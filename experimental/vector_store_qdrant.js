import crypto from 'crypto';

/**
 * Qdrant REST client (lightweight).
 * Uses HTTP calls directly to avoid client version mismatch.
 */
const QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:6333';

// ── SỬA LỖI BƠM: Hàm tạo UUID lũy đẳng từ chuỗi bất kỳ ──
// Qdrant BẮT BUỘC id phải là UInt hoặc chuẩn UUID string.
function stringToUuid(str) {
  const hash = crypto.createHash('md5').update(str).digest('hex');
  // Ép định dạng MD5 thành form UUID (ví dụ: 123e4567-e89b-12d3-a456-426614174000)
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

/**
 * Ensure collection exists dynamically based on the "space" parameter.
 */
async function ensureCollection(collectionName, vectorSize) {
  const url = `${QDRANT_URL}/collections/${encodeURIComponent(collectionName)}`;
  const res = await fetch(url, { method: 'GET' });
  if (res.ok) return true;

  const upsertBody = {
    vectors: {
      size: vectorSize,
      distance: 'Cosine',
    },
  };

  // Create (best-effort)
  const createRes = await fetch(url, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(upsertBody),
  });

  if (!createRes.ok) {
    // Let caller decide fallback
    const text = await createRes.text().catch(() => '');
    throw new Error(`Qdrant create collection failed: ${createRes.status} ${text}`.trim());
  }

  return true;
}

function float32ToArray(arr) {
  // Qdrant expects normal JS arrays of numbers
  return Array.from(arr);
}

// ── NÂNG CẤP TẦNG ROUTER: Nhận tham số 'space' để nhét vào 3 Collection ──
export async function upsertDocument(docId, metadata = {}, chunks = [], embeddings = [], space = 'academic') {
  if (!docId || !Array.isArray(chunks) || !Array.isArray(embeddings) || chunks.length !== embeddings.length) {
    throw new Error('Invalid input to Qdrant upsertDocument');
  }

  const vectorSize = embeddings[0]?.length;
  if (!vectorSize) throw new Error('Cannot infer embedding vector size for Qdrant');

  const collectionName = space; // Chuyển 'space' thành collection
  await ensureCollection(collectionName, vectorSize);

  // Qdrant points: one per chunk
  const points = chunks.map((chunkText, i) => {
    const rawId = `${docId}::${i}`;
    const validUuid = stringToUuid(rawId); // Chuyển sang UUID hợp lệ
    
    return {
      id: validUuid,
      payload: {
        doc_id: docId, // Vẫn lưu rawId trong payload để tra cứu ngược
        chunk_index: i,
        chunk_text: chunkText,
        url: metadata.url || '',
        project: metadata.project || '',
        category: metadata.category || 'Backend',
        metadata: JSON.stringify(metadata || {}),
        added_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      vector: float32ToArray(embeddings[i]),
    };
  });

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

// ── NÂNG CẤP TẦNG ROUTER: Chỉ định 'space' khi search ──
export async function search(queryEmbedding, topK = 5, space = 'academic') {
  if (!Array.isArray(queryEmbedding)) {
    throw new Error('Invalid queryEmbedding for Qdrant search');
  }

  const collectionName = space; // Chỉ tìm trong Collection cụ thể

  // Qdrant requires POST search
  const body = {
    vector: queryEmbedding,
    limit: topK,
    with_payload: true,
  };

  const res = await fetch(`${QDRANT_URL}/collections/${encodeURIComponent(collectionName)}/points/search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Qdrant search failed: ${res.status} ${text}`.trim());
  }

  const data = await res.json();
  const result = (data?.result || []).map((hit) => {
    const payload = hit.payload || {};
    let metadataObj = {};
    try {
      metadataObj = payload.metadata ? JSON.parse(payload.metadata) : {};
    } catch (_) {
      metadataObj = {};
    }
    return {
      score: hit.score,
      doc_id: payload.doc_id,
      chunk_index: payload.chunk_index,
      chunk_text: payload.chunk_text,
      url: payload.url,
      project: payload.project,
      category: payload.category || 'Backend',
      metadata: metadataObj,
      added_at: payload.added_at,
      updated_at: payload.updated_at,
    };
  });

  return result;
}