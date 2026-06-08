#!/usr/bin/env node
/**
 * Schedule Sync CLI — Phase 11: Đồng bộ Lịch trình Tự động
 *
 * Parse thời khóa biểu / syllabus từ file CSV, JSON, hoặc iCal (.ics)
 * Nạp vào hệ thống flashcard và nhắc việc
 *
 * Usage:
 *   node scripts/sync_schedule.js --file schedule.csv
 *   node scripts/sync_schedule.js --file schedule.ics
 *   node scripts/sync_schedule.js --url https://calendar.google.com/calendar/ical/xxx.ics
 *   node scripts/sync_schedule.js --file schedule.csv --dry-run
 *
 * CSV columns: course, topic, date, time, type, description
 * Types: lecture, exam, assignment
 */

import { syncSchedule } from '../lib/schedule_sync.js';
import { addFlashcard } from '../lib/flashcard_db.js';

async function main() {
  const args = process.argv.slice(2);

  // Parse args
  const fileIdx = args.indexOf('--file');
  const urlIdx = args.indexOf('--url');
  const dryRun = args.includes('--dry-run');
  const listOnly = args.includes('--list');

  if (listOnly) {
    console.log('📅 Schedule Sync — Available options:');
    console.log('  --file <path>   Sync from local file (CSV, JSON, iCal)');
    console.log('  --url <url>     Sync from URL (Google Calendar iCal)');
    console.log('  --dry-run       Parse only, don\'t create flashcards');
    console.log('');
    console.log('CSV format: course, topic, date, time, type, description');
    console.log('Types: lecture, exam, assignment');
    process.exit(0);
  }

  let source = null;
  if (fileIdx !== -1 && args[fileIdx + 1]) {
    source = args[fileIdx + 1];
  } else if (urlIdx !== -1 && args[urlIdx + 1]) {
    source = args[urlIdx + 1];
  }

  if (!source) {
    console.log('📅 Schedule Sync — Parse thời khóa biểu / syllabus');
    console.log('');
    console.log('Usage:');
    console.log('  node scripts/sync_schedule.js --file <path>');
    console.log('  node scripts/sync_schedule.js --url <url>');
    console.log('  node scripts/sync_schedule.js --file schedule.csv --dry-run');
    console.log('');
    console.log('Supported formats: CSV, JSON, iCal (.ics)');
    console.log('');
    console.log('CSV columns: course, topic, date, time, type, description');
    console.log('');
    console.log('Example CSV:');
    console.log('  course,topic,date,time,type,description');
    console.log('  CS101,Arrays & Lists,2026-06-10,09:00,lecture,Introduction to data structures');
    console.log('  CS101,Midterm Exam,2026-06-20,14:00,exam,Chapters 1-5');
    process.exit(1);
  }

  console.log(`📅 Schedule Sync: ${source}`);
  if (dryRun) console.log('🔍 Dry-run mode — no flashcards will be created');
  console.log('');

  try {
    const result = await syncSchedule(source, { dryRun });

    console.log('📊 Results:');
    console.log(`  Entries parsed: ${result.entries.length}`);
    console.log(`  Flashcards created: ${result.flashcards.length}`);

    if (result.flashcards.length > 0) {
      console.log('');
      console.log('📝 Flashcard Summary:');
      const byType = {};
      for (const fc of result.flashcards) {
        byType[fc.type] = (byType[fc.type] || 0) + 1;
      }
      for (const [type, count] of Object.entries(byType)) {
        console.log(`  ${type}: ${count}`);
      }

      // Show next review dates
      console.log('');
      console.log('📆 Next Reviews:');
      for (const entry of result.entries.slice(0, 5)) {
        if (entry.date && entry.topic) {
          console.log(`  ${entry.date} — ${entry.course}: ${entry.topic}`);
        }
      }
      if (result.entries.length > 5) {
        console.log(`  ... and ${result.entries.length - 5} more`);
      }
    }

    console.log('');
    console.log('✅ Schedule sync complete!');
  } catch (err) {
    console.error('❌ Schedule sync failed:', err.message);
    process.exit(1);
  }
}

main();
