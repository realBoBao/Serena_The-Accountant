/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Hybrid Search Router — Kiến trúc Tìm kiếm Lai
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 2 luồng tìm kiếm chạy song song:
 *
 * 🛰️ Luồng 1: Tavily — "Trinh sát mở đường" (General Web Scout)
 *    - Tìm kiếm mở rộng trên toàn bộ Internet
 *    - Kích hoạt: câu hỏi chung, tin tức, lỗi lạ, long-tail queries
 *    - Ưu điểm: Không bị mù thông tin
 *
 * 🎯 Luồng 2: Google Custom Search — "Thấu kính học thuật" (Specialized Lens)
 *    - Quét sâu vào 50 domains chuyên sâu (GitHub, StackOverflow, Arxiv, AWS Docs...)
 *    - Kích hoạt: tra cứu docs, fix bug, system design, bài báo khoa học
 *    - Ưu điểm: Độ chính xác cao, loại bỏ clickbait/SPO
 *
 * 🧠 Smart Router:
 *    - Intent Classification: phân loại câu hỏi → chọn luồng phù hợp
 *    - Circuit Breaker: Google fail → tự động fallback sang Tavily
 *    - Quota Optimization: Google chỉ gọi khi thực sự cần
 *
 * @module lib/hybrid_search
 */

import { getLogger } from './logger.js';

const logger = getLogger('HybridSearch');

// ── 50 Domains chuyên sâu cho Google Custom Search ──
// Đây là "ông trùm" trong làng công nghệ và học thuật
const TECH_DOMAINS = [
  // Code & Q/A
  'github.com',
  'stackoverflow.com',
  'stackexchange.com',
  'gitlab.com',
  'bitbucket.org',

  // Academic & Research
  'arxiv.org',
  'scholar.google.com',
  'researchgate.net',
  'semanticscholar.org',
  'dl.acm.org',
  'ieeexplore.ieee.org',
  'springer.com',
  'nature.com',
  'science.org',

  // Cloud & DevOps Docs
  'docs.aws.amazon.com',
  'cloud.google.com',
  'learn.microsoft.com',
  'docs.docker.com',
  'kubernetes.io',
  'terraform.io',
  'ansible.com',
  'jenkins.io',
  'grafana.com',
  'prometheus.io',

  // Language & Framework Docs
  'nodejs.org',
  'python.org',
  'docs.python.org',
  'golang.org',
  'rust-lang.org',
  'docs.oracle.com',
  'kotlinlang.org',
  'swift.org',
  'react.dev',
  'vuejs.org',
  'angular.io',
  'nextjs.org',
  'django-rest-framework.org',
  'flask.palletsprojects.com',
  'spring.io',
  'laravel.com',

  // Tech Blogs & News
  'dev.to',
  'hashnode.dev',
  'hackernews.com',
  'news.ycombinator.com',
  'techcrunch.com',
  'theverge.com',
  'wired.com',
  'arstechnica.com',
  'infoq.com',
  'dzone.com',
  'medium.com',
  'freecodecamp.org',
];

// ── Intent Classification ──
// Bộ từ khóa kích hoạt Google Specialized Lens
const TECH_KEYWORDS = [
  // Bug & Error
  'lỗi', 'bug', 'error', 'fix', 'debug', 'crash', 'exception', 'traceback',
  'sửa lỗi', 'khắc phục', 'troubleshoot',

  // Docs & API
  'docs', 'documentation', 'api', 'reference', 'guide', 'tutorial',
  'hướng dẫn', 'tài liệu', 'tham chiếu',

  // System Design & Architecture
  'system design', 'architecture', 'thiết kế hệ thống', 'kiến trúc',
  'microservices', 'distributed', 'scalability', 'high availability',

  // Algorithm & Data Structure
  'thuật toán', 'algorithm', 'data structure', 'cấu trúc dữ liệu',
  'complexity', 'big o', 'time complexity', 'space complexity',

  // Cloud & DevOps
  'aws', 'azure', 'gcp', 'docker', 'kubernetes', 'k8s', 'terraform',
  'ci/cd', 'devops', 'deployment', 'infrastructure',

  // Database
  'database', 'sql', 'nosql', 'mongodb', 'postgresql', 'mysql',
  'redis', 'elasticsearch', 'cassandra', 'dynamodb',

  // Programming Languages
  'node.js', 'python', 'java', 'golang', 'rust', 'c++', 'typescript',
  'javascript', 'kotlin', 'swift', 'php', 'ruby', 'c#',

  // Frameworks
  'react', 'vue', 'angular', 'nextjs', 'django', 'flask', 'spring',
  'laravel', 'express', 'fastapi', 'nestjs',

  // Research & Academic
  'arxiv', 'paper', 'research', 'nghiên cứu', 'bài báo',
  'machine learning', 'deep learning', 'ai', 'neural network',

  // Security
  'security', 'authentication', 'authorization', 'encryption',
  'jwt', 'oauth', 'ssl', 'vulnerability',
];

/**
 * Kiểm tra câu hỏi có phải technical query không
 */
function isTechnicalQuery(query) {
  const lower = query.toLowerCase();
  return TECH_KEYWORDS.some(kw => lower.includes(kw));
}

/**
 * 🎯 Luồng 2: Google Custom Search — Thấu kính học thuật
 * Quét sâu vào 50 domains chuyên sâu
 *
 * @param {string} query - Câu hỏi tìm kiếm
 * @param {number} num - Số kết quả (default 5)
 * @returns {Promise<Array>} Kết quả tìm kiếm với score
 */
export async function searchGoogleDocs(query, num = 5) {
  const apiKey = process.env.GOOGLE_SEARCH_API_KEY;
  const cxId = process.env.GOOGLE_SEARCH_CX_ID;

  if (!apiKey || !cxId) {
    logger.debug('[GoogleLens] No API key or CX ID');
    return [];
  }

  try {
    // Thêm domain filters vào query để tăng độ chính xác
    const domainFilter = TECH_DOMAINS.slice(0, 10).map(d => `site:${d}`).join(' OR ');
    const enhancedQuery = `${query} (${domainFilter})`;

    const url = `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${cxId}&q=${encodeURIComponent(enhancedQuery)}&num=${num}`;
    const res = await fetch(url);

    if (!res.ok) {
      if (res.status === 403) {
        logger.warn('[GoogleLens] Quota exceeded or invalid key');
      } else {
        logger.debug('[GoogleLens] API error:', res.status);
      }
      return [];
    }

    const data = await res.json();
    const items = data?.items || [];
    if (!items.length) return [];

    return items.map((item, index) => {
      // Score: dựa trên vị trí (position) + domain authority
      const positionScore = 1 - (index * 0.1); // 1st = 1.0, 2nd = 0.9, ...
      const url = item.link || '';
      const isTopDomain = TECH_DOMAINS.slice(0, 10).some(d => url.includes(d));
      const domainBonus = isTopDomain ? 0.2 : 0;
      const score = Math.min(1.0, Math.max(0.1, positionScore + domainBonus));

      return {
        title: item.title || 'No title',
        description: item.snippet || 'No description',
        url: item.link || '',
        source: 'google',
        score,
        displayUrl: item.displayLink || '',
      };
    });
  } catch (err) {
    logger.debug('[GoogleLens] Error:', err?.message || err);
    return [];
  }
}

/**
 * 🛰️ Luồng 1: Tavily — Trinh sát diện rộng
 * Tìm kiếm mở rộng trên toàn bộ Internet
 *
 * @param {string} query - Câu hỏi tìm kiếm
 * @param {number} maxResults - Số kết quả (default 5)
 * @returns {Promise<Array>} Kết quả tìm kiếm với score
 */
export async function searchTavily(query, maxResults = 5) {
  const tavilyApiKey = process.env.TAVILY_API_KEY;
  if (!tavilyApiKey) {
    logger.debug('[TavilyScout] No API key');
    return [];
  }

  try {
    const { tavily } = await import('@tavily/core');
    const client = tavily({ apiKey: tavilyApiKey });
    const results = await client.search(query, {
      searchDepth: 'basic',
      includeAnswer: false,
      maxResults: maxResults * 2, // Lấy nhiều hơn để filter
    });

    const items = results?.results || [];
    if (!items.length) return [];

    return items.slice(0, maxResults).map((item, index) => ({
      title: item.title || 'Web Result',
      description: item.content?.slice(0, 300) || 'No description',
      url: item.url || '',
      source: 'web',
      score: 0.5 - (index * 0.05), // Web = score trung bình, giảm dần theo vị trí
    }));
  } catch (err) {
    logger.debug('[TavilyScout] Error:', err?.message || err);
    return [];
  }
}

/**
 * 🧠 SMART ROUTER — Quyết định dùng động cơ nào
 *
 * Chiến lược:
 * 1. Technical query + Google configured → Google trước, fallback Tavily
 * 2. General query → Tavily only
 * 3. Google fail → tự động fallback sang Tavily
 *
 * @param {string} query - Câu hỏi tìm kiếm
 * @param {object} options - Tùy chọn
 * @returns {Promise<{results: Array, source: string}>}
 */
export async function hybridWebScout(query, options = {}) {
  const { forceGoogle = false, forceTavily = false, maxResults = 5 } = options;

  const hasGoogle = process.env.GOOGLE_SEARCH_API_KEY && process.env.GOOGLE_SEARCH_CX_ID;
  const hasTavily = !!process.env.TAVILY_API_KEY;
  const technical = isTechnicalQuery(query);

  logger.info(`[SmartRouter] Query: "${query.slice(0, 50)}..." | Technical: ${technical} | Google: ${hasGoogle} | Tavily: ${hasTavily}`);

  // ── Luồng 1: Google trước (technical query) ──
  if ((technical || forceGoogle) && hasGoogle && !forceTavily) {
    const googleResults = await searchGoogleDocs(query, maxResults);
    if (googleResults.length > 0) {
      logger.info(`[SmartRouter] ✓ Google returned ${googleResults.length} results`);
      return { results: googleResults, source: 'google' };
    }
    logger.info('[GoogleLens] No results, falling back to Tavily...');
  }

  // ── Luồng 2: Tavily (general query hoặc fallback) ──
  if (hasTavily && !forceGoogle) {
    const tavilyResults = await searchTavily(query, maxResults);
    if (tavilyResults.length > 0) {
      logger.info(`[SmartRouter] ✓ Tavily returned ${tavilyResults.length} results`);
      return { results: tavilyResults, source: 'tavily' };
    }
  }

  // ── Luồng 3: Google (nếu Tavily được force nhưng fail) ──
  if (hasGoogle && forceTavily) {
    const googleResults = await searchGoogleDocs(query, maxResults);
    if (googleResults.length > 0) {
      return { results: googleResults, source: 'google' };
    }
  }

  logger.warn('[SmartRouter] ✗ No results from any source');
  return { results: [], source: 'none' };
}

/**
 * Format kết quả hybrid search thành context string cho LLM
 */
export function formatHybridContext(results, source) {
  if (!results || results.length === 0) return '';

  const sourceLabel = source === 'google' ? '🎯 Google Specialized Lens' : '🌍 Tavily General Web';
  const items = results.map((r, i) => {
    const score = r.score != null ? ` [score: ${r.score.toFixed(2)}]` : '';
    return `[${i + 1}] ${r.title}${score}\nURL: ${r.url}\n${r.description?.slice(0, 300) || ''}`;
  }).join('\n\n---\n\n');

  return `[${sourceLabel}]\n\n${items}`;
}

export { isTechnicalQuery, TECH_DOMAINS, TECH_KEYWORDS };
