/**
 * ═══════════════════════════════════════════════════════════════
 * Command Base Class — Template cho tất cả Discord commands
 * ═══════════════════════════════════════════════════════════════
 *
 * Mỗi command cần:
 *  - prefix: string (ví dụ: '!ask', '!debate')
 *  - description: string (mô tả cho help)
 *  - execute(message, args): async function
 *
 * Usage:
 *   import { AskCommand } from './commands/ask.js';
 *   const cmd = new AskCommand();
 *   await cmd.execute(message, args);
 */

export class Command {
  constructor({ prefix, description, cooldown = 0, maxConcurrency = 1 }) {
    this.prefix = prefix;
    this.description = description;
    this.cooldown = cooldown; // seconds
    this.maxConcurrency = maxConcurrency;
    this._running = 0;
    this._lastUsed = new Map(); // userId → timestamp
  }

  /** Check if command matches message */
  matches(content) {
    return content.startsWith(this.prefix + ' ') || content === this.prefix;
  }

  /** Parse args from message content */
  parseArgs(content) {
    const withoutPrefix = content.slice(this.prefix.length).trim();
    const parts = withoutPrefix.split(/\s+/);
    const flags = {};
    const positional = [];

    for (let i = 0; i < parts.length; i++) {
      if (parts[i].startsWith('--')) {
        const key = parts[i].slice(2);
        const next = parts[i + 1];
        if (next && !next.startsWith('--')) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      } else {
        positional.push(parts[i]);
      }
    }

    return { text: positional.join(' '), flags, raw: withoutPrefix };
  }

  /** Check cooldown */
  isOnCooldown(userId) {
    if (!this.cooldown) return false;
    const last = this._lastUsed.get(userId) || 0;
    return Date.now() - last < this.cooldown * 1000;
  }

  /** Check concurrency limit */
  isAtCapacity() {
    return this._running >= this.maxConcurrency;
  }

  /** Run command with lifecycle management */
  async run(message) {
    const userId = message.author?.id || 'unknown';

    if (this.isOnCooldown(userId)) {
      return { error: 'cooldown', message: `⏳ Đợi ${this.cooldown}s trước khi dùng lại.` };
    }
    if (this.isAtCapacity()) {
      return { error: 'busy', message: '🔄 Đang xử lý, vui lòng chờ...' };
    }

    this._running++;
    this._lastUsed.set(userId, Date.now());

    try {
      const content = message.content || '';
      const args = this.parseArgs(content);
      const result = await this.execute(message, args);
      return { success: true, result };
    } catch (err) {
      console.error(`[Command:${this.prefix}] Error:`, err.message);
      return { error: 'exception', message: `❌ Lỗi: ${err.message}` };
    } finally {
      this._running--;
    }
  }

  /** Override this in subclasses */
  async execute(message, args) {
    throw new Error('execute() must be implemented');
  }

  /** Help text */
  getHelp() {
    return `**${this.prefix}** — ${this.description}`;
  }
}
