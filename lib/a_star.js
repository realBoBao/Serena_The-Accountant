/**
 * A* (A-Star) Search Algorithm — Tìm đường tối ưu trong DAG
 *
 * Ứng dụng trong PlannerAgent:
 * - Khi có nhiều cách để hoàn thành một task (nhiều agent có thể làm),
 *   A* tìm ra "đường đi" tối ưu nhất qua DAG dựa trên heuristic.
 *
 * Heuristic có thể là:
 * - Chi phí API cost thấp nhất
 * - Thời gian chạy Sandbox nhanh nhất
 * - Độ tin cậy của agent cao nhất
 * - Số bước ít nhất
 *
 * So với BFS/DFS đơn giản, A* ưu tiên node có f(n) = g(n) + h(n) thấp nhất:
 *   g(n) = chi phí thực tế từ start đến n
 *   h(n) = heuristic ước lượng chi phí từ n đến goal
 */

import { getLogger } from './logger.js';

const logger = getLogger('AStar');

// ── Priority Queue (Min-Heap) ──
class PriorityQueue {
  constructor() {
    this.heap = [];
  }

  push(item, priority) {
    this.heap.push({ item, priority });
    this._bubbleUp(this.heap.length - 1);
  }

  pop() {
    if (this.heap.length === 0) return null;
    const top = this.heap[0];
    const last = this.heap.pop();
    if (this.heap.length > 0) {
      this.heap[0] = last;
      this._sinkDown(0);
    }
    return top.item;
  }

  get size() {
    return this.heap.length;
  }

  _bubbleUp(i) {
    while (i > 0) {
      const parent = Math.floor((i - 1) / 2);
      if (this.heap[parent].priority <= this.heap[i].priority) break;
      [this.heap[parent], this.heap[i]] = [this.heap[i], this.heap[parent]];
      i = parent;
    }
  }

  _sinkDown(i) {
    const n = this.heap.length;
    while (true) {
      let smallest = i;
      const left = 2 * i + 1;
      const right = 2 * i + 2;
      if (left < n && this.heap[left].priority < this.heap[smallest].priority) smallest = left;
      if (right < n && this.heap[right].priority < this.heap[smallest].priority) smallest = right;
      if (smallest === i) break;
      [this.heap[smallest], this.heap[i]] = [this.heap[i], this.heap[smallest]];
      i = smallest;
    }
  }
}

// ── A* Search ──

/**
 * Tìm đường đi tối ưu từ start đến goal trong graph.
 *
 * @param {object} graph - Adjacency list: { node: [{ to, cost }] }
 * @param {string} start - Node bắt đầu
 * @param {string} goal - Node đích
 * @param {Function} heuristic - h(node) → estimated cost to goal
 * @returns {Array} - Đường đi tối ưu (mảng nodes) hoặc [] nếu không tìm thấy
 */
export function aStarSearch(graph, start, goal, heuristic = () => 0) {
  const openSet = new PriorityQueue();
  openSet.push(start, 0);

  const cameFrom = new Map();
  const gScore = new Map();
  gScore.set(start, 0);

  const fScore = new Map();
  fScore.set(start, heuristic(start));

  const visited = new Set();

  while (openSet.size > 0) {
    const current = openSet.pop();

    if (current === goal) {
      // Reconstruct path
      const path = [current];
      let node = current;
      while (cameFrom.has(node)) {
        node = cameFrom.get(node);
        path.unshift(node);
      }
      logger.info(`[A*] Found path: ${path.join(' → ')} (cost: ${gScore.get(goal)})`);
      return path;
    }

    if (visited.has(current)) continue;
    visited.add(current);

    const neighbors = graph[current] || [];
    for (const { to: neighbor, cost } of neighbors) {
      if (visited.has(neighbor)) continue;

      const tentativeG = (gScore.get(current) || Infinity) + cost;

      if (tentativeG < (gScore.get(neighbor) || Infinity)) {
        cameFrom.set(neighbor, current);
        gScore.set(neighbor, tentativeG);
        const f = tentativeG + heuristic(neighbor);
        fScore.set(neighbor, f);
        openSet.push(neighbor, f);
      }
    }
  }

  logger.warn(`[A*] No path found from ${start} to ${goal}`);
  return [];
}

// ── DAG Path Optimizer cho PlannerAgent ──

/**
 * Tối ưu thứ tự thực thi DAG dựa trên A*.
 * Mỗi node là một step, edge là dependency.
 * Heuristic dựa trên: agent cost, estimated time, reliability.
 *
 * @param {Array} dag - DAG dạng [{ step, agent, action, depends_on, status }]
 * @param {Object} agentMetrics - { agentName: { cost, time, reliability } }
 * @returns {Array} - Thứ tự thực thi tối ưu
 */
export function optimizeDagOrder(dag, agentMetrics = {}) {
  if (!dag || dag.length === 0) return [];

  // Build adjacency list từ DAG
  const graph = {};
  const nodeMap = new Map();

  for (const node of dag) {
    const id = `step_${node.step}`;
    nodeMap.set(id, node);
    graph[id] = [];

    if (node.depends_on) {
      const depId = `step_${node.depends_on}`;
      // Edge từ dependency → node (dependency phải chạy trước)
      if (!graph[depId]) graph[depId] = [];
      graph[depId].push({
        to: id,
        cost: getAgentCost(node.agent, agentMetrics),
      });
    }
  }

  // Tìm root nodes (không có dependency)
  const roots = dag.filter(n => !n.depends_on).map(n => `step_${n.step}`);
  const leaves = dag.filter(n => {
    const id = `step_${n.step}`;
    return !dag.some(other => other.depends_on === n.step);
  }).map(n => `step_${n.step}`);

  // Heuristic: ưu tiên agent có cost thấp, reliability cao
  function heuristic(nodeId) {
    const node = nodeMap.get(nodeId);
    if (!node) return 0;
    const metrics = agentMetrics[node.agent] || { cost: 1, time: 1, reliability: 0.5 };
    // Lower cost + higher reliability = lower heuristic = ưu tiên
    return metrics.cost * 0.4 + metrics.time * 0.3 + (1 - metrics.reliability) * 0.3;
  }

  // Tìm đường tối ưu từ mỗi root đến mỗi leaf
  const allPaths = [];
  for (const root of roots) {
    for (const leaf of leaves) {
      const path = aStarSearch(graph, root, leaf, heuristic);
      if (path.length > 0) {
        allPaths.push({ path, cost: path.reduce((sum, id) => {
          const node = nodeMap.get(id);
          return sum + (node ? getAgentCost(node.agent, agentMetrics) : 0);
        }, 0) });
      }
    }
  }

  // Sắp xếp theo cost tăng dần
  allPaths.sort((a, b) => a.cost - b.cost);

  if (allPaths.length > 0) {
    const bestPath = allPaths[0];
    logger.info(`[A*] Optimal DAG path: ${bestPath.path.join(' → ')} (total cost: ${bestPath.cost.toFixed(2)})`);
    return bestPath.path.map(id => nodeMap.get(id)).filter(Boolean);
  }

  // Fallback: topological sort
  return topologicalSort(dag);
}

/**
 * Topological sort cho DAG (fallback khi A* không tìm được path).
 */
export function topologicalSort(dag) {
  const inDegree = new Map();
  const adj = new Map();

  for (const node of dag) {
    const id = node.step;
    if (!inDegree.has(id)) inDegree.set(id, 0);
    if (!adj.has(id)) adj.set(id, []);

    if (node.depends_on) {
      inDegree.set(id, (inDegree.get(id) || 0) + 1);
      if (!adj.has(node.depends_on)) adj.set(node.depends_on, []);
      adj.get(node.depends_on).push(id);
    }
  }

  const queue = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  const result = [];
  while (queue.length > 0) {
    // Ưu tiên node có cost thấp nhất
    queue.sort((a, b) => {
      const nodeA = dag.find(n => n.step === a);
      const nodeB = dag.find(n => n.step === b);
      return (nodeA?.priority || 0) - (nodeB?.priority || 0);
    });

    const current = queue.shift();
    const node = dag.find(n => n.step === current);
    if (node) result.push(node);

    const neighbors = adj.get(current) || [];
    for (const neighbor of neighbors) {
      inDegree.set(neighbor, inDegree.get(neighbor) - 1);
      if (inDegree.get(neighbor) === 0) queue.push(neighbor);
    }
  }

  return result;
}

function getAgentCost(agentName, metrics = {}) {
  const m = metrics[agentName] || { cost: 1, time: 1, reliability: 0.5 };
  return m.cost * 0.4 + m.time * 0.3 + (1 - m.reliability) * 0.3;
}

export { PriorityQueue };
