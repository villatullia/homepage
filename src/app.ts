import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import staticPlugin from '@fastify/static';
import view from '@fastify/view';
import rawBody from 'fastify-raw-body';
import nunjucks from 'nunjucks';
import type { AppConfig } from './config.js';
import { loadConfig } from './config.js';
import { openDatabase, type Database } from './db.js';
import { createSignatureProvider } from './services/signature.js';
import { createPaymentProvider } from './services/payment.js';
import { EmailService } from './services/email.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerPublicRoutes } from './routes/public.js';
import { registerWebhookRoutes } from './routes/webhooks.js';
import { localizedPublicPage, type PublicLocale } from './public-localization.js';

export interface BuildAppOptions {
  config?: AppConfig;
  db?: Database;
  logger?: boolean;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const config = options.config ?? loadConfig();
  const db = options.db ?? openDatabase(config);
  const app = Fastify({ logger: options.logger ?? config.NODE_ENV !== 'test', trustProxy: config.isProduction ? 1 : false, bodyLimit: 128 * 1024 });

  await app.register(cookie, { secret: config.COOKIE_SECRET });
  await app.register(formbody);
  await app.register(rateLimit, { max: 240, timeWindow: '1 minute' });
  await app.register(rawBody, { field: 'rawBody', global: false, encoding: false, runFirst: true });
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net', 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://cdn.jsdelivr.net', 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:'],
        frameSrc: ['https://www.google.com', 'https://player.twitch.tv'],
        connectSrc: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  });
  await app.register(view, {
    engine: { nunjucks },
    root: path.resolve(process.cwd(), 'src/views'),
    options: { autoescape: true, noCache: config.NODE_ENV !== 'production' },
  });
  await app.register(staticPlugin, {
    root: process.cwd(),
    prefix: '/',
    index: ['index.html'],
    serveDotFiles: false,
    allowedPath(pathName) {
      const normalized = pathName.replace(/^[/\\]+/, '').replace(/\\/g, '/');
      return (
        ['index.html', 'calendarw.html', 'privacy.html', 'robots.txt', 'sitemap.xml', 'favicon.svg', 'testcam.html', 'CNAME', 'guide/things-to-do-padenghe-sul-garda/index.html'].includes(normalized) ||
        normalized.startsWith('imgs/Foto/') ||
        normalized === 'imgs/flowers.jpg' || normalized === 'cro.js'
      );
    },
    setHeaders(response, filePath) {
      if (filePath.endsWith('.html')) response.header('Cache-Control', 'no-cache');
      else response.header('Cache-Control', 'public, max-age=604800, immutable');
    },
  });
  app.get('/', async (_request, reply) => reply.sendFile('index.html'));
  app.get('/guide/things-to-do-padenghe-sul-garda', async (_request, reply) => reply.redirect('/guide/things-to-do-padenghe-sul-garda/'));
  app.get('/guide/things-to-do-padenghe-sul-garda/', async (_request, reply) => reply.sendFile('guide/things-to-do-padenghe-sul-garda/index.html'));
  const localizedRoute = (url: string, file: 'index.html' | 'calendarw.html' | 'privacy.html', locale: PublicLocale) => {
    app.get(url, async (_request, reply) => reply.type('text/html; charset=utf-8').header('Cache-Control', 'no-cache').send(localizedPublicPage(file, locale)));
  };
  app.get('/de', async (_request, reply) => reply.redirect('/de/'));
  app.get('/it', async (_request, reply) => reply.redirect('/it/'));
  app.get('/nl', async (_request, reply) => reply.redirect('/nl/'));
  localizedRoute('/de/', 'index.html', 'de');
  localizedRoute('/it/', 'index.html', 'it');
  localizedRoute('/nl/', 'index.html', 'nl');
  localizedRoute('/de/verfuegbarkeit/', 'calendarw.html', 'de');
  localizedRoute('/it/disponibilita/', 'calendarw.html', 'it');
  localizedRoute('/nl/beschikbaarheid/', 'calendarw.html', 'nl');
  localizedRoute('/de/datenschutz/', 'privacy.html', 'de');
  localizedRoute('/it/privacy/', 'privacy.html', 'it');
  localizedRoute('/nl/privacy/', 'privacy.html', 'nl');
  app.get('/healthz', async (_request, reply) => reply.header('Cache-Control', 'no-store').send({ ok: true }));

  const signatureProvider = createSignatureProvider(config);
  const paymentProvider = createPaymentProvider(config);
  const email = new EmailService(db, config);
  const dependencies = { db, config, signatureProvider, paymentProvider, email };
  await registerPublicRoutes(app, dependencies);
  await registerAdminRoutes(app, dependencies);
  await registerWebhookRoutes(app, dependencies);

  app.setErrorHandler(async (error, request, reply) => {
    request.log.error({ err: error }, 'Request failed');
    const failure = error as Error & { statusCode?: number; expose?: boolean };
    const statusCode = failure.statusCode && failure.statusCode >= 400 && failure.statusCode < 600 ? failure.statusCode : 500;
    if (request.url.startsWith('/api/') || request.url.startsWith('/webhooks/')) {
      return reply.code(statusCode).send({ error: statusCode >= 500 ? 'Internal server error' : failure.message });
    }
    if (request.url.startsWith('/admin')) {
      return reply.code(statusCode).view('error.njk', {
        title: statusCode >= 500 ? 'Unexpected error' : 'Action could not be completed',
        message:
          statusCode >= 500 && config.isProduction && !failure.expose ? 'Please try again or check the server log.' : failure.message,
      });
    }
    return reply.code(statusCode).view('guest-error.njk', { title: 'Request could not be completed' });
  });

  app.addHook('onClose', async () => {
    if (!options.db) db.close();
  });
  return app;
}
