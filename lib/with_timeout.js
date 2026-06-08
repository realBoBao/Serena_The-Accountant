/**
 * ═══════════════════════════════════════════════════════════════
 * WITH_TIMEOUT — Universal Timeout & Deadlock Prevention Utility
 * ═══════════════════════════════════════════════════════════════
 *
 * Tất cả async operations trong hệ thống PHẢI wrap bởi withTimeout.
 * Đây là "cái chìa khóa" để giải quyết vấn đề Agent bị hang/deadlock.
 *
 * Nguyên tắc:
 *   - Mọi LLM call có timeout
 *   - Mọi agent loop có max_iterations
 *   - Mọi API request có timeout
 *   - Mọi sandbox execution có timeout
 *   - Timeout KHÔNG im lặng — luôn log & báo lỗi rõ ràng
 *
 * @module with_timeout
 */

/**
 * Wrap một promise với timeout.
 * Nếu promise không resolve trong `ms` giây, reject với TimeoutError.
 *
 * @param {Promise<T>} promise - Promise cần wrap
 * @param {number} ms - Timeout tính bằng milliseconds
 * @param {string} [label] - Nhãn để log khi timeout
 * @returns {Promise<T>} Kết quả hoặc reject với TimeoutError
 *
 * @example
 * try {
 *   const result = await withTimeout(
 *     invokeLlm(messages, 'RagAgent'),
 *     30_000,
 *     'LLM call'
 *   );
 * } catch (err) {
 *   if (err instanceof TimeoutError) {
 *     console.log('LLM timed out after 30s');
 *   }
 * }
 */
export class TimeoutError extends Error {
  constructor(ms, label) {
    const name = label || 'Operation';
    super(`⏰ TIMEOUT: ${name} exceeded ${ms / 1000}s`);
    this.name = 'TimeoutError';
    this.timeoutMs = ms;
    this.label = label || 'unknown';
  }
}

export function withTimeout(promise, ms, label) {
  if (!ms || ms <= 0) return promise;

  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new TimeoutError(ms, label));
    }, ms);
  });

  // Ensure timer is unref'd so it doesn't keep the Node.js process alive
  if (timer && typeof timer.unref === 'function') {
    timer.unref();
  }

  return Promise.race([
    promise,
    timeoutPromise,
  ]).finally(() => {
    clearTimeout(timer);
  });
}

/**
 * Retry với timeout cho mỗi attempt.
 * Tổng thời gian tối đa = attempts * (timeoutPerAttempt + delayBetweenAttempts)
 *
 * @param {Function} fn - Async function cần retry
 * @param {Object} options
 * @param {number} [options.attempts=3] - Số lần thử
 * @param {number} [options.timeoutPerAttempt=30000] - Timeout mỗi attempt (ms)
 * @param {number} [options.baseDelayMs=1000] - Delay cơ giữa các attempts (ms)
 * @param {string} [options.label] - Nhãn log
 * @param {Function} [options.onRetry] - Callback(err, attempt) khi retry
 * @returns {Promise<T>} Kết quả hoặc throw lỗi cuối cùng
 */
export async function withRetry(fn, {
  attempts = 3,
  timeoutPerAttempt = 30_000,
  baseDelayMs = 1000,
  label = 'operation',
  onRetry,
} = {}) {
  let lastErr;

  for (let i = 0; i < attempts; i++) {
    try {
      return await withTimeout(fn(), timeoutPerAttempt, `${label} (attempt ${i + 1})`);
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        const delay = baseDelayMs * Math.pow(2, i) + Math.random() * 500;
        if (onRetry) onRetry(err, i, delay);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  throw lastErr;
}

/**
 * Chạy nhiều promises song song với timeout chung.
 * Nếu bất kỳ promise nào fail, không cancel các promise khác (allSettled).
 *
 * @param {Array<{promise: Promise, label: string}>} tasks
 * @param {number} globalTimeoutMs
 * @returns {Promise<Array<{status: 'fulfilled'|'rejected', value?: any, reason?: any, label: string}>>}
 */
export async function withTimeoutAll(tasks, globalTimeoutMs) {
  const wrapped = tasks.map(({ promise, label }) =>
    withTimeout(promise, globalTimeoutMs, label)
      .then(value => ({ status: 'fulfilled', value, label }))
      .catch(reason => ({ status: 'rejected', reason, label }))
  );

  return Promise.all(wrapped);
}
