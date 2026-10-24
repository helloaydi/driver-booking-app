// Bangalore service area: a circle around the city centre.
export const CITY = { name: 'Bangalore', lat: 12.9716, lng: 77.5946, radius_km: 35 };

export function distanceKm(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

export function inServiceArea(lat, lng) {
  return distanceKm(lat, lng, CITY.lat, CITY.lng) <= CITY.radius_km;
}

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
