/**
 * !audit Command — Security Audit
 */
import { Command } from './base.js';

export class AuditCommand extends Command {
  constructor() {
    super({ prefix: '!audit', description: 'Quét bảo mật code', cooldown: 5, maxConcurrency: 2 });
  }

  async execute(message, args) {
    const { text } = args;
    if (!text) {
      return message.reply({ content: '🔒 **Security Auditor**\n\n**Cách dùng:** `!audit <code>`\n**Ví dụ:** `!audit const password = "abc123"`', allowedMentions: { parse: [], repliedUser: false } });
    }

    const langMatch = text.match(/^```(\w+)?\n([\s\S]*?)```$/);
    const lang = langMatch ? (langMatch[1] || 'javascript') : 'javascript';
    const cleanCode = langMatch ? langMatch[2].trim() : text;

    const waitingMsg = await message.reply({ content: '🔒 **Security Auditor** đang quét...', allowedMentions: { parse: [], repliedUser: false } });

    try {
      const { auditCode } = await import('../lib/security_auditor.js');
      const report = await auditCode(cleanCode, lang, { useLlm: false });
      const vulnsList = report.vulnerabilities.slice(0, 5).map(v => `• [${v.severity.toUpperCase()}] ${v.type} (line ${v.line}): ${v.message.slice(0, 80)}`).join('\n');
      const secretsList = report.secrets.slice(0, 3).map(s => `• [${s.severity.toUpperCase()}] ${s.type} (line ${s.line}): ${s.match}`).join('\n');
      const output = `🔒 **Security Audit Report**\n\n🛡️ **Score:** ${report.score}/100 | **Risk:** ${report.riskLevel.toUpperCase()}\n\n🔑 **Secrets (${report.secrets.length}):**\n${secretsList || '✅ None found'}\n\n🐛 **Vulnerabilities (${report.vulnerabilities.length}):**\n${vulnsList || '✅ None found'}`;
      await waitingMsg.edit({ content: output.slice(0, 1900), allowedMentions: { parse: [] } });
    } catch (err) {
      await waitingMsg.edit({ content: `❌ Audit lỗi: ${err?.message || err}`, allowedMentions: { parse: [] } });
    }
  }
}
