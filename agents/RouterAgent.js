/**
 * Router Agent — Trung tâm điều phối tất cả Agents
 *
 * Nguyên tắc "Agent-in-the-loop":
 * - Mọi yêu cầu từ Discord/Voice/Vision phải đi qua Router trước
 * - Router quyết định Agent nào được phép "thức dậy"
 * - Agent không được tự ý gọi nhau vô tận
 * - Hỗ trợ State Toggle: bật/tắt từng agent từ Admin Dashboard
 *
 * Usage: import { routerAgent } from './RouterAgent.js'
 */

import { getLogger } from '../lib/logger.js';
import { classifyIntentLocal, classifyIntentLlm } from '../lib/edge_router.js';
import { info, warn } from '../lib/structured_logger.js';
import { searchPointers, fetchPointerContent } from '../lib/lazy_knowledge.js';
import { isEnabled, setEnabled, getAll as getAllFlags } from '../lib/feature_flags.js';
import { detectPersona, shouldSkipRag, getPersonaSystemPrompt } from '../lib/persona_router.js';

const logger = getLogger('RouterAgent');

// ── Agent Registry ──
// Đăng ký tất cả agents với metadata
const AGENT_REGISTRY = {
  rag: {
    name: 'RagAgent',
    description: 'RAG-powered Q&A, web search, knowledge retrieval',
    import: () => import('./RagAgent.js'),
    enabled: true,  // Có thể toggle từ Dashboard
    cost: 'medium', // Token cost: low/medium/high
  },
  pdf: {
    name: 'PdfAgent',
    description: 'PDF processing, text extraction, flashcard generation',
    import: () => import('./PdfAgent.js'),
    enabled: true,
    cost: 'high',
  },
  debate: {
    name: 'DebateAgent',
    description: 'Multi-agent debate (Coder vs Rag → Judge)',
    import: () => import('./DebateAgent.js'),
    enabled: true,
    cost: 'high',
  },
  manim: {
    name: 'ManimAgent',
    description: 'AI animation video generation via Manim',
    import: () => import('./ManimAgent.js'),
    enabled: true,
    cost: 'high',
  },
  interaction: {
    name: 'InteractionAgent',
    description: 'Discord interaction tracking, Markov prediction',
    import: () => import('./InteractionAgent.js'),
    enabled: true,
    cost: 'low',
  },
  vision: {
    name: 'VisionAgent',
    description: 'Image analysis via Gemini Vision',
    import: () => import('./VisionAgent.js'),
    enabled: true,
    cost: 'medium',
  },
  voice: {
    name: 'VoiceAgent',
    description: 'Voice message transcription via whisper.cpp',
    import: () => import('./VoiceAgent.js'),
    enabled: true,
    cost: 'low',
  },
  planner: {
    name: 'PlannerAgent',
    description: 'DAG Task Planner — analyzes intent and creates task graphs',
    import: () => import('./PlannerAgent.js'),
    enabled: true,
    cost: 'medium',
  },
  coder: {
    name: 'CoderAgent',
    description: 'Algorithm expert — write, run, debug code with AddressSanitizer',
    import: () => import('./CoderAgent.js'),
    enabled: true,
    cost: 'high',
  },
  analysis: {
    name: 'AnalysisAgent',
    description: 'URL analyzer — GitHub repo, YouTube video, web page → summary + flashcards',
    import: () => import('./AnalysisAgent.js'),
    enabled: true,
    cost: 'high',
  },
  security: {
    name: 'SecurityAuditor',
    description: 'Security audit — secrets detection, vulnerability scan, unsafe functions',
    import: () => import('./SecurityAuditor.js'),
    enabled: true,
    cost: 'low',
  },
  suggestion: {
    name: 'SuggestionAgent',
    description: 'Learning suggestions — recommends topics, flashcards, study paths',
    import: () => import('./SuggestionAgent.js'),
    enabled: true,
    cost: 'low',
  },
  // ── Persona Agent (Tier 1: Lightweight, no RAG) ──
  persona: {
    name: 'PersonaAgent',
    description: 'Lightweight persona responses — therapist, casual chat (no RAG)',
    import: () => import('./PersonaAgent.js'),
    enabled: true,
    cost: 'low',
  },

  // ── Shadow Agents (Tier 2: Dark Traffic) ──
  // Shadow agents chạy song song với primary khi SHADOW_MODE=true.
  // Chúng KHÔNG nhận traffic chính — chỉ fork từ primary.
  rag_v2: {
    name: 'RagAgent (Shadow)',
    description: 'RAG v2 — shadow copy for dark traffic comparison',
    import: () => import('./RagAgent.js'),  // Cùng module, khác prompt/params
    enabled: false,  // Bật khi muốn test
    cost: 'medium',
    isShadow: true,
  },
  coder_v2: {
    name: 'CoderAgent (Shadow)',
    description: 'Coder v2 — shadow copy for dark traffic comparison',
    import: () => import('./CoderAgent.js'),
    enabled: false,
    cost: 'high',
    isShadow: true,
  },
};

// ── Intent → Agent Mapping ──
// Mỗi intent chỉ được route đến agent đã đăng ký
const INTENT_AGENT_MAP = {
  RAG: ['rag'],
  CODE: ['coder'],
  MEMORY: ['rag'],
  PDF: ['pdf'],
  DEBATE: ['debate'],
  ANIMATE: ['manim'],
  INTERACTION: ['interaction'],
  VISION: ['vision'],
  VOICE: ['voice'],
  CHAT: ['rag'],
  PLANNER: ['planner'],
  VISION_PLANNER: ['vision'],
  ANALYZE: ['analysis'],
  // ── Persona Routing (Tier 1) ──
  THERAPIST: ['persona'],
  TECHNICAL: ['rag'],
};

// ── Shadow Launching Registry ──
// Map: primary agent → shadow agent key (chạy song song khi SHADOW_MODE=true)
const SHADOW_MAP = {
  rag: 'rag_v2',    // RagAgent v1 (primary) vs v2 (shadow)
  coder: 'coder_v2',
};

class RouterAgent {
  constructor() {
    this._agentCache = new Map();  // Lazy-loaded agent modules
    this._stats = {
      totalRequests: 0,
      agentCalls: {},
      errors: 0,
      shadowComparisons: 0,
    };
    this._shadowEnabled = process.env.SHADOW_MODE === 'true';
    if (this._shadowEnabled) {
      info('RouterAgent', 'shadow launching enabled');
    }
  }

  // ── State Toggle API (cho Admin Dashboard) ──

  /**
   * Bật/tắt một agent
   * @param {string} agentKey - Key trong AGENT_REGISTRY (rag, pdf, debate, ...)
   * @param {boolean} enabled
   */
  setAgentState(agentKey, enabled) {
    if (!AGENT_REGISTRY[agentKey]) {
      throw new Error(`Unknown agent: ${agentKey}`);
    }
    AGENT_REGISTRY[agentKey].enabled = enabled;
    // Sync với feature flags
    setEnabled(agentKey, enabled);
    logger.info(`Agent ${agentKey} ${enabled ? 'ENABLED' : 'DISABLED'}`);
    return this.getAgentStates();
  }

  /**
   * Lấy trạng thái tất cả agents
   */
  getAgentStates() {
    const states = {};
    for (const [key, agent] of Object.entries(AGENT_REGISTRY)) {
      states[key] = {
        name: agent.name,
        enabled: agent.enabled,
        cost: agent.cost,
        description: agent.description,
        cached: this._agentCache.has(key),
      };
    }
    return states;
  }

  /**
   * Bật/tắt tất cả agents cùng lúc
   */
  setAllAgents(enabled) {
    for (const key of Object.keys(AGENT_REGISTRY)) {
      AGENT_REGISTRY[key].enabled = enabled;
    }
    logger.info(`All agents ${enabled ? 'ENABLED' : 'DISABLED'}`);
    return this.getAgentStates();
  }

  // ── Routing Core ──

  /**
   * Route request đến agent phù hợp
   * @param {string} intent - Intent type (RAG, CODE, PDF, DEBATE, ...)
   * @param {object} context - Request context { query, filePath, url, ... }
   * @returns {object} { result, agent, cached }
   */
  async route(intent, context = {}) {
    this._stats.totalRequests++;

    // ── Tier 1: Persona Routing — Override intent nếu phát hiện THERAPIST ──
    if (context.query && (intent === 'RAG' || intent === 'CHAT' || intent === 'MEMORY')) {
      const personaResult = detectPersona(context.query);
      if (personaResult.persona === 'THERAPIST' && personaResult.confidence > 0.8) {
        logger.info(`[RouterAgent] Persona override: ${intent} → THERAPIST (${personaResult.confidence.toFixed(2)})`);
        intent = 'THERAPIST';
        context.persona = personaResult;
      }
    }

    const agentKeys = INTENT_AGENT_MAP[intent];
    if (!agentKeys || agentKeys.length === 0) {
      logger.warn(`No agent mapped for intent: ${intent}`);
      return { result: null, agent: null, error: `No agent for intent: ${intent}` };
    }

    // Lấy agent đầu tiên enabled trong danh sách
    const agentKey = agentKeys.find(k => AGENT_REGISTRY[k]?.enabled);
    if (!agentKey) {
      logger.warn(`All agents disabled for intent: ${intent}`);
      return { result: null, agent: null, error: `All agents disabled for intent: ${intent}` };
    }

    const agent = AGENT_REGISTRY[agentKey];
    logger.info(`Routing intent "${intent}" → ${agent.name}`);

    try {
      // Lazy load agent module (chỉ import khi cần)
      const module = await this._loadAgent(agentKey);

      // Gọi agent function phù hợp
      const result = await this._dispatch(agentKey, module, intent, context);

      // ── Tier 1: Lazy Knowledge Pointers — enrich RAG with JIT content ──
      if (intent === 'RAG' || intent === 'CHAT' || intent === 'MEMORY') {
        try {
          const pointers = await searchPointers(context.query, 3);
          if (pointers.length > 0) {
            // JIT fetch content for top matching pointer
            const topPointer = pointers[0];
            if (topPointer.url) {
              const jitContent = await fetchPointerContent(topPointer);
              if (jitContent) {
                context.options = context.options || {};
                context.options.externalContext = [
                  `[${topPointer.repo}] ${topPointer.topic}:\n${jitContent.slice(0, 2000)}`,
                  ...(context.options.externalContext || []),
                ];
                logger.info(`[RouterAgent] Lazy knowledge: enriched with "${topPointer.topic}" from ${topPointer.repo}`);
              }
            }
          }
        } catch (err) {
          logger.debug(`[RouterAgent] Lazy knowledge search failed: ${err.message}`);
        }
      }

      // Update stats
      this._stats.agentCalls[agentKey] = (this._stats.agentCalls[agentKey] || 0) + 1;

      // ── Shadow Launching (Tier 2) ──
      // Nếu SHADOW_MODE=true và có shadow agent cho primary → fork background.
      // Shadow chạy async, không block response. Kết quả log vào structured log.
      if (this._shadowEnabled) {
        const shadowKey = SHADOW_MAP[agentKey];
        if (shadowKey && AGENT_REGISTRY[shadowKey]?.enabled) {
          this._runShadow(shadowKey, agentKey, intent, context, result).catch(() => {});
        }
      }

      return { result, agent: agentKey, cached: this._agentCache.has(agentKey) };
    } catch (err) {
      this._stats.errors++;
      logger.error(`Agent ${agentKey} failed: ${err.message}`);
      return { result: null, agent: agentKey, error: err.message };
    }
  }

  /**
   * Chạy shadow agent song song (fire-and-forget).
   * So sánh kết quả primary vs shadow và log structured.
   */
  async _runShadow(shadowKey, primaryKey, intent, context, primaryResult) {
    const startTime = Date.now();
    try {
      const shadowModule = await this._loadAgent(shadowKey);
      const shadowResult = await this._dispatch(shadowKey, shadowModule, intent, context);
      const latencyMs = Date.now() - startTime;

      // So sánh đơn giản: length diff + content diff indicator
      const primaryText = JSON.stringify(primaryResult ?? '');
      const shadowText = JSON.stringify(shadowResult ?? '');
      const lengthDiff = Math.abs(primaryText.length - shadowText.length);
      const identical = primaryText === shadowText;

      this._stats.shadowComparisons++;

      info('RouterAgent', 'shadow comparison', {
        intent,
        primary: primaryKey,
        shadow: shadowKey,
        identical,
        length_diff: lengthDiff,
        primary_length: primaryText.length,
        shadow_length: shadowText.length,
        shadow_latency_ms: latencyMs,
      });
    } catch (err) {
      warn('RouterAgent', 'shadow agent failed', {
        shadow: shadowKey,
        intent,
        error: err.message,
      });
    }
  }

  /**
   * Lazy load agent module (cache sau khi load)
   */
  async _loadAgent(agentKey) {
    if (this._agentCache.has(agentKey)) {
      return this._agentCache.get(agentKey);
    }

    const agent = AGENT_REGISTRY[agentKey];
    const module = await agent.import();
    this._agentCache.set(agentKey, module);
    logger.info(`Agent ${agent.name} loaded and cached`);
    return module;
  }

  /**
   * Dispatch đến function phù hợp trong agent module
   */
  async _dispatch(agentKey, module, intent, context) {
    switch (agentKey) {
      case 'rag':
        if (intent === 'RAG' || intent === 'CHAT' || intent === 'MEMORY') {
          return await module.answerQuestion(context.query, context.options || {});
        }
        return await module.answerQuestion(context.query, context.options || {});

      case 'pdf':
        return await module.processPdf(context.filePath);

      case 'debate': {
        const quick = context.quick || false;
        return quick
          ? await module.quickDebate(context.query)
          : await module.runDebate(context.query);
      }

      case 'manim': {
        const asyncRender = context.async || false;
        if (asyncRender) {
          return await module.createAnimationAsync(context.query);
        }
        const compress = context.compress || false;
        return compress
          ? await module.createAnimationWithCompression(context.query)
          : await module.createAnimation(context.query);
      }

      case 'interaction':
        return await module.handleInteraction(context.topic);

      case 'vision':
        if (process.env.ENABLE_VISION === 'false') {
          return { error: 'Vision Agent hiện đang bị tắt (ENABLE_VISION=false). Bật lại trong .env để sử dụng.' };
        }
        // VISION_PLANNER: describe image → return structured text for PlannerAgent
        if (intent === 'VISION_PLANNER') {
          return await module.describeImageForPlanner(context.imageBuffer, context.mimeType, context.query);
        }
        // VISION: full markdown analysis for user
        return await module.analyzeImageBuffer(context.imageBuffer, context.mimeType, context.prompt);

      case 'voice':
        if (process.env.ENABLE_VOICE === 'false') {
          return { error: 'Voice Agent hiện đang bị tắt (ENABLE_VOICE=false). Bật lại trong .env để sử dụng.' };
        }
        return await module.processVoiceMessage(context.audioBuffer, context.options);

      case 'manim':
        if (process.env.ENABLE_MANIM === 'false') {
          return { error: 'Manim Agent hiện đang bị tắt (ENABLE_MANIM=false). Bật lại trong .env để sử dụng.' };
        }
        // ... rest of manim handling

      case 'planner':
        return await module.createPlan({
          type: context.type || 'planner_request',
          content: context.query || '',
          context: context.context || '',
        });

      case 'coder':
        return await module.solveWithDebugLoop(context.query, {
          language: context.language || null,
          maxRetries: context.maxRetries ?? 2,
          runTests: context.runTests !== false,
        });

      // ── Persona Agent (Tier 1: Lightweight, no RAG) ──
      case 'persona':
        return await module.answerQuestion(context);

      default:
        throw new Error(`Unknown agent dispatch: ${agentKey}`);
    }
  }


  // ── Edge Routing (Tier 4): Intent classification bằng local model/keyword ──

  /**
   * Phân loại intent bằng edge router (local LLM hoặc keyword matching).
   * Không gọi Gemini API → tiết kiệm chi phí và giảm độ trễ.
   * @param {string} text — User input
   * @returns {Promise<string>} — Intent type
   */
  async classifyIntent(text) {
    // Thử local LLM trước (nếu có)
    const intent = await classifyIntentLlm(text);
    logger.debug(`[EdgeRouter] Intent: ${intent} for: ${text.slice(0, 50)}...`);
    return intent;
  }

  // ── Stats API (cho Admin Dashboard) ──

  getStats() {
    return {
      ...this._stats,
      agents: this.getAgentStates(),
      uptime: process.uptime(),
    };
  }

  resetStats() {
    this._stats = { totalRequests: 0, agentCalls: {}, errors: 0 };
  }
}

// Singleton
export const routerAgent = new RouterAgent();
