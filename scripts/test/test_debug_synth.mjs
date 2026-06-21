import 'dotenv/config';

console.log('=== Debug applyConfidenceScoring ===\n');

// Test 1: confidence_scorer
console.log('--- Test 1: confidence_scorer ---');
try {
  const { scoreConfidence, formatConfidenceSuffix } = await import('../lib/confidence_scorer.js');
  console.log('scoreConfidence type:', typeof scoreConfidence);
  console.log('formatConfidenceSuffix type:', typeof formatConfidenceSuffix);
  
  // Try calling scoreConfidence
  const result = await scoreConfidence({
    question: 'What is microservices?',
    answer: 'Microservices is an architectural style...',
    searchResults: [{ doc_id: 'test', score: 0.5, chunk_text: 'test' }],
  });
  console.log('✅ scoreConfidence result:', JSON.stringify(result, null, 2).slice(0, 200));
} catch (err) {
  console.log('❌ scoreConfidence error:', err.message);
  console.log('   stack:', err.stack?.split('\n').slice(0, 3).join('\n'));
}

// Test 2: rag_verifier
console.log('\n--- Test 2: rag_verifier ---');
try {
  const { RagVerifier } = await import('../lib/rag_verifier.js');
  console.log('RagVerifier type:', typeof RagVerifier);
  console.log('RagVerifier.verify type:', typeof RagVerifier?.verify);
  
  if (RagVerifier?.verify) {
    const result = await RagVerifier.verify(
      'Microservices is an architectural style...',
      [{ doc_id: 'test', score: 0.5, chunk_text: 'test' }]
    );
    console.log('✅ RagVerifier.verify result:', JSON.stringify(result, null, 2).slice(0, 200));
  }
} catch (err) {
  console.log('❌ RagVerifier error:', err.message);
  console.log('   stack:', err.stack?.split('\n').slice(0, 3).join('\n'));
}

// Test 3: applyConfidenceScoring (the actual function that crashes)
console.log('\n--- Test 3: applyConfidenceScoring via RagAgent ---');
try {
  // Import the internal function indirectly by calling answerQuestion with minimal data
  const { answerQuestion } = await import('../agents/RagAgent.js');
  console.log('answerQuestion imported OK');
} catch (err) {
  console.log('❌ answerQuestion import error:', err.message);
}

console.log('\n=== Done ===');
