import { openDbFile } from './lib/sqlite_adapter.js';
const db = openDbFile('./vectors.db');
const rows = db.prepare('SELECT id, length(embedding) as emb_len FROM vectors LIMIT 5').all();
console.log('Sample:', rows);
const one = db.prepare('SELECT id, embedding FROM vectors LIMIT 1').get();
if (one) {
  const e = one.embedding;
  console.log('Type:', e?.constructor?.name, 'len:', e?.byteLength || e?.length);
}
