import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../config.js';
import type { AgreementRow, BookingRow, GuestRow } from '../types.js';
import { randomToken, safeEqual } from '../lib/crypto.js';

export interface SignatureSendInput {
  agreement: AgreementRow;
  booking: BookingRow;
  guest: GuestRow;
}

export interface SignatureProvider {
  readonly name: 'mock' | 'documenso';
  send(input: SignatureSendInput): Promise<{ documentId: string }>;
  resend(documentId: string): Promise<void>;
  cancel(documentId: string): Promise<void>;
  downloadCompleted(documentId: string): Promise<Buffer>;
  verifyWebhook(secretHeader: string | undefined): boolean;
}

class MockSignatureProvider implements SignatureProvider {
  readonly name = 'mock' as const;

  async send(): Promise<{ documentId: string }> {
    return { documentId: `mock_${randomToken(18)}` };
  }

  async resend(): Promise<void> {}

  async cancel(): Promise<void> {}

  async downloadCompleted(): Promise<Buffer> {
    throw new Error('Mock signed documents are completed by the local workflow');
  }

  verifyWebhook(): boolean {
    return false;
  }
}

class DocumensoSignatureProvider implements SignatureProvider {
  readonly name = 'documenso' as const;

  constructor(private readonly config: AppConfig) {}

  private async json(pathname: string, init: RequestInit = {}): Promise<any> {
    if (!this.config.DOCUMENSO_API_TOKEN) throw new Error('Documenso API token is not configured');
    const response = await fetch(`${this.config.DOCUMENSO_BASE_URL.replace(/\/$/, '')}${pathname}`, {
      ...init,
      headers: {
        Authorization: this.config.DOCUMENSO_API_TOKEN,
        ...(init.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
        ...init.headers,
      },
    });
    if (!response.ok) throw new Error(`Documenso request failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
    if (response.status === 204) return undefined;
    return response.json();
  }

  async send(input: SignatureSendInput): Promise<{ documentId: string }> {
    const pdf = fs.readFileSync(input.agreement.unsigned_pdf_path);
    const form = new FormData();
    form.append(
      'payload',
      JSON.stringify({
        type: 'DOCUMENT',
        title: `${input.booking.reference} Rental Agreement v${input.agreement.version}`,
        externalId: `${input.booking.reference}-v${input.agreement.version}`,
        visibility: 'ADMIN',
        recipients: [
          {
            email: this.config.OWNER_EMAIL,
            name: this.config.OWNER_NAME,
            role: 'SIGNER',
            signingOrder: 1,
            fields: [
              {
                identifier: 0,
                type: 'SIGNATURE',
                page: input.agreement.page_count,
                positionX: 10,
                positionY: 80,
                width: 35,
                height: 7,
              },
              {
                identifier: 0,
                type: 'DATE',
                page: input.agreement.page_count,
                positionX: 10,
                positionY: 88,
                width: 20,
                height: 4,
              },
            ],
          },
          {
            email: input.guest.email,
            name: input.guest.legal_name,
            role: 'SIGNER',
            signingOrder: 2,
            fields: [
              {
                identifier: 0,
                type: 'SIGNATURE',
                page: input.agreement.page_count,
                positionX: 55,
                positionY: 80,
                width: 35,
                height: 7,
              },
              {
                identifier: 0,
                type: 'DATE',
                page: input.agreement.page_count,
                positionX: 55,
                positionY: 88,
                width: 20,
                height: 4,
              },
            ],
          },
        ],
        meta: {
          subject: `Villa Tullia agreement ${input.booking.reference}`,
          message: 'Please review and sign the Villa Tullia rental agreement.',
          signingOrder: 'SEQUENTIAL',
          timezone: 'Europe/Rome',
          language: 'en',
          typedSignatureEnabled: true,
          uploadSignatureEnabled: true,
          drawSignatureEnabled: true,
        },
      }),
    );
    form.append('files', new Blob([pdf], { type: 'application/pdf' }), path.basename(input.agreement.unsigned_pdf_path));
    const created = await this.json('/envelope/create', { method: 'POST', body: form });
    if (!created?.id) throw new Error('Documenso did not return an envelope ID');
    await this.json('/envelope/distribute', { method: 'POST', body: JSON.stringify({ envelopeId: created.id }) });
    return { documentId: String(created.id) };
  }

  async resend(documentId: string): Promise<void> {
    await this.json('/envelope/redistribute', { method: 'POST', body: JSON.stringify({ envelopeId: documentId }) });
  }

  async cancel(documentId: string): Promise<void> {
    await this.json('/envelope/delete', { method: 'POST', body: JSON.stringify({ envelopeId: documentId }) });
  }

  async downloadCompleted(documentId: string): Promise<Buffer> {
    const envelope = await this.json(`/envelope/${encodeURIComponent(documentId)}`);
    if (envelope.status !== 'COMPLETED') throw new Error('Documenso document is not completed');
    const itemId = envelope.envelopeItems?.[0]?.id;
    if (!itemId) throw new Error('Documenso envelope has no PDF item');
    const response = await fetch(
      `${this.config.DOCUMENSO_BASE_URL.replace(/\/$/, '')}/envelope/item/${encodeURIComponent(itemId)}/download?version=signed`,
      { headers: { Authorization: this.config.DOCUMENSO_API_TOKEN } },
    );
    if (!response.ok) throw new Error(`Could not download signed document (${response.status})`);
    return Buffer.from(await response.arrayBuffer());
  }

  verifyWebhook(secretHeader: string | undefined): boolean {
    return Boolean(this.config.DOCUMENSO_WEBHOOK_SECRET && secretHeader && safeEqual(secretHeader, this.config.DOCUMENSO_WEBHOOK_SECRET));
  }
}

export function createSignatureProvider(config: AppConfig): SignatureProvider {
  return config.SIGNING_PROVIDER === 'documenso' ? new DocumensoSignatureProvider(config) : new MockSignatureProvider();
}
