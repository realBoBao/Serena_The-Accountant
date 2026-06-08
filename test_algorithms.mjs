/**
 * Test Bloom Filter + HNSW
 * Usage: node test_algorithms.mjs
 */
import { BloomFilter } from './lib/bloom_filter.js';
import { HNSWIndex } from './lib/hnsw.js';

let pass = 0, fail = 0;
function ok(n, c) { if (c) { console.log('✅ ' + n); pass++; } else { console.log('❌ ' + n); fail++; } }

// ═══════════════════════════════════════════════════════════════════════════
// TEST 1: Bloom Filter
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n═══ BLOOM FILTER TESTS ═══');

const bf = new BloomFilter(100000, 0.01); // 100K items, 1% FPR

// Test add + mightContain
bf.add('https://github.com/facebook/react');
bf.add('https://youtube.com/watch?v=abc123');
bf.add('https://arxiv.org/abs/2301.00001');

ok('Contains added URL (react)', bf.mightContain('https://github.com/facebook/react'));
ok('Contains added URL (youtube)', bf.mightContain('https://youtube.com/watch?v=abc123'));
ok('Contains added URL (arxiv)', bf.mightContain('https://arxiv.org/abs/2301.00001'));
ok('Does NOT contain unknown URL', !bf.mightContain('https://unknown-site.com/page'));

// Test addAndCheck
const existed1 = bf.addAndCheck('https://github.com/facebook/react'); // Đã tồn tại
const existed2 = bf.addAndCheck('https://new-url.com/article'); // Mới
ok('addAndCheck returns true for existed', existed1 === true);
ok('addAndCheck returns false for new', existed2 === false);

// Test batch URLs
const urls = [];
for (let i = 0; i < 10000; i++) urls.push(`https://example.com/page/${i}`);
const start = Date.now();
for (const url of urls) bf.add(url);
const elapsed = Date.now() - start;
ok(`Batch add 10K URLs in ${elapsed}ms (< 1000ms)`, elapsed < 1000);

// Test false positive rate
let fp = 0;
for (let i = 0; i < 1000; i++) {
  if (bf.mightContain(`https://definitely-not-added-${i}.com`)) fp++;
}
const fpRate = fp / 1000;
ok(`False positive rate ${(fpRate * 100).toFixed(1)}% < 5%`, fpRate < 0.05);

// Stats
const stats = bf.stats();
console.log('Bloom Filter stats:', stats);
ok('Memory < 2MB', parseFloat(stats.sizeMB) < 2);

// ═══════════════════════════════════════════════════════════════════════════
// TEST 2: HNSW Vector Search
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n═══ HNSW TESTS ═══');

const dim = 768;
const hnsw = new HNSWIndex({ dim, M: 8, efConstruction: 30, efSearch: 30 });

// Generate random vectors
function randomVector(d) {
  const v = new Float32Array(d);
  for (let i = 0; i < d; i++) v[i] = Math.random() * 2 - 1;
  // Normalize
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  for (let i = 0; i < d; i++) v[i] /= norm;
  return v;
}

// Insert 100 vectors (dim=768 rất nặng cho CPU)
const vectors = [];
const insertStart = Date.now();
for (let i = 0; i < 100; i++) {
  const vec = randomVector(dim);
  vectors.push(vec);
  hnsw.insert(`vec_${i}`, vec);
}
const insertElapsed = Date.now() - insertStart;
ok(`Insert 100 vectors (dim=768) in ${insertElapsed}ms (< 5000ms)`, insertElapsed < 5000);

// Search
const query = vectors[0]; // Query với vector đã insert
const searchStart = Date.now();
const results = hnsw.search(query, 10);
const searchElapsed = Date.now() - searchStart;
ok(`Search in ${searchElapsed}ms (< 100ms)`, searchElapsed < 100);
ok('Search returns 10 results', results.length === 10);
ok('Top result is the query itself', results[0]?.id === 'vec_0');
ok('Top result distance ≈ 0', results[0]?.distance < 0.01);

// Test with new query (not in index)
const newQuery = randomVector(dim);
const newResults = hnsw.search(newQuery, 5);
ok('New query returns 5 results', newResults.length === 5);
ok('Results sorted by distance', newResults.every((r, i) => i === 0 || r.distance >= newResults[i - 1].distance));

// Stats
const hnswStats = hnsw.stats();
console.log('HNSW stats:', hnswStats);
ok('HNSW has 100 nodes', hnswStats.nodes === 100);
ok('HNSW memory < 10MB', parseFloat(hnswStats.memoryMB) < 10);

// ═══════════════════════════════════════════════════════════════════════════
// TEST 3: Integration — Bloom Filter + HNSW
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n═══ INTEGRATION TEST ═══');

// Scenario: URL dedup + vector search
const urlFilter = new BloomFilter(10000, 0.01);
const vectorIndex = new HNSWIndex({ dim: 128, M: 8 });

const testUrls = [
  'https://github.com/react',
  'https://github.com/vue',
  'https://github.com/angular',
  'https://youtube.com/react-tutorial',
  'https://youtube.com/vue-tutorial',
];

// Add URLs
for (let i = 0; i < testUrls.length; i++) {
  if (!urlFilter.addAndCheck(testUrls[i])) {
    // New URL → add vector
    const vec = randomVector(128);
    vectorIndex.insert(testUrls[i], vec);
  }
}

ok('Bloom filter has 5 items', urlFilter.count === 5);
ok('HNSW has 5 nodes', vectorIndex.count === 5);

// Try adding duplicate
const dupResult = urlFilter.addAndCheck('https://github.com/react');
ok('Duplicate URL detected', dupResult === true);

// Search
const searchVec = randomVector(128);
const searchResults = vectorIndex.search(searchVec, 3);
ok('Search returns 3 results', searchResults.length === 3);

// ═══════════════════════════════════════════════════════════════════════════
// SUMMARY
// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n═══ RESULT: ${pass}/${pass+fail} PASS ═══`);
if (fail > 0) {
  console.log('❌ Some tests failed!');
  process.exit(1);
} else {
  console.log('✅ All tests passed!');
}
