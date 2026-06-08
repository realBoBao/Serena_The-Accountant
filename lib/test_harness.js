/**
 * Formal Verification — Test Case Library for CoderAgent
 *
 * Provides deterministic test cases for classic CS algorithms.
 * Agent writes code → Sandbox runs against test cases → Pass/Fail verdict.
 * This eliminates LLM "hallucination" about code correctness.
 *
 * Usage:
 *   import { getTestCases, runTests } from './test_harness.js';
 *   const tests = getTestCases('sorting');
 *   const result = await runTests(code, 'sorting', 'python');
 */

import { executeCode } from './code_sandbox.js';
import { getLogger } from './logger.js';

const logger = getLogger('TestHarness');

// ═══════════════════════════════════════════════════════════
// TEST CASE LIBRARY — Classic CS Algorithms
// ═══════════════════════════════════════════════════════════

const TEST_LIBRARY = {
  // ── Sorting ──
  sorting: {
    description: 'Sort an array of integers in ascending order',
    language: 'python',
    template: (input) => `arr = ${JSON.stringify(input)}\nprint(sort_array(arr))`,
    wrapper: (userCode) => `${userCode}\n\n# Test\n{TEST_CALLS}`,
    testCases: [
      { input: [3, 1, 4, 1, 5, 9, 2, 6], expected: [1, 1, 2, 3, 4, 5, 6, 9] },
      { input: [], expected: [] },
      { input: [1], expected: [1] },
      { input: [5, 4, 3, 2, 1], expected: [1, 2, 3, 4, 5] },
      { input: [1, 1, 1], expected: [1, 1, 1] },
      { input: [-3, -1, -2], expected: [-3, -2, -1] },
    ],
    functionName: 'sort_array',
  },

  // ── Binary Search ──
  binary_search: {
    description: 'Find target in sorted array, return index or -1',
    language: 'python',
    wrapper: (userCode) => `${userCode}\n\n# Test\n{TEST_CALLS}`,
    testCases: [
      { input: { arr: [1, 3, 5, 7, 9], target: 5 }, expected: 2 },
      { input: { arr: [1, 3, 5, 7, 9], target: 1 }, expected: 0 },
      { input: { arr: [1, 3, 5, 7, 9], target: 9 }, expected: 4 },
      { input: { arr: [1, 3, 5, 7, 9], target: 4 }, expected: -1 },
      { input: { arr: [], target: 1 }, expected: -1 },
      { input: { arr: [2], target: 2 }, expected: 0 },
    ],
    functionName: 'binary_search',
  },

  // ── Two Sum ──
  two_sum: {
    description: 'Find two numbers that add up to target, return their indices',
    language: 'python',
    wrapper: (userCode) => `${userCode}\n\n# Test\n{TEST_CALLS}`,
    testCases: [
      { input: { nums: [2, 7, 11, 15], target: 9 }, expected: [0, 1] },
      { input: { nums: [3, 2, 4], target: 6 }, expected: [1, 2] },
      { input: { nums: [3, 3], target: 6 }, expected: [0, 1] },
      { input: { nums: [1, 2, 3, 4, 5], target: 10 }, expected: [-1, -1] },
    ],
    functionName: 'two_sum',
  },

  // ── Fibonacci ──
  fibonacci: {
    description: 'Return the nth Fibonacci number (0-indexed)',
    language: 'python',
    wrapper: (userCode) => `${userCode}\n\n# Test\n{TEST_CALLS}`,
    testCases: [
      { input: 0, expected: 0 },
      { input: 1, expected: 1 },
      { input: 2, expected: 1 },
      { input: 10, expected: 55 },
      { input: 20, expected: 6765 },
    ],
    functionName: 'fibonacci',
  },

  // ── Palindrome Check ──
  palindrome: {
    description: 'Check if a string is a palindrome',
    language: 'python',
    wrapper: (userCode) => `${userCode}\n\n# Test\n{TEST_CALLS}`,
    testCases: [
      { input: 'racecar', expected: true },
      { input: 'hello', expected: false },
      { input: 'a', expected: true },
      { input: '', expected: true },
      { input: 'Aba', expected: true },
    ],
    functionName: 'is_palindrome',
  },

  // ── GCD ──
  gcd: {
    description: 'Find greatest common divisor of two numbers',
    language: 'python',
    wrapper: (userCode) => `${userCode}\n\n# Test\n{TEST_CALLS}`,
    testCases: [
      { input: { a: 12, b: 8 }, expected: 4 },
      { input: { a: 17, b: 13 }, expected: 1 },
      { input: { a: 100, b: 25 }, expected: 25 },
      { input: { a: 0, b: 5 }, expected: 5 },
    ],
    functionName: 'gcd',
  },

  // ── Linked List Cycle Detection ──
  has_cycle: {
    description: 'Detect if linked list has a cycle',
    language: 'python',
    wrapper: (userCode) => `${userCode}\n\n# Test\n{TEST_CALLS}`,
    testCases: [
      { input: { values: [3, 2, 0, -4], pos: 1 }, expected: true },
      { input: { values: [1, 2], pos: 0 }, expected: true },
      { input: { values: [1], pos: -1 }, expected: false },
      { input: { values: [], pos: -1 }, expected: false },
    ],
    functionName: 'has_cycle',
  },

  // ── BFS/DFS ──
  bfs_traversal: {
    description: 'BFS traversal of a graph (adjacency list)',
    language: 'python',
    wrapper: (userCode) => `${userCode}\n\n# Test\n{TEST_CALLS}`,
    testCases: [
      { input: { graph: [[1, 2], [0, 3], [0, 3], [1, 2]], start: 0 }, expected: [0, 1, 2, 3] },
      { input: { graph: [[1], [0]], start: 0 }, expected: [0, 1] },
      { input: { graph: [[], []], start: 0 }, expected: [0] },
    ],
    functionName: 'bfs',
  },

  // ── Dynamic Programming: Coin Change ──
  coin_change: {
    description: 'Minimum coins to make amount, -1 if impossible',
    language: 'python',
    wrapper: (userCode) => `${userCode}\n\n# Test\n{TEST_CALLS}`,
    testCases: [
      { input: { coins: [1, 5, 10, 25], amount: 30 }, expected: 2 },
      { input: { coins: [2], amount: 3 }, expected: -1 },
      { input: { coins: [1], amount: 0 }, expected: 0 },
      { input: { coins: [1, 5, 10], amount: 11 }, expected: 2 },
    ],
    functionName: 'coin_change',
  },

  // ── Stack: Valid Parentheses ──
  valid_parentheses: {
    description: 'Check if string has valid balanced parentheses',
    language: 'python',
    wrapper: (userCode) => `${userCode}\n\n# Test\n{TEST_CALLS}`,
    testCases: [
      { input: '()', expected: true },
      { input: '()[]{}', expected: true },
      { input: '(]', expected: false },
      { input: '([)]', expected: false },
      { input: '{[]}', expected: true },
      { input: '', expected: true },
    ],
    functionName: 'is_valid',
  },

  // ── Tree: Max Depth ──
  max_depth: {
    description: 'Find maximum depth of binary tree',
    language: 'python',
    wrapper: (userCode) => `${userCode}\n\n# Test\n{TEST_CALLS}`,
    testCases: [
      { input: { val: 3, left: { val: 9 }, right: { val: 20, left: { val: 15 }, right: { val: 7 } } }, expected: 3 },
      { input: { val: 1 }, expected: 1 },
      { input: null, expected: 0 },
    ],
    functionName: 'max_depth',
  },
};

/**
 * Get test cases for a given algorithm.
 * @param {string} algorithm — Algorithm name (e.g., 'sorting', 'binary_search')
 * @returns {object|null} Test config with testCases array
 */
export function getTestCases(algorithm) {
  return TEST_LIBRARY[algorithm] || null;
}

/**
 * Get all available algorithm names.
 */
export function getAvailableAlgorithms() {
  return Object.keys(TEST_LIBRARY);
}

/**
 * Auto-detect algorithm from problem description.
 * @param {string} problem — Problem description
 * @returns {string|null} Algorithm name or null
 */
export function detectAlgorithm(problem) {
  const p = (problem || '').toLowerCase();

  const keywords = {
    sorting: ['sort', 'sắp xếp', 'sorting', 'arrange'],
    binary_search: ['binary search', 'tìm kiếm nhị phân', 'tìm trong mảng đã sắp xếp'],
    two_sum: ['two sum', 'hai số', 'two numbers add up'],
    fibonacci: ['fibonacci', 'fib', 'f(n)'],
    palindrome: ['palindrome', 'đối xứng', 'đọc xuôi ngược'],
    gcd: ['gcd', 'ước chung lớn nhất', 'greatest common divisor', 'gcf'],
    has_cycle: ['cycle', 'linked list cycle', 'chu trình', 'vòng lặp danh sách liên kết'],
    bfs_traversal: ['bfs', 'breadth first', 'duyệt theo chiều rộng', 'level order'],
    coin_change: ['coin change', 'đổi tiền', 'minimum coins', 'số đồng xu'],
    valid_parentheses: ['valid parentheses', 'dấu ngoặc', 'balanced brackets', 'ngoặc hợp lệ'],
    max_depth: ['max depth', 'maximum depth', 'chiều cao cây', 'tree height', 'độ sâu'],
  };

  for (const [algo, kws] of Object.entries(keywords)) {
    for (const kw of kws) {
      if (p.includes(kw)) return algo;
    }
  }
  return null;
}

/**
 * Build test code that runs user function against all test cases.
 */
function buildTestCode(userCode, testConfig) {
  const { testCases, functionName, wrapper } = testConfig;

  const testCalls = testCases.map((tc, i) => {
    const inputStr = JSON.stringify(tc.input);
    const expectedStr = JSON.stringify(tc.expected);
    return `result_${i} = ${functionName}(${typeof tc.input === 'object' && !Array.isArray(tc.input) ? `**${inputStr}` : inputStr})\nprint(f"test_${i}: {result_${i} == ${expectedStr}} — got={result_${i}}, expected={expectedStr}")`;
  }).join('\n');

  return wrapper(userCode).replace('{TEST_CALLS}', testCalls);
}

/**
 * Run user code against test cases.
 * @param {string} userCode — User's code
 * @param {string} algorithm — Algorithm name
 * @param {string} language — Programming language
 * @returns {object} { passed, total, results, allPassed }
 */
export async function runTests(userCode, algorithm, language = 'python') {
  const testConfig = getTestCases(algorithm);
  if (!testConfig) {
    return { passed: 0, total: 0, results: [], allPassed: false, error: 'Unknown algorithm' };
  }

  const testCode = buildTestCode(userCode, testConfig);
  logger.info(`[TestHarness] Running ${testConfig.testCases.length} tests for ${algorithm}`);

  try {
    const result = await executeCode(testCode, language);

    if (!result.success) {
      return {
        passed: 0,
        total: testConfig.testCases.length,
        results: [],
        allPassed: false,
        error: result.error || result.output,
      };
    }

    // Parse results from output
    const output = result.output || '';
    const results = [];
    let passed = 0;

    for (let i = 0; i < testConfig.testCases.length; i++) {
      const line = output.split('\n').find(l => l.includes(`test_${i}:`));
      const testPassed = line?.includes('True') || line?.includes('true');
      if (testPassed) passed++;
      results.push({ test: i, passed: testPassed, output: line || '' });
    }

    return {
      passed,
      total: testConfig.testCases.length,
      results,
      allPassed: passed === testConfig.testCases.length,
    };
  } catch (err) {
    return {
      passed: 0,
      total: testConfig.testCases.length,
      results: [],
      allPassed: false,
      error: err.message,
    };
  }
}
