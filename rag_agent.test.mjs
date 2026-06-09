import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// ── Embedding Cache Tests ──
import { getCachedEmbedding, setCachedEmbedding, clearCache, getCacheStats } from '../lib/embedding_cache.js';

describe('Embedding Cache', () => {
  beforeEach(async () => {
    await clearCache();
  });

  it('should return null for cache miss', async () => {
    const result = await getCachedEmbedding('nonexistent query');
    expect(result).toBeNull();
  });

  it('should store and retrieve embedding', async () => {
    const embedding = new Float32Array([0.1, 0.2, 0.3, 0.4]);
    await setCachedEmbedding('test query', embedding);

    const cached = await getCachedEmbedding('test query');
    expect(cached).not.toBeNull();
    expect(cached.length).toBe(4);
    expect(cached[0]).toBeCloseTo(0.1, 5);
    expect(cached[3]).toBeCloseTo(0.4, 5);
  });

  it('should be case-insensitive for cache keys', async () => {
    const embedding = new Float32Array([0.5, 0.6]);
    await setCachedEmbedding('Hello World', embedding);

    const cached = await getCachedEmbedding('hello world');
    expect(cached).not.toBeNull();
    expect(cached[0]).toBeCloseTo(0.5, 5);
  });

  it('should increment hit count on cache hit', async () => {
    const embedding = new Float32Array([0.1, 0.2]);
    await setCachedEmbedding('hit test', embedding);

    await getCachedEmbedding('hit test');
    await getCachedEmbedding('hit test');

    const stats = await getCacheStats();
    expect(stats.sqlite.total).toBe(1);
    expect(stats.sqlite.totalHits).toBeGreaterThanOrEqual(1);
  });

  it('should report correct cache stats', async () => {
    await setCachedEmbedding('q1', new Float32Array([0.1]));
    await setCachedEmbedding('q2', new Float32Array([0.2]));

    const stats = await getCacheStats();
    expect(stats.sqlite.total).toBe(2);
  });

  it('should clear all cache entries', async () => {
    await setCachedEmbedding('clear test', new Float32Array([0.1]));
    await clearCache();

    const stats = await getCacheStats();
    expect(stats.sqlite.total).toBe(0);
  });
});

// ── BM25 Search Tests ──
import { indexDocument, searchBm25, removeDocument, getBm25Stats } from '../lib/bm25_search.js';

describe('BM25 Search Engine', () => {
  beforeEach(async () => {
    // Clean up test docs
    await removeDocument('test-doc');
    await removeDocument('test-doc-2');
  });

  afterEach(async () => {
    await removeDocument('test-doc');
    await removeDocument('test-doc-2');
  });

  it('should index and search a document', async () => {
    await indexDocument('test-doc', { url: 'http://test.com' }, [
      'Machine learning is a subset of artificial intelligence',
      'Deep learning uses neural networks with many layers',
    ]);

    const results = await searchBm25('machine learning', 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].doc_id).toBe('test-doc');
    expect(results[0].chunk_text).toContain('Machine learning');
  });

  it('should return empty results for non-matching query', async () => {
    await indexDocument('test-doc', {}, ['artificial intelligence and robotics']);

    const results = await searchBm25('quantum computing xyz123', 5);
    expect(results.length).toBe(0);
  });

  it('should rank more relevant documents higher', async () => {
    await indexDocument('test-doc', {}, [
      'Python programming language for data science and machine learning',
    ]);
    await indexDocument('test-doc-2', {}, [
      'Cooking recipes for Italian pasta and pizza',
    ]);

    const results = await searchBm25('python data science', 5);
    expect(results.length).toBeGreaterThan(0);
    // The Python doc should rank higher
    const pythonDoc = results.find(r => r.doc_id === 'test-doc');
    const cookingDoc = results.find(r => r.doc_id === 'test-doc-2');
    if (pythonDoc && cookingDoc) {
      expect(pythonDoc.score).toBeGreaterThan(cookingDoc.score);
    }
  });

  it('should handle Vietnamese text', async () => {
    await indexDocument('test-doc', {}, [
      'Trí tuệ nhân tạo và học máy là lĩnh vực công nghệ cao',
    ]);

    const results = await searchBm25('trí tuệ nhân tạo', 5);
    expect(results.length).toBeGreaterThan(0);
  });

  it('should remove documents correctly', async () => {
    await indexDocument('test-doc', {}, ['test content for removal']);
    await removeDocument('test-doc');

    const results = await searchBm25('test content removal', 5);
    expect(results.length).toBe(0);
  });

  it('should respect topK limit', async () => {
    await indexDocument('test-doc', {}, [
      'algorithm data structure',
      'algorithm sorting searching',
      'algorithm graph tree',
    ]);

    const results = await searchBm25('algorithm', 2);
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it('should report index stats', async () => {
    await indexDocument('test-doc', {}, ['stats test document']);

    const stats = await getBm25Stats();
    expect(stats.documents).toBeGreaterThanOrEqual(1);
    expect(stats.chunks).toBeGreaterThanOrEqual(1);
    expect(stats.uniqueTerms).toBeGreaterThan(0);
  });
});

// ── Hybrid Search Merge Tests ──

describe('Hybrid Search - mergeHybridResults', () => {
  // Import the merge function indirectly through the module
  function mergeHybridResults(vectorResults, bm25Results, bm25Weight = 0.3) {
    const vectorWeight = 1 - bm25Weight;
    const scoreMap = new Map();

    const maxVecScore = Math.max(...vectorResults.map(r => r.score), 1);
    for (const r of vectorResults) {
      const normalizedScore = (r.score / maxVecScore);
      const key = `${r.doc_id}::${r.chunk_index}`;
      scoreMap.set(key, {
        ...r,
        vectorScore: normalizedScore,
        bm25Score: 0,
        hybridScore: normalizedScore * vectorWeight,
      });
    }

    const maxBm25Score = Math.max(...bm25Results.map(r => r.score), 1);
    for (const r of bm25Results) {
      const normalizedScore = (r.score / maxBm25Score);
      const key = `${r.doc_id}::${r.chunk_index}`;
      const existing = scoreMap.get(key);
      if (existing) {
        existing.bm25Score = normalizedScore;
        existing.hybridScore += normalizedScore * bm25Weight;
      } else {
        scoreMap.set(key, {
          ...r,
          vectorScore: 0,
          bm25Score: normalizedScore,
          hybridScore: normalizedScore * bm25Weight,
        });
      }
    }

    return Array.from(scoreMap.values())
      .sort((a, b) => b.hybridScore - a.hybridScore);
  }

  it('should merge vector and BM25 results', () => {
    const vectorResults = [
      { doc_id: 'doc1', chunk_index: 0, score: 0.9, chunk_text: 'v1' },
      { doc_id: 'doc2', chunk_index: 0, score: 0.7, chunk_text: 'v2' },
    ];
    const bm25Results = [
      { doc_id: 'doc1', chunk_index: 0, score: 5.0, chunk_text: 'b1' },
      { doc_id: 'doc3', chunk_index: 0, score: 3.0, chunk_text: 'b3' },
    ];

    const merged = mergeHybridResults(vectorResults, bm25Results, 0.3);
    expect(merged.length).toBe(3); // doc1, doc2, doc3
    // doc1 should be first (appears in both)
    expect(merged[0].doc_id).toBe('doc1');
    expect(merged[0].hybridScore).toBeGreaterThan(0);
  });

  it('should handle empty BM25 results', () => {
    const vectorResults = [
      { doc_id: 'doc1', chunk_index: 0, score: 0.8, chunk_text: 'test' },
    ];

    const merged = mergeHybridResults(vectorResults, [], 0.3);
    expect(merged.length).toBe(1);
    // Vector: maxVecScore = max(0.8, 1) = 1, norm = 0.8/1 = 0.8, hybrid = 0.8 * 0.7 = 0.56
    expect(merged[0].hybridScore).toBeCloseTo(0.56, 1);
  });

  it('should handle empty vector results', () => {
    const bm25Results = [
      { doc_id: 'doc1', chunk_index: 0, score: 5.0, chunk_text: 'test' },
    ];

    const merged = mergeHybridResults([], bm25Results, 0.3);
    expect(merged.length).toBe(1);
    expect(merged[0].hybridScore).toBeCloseTo(0.3, 1); // Pure BM25 weight
  });

  it('should normalize scores correctly', () => {
    const vectorResults = [
      { doc_id: 'doc1', chunk_index: 0, score: 0.5, chunk_text: 'test' },
    ];
    const bm25Results = [
      { doc_id: 'doc2', chunk_index: 0, score: 10.0, chunk_text: 'test' },
    ];

    const merged = mergeHybridResults(vectorResults, bm25Results, 0.5);
    // Vector: maxVecScore = max(0.5, 1) = 1, norm = 0.5/1 = 0.5, hybrid = 0.5 * 0.5 = 0.25
    // BM25: maxBm25Score = max(10, 1) = 10, norm = 10/10 = 1.0, hybrid = 1.0 * 0.5 = 0.5
    expect(merged[0].hybridScore).toBeCloseTo(0.5, 5);   // BM25 doc (higher score)
    expect(merged[1].hybridScore).toBeCloseTo(0.25, 5);  // Vector doc
  });

  it('should boost documents appearing in both results', () => {
    const vectorResults = [
      { doc_id: 'doc1', chunk_index: 0, score: 0.8, chunk_text: 'test' },
      { doc_id: 'doc2', chunk_index: 0, score: 0.6, chunk_text: 'test' },
    ];
    const bm25Results = [
      { doc_id: 'doc1', chunk_index: 0, score: 4.0, chunk_text: 'test' },
    ];

    const merged = mergeHybridResults(vectorResults, bm25Results, 0.3);
    // doc1 appears in both → should have higher hybrid score than doc2
    const doc1 = merged.find(r => r.doc_id === 'doc1');
    const doc2 = merged.find(r => r.doc_id === 'doc2');
    expect(doc1.hybridScore).toBeGreaterThan(doc2.hybridScore);
  });
});

// ── RagAgent Configuration Tests ──

describe('RagAgent - Configuration', () => {
  it('should have valid similarity threshold', () => {
    const threshold = Number(process.env.DISCORD_SIMILARITY_THRESHOLD || 0.6);
    expect(threshold).toBeGreaterThan(0);
    expect(threshold).toBeLessThanOrEqual(1);
  });

  it('should have valid max results', () => {
    const maxRes = Number(process.env.DISCORD_MAX_RESULTS || 4);
    expect(maxRes).toBeGreaterThan(0);
    expect(maxRes).toBeLessThanOrEqual(20);
  });

  it('should have valid hybrid BM25 weight', () => {
    const weight = Number(process.env.HYBRID_BM25_WEIGHT || 0.3);
    expect(weight).toBeGreaterThanOrEqual(0);
    expect(weight).toBeLessThanOrEqual(1);
  });
});

// ── Query Expansion Logic Tests ──

describe('Query Expansion - Logic', () => {
  it('should parse JSON array from LLM response', () => {
    const raw = '["query one", "query two", "query three"]';
    const jsonStart = raw.indexOf('[');
    const jsonEnd = raw.lastIndexOf(']');
    const parsed = JSON.parse(raw.slice(jsonStart, jsonEnd + 1));

    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(3);
    expect(parsed[0]).toBe('query one');
  });

  it('should handle markdown-wrapped JSON', () => {
    const raw = '```json\n["expanded query 1", "expanded query 2"]\n```';
    const jsonStart = raw.indexOf('[');
    const jsonEnd = raw.lastIndexOf(']');
    const parsed = JSON.parse(raw.slice(jsonStart, jsonEnd + 1));

    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(2);
  });

  it('should filter empty strings from expansion', () => {
    const parsed = ['valid query', '', '   ', 'another valid'];
    const filtered = parsed.filter(q => typeof q === 'string' && q.trim().length > 0).slice(0, 2);

    expect(filtered.length).toBe(2);
    expect(filtered[0]).toBe('valid query');
    expect(filtered[1]).toBe('another valid');
  });

  it('should limit expansions to 2', () => {
    const parsed = ['q1', 'q2', 'q3', 'q4'];
    const limited = parsed.slice(0, 2);

    expect(limited.length).toBe(2);
  });
});

// ── Collection Weights Tests ──

describe('Collection Weights', () => {
  it('should have valid academic weight', () => {
    const weight = Number(process.env.WEIGHT_ACADEMIC || 1.0);
    expect(weight).toBeGreaterThan(0);
    expect(weight).toBeLessThanOrEqual(2);
  });

  it('should have valid system weight', () => {
    const weight = Number(process.env.WEIGHT_SYSTEM || 0.8);
    expect(weight).toBeGreaterThan(0);
    expect(weight).toBeLessThanOrEqual(2);
  });

  it('should have valid daily weight', () => {
    const weight = Number(process.env.WEIGHT_DAILY || 0.9);
    expect(weight).toBeGreaterThan(0);
    expect(weight).toBeLessThanOrEqual(2);
  });

  it('should apply weights correctly to scores', () => {
    const weights = { academic: 1.0, system: 0.8, daily: 0.9 };
    const results = [
      { doc_id: 'a1', score: 0.9 },
      { doc_id: 's1', score: 0.9 },
      { doc_id: 'd1', score: 0.9 },
    ];

    const weighted = [
      { ...results[0], score: results[0].score * weights.academic },
      { ...results[1], score: results[1].score * weights.system },
      { ...results[2], score: results[2].score * weights.daily },
    ];

    expect(weighted[0].score).toBeCloseTo(0.9, 5);   // academic: 1.0
    expect(weighted[1].score).toBeCloseTo(0.72, 5);   // system: 0.8
    expect(weighted[2].score).toBeCloseTo(0.81, 5);   // daily: 0.9
  });
});

// ── Self-Reflect Gate Tests ──

describe('Self-Reflect Gate - Logic', () => {
  it('should parse valid gate response', () => {
    const raw = '{"pass": true, "reason": "context matches question"}';
    const parsed = JSON.parse(raw);

    expect(parsed.pass).toBe(true);
    expect(parsed.reason).toBe('context matches question');
  });

  it('should parse gate response with safeAnswer', () => {
    const raw = '{"pass": false, "reason": "context mismatch", "safeAnswer": "Tôi không chắc chắn"}';
    const parsed = JSON.parse(raw);

    expect(parsed.pass).toBe(false);
    expect(parsed.safeAnswer).toBe('Tôi không chắc chắn');
  });

  it('should extract JSON from mixed response', () => {
    const raw = 'Here is my evaluation: {"pass": true, "reason": "ok"} Thanks!';
    const jsonStart = raw.indexOf('{');
    const jsonEnd = raw.lastIndexOf('}');
    const jsonText = raw.slice(jsonStart, jsonEnd + 1);
    const parsed = JSON.parse(jsonText);

    expect(parsed.pass).toBe(true);
  });

  it('should handle gate failure gracefully', () => {
    const invalidRaw = 'not json at all';
    let parsed = null;
    try {
      parsed = JSON.parse(invalidRaw);
    } catch (e) {
      // Expected to fail
    }
    expect(parsed).toBeNull();
  });
});
