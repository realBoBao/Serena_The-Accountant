import { DatabaseSync } from 'node:sqlite';
import { embedText } from '../lib/embeddings.js';

const db = new DatabaseSync('./vectors.db');

// Get all rows
const rows = db.prepare('SELECT id, chunk_text FROM vectors').all();
console.log('Total rows to re-index:', rows.length);

let updated = 0;
let errors = 0;

for (const row of rows) {
  try {
    const emb = await embedText(row.chunk_text);
    if (emb && emb.length > 0) {
      const buf = Buffer.from(emb.buffer);
      db.prepare('UPDATE vectors SET embedding = ? WHERE id = ?').run(buf, row.id);
      updated++;
    } else {
      errors++;
      console.log('Empty embedding for:', row.id);
    }
  } catch (err) {
    errors++;
    console.log('Error for:', row.id, err.message);
  }
}

console.log(`\nDone: ${updated} updated, ${errors} errors`);

// Verify
const check = db.prepare('SELECT id, length(embedding) as len FROM vectors WHERE len > 0').all();
console.log('Rows with non-empty embeddings:', check.length);

db.close();
