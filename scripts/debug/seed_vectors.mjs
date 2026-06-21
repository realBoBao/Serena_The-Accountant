import { config } from 'dotenv';
config();
import { getDb } from './lib/sqlite_adapter.js';
import { embedText } from './lib/embeddings.js';
const db = getDb();

const testDocs = [
  { title: 'Backend Programming', text: 'Backend programming is the server-side development of web applications. It involves databases, APIs, and server logic. Popular languages include Python, Java, Go, Node.js, and Rust.' },
  { title: 'Python Django Framework', text: 'Django is a high-level Python web framework that encourages rapid development and clean, pragmatic design. It follows the model-template-views pattern.' },
  { title: 'Node.js Express Framework', text: 'Express is a minimal and flexible Node.js web application framework for building web and mobile applications and APIs.' },
  { title: 'System Design Interview', text: 'System design is the process of defining the architecture, components, interfaces, and data for a system. Key concepts include scalability, reliability, and performance.' },
  { title: 'Database Design Patterns', text: 'Database design involves organizing data according to a database model. It includes tables, relationships, indexes, and normalization.' },
  { title: 'REST API Design', text: 'REST API design principles include using HTTP methods correctly, stateless communication, resource-based URLs, and proper status codes.' },
  { title: 'Microservices Architecture', text: 'Microservices architecture is an approach where applications are built as a collection of small, independent services that communicate over APIs.' },
  { title: 'Docker Containers', text: 'Docker is a platform for developing, shipping, and running applications in containers. It enables consistent environments across development and production.' },
  { title: 'Kubernetes Orchestration', text: 'Kubernetes is an open-source container orchestration system for automating deployment, scaling, and management of containerized applications.' },
  { title: 'CI/CD Pipelines', text: 'CI/CD pipelines automate the process of building, testing, and deploying code. Tools include GitHub Actions, Jenkins, GitLab CI, and CircleCI.' },
];

console.log('Inserting test vector data...');
let inserted = 0;
for (const doc of testDocs) {
  try {
    const emb = await embedText(doc.text);
    const id = 'test-' + doc.title.toLowerCase().replace(/[^a-z0-9]/g, '-');
    const embBuffer = Buffer.from(new Float32Array(emb).buffer);
    db.prepare("INSERT OR REPLACE INTO vectors (id, doc_id, chunk_index, chunk_text, embedding, url, category, added_at) VALUES (?, ?, 0, ?, ?, ?, ?, datetime('now'))").run(id, id, doc.text, embBuffer, 'test', 'Backend');
    inserted++;
    console.log('  ✅', id);
  } catch (e) {
    console.log('  ❌', doc.title, ':', e.message);
  }
}

const count = db.prepare('SELECT COUNT(*) as c FROM vectors').get();
console.log(`\n✅ Inserted ${inserted} docs. Total vectors: ${count?.c}`);
