/**
 * Code Execution Sandbox — Single Source of Truth
 * Nhận code C/C++/Java/Python/Rust/Go/C#, biên dịch và chạy trong sandbox.
 * Security: 4-layer analysis (commands, imports, patterns, exfiltration)
 * C/C++: AddressSanitizer (-fsanitize=address) enabled by default
 *
 * Security patterns are imported from code_sandbox_v2.js (the canonical 4-layer
 * pattern database) to avoid duplication. This file adds execution + language config.
 */
import { spawn } from 'child_process';
import { writeFile, mkdir, rm } from 'fs/promises';
import path from 'path';
import os from 'os';
import {
  DANGEROUS_COMMANDS,
  DANGEROUS_IMPORTS,
  DANGEROUS_PATTERNS,
  EXFILTRATION_PATTERNS,
} from './code_sandbox_v2.js';

const SANDBOX_DIR = path.join(os.tmpdir(), 'ai-sandbox');
const TIMEOUT_MS = 5_000;
const MAX_OUTPUT_SIZE = 50_000; // 50KB max output per execution

// ═══════════════════════════════════════════════════════════════
// SECURITY ANALYSIS — uses canonical patterns from code_sandbox_v2.js
// ═══════════════════════════════════════════════════════════════

/**
 * Phân tích code qua 4 lớp bảo mật.
 * Patterns imported from code_sandbox_v2.js (single source of truth).
 * @returns {{ safe: boolean, reason: string, layer: number }}
 */
export function analyzeCodeSecurity(code) {
  for (const p of DANGEROUS_COMMANDS) {
    if (p.test(code)) return { safe: false, reason: `🚫 [Layer 1] Dangerous command: ${p.toString().slice(0, 60)}`, layer: 1 };
  }
  for (const p of DANGEROUS_IMPORTS) {
    if (p.test(code)) return { safe: false, reason: `🚫 [Layer 2] Dangerous import: ${p.toString().slice(0, 60)}`, layer: 2 };
  }
  for (const p of DANGEROUS_PATTERNS) {
    if (p.test(code)) return { safe: false, reason: `🚫 [Layer 3] Dangerous pattern: ${p.toString().slice(0, 60)}`, layer: 3 };
  }
  for (const p of EXFILTRATION_PATTERNS) {
    if (p.test(code)) return { safe: false, reason: `🚫 [Layer 4] Data exfiltration: ${p.toString().slice(0, 60)}`, layer: 4 };
  }
  return { safe: true, reason: null, layer: 0 };
}

const LANG_CONFIG = {
  python: {
    ext: '.py',
    cmd: 'python',
    args: ['{file}'],
    compile: null,
  },
  javascript: {
    ext: '.js',
    cmd: 'node',
    args: ['{file}'],
    compile: null,
  },
  c: {
    ext: '.c',
    cmd: 'gcc',
    args: ['{file}', '-o', '{out}', '-fsanitize=address', '-g', '-O1'],
    compile: true,
    runCmd: '{out}',
    runArgs: [],
    memoryCheck: true,
  },
  cpp: {
    ext: '.cpp',
    cmd: 'g++',
    args: ['{file}', '-o', '{out}', '-std=c++17', '-fsanitize=address', '-g', '-O1'],
    compile: true,
    runCmd: '{out}',
    runArgs: [],
    memoryCheck: true,
  },
  java: {
    ext: '.java',
    cmd: 'javac',
    args: ['{file}'],
    compile: true,
    runCmd: 'java',
    runArgs: ['-cp', '{dir}', '-Xmx64m', '-Xms16m', '{className}'],
  },
  rust: {
    ext: '.rs',
    cmd: 'rustc',
    args: ['{file}', '-o', '{out}', '-C', 'opt-level=3'],
    compile: true,
    runCmd: '{out}',
    runArgs: [],
  },
  go: {
    ext: '.go',
    cmd: 'go',
    args: ['run', '{file}'],
    compile: false,
    runCmd: null,
    runArgs: [],
  },
  csharp: {
    ext: '.cs',
    cmd: 'csc',
    args: ['{file}', '-out:{out}.exe'],
    compile: true,
    runCmd: '{out}.exe',
    runArgs: [],
  },
  // ── Manim: Python-based animation engine ──
  // Requires: manim (pip), ffmpeg, libcairo, libpango, texlive
  // Usage: executeCode({ code: manimScript, language: 'manim', sceneName: 'MyScene' })
  manim: {
    ext: '.py',
    cmd: 'manim',
    args: ['-qm', '--format', 'mp4', '-o', 'output', '{file}', '{sceneName}'],
    compile: false,
    runCmd: null,
    runArgs: [],
    timeout: 120_000, // 2 min render timeout
  },
};

async function ensureSandbox() {
  await mkdir(SANDBOX_DIR, { recursive: true });
}

export function getLang(code) {
  // Auto-detect language từ code
  if (code.includes('#include <iostream>') || code.includes('std::') || code.includes('using namespace std')) return 'cpp';
  if (code.includes('#include <stdio.h>') || code.includes('#include <stdlib.h>') || /^\s*#include\s*<.*\.h>/m.test(code)) return 'c';
  if (code.includes('public class') || code.includes('import java.') || code.includes('System.out.println')) return 'java';
  if (code.includes('fn main()') || code.includes('use std::') || code.includes('println!')) return 'rust';
  if (code.includes('package main') && code.includes('func ')) return 'go';
  if (code.includes('using System;') && code.includes('static void Main')) return 'csharp';
  if (code.includes('def ') || code.includes('import ') || code.includes('print(')) return 'python';
  if (code.includes('const ') || code.includes('let ') || code.includes('function ') || code.includes('console.log')) return 'javascript';
  return 'python'; // default
}

function extractJavaClassName(code) {
  const match = code.match(/public\s+class\s+(\w+)/);
  return match ? match[1] : 'Main';
}

async function runCommand(cmd, args, cwd, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let killed = false;

    const proc = spawn(cmd, args, { cwd, shell: false });

    const timer = setTimeout(() => {
      killed = true;
      proc.kill('SIGTERM');
      resolve({ stdout, stderr: stderr + '\n⏰ TIMEOUT: Code execution exceeded ' + (timeoutMs / 1000) + 's limit', exitCode: -1, timedOut: true });
    }, timeoutMs);

    proc.stdout.on('data', (d) => {
      stdout += d.toString();
      if (stdout.length > MAX_OUTPUT_SIZE) stdout = stdout.slice(0, MAX_OUTPUT_SIZE) + '\n[TRUNCATED]';
    });
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > MAX_OUTPUT_SIZE) stderr = stderr.slice(0, MAX_OUTPUT_SIZE) + '\n[TRUNCATED]';
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: stderr + '\n❌ Error: ' + err.message, exitCode: -1, timedOut: false });
    });
    proc.on('close', (code) => {
      if (killed) return;
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code || 0, timedOut: false });
    });
  });
}

export async function executeCode(code, language = null, options = {}) {
  await ensureSandbox();

  // ── Security Check (4-layer) ──
  // Skip security check for Manim (it's our own generated code)
  const lang = language || getLang(code);
  const isManim = lang === 'manim';

  if (!isManim) {
    const security = analyzeCodeSecurity(code);
    if (!security.safe) {
      return { success: false, output: '', error: security.reason, blocked: true, language: lang };
    }
  }

  const config = LANG_CONFIG[lang];
  if (!config) {
    return { success: false, output: '', error: `Unsupported language: ${lang}`, blocked: false, language: lang };
  }

  const id = `sandbox-${Date.now()}`;
  const dir = path.join(SANDBOX_DIR, id);
  await mkdir(dir, { recursive: true });

  const filename = lang === 'java' ? `${extractJavaClassName(code)}${config.ext}` : `main${config.ext}`;
  const filepath = path.join(dir, filename);
  const outpath = path.join(dir, 'main.exe');

  try {
    await writeFile(filepath, code, 'utf8');

    // ── Compile step (if needed) ──
    if (config.compile) {
      const compileArgs = config.args.map(a =>
        a.replace('{file}', filepath).replace('{out}', outpath).replace('{dir}', dir)
      );
      const compileResult = await runCommand(config.cmd, compileArgs, dir);

      if (compileResult.exitCode !== 0) {
        return {
          success: false,
          output: compileResult.stdout,
          error: `❌ COMPILE ERROR:\n${compileResult.stderr}`,
          language: lang,
          timedOut: compileResult.timedOut,
          blocked: false,
          exitCode: compileResult.exitCode,
        };
      }
    }

    // ── Run step ──
    let runCmd, runArgs;
    if (config.compile) {
      if (lang === 'java') {
        runCmd = 'java';
        runArgs = ['-cp', dir, extractJavaClassName(code)];
      } else {
        runCmd = outpath;
        runArgs = [];
      }
    } else {
      runCmd = config.cmd;
      // Replace placeholders: {file}, {sceneName}, {dir}
      const sceneName = options.sceneName || extractSceneName(code);
      runArgs = config.args.map(a =>
        a.replace('{file}', filepath)
         .replace('{sceneName}', sceneName)
         .replace('{dir}', dir)
      );
    }

    // Use language-specific timeout (Manim needs 2min, others 5s)
    const timeoutMs = config.timeout || TIMEOUT_MS;
    const runResult = await runCommand(runCmd, runArgs, dir, timeoutMs);

    // ── For Manim: find the output video file ──
    if (isManim && runResult.exitCode === 0) {
      const mediaDir = path.join(dir, 'media');
      try {
        const files = await (await import('fs/promises')).readdir(mediaDir, { recursive: true });
        const mp4File = files.find(f => f.endsWith('.mp4'));
        if (mp4File) {
          const videoPath = path.join(mediaDir, mp4File);
          // Copy to a persistent location before cleanup
          const persistDir = path.join(os.tmpdir(), 'manim-output');
          await mkdir(persistDir, { recursive: true });
          const persistPath = path.join(persistDir, `${id}.mp4`);
          await (await import('fs/promises')).copyFile(videoPath, persistPath);
          return {
            success: true,
            output: runResult.stdout.trim(),
            error: null,
            language: lang,
            timedOut: runResult.timedOut,
            exitCode: 0,
            blocked: false,
            videoPath: persistPath,
          };
        }
      } catch {
        // media dir might not exist if render failed
      }
    }

    return {
      success: runResult.exitCode === 0,
      output: runResult.stdout.trim(),
      error: runResult.stderr.trim() || null,
      language: lang,
      timedOut: runResult.timedOut,
      exitCode: runResult.exitCode,
      blocked: false,
    };
  } finally {
    // Cleanup sandbox dir (but NOT manim-output — that's handled by video_cdn cleanup)
    if (!isManim) {
      try { await rm(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    }
  }
}

/**
 * Extract Manim scene class name from Python code.
 * Used by sandbox to pass scene name to `manim` CLI.
 */
function extractSceneName(code) {
  const match = code.match(/class\s+(\w+)\s*\(\s*Scene\s*\)/);
  return match ? match[1] : 'Scene';
}

export function getSupportedLanguages() {
  return Object.keys(LANG_CONFIG);
}
