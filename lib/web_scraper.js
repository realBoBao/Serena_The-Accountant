/**
 * lib/web_scraper.js — Local Firecrawl (Readability + Turndown)
 *
 * $0 API cost. No external API keys. Runs entirely on your server.
 * Combines mozilla/readability (extracts clean article content from HTML)
 * with turndown (converts HTML → Markdown).
 *
 * Usage:
 *   import { scrapeUrl } from './lib/web_scraper.js';
 *   const md = await scrapeUrl('https://example.com/article');
 *   console.log(md); // Clean Markdown, no ads, no nav, no JS
 *
 * @module lib/web_scraper
 */

import { getLogger } from './logger.js';
const logger = getLogger('WebScraper');

// ── Simple in-memory URL → markdown cache ──
let _cache = null;

/**
 * Scrape a URL and return clean Markdown.
 *
 * @param {string} url — URL to scrape
 * @param {object} [opts]
 * @param {number} [opts.timeout=10000] — Fetch timeout in ms
 * @param {boolean} [opts.useCache=true] — Use in-memory cache
 * @returns {string|null} Clean Markdown or null on failure
 */
export async function scrapeUrl(url, opts = {}) {
  const { timeout = 10000, useCache = true } = opts;

  // Check cache
  if (useCache && _cache?.has(url)) {
    logger.debug(`[WebScraper] Cache hit: ${url.slice(0, 80)}`);
    return _cache.get(url);
  }

  try {
    // 1. Fetch raw HTML
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

    if (!res.ok) {
      logger.warn(`[WebScraper] HTTP ${res.status} for ${url.slice(0, 80)}`);
      return null;
    }

    const html = await res.text();

    // 2. Extract clean article content with Readability
    const { JSDOM } = await import('jsdom');
    const doc = new JSDOM(html, { url });
    const { Readability } = await import('@mozilla/readability');
    const reader = new Readability(doc.window.document);
    const article = reader.parse();

    if (!article) {
      logger.warn(`[WebScraper] Readability returned null for ${url.slice(0, 80)}`);
      return null;
    }

    // 3. Convert HTML → Markdown with Turndown
    const TurndownService = (await import('turndown')).default;
    const td = new TurndownService({
      headingStyle: 'atx',
      codeBlockStyle: 'fenced',
      bulletListMarker: '-',
    });
    const markdown = td.turndown(article.content);

    // Build result with metadata header
    const result = `# ${article.title || 'Untitled'}\n\n` +
      `> Source: ${url}\n` +
      `> Scraped: ${new Date().toISOString()}\n\n` +
      markdown;

    // Cache it
    if (useCache) {
      if (!_cache) _cache = new Map();
      _cache.set(url, result);
    }

    logger.info(`[WebScraper] ✓ Scraped ${url.slice(0, 80)} → ${result.length} chars`);
    return result;

  } catch (err) {
    if (err.name === 'AbortError') {
      logger.warn(`[WebScraper] Timeout for ${url.slice(0, 80)}`);
    } else {
      logger.warn(`[WebScraper] Failed ${url.slice(0, 80)}: ${err.message}`);
    }
    return null;
  }
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
 * Clear the URL cache.
 */
export function clearCache() {
  if (_cache) _cache.clear();
}

export default { scrapeUrl, scrapeUrls, clearCache };
