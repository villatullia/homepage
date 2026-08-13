import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db.js';
import { EmailService } from '../src/services/email.js';
import { runDueJobs } from '../src/services/jobs.js';

const envPath = path.resolve(process.cwd(), '.env');
if (fs.existsSync(envPath)) process.loadEnvFile(envPath);
const config = loadConfig();
const db = openDatabase(config);
const result = await runDueJobs(db, config, new EmailService(db, config));
db.close();
console.log(JSON.stringify(result));
