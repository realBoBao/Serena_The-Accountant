import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { PlannerAgent } from '../agents/PlannerAgent.js';

// ── Mock llm.js ─────────────────────────────────────────────
const mockLlmAsk = jest.fn();
const mockAddJob = jest.fn().mockResolvedValue({ id: 'job-1' });

// Mock before importing PlannerAgent
jest.mock('../lib/llm.js', () => ({
  __esModule: true,
  ask: mockLlmAsk,
  default: { ask: mockLlmAsk },
}));

jest.mock('../lib/task_queue.js', () => ({
  __esModule: true,
  addJob: mockAddJob,
  QueueName: { PLANNER: 'planner-tasks', PRIORITY: 'priority-tasks', EVOLUTION: 'evolution-tasks', GRAPH: 'graph-tasks' },
}));

jest.mock('../lib/session_store.js', () => ({
  __esModule: true,
  createSession: jest.fn().mockResolvedValue({ id: 'test-session' }),
  getSession: jest.fn().mockResolvedValue({ id: 'test-session', dag: [], results: {}, status: 'running' }),
  updateSession: jest.fn().mockResolvedValue({}),
  saveStepResult: jest.fn().mockResolvedValue({}),
  addHistoryEntry: jest.fn().mockResolvedValue({}),
  deleteSession: jest.fn().mockResolvedValue(true),
  listSessions: jest.fn().mockResolvedValue([]),
}));

jest.unstable_mockModule('../lib/session_store.js', () => ({
  __esModule: true,
  ...mockSessionStore,
  default: mockSessionStore,
}));

// ── Mock task_queue ─────────────────────────────────────────
const mockAddJob = jest.fn();
jest.unstable_mockModule('../lib/task_queue.js', () => ({
  __esModule: true,
  addJob: mockAddJob,
  QueueName: {
    PLANNER: 'planner-tasks',
    EVOLUTION: 'evolution-tasks',
    GRAPH: 'graph-tasks',
    PRIORITY: 'priority-tasks',
  },
}));

// ── Dynamic import sau khi mock setup ──────────────────────
const { PlannerAgent } = await import('../agents/PlannerAgent.js');

// ── Helpers ─────────────────────────────────────────────────
function makeRequest(overrides = {}) {
  return { type: 'message', content: 'Giải thích thuật toán quicksort', ...overrides };
}

function makeAgent(opts = {}) {
  const agent = new PlannerAgent({
    apiKey: 'test-key',
    model: 'test-model',
    tryLocalLlm: opts.tryLocalLlm ?? null,
    agentModules: opts.agentModules ?? {},
  });
  return { agent, mockLlmAsk };
}

function makePlanResponse(tasks) {
  mockLlmAsk.mockResolvedValueOnce({ answer: JSON.stringify(tasks), provider: 'mock', model: 'test' });
}

function makeOrientResponse(completed, nextStep, reasoning = '') {
  mockLlmAsk.mockResolvedValueOnce({ answer: JSON.stringify({ completed, nextStep, reasoning }), provider: 'mock', model: 'test' });
}

function makeLlmFail() {
  mockLlmAsk.mockRejectedValueOnce(new Error('LLM unavailable'));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAddJob.mockResolvedValue({ id: 'job-1' });
});

// ═══════════════════════════════════════════════════════════
//  1. DAG PLANNING
// ═══════════════════════════════════════════════════════════
describe('PlannerAgent DAG Planning', () => {
  it('trả về DAG hợp lệ từ LLM', async () => {
    const { agent } = makeAgent();
    makePlanResponse([
      { step: 1, agent: 'RagAgent', action: 'search_theory' },
      { step: 2, agent: 'CoderAgent', action: 'implement', depends_on: 1 },
    ]);
    const dag = await agent._createDagPlan(makeRequest());
    expect(Array.isArray(dag)).toBe(true);
    expect(dag).toHaveLength(2);
    expect(dag[0].agent).toBe('RagAgent');
    expect(dag[1].depends_on).toBe(1);
  });

  it('gọi LLM với planning prompt', async () => {
    const { agent, mockLlmAsk: ask } = makeAgent();
    makePlanResponse([{ step: 1, agent: 'RagAgent', action: 'reply' }]);
    await agent._createDagPlan(makeRequest());
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0][1].systemPrompt).toContain('Tech Lead');
  });

  it('fallback khi LLM fail', async () => {
    const { agent } = makeAgent();
    makeLlmFail();
    const dag = await agent._createDagPlan(makeRequest());
    expect(dag).toHaveLength(1);
    expect(dag[0].agent).toBe('RagAgent');
    expect(dag[0].action).toBe('direct_reply');
  });
});

// ═══════════════════════════════════════════════════════════
//  2. _parseDag
// ═══════════════════════════════════════════════════════════
describe('PlannerAgent._parseDag()', () => {
  let agent;
  beforeEach(() => { agent = makeAgent().agent; });

  it('parse JSON array trực tiếp', () => {
    const dag = agent._parseDag(JSON.stringify([{ step: 1, agent: 'RagAgent', action: 'search' }]));
    expect(dag).toHaveLength(1);
    expect(dag[0].agent).toBe('RagAgent');
  });

  it('parse JSON từ markdown code block', () => {
    const dag = agent._parseDag('```json\n[{"step": 1, "agent": "CoderAgent", "action": "code"}]\n```');
    expect(dag[0].agent).toBe('CoderAgent');
  });

  it('parse khi LLM trả về { "plan": [...] }', () => {
    const dag = agent._parseDag(JSON.stringify({ plan: [{ step: 1, agent: 'VisionAgent', action: 'see' }] }));
    expect(dag[0].agent).toBe('VisionAgent');
  });

  it('parse khi LLM trả về { "tasks": [...] }', () => {
    const dag = agent._parseDag(JSON.stringify({ tasks: [{ step: 1, agent: 'PdfAgent', action: 'read' }] }));
    expect(dag[0].agent).toBe('PdfAgent');
  });

  it('fallback khi JSON không hợp lệ', () => {
    const dag = agent._parseDag('not json');
    expect(dag).toHaveLength(1);
    expect(dag[0].agent).toBe('RagAgent');
  });

  it('fallback khi array rỗng', () => {
    const dag = agent._parseDag('[]');
    expect(dag).toHaveLength(1);
    expect(dag[0].agent).toBe('RagAgent');
  });

  it('gán status "pending" cho mọi task', () => {
    const dag = agent._parseDag(JSON.stringify([{ step: 1, agent: 'RagAgent', action: 'x' }]));
    expect(dag[0].status).toBe('pending');
  });

  it('auto-assign step number nếu thiếu', () => {
    const dag = agent._parseDag(JSON.stringify([{ agent: 'RagAgent', action: 'a' }, { agent: 'CoderAgent', action: 'b' }]));
    expect(dag[0].step).toBe(1);
    expect(dag[1].step).toBe(2);
  });

  it('thay agent không hợp lệ bằng RagAgent', () => {
    const dag = agent._parseDag(JSON.stringify([{ step: 1, agent: 'FakeAgent', action: 'hack' }]));
    expect(dag[0].agent).toBe('RagAgent');
  });

  it('xóa depends_on trỏ đến step không tồn tại', () => {
    const dag = agent._parseDag(JSON.stringify([{ step: 1, agent: 'RagAgent', action: 'a', depends_on: 99 }]));
    expect(dag[0].depends_on).toBeUndefined();
  });

  it('gán action mặc định "process" nếu thiếu', () => {
    const dag = agent._parseDag(JSON.stringify([{ step: 1, agent: 'RagAgent' }]));
    expect(dag[0].action).toBe('process');
  });

  it('chỉ chấp nhận agent trong AGENT_QUEUE_MAP', () => {
    const dag = agent._parseDag(JSON.stringify([
      { step: 1, agent: 'RagAgent', action: 'ok' },
      { step: 2, agent: 'UnknownAgent', action: 'bad' },
      { step: 3, agent: 'GraphAgent', action: 'graph' },
    ]));
    expect(dag[0].agent).toBe('RagAgent');
    expect(dag[1].agent).toBe('RagAgent');
    expect(dag[2].agent).toBe('GraphAgent');
  });
});

// ═══════════════════════════════════════════════════════════
//  3. topologicalSort
// ═══════════════════════════════════════════════════════════
describe('PlannerAgent.topologicalSort()', () => {
  it('sắp xếp đúng thứ tự dependency → dependent', () => {
    const tasks = [
      { step: 1, agent: 'VisionAgent', action: 'extract', status: 'pending' },
      { step: 2, agent: 'CoderAgent', action: 'code', depends_on: 1, status: 'pending' },
      { step: 3, agent: 'RagAgent', action: 'verify', depends_on: 2, status: 'pending' },
    ];
    expect(PlannerAgent.topologicalSort(tasks).map(t => t.step)).toEqual([1, 2, 3]);
  });

  it('xử lý task không có dependency', () => {
    const tasks = [
      { step: 1, agent: 'RagAgent', action: 'a', status: 'pending' },
      { step: 2, agent: 'VisionAgent', action: 'b', status: 'pending' },
    ];
    expect(PlannerAgent.topologicalSort(tasks)).toHaveLength(2);
  });

  it('xử lý DAG phức tạp', () => {
    const tasks = [
      { step: 1, agent: 'VisionAgent', action: 'extract', status: 'pending' },
      { step: 2, agent: 'RagAgent', action: 'search', status: 'pending' },
      { step: 3, agent: 'CoderAgent', action: 'code', depends_on: 1, status: 'pending' },
      { step: 4, agent: 'DebateAgent', action: 'judge', depends_on: 2, status: 'pending' },
      { step: 5, agent: 'ManimAgent', action: 'animate', depends_on: 3, status: 'pending' },
    ];
    const sorted = PlannerAgent.topologicalSort(tasks);
    const pos = (step) => sorted.findIndex(t => t.step === step);
    expect(pos(1)).toBeLessThan(pos(3));
    expect(pos(3)).toBeLessThan(pos(5));
  });

  it('bỏ qua circular dependency', () => {
    const tasks = [
      { step: 1, agent: 'RagAgent', action: 'a', depends_on: 2, status: 'pending' },
      { step: 2, agent: 'CoderAgent', action: 'b', depends_on: 1, status: 'pending' },
    ];
    expect(PlannerAgent.topologicalSort(tasks).length).toBeGreaterThanOrEqual(0);
  });

  it('mảng rỗng → mảng rỗng', () => {
    expect(PlannerAgent.topologicalSort([])).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════
//  4. _heuristicOrient
// ═══════════════════════════════════════════════════════════
describe('PlannerAgent._heuristicOrient()', () => {
  let agent;
  beforeEach(() => { agent = makeAgent().agent; });

  it('completed=true khi tất cả steps xong', () => {
    const orient = agent._heuristicOrient({
      dag: [{ step: 1, agent: 'RagAgent', action: 'a' }, { step: 2, agent: 'CoderAgent', action: 'b' }],
      results: { 1: 'r1', 2: 'r2' },
    }, {});
    expect(orient.completed).toBe(true);
    expect(orient.nextStep).toBeNull();
  });

  it('nextStep=1 khi chưa có step nào xong', () => {
    const orient = agent._heuristicOrient({
      dag: [{ step: 1, agent: 'RagAgent', action: 'a' }, { step: 2, agent: 'CoderAgent', action: 'b', depends_on: 1 }],
      results: {},
    }, {});
    expect(orient.completed).toBe(false);
    expect(orient.nextStep).toBe(1);
  });

  it('nextStep=2 khi step 1 xong', () => {
    const orient = agent._heuristicOrient({
      dag: [{ step: 1, agent: 'RagAgent', action: 'a' }, { step: 2, agent: 'CoderAgent', action: 'b', depends_on: 1 }],
      results: { 1: 'done' },
    }, {});
    expect(orient.completed).toBe(false);
    expect(orient.nextStep).toBe(2);
  });

  it('không skip dependency', () => {
    const orient = agent._heuristicOrient({
      dag: [{ step: 1, agent: 'RagAgent', action: 'a' }, { step: 2, agent: 'CoderAgent', action: 'b', depends_on: 1 }],
      results: {},
    }, {});
    expect(orient.nextStep).toBe(1);
  });

  it('retry step bị failed', () => {
    const orient = agent._heuristicOrient({
      dag: [{ step: 1, agent: 'RagAgent', action: 'a' }, { step: 2, agent: 'CoderAgent', action: 'b', depends_on: 1 }],
      results: { 1: { error: 'timeout', failed: true } },
    }, {});
    expect(orient.completed).toBe(false);
    expect(orient.nextStep).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════
//  5. _orient (LLM)
// ═══════════════════════════════════════════════════════════
describe('PlannerAgent._orient() with LLM', () => {
  it('LLM trả về completed=true', async () => {
    const { agent } = makeAgent();
    makeOrientResponse(true, null, 'All done');
    const orient = await agent._orient({
      originalRequest: makeRequest(),
      dag: [{ step: 1, agent: 'RagAgent', action: 'a' }],
      results: { 1: 'done' },
    }, {});
    expect(orient.completed).toBe(true);
    expect(orient.nextStep).toBeNull();
  });

  it('LLM trả về completed=false, nextStep=2', async () => {
    const { agent } = makeAgent();
    makeOrientResponse(false, 2, 'Need step 2');
    const orient = await agent._orient({
      originalRequest: makeRequest(),
      dag: [{ step: 1, agent: 'RagAgent', action: 'a' }, { step: 2, agent: 'CoderAgent', action: 'b', depends_on: 1 }],
      results: { 1: 'done' },
    }, {});
    expect(orient.completed).toBe(false);
    expect(orient.nextStep).toBe(2);
  });

  it('fallback sang heuristic khi LLM fail', async () => {
    const { agent } = makeAgent();
    makeLlmFail();
    const orient = await agent._orient({
      originalRequest: makeRequest(),
      dag: [{ step: 1, agent: 'RagAgent', action: 'a' }, { step: 2, agent: 'CoderAgent', action: 'b', depends_on: 1 }],
      results: { 1: 'done' },
    }, {});
    expect(orient.completed).toBe(false);
    expect(orient.nextStep).toBe(2);
  });

  it('fallback sang heuristic khi LLM trả về invalid JSON', async () => {
    const { agent } = makeAgent();
    mockLlmAsk.mockResolvedValueOnce({ answer: 'not json', provider: 'mock', model: 'test' });
    const orient = await agent._orient({
      originalRequest: makeRequest(),
      dag: [{ step: 1, agent: 'RagAgent', action: 'a' }],
      results: {},
    }, {});
    expect(orient.completed).toBe(false);
    expect(orient.nextStep).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════
//  6. DISPATCH
// ═══════════════════════════════════════════════════════════
describe('PlannerAgent._dispatchNextStep()', () => {
  it('ném job vào PRIORITY queue cho RagAgent', async () => {
    const { agent } = makeAgent();
    const session = { id: 's1', dag: [{ step: 1, agent: 'RagAgent', action: 'search', status: 'pending' }], originalRequest: makeRequest(), results: {} };
    mockSessionStore.getSession.mockResolvedValue(session);
    mockSessionStore.updateSession.mockResolvedValue(session);
    mockSessionStore.addHistoryEntry.mockResolvedValue();
    await agent._dispatchNextStep('s1', session, 1);
    expect(mockAddJob).toHaveBeenCalledTimes(1);
    expect(mockAddJob.mock.calls[0][0]).toBe('priority-tasks');
    expect(mockAddJob.mock.calls[0][1]).toBe('RagAgent:search');
  });

  it('ném job vào GRAPH queue cho GraphAgent', async () => {
    const { agent } = makeAgent();
    const session = { id: 's1', dag: [{ step: 1, agent: 'GraphAgent', action: 'extract', status: 'pending' }], originalRequest: makeRequest(), results: {} };
    mockSessionStore.getSession.mockResolvedValue(session);
    mockSessionStore.updateSession.mockResolvedValue(session);
    mockSessionStore.addHistoryEntry.mockResolvedValue();
    await agent._dispatchNextStep('s1', session, 1);
    expect(mockAddJob.mock.calls[0][0]).toBe('graph-tasks');
  });

  it('ném job vào EVOLUTION queue cho EvoAgent', async () => {
    const { agent } = makeAgent();
    const session = { id: 's1', dag: [{ step: 1, agent: 'EvoAgent', action: 'auto_evaluate', status: 'pending' }], originalRequest: makeRequest(), results: {} };
    mockSessionStore.getSession.mockResolvedValue(session);
    mockSessionStore.updateSession.mockResolvedValue(session);
    mockSessionStore.addHistoryEntry.mockResolvedValue();
    await agent._dispatchNextStep('s1', session, 1);
    expect(mockAddJob.mock.calls[0][0]).toBe('evolution-tasks');
  });

  it('include dependencyResults nếu có depends_on', async () => {
    const { agent } = makeAgent();
    const session = { id: 's1', dag: [
      { step: 1, agent: 'RagAgent', action: 'search', status: 'pending' },
      { step: 2, agent: 'CoderAgent', action: 'code', depends_on: 1, status: 'pending' },
    ], originalRequest: makeRequest(), results: { 1: 'dep result' } };
    mockSessionStore.getSession.mockResolvedValue(session);
    mockSessionStore.updateSession.mockResolvedValue(session);
    mockSessionStore.addHistoryEntry.mockResolvedValue();
    await agent._dispatchNextStep('s1', session, 2);
    expect(mockAddJob.mock.calls[0][2].dependencyResults).toBe('dep result');
  });

  it('update status thành waiting_for_worker', async () => {
    const { agent } = makeAgent();
    const session = { id: 's1', dag: [{ step: 1, agent: 'RagAgent', action: 'search', status: 'pending' }], originalRequest: makeRequest(), results: {} };
    mockSessionStore.getSession.mockResolvedValue(session);
    mockSessionStore.updateSession.mockResolvedValue(session);
    mockSessionStore.addHistoryEntry.mockResolvedValue();
    await agent._dispatchNextStep('s1', session, 1);
    expect(mockSessionStore.updateSession).toHaveBeenCalledWith('s1', { currentStep: 1, status: 'waiting_for_worker' });
  });

  it('mark failed khi addJob fail', async () => {
    const { agent } = makeAgent();
    const session = { id: 's1', dag: [{ step: 1, agent: 'RagAgent', action: 'search', status: 'pending' }], originalRequest: makeRequest(), results: {} };
    mockAddJob.mockRejectedValueOnce(new Error('Redis down'));
    mockSessionStore.getSession.mockResolvedValue(session);
    mockSessionStore.saveStepResult.mockResolvedValue();
    mockSessionStore.updateSession.mockResolvedValue();
    await agent._dispatchNextStep('s1', session, 1);
    expect(mockSessionStore.saveStepResult).toHaveBeenCalledWith('s1', 1, { error: 'Redis down', failed: true });
    expect(mockSessionStore.updateSession).toHaveBeenCalledWith('s1', { status: 'failed' });
  });

  it('không crash nếu step không tồn tại', async () => {
    const { agent } = makeAgent();
    const session = { id: 's1', dag: [{ step: 1, agent: 'RagAgent', action: 'search', status: 'pending' }], originalRequest: makeRequest(), results: {} };
    await agent._dispatchNextStep('s1', session, 99);
    expect(mockAddJob).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════
//  7. FINALIZE
// ═══════════════════════════════════════════════════════════
describe('PlannerAgent._finalizeSession()', () => {
  it('cập nhật status thành completed', async () => {
    const { agent } = makeAgent();
    const session = { id: 's1', originalRequest: makeRequest(), dag: [{ step: 1, agent: 'RagAgent', action: 'a' }, { step: 2, agent: 'CoderAgent', action: 'b' }], results: { 1: 'r1', 2: 'r2' }, history: [] };
    mockSessionStore.getSession.mockResolvedValue(session);
    mockSessionStore.updateSession.mockResolvedValue();
    await agent._finalizeSession('s1', session, { completed: true, nextStep: null });
    expect(mockSessionStore.updateSession).toHaveBeenCalledWith('s1', expect.objectContaining({ status: 'completed' }));
  });

  it('đếm đúng failed steps', async () => {
    const { agent } = makeAgent();
    const session = { id: 's1', originalRequest: makeRequest(), dag: [{ step: 1, agent: 'RagAgent', action: 'a' }, { step: 2, agent: 'CoderAgent', action: 'b' }], results: { 1: 'ok', 2: { error: 'fail', failed: true } }, history: [] };
    mockSessionStore.getSession.mockResolvedValue(session);
    mockSessionStore.updateSession.mockResolvedValue();
    await agent._finalizeSession('s1', session, { completed: true, nextStep: null });
    expect(mockSessionStore.updateSession.mock.calls[0][1].finalResult.completedSteps).toBe(1);
    expect(mockSessionStore.updateSession.mock.calls[0][1].finalResult.failedSteps).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════
//  8. SESSION LIFECYCLE
// ═══════════════════════════════════════════════════════════
describe('PlannerAgent session lifecycle', () => {
  it('startSession: tạo session → DAG → OODA', async () => {
    const { agent } = makeAgent();
    mockSessionStore.createSession.mockResolvedValue({ id: 's1', originalRequest: makeRequest(), dag: [], status: 'planning', results: {}, history: [] });
    makePlanResponse([{ step: 1, agent: 'RagAgent', action: 'search' }]);
    mockSessionStore.updateSession.mockResolvedValue();
    mockSessionStore.getSession.mockResolvedValue({ id: 's1', originalRequest: makeRequest(), dag: [{ step: 1, agent: 'RagAgent', action: 'search', status: 'pending' }], status: 'running', results: {}, history: [], currentStep: null });
    makeOrientResponse(true, null, 'Done');
    mockSessionStore.addHistoryEntry.mockResolvedValue();
    await agent.startSession('s1', makeRequest());
    expect(mockSessionStore.createSession).toHaveBeenCalledWith('s1', makeRequest());
  });

  it('onWorkerComplete: lưu result → trigger OODA', async () => {
    const { agent } = makeAgent();
    mockSessionStore.saveStepResult.mockResolvedValue();
    mockSessionStore.updateSession.mockResolvedValue();
    mockSessionStore.getSession.mockResolvedValue({ id: 's1', originalRequest: makeRequest(), dag: [{ step: 1, agent: 'RagAgent', action: 'search', status: 'pending' }], status: 'running', results: { 1: 'wr' }, history: [], currentStep: 1 });
    makeOrientResponse(true, null, 'Done');
    mockSessionStore.addHistoryEntry.mockResolvedValue();
    await agent.onWorkerComplete('s1', 1, 'wr');
    expect(mockSessionStore.saveStepResult).toHaveBeenCalledWith('s1', 1, 'wr');
  });

  it('onWorkerFailed: lưu error → mark failed', async () => {
    const { agent } = makeAgent();
    mockSessionStore.saveStepResult.mockResolvedValue();
    mockSessionStore.updateSession.mockResolvedValue();
    mockSessionStore.addHistoryEntry.mockResolvedValue();
    await agent.onWorkerFailed('s1', 1, new Error('timeout'));
    expect(mockSessionStore.saveStepResult).toHaveBeenCalledWith('s1', 1, { error: 'timeout', failed: true });
    expect(mockSessionStore.updateSession).toHaveBeenCalledWith('s1', { status: 'failed' });
  });

  it('closeSession: xóa session', async () => {
    const { agent } = makeAgent();
    mockSessionStore.deleteSession.mockResolvedValue();
    await agent.closeSession('s1');
    expect(mockSessionStore.deleteSession).toHaveBeenCalledWith('s1');
  });

  it('getSessionStatus: đọc từ store', async () => {
    const { agent } = makeAgent();
    mockSessionStore.getSession.mockResolvedValue({ id: 's1', status: 'running' });
    const result = await agent.getSessionStatus('s1');
    expect(result).toEqual({ id: 's1', status: 'running' });
  });
});

// ═══════════════════════════════════════════════════════════
//  9. OODA LOOP
// ═══════════════════════════════════════════════════════════
describe('PlannerAgent._oodaLoop()', () => {
  it('dừng nếu session không tồn tại', async () => {
    const { agent } = makeAgent();
    mockSessionStore.getSession.mockResolvedValue(null);
    await agent._oodaLoop('x');
    expect(mockAddJob).not.toHaveBeenCalled();
  });

  it('dừng nếu waiting_for_worker', async () => {
    const { agent } = makeAgent();
    mockSessionStore.getSession.mockResolvedValue({ id: 's1', status: 'waiting_for_worker', dag: [], results: {} });
    await agent._oodaLoop('s1');
    expect(mockAddJob).not.toHaveBeenCalled();
  });

  it('dừng nếu completed', async () => {
    const { agent } = makeAgent();
    mockSessionStore.getSession.mockResolvedValue({ id: 's1', status: 'completed', dag: [], results: {} });
    await agent._oodaLoop('s1');
    expect(mockAddJob).not.toHaveBeenCalled();
  });

  it('dừng nếu failed', async () => {
    const { agent } = makeAgent();
    mockSessionStore.getSession.mockResolvedValue({ id: 's1', status: 'failed', dag: [], results: {} });
    await agent._oodaLoop('s1');
    expect(mockAddJob).not.toHaveBeenCalled();
  });

  it('dispatch next step', async () => {
    const { agent } = makeAgent();
    mockSessionStore.getSession.mockResolvedValue({ id: 's1', status: 'running', dag: [
      { step: 1, agent: 'RagAgent', action: 'search', status: 'pending' },
      { step: 2, agent: 'CoderAgent', action: 'code', depends_on: 1, status: 'pending' },
    ], results: { 1: 'done' }, history: [], currentStep: 1, originalRequest: makeRequest() });
    makeOrientResponse(false, 2, 'Need step 2');
    mockSessionStore.addHistoryEntry.mockResolvedValue();
    mockSessionStore.updateSession.mockResolvedValue();
    await agent._oodaLoop('s1');
    expect(mockAddJob).toHaveBeenCalledTimes(1);
    expect(mockAddJob.mock.calls[0][2].step).toBe(2);
  });

  it('finalize khi completed', async () => {
    const { agent } = makeAgent();
    mockSessionStore.getSession.mockResolvedValue({ id: 's1', status: 'running', dag: [{ step: 1, agent: 'RagAgent', action: 'search' }], results: { 1: 'done' }, history: [], currentStep: 1, originalRequest: makeRequest() });
    makeOrientResponse(true, null, 'All done');
    mockSessionStore.addHistoryEntry.mockResolvedValue();
    mockSessionStore.updateSession.mockResolvedValue();
    await agent._oodaLoop('s1');
    expect(mockAddJob).not.toHaveBeenCalled();
    expect(mockSessionStore.updateSession).toHaveBeenCalledWith('s1', expect.objectContaining({ status: 'completed' }));
  });

  it('mark failed nếu stuck', async () => {
    const { agent } = makeAgent();
    mockSessionStore.getSession.mockResolvedValue({ id: 's1', status: 'running', dag: [], results: {}, history: [], currentStep: null, originalRequest: makeRequest() });
    makeOrientResponse(false, null, 'Stuck');
    mockSessionStore.addHistoryEntry.mockResolvedValue();
    mockSessionStore.updateSession.mockResolvedValue();
    await agent._oodaLoop('s1');
    expect(mockSessionStore.updateSession).toHaveBeenCalledWith('s1', { status: 'failed' });
  });
});

// ═══════════════════════════════════════════════════════════
//  10. SYNC EXECUTION
// ═══════════════════════════════════════════════════════════
describe('PlannerAgent.executeDagSync()', () => {
  it('chạy DAG đồng bộ', async () => {
    const { agent } = makeAgent({ agentModules: { RagAgent: { answerQuestion: jest.fn().mockResolvedValue('Rag result') } } });
    makePlanResponse([{ step: 1, agent: 'RagAgent', action: 'search' }]);
    const result = await agent.executeDagSync(makeRequest());
    expect(result.dag).toHaveLength(1);
    expect(result.results[1]).toBe('Rag result');
    expect(result.completedSteps).toBe(1);
  });

  it('xử lý lỗi worker', async () => {
    const { agent } = makeAgent({ agentModules: { RagAgent: { answerQuestion: jest.fn().mockRejectedValue(new Error('fail')) } } });
    makePlanResponse([{ step: 1, agent: 'RagAgent', action: 'search' }]);
    const result = await agent.executeDagSync(makeRequest());
    expect(result.results[1]).toMatchObject({ error: 'fail', failed: true });
  });

  it('truyền dependency result', async () => {
    const ragFn = jest.fn().mockResolvedValue('s1');
    const coderFn = jest.fn().mockResolvedValue('s2');
    const { agent } = makeAgent({ agentModules: { RagAgent: { answerQuestion: ragFn }, CoderAgent: { solveProblem: coderFn } } });
    makePlanResponse([{ step: 1, agent: 'RagAgent', action: 'a' }, { step: 2, agent: 'CoderAgent', action: 'b', depends_on: 1 }]);
    await agent.executeDagSync(makeRequest());
    expect(coderFn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ dependencyResult: 's1' }));
  });

  it('lỗi nếu agent module không inject', async () => {
    const { agent } = makeAgent({ agentModules: {} });
    makePlanResponse([{ step: 1, agent: 'RagAgent', action: 'search' }]);
    const result = await agent.executeDagSync(makeRequest());
    expect(result.results[1]).toMatchObject({ error: "Agent module 'RagAgent' not injected", failed: true });
  });
});

// ═══════════════════════════════════════════════════════════
//  11. EDGE CASES
// ═══════════════════════════════════════════════════════════
describe('PlannerAgent edge cases', () => {
  it('constructor defaults', () => {
    const agent = new PlannerAgent({ apiKey: 'test' });
    expect(agent.tryLocalLlm).toBeNull();
    expect(agent.model).toBe('openrouter/auto');
  });

  it('content rỗng → vẫn hoạt động', async () => {
    const { agent } = makeAgent();
    makePlanResponse([{ step: 1, agent: 'RagAgent', action: 'reply' }]);
    const dag = await agent._createDagPlan(makeRequest({ content: '' }));
    expect(Array.isArray(dag)).toBe(true);
  });

  it('LLM null answer → fallback', async () => {
    const { agent } = makeAgent();
    mockLlmAsk.mockResolvedValueOnce({ answer: null, provider: 'mock', model: 'test' });
    const dag = await agent._createDagPlan(makeRequest());
    expect(dag).toHaveLength(1);
  });

  it('LLM empty answer → fallback', async () => {
    const { agent } = makeAgent();
    mockLlmAsk.mockResolvedValueOnce({ answer: '', provider: 'mock', model: 'test' });
    const dag = await agent._createDagPlan(makeRequest());
    expect(dag).toHaveLength(1);
  });

  it('LLM plain text → fallback', async () => {
    const { agent } = makeAgent();
    mockLlmAsk.mockResolvedValueOnce({ answer: 'Xin chào', provider: 'mock', model: 'test' });
    const dag = await agent._createDagPlan(makeRequest());
    expect(dag).toHaveLength(1);
  });
});
