import { afterEach, describe, expect, it } from 'vitest';
import { createBooking, createEnquiry, enquirySchema } from '../src/services/booking.js';
import { directPerformance } from '../src/services/analytics.js';
import { createTestContext, validBooking } from './helpers.js';

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach((close) => close()));

describe('direct booking performance', () => {
  it('uses confirmed website rental revenue and the 22.5% Booking.com benchmark', () => {
    const context = createTestContext();
    cleanup.push(context.close);
    const enquiry = createEnquiry(context.db, enquirySchema.parse({
      name: 'Ada Lovelace', email: 'ada@example.test', message: 'A direct website enquiry', website: '',
    }), {});
    const { booking } = createBooking(context.db, context.config, validBooking(), enquiry.id);
    context.db.prepare("UPDATE bookings SET status = 'CONFIRMED' WHERE id = ?").run(booking.id);
    const result = directPerformance(context.db);
    expect(result).toMatchObject({ enquiries: 1, bookings: 1, confirmedWeeks: 1, conversionRate: 100, confirmedRevenueMinor: 300000, estimatedCommissionAvoidedMinor: 67500 });
    expect(result.seasons).toEqual([{ year: '2027', bookings: 1, revenueMinor: 300000, estimatedCommissionAvoidedMinor: 67500 }]);
  });
});
