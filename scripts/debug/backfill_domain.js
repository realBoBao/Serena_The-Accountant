/**
 * scripts/backfill_domain.js — Backfill domain metadata cho vectors cũ
 *
 * Vấn đề: 514 vectors trong DB không có field `domain`, chỉ có `category`.
 * Kết quả: Retrieval bị lỗi (tìm bài rap khi hỏi backend).
 *
 * Giải pháp: Đọc tất cả entities/vectors, gán domain dựa + category + name.
 *
 * Usage: node scripts/backfill_domain.js
 */

import { getDb } from '../lib/sqlite_adapter.js';

// ── Domain mapping rules ────────────────────────────────────────────────────
const DOMAIN_RULES = [
  // Backend / Server
  { domain: 'backend', keywords: ['backend', 'server', 'api', 'rest', 'graphql', 'microservice', 'endpoint', 'middleware', 'express', 'fastapi', 'django', 'spring', 'node', 'nginx', 'apache'] },
  // DevOps / Infrastructure
  { domain: 'devops', keywords: ['devops', 'docker', 'kubernetes', 'k8s', 'deploy', 'ci/cd', 'terraform', 'ansible', 'jenkins', 'github actions', 'monitoring', 'prometheus', 'grafana'] },
  // Database
  { domain: 'database', keywords: ['database', 'sql', 'nosql', 'postgresql', 'mysql', 'mongodb', 'redis', 'elasticsearch', 'sharding', 'replication', 'indexing', 'query'] },
  // Distributed Systems
  { domain: 'distributed-systems', keywords: ['distributed', 'consensus', 'raft', 'paxos', 'cap theorem', 'eventual consistency', 'message queue', 'kafka', 'rabbitmq', 'pub/sub', 'service mesh'] },
  // Algorithms / Data Structures
  { domain: 'algorithms', keywords: ['algorithm', 'data structure', 'sorting', 'searching', 'graph', 'tree', 'dynamic programming', 'hash', 'heap', 'stack', 'queue'] },
  // Networking
  { domain: 'networking', keywords: ['networking', 'tcp', 'udp', 'http', 'dns', 'ssl', 'tls', 'websocket', 'load balancer', 'cdn', 'firewall', 'latency'] },
  // AI / ML
  { domain: 'ai-ml', keywords: ['machine learning', 'deep learning', 'neural network', 'transformer', 'llm', 'gpt', 'bert', 'cnn', 'rnn', 'embedding', 'fine-tuning', 'rag', 'prompt engineering'] },
  // Security
  { domain: 'security', keywords: ['security', 'authentication', 'authorization', 'oauth', 'jwt', 'encryption', 'vulnerability', 'penetration', 'firewall', 'xss', 'csrf', 'injection'] },
  // Programming Languages
  { domain: 'programming', keywords: ['python', 'javascript', 'typescript', 'java', 'c++', 'c#', 'go', 'rust', 'ruby', 'php', 'swift', 'kotlin', 'compiler', 'interpreter'] },
  // System Design
  { domain: 'system-design', keywords: ['system design', 'architecture', 'scalability', 'performance', 'caching', 'load balancing', 'microservices', 'monolith', 'event-driven'] },
  // Cloud
  { domain: 'cloud', keywords: ['cloud', 'aws', 'gcp', 'azure', 'serverless', 'lambda', 'ec2', 's3', 'cloudformation', 'iaas', 'paas', 'saas'] },
  // Math
  { domain: 'math', keywords: ['math', 'calculus', 'linear algebra', 'statistics', 'probability', 'optimization', 'differential', 'integral', 'matrix'] },
  // Physics
  { domain: 'physics', keywords: ['physics', 'mechanics', 'thermodynamics', 'electromagnetism', 'quantum', 'relativity', 'optics', 'energy', 'force', 'momentum'] },
  // Social Sciences
  { domain: 'social-science', keywords: ['psychology', 'sociology', 'philosophy', 'economics', 'politics', 'history', 'anthropology', 'cognitive', 'behavioral', 'emotion', 'motivation'] },
];

function detectDomain(name, category) {
  const text = `${name} ${category}`.toLowerCase();

  for (const rule of DOMAIN_RULES) {
    if (rule.keywords.some(kw => text.includes(kw))) {
      return rule.domain;
    }
  }

  // Fallback based on category
  const categoryMap = {
    'Backend': 'backend',
    'DevOps': 'devops',
    'Database': 'database',
    'AI': 'ai-ml',
    'Math': 'math',
    'Algorithms': 'algorithms',
    'Security': 'security',
    'Networking': 'networking',
    'System Design': 'system-design',
    'Cloud': 'cloud',
    'Physics': 'physics',
    'Social': 'social-science',
  };

  return categoryMap[category] || 'general';
}

async function main() {
  const db = getDb();

  console.log('[Backfill] Starting domain metadata backfill...');

  // ── 1. Backfill entities table ──────────────────────────────────────────
  const entities = db.prepare('SELECT id, name, category, domain FROM entities').all();
  let entityUpdated = 0;

  for (const entity of entities) {
    if (entity.domain && entity.domain !== 'general') continue; // Already has domain

    const domain = detectDomain(entity.name, entity.category);
    if (domain !== entity.domain) {
      db.prepare('UPDATE entities SET domain = ? WHERE id = ?').run(domain, entity.id);
      entityUpdated++;
    }
  }

  console.log(`[Backfill] Entities: ${entityUpdated}/${entities.length} updated`);

  // ── 2. Backfill vectors (SQLite vector store) ──────────────────────────
  try {
    // Check if vectors table exists
    const tableCheck = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='vectors'").get();
    if (tableCheck) {
      const vectors = db.prepare('SELECT id, category, metadata FROM vectors').all();
      let vectorUpdated = 0;

      for (const vec of vectors) {
        let metadata = {};
        try {
          metadata = JSON.parse(vec.metadata || '{}');
        } catch { /* ignore */ }

        if (metadata.domain) continue; // Already has domain

        const domain = detectDomain(vec.project || vec.doc_id || '', vec.category);
        metadata.domain = domain;

        db.prepare('UPDATE vectors SET metadata = ? WHERE id = ?').run(JSON.stringify(metadata), vec.id);
        vectorUpdated++;
      }

      console.log(`[Backfill] Vectors: ${vectorUpdated}/${vectors.length} updated`);
    }
  } catch (err) {
    console.warn('[Backfill] Vectors table not available:', err.message);
  }

  // ── 3. Verify ───────────────────────────────────────────────────────────
  const totalEntities = db.prepare('SELECT COUNT(*) as n FROM entities').get().n;
  const entitiesWithDomain = db.prepare("SELECT COUNT(*) as n FROM entities WHERE domain != 'general'").get().n;

  console.log(`\n[Backfill] Summary:`);
  console.log(`  Total entities: ${totalEntities}`);
  console.log(`  Entities with domain: ${entitiesWithDomain} (${((entitiesWithDomain / totalEntities) * 100).toFixed(1)}%)`);
  console.log(`  Entities without domain: ${totalEntities - entitiesWithDomain}`);

  // Domain distribution
  const distribution = db.prepare('SELECT domain, COUNT(*) as count FROM entities GROUP BY domain ORDER BY count DESC').all();
  console.log('\n[Backfill] Domain distribution:');
  for (const d of distribution) {
    console.log(`  ${d.domain}: ${d.count}`);
  }

  console.log('\n[Backfill] Done!');
}

main().catch(err => {
  console.error('[Backfill] Error:', err.message);
  process.exit(1);
});
