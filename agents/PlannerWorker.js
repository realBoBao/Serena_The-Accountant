/**
 * PlannerWorker — OODA Task Planner (BullMQ Worker)
 *
 * Nhận job từ BullMQ queue → chạy PlannerAgent → trả kết quả.
 * Runs independently via PM2 + BullMQ worker.
 */

import { createWorker, addJob, JobType, QueueName } from '../lib/task_queue.js';
import { getLogger } from '../lib/logger.js';

const logger = getLogger('PlannerWorker');

let worker = null;

export async function start() {
  if (worker) return;

  worker = createWorker(
    QueueName.PRIORITY,
    async (job) => {
      const { name, data } = job;
      logger.info(`[PlannerWorker] Processing job: ${name}`);

      switch (name) {
        case JobType.PLAN_TASK:
          return await handlePlanTask(data);
        case JobType.EXECUTE_DAG:
          return await handleExecuteDag(data);
        default:
          return { skipped: true, reason: 'unknown_job_type' };
      }
    },
    { concurrency: 2 }
  );

  logger.info('[PlannerWorker] Started');
}

async function handlePlanTask(data) {
  const { query, userId, context } = data;
  try {
    const { default: PlannerAgent } = await import('./PlannerAgent.js');
    const agent = new PlannerAgent({
      apiKey: process.env.OPENROUTER_API_KEY,
      model: process.env.OPENROUTER_MODEL_NAME || 'openrouter/auto',
    });
    const result = await agent.plan(query, { userId, context });
    return { success: true, dag: result };
  } catch (err) {
    logger.error('[PlannerWorker] Plan task failed:', err.message);
    return { success: false, error: err.message };
  }
}

async function handleExecuteDag(data) {
  const { dag, userId } = data;
  try {
    const { default: PlannerAgent } = await import('./PlannerAgent.js');
    const agent = new PlannerAgent({
      apiKey: process.env.OPENROUTER_API_KEY,
      model: process.env.OPENROUTER_MODEL_NAME || 'openrouter/auto',
    });
    const result = await agent.executeDag(dag, { userId });
    return { success: true, results: result };
  } catch (err) {
    logger.error('[PlannerWorker] Execute DAG failed:', err.message);
    return { success: false, error: err.message };
  }
}

export async function stop() {
  if (worker) {
    await worker.close();
    worker = null;
    logger.info('[PlannerWorker] Stopped');
  }
}

// Auto-start when run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  start().catch(err => {
    logger.error('[PlannerWorker] Start failed:', err.message);
    process.exit(1);
  });
}

export default { start, stop };
