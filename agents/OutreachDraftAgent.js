/**
 * agents/OutreachDraftAgent.js — Tier 4: Human-in-the-Loop Outreach Drafting
 *
 * "Who controls the past controls the future."
 *
 * Agent này giúp soạn thảo tin nhắn outreach (LinkedIn/email) cá nhân hóa.
 * User paste JD hoặc recruiter profile → Agent sinh 3 phiên bản.
 * User tự chọn và gửi — KHÔNG automated scraping hay sending.
 *
 * Usage:
 *   import { OutreachDraftAgent } from './OutreachDraftAgent.js';
 *   const agent = new OutreachDraftAgent();
 *   const drafts = await agent.execute(jdText, userId);
 */

import { getLogger } from '../lib/logger.js';

const logger = getLogger('OutreachDraftAgent');

export class OutreachDraftAgent {

  /**
   * Generate 3 phiên bản outreach message
   * @param {string} input — JD text hoặc recruiter profile
   * @param {string} userId — Discord user ID
   * @returns {Promise<string>} — 3 phiên bản message
   */
  async execute(input, userId = 'anonymous') {
    if (!input || input.length < 50) {
      return '❌ Input quá ngắn. Paste ít nhất 1 đoạn JD hoặc recruiter profile.';
    }

    logger.info(`[OutreachDraftAgent] Generating drafts for user ${userId}`);

    // System prompt — Communications Expert persona
    const systemPrompt = `Bạn là chuyên gia viết cold outreach cho software engineer đang xin việc.
Bạn hiểu sâu về ngành công nghệ và biết cách viết tin nhắn cá nhân hóa, không generic.

QUY TẮC:
- KHÔNG dùng "I hope this message finds you well" hay bất kỳ cliché nào
- KHÔNG đề cập đến "passion", "dream company", "synergy"
- Giọng điệu: professional nhưng gần gũi, như engineer nói chuyện với engineer
- Để [COMPANY] và [NAME] placeholder để user điền tay
- Mỗi version dưới 150 từ
- Không dùng emoji quá nhiều (tối đa 1-2)`;

    // User prompt
    const userPrompt = `Viết 3 phiên bản outreach message (LinkedIn connection request hoặc email) cho JD sau:

${input.slice(0, 2000)}

---

**Version A — Concise (dưới 80 từ)**
Thẳng vào vấn đề, không nói vòng vo. Focus vào value proposition.

**Version B — Persuasive (100-150 từ)**
Kể 1 achievement cụ thể liên quan đến JD, đề xuất giá trị rõ ràng. Mention công ty cụ thể.

**Version C — Curious (80-120 từ)**
Đặt câu hỏi thông minh về team/tech stack/dự án, tạo conversation tự nhiên.

Format output:
**A — Concise:**
[nội dung]

**B — Persuasive:**
[nội dung]

**C — Curious:**
[nội dung]`;

    try {
      // Use LLM to generate drafts
      const { ask } = await import('../lib/llm.js');
      const response = await ask(
        `${systemPrompt}\n\n${userPrompt}`,
        { maxTokens: 800, temperature: 0.7 }
      );

      return response;
    } catch (err) {
      logger.error(`[OutreachDraftAgent] LLM failed: ${err.message}`);
      return `❌ Lỗi sinh draft: ${err.message}`;
    }
  }
}

export default OutreachDraftAgent;
