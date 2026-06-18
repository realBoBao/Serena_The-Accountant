/**
 * Qdrant Multi-Collection Manager
 * Quản lý 3 không gian vector chuyên biệt:
 * - academic-docs: Kiến thức nền tảng, bài giảng, tài liệu lý thuyết
 * - system-logs: Các bản ghi lỗi, cách cấu hình hệ thống
 * - daily-memory: Trí nhớ cá nhân tổng hợp hàng ngày
 */

const QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:6333';

const COLLECTIONS = {
  ACADEMIC: 'academic-docs',
  SYSTEM: 'system-logs',
  DAILY: 'daily-memory'
};

async function ensureCollection(collectionName, vectorSize) {
  const url = `${QDRANT_URL}/collections/${encodeURIComponent(collectionName)}`;
  const res = await fetch(url, { method: 'GET' });
  if (res.ok) return true;

  const createRes = await fetch(url, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      vectors: { size: vectorSize, distance: 'Cosine' },
    }),
  });

  if (!createRes.ok) {
    const text = await createRes.text().catch(() => '');
    throw new Error(`Qdrant create collection ${collectionName} failed: ${createRes.status} ${text}`.trim());
  }
  return true;
}

function float32ToArray(arr) {
  return Array.from(arr);
}

async function upsertDocument(collectionName, docId, metadata = {}, chunks = [], embeddings = []) {
  if (!docId || !Array.isArray(chunks) || !Array.isArray(embeddings) || chunks.length !== embeddings.length) {
    throw new Error('Invalid input to upsertDocument');
  }

  const vectorSize = embeddings?.[0]?.length;
  if (!vectorSize || vectorSize === 0) {
    throw new Error(`Cannot infer embedding vector size (embeddings: ${embeddings?.length || 0}, first: ${typeof embeddings?.[0]})`);
  }

  await ensureCollection(collectionName, vectorSize);

  const points = chunks.map((chunkText, i) => ({
    id: `${docId}::${i}`,
    payload: {
      doc_id: docId,
      chunk_index: i,
      chunk_text: chunkText,
      url: metadata.url || '',
      project: metadata.project || '',
      category: metadata.category || 'General',
      type: metadata.type || 'document',
      metadata: JSON.stringify(metadata || {}),
      added_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    vector: float32ToArray(embeddings[i]),
  }));

  const res = await fetch(`${QDRANT_URL}/collections/${encodeURIComponent(collectionName)}/points?wait=true`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ points }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Qdrant upsert failed: ${res.status} ${text}`.trim());
  }
  return true;
}

async function searchCollection(collectionName, queryEmbedding, topK = 5, category = null) {
  if (!Array.isArray(queryEmbedding)) {
    throw new Error('Invalid queryEmbedding');
  }

  const filter = category
    ? { must: [{ key: 'category', match: { value: category } }] }
    : undefined;

  const res = await fetch(`${QDRANT_URL}/collections/${encodeURIComponent(collectionName)}/points/search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ vector: queryEmbedding, limit: topK, with_payload: true, ...(filter ? { filter } : {}) }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Qdrant search failed: ${res.status} ${text}`.trim());
  }

  const data = await res.json();
  return (data?.result || []).map((hit) => {
    const payload = hit.payload || {};
    let metadataObj = {};
    try { metadataObj = payload.metadata ? JSON.parse(payload.metadata) : {}; } catch (_) {}
    return {
      score: hit.score,
      doc_id: payload.doc_id,
      chunk_index: payload.chunk_index,
      chunk_text: payload.chunk_text,
      url: payload.url,
      project: payload.project,
      category: payload.category || 'General',
      type: payload.type || 'document',
      metadata: metadataObj,
    };
  });
}

// Convenience functions for each collection
async function upsertAcademic(docId, metadata, chunks, embeddings) {
  return upsertDocument(COLLECTIONS.ACADEMIC, docId, metadata, chunks, embeddings);
}

async function upsertSystem(docId, metadata, chunks, embeddings) {
  return upsertDocument(COLLECTIONS.SYSTEM, docId, metadata, chunks, embeddings);
}

async function upsertDaily(docId, metadata, chunks, embeddings) {
  return upsertDocument(COLLECTIONS.DAILY, docId, metadata, chunks, embeddings);
}

async function searchAcademic(queryEmbedding, topK = 5, category = null) {
  return searchCollection(COLLECTIONS.ACADEMIC, queryEmbedding, topK, category);
}

async function searchSystem(queryEmbedding, topK = 5, category = null) {
  return searchCollection(COLLECTIONS.SYSTEM, queryEmbedding, topK, category);
}

async function searchDaily(queryEmbedding, topK = 5, category = null) {
  return searchCollection(COLLECTIONS.DAILY, queryEmbedding, topK, category);
}

/**
 * Search system-logs collection by text (uses embedding internally)
 * Helper for EvoAgent to find OOM/error entries
 */
async function searchSystemLogs(queryText, topK = 5) {
  try {
    const { embedText } = await import('./embeddings.js');
    const embedding = await embedText(queryText);
    return searchCollection(COLLECTIONS.SYSTEM, embedding, topK);
  } catch {
    return [];
  }
}

/**
 * Search all 3 collections simultaneously
 * Helper for GraphAgent sync & EvoAgent knowledge gap detection
 */
async function searchAll(queryText, topK = 5) {
  try {
    const { embedText } = await import('./embeddings.js');
    const embedding = await embedText(queryText);
    const [academic, system, daily] = await Promise.all([
      searchCollection(COLLECTIONS.ACADEMIC, embedding, topK).catch(() => []),
      searchCollection(COLLECTIONS.SYSTEM, embedding, topK).catch(() => []),
      searchCollection(COLLECTIONS.DAILY, embedding, topK).catch(() => []),
    ]);
    return [...academic, ...system, ...daily];
  } catch {
    return [];
  }
}

export {
  COLLECTIONS,
  ensureCollection,
  upsertDocument,
  searchCollection,
  upsertAcademic,
  upsertSystem,
  upsertDaily,
  searchAcademic,
  searchSystem,
  searchDaily,
  searchSystemLogs,
  searchAll
};