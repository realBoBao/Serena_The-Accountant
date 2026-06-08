/**
 * SuggestionAgent — Proactive Context Monitor
 *
 * Monitors user context (flashcard scores, knowledge gaps, calendar)
 * and proactively suggests review sessions before the user asks.
 *
 * Triggers:
 * 1. Daily morning check (8:00 AM cron) — knowledge gap analysis
 * 2. Quiz score drop detection — auto-suggest weak topics
 * 3. Upcoming exam detection (from calendar) — push review content
 * 4. Stale flashcard detection — cards not reviewed in >7 days
 *
 * Runs as a cron job via scheduler.js (not a standalone PM2 service).
 */

import { getLogger } from '../lib/logger.js';
import { classifyQueryComplexity } from '../lib/cost_aware.js';

const logger = getLogger('SuggestionAgent');

// ═══════════════════════════════════════════════════════════
// 1. Knowledge Gap Analysis
// ═══════════════════════════════════════════════════════════

/**
 * Analyze flashcard performance to find weak knowledge areas.
 * Returns topics that need review.
 */
export async function analyzeKnowledgeGaps() {
  try {
    const { getDueCount, getWeakCategories, getStaleCards } = await import('../lib/flashcard_db.js');

    const dueCount = await getDueCount();
    const weakCategories = await getWeakCategories ? await getWeakCategories() : [];
    const staleCards = await getStaleCards ? await getStaleCards(7) : [];

    const gaps = [];

    // High due count → needs review
    if (dueCount > 20) {
      gaps.push({
        type: 'high_due',
        severity: dueCount > 50 ? 'high' : 'medium',
        message: `Bạn có ${dueCount} thẻ cần ôn tập. Dành 10 phút hôm nay?`,
        action: 'quiz',
        priority: dueCount > 50 ? 1 : 3,
      });
    }

    // Weak categories → targeted review
    for (const cat of weakCategories.slice(0, 3)) {
      gaps.push({
        type: 'weak_category',
        severity: cat.accuracy < 0.4 ? 'high' : 'medium',
        message: `Tỉ lệ đúng môn ${cat.name} chỉ ${(cat.accuracy * 100).toFixed(0)}%. Ôn lại không?`,
        action: 'review',
        category: cat.name,
        priority: cat.accuracy < 0.4 ? 2 : 4,
      });
    }

    // Stale cards → forgotten content
    if (staleCards.length > 10) {
      gaps.push({
        type: 'stale_cards',
        severity: 'medium',
        message: `${staleCards.length} thẻ chưa ôn hơn 7 ngày. Bạn đang quên dần!`,
        action: 'review',
        priority: 3,
      });
    }

    // Sort by priority
    gaps.sort((a, b) => a.priority - b.priority);

    logger.info(`[SuggestionAgent] Found ${gaps.length} knowledge gaps`);
    return gaps;
  } catch (err) {
    logger.warn('[SuggestionAgent] Knowledge gap analysis failed:', err.message);
    return [];
  }
}

// ═══════════════════════════════════════════════════════════
// 2. Proactive Suggestion Generator
// ═══════════════════════════════════════════════════════════

/**
 * Generate proactive suggestions based on context.
 * Called by scheduler.js cron job.
 */
export async function generateSuggestions() {
  const suggestions = [];

  // 1. Knowledge gaps
  const gaps = await analyzeKnowledgeGaps();
  suggestions.push(...gaps);

  // 2. Check if it's exam season (based on calendar or flashcard density)
  try {
    const { getRecentStats } = await import('../lib/flashcard_db.js');
    const stats = await getRecentStats ? await getRecentStats(7) : null;
    if (stats && stats.total > 0 && stats.avgScore < 0.5) {
      suggestions.push({
        type: 'low_performance',
        severity: 'high',
        message: `Điểm quiz tuần này trung bình chỉ ${(stats.avgScore * 100).toFixed(0)}%. Cần ôn tập nhiều hơn!`,
        action: 'intensive_review',
        priority: 1,
      });
    }
  } catch { /* skip */ }

  return suggestions;
}

/**
 * Format suggestions into a friendly Discord message.
 */
export function formatSuggestionMessage(suggestions) {
  if (!suggestions || suggestions.length === 0) {
    return null; // Nothing to suggest
  }

  const highPriority = suggestions.filter(s => s.severity === 'high');
  const mediumPriority = suggestions.filter(s => s.severity === 'medium');

  let msg = '🌅 **Chào buổi sáng! Đây là gợi ý học tập hôm nay:**\n\n';

  if (highPriority.length > 0) {
    msg += '🔴 **Cần chú ý:**\n';
    for (const s of highPriority) {
      msg += `  • ${s.message}\n`;
    }
    msg += '\n';
  }

  if (mediumPriority.length > 0) {
    msg += '🟡 **Gợi ý:**\n';
    for (const s of mediumPriority.slice(0, 3)) {
      msg += `  • ${s.message}\n`;
    }
    msg += '\n';
  }

  msg += '💡 Dùng `!quiz` để bắt đầu ôn tập, hoặc `!ask` để hỏi bất cứ điều gì.';

  return msg;
}

// ═══════════════════════════════════════════════════════════
// 3. Context Monitor — Runs on cron
// ═══════════════════════════════════════════════════════════

/**
 * Main entry point — called by scheduler.js cron job.
 * Analyzes context and returns suggestions if any.
 */
export async function runContextMonitor() {
  logger.info('[SuggestionAgent] Running context monitor...');

  const suggestions = await generateSuggestions();

  if (suggestions.length === 0) {
    logger.info('[SuggestionAgent] No suggestions — user is on track!');
    return null;
  }

  const message = formatSuggestionMessage(suggestions);
  logger.info(`[SuggestionAgent] Generated ${suggestions.length} suggestions`);

  return {
    suggestions,
    message,
    timestamp: new Date().toISOString(),
  };
}
