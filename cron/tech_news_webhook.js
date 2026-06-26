#!/usr/bin/env node
/**
 * cron/tech_news_webhook.js — Lightweight tech news digest (TẬP CON của Pipeline)
 *
 * Nguồn: HN + Reddit + GitHub + arXiv → gửi Discord
 * Smart fetch: retry + rate-limit + fallback
 *
 * Usage: node cron/tech_news_webhook.js [topic]
 * Cron: 5x/day PDT (8AM, 11AM, 2PM, 5PM, 8PM)
 */

import 'dotenv/config';
import { httpGet, httpScrape, fetchText } from '../lib/http_client.js';
import { scoreContent, formatQualityBar } from '../lib/content_quality.js';
import { getDb, runQuery } from '../lib/db.js';

const TECH_WEBHOOK = process.env.TECH_WEBHOOK_URL;
if (!TECH_WEBHOOK) {
  console.error('❌ TECH_WEBHOOK_URL not set in .env');
  console.error('   Set it to your dedicated tech-news webhook URL.');
  process.exit(1);
}

const TECH_TOPICS = [
  'artificial intelligence', 'machine learning', 'distributed systems',
  'cloud computing', 'cybersecurity', 'devops', 'microservices',
  'kubernetes', 'rust programming', 'golang', 'typescript',
  'python', 'system design', 'database optimization', 'API design',
  'networking', 'open source', 'edge computing', 'IoT',
];

// ── Dedup: SQLite DB (survives restarts, unlike file-based) ──
async function ensureDedupTable() {
  const db = await getDb();
  await runQuery(db, `CREATE TABLE IF NOT EXISTS sent_news (url TEXT PRIMARY KEY, sent_at TEXT DEFAULT (datetime('now')))`);
}

async function isTopicSentToday(topic) {
  // Bỏ topic dedup — luôn gửi topic mới mỗi lần trigger
  // Chỉ dedup theo URL (tránh gửi cùng 1 link)
  return false;
}

async function recordSentTopic(topic, urls) {
  const db = await getDb();
  await runQuery(db, 'INSERT OR IGNORE INTO sent_news (url, sent_at) VALUES (?, ?)', [`topic:${topic}`, new Date().toISOString()]);
  for (const url of urls) {
    if (url) await runQuery(db, 'INSERT OR IGNORE INTO sent_news (url, sent_at) VALUES (?, ?)', [url, new Date().toISOString()]);
  }
}

// ── Smart fetcher (retry + rate-limit + fallback) ──
// Uses fetchJson for APIs, fetchText for HTML/XML

async function fetchHN(query, limit = 10) {
  // HN Algolia API — JSON endpoint, dùng httpGet với auto-retry
  const d = await httpGet(`https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=${limit}`);
  if (!d) return [];
  return (d.hits || []).map(h => ({ title: h.title || 'Untitled', url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`, pts: h.points || 0 }));
}

async function fetchReddit(query, limit = 10) {
  // Reddit JSON API — dùng httpGet với auto-retry
  const d = await httpGet(`https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&sort=relevance&t=week&limit=${limit}`);
  if (!d || !d.data?.children) return [];
  return d.data.children
    .filter(c => c.data && !c.data.stickied)
    .map(c => ({ title: c.data.title || 'Untitled', url: `https://reddit.com${c.data.permalink || ''}`, pts: c.data.score || 0 }))
    .slice(0, limit);
}

async function fetchGitHub(query, limit = 10) {
  // GitHub API — JSON endpoint, dùng httpGet với auto-retry
  const d = await httpGet(
    `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}+created:>2024-01-01&sort=stars&order=desc&per_page=${limit}`,
    { headers: { 'Accept': 'application/vnd.github.v3+json' } }
  );
  if (!d || !d.items) return [];
  return d.items.slice(0, limit).map(r => ({ title: r.full_name || 'Untitled', url: r.html_url || '', pts: r.stargazers_count || 0 }));
}

async function fetchArXiv(query, limit = 5) {
  // ArXiv API — XML endpoint, dùng fetchText với auto-retry
  const xml = await fetchText(`http://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&start=0&max_results=${limit}`);
  if (!xml) return [];
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(m => ({
    title: m[1].match(/<title>([\s\S]*?)<\/title>/)?.[1]?.trim().replace(/\s+/g, ' ') || 'Untitled',
    url: m[1].match(/<id>([^<]+)<\/id>/)?.[1] || '',
    pts: 0,
  }));
}

function pickRandomTopic() {
  return TECH_TOPICS[Math.floor(Math.random() * TECH_TOPICS.length)];
}

async function main() {
  const topic = process.argv[2] || pickRandomTopic();

  await ensureDedupTable();
  if (await isTopicSentToday(topic)) {
    console.log(`[TechNews] Already sent "${topic}" today — skip`);
    return;
  }

  console.log(`[TechNews] Fetching: "${topic}"`);

  const [hn, reddit, github, arxiv] = await Promise.all([
    fetchHN(topic, 10), fetchReddit(topic, 10), fetchGitHub(topic, 10), fetchArXiv(topic, 5),
  ]);

  let all = [
    ...hn.map(n => ({ ...n, src: 'HN', score: Math.min(1, n.pts / 500) })),
    ...reddit.map(n => ({ ...n, src: 'Reddit', score: Math.min(1, n.pts / 200) })),
    ...github.map(n => ({ ...n, src: 'GitHub', score: Math.min(1, n.pts / 1000) })),
    ...arxiv.map(n => ({ ...n, src: 'arXiv', score: 0.75 })),
  ];

  // ── Intra-run URL dedup (same URL from multiple sources) ──
  const seenUrls = new Set();
  all = all.filter(n => {
    if (!n.url || seenUrls.has(n.url)) return false;
    seenUrls.add(n.url);
    return true;
  });

  // ── Inter-run URL dedup via SQLite ──
  const db = await getDb();
  const sentRows = await runQuery(db, "SELECT url FROM sent_news WHERE sent_at >= datetime('now', '-7 days')");
  const sentUrls = new Set(sentRows.map(r => r.url));
  if (sentUrls.size > 0) {
    const before = all.length;
    all = all.filter(n => !sentUrls.has(n.url));
    if (all.length < before) {
      console.log(`[TechNews] Dedup: ${before} → ${all.length} (removed ${before - all.length} previously sent)`);
    }
  }

  // Nếu không còn gì mới → skip, không gửi trùng
  if (!all.length) {
    console.log('[TechNews] No new sources today — skip (no duplicate send)');
    return;
  }

  // ── Quality scoring (soft ranking — keep all, sort by quality) ──
  for (const item of all) {
    item.quality = scoreContent({ title: item.title, url: item.url, source: item.src, points: item.pts });
  }
  all.sort((a, b) => b.quality.score - a.quality.score);
  console.log(`[TechNews] Quality ranked: ${all.length} items (best first)`);

  const lines = all.slice(0, 15).map((n, i) => {
    const bar = formatQualityBar(n.quality.score);
    return `**${i + 1}.** ${n.quality.tag} [${n.src}] [${n.title.slice(0, 60)}](${n.url})\n   📊 ${bar}`;
  });

  const types = {};
  for (const n of all) types[n.src] = (types[n.src] || 0) + 1;

  // Use PDT date for consistency with other embeds
  const pdtDate = new Date().toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' });
  const embed = {
    title: `📰 Tech News: "${topic}" — ${pdtDate}`,
    description: [
      `📦 **Total:** ${all.length} | 📊 **By Type:** ${Object.entries(types).map(([t, c]) => `${t}: ${c}`).join(' | ')}`,
      '', ...lines,
    ].join('\n').slice(0, 4000),
    color: 0x00aa55,
    timestamp: new Date().toISOString(),
  };

  try {
    const res = await fetch(TECH_WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ embeds: [embed] }) });
    if (res.ok) {
      console.log(`[TechNews] ✅ Sent ${all.length} items`);
      // Record sent topic + URLs vào DB để lần sau không trùng
      await recordSentTopic(topic, all.map(n => n.url));
    } else {
      console.error('[TechNews] ❌ Failed:', res.status);
    }
  } catch (err) { console.error('[TechNews] ❌ Error:', err.message); }
}

main().catch(e => { console.error('[TechNews] Fatal:', e.message); process.exit(1); });
