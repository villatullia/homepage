import { randomUUID } from 'node:crypto';
import Stripe from 'stripe';
import type { AppConfig } from '../config.js';
import type { Database } from '../db.js';
import { confirmDateBlock, releaseDateBlock, transitionBooking, withImmediateTransaction } from '../db.js';
import { nowIso } from '../lib/format.js';
import { randomToken } from '../lib/crypto.js';
import type { AgreementRow, BookingRow, PaymentRow } from '../types.js';

export interface PaymentProvider {
  readonly name: 'mock' | 'stripe';
  createCheckout(
    booking: BookingRow,
    agreement: AgreementRow,
    attempt: number,
    guestEmail: string,
    amountMinor: number,
    purpose: 'INITIAL' | 'BALANCE',
  ): Promise<{ sessionId: string; url: string }>;
}

class MockPaymentProvider implements PaymentProvider {
  readonly name = 'mock' as const;
  constructor(private readonly config: AppConfig) {}

  async createCheckout(): Promise<{ sessionId: string; url: string }> {
    const sessionId = `mockpay_${randomToken(24)}`;
    return { sessionId, url: `${this.config.APP_BASE_URL}/mock-pay/${encodeURIComponent(sessionId)}` };
  }
}

class StripePaymentProvider implements PaymentProvider {
  readonly name = 'stripe' as const;
  private readonly client: Stripe;

  constructor(private readonly config: AppConfig) {
    if (!config.STRIPE_SECRET_KEY.startsWith('sk_test_')) {
      throw new Error('Stripe must remain in test mode until production activation is explicitly configured');
    }
    this.client = new Stripe(config.STRIPE_SECRET_KEY);
  }

  async createCheckout(
    booking: BookingRow,
    agreement: AgreementRow,
    attempt: number,
    guestEmail: string,
    amountMinor: number,
    purpose: 'INITIAL' | 'BALANCE',
  ): Promise<{ sessionId: string; url: string }> {
    const metadata = {
      booking_id: booking.id,
      booking_reference: booking.reference,
      agreement_version: String(agreement.version),
      payment_purpose: purpose,
    };
    const session = await this.client.checkout.sessions.create(
      {
        mode: 'payment',
        customer_email: guestEmail,
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: booking.currency.toLowerCase(),
              unit_amount: amountMinor,
              product_data: { name: `Villa Tullia ${purpose === 'BALANCE' ? 'balance' : 'booking'} ${booking.reference}` },
            },
          },
        ],
        metadata,
        payment_intent_data: { metadata },
        success_url: `${this.config.APP_BASE_URL}/payment/return?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${this.config.APP_BASE_URL}/payment/return?cancelled=1`,
        expires_at: Math.floor(Date.now() / 1000) + 24 * 60 * 60,
      },
      { idempotencyKey: `${booking.id}:agreement:${agreement.version}:attempt:${attempt}` },
    );
    if (!session.url) throw new Error('Stripe did not return a Checkout URL');
    return { sessionId: session.id, url: session.url };
  }
}

export function createPaymentProvider(config: AppConfig): PaymentProvider {
  return config.PAYMENT_PROVIDER === 'stripe' ? new StripePaymentProvider(config) : new MockPaymentProvider(config);
}

export function balanceDueDate(checkIn: string): string {
  const date = new Date(`${checkIn}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 15);
  return date.toISOString().slice(0, 10);
}

export async function createPaymentRequest(
  db: Database,
  provider: PaymentProvider,
  bookingId: string,
  agreementId: string,
  purpose: 'INITIAL' | 'BALANCE' = 'INITIAL',
): Promise<PaymentRow> {
  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId) as BookingRow | undefined;
  const agreement = db.prepare('SELECT * FROM agreements WHERE id = ?').get(agreementId) as AgreementRow | undefined;
  if (!booking || !agreement) throw new Error('Booking or agreement not found');
  const allowed = purpose === 'INITIAL'
    ? ['AGREEMENT_SIGNED', 'AWAITING_PAYMENT', 'PAYMENT_FAILED']
    : ['CONFIRMED'];
  if (!allowed.includes(booking.status)) {
    throw new Error(purpose === 'BALANCE' ? 'Balance cannot be requested before the booking is confirmed' : 'Payment cannot be requested before both signatures are complete');
  }
  if (purpose === 'BALANCE' && booking.remaining_balance_minor <= 0) throw new Error('This booking has no remaining balance');
  if (agreement.status !== 'COMPLETED' || !agreement.guest_signed_at || !agreement.owner_signed_at) {
    throw new Error('The completed agreement is not signed by both parties');
  }
  const existing = db.prepare(`
    SELECT * FROM payments WHERE booking_id = ? AND agreement_id = ? AND purpose = ?
      AND status IN ('CREATED','PENDING','PROCESSING','SUCCEEDED')
    ORDER BY created_at DESC LIMIT 1
  `).get(bookingId, agreementId, purpose) as PaymentRow | undefined;
  if (existing) return existing;
  const count = db.prepare('SELECT COUNT(*) AS count FROM payments WHERE booking_id = ?').get(bookingId) as { count: number };
  const guest = db.prepare('SELECT email FROM guests WHERE id = ?').get(booking.primary_guest_id) as { email: string };
  const amountMinor = purpose === 'BALANCE' ? booking.remaining_balance_minor : booking.amount_due_minor;
  const dueDate = purpose === 'BALANCE' ? balanceDueDate(booking.check_in) : booking.payment_deadline;
  const checkout = await provider.createCheckout(booking, agreement, count.count + 1, guest.email, amountMinor, purpose);
  const timestamp = nowIso();
  const paymentId = randomUUID();
  withImmediateTransaction(db, () => {
    db.prepare(`
      INSERT INTO payments
        (id, booking_id, agreement_id, agreement_version, provider, purpose, due_date, status, amount_minor, currency,
         checkout_session_id, checkout_url, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?, ?, ?, ?)
    `).run(
      paymentId,
      bookingId,
      agreementId,
      agreement.version,
      provider.name,
      purpose,
      dueDate,
      amountMinor,
      booking.currency,
      checkout.sessionId,
      checkout.url,
      timestamp,
      timestamp,
    );
    if (purpose === 'INITIAL' && (booking.status === 'AGREEMENT_SIGNED' || booking.status === 'PAYMENT_FAILED')) {
      transitionBooking(db, bookingId, 'AWAITING_PAYMENT', { type: 'SYSTEM' }, 'PAYMENT_REQUEST_CREATED', {
        paymentId,
        provider: provider.name,
      });
    }
    const deadlineEpoch = Math.floor(new Date(`${dueDate}T09:00:00+02:00`).getTime() / 1000);
    const reminderAt = Math.max(Math.floor(Date.now() / 1000) + 300, deadlineEpoch - 24 * 60 * 60);
    db.prepare(`
      INSERT OR IGNORE INTO scheduled_jobs
        (id, job_type, booking_id, run_at, payload_json, idempotency_key, status, created_at)
      VALUES (?, 'PAYMENT_REMINDER', ?, ?, ?, ?, 'PENDING', ?)
    `).run(randomUUID(), bookingId, reminderAt, JSON.stringify({ paymentId }), `payment-reminder:${paymentId}`, timestamp);
  });
  return db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId) as unknown as PaymentRow;
}

export function markPaymentProcessing(db: Database, payment: PaymentRow, paymentIntentId?: string): void {
  withImmediateTransaction(db, () => {
    if (['SUCCEEDED', 'REFUNDED'].includes(payment.status)) return;
    db.prepare(`
      UPDATE payments SET status = 'PROCESSING', payment_intent_id = COALESCE(?, payment_intent_id), updated_at = ? WHERE id = ?
    `).run(paymentIntentId ?? null, nowIso(), payment.id);
    const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(payment.booking_id) as unknown as BookingRow;
    if (payment.purpose === 'INITIAL' && (booking.status === 'AWAITING_PAYMENT' || booking.status === 'PAYMENT_FAILED')) {
      transitionBooking(db, booking.id, 'PAYMENT_PROCESSING', { type: 'PAYMENT_PROVIDER' }, 'PAYMENT_PROCESSING');
    }
  });
}

export function markPaymentSucceeded(
  db: Database,
  payment: PaymentRow,
  details: { paymentIntentId?: string; chargeId?: string },
): boolean {
  return withImmediateTransaction(db, () => {
    const current = db.prepare('SELECT * FROM payments WHERE id = ?').get(payment.id) as unknown as PaymentRow;
    if (current.status === 'SUCCEEDED' || current.status === 'REFUNDED') return false;
    const timestamp = nowIso();
    db.prepare(`
      UPDATE payments SET status = 'SUCCEEDED', payment_intent_id = COALESCE(?, payment_intent_id),
        charge_id = COALESCE(?, charge_id), paid_at = ?, updated_at = ? WHERE id = ?
    `).run(details.paymentIntentId ?? null, details.chargeId ?? null, timestamp, timestamp, payment.id);
    const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(payment.booking_id) as unknown as BookingRow;
    if (current.purpose === 'INITIAL') {
      if (!['AWAITING_PAYMENT', 'PAYMENT_PROCESSING', 'PAYMENT_FAILED'].includes(booking.status)) {
        throw new Error(`Cannot confirm booking from ${booking.status}`);
      }
      transitionBooking(db, booking.id, 'CONFIRMED', { type: 'PAYMENT_PROVIDER' }, 'PAYMENT_SUCCEEDED', { paymentId: payment.id });
      confirmDateBlock(db, booking.id);
      if (booking.remaining_balance_minor > 0) {
        const runAt = Math.max(Math.floor(Date.now() / 1000) + 60, Math.floor(new Date(`${balanceDueDate(booking.check_in)}T09:00:00+02:00`).getTime() / 1000));
        db.prepare(`
          INSERT OR IGNORE INTO scheduled_jobs
            (id, job_type, booking_id, run_at, payload_json, idempotency_key, status, created_at)
          VALUES (?, 'BALANCE_PAYMENT_REQUEST', ?, ?, '{}', ?, 'PENDING', ?)
        `).run(randomUUID(), booking.id, runAt, `balance-payment-request:${booking.id}`, timestamp);
      }
    } else {
      db.prepare(`INSERT INTO booking_events
        (id, booking_id, actor_type, event_type, details_json, created_at)
        VALUES (?, ?, 'PAYMENT_PROVIDER', 'BALANCE_PAYMENT_SUCCEEDED', ?, ?)
      `).run(randomUUID(), booking.id, JSON.stringify({ paymentId: payment.id }), timestamp);
    }
    return true;
  });
}

export function markPaymentFailed(db: Database, payment: PaymentRow, code?: string, message?: string): boolean {
  return withImmediateTransaction(db, () => {
    const current = db.prepare('SELECT * FROM payments WHERE id = ?').get(payment.id) as unknown as PaymentRow;
    if (['SUCCEEDED', 'REFUNDED', 'FAILED'].includes(current.status)) return false;
    db.prepare(`
      UPDATE payments SET status = 'FAILED', failure_code = ?, failure_message = ?, updated_at = ? WHERE id = ?
    `).run(code ?? null, message?.slice(0, 1000) ?? null, nowIso(), payment.id);
    const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(payment.booking_id) as unknown as BookingRow;
    if (current.purpose === 'INITIAL' && (booking.status === 'AWAITING_PAYMENT' || booking.status === 'PAYMENT_PROCESSING')) {
      transitionBooking(db, booking.id, 'PAYMENT_FAILED', { type: 'PAYMENT_PROVIDER' }, 'PAYMENT_FAILED', { code });
    }
    return true;
  });
}

export function markRefund(
  db: Database,
  payment: PaymentRow,
  refundedMinor: number,
  chargeId?: string,
): boolean {
  return withImmediateTransaction(db, () => {
    const current = db.prepare('SELECT * FROM payments WHERE id = ?').get(payment.id) as unknown as PaymentRow;
    if (refundedMinor <= current.refunded_minor) return false;
    const full = refundedMinor >= current.amount_minor;
    const timestamp = nowIso();
    db.prepare(`
      UPDATE payments SET status = ?, refunded_minor = ?, charge_id = COALESCE(?, charge_id), refunded_at = ?, updated_at = ?
      WHERE id = ?
    `).run(full ? 'REFUNDED' : 'PARTIALLY_REFUNDED', Math.min(refundedMinor, current.amount_minor), chargeId ?? null, timestamp, timestamp, payment.id);
    const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(payment.booking_id) as unknown as BookingRow;
    const totals = db.prepare(`
      SELECT
        COALESCE(SUM(amount_minor), 0) AS paid_total,
        COALESCE(SUM(refunded_minor), 0) AS refunded_total
      FROM payments
      WHERE booking_id = ? AND status IN ('SUCCEEDED','REFUNDED','PARTIALLY_REFUNDED')
    `).get(payment.booking_id) as { paid_total: number; refunded_total: number };
    if (full && totals.paid_total > 0 && totals.refunded_total >= totals.paid_total && ['CONFIRMED', 'CANCELLED'].includes(booking.status)) {
      transitionBooking(db, booking.id, 'REFUNDED', { type: 'PAYMENT_PROVIDER' }, 'PAYMENT_REFUNDED', {
        paymentId: payment.id,
        refundedMinor,
      });
      releaseDateBlock(db, booking.id, 'fully_refunded');
    }
    return true;
  });
}

export function stripeClient(config: AppConfig): Stripe {
  if (!config.STRIPE_SECRET_KEY) throw new Error('Stripe secret key is not configured');
  return new Stripe(config.STRIPE_SECRET_KEY);
}
