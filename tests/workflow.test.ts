import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BookingRow, PaymentRow } from '../src/types.js';
import { createBooking } from '../src/services/booking.js';
import { generateAgreement } from '../src/services/agreement.js';
import { confirmBankTransfer, createPaymentProvider, markPaymentSucceeded, selectBankTransfer } from '../src/services/payment.js';
import { createSignatureProvider, type SignatureProvider } from '../src/services/signature.js';
import { EmailService } from '../src/services/email.js';
import { mockGuestSigned, mockOwnerSigned, processDocumensoEvent, sendAgreement } from '../src/services/workflow.js';
import { runDueJobs } from '../src/services/jobs.js';
import { createTestContext, validBooking } from './helpers.js';

const cleanup: Array<() => void> = [];
afterEach(() => {
  cleanup.splice(0).forEach((close) => close());
  vi.unstubAllGlobals();
});

describe('enquiry-to-confirmation workflow', () => {
  it('creates immutable agreement versions', async () => {
    const context = createTestContext();
    cleanup.push(context.close);
    const { booking } = createBooking(context.db, context.config, validBooking());
    const first = await generateAgreement(context.db, context.config, booking.id);
    const firstBytes = fs.readFileSync(first.unsigned_pdf_path);
    const second = await generateAgreement(context.db, context.config, booking.id);

    expect(second.version).toBe(2);
    expect(second.unsigned_pdf_path).not.toBe(first.unsigned_pdf_path);
    expect(fs.readFileSync(first.unsigned_pdf_path)).toEqual(firstBytes);
    expect((context.db.prepare('SELECT status FROM agreements WHERE id = ?').get(first.id) as { status: string }).status).toBe(
      'INVALIDATED',
    );
  });

  it('protects dates and confirms only after both signatures and payment', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ blockedRanges: [] }), { status: 200 })));
    const context = createTestContext();
    cleanup.push(context.close);
    const signature = createSignatureProvider(context.config);
    const paymentProvider = createPaymentProvider(context.config);
    const email = new EmailService(context.db, context.config);
    const { booking } = createBooking(context.db, context.config, validBooking());
    await generateAgreement(context.db, context.config, booking.id);
    await sendAgreement(context.db, context.config, signature, booking.id, 'test-admin');

    const conflicting = createBooking(
      context.db,
      context.config,
      validBooking({ legalName: 'Grace Hopper', email: 'grace@example.test', checkIn: '2027-06-12', checkOut: '2027-06-19' }),
    );
    await generateAgreement(context.db, context.config, conflicting.booking.id);
    await expect(sendAgreement(context.db, context.config, signature, conflicting.booking.id, 'test-admin')).rejects.toThrow(
      /date_overlap/,
    );

    mockOwnerSigned(context.db, context.config, booking.id);
    await mockGuestSigned(context.db, context.config, paymentProvider, email, booking.id);
    const beforePayment = context.db.prepare('SELECT * FROM bookings WHERE id = ?').get(booking.id) as unknown as BookingRow;
    const payment = context.db.prepare('SELECT * FROM payments WHERE booking_id = ?').get(booking.id) as unknown as PaymentRow;
    expect(beforePayment.status).toBe('AWAITING_PAYMENT');
    expect(payment.status).toBe('PENDING');
    expect(
      context.db.prepare('SELECT template_key, recipient FROM email_deliveries WHERE booking_id = ? ORDER BY created_at').all(booking.id),
    ).toEqual([{ template_key: 'payment-request', recipient: 'ada@example.test' }]);
    expect(markPaymentSucceeded(context.db, payment, { paymentIntentId: 'mock_intent' })).toBe(true);
    expect(markPaymentSucceeded(context.db, payment, { paymentIntentId: 'mock_intent' })).toBe(false);

    const balanceJob = context.db.prepare("SELECT id, run_at FROM scheduled_jobs WHERE job_type = 'BALANCE_PAYMENT_REQUEST' AND booking_id = ?").get(booking.id) as { id: string; run_at: number };
    expect(new Date(balanceJob.run_at * 1000).toISOString().slice(0, 10)).toBe('2027-05-26');
    context.db.prepare('UPDATE scheduled_jobs SET run_at = 0 WHERE id = ?').run(balanceJob.id);
    await runDueJobs(context.db, context.config, email, paymentProvider);
    const balancePayment = context.db.prepare("SELECT * FROM payments WHERE booking_id = ? AND purpose = 'BALANCE'").get(booking.id) as unknown as PaymentRow;
    expect(balancePayment.amount_minor).toBe(200000);
    expect(balancePayment.due_date).toBe('2027-05-26');
    expect(markPaymentSucceeded(context.db, balancePayment, { paymentIntentId: 'mock_balance_intent' })).toBe(true);

    const confirmed = context.db.prepare('SELECT * FROM bookings WHERE id = ?').get(booking.id) as unknown as BookingRow;
    const block = context.db.prepare('SELECT kind, expires_at FROM date_blocks WHERE booking_id = ?').get(booking.id) as {
      kind: string;
      expires_at: number | null;
    };
    expect(confirmed.status).toBe('CONFIRMED');
    expect(block).toEqual({ kind: 'CONFIRMED', expires_at: null });
    expect((context.db.prepare('SELECT status FROM bookings WHERE id = ?').get(booking.id) as { status: string }).status).toBe('CONFIRMED');
  });

  it('does not schedule a balance payment when the full amount is due initially', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ blockedRanges: [] }), { status: 200 })));
    const context = createTestContext();
    cleanup.push(context.close);
    const paymentProvider = createPaymentProvider(context.config);
    const email = new EmailService(context.db, context.config);
    const { booking } = createBooking(context.db, context.config, validBooking({ amountDueMinor: 300000, remainingBalanceMinor: 0 }));
    await generateAgreement(context.db, context.config, booking.id);
    await sendAgreement(context.db, context.config, createSignatureProvider(context.config), booking.id, 'test-admin');
    mockOwnerSigned(context.db, context.config, booking.id);
    await mockGuestSigned(context.db, context.config, paymentProvider, email, booking.id);
    const payment = context.db.prepare('SELECT * FROM payments WHERE booking_id = ?').get(booking.id) as unknown as PaymentRow;
    markPaymentSucceeded(context.db, payment, { paymentIntentId: 'mock_full_intent' });
    expect(context.db.prepare("SELECT 1 FROM scheduled_jobs WHERE job_type = 'BALANCE_PAYMENT_REQUEST' AND booking_id = ?").get(booking.id)).toBeUndefined();
  });

  it('recovers when an interrupted attempt left an untracked agreement PDF', async () => {
    const context = createTestContext();
    cleanup.push(context.close);
    const { booking } = createBooking(context.db, context.config, validBooking());
    const directory = path.join(context.config.storagePath, 'agreements', booking.reference);
    const orphanPath = path.join(directory, 'agreement-v1-unsigned.pdf');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(orphanPath, 'orphaned partial attempt');

    const agreement = await generateAgreement(context.db, context.config, booking.id);

    expect(agreement.version).toBe(1);
    expect(agreement.unsigned_pdf_path).not.toBe(orphanPath);
    expect(fs.readFileSync(orphanPath, 'utf8')).toBe('orphaned partial attempt');
    expect(fs.existsSync(agreement.unsigned_pdf_path)).toBe(true);
  });

  it('lets a guest select bank transfer and requires administrator confirmation', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ blockedRanges: [] }), { status: 200 })));
    const context = createTestContext();
    cleanup.push(context.close);
    const { booking } = createBooking(context.db, context.config, validBooking());
    await generateAgreement(context.db, context.config, booking.id);
    await sendAgreement(context.db, context.config, createSignatureProvider(context.config), booking.id, 'test-admin');
    mockOwnerSigned(context.db, context.config, booking.id);
    await mockGuestSigned(
      context.db,
      context.config,
      createPaymentProvider(context.config),
      new EmailService(context.db, context.config),
      booking.id,
    );

    const payment = context.db.prepare('SELECT * FROM payments WHERE booking_id = ?').get(booking.id) as unknown as PaymentRow;
    selectBankTransfer(context.db, payment);
    const selected = context.db.prepare('SELECT * FROM payments WHERE id = ?').get(payment.id) as unknown as PaymentRow;
    expect(selected).toMatchObject({ payment_method: 'BANK_TRANSFER', status: 'PROCESSING' });
    expect((context.db.prepare('SELECT status FROM bookings WHERE id = ?').get(booking.id) as { status: string }).status).toBe('PAYMENT_PROCESSING');

    expect(confirmBankTransfer(context.db, selected, 'test-admin')).toBe(true);
    const confirmed = context.db.prepare('SELECT * FROM payments WHERE id = ?').get(payment.id) as unknown as PaymentRow;
    expect(confirmed.status).toBe('SUCCEEDED');
    expect(confirmed.bank_transfer_confirmed_at).toBeTruthy();
    expect((context.db.prepare('SELECT status FROM bookings WHERE id = ?').get(booking.id) as { status: string }).status).toBe('CONFIRMED');
  });

  it('fails closed when the external calendar reports a conflict', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ blockedRanges: [{ start: '2027-06-14', end: '2027-06-21' }] }), { status: 200 })),
    );
    const context = createTestContext();
    cleanup.push(context.close);
    const { booking } = createBooking(context.db, context.config, validBooking());
    await generateAgreement(context.db, context.config, booking.id);
    await expect(
      sendAgreement(context.db, context.config, createSignatureProvider(context.config), booking.id, 'test-admin'),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/external availability calendar/),
      statusCode: 409,
      expose: true,
    });
    expect(context.db.prepare('SELECT 1 FROM date_blocks WHERE booking_id = ?').get(booking.id)).toBeUndefined();
  });

  it('allows a published direct-rate week despite Airbnb/Vrbo closures', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({
        blockedRanges: [{ start: '2027-01-01', end: '2029-01-01' }],
        bookingBlockedRanges: [],
        softBlockedRanges: [{ start: '2027-01-01', end: '2029-01-01' }],
        manualBlockedRanges: [],
      }), { status: 200 })),
    );
    const context = createTestContext();
    cleanup.push(context.close);
    const { booking } = createBooking(context.db, context.config, validBooking({
      checkIn: '2027-06-12',
      checkOut: '2027-06-19',
      rentalPriceMinor: 500000,
    }));
    await generateAgreement(context.db, context.config, booking.id);

    await expect(sendAgreement(context.db, context.config, createSignatureProvider(context.config), booking.id, 'test-admin')).resolves.toBeTruthy();
  });

  it('rejects a published direct-rate week blocked by Booking.com', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({
        blockedRanges: [{ start: '2027-07-31', end: '2027-08-14' }],
        bookingBlockedRanges: [{ start: '2027-07-31', end: '2027-08-14' }],
        softBlockedRanges: [],
        manualBlockedRanges: [],
      }), { status: 200 })),
    );
    const context = createTestContext();
    cleanup.push(context.close);
    const { booking } = createBooking(context.db, context.config, validBooking({
      checkIn: '2027-07-31',
      checkOut: '2027-08-07',
      rentalPriceMinor: 500000,
    }));
    await generateAgreement(context.db, context.config, booking.id);

    await expect(
      sendAgreement(context.db, context.config, createSignatureProvider(context.config), booking.id, 'test-admin'),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('matches Documenso v2 webhooks by envelopeId', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ blockedRanges: [] }), { status: 200 })));
    const context = createTestContext();
    cleanup.push(context.close);
    const { booking } = createBooking(context.db, context.config, validBooking());
    const agreement = await generateAgreement(context.db, context.config, booking.id);
    await sendAgreement(context.db, context.config, createSignatureProvider(context.config), booking.id, 'test-admin');
    context.db
      .prepare("UPDATE agreements SET provider = 'documenso', provider_document_id = 'envelope_test' WHERE id = ?")
      .run(agreement.id);
    const provider: SignatureProvider = {
      name: 'documenso',
      async send() {
        return { documentId: 'envelope_test' };
      },
      async resend() {},
      async cancel() {},
      async downloadCompleted() {
        return Buffer.from('signed agreement');
      },
      async downloadIfCompleted() {
        return Buffer.from('signed agreement');
      },
      verifyWebhook() {
        return true;
      },
    };
    await processDocumensoEvent(
      context.db,
      context.config,
      provider,
      createPaymentProvider(context.config),
      new EmailService(context.db, context.config),
      {
        event: 'DOCUMENT_SIGNED',
        payload: {
          id: 1,
          envelopeId: 'envelope_test',
          recipients: [
            { email: context.config.OWNER_EMAIL, signingStatus: 'SIGNED', signedAt: '2026-07-30T18:05:00.000Z' },
          ],
        },
      },
    );
    expect((context.db.prepare('SELECT status FROM bookings WHERE id = ?').get(booking.id) as { status: string }).status).toBe(
      'AWAITING_GUEST_SIGNATURE',
    );

    await processDocumensoEvent(
      context.db,
      context.config,
      provider,
      createPaymentProvider(context.config),
      new EmailService(context.db, context.config),
      {
        event: 'DOCUMENT_SIGNED',
        payload: {
          id: 1,
          envelopeId: 'envelope_test',
          status: 'COMPLETED',
          recipients: [
            { email: 'ada@example.test', signingStatus: 'SIGNED', signedAt: '2026-07-30T18:10:00.000Z' },
          ],
        },
      },
    );
    expect((context.db.prepare('SELECT status FROM bookings WHERE id = ?').get(booking.id) as { status: string }).status).toBe(
      'AWAITING_PAYMENT',
    );
    expect(
      (context.db.prepare('SELECT guest_signed_at FROM agreements WHERE id = ?').get(agreement.id) as { guest_signed_at: string })
        .guest_signed_at,
    ).toBe('2026-07-30T18:10:00.000Z');
  });
});
