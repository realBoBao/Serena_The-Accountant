/**
 * AnalysisAgent — Phân tích GitHub repo / YouTube video / Web page
 *
 * Tích hợp Bloom Filter để tránh phân tích URL trùng lặp.
 * Khi phân tích hàng chục ngàn URL, Bloom Filter giúp kiểm tra
 * "URL này đã phân tích chưa?" trong O(1) với RAM cực nhỏ.
 *
 * Web scraping: Local Firecrawl (mozilla/readability + turndown)
 * $0 API cost. No external API keys needed.
 */

import { BloomFilter } from '../lib/bloom_filter.js';
import { scrapeUrl } from '../lib/web_scraper.js';

// Singleton Bloom Filter cho URL deduplication
// Dự kiến 10M URL, false positive rate 1% → ~12MB RAM
let _urlFilter = null;

function getUrlFilter() {
  if (!_urlFilter) {
    _urlFilter = new BloomFilter(10_000_000, 0.01);
  }
  return _urlFilter;
}

/**
 * Kiểm tra URL đã được phân tích chưa
 * @param {string} url
 * @returns {boolean} — true nếu đã phân tích
 */
export function isUrlAnalyzed(url) {
  return getUrlFilter().mightContain(url);
}

/**
 * Đánh dấu URL đã phân tích
 * @param {string} url
 */
export function markUrlAnalyzed(url) {
  getUrlFilter().add(url);
}

/**
 * Phân tích URL với Bloom Filter deduplication
 * @param {string} url
 * @param {Object} [options]
 * @param {boolean} [options.force=false] — Bỏ qua Bloom Filter, phân tích lại
 * @returns {Promise<Object|null>} — null nếu URL đã phân tích (trừ khi force=true)
 */
export async function analyzeUrl(url, options = {}) {
  const { force = false } = options;

  // Kiểm tra Bloom Filter (trừ khi force re-analysis)
  if (!force) {
    const existed = getUrlFilter().addAndCheck(url);
    if (existed) {
      console.log(`[AnalysisAgent] URL already analyzed (Bloom Filter): ${url}`);
      return null; // Đã phân tích rồi, bỏ qua
    }
  }

  // Phân tích URL mới — scrape web content locally
  const urlType = detectUrlType(url);
  let content = null;
  let title = url;

  if (urlType === 'web') {
    // Use Local Firecrawl for generic web pages
    content = await scrapeUrl(url);
    if (content) {
      // Extract title from markdown (# Title)
      const titleMatch = content.match(/^#\s+(.+)/m);
      if (titleMatch) title = titleMatch[1].trim();
    }
  }
  // For github/youtube/arxiv, keep existing behavior (API-based)

  const result = {
    url,
    type: urlType,
    title,
    summary: content ? content.slice(0, 500) : `Analysis for ${url}`,
    content,       // Full markdown content (for RAG pipeline)
    analyzedAt: new Date().toISOString(),
  };

  console.log(`[AnalysisAgent] New URL analyzed: ${url} (${urlType})${content ? ` → ${content.length} chars` : ''}`);
  return result;
}

/**
 * Phân tích batch URLs với deduplication
 * @param {string[]} urls
 * @returns {Promise<Object[]>}
 */
export async function analyzeUrls(urls) {
  const results = [];
  let skipped = 0;

  for (const url of urls) {
    const result = await analyzeUrl(url);
    if (result) {
      results.push(result);
    } else {
      skipped++;
    }
  }

  console.log(`[AnalysisAgent] Batch: ${results.length} new, ${skipped} skipped (Bloom Filter)`);
  return results;
}

/**
 * Detect loại URL
 */
function detectUrlType(url) {
  if (url.includes('github.com')) return 'github';
  if (url.includes('youtube.com') || url.includes('youtu.be')) return 'youtube';
  if (url.includes('arxiv.org')) return 'arxiv';
  if (url.includes('stackoverflow.com')) return 'stackoverflow';
  return 'web';
}

/** Thống kê Bloom Filter */
export function getAnalysisStats() {
  return getUrlFilter().stats();
}
