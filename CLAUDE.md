# DriverBooking

On-demand hourly driver booking for Bangalore: our driver drives the customer's own car.
One Node app serves the API and a React PWA with three areas: customer (`/`), driver (`/driver`), admin (`/admin`).

## Stack
- `server/` Express 5 + better-sqlite3. Entry: `server/index.js`. Schema migrations in `server/db.js` (append only).
- `web/` React + Vite PWA (`web/public/sw.js` is a hand-written network-first service worker). Built to `web/dist/`, served by Express.
- Auth: Google Identity Services ID token → `POST /api/auth/google` → our own httpOnly session cookie. `DEV_LOGIN=1` adds a no-Google login for local dev only.
- Admins: emails in `ADMIN_EMAILS`. Drivers: any user applies, an admin approves.

## Business rules
- Hourly pricing only. Money is in paise. Rates/commission are copied onto each booking at request time.
- Fare = hourly_rate × actual trip time rounded up to `billing_step_min`, minimum `min_hours`.
- Booking status: requested → accepted → arrived → started → completed (or cancelled). A driver dropping a trip puts it back to requested.
- The 4-digit OTP is shown only in the customer app (accepted/arrived) and the driver enters it to start. Never send it to the driver API.
- Pickup must be within 35 km of central Bangalore. Drivers see requests within `match_radius_km` that match their transmission.
- No cash. Online payment (Razorpay) is not built yet.

## Commands
- `npm run dev` (API on :4602, reads `.env`) + `npm run dev:web` (Vite on :5173, proxies /api)
- `npm test`, `npm run build`, `npm start`
