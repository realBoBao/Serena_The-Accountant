/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AgentWorker — Worker xử lý agent jobs từ queue:priority
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Nhận jobs từ PlannerAgent → gọi agent tương ứng → lưu kết quả vào session.
 *
 * Job format: {
 *   sessionId, step, agent, action,
 *   originalRequest, dependencyResults
 * }
 */

'use strict';

import { createWorker, QueueName, getConnection } from '../lib/task_queue.js';
import { getSession, saveStepResult, updateSession } from '../lib/session_store.js';
import { PlannerAgent } from './PlannerAgent.js';
import { getLogger } from '../lib/logger.js';

const logger = getLogger('AgentWorker');

// ─── Agent Registry (lazy load) ─────────────────────────────────────────────

const AGENT_REGISTRY = {
  RagAgent:       () => import('./RagAgent.js'),
  CoderAgent:     () => import('./CoderAgent.js'),
  VisionAgent:    () => import('./VisionAgent.js'),
  VoiceAgent:     () => import('./VoiceAgent.js'),
  PdfAgent:       () => import('./PdfAgent.js'),
  DebateAgent:    () => import('./DebateAgent.js'),
  ManimAgent:     () => import('./ManimAgent.js'),
  FlashcardAgent: () => import('./PdfAgent.js'), // PdfAgent handles flashcards
  EvoAgent:       () => import('./EvoAgent.js'),
  GraphAgent:     () => import('./GraphAgent.js'),
};

const AGENT_FN_MAP = {
  RagAgent:       'answerQuestion',
  CoderAgent:     'solveWithDebugLoop',
  VisionAgent:    'analyzeImageBuffer',
  VoiceAgent:     'processVoiceMessage',
  PdfAgent:       'processPdf',
  DebateAgent:    'runDebate',
  ManimAgent:     'createAnimationAsync',
  FlashcardAgent: 'processPdf',
  // EvoAgent & GraphAgent are standalone PM2 services — not called via AgentWorker
  // They process jobs from their own BullMQ queues (EVOLUTION, GRAPH)
  EvoAgent:       null,  // Not dispatched via AgentWorker
  GraphAgent:     null,  // Not dispatched via AgentWorker
};

// Cache loaded modules
const _moduleCache = {};

async function loadAgent(agentName) {
  if (_moduleCache[agentName]) return _moduleCache[agentName];
  const loader = AGENT_REGISTRY[agentName];
  if (!loader) throw new Error(`Unknown agent: ${agentName}`);
  const mod = await loader();
  _moduleCache[agentName] = mod;
  return mod;
}

// ─── Job Processor ──────────────────────────────────────────────────────────

async function processAgentJob(job) {
  const { sessionId, step, agent, action, originalRequest, dependencyResults } = job.data;

  logger.info(`[AgentWorker] Processing: session=${sessionId} step=${step} agent=${agent} action=${action}`);

  // Update session status
  await updateSession(sessionId, { currentStep: step, status: 'executing' });

  try {
    // Load agent module
    const mod = await loadAgent(agent);
    const fnName = AGENT_FN_MAP[agent];

    // Skip agents that are standalone PM2 services (EvoAgent, GraphAgent)
    if (fnName === null) {
      logger.info(`[AgentWorker] Skipping standalone agent: ${agent} (runs as PM2 service)`);
      const result = { skipped: true, reason: 'standalone_pm2_service', agent };
      await saveStepResult(sessionId, step, { agent, action, result, completedAt: new Date().toISOString() });
      await updateSession(sessionId, { status: 'waiting_for_planner' });
      return { sessionId, step, agent, status: 'skipped' };
    }

    const fn = mod[fnName];
    if (!fn) {
      throw new Error(`Agent '${agent}' does not export '${fnName}'`);
    }

    // Build context
    const context = {
      query: originalRequest?.content || '',
      action,
      dependencyResult: dependencyResults,
      sessionId,
      step,
    };

    // Execute agent — special cases for agents that need raw buffers
    let result;
    if (agent === 'VisionAgent') {
      // VisionAgent needs imageBuffer + mimeType + prompt
      const imageBuffer = originalRequest?._imageBuffer;
      const mimeType = originalRequest?._mimeType || 'image/png';
      const prompt = originalRequest?.content || '';
      if (!imageBuffer) {
        throw new Error('VisionAgent requires imageBuffer in originalRequest._imageBuffer');
      }
      result = await fn(imageBuffer, mimeType, prompt);
    } else if (agent === 'VoiceAgent') {
      // VoiceAgent needs audioBuffer + options
      const audioBuffer = originalRequest?._audioBuffer;
      const options = originalRequest?._audioOptions || {};
      if (!audioBuffer) {
        throw new Error('VoiceAgent requires audioBuffer in originalRequest._audioBuffer');
      }
      result = await fn(audioBuffer, options);
    } else {
      // Standard agents: fn(query, options)
      result = await fn(context.query, {
        action,
        dependencyResult: dependencyResults,
        sessionId,
        step,
      });
    }

    // Save result to session
    await saveStepResult(sessionId, step, {
      agent,
      action,
      result,
      completedAt: new Date().toISOString(),
    });

    await updateSession(sessionId, { status: 'waiting_for_planner' });

    logger.info(`[AgentWorker] Step ${step} (${agent}) completed for session ${sessionId}`);

    // Trigger OODA loop
    const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
    if (OPENROUTER_API_KEY) {
      const { PlannerAgent: PA } = await import('./PlannerAgent.js');
      const planner = new PA({
        apiKey: OPENROUTER_API_KEY,
        baseURL: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
        model: process.env.LLM_MODEL || 'openrouter/auto',
      });
      // Fire-and-forget OODA loop
      planner.onWorkerComplete(sessionId, step, result).catch((err) => {
        logger.error(`[AgentWorker] OODA trigger failed: ${err.message}`);
      });
    }

    return { sessionId, step, agent, status: 'completed' };
  } catch (err) {
    logger.error(`[AgentWorker] Step ${step} (${agent}) failed: ${err.message}`);

    await saveStepResult(sessionId, step, {
      agent,
      action,
      error: err.message,
      failed: true,
      failedAt: new Date().toISOString(),
    });

    throw err; // BullMQ retry
  }
}

// ─── Worker Setup ───────────────────────────────────────────────────────────

let worker;
(async () => {
  worker = await createWorker(
    QueueName.PRIORITY,
    async (job) => {
      return processAgentJob(job);
    },
    {
      concurrency: 3,
      limiter: { max: 10, duration: 1000 },
    }
  );

  worker.on('completed', (job, result) => {
    logger.info(`[AgentWorker] Job ${job.id} completed: session=${result?.sessionId} step=${result?.step}`);
  });

  worker.on('failed', (job, err) => {
    logger.error(`[AgentWorker] Job ${job?.id} failed: ${err.message}`);
  });

  worker.on('error', (err) => {
    logger.error(`[AgentWorker] Worker error: ${err.message}`);
  });

  console.log('[AgentWorker] Worker started on queue:priority');
})();

// ─── Graceful Shutdown ──────────────────────────────────────────────────────

async function shutdown(signal) {
  logger.info(`[AgentWorker] Received ${signal}. Shutting down...`);
  await worker.close();
  const conn = getConnection();
  if (conn) await conn.quit();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

logger.info('[AgentWorker] Started ✅ — Listening on queue:priority');
