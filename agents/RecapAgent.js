/**
 * RecapAgent — Daily learning recap and summary generator
 *
 * Generates summaries of learning sessions:
 * - Text recap of topics discussed
 * - Key takeaways and action items
 * - Spaced repetition reminders
 *
 * Usage:
 *   import { RecapAgent } from './RecapAgent.js';
 *   const recap = await RecapAgent.generateRecap(userId, chatHistory);
 *
 * @module agents/RecapAgent.js
 */

import { invokeLlm } from '../lib/llm.js';
import { HumanMessage } from '@langchain/core/messages';
import { getLogger } from '../lib/logger.js';

const logger = getLogger('RecapAgent');

const RECAP_SYSTEM_PROMPT = `You are a learning assistant that creates concise, actionable recaps of study sessions.

## Your Job

Given a chat history or list of topics discussed, create a structured recap that helps the user remember and review.

## Output Format

# 📚 Learning Recap — [Date]

## 🎯 Topics Covered
- [Topic 1]: [1-line summary]
- [Topic 2]: [1-line summary]

## 💡 Key Takeaways
1. [Most important insight]
2. [Second insight]
3. [Third insight]

## 📝 Action Items
- [ ] [Specific thing to review/practice]
- [ ] [Another action item]

## 🔗 Related Topics to Explore
- [Topic A] → [why it's related]
- [Topic B] → [why it's related]

Keep it concise (max 1900 chars for Discord). Use emojis for readability.`;

/**
 * Generate a recap from chat history
 * @param {string} userId - User ID
 * @param {Array} chatHistory - Array of { role, content } messages
 * @param {object} options - { format: 'text' | 'embed', maxLength: number }
 * @returns {string} - Formatted recap
 */
export async function generateRecap(userId, chatHistory = [], options = {}) {
  const { format = 'text', maxLength = 1900 } = options;

  logger.info(`[RecapAgent] Generating recap for user ${userId}, ${chatHistory.length} messages`);

  if (!chatHistory.length) {
    return '📚 **Learning Recap**\n\nNo chat history found for today. Start learning with `!ask` to build your recap!';
  }

  // Build context from chat history (last 50 messages)
  const recentMessages = chatHistory.slice(-50);
  const context = recentMessages
    .map(m => `${m.role === 'user' ? '👤 User' : '🤖 AI'}: ${m.content?.slice(0, 200) || ''}`)
    .join('\n');

  const today = new Date().toLocaleDateString('vi-VN', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  const prompt = new HumanMessage(
    `Create a learning recap based on this chat session:\n\n${context}\n\nFormat the recap for Discord (use emojis, markdown). Keep it under ${maxLength} characters. Date: ${today}`
  );

  try {
    const recap = await invokeLlm(
      [new HumanMessage(RECAP_SYSTEM_PROMPT), prompt],
      'RecapAgent'
    );

    return recap.slice(0, maxLength);
  } catch (err) {
    logger.error('[RecapAgent] Failed to generate recap:', err.message);
    return '❌ Failed to generate recap. Please try again later.';
  }
}

/**
 * Generate a quick summary of a specific topic
 * @param {string} topic - Topic to summarize
 * @returns {string} - Summary
 */
export async function summarizeTopic(topic) {
  const prompt = new HumanMessage(
    `Summarize the key points about "${topic}" in 3-5 bullet points. Keep it concise and actionable.`
  );

  try {
    return await invokeLlm(
      [new HumanMessage(RECAP_SYSTEM_PROMPT), prompt],
      'RecapAgent'
    );
  } catch (err) {
    logger.error('[RecapAgent] Failed to summarize topic:', err.message);
    return `❌ Failed to summarize "${topic}".`;
  }
}

export default { generateRecap, summarizeTopic };
