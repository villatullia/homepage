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

    const home = await app.inject({ method: 'GET', url: '/' });
    expect(home.statusCode).toBe(200);
    expect(home.body).toContain('data-villa-chat-open');
    expect(home.body).toContain('/chat-widget.js?v=20260929');
    expect((await app.inject({ method: 'GET', url: '/chat-widget.js' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/chat-widget.css' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/privacy.html' })).statusCode).toBe(200);
    const german = await app.inject({ method: 'GET', url: '/de/' });
    expect(german.statusCode).toBe(200);
    expect(german.body).toContain('<html lang="de"');
    expect(german.body).toContain('Villa in Padenghe nahe Sirmione');
    expect(german.body).toContain('Eine Ferienvilla nahe Sirmione, Desenzano, Moniga und Lonato.');
    expect(german.body).toContain('"inLanguage":"de"');
    expect(german.body).toContain('"@type":"LocationFeatureSpecification"');
    expect(german.body).toContain('rel="canonical" href="https://villatullia.it/de/"');
    expect(german.body).toContain('hreflang="it" href="https://villatullia.it/it/"');
    const englishAvailability = await app.inject({ method: 'GET', url: '/calendarw.html' });
    expect(englishAvailability.statusCode).toBe(200);
    expect(englishAvailability.body).toContain('This is the week you chose.');
    expect(englishAvailability.body).toContain('For the entire villa');
    expect(englishAvailability.body).toContain('No mandatory charges on arrival');
    expect(englishAvailability.body).toContain('Ask about this week — no payment');
    expect(englishAvailability.body).toContain('Non-binding · No payment now');
    expect(englishAvailability.body).not.toContain('A personal reply from Alex Pellegrini');
    expect(englishAvailability.body).not.toContain('Veronika · Czech Republic · Verified Booking.com guest');
    expect(englishAvailability.body).toContain('ALL INCLUSIVE');
    expect(englishAvailability.body).toContain('openAmenitiesFromEnquiry');
    expect(englishAvailability.body).not.toContain('Recommended');
    expect(englishAvailability.body).not.toContain('No contact details required. Ask your question and receive Alex’s reply here.');
    expect(englishAvailability.body).toContain('Let’s make it happen');
    const chatWidget = (await app.inject({ method: 'GET', url: '/chat-widget.js' })).body;
    expect(chatWidget).toContain('He usually replies in less than one minute.');
    expect(chatWidget).toContain("fetch('/api/chat/interests'");
    expect(englishAvailability.body.indexOf('id="flowBack"')).toBeLessThan(englishAvailability.body.indexOf('class="flow-window"'));
    expect(englishAvailability.body).not.toContain('id="backToYears"');
    expect(englishAvailability.body).not.toContain('id="backToMonths"');
    expect(englishAvailability.body.indexOf('class="contact-primary"')).toBeLessThan(englishAvailability.body.indexOf('id="emailEnquiry"'));
    expect(englishAvailability.body).toContain('Email or WhatsApp instead');
    expect(englishAvailability.body).not.toContain('id="syncStatus"');
    expect(englishAvailability.body).not.toContain('Live calendar checked');
    expect(englishAvailability.body).toContain("selectedWeek:week.textContent");
    expect((await app.inject({ method: 'GET', url: '/imgs/Foto/alex-pellegrini.png' })).statusCode).toBe(200);
    expect(englishAvailability.body).not.toContain('We answer within 30 minutes.');
    expect(englishAvailability.body).not.toContain('end - oneDay');
    expect(englishAvailability.body).toContain('formatDate(week.end)');
    expect(englishAvailability.body).toContain('formatDate(selectedWeek.end)');
    const germanAvailability = await app.inject({ method: 'GET', url: '/de/verfuegbarkeit/' });
    expect(germanAvailability.body).toContain('Diese Woche anfragen — keine Zahlung');
    expect(germanAvailability.body).toContain('Für die gesamte Villa');
    expect(germanAvailability.body).toContain('Machen wir es möglich');
    expect(germanAvailability.body).toContain('Lieber E-Mail oder WhatsApp');
    expect(germanAvailability.body).toContain('Sparen Sie 530–913 € pro Woche.');
    expect(germanAvailability.body).toContain("'Woche ändern'");
    const italianAvailability = await app.inject({ method: 'GET', url: '/it/disponibilita/' });
    expect(italianAvailability.statusCode).toBe(200);
    expect(italianAvailability.body).toContain('<html lang="it"');
    expect(italianAvailability.body).toContain('Scegli la tua settimana sul Garda.');
    expect(italianAvailability.body).toContain('Chiedi informazioni per questa settimana — nessun pagamento');
    expect(italianAvailability.body).toContain('Facciamolo');
    expect(italianAvailability.body).toContain("new Intl.DateTimeFormat('it-IT'");
    const dutchAvailability = await app.inject({ method: 'GET', url: '/nl/beschikbaarheid/' });
    expect(dutchAvailability.body).toContain('Vraag naar deze week — nu niet betalen');
    expect(dutchAvailability.body).toContain('Voor de hele villa');
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

  it('serves the unlisted booking-process prototype', async () => {
    const context = createTestContext();
    const app = await buildApp({ config: context.config, db: context.db, logger: false });
    cleanup.push(async () => {
      await app.close();
      context.close();
    });
    const response = await app.inject({ method: 'GET', url: '/booking-process-test.html' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('Booking process prototype');
    expect(response.body).toContain('Prototype only');
  });

  it('serves the unlisted anonymous chat prototype', async () => {
    const context = createTestContext();
    const app = await buildApp({ config: context.config, db: context.db, logger: false });
    cleanup.push(async () => {
      await app.close();
      context.close();
    });
    const response = await app.inject({ method: 'GET', url: '/chat-test.html' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('Anonymous website chat');
    expect(response.body).toContain('No contact details required');
    expect(response.body).toContain('Simulate Alex replying');
    expect(response.body).toContain('Messages are saved locally · Telegram is not connected yet');
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
    const rates = response.json().directRates as Array<{ start: string; end: string; weeklyPrice: number; bookingComPrice?: number; currency: string }>;
    expect(rates).toHaveLength(21);
    const previousPrices = [3675, 3675, 4113, 4375, 4375, 4375, 4638, 4900, 4900, 4900, 4900, 5075, 5338, 5338, 5075, 4638, 4113, 4113, 3675, 3238, 2975];
    expect(rates.map((rate) => rate.weeklyPrice)).toEqual(previousPrices.map((price) => Math.round(price * 0.95)));
    expect(rates[0]).toEqual({ start: '2027-05-15', end: '2027-05-22', weeklyPrice: 3491, bookingComPrice: 4134, currency: 'EUR' });
    expect(rates.at(-1)).toEqual({ start: '2027-10-02', end: '2027-10-09', weeklyPrice: 2826, bookingComPrice: 3518, currency: 'EUR' });
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
