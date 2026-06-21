import { openDbFile } from './lib/sqlite_adapter.js';
const db = openDbFile('./vectors.db');

// Update test data to have proper metadata with space
const docs = db.prepare("SELECT id FROM vectors WHERE id LIKE 'test-%'").all();
console.log('Found', docs.length, 'test docs');

for (const doc of docs) {
  const meta = JSON.stringify({ space: 'academic', type: 'tutorial' });
  db.prepare("UPDATE vectors SET metadata = ?, domain = 'backend' WHERE id = ?").run(meta, doc.id);
  console.log('  Updated:', doc.id);
}

// Verify
const verify = db.prepare("SELECT id, metadata, domain FROM vectors WHERE id LIKE 'test-%' LIMIT 3").all();
console.log('Verification:', verify);
