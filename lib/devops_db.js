/**
 * lib/devops_db.js — Query DevOps free resources database
 * PlannerAgent uses this to find $0 alternatives to paid services
 *
 * @module lib/devops_db
 */
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import path from 'path';

const DB_PATH = path.resolve('./data/devops.db');

let _db = null;

async function getDb() {
  if (_db) return _db;
  _db = await open({ filename: DB_PATH, driver: sqlite3.Database });
  return _db;
}

/**
 * Search devops resources by category or keyword.
 * @param {string} query — Search term (category name or keyword)
 * @param {number} [limit=5]
 * @returns {Promise<Array>}
 */
export async function searchResources(query, limit = 5) {
  try {
    const db = await getDb();
    return await db.all(
      `SELECT name, url, category, tier, description FROM devops_resources
       WHERE category LIKE ? OR name LIKE ? OR description LIKE ?
       LIMIT ?`,
      `%${query}%`, `%${query}%`, `%${query}%`, limit
    );
  } catch { return []; }
}

/**
 * Get all categories.
 * @returns {Promise<Array>}
 */
export async function getCategories() {
  try {
    const db = await getDb();
    return await db.all('SELECT DISTINCT category FROM devops_resources');
  } catch { return []; }
}

/**
 * Get resources by exact category.
 * @param {string} category
 * @returns {Promise<Array>}
 */
export async function getByCategory(category) {
  try {
    const db = await getDb();
    return await db.all(
      'SELECT name, url, tier, description FROM devops_resources WHERE category = ?',
      category
    );
  } catch { return []; }
}

export default { searchResources, getCategories, getByCategory };
