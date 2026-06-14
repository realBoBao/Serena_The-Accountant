import { spawn } from 'child_process';
import cron from 'node-cron';
import { addJob, JobType, QueueName } from './lib/task_queue.js';
import { getLogger } from './lib/logger.js';

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

// Atomic write/read utilities (loaded once)
import { writeJsonAtomic, readJsonSafe } from './lib/atomic_write.js';

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
  const lastEvo = parseLastRun(lastRuns.evo);
  const lastGraph = parseLastRun(lastRuns.graph);

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

  // ── Chạy catch-up cho từng job bị lỡ, lưu kết quả thực tế ──
  const catchUpResults = {}; // { jobName: { output: string, error?: string } }
  const missedJobs = [];

  // Pipeline catch-up (nếu chưa bao giờ chạy → coi như missed)
  const hsPipeline = hoursSince(lastPipeline);
  if (hsPipeline === null || hsPipeline > 12) {
    console.log('[scheduler] ⚠️ Pipeline missed! Running catch-up...');
    try {
      // Chạy pipeline và lấy output (timeout 10 phút)
      const { execSync } = await import('child_process');
      const output = execSync(`node pipeline_report_v2.js --no-webhook`, {
        encoding: 'utf8',
        timeout: 600000,
        maxBuffer: 10 * 1024 * 1024, // 10MB buffer
      });
      // Lấy phần summary từ output (từ dòng "Pipeline completed" trở về trước)
      const lines = output.split('\n');
      const summaryStart = lines.findIndex(l => l.includes('Pipeline completed') || l.includes('Markdown report saved'));
      const summary = summaryStart >= 0 ? lines.slice(Math.max(0, summaryStart - 20)).join('\n') : output.slice(-3000);
      catchUpResults.Pipeline = { output: summary };
      missedJobs.push({ name: 'Pipeline', hours: hsPipeline || 0 });
      console.log('[scheduler] Pipeline catch-up completed, output length:', summary.length);
    } catch (err) {
      catchUpResults.Pipeline = { error: err.message };
      missedJobs.push({ name: 'Pipeline', hours: hsPipeline || 0 });
      console.error('[scheduler] Pipeline catch-up failed:', err.message);
    }
  }

  // Memory consolidation catch-up (nếu chưa bao giờ chạy → coi như missed)
  const hsMemory = hoursSince(lastMemory);
  if (hsMemory === null || hsMemory > 24) {
    console.log('[scheduler] ⚠️ Memory consolidation missed! Running catch-up...');
    try {
      const result = await runMemoryConsolidation();
      catchUpResults.Memory = { output: `Memory consolidation completed. Archived memories.` };
      missedJobs.push({ name: 'Memory', hours: hsMemory });
    } catch (err) {
      catchUpResults.Memory = { error: err.message };
      missedJobs.push({ name: 'Memory', hours: hsMemory });
    }
  }

  // Backup catch-up (nếu chưa bao giờ chạy → coi như missed)
  const hsBackup = hoursSince(lastBackup);
  if (hsBackup === null || hsBackup > 168) {
    console.log('[scheduler] ⚠️ Backup missed! Running catch-up...');
    try {
      const result = await runBackup();
      catchUpResults.Backup = { output: `Backup completed successfully.` };
      missedJobs.push({ name: 'Backup', hours: hsBackup });
    } catch (err) {
      catchUpResults.Backup = { error: err.message };
      missedJobs.push({ name: 'Backup', hours: hsBackup });
    }
  }

  // EvoAgent catch-up (nếu chưa bao giờ chạy → coi như missed)
  const hsEvo = hoursSince(lastEvo);
  if (hsEvo === null || hsEvo > 24) {
    console.log('[scheduler] ⚠️ EvoAgent missed! Running catch-up...');
    try {
      await addJob(QueueName.EVOLUTION, JobType.AUTO_EVALUATE, { timestamp: Date.now() }, { priority: 3 });
      catchUpResults.EvoAgent = { output: 'EvoAgent auto-evaluate job queued.' };
      missedJobs.push({ name: 'EvoAgent', hours: hsEvo });
    } catch (err) {
      catchUpResults.EvoAgent = { error: err.message };
      missedJobs.push({ name: 'EvoAgent', hours: hsEvo });
    }
  }

  // GraphAgent catch-up (nếu chưa bao giờ chạy → coi như missed)
  const hsGraph = hoursSince(lastGraph);
  if (hsGraph === null || hsGraph > 168) {
    console.log('[scheduler] ⚠️ GraphAgent missed! Running catch-up...');
    try {
      await addJob(QueueName.GRAPH, JobType.SYNC_GRAPH, { timestamp: Date.now() }, { priority: 5 });
      catchUpResults.GraphAgent = { output: 'GraphAgent sync job queued.' };
      missedJobs.push({ name: 'GraphAgent', hours: hsGraph });
    } catch (err) {
      catchUpResults.GraphAgent = { error: err.message };
      missedJobs.push({ name: 'GraphAgent', hours: hsGraph });
    }
  }

  // WebhookBot catch-up: kiểm tra xem service có đang chạy không
  try {
    const webhookHealth = await fetch('http://localhost:3007/health', { signal: AbortSignal.timeout(5000) });
    if (!webhookHealth.ok) {
      console.log('[scheduler] ⚠️ WebhookBot not healthy, restarting...');
      // Restart webhook bot via PM2
      const { execSync } = await import('child_process');
      execSync('pm2 restart AI_WebhookBot', { encoding: 'utf8' });
      catchUpResults.WebhookBot = { output: 'WebhookBot restarted via PM2' };
      missedJobs.push({ name: 'WebhookBot', hours: 0 });
    }
  } catch (err) {
    console.log('[scheduler] ⚠️ WebhookBot not running, starting...');
    try {
      const { execSync } = await import('child_process');
      execSync('pm2 start ecosystem.config.cjs --only AI_WebhookBot', { encoding: 'utf8' });
      catchUpResults.WebhookBot = { output: 'WebhookBot started via PM2' };
      missedJobs.push({ name: 'WebhookBot', hours: 0 });
    } catch (startErr) {
      catchUpResults.WebhookBot = { error: startErr.message };
      missedJobs.push({ name: 'WebhookBot', hours: 0 });
    }
  }

  // ── Gửi Discord alert khi service down ──
  if (missedJobs.length > 0) {
    console.log(`[scheduler] ⚠️ Catch-up ran for: ${missedJobs.map(j => j.name).join(', ')}`);
    // Chỉ gửi alert khi có lỗi thực sự
    const failedJobs = missedJobs.filter(j => catchUpResults[j.name]?.error);
    if (failedJobs.length > 0) {
      try {
        const webhookUrl = process.env.DISCORD_WEBHOOK;
        if (webhookUrl) {
          const alertLines = failedJobs.map(j => {
            const detail = catchUpResults[j.name]?.error || '';
            return `❌ **${j.name}** — ${detail.slice(0, 200)}`;
          });
          const payload = {
            content: `🚨 **Service Alert** — ${failedJobs.length} service(s) FAILED\n\n${alertLines.join('\n')}\n\n⏰ ${new Date().toISOString()}`,
          };
          await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
        }
      } catch (notifyErr) {
        console.error('[scheduler] Discord alert failed:', notifyErr.message);
      }
    }
    // const catchUpKey = `catchup_notified_${new Date().toISOString().slice(0, 10)}`;
    // if (!global[catchUpKey]) {
    //   console.log(`[scheduler] 📢 Sending catch-up notification for: ${missedJobs.map(j => j.name).join(', ')}`);
    //   await _sendCatchUpNotification(missedJobs, catchUpResults);
    //   global[catchUpKey] = true;
    // } else {
    //   console.log('[scheduler] Catch-up notification already sent today, skipping');
    // }
  }
}

/**
 * Gửi Discord webhook notification khi catch-up chạy
 */
async function _sendCatchUpNotification(missedJobs, catchUpResults) {
  // Đọc webhook URL từ .env file trực tiếp (child process không có process.env)
  let webhookUrl = process.env.DISCORD_WEBHOOK;
  if (!webhookUrl) {
    try {
      const fs = await import('fs');
      const envContent = fs.readFileSync('.env', 'utf8');
      const match = envContent.match(/DISCORD_WEBHOOK="([^"]+)"/);
      webhookUrl = match ? match[1] : null;
    } catch { /* ignore */ }
  }
  if (!webhookUrl) return; // Không có webhook → skip

  // Build fields: mỗi job hiện thời gian lỡ + kết quả thực tế (nếu có)
  const fields = missedJobs.map(job => {
    const result = catchUpResults[job.name];
    const hoursStr = job.hours === null || job.hours === undefined ? 'never' : `${Number(job.hours).toFixed(1)}h`;
    let value = `Lỡ: ${hoursStr}`;
    if (result?.output) {
      // Có kết quả thực tế → hiển thị output (giới hạn 1024 ký tự cho Discord field)
      const output = String(result.output).slice(0, 1000);
      value += `\n\`\`\`${output}${result.output.length > 1000 ? '...' : ''}\`\`\``;
    } else if (result?.error) {
      value += `\n❌ Lỗi: ${result.error}`;
    } else {
      value += `\n✅ Đã chạy bù`;
    }
    return { name: `⚠️ ${job.name}`, value, inline: false };
  });

  const embed = {
    title: '🔄 Scheduler Catch-Up',
    description: `Máy vừa reboot/sleep. Đã chạy bù **${missedJobs.length}** job bị lỡ:`,
    fields,
    timestamp: new Date().toISOString(),
    color: 0xffaa00,
  };

  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [embed] }),
    });
    console.log('[scheduler] Catch-up notification sent to Discord');
  } catch (err) {
    console.error('[scheduler] Failed to send catch-up notification:', err.message);
  }
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

// Kiểm tra xem job có đang chạy không
function isJobRunning(type) {
  try {
    const lastRuns = readJsonSafe(CATCH_UP_FILE, {});
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
  setTimeout(() => {
    // Skip if catch-up already ran pipeline recently (within 5 minutes)
    try {
      const lastRuns = readJsonSafe(CATCH_UP_FILE, {});
      const lastPipeline = lastRuns.pipeline?.ts ? new Date(lastRuns.pipeline.ts) : null;
      if (lastPipeline && (Date.now() - lastPipeline.getTime()) < 300000) {
        console.log('[scheduler] Startup pipeline skipped — catch-up ran recently');
        return;
      }
    } catch { /* ignore */ }
    try {
      runPipeline();
    } catch (err) {
      console.error('[scheduler] Startup pipeline failed:', err?.message || err);
    }
  }, 30000);
}

// ── Only schedule cron jobs when NOT on Cloud Run ──
// On Cloud Run, use Google Cloud Scheduler → HTTP POST → /scheduler/:job
let task, memoryTask, backupTask, suggestionTask, evoTask, graphTask, pipelineTask, nightlyTask, webhookPushTask;

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
  });

  // Disaster Recovery: 3:00 AM Chủ Nhật hàng tuần
  backupTask = cron.schedule(BACKUP_CRON, () => {
    logger.info('[scheduler] Backup triggered');
    runBackup();
  });

  // ── Proactive Suggestion: 8:00 AM mỗi ngày ──
  const SUGGESTION_CRON = '0 8 * * *';
  suggestionTask = cron.schedule(SUGGESTION_CRON, async () => {
  console.log('[scheduler] Proactive suggestion triggered at', new Date().toISOString());
  try {
    const { runContextMonitor } = await import('./agents/SuggestionAgent.js');
    const result = await runContextMonitor();
    if (result && result.message) {
      console.log('[scheduler] Proactive suggestions:', result.suggestions.length);
      // Store suggestions for Discord bot to pick up
      const { upsertDaily } = await import('./lib/vector_collections.js');
      const { embedText } = await import('./lib/embeddings.js');
      const embedding = await embedText(result.message);
      await upsertDaily(`suggestion:${Date.now()}`, {
        url: 'scheduler://proactive-suggestion',
        type: 'suggestion',
      }, [result.message], [embedding]);
    }
  } catch (err) {
    console.error('[scheduler] Suggestion error:', err?.message || err);
  }
});

// ── EvoAgent: 4:00 AM mỗi ngày — Phân tích logs & tối ưu hệ thống ──
  const EVO_CRON = '0 4 * * *';
  evoTask = cron.schedule(EVO_CRON, async () => {
    logger.info('[scheduler] EvoAgent analysis triggered');
    try {
      await addJob(QueueName.EVOLUTION, JobType.AUTO_EVALUATE, { timestamp: Date.now() }, { priority: 3 });
      const today = new Date();
      if (today.getDate() === 1) {
        await addJob(QueueName.EVOLUTION, JobType.KNOWLEDGE_GAP_DETECTION, { timestamp: Date.now() }, { priority: 3 });
      }
      await saveLastRun('evo');
    } catch (err) {
      logger.errorObj('[scheduler] EvoAgent error', err);
    }
  });

  // ── GraphAgent: 5:00 AM Chủ Nhật — Đồng bộ Knowledge Graph ──
  const GRAPH_CRON = '0 5 * * 0';
  graphTask = cron.schedule(GRAPH_CRON, async () => {
    logger.info('[scheduler] GraphAgent sync triggered');
    try {
      await addJob(QueueName.GRAPH, JobType.SYNC_GRAPH, { timestamp: Date.now() }, { priority: 5 });
      const today = new Date();
      if (today.getDate() === 1) {
        await addJob(QueueName.GRAPH, JobType.REPAIR_GRAPH_CONNECTIONS, { timestamp: Date.now() }, { priority: 4 });
      }
      await saveLastRun('graph');
    } catch (err) {
      logger.errorObj('[scheduler] GraphAgent error', err);
    }
  });

  // ── Data Pipeline: 14:00 & 20:00 mỗi ngày ──
  const PIPELINE_CRON = '0 14,20 * * *';
  pipelineTask = cron.schedule(PIPELINE_CRON, () => {
    logger.info('[scheduler] Pipeline triggered');
    const child = spawn('node', ['pipeline_report_v2.js'], { stdio: 'inherit', detached: true });
    child.unref();
    logger.info(`[scheduler] Pipeline spawned PID ${child.pid}`);
  }, { timezone: 'America/Los_Angeles' });

  // ── Nightly Scraper: 2:00 AM mỗi ngày ──
  const NIGHTLY_CRON = '0 2 * * *';
  nightlyTask = cron.schedule(NIGHTLY_CRON, async () => {
    logger.info('[scheduler] Nightly scraper triggered');
    try {
      const { runNightlyScraper } = await import('./scripts/nightly_scraper.js');
      const result = await runNightlyScraper();
      logger.info(`[scheduler] Nightly scraper done: ${result.stored} docs stored`);
      await saveLastRun('nightly');
    } catch (err) {
      logger.errorObj('[scheduler] Nightly scraper error', err);
    }
  }, { timezone: 'America/Los_Angeles' });

  // ── Webhook Source Push: 8:00 AM & 8:00 PM ──
  const WEBHOOK_PUSH_CRON = '0 8,20 * * *';
  webhookPushTask = cron.schedule(WEBHOOK_PUSH_CRON, async () => {
    logger.info('[scheduler] Webhook source push triggered');
    try {
      const { runNightlyScraper } = await import('./scripts/nightly_scraper.js');
      const result = await runNightlyScraper();
      const webhookUrl = `http://localhost:${process.env.WEBHOOK_BOT_PORT || 3007}/webhook/pipeline`;
      await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: result.stored > 0 ? 'success' : 'partial',
          topic: 'Nightly Source Push',
          results: {
            arxiv: result.breakdown?.arxiv || 0,
            stackoverflow: result.breakdown?.stackoverflow || 0,
            hackernews: result.breakdown?.hackernews || 0,
            github: result.breakdown?.github || 0,
            reddit: result.breakdown?.reddit || 0,
            youtube: result.breakdown?.youtube || 0,
            total: result.stored,
          },
          duration: result.duration,
        }),
      });
      if (result.stored > 0) {
        const alertUrl = `http://localhost:${process.env.WEBHOOK_BOT_PORT || 3007}/webhook/alert`;
        await fetch(alertUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            severity: 'info',
            title: '📚 New Sources Ingested',
            message: `Nightly scraper stored **${result.stored}** new documents.`,
            source: 'nightly_scraper',
          }),
        });
      }
      logger.info(`[scheduler] Webhook push done: ${result.stored} sources sent`);
    } catch (err) {
      logger.errorObj('[scheduler] Webhook push error', err);
    }
  }, { timezone: 'America/Los_Angeles' });

  // ── Start all cron jobs ──
  task.start();
  memoryTask.start();
  backupTask.start();
  suggestionTask.start();
  evoTask.start();
  graphTask.start();
  pipelineTask.start();
  nightlyTask.start();
  webhookPushTask.start();

  logger.info('[Scheduler] All node-cron jobs started');
} // end if (!IS_CLOUD_RUN)

async function gracefulShutdown(signal) {
  console.log(`[scheduler] Received ${signal}, stopping all cron tasks...`);
  task.stop();
  memoryTask.stop();
  backupTask.stop();
  evoTask.stop();
  graphTask.stop();
  pipelineTask.stop();
  suggestionTask.stop();

  process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
