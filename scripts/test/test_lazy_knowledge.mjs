import { loadTocFiles, searchPointers, getRepoStats, fetchPointerContent } from '../lib/lazy_knowledge.js';

const loaded = await loadTocFiles();
console.log('Loaded', loaded, 'entries');

const stats = await getRepoStats();
console.log('Repo stats:', JSON.stringify(stats));

const r1 = await searchPointers('scalability');
console.log('Search scalability:', r1.length, 'results');
r1.slice(0, 3).forEach(r => console.log('  -', r.topic, '(' + r.repo + ')'));

const r2 = await searchPointers('thuat toan');
console.log('Search thuat toan:', r2.length, 'results');
r2.slice(0, 3).forEach(r => console.log('  -', r.topic, '(' + r.repo + ')'));

// Test JIT fetch
if (r1.length > 0 && r1[0].url) {
  console.log('\nJIT fetching content for:', r1[0].topic);
  const content = await fetchPointerContent(r1[0]);
  console.log('Content:', content ? content.slice(0, 200) + '...' : 'null');
}
