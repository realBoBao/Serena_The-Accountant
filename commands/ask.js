/**
 * !ask Command — RAG-powered Q&A
 */
import { Command } from './base.js';

export class AskCommand extends Command {
  constructor() {
    super({
      prefix: '!ask',
      description: 'Hỏi đáp AI với RAG (web search + knowledge base)',
      cooldown: 3,
      maxConcurrency: 3,
    });
  }

  async execute(message, args) {
    const { text, flags } = args;
    if (!text) {
      return message.reply({
        content: '🤖 **Serana_Project00** — Hỏi đáp AI\n\n' +
          '**Cách dùng:** `!ask <câu hỏi>`\n' +
          '**Ví dụ:** `!ask Backend là gì?`\n' +
          '**Nâng cao:** `!ask Backend --deep` (tìm kiếm sâu)',
        allowedMentions: { parse: [], repliedUser: false },
      });
    }

    const waitingMsg = await message.reply({
      content: `🤔 Đang tìm kiếm câu trả lời cho: "${text.slice(0, 80)}"...`,
      allowedMentions: { parse: [], repliedUser: false },
    });

    try {
      const { answerQuestion } = await import('../agents/RagAgent.js');
      const result = await answerQuestion(text, {
        biasTopic: flags.topic || null,
        deep: flags.deep || false,
      });

      const sourceIcon = result.source === 'web' ? '🌐' : result.source === 'local' ? '📚' : '🤖';
      const output = `${sourceIcon} **Trả lời:**\n\n${result.answer.slice(0, 1800)}`;

      await waitingMsg.edit({
        content: output,
        allowedMentions: { parse: [] },
      });
    } catch (err) {
      await waitingMsg.edit({
        content: `❌ Lỗi: ${err?.message || err}`,
        allowedMentions: { parse: [] },
      });
    }
  }
}
