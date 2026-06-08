/**
 * ═══════════════════════════════════════════════════════════════
 * Multi-Agent Debate Protocol — Tòa Án Trọng Tài (Judge)
 * ═══════════════════════════════════════════════════════════════
 *
 * Cơ chế:
 * 1. Planner spawn 2 instance của CoderAgent giải bài toán theo 2 cách khác nhau
 * 2. Mỗi solution được chạy trong Sandbox → thu thập latency + memory
 * 3. RagAgent phản biện cả 2 giải pháp
 * 4. JudgeAgent chấm điểm dựa trên:
 *    - Chất lượng code (correctness, readability)
 *    - Hiệu suất thực tế (latency từ Sandbox)
 *    - Tài nguyên tiêu thụ (memory từ Sandbox)
 *    - Độ phức tạp thuật toán
 * 5. Chọn ra thuật toán tối ưu nhất
 *
 * Deadlock Prevention:
 * - maxRounds capped at 5
 * - Per-round timeout (60s)
 * - Total debate timeout (5 min)
 * - Sandbox timeout (5s per execution)
 */

import { HumanMessage } from '@langchain/core/messages';
import { invokeLlm } from './RagAgent.js';
import { solveWithDebugLoop } from './CoderAgent.js';
import { withTimeout, TimeoutError } from '../lib/with_timeout.js';
import { sandboxGateway } from '../sandbox_gateway.js';
import { getLogger } from '../lib/logger.js';

const logger = getLogger('DebateAgent');

const DEBATE_ROUNDS = 3;
const MAX_DEBATE_ROUNDS = 5;
const PER_ROUND_TIMEOUT = 60_000;
const TOTAL_DEBATE_TIMEOUT = 300_000;

// ── Scoring Weights for Judge ──
const SCORE_WEIGHTS = {
  correctness: 0.30,
  performance: 0.25,
  memory: 0.15,
  readability: 0.15,
  scalability: 0.15,
};

/**
 * CoderAgent Instance A: Giải theo cách tiếp cận thuật toán/đời thường
 * → Tập trung vào correctness, readability, maintainability
 */
/**
 * CoderAgent Instance A: Giải theo cách tiếp cận đúng đắn, dễ đọc, dễ bảo trì.
 * Delegates to CoderAgent.solveWithDebugLoop (AddressSanitizer + self-debug).
 */
async function coderAgentA(problem, previousRounds = []) {
  const context = previousRounds.length > 0
    ? `\n\n## Các vòng tranh luận trước:\n${previousRounds.map((r, i) =>
        `Vòng ${i + 1}:\nCoder A: ${r.coderA?.solution?.slice(0, 200) || '(không có)'}\nCoder B: ${r.coderB?.solution?.slice(0, 200) || '(không có)'}\nRag: ${r.rag?.slice(0, 200) || '(không có)'}`
      ).join('\n\n')}`
    : '';

  const styledProblem = `${problem}${context}\n\n## Phong cách: Tập trung vào TÍNH ĐÚNG ĐẮN, DỄ ĐỌC, DỂ BẢO TRÌ. Ưu tiên code sạch, dễ hiểu, ít bug.`;

  const result = await solveWithDebugLoop(styledProblem, { language: 'python', maxRetries: 1, runTests: false });
  return result;
}

/**
 * CoderAgent Instance B: Giải theo cách tiếp cận hiệu suất/tối ưu.
 * Delegates to CoderAgent.solveWithDebugLoop (AddressSanitizer + self-debug).
 */
async function coderAgentB(problem, previousRounds = []) {
  const context = previousRounds.length > 0
    ? `\n\n## Các vòng tranh luận trước:\n${previousRounds.map((r, i) =>
        `Vòng ${i + 1}:\nCoder A: ${r.coderA?.solution?.slice(0, 200) || '(không có)'}\nCoder B: ${r.coderB?.solution?.slice(0, 200) || '(không có)'}\nRag: ${r.rag?.slice(0, 200) || '(không có)'}`
      ).join('\n\n')}`
    : '';

  const styledProblem = `${problem}${context}\n\n## Phong cách: Tập trung vào HIỆU SUẤT CAO, MEMORY THẤP, ĐỘ PHỨC TẠP TỐI ƯU. Ưu tiên tốc độ, tiết kiệm RAM.`;

  const result = await solveWithDebugLoop(styledProblem, { language: 'python', maxRetries: 1, runTests: false });
  return result;
}

/**
 * Extract code block from LLM response
 */
function extractCode(response) {
  const codeBlockMatch = response.match(/```(?:python|javascript|js|py)?\s*\n([\s\S]*?)\n```/i);
  if (codeBlockMatch) return codeBlockMatch[1].trim();
  const genericBlock = response.match(/```\s*\n([\s\S]*?)\n```/);
  if (genericBlock) return genericBlock[1].trim();
  return null;
}

/**
 * Detect language from code
 */
function detectLanguage(code) {
  if (code.includes('def ') || code.includes('import ') || code.includes('print(') || code.includes('elif ')) return 'python';
  if (code.includes('const ') || code.includes('let ') || code.includes('function ') || code.includes('console.log')) return 'javascript';
  return 'python';
}

/**
 * Run code in sandbox and collect metrics
 * Returns: { success, output, error, latencyMs, memoryKb, exitCode, timedOut }
 */
async function runInSandbox(code, language) {
  const startTime = process.hrtime.bigint();
  const startMemory = process.memoryUsage().heapUsed;

  try {
    const result = await sandboxGateway.execute({
      agent: 'debate',
      code,
      language,
      timeout: 5000,
    });

    const endTime = process.hrtime.bigint();
    const endMemory = process.memoryUsage().heapUsed;

    const latencyMs = Number(endTime - startTime) / 1_000_000;
    const memoryKb = Math.max(0, Math.round((endMemory - startMemory) / 1024));

    return {
      success: result.success,
      output: result.output || '',
      error: result.error || null,
      latencyMs: Math.round(latencyMs * 100) / 100,
      memoryKb,
      exitCode: result.exitCode ?? -1,
      timedOut: result.timedOut || false,
      blocked: result.blocked || false,
    };
  } catch (err) {
    const endTime = process.hrtime.bigint();
    const latencyMs = Number(endTime - startTime) / 1_000_000;

    return {
      success: false,
      output: '',
      error: `Sandbox error: ${err.message}`,
      latencyMs: Math.round(latencyMs * 100) / 100,
      memoryKb: 0,
      exitCode: -1,
      timedOut: false,
      blocked: false,
    };
  }
}

/**
 * RagAgent: Phân tích và phản biện cả 2 giải pháp dựa trên sandbox metrics
 */
async function ragAgentReview(problem, solutionA, solutionB, metricsA, metricsB, previousRounds = []) {
  const context = previousRounds.length > 0
    ? `\n\nCác vòng tranh luận trước:\n${previousRounds.map((r, i) =>
        `Vòng ${i + 1}:\nRag: ${r.rag?.slice(0, 300) || '(không có)'}`
      ).join('\n\n')}`
    : '';

  const prompt = `Bạn là chuyên gia review code và kiến trúc hệ thống. Phân tích và so sánh 2 giải pháp cho bài toán sau.

Bài toán: ${problem}

━━━ GIẢI PHÁP A (Tập trung đúng đắn, dễ đọc) ━━━
${solutionA.slice(0, 1500)}

**Sandbox Metrics A**:
- ✅ Chạy thành công: ${metricsA.success ? 'Có' : 'Không'}
- ⏱️ Latency: ${metricsA.latencyMs}ms
- 💾 Memory delta: ${metricsA.memoryKb}KB
- 📤 Output: ${metricsA.output?.slice(0, 200) || '(không có)'}
${metricsA.error ? `- ❌ Error: ${metricsA.error.slice(0, 200)}` : ''}

━━━ GIẢI PHÁP B (Tập trung hiệu suất, tối ưu) ━━━
${solutionB.slice(0, 1500)}

**Sandbox Metrics B**:
- ✅ Chạy thành công: ${metricsB.success ? 'Có' : 'Không'}
- ⏱️ Latency: ${metricsB.latencyMs}ms
- 💾 Memory delta: ${metricsB.memoryKb}KB
- 📤 Output: ${metricsB.output?.slice(0, 200) || '(không có)'}
${metricsB.error ? `- ❌ Error: ${metricsB.error.slice(0, 200)}` : ''}

━━━ YÊU CẦU PHÂN TÍCH ━━━
1. So sánh ưu/nhược điểm của 2 giải pháp
2. Giải pháp nào đúng hơn? (dựa trên sandbox output)
3. Giải pháp nào nhanh hơn? (dựa trên latency thực tế)
4. Giải pháp nào tiết kiệm memory hơn?
5. Edge cases nào cần lưu ý?
6. Gợi ý cải tiến cho cả 2

Trả lời bằng tiếng Việt, chi tiết và có căn cứ.${context}`;

  return invokeLlm([new HumanMessage(prompt)], 'RagAgent');
}

/**
 * JudgeAgent: Tòa Án Trọng Tài
 * Chấm điểm dựa trên metrics thực tế từ Sandbox + phân tích chất lượng
 */
async function judgeAgentFinal(problem, rounds) {
  const debateHistory = rounds.map((r, i) => {
    const mA = r.metricsA || {};
    const mB = r.metricsB || {};
    return `━━━ Vòng ${i + 1} ━━━
Coder A: ${(r.coderA?.solution || '').slice(0, 400)}
  → Sandbox: ${mA.success ? '✅' : '❌'} | Latency: ${mA.latencyMs}ms | Memory: ${mA.memoryKb}KB

Coder B: ${(r.coderB?.solution || '').slice(0, 400)}
  → Sandbox: ${mB.success ? '✅' : '❌'} | Latency: ${mB.latencyMs}ms | Memory: ${mB.memoryKb}KB

Rag Review: ${(r.rag || '').slice(0, 400)}`;
  }).join('\n\n');

  const avgLatencyA = rounds.reduce((s, r) => s + (r.metricsA?.latencyMs || 0), 0) / rounds.length;
  const avgLatencyB = rounds.reduce((s, r) => s + (r.metricsB?.latencyMs || 0), 0) / rounds.length;
  const avgMemoryA = rounds.reduce((s, r) => s + (r.metricsA?.memoryKb || 0), 0) / rounds.length;
  const avgMemoryB = rounds.reduce((s, r) => s + (r.metricsB?.memoryKb || 0), 0) / rounds.length;
  const successA = rounds.filter(r => r.metricsA?.success).length;
  const successB = rounds.filter(r => r.metricsB?.success).length;

  const prompt = `Bạn là CTO (Chief Technology Officer) — Tòa Án Trọng Tài cuối cùng.

Bài toán: ${problem}

━━━ LỊCH SỬ TRANH LUẬN ━━━
${debateHistory}

━━━ TỔNG HỢP METRICS THỰC TẾ TỪ SANDBOX ━━━
| Metric | Coder A (Đúng đắn) | Coder B (Hiệu suất) |
|---|---|---|
| Tỉ lệ chạy đúng | ${successA}/${rounds.length} vòng | ${successB}/${rounds.length} vòng |
| Latency trung bình | ${Math.round(avgLatencyA * 100) / 100}ms | ${Math.round(avgLatencyB * 100) / 100}ms |
| Memory trung bình | ${Math.round(avgMemoryA)}KB | ${Math.round(avgMemoryB)}KB |

━━━ NHIỆM VỤ CỦA TOÀ ÁN ━━━
Hãy đưa ra PHÁN QUYẾT CUỐI CÙNG bao gồm:

1. **BẢNG CHẤM ĐIỂM** (thang 1-10):
   - Correctness (30%): Code chạy đúng, output chính xác
   - Performance (25%): Latency thấp, throughput cao
   - Memory (15%): Tiêu thụ RAM thấp
   - Readability (15%): Code sạch, dễ maintain
   - Scalability (15%): Khả năng mở rộng

2. **NGƯỜI THẮNG**: Coder A hay Coder B? (Hoặc kết hợp cả 2?)

3. **GIẢI PHÁP TỐI ƯU CUỐI CÙNG**:
   - Kết hợp best ideas từ cả 2 bên
   - Code hoàn chỉnh đã tối ưu
   - Giải thích trade-offs đã chấp nhận

4. **KHUYẾN NGHỊ TRIỂN KHAI**:
   - Ưu tiên implement gì trước
   - Cần test gì thêm
   - Monitoring cần thiết

Trả lời bằng tiếng Việt, chi tiết và có căn cứ rõ ràng.`;

  return invokeLlm([new HumanMessage(prompt)], 'JudgeAgent');
}

/**
 * Run full multi-agent debate with sandbox metrics
 * @param {string} problem - Bài toán cần giải quyết
 * @param {object} options
 * @param {number} [options.rounds=3] - Số vòng tranh luận
 * @param {boolean} [options.skipSandbox=false] - Bỏ qua sandbox (chỉ LLM debate)
 * @returns {object} Debate result with metrics
 */
export async function runDebate(problem, options = {}) {
  const rounds = Math.min(options.rounds || DEBATE_ROUNDS, MAX_DEBATE_ROUNDS);
  const skipSandbox = options.skipSandbox || false;
  const debateLog = [];

  logger.info(`[DebateAgent] 🏛️ Bắt đầu tranh luận đa tác nhân: "${problem.slice(0, 60)}..."`);
  logger.info(`[DebateAgent] Số vòng: ${rounds} | Sandbox: ${skipSandbox ? 'OFF' : 'ON'}`);

  const startTime = Date.now();

  for (let i = 0; i < rounds; i++) {
    logger.info(`[DebateAgent] ━━━ Vòng ${i + 1}/${rounds} ━━━`);

    // ── Step 1: Both coders solve via CoderAgent (parallel) ──
    const [resultA, resultB] = await Promise.all([
      withTimeout(coderAgentA(problem, debateLog), PER_ROUND_TIMEOUT, 'CoderAgent-A timeout'),
      withTimeout(coderAgentB(problem, debateLog), PER_ROUND_TIMEOUT, 'CoderAgent-B timeout'),
    ]);

    // solveWithDebugLoop returns { status, code, stdout, stderr, errorLine, ... }
    const rawA = resultA.code || '';
    const rawB = resultB.code || '';

    logger.info(`[DebateAgent] Coder A: ${resultA.status} | ${rawA.slice(0, 80)}...`);
    logger.info(`[DebateAgent] Coder B: ${resultB.status} | ${rawB.slice(0, 80)}...`);

    // ── Step 2: Sandbox metrics (CoderAgent already ran sandbox, reuse metrics) ──
    const metricsA = {
      success: resultA.status === 'success',
      output: resultA.stdout || '',
      error: resultA.stderr || null,
      latencyMs: 0,  // CoderAgent doesn't track latency yet
      memoryKb: 0,
      exitCode: resultA.exitCode ?? (resultA.status === 'success' ? 0 : -1),
      timedOut: false,
      skipped: false,
    };
    const metricsB = {
      success: resultB.status === 'success',
      output: resultB.stdout || '',
      error: resultB.stderr || null,
      latencyMs: 0,
      memoryKb: 0,
      exitCode: resultB.exitCode ?? (resultB.status === 'success' ? 0 : -1),
      timedOut: false,
      skipped: false,
    };

    // If CoderAgent didn't run sandbox (e.g., LLM failed), run here as fallback
    if (!skipSandbox && resultA.status !== 'success' && rawA) {
      const langA = detectLanguage(rawA);
      const sandboxResult = await runInSandbox(rawA, langA);
      Object.assign(metricsA, sandboxResult);
    }
    if (!skipSandbox && resultB.status !== 'success' && rawB) {
      const langB = detectLanguage(rawB);
      const sandboxResult = await runInSandbox(rawB, langB);
      Object.assign(metricsB, sandboxResult);
    }

    // ── Step 3: Rag reviews both solutions with metrics ──
    const ragReview = await withTimeout(
      ragAgentReview(problem, rawA, rawB, metricsA, metricsB, debateLog),
      PER_ROUND_TIMEOUT,
      'RagAgent timeout'
    );
    logger.info(`[DebateAgent] Rag review: ${ragReview.slice(0, 80)}...`);

    debateLog.push({
      round: i + 1,
      coderA: { solution: rawA, metrics: metricsA, coderResult: resultA },
      coderB: { solution: rawB, metrics: metricsB, coderResult: resultB },
      rag: ragReview,
    });
  }

  // ── Step 4: Judge synthesizes final answer ──
  logger.info('[DebateAgent] ⚖️ Toà Án đang phán quyết...');
  const finalSolution = await withTimeout(
    judgeAgentFinal(problem, debateLog),
    PER_ROUND_TIMEOUT,
    'JudgeAgent timeout'
  );

  const totalTime = Date.now() - startTime;

  // ── Build summary metrics ──
  const summary = {
    totalRounds: rounds,
    totalTimeMs: totalTime,
    coderA: {
      avgLatencyMs: Math.round(debateLog.reduce((s, r) => s + (r.metricsA?.latencyMs || 0), 0) / rounds * 100) / 100,
      avgMemoryKb: Math.round(debateLog.reduce((s, r) => s + (r.metricsA?.memoryKb || 0), 0) / rounds),
      successRate: `${debateLog.filter(r => r.metricsA?.success).length}/${rounds}`,
    },
    coderB: {
      avgLatencyMs: Math.round(debateLog.reduce((s, r) => s + (r.metricsB?.latencyMs || 0), 0) / rounds * 100) / 100,
      avgMemoryKb: Math.round(debateLog.reduce((s, r) => s + (r.metricsB?.memoryKb || 0), 0) / rounds),
      successRate: `${debateLog.filter(r => r.metricsB?.success).length}/${rounds}`,
    },
  };

  logger.info(`[DebateAgent] ✅ Tranh luận hoàn tất trong ${totalTime}ms`);
  logger.info(`[DebateAgent] Summary: A=${summary.coderA.avgLatencyMs}ms/${summary.coderA.avgMemoryKb}KB | B=${summary.coderB.avgLatencyMs}ms/${summary.coderB.avgMemoryKb}KB`);

  return {
    problem,
    rounds: debateLog,
    finalSolution,
    summary,
    scoringWeights: SCORE_WEIGHTS,
  };
}

/**
 * Quick debate (1 round, skip sandbox for speed)
 */
export async function quickDebate(problem) {
  return runDebate(problem, { rounds: 1, skipSandbox: true });
}

/**
 * Full debate with sandbox metrics (explicit API)
 */
export async function fullDebate(problem, rounds = 3) {
  return runDebate(problem, { rounds, skipSandbox: false });
}

// ═══════════════════════════════════════════════════════════════
//  RAFT CONSENSUS DEBATE — Phiên bản không Judge trung tâm
// ═══════════════════════════════════════════════════════════════
//
// Thay thế JudgeAgent bằng Raft Consensus:
// - Mỗi CoderAgent và RagAgent là một RaftNode độc lập
// - Leader Election: các node bỏ phiếu chọn leader
// - Log Replication: proposal chỉ committed khi đa số đồng ý
// - Không single point of failure

import { RaftCluster } from '../lib/raft.js';

/**
 * Raft-based debate: thay Judge trung tâm bằng đồng thuận phân tán.
 *
 * Cơ chế:
 * 1. Tạo Raft cluster với các agent nodes (CoderA, CoderB, Rag, Sandbox)
 * 2. Leader Election → chọn node điều phối
 * 3. Mỗi round: leader gửi proposal → đa số ACK → commit
 * 4. Kết quả cuối cùng là entry cuối cùng được committed
 *
 * @param {string} problem - Bài toán cần giải quyết
 * @param {object} options
 * @param {number} [options.rounds=3]
 * @param {boolean} [options.skipSandbox=false]
 * @returns {object} Debate result với consensus
 */
export async function raftDebate(problem, options = {}) {
  const numRounds = Math.min(options.rounds || DEBATE_ROUNDS, MAX_DEBATE_ROUNDS);
  const skipSandbox = options.skipSandbox || false;

  logger.info(`[DebateAgent:Raft] 🏛️ Bắt đầu Raft Consensus Debate: "${problem.slice(0, 60)}..."`);

  // ── Phase 1: Leader Election qua LLM ──
  // Mỗi agent "bỏ phiếu" cho nhau dựa trên khả năng
  const voterAgents = ['CoderAgent-A', 'CoderAgent-B', 'RagAgent', 'SandboxAgent'];
  const votes = new Map();

  for (const voter of voterAgents) {
    const votePrompt = `Bạn là ${voter}. Bạn đang bỏ phiếu chọn LEADER cho cuộc tranh luận về bài toán:

"${problem.slice(0, 200)}"

Các ứng viên: CoderAgent-A, CoderAgent-B, RagAgent, SandboxAgent

Ai nên là LEADER? Chỉ trả lời TÊN của 1 agent (ví dụ: "RagAgent"). Không giải thích.`;

    try {
      const vote = await invokeLlm([new HumanMessage(votePrompt)], voter);
      const votedFor = vote.trim().replace(/['"]/g);
      votes.set(voter, votedFor);
    } catch {
      votes.set(voter, 'RagAgent'); // Default vote
    }
  }

  // Count votes
  const voteCount = new Map();
  for (const [, votedFor] of votes) {
    voteCount.set(votedFor, (voteCount.get(votedFor) || 0) + 1);
  }

  // Find leader (majority)
  let leader = 'RagAgent';
  let maxVotes = 0;
  for (const [candidate, count] of voteCount) {
    if (count > maxVotes) {
      maxVotes = count;
      leader = candidate;
    }
  }

  logger.info(`[DebateAgent:Raft] 🗳️ Leader Election: ${leader} (${maxVotes}/${voterAgents.length} votes)`);
  logger.info(`[DebateAgent:Raft] Vote details: ${[...votes.entries()].map(([v, c]) => `${v}→${c}`).join(', ')}`);

  // ── Phase 2: Raft Log Replication (simulated) ──
  const committedLog = [];
  const debateRounds = [];

  for (let round = 0; round < numRounds; round++) {
    logger.info(`[DebateAgent:Raft] ━━━ Vòng ${round + 1}/${numRounds} (Leader: ${leader}) ━━━`);

    // Leader proposes: spawn both coders in parallel
    const [resultA, resultB] = await Promise.all([
      withTimeout(coderAgentA(problem, debateRounds), PER_ROUND_TIMEOUT, 'CoderAgent-A timeout'),
      withTimeout(coderAgentB(problem, debateRounds), PER_ROUND_TIMEOUT, 'CoderAgent-B timeout'),
    ]);

    const rawA = resultA.code || '';
    const rawB = resultB.code || '';

    // Sandbox metrics
    const metricsA = { success: resultA.status === 'success', output: resultA.stdout || '', error: resultA.stderr || null, latencyMs: 0, memoryKb: 0 };
    const metricsB = { success: resultB.status === 'success', output: resultB.stdout || '', error: resultB.stderr || null, latencyMs: 0, memoryKb: 0 };

    if (!skipSandbox && rawA) {
      const langA = detectLanguage(rawA);
      Object.assign(metricsA, await runInSandbox(rawA, langA));
    }
    if (!skipSandbox && rawB) {
      const langB = detectLanguage(rawB);
      Object.assign(metricsB, await runInSandbox(rawB, langB));
    }

    // Leader gửi proposal để replicate
    const proposal = {
      round: round + 1,
      coderA: { solution: rawA, metrics: metricsA },
      coderB: { solution: rawB, metrics: metricsB },
      proposedAt: Date.now(),
    };

    // Các follower "ACK" proposal (dựa trên metrics)
    const acks = [];
    const ackVoters = ['CoderAgent-A', 'CoderAgent-B', 'RagAgent', 'SandboxAgent'].filter(a => a !== leader);

    for (const voter of ackVoters) {
      const ackPrompt = `Bạn là ${voter}. Leader ${leader} đã gửi proposal cho vòng ${round + 1}:

Coder A: ${metricsA.success ? '✅' : '❌'} | ${rawA.slice(0, 100)}
Coder B: ${metricsB.success ? '✅' : '❌'} | ${rawB.slice(0, 100)}

Bạn có ĐỒNG Ý (ACK) với proposal này không? Chỉ trả lời "ACK" hoặc "REJECT".`;

      try {
        const ack = await invokeLlm([new HumanMessage(ackPrompt)], voter);
        const isAck = ack.trim().toUpperCase().includes('ACK');
        acks.push({ voter, ack: isAck });
      } catch {
        acks.push({ voter, ack: true }); // Default ACK
      }
    }

    // Check majority (including leader)
    const totalNodes = voterAgents.length;
    const majority = Math.floor(totalNodes / 2) + 1;
    const ackCount = acks.filter(a => a.ack).length + 1; // +1 for leader

    const committed = ackCount >= majority;

    if (committed) {
      // Rag reviews
      const ragReview = await withTimeout(
        ragAgentReview(problem, rawA, rawB, metricsA, metricsB, debateRounds),
        PER_ROUND_TIMEOUT,
        'RagAgent timeout'
      );

      proposal.ragReview = ragReview;
      proposal.committed = true;
      proposal.acks = acks;
      committedLog.push(proposal);

      debateRounds.push({
        round: round + 1,
        coderA: { solution: rawA, metrics: metricsA, coderResult: resultA },
        coderB: { solution: rawB, metrics: metricsB, coderResult: resultB },
        rag: ragReview,
        leader,
        consensus: { committed: true, ackCount, majority },
      });

      logger.info(`[DebateAgent:Raft] ✅ Vòng ${round + 1} COMMITTED (${ackCount}/${totalNodes} ACKs)`);
    } else {
      proposal.committed = false;
      proposal.acks = acks;
      debateRounds.push({
        round: round + 1,
        coderA: { solution: rawA, metrics: metricsA },
        coderB: { solution: rawB, metrics: metricsB },
        leader,
        consensus: { committed: false, ackCount, majority },
      });

      logger.info(`[DebateAgent:Raft] ❌ Vòng ${round + 1} REJECTED (${ackCount}/${totalNodes} ACKs)`);
    }
  }

  // ── Phase 3: Final decision từ committed log ──
  const lastCommitted = committedLog[committedLog.length - 1];
  const finalPrompt = `Bạn là ${leader} (Leader được bầu bởi cluster). Dựa trên toàn bộ log đã committed:

${committedLog.map((e, i) => `Vòng ${i + 1}:
Coder A: ${e.coderA.solution.slice(0, 300)}
Coder B: ${e.coderB.solution.slice(0, 300)}
Rag: ${e.ragReview?.slice(0, 300) || '(không có)'}
Consensus: ${e.ackCount}/${voterAgents.length} ACKs`).join('\n\n')}

Hãy đưa ra GIẢI PHÁP TỐI ƯU CUỐI CÙNG cho bài toán: ${problem}

Bao gồm:
1. Người thắng (Coder A hoặc B) và lý do
2. Code tối ưu (kết hợp best ideas)
3. Trade-offs đã chấp nhận
4. Khuyến nghị triển khai`;

  const finalSolution = await invokeLlm([new HumanMessage(finalPrompt)], leader);

  return {
    problem,
    leader,
    voteCount: Object.fromEntries(voteCount),
    rounds: debateRounds,
    committedLog,
    finalSolution,
    consensusProtocol: 'Raft',
    totalCommitted: committedLog.length,
    totalRounds: numRounds,
  };
}

/**
 * Raft debate với in-memory cluster (cho testing).
 */
export async function raftDebateWithCluster(problem, options = {}) {
  const cluster = new RaftCluster(5);
  await cluster.start();

  try {
    const result = await cluster.propose({
      type: 'debate',
      problem,
      options,
    });

    return {
      problem,
      clusterStates: cluster.getAllStates(),
      result,
      messageCount: cluster.messageCount,
    };
  } finally {
    cluster.stop();
  }
}

// ═══════════════════════════════════════════════════════════════
//  PLANNER INTERVENTION — Vòng lặp Can thiệp
// ═══════════════════════════════════════════════════════════════
//
// Khi Planner bế tắc (ví dụ: CoderAgent sửa code C++ 3 vòng lặp liên tiếp
// vẫn văng lỗi Memory Leak), Planner sẽ "cầu cứu" DebateAgent.
//
// Cơ chế:
//   1. Đọc toàn bộ lịch sử lỗi trong Redis session
//   2. Phân tích pattern lỗi (memory leak, infinite loop, segfault, v.v.)
//   3. Spawn 2 hướng giải quyết song song:
//      - Hướng A: "Root cause fix" — Sửa gốc rễ vấn đề
//      - Hướng B: "Workaround + defensive" — Bypass + bảo vệ
//   4. Chạy cả 2 trong sandbox → so sánh metrics
//   5. Chọn hướng tốt nhất → trả về Planner
//   6. Planner bắt buộc đi theo hướng được chọn

import { getSession, updateSession, saveStepResult, addHistoryEntry } from '../lib/session_store.js';

/**
 * Đọc lịch sử lỗi từ Redis session
 * @param {string} sessionId - Session ID trong Redis
 * @returns {object} { errorHistory, failedSteps, errorPatterns, rawSession }
 */
async function readErrorHistory(sessionId) {
  try {
    const session = await getSession(sessionId);
    if (!session) {
      logger.warn(`[DebateAgent] Session ${sessionId} not found in Redis`);
      return { errorHistory: [], failedSteps: [], errorPatterns: [], rawSession: null };
    }

    // Trích xuất tất cả lịch sử OODA
    const history = session.history || [];

    // Trích xuất các step bị failed
    const results = session.results || {};
    const failedSteps = Object.entries(results)
      .filter(([, v]) => v?.failed || v?.error)
      .map(([step, result]) => ({
        step: Number(step),
        error: result?.error || result?.stderr || 'Unknown error',
        agent: result?.agent || 'Unknown',
        attempt: result?.attempt || 1,
      }));

    // Phân tích pattern lỗi
    const errorPatterns = analyzeErrorPatterns(failedSteps);

    // Trích xuất error history từ OODA iterations
    const errorHistory = history
      .filter(h => h.phase === 'ACT' && h.action?.includes('failed'))
      .map(h => ({
        step: h.step,
        agent: h.agent,
        error: h.error || 'Unknown',
        timestamp: h.timestamp,
      }));

    logger.info(`[DebateAgent] 📋 Đọc ${failedSteps.length} failed steps, ${errorPatterns.length} error patterns từ session ${sessionId}`);

    return { errorHistory, failedSteps, errorPatterns, rawSession: session };
  } catch (err) {
    logger.error(`[DebateAgent] Lỗi đọc Redis session ${sessionId}: ${err.message}`);
    return { errorHistory: [], failedSteps: [], errorPatterns: [], rawSession: null };
  }
}

/**
 * Phân tích pattern lỗi từ các failed steps
 * @param {Array} failedSteps
 * @returns {Array} Các pattern lỗi đã phân loại
 */
function analyzeErrorPatterns(failedSteps) {
  const patterns = [];
  const errorTexts = failedSteps.map(f => (f.error || '').toLowerCase());

  // Memory leak patterns
  if (errorTexts.some(e => e.includes('memory leak') || e.includes('asan') || e.includes('heap-use-after-free') || e.includes('definitely lost'))) {
    patterns.push({ type: 'MEMORY_LEAK', severity: 'critical', description: 'Memory leak detected — smart pointer / RAII needed' });
  }

  // Segfault / access violation
  if (errorTexts.some(e => e.includes('segfault') || e.includes('segmentation') || e.includes('access violation') || e.includes('null pointer'))) {
    patterns.push({ type: 'NULL_POINTER', severity: 'critical', description: 'Null pointer / invalid memory access' });
  }

  // Infinite loop / timeout
  if (errorTexts.some(e => e.includes('timeout') || e.includes('infinite') || e.includes('timelimit') || e.includes('tle'))) {
    patterns.push({ type: 'INFINITE_LOOP', severity: 'high', description: 'Infinite loop or timeout — check loop conditions' });
  }

  // Compilation error
  if (errorTexts.some(e => e.includes('compile') || e.includes('syntax') || e.includes('undefined reference'))) {
    patterns.push({ type: 'COMPILE_ERROR', severity: 'medium', description: 'Compilation error — check includes, types, linking' });
  }

  // Logic error (wrong output)
  if (errorTexts.some(e => e.includes('wrong') || e.includes('incorrect') || e.includes('expected') || e.includes('mismatch'))) {
    patterns.push({ type: 'LOGIC_ERROR', severity: 'medium', description: 'Logic error — algorithm produces wrong output' });
  }

  // Stack overflow / recursion
  if (errorTexts.some(e => e.includes('stack overflow') || e.includes('recursion') || e.includes('deep recursion'))) {
    patterns.push({ type: 'STACK_OVERFLOW', severity: 'high', description: 'Stack overflow — convert recursion to iteration' });
  }

  // If no specific pattern found but there are failures
  if (patterns.length === 0 && failedSteps.length > 0) {
    patterns.push({ type: 'UNKNOWN', severity: 'medium', description: `Unrecognized error pattern — ${failedSteps.length} failed attempts` });
  }

  return patterns;
}

/**
 * CoderAgent Hướng A: "Root Cause Fix"
 * Sửa gốrễ vấn đề dựa trên error pattern
 */
async function coderAgentRootCause(problem, errorPatterns, failedSteps, previousAttempts = []) {
  const errorContext = failedSteps.map(f =>
    `Step ${f.step} (${f.agent}): ${f.error.slice(0, 300)}`
  ).join('\n');

  const patternContext = errorPatterns.map(p =>
    `[${p.severity.toUpperCase()}] ${p.type}: ${p.description}`
  ).join('\n');

  const attemptContext = previousAttempts.length > 0
    ? `\n\n⚠️ Các lần thử trước đã FAIL:\n${previousAttempts.map((a, i) => `Lần ${i + 1}: ${a.error?.slice(0, 200) || 'Unknown'}`).join('\n')}`
    : '';

  const prompt = `Bạn là chuyên gia debug hệ thống cấp cao. Một Agent đang bế tắc với bài toán sau.

**Bài toán gốc**: ${problem}

**Phân tích lỗi từ hệ thống**:
${patternContext}

**Lịch sử lỗi chi tiết**:
${errorContext}${attemptContext}

**NHIỆM VỤ**: SỬA GỐC RỄ vấn đề.
- Đừng sửa symptom, hãy tìm root cause
- Nếu memory leak → dùng smart pointer / RAII / proper free
- Nếu null pointer → thêm null check, dùng reference thay pointer
- Nếu infinite loop → sửa loop condition, thêm break guard
- Nếu stack overflow → chuyển recursion → iteration

**Yêu cầu output**:
1. Phân tích root cause (tiếng Việt)
2. Code hoàn chỉnh ĐÃ SỬA trong code block \`\`\`python hoặc \`\`\`javascript
3. Giải thích tại thay đổi này fix được gì
4. Test cases để verify fix

Trả lời bằng tiếng Việt. Code PHẢI nằm trong code block.`;

  return invokeLlm([new HumanMessage(prompt)], 'CoderAgent-RootCause');
}

/**
 * CoderAgent Hướng B: "Workaround + Defensive"
 * Bypass vấn đề + thêm bảo vệ defensive
 */
async function coderAgentWorkaround(problem, errorPatterns, failedSteps, previousAttempts = []) {
  const errorContext = failedSteps.map(f =>
    `Step ${f.step} (${f.agent}): ${f.error.slice(0, 300)}`
  ).join('\n');

  const patternContext = errorPatterns.map(p =>
    `[${p.severity.toUpperCase()}] ${p.type}: ${p.description}`
  ).join('\n');

  const attemptContext = previousAttempts.length > 0
    ? `\n\n⚠️ Các lần thử trước đã FAIL:\n${previousAttempts.map((a, i) => `Lần ${i + 1}: ${a.error?.slice(0, 200) || 'Unknown'}`).join('\n')}`
    : '';

  const prompt = `Bạn là chuyên gia defensive programming và workaround. Một Agent đang bế tắc với bài toán sau.

**Bài toán gốc**: ${problem}

**Phân tích lỗi từ hệ thống**:
${patternContext}

**Lịch sử lỗi chi tiết**:
${errorContext}${attemptContext}

**NHIỆM VỤ**: BYPASS + DEFENSIVE.
- Không cần tìm root cause, hãy tìm cách BYPASS vấn đề
- Thêm defensive guards: input validation, boundary checks, try/catch
- Dùng approach khác hoàn toàn nếu approach hiện tại không work
- Ưu tiên code CHẠY ĐƯỢC hơn code PERFECT

**Yêu cầu output**:
1. Giải thích workaround approach (tiếng Việt)
2. Code hoàn chỉnh với defensive guards trong code block \`\`\`python hoặc \`\`\`javascript
3. Liệt kê các guards đã thêm
4. Trade-offs so với approach gốc

Trả lời bằng tiếng Việt. Code PHẢI nằm trong code block.`;

  return invokeLlm([new HumanMessage(prompt)], 'CoderAgent-Workaround');
}

/**
 * Judge cho Planner Intervention
 * Chọn hướng giải quyết tốt nhất dựa trên sandbox metrics + error context
 */
async function judgePlannerIntervention(problem, errorPatterns, failedSteps, solutionA, solutionB, metricsA, metricsB) {
  const errorContext = errorPatterns.map(p =>
    `[${p.severity.toUpperCase()}] ${p.type}: ${p.description}`
  ).join('\n');

  const failedContext = failedSteps.slice(0, 5).map(f =>
    `Step ${f.step}: ${f.error.slice(0, 200)}`
  ).join('\n');

  const prompt = `Bạn là CTO — Tòa Án Trọng Tài. PlannerAgent đang bế tắc và cầu cứu.

**Bài toán**: ${problem}

**Error Patterns**:
${errorContext}

**Failed Steps (gần nhất)**:
${failedContext}

━━━ GIẢI PHÁP A (Root Cause Fix) ━━━
${solutionA.slice(0, 1000)}
**Sandbox**: ${metricsA.success ? '✅' : '❌'} | ${metricsA.latencyMs}ms | ${metricsA.memoryKb}KB
${metricsA.error ? `Error: ${metricsA.error.slice(0, 200)}` : ''}

━━━ GIẢI PHÁP B (Workaround + Defensive) ━━━
${solutionB.slice(0, 1000)}
**Sandbox**: ${metricsB.success ? '✅' : '❌'} | ${metricsB.latencyMs}ms | ${metricsB.memoryKb}KB
${metricsB.error ? `Error: ${metricsB.error.slice(0, 200)}` : ''}

━━━ PHÁN QUYẾT ━━━
Chọn hướng tốt nhất cho Planner đi theo:

1. **CHỌN A hay B?** (hoặc kết hợp?)
2. **Lý do**: Dựa trên sandbox metrics + error patterns
3. **Hướng dẫn cụ thể cho Planner**: Step nào cần làm gì
4. **Cảnh báo**: Điều gì cần tránh ở lần thử tiếp theo

Trả lời bằng tiếng Việt, ngắn gọn, đi thẳng vào vấn đề.`;

  return invokeLlm([new HumanMessage(prompt)], 'JudgeAgent-Intervention');
}

/**
 * ═══════════════════════════════════════════════════════════════
 *  PLANNER INTERVENTION API — "Cầu cứu" khi Planner bế tắc
 * ═══════════════════════════════════════════════════════════════
 *
 * @param {string} sessionId  - Redis session ID của Planner
 * @param {string} problem    - Mô tả bài toán đang bế tắc
 * @param {object} [options]
 * @param {boolean} [options.skipSandbox=false] - Bỏ qua sandbox
 * @param {number} [options.maxRetries=2] - Số lần thử lại nếu cả 2 đều fail
 * @returns {object} {
 *   chosenDirection: 'A' | 'B' | 'combined',
 *   solution: string,       // Code + explanation
 *   metrics: object,        // Sandbox metrics
 *   judgeReasoning: string, // Lý do Judge chọn hướng này
 *   plannerDirective: string, // Hướng dẫn cụ thể cho Planner
 *   errorPatterns: array,   // Các pattern lỗi đã phân tích
 * }
 */
export async function interveneForPlanner(sessionId, problem, options = {}) {
  const skipSandbox = options.skipSandbox || false;
  const maxRetries = options.maxRetries || 2;

  logger.info(`[DebateAgent] 🚨 PLANNER INTERVENTION cho session ${sessionId}`);
  logger.info(`[DebateAgent] Bài toán: "${problem.slice(0, 80)}..."`);

  const startTime = Date.now();

  // ── Step 1: Đọc lịch sử lỗi từ Redis ──
  const { errorHistory, failedSteps, errorPatterns, rawSession } = await readErrorHistory(sessionId);

  if (failedSteps.length === 0) {
    logger.info('[DebateAgent] ⚠️ Không tìm thấy failed steps trong session. Debate thông thường.');
  } else {
    logger.info(`[DebateAgent] 📋 Tìm thấy ${failedSteps.length} failed steps, patterns: ${errorPatterns.map(p => p.type).join(', ')}`);
  }

  // ── Step 2: Spawn 2 hướng giải quyết song song ──
  let bestSolution = null;
  let bestMetrics = null;
  let bestDirection = null;
  let judgeReasoning = '';
  let attempts = [];

  for (let retry = 0; retry <= maxRetries; retry++) {
    if (retry > 0) {
      logger.info(`[DebateAgent] 🔄 Thử lại lần ${retry}/${maxRetries}...`);
    }

    // Spawn song song
    const [rawA, rawB] = await Promise.all([
      withTimeout(
        coderAgentRootCause(problem, errorPatterns, failedSteps, attempts),
        PER_ROUND_TIMEOUT,
        'CoderAgent-RootCause timeout'
      ),
      withTimeout(
        coderAgentWorkaround(problem, errorPatterns, failedSteps, attempts),
        PER_ROUND_TIMEOUT,
        'CoderAgent-Workaround timeout'
      ),
    ]);

    // Chạy sandbox
    let metricsA = { success: false, latencyMs: 0, memoryKb: 0, skipped: true };
    let metricsB = { success: false, latencyMs: 0, memoryKb: 0, skipped: true };

    if (!skipSandbox) {
      const codeA = extractCode(rawA);
      const codeB = extractCode(rawB);

      if (codeA) {
        metricsA = await runInSandbox(codeA, detectLanguage(codeA));
        logger.info(`[DebateAgent] RootCause → ${metricsA.success ? '✅' : '❌'} | ${metricsA.latencyMs}ms`);
      }
      if (codeB) {
        metricsB = await runInSandbox(codeB, detectLanguage(codeB));
        logger.info(`[DebateAgent] Workaround → ${metricsB.success ? '✅' : '❌'} | ${metricsB.latencyMs}ms`);
      }
    }

    // Judge chọn hướng
    judgeReasoning = await withTimeout(
      judgePlannerIntervention(problem, errorPatterns, failedSteps, rawA, rawB, metricsA, metricsB),
      PER_ROUND_TIMEOUT,
      'JudgeAgent timeout'
    );

    // Quyết định dựa trên sandbox results
    if (metricsA.success && !metricsB.success) {
      bestSolution = rawA;
      bestMetrics = metricsA;
      bestDirection = 'A';
      logger.info('[DebateAgent] ✅ Chọn Hướng A (Root Cause Fix) — chạy được, B fail');
      break;
    } else if (metricsB.success && !metricsA.success) {
      bestSolution = rawB;
      bestMetrics = metricsB;
      bestDirection = 'B';
      logger.info('[DebateAgent] ✅ Chọn Hướng B (Workaround) — chạy được, A fail');
      break;
    } else if (metricsA.success && metricsB.success) {
      // Cả 2 đều chạy được → chọn theo latency + memory
      const scoreA = (1 / (metricsA.latencyMs + 1)) * 0.6 + (1 / (metricsA.memoryKb + 1)) * 0.4;
      const scoreB = (1 / (metricsB.latencyMs + 1)) * 0.6 + (1 / (metricsB.memoryKb + 1)) * 0.4;
      if (scoreA >= scoreB) {
        bestSolution = rawA;
        bestMetrics = metricsA;
        bestDirection = 'A';
      } else {
        bestSolution = rawB;
        bestMetrics = metricsB;
        bestDirection = 'B';
      }
      logger.info(`[DebateAgent] ✅ Cả 2 đều OK → chọn Hướng ${bestDirection} (score: A=${scoreA.toFixed(4)} B=${scoreB.toFixed(4)})`);
      break;
    } else {
      // Cả 2 đều fail → retry với error context
      attempts.push({ direction: 'A', error: metricsA.error }, { direction: 'B', error: metricsB.error });
      logger.warn(`[DebateAgent] ⚠️ Cả 2 hướng đều fail, retry ${retry + 1}/${maxRetries}`);
    }
  }

  // Nếu hết retries mà vẫn fail → chọn cái ít fail nhất
  if (!bestSolution) {
    logger.warn('[DebateAgent] ⚠️ Hết retries — không có hướng nào chạy được hoàn toàn');
    bestSolution = judgeReasoning; // Dùng Judge reasoning như fallback
    bestMetrics = { success: false, latencyMs: 0, memoryKb: 0, allFailed: true };
    bestDirection = 'fallback';
  }

  const totalTime = Date.now() - startTime;

  // ── Step 3: Cập nhật Redis session với kết quả intervention ──
  try {
    if (rawSession) {
      await addHistoryEntry(sessionId, {
        phase: 'DEBATE_INTERVENTION',
        errorPatterns: errorPatterns.map(p => p.type),
        chosenDirection: bestDirection,
        sandboxSuccess: bestMetrics.success,
        totalTimeMs: totalTime,
        timestamp: Date.now(),
      });
      logger.info(`[DebateAgent] 📝 Đã cập nhật session ${sessionId} với intervention result`);
    }
  } catch (err) {
    logger.warn(`[DebateAgent] Không thể cập nhật session: ${err.message}`);
  }

  // ── Step 4: Build planner directive ──
  const plannerDirective = buildPlannerDirective(bestDirection, errorPatterns, bestMetrics, judgeReasoning);

  logger.info(`[DebateAgent] ✅ Intervention hoàn tất trong ${totalTime}ms | Hướng: ${bestDirection}`);

  return {
    chosenDirection: bestDirection,
    solution: bestSolution,
    metrics: bestMetrics,
    judgeReasoning,
    plannerDirective,
    errorPatterns,
    failedSteps: failedSteps.length,
    totalTimeMs: totalTime,
    sessionId,
  };
}

/**
 * Build hướng dẫn cụ thể cho Planner dựa trên kết quả debate
 */
function buildPlannerDirective(direction, errorPatterns, metrics, judgeReasoning) {
  const patternTypes = errorPatterns.map(p => p.type);

  let directive = `🏛️ DEBATE AGENT INTERVENTION\n\n`;
  directive += `**Hướng được chọn**: ${direction === 'A' ? 'Root Cause Fix' : direction === 'B' ? 'Workaround + Defensive' : 'Fallback (Judge reasoning)'}\n`;
  directive += `**Sandbox**: ${metrics.success ? '✅ Chạy được' : '❌ Vẫn lỗi'}\n`;
  directive += `**Latency**: ${metrics.latencyMs}ms | **Memory**: ${metrics.memoryKb}KB\n\n`;

  directive += `**Error Patterns phát hiện**:\n`;
  for (const p of errorPatterns) {
    directive += `- [${p.severity.toUpperCase()}] ${p.type}: ${p.description}\n`;
  }

  directive += `\n**⚠️ BẮT BUỘC**: Planner phải đi theo hướng ${direction} ở step tiếp theo.\n`;
  directive += `**KHÔNG ĐƯỢC** quay lại approach cũ đã fail ${patternTypes.join(', ')}.\n\n`;

  directive += `**Judge's reasoning**:\n${judgeReasoning.slice(0, 500)}`;

  return directive;
}
