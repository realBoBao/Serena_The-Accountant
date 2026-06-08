import { spawn } from 'child_process';
import cron from 'node-cron';
import { addJob, JobType, QueueName } from './lib/task_queue.js';

const CRON_SCHEDULE = process.env.CRON_SCHEDULE || '0 8,20 * * *';
const RUN_ON_START = process.env.RUN_ON_START !== 'false';
const FORCE_RUN = process.env.FORCE_PIPELINE === 'true';
const TOPIC_OVERRIDE = process.env.PIPELINE_TOPIC || '';

// ── Memory Consolidation: 2:00 AM mỗi ngày ──
// Tóm tắt lịch sử chat Discord hôm qua → nhúng vector → lưu vào long-term memory
const MEMORY_CRON = '0 2 * * *';

// ── Disaster Recovery: 3:00 AM Chủ Nhật hàng tuần ──
// Backup toàn bộ DB (vectors.db, data.db, artifacts) vào thư mục backups/
const BACKUP_CRON = '0 3 * * 0';

async function runMemoryConsolidation() {
  console.log('[scheduler] Starting memory consolidation at', new Date().toISOString());

  try {
    const { archiveOldMemories, getRecentMemories } = await import('./lib/memory_manager.js');
    const { embedText } = await import('./lib/embeddings.js');
    const { upsertAcademic, upsertSystem, upsertDaily } = await import('./lib/vector_collections.js');

    // Lấy memories từ 7 ngày qua
    const recentMemories = await getRecentMemories(7);
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
      
      const embedding = await embedText(combinedText);
      await upsertFn(docId, {
        url: 'scheduler://consolidation',
        project: collectionName,
        category: 'Memory',
        type: 'consolidated',
      }, [combinedText], [embedding]);
      
      console.log(`[scheduler] Consolidated ${items.length} items to ${collectionName}`);
    };

    await Promise.all([
      processItems(academicItems, upsertAcademic, 'academic-docs'),
      processItems(systemItems, upsertSystem, 'system-logs'),
      processItems(dailyItems, upsertDaily, 'daily-memory'),
    ]);

    // Archive memories cũ
    await archiveOldMemories(30);
    console.log('[scheduler] Memory consolidation completed');
    await saveLastRun('memory');
  } catch (err) {
    console.error('[scheduler] Memory consolidation error:', err?.message || err);
  }
}

function runPipeline() {
  const args = ['pipeline_report_v2.js'];
  if (TOPIC_OVERRIDE) args.push(TOPIC_OVERRIDE);
  if (FORCE_RUN) args.push('--force');

  console.log(`[scheduler] Starting pipeline at ${new Date().toISOString()}`);
  console.log('[scheduler] Command:', 'node', args.join(' '));

  const child = spawn('node', args, { stdio: 'inherit' });

  child.on('exit', (code, signal) => {
    if (signal) {
      console.log(`[scheduler] Pipeline process terminated with signal ${signal}`);
    } else {
      console.log(`[scheduler] Pipeline process exited with code ${code}`);
    }
    saveLastRun('pipeline').catch(() => {});
  });

  child.on('error', (err) => {
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

async function checkCatchUp() {
  const fs = await import('fs');
  const now = new Date();
  const currentHour = now.getHours();
  const currentDay = now.getDay(); // 0=Sun, 1=Mon, ...

  // Đọc last run times
  let lastRuns = {};
  try {
    if (fs.existsSync(CATCH_UP_FILE)) {
      lastRuns = JSON.parse(fs.readFileSync(CATCH_UP_FILE, 'utf8'));
    }
  } catch { /* ignore */ }

  const lastPipeline = lastRuns.pipeline ? new Date(lastRuns.pipeline) : null;
  const lastMemory = lastRuns.memory ? new Date(lastRuns.memory) : null;
  const lastBackup = lastRuns.backup ? new Date(lastRuns.backup) : null;
  const lastEvo = lastRuns.evo ? new Date(lastRuns.evo) : null;
  const lastGraph = lastRuns.graph ? new Date(lastRuns.graph) : null;

  const hoursSince = (date) => date ? (now - date) / 3600000 : Infinity;

  console.log('[scheduler] Catch-up check:');
  console.log(`  Pipeline: last run ${lastPipeline ? hoursSince(lastPipeline).toFixed(1) + 'h ago' : 'never'}`);
  console.log(`  Memory:   last run ${lastMemory ? hoursSince(lastMemory).toFixed(1) + 'h ago' : 'never'}`);
  console.log(`  Backup:   last run ${lastBackup ? hoursSince(lastBackup).toFixed(1) + 'h ago' : 'never'}`);

  // Pipeline catch-up: nếu quá 12h chưa chạy → chạy bù
  if (hoursSince(lastPipeline) > 12) {
    console.log('[scheduler] ⚠️ Pipeline missed! Running catch-up...');
    runPipeline();
  }

  // Memory consolidation catch-up: nếu quá 24h chưa chạy → chạy bù
  if (hoursSince(lastMemory) > 24) {
    console.log('[scheduler] ⚠️ Memory consolidation missed! Running catch-up...');
    runMemoryConsolidation();
  }

  // Backup catch-up: nếu quá 7 ngày chưa chạy (chủ nhật) → chạy bù
  if (hoursSince(lastBackup) > 168) {
    console.log('[scheduler] ⚠️ Backup missed! Running catch-up...');
    runBackup();
  }

  // EvoAgent catch-up: nếu quá 24h chưa chạy → chạy bù
  if (hoursSince(lastEvo) > 24) {
    console.log('[scheduler] ⚠️ EvoAgent missed! Running catch-up...');
    try {
      await addJob(QueueName.EVOLUTION, JobType.AUTO_EVALUATE, { timestamp: Date.now() }, { priority: 3 });
    } catch { /* ignore */ }
  }

  // GraphAgent catch-up: nếu quá 7 ngày chưa chạy → chạy bù
  if (hoursSince(lastGraph) > 168) {
    console.log('[scheduler] ⚠️ GraphAgent missed! Running catch-up...');
    try {
      await addJob(QueueName.GRAPH, JobType.SYNC_GRAPH, { timestamp: Date.now() }, { priority: 5 });
    } catch { /* ignore */ }
  }
}

// Lưu last run time
async function saveLastRun(type) {
  try {
    const fs = await import('fs');
    let lastRuns = {};
    if (fs.existsSync(CATCH_UP_FILE)) {
      lastRuns = JSON.parse(fs.readFileSync(CATCH_UP_FILE, 'utf8'));
    }
    lastRuns[type] = new Date().toISOString();
    fs.writeFileSync(CATCH_UP_FILE, JSON.stringify(lastRuns, null, 2));
  } catch (err) {
    console.error('[scheduler] saveLastRun failed:', err?.message || err);
  }
}

// Chạy catch-up check khi start (delay 60s để services khác khởi động xong)
setTimeout(() => {
  checkCatchUp().catch(err => console.error('[scheduler] Catch-up check failed:', err?.message || err));
}, 60000);

if (RUN_ON_START) {
  // Delay 30s startup to let other services initialize first
  setTimeout(() => {
    try {
      runPipeline();
    } catch (err) {
      console.error('[scheduler] Startup pipeline failed:', err?.message || err);
    }
  }, 30000);
}

const task = cron.schedule(CRON_SCHEDULE, () => {
  console.log('[scheduler] Cron triggered at', new Date().toISOString());
  runPipeline();
  saveLastRun('pipeline').catch(() => {});
});

// Memory consolidation: 2:00 AM mỗi ngày
const memoryTask = cron.schedule(MEMORY_CRON, () => {
  console.log('[scheduler] Memory consolidation triggered at', new Date().toISOString());
  runMemoryConsolidation();
  saveLastRun('memory').catch(() => {});
});

// Disaster Recovery: 3:00 AM Chủ Nhật hàng tuần
const backupTask = cron.schedule(BACKUP_CRON, () => {
  console.log('[scheduler] Backup triggered at', new Date().toISOString());
  runBackup();
  saveLastRun('backup').catch(() => {});
});

// ── Proactive Suggestion: 8:00 AM mỗi ngày — Gợi ý học tập chủ động ──
const SUGGESTION_CRON = '0 8 * * *';
const suggestionTask = cron.schedule(SUGGESTION_CRON, async () => {
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
const evoTask = cron.schedule(EVO_CRON, async () => {
  console.log('[scheduler] EvoAgent analysis triggered at', new Date().toISOString());
  try {
    await addJob(QueueName.EVOLUTION, JobType.AUTO_EVALUATE, {
      timestamp: Date.now(),
    }, { priority: 3 });

    // Trigger knowledge gap detection monthly
    const today = new Date();
    if (today.getDate() === 1) {
      await addJob(QueueName.EVOLUTION, JobType.KNOWLEDGE_GAP_DETECTION, {
        timestamp: Date.now(),
      }, { priority: 3 });
    }
    await saveLastRun('evo');
  } catch (err) {
    console.error('[scheduler] EvoAgent error:', err?.message || err);
  }
});

// ── GraphAgent: 5:00 AM Chủ Nhật — Đồng bộ Knowledge Graph ──
const GRAPH_CRON = '0 5 * * 0';
const graphTask = cron.schedule(GRAPH_CRON, async () => {
  console.log('[scheduler] GraphAgent sync triggered at', new Date().toISOString());
  try {
    await addJob(QueueName.GRAPH, JobType.SYNC_GRAPH, {
      timestamp: Date.now(),
    }, { priority: 5 });

    // Repair broken connections monthly
    const today = new Date();
    if (today.getDate() === 1) {
      await addJob(QueueName.GRAPH, JobType.REPAIR_GRAPH_CONNECTIONS, {
        timestamp: Date.now(),
      }, { priority: 4 });
    }
    await saveLastRun('graph');
  } catch (err) {
    console.error('[scheduler] GraphAgent error:', err?.message || err);
  }
});

// ── Data Pipeline: 14:00 & 20:00 mỗi ngày (PDT/UTC-7) — Search & Scrape tài liệu ──
// Dùng timezone PDT để chạy đúng giờ địa phương
const PIPELINE_CRON = '0 14,20 * * *';
const pipelineTask = cron.schedule(PIPELINE_CRON, () => {
  console.log('[scheduler] Pipeline triggered at', new Date().toISOString());
  // Chạy pipeline trong background process để không block scheduler
  const child = spawn('node', ['pipeline_report_v2.js'], {
    stdio: 'inherit',
    detached: true,
  });
  child.unref();
  console.log(`[scheduler] Pipeline spawned with PID ${child.pid}`);
}, {
  timezone: 'America/Los_Angeles', // PDT (UTC-7) — tự động adjust DST
});

task.start();
memoryTask.start();
backupTask.start();
evoTask.start();
graphTask.start();
pipelineTask.start();

async function gracefulShutdown(signal) {
  console.log(`[scheduler] Received ${signal}, stopping all cron tasks...`);
  task.stop();
  memoryTask.stop();
  backupTask.stop();
  evoTask.stop();
  graphTask.stop();
  pipelineTask.stop();

  process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
