import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

export default function Login({ onSignedIn }) {
  const [config, setConfig] = useState(null);
  const [error, setError] = useState('');
  const [devEmail, setDevEmail] = useState('');
  const button = useRef(null);

  useEffect(() => {
    api('/api/config').then(setConfig, () => setError('Could not reach the server'));
  }, []);

  useEffect(() => {
    if (!config?.googleClientId) return;
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.onload = () => {
      window.google.accounts.id.initialize({
        client_id: config.googleClientId,
        callback: async ({ credential }) => {
          try {
            await api('/api/auth/google', { method: 'POST', body: { credential } });
            onSignedIn();
          } catch (e) {
            setError(e.message);
          }
        },
      });
      window.google.accounts.id.renderButton(button.current, {
        theme: 'outline', size: 'large', shape: 'pill', text: 'continue_with', width: 280,
      });
    };
    script.onerror = () => setError('Could not load Google sign-in');
    document.head.appendChild(script);
    return () => script.remove();
  }, [config, onSignedIn]);

  async function devLogin(e) {
    e.preventDefault();
    try {
      await api('/api/auth/dev', { method: 'POST', body: { email: devEmail } });
      onSignedIn();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="login">
      <img src="/icon.svg" alt="" width="72" height="72" />
      <h1>DriverBooking</h1>
      <p className="muted">A trusted driver for your own car, by the hour. Now in {config?.city.name ?? 'Bangalore'}.</p>
      <div ref={button} className="google-button" />
      {config && !config.googleClientId && !config.devLogin && (
        <p className="error">Google sign-in is not set up yet.</p>
      )}
      {config?.devLogin && (
        <form onSubmit={devLogin} className="card stack">
          <strong>Developer sign-in</strong>
          <small className="muted">Only on your computer. Turned off in production.</small>
          <input type="email" placeholder="any@email.com" value={devEmail} onChange={(e) => setDevEmail(e.target.value)} required />
          <button>Sign in</button>
        </form>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
