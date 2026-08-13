import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Database } from '../db.js';
import { nextBookingReference, withImmediateTransaction } from '../db.js';
import type { AppConfig } from '../config.js';
import { nowIso } from '../lib/format.js';
import { randomToken, sealToken, sha256 } from '../lib/crypto.js';
import type { BookingRow } from '../types.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const enquirySchema = z
  .object({
    name: z.string().trim().min(2).max(160),
    email: z.string().trim().email().max(254),
    phone: z.string().trim().max(60).optional().default(''),
    message: z.string().trim().min(1).max(4000),
    checkIn: isoDate.optional().or(z.literal('')),
    checkOut: isoDate.optional().or(z.literal('')),
    guestsCount: z.coerce.number().int().min(1).max(8).optional(),
    website: z.string().max(200).optional().default(''),
  })
  .refine((data) => (!data.checkIn && !data.checkOut) || Boolean(data.checkIn && data.checkOut && data.checkOut > data.checkIn), {
    message: 'Please choose valid stay dates',
  });

export interface BookingInput {
  legalName: string;
  email: string;
  phone: string;
  addressLine1: string;
  addressLine2?: string;
  postalCode: string;
  city: string;
  region?: string;
  country: string;
  guestsCount: number;
  additionalGuests: string[];
  checkIn: string;
  checkOut: string;
  rentalPriceMinor: number;
  amountDueMinor: number;
  remainingBalanceMinor: number;
  securityDepositMinor: number;
  touristTaxMinor: number;
  currency: string;
  paymentDeadline: string;
  cancellationTerms: string;
  specialConditions: string;
}

export const bookingInputSchema = z
  .object({
    legalName: z.string().trim().min(2).max(200),
    email: z.string().trim().email().max(254),
    phone: z.string().trim().min(5).max(60),
    addressLine1: z.string().trim().min(3).max(250),
    addressLine2: z.string().trim().max(250).optional().default(''),
    postalCode: z.string().trim().min(2).max(30),
    city: z.string().trim().min(2).max(120),
    region: z.string().trim().max(120).optional().default(''),
    country: z.string().trim().min(2).max(120),
    guestsCount: z.coerce.number().int().min(1).max(8),
    additionalGuests: z.array(z.string().trim().min(2).max(200)).max(7),
    checkIn: isoDate,
    checkOut: isoDate,
    rentalPriceMinor: z.number().int().min(0),
    amountDueMinor: z.number().int().min(0),
    remainingBalanceMinor: z.number().int().min(0),
    securityDepositMinor: z.number().int().min(0),
    touristTaxMinor: z.number().int().min(0),
    currency: z.string().trim().length(3).transform((value) => value.toUpperCase()),
    paymentDeadline: isoDate,
    cancellationTerms: z.string().trim().min(3).max(10_000),
    specialConditions: z.string().trim().max(10_000).default(''),
  })
  .refine((data) => data.checkOut > data.checkIn, { message: 'Check-out must be after check-in', path: ['checkOut'] })
  .refine((data) => data.paymentDeadline <= data.checkIn, {
    message: 'Payment deadline must not be after check-in',
    path: ['paymentDeadline'],
  })
  .refine((data) => data.additionalGuests.length <= Math.max(0, data.guestsCount - 1), {
    message: 'There are more guest names than the total number of guests',
    path: ['additionalGuests'],
  })
  .refine(
    (data) =>
      data.amountDueMinor + data.remainingBalanceMinor <=
      data.rentalPriceMinor + data.securityDepositMinor + data.touristTaxMinor,
    { message: 'Payment amounts exceed the total charges', path: ['amountDueMinor'] },
  );

export function createEnquiry(
  db: Database,
  input: z.infer<typeof enquirySchema>,
  metadata: { ipHash?: string },
): { id: string; reference: string } {
  const id = randomUUID();
  const reference = `ENQ-${new Date().getUTCFullYear()}-${randomToken(5).replace(/[-_]/g, '').slice(0, 7).toUpperCase()}`;
  const timestamp = nowIso();
  db.prepare(`
    INSERT INTO enquiries
      (id, reference, status, full_name, email, phone, requested_check_in, requested_check_out,
       guests_count, message, source, privacy_notice_version, ip_hash, created_at, updated_at)
    VALUES (?, ?, 'ENQUIRY_NEW', ?, ?, ?, ?, ?, ?, ?, 'WEBSITE', '2026-07-30', ?, ?, ?)
  `).run(
    id,
    reference,
    input.name,
    input.email,
    input.phone || null,
    input.checkIn || null,
    input.checkOut || null,
    input.guestsCount ?? null,
    input.message,
    metadata.ipHash ?? null,
    timestamp,
    timestamp,
  );
  return { id, reference };
}

export function createBooking(
  db: Database,
  config: AppConfig,
  raw: BookingInput,
  enquiryId?: string,
): { booking: BookingRow; guestToken: string } {
  const input = bookingInputSchema.parse(raw);
  return withImmediateTransaction(db, () => {
    if (enquiryId) {
      const enquiry = db.prepare('SELECT status FROM enquiries WHERE id = ?').get(enquiryId) as { status: string } | undefined;
      if (!enquiry) throw new Error('Enquiry not found');
      if (!['ENQUIRY_NEW', 'ENQUIRY_APPROVED'].includes(enquiry.status)) throw new Error('Enquiry has already been processed');
    }
    const timestamp = nowIso();
    const guestId = randomUUID();
    db.prepare(`
      INSERT INTO guests
        (id, legal_name, email, phone, address_line1, address_line2, postal_code, city, region, country, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      guestId,
      input.legalName,
      input.email,
      input.phone,
      input.addressLine1,
      input.addressLine2 || null,
      input.postalCode,
      input.city,
      input.region || null,
      input.country,
      timestamp,
      timestamp,
    );
    const bookingId = randomUUID();
    const reference = nextBookingReference(db, Number(input.checkIn.slice(0, 4)));
    db.prepare(`
      INSERT INTO bookings
        (id, reference, property_id, enquiry_id, primary_guest_id, status, check_in, check_out, guests_count,
         currency, rental_price_minor, amount_due_minor, remaining_balance_minor, security_deposit_minor,
         tourist_tax_minor, payment_deadline, cancellation_terms, special_conditions, created_at, updated_at)
      VALUES (?, ?, 'villa-tullia', ?, ?, 'AGREEMENT_DRAFT', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      bookingId,
      reference,
      enquiryId ?? null,
      guestId,
      input.checkIn,
      input.checkOut,
      input.guestsCount,
      input.currency || config.DEFAULT_CURRENCY,
      input.rentalPriceMinor,
      input.amountDueMinor,
      input.remainingBalanceMinor,
      input.securityDepositMinor,
      input.touristTaxMinor,
      input.paymentDeadline,
      input.cancellationTerms,
      input.specialConditions,
      timestamp,
      timestamp,
    );
    input.additionalGuests.forEach((name, index) => {
      db.prepare('INSERT INTO booking_guests (id, booking_id, full_name, position) VALUES (?, ?, ?, ?)').run(
        randomUUID(),
        bookingId,
        name,
        index + 1,
      );
    });
    if (enquiryId) {
      db.prepare("UPDATE enquiries SET status = 'CONVERTED', updated_at = ? WHERE id = ?").run(timestamp, enquiryId);
    }
    db.prepare(`
      INSERT INTO booking_events
        (id, booking_id, actor_type, event_type, to_status, details_json, created_at)
      VALUES (?, ?, 'ADMIN', 'BOOKING_CREATED', 'AGREEMENT_DRAFT', ?, ?)
    `).run(randomUUID(), bookingId, JSON.stringify({ enquiryId: enquiryId ?? null }), timestamp);
    const guestToken = randomToken();
    db.prepare(`
      INSERT INTO guest_access_tokens (id, booking_id, token_hash, token_ciphertext, purpose, expires_at, created_at)
      VALUES (?, ?, ?, ?, 'STATUS', ?, ?)
    `).run(
      randomUUID(),
      bookingId,
      sha256(guestToken),
      sealToken(guestToken, config.COOKIE_SECRET),
      Math.floor(Date.now() / 1000) + 370 * 24 * 60 * 60,
      timestamp,
    );
    return {
      booking: db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId) as unknown as BookingRow,
      guestToken,
    };
  });
}

export function updateDraftBooking(db: Database, bookingId: string, raw: BookingInput): BookingRow {
  const input = bookingInputSchema.parse(raw);
  return withImmediateTransaction(db, () => {
    const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId) as BookingRow | undefined;
    if (!booking) throw new Error('Booking not found');
    if (booking.status !== 'AGREEMENT_DRAFT') throw new Error('Only draft bookings can be edited');
    const sent = db.prepare(`SELECT 1 FROM agreements WHERE booking_id = ? AND status IN ('SENT','OWNER_SIGNED','COMPLETED')`).get(bookingId);
    if (sent) throw new Error('A sent agreement prevents editing');
    const timestamp = nowIso();
    db.prepare(`
      UPDATE guests SET legal_name = ?, email = ?, phone = ?, address_line1 = ?, address_line2 = ?,
        postal_code = ?, city = ?, region = ?, country = ?, updated_at = ? WHERE id = ?
    `).run(
      input.legalName,
      input.email,
      input.phone,
      input.addressLine1,
      input.addressLine2 || null,
      input.postalCode,
      input.city,
      input.region || null,
      input.country,
      timestamp,
      booking.primary_guest_id,
    );
    db.prepare(`
      UPDATE bookings SET check_in = ?, check_out = ?, guests_count = ?, currency = ?, rental_price_minor = ?,
        amount_due_minor = ?, remaining_balance_minor = ?, security_deposit_minor = ?, tourist_tax_minor = ?,
        payment_deadline = ?, cancellation_terms = ?, special_conditions = ?, version = version + 1, updated_at = ?
      WHERE id = ?
    `).run(
      input.checkIn,
      input.checkOut,
      input.guestsCount,
      input.currency,
      input.rentalPriceMinor,
      input.amountDueMinor,
      input.remainingBalanceMinor,
      input.securityDepositMinor,
      input.touristTaxMinor,
      input.paymentDeadline,
      input.cancellationTerms,
      input.specialConditions,
      timestamp,
      bookingId,
    );
    db.prepare('DELETE FROM booking_guests WHERE booking_id = ?').run(bookingId);
    input.additionalGuests.forEach((name, index) => {
      db.prepare('INSERT INTO booking_guests (id, booking_id, full_name, position) VALUES (?, ?, ?, ?)').run(
        randomUUID(),
        bookingId,
        name,
        index + 1,
      );
    });
    db.prepare(`
      UPDATE agreements SET status = 'INVALIDATED', invalidated_at = ?, invalidated_reason = 'Booking details changed', updated_at = ?
      WHERE booking_id = ? AND status = 'DRAFT'
    `).run(timestamp, timestamp, bookingId);
    db.prepare(`
      INSERT INTO booking_events (id, booking_id, actor_type, event_type, details_json, created_at)
      VALUES (?, ?, 'ADMIN', 'BOOKING_UPDATED', '{}', ?)
    `).run(randomUUID(), bookingId, timestamp);
    return db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId) as unknown as BookingRow;
  });
}

export function releaseExpiredHolds(db: Database): number {
  return withImmediateTransaction(db, () => {
    const expired = db.prepare(`
      SELECT b.id, b.status FROM bookings b JOIN date_blocks d ON d.booking_id = b.id
      WHERE d.released_at IS NULL AND d.kind = 'HOLD' AND d.expires_at <= unixepoch()
        AND b.status IN ('AWAITING_OWNER_SIGNATURE','AWAITING_GUEST_SIGNATURE','AGREEMENT_SIGNED','AWAITING_PAYMENT','PAYMENT_PROCESSING','PAYMENT_FAILED')
    `).all() as Array<{ id: string; status: string }>;
    const timestamp = nowIso();
    for (const row of expired) {
      db.prepare("UPDATE bookings SET status = 'EXPIRED', version = version + 1, updated_at = ? WHERE id = ?").run(timestamp, row.id);
      db.prepare(`UPDATE date_blocks SET released_at = ?, release_reason = 'hold_expired', updated_at = ? WHERE booking_id = ?`).run(
        timestamp,
        timestamp,
        row.id,
      );
      db.prepare(`
        INSERT INTO booking_events
          (id, booking_id, actor_type, event_type, from_status, to_status, details_json, created_at)
        VALUES (?, ?, 'SYSTEM', 'HOLD_EXPIRED', ?, 'EXPIRED', '{}', ?)
      `).run(randomUUID(), row.id, row.status, timestamp);
    }
    return expired.length;
  });
}
