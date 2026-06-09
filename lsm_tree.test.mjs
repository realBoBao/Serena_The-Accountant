/**
 * ═══════════════════════════════════════════════════════════════
 * LSM-Tree Unit Tests
 * ═══════════════════════════════════════════════════════════════
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { LSMTree, SkipList, SSTable } from '../lib/lsm_tree.js';
import fs from 'fs/promises';
import path from 'path';

const TEST_DIR = './data/test-lsm';

describe('SkipList', () => {
  it('should insert and retrieve values', () => {
    const sl = new SkipList();
    sl.insert('key1', 'value1');
    sl.insert('key2', 'value2');
    sl.insert('key3', 'value3');

    expect(sl.get('key1')).toBe('value1');
    expect(sl.get('key2')).toBe('value2');
    expect(sl.get('key3')).toBe('value3');
    expect(sl.get('nonexistent')).toBeNull();
  });

  it('should update existing keys', () => {
    const sl = new SkipList();
    sl.insert('key', 'old');
    sl.insert('key', 'new');

    expect(sl.get('key')).toBe('new');
    expect(sl.size).toBe(1);
  });

  it('should delete with tombstone', () => {
    const sl = new SkipList();
    sl.insert('key', 'value');
    sl.delete('key');

    expect(sl.get('key')).toEqual({ __deleted: true, __ts: expect.any(Number) });
    expect(sl.has('key')).toBe(false);
  });

  it('should iterate in sorted order', () => {
    const sl = new SkipList();
    sl.insert('c', 3);
    sl.insert('a', 1);
    sl.insert('b', 2);

    const entries = sl.toArray();
    expect(entries.map(e => e.key)).toEqual(['a', 'b', 'c']);
    expect(entries.map(e => e.value)).toEqual([1, 2, 3]);
  });

  it('should handle 1000 entries', () => {
    const sl = new SkipList();
    for (let i = 0; i < 1000; i++) {
      sl.insert(`key-${i}`, `value-${i}`);
    }
    expect(sl.size).toBe(1000);
    expect(sl.get('key-500')).toBe('value-500');
    expect(sl.get('key-999')).toBe('value-999');
  });
});

describe('SSTable', () => {
  const testFile = path.join(TEST_DIR, 'test.sst');

  beforeAll(async () => {
    await fs.mkdir(TEST_DIR, { recursive: true });
  });

  afterAll(async () => {
    await fs.rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
  });

  it('should write and read entries', async () => {
    const entries = [
      { key: 'a', value: 1 },
      { key: 'b', value: 2 },
      { key: 'c', value: 3 },
    ];

    await SSTable.write(testFile, entries);

    const sst = new SSTable(testFile, 0);
    await sst.load();

    expect(await sst.get('a')).toBe(1);
    expect(await sst.get('b')).toBe(2);
    expect(await sst.get('c')).toBe(3);
    expect(await sst.get('d')).toBeNull();
  });

  it('should handle empty entries', async () => {
    const emptyFile = path.join(TEST_DIR, 'empty.sst');
    await SSTable.write(emptyFile, []);

    const sst = new SSTable(emptyFile, 0);
    await sst.load();

    expect(sst.size).toBe(0);
  });
});

describe('LSMTree', () => {
  let lsm;

  beforeAll(async () => {
    lsm = new LSMTree({
      dataDir: TEST_DIR,
      memTableSize: 100,
      memTableBytes: 1024 * 1024,
      compactionInterval: 999999, // Disable auto-compaction in tests
    });
    await lsm.open();
  });

  afterAll(async () => {
    await lsm.close();
    await fs.rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
  });

  it('should put and get values', async () => {
    await lsm.put('key1', 'value1');
    await lsm.put('key2', { nested: true, data: [1, 2, 3] });

    expect(await lsm.get('key1')).toBe('value1');
    expect(await lsm.get('key2')).toEqual({ nested: true, data: [1, 2, 3] });
  });

  it('should return null for missing keys', async () => {
    expect(await lsm.get('nonexistent')).toBeNull();
  });

  it('should delete keys', async () => {
    await lsm.put('to-delete', 'value');
    expect(await lsm.get('to-delete')).toBe('value');

    await lsm.delete('to-delete');
    expect(await lsm.get('to-delete')).toBeNull();
  });

  it('should handle batch writes', async () => {
    for (let i = 0; i < 50; i++) {
      await lsm.put(`batch-${i}`, `value-${i}`);
    }

    for (let i = 0; i < 50; i++) {
      expect(await lsm.get(`batch-${i}`)).toBe(`value-${i}`);
    }
  });

  it('should track stats', async () => {
    const stats = lsm.getStats();
    expect(stats.writes).toBeGreaterThan(0);
    expect(stats.reads).toBeGreaterThan(0);
    expect(stats.memTableEntries).toBeGreaterThanOrEqual(0);
  });

  it('should handle updates to same key', async () => {
    await lsm.put('update-key', 'v1');
    await lsm.put('update-key', 'v2');
    await lsm.put('update-key', 'v3');

    expect(await lsm.get('update-key')).toBe('v3');
  });

  it('should scan all entries', async () => {
    await lsm.put('scan-a', 1);
    await lsm.put('scan-b', 2);
    await lsm.put('scan-c', 3);

    const entries = [];
    for await (const entry of lsm.scan()) {
      if (entry.key.startsWith('scan-')) {
        entries.push(entry);
      }
    }

    expect(entries.length).toBe(3);
    expect(entries.map(e => e.key).sort()).toEqual(['scan-a', 'scan-b', 'scan-c']);
  });
});
