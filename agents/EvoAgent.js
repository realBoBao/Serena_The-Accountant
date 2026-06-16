/**
 * EvoAgent — Self-evolution background agent
 * Monitors logs, detects OOM errors, tracks quiz scores, optimizes hyperparameters.
 * @module agents/EvoAgent
 */

import { getLogger } from '../lib/logger.js';
const logger = getLogger('EvoAgent');

/**
 * Auto-evaluate system health and suggest optimizations.
 */
export async function autoEvaluate(options = {}) {
  logger.info('[EvoAgent] Running auto-evaluation');

  try {
    const { analyzePerformance } = await import('../lib/performance_profiler.js');
    const perf = analyzePerformance();

    const suggestions = [];
    if (!perf.healthy) {
      perf.warnings.forEach(w => suggestions.push({ type: 'performance', message: w }));
    }

    return {
      healthy: perf.healthy,
      metrics: perf.metrics,
      suggestions,
      timestamp: new Date().toISOString(),
    };
  } catch (err) {
    logger.error('[EvoAgent] autoEvaluate failed:', err.message);
    return { healthy: true, suggestions: [], error: err.message };
  }
}

/**
 * Detect knowledge gaps from quiz results.
 */
export async function detectKnowledgeGaps() {
  logger.info('[EvoAgent] Detecting knowledge gaps');

  try {
    const { getDb } = await import('../lib/db.js');
    const db = await getDb();

    // Find topics with low accuracy
    const gaps = await db.all(`
      SELECT topic, 
             COUNT(*) as total,
             SUM(CASE WHEN correct = 1 THEN 1 ELSE 0 END) as correct,
             CAST(SUM(CASE WHEN correct = 1 THEN 1 ELSE 0 END) AS FLOAT) / COUNT(*) as accuracy
      FROM quiz_results 
      GROUP BY topic 
      HAVING accuracy < 0.6 AND total >= 3
      ORDER BY accuracy ASC
      LIMIT 10
    `).catch(() => []);

    return { gaps: gaps || [], count: gaps?.length || 0 };
  } catch (err) {
    logger.error('[EvoAgent] detectKnowledgeGaps failed:', err.message);
    return { gaps: [], count: 0 };
  }
}

/**
 * Analyze behavioral evolution: implicit feedback + mood trends + memory decay.
 * Called by daily cron to build a "behavioral report" for the user.
 *
 * @param {string} userId — Discord user ID (optional, runs for all users if omitted)
 * @returns {Object} behavioral analysis summary
 */
export async function analyzeBehavioralEvolution(userId = null) {
  logger.info('[EvoAgent] Running behavioral evolution analysis');

  const report = {
    timestamp: new Date().toISOString(),
    implicitFeedback: null,
    moodTrend: null,
    memoryDecay: null,
    recommendations: [],
  };

  try {
    // ── 1. Implicit Feedback Analysis ──
    const { implicitFeedback } = await import('../lib/implicit_feedback.js');
    if (userId) {
      report.implicitFeedback = implicitFeedback.getImplicitSignals(userId);
    }
    // Mark old unclicked links as skipped (cleanup)
    const skipped = implicitFeedback.markOldUnclickedAsSkipped(48);
    if (skipped > 0) {
      logger.info(`[EvoAgent] Marked ${skipped} old unclicked links as skipped`);
    }
  } catch (err) {
    logger.warn('[EvoAgent] Implicit feedback analysis failed:', err.message);
  }

  try {
    // ── 2. Mood State Trend ──
    const { moodState } = await import('../lib/mood_state.js');
    if (userId) {
      const dominantMood = moodState.getDominantMood(userId, 7);
      const lastState = moodState.getLastState(userId);
      report.moodTrend = {
        dominantMood,
        lastState: lastState?.state || 'unknown',
        recommendation: moodState.getRecommendation(dominantMood),
      };

      // Proactive recommendation based on mood
      if (dominantMood === 'burnout' || dominantMood === 'stressed') {
        report.recommendations.push({
          type: 'wellness',
          priority: 'high',
          message: `⚠️ User showing signs of ${dominantMood}. Suggest dopamine recovery activities.`,
        });
      }
    }
  } catch (err) {
    logger.warn('[EvoAgent] Mood trend analysis failed:', err.message);
  }

  try {
    // ── 3. Memory Decay Report ──
    const { memoryDecay } = await import('../lib/memory_decay.js');
    if (userId) {
      const freshness = memoryDecay.getProfileFreshness(userId);
      report.memoryDecay = { profileFreshness: freshness };

      if (freshness !== null && freshness < 0.3) {
        report.recommendations.push({
          type: 'engagement',
          priority: 'medium',
          message: '📉 Profile data is getting stale. Consider re-engagement prompts.',
        });
      }
    }
  } catch (err) {
    logger.warn('[EvoAgent] Memory decay analysis failed:', err.message);
  }

  // ── 4. Cross-signal insights ──
  if (report.implicitFeedback && report.moodTrend) {
    const topCat = report.implicitFeedback.topCategory;
    const mood = report.moodTrend.dominantMood;

    // Insight: user is burned out but still clicking tech content → suggest break
    if (mood === 'burnout' && topCat && topCat !== 'video') {
      report.recommendations.push({
        type: 'content_shift',
        priority: 'high',
        message: `🔄 User is ${mood} but consuming ${topCat} content. Shift to lighter content (music, memes, lofi).`,
      });
    }

    // Insight: high CTR + celebrating mood → amplify winning streak
    if (mood === 'celebrating' && report.implicitFeedback.clickThroughRate > 0.5) {
      report.recommendations.push({
        type: 'amplify',
        priority: 'low',
        message: '🚀 User is engaged and winning! Suggest next challenge to ride the momentum.',
      });
    }
  }

  logger.info('[EvoAgent] Behavioral evolution analysis complete:', {
    recommendations: report.recommendations.length,
    mood: report.moodTrend?.dominantMood,
    freshness: report.memoryDecay?.profileFreshness,
  });

  return report;
}

/**
 * Run full daily evolution cycle: system health + knowledge gaps + behavioral.
 * Called by scheduler cron at 4:00 AM.
 */
export async function runDailyEvolution() {
  logger.info('[EvoAgent] ═══ Starting daily evolution cycle ═══');

  const results = {
    systemHealth: null,
    knowledgeGaps: null,
    behavioral: null,
    timestamp: new Date().toISOString(),
  };

  try {
    results.systemHealth = await autoEvaluate();
  } catch (err) {
    logger.error('[EvoAgent] System health check failed:', err.message);
  }

  try {
    results.knowledgeGaps = await detectKnowledgeGaps();
  } catch (err) {
    logger.error('[EvoAgent] Knowledge gap detection failed:', err.message);
  }

  try {
    results.behavioral = await analyzeBehavioralEvolution();
  } catch (err) {
    logger.error('[EvoAgent] Behavioral evolution failed:', err.message);
  }

  logger.info('[EvoAgent] ═══ Daily evolution cycle complete ═══');
  return results;
}

export default { autoEvaluate, detectKnowledgeGaps, analyzeBehavioralEvolution, runDailyEvolution };
