/**
 * Tests for InteractionAgent — Discord interaction session management
 * Tests plain function exports from agents/InteractionAgent.js
 */
import { describe, it, expect } from '@jest/globals';
import {
  createSession,
  getSession,
  updateSession,
  deleteSession,
  handleInteraction,
} from '../agents/InteractionAgent.js';

describe('InteractionAgent — Session Management', () => {
  it('should create and retrieve a session', () => {
    const id = 'test-session-1';
    createSession(id, { userId: 'u-1', source: 'discord' });

    const session = getSession(id);
    expect(session).toBeDefined();
    expect(session.userId).toBe('u-1');
    expect(session.source).toBe('discord');
    expect(session.createdAt).toBeDefined();

    // Cleanup
    deleteSession(id);
  });

  it('should return undefined for missing session', () => {
    expect(getSession('nonexistent')).toBeUndefined();
  });

  it('should update a session', () => {
    const id = 'test-session-2';
    createSession(id, { userId: 'u-2' });

    updateSession(id, { status: 'active', content: 'Hello' });

    const session = getSession(id);
    expect(session.userId).toBe('u-2');
    expect(session.status).toBe('active');
    expect(session.content).toBe('Hello');
    expect(session.updatedAt).toBeDefined();

    deleteSession(id);
  });

  it('should delete a session', () => {
    const id = 'test-session-3';
    createSession(id, {});
    deleteSession(id);

    expect(getSession(id)).toBeUndefined();
  });

  it('should create session with empty data', () => {
    const id = 'test-session-4';
    const result = createSession(id);

    expect(result).toBe(id);
    const session = getSession(id);
    expect(session).toBeDefined();
    expect(session.createdAt).toBeDefined();

    deleteSession(id);
  });
});

describe('InteractionAgent — handleInteraction', () => {
  it('should handle quiz interaction', async () => {
    const result = await handleInteraction({ customId: 'quiz_answer_1', type: 3 });
    expect(result.handled).toBe(true);
    expect(result.type).toBe('quiz');
  });

  it('should handle debate interaction', async () => {
    const result = await handleInteraction({ customId: 'debate_vote_pro', type: 3 });
    expect(result.handled).toBe(true);
    expect(result.type).toBe('debate');
  });

  it('should handle flashcard interaction', async () => {
    const result = await handleInteraction({ customId: 'flashcard_review_1', type: 3 });
    expect(result.handled).toBe(true);
    expect(result.type).toBe('flashcard');
  });

  it('should return unhandled for unknown customId', async () => {
    const result = await handleInteraction({ customId: 'unknown_action', type: 3 });
    expect(result.handled).toBe(false);
  });

  it('should return unhandled for missing customId', async () => {
    const result = await handleInteraction({ type: 3 });
    expect(result.handled).toBe(false);
  });

  it('should handle null interaction gracefully', async () => {
    const result = await handleInteraction(null);
    expect(result.handled).toBe(false);
  });

  it('should handle non-object interaction gracefully', async () => {
    const result = await handleInteraction('string');
    expect(result.handled).toBe(false);
  });
});
