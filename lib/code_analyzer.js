/**
 * ═══════════════════════════════════════════════════════════════
 * CodeAnalyzer — Phân tích Code Quality, Complexity & Security
 * ═══════════════════════════════════════════════════════════════
 *
 * Cung cấp:
 *   - analyzeCode(code, language) → Phân tích code snippet
 *   - analyzeFile(filePath) → Phân tích file
 *   - analyzeProject(dir) → Phân tích cả project
 *   - getComplexityScore(code) → Tính độ phức tạp cyclomatic
 *   - getQualityReport(code, language) → Báo cáo chất lượng tổng hợp
 *   - detectAntiPatterns(code, language) → Phát hiện anti-patterns
 *   - suggestRefactor(code, language) → Gợi ý refactor
 *
 * Được gọi bởi:
 * - discord_bot.js (!analyze <code>)
 * - REST API (/api/analyze/code)
 * - pipeline_report_v2.js
 * - DebateAgent (khi cần đánh giá code quality)
 */

import { getLogger } from './logger.js';
import { ask as llmAsk } from './llm.js';

const logger = getLogger('CodeAnalyzer');

// ── Complexity Analysis ────────────────────────────────────────────

/**
 * Tính cyclomatic complexity dựa trên control flow keywords
 */
export function getComplexityScore(code, language = 'javascript') {
  const lines = code.split('\n');
  let complexity = 1; // Base complexity

  const controlFlowPatterns = {
    javascript: /\b(if|else\s+if|for|while|do|switch|case|catch|&&|\|\||\?)\b/g,
    python: /\b(if|elif|else|for|while|except|and|or|with|assert)\b/g,
    java: /\b(if|else\s+if|for|while|do|switch|case|catch|&&|\|\||\?)\b/g,
    c: /\b(if|else\s+if|for|while|do|switch|case|&&|\|\||\?)\b/g,
    cpp: /\b(if|else\s+if|for|while|do|switch|case|catch|&&|\|\||\?|try|throw)\b/g,
    csharp: /\b(if|else\s+if|for|while|do|switch|case|catch|&&|\|\||\?|try|throw)\b/g,
    go: /\b(if|else|for|switch|case|select|&&|\|\|)\b/g,
    rust: /\b(if|else|for|while|loop|match|&&|\|\||\?)\b/g,
  };

  const pattern = controlFlowPatterns[language] || controlFlowPatterns.javascript;
  const codeWithoutComments = removeComments(code, language);
  const matches = codeWithoutComments.match(pattern);
  if (matches) complexity += matches.length;

  // Nested depth penalty
  const maxDepth = getMaxNestingDepth(code, language);
  if (maxDepth > 4) complexity += (maxDepth - 4) * 2;

  return {
    cyclomatic: complexity,
    rating: complexity <= 10 ? 'A' : complexity <= 20 ? 'B' : complexity <= 40 ? 'C' : 'D',
    maxNestingDepth: maxDepth,
    linesOfCode: lines.length,
    commentRatio: getCommentRatio(code, language),
  };
}

function removeComments(code, language) {
  // Remove single-line comments
  let result = code.replace(/\/\/.*$/gm, '');
  // Remove multi-line comments
  result = result.replace(/\/\*[\s\S]*?\*\//g, '');
  // Remove Python comments
  if (language === 'python') {
    result = result.replace(/#.*$/gm, '');
    result = result.replace(/"""[\s\S]*?"""/g, '');
    result = result.replace(/'''[\s\S]*?'''/g, '');
  }
  return result;
}

function getMaxNestingDepth(code, language) {
  const lines = code.split('\n');
  let maxDepth = 0;
  let currentDepth = 0;

  const indentSensitive = ['python'];
  if (indentSensitive.includes(language)) {
    for (const line of lines) {
      const indent = line.match(/^(\s*)/)[1].length;
      const depth = Math.floor(indent / 4);
      if (depth > maxDepth) maxDepth = depth;
    }
  } else {
    for (const line of lines) {
      const opens = (line.match(/[{([]/g) || []).length;
      const closes = (line.match(/[})\]]/g) || []).length;
      currentDepth += opens - closes;
      if (currentDepth > maxDepth) maxDepth = currentDepth;
    }
  }

  return maxDepth;
}

function getCommentRatio(code, language) {
  const totalLines = code.split('\n').length;
  if (totalLines === 0) return 0;

  let commentLines = 0;
  const lines = code.split('\n');
  let inBlockComment = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (language === 'python') {
      if (trimmed.startsWith('#') || trimmed.startsWith('"""') || trimmed.startsWith("'''")) {
        commentLines++;
      }
    } else {
      if (inBlockComment) {
        commentLines++;
        if (trimmed.includes('*/')) inBlockComment = false;
      } else if (trimmed.startsWith('//') || trimmed.startsWith('/*')) {
        commentLines++;
        if (trimmed.includes('/*') && !trimmed.includes('*/')) inBlockComment = true;
      }
    }
  }

  return Math.round((commentLines / totalLines) * 100);
}

// ── Anti-Pattern Detection ─────────────────────────────────────────

/**
 * Phát hiện anti-patterns trong code
 */
export function detectAntiPatterns(code, language = 'javascript') {
  const antiPatterns = [];
  const lines = code.split('\n');

  // Common anti-patterns across languages
  const patterns = [
    {
      name: 'God Object / Long Function',
      check: () => lines.length > 100,
      severity: 'warning',
      message: `Function/file has ${lines.length} lines. Consider breaking into smaller units.`,
    },
    {
      name: 'Deep Nesting',
      check: () => getMaxNestingDepth(code, language) > 4,
      severity: 'warning',
      message: 'Deep nesting detected (>4 levels). Consider early returns or extraction.',
    },
    {
      name: 'Magic Numbers',
      check: () => {
        const magicNumbers = code.match(/[^a-zA-Z_](\d{2,})(?![a-zA-Z_])/g);
        return magicNumbers && magicNumbers.length > 3;
      },
      severity: 'info',
      message: 'Multiple magic numbers detected. Consider named constants.',
    },
    {
      name: 'Empty Catch Block',
      check: () => /catch\s*\([^)]*\)\s*\{\s*\}/.test(code),
      severity: 'error',
      message: 'Empty catch block — errors are silently swallowed.',
    },
    {
      name: 'Console.log in Production',
      check: () => language === 'javascript' && /console\.(log|debug|info)\s*\(/.test(code),
      severity: 'info',
      message: 'console.log statements found. Remove or use proper logging.',
    },
    {
      name: 'Hardcoded Credentials',
      check: () => /(password|secret|api_key|token|apikey)\s*[:=]\s*['"][^'"]{8,}['"]/i.test(code),
      severity: 'critical',
      message: 'Potential hardcoded credentials detected!',
    },
    {
      name: 'SQL Injection Risk',
      check: () => /(query|execute|exec)\s*\(\s*['"`].*\$\{|(query|execute|exec)\s*\(\s*['"`]\s*\+/.test(code),
      severity: 'critical',
      message: 'Potential SQL injection — use parameterized queries.',
    },
    {
      name: 'eval() Usage',
      check: () => /\beval\s*\(/.test(code),
      severity: 'critical',
      message: 'eval() is dangerous — avoid or use safer alternatives.',
    },
    {
      name: 'var instead of let/const',
      check: () => language === 'javascript' && /\bvar\s+/.test(code),
      severity: 'info',
      message: 'Use let/const instead of var for block scoping.',
    },
    {
      name: 'Missing Error Handling',
      check: () => {
        const hasAsync = /async|await|Promise|\.then\(/.test(code);
        const hasTryCatch = /try\s*\{/.test(code);
        return hasAsync && !hasTryCatch;
      },
      severity: 'warning',
      message: 'Async code without try/catch — add error handling.',
    },
    {
      name: 'TODO/FIXME Comments',
      check: () => {
        const todos = code.match(/TODO|FIXME|HACK|XXX/gi);
        return todos && todos.length > 0;
      },
      severity: 'info',
      message: 'TODO/FIXME comments found — track in issue tracker.',
    },
    {
      name: 'Duplicate Code',
      check: () => {
        const lineSet = new Set();
        let duplicates = 0;
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.length > 20) {
            if (lineSet.has(trimmed)) duplicates++;
            lineSet.add(trimmed);
          }
        }
        return duplicates > 3;
      },
      severity: 'warning',
      message: 'Duplicate code blocks detected — consider extraction.',
    },
  ];

  for (const pattern of patterns) {
    try {
      if (pattern.check()) {
        antiPatterns.push({
          name: pattern.name,
          severity: pattern.severity,
          message: pattern.message,
        });
      }
    } catch {
      // Skip patterns that fail to evaluate
    }
  }

  return antiPatterns;
}

// ── Quality Report ─────────────────────────────────────────────────

/**
 * Tạo báo cáo chất lượng code tổng hợp
 */
export function getQualityReport(code, language = 'javascript') {
  const complexity = getComplexityScore(code, language);
  const antiPatterns = detectAntiPatterns(code, language);

  // Calculate quality score (0-100)
  let score = 100;

  // Complexity penalty
  if (complexity.cyclomatic > 10) score -= (complexity.cyclomatic - 10) * 2;
  if (complexity.maxNestingDepth > 4) score -= (complexity.maxNestingDepth - 4) * 5;

  // Anti-pattern penalties
  for (const ap of antiPatterns) {
    if (ap.severity === 'critical') score -= 15;
    else if (ap.severity === 'error') score -= 10;
    else if (ap.severity === 'warning') score -= 5;
    else if (ap.severity === 'info') score -= 2;
  }

  // Comment ratio bonus/penalty
  if (complexity.commentRatio < 5) score -= 10;
  else if (complexity.commentRatio > 30) score += 5;

  score = Math.max(0, Math.min(100, score));

  const grade = score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : score >= 60 ? 'D' : 'F';

  return {
    score,
    grade,
    complexity,
    antiPatterns,
    summary: `${antiPatterns.length} issues found, complexity: ${complexity.cyclomatic} (Grade ${complexity.rating})`,
    recommendations: generateRecommendations(complexity, antiPatterns),
  };
}

function generateRecommendations(complexity, antiPatterns) {
  const recs = [];

  if (complexity.cyclomatic > 10) {
    recs.push('Reduce cyclomatic complexity by extracting functions');
  }
  if (complexity.maxNestingDepth > 4) {
    recs.push('Reduce nesting depth — use early returns or guard clauses');
  }
  if (complexity.commentRatio < 5) {
    recs.push('Add more comments to improve code readability');
  }
  if (complexity.linesOfCode > 100) {
    recs.push('Consider splitting into smaller modules');
  }

  const critical = antiPatterns.filter(a => a.severity === 'critical');
  if (critical.length > 0) {
    recs.push(`Fix ${critical.length} critical issue(s) immediately`);
  }

  return recs;
}

// ── LLM-Powered Analysis ──────────────────────────────────────────

/**
 * Phân tích code bằng LLM để có insights sâu hơn
 */
export async function analyzeWithLlm(code, language = 'javascript') {
  const prompt = `You are a senior code reviewer. Analyze the following ${language} code and provide:

1. **Code Quality** (1-10): Overall quality assessment
2. **Main Issues**: Top 3-5 issues or concerns
3. **Improvement Suggestions**: Specific, actionable recommendations
4. **Security Concerns**: Any security vulnerabilities
5. **Performance Notes**: Potential performance improvements

Keep the response concise and in Vietnamese.

\`\`\`${language}
${code.slice(0, 3000)}
\`\`\`

Respond in JSON format:
{"quality": number, "issues": string[], "suggestions": string[], "security": string[], "performance": string[]}`;

  try {
    const { answer } = await llmAsk(prompt, {
      systemPrompt: 'You are an expert code reviewer. Always respond in valid JSON format.',
      temperature: 0.2,
      maxTokens: 1024,
    });

    // Extract JSON from response
    const jsonMatch = answer.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    return { raw: answer };
  } catch (err) {
    logger.warn('[CodeAnalyzer] LLM analysis failed:', err?.message);
    return { error: 'LLM analysis unavailable' };
  }
}

// ── Main Analysis Entry Point ──────────────────────────────────────

/**
 * Phân tích code hoàn chỉnh (static + LLM)
 */
export async function analyzeCode(code, language = 'javascript', options = {}) {
  const staticReport = getQualityReport(code, language);
  let llmReport = null;

  if (options.useLlm !== false && code.length < 10000) {
    llmReport = await analyzeWithLlm(code, language);
  }

  return {
    language,
    static: staticReport,
    llm: llmReport,
    timestamp: new Date().toISOString(),
  };
}
