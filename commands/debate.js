/**
 * !debate Command — Multi-Agent Debate
 */
import { Command } from './base.js';

export class DebateCommand extends Command {
  constructor() {
    super({
      prefix: '!debate',
      description: 'Tranh luận đa tác nhân (Coder A vs Coder B → Judge)',
      cooldown: 30,
      maxConcurrency: 1,
    });
  }

  async execute(message, args) {
    const { text, flags } = args;
    if (!text) {
      return message.reply({
        content: '🏛️ **Debate Agent** — Tranh luận đa tác nhân\n\n' +
          '**Cách dùng:** `!debate <bài toán>`\n' +
          '**Nâng cao:** `!debate <bài toán> --quick` (1 vòng, không sandbox)',
        allowedMentions: { parse: [], repliedUser: false },
      });
    }

    const isQuick = flags.quick;
    const cleanText = text.replace(/\s*--quick\s*/g, '').trim();

    const waitingMsg = await message.reply({
      content: `🏛️ **Debate Agent** đang bắt đầu...\n📝 "${cleanText.slice(0, 80)}"\n⚡ Mode: ${isQuick ? 'Quick' : 'Full (3 vòng + sandbox)'}\n⏳ Vui lòng chờ 1-3 phút...`,
      allowedMentions: { parse: [], repliedUser: false },
    });

    try {
      const { runDebate, quickDebate } = await import('../agents/DebateAgent.js');
      const result = isQuick ? await quickDebate(cleanText) : await runDebate(cleanText);

      const s = result.summary;
      const metricsTable =
        `📊 **Metrics từ Sandbox:**\n` +
        `| | Coder A (Đúng đắn) | Coder B (Hiệu suất) |\n` +
        `|---|---|---|\n` +
        `| Latency | ${s.coderA.avgLatencyMs}ms | ${s.coderB.avgLatencyMs}ms |\n` +
        `| Memory | ${s.coderA.avgMemoryKb}KB | ${s.coderB.avgMemoryKb}KB |\n` +
        `| Success | ${s.coderA.successRate} | ${s.coderB.successRate} |\n\n`;

      const output = `🏛️ **Debate Agent — Kết quả** (${s.totalTimeMs}ms)\n\n` +
        metricsTable +
        `⚖️ **Phán quyết của Toà Án:**\n\n${result.finalSolution.slice(0, 1500)}`;

      await waitingMsg.edit({ content: output.slice(0, 1900), allowedMentions: { parse: [] } });
    } catch (err) {
      await waitingMsg.edit({ content: `❌ Debate lỗi: ${err?.message || err}`, allowedMentions: { parse: [] } });
    }
  }
}
