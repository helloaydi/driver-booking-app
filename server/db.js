import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

// Each entry runs once, in order. Never edit an entry that has shipped; add a new one.
const MIGRATIONS = [
  `
  CREATE TABLE users (
    id          INTEGER PRIMARY KEY,
    email       TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    picture     TEXT,
    phone       TEXT,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE TABLE sessions (
    token_hash  TEXT PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id),
    expires_at  TEXT NOT NULL
  );

  CREATE TABLE cars (
    id            INTEGER PRIMARY KEY,
    user_id       INTEGER NOT NULL REFERENCES users(id),
    model         TEXT NOT NULL,
    reg_no        TEXT NOT NULL,
    transmission  TEXT NOT NULL CHECK (transmission IN ('manual', 'automatic')),
    deleted       INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  -- One row per user who applied to drive. status: pending | approved | rejected
  CREATE TABLE drivers (
    user_id           INTEGER PRIMARY KEY REFERENCES users(id),
    status            TEXT NOT NULL DEFAULT 'pending',
    licence_no        TEXT NOT NULL,
    experience_years  INTEGER NOT NULL,
    transmission      TEXT NOT NULL CHECK (transmission IN ('manual', 'automatic', 'both')),
    is_online         INTEGER NOT NULL DEFAULT 0,
    lat               REAL,
    lng               REAL,
    location_at       TEXT,
    reviewed_at       TEXT,
    created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  -- Money is stored in paise. Rates are copied onto the booking so later
  -- settings changes never alter an existing booking.
  -- status: requested | accepted | arrived | started | completed | cancelled
  CREATE TABLE bookings (
    id                 INTEGER PRIMARY KEY,
    customer_id        INTEGER NOT NULL REFERENCES users(id),
    driver_id          INTEGER REFERENCES users(id),
    car_id             INTEGER NOT NULL REFERENCES cars(id),
    status             TEXT NOT NULL DEFAULT 'requested',
    pickup_address     TEXT NOT NULL,
    pickup_lat         REAL NOT NULL,
    pickup_lng         REAL NOT NULL,
    booked_hours       REAL NOT NULL,
    hourly_rate        INTEGER NOT NULL,
    min_hours          REAL NOT NULL,
    billing_step_min   INTEGER NOT NULL,
    commission_pct     REAL NOT NULL,
    estimate           INTEGER NOT NULL,
    otp                TEXT NOT NULL,
    requested_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    accepted_at        TEXT,
    arrived_at         TEXT,
    started_at         TEXT,
    completed_at       TEXT,
    cancelled_at       TEXT,
    cancelled_by       TEXT,
    cancel_reason      TEXT,
    billed_minutes     INTEGER,
    amount             INTEGER,
    commission         INTEGER,
    driver_earning     INTEGER,
    payment_status     TEXT NOT NULL DEFAULT 'unpaid',
    payout_status      TEXT NOT NULL DEFAULT 'unpaid'
  );
  CREATE INDEX bookings_status ON bookings(status);
  CREATE INDEX bookings_customer ON bookings(customer_id);
  CREATE INDEX bookings_driver ON bookings(driver_id);

  CREATE TABLE settings (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL
  );
  `,
  `
  -- One row per Razorpay order. status: created | paid
  CREATE TABLE payments (
    id          INTEGER PRIMARY KEY,
    booking_id  INTEGER NOT NULL REFERENCES bookings(id),
    order_id    TEXT NOT NULL UNIQUE,
    payment_id  TEXT,
    amount      INTEGER NOT NULL,
    status      TEXT NOT NULL DEFAULT 'created',
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    paid_at     TEXT
  );
  CREATE INDEX payments_booking ON payments(booking_id);

  ALTER TABLE bookings ADD COLUMN paid_at TEXT;
  ALTER TABLE bookings ADD COLUMN payout_at TEXT;
  `,
  `
  -- Location sharing was removed: pickups are by address only.
  ALTER TABLE bookings DROP COLUMN pickup_lat;
  ALTER TABLE bookings DROP COLUMN pickup_lng;
  ALTER TABLE drivers DROP COLUMN lat;
  ALTER TABLE drivers DROP COLUMN lng;
  ALTER TABLE drivers DROP COLUMN location_at;
  DELETE FROM settings WHERE key = 'match_radius_km';
  `,
];

export const DEFAULT_SETTINGS = {
  hourly_rate: 20000, // paise: ₹200 per hour
  min_hours: 2,
  billing_step_min: 30, // trip time is rounded up to this many minutes
  commission_pct: 20,
  request_timeout_min: 10, // unaccepted requests are cancelled after this
};

export function openDb(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  const version = db.pragma('user_version', { simple: true });
  for (let i = version; i < MIGRATIONS.length; i++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[i]);
      db.pragma(`user_version = ${i + 1}`);
    })();
  }

  const insert = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) insert.run(key, String(value));

  return db;
}

export function getSettings(db) {
  const settings = {};
  for (const { key, value } of db.prepare('SELECT key, value FROM settings').all()) {
    settings[key] = Number(value);
  }
  return settings;
}
