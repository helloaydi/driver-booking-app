import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { api } from './api.js';
import { MeContext, useMe } from './me.js';
import Login from './pages/Login.jsx';
import Profile from './pages/Profile.jsx';
import Customer from './pages/Customer.jsx';
import Trips from './pages/Trips.jsx';
import Driver from './pages/Driver.jsx';
import Admin from './pages/Admin.jsx';
import './styles.css';

function App() {
  const [me, setMe] = useState(undefined);
  const refresh = () => api('/api/me').then(setMe, () => setMe(null));
  useEffect(() => { refresh(); }, []);

  if (me === undefined) return <div className="center muted">Loading…</div>;
  if (me === null) return <Login onSignedIn={refresh} />;
  return (
    <MeContext.Provider value={{ me, refresh }}>
      <Shell />
    </MeContext.Provider>
  );
}

function Shell() {
  const { me } = useMe();
  const { pathname } = useLocation();
  const area = pathname.startsWith('/admin') ? 'admin' : pathname.startsWith('/driver') ? 'driver' : 'customer';
  const needsProfile = !me.phone && pathname !== '/profile';

  return (
    <div className={`app app-${area}`}>
      <header className="topbar">
        <span className="brand">DriverBooking{area !== 'customer' && <small> · {area}</small>}</span>
        <nav className="modes">
          {area !== 'customer' && <NavLink to="/">Book</NavLink>}
          {area !== 'driver' && <NavLink to="/driver">Drive</NavLink>}
          {me.is_admin && area !== 'admin' && <NavLink to="/admin">Admin</NavLink>}
        </nav>
      </header>
      <main>
        {needsProfile ? (
          <Navigate to="/profile" replace />
        ) : (
          <Routes>
            <Route path="/" element={<Customer />} />
            <Route path="/trips" element={<Trips />} />
            <Route path="/profile" element={<Profile />} />
            <Route path="/driver/*" element={<Driver />} />
            <Route path="/admin/*" element={me.is_admin ? <Admin /> : <Navigate to="/" />} />
            <Route path="*" element={<Navigate to="/" />} />
          </Routes>
        )}
      </main>
      {area === 'customer' && (
        <nav className="tabbar">
          <NavLink to="/" end>Book</NavLink>
          <NavLink to="/trips">Trips</NavLink>
          <NavLink to="/profile">Profile</NavLink>
        </nav>
      )}
    </div>
  );
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js'));
}
