import { config } from 'dotenv';
config();
import { openDbFile, getAllDbRows } from './lib/sqlite_adapter.js';
import { embedText } from './lib/embeddings.js';

const db = openDbFile('./vectors.db');
const emb = await embedText('Backend programming');
console.log('Query embedding:', emb?.length, 'dims');

const rows = getAllDbRows(db, 'SELECT id, doc_id, chunk_text, embedding FROM vectors LIMIT 5');
console.log('Rows:', rows.length);

if (rows.length > 0) {
  const r = rows[0];
  console.log('First row id:', r.id);
  console.log('Embedding type:', typeof r.embedding, r.embedding?.constructor?.name);
  
  // Check if embedding is Buffer or Uint8Array
  const embBuf = r.embedding;
  console.log('Is Buffer:', Buffer.isBuffer(embBuf));
  console.log('Byte length:', embBuf?.length || embBuf?.byteLength);
  
  // Try to convert to Float32Array
  try {
    let float32;
    if (Buffer.isBuffer(embBuf)) {
      float32 = new Float32Array(embBuf.buffer, embBuf.byteOffset, embBuf.byteLength / 4);
    } else if (embBuf instanceof Uint8Array) {
      float32 = new Float32Array(embBuf.buffer, embBuf.byteOffset, embBuf.byteLength / 4);
    } else {
      float32 = new Float32Array(embBuf);
    }
    console.log('Float32 length:', float32.length);
    console.log('First 5 values:', Array.from(float32.slice(0, 5)));
    
    // Compute similarity
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < Math.min(float32.length, emb.length); i++) {
      dot += float32[i] * emb[i];
      na += float32[i] * float32[i];
      nb += emb[i] * emb[i];
    }
    const sim = (na === 0 || nb === 0) ? -1 : dot / (Math.sqrt(na) * Math.sqrt(nb));
    console.log('Similarity:', sim);
  } catch (e) {
    console.log('Error:', e.message);
  }
}
