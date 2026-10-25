import express from 'express';
import { requireDriver } from './auth.js';
import { finalFare } from './pricing.js';
import { HttpError, activeBookingFor, expireRequests, now, transition } from './bookings.js';

const MAX_OTP_TRIES = 5;

const canDrive = (driverTransmission, carTransmission) =>
  driverTransmission === 'both' || driverTransmission === carTransmission;

// What a driver sees about their current trip. Never includes the OTP.
function driverView(db, booking) {
  const customer = db.prepare('SELECT name, phone, picture FROM users WHERE id = ?').get(booking.customer_id);
  const car = db.prepare('SELECT model, reg_no, transmission FROM cars WHERE id = ?').get(booking.car_id);
  const { otp, customer_id, commission_pct, commission, payment_status, ...rest } = booking;
  return { ...rest, customer, car };
}

export function driverRouter({ db }) {
  const router = express.Router();
  const otpTries = new Map(); // booking id -> wrong attempts

  // Applying is open to any signed-in user; everything else needs approval.
  router.get('/api/driver/profile', (req, res) => {
    res.json(db.prepare('SELECT * FROM drivers WHERE user_id = ?').get(req.user.id) ?? null);
  });

  router.post('/api/driver/apply', (req, res) => {
    const licence = String(req.body?.licence_no ?? '').toUpperCase().replace(/[\s-]/g, '');
    const years = Number(req.body?.experience_years);
    const transmission = req.body?.transmission;
    if (!req.user.phone) throw new HttpError(400, 'Add your phone number first');
    if (!/^[A-Z]{2}\d{2}[A-Z0-9]{9,12}$/.test(licence)) throw new HttpError(400, 'Enter a valid driving licence number');
    if (!Number.isInteger(years) || years < 1 || years > 50) throw new HttpError(400, 'Enter years of driving experience');
    if (!['manual', 'automatic', 'both'].includes(transmission)) throw new HttpError(400, 'Choose which cars you can drive');
    const existing = db.prepare('SELECT status FROM drivers WHERE user_id = ?').get(req.user.id);
    if (existing && existing.status !== 'rejected') throw new HttpError(409, 'You have already applied');
    db.prepare(
      `INSERT INTO drivers (user_id, licence_no, experience_years, transmission) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET status = 'pending', licence_no = excluded.licence_no,
         experience_years = excluded.experience_years, transmission = excluded.transmission, reviewed_at = NULL`,
    ).run(req.user.id, licence, years, transmission);
    res.json({ ok: true });
  });

  router.use('/api/driver', requireDriver);

  router.post('/api/driver/online', (req, res) => {
    const online = Boolean(req.body?.online);
    if (online) {
      db.prepare('UPDATE drivers SET is_online = 1 WHERE user_id = ?').run(req.user.id);
    } else {
      if (activeBookingFor(db, 'driver_id', req.user.id)) throw new HttpError(409, 'Finish your current trip first');
      db.prepare('UPDATE drivers SET is_online = 0 WHERE user_id = ?').run(req.user.id);
    }
    res.json({ ok: true });
  });

  // Open requests this driver is able to drive, oldest first.
  router.get('/api/driver/requests', (req, res) => {
    expireRequests(db);
    const me = db.prepare('SELECT * FROM drivers WHERE user_id = ?').get(req.user.id);
    if (!me.is_online || activeBookingFor(db, 'driver_id', req.user.id)) return res.json([]);
    const rows = db
      .prepare(
        `SELECT b.id, b.pickup_address, b.booked_hours, b.estimate,
           b.commission_pct, b.requested_at, c.model, c.transmission
         FROM bookings b JOIN cars c ON c.id = b.car_id
         WHERE b.status = 'requested' AND b.customer_id != ?
         ORDER BY b.requested_at`,
      )
      .all(req.user.id);
    const requests = rows
      .filter((r) => canDrive(me.transmission, r.transmission))
      .map(({ commission_pct, ...r }) => ({
        ...r,
        est_earning: Math.round(r.estimate * (1 - commission_pct / 100)),
      }));
    res.json(requests);
  });

  router.get('/api/driver/active', (req, res) => {
    const booking = activeBookingFor(db, 'driver_id', req.user.id);
    res.json(booking ? driverView(db, booking) : null);
  });

  router.post('/api/driver/bookings/:id/accept', (req, res) => {
    db.transaction(() => {
      const me = db.prepare('SELECT * FROM drivers WHERE user_id = ?').get(req.user.id);
      if (!me.is_online) throw new HttpError(409, 'Go online to accept trips');
      if (activeBookingFor(db, 'driver_id', req.user.id)) throw new HttpError(409, 'Finish your current trip first');
      const booking = db
        .prepare('SELECT b.*, c.transmission FROM bookings b JOIN cars c ON c.id = b.car_id WHERE b.id = ?')
        .get(req.params.id);
      if (!booking || booking.customer_id === req.user.id) throw new HttpError(404, 'Booking not found');
      if (!canDrive(me.transmission, booking.transmission)) throw new HttpError(409, 'You cannot drive this car type');
      const ok = transition(db, booking.id, 'requested', 'accepted', { driver_id: req.user.id, accepted_at: now() });
      if (!ok) throw new HttpError(409, 'Another driver took this trip');
    })();
    res.json({ ok: true });
  });

  function myBooking(req) {
    const booking = db.prepare('SELECT * FROM bookings WHERE id = ? AND driver_id = ?').get(req.params.id, req.user.id);
    if (!booking) throw new HttpError(404, 'Booking not found');
    return booking;
  }

  router.post('/api/driver/bookings/:id/arrived', (req, res) => {
    const booking = myBooking(req);
    if (!transition(db, booking.id, 'accepted', 'arrived', { arrived_at: now() })) {
      throw new HttpError(409, 'This trip has changed. Refresh and try again.');
    }
    res.json({ ok: true });
  });

  router.post('/api/driver/bookings/:id/start', (req, res) => {
    const booking = myBooking(req);
    const tries = otpTries.get(booking.id) ?? 0;
    if (tries >= MAX_OTP_TRIES) throw new HttpError(429, 'Too many wrong OTPs. Please contact support.');
    if (String(req.body?.otp ?? '').trim() !== booking.otp) {
      otpTries.set(booking.id, tries + 1);
      throw new HttpError(400, 'Wrong OTP. Ask the customer for the OTP shown in their app.');
    }
    if (!transition(db, booking.id, ['accepted', 'arrived'], 'started', { started_at: now() })) {
      throw new HttpError(409, 'This trip has changed. Refresh and try again.');
    }
    otpTries.delete(booking.id);
    res.json({ ok: true });
  });

  router.post('/api/driver/bookings/:id/complete', (req, res) => {
    const booking = myBooking(req);
    if (booking.status !== 'started') throw new HttpError(409, 'This trip has not started');
    const completedAt = now();
    const minutes = (Date.parse(completedAt) - Date.parse(booking.started_at)) / 60_000;
    const fare = finalFare(booking, minutes);
    if (!transition(db, booking.id, 'started', 'completed', { completed_at: completedAt, ...fare })) {
      throw new HttpError(409, 'This trip has changed. Refresh and try again.');
    }
    res.json(fare);
  });

  // A driver who drops a trip before it starts puts it back up for others.
  router.post('/api/driver/bookings/:id/cancel', (req, res) => {
    const booking = myBooking(req);
    const ok = transition(db, booking.id, ['accepted', 'arrived'], 'requested', {
      driver_id: null,
      accepted_at: null,
      arrived_at: null,
      requested_at: now(),
    });
    if (!ok) throw new HttpError(409, 'This trip can no longer be dropped');
    res.json({ ok: true });
  });

  router.get('/api/driver/earnings', (req, res) => {
    const trips = db
      .prepare(
        `SELECT id, pickup_address, started_at, completed_at, billed_minutes, amount, driver_earning, payout_status
         FROM bookings WHERE driver_id = ? AND status = 'completed' ORDER BY completed_at DESC LIMIT 100`,
      )
      .all(req.user.id);
    const totals = db
      .prepare(
        `SELECT COUNT(*) AS trips, COALESCE(SUM(driver_earning), 0) AS earned,
           COALESCE(SUM(CASE WHEN payout_status = 'unpaid' THEN driver_earning END), 0) AS unpaid
         FROM bookings WHERE driver_id = ? AND status = 'completed'`,
      )
      .get(req.user.id);
    res.json({ totals, trips });
  });

  return router;
}
