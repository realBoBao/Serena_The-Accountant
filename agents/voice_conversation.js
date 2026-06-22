/**
 * agents/voice_conversation.js — Full Voice Conversation Flow
 *
 * Flow: User nói → Discord VoiceReceiver → Audio buffer → Groq Whisper (STT) → Text
 *       → Groq LLM → Text trả lời → edge-tts (TTS) → Audio → Discord VoiceChannel
 *
 * Commands:
 *   !join     — Bot join voice channel
 *   !leave    — Bot rời voice channel
 *   !vc on    — Bật chế độ voice conversation (nghe & nói)
 *   !vc off   — Tắt chế độ voice conversation
 */

import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
  VoiceReceiver,
  createDefaultAudioReceiveStreamOptions,
  EndBehaviorType,
} from '@discordjs/voice';
import { getLogger } from '../lib/logger.js';
import { spawn, execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { Readable } from 'stream';

const logger = getLogger('VoiceConversation');

// ── State ──
const _connections = new Map(); // guildId → { connection, player, receiver, speaking, listening, audioBuffers }

// ── Helpers ──

function findPython() {
  if (process.env.PYTHON_PATH && fs.existsSync(process.env.PYTHON_PATH)) return process.env.PYTHON_PATH;
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || '';
    const candidates = [
      path.join(localAppData, 'Programs', 'Python', 'Python312', 'python.exe'),
      path.join(localAppData, 'Programs', 'Python', 'Python311', 'python.exe'),
      path.join(localAppData, 'Programs', 'Python', 'Python310', 'python.exe'),
    ];
    for (const p of candidates) if (fs.existsSync(p)) return p;
  }
  // Linux: try python3 first, then python
  try { execSync('which python3', { stdio: 'pipe' }); return 'python3'; } catch {}
  try { execSync('which python', { stdio: 'pipe' }); return 'python'; } catch {}
  return 'python3'; // fallback
}

// ── TTS: Text → Audio (edge-tts) ──

export async function textToSpeech(text, voice = 'vi-VN-HoaiMyNeural') {
  const tmpDir = os.tmpdir();
  const outPath = path.join(tmpDir, `tts-${Date.now()}.mp3`);
  const pythonPath = findPython();

  return new Promise((resolve) => {
    const args = ['-m', 'edge_tts', '--voice', voice, '--text', text, '--write-media', outPath];
    const proc = spawn(pythonPath, args, { env: process.env, windowsHide: true });

    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', code => {
      if (code === 0 && fs.existsSync(outPath) && fs.statSync(outPath).size > 0) {
        logger.info(`[TTS] Generated: ${outPath} (${fs.statSync(outPath).size} bytes)`);
        resolve(outPath);
      } else {
        logger.error(`[TTS] Failed: code=${code}, stderr=${stderr.slice(0, 200)}`);
        resolve(null);
      }
    });
    proc.on('error', err => { logger.error(`[TTS] Spawn error: ${err.message}`); resolve(null); });
  });
}

// ── STT: Audio → Text (Groq Whisper) ──
// ponytail: Opus decode requires @discordjs/voice prism-media decoder
// FFmpeg cannot decode raw Opus packets from Discord VoiceReceiver
// TODO: implement proper Opus→PCM→WAV pipeline using prism-media
export async function speechToText(audioBuffer, language = 'vi') {
  const GROQ_KEY = process.env.GROQ_API_KEY;
  if (!GROQ_KEY) {
    logger.error('[STT] GROQ_API_KEY not set');
    return null;
  }

  // TEMP: Discord VoiceReceiver sends raw Opus packets, not OGG files
  // FFmpeg cannot decode these. Need prism-media decoder.
  // For now, return null to prevent crash.
  logger.warn('[STT] Opus decode not yet implemented — need prism-media decoder');
  return null;

  /* TODO: Implement proper Opus→WAV conversion
  const tmpDir = os.tmpdir();
  const inputPath = path.join(tmpDir, `stt-in-${Date.now()}.opus`);
  const outputPath = path.join(tmpDir, `stt-out-${Date.now()}.wav`);
  fs.writeFileSync(inputPath, audioBuffer);

  // Use prism-media to decode Opus → PCM, then write WAV
  // const { OpusDecoder } = require('@discordjs/opus');
  // ... conversion code ...

  const sendBuffer = fs.readFileSync(outputPath);
  const filename = 'audio.wav';
  const contentType = 'audio/wav';

  const models = ['whisper-large-v3-turbo', 'whisper-large-v3'];
  for (const model of models) {
    try {
      const boundary = '----FormBoundary' + Date.now();
      const header = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`);
      const footer = Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${model}\r\n--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\n${language}\r\n--${boundary}--\r\n`);
      const body = Buffer.concat([header, sendBuffer, footer]);

      const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${GROQ_KEY}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
        },
        body,
      });

      if (res.ok) {
        const data = await res.json();
        const text = data.text || null;
        if (text) {
          logger.info(`[STT] Model ${model} recognized: "${text.slice(0, 50)}"`);
          return text;
        }
      }

      const errText = await res.text().catch(() => '');
      if (errText.includes('blocked') || errText.includes('permission')) {
        logger.warn(`[STT] Model ${model} blocked, trying next...`);
        continue;
      }
      logger.error(`[STT] Groq API ${res.status} (${model}): ${errText.slice(0, 100)}`);
    } catch (err) {
      logger.error(`[STT] Error (${model}): ${err.message}`);
    }
  }

  logger.error('[STT] All Whisper models failed. Enable whisper-large-v3-turbo at https://console.groq.com/settings/project/limits');
  return null;
}

// ── LLM: Text → Text (Groq) ──

export async function askLlm(text, systemPrompt = '') {
  const GROQ_KEY = process.env.GROQ_API_KEY;
  if (!GROQ_KEY) return null;

  const messages = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: text });

  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
        messages,
        max_tokens: 256,
        temperature: 0.7,
      }),
    });

    if (!res.ok) return null;
    const data = await res.json();
    return data.choices?.[0]?.message?.content || null;
  } catch (err) {
    logger.error(`[LLM] Error: ${err.message}`);
    return null;
  }
}

// ── Voice Channel Management ──

export async function joinChannel(channel) {
  const guildId = channel.guild.id;

  if (_connections.has(guildId)) {
    leaveChannel(guildId);
  }

  try {
    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });

    await entersState(connection, VoiceConnectionStatus.Ready, 10000);

    const player = createAudioPlayer();
    connection.subscribe(player);

    _connections.set(guildId, {
      connection,
      player,
      receiver: connection.receiver,
      speaking: false,
      listening: false,
      audioBuffers: new Map(), // userId → Buffer[]
      manuallyDisconnected: false, // flag to prevent auto-rejoin
    });

    connection.on(VoiceConnectionStatus.Disconnected, () => {
      logger.info(`[Voice] Disconnected from ${guildId}`);
      _connections.delete(guildId);
    });

    // Handle UDP/network errors gracefully — don't crash the bot
    connection.on('error', (err) => {
      logger.error(`[Voice] Connection error: ${err.message}`);
      // Don't delete connection on transient errors — only on explicit disconnect
      if (err.message?.includes('socket closed') || err.message?.includes('IP discovery')) {
        logger.warn(`[Voice] UDP error (common on local Windows). Bot stays alive but voice may not work.`);
      }
    });

    logger.info(`[Voice] Joined: ${channel.name} (${guildId})`);
    return { success: true };
  } catch (err) {
    logger.error(`[Voice] Join failed: ${err.message}`);
    return { success: false, error: err.message };
  }
}

// Track manually disconnected guilds to prevent auto-rejoin
const _manuallyDisconnected = new Set();

export function leaveChannel(guildId) {
  const entry = _connections.get(guildId);
  if (!entry) {
    logger.info(`[Voice] leaveChannel: no connection for ${guildId}`);
    return { success: false, error: 'Not connected' };
  }
  try {
    // Force destroy even if connection is in broken state
    try { entry.connection?.disconnect?.(); } catch { /* ignore */ }
    try { entry.connection?.destroy?.(); } catch { /* ignore */ }
    _connections.delete(guildId);
    _manuallyDisconnected.add(guildId); // Mark as manually disconnected
    logger.info(`[Voice] Left: ${guildId} (manual disconnect)`);
    return { success: true };
  } catch (err) {
    logger.error(`[Voice] Leave error: ${err.message}`);
    _connections.delete(guildId);
    _manuallyDisconnected.add(guildId);
    return { success: false, error: err.message };
  }
}

export function isManuallyDisconnected(guildId) {
  return _manuallyDisconnected.has(guildId);
}

export function clearManualDisconnect(guildId) {
  _manuallyDisconnected.delete(guildId);
}

// ── Play Audio in Channel ──

export async function playAudio(guildId, audioSource) {
  const entry = _connections.get(guildId);
  if (!entry) return { success: false, error: 'Not connected' };

  try {
    // Support both file path (string) and Readable stream
    let resource;
    if (typeof audioSource === 'string') {
      // File path — createAudioResource handles it
      resource = createAudioResource(audioSource);
    } else if (audioSource instanceof Readable) {
      resource = createAudioResource(audioSource);
    } else {
      return { success: false, error: 'Invalid audio source type' };
    }
    entry.player.play(resource);
    entry.speaking = true;

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        entry.speaking = false;
        reject(new Error('Audio playback timeout (30s)'));
      }, 30000);

      entry.player.once(AudioPlayerStatus.Idle, () => {
        clearTimeout(timeout);
        entry.speaking = false;
        resolve();
      });

      entry.player.once('error', (err) => {
        clearTimeout(timeout);
        entry.speaking = false;
        reject(err);
      });
    });

    return { success: true };
  } catch (err) {
    entry.speaking = false;
    logger.error(`[Voice] playAudio error: ${err.message}`);
    return { success: false, error: err.message };
  }
}

// ── Speak in Channel (TTS + Play) ──

export async function speakInChannel(guildId, text, voice = 'vi-VN-HoaiMyNeural') {
  const audioPath = await textToSpeech(text, voice);
  if (!audioPath) return { success: false, error: 'TTS failed' };

  const result = await playAudio(guildId, audioPath);

  // Cleanup temp file after 5s
  setTimeout(() => {
    try { fs.unlinkSync(audioPath); } catch { /* ignore */ }
  }, 5000);

  return result;
}

// ── Start Listening (Voice Conversation Mode) ──

export function startListening(guildId) {
  const entry = _connections.get(guildId);
  if (!entry) return { success: false, error: 'Not connected' };

  entry.listening = true;
  const receiver = entry.receiver;

  // Lắng nghe audio từ tất cả users trong voice channel
  receiver.speaking.on('start', (userId) => {
    if (!entry.listening) return;

    logger.info(`[Voice] User ${userId} started speaking`);

    // Tạo stream để thu audio
    const audioStream = receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.AfterSilence,
        duration: 1000, // 1s im lặng = kết thúc
      },
    });

    const chunks = [];
    audioStream.on('data', (chunk) => {
      chunks.push(chunk);
    });

    audioStream.on('end', async () => {
      if (!entry.listening) return;

      const audioBuffer = Buffer.concat(chunks);
      logger.info(`[Voice] Received ${audioBuffer.length} bytes from ${userId}`);

      // Chỉ xử lý nếu audio đủ lớn (> 200 bytes, ~0.2s audio)
      if (audioBuffer.length < 200) {
        logger.info('[Voice] Audio too short, skipping');
        return;
      }

      // 1. STT: Audio → Text
      logger.info('[Voice] Running speech-to-text...');
      const text = await speechToText(audioBuffer);

      if (!text || !text.trim()) {
        logger.info('[STT] No text recognized');
        return;
      }

      logger.info(`[STT] Recognized: "${text}"`);

      // 2. LLM: Text → Response
      logger.info('[Voice] Asking LLM...');
      const systemPrompt = 'Bạn là Serena, trợ lý AI thông minh. Trả lời ngắn gọn, tự nhiên, như đang nói chuyện với bạn bè. Trả lời bằng tiếng Việt.';
      const response = await askLlm(text, systemPrompt);

      if (!response || !response.trim()) {
        logger.info('[LLM] No response');
        return;
      }

      logger.info(`[LLM] Response: "${response.slice(0, 100)}..."`);

      // 3. TTS: Response → Audio → Play
      logger.info('[Voice] Speaking response...');
      await speakInChannel(guildId, response.trim());
    });
  });

  logger.info(`[Voice] Started listening in ${guildId}`);
  return { success: true };
}

// ── Stop Listening ──

export function stopListening(guildId) {
  const entry = _connections.get(guildId);
  if (!entry) return { success: false, error: 'Not connected' };

  entry.listening = false;
  logger.info(`[Voice] Stopped listening in ${guildId}`);
  return { success: true };
}

// ── Status ──

export function isConnected(guildId) {
  return _connections.has(guildId);
}

export function isListening(guildId) {
  return _connections.get(guildId)?.listening || false;
}

export function isSpeaking(guildId) {
  return _connections.get(guildId)?.speaking || false;
}

export function listConnections() {
  return [..._connections.keys()];
}
