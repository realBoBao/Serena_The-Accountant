/**
 * lib/http_client.js — Universal HTTP client for entire Serena project
 *
 * Tự động 100%:
 * - Retry khi 429/5xx/network error
 * - Rate-limit (max 5 concurrent)
 * - curl-impersonate fallback cho Cloudflare
 * - Python web scraper fallback cho HTML pages
 * - Response caching (5 minutes)
 *
 * Usage (thay thế tất cả fetch() calls):
 *   import { httpGet, httpPost, httpScrape } from './lib/http_client.js';
 *
 *   // GET JSON (auto retry)
 *   const data = await httpGet('https://api.github.com/repos/nodejs/node');
 *
 *   // POST JSON (auto retry)
 *   const result = await httpPost('https://leetcode.com/graphql', {
 *     query: '...',
 *     variables: { ... }
 *   });
 *
 *   // Scrape web page → Markdown (Python fallback)
 *   const markdown = await httpScrape('https://example.com/article');
 *
 *   // Scrape với CSS selector
 *   const content = await httpScrape('https://news.ycombinator.com', {
 *     selector: '.titleline > a'
 *   });
 */

import { fetchJson, fetchText, crawlHtml, scrapeWebPage } from './smart_fetcher.js';

// Re-export tất cả từ smart_fetcher
export { fetchJson, fetchText, crawlHtml, scrapeWebPage };

/**
 * GET request với auto-retry
 * @param {string} url
 * @param {Object} options
 * @returns {Promise<any>} JSON response
 */
export async function httpGet(url, options = {}) {
  return fetchJson(url, options);
}

/**
 * POST request với auto-retry
 * @param {string} url
 * @param {Object} body
 * @param {Object} options
 * @returns {Promise<any>} JSON response
 */
export async function httpPost(url, body, options = {}) {
  return fetchJson(url, { ...options, method: 'POST', body });
}

/**
 * Scrape web page → Markdown
 * @param {string} url
 * @param {Object} options
 * @param {string} options.selector — CSS selector để extract specific content
 * @param {number} options.maxLength — Max characters (default 10000)
 * @returns {Promise<string>} Markdown content
 */
export async function httpScrape(url, options = {}) {
  const result = await scrapeWebPage(url, options.maxLength || 10000);
  if (result.error) {
    console.warn(`[HttpClient] Scrape failed for ${url}: ${result.error}`);
    return '';
  }
  return result.markdown || '';
}

/**
 * Scrape nhiều URLs cùng lúc (song song)
 * @param {string[]} urls
 * @param {Object} options
 * @returns {Promise<Array<{url, markdown, error}>>}
 */
export async function httpScrapeAll(urls, options = {}) {
  const results = await Promise.all(
    urls.map(url => httpScrape(url, options).then(markdown => ({ url, markdown, error: null })))
  );
  return results;
}

/**
 * Check URL có accessible không (không cần fetch full content)
 * @param {string} url
 * @returns {Promise<{ok: boolean, status: number, error?: string}>}
 */
export async function httpCheck(url) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(url, {
      method: 'HEAD',
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    clearTimeout(timer);
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, status: 0, error: err.message };
  }
}

export default {
  httpGet,
  httpPost,
  httpScrape,
  httpScrapeAll,
  httpCheck,
  fetchJson,
  fetchText,
  crawlHtml,
  scrapeWebPage,
};
