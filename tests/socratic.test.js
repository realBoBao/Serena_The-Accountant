/**
 * SocraticAgent — Unit Tests (pure functions)
 * Test logic không cần LLM/DB — chỉ pure functions
 */

import { SocraticAgent } from '../agents/SocraticAgent.js';

describe('SocraticAgent — isConfusedSignal', () => {
  test('detects Vietnamese confused signals', () => {
    expect(SocraticAgent.isConfusedSignal('không biết')).toBe(true);
    expect(SocraticAgent.isConfusedSignal('chịu rồi')).toBe(true);
    expect(SocraticAgent.isConfusedSignal('bó tay')).toBe(true);
    expect(SocraticAgent.isConfusedSignal('không hiểu gì')).toBe(true);
    expect(SocraticAgent.isConfusedSignal('mù tịt')).toBe(true);
  });

  test('detects escape commands', () => {
    expect(SocraticAgent.isConfusedSignal('!explain')).toBe(true);
    expect(SocraticAgent.isConfusedSignal('skip')).toBe(true);
    expect(SocraticAgent.isConfusedSignal('hint đi')).toBe(true);
    expect(SocraticAgent.isConfusedSignal('nói thẳng đi')).toBe(true);
  });

  test('detects short/empty responses', () => {
    expect(SocraticAgent.isConfusedSignal('')).toBe(true);
    expect(SocraticAgent.isConfusedSignal('ok')).toBe(true);
    expect(SocraticAgent.isConfusedSignal('???')).toBe(true);
  });

  test('does not flag normal answers', () => {
    expect(SocraticAgent.isConfusedSignal('binary search tìm kiếm bằng cách chia đôi mảng')).toBe(false);
    expect(SocraticAgent.isConfusedSignal('O(log n)')).toBe(false);
    expect(SocraticAgent.isConfusedSignal('dùng hash map để tìm kiếm O(1)')).toBe(false);
  });

  test('detects English confused signals', () => {
    expect(SocraticAgent.isConfusedSignal('wtf')).toBe(true);
    expect(SocraticAgent.isConfusedSignal('help')).toBe(true);
    expect(SocraticAgent.isConfusedSignal('cứu')).toBe(true);
  });
});
