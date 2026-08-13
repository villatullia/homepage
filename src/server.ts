import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.js';
import { buildApp } from './app.js';
import { runDueJobs } from './services/jobs.js';
import { openDatabase } from './db.js';
import { EmailService } from './services/email.js';
import { createPaymentProvider } from './services/payment.js';

const envPath = path.resolve(process.cwd(), '.env');
if (fs.existsSync(envPath)) process.loadEnvFile(envPath);

const config = loadConfig();
const app = await buildApp({ config });
await app.listen({ host: config.HOST, port: config.PORT });

const jobDb = openDatabase(config);
const jobEmail = new EmailService(jobDb, config);
const jobPaymentProvider = createPaymentProvider(config);
const jobTimer = setInterval(() => {
  void runDueJobs(jobDb, config, jobEmail, jobPaymentProvider).catch((error) => app.log.error({ err: error }, 'Background jobs failed'));
}, 60_000);
jobTimer.unref();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    clearInterval(jobTimer);
    jobDb.close();
    void app.close().finally(() => process.exit(0));
  });
}
