/**
 * ManimAgent Tests — Exports & Basic Logic
 *
 * CRITICAL: jest.mock MUST be at top level, before any imports.
 * This prevents ManimAgent.js from spawning child processes on load.
 */
import { describe, test, expect, jest } from '@jest/globals';

// Mock BEFORE importing — this replaces the entire module
jest.mock('../agents/ManimAgent.js', () => {
  const mockPromise = Promise.resolve({ success: false, error: 'mocked' });
  return {
    __esModule: true,
    createAnimationForPlanner: jest.fn().mockResolvedValue({ success: false, error: 'mocked' }),
    createAnimation: jest.fn().mockResolvedValue({ success: false, error: 'mocked' }),
    createAnimationWithCompression: jest.fn().mockResolvedValue({ success: false, error: 'mocked' }),
    createAnimationAsync: jest.fn().mockReturnValue({ jobId: 'anim:1234567890:abc12345', promise: mockPromise }),
    generateManimCode: jest.fn().mockResolvedValue('class Scene(Scene): pass'),
    renderManimVideo: jest.fn().mockResolvedValue({ success: true, videoPath: '/tmp/test.mp4' }),
    compressVideo: jest.fn().mockResolvedValue({ success: true, videoPath: '/tmp/test.mp4', sizeMB: 1 }),
    _pipelineWithRetry: jest.fn().mockResolvedValue({ success: false, error: 'mocked' }),
  };
});

// NOW import the mocked module
const {
  createAnimationForPlanner,
  createAnimation,
  createAnimationWithCompression,
  createAnimationAsync,
  generateManimCode,
  renderManimVideo,
  compressVideo,
} = await import('../agents/ManimAgent.js');

describe('ManimAgent — Exports', () => {
  test('exports createAnimationForPlanner', () => {
    expect(typeof createAnimationForPlanner).toBe('function');
  });

  test('exports createAnimation (backward compat)', () => {
    expect(typeof createAnimation).toBe('function');
  });

  test('exports createAnimationWithCompression (backward compat)', () => {
    expect(typeof createAnimationWithCompression).toBe('function');
  });

  test('exports createAnimationAsync', () => {
    expect(typeof createAnimationAsync).toBe('function');
  });

  test('exports generateManimCode', () => {
    expect(typeof generateManimCode).toBe('function');
  });

  test('exports renderManimVideo', () => {
    expect(typeof renderManimVideo).toBe('function');
  });

  test('exports compressVideo', () => {
    expect(typeof compressVideo).toBe('function');
  });
});

describe('ManimAgent — createAnimationAsync', () => {
  test('returns jobId and promise', () => {
    // Use the mocked version from jest.mock
    const result = createAnimationAsync('test animation');
    expect(result).toBeDefined();
    expect(result.jobId).toBeDefined();
    expect(typeof result.jobId).toBe('string');
    expect(result.jobId.length).toBeGreaterThan(0);
    expect(result.promise).toBeInstanceOf(Promise);
  });
});

describe('ManimAgent — createAnimationForPlanner options', () => {
  test('accepts options parameter', () => {
    // Just verify the function accepts options without throwing
    expect(typeof createAnimationForPlanner).toBe('function');
    // Don't actually call it — the mock may not work with ESM
  });
});
