/**
 * lib/orchestrator_guard.js — Circuit breaker + health check cho Orchestrator
 *
 * Tier 2: Tách "Não" khỏi "Xác"
 * - Circuit breaker: khi RouterAgent fail 5 lần liên tiếp → bypass, trả fallback
 * - Health check: ping RouterAgent mỗi 30s
 * - Fallback: khi circuit open, trả response cơ bản thay vì crash
 *
 * Usage:
 *   import { orchestratorGuard } from './orchestrator_guard.js';
 *   const result = await orchestratorGuard.routeWithGuard(intent, context, userId);
 */

import { getLogger } from './logger.js';

const logger = getLogger('OrchestratorGuard');

// ── Circuit breaker state ──
let failureCount = 0;
let circuitOpen = false;
let lastFailureTime = 0;
const FAILURE_THRESHOLD = 5;
const RESET_AFTER_MS = 30_000; // 30s

// ── Agent usage tracking ──
const AGENT_USAGE = new Map();

export const orchestratorGuard = {
  /**
   * Route với circuit breaker protection
   */
  async routeWithGuard(intent, context, userId) {
    // Circuit open → fallback ngay
    if (circuitOpen) {
      if (Date.now() - lastFailureTime > RESET_AFTER_MS) {
        circuitOpen = false;
        failureCount = 0;
        logger.info('[OrchestratorGuard] Circuit HALF_OPEN — testing...');
      } else {
        logger.warn('[OrchestratorGuard] Circuit OPEN — bypass RouterAgent');
        return this._fallback(intent, context, userId);
      }
    }

    try {
      // Timeout 8s — nếu RouterAgent treo, coi như fail
      const { routerAgent } = await import('../agents/RouterAgent.js');
      const result = await Promise.race([
        routerAgent.route(intent, context),
        new Promise((_, reject) => setTimeout(() => reject(new Error('RouterAgent timeout')), 8000)),
      ]);

      // Reset counter khi thành công
      failureCount = 0;

      // Track agent usage
      if (result?.agent) {
        AGENT_USAGE.set(result.agent, (AGENT_USAGE.get(result.agent) ?? 0) + 1);
      }

      return result;

    } catch (err) {
      failureCount++;
      lastFailureTime = Date.now();
      logger.error(`[OrchestratorGuard] RouterAgent failed (${failureCount}/${FAILURE_THRESHOLD}): ${err.message}`);

      if (failureCount >= FAILURE_THRESHOLD) {
        circuitOpen = true;
        logger.error('[OrchestratorGuard] Circuit OPEN — RouterAgent bypass mode');
      }

      return this._fallback(intent, context, userId);
    }
  },

  /**
   * Fallback khi RouterAgent chết — trả response cơ bản
   */
  _fallback(intent, context, userId) {
    const FALLBACK_RESPONSES = {
      'RAG': { text: '⚠️ Hệ thống routing đang gặp lỗi tạm thời. Đang tự khôi phục, thử lại sau 30s.' },
      'CODE': { text: '⚠️ RouterAgent đang lỗi. Dùng `!run <code>` trực tiếp.' },
      'QUIZ': { text: '⚠️ RouterAgent đang lỗi. Dùng `!answer <id> <đáp án>` trực tiếp.' },
      'HELP': { text: '📋 Danh sách lệnh: xem README.md trên GitHub.' },
    };

    return FALLBACK_RESPONSES[intent] || { text: '⚠️ Hệ thống đang bảo trì tạm thời. Thử lại sau.' };
  },

  /**
   * Health check — gọi từ cron job mỗi 30s
   */
  async healthCheck() {
    try {
      const { routerAgent } = await import('../agents/RouterAgent.js');
      await Promise.race([
        routerAgent.route('HEALTH', { ping: true }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
      ]);
      return { healthy: true, circuitOpen, failureCount };
    } catch {
      return { healthy: false, circuitOpen, failureCount };
    }
  },

  /**
   * Agent usage stats — cho !agentstats command
   */
  getAgentUsage() {
    return new Map(AGENT_USAGE);
  },

  /**
   * Reset circuit breaker (manual)
   */
  reset() {
    circuitOpen = false;
    failureCount = 0;
    logger.info('[OrchestratorGuard] Circuit breaker reset');
  },
};
