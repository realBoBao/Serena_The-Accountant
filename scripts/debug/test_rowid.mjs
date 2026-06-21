import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(':memory:');
db.prepare('CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)').run();
const r = db.prepare('INSERT INTO t (name) VALUES ($n)').run({ $n: 'test' });
console.log('result:', JSON.stringify(r));
console.log('lastInsertRowid:', r?.lastInsertRowid);
console.log('changes:', r?.changes);
