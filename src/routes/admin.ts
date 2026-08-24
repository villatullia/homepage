import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.js';
import type { Database } from '../db.js';
import { createSession, releaseDateBlock, transitionBooking, withImmediateTransaction } from '../db.js';
import {
  adminCookieName,
  adminFromRequest,
  clearAdminCookie,
  getAdmin,
  requireAdmin,
  requireCsrf,
  setAdminCookie,
} from '../auth.js';
import { sha256, verifyPassword } from '../lib/crypto.js';
import { formatMoney, nowIso, parseMoneyToMinor } from '../lib/format.js';
import { bookingStatuses } from '../domain/status.js';
import type { AgreementRow, BookingRow, PaymentRow } from '../types.js';
import { bookingViewModel } from '../view-models.js';
import { createBooking, updateDraftBooking, type BookingInput } from '../services/booking.js';
import { generateAgreement } from '../services/agreement.js';
import type { SignatureProvider } from '../services/signature.js';
import type { PaymentProvider } from '../services/payment.js';
import { confirmBankTransfer, createPaymentRequest } from '../services/payment.js';
import type { EmailService } from '../services/email.js';
import {
  cancelBookingWorkflow,
  mockGuestSigned,
  mockOwnerSigned,
  resendAgreement,
  sendAgreement,
} from '../services/workflow.js';
import { BOOKING_COM_COMMISSION_BASIS_POINTS, directPerformance } from '../services/analytics.js';
import { croDashboard } from '../services/cro.js';
import { randomUUID } from 'node:crypto';

interface AdminRouteDependencies {
  db: Database;
  config: AppConfig;
  signatureProvider: SignatureProvider;
  paymentProvider: PaymentProvider;
  email: EmailService;
}

function bodyRecord(request: FastifyRequest): Record<string, unknown> {
  return (request.body ?? {}) as Record<string, unknown>;
}

function parseBookingBody(body: Record<string, unknown>, config: AppConfig): BookingInput {
  const additionalGuests = String(body.additionalGuests ?? '')
    .split(/\r?\n/)
    .map((name) => name.trim())
    .filter(Boolean);
  return {
    legalName: String(body.legalName ?? ''),
    email: String(body.email ?? ''),
    phone: String(body.phone ?? ''),
    addressLine1: String(body.addressLine1 ?? ''),
    addressLine2: String(body.addressLine2 ?? ''),
    postalCode: String(body.postalCode ?? ''),
    city: String(body.city ?? ''),
    region: String(body.region ?? ''),
    country: String(body.country ?? ''),
    guestsCount: Number(body.guestsCount),
    additionalGuests,
    checkIn: String(body.checkIn ?? ''),
    checkOut: String(body.checkOut ?? ''),
    rentalPriceMinor: parseMoneyToMinor(body.rentalPrice),
    amountDueMinor: parseMoneyToMinor(body.amountDue),
    remainingBalanceMinor: parseMoneyToMinor(body.remainingBalance),
    securityDepositMinor: parseMoneyToMinor(body.securityDeposit),
    touristTaxMinor: parseMoneyToMinor(body.touristTax),
    currency: String(body.currency ?? config.DEFAULT_CURRENCY),
    paymentDeadline: String(body.paymentDeadline ?? ''),
    cancellationTerms: String(body.cancellationTerms ?? ''),
    specialConditions: String(body.specialConditions ?? ''),
  };
}

function bookingFormValues(booking?: ReturnType<typeof bookingViewModel>, enquiry?: Record<string, unknown>) {
  return {
    legalName: booking?.guest.legal_name ?? enquiry?.full_name ?? '',
    email: booking?.guest.email ?? enquiry?.email ?? '',
    phone: booking?.guest.phone ?? enquiry?.phone ?? '',
    addressLine1: booking?.guest.address_line1 ?? '',
    addressLine2: booking?.guest.address_line2 ?? '',
    postalCode: booking?.guest.postal_code ?? '',
    city: booking?.guest.city ?? '',
    region: booking?.guest.region ?? '',
    country: booking?.guest.country ?? 'Italy',
    guestsCount: booking?.guests_count ?? enquiry?.guests_count ?? 1,
    additionalGuests: booking?.additionalGuests.map((member: any) => member.full_name).join('\n') ?? '',
    checkIn: booking?.check_in ?? enquiry?.requested_check_in ?? '',
    checkOut: booking?.check_out ?? enquiry?.requested_check_out ?? '',
    rentalPrice: booking ? (booking.rental_price_minor / 100).toFixed(2) : '0.00',
    amountDue: booking ? (booking.amount_due_minor / 100).toFixed(2) : '0.00',
    remainingBalance: booking ? (booking.remaining_balance_minor / 100).toFixed(2) : '0.00',
    securityDeposit: booking ? (booking.security_deposit_minor / 100).toFixed(2) : '0.00',
    touristTax: booking ? (booking.tourist_tax_minor / 100).toFixed(2) : '0.00',
    currency: booking?.currency ?? 'EUR',
    paymentDeadline: booking?.payment_deadline ?? enquiry?.requested_check_in ?? '',
    cancellationTerms: booking?.cancellation_terms ?? 'Cancellation terms to be agreed before the agreement is sent.',
    specialConditions: booking?.special_conditions ?? '',
  };
}

export async function registerAdminRoutes(app: FastifyInstance, deps: AdminRouteDependencies): Promise<void> {
  const { db, config, signatureProvider, paymentProvider, email } = deps;
  const auth = requireAdmin(db);
  const csrf = requireCsrf();

  app.get('/admin/login', async (request, reply) => {
    if (getAdmin(request, db)) return reply.redirect('/admin');
    const count = db.prepare('SELECT COUNT(*) AS count FROM administrators WHERE active = 1').get() as { count: number };
    return reply.view('login.njk', {
      title: 'Administrator sign in',
      returnTo: (request.query as { returnTo?: string }).returnTo ?? '/admin',
      noAdministrator: count.count === 0,
      error: (request.query as { error?: string }).error,
    });
  });

  app.post(
    '/admin/login',
    { config: { rateLimit: { max: 8, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const body = bodyRecord(request);
      const emailAddress = String(body.email ?? '').trim().toLowerCase();
      const password = String(body.password ?? '');
      const administrator = db.prepare(`
        SELECT id, email, display_name, password_hash FROM administrators WHERE email = ? AND active = 1
      `).get(emailAddress) as { id: string; email: string; display_name: string; password_hash: string } | undefined;
      if (!administrator || !(await verifyPassword(password, administrator.password_hash))) {
        return reply.redirect(`/admin/login?error=${encodeURIComponent('Email or password is incorrect')}`);
      }
      const session = createSession(db, administrator, {
        ipHash: sha256(request.ip),
        userAgent: request.headers['user-agent'],
      });
      db.prepare('UPDATE administrators SET last_login_at = ?, updated_at = ? WHERE id = ?').run(nowIso(), nowIso(), administrator.id);
      setAdminCookie(reply, config, session.token, session.expiresAt);
      const requested = String(body.returnTo ?? '/admin');
      return reply.redirect(requested.startsWith('/admin') ? requested : '/admin');
    },
  );

  app.post('/admin/logout', { preHandler: [auth, csrf] }, async (request, reply) => {
    const token = request.cookies[adminCookieName];
    if (token) db.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').run(sha256(token));
    clearAdminCookie(reply, config);
    return reply.redirect('/admin/login');
  });

  app.get('/admin', { preHandler: auth }, async (request, reply) => {
    const admin = adminFromRequest(request);
    const query = request.query as {
      bookingStatus?: string;
      enquiryStatus?: string;
      calendarMessage?: string;
      calendarError?: string;
    };
    const enquiryStatus = query.enquiryStatus && query.enquiryStatus !== 'ALL' ? query.enquiryStatus : undefined;
    const bookingStatus = query.bookingStatus && query.bookingStatus !== 'ALL' ? query.bookingStatus : undefined;
    const enquiries = enquiryStatus
      ? db.prepare('SELECT * FROM enquiries WHERE status = ? ORDER BY created_at DESC').all(enquiryStatus)
      : db.prepare('SELECT * FROM enquiries ORDER BY created_at DESC LIMIT 100').all();
    const bookings = bookingStatus
      ? db.prepare(`
          SELECT b.*, g.legal_name AS guest_name FROM bookings b JOIN guests g ON g.id = b.primary_guest_id
          WHERE b.status = ? ORDER BY b.created_at DESC
        `).all(bookingStatus)
      : db.prepare(`
          SELECT b.*, g.legal_name AS guest_name FROM bookings b JOIN guests g ON g.id = b.primary_guest_id
          ORDER BY b.created_at DESC LIMIT 100
        `).all();
    const performance = directPerformance(db);
    const closedWeeks = db.prepare(`
      SELECT id, check_in, check_out, note, created_at
      FROM manual_week_blocks
      WHERE released_at IS NULL
      ORDER BY check_in
    `).all();
    const directPerformanceView = {
      ...performance,
      benchmarkPercent: BOOKING_COM_COMMISSION_BASIS_POINTS / 100,
      confirmedRevenueFormatted: formatMoney(performance.confirmedRevenueMinor, config.DEFAULT_CURRENCY),
      estimatedCommissionAvoidedFormatted: formatMoney(performance.estimatedCommissionAvoidedMinor, config.DEFAULT_CURRENCY),
      seasons: performance.seasons.map((season) => ({
        ...season,
        revenueFormatted: formatMoney(season.revenueMinor, config.DEFAULT_CURRENCY),
        estimatedCommissionAvoidedFormatted: formatMoney(season.estimatedCommissionAvoidedMinor, config.DEFAULT_CURRENCY),
      })),
    };
    return reply.view('dashboard.njk', {
      title: 'Booking dashboard',
      admin,
      csrf: admin.csrf_token,
      enquiries,
      bookings,
      bookingStatuses,
      enquiryStatuses: ['ENQUIRY_NEW', 'ENQUIRY_APPROVED', 'CONVERTED', 'DECLINED', 'SPAM'],
      enquiryStatus: enquiryStatus ?? 'ALL',
      bookingStatus: bookingStatus ?? 'ALL',
      calendarMessage: query.calendarMessage,
      calendarError: query.calendarError,
      signingProvider: signatureProvider.name,
      paymentProvider: paymentProvider.name,
      directPerformance: directPerformanceView,
      closedWeeks,
      icalFeedUrl: config.ICAL_FEED_TOKEN
        ? `${config.APP_BASE_URL}/calendar/${encodeURIComponent(config.ICAL_FEED_TOKEN)}/villa-tullia.ics`
        : '',
    });
  });

  app.post('/admin/calendar/close-week', { preHandler: [auth, csrf] }, async (request, reply) => {
    const admin = adminFromRequest(request);
    const body = bodyRecord(request);
    const checkIn = String(body.checkIn ?? '');
    const note = String(body.note ?? '').trim().slice(0, 200);
    const parsed = /^\d{4}-\d{2}-\d{2}$/.test(checkIn) ? new Date(`${checkIn}T00:00:00Z`) : new Date(Number.NaN);
    if (Number.isNaN(parsed.getTime()) || parsed.getUTCDay() !== 6) {
      return reply.redirect(`/admin?calendarError=${encodeURIComponent('Choose a Saturday as the start of the week.')}`);
    }
    const checkoutDate = new Date(parsed);
    checkoutDate.setUTCDate(checkoutDate.getUTCDate() + 7);
    const checkOut = checkoutDate.toISOString().slice(0, 10);
    const overlap = db.prepare(`
      SELECT 1 FROM date_blocks
      WHERE released_at IS NULL AND (expires_at IS NULL OR expires_at > unixepoch())
        AND ? < check_out AND ? > check_in
      UNION ALL
      SELECT 1 FROM manual_week_blocks
      WHERE released_at IS NULL AND ? < check_out AND ? > check_in
      LIMIT 1
    `).get(checkIn, checkOut, checkIn, checkOut);
    if (overlap) return reply.redirect(`/admin?calendarError=${encodeURIComponent('That week is already unavailable.')}`);
    const timestamp = nowIso();
    db.prepare(`
      INSERT INTO manual_week_blocks
        (id, property_id, check_in, check_out, note, created_by, created_at, updated_at)
      VALUES (?, 'villa-tullia', ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), checkIn, checkOut, note || null, admin.id, timestamp, timestamp);
    return reply.redirect(`/admin?calendarMessage=${encodeURIComponent(`Week ${checkIn} to ${checkOut} closed`)}`);
  });

  app.post('/admin/calendar/closed-weeks/:id/reopen', { preHandler: [auth, csrf] }, async (request, reply) => {
    const admin = adminFromRequest(request);
    const id = (request.params as { id: string }).id;
    const timestamp = nowIso();
    const result = db.prepare(`
      UPDATE manual_week_blocks SET released_at = ?, released_by = ?, updated_at = ?
      WHERE id = ? AND released_at IS NULL
    `).run(timestamp, admin.id, timestamp, id);
    const message = result.changes === 1 ? 'Week reopened' : 'Week was already open';
    return reply.redirect(`/admin?calendarMessage=${encodeURIComponent(message)}`);
  });

  app.get('/admin/enquiries/:id', { preHandler: auth }, async (request, reply) => {
    const admin = adminFromRequest(request);
    const id = (request.params as { id: string }).id;
    const enquiry = db.prepare('SELECT * FROM enquiries WHERE id = ?').get(id);
    if (!enquiry) return reply.code(404).view('error.njk', { title: 'Not found', message: 'Enquiry not found.' });
    return reply.view('enquiry.njk', { title: 'Enquiry', admin, csrf: admin.csrf_token, enquiry });
  });

  app.post('/admin/enquiries/:id/approve', { preHandler: [auth, csrf] }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    db.prepare("UPDATE enquiries SET status = 'ENQUIRY_APPROVED', updated_at = ? WHERE id = ? AND status = 'ENQUIRY_NEW'").run(
      nowIso(),
      id,
    );
    return reply.redirect(`/admin/enquiries/${encodeURIComponent(id)}/create-booking`);
  });

  app.get('/admin/enquiries/:id/create-booking', { preHandler: auth }, async (request, reply) => {
    const admin = adminFromRequest(request);
    const id = (request.params as { id: string }).id;
    const enquiry = db.prepare('SELECT * FROM enquiries WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!enquiry) return reply.code(404).view('error.njk', { title: 'Not found', message: 'Enquiry not found.' });
    return reply.view('booking-form.njk', {
      title: 'Create booking',
      admin,
      csrf: admin.csrf_token,
      action: `/admin/enquiries/${encodeURIComponent(id)}/create-booking`,
      values: bookingFormValues(undefined, enquiry),
      enquiry,
      isEdit: false,
    });
  });

  app.post('/admin/enquiries/:id/create-booking', { preHandler: [auth, csrf] }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const result = createBooking(db, config, parseBookingBody(bodyRecord(request), config), id);
    return reply.redirect(`/admin/bookings/${encodeURIComponent(result.booking.id)}?created=1`);
  });

  app.get('/admin/bookings/new', { preHandler: auth }, async (request, reply) => {
    const admin = adminFromRequest(request);
    return reply.view('booking-form.njk', {
      title: 'Create booking',
      admin,
      csrf: admin.csrf_token,
      action: '/admin/bookings/new',
      values: bookingFormValues(),
      isEdit: false,
    });
  });

  app.post('/admin/bookings/new', { preHandler: [auth, csrf] }, async (request, reply) => {
    const result = createBooking(db, config, parseBookingBody(bodyRecord(request), config));
    return reply.redirect(`/admin/bookings/${encodeURIComponent(result.booking.id)}?created=1`);
  });

  app.get('/admin/bookings/:id', { preHandler: auth }, async (request, reply) => {
    const admin = adminFromRequest(request);
    const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get((request.params as { id: string }).id) as BookingRow | undefined;
    if (!booking) return reply.code(404).view('error.njk', { title: 'Not found', message: 'Booking not found.' });
    return reply.view('booking.njk', {
      title: booking.reference,
      admin,
      csrf: admin.csrf_token,
      booking: bookingViewModel(db, config, booking),
      signingProvider: signatureProvider.name,
      paymentProvider: paymentProvider.name,
      message: (request.query as { message?: string }).message,
      created: (request.query as { created?: string }).created,
    });
  });

  app.get('/admin/bookings/:id/edit', { preHandler: auth }, async (request, reply) => {
    const admin = adminFromRequest(request);
    const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get((request.params as { id: string }).id) as BookingRow | undefined;
    if (!booking) return reply.code(404).view('error.njk', { title: 'Not found', message: 'Booking not found.' });
    const model = bookingViewModel(db, config, booking);
    return reply.view('booking-form.njk', {
      title: `Edit ${booking.reference}`,
      admin,
      csrf: admin.csrf_token,
      action: `/admin/bookings/${encodeURIComponent(booking.id)}/edit`,
      values: bookingFormValues(model),
      booking,
      isEdit: true,
    });
  });

  app.post('/admin/bookings/:id/edit', { preHandler: [auth, csrf] }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    updateDraftBooking(db, id, parseBookingBody(bodyRecord(request), config));
    return reply.redirect(`/admin/bookings/${encodeURIComponent(id)}?message=${encodeURIComponent('Booking updated')}`);
  });

  app.post('/admin/bookings/:id/agreement/generate', { preHandler: [auth, csrf] }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    await generateAgreement(db, config, id);
    return reply.redirect(`/admin/bookings/${encodeURIComponent(id)}?message=${encodeURIComponent('Agreement generated')}`);
  });

  app.get('/admin/bookings/:id/agreement/preview', { preHandler: auth }, async (request, reply) => {
    const agreement = db.prepare(`
      SELECT * FROM agreements WHERE booking_id = ? AND status <> 'INVALIDATED' ORDER BY version DESC LIMIT 1
    `).get((request.params as { id: string }).id) as AgreementRow | undefined;
    if (!agreement) return reply.code(404).view('error.njk', { title: 'Not found', message: 'Agreement not found.' });
    return reply.type('text/html; charset=utf-8').send(agreement.rendered_html);
  });

  app.get('/admin/bookings/:id/agreement/download', { preHandler: auth }, async (request, reply) => {
    const agreement = db.prepare(`
      SELECT * FROM agreements WHERE booking_id = ? AND status <> 'INVALIDATED' ORDER BY version DESC LIMIT 1
    `).get((request.params as { id: string }).id) as AgreementRow | undefined;
    if (!agreement) return reply.code(404).send('Agreement not found');
    const file = agreement.signed_pdf_path ?? agreement.unsigned_pdf_path;
    return reply
      .header('Content-Disposition', `attachment; filename="agreement-v${agreement.version}.pdf"`)
      .type('application/pdf')
      .send(await import('node:fs').then((module) => module.createReadStream(file)));
  });

  app.post('/admin/bookings/:id/agreement/send', { preHandler: [auth, csrf] }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    await sendAgreement(db, config, signatureProvider, id, adminFromRequest(request).id);
    return reply.redirect(`/admin/bookings/${encodeURIComponent(id)}?message=${encodeURIComponent('Agreement sent to the owner')}`);
  });

  app.post('/admin/bookings/:id/agreement/resend', { preHandler: [auth, csrf] }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const result = await resendAgreement(db, config, signatureProvider, paymentProvider, email, id);
    const message = result === 'synchronized' ? 'Completed signatures synchronized' : 'Signing invitation resent';
    return reply.redirect(`/admin/bookings/${encodeURIComponent(id)}?message=${encodeURIComponent(message)}`);
  });

  app.post('/admin/bookings/:id/mock-owner-sign', { preHandler: [auth, csrf] }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    if (signatureProvider.name !== 'mock') throw new Error('Mock actions are disabled');
    mockOwnerSigned(db, config, id);
    const booking = db.prepare('SELECT primary_guest_id FROM bookings WHERE id = ?').get(id) as { primary_guest_id: string };
    const guest = db.prepare('SELECT email FROM guests WHERE id = ?').get(booking.primary_guest_id) as { email: string };
    await email.send('guest-signature-request', id, guest.email, `guest-signature-request:${id}`);
    return reply.redirect(`/admin/bookings/${encodeURIComponent(id)}?message=${encodeURIComponent('Mock owner signature recorded')}`);
  });

  app.post('/admin/bookings/:id/mock-guest-sign', { preHandler: [auth, csrf] }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    if (signatureProvider.name !== 'mock') throw new Error('Mock actions are disabled');
    await mockGuestSigned(db, config, paymentProvider, email, id);
    return reply.redirect(`/admin/bookings/${encodeURIComponent(id)}?message=${encodeURIComponent('Mock guest signature recorded and payment requested')}`);
  });

  app.post('/admin/bookings/:id/payment/request', { preHandler: [auth, csrf] }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const purpose = bodyRecord(request).purpose === 'BALANCE' ? 'BALANCE' : 'INITIAL';
    const agreement = db.prepare(`
      SELECT * FROM agreements WHERE booking_id = ? AND status = 'COMPLETED' ORDER BY version DESC LIMIT 1
    `).get(id) as AgreementRow | undefined;
    if (!agreement) throw new Error('No completed agreement');
    const payment = await createPaymentRequest(db, paymentProvider, id, agreement.id, purpose);
    await email.sendPaymentRequest(id, payment);
    return reply.redirect(`/admin/bookings/${encodeURIComponent(id)}?message=${encodeURIComponent('Payment request ready')}`);
  });

  app.get('/admin/cro', { preHandler: auth }, async (request, reply) => {
    const admin = adminFromRequest(request);
    return reply.view('cro-dashboard.njk', { title:'CRO dashboard', admin, csrf:admin.csrf_token, cro:croDashboard(db, 'villa-tullia') });
  });

  app.post('/admin/bookings/:id/payment/:paymentId/confirm-bank-transfer', { preHandler: [auth, csrf] }, async (request, reply) => {
    const { id, paymentId } = request.params as { id: string; paymentId: string };
    const payment = db.prepare('SELECT * FROM payments WHERE id = ? AND booking_id = ?').get(paymentId, id) as PaymentRow | undefined;
    if (!payment) throw new Error('Payment not found');
    if (confirmBankTransfer(db, payment, adminFromRequest(request).id)) await email.sendConfirmation(id, payment.id);
    return reply.redirect(`/admin/bookings/${encodeURIComponent(id)}?message=${encodeURIComponent('Bank transfer confirmed')}`);
  });

  app.post('/admin/bookings/:id/cancel', { preHandler: [auth, csrf] }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const reason = String(bodyRecord(request).reason ?? '').trim();
    if (reason.length < 3) throw new Error('Please provide a cancellation reason');
    await cancelBookingWorkflow(db, config, signatureProvider, email, id, adminFromRequest(request).id, reason);
    return reply.redirect(`/admin/bookings/${encodeURIComponent(id)}?message=${encodeURIComponent('Booking cancelled')}`);
  });

}
