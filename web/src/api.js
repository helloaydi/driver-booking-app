import { useCallback, useEffect, useRef, useState } from 'react';

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// Loads a URL and reloads it every `intervalMs` (0 = load once, null path = skip).
export function usePoll(path, intervalMs = 0) {
  const [state, setState] = useState({ data: undefined, error: null, loading: Boolean(path) });
  const pathRef = useRef(path);
  pathRef.current = path;

  const reload = useCallback(async () => {
    if (!pathRef.current) return;
    try {
      const data = await api(pathRef.current);
      setState({ data, error: null, loading: false });
    } catch (error) {
      setState((s) => ({ ...s, error, loading: false }));
    }
  }, []);

  useEffect(() => {
    if (!path) return setState({ data: undefined, error: null, loading: false });
    reload();
    if (!intervalMs) return;
    const timer = setInterval(() => document.visibilityState === 'visible' && reload(), intervalMs);
    return () => clearInterval(timer);
  }, [path, intervalMs, reload]);

  return { ...state, reload };
}

export const rupees = (paise) =>
  paise == null ? '—' : '₹' + (paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 });

export const hoursLabel = (h) => (h === 1 ? '1 hour' : `${h} hours`);

export const minutesLabel = (m) => {
  if (m == null) return '—';
  const h = Math.floor(m / 60), r = m % 60;
  return [h && `${h}h`, r && `${r}m`].filter(Boolean).join(' ') || '0m';
};

export const timeLabel = (iso) =>
  iso ? new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—';

export function getLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('This device cannot share location'));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      (e) => reject(new Error(e.code === 1 ? 'Allow location access to continue' : 'Could not get your location')),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 },
    );
  });
}

export const STATUS_LABEL = {
  requested: 'Finding a driver',
  accepted: 'Driver on the way',
  arrived: 'Driver has arrived',
  started: 'Trip in progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
};
