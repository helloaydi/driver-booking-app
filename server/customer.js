import express from 'express';
import { getSettings } from './db.js';
import { CITY, estimate } from './pricing.js';
import { HttpError, activeBookingFor, expireRequests, newOtp, now, transition } from './bookings.js';

const PHONE = /^[6-9]\d{9}$/; // Indian mobile number, 10 digits

function validHours(value) {
  const hours = Number(value);
  return Number.isFinite(hours) && hours >= 1 && hours <= 12 && (hours * 2) % 1 === 0 ? hours : null;
}

// What a customer is allowed to see about their booking. The OTP is only
// shown once a driver is on the way, and never after the trip starts.
function customerView(db, booking) {
  const driver = booking.driver_id
    ? db
        .prepare(
          `SELECT u.name, u.phone, u.picture, d.experience_years FROM users u
           JOIN drivers d ON d.user_id = u.id WHERE u.id = ?`,
        )
        .get(booking.driver_id)
    : null;
  const car = db.prepare('SELECT model, reg_no, transmission FROM cars WHERE id = ?').get(booking.car_id);
  const { otp, customer_id, driver_id, commission, driver_earning, commission_pct, payout_status, ...rest } = booking;
  return {
    ...rest,
    car,
    driver,
    otp: ['accepted', 'arrived'].includes(booking.status) ? otp : null,
  };
}

export function customerRouter({ db }) {
  const router = express.Router();
  router.get('/api/me', (req, res) => {
    const { id, email, name, picture, phone, is_admin, driver_status } = req.user;
    res.json({ id, email, name, picture, phone, is_admin, driver_status: driver_status ?? null, city: CITY });
  });

  router.put('/api/me', (req, res) => {
    const name = String(req.body?.name ?? '').trim();
    const phone = String(req.body?.phone ?? '').replace(/\D/g, '').replace(/^91(?=\d{10}$)/, '');
    if (!name) throw new HttpError(400, 'Enter your name');
    if (!PHONE.test(phone)) throw new HttpError(400, 'Enter a valid 10-digit mobile number');
    db.prepare('UPDATE users SET name = ?, phone = ? WHERE id = ?').run(name, phone, req.user.id);
    res.json({ ok: true });
  });

  router.get('/api/cars', (req, res) => {
    res.json(
      db
        .prepare('SELECT id, model, reg_no, transmission FROM cars WHERE user_id = ? AND deleted = 0 ORDER BY id')
        .all(req.user.id),
    );
  });

  router.post('/api/cars', (req, res) => {
    const model = String(req.body?.model ?? '').trim();
    const regNo = String(req.body?.reg_no ?? '').toUpperCase().replace(/\s+/g, '');
    const transmission = req.body?.transmission;
    if (!model) throw new HttpError(400, 'Enter the car model');
    if (!/^[A-Z0-9]{6,11}$/.test(regNo)) throw new HttpError(400, 'Enter a valid registration number');
    if (!['manual', 'automatic'].includes(transmission)) throw new HttpError(400, 'Choose manual or automatic');
    const { lastInsertRowid } = db
      .prepare('INSERT INTO cars (user_id, model, reg_no, transmission) VALUES (?, ?, ?, ?)')
      .run(req.user.id, model, regNo, transmission);
    res.json({ id: Number(lastInsertRowid) });
  });

  router.delete('/api/cars/:id', (req, res) => {
    db.prepare('UPDATE cars SET deleted = 1 WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
    res.json({ ok: true });
  });

  router.get('/api/estimate', (req, res) => {
    const settings = getSettings(db);
    const hours = validHours(req.query.hours) ?? settings.min_hours;
    res.json({
      hours,
      hourly_rate: settings.hourly_rate,
      min_hours: settings.min_hours,
      billing_step_min: settings.billing_step_min,
      estimate: estimate(settings, hours),
    });
  });

  router.post('/api/bookings', (req, res) => {
    const { car_id, pickup_address } = req.body ?? {};
    const hours = validHours(req.body?.hours);
    if (!req.user.phone) throw new HttpError(400, 'Add your phone number first');
    const car = db.prepare('SELECT * FROM cars WHERE id = ? AND user_id = ? AND deleted = 0').get(car_id, req.user.id);
    if (!car) throw new HttpError(400, 'Choose one of your cars');
    if (!hours) throw new HttpError(400, 'Choose between 1 and 12 hours');
    const address = String(pickup_address ?? '').trim();
    if (address.length < 5) throw new HttpError(400, 'Enter the pickup address');

    const id = db.transaction(() => {
      expireRequests(db);
      if (activeBookingFor(db, 'customer_id', req.user.id)) throw new HttpError(409, 'You already have an active booking');
      const unpaid = db
        .prepare(`SELECT id FROM bookings WHERE customer_id = ? AND status = 'completed' AND payment_status != 'paid'`)
        .get(req.user.id);
      if (unpaid) throw new HttpError(409, 'Please pay for your last trip first');
      const s = getSettings(db);
      const { lastInsertRowid } = db
        .prepare(
          `INSERT INTO bookings (customer_id, car_id, pickup_address, booked_hours,
             hourly_rate, min_hours, billing_step_min, commission_pct, estimate, otp, requested_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          req.user.id, car.id, address, hours,
          s.hourly_rate, s.min_hours, s.billing_step_min, s.commission_pct, estimate(s, hours), newOtp(), now(),
        );
      return Number(lastInsertRowid);
    })();
    res.json({ id });
  });

  router.get('/api/bookings', (req, res) => {
    expireRequests(db);
    const rows = db
      .prepare('SELECT * FROM bookings WHERE customer_id = ? ORDER BY id DESC LIMIT 50')
      .all(req.user.id);
    res.json(rows.map((b) => customerView(db, b)));
  });

  router.get('/api/bookings/:id', (req, res) => {
    expireRequests(db);
    const booking = db.prepare('SELECT * FROM bookings WHERE id = ? AND customer_id = ?').get(req.params.id, req.user.id);
    if (!booking) throw new HttpError(404, 'Booking not found');
    res.json(customerView(db, booking));
  });

  router.post('/api/bookings/:id/cancel', (req, res) => {
    const booking = db.prepare('SELECT * FROM bookings WHERE id = ? AND customer_id = ?').get(req.params.id, req.user.id);
    if (!booking) throw new HttpError(404, 'Booking not found');
    const ok = transition(db, booking.id, ['requested', 'accepted', 'arrived'], 'cancelled', {
      cancelled_at: now(),
      cancelled_by: 'customer',
      cancel_reason: String(req.body?.reason ?? '').slice(0, 200) || null,
    });
    if (!ok) throw new HttpError(409, 'This booking can no longer be cancelled');
    res.json({ ok: true });
  });

  return router;
}
