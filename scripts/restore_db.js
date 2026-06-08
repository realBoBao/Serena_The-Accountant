/**
 * One-Click Database Restore Script
 * Phục hồi toàn bộ dữ liệu từ backup
 * 
 * Usage: node scripts/restore_db.js <backup-name-or-path>
 * Example: node scripts/restore_db.js backup-2026-06-03T03-00-00
 * Example: node scripts/restore_db.js backups/backup-2026-06-03T03-00-00
 */
import { mkdir, readdir, copyFile, rm, access } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BACKUP_DIR = path.join(ROOT, 'backups');

async function listBackups() {
  try {
    const entries = await readdir(BACKUP_DIR, { withFileTypes: true });
    return entries
      .filter(e => e.isDirectory() && e.name.startsWith('backup-'))
      .map(e => e.name)
      .sort()
      .reverse(); // Mới nhất trước
  } catch {
    return [];
  }
}

async function restoreBackup(backupNameOrPath) {
  // Resolve backup path
  let backupPath = backupNameOrPath;
  if (!path.isAbsolute(backupPath)) {
    backupPath = path.join(BACKUP_DIR, backupNameOrPath);
  }

  // Verify backup exists
  try {
    await access(backupPath);
  } catch {
    console.error(`❌ Backup not found: ${backupPath}`);
    const backups = await listBackups();
    if (backups.length > 0) {
      console.log('\nAvailable backups:');
      backups.forEach((b, i) => console.log(`  ${i + 1}. ${b}`));
    } else {
      console.log('\nNo backups found in:', BACKUP_DIR);
    }
    process.exit(1);
  }

  console.log(`[Restore] Restoring from: ${backupPath}`);
  console.log(`[Restore] Target: ${ROOT}`);

  const results = [];

  // Restore files
  const filesToRestore = [
    { src: 'vectors.db', dest: 'vectors.db' },
    { src: 'data.db', dest: 'data.db' },
    { src: 'artifacts/feedback.json', dest: 'artifacts/feedback.json' },
    { src: 'artifacts/weights.json', dest: 'artifacts/weights.json' },
    { src: 'transition_matrix.json', dest: 'transition_matrix.json' },
    { src: 'user_state.json', dest: 'user_state.json' },
  ];

  for (const { src, dest } of filesToRestore) {
    const srcPath = path.join(backupPath, src);
    const destPath = path.join(ROOT, dest);

    try {
      await access(srcPath);
      await mkdir(path.dirname(destPath), { recursive: true });
      await copyFile(srcPath, destPath);
      results.push({ file: dest, status: 'OK' });
      console.log(`  ✓ ${dest}`);
    } catch {
      results.push({ file: dest, status: 'SKIP', reason: 'Not in backup' });
      console.log(`  - ${dest} (not in backup)`);
    }
  }

  // Restore artifacts directory
  const backupArtifacts = path.join(backupPath, 'artifacts');
  try {
    await access(backupArtifacts);
    const destArtifacts = path.join(ROOT, 'artifacts');

    // Remove existing artifacts
    await rm(destArtifacts, { recursive: true, force: true });

    // Copy from backup
    const { spawn } = await import('child_process');
    const isWindows = process.platform === 'win32';

    if (isWindows) {
      await new Promise((resolve, reject) => {
        const proc = spawn('xcopy', [backupArtifacts, destArtifacts + '\\', '/E', '/I', '/Y'], { stdio: 'pipe' });
        proc.on('close', code => code === 0 ? resolve() : reject(new Error(`xcopy exited ${code}`)));
        proc.on('error', reject);
      });
    } else {
      await new Promise((resolve, reject) => {
        const proc = spawn('cp', ['-r', backupArtifacts, destArtifacts], { stdio: 'pipe' });
        proc.on('close', code => code === 0 ? resolve() : reject(new Error(`cp exited ${code}`)));
        proc.on('error', reject);
      });
    }

    results.push({ file: 'artifacts/', status: 'OK' });
    console.log(`  ✓ artifacts/`);
  } catch {
    results.push({ file: 'artifacts/', status: 'SKIP', reason: 'Not in backup' });
    console.log(`  - artifacts/ (not in backup)`);
  }

  const ok = results.filter(r => r.status === 'OK').length;
  const skip = results.filter(r => r.status === 'SKIP').length;
  console.log(`\n✅ Restore completed: ${ok} restored, ${skip} skipped`);
  console.log('⚠️  Restart PM2 services to apply: pm2 restart ecosystem.config.cjs');
}

// Main
const args = process.argv.slice(2);

if (args.length === 0 || args[0] === '--list' || args[0] === '-l') {
  // List available backups
  listBackups().then(backups => {
    if (backups.length === 0) {
      console.log('No backups found in:', BACKUP_DIR);
    } else {
      console.log('Available backups:');
      backups.forEach((b, i) => console.log(`  ${i + 1}. ${b}`));
      console.log('\nUsage: node scripts/restore_db.js <backup-name>');
    }
  });
} else {
  restoreBackup(args[0]);
}
