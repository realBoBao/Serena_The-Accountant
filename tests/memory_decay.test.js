/**
 * Memory Decay & Consolidation Tests — Tier 3
 */
import { describe, test, expect } from '@jest/globals';
import { memoryDecay, ebbinghausRetention, DEFAULT_HALF_LIFE } from '../lib/memory_decay.js';

describe('Memory Decay — ebbinghausRetention', () => {
  test('returns 1.0 for zero elapsed time', () => {
    expect(ebbinghausRetention(0, 86400000)).toBe(1.0);
  });

  test('returns ~0.5 at half-life', () => {
    const halfLife = 86400000; // 1 day in ms
    const result = ebbinghausRetention(halfLife, halfLife);
    expect(result).toBeCloseTo(0.5, 2);
  });

  test('decays over time', () => {
    const halfLife = 86400000;
    const r1 = ebbinghausRetention(halfLife, halfLife);
    const r2 = ebbinghausRetention(halfLife * 3, halfLife);
    expect(r2).toBeLessThan(r1);
  });

  test('approaches 0 for large elapsed time', () => {
    const halfLife = 86400000;
    const result = ebbinghausRetention(halfLife * 30, halfLife);
    expect(result).toBeLessThan(0.01);
  });

  test('returns 0 for zero half-life', () => {
    expect(ebbinghausRetention(1000, 0)).toBe(0);
  });

  test('returns 0 for negative half-life', () => {
    expect(ebbinghausRetention(1000, -100)).toBe(0);
  });
});

describe('Memory Decay — DEFAULT_HALF_LIFE', () => {
  test('category_affinity is 14 days', () => {
    expect(DEFAULT_HALF_LIFE.category_affinity).toBe(14 * 24 * 60 * 60 * 1000);
  });

  test('topic_strength is 30 days', () => {
    expect(DEFAULT_HALF_LIFE.topic_strength).toBe(30 * 24 * 60 * 60 * 1000);
  });

  test('mood_weight is 3 days', () => {
    expect(DEFAULT_HALF_LIFE.mood_weight).toBe(3 * 24 * 60 * 60 * 1000);
  });

  test('implicit_score is 21 days', () => {
    expect(DEFAULT_HALF_LIFE.implicit_score).toBe(21 * 24 * 60 * 60 * 1000);
  });
});

describe('Memory Decay — decayValue', () => {
  test('returns same value for zero elapsed', () => {
    const result = memoryDecay.decayValue(0.8, 0, 'category_affinity');
    expect(result).toBe(0.8);
  });

  test('decays value over time', () => {
    const result = memoryDecay.decayValue(0.8, 14 * 24 * 60 * 60 * 1000, 'category_affinity');
    expect(result).toBeLessThan(0.8);
    expect(result).toBeGreaterThanOrEqual(0.1);
  });

  test('respects minValue floor', () => {
    const result = memoryDecay.decayValue(0.5, 365 * 24 * 60 * 60 * 1000, 'category_affinity', 0.15);
    expect(result).toBeGreaterThanOrEqual(0.15);
  });

  test('uses default half-life for unknown type', () => {
    const result = memoryDecay.decayValue(0.8, 21 * 24 * 60 * 60 * 1000, 'unknown_type');
    // Should use implicit_score half-life (21 days) → ~0.5
    expect(result).toBeLessThan(0.8);
    expect(result).toBeGreaterThan(0.1);
  });
});

describe('Memory Decay — getProfileFreshness', () => {
  test('returns null for unknown user', async () => {
    const freshness = await memoryDecay.getProfileFreshness('nonexistent_user');
    expect(freshness).toBeNull();
  });
});

describe('Memory Decay — getDecayStats', () => {
  test('returns empty array for unknown user', async () => {
    const stats = await memoryDecay.getDecayStats('nonexistent_user');
    expect(stats).toEqual([]);
  });
});

describe('Memory Decay — cleanup', () => {
  test('does not throw', async () => {
    await expect(memoryDecay.cleanup(0)).resolves.not.toThrow();
  });
});

describe('Memory Decay — runDailyDecay', () => {
  test('returns usersProcessed and totalChanges', async () => {
    const result = await memoryDecay.runDailyDecay();
    expect(result).toHaveProperty('usersProcessed');
    expect(result).toHaveProperty('totalChanges');
    expect(typeof result.usersProcessed).toBe('number');
    expect(typeof result.totalChanges).toBe('number');
  });
});
