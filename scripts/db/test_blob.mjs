import { DatabaseSync } from 'node:sqlite';

// Create test DB
const db = new DatabaseSync('./test_emb.db');
db.exec('CREATE TABLE IF NOT EXISTS test (id TEXT PRIMARY KEY, embedding BLOB)');

// Insert a Float32Array
const arr = new Float32Array([1.0, 2.0, 3.0, 4.0, 5.0]);
const buf = Buffer.from(arr.buffer);
console.log('Original:', arr, 'Buffer length:', buf.byteLength);

db.prepare('INSERT OR REPLACE INTO test VALUES (?, ?)').run('test1', buf);

// Read back
const row = db.prepare('SELECT id, embedding FROM test WHERE id = ?').get('test1');
console.log('Read back type:', typeof row.embedding, 'constructor:', row.embedding?.constructor?.name);
console.log('Read back byteLength:', row.embedding?.byteLength, 'length:', row.embedding?.length);

if (row.embedding && row.embedding.byteLength > 0) {
  const ab = row.embedding.buffer.slice(row.embedding.byteOffset, row.embedding.byteOffset + row.embedding.byteLength);
  const restored = new Float32Array(ab);
  console.log('Restored:', restored);
} else {
  console.log('ERROR: embedding is empty!');
}

db.close();
