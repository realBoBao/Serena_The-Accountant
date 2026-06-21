import 'dotenv/config';
import crypto from 'crypto';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
} from 'discord.js';
import { initializeMarkovFiles } from './lib/markov_engine.js';
import { orchestrator } from './Orchestrator.js';
import { orchestratorGuard } from './lib/orchestrator_guard.js';
import { sandboxGateway } from './sandbox_gateway.js';
import { withTimeout, TimeoutError } from './lib/with_timeout.js';
import { embedText } from './lib/embeddings.js';
import { search as vectorSearch } from './lib/vector_store.js';
import { runDebate, quickDebate } from './agents/DebateAgent.js';
import { solveWithDebugLoop } from './agents/CoderAgent.js';
import { processVisionMessage } from './agents/VisionAgent.js';
import { initSemanticRouter, classifyIntentSemantic } from './lib/semantic_router.js';
import { processVoiceMessage } from './agents/VoiceAgent.js';
import { createAnimation, createAnimationWithCompression, createAnimationAsync } from './agents/ManimAgent.js';
import { startShadowReview, submitReviewAnswer, getNextHint } from './agents/MentorAgent.js';
import { generateIncident, evaluateHotfix, createIncidentSession, getIncidentSession } from './agents/IncidentAgent.js';
import { analyzeUrl } from './agents/AnalysisAgent.js';
import {
  getSocraticSession,
  startSocraticSession,
  handleSocraticReply,
  extractTopic,
  SocraticAgent,
} from './agents/SocraticAgent.js';

const requestQueue = [];
let isProcessingQueue = false;
const MAX_QUEUE_SIZE = 50; // Prevent memory leak from spam

// ── User-level query dedup: block cùng user + cùng query trong 1 giờ ──
const _userQueryCache = new Map(); // userId:{queryHash} → timestamp
const USER_QUERY_DEDUP_MS = 60 * 60 * 1000; // 1 giờ

const token = process.env.DISCORD_BOT_TOKEN?.trim();
const prefix = process.env.DISCORD_COMMAND_PREFIX || '!ask ';
const interestTopics = new Map();
const interestTtlMs = 24 * 60 * 60 * 1000;
const maxDiscordMessageLength = 1900;

if (!token) {
  throw new Error('DISCORD_BOT_TOKEN is required in .env to start the Discord bot.');
}

function truncateForDiscord(value, maxLength = maxDiscordMessageLength) {
  const text = String(value ?? '').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function previewTopic(value, maxLength = 35) {
  const text = String(value ?? '').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

const MAX_INTEREST_TOPICS = 1000;

function rememberInterestTopic(topic) {
  // Cleanup nếu quá nhiều entries
  if (interestTopics.size >= MAX_INTEREST_TOPICS) {
    const oldestKey = interestTopics.keys().next().value;
    interestTopics.delete(oldestKey);
  }

  const id = crypto.randomBytes(8).toString('hex');
  interestTopics.set(id, topic);

  const timeout = setTimeout(() => {
    interestTopics.delete(id);
  }, interestTtlMs);
  if (typeof timeout.unref === 'function') timeout.unref();

  return `interest:${id}`;
}

// ── Implicit Feedback: Track outbound links/content ──
// Fire-and-forget tracking — never blocks the main flow
const _outboundTracker = {
  _pending: new Map(), // userId → { linkId, sentAt, category }

  /**
   * Track a URL or content piece sent to user.
   * @param {string} userId
   * @param {string} url
   * @param {string} category — 'video' | 'repo' | 'article' | 'book' | 'evo' | ...
   * @param {string} messageId — Discord message ID
   */
  track(userId, url, category = 'unknown', messageId = null) {
    try {
      import('./lib/implicit_feedback.js').then(async ({ implicitFeedback }) => {
        const linkId = await implicitFeedback.trackOutbound(userId, { url, category, messageId });
        this._pending.set(userId, { linkId, sentAt: Date.now(), category });
      }).catch(() => {});
    } catch { /* non-critical */ }
  },

  /**
   * Get the pending outbound for a user (for dwell time calculation).
   */
  getPending(userId) {
    return this._pending.get(userId) || null;
  },

  /**
   * Clear pending after dwell time is recorded.
   */
  clearPending(userId) {
    this._pending.delete(userId);
  },
};

function resolveInterestTopic(customId) {
  const raw = customId.slice('interest:'.length);
  const storedTopic = interestTopics.get(raw);
  if (storedTopic) return storedTopic;
  if (/^[a-f0-9]{16}$/i.test(raw)) return null;

  try {
    return decodeURIComponent(raw);
  } catch (_) {
    return raw || null;
  }
}

async function safeInteractionReply(interaction, content) {
  const payload = {
    content: truncateForDiscord(content),
    ephemeral: true,
    allowedMentions: { parse: [] },
  };

  if (interaction.replied || interaction.deferred) {
    return interaction.followUp(payload);
  }
  return interaction.reply(payload);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
  partials: [Partials.Channel],
});

let readyWatchdog = setTimeout(() => {
  console.warn('Discord bot is still waiting for ready. Check the bot token, network access, and Message Content Intent in the Discord Developer Portal.');
}, 30000);
if (typeof readyWatchdog.unref === 'function') readyWatchdog.unref();

client.once(Events.ClientReady, async (readyClient) => {
  clearTimeout(readyWatchdog);

  try {
    await initializeMarkovFiles();
  } catch (err) {
    console.error('Markov file initialization failed:', err.message || err);
  }

  // Initialize semantic router (async — non-blocking)
  initSemanticRouter().catch(err => {
    console.warn('[SemanticRouter] Init failed, using keyword fallback:', err.message);
  });

  // Init SQLite DB (required for RagAgent, flashcard, mood, etc.)
  try {
    const { openDb } = await import('./lib/sqlite_adapter.js');
    await openDb();
    console.log('[DB] SQLite initialized');
  } catch (err) {
    console.error('[DB] Init failed:', err.message);
  }

  // Load plugins
  try {
    const { PluginLoader } = await import('./lib/plugin_loader.js');
    await PluginLoader.loadAll();
    const plugins = PluginLoader.list();
    if (plugins.length > 0) {
      console.log(`[Plugins] Loaded: ${plugins.map(p => p.name).join(', ')}`);
    }
  } catch (err) {
    console.error('[PluginLoader] Init failed:', err.message);
  }

  console.log(`Discord bot ready as ${readyClient.user.tag}`);
});

client.on(Events.Error, (err) => {
  console.error('Discord client error:', err?.stack || err?.message || err);
});

client.on(Events.Warn, (warning) => {
  console.warn('Discord warning:', warning);
});

client.on(Events.ShardError, (err, shardId) => {
  console.error(`Discord shard ${shardId} error:`, err?.stack || err?.message || err);
});

client.on(Events.ShardDisconnect, (event, shardId) => {
  const code = event?.code;
  const reason = event?.reason || '';
  console.warn(`Discord shard ${shardId} disconnected:`, code, reason);
  if (code === 4014) {
    console.warn('Discord rejected a privileged intent. Enable Message Content Intent for this bot, or remove MessageContent and switch to slash commands.');
  } else if (code !== 1000) {
    // Auto-reconnect for non-clean disconnects (code 1000 = normal close)
    console.log(`[Discord] Attempting auto-reconnect for shard ${shardId} in 5s...`);
    setTimeout(() => {
      if (!client.readyAt) {
        client.login(token).catch((err) => {
          console.error('[Discord] Auto-reconnect failed:', err?.message || err);
        });
      }
    }, 5000);
  }
});

client.on(Events.ShardReconnecting, (shardId) => {
  console.warn(`Discord shard ${shardId} reconnecting...`);
});

if (process.env.DISCORD_DEBUG === '1') {
  client.on(Events.Debug, (message) => {
    console.debug('Discord debug:', message);
  });
}

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (!interaction.isButton()) return;
    const { customId } = interaction;
    if (!customId.startsWith('interest:')) return;

    const topic = resolveInterestTopic(customId);
    if (!topic) {
      return safeInteractionReply(interaction, 'Tuong tac nay da het han. Vui long hoi lai bang lenh `!ask`.');
    }

    const result = await orchestrator.route({ type: 'discord_interaction', topic });
    if (result?.error) {
      console.error('Interaction handling failed:', result?.error?.stack || result?.error?.message || result?.error);
      return safeInteractionReply(interaction, 'Khong the luu tuong tac nay, vui long thu lai.');
    }

    return safeInteractionReply(interaction, result.message || `Da ghi nhan chu de: ${topic}`);
  } catch (err) {
    console.error('interactionCreate error:', err?.stack || err?.message || err);
    try {
      await safeInteractionReply(interaction, 'Loi noi bo khi xu ly tuong tac. Vui long thu lai.');
    } catch (replyErr) {
      console.error('Interaction error reply failed:', replyErr?.stack || replyErr?.message || replyErr);
    }
  }
});

orchestrator.on('error', async (error, event) => {
  console.error('Orchestrator event error:', error, event);
});

// ── Router Agent: Intent Classification ──
// Phân loại tin nhắn thành các intent: CODE, RAG, MEMORY, CHAT
const INTENT_KEYWORDS = {
  CODE: ['!run', '!code', 'chạy code', 'run code', 'execute', 'biên dịch', 'compile', 'sandbox', 'viết code', 'giải bài toán', 'giải thuật'],
  DEBATE: ['!debate', 'tranh luận', 'so sánh giải pháp', 'debate', 'coder vs rag'],
  MEMORY: ['!memory', '!mem', 'lưu trí nhớ', 'ghi nhớ', 'nhớ đi', 'lưu lại', 'trí nhớ'],
  SCHEDULE: ['!schedule', 'thời khóa biểu', 'syllabus', 'lịch học', 'lịch thi'],
  ANIMATE: ['!animate', 'animation', 'video', 'manim', 'trình chiếu'],
  VISION: ['!vision', 'phân tích ảnh', 'nhìn ảnh', 'chụp màn hình'],
  VOICE: ['!voice', 'voice message', 'thính giác', 'nói chuyện'],
  REVIEW: ['!review', 'shadow review', 'ôn tập code', 'bắt bẻ code'],
  INCIDENT: ['!incident', 'chaos', 'sự cố', 'production incident', '3am alert'],
  ANALYZE: ['!analyze', 'phân tích', 'analyze', 'tổng hợp', 'code quality'],
  AUDIT: ['!audit', 'security audit', 'quét bảo mật', 'vulnerability scan'],
  PROFILE: ['!profile', 'hồ sơ', 'profile', 'thống kê học tập'],
  PERF: ['!perf', 'performance', 'benchmark', 'profiling'],
  LOGS: ['!logs', 'log analysis', 'phân tích log', 'error log'],
  RAG: ['!ask', 'tìm kiếm', 'search', 'hỏi', 'giải thích', 'là gì', 'như thế nào'],
};

/**
 * Phân loại intent: Semantic (Cosine Similarity) → Keyword fallback
 * Semantic router chạy async → cần await ở caller
 */
async function classifyIntentAsync(text) {
  const lower = text.toLowerCase();

  // 1. Check explicit commands first (fast path)
  if (lower.startsWith('!run ')) return 'CODE';
  if (lower.startsWith('!code ')) return 'CODE';
  if (lower.startsWith('!debate ')) return 'DEBATE';
  if (lower.startsWith('!review')) return 'REVIEW';
  if (lower.startsWith('!incident')) return 'INCIDENT';
  if (lower.startsWith('!analyze ')) return 'ANALYZE';
  if (lower.startsWith('!audit ')) return 'AUDIT';
  if (lower.startsWith('!perf ')) return 'PERF';
  if (lower.startsWith('!profile')) return 'PROFILE';
  if (lower.startsWith('!history ')) return 'HISTORY';
  if (lower.startsWith('!whenwas ')) return 'WHENWAS';
  if (lower.startsWith('!logs ')) return 'LOGS';
  if (lower.startsWith('!memory ') || lower.startsWith('!mem ')) return 'MEMORY';
  if (lower.startsWith('!prefer ')) return 'PREFER';
  if (lower.startsWith('!preferences')) return 'PREFERENCES';
  if (lower.startsWith('!ask ')) return 'RAG';

  // 2. Semantic routing (Cosine Similarity)
  try {
    const semanticIntent = await classifyIntentSemantic(text);
    if (semanticIntent) return semanticIntent;
  } catch (err) {
    // Semantic fail → fallback to keyword
  }

  // 3. Keyword fallback
  for (const [intent, keywords] of Object.entries(INTENT_KEYWORDS)) {
    for (const kw of keywords) {
      if (lower.includes(kw)) return intent;
    }
  }

  // 4. Scope check — nếu out of scope → trả về 'OUT_OF_SCOPE'
  try {
    const { checkScope } = await import('./lib/scope_detector.js');
    const scope = checkScope(text);
    if (!scope.inScope) {
      return 'OUT_OF_SCOPE';
    }
  } catch { /* scope detector fail → continue normally */ }

  // 5. Default: RAG
  return 'RAG';
}

// Backward compat — sync version dùng keyword only
function classifyIntent(text) {
  const lower = text.toLowerCase();
  if (lower.startsWith('!run ')) return 'CODE';
  if (lower.startsWith('!code ')) return 'CODE';
  if (lower.startsWith('!debate ')) return 'DEBATE';
  if (lower.startsWith('!review')) return 'REVIEW';
  if (lower.startsWith('!incident')) return 'INCIDENT';
  if (lower.startsWith('!analyze ')) return 'ANALYZE';
  if (lower.startsWith('!audit ')) return 'AUDIT';
  if (lower.startsWith('!perf ')) return 'PERF';
  if (lower.startsWith('!profile')) return 'PROFILE';
  if (lower.startsWith('!logs ')) return 'LOGS';
  if (lower.startsWith('!memory ') || lower.startsWith('!mem ')) return 'MEMORY';
  if (lower.startsWith('!prefer ')) return 'PREFER';
  if (lower.startsWith('!preferences')) return 'PREFERENCES';
  if (lower.startsWith('!ask ')) return 'RAG';
  for (const [intent, keywords] of Object.entries(INTENT_KEYWORDS)) {
    for (const kw of keywords) {
      if (lower.includes(kw)) return intent;
    }
  }
  return 'RAG';
}

// ── Memory Command Handler ──
async function handleMemoryCommand(message, query) {
  const { addMemory } = await import('./lib/memory_manager.js');

  // Lưu vào memory
  await addMemory({
    id: `memory:discord:${message.id}`,
    type: 'discord_chat',
    source: message.author.username,
    sourceUrl: message.url,
    content: query,
    tags: ['discord', 'user-memory'],
  });

  return `✅ Đã lưu vào trí nhớ: "${query.slice(0, 80)}${query.length > 80 ? '...' : ''}"`;
}

// ── Token Bucket Rate Limiter ───────────────────────────
// Mỗi user có 1 bucket: max 5 tokens, refill 1 token mỗi 2s
// Cho phép burst 5 lệnh liên tục, nhưng chặn spam kéo dài
const TOKEN_BUCKET_MAX = 5;
const TOKEN_REFILL_MS = 2000; // 1 token mỗi 2 giây
const tokenBuckets = new Map(); // userId → { tokens, lastRefill }
const MAX_BUCKET_ENTRIES = 1000;

function checkTokenBucket(userId) {
  const now = Date.now();
  let bucket = tokenBuckets.get(userId);

  if (!bucket) {
    bucket = { tokens: TOKEN_BUCKET_MAX, lastRefill: now };
    tokenBuckets.set(userId, bucket);
  }

  // Refill tokens dựa trên thời gian trôi qua
  const elapsed = now - bucket.lastRefill;
  const tokensToAdd = Math.floor(elapsed / TOKEN_REFILL_MS);
  if (tokensToAdd > 0) {
    bucket.tokens = Math.min(TOKEN_BUCKET_MAX, bucket.tokens + tokensToAdd);
    bucket.lastRefill = now;
  }

  // Kiểm tra và tiêu thụ token
  if (bucket.tokens > 0) {
    bucket.tokens--;
    return true; // Cho phép
  }
  return false; // Chặn — bucket rỗng
}

function cleanupTokenBuckets() {
  if (tokenBuckets.size > MAX_BUCKET_ENTRIES) {
    const oldest = tokenBuckets.keys().next().value;
    tokenBuckets.delete(oldest);
  }
}

client.on(Events.MessageCreate, async (message) => {
  try {
    if (message.author.bot) return;

    const content = message.content;

    // ── 0. Instant commands — bypass ALL middleware (rate limit, dedup, AI) ──
    if (content.trim().toLowerCase() === '!help') {
      try {
        const { EmbedBuilder } = await import('discord.js');
        const helpEmbed = new EmbedBuilder()
          .setColor(0x7F77DD)
          .setTitle('📋 Danh sách lệnh AI Brain v7.0')
          .setDescription(
            '**🔍 Hỏi đáp & Tìm kiếm:**\n' +
            '`!ask <câu hỏi>` — Hỏi AI (RAG + Web Search)\n' +
            '`!ask <câu hỏi> --deep` — Tìm kiếm sâu\n\n' +
            '**💻 Code & Thuật toán:**\n' +
            '`!run <code>` — Chạy code trong Sandbox\n' +
            '`!code <bài toán>` — Viết + chạy code\n' +
            '`!debate <bài toán>` — Tranh luận đa tác nhân\n' +
            '`!cli <tool>` — Tìm lệnh CLI (0% hallucination)\n\n' +
            '**📚 Học tập & Ôn tập:**\n' +
            '`!quiz` — Ôn tập flashcard (FSRS)\n' +
            '`!quiz stats` — Xem thống kê\n' +
            '`!answer <id> <đáp án>` — Trả lời flashcard\n' +
            '`!learn <url>` — Học từ URL/PDF\n' +
            '`!path <topic>` — Tạo lộ trình học\n' +
            '`!cs <subject>` — Học CS theo chủ đề\n' +
            '`!cs list` — Xem danh sách môn CS\n' +
            '`!gaps` — Xem lỗ hổng kiến thức\n' +
            '`!resources <keyword>` — Tìm free DevOps resources\n\n' +
            '**🔍 Phân tích & Kiểm tra:**\n' +
            '`!analyze <code>` — Phân tích code\n' +
            '`!audit <code>` — Quét bảo mật\n' +
            '`!perf <code>` — Phân tích performance\n' +
            '`!logs <text>` — Phân tích logs\n\n' +
            '**⚙️ Tuỳ chọn:**\n' +
            '`!profile` — Xem hồ sơ học tập\n' +
            '`!preferences show` — Xem tuỳ chọn\n' +
            '`!preferences model openrouter|gemini|auto` — Chọn model\n\n' +
            '**🎨 Sáng tạo:**\n' +
            '`!animate <mô tả>` — Tạo video animation\n\n' +
            '**👁️ Đa giác quan:**\n' +
            '`!vision` + ảnh — Phân tích ảnh\n' +
            '`!voice` + audio — Transcribe giọng nói\n\n' +
            '**🧠 Nâng cao:**\n' +
            '`!review` — Shadow Review\n' +
            '`!incident` — Chaos Engineering\n' +
            '`!memory <nội dung>` — Lưu trí nhớ\n' +
            '`!f1stats` — F1 Score Dashboard\n\n' +
            '**🎙️ Voice:**\n' +
            '`!join` — Tham gia voice channel\n' +
            '`!leave` — Rời voice channel\n' +
            '`!vc on` — Bật voice conversation\n' +
            '`!vc off` — Tắt voice conversation\n' +
            '`!voice study` — Chế độ học (im lặng)\n\n' +
            '**⚙️ Hệ thống:**\n' +
            '`!plugins` — Xem plugins\n' +
            '`!plugin unload <name>` — Unload plugin\n' +
            '`!agentstats` — Thống kê sử dụng agents\n\n' +
            '**💼 Career & Interview:**\n' +
            '`!draft <JD text>` — Soạn thảo outreach (3 versions)\n' +
            '`!interview start` — Mock interview\n' +
            '`!interview end` — Kết thúc mock interview\n\n' +
            '**🤖 Serena** — AI Robot Girl Companion | MIT License'
          )
          .setFooter({ text: 'Gõ !help <category> để xem chi tiết. Ví dụ: !help code' });
        return message.channel.send({ embeds: [helpEmbed] }).catch(err => console.error('Lỗi gửi help:', err));
      } catch (err) {
        console.error('Help embed error:', err);
        return message.channel.send('📋 Lỗi khi gửi menu help. Vui lòng thử lại.');
      }
    }

    // ── Tier 1: Idempotency check — chặn duplicate requests ──
    // Bypass cho lệnh nhanh (không cần cache vì chạy < 1s)
    const isFastCommand = /^!(help|voice|plugins|plugin unload|ping|status|uptime)(\s|$)/i.test(content);
    try {
      if (!isFastCommand) {
        const { createKey, check, markProcessing, markDone } = await import('./lib/idempotency.js');
        const msgKey = createKey(`${message.author.id}:${message.content}`);
        const idemCheck = check(msgKey);
        if (idemCheck.cached) {
          if (idemCheck.processing) {
            logger.debug(`[Idempotency] Duplicate request from ${message.author.id}, still processing`);
            return; // Đang xử lý, bỏ qua
          }
          if (idemCheck.result) {
            logger.debug(`[Idempotency] Returning cached result for ${message.author.id}`);
            await message.reply(idemCheck.result.answer || idemCheck.result);
            return;
          }
        }
        markProcessing(msgKey);
        // Store key để markDone sau khi xử lý xong
        message._idempotencyKey = msgKey;
      }
    } catch { /* idempotency optional */ }

    // ── User-level query dedup: block cùng query từ cùng user trong 1 giờ ──
    // Bypass cho fast commands (help, ping, status) — luôn cho phép
    if (!isFastCommand) {
    try {
      const queryHash = require('crypto').createHash('md5').update(content.toLowerCase().trim()).digest('hex');
      const userKey = message.author.id + ':' + queryHash;
      const lastTime = _userQueryCache.get(userKey);
      if (lastTime && Date.now() - lastTime < USER_QUERY_DEDUP_MS) {
        logger.info(`[Dedup] User ${message.author.id} sent same query within 1h, skipping`);
        return; // Bỏ qua — đã xử lý query này gần đây
      }
      _userQueryCache.set(userKey, Date.now());
      // Cleanup old entries (giữ < 5000 entries)
      if (_userQueryCache.size > 5000) {
        const cutoff = Date.now() - USER_QUERY_DEDUP_MS;
        for (const [k, v] of _userQueryCache) {
          if (v < cutoff) _userQueryCache.delete(k);
        }
      }
    } catch { /* dedup optional */ }
    } // end isFastCommand bypass

    // Token Bucket rate limit — bypass cho fast commands (help, ping, status)
    if (!isFastCommand && !checkTokenBucket(message.author.id)) {
      return; // Silent drop — bucket rỗng
    }
    cleanupTokenBuckets();

    // ── 0a. Implicit Feedback: Record dwell time from previous outbound ──
    try {
      const { implicitFeedback } = await import('./lib/implicit_feedback.js');
      const userLinks = await implicitFeedback._getRecentUnreplied(message.author.id);
      if (userLinks && userLinks.length > 0) {
        const lastLink = userLinks[userLinks.length - 1];
        const dwellMs = Date.now() - new Date(lastLink.sent_at).getTime();
        await implicitFeedback.recordDwellTime(lastLink.id, message.author.id, dwellMs);
      }
    } catch { /* implicit feedback non-critical */ }

    // ── 0a. Mood State Analysis ──
    try {
      const { moodState } = await import('./lib/mood_state.js');
      const moodResult = moodState.analyze(message.author.id, message.content, {
        hour: new Date().getHours(),
        messageLength: message.content.length,
      });
      await moodState.recordState(message.author.id, moodResult);
    } catch { /* mood analysis non-critical */ }

    // ── 0a. Session Memory — save user message ──
    try {
      const { SessionMemory } = await import('./lib/session_memory.js');
      SessionMemory.save(message.author.id, 'user', content);
    } catch { /* session memory non-critical */ }

    // ── 0a. Voice Channel commands ──
    if (content === '!voice join' || content === '!join') {
      try {
        const voiceChannel = message.member?.voice?.channel;
        if (!voiceChannel) {
          await message.reply('❌ Bạn cần vào voice channel trước!');
          return;
        }
        const { joinChannel } = await import('./agents/voice_conversation.js');
        const result = await joinChannel(voiceChannel);
        if (result.success) {
          await message.reply(`🎙️ Đã tham gia voice channel **${voiceChannel.name}**! Dùng \`!vc on\` để bật chế độ nghe & nói.`);
        } else {
          await message.reply(`❌ Lỗi: ${result.error}`);
        }
      } catch (err) {
        await message.reply('❌ Lỗi: ' + err.message);
      }
      return;
    }

    if (content === '!voice leave' || content === '!leave') {
      try {
        if (!message.guild) {
          return message.reply('❌ Lệnh này chỉ dùng trong server, không dùng được trong DM.');
        }
        const { leaveChannel } = await import('./agents/voice_conversation.js');
        leaveChannel(message.guild.id);
        await message.reply('👋 Đã rời voice channel.');
      } catch (err) {
        await message.reply('❌ Lỗi: ' + err.message);
      }
      return;
    }

    // ── Voice Conversation: !vc on / !vc off ──
    if (content === '!vc on' || content === '!vc start') {
      try {
        if (!message.guild) return message.reply('❌ Chỉ dùng trong server.');
        const { isConnected, startListening } = await import('./agents/voice_conversation.js');
        if (!isConnected(message.guild.id)) {
          // Tự động join nếu user đang trong voice channel
          const voiceChannel = message.member?.voice?.channel;
          if (!voiceChannel) {
            return message.reply('❌ Bạn cần vào voice channel trước! Dùng `!join` để mời bot.');
          }
          const { joinChannel } = await import('./agents/voice_conversation.js');
          const r = await joinChannel(voiceChannel);
          if (!r.success) return message.reply(`❌ Lỗi join: ${r.error}`);
        }
        const result = startListening(message.guild.id);
        if (result.success) {
          await message.reply('🎤 **Voice conversation BẬT!** Tôi sẽ nghe bạn nói và trả lời bằng giọng nữ. Nói đi! 🗣️');
        } else {
          await message.reply(`❌ Lỗi: ${result.error}`);
        }
      } catch (err) {
        await message.reply('❌ Lỗi: ' + err.message);
      }
      return;
    }

    if (content === '!vc off' || content === '!vc stop') {
      try {
        if (!message.guild) return message.reply('❌ Chỉ dùng trong server.');
        const { stopListening } = await import('./agents/voice_conversation.js');
        const result = stopListening(message.guild.id);
        if (result.success) {
          await message.reply('🔇 **Voice conversation TẮT.** Tôi sẽ không nghe nữa.');
        } else {
          await message.reply(`❌ Lỗi: ${result.error}`);
        }
      } catch (err) {
        await message.reply('❌ Lỗi: ' + err.message);
      }
      return;
    }

    // ── 0a. Voice Study Mode commands ──
    if (content === '!voice study' || content === '!voice bắt đầu học') {
      try {
        const { setUserStudyState } = await import('./agents/VoiceAgent.js');
        setUserStudyState(message.author.id, true);
        await message.reply('📚 **Chế độ học đã bật!** Tôi sẽ im lặng và chỉ lên tiếng khi bạn gọi "Serena". Chúc bạn học tối! 🎯');
      } catch (err) {
        await message.reply('❌ Lỗi: ' + err.message);
      }
      return;
    }
    if (content === '!voice stop' || content === '!voice học xong') {
      try {
        const { setUserStudyState } = await import('./agents/VoiceAgent.js');
        setUserStudyState(message.author.id, false);
        await message.reply('🎉 **Chế độ học đã tắt!** Tôi có thể trò chuyện bình thường rồi.');
      } catch (err) {
        await message.reply('❌ Lỗi: ' + err.message);
      }
      return;
    }

    // ── !agentstats command: Agent Usage Statistics ──
    if (content === '!agentstats') {
      try {
        const { orchestratorGuard } = await import('./lib/orchestrator_guard.js');
        const usage = orchestratorGuard.getAgentUsage();
        if (usage.size === 0) {
          return message.reply('📊 Chưa có dữ liệu agent usage. Hãy dùng vài lệnh trước!');
        }
        const lines = [...usage.entries()].sort(([, a], [, b]) => b - a)
          .map(([name, count]) => `• **${name}**: ${count} calls`);
        return message.reply({
          embeds: [{
            color: 0x7F77DD,
            title: '📊 Agent Usage Statistics',
            description: lines.join('\n'),
            footer: { text: 'Track since last restart' },
          }],
          allowedMentions: { parse: [], repliedUser: false },
        });
      } catch (err) {
        return message.reply(`❌ Lỗi: ${err?.message || err}`);
      }
    }

    // ── !draft command: Outreach Drafting (Tier 4) ──
    if (content.startsWith('!draft ')) {
      const input = content.slice(7).trim();
      if (input.length < 50) {
        return message.reply(
          '📋 Paste nội dung JD hoặc recruiter profile vào sau `!draft`.\n' +
          'Ví dụ: `!draft We are looking for a backend engineer with 2+ years...`'
        );
      }
      try {
        await message.channel.sendTyping();
        const { OutreachDraftAgent } = await import('./agents/OutreachDraftAgent.js');
        const agent = new OutreachDraftAgent();
        const drafts = await agent.execute(input, message.author.id);

        // Gửa qua DM để không spam channel chung
        try {
          const dm = await message.author.createDM();
          await dm.send({
            embeds: [{
              color: 0x7F77DD,
              title: '✉️ Outreach Drafts — Chọn 1 rồi copy sang LinkedIn/email',
              description: drafts.slice(0, 4000),
              footer: { text: 'Nhớ thay [NAME] và [COMPANY] trước khi gửi' },
            }],
          });
          return message.reply('✅ Đã gửi 3 phiên bản qua DM.');
        } catch {
          // Fallback: gửa trong channel nếu không được DM
          return message.reply({
            embeds: [{
              color: 0x7F77DD,
              title: '✉️ Outreach Drafts',
              description: drafts.slice(0, 4000),
              footer: { text: 'Nhớ thay [NAME] và [COMPANY] trước khi gửi' },
            }],
          });
        }
      } catch (err) {
        return message.reply(`❌ Lỗi: ${err?.message || err}`);
      }
    }

    // ── !done: Đánh dấu đã giải bài tập Algo ──
    if (content === '!done' || content === '!done ') {
      try {
        const { execSync } = await import('child_process');
        execSync('node scripts/algo_webhook.js done', { encoding: 'utf8', timeout: 10000 });
        return message.reply('✅ Đã đánh dấu giải xong! Đáp án sẽ không gửi lúc 23:59.');
      } catch (err) {
        return message.reply(`❌ Lỗi: ${err?.message || err}`);
      }
    }

    // ── 0. Socratic Mode: Kiểm tra session đang active ──
    const activeSocratic = await getSocraticSession(message.author.id);
    if (activeSocratic) {
      // User đang trong Socratic session — xử lý câu trả lời
      await handleSocraticReply(message, activeSocratic);
      return; // Không route sang agent khác
    }

    // ── 0b. Feedback handler (👍/👎) ──
    if (message.content.startsWith('feedback:')) {
      const parts = message.content.split(':');
      const sentiment = parts[1]; // '👍' or '👎'
      const originalMessageId = parts[2];
      // Store feedback cho F1 evaluation
      try {
        const { getDb } = await import('./lib/flashcard_db.js');
        const db = await getDb();
        db.prepare(`
          INSERT INTO f1_feedback (user_id, message_id, sentiment, created_at)
          VALUES (?, ?, ?, datetime('now'))
        `).run(message.author.id, originalMessageId, sentiment);
        await message.reply(`✅ Feedback recorded: ${sentiment}`);
      } catch (err) {
        await message.reply('❌ Lỗi khi lưu feedback.');
      }
      return;
    }

    // ── 0b. Explicit !learn command → bắt đầu Socratic ──
    if (message.content.startsWith('!learn ')) {
      const topic = message.content.slice(7).trim();
      if (topic) {
        await startSocraticSession(message, topic, true);
        return;
      }
    }

    // ── Tier 1: Persona Routing (AGI giả) ──
    // Phân loại intent trước: THERAPIST vs TECHNICAL
    // Giảm ~70% API cost bỏ qua RAG 7 tầng khi user chỉ cần tâm sự
    let personaIntent = null;
    try {
      const { classifyIntentSemantic } = await import('./lib/semantic_router.js');
      personaIntent = await classifyIntentSemantic(content);
    } catch { /* persona routing non-critical */ }

    // Therapist bypass: không qua RAG pipeline, dùng LLM nhẹ
    if (personaIntent === 'THERAPIST' && !content.startsWith('!')) {
      try {
        const { ask } = await import('./lib/llm.js');
        const response = await ask(content, {
          systemPrompt: 'Bạn là Serena, người bạn đồng hành thấu cảm. Lắng nghe, đặt câu hỏi mở, không phán xét. Nếu cần, gợi ý nhẹ nhàng cách giải tỏa stress. Trả lời ngắn gọn, ấm áp, bằng tiếng Việt.',
          maxTokens: 512,
          temperature: 0.8,
        });
        await message.reply(response.text || response);
      } catch {
        await message.reply('Mình nghe bạn nè. Kể thêm đi 💙');
      }
      return;
    }

    // ── Router: Phân loại intent (Semantic + Keyword fallback) ──
    const intent = await classifyIntentAsync(message.content);

    // Nếu không match command nào, bỏ qua
    if (!message.content.startsWith('!') && !message.content.startsWith(prefix)) return;

    // ── Out of Scope: Câu hỏi nằm ngoài khả năng ──
    if (intent === 'OUT_OF_SCOPE') {
      return message.reply({
        content: '🤔 Câu hỏi này có thể nằm ngoài phạm vi chuyên môn của tôi.\n\n' +
          'Tôi chuyên về: **lập trình, thuật toán, system design, DevOps, ML/AI**.\n\n' +
          'Bạn có thể thử:\n' +
          '• Hỏi về các chủ đề kỹ thuật\n' +
          '• Dùng `!ask` để tôi tìm kiếm trên web\n' +
          '• Dùng `!help` để xem danh sách lệnh\n' +
          '• Dùng `!path <topic>` để xem lộ trình học',
        allowedMentions: { parse: [], repliedUser: false },
      });
    }

    // ── RAG intent: !ask command ──
    if (intent === 'RAG' && message.content.startsWith('!ask ')) {
      try {
        const query = message.content.slice(5).trim();
        if (!query) {
          return message.reply('📋 Dùng: `!ask <câu hỏi>` hoặc `!ask <câu hỏi> --deep`');
        }
        // Inject session history vào context
        let history = [];
        try {
          const { SessionMemory } = await import('./lib/session_memory.js');
          history = SessionMemory.getRecent(message.author.id, 6);
        } catch { /* optional */ }
        const ragResult = await orchestratorGuard.routeWithGuard('RAG', {
          query,
          options: { userId: message.author.id, history },
        }, message.author.id);

        // Build formatted reply with sources
        const answer = ragResult?.answer || ragResult?.text || ragResult?.result?.answer || ragResult?.result?.text || 'Không tìm thấy câu trả lời.';
        const sourcesFormatted = ragResult?.sourcesFormatted || ragResult?.result?.sourcesFormatted || '';
        const source = ragResult?.source || ragResult?.result?.source || 'unknown';
        const confidence = ragResult?.confidence || ragResult?.result?.confidence;

        // Build final message
        let reply = answer;

        // Add sources section if available
        if (sourcesFormatted && sourcesFormatted.trim()) {
          reply += `\n\n---\n📚 **Nguồn tham kháo:**\n${sourcesFormatted}`;
        }

        // Add confidence badge
        if (confidence) {
          const confScore = Math.round((confidence.score || 0) * 100);
          const confEmoji = confScore >= 80 ? '🟢' : confScore >= 50 ? '🟡' : '🔴';
          reply += `\n\n${confEmoji} Độ tin cậy: ${confScore}% | 📡 Nguồn: ${source}`;
        }

        // Add feedback hint
        reply += '\n\n👍 Hữu ích | 👎 Không hữu ích';

        const sentMsg = await message.reply(reply);

        // Add reaction buttons
        try {
          await sentMsg.react('👍');
          await sentMsg.react('👎');
        } catch { /* reactions optional */ }

        // Save assistant reply to session memory
        try {
          const { SessionMemory } = await import('./lib/session_memory.js');
          SessionMemory.save(message.author.id, 'assistant', reply);
        } catch { /* optional */ }
      } catch (err) {
        await message.reply(`❌ Lỗi RAG: ${err?.message || err}`);
      }
      return;
    }

    // ── !f1stats command: F1 Score Dashboard ──
    if (message.content === '!f1stats' || message.content.startsWith('!f1stats ')) {
      try {
        const { F1Evaluator } = await import('./lib/f1_evaluator.js');
        const { getDb } = await import('./lib/flashcard_db.js');
        const db = await getDb();
        const days = parseInt(message.content.slice(8).trim()) || 7;
        const metricsList = await F1Evaluator.getAllMetrics(db, days);
        const output = F1Evaluator.formatDashboard(metricsList);
        await message.reply({
          embeds: [{
            color: 0x7F77DD,
            title: `📊 F1 Score Dashboard — ${days} ngày gần đây`,
            description: output,
            footer: { text: 'Gap cao = accuracy illusion. F1 là số đáng tin.' },
          }],
          allowedMentions: { parse: [], repliedUser: false },
        });
      } catch (err) {
        await message.reply(`❌ Lỗi: ${err?.message || err}`);
      }
      return;
    }

    // ── !profile command: Xem hồ sơ học tập ──
    if (intent === 'PROFILE' || message.content === '!profile' || message.content.startsWith('!profile ')) {
      try {
        const { userProfileManager } = await import('./lib/user_profile.js');
        const userId = message.author.id;
        const profile = await userProfileManager.getProfile(userId, message.author.username);
        const stats = profile.topic_stats || {};

        const totalQuestions = Object.values(stats).reduce((s, t) => s + (t.asked || 0), 0);
        const totalCorrect   = Object.values(stats).reduce((s, t) => s + (t.correct || 0), 0);
        const accuracy = totalQuestions > 0 ? Math.round((totalCorrect / totalQuestions) * 100) : 0;

        const topStrengths = Object.entries(profile.strengths || {})
          .sort(([,a],[,b]) => b - a).slice(0, 5);
        const topWeak = Object.entries(profile.weak_areas || {})
          .sort(([,a],[,b]) => b - a).slice(0, 3);

        const speedBar = '█'.repeat(Math.round(profile.learn_speed * 10)) +
                         '░'.repeat(10 - Math.round(profile.learn_speed * 10));

        const { EmbedBuilder } = await import('discord.js');
        const embed = new EmbedBuilder()
          .setColor(0x7F77DD)
          .setTitle(`📊 Hồ sơ học tập — ${message.author.username}`)
          .addFields(
            { name: '📈 Tổng quan', value: `Tổng câu hỏi: **${totalQuestions}** | Chính xác: **${accuracy}%** | Sessions: **${profile.session_count || 0}**`, inline: false },
            { name: '⚡ Tốc độ tiếp thu', value: `\`${speedBar}\` ${Math.round(profile.learn_speed * 100)}%`, inline: false },
            { name: '🎯 Phong cách học', value: `\`${profile.learn_style || 'example_first'}\` · Độ chi tiết: \`${profile.depth_pref || 'auto'}\``, inline: false },
            { name: '💪 Điểm mạnh', value: topStrengths.length ? topStrengths.map(([t, s]) => `\`${t}\` ${Math.round(s*100)}%`).join(' | ') : '_Chưa đủ dữ liệu_', inline: false },
            { name: '📝 Cần ôn thêm', value: topWeak.length ? topWeak.map(([t, c]) => `\`${t}\` (hỏi lại ${c} lần)`).join(' | ') : '_Không có_', inline: false },
          )
          .setFooter({ text: 'Dùng !prefer example_first | theory_first | code_heavy | concise | detailed để điều chỉnh' });

        await message.reply({ embeds: [embed] });
      } catch (err) {
        await message.reply({ content: `❌ Lỗi profile: ${err?.message || err}` });
      }
      return;
    }

    // ── !prefer command: Điều chỉnh phong cách học ──
    if (message.content.startsWith('!prefer ')) {
      try {
        const { userProfileManager } = await import('./lib/user_profile.js');
        const args = message.content.slice(8).trim().split(/\s+/);
        const value = args[0];
        const validStyles = ['example_first', 'theory_first', 'code_heavy', 'visual'];
        const validDepths = ['concise', 'detailed', 'auto'];

        if (validStyles.includes(value)) {
          await userProfileManager.setUserPreference(message.author.id, { style: value });
          await message.reply(`✅ Đã cập nhật phong cách học: \`${value}\``);
        } else if (validDepths.includes(value)) {
          await userProfileManager.setUserPreference(message.author.id, { depth: value });
          await message.reply(`✅ Đã cập nhật độ chi tiết: \`${value}\``);
        } else {
          await message.reply('📋 Dùng: `!prefer example_first | theory_first | code_heavy | visual | concise | detailed | auto`');
        }
      } catch (err) {
        await message.reply({ content: `❌ Lỗi: ${err?.message || err}` });
      }
      return;
    }

    // ── !history command: Xem facts gần đây từ Temporal KG ──
    if (intent === 'HISTORY' || message.content.startsWith('!history ')) {
      try {
        const { TemporalKG } = await import('./lib/temporal_kg.js');
        const args = message.content.slice(9).trim();
        const daysMatch = args.match(/^(\d+)\s+(.+)/);
        const days = daysMatch ? parseInt(daysMatch[1]) : 30;
        const topic = daysMatch ? daysMatch[2] : args;

        if (!topic) {
          return message.reply({ content: '📋 Dùng: `!history <topic>` hoặc `!history 7 <topic>`' });
        }

        const facts = TemporalKG.getRecentFacts(topic, days);
        if (!facts.length) {
          return message.reply({ content: `🔍 Không tìm thấy facts nào về **${topic}** trong ${days} ngày gần đây.` });
        }

        const lines = facts.map(f =>
          `• **${f.source}** → *${f.relationship_type}* → **${f.target}** (${Math.round(f.confidence * 100)}%)`
        ).join('\n');

        const { EmbedBuilder } = await import('discord.js');
        const embed = new EmbedBuilder()
          .setColor(0x1D9E75)
          .setTitle(`📚 Facts về "${topic}" — ${days} ngày gần đây`)
          .setDescription(lines.slice(0, 4000))
          .setFooter({ text: `${facts.length} facts tìm thấy · !whenwas để query tại thời điểm cụ thể` });

        await message.reply({ embeds: [embed] });
      } catch (err) {
        await message.reply({ content: `❌ Lỗi: ${err?.message || err}` });
      }
      return;
    }

    // ── !whenwas command: Query KG tại thời điểm cụ thể ──
    if (intent === 'WHENWAS' || message.content.startsWith('!whenwas ')) {
      try {
        const { TemporalKG } = await import('./lib/temporal_kg.js');
        const args = message.content.slice(9).trim();
        const parts = args.split(' ');
        const dateStr = parts[parts.length - 1];
        const isDate = /\d{4}-\d{2}-\d{2}/.test(dateStr);
        const topic = isDate ? parts.slice(0, -1).join(' ') : parts.join(' ');
        const pointInTime = isDate ? new Date(dateStr).toISOString() : null;

        if (!topic) {
          return message.reply({ content: '📋 Dùng: `!whenwas <topic>` hoặc `!whenwas <topic> YYYY-MM-DD`' });
        }

        const facts = TemporalKG.searchAtTime(topic, pointInTime);
        const label = pointInTime ? `vào ${dateStr}` : 'hiện tại';

        if (!facts.length) {
          return message.reply({ content: `🔍 Không có facts nào về **${topic}** ${label}.` });
        }

        const current = facts.filter(f => f.status === 'current');
        const historical = facts.filter(f => f.status === 'historical');

        const fmt = (arr) => arr.map(f =>
          `• **${f.source}** → *${f.relationship_type}* → **${f.target}** (${Math.round(f.confidence * 100)}%)`
        ).join('\n') || '_Không có_';

        const { EmbedBuilder } = await import('discord.js');
        const embed = new EmbedBuilder()
          .setColor(0x7F77DD)
          .setTitle(`🕐 Knowledge Graph về "${topic}" ${label}`)
          .addFields(
            { name: `✅ Đang valid (${current.length})`, value: fmt(current).slice(0, 1000), inline: false },
            { name: `📜 Lịch sử (${historical.length})`, value: fmt(historical).slice(0, 1000), inline: false },
          )
          .setFooter({ text: '!whenwas <topic> YYYY-MM-DD để query tại thời điểm cụ thể' });

        await message.reply({ embeds: [embed] });
      } catch (err) {
        await message.reply({ content: `❌ Lỗi: ${err?.message || err}` });
      }
      return;
    }

    // ── !memory command: Lưu trí nhớ ──
    if (intent === 'MEMORY' || message.content.startsWith('!memory ') || message.content.startsWith('!mem ')) {
      const memQuery = message.content.replace(/^!memory\s*|^!mem\s*/i, '').trim();
      if (!memQuery) {
        return message.reply({
          content: 'Vui long gui noi dung can luu. Vi du: `!memory Toi dang hoc Spring Boot`',
          allowedMentions: { parse: [], repliedUser: false },
        });
      }
      const result = await handleMemoryCommand(message, memQuery);
      return message.reply({ content: result, allowedMentions: { parse: [], repliedUser: false } });
    }

    // ── !review command: Shadow Review (Ôn tập Kiến trúc cá nhân) ──
    if (intent === 'REVIEW') {
      const args = message.content.replace(/^!review\s*/i, '').trim();
      const userId = message.author.id;

      // Parse --level flag
      let level = 1;
      if (args.includes('--level 2') || args.includes('--lvl 2')) level = 2;
      if (args.includes('--level 3') || args.includes('--lvl 3')) level = 3;

      // Check if user is submitting code for an active session
      // Format: !review <session_id> <code> or just code after challenge
      const sessionMatch = args.match(/^(\S+)\s+([\s\S]+)$/);
      if (sessionMatch && sessionMatch[1].startsWith('review:')) {
        const sessionId = sessionMatch[1];
        const userCode = sessionMatch[2].trim();
        // Extract language from code or default to cpp
        const langMatch = userCode.match(/^```(\w+)/);
        const language = langMatch ? langMatch[1] : 'cpp';
        const cleanCode = userCode.replace(/^```\w*\n?/, '').replace(/```$/, '').trim();

        const waitingMsg = await message.reply({
          content: '🔍 **MentorAgent** đang chấm code của bạn...',
          allowedMentions: { parse: [], repliedUser: false },
        });

        try {
          const result = await submitReviewAnswer(userId, sessionId, cleanCode, language);
          await waitingMsg.edit({
            content: truncateForDiscord(result.message),
            allowedMentions: { parse: [] },
          });
        } catch (err) {
          await waitingMsg.edit({
            content: `❌ Lỗi chấm code: ${err?.message || err}`,
            allowedMentions: { parse: [] },
          });
        }
        return;
      }

      // Check for hint request: !review hint <session_id>
      if (args.startsWith('hint ')) {
        const sessionId = args.replace(/^hint\s*/, '').trim();
        try {
          const result = await getNextHint(userId, sessionId);
          return message.reply({
            content: truncateForDiscord(result.message),
            allowedMentions: { parse: [], repliedUser: false },
          });
        } catch (err) {
          return message.reply({
            content: `❌ Lỗi: ${err?.message || err}`,
            allowedMentions: { parse: [], repliedUser: false },
          });
        }
      }

      // Start new review session
      const waitingMsg = await message.reply({
        content: '🔍 **Shadow Review** đang tìm code cũ của bạn trong memory...',
        allowedMentions: { parse: [], repliedUser: false },
      });

      try {
        const result = await startShadowReview(userId, level);
        await waitingMsg.edit({
          content: truncateForDiscord(result.message),
          allowedMentions: { parse: [] },
        });
      } catch (err) {
        await waitingMsg.edit({
          content: `❌ Shadow Review lỗi: ${err?.message || err}`,
          allowedMentions: { parse: [] },
        });
      }
      return;
    }

    // ── !incident command: Chaos Engineering (3 AM Incident Simulator) ──
    if (intent === 'INCIDENT') {
      const args = message.content.replace(/^!incident\s*/i, '').trim();
      const userId = message.author.id;

      // Parse difficulty
      let difficulty = 'medium';
      if (args.includes('--easy') || args.includes('--de')) difficulty = 'easy';
      if (args.includes('--hard') || args.includes('--kho')) difficulty = 'hard';

      // Check if user is submitting hotfix
      const hotfixMatch = args.match(/^hotfix\s+(\S+)\s+([\s\S]+)$/);
      if (hotfixMatch) {
        const sessionId = hotfixMatch[1];
        const userCode = hotfixMatch[2].trim();
        const langMatch = userCode.match(/^```(\w+)/);
        const language = langMatch ? langMatch[1] : 'cpp';
        const cleanCode = userCode.replace(/^```\w*\n?/, '').replace(/```$/, '').trim();

        const session = getIncidentSession(sessionId);
        if (!session) {
          return message.reply({
            content: '❌ Session không tồn tại. Gõ `!incident` để bắt đầu sự cố mới.',
            allowedMentions: { parse: [], repliedUser: false },
          });
        }

        const waitingMsg = await message.reply({
          content: '🔥 **IncidentAgent** đang chấm hotfix...',
          allowedMentions: { parse: [], repliedUser: false },
        });

        try {
          const result = await evaluateHotfix(session.incident, cleanCode, language);
          const scoreBar = '█'.repeat(Math.round(result.score)) + '░'.repeat(10 - Math.round(result.score));
          let output = [
            `📊 **Kết quả Hotfix**`,
            `Score: [${scoreBar}] ${result.score}/10`,
            `${result.passed ? '✅ Sự cố đã được xử lý!' : '❌ Hotfix chưa đạt.'}`,
            ``,
            `💬 ${result.feedback}`,
          ].join('\n');

          if (result.passed) {
            output += `\n\n🎉 **Chúc mừng! Bạn đã xử lý sự cố thành công!**\nGõ \`!incident\` để thử sự cố tiếp theo.`;
          } else {
            output += `\n\n💡 Gõ \`!incident hotfix <session_id> <code>\` để thử lại.`;
          }

          await waitingMsg.edit({
            content: truncateForDiscord(output),
            allowedMentions: { parse: [] },
          });
        } catch (err) {
          await waitingMsg.edit({
            content: `❌ Lỗi chấm: ${err?.message || err}`,
            allowedMentions: { parse: [] },
          });
        }
        return;
      }

      // Start new incident
      const waitingMsg = await message.reply({
        content: '🚨 **IncidentAgent** đang tạo kịch bản sự cố...',
        allowedMentions: { parse: [], repliedUser: false },
      });

      try {
        const result = await generateIncident(userId, difficulty);
        const incident = result.incident;
        const sessionId = createIncidentSession(userId, incident);

        const output = [
          `🚨 **${incident.title}**`,
          `Severity: ${incident.severity} | Difficulty: ${incident.difficulty}`,
          ``,
          `📋 **Tình huống:**`,
          incident.scenario,
          ``,
          `📜 **Logs:**`,
          `\`\`\``,
          incident.logs.slice(0, 1500),
          `\`\`\``,
          ``,
          `📊 **Metrics:**`,
          `\`\`\``,
          incident.metrics,
          `\`\`\``,
          ``,
          `💻 **Code có lỗi:**`,
          `\`\`\`${incident.language}`,
          incident.buggyCode.slice(0, 1200),
          `\`\`\``,
          ``,
          `⏱️ Thời gian: ${incident.timeLimit} phút`,
          ``,
          `**Nhiệm vụ:**`,
          `1. Đọc log và metrics`,
          `2. Tìm root cause`,
          `3. Viết hotfix code`,
          `4. Nộp: \`!incident hotfix ${sessionId} <code>\``,
          ``,
          `💡 Cần gợi ý? Gõ \`!review hint ${sessionId}\``,
        ].join('\n');

        await waitingMsg.edit({
          content: truncateForDiscord(output),
          allowedMentions: { parse: [] },
        });
      } catch (err) {
        await waitingMsg.edit({
          content: `❌ IncidentAgent lỗi: ${err?.message || err}`,
          allowedMentions: { parse: [] },
        });
      }
      return;
    }

    // ── !analyze command: Phân tích URL (GitHub repo / YouTube / Web) ──
    if (intent === 'ANALYZE') {
      const url = message.content.replace(/^!analyze\s*/i, '').trim();
      if (!url) {
        return message.reply({
          content: '📊 **AnalysisAgent** — Phân tích GitHub repo / YouTube video / Web page\n\n' +
            '**Cách dùng:** `!analyze <URL>`\n' +
            '**Ví dụ:**\n' +
            '`!analyze https://github.com/facebook/react`\n' +
            '`!analyze https://youtube.com/watch?v=abc123`\n' +
            '`!analyze https://example.com/article`\n\n' +
            'Kết quả: Summary + Flashcards + Key concepts',
          allowedMentions: { parse: [], repliedUser: false },
        });
      }

      const waitingMsg = await message.reply({
        content: `🔍 **AnalysisAgent** đang phân tích: ${url.slice(0, 80)}...`,
        allowedMentions: { parse: [], repliedUser: false },
      });

      try {
        const result = await analyzeUrl(url, { createFlashcards: true });

        if (!result.success) {
          await waitingMsg.edit({
            content: `❌ Phân tích thất bại: ${result.error || 'Không thể phân tích URL này'}`,
            allowedMentions: { parse: [] },
          });
          return;
        }

        const output = [
          `## 📊 Analysis Result`,
          `**URL:** ${url}`,
          `**Loại:** ${result.type || 'unknown'}`,
          `**Category:** ${result.category || 'Other'}`,
          ``,
          `### 📝 Summary:`,
          ...(result.summary || []).slice(0, 5).map(s => `• ${s}`),
          ``,
          `### 🎯 Key Concepts:`,
          ...(result.key_concepts || []).slice(0, 8).map(c => `• ${c}`),
          ``,
          `### 🛠 Technologies:`,
          ...(result.technologies || []).slice(0, 6).map(t => `• ${t}`),
          ``,
          `### 📚 Flashcards: ${result.flashcards?.length || 0} cards generated`,
          result.flashcards?.length > 0 ? `Xem trong DB hoặc dùng \`!quiz\` để ôn tập` : '',
        ].filter(Boolean).join('\n');

        await waitingMsg.edit({
          content: truncateForDiscord(output),
          allowedMentions: { parse: [] },
        });

        // Track outbound URL for implicit feedback
        _outboundTracker.track(
          message.author.id,
          url,
          result.type || 'article',
          waitingMsg.id
        );
      } catch (err) {
        await waitingMsg.edit({
          content: `❌ AnalysisAgent lỗi: ${err?.message || err}`,
          allowedMentions: { parse: [] },
        });
      }
      return;
    }

    // ── !vision command: Phân tích ảnh bằng Gemini Vision ──
    if (message.content.startsWith('!vision')) {
      const hasImage = message.attachments.some(att => att.contentType?.startsWith('image/'));
      if (!hasImage) {
        return message.reply({
          content: '📸 **Vision Agent** — Phân tích ảnh bằng Gemini Vision\n\n' +
            '**Cách dùng:** Gửi ảnh đính kèm cùng lệnh `!vision`\n' +
            '**Ví dụ:** `!vision Phân tích lỗi này` (kèm ảnh chụp màn hình)\n\n' +
            'Hỗ trợ: ảnh lỗi code, sơ đồ, bài giảch, bất kỳ ảnh nào bạn muốn phân tích.',
          allowedMentions: { parse: [], repliedUser: false },
        });
      }

      const waitingMsg = await message.reply({
        content: '👁️ **Vision Agent** đang phân tích ảnh...',
        allowedMentions: { parse: [], repliedUser: false },
      });

      try {
        const result = await processVisionMessage(message);

        if (!result.success) {
          await waitingMsg.edit({
            content: `❌ ${result.error}`,
            allowedMentions: { parse: [] },
          });
          return;
        }

        // Format results
        let output = '👁️ **Vision Agent — Kết quả phân tích:**\n\n';
        for (const r of result.results) {
          if (r.error) {
            output += `📎 **${r.fileName}:** ❌ ${r.error}\n\n`;
          } else {
            output += `📎 **${r.fileName}:**\n${r.analysis.slice(0, 1500)}${r.analysis.length > 1500 ? '...' : ''}\n\n`;
          }
        }

        await waitingMsg.edit({
          content: truncateForDiscord(output),
          allowedMentions: { parse: [] },
        });
      } catch (err) {
        await waitingMsg.edit({
          content: `❌ Vision Agent lỗi: ${err?.message || err}`,
          allowedMentions: { parse: [] },
        });
      }
      return;
    }

    // ── !voice command: Transcribe voice message bằng whisper.cpp ──
    if (message.content.startsWith('!voice')) {
      const hasAudio = message.attachments.some(att =>
        att.contentType?.startsWith('audio/') ||
        /\.(ogg|mp3|wav|m4a|webm)$/i.test(att.name || '')
      );

      if (!hasAudio) {
        return message.reply({
          content: '🎤 **Voice Agent** — Transcribe voice message bằng whisper.cpp\n\n' +
            '**Cách dùng:** Gửi audio đính kèm cùng lệnh `!voice`\n' +
            '**Hỗ trợ:** .ogg, .mp3, .wav, .m4a, .webm\n\n' +
            'Sau khi transcribe, bot sẽ tự động phân tích ý định và trả lời.',
          allowedMentions: { parse: [], repliedUser: false },
        });
      }

      const waitingMsg = await message.reply({
        content: '🎤 **Voice Agent** đang transcribe audio...',
        allowedMentions: { parse: [], repliedUser: false },
      });

      try {
        const result = await processVoiceMessage(message);

        if (!result.success) {
          await waitingMsg.edit({
            content: `❌ ${result.error}`,
            allowedMentions: { parse: [] },
          });
          return;
        }

        // Format results — transcribe + auto-answer
        let output = '🎤 **Voice Agent — Kết quả:**\n\n';
        let transcribedText = '';

        for (const r of result.results) {
          if (r.error) {
            output += `📎 **${r.fileName}:** ❌ ${r.error}\n`;
            if (r.hint) output += `💡 ${r.hint}\n`;
            output += '\n';
          } else {
            transcribedText += r.text + ' ';
            output += `📎 **${r.fileName}:** "${r.text}" (${r.language || 'vi'})\n\n`;
          }
        }

        await waitingMsg.edit({
          content: truncateForDiscord(output),
          allowedMentions: { parse: [] },
        });

        // If transcription successful, auto-answer via RAG
        if (transcribedText.trim()) {
          const answerMsg = await message.reply({
            content: '🤔 Đang phân tích ý định từ voice...',
            allowedMentions: { parse: [], repliedUser: false },
          });

          try {
            const { answerQuestion } = await import('./agents/RagAgent.js');
            const ragResult = await answerQuestion(transcribedText.trim());
            await answerMsg.edit({
              content: `🎤 → 💬 **Voice Q&A:**\n\n**Câu hỏi:** "${transcribedText.trim().slice(0, 100)}"\n\n**Trả lời:**\n${truncateForDiscord(ragResult.answer || 'Không tìm thấy câu trả lời.')}`,
              allowedMentions: { parse: [] },
            });
          } catch (ragErr) {
            await answerMsg.edit({
              content: `🎤 Transcribe OK, nhưng RAG lỗi: ${ragErr?.message || ragErr}`,
              allowedMentions: { parse: [] },
            });
          }
        }
      } catch (err) {
        await waitingMsg.edit({
          content: `❌ Voice Agent lỗi: ${err?.message || err}`,
          allowedMentions: { parse: [] },
        });
      }
      return;
    }

    // ── !plan command: Vision-First DAG Planning ──
    if (message.content.startsWith('!plan')) {
      const hasImage = message.attachments.some(att => att.contentType?.startsWith('image/'));
      const userRequest = message.content.replace(/^!plan\s*/i, '').trim();

      if (!hasImage) {
        return message.reply({
          content: '🧠 **PlannerAgent** — Lập kế hoạch từ ảnh\n\n' +
            '**Cách dùng:** Gửi ảnh đính kèm cùng lệnh `!plan <yêu cầu>`\n' +
            '**Ví dụ:** `!plan Fix lỗi trong ảnh này` (kèm ảnh chụp màn hình)\n' +
            '**Ví dụ:** `!plan Giải thích thuật toán trong sơ đồ` (kèm ảnh sơ đồ)\n\n' +
            'Workflow: VisionAgent phân tích ảnh → PlannerAgent tạo DAG → Thực thi tự động.',
          allowedMentions: { parse: [], repliedUser: false },
        });
      }

      const waitingMsg = await message.reply({
        content: '🧠 **PlannerAgent** đang phân tích ảnh và lập kế hoạch...\n⏳ Bước 1/3: VisionAgent đọc ảnh...',
        allowedMentions: { parse: [], repliedUser: false },
      });

      try {
        // 1. Download image
        const { downloadImageToBuffer } = await import('./agents/VisionAgent.js');
        const imageAttachment = message.attachments.find(att => att.contentType?.startsWith('image/'));
        const { buffer, mimeType } = await downloadImageToBuffer(imageAttachment.url);

        await waitingMsg.edit({
          content: '🧠 **PlannerAgent** đang lập kế hoạch...\n✅ Bước 1/3: VisionAgent đọc ảnh xong\n⏳ Bước 2/3: PlannerAgent tạo DAG...',
          allowedMentions: { parse: [], repliedUser: false },
        });

        // 2. Vision-first planning
        const PlannerAgent = (await import('./agents/PlannerAgent.js')).default;
        const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
        const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL_NAME || 'openrouter/auto';

        const { dag, visionDescription, visionResult } = await PlannerAgent.createVisionFirstPlan({
          apiKey: OPENROUTER_API_KEY,
          model: OPENROUTER_MODEL,
          imageBuffer: buffer,
          mimeType,
          userRequest: userRequest || 'Phân tích và xử lý nội dung trong ảnh',
        });

        await waitingMsg.edit({
          content: '🧠 **PlannerAgent** đang lập kế hoạch...\n✅ Bước 1/3: VisionAgent đọc ảnh xong\n✅ Bước 2/3: PlannerAgent tạo DAG xong\n⏳ Bước 3/3: Thực thi DAG...',
          allowedMentions: { parse: [], repliedUser: false },
        });

        // 3. Execute DAG sync (inject agent modules)
        const agentModules = {};
        try { agentModules.RagAgent = await import('./agents/RagAgent.js'); } catch { /* skip */ }
        try { agentModules.CoderAgent = await import('./agents/CoderAgent.js'); } catch { /* skip */ }
        try { agentModules.VisionAgent = await import('./agents/VisionAgent.js'); } catch { /* skip */ }
        try { agentModules.PdfAgent = await import('./agents/PdfAgent.js'); } catch { /* skip */ }
        try { agentModules.DebateAgent = await import('./agents/DebateAgent.js'); } catch { /* skip */ }
        try { agentModules.ManimAgent = await import('./agents/ManimAgent.js'); } catch { /* skip */ }

        const planner = new PlannerAgent({
          apiKey: OPENROUTER_API_KEY,
          model: OPENROUTER_MODEL,
          agentModules,
        });

        const result = await planner.executeDagSync({
          type: 'vision_planner_request',
          content: userRequest || visionDescription,
          context: visionDescription,
        });

        // 4. Format output
        let output = '🧠 **PlannerAgent — Kết quả Vision-First Planning:**\n\n';
        output += `👁️ **Vision Agent** đã phân tích:\n> ${visionDescription.slice(0, 300)}${visionDescription.length > 300 ? '...' : ''}\n\n`;
        output += `📋 **DAG Plan** (${result.totalSteps} bước):\n`;
        for (const task of result.dag) {
          const status = result.results[task.step]?.failed ? '❌' : (result.results[task.step] ? '✅' : '⏳');
          const dep = task.depends_on ? ` (chờ bước ${task.depends_on})` : '';
          output += `${status} **Bước ${task.step}:** ${task.agent} → ${task.action}${dep}\n`;
        }
        output += '\n';

        // Add results
        for (const [step, stepResult] of Object.entries(result.results)) {
          if (stepResult?.error || stepResult?.failed) {
            output += `❌ **Bước ${step} lỗi:** ${stepResult.error || 'Unknown error'}\n`;
          } else if (stepResult) {
            const text = typeof stepResult === 'string' ? stepResult : (stepResult.answer || stepResult.description || JSON.stringify(stepResult));
            output += `✅ **Bước ${step}:**\n${String(text).slice(0, 500)}${String(text).length > 500 ? '...' : ''}\n\n`;
          }
        }

        await waitingMsg.edit({
          content: truncateForDiscord(output),
          allowedMentions: { parse: [], repliedUser: false },
        });
      } catch (err) {
        await waitingMsg.edit({
          content: `❌ PlannerAgent lỗi: ${err?.message || err}`,
          allowedMentions: { parse: [], repliedUser: false },
        });
      }
      return;
    }

    // ── !animate command: Manim Video Generation (Async + Compression) ──
    if (message.content.startsWith('!animate ')) {
      const description = message.content.slice(9).trim();
      if (!description) {
        return message.reply({
          content: 'Vui long gui mo ta animation. Vi du: `!animate Giai thuat thuat toan QuickSort`',
          allowedMentions: { parse: [], repliedUser: false },
        });
      }

      // Check for --async flag
      const isAsync = description.includes('--async');
      const cleanDescription = description.replace(/\s*--async\s*/g, '').trim();

      const waitingMsg = await message.reply({
        content: '🎬 **Đang tạo animation...**\n⏳ Bước 1/3: AI viết code Manim...',
        allowedMentions: { parse: [], repliedUser: false },
      });

      try {
        if (isAsync) {
          // Async mode: start render in background, notify when done
          const { jobId, promise } = createAnimationAsync(cleanDescription);

          await waitingMsg.edit({
            content: `🎬 **Animation đang được render!**\n🆔 Job: \`${jobId}\n⏳ Bạn sẽ nhận được video khi render xong (1-3 phút).`,
            allowedMentions: { parse: [] },
          });

          // Render in background
          const result = await promise;

          if (!result.success) {
            await message.reply({
              content: `❌ **Animation thất bại** (Job: \`${jobId}\`)\n${result.error?.slice(0, 500) || 'Unknown error'}`,
              allowedMentions: { parse: [], repliedUser: false },
            });
            return;
          }

          // Send video
          const sizeMB = result.sizeMB || 0;
          if (sizeMB > 25) {
            await message.reply({
              content: `✅ **Animation hoàn thành!** (Job: \`${jobId}\`)\n⚠️ Video quá lớn (${sizeMB.toFixed(1)}MB > 25MB). Thêm --compress để nén tự động.`,
              allowedMentions: { parse: [], repliedUser: false },
            });
          } else {
            await message.reply({
              content: `✅ **Animation hoàn thành!** (Job: \`${jobId}\`)`,
              files: [result.videoPath],
              allowedMentions: { parse: [], repliedUser: false },
            });
          }
        } else {
          // Sync mode with compression
          const result = await createAnimationWithCompression(cleanDescription);

          if (!result.success) {
            await waitingMsg.edit({
              content: `❌ Lỗi khi tạo animation: ${result.error?.slice(0, 500) || 'Unknown error'}`,
              allowedMentions: { parse: [] },
            });
            return;
          }

          const sizeMB = result.sizeMB || 0;
          let statusMsg = `✅ **Animation hoàn thành!** (${sizeMB.toFixed(1)}MB)`;
          if (result.compressed) {
            statusMsg += ' 📦 Đã nén tự động';
          }

          await waitingMsg.edit({
            content: statusMsg,
            files: [result.videoPath],
            allowedMentions: { parse: [] },
          });
        }
      } catch (err) {
        await waitingMsg.edit({
          content: `❌ Lỗi animation: ${err?.message || err}`,
          allowedMentions: { parse: [] },
        });
      }
      return;
    }

    // ── !debate command: Multi-Agent Debate with Sandbox Metrics ──
    if (message.content.startsWith('!debate ')) {
      const query = message.content.slice(8).trim();
      if (!query) {
        return message.reply({
          content: '🏛️ **Debate Agent** — Tranh luận đa tác nhân\n\n' +
            '**Cách dùng:** `!debate <bài toán>`\n' +
            '**Nâng cao:** `!debate <bài toán> --quick` (1 vòng, không sandbox)\n\n' +
            '**Cơ chế:**\n' +
            '1. Coder A giải theo hướng đúng đắn, dễ đọc\n' +
            '2. Coder B giải theo hướng hiệu suất, tối ưu\n' +
            '3. Sandbox chạy cả 2 → đo latency + memory\n' +
            '4. RagAgent phản biện dựa trên metrics\n' +
            '5. JudgeAgent chấm điểm và chọn người thắng',
          allowedMentions: { parse: [], repliedUser: false },
        });
      }

      const isQuick = query.includes('--quick');
      const cleanQuery = query.replace(/\s*--quick\s*/g, '').trim();

      const waitingMsg = await message.reply({
        content: `🏛️ **Debate Agent** đang bắt đầu tranh luận...\n` +
          `📝 Bài toán: "${cleanQuery.slice(0, 80)}"\n` +
          `⚡ Mode: ${isQuick ? 'Quick (1 vòng)' : 'Full (3 vòng + sandbox)'}\n` +
          `⏳ Vui lòng chờ 1-3 phút...`,
        allowedMentions: { parse: [], repliedUser: false },
      });

      try {
        const result = isQuick
          ? await quickDebate(cleanQuery)
          : await runDebate(cleanQuery);

        // Format summary metrics
        const s = result.summary;
        const metricsTable =
          `📊 **Metrics từ Sandbox:**\n` +
          `| | Coder A (Đúng đắn) | Coder B (Hiệu suất) |\n` +
          `|---|---|---|\n` +
          `| Latency | ${s.coderA.avgLatencyMs}ms | ${s.coderB.avgLatencyMs}ms |\n` +
          `| Memory | ${s.coderA.avgMemoryKb}KB | ${s.coderB.avgMemoryKb}KB |\n` +
          `| Success | ${s.coderA.successRate} | ${s.coderB.successRate} |\n\n`;

        const output = `🏛️ **Debate Agent — Kết quán** (${s.totalTimeMs}ms)\n\n` +
          metricsTable +
          `⚖️ **Phán quyết của Toà Án:**\n\n` +
          result.finalSolution.slice(0, 1500);

        await waitingMsg.edit({
          content: truncateForDiscord(output),
          allowedMentions: { parse: [] },
        });
      } catch (err) {
        await waitingMsg.edit({
          content: `❌ Debate Agent lỗi: ${err?.message || err}`,
          allowedMentions: { parse: [] },
        });
      }
      return;
    }

    // ── !analyze command: Code Quality Analysis ──
    if (message.content.startsWith('!analyze ')) {
      const code = message.content.slice(9).trim();
      if (!code) {
        return message.reply({
          content: '🔍 **Code Analyzer** — Phân tích chất lượng code\n\n' +
            '**Cách dùng:** `!analyze <code>` hoặc `!analyze` + paste code\n' +
            '**Ví dụ:** `!analyze function foo() { return 1; }`\n\n' +
            '**Phân tích:**\n' +
            '1. Cyclomatic complexity\n' +
            '2. Anti-patterns detection\n' +
            '3. Quality score (0-100)\n' +
            '4. Improvement suggestions',
          allowedMentions: { parse: [], repliedUser: false },
        });
      }

      const langMatch = code.match(/^```(\w+)?\n([\s\S]*?)```$/);
      const lang = langMatch ? (langMatch[1] || 'javascript') : 'javascript';
      const cleanCode = langMatch ? langMatch[2].trim() : code;

      const waitingMsg = await message.reply({
        content: '🔍 **Code Analyzer** đang phân tích...',
        allowedMentions: { parse: [], repliedUser: false },
      });

      try {
        const { getQualityReport } = await import('./lib/code_analyzer.js');
        const report = getQualityReport(cleanCode, lang);

        const issuesList = report.antiPatterns.slice(0, 5).map(ap =>
          `• [${ap.severity.toUpperCase()}] ${ap.name}: ${ap.message.slice(0, 80)}`
        ).join('\n');

        const output = `🔍 **Code Analysis Report**\n\n` +
          `📊 **Score:** ${report.score}/100 (Grade ${report.grade})\n` +
          `📈 **Complexity:** ${report.complexity.cyclomatic} (Grade ${report.complexity.rating})\n` +
          `📏 **Lines:** ${report.complexity.linesOfCode} | **Comments:** ${report.complexity.commentRatio}%\n` +
          `🔧 **Nesting Depth:** ${report.complexity.maxNestingDepth}\n\n` +
          `⚠️ **Issues (${report.antiPatterns.length}):**\n${issuesList || '✅ No issues found'}\n\n` +
          `💡 **Recommendations:**\n${report.recommendations.slice(0, 3).map(r => `• ${r}`).join('\n')}`;

        await waitingMsg.edit({
          content: truncateForDiscord(output),
          allowedMentions: { parse: [] },
        });
      } catch (err) {
        await waitingMsg.edit({
          content: `❌ Analyzer lỗi: ${err?.message || err}`,
          allowedMentions: { parse: [] },
        });
      }
      return;
    }

    // ── !audit command: Security Audit ──
    if (message.content.startsWith('!audit ')) {
      const code = message.content.slice(7).trim();
      if (!code) {
        return message.reply({
          content: '🔒 **Security Auditor** — Quét bảo mật code\n\n' +
            '**Cách dùng:** `!audit <code>`\n' +
            '**Ví dụ:** `!audit const password = "abc123"`\n\n' +
            '**Quét:**\n' +
            '1. Hardcoded secrets/credentials\n' +
            '2. SQL injection, XSS, Command injection\n' +
            '3. Weak crypto, SSL bypass\n' +
            '4. Path traversal, SSRF\n' +
            '5. Security score (0-100)',
          allowedMentions: { parse: [], repliedUser: false },
        });
      }

      const langMatch = code.match(/^```(\w+)?\n([\s\S]*?)```$/);
      const lang = langMatch ? (langMatch[1] || 'javascript') : 'javascript';
      const cleanCode = langMatch ? langMatch[2].trim() : code;

      const waitingMsg = await message.reply({
        content: '🔒 **Security Auditor** đang quét...',
        allowedMentions: { parse: [], repliedUser: false },
      });

      try {
        const { auditCode } = await import('./lib/security_auditor.js');
        const report = await auditCode(cleanCode, lang, { useLlm: false });

        const vulnsList = report.vulnerabilities.slice(0, 5).map(v =>
          `• [${v.severity.toUpperCase()}] ${v.type} (line ${v.line}): ${v.message.slice(0, 80)}`
        ).join('\n');

        const secretsList = report.secrets.slice(0, 3).map(s =>
          `• [${s.severity.toUpperCase()}] ${s.type} (line ${s.line}): ${s.match}`
        ).join('\n');

        const output = `🔒 **Security Audit Report**\n\n` +
          `🛡️ **Score:** ${report.score}/100 | **Risk:** ${report.riskLevel.toUpperCase()}\n\n` +
          `🔑 **Secrets (${report.secrets.length}):**\n${secretsList || '✅ None found'}\n\n` +
          `🐛 **Vulnerabilities (${report.vulnerabilities.length}):**\n${vulnsList || '✅ None found'}`;

        await waitingMsg.edit({
          content: truncateForDiscord(output),
          allowedMentions: { parse: [] },
        });
      } catch (err) {
        await waitingMsg.edit({
          content: `❌ Audit lỗi: ${err?.message || err}`,
          allowedMentions: { parse: [] },
        });
      }
      return;
    }

    // ── !perf command: Performance Profiling ──
    if (message.content.startsWith('!perf ')) {
      const code = message.content.slice(6).trim();
      if (!code) {
        return message.reply({
          content: '⚡ **Performance Profiler** — Phân tích performance\n\n' +
            '**Cách dùng:** `!perf <code>`\n' +
            '**Ví dụ:** `!perf for(let i=0;i<arr.length;i++) arr[i]++`\n\n' +
            '**Phân tích:**\n' +
            '1. Performance anti-patterns\n' +
            '2. Loop optimization\n' +
            '3. Memory usage tips\n' +
            '4. System metrics',
          allowedMentions: { parse: [], repliedUser: false },
        });
      }

      const langMatch = code.match(/^```(\w+)?\n([\s\S]*?)```$/);
      const lang = langMatch ? (langMatch[1] || 'javascript') : 'javascript';
      const cleanCode = langMatch ? langMatch[2].trim() : code;

      const waitingMsg = await message.reply({
        content: '⚡ **Performance Profiler** đang phân tích...',
        allowedMentions: { parse: [], repliedUser: false },
      });

      try {
        const { analyzePerformance, getSystemMetrics } = await import('./lib/performance_profiler.js');
        const perf = analyzePerformance(cleanCode, lang);
        const sys = getSystemMetrics();

        const issuesList = perf.issues.slice(0, 5).map(i =>
          `• [${i.severity}] ${i.type}: ${i.message.slice(0, 80)}`
        ).join('\n');

        const output = `⚡ **Performance Report**\n\n` +
          `🔧 **Issues (${perf.issues.length}):**\n${issuesList || '✅ No issues'}\n\n` +
          `💡 **Recommendations:**\n${perf.recommendations.slice(0, 3).map(r => `• ${r}`).join('\n')}\n\n` +
          `🖥️ **System:** CPU ${sys.cpu.usage}% | RAM ${sys.memory.usage}% | ${sys.cpu.cores} cores`;

        await waitingMsg.edit({
          content: truncateForDiscord(output),
          allowedMentions: { parse: [] },
        });
      } catch (err) {
        await waitingMsg.edit({
          content: `❌ Profile lỗi: ${err?.message || err}`,
          allowedMentions: { parse: [] },
        });
      }
      return;
    }

    // ── !logs command: Log Analysis ──
    if (message.content.startsWith('!logs ')) {
      const logText = message.content.slice(6).trim();
      if (!logText) {
        return message.reply({
          content: '📋 **Log Analyzer** — Phân tích logs\n\n' +
            '**Cách dùng:** `!logs <log text>`\n' +
            '**Ví dụ:** `!logs ERROR: connection failed at 2024-01-01`\n\n' +
            '**Phân tích:**\n' +
            '1. Error clustering\n' +
            '2. Anomaly detection\n' +
            '3. Health score\n' +
            '4. Error trends',
          allowedMentions: { parse: [], repliedUser: false },
        });
      }

      const waitingMsg = await message.reply({
        content: '📋 **Log Analyzer** đang phân tích...',
        allowedMentions: { parse: [], repliedUser: false },
      });

      try {
        const { analyzeLog } = await import('./lib/log_analyzer.js');
        const analysis = analyzeLog(logText);

        const topErrors = analysis.topErrors.slice(0, 3).map(e =>
          `• (${e.count}x) ${e.pattern.slice(0, 80)}`
        ).join('\n');

        const anomalies = analysis.anomalies.slice(0, 3).map(a =>
          `• [${a.severity}] ${a.message.slice(0, 80)}`
        ).join('\n');

        const output = `📋 **Log Analysis Report**\n\n` +
          `📊 **Health:** ${analysis.healthScore}/100 (${analysis.rating})\n` +
          `📈 **Lines:** ${analysis.totalLines} | **Errors:** ${analysis.errorCount} | **Warnings:** ${analysis.warningCount}\n` +
          `📊 **Levels:** ${Object.entries(analysis.levelCounts).map(([k, v]) => `${k}: ${v}`).join(', ')}\n\n` +
          `🔴 **Top Errors:**\n${topErrors || '✅ None'}\n\n` +
          `⚠️ **Anomalies:**\n${anomalies || '✅ None'}`;

        await waitingMsg.edit({
          content: truncateForDiscord(output),
          allowedMentions: { parse: [] },
        });
      } catch (err) {
        await waitingMsg.edit({
          content: `❌ Log analysis lỗi: ${err?.message || err}`,
          allowedMentions: { parse: [] },
        });
      }
      return;
    }

    // ── !run command: Code Execution Sandbox (via SandboxGateway) ──
    if (message.content.startsWith('!run ')) {
      const code = message.content.slice(5).trim();
      if (!code) {
        return message.reply({
          content: 'Vui long gui code sau lenh `!run`. Vi du: `!run print("hello")`',
          allowedMentions: { parse: [], repliedUser: false },
        });
      }

      const langMatch = code.match(/^```(\w+)?\n([\s\S]*?)```$/);
      const lang = langMatch ? (langMatch[1] || null) : null;
      const cleanCode = langMatch ? langMatch[2].trim() : code;

      const waitingMsg = await message.reply({
        content: '⚡ Dang chay code...',
        allowedMentions: { parse: [], repliedUser: false },
      });

      try {
        // Use SandboxGateway with timeout — prevents silent hangs
        const result = await withTimeout(
          sandboxGateway.execute({
            agent: 'discord_message',
            code: cleanCode,
            language: lang || undefined,
          }),
          60_000,
          'Discord !run sandbox execution'
        );

        let output = '';
        if (result.blocked) {
          output = `🚫 **Code bị chặn bởi Sandbox!**\n${result.error || 'Lý do không xác định'}`;
        } else if (result.success) {
          output = `✅ **Code chạy thành công!** (method: ${result.method}, trust: ${result.trustLevel})\n\`\`\`\n${result.output || '(khong co output)'}\n\`\`\``;
        } else {
          output = `❌ **Code lỗi!** (method: ${result.method})\n${result.error ? `\`\`\`\n${result.error.slice(0, 800)}\n\`\`\`` : ''}`;
        }
        if (result.timedOut) output += '\n⏰ Code bị timeout';
        await waitingMsg.edit({ content: truncateForDiscord(output), allowedMentions: { parse: [] } });
      } catch (err) {
        const errMsg = err instanceof TimeoutError
          ? `⏰ **Timeout!** Code chạy quá lâu (>60s). Kiểm tra vòng lặp vô hạn.`
          : `❌ Lỗi sandbox: ${err?.message || err}`;
        await waitingMsg.edit({
          content: errMsg,
          allowedMentions: { parse: [] },
        });
      }
      return;
    }

    // ── !quiz command: Spaced Repetition Flashcards ──
    if (message.content.startsWith('!quiz')) {
      const { getDueFlashcards, getRandomFlashcards, reviewFlashcard, getStats } = await import('./lib/flashcard_db.js');
      
      const args = message.content.slice(5).trim().split(/\s+/);
      const subCommand = args[0] || 'start';
      const category = args[1] || null;

      try {
        if (subCommand === 'stats') {
          const stats = await getStats();
          return message.reply({
            content: `📊 **Thong ke flashcards:**\n- Tong so: ${stats.total || 0}\n- Den ngay: ${stats.due || 0}\n- Dung tan: ${stats.total_correct || 0}/${stats.total_reviews || 0}`,
            allowedMentions: { parse: [], repliedUser: false },
          });
        }

        if (subCommand === 'review') {
          const dueCards = await getDueFlashcards(10);
          if (dueCards.length === 0) {
            return message.reply({
              content: '🎉 Khong co thu cong nao den! Flu derby roi nhe ^_^',
              allowedMentions: { parse: [], repliedUser: false },
            });
          }
          
          const card = dueCards[0];
          const reviewContent = `❓ **Thu cong #${card.id}:** ${card.question}\n\n*(Nhap !answer ${card.id} <dapan> de tra loi)*`;
          const quizMsg = await message.reply({
            content: reviewContent,
            allowedMentions: { parse: [], repliedUser: false },
          });
          return;
        }

        // Start quiz with random cards
        const cards = category 
          ? await getRandomFlashcards(5, category)
          : await getRandomFlashcards(5);
        
        if (cards.length === 0) {
          return message.reply({
            content: 'Chua co flashcard nao. Su dung !learn <pdf-url> hoac !ask <cau hoi> de tao thu cong.',
            allowedMentions: { parse: [], repliedUser: false },
          });
        }

        const quizContent = cards.map((c, i) => `**${i + 1}.** ${c.question}`).join('\n');
        const quizFooter = '*(Su dung !answer <id> <dapan> de tra loi tung cau)*';
        return message.reply({
          content: `📚 **Khoa hoc lai - ${cards.length} cau hoi:**\n\n${quizContent}\n\n${quizFooter}`,
          allowedMentions: { parse: [], repliedUser: false },
        });
      } catch (err) {
        console.error('Quiz error:', err.message);
        return message.reply({
          content: `Loi khi bat dau khoa hoc lai: ${err.message}`,
          allowedMentions: { parse: [], repliedUser: false },
        });
      }
    }

    // ── !preferences command: Set user learning preferences ──
    if (message.content.startsWith('!preferences')) {
      const { setUserPreference, getUserPreference } = await import('./lib/cross_model_learner.js');
      const args = message.content.slice(12).trim().split(/\s+/);
      const subCommand = args[0] || 'show';
      const userId = message.author.id;

      if (subCommand === 'show') {
        const prefs = getUserPreference(userId);
        return message.reply({
          content: `⚙️ **Tuỳ chọn của bạn:**\n` +
            `- Model ưu tiên: **${prefs.preferredModel}**\n` +
            `- Sources ưu tiên: **${(prefs.preferredSources || []).join(', ') || 'không có'}**\n` +
            `- Tự học: **${prefs.learningEnabled ? 'BẬT' : 'TẮT'}**\n\n` +
            `**Cách dùng:**\n` +
            `\`!preferences model openrouter|gemini|auto\`\n` +
            `\`!preferences sources youtube,github,stackoverflow\`\n` +
            `\`!preferences learning on|off\``,
          allowedMentions: { parse: [], repliedUser: false },
        });
      }

      if (subCommand === 'model') {
        const model = args[1];
        if (!['openrouter', 'gemini', 'auto'].includes(model)) {
          return message.reply({ content: '❌ Model phải là: openrouter, gemini, hoặc auto', allowedMentions: { parse: [], repliedUser: false } });
        }
        setUserPreference(userId, { preferredModel: model });
        return message.reply({ content: `✅ Đã set model ưu tiên: **${model}**`, allowedMentions: { parse: [], repliedUser: false } });
      }

      if (subCommand === 'sources') {
        const sources = args.slice(1).join(' ').split(',').map(s => s.trim()).filter(Boolean);
        if (sources.length === 0) {
          return message.reply({ content: '❌ Ví dụ: `!preferences sources youtube,github`', allowedMentions: { parse: [], repliedUser: false } });
        }
        setUserPreference(userId, { preferredSources: sources });
        return message.reply({ content: `✅ Đã set sources ưu tiên: **${sources.join(', ')}**`, allowedMentions: { parse: [], repliedUser: false } });
      }

      if (subCommand === 'learning') {
        const enabled = args[1] === 'on';
        setUserPreference(userId, { learningEnabled: enabled });
        return message.reply({ content: `✅ Đã ${enabled ? 'BẬT' : 'TẮT'} chế độ tự học`, allowedMentions: { parse: [], repliedUser: false } });
      }

      return message.reply({
        content: '❌ Lệnh không hợp lệ. Dùng: `!preferences show|model|sources|learning`',
        allowedMentions: { parse: [], repliedUser: false },
      });
    }

    // ── !answer command: Review flashcard ──
    if (message.content.startsWith('!answer ')) {
      const { reviewFlashcard } = await import('./lib/flashcard_db.js');
      const args = message.content.slice(8).trim().split(/\s+/);
      const cardId = parseInt(args[0], 10);
      const userAnswer = args.slice(1).join(' ').trim();

      if (!cardId || !userAnswer) {
        return message.reply({
          content: 'Cu phap: !answer <id> <dapan>',
          allowedMentions: { parse: [], repliedUser: false },
        });
      }

      try {
        const result = await reviewFlashcard(cardId, userAnswer.toLowerCase().includes('dung') || userAnswer.toLowerCase().includes('correct'));
        if (!result) {
          return message.reply({ content: 'Khong tim thay thu cong!', allowedMentions: { parse: [], repliedUser: false } });
        }
        return message.reply({
          content: `✅ Da ghi nhan: Card #${cardId} - ${result.correctCount}/${result.reviewCount} lan dung`,
          allowedMentions: { parse: [], repliedUser: false },
        });
      } catch (err) {
        return message.reply({
          content: `Loi: ${err.message}`,
          allowedMentions: { parse: [], repliedUser: false },
        });
      }
    }

    // ── !learn command: Process URL for flashcards ──
    if (message.content.startsWith('!learn ')) {
      const url = message.content.slice(7).trim();
      if (!url) {
        return message.reply({
          content: 'Cu phap: !learn <url> hoac drag PDF vao thu muc library/incoming',
          allowedMentions: { parse: [], repliedUser: false },
        });
      }

      const waitingMsg = await message.reply({
        content: `📥 Đang xử lý tài liệu từ: ${url}\n(Vui lòng chờ trong giây lát...)`,
        allowedMentions: { parse: [], repliedUser: false },
      });

      try {
        // Gọi orchestrator để xử lý repo URL
        const result = await orchestrator.route({ type: 'repo_url', url });
        if (result?.error) {
          await waitingMsg.edit({
            content: `❌ Lỗi khi xử lý: ${result.error}`,
            allowedMentions: { parse: [] },
          });
        } else {
          await waitingMsg.edit({
            content: `✅ Đã xử lý xong!\n${result.message || 'Tài liệu đã được nạp vào hệ thống.'}`,
            allowedMentions: { parse: [] },
          });
        }
      } catch (err) {
        await waitingMsg.edit({
          content: `❌ Lỗi: ${err?.message || err}`,
          allowedMentions: { parse: [] },
        });
      }
      return;
    }

    // ── !schedule command: Sync thời khóa biểu / syllabus ──
    if (message.content.startsWith('!schedule')) {
      const args = message.content.slice(9).trim().split(/\s+/);
      const subCommand = args[0] || 'help';

      if (subCommand === 'help' || !subCommand) {
        return message.reply({
          content: `📅 **Schedule Sync** — Đồng bộ thời khóa biểu\n\n` +
            `**Cách dùng:**\n` +
            `\`!schedule upload\` + đính kèm file CSV/JSON/ics\n` +
            `\`!schedule url <link>\` — Sync từ Google Calendar iCal URL\n` +
            `\`!schedule list\` — Xem các môn đã sync\n` +
            `\`!schedule clear\` — Xóa tất cả schedule flashcards\n\n` +
            `**CSV format:** course, topic, date, time, type, description\n` +
            `**Types:** lecture, exam, assignment`,
          allowedMentions: { parse: [], repliedUser: false },
        });
      }

      // ── !schedule upload: Xử lý file đính kèm ──
      if (subCommand === 'upload' || message.attachments.size > 0) {
        const file = message.attachments.first();
        if (!file) {
          return message.reply({
            content: '❌ Vui lòng đính kèm file .ics, .csv, hoặc .json cùng lệnh `!schedule upload`.',
            allowedMentions: { parse: [], repliedUser: false },
          });
        }

        // Kiểm tra đuôi file
        const fileName = file.name.toLowerCase();
        const allowedExts = ['.ics', '.csv', '.json'];
        const hasValidExt = allowedExts.some(ext => fileName.endsWith(ext));
        if (!hasValidExt) {
          return message.reply({
            content: `❌ Định dạng file không hợp lệ: \`${file.name}\`\n` +
              `**Hỗ trợ:** .ics (iCalendar), .csv, .json\n` +
              `**Ví dụ:** \`!schedule upload\` + đính kèm file .ics`,
            allowedMentions: { parse: [], repliedUser: false },
          });
        }

        const waitingMsg = await message.reply({
          content: `📅 Đang xử lý file **${file.name}**... (có thể mất 15-30s)`,
          allowedMentions: { parse: [], repliedUser: false },
        });

        try {
          const fileUrl = file.url || file.proxyURL;
          if (!fileUrl || (!fileUrl.startsWith('http://') && !fileUrl.startsWith('https://'))) {
            throw new Error(`URL file không hợp lệ: ${fileUrl || 'undefined'}`);
          }
          const { syncSchedule } = await import('./lib/schedule_sync.js');
          const result = await syncSchedule(fileUrl, { fileName: file.name });

          let output = `✅ **Upload thành công!**\n`;
          output += `📄 File: \`${file.name}\`\n`;
          output += `📊 Đọc được: ${result.entries.length} mục\n`;
          output += `📝 Tạo flashcard: ${result.flashcards.length} thẻ\n`;

          if (result.flashcards.length > 0) {
            const byType = {};
            for (const fc of result.flashcards) {
              byType[fc.type] = (byType[fc.type] || 0) + 1;
            }
            output += `\n**Chi tiết:**\n`;
            for (const [type, count] of Object.entries(byType)) {
              output += `  • ${type}: ${count} thẻ\n`;
            }
            output += `\n💡 Dùng \`!quiz\` để ôn tập hoặc \`!quiz category exam\` cho bài thi.`;
          }

          await waitingMsg.edit({
            content: truncateForDiscord(output),
            allowedMentions: { parse: [] },
          });
        } catch (err) {
          await waitingMsg.edit({
            content: `❌ Lỗi xử lý file: ${err?.message || err}`,
            allowedMentions: { parse: [] },
          });
        }
        return;
      }

      if (subCommand === 'url') {
        const url = args[1];
        if (!url) {
          return message.reply({
            content: '❌ Vui lòng cung cấp URL. Ví dụ: `!schedule url https://calendar.google.com/calendar/ical/xxx.ics`',
            allowedMentions: { parse: [], repliedUser: false },
          });
        }

        const waitingMsg = await message.reply({
          content: '📅 Đang sync từ URL... (có thể mất 30-60s)',
          allowedMentions: { parse: [], repliedUser: false },
        });

        try {
          const { syncSchedule } = await import('./lib/schedule_sync.js');
          const result = await syncSchedule(url);

          let output = `✅ **Sync thành công!**\n`;
          output += `📊 Đọc được: ${result.entries.length} mục\n`;
          output += `📝 Tạo flashcard: ${result.flashcards.length} thẻ\n`;

          if (result.flashcards.length > 0) {
            const byType = {};
            for (const fc of result.flashcards) {
              byType[fc.type] = (byType[fc.type] || 0) + 1;
            }
            output += `\n**Chi tiết:**\n`;
            for (const [type, count] of Object.entries(byType)) {
              output += `  • ${type}: ${count} thẻ\n`;
            }
            output += `\n💡 Dùng \`!quiz\` để ôn tập hoặc \`!quiz category exam\` cho bài thi.`;
          }

          await waitingMsg.edit({
            content: truncateForDiscord(output),
            allowedMentions: { parse: [] },
          });
        } catch (err) {
          await waitingMsg.edit({
            content: `❌ Lỗi sync: ${err?.message || err}`,
            allowedMentions: { parse: [] },
          });
        }
        return;
      }

      if (subCommand === 'list') {
        const { getRandomFlashcards } = await import('./lib/flashcard_db.js');
        const cards = await getRandomFlashcards(20, null);
        const scheduleCards = cards.filter(c => c.source === 'schedule-sync');

        if (scheduleCards.length === 0) {
          return message.reply({
            content: '📅 Chưa có schedule nào được sync. Dùng `!schedule url <link>` hoặc upload file CSV.',
            allowedMentions: { parse: [], repliedUser: false },
          });
        }

        const lines = scheduleCards.slice(0, 10).map(c =>
          `• **#${c.id}** [${c.category}] ${c.question.slice(0, 60)}`
        );
        return message.reply({
          content: `📅 **Schedule Flashcards (${scheduleCards.length}):**\n\n${lines.join('\n')}${scheduleCards.length > 10 ? `\n... và ${scheduleCards.length - 10} thẻ khác` : ''}`,
          allowedMentions: { parse: [], repliedUser: false },
        });
      }

      if (subCommand === 'clear') {
        const { clearBySource } = await import('./lib/flashcard_db.js');
        const deleted = await clearBySource('schedule-sync');
        return message.reply({
          content: `🗑️ Đã xóa ${deleted} schedule flashcards.`,
          allowedMentions: { parse: [], repliedUser: false },
        });
      }

      return message.reply({
        content: '❌ Lệnh không hợp lệ. Dùng `!schedule help` để xem hướng dẫn.',
        allowedMentions: { parse: [], repliedUser: false },
      });
    }

    // ── !code command: CoderAgent — Viết + Chạy code ──
    if (message.content.startsWith('!code ')) {
      const problem = message.content.slice(6).trim();
      if (!problem) {
        return message.reply({
          content: 'Cú pháp: `!code <mô tả bài toán>`\nVí dụ: `!code Viết hàm tìm số Fibonacci thứ n bằng Python`',
          allowedMentions: { parse: [], repliedUser: false },
        });
      }

      const waitingMsg = await message.reply({
        content: '💻 CoderAgent đang viết code + chạy thử...',
        allowedMentions: { parse: [], repliedUser: false },
      });

      try {
        const result = await solveWithDebugLoop(problem, { runTests: true, maxRetries: 2 });

        const isSuccess = result.status === 'success';
        let output = `## 💻 CoderAgent Result\n\n`;
        output += `**Language:** ${result.language}${result.memorySanitizer ? ' (Memory Sanitizer ✅)' : ''}\n`;
        output += `**Status:** ${isSuccess ? '✅ SUCCESS' : '❌ FAILED'}\n`;
        output += `**Attempts:** ${result.attempts}\n`;

        if (result.bigO?.time) {
          output += `**Big O:** Time ${result.bigO.time} | Space ${result.bigO.space || 'N/A'}\n`;
        }

        output += `\n\`\`\`${result.language}\n${(result.code || '').slice(0, 1200)}${(result.code || '').length > 1200 ? '\n// ... [truncated]' : ''}\n\`\`\`\n`;

        if (isSuccess) {
          if (result.stdout) {
            output += `**Stdout:**\n\`\`\`\n${result.stdout.slice(0, 500)}\n\`\`\`\n`;
          }
        } else {
          // Thất bại — hiển thị stderr + dòng code gây lỗi
          if (result.summary) {
            output += `**Error:** ${result.summary}\n`;
          }
          if (result.errorLine) {
            output += `**Dòng lỗi:** ${result.errorLine}${result.errorLineText ? ` — "${result.errorLineText.slice(0, 80)}"` : ''}\n`;
          }
          if (result.stderr) {
            output += `**Stderr:**\n\`\`\`\n${result.stderr.slice(0, 400)}\n\`\`\`\n`;
          }
          // Debug history
          if (result.debugHistory?.length > 1) {
            output += `\n**Debug History:**\n`;
            for (const h of result.debugHistory) {
              output += `  Attempt ${h.attempt}: ${h.errorType} — ${h.summary.slice(0, 100)}\n`;
            }
          }
        }

        if (result.testResults?.length > 0) {
          output += `**Tests:** ${result.testResults.map((t, i) => `Test ${i + 1}: ${t.passed ? '✅' : '❌'}`).join(' | ')}\n`;
        }

        if (result.explanation) {
          output += `\n**Giải thích:** ${result.explanation.slice(0, 300)}`;
        }

        await waitingMsg.edit({
          content: truncateForDiscord(output),
          allowedMentions: { parse: [] },
        });
      } catch (err) {
        await waitingMsg.edit({
          content: `❌ CoderAgent error: ${err?.message || err}`,
          allowedMentions: { parse: [] },
        });
      }
      return;
    }

    // ── !path command: Learning Path Generator ──
    if (message.content.startsWith('!path ') || message.content.startsWith('!learn-path ')) {
      const prefixLen = message.content.startsWith('!path ') ? 6 : 12;
      const raw = message.content.slice(prefixLen).trim();
      if (!raw) {
        return message.reply({
          content: '📚 **Learning Path Generator**\n\n' +
            '**Cách dùng:** `!path <topic> [--short] [--gaps]`\n' +
            '**Ví dụ:** `!path distributed systems`\n' +
            '`!path algorithms --short` — chỉ 5 bước\n' +
            '`!path systems --gaps` — chỉ topic cần học\n\n' +
            'Tạo lộ trình học từ Knowledge Graph + Flashcard stats.',
          allowedMentions: { parse: [], repliedUser: false },
        });
      }

      const short = raw.includes('--short');
      const gapsOnly = raw.includes('--gaps');
      const topic = raw.replace(/--\w+/g, '').trim();

      const waitingMsg = await message.reply({
        content: `📚 Đang tạo lộ trình học cho **${topic}**...`,
        allowedMentions: { parse: [], repliedUser: false },
      });

      try {
        const { LearningPathGenerator } = await import('./lib/learning_path.js');
        const userId = message.author.id;
        const result = await LearningPathGenerator.generate(userId, topic, {
          maxDepth: short ? 3 : 6,
          maxNodes: short ? 8 : 20,
        });

        if (result.error) {
          await waitingMsg.edit({ content: `❌ ${result.error}`, allowedMentions: { parse: [] } });
          return;
        }

        const { embeds } = LearningPathGenerator.formatDiscord(result, { short, gapsOnly });
        await waitingMsg.edit({ content: '', embeds, allowedMentions: { parse: [] } });
      } catch (err) {
        await waitingMsg.edit({
          content: `❌ Lỗi tạo lộ trình: ${err?.message || err}`,
          allowedMentions: { parse: [] },
        });
      }
      return;
    }

    // ── !cli command: JIT CLI Tool Finder ──
    if (message.content.startsWith('!cli ')) {
      const query = message.content.slice(5).trim();
      if (!query) {
        return message.reply('🔧 **CLI Tool Finder**\n\nDùng: `!cli <tool>` — Tìm lệnh CLI\nVí dụ: `!cli docker`, `!cli nginx`, `!cli ssh`\n\nTìm lệnh chính xác từ the-book-of-secret-knowledge (0% hallucination).');
      }
      try {
        const { findCliTool } = await import('./agents/CoderAgent.js');
        const result = await findCliTool(query);
        await message.reply({ content: result.message, allowedMentions: { parse: [], repliedUser: false } });
      } catch (err) {
        await message.reply(`❌ Lỗi: ${err?.message || err}`);
      }
      return;
    }

    // ── !cs command: Virtual CS Curriculum ──
    if (message.content.startsWith('!cs ')) {
      const args = message.content.slice(4).trim();
      if (!args || args === 'list') {
        const { listCsSubjects } = await import('./agents/SocraticAgent.js');
        const subjects = await listCsSubjects();
        const lines = subjects.map(s => `• **${s.name}** (${s.topicCount} topics) — \`!cs ${s.id}\``);
        return message.reply('📚 **CS Curriculum** (TeachYourselfCS + ossu)\n\n' + lines.join('\n') + '\n\nDùng `!cs <subject>` để bắt đầu học.');
      }
      try {
        const { getCsSocraticPrompt } = await import('./agents/SocraticAgent.js');
        const result = await getCsSocraticPrompt(args);
        if (!result) {
          return message.reply(`❌ Không tìm thấy môn "${args}". Dùng \`!cs list\` để xem danh sách.`);
        }
        await message.reply({ content: result.prompt, allowedMentions: { parse: [], repliedUser: false } });
      } catch (err) {
        await message.reply(`❌ Lỗi: ${err?.message || err}`);
      }
      return;
    }

    // ── !gaps command: Weighted Gap Analysis ──
    if (message.content === '!gaps' || message.content === '!gap') {
      try {
        const { getTopGaps, generateGapAdvice } = await import('./lib/gap_router.js');
        const gaps = await getTopGaps(5);
        if (gaps.length === 0) {
          return message.reply('✅ **Không có lỗ hổng kiến thức nào!**\n\nBạn đang học rất đều. Tiếp tục ôn tập để giữ streak!');
        }
        const advice = await generateGapAdvice();
        const lines = gaps.map((g, i) => `${i + 1}. **${g.name}** — gap score: ${g.gap_score.toFixed(1)}`);
        await message.reply({
          content: `📊 **Lỗ hổng kiến thức:**\n\n${lines.join('\n')}\n\n${advice || ''}`,
          allowedMentions: { parse: [], repliedUser: false },
        });
      } catch (err) {
        await message.reply(`❌ Lỗi: ${err?.message || err}`);
      }
      return;
    }

    // ── !resources command: Free DevOps Resources ──
    if (message.content.startsWith('!resources ')) {
      const query = message.content.slice(11).trim();
      if (!query) {
        return message.reply('🆓 **Free DevOps Resources**\n\nDùng: `!resources <keyword>`\nVí dụ: `!resources hosting`, `!resources database`, `!resources auth`\n\nTìm free alternatives từ free-for-dev + open-source-alternatives.');
      }
      try {
        const { suggestFreeResources } = await import('./agents/PlannerAgent.js');
        const result = await suggestFreeResources(query);
        await message.reply({ content: result.message, allowedMentions: { parse: [], repliedUser: false } });
      } catch (err) {
        await message.reply(`❌ Lỗi: ${err?.message || err}`);
      }
      return;
    }

    // ── !recap command: Generate learning recap ──\n    if (message.content.startsWith('!recap ')) {\n      const topic = message.content.slice(7).trim();\n      if (!topic) {\n        return message.reply({ content: '📋 Dùng: !recap <topic> — Tạo tóm tắt bài học', allowedMentions: { parse: [], repliedUser: false } });\n      }\n      const waitingMsg = await message.reply({ content: 📚 Đang tạo recap cho ****..., allowedMentions: { parse: [], repliedUser: false } });\n      try {\n        const { RecapAgent } = await import('./agents/RecapAgent.js');\n        const recap = await RecapAgent.summarizeTopic(topic);\n        await waitingMsg.edit({ content: recap, allowedMentions: { parse: [] } });\n      } catch (err) {\n        await waitingMsg.edit({ content: ❌ Lỗi recap: , allowedMentions: { parse: [] } });\n      }\n      return;\n    }\n\n    // Parse query + flags (--deep, --source=xxx)
    const rawInput = message.content.slice(prefix.length).trim();
    if (!rawInput) {
      return message.reply({
        content: `Vui long gui cau hoi sau lenh ${prefix}, vi du: ${prefix}He thong RAG hoat dong the nao?`,
        allowedMentions: { parse: [], repliedUser: false },
      });
    }

    // Extract flags
    const isDeep = rawInput.includes('--deep');
    const sourceMatch = rawInput.match(/--source=(\S+)/);
    const preferredSources = sourceMatch ? sourceMatch[1].split(',') : [];
    const query = rawInput.replace(/\s*--deep\s*/g, '').replace(/\s*--source=\S+\s*/g, '').trim();

    // ── Socratic Auto-detect: nếu topic đã học → tự động Socratic ──
    // Chỉ khi KHÔNG có --deep flag (deep mode ưu tiên hơn)
    if (!isDeep) {
      const detectedTopic = await extractTopic(query);
      if (detectedTopic && SocraticAgent.shouldUseSocratic(message.author.id, detectedTopic)) {
        logger.info(`[Socratic] Auto-detected topic "${detectedTopic}" for user ${message.author.id}`);
        await startSocraticSession(message, detectedTopic, false, query);
        return;
      }
    }

    const waitingMsg = await message.reply({
      content: isDeep
        ? '🔍 **Deep Search** đang chạy... (tìm kiếm sâu qua nhiều nguồn)'
        : 'Dang xu ly cau hoi cua ban...',
      allowedMentions: { parse: [], repliedUser: false },
    });

    // Enqueue (Producer) — reject if queue is full
    if (requestQueue.length >= MAX_QUEUE_SIZE) {
      return waitingMsg.edit({
        content: '⚠️ Hệ thống đang quá tải. Vui lòng thử lại sau vài giây.',
        allowedMentions: { parse: [] },
      });
    }
    requestQueue.push({ query, waitingMsg, message, isDeep, preferredSources });

    // UX: show position in queue (1-based)
    const position = requestQueue.length;
    try {
      await waitingMsg.edit({
        content: `Dang xu ly cau hoi cua ban... (Vi tri trong hang doi: ${position})`,
        allowedMentions: { parse: [] },
      });
    } catch (_) {
      // ignore edit failures
    }

    // Start worker (Consumer)
    if (!isProcessingQueue) {
      isProcessingQueue = true;

      (async () => {
        while (requestQueue.length > 0) {
          const job = requestQueue.shift();
          try {
            let result;
            if (process.env.USE_MICROSERVICE === 'true') {
              try {
                const resp = await fetch('http://localhost:3000/api/ask', {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ query: job.query, options: {} }),
                });
                if (!resp.ok) {
                  throw new Error(`api_server responded ${resp.status}`);
                }
                const data = await resp.json();
                result = data?.ok ? data : { error: data?.error || 'api_server_error' };
              } catch (err) {
                console.warn('Microservice offline, trượt về Local Function:', err?.message || err);
                result = await orchestrator.route({ type: 'discord_question', query: job.query });
              }
            } else {
              result = await orchestrator.route({
                type: 'discord_question',
                query: job.query,
                options: {
                  isDeep: job.isDeep || false,
                  preferredSources: job.preferredSources || [],
                },
              });
            }

            if (result?.error) {
              console.error('Orchestrator query failed:', result?.error?.stack || result?.error?.message || result?.error);
              await job.waitingMsg.edit({
                content: 'Da co loi khi xu ly cau hoi. Vui long thu lai sau.',
                components: [],
                allowedMentions: { parse: [] },
              });
              continue;
            }

            const topicLabel = result.predictedTopic
              || job.query.split(/[\s,.!?]+/).slice(0, 4).join(' ')
              || 'chu de nay';
            const safeTopic = previewTopic(topicLabel);
            const customId = rememberInterestTopic(topicLabel);

            // 👍 = Quan tâm + F1 positive feedback (gộp Markov chain vào feedback)
            const row = new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setCustomId(`feedback:👍:${customId}`)
                .setLabel(`👍 Quan tâm: ${safeTopic}`)
                .setStyle(ButtonStyle.Success),
              new ButtonBuilder()
                .setCustomId(`feedback:👎:${customId}`)
                .setLabel('👎')
                .setStyle(ButtonStyle.Danger),
            );

            // Build response with source scores
            let responseText = result.answer || 'Khong tim thay cau tra loi phu hop.';
            
            // Append source scores if available
            if (result.sourcesFormatted) {
              responseText += '\n\n---\n\n📚 **Nguồn tham khảo (Score/Weight):**\n\n' + result.sourcesFormatted;
            }

            await job.waitingMsg.edit({
              content: truncateForDiscord(responseText),
              components: [row],
              allowedMentions: { parse: [] },
            });
          } catch (err) {
            console.error('Queue job failed:', err?.stack || err?.message || err);
            try {
              await job.waitingMsg.edit({
                content: 'Da co loi khi xu ly cau hoi. Vui long thu lai sau.',
                components: [],
                allowedMentions: { parse: [] },
              });
            } catch (_) {
              // ignore
            }
          }
        }

        isProcessingQueue = false;
      })().catch((err) => {
        console.error('Queue worker fatal error:', err?.stack || err?.message || err);
        isProcessingQueue = false;
      });
    }
  } catch (err) {
    console.error('Discord query failed:', err?.stack || err?.message || err);
    await message.channel.send({
      content: 'Da co loi khi xu ly cau hoi. Vui long thu lai sau.',
      allowedMentions: { parse: [] },
    });
    // Mark idempotency done (with error)
    try {
      const { markDone } = await import('./lib/idempotency.js');
      if (message._idempotencyKey) markDone(message._idempotencyKey, { answer: '❌ Lỗi xử lý' });
    } catch { /* ignore */ }
    return;
  }

  // Mark idempotency done (success)
  try {
    const { markDone } = await import('./lib/idempotency.js');
    if (message._idempotencyKey) markDone(message._idempotencyKey, { answer: '✅ Đã xử lý' });
  } catch { /* ignore */ }

  // ── !plugins command ──
  if (content === '!plugins') {
    try {
      const { PluginLoader } = await import('./lib/plugin_loader.js');
      const plugins = PluginLoader.list();
      if (plugins.length === 0) {
        await message.reply('Không có plugin nào đang chạy.');
      } else {
        const lines = plugins.map(p =>
          `**${p.name}** v${p.version} — intents: ${p.intents.join(', ')}\n` +
          `  permissions: \`${p.permissions.join(', ')}\``
        ).join('\n\n');
        await message.reply({
          embeds: [{ title: `Loaded plugins (${plugins.length})`, description: lines }],
        });
      }
    } catch (err) {
      await message.reply('Lỗi khi lấy danh sách plugins: ' + err.message);
    }
  }

  // ── !plugin unload <name> command (admin only) ──
  if (content.startsWith('!plugin unload ')) {
    const adminIds = process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',') : [];
    if (!adminIds.includes(message.author.id)) {
      await message.reply('❌ Cần quyền admin để unload plugin.');
    } else {
      const name = content.slice(16).trim();
      try {
        const { PluginLoader } = await import('./lib/plugin_loader.js');
        const ok = await PluginLoader.unload(name);
        await message.reply(ok ? `✅ Đã unload plugin "${name}"` : `❌ Không tìm thấy plugin "${name}"`);
      } catch (err) {
        await message.reply('Lỗi khi unload: ' + err.message);
      }
    }
  }
});

async function shutdown(signal) {
  console.log(`Received ${signal}. Shutting down Discord bot...`);
  try {
    await client.destroy();
  } finally {
    process.exit(0);
  }
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

console.log(`Starting Discord bot with command prefix ${JSON.stringify(prefix)}...`);

client.login(token).catch((err) => {
  clearTimeout(readyWatchdog);
  console.error('Discord login failed:', err.message || err);
  process.exit(1);
});
