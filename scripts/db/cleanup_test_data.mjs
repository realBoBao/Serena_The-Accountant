import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('./vectors.db');

// Delete test data
const result = db.prepare("DELETE FROM vectors WHERE id LIKE 'test-%'").run();
console.log('Deleted test vectors:', result.changes);

// Verify
const count = db.prepare('SELECT COUNT(*) as c FROM vectors').get();
console.log('Remaining vectors:', count.c);

db.close();
