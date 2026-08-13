import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db.js';
import { hashPassword } from '../src/lib/crypto.js';
import { nowIso } from '../src/lib/format.js';

const envPath = path.resolve(process.cwd(), '.env');
if (fs.existsSync(envPath)) process.loadEnvFile(envPath);
const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
const password = process.env.ADMIN_PASSWORD ?? '';
const displayName = process.env.ADMIN_NAME?.trim() || 'Villa Tullia Administrator';
if (!email?.includes('@') || password.length < 12) {
  throw new Error('Set ADMIN_EMAIL and ADMIN_PASSWORD (at least 12 characters) for this one command.');
}
const db = openDatabase(loadConfig());
const timestamp = nowIso();
db.prepare(`
  INSERT INTO administrators (id, email, display_name, password_hash, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(email) DO UPDATE SET display_name = excluded.display_name, password_hash = excluded.password_hash,
    active = 1, updated_at = excluded.updated_at
`).run(randomUUID(), email, displayName, await hashPassword(password), timestamp, timestamp);
db.close();
console.log(`Administrator ready: ${email}`);
