/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HNSW (Hierarchical Navigable Small World) — Vector Search Engine
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Mục tiêm: Tìm kiếm Nearest Neighbor trong không gian vector đa chiều
 * với độ phức tạp O(log N) thay vì O(N) brute-force.
 *
 * Nguyên lý:
 *   - Xây dựng đồ thị đa tầng (layered graph)
 *   - Tầng trên: ít node, liên kết dài → "nhảy" nhanh đến vùng gần đích
 *   - Tầng dưới: nhiều node, liên kết ngắn → tinh chỉnh kết quả
 *   - Mỗi node chỉ giữ M liên kết gần nhất (pruning heuristic)
 *
 * Thuật toán:
 *   1. Insert: Tìm entry point, đi xuống từng tầng, tìm M gần nhất
 *   2. Search: Từ entry point, greedy traversal xuống tầng dưới
 *   3. Pruning: Giữ top-M candidates, loại bỏ node xa
 *
 * Ứng dụng:
 *   - vector_store.js: Tìm flashcard/trí nhớ liên quan
 *   - RAG: Context retrieval nhanh hơn O(N) brute-force
 *   - Deduplication: Phát hiện vector gần giống
 *
 * @module lib/hnsw
 */

'use strict';

/**
 * Node trong đồ thị HNSW
 */
class HNSWNode {
  constructor(id, vector, level) {
    this.id = id;
    this.vector = vector;
    this.level = level;
    this.neighbors = []; // [ { node, distance } ] theo từng tầng
  }
}

export class HNSWIndex {
  /**
   * @param {Object} opts
   * @param {number} [opts.dim=768] — Số chiều vector
   * @param {number} [opts.M=16] — Số liên kết tối đa mỗi node (mặc định 16)
   * @param {number} [opts.efConstruction=200] — Beam width khi insert
   * @param {number} [opts.efSearch=50] — Beam width khi search
   * @param {number} [opts.mL=1.0] — Logarithmic level multiplier
   */
  constructor({ dim = 768, M = 16, efConstruction = 200, efSearch = 50, mL = 1.0 } = {}) {
    this.dim = dim;
    this.M = M;
    this.Mmax = M; // Max neighbors per layer
    this.efConstruction = efConstruction;
    this.efSearch = efSearch;
    this.mL = mL;

    this.nodes = new Map(); // id → HNSWNode
    this.entryPoint = null;
    this.maxLevel = 0;
    this.count = 0;

    console.log(`[HNSW] Initialized: dim=${dim}, M=${M}, efC=${efConstruction}, efS=${efSearch}`);
  }

  /**
   * Tính khoảng cách Cosine (1 - cosine similarity)
   * @param {Float32Array} a
   * @param {Float32Array} b
   * @returns {number} — 0 = giống hệt, 2 = hoàn toàn khác
   */
  static cosineDistance(a, b) {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 2.0 : 1.0 - (dot / denom);
  }

  /**
   * Tính khoảng cách Euclidean
   */
  static euclideanDistance(a, b) {
    let sum = 0;
    for (let i = 0; i < a.length; i++) {
      const diff = a[i] - b[i];
      sum += diff * diff;
    }
    return Math.sqrt(sum);
  }

  /**
   * Random level theo phân phối logarithmic
   * P(level = k) = 1 / mL * (1 - 1/mL)^k
   */
  _randomLevel() {
    let level = 0;
    while (Math.random() < 1.0 / this.mL && level < 16) {
      level++;
    }
    return level;
  }

  /**
   * Tìm M nearest neighbors từ một node ở tầng cụ thể
   * @param {Float32Array} queryVector
   * @param {HNSWNode} entryNode
   * @param {number} level
   * @param {number} ef — Beam width
   * @returns {Array<{node: HNSWNode, distance: number}>}
   */
  _searchLayer(queryVector, entryNode, level, ef) {
    // Visited set
    const visited = new Set([entryNode.id]);
    // Candidates (min-heap theo distance)
    const candidates = [{ node: entryNode, distance: this._distance(queryVector, entryNode.vector) }];
    // Results (max-heap, giữ top-ef)
    const results = [{ node: entryNode, distance: candidates[0].distance }];

    while (candidates.length > 0) {
      // Lấy candidate gần nhất
      const current = candidates.pop();
      // Nếu candidate xa hơn result xa nhất → dừng
      if (current.distance > results[results.length - 1]?.distance) break;

      // Duyệt neighbors
      const neighbors = current.node.neighbors[level] || [];
      for (const neighbor of neighbors) {
        if (visited.has(neighbor.node.id)) continue;
        visited.add(neighbor.node.id);
        const dist = this._distance(queryVector, neighbor.node.vector);
        if (dist < results[results.length - 1]?.distance || results.length < ef) {
          candidates.push({ node: neighbor.node, distance: dist });
          results.push({ node: neighbor.node, distance: dist });
          // Sort để giữ top-ef
          results.sort((a, b) => a.distance - b.distance);
          if (results.length > ef) results.pop();
        }
      }
    }

    return results;
  }

  _distance(a, b) {
    return HNSWIndex.cosineDistance(a, b);
  }

  /**
   * Thêm vector vào index
   * @param {string|number} id
   * @param {Float32Array|Array} vector
   */
  insert(id, vector) {
    const vec = vector instanceof Float32Array ? vector : new Float32Array(vector);
    const level = this._randomLevel();
    const newNode = new HNSWNode(id, vec, level);

    if (!this.entryPoint) {
      this.entryPoint = newNode;
      this.maxLevel = level;
      this.nodes.set(id, newNode);
      this.count++;
      return;
    }

    // Tìm entry point cho insertion
    let current = this.entryPoint;
    let currentDist = this._distance(vec, current.vector);

    // Đi từ tầng cao nhất xuống tầng của node mới
    for (let l = this.maxLevel; l > level; l--) {
      let changed = true;
      while (changed) {
        changed = false;
        const neighbors = current.neighbors[l] || [];
        for (const neighbor of neighbors) {
          const dist = this._distance(vec, neighbor.node.vector);
          if (dist < currentDist) {
            current = neighbor.node;
            currentDist = dist;
            changed = true;
          }
        }
      }
    }

    // Insert vào từng tầng từ min(maxLevel, level) xuống 0
    for (let l = Math.min(this.maxLevel, level); l >= 0; l--) {
      const neighbors = this._searchLayer(vec, current, l, this.efConstruction);
      // Giữ top-M neighbors
      newNode.neighbors[l] = neighbors.slice(0, this.M).map(n => ({ node: n.node, distance: n.distance }));
      // Bidirectional linking
      for (const neighbor of newNode.neighbors[l]) {
        if (!neighbor.node.neighbors[l]) neighbor.node.neighbors[l] = [];
        neighbor.node.neighbors[l].push({ node: newNode, distance: neighbor.distance });
        // Pruning: nếu quá M, loại bỏ neighbor xa nhất
        if (neighbor.node.neighbors[l].length > this.Mmax) {
          neighbor.node.neighbors[l].sort((a, b) => a.distance - b.distance);
          neighbor.node.neighbors[l] = neighbor.node.neighbors[l].slice(0, this.Mmax);
        }
      }
      current = neighbors[0]?.node || current;
    }

    // Update entry point nếu node mới ở tầng cao hơn
    if (level > this.maxLevel) {
      this.maxLevel = level;
      this.entryPoint = newNode;
    }

    this.nodes.set(id, newNode);
    this.count++;
  }

  /**
   * Tìm K nearest neighbors
   * @param {Float32Array|Array} queryVector
   * @param {number} [k=10] — Số kết quả
   * @returns {Array<{id: string|number, distance: number}>}
   */
  search(queryVector, k = 10) {
    if (!this.entryPoint) return [];

    const vec = queryVector instanceof Float32Array ? queryVector : new Float32Array(queryVector);

    // Greedy traversal từ tầng cao xuống tầng 0
    let current = this.entryPoint;
    for (let l = this.maxLevel; l > 0; l--) {
      let changed = true;
      while (changed) {
        changed = false;
        const neighbors = current.neighbors[l] || [];
        for (const neighbor of neighbors) {
          const dist = this._distance(vec, neighbor.node.vector);
          if (dist < this._distance(vec, current.vector)) {
            current = neighbor.node;
            changed = true;
          }
        }
      }
    }

    // Tìm kiếm chi tiết ở tầng 0
    const results = this._searchLayer(vec, current, 0, Math.max(k, this.efSearch));
    return results.slice(0, k).map(r => ({ id: r.node.id, distance: r.distance }));
  }

  /** Thống kê */
  stats() {
    return {
      nodes: this.count,
      maxLevel: this.maxLevel,
      dim: this.dim,
      M: this.M,
      memoryMB: (this.count * this.dim * 4 / 1024 / 1024).toFixed(2), // Float32 = 4 bytes
    };
  }
}

export default HNSWIndex;
