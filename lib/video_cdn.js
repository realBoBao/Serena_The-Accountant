/**
 * video_cdn.js — Video CDN upload + local storage (stub)
 */
export async function uploadVideo(filePath, options = {}) {
  return { url: `file://${filePath}`, local: true, stub: true };
}

export function getVideoUrl(videoId) {
  return `file:///app/artifacts/${videoId}.mp4`;
}

export async function cleanupOldVideos(maxAgeHours = 24) {
  return { cleaned: 0, stub: true };
}

export async function listVideos() {
  return [];
}
