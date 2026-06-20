/**
 * agents/VoiceChannel.js — Discord Voice Channel Handler
 * Tham gia voice channel, nghe user nói, trả lời bằng giọng nói.
 * @module agents/VoiceChannel
 */

import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
} from '@discordjs/voice';
import { getLogger } from '../lib/logger.js';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import os from 'os';

const logger = getLogger('VoiceChannel');
const execAsync = promisify(exec);

const _connections = new Map(); // guildId → { connection, player, speaking }

/**
 * Tìm Python executable path trên Windows/Linux/Mac.
 * edge-tts cần Python 3.10+.
 */
function findPython() {
  // 1. Check env override
  if (process.env.PYTHON_PATH && fs.existsSync(process.env.PYTHON_PATH)) {
    return process.env.PYTHON_PATH;
  }

  // 2. Common Windows paths
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || '';
    const candidates = [
      path.join(localAppData, 'Programs', 'Python', 'Python312', 'python.exe'),
      path.join(localAppData, 'Programs', 'Python', 'Python311', 'python.exe'),
      path.join(localAppData, 'Programs', 'Python', 'Python310', 'python.exe'),
      'C:\\Python312\\python.exe',
      'C:\\Python311\\python.exe',
      'C:\\Python310\\python.exe',
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
  }

  // 3. Try PATH
  return 'python';
}

/**
 * Tham gia voice channel.
 * @param {import('discord.js').VoiceChannel} channel
 */
export async function joinChannel(channel) {
  const guildId = channel.guild.id;

  // Nếu đã kết nối → disconnect trước
  if (_connections.has(guildId)) {
    leaveChannel(guildId);
  }

  try {
    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false,  // ← FIX: Không tự điếc, bot có thể nghe
      selfMute: false,  // ← FIX: Không tự tắt mic
    });

    // Chờ kết nối sẵn sàng
    await entersState(connection, VoiceConnectionStatus.Ready, 10000);

    const player = createAudioPlayer();
    connection.subscribe(player);

    _connections.set(guildId, { connection, player, speaking: false });

    // Xử lý disconnect
    connection.on(VoiceConnectionStatus.Disconnected, () => {
      logger.info(`[Voice] Disconnected from ${guildId}`);
      _connections.delete(guildId);
    });

    logger.info(`[Voice] Joined channel: ${channel.name} (${guildId})`);

    // TODO: TTS greeting — install edge-tts for voice output
    return { success: true };
  } catch (err) {
    logger.error(`[Voice] Join failed: ${err.message}`);
    return { success: false, error: err.message };
  }
}

/**
 * Rời voice channel.
 * @param {string} guildId
 */
export function leaveChannel(guildId) {
  const entry = _connections.get(guildId);
  if (!entry) return;

  try {
    entry.connection.destroy();
    _connections.delete(guildId);
    logger.info(`[Voice] Left channel: ${guildId}`);
  } catch (err) {
    logger.error(`[Voice] Leave error: ${err.message}`);
  }
}

/**
 * Phát audio từ URL hoặc Buffer.
 * @param {string} guildId
 * @param {string|Buffer} audioSource — URL hoặc audio buffer
 */
export async function playAudio(guildId, audioSource) {
  const entry = _connections.get(guildId);
  if (!entry) {
    logger.warn(`[Voice] No connection for ${guildId}`);
    return { success: false, error: 'Not connected' };
  }

  try {
    const resource = createAudioResource(audioSource);
    entry.player.play(resource);
    entry.speaking = true;

    // Chờ phát xong
    await new Promise((resolve) => {
      entry.player.once(AudioPlayerStatus.Idle, () => {
        entry.speaking = false;
        resolve();
      });
    });

    return { success: true };
  } catch (err) {
    logger.error(`[Voice] Play error: ${err.message}`);
    entry.speaking = false;
    return { success: false, error: err.message };
  }
}

/**
 * Kiểm tra đang nói không.
 * @param {string} guildId
 */
export function isSpeaking(guildId) {
  return _connections.get(guildId)?.speaking || false;
}

/**
 * Kiểm tra đã kết nối voice chưa.
 * @param {string} guildId
 */
export function isConnected(guildId) {
  return _connections.has(guildId);
}

/**
 * Lấy danh sách voice connections.
 */
export function listConnections() {
  return [..._connections.keys()];
}

/**
 * Text-to-Speech bằng edge-tts (miễn phí, không cần API key).
 * Dùng spawn thay vì exec để tránh PATH issues trên Windows.
 * @param {string} text — Nội dung cần đọc
 * @param {string} [voice='vi-VN-HoaiMyNeural'] — Giọng đọc (Vietnamese female)
 * @returns {Promise<string>} — Đường dẫn file MP3
 */
export async function textToSpeech(text, voice = 'vi-VN-HoaiMyNeural') {
  const tmpDir = os.tmpdir();
  const outPath = path.join(tmpDir, `tts-${Date.now()}.mp3`);

  // Tìm python executable
  const pythonPath = findPython();
  if (!pythonPath) {
    logger.error('[Voice] Python not found. Install Python 3.10+ and: pip install edge-tts');
    return null;
  }

  return new Promise((resolve) => {
    const args = ['-m', 'edge_tts', '--voice', voice, '--text', text, '--write-media', outPath];
    const proc = spawn(pythonPath, args, { env: process.env, windowsHide: true });

    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', code => {
      if (code === 0 && fs.existsSync(outPath) && fs.statSync(outPath).size > 0) {
        logger.info(`[Voice] TTS generated: ${outPath} (${fs.statSync(outPath).size} bytes)`);
        resolve(outPath);
      } else {
        logger.error(`[Voice] TTS failed: code=${code}, stderr=${stderr.slice(0, 200)}`);
        resolve(null);
      }
    });
    proc.on('error', err => {
      logger.error(`[Voice] TTS spawn error: ${err.message}`);
      resolve(null);
    });
  });
}

/**
 * Phát text trong voice channel (TTS + play).
 * @param {string} guildId
 * @param {string} text
 * @param {string} [voice='vi-VN-NamNeural']
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function speakInChannel(guildId, text, voice = 'vi-VN-NamNeural') {
  // Generate TTS audio
  const audioPath = await textToSpeech(text, voice);
  if (!audioPath) {
    return { success: false, error: 'TTS failed' };
  }

  // Play in channel
  const result = await playAudio(guildId, audioPath);

  // Cleanup temp file
  try {
    setTimeout(() => {
      fs.unlink(audioPath, () => {});
    }, 5000);
  } catch { /* ignore */ }

  return result;
}
