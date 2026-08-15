import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../config.js';
import type { Database } from '../db.js';
import { nowIso } from '../lib/format.js';
import { sha256 } from '../lib/crypto.js';
import type { EmailService } from '../services/email.js';
import type { SignatureProvider } from '../services/signature.js';
import type { PaymentProvider } from '../services/payment.js';
import {
  markPaymentFailed,
  markPaymentProcessing,
  markPaymentSucceeded,
  markRefund,
  stripeClient,
} from '../services/payment.js';
import { processDocumensoEvent } from '../services/workflow.js';
import type { PaymentRow } from '../types.js';

interface WebhookDependencies {
  db: Database;
  config: AppConfig;
  signatureProvider: SignatureProvider;
  paymentProvider: PaymentProvider;
  email: EmailService;
}

function startEvent(db: Database, provider: string, eventId: string, eventType: string, payloadHash: string): boolean {
  const existing = db.prepare(`
    SELECT processed_at FROM webhook_events WHERE provider = ? AND provider_event_id = ?
  `).get(provider, eventId) as { processed_at: string | null } | undefined;
  if (existing?.processed_at) return false;
  if (!existing) {
    db.prepare(`
      INSERT INTO webhook_events (id, provider, provider_event_id, event_type, payload_hash, received_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), provider, eventId, eventType, payloadHash, nowIso());
  } else {
    db.prepare(`
      UPDATE webhook_events SET processing_error = NULL, received_at = ? WHERE provider = ? AND provider_event_id = ?
    `).run(nowIso(), provider, eventId);
  }
  return true;
}

function finishEvent(db: Database, provider: string, eventId: string): void {
  db.prepare(`
    UPDATE webhook_events SET processed_at = ?, processing_error = NULL WHERE provider = ? AND provider_event_id = ?
  `).run(nowIso(), provider, eventId);
}

function failEvent(db: Database, provider: string, eventId: string, error: unknown): void {
  db.prepare(`
    UPDATE webhook_events SET processing_error = ? WHERE provider = ? AND provider_event_id = ?
  `).run(error instanceof Error ? error.message.slice(0, 1000) : 'Unknown webhook error', provider, eventId);
}

function paymentByCheckout(db: Database, sessionId: string): PaymentRow | undefined {
  return db.prepare('SELECT * FROM payments WHERE checkout_session_id = ?').get(sessionId) as PaymentRow | undefined;
}

function paymentByIntentOrBooking(db: Database, paymentIntentId?: string, bookingId?: string): PaymentRow | undefined {
  if (paymentIntentId) {
    const found = db.prepare('SELECT * FROM payments WHERE payment_intent_id = ?').get(paymentIntentId) as PaymentRow | undefined;
    if (found) return found;
  }
  if (bookingId) {
    return db.prepare('SELECT * FROM payments WHERE booking_id = ? ORDER BY created_at DESC LIMIT 1').get(bookingId) as
      | PaymentRow
      | undefined;
  }
  return undefined;
}

async function sendFailureEmail(db: Database, email: EmailService, payment: PaymentRow): Promise<void> {
  const booking = db.prepare('SELECT primary_guest_id FROM bookings WHERE id = ?').get(payment.booking_id) as { primary_guest_id: string };
  const guest = db.prepare('SELECT email FROM guests WHERE id = ?').get(booking.primary_guest_id) as { email: string };
  await email.send('payment-failure', payment.booking_id, guest.email, `payment-failure:${payment.id}`);
}

export async function registerWebhookRoutes(app: FastifyInstance, deps: WebhookDependencies): Promise<void> {
  const { db, config, signatureProvider, paymentProvider, email } = deps;

  app.post('/webhooks/documenso', async (request, reply) => {
    if (signatureProvider.name !== 'documenso') return reply.code(404).send({ error: 'Not configured' });
    if (!signatureProvider.verifyWebhook(request.headers['x-documenso-secret'] as string | undefined)) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
    const body = request.body as { event?: string; payload?: unknown; createdAt?: string };
    if (!body?.event || !body.payload) return reply.code(400).send({ error: 'Invalid event' });
    const serialized = JSON.stringify(body);
    const eventId = sha256(serialized);
    if (!startEvent(db, 'documenso', eventId, body.event, sha256(serialized))) return reply.send({ received: true, duplicate: true });
    try {
      await processDocumensoEvent(db, config, signatureProvider, paymentProvider, email, body as any);
      finishEvent(db, 'documenso', eventId);
      return reply.send({ received: true });
    } catch (error) {
      failEvent(db, 'documenso', eventId, error);
      request.log.error({ err: error }, 'Documenso webhook failed');
      return reply.code(500).send({ error: 'Webhook processing failed' });
    }
  });

  app.post('/webhooks/stripe', { config: { rawBody: true } }, async (request, reply) => {
    if (config.PAYMENT_PROVIDER !== 'stripe') return reply.code(404).send({ error: 'Not configured' });
    const signature = request.headers['stripe-signature'];
    const rawBody = (request as typeof request & { rawBody?: Buffer }).rawBody;
    if (typeof signature !== 'string' || !rawBody || !config.STRIPE_WEBHOOK_SECRET) {
      return reply.code(400).send({ error: 'Missing webhook signature' });
    }
    let event: any;
    try {
      event = stripeClient(config).webhooks.constructEvent(rawBody, signature, config.STRIPE_WEBHOOK_SECRET);
    } catch {
      return reply.code(400).send({ error: 'Invalid webhook signature' });
    }
    if (!startEvent(db, 'stripe', event.id, event.type, sha256(rawBody))) return reply.send({ received: true, duplicate: true });
    try {
      const object = event.data.object as any;
      if (event.type === 'checkout.session.completed') {
        const payment = paymentByCheckout(db, object.id);
        if (!payment) throw new Error('Unknown Stripe Checkout Session');
        db.prepare("UPDATE payments SET payment_method = 'CARD', updated_at = ? WHERE id = ?").run(nowIso(), payment.id);
        if (object.payment_status === 'paid') {
          const changed = markPaymentSucceeded(db, payment, { paymentIntentId: String(object.payment_intent ?? '') || undefined });
          if (changed) await email.sendConfirmation(payment.booking_id, payment.id);
        } else {
          markPaymentProcessing(db, payment, String(object.payment_intent ?? '') || undefined);
        }
      } else if (event.type === 'checkout.session.async_payment_succeeded') {
        const payment = paymentByCheckout(db, object.id);
        if (!payment) throw new Error('Unknown Stripe Checkout Session');
        db.prepare("UPDATE payments SET payment_method = 'CARD', updated_at = ? WHERE id = ?").run(nowIso(), payment.id);
        const changed = markPaymentSucceeded(db, payment, { paymentIntentId: String(object.payment_intent ?? '') || undefined });
        if (changed) await email.sendConfirmation(payment.booking_id, payment.id);
      } else if (event.type === 'checkout.session.async_payment_failed') {
        const payment = paymentByCheckout(db, object.id);
        if (!payment) throw new Error('Unknown Stripe Checkout Session');
        if (markPaymentFailed(db, payment, 'async_payment_failed')) await sendFailureEmail(db, email, payment);
      } else if (event.type === 'payment_intent.payment_failed') {
        const payment = paymentByIntentOrBooking(db, object.id, object.metadata?.booking_id);
        if (!payment) throw new Error('Unknown Stripe PaymentIntent');
        if (markPaymentFailed(db, payment, object.last_payment_error?.code, object.last_payment_error?.message)) {
          await sendFailureEmail(db, email, payment);
        }
      } else if (event.type === 'charge.refunded') {
        const payment = paymentByIntentOrBooking(db, String(object.payment_intent ?? '') || undefined, object.metadata?.booking_id);
        if (!payment) throw new Error('Unknown Stripe charge');
        markRefund(db, payment, Number(object.amount_refunded ?? 0), object.id);
      }
      finishEvent(db, 'stripe', event.id);
      return reply.send({ received: true });
    } catch (error) {
      failEvent(db, 'stripe', event.id, error);
      request.log.error({ err: error }, 'Stripe webhook failed');
      return reply.code(500).send({ error: 'Webhook processing failed' });
    }
  });
}
