import { config } from 'dotenv';
config();
import { openDbFile } from './lib/sqlite_adapter.js';
import { embedText } from './lib/embeddings.js';

const db = openDbFile('./vectors.db');

// Clear old test data
db.prepare("DELETE FROM vectors WHERE id LIKE 'test-%'").run();
console.log('Cleared old test data');

const testDocs = [
  { id: 'test-backend-programming', title: 'Backend Programming', text: 'Backend programming is the server-side development of web applications. It involves databases, APIs, and server logic. Popular languages include Python, Java, Go, Node.js, and Rust. Frameworks include Django, Spring, Express, Gin, and FastAPI.' },
  { id: 'test-python-django', title: 'Python Django', text: 'Django is a high-level Python web framework for rapid development. It follows MVC pattern and includes ORM, admin panel, and authentication.' },
  { id: 'test-node-express', title: 'Node.js Express', text: 'Express is a minimal Node.js web framework for building APIs and web applications. It is fast, unopinionated, and flexible.' },
  { id: 'test-system-design', title: 'System Design', text: 'System design is the process of defining architecture, components, and interfaces. Key concepts: scalability, reliability, availability, and performance.' },
  { id: 'test-database', title: 'Database Design', text: 'Database design involves organizing data with tables, relationships, indexes, and normalization. Popular databases: PostgreSQL, MongoDB, Redis, MySQL.' },
  { id: 'test-rest-api', title: 'REST API', text: 'REST API design uses HTTP methods (GET, POST, PUT, DELETE), resource-based URLs, and status codes. Best practices include versioning, pagination, and authentication.' },
  { id: 'test-microservices', title: 'Microservices', text: 'Microservices architecture builds applications as small independent services communicating via APIs. Benefits: scalability, independent deployment, technology diversity.' },
  { id: 'test-docker', title: 'Docker', text: 'Docker containers package applications with dependencies for consistent deployment. Key concepts: images, containers, Dockerfile, Docker Compose.' },
  { id: 'test-kubernetes', title: 'Kubernetes', text: 'Kubernetes orchestrates containerized applications. Features: auto-scaling, self-healing, service discovery, load balancing, rolling updates.' },
  { id: 'test-cicd', title: 'CI/CD', text: 'CI/CD automates build, test, and deployment. Tools: GitHub Actions, Jenkins, GitLab CI. Benefits: faster releases, fewer bugs, consistent deployments.' },
];

let inserted = 0;
for (const doc of testDocs) {
  try {
    const emb = await embedText(doc.text);
    // Store as hex string to avoid BLOB issues
    const embHex = Buffer.from(new Float32Array(emb).buffer).toString('hex');
    db.prepare("INSERT OR REPLACE INTO vectors (id, doc_id, chunk_index, chunk_text, embedding, url, category, added_at) VALUES (?, ?, 0, ?, ?, ?, ?, datetime('now'))").run(doc.id, doc.id, doc.text, embHex, 'test', 'Backend');
    inserted++;
    console.log('  ✅', doc.id, '- embedding hex length:', embHex.length);
  } catch (e) {
    console.log('  ❌', doc.id, ':', e.message);
  }
}

// Verify
const verify = db.prepare("SELECT id, length(embedding) as emb_len FROM vectors WHERE id LIKE 'test-%'").all();
console.log('\nVerification:', verify);

const count = db.prepare('SELECT COUNT(*) as c FROM vectors').get();
console.log('Total vectors:', count?.c);
