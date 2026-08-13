import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db.js';
import { createBooking } from '../src/services/booking.js';
import { generateAgreement } from '../src/services/agreement.js';

const workDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'villa-sample-'));
const output = path.resolve(process.env.SAMPLE_OUTPUT ?? './tmp/pdfs/sample-agreement.pdf');
const config = loadConfig({
  NODE_ENV: 'test',
  DATABASE_PATH: path.join(workDirectory, 'sample.sqlite'),
  STORAGE_PATH: path.join(workDirectory, 'storage'),
  COOKIE_SECRET: 'sample-only-cookie-secret-that-is-over-32-characters',
  OWNER_NAME: 'Maria Rossi',
  OWNER_EMAIL: 'owner@example.test',
  OWNER_ADDRESS: 'Via del Lago 1, 25080 Padenghe sul Garda, Italy',
  PROPERTY_LEGAL_NAME: 'Villa Tullia',
  PROPERTY_ADDRESS: 'Via del Lago 10, 25080 Padenghe sul Garda, Italy',
});
const db = openDatabase(config);
try {
  const result = createBooking(db, config, {
    legalName: 'Alex Example',
    email: 'guest@example.test',
    phone: '+39 333 123 4567',
    addressLine1: '10 Example Street',
    postalCode: '10100',
    city: 'Turin',
    country: 'Italy',
    guestsCount: 4,
    additionalGuests: ['Guest Two', 'Guest Three', 'Guest Four'],
    checkIn: '2027-07-10',
    checkOut: '2027-07-17',
    rentalPriceMinor: 420000,
    amountDueMinor: 140000,
    remainingBalanceMinor: 280000,
    securityDepositMinor: 50000,
    touristTaxMinor: 0,
    currency: 'EUR',
    paymentDeadline: '2027-06-10',
    cancellationTerms:
      'The amount paid is refundable until 60 days before arrival. Thereafter it is non-refundable except where mandatory law provides otherwise.',
    specialConditions: 'No parties or events. Quiet hours begin at 22:00. Maximum occupancy is four guests.',
    addressLine2: '',
    region: 'Piedmont',
  });
  const agreement = await generateAgreement(db, config, result.booking.id);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.copyFileSync(agreement.unsigned_pdf_path, output, fs.constants.COPYFILE_EXCL);
  console.log(output);
} finally {
  db.close();
  fs.rmSync(workDirectory, { recursive: true, force: true });
}
