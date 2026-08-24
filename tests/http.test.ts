import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { acquireDateHold } from '../src/db.js';
import { createBooking } from '../src/services/booking.js';
import { createTestContext } from './helpers.js';
import { validBooking } from './helpers.js';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  vi.unstubAllGlobals();
});

describe('public HTTP surface', () => {
  it('serves the site and accepts a valid enquiry without exposing private files', async () => {
    const context = createTestContext();
    const app = await buildApp({ config: context.config, db: context.db, logger: false });
    cleanup.push(async () => {
      await app.close();
      context.close();
    });

    expect((await app.inject({ method: 'GET', url: '/' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/privacy.html' })).statusCode).toBe(200);
    const german = await app.inject({ method: 'GET', url: '/de/' });
    expect(german.statusCode).toBe(200);
    expect(german.body).toContain('<html lang="de"');
    expect(german.body).toContain('Ferienvilla am Gardasee für 8 Personen');
    expect(german.body).toContain('rel="canonical" href="https://villatullia.it/de/"');
    expect(german.body).toContain('hreflang="it" href="https://villatullia.it/it/"');
    const italianAvailability = await app.inject({ method: 'GET', url: '/it/disponibilita/' });
    expect(italianAvailability.statusCode).toBe(200);
    expect(italianAvailability.body).toContain('<html lang="it"');
    expect(italianAvailability.body).toContain('Scegli la tua settimana sul Garda.');
    expect(italianAvailability.body).toContain("new Intl.DateTimeFormat('it-IT'");
    expect((await app.inject({ method: 'GET', url: '/favicon.svg' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/.env.example' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/src/config.ts' })).statusCode).toBe(404);

    const response = await app.inject({
      method: 'POST',
      url: '/api/enquiries',
      payload: {
        name: 'Ada Lovelace',
        email: 'ada@example.test',
        phone: '+39 333 123 4567',
        message: 'Please let me know if these dates are available.',
        checkIn: '2027-06-10',
        checkOut: '2027-06-17',
        guestsCount: 2,
        website: '',
      },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ ok: true });
    expect((context.db.prepare('SELECT COUNT(*) AS count FROM enquiries').get() as { count: number }).count).toBe(1);
    expect(
      context.db.prepare("SELECT recipient, status FROM email_deliveries WHERE template_key = 'enquiry-notification'").get(),
    ).toEqual({ recipient: context.config.OWNER_EMAIL, status: 'PREVIEWED' });
  });

  it('exports active date blocks as a private iCal feed without guest data', async () => {
    const context = createTestContext();
    const { booking } = createBooking(context.db, context.config, validBooking());
    acquireDateHold(context.db, booking, 72);
    const app = await buildApp({ config: context.config, db: context.db, logger: false });
    cleanup.push(async () => {
      await app.close();
      context.close();
    });

    expect((await app.inject({ method: 'GET', url: '/calendar/wrong-token/villa-tullia.ics' })).statusCode).toBe(404);
    const response = await app.inject({
      method: 'GET',
      url: `/calendar/${context.config.ICAL_FEED_TOKEN}/villa-tullia.ics`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/calendar');
    expect(response.body).toContain('DTSTART;VALUE=DATE:20270610');
    expect(response.body).toContain('DTEND;VALUE=DATE:20270617');
    expect(response.body).toContain('SUMMARY:Villa Tullia - Unavailable');
    expect(response.body).not.toContain('Ada Lovelace');
    expect(response.body).not.toContain(booking.reference);
  });

  it('exports manually closed weeks and removes them after reopening', async () => {
    const context = createTestContext();
    context.db.prepare(`
      INSERT INTO manual_week_blocks
        (id, property_id, check_in, check_out, note, created_at, updated_at)
      VALUES ('owner-week', 'villa-tullia', '2027-08-07', '2027-08-14', 'Owner stay', '2026-08-24', '2026-08-24')
    `).run();
    const app = await buildApp({ config: context.config, db: context.db, logger: false });
    cleanup.push(async () => {
      await app.close();
      context.close();
    });

    const url = `/calendar/${context.config.ICAL_FEED_TOKEN}/villa-tullia.ics`;
    const closed = await app.inject({ method: 'GET', url });
    expect(closed.body).toContain('DTSTART;VALUE=DATE:20270807');
    expect(closed.body).toContain('DTEND;VALUE=DATE:20270814');
    expect(closed.body).not.toContain('Owner stay');

    context.db.prepare("UPDATE manual_week_blocks SET released_at = '2026-08-25', updated_at = '2026-08-25' WHERE id = 'owner-week'").run();
    const reopened = await app.inject({ method: 'GET', url });
    expect(reopened.body).not.toContain('DTSTART;VALUE=DATE:20270807');
  });

  it('publishes 2027 direct rates separately from partner and local calendar blocks', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      lastUpdated: '2026-08-17T10:00:00Z',
      blockedRanges: [{ start: '2027-01-01', end: '2029-01-01' }],
    }), { status: 200 })));
    const context = createTestContext();
    const { booking } = createBooking(context.db, context.config, validBooking());
    acquireDateHold(context.db, booking, 72);
    const app = await buildApp({ config: context.config, db: context.db, logger: false });
    cleanup.push(async () => {
      await app.close();
      context.close();
    });

    const response = await app.inject({ method: 'GET', url: '/api/availability' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      partnerBlockedRanges: [{ start: '2027-01-01', end: '2029-01-01' }],
      localBlockedRanges: [{ start: '2027-06-10', end: '2027-06-17' }],
    });
    const rates = response.json().directRates as Array<{ start: string; end: string; weeklyPrice: number; currency: string }>;
    expect(rates).toHaveLength(21);
    expect(rates[0]).toEqual({ start: '2027-05-15', end: '2027-05-22', weeklyPrice: 4200, currency: 'EUR' });
    expect(rates.at(-1)).toEqual({ start: '2027-10-02', end: '2027-10-09', weeklyPrice: 3400, currency: 'EUR' });
  });

  it('silently discards honeypot submissions', async () => {
    const context = createTestContext();
    const app = await buildApp({ config: context.config, db: context.db, logger: false });
    cleanup.push(async () => {
      await app.close();
      context.close();
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/enquiries',
      payload: {
        name: 'Spam Bot',
        email: 'bot@example.test',
        message: 'Buy things now',
        website: 'https://spam.example',
      },
    });
    expect(response.statusCode).toBe(202);
    expect((context.db.prepare('SELECT COUNT(*) AS count FROM enquiries').get() as { count: number }).count).toBe(0);
  });
});
