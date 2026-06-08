/**
 * ═══════════════════════════════════════════════════════════════════════════
 * PlannerWorker — Worker xử lý jobs từ queue:planner
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Nhận job 'init_session' từ InteractionAgent → gọi PlannerAgent.startSession()
 * → OODA loop → dispatch agent jobs → finalize.
 *
 * Chạy như PM2 service riêng biệt (AI_PlannerWorker).
 */

'use strict';

import { createWorker, QueueName, getConnection } from '../lib/task_queue.js';
import { PlannerAgent } from './PlannerAgent.js';
import { getLogger } from '../lib/logger.js';

const logger = getLogger('PlannerWorker');

// ─── Config ────────────────────────────────────────────────────────────────

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const OPENROUTER_BASE_URL = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
const LLM_MODEL = process.env.LLM_MODEL || 'openrouter/auto';
const LOCAL_LLM_URL = process.env.LOCAL_LLM_URL || 'http://127.0.0.1:3001';

// ─── Local LLM Fallback ─────────────────────────────────────────────────────

async function tryLocalLlm(systemPrompt, userMessage) {
  try {
    const res = await fetch(`${LOCAL_LLM_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'local',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        max_tokens: 1024,
        temperature: 0.2,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`Local LLM HTTP ${res.status}`);
    const data = await res.json();
    return data.choices?.[0]?.message?.content || null;
  } catch {
    return null;
  }
}

// ─── PlannerAgent Instance ──────────────────────────────────────────────────

const planner = new PlannerAgent({
  apiKey: OPENROUTER_API_KEY,
  baseURL: OPENROUTER_BASE_URL,
  model: LLM_MODEL,
  tryLocalLlm: tryLocalLlm,
});

// ─── Job Processor ──────────────────────────────────────────────────────────

/**
 * Xử lý job 'init_session' từ queue:planner.
 *
 * Job data: {
 *   session_id: string,
 *   source: string,
 *   user_id: string,
 *   username: string,
 *   channel_id: string,
 *   content: string,
 *   has_image: boolean,
 *   has_audio: boolean,
 *   is_admin: boolean,
 *   message_id: string|null,
 *   created_at: string,
 * }
 */
async function processInitSession(job) {
  const data = job.data;
  const sessionId = data.session_id;

  logger.info(`[PlannerWorker] Processing init_session: ${sessionId} (source=${data.source}, user=${data.username})`);

  try {
    let dag;
    let visionDescription = '';

    // Vision-First Planning: nếu có ảnh → gọi VisionAgent trước rồi plan
    if (data.has_image && data._imageBuffer) {
      logger.info(`[PlannerWorker] Vision-first planning for session ${sessionId}`);

      const { PlannerAgent: PA } = await import('./PlannerAgent.js');
      const visionPlan = await PA.createVisionFirstPlan({
        apiKey: OPENROUTER_API_KEY,
        baseURL: OPENROUTER_BASE_URL,
        model: LLM_MODEL,
        imageBuffer: data._imageBuffer,
        mimeType: data._mimeType || 'image/png',
        userRequest: data.content,
        tryLocalLlm: tryLocalLlm,
      });

      dag = visionPlan.dag;
      visionDescription = visionPlan.visionDescription;

      logger.info(`[PlannerWorker] Vision-first plan created: ${dag.length} steps, vision="${visionDescription.slice(0, 80)}..."`);
    }

    // Gọi PlannerAgent để tạo DAG (hoặc dùng vision-first DAG) và bắt đầu OODA loop
    const session = await planner.startSession(sessionId, {
      type: data.source,
      content: data.content,
      context: JSON.stringify({
        source: data.source,
        userId: data.user_id,
        username: data.username,
        channelId: data.channel_id,
        hasImage: data.has_image,
        hasAudio: data.has_audio,
        isAdmin: data.is_admin,
        messageId: data.message_id,
        visionDescription, // Planner dùng để enrich context
      }),
    });

    // Nếu có vision-first DAG → override DAG của session
    if (dag) {
      const { updateSession } = await import('../lib/session_store.js');
      await updateSession(sessionId, { dag, visionDescription });
      session.dag = dag;
      session.visionDescription = visionDescription;
    }

    logger.info(`[PlannerWorker] Session ${sessionId} planned. DAG steps: ${session.dag?.length || 0}`);

    return {
      sessionId,
      status: session.status,
      dag: session.dag,
      visionDescription,
    };
  } catch (err) {
    logger.error(`[PlannerWorker] Failed to process session ${sessionId}: ${err.message}`);
    throw err; // BullMQ sẽ retry
  }
}

// ─── Worker Setup ───────────────────────────────────────────────────────────

let worker;
(async () => {
  worker = await createWorker(
    QueueName.PLANNER,
    async (job) => {
      switch (job.name) {
        case 'init_session':
          return processInitSession(job);

        default:
          logger.warn(`[PlannerWorker] Unknown job type: ${job.name}`);
          return { error: `Unknown job type: ${job.name}` };
      }
    },
    {
      concurrency: 2,
      limiter: { max: 5, duration: 1000 },
    }
  );

  worker.on('completed', (job, result) => {
    logger.info(`[PlannerWorker] Job ${job.id} completed: session=${result?.sessionId}`);
  });

  worker.on('failed', (job, err) => {
    logger.error(`[PlannerWorker] Job ${job?.id} failed: ${err.message}`);
  });

  worker.on('error', (err) => {
    logger.error(`[PlannerWorker] Worker error: ${err.message}`);
  });

  console.log('[PlannerWorker] Worker started on queue:planner');
})();

// ─── Graceful Shutdown ──────────────────────────────────────────────────────

async function shutdown(signal) {
  logger.info(`[PlannerWorker] Received ${signal}. Shutting down gracefully...`);
  if (worker) await worker.close();
  const conn = getConnection();
  if (conn) await conn.quit();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

logger.info('[PlannerWorker] Started ✅ — Listening on queue:planner');
