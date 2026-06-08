/**
 * !analyze Command — Code Quality Analysis
 */
import { Command } from './base.js';

export class AnalyzeCommand extends Command {
  constructor() {
    super({ prefix: '!analyze', description: 'Phân tích chất lượng code', cooldown: 5, maxConcurrency: 2 });
  }

  async execute(message, args) {
    const { text } = args;
    if (!text) {
      return message.reply({ content: '🔍 **Code Analyzer**\n\n**Cách dùng:** `!analyze <code>`\n**Ví dụ:** `!analyze function foo() { return 1; }`', allowedMentions: { parse: [], repliedUser: false } });
    }

    const langMatch = text.match(/^```(\w+)?\n([\s\S]*?)```$/);
    const lang = langMatch ? (langMatch[1] || 'javascript') : 'javascript';
    const cleanCode = langMatch ? langMatch[2].trim() : text;

    const waitingMsg = await message.reply({ content: '🔍 **Code Analyzer** đang phân tích...', allowedMentions: { parse: [], repliedUser: false } });

    try {
      const { getQualityReport } = await import('../lib/code_analyzer.js');
      const report = getQualityReport(cleanCode, lang);
      const issuesList = report.antiPatterns.slice(0, 5).map(ap => `• [${ap.severity.toUpperCase()}] ${ap.name}: ${ap.message.slice(0, 80)}`).join('\n');
      const output = `🔍 **Code Analysis Report**\n\n📊 **Score:** ${report.score}/100 (Grade ${report.grade})\n📈 **Complexity:** ${report.complexity.cyclomatic} (Grade ${report.complexity.rating})\n📏 **Lines:** ${report.complexity.linesOfCode} | **Comments:** ${report.complexity.commentRatio}%\n\n⚠️ **Issues (${report.antiPatterns.length}):**\n${issuesList || '✅ No issues found'}\n\n💡 **Recommendations:**\n${report.recommendations.slice(0, 3).map(r => `• ${r}`).join('\n')}`;
      await waitingMsg.edit({ content: output.slice(0, 1900), allowedMentions: { parse: [] } });
    } catch (err) {
      await waitingMsg.edit({ content: `❌ Analyzer lỗi: ${err?.message || err}`, allowedMentions: { parse: [] } });
    }
  }
}
