import crypto from 'node:crypto';
import { getSettings } from './db.js';

export const ACTIVE = ['requested', 'accepted', 'arrived', 'started'];
const now = () => new Date().toISOString();

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const newOtp = () => String(crypto.randomInt(0, 10000)).padStart(4, '0');

// Cancels requests nobody accepted in time. Cheap enough to run before reads.
export function expireRequests(db) {
  const { request_timeout_min } = getSettings(db);
  const cutoff = new Date(Date.now() - request_timeout_min * 60_000).toISOString();
  db.prepare(
    `UPDATE bookings SET status = 'cancelled', cancelled_at = ?, cancelled_by = 'system',
       cancel_reason = 'No driver accepted in time'
     WHERE status = 'requested' AND requested_at < ?`,
  ).run(now(), cutoff);
}

export function activeBookingFor(db, column, userId) {
  return db
    .prepare(`SELECT * FROM bookings WHERE ${column} = ? AND status IN (${ACTIVE.map(() => '?').join(',')})`)
    .get(userId, ...ACTIVE);
}

// Moves a booking from one status to the next, only if it is still in the
// expected status. Returns false when someone else got there first.
export function transition(db, id, from, to, extra = {}) {
  const fields = { status: to, ...extra };
  const sets = Object.keys(fields).map((k) => `${k} = @${k}`);
  const fromList = [].concat(from);
  const result = db
    .prepare(
      `UPDATE bookings SET ${sets.join(', ')}
       WHERE id = @id AND status IN (${fromList.map((_, i) => `@from${i}`).join(',')})`,
    )
    .run({ ...fields, id, ...Object.fromEntries(fromList.map((s, i) => [`from${i}`, s])) });
  return result.changes === 1;
}

export { now };
