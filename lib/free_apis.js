/**
 * lib/free_apis.js — Free APIs for Job, Tech, and Algo news
 * No auth required, JSON responses
 * 
 * Usage:
 *   import { fetchArbeitnow, fetchAITechJobs, fetchDevTo, fetchHNTop, fetchCodeforces } from './lib/free_apis.js';
 */

const sleep = (ms) => new Promise(res => setTimeout(res, ms));

// ═══════════════════════════════════════════════════════════════
// JOB APIS
// ═══════════════════════════════════════════════════════════════

/**
 * Arbeitnow — Remote jobs in Europe (Free, No auth)
 * https://arbeitnow.com/api/job-board-api
 */
export async function fetchArbeitnow(limit = 10) {
  try {
    const res = await fetch('https://arbeitnow.com/api/job-board-api');
    if (!res.ok) return [];
    const data = await res.json();
    return (data.data || []).slice(0, limit).map(j => ({
      id: j.id || `arbe-${Buffer.from(j.url || j.title).toString('base64').slice(0, 8)}`,
      title: j.title || 'Unknown',
      company: j.company_name || 'Unknown',
      url: j.url || '#',
      location: j.location || (j.remote ? 'Remote' : 'Unknown'),
      source: 'Arbeitnow',
      tags: Array.isArray(j.tags) ? j.tags.map(t => t.toLowerCase()) : String(j.tags || '').split(',').map(t => t.trim()).filter(Boolean),
      posted_date: j.published_at || new Date().toISOString(),
    }));
  } catch (err) {
    console.warn('[Arbeitnow] Fetch failed:', err.message);
    return [];
  }
}

/**
 * AI Dev Jobs — AI/ML engineering jobs (Free, No auth)
 * https://aidevboard.com/openapi.yaml
 */
export async function fetchAIDevJobs(limit = 10) {
  try {
    const res = await fetch('https://api.aidevboard.com/v1/jobs');
    if (!res.ok) return [];
    const data = await res.json();
    const jobs = Array.isArray(data) ? data : (data.jobs || data.data || []);
    return jobs.slice(0, limit).map(j => ({
      id: j.id || `ai-${Buffer.from(j.url || j.title).toString('base64').slice(0, 8)}`,
      title: j.title || 'Unknown',
      company: j.company || 'Unknown',
      url: j.url || '#',
      location: j.location || 'Remote',
      source: 'AIDevJobs',
      tags: Array.isArray(j.tags) ? j.tags.map(t => t.toLowerCase()) : String(j.tags || '').split(',').map(t => t.trim()).filter(Boolean),
      posted_date: j.date || j.posted_at || new Date().toISOString(),
    }));
  } catch (err) {
    console.warn('[AIDevJobs] Fetch failed:', err.message);
    return [];
  }
}

/**
 * GraphQL Jobs — GraphQL-based job search (Free, No auth)
 * https://graphql.jobs/docs/api/
 */
export async function fetchGraphQLJobs(query = 'backend', limit = 10) {
  try {
    const graphqlQuery = `{
      jobs(query: "${query}", limit: ${limit}) {
        id
        title
        company { name }
        location { city country }
        url
        tags
        postedAt
      }
    }`;
    const res = await fetch('https://api.graphql.jobs/v1/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: graphqlQuery }),
    });
    if (!res.ok) return [];
    const data = await res.json();
    const jobs = data?.data?.jobs || [];
    return jobs.map(j => ({
      id: j.id || `gql-${Buffer.from(j.url || j.title).toString('base64').slice(0, 8)}`,
      title: j.title || 'Unknown',
      company: j.company?.name || 'Unknown',
      url: j.url || '#',
      location: j.location ? `${j.location.city || ''}, ${j.location.country || ''}`.trim() : 'Remote',
      source: 'GraphQLJobs',
      tags: Array.isArray(j.tags) ? j.tags.map(t => t.toLowerCase()) : String(j.tags || '').split(',').map(t => t.trim()).filter(Boolean),
      posted_date: j.postedAt || new Date().toISOString(),
    }));
  } catch (err) {
    console.warn('[GraphQLJobs] Fetch failed:', err.message);
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════
// TECH NEWS APIS
// ═══════════════════════════════════════════════════════════════

/**
 * Dev.to — Developer articles (Free, No auth)
 * https://dev.to/api/articles?top=1&per_page=5
 */
export async function fetchDevTo(limit = 10) {
  try {
    const res = await fetch(`https://dev.to/api/articles?per_page=${limit}`);
    if (!res.ok) return [];
    const data = await res.json();
    return data.slice(0, limit).map(a => ({
      id: a.id || `devto-${Buffer.from(a.url || a.title).toString('base64').slice(0, 8)}`,
      title: a.title || 'Unknown',
      description: (a.description || '').slice(0, 200),
      url: a.url || '#',
      source: 'Dev.to',
      tags: Array.isArray(a.tags) ? a.tags.map(t => t.toLowerCase()) : String(a.tags || '').split(',').map(t => t.trim()).filter(Boolean),
      posted_date: a.published_at || new Date().toISOString(),
      score: a.positive_reactions_count || 0,
    }));
  } catch (err) {
    console.warn('[Dev.to] Fetch failed:', err.message);
    return [];
  }
}

/**
 * HackerNews Top Stories (Free, No auth)
 * https://hacker-news.firebaseio.com/v0/topstories.json
 */
export async function fetchHNTopStories(limit = 10) {
  try {
    const res = await fetch('https://hacker-news.firebaseio.com/v0/topstories.json');
    if (!res.ok) return [];
    const ids = await res.json();
    const stories = [];
    for (const id of ids.slice(0, limit)) {
      try {
        const r = await fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`);
        const data = await r.json();
        if (data) stories.push(data);
      } catch { /* skip */ }
      await sleep(100);
    }
    return stories.map(s => ({
      id: s.id || `hn-${Buffer.from(s.url || s.title || String(s.id)).toString('base64').slice(0, 8)}`,
      title: s.title || 'Unknown',
      description: (s.text || '').replace(/<[^>]+>/g, '').slice(0, 200),
      url: s.url || `https://news.ycombinator.com/item?id=${s.id}`,
      source: 'HackerNews',
      tags: [],
      posted_date: new Date(s.time * 1000).toISOString(),
      score: s.score || 0,
    }));
  } catch (err) {
    console.warn('[HNTop] Fetch failed:', err.message);
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════
// ALGO NEWS APIS
// ═══════════════════════════════════════════════════════════════

/**
 * Codeforces — Recent contests and problems (Free, No auth)
 * https://codeforces.com/api/contest.list
 */
export async function fetchCodeforces(limit = 5) {
  try {
    const res = await fetch('https://codeforces.com/api/contest.list?gym=false');
    if (!res.ok) return [];
    const data = await res.json();
    const contests = (data.result || [])
      .filter(c => c.phase === 'FINISHED' || c.phase === 'BEFORE')
      .slice(0, limit);
    return contests.map(c => ({
      id: c.id || `cf-${c.name?.slice(0, 20)}`,
      title: c.name || 'Unknown Contest',
      description: `${c.type} contest, ${c.durationSeconds ? Math.round(c.durationSeconds / 60) : '?'} minutes`,
      url: `https://codeforces.com/contest/${c.id}`,
      source: 'Codeforces',
      tags: ['competitive-programming', 'contest'],
      posted_date: new Date(c.startTimeSeconds * 1000).toISOString(),
    }));
  } catch (err) {
    console.warn('[Codeforces] Fetch failed:', err.message);
    return [];
  }
}

/**
 * Hackerearth — Challenges and contests (Free, No auth)
 * https://www.hackerearth.com/api/events/
 */
export async function fetchHackerearth(limit = 5) {
  try {
    const res = await fetch('https://www.hackerearth.com/api/events/?limit=' + limit, {
      headers: { 'Accept': 'application/json' },
    });
    if (!res.ok) return [];
    const data = await res.json();
    const events = Array.isArray(data) ? data : (data.events || data.data || []);
    return events.slice(0, limit).map(e => ({
      id: e.id || `he-${(e.title || e.name || '').slice(0, 20)}`,
      title: e.title || e.name || 'Unknown Challenge',
      description: (e.description || '').slice(0, 200),
      url: e.url || e.challenge_url || '#',
      source: 'Hackerearth',
      tags: ['competitive-programming', 'challenge'],
      posted_date: e.start_time || e.created_at || new Date().toISOString(),
    }));
  } catch (err) {
    console.warn('[Hackerearth] Fetch failed:', err.message);
    return [];
  }
}

/**
 * KONTESTS — Upcoming competitive programming contests (Free, No auth)
 * https://kontests.net/api/v1/all
 */
export async function fetchKontests(limit = 5) {
  try {
    const res = await fetch('https://kontests.net/api/v1/all');
    if (!res.ok) return [];
    const data = await res.json();
    const now = Date.now();
    const upcoming = data
      .filter(c => new Date(c.start_time).getTime() > now - 86400000)
      .sort((a, b) => new Date(a.start_time) - new Date(b.start_time))
      .slice(0, limit);
    return upcoming.map(c => ({
      id: c.id || `kt-${(c.name || '').slice(0, 20)}`,
      title: c.name || 'Unknown Contest',
      description: `${c.site} contest, ${c.duration || '?'} duration`,
      url: c.url || '#',
      source: 'KONTESTS',
      site: c.site || 'Unknown',
      tags: ['competitive-programming', 'contest'],
      posted_date: c.start_time || new Date().toISOString(),
    }));
  } catch (err) {
    console.warn('[KONTESTS] Fetch failed:', err.message);
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════
// AGGREGATORS
// ═══════════════════════════════════════════════════════════════

/**
 * Fetch all free job sources
 */
export async function fetchAllFreeJobs(limitPerSource = 5) {
  const [arbe, ai, gql] = await Promise.allSettled([
    fetchArbeitnow(limitPerSource),
    fetchAIDevJobs(limitPerSource),
    fetchGraphQLJobs('backend', limitPerSource),
  ]);
  return [
    ...(arbe.status === 'fulfilled' ? arbe.value : []),
    ...(ai.status === 'fulfilled' ? ai.value : []),
    ...(gql.status === 'fulfilled' ? gql.value : []),
  ];
}

/**
 * Fetch all free tech news sources
 */
export async function fetchAllTechNews(limitPerSource = 5) {
  const [devto, hn] = await Promise.allSettled([
    fetchDevTo(limitPerSource),
    fetchHNTopStories(limitPerSource),
  ]);
  return [
    ...(devto.status === 'fulfilled' ? devto.value : []),
    ...(hn.status === 'fulfilled' ? hn.value : []),
  ];
}

/**
 * Fetch all free algo news sources
 */
export async function fetchAllAlgoNews(limitPerSource = 3) {
  const [cf, he, kt] = await Promise.allSettled([
    fetchCodeforces(limitPerSource),
    fetchHackerearth(limitPerSource),
    fetchKontests(limitPerSource),
  ]);
  return [
    ...(cf.status === 'fulfilled' ? cf.value : []),
    ...(he.status === 'fulfilled' ? he.value : []),
    ...(kt.status === 'fulfilled' ? kt.value : []),
  ];
}

export default {
  fetchArbeitnow, fetchAIDevJobs, fetchGraphQLJobs,
  fetchDevTo, fetchHNTopStories,
  fetchCodeforces, fetchHackerearth, fetchKontests,
  fetchAllFreeJobs, fetchAllTechNews, fetchAllAlgoNews,
};
