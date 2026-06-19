/**
 * scripts/ingest_interview_resources.js — Tier 1: Static RAG Ingestion
 *
 * Clone và nạp nội dung từ các repo GitHub interview resources vào Vector DB.
 * Chạy 1 lần duy nhất, không cần maintain.
 *
 * Usage: node scripts/ingest_interview_resources.js
 */

import { getDb } from '../lib/sqlite_adapter.js';
import { embedText } from '../lib/embeddings.js';

// ── Sources ─────────────────────────────────────────────────────────────────
const SOURCES = [
  {
    name: 'coding-interview-university',
    url: 'https://raw.githubusercontent.com/jwasham/coding-interview-university/main/README.md',
    domain: 'algorithms',
    tags: ['interview', 'cs-fundamentals', 'data-structures', 'algorithms'],
  },
  {
    name: 'tech-interview-handbook',
    url: 'https://raw.githubusercontent.com/yangshun/tech-interview-handbook/main/contents/coding-interview-techniques.md',
    domain: 'algorithms',
    tags: ['interview', 'techniques', 'coding', 'problem-solving'],
  },
  {
    name: 'grokking-coding-interview',
    url: 'https://raw.githubusercontent.com/dipjul/Grokking-the-Coding-Interview-Patterns-for-Coding-Questions/main/README.md',
    domain: 'algorithms',
    tags: ['patterns', 'sliding-window', 'two-pointers', 'dp', 'greedy'],
  },
  {
    name: 'awesome-interview-questions',
    url: 'https://raw.githubusercontent.com/DopplerHQ/awesome-interview-questions/main/README.md',
    domain: 'algorithms',
    tags: ['interview', 'questions', 'system-design', 'behavioral'],
  },
  {
    name: 'coding-interview-university-algorithms',
    url: 'https://raw.githubusercontent.com/jwasham/coding-interview-university/main/contents/algorithms.md',
    domain: 'algorithms',
    tags: ['algorithms', 'sorting', 'searching', 'graph', 'dynamic-programming'],
  },
];

// ── Helpers ─────────────────────────────────────────────────────────────────

function chunkText(text, maxChunkSize = 1500) {
  // Split by ## headings first
  const sections = text.split(/\n(?=#+ )/).filter(s => s.trim().length > 50);
  const chunks = [];

  for (const section of sections) {
    if (section.length <= maxChunkSize) {
      chunks.push(section.trim());
    } else {
      // Split long sections by paragraphs
      const paragraphs = section.split(/\n\n+/).filter(p => p.trim().length > 20);
      let current = '';
      for (const p of paragraphs) {
        if ((current + p).length > maxChunkSize) {
          if (current) chunks.push(current.trim());
          current = p;
        } else {
          current += '\n\n' + p;
        }
      }
      if (current) chunks.push(current.trim());
    }
  }

  return chunks;
}

async function fetchContent(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'my-ai-brain/1.0' },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${url}`);
  return res.text();
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const db = getDb();

  // Ensure domain column exists in vectors table
  try {
    await db.exec("ALTER TABLE vectors ADD COLUMN domain TEXT DEFAULT 'general'");
  } catch { /* already exists */ }

  let totalChunks = 0;
  let totalIngested = 0;

  for (const source of SOURCES) {
    console.log(`\n[Ingest] ${source.name}...`);

    try {
      const content = await fetchContent(source.url);
      const chunks = chunkText(content);
      totalChunks += chunks.length;

      console.log(`  Fetched ${content.length} chars → ${chunks.length} chunks`);

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        if (chunk.length < 50) continue;

        // Generate embedding
        let embedding;
        try {
          embedding = await embedText(chunk.slice(0, 1000));
        } catch (e) {
          console.warn(`  Skip chunk ${i}: embed failed (${e.message})`);
          continue;
        }

        if (!embedding || embedding.length === 0) continue;

        // Insert into vectors table
        const docId = `interview::${source.name}::${i}`;
        const metadata = JSON.stringify({
          domain: source.domain,
          tags: source.tags,
          source: source.url,
          source_name: source.name,
          chunk_index: i,
          indexed_at: new Date().toISOString(),
        });

        try {
          // Check if already exists
          const existing = db.prepare('SELECT id FROM vectors WHERE id = ?').get(docId);
          if (existing) {
            // Update
            db.prepare('UPDATE vectors SET chunk_text = ?, embedding = ?, metadata = ?, domain = ? WHERE id = ?')
              .run(chunk, Buffer.from(new Float32Array(embedding).buffer), metadata, source.domain, docId);
          } else {
            // Insert
            db.prepare('INSERT INTO vectors (id, doc_id, chunk_index, chunk_text, embedding, domain, metadata, url, project, category, added_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
              .run(docId, `interview::${source.name}`, i, chunk, Buffer.from(new Float32Array(embedding).buffer), source.domain, metadata, source.url, source.name, 'Algorithms', new Date().toISOString(), new Date().toISOString());
          }
          totalIngested++;
        } catch (e) {
          console.warn(`  Insert failed: ${e.message}`);
        }
      }

      console.log(`  ✓ Ingested ${chunks.length} chunks`);
    } catch (err) {
      console.error(`  ✗ Failed: ${err.message}`);
    }
  }

  // Verify
  const totalVectors = db.prepare('SELECT COUNT(*) as n FROM vectors').get().n;
  const interviewVectors = db.prepare("SELECT COUNT(*) as n FROM vectors WHERE domain = 'algorithms'").get().n;

  console.log(`\n=== Summary ===`);
  console.log(`Total chunks processed: ${totalChunks}`);
  console.log(`Total ingested: ${totalIngested}`);
  console.log(`Total vectors in DB: ${totalVectors}`);
  console.log(`Interview vectors: ${interviewVectors}`);

  // Domain distribution
  const dist = db.prepare('SELECT domain, COUNT(*) as cnt FROM vectors GROUP BY domain ORDER BY cnt DESC').all();
  console.log('\nDomain distribution:');
  for (const r of dist) console.log(`  ${r.domain}: ${r.cnt}`);

  await db.close();
  console.log('\n[Ingest] Done!');
}

main().catch(err => {
  console.error('[Ingest] Fatal:', err.message);
  process.exit(1);
});
