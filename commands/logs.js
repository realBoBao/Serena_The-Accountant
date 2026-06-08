/**
 * !logs Command — Log Analysis
 */
import { Command } from './base.js';

export class LogsCommand extends Command {
  constructor() {
    super({ prefix: '!logs', description: 'Phân tích logs', cooldown: 3, maxConcurrency: 2 });
  }

  async execute(message, args) {
    const { text } = args;
    if (!text) {
      return message.reply({ content: '📋 **Log Analyzer**\n\n**Cách dùng:** `!logs <log text>`\n**Ví dụ:** `!logs ERROR: connection failed at 2024-01-01`', allowedMentions: { parse: [], repliedUser: false } });
    }

    const waitingMsg = await message.reply({ content: '📋 **Log Analyzer** đang phân tích...', allowedMentions: { parse: [], repliedUser: false } });

    try {
      const { analyzeLog } = await import('../lib/log_analyzer.js');
      const analysis = analyzeLog(text);
      const topErrors = analysis.topErrors.slice(0, 3).map(e => `• (${e.count}x) ${e.pattern.slice(0, 80)}`).join('\n');
      const anomalies = analysis.anomalies.slice(0, 3).map(a => `• [${a.severity}] ${a.message.slice(0, 80)}`).join('\n');
      const output = `📋 **Log Analysis Report**\n\n📊 **Health:** ${analysis.healthScore}/100 (${analysis.rating})\n📈 **Lines:** ${analysis.totalLines} | **Errors:** ${analysis.errorCount} | **Warnings:** ${analysis.warningCount}\n\n🔴 **Top Errors:**\n${topErrors || '✅ None'}\n\n⚠️ **Anomalies:**\n${anomalies || '✅ None'}`;
      await waitingMsg.edit({ content: output.slice(0, 1900), allowedMentions: { parse: [] } });
    } catch (err) {
      await waitingMsg.edit({ content: `❌ Log analysis lỗi: ${err?.message || err}`, allowedMentions: { parse: [] } });
    }
  }
}
