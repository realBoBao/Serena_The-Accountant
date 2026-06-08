/**
 * EvoAgent — Kỹ sư Tự tiến hóa (Standalone PM2 Service)
 *
 * Background maintenance agent: monitors logs, detects OOM errors,
 * tracks quiz scores, optimizes hyperparameters, and repairs knowledge gaps.
 * Runs independently via PM2 + BullMQ worker.
 *
 * @module agents/EvoAgent
 */

import { createWorker, addJob, JobType, QueueName } from '../lib/task_queue.js';
import { Gauge, Counter } from 'prom-client';

// ── Prometheus Metrics ──
const evoActionsTotal = new Counter({
  name: 'evo_agent_actions_total',
  help: 'Total EvoAgent optimization actions',
  labelNames: ['action', 'reason'],
});

const evoQuizAvgScore = new Gauge({
  name: 'evo_agent_quiz_avg_score',
  help: 'Average quiz score tracked by EvoAgent',
});

const evoSystemHealth = new Gauge({
  name: 'evo_agent_system_health',
  help: 'System health score (0-100)',
});

// ── Module-level state ──
const state = {
  worker: null,
  healthInterval: null,
  metricsInterval: null,
  isRunning: false,
  metricsHistory: [],
  optimizations: [],
  maxHistory: 50,
  maxOptimizations: 20,
  thresholds: {
    memoryUsage: 85,
    cpuThreshold: 90,
    quizScoreDrop: 0.2,
    oomErrors: 3,
    healthCheckInterval: 600000,
  },
  srParams: {
    intervals: [1, 3, 7, 14, 30, 60, 180],
    easeFactor: 2.5,
    minEase: 1.3,
    batchSize: 50,
    cacheSize: 200,
  },
};

// ── Job Processor ──
async function processJob(job) {
  const { name, data } = job;
  console.log(`[EvoAgent] Processing job: ${name}`);

  switch (name) {
    case JobType.AUTO_EVALUATE:
      return autoEvaluate(data);
    case JobType.SELF_REPAIR:
      return selfRepair(data);
    case JobType.KNOWLEDGE_GAP_DETECTION:
      return detectKnowledgeGaps(data);
    case JobType.OPTIMIZE_HYPERPARAMS:
      return optimizeHyperparameters(data);
    case JobType.UPDATE_SPACED_REPETITION:
      return updateSpacedRepetition(data);
    default:
      console.warn(`[EvoAgent] Unknown job type: ${name}`);
      return { skipped: true, reason: 'unknown_job_type' };
  }
}

// ── Health Monitor ──
async function analyzeSystemHealth() {
  try {
    const metrics = await collectCurrentMetrics();
    state.metricsHistory.push({ ts: Date.now(), ...metrics });
    if (state.metricsHistory.length > state.maxHistory) {
      state.metricsHistory = state.metricsHistory.slice(-state.maxHistory);
    }

    const healthScore = calculateHealthScore(metrics);
    evoSystemHealth.set(healthScore);

    await checkOomErrors();
    await checkQuizScoreTrend();
    await checkMemoryPressure(metrics);

    console.log(`[EvoAgent] Health score: ${healthScore}/100`);
  } catch (err) {
    console.error('[EvoAgent] Health analysis error:', err.message);
  }
}

async function collectCurrentMetrics() {
  const mem = process.memoryUsage();
  const metrics = {
    rss: mem.rss,
    heapUsed: mem.heapUsed,
    heapTotal: mem.heapTotal,
    external: mem.external,
    timestamp: Date.now(),
  };

  try {
    const { getDueCount, getRecentStats } = await import('../lib/flashcard_db.js');
    metrics.flashcardsDue = await getDueCount();
    const stats = await getRecentStats(7);
    metrics.quizAvgScore = stats.avgScore || 0;
    metrics.quizTotalReviews = stats.total || 0;
  } catch {
    metrics.flashcardsDue = 0;
    metrics.quizAvgScore = 0;
  }

  return metrics;
}

function calculateHealthScore(metrics) {
  let score = 100;
  const memPercent = (metrics.heapUsed / metrics.heapTotal) * 100;
  if (memPercent > 80) score -= (memPercent - 80) * 2;
  if (metrics.quizAvgScore > 0 && metrics.quizAvgScore < 0.6) {
    score -= (0.6 - metrics.quizAvgScore) * 50;
  }
  return Math.max(0, Math.min(100, Math.round(score)));
}

async function checkOomErrors() {
  try {
    const { searchSystemLogs } = await import('../lib/vector_collections.js');
    const oomResults = await searchSystemLogs('out of memory OOM killed', 1);
    const recentOomCount = oomResults?.length || 0;

    if (recentOomCount >= state.thresholds.oomErrors) {
      console.warn(`[EvoAgent] Detected ${recentOomCount} OOM events — triggering optimization`);
      await addJob(QueueName.EVOLUTION, JobType.OPTIMIZE_HYPERPARAMS, {
        reason: 'oom_errors',
        count: recentOomCount,
        timestamp: Date.now(),
      }, { priority: 1 });
      evoActionsTotal.inc({ action: 'optimize_hyperparams', reason: 'oom_errors' });
    }
  } catch { /* skip silently */ }
}

async function checkQuizScoreTrend() {
  if (state.metricsHistory.length < 20) return;

  const recent = state.metricsHistory.slice(-10);
  const older = state.metricsHistory.slice(-20, -10);
  const recentAvg = recent.reduce((a, b) => a + (b.quizAvgScore || 0), 0) / recent.length;
  const olderAvg = older.reduce((a, b) => a + (b.quizAvgScore || 0), 0) / older.length;

  evoQuizAvgScore.set(recentAvg);

  if (olderAvg > 0 && (olderAvg - recentAvg) / olderAvg > state.thresholds.quizScoreDrop) {
    console.warn(`[EvoAgent] Quiz score dropped ${(olderAvg - recentAvg).toFixed(2)} — adjusting SR`);
    await addJob(QueueName.EVOLUTION, JobType.UPDATE_SPACED_REPETITION, {
      reason: 'score_drop',
      recentAvg,
      olderAvg,
      dropPercent: ((olderAvg - recentAvg) / olderAvg * 100).toFixed(1),
    }, { priority: 2 });
    evoActionsTotal.inc({ action: 'update_sr_params', reason: 'score_drop' });
  }
}

async function checkMemoryPressure(metrics) {
  const memPercent = (metrics.heapUsed / metrics.heapTotal) * 100;
  if (memPercent > state.thresholds.memoryUsage) {
    console.warn(`[EvoAgent] Memory usage ${memPercent.toFixed(1)}% — triggering optimization`);
    await addJob(QueueName.EVOLUTION, JobType.OPTIMIZE_HYPERPARAMS, {
      reason: 'memory_pressure',
      memPercent,
    }, { priority: 2 });
    evoActionsTotal.inc({ action: 'optimize_hyperparams', reason: 'memory_pressure' });
  }
}

// ── Job Handlers ──
async function optimizeHyperparameters(data) {
  console.log(`[EvoAgent] Optimizing hyperparameters — reason: ${data.reason}`);
  const before = { ...state.srParams };

  switch (data.reason) {
    case 'oom_errors':
      state.srParams.batchSize = Math.max(10, Math.floor(state.srParams.batchSize * 0.7));
      state.srParams.cacheSize = Math.max(50, Math.floor(state.srParams.cacheSize * 0.6));
      break;
    case 'memory_pressure':
      state.srParams.batchSize = Math.max(5, Math.floor(state.srParams.batchSize * 0.5));
      state.srParams.cacheSize = Math.max(20, Math.floor(state.srParams.cacheSize * 0.5));
      break;
    default:
      return { action: 'no_change', reason: 'unknown_reason' };
  }

  const result = { action: 'optimized', reason: data.reason, before, after: { ...state.srParams }, timestamp: new Date().toISOString() };
  state.optimizations.push(result);
  if (state.optimizations.length > state.maxOptimizations) {
    state.optimizations = state.optimizations.slice(-state.maxOptimizations);
  }
  return result;
}

async function updateSpacedRepetition(data) {
  console.log(`[EvoAgent] Updating spaced repetition — reason: ${data.reason}`);
  const before = { ...state.srParams };

  if (data.reason === 'score_drop') {
    state.srParams.intervals = state.srParams.intervals.map(i => Math.max(1, Math.floor(i * 0.85)));
    state.srParams.easeFactor = Math.max(state.srParams.minEase, +(state.srParams.easeFactor - 0.1).toFixed(2));
  }

  const result = { action: 'updated_sr', reason: data.reason, before, after: { ...state.srParams }, timestamp: new Date().toISOString() };
  state.optimizations.push(result);
  if (state.optimizations.length > state.maxOptimizations) {
    state.optimizations = state.optimizations.slice(-state.maxOptimizations);
  }
  return result;
}

async function autoEvaluate(data) {
  const metrics = await collectCurrentMetrics();
  const healthScore = calculateHealthScore(metrics);
  return {
    evaluated: true,
    healthScore,
    metrics: {
      rssMB: (metrics.rss / 1048576).toFixed(1),
      heapUsedMB: (metrics.heapUsed / 1048576).toFixed(1),
      quizAvgScore: metrics.quizAvgScore,
      flashcardsDue: metrics.flashcardsDue,
    },
    timestamp: new Date().toISOString(),
  };
}

async function selfRepair(data) {
  console.log('[EvoAgent] Running self-repair pipeline');
  const repairs = [];

  try {
    const { getAllQueueStats } = await import('../lib/task_queue.js');
    const stats = await getAllQueueStats();
    for (const [name, s] of Object.entries(stats)) {
      if (s.failed > 10) repairs.push({ queue: name, action: 'alert_high_failures', count: s.failed });
    }
  } catch (err) {
    repairs.push({ action: 'queue_check_failed', error: err.message });
  }

  try {
    const { getDueCount } = await import('../lib/flashcard_db.js');
    await getDueCount();
    repairs.push({ action: 'db_check', status: 'ok' });
  } catch (err) {
    repairs.push({ action: 'db_check', status: 'error', error: err.message });
  }

  return { repaired: true, repairs, timestamp: new Date().toISOString() };
}

async function detectKnowledgeGaps(data) {
  console.log('[EvoAgent] Detecting knowledge gaps');
  const gaps = [];

  try {
    const { searchAll } = await import('../lib/vector_collections.js');
    const testTopics = ['algorithms', 'data structures', 'system design', 'machine learning'];
    for (const topic of testTopics) {
      const results = await searchAll(topic, 1);
      if (!results || results.length < 2) {
        gaps.push({ topic, resultCount: results?.length || 0, severity: 'low' });
      }
    }
  } catch (err) {
    gaps.push({ error: err.message });
  }

  return { gaps, timestamp: new Date().toISOString() };
}

// ── Lifecycle ──
async function start() {
  if (state.isRunning) return;
  state.isRunning = true;

  state.worker = await createWorker(
    QueueName.EVOLUTION,
    (job) => processJob(job),
    { concurrency: 2, limiter: { max: 5, duration: 1000 } }
  );

  state.healthInterval = setInterval(() => analyzeSystemHealth(), state.thresholds.healthCheckInterval);
  state.metricsInterval = setInterval(async () => {
    try {
      const metrics = await collectCurrentMetrics();
      state.metricsHistory.push({ ts: Date.now(), rss: metrics.rss, heapUsed: metrics.heapUsed, heapTotal: metrics.heapTotal });
      if (state.metricsHistory.length > state.maxHistory) {
        state.metricsHistory = state.metricsHistory.slice(-state.maxHistory);
      }
      // Auto-trigger GC suggestion if memory high
      const memPercent = (metrics.heapUsed / metrics.heapTotal) * 100;
      if (memPercent > 90) {
        console.warn(`[EvoAgent] High memory usage ${memPercent.toFixed(1)}% — suggesting GC`);
        if (global.gc) global.gc();
      }
    } catch { /* silent */ }
  }, 60000);

  console.log('[EvoAgent] Started — monitoring system health');
}

async function stop() {
  console.log('[EvoAgent] Stopping...');
  state.isRunning = false;
  if (state.healthInterval) clearInterval(state.healthInterval);
  if (state.metricsInterval) clearInterval(state.metricsInterval);
  if (state.worker) await state.worker.close();
  console.log('[EvoAgent] Stopped');
}

function getStatus() {
  return {
    isRunning: state.isRunning,
    thresholds: state.thresholds,
    currentParams: { ...state.srParams },
    historyLength: state.metricsHistory.length,
    optimizationsCount: state.optimizations.length,
    lastOptimizations: state.optimizations.slice(-5),
  };
}

// ── Graceful Shutdown ──
async function gracefulShutdown(signal) {
  console.log(`[EvoAgent] Received ${signal}, shutting down...`);
  await stop();
  process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// ── Auto-start ──
start();

export { start, stop, getStatus, processJob };
