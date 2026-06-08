/**
 * ═══════════════════════════════════════════════════════════════
 * SANDBOX GATEWAY — Unified Secure Code Execution Gateway
 * ═══════════════════════════════════════════════════════════════
 *
 * Đây là "cổng duy nhất" mà tất cả Agent phải qua để chạy code.
 * Không Agent nào được phép chạy code trực tiếp mà không qua Gateway này.
 *
 * Architecture:
 *   Agent → SandboxGateway.execute() → Policy Check → Docker Sandbox (preferred)
 *                                                        ↓ fallback
 *                                                   In-Process Sandbox
 *                                                        ↓
 *                                                   Audit Log
 *
 * Security Flow:
 *   1. Agent gửi request với code + agent name
 *   2. Policy Engine kiểm tra trust level, rate limit, code size
 *   3. Security Analysis quét code qua 4 lớp blacklist
 *   4. Nếu PASS → chạy trong Docker container (hoặc in-process fallback)
 *   5. Kết quả được log vào Audit System
 *   6. Trả kết quả về cho Agent
 *
 * Usage:
 *   import { sandboxGateway } from './sandbox_gateway.js';
 *
 *   const result = await sandboxGateway.execute({
 *     agent: 'rag',
 *     code: 'print("Hello World")',
 *     language: 'python',
 *   });
 *
 *   if (result.blocked) {
 *     console.log('Code blocked:', result.error);
 *   } else if (result.success) {
 *     console.log('Output:', result.output);
 *   }
 *
 * @module sandbox_gateway
 */

import {
  evaluatePolicy,
  logExecution,
  recordExecution,
  computeCodeHash,
  getAgentTrustConfig,
  getAgentTrustLevel,
  TrustLevel,
  checkRateLimit,
  getRecentExecutions,
} from './lib/sandbox_policy.js';

import {
  analyzeCodeSecurity,
} from './lib/code_sandbox.js';

import {
  execute as dockerExecute,
  isDockerAvailable,
  isImageBuilt,
  ensureSandboxReady,
} from './sandbox_runner.js';

// ═══════════════════════════════════════════════════════════════
// SANDBOX GATEWAY CLASS
// ═══════════════════════════════════════════════════════════════

class SandboxGateway {
  constructor() {
    this._initialized = false;
    this._dockerReady = false;
    this._stats = {
      totalExecutions: 0,
      blocked: 0,
      timedOut: 0,
      errors: 0,
      byMethod: { docker: 0, 'in-process': 0, blocked: 0 },
    };
  }

  /**
   * Initialize the gateway — check Docker availability, build image if needed
   */
  async initialize() {
    if (this._initialized) return;

    console.log('[SandboxGateway] Initializing...');

    const dockerOk = await isDockerAvailable();
    if (dockerOk) {
      const ready = await ensureSandboxReady();
      this._dockerReady = ready.ready;
      console.log(`[SandboxGateway] Docker: ${ready.ready ? '✅ Ready' : '❌ ' + ready.reason}`);
    } else {
      this._dockerReady = false;
      console.log('[SandboxGateway] Docker not available, using in-process sandbox (lower security)');
    }

    this._initialized = true;
    console.log('[SandboxGateway] ✅ Gateway initialized');
  }

  /**
   * Main execution entry point — ALL code execution goes through here
   *
   * @param {Object} request
   * @param {string} request.agent       - Name of the agent requesting execution
   * @param {string} request.code        - Source code to execute
   * @param {string} [request.language]  - Language (auto-detected if not provided)
   * @param {number} [request.timeout]   - Custom timeout (capped by trust level)
   * @param {string} [request.forceMethod] - 'docker' | 'in-process' | undefined (auto)
   * @returns {Promise<Object>} Execution result
   */
  async execute(request) {
    const { agent, code, language, timeout, forceMethod } = request;
    const startTime = Date.now();

    // Ensure initialized
    if (!this._initialized) {
      await this.initialize();
    }

    // ── Step 1: Policy Evaluation ──
    const policy = evaluatePolicy({ agent, code, language, timeout });

    if (!policy.allowed) {
      this._stats.blocked++;
      this._stats.byMethod.blocked++;

      await logExecution({
        agent,
        language: language || 'unknown',
        success: false,
        blocked: true,
        timedOut: false,
        exitCode: -1,
        method: policy.method,
        durationMs: Date.now() - startTime,
        codeHash: computeCodeHash(code),
        codeLength: code.length,
        outputLength: 0,
        reason: policy.reason,
      });

      return {
        success: false,
        output: '',
        error: policy.reason,
        blocked: true,
        timedOut: false,
        exitCode: -1,
        method: policy.method,
        agent,
        trustLevel: getAgentTrustLevel(agent),
      };
    }

    // ── Step 2: Record execution for rate limiting ──
    recordExecution(agent);

    // ── Step 3: Multi-layer security analysis ──
    const security = analyzeCodeSecurity(code);
    if (!security.safe) {
      this._stats.blocked++;
      this._stats.byMethod.blocked++;

      await logExecution({
        agent,
        language: language || 'unknown',
        success: false,
        blocked: true,
        timedOut: false,
        exitCode: -1,
        method: 'blocked',
        durationMs: Date.now() - startTime,
        codeHash: computeCodeHash(code),
        codeLength: code.length,
        outputLength: 0,
        error: security.reason,
        reason: `Security: Layer ${security.layer}`,
      });

      return {
        success: false,
        output: '',
        error: security.reason,
        blocked: true,
        timedOut: false,
        exitCode: -1,
        method: 'blocked',
        agent,
        trustLevel: getAgentTrustLevel(agent),
      };
    }

    // ── Step 4: Execute in sandbox ──
    let result;
    try {
      if (forceMethod === 'docker' || (!forceMethod && this._dockerReady)) {
        result = await dockerExecute(code, language, {
          timeout: policy.effectiveTimeout,
          forceMethod: forceMethod,
        });
      } else {
        // Fallback to in-process sandbox (single source of truth)
        const { executeCode } = await import('./lib/code_sandbox.js');
        const execResult = await executeCode(code, language);
        result = { ...execResult, method: 'in-process' };
      }
    } catch (err) {
      result = {
        success: false,
        output: '',
        error: `❌ Sandbox execution error: ${err.message}`,
        blocked: false,
        timedOut: false,
        exitCode: -1,
        method: 'error',
        language: language || 'unknown',
      };
    }

    // ── Step 5: Update stats ──
    this._stats.totalExecutions++;
    this._stats.byMethod[result.method] = (this._stats.byMethod[result.method] || 0) + 1;
    if (result.timedOut) this._stats.timedOut++;
    if (!result.success && !result.blocked) this._stats.errors++;

    // ── Step 6: Audit logging ──
    await logExecution({
      agent,
      language: result.language || language || 'unknown',
      success: result.success,
      blocked: result.blocked || false,
      timedOut: result.timedOut || false,
      exitCode: result.exitCode ?? -1,
      method: result.method || 'unknown',
      durationMs: Date.now() - startTime,
      codeHash: computeCodeHash(code),
      codeLength: code.length,
      outputLength: (result.output || '').length,
      error: result.error,
    });

    return {
      ...result,
      agent,
      trustLevel: getAgentTrustLevel(agent),
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * Get gateway status and statistics
   */
  async getStatus() {
    const dockerOk = await isDockerAvailable();
    const imageOk = dockerOk ? await isImageBuilt() : false;

    return {
      initialized: this._initialized,
      dockerAvailable: dockerOk,
      dockerImageBuilt: imageOk,
      preferredMethod: this._dockerReady ? 'docker' : 'in-process',
      stats: { ...this._stats },
    };
  }

  /**
   * Get recent execution history
   */
  async getHistory(limit = 50) {
    return getRecentExecutions(limit);
  }

  /**
   * Check if an agent can execute code (without actually running)
   */
  canExecute(agent) {
    const rateLimit = checkRateLimit(agent);
    const trustConfig = getAgentTrustConfig(agent);

    return {
      agent,
      trustLevel: getAgentTrustLevel(agent),
      trustLabel: trustConfig.label,
      rateLimit,
      canExecute: rateLimit.allow && !trustConfig.requireApproval,
    };
  }
}

// ═══════════════════════════════════════════════════════════════
// SINGLETON EXPORT
// ═══════════════════════════════════════════════════════════════

export const sandboxGateway = new SandboxGateway();
export { TrustLevel, TRUST_CONFIG } from './lib/sandbox_policy.js';
