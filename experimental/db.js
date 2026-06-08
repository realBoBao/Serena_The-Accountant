import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import path from 'path';

const DB_PATH = path.resolve('./data.db');

export async function getDb(){
  const db = await open({ filename: DB_PATH, driver: sqlite3.Database });
  await db.exec(`CREATE TABLE IF NOT EXISTS processed (
    id TEXT PRIMARY KEY,
    type TEXT,
    url TEXT,
    hash TEXT,
    processed_at TEXT
  )`);
  return db;
}

export async function isProcessed(id){
  const db = await getDb();
  const row = await db.get('SELECT id FROM processed WHERE id = ?', id);
  await db.close();
  return !!row;
}

export async function markProcessed({id, type, url, hash}){
  const db = await getDb();
  await db.run('INSERT OR REPLACE INTO processed(id,type,url,hash,processed_at) VALUES(?,?,?,?,?)', id, type, url, hash || '', new Date().toISOString());
  await db.close();
}
