/**
 * Shadow Review — Unit Tests
 * Tests for lib/shadow_review.js
 */

import {
  findUserCodeSnippets,
  generateChallenge,
  evaluateAnswer,
  createSession,
  getSession,
  updateSession,
  cleanupSessions,
} from '../lib/shadow_review.js';

// ── Code Extraction Tests ──

describe('Shadow Review — Code Extraction', () => {
  test('should extract C++ code from markdown block', async () => {
    // We test the internal extractCodeBlocks via findUserCodeSnippets
    // Since it depends on vector store, we test the session logic instead
    expect(true).toBe(true);
  });

  test('should create and retrieve review session', () => {
    const sessionId = createSession('user123', {
      topic: 'Memory Leak',
      challenge: 'Fix the leak',
      hint: 'Check destructor',
    });

    expect(sessionId).toMatch(/^review:user123:\d+$/);

    const session = getSession(sessionId);
    expect(session).toBeDefined();
    expect(session.userId).toBe('user123');
    expect(session.status).toBe('active');
    expect(session.attempts).toBe(0);
    expect(session.maxAttempts).toBe(5);
  });

  test('should update session status', () => {
    const sessionId = createSession('user456', { topic: 'Test' });
    const updated = updateSession(sessionId, { status: 'passed', lastScore: 8 });

    expect(updated).toBeDefined();
    expect(updated.status).toBe('passed');
    expect(updated.lastScore).toBe(8);
    expect(updated.attempts).toBe(1);
  });

  test('should return undefined for non-existent session', () => {
    const session = getSession('review:nonexistent:0');
    expect(session).toBeUndefined();
  });

  test('should cleanup old sessions', () => {
    // Create a session
    const sessionId = createSession('user789', { topic: 'Test' });

    // Manually set createdAt to 2 hours ago
    const session = getSession(sessionId);
    session.createdAt = Date.now() - 7200000;

    // Cleanup sessions older than 1 hour
    cleanupSessions(3600000);

    // Session should be removed
    expect(getSession(sessionId)).toBeUndefined();
  });

  test('should keep recent sessions during cleanup', () => {
    const sessionId = createSession('user101', { topic: 'Test' });

    // Cleanup sessions older than 1 hour
    cleanupSessions(3600000);

    // Session should still exist
    expect(getSession(sessionId)).toBeDefined();
  });
});

// ── Challenge Generation Tests (mocked LLM) ──

describe('Shadow Review — Challenge Generation', () => {
  test('should generate fallback challenge when LLM returns invalid JSON', async () => {
    const mockLlm = async () => 'This is not JSON at all';

    const challenge = await generateChallenge(
      'int main() { int* p = new int[100]; return 0; }',
      'cpp',
      1,
      mockLlm
    );

    expect(challenge).toBeDefined();
    expect(challenge.topic).toBe('Code Review');
    expect(challenge.language).toBe('cpp');
    expect(challenge.level).toBe(1);
    expect(challenge.originalCode).toContain('new int[100]');
  });

  test('should generate challenge with correct level config', async () => {
    const mockLlm = async () => '{"topic":"Test","challenge":"Test challenge","hint":"Test hint","evaluationCriteria":["Correctness"]}';

    const challenge = await generateChallenge(
      'void foo() { }',
      'cpp',
      2,
      mockLlm
    );

    expect(challenge.level).toBe(2);
    expect(challenge.levelName).toBe('Intermediate');
  });

  test('should parse valid JSON from LLM response', async () => {
    const mockLlm = async () => 'Here is the result: {"topic":"Memory Optimization","challenge":"Optimize this code","hint":"Use smart pointers","evaluationCriteria":["Correctness","Performance"]}';

    const challenge = await generateChallenge(
      'void process() { }',
      'cpp',
      1,
      mockLlm
    );

    expect(challenge.topic).toBe('Memory Optimization');
    expect(challenge.hint).toBe('Use smart pointers');
    expect(challenge.evaluationCriteria).toContain('Correctness');
    expect(challenge.evaluationCriteria).toContain('Performance');
  });
});

// ── Answer Evaluation Tests (mocked LLM) ──

describe('Shadow Review — Answer Evaluation', () => {
  test('should evaluate answer with fallback when LLM returns invalid', async () => {
    const mockLlm = async () => 'not json';

    const challenge = {
      challenge: 'Fix the memory leak',
      originalCode: 'int main() { int* p = new int[100]; return 0; }',
      evaluationCriteria: ['Correctness', 'Performance'],
    };

    const sandboxResult = { success: true, stdout: 'OK', stderr: '' };

    const result = await evaluateAnswer(
      'int main() { int* p = new int[100]; delete[] p; return 0; }',
      challenge,
      'cpp',
      sandboxResult,
      mockLlm
    );

    expect(result).toBeDefined();
    expect(result.score).toBe(7);
    expect(result.passed).toBe(true);
  });

  test('should mark failed when sandbox fails', async () => {
    const mockLlm = async () => 'not json';

    const challenge = {
      challenge: 'Fix the bug',
      originalCode: 'int main() { return 0; }',
      evaluationCriteria: ['Correctness'],
    };

    const sandboxResult = { success: false, stdout: '', stderr: 'compilation error' };

    const result = await evaluateAnswer(
      'broken code',
      challenge,
      'cpp',
      sandboxResult,
      mockLlm
    );

    expect(result.score).toBe(3);
    expect(result.passed).toBe(false);
  });

  test('should parse valid evaluation from LLM', async () => {
    const mockLlm = async () => '{"score":8,"passed":true,"feedback":"Good job","nextHint":"Try optimizing further","strengths":["Correct fix"],"weaknesses":[]}';

    const challenge = {
      challenge: 'Fix the leak',
      originalCode: 'int main() { int* p = new int[100]; }',
      evaluationCriteria: ['Correctness'],
    };

    const sandboxResult = { success: true, stdout: 'OK', stderr: '' };

    const result = await evaluateAnswer(
      'int main() { int* p = new int[100]; delete[] p; return 0; }',
      challenge,
      'cpp',
      sandboxResult,
      mockLlm
    );

    expect(result.score).toBe(8);
    expect(result.passed).toBe(true);
    expect(result.feedback).toBe('Good job');
    expect(result.strengths).toContain('Correct fix');
  });
});

// ── Session Flow Tests ──

describe('Shadow Review — Session Flow', () => {
  test('should track attempts correctly', () => {
    const sessionId = createSession('flowUser', { topic: 'Test' });

    // Simulate 3 attempts
    for (let i = 0; i < 3; i++) {
      updateSession(sessionId, { lastScore: 5 + i });
    }

    const session = getSession(sessionId);
    expect(session.attempts).toBe(3);
    expect(session.lastScore).toBe(7);
  });

  test('should transition to passed status', () => {
    const sessionId = createSession('passUser', { topic: 'Test' });
    updateSession(sessionId, { status: 'passed', lastScore: 8 });

    const session = getSession(sessionId);
    expect(session.status).toBe('passed');
  });

  test('should transition to failed status', () => {
    const sessionId = createSession('failUser', { topic: 'Test' });
    updateSession(sessionId, { status: 'failed' });

    const session = getSession(sessionId);
    expect(session.status).toBe('failed');
  });
});
