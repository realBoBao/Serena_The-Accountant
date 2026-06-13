/**
 * lib/llm.js — Unified LLM Layer với Multi-Model Fallback
 *
 * Thứ tự fallback:
 *   1. OpenRouter        (OPENROUTER_API_KEY) — nhiều model free
 *   2. Vertex AI         (GOOGLE_APPLICATION_CREDENTIALS) — Gemini trên GCP
 *   3. Gemini API        (GEMINI_API_KEY) — model: gemini-2.0-flash (mặc định)
 *   4. Local LLM         (llama-server :3002) — Qwen 1.5B
 *   5. Static fallback   — rule-based response (không cần API key)
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
import { ChatOpenAI } from '@langchain/openai';

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

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || '';
const OPENROUTER_BASE = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
const OPENROUTER_MODELS = (process.env.OPENROUTER_MODELS || 'google/gemini-2.0-flash-001,google/gemma-2-9b-it:free,mistralai/mistral-7b-instruct:free,meta-llama/llama-3.1-8b-instruct:free')
  .split(',').map(s => s.trim()).filter(Boolean);

const LOCAL_LLM_URL = process.env.LOCAL_LLM_URL || 'http://127.0.0.1:3002';
const LOCAL_LLM_TIMEOUT = Number(process.env.LOCAL_LLM_TIMEOUT || 15000);

const DEFAULT_TEMPERATURE = Number(process.env.LLM_TEMPERATURE || 0.7);
const DEFAULT_MAX_TOKENS = Number(process.env.LLM_MAX_TOKENS || 1024);

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

/** Tạo OpenRouter LLM instance */
function createOpenRouterLlm(opts = {}) {
  if (!OPENROUTER_KEY) return null;
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

/** Tạo Vertex AI LLM instance (Gemini trên GCP) — dùng @google/genai mới */
function createVertexLlm(opts = {}) {
  const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || './vertex-key.json';
  try {
    if (!require('fs').existsSync(keyPath)) return null;
    const keyData = JSON.parse(require('fs').readFileSync(keyPath, 'utf8'));
    const projectId = process.env.GCP_PROJECT_ID || keyData.project_id || '';
    if (!projectId) {
      console.warn('[LLM] Vertex AI: thiếu project_id');
      return null;
    }
    // Set env var để SDK đọc credentials
    process.env.GOOGLE_APPLICATION_CREDENTIALS = keyPath;
    const { GoogleGenAI } = require('@google/genai');
    const client = new GoogleGenAI({ vertexai: true, project: projectId, location: process.env.GCP_LOCATION || 'us-central1' });
    return { client, model: opts.model || 'gemini-2.0-flash' };
  } catch (err) {
    console.warn('[LLM] Vertex AI init failed:', err.message);
    return null;
  }
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

  // Mặc định
  return {
    answer: `Tôi đã nhận được câu hỏi: "${query.slice(0, 100)}". Hiện tại tôi đang ở chế độ offline (không có LLM API key). Các lệnh !quiz, !run, !debate, !animate vẫn hoạt động bình thường. Để kích hoạt AI đầy đủ, hãy thêm GEMINI_API_KEY hoặc OPENROUTER_API_KEY vào file .env.`,
    provider: 'static',
    model: 'rule-based',
  };
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
export async function ask(query, opts = {}) {
  const systemPrompt = opts.systemPrompt || 'You are Serena_Project00, a helpful AI assistant. Answer in Vietnamese when asked in Vietnamese.';
  const temperature = opts.temperature ?? DEFAULT_TEMPERATURE;
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  const timeoutMs = opts.timeoutMs ?? 15000; // Default 15s timeout

  // Wrap với timeout
  return Promise.race([
    _doAsk(query, { systemPrompt, temperature, maxTokens, opts }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('LLM timeout')), timeoutMs)),
  ]).catch(err => {
    if (err.message === 'LLM timeout') {
      console.warn('[LLM] Timeout, using static fallback');
      const fallback = staticFallback(query);
      return { answer: fallback.answer, provider: 'static', model: 'timeout-fallback' };
    }
    throw err;
  });
}

async function _doAsk(query, { systemPrompt, temperature, maxTokens, opts }) {

  const messages = [];
  if (systemPrompt) messages.push(new SystemMessage(systemPrompt));
  messages.push(new HumanMessage(query));

  // ── 1. OpenRouter (ưu tiên #1 - nhiều model free, ít rate limit) ──
  if (opts.provider === 'auto' || opts.provider === 'openrouter' || !opts.provider) {
    const orLlm = createOpenRouterLlm({ model: opts.model, temperature, maxTokens });
    if (orLlm) {
      // Nếu có model cụ thể, thử trước
      if (opts.model) {
        try {
          const res = await orLlm.invoke(messages);
          const answer = typeof res.content === 'string' ? res.content : String(res.content || '');
          if (answer && answer.trim()) {
            return { answer: answer.trim(), provider: 'openrouter', model: opts.model };
          }
        } catch (err) {
          console.warn('[LLM] OpenRouter model lỗi:', err?.message || err);
        }
      }

      // Thử lần lượt các model fallback
      for (const modelName of OPENROUTER_MODELS) {
        try {
          const fallbackLlm = createOpenRouterLlm({ model: modelName, temperature, maxTokens });
          if (!fallbackLlm) continue;
          const res = await fallbackLlm.invoke(messages);
          const answer = typeof res.content === 'string' ? res.content : String(res.content || '');
          if (answer && answer.trim()) {
            return { answer: answer.trim(), provider: 'openrouter', model: modelName };
          }
        } catch { /* thử model tiếp theo */ }
      }
    }
  }

  // ── 2. Gemini (ưu tiên #2 - nhanh nhưng quota thấp) ─────
  if (opts.provider === 'auto' || opts.provider === 'gemini' || !opts.provider) {
    const modelsToTry = opts.model ? [opts.model] : GEMINI_FALLBACK_MODELS;
    for (const modelName of modelsToTry) {
      if (!modelName) continue;
      const gemini = createGeminiLlm({ model: modelName, temperature, maxTokens });
      if (!gemini) continue;
      try {
        const res = await gemini.invoke(messages);
        const answer = typeof res.content === 'string' ? res.content : String(res.content || '');
        if (answer && answer.trim()) {
          if (modelName !== modelsToTry[0]) {
            console.log(`[LLM] Gemini fallback thành công với model: ${modelName}`);
          }
          return { answer: answer.trim(), provider: 'gemini', model: modelName };
        }
      } catch (err) {
        const msg = String(err?.message || '').toLowerCase();
        if (msg.includes('404') || msg.includes('not found') || msg.includes('model')) {
          console.warn(`[LLM] Gemini model "${modelName}" không khả dụng, thử tiếp...`);
        } else {
          console.warn(`[LLM] Gemini lỗi (${modelName}):`, err?.message || err);
          break;
        }
      }
    }
  }

  // ── 3. Vertex AI (Gemini trên GCP) ──────────────────────
  // NOTE: Cần enable Vertex AI API trong Google Cloud Console và có project_id hợp lệ
  if (opts.provider === 'vertex') {
    const vertexLlm = createVertexLlm({ model: opts.model, temperature, maxTokens });
    if (vertexLlm) {
      try {
        const { client, model } = vertexLlm;
        const result = await client.models.generateContent({
          model,
          contents: [{ role: 'user', parts: [{ text: query }] }],
        });
        const answer = result?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        if (answer.trim()) {
          return { answer: answer.trim(), provider: 'vertex', model };
        }
      } catch (err) {
        console.warn('[LLM] Vertex AI lỗi:', err?.message || err);
      }
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
  console.warn('[LLM] Tất cả providers đều không khả dụng. Dùng static fallback.');
  return { answer: staticFallback(query), provider: 'static', model: 'rule-based' };
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

export default { ask, askWithContext, streamAsk, healthCheck, invokeLlm };
