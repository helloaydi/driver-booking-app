import { useState } from 'react';
import { NavLink, Route, Routes } from 'react-router-dom';
import { STATUS_LABEL, api, hoursLabel, minutesLabel, rupees, timeLabel, usePoll } from '../api.js';
import { useMe } from '../me.js';

export default function Driver() {
  const profile = usePoll('/api/driver/profile', 15000);
  if (profile.loading) return <p className="muted">Loading…</p>;
  const p = profile.data;

  if (!p || p.status === 'rejected') return <Apply rejected={p?.status === 'rejected'} onApplied={profile.reload} />;
  if (p.status === 'pending') {
    return (
      <div className="card stack">
        <h2>Application received</h2>
        <p>Thanks for applying. Our team will check your licence and call you. This page updates when you're approved.</p>
      </div>
    );
  }
  return (
    <>
      <Routes>
        <Route path="earnings" element={<Earnings />} />
        <Route path="*" element={<DriverHome profile={p} onChange={profile.reload} />} />
      </Routes>
      <nav className="tabbar">
        <NavLink to="/driver" end>Trips</NavLink>
        <NavLink to="/driver/earnings">Earnings</NavLink>
      </nav>
    </>
  );
}

function Apply({ rejected, onApplied }) {
  const { me } = useMe();
  const [form, setForm] = useState({ licence_no: '', experience_years: '', transmission: 'both' });
  const [error, setError] = useState('');
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  async function submit(e) {
    e.preventDefault();
    try {
      await api('/api/driver/apply', { method: 'POST', body: { ...form, experience_years: Number(form.experience_years) } });
      onApplied();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <form className="stack" onSubmit={submit}>
      <h2>Drive with us</h2>
      {rejected && <p className="notice">Your last application wasn't approved. You can update your details and apply again.</p>}
      <p className="muted">Drive customers' own cars around {me.city.name} and earn by the hour.</p>
      <label>Driving licence number<input placeholder="KA01 20150012345" value={form.licence_no} onChange={set('licence_no')} required /></label>
      <label>Years of driving experience<input type="number" min="1" max="50" value={form.experience_years} onChange={set('experience_years')} required /></label>
      <fieldset className="segmented">
        <legend>Cars you can drive</legend>
        {[['manual', 'Manual'], ['automatic', 'Automatic'], ['both', 'Both']].map(([v, label]) => (
          <label key={v} className={form.transmission === v ? 'on' : ''}>
            <input type="radio" name="transmission" value={v} checked={form.transmission === v} onChange={set('transmission')} />
            {label}
          </label>
        ))}
      </fieldset>
      {error && <p className="error">{error}</p>}
      <button className="primary">Apply</button>
    </form>
  );
}

function DriverHome({ profile, onChange }) {
  const online = Boolean(profile.is_online);
  const active = usePoll('/api/driver/active', 5000);
  const requests = usePoll(online ? '/api/driver/requests' : null, 5000);
  const [fare, setFare] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function toggle() {
    setBusy(true);
    setError('');
    try {
      await api('/api/driver/online', { method: 'POST', body: { online: !online } });
      onChange();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function accept(id) {
    setError('');
    try {
      await api(`/api/driver/bookings/${id}/accept`, { method: 'POST', body: {} });
      active.reload();
    } catch (e) {
      setError(e.message);
      requests.reload();
    }
  }

  if (active.data) return <ActiveTrip trip={active.data} onChange={active.reload} onCompleted={setFare} />;

  return (
    <div className="stack">
      {fare && <FareSummary fare={fare} onClose={() => setFare(null)} />}
      <div className={`card row between ${online ? 'online' : ''}`}>
        <div>
          <strong>{online ? 'You are online' : 'You are offline'}</strong>
          <div className="muted small">{online ? 'New trip requests appear below.' : 'Go online to get trips.'}</div>
        </div>
        <button className={online ? 'secondary' : 'primary'} onClick={toggle} disabled={busy}>
          {busy ? '…' : online ? 'Go offline' : 'Go online'}
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      {online && Array.isArray(requests.data) && (
        requests.data.length === 0 ? (
          <p className="muted center">No requests right now. Keep this screen open.</p>
        ) : (
          requests.data.map((r) => (
            <div key={r.id} className="card stack">
              <div className="row between">
                <strong>{hoursLabel(r.booked_hours)}</strong>
                <strong className="big">{rupees(r.est_earning)}</strong>
              </div>
              <div>{r.pickup_address}</div>
              <div className="muted small">{r.model} ({r.transmission}) · {hoursLabel(r.booked_hours)} · you earn about {rupees(r.est_earning)}</div>
              <button className="primary" onClick={() => accept(r.id)}>Accept trip</button>
            </div>
          ))
        )
      )}
    </div>
  );
}

function ActiveTrip({ trip: t, onChange, onCompleted }) {
  const { me } = useMe();
  const [otp, setOtp] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function act(action, body = {}, confirmText) {
    if (confirmText && !confirm(confirmText)) return;
    setBusy(true);
    setError('');
    try {
      const result = await api(`/api/driver/bookings/${t.id}/${action}`, { method: 'POST', body });
      if (action === 'complete') onCompleted(result);
      onChange();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const maps = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${t.pickup_address}, ${me.city.name}`)}`;

  return (
    <div className="stack">
      <div className={`status status-${t.status}`}>
        <h2>{STATUS_LABEL[t.status]}</h2>
        {t.status === 'started' && <p>Started {timeLabel(t.started_at)}</p>}
      </div>

      <div className="card row">
        {t.customer.picture && <img className="avatar" src={t.customer.picture} alt="" referrerPolicy="no-referrer" />}
        <div className="grow">
          <strong>{t.customer.name}</strong>
          <div className="muted small">{t.car.model} · {t.car.reg_no} · {t.car.transmission}</div>
        </div>
        <a className="button secondary" href={`tel:+91${t.customer.phone}`}>Call</a>
      </div>

      <div className="card stack small">
        <div className="row between"><span className="muted">Pickup</span><span className="right">{t.pickup_address}</span></div>
        <div className="row between"><span className="muted">Booked for</span><span>{hoursLabel(t.booked_hours)}</span></div>
        <a href={maps} target="_blank" rel="noreferrer">Open directions in Google Maps</a>
      </div>

      {error && <p className="error">{error}</p>}

      {t.status === 'accepted' && (
        <button className="primary" disabled={busy} onClick={() => act('arrived')}>I've arrived</button>
      )}
      {['accepted', 'arrived'].includes(t.status) && (
        <form className="card stack" onSubmit={(e) => { e.preventDefault(); act('start', { otp }); }}>
          <label>Customer's OTP
            <input className="otp-input" inputMode="numeric" maxLength="4" pattern="\d{4}" placeholder="••••" value={otp}
              onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))} required />
          </label>
          <button className="primary" disabled={busy || otp.length !== 4}>Start trip</button>
        </form>
      )}
      {t.status === 'started' && (
        <button className="primary" disabled={busy} onClick={() => act('complete', {}, 'End this trip now?')}>End trip</button>
      )}
      {['accepted', 'arrived'].includes(t.status) && (
        <button className="secondary danger" disabled={busy}
          onClick={() => act('cancel', {}, 'Drop this trip? It will go to another driver.')}>Drop trip</button>
      )}
    </div>
  );
}

function FareSummary({ fare, onClose }) {
  return (
    <div className="card notice stack">
      <strong>Trip completed</strong>
      <div className="row between"><span>Billed time</span><span>{minutesLabel(fare.billed_minutes)}</span></div>
      <div className="row between"><span>Customer pays</span><span>{rupees(fare.amount)}</span></div>
      <div className="row between"><strong>You earn</strong><strong>{rupees(fare.driver_earning)}</strong></div>
      <small>Collect nothing in cash. The customer pays online.</small>
      <button className="secondary" onClick={onClose}>Done</button>
    </div>
  );
}

function Earnings() {
  const { data } = usePoll('/api/driver/earnings');
  if (!data) return null;
  return (
    <div className="stack">
      <h2>Earnings</h2>
      <div className="tiles">
        <div className="card tile"><small>Trips</small><strong>{data.totals.trips}</strong></div>
        <div className="card tile"><small>Total earned</small><strong>{rupees(data.totals.earned)}</strong></div>
        <div className="card tile"><small>Not yet paid out</small><strong>{rupees(data.totals.unpaid)}</strong></div>
      </div>
      {data.trips.map((t) => (
        <div key={t.id} className="card row between small">
          <div>
            <strong>{timeLabel(t.completed_at)}</strong>
            <div className="muted">{minutesLabel(t.billed_minutes)} · {t.pickup_address}</div>
          </div>
          <div className="right">
            <strong>{rupees(t.driver_earning)}</strong>
            <div className="muted">{t.payout_status === 'paid' ? 'Paid out' : 'Pending'}</div>
          </div>
        </div>
      ))}
    </div>
  );
}
