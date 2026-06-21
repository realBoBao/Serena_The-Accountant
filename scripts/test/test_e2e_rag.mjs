import 'dotenv/config';

console.log('=== End-to-End RAG Test ===\n');

// Step 1: Test orchestratorGuard route
console.log('--- Step 1: orchestratorGuard.routeWithGuard ---');
try {
  const { orchestratorGuard } = await import('../lib/orchestrator_guard.js');
  const result = await orchestratorGuard.routeWithGuard('RAG', {
    query: 'microservices and distributed systems',
    options: { userId: 'test-user' },
  }, 'test-user');
  console.log('✅ Guard response:', JSON.stringify(result, null, 2).slice(0, 500));
} catch (err) {
  console.log('❌ Guard error:', err.message);
}

// Step 2: Test RagAgent directly
console.log('\n--- Step 2: RagAgent.answerQuestion ---');
try {
  const { answerQuestion } = await import('../agents/RagAgent.js');
  const result = await answerQuestion('microservices and distributed systems', { userId: 'test-user' });
  console.log('✅ Answer:', result.answer?.slice(0, 200));
  console.log('   Source:', result.source);
  console.log('   Results count:', result.results?.length);
  if (result.results?.length > 0) {
    console.log('   Top 3 results:');
    for (const r of result.results.slice(0, 3)) {
      console.log(`     [${r.score?.toFixed(3)}] ${r.doc_id}: ${(r.chunk_text || '').slice(0, 60)}`);
    }
  }
} catch (err) {
  console.log('❌ RagAgent error:', err.message);
}

// Step 3: Test search directly
console.log('\n--- Step 3: vector_store.search ---');
try {
  const { search } = await import('../lib/vector_store.js');
  const { embedText } = await import('../lib/embeddings.js');
  const emb = await embedText('microservices and distributed systems');
  const results = await search(emb, 10, 'academic');
  console.log('✅ Search results:', results.length);
  for (const r of results.slice(0, 5)) {
    console.log(`   [${r.score?.toFixed(3)}] ${r.category}/${r.domain} ${r.doc_id}: ${(r.chunk_text || '').slice(0, 60)}`);
  }
} catch (err) {
  console.log('❌ Search error:', err.message);
}

console.log('\n=== Test Complete ===');
