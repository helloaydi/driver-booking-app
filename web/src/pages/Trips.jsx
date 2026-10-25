import { STATUS_LABEL, hoursLabel, minutesLabel, rupees, timeLabel, usePoll } from '../api.js';

export default function Trips() {
  const bookings = usePoll('/api/bookings');
  return (
    <div className="stack">
      <h2>Your trips</h2>
      {bookings.data?.length === 0 && <p className="muted">No trips yet.</p>}
      {bookings.data?.map((b) => (
        <div key={b.id} className="card stack small">
          <div className="row between">
            <strong>{timeLabel(b.requested_at)}</strong>
            <span className={`pill pill-${b.status}`}>{STATUS_LABEL[b.status]}</span>
          </div>
          <div className="muted">{b.pickup_address}</div>
          <div className="row between">
            <span>{b.car.model}{b.driver && ` · ${b.driver.name}`}</span>
            <span>
              {b.status === 'completed'
                ? `${minutesLabel(b.billed_minutes)} · ${rupees(b.amount)} · ${b.payment_status === 'paid' ? 'Paid' : 'Payment due'}`
                : hoursLabel(b.booked_hours)}
            </span>
          </div>
          {b.cancel_reason && <small className="muted">{b.cancel_reason}</small>}
        </div>
      ))}
    </div>
  );
}
