/**
 * ═══════════════════════════════════════════════════════════════
 * Cloud Scheduler Triggers — Replace node-cron scheduler.js
 * ═══════════════════════════════════════════════════════════════
 *
 * Google Cloud Scheduler → HTTP POST → /scheduler/:job (Cloud Run)
 *
 * CƠ CHẾ:
 *   Cloud Scheduler (cron trên mây) → bắt request → Cloud Run thức dậy
 *   → xử lí job → trả 200 → ngủ đông
 *
 * Thay thế hoàn toàn scheduler.js (node-cron chạy 24/7 trong process).
 * Không tốn CPU khi không có job.
 *
 * @module cloud_scheduler_triggers
 */

import 'dotenv/config';
import { main as runTechNews } from './tech_news_webhook.js';
import { main as runAlgoWebhook } from './algo_webhook.js';
import { runJobScraper } from './job_scraper.js';
import { runNightlyScraper } from './nightly_scraper.js';

// ═══════════════════════════════════════════════════════════
//  JOB HANDLERS
// ═══════════════════════════════════════════════════════════

const jobHandlers = new Map();

export function registerJob(name, handler) {
  jobHandlers.set(name, handler);
}

export async function handleJob(jobName) {
  const handler = jobHandlers.get(jobName);
  if (!handler) {
    return { ok: false, error: `Unknown job: ${jobName}` };
  }

  console.log(`[CloudScheduler] Starting job: ${jobName} at ${new Date().toISOString()}`);
  const startTime = Date.now();

  try {
    const result = await handler();
    const duration = Date.now() - startTime;
    console.log(`[CloudScheduler] Job ${jobName} completed in ${duration}ms`);
    return { ok: true, duration, ...result };
  } catch (err) {
    console.error(`[CloudScheduler] Job ${jobName} failed:`, err?.message || err);
    return { ok: false, error: err?.message || String(err), duration: Date.now() - startTime };
  }
}

// ═══════════════════════════════════════════════════════════
//  REGISTER JOBS (ported from scheduler.js)
// ═══════════════════════════════════════════════════════════

/**
 * Memory Consolidation — Chạy 2:00 AM mỗi ngày
 */
registerJob('memory', async () => {
  const { archiveOldMemories, getRecentMemory } = await import('./lib/memory_manager.js');
  const { embedText } = await import('./lib/embeddings.js');
  const { upsertAcademic, upsertSystem, upsertDaily } = await import('./lib/vector_collections.js');

  const recentMemories = await getRecentMemory(7);
  if (!recentMemories || recentMemories.length === 0) {
    return { message: 'No recent memories to consolidate' };
  }

  const academicItems = [];
  const systemItems = [];
  const dailyItems = [];

  for (const mem of recentMemories) {
    const content = mem.content || '';
    const tags = (mem.tags || []).join(',');
    if (tags.includes('discord') || tags.includes('user-memory')) {
      dailyItems.push({ ...mem, content });
    } else if (tags.includes('system') || tags.includes('error') || tags.includes('log')) {
      systemItems.push({ ...mem, content });
    } else {
      academicItems.push({ ...mem, content });
    }
  }

  const processItems = async (items, upsertFn, name) => {
    if (items.length === 0) return;

    const combinedText = items.map(i => i.content).join('\n').slice(0, 4000);
    const docId = `${name}:${new Date().toISOString().slice(0, 10)}`;

    const embedding = await embedText(combinedText);
    if (!embedding?.length) {
      return { skipped: true, reason: 'embedding failed', name };
    }

    await upsertFn(
      docId,
      {
        url: 'scheduler://consolidation',
        project: name,
        category: 'Memory',
        type: 'consolidated',
      },
      [combinedText],
      [embedding]
    );

    return { saved: true, items: items.length, name };
  };

  const results = await Promise.allSettled([
    processItems(academicItems, upsertAcademic, 'academic'),
    processItems(systemItems, upsertSystem, 'system'),
    processItems(dailyItems, upsertDaily, 'daily'),
  ]);

  for (const r of results) {
    if (r.status === 'rejected') {
      console.error('[CloudScheduler] memory collection failed:', r.reason?.message || r.reason);
    }
  }

  await archiveOldMemories(30);
  return { message: `Consolidated ${recentMemories.length} memories` };
});

/**
 * Weekly Backup — Chạy 3:00 AM Chủ Nhật
 */
registerJob('backup', async () => {
  const { execSync } = await import('child_process');
  const result = execSync('node scripts/backup_db.js', { encoding: 'utf8', timeout: 60000 });
  return { message: 'Backup completed', output: result.slice(0, 500) };
});

/**
 * Evolution Evaluation — Chạy 4:00 AM mỗi ngày/tuần theo scheduler.js (hiện port: 4:00 AM thứ 2)
 */
registerJob('evolution', async () => {
  const { getEvaluationStats, getModelPerformanceReport, detectKnowledgeGaps } = await import('./lib/self_evolution.js');

  const evalStats = getEvaluationStats();
  const modelPerf = getModelPerformanceReport();
  const gaps = await detectKnowledgeGaps();

  return {
    message: 'Evolution evaluation completed',
    evaluation: evalStats,
    modelPerformance: modelPerf,
    knowledgeGaps: gaps,
  };
});

/**
 * Pipeline Report — Chạy theo lịch từ scheduler.js
 */
registerJob('pipeline', async () => {
  const { addJob, JobType, QueueName } = await import('./lib/task_queue.js');
  await addJob(QueueName.PRIORITY, JobType.RUN_PIPELINE, {
    topic: process.env.PIPELINE_TOPIC || 'beginner',
    force: false,
  });
  return { message: 'Pipeline job queued' };
});

/**
 * Graph Sync — Đồng bộ knowledge graph
 */
registerJob('graph', async () => {
  const { getGraphStats } = await import('./lib/knowledge_graph.js');
  const stats = await getGraphStats();
  return { message: 'Graph sync completed', stats };
});

// ────────────────────────────────────────────────────────────────
// Tech News — Port từ scheduler.js (job “techNews”)
// ────────────────────────────────────────────────────────────────
registerJob('techNews', async () => {
  const { runTechNews } = await import('./cron/tech_news_webhook.js');
  const result = await runTechNews();
  return { message: 'Tech news completed', result };
});

// ────────────────────────────────────────────────────────────────
// Algo Webhook — Port từ scheduler.js (job “algo”)
// ────────────────────────────────────────────────────────────────
registerJob('algo', async () => {
  const { runAlgoWebhook } = await import('./cron/algo_webhook.js');
  const result = await runAlgoWebhook();
  return { message: 'Algo webhook completed', result };
});

