import { openDbFile, getAllDbRows } from './lib/sqlite_adapter.js';
import { embedText } from './lib/embeddings.js';

const db = openDbFile('./vectors.db');
const emb = await embedText('Backend programming');

// Get one row
const row = getAllDbRows(db, "SELECT id, embedding FROM vectors WHERE id = 'test-backend-programming'")[0];
console.log('Row id:', row.id);
console.log('Embedding type:', typeof row.embedding);
console.log('Embedding length:', row.embedding?.length);

// Test bufferToFloat32
function bufferToFloat32(buf) {
  if (typeof buf === 'string') {
    console.log('Hex string detected, length:', buf.length);
    const bytes = Buffer.from(buf, 'hex');
    console.log('Bytes length:', bytes.byteLength);
    return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  }
  if (buf && buf.byteLength > 0) {
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    return new Float32Array(ab);
  }
  return new Float32Array(0);
}

const float32 = bufferToFloat32(row.embedding);
console.log('Float32 length:', float32.length);
console.log('First 5 values:', Array.from(float32.slice(0, 5)));

// Compute similarity
if (float32.length === emb.length) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < float32.length; i++) {
    dot += float32[i] * emb[i];
    na += float32[i] * float32[i];
    nb += emb[i] * emb[i];
  }
  const sim = dot / (Math.sqrt(na) * Math.sqrt(nb));
  console.log('Similarity:', sim);
} else {
  console.log('Length mismatch:', float32.length, 'vs', emb.length);
}
