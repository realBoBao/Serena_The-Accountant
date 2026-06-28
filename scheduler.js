import { spawn } from 'child_process';
import cron from 'node-cron';
import { addJob, JobType, QueueName } from './lib/task_queue.js';
import { getLogger } from './lib/logger.js';
import { writeJsonSafe, readJsonSafe, writeJsonWithBackup, cleanupStaleTempFiles } from './lib/safe_json.js';
import { writeJsonAtomic } from './lib/atomic_write.js';
import { checkRisk, sendRiskAlert } from './lib/behavioral_predictor.js';

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
  logger.info('[Scheduler] Running on local/server — using node-cron with UTC timezone');
}

// ── Global cron task references (for gracefulShutdown) ──
let task, memoryTask, backupTask, evoTask, graphTask, suggestionTask, rssTask, jobTask, algoTask, algoAnswerTask;

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
// File-based lock để persist across PM2 restarts
const LOCK_FILE = './.pipeline_lock.json';
const MIN_RUN_INTERVAL = 30 * 60 * 1000; // 30 minutes minimum between runs

async function acquirePipelineLock() {
  try {
    const lock = await readJsonSafe(LOCK_FILE, { running: false, lastRun: 0, topic: '' });
    if (lock.running) {
      // Check if process is still alive (stale lock?)
      if (lock.pid && process.kill(lock.pid, 0)) {
        return false; // Process still running
      }
      // Stale lock — process died, take over
      logger.warn('[scheduler] Stale lock detected, taking over');
    }
    // Check cooldown
    if (Date.now() - lock.lastRun < MIN_RUN_INTERVAL) {
      const minsAgo = Math.round((Date.now() - lock.lastRun) / 60000);
      logger.info(`[scheduler] Pipeline ran ${minsAgo}m ago, skipping`);
      return false;
    }
    // Acquire lock
    await writeJsonAtomic(LOCK_FILE, { running: true, pid: process.pid, lastRun: Date.now(), topic: '' });
    return true;
  } catch {
    return true; // If lock file is corrupt, proceed
  }
}

async function releasePipelineLock(topic) {
  await writeJsonAtomic(LOCK_FILE, { running: false, pid: null, lastRun: Date.now(), topic });
}

async function runPipeline({ respectCooldown = true } = {}) {
  // ── File-based lock để tránh duplicate across restarts ──
  if (respectCooldown) {
    const acquired = await acquirePipelineLock();
    if (!acquired) {
      return; // Already running or cooldown active
    }
  }

  const args = ['pipeline_report_v2.js'];
  if (TOPIC_OVERRIDE) args.push(TOPIC_OVERRIDE);
  if (FORCE_RUN) args.push('--force');

  console.log(`[scheduler] Starting pipeline at ${new Date().toISOString()}`);
  console.log('[scheduler] Command:', 'node', args.join(' '));

  const child = spawn('node', args, { stdio: 'inherit' });

  child.on('exit', async (code, signal) => {
    await releasePipelineLock(TOPIC_OVERRIDE || 'auto');
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

      // ── Tier 4: Behavioral Predictor — Check risk patterns ──
      try {
        const risks = checkRisk('pipeline', TOPIC_OVERRIDE || 'auto');
        if (risks.length > 0) {
          console.log(`[scheduler] ⚠️ Behavioral Predictor: ${risks.length} risk(s) detected`);
          await sendRiskAlert(risks, 'scheduler_pipeline');
        }
      } catch (predictorErr) {
        logger.debug('[scheduler] Behavioral Predictor skipped:', predictorErr?.message);
      }
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
    // ponytail: dùng child_process thay vì import để tránh lỗi "X is not a function"
    const { execSync } = await import('child_process');
    const result = execSync('node scripts/backup_db.js', { encoding: 'utf8', timeout: 60000 });
    console.log(`[scheduler] Backup completed: ${result.trim()}`);
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
      const { runNightlyScraper } = await import('./cron/nightly_scraper.js');
      await runNightlyScraper();
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
  return missed.length > 0;
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

// ── Single startup trigger: Catch-up OR pipeline (NOT both) ──
// Delay 60s để services khác khởi động xong
setTimeout(async () => {
  try {
    // 1. Check catch-up (missed jobs khi PM2 restart)
    const missed = await checkCatchUp();
    
    // 2. Nếu catch-up KHÔNG chạy pipeline → chạy startup pipeline
    if (!missed) {
      const lastRuns = await readJsonSafe(CATCH_UP_FILE, {});
      const lastPipeline = lastRuns.pipeline?.ts ? new Date(lastRuns.pipeline.ts) : null;
      const hoursSincePipeline = lastPipeline ? (Date.now() - lastPipeline.getTime()) / 3600000 : 999;
      
      if (hoursSincePipeline > 1) {
        console.log('[scheduler] Running startup pipeline...');
        try {
          await runPipeline({ respectCooldown: false });
        } catch (err) {
          console.error('[scheduler] Startup pipeline failed:', err?.message || err);
        }
      } else {
        console.log('[scheduler] Pipeline ran recently, skipping startup');
      }
    } else {
      console.log('[Scheduler] Catch-up ran pipeline, skipping startup');
    }
  } catch (err) {
    console.error('[Scheduler] Startup trigger failed:', err?.message || err);
  }
}, 60000);

// ── Dọn file .tmp còn sót từ crash trước ──
cleanupStaleTempFiles('.').catch(() => {});

// ── Only schedule cron jobs when NOT on Cloud Run ──
// On Cloud Run, use Google Cloud Scheduler → HTTP POST → /scheduler/:job
if (!IS_CLOUD_RUN) {
  logger.info('[Scheduler] Registering node-cron jobs (local/server mode)');

  task = cron.schedule(CRON_SCHEDULE, () => {
    logger.info('[scheduler] Cron triggered');
    runPipeline();
  }, {
    timezone: 'Etc/UTC',
  });

  // Memory consolidation: 2:00 AM mỗi ngày
  memoryTask = cron.schedule(MEMORY_CRON, () => {
    logger.info('[scheduler] Memory consolidation triggered');
    runMemoryConsolidation();
  }, { timezone: 'Etc/UTC' });

  // Disaster Recovery: 3:00 AM Chủ Nhật hàng tuần
  backupTask = cron.schedule(BACKUP_CRON, () => {
    logger.info('[scheduler] Backup triggered');
    runBackup();
  }, { timezone: 'Etc/UTC' });

  // ── Hot/Cold Data Federation (Tier 4): 4:00 AM Chủ Nhật ──
  const archiveTask = cron.schedule(ARCHIVE_CRON, () => {
    logger.info('[scheduler] Archive old data triggered');
    import('./lib/data_federation.js').then(m => m.archiveOldData()).catch(() => {});
  }, { timezone: 'Etc/UTC' });

  // ── EvoAgent: 4:00 AM mỗi ngày — Phân tích logs & tối ưu hệ thống ──
  const EVO_CRON = '0 4 * * *';
  evoTask = cron.schedule(EVO_CRON, async () => {
    logger.info('[scheduler] EvoAgent analysis triggered');
    // Session memory cleanup — xóa entries cũ hơn 7 ngày
    try {
      const { SessionMemory } = await import('./lib/session_memory.js');
      SessionMemory.cleanup();
    } catch { /* optional */ }
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
  }, { timezone: 'Etc/UTC' });

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
  }, { timezone: 'Etc/UTC' });

  // ── GraphAgent: 5:00 AM Chủ Nhật — Đồng bộ Knowledge Graph ──
  const GRAPH_CRON = '0 5 * * 0';
  graphTask = cron.schedule(GRAPH_CRON, async () => {
    logger.info('[scheduler] GraphAgent sync triggered');
    try {
      const { syncGraph } = await import('./agents/GraphAgent.js');
      await syncGraph();
      await saveLastRun('graph');
    } catch (err) {
      logger.error('[scheduler] GraphAgent error:', err?.message || err);
    }
  }, { timezone: 'Etc/UTC' });

  // ── Proactive Suggestion: 8:00 AM PDT = 15:00 UTC ──
  const SUGGESTION_CRON = '0 15 * * *';
  suggestionTask = cron.schedule(SUGGESTION_CRON, async () => {
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
  }, { timezone: 'Etc/UTC' });

  // ── Tier 2: Daily RSS Fetch — 6:00 AM PDT = 13:00 UTC ──
  const RSS_CRON = '0 13 * * *';
  rssTask = cron.schedule(RSS_CRON, async () => {
    logger.info('[scheduler] Daily RSS fetch triggered');
    try {
      const { runNightlyScraper } = await import('./cron/nightly_scraper.js');
      const result = await runNightlyScraper();
      logger.info(`[scheduler] Nightly scrape: ${result.stored} docs stored`);
      await saveLastRun('rss');
    } catch (err) {
      logger.error('[scheduler] Daily RSS fetch error:', err?.message || err);
    }
  }, { timezone: 'Etc/UTC' });

  // ── Tier 3: Job Scraper — 6AM/1PM/7PM PDT = 13:00/20:00/02:00 UTC ──
  const JOB_CRON = '0 13,20,2 * * *';
  jobTask = cron.schedule(JOB_CRON, async () => {
    logger.info('[Scheduler] Job scraper triggered');
    try {
      const { runJobScraper } = await import('./cron/job_scraper.js');
      const result = await runJobScraper();
      logger.info(`[Scheduler] Job scraper: ${result.newJobs} new jobs found`);
      await saveLastRun('jobs');
    } catch (err) {
      logger.error('[Scheduler] Job scraper error:', err?.message || err);
    }
  }, { timezone: 'Etc/UTC' });

  // ── Tech News Webhook — 8AM/11AM/2PM/5PM/8PM PDT = 15:00/18:00/21:00/00:00/03:00 UTC ──
  const TECH_NEWS_CRON = '0 15,18,21,0,3 * * *';
  const techNewsTask = cron.schedule(TECH_NEWS_CRON, async () => {
    const now = new Date();
    logger.info(`[Scheduler] Tech news triggered at ${now.toISOString()} (${now.toLocaleString('en-US', { timezone: 'Etc/UTC' })} PDT)`);
    try {
      const { runTechNews } = await import('./cron/tech_news_webhook.js');
      const result = await runTechNews();
      logger.info(`[Scheduler] Tech news: ${result.items} items sent`);
      await saveLastRun('techNews');
    } catch (err) {
      logger.error('[Scheduler] Tech news error:', err?.message || err);
    }
  }, { timezone: 'Etc/UTC' });

  // ── Algo Webhook — 8:00 AM PDT = 15:00 UTC ──
  const ALGO_CRON = '0 15 * * *';
  algoTask = cron.schedule(ALGO_CRON, async () => {
    logger.info('[Scheduler] Algo webhook triggered');
    try {
      const { runAlgoWebhook } = await import('./cron/algo_webhook.js');
      const result = await runAlgoWebhook();
      logger.info(`[Scheduler] Algo webhook: ${result.sent ? 'sent' : 'skipped (already sent today)'}`);
      await saveLastRun('algo');
    } catch (err) {
      logger.error('[Scheduler] Algo webhook error:', err?.message || err);
    }
  }, { timezone: 'Etc/UTC' });

  // ── Start all cron jobs ──
  task.start();
  memoryTask.start();
  backupTask.start();
  evoTask.start();
  graphTask.start();
  suggestionTask.start();
  rssTask.start();
  jobTask.start();
  techNewsTask.start();
  algoTask.start();

  // ── Step 5: Morning Health Check — 8:00 AM PDT ──
  const healthTask = cron.schedule('0 8 * * *', async () => {
    logger.info('[Scheduler] Morning health check triggered');
    try {
      const { runHealthCheck, formatHealthMessage } = await import('./lib/health_check.js');
      const result = await runHealthCheck();
      const message = formatHealthMessage(result);

      // Gửn Discord alert nếu có issues
      if (!result.healthy) {
        const { sendWebhook } = await import('./lib/webhook.js');
        await sendWebhook(process.env.DISCORD_WEBHOOK_URL, {
          embeds: [{ color: 0xffaa00, title: message, timestamp: new Date().toISOString() }],
        });
      }
      logger.info(`[Scheduler] Health check: ${result.healthy ? 'HEALTHY' : `${result.errors.length} issues`}`);
    } catch (err) {
      logger.error('[Scheduler] Health check error:', err?.message || err);
    }
  }, { timezone: 'Etc/UTC' });
  healthTask.start();

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
  rssTask?.stop();
  jobTask?.stop();
  algoTask?.stop();
  algoAnswerTask?.stop();

  process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
