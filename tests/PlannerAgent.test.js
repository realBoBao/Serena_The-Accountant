/**
 * PlannerAgent Tests — DAG Plan Creation
 * Tests createPlan() and createVisionFirstPlan() from agents/PlannerAgent.js
 */
import { describe, it, expect, beforeEach, jest } from '@jest/globals';

// ── Mock llm.js ──
const mockLlmAsk = jest.fn();

jest.unstable_mockModule('../lib/llm.js', () => ({
  __esModule: true,
  ask: mockLlmAsk,
  default: { ask: mockLlmAsk },
}));

// ── Dynamic import after mock setup ──
const { createPlan, createVisionFirstPlan } = await import('../agents/PlannerAgent.js');

// ── Tests ──
describe('PlannerAgent — createPlan', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should create a plan with valid LLM response', async () => {
    mockLlmAsk.mockResolvedValue(JSON.stringify({
      goal: 'Explain quicksort',
      steps: [
        { id: 'step1', action: 'Research quicksort algorithm', dependsOn: [], agent: 'RagAgent' },
        { id: 'step2', action: 'Write implementation', dependsOn: ['step1'], agent: 'CoderAgent' },
      ],
    }));

    const result = await createPlan('Explain quicksort algorithm');

    expect(result).toBeDefined();
    expect(result.goal).toBe('Explain quicksort');
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0].agent).toBe('RagAgent');
    expect(result.steps[1].dependsOn).toEqual(['step1']);
  });

  it('should handle LLM failure gracefully with fallback', async () => {
    mockLlmAsk.mockRejectedValue(new Error('LLM down'));

    const result = await createPlan('test query');

    expect(result).toBeDefined();
    expect(result.goal).toBe('test query');
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].agent).toBe('CoderAgent');
    expect(result.error).toBe('LLM down');
  });

  it('should handle non-JSON LLM response with fallback', async () => {
    mockLlmAsk.mockResolvedValue('This is not JSON at all');

    const result = await createPlan('test query');

    expect(result).toBeDefined();
    expect(result.goal).toBe('test query');
    expect(result.steps).toHaveLength(1);
    expect(result.error).toBeDefined();
  });

  it('should return empty steps array when LLM returns no steps', async () => {
    mockLlmAsk.mockResolvedValue(JSON.stringify({ goal: 'test' }));

    const result = await createPlan('test');

    expect(result.steps).toEqual([]);
  });
});

describe('PlannerAgent — createVisionFirstPlan', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should create a vision-first plan', async () => {
    mockLlmAsk.mockResolvedValue(JSON.stringify({
      goal: 'Build a web app from mockup',
      steps: [
        { id: 'step1', action: 'Analyze mockup layout', dependsOn: [], agent: 'VisionAgent' },
        { id: 'step2', action: 'Generate HTML/CSS', dependsOn: ['step1'], agent: 'CoderAgent' },
      ],
    }));

    const result = await createVisionFirstPlan({
      imageDescription: 'A login form with username and password fields',
      userQuery: 'Build this login page',
      userId: 'user-1',
    });

    expect(result).toBeDefined();
    expect(result.goal).toBe('Build a web app from mockup');
    expect(result.steps).toHaveLength(2);
    expect(result.visionDescription).toBe('A login form with username and password fields');
    expect(result.userQuery).toBe('Build this login page');
  });

  it('should handle LLM failure in vision-first plan', async () => {
    mockLlmAsk.mockRejectedValue(new Error('Vision LLM down'));

    const result = await createVisionFirstPlan({
      imageDescription: 'A chart',
      userQuery: 'Analyze this chart',
      userId: 'user-1',
    });

    expect(result).toBeDefined();
    expect(result.goal).toBe('Analyze this chart');
    expect(result.steps).toHaveLength(1);
    expect(result.error).toBe('Vision LLM down');
  });
});
