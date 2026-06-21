/**
 * data/load_devops_db.js — Load devops_resources.json into SQLite
 * Run: node data/load_devops_db.js
 * Creates data/devops.db with searchable resources for PlannerAgent
 */
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { readFileSync } from 'fs';

const DB = new URL('./devops.db', import.meta.url).pathname;
const json = JSON.parse(readFileSync(new URL('./devops_resources.json', import.meta.url), 'utf8'));

const db = await open({ filename: DB, driver: sqlite3.Database });

await db.exec(`
  CREATE TABLE IF NOT EXISTS devops_resources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    url TEXT,
    category TEXT NOT NULL,
    source TEXT,
    tier TEXT DEFAULT 'Free',
    description TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )
`);

await db.exec('DELETE FROM devops_resources'); // Refresh

for (const cat of json.categories) {
  for (const item of cat.items) {
    await db.run(
      'INSERT INTO devops_resources (name, url, category, source, tier, description) VALUES (?, ?, ?, ?, ?, ?)',
      item.name, item.url || '', cat.name, cat.source, item.tier || 'Free', item.desc || ''
    );
  }
}

const count = await db.get('SELECT COUNT(*) as c FROM devops_resources');
console.log(`Loaded ${count.c} devops resources into ${DB}`);
