#!/usr/bin/env node
/**
 * cron/tech_news_webhook.js — Fetch tech news theo topic random và gửi qua TECH_WEBHOOK_URL
 *
 * Nguồn: HackerNews, Reddit r/programming, GitHub trending
 * Usage: node cron/tech_news_webhook.js [topic]
 * Cron: 11AM + 5PM PDT daily (via GitHub Actions)
 *
 * Topic pool — random 4 lần/ngày không trùng:
 * - Nếu có topic argument → dùng topic đó
 * - Nếu không → random từ TECH_TOPICS pool, không trùng với .topic_history.json
 */

import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';

const TECH_WEBHOOK = process.env.TECH_WEBHOOK_URL || process.env.DISCORD_WEBHOOK;

// ── Tech topic pool — random không trùng ──
const TECH_TOPICS = [
  'artificial intelligence',
  'machine learning',
  'distributed systems',
  'cloud computing',
  'cybersecurity',
  'blockchain',
  'web development',
  'mobile development',
  'devops',
  'data engineering',
  'microservices',
  'kubernetes',
  'rust programming',
  'golang',
  'typescript',
  'python',
  'react',
  'vue.js',
  'node.js',
  'database optimization',
  'API design',
  'system design',
  'networking',
  'linux kernel',
  'open source',
  'startup tech',
  'quantum computing',
  'edge computing',
  'IoT',
  'AR VR',
  'chatbot development',
];

const TOPIC_HISTORY_FILE = path.resolve('./.topic_history.json');

async function loadTopicHistory() {
  try {
    const data = await fs.readFile(TOPIC_HISTORY_FILE, 'utf8');
    const history = JSON.parse(data);
    const today = new Date().toISOString().slice(0, 10);
    return history[today] || [];
  } catch { return []; }
}

async function saveTopicHistory(topic) {
  try {
    let history = {};
    try { history = JSON.parse(await fs.readFile(TOPIC_HISTORY_FILE, 'utf8')); } catch {}
    const today = new Date().toISOString().slice(0, 10);
    if (!history[today]) history[today] = [];
    history[today].push({ topic, ts: new Date().toISOString() });
    await fs.writeFile(TOPIC_HISTORY_FILE, JSON.stringify(history, null, 2), 'utf8');
  } catch { /* ignore */ }
}

async function pickSmartTopic() {
  // ── 1. Thử dùng Markov Engine để predict topic user quan tâm ──
  try {
    const { getPredictedTopic, initializeMarkovFiles } = await import('../lib/markov_engine.js');
    await initializeMarkovFiles();
    const predicted = await getPredictedTopic();
    if (predicted && TECH_TOPICS.includes(predicted)) {
      console.log(`[TechNews] Markov predicted topic: "${predicted}"`);
      return predicted;
    }
  } catch (err) {
    console.debug('[TechNews] Markov prediction failed, using random fallback:', err.message);
  }

  // ── 2. Fallback: random từ pool, không trùng trong ngày ──
  const history = await loadTopicHistory();
  const available = TECH_TOPICS.filter(t => !history.includes(t));
  if (available.length === 0) {
    const today = new Date().toISOString().slice(0, 10);
    await fs.writeFile(TOPIC_HISTORY_FILE, JSON.stringify({ [today]: [] }, null, 2), 'utf8');
    return TECH_TOPICS[Math.floor(Math.random() * TECH_TOPICS.length)];
  }
  return available[Math.floor(Math.random() * available.length)];
}

if (!TECH_WEBHOOK) {
  console.error('❌ TECH_WEBHOOK_URL not set in .env');
  process.exit(1);
}

// ── Source Router handles all fetching with multi-backend fallback ──

// ── Catch-up tracking file ──
const CATCHUP_FILE = path.resolve('./.tech_news_catchup.json');

async function wasSentToday(topic) {
  try {
    const data = JSON.parse(await fs.readFile(CATCHUP_FILE, 'utf8'));
    const today = new Date().toISOString().slice(0, 10);
    return data[today]?.includes(topic);
  } catch { return false; }
}

async function markSent(topic) {
  try {
    let data = {};
    try { data = JSON.parse(await fs.readFile(CATCHUP_FILE, 'utf8')); } catch {}
    const today = new Date().toISOString().slice(0, 10);
    if (!data[today]) data[today] = [];
    data[today].push(topic);
    await fs.writeFile(CATCHUP_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch { /* ignore */ }
}

async function main() {
  // Pick smart topic (Markov prediction → random fallback)
  const topic = process.argv[2] || await pickSmartTopic();

  // ── Catch-up: Skip if already sent today ──
  if (await wasSentToday(topic)) {
    console.log(`[TechNews] Already sent "${topic}" today — skipping (catch-up)`);
    return;
  }

  await saveTopicHistory(topic);

  // Record interaction cho Markov Engine
  try {
    const { recordInteraction } = await import('../lib/markov_engine.js');
    await recordInteraction(topic);
  } catch { /* non-critical */ }

  console.log(`[TechNews] Fetching tech news for topic: "${topic}"`);

  // ── Multi-source search với Source Router (multi-backend fallback) ──
  const { searchWithFallback } = await import('../lib/source_router.js');
  const [hn, reddit, github, arxiv] = await Promise.all([
    searchWithFallback('hackernews', topic),
    searchWithFallback('reddit', topic),
    searchWithFallback('github', topic),
    searchWithFallback('arxiv', topic),
  ]);

  // Normalize results to common format with proper scoring
  const allNews = [
    ...hn.map(n => ({ ...n, type: 'hackernews', score: Math.min(1.0, (n.score || 0) / 500) })), // HN: 500+ points = max
    ...reddit.map(n => ({ ...n, type: 'reddit', score: Math.min(1.0, (n.score || 0) / 200) })), // Reddit: 200+ = max
    ...github.map(n => ({ ...n, type: 'github', score: Math.min(1.0, (n.score || 0) / 1000) })), // GitHub: 1000+ stars = max
    ...arxiv.map(n => ({ ...n, type: 'arxiv', score: 0.75 })), // arXiv: fixed high quality
  ];

  if (allNews.length === 0) {
    console.log('[TechNews] No news fetched.');
    return;
  }

  allNews.sort((a, b) => b.score - a.score);

  // ── Fallback: Nếu không có news mới → lấy từ DB theo topic ──
  if (allNews.length === 0) {
    console.log('[TechNews] No new sources — fetching from DB cache...');
    try {
      const { search: vectorSearch } = await import('../lib/vector_store.js');
      const { embedText } = await import('../lib/embeddings.js');
      const emb = await embedText(topic);
      const cached = await vectorSearch(emb, 10, 'academic');
      if (cached.length > 0) {
        const cachedNews = cached.map(c => ({
          title: c.project || c.doc_id || 'Cached Source',
          url: c.url || '',
          type: 'cached',
          score: 0.5,
          source: 'cache',
        }));
        allNews.push(...cachedNews);
        console.log(`[TechNews] Fallback: ${cachedNews.length} cached sources from DB`);
      }
    } catch (cacheErr) {
      console.warn('[TechNews] DB cache fallback failed:', cacheErr.message);
    }
  }

  // ── F1 Quality Gate ──
  let qualityNews = allNews;
  try {
    const { computeF1 } = await import('../lib/f1_evaluator.js');
    qualityNews = allNews.filter(n => {
      const f1 = computeF1(n.title, topic);
      return f1.f1 >= 0.05;
    });
    if (qualityNews.length < allNews.length) {
      console.log(`[TechNews] F1 filter: ${allNews.length} → ${qualityNews.length}`);
    }
  } catch { /* F1 optional */ }

  console.log(`[TechNews] Fetched ${qualityNews.length} quality news items for "${topic}"`);

  // Build sources lines with scores
  const sourcesLines = qualityNews.slice(0, 15).map((n, i) => {
    const tag = n.type === 'hackernews' ? '[HN]' : n.type === 'reddit' ? '[Reddit]' : n.type === 'arxiv' ? '[arXiv]' : '[GitHub]';
    const scoreBar = '█'.repeat(Math.min(10, Math.max(0, Math.round(n.score * 10)))) + '░'.repeat(10 - Math.min(10, Math.max(0, Math.round(n.score * 10))));
    return `**${i + 1}.** ${tag} [${n.title.slice(0, 60)}](${n.url})\n   📊 Score: **${n.score.toFixed(2)}** ${scoreBar}`;
  });

  const typeCounts = {};
  for (const n of qualityNews) typeCounts[n.type] = (typeCounts[n.type] || 0) + 1;
  const summary = Object.entries(typeCounts).map(([t, c]) => `${t}: ${c}`).join(' | ');
  const topScore = qualityNews.length > 0 ? qualityNews[0].score.toFixed(3) : '0';
  const avgScore = qualityNews.length > 0 ? (qualityNews.reduce((s, n) => s + n.score, 0) / qualityNews.length).toFixed(3) : '0';

  const embed = {
    title: `📰 Tech News: "${topic}" — ${new Date().toLocaleDateString('vi-VN')}`,
    description: [
      `🔍 **Topic:** ${topic}`,
      `🏆 **Top Score:** ${topScore} | 📊 **Avg Score:** ${avgScore}`,
      `📦 **Total Sources:** ${qualityNews.length} | 📊 **By Type:** ${summary}`,
      ``,
      ...sourcesLines,
    ].join('\n').slice(0, 4000),
    color: 0x00aa55,
    timestamp: new Date().toISOString(),
  };
  
  try {
    const res = await fetch(TECH_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [embed] }),
    });
    
    if (res.ok) {
      console.log('[TechNews] ✅ Webhook sent successfully');
      await markSent(topic); // Mark as sent for catch-up
    } else {
      console.error('[TechNews] ❌ Webhook failed:', res.status, await res.text());
    }
  } catch (err) {
    console.error('[TechNews] ❌ Webhook error:', err.message);
  }
}

main().catch(err => {
  console.error('[TechNews] Fatal:', err.message);
  process.exit(1);
});
