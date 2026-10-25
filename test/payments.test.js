import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createApp } from '../server/index.js';
import { openDb } from '../server/db.js';

const KEY_SECRET = 'test_key_secret';
const WEBHOOK_SECRET = 'test_webhook_secret';
const sign = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('hex');

let server, base, db, orderCalls = 0;
const realFetch = globalThis.fetch;

before(async () => {
  // Fake Razorpay's Orders API; everything else goes to our test server.
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://api.razorpay.com/')) {
      orderCalls++;
      const body = JSON.parse(init.body);
      return new Response(JSON.stringify({ id: `order_test${orderCalls}`, amount: body.amount, status: 'created' }), { status: 200 });
    }
    return realFetch(url, init);
  };
  db = openDb(':memory:');
  const config = {
    production: false, devLogin: true, adminEmails: ['admin@test.in'], googleClientId: '',
    razorpay: { keyId: 'rzp_test_abc', keySecret: KEY_SECRET, webhookSecret: WEBHOOK_SECRET },
  };
  const { app } = createApp(config, db);
  server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => { server.close(); globalThis.fetch = realFetch; });

async function login(email) {
  let cookie = '';
  const call = async (method, path, body, headers = {}) => {
    const res = await realFetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', cookie, ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return { status: res.status, data: await res.json() };
  };
  if (email) await call('POST', '/api/auth/dev', { email });
  return { get: (p) => call('GET', p), post: (p, b = {}, h) => call('POST', p, b, h) };
}

// A customer with one finished, unpaid trip worth ₹400.
function completedTrip(email) {
  const user = db.prepare(`INSERT INTO users (email, name, phone) VALUES (?, 'C', '9845012345') RETURNING id`).get(email);
  const car = db.prepare(`INSERT INTO cars (user_id, model, reg_no, transmission) VALUES (?, 'Swift', 'KA01AB1234', 'manual') RETURNING id`).get(user.id);
  return db.prepare(
    `INSERT INTO bookings (customer_id, car_id, status, pickup_address, pickup_lat, pickup_lng, booked_hours, hourly_rate,
       min_hours, billing_step_min, commission_pct, estimate, otp, amount, commission, driver_earning, billed_minutes, completed_at)
     VALUES (?, ?, 'completed', 'MG Road', 12.97, 77.6, 2, 20000, 2, 30, 20, 40000, '1234', 40000, 8000, 32000, 120, ?)
     RETURNING id`,
  ).get(user.id, car.id, new Date().toISOString()).id;
}

test('checkout: order, signature check, paid; unpaid trip blocks new bookings', async () => {
  const id = completedTrip('pay@test.in');
  const customer = await login('pay@test.in');

  const blocked = await customer.post('/api/bookings', { car_id: 1, hours: 2, pickup_address: 'MG Road', lat: 12.97, lng: 77.6 });
  assert.equal(blocked.status, 409);

  const order = await customer.post('/api/payments/order', { booking_id: id });
  assert.equal(order.status, 200);
  assert.equal(order.data.amount, 40000);
  assert.equal(order.data.key_id, 'rzp_test_abc');
  const again = await customer.post('/api/payments/order', { booking_id: id });
  assert.equal(again.data.order_id, order.data.order_id, 'reuses the open order');

  const other = await login('someone@test.in');
  assert.equal((await other.post('/api/payments/order', { booking_id: id })).status, 404);

  const bad = await customer.post('/api/payments/verify', {
    razorpay_order_id: order.data.order_id, razorpay_payment_id: 'pay_1', razorpay_signature: 'nope',
  });
  assert.equal(bad.status, 400);
  assert.equal((await customer.get(`/api/bookings/${id}`)).data.payment_status, 'unpaid');

  const good = await customer.post('/api/payments/verify', {
    razorpay_order_id: order.data.order_id, razorpay_payment_id: 'pay_1',
    razorpay_signature: sign(KEY_SECRET, `${order.data.order_id}|pay_1`),
  });
  assert.equal(good.status, 200);
  assert.equal((await customer.get(`/api/bookings/${id}`)).data.payment_status, 'paid');
  assert.equal((await customer.post('/api/payments/order', { booking_id: id })).status, 409);
});

test('webhook marks paid only with a valid signature and matching amount', async () => {
  const id = completedTrip('hook@test.in');
  const customer = await login('hook@test.in');
  const { data: order } = await customer.post('/api/payments/order', { booking_id: id });
  const anon = await login();

  const event = (amount) => JSON.stringify({
    event: 'payment.captured',
    payload: { payment: { entity: { id: 'pay_hook', order_id: order.order_id, amount } } },
  });

  assert.equal((await anon.post('/api/payments/webhook', event(40000), { 'x-razorpay-signature': 'forged' })).status, 400);
  const wrongAmount = event(100);
  await anon.post('/api/payments/webhook', wrongAmount, { 'x-razorpay-signature': sign(WEBHOOK_SECRET, wrongAmount) });
  assert.equal((await customer.get(`/api/bookings/${id}`)).data.payment_status, 'unpaid');

  const body = event(40000);
  const res = await anon.post('/api/payments/webhook', body, { 'x-razorpay-signature': sign(WEBHOOK_SECRET, body) });
  assert.equal(res.status, 200);
  assert.equal((await customer.get(`/api/bookings/${id}`)).data.payment_status, 'paid');
});

test('admin sees and settles what drivers are owed', async () => {
  const id = completedTrip('owed@test.in');
  const driver = db.prepare(`INSERT INTO users (email, name, phone) VALUES ('drv@test.in', 'Ravi', '9900011111') RETURNING id`).get().id;
  db.prepare(`UPDATE bookings SET driver_id = ?, payment_status = 'paid' WHERE id = ?`).run(driver, id);
  const admin = await login('admin@test.in');
  const owed = (await admin.get('/api/admin/payouts')).data.find((p) => p.driver_id === driver);
  assert.equal(owed.owed, 32000);
  assert.equal((await admin.post(`/api/admin/payouts/${driver}/paid`)).data.trips, 1);
  assert.equal((await admin.get('/api/admin/payouts')).data.find((p) => p.driver_id === driver), undefined);
});
