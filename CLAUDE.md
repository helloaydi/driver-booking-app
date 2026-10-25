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
- No location sharing: pickup is a typed address only, and there is no service-area check. Online drivers see every open request whose car transmission they can drive, oldest first.
- No cash. The customer pays online right after the trip (Razorpay Checkout) and can't book again until paid.
  `server/payments.js`: order via Razorpay Orders API (plain fetch, no SDK), confirmed by the checkout signature
  (`/api/payments/verify`) and/or the signed webhook (`/api/payments/webhook`, public, checks amount). Both are idempotent.
- Driver payouts are manual: admin pays by bank/UPI, then marks it on /admin/payouts (only customer-paid trips count).

## Commands
- `npm run dev` (API on :4602, reads `.env`) + `npm run dev:web` (Vite on :5173, proxies /api)
- `npm test`, `npm run build`, `npm start`

## Deployment
Shared course server (about 15 students). Full guide: `DEPLOY-GUIDE.md`.

| | |
|---|---|
| Server | `ssh siyasparayil@187.127.162.81` (key login) |
| App name | `driverbooking` |
| Port | 4602 on 127.0.0.1 |
| Address | https://driverbooking-siyasparayil.dhilber.in (HTTPS ends at the instructor's proxy) |
| Code | `~/apps/driverbooking` (clone of https://github.com/helloaydi/driver-booking-app, public) |
| Database | `~/data/driverbooking/driverbooking.db` |
| Backups | `~/data/driverbooking/backups/`, nightly at 21:48 UTC via crontab, kept 14 days |
| Settings | `~/.config/driverbooking.env` (chmod 600): PORT, HOST, NODE_ENV, DB_PATH, ADMIN_EMAILS, GOOGLE_CLIENT_ID, RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET |
| Service | `~/.config/systemd/user/driverbooking.service`, runs `node server/index.js` |

Update after pushing to GitHub:
```
ssh siyasparayil@187.127.162.81 "cd ~/apps/driverbooking && git pull && npm ci && npm run build && systemctl --user restart driverbooking"
```
Then check `systemctl --user status driverbooking --no-pager`, `curl -s http://127.0.0.1:4602/api/health`, and the address.
Logs: `journalctl --user -u driverbooking -n 50 --no-pager`. After editing the env file, restart the service.

Server rules:
1. No sudo, apt or `npm install -g`. If something needs root, the student asks the instructor.
2. Stay inside /home/siyasparayil. Never touch anything you didn't create; other students' apps run here.
3. Listen on 127.0.0.1 only, on a port in 4600–4699 (4600 tuition, 4601 quickbill, 4602 driverbooking), including test runs.
4. Don't touch the web server, firewall or DNS.
5. Secrets only in `~/.config/driverbooking.env`, never in git or this file.
6. Keep it running with `systemctl --user`, not pm2, nohup, screen or `&`.
