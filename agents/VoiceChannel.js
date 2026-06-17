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
const logger = getLogger('VoiceChannel');

const _connections = new Map(); // guildId → { connection, player, speaking }

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

    // ── Phát âm thanh chào khi vào kênh (Google TTS) ──
    try {
      const ttsUrl = 'https://translate.google.com/translate_tts?ie=UTF-8&tl=vi&client=tw-ob&q=Xin+chào,+Serena+đã+có+mặt';
      const ttsRes = await fetch(ttsUrl);
      if (ttsRes.ok) {
        const audioBuffer = Buffer.from(await ttsRes.arrayBuffer());
        const resource = createAudioResource(audioBuffer);
        player.play(resource);
        logger.info(`[Voice] Playing greeting in ${channel.name}`);
      }
    } catch (ttsErr) {
      logger.debug(`[Voice] TTS greeting failed: ${ttsErr.message}`);
    }

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
