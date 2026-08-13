import type { Database } from '../db.js';
import { releaseExpiredHolds } from './booking.js';
import type { AppConfig } from '../config.js';
import type { EmailService } from './email.js';
import { nowIso } from '../lib/format.js';
import type { PaymentProvider } from './payment.js';
import { createPaymentRequest } from './payment.js';
import type { AgreementRow, PaymentRow } from '../types.js';

export async function runDueJobs(db: Database, config: AppConfig, email: EmailService, paymentProvider?: PaymentProvider): Promise<{ expired: number; completed: number }> {
  const expired = releaseExpiredHolds(db);
  const jobs = db.prepare(`
    SELECT * FROM scheduled_jobs WHERE status IN ('PENDING','FAILED') AND run_at <= unixepoch() AND attempts < 5
    ORDER BY run_at LIMIT 20
  `).all() as Array<{ id: string; job_type: string; booking_id: string | null; attempts: number; payload_json: string }>;
  let completed = 0;
  for (const job of jobs) {
    const claim = db.prepare(`
      UPDATE scheduled_jobs SET status = 'RUNNING', attempts = attempts + 1
      WHERE id = ? AND status IN ('PENDING','FAILED')
    `).run(job.id);
    if (claim.changes !== 1) continue;
    try {
      if (!job.booking_id) throw new Error('Reminder job is missing a booking');
      const booking = db.prepare('SELECT status, primary_guest_id FROM bookings WHERE id = ?').get(job.booking_id) as
        | { status: string; primary_guest_id: string }
        | undefined;
      if (!booking) throw new Error('Booking not found');
      // Signature invitations already come from the signing provider. Legacy
      // SIGNING_REMINDER jobs are completed silently to avoid duplicate mail.
      if (job.job_type === 'BALANCE_PAYMENT_REQUEST' && booking.status === 'CONFIRMED') {
        if (!paymentProvider) throw new Error('Payment provider is unavailable');
        const agreement = db.prepare(`SELECT * FROM agreements WHERE booking_id = ? AND status = 'COMPLETED' ORDER BY version DESC LIMIT 1`).get(job.booking_id) as AgreementRow | undefined;
        if (!agreement) throw new Error('Completed agreement not found');
        const payment = await createPaymentRequest(db, paymentProvider, job.booking_id, agreement.id, 'BALANCE');
        await email.sendPaymentRequest(job.booking_id, payment);
      } else if (job.job_type === 'PAYMENT_REMINDER' && ['AWAITING_PAYMENT', 'PAYMENT_FAILED', 'CONFIRMED'].includes(booking.status)) {
        const payload = JSON.parse(job.payload_json || '{}') as { paymentId?: string };
        const payment = (payload.paymentId
          ? db.prepare('SELECT * FROM payments WHERE id = ?').get(payload.paymentId)
          : db.prepare("SELECT * FROM payments WHERE booking_id = ? AND status IN ('PENDING','FAILED') ORDER BY created_at DESC LIMIT 1").get(job.booking_id)) as PaymentRow | undefined;
        if (payment && ['PENDING', 'FAILED'].includes(payment.status)) await email.sendPaymentReminder(job.booking_id, payment);
      }
      db.prepare("UPDATE scheduled_jobs SET status = 'COMPLETED', completed_at = ?, last_error = NULL WHERE id = ?").run(nowIso(), job.id);
      completed += 1;
    } catch (error) {
      db.prepare("UPDATE scheduled_jobs SET status = 'FAILED', last_error = ? WHERE id = ?").run(
        error instanceof Error ? error.message.slice(0, 1000) : 'Unknown job failure',
        job.id,
      );
    }
  }
  return { expired, completed };
}
