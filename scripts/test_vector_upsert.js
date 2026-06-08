import { chunkText } from '../lib/chunking.js';
import { embedText } from '../lib/embeddings.js';
import { upsertDocument } from '../lib/vector_store.js';

async function main(){
  const sample = `# Sample Project\n\nThis project demonstrates a simple backend using Node.js and Express. It includes routing, middlewares, and tests. The architecture uses MVC and a SQLite database.`.repeat(5);
  const chunks = chunkText(sample, 200, 40);
  const embeddings = await Promise.all(chunks.map(c => embedText(c)));
  const docId = `test:sample-project`;
  await upsertDocument(docId, { url: 'https://example.com/sample', project: 'sample-project' }, chunks, embeddings);
  console.log('Upserted sample doc with', chunks.length, 'chunks');
}

main().catch(e=>{ console.error(e); process.exit(1); });
