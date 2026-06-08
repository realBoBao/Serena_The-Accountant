/**
 * !profile Command — Performance Profiling
 */
import { Command } from './base.js';

export class ProfileCommand extends Command {
  constructor() {
    super({ prefix: '!profile', description: 'Phân tích performance code', cooldown: 5, maxConcurrency: 2 });
  }

  async execute(message, args) {
    const { text } = args;
    if (!text) {
      return message.reply({ content: '⚡ **Performance Profiler**\n\n**Cách dùng:** `!profile <code>`\n**Ví dụ:** `!profile for(let i=0;i<arr.length;i++) arr[i]++`', allowedMentions: { parse: [], repliedUser: false } });
    }

    const langMatch = text.match(/^```(\w+)?\n([\s\S]*?)```$/);
    const lang = langMatch ? (langMatch[1] || 'javascript') : 'javascript';
    const cleanCode = langMatch ? langMatch[2].trim() : text;

    const waitingMsg = await message.reply({ content: '⚡ **Performance Profiler** đang phân tích...', allowedMentions: { parse: [], repliedUser: false } });

    try {
      const { analyzePerformance, getSystemMetrics } = await import('../lib/performance_profiler.js');
      const perf = analyzePerformance(cleanCode, lang);
      const sys = getSystemMetrics();
      const issuesList = perf.issues.slice(0, 5).map(i => `• [${i.severity}] ${i.type}: ${i.message.slice(0, 80)}`).join('\n');
      const output = `⚡ **Performance Report**\n\n🔧 **Issues (${perf.issues.length}):**\n${issuesList || '✅ No issues'}\n\n💡 **Recommendations:**\n${perf.recommendations.slice(0, 3).map(r => `• ${r}`).join('\n')}\n\n🖥️ **System:** CPU ${sys.cpu.usage}% | RAM ${sys.memory.usage}% | ${sys.cpu.cores} cores`;
      await waitingMsg.edit({ content: output.slice(0, 1900), allowedMentions: { parse: [] } });
    } catch (err) {
      await waitingMsg.edit({ content: `❌ Profile lỗi: ${err?.message || err}`, allowedMentions: { parse: [] } });
    }
  }
}
