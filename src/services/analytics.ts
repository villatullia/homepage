import type { Database } from '../db.js';

export const BOOKING_COM_COMMISSION_BASIS_POINTS = 2250;

export function directPerformance(db: Database) {
  const enquiries = (db.prepare("SELECT COUNT(*) AS count FROM enquiries WHERE source = 'WEBSITE' AND status <> 'SPAM'").get() as { count: number }).count;
  const bookings = (db.prepare(`SELECT COUNT(*) AS count FROM bookings b JOIN enquiries e ON e.id = b.enquiry_id WHERE e.source = 'WEBSITE'`).get() as { count: number }).count;
  const confirmed = db.prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(b.rental_price_minor), 0) AS revenue
    FROM bookings b JOIN enquiries e ON e.id = b.enquiry_id
    WHERE e.source = 'WEBSITE' AND b.status = 'CONFIRMED'
  `).get() as { count: number; revenue: number };
  const seasonRows = db.prepare(`
    SELECT substr(b.check_in, 1, 4) AS year, COUNT(*) AS bookings, COALESCE(SUM(b.rental_price_minor), 0) AS revenue
    FROM bookings b JOIN enquiries e ON e.id = b.enquiry_id
    WHERE e.source = 'WEBSITE' AND b.status = 'CONFIRMED'
    GROUP BY substr(b.check_in, 1, 4) ORDER BY year DESC
  `).all() as Array<{ year: string; bookings: number; revenue: number }>;
  const avoided = (amount: number) => Math.round((amount * BOOKING_COM_COMMISSION_BASIS_POINTS) / 10_000);
  return {
    enquiries,
    bookings,
    confirmedWeeks: confirmed.count,
    conversionRate: enquiries ? Math.round((bookings / enquiries) * 1000) / 10 : 0,
    confirmedRevenueMinor: confirmed.revenue,
    estimatedCommissionAvoidedMinor: avoided(confirmed.revenue),
    seasons: seasonRows.map((row) => ({
      year: row.year,
      bookings: row.bookings,
      revenueMinor: row.revenue,
      estimatedCommissionAvoidedMinor: avoided(row.revenue),
    })),
  };
}
