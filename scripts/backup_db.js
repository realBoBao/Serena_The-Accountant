#!/usr/bin/env node
/**
 * scripts/backup_db.js — Backup SQLite database
 * Usage: node scripts/backup_db.js
 */

import { createReadStream, createWriteStream, existsSync } from 'fs';
import { mkdir } from 'fs/promises';
import path from 'path';

const DB_PATH = process.env.DB_PATH || './data.db';
const BACKUP_DIR = './backups';

async function backup() {
  if (!existsSync(DB_PATH)) {
    console.log('[Backup] DB file not found, skipping');
    return { skipped: true };
  }

  await mkdir(BACKUP_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(BACKUP_DIR, `vectors-${timestamp}.db`);

  // Simple file copy for SQLite backup
  const src = createReadStream(DB_PATH);
  const dst = createWriteStream(backupPath);

  return new Promise((resolve, reject) => {
    src.pipe(dst);
    dst.on('finish', () => {
      console.log(`[Backup] OK: ${backupPath}`);
      resolve({ success: true, path: backupPath });
    });
    dst.on('error', reject);
  });
}

backup().catch(err => {
  console.error('[Backup] Failed:', err.message);
  process.exit(1);
});
