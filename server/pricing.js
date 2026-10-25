export const CITY = { name: 'Bangalore' };

// Upfront estimate shown before booking: the hours the customer asked for,
// never less than the minimum.
export function estimate({ hourly_rate, min_hours }, bookedHours) {
  return Math.round(hourly_rate * Math.max(bookedHours, min_hours));
}

// Final fare from the actual trip time. Minutes are rounded up to the
// billing step, with the minimum hours applied.
export function finalFare(booking, tripMinutes) {
  const step = booking.billing_step_min;
  const billedMinutes = Math.max(Math.ceil(tripMinutes / step) * step, booking.min_hours * 60);
  const amount = Math.round((booking.hourly_rate * billedMinutes) / 60);
  const commission = Math.round((amount * booking.commission_pct) / 100);
  return { billed_minutes: billedMinutes, amount, commission, driver_earning: amount - commission };
}
