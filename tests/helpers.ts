import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppConfig } from '../src/config.js';
import { loadConfig } from '../src/config.js';
import type { Database } from '../src/db.js';
import { openDatabase } from '../src/db.js';
import type { BookingInput } from '../src/services/booking.js';

export function createTestContext(overrides: Record<string, string | undefined> = {}): {
  config: AppConfig;
  db: Database;
  directory: string;
  close: () => void;
} {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'villa-tullia-'));
  const config = loadConfig({
    NODE_ENV: 'test',
    APP_BASE_URL: 'http://127.0.0.1:3000',
    DATABASE_PATH: path.join(directory, 'villa.sqlite'),
    STORAGE_PATH: path.join(directory, 'storage'),
    COOKIE_SECRET: 'test-only-cookie-secret-that-is-over-32-characters',
    OWNER_NAME: 'Test Owner',
    OWNER_EMAIL: 'owner@example.test',
    OWNER_ADDRESS: '1 Owner Street, Italy',
    PROPERTY_LEGAL_NAME: 'Villa Tullia Test',
    PROPERTY_ADDRESS: '1 Lake Road, Padenghe sul Garda, Italy',
    SIGNING_PROVIDER: 'mock',
    PAYMENT_PROVIDER: 'mock',
    EMAIL_PROVIDER: 'preview',
    ICAL_FEED_TOKEN: 'test-calendar-token-that-is-private',
    ...overrides,
  });
  const db = openDatabase(config);
  return {
    config,
    db,
    directory,
    close() {
      db.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

export function validBooking(overrides: Partial<BookingInput> = {}): BookingInput {
  return {
    legalName: 'Ada Lovelace',
    email: 'ada@example.test',
    phone: '+39 333 123 4567',
    addressLine1: '10 Example Street',
    addressLine2: '',
    postalCode: '25080',
    city: 'Padenghe sul Garda',
    region: 'Brescia',
    country: 'Italy',
    guestsCount: 2,
    additionalGuests: ['Charles Babbage'],
    checkIn: '2027-06-10',
    checkOut: '2027-06-17',
    rentalPriceMinor: 300000,
    amountDueMinor: 100000,
    remainingBalanceMinor: 200000,
    securityDepositMinor: 50000,
    touristTaxMinor: 0,
    currency: 'EUR',
    paymentDeadline: '2027-05-10',
    cancellationTerms: 'Refundable until 60 days before arrival; non-refundable thereafter.',
    specialConditions: 'No parties.',
    ...overrides,
  };
}
