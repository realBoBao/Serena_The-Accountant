/**
 * ═══════════════════════════════════════════════════════════════
 * Command Registry — Router cho tất cả Discord commands
 * ═══════════════════════════════════════════════════════════════
 *
 * Nguyên tắc:
 * - Mỗi command là 1 module riêng trong /commands
 * - Registry map prefix → Command instance
 * - Bot chỉ cần gọi registry.handle(message)
 *
 * Để thêm command mới:
 * 1. Tạo file trong /commands (ví dụ: mycommand.js)
 * 2. Export class kế thừa từ Command
 * 3. Thêm vào COMMANDS array bên dưới
 */

import { AskCommand } from './ask.js';
import { DebateCommand } from './debate.js';
import { AnalyzeCommand } from './analyze.js';
import { AuditCommand } from './audit.js';
import { ProfileCommand } from './profile.js';
import { LogsCommand } from './logs.js';

// ── Command Registry ──
const COMMANDS = [
  new AskCommand(),
  new DebateCommand(),
  new AnalyzeCommand(),
  new AuditCommand(),
  new ProfileCommand(),
  new LogsCommand(),
];

// Build prefix → command map
const PREFIX_MAP = new Map();
for (const cmd of COMMANDS) {
  PREFIX_MAP.set(cmd.prefix, cmd);
}

/**
 * Handle a Discord message — find matching command and execute
 * @param {Message} message - Discord.js Message object
 * @returns {boolean} true if a command was handled
 */
export async function handleCommand(message) {
  if (message.author?.bot) return false;

  const content = message.content?.trim() || '';

  // Find matching command
  for (const [prefix, cmd] of PREFIX_MAP) {
    if (cmd.matches(content)) {
      const result = await cmd.run(message);
      if (result?.error && result.message) {
        await message.reply({ content: result.message, allowedMentions: { parse: [], repliedUser: false } });
      }
      return true;
    }
  }

  return false;
}

/**
 * Get help text for all commands
 */
export function getHelpText() {
  const lines = ['📚 **Danh sách lệnh:**', ''];
  for (const cmd of COMMANDS) {
    lines.push(cmd.getHelp());
  }
  lines.push('');
  lines.push('💡 Gõ `!help` để xem hướng dẫn chi tiết.');
  return lines.join('\n');
}

/**
 * Get command by prefix
 */
export function getCommand(prefix) {
  return PREFIX_MAP.get(prefix);
}

/**
 * Get all registered commands
 */
export function getAllCommands() {
  return [...COMMANDS];
}

export { COMMANDS, PREFIX_MAP };
