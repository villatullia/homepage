import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { AppConfig } from './config.js';
import { nowIso, addHoursEpoch } from './lib/format.js';
import { sha256, randomToken } from './lib/crypto.js';
import type { Administrator, BookingRow } from './types.js';
import type { BookingStatus } from './domain/status.js';
import { assertTransition } from './domain/status.js';

export type Database = DatabaseSync;

export function openDatabase(config: AppConfig): Database {
  fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });
  const db = new DatabaseSync(config.databasePath);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  migrate(db);
  seedProperty(db, config);
  seedAgreementTemplate(db);
  return db;
}

export function migrate(db: Database): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const migrationDir = path.resolve(process.cwd(), 'migrations');
  if (!fs.existsSync(migrationDir)) return;
  const applied = db.prepare('SELECT 1 FROM schema_migrations WHERE name = ?');
  for (const name of fs.readdirSync(migrationDir).filter((file) => file.endsWith('.sql')).sort()) {
    if (applied.get(name)) continue;
    const sql = fs.readFileSync(path.join(migrationDir, name), 'utf8');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(name, nowIso());
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}

function seedProperty(db: Database, config: AppConfig): void {
  db.prepare(`
    INSERT INTO properties (id, name, legal_name, address, timezone, created_at)
    VALUES ('villa-tullia', 'Villa Tullia', ?, ?, 'Europe/Rome', ?)
    ON CONFLICT(id) DO UPDATE SET legal_name = excluded.legal_name, address = excluded.address
  `).run(config.PROPERTY_LEGAL_NAME, config.PROPERTY_ADDRESS, nowIso());
}

function seedAgreementTemplate(db: Database): void {
  const templatePath = path.resolve(process.cwd(), 'templates/agreements/v1.hbs');
  if (!fs.existsSync(templatePath)) return;
  const body = fs.readFileSync(templatePath, 'utf8');
  const hash = sha256(body);
  db.prepare(`
    INSERT INTO agreement_templates (id, version, name, body_template, content_hash, active, created_at)
    VALUES ('villa-rental-v1', '1.0.0', 'Villa Tullia Rental Agreement', ?, ?, 1, ?)
    ON CONFLICT(version) DO NOTHING
  `).run(body, hash, nowIso());
}

export function withImmediateTransaction<T>(db: Database, work: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function createSession(
  db: Database,
  administrator: Administrator,
  metadata: { ipHash?: string; userAgent?: string },
): { token: string; csrfToken: string; expiresAt: number } {
  const token = randomToken();
  const csrfToken = randomToken(24);
  const expiresAt = addHoursEpoch(12);
  db.prepare(`
    INSERT INTO admin_sessions
      (id, administrator_id, token_hash, csrf_token, expires_at, created_at, last_seen_at, ip_hash, user_agent)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    randomUUID(),
    administrator.id,
    sha256(token),
    csrfToken,
    expiresAt,
    nowIso(),
    nowIso(),
    metadata.ipHash ?? null,
    metadata.userAgent?.slice(0, 500) ?? null,
  );
  return { token, csrfToken, expiresAt };
}

export function getSessionAdministrator(
  db: Database,
  token: string | undefined,
): (Administrator & { csrf_token: string; session_id: string }) | undefined {
  if (!token) return undefined;
  db.prepare('DELETE FROM admin_sessions WHERE expires_at <= unixepoch()').run();
  return db.prepare(`
    SELECT a.id, a.email, a.display_name, s.csrf_token, s.id AS session_id
    FROM admin_sessions s
    JOIN administrators a ON a.id = s.administrator_id
    WHERE s.token_hash = ? AND s.expires_at > unixepoch() AND a.active = 1
  `).get(sha256(token)) as (Administrator & { csrf_token: string; session_id: string }) | undefined;
}

export function nextBookingReference(db: Database, year: number): string {
  db.prepare(`
    INSERT INTO booking_reference_sequences (year, next_value) VALUES (?, 2)
    ON CONFLICT(year) DO UPDATE SET next_value = next_value + 1
  `).run(year);
  const row = db.prepare('SELECT next_value - 1 AS value FROM booking_reference_sequences WHERE year = ?').get(year) as { value: number };
  return `VILLA-${year}-${String(row.value).padStart(3, '0')}`;
}

export function transitionBooking(
  db: Database,
  bookingId: string,
  to: BookingStatus,
  actor: { type: string; id?: string },
  eventType: string,
  details: Record<string, unknown> = {},
): void {
  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId) as BookingRow | undefined;
  if (!booking) throw new Error('Booking not found');
  assertTransition(booking.status, to);
  const timestamp = nowIso();
  const confirmedAt = to === 'CONFIRMED' ? timestamp : booking.confirmed_at;
  const cancelledAt = to === 'CANCELLED' ? timestamp : booking.cancelled_at;
  const update = db.prepare(`
    UPDATE bookings
    SET status = ?, version = version + 1, updated_at = ?, confirmed_at = ?, cancelled_at = ?
    WHERE id = ? AND version = ?
  `).run(to, timestamp, confirmedAt, cancelledAt, bookingId, booking.version);
  if (update.changes !== 1) throw new Error('Booking was modified concurrently');
  db.prepare(`
    INSERT INTO booking_events
      (id, booking_id, actor_type, actor_id, event_type, from_status, to_status, details_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    randomUUID(),
    bookingId,
    actor.type,
    actor.id ?? null,
    eventType,
    booking.status,
    to,
    JSON.stringify(details),
    timestamp,
  );
}

export function acquireDateHold(db: Database, booking: BookingRow, hours: number): void {
  const timestamp = nowIso();
  db.prepare(`
    UPDATE date_blocks SET released_at = ?, release_reason = 'superseded', updated_at = ?
    WHERE booking_id = ? AND released_at IS NULL
  `).run(timestamp, timestamp, booking.id);
  db.prepare(`
    INSERT INTO date_blocks
      (id, property_id, booking_id, check_in, check_out, kind, expires_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'HOLD', ?, ?, ?)
    ON CONFLICT(booking_id) DO UPDATE SET
      property_id = excluded.property_id,
      check_in = excluded.check_in,
      check_out = excluded.check_out,
      kind = 'HOLD',
      expires_at = excluded.expires_at,
      released_at = NULL,
      release_reason = NULL,
      updated_at = excluded.updated_at
  `).run(
    randomUUID(),
    booking.property_id,
    booking.id,
    booking.check_in,
    booking.check_out,
    addHoursEpoch(hours),
    timestamp,
    timestamp,
  );
}

export function confirmDateBlock(db: Database, bookingId: string): void {
  const result = db.prepare(`
    UPDATE date_blocks SET kind = 'CONFIRMED', expires_at = NULL, updated_at = ?
    WHERE booking_id = ? AND released_at IS NULL
  `).run(nowIso(), bookingId);
  if (result.changes !== 1) throw new Error('Active date hold not found');
}

export function releaseDateBlock(db: Database, bookingId: string, reason: string): void {
  db.prepare(`
    UPDATE date_blocks SET released_at = ?, release_reason = ?, updated_at = ?
    WHERE booking_id = ? AND released_at IS NULL
  `).run(nowIso(), reason, nowIso(), bookingId);
}
