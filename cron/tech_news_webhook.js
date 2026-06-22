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

async function pickRandomTopic() {
  const history = await loadTopicHistory();
  const available = TECH_TOPICS.filter(t => !history.includes(t));
  // Nếu chạy hết → reset và random lại
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

async function fetchHackerNews(query, limit = 10) {
  try {
    // Search theo topic thay vì fetch top stories chung
    const res = await fetch(`https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=${limit}`);
    if (!res.ok) throw new Error(`HN API ${res.status}`);
    const data = await res.json();
    return (data.hits || []).map(hit => ({
      title: hit.title || 'Untitled',
      url: hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}`,
      score: (hit.points || 0) / 100,
      type: 'hackernews',
      category: 'Tech News',
    }));
  } catch (err) {
    console.warn('[TechNews] HackerNews failed:', err.message);
    return [];
  }
}

async function fetchReddit(query, limit = 10) {
  try {
    // Search theo topic thay vì fetch hot chung
    const res = await fetch(`https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&sort=relevance&t=week&limit=${limit}`, {
      headers: { 'User-Agent': 'Serena-Brain/1.0' },
    });
    if (!res.ok) throw new Error(`Reddit API ${res.status}`);
    const data = await res.json();
    return (data.data?.children || [])
      .filter(c => c.data && !c.data.stickied)
      .map(c => ({
        title: c.data.title || 'Untitled',
        url: `https://reddit.com${c.data.permalink || ''}`,
        score: (c.data.score || 0) / 100,
        type: 'reddit',
        category: 'Tech News',
      }));
  } catch (err) {
    console.warn('[TechNews] Reddit failed:', err.message);
    return [];
  }
}

async function fetchGitHubTrending(limit = 10) {
  try {
    const res = await fetch(`https://api.github.com/search/repositories?q=created:>2024-01-01&sort=stars&order=desc&per_page=${limit}`);
    if (!res.ok) throw new Error(`GitHub API ${res.status}`);
    const data = await res.json();
    return (data.items || []).slice(0, limit).map(r => ({
      title: r.full_name || 'Untitled',
      url: r.html_url || '',
      score: (r.stargazers_count || 0) / 1000,
      type: 'github',
      category: 'Tech News',
    }));
  } catch (err) {
    console.warn('[TechNews] GitHub failed:', err.message);
    return [];
  }
}

async function main() {
  // Pick random topic from pool (no duplicate today)
  const topic = process.argv[2] || await pickRandomTopic();
  await saveTopicHistory(topic);
  console.log(`[TechNews] Fetching tech news for topic: "${topic}"`);

  // Search theo topic thay vì fetch trending chung
  const [hn, reddit, github] = await Promise.all([
    fetchHackerNews(topic, 10),
    fetchReddit(topic, 10),
    fetchGitHubTrending(topic, 10),
  ]);

  const allNews = [...hn, ...reddit, ...github];

  if (allNews.length === 0) {
    console.log('[TechNews] No news fetched.');
    return;
  }

  allNews.sort((a, b) => b.score - a.score);

  console.log(`[TechNews] Fetched ${allNews.length} news items for "${topic}"`);
  
  // Group by topic/category for better readability
  const topicGroups = {};
  for (const n of allNews) {
    const topic = n.category || 'General';
    if (!topicGroups[topic]) topicGroups[topic] = [];
    topicGroups[topic].push(n);
  }

  // Build sources lines with scores
  const sourcesLines = allNews.slice(0, 15).map((n, i) => {
    const tag = n.type === 'hackernews' ? '[HN]' : n.type === 'reddit' ? '[Reddit]' : '[GitHub]';
    const scoreBar = '█'.repeat(Math.min(10, Math.max(0, Math.round(n.score * 10)))) + '░'.repeat(10 - Math.min(10, Math.max(0, Math.round(n.score * 10))));
    return `**${i + 1}.** ${tag} [${n.title.slice(0, 60)}](${n.url})\n   📊 Score: **${n.score.toFixed(2)}** ${scoreBar}`;
  });

  const typeCounts = {};
  for (const n of allNews) typeCounts[n.type] = (typeCounts[n.type] || 0) + 1;
  const summary = Object.entries(typeCounts).map(([t, c]) => `${t}: ${c}`).join(' | ');
  const topScore = allNews.length > 0 ? allNews[0].score.toFixed(3) : '0';
  const avgScore = allNews.length > 0 ? (allNews.reduce((s, n) => s + n.score, 0) / allNews.length).toFixed(3) : '0';

  const embed = {
    title: `📰 Tech News: "${topic}" — ${new Date().toLocaleDateString('vi-VN')}`,
    description: [
      `🔍 **Topic:** ${topic}`,
      `🏆 **Top Score:** ${topScore} | 📊 **Avg Score:** ${avgScore}`,
      `📦 **Total Sources:** ${allNews.length} | 📊 **By Type:** ${summary}`,
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
