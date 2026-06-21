import 'dotenv/config';
import { embedText } from '../lib/embeddings.js';
import { search } from '../lib/vector_store.js';

const emb = await embedText('microservices and distributed systems');
console.log('Embedding:', emb?.length, 'dims');

const results = await search(emb, 5, 'academic');
console.log('\nFinal results:', results.length);
for (const r of results) {
  console.log(`  [${r.score?.toFixed(3)}] source=${r.source} doc=${r.doc_id}: ${(r.chunk_text || '').slice(0, 60)}`);
}
