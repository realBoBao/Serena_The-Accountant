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
import { scoreContent, formatQualityBar } from '../lib/content_quality.js';
import { fetchCodeforces, fetchHackerearth, fetchKontests } from '../lib/free_apis.js';

const ALGO_WEBHOOK_URL = process.env.ALGO_WEBHOOK_URL;
if (!ALGO_WEBHOOK_URL) {
  console.error('❌ ALGO_WEBHOOK_URL not set in .env');
  console.error('   Create a separate webhook for algo: Discord Server Settings → Integrations → Webhooks');
  process.exit(1);
}
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

  console.log('[AlgoBot] Fetching algorithm problems...');

  // ── Fetch from all sources in parallel ──
  const [leetcode, cf, he, kontests] = await Promise.all([
    fetchLeetCodeProblemByDifficulty('easy').catch(async () => {
      const ql = await fetchLeetCodeProblem();
      return ql?.question || null;
    }),
    fetchCodeforces(5).catch(() => []),
    fetchHackerearth(5).catch(() => []),
    fetchKontests(5).catch(() => []),
  ]);

  // ── Build main problem (LeetCode) ──
  if (!leetcode) {
    console.error('[AlgoBot] Failed to fetch LeetCode problem');
    return;
  }

  const title = leetcode.title;
  const difficulty = leetcode.difficulty;
  const tags = (leetcode.topicTags || []).map(t => t.name).join(', ');
  const content = leetcode.content?.replace(/<[^>]+>/g, '').slice(0, 1000) || 'Xem đề bài tại link bên dưới.';
  const link = `https://leetcode.com/problems/${leetcode.titleSlug}/`;

  // ── Quality score ──
  const quality = scoreContent({ title, url: link, source: 'LeetCode', description: content });
  console.log(`[AlgoBot] Quality: ${quality.score} (${quality.level}) ${quality.tag}`);

  // ── Build bonus problems from free sources ──
  const bonusProblems = [
    ...cf.map(p => ({ ...p, src: 'Codeforces' })),
    ...he.map(p => ({ ...p, src: 'Hackerearth' })),
    ...kontests.map(p => ({ ...p, src: 'KONTESTS' })),
  ];

  // Score and sort bonus problems
  for (const p of bonusProblems) {
    p.quality = scoreContent({ title: p.title, url: p.url, source: p.src });
  }
  bonusProblems.sort((a, b) => b.quality.score - a.quality.score);

  const topBonus = bonusProblems.slice(0, 3);

  // ── Build bonus section ──
  let bonusText = '';
  if (topBonus.length > 0) {
    bonusText = '\n\n🎯 **Bonus Challenges:**\n';
    for (const p of topBonus) {
      bonusText += `• [${p.title}](${p.url}) (${p.src}) ${p.quality.tag}\n`;
    }
  }

  // ── Gửi Webhook: Nhúng thẳng đáp án dưới dạng Spoiler ──
  const payload = {
    embeds: [{
      color: difficulty === 'Easy' ? 0x22c55e : difficulty === 'Medium' ? 0xf59e0b : 0xff0000,
      title: `🧠 Daily Algorithm — ${title}`,
      description: `**Difficulty:** ${difficulty}\n**Tags:** ${tags}\n📊 **Quality:** ${quality.tag} ${formatQualityBar(quality.score)}\n\n${content.slice(0, 500)}\n\n[📝 Bấm vào đây để Giải](${link})\n\n💡 **Đáp án (Click để xem):** ||[Xem Solution Code trên LeetCode](${link}editorial/)||${bonusText}`,
      footer: { text: `Không cần gõ !done nữa, hãy tự giác học tập nhé! | Sources: LeetCode + ${topBonus.length} bonus` },
      timestamp: new Date().toISOString(),
    }],
  };

  const ok = await sendWebhook(payload);
  console.log(`[AlgoBot] Sent: ${title} (${difficulty}) + ${topBonus.length} bonus — ${ok ? 'OK' : 'FAILED'}`);
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
