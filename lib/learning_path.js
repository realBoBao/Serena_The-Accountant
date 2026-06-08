/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Learning Path Generator — Lộ trình học tự động từ Knowledge Graph
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Mục tiêu: Từ "Tao muốn hiểu X" → tạo ra lộ trình học ordered A→B→C
 * dựa trên Knowledge Graph prerequisites + flashcard stats.
 *
 * Thuật toán:
 *   1. Nhận topic input → tìm entity trong KG
 *   2. BFS/DFS tìm prerequisites (incoming edges)
 *   3. Topo sort để sẩp xếp thứ tự học
 *   4. Gắn status từ flashcard stats (✅ nắm / ⚠️ cần ôn / ❌ chưa học)
 *   5. Trả về ordered learning path
 *
 * Ứng dụng:
 *   Discord: !learn-path distributed-systems
 *   API: GET /api/learning-path?topic=distributed-systems
 *
 * @module lib/learning_path
 */

'use strict';

import { open } from 'sqlite';
import sqlite3 from 'sqlite3';
import path from 'path';

const KG_DB = path.resolve('./knowledge_graph.db');
const FC_DB = path.resolve('./flashcards.db');

/**
 * Tạo learning path từ topic
 * @param {string} topic — Topic muốn học (ví dụ: "distributed systems")
 * @param {Object} [opts]
 * @param {number} [opts.maxDepth=5] — Độ sâu tìm prerequisites
 * @param {boolean} [opts.includeReviewed=false] — Bao gồm topic đã ôn rồi
 * @returns {Promise<Object>} — Learning path với ordered topics + status
 */
export async function generateLearningPath(topic, opts = {}) {
  const { maxDepth = 5, includeReviewed = false } = opts;

  const kgDb = await open({ filename: KG_DB, driver: sqlite3.Database });
  const fcDb = await open({ filename: FC_DB, driver: sqlite3.Database });

  try {
    // 1. Tìm entity matching topic
    const entity = await _findEntity(kgDb, topic);
    if (!entity) {
      return { topic, found: false, message: `Không tìm thấy "${topic}" trong Knowledge Graph. Hãy hỏi bot về topic này trước để xây dựng KG.` };
    }

    // 2. BFS tìm prerequisites (incoming edges)
    const visited = new Set();
    const queue = [{ id: entity.id, depth: 0 }];
    const nodes = new Map(); // id → { entity, depth, prerequisites: [] }

    while (queue.length > 0) {
      const { id, depth } = queue.shift();
      if (visited.has(id) || depth > maxDepth) continue;
      visited.add(id);

      const ent = await kgDb.get('SELECT * FROM entities WHERE id = ?', id);
      if (!ent) continue;

      // Tìm prerequisites (incoming edges)
      const prereqs = await kgDb.all(
        'SELECT e.* FROM edges JOIN entities e ON e.id = edges.source_id WHERE edges.target_id = ? AND edges.relation IN (?, ?, ?)',
        id, 'prerequisite_of', 'requires', 'before'
      );

      nodes.set(id, { entity: ent, depth, prerequisites: prereqs.map(p => p.id) });

      // Thêm prerequisites vào queue
      for (const prereq of prereqs) {
        if (!visited.has(prereq.id)) {
          queue.push({ id: prereq.id, depth: depth + 1 });
        }
      }
    }

    // 3. Topo sort để sắp xếp thứ tự học
    const sorted = _topoSort(nodes);

    // 4. Gắn flashcard status cho từng topic
    const path = [];
    for (const node of sorted) {
      const status = await _getTopicStatus(fcDb, node.entity.name);
      path.push({
        id: node.entity.id,
        name: node.entity.name,
        type: node.entity.type,
        description: node.entity.description?.slice(0, 100) || '',
        depth: node.depth,
        status: status,
        prerequisites: node.prerequisites,
      });
    }

    // 5. Filter nếu không muốn include reviewed topics
    const filteredPath = includeReviewed ? path : path.filter(p => p.status.level !== 'mastered');

    return {
      topic: entity.name,
      found: true,
      totalSteps: filteredPath.length,
      mastered: path.filter(p => p.status.level === 'mastered').length,
      needsReview: path.filter(p => p.status.level === 'needs_review').length,
      notLearned: path.filter(p => p.status.level === 'not_learned').length,
      path: filteredPath,
      generatedAt: new Date().toISOString(),
    };
  } finally {
    await kgDb.close();
    await fcDb.close();
  }
}

/**
 * Tìm entity theo tên (fuzzy match)
 */
async function _findEntity(db, topic) {
  // Exact match first
  let entity = await db.get('SELECT * FROM entities WHERE LOWER(name) = LOWER(?)', topic);
  if (entity) return entity;

  // Alias match
  entity = await db.get('SELECT e.* FROM entity_aliases ea JOIN entities e ON e.id = ea.entity_id WHERE LOWER(ea.alias) = LOWER(?)', topic);
  if (entity) return entity;

  // Fuzzy match
  entity = await db.get('SELECT * FROM entities WHERE LOWER(name) LIKE ?', `%${topic.toLowerCase()}%`);
  return entity;
}

/**
 * Topo sort cho learning path
 * Prerequisites trước, advanced sau
 */
function _topoSort(nodes) {
  const sorted = [];
  const visited = new Set();
  const visiting = new Set();

  function visit(nodeId) {
    if (visited.has(nodeId)) return;
    if (visiting.has(nodeId)) return; // Circular dependency, skip

    visiting.add(nodeId);
    const node = nodes.get(nodeId);
    if (node) {
      for (const prereqId of node.prerequisites) {
        visit(prereqId);
      }
    }
    visiting.delete(nodeId);
    visited.add(nodeId);
    if (node) sorted.push(node);
  }

  for (const [id] of nodes) {
    visit(id);
  }

  return sorted;
}

/**
 * Lấy status của topic từ flashcard stats
 * @returns {{ level: string, cards: number, accuracy: number }}
 */
async function _getTopicStatus(fcDb, topicName) {
  try {
    const stats = await fcDb.get(
      'SELECT COUNT(*) as total, SUM(CASE WHEN review_count > 0 THEN 1 ELSE 0 END) as reviewed, SUM(correct_count) as correct, SUM(review_count) as reviews FROM flashcards WHERE LOWER(question) LIKE ? OR LOWER(category) LIKE ?',
      `%${topicName.toLowerCase()}%`, `%${topicName.toLowerCase()}%`
    );

    if (!stats || stats.total === 0) {
      return { level: 'not_learned', cards: 0, accuracy: 0, label: '❌ Chưa học' };
    }

    const accuracy = stats.reviews > 0 ? (stats.correct / stats.reviews) : 0;
    const reviewed = stats.reviewed / stats.total;

    if (reviewed >= 0.8 && accuracy >= 0.7) {
      return { level: 'mastered', cards: stats.total, accuracy: Math.round(accuracy * 100), label: '✅ Đã nắm' };
    } else if (reviewed >= 0.3) {
      return { level: 'needs_review', cards: stats.total, accuracy: Math.round(accuracy * 100), label: '⚠️ Cần ôn' };
    } else {
      return { level: 'not_learned', cards: stats.total, accuracy: Math.round(accuracy * 100), label: '❌ Chưa học' };
    }
  } catch {
    return { level: 'not_learned', cards: 0, accuracy: 0, label: '❌ Chưa học' };
  }
}

/**
 * Format learning path cho Discord message
 */
export function formatLearningPath(pathData) {
  if (!pathData.found) {
    return `❌ ${pathData.message}`;
  }

  const lines = [
    `📚 **Learning Path: ${pathData.topic}**`,
    `Tổng: ${pathData.totalSteps} bước | ✅ ${pathData.mastered} đã nắm | ⚠️ ${pathData.needsReview} cần ôn | ❌ ${pathData.notLearned} chưa học`,
    '',
  ];

  for (let i = 0; i < pathData.path.length; i++) {
    const step = pathData.path[i];
    const indent = '  '.repeat(step.depth);
    const num = `${i + 1}.`;
    lines.push(`${indent}${num} ${step.status.label} **${step.name}**${step.description ? ` — ${step.description}` : ''}`);
  }

  lines.push('');
  lines.push('💡 Dùng `!learn <topic>` để học từng bước, `!quiz` để ôn tập.');

  return lines.join('\n');
}

export default { generateLearningPath, formatLearningPath };
