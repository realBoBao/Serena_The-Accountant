/**
 * lib/anki_export.js — Anki Flashcard Export
 *
 * Tích hợp chức năng từ: migrate_csv_to_anki.js, anki_connect.js
 *
 * Cung cấp:
 *   - exportToAnki(flashcards, deckName) → Export flashcards sang Anki (via AnkiConnect)
 *   - exportToCsv(flashcards, filePath)  → Export sang CSV (import thủ công vào Anki)
 *   - importFromCsv(filePath)           → Import flashcards từ CSV
 *
 * Được gọi bởi:
 * - discord_bot.js (!anki export)
 * - REST API (/api/flashcards/export)
 * - pipeline_report_v2.js (khi cần export flashcards)
 */

import 'dotenv/config';
import { getLogger } from './logger.js';
import { addFlashcard, getDueFlashcards, getRandomFlashcards, getStats } from './flashcard_db.js';

const logger = getLogger('AnkiExport');

// ── AnkiConnect API ──────────────────────────────────────

/**
 * Gọi AnkiConnect API (Anki phải đang chạy với AnkiConnect addon)
 */
async function ankiConnect(action, params = {}, version = 6) {
  const ANKI_CONNECT_URL = process.env.ANKI_CONNECT_URL || 'http://localhost:8765';

  try {
    const res = await fetch(ANKI_CONNECT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, version, params }),
      signal: AbortSignal.timeout(5000),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    return data.result;
  } catch (err) {
    logger.warn('[AnkiExport] AnkiConnect error:', err.message);
    return null;
  }
}

/**
 * Kiểm tra AnkiConnect có sẵn không
 */
export async function isAnkiAvailable() {
  const result = await ankiConnect('version');
  return result !== null;
}

/**
 * Lất danh sách decks
 */
export async function getDecks() {
  return await ankiConnect('deckNames') || [];
}

/**
 * Tạo deck mới (nếu chưa có)
 */
export async function createDeck(deckName) {
  return await ankiConnect('createDeck', { deck: deckName });
}

/**
 * Export flashcards từ DB sang Anki (via AnkiConnect)
 */
export async function exportToAnki(flashcards, deckName = 'AI Brain', noteType = 'Basic') {
  const available = await isAnkiAvailable();
  if (!available) {
    logger.warn('[AnkiExport] AnkiConnect not available — use CSV export instead');
    return { success: false, reason: 'AnkiConnect not available' };
  }

  // Tạo deck nếu chưa có
  await createDeck(deckName);

  let added = 0;
  let failed = 0;

  for (const card of flashcards) {
    const front = card.question || card.front || '';
    const back = card.answer || card.back || '';
    if (!front || !back) { failed++; continue; }

    // Thêm tags nếu có
    const tags = card.tags || [];
    if (card.category) tags.push(card.category);
    if (card.source) tags.push(card.source.replace(/[^a-zA-Z0-9]/g, '_'));

    try {
      await ankiConnect('addNote', {
        note: {
          deckName,
          modelName: noteType,
          fields: { Front: front, Back: back },
          tags,
        },
      });
      added++;
    } catch {
      failed++;
    }
  }

  logger.info(`[AnkiExport] Exported ${added} cards to Anki deck "${deckName}" (${failed} failed)`);
  return { success: true, added, failed, deckName };
}

/**
 * Export flashcards sang CSV (import thủ công vào Anki)
 */
export async function exportToCsv(flashcards, filePath = './flashcards_export.csv') {
  const fs = await import('fs');

  const lines = ['question,answer,tags,category,source'];
  for (const card of flashcards) {
    const q = (card.question || card.front || '').replace(/"/g, '""');
    const a = (card.answer || card.back || '').replace(/"/g, '""');
    const tags = (card.tags || []).join(';');
    const cat = card.category || '';
    const src = card.source || '';
    lines.push(`"${q}",""${a}","${tags}","${cat}","${src}"`);
  }

  fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
  logger.info(`[AnkiExport] Exported ${flashcards.length} cards to ${filePath}`);
  return { success: true, count: flashcards.length, filePath };
}

/**
 * Import flashcards từ CSV
 */
export async function importFromCsv(filePath = './flashcards_export.csv') {
  const fs = await import('fs');
  if (!fs.existsSync(filePath)) return { success: false, reason: 'File not found' };

  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n').slice(1); // Skip header

  let imported = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    const parts = line.split(',').map(p => p.replace(/^"|"$/g, '').replace(/""/g, '"'));
    if (parts.length >= 2) {
      await addFlashcard({
        question: parts[0],
        answer: parts[1],
        tags: parts[2] ? parts[2].split(';') : [],
        category: parts[3] || 'imported',
        source: parts[4] || filePath,
      });
      imported++;
    }
  }

  logger.info(`[AnkiExport] Imported ${imported} cards from ${filePath}`);
  return { success: true, imported };
}

/**
 * Export tất cả flashcards từ DB sang Anki
 */
export async function exportAllToAnki(deckName = 'AI Brain') {
  const flashcards = await getRandomFlashcards(1000); // Lấy tất cả
  return exportToAnki(flashcards, deckName);
}

export default { isAnkiAvailable, getDecks, createDeck, exportToAnki, exportToCsv, importFromCsv, exportAllToAnki };
