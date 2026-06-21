import 'dotenv/config';
import { embedText } from '../lib/embeddings.js';
import { search } from '../lib/vector_store.js';

const queries = [
  'microservices and distributed systems',
  'rust async programming',
  'backend programming',
];

for (const q of queries) {
  console.log(`\n=== Query: "${q}" ===`);
  try {
    const emb = await embedText(q);
    console.log('Embedding length:', emb?.length);
    const results = await search(emb, 5);
    console.log('Results:', results.length);
    for (const r of results) {
      console.log(`  [${r.score?.toFixed(3)}] ${r.doc_id}: ${(r.chunk_text || '').slice(0, 60)}`);
    }
  } catch (err) {
    console.log('ERROR:', err.message);
  }
}
