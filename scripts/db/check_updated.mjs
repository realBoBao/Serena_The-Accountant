import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('./vectors.db');

// Check updated_at for test vs real
const test = db.prepare("SELECT id, updated_at FROM vectors WHERE id LIKE 'test-%' ORDER BY updated_at DESC LIMIT 3").all();
const real = db.prepare("SELECT id, updated_at FROM vectors WHERE id NOT LIKE 'test-%' ORDER BY updated_at DESC LIMIT 3").all();

console.log('Test data (newest):', JSON.stringify(test, null, 2));
console.log('Real data (newest):', JSON.stringify(real, null, 2));

// Count by updated_at range
const testNewer = db.prepare("SELECT COUNT(*) as c FROM vectors WHERE id LIKE 'test-%' AND updated_at > (SELECT MAX(updated_at) FROM vectors WHERE id NOT LIKE 'test-%')").get();
console.log('\nTest data newer than all real data:', testNewer.c);

db.close();
