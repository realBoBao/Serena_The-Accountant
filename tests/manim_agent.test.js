/**
 * ManimAgent Tests — Pipeline Logic & Exports
 */
import { describe, test, expect } from '@jest/globals';

describe('ManimAgent — Exports', () => {
  test('exports createAnimationForPlanner', async () => {
    const mod = await import('../agents/ManimAgent.js');
    expect(typeof mod.createAnimationForPlanner).toBe('function');
  });

  test('exports createAnimation (backward compat)', async () => {
    const mod = await import('../agents/ManimAgent.js');
    expect(typeof mod.createAnimation).toBe('function');
  });

  test('exports createAnimationWithCompression (backward compat)', async () => {
    const mod = await import('../agents/ManimAgent.js');
    expect(typeof mod.createAnimationWithCompression).toBe('function');
  });

  test('exports createAnimationAsync', async () => {
    const mod = await import('../agents/ManimAgent.js');
    expect(typeof mod.createAnimationAsync).toBe('function');
  });

  test('exports generateManimCode', async () => {
    const mod = await import('../agents/ManimAgent.js');
    expect(typeof mod.generateManimCode).toBe('function');
  });

  test('exports renderManimVideo', async () => {
    const mod = await import('../agents/ManimAgent.js');
    expect(typeof mod.renderManimVideo).toBe('function');
  });

  test('exports compressVideo', async () => {
    const mod = await import('../agents/ManimAgent.js');
    expect(typeof mod.compressVideo).toBe('function');
  });
});

describe('ManimAgent — createAnimationAsync', () => {
  test('returns jobId and promise', async () => {
    const { createAnimationAsync } = await import('../agents/ManimAgent.js');
    const { jobId, promise } = createAnimationAsync('test animation');
    expect(jobId).toMatch(/^anim:\d+:[a-z0-9]+$/);
    expect(promise).toBeInstanceOf(Promise);
  });
});

describe('ManimAgent — createAnimationForPlanner options', () => {
  test('accepts options parameter', async () => {
    const { createAnimationForPlanner } = await import('../agents/ManimAgent.js');
    // Just verify it accepts options without throwing
    expect(() => createAnimationForPlanner('test', {
      compress: false,
      uploadToCdn: false,
      maxRetries: 0,
    })).not.toThrow();
  });
});
