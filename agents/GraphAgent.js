/**
 * GraphAgent — Kỹ sư Đồ thị Tri thức (Standalone PM2 Service)
 *
 * Background maintenance agent: extracts entities (via LLM/Regex hybrid),
 * builds relationships, repairs broken graph connections, and syncs with vector store.
 * Runs independently via PM2 + BullMQ worker.
 *
 * @module agents/GraphAgent
 */

import { createWorker, addJob, JobType, QueueName } from '../lib/task_queue.js';
import { invokeLlm } from './RagAgent.js'; // Tích hợp động cơ Tier-2 OpenRouter
import { HumanMessage } from '@langchain/core/messages';
import { embedText } from '../lib/embeddings.js';

// ── Module-level state ──
const state = {
  worker: null,
  isRunning: false,
  neo4jUri: process.env.NEO4J_URI || 'bolt://localhost:7687',
  neo4jUser: process.env.NEO4J_USER || 'neo4j',
  neo4jPass: process.env.NEO4J_PASSWORD || 'password',
  driver: null,
  inMemoryGraph: { nodes: new Map(), edges: new Map() },
  extractionStats: { totalEntities: 0, totalRelationships: 0, lastRun: null },
  maxNodes: 5000,
  maxEdges: 10000,
};

// ── Neo4j Connection ──
async function connectNeo4j() {
  try {
    const neo4j = await import('neo4j-driver');
    state.driver = neo4j.driver(
      state.neo4jUri,
      neo4j.auth.basic(state.neo4jUser, state.neo4jPass),
      { maxConnectionPoolSize: 5 }
    );
    await state.driver.verifyConnectivity();
    console.log('🌐 [GraphAgent] Neo4j connected successfully');

    const session = state.driver.session();
    try {
      await session.run('CREATE CONSTRAINT entity_name IF NOT EXISTS FOR (e:Entity) REQUIRE e.name IS UNIQUE');
    } finally {
      await session.close();
    }
  } catch (err) {
    console.warn('⚠️ [GraphAgent] Neo4j unavailable, falling back to safe In-Memory Graph:', err.message);
    state.driver = null;
  }
}

// ── Job Processor ──
async function processJob(job) {
  const { name, data } = job;
  console.log(`⚙️ [GraphAgent] Processing job: ${name}`);

  switch (name) {
    case JobType.EXTRACT_ENTITIES:
      return extractEntities(data);
    case JobType.BUILD_RELATIONSHIPS:
      return buildRelationships(data);
    case JobType.REPAIR_GRAPH_CONNECTIONS:
      return repairConnections(data);
    case JobType.SYNC_GRAPH:
      return syncGraph(data);
    default:
      return { skipped: true, reason: 'unknown_job_type' };
  }
}

// ── Entity Extraction (SỬA LỖI 1: ÁP DỤNG LLM ĐỂ BÓC TÁCH CHUẨN XÁC) ──
async function extractEntities(data) {
  const { text, source, docId } = data;
  if (!text) return { extracted: 0, reason: 'no_text' };

  let entities = [];
  
  // Dùng LLM cho đoạn text quan trọng (1500 ký tự đầu) để lấy hạt nhân tri thức
  const coreText = text.slice(0, 1500);
  try {
    const prompt = `Extract highly specific SOFTWARE ENGINEERING and COMPUTER SCIENCE entities (Tools, Concepts, Languages, Frameworks, Architecture) from the text. 
Ignore common words, people, and generic verbs.
Return ONLY a valid JSON array of objects with 'name', 'type' (CONCEPT or TECH), and 'confidence' (0.0-1.0).
TEXT: "${coreText.replace(/"/g, "'")}"`;

    const rawJson = await invokeLlm([new HumanMessage(prompt)], 'EntityExtraction');
    const jsonStart = rawJson.indexOf('[');
    const jsonEnd = rawJson.lastIndexOf(']');
    if (jsonStart >= 0 && jsonEnd > jsonStart) {
       entities = JSON.parse(rawJson.slice(jsonStart, jsonEnd + 1));
    }
  } catch (err) {
    console.warn('LLM Extraction failed, falling back to Regex:', err?.message);
    entities = regexExtractEntities(coreText);
  }

  let saved = 0;
  for (const entity of entities) {
    if (!entity.name || entity.name.length < 2) continue;
    if (state.driver) {
      await saveEntityNeo4j(entity, source, docId);
    } else {
      saveEntityInMemory(entity, source, docId);
    }
    saved++;
  }

  state.extractionStats.totalEntities += saved;
  state.extractionStats.lastRun = new Date().toISOString();

  // Bắn Job nối quan hệ (Relationship) ngay khi bóc thực thể xong
  if (saved > 0) {
    await addJob(QueueName.GRAPH, JobType.BUILD_RELATIONSHIPS, { 
       text, 
       entities: entities.map(e => e.name), 
       docId 
    });
  }

  return { extracted: saved, entities: entities.map(e => e.name), source };
}

function regexExtractEntities(text) {
  const entities = [];
  const seen = new Set();
  const techTerms = text.match(/\b[A-Z]{2,}\b|\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b/g) || [];
  for (const term of techTerms) {
    if (!seen.has(term.toLowerCase()) && term.length > 2) {
      seen.add(term.toLowerCase());
      entities.push({ name: term, type: 'TECH', confidence: 0.5 });
    }
  }
  return entities.slice(0, 30);
}

async function saveEntityNeo4j(entity, source, docId) {
  const session = state.driver.session();
  try {
    await session.run(
      `MERGE (e:Entity {name: $name})
       ON CREATE SET e.type = $type, e.confidence = $confidence, e.source = $source, e.createdAt = datetime()
       ON MATCH SET e.confidence = CASE WHEN e.confidence < $confidence THEN $confidence ELSE e.confidence END`,
      { name: entity.name, type: entity.type || 'CONCEPT', confidence: entity.confidence || 0.5, source: source || 'unknown' }
    );
  } finally {
    await session.close();
  }
}

function saveEntityInMemory(entity, source, docId) {
  const key = entity.name.toLowerCase();
  if (!state.inMemoryGraph.nodes.has(key)) {
    // Evict oldest node if at capacity
    if (state.inMemoryGraph.nodes.size >= state.maxNodes) {
      const oldestKey = state.inMemoryGraph.nodes.keys().next().value;
      state.inMemoryGraph.nodes.delete(oldestKey);
    }
    state.inMemoryGraph.nodes.set(key, { ...entity, source, docId, createdAt: Date.now(), connections: 0 });
  }
}

// ── Relationship Building ──
async function buildRelationships(data) {
  const { text, entities: entityNames, docId } = data;
  let relationships = [];

  if (state.driver) {
    relationships = await buildRelationshipsNeo4j(entityNames, text);
  } else {
    relationships = buildRelationshipsInMemory(entityNames, text);
  }

  state.extractionStats.totalRelationships += relationships.length;
  return { built: relationships.length, relationships: relationships.slice(0, 10) };
}

async function buildRelationshipsNeo4j(entityNames, text) {
  const relationships = [];
  if (!entityNames || entityNames.length < 2) return relationships;

  const session = state.driver.session();
  try {
    const sentences = text.split(/[.!?]+/);
    for (const sentence of sentences) {
      const present = entityNames.filter(e => sentence.toLowerCase().includes(e.toLowerCase()));
      for (let i = 0; i < present.length; i++) {
        for (let j = i + 1; j < present.length; j++) {
          await session.run(
            `MATCH (a:Entity {name: $a}), (b:Entity {name: $b})
             MERGE (a)-[r:RELATED_TO]->(b)
             ON CREATE SET r.strength = 1, r.context = $ctx
             ON MATCH SET r.strength = r.strength + 1`,
            { a: present[i], b: present[j], ctx: sentence.slice(0, 150) }
          );
          relationships.push({ from: present[i], to: present[j], type: 'RELATED_TO' });
        }
      }
    }
  } finally {
    await session.close();
  }
  return relationships;
}

// SỬA LỖI 3: VÁ RÒ RỈ RAM BẰNG CÁCH DÙNG MAP DEDUPLICATION
function buildRelationshipsInMemory(entityNames, text) {
  const relationships = [];
  if (!entityNames || entityNames.length < 2) return relationships;

  const sentences = text.split(/[.!?]+/);
  for (const sentence of sentences) {
    const present = entityNames.filter(e => sentence.toLowerCase().includes(e.toLowerCase()));
    for (let i = 0; i < present.length; i++) {
      for (let j = i + 1; j < present.length; j++) {
        const edgeKey = [present[i], present[j]].sort().join('::').toLowerCase();
        
        if (state.inMemoryGraph.edges.has(edgeKey)) {
          // Edge đã tồn tại -> Chỉ tăng sức mạnh (strength)
          const edge = state.inMemoryGraph.edges.get(edgeKey);
          edge.strength += 1;
        } else {
          // Edge mới -> Tạo mới
          state.inMemoryGraph.edges.set(edgeKey, {
            from: present[i], to: present[j], type: 'RELATED_TO',
            context: sentence.slice(0, 100), strength: 1,
          });
          
          const nodeA = state.inMemoryGraph.nodes.get(present[i].toLowerCase());
          const nodeB = state.inMemoryGraph.nodes.get(present[j].toLowerCase());
          if (nodeA) nodeA.connections++;
          if (nodeB) nodeB.connections++;
        }
        relationships.push({ from: present[i], to: present[j] });
      }
    }
  }
  return relationships;
}

// ── Graph Repair ──
async function repairConnections(data) {
  console.log('🔧 [GraphAgent] Repairing broken graph connections');
  const repairs = [];

  if (state.driver) {
    const session = state.driver.session();
    try {
      const result = await session.run(
        `MATCH (n:Entity) WHERE NOT (n)--()
         WITH n LIMIT 50
         MATCH (m:Entity) WHERE m.type = n.type AND id(m) <> id(n)
         WITH n, m, rand() AS r ORDER BY r LIMIT 1
         MERGE (n)-[r:RELATED_TO {auto: true, repairedAt: datetime()}]->(m)
         RETURN n.name AS from, m.name AS to`
      );
      for (const record of result.records) {
        repairs.push({ from: record.get('from'), to: record.get('to'), action: 'reconnected' });
      }
    } finally {
      await session.close();
    }
  } else {
    // In-Memory Repair
    for (const [key, node] of state.inMemoryGraph.nodes) {
      if (node.connections === 0) {
        let connected = false;
        for (const [otherKey, otherNode] of state.inMemoryGraph.nodes) {
          if (otherKey !== key && otherNode.type === node.type) {
            const edgeKey = [node.name, otherNode.name].sort().join('::').toLowerCase();
            state.inMemoryGraph.edges.set(edgeKey, {
              from: node.name, to: otherNode.name, type: 'RELATED_TO', auto: true, strength: 0.5,
            });
            node.connections++;
            otherNode.connections++;
            repairs.push({ from: node.name, to: otherNode.name, action: 'reconnected' });
            connected = true;
            break;
          }
        }
        if (!connected) repairs.push({ from: node.name, action: 'still_orphaned' });
      }
    }
  }

  console.log(`[GraphAgent] Repaired ${repairs.filter(r => r.action === 'reconnected').length} connections`);
  return { repaired: repairs.length, repairs };
}

// ── Graph Sync (SỬA LỖI 2: TRÁNH CRASH KHI GỌI VECTOR DB) ──
async function syncGraph(data) {
  console.log('🔄 [GraphAgent] Syncing graph with vector store');
  const synced = { nodes: 0, edges: 0 };

  try {
    const { search } = await import('../lib/vector_store.js');
    // Dùng một vector nhúng (embedding) khái quát để mồi (seed) dữ liệu thay vì '*'
    // Từ khóa mồi: "Software Engineering System Design AI"
    const seedEmbedding = await embedText("Software Engineering System Design AI DevOps Microservices");
    
    // Tìm 50 chunks liên quan nhất từ không gian 'academic'
    const docs = await search(seedEmbedding, 10, 'academic');
    
    if (docs && docs.length > 0) {
      for (const doc of docs) {
        if (doc.chunk_text) {
           // Bắn thẳng Job Extract Entity vào Queue để Worker từ từ bóc tách, tránh kẹt luồng
           await addJob(QueueName.GRAPH, JobType.EXTRACT_ENTITIES, {
             text: doc.chunk_text,
             source: doc.url || 'vector_db',
             docId: doc.doc_id
           });
           synced.nodes++;
        }
      }
    }
  } catch (err) {
    console.warn('⚠️ [GraphAgent] Sync error:', err.message);
  }

  return { syncedChunksQueued: synced.nodes, timestamp: new Date().toISOString() };
}

// ── Lifecycle ──
async function start() {
  if (state.isRunning) return;
  state.isRunning = true;

  await connectNeo4j();

  state.worker = createWorker(
    QueueName.GRAPH,
    (job) => processJob(job),
    { concurrency: 1 } // Giữ Concurrency 1 để chống đụng độ Transaction trong Neo4j
  );

  console.log('🚀 [GraphAgent] Background Service Started');
}

async function stop() {
  console.log('[GraphAgent] Stopping...');
  state.isRunning = false;
  if (state.worker) await state.worker.close();
  if (state.driver) await state.driver.close();
  console.log('🛑 [GraphAgent] Stopped');
}

function getStatus() {
  return {
    isRunning: state.isRunning,
    neo4jConnected: !!state.driver,
    inMemoryNodes: state.inMemoryGraph.nodes.size,
    inMemoryEdges: state.inMemoryGraph.edges.size,
    stats: { ...state.extractionStats },
  };
}

async function queryGraph(query) {
  if (state.driver) {
    const session = state.driver.session();
    try {
      const result = await session.run(query);
      return result.records.map(r => r.toObject());
    } finally {
      await session.close();
    }
  } else {
    return {
      nodes: Array.from(state.inMemoryGraph.nodes.values()).slice(0, 20),
      edges: Array.from(state.inMemoryGraph.edges.values()).slice(0, 20),
    };
  }
}

// ── Graceful Shutdown ──
async function gracefulShutdown(signal) {
  console.log(`\n[GraphAgent] Received ${signal}, shutting down...`);
  await stop();
  process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// ── Auto-start ──
start();

export { start, stop, getStatus, queryGraph, processJob };