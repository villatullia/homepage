import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import nodemailer from 'nodemailer';
import nunjucks from 'nunjucks';
import type { AppConfig } from '../config.js';
import type { Database } from '../db.js';
import { openToken } from '../lib/crypto.js';
import { formatDate, formatMoney, nowIso } from '../lib/format.js';
import type { BookingRow, EnquiryRow, GuestRow, PaymentRow } from '../types.js';

export type EmailTemplateKey =
  | 'owner-signature-request'
  | 'guest-signature-request'
  | 'agreement-completed'
  | 'payment-request'
  | 'payment-confirmation'
  | 'payment-failure'
  | 'booking-cancellation'
  | 'signing-reminder'
  | 'payment-reminder'
  | 'enquiry-notification';

const subjects: Record<EmailTemplateKey, string> = {
  'owner-signature-request': 'Please sign {{ reference }}',
  'guest-signature-request': 'Your Villa Tullia agreement is ready to sign',
  'agreement-completed': 'Agreement completed for {{ reference }}',
  'payment-request': 'Secure payment for {{ reference }}',
  'payment-confirmation': 'Booking confirmed — {{ reference }}',
  'payment-failure': 'Payment needs attention — {{ reference }}',
  'booking-cancellation': 'Booking cancelled — {{ reference }}',
  'signing-reminder': 'Reminder: please sign {{ reference }}',
  'payment-reminder': 'Reminder: payment due for {{ reference }}',
  'enquiry-notification': 'New Villa Tullia enquiry {{ reference }}',
};

interface EmailContext {
  reference: string;
  guestName: string;
  checkIn: string;
  checkOut: string;
  amount: string;
  deadline: string;
  guestUrl: string;
  ownerName: string;
  isBalance?: boolean;
  paymentLabel?: string;
}

export class EmailService {
  private readonly renderer: nunjucks.Environment;
  private readonly transport: nodemailer.Transporter | undefined;

  constructor(
    private readonly db: Database,
    private readonly config: AppConfig,
  ) {
    this.renderer = nunjucks.configure(path.resolve(process.cwd(), 'src/views/emails'), { autoescape: true, noCache: true });
    this.transport =
      config.EMAIL_PROVIDER === 'smtp'
        ? nodemailer.createTransport({
            host: config.SMTP_HOST,
            port: config.SMTP_PORT,
            secure: config.SMTP_SECURE,
            ...(config.SMTP_USER ? { auth: { user: config.SMTP_USER, pass: config.SMTP_PASSWORD } } : {}),
          })
        : undefined;
  }

  private context(bookingId: string): EmailContext {
    const booking = this.db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId) as unknown as BookingRow;
    const guest = this.db.prepare('SELECT * FROM guests WHERE id = ?').get(booking.primary_guest_id) as unknown as GuestRow;
    const tokenRow = this.db.prepare(`
      SELECT token_ciphertext FROM guest_access_tokens
      WHERE booking_id = ? AND revoked_at IS NULL AND expires_at > unixepoch()
      ORDER BY created_at DESC LIMIT 1
    `).get(bookingId) as { token_ciphertext: string } | undefined;
    const guestToken = tokenRow ? openToken(tokenRow.token_ciphertext, this.config.COOKIE_SECRET) : '';
    return {
      reference: booking.reference,
      guestName: guest.legal_name,
      checkIn: formatDate(booking.check_in),
      checkOut: formatDate(booking.check_out),
      amount: formatMoney(booking.amount_due_minor, booking.currency),
      deadline: formatDate(booking.payment_deadline),
      guestUrl: guestToken ? `${this.config.APP_BASE_URL}/booking/${encodeURIComponent(guestToken)}` : this.config.APP_BASE_URL,
      ownerName: this.config.OWNER_NAME,
    };
  }

  private async deliver(input: {
    template: EmailTemplateKey;
    bookingId?: string;
    recipient: string;
    replyTo?: string;
    idempotencyKey: string;
    subject: string;
    html: string;
  }): Promise<boolean> {
    if (this.db.prepare('SELECT 1 FROM email_deliveries WHERE idempotency_key = ?').get(input.idempotencyKey)) return false;
    const id = randomUUID();
    const timestamp = nowIso();
    this.db.prepare(`
      INSERT INTO email_deliveries
        (id, booking_id, template_key, recipient, idempotency_key, provider, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'QUEUED', ?)
    `).run(
      id,
      input.bookingId ?? null,
      input.template,
      input.recipient,
      input.idempotencyKey,
      this.config.EMAIL_PROVIDER,
      timestamp,
    );
    try {
      if (this.transport) {
        const result = await this.transport.sendMail({
          from: this.config.EMAIL_FROM,
          to: input.recipient,
          replyTo: input.replyTo,
          subject: input.subject,
          html: input.html,
        });
        this.db.prepare(`
          UPDATE email_deliveries SET status = 'SENT', provider_message_id = ?, sent_at = ? WHERE id = ?
        `).run(result.messageId, nowIso(), id);
      } else {
        const previewDirectory = path.join(this.config.storagePath, 'email-preview');
        fs.mkdirSync(previewDirectory, { recursive: true });
        fs.writeFileSync(
          path.join(previewDirectory, `${id}.html`),
          `<!doctype html><meta charset="utf-8"><title>${input.subject}</title><p><strong>To:</strong> ${input.recipient}</p>${input.html}`,
          { encoding: 'utf8', flag: 'wx' },
        );
        this.db.prepare("UPDATE email_deliveries SET status = 'PREVIEWED', sent_at = ? WHERE id = ?").run(nowIso(), id);
      }
      return true;
    } catch (error) {
      this.db.prepare("UPDATE email_deliveries SET status = 'FAILED', error_message = ? WHERE id = ?").run(
        error instanceof Error ? error.message.slice(0, 1000) : 'Unknown email error',
        id,
      );
      throw error;
    }
  }

  async send(
    template: EmailTemplateKey,
    bookingId: string,
    recipient: string,
    idempotencyKey: string,
  ): Promise<boolean> {
    const context = this.context(bookingId);
    const subject = nunjucks.renderString(subjects[template], context);
    const html = this.renderer.render(`${template}.njk`, context);
    return this.deliver({ template, bookingId, recipient, idempotencyKey, subject, html });
  }

  async sendEnquiryNotification(enquiryId: string): Promise<boolean> {
    const enquiry = this.db.prepare('SELECT * FROM enquiries WHERE id = ?').get(enquiryId) as unknown as EnquiryRow | undefined;
    if (!enquiry) throw new Error('Enquiry not found');
    const context = {
      reference: enquiry.reference,
      guestName: enquiry.full_name,
      guestEmail: enquiry.email,
      phone: enquiry.phone || 'Not supplied',
      checkIn: enquiry.requested_check_in ? formatDate(enquiry.requested_check_in) : 'Flexible',
      checkOut: enquiry.requested_check_out ? formatDate(enquiry.requested_check_out) : 'Flexible',
      guestsCount: enquiry.guests_count ?? 'Not supplied',
      message: enquiry.message,
      adminUrl: `${this.config.APP_BASE_URL}/admin/enquiries/${encodeURIComponent(enquiry.id)}`,
    };
    return this.deliver({
      template: 'enquiry-notification',
      recipient: this.config.OWNER_EMAIL,
      replyTo: enquiry.email,
      idempotencyKey: `enquiry-notification:${enquiry.id}:owner`,
      subject: nunjucks.renderString(subjects['enquiry-notification'], context),
      html: this.renderer.render('enquiry-notification.njk', context),
    });
  }

  async sendPaymentRequest(bookingId: string, payment: PaymentRow): Promise<void> {
    const booking = this.db.prepare('SELECT primary_guest_id FROM bookings WHERE id = ?').get(bookingId) as { primary_guest_id: string };
    const guest = this.db.prepare('SELECT email FROM guests WHERE id = ?').get(booking.primary_guest_id) as { email: string };
    await this.sendPaymentTemplate('payment-request', bookingId, payment, guest.email, `payment-request:${payment.id}`);
  }

  async sendConfirmation(bookingId: string, paymentId: string): Promise<void> {
    const payment = this.db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId) as unknown as PaymentRow;
    const booking = this.db.prepare('SELECT primary_guest_id FROM bookings WHERE id = ?').get(bookingId) as { primary_guest_id: string };
    const guest = this.db.prepare('SELECT email FROM guests WHERE id = ?').get(booking.primary_guest_id) as { email: string };
    await this.sendPaymentTemplate('payment-confirmation', bookingId, payment, guest.email, `payment-confirmation:${paymentId}:guest`);
    await this.sendPaymentTemplate('payment-confirmation', bookingId, payment, this.config.OWNER_EMAIL, `payment-confirmation:${paymentId}:owner`);
  }

  async sendPaymentReminder(bookingId: string, payment: PaymentRow): Promise<void> {
    const booking = this.db.prepare('SELECT primary_guest_id FROM bookings WHERE id = ?').get(bookingId) as { primary_guest_id: string };
    const guest = this.db.prepare('SELECT email FROM guests WHERE id = ?').get(booking.primary_guest_id) as { email: string };
    await this.sendPaymentTemplate('payment-reminder', bookingId, payment, guest.email, `payment-reminder:${payment.id}`);
  }

  private async sendPaymentTemplate(
    template: 'payment-request' | 'payment-confirmation' | 'payment-reminder',
    bookingId: string,
    payment: PaymentRow,
    recipient: string,
    idempotencyKey: string,
  ): Promise<boolean> {
    const context = {
      ...this.context(bookingId),
      amount: formatMoney(payment.amount_minor, payment.currency),
      deadline: payment.due_date ? formatDate(payment.due_date) : '',
      isBalance: payment.purpose === 'BALANCE',
      paymentLabel: payment.purpose === 'BALANCE' ? 'remaining balance' : 'initial payment',
    };
    const defaultSubject = nunjucks.renderString(subjects[template], context);
    const subject = payment.purpose === 'BALANCE'
      ? `${template === 'payment-confirmation' ? 'Balance received' : template === 'payment-reminder' ? 'Reminder: balance due' : 'Balance payment'} for ${context.reference}`
      : defaultSubject;
    return this.deliver({
      template,
      bookingId,
      recipient,
      idempotencyKey,
      subject,
      html: this.renderer.render(`${template}.njk`, context),
    });
  }
}
