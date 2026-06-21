import 'dotenv/config';

console.log('=== Quick LLM Synthesis Test ===\n');

// Test 1: invokeLlm directly
console.log('--- Test 1: invokeLlm ---');
try {
  const { invokeLlm } = await import('../agents/RagAgent.js');
  const { HumanMessage } = await import('@langchain/core/messages');
  const result = await invokeLlm([
    new HumanMessage('You are a helpful assistant. Answer in Vietnamese.'),
    new HumanMessage('What is microservices? Answer in 2 sentences.')
  ], 'test');
  console.log('✅ invokeLlm result:', result?.slice(0, 100));
} catch (err) {
  console.log('❌ invokeLlm error:', err.message);
}

// Test 2: synthesizeAnswer
console.log('\n--- Test 2: synthesizeAnswer ---');
try {
  const { synthesizeAnswer } = await import('../agents/RagAgent.js');
  const result = await synthesizeAnswer(
    'What is microservices?',
    'Context: Microservices is an architectural style that structures an application as a collection of small independent services.',
    'local'
  );
  console.log('✅ synthesizeAnswer result:', result?.slice(0, 100));
} catch (err) {
  console.log('❌ synthesizeAnswer error:', err.message);
}

// Test 3: formatSourcesWithScore
console.log('\n--- Test 3: formatSourcesWithScore ---');
try {
  const { formatSourcesWithScore } = await import('../agents/RagAgent.js');
  const mockResults = [
    { doc_id: 'test-1', score: 0.5, chunk_text: 'test', url: 'https://example.com', source: 'vector' },
    { doc_id: 'test-2', score: 0.3, chunk_text: 'test2', url: '', source: 'vector' },
  ];
  const formatted = formatSourcesWithScore(mockResults, 'local');
  console.log('✅ formatSourcesWithScore OK:', formatted.slice(0, 100));
} catch (err) {
  console.log('❌ formatSourcesWithScore error:', err.message);
}

console.log('\n=== Done ===');
