/**
 * Embedding Cache Tests — Phase 17
 */
import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { getCachedEmbedding, setCachedEmbedding, getCacheStats, clearCache } from '../lib/embedding_cache.js';
import { embedText, embedTextsBatch } from '../lib/embeddings.js';

beforeAll(async () => {
  await clearCache();
});

afterAll(async () => {
  await clearCache();
});

describe('Embedding Cache — Basic Operations', () => {
  test('getCachedEmbedding returns null for miss', async () => {
    const result = await getCachedEmbedding('nonexistent text that was never cached');
    expect(result).toBeNull();
  });

  test('setCachedEmbedding stores embedding', async () => {
    const text = 'test embedding cache ' + Date.now();
    const embedding = new Float32Array(3072);
    embedding[0] = 0.5;
    embedding[1] = 0.3;

    await setCachedEmbedding(text, embedding);
    const cached = await getCachedEmbedding(text);

    expect(cached).not.toBeNull();
    expect(cached[0]).toBeCloseTo(0.5);
    expect(cached[1]).toBeCloseTo(0.3);
  });

  test('getCacheStats returns stats', async () => {
    const stats = await getCacheStats();
    expect(stats).toHaveProperty('total');
    expect(stats).toHaveProperty('hits');
    expect(typeof stats.total).toBe('number');
  });

  test('clearCache removes all entries', async () => {
    await clearCache();
    const stats = await getCacheStats();
    expect(stats.total).toBe(0);
  });
});

describe('Embeddings — Cache Integration', () => {
  test('embedText returns Float32Array', async () => {
    const result = await embedText('test query for embedding');
    expect(result).toBeInstanceOf(Float32Array);
    expect(result.length).toBeGreaterThan(0);
  });

  test('embedTextsBatch returns array of embeddings', async () => {
    const texts = ['first text', 'second text', 'third text'];
    const results = await embedTextsBatch(texts);
    expect(results.length).toBe(3);
    results.forEach(emb => {
      expect(emb).toBeInstanceOf(Float32Array);
      expect(emb.length).toBeGreaterThan(0);
    });
  });

  test('embedTextsBatch handles empty array', async () => {
    const results = await embedTextsBatch([]);
    expect(results).toEqual([]);
  });

  test('embedTextsBatch handles null input', async () => {
    const results = await embedTextsBatch(null);
    expect(results).toEqual([]);
  });
});
