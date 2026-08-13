import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../config.js';
import type { Database } from '../db.js';
import {
  acquireDateHold,
  releaseDateBlock,
  transitionBooking,
  withImmediateTransaction,
} from '../db.js';
import { nowIso } from '../lib/format.js';
import { sha256 } from '../lib/crypto.js';
import type { AgreementRow, BookingRow, GuestRow } from '../types.js';
import type { SignatureProvider } from './signature.js';
import type { PaymentProvider } from './payment.js';
import { createPaymentRequest } from './payment.js';
import type { EmailService } from './email.js';

function availabilityError(message: string, statusCode: 409 | 503): Error & { statusCode: number; expose: boolean } {
  return Object.assign(new Error(message), { statusCode, expose: true });
}

async function assertPartnerAvailability(config: AppConfig, booking: BookingRow): Promise<void> {
  let response: Response;
  try {
    response = await fetch(config.CALENDAR_AVAILABILITY_URL, { signal: AbortSignal.timeout(5000) });
  } catch {
    throw availabilityError('The external availability calendar could not be verified. Try again before sending the agreement.', 503);
  }
  if (!response.ok) {
    throw availabilityError('The external availability calendar could not be verified. Try again before sending the agreement.', 503);
  }
  const payload = (await response.json()) as { blockedRanges?: Array<{ start?: string; end?: string }> };
  const conflict = (payload.blockedRanges ?? []).some(
    (range) =>
      typeof range.start === 'string' &&
      typeof range.end === 'string' &&
      booking.check_in < range.end &&
      booking.check_out > range.start,
  );
  if (conflict) throw availabilityError('These dates are blocked by the external availability calendar.', 409);
}

export async function sendAgreement(
  db: Database,
  config: AppConfig,
  provider: SignatureProvider,
  bookingId: string,
  adminId: string,
): Promise<AgreementRow> {
  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId) as BookingRow | undefined;
  const agreement = db.prepare(`
    SELECT * FROM agreements WHERE booking_id = ? AND status = 'DRAFT' ORDER BY version DESC LIMIT 1
  `).get(bookingId) as AgreementRow | undefined;
  if (!booking || !agreement) throw new Error('Generate an agreement before sending it');
  if (booking.status !== 'AGREEMENT_DRAFT') throw new Error('Agreement cannot be sent from the current booking status');
  const guest = db.prepare('SELECT * FROM guests WHERE id = ?').get(booking.primary_guest_id) as unknown as GuestRow;

  await assertPartnerAvailability(config, booking);

  withImmediateTransaction(db, () => acquireDateHold(db, booking, config.SIGNING_HOLD_HOURS));
  let result: { documentId: string };
  try {
    result = await provider.send({ agreement, booking, guest });
  } catch (error) {
    withImmediateTransaction(db, () => releaseDateBlock(db, bookingId, 'signature_send_failed'));
    throw error;
  }

  withImmediateTransaction(db, () => {
    const timestamp = nowIso();
    db.prepare(`
      UPDATE agreements SET status = 'SENT', provider = ?, provider_document_id = ?, updated_at = ?
      WHERE id = ? AND status = 'DRAFT'
    `).run(provider.name, result.documentId, timestamp, agreement.id);
    transitionBooking(db, bookingId, 'AWAITING_OWNER_SIGNATURE', { type: 'ADMIN', id: adminId }, 'AGREEMENT_SENT', {
      agreementId: agreement.id,
      version: agreement.version,
      provider: provider.name,
      providerDocumentId: result.documentId,
    });
  });
  return db.prepare('SELECT * FROM agreements WHERE id = ?').get(agreement.id) as unknown as AgreementRow;
}

export async function resendAgreement(db: Database, provider: SignatureProvider, bookingId: string): Promise<void> {
  const agreement = db.prepare(`
    SELECT * FROM agreements WHERE booking_id = ? AND status IN ('SENT','OWNER_SIGNED') ORDER BY version DESC LIMIT 1
  `).get(bookingId) as AgreementRow | undefined;
  if (!agreement?.provider_document_id) throw new Error('No active signature request');
  await provider.resend(agreement.provider_document_id);
  db.prepare(`
    INSERT INTO booking_events (id, booking_id, actor_type, event_type, details_json, created_at)
    VALUES (?, ?, 'ADMIN', 'SIGNING_INVITATION_RESENT', ?, ?)
  `).run(randomUUID(), bookingId, JSON.stringify({ agreementId: agreement.id }), nowIso());
}

function applySignerTimestamps(
  db: Database,
  config: AppConfig,
  agreement: AgreementRow,
  recipients: Array<{ email?: string; signedAt?: string | null; signingStatus?: string }>,
): void {
  const guest = db.prepare(`
    SELECT g.email FROM guests g JOIN bookings b ON b.primary_guest_id = g.id WHERE b.id = ?
  `).get(agreement.booking_id) as { email: string };
  const ownerRecipient = recipients.find(
    (recipient) => recipient.email?.toLowerCase() === config.OWNER_EMAIL.toLowerCase() && recipient.signingStatus === 'SIGNED',
  );
  const guestRecipient = recipients.find(
    (recipient) => recipient.email?.toLowerCase() === guest.email.toLowerCase() && recipient.signingStatus === 'SIGNED',
  );
  db.prepare(`
    UPDATE agreements SET owner_signed_at = COALESCE(owner_signed_at, ?), guest_signed_at = COALESCE(guest_signed_at, ?), updated_at = ?
    WHERE id = ?
  `).run(ownerRecipient?.signedAt ?? null, guestRecipient?.signedAt ?? null, nowIso(), agreement.id);
}

async function finalizeAgreement(
  db: Database,
  config: AppConfig,
  agreement: AgreementRow,
  signedPdf: Buffer,
  paymentProvider: PaymentProvider,
  email: EmailService,
  actorType: 'SIGNATURE_PROVIDER' | 'ADMIN',
): Promise<void> {
  const target = path.join(
    config.storagePath,
    'agreements',
    (db.prepare('SELECT reference FROM bookings WHERE id = ?').get(agreement.booking_id) as { reference: string }).reference,
    `agreement-v${agreement.version}-signed.pdf`,
  );
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (!fs.existsSync(target)) fs.writeFileSync(target, signedPdf, { flag: 'wx' });
  else if (sha256(fs.readFileSync(target)) !== sha256(signedPdf)) throw new Error('Stored signed agreement differs from the provider copy');
  const documentHash = sha256(fs.readFileSync(target));
  const timestamp = nowIso();
  withImmediateTransaction(db, () => {
    const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(agreement.booking_id) as unknown as BookingRow;
    const currentAgreement = db.prepare('SELECT * FROM agreements WHERE id = ?').get(agreement.id) as unknown as AgreementRow;
    if (currentAgreement.status === 'COMPLETED') return;
    const ownerSignedAt = currentAgreement.owner_signed_at ?? timestamp;
    const guestSignedAt = currentAgreement.guest_signed_at ?? timestamp;
    if (booking.status === 'AWAITING_OWNER_SIGNATURE') {
      transitionBooking(db, booking.id, 'AWAITING_GUEST_SIGNATURE', { type: actorType }, 'OWNER_SIGNED');
    }
    const afterOwner = db.prepare('SELECT * FROM bookings WHERE id = ?').get(booking.id) as unknown as BookingRow;
    if (afterOwner.status === 'AWAITING_GUEST_SIGNATURE') {
      transitionBooking(db, booking.id, 'AGREEMENT_SIGNED', { type: actorType }, 'GUEST_SIGNED');
    }
    db.prepare(`
      UPDATE agreements SET status = 'COMPLETED', signed_pdf_path = ?, signed_document_hash = ?,
        owner_signed_at = ?, guest_signed_at = ?, completed_at = ?, updated_at = ? WHERE id = ?
    `).run(target, documentHash, ownerSignedAt, guestSignedAt, timestamp, timestamp, agreement.id);
    db.prepare(`
      INSERT INTO booking_events (id, booking_id, actor_type, event_type, details_json, created_at)
      VALUES (?, ?, ?, 'AGREEMENT_COMPLETED', ?, ?)
    `).run(
      randomUUID(),
      booking.id,
      actorType,
      JSON.stringify({ agreementId: agreement.id, version: agreement.version, signedDocumentHash: documentHash }),
      timestamp,
    );
  });
  const payment = await createPaymentRequest(db, paymentProvider, agreement.booking_id, agreement.id);
  // The signature provider already communicates completion. Send one actionable
  // message to the guest instead of separate completion and payment emails.
  await email.sendPaymentRequest(agreement.booking_id, payment);
}

export function mockOwnerSigned(db: Database, config: AppConfig, bookingId: string): void {
  const agreement = db.prepare(`
    SELECT * FROM agreements WHERE booking_id = ? AND status = 'SENT' ORDER BY version DESC LIMIT 1
  `).get(bookingId) as AgreementRow | undefined;
  if (!agreement || agreement.provider !== 'mock') throw new Error('No mock agreement awaiting owner signature');
  withImmediateTransaction(db, () => {
    const timestamp = nowIso();
    db.prepare("UPDATE agreements SET status = 'OWNER_SIGNED', owner_signed_at = ?, updated_at = ? WHERE id = ?").run(
      timestamp,
      timestamp,
      agreement.id,
    );
    transitionBooking(db, bookingId, 'AWAITING_GUEST_SIGNATURE', { type: 'ADMIN' }, 'OWNER_SIGNED');
  });
}

export async function mockGuestSigned(
  db: Database,
  config: AppConfig,
  paymentProvider: PaymentProvider,
  email: EmailService,
  bookingId: string,
): Promise<void> {
  const agreement = db.prepare(`
    SELECT * FROM agreements WHERE booking_id = ? AND status = 'OWNER_SIGNED' ORDER BY version DESC LIMIT 1
  `).get(bookingId) as AgreementRow | undefined;
  if (!agreement || agreement.provider !== 'mock') throw new Error('No mock agreement awaiting guest signature');
  const timestamp = nowIso();
  db.prepare('UPDATE agreements SET guest_signed_at = ?, updated_at = ? WHERE id = ?').run(timestamp, timestamp, agreement.id);
  await finalizeAgreement(db, config, agreement, fs.readFileSync(agreement.unsigned_pdf_path), paymentProvider, email, 'ADMIN');
}

export async function processDocumensoEvent(
  db: Database,
  config: AppConfig,
  signatureProvider: SignatureProvider,
  paymentProvider: PaymentProvider,
  email: EmailService,
  event: { event: string; payload: any; createdAt?: string },
): Promise<void> {
  // V2 envelope webhooks include both the legacy numeric document `id` and the
  // public string `envelopeId` returned by the envelope API. We store the latter.
  const providerDocumentId = String(event.payload?.envelopeId ?? event.payload?.id ?? '');
  const agreement = db.prepare('SELECT * FROM agreements WHERE provider_document_id = ?').get(providerDocumentId) as AgreementRow | undefined;
  if (!agreement) throw new Error('Unknown Documenso document');
  const recipients = Array.isArray(event.payload?.recipients) ? event.payload.recipients : [];
  withImmediateTransaction(db, () => {
    applySignerTimestamps(db, config, agreement, recipients);
    const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(agreement.booking_id) as unknown as BookingRow;
    const ownerSigned = recipients.some(
      (recipient: any) => recipient.email?.toLowerCase() === config.OWNER_EMAIL.toLowerCase() && recipient.signingStatus === 'SIGNED',
    );
    if (ownerSigned && booking.status === 'AWAITING_OWNER_SIGNATURE') {
      db.prepare("UPDATE agreements SET status = 'OWNER_SIGNED', updated_at = ? WHERE id = ?").run(nowIso(), agreement.id);
      transitionBooking(db, booking.id, 'AWAITING_GUEST_SIGNATURE', { type: 'SIGNATURE_PROVIDER' }, 'OWNER_SIGNED');
    }
  });
  if (event.event === 'DOCUMENT_COMPLETED') {
    const signed = await signatureProvider.downloadCompleted(providerDocumentId);
    await finalizeAgreement(db, config, agreement, signed, paymentProvider, email, 'SIGNATURE_PROVIDER');
  }
}

export async function cancelBookingWorkflow(
  db: Database,
  config: AppConfig,
  provider: SignatureProvider,
  email: EmailService,
  bookingId: string,
  adminId: string,
  reason: string,
): Promise<void> {
  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId) as BookingRow | undefined;
  if (!booking) throw new Error('Booking not found');
  if (['EXPIRED', 'CANCELLED', 'REFUNDED'].includes(booking.status)) throw new Error('Booking is already final');
  const agreement = db.prepare(`
    SELECT * FROM agreements WHERE booking_id = ? AND status IN ('SENT','OWNER_SIGNED') ORDER BY version DESC LIMIT 1
  `).get(bookingId) as AgreementRow | undefined;
  if (agreement?.provider_document_id) await provider.cancel(agreement.provider_document_id);
  withImmediateTransaction(db, () => {
    transitionBooking(db, bookingId, 'CANCELLED', { type: 'ADMIN', id: adminId }, 'BOOKING_CANCELLED', { reason });
    releaseDateBlock(db, bookingId, 'cancelled');
    db.prepare(`
      UPDATE agreements SET status = CASE WHEN status = 'COMPLETED' THEN status ELSE 'CANCELLED' END,
        invalidated_reason = ?, updated_at = ? WHERE booking_id = ? AND status IN ('DRAFT','SENT','OWNER_SIGNED')
    `).run(reason, nowIso(), bookingId);
  });
  const guest = db.prepare(`
    SELECT g.email FROM guests g JOIN bookings b ON b.primary_guest_id = g.id WHERE b.id = ?
  `).get(bookingId) as { email: string };
  await email.send('booking-cancellation', bookingId, guest.email, `booking-cancellation:${bookingId}:guest`);
}
