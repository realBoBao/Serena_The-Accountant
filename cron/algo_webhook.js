/**
 * scripts/algo_webhook.js — Daily Algorithm Problem từ LeetCode
 * Compatible với cả Node 20 (better-sqlite3) và Node 22+ (node:sqlite)
 */

import 'dotenv/config';

const DB_PATH = './vectors.db';
const ALGO_WEBHOOK_URL = process.env.ALGO_WEBHOOK_URL || '';

// ── SQLite helper — tương thích Node 20 và Node 22+ ─────────────────────────

async function withDb(fn) {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(DB_PATH);
    const result = fn(db);
    db.close();
    return result;
  } catch {
    // Node 20 fallback
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(DB_PATH);
    const result = fn(db);
    db.close();
    return result;
  }
}

// ── LeetCode GraphQL API ────────────────────────────────────────────────────

// Lấy random problem theo difficulty từ LeetCode
async function fetchLeetCodeProblemByDifficulty(difficulty) {
  // Map difficulty sang LeetCode slug
  const diffSlug = difficulty === 'easy' ? 'EASY' : difficulty === 'medium' ? 'MEDIUM' : 'HARD';

  const query = `query problemsetQuestionList($categorySlug: String, $limit: Int, $skip: Int, $filters: QuestionListFilterInput) {
    problemsetQuestionList: questionList(
      categorySlug: $categorySlug
      limit: $limit
      skip: $skip
      filters: $filters
    ) {
      total: totalNum
      questions: data {
        questionId
        title
        titleSlug
        difficulty
        content
        topicTags { name slug }
      }
    }
  }`;

  // Random offset để lấy bài khác nhau mỗi ngày
  const seed = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const skip = parseInt(seed) % 100;

  const res = await fetch('https://leetcode.com/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query,
      variables: {
        categorySlug: 'all-code-essentials',
        limit: 1,
        skip,
        filters: { difficulty: diffSlug },
      },
    }),
  });

  const data = await res.json();
  return data.data?.problemsetQuestionList?.questions?.[0];
}

// Lấy random problem (fallback)
async function fetchLeetCodeProblem() {
  const query = `query {
    activeDailyCodingChallengeQuestion {
      date
      link
      question {
        questionId
        title
        titleSlug
        difficulty
        content
        topicTags { name slug }
        hints
      }
    }
  }`;

  const res = await fetch('https://leetcode.com/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });

  const data = await res.json();
  return data.data?.activeDailyCodingChallengeQuestion;
}

// ── Discord Webhook ─────────────────────────────────────────────────────────

async function sendWebhook(payload) {
  if (!ALGO_WEBHOOK_URL) {
    console.log('[AlgoBot] ALGO_WEBHOOK_URL not set');
    return false;
  }
  const res = await fetch(ALGO_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return res.ok;
}

// ── Daily: Gửi bài mới ─────────────────────────────────────────────────────

async function sendDailyProblem() {
  console.log('[AlgoBot] Fetching LeetCode problem...');

  // Xác định difficulty dựa trên tier
  const stats = await withDb(db => {
    const row = db.prepare("SELECT value FROM algo_daily WHERE key = 'user_stats'").get();
    return row ? JSON.parse(row.value) : { tier: 1, easySolved: 0, mediumSolved: 0, hardSolved: 0 };
  });

  const tier = stats.tier || 1;
  const difficultyMap = { 1: 'easy', 2: 'medium', 3: 'hard', 4: 'expert' };
  const targetDifficulty = difficultyMap[tier] || 'easy';

  // Tier upgrade logic
  if (stats.easySolved >= 30 && tier === 1) stats.tier = 2;
  if (stats.mediumSolved >= 50 && tier === 2) stats.tier = 3;
  if (stats.hardSolved >= 30 && tier === 3) stats.tier = 4;

  // Fetch problem theo difficulty
  let q = await fetchLeetCodeProblemByDifficulty(targetDifficulty);
  if (!q) {
    console.warn('[AlgoBot] Fallback to daily challenge');
    const ql = await fetchLeetCodeProblem();
    q = ql?.question;
  }

  if (!q) {
    console.error('[AlgoBot] Failed to fetch any problem');
    return;
  }

  const title = q.title;
  const difficulty = q.difficulty;
  const tags = (q.topicTags || []).map(t => t.name).join(', ');
  const content = q.content?.replace(/<[^>]+>/g, '').slice(0, 1000) || 'Xem đề bài tại link bên dưới.';
  const link = `https://leetcode.com/problems/${q.titleSlug}/`;
  const today = new Date().toISOString().slice(0, 10);

  // Lưu vào DB
  await withDb(db => {
    db.exec(`CREATE TABLE IF NOT EXISTS algo_daily (key TEXT PRIMARY KEY, value TEXT, created_at TEXT)`);
    db.prepare('INSERT OR REPLACE INTO algo_daily VALUES (?, ?, ?)').run(
      'current_problem',
      JSON.stringify({ title, difficulty, tags, content, link, date: today }),
      new Date().toISOString()
    );
  });

  // Gửi webhook
  const payload = {
    embeds: [{
      color: difficulty === 'Easy' ? 0x22c55e : difficulty === 'Medium' ? 0xf59e0b : 0xff0000,
      title: `🧠 Daily Algorithm — ${title}`,
      description: `**Difficulty:** ${difficulty}\n**Tags:** ${tags}\n\n${content.slice(0, 500)}\n\n[📝 Giải bài này](${link})`,
      footer: { text: 'Gõ !done khi đã giải xong. Đáp án sẽ gửi lúc 23:59 nếu chưa giải.' },
      timestamp: new Date().toISOString(),
    }],
  };

  const ok = await sendWebhook(payload);
  console.log(`[AlgoBot] Sent: ${title} (${difficulty}) — ${ok ? 'OK' : 'FAILED'}`);
}

// ── Answer: Gửi đáp án 23:59 ────────────────────────────────────────────────

async function sendAnswer() {
  console.log('[AlgoBot] Checking if answer needed...');

  const problem = await withDb(db => {
    const row = db.prepare("SELECT value FROM algo_daily WHERE key = 'current_problem'").get();
    return row ? JSON.parse(row.value) : null;
  });

  if (!problem) {
    console.log('[AlgoBot] No current problem.');
    return;
  }

  const solved = await withDb(db => {
    const row = db.prepare("SELECT value FROM algo_daily WHERE key = 'solved'").get();
    return row?.value;
  });

  const today = new Date().toISOString().slice(0, 10);
  if (solved === today) {
    console.log('[AlgoBot] Already solved today.');
    return;
  }

  const payload = {
    embeds: [{
      color: 0x22c55e,
      title: `💡 Đáp án: ${problem.title}`,
      description: `**Difficulty:** ${problem.difficulty}\n**Tags:** ${problem.tags}\n\n${problem.content?.slice(0, 1000) || 'Xem solution tại LeetCode.'}\n\n[📝 Xem solution](${problem.link})`,
      footer: { text: 'Hôm nay lại có bài mới lúc 8AM!' },
      timestamp: new Date().toISOString(),
    }],
  };

  const ok = await sendWebhook(payload);
  console.log(`[AlgoBot] Sent answer: ${problem.title} — ${ok ? 'OK' : 'FAILED'}`);
}

// ── Mark solved ─────────────────────────────────────────────────────────────

async function markSolved() {
  await withDb(db => {
    db.exec(`CREATE TABLE IF NOT EXISTS algo_daily (key TEXT PRIMARY KEY, value TEXT, created_at TEXT)`);
    const today = new Date().toISOString().slice(0, 10);
    db.prepare('INSERT OR REPLACE INTO algo_daily VALUES (?, ?, ?)').run('solved', today, new Date().toISOString());
  });
  console.log('[AlgoBot] Marked as solved.');
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const mode = process.argv[2] || 'daily';

switch (mode) {
  case 'daily':
    await sendDailyProblem();
    break;
  case 'answer':
    await sendAnswer();
    break;
  case 'done':
    await markSolved();
    break;
  default:
    console.log('Usage: node scripts/algo_webhook.js [daily|answer|done]');
}
