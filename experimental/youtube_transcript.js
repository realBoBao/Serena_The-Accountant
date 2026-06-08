#!/usr/bin/env node
/**
 * youtube_transcript.js — Lấy transcript từ YouTube video
 * Usage: node youtube_transcript.js <videoId>
 * Output: JSON { videoId, title, transcript, duration }
 */
import { execSync } from 'child_process';
import { writeFileSync } from 'fs';

const videoId = process.argv[2];
if (!videoId) {
  console.error('Usage: node youtube_transcript.js <videoId>');
  process.exit(1);
}

try {
  // Thử dùng yt-dlp để lấy subtitle
  const result = execSync(
    `yt-dlp --write-auto-sub --sub-lang en,vi --skip-download --output "tmp_${videoId}" --print-json "https://www.youtube.com/watch?v=${videoId}" 2>/dev/null`,
    { timeout: 30000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
  );
  const info = JSON.parse(result);
  const output = {
    videoId,
    title: info.title || '',
    channel: info.channel || '',
    duration: info.duration || 0,
    transcript: info.subtitles ? JSON.stringify(info.subtitles) : '',
  };
  console.log(JSON.stringify(output));
} catch {
  // Fallback: trả về thông tin cơ bản
  console.log(JSON.stringify({
    videoId,
    title: '',
    channel: '',
    duration: 0,
    transcript: '',
    error: 'Transcript unavailable',
  }));
}
