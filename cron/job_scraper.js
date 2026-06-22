#!/usr/bin/env node
/**
 * cron/job_scraper.js — Scrape job postings và gửi qua JOB_WEBHOOK_URL
 *
 * Nguồn: SimplifyJobs (GitHub), RemoteOK, WeWorkRemotely
 * Usage: node cron/job_scraper.js
 * Cron: 6AM + 12PM + 6PM PDT daily (via GitHub Actions)
 */

import 'dotenv/config';

const JOB_WEBHOOK = process.env.JOB_WEBHOOK_URL || process.env.DISCORD_WEBHOOK;

if (!JOB_WEBHOOK) {
  console.error('❌ JOB_WEBHOOK_URL not set in .env');
  process.exit(1);
}

// ── Job sources ──
async function fetchSimplifyJobs(limit = 10) {
  try {
    // SimplifyJobs GitHub repo — job postings
    const res = await fetch('https://raw.githubusercontent.com/SimplifyJobs/Summer2025-Internships/dev/README.md');
    if (!res.ok) throw new Error(`SimplifyJobs ${res.status}`);
    const text = await res.text();
    // Parse markdown table
    const lines = text.split('\n').filter(l => l.startsWith('|') && !l.includes('---') && !l.includes('Company'));
    return lines.slice(0, limit).map(l => {
      const cols = l.split('|').map(c => c.trim()).filter(Boolean);
      return {
        company: cols[0] || 'Unknown',
        role: cols[1] || 'Unknown',
        location: cols[2] || 'Remote',
        link: cols[3] || '#',
        source: 'SimplifyJobs',
      };
    }).filter(j => j.company !== 'Unknown');
  } catch (err) {
    console.warn('[JobScraper] SimplifyJobs failed:', err.message);
    return [];
  }
}

async function fetchRemoteOK(limit = 10) {
  try {
    const res = await fetch('https://remoteok.com/api?tag=dev', {
      headers: { 'User-Agent': 'Serena-Brain/1.0' },
    });
    if (!res.ok) throw new Error(`RemoteOK ${res.status}`);
    const data = await res.json();
    return (data || []).slice(1, limit + 1).map(j => ({
      company: j.company || 'Unknown',
      role: j.position || 'Unknown',
      location: j.location || 'Remote',
      link: j.url || j.apply_url || '#',
      source: 'RemoteOK',
    }));
  } catch (err) {
    console.warn('[JobScraper] RemoteOK failed:', err.message);
    return [];
  }
}

async function fetchWeWorkRemotely(limit = 10) {
  try {
    const res = await fetch('https://weworkremotely.com/remote-jobs.rss', {
      headers: { 'User-Agent': 'Serena-Brain/1.0' },
    });
    if (!res.ok) throw new Error(`WeWorkRemotely ${res.status}`);
    const xml = await res.text();
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)];
    return items.slice(0, limit).map(m => {
      const item = m[1];
      const title = item.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.trim() || 'Unknown';
      const link = item.match(/<link>([\s\S]*?)<\/link>/)?.[1]?.trim() || '#';
      const desc = item.match(/<description>([\s\S]*?)<\/description>/)?.[1]?.replace(/<[^>]+>/g, '').slice(0, 100) || '';
      return {
        company: title.split('—')[0]?.split('-')[0]?.trim() || 'Unknown',
        role: title,
        location: 'Remote',
        link,
        source: 'WeWorkRemotely',
        description: desc,
      };
    });
  } catch (err) {
    console.warn('[JobScraper] WeWorkRemotely failed:', err.message);
    return [];
  }
}

async function main() {
  console.log('[JobScraper] Fetching job postings...');

  const [simplify, remoteok, wework] = await Promise.all([
    fetchSimplifyJobs(10),
    fetchRemoteOK(10),
    fetchWeWorkRemotely(10),
  ]);

  // ── Filter: Chỉ giữ jobs phù hợp với tech profile ──
  const REQUIRED_KEYWORDS = [
    'backend', 'software engineer', 'node.js', 'javascript', 'typescript',
    'devops', 'fullstack', 'full-stack', 'python', 'cloud', 'infrastructure',
    'swe', 'intern', 'developer', 'programming', 'api', 'database',
    'kubernetes', 'docker', 'microservices', 'distributed systems',
  ];
  const EXCLUDE_KEYWORDS = [
    'store manager', 'data entry', 'paralegal', 'sales agent',
    'no experience required', 'military', 'national guard',
    'manufacturing', 'real estate', 'insurance agent', 'retail',
    'appointment setter', 'document review', 'outside sales',
    'operations roles', 'membership offers', 'assistant store',
    'financial accountant', 'account manager', 'credit card',
    'business strategy', 'oracle services', 'workday',
    'cyber', 'project scheduling', 'project assistant',
    'data analyst', 'analytics and bi', 'data warehouse',
    'msp service delivery', 'director of operations',
  ];

  function isRelevant(title = '', company = '') {
    const text = (title + ' ' + company).toLowerCase();
    const hasRequired = REQUIRED_KEYWORDS.some(k => text.includes(k));
    const hasExcluded = EXCLUDE_KEYWORDS.some(k => text.includes(k));
    return hasRequired && !hasExcluded;
  }

  const rawJobs = [...simplify, ...remoteok, ...wework];
  const filteredJobs = rawJobs.filter(j => isRelevant(j.title, j.company));

  if (filteredJobs.length < rawJobs.length) {
    console.log(`[JobScraper] Filtered: ${rawJobs.length} → ${filteredJobs.length} (removed ${rawJobs.length - filteredJobs.length} irrelevant)`);
  }

  // ── Dedup: Loại bỏ jobs đã gửi (check Discord history bằng URL + title) ──
  let dedupedJobs = filteredJobs;
  try {
    const webhookMatch = JOB_WEBHOOK.match(/webhooks\/(\d+)\//);
    if (webhookMatch) {
      const channelId = webhookMatch[1];
      const histRes = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages?limit=50`, {
        headers: { 'Authorization': `Bot ${process.env.DISCORD_BOT_TOKEN}` },
      });
      if (histRes.ok) {
        const messages = await histRes.json();
        const sentUrls = new Set();
        const sentTitles = new Set();
        for (const msg of messages) {
          // Extract URLs from embed description
          if (msg.embeds?.[0]?.description) {
            const urlMatches = msg.embeds[0].description.match(/https?:\/\/[^\s\)]+/g);
            if (urlMatches) urlMatches.forEach(u => sentUrls.add(u));
          }
          // Extract job titles from embed description
          // Format: **1.** [Source] **Company — Role** — description [Apply](url)
          if (msg.embeds?.[0]?.description) {
            const lines = msg.embeds[0].description.split('\n');
            for (const line of lines) {
              // Match lines like: **1.** [Source] **Company — Role** — ...
              const m = line.match(/\*\*[^\]]+\.\*\*\s*\[[^\]]+\]\s*\*\*([^*]+)\*\*/);
              if (m) {
                sentTitles.add(m[1].trim().toLowerCase());
              }
            }
          }
        }
        dedupedJobs = filteredJobs.filter(j => {
          const urlMatch = sentUrls.has(j.link || '');
          const titleMatch = sentTitles.has((`${j.company} — ${j.role}`).trim().toLowerCase());
          return !urlMatch && !titleMatch;
        });
        if (dedupedJobs.length < filteredJobs.length) {
          console.log(`[JobScraper] Dedup: ${filteredJobs.length} → ${dedupedJobs.length} (removed already sent)`);
        }
      }
    }
  } catch (dedupErr) {
    console.debug('[JobScraper] Discord dedup skipped:', dedupErr.message);
  }

  if (dedupedJobs.length === 0) {
    console.log('[JobScraper] No new jobs after filter + dedup.');
    return;
  }

  console.log(`[JobScraper] Sending ${dedupedJobs.length} relevant jobs`);

  // Build Discord embed
  const jobsByType = {};
  for (const j of dedupedJobs) {
    if (!jobsByType[j.source]) jobsByType[j.source] = [];
    jobsByType[j.source].push(j);
  }

  const summary = Object.entries(jobsByType).map(([s, jobs]) => `${s}: ${jobs.length}`).join(' | ');

  const jobLines = dedupedJobs.slice(0, 15).map((j, i) => {
    const link = j.link && j.link !== '#' ? `[Apply](${j.link})` : '';
    return `**${i + 1}.** [${j.source}] **${j.company}** — ${j.role} (${j.location}) ${link}`;
  });

  // Use PDT date for consistency
  const pdtDate = new Date().toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' });
  const embed = {
    title: `💼 Job Alerts — ${pdtDate}`,
    description: [
      `📦 **Total Jobs:** ${dedupedJobs.length} | 📊 **By Source:** ${summary}`,
      ``,
      ...jobLines,
    ].join('\n').slice(0, 4000),
    color: 0x43b581,
    timestamp: new Date().toISOString(),
  };

  try {
    const res = await fetch(JOB_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [embed] }),
    });

    if (res.ok) {
      console.log('[JobScraper] ✅ Webhook sent successfully');
      // Save sent jobs to SQLite for dedup
      try {
        const { DatabaseSync } = await import('node:sqlite');
        const db = new DatabaseSync('./vectors.db');
        db.exec('CREATE TABLE IF NOT EXISTS sent_jobs (url TEXT PRIMARY KEY, sent_at TEXT)');
        const stmt = db.prepare("INSERT OR IGNORE INTO sent_jobs (url, sent_at) VALUES (?, datetime('now'))");
        for (const j of dedupedJobs) { stmt.run(j.link || j.title); }
        db.close();
        console.log(`[JobScraper] Saved ${dedupedJobs.length} job URLs to DB`);
      } catch (saveErr) { /* ignore */ }
    } else {
      console.error('[JobScraper] ❌ Webhook failed:', res.status, await res.text());
    }
  } catch (err) {
    console.error('[JobScraper] ❌ Webhook error:', err.message);
  }
}

main().catch(err => {
  console.error('[JobScraper] Fatal:', err.message);
  process.exit(0); // Exit 0 to avoid GitHub Actions failure
});
