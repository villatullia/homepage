import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Handlebars from 'handlebars';
import { convert } from 'html-to-text';
import PDFDocument from 'pdfkit';
import type { Database } from '../db.js';
import type { AppConfig } from '../config.js';
import { formatDate, formatMoney, nowIso } from '../lib/format.js';
import { sha256 } from '../lib/crypto.js';
import type { AgreementRow, BookingRow, GuestRow } from '../types.js';

interface AgreementContext {
  agreement: { version: number };
  booking: {
    reference: string;
    checkInFormatted: string;
    checkOutFormatted: string;
    guestsCount: number;
    paymentDeadlineFormatted: string;
    cancellationTerms: string;
    specialConditions: string;
  };
  guest: { legalName: string; email: string; phone: string; address: string };
  owner: { name: string; email: string; address: string };
  property: { legalName: string; address: string };
  money: {
    rentalPrice: string;
    amountDue: string;
    remainingBalance: string;
    securityDeposit: string;
    touristTax: string;
  };
  additionalGuests: string;
}

export function buildAgreementContext(
  db: Database,
  config: AppConfig,
  booking: BookingRow,
  version: number,
): AgreementContext {
  const guest = db.prepare('SELECT * FROM guests WHERE id = ?').get(booking.primary_guest_id) as unknown as GuestRow;
  const property = db.prepare('SELECT * FROM properties WHERE id = ?').get(booking.property_id) as {
    legal_name: string;
    address: string;
  };
  const party = db.prepare('SELECT full_name FROM booking_guests WHERE booking_id = ? ORDER BY position').all(booking.id) as Array<{
    full_name: string;
  }>;
  return {
    agreement: { version },
    booking: {
      reference: booking.reference,
      checkInFormatted: formatDate(booking.check_in),
      checkOutFormatted: formatDate(booking.check_out),
      guestsCount: booking.guests_count,
      paymentDeadlineFormatted: formatDate(booking.payment_deadline),
      cancellationTerms: booking.cancellation_terms,
      specialConditions: booking.special_conditions || 'No special conditions.',
    },
    guest: {
      legalName: guest.legal_name,
      email: guest.email,
      phone: guest.phone,
      address: [guest.address_line1, guest.address_line2, `${guest.postal_code} ${guest.city}`, guest.region, guest.country]
        .filter(Boolean)
        .join(', '),
    },
    owner: { name: config.OWNER_NAME, email: config.OWNER_EMAIL, address: config.OWNER_ADDRESS },
    property: { legalName: property.legal_name, address: property.address },
    money: {
      rentalPrice: formatMoney(booking.rental_price_minor, booking.currency),
      amountDue: formatMoney(booking.amount_due_minor, booking.currency),
      remainingBalance: formatMoney(booking.remaining_balance_minor, booking.currency),
      securityDeposit: formatMoney(booking.security_deposit_minor, booking.currency),
      touristTax: formatMoney(booking.tourist_tax_minor, booking.currency),
    },
    additionalGuests: party.map((member) => member.full_name).join(', '),
  };
}

async function writePdf(html: string, targetPath: string): Promise<number> {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const plainText = convert(html, {
    wordwrap: 92,
    selectors: [
      { selector: 'style', format: 'skip' },
      { selector: '.eyebrow', format: 'skip' },
      { selector: '.signature-grid', format: 'skip' },
    ],
  });
  return await new Promise<number>((resolve, reject) => {
    const stream = fs.createWriteStream(targetPath, { flags: 'wx' });
    const document = new PDFDocument({ size: 'A4', margins: { top: 54, left: 58, right: 58, bottom: 54 }, bufferPages: true });
    let pages = 1;
    document.on('pageAdded', () => {
      pages += 1;
    });
    stream.on('finish', () => resolve(pages));
    stream.on('error', reject);
    document.on('error', reject);
    document.pipe(stream);
    document.fillColor('#b66b4f').font('Helvetica-Bold').fontSize(9).text('VILLA TULLIA · PADENGHE SUL GARDA', { characterSpacing: 1.2 });
    document.moveDown(0.6).fillColor('#183632').font('Times-Roman').fontSize(11);
    const cancellationMarker = '4. CANCELLATION';
    const cancellationIndex = plainText.indexOf(cancellationMarker);
    if (cancellationIndex > 0) {
      document.text(plainText.slice(0, cancellationIndex).trimEnd(), { align: 'left', lineGap: 2 });
      document.addPage();
      document.text(plainText.slice(cancellationIndex), { align: 'left', lineGap: 2 });
    } else {
      document.text(plainText, { align: 'left', lineGap: 2 });
    }
    if (document.y > 580) document.addPage();
    document.moveDown(2).font('Times-Bold').fontSize(15).text('Signatures');
    const y = document.y + 72;
    document.moveTo(58, y).lineTo(270, y).strokeColor('#183632').stroke();
    document.moveTo(326, y).lineTo(538, y).stroke();
    document.font('Helvetica').fontSize(9).fillColor('#586762').text('Owner signature and date', 58, y + 7, { width: 212 });
    document.text('Guest signature and date', 326, y + 7, { width: 212 });
    const range = document.bufferedPageRange();
    for (let index = range.start; index < range.start + range.count; index += 1) {
      document.switchToPage(index);
      document.font('Helvetica').fontSize(8).fillColor('#7b8581').text(`Page ${index + 1} of ${range.count}`, 58, 750, {
        width: 480,
        align: 'right',
        lineBreak: false,
      });
    }
    pages = range.count;
    document.end();
  });
}

export async function generateAgreement(db: Database, config: AppConfig, bookingId: string): Promise<AgreementRow> {
  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId) as BookingRow | undefined;
  if (!booking) throw new Error('Booking not found');
  if (booking.status !== 'AGREEMENT_DRAFT') throw new Error('Agreement can only be generated for a draft booking');
  const activeSent = db.prepare(`
    SELECT 1 FROM agreements WHERE booking_id = ? AND status IN ('SENT','OWNER_SIGNED','COMPLETED') LIMIT 1
  `).get(bookingId);
  if (activeSent) throw new Error('A sent or completed agreement cannot be replaced');

  const template = db.prepare('SELECT * FROM agreement_templates WHERE active = 1 ORDER BY created_at DESC LIMIT 1').get() as {
    id: string;
    version: string;
    body_template: string;
  } | undefined;
  if (!template) throw new Error('No active agreement template');
  const row = db.prepare('SELECT COALESCE(MAX(version), 0) + 1 AS version FROM agreements WHERE booking_id = ?').get(bookingId) as {
    version: number;
  };
  const context = buildAgreementContext(db, config, booking, row.version);
  const html = Handlebars.compile(template.body_template, { strict: true })(context);
  const directory = path.join(config.storagePath, 'agreements', booking.reference);
  const targetPath = path.join(directory, `agreement-v${row.version}-unsigned.pdf`);
  const pageCount = await writePdf(html, targetPath);
  const hash = sha256(fs.readFileSync(targetPath));
  const timestamp = nowIso();
  const id = randomUUID();

  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`
      UPDATE agreements
      SET status = 'INVALIDATED', invalidated_at = ?, invalidated_reason = 'Replaced by a new draft version', updated_at = ?
      WHERE booking_id = ? AND status = 'DRAFT'
    `).run(timestamp, timestamp, bookingId);
    db.prepare(`
      INSERT INTO agreements
        (id, booking_id, version, template_id, template_version, status, generated_at, rendered_html,
         template_data_json, page_count, document_hash, unsigned_pdf_path, provider, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      bookingId,
      row.version,
      template.id,
      template.version,
      timestamp,
      html,
      JSON.stringify(context),
      pageCount,
      hash,
      targetPath,
      config.SIGNING_PROVIDER,
      timestamp,
      timestamp,
    );
    db.prepare(`
      INSERT INTO booking_events
        (id, booking_id, actor_type, event_type, details_json, created_at)
      VALUES (?, ?, 'ADMIN', 'AGREEMENT_GENERATED', ?, ?)
    `).run(randomUUID(), bookingId, JSON.stringify({ agreementId: id, version: row.version, hash }), timestamp);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return db.prepare('SELECT * FROM agreements WHERE id = ?').get(id) as unknown as AgreementRow;
}
