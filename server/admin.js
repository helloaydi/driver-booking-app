import express from 'express';
import { requireAdmin } from './auth.js';
import { DEFAULT_SETTINGS, getSettings } from './db.js';
import { ACTIVE, HttpError, activeBookingFor, expireRequests, now, transition } from './bookings.js';

// Limits for each setting an admin can change.
const SETTING_LIMITS = {
  hourly_rate: [5000, 200000],
  min_hours: [1, 12],
  billing_step_min: [1, 60],
  commission_pct: [0, 60],
  match_radius_km: [1, 50],
  request_timeout_min: [2, 60],
};

export function adminRouter({ db }) {
  const router = express.Router();
  router.use('/api/admin', requireAdmin);

  router.get('/api/admin/overview', (req, res) => {
    expireRequests(db);
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    res.json({
      active: db.prepare(`SELECT status, COUNT(*) AS n FROM bookings WHERE status IN (${ACTIVE.map(() => '?')}) GROUP BY status`).all(...ACTIVE),
      online_drivers: db.prepare(`SELECT COUNT(*) AS n FROM drivers WHERE status = 'approved' AND is_online = 1`).get().n,
      pending_drivers: db.prepare(`SELECT COUNT(*) AS n FROM drivers WHERE status = 'pending'`).get().n,
      today: db
        .prepare(
          `SELECT COUNT(*) AS trips, COALESCE(SUM(amount), 0) AS revenue, COALESCE(SUM(commission), 0) AS commission
           FROM bookings WHERE status = 'completed' AND completed_at >= ?`,
        )
        .get(today.toISOString()),
    });
  });

  router.get('/api/admin/bookings', (req, res) => {
    expireRequests(db);
    const status = req.query.status;
    const where =
      status === 'active' ? `WHERE b.status IN (${ACTIVE.map((s) => `'${s}'`)})`
      : ['completed', 'cancelled'].includes(status) ? `WHERE b.status = '${status}'`
      : '';
    res.json(
      db
        .prepare(
          `SELECT b.*, cu.name AS customer_name, cu.phone AS customer_phone,
             du.name AS driver_name, du.phone AS driver_phone, c.model AS car_model, c.reg_no, c.transmission
           FROM bookings b
           JOIN users cu ON cu.id = b.customer_id
           LEFT JOIN users du ON du.id = b.driver_id
           JOIN cars c ON c.id = b.car_id
           ${where} ORDER BY b.id DESC LIMIT 200`,
        )
        .all()
        .map(({ otp, ...b }) => b),
    );
  });

  router.post('/api/admin/bookings/:id/assign', (req, res) => {
    const driverId = Number(req.body?.driver_id);
    db.transaction(() => {
      const driver = db.prepare(`SELECT * FROM drivers WHERE user_id = ? AND status = 'approved'`).get(driverId);
      if (!driver) throw new HttpError(400, 'Choose an approved driver');
      if (activeBookingFor(db, 'driver_id', driverId)) throw new HttpError(409, 'That driver is on another trip');
      const ok = transition(db, Number(req.params.id), 'requested', 'accepted', { driver_id: driverId, accepted_at: now() });
      if (!ok) throw new HttpError(409, 'Only waiting requests can be assigned');
    })();
    res.json({ ok: true });
  });

  router.post('/api/admin/bookings/:id/cancel', (req, res) => {
    const ok = transition(db, Number(req.params.id), ACTIVE, 'cancelled', {
      cancelled_at: now(),
      cancelled_by: 'admin',
      cancel_reason: String(req.body?.reason ?? '').slice(0, 200) || null,
    });
    if (!ok) throw new HttpError(409, 'This booking is already finished');
    res.json({ ok: true });
  });

  router.get('/api/admin/drivers', (req, res) => {
    const rows = db
      .prepare(
        `SELECT d.*, u.name, u.email, u.phone, u.picture,
           (SELECT COUNT(*) FROM bookings b WHERE b.driver_id = d.user_id AND b.status = 'completed') AS trips,
           (SELECT b.id FROM bookings b WHERE b.driver_id = d.user_id
              AND b.status IN ('accepted', 'arrived', 'started')) AS active_booking_id
         FROM drivers d JOIN users u ON u.id = d.user_id
         ORDER BY CASE d.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, d.created_at DESC`,
      )
      .all();
    res.json(rows);
  });

  router.post('/api/admin/drivers/:id/review', (req, res) => {
    const status = req.body?.status;
    if (!['approved', 'rejected'].includes(status)) throw new HttpError(400, 'Choose approve or reject');
    const driverId = Number(req.params.id);
    if (status === 'rejected' && activeBookingFor(db, 'driver_id', driverId)) {
      throw new HttpError(409, 'This driver is on a trip right now');
    }
    const { changes } = db
      .prepare(`UPDATE drivers SET status = ?, reviewed_at = ?, is_online = CASE WHEN ? = 'approved' THEN is_online ELSE 0 END WHERE user_id = ?`)
      .run(status, now(), status, driverId);
    if (!changes) throw new HttpError(404, 'Driver not found');
    res.json({ ok: true });
  });

  // What we owe each driver: trips the customer has paid for, not yet paid out.
  router.get('/api/admin/payouts', (req, res) => {
    res.json(
      db
        .prepare(
          `SELECT u.id AS driver_id, u.name, u.phone, COUNT(*) AS trips, SUM(b.driver_earning) AS owed,
             MIN(b.completed_at) AS oldest
           FROM bookings b JOIN users u ON u.id = b.driver_id
           WHERE b.status = 'completed' AND b.payment_status = 'paid' AND b.payout_status = 'unpaid'
           GROUP BY u.id ORDER BY owed DESC`,
        )
        .all(),
    );
  });

  // Record that the driver was paid (by bank transfer or UPI, outside the app).
  router.post('/api/admin/payouts/:driverId/paid', (req, res) => {
    const { changes } = db
      .prepare(
        `UPDATE bookings SET payout_status = 'paid', payout_at = ?
         WHERE driver_id = ? AND status = 'completed' AND payment_status = 'paid' AND payout_status = 'unpaid'`,
      )
      .run(now(), Number(req.params.driverId));
    if (!changes) throw new HttpError(404, 'Nothing owed to this driver');
    res.json({ trips: changes });
  });

  router.get('/api/admin/settings', (req, res) => res.json(getSettings(db)));

  router.put('/api/admin/settings', (req, res) => {
    const update = db.prepare('UPDATE settings SET value = ? WHERE key = ?');
    const changes = [];
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (req.body?.[key] === undefined) continue;
      const value = Number(req.body[key]);
      const [min, max] = SETTING_LIMITS[key];
      if (!Number.isFinite(value) || value < min || value > max) throw new HttpError(400, `${key} must be between ${min} and ${max}`);
      changes.push([String(value), key]);
    }
    db.transaction(() => changes.forEach((c) => update.run(...c)))();
    res.json(getSettings(db));
  });

  return router;
}
