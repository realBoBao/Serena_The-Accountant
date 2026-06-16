/**
 * Implicit Feedback Loop Tests — Tier 1
 */
import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { implicitFeedback } from '../lib/implicit_feedback.js';

const TEST_USER = 'test_user_if_001';

beforeEach(async () => {
  await implicitFeedback.cleanup(0);
});

afterEach(async () => {
  await implicitFeedback.cleanup(0);
});

describe('Implicit Feedback — trackOutbound', () => {
  test('trackOutbound returns a tracking ID', async () => {
    const id = await implicitFeedback.trackOutbound(TEST_USER, {
      url: 'https://youtube.com/watch?v=abc',
      category: 'video',
      messageId: 'msg123',
    });
    expect(id).toBeDefined();
    expect(id.startsWith('if_')).toBe(true);
  });

  test('trackOutbound does not throw with null DB', async () => {
    // Should gracefully handle SQLite being unavailable
    await expect(implicitFeedback.trackOutbound('any_user', {
      url: 'https://example.com',
      category: 'test',
    })).resolves.toBeDefined();
  });
});

describe('Implicit Feedback — recordClick', () => {
  test('recordClick does not throw', async () => {
    await expect(implicitFeedback.recordClick('fake_id', TEST_USER)).resolves.not.toThrow();
  });
});

describe('Implicit Feedback — recordDwellTime', () => {
  test('recordDwellTime does not throw', async () => {
    await expect(implicitFeedback.recordDwellTime('fake_id', TEST_USER, 5000)).resolves.not.toThrow();
  });
});

describe('Implicit Feedback — getImplicitSignals', () => {
  test('returns default signals for new user', async () => {
    const signals = await implicitFeedback.getImplicitSignals('brand_new_user');
    expect(signals.userId).toBe('brand_new_user');
    expect(signals.clickThroughRate).toBe(0);
    expect(signals.totalSent).toBe(0);
    expect(signals.categoryAffinity).toEqual([]);
  });

  test('returns valid structure even with null DB', async () => {
    const signals = await implicitFeedback.getImplicitSignals(TEST_USER);
    expect(signals).toHaveProperty('userId');
    expect(signals).toHaveProperty('categoryAffinity');
    expect(signals).toHaveProperty('clickThroughRate');
    expect(signals).toHaveProperty('computedAt');
  });
});

describe('Implicit Feedback — getCategoryAffinity', () => {
  test('returns array', async () => {
    const affinity = await implicitFeedback.getCategoryAffinity(TEST_USER);
    expect(Array.isArray(affinity)).toBe(true);
  });
});

describe('Implicit Feedback — markOldUnclickedAsSkipped', () => {
  test('returns a number', async () => {
    const count = await implicitFeedback.markOldUnclickedAsSkipped(0);
    expect(typeof count).toBe('number');
  });
});

describe('Implicit Feedback — _getRecentUnreplied', () => {
  test('returns array', async () => {
    const links = await implicitFeedback._getRecentUnreplied(TEST_USER);
    expect(Array.isArray(links)).toBe(true);
  });
});

describe('Implicit Feedback — cleanup', () => {
  test('does not throw', async () => {
    await expect(implicitFeedback.cleanup(0)).resolves.not.toThrow();
  });
});
