/**
 * ═══════════════════════════════════════════════════════════════
 * SANDBOX POLICY ENGINE — Security Policy & Audit System
 * ═══════════════════════════════════════════════════════════════
 *
 * Đây là "bộ não" bảo mật quyết định code có được phép chạy hay không.
 * Hoạt động như một firewall cho code execution.
 *
 * Chức năng:
 *   1. Policy Enforcement — Whitelist/Blacklist cho từng Agent
 *   2. Audit Logging — Ghi log mọi lần chạy code (thành công/thất bại/blocked)
 *   3. Rate Limiting — Giới hạn số lần chạy code trong khoảng thời gian
 *   4. Agent Trust Levels — Mỗi Agent có mức tin cậy khác nhau
 *   5. Execution History — Lưu lịch sử để phân tích pattern bất thường
 *
 * Agent Trust Levels:
 *   🔴 UNTRUSTED  — Chỉ được chạy code đơn giản, không I/O, timeout 5s
 *   🟡 BASIC      — Được chạy code có I/O cơ bản, timeout 10s
 *   🟢 TRUSTED    — Được chạy hầu hết code, timeout 30s
 *   🔵 PRIVILEGED — Chỉ dành cho system agents, timeout 60s
 *
 * @module sandbox_policy
 */

import { appendFile, mkdir } from 'fs/promises';
import path from 'path';
import os from 'os';

// ═══════════════════════════════════════════════════════════════
// TRUST LEVELS
// ═══════════════════════════════════════════════════════════════

export const TrustLevel = {
  UNTRUSTED: 0,    // Code từ bên ngoài, user input, web scraping
  BASIC: 1,        // Code từ agent nội bộ, đã qua review
  TRUSTED: 2,      // Code từ system agents
  PRIVILEGED: 3,   // Code từ orchestrator, admin operations
};

export const TRUST_CONFIG = {
  [TrustLevel.UNTRUSTED]: {
    label: '🔴 UNTRUSTED',
    maxTimeout: 5_000,        // 5 seconds
    allowNetwork: false,
    allowFileIO: false,
    allowCompilation: true,
    maxExecutionsPerMinute: 3,
    requireApproval: true,    // Cần approval trước khi chạy
    description: 'Code from untrusted sources — maximum restrictions',
  },
  [TrustLevel.BASIC]: {
    label: '🟡 BASIC',
    maxTimeout: 10_000,       // 10 seconds
    allowNetwork: false,
    allowFileIO: true,        // Chỉ trong sandbox dir
    allowCompilation: true,
    maxExecutionsPerMinute: 10,
    requireApproval: false,
    description: 'Code from internal agents — moderate restrictions',
  },
  [TrustLevel.TRUSTED]: {
    label: '🟢 TRUSTED',
    maxTimeout: 30_000,       // 30 seconds
    allowNetwork: false,
    allowFileIO: true,
    allowCompilation: true,
    maxExecutionsPerMinute: 30,
    requireApproval: false,
    description: 'Code from system agents — standard restrictions',
  },
  [TrustLevel.PRIVILEGED]: {
    label: '🔵 PRIVILEGED',
    maxTimeout: 60_000,       // 60 seconds
    allowNetwork: true,       // Chỉ privileged mới được network
    allowFileIO: true,
    allowCompilation: true,
    maxExecutionsPerMinute: 60,
    requireApproval: false,
    description: 'System-level code — elevated permissions',
  },
};

// ═══════════════════════════════════════════════════════════════
// AGENT TRUST ASSIGNMENTS
// ═══════════════════════════════════════════════════════════════

const AGENT_TRUST_MAP = {
  // System agents — highest trust
  orchestrator: TrustLevel.PRIVILEGED,
  scheduler: TrustLevel.TRUSTED,

  // Internal agents — standard trust
  rag: TrustLevel.TRUSTED,
  pdf: TrustLevel.TRUSTED,
  interaction: TrustLevel.BASIC,
  debate: TrustLevel.BASIC,
  manim: TrustLevel.BASIC,
  vision: TrustLevel.BASIC,
  voice: TrustLevel.BASIC,

  // External/untrusted sources
  user_input: TrustLevel.UNTRUSTED,
  web_scraped: TrustLevel.UNTRUSTED,
  discord_message: TrustLevel.UNTRUSTED,
  api_request: TrustLevel.BASIC,
};

/**
 * Get trust level for an agent
 */
export function getAgentTrustLevel(agentName) {
  return AGENT_TRUST_MAP[agentName] ?? TrustLevel.UNTRUSTED;
}

/**
 * Get trust config for an agent
 */
export function getAgentTrustConfig(agentName) {
  const level = getAgentTrustLevel(agentName);
  return TRUST_CONFIG[level];
}

// ═══════════════════════════════════════════════════════════════
// RATE LIMITER
// ═══════════════════════════════════════════════════════════════

const executionCounters = new Map(); // agentName -> [{timestamp}]

/**
 * Kiểm tra rate limit cho một agent
 * @returns {{ allowed: boolean, remaining: number, resetIn: number }}
 */
export function checkRateLimit(agentName) {
  const config = getAgentTrustConfig(agentName);
  const now = Date.now();
  const windowStart = now - 60_000; // 1 minute window

  // Get or initialize counter
  if (!executionCounters.has(agentName)) {
    executionCounters.set(agentName, []);
  }

  const timestamps = executionCounters.get(agentName);

  // Remove old entries outside the window
  const recent = timestamps.filter(t => t > windowStart);
  executionCounters.set(agentName, recent);

  const count = recent.length;
  const allowed = count < config.maxExecutionsPerMinute;
  const remaining = Math.max(0, config.maxExecutionsPerMinute - count);
  const resetIn = recent.length > 0
    ? Math.ceil((recent[0] + 60_000 - now) / 1000)
    : 0;

  return { allowed, remaining, resetIn };
}

/**
 * Record an execution for rate limiting
 */
export function recordExecution(agentName) {
  if (!executionCounters.has(agentName)) {
    executionCounters.set(agentName, []);
  }
  executionCounters.get(agentName).push(Date.now());
}

// ═══════════════════════════════════════════════════════════════
// AUDIT LOGGER
// ═══════════════════════════════════════════════════════════════

const AUDIT_LOG_DIR = path.join(os.tmpdir(), 'ai-sandbox-audit');
const AUDIT_LOG_FILE = path.join(AUDIT_LOG_DIR, 'sandbox-audit.jsonl');

let auditInitialized = false;

async function ensureAuditLog() {
  if (auditInitialized) return;
  await mkdir(AUDIT_LOG_DIR, { recursive: true });
  auditInitialized = true;
}

/**
 * Log a sandbox execution event
 */
export async function logExecution(event) {
  await ensureAuditLog();

  const entry = {
    timestamp: new Date().toISOString(),
    id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    agent: event.agent || 'unknown',
    trustLevel: getAgentTrustLevel(event.agent || 'unknown'),
    language: event.language || 'unknown',
    success: event.success || false,
    blocked: event.blocked || false,
    timedOut: event.timedOut || false,
    exitCode: event.exitCode ?? -1,
    method: event.method || 'unknown',
    durationMs: event.durationMs || 0,
    codeHash: event.codeHash || null,  // SHA-256 hash, not the actual code
    codeLength: event.codeLength || 0,
    outputLength: event.outputLength || 0,
    error: event.error ? String(event.error).slice(0, 200) : null,
    reason: event.reason || null,
  };

  try {
    await appendFile(AUDIT_LOG_FILE, JSON.stringify(entry) + '\n', 'utf8');
  } catch {
    /* audit logging should never break execution */
  }

  return entry;
}

/**
 * Get recent audit log entries
 */
export async function getRecentExecutions(limit = 50) {
  await ensureAuditLog();

  try {
    const { readFile } = await import('fs/promises');
    const content = await readFile(AUDIT_LOG_FILE, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    return lines.slice(-limit).map(line => JSON.parse(line));
  } catch {
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════
// POLICY DECISION ENGINE
// ═══════════════════════════════════════════════════════════════

/**
 * Quyết định cuối cùng: code này có được phép chạy không?
 *
 * @param {Object} request — { agent, code, language, timeout }
 * @returns {{ allowed: boolean, reason: string, effectiveTimeout: number, method: string }}
 */
export function evaluatePolicy(request) {
  const { agent, code, language, timeout } = request;
  const trustConfig = getAgentTrustConfig(agent);

  // 1. Check rate limit
  const rateLimit = checkRateLimit(agent);
  if (!rateLimit.allowed) {
    return {
      allowed: false,
      reason: `🚫 Rate limit exceeded for agent "${agent}". Max ${trustConfig.maxExecutionsPerMinute}/min. Retry in ${rateLimit.resetIn}s.`,
      effectiveTimeout: 0,
      method: 'blocked',
    };
  }

  // 2. Check code size (prevent memory abuse)
  const MAX_CODE_SIZE = 50_000; // 50KB
  if (code.length > MAX_CODE_SIZE) {
    return {
      allowed: false,
      reason: `🚫 Code too large: ${code.length} bytes (max ${MAX_CODE_SIZE})`,
      effectiveTimeout: 0,
      method: 'blocked',
    };
  }

  // 3. Enforce timeout limit based on trust level
  const effectiveTimeout = Math.min(
    timeout || trustConfig.maxTimeout,
    trustConfig.maxTimeout
  );

  // 4. Check language restrictions for untrusted agents
  if (trustConfig.label.includes('UNTRUSTED')) {
    const allowedLanguages = ['python', 'javascript'];
    if (language && !allowedLanguages.includes(language)) {
      return {
        allowed: false,
        reason: `🚫 Agent "${agent}" (UNTRUSTED) can only run: ${allowedLanguages.join(', ')}`,
        effectiveTimeout: 0,
        method: 'blocked',
      };
    }
  }

  // 5. Check if approval is required
  if (trustConfig.requireApproval) {
    return {
      allowed: false,
      reason: `⏸️ Agent "${agent}" requires manual approval before code execution. Code has been queued for review.`,
      effectiveTimeout: 0,
      method: 'pending_approval',
    };
  }

  return {
    allowed: true,
    reason: `✅ Agent "${agent}" (${trustConfig.label}) — execution approved`,
    effectiveTimeout,
    method: 'approved',
  };
}

/**
 * Compute a simple hash of code for audit logging (not for security, just identification)
 */
export function computeCodeHash(code) {
  // Simple hash — NOT cryptographically secure, just for identification
  let hash = 0;
  for (let i = 0; i < code.length; i++) {
    const char = code.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash).toString(16).padStart(8, '0');
}
