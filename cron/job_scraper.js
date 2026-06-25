#!/usr/bin/env node
/**
 * cron/job_scraper.js — Scrape job postings và gửi qua JOB_WEBHOOK_URL
 *
 * Nguồn: SimplifyJobs (GitHub), NewGradPositions, HackerNews, RemoteOK, WeWorkRemotely, LinkedIn, Indeed
 * Usage: node cron/job_scraper.js
 * Cron: 6AM + 12PM + 6PM PDT daily (via GitHub Actions)
 *
 * Smart fetch: retry + rate-limit + fallback
 */

import 'dotenv/config';
import { httpGet, httpPost, httpScrape } from '../lib/http_client.js';
import { getDb, runQuery } from '../lib/db.js';
import { scoreContent, formatQualityBar } from '../lib/content_quality.js';

const JOB_WEBHOOK = process.env.JOB_WEBHOOK_URL;

if (!JOB_WEBHOOK) {
  console.error('❌ JOB_WEBHOOK_URL not set in .env');
  console.error('   Create a separate webhook for jobs: Discord Server Settings → Integrations → Webhooks');
  process.exit(1);
}

// ── Helpers ──
function stripHtml(s) { return s.replace(/<[^>]+>/g, '').trim(); }

function parseSimplifyHtml(text, limit, source) {
  const tbodyMatch = text.match(/<tbody>([\s\S]*?)<\/tbody>/);
  if (!tbodyMatch) return [];
  const rows = tbodyMatch[1].split(/<tr>/).filter(r => r.includes('<td>'));
  return rows.slice(0, limit).map(r => {
    const cells = r.split(/<td>/).filter(c => c.includes('</td>'));
    const vals = cells.map(c => {
      const end = c.indexOf('</td>');
      const html = c.slice(0, end);
      const link = html.match(/href="([^"]+)"/)?.[1] || '';
      const text = stripHtml(html);
      return { text, link };
    });
    return {
      company: vals[0]?.text || 'Unknown',
      role: vals[1]?.text || 'Unknown',
      location: vals[2]?.text || 'Remote',
      link: vals[3]?.link || '#',
      source,
    };
  }).filter(j => j.company !== 'Unknown');
}

// ── Job sources ──
async function fetchSimplifyJobs(limit = 10) {
  try {
    const res = await fetch('https://raw.githubusercontent.com/SimplifyJobs/Summer2026-Internships/dev/README.md');
    if (!res.ok) throw new Error(`SimplifyJobs ${res.status}`);
    const text = await res.text();
    return parseSimplifyHtml(text, limit, 'SimplifyJobs');
  } catch (err) {
    console.warn('[JobScraper] SimplifyJobs failed:', err.message);
    return [];
  }
}

async function fetchNewGradPositions(limit = 10) {
  try {
    const res = await fetch('https://raw.githubusercontent.com/SimplifyJobs/New-Grad-Positions/dev/README.md');
    if (!res.ok) throw new Error(`NewGradPositions ${res.status}`);
    const text = await res.text();
    return parseSimplifyHtml(text, limit, 'NewGradPositions');
  } catch (err) {
    console.warn('[JobScraper] NewGradPositions failed:', err.message);
    return [];
  }
}

async function fetchRemoteOK(limit = 10) {
  try {
    const res = await fetch('https://remoteok.com/api?tag=dev', {
      headers: { 'User-Agent': 'Serena-Brain/1.0' },
    });
    if (!res.ok) throw new Error(`RemoteOK ${res.status}`);
    const data = await res.json();
    return (data || []).slice(1, limit + 1).map(j => ({
      company: j.company || 'Unknown',
      role: j.position || 'Unknown',
      title: j.position || 'Unknown', // ← thêm để isRelevant check được
      location: j.location || 'Remote',
      link: j.url || j.apply_url || '#',
      source: 'RemoteOK',
    }));
  } catch (err) {
    console.warn('[JobScraper] RemoteOK failed:', err.message);
    return [];
  }
}

async function fetchHackerNewsHiring(limit = 15) {
  try {
    // Tìm thread "Ask HN: Who is hiring?" tháng hiện tại
    const searchRes = await fetch(
      'https://hn.algolia.com/api/v1/search?query=Ask+HN+Who+is+hiring&tags=ask_hn&hitsPerPage=1'
    );
    if (!searchRes.ok) throw new Error(`HN search ${searchRes.status}`);
    const search = await searchRes.json();
    const threadId = search.hits[0]?.objectID;
    if (!threadId) return [];

    // Lấy thread info
    const threadRes = await fetch(`https://hacker-news.firebaseio.com/v0/item/${threadId}.json`);
    if (!threadRes.ok) throw new Error(`HN thread ${threadRes.status}`);
    const thread = await threadRes.json();

    // Lấy comments (mỗi comment = 1 job posting)
    const commentIds = (thread.kids || []).slice(0, limit * 2); // lấy nhiều hơn để filter
    const comments = await Promise.all(
      commentIds.map(id =>
        fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`).then(r => r.json())
      )
    );

    const techKeywords = ['backend', 'node', 'devops', 'fullstack', 'software engineer', 'swe', 'api', 'distributed', 'microservices', 'cloud', 'infrastructure', 'javascript', 'typescript', 'python', 'kubernetes', 'docker'];
    return comments
      .filter(c => c?.text && !c.deleted && !c.dead)
      .map(c => {
        const text = c.text;
        const cleanText = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        const lines = cleanText.split('\n').filter(Boolean);
        const firstLine = lines[0] || '';

        // Parse pipe-delimited format: "Company | Role | Location | URL | ..."
        const parts = firstLine.split('|').map(p => p.trim());
        const company = parts[0]?.slice(0, 50) || 'HN Company';
        const role = parts[1] || firstLine.slice(0, 80);
        const location = parts[2] || 'Remote';

        // Extract URL từ href hoặc từ pipe part
        const hrefMatch = text.match(/href="([^"]+)"/);
        let url = hrefMatch ? hrefMatch[1] : `https://news.ycombinator.com/item?id=${c.id}`;
        url = url.replace(/&#x2F;/g, '/').replace(/&amp;/g, '&');
        if (!hrefMatch && parts[3] && parts[3].includes('http')) {
          url = parts[3];
        }

        return {
          company,
          role,
          title: role,
          location,
          link: url,
          source: 'HackerNews',
          description: cleanText.slice(0, 200),
        };
      })
      .filter(j => {
        const text = (j.title + ' ' + j.company + ' ' + j.description).toLowerCase();
        return techKeywords.some(k => text.includes(k));
      })
      .slice(0, limit);
  } catch (err) {
    console.warn('[JobScraper] HackerNews failed:', err.message);
    return [];
  }
}

// ── Crawlee-powered fetch for HTML-heavy sites ────────────
async function fetchWithCrawlee(url, extractFn, limit = 10) {
  try {
    const { CheerioCrawler, Configuration, MemoryStorage } = await import('crawlee');
    const config = new Configuration({ storageClient: new MemoryStorage(), purgeOnStart: true });
    const results = [];

    const crawler = new CheerioCrawler({
      maxConcurrency: 3,
      maxRequestRetries: 2,
      requestHandlerTimeoutSecs: 20,
      preNavigationHooks: [
        ({ request }) => {
          request.headers = {
            ...request.headers,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
            'Accept-Language': 'en-US,en;q=0.9',
          };
        },
      ],
    }, config);

    crawler.requestHandler = async ({ $, request }) => {
      try {
        const result = extractFn($, request.url);
        if (result) results.push(result);
      } catch { /* skip bad items */ }
    };

    await crawler.run([url]);
    return results.slice(0, limit);
  } catch (err) {
    console.warn(`[JobScraper] Crawlee fetch failed for ${url}:`, err.message);
    return [];
  }
}

async function fetchWeWorkRemotely(limit = 10) {
  // Use Crawlee for HTML parsing (more robust than regex)
  const extractFn = ($, url) => {
    const title = $('title').text().trim() || 'Unknown';
    const description = $('description').text().replace(/<[^>]+>/g, '').slice(0, 200) || '';
    const link = $('link').text().trim() || url;
    return {
      company: title.split('—')[0]?.split('-')[0]?.trim() || 'Unknown',
      role: title,
      location: 'Remote',
      link,
      source: 'WeWorkRemotely',
      description,
    };
  };

  const rssResults = await fetchWithCrawlee(
    'https://weworkremotely.com/remote-jobs.rss',
    extractFn,
    limit
  );

  // Fallback to simple fetch if Crawlee fails
  if (rssResults.length === 0) {
    try {
      const res = await fetch('https://weworkremotely.com/remote-jobs.rss', {
        headers: { 'User-Agent': 'Serena-Brain/1.0' },
      });
      if (!res.ok) throw new Error(`WeWorkRemotely ${res.status}`);
      const xml = await res.text();
      const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)];
      return items.slice(0, limit).map(m => {
        const item = m[1];
        const title = item.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.trim() || 'Unknown';
        const link = item.match(/<link>([\s\S]*?)<\/link>/)?.[1]?.trim() || '#';
        const desc = item.match(/<description>([\s\S]*?)<\/description>/)?.[1]?.replace(/<[^>]+>/g, '').slice(0, 100) || '';
        return {
          company: title.split('—')[0]?.split('-')[0]?.trim() || 'Unknown',
          role: title,
          location: 'Remote',
          link,
          source: 'WeWorkRemotely',
          description: desc,
        };
      });
    } catch (err) {
      console.warn('[JobScraper] WeWorkRemotely fallback failed:', err.message);
      return [];
    }
  }

  return rssResults;
}

// ── LinkedIn Jobs (Crawlee) ───────────────────────────────
async function fetchLinkedInJobs(limit = 10) {
  // LinkedIn public jobs page (no login required for basic listings)
  const extractFn = ($, url) => {
    // LinkedIn job cards
    const cards = $('div.job-card-container, div.base-card, [data-job-id]');
    return cards.map((i, el) => {
      const $el = $(el);
      const title = $el.find('a.job-card-list__title, h3.base-search-card__title').text().trim() || 'Unknown';
      const company = $el.find('h4.base-search-card__subtitle, a.hidden-nested-link').text().trim() || 'Unknown';
      const location = $el.find('span.job-card-container__metadata-item, span.base-search-card__metadata').first().text().trim() || 'Remote';
      const link = $el.find('a.base-card__full-link, a.job-card-list__title-link').attr('href') || url;
      return {
        company,
        role: title,
        title,
        location,
        link: link.startsWith('http') ? link : `https://www.linkedin.com${link}`,
        source: 'LinkedIn',
        description: $el.find('p.job-card-list__snippet').text().slice(0, 100) || '',
      };
    }).get();
  };

  return fetchWithCrawlee(
    'https://www.linkedin.com/jobs/search/?keywords=software%20engineer%20remote',
    extractFn,
    limit
  );
}

// ── Indeed Jobs (Crawlee) ─────────────────────────────────
async function fetchIndeedJobs(limit = 10) {
  const extractFn = ($, url) => {
    const cards = $('div.job_seen_beacon, div.jobsearch-SerpJobCard, [data-jk]');
    return cards.map((i, el) => {
      const $el = $(el);
      const title = $el.find('h2.jobTitle a, h2.jobTitle span').text().trim() || 'Unknown';
      const company = $el.find('span[data-testid="company-name"], span.companyName').text().trim() || 'Unknown';
      const location = $el.find('div[data-testid="text-location"], div.companyLocation').text().trim() || 'Remote';
      const link = $el.find('h2.jobTitle a').attr('href') || '';
      return {
        company,
        role: title,
        title,
        location,
        link: link.startsWith('http') ? link : `https://www.indeed.com${link}`,
        source: 'Indeed',
        description: $el.find('div.job-snippet').text().slice(0, 100) || '',
      };
    }).get();
  };

  return fetchWithCrawlee(
    'https://www.indeed.com/jobs?q=software+engineer+remote',
    extractFn,
    limit
  );
}

async function main() {
  console.log('[JobScraper] Fetching job postings...');

  const [simplify, newgrad, hn, remoteok, wework, linkedin, indeed] = await Promise.all([
    fetchSimplifyJobs(10),
    fetchNewGradPositions(10),
    fetchHackerNewsHiring(15),
    fetchRemoteOK(10),
    fetchWeWorkRemotely(10),
    fetchLinkedInJobs(10),
    fetchIndeedJobs(10),
  ]);

  // ── Filter: Chỉ giữ jobs phù hợp với tech profile ──
  const REQUIRED_KEYWORDS = [
    'backend', 'software engineer', 'node.js', 'javascript', 'typescript',
    'devops', 'fullstack', 'full-stack', 'python', 'cloud', 'infrastructure',
    'swe', 'intern', 'developer', 'programming', 'api', 'database',
    'kubernetes', 'docker', 'microservices', 'distributed systems',
  ];
  const EXCLUDE_KEYWORDS = [
    'store manager', 'data entry', 'paralegal', 'sales agent',
    'no experience required', 'military', 'national guard',
    'manufacturing', 'real estate', 'insurance agent', 'retail',
    'appointment setter', 'document review', 'outside sales',
    'operations roles', 'membership offers', 'assistant store',
    'financial accountant', 'account manager', 'credit card',
    'business strategy', 'oracle services', 'workday',
    'cyber', 'project scheduling', 'project assistant',
    'data analyst', 'analytics and bi', 'data warehouse',
    'msp service delivery', 'director of operations',
  ];

  function isRelevant(title = '', company = '', role = '') {
    const text = (title + ' ' + company + ' ' + role).toLowerCase();
    const hasRequired = REQUIRED_KEYWORDS.some(k => new RegExp(`\\b${k.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\b`, 'i').test(text));
    const hasExcluded = EXCLUDE_KEYWORDS.some(k => new RegExp(`\\b${k.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\b`, 'i').test(text));
    return hasRequired && !hasExcluded;
  }

  const rawJobs = [...simplify, ...newgrad, ...hn, ...remoteok, ...wework, ...linkedin, ...indeed];
  const filteredJobs = rawJobs.filter(j => isRelevant(j.title, j.company, j.role));

  if (filteredJobs.length < rawJobs.length) {
    console.log(`[JobScraper] Filtered: ${rawJobs.length} → ${filteredJobs.length} (removed ${rawJobs.length - filteredJobs.length} irrelevant)`);
  }

  // ── Dedup: Dùng SQLite DB để lọc trùng (không phụ thuộc Discord API) ──
  console.log(`[JobScraper] Kiểm tra SQLite DB để lọc trùng...`);
  const db = await getDb();
  
  // Tạo bảng sent_jobs nếu chưa có
  await runQuery(db, `
    CREATE TABLE IF NOT EXISTS sent_jobs (
      url TEXT PRIMARY KEY,
      sent_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Query tất cả URL đã gửi trong 7 ngày qua
  const sentRows = await runQuery(db, 
    "SELECT url FROM sent_jobs WHERE sent_at >= datetime('now', '-7 days')"
  );
  const sentUrls = new Set(sentRows.map(r => r.url));
  console.log(`[JobScraper] DB dedup: ${sentUrls.size} URLs đã gửi trong 7 ngày qua`);

  // Lọc ra những job chưa từng gửi
  const skipped = [];
  const dedupedJobs = filteredJobs.filter(j => {
    const url = j.link || '';
    if (sentUrls.has(url)) {
      skipped.push(j.company);
      return false;
    }
    return true;
  });

  if (skipped.length > 0) {
    console.log(`[JobScraper] SKIP ${skipped.length} đã gửi: ${skipped.slice(0, 5).join(', ')}${skipped.length > 5 ? '...' : ''}`);
  }
  console.log(`[JobScraper] Dedup: ${filteredJobs.length} → ${dedupedJobs.length} (removed ${skipped.length} trùng)`);

  if (dedupedJobs.length === 0) {
    console.log('[JobScraper] ✅ 0 job mới. Dedup hoạt động bình thường, không spam.');
    return;
  }

  // ── Quality scoring (soft ranking — keep all, sort by quality) ──
  for (const j of dedupedJobs) {
    j.quality = scoreContent({ title: j.role, url: j.link, source: j.source, description: j.company });
  }
  dedupedJobs.sort((a, b) => b.quality.score - a.quality.score);
  console.log(`[JobScraper] Quality ranked: ${dedupedJobs.length} jobs (best first)`);

  // Build Discord embed
  const jobsByType = {};
  for (const j of dedupedJobs) {
    if (!jobsByType[j.source]) jobsByType[j.source] = [];
    jobsByType[j.source].push(j);
  }

  const summary = Object.entries(jobsByType).map(([s, jobs]) => `${s}: ${jobs.length}`).join(' | ');

  const jobLines = dedupedJobs.slice(0, 15).map((j, i) => {
    const link = j.link && j.link !== '#' ? `[Apply](${j.link})` : '';
    const qTag = j.quality ? j.quality.tag : '';
    return `**${i + 1}.** ${qTag} [${j.source}] **${j.company}** — ${j.role} (${j.location}) ${link}`;
  });

  // Use PDT date for consistency
  const pdtDate = new Date().toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' });
  const avgQuality = (dedupedJobs.reduce((s, j) => s + (j.quality?.score || 0), 0) / dedupedJobs.length * 100).toFixed(0);
  const embed = {
    title: `💼 Job Alerts — ${pdtDate}`,
    description: [
      `📦 **Total:** ${dedupedJobs.length} | 📊 **By Source:** ${summary} | ⭐ **Avg Quality:** ${avgQuality}%`,
      ``,
      ...jobLines,
    ].join('\n').slice(0, 4000),
    color: 0x43b581,
    timestamp: new Date().toISOString(),
  };

  try {
    const res = await fetch(JOB_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [embed] }),
    });

    if (res.ok) {
      console.log('[JobScraper] ✅ Webhook sent successfully');
      // Lưu URL đã gửi vào DB
      for (const j of dedupedJobs) {
        try {
          await runQuery(db, 'INSERT OR IGNORE INTO sent_jobs (url) VALUES (?)', [j.link || '']);
        } catch { /* ignore dup */ }
      }
      console.log(`[JobScraper] ✅ Đã lưu ${dedupedJobs.length} URLs vào DB`);
    } else {
      console.error('[JobScraper] ❌ Webhook failed:', res.status, await res.text());
    }
  } catch (err) {
    console.error('[JobScraper] ❌ Webhook error:', err.message);
  }
}

main().catch(err => {
  console.error('[JobScraper] Fatal:', err.message);
});
