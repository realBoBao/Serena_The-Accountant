/**
 * ═══════════════════════════════════════════════════════════════
 * SANDBOX RUNNER — Docker-based Secure Code Execution Engine
 * ═══════════════════════════════════════════════════════════════
 *
 * Đây là "cánh tay" bảo mật chịu trách nhiệm:
 *   1. Nhận code từ bất kỳ Agent nào
 *   2. Gửi code vào Docker Container cách ly hoàn toàn
 *   3. Thu thập stdout/stderr
 *   4. Tiêu diệt Container ngay sau khi chạy xong
 *
 * Security Guarantees:
 *   ✅ Network Isolation  — --network none (không ra được internet)
 *   ✅ Resource Limits   — 256MB RAM, 0.5 CPU, 50 processes max
 *   ✅ Read-only FS      — root filesystem read-only, chỉ /tmp writable
 *   ✅ No privilege escalation — non-root user, no SUID binaries
 *   ✅ Auto-destroy      — --rm flag, container bị xóa sau mỗi lần chạy
 *   ✅ Timeout           — 30s default, kill container nếu quá thời gian
 *
 * Fallback: Nếu Docker không available, dùng in-process sandbox (lib/code_sandbox.js)
 *            nhưng với security level giảm hơn.
 *
 * @module sandbox_runner
 */

import { execFile, execSync } from 'child_process';
import { writeFile, mkdir, rm, access } from 'fs/promises';
import { constants } from 'fs';
import path from 'path';
import os from 'os';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// ═══════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════

const CONFIG = {
  // Docker settings
  docker: {
    image: 'ai-sandbox:latest',
    network: 'none',           // ← Network isolation
    memory: '256m',            // ← RAM limit
    memorySwap: '256m',        // ← No swap (prevent disk thrashing)
    cpus: '0.5',               // ← CPU limit
    pidsLimit: 50,             // ← Max processes (prevent fork bombs)
    readOnly: true,            // ← Read-only root filesystem
    tmpfsSize: '50m',          // ← /tmp size limit
    user: '1000:1000',         // ← Non-root UID:GID
    capDrop: ['ALL'],          // ← Drop ALL Linux capabilities
    securityOpt: ['no-new-privileges:true'],  // ← Prevent privilege escalation
  },
  // Execution limits
  timeout: 30_000,             // 30 seconds max
  maxOutputSize: 100_000,      // 100KB max output
  // Paths
  sandboxDir: path.join(os.tmpdir(), 'ai-sandbox-docker'),
};

// ═══════════════════════════════════════════════════════════════
// LANGUAGE CONFIGURATION
// ═══════════════════════════════════════════════════════════════

const LANG_CONFIG = {
  python: {
    ext: '.py',
    filename: 'main.py',
    cmd: ['python3', '/sandbox/code.py'],
  },
  javascript: {
    ext: '.js',
    filename: 'main.js',
    cmd: ['node', '/sandbox/code.js'],
  },
  c: {
    ext: '.c',
    filename: 'main.c',
    compileCmd: ['gcc', '/sandbox/code.c', '-o', '/tmp/main', '-static', '-O2'],
    cmd: ['/tmp/main'],
  },
  cpp: {
    ext: '.cpp',
    filename: 'main.cpp',
    compileCmd: ['g++', '/sandbox/code.cpp', '-o', '/tmp/main', '-static', '-std=c++17', '-O2'],
    cmd: ['/tmp/main'],
  },
  java: {
    ext: '.java',
    filename: 'Main.java',
    compileCmd: ['javac', '/sandbox/code.java', '-d', '/tmp/'],
    cmd: ['java', '-Xmx64m', '-cp', '/tmp/', 'Main'],
  },
  rust: {
    ext: '.rs',
    filename: 'main.rs',
    compileCmd: ['rustc', '/sandbox/code.rs', '-o', '/tmp/main', '-C', 'opt-level=2'],
    cmd: ['/tmp/main'],
  },
  go: {
    ext: '.go',
    filename: 'main.go',
    cmd: ['go', 'run', '/sandbox/code.go'],
  },
};

// ═══════════════════════════════════════════════════════════════
// DOCKER AVAILABILITY CHECK
// ═══════════════════════════════════════════════════════════════

let dockerAvailable = null;
let imageBuilt = null;

/**
 * Kiểm tra Docker daemon có đang chạy không
 */
export async function isDockerAvailable() {
  if (dockerAvailable !== null) return dockerAvailable;

  try {
    await execFileAsync('docker', ['info'], { timeout: 5000 });
    dockerAvailable = true;
    return true;
  } catch {
    dockerAvailable = false;
    return false;
  }
}

/**
 * Kiểm tra sandbox image đã được build chưa
 */
export async function isImageBuilt() {
  if (imageBuilt !== null) return imageBuilt;

  try {
    const { stdout } = await execFileAsync('docker', ['images', '-q', CONFIG.docker.image], { timeout: 5000 });
    imageBuilt = stdout.trim().length > 0;
    return imageBuilt;
  } catch {
    imageBuilt = false;
    return false;
  }
}

/**
 * Build sandbox image (chỉ cần chạy 1 lần)
 */
export async function buildSandboxImage() {
  const dockerfilePath = path.join(process.cwd(), 'Dockerfile.sandbox');

  try {
    await access(dockerfilePath, constants.R_OK);
  } catch {
    throw new Error('Dockerfile.sandbox not found. Cannot build sandbox image.');
  }

  console.log('[Sandbox] Building Docker sandbox image...');
  const { stdout, stderr } = await execFileAsync('docker', [
    'build',
    '-t', CONFIG.docker.image,
    '-f', dockerfilePath,
    '--no-cache',
    '.'
  ], { timeout: 300_000 }); // 5 min build timeout

  imageBuilt = true;
  console.log('[Sandbox] ✅ Sandbox image built successfully');
  return { stdout, stderr };
}

/**
 * Tự động setup: check Docker → check image → build nếu cần
 */
export async function ensureSandboxReady() {
  const dockerOk = await isDockerAvailable();
  if (!dockerOk) {
    return { ready: false, reason: 'Docker is not available. Install Docker Desktop or use in-process sandbox.' };
  }

  const imageOk = await isImageBuilt();
  if (!imageOk) {
    try {
      await buildSandboxImage();
      return { ready: true, reason: 'Sandbox image built and ready' };
    } catch (err) {
      return { ready: false, reason: `Failed to build sandbox image: ${err.message}` };
    }
  }

  return { ready: true, reason: 'Sandbox image already exists' };
}

// ═══════════════════════════════════════════════════════════════
// CORE: DOCKER SANDBOX EXECUTION
// ═══════════════════════════════════════════════════════════════

/**
 * Chạy code bên trong Docker container cách ly hoàn toàn
 *
 * @param {string} code     - Source code cần chạy
 * @param {string} language - Ngôn ngữ (python, javascript, c, cpp, java, rust, go)
 * @param {Object} options  - { timeout?: number, input?: string }
 * @returns {Promise<{success: boolean, output: string, error: string, blocked: boolean, timedOut: boolean, exitCode: number, method: string}>}
 */
export async function runInDockerSandbox(code, language, options = {}) {
  const lang = language || detectLanguage(code);
  const config = LANG_CONFIG[lang];

  if (!config) {
    return {
      success: false,
      output: '',
      error: `Unsupported language: ${lang}. Supported: ${Object.keys(LANG_CONFIG).join(', ')}`,
      blocked: false,
      timedOut: false,
      exitCode: -1,
      method: 'docker',
    };
  }

  const timeout = options.timeout || CONFIG.timeout;
  const id = `sb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const workDir = path.join(CONFIG.sandboxDir, id);

  try {
    // ── Step 1: Create temp directory for this execution ──
    await mkdir(workDir, { recursive: true });
    const codeFile = path.join(workDir, config.filename);
    await writeFile(codeFile, code, 'utf8');

    // ── Step 2: Build Docker run command with ALL security flags ──
    const dockerArgs = [
      'run',
      '--rm',                                    // Auto-destroy after execution
      '--name', id,                              // Named for debugging
      '--network', CONFIG.docker.network,        // ← NO NETWORK
      '--memory', CONFIG.docker.memory,          // ← RAM limit
      '--memory-swap', CONFIG.docker.memorySwap, // ← No swap
      '--cpus', CONFIG.docker.cpus,              // ← CPU limit
      '--pids-limit', String(CONFIG.docker.pidsLimit), // ← Process limit
      '--read-only',                             // ← Read-only root FS
      '--tmpfs', `/tmp:rw,noexec,size=${CONFIG.docker.tmpfsSize}`, // Writable /tmp
      '--user', CONFIG.docker.user,              // ← Non-root user
      '--cap-drop', 'ALL',                       // ← Drop ALL capabilities
      '--security-opt', 'no-new-privileges:true', // ← No privilege escalation
      '--stop-signal', 'SIGKILL',                // ← Force kill on timeout
      '-v', `${codeFile}:/sandbox/${config.filename}:ro`, // Mount code read-only
    ];

    // Add compile volume if needed (compiler writes to /tmp)
    if (config.compileCmd) {
      dockerArgs.push('-v', `${workDir}:/tmp:rw`);
    }

    dockerArgs.push(CONFIG.docker.image);

    // ── Step 3: Compile (if needed) ──
    if (config.compileCmd) {
      const compileArgs = [...dockerArgs, ...config.compileCmd];
      try {
        const compileResult = await execWithTimeout(compileArgs, timeout);
        if (compileResult.exitCode !== 0) {
          return {
            success: false,
            output: compileResult.stdout,
            error: `❌ COMPILE ERROR:\n${compileResult.stderr}`,
            blocked: false,
            timedOut: compileResult.timedOut,
            exitCode: compileResult.exitCode,
            method: 'docker',
          };
        }
      } catch (err) {
        return {
          success: false,
          output: '',
          error: `❌ COMPILE FAILED: ${err.message}`,
          blocked: false,
          timedOut: err.message.includes('TIMEOUT'),
          exitCode: -1,
          method: 'docker',
        };
      }
    }

    // ── Step 4: Run the code ──
    const runArgs = [...dockerArgs, ...config.cmd];
    const result = await execWithTimeout(runArgs, timeout);

    // ── Step 5: Parse and return results ──
    let stdout = result.stdout;
    let stderr = result.stderr;

    // Truncate output if too large
    if (stdout.length > CONFIG.maxOutputSize) {
      stdout = stdout.slice(0, CONFIG.maxOutputSize) + '\n... [OUTPUT TRUNCATED]';
    }
    if (stderr.length > CONFIG.maxOutputSize) {
      stderr = stderr.slice(0, CONFIG.maxOutputSize) + '\n... [ERROR TRUNCATED]';
    }

    return {
      success: result.exitCode === 0,
      output: stdout.trim(),
      error: stderr.trim() || null,
      blocked: false,
      timedOut: result.timedOut,
      exitCode: result.exitCode,
      method: 'docker',
    };

  } finally {
    // ── Step 6: Cleanup temp directory ──
    try { await rm(workDir, { recursive: true, force: true }); } catch { /* ignore */ }

    // ── Step 7: Force kill container if still running (safety net) ──
    try {
      execSync(`docker kill ${id} 2>/dev/null`, { timeout: 5000 });
    } catch { /* container already dead, that's fine */ }
  }
}

/**
 * Execute a command with timeout
 */
function execWithTimeout(args, timeoutMs) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let killed = false;

    const proc = execFile(args[0], args.slice(1), {
      timeout: timeoutMs,
      maxBuffer: CONFIG.maxOutputSize * 2,
      killSignal: 'SIGKILL',
    });

    proc.stdout?.on('data', (d) => { stdout += d.toString(); });
    proc.stderr?.on('data', (d) => { stderr += d.toString(); });

    proc.on('error', (err) => {
      const isTimeout = err.killed || err.code === 'ETIMEDOUT';
      resolve({
        stdout,
        stderr: stderr + (isTimeout ? `\n⏰ TIMEOUT: Exceeded ${timeoutMs / 1000}s` : `\n❌ ${err.message}`),
        exitCode: -1,
        timedOut: isTimeout,
      });
    });

    proc.on('close', (code) => {
      resolve({
        stdout,
        stderr,
        exitCode: code || 0,
        timedOut: false,
      });
    });
  });
}

// ═══════════════════════════════════════════════════════════════
// LANGUAGE DETECTION
// ═══════════════════════════════════════════════════════════════

function detectLanguage(code) {
  if (code.includes('#include <iostream>') || code.includes('std::')) return 'cpp';
  if (code.includes('#include <') && (code.includes('printf') || code.includes('scanf'))) return 'c';
  if (code.includes('public class') || code.includes('System.out.println')) return 'java';
  if (code.includes('fn main()') || code.includes('println!')) return 'rust';
  if (code.includes('package main') && code.includes('func ')) return 'go';
  if (code.includes('def ') || code.includes('import ') || code.includes('print(')) return 'python';
  if (code.includes('console.log') || code.includes('const ') || code.includes('function ')) return 'javascript';
  return 'python';
}

// ═══════════════════════════════════════════════════════════════
// UNIFIED INTERFACE: Auto-select Docker or In-Process
// ═══════════════════════════════════════════════════════════════

/**
 * Unified sandbox execution — tự động chọn Docker (ưu tiên) hoặc in-process fallback
 *
 * @param {string} code     - Source code
 * @param {string} language - Ngôn ngữ
 * @param {Object} options  - { timeout?: number, forceMethod?: 'docker' | 'in-process' }
 * @returns {Promise<Object>} Execution result
 */
export async function execute(code, language, options = {}) {
  // Force specific method
  if (options.forceMethod === 'in-process') {
    const { executeCode } = await import('./lib/code_sandbox.js');
    const result = await executeCode(code, language);
    return { ...result, method: 'in-process' };
  }

  if (options.forceMethod === 'docker') {
    return runInDockerSandbox(code, language, options);
  }

  // Auto-select: Docker first, fallback to in-process
  const dockerOk = await isDockerAvailable();
  if (dockerOk && (await isImageBuilt())) {
    return runInDockerSandbox(code, language, options);
  }

  // Fallback to in-process sandbox
  console.warn('[Sandbox] Docker not available, falling back to in-process sandbox (lower security)');
  const { executeCode } = await import('./lib/code_sandbox.js');
  const result = await executeCode(code, language);
  return { ...result, method: 'in-process' };
}

export { LANG_CONFIG as SUPPORTED_LANGUAGES };
