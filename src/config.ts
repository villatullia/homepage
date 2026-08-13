import path from 'node:path';
import { z } from 'zod';

const booleanValue = z
  .string()
  .optional()
  .transform((value) => value === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  APP_BASE_URL: z.string().url().default('http://127.0.0.1:3000'),
  DATABASE_PATH: z.string().default('./data/private/villa.sqlite'),
  STORAGE_PATH: z.string().default('./storage'),
  COOKIE_SECRET: z.string().min(32).default('development-only-secret-change-this-now'),
  OWNER_NAME: z.string().min(1).default('Villa Tullia Owner'),
  OWNER_EMAIL: z.string().email().default('owner@example.com'),
  OWNER_ADDRESS: z.string().min(1).default("Owner's legal address"),
  PROPERTY_LEGAL_NAME: z.string().min(1).default('Villa Tullia'),
  PROPERTY_ADDRESS: z.string().min(1).default("Via placeholder, Padenghe sul Garda, Italy"),
  DEFAULT_CURRENCY: z.string().length(3).default('EUR'),
  SIGNING_HOLD_HOURS: z.coerce.number().int().min(1).max(720).default(72),
  CALENDAR_AVAILABILITY_URL: z.string().url().default('https://villa-calendar-sync.lankaswellproject.workers.dev/availability.json'),
  ICAL_FEED_TOKEN: z.string().default(''),
  SIGNING_PROVIDER: z.enum(['mock', 'documenso']).default('mock'),
  DOCUMENSO_BASE_URL: z.string().url().default('http://documenso:3000/api/v2'),
  DOCUMENSO_API_TOKEN: z.string().default(''),
  DOCUMENSO_WEBHOOK_SECRET: z.string().default(''),
  PAYMENT_PROVIDER: z.enum(['mock', 'stripe']).default('mock'),
  STRIPE_SECRET_KEY: z.string().default(''),
  STRIPE_WEBHOOK_SECRET: z.string().default(''),
  EMAIL_PROVIDER: z.enum(['preview', 'smtp']).default('preview'),
  EMAIL_FROM: z.string().default('Villa Tullia <bookings@example.com>'),
  SMTP_HOST: z.string().default('127.0.0.1'),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(1025),
  SMTP_SECURE: booleanValue,
  SMTP_USER: z.string().default(''),
  SMTP_PASSWORD: z.string().default(''),
});

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(overrides: Record<string, string | undefined> = {}) {
  const values = schema.parse({ ...process.env, ...overrides });
  const root = process.cwd();
  return {
    ...values,
    databasePath: path.resolve(root, values.DATABASE_PATH),
    storagePath: path.resolve(root, values.STORAGE_PATH),
    secureCookies: values.NODE_ENV === 'production',
    isProduction: values.NODE_ENV === 'production',
  };
}
