/**
 * cron/algo_webhook.js — Daily Algorithm Problem từ LeetCode
 * Stateless: gửi đáp án ngay trong Spoiler, không cần DB
 * Catch-up: nếu đã gửi hôm nay thì skip
 *
 * Smart fetch: retry + rate-limit cho LeetCode GraphQL API
 */

import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { httpGet, httpPost } from '../lib/http_client.js';

const ALGO_WEBHOOK_URL = process.env.ALGO_WEBHOOK_URL || '';
const CATCHUP_FILE = path.resolve('./.algo_catchup.json');

function getPdtDate() {
  const now = new Date();
  const pdt = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  return `${pdt.getFullYear()}-${String(pdt.getMonth() + 1).padStart(2, '0')}-${String(pdt.getDate()).padStart(2, '0')}`;
}

async function wasSentToday() {
  try {
    const data = JSON.parse(await fs.readFile(CATCHUP_FILE, 'utf8'));
    return data[getPdtDate()] === true;
  } catch { return false; }
}

async function markSent() {
  try {
    let data = {};
    try { data = JSON.parse(await fs.readFile(CATCHUP_FILE, 'utf8')); } catch {}
    data[getPdtDate()] = true;
    await fs.writeFile(CATCHUP_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch { /* ignore */ }
}

// ── LeetCode GraphQL API ────────────────────────────────────────────────────

// Lấy random problem theo difficulty từ LeetCode
async function fetchLeetCodeProblemByDifficulty(difficulty) {
  // Map difficulty sang LeetCode slug
  const diffSlug = difficulty === 'easy' ? 'EASY' : difficulty === 'medium' ? 'MEDIUM' : difficulty === 'hard' ? 'HARD' : 'HARD'; // expert = hard+

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

  // Dùng httpPost với auto-retry
  const data = await httpPost('https://leetcode.com/graphql', {
    query,
    variables: {
      categorySlug: 'all-code-essentials',
      limit: 1,
      skip,
      filters: { difficulty: diffSlug },
    },
  }, {
    headers: { 'Content-Type': 'application/json' },
  });

  return data?.data?.problemsetQuestionList?.questions?.[0];
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
  // ── Catch-up: Skip if already sent today ──
  if (await wasSentToday()) {
    console.log('[AlgoBot] Already sent today — skipping (catch-up)');
    return;
  }

  console.log('[AlgoBot] Fetching LeetCode problem...');

  // ── Determine difficulty (default: easy, no DB dependency) ──
  const targetDifficulty = 'easy';
  console.log(`[AlgoBot] Target difficulty: ${targetDifficulty}`);

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

  // ── Gửi Webhook: Nhúng thẳng đáp án dưới dạng Spoiler ──
  const payload = {
    embeds: [{
      color: difficulty === 'Easy' ? 0x22c55e : difficulty === 'Medium' ? 0xf59e0b : 0xff0000,
      title: `🧠 Daily Algorithm — ${title}`,
      description: `**Difficulty:** ${difficulty}\n**Tags:** ${tags}\n\n${content.slice(0, 500)}\n\n[📝 Bấm vào đây để Giải](${link})\n\n💡 **Đáp án (Click để xem):** ||[Xem Solution Code trên LeetCode](${link}editorial/)||`,
      footer: { text: 'Không cần gõ !done nữa, hãy tự giác học tập nhé!' },
      timestamp: new Date().toISOString(),
    }],
  };

  const ok = await sendWebhook(payload);
  console.log(`[AlgoBot] Sent: ${title} (${difficulty}) — ${ok ? 'OK' : 'FAILED'}`);
  if (ok) await markSent(); // Mark as sent for catch-up
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const mode = process.argv[2] || 'daily';

switch (mode) {
  case 'daily':
    await sendDailyProblem();
    break;
  default:
    console.log('Usage: node cron/algo_webhook.js daily');
}
