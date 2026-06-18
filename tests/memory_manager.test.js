import fs from 'fs';
import path from 'path';
import os from 'os';
import { describe, it, expect, afterAll } from '@jest/globals';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-test-'));
const TEST_DB = path.join(TMP_DIR, 'test.db');

// Override DB_PATH env so memory_manager uses our temp DB
process.env.DB_PATH = TEST_DB;

import { addMemory, getRecentMemory, searchMemory, getArchivedMemory } from '../lib/memory_manager.js';

describe('memory_manager.getMemoryDb regression', () => {
  it('should create schema on cold start and insert/read', async () => {
    const id = `test-${Date.now()}`;
    await addMemory({
      id,
      type: 'memory',
      source: 'jest',
      sourceUrl: 'http://localhost',
      content: 'hello world',
      tags: ['t1'],
      createdAt: new Date().toISOString(),
    });

    const items = await getRecentMemory(1);
    expect(Array.isArray(items)).toBe(true);
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items[0].content).toBe('hello world');
  });

  it('should survive repeated reads (no SQLITE_MISUSE)', async () => {
    const a = await getRecentMemory(7);
    const b = await getRecentMemory(7);
    const c = await searchMemory('hello');
    expect(Array.isArray(a)).toBe(true);
    expect(Array.isArray(b)).toBe(true);
    expect(Array.isArray(c)).toBe(true);
  });

  it('should return archived items', async () => {
    const archived = await getArchivedMemory();
    expect(Array.isArray(archived)).toBe(true);
  });

  afterAll(() => {
    try { fs.unlinkSync(TEST_DB); } catch { /* ignore */ }
    try { fs.rmdirSync(TMP_DIR); } catch { /* ignore */ }
  });
});

