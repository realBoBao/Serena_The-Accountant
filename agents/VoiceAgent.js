/**
 * Voice Agent — Phase 14: Thính giác (Voice)
 * whisper.cpp: Voice Message → text → phân tích ý định
 *
 * Workflow:
 * 1. User gửi voice message (Discord attachment .ogg/.mp3)
 * 2. VoiceAgent download → convert → whisper.cpp transcribe
 * 3. Text được đưa vào RagAgent để phân tích ý định
 *
 * Discord: Gửi voice message kèm !voice
 */

import 'dotenv/config';
import { spawn } from 'child_process';
import { readFile, writeFile, mkdir, rm, access } from 'fs/promises';
import path from 'path';
import os from 'os';
import { preprocessAudio } from '../lib/media_preprocessor.js';

const WHISPER_MODEL = process.env.WHISPER_MODEL || path.join(process.cwd(), 'models', 'ggml-base.bin');
const WHISPER_BIN = process.env.WHISPER_BIN || path.join(process.cwd(), 'whisper.cpp', 'build', 'bin', 'Release', 'whisper-cli.exe');

/**
 * Transcribe audio file using whisper.cpp
 */
export async function transcribeAudio(audioBuffer, options = {}) {
  const { language = 'vi' } = options;

  // ── Pre-process: Cắt ngắn + normalize để giảm processing time ──
  const preprocessed = await preprocessAudio(audioBuffer, { maxDuration: 60, sampleRate: 16000 });
  const finalBuffer = preprocessed.buffer;

  const tmpDir = path.join(os.tmpdir(), `whisper-${Date.now()}`);
  await mkdir(tmpDir, { recursive: true });

  const inputPath = path.join(tmpDir, 'input.wav');
  const outputPath = path.join(tmpDir, 'output');

  try {
    // Write preprocessed audio buffer to temp file
    await writeFile(inputPath, finalBuffer);

    // Check whisper binary exists
    try {
      await access(WHISPER_BIN);
    } catch {
      return {
        success: false,
        error: 'whisper-cli.exe not found. Build whisper.cpp first.',
        hint: 'cd whisper.cpp && cmake -B build && cmake --build build --config Release',
      };
    }

    // Check model exists
    try {
      await access(WHISPER_MODEL);
    } catch {
      return {
        success: false,
        error: `Whisper model not found: ${WHISPER_MODEL}`,
        hint: 'Download from: https://huggingface.co/ggerganov/whisper.cpp/tree/main',
      };
    }

    // Run whisper
    const result = await runWhisper(inputPath, outputPath, language);

    return {
      success: true,
      text: result.text,
      language: result.language || language,
    };
  } finally {
    // Cleanup
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

function runWhisper(inputPath, outputPath, language) {
  return new Promise((resolve, reject) => {
    const proc = spawn(WHISPER_BIN, [
      '-m', WHISPER_MODEL,
      '-f', inputPath,
      '-l', language,
      '-otxt',
      '-of', outputPath,
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60000,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });

    proc.on('close', async (code) => {
      try {
        // Read output text file
        const txtPath = `${outputPath}.txt`;
        const text = await readFile(txtPath, 'utf8').catch(() => '');
        resolve({ text: text.trim(), language });
      } catch {
        // Fallback: parse from stdout
        const text = stdout.split('\n')
          .filter(line => line.trim() && !line.includes('whisper_'))
          .join(' ')
          .trim();
        resolve({ text, language });
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`whisper error: ${err.message}`));
    });
  });
}

/**
 * Process Discord voice message
 */
export async function processVoiceMessage(message) {
  if (!message?.attachments) {
    return {
      success: false,
      error: 'Không tìm thấy audio đính kèm. Hãy gửi voice message cùng lệnh !voice.',
    };
  }
  const attachments = message.attachments.filter(att =>
    att.contentType?.startsWith('audio/') ||
    att.name?.endsWith('.ogg') ||
    att.name?.endsWith('.mp3') ||
    att.name?.endsWith('.wav') ||
    att.name?.endsWith('.m4a')
  );

  if (attachments.size === 0) {
    return {
      success: false,
      error: 'Không tìm thể audio đính kèm. Hãy gửi voice message cùng lệnh !voice.',
    };
  }

  const results = [];

  for (const [, attachment] of attachments) {
    try {
      // Download audio
      const res = await fetch(attachment.url);
      if (!res.ok) throw new Error(`Download failed: ${res.status}`);
      const buffer = await res.arrayBuffer();

      const result = await transcribeAudio(Buffer.from(buffer), { language: 'vi' });
      results.push({
        fileName: attachment.name,
        ...result,
      });
    } catch (err) {
      results.push({
        fileName: attachment.name,
        success: false,
        error: err.message,
      });
    }
  }

  return { success: true, results };
}
