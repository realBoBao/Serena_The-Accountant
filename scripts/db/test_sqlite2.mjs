import { DatabaseSync } from 'node:sqlite';
import { embedText } from '../lib/embeddings.js';

function bufferToFloat32(buf) {
  if (typeof buf === 'string') {
    const bytes = Buffer.from(buf, 'hex');
    return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  }
  if (buf && buf.byteLength > 0) {
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    return new Float32Array(ab);
  }
  return new Float32Array(0);
}

const db = new DatabaseSync('./vectors.db');
const emb = await embedText('microservices and distributed systems');
console.log('Query embedding:', emb?.length, 'dims, sample:', emb?.slice(0, 3));

const rows = db.prepare('SELECT id, doc_id, category, domain, chunk_text, embedding FROM vectors LIMIT 2000').all();
console.log('Rows fetched:', rows.length);

// Check first row embedding format
if (rows.length > 0) {
  const first = rows[0].embedding;
  console.log('First embedding type:', typeof first, 'constructor:', first?.constructor?.name, 'byteLength:', first?.byteLength, 'length:', first?.length);
  const parsed = bufferToFloat32(first);
  console.log('Parsed length:', parsed.length, 'sample:', parsed.slice(0, 3));
}

const results = [];
for (const r of rows) {
  const e = bufferToFloat32(r.embedding);
  if (e.length === 0) continue;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < Math.min(emb.length, e.length); i++) {
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
