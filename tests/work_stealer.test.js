/**
 * ═══════════════════════════════════════════════════════════════
 * Work Stealing Scheduler Unit Tests
 * ═══════════════════════════════════════════════════════════════
 */

import { describe, it, expect } from '@jest/globals';
import { WorkStealingScheduler, Deque } from '../lib/work_stealer.js';

describe('Deque', () => {
  it('should push and pop (LIFO)', () => {
    const d = new Deque();
    d.push('a');
    d.push('b');
    d.push('c');

    expect(d.pop()).toBe('c');
    expect(d.pop()).toBe('b');
    expect(d.pop()).toBe('a');
    expect(d.pop()).toBeUndefined();
  });

  it('should steal from bottom (FIFO)', () => {
    const d = new Deque();
    d.push('a');
    d.push('b');
    d.push('c');

    expect(d.steal()).toBe('a');
    expect(d.steal()).toBe('b');
    expect(d.steal()).toBe('c');
    expect(d.steal()).toBeUndefined();
  });

  it('should handle mixed pop and steal', () => {
    const d = new Deque();
    d.push('a');
    d.push('b');
    d.push('c');
    d.push('d');

    expect(d.pop()).toBe('d');    // Owner pops top
    expect(d.steal()).toBe('a');  // Thief steals bottom
    expect(d.pop()).toBe('c');    // Owner pops top
    expect(d.steal()).toBe('b');  // Thief steals bottom
  });

  it('should report size correctly', () => {
    const d = new Deque();
    expect(d.size).toBe(0);
    expect(d.isEmpty).toBe(true);

    d.push('a');
    expect(d.size).toBe(1);

    d.push('b');
    expect(d.size).toBe(2);

    d.pop();
    expect(d.size).toBe(1);

    d.steal();
    expect(d.size).toBe(0);
    expect(d.isEmpty).toBe(true);
  });
});

describe('WorkStealingScheduler', () => {
  it('should execute a single task', async () => {
    const scheduler = new WorkStealingScheduler({
      numWorkers: 2,
      taskRunner: async (task) => {
        return task.args[0] * 2;
      },
    });

    // Start scheduler in background
    scheduler.start().catch(() => {});

    // Wait for workers to be ready
    await new Promise(r => setTimeout(r, 50));

    const result = await scheduler.submit({
      id: 'test-1',
      fn: (x) => x * 2,
      args: [5],
    });

    const taskResult = await result;
    await scheduler.stop();

    expect(taskResult).toBe(10);
  }, 10000);

  it('should track stats', () => {
    const scheduler = new WorkStealingScheduler({
      numWorkers: 4,
      taskRunner: async () => {},
    });

    const stats = scheduler.getStats();
    expect(stats.numWorkers).toBe(4);
    expect(stats.queueSizes).toHaveLength(4);
    expect(stats.queueSizes.every(s => s === 0)).toBe(true);
  });

  it('should track stats correctly', async () => {
    const scheduler = new WorkStealingScheduler({
      numWorkers: 2,
      taskRunner: async (task) => {
        await new Promise(r => setTimeout(r, 10));
        return `result-${task.id}`;
      },
    });

    // Submit tasks directly to deques without starting the scheduler loop
    scheduler.deques[0].push({
      id: 'direct-1',
      fn: () => {},
      args: [],
      resolve: () => {},
      reject: () => {},
      submittedAt: Date.now(),
    });
    scheduler.deques[0].push({
      id: 'direct-2',
      fn: () => {},
      args: [],
      resolve: () => {},
      reject: () => {},
      submittedAt: Date.now(),
    });

    expect(scheduler.deques[0].size).toBe(2);
    expect(scheduler.deques[1].size).toBe(0);

    // Pop one task
    const task = scheduler.deques[0].pop();
    expect(task.id).toBe('direct-2');
    expect(scheduler.deques[0].size).toBe(1);

    // Steal from worker 0's deque (has 1 task remaining)
    const stolen = scheduler._stealFromOthers(1);
    expect(stolen).not.toBeNull();
    expect(stolen.id).toBe('direct-1');
    expect(scheduler.deques[0].size).toBe(0);
  });
});
