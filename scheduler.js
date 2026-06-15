import { spawn } from 'child_process';
import cron from 'node-cron';
import { addJob, JobType, QueueName } from './lib/task_queue.js';
import { getLogger } from './lib/logger.js';import { writeJsonAtomic, readJsonSafe } from './lib/atomic_write.js';

const logger = getLogger('Scheduler');

// ── Cloud Run detection ──────────────────────────────────────────────────────
// Trên Cloud Run, KHÔNG dùng node-cron (process bị scale-to-zero).
// Thay vào đó, dùng Google Cloud Scheduler → HTTP POST → /scheduler/:job
const IS_CLOUD_RUN = !!process.env.K_SERVICE; // Cloud Run sets K_SERVICE env var

// Cron schedule theo PDT (UTC-7)
// 8AM=15:00UTC, 11AM=18:00UTC, 2PM=21:00UTC, 5PM=00:00UTC, 8PM=03:00UTC
// Dùng timezone 'America/Los_Angeles' để cron tự động chuyển đổi
const CRON_SCHEDULE = process.env.CRON_SCHEDULE || '0 8,11,14,17,20 * * *';
const RUN_ON_START = process.env.RUN_ON_START !== 'false';
const FORCE_RUN = process.env.FORCE_PIPELINE === 'true';
const TOPIC_OVERRIDE = process.env.PIPELINE_TOPIC || '';

if (IS_CLOUD_RUN) {
  logger.info('[Scheduler] Running on Cloud Run — node-cron disabled, using Cloud Scheduler');
} else {
  logger.info('[Scheduler] Running on local/server — using node-cron with PDT timezone');
}

// ── Memory Consolidation: 2:00 AM mỗi ngày ──
// Tóm tắt lịch sử chat Discord hôm qua → nhúng vector → lưu vào long-term memory
const MEMORY_CRON = '0 2 * * *';

// ── Disaster Recovery: 3:00 AM Chủ Nhật hàng tuần ──
// Backup toàn bộ DB (vectors.db, data.db, artifacts) vào thư mục backups/
const BACKUP_CRON = '0 3 * * 0';

async function runMemoryConsolidation() {
  console.log('[scheduler] Starting memory consolidation at', new Date().toISOString());

  try {
    const { archiveOldMemories, getRecentMemory } = await import('./lib/memory_manager.js');
    const { embedText } = await import('./lib/embeddings.js');
    const { upsertAcademic, upsertSystem, upsertDaily } = await import('./lib/vector_collections.js');

    // Lấy memories từ 7 ngày qua
    const recentMemories = await getRecentMemory(7);
    if (!recentMemories || recentMemories.length === 0) {
      console.log('[scheduler] No recent memories to consolidate');
      return;
    }

    // Phân loại memories theo collection
    const academicItems = [];
    const systemItems = [];
    const dailyItems = [];

    for (const mem of recentMemories) {
      const content = mem.content || '';
      const source = mem.source || 'unknown';
      const tags = (mem.tags || []).join(',');
      
      // Phân loại dựa trên tags và nội dung
      if (tags.includes('discord') || tags.includes('user-memory')) {
        dailyItems.push({ ...mem, content });
      } else if (tags.includes('system') || tags.includes('error') || tags.includes('log')) {
        systemItems.push({ ...mem, content });
      } else {
        academicItems.push({ ...mem, content });
      }
    }

    // Xử lý từng collection
    const processItems = async (items, upsertFn, collectionName) => {
      if (items.length === 0) return;
      
      const combinedText = items.map(i => i.content).join('\n').slice(0, 4000);
      const docId = `${collectionName}:${new Date().toISOString().slice(0, 10)}`;
      
      try {
        const embedding = await embedText(combinedText);
        if (!embedding || !embedding.length) {
          console.warn(`[scheduler] Embedding failed for ${collectionName}, skipping`);
          return;
        }
        await upsertFn(docId, {
          url: 'scheduler://consolidation',
          project: collectionName,
          category: 'Memory',
          type: 'consolidated',
        }, [combinedText], [embedding]);
        
        console.log(`[scheduler] Consolidated ${items.length} items to ${collectionName}`);
      } catch (err) {
        console.error(`[scheduler] Consolidation error for ${collectionName}:`, err?.message || err);
      }
    };

    // Process each collection independently — one failure doesn't block others
    const results = await Promise.allSettled([
      processItems(academicItems, upsertAcademic, 'academic-docs'),
      processItems(systemItems, upsertSystem, 'system-logs'),
      processItems(dailyItems, upsertDaily, 'daily-memory'),
    ]);
    for (const r of results) {
      if (r.status === 'rejected') {
        console.error('[scheduler] Collection processing error:', r.reason?.message || r.reason);
      }
    }

    // Archive memories cũ
    await archiveOldMemories(30);
    console.log('[scheduler] Memory consolidation completed');
    await saveLastRun('memory');
  } catch (err) {
    // ponytail: Qdrant not available → memory consolidation silently fails, upgrade: add Qdrant or switch to SQLite vector store
    console.error('[scheduler] Memory consolidation error:', err?.message || err);
  }
}

// ── Pipeline lock để tránh chạy đồng thời ──
let _pipelineRunning = false;

async function runPipeline() {
  // Nếu pipeline đang chạy → bỏ qua
  if (_pipelineRunning) {
    console.log('[scheduler] Pipeline đang chạy, bỏ qua lần này');
    return;
  }

  const args = ['pipeline_report_v2.js'];
  if (TOPIC_OVERRIDE) args.push(TOPIC_OVERRIDE);
  if (FORCE_RUN) args.push('--force');

  console.log(`[scheduler] Starting pipeline at ${new Date().toISOString()}`);
  console.log('[scheduler] Command:', 'node', args.join(' '));

  _pipelineRunning = true;

  const child = spawn('node', args, { stdio: 'inherit' });

  child.on('exit', async (code, signal) => {
    _pipelineRunning = false;
    if (signal) {
      console.log(`[scheduler] Pipeline process terminated with signal ${signal}`);
      await saveLastRun('pipeline');
    } else {
      console.log(`[scheduler] Pipeline process exited with code ${code}`);
      await saveLastRun('pipeline');
    }
  });

  child.on('error', (err) => {
    _pipelineRunning = false;
    console.error('[scheduler] Failed to start pipeline process:', err.message || err);
  });
}

// ── Backup Function ──
// Import once at startup to avoid repeated dynamic imports
let backupModule = null;
async function runBackup() {
  try {
    if (!backupModule) {
      backupModule = await import('./scripts/backup_db.js');
    }
    const result = await backupModule.runBackup();
    console.log(`[scheduler] Backup completed: ${result.backupName}`);
    await saveLastRun('backup');
  } catch (err) {
    console.error('[scheduler] Backup failed:', err?.message || err);
  }
}

console.log('[scheduler] Starting autonomous scheduler');
console.log('[scheduler] Cron expression:', CRON_SCHEDULE);
console.log('[scheduler] Pipeline topic override:', TOPIC_OVERRIDE || 'none');
console.log('[scheduler] Force run enabled:', FORCE_RUN);
console.log('[scheduler] Run on start:', RUN_ON_START);

// ── Catch-up: Kiểm tra cron jobs bị lỡ khi máy sleep/reboot ────────────────
const CATCH_UP_FILE = './.scheduler_last_run.json';

// Atomic write/read utilities (loaded once at top of file)

async function checkCatchUp() {
  const now = new Date();
  const currentHour = now.getHours();
  const currentDay = now.getDay(); // 0=Sun, 1=Mon, ...

  // Đọc last run times (atomic read with backup recovery)
  const lastRuns = await readJsonSafe(CATCH_UP_FILE, {});

  // Parse last runs — hỗ trợ cả format cũ (string) và mới (object {ts, status})
  const parseLastRun = (entry) => {
    if (!entry) return null;
    if (typeof entry === 'string') return { ts: new Date(entry), status: 'done' };
    return { ts: new Date(entry.ts), status: entry.status || 'done' };
  };

  const lastPipeline = parseLastRun(lastRuns.pipeline);
  const lastMemory = parseLastRun(lastRuns.memory);
  const lastBackup = parseLastRun(lastRuns.backup);
  // Nếu job đang chạy → bỏ qua, không trigger lại
  if (lastPipeline?.status === 'running') {
    console.log('[scheduler] Pipeline đang chạy, bỏ qua catch-up');
    return;
  }

  const hoursSince = (date) => {
    if (!date) return null; // null = chưa bao giờ chạy
    const hours = (now - new Date(date).getTime()) / 3600000;
    return hours > 0 ? hours : 0;
  };

  const formatHours = (h) => h === null ? 'never' : `${h.toFixed(1)}h ago`;

  console.log('[scheduler] Catch-up check:');
  console.log(`  Pipeline: last run ${formatHours(hoursSince(lastPipeline))}`);
  console.log(`  Memory:   last run ${formatHours(hoursSince(lastMemory))}`);
  console.log(`  Backup:   last run ${formatHours(hoursSince(lastBackup))}`);

  // ── Chạy catch-up cho từng job bị lỡ ──
  const missed = [];

  // Pipeline catch-up
  const hsPipeline = hoursSince(lastPipeline);
  if (hsPipeline === null || hsPipeline > 12) {
    console.log('[scheduler] ⚠️ Pipeline missed! Running catch-up...');
    try {
      const { execSync } = await import('child_process');
      execSync(`node pipeline_report_v2.js --no-webhook`, { encoding: 'utf8', timeout: 600000 });
      missed.push('Pipeline');
    } catch (err) { console.error('[scheduler] Pipeline catch-up failed:', err.message); }
  }

  // Memory consolidation catch-up
  const hsMemory = hoursSince(lastMemory);
  if (hsMemory === null || hsMemory > 24) {
    console.log('[scheduler] ⚠️ Memory consolidation missed! Running catch-up...');
    try { await runMemoryConsolidation(); missed.push('Memory'); }
    catch (err) { console.error('[scheduler] Memory catch-up failed:', err.message); }
  }

  // Backup catch-up
  const hsBackup = hoursSince(lastBackup);
  if (hsBackup === null || hsBackup > 168) {
    console.log('[scheduler] ⚠️ Backup missed! Running catch-up...');
    try { await runBackup(); missed.push('Backup'); }
    catch (err) { console.error('[scheduler] Backup catch-up failed:', err.message); }
  }

  if (missed.length > 0) console.log(`[scheduler] Catch-up done: ${missed.join(', ')}`);
}

// Lưu last run time — atomic write với running flag
async function saveLastRun(type, status = 'done') {
  try {
    // Read current state (with backup recovery)
    const lastRuns = await readJsonSafe(CATCH_UP_FILE, {});
    lastRuns[type] = {
      ts: new Date().toISOString(),
      status, // 'running' | 'done' | 'failed'
    };
    // Atomic write with backup
    await writeJsonAtomic(CATCH_UP_FILE, lastRuns);
  } catch (err) {
    console.error('[scheduler] saveLastRun failed:', err?.message || err);
  }
}

// Kiểm tra xem job có đang chạy không (sync version for use in non-async contexts)
function isJobRunning(type) {
  try {
    const fs = require('fs');
    if (!fs.existsSync(CATCH_UP_FILE)) return false;
    const raw = fs.readFileSync(CATCH_UP_FILE, 'utf8');
    const lastRuns = JSON.parse(raw || '{}');
    return lastRuns[type]?.status === 'running';
  } catch {
    return false;
  }
}

// Chạy catch-up check khi start (delay 60s để services khác khởi động xong)
setTimeout(() => {
  checkCatchUp().catch(err => console.error('[scheduler] Catch-up check failed:', err?.message || err));
}, 60000);

if (RUN_ON_START) {
  // Delay 30s startup to let other services initialize first
  setTimeout(async () => {
    // Skip if catch-up already ran pipeline recently (within 5 minutes)
    try {
      const lastRuns = await readJsonSafe(CATCH_UP_FILE, {});
      const lastPipeline = lastRuns.pipeline?.ts ? new Date(lastRuns.pipeline.ts) : null;
      if (lastPipeline && (Date.now() - lastPipeline.getTime()) < 300000) {
        console.log('[scheduler] Startup pipeline skipped — catch-up ran recently');
        return;
      }
    } catch { /* ignore */ }

    // Skip startup run — cron jobs handle scheduled runs
    // Catch-up logic above handles missed jobs
    console.log('[scheduler] Startup pipeline skipped — waiting for cron schedule');
    return;

    try {
      runPipeline();
    } catch (err) {
      console.error('[scheduler] Startup pipeline failed:', err?.message || err);
    }
  }, 30000);
}

// ── Only schedule cron jobs when NOT on Cloud Run ──
// On Cloud Run, use Google Cloud Scheduler → HTTP POST → /scheduler/:job
let task, memoryTask, backupTask;

if (!IS_CLOUD_RUN) {
  logger.info('[Scheduler] Registering node-cron jobs (local/server mode)');

  task = cron.schedule(CRON_SCHEDULE, () => {
    logger.info('[scheduler] Cron triggered');
    runPipeline();
  }, {
    timezone: 'America/Los_Angeles',
  });

  // Memory consolidation: 2:00 AM mỗi ngày
  memoryTask = cron.schedule(MEMORY_CRON, () => {
    logger.info('[scheduler] Memory consolidation triggered');
    runMemoryConsolidation();
  }, { timezone: 'America/Los_Angeles' });

  // Disaster Recovery: 3:00 AM Chủ Nhật hàng tuần
  backupTask = cron.schedule(BACKUP_CRON, () => {
    logger.info('[scheduler] Backup triggered');
    runBackup();
  }, { timezone: 'America/Los_Angeles' });

  // ── EvoAgent: 4:00 AM mỗi ngày — Phân tích logs & tối ưu hệ thống ──
  const EVO_CRON = '0 4 * * *';
  const evoTask = cron.schedule(EVO_CRON, async () => {
    logger.info('[scheduler] EvoAgent analysis triggered');
    try {
      const { autoEvaluate } = await import('./agents/EvoAgent.js');
      await autoEvaluate();
      await saveLastRun('evo');
    } catch (err) {
      logger.error('[scheduler] EvoAgent error:', err?.message || err);
    }
  }, { timezone: 'America/Los_Angeles' });

  // ── GraphAgent: 5:00 AM Chủ Nhật — Đồng bộ Knowledge Graph ──
  const GRAPH_CRON = '0 5 * * 0';
  const graphTask = cron.schedule(GRAPH_CRON, async () => {
    logger.info('[scheduler] GraphAgent sync triggered');
    try {
      const { syncGraph } = await import('./agents/GraphAgent.js');
      await syncGraph();
      await saveLastRun('graph');
    } catch (err) {
      logger.error('[scheduler] GraphAgent error:', err?.message || err);
    }
  }, { timezone: 'America/Los_Angeles' });

  // ── Proactive Suggestion: 8:00 AM mỗi ngày ──
  const SUGGESTION_CRON = '0 8 * * *';
  const suggestionTask = cron.schedule(SUGGESTION_CRON, async () => {
    logger.info('[scheduler] Proactive suggestion triggered');
    try {
      const { runContextMonitor } = await import('./agents/SuggestionAgent.js');
      const result = await runContextMonitor();
      if (result?.message) {
        logger.info(`[scheduler] Proactive suggestions: ${result.suggestions.length}`);
      }
    } catch (err) {
      logger.error('[scheduler] Suggestion error:', err?.message || err);
    }
  }, { timezone: 'America/Los_Angeles' });

  // ── Start all cron jobs ──
  task.start();
  memoryTask.start();
  backupTask.start();
  evoTask.start();
  graphTask.start();
  suggestionTask.start();

  logger.info('[Scheduler] All node-cron jobs started');
} // end if (!IS_CLOUD_RUN)

async function gracefulShutdown(signal) {
  console.log(`[scheduler] Received ${signal}, stopping all cron tasks...`);
  task?.stop();
  memoryTask?.stop();
  backupTask?.stop();
  evoTask?.stop();
  graphTask?.stop();
  suggestionTask?.stop();

  process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
