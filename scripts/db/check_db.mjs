import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('./vectors.db');
const count = db.prepare('SELECT COUNT(*) as c FROM vectors').get();
console.log('Total vectors:', count.c);
const sample = db.prepare('SELECT id, doc_id, category FROM vectors LIMIT 10').all();
console.log('Sample:', JSON.stringify(sample, null, 2));
db.close();
