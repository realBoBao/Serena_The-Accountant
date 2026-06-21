#!/usr/bin/env node
/**
 * scripts/tech_news_webhook.js — Fetch tech news và gửi qua TECH_WEBHOOK_URL
 *
 * Nguồn: HackerNews, Reddit r/programming, GitHub trending
 * Usage: node scripts/tech_news_webhook.js
 * Cron: 8AM PDT daily (via GitHub Actions)
 */

import 'dotenv/config';

const TECH_WEBHOOK = process.env.TECH_WEBHOOK_URL || process.env.DISCORD_WEBHOOK;

if (!TECH_WEBHOOK) {
  console.error('❌ TECH_WEBHOOK_URL not set in .env');
  process.exit(1);
}

async function fetchHackerNews(limit = 10) {
  try {
    const res = await fetch('https://hacker-news.firebaseio.com/v0/topstories.json');
    if (!res.ok) throw new Error(`HN API ${res.status}`);
    const ids = await res.json();
    const top = ids.slice(0, limit);
    const stories = await Promise.allSettled(
      top.map(id => fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`).then(r => r.json()))
    );
    return stories
      .filter(s => s.status === 'fulfilled' && s.value)
      .map(s => ({
        title: s.value.title || 'Untitled',
        url: s.value.url || `https://news.ycombinator.com/item?id=${s.value.id}`,
        score: (s.value.score || 0) / 100,
        type: 'hackernews',
        category: 'Tech News',
      }));
  } catch (err) {
    console.warn('[TechNews] HackerNews failed:', err.message);
    return [];
  }
}

async function fetchReddit(subreddit = 'programming', limit = 10) {
  try {
    const res = await fetch(`https://www.reddit.com/r/${subreddit}/hot.json?limit=${limit}`, {
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
  console.log('[TechNews] Fetching tech news...');
  
  const [hn, reddit, github] = await Promise.all([
    fetchHackerNews(10),
    fetchReddit('programming', 10),
    fetchGitHubTrending(10),
  ]);
  
  const allNews = [...hn, ...reddit, ...github];
  
  if (allNews.length === 0) {
    console.log('[TechNews] No news fetched.');
    return;
  }
  
  allNews.sort((a, b) => b.score - a.score);
  
  console.log(`[TechNews] Fetched ${allNews.length} news items`);
  
  const sourcesLines = allNews.slice(0, 15).map((n, i) => {
    const tag = n.type === 'hackernews' ? '[HN]' : n.type === 'reddit' ? '[Reddit]' : '[GitHub]';
    return `**${i + 1}.** ${tag} [${n.title.slice(0, 70)}](${n.url})`;
  });
  
  const typeCounts = {};
  for (const n of allNews) typeCounts[n.type] = (typeCounts[n.type] || 0) + 1;
  const summary = Object.entries(typeCounts).map(([t, c]) => `${t}: ${c}`).join(' | ');
  
  const embed = {
    title: `📰 Tech News — ${new Date().toLocaleDateString('vi-VN')}`,
    description: `📊 **Sources:** ${summary}\n\n${sourcesLines.join('\n')}`,
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
