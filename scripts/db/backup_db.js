/**
 * Automated Database Backup Script
 * Chạy hàng tuần (3:00 AM Chủ Nhật) để snapshot toàn bộ dữ liệu
 * 
 * Usage: node scripts/backup_db.js
 * Cron: 0 3 * * 0 (3:00 AM every Sunday)
 */
import { spawn } from 'child_process';
import { mkdir, readdir, stat, copyFile, rm } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BACKUP_DIR = path.join(ROOT, 'backups');
const MAX_BACKUPS = 4 // Giữ tối đa 4 backup (4 tuần)

// Các file/thư mục cần backup
const BACKUP_SOURCES = [
  { type: 'file', path: 'vectors.db', desc: 'Vector store (SQLite)' },
  { type: 'file', path: 'data.db', desc: 'Processed tracking DB' },
  { type: 'file', path: 'artifacts/feedback.json', desc: 'User feedback' },
  { type: 'file', path: 'artifacts/weights.json', desc: 'Learning weights' },
  { type: 'file', path: 'transition_matrix.json', desc: 'Markov transition matrix' },
  { type: 'file', path: 'user_state.json', desc: 'User state' },
  { type: 'dir', path: 'artifacts', desc: 'All artifacts (reports, summaries)' },
];

async function ensureDir(dir) {
  await mkdir(dir, { recursive: true });
}

async function getDirSize(dirPath) {
  try {
    const files = await readdir(dirPath, { recursive: true, withFileTypes: true });
    let total = 0;
    for (const f of files) {
      if (f.isFile()) {
        const s = await stat(path.join(f.parentPath || dirPath, f.name));
        total += s.size;
      }
    }
    return total;
  } catch {
    return 0;
  }
}

async function cleanupOldBackups() {
  try {
    const entries = await readdir(BACKUP_DIR, { withFileTypes: true });
    const dirs = entries
      .filter(e => e.isDirectory() && e.name.startsWith('backup-'))
      .map(e => ({ name: e.name, path: path.join(BACKUP_DIR, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));

    // Xóa backup cũ nhất nếu vượt MAX_BACKUPS
    while (dirs.length >= MAX_BACKUPS) {
      const oldest = dirs.shift();
      console.log(`[Backup] Removing old backup: ${oldest.name}`);
      await rm(oldest.path, { recursive: true, force: true });
    }
  } catch (err) {
    console.warn('[Backup] Cleanup failed:', err.message);
  }
}

async function runBackup() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupName = `backup-${timestamp}`;
  const backupPath = path.join(BACKUP_DIR, backupName);

  console.log(`[Backup] Starting backup: ${backupName}`);
  console.log(`[Backup] Destination: ${backupPath}`);

  await ensureDir(backupPath);
  await ensureDir(path.join(backupPath, 'artifacts'));

  const results = [];

  for (const source of BACKUP_SOURCES) {
    const srcPath = path.join(ROOT, source.path);

    try {
      if (source.type === 'file') {
        const destPath = path.join(backupPath, path.basename(source.path));
        await copyFile(srcPath, destPath);
        const s = await stat(destPath);
        results.push({ name: source.desc, status: 'OK', size: `${(s.size / 1024).toFixed(1)}KB` });
        console.log(`  ✓ ${source.desc} (${(s.size / 1024).toFixed(1)}KB)`);
      } else if (source.type === 'dir') {
        // Copy directory recursively using xcopy (Windows) or cp (Unix)
        const destDir = path.join(backupPath, 'artifacts');
        const isWindows = process.platform === 'win32';

        if (isWindows) {
          await new Promise((resolve, reject) => {
            const proc = spawn('xcopy', [srcPath, destDir + '\\', '/E', '/I', '/Y'], { stdio: 'pipe' });
            proc.on('close', code => code === 0 ? resolve() : reject(new Error(`xcopy exited ${code}`)));
            proc.on('error', reject);
          });
        } else {
          await new Promise((resolve, reject) => {
            const proc = spawn('cp', ['-r', srcPath, destDir], { stdio: 'pipe' });
            proc.on('close', code => code === 0 ? resolve() : reject(new Error(`cp exited ${code}`)));
            proc.on('error', reject);
          });
        }

        const size = await getDirSize(destDir);
        results.push({ name: source.desc, status: 'OK', size: `${(size / 1024).toFixed(1)}KB` });
        console.log(`  ✓ ${source.desc} (${(size / 1024).toFixed(1)}KB)`);
      }
    } catch (err) {
      results.push({ name: source.desc, status: 'FAIL', error: err.message });
      console.log(`  ✗ ${source.desc}: ${err.message}`);
    }
  }

  // Cleanup old backups
  await cleanupOldBackups();

  // Summary
  const totalSize = await getDirSize(backupPath);
  console.log(`\n[Backup] Completed: ${backupName}`);
  console.log(`[Backup] Total size: ${(totalSize / 1024).toFixed(1)}KB`);
  console.log(`[Backup] Files: ${results.filter(r => r.status === 'OK').length}/${results.length} OK`);

  return { backupName, backupPath, results, totalSize };
}

// Export for scheduler import
export { runBackup };

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runBackup()
  .then(r => {
    console.log(`\n✅ Backup saved to: ${r.backupPath}`);
    process.exit(0);
  })
  .catch(err => {
    console.error('❌ Backup failed:', err);
    process.exit(1);
  });
}
