import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('./vectors.db');
const test = db.prepare("SELECT COUNT(*) as c FROM vectors WHERE id LIKE 'test-%'").get();
const real = db.prepare("SELECT COUNT(*) as c FROM vectors WHERE id NOT LIKE 'test-%'").get();
console.log('Test vectors:', test.c);
console.log('Real vectors:', real.c);

// Check categories
const cats = db.prepare('SELECT category, COUNT(*) as cnt FROM vectors GROUP BY category ORDER BY cnt DESC').all();
console.log('\nCategories:', JSON.stringify(cats, null, 2));

// Check domains
const domains = db.prepare('SELECT domain, COUNT(*) as cnt FROM vectors WHERE domain IS NOT NULL GROUP BY domain ORDER BY cnt DESC').all();
console.log('\nDomains:', JSON.stringify(domains, null, 2));

db.close();
