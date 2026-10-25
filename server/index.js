import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { openDb } from './db.js';
import { authRouter, requireUser } from './auth.js';
import { customerRouter } from './customer.js';
import { driverRouter } from './driver.js';
import { adminRouter } from './admin.js';
import { paymentsRouter } from './payments.js';
import { CITY } from './pricing.js';
import { expireRequests } from './bookings.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function loadConfig(env = process.env) {
  return {
    port: Number(env.PORT || 4602),
    host: env.HOST || '127.0.0.1',
    production: env.NODE_ENV === 'production',
    dbPath: env.DB_PATH || path.join(root, 'data', 'driverbooking.db'),
    googleClientId: env.GOOGLE_CLIENT_ID || '',
    adminEmails: (env.ADMIN_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean),
    devLogin: env.DEV_LOGIN === '1',
    razorpay: {
      keyId: env.RAZORPAY_KEY_ID || '',
      keySecret: env.RAZORPAY_KEY_SECRET || '',
      webhookSecret: env.RAZORPAY_WEBHOOK_SECRET || '',
    },
  };
}

export function createApp(config, db = openDb(config.dbPath)) {
  const app = express();
  // HTTPS ends at the course proxy, which forwards plain HTTP to us.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  // Keep the raw body too: Razorpay webhook signatures are over the exact bytes.
  app.use(express.json({ limit: '100kb', verify: (req, res, buf) => { req.rawBody = buf; } }));

  // Writes must be JSON. Browsers can't send that cross-site without CORS,
  // which (with SameSite cookies) blocks cross-site form posts.
  app.use('/api', (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD' && !req.is('application/json')) {
      return res.status(415).json({ error: 'Send JSON' });
    }
    next();
  });

  app.get('/api/health', (req, res) => res.json({ ok: true }));
  app.get('/api/config', (req, res) =>
    res.json({
      googleClientId: config.googleClientId,
      devLogin: config.devLogin && !config.production,
      payments: Boolean(config.razorpay?.keyId && config.razorpay?.keySecret),
      city: CITY,
    }),
  );

  app.use(authRouter({ db, config }));
  app.use(paymentsRouter({ db, config }));
  app.use('/api', requireUser);
  app.use(driverRouter({ db }));
  app.use(adminRouter({ db }));
  app.use(customerRouter({ db }));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // The built PWA. Any other path gets index.html so client-side routes work.
  const dist = path.join(root, 'web', 'dist');
  if (fs.existsSync(dist)) {
    app.use(express.static(dist, { index: false, maxAge: '1h', setHeaders: noCacheForShell }));
    app.get('/{*path}', (req, res) => res.sendFile(path.join(dist, 'index.html'), { headers: { 'Cache-Control': 'no-cache' } }));
  }

  app.use((err, req, res, next) => {
    if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  });

  return { app, db };
}

// The service worker and manifest must always be fresh; hashed assets can be cached.
function noCacheForShell(res, filePath) {
  const name = path.basename(filePath);
  if (name === 'sw.js' || name === 'manifest.webmanifest' || name === 'index.html') {
    res.setHeader('Cache-Control', 'no-cache');
  } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = loadConfig();
  const { app, db } = createApp(config);
  setInterval(() => expireRequests(db), 60_000).unref();
  app.listen(config.port, config.host, () => {
    console.log(`driverbooking listening on http://${config.host}:${config.port}`);
  });
}
