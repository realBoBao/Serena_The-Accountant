import { embedText } from '../lib/embeddings.js';
import { search } from '../lib/vector_store.js';

async function main(){
  const q = process.argv.slice(2).join(' ') || 'Node.js Express routing and MVC';
  const qEmb = await embedText(q);
  const results = await search(qEmb, 5);
  console.log('Query:', q);
  console.log('Top results:');
  results.forEach((r, i) => {
    console.log(`${i+1}. score=${r.score.toFixed(4)} doc=${r.doc_id} url=${r.url} chunkIndex=${r.chunk_index}`);
    console.log('   ', r.chunk_text.slice(0,120).replace(/\n/g,' '));
  });
}

main().catch(e=>{ console.error(e); process.exit(1); });
