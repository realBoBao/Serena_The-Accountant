import OpenAI from 'openai';
import { ask as llmAsk } from '../lib/llm.js';
import { addJob, QueueName } from '../lib/task_queue.js';
import {
  createSession,
  getSession,
  updateSession,
  saveStepResult,
  addHistoryEntry,
  deleteSession,
} from '../lib/session_store.js';

/**
 * PlannerAgent — Bộ não Điều phối (OODA Loop)
 *
 * ┌─────────────────────────────────────────────────────────────┐
 * │                    OODA LOOP                                │
 * │                                                             │
 * │  1. OBSERVE  → Đọc session state + kết quả workers         │
 * │  2. ORIENT   → LLM phân tích: đã xong chưa? nút thắt đâu?  │
 * │  3. DECIDE   → Chọn agent cho bước tiếp theo               │
 * │  4. ACT      → Ném job vào BullMQ queue tương ứng          │
 * │                                                             │
 * │  Nếu xong → tổng hợp kết quả → trả về InteractionAgent    │
 * └─────────────────────────────────────────────────────────────┘
 *
 * Session state được lưu trong Redis (session_store.js).
 * Workers nhận job từ BullMQ → xử lý → lưu kết quả vào session.
 * PlannerAgent đọc kết quả → OODA loop tiếp.
 */

// ─── Agent → Queue mapping ──────────────────────────────────
const AGENT_QUEUE_MAP = {
  RagAgent:        QueueName.PRIORITY,
  CoderAgent:      QueueName.PRIORITY,
  VisionAgent:     QueueName.PRIORITY,
  VoiceAgent:      QueueName.PRIORITY,
  PdfAgent:        QueueName.PRIORITY,
  DebateAgent:     QueueName.PRIORITY,
  ManimAgent:      QueueName.PRIORITY,
  FlashcardAgent:  QueueName.PRIORITY,
  EvoAgent:        QueueName.EVOLUTION,
  GraphAgent:      QueueName.GRAPH,
};

const AGENT_EXPORT_MAP = {
  RagAgent:       'answerQuestion',
  CoderAgent:     'solveWithDebugLoop',
  VisionAgent:    'analyzeImageBuffer',
  VoiceAgent:     'processVoiceMessage',
  PdfAgent:       'processPdf',
  DebateAgent:    'runDebate',
  ManimAgent:     'createAnimationForPlanner',
  FlashcardAgent: 'generateFlashcards',
  EvoAgent:       'autoEvaluate',
  GraphAgent:     'extractEntities',
};

// ─── System Prompts ─────────────────────────────────────────

const PLANNING_PROMPT = `Bạn là một Tech Lead giỏi giang. Nhiệm vụ của bạn là PHÂN TÍCH và LẬP KẾ HOẠCH.

Quy tắc:
1. Đừng giải quyết vấn đề. Hãy chia vấn đề thành các bước nhỏ, rõ ràng.
2. Mỗi bước phải chỉ định đúng agent phụ trách.
3. Xác định mối quan hệ phụ thuộc (depends_on) giữa các bước — tạo thành DAG.
4. Thứ tự bước phải hợp lệ — không vòng lặp.
5. Chỉ dùng các agent sau: RagAgent, CoderAgent, VisionAgent, VoiceAgent, PdfAgent, DebateAgent, ManimAgent, FlashcardAgent, EvoAgent, GraphAgent.
6. Output PHẢI là JSON array hợp lệ, không thêm markdown.

Định dạng output:
[
  {"step": 1, "agent": "<AgentName>", "action": "<hành động cụ thể>", "status": "pending"},
  {"step": 2, "agent": "<AgentName>", "action": "<hành động cụ thể>", "depends_on": 1, "status": "pending"}
]

Lưu ý:
- "action" phải cụ thể, động tả, mô tả chính xác công việc.
- Nếu chỉ cần 1 bước, trả về mảng 1 phần tử.
- Nếu yêu cầu đơn giản (chitchat), trả về [{"step": 1, "agent": "RagAgent", "action": "direct_reply", "status": "pending"}].

## Vision-First Planning (QUAN TRỌNG):
Nếu trong context có trường "visionDescription" (mô tả ảnh từ VisionAgent):
- BƯỚC 1 LUÔN là VisionAgent với action "analyze_image" (step 1, không depends_on)
- Các bước sau PHẢI depends_on step 1 để dùng kết quả vision
- Dùng visionDescription để hiểu nội dung ảnh và lập plan phù hợp
- Ví dụ: nếu ảnh là lỗi code → step 2 là CoderAgent fix_lỗi, step 3 là RagAgent giải_thích
- Ví dụ: nếu ảnh là sơ đồ thuật toán → step 2 là RagAgent phân_tích, step 3 là ManimAgent animate
- Ví dụ: nếu ảnh là bài giảng → step 2 là FlashcardAgent tạo_thẻ, step 3 là RagAgent tóm_tắt`;

const VISION_FIRST_PLANNING_PROMPT = `Bạn là một Tech Lead giỏi giang. Bạn nhận được MÔ TẢ ẢNH từ VisionAgent và yêu cầu của người dùng.

Mô tả ảnh đã được VisionAgent phân tích. Bạn cần lập kế hoạch dựa trên NỘI DUNG ẢNH.

Quy tắc:
1. Đừng giải quyết vấn đề. Hãy chia thành các bước nhỏ, rõ ràng.
2. Bước 1 LUÔN là VisionAgent với action "analyze_image" (đã có sẵn kết quả, dùng để tham chiếu).
3. Các bước sau phải depends_on step 1.
4. Chỉ dùng các agent sau: RagAgent, CoderAgent, VisionAgent, VoiceAgent, PdfAgent, DebateAgent, ManimAgent, FlashcardAgent, EvoAgent, GraphAgent.
5. Output PHẢI là JSON array hợp lệ.

Định dạng:
[
  {"step": 1, "agent": "VisionAgent", "action": "analyze_image", "status": "completed"},
  {"step": 2, "agent": "<AgentName>", "action": "<hành động>", "depends_on": 1, "status": "pending"}
]`;

const OODA_ORIENT_PROMPT = `Bạn là một Tech Lead đang giám sát tiến độ công việc.

Bạn sẽ nhận được:
1. MỤC TIÊU GỐC: Yêu cầu ban đầu của người dùng
2. KẾ HOẠCH: Danh sách các bước cần làm (DAG)
3. KẾT QUẢ HIỆN TẠI: Kết quả đã nhận được từ các worker

Nhiệm vụ: Phân tích và trả lời JSON với 2 trường:
{
  "completed": true | false,
  "nextStep": <step number hoặc null nếu đã xong>,
  "reasoning": "<giải thích ngắn gọn>"
}

Quy tắc:
- Nếu tất cả các step đều có kết quả → completed: true, nextStep: null
- Nếu còn step chưa xong → completed: false, nextStep: <step đầu tiên chưa có kết quả mà dependency đã xong>
- Nếu có step bị failed → completed: false, nextStep: <step bị failed để retry>
- Chỉ trả về JSON thuần, không markdown.`;

// ─── PlannerAgent Class ─────────────────────────────────────

export class PlannerAgent {
  /**
   * @param {Object}   opts
   * @param {string}   opts.apiKey        - OpenRouter API key
   * @param {string}   [opts.baseURL]     - OpenRouter base URL
   * @param {string}   [opts.model]       - LLM model
   * @param {Function} [opts.tryLocalLlm] - Fallback local LLM
   * @param {Object}   [opts.agentModules] - Pre-loaded agent modules { RagAgent, CoderAgent, ... }
   */
  constructor({
    apiKey,
    baseURL = 'https://openrouter.ai/api/v1',
    model = 'openrouter/auto',
    tryLocalLlm = null,
    agentModules = {},
  } = {}) {
    this.model = model;
    this.tryLocalLlm = tryLocalLlm;
    this.agentModules = agentModules; // { RagAgent: { answerQuestion }, CoderAgent: { solveWithDebugLoop }, ... }

    this.openai = new OpenAI({
      apiKey,
      baseURL,
      defaultHeaders: {
        'HTTP-Referer': 'https://github.com/my-ai-brain',
        'X-Title': 'My AI Brain — PlannerAgent',
      },
    });
  }

  // ═══════════════════════════════════════════════════════════
  //  PUBLIC API
  // ═══════════════════════════════════════════════════════════

  /**
   * Bắt đầu session mới với yêu cầu từ user.
   * Tạo DAG plan → lưu session → trigger OODA loop.
   *
   * @param {string} sessionId
   * @param {Object} request       — { type, content, context }
   * @returns {Object} Session sau khi planning
   */
  async startSession(sessionId, request) {
    // 1. Tạo session trong Redis
    const session = await createSession(sessionId, request);

    // 2. Gọi LLM để tạo DAG plan
    const dag = await this._createDagPlan(request);

    // 3. Lưu DAG vào session
    await updateSession(sessionId, { dag, status: 'running' });

    // 4. Bắt đầu OODA loop
    await this._oodaLoop(sessionId);

    return getSession(sessionId);
  }

  /**
   * Worker callback: gọi khi một worker hoàn thành step.
   * Lưu kết quả → trigger OODA loop tiếp.
   *
   * @param {string} sessionId
   * @param {number} step
   * @param {*} result
   */
  async onWorkerComplete(sessionId, step, result) {
    await saveStepResult(sessionId, step, result);
    await updateSession(sessionId, { status: 'running' });
    await this._oodaLoop(sessionId);
  }

  /**
   * Worker callback: gọi khi một worker bị lỗi.
   *
   * @param {string} sessionId
   * @param {number} step
   * @param {Error} error
   */
  async onWorkerFailed(sessionId, step, error) {
    await saveStepResult(sessionId, step, { error: error.message, failed: true });
    await updateSession(sessionId, { status: 'failed' });

    await addHistoryEntry(sessionId, {
      phase: 'ACT',
      action: 'worker_failed',
      step,
      error: error.message,
    });
  }

  /**
   * Lấy trạng thái session hiện tại.
   */
  async getSessionStatus(sessionId) {
    return getSession(sessionId);
  }

  /**
   * Đóng session (cleanup Redis).
   */
  async closeSession(sessionId) {
    await deleteSession(sessionId);
  }

  // ═══════════════════════════════════════════════════════════
  //  OODA LOOP (private)
  // ═══════════════════════════════════════════════════════════

  /**
   * Vòng lặp OODA chính.
   * Observe → Orient → Decide → Act
   */
  async _oodaLoop(sessionId) {
    // ── 1. OBSERVE ──────────────────────────────────────────
    const session = await getSession(sessionId);
    if (!session) {
      console.warn(`[PlannerAgent] Session ${sessionId} not found. Stopping OODA.`);
      return;
    }

    // Nếu đang waiting_for_worker thì chờ (worker sẽ gọi onWorkerComplete)
    if (session.status === 'waiting_for_worker') {
      return;
    }

    // Nếu đã completed hoặc failed thì dừng
    if (session.status === 'completed' || session.status === 'failed') {
      return;
    }

    const observe = {
      originalRequest: session.originalRequest,
      dag: session.dag,
      results: session.results,
      currentStep: session.currentStep,
    };

    // ── 2. ORIENT ───────────────────────────────────────────
    const orient = await this._orient(session, observe);

    await addHistoryEntry(sessionId, {
      phase: 'OODA',
      observe,
      orient,
      action: orient.completed ? 'finalize' : 'dispatch_next',
      nextStep: orient.nextStep,
    });

    // ── 3+4. DECIDE & ACT ───────────────────────────────────
    if (orient.completed) {
      // ✅ Tất cả steps đã xong → tổng hợp kết quả
      await this._finalizeSession(sessionId, session, orient);
    } else if (orient.nextStep != null) {
      // ⚡ Còn step chưa xong → dispatch worker
      await this._dispatchNextStep(sessionId, session, orient.nextStep);
    } else {
      // ⚠️ Không có nextStep nhưng chưa completed → stuck
      console.warn(`[PlannerAgent] Session ${sessionId}: stuck state. Marking as failed.`);
      await updateSession(sessionId, { status: 'failed' });
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  OBSERVE
  // ═══════════════════════════════════════════════════════════

  // Được thực hiện trong _oodaLoop — đọc session từ Redis.

  // ═══════════════════════════════════════════════════════════
  //  ORIENT (LLM reasoning)
  // ═══════════════════════════════════════════════════════════

  /**
   * Gọi LLM đánh giá tiến độ và quyết định bước tiếp theo.
   * Dùng unified LLM layer với heuristic fallback.
   */
  async _orient(session, observe) {
    const userMessage = this._buildOrientMessage(session, observe);

    try {
      const result = await llmAsk(userMessage, {
        systemPrompt: OODA_ORIENT_PROMPT,
        temperature: 0.1,
        maxTokens: 512,
      });
      if (result.answer?.trim()) {
        const parsed = JSON.parse(result.answer);
        if (typeof parsed.completed === 'boolean') {
          return {
            completed: parsed.completed,
            nextStep: parsed.nextStep ?? null,
            reasoning: parsed.reasoning || '',
          };
        }
      }
    } catch (err) {
      console.error('[PlannerAgent] Orient LLM failed:', err.message);
    }

    // ── Heuristic fallback nếu LLM fail ─────────────────────
    return this._heuristicOrient(session, observe);
  }

  /**
   * Heuristic orientation khi LLM không khả dụng.
   * Duyệt DAG theo thứ tự topo, tìm step đầu tiên chưa có kết quả
   * mà tất cả dependencies đã xong.
   */
  _heuristicOrient(session, observe) {
    const { dag, results } = session;
    const completedSteps = new Set(
      Object.keys(results)
        .map(Number)
        .filter(s => !results[s]?.failed)
    );
    const failedSteps = new Set(
      Object.keys(results)
        .map(Number)
        .filter(s => results[s]?.failed)
    );

    // Nếu có step bị failed → retry step đó
    for (const task of dag) {
      if (failedSteps.has(task.step)) {
        return { completed: false, nextStep: task.step, reasoning: 'Retrying failed step' };
      }
    }

    // Tìm step chưa xong mà dependencies đã xong
    const sorted = PlannerAgent.topologicalSort(dag);
    for (const task of sorted) {
      if (completedSteps.has(task.step)) continue;

      // Kiểm tra dependencies
      if (task.depends_on) {
        if (!completedSteps.has(task.depends_on)) continue; // Chờ dependency
      }

      return { completed: false, nextStep: task.step, reasoning: 'Next available step' };
    }

    // Tất cả steps đã xong
    if (completedSteps.size >= dag.length) {
      return { completed: true, nextStep: null, reasoning: 'All steps completed' };
    }

    return { completed: false, nextStep: null, reasoning: 'Stuck — no available steps' };
  }

  _buildOrientMessage(session, observe) {
    return [
      `MỤC TIÊU GỐC: ${session.originalRequest.content}`,
      ``,
      `KẾ HOẠCH (DAG):`,
      JSON.stringify(session.dag, null, 2),
      ``,
      `KẾT QUẢ HIỆN TẠI:`,
      JSON.stringify(session.results, null, 2),
    ].join('\n');
  }

  // ═══════════════════════════════════════════════════════════
  //  DECIDE & ACT
  // ═══════════════════════════════════════════════════════════

  /**
   * Dispatch step tiếp theo vào BullMQ queue.
   */
  async _dispatchNextStep(sessionId, session, stepNumber) {
    const task = session.dag.find(t => t.step === stepNumber);
    if (!task) {
      console.error(`[PlannerAgent] Step ${stepNumber} not found in DAG`);
      return;
    }

    const agentName = task.agent;
    const queueName = AGENT_QUEUE_MAP[agentName] || QueueName.PRIORITY;

    // Tạo job data
    const jobData = {
      sessionId,
      step: stepNumber,
      agent: agentName,
      action: task.action,
      originalRequest: session.originalRequest,
      // Kết quả từ các step phụ thộc (nếu có)
      dependencyResults: task.depends_on ? session.results[task.depends_on] : null,
    };

    // Ném job vào BullMQ
    try {
      await addJob(queueName, `${agentName}:${task.action}`, jobData, {
        priority: 1,
        attempts: 2,
        backoff: { type: 'exponential', delay: 1000 },
      });

      await updateSession(sessionId, {
        currentStep: stepNumber,
        status: 'waiting_for_worker',
      });

      await addHistoryEntry(sessionId, {
        phase: 'ACT',
        action: 'dispatched_job',
        step: stepNumber,
        agent: agentName,
        queue: queueName,
      });

      console.log(`[PlannerAgent] Dispatched step ${stepNumber} (${agentName}) → ${queueName}`);
    } catch (err) {
      console.error(`[PlannerAgent] Failed to dispatch step ${stepNumber}:`, err.message);
      await saveStepResult(sessionId, stepNumber, { error: err.message, failed: true });
      await updateSession(sessionId, { status: 'failed' });
    }
  }

  /**
   * Tổng hợp kết quả và đóng session.
   */
  async _finalizeSession(sessionId, session, orient) {
    const finalResult = {
      sessionId,
      originalRequest: session.originalRequest,
      dag: session.dag,
      results: session.results,
      totalSteps: session.dag.length,
      completedSteps: Object.keys(session.results).filter(s => !session.results[s]?.failed).length,
      failedSteps: Object.keys(session.results).filter(s => session.results[s]?.failed).length,
      history: session.history,
      completedAt: Date.now(),
    };

    await updateSession(sessionId, {
      status: 'completed',
      finalResult,
    });

    console.log(`[PlannerAgent] Session ${sessionId} completed. ${finalResult.completedSteps}/${finalResult.totalSteps} steps done.`);
  }

  // ═══════════════════════════════════════════════════════════
  //  DAG PLANNING (LLM)
  // ═══════════════════════════════════════════════════════════

  /**
   * Gọi LLM tạo DAG plan từ request.
   * Dùng unified LLM layer: Gemini → OpenRouter → Local → heuristic fallback.
   */
  async _createDagPlan(request) {
    const userMessage = [
      `Loại yêu cầu: ${request.type || 'message'}`,
      `Nội dung: ${request.content || ''}`,
      request.context ? `Context: ${request.context}` : '',
    ].filter(Boolean).join('\n');

    try {
      const result = await llmAsk(userMessage, {
        systemPrompt: PLANNING_PROMPT,
        temperature: 0.2,
        maxTokens: 1024,
      });
      if (result.answer?.trim()) {
        return this._parseDag(result.answer);
      }
    } catch (err) {
      console.error('[PlannerAgent] Planning LLM failed:', err.message);
    }

    // Fallback: single-step RagAgent plan
    return [{ step: 1, agent: 'RagAgent', action: 'direct_reply', status: 'pending' }];
  }

  /**
   * Parse và validate DAG từ LLM output.
   */
  _parseDag(raw) {
    let tasks = null;

    try {
      tasks = JSON.parse(raw);
    } catch {
      const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (jsonMatch) {
        try { tasks = JSON.parse(jsonMatch[1]); } catch { /* ignore */ }
      }
    }

    if (tasks && !Array.isArray(tasks)) {
      if (Array.isArray(tasks.plan)) tasks = tasks.plan;
      else if (Array.isArray(tasks.tasks)) tasks = tasks.tasks;
      else if (Array.isArray(tasks.steps)) tasks = tasks.steps;
    }

    if (!Array.isArray(tasks) || tasks.length === 0) {
      return [{ step: 1, agent: 'RagAgent', action: 'direct_reply', status: 'pending' }];
    }

    const validated = tasks.map((task, i) => ({
      step: task.step || (i + 1),
      agent: Object.keys(AGENT_QUEUE_MAP).includes(task.agent) ? task.agent : 'RagAgent',
      action: task.action || 'process',
      depends_on: Number.isInteger(task.depends_on) ? task.depends_on : undefined,
      status: 'pending',
    })).filter(t => t.agent);

    // Validate depends_on references
    const stepSet = new Set(validated.map(t => t.step));
    for (const task of validated) {
      if (task.depends_on && !stepSet.has(task.depends_on)) {
        console.warn(`[PlannerAgent] Step ${task.step} depends_on ${task.depends_on} (not found). Removing.`);
        delete task.depends_on;
      }
    }

    return validated;
  }

  // ═══════════════════════════════════════════════════════════
  //  SYNC EXECUTION (cho trường hợp không dùng BullMQ workers)
  // ═══════════════════════════════════════════════════════════

  /**
   * Chạy toàn bộ DAG đồng thội (không qua BullMQ).
   * Dùng khi agentModules được inject trực tiếp.
   *
   * @param {Object} request  — { type, content, context }
   * @returns {Object} Final result
   */
  async executeDagSync(request) {
    const dag = await this._createDagPlan(request);
    const sorted = PlannerAgent.topologicalSort(dag);
    const results = {};

    for (const task of sorted) {
      try {
        const result = await this._executeTaskSync(task, request, results);
        results[task.step] = result;
      } catch (err) {
        results[task.step] = { error: err.message, failed: true };
      }
    }

    return {
      dag,
      results,
      totalSteps: dag.length,
      completedSteps: Object.keys(results).filter(s => !results[s]?.failed).length,
    };
  }

  /**
   * Thực thi một task đồng bộ từ injected agentModules.
   */
  async _executeTaskSync(task, request, dependencyResults) {
    const mod = this.agentModules[task.agent];
    if (!mod) {
      throw new Error(`Agent module '${task.agent}' not injected`);
    }

    const fnName = AGENT_EXPORT_MAP[task.agent];
    const fn = mod[fnName];
    if (!fn) {
      throw new Error(`Agent '${task.agent}' does not export '${fnName}'`);
    }

    // Build context cho agent
    const context = {
      query: request.content,
      action: task.action,
      dependencyResult: task.depends_on ? dependencyResults[task.depends_on] : null,
    };

    return await fn(context.query, { action: task.action, dependencyResult: context.dependencyResult });
  }

  // ═══════════════════════════════════════════════════════════
  //  VISION-FIRST PLANNING
  // ═══════════════════════════════════════════════════════════

  /**
   * Tạo plan khi có ảnh đầu vào.
   * Workflow: VisionAgent phân tích ảnh → Planner dùng description để tạo DAG.
   *
   * Đây là static method — có thể gọi mà không cần constructor.
   *
   * @param {Object} opts
   * @param {string} opts.apiKey      - OpenRouter API key
   * @param {string} [opts.baseURL]   - OpenRouter base URL
   * @param {string} [opts.model]     - LLM model
   * @param {Buffer} opts.imageBuffer - Raw image bytes
   * @param {string} opts.mimeType   - image/png, image/jpeg, etc.
   * @param {string} [opts.userRequest] - Yêu cầu của user (VD: "Fix lỗi này")
   * @param {Function} [opts.tryLocalLlm] - Fallback local LLM
   * @returns {Promise<{ dag: Array, visionDescription: string, visionResult: Object }>}
   */
  static async createVisionFirstPlan({
    apiKey,
    baseURL = 'https://openrouter.ai/api/v1',
    model = 'openrouter/auto',
    imageBuffer,
    mimeType,
    userRequest = '',
    tryLocalLlm = null,
  }) {
    // 1. Gọi VisionAgent để phân tích ảnh
    const { describeImageForPlanner } = await import('./VisionAgent.js');
    const visionResult = await describeImageForPlanner(imageBuffer, mimeType, userRequest);

    if (!visionResult.success) {
      console.warn('[PlannerAgent] Vision analysis failed:', visionResult.error);
      // Fallback: plan không có vision
      return {
        dag: [{ step: 1, agent: 'RagAgent', action: 'direct_reply', status: 'pending' }],
        visionDescription: '',
        visionResult,
      };
    }

    const visionDescription = visionResult.description;
    console.log(`[PlannerAgent] Vision description: ${visionDescription.slice(0, 100)}...`);

    // 2. Gọi LLM tạo DAG plan dựa trên vision description
    const openai = new OpenAI({
      apiKey,
      baseURL,
      defaultHeaders: {
        'HTTP-Referer': 'https://github.com/my-ai-brain',
        'X-Title': 'My AI Brain — VisionFirstPlanner',
      },
    });

    const userMessage = [
      `MÔ TẢ ẢNH (từ VisionAgent): ${visionDescription}`,
      visionResult.ocrText ? `OCR TEXT: ${visionResult.ocrText}` : '',
      `YÊU CẦU NGƯỜI DÙNG: ${userRequest || 'Phân tích và xử lý nội dung trong ảnh'}`,
    ].filter(Boolean).join('\n\n');

    let raw = null;

    try {
      const completion = await openai.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: VISION_FIRST_PLANNING_PROMPT },
          { role: 'user', content: userMessage },
        ],
        temperature: 0.2,
        max_tokens: 1024,
        response_format: { type: 'json_object' },
      });
      raw = completion.choices[0]?.message?.content;
    } catch (err) {
      console.error('[PlannerAgent] Vision-first planning LLM failed:', err.message);
    }

    if (!raw && tryLocalLlm) {
      try {
        raw = await tryLocalLlm(VISION_FIRST_PLANNING_PROMPT, userMessage);
      } catch (err) {
        console.error('[PlannerAgent] Vision-first planning local LLM failed:', err.message);
      }
    }

    // 3. Parse DAG
    let dag = null;
    if (raw) {
      try {
        dag = JSON.parse(raw);
      } catch {
        const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        if (jsonMatch) {
          try { dag = JSON.parse(jsonMatch[1]); } catch { /* ignore */ }
        }
      }

      if (dag && !Array.isArray(dag)) {
        if (Array.isArray(dag.plan)) dag = dag.plan;
        else if (Array.isArray(dag.tasks)) dag = dag.tasks;
        else if (Array.isArray(dag.steps)) dag = dag.steps;
      }
    }

    // 4. Validate DAG
    if (!Array.isArray(dag) || dag.length === 0) {
      // Fallback: simple 2-step plan
      dag = [
        { step: 1, agent: 'VisionAgent', action: 'analyze_image', status: 'completed' },
        { step: 2, agent: 'RagAgent', action: 'explain_and_suggest', depends_on: 1, status: 'pending' },
      ];
    }

    // Validate agent names
    const validAgents = new Set(Object.keys(AGENT_QUEUE_MAP));
    dag = dag.map((task, i) => ({
      step: task.step || (i + 1),
      agent: validAgents.has(task.agent) ? task.agent : 'RagAgent',
      action: task.action || 'process',
      depends_on: Number.isInteger(task.depends_on) ? task.depends_on : undefined,
      status: task.status || 'pending',
    }));

    // Ensure step 1 is VisionAgent
    if (dag[0]?.agent !== 'VisionAgent') {
      dag.unshift({ step: 1, agent: 'VisionAgent', action: 'analyze_image', status: 'completed' });
      // Re-number steps
      dag.forEach((t, i) => { t.step = i + 1; });
      // Fix depends_on
      dag.forEach(t => {
        if (t.depends_on) t.depends_on += 1;
      });
    }

    return { dag, visionDescription, visionResult };
  }

  // ═══════════════════════════════════════════════════════════
  //  UTILITY
  // ═══════════════════════════════════════════════════════════

  /**
   * Topological sort (static).
   */
  static topologicalSort(tasks) {
    const sorted = [];
    const visited = new Set();
    const visiting = new Set();

    const visit = (task) => {
      if (visited.has(task.step)) return;
      if (visiting.has(task.step)) {
        console.warn(`[PlannerAgent] Circular dependency at step ${task.step}. Skipping.`);
        return;
      }
      visiting.add(task.step);
      if (task.depends_on) {
        const dep = tasks.find(t => t.step === task.depends_on);
        if (dep) visit(dep);
      }
      visiting.delete(task.step);
      visited.add(task.step);
      sorted.push(task);
    };

    for (const task of tasks) visit(task);
    return sorted;
  }
}

export default PlannerAgent;
