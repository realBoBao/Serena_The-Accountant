/**
 * lib/youtube_analyzer.js — YouTube Video & Channel Analyzer
 *
 * Tích hợp chức năng từ: youtube_transcript.js, youtube_channel_videos.js
 *
 * Cung cấp:
 *   - getTranscript(videoId)     → Lấy transcript/subtitle từ YouTube
 *   - getChannelVideos(channelId) → Lấy danh sách videos từ channel
 *   - analyzeVideo(videoId)      → Phân tích video → summary + flashcards
 *   - searchAndAnalyze(query)    → Tìm kiếm + phân tích top videos
 *
 * Được gọi bởi:
 * - discord_bot.js (!analyze <youtube_url>)
 * - REST API (/api/analyze)
 * - RagAgent.js (khi cần phân tích video)
 */

import 'dotenv/config';
import { ask as llmAsk } from './llm.js';
import { getLogger } from './logger.js';

const logger = getLogger('YouTubeAnalyzer');
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || '';

// ── Transcript Extraction ───────────────────────────────

/**
 * Lấy transcript từ YouTube video (dùng youtubei hoặc yt-dlp fallback)
 */
export async function getTranscript(videoId) {
  // Method 1: Thử dùng youtube-transcript-api (nếu có)
  try {
    const { YoutubeTranscript } = await import('youtube-transcript');
    const transcript = await YoutubeTranscript.fetchTranscript(videoId);
    if (transcript && transcript.length > 0) {
      return transcript.map(t => t.text).join(' ');
    }
  } catch {
    // Fallback to method 2
  }

  // Method 2: Dùng YouTube Data API v3 (có caption tracks)
  if (YOUTUBE_API_KEY) {
    try {
      // Lấy caption tracks
      const captionsRes = await fetch(
        `https://www.googleapis.com/youtube/v3/captions?part=snippet&videoId=${videoId}&key=${YOUTUBE_API_KEY}`
      );
      const captionsData = await captionsRes.json();
      if (captionsData.items && captionsData.items.length > 0) {
        // Lấy caption đầu tiên
        const captionId = captionsData.items[0].id;
        const captionRes = await fetch(
          `https://www.googleapis.com/youtube/v3/captions/${captionId}?key=${YOUTUBE_API_KEY}`,
          { headers: { 'Accept': 'text/plain' } }
        );
        if (captionRes.ok) {
          return await captionRes.text();
        }
      }
    } catch (err) {
      logger.debug('[YouTubeAnalyzer] Caption API error:', err.message);
    }
  }

  // Method 3: Dùng yt-dlp (nếu có trong PATH)
  try {
    const { execSync } = await import('child_process');
    const result = execSync(
      `yt-dlp --write-auto-sub --sub-lang en,vi --skip-download --convert-subs srt -o /tmp/yt_${videoId} https://youtube.com/watch?v=${videoId}`,
      { timeout: 30000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
    // Đọc file SRT
    const fs = await import('fs');
    const srtPath = `/tmp/yt_${videoId}.en.srt`;
    if (fs.existsSync(srtPath)) {
      const srt = fs.readFileSync(srtPath, 'utf8');
      // Parse SRT → plain text
      const text = srt
        .replace(/\d+\n\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}\n/g, '')
        .replace(/\n\n/g, ' ')
        .replace(/\n/g, ' ')
        .trim();
      fs.unlinkSync(srtPath);
      return text;
    }
  } catch {
    // yt-dlp không có hoặc fail
  }

  logger.warn(`[YouTubeAnalyzer] No transcript available for ${videoId}`);
  return null;
}

/**
 * Lấy thông tin video từ YouTube Data API
 */
export async function getVideoInfo(videoId) {
  if (!YOUTUBE_API_KEY) return null;

  try {
    const res = await fetch(
      `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,statistics&id=${videoId}&key=${YOUTUBE_API_KEY}`
    );
    const data = await res.json();
    if (data.items && data.items.length > 0) {
      const v = data.items[0];
      return {
        id: videoId,
        title: v.snippet.title,
        description: v.snippet.description,
        channelTitle: v.snippet.channelTitle,
        channelId: v.snippet.channelId,
        publishedAt: v.snippet.publishedAt,
        duration: v.contentDetails.duration,
        viewCount: Number(v.statistics.viewCount || 0),
        likeCount: Number(v.statistics.likeCount || 0),
        commentCount: Number(v.statistics.commentCount || 0),
        tags: v.snippet.tags || [],
        thumbnail: v.snippet.thumbnails?.high?.url || v.snippet.thumbnails?.default?.url,
      };
    }
  } catch (err) {
    logger.warn('[YouTubeAnalyzer] getVideoInfo error:', err.message);
  }
  return null;
}

/**
 * Lấy danh sách videos từ channel
 */
export async function getChannelVideos(channelId, maxResults = 10) {
  if (!YOUTUBE_API_KEY) return [];

  try {
    // Lấu uploads playlist ID
    const channelRes = await fetch(
      `https://www.googleapis.com/youtube/v3/channels?part=contentDetails&id=${channelId}&key=${YOUTUBE_API_KEY}`
    );
    const channelData = await channelRes.json();
    if (!channelData.items?.[0]) return [];

    const uploadsPlaylistId = channelData.items[0].contentDetails.relatedPlaylists.uploads;

    // Lấy videos từ playlist
    const playlistRes = await fetch(
      `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=${uploadsPlaylistId}&maxResults=${maxResults}&key=${YOUTUBE_API_KEY}`
    );
    const playlistData = await playlistRes.json();

    return (playlistData.items || []).map(item => ({
      id: item.snippet.resourceId.videoId,
      title: item.snippet.title,
      description: item.snippet.description,
      publishedAt: item.snippet.publishedAt,
      thumbnail: item.snippet.thumbnails?.high?.url,
    }));
  } catch (err) {
    logger.warn('[YouTubeAnalyzer] getChannelVideos error:', err.message);
    return [];
  }
}

/**
 * Phân tích video → summary + flashcards
 */
export async function analyzeVideo(videoId) {
  logger.info(`[YouTubeAnalyzer] Analyzing video ${videoId}...`);

  // 1. Lấy video info
  const info = await getVideoInfo(videoId);

  // 2. Lấy transcript
  const transcript = await getTranscript(videoId);
  if (!transcript) {
    // Fallback: phân tích từ title + description
    if (info) {
      return analyzeText(
        `Title: ${info.title}\n\nDescription: ${info.description}\n\nChannel: ${info.channelTitle}`,
        'video_meta',
        { videoId, ...info }
      );
    }
    return null;
  }

  // 3. Phân tích transcript bằng LLM
  const textToAnalyze = transcript.length > 10000 ? transcript.slice(0, 10000) : transcript;
  const analysis = await analyzeText(textToAnalyze, 'video_transcript', { videoId, ...info });

  return {
    ...analysis,
    videoId,
    videoInfo: info,
    transcriptLength: transcript.length,
  };
}

/**
 * Phân tích text (dùng cho transcript hoặc meta)
 */
async function analyzeText(text, type = 'text', meta = {}) {
  if (!text || text.trim().length < 50) return null;

  const prompt = `Phân tích nội dung video sau và trả về JSON:

\`\`\`
${text.slice(0, 8000)}
\`\`\`

Trả về JSON:
{
  "summary": ["bullet1", "bullet2", "bullet3"],
  "flashcards": [{"question":"...", "answer":"..."}],
  "key_concepts": ["concept1", "concept2"],
  "technologies": ["tech1", "tech2"],
  "category": "Backend|AI|DevOps|Math|Algorithms|Other"
}`;

  try {
    const result = await llmAsk(prompt, { maxTokens: 1500, temperature: 0.2 });
    const jsonMatch = result.answer.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    return { ...JSON.parse(jsonMatch[0]), type, source: meta.videoId || meta.source };
  } catch (err) {
    logger.warn('[YouTubeAnalyzer] analyzeText error:', err.message);
    return null;
  }
}

/**
 * Tìm kiếm + phân tích top videos
 */
export async function searchAndAnalyze(query, maxResults = 3) {
  if (!YOUTUBE_API_KEY) return [];

  try {
    const searchRes = await fetch(
      `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&type=video&maxResults=${maxResults}&order=relevance&key=${YOUTUBE_API_KEY}`
    );
    const searchData = await searchRes.json();
    const videoIds = (searchData.items || []).map(i => i.id.videoId);

    const results = [];
    for (const id of videoIds) {
      const analysis = await analyzeVideo(id);
      if (analysis) results.push(analysis);
    }
    return results;
  } catch (err) {
    logger.warn('[YouTubeAnalyzer] searchAndAnalyze error:', err.message);
    return [];
  }
}

/**
 * Parse YouTube URL → videoId hoặc channelId
 */
export function parseYoutubeUrl(url) {
  if (!url) return null;

  // youtube.com/watch?v=xxx
  const watchMatch = url.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
  if (watchMatch) return { type: 'video', id: watchMatch[1] };

  // youtu.be/xxx
  const shortMatch = url.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
  if (shortMatch) return { type: 'video', id: shortMatch[1] };

  // youtube.com/channel/xxx
  const channelMatch = url.match(/channel\/([a-zA-Z0-9_-]+)/);
  if (channelMatch) return { type: 'channel', id: channelMatch[1] };

  // youtube.com/@handle
  const handleMatch = url.match(/@([a-zA-Z0-9_.-]+)/);
  if (handleMatch) return { type: 'handle', id: handleMatch[1] };

  return null;
}

export default { getTranscript, getVideoInfo, getChannelVideos, analyzeVideo, searchAndAnalyze, parseYoutubeUrl };
