#!/usr/bin/env node
/**
 * cron/tech_news_webhook.js — Lightweight tech news digest (TẬP CON của Pipeline)
 *
 * Chỉ fetch HN + Reddit + GitHub + arXiv → gửi Discord
 * Không scrape sâu, không embed, không tạo flashcard
 *
 * Usage: node cron/tech_news_webhook.js [topic]
 * Cron: 5x/day PDT (8AM, 11AM, 2PM, 5PM, 8PM)
 */

import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';

const TECH_WEBHOOK = process.env.TECH_WEBHOOK_URL || process.env.DISCORD_WEBHOOK;
if (!TECH_WEBHOOK) { console.error('❌ TECH_WEBHOOK_URL not set'); process.exit(1); }

const TECH_TOPICS = [
  'artificial intelligence', 'machine learning', 'distributed systems',
  'cloud computing', 'cybersecurity', 'devops', 'microservices',
  'kubernetes', 'rust programming', 'golang', 'typescript',
  'python', 'system design', 'database optimization', 'API design',
  'networking', 'open source', 'edge computing', 'IoT',
];

const TOPIC_HISTORY = path.resolve('./.topic_history.json');
const CATCHUP_FILE = path.resolve('./.tech_news_catchup.json');

function loadHistorySync() {
  try { return JSON.parse(require('fs').readFileSync(TOPIC_HISTORY, 'utf8'))[new Date().toISOString().slice(0, 10)] || []; }
  catch { return []; }
}

async function saveHistory(topic) {
  try {
    let d = {}; try { d = JSON.parse(await fs.readFile(TOPIC_HISTORY, 'utf8')); } catch {}
    const t = new Date().toISOString().slice(0, 10);
    if (!d[t]) d[t] = [];
    d[t].push({ topic, ts: new Date().toISOString() });
    await fs.writeFile(TOPIC_HISTORY, JSON.stringify(d, null, 2), 'utf8');
  } catch { /* ignore */ }
}

async function wasSent(topic) {
  // Check local file first (works on persistent servers)
  try {
    const local = JSON.parse(await fs.readFile(CATCHUP_FILE, 'utf8'));
    if (local[new Date().toISOString().slice(0, 10)]?.includes(topic)) return true;
  } catch { /* ignore */ }

  // Check Discord channel history (works on GitHub Actions / ephemeral VMs)
  try {
    const webhookMatch = TECH_WEBHOOK.match(/webhooks\/(\d+)\//);
    if (webhookMatch) {
      const channelId = webhookMatch[1];
      const histRes = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages?limit=20`, {
        headers: { 'Authorization': `Bot ${process.env.DISCORD_BOT_TOKEN}` },
      });
      if (histRes.ok) {
        const messages = await histRes.json();
        const today = new Date().toISOString().slice(0, 10);
        for (const msg of messages) {
          if (msg.embeds?.[0]?.title?.includes(topic) && msg.timestamp?.startsWith(today)) {
            return true;
          }
        }
      }
    }
  } catch { /* ignore */ }

  return false;
}

async function markSent(topic) {
  try {
    let d = {}; try { d = JSON.parse(await fs.readFile(CATCHUP_FILE, 'utf8')); } catch {}
    const t = new Date().toISOString().slice(0, 10);
    if (!d[t]) d[t] = [];
    d[t].push(topic);
    await fs.writeFile(CATCHUP_FILE, JSON.stringify(d, null, 2), 'utf8');
  } catch { /* ignore */ }
}

function pickTopic() {
  const history = loadHistorySync();
  const avail = TECH_TOPICS.filter(t => !history.includes(t));
  const pool = avail.length ? avail : TECH_TOPICS;
  return pool[Math.floor(Math.random() * pool.length)];
}

async function fetchHN(query, limit = 10) {
  try {
    const r = await fetch(`https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=${limit}`);
    if (!r.ok) return [];
    const d = await r.json();
    return (d.hits || []).map(h => ({ title: h.title || 'Untitled', url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`, pts: h.points || 0 }));
  } catch { return []; }
}

async function fetchReddit(query, limit = 10) {
  try {
    const r = await fetch(`https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&sort=relevance&t=week&limit=${limit}`, { headers: { 'User-Agent': 'Serena-Brain/1.0' } });
    if (!r.ok) return [];
    const d = await r.json();
    return (d.data?.children || []).filter(c => c.data && !c.data.stickied).map(c => ({ title: c.data.title || 'Untitled', url: `https://reddit.com${c.data.permalink || ''}`, pts: c.data.score || 0 }));
  } catch { return []; }
}

async function fetchGitHub(query, limit = 10) {
  try {
    const r = await fetch(`https://api.github.com/search/repositories?q=${encodeURIComponent(query)}+created:>2024-01-01&sort=stars&order=desc&per_page=${limit}`);
    if (!r.ok) return [];
    const d = await r.json();
    return (d.items || []).slice(0, limit).map(r => ({ title: r.full_name || 'Untitled', url: r.html_url || '', pts: r.stargazers_count || 0 }));
  } catch { return []; }
}

async function fetchArXiv(query, limit = 5) {
  try {
    const r = await fetch(`http://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&start=0&max_results=${limit}`);
    if (!r.ok) return [];
    const xml = await r.text();
    return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(m => ({
      title: m[1].match(/<title>([\s\S]*?)<\/title>/)?.[1]?.trim().replace(/\s+/g, ' ') || 'Untitled',
      url: m[1].match(/<id>([^<]+)<\/id>/)?.[1] || '',
      pts: 0,
    }));
  } catch { return []; }
}

async function main() {
  const topic = process.argv[2] || pickTopic();

  if (await wasSent(topic)) {
    console.log(`[TechNews] Already sent "${topic}" today — skip`);
    return;
  }

  await saveHistory(topic);
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

  // ── Dedup + Fallback via direct SQLite query ──
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync('./vectors.db');

    // Get existing URLs for this topic
    const rows = db.prepare("SELECT url FROM vectors WHERE chunk_text LIKE ? LIMIT 100").all(`%${topic}%`);
    const existingUrls = new Set(rows.map(r => r.url).filter(Boolean));

    if (existingUrls.size > 0) {
      const before = all.length;
      all = all.filter(n => !existingUrls.has(n.url));
      if (all.length < before) {
        console.log(`[TechNews] Dedup: ${before} → ${all.length} (removed ${before - all.length} duplicates)`);
      }
    }

    // Fallback: if nothing new, get oldest from DB
    if (!all.length) {
      console.log('[TechNews] No new sources — fetching from DB cache...');
      const cached = db.prepare("SELECT DISTINCT doc_id, url, project FROM vectors WHERE chunk_text LIKE ? ORDER BY added_at ASC LIMIT 10").all(`%${topic}%`);
      if (cached.length > 0) {
        all = cached.map(c => ({
          title: c.project || c.doc_id || 'Cached',
          url: c.url || '',
          src: 'cached',
          score: 0.5,
          pts: 0,
        }));
        console.log(`[TechNews] Fallback: ${all.length} cached sources from DB`);
      }
    }

    db.close();
  } catch (dbErr) {
    console.debug('[TechNews] DB dedup/fallback skipped:', dbErr.message);
  }

  if (!all.length) { console.log('[TechNews] No results at all'); return; }
  all.sort((a, b) => b.score - a.score);

  const lines = all.slice(0, 15).map((n, i) => {
    const bar = '█'.repeat(Math.round(n.score * 10)) + '░'.repeat(10 - Math.round(n.score * 10));
    return `**${i + 1}.** [${n.src}] [${n.title.slice(0, 60)}](${n.url})\n   📊 ${n.score.toFixed(2)} ${bar}`;
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
    if (res.ok) { console.log(`[TechNews] ✅ Sent ${all.length} items`); await markSent(topic); }
    else console.error('[TechNews] ❌ Failed:', res.status);
  } catch (err) { console.error('[TechNews] ❌ Error:', err.message); }
}

main().catch(e => { console.error('[TechNews] Fatal:', e.message); process.exit(1); });
