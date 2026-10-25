import { useEffect, useState } from 'react';
import { STATUS_LABEL, api, hoursLabel, minutesLabel, rupees, timeLabel, usePoll } from '../api.js';
import { Cars } from './Profile.jsx';

const ACTIVE = ['requested', 'accepted', 'arrived', 'started'];

export default function Customer() {
  const bookings = usePoll('/api/bookings', 5000);
  if (bookings.loading) return <p className="muted">Loading…</p>;
  const latest = bookings.data?.[0];
  const active = latest && ACTIVE.includes(latest.status) ? latest : null;
  const unpaid = bookings.data?.find((b) => b.status === 'completed' && b.payment_status === 'unpaid');

  return (
    <div className="stack">
      {unpaid && <PaymentDue booking={unpaid} onPaid={bookings.reload} />}
      {active ? <ActiveBooking booking={active} onChange={bookings.reload} /> : !unpaid && <BookForm onBooked={bookings.reload} />}
    </div>
  );
}

function BookForm({ onBooked }) {
  const cars = usePoll('/api/cars');
  const [carId, setCarId] = useState(null);
  const [hours, setHours] = useState(null);
  const [address, setAddress] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const quote = usePoll(`/api/estimate${hours ? `?hours=${hours}` : ''}`);

  useEffect(() => {
    if (hours === null && quote.data) setHours(quote.data.min_hours);
  }, [quote.data, hours]);
  useEffect(() => {
    if (carId === null && cars.data?.length) setCarId(cars.data[0].id);
  }, [cars.data, carId]);

  async function book(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/api/bookings', { method: 'POST', body: { car_id: carId, hours, pickup_address: address } });
      onBooked();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (cars.loading) return null;
  if (!cars.data?.length) {
    return (
      <>
        <h2>Book a driver</h2>
        <p className="muted">First, tell us about your car.</p>
        <Cars onAdded={(id) => { setCarId(id); cars.reload(); }} />
      </>
    );
  }

  const q = quote.data;
  const minHours = q?.min_hours ?? 1;
  return (
    <form className="stack" onSubmit={book}>
      <h2>Book a driver</h2>
      <p className="muted">Our driver comes to you and drives your car.</p>

      <label>Car
        <select value={carId ?? ''} onChange={(e) => setCarId(Number(e.target.value))}>
          {cars.data.map((c) => <option key={c.id} value={c.id}>{c.model} · {c.reg_no} ({c.transmission})</option>)}
        </select>
      </label>

      <div className="field">
        <span>How long do you need the driver?</span>
        <div className="stepper">
          <button type="button" className="secondary" disabled={!hours || hours <= minHours} onClick={() => setHours(hours - 0.5)}>−</button>
          <strong>{hours ? hoursLabel(hours) : '…'}</strong>
          <button type="button" className="secondary" disabled={!hours || hours >= 12} onClick={() => setHours(hours + 0.5)}>+</button>
        </div>
      </div>

      <label>Pickup address
        <textarea rows="2" placeholder="House no., street, area, landmark" value={address} onChange={(e) => setAddress(e.target.value)} required />
      </label>

      {q && (
        <div className="card quote">
          <div className="row between"><span>Estimated fare</span><strong className="big">{rupees(q.estimate)}</strong></div>
          <small className="muted">
            {rupees(q.hourly_rate)}/hour, minimum {hoursLabel(q.min_hours)}. You pay for the actual trip time,
            rounded up to {q.billing_step_min} minutes.
          </small>
        </div>
      )}

      {error && <p className="error">{error}</p>}
      <button className="primary" disabled={busy || !carId}>{busy ? 'Booking…' : 'Book driver now'}</button>
    </form>
  );
}

function ActiveBooking({ booking: b, onChange }) {
  const [error, setError] = useState('');

  async function cancel() {
    if (!confirm('Cancel this booking?')) return;
    try {
      await api(`/api/bookings/${b.id}/cancel`, { method: 'POST', body: {} });
      onChange();
    } catch (e) {
      setError(e.message);
    }
  }

  return (
    <div className="stack">
      <div className={`status status-${b.status}`}>
        {b.status === 'requested' && <span className="pulse" />}
        <h2>{STATUS_LABEL[b.status]}</h2>
        {b.status === 'requested' && <p>We're matching you with a driver. This usually takes a few minutes.</p>}
        {b.status === 'started' && <Elapsed since={b.started_at} />}
      </div>

      {b.otp && (
        <div className="card otp">
          <small>Your trip OTP</small>
          <strong>{b.otp}</strong>
          <small className="muted">Tell this to your driver when you're ready to start. Don't share it before they arrive.</small>
        </div>
      )}

      {b.driver && (
        <div className="card row">
          {b.driver.picture && <img className="avatar" src={b.driver.picture} alt="" referrerPolicy="no-referrer" />}
          <div className="grow">
            <strong>{b.driver.name}</strong>
            <div className="muted">{b.driver.experience_years} years driving</div>
          </div>
          <a className="button secondary" href={`tel:+91${b.driver.phone}`}>Call</a>
        </div>
      )}

      <div className="card stack small">
        <div className="row between"><span className="muted">Car</span><span>{b.car.model} · {b.car.reg_no}</span></div>
        <div className="row between"><span className="muted">Pickup</span><span className="right">{b.pickup_address}</span></div>
        <div className="row between"><span className="muted">Booked for</span><span>{hoursLabel(b.booked_hours)}</span></div>
        <div className="row between"><span className="muted">Estimate</span><span>{rupees(b.estimate)}</span></div>
      </div>

      {error && <p className="error">{error}</p>}
      {['requested', 'accepted', 'arrived'].includes(b.status) && (
        <button className="secondary danger" onClick={cancel}>Cancel booking</button>
      )}
    </div>
  );
}

function Elapsed({ since }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30000);
    return () => clearInterval(t);
  }, []);
  return <p>Started {timeLabel(since)} · {minutesLabel(Math.floor((Date.now() - Date.parse(since)) / 60000))} so far</p>;
}

function loadCheckout() {
  if (window.Razorpay) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://checkout.razorpay.com/v1/checkout.js';
    script.onload = resolve;
    script.onerror = () => reject(new Error('Could not load the payment page. Check your connection.'));
    document.head.appendChild(script);
  });
}

function PaymentDue({ booking: b, onPaid }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function pay() {
    setBusy(true);
    setError('');
    try {
      await loadCheckout();
      const order = await api('/api/payments/order', { method: 'POST', body: { booking_id: b.id } });
      new window.Razorpay({
        key: order.key_id,
        order_id: order.order_id,
        amount: order.amount,
        currency: order.currency,
        name: 'DriverBooking',
        description: `Trip #${b.id} · ${minutesLabel(b.billed_minutes)}`,
        prefill: order.prefill,
        theme: { color: '#0f766e' },
        handler: async (response) => {
          try {
            await api('/api/payments/verify', { method: 'POST', body: response });
            onPaid();
          } catch (e) {
            setError(e.message);
          }
        },
        modal: { ondismiss: () => setBusy(false) },
      })
        .on('payment.failed', (r) => setError(r.error?.description || 'Payment failed. Please try again.'))
        .open();
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  }

  return (
    <div className="card notice stack">
      <div className="row between">
        <strong>Trip completed</strong>
        <strong className="big">{rupees(b.amount)}</strong>
      </div>
      <small>{minutesLabel(b.billed_minutes)} billed · {b.car.model}. Please pay to book your next trip.</small>
      {error && <p className="error">{error}</p>}
      <button className="primary" onClick={pay} disabled={busy}>{busy ? 'Opening payment…' : `Pay ${rupees(b.amount)}`}</button>
    </div>
  );
}
