import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../config.js';
import type { Database } from '../db.js';
import { safeEqual, sha256 } from '../lib/crypto.js';
import { formatDate, formatMoney, nowIso } from '../lib/format.js';
import { createEnquiry, enquirySchema } from '../services/booking.js';
import type { EmailService } from '../services/email.js';
import { balanceDueDate, markPaymentSucceeded, selectBankTransfer, selectCardPayment } from '../services/payment.js';
import type { PaymentRow } from '../types.js';
import { croEventSchema, recordCroEvent, resolveCountry } from '../services/cro.js';

interface PublicDependencies {
  db: Database;
  config: AppConfig;
  email: EmailService;
}

function publicBooking(db: Database, token: string) {
  const row = db.prepare(`
    SELECT b.*, g.legal_name, g.email
    FROM guest_access_tokens t
    JOIN bookings b ON b.id = t.booking_id
    JOIN guests g ON g.id = b.primary_guest_id
    WHERE t.token_hash = ? AND t.revoked_at IS NULL AND t.expires_at > unixepoch()
  `).get(sha256(token)) as Record<string, any> | undefined;
  if (row) {
    db.prepare('UPDATE guest_access_tokens SET last_used_at = ? WHERE token_hash = ?').run(nowIso(), sha256(token));
  }
  return row;
}

export async function registerPublicRoutes(app: FastifyInstance, deps: PublicDependencies): Promise<void> {
  const { db, config, email } = deps;

  app.post('/api/cro/events', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (request, reply) => {
    const parsed = croEventSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid event' });
    recordCroEvent(db, parsed.data, { countryCode:await resolveCountry(request.ip, request.headers) });
    return reply.code(202).send({ ok: true });
  });

  app.get('/calendar/:token/villa-tullia.ics', async (request, reply) => {
    const token = (request.params as { token: string }).token;
    if (!config.ICAL_FEED_TOKEN || !safeEqual(token, config.ICAL_FEED_TOKEN)) return reply.code(404).send('Calendar not found');
    const blocks = db.prepare(`
      SELECT id, check_in, check_out FROM date_blocks
      WHERE released_at IS NULL AND (expires_at IS NULL OR expires_at > unixepoch())
      ORDER BY check_in, check_out
    `).all() as Array<{ id: string; check_in: string; check_out: string }>;
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Villa Tullia//Availability//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
    for (const block of blocks) {
      lines.push(
        'BEGIN:VEVENT',
        `UID:${sha256(block.id).slice(0, 24)}@villatullia.it`,
        `DTSTAMP:${stamp}`,
        `DTSTART;VALUE=DATE:${block.check_in.replaceAll('-', '')}`,
        `DTEND;VALUE=DATE:${block.check_out.replaceAll('-', '')}`,
        'SUMMARY:Villa Tullia - Unavailable',
        'TRANSP:OPAQUE',
        'STATUS:CONFIRMED',
        'END:VEVENT',
      );
    }
    lines.push('END:VCALENDAR');
    return reply
      .header('Content-Type', 'text/calendar; charset=utf-8')
      .header('Content-Disposition', 'inline; filename="villa-tullia.ics"')
      .header('Cache-Control', 'no-cache, max-age=300')
      .send(`${lines.join('\r\n')}\r\n`);
  });

  app.get('/api/availability', async (_request, reply) => {
    let partnerRanges: Array<{ start: string; end: string }> = [];
    let upstreamUpdated: string | undefined;
    try {
      const response = await fetch(config.CALENDAR_AVAILABILITY_URL, { signal: AbortSignal.timeout(5000) });
      if (response.ok) {
        const payload = (await response.json()) as { blockedRanges?: Array<{ start: string; end: string }>; lastUpdated?: string };
        partnerRanges = Array.isArray(payload.blockedRanges) ? payload.blockedRanges : [];
        upstreamUpdated = payload.lastUpdated;
      }
    } catch {
      // Local and confirmed booking blocks are still authoritative if the partner feed is temporarily unavailable.
    }
    const localRanges = db.prepare(`
      SELECT check_in AS start, check_out AS end FROM date_blocks
      WHERE released_at IS NULL AND (expires_at IS NULL OR expires_at > unixepoch())
    `).all() as Array<{ start: string; end: string }>;
    const unique = new Map<string, { start: string; end: string }>();
    for (const range of [...partnerRanges, ...localRanges]) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(range.start) && /^\d{4}-\d{2}-\d{2}$/.test(range.end) && range.end > range.start) {
        unique.set(`${range.start}:${range.end}`, range);
      }
    }
    return reply.header('Cache-Control', 'no-store').send({
      lastUpdated: upstreamUpdated ?? nowIso(),
      blockedRanges: [...unique.values()].sort((a, b) => a.start.localeCompare(b.start)),
    });
  });

  app.post(
    '/api/enquiries',
    { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } },
    async (request, reply) => {
      const parsed = enquirySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Please check the enquiry details and try again.' });
      }
      if (parsed.data.website) return reply.code(202).send({ ok: true });
      const enquiry = createEnquiry(db, parsed.data, { ipHash: sha256(request.ip) });
      try {
        await email.sendEnquiryNotification(enquiry.id);
      } catch (error) {
        request.log.error({ err: error, enquiryId: enquiry.id }, 'Owner enquiry notification failed');
      }
      return reply.code(201).send({ ok: true, reference: enquiry.reference });
    },
  );

  app.get('/booking/:token', { config: { rateLimit: { max: 60, timeWindow: '15 minutes' } } }, async (request, reply) => {
    const token = (request.params as { token: string }).token;
    const booking = publicBooking(db, token);
    if (!booking) return reply.code(404).view('guest-error.njk', { title: 'Secure link unavailable' });
    const agreement = db.prepare(`
      SELECT version, status, completed_at, signed_pdf_path FROM agreements
      WHERE booking_id = ? AND status <> 'INVALIDATED' ORDER BY version DESC LIMIT 1
    `).get(booking.id) as Record<string, any> | undefined;
    const payments = db.prepare(`SELECT * FROM payments WHERE booking_id = ? ORDER BY created_at`).all(booking.id) as unknown as PaymentRow[];
    const payment = [...payments].reverse().find((item) => ['PENDING', 'FAILED', 'PROCESSING'].includes(item.status));
    const balancePayment = payments.find((item) => item.purpose === 'BALANCE');
    return reply.view('guest.njk', {
      title: `Booking ${booking.reference}`,
      booking: {
        reference: booking.reference,
        status: booking.status,
        guestName: booking.legal_name,
        checkIn: formatDate(booking.check_in),
        checkOut: formatDate(booking.check_out),
        amount: formatMoney(booking.amount_due_minor, booking.currency),
        paymentDeadline: formatDate(booking.payment_deadline),
        remainingBalance: formatMoney(booking.remaining_balance_minor, booking.currency),
        hasBalance: booking.remaining_balance_minor > 0,
        balanceDue: formatDate(balanceDueDate(booking.check_in)),
        balancePaid: balancePayment?.status === 'SUCCEEDED',
      },
      agreement,
      payment: payment
        ? { ...payment, amountFormatted: formatMoney(payment.amount_minor, payment.currency), label: payment.purpose === 'BALANCE' ? 'remaining balance' : 'initial payment' }
        : undefined,
      bankTransfer: config.BANK_TRANSFER_ENABLED && config.BANK_ACCOUNT_HOLDER && config.BANK_IBAN
        ? {
            accountHolder: config.BANK_ACCOUNT_HOLDER,
            bankName: config.BANK_NAME,
            iban: config.BANK_IBAN,
            bic: config.BANK_BIC,
            reference: booking.reference,
          }
        : undefined,
      token,
    });
  });

  app.post('/booking/:token/payment/:paymentId/card', async (request, reply) => {
    const { token, paymentId } = request.params as { token: string; paymentId: string };
    const booking = publicBooking(db, token);
    if (!booking) return reply.code(404).view('guest-error.njk', { title: 'Secure link unavailable' });
    const payment = db.prepare('SELECT * FROM payments WHERE id = ? AND booking_id = ?').get(paymentId, booking.id) as PaymentRow | undefined;
    if (!payment?.checkout_url) return reply.code(404).view('guest-error.njk', { title: 'Card payment unavailable' });
    selectCardPayment(db, payment);
    return reply.redirect(payment.checkout_url);
  });

  app.post('/booking/:token/payment/:paymentId/bank-transfer', async (request, reply) => {
    const { token, paymentId } = request.params as { token: string; paymentId: string };
    const booking = publicBooking(db, token);
    if (!booking) return reply.code(404).view('guest-error.njk', { title: 'Secure link unavailable' });
    if (!config.BANK_TRANSFER_ENABLED || !config.BANK_ACCOUNT_HOLDER || !config.BANK_IBAN) {
      return reply.code(404).view('guest-error.njk', { title: 'Bank transfer unavailable' });
    }
    const payment = db.prepare('SELECT * FROM payments WHERE id = ? AND booking_id = ?').get(paymentId, booking.id) as PaymentRow | undefined;
    if (!payment) return reply.code(404).view('guest-error.njk', { title: 'Payment unavailable' });
    selectBankTransfer(db, payment);
    return reply.redirect(`/booking/${encodeURIComponent(token)}`);
  });

  app.get('/booking/:token/agreement', async (request, reply) => {
    const token = (request.params as { token: string }).token;
    const booking = publicBooking(db, token);
    if (!booking) return reply.code(404).send('Secure link unavailable');
    const agreement = db.prepare(`
      SELECT version, signed_pdf_path FROM agreements WHERE booking_id = ? AND status = 'COMPLETED'
      ORDER BY version DESC LIMIT 1
    `).get(booking.id) as { version: number; signed_pdf_path: string | null } | undefined;
    if (!agreement?.signed_pdf_path || !fs.existsSync(agreement.signed_pdf_path)) return reply.code(404).send('Signed agreement not available');
    return reply
      .header('Content-Disposition', `attachment; filename="${booking.reference}-signed-agreement-v${agreement.version}.pdf"`)
      .type('application/pdf')
      .send(fs.createReadStream(agreement.signed_pdf_path));
  });

  app.get('/mock-pay/:sessionId', async (request, reply) => {
    if (config.PAYMENT_PROVIDER !== 'mock') return reply.code(404).send('Not found');
    const sessionId = (request.params as { sessionId: string }).sessionId;
    const payment = db.prepare(`
      SELECT p.*, b.reference, g.legal_name FROM payments p
      JOIN bookings b ON b.id = p.booking_id JOIN guests g ON g.id = b.primary_guest_id
      WHERE p.checkout_session_id = ? AND p.provider = 'mock'
    `).get(sessionId) as Record<string, any> | undefined;
    if (!payment) return reply.code(404).view('guest-error.njk', { title: 'Payment link unavailable' });
    return reply.view('mock-payment.njk', {
      title: 'Test payment',
      payment: { ...payment, amountFormatted: formatMoney(payment.amount_minor, payment.currency) },
    });
  });

  app.post('/mock-pay/:sessionId', async (request, reply) => {
    if (config.PAYMENT_PROVIDER !== 'mock') return reply.code(404).send('Not found');
    const sessionId = (request.params as { sessionId: string }).sessionId;
    const payment = db.prepare(`SELECT * FROM payments WHERE checkout_session_id = ? AND provider = 'mock'`).get(sessionId) as
      | PaymentRow
      | undefined;
    if (!payment) return reply.code(404).send('Payment link unavailable');
    const changed = markPaymentSucceeded(db, payment, { paymentIntentId: `mockpi_${sessionId.slice(-18)}` });
    if (changed) await email.sendConfirmation(payment.booking_id, payment.id);
    return reply.view('payment-return.njk', { title: 'Payment recorded', confirmed: true });
  });

  app.get('/payment/return', async (request, reply) => {
    const query = request.query as { cancelled?: string };
    return reply.view('payment-return.njk', { title: 'Payment status', cancelled: Boolean(query.cancelled) });
  });
}
