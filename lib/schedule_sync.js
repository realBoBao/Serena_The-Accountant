/**
 * Schedule Sync — Phase 11: Đồng bộ Lịch trình Tự động
 * Parse thời khóa biểu / syllabus từ file CSV hoặc Google Calendar
 * Nạp vào hệ thống nhắc việc và flashcard scheduler
 *
 * Usage:
 *   node scripts/sync_schedule.js --file schedule.csv
 *   node scripts/sync_schedule.js --url https://calendar.google.com/calendar/ical/...
 */

import fs from 'fs/promises';
import path from 'path';
import { addFlashcard } from './flashcard_db.js';

// ── CSV Parser ──
function parseCSV(content) {
  const lines = content.trim().split('\n');
  if (lines.length < 2) return [];

  const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',').map(v => v.trim());
    const row = {};
    headers.forEach((h, idx) => { row[h] = values[idx] || ''; });
    rows.push(row);
  }

  return rows;
}

// ── Schedule Entry ──
function createScheduleEntry(row) {
  // Expected columns: course, topic, date, time, type, description
  const course = row.course || row.subject || row.name || 'Unknown';
  const topic = row.topic || row.title || row.lesson || '';
  const date = row.date || row.day || '';
  const time = row.time || row.hour || '';
  const type = row.type || row.loai || 'lecture';
  const description = row.description || row.desc || row.note || '';

  return { course, topic, date, time, type, description };
}

// ── Generate Flashcards from Schedule ──
async function generateScheduleFlashcards(entries) {
  const results = [];

  for (const entry of entries) {
    const { course, topic, date, type, description } = entry;

    // Create a flashcard for each lecture/exam
    if (type.includes('exam') || type.includes('thi')) {
      const id = await addFlashcard({
        question: `Khi nào thi ${course}?`,
        answer: `Môn ${course} thi ngày ${date}. Chủ đề: ${topic}. ${description}`,
        source: 'schedule-sync',
        category: 'exam',
      });
      results.push({ id, type: 'exam-reminder', course, date });
    }

    if (type.includes('assignment') || type.includes('baitap')) {
      const id = await addFlashcard({
        question: `Bài tập/Topic: ${topic} (${course})`,
        answer: `Môn ${course}, ngày ${date}. ${description}`,
        source: 'schedule-sync',
        category: 'assignment',
      });
      results.push({ id, type: 'assignment', course, date });
    }

    // General lecture note
    if (topic && date) {
      const id = await addFlashcard({
        question: `Nội dung bài học ${course} ngày ${date}?`,
        answer: `${topic}. ${description}`,
        source: 'schedule-sync',
        category: 'lecture',
      });
      results.push({ id, type: 'lecture', course, date });
    }
  }

  return results;
}

// ── Main Sync Function ──
export async function syncSchedule(source, options = {}) {
  console.log(`[ScheduleSync] Syncing from: ${source}`);

  let entries = [];

  if (source.startsWith('http://') || source.startsWith('https://')) {
    // Fetch from URL (Google Calendar iCal, Discord attachment, etc.)
    const res = await fetch(source, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/calendar, text/csv, application/json, text/plain, */*',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    const text = await res.text();

    // Detect format từ content
    const isICal = source.includes('.ics') || text.includes('BEGIN:VCALENDAR') || text.includes('VCALENDAR');
    const isJSON = text.trim().startsWith('[') || text.trim().startsWith('{');
    
    if (isICal) {
      entries = parseICal(text);
    } else if (isJSON) {
      try {
        const parsed = JSON.parse(text);
        entries = Array.isArray(parsed) ? parsed.map(createScheduleEntry) : [createScheduleEntry(parsed)];
      } catch {
        entries = parseCSV(text);
      }
    } else {
      entries = parseCSV(text);
    }
  } else {
    // Read from local file
    const ext = path.extname(source).toLowerCase();
    const content = await fs.readFile(source, 'utf8');

    if (ext === '.csv') {
      const rows = parseCSV(content);
      entries = rows.map(createScheduleEntry);
    } else if (ext === '.json') {
      entries = JSON.parse(content);
    } else if (ext === '.ics') {
      entries = parseICal(content);
    } else {
      throw new Error(`Unsupported file format: ${ext}`);
    }
  }

  console.log(`[ScheduleSync] Parsed ${entries.length} schedule entries`);

  // Generate flashcards
  const flashcards = await generateScheduleFlashcards(entries);
  console.log(`[ScheduleSync] Created ${flashcards.length} flashcards`);

  return { entries, flashcards };
}

// ── iCal Parser (basic) ──
function parseICal(content) {
  const entries = [];
  const events = content.split('BEGIN:VEVENT');

  for (const event of events.slice(1)) {
    const get = (key) => {
      const match = event.match(new RegExp(`^${key}:(.+)$`, 'm'));
      return match ? match[1].trim() : '';
    };

    const summary = get('SUMMARY');
    const dtstart = get('DTSTART');
    const description = get('DESCRIPTION');

    // Parse date from iCal format: 20240603T090000Z
    let date = dtstart;
    if (dtstart.length >= 8) {
      date = `${dtstart.slice(0, 4)}-${dtstart.slice(4, 6)}-${dtstart.slice(6, 8)}`;
    }

    entries.push({
      course: summary.split('-')[0]?.trim() || summary,
      topic: summary,
      date,
      time: dtstart.length >= 13 ? `${dtstart.slice(9, 11)}:${dtstart.slice(11, 13)}` : '',
      type: summary.toLowerCase().includes('exam') ? 'exam' : 'lecture',
      description,
    });
  }

  return entries;
}

// ── CLI ──
async function main() {
  const args = process.argv.slice(2);
  const sourceIdx = args.findIndex(a => a === '--file' || a === '--url');
  if (sourceIdx === -1 || !args[sourceIdx + 1]) {
    console.log('Usage: node scripts/sync_schedule.js --file <path> | --url <url>');
    console.log('');
    console.log('Supported formats: CSV, JSON, iCal (.ics)');
    console.log('');
    console.log('CSV columns: course, topic, date, time, type, description');
    process.exit(1);
  }

  const source = args[sourceIdx + 1];
  const result = await syncSchedule(source);

  console.log('\n📅 Schedule Sync Complete:');
  console.log(`  Entries parsed: ${result.entries.length}`);
  console.log(`  Flashcards created: ${result.flashcards.length}`);

  if (result.flashcards.length > 0) {
    console.log('\n📝 Flashcard Summary:');
    const byType = {};
    for (const fc of result.flashcards) {
      byType[fc.type] = (byType[fc.type] || 0) + 1;
    }
    for (const [type, count] of Object.entries(byType)) {
      console.log(`  ${type}: ${count}`);
    }
  }
}

const isDirectRun = typeof process.argv[1] === 'string' && process.argv[1].endsWith('sync_schedule.js');
if (isDirectRun) {
  main().catch(err => {
    console.error('[ScheduleSync] Error:', err.message);
    process.exit(1);
  });
}
