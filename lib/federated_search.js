/**
 * lib/federated_search.js — Multi-source search với dedup + emoji counter
 * 
 * Sources: Tavily, Jina, SearXNG (self-hosted)
 * Chạy song song tất cả sources, dedup theo URL, sort theo score.
 * 
 * Usage:
 *   import { federatedSearch, getDuplicateEmoji } from './lib/federated_search.js';
 *   const results = await federatedSearch('backend engineer remote');
 *   const emoji = getDuplicateEmoji('https://example.com/job/123');
 */

import { DatabaseSync } from 'node:sqlite';

// ── Duplicate Counter (SQLite-backed) ───────────────────────────────────────

function getDb() {
  const db = new DatabaseSync('./data/app.db');
  db.exec(`CREATE TABLE IF NOT EXISTS sent_urls (
    url TEXT PRIMARY KEY,
    count INTEGER DEFAULT 1,
    first_sent TEXT DEFAULT (datetime('now')),
    last_sent TEXT DEFAULT (datetime('now'))
  )`);
  return db;
}

/**
 * Record URL as sent, return duplicate count (1 = first time, 2+ = duplicate)
 */
export function recordSentUrl(url) {
  if (!url) return 1;
  const db = getDb();
  try {
    const existing = db.prepare('SELECT count FROM sent_urls WHERE url = ?').get(url);
    if (existing) {
      const newCount = existing.count + 1;
      db.prepare('UPDATE sent_urls SET count = ?, last_sent = datetime(\'now\') WHERE url = ?').run(newCount, url);
      return newCount;
    } else {
      db.prepare('INSERT INTO sent_urls (url) VALUES (?)').run(url);
      return 1;
    }
  } finally {
    db.close();
  }
}

/**
 * Get emoji indicator for duplicate count
 * 1 = 🆕 (new), 2 = 🔄🔄, 3 = ⚠️⚠️⚠️, 4+ = ♻️ x{count}
 */
export function getDuplicateEmoji(count) {
  if (!count || count <= 1) return '🆕';
  if (count === 2) return '🔄🔄';
  if (count === 3) return '⚠️⚠️⚠️';
  return `♻️ x${count}`;
}

/**
 * Check if URL was sent in last N days (for dedup before sending)
 */
export function wasUrlSentRecently(url, days = 7) {
  if (!url) return false;
  const db = getDb();
  try {
    const row = db.prepare(
      'SELECT 1 FROM sent_urls WHERE url = ? AND last_sent >= datetime(\'now\', ?)'
    ).get(url, `-${days} days`);
    return !!row;
  } finally {
    db.close();
  }
}

// ── Search Sources ──────────────────────────────────────────────────────────

/**
 * Tavily Search — AI-optimized, requires API key
 */
async function searchTavily(query, limit = 5) {
  const key = process.env.TAVILY_API_KEY;
  if (!key) return [];
  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: key, query, max_results: limit, days: 7 }),
    });
    if (!res.ok) return [];
    const d = await res.json();
    return (d.results || []).map(r => ({
      title: r.title || 'Untitled',
      url: r.url || '',
      description: (r.content || '').slice(0, 200),
      source: 'Tavily',
      score: r.score || 0.85,
    }));
  } catch { return []; }
}

/**
 * Jina Search — Free, no key required (rate limited)
 */
async function searchJina(query, limit = 5) {
  try {
    const key = process.env.JINA_API_KEY;
    const headers = {
      'Accept': 'application/json',
      'X-Retain-Images': 'none',
      'X-Return-Format': 'text',
    };
    // Nếu có API key thì thêm auth header (tránh block)
    if (key && !key.includes('your_')) {
      headers['Authorization'] = `Bearer ${key}`;
    }
    const res = await fetch(`https://s.jina.ai/${encodeURIComponent(query)}`, { headers });
    if (!res.ok) return [];
    const d = await res.json();
    return (d.data || []).slice(0, limit).map(r => ({
      title: r.title || 'Untitled',
      url: r.url || '',
      description: (r.description || r.content || '').slice(0, 200),
      source: 'Jina',
      score: 0.8,
    }));
  } catch { return []; }
}

/**
 * SearXNG — Self-hosted meta-search (free, no key)
 * Aggregates Google, Bing, DuckDuckGo, etc.
 */
async function searchSearXNG(query, limit = 5) {
  // Thử nhiều instances — public instances thường down/rate-limit
  const instances = [
    process.env.SEARXNG_URL,
    'http://localhost:8080',
    'https://searx.tiekoetter.com',
    'https://searx.be',
    'https://search.sapti.me',
  ].filter(Boolean);

  for (const baseUrl of instances) {
    try {
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(
        `${baseUrl}/search?q=${encodeURIComponent(query)}&format=json&categories=general`,
        { headers: { 'User-Agent': 'Serena-Brain/1.0' }, signal: controller.signal }
      );
      clearTimeout(tid);
      if (!res.ok) continue;
      const d = await res.json();
      const results = (d.results || []).slice(0, limit).map(r => ({
        title: r.title || 'Untitled',
        url: r.url || '',
        description: (r.content || '').slice(0, 200),
        source: 'SearXNG',
        score: r.score ? Math.min(1, r.score) : 0.75,
      }));
      if (results.length > 0) return results;
    } catch { /* try next instance */ }
  }
  return [];
}

/**
 * SearXNG for LinkedIn jobs — Google Dorking via SearXNG
 */
async function searchLinkedInJobs(query, limit = 5) {
  const baseUrl = process.env.SEARXNG_URL || 'http://localhost:8080';
  try {
    const dorkQuery = `site:linkedin.com/jobs "${query}" ("software engineer" OR "backend" OR "fullstack" OR "intern") ("remote" OR "hybrid")`;
    const res = await fetch(
      `${baseUrl}/search?q=${encodeURIComponent(dorkQuery)}&format=json&categories=general`,
      { headers: { 'User-Agent': 'Serena-Brain/1.0' } }
    );
    if (!res.ok) return [];
    const d = await res.json();
    return (d.results || []).slice(0, limit).map(r => ({
      title: r.title || 'Untitled',
      url: r.url || '',
      description: (r.content || '').slice(0, 200),
      source: 'LinkedIn (via SearXNG)',
      score: 0.8,
    }));
  } catch { return []; }
}

/**
 * SearXNG for Indeed jobs
 */
async function searchIndeedJobs(query, limit = 5) {
  const baseUrl = process.env.SEARXNG_URL || 'http://localhost:8080';
  try {
    const dorkQuery = `site:indeed.com "${query}" ("software engineer" OR "backend" OR "fullstack")`;
    const res = await fetch(
      `${baseUrl}/search?q=${encodeURIComponent(dorkQuery)}&format=json&categories=general`,
      { headers: { 'User-Agent': 'Serena-Brain/1.0' } }
    );
    if (!res.ok) return [];
    const d = await res.json();
    return (d.results || []).slice(0, limit).map(r => ({
      title: r.title || 'Untitled',
      url: r.url || '',
      description: (r.content || '').slice(0, 200),
      source: 'Indeed (via SearXNG)',
      score: 0.75,
    }));
  } catch { return []; }
}

// ── Main Federated Search ───────────────────────────────────────────────────

/**
 * Run all search sources in parallel, dedup, sort by score.
 * 
 * @param {string} query - Search query
 * @param {Object} [options]
 * @param {number} [options.limit=5] - Results per source
 * @param {boolean} [options.includeLinkedIn=false] - Include LinkedIn job search
 * @param {boolean} [options.includeIndeed=false] - Include Indeed job search
 * @returns {Array} Deduplicated, sorted results
 */
export async function federatedSearch(query, options = {}) {
  const { limit = 5, includeLinkedIn = false, includeIndeed = false } = options;

  const sources = [
    searchTavily(query, limit),
    searchJina(query, limit),
    searchSearXNG(query, limit),
  ];

  if (includeLinkedIn) sources.push(searchLinkedInJobs(query, limit));
  if (includeIndeed) sources.push(searchIndeedJobs(query, limit));

  const results = await Promise.allSettled(sources);

  // Merge all results
  const all = [];
  for (const r of results) {
    if (r.status === 'fulfilled' && Array.isArray(r.value)) {
      all.push(...r.value);
    }
  }

  // Dedup by URL
  const seen = new Set();
  const unique = all.filter(r => {
    if (!r.url || seen.has(r.url)) return false;
    seen.add(r.url);
    return true;
  });

  // Sort by score descending
  unique.sort((a, b) => (b.score || 0) - (a.score || 0));

  const successfulSources = results.filter(r => r.status === 'fulfilled' && r.value.length > 0).length;
  console.log(`[FederatedSearch] "${query}" → ${unique.length} results from ${successfulSources}/${results.length} sources`);

  return unique;
}

/**
 * Search specifically for jobs — includes LinkedIn + Indeed via SearXNG
 */
export async function federatedJobSearch(query, options = {}) {
  return federatedSearch(query, { ...options, includeLinkedIn: true, includeIndeed: true });
}
