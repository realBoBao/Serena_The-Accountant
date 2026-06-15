import crypto from 'crypto';

function envBool(name, defaultVal = false) {
  const v = process.env[name];
  if (v === undefined) return defaultVal;
  return String(v).toLowerCase() === 'true' || v === '1' || v === 'yes';
}

const IS_CLOUD_RUN = !!process.env.K_SERVICE;
const ENABLE_DEBUG = envBool('LOG_DEBUG', false) && !IS_CLOUD_RUN;
const LOG_LEVEL = (process.env.LOG_LEVEL || (IS_CLOUD_RUN ? 'warn' : 'info')).toLowerCase();
const MAX_MSG_LEN = parseInt(process.env.LOG_MAX_MSG || (IS_CLOUD_RUN ? '200' : '500'));
const MAX_STACK_LINES = parseInt(process.env.LOG_MAX_STACK || '2');

// ── Log level filter ─────────────────────────────────────────────────────────
const LEVEL_ORDER = { debug: 0, info: 1, warn: 2, error: 3 };
function shouldLog(level) {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[LOG_LEVEL];
}

// ── Request ID tracking (for Cloud Run trace correlation) ───────────────────
const _requestIds = new Map(); // asyncLocalStorage alternative for Node ESM

export function setRequestId(id) {
  const key = typeof require !== 'undefined' ? require('worker_threads').threadId : 0;
  _requestIds.set(key, id);
}

export function getRequestId() {
  const key = typeof require !== 'undefined' ? require('worker_threads').threadId : 0;
  return _requestIds.get(key) || null;
}

export function clearRequestId() {
  const key = typeof require !== 'undefined' ? require('worker_threads').threadId : 0;
  _requestIds.delete(key);
}

/**
 * Structured JSON logger — Cloud Run optimized.
 * Outputs single-line JSON for each log entry.
 * Supports: levels, request IDs, child loggers, timing.
 */
export function getLogger(context = '') {
  const prefix = context ? `[${context}]` : '[app]';

  function truncate(str, max) {
    if (!str || str.length <= max) return str;
    return str.slice(0, max) + `…(+${str.length - max})`;
  }

  function base(level, msg, meta) {
    if (!shouldLog(level)) return;

    // Truncate long messages to save tokens
    const trimmedMsg = typeof msg === 'string' ? truncate(msg, MAX_MSG_LEN) : msg;

    const line = {
      ts: new Date().toISOString(),
      level,
      prefix,
      reqId: getRequestId() || undefined,
      msg: trimmedMsg,
      ...(meta && typeof meta === 'object' ? meta : {}),
    };

    // Truncate long string values in meta
    for (const k of Object.keys(line)) {
      if (line[k] === undefined) { delete line[k]; }
      else if (typeof line[k] === 'string' && k !== 'ts') line[k] = truncate(line[k], MAX_MSG_LEN);
    }

    try {
      console.log(JSON.stringify(line));
    } catch (_) {
      console.log(`${level} ${prefix} ${msg}`);
    }
  }

  const logger = {
    info: (msg, meta) => base('info', msg, meta),
    warn: (msg, meta) => base('warn', msg, meta),
    error: (msg, meta) => base('error', msg, meta),
    debug: (msg, meta) => base('debug', msg, meta),

    /** Create child logger with sub-context */
    child(subContext) {
      return getLogger(`${context}:${subContext}`);
    },

    /** Time an operation */
    async time(label, fn, meta = {}) {
      const start = Date.now();
      try {
        const result = await fn();
        base('info', `${label} completed`, { ...meta, duration: Date.now() - start });
        return result;
      } catch (err) {
        base('error', `${label} failed`, { ...meta, duration: Date.now() - start, error: err.message });
        throw err;
      }
    },

    /** Log with error object — stack truncated in production */
    errorObj(msg, err, meta = {}) {
      let stack = undefined;
      if (err.stack) {
        const lines = err.stack.split('\n').slice(0, ENABLE_DEBUG ? undefined : MAX_STACK_LINES);
        stack = truncate(lines.join('\n'), MAX_MSG_LEN);
      }
      base('error', msg, {
        ...meta,
        error: err.message,
        stack,
        code: err.code || undefined,
      });
    },
  };

  return logger;
}

export default getLogger;
