/**
 * ═══════════════════════════════════════════════════════════════
 * Work Stealing Scheduler — Deque-based Task Scheduling
 * ═══════════════════════════════════════════════════════════════
 *
 * Bí mật đằng sau Goroutines (Golang), Tokio (Rust), Fork/Join (Java).
 *
 * Kiến trúc:
 * ┌─────────────────────────────────────────────────────────────┐
 * │  Thread Pool (N workers = CPU cores)                        │
 * │                                                             │
 * │  Worker 0    Worker 1    Worker 2    Worker 3               │
 * │  ┌──────┐   ┌──────┐   ┌──────┐   ┌──────┐               │
 * │  │Deque │   │Deque │   │Deque │   │Deque │               │
 * │  │ ↑push│   │ ↑push│   │ ↑push│   │ ↑push│  ← Owner pops │
 * │  │ ↓pop │   │ ↓pop │   │ ↓pop │   │ ↓pop │  ← Owner pops │
 * │  │ ↓steal│  │ ↓steal│  │ ↓steal│  │ ↓steal│ ← Thief steals│
 * │  └──────┘   └──────┘   └──────┘   └──────┘               │
 * │                                                             │
 * │  Idle workers "steal" from the BOTTOM of busy workers       │
 * └─────────────────────────────────────────────────────────────┘
 *
 * @author Serena_Project00
 */

import { getLogger } from './logger.js';
import os from 'os';

const logger = getLogger('WorkStealer');

// ═══════════════════════════════════════════════════════════
//  Deque — Double-ended queue with lock-free operations
// ═══════════════════════════════════════════════════════════

class Deque {
  constructor() {
    this._tasks = [];
    this._top = 0;    // Owner pops from here (LIFO — hot cache)
    this._bottom = 0; // Thief steals from here (FIFO — cold cache)
  }

  /**
   * Push task to the top (owner only). O(1).
   */
  push(task) {
    this._tasks.push(task);
    this._bottom++;
  }

  /**
   * Pop task from the top (owner only). O(1). LIFO.
   * Returns undefined if empty.
   */
  pop() {
    if (this._top >= this._bottom) return undefined;
    this._bottom--;
    return this._tasks.pop();
  }

  /**
   * Steal task from the bottom (other workers). O(1). FIFO.
   * Returns undefined if empty.
   */
  steal() {
    if (this._top >= this._bottom) return undefined;
    const task = this._tasks[this._top - (this._tasks.length - this._bottom)];
    this._top++;
    return task;
  }

  get size() {
    return Math.max(0, this._bottom - this._top);
  }

  get isEmpty() {
    return this._top >= this._bottom;
  }
}

// ═══════════════════════════════════════════════════════════
//  WorkStealingScheduler — Main scheduler
// ═══════════════════════════════════════════════════════════

export class WorkStealingScheduler {
  /**
   * @param {Object} opts
   * @param {number} [opts.numWorkers] — Number of workers (default: CPU cores)
   * @param {Function} opts.taskRunner — async function(task) => result
   * @param {number} [opts.stealAttempts=3] — Max steal attempts before idle wait
   */
  constructor({
    numWorkers = os.cpus().length,
    taskRunner,
    stealAttempts = 3,
  } = {}) {
    this.numWorkers = numWorkers;
    this.taskRunner = taskRunner;
    this.stealAttempts = stealAttempts;

    // Each worker has its own Deque
    this.deques = Array.from({ length: numWorkers }, () => new Deque());

    // Worker states
    this.workers = Array.from({ length: numWorkers }, (_, i) => ({
      id: i,
      status: 'idle', // idle | busy | stealing | waiting
      tasksCompleted: 0,
      tasksStolen: 0,
      stealFailures: 0,
    }));

    // Global task counter
    this.totalTasks = 0;
    this.completedTasks = 0;
    this.failedTasks = 0;

    // Results storage
    this.results = new Map();

    // Running state
    this._running = false;
    this._resolveIdle = null;
  }

  /**
   * Submit a task to the scheduler.
   * Task is pushed to the least-loaded worker's deque.
   *
   * @param {Object} task — { id, fn, args, priority, dependsOn }
   * @returns {Promise} Resolves with task result
   */
  submit(task) {
    return new Promise((resolve, reject) => {
      const wrappedTask = {
        id: task.id || `task-${this.totalTasks++}`,
        fn: task.fn,
        args: task.args || [],
        priority: task.priority || 0,
        dependsOn: task.dependsOn || [],
        resolve,
        reject,
        submittedAt: Date.now(),
        startedAt: null,
        completedAt: null,
      };

      // Find least-loaded worker
      let minSize = Infinity;
      let targetWorker = 0;
      for (let i = 0; i < this.numWorkers; i++) {
        if (this.deques[i].size < minSize) {
          minSize = this.deques[i].size;
          targetWorker = i;
        }
      }

      this.deques[targetWorker].push(wrappedTask);
      logger.debug(`[WorkStealer] Task ${wrappedTask.id} → Worker ${targetWorker} (queue: ${minSize + 1})`);
    });
  }

  /**
   * Submit multiple tasks and wait for all to complete.
   * Handles dependency ordering automatically.
   *
   * @param {Array} tasks — Array of { id, fn, args, dependsOn }
   * @returns {Map} taskId → result
   */
  async submitAll(tasks) {
    const resultMap = new Map();
    const taskMap = new Map();
    const pendingTasks = new Set(tasks.map(t => t.id));

    // Build dependency graph
    const depGraph = new Map();
    for (const task of tasks) {
      depGraph.set(task.id, task.dependsOn || []);
    }

    // Submit tasks in topological order
    const completed = new Set();
    const inProgress = new Set();

    const submitReady = () => {
      for (const task of tasks) {
        if (completed.has(task.id) || inProgress.has(task.id)) continue;

        const deps = depGraph.get(task.id) || [];
        const allDepsDone = deps.every(d => completed.has(d));

        if (allDepsDone) {
          inProgress.add(task.id);

          // Wrap the task function to capture result
          const originalFn = task.fn;
          task.fn = async (...args) => {
            const result = await originalFn(...args);
            completed.add(task.id);
            inProgress.delete(task.id);
            resultMap.set(task.id, { success: true, result });
            // Submit newly ready tasks
            submitReady();
            return result;
          };

          this.submit(task);
        }
      }
    };

    submitReady();

    // Wait for all tasks to complete
    while (completed.size < tasks.length) {
      await new Promise(r => setTimeout(r, 10));
    }

    return resultMap;
  }

  /**
   * Start the scheduler. Workers begin processing tasks.
   */
  async start() {
    if (this._running) return;
    this._running = true;

    logger.info(`[WorkStealer] Starting ${this.numWorkers} workers`);

    // Start all workers
    const workerPromises = [];
    for (let i = 0; i < this.numWorkers; i++) {
      workerPromises.push(this._workerLoop(i));
    }

    // Wait for all workers to finish (when stop() is called)
    this._idlePromise = new Promise(resolve => {
      this._resolveIdle = resolve;
    });

    await Promise.all(workerPromises);
  }

  /**
   * Stop the scheduler gracefully.
   */
  async stop() {
    this._running = false;
    if (this._resolveIdle) this._resolveIdle();
    logger.info(`[WorkStealer] Stopped — completed: ${this.completedTasks}, failed: ${this.failedTasks}`);
  }

  /**
   * Worker main loop: pop own tasks → steal from others → idle wait.
   */
  async _workerLoop(workerId) {
    const deque = this.deques[workerId];
    const worker = this.workers[workerId];

    while (this._running) {
      let task = null;

      // 1. Try to pop from own deque (LIFO — hot cache)
      task = deque.pop();

      // 2. If empty, try to steal from other workers (FIFO — cold cache)
      if (!task) {
        worker.status = 'stealing';
        task = this._stealFromOthers(workerId);
      }

      // 3. If still no task, wait briefly
      if (!task) {
        worker.status = 'waiting';
        await this._idleWait();
        continue;
      }

      // 4. Execute task
      worker.status = 'busy';
      task.startedAt = Date.now();

      try {
        const result = await this.taskRunner(task);
        task.completedAt = Date.now();
        task.resolve(result);
        this.completedTasks++;
        worker.tasksCompleted++;

        const duration = task.completedAt - task.startedAt;
        logger.debug(`[WorkStealer] Worker ${workerId} completed ${task.id} in ${duration}ms`);
      } catch (err) {
        task.completedAt = Date.now();
        task.reject(err);
        this.failedTasks++;
        logger.error(`[WorkStealer] Worker ${workerId} failed ${task.id}: ${err.message}`);
      }
    }

    worker.status = 'idle';
  }

  /**
   * Steal a task from another worker's deque (from the bottom).
   */
  _stealFromOthers(thiefId) {
    // Try stealing from the busiest worker first
    let maxSize = 0;
    let victimId = -1;

    for (let i = 0; i < this.numWorkers; i++) {
      if (i === thiefId) continue;
      if (this.deques[i].size > maxSize) {
        maxSize = this.deques[i].size;
        victimId = i;
      }
    }

    if (victimId === -1) return null;

    const stolen = this.deques[victimId].steal();
    if (stolen) {
      this.workers[thiefId].tasksStolen++;
      logger.debug(`[WorkStealer] Worker ${thiefId} stole ${stolen.id} from Worker ${victimId}`);
    } else {
      this.workers[thiefId].stealFailures++;
    }

    return stolen;
  }

  /**
   * Wait for new tasks (with exponential backoff).
   */
  async _idleWait() {
    // Short busy-wait first (for low latency), then yield
    for (let i = 0; i < 10; i++) {
      // Check if any deque has work
      for (const deque of this.deques) {
        if (!deque.isEmpty) return;
      }
      // Yield to event loop
      await new Promise(r => setImmediate(r));
    }

    // Longer wait with timeout
    return new Promise(resolve => {
      const timer = setTimeout(resolve, 50);
      if (timer.unref) timer.unref();

      // Also resolve when new tasks arrive
      if (this._resolveIdle) {
        const prev = this._resolveIdle;
        this._resolveIdle = () => {
          prev();
          resolve();
        };
      }
    });
  }

  // ── Stats ─────────────────────────────────────────────────

  getStats() {
    const queueSizes = this.deques.map(d => d.size);
    const totalQueued = queueSizes.reduce((a, b) => a + b, 0);

    return {
      numWorkers: this.numWorkers,
      running: this._running,
      totalTasks: this.totalTasks,
      completedTasks: this.completedTasks,
      failedTasks: this.failedTasks,
      queuedTasks: totalQueued,
      queueSizes,
      workers: this.workers.map(w => ({
        id: w.id,
        status: w.status,
        completed: w.tasksCompleted,
        stolen: w.tasksStolen,
        stealFailures: w.stealFailures,
      })),
    };
  }
}

export { Deque };
