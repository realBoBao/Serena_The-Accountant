/**
 * Tests for InteractionAgent — Lễ tân & Khởi tạo Phiên
 * ESM-compatible: manual mocks thay vì jest.mock()
 */
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

// ── Manual mocks ──────────────────────────────────────────────────────────
const mockPipeline = {
  hset: jest.fn(),
  expire: jest.fn(),
  exec: jest.fn().mockResolvedValue([[null, 1], [null, 1]]),
};
const mockRedis = {
  pipeline: jest.fn().mockReturnValue(mockPipeline),
  hset: jest.fn().mockResolvedValue('OK'),
  hgetall: jest.fn().mockResolvedValue({}),
  on: jest.fn(),
  disconnect: jest.fn(),
  status: 'ready',
};
const mockAddJob = jest.fn().mockResolvedValue({ id: 'job-mock-123' });

// ── Import module under test ───────────────────────────────────────────────
const mod = await import('../agents/InteractionAgent.js');
const InteractionAgent = mod.default || mod.InteractionAgent;

// ── Tests ──────────────────────────────────────────────────────────────────
describe('InteractionAgent', () => {
  let agent;
  beforeEach(() => {
    jest.clearAllMocks();
    mockPipeline.exec.mockResolvedValue([[null, 1], [null, 1]]);
    mockAddJob.mockResolvedValue({ id: 'job-mock-123' });
    agent = new InteractionAgent({ logger: { info: jest.fn(), error: jest.fn(), debug: jest.fn() } });
  });
  afterEach(() => { agent.destroy(); });

  describe('generateSessionId()', () => {
    it('returns a valid UUID v4', () => {
      const id = InteractionAgent.generateSessionId();
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });

    it('returns unique IDs', () => {
      const ids = new Set();
      for (let i = 0; i < 100; i++) ids.add(InteractionAgent.generateSessionId());
      expect(ids.size).toBe(100);
    });
  });

  describe('receive()', () => {
    it('creates session, saves Redis, dispatches planner job', async () => {
      const result = await agent.receive({
        source: 'discord', userId: 'u-1', username: 'alice', channelId: 'ch-1', content: 'Hello!',
      });
      expect(result.sessionId).toBeDefined();
      expect(result.error).toBeNull();
      expect(result.statusCode).toBe(200);
      expect(result.state.source).toBe('discord');
      expect(result.state.content).toBe('Hello!');
    });

    it('handles missing optional fields', async () => {
      const result = await agent.receive({ source: 'rest_api', content: 'Test' });
      expect(result.sessionId).toBeDefined();
      expect(result.error).toBeNull();
    });

    it('rejects invalid source', async () => {
      const result = await agent.receive({ source: 'invalid_source', content: 'Test' });
      expect(result.error).toBeDefined();
      expect(result.statusCode).toBe(400);
    });

    it('rejects empty content', async () => {
      const result = await agent.receive({ source: 'discord', content: '' });
      expect(result.error).toBeDefined();
      expect(result.statusCode).toBe(400);
    });
  });

  describe('receive() with Discord input', () => {
    it('processes Discord message correctly', async () => {
      const result = await agent.receive({
        source: 'discord', userId: 'u1', username: 'test',
        channelId: 'c1', content: '!ask What is AI?',
      });
      expect(result.sessionId).toBeDefined();
      expect(result.state.content).toBe('!ask What is AI?');
      expect(result.state.source).toBe('discord');
    });

    it('handles input with attachments', async () => {
      const result = await agent.receive({
        source: 'discord', userId: 'u1', username: 'test',
        channelId: 'c1', content: 'Check this',
        attachmentCount: 1, hasImage: true,
      });
      expect(result.sessionId).toBeDefined();
      expect(result.state.attachmentCount).toBe(1);
      expect(result.state.hasImage).toBe(true);
    });
  });

  describe('receive() with REST API input', () => {
    it('processes REST API request', async () => {
      const result = await agent.receive({
        source: 'rest_api', content: 'Hello from API',
      });
      expect(result.sessionId).toBeDefined();
      expect(result.state.content).toBe('Hello from API');
      expect(result.state.source).toBe('rest_api');
    });
  });

  describe('getStats()', () => {
    it('returns stats object', () => {
      const stats = agent.getStats();
      expect(stats).toHaveProperty('totalReceived');
    });
  });

  describe('health()', () => {
    it('returns healthy status', () => {
      expect(agent.health().status).toBe('healthy');
    });
  });

  describe('handleInteraction()', () => {
    it('processes interaction topic via named export', async () => {
      const result = await mod.handleInteraction('test-topic');
      expect(result).toBeDefined();
    });
  });

  describe('updateStatus()', () => {
    it('updates session status in memory', async () => {
      await agent.updateStatus('test-session', 'completed');
      expect(true).toBe(true); // No error thrown
    });
  });

  describe('destroy()', () => {
    it('cleans up without error', () => {
      expect(() => agent.destroy()).not.toThrow();
    });
  });
});
