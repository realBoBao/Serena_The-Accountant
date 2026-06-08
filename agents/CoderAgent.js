/**
 * CoderAgent — Chuyên gia Giải thuật & Gỡ lỗi
 *
 * Vai trò: Viết code, tối ưu Big O, kiểm thử, tự gỡ lỗi (self-debug loop).
 * Công cụ: Điều khiển trực tiếp code_sandbox.js (AddressSanitizer cho C/C++).
 *
 * ═══ Vòng lặp cốt lõi (Self-Correction Loop) ═══
 *   Nhận yêu cầu → Viết code → Wrap Sanitizer → Chạy Sandbox → Thu kết quả
 *     ├─ Thành công → Trả stdout + Big O
 *     └─ Thất bại  → Trả stderr (segfault, etc.) + dòng code gây lỗi
 *                     → LLM sửa lại → Lặp lại (tối đa maxRetries)
 *
 * ═══ Feedback cho PlannerAgent ═══
 *   Thành công: { status: 'success', stdout, bigO: { time, space }, code }
 *   Thất bại:  { status: 'failed',  stderr, errorLine, errorType, errorCode, code }
 *
 * Được gọi bởi:
 * - PlannerAgent (trong DAG, CoderAgent là một step)
 * - DebateAgent  (trong debate, CoderAgent đưa giải pháp code cụ thể)
 * - discord_bot.js (command: !code <bài toán>)
 */

import { executeCode, getSupportedLanguages } from '../lib/code_sandbox.js';
import { invokeLlm } from './RagAgent.js';
import { HumanMessage } from '@langchain/core/messages';
import { getLogger } from '../lib/logger.js';
import { totSolve } from '../lib/tot_mcts.js';
import { detectAlgorithm, runTests } from '../lib/test_harness.js';

const logger = getLogger('CoderAgent');

// ── Cấu hình ──
const MAX_OUTPUT_LENGTH = 4_000;
const MAX_DEBUG_ROUNDS = 3;        // Số vòng lặp tự sửa lỗi tối đa
const MAX_CODE_LENGTH = 8_000;

// ═══════════════════════════════════════════════════════════════
// MEMORY SANITIZER — AddressSanitizer cho C/C++
// ═══════════════════════════════════════════════════════════════

/**
 * Bọc code C/C++ với memory sanitizer guards.
 * AddressSanitizer phát hiện: buffer overflow, use-after-free, memory leak, etc.
 */
function wrapWithMemorySanitizer(code, language) {
  if (language === 'c') {
    return `/* [CoderAgent] Memory Sanitizer: -fsanitize=address -g -O1 */
#include <stdlib.h>
#include <stdio.h>
#include <string.h>

#define SAFE_FREE(ptr) { if (ptr) { free(ptr); ptr = NULL; } }

${code}
`;
  }
  if (language === 'cpp') {
    return `/* [CoderAgent] Memory Sanitizer: -fsanitize=address -g -O1 -std=c++17 */
#include <iostream>
#include <vector>
#include <string>
#include <memory>
using namespace std;

${code}
`;
  }
  return code;
}

export function needsMemorySanitizer(language) {
  return language === 'c' || language === 'cpp';
}

// ═══════════════════════════════════════════════════════════════
// ERROR ANALYSIS — Xác định dòng code gây lỗi từ stderr
// ═══════════════════════════════════════════════════════════════

/**
 * Phân tích stderr để tìm dòng code gây lỗi.
 * Hỗ trợ format:
 *   - GCC/Clang: "file.c:12:5: error: ..."
 *   - ASan: "#0 0x... in function file.c:12" + loại lỗi (heap-buffer-overflow, etc.)
 *   - Python: 'File "file.py", line 12, in <module>'
 *   - Java: "Main.java:12: error: ..."
 *   - Node.js: "file.js:12:5: ..."
 *   - Segmentation Fault, Timeout
 *
 * @returns {{ errorLine, errorLineText, errorType, summary }}
 */
export function analyzeError(stderr, code) {
  if (!stderr) {
    return { errorLine: null, errorLineText: null, errorType: null, summary: null };
  }

  const lines = code.split('\n');
  let errorLine = null;
  let errorType = null;

  // ── 1. AddressSanitizer stack trace (check BEFORE GCC to avoid false match) ──
  const asanMatch = stderr.match(/#\d+\s+0x[\da-f]+\s+in\s+\w+\s+[^:]+\.(?:c|cpp|cc|cxx):(\d+)/i);
  if (asanMatch) {
    errorLine = parseInt(asanMatch[1], 10);
    if (/heap-buffer-overflow/i.test(stderr)) errorType = 'heap_buffer_overflow';
    else if (/stack-buffer-overflow/i.test(stderr)) errorType = 'stack_buffer_overflow';
    else if (/use-after-free/i.test(stderr) || /heap-use-after-free/i.test(stderr)) errorType = 'use_after_free';
    else if (/memory leak/i.test(stderr) || /leak/i.test(stderr)) errorType = 'memory_leak';
    else if (/double-free/i.test(stderr)) errorType = 'double_free';
    else if (/stack-overflow/i.test(stderr)) errorType = 'stack_overflow';
    else errorType = 'address_sanitizer_error';
  }

  // ── 2. GCC/Clang: "file.c:12:5: error: ..." ──
  if (!errorLine) {
    const gccMatch = stderr.match(/\w+\.(c|cpp|cc|cxx|java|cs):(\d+):/);
    if (gccMatch) {
      errorLine = parseInt(gccMatch[2], 10);
      const typeMatch = stderr.match(/:\s*(error|warning|fatal error)\s*:/i);
      errorType = typeMatch ? typeMatch[1] : 'compile_error';
    }
  }

  // ── 3. Python traceback ──
  if (!errorLine) {
    const pyMatch = stderr.match(/File\s+"[^"]+",\s+line\s+(\d+)/);
    if (pyMatch) {
      errorLine = parseInt(pyMatch[1], 10);
      const excMatch = stderr.match(/(\w+Error|\w+Exception)/);
      errorType = excMatch ? excMatch[1].toLowerCase() : 'runtime_error';
    }
  }

  // ── 4. Node.js ──
  if (!errorLine) {
    const nodeMatch = stderr.match(/\w+\.js:(\d+)/);
    if (nodeMatch) {
      errorLine = parseInt(nodeMatch[1], 10);
      const excMatch = stderr.match(/(\w+Error)/);
      errorType = excMatch ? excMatch[1].toLowerCase() : 'runtime_error';
    }
  }

  // ── 5. Java ──
  if (!errorLine) {
    const javaMatch = stderr.match(/\w+\.java:(\d+)/);
    if (javaMatch) {
      errorLine = parseInt(javaMatch[1], 10);
      const excMatch = stderr.match(/(\w+Exception|\w+Error)/);
      errorType = excMatch ? excMatch[1].toLowerCase() : 'runtime_error';
    }
  }

  // ── 6. Segmentation Fault ──
  if (!errorLine && /segmentation fault|segfault|SIGSEGV/i.test(stderr)) {
    errorType = 'segmentation_fault';
  }

  // ── 7. Timeout ──
  if (!errorLine && /TIMEOUT|timed out/i.test(stderr)) {
    errorType = 'timeout';
  }

  const errorLineText = errorLine && errorLine > 0 && errorLine <= lines.length
    ? lines[errorLine - 1].trim()
    : null;

  const summary = buildErrorSummary(errorType, errorLine, errorLineText);

  return { errorLine, errorLineText, errorType, summary };
}

function buildErrorSummary(errorType, errorLine, errorLineText) {
  const typeLabels = {
    heap_buffer_overflow:    'Heap buffer overflow',
    stack_buffer_overflow:   'Stack buffer overflow',
    use_after_free:          'Use-after-free',
    memory_leak:             'Memory leak',
    double_free:             'Double free',
    stack_overflow:          'Stack overflow',
    address_sanitizer_error: 'AddressSanitizer error',
    segmentation_fault:      'Segmentation fault',
    timeout:                 'Timeout',
    compile_error:           'Compile error',
    error:                   'Compile error',
    warning:                 'Compile warning',
    'fatal error':           'Fatal compile error',
  };

  const label = typeLabels[errorType] || errorType || 'Unknown error';
  const lineInfo = errorLine ? ` at line ${errorLine}` : '';
  const codeInfo = errorLineText ? ` — "${errorLineText.slice(0, 80)}"` : '';

  return `${label}${lineInfo}${codeInfo}`;
}

// ═══════════════════════════════════════════════════════════════
// PROMPT BUILDERS
// ═══════════════════════════════════════════════════════════════

function buildCodePrompt(problem, language = null, action = null, dependencyResult = null) {
  const langHint = language ? ` bằng ngôn ngữ ${language}` : '';
  const actionHint = action ? `\n## Hành động cụ thể: ${action}` : '';
  const depHint = dependencyResult ? `\n## Kết quả từ bước trước:\n${typeof dependencyResult === 'string' ? dependencyResult : JSON.stringify(dependencyResult, null, 2)}` : '';
  return `Bạn là chuyên gia giải thuật và kiểm thử phần mềm hàng đầu.

## Bài toán:
${problem}${actionHint}${depHint}

## Yêu cầu nghiêm ngặt:
1. Viết code${langHint} hoàn chỉnh, chạy được (KHÔNG phải pseudocode)
2. Code PHẢI có try/catch hoặc xử lý lỗi đầy đủ (edge cases, input validation)
3. Phân tích độ phức tạp thời gian (Big O) và không gian
4. Viết ít nhất 3 test cases (bao gồm edge cases)
5. Với C/C++: chú ý memory management (malloc/free, new/delete, tránh buffer overflow)
6. Code phải an toàn: không dùng eval, không truy cập file system, không gọi system()

## Định dạng trả về (TUYỆT ĐỐI tuân thủ):

\`\`\`[language]
// Code chính — hoàn chỉnh, chạy được
[code chính ở đây]
\`\`\`

\`\`\`[language]
// Test cases
[test code ở đây]
\`\`\`

## Phân tích Big O:
- Thời gian: O(?)
- Không gian: O(?)

## Giải thích:
[giải thích ngắn gọn cách tiếp cận]`;
}

/**
 * Tạo prompt sửa lỗi — gửi stderr + dòng code gây lỗi cho LLM
 */
function buildDebugPrompt(problem, language, originalCode, errorAnalysis) {
  const { errorType, errorLine, errorLineText, summary } = errorAnalysis;

  const errorDetails = [
    errorType    ? `- Loại lỗi: ${errorType}` : null,
    errorLine    ? `- Dòng lỗi: ${errorLine}` : null,
    errorLineText ? `- Code gây lỗi: "${errorLineText}"` : null,
  ].filter(Boolean).join('\n');

  return `Bạn là chuyên gia giải thuật và gỡ lỗi (debug) hàng đầu.

## Bài toán gốc:
${problem}

## Code đã viết (${language}):
\`\`\`${language}
${originalCode}
\`\`\`

## ❌ Lỗi phát hiện:
${summary}

${errorDetails}

## Yêu cầu:
1. Phân tích nguyên nhân gốc rễ (root cause) của lỗi
2. Viết lại code ĐÃ SỬA hoàn chỉnh
3. Giải thích ngắn gọn đã sửa gì

## Định dạng trả về:

\`\`\`${language}
// Code ĐÃ SỬA — hoàn chỉnh, chạy được
[fixed code ở đây]
\`\`\`

## Nguyên nhân gốc rễ:
[root cause]

## Cách sửa:
[explanation]`;
}

// ═══════════════════════════════════════════════════════════════
// CODE PARSER
// ═══════════════════════════════════════════════════════════════

function parseCodeResponse(response) {
  const result = {
    code: '',
    testCode: '',
    bigO: { time: '', space: '' },
    explanation: '',
    language: 'javascript',
  };

  const codeBlockRegex = /```(\w+)?\n([\s\S]*?)```/g;
  const blocks = [];
  let match;
  while ((match = codeBlockRegex.exec(response)) !== null) {
    blocks.push({ language: match[1] || '', code: match[2].trim() });
  }

  if (blocks.length >= 1) {
    result.code = blocks[0].code;
    result.language = normalizeLanguage(blocks[0].language) || detectLanguageFromCode(blocks[0].code);
  }
  if (blocks.length >= 2) {
    result.testCode = blocks[1].code;
  }

  const timeMatch = response.match(/Thời gian[:\s]*O\([^)]+\)/i) || response.match(/Time[:\s]*O\([^)]+\)/i);
  const spaceMatch = response.match(/Không gian[:\s]*O\([^)]+\)/i) || response.match(/Space[:\s]*O\([^)]+\)/i);
  if (timeMatch) result.bigO.time = timeMatch[0].replace(/[^O]*O\(/, 'O(').replace(/\).*/, ')').trim();
  if (spaceMatch) result.bigO.space = spaceMatch[0].replace(/[^O]*O\(/, 'O(').replace(/\).*/, ')').trim();

  const explainMatch = response.match(/Giải thích[:\s]*([\s\S]+?)(?=##|$)/i);
  if (explainMatch) result.explanation = explainMatch[1].trim();

  return result;
}

function normalizeLanguage(lang) {
  if (!lang) return null;
  const map = {
    js: 'javascript', javascript: 'javascript',
    py: 'python', python: 'python',
    c: 'c',
    cpp: 'cpp', 'c++': 'cpp', cc: 'cpp', cxx: 'cpp',
    java: 'java',
    rs: 'rust', rust: 'rust',
    go: 'go', golang: 'go',
    cs: 'csharp', csharp: 'csharp', 'c#': 'csharp',
  };
  return map[lang.toLowerCase()] || null;
}

function detectLanguageFromCode(code) {
  if (code.includes('#include <iostream>') || code.includes('std::')) return 'cpp';
  if (code.includes('#include <stdio.h>') || code.includes('#include <stdlib.h>')) return 'c';
  if (code.includes('public class') || code.includes('System.out.println')) return 'java';
  if (code.includes('fn main()') || code.includes('println!')) return 'rust';
  if (code.includes('package main') && code.includes('func ')) return 'go';
  if (code.includes('using System;') && code.includes('static void Main')) return 'csharp';
  if (code.includes('def ') || code.includes('print(') || code.includes('import ')) return 'python';
  return 'javascript';
}

// ═══════════════════════════════════════════════════════════════
// SANDBOX EXECUTOR
// ═══════════════════════════════════════════════════════════════

async function safeExecute(code, language, label = 'code') {
  try {
    const result = await executeCode(code, language);
    return {
      stdout: (result.output || '').slice(0, MAX_OUTPUT_LENGTH),
      stderr: (result.error || '').slice(0, MAX_OUTPUT_LENGTH),
      exitCode: result.exitCode,
      timedOut: result.timedOut || false,
      success: result.success && result.exitCode === 0,
    };
  } catch (err) {
    logger.error(`[CoderAgent] Sandbox execution failed for ${label}:`, err?.message || err);
    return {
      stdout: '',
      stderr: `Sandbox error: ${err.message}`,
      exitCode: -1,
      timedOut: false,
      success: false,
    };
  }
}

// ═══════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════

/**
 * ═══ VÒNG LẶP CỐT LÕI: solveWithDebugLoop ═══
 *
 * Nhận yêu cầu viết/sửa code → Chạy Sandbox (AddressSanitizer) → Thu kết quả.
 *
 * Thành công: Trả stdout + Big O (time & space).
 * Thất bại:   Trả stderr (segfault, etc.) + dòng code gây lỗi
 *             → LLM sửa lại → Lặp lại (tối đa maxRetries).
 *
 * @param {string} problem  - Mô tả bài toán
 * @param {object} options  - { language, maxRetries, runTests }
 * @returns {object} Feedback cho PlannerAgent
 *   Thành công: { status: 'success', stdout, bigO, code, language, attempts }
 *   Thất bại:   { status: 'failed',  stderr, errorLine, errorLineText, errorType,
 *                           errorCode, code, language, attempts, debugHistory }
 */
export async function solveWithDebugLoop(problem, options = {}) {
  const {
    language = null,
    maxRetries = options.maxRetries ?? MAX_DEBUG_ROUNDS,
    runTests = true,
    action = null,           // Từ PlannerAgent: mô tả hành động cụ thể
    dependencyResult = null, // Từ PlannerAgent: kết quả từ bước trước
  } = options;

  logger.info(`[CoderAgent] ▶ solveWithDebugLoop: "${problem.slice(0, 80)}..."`);

  // ── Phase 0: Tree of Thoughts — Chọn approach tốt nhất trước khi code ──
  // Chỉ dùng ToT cho bài toán phức tạp (có action hoặc dependency)
  let selectedApproach = null;
  if (action || dependencyResult || problem.length > 100) {
    logger.info('[CoderAgent] 🌳 Running ToT-MCTS to select best approach...');
    const totResult = await totSolve(problem, {
      language,
      maxBranches: 3,
      maxDepth: 2,
      executeCode: runTests ? (code, lang) => safeExecute(code, lang, 'tot-eval') : null,
    });

    if (totResult?.status === 'success' || totResult?.status === 'heuristic') {
      selectedApproach = totResult;
      logger.info(`[CoderAgent] 🌳 ToT selected: ${totResult.approach} (score: ${totResult.score.toFixed(2)})`);
      if (totResult.tree) {
        logger.info(`[CoderAgent] 🌳 Tree: ${totResult.tree.branches} branches, ${totResult.tree.pruned} pruned, ${totResult.tree.evaluated} evaluated`);
      }
    }
  }

  const debugHistory = [];
  let lastCode = null;
  let lastLanguage = language;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    logger.info(`[CoderAgent] ● Attempt ${attempt}/${maxRetries + 1}`);

    let parsed;

    if (attempt === 1) {
      // ── Vòng 1: Viết code mới (dùng approach từ ToT nếu có) ──
      const prompt = buildCodePrompt(
        problem,
        language,
        action || selectedApproach?.approach || null,
        dependencyResult || selectedApproach?.description || null
      );
      const raw = await invokeLlm([new HumanMessage(prompt)], `CoderAgent-solve-${attempt}`);
      parsed = parseCodeResponse(raw);
    } else {
      // ── Vòng 2+: Sửa lỗi dựa trên stderr + dòng code gây lỗi ──
      const prevError = debugHistory[debugHistory.length - 1];
      const errorAnalysis = prevError.errorAnalysis;

      logger.info(`[CoderAgent] ↻ Debug round ${attempt}: ${errorAnalysis.summary}`);

      const prompt = buildDebugPrompt(problem, lastLanguage, lastCode, errorAnalysis);
      const raw = await invokeLlm([new HumanMessage(prompt)], `CoderAgent-debug-${attempt}`);
      parsed = parseCodeResponse(raw);
    }

    if (!parsed.code) {
      logger.warn(`[CoderAgent] LLM returned no code on attempt ${attempt}`);
      debugHistory.push({
        attempt,
        error: 'LLM không sinh code',
        errorAnalysis: { errorType: 'no_code', summary: 'LLM không sinh code' },
      });
      continue;
    }

    if (parsed.code.length > MAX_CODE_LENGTH) {
      parsed.code = parsed.code.slice(0, MAX_CODE_LENGTH) + '\n// ... [truncated]';
    }

    lastCode = parsed.code;
    lastLanguage = parsed.language;

    // ── Wrap Memory Sanitizer cho C/C++ ──
    const useSanitizer = needsMemorySanitizer(parsed.language);
    const codeToRun = useSanitizer
      ? wrapWithMemorySanitizer(parsed.code, parsed.language)
      : parsed.code;

    // ── Chạy code chính qua Sandbox ──
    const execResult = await safeExecute(codeToRun, parsed.language, `attempt-${attempt}-main`);

    // ── Chạy test cases ──
    const testResults = [];
    if (runTests && parsed.testCode) {
      const testResult = await safeExecute(parsed.testCode, parsed.language, `attempt-${attempt}-test`);
      testResults.push({
        passed: testResult.success,
        stdout: testResult.stdout,
        stderr: testResult.stderr,
        exitCode: testResult.exitCode,
      });
    }

    // ── Formal Verification (Test Harness) ──
    // Auto-detect algorithm and run deterministic test cases
    let formalVerification = null;
    if (execResult.success && parsed.language === 'python') {
      const detectedAlgo = detectAlgorithm(problem);
      if (detectedAlgo) {
        logger.info(`[CoderAgent] Formal verification: running test harness for '${detectedAlgo}'`);
        formalVerification = await runTests(parsed.code, detectedAlgo, 'python');
        logger.info(`[CoderAgent] Formal verification: ${formalVerification.passed}/${formalVerification.total} tests passed`);
      }
    }

    // ── Phân tích kết quả ──
    const allTestsPassed = testResults.every(t => t.passed);
    const formalPassed = !formalVerification || formalVerification.allPassed;
    const success = execResult.success && (testResults.length === 0 || allTestsPassed) && formalPassed;

    if (success) {
      // ✅ THÀNH CÔNG — Trả stdout + Big O cho PlannerAgent
      logger.info(`[CoderAgent] ✅ Success on attempt ${attempt}`);
      return {
        status: 'success',
        agent: 'CoderAgent',
        problem,
        language: parsed.language,
        code: codeToRun,
        originalCode: parsed.code,
        stdout: execResult.stdout,
        bigO: parsed.bigO,
        explanation: parsed.explanation,
        execution: {
          exitCode: execResult.exitCode,
          timedOut: execResult.timedOut,
        },
        testResults,
        formalVerification: formalVerification ? {
          algorithm: detectAlgorithm(problem),
          passed: formalVerification.passed,
          total: formalVerification.total,
          allPassed: formalVerification.allPassed,
        } : null,
        attempts: attempt,
        memorySanitizer: useSanitizer,
        debugHistory,
      };
    }

    // ── THẤT BẠI — Phân tích lỗi để gửi feedback ──
    const combinedStderr = [
      execResult.stderr,
      ...testResults.filter(t => !t.passed).map(t => t.stderr),
    ].filter(Boolean).join('\n');

    // Add formal verification failures to error context
    let formalError = '';
    if (formalVerification && !formalVerification.allPassed) {
      const failedTests = formalVerification.results?.filter(r => !r.passed) || [];
      formalError = `\n\n[Formal Verification] ${formalVerification.passed}/${formalVerification.total} tests passed. Failed tests:\n${failedTests.map(t => `  ${t.output}`).join('\n')}`;
    }

    const errorAnalysis = analyzeError(combinedStderr + formalError, codeToRun);

    debugHistory.push({
      attempt,
      code: codeToRun,
      stderr: combinedStderr,
      exitCode: execResult.exitCode,
      timedOut: execResult.timedOut,
      errorAnalysis,
      testResults,
    });

    logger.warn(`[CoderAgent] ❌ Attempt ${attempt} failed: ${errorAnalysis.summary}`);
  }

  // ═══ TẤT CẢ VÒNG LẶP ĐỀU THẤT BẠI ═══
  const lastError = debugHistory[debugHistory.length - 1];
  const lastAnalysis = lastError.errorAnalysis;

  logger.error(`[CoderAgent] ✗ All ${maxRetries + 1} attempts failed. Last error: ${lastAnalysis.summary}`);

  return {
    status: 'failed',
    agent: 'CoderAgent',
    problem,
    language: lastLanguage,
    code: lastCode,
    stderr: lastError.stderr,
    exitCode: lastError.exitCode,
    // ── Thông tin lỗi chi tiết cho PlannerAgent ──
    errorLine: lastAnalysis.errorLine,
    errorLineText: lastAnalysis.errorLineText,
    errorType: lastAnalysis.errorType,
    errorCode: lastError.exitCode,
    summary: lastAnalysis.summary,
    // ── Lịch sử debug để PlannerAgent đánh giá ──
    attempts: maxRetries + 1,
    memorySanitizer: needsMemorySanitizer(lastLanguage),
    debugHistory: debugHistory.map(h => ({
      attempt: h.attempt,
      errorType: h.errorAnalysis.errorType,
      errorLine: h.errorAnalysis.errorLine,
      summary: h.errorAnalysis.summary,
      timedOut: h.timedOut,
    })),
  };
}

/**
 * Viết code mới (không chạy) — dùng cho DebateAgent
 */
export async function writeCode(problem, language = null) {
  const prompt = buildCodePrompt(problem, language);
  const raw = await invokeLlm([new HumanMessage(prompt)], 'CoderAgent-write');
  return parseCodeResponse(raw);
}

/**
 * Chạy code có sẵn — dùng cho PlannerAgent gọi lại
 */
export async function runCode(code, language) {
  const lang = language || detectLanguageFromCode(code);
  const codeToRun = needsMemorySanitizer(lang) ? wrapWithMemorySanitizer(code, lang) : code;
  const result = await safeExecute(codeToRun, lang, 'run-code');
  return { ...result, language: lang, memorySanitizer: needsMemorySanitizer(lang) };
}

/**
 * Tối ưu code đã có
 */
export async function optimizeCode(code, language, target = 'time') {
  const targetLabel = target === 'time' ? 'độ phức tạp thuật toán (Big O)' : 'độ phức tạp bộ nhớ';
  const prompt = `Bạn là chuyên gia tối ưu hiệu suất.

## Code hiện tại (${language}):
\`\`\`${language}
${code}
\`\`\`

## Yêu cầu:
Tối ưu code trên để cải thiện ${targetLabel}.

Trả về:
\`\`\`${language}
[optimized code]
\`\`\`

## So sánh Big O:
- Trước: O(?)
- Sau: O(?)

## Giải thích:
[explanation]`;

  const raw = await invokeLlm([new HumanMessage(prompt)], 'CoderAgent-optimize');
  return parseCodeResponse(raw);
}

/**
 * Debug code có lỗi (1 vòng, không loop)
 */
export async function debugCode(code, language, error) {
  const errorAnalysis = analyzeError(error, code);
  const prompt = buildDebugPrompt('Sửa lỗi code', language, code, errorAnalysis);
  const raw = await invokeLlm([new HumanMessage(prompt)], 'CoderAgent-debug');
  return parseCodeResponse(raw);
}

export function getCoderAgentLanguages() {
  return getSupportedLanguages();
}

/**
 * solveProblem — Alias cho solveWithDebugLoop (backward compat với PlannerAgent).
 * PlannerAgent gọi solveProblem(query, options) → chuyển thành solveWithDebugLoop.
 */
export async function solveProblem(problem, options = {}) {
  return solveWithDebugLoop(problem, options);
}
