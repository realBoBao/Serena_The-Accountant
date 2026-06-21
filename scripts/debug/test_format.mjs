import { config } from 'dotenv';
config();
import { openDb } from './lib/sqlite_adapter.js';
await openDb();

// Test formatContext
const RagAgent = await import('./agents/RagAgent.js');

// Create mock results like hybridLocalRetrieval would return
const mockResults = [
  { doc_id: 'test-backend', chunk_text: 'Backend programming is server-side development...', score: 0.3, url: 'test', source: 'sqlite' },
  { doc_id: 'test-python', chunk_text: 'Python Django framework...', score: 0.25, url: 'test', source: 'sqlite' },
];

// Test formatContext via synthesizeAnswer
const { embedText } = await import('./lib/embeddings.js');
const emb = await embedText('Backend programming');

// Call synthesizeAnswer directly
const answer = await RagAgent.synthesizeAnswer('Backend programming la gi?', 'Test context', 'local');
console.log('synthesizeAnswer result:', answer?.slice(0, 200) || 'NULL');
