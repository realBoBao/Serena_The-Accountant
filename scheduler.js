import { spawn } from 'child_process';
import cron from 'node-cron';
import { addJob, JobType, QueueName } from './lib/task_queue.js';
import { getLogger } from './lib/logger.js';
import { writeJsonSafe, readJsonSafe, writeJsonWithBackup, cleanupStaleTempFiles } from './lib/safe_json.js';
import { writeJsonAtomic } from './lib/atomic_write.js';

const logger = getLogger('Scheduler');
const eventBus = globalThis.eventBus ?? null;

// ── Cloud Run detection ──────────────────────────────────────────────────────
// Trên Cloud Run, KHÔNG dùng node-cron (process bị scale-to-zero).
// Thay vào đó, dùng Google Cloud Scheduler → HTTP POST → /scheduler/:job
const IS_CLOUD_RUN = !!process.env.K_SERVICE; // Cloud Run sets K_SERVICE env var

// Cron schedule — dùng timezone từ env hoặc mặc định server local time
// Mặc định: 8AM, 11AM, 2PM, 5PM, 8PM theo timezone server
// Để dùng PDT: đặz CRON_TZ=America/Los_Angeles trong .env
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

// ── Hot/Cold Data Federation (Tier 4): 4:00 AM Chủ Nhật ──
// Move dữ liệu cũ >30 ngày từ flashcards.db sang archive.db
const ARCHIVE_CRON = '0 4 * * 0';

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
    eventBus?.emit('memory:complete', { topic: 'memory', ts: new Date().toISOString() });
      // Tier 4: Invalidate cache after memory consolidation
      try {
        const { default: SemanticCache } = await import('./lib/semantic_cache.js');
        const cache = new SemanticCache();
        await cache.initialize();
        cache.invalidateByContext('memory');
      } catch (cacheErr) {
        logger.debug('[scheduler] Cache invalidation skipped:', cacheErr?.message);
      }
  } catch (err) {
    // ponytail: Qdrant not available → memory consolidation silently fails, upgrade: add Qdrant or switch to SQLite vector store
    console.error('[scheduler] Memory consolidation error:', err?.message || err);
  }
}

// ── Pipeline lock để tránh chạy đồng thời ──
let _pipelineRunning = false;
let _lastPipelineRun = 0; // timestamp of last run
const MIN_RUN_INTERVAL = 30 * 60 * 1000; // 30 minutes minimum between runs

async function runPipeline({ respectCooldown = true } = {}) {
  // Nếu pipeline đang chạy → bỏ qua
  if (_pipelineRunning) {
    console.log('[scheduler] Pipeline đang chạy, bỏ qua lần này');
    return;
  }
  // Nếu chạy gần đây (< 30 phút) → bỏ qua (tránh duplicate)
  if (respectCooldown && Date.now() - _lastPipelineRun < MIN_RUN_INTERVAL) {
    const minsAgo = Math.round((Date.now() - _lastPipelineRun) / 60000);
    console.log(`[scheduler] Pipeline chạy ${minsAgo} phút trước, bỏ qua`);
    return;
  }

  const args = ['pipeline_report_v2.js'];
  if (TOPIC_OVERRIDE) args.push(TOPIC_OVERRIDE);
  if (FORCE_RUN) args.push('--force');

  console.log(`[scheduler] Starting pipeline at ${new Date().toISOString()}`);
  console.log('[scheduler] Command:', 'node', args.join(' '));

  _pipelineRunning = true;
  if (respectCooldown) {
    _lastPipelineRun = Date.now();
  }

  const child = spawn('node', args, { stdio: 'inherit' });

  child.on('exit', async (code, signal) => {
    _pipelineRunning = false;
    if (signal) {
      console.log(`[scheduler] Pipeline process terminated with signal ${signal}`);
      await saveLastRun('pipeline');
      eventBus?.emit('pipeline:complete', { topic: 'pipeline', ts: new Date().toISOString() });
      // Tier 4: Invalidate stale cache entries after pipeline update
      try {
        const { default: SemanticCache } = await import('./lib/semantic_cache.js');
        const cache = new SemanticCache();
        await cache.initialize();
        const invalidated = cache.invalidateByContext('pipeline');
        if (invalidated > 0) logger.info(`[scheduler] Cache invalidated: ${invalidated} entries`);
      } catch (cacheErr) {
        logger.debug('[scheduler] Cache invalidation skipped:', cacheErr?.message);
      }
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
    eventBus?.emit('backup:complete', { topic: 'backup', ts: new Date().toISOString() });
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

  // Pipeline catch-up (>12h)
  const hsPipeline = hoursSince(lastPipeline);
  if (hsPipeline === null || hsPipeline > 12) {
    console.log('[scheduler] ⚠️ Pipeline missed! Running catch-up...');
    try {
      const { execSync } = await import('child_process');
      execSync(`node pipeline_report_v2.js --no-webhook`, { encoding: 'utf8', timeout: 600000 });
      missed.push('Pipeline');
    } catch (err) { console.error('[scheduler] Pipeline catch-up failed:', err.message); }
  }

  // Memory consolidation catch-up (>24h)
  const hsMemory = hoursSince(lastMemory);
  if (hsMemory === null || hsMemory > 24) {
    console.log('[scheduler] ⚠️ Memory consolidation missed! Running catch-up...');
    try { await runMemoryConsolidation(); missed.push('Memory'); }
    catch (err) { console.error('[scheduler] Memory catch-up failed:', err.message); }
  }

  // Backup catch-up (>168h = 7 days)
  const hsBackup = hoursSince(lastBackup);
  if (hsBackup === null || hsBackup > 168) {
    console.log('[scheduler] ⚠️ Backup missed! Running catch-up...');
    try { await runBackup(); missed.push('Backup'); }
    catch (err) { console.error('[scheduler] Backup catch-up failed:', err.message); }
  }

  // EvoAgent catch-up (>24h)
  const hsEvo = hoursSince(parseLastRun(lastRuns.evo));
  if (hsEvo === null || hsEvo > 24) {
    console.log('[scheduler] ⚠️ EvoAgent missed! Running catch-up...');
    try {
      const { runDailyEvolution } = await import('./agents/EvoAgent.js');
      await runDailyEvolution();
      missed.push('EvoAgent');
    } catch (err) { console.error('[scheduler] EvoAgent catch-up failed:', err.message); }
  }

  // Suggestion catch-up (>24h)
  const hsSuggestion = hoursSince(parseLastRun(lastRuns.suggestion));
  if (hsSuggestion === null || hsSuggestion > 24) {
    console.log('[scheduler] ⚠️ Suggestion missed! Running catch-up...');
    try {
      const { runContextMonitor } = await import('./agents/SuggestionAgent.js');
      await runContextMonitor();
      missed.push('Suggestion');
    } catch (err) { console.error('[scheduler] Suggestion catch-up failed:', err.message); }
  }

  // RSS fetch catch-up (>24h)
  const hsRss = hoursSince(parseLastRun(lastRuns.rss));
  if (hsRss === null || hsRss > 24) {
    console.log('[scheduler] ⚠️ RSS fetch missed! Running catch-up...');
    try {
      const { runDailyRssFetch } = await import('./cron/daily_rss_fetch.js');
      await runDailyRssFetch();
      missed.push('RSS');
    } catch (err) { console.error('[scheduler] RSS catch-up failed:', err.message); }
  }

  // Decay catch-up (>24h)
  const hsDecay = hoursSince(parseLastRun(lastRuns.decay));
  if (hsDecay === null || hsDecay > 24) {
    console.log('[scheduler] ⚠️ Memory decay missed! Running catch-up...');
    try {
      const { memoryDecay } = await import('./lib/memory_decay.js');
      memoryDecay.runDailyDecay();
      missed.push('Decay');
    } catch (err) { console.error('[scheduler] Decay catch-up failed:', err.message); }
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

// Kiểm tra xem job có đang chạy không — dùng readJsonSafe async
async function isJobRunning(type) {
  try {
    const lastRuns = await readJsonSafe(CATCH_UP_FILE, {});
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
    // Check if catch-up already ran pipeline recently (within 1 hour)
    try {
      const lastRuns = await readJsonSafe(CATCH_UP_FILE, {});
      const lastPipeline = lastRuns.pipeline?.ts ? new Date(lastRuns.pipeline.ts) : null;
      if (lastPipeline && (Date.now() - lastPipeline.getTime()) < 3600000) {
        console.log('[scheduler] Startup pipeline skipped — catch-up ran within 1h');
        return;
      }
    } catch { /* ignore */ }

    // Run pipeline on startup if not caught up recently
    console.log('[scheduler] Running startup pipeline...');
    try {
      runPipeline({ respectCooldown: false });
    } catch (err) {
      console.error('[scheduler] Startup pipeline failed:', err?.message || err);
    }
  }, 30000);
}

// ── Dọn file .tmp còn sót từ crash trước ──
cleanupStaleTempFiles('.').catch(() => {});

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

  // ── Hot/Cold Data Federation (Tier 4): 4:00 AM Chủ Nhật ──
  const archiveTask = cron.schedule(ARCHIVE_CRON, () => {
    logger.info('[scheduler] Archive old data triggered');
    import('./lib/data_federation.js').then(m => m.archiveOldData()).catch(() => {});
  }, { timezone: 'America/Los_Angeles' });

  // ── EvoAgent: 4:00 AM mỗi ngày — Phân tích logs & tối ưu hệ thống ──
  const EVO_CRON = '0 4 * * *';
  const evoTask = cron.schedule(EVO_CRON, async () => {
    logger.info('[scheduler] EvoAgent analysis triggered');
    try {
      const { runDailyEvolution } = await import('./agents/EvoAgent.js');
      const result = await runDailyEvolution();
      await saveLastRun('evo');
      // Gửi Discord notification nếu có warnings
      if (result?.systemHealth?.warnings?.length > 0) {
        try {
          const { sendAggregatedWebhook } = await import('./notify_discord.js');
          await sendAggregatedWebhook({
            topic: `🔍 EvoAgent Report — ${new Date().toLocaleDateString('vi-VN')}`,
            results: result.systemHealth.warnings.map(w => ({
              title: w.message || w.type || 'Warning',
              url: '',
              type: 'evo',
              score: 0.5,
              category: 'System',
            })),
            bullets: `${result.systemHealth.warnings.length} warning(s) detected`,
            isError: !result.systemHealth.healthy,
          });
        } catch (webhookErr) { /* ignore */ }
      }
      // Log behavioral recommendations
      if (result?.behavioral?.recommendations?.length > 0) {
        logger.info('[scheduler] EvoAgent behavioral recommendations:', result.behavioral.recommendations);
      }
    } catch (err) {
      logger.error('[scheduler] EvoAgent error:', err?.message || err);
    }
  }, { timezone: 'America/Los_Angeles' });

  // ── Memory Decay: 4:30 AM mỗi ngày — Ebbinghaus forgetting curve ──
  const DECAY_CRON = '30 4 * * *';
  const decayTask = cron.schedule(DECAY_CRON, async () => {
    logger.info('[scheduler] Memory decay triggered');
    try {
      const { memoryDecay } = await import('./lib/memory_decay.js');
      const result = memoryDecay.runDailyDecay();
      await saveLastRun('decay');
      logger.info(`[scheduler] Memory decay complete: ${result.totalChanges} values decayed across ${result.usersProcessed} users`);
    } catch (err) {
      logger.error('[scheduler] Memory decay error:', err?.message || err);
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
        // Gửi Discord notification
        try {
          const { sendAggregatedWebhook } = await import('./notify_discord.js');
          await sendAggregatedWebhook({
            topic: `💡 Gợi ý học tập — ${new Date().toLocaleDateString('vi-VN')}`,
            results: (result.suggestions || []).map(s => ({
              title: s.title || 'Gợi ý',
              url: s.url || '',
              type: 'suggestion',
              score: 0.5,
              category: 'Learning',
            })),
            bullets: result.message,
            isError: false,
          });
          logger.info('[scheduler] Suggestion notification sent to Discord');
        } catch (webhookErr) {
          logger.error('[scheduler] Suggestion webhook failed:', webhookErr?.message || webhookErr);
        }
      }
      await saveLastRun('suggestion');
    } catch (err) {
      logger.error('[scheduler] Suggestion error:', err?.message || err);
    }
  }, { timezone: 'America/Los_Angeles' });

  // ── Tier 2: Daily RSS Fetch — 6:00 AM PDT ──
  const RSS_CRON = '0 6 * * *';
  const rssTask = cron.schedule(RSS_CRON, async () => {
    logger.info('[scheduler] Daily RSS fetch triggered');
    try {
      const { runDailyRssFetch } = await import('./cron/daily_rss_fetch.js');
      const result = await runDailyRssFetch();
      logger.info(`[scheduler] Daily RSS: ${result.articles} articles, ${result.flashcards} flashcards`);
      await saveLastRun('rss');
    } catch (err) {
      logger.error('[scheduler] Daily RSS fetch error:', err?.message || err);
    }
  }, { timezone: 'America/Los_Angeles' });

  // ── Start all cron jobs ──
  task.start();
  memoryTask.start();
  backupTask.start();
  evoTask.start();
  graphTask.start();
  suggestionTask.start();
  rssTask.start();

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
