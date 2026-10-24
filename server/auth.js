import crypto from 'node:crypto';
import express from 'express';
import { OAuth2Client } from 'google-auth-library';

const COOKIE = 'sid';
const SESSION_DAYS = 30;

const hash = (token) => crypto.createHash('sha256').update(token).digest('hex');

function parseCookies(header = '') {
  const cookies = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) cookies[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return cookies;
}

export function authRouter({ db, config }) {
  const router = express.Router();
  const google = new OAuth2Client();
  const adminEmails = new Set(config.adminEmails);

  function startSession(res, userId) {
    const token = crypto.randomBytes(32).toString('base64url');
    const expires = new Date(Date.now() + SESSION_DAYS * 86400_000);
    db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(
      hash(token),
      userId,
      expires.toISOString(),
    );
    res.cookie(COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.production,
      expires,
      path: '/',
    });
  }

  function upsertUser({ email, name, picture }) {
    db.prepare(
      `INSERT INTO users (email, name, picture) VALUES (?, ?, ?)
       ON CONFLICT(email) DO UPDATE SET name = excluded.name, picture = excluded.picture`,
    ).run(email, name, picture ?? null);
    return db.prepare('SELECT id FROM users WHERE email = ?').get(email).id;
  }

  // Attaches req.user (or null) on every request.
  router.use((req, res, next) => {
    req.user = null;
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (token) {
      const row = db
        .prepare(
          `SELECT u.*, d.status AS driver_status FROM sessions s
           JOIN users u ON u.id = s.user_id
           LEFT JOIN drivers d ON d.user_id = u.id
           WHERE s.token_hash = ? AND s.expires_at > ?`,
        )
        .get(hash(token), new Date().toISOString());
      if (row) req.user = { ...row, is_admin: adminEmails.has(row.email) };
    }
    next();
  });

  // The browser gets an ID token from Google's sign-in button and sends it here.
  router.post('/api/auth/google', async (req, res) => {
    if (!config.googleClientId) return res.status(500).json({ error: 'Google sign-in is not configured' });
    let payload;
    try {
      const ticket = await google.verifyIdToken({
        idToken: String(req.body?.credential ?? ''),
        audience: config.googleClientId,
      });
      payload = ticket.getPayload();
    } catch {
      return res.status(401).json({ error: 'Google sign-in failed' });
    }
    if (!payload.email_verified) return res.status(401).json({ error: 'Google email is not verified' });
    const userId = upsertUser({
      email: payload.email.toLowerCase(),
      name: payload.name || payload.email,
      picture: payload.picture,
    });
    startSession(res, userId);
    res.json({ ok: true });
  });

  // Local testing without Google. Never enabled in production.
  if (config.devLogin && !config.production) {
    router.post('/api/auth/dev', (req, res) => {
      const email = String(req.body?.email ?? '').trim().toLowerCase();
      if (!email.includes('@')) return res.status(400).json({ error: 'Enter an email' });
      const userId = upsertUser({ email, name: req.body?.name || email.split('@')[0] });
      startSession(res, userId);
      res.json({ ok: true });
    });
  }

  router.post('/api/auth/logout', (req, res) => {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash(token));
    res.clearCookie(COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  return router;
}

export function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Please sign in' });
  next();
}

export function requireDriver(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Please sign in' });
  if (req.user.driver_status !== 'approved') return res.status(403).json({ error: 'Driver account not approved' });
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Please sign in' });
  if (!req.user.is_admin) return res.status(403).json({ error: 'Admins only' });
  next();
}
