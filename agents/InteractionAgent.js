/**
 * InteractionAgent — Handles interactive Discord interactions
 * Manages button clicks, modals, select menus from Discord messages.
 * @module agents/InteractionAgent
 */

import { getLogger } from '../lib/logger.js';
const logger = getLogger('InteractionAgent');

const sessions = new Map();

/**
 * Create an interaction session.
 */
export function createSession(sessionId, data = {}) {
  sessions.set(sessionId, { ...data, createdAt: Date.now() });
  return sessionId;
}

/**
 * Get an interaction session.
 */
export function getSession(sessionId) {
  return sessions.get(sessionId);
}

/**
 * Update an interaction session.
 */
export function updateSession(sessionId, data) {
  const existing = sessions.get(sessionId) || {};
  sessions.set(sessionId, { ...existing, ...data, updatedAt: Date.now() });
}

/**
 * Delete an interaction session.
 */
export function deleteSession(sessionId) {
  sessions.delete(sessionId);
}

/**
 * Handle an interaction event.
 */
export async function handleInteraction(interaction) {
  try {
    if (!interaction || typeof interaction !== 'object') return { handled: false };
    logger.info('[InteractionAgent] Handling interaction:', interaction.type);
    const { customId } = interaction;
    if (!customId) return { handled: false };

    // Route by customId prefix
    if (customId.startsWith('quiz_')) {
      return { handled: true, type: 'quiz', action: 'answer' };
    }
    if (customId.startsWith('debate_')) {
      return { handled: true, type: 'debate', action: 'vote' };
    }
    if (customId.startsWith('flashcard_')) {
      return { handled: true, type: 'flashcard', action: 'review' };
    }

    return { handled: false };
  } catch (err) {
    logger.error('[InteractionAgent] handleInteraction failed:', err.message);
    return { handled: false, error: err.message };
  }
}

export default { createSession, getSession, updateSession, deleteSession, handleInteraction };
