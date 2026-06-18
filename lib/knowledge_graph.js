/**
 * Knowledge Graph Engine — Phase 19
 * SQLite-backed knowledge graph for entity relationships.
 * Stores entities (nodes) and relationships (edges) extracted from documents.
 * Enables graph-enhanced RAG: combine vector search + graph traversal.
 *
 * Schema:
 *   entities: id, name, type, description, metadata, created_at
 *   edges: id, source_id, target_id, relation, weight, created_at
 *   entity_aliases: alias, entity_id (for fuzzy matching)
 */

import { open } from './sqlite_adapter.js';
import path from 'path';
import { createHash } from 'crypto';

const KG_DB = path.resolve('./knowledge_graph.db');

let dbPromise = null;

export async function getDb() {
  if (dbPromise) return dbPromise;
  dbPromise = (async () => {
    const db = await open({ filename: KG_DB, driver: null });

    // ── WAL mode for crash safety on Cloud Run ──
    await db.exec('PRAGMA journal_mode=WAL');
    await db.exec('PRAGMA synchronous=NORMAL');
    await db.exec('PRAGMA foreign_keys=ON');

    await db.exec(`
      CREATE TABLE IF NOT EXISTS entities (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT DEFAULT 'concept',
        description TEXT DEFAULT '',
        domain TEXT DEFAULT 'general',
        metadata TEXT DEFAULT '{}',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS edges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        relation TEXT NOT NULL,
        weight REAL DEFAULT 1.0,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (source_id) REFERENCES entities(id),
        FOREIGN KEY (target_id) REFERENCES entities(id)
      );
      CREATE TABLE IF NOT EXISTS entity_aliases (
        alias TEXT PRIMARY KEY,
        entity_id TEXT NOT NULL,
        FOREIGN KEY (entity_id) REFERENCES entities(id)
      );
      CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name);
      CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);
      CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id);
      CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);
      CREATE INDEX IF NOT EXISTS idx_edges_relation ON edges(relation);
      CREATE INDEX IF NOT EXISTS idx_aliases_entity ON entity_aliases(entity_id);

  CREATE TABLE IF NOT EXISTS media_nodes (
    id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, media_type TEXT NOT NULL,
    url TEXT, title TEXT, description TEXT, duration_sec INTEGER,
    thumbnail_url TEXT, source TEXT, metadata TEXT DEFAULT '{}',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (entity_id) REFERENCES entities(id)
  );
  CREATE INDEX IF NOT EXISTS idx_media_entity ON media_nodes(entity_id);
  CREATE INDEX IF NOT EXISTS idx_media_type ON media_nodes(media_type);

    `);
    return db;
  })();
  return dbPromise;
}

/** Close the singleton connection (for graceful shutdown) */
export async function closeDb() {
  if (dbPromise) {
    const db = await dbPromise;
    await db.close();
    dbPromise = null;
  }
}

function makeEntityId(name, type) {
  const normalized = `${type}:${name.toLowerCase().trim()}`;
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

// ── Entity CRUD ──

/**
 * Add or update an entity.
 * @param {string} name - Entity name (e.g., "QuickSort", "Binary Tree")
 * @param {string} type - Entity type (e.g., "algorithm", "concept", "person", "technology")
 * @param {string} description - Short description
 * @param {object} metadata - Additional metadata
 * @returns {Promise<string>} entity id
 */
export async function upsertEntity(name, type = 'concept', description = '', metadata = {}) {
  const db = await getDb();
  const id = makeEntityId(name, type);
  const metaJson = JSON.stringify(metadata);

  db.prepare(
    `INSERT INTO entities (id, name, type, description, metadata, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       description = COALESCE(excluded.description, entities.description),
       metadata = COALESCE(excluded.metadata, entities.metadata),
       updated_at = datetime('now')`
  ).run(id, name, type, description, metaJson);

  return id;
}

/**
 * Get entity by ID.
 */
export async function getEntity(id) {
  const db = await getDb();
  const row = db.prepare('SELECT * FROM entities WHERE id = ?').get(id);
  if (!row) return null;
  try { row.metadata = JSON.parse(row.metadata || '{}'); } catch { row.metadata = {}; }
  return row;
}

/**
 * Search entities by name (fuzzy match).
 */
export async function searchEntities(query, type = null, limit = 10) {
  const db = await getDb();
  const pattern = `%${query.toLowerCase()}%`;
  let sql = 'SELECT * FROM entities WHERE (name LIKE ? OR description LIKE ?)';
  const params = [pattern, pattern];
  if (type) { sql += ' AND type = ?'; params.push(type); }
  sql += ' ORDER BY name LIMIT ?';
  params.push(limit);
  const rows = db.prepare(sql).all(...params);
  for (const r of rows) {
    try { r.metadata = JSON.parse(r.metadata || '{}'); } catch { r.metadata = {}; }
  }
  return rows;
}

// ── Edge / Relationship CRUD ──

/**
 * Add a relationship between two entities.
 * Auto-creates entities if they don't exist.
 */
export async function addRelationship(sourceName, targetName, relation, weight = 1.0, sourceType = 'concept', targetType = 'concept') {
  const db = await getDb();
  const sourceId = await upsertEntity(sourceName, sourceType);
  const targetId = await upsertEntity(targetName, targetType);

  db.prepare(
    `INSERT INTO edges (source_id, target_id, relation, weight) VALUES (?, ?, ?, ?)`
  ).run(sourceId, targetId, relation, weight);

  return { sourceId, targetId, relation, weight };
}

/**
 * Get all relationships for an entity (both directions).
 */
export async function getRelationships(entityId) {
  const db = await getDb();
  const outgoing = db.prepare(
    `SELECT e.name as source_name, t.name as target_name, r.relation, r.weight, r.id as edge_id
     FROM edges r
     JOIN entities e ON e.id = r.source_id
     JOIN entities t ON t.id = r.target_id
     WHERE r.source_id = ?`
  ).all(entityId);
  const incoming = db.prepare(
    `SELECT e.name as source_name, t.name as target_name, r.relation, r.weight, r.id as edge_id
     FROM edges r
     JOIN entities e ON e.id = r.source_id
     JOIN entities t ON t.id = r.target_id
     WHERE r.target_id = ?`
  ).all(entityId);
  return { outgoing, incoming };
}

/**
 * Graph traversal: BFS from a starting entity.
 * Returns entities and edges within `depth` hops.
 */
export async function traverseGraph(startEntityId, depth = 2) {
  const db = await getDb();
  const visited = new Set([startEntityId]);
  const queue = [{ id: startEntityId, dist: 0 }];
  const nodes = [];
  const links = [];

  while (queue.length > 0) {
    const { id, dist } = queue.shift();
    if (dist > depth) break;

    const entity = await getEntity(id);
    if (entity) nodes.push({ ...entity, depth: dist });

    if (dist < depth) {
      const edges = db.prepare(
        'SELECT * FROM edges WHERE source_id = ? OR target_id = ?'
      ).all(id, id);
      for (const edge of edges) {
        links.push(edge);
        const next = edge.source_id === id ? edge.target_id : edge.source_id;
        if (!visited.has(next)) {
          visited.add(next);
          queue.push({ id: next, dist: dist + 1 });
        }
      }
    }
  }

  return { nodes, links: [...new Map(links.map(l => [l.id, l])).values()] };
}

/**
 * Get graph statistics.
 */
export async function getGraphStats() {
  const db = await getDb();
  const entities = db.prepare('SELECT COUNT(*) as n FROM entities').get();
  const edges = db.prepare('SELECT COUNT(*) as n FROM edges').get();
  const types = db.prepare('SELECT type, COUNT(*) as count FROM entities GROUP BY type ORDER BY count DESC').all();
  const relations = db.prepare('SELECT relation, COUNT(*) as count FROM edges GROUP BY relation ORDER BY count DESC LIMIT 10').all();
  return {
    totalEntities: entities.n,
    totalEdges: edges.n,
    entityTypes: types,
    topRelations: relations,
  };
}

/**
 * Clear the entire knowledge graph.
 */
export async function clearGraph() {
  const db = await getDb();
  db.prepare('DELETE FROM edges').run();
  db.prepare('DELETE FROM entity_aliases').run();
  db.prepare('DELETE FROM media_nodes').run();
  db.prepare('DELETE FROM entities').run();
}

/**
 * Export graph data for visualization (D3.js / Cytoscape format).
 */
export async function exportGraphForVisualization() {
  const db = await getDb();
  const entities = db.prepare('SELECT id, name, type, description FROM entities').all();
  const edges = db.prepare('SELECT source_id, target_id, relation, weight FROM edges').all();

  return {
    nodes: entities.map(e => ({ id: e.id, label: e.name, group: e.type, description: e.description })),
    edges: edges.map(e => ({ source: e.source_id, target: e.target_id, label: e.relation, weight: e.weight })),
  };
}
