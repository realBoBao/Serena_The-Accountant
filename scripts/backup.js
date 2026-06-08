/**
 * Disaster Recovery — Phase 13: Automated Backup & Restore
 *
 * Backup:  node scripts/backup.js
 * Restore: node scripts/restore.js <backup-file.tar.gz>
 */

import { spawn } from 'child_process';
import { createReadStream, createWriteStream, mkdirSync, existsSync, readdirSync, statSync } from 'fs';
import { rm, mkdir, readFile, writeFile, access } from 'fs/promises';
import path from 'path';
import { createGzip } from 'zlib';
import { pipeline } from 'stream/promises';

const BACKUP_DIR = path.resolve('./backups');
const DB_FILES = [
  './vectors.db',
  './flashcards.db',
  './memory.db',
  './data.db',
];
const CONFIG_FILES = [
  './.env',
  './ecosystem.config.cjs',
  './package.json',
];
const ARTIFACT_DIRS = [
  './artifacts',
];

// ── Backup ──
export async function createBackup() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupName = `backup-${timestamp}`;
  const backupPath = path.join(BACKUP_DIR, backupName);

  console.log(`[Backup] Creating backup: ${backupName}`);

  await mkdir(backupPath, { recursive: true });

  // Copy database files
  for (const dbFile of DB_FILES) {
    try {
      await access(dbFile);
      const dest = path.join(backupPath, path.basename(dbFile));
      const content = await readFile(dbFile);
      await writeFile(dest, content);
      console.log(`[Backup] ✓ ${dbFile}`);
    } catch {
      console.log(`[Backup] ⊘ ${dbFile} (not found)`);
    }
  }

  // Copy config files
  for (const configFile of CONFIG_FILES) {
    try {
      await access(configFile);
      const dest = path.join(backupPath, path.basename(configFile));
      const content = await readFile(configFile);
      await writeFile(dest, content);
      console.log(`[Backup] ✓ ${configFile}`);
    } catch {
      console.log(`[Backup] ⊘ ${configFile} (not found)`);
    }
  }

  // Copy artifact directories
  for (const dir of ARTIFACT_DIRS) {
    try {
      await access(dir);
      const dest = path.join(backupPath, path.basename(dir));
      await copyDir(dir, dest);
      console.log(`[Backup] ✓ ${dir}/`);
    } catch {
      console.log(`[Backup] ⊘ ${dir}/ (not found)`);
    }
  }

  // Create manifest
  const manifest = {
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    files: readdirSync(backupPath),
  };
  await writeFile(path.join(backupPath, 'manifest.json'), JSON.stringify(manifest, null, 2));

  // Compress
  const tarPath = `${backupPath}.tar.gz`;
  await compressDir(backupPath, tarPath);

  // Remove uncompressed directory
  await rm(backupPath, { recursive: true });

  const stats = statSync(tarPath);
  console.log(`[Backup] ✅ Complete: ${tarPath} (${(stats.size / 1024 / 1024).toFixed(1)} MB)`);

  return tarPath;
}

// ── Restore ──
export async function restoreBackup(backupFile) {
  if (!existsSync(backupFile)) {
    throw new Error(`Backup file not found: ${backupFile}`);
  }

  console.log(`[Restore] Restoring from: ${backupFile}`);

  const tempDir = path.join(BACKUP_DIR, `restore-${Date.now()}`);
  await mkdir(tempDir, { recursive: true });

  // Decompress
  await decompressFile(backupFile, tempDir);

  // Find the backup directory inside temp
  const entries = readdirSync(tempDir);
  const backupDir = entries.length === 1 && statSync(path.join(tempDir, entries(0))).isDirectory()
    ? path.join(tempDir, entries[0])
    : tempDir;

  // Read manifest
  try {
    const manifest = JSON.parse(await readFile(path.join(backupDir, 'manifest.json'), 'utf8'));
    console.log(`[Restore] Backup from: ${manifest.timestamp}`);
  } catch {
    console.log('[Restore] ⚠️  No manifest found, proceeding anyway');
  }

  // Restore database files
  for (const dbFile of DB_FILES) {
    const backupDb = path.join(backupDir, path.basename(dbFile));
    try {
      await access(backupDb);
      const content = await readFile(backupDb);
      await writeFile(dbFile, content);
      console.log(`[Restore] ✓ ${dbFile}`);
    } catch {
      console.log(`[Restore] ⊘ ${path.basename(dbFile)} (not in backup)`);
    }
  }

  // Restore config files
  for (const configFile of CONFIG_FILES) {
    const backupConfig = path.join(backupDir, path.basename(configFile));
    try {
      await access(backupConfig);
      const content = await readFile(backupConfig);
      await writeFile(configFile, content);
      console.log(`[Restore] ✓ ${configFile}`);
    } catch {
      console.log(`[Restore] ⊘ ${path.basename(configFile)} (not in backup)`);
    }
  }

  // Cleanup
  await rm(tempDir, { recursive: true });

  console.log('[Restore] ✅ Complete! Restart services: pm2 restart all');
}

// ── Helpers ──
async function copyDir(src, dest) {
  await mkdir(dest, { recursive: true });
  const entries = readdirSync(src);
  for (const entry of entries) {
    const srcPath = path.join(src, entry);
    const destPath = path.join(dest, entry);
    const stat = statSync(srcPath);
    if (stat.isDirectory()) {
      await copyDir(srcPath, destPath);
    } else {
      const content = await readFile(srcPath);
      await writeFile(destPath, content);
    }
  }
}

async function compressDir(dir, output) {
  return new Promise((resolve, reject) => {
    const tar = spawn('tar', ['-czf', output, '-C', path.dirname(dir), path.basename(dir)], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    tar.stderr.on('data', d => { stderr += d; });
    tar.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`tar failed: ${stderr}`));
    });
  });
}

async function decompressFile(file, dest) {
  return new Promise((resolve, reject) => {
    const tar = spawn('tar', ['-xzf', file, '-C', dest], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    tar.stderr.on('data', d => { stderr += d; });
    tar.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`tar failed: ${stderr}`));
    });
  });
}

// ── CLI ──
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === 'backup' || !command) {
    await createBackup();
  } else if (command === 'restore') {
    const file = args[1];
    if (!file) {
      console.log('Usage: node scripts/restore.js <backup-file.tar.gz>');
      process.exit(1);
    }
    await restoreBackup(file);
  } else if (command === 'list') {
    await mkdir(BACKUP_DIR, { recursive: true });
    const backups = readdirSync(BACKUP_DIR)
      .filter(f => f.endsWith('.tar.gz'))
      .sort()
      .reverse()
      .slice(0, 10);

    if (backups.length === 0) {
      console.log('No backups found.');
    } else {
      console.log('📦 Available backups:');
      for (const b of backups) {
        const stats = statSync(path.join(BACKUP_DIR, b));
        console.log(`  ${b} (${(stats.size / 1024 / 1024).toFixed(1)} MB)`);
      }
    }
  } else {
    console.log('Usage: node scripts/backup.js [backup|restore <file>|list]');
  }
}

const isDirectRun = typeof process.argv[1] === 'string' && process.argv[1].includes('backup.js');
if (isDirectRun) {
  main().catch(err => {
    console.error('[Backup] Error:', err.message);
    process.exit(1);
  });
}
