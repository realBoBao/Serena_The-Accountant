/**
 * lib/bigquery_store.js — BigQuery Vector Store
 *
 * Thay thế Qdrant bằng BigQuery làm vector search backend.
 * BigQuery hỗ trợ:
 * - 10GB lưu trữ miễn phí/tháng
 * - 1TB query miễn phí/tháng
 * - Vector search với VECTOR_SEARCH function
 * - BigQuery ML cho embedding generation
 *
 * Setup:
 * 1. Tạo dataset: CREATE SCHEMA `agent_memory`
 * 2. Tạo table: CREATE TABLE `agent_memory.rag_knowledge` (id STRING, content STRING, embedding ARRAY<FLOAT64>, source STRING, created_at TIMESTAMP)
 * 3. Tạo vector index: CREATE VECTOR INDEX ON `agent_memory.rag_knowledge`(embedding)
 *
 * Usage:
 * import { BigQueryStore } from './lib/bigquery_store.js';
 * const store = new BigQueryStore();
 * await store.upsert(docId, embedding, metadata, chunks);
 * const results = await store.search(queryEmbedding, 5);
 */

import { getLogger } from './logger.js';

const logger = getLogger('BigQueryStore');

let _bigqueryClient = null;
let _datasetId = null;
let _tableId = null;

function getBigQuery() {
  if (!_bigqueryClient) {
    try {
      const { BigQuery } = require('@google-cloud/bigquery');
      _bigqueryClient = new BigQuery({
        projectId: process.env.GCP_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT,
      });
      _datasetId = process.env.BQ_DATASET_ID || 'agent_memory';
      _tableId = process.env.BQ_TABLE_ID || 'rag_knowledge';
    } catch (err) {
      logger.error('[BigQuery] Init failed:', err.message);
      throw err;
    }
  }
  return _bigqueryClient;
}

/**
 * Tạo dataset và table nếu chưa tồn tại.
 */
export async function ensureTable() {
  const bq = getBigQuery();
  const dataset = bq.dataset(_datasetId);

  // Tạo dataset nếu chưa có
  const [datasetExists] = await dataset.exists();
  if (!datasetExists) {
    logger.info(`[BigQuery] Creating dataset ${_datasetId}...`);
    await dataset.create();
    logger.info(`[BigQuery] Dataset ${_datasetId} created`);
  }

  const table = dataset.table(_tableId);

  // Tạo table nếu chưa có
  const [tableExists] = await table.exists();
  if (!tableExists) {
    logger.info(`[BigQuery] Creating table ${_tableId}...`);
    const schema = [
      { name: 'id', type: 'STRING', mode: 'REQUIRED' },
      { name: 'content', type: 'STRING', mode: 'NULLABLE' },
      { name: 'embedding', type: 'FLOAT64', mode: 'REPEATED' },
      { name: 'source', type: 'STRING', mode: 'NULLABLE' },
      { name: 'category', type: 'STRING', mode: 'NULLABLE' },
      { name: 'metadata', type: 'STRING', mode: 'NULLABLE' },
      { name: 'created_at', type: 'TIMESTAMP', mode: 'NULLABLE' },
    ];
    await table.create({ schema });
    logger.info(`[BigQuery] Table ${_tableId} created`);
  }

  return table;
}

/**
 * Upsert documents vào BigQuery.
 * @param {string} docId - Document ID
 * @param {Float32Array} embedding - Embedding vector
 * @param {object} metadata - { source, category, ... }
 * @param {string[]} chunks - Text chunks
 */
export async function upsertDocument(docId, metadata = {}, chunks = [], embeddings = []) {
  try {
    const bq = getBigQuery();
    await ensureTable();

    const rows = chunks.map((chunk, i) => ({
      id: `${docId}::${i}`,
      content: chunk.slice(0, 10000), // BigQuery STRING limit
      embedding: Array.from(embeddings[i] || []),
      source: metadata.source || metadata.url || '',
      category: metadata.category || 'General',
      metadata: JSON.stringify(metadata).slice(0, 1000),
      created_at: new Date().toISOString(),
    }));

    // BigQuery streaming insert
    const table = bq.dataset(_datasetId).table(_tableId);
    await table.insert(rows, { raw: true });

    logger.info(`[BigQuery] Upserted ${rows.length} rows for ${docId}`);
    return true;
  } catch (err) {
    logger.error(`[BigQuery] Upsert failed for ${docId}:`, err.message);
    return false;
  }
}

/**
 * Vector search trong BigQuery.
 * @param {Float32Array} queryEmbedding - Query embedding vector
 * @param {number} topK - Số lượng kết quả
 * @returns {Array} - [{ id, content, source, score }]
 */
export async function search(queryEmbedding, topK = 5) {
  try {
    const bq = getBigQuery();
    await ensureTable();

    // Sử dụng VECTOR_SEARCH function của BigQuery
    const query = `
      SELECT
        base.id,
        base.content,
        base.source,
        base.category,
        base.metadata,
        distance AS score
      FROM VECTOR_SEARCH(
        TABLE \`${_datasetId}.${_tableId}\`,
        'embedding',
        (SELECT [${Array.from(queryEmbedding).join(', ')}] AS embedding),
        top_k => ${topK},
        distance_type => 'COSINE'
      )
      ORDER BY score ASC
      LIMIT ${topK}
    `;

    const [rows] = await bq.query(query);

    return rows.map(r => ({
      id: r.id,
      doc_id: r.id,
      chunk_text: r.content,
      source: r.source,
      category: r.category,
      metadata: (() => { try { return JSON.parse(r.metadata); } catch { return {}; } })(),
      score: 1 - r.score, // Convert distance to similarity (cosine)
    }));
  } catch (err) {
    logger.warn('[BigQuery] Search failed:', err.message);
    return [];
  }
}

/**
 * Xóa documents theo docId prefix.
 */
export async function deleteDocuments(docId) {
  try {
    const bq = getBigQuery();
    const query = `
      DELETE FROM \`${_datasetId}.${_tableId}\`
      WHERE STARTS_WITH(id, @docId)
    `;
    await bq.query({
      query,
      params: { docId: `${docId}::` },
    });
    logger.info(`[BigQuery] Deleted documents for ${docId}`);
    return true;
  } catch (err) {
    logger.error(`[BigQuery] Delete failed for ${docId}:`, err.message);
    return false;
  }
}

/**
 * Đếm số documents trong table.
 */
export async function countDocuments() {
  try {
    const bq = getBigQuery();
    const query = `SELECT COUNT(*) as n FROM \`${_datasetId}.${_tableId}\``;
    const [rows] = await bq.query(query);
    return rows[0]?.n || 0;
  } catch {
    return 0;
  }
}

export default { ensureTable, upsertDocument, search, deleteDocuments, countDocuments };
