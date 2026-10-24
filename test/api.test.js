import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/index.js';
import { openDb } from '../server/db.js';
import { finalFare } from '../server/pricing.js';

const MG_ROAD = { lat: 12.9756, lng: 77.6066 };
const INDIRANAGAR = { lat: 12.9784, lng: 77.6408 };
const MYSORE = { lat: 12.2958, lng: 76.6394 };

let server, base, db;

before(async () => {
  db = openDb(':memory:');
  const config = { production: false, devLogin: true, adminEmails: ['admin@test.in'], googleClientId: '' };
  ({ app: server } = createApp(config, db));
  server = await new Promise((resolve) => {
    const s = server.listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

// A tiny client that keeps its own session cookie.
async function login(email) {
  let cookie = '';
  const call = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const data = await res.json();
    return { status: res.status, data };
  };
  const res = await call('POST', '/api/auth/dev', { email });
  assert.equal(res.status, 200);
  return {
    get: (p) => call('GET', p),
    post: (p, b = {}) => call('POST', p, b),
    put: (p, b) => call('PUT', p, b),
  };
}

test('fare rounds up to the billing step and applies the minimum', () => {
  const booking = { hourly_rate: 20000, min_hours: 2, billing_step_min: 30, commission_pct: 20 };
  assert.deepEqual(finalFare(booking, 10), { billed_minutes: 120, amount: 40000, commission: 8000, driver_earning: 32000 });
  assert.equal(finalFare(booking, 151).billed_minutes, 180);
  assert.equal(finalFare(booking, 180).amount, 60000);
});

test('signed-out requests are rejected', async () => {
  const res = await fetch(base + '/api/me');
  assert.equal(res.status, 401);
});

test('full booking flow: request, accept, OTP start, complete', async () => {
  const admin = await login('admin@test.in');
  const customer = await login('asha@test.in');
  const driver = await login('ravi@test.in');
  const other = await login('kiran@test.in');

  assert.equal((await customer.get('/api/me')).data.is_admin, false);
  assert.equal((await admin.get('/api/me')).data.is_admin, true);
  assert.equal((await customer.get('/api/admin/bookings')).status, 403);

  // Customer needs a phone and a car.
  assert.equal((await customer.post('/api/bookings', {})).status, 400);
  assert.equal((await customer.put('/api/me', { name: 'Asha', phone: '98450 12345' })).status, 200);
  const car = await customer.post('/api/cars', { model: 'Swift', reg_no: 'KA 01 AB 1234', transmission: 'manual' });
  assert.equal(car.status, 200);

  // Outside Bangalore is refused.
  const far = await customer.post('/api/bookings', { car_id: car.data.id, hours: 3, pickup_address: 'Mysore Palace', ...MYSORE });
  assert.equal(far.status, 400);

  const booking = await customer.post('/api/bookings', {
    car_id: car.data.id, hours: 3, pickup_address: '12 MG Road, Bangalore', ...MG_ROAD,
  });
  assert.equal(booking.status, 200);
  const id = booking.data.id;
  assert.equal((await customer.get(`/api/bookings/${id}`)).data.estimate, 60000);
  assert.equal((await customer.get(`/api/bookings/${id}`)).data.otp, null, 'no OTP before a driver accepts');
  assert.equal(
    (await customer.post('/api/bookings', { car_id: car.data.id, hours: 2, pickup_address: 'Somewhere else', ...MG_ROAD })).status,
    409,
    'one active booking at a time',
  );

  // Drivers apply and need approval.
  for (const [d, phone, transmission] of [[driver, '9900011111', 'both'], [other, '9900022222', 'automatic']]) {
    await d.put('/api/me', { name: 'Driver', phone });
    assert.equal((await d.post('/api/driver/apply', { licence_no: 'KA01 20150012345', experience_years: 5, transmission })).status, 200);
    assert.equal((await d.post('/api/driver/online', { online: true, ...INDIRANAGAR })).status, 403);
  }
  const drivers = (await admin.get('/api/admin/drivers')).data;
  for (const d of drivers) assert.equal((await admin.post(`/api/admin/drivers/${d.user_id}/review`, { status: 'approved' })).status, 200);

  assert.equal((await driver.post('/api/driver/online', { online: true, ...INDIRANAGAR })).status, 200);
  assert.equal((await other.post('/api/driver/online', { online: true, ...INDIRANAGAR })).status, 200);

  const requests = (await driver.get('/api/driver/requests')).data;
  assert.equal(requests.length, 1);
  assert.equal(requests[0].est_earning, 48000);
  assert.equal(requests[0].otp, undefined);
  assert.deepEqual((await other.get('/api/driver/requests')).data, [], 'automatic-only driver does not see a manual car');

  assert.equal((await driver.post(`/api/driver/bookings/${id}/accept`)).status, 200);
  assert.equal((await other.post(`/api/driver/bookings/${id}/accept`)).status, 409);

  const view = (await customer.get(`/api/bookings/${id}`)).data;
  assert.equal(view.status, 'accepted');
  assert.equal(view.driver.phone, '9900011111');
  assert.match(view.otp, /^\d{4}$/);
  const active = (await driver.get('/api/driver/active')).data;
  assert.equal(active.otp, undefined, 'driver never sees the OTP');
  assert.equal(active.customer.phone, '9845012345');

  assert.equal((await driver.post(`/api/driver/bookings/${id}/arrived`)).status, 200);
  const wrong = view.otp === '0000' ? '1111' : '0000';
  assert.equal((await driver.post(`/api/driver/bookings/${id}/start`, { otp: wrong })).status, 400);
  assert.equal((await driver.post(`/api/driver/bookings/${id}/start`, { otp: view.otp })).status, 200);
  assert.equal((await customer.get(`/api/bookings/${id}`)).data.otp, null, 'OTP hidden once started');
  assert.equal((await customer.post(`/api/bookings/${id}/cancel`)).status, 409, 'cannot cancel a started trip');

  // Pretend the trip ran 2h40m: billed as 3h.
  db.prepare('UPDATE bookings SET started_at = ? WHERE id = ?').run(new Date(Date.now() - 160 * 60_000).toISOString(), id);
  const done = await driver.post(`/api/driver/bookings/${id}/complete`);
  assert.equal(done.status, 200);
  assert.deepEqual(done.data, { billed_minutes: 180, amount: 60000, commission: 12000, driver_earning: 48000 });

  const earnings = (await driver.get('/api/driver/earnings')).data;
  assert.equal(earnings.totals.earned, 48000);
  assert.equal((await admin.get('/api/admin/overview')).data.today.commission, 12000);
});

test('driver dropping a trip puts it back up; admin can assign and cancel', async () => {
  const admin = await login('admin@test.in');
  const customer = await login('meena@test.in');
  const driver = await login('ravi@test.in');
  await customer.put('/api/me', { name: 'Meena', phone: '9845099999' });
  const car = await customer.post('/api/cars', { model: 'Creta', reg_no: 'KA05MN4321', transmission: 'automatic' });
  const { data } = await customer.post('/api/bookings', { car_id: car.data.id, hours: 2, pickup_address: 'Koramangala 5th Block', ...MG_ROAD });

  const ravi = (await admin.get('/api/admin/drivers')).data.find((d) => d.email === 'ravi@test.in');
  assert.equal((await admin.post(`/api/admin/bookings/${data.id}/assign`, { driver_id: ravi.user_id })).status, 200);
  assert.equal((await driver.post(`/api/driver/bookings/${data.id}/cancel`)).status, 200);
  assert.equal((await customer.get(`/api/bookings/${data.id}`)).data.status, 'requested');

  assert.equal((await admin.post(`/api/admin/bookings/${data.id}/cancel`, { reason: 'test' })).status, 200);
  assert.equal((await customer.get(`/api/bookings/${data.id}`)).data.status, 'cancelled');
});

test('settings are validated', async () => {
  const admin = await login('admin@test.in');
  assert.equal((await admin.put('/api/admin/settings', { commission_pct: 95 })).status, 400);
  const ok = await admin.put('/api/admin/settings', { hourly_rate: 25000 });
  assert.equal(ok.data.hourly_rate, 25000);
});
