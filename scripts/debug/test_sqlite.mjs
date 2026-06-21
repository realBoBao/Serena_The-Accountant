import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(':memory:');
db.prepare("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, created_at TEXT)").run();
const now = new Date().toISOString();
db.prepare('INSERT INTO t (name, created_at) VALUES ($n, $d)').run({ $n: 'hello', $d: now });
const rows = db.prepare('SELECT * FROM t').all();
console.log(JSON.stringify(rows));
