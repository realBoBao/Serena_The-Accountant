/**
 * SecurityAuditor — Quét bảo mật code bằng Aho-Corasick
 *
 * Dùng Aho-Corasick để quét hàng chục ngàn pattern (secrets, unsafe functions,
 * SQL injection, XSS) trong O(N) — không phụ thuộc số lượng rules.
 *
 * So với regex loop: O(N * K) với K = số patterns
 * Aho-Corasick: O(N + M + Z) — KHÔNG chậm đi khi thêm rules
 *
 * Ứng dụng:
 * - Quét secrets/API keys trong code
 * - Phát hiện unsafe functions (strcpy, gets, system)
 * - Tìm SQL injection patterns
 * - Tìm XSS vulnerabilities
 */

import { createSecurityScanner } from '../lib/aho_corasick.js';
import { getLogger } from '../lib/logger.js';

const logger = getLogger('SecurityAuditor');

// Singleton scanner (built once, reused)
let scanner = null;

function getScanner() {
  if (!scanner) {
    scanner = createSecurityScanner();
  }
  return scanner;
}

/**
 * Quét code để tìm vấn đề bảo mật.
 * @param {string} code - Code cần quét
 * @param {string} filename - Tên file (optional)
 * @returns {object} - { issues, score, summary }
 */
export function auditCode(code, filename = 'unknown') {
  const ac = getScanner();
  const matches = ac.searchSummary(code);

  const issues = [];
  let criticalCount = 0;
  let highCount = 0;
  let mediumCount = 0;
  let lowCount = 0;

  for (const match of matches) {
    const issue = {
      pattern: match.pattern,
      severity: match.severity,
      category: match.category,
      count: match.count,
      positions: match.positions,
      file: filename,
    };

    issues.push(issue);

    switch (match.severity) {
      case 'CRITICAL': criticalCount += match.count; break;
      case 'HIGH': highCount += match.count; break;
      case 'MEDIUM': mediumCount += match.count; break;
      default: lowCount += match.count; break;
    }
  }

  // Calculate security score (0-100)
  const totalIssues = criticalCount * 10 + highCount * 5 + mediumCount * 2 + lowCount * 0.5;
  const score = Math.max(0, Math.round(100 - totalIssues));

  const summary = {
    filename,
    totalPatterns: ac.patternCount,
    issuesFound: issues.length,
    critical: criticalCount,
    high: highCount,
    medium: mediumCount,
    low: lowCount,
    score,
    grade: score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : score >= 40 ? 'D' : 'F',
  };

  logger.info(`[SecurityAuditor] ${filename}: score ${score}/100 (${issues.length} issues)`);

  return { issues, score, summary };
}

/**
 * Quét nhiều files cùng lúc.
 */
export function auditFiles(files) {
  const results = [];
  for (const { code, filename } of files) {
    results.push(auditCode(code, filename));
  }

  const totalScore = results.length > 0
    ? Math.round(results.reduce((a, r) => a + r.score, 0) / results.length)
    : 100;

  return {
    files: results,
    overallScore: totalScore,
    totalIssues: results.reduce((a, r) => a + r.issues.length, 0),
  };
}

/**
 * Format kết quả audit thành message cho Discord.
 */
export function formatAuditMessage(result) {
  const { summary, issues } = result;

  const lines = [
    `🔒 **Security Audit — ${summary.filename}**`,
    ``,
    `📊 **Score:** ${summary.score}/100 (Grade: ${summary.grade})`,
    `🔍 Scanned against ${summary.totalPatterns} patterns`,
    ``,
  ];

  if (issues.length === 0) {
    lines.push(`✅ **Không phát hiện vấn đề bảo mật!**`);
  } else {
    lines.push(`⚠️ **${issues.length} vấn đề phát hiện:**`);
    lines.push(``);

    // Group by severity
    const bySeverity = { CRITICAL: [], HIGH: [], MEDIUM: [], LOW: [] };
    for (const issue of issues) {
      bySeverity[issue.severity]?.push(issue);
    }

    for (const [sev, items] of Object.entries(bySeverity)) {
      if (items.length === 0) continue;
      const icon = sev === 'CRITICAL' ? '🔴' : sev === 'HIGH' ? '🟠' : sev === 'MEDIUM' ? '🟡' : '🔵';
      lines.push(`${icon} **${sev} (${items.length}):**`);
      for (const item of items.slice(0, 5)) {
        lines.push(`  • \`${item.pattern}\` (${item.count}x) [${item.category}]`);
      }
      if (items.length > 5) lines.push(`  • ... và ${items.length - 5} khác`);
    }
  }

  return lines.join('\n');
}
