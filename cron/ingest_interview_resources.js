/**
 * scripts/ingest_interview_resources.js — Static RAG Ingestion (text-only, no embedding)
 * Fetch từ GitHub repos → chunk → lưu vào vectors DB (dùng BM25 search)
 * Usage: node scripts/ingest_interview_resources.js
 */

import { DatabaseSync } from 'node:sqlite';
import { chunkText } from '../lib/chunking.js';

const SOURCES = [
  { repo: 'jwasham/coding-interview-university', path: 'README.md', domain: 'algorithms', difficulty: 'easy', tier: 1, tags: ['arrays', 'hashmap', 'two-pointers'] },
  { repo: 'trekhleb/javascript-algorithms', path: 'README.md', domain: 'algorithms', difficulty: 'easy', tier: 1, tags: ['sorting', 'trees', 'graphs'] },
  { repo: 'krahets/hello-algo', path: 'README.md', domain: 'algorithms', difficulty: 'easy', tier: 1, tags: ['binary-search', 'data-structures'] },
  { repo: 'yangshun/tech-interview-handbook', path: 'README.md', domain: 'algorithms', difficulty: 'medium', tier: 2, tags: ['stack', 'queue', 'sliding-window'] },
  { repo: 'Gaurav14cs17/DSA', path: 'README.md', domain: 'algorithms', difficulty: 'medium', tier: 2, tags: ['trees', 'graphs'] },
  { repo: 'dipjul/Grokking-the-Coding-Interview-Patterns-for-Coding-Questions', path: 'README.md', domain: 'algorithms', difficulty: 'hard', tier: 3, tags: ['dp', 'backtracking'] },
  { repo: 'labuladong/fucking-algorithm', path: 'README.md', domain: 'algorithms', difficulty: 'hard', tier: 3, tags: ['trees', 'graphs', 'dp'] },
  { repo: 'ashishps1/awesome-leetcode-resources', path: 'README.md', domain: 'algorithms', difficulty: 'hard', tier: 3, tags: ['dp', 'graphs'] },
  { repo: 'DopplerHQ/awesome-interview-questions', path: 'README.md', domain: 'algorithms', difficulty: 'expert', tier: 4, tags: ['system-design'] },
  { repo: 'SimplifyJobs/Summer2026-Internships', path: 'README.md', domain: 'career', difficulty: 'easy', tier: 0, tags: ['internships', 'jobs'] },
];

async function fetchFromGitHub(repo, filePath) {
  const token = process.env.GITHUB_TOKEN || '';
  const headers = { 'User-Agent': 'my-ai-brain/1.0', 'Accept': 'application/vnd.github.v3+json' };
  if (token) headers['Authorization'] = `token ${token}`;
  const res = await fetch(`https://api.github.com/repos/${repo}/contents/${filePath}`, { headers, signal: AbortSignal.timeout(15000) });
  if (!res.ok) {
    const rawRes = await fetch(`https://raw.githubusercontent.com/${repo}/main/${filePath}`, { headers: { 'User-Agent': 'my-ai-brain/1.0' }, signal: AbortSignal.timeout(15000) });
    if (!rawRes.ok) throw new Error(`Fetch failed: ${res.status}`);
    return rawRes.text();
  }
  return Buffer.from((await res.json()).content, 'base64').toString('utf8');
}

async function main() {
  const db = new DatabaseSync('./vectors.db');
  try { db.exec("ALTER TABLE vectors ADD COLUMN domain TEXT DEFAULT 'general'"); } catch {}
  try { db.exec("ALTER TABLE vectors ADD COLUMN difficulty TEXT DEFAULT 'easy'"); } catch {}
  try { db.exec("ALTER TABLE vectors ADD COLUMN tier INTEGER DEFAULT 1"); } catch {}
  db.exec("DELETE FROM vectors WHERE id LIKE 'interview::%' OR domain = 'career'");
  console.log('Cleared old data');

  const stmt = db.prepare('INSERT OR REPLACE INTO vectors (id, doc_id, chunk_index, chunk_text, embedding, domain, difficulty, tier, metadata, url, project, category, added_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');

  let totalIngested = 0;
  const allRows = [];

  for (const source of SOURCES) {
    console.log(`[Fetch] ${source.repo} (${source.difficulty})...`);
    try {
      const content = await fetchFromGitHub(source.repo, source.path);
      const chunks = chunkText(content, 1500);
      console.log(`  ${content.length} chars → ${chunks.length} chunks`);

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        if (chunk.length < 50) continue;

        // Lưu text thô, không cần embedding (dùng BM25 search)
        allRows.push({
          id: `interview::${source.repo}::${i}`,
          docId: `interview::${source.repo}`,
          chunkIndex: i,
          chunk,
          embedding: Buffer.alloc(0), // empty embedding — BM25 sẽ handle search
          domain: source.domain,
          difficulty: source.difficulty,
          tier: source.tier,
          metadata: JSON.stringify({ tags: source.tags, source: source.repo }),
          url: `https://github.com/${source.repo}`,
          project: source.repo,
          category: source.domain === 'career' ? 'Career' : 'Algorithms',
          now: new Date().toISOString(),
        });
      }
    } catch (err) {
      console.error(`  ✗ Fetch fail: ${err.message}`);
    }
  }

  console.log(`\n[Insert] ${allRows.length} rows...`);

  db.exec('BEGIN');
  try {
    for (const row of allRows) {
      stmt.run(row.id, row.docId, row.chunkIndex, row.chunk, row.embedding,
               row.domain, row.difficulty, row.tier, row.metadata,
               row.url, row.project, row.category, row.now, row.now);
      totalIngested++;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  const totalVectors = db.prepare('SELECT COUNT(*) as n FROM vectors').get().n;
  console.log(`\n=== Summary ===`);
  console.log(`Total ingested: ${totalIngested}`);
  console.log(`Total vectors in DB: ${totalVectors}`);

  db.close();
  console.log('\n[Ingest] Done!');
}

main().catch(err => { console.error('[Ingest] Fatal:', err.message); process.exit(1); });
