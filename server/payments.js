import crypto from 'node:crypto';
import express from 'express';
import { requireUser } from './auth.js';
import { HttpError, now } from './bookings.js';

const RAZORPAY_API = 'https://api.razorpay.com/v1';

const hmac = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('hex');

function sameSignature(expected, given) {
  const a = Buffer.from(expected);
  const b = Buffer.from(String(given ?? ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Marks an order paid. Safe to call twice (checkout callback and webhook both do).
export function markPaid(db, orderId, paymentId, paidAmount) {
  return db.transaction(() => {
    const payment = db.prepare('SELECT * FROM payments WHERE order_id = ?').get(orderId);
    if (!payment) return false;
    if (paidAmount != null && paidAmount !== payment.amount) {
      console.error(`Razorpay amount mismatch on ${orderId}: paid ${paidAmount}, expected ${payment.amount}`);
      return false;
    }
    const at = now();
    db.prepare(`UPDATE payments SET status = 'paid', payment_id = ?, paid_at = ? WHERE id = ? AND status != 'paid'`).run(
      paymentId, at, payment.id,
    );
    db.prepare(`UPDATE bookings SET payment_status = 'paid', paid_at = ? WHERE id = ? AND payment_status != 'paid'`).run(
      at, payment.booking_id,
    );
    return true;
  })();
}

export function paymentsRouter({ db, config }) {
  const router = express.Router();
  const { keyId, keySecret, webhookSecret } = config.razorpay ?? {};
  const enabled = Boolean(keyId && keySecret);

  async function createOrder(booking) {
    const res = await fetch(`${RAZORPAY_API}/orders`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Basic ' + Buffer.from(`${keyId}:${keySecret}`).toString('base64'),
      },
      body: JSON.stringify({
        amount: booking.amount,
        currency: 'INR',
        receipt: `booking_${booking.id}`,
        notes: { booking_id: String(booking.id) },
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error('Razorpay order failed', res.status, data?.error?.description);
      throw new HttpError(502, 'Could not start the payment. Please try again.');
    }
    return data;
  }

  // Razorpay calls this directly, so it is not behind sign-in. The signature
  // over the raw body proves the call came from Razorpay.
  router.post('/api/payments/webhook', (req, res) => {
    if (!webhookSecret) return res.status(503).json({ error: 'Webhook not configured' });
    if (!sameSignature(hmac(webhookSecret, req.rawBody ?? ''), req.get('x-razorpay-signature'))) {
      return res.status(400).json({ error: 'Bad signature' });
    }
    const event = req.body?.event;
    const payment = req.body?.payload?.payment?.entity;
    if ((event === 'payment.captured' || event === 'order.paid') && payment?.order_id) {
      markPaid(db, payment.order_id, payment.id, payment.amount);
    }
    res.json({ ok: true });
  });

  router.use('/api/payments', requireUser);

  // Starts (or resumes) payment for a completed trip.
  router.post('/api/payments/order', async (req, res) => {
    if (!enabled) throw new HttpError(503, 'Online payment is not set up yet');
    const booking = db
      .prepare(`SELECT * FROM bookings WHERE id = ? AND customer_id = ? AND status = 'completed'`)
      .get(Number(req.body?.booking_id), req.user.id);
    if (!booking) throw new HttpError(404, 'Trip not found');
    if (booking.payment_status === 'paid') throw new HttpError(409, 'This trip is already paid');

    let payment = db
      .prepare(`SELECT * FROM payments WHERE booking_id = ? AND status = 'created' AND amount = ? ORDER BY id DESC`)
      .get(booking.id, booking.amount);
    if (!payment) {
      const order = await createOrder(booking);
      db.prepare('INSERT INTO payments (booking_id, order_id, amount) VALUES (?, ?, ?)').run(booking.id, order.id, booking.amount);
      payment = { order_id: order.id, amount: booking.amount };
    }
    res.json({
      key_id: keyId,
      order_id: payment.order_id,
      amount: payment.amount,
      currency: 'INR',
      prefill: { name: req.user.name, email: req.user.email, contact: req.user.phone ? `+91${req.user.phone}` : undefined },
    });
  });

  // Checkout hands the browser a signature; checking it here confirms the payment.
  router.post('/api/payments/verify', (req, res) => {
    if (!enabled) throw new HttpError(503, 'Online payment is not set up yet');
    const { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature } = req.body ?? {};
    const payment = db
      .prepare(
        `SELECT p.* FROM payments p JOIN bookings b ON b.id = p.booking_id
         WHERE p.order_id = ? AND b.customer_id = ?`,
      )
      .get(String(orderId ?? ''), req.user.id);
    if (!payment) throw new HttpError(404, 'Payment not found');
    if (!sameSignature(hmac(keySecret, `${orderId}|${paymentId}`), signature)) {
      throw new HttpError(400, 'Payment could not be verified');
    }
    markPaid(db, orderId, String(paymentId));
    res.json({ ok: true });
  });

  return router;
}
