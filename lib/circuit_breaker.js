/**
 * lib/circuit_breaker.js — Circuit Breaker Pattern for API Calls
 *
 * Ngăn chặn việc gọi API liên tục khi đang lỗi (429, 500, network error).
 *
 * 3 trạng thái:
 *   CLOSED   → Bình thường, cho phép gọi API
 *   OPEN     → API đang lỗi, chặn mọi request (fail fast)
 *   HALF_OPEN → Thử lại 1 request để kiểm tra API đã hồi chưa
 *
 * Cấu hình:
 *   - failureThreshold: Số lỗi liên tiếp trước khi OPEN (mặc định: 3)
 *   - resetTimeout: Thời gian chờ trước khi thử HALF_OPEN (mặc định: 60s)
 *   - maxRetries: Số retry trong CLOSED state (mặc định: 2)
 *   - retryDelay: Delay giữa các retry, exponential backoff (mặc định: 1s)
 *
 * Usage:
 *   import { circuitBreaker } from './circuit_breaker.js';
 *   const result = await circuitBreaker.execute('gemini', () => fetch(url));
 */

import { getLogger } from './logger.js';

const logger = getLogger('CircuitBreaker');

// ── States ──────────────────────────────────────────────
const STATE = {
  CLOSED: 'CLOSED',
  OPEN: 'OPEN',
  HALF_OPEN: 'HALF_OPEN',
};

// ── Circuit Breaker per provider ────────────────────────
class CircuitBreaker {
  constructor(name, options = {}) {
    this.name = name;
    this.state = STATE.CLOSED;
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureTime = 0;
    this.lastStateChange = Date.now();

    this.failureThreshold = options.failureThreshold || 3;
    this.resetTimeout = options.resetTimeout || 60000; // 60s
    this.maxRetries = options.maxRetries || 2;
    this.retryDelay = options.retryDelay || 1000; // 1s base
  }

  /**
   * Execute với circuit breaker protection
   */
  async execute(fn) {
    // Nếu OPEN → kiểm tra đã đến lúc thử lại chưa
    if (this.state === STATE.OPEN) {
      const elapsed = Date.now() - this.lastStateChange;
      if (elapsed < this.resetTimeout) {
        const waitSec = Math.ceil((this.resetTimeout - elapsed) / 1000);
        logger.warn(`[CircuitBreaker:${this.name}] OPEN — skipping request (retry in ${waitSec}s)`);
        throw new Error(`Circuit breaker OPEN for ${this.name} — retry in ${waitSec}s`);
      }
      // Đã đủ thời gian → chuyển sang HALF_OPEN
      this.state = STATE.HALF_OPEN;
      logger.info(`[CircuitBreaker:${this.name}] → HALF_OPEN (testing...)`);
    }

    // Thử execute với retry
    let lastErr;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        const delay = this.retryDelay * Math.pow(2, attempt - 1);
        logger.info(`[CircuitBreaker:${this.name}] Retry ${attempt}/${this.maxRetries} in ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
      }

      try {
        const result = await fn();

        // Kiểm tra nếu result là Response với status lỗi
        if (result && typeof result === 'object' && 'status' in result && result.status >= 400) {
          throw new Error(`HTTP ${result.status}`);
        }

        // Thành công → reset failure count
        this.onSuccess();
        return result;
      } catch (err) {
        lastErr = err;
        const msg = err?.message || String(err);

        // Chỉ count retryable errors
        if (msg.includes('429') || msg.includes('500') || msg.includes('502') ||
            msg.includes('503') || msg.includes('504') || msg.includes('network') ||
            msg.includes('timeout') || msg.includes('ECONNREFUSED')) {
          this.onFailure();
        } else {
          // Non-retryable error (401, 403, 404) → throw ngay
          logger.warn(`[CircuitBreaker:${this.name}] Non-retryable error: ${msg}`);
          throw err;
        }
      }
    }

    // Hết retries → throw
    throw lastErr;
  }

  onSuccess() {
    this.failureCount = 0;
    this.successCount++;
    if (this.state === STATE.HALF_OPEN) {
      this.state = STATE.CLOSED;
      this.lastStateChange = Date.now();
      logger.info(`[CircuitBreaker:${this.name}] → CLOSED (recovered ✅)`);
    }
  }

  onFailure() {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.failureCount >= this.failureThreshold) {
      this.state = STATE.OPEN;
      this.lastStateChange = Date.now();
      logger.warn(`[CircuitBreaker:${this.name}] → OPEN (${this.failureCount} consecutive failures)`);
    }
  }

  getStatus() {
    return {
      name: this.name,
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      lastFailureTime: this.lastFailureTime,
      lastStateChange: this.lastStateChange,
    };
  }
}

// ── Global Registry ─────────────────────────────────────
const breakers = new Map();

/**
 * Lấy hoặc tạo circuit breaker cho provider
 */
export function getBreaker(name, options = {}) {
  if (!breakers.has(name)) {
    breakers.set(name, new CircuitBreaker(name, options));
  }
  return breakers.get(name);
}

/**
 * Execute với circuit breaker (shortcut)
 */
export async function withCircuitBreaker(name, fn, options = {}) {
  const breaker = getBreaker(name, options);
  return breaker.execute(fn);
}

/**
 * Lấy status tất cả breakers (cho monitoring)
 */
export function getAllBreakerStatus() {
  const status = {};
  for (const [name, breaker] of breakers) {
    status[name] = breaker.getStatus();
  }
  return status;
}

export default { CircuitBreaker, getBreaker, withCircuitBreaker, getAllBreakerStatus };
