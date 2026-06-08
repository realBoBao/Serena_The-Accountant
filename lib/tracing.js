/**
 * Distributed Tracing — trace_id per session for multi-agent debugging
 *
 * When a request flows through Planner → RagAgent → CoderAgent → Sandbox,
 * each step is logged with the same trace_id. If something goes wrong,
 * you can trace the entire chain to find which agent "hallucinated".
 *
 * Usage:
 *   import { startSpan, endSpan, getTraceLog } from './tracing.js';
 *   const span = startSpan('RagAgent.answerQuestion', { traceId, query });
 *   try { ... } finally { endSpan(span, { result }); }
 */

import { getLogger } from './logger.js';
import crypto from 'crypto';

const logger = getLogger('Tracing');

// In-memory trace store (capped to prevent memory leak)
const _traceStore = new Map();
const MAX_TRACES = 1000;
const MAX_SPANS_PER_TRACE = 50;

/**
 * Generate a new trace ID.
 */
export function generateTraceId() {
  return crypto.randomBytes(8).toString('hex');
}

/**
 * Start a new span (a single step in the trace).
 * @param {string} name — Span name (e.g., 'RagAgent.answerQuestion')
 * @param {object} attrs — Attributes (traceId, query, agent, etc.)
 * @returns {object} Span object
 */
export function startSpan(name, attrs = {}) {
  const span = {
    id: crypto.randomBytes(4).toString('hex'),
    name,
    traceId: attrs.traceId || generateTraceId(),
    parentId: attrs.parentId || null,
    startTime: Date.now(),
    endTime: null,
    durationMs: null,
    status: 'running',
    attrs: { ...attrs },
    error: null,
  };

  // Store in trace log
  const traceKey = span.traceId;
  if (!_traceStore.has(traceKey)) {
    _traceStore.set(traceKey, {
      traceId: traceKey,
      startTime: span.startTime,
      spans: [],
      rootQuery: attrs.query || attrs.problem || '',
    });
  }

  const trace = _traceStore.get(traceKey);
  if (trace.spans.length < MAX_SPANS_PER_TRACE) {
    trace.spans.push(span);
  }

  // Evict oldest traces if over limit
  if (_traceStore.size > MAX_TRACES) {
    const oldestKey = _traceStore.keys().next().value;
    _traceStore.delete(oldestKey);
  }

  logger.debug(`[Trace:${span.traceId.slice(0, 8)}] START ${name}`);
  return span;
}

/**
 * End a span (mark as completed or failed).
 * @param {object} span — Span object from startSpan
 * @param {object} result — Result data (output, error, etc.)
 */
export function endSpan(span, result = {}) {
  span.endTime = Date.now();
  span.durationMs = span.endTime - span.startTime;

  if (result.error) {
    span.status = 'error';
    span.error = String(result.error).slice(0, 500);
  } else {
    span.status = 'ok';
  }

  // Store result summary (not full output to save memory)
  if (result.output) {
    span.outputPreview = String(result.output).slice(0, 200);
  }
  if (result.score) span.score = result.score;
  if (result.model) span.model = result.model;
  if (result.provider) span.provider = result.provider;

  logger.debug(`[Trace:${span.traceId.slice(0, 8)}] END ${span.name} (${span.durationMs}ms) status=${span.status}`);
  return span;
}

/**
 * Get full trace by ID.
 */
export function getTrace(traceId) {
  return _traceStore.get(traceId) || null;
}

/**
 * Get trace summary (for debugging).
 */
export function getTraceSummary(traceId) {
  const trace = _traceStore.get(traceId);
  if (!trace) return null;

  return {
    traceId: trace.traceId,
    rootQuery: trace.rootQuery.slice(0, 100),
    totalSpans: trace.spans.length,
    totalDurationMs: trace.spans.reduce((sum, s) => sum + (s.durationMs || 0), 0),
    errors: trace.spans.filter(s => s.status === 'error').length,
    spans: trace.spans.map(s => ({
      name: s.name,
      durationMs: s.durationMs,
      status: s.status,
      error: s.error?.slice(0, 100) || null,
      model: s.model || null,
    })),
  };
}

/**
 * Get all recent traces (for monitoring).
 */
export function getRecentTraces(limit = 20) {
  const traces = Array.from(_traceStore.values())
    .sort((a, b) => b.startTime - a.startTime)
    .slice(0, limit);

  return traces.map(t => getTraceSummary(t.traceId));
}

/**
 * Clear all traces (for testing).
 */
export function clearTraces() {
  _traceStore.clear();
}

/**
 * Decorator/wrapper for tracing async functions.
 * Usage:
 *   const tracedFn = withTracing('RagAgent.answerQuestion', async (query) => { ... });
 */
export function withTracing(name, fn) {
  return async (input, opts = {}) => {
    const span = startSpan(name, {
      traceId: opts.traceId,
      parentId: opts.parentId,
      query: typeof input === 'string' ? input : JSON.stringify(input).slice(0, 200),
    });

    try {
      const result = await fn(input, { ...opts, traceId: span.traceId, parentId: span.id });
      endSpan(span, { output: result });
      return result;
    } catch (err) {
      endSpan(span, { error: err });
      throw err;
    }
  };
}
