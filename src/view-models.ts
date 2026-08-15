import type { AppConfig } from './config.js';
import type { Database } from './db.js';
import { openToken } from './lib/crypto.js';
import { formatDate, formatMoney } from './lib/format.js';
import type { AgreementRow, BookingRow, GuestRow, PaymentRow } from './types.js';
import { balanceDueDate } from './services/payment.js';

export function bookingViewModel(db: Database, config: AppConfig, booking: BookingRow) {
  const guest = db.prepare('SELECT * FROM guests WHERE id = ?').get(booking.primary_guest_id) as unknown as GuestRow;
  const additionalGuests = db.prepare('SELECT * FROM booking_guests WHERE booking_id = ? ORDER BY position').all(booking.id);
  const agreements = db.prepare('SELECT * FROM agreements WHERE booking_id = ? ORDER BY version DESC').all(booking.id) as unknown as AgreementRow[];
  const payments = db.prepare('SELECT * FROM payments WHERE booking_id = ? ORDER BY created_at DESC').all(booking.id) as unknown as PaymentRow[];
  const events = db.prepare('SELECT * FROM booking_events WHERE booking_id = ? ORDER BY created_at DESC').all(booking.id) as Array<
    Record<string, unknown>
  >;
  const tokenRow = db.prepare(`
    SELECT token_ciphertext FROM guest_access_tokens WHERE booking_id = ? AND revoked_at IS NULL AND expires_at > unixepoch()
    ORDER BY created_at DESC LIMIT 1
  `).get(booking.id) as { token_ciphertext: string } | undefined;
  const token = tokenRow ? openToken(tokenRow.token_ciphertext, config.COOKIE_SECRET) : '';
  return {
    ...booking,
    guest,
    additionalGuests,
    agreements,
    payments: payments.map((payment) => ({
      ...payment,
      amountFormatted: formatMoney(payment.amount_minor, payment.currency),
      refundedFormatted: formatMoney(payment.refunded_minor, payment.currency),
      purposeFormatted: payment.purpose === 'BALANCE' ? 'Balance' : 'Initial payment',
      methodFormatted: payment.payment_method === 'BANK_TRANSFER' ? 'Bank transfer' : payment.payment_method === 'CARD' ? 'Card' : 'Not selected',
      dueDateFormatted: payment.due_date ? formatDate(payment.due_date) : '',
    })),
    events: events.map((event) => ({
      ...event,
      details: JSON.parse(String(event.details_json ?? '{}')),
      createdFormatted: new Date(String(event.created_at)).toLocaleString('en-GB', { timeZone: 'Europe/Rome' }),
    })),
    checkInFormatted: formatDate(booking.check_in),
    checkOutFormatted: formatDate(booking.check_out),
    paymentDeadlineFormatted: formatDate(booking.payment_deadline),
    balanceDueFormatted: formatDate(balanceDueDate(booking.check_in)),
    rentalPriceFormatted: formatMoney(booking.rental_price_minor, booking.currency),
    amountDueFormatted: formatMoney(booking.amount_due_minor, booking.currency),
    remainingBalanceFormatted: formatMoney(booking.remaining_balance_minor, booking.currency),
    securityDepositFormatted: formatMoney(booking.security_deposit_minor, booking.currency),
    touristTaxFormatted: formatMoney(booking.tourist_tax_minor, booking.currency),
    guestUrl: token ? `${config.APP_BASE_URL}/booking/${encodeURIComponent(token)}` : '',
  };
}
