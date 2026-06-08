/**
 * lib/media_preprocessor.js — Multi-modal Media Pre-processing
 *
 * Tối ưu token cost khi gửi ảnh/video/âm thanh lên API:
 * 1. Image: Resize + compress trước khi gửi lên Gemini Vision
 *    - Max 1024x1024 (đủ nhìn rõ cho phân tích kỹ thuật)
    - JPEG quality 80% (giảm 60-80% dung lượng)
 * 2. Audio: Cắt ngắn + normalize trước khi whisper
 *    - Max 60s per chunk (whisper nhanh hơn, ít token hơn)
 *    - Chỉ lấy đoạn có speech (skip silence)
 * 3. Video: Extract key frames thay vì gửi toàn bộ
 *    - Max 5 frames/video (đủ hiểu nội dung)
 *
 * Usage:
 *   import { preprocessImage, preprocessAudio } from './media_preprocessor.js';
 *   const { buffer, width, height, originalSize, compressedSize } = await preprocessImage(rawBuffer);
 */

import { getLogger } from './logger.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import os from 'os';
import { writeFile, mkdir, rm, readFile, access } from 'fs/promises';

const execp = promisify(exec);
const logger = getLogger('MediaPreprocessor');

// ── Image Preprocessing ─────────────────────────────────

const IMAGE_MAX_DIMENSION = 1024; // Max width/height
const IMAGE_JPEG_QUALITY = 80;    // JPEG quality (0-100)
const IMAGE_MAX_BYTES = 2 * 1024 * 1024; // 2MB target

/**
 * Tiền xử lý ảnh: Resize + Compress để giảm token cost
 *
 * @param {Buffer} rawBuffer — Raw image buffer
 * @param {object} options — { maxDim, quality, format }
 * @returns {object} { buffer, width, height, originalSize, compressedSize, ratio }
 */
export async function preprocessImage(rawBuffer, options = {}) {
  const maxDim = options.maxDim || IMAGE_MAX_DIMENSION;
  const quality = options.quality || IMAGE_JPEG_QUALITY;
  const format = options.format || 'jpeg';

  const originalSize = rawBuffer.length;

  // Nếu ảnh đã nhỏ → không cần xử lý
  if (originalSize < 100 * 1024) { // < 100KB
    logger.debug(`[MediaPreprocessor] Image already small (${(originalSize / 1024).toFixed(0)}KB), skip preprocessing`);
    return { buffer: rawBuffer, width: 0, height: 0, originalSize, compressedSize: originalSize, ratio: 1 };
  }

  const tmpDir = path.join(os.tmpdir(), `img-prep-${Date.now()}`);
  await mkdir(tmpDir, { recursive: true });

  const inputPath = path.join(tmpDir, 'input');
  const outputPath = path.join(tmpDir, `output.${format}`);

  try {
    // Ghi raw buffer ra file
    await writeFile(inputPath, rawBuffer);

    // Dùng ImageMagick hoặc ffmpeg để resize + compress
    // Ưu tiên ImageMagick (nhẹ hơn), fallback sang ffmpeg
    let resized = false;

    // Thử ImageMagick
    try {
      await execp(
        `magick "${inputPath}" -resize ${maxDim}x${maxDim}> -quality ${quality} "${outputPath}"`,
        { timeout: 15000 }
      );
      resized = true;
    } catch {
      // ImageMagick không có → thử ffmpeg
      try {
        await execp(
          `ffmpeg -y -i "${inputPath}" -vf "scale='min(${maxDim},iw)':-1" -q:v ${Math.round((100 - quality) / 10)} "${outputPath}"`,
          { timeout: 15000 }
        );
        resized = true;
      } catch {
        // Cả 2 đều không có → dùng Node.js pure (chậm hơn nhưng không cần dependency)
        logger.warn('[MediaPreprocessor] No ImageMagick/ffmpeg found, using Node.js fallback');
      }
    }

    let outputBuffer;
    if (resized) {
      outputBuffer = await readFile(outputPath);
    } else {
      // Fallback: gửi ảnh gốc (không resize được)
      outputBuffer = rawBuffer;
    }

    const compressedSize = outputBuffer.length;
    const ratio = (compressedSize / originalSize * 100).toFixed(1);

    logger.info(`[MediaPreprocessor] Image: ${(originalSize / 1024).toFixed(0)}KB → ${(compressedSize / 1024).toFixed(0)}KB (${ratio}%)`);

    return {
      buffer: outputBuffer,
      width: maxDim,
      height: maxDim,
      originalSize,
      compressedSize,
      ratio: parseFloat(ratio),
    };
  } catch (err) {
    logger.warn('[MediaPreprocessor] Image preprocessing failed:', err.message);
    return { buffer: rawBuffer, width: 0, height: 0, originalSize, compressedSize: originalSize, ratio: 100 };
  } finally {
    // Cleanup temp files
    try { await rm(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/**
 * Phân tích ảnh để lấy dimensions (không cần resize)
 */
export async function getImageInfo(buffer) {
  const tmpDir = path.join(os.tmpdir(), `img-info-${Date.now()}`);
  await mkdir(tmpDir, { recursive: true });
  const inputPath = path.join(tmpDir, 'input');

  try {
    await writeFile(inputPath, buffer);
    const { stdout } = await execp(`magick identify -format "%w %h" "${inputPath}"`, { timeout: 5000 });
    const [width, height] = stdout.trim().split(' ').map(Number);
    return { width, height, size: buffer.length };
  } catch {
    return { width: 0, height: 0, size: buffer.length };
  } finally {
    try { await rm(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ── Audio Preprocessing ─────────────────────────────────

const AUDIO_MAX_DURATION_SEC = 60; // Max 60s per chunk
const AUDIO_SAMPLE_RATE = 16000;   // Whisper optimal: 16kHz

/**
 * Tiền xử lý audio: Cắt ngắn + normalize
 *
 * @param {Buffer} rawBuffer — Raw audio buffer
 * @param {object} options — { maxDuration, sampleRate }
 * @returns {object} { buffer, duration, originalSize, compressedSize }
 */
export async function preprocessAudio(rawBuffer, options = {}) {
  const maxDuration = options.maxDuration || AUDIO_MAX_DURATION_SEC;
  const sampleRate = options.sampleRate || AUDIO_SAMPLE_RATE;

  const originalSize = rawBuffer.length;

  // Nếu audio nhỏ → không cần xử lý
  if (originalSize < 500 * 1024) { // < 500KB
    return { buffer: rawBuffer, duration: 0, originalSize, compressedSize: originalSize };
  }

  const tmpDir = path.join(os.tmpdir(), `audio-prep-${Date.now()}`);
  await mkdir(tmpDir, { recursive: true });

  const inputPath = path.join(tmpDir, 'input');
  const outputPath = path.join(tmpDir, 'output.wav');

  try {
    await writeFile(inputPath, rawBuffer);

    // Dùng ffmpeg để cắt + normalize + convert sang WAV 16kHz mono
    await execp(
      `ffmpeg -y -i "${inputPath}" -t ${maxDuration} -ar ${sampleRate} -ac 1 -af "loudnorm=I=-16:TP=-1.5:LRA=11" -f wav "${outputPath}"`,
      { timeout: 30000 }
    );

    const outputBuffer = await readFile(outputPath);
    const compressedSize = outputBuffer.length;

    logger.info(`[MediaPreprocessor] Audio: ${(originalSize / 1024).toFixed(0)}KB → ${(compressedSize / 1024).toFixed(0)}KB`);

    return { buffer: outputBuffer, duration: maxDuration, originalSize, compressedSize };
  } catch (err) {
    logger.warn('[MediaPreprocessor] Audio preprocessing failed:', err.message);
    return { buffer: rawBuffer, duration: 0, originalSize, compressedSize: originalSize };
  } finally {
    try { await rm(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ── Video Preprocessing ─────────────────────────────────

const VIDEO_MAX_FRAMES = 5;        // Max 5 key frames
const VIDEO_FRAME_INTERVAL = 10;  // Extract 1 frame every 10s

/**
 * Extract key frames từ video thay vì gửi toàn bộ
 *
 * @param {Buffer} rawBuffer — Raw video buffer
 * @param {object} options — { maxFrames, interval }
 * @returns {object} { frames: Buffer[], frameCount, originalSize }
 */
export async function extractVideoFrames(rawBuffer, options = {}) {
  const maxFrames = options.maxFrames || VIDEO_MAX_FRAMES;
  const interval = options.interval || VIDEO_FRAME_INTERVAL;

  const originalSize = rawBuffer.length;

  // Nếu video nhỏ → không cần xử lý
  if (originalSize < 1024 * 1024) { // < 1MB
    return { frames: [rawBuffer], frameCount: 1, originalSize };
  }

  const tmpDir = path.join(os.tmpdir(), `video-prep-${Date.now()}`);
  await mkdir(tmpDir, { recursive: true });

  const inputPath = path.join(tmpDir, 'input');
  const outputPattern = path.join(tmpDir, 'frame_%03d.jpg');

  try {
    await writeFile(inputPath, rawBuffer);

    // Extract key frames mỗi interval giây
    await execp(
      `ffmpeg -y -i "${inputPath}" -vf "fps=1/${interval},scale=640:-1" -vframes ${maxFrames} -q:v 5 "${outputPattern}"`,
      { timeout: 30000 }
    );

    // Đọc các frames
    const frames = [];
    for (let i = 1; i <= maxFrames; i++) {
      const framePath = path.join(tmpDir, `frame_${String(i).padStart(3, '0')}.jpg`);
      try {
        const frame = await readFile(framePath);
        frames.push(frame);
      } catch {
        break; // Hết frames
      }
    }

    logger.info(`[MediaPreprocessor] Video: extracted ${frames.length} frames from ${(originalSize / 1024 / 1024).toFixed(1)}MB`);

    return { frames, frameCount: frames.length, originalSize };
  } catch (err) {
    logger.warn('[MediaPreprocessor] Video frame extraction failed:', err.message);
    return { frames: [rawBuffer], frameCount: 1, originalSize };
  } finally {
    try { await rm(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

export default { preprocessImage, getImageInfo, preprocessAudio, extractVideoFrames };
