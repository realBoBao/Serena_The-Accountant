/**
 * scripts/test_scheduler.js — Test scheduler catch-up logic
 * Chạy catch-up check ngay mà không cần đợi cron.
 *
 * Usage:
 *   node scripts/test_scheduler.js [--run-pipeline] [--run-memory] [--run-backup]
 *
 * Mặc định: chỉ check xem job nào bị missed, KHÔNG chạy thật.
 * Thêm flag để chạy thật từng job.
 */

import 'dotenv/config';
import { spawn } from 'child_process';
import fs from 'fs';

const CATCH_UP_FILE = './.scheduler_last_run.json';

function readLastRuns() {
  try {
    if (!fs.existsSync(CATCH_UP_FILE)) return {};
    return JSON.parse(fs.readFileSync(CATCH_UP_FILE, 'utf8'));
  } catch { return {}; }
}

function parseLastRun(entry) {
  if (!entry) return null;
  if (typeof entry === 'string') return { ts: new Date(entry), status: 'done' };
  return { ts: new Date(entry.ts), status: entry.status || 'done' };
}

function hoursSince(date) {
  if (!date) return null;
  const h = (Date.now() - new Date(date).getTime()) / 3600000;
  return h > 0 ? h : 0;
}

const args = process.argv.slice(2);
const shouldRun = {
  pipeline: args.includes('--run-pipeline'),
  memory: args.includes('--run-memory'),
  backup: args.includes('--run-backup'),
};

const lastRuns = readLastRuns();
const now = new Date();

const jobs = [
  { name: 'Pipeline', key: 'pipeline', hours: hoursSince(parseLastRun(lastRuns.pipeline)?.ts), threshold: 12 },
  { name: 'Memory', key: 'memory', hours: hoursSince(parseLastRun(lastRuns.memory)?.ts), threshold: 24 },
  { name: 'Backup', key: 'backup', hours: hoursSince(parseLastRun(lastRuns.backup)?.ts), threshold: 168 },
  { name: 'Evo', key: 'evo', hours: hoursSince(parseLastRun(lastRuns.evo)?.ts), threshold: 24 },
  { name: 'Graph', key: 'graph', hours: hoursSince(parseLastRun(lastRuns.graph)?.ts), threshold: 168 },
];

console.log('═'.repeat(50));
console.log('Scheduler Catch-Up Test');
console.log('═'.repeat(50));
console.log(`Time: ${now.toISOString()}`);
console.log(`Last run file: ${fs.existsSync(CATCH_UP_FILE) ? 'EXISTS' : 'NOT FOUND (first run)'}`);
console.log('');

let missedCount = 0;
for (const job of jobs) {
  const status = job.hours === null ? '🔵 NEVER RUN' : job.hours > job.threshold ? '🔴 MISSED' : '🟢 OK';
  const hoursStr = job.hours === null ? 'never' : `${job.hours.toFixed(1)}h ago`;
  console.log(`${status}  ${job.name.padEnd(12)} ${hoursStr.padEnd(12)} (threshold: ${job.threshold}h)`);
  if (job.hours === null || job.hours > job.threshold) missedCount++;
}

console.log('');
console.log(`Result: ${missedCount} job(s) missed`);

if (missedCount > 0) {
  console.log('');
  console.log('To run missed jobs, use flags:');
  console.log('  --run-pipeline   Run pipeline_report_v2.js --force');
  console.log('  --run-memory     Run memory consolidation');
  console.log('  --run-backup     Run DB backup');
  console.log('');

  if (shouldRun.pipeline) {
    console.log('[TestScheduler] Running pipeline...');
    const child = spawn('node', ['pipeline_report_v2.js', '--force'], { stdio: 'inherit' });
    child.on('exit', (code) => {
      console.log(`[TestScheduler] Pipeline exited with code ${code}`);
    });
  }

  if (shouldRun.backup) {
    console.log('[TestScheduler] Running backup...');
    const { runBackup } = await import('./backup_db.js');
    const result = await runBackup();
    console.log(`[TestScheduler] Backup done: ${result.backupName}`);
  }
} else {
  console.log('All jobs are up to date. ✅');
}
