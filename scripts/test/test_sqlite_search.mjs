import { DatabaseSync } from 'node:sqlite';
import { embedText } from '../lib/embeddings.js';

const db = new DatabaseSync('./vectors.db');
const emb = await embedText('microservices and distributed systems');
console.log('Embedding:', emb?.length, 'dims');

// Brute force search
const rows = db.prepare('SELECT id, doc_id, category, domain, chunk_text, embedding FROM vectors LIMIT 2000').all();
console.log('Rows fetched:', rows.length);

const results = [];
for (const r of rows) {
  const buf = Buffer.from(r.embedding);
  const e = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < emb.length; i++) {
    dot += e[i] * emb[i];
    na += e[i] * e[i];
    nb += emb[i] * emb[i];
  }
  const sim = (na === 0 || nb === 0) ? -1 : dot / (Math.sqrt(na) * Math.sqrt(nb));
  results.push({ id: r.id, doc_id: r.doc_id, category: r.category, domain: r.domain, score: sim, text: (r.chunk_text || '').slice(0, 60) });
}

results.sort((a, b) => b.score - a.score);
console.log('\nTop 10 results:');
for (const r of results.slice(0, 10)) {
  console.log(`  [${r.score.toFixed(3)}] ${r.category}/${r.domain} ${r.id}: ${r.text}`);
}

db.close();
