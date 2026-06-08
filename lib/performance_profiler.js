/**
 * ═══════════════════════════════════════════════════════════════
 * PerformanceProfiler — Benchmark, Memory Profile, Latency Tracking
 * ═══════════════════════════════════════════════════════════════
 *
 * Cung cấp:
 *   - benchmark(fn, options) → Benchmark function execution
 *   - profileMemory(fn) → Profile memory usage
 *   - trackLatency(name, fn) → Track execution latency
 *   - getSystemMetrics() → CPU, RAM, disk, network stats
 *   - analyzePerformance(code, language) → Phân tích performance code
 *   - detectBottlenecks(code, language) → Phát hiện bottlenecks
 *
 * Được gọi bởi:
 * - discord_bot.js (!profile <code>)
 * - REST API (/api/performance)
 * - DebateAgent (so sánh performance giữa 2 solutions)
 * - EvoAgent (giám sát system metrics)
 */

import { getLogger } from './logger.js';
import { ask as llmAsk } from './llm.js';
import os from 'os';

const logger = getLogger('PerformanceProfiler');

// ── Benchmark ──────────────────────────────────────────────────────

/**
 * Benchmark một function
 */
export async function benchmark(fn, options = {}) {
  const iterations = options.iterations || 100;
  const warmup = options.warmup || 10;
  const name = options.name || 'anonymous';

  // Warmup
  for (let i = 0; i < warmup; i++) {
    try { await fn(); } catch { /* ignore */ }
  }

  const times = [];
  const memoryBefore = process.memoryUsage();

  for (let i = 0; i < iterations; i++) {
    const start = process.hrtime.bigint();
    try { await fn(); } catch { /* ignore */ }
    const end = process.hrtime.bigint();
    times.push(Number(end - start) / 1_000_000); // ms
  }

  const memoryAfter = process.memoryUsage();
  times.sort((a, b) => a - b);

  const result = {
    name,
    iterations,
    min: Math.round(times[0] * 100) / 100,
    max: Math.round(times[times.length - 1] * 100) / 100,
    mean: Math.round((times.reduce((a, b) => a + b, 0) / times.length) * 100) / 100,
    median: Math.round(times[Math.floor(times.length / 2)] * 100) / 100,
    p95: Math.round(times[Math.floor(times.length * 0.95)] * 100) / 100,
    p99: Math.round(times[Math.floor(times.length * 0.99)] * 100) / 100,
    memoryDelta: {
      heapUsed: Math.round((memoryAfter.heapUsed - memoryBefore.heapUsed) / 1024),
      external: Math.round((memoryAfter.external - memoryBefore.external) / 1024),
    },
    rating: times[Math.floor(times.length / 2)] < 1 ? 'A' : times[Math.floor(times.length / 2)] < 10 ? 'B' : times[Math.floor(times.length / 2)] < 100 ? 'C' : 'D',
  };

  logger.info(`[Benchmark] ${name}: ${result.mean}ms (median), ${result.p95}ms (p95), Grade ${result.rating}`);
  return result;
}

// ── Memory Profiling ──────────────────────────────────────────────

/**
 * Profile memory usage của một function
 */
export async function profileMemory(fn, options = {}) {
  const name = options.name || 'anonymous';
  const gcBefore = global.gc;
  if (global.gc) global.gc();

  const before = process.memoryUsage();
  const start = process.hrtime.bigint();

  let result;
  try {
    result = await fn();
  } catch (err) {
    return { name, error: err.message };
  }

  const end = process.hrtime.bigint();
  if (global.gc) global.gc();
  const after = process.memoryUsage();

  return {
    name,
    durationMs: Math.round(Number(end - start) / 1_000_000 * 100) / 100,
    memory: {
      heapUsedDelta: Math.round((after.heapUsed - before.heapUsed) / 1024),
      heapTotalDelta: Math.round((after.heapTotal - before.heapTotal) / 1024),
      externalDelta: Math.round((after.external - before.external) / 1024),
      rssDelta: Math.round((after.rss - before.rss) / 1024),
    },
    result: typeof result === 'object' ? { type: 'object', keys: Object.keys(result) } : { type: typeof result },
  };
}

// ── System Metrics ─────────────────────────────────────────────────

/**
 * Lấy system metrics (CPU, RAM, disk)
 */
export function getSystemMetrics() {
  const cpus = os.cpus();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;

  // CPU usage (average across cores)
  let totalIdle = 0, totalTick = 0;
  for (const cpu of cpus) {
    for (const type in cpu.times) {
      totalTick += cpu.times[type];
    }
    totalIdle += cpu.times.idle;
  }
  const cpuUsage = Math.round((1 - totalIdle / totalTick) * 100);

  return {
    cpu: {
      usage: cpuUsage,
      cores: cpus.length,
      model: cpus[0]?.model || 'unknown',
    },
    memory: {
      total: Math.round(totalMem / 1024 / 1024),
      used: Math.round(usedMem / 1024 / 1024),
      free: Math.round(freeMem / 1024 / 1024),
      usage: Math.round((usedMem / totalMem) * 100),
      process: {
        heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        heapTotal: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
        rss: Math.round(process.memoryUsage().rss / 1024 / 1024),
      },
    },
    uptime: {
      system: Math.round(os.uptime() / 3600 * 10) / 10, // hours
      process: Math.round(process.uptime() / 3600 * 10) / 10,
    },
    loadAvg: os.loadavg(),
    rating: cpuUsage < 50 && (usedMem / totalMem) < 0.8 ? 'healthy' : cpuUsage < 80 && (usedMem / totalMem) < 0.9 ? 'warning' : 'critical',
  };
}

// ── Performance Analysis ───────────────────────────────────────────

/**
 * Phán tích performance của code
 */
export function analyzePerformance(code, language = 'javascript') {
  const issues = [];
  const lines = code.split('\n');

  // Performance anti-patterns
  const perfPatterns = [
    { pattern: /for\s*\(.*\.length/g, type: 'Loop Optimization', message: 'Cache array length in loop condition', severity: 'info' },
    { pattern: /for\s*\(\s*let\s+i\s*=\s*0\s*;\s*i\s*<\s*\w+\.length/g, type: 'Loop Optimization', message: 'Consider caching .length or using for-of', severity: 'info' },
    { pattern: /\.forEach\s*\(\s*async/g, type: 'Async Loop', message: 'forEach with async — use for-of with await instead', severity: 'warning' },
    { pattern: /\.map\s*\(\s*async/g, type: 'Async Map', message: 'map with async — use Promise.all(map(...)) instead', severity: 'warning' },
    { pattern: /JSON\.parse\s*\(.*JSON\.stringify/g, type: 'Deep Clone', message: 'JSON.parse(JSON.stringify()) is slow — use structuredClone()', severity: 'info' },
    { pattern: /new\s+Date\s*\(\s*\)\.getTime\s*\(\s*\)/g, type: 'Date Optimization', message: 'Use Date.now() instead of new Date().getTime()', severity: 'info' },
    { pattern: /\.indexOf\s*\(\s*[^)]+\s*\)\s*!==?\s*-1/g, type: 'Array Search', message: 'Use .includes() instead of .indexOf() !== -1', severity: 'info' },
    { pattern: /Object\.keys\s*\(\s*\w+\s*\)\.length\s*===?\s*0/g, type: 'Empty Check', message: 'Use Object.keys().length === 0 or check with for-in', severity: 'info' },
    { pattern: /await\s+.*\n\s*await\s+.*\n\s*await/gm, type: 'Sequential Await', message: 'Sequential awaits — consider Promise.all() for parallel execution', severity: 'warning' },
    { pattern: /\.concat\s*\(/g, type: 'Array Concat', message: 'Use spread operator [...] instead of .concat()', severity: 'info' },
    { pattern: /setTimeout\s*\(\s*function/g, type: 'Callback Style', message: 'Use arrow functions or async/await for better readability', severity: 'info' },
    { pattern: /while\s*\(\s*true\s*\)/g, type: 'Infinite Loop', message: 'Infinite loop detected — ensure proper exit condition', severity: 'warning' },
    { pattern: /recursive|recursion/gi, type: 'Recursion', message: 'Recursive function — consider iterative approach for large inputs', severity: 'info' },
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const { pattern, type, message, severity } of perfPatterns) {
      pattern.lastIndex = 0;
      if (pattern.test(line)) {
        issues.push({ type, severity, message, line: i + 1 });
      }
    }
  }

  return {
    issues,
    summary: `${issues.length} performance considerations found`,
    recommendations: [...new Set(issues.map(i => i.message))].slice(0, 5),
  };
}

// ── LLM Performance Analysis ──────────────────────────────────────

export async function analyzePerformanceWithLlm(code, language = 'javascript') {
  const prompt = `You are a performance optimization expert. Analyze the following ${language} code for performance issues.

Focus on:
1. Time complexity (Big O)
2. Space complexity
3. Unnecessary computations
4. I/O bottlenecks
5. Memory leaks
6. Optimization opportunities

\`\`\`${language}
${code.slice(0, 3000)}
\`\`\`

Respond in JSON format:
{"time_complexity": string, "space_complexity": string, "bottlenecks": string[], "optimizations": string[], "rating": "A|B|C|D"}`;

  try {
    const { answer } = await llmAsk(prompt, {
      systemPrompt: 'You are a performance optimization expert. Always respond in valid JSON.',
      temperature: 0.2,
      maxTokens: 1024,
    });

    const jsonMatch = answer.match(/\{[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
    return { raw: answer };
  } catch (err) {
    logger.warn('[PerformanceProfiler] LLM analysis failed:', err?.message);
    return { error: 'LLM analysis unavailable' };
  }
}

// ── Main Entry Point ───────────────────────────────────────────────

export async function profileCode(code, language = 'javascript', options = {}) {
  const staticAnalysis = analyzePerformance(code, language);
  const systemMetrics = getSystemMetrics();
  let llmReport = null;

  if (options.useLlm !== false && code.length < 10000) {
    llmReport = await analyzePerformanceWithLlm(code, language);
  }

  return {
    language,
    static: staticAnalysis,
    system: systemMetrics,
    llm: llmReport,
    timestamp: new Date().toISOString(),
  };
}
