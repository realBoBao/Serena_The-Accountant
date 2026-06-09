import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { isProcessed, markProcessed } from './lib/db.js';
import { addMemory, archiveOldMemories } from './lib/memory_manager.js';
import { sendDiscordNotification } from './notify_discord.js';
import { chunkText } from './lib/chunking.js';
import { embedText, embedTextsBatch } from './lib/embeddings.js';
import { upsertDocument } from './lib/vector_store.js';
import { fetchWithRetry } from './lib/fetch_retry.js';

const execp = promisify(exec);
const GITHUB_SEARCH_URL = 'https://api.github.com/search/repositories';
const YOUTUBE_SEARCH_URL = 'https://www.googleapis.com/youtube/v3/search';

const GITHUB_PER_PAGE = Number(process.env.GITHUB_PER_PAGE || 3);
const GITHUB_MIN_STARS = Number(process.env.GITHUB_MIN_STARS || 10);
const GITHUB_CREATED_AFTER = process.env.GITHUB_CREATED_AFTER || '2020-01-01';
const YOUTUBE_MAX_RESULTS = Number(process.env.YOUTUBE_MAX_RESULTS || 3);
const YOUTUBE_MIN_VIEWS = Number(process.env.YOUTUBE_MIN_VIEWS || 50000);
const YOUTUBE_ORDER = process.env.YOUTUBE_ORDER || 'viewCount';

// ── URL Parser — Nhận diện domain đích từ URL ──
function detectExternalSource(url) {
  if (!url) return '';
  const u = url.toLowerCase();
  if (u.includes('github.com')) return '[GitHub]';
  if (u.includes('youtube.com') || u.includes('youtu.be')) return '[YouTube]';
  if (u.includes('medium.com') || u.includes('dev.to') || u.includes('hashnode')) return '[Blog]';
  if (u.includes('arxiv.org')) return '[arXiv]';
  if (u.includes('stackoverflow.com')) return '[StackOverflow]';
  if (u.includes('docs.google.com') || u.includes('drive.google.com')) return '[GoogleDocs]';
  if (u.includes('notion.so') || u.includes('notion.site')) return '[Notion]';
  if (u.includes('figma.com')) return '[Figma]';
  if (u.includes('twitter.com') || u.includes('x.com')) return '[Twitter]';
  if (u.includes('linkedin.com')) return '[LinkedIn]';
  return '';
}

/**
 * Trích xuất domain key từ tag detectExternalSource để thêm vào tags array.
 * Ví dụ: '[GitHub]' → 'github', '[YouTube]' → 'youtube'
 */
function extractDomainTag(tag) {
  if (!tag) return '';
  return tag.replace(/[\[\]]/g, '').toLowerCase();
}

// ── Score Calculator — Tính điểm chất lượng nguồn (0-1) ──
// Buffed scores: base 0.6, hệ số chia lớn hơn để nâng điểm trung bình
function calculateSourceScore({ type, stars, views, points, relevanceConfidence, isRelevant }) {
  let score = 0.6; // Base score: từ 0.5 → 0.6

  switch (type) {
    case 'repo': {
      // GitHub: dựa trên stars (log scale), giảm độ gắt
      if (stars) {
        score = Math.min(1.0, Math.log10(stars + 1) / 5); // 100k stars → ~1.0, 1k → ~0.6
      }
      break;
    }
    case 'video': {
      // YouTube: dựa trên views (log scale), giảm độ gắt
      if (views) {
        score = Math.min(1.0, Math.log10(views + 1) / 6); // 1M views → ~1.0, 10k → ~0.67
      }
      break;
    }
    case 'reddit': {
      // Reddit: giảm từ /4 → /3.0 để nâng điểm
      if (points) {
        score = Math.min(1.0, Math.log10(points + 1) / 3.0);
      }
      break;
    }
    case 'stackoverflow': {
      // StackOverflow: giảm từ /3 → /2.5 để nâng điểm
      if (points) {
        score = Math.min(1.0, Math.log10(points + 1) / 2.5);
      }
      break;
    }
    case 'hackernews': {
      // HN: giảm từ /3.5 → /3.0 để nâng điểm
      if (points) {
        score = Math.min(1.0, Math.log10(points + 1) / 3.0);
      }
      break;
    }
    case 'arxiv': {
      // arXiv: base score cao vì là academic paper
      score = 0.75;
      break;
    }
    default:
      score = 0.6;
  }

  // Relevance gate bonus/penalty (nhẹ hơn)
  if (isRelevant === false) score *= 0.5; // từ 0.3 → 0.5
  if (relevanceConfidence === 'high') score *= 1.1;
  if (relevanceConfidence === 'low') score *= 0.85; // từ 0.8 → 0.85

  return Math.min(1.0, Math.max(0, score));
}

// ── Đã tinh chỉnh: Xóa Web Dev, dồn trọng tâm vào Backend, DevOps, C/C++, Java & AGI ──
const DEV_TOPICS = [
  'system design architecture',
  'DevOps CI/CD automation',
  'backend performance optimization',
  'microservices and distributed systems',
  'cloud native infrastructure as code',
  'C++ memory management and pointers',
  'data structures and algorithm analysis',
  'database scaling and sharding strategies',
  'Java multithreading best practices',
  'hardware architecture foundations',
  'Multi-agent AI ecosystems and LLM orchestration',
  'Computer networking protocols and network architecture',
  'System design case studies for scalable platforms',
];

// ── Active Recall Flagging — Đánh dấu tài liệu chất lượng cao ──
// Nếu score > 0.85 → đánh dấu isHighValueStudy để phục vụ Spaced Repetition
const HIGH_VALUE_THRESHOLD = 0.85;

function isHighValueStudy(score) {
  return score >= HIGH_VALUE_THRESHOLD;
}

// ── Tối ưu hóa API: Chia nhỏ Batch để chống lỗi 413 Payload Too Large ──
async function embedChunksSafe(chunks) {
  const MAX_BATCH_SIZE = 100; // Ngưỡng an toàn cho hầu hết các LLM API
  const allEmbeddings = [];

  try {
    for (let i = 0; i < chunks.length; i += MAX_BATCH_SIZE) {
      const batch = chunks.slice(i, i + MAX_BATCH_SIZE);
      const batchEmbeddings = await embedTextsBatch(batch);
      allEmbeddings.push(...batchEmbeddings);
      // Ngủ 200ms giữa các batch để tránh bị Rate Limit
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    return allEmbeddings;
  } catch (err) {
    console.warn('[pipeline_report_v2] embedTextsBatch failed, falling back to embedText per chunk:', err?.message || err);
    // Fallback cực đoan: Lặp qua từng chunk nếu API Batch sập
    const fallbackEmbeddings = [];
    for (const c of chunks) {
      fallbackEmbeddings.push(await embedText(c));
    }
    return fallbackEmbeddings;
  }
}

async function githubSearch(topic, perPage = GITHUB_PER_PAGE, minStars = GITHUB_MIN_STARS, createdAfter = GITHUB_CREATED_AFTER){
  const q = `${topic} stars:>=${minStars} created:>=${createdAfter}`;
  const url = `${GITHUB_SEARCH_URL}?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=${perPage}`;
  const res = await fetchWithRetry(url, { headers: process.env.GITHUB_TOKEN ? { Authorization: `token ${process.env.GITHUB_TOKEN}` } : {} });
  if(!res.ok) throw new Error(`GitHub search ${res.status}`);
  const j = await res.json();
  return j.items || [];
}

async function fetchRepoReadmeAndAnalyze(owner, repo, stars){
  // Dùng repo_analyzer thay vì spawn child process
  const { analyzeReadme, fetchFileContent } = await import('./lib/repo_analyzer.js');
  const githubToken = process.env.GITHUB_TOKEN || '';

  // Thử lấy README trực tiếp từ GitHub
  const readmeContent = await fetchFileContent(owner, repo, 'README.md', githubToken);
  if (!readmeContent) {
    // Fallback: thử các variant
    for (const name of ['readme.md', 'README.rst', 'README.txt', 'readme.txt', 'README']) {
      const c = await fetchFileContent(owner, repo, name, githubToken);
      if (c) {
        const { analyzeText } = await import('./lib/repo_analyzer.js');
        const analysis = await analyzeText(c, 'readme', { owner, repo });
        return { summary: analysis?.summary?.join('\n') || '', category: analysis?.category || 'Backend' };
      }
    }
    return { error: 'no readme' };
  }

  const { analyzeText } = await import('./lib/repo_analyzer.js');
  const analysis = await analyzeText(readmeContent, 'readme', { owner, repo });
  return { summary: analysis?.summary?.join('\n') || '', category: analysis?.category || 'Backend' };
  const summaryPath = path.join(base, 'summary.txt');
  let summary = '';
  let category = 'Backend';
  try{ summary = await fs.readFile(summaryPath,'utf8'); }catch(e){/*ignore*/}
  try{
    const analysisJson = await fs.readFile(path.join(base, 'analysis.json'), 'utf8');
    const parsed = JSON.parse(analysisJson);
    if(['Backend', 'AI', 'DevOps', 'Math', 'Algorithms'].includes(parsed.category)) category = parsed.category;
  }catch(e){/*ignore*/}

  // Chunk, embed, and upsert into vector DB (Qdrant Academic Space)
  try{
    const text = await fs.readFile(readmeFile,'utf8');
    const chunks = chunkText(text, 1000, 100);
    const embeddings = await embedChunksSafe(chunks);
    const docId = `repo:${owner}/${repo}`;
    // Bổ sung metadata 'space: academic' cho 3-Space Vector DB
    await upsertDocument(docId, { url: `https://github.com/${owner}/${repo}`, project: repo, category, space: 'academic' }, chunks, embeddings);
  }catch(e){ console.error('Vector upsert failed for repo', owner+'/'+repo, e.message||e); }

  return { readmePath: readmeFile, summaryPath, summary, category };
}

async function fetchYouTubeVideoStats(videoIds, apiKey){
  if(!apiKey || !videoIds) return {};
  const params = new URLSearchParams({ part: 'statistics', id: videoIds, key: apiKey });
  const res = await fetchWithRetry(`https://www.googleapis.com/youtube/v3/videos?${params.toString()}`);
  if(!res.ok) throw new Error(`YouTube videos stats ${res.status}`);
  const j = await res.json();
  return (j.items || []).reduce((acc, item) => {
    acc[item.id] = {
      viewCount: Number(item.statistics?.viewCount || 0),
      likeCount: Number(item.statistics?.likeCount || 0),
      commentCount: Number(item.statistics?.commentCount || 0),
    };
    return acc;
  }, {});
}

function heuristicRelevance(title, description){
  const text = `${title || ''} ${description || ''}`.toLowerCase();
  
  const strongNegative = [
    'vlog', 'music', 'song', 'singer', 'musician', 'movie', 'film', 'trailer',
    'funny', 'meme', 'prank', 'cute', 'pet', 'animal', 'cooking', 'recipe', 'food',
    'makeup', 'beauty', 'fashion', 'shopping', 'haul', 'unboxing', 'review',
    'family', 'kids', 'baby', 'child', 'home decor', 'interior', 'roof', 'canopy',
    'fitness', 'workout', 'gym', 'yoga', 'dance', 'choreography', 'entertainment'
  ];
  
  const strongPositive = [
    'software', 'backend', 'frontend', 'devops', 'api', 'algorithm', 'code',
    'programming', 'developer', 'database', 'microservices', 'docker', 'kubernetes',
    'cloud computing', 'web development', 'deploy', 'infrastructure','coding insterview',
    'system design', 'distributed systems', 'scalability', 'performance optimization', 
    'load balancing', 'caching strategies', 'cloud architecture', 'software architecture', 
    'multithreading', 'concurrency', 'memory management', 'data structures', 'algorithm analysis',
    'network bottleneck', 'networking', 'tcp', 'http', 'protocol', 'server', 'latency',
    'throughput', 'bandwidth', 'firewall', 'load balancer', 'reverse proxy', 'cdn'
  ];

  if(strongNegative.some((term) => text.includes(term))){
    if(!strongPositive.some((term) => text.includes(term))){
      return { isRelevant: false, confidence: 'high', reason: 'Non-technical content detected', score: 0.2 };
    }
  }
  
  if(strongPositive.some((term) => text.includes(term))){
    return { isRelevant: true, confidence: 'medium', reason: 'Technical content confirmed', score: 0.7 };
  }

  const weakPositive = ['system', 'design', 'architecture', 'learning', 'tutorial', 'course', 'engineering'];
  const weakCount = weakPositive.filter((term) => text.includes(term)).length;
  if(weakCount >= 2){
    return { isRelevant: true, confidence: 'low', reason: 'Technical keywords detected', score: 0.5 };
  }

  return { isRelevant: false, confidence: 'medium', reason: 'Insufficient technical indicators', score: 0.3 };
}

async function preCheckRelevance(title, description){
  const result = heuristicRelevance(title, description);
  if(!result.isRelevant){
    console.log('[preCheckRelevance] Gatekeeper rejected:', result.reason);
  }
  return result;
}

async function preCheckRelevanceWithLLM(title, description){
  const apiKey = process.env.GOOGLE_API_KEY || process.env.Google_API_KEY;
  if(!apiKey){
    console.warn('[preCheckRelevance] GOOGLE_API_KEY not set, using heuristic fallback');
    return heuristicRelevance(title, description);
  }

  const systemPrompt = `You are a Senior Tech Lead with 20 years of experience evaluating technical content quality. Your role is to distinguish between SOFTWARE ENGINEERING content and non-technical content with precision.

CRITICAL DISTINCTION:
- "System Design" in SOFTWARE ENGINEERING = Distributed systems, APIs, databases, microservices, cloud architecture, load balancing, caching strategies, scalability patterns
- "System Design" in OTHER DOMAINS = Architecture, interior design, roof systems, furniture layouts, building structures

DECISION CRITERIA (STRICT):
1. Does the content contain technical implementation details (code, architecture diagrams, infrastructure)?
2. Does it discuss software systems, backend infrastructure, DevOps, or software architecture?
3. Is the target audience software engineers, developers, or tech professionals?

Return JSON with exactly: {"isRelevant": boolean, "confidence": 0-100, "reason": "brief explanation"}`;

  const userPrompt = `Title: "${title}"
Description: "${description}"

Evaluate if this is legitimate software engineering content or misleading/non-technical content.`;

  try{
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent`;
    const body = {
      system: [{ text: systemPrompt }],
      contents: [
        {
          parts: [{ text: userPrompt }]
        }
      ],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 200,
      }
    };
    const res = await fetchWithRetry(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
    });
    if(!res.ok){
      console.warn('[preCheckRelevance] LLM API error, falling back to heuristic');
      return heuristicRelevance(title, description);
    }
    const j = await res.json();
    const raw = j?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const match = String(raw).match(/\{[\s\S]*\}$/m);
    if(!match) {
      return heuristicRelevance(title, description);
    }
    const parsed = JSON.parse(match[0]);
    // Normalize confidence: LLM có thể trả về number (0-100) hoặc string ('high'/'medium'/'low')
    let confidenceStr = 'medium';
    if (typeof parsed.confidence === 'number') {
      confidenceStr = parsed.confidence >= 70 ? 'high' : parsed.confidence >= 40 ? 'medium' : 'low';
    } else if (typeof parsed.confidence === 'string') {
      confidenceStr = parsed.confidence;
    }
    // Normalize score: đảm bảo luôn có giá trị mặc định
    const score = (typeof parsed.score === 'number' && !isNaN(parsed.score))
      ? Math.max(0, Math.min(1, parsed.score))
      : (parsed.isRelevant ? 0.6 : 0.2);
    return {
      isRelevant: Boolean(parsed.isRelevant),
      confidence: confidenceStr,
      reason: String(parsed.reason || 'No reason provided'),
      score,
    };
  }catch(e){
    console.warn('[preCheckRelevance] LLM request failed, falling back to heuristic');
    return heuristicRelevance(title, description);
  }
}

async function youtubeSearchVideos(topic, maxResults = YOUTUBE_MAX_RESULTS, minViews = YOUTUBE_MIN_VIEWS){
  const apiKey = process.env.YOUTUBE_API_KEY;
  const params = new URLSearchParams({
    part: 'snippet',
    q: topic,
    type: 'video',
    order: YOUTUBE_ORDER,
    publishedAfter: '2026-01-01T00:00:00Z',
    maxResults: String(Math.min(maxResults * 2, 50)),
  });
  if(apiKey) params.set('key', apiKey);
  const res = await fetchWithRetry(`${YOUTUBE_SEARCH_URL}?${params.toString()}`);
  if(!res.ok) throw new Error(`Youtube ${res.status}`);
  const j = await res.json();
  const videos = (j.items || []).map((item) => ({
    videoId: item.id.videoId,
    title: item.snippet.title,
    description: item.snippet.description,
    publishedAt: item.snippet.publishedAt,
    channelTitle: item.snippet.channelTitle,
    thumbnail: item.snippet.thumbnails?.default?.url || null,
  })).filter((video) => {
    if(!video.videoId) return false;
    const lower = `${video.title || ''} ${video.description || ''}`.toLowerCase();
    const isShorts = /#shorts|\bshorts\b/.test(lower);
    const isIndonesiaApi = /\b(kereta api|kembang api)\b/.test(lower);
    return !isShorts && !isIndonesiaApi;
  });

  const ids = videos.map((video) => video.videoId).join(',');
  const stats = await fetchYouTubeVideoStats(ids, apiKey);

  const enriched = videos.map((video) => ({
    ...video,
    viewCount: stats[video.videoId]?.viewCount || 0,
  })).filter((video) => video.viewCount >= minViews)
    .sort((a, b) => b.viewCount - a.viewCount)
    .slice(0, maxResults);

  return enriched;
}

async function redditSearch(topic, maxResults = 5){
  const url = `https://www.reddit.com/search.json?q=${encodeURIComponent(topic)}&sort=relevance&t=all&limit=${maxResults}`;
  const res = await fetchWithRetry(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json',
    },
  });
  if (res.status === 403) {
    console.warn('[Reddit] 403 Forbidden — Reddit may be blocking automated requests. Returning empty results.');
    return [];
  }
  if(!res.ok) throw new Error(`Reddit search ${res.status}`);
  const j = await res.json();
  return (j.data?.children || []).map((item) => ({
    id: item.data.id,
    title: item.data.title,
    subreddit: item.data.subreddit,
    selftext: item.data.selftext || '',
    score: item.data.score || 0,
    url: `https://www.reddit.com${item.data.permalink}`,
  })).filter((post) => post.title || post.selftext);
}

async function stackOverflowSearch(topic, maxResults = 5){
  const url = `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q=${encodeURIComponent(topic)}&site=stackoverflow&pagesize=${maxResults}&filter=withbody`;
  const res = await fetchWithRetry(url);
  if(!res.ok) throw new Error(`StackOverflow search ${res.status}`);
  const j = await res.json();
  return (j.items || []).map((item) => ({
    question_id: item.question_id,
    title: item.title,
    body: item.body || '',
    link: item.link,
    score: item.score || 0,
    tags: item.tags || [],
    accepted_answer_id: item.accepted_answer_id || null,
  })).filter((q) => q.title || q.body);
}

async function hackerNewsSearch(topic, maxResults = 5){
  const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(topic)}&tags=story&hitsPerPage=${maxResults}`;
  const res = await fetchWithRetry(url);
  if(!res.ok) throw new Error(`Hacker News search ${res.status}`);
  const j = await res.json();
  return (j.hits || []).map((hit) => ({
    objectID: hit.objectID,
    title: hit.title || hit.story_title || 'Hacker News Story',
    url: hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}`,
    author: hit.author,
    points: hit.points || 0,
    created_at: hit.created_at,
    story_text: hit.story_text || '',
  })).filter((story) => story.title);
}

async function analyzeWebItemAndUpsert(itemKey, metadata, text, category = 'Backend'){
  const slug = itemKey.replace(/[^a-zA-Z0-9]+/g, '-').slice(0, 120);
  const baseDir = path.resolve('./artifacts', `${metadata.type || 'web'}-${slug}`);
  await fs.mkdir(baseDir, { recursive: true });
  const sourcePath = path.join(baseDir, 'source.txt');
  await fs.writeFile(sourcePath, text, 'utf8');
  const analysisMetadata = `${metadata.source || metadata.url || ''}`;
  try{
    // Dùng analyzeText trực tiếp thay vì spawn child process
    const { analyzeText } = await import('./lib/repo_analyzer.js');
    const analysis = await analyzeText(text, metadata.type || 'web', { source: itemKey });
    // Lưu summary vào file để backward compat
    if (analysis?.summary) {
      await fs.writeFile(path.join(baseDir, 'summary.txt'), analysis.summary.join('\n'), 'utf8');
    }
  }catch(e){
    console.warn('Web item analysis failed for', itemKey, e.message||e);
  }
  let summary = '';
  let categoryGuess = category;
  try{ summary = await fs.readFile(path.join(baseDir, 'summary.txt'),'utf8'); }catch(_){ }
  try{
    const analysisJson = await fs.readFile(path.join(baseDir, 'analysis.json'), 'utf8');
    const parsed = JSON.parse(analysisJson);
    if(['Backend','AI','DevOps','Math','Algorithms'].includes(parsed.category)) categoryGuess = parsed.category;
  }catch(_){ }
  const chunks = chunkText(text, 1000, 100);
  const embeddings = await embedChunksSafe(chunks);
  const docId = `${metadata.type || 'web'}:${itemKey}`;
  // Đảm bảo trích xuất chính xác vào không gian 'academic'
  await upsertDocument(docId, { url: metadata.url || metadata.link || '', project: metadata.title || metadata.name || itemKey, category: categoryGuess, space: 'academic' }, chunks, embeddings);
  return { summary, category: categoryGuess };
}

async function arxivSearch(topic, maxResults = 3){
  const query = encodeURIComponent(`all:${topic}`);
  const url = `http://export.arxiv.org/api/query?search_query=${query}&start=0&max_results=${maxResults}&sortBy=relevance&sortOrder=descending`;
  let res;
  for (let attempt = 0; attempt < 3; attempt++) {
    res = await fetch(url);
    if (res.ok) break;
    if (res.status === 429) {
      const delay = (attempt + 1) * 3000;
      console.warn(`[arXiv] Rate limited (429), retrying in ${delay}ms...`);
      await new Promise(r => setTimeout(r, delay));
    } else {
      break;
    }
  }
  if(!res.ok) throw new Error(`arXiv search ${res.status}`);
  const xml = await res.text();
  const entries = Array.from(xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)).slice(0, maxResults);
  return entries.map((match) => {
    const entry = match[1];
    const idMatch = entry.match(/<id>([^<]+)<\/id>/);
    const titleMatch = entry.match(/<title>([\s\S]*?)<\/title>/);
    const summaryMatch = entry.match(/<summary>([\s\S]*?)<\/summary>/);
    const publishedMatch = entry.match(/<published>([^<]+)<\/published>/);
    const authors = Array.from(entry.matchAll(/<name>([^<]+)<\/name>/g)).map((m) => m[1].trim());
    const pdfMatch = entry.match(/<link[^>]*title="pdf"[^>]*href="([^"]+)"/);
    return {
      id: idMatch?.[1]?.trim() || 'unknown',
      title: titleMatch?.[1]?.trim().replace(/\s+/g, ' ') || 'No title',
      summary: summaryMatch?.[1]?.trim().replace(/\s+/g, ' ') || '',
      published: publishedMatch?.[1]?.trim() || '',
      authors,
      pdf_url: pdfMatch?.[1] || null,
      link: idMatch?.[1]?.trim() || null,
    };
  });
}

async function fetchArxivPaperAndAnalyze(paper){
  const slug = paper.id.replace(/https?:\/\//, '').replace(/[\/\s]+/g, '-');
  const baseDir = path.resolve('./artifacts', `arxiv-${slug}`);
  await fs.mkdir(baseDir, { recursive: true });
  const descPath = path.join(baseDir, 'description.txt');
  const text = `Title: ${paper.title}\nAuthors: ${paper.authors.join(', ')}\nPublished: ${paper.published}\nURL: ${paper.link}\n\n${paper.summary}`;
  await fs.writeFile(descPath, text, 'utf8');

  try{
    // Dùng analyzeText trực tiếp thay vì spawn child process
    const { analyzeText } = await import('./lib/repo_analyzer.js');
    const analysis = await analyzeText(text, 'arxiv', { source: paper.id });
    if (analysis?.summary) {
      await fs.writeFile(path.join(baseDir, 'summary.txt'), analysis.summary.join('\n'), 'utf8');
    }
  }catch(e){
    console.warn('arXiv analysis failed for', paper.id, e.message || e);
  }

  let summary = '';
  try{ summary = await fs.readFile(path.join(baseDir, 'summary.txt'),'utf8'); }catch(_){ }

  const category = 'AI';
  const chunks = chunkText(text, 1000, 100);
  const embeddings = await embedChunksSafe(chunks);
  const docId = `arxiv:${paper.id}`;
  await upsertDocument(docId, { url: paper.pdf_url || paper.link, project: paper.title, category, space: 'academic' }, chunks, embeddings);
  return { ...paper, summary, descPath, category };
}

function extractBullets(summary){
  if(!summary) return [];
  const lines = summary.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const bullets = lines.map((line) => line.replace(/^[-*\s]+/, '').trim());
  if(bullets.length >= 3) return bullets.slice(0, 3);
  const fallback = summary.split(/[\.\?\!]\s+/).map((sentence) => sentence.trim()).filter(Boolean);
  return bullets.concat(fallback).slice(0, 3);
}

async function fetchVideoAndAnalyze(video){
  const videoId = video.videoId;
  await execp(`node youtube_transcript.js ${videoId}`);
  const descPath = path.resolve('./artifacts', `video-${videoId}`, 'description.txt');
  let summary = '';
  let category = 'Backend';

  try{
    const metadata = `Views: ${video.viewCount}, Channel: ${video.channelTitle}`;
    try{
      await fs.access(descPath);
    }catch(_){
      if(video.description){
        await fs.mkdir(path.dirname(descPath), { recursive: true });
        await fs.writeFile(descPath, video.description, 'utf8');
        console.log('Fallback description saved for video', videoId);
      }
    }
    // Dùng analyzeText trực tiếp cho web items
    const { analyzeText } = await import('./lib/repo_analyzer.js');
    const webContent = await fs.readFile(descPath, 'utf8').catch(() => '');
    const analysis = await analyzeText(webContent, 'web', { source: metadata });
    summary = await fs.readFile(path.resolve('./artifacts', `video-${videoId}`, 'summary.txt'),'utf8');
    const analysisJson = await fs.readFile(path.resolve('./artifacts', `video-${videoId}`, 'analysis.json'),'utf8');
    const parsed = JSON.parse(analysisJson);
    if(['Backend', 'AI', 'DevOps', 'Math', 'Algorithms'].includes(parsed.category)) category = parsed.category;
  }catch(e){/*ignore*/}

  const vidId = `video::${videoId}`;
  await markProcessed({ id: vidId, type: 'video', url: `https://youtu.be/${videoId}`, hash: String(video.viewCount) });

  // Chunk, embed, and upsert transcript/description into vector DB
  try{
    let text = video.description || '';
    try{
      await fs.access(descPath);
      text = await fs.readFile(descPath,'utf8');
    }catch(_){
      console.warn('description.txt missing for video', videoId, '- using video.description fallback');
    }

    const chunks = chunkText(text, 1000, 100);
    const embeddings = await embedChunksSafe(chunks);
    const docId = `video:${videoId}`;
    await upsertDocument(docId, { url: `https://youtu.be/${videoId}`, project: video.channelTitle, category, space: 'academic' }, chunks, embeddings);
  }catch(e){
    console.error('Vector upsert failed for video', videoId, e.message||e);
  }

  return { ...video, summary, descPath, category };
}

async function run(topic = null, isForce = false){
  const chosenTopic = topic && String(topic).trim() ? String(topic).trim() : DEV_TOPICS[Math.floor(Math.random() * DEV_TOPICS.length)];
  if(!topic || !String(topic).trim()){
    console.log('No topic argument provided. Selected random topic:', chosenTopic);
  }

  const allAnalyzedRepos = [];
  const allAnalyzedVideos = [];
  const allAnalyzedSO = [];
  const allAnalyzedHN = [];
  const allAnalyzedPapers = [];
  const allAnalyzedReddits = [];

  await archiveOldMemories(7);
  console.log('Archived older memory entries and kept recent 7-day context.');
  console.log('Searching multi-source for', chosenTopic);

  // Facebook/Tavily web search — tìm social media posts về topic
  async function facebookWebSearch(topic, maxResults = 3) {
    const tavilyKey = process.env.TAVILY_API_KEY;
    if (!tavilyKey) {
      console.log('[search] Facebook/Tavily: No TAVILY_API_KEY, skipping');
      return [];
    }
    try {
      const { tavily } = await import('@tavily/core');
      const client = tavily({ apiKey: tavilyKey });
      
      // Search với query bao gồm "facebook" để tìm posts từ Facebook
      const socialQuery = `${topic} (facebook OR twitter OR linkedin OR reddit)`;
      const result = await client.search(socialQuery, {
        maxResults: maxResults * 3, // Lấy nhiều hơn để filter
        includeAnswer: false,
        searchDepth: 'basic',
      });
      
      const items = (result?.results || [])
        .filter(r => {
          const url = (r.url || '').toLowerCase();
          // Chấp nhiều nguồn social/media
          return url.includes('facebook.com') || url.includes('fb.com') ||
                 url.includes('twitter.com') || url.includes('x.com') ||
                 url.includes('linkedin.com') || url.includes('reddit.com') ||
                 url.includes('medium.com') || url.includes('dev.to') ||
                 url.includes('hashnode.dev');
        })
        .slice(0, maxResults)
        .map(r => {
          const url = (r.url || '').toLowerCase();
          let source = 'web';
          if (url.includes('facebook.com') || url.includes('fb.com')) source = 'facebook';
          else if (url.includes('twitter.com') || url.includes('x.com')) source = 'twitter';
          else if (url.includes('linkedin.com')) source = 'linkedin';
          else if (url.includes('reddit.com')) source = 'reddit';
          else if (url.includes('medium.com')) source = 'medium';
          
          return {
            id: r.url,
            title: r.title || 'Social Post',
            url: r.url,
            snippet: r.content?.slice(0, 300) || '',
            score: 0.6, // Social posts = medium-high score
            source,
          };
        });
      
      if (items.length === 0) {
        // Fallback: lấy general web results nếu không tìm được social
        const fallback = await client.search(topic, {
          maxResults: maxResults,
          includeAnswer: false,
          searchDepth: 'basic',
        });
        return (fallback?.results || []).slice(0, maxResults).map(r => ({
          id: r.url,
          title: r.title || 'Web Post',
          url: r.url,
          snippet: r.content?.slice(0, 300) || '',
          score: 0.4,
          source: 'web',
        }));
      }
      
      return items;
    } catch (err) {
      console.warn('[search] Facebook/Tavily search failed:', err?.message || err);
      return [];
    }
  }

  const searchResults = await Promise.allSettled([
    githubSearch(chosenTopic),
    youtubeSearchVideos(chosenTopic),
    arxivSearch(chosenTopic),
    redditSearch(chosenTopic),
    stackOverflowSearch(chosenTopic),
    hackerNewsSearch(chosenTopic),
    facebookWebSearch(chosenTopic),
  ]);

  const repos = searchResults[0].status === 'fulfilled' ? searchResults[0].value : [];
  const videos = searchResults[1].status === 'fulfilled' ? searchResults[1].value : [];
  const papers = searchResults[2].status === 'fulfilled' ? searchResults[2].value : [];
  const reddits = searchResults[3].status === 'fulfilled' ? searchResults[3].value : [];
  const stackoverflow = searchResults[4].status === 'fulfilled' ? searchResults[4].value : [];
  const hackerNews = searchResults[5].status === 'fulfilled' ? searchResults[5].value : [];
  const facebookPosts = searchResults[6].status === 'fulfilled' ? searchResults[6].value : [];

  // Detailed logging for debugging
  const sourceSummary = [
    { name: 'GitHub', count: repos.length, failed: searchResults[0].status === 'rejected', error: searchResults[0].reason?.message },
    { name: 'YouTube', count: videos.length, failed: searchResults[1].status === 'rejected', error: searchResults[1].reason?.message },
    { name: 'arXiv', count: papers.length, failed: searchResults[2].status === 'rejected', error: searchResults[2].reason?.message },
    { name: 'Reddit', count: reddits.length, failed: searchResults[3].status === 'rejected', error: searchResults[3].reason?.message },
    { name: 'StackOverflow', count: stackoverflow.length, failed: searchResults[4].status === 'rejected', error: searchResults[4].reason?.message },
    { name: 'HackerNews', count: hackerNews.length, failed: searchResults[5].status === 'rejected', error: searchResults[5].reason?.message },
    { name: 'Facebook/Tavily', count: facebookPosts.length, failed: searchResults[6].status === 'rejected', error: searchResults[6].reason?.message },
  ];
  for (const s of sourceSummary) {
    if (s.failed) console.warn(`[search] ❌ ${s.name} FAILED: ${s.error}`);
    else if (s.count === 0) console.log(`[search] ⚠ ${s.name}: 0 results`);
    else console.log(`[search] ✓ ${s.name}: ${s.count} results`);
  }
  console.log(`[search] Total: ${repos.length} repos, ${videos.length} videos, ${papers.length} papers, ${reddits.length} reddits, ${stackoverflow.length} SO, ${hackerNews.length} HN, ${facebookPosts.length} FB`);

  // ═══════════════════════════════════════════════════════════════
  // AGGREGATION: Thu thập tất cả results vào 1 mảng
  // ═══════════════════════════════════════════════════════════════
  const allResults = [];

  for(const r of repos){
    const owner = r.owner.login; const name = r.name;
    const id = `repo::${r.full_name}`;
    if(!isForce && await isProcessed(id)){
      console.log('Skipped already processed repo', r.full_name);
      continue;
    }
    if(isForce && await isProcessed(id)){
      console.log('Force re-analyzing processed repo', r.full_name);
    }

    // GitHub repos từ API đã được filter stars >= threshold, nên luôn relevant
    // Chỉ dùng heuristic nhẹ, không dùng LLM gate cho repo (stars đã là signal đủ mạnh)
    const repoGate = preCheckRelevance(r.full_name, r.description || '');
    if(!repoGate.isRelevant && (r.stargazers_count || 0) >= 50000){
      // High-star repo luôn keep dù heuristic fail
      console.log('[KEEP] High-star repo', r.full_name, '⭐', r.stargazers_count, '- bypass heuristic');
    } else if(!repoGate.isRelevant && repoGate.confidence !== 'low'){
      console.log('[DROP] GitHub repo', r.full_name, '-', repoGate.reason);
      continue;
    }

    console.log('Analyzing repo', r.full_name, '⭐', r.stargazers_count);
    const analysis = await fetchRepoReadmeAndAnalyze(owner, name, r.stargazers_count);
    allAnalyzedRepos.push({ name: r.full_name, stars: r.stargazers_count, url: r.html_url, summary: analysis.summary, category: analysis.category });
    await markProcessed({ id, type: 'repo', url: r.html_url, hash: String(r.stargazers_count) });
    const score = calculateSourceScore({ type: 'repo', stars: r.stargazers_count, relevanceConfidence: repoGate?.confidence || 'medium', isRelevant: repoGate?.isRelevant !== false });
    const highValue = isHighValueStudy(score);
    if (highValue) console.log(`[HIGH VALUE] Repo ${r.full_name} — score: ${score.toFixed(2)}`);
    await addMemory({
      id: `memory:repo:${r.full_name}`,
      type: 'repo',
      source: r.full_name,
      sourceUrl: r.html_url,
      content: analysis.summary || '',
      tags: [analysis.category, 'github', ...(highValue ? ['high-value-study'] : [])],
      metadata: { score, isHighValueStudy: highValue },
    });
    allResults.push({
      title: r.full_name,
      url: r.html_url,
      type: 'repo',
      category: analysis.category,
      score,
      stars: r.stargazers_count,
    });
  }

  for(const video of videos){
    const id = `video::${video.videoId}`;
    if(!isForce && await isProcessed(id)){
      console.log('Skipped already processed video', video.title);
      continue;
    }
    if(isForce && await isProcessed(id)){
      console.log('Force re-analyzing processed video', video.title);
    }

    // YouTube videos từ API đã được filter view count, nên luôn relevant
    // Chỉ dùng LLM check nếu có API key, bỏ qua heuristic drop
    const videoGate = await preCheckRelevanceWithLLM(video.title, video.description || '');
    if(!videoGate.isRelevant && videoGate.confidence === 'high'){
      console.log('[DROP] YouTube video', video.videoId, '-', videoGate.reason);
      continue;
    }
    if(!videoGate.isRelevant){
      console.log('[WARN] YouTube video', video.videoId, '- low confidence, keeping anyway:', videoGate.reason);
    }

    console.log('Analyzing video', video.title, video.videoId);
    const analyzed = await fetchVideoAndAnalyze(video);
    allAnalyzedVideos.push({ title: analyzed.title, videoId: analyzed.videoId, channelTitle: analyzed.channelTitle, viewCount: analyzed.viewCount, url: `https://youtu.be/${analyzed.videoId}`, summary: analyzed.summary, category: analyzed.category });
    const videoScore = calculateSourceScore({ type: 'video', views: analyzed.viewCount, relevanceConfidence: videoGate.confidence, isRelevant: videoGate.isRelevant });
    const videoHighValue = isHighValueStudy(videoScore);
    if (videoHighValue) console.log(`[HIGH VALUE] Video "${analyzed.title}" — score: ${videoScore.toFixed(2)}`);
    await addMemory({
      id: `memory:video:${video.videoId}`,
      type: 'video',
      source: video.title,
      sourceUrl: `https://youtu.be/${video.videoId}`,
      content: analyzed.summary || '',
      tags: [analyzed.category, 'youtube', ...(videoHighValue ? ['high-value-study'] : [])],
      metadata: { score: videoScore, isHighValueStudy: videoHighValue },
    });
    allResults.push({
      title: `${analyzed.title} (${analyzed.channelTitle})`,
      url: `https://youtu.be/${analyzed.videoId}`,
      type: 'video',
      category: analyzed.category,
      score: videoScore,
      views: analyzed.viewCount,
    });
  }

  for(const post of reddits){
    const id = `reddit::${post.id}`;
    if(!isForce && await isProcessed(id)){
      console.log('Skipped already processed Reddit post', post.title);
      continue;
    }

    if(isForce && await isProcessed(id)){
      console.log('Force re-analyzing processed Reddit post', post.title);
    }

    const redditGate = await preCheckRelevanceWithLLM(post.title, post.selftext || '');
    if(!redditGate.isRelevant){
      console.log('[DROP] Reddit post', post.url, '-', redditGate.reason, `(confidence: ${redditGate.confidence})`);
      continue;
    }

    console.log('Analyzing Reddit post', post.title);
    const analyzed = await analyzeWebItemAndUpsert(
      post.id,
      { type: 'reddit', title: post.title, url: post.url, source: post.subreddit },
      `${post.title}\n\n${post.selftext || ''}`,
      'DevOps'
    );

    // ── BƯỚC 2: Phân tích URL đích để gán tag nguồn thực sự ──
    const redditExternalTag = detectExternalSource(post.url);
    const redditExternalDomain = extractDomainTag(redditExternalTag);
    const redditEnrichedTitle = redditExternalTag ? `${redditExternalTag} ${post.title}` : post.title;
    if (redditExternalTag) {
      console.log(`[Reddit] External source detected: ${redditExternalTag} → ${post.url}`);
    }

    // ── BƯỚC 3: Thêm domain đích vào tags để Vector DB truy vấn chính xác ──
    const redditTags = [analyzed.category || 'DevOps', 'reddit'];
    if (redditExternalDomain) redditTags.push(redditExternalDomain);

    const redditScore = calculateSourceScore({ type: 'reddit', points: post.score, relevanceConfidence: redditGate.confidence, isRelevant: redditGate.isRelevant });
    const redditHighValue = isHighValueStudy(redditScore);
    if (redditHighValue) console.log(`[HIGH VALUE] Reddit "${post.title.slice(0, 50)}" — score: ${redditScore.toFixed(2)}`);
    await addMemory({
      id,
      type: 'reddit',
      source: redditEnrichedTitle,
      sourceUrl: post.url,
      content: analyzed.summary || post.selftext || post.title,
      tags: [...redditTags, ...(redditHighValue ? ['high-value-study'] : [])],
      metadata: { score: redditScore, isHighValueStudy: redditHighValue },
    });
    allResults.push({
      title: redditEnrichedTitle,
      url: post.url,
      type: 'reddit',
      category: analyzed.category,
      score: redditScore,
      points: post.score,
    });
  }

  for(const question of stackoverflow){
    const id = `stackoverflow::${question.question_id}`;
    if(!isForce && await isProcessed(id)){
      console.log('Skipped already processed StackOverflow question', question.title);
      continue;
    }

    const soGate = await preCheckRelevanceWithLLM(question.title, question.body || '');
    if(!soGate.isRelevant){
      console.log('[DROP] StackOverflow question', question.link, '-', soGate.reason, `(confidence: ${soGate.confidence})`);
      continue;
    }

    console.log('Analyzing StackOverflow question', question.title);
    const analyzed = await analyzeWebItemAndUpsert(
      String(question.question_id),
      { type: 'stackoverflow', title: question.title, url: question.link, source: question.tags.join(', ') },
      `Title: ${question.title}\nTags: ${question.tags.join(', ')}\n\n${question.body}`,
      'Algorithms'
    );

    allAnalyzedSO.push({ title: question.title, question_id: question.question_id, link: question.link, tags: question.tags, summary: analyzed.summary, category: analyzed.category });
    const soScore = calculateSourceScore({ type: 'stackoverflow', points: question.score, relevanceConfidence: soGate.confidence, isRelevant: soGate.isRelevant });
    const soHighValue = isHighValueStudy(soScore);
    if (soHighValue) console.log(`[HIGH VALUE] StackOverflow "${question.title.slice(0, 50)}" — score: ${soScore.toFixed(2)}`);
    await addMemory({
      id,
      type: 'stackoverflow',
      source: question.title,
      sourceUrl: question.link,
      content: analyzed.summary || question.body || question.title,
      tags: [analyzed.category || 'Algorithms', 'stackoverflow', ...(soHighValue ? ['high-value-study'] : [])],
      metadata: { score: soScore, isHighValueStudy: soHighValue },
    });
    allResults.push({
      title: question.title,
      url: question.link,
      type: 'stackoverflow',
      category: analyzed.category,
      score: soScore,
      points: question.score,
    });
  }

  for(const story of hackerNews){
    const id = `hackernews::${story.objectID}`;
    if(!isForce && await isProcessed(id)){
      console.log('Skipped already processed Hacker News story', story.title);
      continue;
    }

    const hnGate = await preCheckRelevanceWithLLM(story.title, story.story_text || '');
    if(!hnGate.isRelevant){
      console.log('[DROP] Hacker News', story.url, '-', hnGate.reason, `(confidence: ${hnGate.confidence})`);
      continue;
    }

    console.log('Analyzing Hacker News story', story.title);
    const analyzed = await analyzeWebItemAndUpsert(
      String(story.objectID),
      { type: 'hackernews', title: story.title, url: story.url, source: story.author },
      `Title: ${story.title}\nAuthor: ${story.author}\nPoints: ${story.points}\nURL: ${story.url}\n\n${story.story_text || ''}`,
      'Backend'
    );

    // ── BƯỚC 2: Phân tích URL đích để gán tag nguồn thực sự ──
    const hnExternalTag = detectExternalSource(story.url);
    const hnExternalDomain = extractDomainTag(hnExternalTag);
    const hnEnrichedTitle = hnExternalTag ? `${hnExternalTag} ${story.title}` : story.title;
    if (hnExternalTag) {
      console.log(`[HN] External source detected: ${hnExternalTag} → ${story.url}`);
    }

    allAnalyzedHN.push({ title: hnEnrichedTitle, objectID: story.objectID, url: story.url, author: story.author, points: story.points, summary: analyzed.summary, category: analyzed.category });
    const hnScore = calculateSourceScore({ type: 'hackernews', points: story.points, relevanceConfidence: hnGate.confidence, isRelevant: hnGate.isRelevant });
    const hnHighValue = isHighValueStudy(hnScore);
    if (hnHighValue) console.log(`[HIGH VALUE] HN "${story.title.slice(0, 50)}" — score: ${hnScore.toFixed(2)}`);
    const hnTags = [analyzed.category || 'Backend', 'hackernews', ...(hnHighValue ? ['high-value-study'] : [])];
    if (hnExternalDomain) hnTags.push(hnExternalDomain);
    await addMemory({
      id,
      type: 'hackernews',
      source: hnEnrichedTitle,
      sourceUrl: story.url,
      content: analyzed.summary || story.story_text || story.title,
      tags: hnTags,
      metadata: { score: hnScore, isHighValueStudy: hnHighValue },
    });
    allResults.push({
      title: hnEnrichedTitle,
      url: story.url,
      type: 'hackernews',
      category: analyzed.category,
      score: hnScore,
      points: story.points,
    });
  }

  // ── Facebook / Web Social Posts ──
  for(const post of facebookPosts){
    const id = `facebook::${post.id.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 80)}`;
    if(!isForce && await isProcessed(id)){
      console.log('Skipped already processed Facebook post', post.title);
      continue;
    }

    console.log('Analyzing Facebook/web post', post.title);
    const analyzed = await analyzeWebItemAndUpsert(
      id,
      { type: 'facebook', title: post.title, url: post.url, source: post.source },
      `${post.title}\n\n${post.snippet}`,
      'Backend'
    );

    const fbScore = calculateSourceScore({ type: 'facebook', relevanceConfidence: 'medium', isRelevant: true });
    const fbHighValue = isHighValueStudy(fbScore);
    await addMemory({
      id,
      type: 'facebook',
      source: post.title,
      sourceUrl: post.url,
      content: analyzed.summary || post.snippet || post.title,
      tags: [analyzed.category || 'Backend', 'facebook', ...(fbHighValue ? ['high-value-study'] : [])],
      metadata: { score: fbScore, isHighValueStudy: fbHighValue },
    });
    allResults.push({
      title: post.title,
      url: post.url,
      type: post.source || 'facebook',
      category: analyzed.category || 'Backend',
      score: fbScore,
    });
  }

  for(const paper of papers){
    const id = `arxiv::${paper.id}`;
    if(!isForce && await isProcessed(id)){
      console.log('Skipped already processed arXiv paper', paper.id);
      continue;
    }

    console.log('Analyzing arXiv paper', paper.title);
    const analyzed = await fetchArxivPaperAndAnalyze(paper);
    await addMemory({
      id,
      type: 'arxiv',
      source: paper.title,
      sourceUrl: paper.pdf_url || paper.link || '',
      content: analyzed.summary || paper.summary || '',
      tags: [analyzed.category, 'arxiv'],
    });

    const score = calculateSourceScore({ type: 'arxiv' });
    allResults.push({
      title: paper.title,
      url: paper.pdf_url || paper.link || '',
      type: 'arxiv',
      category: analyzed.category,
      score,
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // SINGLE AGGREGATED WEBHOOK — Chỉ gửi khi KHÔNG phải catch-up (--no-webhook)
  // ═══════════════════════════════════════════════════════════════
  const noWebhook = process.argv.includes('--no-webhook');
  if (process.env.DISCORD_WEBHOOK && !noWebhook) {
    try {
      const { sendAggregatedWebhook } = await import('./notify_discord.js');

      if (allResults.length > 0) {
        // Có source → gửi thông báo source bình thường
        await sendAggregatedWebhook({
          topic: chosenTopic,
          results: allResults,
          bullets: `${allResults.length} sources found across YouTube, GitHub, StackOverflow, HackerNews, arXiv, Facebook`,
        });
        console.log(`[Webhook] ✓ Sent aggregated embed with ${allResults.length} sources`);
      } else {
        // Không có source → gửi thông báo server status (để biết pipeline đã chạy)
        const errorSources = [];
        if (repos.length === 0) errorSources.push('GitHub');
        if (videos.length === 0) errorSources.push('YouTube');
        if (reddits.length === 0) errorSources.push('Reddit');
        if (stackoverflow.length === 0) errorSources.push('StackOverflow');
        if (hackerNews.length === 0) errorSources.push('HackerNews');
        if (papers.length === 0) errorSources.push('arXiv');
        if (facebookPosts.length === 0) errorSources.push('Facebook/Tavily');

        // ── Fallback: Tạo report từ knowledge base khi search API fail ──
        console.log('[Pipeline] All search APIs failed — generating report from knowledge base...');
        try {
          const { ask: llmAsk } = await import('./lib/llm.js');
          const fallbackReport = await llmAsk(
            `Hãy tạo một báo tổng hợp về chủ đề "${chosenTopic}" dựa trên kiến thức của bạn. Bao gồm: 1) Tổng quan chủ đề, 2) Các khái niệm quan trọng, 3) Best practices, 4) Tài liệu tham khảo gợi ý. Trả lời bằng tiếng Việt, định dạng Markdown.`,
            { maxTokens: 2000, temperature: 0.3 }
          );

          // Gửi webhook với fallback content
          await sendAggregatedWebhook({
            topic: `${chosenTopic} (Fallback — Search APIs unavailable)`,
            results: [{
              title: `📚 Knowledge Base Summary: ${chosenTopic}`,
              url: '',
              type: 'knowledge-base',
              score: 0.5,
              category: 'Backend',
            }],
            bullets: fallbackReport.answer?.slice(0, 500) || 'Generated from knowledge base',
            isError: false,
          });
          console.log('[Webhook] ✓ Sent fallback report from knowledge base');
        } catch (llmErr) {
          // Nếu cả LLM fail → gửi thông báo lỗi
          await sendAggregatedWebhook({
            topic: chosenTopic,
            results: [],
            bullets: '',
            isError: true,
            errorMessage: `All search APIs failed (${errorSources.join(', ')}). LLM fallback also failed: ${llmErr?.message || 'unknown'}`,
          });
          console.log('[Webhook] ⚠️ Sent error notification — all sources and LLM failed');
        }
      }
    } catch (err) {
      console.error('[Webhook] ✗ Aggregated webhook failed:', err?.message || err);
    }
  }

  const report = generateMarkdownReport({
    topic: chosenTopic,
    repos: allAnalyzedRepos,
    videos: allAnalyzedVideos,
    stackoverflow: allAnalyzedSO,
    hackernews: allAnalyzedHN,
    papers: allAnalyzedPapers,
    reddits: allAnalyzedReddits,
  });
  const reportPath = path.resolve('./artifacts', `report-${Date.now()}.md`);
  await fs.writeFile(reportPath, report, 'utf8');
  console.log('📄 Markdown report saved to', reportPath);
  console.log('Pipeline completed for topic', chosenTopic);
}

function generateMarkdownReport({ topic, repos, videos, stackoverflow, hackernews, papers, reddits }) {
  const now = new Date().toISOString();
  const totalSources = repos.length + videos.length + stackoverflow.length + hackernews.length + papers.length + reddits.length;

  let md = '';
  md += `# 🚀 BÁO CÁO PHÂN TÍCH TÀI LIỆU ${topic.toUpperCase()}\n\n`;
  md += `* **🔍 Chủ đề:** ${topic}\n`;
  md += `* **⏱ Thời gian quét:** ${now}\n`;
  md += `* **📊 Tổng quát:** Phân tích thành công **${repos.length} GitHub Repositories**, **${videos.length} YouTube Videos**, **${stackoverflow.length} StackOverflow**, **${hackernews.length} Hacker News**, **${papers.length} arXiv Papers**, **${reddits.length} Reddit Posts**.\n`;
  md += `* **⚙️ Chế độ:** Production\n\n`;
  md += `---\n\n`;

  if (repos.length > 0) {
    md += `## 🏆 TOP GITHUB REPOSITORIES ĐƯỢC ĐÁNH GIÁ\n\n`;
    // Score range: 0-1 (from calculateSourceScore)
    const goodRepos = repos.filter(r => r.score >= 0.7);
    const okRepos = repos.filter(r => r.score >= 0.4 && r.score < 0.7);
    const weakRepos = repos.filter(r => r.score < 0.4);

    if (goodRepos.length > 0) {
      md += `### 🟢 Nguồn Tài Liệu Tốt (Đáng tham khảo nhất)\n\n`;
      md += renderRepoTable(goodRepos);
    }
    if (okRepos.length > 0) {
      md += `### 🟡 Nguồn Tài Liệu Bình Thường (Tham khảo thêm)\n\n`;
      md += renderRepoTable(okRepos);
    }
    if (weakRepos.length > 0) {
      md += `### 🔴 Nguồn Tài Liệu Yếu (Không khuyến nghị)\n\n`;
      md += renderRepoTable(weakRepos);
    }
  }

  if (videos.length > 0) {
    md += `## 📺 PHÂN TÍCH VIDEO YOUTUBE\n\n`;
    md += `| 📺 Tên Video & Link | 👁 Views | 👥 Channel | 🎯 Đánh giá | 💡 Điểm nhấn |\n`;
    md += `|---|---|---|---|---|\n`;
    videos.forEach(v => {
      const title = v.title || v.videoId;
      const url = `https://youtu.be/${v.videoId}`;
      const views = v.viewCount ? Number(v.viewCount).toLocaleString() : 'N/A';
      const channel = v.channelTitle || 'N/A';
      const verdict = v.verdict || 'Chưa đánh giá';
      const highlights = (v.highlights || []).join(', ') || 'N/A';
      md += `| [${title}](${url}) | ${views} | ${channel} | ${verdict} | ${highlights} |\n`;
    });
    md += `\n`;
  }

  if (stackoverflow.length > 0) {
    md += `## 💬 STACKOVERFLOW QUESTIONS\n\n`;
    md += `| 📝 Câu hỏi & Link | 🏷 Tags | 💡 Tóm tắt |\n`;
    md += `|---|---|---|\n`;
    stackoverflow.forEach(q => {
      const title = q.title || 'Untitled';
      const url = q.link || `https://stackoverflow.com/questions/${q.question_id}`;
      const tags = (q.tags || []).slice(0, 3).join(', ');
      const summary = (q.summary || q.body || '').slice(0, 120).replace(/\|/g, '\\|').replace(/\n/g, ' ');
      md += `| [${title}](${url}) | ${tags} | ${summary}... |\n`;
    });
    md += `\n`;
  }

  if (hackernews.length > 0) {
    md += `## 📰 HACKER NEWS STORIES\n\n`;
    md += `| 📰 Tiêu đề & Link | 👤 Tác giả | ⭐ Points | 💡 Tóm tắt |\n`;
    md += `|---|---|---|---|\n`;
    hackernews.forEach(h => {
      const title = h.title || 'Untitled';
      const url = h.url || `https://news.ycombinator.com/item?id=${h.objectID}`;
      const author = h.author || 'N/A';
      const points = h.points || 0;
      const summary = (h.summary || h.story_text || '').slice(0, 120).replace(/\|/g, '\\|').replace(/\n/g, ' ');
      md += `| [${title}](${url}) | ${author} | ${points} | ${summary}... |\n`;
    });
    md += `\n`;
  }

  if (papers.length > 0) {
    md += `## 📄 ARXIV PAPERS\n\n`;
    papers.forEach(p => {
      md += `### ${p.title}\n`;
      md += `- **Authors:** ${(p.authors || []).join(', ')}\n`;
      md += `- **URL:** ${p.link || p.pdf_url || 'N/A'}\n`;
      md += `- **Summary:** ${(p.summary || p.abstract || '').slice(0, 300)}...\n\n`;
    });
  }

  if (reddits.length > 0) {
    md += `## 🔴 REDDIT POSTS\n\n`;
    reddits.forEach(r => {
      md += `### ${r.title}\n`;
      md += `- **Subreddit:** ${r.subreddit || 'N/A'}\n`;
      md += `- **URL:** ${r.url || 'N/A'}\n`;
      md += `- **Summary:** ${(r.summary || r.selftext || '').slice(0, 300)}...\n\n`;
    });
  }

  md += `---\n\n`;
  md += `> 📊 **Tổng cộng:** ${totalSources} nguồn tài liệu được phân tích và index vào vector store.\n`;
  md += `> 🤖 Được tạo bởi **my-ai-brain** pipeline v3.0 — ${now}\n`;
  return md;
}

function renderRepoTable(repos) {
  let md = '';
  md += `| 📦 Tên Repository & Link | ⭐ Stars |  Category | 💡 Tóm tắt |\n`;
  md += `|---|---|---|---|\n`;
  repos.forEach(r => {
    const name = r.name || 'Unknown';
    const url = r.url || `https://github.com/${name}`;
    const stars = r.stars || 0;
    const category = r.category || 'Backend';
    const summary = (r.summary || '').slice(0, 100).replace(/\|/g, '\\|').replace(/\n/g, ' ');
    md += `| [${name}](${url}) | ${stars} | ${category} | ${summary}... |\n`;
  });
  md += `\n`;
  return md;
}

const args = process.argv.slice(2);
const isForce = args.includes('--force');
const topicArg = args.find(arg => arg !== '--force');

run(topicArg, isForce).catch(e=>{ console.error('Pipeline error:', e.message||e); process.exit(1); });