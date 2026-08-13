import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db.js';

const config = loadConfig();
const backupDirectory = path.resolve(process.env.BACKUP_PATH ?? './backups');
fs.mkdirSync(backupDirectory, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const target = path.join(backupDirectory, `villa-${stamp}.sqlite`);
const db = openDatabase(config);
try {
  db.exec('PRAGMA wal_checkpoint(FULL)');
  db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
} finally {
  db.close();
}
console.log(target);
