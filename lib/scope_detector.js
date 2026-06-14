/**
 * ═══════════════════════════════════════════════════════════════
 * Out-of-Scope Detector — TF-IDF similarity (không cần labels)
 * ═══════════════════════════════════════════════════════════════
 *
 * Thay vì Naive Bayes (cần 500+ labeled examples mỗi class),
 * dùng TF-IDF similarity để detect câu hỏi nằm ngoài scope.
 *
 * Nguyên lý: So sánh cosine similarity của query với các câu hỏi
 * mẫu TRONG scope. Nếu similarity quá thấp → out of scope.
 *
 * Ưu điểm:
 * - Không cần labeled data
 * - Không cần training
 * - Chạy ngay với ~50 seed examples
 * - Cập nhật seed examples từ Discord logs là đủ
 */

// Lightweight TF-IDF implementation (no external dependency)
// Replaces `natural` package which has ESM compatibility issues on Node 24
const TfIdf = createTfIdf();

function createTfIdf() {
  const documents = [];
  const idfCache = new Map();

  function addDocument(text) {
    const words = tokenize(text);
    const tf = new Map();
    for (const w of words) tf.set(w, (tf.get(w) || 0) + 1);
    // Normalize TF
    const maxFreq = Math.max(...tf.values(), 1);
    for (const [w, freq] of tf) tf.set(w, 0.5 + 0.5 * (freq / maxFreq));
    documents.push(tf);
    idfCache.clear(); // Invalidate cache
  }

  function tokenize(text) {
    return String(text).toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2);
  }

  function getIdf(word) {
    if (idfCache.has(word)) return idfCache.get(word);
    const docsWithWord = documents.filter(d => d.has(word)).length;
    const idf = Math.log((documents.length + 1) / (docsWithWord + 1)) + 1;
    idfCache.set(word, idf);
    return idf;
  }

  function similarity(query, docIndex) {
    const qWords = tokenize(query);
    if (!qWords.length || docIndex >= documents.length) return 0;
    const doc = documents[docIndex];
    let dot = 0, qNorm = 0, dNorm = 0;
    for (const w of qWords) {
      const qTf = 1 / qWords.length;
      const dTf = doc.get(w) || 0;
      const idf = getIdf(w);
      dot += qTf * idf * dTf * idf;
      qNorm += (qTf * idf) ** 2;
    }
    for (const [w, tf] of doc) {
      const idf = getIdf(w);
      dNorm += (tf * idf) ** 2;
    }
    const denom = Math.sqrt(qNorm) * Math.sqrt(dNorm);
    return denom > 0 ? dot / denom : 0;
  }

  function maxSimilarity(query) {
    let max = 0;
    for (let i = 0; i < documents.length; i++) {
      const sim = similarity(query, i);
      if (sim > max) max = sim;
    }
    return max;
  }

  return { addDocument, similarity, maxSimilarity, tokenize };
}

// ── Seed examples — câu hỏi TRONG scope
// Cập nhật thêm từ Discord logs khi có dữ liệu thực tế
const IN_SCOPE_SEEDS = [
  // Project & Bot info
  'what is Serena Project00',
  'what is Serena Project00APP',
  'what is serena app',
  'serena project00app',
  'serena app',
  'serena project app',
  'the serena application',
  'serena_project00app',
  'serana project00app',
  'serana_project00app',
  'serana app',
  'serana project',
  'prefer theory_first',
  'prefer example_first',
  'prefer code_heavy',
  'prefer concise',
  'prefer detailed',
  'theory first',
  'example first',
  'code heavy',
  'learning style',
  'teaching style',
  'what is my ai brain',
  'what can you do',
  'help me with commands',
  'what are your features',
  'tell me about yourself',
  'what is your name',
  'how do you work',
  'what is this bot',
  'who are you',
  'what is serena',
  'project information',
  'bot capabilities',
  'what is auto teaching',
  'what is this project',
  'explain this project',
  'what can this bot do',
  'how to use this bot',
  'list your commands',
  'show me your features',
  'what do you know',
  'help me understand this project',
  'serena project',
  'serena bot',
  'ai brain project',
  'auto teaching system',
  'multi agent system',
  'what are you capable of',
  'introduce yourself',
  'give me an overview',
  'project overview',
  'system overview',
  'capabilities',
  'feature list',
  'command list',
  'help menu',
  'getting started',
  'quick start guide',
  'user guide',
  'documentation',
  'readme',
  'about this project',
  'about serena',
  'about the bot',
  'bot introduction',
  'project introduction',
  'what is this application',
  'what is this system',
  'system description',
  'project description',
  'tell me more about yourself',
  'what makes you special',
  'why should i use this',
  'what problems do you solve',
  'use cases',
  'examples of what you can do',
  'show me an example',
  'demo',
  'tutorial',
  'how to get started',
  'getting started guide',
  'welcome',
  'hello',
  'hi there',
  'good morning',
  'good evening',
  'hey',
  'greetings',
  'bot capabilities',

  // Programming & Algorithms
  'explain binary search algorithm',
  'how does quicksort work',
  'what is dynamic programming',
  'implement linked list in Python',
  'debug this JavaScript code',
  'what is time complexity',
  'how does hash table work',
  'explain depth first search',
  'what is object oriented programming',
  'how to reverse a string',

  // System Design
  'how does TCP handshake work',
  'what is database indexing',
  'explain distributed systems',
  'what is load balancing',
  'how does caching work',
  'what is microservices architecture',
  'explain REST API design',
  'what is message queue',

  // Data Science & ML
  'what is machine learning',
  'explain neural network',
  'what is supervised learning',
  'how does gradient descent work',
  'what is overfitting',

  // DevOps & Infrastructure
  'what is Docker container',
  'explain Kubernetes deployment',
  'what is CI CD pipeline',
  'how does load balancer work',

  // General Knowledge
  'what is blockchain technology',
  'explain quantum computing',
  'what is cloud computing',
  'how does internet work',
];

// ── Singleton TF-IDF instance (lightweight, no external dependency)
let _tfidf = null;
let _seedsLoaded = false;

function getTfidf() {
  if (_tfidf && _seedsLoaded) return _tfidf;

  _tfidf = TfIdf; // TfIdf is the singleton object from createTfIdf()
  for (const seed of IN_SCOPE_SEEDS) {
    _tfidf.addDocument(seed.toLowerCase());
  }
  _seedsLoaded = true;
  return _tfidf;
}

/**
 * Kiểm tra query có nằm trong scope không.
 * @param {string} query
 * @returns {{ inScope: boolean, maxSimilarity: number }}
 */
export function checkScope(query) {
  const tfidf = getTfidf();
  const queryLower = query.toLowerCase();

  // Tính max TF-IDF similarity với tất cả seed documents
  const maxSim = tfidf.maxSimilarity(queryLower);

  // Ngưỡng — cosine similarity TF-IDF, 0.12 is lenient (accepts most queries)
  const THRESHOLD = 0.12;

  return {
    inScope: maxSim >= THRESHOLD,
    maxSimilarity: Math.round(maxSim * 1000) / 1000,
  };
}

/**
 * Thêm seed example mới (từ Discord logs).
 */
export function addSeedExample(text) {
  const tfidf = getTfidf();
  tfidf.addDocument(text.toLowerCase());
}

/**
 * Lất danh sách seed examples hiện tại.
 */
export function getSeedExamples() {
  return [...IN_SCOPE_SEEDS];
}

export default { checkScope, addSeedExample, getSeedExamples };
