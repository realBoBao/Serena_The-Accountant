/**
 * E2E Integration Tests — Full Pipeline (ESM)
 */
import { describe, it, expect } from '@jest/globals';

describe('E2E: Scope Detector', () => {
  it('should detect out-of-scope queries', async () => {
    const { checkScope } = await import('../lib/scope_detector.js');
    expect(checkScope('What is the meaning of life?').inScope).toBe(false);
    expect(checkScope('Explain binary search algorithm').inScope).toBe(true);
  });

  it('should reject non-technical queries', async () => {
    const { checkScope } = await import('../lib/scope_detector.js');
    for (const q of ['best restaurants in Tokyo', 'how to cook pasta', 'funny cat videos']) {
      expect(checkScope(q).inScope).toBe(false);
    }
  });

  it('should accept technical queries', async () => {
    const { checkScope } = await import('../lib/scope_detector.js');
    for (const q of ['explain distributed systems', 'binary search algorithm']) {
      expect(checkScope(q).inScope).toBe(true);
    }
  });
});

describe('E2E: RAG Quality', () => {
  it('should evaluate answer quality', async () => {
    const { evaluateRagAnswer } = await import('../lib/rag_evaluator.js');
    const result = await evaluateRagAnswer(
      'What is binary search?',
      'Binary search is an algorithm that finds the position of a target value within a sorted array.',
      ['Binary search is an algorithm that finds the position of a target value within a sorted array by repeatedly dividing the search interval in half.']
    );
    expect(result.score).toBeGreaterThan(0.5);
  });
});
