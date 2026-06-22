import { openDbFile, runDb, getAllDbRows } from './sqlite_adapter.js';
import path from 'path';
import { HNSWIndex } from './hnsw.js';

// ── HNSW In-Memory Index (O(log N) search) ────────────────────────────────
// Khi không có Qdrant, HNSW cung cấp tìm kiếm nhanh hơn brute-force O(N)
let _hnswIndex = null;
let _hnswMeta = new Map(); // id → { docId, chunkIndex, chunkText, metadata }

function getHnswIndex(dim = 768) {
  if (!_hnswIndex) {
    _hnswIndex = new HNSWIndex({ dim, M: 16, efConstruction: 200, efSearch: 50 });
    console.log(`[HNSW] In-memory index created (dim=${dim})`);
  }
  return _hnswIndex;
}

const VDB = path.resolve(process.env.VECTOR_DB_PATH || path.join(process.cwd(), 'vectors.db'));

// Theo dõi trạng thái in log để tránh xả rác vào console
let qdrantStatusLogged = false;

let _vectorDb = null;

async function getDb() {
  if (_vectorDb) return _vectorDb;
  _vectorDb = openDbFile(VDB);

  // ── WAL mode for crash safety on Cloud Run ──
  runDb(_vectorDb, 'PRAGMA journal_mode=WAL');
  runDb(_vectorDb, 'PRAGMA synchronous=NORMAL');

  runDb(_vectorDb, `CREATE TABLE IF NOT EXISTS vectors (
    id TEXT PRIMARY KEY,
    doc_id TEXT,
    chunk_index INTEGER,
    chunk_text TEXT,
    embedding BLOB,
    url TEXT,
    project TEXT,
    category TEXT,
    metadata TEXT,
    added_at TEXT,
    updated_at TEXT
  )`);
  try { runDb(_vectorDb, `ALTER TABLE vectors ADD COLUMN category TEXT`); } catch { /* exists */ }
  try { runDb(_vectorDb, `ALTER TABLE vectors ADD COLUMN metadata TEXT`); } catch { /* exists */ }
  try { runDb(_vectorDb, `ALTER TABLE vectors ADD COLUMN updated_at TEXT`); } catch { /* exists */ }
  try { runDb(_vectorDb, `ALTER TABLE vectors ADD COLUMN domain TEXT DEFAULT 'general'`); } catch { /* exists */ }
  runDb(_vectorDb, `CREATE INDEX IF NOT EXISTS idx_doc_id ON vectors(doc_id)`);
  runDb(_vectorDb, `CREATE INDEX IF NOT EXISTS idx_category ON vectors(category)`);
  runDb(_vectorDb, `CREATE INDEX IF NOT EXISTS idx_domain ON vectors(domain)`);
  runDb(_vectorDb, `CREATE INDEX IF NOT EXISTS idx_added_at ON vectors(added_at)`);
  return _vectorDb;
}

/** Close the DB connection and reset HNSW index (for graceful shutdown) */
export async function closeDb() {
  if (_dbPromise) {
    const db = await _dbPromise;
    await db.close();
    _dbPromise = null;
  }
  _hnswIndex = null;
  _hnswMeta.clear();
}

function float32ToBuffer(arr) {
  return Buffer.from(arr.buffer);
}

function bufferToFloat32(buf) {
  // Handle hex string storage (fallback for node:sqlite BLOB issues)
  if (typeof buf === 'string') {
    const bytes = Buffer.from(buf, 'hex');
    return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  }
  // Handle Buffer/Uint8Array
  if (buf && buf.byteLength > 0) {
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    return new Float32Array(ab);
  }
  // Fallback: empty array
  return new Float32Array(0);
}

// ===== SQLite backend (legacy / fallback) =====
async function sqliteUpsertDocument(docId, metadata, chunks, embeddings) {
  const db = await getDb();
  // delete existing chunks for docId
  db.run('DELETE FROM vectors WHERE doc_id = ?', docId);

  const added_at = new Date().toISOString();
  const updated_at = new Date().toISOString();
  const category = metadata?.category || 'Backend';
  const domain = metadata?.domain || 'general';
  const metadataJson = JSON.stringify(metadata || {});
  const insert = await db.prepare(
    'INSERT INTO vectors(id,doc_id,chunk_index,chunk_text,embedding,url,project,category,domain,metadata,added_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)'
  );

  for (let i = 0; i < chunks.length; i += 1) {
    const id = `${docId}::${i}`;
    const embBuf = float32ToBuffer(embeddings[i]);
    await insert.run(
      id,
      docId,
      i,
      chunks[i],
      embBuf,
      metadata?.url || '',
      metadata?.project || '',
      category,
      domain,
      metadataJson,
      added_at,
      updated_at
    );
  }

  await insert.finalize();
  await db.close();
  return true;
}

async function sqliteSearch(queryEmbedding, topK = 5, space = 'default', domain = null) {
  const db = await getDb();
  
  // ── SỬA LỖI 2: TRÁNH TREO NODE.JS BẰNG CÁCH CHỈ LẤY VECTO LIÊN QUAN HOẶC GIỚI HẠN DÒNG ──
  // Do SQLite không có chỉ mục vector thực sự, ta phải quét bảng. 
  // Để tránh Event Loop Blocking khi bảng quá lớn, giới hạn số dòng quét tối đa.
  const MAX_ROWS_TO_SCAN = 2000; // Giảm từ 15000 để tránh event loop blocking
  
  // Tối ưu: Nếu có space (collection), ta dùng JSON_EXTRACT để lọc bớt từ cột metadata trước
  // Whitelist allowed spaces to prevent SQL injection
  const ALLOWED_SPACES = ['academic', 'system', 'daily', 'default'];
  if (!ALLOWED_SPACES.includes(space)) {
    throw new Error(`Invalid space: ${space}. Allowed: ${ALLOWED_SPACES.join(', ')}`);
  }

  let queryStr = 'SELECT id, doc_id, chunk_index, chunk_text, embedding, url, project, category, domain, metadata, added_at, updated_at FROM vectors';
  const params = [];
  const conditions = [];
  
  if (space !== 'default') {
    conditions.push(`metadata LIKE '%"space":"' || ? || '"%'`);
    params.push(space);
  }
  if (domain && domain !== 'all') {
    conditions.push('domain = ?');
    params.push(domain);
  }
  
  if (conditions.length > 0) {
    queryStr += ' WHERE ' + conditions.join(' AND ');
  }
  queryStr += ` ORDER BY updated_at DESC LIMIT ${MAX_ROWS_TO_SCAN}`;

  const rows = getAllDbRows(db, queryStr, ...params);

  const results = [];
  const now = Date.now();
  const HALF_LIFE_DAYS = 30; // Score giảm 1/2 sau 30 ngày

  for (const r of rows) {
    const emb = bufferToFloat32(r.embedding);
    let dot = 0; let na = 0; let nb = 0;
    for (let i = 0; i < emb.length; i += 1) {
      dot += emb[i] * queryEmbedding[i];
      na += emb[i] * emb[i];
      nb += queryEmbedding[i] * queryEmbedding[i];
    }
    const sim = (na === 0 || nb === 0) ? -1 : dot / (Math.sqrt(na) * Math.sqrt(nb));

    // ── Temporal Decay: Tin cũ trọng số thấp hơn ──
    // decay = 2^(-days_ago / half_life)
    // 0 ngày → 1.0, 30 ngày → 0.5, 90 ngày → 0.125
    let temporalScore = sim;
    if (r.added_at && sim > 0) {
      const addedAt = new Date(r.added_at).getTime();
      const daysAgo = (now - addedAt) / (1000 * 3600 * 24);
      const decay = Math.pow(2, -daysAgo / HALF_LIFE_DAYS);
      temporalScore = sim * decay;
    }

    results.push({ score: temporalScore, originalScore: sim, row: r, daysAgo: r.added_at ? (now - new Date(r.added_at).getTime()) / (1000 * 3600 * 24) : null });
  }

  // Don't close DB — it's shared
  results.sort((a, b) => b.score - a.score);

  return results.slice(0, topK).map((r) => ({
    score: r.score,
    originalScore: r.originalScore,
    daysAgo: r.daysAgo ? Math.round(r.daysAgo * 10) / 10 : null,
    doc_id: r.row.doc_id,
    chunk_index: r.row.chunk_index,
    chunk_text: r.row.chunk_text,
    url: r.row.url,
    project: r.row.project,
    category: r.row.category || 'Backend',
    metadata: (() => {
      try { return JSON.parse(r.row.metadata || '{}'); } catch (err) { return {}; }
    })(),
    added_at: r.row.added_at,
    updated_at: r.row.updated_at,
  }));
}

/**
 * Lấy sources từ database theo thứ tự thời gian (oldest → newest).
 * Dùng làm fallback khi search API fail hoặc rate limit.
 * @param {string} space — Collection name (academic, system, daily)
 * @param {number} limit — Số lượng sources trả về
 * @param {string} order — 'asc' (oldest first) hoặc 'desc' (newest first)
 * @returns {Array} — [{ doc_id, url, project, category, chunk_text, added_at, ... }]
 */
export async function getSourcesByDate(space = 'academic', limit = 10, order = 'asc') {
  const db = await getDb();
  const ALLOWED_SPACES = ['academic', 'system', 'daily', 'default'];
  if (!ALLOWED_SPACES.includes(space)) space = 'academic';

  let sql = `SELECT DISTINCT doc_id, url, project, category, added_at, metadata FROM vectors`;
  if (space !== 'default') sql += ` WHERE metadata LIKE '%"space":"' || ? || '"%'`;
  sql += ` ORDER BY added_at ${order === 'desc' ? 'DESC' : 'ASC'} LIMIT ?`;

  const params = space !== 'default' ? [space, limit] : [limit];
  const rows = await db.all(sql, params);
  await db.close();

  return rows.map(r => ({
    doc_id: r.doc_id,
    url: r.url,
    project: r.project,
    category: r.category || 'Backend',
    added_at: r.added_at,
    metadata: (() => { try { return JSON.parse(r.metadata || '{}'); } catch { return {}; } })(),
  }));
}

// ── SỬA LỖI 1: ÉP QDRANT LÀM MẶC ĐỊNH (PRODUCTION-READY) ──
function shouldUseQdrant() {
  // Mặc định luôn bật Qdrant, trừ khi bị ép tắt (USE_QDRANT='false')
  const useQdrant = String(process.env.USE_QDRANT || 'true').toLowerCase() !== 'false';
  
  if (!qdrantStatusLogged) {
    if (useQdrant) {
      console.log('🚀 [vector_store] Primary Engine: Qdrant (Docker Container)');
    } else {
      console.warn('⚠️ [vector_store] Primary Engine: SQLite (Legacy). Expected performance degradation.');
    }
    qdrantStatusLogged = true;
  }
  
  return useQdrant;
}

// ===== Public API with Qdrant fallback & 3-Space Support =====
// ── SỬA LỖI 3: HỖ TRỢ TRUYỀN TÊN COLLECTION (SPACE) QUA METADATA ──

export async function upsertDocument(docId, metadata, chunks, embeddings) {
  // Bóc tách biến không gian (space), mặc định là 'academic' nếu không khai báo
  const targetSpace = metadata?.space || 'academic';

  if (shouldUseQdrant()) {
    try {
      const qdrant = await import('./vector_store_qdrant.js');
      // Chuyển targetSpace sang hàm Qdrant (phải đảm bảo vector_store_qdrant.js cũng bắt được tham số này)
      return await qdrant.upsertDocument(docId, metadata, chunks, embeddings, targetSpace);
    } catch (err) {
      console.warn(`[vector_store] Qdrant upsert failed for space '${targetSpace}', fallback to SQLite:`, err?.message || err);
      // fall through
    }
  }
  // 3. Thử BigQuery (nếu có credentials)
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.GCP_PROJECT_ID) {
    try {
      const bq = await import('./bigquery_store.js');
      const success = await bq.upsertDocument(docId, metadata, chunks, embeddings);
      if (success) return true;
    } catch (err) {
      console.warn(`[vector_store] BigQuery upsert failed, fallback to SQLite:`, err?.message || err);
    }
  }

  // 4. Fallback SQLite
  return sqliteUpsertDocument(docId, metadata, chunks, embeddings);
}

export async function search(queryEmbedding, topK = 5, space = 'academic') {
  // 1. Thử Qdrant trước (nếu có Docker)
  if (shouldUseQdrant()) {
    try {
      const qdrant = await import('./vector_store_qdrant.js');
      return await qdrant.search(queryEmbedding, topK, space);
    } catch (err) {
      console.warn(`[vector_store] Qdrant search failed, trying HNSW:`, err?.message || err);
    }
  }

  // 2. Thử HNSW in-memory (O(log N)) — chỉ dùng nếu có real data (không phải test data)
  if (_hnswIndex && _hnswIndex.count > 0) {
    try {
      const hnswResults = _hnswIndex.search(queryEmbedding, topK);
      // Kiểm tra score — nếu max score quá thấp (< 0.5), HNSW chỉ có test data, bỏ qua
      const maxScore = hnswResults.length > 0 ? (1.0 - hnswResults[0].distance) : 0;
      if (maxScore >= 0.5) {
        return hnswResults.map(r => {
          const meta = _hnswMeta.get(r.id) || {};
          return {
            score: 1.0 - r.distance,
            doc_id: meta.docId,
            chunk_index: meta.chunkIndex,
            chunk_text: meta.chunkText,
            url: meta.url || '',
            project: meta.project || '',
            category: meta.category || 'Backend',
            metadata: meta.metadata || {},
            added_at: meta.addedAt,
            source: 'hnsw',
          };
        });
      } else {
        console.warn(`[vector_store] HNSW max score ${maxScore.toFixed(3)} < 0.5, skipping (test data only), fallback to SQLite`);
      }
    } catch (err) {
      console.warn(`[vector_store] HNSW search failed, fallback to SQLite:`, err?.message || err);
    }
  }

  // 3. Thử BigQuery Vector Search (nếu có credentials)
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.GCP_PROJECT_ID) {
    try {
      const bq = await import('./bigquery_store.js');
      const bqResults = await bq.search(queryEmbedding, topK);
      if (bqResults.length > 0) {
        return bqResults;
      }
    } catch (err) {
      console.warn(`[vector_store] BigQuery search failed, fallback to SQLite:`, err?.message || err);
    }
  }

  // 4. Fallback SQLite brute-force (O(N))
  let results = await sqliteSearch(queryEmbedding, topK, space);
  // Fallback: nếu space filter return 0 results, thử lại với default (không filter space)
  if (results.length === 0 && space !== 'default') {
    console.warn(`[vector_store] SQLite search with space='${space}' returned 0 results, retrying with space='default'`);
    results = await sqliteSearch(queryEmbedding, topK, 'default');
  }
  return results;
}

/**
 * Thêm vector vào HNSW index (gọi khi upsert document)
 * @param {string} id — Vector ID
 * @param {Float32Array} embedding — Vector embedding
 * @param {Object} meta — Metadata (docId, chunkIndex, chunkText, ...)
 */
export function addToHnsw(id, embedding, meta = {}) {
  try {
    const dim = embedding.length;
    const index = getHnswIndex(dim);
    index.insert(id, embedding);
    _hnswMeta.set(id, meta);
  } catch (err) {
    console.warn(`[vector_store] HNSW insert failed:`, err?.message || err);
  }
}

/** Thống kê HNSW index */
export function getHnswStats() {
  if (!_hnswIndex) return { enabled: false, nodes: 0 };
  return { enabled: true, ..._hnswIndex.stats() };
}