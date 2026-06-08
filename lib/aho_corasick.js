/**
 * Aho-Corasick Algorithm — Multi-pattern string matching
 *
 * Xây dựng Trie + Failure Links (Automaton) để quét HÀNG CHỤC NGÀN
 * pattern trên hàng triệu dòng text trong O(N + M + Z) với:
 *   N = độ dài text
 *   M = tổng độ dài patterns
 *   Z = số matches
 *
 * Ứng dụng:
 * - Security Auditor: quét secrets, API keys, passwords trong code
 * - Log Analyzer: quét error patterns, attack signatures
 * - Content Filter: quét spam, toxic keywords
 *
 * So với Regex loop: O(N * K) với K = số patterns
 * Aho-Corasick: O(N + M + Z) — KHÔNG phụ thuộc số patterns!
 */

import { getLogger } from './logger.js';

const logger = getLogger('AhoCorasick');

// ── Trie Node ──
class ACNode {
  constructor() {
    this.children = new Map();    // char → ACNode
    this.fail = null;             // failure link
    this.output = [];             // patterns ending at this node
    this.depth = 0;
  }
}

// ── Aho-Corasick Automaton ──
class AhoCorasickAutomaton {
  constructor() {
    this.root = new ACNode();
    this._built = false;
    this._patternCount = 0;
  }

  /**
   * Thêm pattern vào Trie.
   * @param {string} pattern - Pattern cần match
   * @param {object} metadata - Metadata kèm theo (VD: severity, category)
   */
  addPattern(pattern, metadata = {}) {
    if (!pattern || pattern.length === 0) return;
    this._built = false;

    let node = this.root;
    for (const ch of pattern) {
      if (!node.children.has(ch)) {
        const child = new ACNode();
        child.depth = node.depth + 1;
        node.children.set(ch, child);
      }
      node = node.children.get(ch);
    }
    node.output.push({ pattern, ...metadata });
    this._patternCount++;
  }

  /**
   * Thêm nhiều patterns cùng lúc.
   * @param {Array<{pattern, metadata}>} patterns
   */
  addPatterns(patterns) {
    for (const p of patterns) {
      if (typeof p === 'string') {
        this.addPattern(p);
      } else {
        this.addPattern(p.pattern, p.metadata || {});
      }
    }
  }

  /**
   * Xây dựng Failure Links bằng BFS.
   * Phải gọi trước khi search.
   */
  build() {
    if (this._built) return;

    const queue = [];

    // Bước 1: Children của root → fail = root
    for (const [ch, child] of this.root.children) {
      child.fail = this.root;
      queue.push(child);
    }

    // Bước 2: BFS xây failure links
    while (queue.length > 0) {
      const current = queue.shift();

      for (const [ch, child] of current.children) {
        queue.push(child);

        // Tìn failure link
        let failNode = current.fail;
        while (failNode !== null && !failNode.children.has(ch)) {
          failNode = failNode.fail;
        }

        child.fail = failNode ? failNode.children.get(ch) : this.root;
        if (child.fail === child) child.fail = this.root;

        // Merge output từ fail link (dictionary suffix links)
        if (child.fail && child.fail.output.length > 0) {
          child.output = [...child.output, ...child.fail.output];
        }
      }
    }

    this._built = true;
    logger.info(`[AhoCorasick] Built automaton with ${this._patternCount} patterns`);
  }

  /**
   * Tìm tất cả matches trong text.
   * @param {string} text - Text cần quét
   * @returns {Array<{pattern, position, metadata}>}
   */
  search(text) {
    if (!this._built) this.build();

    const results = [];
    let current = this.root;

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];

      // Follow failure links cho đến khi tìm được transition
      while (current !== this.root && !current.children.has(ch)) {
        current = current.fail;
      }

      if (current.children.has(ch)) {
        current = current.children.get(ch);
      }

      // Collect all matches tại vị trí này
      if (current.output.length > 0) {
        for (const match of current.output) {
          results.push({
            pattern: match.pattern,
            position: i - match.pattern.length + 1,
            endPosition: i,
            ...match,
          });
        }
      }
    }

    return results;
  }

  /**
   * Quét và trả về summary (deduplicated by pattern).
   */
  searchSummary(text) {
    const matches = this.search(text);
    const summary = new Map();

    for (const m of matches) {
      if (!summary.has(m.pattern)) {
        summary.set(m.pattern, { ...m, count: 0, positions: [] });
      }
      const entry = summary.get(m.pattern);
      entry.count++;
      if (entry.positions.length < 5) entry.positions.push(m.position);
    }

    return Array.from(summary.values());
  }

  get patternCount() {
    return this._patternCount;
  }
}

// ── Pre-built Security Patterns ──

/**
 * Tạo AhoCorasick với các security patterns phổ biến.
 * Quét secrets, API keys, passwords trong code.
 */
export function createSecurityScanner() {
  const ac = new AhoCorasickAutomaton();

  // Secrets & API Keys
  ac.addPatterns([
    { pattern: 'API_KEY', metadata: { severity: 'CRITICAL', category: 'secret' } },
    { pattern: 'api_key', metadata: { severity: 'CRITICAL', category: 'secret' } },
    { pattern: 'apiSecret', metadata: { severity: 'CRITICAL', category: 'secret' } },
    { pattern: 'api_secret', metadata: { severity: 'CRITICAL', category: 'secret' } },
    { pattern: 'accessToken', metadata: { severity: 'CRITICAL', category: 'secret' } },
    { pattern: 'access_token', metadata: { severity: 'CRITICAL', category: 'secret' } },
    { pattern: 'private_key', metadata: { severity: 'CRITICAL', category: 'secret' } },
    { pattern: 'privateKey', metadata: { severity: 'CRITICAL', category: 'secret' } },
    { pattern: 'secret_key', metadata: { severity: 'CRITICAL', category: 'secret' } },
    { pattern: 'secretKey', metadata: { severity: 'CRITICAL', category: 'secret' } },
    { pattern: 'password', metadata: { severity: 'HIGH', category: 'secret' } },
    { pattern: 'passwd', metadata: { severity: 'HIGH', category: 'secret' } },
    { pattern: 'pwd', metadata: { severity: 'MEDIUM', category: 'secret' } },
    { pattern: 'connection_string', metadata: { severity: 'CRITICAL', category: 'secret' } },
    { pattern: 'connectionString', metadata: { severity: 'CRITICAL', category: 'secret' } },
    { pattern: 'jdbc:', metadata: { severity: 'HIGH', category: 'secret' } },
    { pattern: 'mongodb://', metadata: { severity: 'HIGH', category: 'secret' } },
    { pattern: 'postgres://', metadata: { severity: 'HIGH', category: 'secret' } },
    { pattern: 'mysql://', metadata: { severity: 'HIGH', category: 'secret' } },
    { pattern: 'redis://', metadata: { severity: 'HIGH', category: 'secret' } },
    { pattern: 'BEGIN RSA PRIVATE KEY', metadata: { severity: 'CRITICAL', category: 'secret' } },
    { pattern: 'BEGIN OPENSSH PRIVATE KEY', metadata: { severity: 'CRITICAL', category: 'secret' } },
    { pattern: 'AKIA', metadata: { severity: 'CRITICAL', category: 'aws_key' } },  // AWS Access Key
    { pattern: 'ghp_', metadata: { severity: 'CRITICAL', category: 'github_token' } },  // GitHub PAT
    { pattern: 'xoxb-', metadata: { severity: 'CRITICAL', category: 'slack_token' } },  // Slack Bot Token
  ]);

  // Dangerous functions (C/C++)
  ac.addPatterns([
    { pattern: 'strcpy', metadata: { severity: 'HIGH', category: 'unsafe_function', lang: 'c' } },
    { pattern: 'strcat', metadata: { severity: 'HIGH', category: 'unsafe_function', lang: 'c' } },
    { pattern: 'sprintf', metadata: { severity: 'HIGH', category: 'unsafe_function', lang: 'c' } },
    { pattern: 'gets', metadata: { severity: 'CRITICAL', category: 'unsafe_function', lang: 'c' } },
    { pattern: 'scanf', metadata: { severity: 'MEDIUM', category: 'unsafe_function', lang: 'c' } },
    { pattern: 'system(', metadata: { severity: 'HIGH', category: 'command_injection', lang: 'c' } },
    { pattern: 'exec(', metadata: { severity: 'HIGH', category: 'command_injection', lang: 'c' } },
    { pattern: 'eval(', metadata: { severity: 'HIGH', category: 'code_injection', lang: 'js' } },
    { pattern: 'innerHTML', metadata: { severity: 'MEDIUM', category: 'xss', lang: 'js' } },
  ]);

  // SQL Injection patterns
  ac.addPatterns([
    { pattern: 'DROP TABLE', metadata: { severity: 'CRITICAL', category: 'sql_injection' } },
    { pattern: 'UNION SELECT', metadata: { severity: 'CRITICAL', category: 'sql_injection' } },
    { pattern: "'; --", metadata: { severity: 'CRITICAL', category: 'sql_injection' } },
    { pattern: "' OR '1'='1", metadata: { severity: 'CRITICAL', category: 'sql_injection' } },
    { pattern: '" OR "1"="1', metadata: { severity: 'CRITICAL', category: 'sql_injection' } },
  ]);

  ac.build();
  return ac;
}

/**
 * Tạo AhoCorasick cho log analysis.
 * Quét error patterns, attack signatures.
 */
export function createLogAnalyzer() {
  const ac = new AhoCorasickAutomaton();

  ac.addPatterns([
    // Error patterns
    { pattern: 'OutOfMemoryError', metadata: { severity: 'CRITICAL', type: 'oom' } },
    { pattern: 'StackOverflowError', metadata: { severity: 'CRITICAL', type: 'stack_overflow' } },
    { pattern: 'Segmentation fault', metadata: { severity: 'CRITICAL', type: 'segfault' } },
    { pattern: 'SIGSEGV', metadata: { severity: 'CRITICAL', type: 'segfault' } },
    { pattern: 'SIGABRT', metadata: { severity: 'CRITICAL', type: 'abort' } },
    { pattern: 'Deadlock', metadata: { severity: 'CRITICAL', type: 'deadlock' } },
    { pattern: 'deadlock', metadata: { severity: 'CRITICAL', type: 'deadlock' } },
    { pattern: 'Connection refused', metadata: { severity: 'HIGH', type: 'connection' } },
    { pattern: 'Connection timeout', metadata: { severity: 'HIGH', type: 'timeout' } },
    { pattern: 'Too many connections', metadata: { severity: 'HIGH', type: 'connection_pool' } },
    { pattern: '502 Bad Gateway', metadata: { severity: 'CRITICAL', type: 'gateway' } },
    { pattern: '503 Service Unavailable', metadata: { severity: 'CRITICAL', type: 'unavailable' } },
    { pattern: '504 Gateway Timeout', metadata: { severity: 'HIGH', type: 'timeout' } },
    { pattern: 'OutOfMemory', metadata: { severity: 'CRITICAL', type: 'oom' } },
    { pattern: 'OOM killed', metadata: { severity: 'CRITICAL', type: 'oom' } },
    { pattern: 'Killed', metadata: { severity: 'HIGH', type: 'killed' } },
    { pattern: 'panic:', metadata: { severity: 'CRITICAL', type: 'panic' } },
    { pattern: 'fatal error', metadata: { severity: 'CRITICAL', type: 'fatal' } },
    { pattern: 'NullPointerException', metadata: { severity: 'HIGH', type: 'null_pointer' } },
    { pattern: 'IndexOutOfBoundsException', metadata: { severity: 'HIGH', type: 'bounds' } },
    { pattern: 'ClassNotFoundException', metadata: { severity: 'HIGH', type: 'class_not_found' } },
    { pattern: 'NoClassDefFoundError', metadata: { severity: 'HIGH', type: 'class_not_found' } },
    { pattern: 'Permission denied', metadata: { severity: 'MEDIUM', type: 'permission' } },
    { pattern: 'Access denied', metadata: { severity: 'MEDIUM', type: 'permission' } },
    { pattern: 'Disk full', metadata: { severity: 'HIGH', type: 'disk' } },
    { pattern: 'No space left', metadata: { severity: 'HIGH', type: 'disk' } },
    { pattern: 'CPU throttling', metadata: { severity: 'MEDIUM', type: 'cpu' } },
    { pattern: 'Load average', metadata: { severity: 'LOW', type: 'load' } },
  ]);

  ac.build();
  return ac;
}

export { AhoCorasickAutomaton, ACNode };
