/**
 * JSON Store — Simple file-based JSON read/write with atomic writes
 * @module lib/json_store
 */

import fs from 'fs/promises';
import path from 'path';

/**
 * Read JSON file, return default if not exists or invalid
 */
export async function readJson(filePath, defaultValue = {}) {
  try {
    const data = await fs.readFile(filePath, 'utf8');
    return JSON.parse(data);
  } catch {
    return defaultValue;
  }
}

/**
 * Write JSON file atomically (write to temp, then rename)
 */
export async function writeJson(filePath, data) {
  const tmpPath = filePath + '.tmp.' + process.pid;
  await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf8');
  await fs.rename(tmpPath, filePath);
}

/**
 * Append to a JSON array file
 */
export async function appendJsonArray(filePath, item, maxItems = 1000) {
  const arr = await readJson(filePath, []);
  arr.push(item);
  if (arr.length > maxItems) arr.splice(0, arr.length - maxItems);
  await writeJson(filePath, arr);
}
