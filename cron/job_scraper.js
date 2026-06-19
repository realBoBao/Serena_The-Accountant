/**
 * cron/job_scraper.js — Tier 3: Real-time Internship Scraper
 *
 * Scrape SimplifyJobs/Summer2026-Internships repo mỗi 6h.
 * So sánh với version cũ trong SQLite để tìm jobs mới.
 * Gửi notification qua Discord nếu có job phù hợp.
 *
 * Usage: node cron/job_scraper.js
 */

import { getLogger } from '../lib/logger.js';

const logger = getLogger('JobScraper');

const REPO = 'SimplifyJobs/Summer2026-Internships';
const GITHUB_API = `https://api.github.com/repos/${REPO}/contents/README.md`;

// ── Keywords để filter jobs phù hợp ──
const MATCH_KEYWORDS = [
  'backend', 'software engineer', 'swe', 'full stack', 'fullstack',
  'backend engineer', 'software developer', 'devops', 'infrastructure',
  'data engineer', 'ml engineer', 'machine learning', 'ai engineer',
  'security engineer', 'cloud engineer', 'sre', 'site reliability',
  'node.js', 'python', 'java', 'go', 'rust', 'typescript',
  'react', 'angular', 'vue', 'frontend', 'mobile', 'ios', 'android',
];

/**
 * Lấy nội dung README từ GitHub API
 */
async function fetchReadme() {
  const res = await fetch(GITHUB_API, {
    headers: {
      'User-Agent': 'my-ai-brain/1.0',
      'Accept': 'application/vnd.github.v3+json',
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) throw new Error(`GitHub API ${res.status}`);

  const data = await res.json();
  if (!data.content) throw new Error('No content in response');

  return Buffer.from(data.content, 'base64').toString('utf8');
}

/**
 * Parse jobs từ markdown table
 */
function parseJobs(markdown) {
  const lines = markdown.split('\n');
  const jobs = [];

  for (const line of lines) {
    // Markdown table row: | Company | Role | Location | Link |
    if (!line.includes('|')) continue;
    const cells = line.split('|').map(c => c.trim()).filter(Boolean);
    if (cells.length < 3) continue;

    const company = cells[0] || '';
    const role = cells[1] || '';
    const location = cells[2] || '';
    const link = cells[3] || '';

    // Skip header rows
    if (company.toLowerCase() === 'company' || company.toLowerCase() === '---') continue;
    if (role.toLowerCase() === 'role' || role.toLowerCase() === 'position') continue;

    jobs.push({ company, role, location, link });
  }

  return jobs;
}

/**
 * Filter jobs phù hợp với keywords
 */
function filterJobs(jobs) {
  return jobs.filter(job => {
    const text = `${job.company} ${job.role} ${job.location}`.toLowerCase();
    return MATCH_KEYWORDS.some(kw => text.includes(kw));
  });
}

/**
 * Main: Scrape và so sánh với version cũ
 */
export async function runJobScraper() {
  logger.info('[JobScraper] Starting job scrape...');

  try {
    // 1. Fetch README mới nhất
    const content = await fetchReadme();

    // 2. Parse jobs
    const allJobs = parseJobs(content);
    logger.info(`[JobScraper] Parsed ${allJobs.length} total jobs`);

    // 3. Filter jobs phù hợp
    const matchingJobs = filterJobs(allJobs);
    logger.info(`[JobScraper] ${matchingJobs.length} matching jobs`);

    // 4. So sánh với version cũ (từ SQLite)
    const { getDb } = await import('../lib/sqlite_adapter.js');
    const db = getDb();

    // Tạo job_tracker table nếu chưa có
    await db.exec(`
      CREATE TABLE IF NOT EXISTS job_tracker (
        key TEXT PRIMARY KEY,
        value TEXT
      )
    `);

    const prev = db.prepare("SELECT value FROM job_tracker WHERE key = 'last_readme'").get();
    const prevContent = prev?.value || '';

    await db.close();

    // 5. Nếu không có gì mới → return
    if (content === prevContent) {
      logger.info('[JobScraper] No new jobs (README unchanged)');
      return { newJobs: 0, totalJobs: allJobs.length, matchingJobs: matchingJobs.length };
    }

    // 6. Tìm jobs mới
    const prevLines = new Set(prevContent.split('\n'));
    const newLines = content.split('\n').filter(line => !prevLines.has(line));
    const newJobsText = newLines.filter(line => line.includes('|') && line.includes('http'));

    // 7. Lưu version mới
    const db2 = getDb();
    await db2.prepare("INSERT OR REPLACE INTO job_tracker VALUES ('last_readme', ?)").run(content);
    await db2.close();

    // 8. Gửi notification nếu có jobs mới phù hợp
    if (newJobsText.length > 0 && matchingJobs.length > 0) {
      const topJobs = matchingJobs.slice(0, 5).map(j =>
        `• **${j.role}** @ ${j.company} (${j.location}) ${j.link}`
      ).join('\n');

      const webhook = process.env.DISCORD_WEBHOOK;
      if (webhook) {
        const payload = {
          embeds: [{
            title: `💼 Internship mới — ${newJobsText.length} jobs mới`,
            description: topJobs,
            color: 0x00aa55,
            timestamp: new Date().toISOString(),
            footer: { text: `${matchingJobs.length} jobs phù hợp tổng` },
          }],
        };

        await fetch(webhook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });

        logger.info(`[JobScraper] Sent notification for ${matchingJobs.length} jobs`);
      }
    }

    return {
      newJobs: newJobsText.length,
      totalJobs: allJobs.length,
      matchingJobs: matchingJobs.length,
    };
  } catch (err) {
    logger.error(`[JobScraper] Error: ${err.message}`);
    return { newJobs: 0, totalJobs: 0, matchingJobs: 0, error: err.message };
  }
}

export default { runJobScraper };
