/**
 * AnalysisAgent — Phân tích tổng hợp (Repo + Video + Web)
 *
 * Tích hợp chức năng từ: combined-agent.js
 *
 * Vai trò: Nhận URL (GitHub repo / YouTube video / web page) → Phân tích → Tạo flashcards + summary
 *
 * Được gọi bởi:
 * - discord_bot.js (!analyze <url>)
 * - REST API (/api/analyze)
 * - PlannerAgent (khi cần phân tích resource)
 */

import { getLogger } from '../lib/logger.js';
import { analyzeRepo, analyzeText, analyzePdf } from '../lib/repo_analyzer.js';
import { analyzeVideo, parseYoutubeUrl } from '../lib/youtube_analyzer.js';
import { exportToCsv } from '../lib/anki_export.js';
import { addMemory } from '../lib/memory_manager.js';

const logger = getLogger('AnalysisAgent');

/**
 * Phân tích URL (tự động nhận diện loại)
 * @param {string} url — GitHub repo URL / YouTube URL / web URL
 * @param {object} options — { createFlashcards, exportAnki, maxDepth }
 */
export async function analyzeUrl(url, options = {}) {
  const { createFlashcards = true, exportAnki = false, maxDepth = 3 } = options;

  logger.info(`[AnalysisAgent] Analyzing: ${url}`);

  // 1. Nhận diện loại URL
  const youtubeInfo = parseYoutubeUrl(url);
  const githubMatch = url.match(/github\.com\/([^\/]+)\/([^\/\?#]+)/);

  let result;

  if (youtubeInfo?.type === 'video') {
    // YouTube video
    result = await analyzeVideo(youtubeInfo.id);
  } else if (youtubeInfo?.type === 'channel' || youtubeInfo?.type === 'handle') {
    // YouTube channel — phân tích top videos
    result = await analyzeChannel(youtubeInfo.id, youtubeInfo.type, maxDepth);
  } else if (githubMatch) {
    // GitHub repo
    const [, owner, repo] = githubMatch;
    result = await analyzeRepo(owner, repo, process.env.GITHUB_TOKEN);
  } else {
    // Web page — fetch content rồi analyze
    result = await analyzeWebPage(url);
  }

  if (!result) {
    return { success: false, error: 'Không thể phân tích URL này', url };
  }

  // 2. Lưu vào memory nếu có flashcards
  if (createFlashcards && result.flashcards?.length > 0) {
    for (const card of result.flashcards.slice(0, 20)) {
      await addMemory({
        id: `analysis:${Date.now()}:${Math.random().toString(36).slice(2,8)}`,
        type: 'analysis',
        source: url,
        sourceUrl: url,
        content: `${card.question}\n${card.answer}`,
        tags: [result.category || 'analysis', 'auto-generated'],
      });
    }
  }

  // 3. Export sang Anki nếu yêu cầu
  if (exportAnki && result.flashcards?.length > 0) {
    const ankiResult = await exportToCsv(result.flashcards, `./exports/analysis_${Date.now()}.csv`);
    result.ankiExport = ankiResult;
  }

  return { success: true, url, ...result };
}

/**
 * Phân tích YouTube channel
 */
async function analyzeChannel(channelId, type, maxDepth) {
  const { getChannelVideos, analyzeVideo } = await import('../lib/youtube_analyzer.js');

  let videos;
  if (type === 'handle') {
    // Cần resolve handle → channelId (dùng YouTube Data API)
    videos = []; // TODO: implement handle resolution
  } else {
    videos = await getChannelVideos(channelId, maxDepth);
  }

  const analyses = [];
  for (const video of videos.slice(0, maxDepth)) {
    const analysis = await analyzeVideo(video.id);
    if (analysis) analyses.push(analysis);
  }

  return {
    type: 'channel',
    channelId,
    videosAnalyzed: analyses.length,
    flashcards: analyses.flatMap(a => a.flashcards || []),
    summary: analyses.flatMap(a => a.summary || []),
    category: analyses[0]?.category || 'Other',
  };
}

/**
 * Phân tích web page
 */
async function analyzeWebPage(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AIBrain/1.0)' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;

    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/pdf')) {
      const buffer = Buffer.from(await res.arrayBuffer());
      return analyzePdf(buffer, url);
    }

    const text = await res.text();
    // Strip HTML tags đơn giản
    const plainText = text
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    return analyzeText(plainText.slice(0, 8000), 'web', { source: url });
  } catch (err) {
    logger.warn('[AnalysisAgent] analyzeWebPage error:', err.message);
    return null;
  }
}

/**
 * Batch analyze nhiều URLs
 */
export async function analyzeBatch(urls, options = {}) {
  const results = [];
  for (const url of urls) {
    const result = await analyzeUrl(url, options);
    results.push(result);
  }
  return results;
}

export default { analyzeUrl, analyzeBatch };
