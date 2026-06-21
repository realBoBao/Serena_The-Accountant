/**
 * lib/llm.js — Unified LLM Layer với Multi-Model Fallback
 *
 * Thứ tự fallback:
 *   1. OpenRouter        (OPENROUTER_API_KEY) — nhiều model free
 *   2. Gemini API        (GEMINI_API_KEY) — model: gemini-2.0-flash (mặc định)
 *   3. Local LLM         (llama-server :3002) — Qwen 1.5B
 *   4. Static fallback   — rule-based response (không cần API key)
 *
 * Cách dùng:
 *   import { ask, askWithFallback, streamAsk } from './llm.js';
 *   const answer = await ask("Xin chào!");
 *
 * Hoặc dùng trực tiếp:
 *   const llm = createLlm();
 *   const res = await llm.invoke([new HumanMessage("Xin chào")]);
 */

import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import crypto from 'crypto';
import { selectModel } from './adaptive_model.js';

// Optional: OpenRouter fallback (only if @langchain/openai installed)
let ChatOpenAI = null;
try { ChatOpenAI = (await import('@langchain/openai')).ChatOpenAI; } catch { /* optional */ }

// ═══════════════════════════════════════════════════════════
//  CONFIG
// ═══════════════════════════════════════════════════════════

const GEMINI_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.Google_API_KEY || '';
// Thứ tự thử: env → 2.5-flash → 2.0-flash → 2.0-flash-lite → 3.5-flash
const GEMINI_FALLBACK_MODELS = [
  process.env.GEMINI_MODEL,
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
  'gemini-3.5-flash',
  'gemini-flash-latest',
].filter(Boolean);
const GEMINI_MODEL = GEMINI_FALLBACK_MODELS[0];

// ── Groq (LPU inference — ultra-low latency) ──
const GROQ_KEY = process.env.GROQ_API_KEY || '';
const GROQ_BASE = process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1';
const GROQ_DEFAULT_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
const GROQ_FALLBACK_MODELS = [
  GROQ_DEFAULT_MODEL,   // llama-3.3-70b-versatile (primary — confirmed working)
  'llama-3.3-70b-versatile',
  'llama-3.2-3b-preview',
  'llama-3.2-1b-preview',
  'gemma2-9b-it',
].filter(Boolean);

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || '';
const OPENROUTER_BASE = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
const OPENROUTER_MODELS = (process.env.OPENROUTER_MODELS || 'google/gemma-4-31b-it:free,qwen/qwen3-next-80b-a3b-instruct:free,nvidia/nemotron-3-nano-30b-a3b:free,cohere/north-mini-code:free')
  .split(',').map(s => s.trim()).filter(Boolean);

const LOCAL_LLM_URL = process.env.LOCAL_LLM_URL || 'http://127.0.0.1:3002';
const LOCAL_LLM_TIMEOUT = Number(process.env.LOCAL_LLM_TIMEOUT || 15000);

const DEFAULT_TEMPERATURE = Number(process.env.LLM_TEMPERATURE || 0.7);
const DEFAULT_MAX_TOKENS = Number(process.env.LLM_MAX_TOKENS || 1024);

// ═══════════════════════════════════════════════════════════
//  TIER 1: Context Compression
// ═══════════════════════════════════════════════════════════

/**
 * Summarize long context to reduce token usage.
 * Uses a cheap local model or static extraction as fallback.
 *
 * @param {string} longText — Raw context (logs, files, chat history)
 * @param {number} [maxOutputChars=500] — Max length of summary
 * @returns {Promise<string>} Compressed summary
 */
export async function summarizeContext(longText, maxOutputChars = 500) {
  if (!longText || longText.length <= maxOutputChars) return longText;

  // Static fallback: extract key sentences (first + last + keywords)
  const lines = longText.split(/\n/).filter(l => l.trim().length > 10);
  if (lines.length <= 5) return longText.slice(0, maxOutputChars);

  // Take first 2 lines, last 2 lines, and any lines with keywords
  const keywords = ['error', 'fail', 'bug', 'fix', 'important', 'note', 'warning', 'critical', 'lỗi', 'sửa', 'quan trọng'];
  const keyLines = lines.filter(l => keywords.some(k => l.toLowerCase().includes(k)));
  const summary = [
    ...lines.slice(0, 2),
    ...keyLines.slice(0, 3),
    ...lines.slice(-2),
  ].filter((v, i, a) => a.indexOf(v) === i).join('\n');

  return summary.length > maxOutputChars ? summary.slice(0, maxOutputChars) + '...' : summary;
}

// ═══════════════════════════════════════════════════════════
//  PROVIDER FACTORIES
// ═══════════════════════════════════════════════════════════

/** Tạo Gemini LLM instance */
function createGeminiLlm(opts = {}) {
  if (!GEMINI_KEY) return null;
  return new ChatGoogleGenerativeAI({
    apiKey: GEMINI_KEY,
    model: opts.model || GEMINI_MODEL,
    temperature: opts.temperature ?? DEFAULT_TEMPERATURE,
    maxOutputTokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
    maxRetries: 2,
  });
}

/** Tạo Groq LLM instance (LPU inference — ultra-low latency, OpenAI-compatible) */
function createGroqLlm(opts = {}) {
  if (!GROQ_KEY || !ChatOpenAI) return null;
  return new ChatOpenAI({
    apiKey: GROQ_KEY,
    model: opts.model || GROQ_DEFAULT_MODEL,
    temperature: opts.temperature ?? DEFAULT_TEMPERATURE,
    maxTokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
    maxRetries: 1, // Groq is fast, retry quickly
    configuration: { baseURL: GROQ_BASE },
    openAIApiKey: GROQ_KEY,
  });
}

/**
 * Gọi Groq API trực tiếp qua native fetch — không cần @langchain/openai
 * Dùng khi LangChain không available. Groq có OpenAI-compatible endpoint.
 * Đọc env vars lazily để hỗ trợ dotenv config() gọi sau khi import.
 */
async function callGroqNative(messages, opts = {}) {
  const groqKey = process.env.GROQ_API_KEY || GROQ_KEY;
  if (!groqKey) return null;
  const model = opts.model || GROQ_DEFAULT_MODEL;
  const temperature = opts.temperature ?? DEFAULT_TEMPERATURE;
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;

  // Convert LangChain messages to OpenAI format
  const openaiMessages = [];
  for (const msg of messages) {
    const type = msg._getType?.() || msg.role || '';
    const content = typeof msg.content === 'string' ? msg.content : String(msg.content || '');
    if (type === 'system') openaiMessages.push({ role: 'system', content });
    else if (type === 'human' || type === 'user') openaiMessages.push({ role: 'user', content });
    else if (type === 'ai' || type === 'assistant') openaiMessages.push({ role: 'assistant', content });
    else openaiMessages.push({ role: 'user', content }); // fallback
  }

  const res = await fetch(`${GROQ_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${groqKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: openaiMessages,
      temperature,
      max_tokens: maxTokens,
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Groq API ${res.status}: ${errBody.slice(0, 200)}`);
  }

  const data = await res.json();
  const answer = data.choices?.[0]?.message?.content;
  if (!answer || !answer.trim()) return null;
  return { answer: answer.trim(), provider: 'groq', model };
}

/** Tạo OpenRouter LLM instance */
function createOpenRouterLlm(opts = {}) {
  if (!OPENROUTER_KEY || !ChatOpenAI) return null;
  return new ChatOpenAI({
    apiKey: OPENROUTER_KEY,
    model: opts.model || OPENROUTER_MODELS[0] || 'openrouter/auto',
    temperature: opts.temperature ?? DEFAULT_TEMPERATURE,
    maxTokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
    maxRetries: 2,
    configuration: { baseURL: OPENROUTER_BASE },
    openAIApiKey: OPENROUTER_KEY,
  });
}

/** Gọi Local LLM qua HTTP (local_llm_server.js proxy) */
async function callLocalLlm(messages, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOCAL_LLM_TIMEOUT);

  try {
    // Chuyển messages thành query đơn giản
    const lastUser = messages.find(m => {
      const t = m._getType?.() || m.role || '';
      return t === 'human' || t === 'user';
    });
    const query = lastUser?.content || messages[messages.length - 1]?.content || '';

    // Thử endpoint /api/ask trước (local_llm_server.js)
    const response = await fetch(`${LOCAL_LLM_URL}/api/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!response.ok) return null;
    const data = await response.json();
    if (data?.ok && data?.answer) return data.answer;
    if (data?.content) return data.content;
    if (data?.choices?.[0]?.text) return data.choices[0].text;
    return null;
  } catch {
    clearTimeout(timer);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════
//  STATIC FALLBACK (không cần API key)
// ═══════════════════════════════════════════════════════════

/** Rule-based fallback khi tất cả API đều không khả dụng */
async function staticFallback(query, context = '') {
  const q = (query || '').toLowerCase().trim();

  // Chào hỏi
  if (/^(xin chào|hello|hi|hey|chào|chao)\b/.test(q)) {
    return 'Xin chào! Tôi là Serena_Project00, trợ lý AI của bạn. Tôi đang ở chế độ offline (không có LLM API key). Tôi có thể giúp bạn với các lệnh Discord như !quiz, !run, !debate. Để có AI đầy đủ, hãy cấu hình GEMINI_API_KEY hoặc OPENROUTER_API_KEY trong .env.';
  }

  // Hỏi tên
  if (/tên gì|who are you|bạn là ai|giới thiệu/.test(q)) {
    return 'Tôi là Serena_Project00 — trợ lý AI đa năng. Hiện đang ở chế độ offline. Cấu hình API key để kích hoạt AI đầy đủ.';
  }

  // Hỏi trạng thái
  if (/trạng thái|status|khỏe không|hoạt động/.test(q)) {
    return 'Hệ thống đang chạy ở chế độ offline. Các lệnh Discord cơ bản vẫn hoạt động. Để có AI đầy đủ, cần GEMINI_API_KEY hoặc OPENROUTER_API_KEY.';
  }

  // Thử search vector DB trước khi fallback hoàn toàn
  try {
    const { embedText } = await import('./embeddings.js');
    const { search: vectorSearch } = await import('./vector_store.js');
    const qEmbedding = await embedText(query);
    const results = await vectorSearch(qEmbedding, 3);
    if (results && results.length > 0) {
      const snippets = results.map((r, i) =>
        `[${i + 1}] ${r.chunk_text?.slice(0, 300) || ''}`
      ).join('\n\n');
      return `⚠️ LLM API hiện không khả dụng (rate limit / key hết hạn). Dưới đây là kết quả tìm kiếm từ knowledge base:\n\n${snippets}\n\n💡 Để có AI đầy đủ, hãy cập nhật GEMINI_API_KEY hoặc OPENROUTER_API_KEY trong .env.`;
    }
  } catch {
    // Vector search cũng fail → dùng static text
  }

  // Mặc định — trả về string thuần, không phải object
  return `Tôi đã nhận được câu hỏi: "${query.slice(0, 100)}". Hiện tại tôi đang ở chế độ offline. Các lệnh !quiz, !run, !debate, !animate vẫn hoạt động bình thường. Để kích hoạt AI đầy đủ, hãy thêm GEMINI_API_KEY hoặc OPENROUTER_API_KEY vào file .env.`;
}

// ═══════════════════════════════════════════════════════════
//  MAIN: ask() với full fallback chain
// ═══════════════════════════════════════════════════════════

/**
 * Gọi LLM với full fallback chain.
 *
 * @param {string} query       — Câu hỏi/câu lệnh
 * @param {Object} [opts]
 * @param {string} [opts.systemPrompt] — System prompt
 * @param {string} [opts.provider]      — 'gemini' | 'openrouter' | 'local' | 'auto' (mặc định)
 * @param {number} [opts.temperature]
 * @param {number} [opts.maxTokens]
 * @param {string} [opts.model]         — Override model name
 *
 * @returns {Promise<{ answer: string, provider: string, model: string }>}
 */
// ── Simple in-memory response cache ──
// Key: hash of (query + systemPrompt + model), Value: { answer, provider, model, ts }
const _responseCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes TTL
const MAX_CACHE_SIZE = 500;

function _cacheKey(query, systemPrompt, model) {
  return crypto.createHash('md5').update(`${query}|${systemPrompt}|${model || 'auto'}`).digest('hex');
}

function _cacheGet(key) {
  const entry = _responseCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    _responseCache.delete(key);
    return null;
  }
  return entry;
}

function _cacheSet(key, value) {
  if (_responseCache.size >= MAX_CACHE_SIZE) {
    // Evict oldest entry
    const oldest = _responseCache.keys().next().value;
    _responseCache.delete(oldest);
  }
  _responseCache.set(key, { ...value, ts: Date.now() });
}

export async function ask(query, opts = {}) {
  const systemPrompt = opts.systemPrompt || 'You are Serena_Project00, a helpful AI assistant. Answer in Vietnamese when asked in Vietnamese.';
  const temperature = opts.temperature ?? DEFAULT_TEMPERATURE;
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  const timeoutMs = opts.timeoutMs ?? 15000; // Default 15s timeout

  // ── Tier 2: Check cache first (skip if opts.noCache) ──
  if (!opts.noCache) {
    const modelHint = opts.model || opts.provider || 'auto';
    const key = _cacheKey(query, systemPrompt, modelHint);
    const cached = _cacheGet(key);
    if (cached) {
      console.debug('[LLM] Cache hit — returning cached response');
      return { ...cached, cached: true };
    }
  }

  // Wrap với timeout
  let result;
  try {
    result = await Promise.race([
      _doAsk(query, { systemPrompt, temperature, maxTokens, opts }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('LLM timeout')), timeoutMs)),
    ]);
  } catch (err) {
    if (err.message === 'LLM timeout') {
      console.debug('[LLM] Timeout, using static fallback');
      const fallback = await staticFallback(query);
      return { answer: typeof fallback === 'string' ? fallback : fallback?.answer || String(fallback), provider: 'static', model: 'timeout-fallback' };
    }
    // All providers failed — return static fallback instead of throwing
    console.debug('[LLM] All providers failed, using static fallback:', err?.message);
    const fallback = await staticFallback(query);
    return { answer: typeof fallback === 'string' ? fallback : fallback?.answer || String(fallback), provider: 'static', model: 'error-fallback' };
  }

  // ── Tier 2: Store in cache ──
  if (!opts.noCache && result?.answer) {
    const modelHint = opts.model || opts.provider || 'auto';
    const key = _cacheKey(query, systemPrompt, modelHint);
    _cacheSet(key, { answer: result.answer, provider: result.provider, model: result.model });
  }

  return result;
}

// ── Provider health cache (avoid retrying known-bad keys) ──
// Key: 'groq' | 'gemini' | 'openrouter', Value: { valid: boolean, ts: number }
const _providerHealth = new Map();
const PROVIDER_HEALTH_TTL = 5 * 60 * 1000; // 5 minutes

function isProviderHealthy(provider) {
  const entry = _providerHealth.get(provider);
  if (!entry) return null; // unknown → try
  if (Date.now() - entry.ts > PROVIDER_HEALTH_TTL) return null; // expired → retry
  return entry.valid;
}

function setProviderHealth(provider, valid) {
  _providerHealth.set(provider, { valid, ts: Date.now() });
}

async function _doAsk(query, { systemPrompt, temperature, maxTokens, opts }) {

  const messages = [];
  if (systemPrompt) messages.push(new SystemMessage(systemPrompt));
  messages.push(new HumanMessage(query));

  // ── Tier 2: Adaptive model selection ──
  // Nếu user không chỉ định model/provider cụ thể, tự động chọn theo loại query
  const adaptive = (!opts.model && !opts.provider) ? selectModel(query) : null;
  const preferredProvider = opts.provider || (adaptive ? adaptive.provider : 'auto');
  const preferredModel = opts.model || (adaptive ? adaptive.model : null);
  if (adaptive) {
    console.debug(`[LLM] Adaptive routing: query="${query.slice(0,40)}..." → provider=${adaptive.provider} model=${adaptive.model} (${adaptive.reason})`);
  }

  // ── 0. Groq LPU (ưu tiên #0 — ultra-low latency, confirmed working) ──
  if (preferredProvider === 'groq' || preferredProvider === 'auto') {
    // Health check: skip if known-bad
    const groqHealth = isProviderHealthy('groq');
    if (groqHealth === false) {
      console.debug('[LLM] Groq key known-bad, skipping...');
    } else {
      const modelsToTry = preferredModel ? [preferredModel, ...GROQ_FALLBACK_MODELS] : GROQ_FALLBACK_MODELS;
      const tried = new Set();
      for (const modelName of modelsToTry) {
        if (!modelName || tried.has(modelName)) continue;
        tried.add(modelName);
        try {
          // Thử LangChain trước (nếu available)
          if (ChatOpenAI) {
            const groqLlm = createGroqLlm({ model: modelName, temperature, maxTokens });
            if (groqLlm) {
              const res = await groqLlm.invoke(messages);
              const answer = typeof res.content === 'string' ? res.content : String(res.content || '');
              if (answer && answer.trim()) {
                setProviderHealth('groq', true);
                return { answer: answer.trim(), provider: 'groq', model: modelName };
              }
            }
          }
          // Fallback: dùng native fetch (không cần @langchain/openai)
          const nativeResult = await callGroqNative(messages, { model: modelName, temperature, maxTokens });
          if (nativeResult) {
            setProviderHealth('groq', true);
            if (modelName !== GROQ_DEFAULT_MODEL) {
              console.log(`[LLM] Groq native fallback thành công với model: ${modelName}`);
            }
            return nativeResult;
          }
        } catch (err) {
          const msg = String(err?.message || '').toLowerCase();
          if (msg.includes('blocked') || msg.includes('permission')) {
            console.warn(`[LLM] Groq model "${modelName}" bị block, bỏ qua...`);
          } else {
            console.warn(`[LLM] Groq lỗi (${modelName}):`, err?.message || err);
          }
        }
      }
      // All Groq models failed → mark key as bad
      setProviderHealth('groq', false);
    }
  }

  // ── 1. OpenRouter (ưu tiên #1 - nhiều model free, ít rate limit) ──
  if (preferredProvider === 'openrouter' || preferredProvider === 'auto') {
    const orHealth = isProviderHealthy('openrouter');
    if (orHealth === false) {
      console.debug('[LLM] OpenRouter known-bad, skipping...');
    } else {
      const orModel = preferredModel || opts.model;
      const orLlm = createOpenRouterLlm({ model: orModel, temperature, maxTokens });
      if (orLlm) {
        // Nếu có model cụ thể, thử trước
        if (orModel) {
          try {
            const res = await orLlm.invoke(messages);
            const answer = typeof res.content === 'string' ? res.content : String(res.content || '');
            if (answer && answer.trim()) {
              setProviderHealth('openrouter', true);
              return { answer: answer.trim(), provider: 'openrouter', model: orModel };
            }
          } catch (err) {
            console.warn('[LLM] OpenRouter model lỗi:', err?.message || err);
          }
        }

        // Thử lần lượt các model fallback
        let anySuccess = false;
        for (const modelName of OPENROUTER_MODELS) {
          try {
            const fallbackLlm = createOpenRouterLlm({ model: modelName, temperature, maxTokens });
            if (!fallbackLlm) continue;
            const res = await fallbackLlm.invoke(messages);
            const answer = typeof res.content === 'string' ? res.content : String(res.content || '');
            if (answer && answer.trim()) {
              setProviderHealth('openrouter', true);
              anySuccess = true;
              return { answer: answer.trim(), provider: 'openrouter', model: modelName };
            }
          } catch { /* thử model tiếp theo */ }
        }
        if (!anySuccess) {
          setProviderHealth('openrouter', false);
          console.warn('[LLM] All OpenRouter models failed, marked as bad for 5min');
        }
      }
    }
  }

  // ── 2. Gemini (ưu tiên #2 - nhanh nhưng quota thấp) ─────
  if (preferredProvider === 'gemini' || preferredProvider === 'auto') {
    const geminiHealth = isProviderHealthy('gemini');
    if (geminiHealth === false) {
      console.debug('[LLM] Gemini key known-bad, skipping...');
    } else {
      const modelsToTry = preferredModel ? [preferredModel] : opts.model ? [opts.model] : GEMINI_FALLBACK_MODELS;
      let keyInvalid = false;
      for (const modelName of modelsToTry) {
        if (!modelName) continue;
        const gemini = createGeminiLlm({ model: modelName, temperature, maxTokens });
        if (!gemini) continue;
        try {
          // Thử dùng context cache nếu có system prompt dài
          let invokeOpts = {};
          if (systemPrompt && systemPrompt.length > 200) {
            const { getOrCreateCache, getCacheName } = await import('./context_cache.js');
            const cacheName = opts.cacheName || 'serena-system-prompt';
            let cachedName = getCacheName(cacheName);
            if (!cachedName) {
              cachedName = await getOrCreateCache(cacheName, systemPrompt, '3600s');
            }
            if (cachedName) {
              invokeOpts.cachedContent = cachedName;
            }
          }
          const res = await gemini.invoke(messages, invokeOpts);
          const answer = typeof res.content === 'string' ? res.content : String(res.content || '');
          if (answer && answer.trim()) {
            setProviderHealth('gemini', true);
            if (modelName !== modelsToTry[0]) {
              console.log(`[LLM] Gemini fallback thành công với model: ${modelName}`);
            }
            return { answer: answer.trim(), provider: 'gemini', model: modelName };
          }
        } catch (err) {
          const msg = String(err?.message || '').toLowerCase();
          if (msg.includes('api key not valid') || msg.includes('invalid')) {
            // Key invalid → skip all Gemini models immediately
            console.warn(`[LLM] Gemini API key invalid, skipping all models`);
            keyInvalid = true;
            break;
          } else if (msg.includes('404') || msg.includes('not found') || msg.includes('model')) {
            console.warn(`[LLM] Gemini model "${modelName}" không khả dụng, thử tiếp...`);
          } else {
            console.warn(`[LLM] Gemini lỗi (${modelName}):`, err?.message || err);
            break;
          }
        }
      }
      if (keyInvalid) {
        setProviderHealth('gemini', false);
        console.warn('[LLM] Gemini marked as bad for 5min (invalid key)');
      }
    }
  }

  // ── 3. Fallback: nếu Gemini/OpenRouter fail, thử Groq (confirmed working) ──
  // Adaptive routing có thể chọn Gemini/OpenRouter → fail → cần fallback sang Groq
  if (preferredProvider !== 'groq' && GROQ_KEY) {
    const groqHealth = isProviderHealthy('groq');
    if (groqHealth !== false) {
      console.debug('[LLM] Primary provider failed, trying Groq fallback...');
      const modelsToTry = [GROQ_DEFAULT_MODEL, ...GROQ_FALLBACK_MODELS.slice(1)];
      const tried = new Set();
      for (const modelName of modelsToTry) {
        if (!modelName || tried.has(modelName)) continue;
        tried.add(modelName);
        try {
          const nativeResult = await callGroqNative(messages, { model: modelName, temperature, maxTokens });
          if (nativeResult) {
            setProviderHealth('groq', true);
            console.log(`[LLM] Groq fallback success: ${modelName}`);
            return nativeResult;
          }
        } catch (err) {
          const msg = String(err?.message || '').toLowerCase();
          if (msg.includes('blocked') || msg.includes('permission')) {
            console.warn(`[LLM] Groq model "${modelName}" bị block, bỏ qua...`);
          }
        }
      }
      setProviderHealth('groq', false);
    }
  }

  // ── 4. Local LLM (ưu tiên #4) ───────────────────────────
  if (opts.provider === 'auto' || opts.provider === 'local' || !opts.provider) {
    const localAnswer = await callLocalLlm(messages, { temperature, maxTokens });
    if (localAnswer && localAnswer.trim()) {
      return { answer: localAnswer.trim(), provider: 'local', model: 'qwen-1.5b' };
    }
  }

  // ── 5. Static fallback ──────────────────────────────────
  console.debug('[LLM] All providers unavailable, using static fallback.');
  const fallbackAnswer = await staticFallback(query);
  return { answer: typeof fallbackAnswer === 'string' ? fallbackAnswer : String(fallbackAnswer), provider: 'static', model: 'rule-based' };
}

/**
 * Gọi LLM với context (RAG-style).
 * Tự động format prompt vào query.
 */
export async function askWithContext(query, contextDocs, opts = {}) {
  let fullQuery = query;
  if (contextDocs && contextDocs.length > 0) {
    const contextStr = contextDocs.map((doc, i) => `[${i + 1}] ${doc}`).join('\n\n');
    fullQuery = `Context:\n${contextStr}\n\nCâu hỏi: ${query}`;
  }
  return ask(fullQuery, opts);
}

/**
 * Stream LLM response (chỉ hỗ trợ Gemini + OpenRouter).
 */
export async function streamAsk(query, onChunk, opts = {}) {
  const systemPrompt = opts.systemPrompt || 'You are Serena_Project00, a helpful AI assistant.';
  const messages = [];
  if (systemPrompt) messages.push(new SystemMessage(systemPrompt));
  messages.push(new HumanMessage(query));

  // Thử Gemini stream
  const gemini = createGeminiLlm(opts);
  if (gemini) {
    try {
      const stream = await gemini.stream(messages);
      let full = '';
      for await (const chunk of stream) {
        const text = typeof chunk.content === 'string' ? chunk.content : String(chunk.content || '');
        full += text;
        onChunk?.(text);
      }
      return { answer: full.trim(), provider: 'gemini', model: opts.model || GEMINI_MODEL };
    } catch { /* fallback */ }
  }

  // Fallback: non-stream ask
  const result = await ask(query, opts);
  onChunk?.(result.answer);
  return result;
}

/**
 * Health check: kiểm tra providers nào khả dụng.
 */
export async function healthCheck() {
  const providers = [];

  if (GEMINI_KEY) {
    try {
      const llm = createGeminiLlm();
      if (llm) {
        await llm.invoke([new HumanMessage('ping')]);
        providers.push({ name: 'gemini', model: GEMINI_MODEL, status: 'ok' });
      }
    } catch (err) {
      providers.push({ name: 'gemini', model: GEMINI_MODEL, status: 'error', error: err?.message || String(err) });
    }
  }

  if (OPENROUTER_KEY) {
    try {
      const llm = createOpenRouterLlm();
      if (llm) {
        await llm.invoke([new HumanMessage('ping')]);
        providers.push({ name: 'openrouter', model: OPENROUTER_MODELS[0], status: 'ok' });
      }
    } catch (err) {
      providers.push({ name: 'openrouter', model: OPENROUTER_MODELS[0], status: 'error', error: err?.message || String(err) });
    }
  }

  // Local LLM
  try {
    const r = await fetch(`${LOCAL_LLM_URL}/health`, { signal: AbortSignal.timeout(3000) });
    if (r.ok) {
      const data = await r.json();
      providers.push({ name: 'local', model: 'qwen-1.5b', status: data?.status === 'online' ? 'ok' : 'offline' });
    }
  } catch {
    providers.push({ name: 'local', model: 'qwen-1.5b', status: 'offline' });
  }

  providers.push({ name: 'static', model: 'rule-based', status: 'always' });

  return providers;
}

/**
 * Invoke LLM with messages array (LangChain format).
 * Wrapper cho RagAgent.invokeLlm — giữ backward compatibility.
 * Các agent khác nên dùng hàm này thay vì import trực tiếp từ RagAgent.
 */
export async function invokeLlm(messages, label = 'LLM') {
  // Dynamic import để tránh circular dependency
  const { invokeLlm: ragInvokeLlm } = await import('../agents/RagAgent.js');
  return ragInvokeLlm(messages, label);
}

// Named exports for direct access
export { createGroqLlm, createOpenRouterLlm, createGeminiLlm };

export default { ask, askWithContext, streamAsk, healthCheck, invokeLlm, createGroqLlm, createOpenRouterLlm, createGeminiLlm };
