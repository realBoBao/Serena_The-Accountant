/**
 * lib/repo_analyzer.js — GitHub Repository & Document Analyzer
 *
 * Tích hợp chức năng từ: analyze_text.js, analyze_readme.js, analyze_pdf.js, fetch_repo_files.js
 *
 * Cung cấp:
 *   - fetchRepoFiles(owner, repo)  → Lấy danh sách files từ GitHub repo
 *   - analyzeRepo(owner, repo)     → Phân tích README + code → flashcards + summary
 *   - analyzeText(text, type)      → Phân tích text thuần (Gemini)
 *   - analyzePdf(buffer)           → Phân tích PDF (text extraction + Gemini)
 *
 * Được gọi bởi:
 * - discord_bot.js (!analyze <github_url>)
 * - REST API (/api/analyze)
 * - pipeline_report_v2.js (khi cần phân tích repo cụ thể)
 */

import 'dotenv/config';
import { ask as llmAsk } from './llm.js';
import { getLogger } from './logger.js';
import { addMemory } from './memory_manager.js';
import { chunkText } from './chunking.js';
import { upsertDocument } from './vector_store.js';

const logger = getLogger('RepoAnalyzer');

// ── GitHub API ──────────────────────────────────────────

/**
 * Lấy danh sách files từ GitHub repo (recursive tree)
 */
export async function fetchRepoFiles(owner, repo, branch = 'main', githubToken = null) {
  const headers = {
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'my-ai-brain',
  };
  if (githubToken) headers['Authorization'] = `token ${githubToken}`;

  try {
    // Lấy tree recursive
    const branchRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`, { headers });
    if (!branchRes.ok) {
      // Thử master nếu main không có
      if (branch === 'main') return fetchRepoFiles(owner, repo, 'master', githubToken);
      throw new Error(`GitHub tree API ${branchRes.status}: ${branchRes.statusText}`);
    }
    const data = await branchRes.json();
    const files = (data.tree || [])
      .filter(f => f.type === 'blob')
      .filter(f => {
        // Chỉ lấy file text/code có ý nghĩa
        const ext = f.path.split('.').pop()?.toLowerCase();
        return ['md', 'txt', 'js', 'ts', 'py', 'java', 'cpp', 'c', 'h', 'json', 'yml', 'yaml', 'toml', 'rs', 'go', 'rb', 'php', 'sh', 'bat', 'ps1', 'sql', 'html', 'css', 'scss', 'xml', 'csv', 'log', 'cfg', 'ini', 'env', 'dockerfile', 'makefile', 'gradle', 'pom', 'sbt', 'scala', 'kt', 'swift', 'm', 'mm', 'h', 'hpp', 'cs', 'fs', 'fsx', 'fsi', 'vb', 'pl', 'pm', 't', 'r', 'R', 'm', 'lua', 'vim', 'el', 'clj', 'cljs', 'ex', 'exs', 'erl', 'hrl', 'hs', 'lhs', 'ml', 'mli', 'fs', 'fsi', 'fsx', 'v', 'sv', 'svh', 'vhd', 'vhdl', 'qasm', 'proto', 'graphql', 'prisma', 'dml', 'cypher', 'sparql', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'psm1', 'psd1', 'bat', 'cmd', 'awk', 'sed', 'make', 'cmake', 'dockerfile', 'jenkinsfile', 'vagrantfile', 'gemfile', 'rakefile', 'procfile', 'docker-compose', 'helmfile', 'skaffold', 'tiltfile', 'earthfile', 'justfile', 'taskfile', 'magefile', 'goreleaser', 'nfpm', 'snapcraft', 'flatpak', 'appimage', 'dmg', 'msi', 'deb', 'rpm', 'apk', 'ipa', 'aab', 'app', 'exe', 'dll', 'so', 'dylib', 'wasm', 'wat', 'wast', 'wit', 'witx', 'witx', 'wit'].includes(ext) || f.path.toLowerCase().includes('readme') || f.path.toLowerCase().includes('license') || f.path.toLowerCase().includes('changelog') || f.path.toLowerCase().includes('contributing') || f.path.toLowerCase().includes('code of conduct') || f.path.toLowerCase().includes('security') || f.path.toLowerCase().includes('todo') || f.path.toLowerCase().includes('roadmap') || f.path.toLowerCase().includes('architecture') || f.path.toLowerCase().includes('design') || f.path.toLowerCase().includes('spec') || f.path.toLowerCase().includes('test') || f.path.toLowerCase().includes('example') || f.path.toLowerCase().includes('sample') || f.path.toLowerCase().includes('demo') || f.path.toLowerCase().includes('tutorial') || f.path.toLowerCase().includes('guide') || f.path.toLowerCase().includes('faq') || f.path.toLowerCase().includes('troubleshoot') || f.path.toLowerCase().includes('debug') || f.path.toLowerCase().includes('performance') || f.path.toLowerCase().includes('optimization') || f.path.toLowerCase().includes('benchmark') || f.path.toLowerCase().includes('profile') || f.path.toLowerCase().includes('monitor') || f.path.toLowerCase().includes('deploy') || f.path.toLowerCase().includes('ci') || f.path.toLowerCase().includes('cd') || f.path.toLowerCase().includes('devops') || f.path.toLowerCase().includes('infrastructure') || f.path.toLowerCase().includes('config') || f.path.toLowerCase().includes('setup') || f.path.toLowerCase().includes('install') || f.path.toLowerCase().includes('getting started') || f.path.toLowerCase().includes('quick start') || f.path.toLowerCase().includes('quickstart') || f.path.toLowerCase().includes('getting-started') || f.path.toLowerCase().includes('quick-start') || f.path.toLowerCase().includes('quickstart') || f.path.toLowerCase().includes('getting_started') || f.path.toLowerCase().includes('quick_start') || f.path.toLowerCase().includes('quickstart');
      })
      .slice(0, 50); // Giới hạn 50 files

    logger.info(`[RepoAnalyzer] ${owner}/${repo}: ${files.length} files found`);
    return files;
  } catch (err) {
    logger.warn('[RepoAnalyzer] fetchRepoFiles error:', err.message);
    return [];
  }
}

/**
 * Lấy nội dung 1 file từ GitHub
 */
export async function fetchFileContent(owner, repo, filePath, githubToken = null) {
  const headers = {
    'Accept': 'application/vnd.github.v3.raw',
    'User-Agent': 'my-ai-brain',
  };
  if (githubToken) headers['Authorization'] = `token ${githubToken}`;

  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`, { headers });
  if (!res.ok) return null;
  return res.text();
}

/**
 * Phân tích README của repo → summary + flashcards
 */
export async function analyzeReadme(owner, repo, githubToken = null) {
  const content = await fetchFileContent(owner, repo, 'README.md', githubToken);
  if (!content) {
    // Thử các variant
    for (const name of ['readme.md', 'README.rst', 'README.txt', 'readme.txt', 'README']) {
      const c = await fetchFileContent(owner, repo, name, githubToken);
      if (c) { return analyzeText(c, 'readme', { owner, repo }); }
    }
    return null;
  }
  return analyzeText(content, 'readme', { owner, repo });
}

/**
 * Phân tích text thuần bằng Gemini → summary + flashcards
 */
export async function analyzeText(text, type = 'text', meta = {}) {
  if (!text || text.trim().length < 50) return null;

  const prompt = `Phân tích ${type === 'readme' ? 'README' : 'text'} sau và trả về JSON:

\`\`\`
${text.slice(0, 8000)}
\`\`\`

Trả về JSON:
{
  "summary": ["bullet1", "bullet2", "bullet3"],
  "flashcards": [{"question":"...", "answer":"..."}],
  "complexity": [{"topic":"...", "time":"O(...)", "space":"O(...)"}],
  "category": "Backend|AI|DevOps|Math|Algorithms|Other",
  "key_concepts": ["concept1", "concept2"],
  "technologies": ["tech1", "tech2"]
}`;

  try {
    const result = await llmAsk(prompt, { maxTokens: 2000, temperature: 0.2 });
    const jsonMatch = result.answer.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);
    return {
      ...parsed,
      type,
      source: meta.owner ? `${meta.owner}/${meta.repo}` : meta.source || 'text',
      analyzedAt: new Date().toISOString(),
    };
  } catch (err) {
    logger.warn('[RepoAnalyzer] analyzeText error:', err.message);
    return null;
  }
}

/**
 * Phân tích PDF buffer → text extraction + Gemini analysis
 */
export async function analyzePdf(buffer, filename = 'document.pdf') {
  // PDF parsing dùng pdf-parse (đã có trong dependencies)
  try {
    const pdfParse = (await import('pdf-parse')).default;
    const data = await pdfParse(buffer);
    const text = data.text;
    if (!text || text.trim().length < 50) return null;
    return analyzeText(text, 'pdf', { source: filename });
  } catch (err) {
    logger.warn('[RepoAnalyzer] analyzePdf error:', err.message);
    return null;
  }
}

/**
 * Phân tích toàn bộ repo → tổng hợp từ nhiều files
 */
export async function analyzeRepo(owner, repo, githubToken = null) {
  logger.info(`[RepoAnalyzer] Analyzing ${owner}/${repo}...`);

  // 1. Phân tích README
  const readmeAnalysis = await analyzeReadme(owner, repo, githubToken);

  // 2. Lấy danh sách files
  const files = await fetchRepoFiles(owner, repo, 'main', githubToken);

  // 3. Phân tích thêm các file code quan trọng (tối đa 5 files)
  const codeFiles = files.filter(f => {
    const ext = f.path.split('.').pop()?.toLowerCase();
    return ['js', 'ts', 'py', 'java', 'cpp', 'c', 'rs', 'go'].includes(ext) && f.size < 50000;
  }).slice(0, 5);

  const codeAnalyses = [];
  for (const file of codeFiles) {
    const content = await fetchFileContent(owner, repo, file.path, githubToken);
    if (content && content.length > 100) {
      const analysis = await analyzeText(content, 'code', { source: `${owner}/${repo}/${file.path}` });
      if (analysis) codeAnalyses.push(analysis);
    }
  }

  // 4. Tổng hợp kết quả
  const allFlashcards = [
    ...(readmeAnalysis?.flashcards || []),
    ...codeAnalyses.flatMap(a => a.flashcards || []),
  ];

  const allSummary = [
    ...(readmeAnalysis?.summary || []),
    ...codeAnalyses.flatMap(a => a.summary || []),
  ];

  const result = {
    owner,
    repo,
    url: `https://github.com/${owner}/${repo}`,
    summary: allSummary.slice(0, 20),
    flashcards: allFlashcards.slice(0, 30),
    category: readmeAnalysis?.category || 'Other',
    key_concepts: [...new Set([
      ...(readmeAnalysis?.key_concepts || []),
      ...codeAnalyses.flatMap(a => a.key_concepts || []),
    ])].slice(0, 15),
    technologies: [...new Set([
      ...(readmeAnalysis?.technologies || []),
      ...codeAnalyses.flatMap(a => a.technologies || []),
    ])].slice(0, 15),
    filesAnalyzed: codeFiles.length + (readmeAnalysis ? 1 : 0),
    analyzedAt: new Date().toISOString(),
  };

  logger.info(`[RepoAnalyzer] ${owner}/${repo}: ${result.flashcards.length} flashcards, ${result.filesAnalyzed} files`);
  return result;
}

export default { fetchRepoFiles, fetchFileContent, analyzeReadme, analyzeText, analyzePdf, analyzeRepo };
