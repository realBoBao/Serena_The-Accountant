/**
 * Work Stealing Scheduler Unit Tests
 * Tests Deque + WorkStealingScheduler from lib/work_stealer.js
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
    expect(d.pop()).toBeNull();
  });

  it('should steal from bottom (FIFO)', () => {
    const d = new Deque();
    d.push('a');
    d.push('b');
    d.push('c');

    expect(d.steal()).toBe('a');
    expect(d.steal()).toBe('b');
    expect(d.steal()).toBe('c');
    expect(d.steal()).toBeNull();
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
    expect(d.empty).toBe(true);

    d.push('a');
    expect(d.size).toBe(1);

    d.push('b');
    expect(d.size).toBe(2);

    d.pop();
    expect(d.size).toBe(1);

    d.steal();
    expect(d.size).toBe(0);
    expect(d.empty).toBe(true);
  });
});

describe('WorkStealingScheduler', () => {
  it('should submit tasks to workers', () => {
    const scheduler = new WorkStealingScheduler(2);
    scheduler.submit('task1', 0);
    scheduler.submit('task2', 0);
    scheduler.submit('task3', 1);

    expect(scheduler.workers[0].size).toBe(2);
    expect(scheduler.workers[1].size).toBe(1);
  });

  it('should submit to random worker when no workerId', () => {
    const scheduler = new WorkStealingScheduler(4);
    for (let i = 0; i < 100; i++) {
      scheduler.submit(`task-${i}`);
    }

    const total = scheduler.workers.reduce((sum, w) => sum + w.size, 0);
    expect(total).toBe(100);
  });

  it('should run tasks with processor', async () => {
    const scheduler = new WorkStealingScheduler(2);
    const results = [];

    scheduler.submit('a', 0);
    scheduler.submit('b', 0);
    scheduler.submit('c', 1);

    await scheduler.run(async (task) => {
      results.push(task);
    });

    expect(results.sort()).toEqual(['a', 'b', 'c']);
  });

  it('should stop running', async () => {
    const scheduler = new WorkStealingScheduler(2);
    scheduler.submit('task1', 0);

    const runPromise = scheduler.run(async () => {
      scheduler.stop();
    });

    await runPromise;
    expect(scheduler.running).toBe(false);
  });

  it('should ignore invalid workerId', () => {
    const scheduler = new WorkStealingScheduler(2);
    scheduler.submit('task1', -1);
    scheduler.submit('task2', 99);

    const total = scheduler.workers.reduce((sum, w) => sum + w.size, 0);
    expect(total).toBe(2);
  });
});
