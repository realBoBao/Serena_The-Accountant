import { describe, it, expect } from '@jest/globals';

describe('Discord Bot - Intent Classification', () => {
  // Replicate the classifyIntent function for testing
  const INTENT_KEYWORDS = {
    CODE: ['!run', 'chạy code', 'run code', 'execute', 'biên dịch', 'compile', 'sandbox'],
    MEMORY: ['!memory', '!mem', 'lưu trí nhớ', 'ghi nhớ', 'nhớ đi', 'lưu lại', 'trí nhớ'],
    RAG: ['!ask', 'tìm kiếm', 'search', 'hỏi', 'giải thích', 'là gì', 'như thế nào'],
  };

  function classifyIntent(text) {
    const lower = text.toLowerCase();

    if (lower.startsWith('!run ')) return 'CODE';
    if (lower.startsWith('!memory ') || lower.startsWith('!mem ')) return 'MEMORY';
    if (lower.startsWith('!ask ')) return 'RAG';

    for (const [intent, keywords] of Object.entries(INTENT_KEYWORDS)) {
      for (const kw of keywords) {
        if (lower.includes(kw)) return intent;
      }
    }

    return 'RAG';
  }

  describe('Explicit Commands', () => {
    it('should classify !run as CODE', () => {
      expect(classifyIntent('!run print("hello")')).toBe('CODE');
    });

    it('should classify !memory as MEMORY', () => {
      expect(classifyIntent('!memory I learned about Docker today')).toBe('MEMORY');
    });

    it('should classify !mem as MEMORY', () => {
      expect(classifyIntent('!mem remember this')).toBe('MEMORY');
    });

    it('should classify !ask as RAG', () => {
      expect(classifyIntent('!ask What is RAG?')).toBe('RAG');
    });
  });

  describe('Keyword Detection', () => {
    it('should classify "chạy code" as CODE', () => {
      expect(classifyIntent('chạy code này đi')).toBe('CODE');
    });

    it('should classify "compile" as CODE', () => {
      expect(classifyIntent('compile this for me')).toBe('CODE');
    });

    it('should classify "lưu trí nhớ" as MEMORY', () => {
      expect(classifyIntent('lưu trí nhớ đi')).toBe('MEMORY');
    });

    it('should classify "tìm kiếm" as RAG', () => {
      expect(classifyIntent('tìm kiếm về Docker')).toBe('RAG');
    });

    it('should classify "là gì" as RAG', () => {
      expect(classifyIntent('Docker là gì?')).toBe('RAG');
    });
  });

  describe('Default Behavior', () => {
    it('should default to RAG for unknown text', () => {
      expect(classifyIntent('random text here')).toBe('RAG');
    });

    it('should default to RAG for empty-ish text', () => {
      expect(classifyIntent('hello')).toBe('RAG');
    });
  });
});

describe('Discord Bot - Message Truncation', () => {
  const maxDiscordMessageLength = 1900;

  function truncateForDiscord(value, maxLength = maxDiscordMessageLength) {
    const text = String(value ?? '').trim();
    if (text.length <= maxLength) return text;
    return `${text.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
  }

  it('should not truncate short messages', () => {
    const msg = 'Hello, World!';
    expect(truncateForDiscord(msg)).toBe(msg);
  });

  it('should truncate long messages', () => {
    const longMsg = 'a'.repeat(2000);
    const result = truncateForDiscord(longMsg);
    expect(result.length).toBeLessThanOrEqual(maxDiscordMessageLength);
    expect(result.endsWith('...')).toBe(true);
  });

  it('should handle null/undefined', () => {
    expect(truncateForDiscord(null)).toBe('');
    expect(truncateForDiscord(undefined)).toBe('');
  });

  it('should handle exact boundary', () => {
    const exactMsg = 'a'.repeat(maxDiscordMessageLength);
    expect(truncateForDiscord(exactMsg)).toBe(exactMsg);
  });
});
