const fs = require('fs');
let kg = fs.readFileSync('lib/knowledge_graph.js', 'utf8');
kg = kg.replace(/^\uFEFF/, '');

// Tier 4: Add media table
const mediaTable = `
  CREATE TABLE IF NOT EXISTS media_nodes (
    id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, media_type TEXT NOT NULL,
    url TEXT, title TEXT, description TEXT, duration_sec INTEGER,
    thumbnail_url TEXT, source TEXT, metadata TEXT DEFAULT '{}',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (entity_id) REFERENCES entities(id)
  );
  CREATE INDEX IF NOT EXISTS idx_media_entity ON media_nodes(entity_id);
  CREATE INDEX IF NOT EXISTS idx_media_type ON media_nodes(media_type);
`;

kg = kg.replace(
  "CREATE INDEX IF NOT EXISTS idx_aliases_entity ON entity_aliases(entity_id);",
  "CREATE INDEX IF NOT EXISTS idx_aliases_entity ON entity_aliases(entity_id);\n" + mediaTable
);

// Add media functions
const mediaFns = `
// -- Tier 4: Multimedia KG --
export async function addMediaNode(entityId, mediaData) {
  const db = await getDb();
  const id = "media:" + mediaData.media_type + ":" + Date.now();
  await db.run("INSERT INTO media_nodes (id, entity_id, media_type, url, title, description, duration_sec, thumbnail_url, source, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    id, entityId, mediaData.media_type, mediaData.url||null, mediaData.title||null, mediaData.description||null, mediaData.duration_sec||null, mediaData.thumbnail_url||null, mediaData.source||null, JSON.stringify(mediaData.metadata||{}));
  return id;
}
export async function getEntityMedia(entityId) {
  const db = await getDb();
  return await db.all("SELECT * FROM media_nodes WHERE entity_id = ? ORDER BY created_at DESC", entityId);
}
export async function searchMedia(mediaType, limit=20) {
  const db = await getDb();
  return await db.all("SELECT m.*, e.name as entity_name FROM media_nodes m JOIN entities e ON e.id = m.entity_id WHERE m.media_type = ? ORDER BY m.created_at DESC LIMIT ?", mediaType, limit);
}
export async function getMediaStats() {
  const db = await getDb();
  const stats = await db.all("SELECT media_type, COUNT(*) as count FROM media_nodes GROUP BY media_type");
  return { total: stats.reduce((s,r)=>s+r.count,0), breakdown: stats };
}
export async function linkMediaToKnowledgeGraph(mediaData, related=[]) {
  const entityId = await upsertEntity(mediaData.title||'Untitled', mediaData.media_type, mediaData.description);
  const mediaId = await addMediaNode(entityId, mediaData);
  for (const rel of related) await addRelationship(rel.source||entityId, rel.target, rel.relation||'related_to', rel.weight||0.5);
  return { entityId, mediaId };
}
`;

kg = kg.replace("/** Clear the entire knowledge graph. */", mediaFns + "\n/** Clear the entire knowledge graph. */");
kg = kg.replace("await db.run('DELETE FROM entities');", "await db.run('DELETE FROM media_nodes');\n  await db.run('DELETE FROM entities');");

fs.writeFileSync('lib/knowledge_graph.js', kg, 'utf8');
console.log('Tier 4: Multimedia KG added');
