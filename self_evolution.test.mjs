/**
 * Self-Evolution Protocol Tests — Phase 20
 */
import { describe, test, expect, beforeEach } from '@jest/globals';
import {
  evaluateResponse,
  getLowQualityResponses,
  getEvaluationStats,
  recordModelCall,
  selectOptimalModel,
  getModelPerformanceReport,
  createABTest,
  selectStrategy,
  recordABResult,
  getABTestResults,
  getAllABTestResults,
} from '../lib/self_evolution.js';

beforeEach(() => {
  // Reset model stats between tests
  // Note: evaluation log persists but that's OK for testing
});

describe('Self-Evolution — Response Evaluation', () => {
  test('evaluateResponse returns score 0-1', async () => {
    const result = await evaluateResponse(
      'What is QuickSort?',
      'QuickSort is a divide-and-conquer algorithm that picks a pivot element and partitions the array around it.'
    );
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(1);
    expect(result.checks.length).toBeGreaterThan(0);
  });

  test('evaluateResponse detects short response as low quality', async () => {
    const result = await evaluateResponse('What is QuickSort?', 'It sorts.');
    expect(result.score).toBeLessThan(0.5);
  });

  test('evaluateResponse detects refusal', async () => {
    const result = await evaluateResponse(
      'What is QuickSort?',
      "I don't know about QuickSort. I cannot answer that."
    );
    expect(result.score).toBeLessThan(0.5);
  });

  test('evaluateResponse rewards keyword relevance', async () => {
    const result = await evaluateResponse(
      'Explain binary tree traversal',
      'Binary tree traversal involves visiting each node in a binary tree. There are three types: inorder, preorder, and postorder traversal.'
    );
    const keywordCheck = result.checks.find(c => c.check === 'keyword_relevance');
    expect(keywordCheck.score).toBeGreaterThan(0.3);
  });

  test('getEvaluationStats returns aggregate stats', () => {
    const stats = getEvaluationStats();
    expect(stats).toHaveProperty('total');
    expect(stats).toHaveProperty('avgScore');
    expect(stats).toHaveProperty('lowQualityRate');
  });
});

describe('Self-Evolution — Adaptive Model Selection', () => {
  test('recordModelCall tracks model performance', () => {
    recordModelCall('test-model-a', { latencyMs: 1000, success: true, tokensUsed: 100, cost: 0.001 });
    const report = getModelPerformanceReport();
    expect(report['test-model-a']).toBeTruthy();
    expect(report['test-model-a'].calls).toBe(1);
    expect(report['test-model-a'].successRate).toBe(1);
  });

  test('selectOptimalModel picks best model', () => {
    // Model A: fast and reliable
    for (let i = 0; i < 10; i++) {
      recordModelCall('fast-model', { latencyMs: 500, success: true, cost: 0.001 });
    }
    // Model B: slow and unreliable
    for (let i = 0; i < 10; i++) {
      recordModelCall('slow-model', { latencyMs: 15000, success: i < 5, cost: 0.01 });
    }

    const best = selectOptimalModel('general');
    expect(best).toBe('fast-model');
  });

  test('selectOptimalModel returns null for no data', () => {
    const best = selectOptimalModel('general', []);
    expect(best).toBeNull();
  });

  test('getModelPerformanceReport includes all tracked models', () => {
    const report = getModelPerformanceReport();
    expect(Object.keys(report).length).toBeGreaterThan(0);
    for (const [model, perf] of Object.entries(report)) {
      expect(perf).toHaveProperty('calls');
      expect(perf).toHaveProperty('successRate');
      expect(perf).toHaveProperty('avgLatencyMs');
    }
  });
});

describe('Self-Evolution — A/B Testing', () => {
  test('createABTest initializes test', () => {
    createABTest('prompt-test', { name: 'formal' }, { name: 'casual' });
    const results = getABTestResults('prompt-test');
    expect(results).not.toBeNull();
    expect(results.strategyA.name).toBe('formal');
    expect(results.strategyB.name).toBe('casual');
  });

  test('selectStrategy returns A or B', () => {
    createABTest('ab-test-2', { name: 'A' }, { name: 'B' });
    const strategy = selectStrategy('ab-test-2');
    expect(strategy).not.toBeNull();
    expect(['A', 'B']).toContain(strategy.strategy);
  });

  test('recordABResult updates scores', () => {
    createABTest('ab-test-3', { name: 'A' }, { name: 'B' });
    recordABResult('ab-test-3', 'A', 0.9);
    recordABResult('ab-test-3', 'A', 0.8);
    recordABResult('ab-test-3', 'B', 0.5);

    const results = getABTestResults('ab-test-3');
    expect(results.strategyA.avgScore).toBe(0.85);
    expect(results.strategyB.avgScore).toBe(0.5);
    expect(results.winner).toBe('A');
  });

  test('getAllABTestResults returns all tests', () => {
    const all = getAllABTestResults();
    expect(Object.keys(all).length).toBeGreaterThan(0);
  });
});
