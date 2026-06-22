/**
 * scripts/nightly_scraper.js — Nightly source scraper
 *
 * Chạy hàng ngày lúc 2:00 AM PDT để scrape sources mới từ:
 * - GitHub trending repos
 * - YouTube tech videos
 * - Web search (Tavily)
 *
 * Usage: node scripts/nightly_scraper.js
 * Cron: 0 2 * * * (2:00 AM PDT)
 */

import 'dotenv/config';
import { getLogger } from '../lib/logger.js';
import { embedText } from '../lib/embeddings.js';
import { upsertDocument } from '../lib/vector_store.js';

const logger = getLogger('NightlyScraper');

// ── Config ──
const MAX_RESULTS_PER_SOURCE = 5;
const MAX_DOCS_TOTAL = 20;

/**
 * Scrape GitHub trending repos
 */
async function scrapeGitHub(topic = 'trending') {
  const results = [];
  try {
    const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(topic)}+stars:>1000&sort=stars&order=desc&per_page=${MAX_RESULTS_PER_SOURCE}`;
    const res = await fetch(url, {
      headers: { 'Accept': 'application/vnd.github.v3+json' },
    });
    if (!res.ok) throw new Error(`GitHub API ${res.status}`);
    const data = await res.json();
    for (const item of (data.items || [])) {
      results.push({
        source: 'github',
        title: item.full_name,
        url: item.html_url,
        content: `${item.description || ''}\n\nStars: ${item.stargazers_count}\nLanguage: ${item.language || 'N/A'}`,
        category: 'Backend',
      });
    }
  } catch (err) {
    logger.warn('[NightlyScraper] GitHub failed:', err.message);
  }
  return results;
}

/**
 * Scrape YouTube tech videos
 */
async function scrapeYouTube(topic = 'technology programming') {
  const results = [];
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    logger.debug('[NightlyScraper] No YOUTUBE_API_KEY, skipping');
    return results;
  }
  try {
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(topic)}&type=video&order=date&maxResults=${MAX_RESULTS_PER_SOURCE}&key=${apiKey}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`YouTube API ${res.status}`);
    const data = await res.json();
    for (const item of (data.items || [])) {
      results.push({
        source: 'youtube',
        title: item.snippet.title,
        url: `https://youtube.com/watch?v=${item.id.videoId}`,
        content: item.snippet.description || '',
        category: 'Video',
      });
    }
  } catch (err) {
    logger.warn('[NightlyScraper] YouTube failed:', err.message);
  }
  return results;
}

/**
 * Scrape web search via Tavily
 */
async function scrapeWeb(topic = 'latest technology news programming') {
  const results = [];
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    logger.debug('[NightlyScraper] No TAVILY_API_KEY, skipping');
    return results;
  }
  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        query: topic,
        search_depth: 'basic',
        max_results: MAX_RESULTS_PER_SOURCE,
        include_answer: true,
      }),
    });
    if (!res.ok) throw new Error(`Tavily API ${res.status}`);
    const data = await res.json();
    for (const item of (data.results || [])) {
      results.push({
        source: 'web',
        title: item.title || '',
        url: item.url || '',
        content: item.content || item.answer || '',
        category: 'General',
      });
    }
  } catch (err) {
    logger.warn('[NightlyScraper] Web search failed:', err.message);
  }
  return results;
}

/**
 * Main scraper function — called by cron or directly
 */
export async function runNightlyScraper(topic = 'technology programming') {
  const startTime = Date.now();
  logger.info('[NightlyScraper] Starting...');

  const allDocs = [];

  // Scrape all sources in parallel
  const [github, youtube, web] = await Promise.all([
    scrapeGitHub(topic),
    scrapeYouTube(topic),
    scrapeWeb(topic),
  ]);

  allDocs.push(...github, ...youtube, ...web);

  // Limit total docs
  const docs = allDocs.slice(0, MAX_DOCS_TOTAL);

  // Store in vector DB
  let stored = 0;
  for (const doc of docs) {
    try {
      const embedding = await embedText(doc.content.slice(0, 2000));
      await upsertDocument(
        `nightly:${doc.source}:${Date.now()}:${stored}`,
        { source: doc.source, category: doc.category, url: doc.url, title: doc.title },
        [doc.content],
        [embedding]
      );
      stored++;
    } catch (err) {
      logger.warn('[NightlyScraper] Failed to store doc:', err.message);
    }
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  const breakdown = {};
  for (const doc of docs) {
    breakdown[doc.source] = (breakdown[doc.source] || 0) + 1;
  }

  logger.info(`[NightlyScraper] Done: ${stored} docs stored in ${duration}s`);

  return { stored, breakdown, duration, total: docs.length };
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runNightlyScraper()
    .then(r => {
      console.log(`✅ Scraper done: ${r.stored} docs in ${r.duration}s`);
      process.exit(0);
    })
    .catch(err => {
      console.error('❌ Scraper failed:', err);
      process.exit(1);
    });
}
