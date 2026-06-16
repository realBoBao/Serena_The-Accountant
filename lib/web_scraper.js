/**
 * lib/web_scraper.js — Local Firecrawl (4-Tier Architecture)
 *
 * Tier 1: Readability + Turndown (clean Markdown from HTML)
 * Tier 2: Puppeteer fallback (bypass Cloudflare / JS-rendered sites)
 * Tier 3: SQLite URL cache (O(1) re-reads, offline archive)
 * Tier 4: Docker self-host ready (swappable backend via FIRECRARAWL_URL env)
 *
 * $0 API cost. No external API keys. Runs entirely on your server.
 *
 * Usage:
 *   import { scrapeUrl, scrapeUrls, clearCache, getCacheStats } from './lib/web_scraper.js';
 *   const md = await scrapeUrl('https://example.com/article');
 *   console.log(md); // Clean Markdown, no ads, no nav, no JS
 *
 * @module lib/web_scraper
 */

import { getLogger } from './logger.js';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import path from 'path';
const logger = getLogger('WebScraper');

// ── Tier 3: SQLite-backed URL cache ──
const CACHE_DB = path.resolve('./data/web_cache.sqlite');

let _dbPromise = null;

async function getDb() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = (async () => {
    const db = await open({ filename: CACHE_DB, driver: sqlite3.Database });
    await db.exec(`
      CREATE TABLE IF NOT EXISTS web_cache (
        url TEXT PRIMARY KEY,
        markdown TEXT NOT NULL,
        title TEXT,
        scraped_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      )
    `);
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_web_cache_expires ON web_cache(expires_at)`);
    return db;
  })();
  return _dbPromise;
}

async function cacheGet(url) {
  try {
    const db = await getDb();
    const row = await db.get('SELECT markdown FROM web_cache WHERE url = ? AND expires_at > ?', url, new Date().toISOString());
    if (row) {
      logger.debug(`[WebScraper:T3] Cache hit: ${url.slice(0, 80)}`);
      return row.markdown;
    }
  } catch { /* cache miss or DB error */ }
  return null;
}

async function cacheSet(url, markdown, title = '', ttlHours = 168) {
  try {
    const db = await getDb();
    const now = new Date();
    const expires = new Date(now.getTime() + ttlHours * 3600 * 1000);
    await db.run(`
      INSERT OR REPLACE INTO web_cache (url, markdown, title, scraped_at, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `, url, markdown, title, now.toISOString(), expires.toISOString());
  } catch { /* ignore cache write errors */ }
}

// ── Tier 2: Puppeteer fallback ──
let _puppeteer = null;

async function scrapeWithPuppeteer(url, timeout = 15000) {
  if (!_puppeteer) {
    try {
      _puppeteer = await import('puppeteer');
    } catch {
      logger.warn('[WebScraper:T2] puppeteer not installed — npm install puppeteer');
      return null;
    }
  }

  let browser = null;
  try {
    browser = await _puppeteer.default.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.goto(url, { waitUntil: 'networkidle2', timeout });
    const html = await page.content();
    logger.info(`[WebScraper:T2] Puppeteer fetched ${url.slice(0, 80)} → ${html.length} chars`);
    return html;
  } catch (err) {
    logger.warn(`[WebScraper:T2] Puppeteer failed ${url.slice(0, 80)}: ${err.message}`);
    return null;
  } finally {
    if (browser) try { await browser.close(); } catch { /* ignore */ }
  }
}

// ── Tier 4: Docker self-host config ──
const DOCKER_FIRECRAWL_URL = process.env.FIRECRARAWL_URL || null;

async function scrapeViaDocker(url) {
  if (!DOCKER_FIRECRAWL_URL) return null;
  try {
    const res = await fetch(`${DOCKER_FIRECRAWL_URL}/v1/scrape`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, formats: ['markdown'] }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.markdown || data?.data?.markdown || null;
  } catch {
    return null;
  }
}

// ── Core: HTML → clean Markdown (Tier 1) ──
async function htmlToMarkdown(html, url) {
  const { JSDOM } = await import('jsdom');
  const doc = new JSDOM(html, { url });
  const { Readability } = await import('@mozilla/readability');
  const reader = new Readability(doc.window.document);
  const article = reader.parse();

  if (!article) return null;

  const TurndownService = (await import('turndown')).default;
  const td = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
  });
  const markdown = td.turndown(article.content);

  return {
    title: article.title || 'Untitled',
    markdown: `# ${article.title || 'Untitled'}\n\n> Source: ${url}\n> Scraped: ${new Date().toISOString()}\n\n${markdown}`,
  };
}

// ── Main: scrapeUrl with all 4 tiers ──
/**
 * Scrape a URL and return clean Markdown.
 *
 * @param {string} url — URL to scrape
 * @param {object} [opts]
 * @param {number} [opts.timeout=10000] — Fetch timeout in ms
 * @param {boolean} [opts.useCache=true] — Use SQLite cache (Tier 3)
 * @param {boolean} [opts.usePuppeteer=true] — Allow Puppeteer fallback (Tier 2)
 * @param {boolean} [opts.useDocker=true] — Allow Docker Firecrawl (Tier 4)
 * @param {number} [opts.cacheTtlHours=168] — Cache TTL in hours (default 7 days)
 * @returns {string|null} Clean Markdown or null on failure
 */
export async function scrapeUrl(url, opts = {}) {
  const { timeout = 10000, useCache = true, usePuppeteer = true, useDocker = true, cacheTtlHours = 168 } = opts;

  // Tier 3: Check cache first
  if (useCache) {
    const cached = await cacheGet(url);
    if (cached) return cached;
  }

  // Tier 4: Docker self-host Firecrawl
  if (useDocker && DOCKER_FIRECRAWL_URL) {
    const dockerResult = await scrapeViaDocker(url);
    if (dockerResult) {
      if (useCache) await cacheSet(url, dockerResult, '', cacheTtlHours);
      logger.info(`[WebScraper:T4] Docker Firecrawl: ${url.slice(0, 80)} → ${dockerResult.length} chars`);
      return dockerResult;
    }
  }

  // Tier 1: Fetch + Readability + Turndown
  let html = null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9,vi;q=0.8',
      },
    });
    clearTimeout(timer);

    if (res.ok) {
      html = await res.text();
    } else {
      logger.warn(`[WebScraper:T1] HTTP ${res.status} for ${url.slice(0, 80)}`);
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      logger.warn(`[WebScraper:T1] Timeout for ${url.slice(0, 80)}`);
    } else {
      logger.warn(`[WebScraper:T1] Fetch failed ${url.slice(0, 80)}: ${err.message}`);
    }
  }

  // Tier 2: Puppeteer fallback if fetch failed or returned empty
  if (!html && usePuppeteer) {
    html = await scrapeWithPuppeteer(url);
  }

  if (!html) return null;

  // Convert HTML → Markdown
  let result;
  try {
    result = await htmlToMarkdown(html, url);
  } catch (err) {
    logger.warn(`[WebScraper] htmlToMarkdown failed: ${err.message}`);
    return null;
  }

  if (!result) {
    logger.warn(`[WebScraper] Readability returned null for ${url.slice(0, 80)}`);
    return null;
  }

  // Tier 3: Cache the result
  if (useCache) {
    await cacheSet(url, result.markdown, result.title, cacheTtlHours);
  }

  logger.info(`[WebScraper] ✓ Scraped ${url.slice(0, 80)} → ${result.markdown.length} chars`);
  return result.markdown;
}

/**
 * Scrape multiple URLs in parallel.
 *
 * @param {string[]} urls
 * @param {object} [opts] — Same as scrapeUrl
 * @returns {Map<string, string|null>} URL → Markdown
 */
export async function scrapeUrls(urls, opts = {}) {
  const results = new Map();
  await Promise.all(urls.map(async (url) => {
    results.set(url, await scrapeUrl(url, opts));
  }));
  return results;
}

/**
 * Clear the URL cache (Tier 3).
 */
export async function clearCache() {
  try {
    const db = await getDb();
    await db.run('DELETE FROM web_cache');
    logger.info('[WebScraper:T3] Cache cleared');
  } catch { /* ignore */ }
}

/**
 * Get cache statistics (Tier 3).
 */
export async function getCacheStats() {
  try {
    const db = await getDb();
    const row = await db.get('SELECT COUNT(*) as count, SUM(LENGTH(markdown)) as total_chars FROM web_cache');
    return { count: row?.count || 0, totalChars: row?.total_chars || 0 };
  } catch { return { count: 0, totalChars: 0 }; }
}

export default { scrapeUrl, scrapeUrls, clearCache, getCacheStats };
