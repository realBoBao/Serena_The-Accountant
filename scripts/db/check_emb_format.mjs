import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('./vectors.db');

const row = db.prepare('SELECT id, embedding, length(embedding) as len FROM vectors LIMIT 3').all();
for (const r of row) {
  console.log(r.id, 'len:', r.len, 'type:', typeof r.embedding, 'constructor:', r.embedding?.constructor?.name);
  if (r.embedding) {
    console.log('  byteLength:', r.embedding.byteLength, 'length:', r.embedding.length);
    // Try to read first few bytes
    const buf = Buffer.isBuffer(r.embedding) ? r.embedding : Buffer.from(r.embedding);
    console.log('  first 20 bytes:', buf.slice(0, 20).toString('hex'));
  }
}

db.close();
