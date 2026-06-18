/**
 * lib/query_quality.js — Query Quality Gate (Tier 3)
 *
 * Đánh giá chất lượng câu hỏi TRƯỚC khi vào RAG pipeline.
 * Garbage in = garbage out. Nếu câu hỏi mơ hồ → RAG tìm sai.
 *
 * @module lib/query_quality
 */
import { getLogger } from './logger.js';
const logger = getLogger('QueryQuality');

// Domain keywords để detect chủ đề
const DOMAIN_KEYWORDS = {
  backend: ['backend', 'server', 'api', 'database', 'sql', 'nosql', 'rest', 'graphql', 'microservice', 'docker', 'kubernetes', 'devops', 'ci/cd', 'deploy', 'cloud', 'aws', 'gcp', 'azure', 'linux', 'nginx', 'apache', 'redis', 'kafka', 'rabbitmq', 'grpc', 'websocket', 'oauth', 'jwt', 'cdn', 'load balancer', 'scaling', 'sharding', 'replication', 'caching', 'indexing', 'query optimization', 'distributed system', 'consensus', 'raft', 'paxos', 'cap theorem', 'eventual consistency', 'message queue', 'pub/sub', 'service mesh', 'observability', 'monitoring', 'logging', 'tracing'],
  frontend: ['frontend', 'react', 'vue', 'angular', 'javascript', 'typescript', 'css', 'html', 'webpack', 'vite', 'nextjs', 'nuxt', 'spa', 'pwa', 'responsive', 'accessibility', 'seo', 'dom', 'virtual dom', 'state management', 'redux', 'zustand', 'tailwind', 'sass', 'less'],
  algorithms: ['algorithm', 'data structure', 'sorting', 'searching', 'graph', 'tree', 'dynamic programming', 'greedy', 'backtracking', 'big o', 'complexity', 'hash', 'heap', 'stack', 'queue', 'linked list', 'binary search', 'bfs', 'dfs', 'dijkstra', 'shortest path', 'minimum spanning tree', 'topological sort'],
  ml_ai: ['machine learning', 'deep learning', 'neural network', 'transformer', 'llm', 'gpt', 'bert', 'cnn', 'rnn', 'lstm', 'gan', 'reinforcement learning', 'supervised', 'unsupervised', 'classification', 'regression', 'clustering', 'embedding', 'fine-tuning', 'prompt engineering', 'rag', 'vector database', 'attention mechanism', 'backpropagation', 'gradient descent', 'overfitting', 'underfitting', 'cross validation'],
  physics: ['physics', 'mechanics', 'thermodynamics', 'electromagnetism', 'quantum', 'relativity', 'optics', 'fluid dynamics', 'statistical mechanics', 'particle physics', 'nuclear', 'astrophysics', 'cosmology', 'string theory', 'wave', 'energy', 'force', 'momentum', 'entropy', 'schrodinger', 'heisenberg', 'maxwell', 'newton', 'einstein'],
  social: ['psychology', 'sociology', 'philosophy', 'economics', 'politics', 'history', 'anthropology', 'linguistics', 'cognitive', 'behavioral', 'social', 'culture', 'society', 'ethics', 'morality', 'consciousness', 'perception', 'memory', 'learning', 'motivation', 'emotion', 'personality', 'mental health', 'therapy', 'counseling'],
};

/**
 * Đánh giá chất lượng câu hỏi.
 * @param {string} query
 * @returns {{ score: number, issues: string[], domain: string|null, improved: string|null }}
 */
export function assessQueryQuality(query) {
  const issues = [];
  const q = query.toLowerCase().trim();

  // 1. Quá ngắn
  if (q.length < 5) {
    issues.push('Câu hỏi quá ngắn — cần ít nhất 5 ký tự để tìm kiếm chính xác');
  }

  // 2. Quá dài (nhiều ý ghép)
  if (q.length > 200) {
    issues.push('Câu hỏi quá dài — có thể chứa nhiều ý. Tách riêng để câu trả lời chính xác hơn');
  }

  // 3. Có nhiều câu hỏi ghép (dấu ? nhiều lần)
  const questionMarks = (q.match(/\?/g) || []).length;
  if (questionMarks > 2) {
    issues.push('Nhiều câu hỏi ghép — nên tách riêng để từng câu được trả lời sâu hơn');
  }

  // 4. Thiếu từ khóa kỹ thuật (chung chung quá)
  const hasTechnicalKeyword = Object.values(DOMAIN_KEYWORDS).flat().some(kw => q.includes(kw));
  if (!hasTechnicalKeyword && q.length > 10) {
    issues.push('Câu hỏi thiếu từ khóa kỹ thuật — thêm chi tiết để kết quả chính xác hơn');
  }

  // 5. Detect domain
  let detectedDomain = null;
  let maxMatches = 0;
  for (const [domain, keywords] of Object.entries(DOMAIN_KEYWORDS)) {
    const matches = keywords.filter(kw => q.includes(kw)).length;
    if (matches > maxMatches) {
      maxMatches = matches;
      detectedDomain = domain;
    }
  }

  // 6. Suggest improved query
  let improved = null;
  if (issues.length > 0 && detectedDomain) {
    improved = `Gợi ý: "${query}" → thử thêm từ khóa ${detectedDomain} cụ thể hơn`;
  }

  const score = Math.max(0, 1 - issues.length * 0.2);

  return { score, issues, domain: detectedDomain, improved };
}

/**
 * Map a detected domain to an existing retrieval category.
 * Returns null when the corpus has no safe matching category.
 * @param {string|null} domain
 * @returns {string|null}
 */
export function normalizeDomainCategory(domain) {
  const mapping = {
    backend: 'Backend',
    algorithms: 'Algorithms',
    ml_ai: 'AI',
  };

  return mapping[String(domain || '').trim()] || null;
}

/**
 * Random query generator theo domain + tech news.
 * @param {string} domain — 'backend' | 'frontend' | 'algorithms' | 'ml_ai' | 'physics' | 'social'
 * @param {string} [techNews] — Optional tech news context
 * @returns {string}
 */
export function generateDomainQuery(domain = 'backend', techNews = null) {
  const TEMPLATES = {
    backend: [
      'Giải thích {concept} trong kiến trúc backend',
      'So sánh {concept1} vs {concept2} cho hệ thống lớn',
      'Best practices cho {concept} production',
      'Tại sao {concept} quan trọng trong distributed systems',
      'Debug {concept} — các lỗi thường gặp',
    ],
    frontend: [
      'Giải thích {concept} trong React/Vue',
      'Performance optimization cho {concept}',
      'So sánh {concept1} vs {concept2}',
      'Accessibility best practices cho {concept}',
    ],
    algorithms: [
      'Giải thích thuật toán {concept}',
      'Big O của {concept} — phân tích chi tiết',
      'Khi nào dùng {concept} thay vì {concept2}',
      'Implement {concept} bằng Python/JavaScript',
    ],
    ml_ai: [
      'Giải thích {concept} trong machine learning',
      'So sánh {concept1} vs {concept2}',
      'Khi nào dùng {concept} — use cases thực tế',
      'Fine-tuning {concept} — best practices',
    ],
    physics: [
      'Giải thích {concept} trong vật lý hiện đại',
      'Ứng dụng {concept} trong công nghệ',
      'So sánh {concept1} vs {concept2}',
      'Thought experiment: {concept}',
    ],
    social: [
      'Giải thích {concept} trong tâm lý học',
      'Ứng dụng {concept} trong cuộc sống hàng ngày',
      'So sánh {concept1} vs {concept2}',
      'Tại sao {concept} quan trọng cho sức khỏe tinh thần',
    ],
  };

  const CONCEPTS = {
    backend: ['microservices', 'event sourcing', 'CQRS', 'API gateway', 'service mesh', 'circuit breaker', 'rate limiting', 'caching strategies', 'database sharding', 'message queues', 'CQRS', 'saga pattern', 'idempotency', 'distributed tracing', 'health checks', 'graceful degradation', 'backpressure', 'connection pooling', 'index optimization', 'CAP theorem'],
    frontend: ['virtual DOM', 'state management', 'code splitting', 'tree shaking', 'SSR vs CSR', 'web components', 'CSS-in-JS', 'responsive design', 'web performance', 'bundle optimization'],
    algorithms: ['dynamic programming', 'graph traversal', 'binary search', 'merge sort', 'quick sort', 'heap', 'hash table', 'B-tree', 'red-black tree', 'topological sort'],
    ml_ai: ['attention mechanism', 'transformer', 'fine-tuning', 'RAG', 'vector embeddings', 'contrastive learning', 'knowledge distillation', 'quantization', 'LoRA', 'RLHF'],
    physics: ['quantum entanglement', 'wave-particle duality', 'thermodynamics', 'special relativity', 'quantum computing', 'superconductivity', 'nuclear fusion', 'dark matter', 'string theory', 'holographic principle'],
    social: ['cognitive bias', 'confirmation bias', 'dunning-kruger effect', 'flow state', 'growth mindset', 'emotional intelligence', 'attachment theory', 'maslow hierarchy', 'stoic philosophy', 'mindfulness'],
  };

  const templates = TEMPLATES[domain] || TEMPLATES.backend;
  const concepts = CONCEPTS[domain] || CONCEPTS.backend;

  const template = templates[Math.floor(Math.random() * templates.length)];
  const concept = concepts[Math.floor(Math.random() * concepts.length)];
  const concept2 = concepts.filter(c => c !== concept)[Math.floor(Math.random() * (concepts.length - 1))];

  let query = template.replace('{concept}', concept).replace('{concept1}', concept).replace('{concept2}', concept2);

  // Nếu có tech news, inject vào query
  if (techNews) {
    query += ` (liên quan: ${techNews.slice(0, 50)})`;
  }

  logger.debug(`[QueryQuality] Generated ${domain} query: ${query}`);
  return query;
}

export default { assessQueryQuality, generateDomainQuery, normalizeDomainCategory };
