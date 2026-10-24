import { useEffect, useState } from 'react';
import { NavLink, Route, Routes } from 'react-router-dom';
import { STATUS_LABEL, api, hoursLabel, minutesLabel, rupees, timeLabel, usePoll } from '../api.js';

export default function Admin() {
  return (
    <div className="admin">
      <nav className="subnav">
        <NavLink to="/admin" end>Overview</NavLink>
        <NavLink to="/admin/bookings">Bookings</NavLink>
        <NavLink to="/admin/drivers">Drivers</NavLink>
        <NavLink to="/admin/settings">Pricing</NavLink>
      </nav>
      <Routes>
        <Route index element={<Overview />} />
        <Route path="bookings" element={<Bookings />} />
        <Route path="drivers" element={<Drivers />} />
        <Route path="settings" element={<Settings />} />
      </Routes>
    </div>
  );
}

function Overview() {
  const { data } = usePoll('/api/admin/overview', 10000);
  if (!data) return null;
  const count = (s) => data.active.find((a) => a.status === s)?.n ?? 0;
  return (
    <div className="stack">
      <div className="tiles">
        <div className="card tile"><small>Waiting for a driver</small><strong>{count('requested')}</strong></div>
        <div className="card tile"><small>Driver on the way</small><strong>{count('accepted') + count('arrived')}</strong></div>
        <div className="card tile"><small>Trips in progress</small><strong>{count('started')}</strong></div>
        <div className="card tile"><small>Drivers online</small><strong>{data.online_drivers}</strong></div>
        <div className="card tile"><small>Applications to review</small><strong>{data.pending_drivers}</strong></div>
        <div className="card tile"><small>Trips today (UTC)</small><strong>{data.today.trips}</strong></div>
        <div className="card tile"><small>Fares today</small><strong>{rupees(data.today.revenue)}</strong></div>
        <div className="card tile"><small>Commission today</small><strong>{rupees(data.today.commission)}</strong></div>
      </div>
      <h3>Live bookings</h3>
      <BookingTable status="active" />
    </div>
  );
}

function Bookings() {
  const [status, setStatus] = useState('active');
  return (
    <div className="stack">
      <div className="segmented inline">
        {[['active', 'Active'], ['completed', 'Completed'], ['cancelled', 'Cancelled'], ['all', 'All']].map(([v, label]) => (
          <button key={v} className={status === v ? 'on' : ''} onClick={() => setStatus(v)}>{label}</button>
        ))}
      </div>
      <BookingTable status={status} />
    </div>
  );
}

function BookingTable({ status }) {
  const bookings = usePoll(`/api/admin/bookings?status=${status}`, 10000);
  const drivers = usePoll('/api/admin/drivers');
  const [error, setError] = useState('');
  const free = drivers.data?.filter((d) => d.status === 'approved' && !d.active_booking_id) ?? [];

  async function act(path, body) {
    setError('');
    try {
      await api(path, { method: 'POST', body });
      bookings.reload();
      drivers.reload();
    } catch (e) {
      setError(e.message);
    }
  }

  if (!bookings.data) return null;
  if (!bookings.data.length) return <p className="muted">No bookings.</p>;
  return (
    <>
      {error && <p className="error">{error}</p>}
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>#</th><th>Requested</th><th>Status</th><th>Customer</th><th>Car</th><th>Pickup</th><th>Hours</th><th>Driver</th><th>Fare</th><th></th></tr>
          </thead>
          <tbody>
            {bookings.data.map((b) => (
              <tr key={b.id}>
                <td>{b.id}</td>
                <td>{timeLabel(b.requested_at)}</td>
                <td><span className={`pill pill-${b.status}`}>{STATUS_LABEL[b.status]}</span></td>
                <td>{b.customer_name}<div className="muted">{b.customer_phone}</div></td>
                <td>{b.car_model}<div className="muted">{b.reg_no} · {b.transmission}</div></td>
                <td className="wrap">{b.pickup_address}</td>
                <td>{b.status === 'completed' ? minutesLabel(b.billed_minutes) : hoursLabel(b.booked_hours)}</td>
                <td>
                  {b.driver_name ? <>{b.driver_name}<div className="muted">{b.driver_phone}</div></> :
                    b.status === 'requested' ? (
                      <select defaultValue="" onChange={(e) => e.target.value && act(`/api/admin/bookings/${b.id}/assign`, { driver_id: Number(e.target.value) })}>
                        <option value="">Assign…</option>
                        {free.map((d) => <option key={d.user_id} value={d.user_id}>{d.name} ({d.transmission}){d.is_online ? '' : ' · offline'}</option>)}
                      </select>
                    ) : '—'}
                </td>
                <td>
                  {b.status === 'completed' ? <>{rupees(b.amount)}<div className="muted">cut {rupees(b.commission)}</div></> : <span className="muted">~{rupees(b.estimate)}</span>}
                </td>
                <td>
                  {['requested', 'accepted', 'arrived', 'started'].includes(b.status) && (
                    <button className="link danger" onClick={() => {
                      const reason = prompt('Reason for cancelling?');
                      if (reason !== null) act(`/api/admin/bookings/${b.id}/cancel`, { reason });
                    }}>Cancel</button>
                  )}
                  {b.cancel_reason && <div className="muted">{b.cancelled_by}: {b.cancel_reason}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Drivers() {
  const drivers = usePoll('/api/admin/drivers', 15000);
  const [error, setError] = useState('');

  async function review(id, status) {
    if (status === 'rejected' && !confirm('Reject this driver?')) return;
    setError('');
    try {
      await api(`/api/admin/drivers/${id}/review`, { method: 'POST', body: { status } });
      drivers.reload();
    } catch (e) {
      setError(e.message);
    }
  }

  if (!drivers.data) return null;
  if (!drivers.data.length) return <p className="muted">No driver applications yet.</p>;
  return (
    <div className="stack">
      {error && <p className="error">{error}</p>}
      <div className="table-wrap">
        <table>
          <thead><tr><th>Driver</th><th>Status</th><th>Licence</th><th>Experience</th><th>Drives</th><th>Trips</th><th>Applied</th><th></th></tr></thead>
          <tbody>
            {drivers.data.map((d) => (
              <tr key={d.user_id}>
                <td>{d.name}<div className="muted">{d.phone} · {d.email}</div></td>
                <td>
                  <span className={`pill pill-${d.status}`}>{d.status}</span>
                  {d.status === 'approved' && <div className="muted">{d.active_booking_id ? `on trip #${d.active_booking_id}` : d.is_online ? 'online' : 'offline'}</div>}
                </td>
                <td>{d.licence_no}</td>
                <td>{d.experience_years} yrs</td>
                <td>{d.transmission}</td>
                <td>{d.trips}</td>
                <td>{timeLabel(d.created_at)}</td>
                <td className="actions">
                  {d.status !== 'approved' && <button className="link" onClick={() => review(d.user_id, 'approved')}>Approve</button>}
                  {d.status !== 'rejected' && <button className="link danger" onClick={() => review(d.user_id, 'rejected')}>Reject</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Money settings are shown in rupees but stored in paise.
const FIELDS = [
  ['hourly_rate', 'Hourly rate (₹)', 100],
  ['min_hours', 'Minimum hours', 1],
  ['billing_step_min', 'Round trip time up to (minutes)', 1],
  ['commission_pct', 'Our commission (%)', 1],
  ['match_radius_km', 'Show requests to drivers within (km)', 1],
  ['request_timeout_min', 'Cancel unaccepted requests after (minutes)', 1],
];

function Settings() {
  const settings = usePoll('/api/admin/settings');
  const [form, setForm] = useState(null);
  const [msg, setMsg] = useState(null);

  useEffect(() => {
    if (settings.data) setForm(Object.fromEntries(FIELDS.map(([k, , scale]) => [k, settings.data[k] / scale])));
  }, [settings.data]);

  async function save(e) {
    e.preventDefault();
    try {
      const body = Object.fromEntries(FIELDS.map(([k, , scale]) => [k, Math.round(Number(form[k]) * scale)]));
      await api('/api/admin/settings', { method: 'PUT', body });
      setMsg({ ok: true, text: 'Saved. New bookings use these prices; existing bookings keep theirs.' });
      settings.reload();
    } catch (err) {
      setMsg({ ok: false, text: err.message });
    }
  }

  if (!form) return null;
  return (
    <form className="card stack narrow" onSubmit={save}>
      <h3>Pricing and matching</h3>
      {FIELDS.map(([k, label]) => (
        <label key={k}>{label}
          <input type="number" step="any" value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} required />
        </label>
      ))}
      <button className="primary">Save</button>
      {msg && <p className={msg.ok ? 'success' : 'error'}>{msg.text}</p>}
    </form>
  );
}
