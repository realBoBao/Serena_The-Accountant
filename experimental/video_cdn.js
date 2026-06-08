/**
 * Video CDN — Phase 17: CDN for Manim Videos
 *
 * Uploads rendered videos to local storage with signed URLs,
 * or S3-compatible storage (MinIO / AWS S3) for production.
 * Falls back to local file serving if S3 is not configured.
 *
 * Environment variables:
 *   VIDEO_CDN_PROVIDER    — 'local' (default) | 's3' | 'minio'
 *   VIDEO_CDN_LOCAL_DIR   — Local directory for video storage (default: ./public/videos)
 *   VIDEO_CDN_BASE_URL    — Public base URL for video access
 *   S3_BUCKET             — S3 bucket name
 *   S3_REGION             — S3 region
 *   S3_ACCESS_KEY         — S3 access key
 *   S3_SECRET_KEY         — S3 secret key
 *   S3_ENDPOINT           — Custom S3 endpoint (for MinIO)
 */

import fs from 'fs/promises';
import path from 'path';
import { createHash, randomBytes } from 'crypto';
import { getLogger } from './logger.js';

const logger = getLogger('VideoCDN');

const PROVIDER = process.env.VIDEO_CDN_PROVIDER || 'local';
const LOCAL_DIR = process.env.VIDEO_CDN_LOCAL_DIR || './public/videos';
const BASE_URL = process.env.VIDEO_CDN_BASE_URL || '';
const SIGNED_URL_TTL = Number(process.env.VIDEO_CDN_URL_TTL || 3600); // 1 hour

// ── Local Storage Provider ──

async function ensureLocalDir() {
  const dir = path.resolve(LOCAL_DIR);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

function generateVideoId() {
  return `vid_${Date.now()}_${randomBytes(4).toString('hex')}`;
}

function signUrl(videoId, expiresIn = SIGNED_URL_TTL) {
  const expires = Math.floor(Date.now() / 1000) + expiresIn;
  const data = `${videoId}:${expires}`;
  const sig = createHash('sha256').update(data + (process.env.VIDEO_CDN_SECRET || 'default-secret')).digest('hex').slice(0, 16);
  return { expires, sig };
}

function verifySignedUrl(videoId, expires, sig) {
  if (Date.now() / 1000 > expires) return false;
  const data = `${videoId}:${expires}`;
  const expected = createHash('sha256').update(data + (process.env.VIDEO_CDN_SECRET || 'default-secret')).digest('hex').slice(0, 16);
  return sig === expected;
}

async function uploadLocal(videoPath, metadata = {}) {
  const dir = await ensureLocalDir();
  const videoId = generateVideoId();
  const ext = path.extname(videoPath) || '.mp4';
  const filename = `${videoId}${ext}`;
  const destPath = path.join(dir, filename);

  await fs.copyFile(videoPath, destPath);

  const stats = await fs.stat(destPath);
  const { expires, sig } = signUrl(videoId);

  const publicUrl = BASE_URL
    ? `${BASE_URL}/videos/${filename}?id=${videoId}&expires=${expires}&sig=${sig}`
    : `file://${destPath}`;

  logger.info(`[VideoCDN] Uploaded locally: ${filename} (${(stats.size / 1048576).toFixed(1)}MB)`);

  return {
    videoId,
    url: publicUrl,
    localPath: destPath,
    size: stats.size,
    sizeMB: +(stats.size / 1048576).toFixed(2),
    expires,
    provider: 'local',
    metadata,
  };
}

async function deleteLocal(videoId) {
  const dir = await ensureLocalDir();
  const files = await fs.readdir(dir);
  const file = files.find(f => f.startsWith(videoId));
  if (file) {
    await fs.unlink(path.join(dir, file));
    logger.info(`[VideoCDN] Deleted local video: ${file}`);
    return true;
  }
  return false;
}

// ── S3 Provider (optional) ──

async function uploadS3(videoPath, metadata = {}) {
  // Dynamic import to avoid hard dependency on AWS SDK
  try {
    const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
    const fsSync = await import('fs');

    const client = new S3Client({
      region: process.env.S3_REGION || 'us-east-1',
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY,
        secretAccessKey: process.env.S3_SECRET_KEY,
      },
      ...(process.env.S3_ENDPOINT ? { endpoint: process.env.S3_ENDPOINT, forcePathStyle: true } : {}),
    });

    const videoId = generateVideoId();
    const ext = path.extname(videoPath) || '.mp4';
    const key = `videos/${videoId}${ext}`;
    const fileBuffer = fsSync.readFileSync(videoPath);

    await client.send(new PutObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: key,
      Body: fileBuffer,
      ContentType: 'video/mp4',
      Metadata: {
        'original-name': metadata.originalName || 'animation.mp4',
        'created-at': new Date().toISOString(),
      },
    }));

    const publicUrl = process.env.S3_PUBLIC_URL
      ? `${process.env.S3_PUBLIC_URL}/${key}`
      : `https://${process.env.S3_BUCKET}.s3.${process.env.S3_REGION}.amazonaws.com/${key}`;

    logger.info(`[VideoCDN] Uploaded to S3: ${key}`);

    return {
      videoId,
      url: publicUrl,
      size: fileBuffer.length,
      sizeMB: +(fileBuffer.length / 1048576).toFixed(2),
      provider: 's3',
      key,
      metadata,
    };
  } catch (err) {
    logger.warn('[VideoCDN] S3 upload failed, falling back to local:', err.message);
    return uploadLocal(videoPath, metadata);
  }
}

// ── Cleanup: Remove old videos ──

async function cleanupLocal(maxAgeHours = 48) {
  try {
    const dir = await ensureLocalDir();
    const files = await fs.readdir(dir);
    const now = Date.now();
    const maxAge = maxAgeHours * 3600 * 1000;
    let cleaned = 0;

    for (const file of files) {
      const filePath = path.join(dir, file);
      const stats = await fs.stat(filePath);
      if (now - stats.mtimeMs > maxAge) {
        await fs.unlink(filePath);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.info(`[VideoCDN] Cleaned up ${cleaned} old videos`);
    }
    return cleaned;
  } catch (err) {
    logger.warn('[VideoCDN] Cleanup failed:', err.message);
    return 0;
  }
}

// ── Public API ──

/**
 * Upload a video file to the configured CDN provider.
 * @param {string} videoPath - Local path to the video file
 * @param {object} metadata - Optional metadata (originalName, description, etc.)
 * @returns {Promise<{videoId, url, sizeMB, provider}>}
 */
export async function uploadVideo(videoPath, metadata = {}) {
  switch (PROVIDER) {
    case 's3':
    case 'minio':
      return uploadS3(videoPath, metadata);
    case 'local':
    default:
      return uploadLocal(videoPath, metadata);
  }
}

/**
 * Delete a video by ID.
 */
export async function deleteVideo(videoId) {
  if (PROVIDER === 'local') {
    return deleteLocal(videoId);
  }
  logger.warn('[VideoCDN] S3 delete not implemented yet');
  return false;
}

/**
 * Verify a signed URL is valid.
 */
export function verifyUrl(videoId, expires, sig) {
  return verifySignedUrl(videoId, parseInt(expires, 10), sig);
}

/**
 * Run cleanup of old videos.
 */
export async function cleanup(maxAgeHours = 48) {
  if (PROVIDER === 'local') {
    return cleanupLocal(maxAgeHours);
  }
  return 0;
}

/**
 * Get CDN status/info.
 */
export function getStatus() {
  return {
    provider: PROVIDER,
    localDir: path.resolve(LOCAL_DIR),
    baseUrl: BASE_URL || 'not configured',
    signedUrlTTL: SIGNED_URL_TTL,
  };
}

/**
 * List all stored videos.
 */
export async function listVideos() {
  if (PROVIDER === 'local') {
    try {
      const dir = await ensureLocalDir();
      const files = await fs.readdir(dir);
      const videos = [];
      for (const f of files.filter(f => f.endsWith('.mp4'))) {
        const stats = await fs.stat(path.join(dir, f));
        videos.push({
          name: f,
          sizeMB: Math.round((stats.size / (1024 * 1024)) * 100) / 100,
          created: stats.birthtime,
        });
      }
      return videos;
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Cleanup old videos (alias).
 */
export async function cleanupOldVideos(maxAgeHours = 48) {
  return cleanup(maxAgeHours);
}

/**
 * Store video locally (legacy alias).
 */
export async function storeVideo(videoPath, jobId) {
  return uploadLocal(videoPath, { jobId });
}

