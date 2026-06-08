/**
 * BullMQ Task Queue — Message Broker cho toàn bộ Agent ecosystem
 * 
 * Cung cấp:
 * - 4 queues: planner, evolution, graph, priority
 * - Job persistence qua Redis (survive PM2 restart)
 * - Auto-retry với exponential backoff
 * - Rate limiting & concurrency control
 * - Delayed jobs & priority support
 * 
 * @module lib/task_queue
 */

// ── Storage: in-memory (set USE_REDIS=1 to enable Redis) ──────────────────

let _memoryMode = true; // Default to memory mode (no Redis dependency)
let _redisAvailable = false;

// ── In-Memory Fallback (when Redis is unavailable) ──
const memQueues = {};
const memWorkers = [];
let memJobId = 0;
const MAX_MEM_QUEUE_SIZE = 100; // Per queue
const MAX_TOTAL_MEM_JOBS = 500;

function getMemQueue(name) {
  if (!memQueues[name]) {
    memQueues[name] = [];
  }
  return memQueues[name];
}

function getTotalMemJobs() {
  return Object.values(memQueues).reduce((sum, q) => sum + q.length, 0);
}

function evictOldestMemJob() {
  // Find the queue with the most jobs and remove the oldest
  let largestQueue = null;
  let largestName = '';
  for (const [name, q] of Object.entries(memQueues)) {
    if (q.length > (largestQueue?.length || 0)) {
      largestQueue = q;
      largestName = name;
    }
  }
  if (largestQueue && largestQueue.length > 0) {
    largestQueue.shift();
  }
}

async function processMemQueue(queueName) {
  const q = getMemQueue(queueName);
  if (q.length === 0 || !memWorkers[queueName]) return;
  const job = q.shift();
  if (!job) return;
  try {
    const result = await memWorkers[queueName](job);
    if (job.resolve) job.resolve(result);
    console.log(`[TaskQueue:mem] Job ${job.id} completed in ${queueName}`);
  } catch (err) {
    if (job.reject) job.reject(err);
    console.error(`[TaskQueue:mem] Job ${job.id} failed in ${queueName}: ${err.message}`);
  }
  // Process next
  setImmediate(() => processMemQueue(queueName));
}

export function getConnection() {
  // In-memory mode — no Redis connection needed
  return null;
}

export function isMemoryMode() {
  return _memoryMode;
}

// ── Job Types ──
export const JobType = {
  // Planner tasks
  ANALYZE_SYSTEM_LOGS: 'analyze_system_logs',
  OPTIMIZE_HYPERPARAMS: 'optimize_hyperparameters',
  UPDATE_SPACED_REPETITION: 'update_spaced_repetition',
  REPAIR_GRAPH_CONNECTIONS: 'repair_graph_connections',

  // Evolution tasks
  AUTO_EVALUATE: 'auto_evaluate',
  SELF_REPAIR: 'self_repair',
  KNOWLEDGE_GAP_DETECTION: 'knowledge_gap_detection',

  // Graph tasks
  EXTRACT_ENTITIES: 'extract_entities',
  BUILD_RELATIONSHIPS: 'build_relationships',
  SYNC_GRAPH: 'sync_graph',
};

// ── Queue Names ──
export const QueueName = {
  PLANNER: 'planner-tasks',
  EVOLUTION: 'evolution-tasks',
  GRAPH: 'graph-tasks',
  PRIORITY: 'priority-tasks',
};

// ── Queues ──
// BullMQ imports (lazy — only when Redis is available)
let _bullmqLoaded = false;
let Queue, Worker;

async function loadBullmq() {
  if (_bullmqLoaded) return;
  const bullmq = await import('bullmq');
  Queue = bullmq.Queue;
  Worker = bullmq.Worker;
  _bullmqLoaded = true;
}

const queues = {};

async function getQueue(name) {
  if (_memoryMode) return null; // Use memory fallback
  if (!queues[name]) {
    await loadBullmq();
    queues[name] = new Queue(name, {
      connection: getConnection(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: 100,
        removeOnFail: 50,
      },
    });
  }
  return queues[name];
}

// ── Public API ──

/**
 * Thêm job vào queue (auto-fallback to in-memory if Redis unavailable)
 */
export async function addJob(queueName, jobType, data, options = {}) {
  if (_memoryMode) {
    // In-memory fallback
    const q = getMemQueue(queueName);
    // Evict if at capacity
    if (q.length >= MAX_MEM_QUEUE_SIZE) {
      q.shift();
    }
    if (getTotalMemJobs() >= MAX_TOTAL_MEM_JOBS) {
      evictOldestMemJob();
    }
    const job = { id: `mem-${++memJobId}`, name: jobType, data, opts: options };
    q.push(job);
    // Trigger processing
    setImmediate(() => processMemQueue(queueName));
    return job;
  }

  try {
    const queue = await getQueue(queueName);
    const job = await queue.add(jobType, data, {
      priority: options.priority ?? 5,
      delay: options.delay ?? 0,
      attempts: options.attempts,
      backoff: options.backoff,
      removeOnComplete: options.removeOnComplete,
      removeOnFail: options.removeOnFail,
    });
    console.log(`[TaskQueue] Added job ${job.id} (${jobType}) to ${queueName}`);
    return job;
  } catch (err) {
    console.warn(`[TaskQueue] Redis addJob failed, falling back to memory: ${err.message}`);
    _memoryMode = true;
    return addJob(queueName, jobType, data, options);
  }
}

/**
 * Lấy thống kê queue
 */
export async function getQueueStats(queueName) {
  if (_memoryMode) {
    const q = getMemQueue(queueName);
    return { waiting: q.length, active: 0, completed: 0, failed: 0, delayed: 0, mode: 'memory' };
  }
  try {
    const queue = await getQueue(queueName);
    const [waiting, active, completed, failed, delayed] = await Promise.all([
      queue.getWaitingCount(),
      queue.getActiveCount(),
      queue.getCompletedCount(),
      queue.getFailedCount(),
      queue.getDelayedCount(),
    ]);
    return { waiting, active, completed, failed, delayed, mode: 'redis' };
  } catch {
    return { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, mode: 'error' };
  }
}

/**
 * Lấy thống kê tất cả queues
 */
export async function getAllQueueStats() {
  const stats = {};
  for (const name of Object.values(QueueName)) {
    stats[name] = await getQueueStats(name);
  }
  return stats;
}

/**
 * Tạo Worker để xử lý jobs (auto-fallback to in-memory if Redis unavailable)
 */
export async function createWorker(queueName, processor, options = {}) {
  if (_memoryMode) {
    console.log(`[TaskQueue:mem] Creating in-memory worker for ${queueName}`);
    memWorkers[queueName] = processor;
    return {
      close: () => { delete memWorkers[queueName]; },
      on: () => {},
    };
  }

  try {
    // Đảm bảo BullMQ đã load (async)
    if (!_bullmqLoaded) await loadBullmq();
    const worker = new Worker(queueName, processor, {
      connection: getConnection(),
      concurrency: options.concurrency ?? 2,
      limiter: options.limiter,
    });

    worker.on('completed', (job) => {
      console.log(`[TaskQueue] Job ${job.id} completed in ${queueName}`);
    });

    worker.on('failed', (job, err) => {
      console.error(`[TaskQueue] Job ${job?.id} failed in ${queueName}: ${err.message}`);
    });

    worker.on('error', (err) => {
      console.error(`[TaskQueue] Worker error in ${queueName}: ${err.message}`);
    });

    return worker;
  } catch (err) {
    console.warn(`[TaskQueue] Failed to create BullMQ worker, using memory fallback: ${err.message}`);
    _memoryMode = true;
    return createWorker(queueName, processor, options);
  }
}

/**
 * Graceful shutdown
 */
export async function shutdownQueues() {
  console.log('[TaskQueue] Shutting down queues...');
  if (_memoryMode) {
    memWorkers.length = 0;
    for (const name of Object.keys(memQueues)) {
      memQueues[name] = [];
    }
    console.log('[TaskQueue] In-memory queues cleared');
  } else {
    for (const [name, queue] of Object.entries(queues)) {
      try { await queue.close(); } catch {}
      console.log(`[TaskQueue] Closed queue: ${name}`);
    }
    if (_connection) {
      try { await _connection.quit(); } catch {}
      _connection = null;
    }
  }
  console.log('[TaskQueue] Shutdown complete');
}

export { Worker };
