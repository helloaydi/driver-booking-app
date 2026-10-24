import { useState } from 'react';
import { api, usePoll } from '../api.js';
import { useMe } from '../me.js';

export default function Profile() {
  const { me, refresh } = useMe();
  const [name, setName] = useState(me.name);
  const [phone, setPhone] = useState(me.phone ?? '');
  const [msg, setMsg] = useState(null);

  async function save(e) {
    e.preventDefault();
    try {
      await api('/api/me', { method: 'PUT', body: { name, phone } });
      setMsg({ ok: true, text: 'Saved' });
      refresh();
    } catch (err) {
      setMsg({ ok: false, text: err.message });
    }
  }

  async function logout() {
    await api('/api/auth/logout', { method: 'POST', body: {} });
    location.href = '/';
  }

  return (
    <div className="stack">
      <h2>Profile</h2>
      {!me.phone && <p className="notice">Add your mobile number so your driver can reach you.</p>}
      <form className="card stack" onSubmit={save}>
        <label>Name<input value={name} onChange={(e) => setName(e.target.value)} required /></label>
        <label>Mobile number<input inputMode="tel" placeholder="98450 12345" value={phone} onChange={(e) => setPhone(e.target.value)} required /></label>
        <small className="muted">{me.email}</small>
        <button>Save</button>
        {msg && <p className={msg.ok ? 'success' : 'error'}>{msg.text}</p>}
      </form>
      {me.phone && <Cars />}
      <button className="secondary" onClick={logout}>Sign out</button>
    </div>
  );
}

export function Cars({ onAdded }) {
  const cars = usePoll('/api/cars');
  const [form, setForm] = useState({ model: '', reg_no: '', transmission: 'manual' });
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState('');
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  async function add(e) {
    e.preventDefault();
    try {
      const { id } = await api('/api/cars', { method: 'POST', body: form });
      setForm({ model: '', reg_no: '', transmission: 'manual' });
      setAdding(false);
      setError('');
      await cars.reload();
      onAdded?.(id);
    } catch (err) {
      setError(err.message);
    }
  }

  async function remove(id) {
    if (!confirm('Remove this car?')) return;
    await api(`/api/cars/${id}`, { method: 'DELETE' });
    cars.reload();
  }

  return (
    <section className="card stack">
      <h3>My cars</h3>
      {cars.data?.length === 0 && !adding && <p className="muted">No cars yet.</p>}
      {cars.data?.map((c) => (
        <div key={c.id} className="row between">
          <span><strong>{c.model}</strong> · {c.reg_no} · <span className="muted">{c.transmission}</span></span>
          <button className="link" onClick={() => remove(c.id)}>Remove</button>
        </div>
      ))}
      {adding ? (
        <form className="stack" onSubmit={add}>
          <label>Car model<input placeholder="Maruti Swift" value={form.model} onChange={set('model')} required /></label>
          <label>Registration number<input placeholder="KA 01 AB 1234" value={form.reg_no} onChange={set('reg_no')} required /></label>
          <fieldset className="segmented">
            {['manual', 'automatic'].map((t) => (
              <label key={t} className={form.transmission === t ? 'on' : ''}>
                <input type="radio" name="transmission" value={t} checked={form.transmission === t} onChange={set('transmission')} />
                {t === 'manual' ? 'Manual' : 'Automatic'}
              </label>
            ))}
          </fieldset>
          <div className="row">
            <button>Add car</button>
            <button type="button" className="secondary" onClick={() => setAdding(false)}>Cancel</button>
          </div>
          {error && <p className="error">{error}</p>}
        </form>
      ) : (
        <button className="secondary" onClick={() => setAdding(true)}>+ Add a car</button>
      )}
    </section>
  );
}
