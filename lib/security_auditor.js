/**
 * ═══════════════════════════════════════════════════════════════
 * SecurityAuditor — Quét Vulnerability, Secret Leak & Dependency
 * ═══════════════════════════════════════════════════════════════
 *
 * Cung cấp:
 *   - scanCode(code, language) → Quét vulnerabilities trong code
 *   - scanFile(filePath) → Quét file
 *   - scanProject(dir) → Quét cả project
 *   - detectSecrets(code) → Phát hiện API keys, passwords, tokens
 *   - checkDependencies(dir) → Kiểm tra dependency vulnerabilities
 *   - getSecurityReport() → Báo cáo bảo mật tổng hợp
 *
 * Được gọi bởi:
 * - discord_bot.js (!audit <code>)
 * - REST API (/api/security/audit)
 * - pipeline_report_v2.js
 * - DebateAgent (khi cần đánh giá security)
 */

import { getLogger } from './logger.js';
import { ask as llmAsk } from './llm.js';
import { readFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';

const logger = getLogger('SecurityAuditor');

// ── Secret Detection ──────────────────────────────────────────────

/**
 * Phát hiện secrets/credentials trong code
 */
export function detectSecrets(code, filename = '') {
  const findings = [];

  const secretPatterns = [
    { pattern: /(?:api[_-]?key|apikey)\s*[:=]\s*['"]([a-zA-Z0-9_\-]{16,})['"]/gi, type: 'API Key', severity: 'critical' },
    { pattern: /(?:secret[_-]?key|secretkey)\s*[:=]\s*['"]([a-zA-Z0-9_\-]{16,})['"]/gi, type: 'Secret Key', severity: 'critical' },
    { pattern: /(?:password|passwd|pwd)\s*[:=]\s*['"]([^'"]{8,})['"]/gi, type: 'Password', severity: 'critical' },
    { pattern: /(?:token|access[_-]?token)\s*[:=]\s*['"]([a-zA-Z0-9_\-\.]{20,})['"]/gi, type: 'Access Token', severity: 'critical' },
    { pattern: /(?:private[_-]?key|privatekey)\s*[:=]\s*['"]([^'"]+)['"]/gi, type: 'Private Key', severity: 'critical' },
    { pattern: /-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g, type: 'PEM Private Key', severity: 'critical' },
    { pattern: /sk-[a-zA-Z0-9]{20,}/g, type: 'OpenAI/Stripe Key', severity: 'critical' },
    { pattern: /ghp_[a-zA-Z0-9]{36}/g, type: 'GitHub Token', severity: 'critical' },
    { pattern: /gho_[a-zA-Z0-9]{36}/g, type: 'GitHub OAuth Token', severity: 'critical' },
    { pattern: /xox[bpoas]-[a-zA-Z0-9\-]{10,}/g, type: 'Slack Token', severity: 'critical' },
    { pattern: /AIza[0-9A-Za-z\-_]{35}/g, type: 'Google API Key', severity: 'high' },
    { pattern: /[0-9]+-[0-9A-Za-z_]{32}\.apps\.googleusercontent\.com/g, type: 'Google OAuth', severity: 'high' },
    { pattern: /AKIA[0-9A-Z]{16}/g, type: 'AWS Access Key', severity: 'critical' },
    { pattern: /['"]?AWS_SECRET_ACCESS_KEY['"]?\s*[:=]\s*['"]([a-zA-Z0-9/+=]{40})['"]/gi, type: 'AWS Secret Key', severity: 'critical' },
    { pattern: /eyJhbGciOi[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]*/g, type: 'JWT Token', severity: 'high' },
    { pattern: /(?:connection[_-]?string|conn[_-]?str)\s*[:=]\s*['"]([^'"]+)['"]/gi, type: 'Connection String', severity: 'high' },
    { pattern: /mongodb(?:\+srv)?:\/\/[^:]+:[^@]+@/gi, type: 'MongoDB Connection', severity: 'high' },
    { pattern: /postgres(?:ql)?:\/\/[^:]+:[^@]+@/gi, type: 'PostgreSQL Connection', severity: 'high' },
    { pattern: /mysql:\/\/[^:]+:[^@]+@/gi, type: 'MySQL Connection', severity: 'high' },
    { pattern: /(?:discord|bot)[_-]?token\s*[:=]\s*['"]([a-zA-Z0-9\-_\.]{20,})['"]/gi, type: 'Discord Token', severity: 'critical' },
  ];

  const lines = code.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const { pattern, type, severity } of secretPatterns) {
      pattern.lastIndex = 0;
      const match = pattern.exec(line);
      if (match) {
        findings.push({
          type,
          severity,
          line: i + 1,
          filename,
          // Mask the actual secret
          match: match[0].slice(0, 8) + '...' + match[0].slice(-4),
          context: line.trim().slice(0, 100),
        });
      }
    }
  }

  return findings;
}

// ── Vulnerability Scanning ────────────────────────────────────────

/**
 * Quét vulnerabilities trong code
 */
export function scanCode(code, language = 'javascript') {
  const vulnerabilities = [];

  const vulnPatterns = [
    // Injection vulnerabilities
    { pattern: /eval\s*\(/g, type: 'Code Injection', severity: 'critical', cwe: 'CWE-94', message: 'eval() allows arbitrary code execution' },
    { pattern: /new\s+Function\s*\(/g, type: 'Code Injection', severity: 'critical', cwe: 'CWE-94', message: 'Function constructor allows code injection' },
    { pattern: /innerHTML\s*=/g, type: 'XSS', severity: 'high', cwe: 'CWE-79', message: 'innerHTML can lead to XSS attacks' },
    { pattern: /document\.write\s*\(/g, type: 'XSS', severity: 'high', cwe: 'CWE-79', message: 'document.write can lead to XSS' },

    // SQL Injection
    { pattern: /(?:query|execute|exec)\s*\(\s*['"`].*\+/g, type: 'SQL Injection', severity: 'critical', cwe: 'CWE-89', message: 'String concatenation in SQL query' },
    { pattern: /\$\{(?:[^}]+)\}.*(?:SELECT|INSERT|UPDATE|DELETE|DROP)/gi, type: 'SQL Injection', severity: 'critical', cwe: 'CWE-89', message: 'Template literal in SQL query' },

    // Path Traversal
    { pattern: /readFile(?:Sync)?\s*\(.*(?:req|request|params|query|body)/g, type: 'Path Traversal', severity: 'high', cwe: 'CWE-22', message: 'User input in file path — path traversal risk' },
    { pattern: /writeFile(?:Sync)?\s*\(.*(?:req|request|params|query|body)/g, type: 'Path Traversal', severity: 'high', cwe: 'CWE-22', message: 'User input in file write path' },

    // Command Injection
    { pattern: /exec\s*\(.*(?:req|request|params|query|body)/g, type: 'Command Injection', severity: 'critical', cwe: 'CWE-78', message: 'User input in exec() — command injection risk' },
    { pattern: /execSync\s*\(.*(?:req|request|params|query|body)/g, type: 'Command Injection', severity: 'critical', cwe: 'CWE-78', message: 'User input in execSync() — command injection risk' },
    { pattern: /child_process.*(?:req|request|params|query|body)/g, type: 'Command Injection', severity: 'critical', cwe: 'CWE-78', message: 'User input in child_process' },

    // SSRF
    { pattern: /fetch\s*\(.*(?:req|request|params|query|body)/g, type: 'SSRF', severity: 'high', cwe: 'CWE-918', message: 'User input in fetch URL — SSRF risk' },
    { pattern: /axios\s*\.\w+\s*\(.*(?:req|request|params|query|body)/g, type: 'SSRF', severity: 'high', cwe: 'CWE-918', message: 'User input in axios URL — SSRF risk' },

    // Insecure crypto
    { pattern: /createHash\s*\(\s*['"]md5['"]\s*\)/gi, type: 'Weak Crypto', severity: 'high', cwe: 'CWE-328', message: 'MD5 is cryptographically weak' },
    { pattern: /createHash\s*\(\s*['"]sha1['"]\s*\)/gi, type: 'Weak Crypto', severity: 'high', cwe: 'CWE-328', message: 'SHA1 is cryptographically weak' },
    { pattern: /Math\.random\s*\(\s*\)/g, type: 'Weak Random', severity: 'medium', cwe: 'CWE-330', message: 'Math.random() is not cryptographically secure' },

    // Prototype Pollution
    { pattern: /Object\.assign\s*\(\s*\{\s*\}\s*,\s*(?:req|request|params|query|body)/g, type: 'Prototype Pollution', severity: 'high', cwe: 'CWE-1321', message: 'Object.assign with user input — prototype pollution risk' },

    // Missing security headers (for web frameworks)
    { pattern: /app\.use\s*\(\s*helmet\s*\(\s*\)/g, type: 'Security Header', severity: 'info', cwe: 'CWE-693', message: 'Good: helmet() middleware detected' },

    // Hardcoded IP addresses
    { pattern: /\b(?:192\.168\.|10\.|172\.(?:1[6-9]|2[0-9]|3[01])\.)\d{1,3}\.\d{1,3}\b/g, type: 'Info Disclosure', severity: 'low', cwe: 'CWE-200', message: 'Private IP address in code' },

    // Disabled SSL verification
    { pattern: /rejectUnauthorized\s*:\s*false/g, type: 'SSL Bypass', severity: 'critical', cwe: 'CWE-295', message: 'SSL certificate verification disabled' },
    { pattern: /NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]0['"]/g, type: 'SSL Bypass', severity: 'critical', cwe: 'CWE-295', message: 'TLS rejection disabled globally' },

    // Python-specific
    { pattern: /pickle\.loads?\s*\(/g, type: 'Deserialization', severity: 'critical', cwe: 'CWE-502', message: 'pickle.loads can execute arbitrary code' },
    { pattern: /yaml\.load\s*\([^,]+\)/g, type: 'YAML Injection', severity: 'high', cwe: 'CWE-502', message: 'yaml.load without SafeLoader' },
    { pattern: /subprocess\.\w+\s*\(.*shell\s*=\s*True/g, type: 'Command Injection', severity: 'critical', cwe: 'CWE-78', message: 'subprocess with shell=True' },
    { pattern: /os\.system\s*\(/g, type: 'Command Injection', severity: 'critical', cwe: 'CWE-78', message: 'os.system() is dangerous' },
  ];

  const lines = code.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const { pattern, type, severity, cwe, message } of vulnPatterns) {
      pattern.lastIndex = 0;
      if (pattern.test(line)) {
        vulnerabilities.push({
          type,
          severity,
          cwe,
          message,
          line: i + 1,
          context: line.trim().slice(0, 120),
        });
      }
    }
  }

  return vulnerabilities;
}

// ── Dependency Check ──────────────────────────────────────────────

/**
 * Kiểm tra dependency vulnerabilities (npm audit)
 */
export function checkDependencies(dir = '.') {
  try {
    if (!existsSync(`${dir}/package.json`)) {
      return { error: 'No package.json found' };
    }

    const audit = execSync('npm audit --json 2>/dev/null || true', {
      cwd: dir,
      timeout: 30000,
      encoding: 'utf8',
    });

    const result = JSON.parse(audit);
    return {
      vulnerabilities: result.vulnerabilities || {},
      metadata: result.metadata || {},
      total: Object.values(result.vulnerabilities || {}).reduce((sum, v) => sum + (v.via?.length || 0), 0),
    };
  } catch {
    return { error: 'npm audit unavailable' };
  }
}

// ── LLM Security Analysis ─────────────────────────────────────────

/**
 * Phân tích bảo mật bằng LLM
 */
export async function analyzeSecurityWithLlm(code, language = 'javascript') {
  const prompt = `You are a security expert. Review the following ${language} code for security vulnerabilities.

Focus on:
1. Injection attacks (SQL, Command, XSS, SSRF)
2. Authentication/Authorization issues
3. Data exposure (secrets, PII)
4. Cryptographic weaknesses
5. Input validation issues
6. Dependency risks

\`\`\`${language}
${code.slice(0, 3000)}
\`\`\`

Respond in JSON format:
{"risk_level": "low|medium|high|critical", "vulnerabilities": [{"type": string, "severity": string, "description": string, "fix": string}], "summary": string}`;

  try {
    const { answer } = await llmAsk(prompt, {
      systemPrompt: 'You are a cybersecurity expert. Always respond in valid JSON.',
      temperature: 0.2,
      maxTokens: 1024,
    });

    const jsonMatch = answer.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    return { raw: answer };
  } catch (err) {
    logger.warn('[SecurityAuditor] LLM analysis failed:', err?.message);
    return { error: 'LLM analysis unavailable' };
  }
}

// ── Main Audit Entry Point ─────────────────────────────────────────

/**
 * Audit bảo mật hoàn chỉnh
 */
export async function auditCode(code, language = 'javascript', options = {}) {
  const secrets = detectSecrets(code);
  const vulnerabilities = scanCode(code, language);
  let llmReport = null;

  if (options.useLlm !== false && code.length < 10000) {
    llmReport = await analyzeSecurityWithLlm(code, language);
  }

  // Calculate security score
  let score = 100;
  for (const v of vulnerabilities) {
    if (v.severity === 'critical') score -= 20;
    else if (v.severity === 'high') score -= 10;
    else if (v.severity === 'medium') score -= 5;
    else if (v.severity === 'low') score -= 2;
  }
  for (const s of secrets) {
    if (s.severity === 'critical') score -= 15;
    else if (s.severity === 'high') score -= 8;
  }
  score = Math.max(0, Math.min(100, score));

  const riskLevel = score >= 80 ? 'low' : score >= 60 ? 'medium' : score >= 40 ? 'high' : 'critical';

  return {
    score,
    riskLevel,
    secrets,
    vulnerabilities,
    llm: llmReport,
    summary: `${secrets.length} secrets, ${vulnerabilities.length} vulnerabilities found`,
    timestamp: new Date().toISOString(),
  };
}
