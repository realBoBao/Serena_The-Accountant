import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('./vectors.db');

// Check space in metadata
const sample = db.prepare('SELECT id, metadata FROM vectors LIMIT 5').all();
for (const r of sample) {
  console.log(r.id, ':', r.metadata?.slice(0, 100));
}

// Check how many have space=academic
const academic = db.prepare("SELECT COUNT(*) as c FROM vectors WHERE metadata LIKE '%\"space\":\"academic\"%'").get();
const all = db.prepare('SELECT COUNT(*) as c FROM vectors').get();
console.log('\nAcademic space:', academic.c, '/', all.c);

db.close();
