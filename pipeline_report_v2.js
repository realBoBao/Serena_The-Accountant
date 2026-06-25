import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { isProcessed, markProcessed, checkSourceStatus } from './lib/db.js';
import { addMemory, archiveOldMemories } from './lib/memory_manager.js';
import { sendDiscordNotification } from './notify_discord.js';
// Inline chunkText (chunking.js removed)
function chunkText(text, maxChunkSize = 1000, overlap = 100) {
  if (!text || text.length <= maxChunkSize) return [text || ''];
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + maxChunkSize, text.length);
    chunks.push(text.slice(start, end));
    start += maxChunkSize - overlap;
  }
  return chunks;
}
import { embedText, embedTextsBatch } from './lib/embeddings.js';
import { upsertDocument } from './lib/vector_store.js';
import { httpGet } from './lib/http_client.js';
// Inline retry + hedge (backoff.js + request_hedging.js removed)
async function retry(fn, { retries = 3, baseDelay = 1000 } = {}) {
  for (let i = 0; i <= retries; i++) {
    try { return await fn(); } catch (err) {
      if (i === retries) throw err;
      await new Promise(r => setTimeout(r, baseDelay * Math.pow(2, i)));
    }
  }
}
async function hedge(fn, { hedgeDelay = 1500 } = {}) {
  return fn(); // simplified: no hedging, just call directly
}

// ── Deduplication helper ──
// Loại bỏ duplicate sources dựa trên URL (cùng URL từ nhiều sources chỉ giữ 1)
function dedupSources(sources) {
  const seen = new Map();
  for (const s of sources) {
    const key = (s.url || s.title || '').toLowerCase().trim();
    if (!key) continue;
    if (!seen.has(key)) seen.set(key, s);
  }
  return Array.from(seen.values());
}
import {
  detectExternalSource,
  extractDomainTag,
  calculateSourceScore,
  isHighValueStudy,
  embedChunksSafe as _embedChunksSafe,
  preCheckRelevanceWithLLM,
} from './lib/source_analyzer.js';

// Bind embed functions for embedChunksSafe
const embedChunksSafe = (chunks) => _embedChunksSafe(chunks, embedTextsBatch, embedText);

const execp = promisify(exec);
const GITHUB_SEARCH_URL = 'https://api.github.com/search/repositories';
const YOUTUBE_SEARCH_URL = 'https://www.googleapis.com/youtube/v3/search';

const GITHUB_PER_PAGE = Number(process.env.GITHUB_PER_PAGE || 3);
const GITHUB_MIN_STARS = Number(process.env.GITHUB_MIN_STARS || 10);
const YOUTUBE_MAX_RESULTS = Number(process.env.YOUTUBE_MAX_RESULTS || 3);
const YOUTUBE_MIN_VIEWS = Number(process.env.YOUTUBE_MIN_VIEWS || 50000);
const YOUTUBE_ORDER = process.env.YOUTUBE_ORDER || 'viewCount';



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

// ── Topic Tracking: Tránh chạy duplicate topic trong ngày ──
const TOPIC_HISTORY_FILE = path.resolve('./.topic_history.json');

async function loadTopicHistory() {
  try {
    const data = await fs.readFile(TOPIC_HISTORY_FILE, 'utf8');
    const history = JSON.parse(data);
    // Chỉ giữ topics trong hôm nay
    const today = new Date().toISOString().slice(0, 10);
    return history[today] || [];
  } catch {
    return [];
  }
}

async function saveTopicHistory(topic) {
  try {
    let history = {};
    try {
      const data = await fs.readFile(TOPIC_HISTORY_FILE, 'utf8');
      history = JSON.parse(data);
    } catch { /* file not found */ }
    const today = new Date().toISOString().slice(0, 10);
    if (!history[today]) history[today] = [];
    history[today].push({ topic, ts: new Date().toISOString() });
    await fs.writeFile(TOPIC_HISTORY_FILE, JSON.stringify(history, null, 2), 'utf8');
  } catch { /* ignore */ }
}

// Extended topic pool — dùng khi chạy hết DEV_TOPICS
const EXTENDED_TOPICS = [
  'rust programming language',
  'golang concurrency patterns',
  'typescript advanced types',
  'python asyncio deep dive',
  'kubernetes operators',
  'terraform modules',
  'graphql schema design',
  'event-driven architecture',
  'CQRS and event sourcing',
  'database sharding strategies',
  'API gateway patterns',
  'service mesh istio',
  'observability prometheus grafana',
  'chaos engineering practices',
  'LLM fine-tuning techniques',
  'RAG architecture patterns',
  'vector database comparison',
  'multi-agent AI systems',
  'WebAssembly performance',
  'edge computing architecture',
];

async function pickUniqueTopic() {
  const history = await loadTopicHistory();
  const devAvailable = DEV_TOPICS.filter(t => !history.includes(t));
  
  // Nếu còn DEV_TOPICS chưa chạy → random từ đó
  if (devAvailable.length > 0) {
    return devAvailable[Math.floor(Math.random() * devAvailable.length)];
  }
  
  // Nếu chạy hết DEV_TOPICS → random thêm 1 từ EXTENDED_TOPICS
  const extAvailable = EXTENDED_TOPICS.filter(t => !history.includes(t));
  if (extAvailable.length > 0) {
    const topic = extAvailable[Math.floor(Math.random() * extAvailable.length)];
    console.log('[Pipeline] All DEV_TOPICS ran — picking from extended pool:', topic);
    return topic;
  }
  
  // Nếu chạy hết cả 2 → reset và random lại
  console.log('[Pipeline] All topics exhausted — resetting history');
  const today = new Date().toISOString().slice(0, 10);
  await fs.writeFile(TOPIC_HISTORY_FILE, JSON.stringify({ [today]: [] }, null, 2), 'utf8');
  return DEV_TOPICS[Math.floor(Math.random() * DEV_TOPICS.length)];
}
async function githubSearch(topic, perPage = GITHUB_PER_PAGE, minStars = GITHUB_MIN_STARS){
  return retry(
    () => hedge(
      async (signal) => {
        const q = `${topic} stars:>=${minStars}`;
        const url = `${GITHUB_SEARCH_URL}?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=${perPage}`;
        const res = await httpGet(url, {
          headers: process.env.GITHUB_TOKEN ? { Authorization: `token ${process.env.GITHUB_TOKEN}` } : {},
        });
        if (!res.ok) throw new Error(`GitHub search ${res.status}`);
        const j = await res.json();
        return j.items || [];
      },
      { hedgeDelay: 1500, timeout: 8000 }
    ),
    { maxRetries: 2, baseDelay: 1000 }
  );
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
  const summary = analysis?.summary?.join('\n') || '';
  const category = analysis?.category || 'Backend';

  // Chunk, embed, and upsert into vector DB (Qdrant Academic Space)
  try{
    const chunks = chunkText(readmeContent, 1000, 100);
    const embeddings = await embedChunksSafe(chunks);
    const docId = `repo:${owner}/${repo}`;
    // Bổ sung metadata 'space: academic' cho 3-Space Vector DB
    await upsertDocument(docId, { url: `https://github.com/${owner}/${repo}`, project: repo, category, space: 'academic' }, chunks, embeddings);
  }catch(e){ console.error('Vector upsert failed for repo', owner+'/'+repo, e.message||e); }

  return { summary, category };
}

async function fetchYouTubeVideoStats(videoIds, apiKey){
  if(!apiKey || !videoIds) return {};
  const params = new URLSearchParams({ part: 'statistics', id: videoIds, key: apiKey });
  const res = await httpGet(`https://www.googleapis.com/youtube/v3/videos?${params.toString()}`);
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

async function youtubeSearchVideos(topic, maxResults = YOUTUBE_MAX_RESULTS, minViews = YOUTUBE_MIN_VIEWS){
  return retry(
    () => hedge(
      async (signal) => {
        const apiKey = process.env.YOUTUBE_API_KEY;
        const params = new URLSearchParams({
          part: 'snippet',
          q: topic,
          type: 'video',
          order: YOUTUBE_ORDER,
          publishedAfter: '2026-01-01T00:00:00Z',
          maxResults: String(Math.min(maxResults * 2, 50)),
        });
        if (apiKey) params.set('key', apiKey);
        const res = await httpGet(`${YOUTUBE_SEARCH_URL}?${params.toString()}`);
        if (!res.ok) { console.warn(`[Pipeline] YouTube ${res.status} (no API key?), skipping`); return []; }
        const j = await res.json();
        const videos = (j.items || []).map((item) => ({
          videoId: item.id.videoId,
          title: item.snippet.title,
          description: item.snippet.description,
          publishedAt: item.snippet.publishedAt,
          channelTitle: item.snippet.channelTitle,
          thumbnail: item.snippet.thumbnails?.default?.url || null,
        })).filter((video) => {
          if (!video.videoId) return false;
          const lower = `${video.title || ''} ${video.description || ''}`.toLowerCase();
          const isShorts = /#shorts|\bshorts\b/.test(lower);
          const isIndonesiaApi = /\b(kereta api|kembang api)\b/.test(lower);
          // Filter nội dung không liên quan đến tech/engineering
          const IRRELEVANT_TAGS = ['house','homedecor','canopy','roof system','garden','furniture','interior design','real estate','property','apartment','kitchen','bedroom','bathroom','living room','dining','patio','deck','fence','gate','window','door','flooring','paint','wallpaper','lighting','plumbing','electrical','hvac','landscaping','lawn','pool','spa','gym','garage','driveway','sidewalk','street','road','bridge','tunnel','building construction','home improvement','diy home','home repair','home renovation','home makeover','home tour','home design','house tour','room tour','apartment tour','real estate tour','property tour','open house','house hunting','home buying','home selling','mortgage','insurance','tax','legal','financial','investment','stock','crypto','nft','forex','trading','gambling','casino','poker','sports','football','basketball','baseball','soccer','tennis','golf','hockey','mma','wrestling','boxing','cricket','rugby','volleyball','badminton','swimming','running','cycling','hiking','camping','fishing','hunting','cooking','recipe','food','restaurant','travel','tourism','hotel','flight','car','auto','motorcycle','boat','plane','train','bus','subway','taxi','uber','lyft','delivery','shopping','fashion','beauty','makeup','hair','nail','skin','health','medical','dental','vision','pharmacy','drug','supplement','vitamin','weight loss','diet','fitness','yoga','meditation','sleep','stress','anxiety','depression','therapy','counseling','relationship','dating','marriage','parenting','baby','kid','toy','game','movie','music','concert','festival','comedy','drama','action','horror','sci-fi','fantasy','romance','thriller','documentary','animation','anime','manga','comic','book','novel','poetry','art','photography','design','craft','sew','knit','crochet','woodwork','metalwork','pottery','glass','candle','soap','perfume','jewelry','watch','bag','shoe','hat','scarf','glove','sock','underwear','pajama','robe','towel','blanket','pillow','curtain','rug','vase','frame','mirror','clock','lamp','cushion','basket','box','bottle','jar','can','bag','wrap','tape','glue','tool','hardware','safety','security','alarm','camera','sensor','switch','outlet','breaker','wire','pipe','valve','pump','filter','heater','cooler','fan','blower','compressor','generator','battery','inverter','transformer','motor','engine','gear','belt','chain','bearing','seal','gasket','bolt','nut','screw','nail','rivet','pin','spring','clip','clamp','bracket','hinge','latch','lock','key','handle','knob','lever','button','dial','gauge','meter','scale','timer','thermostat','humidifier','dehumidifier','air purifier','vacuum','washer','dryer','dishwasher','refrigerator','freezer','oven','stove','microwave','blender','mixer','toaster','coffee maker','kettle','iron','sewing machine','printer','scanner','monitor','keyboard','mouse','speaker','headphone','microphone','camera','tv','remote','charger','cable','adapter','hub','router','modem','switch','antenna','satellite','dish','receiver','amplifier','equalizer','mixer','turntable','record','tape','cd','dvd','blu-ray','game console','controller','joystick','steering wheel','pedal','seat','wheel','tire','brake','axle','transmission','suspension','exhaust','fuel','oil','coolant','transmission fluid','brake fluid','power steering fluid','windshield wiper','headlight','taillight','turn signal','horn','mirror','windshield','bumper','grille','fender','hood','trunk','door','window','roof','sunroof','convertible','sedan','suv','truck','van','bus','motorcycle','scooter','bicycle','skateboard','roller','ski','snowboard','surfboard','kayak','canoe','raft','sailboat','yacht','ship','submarine','helicopter','jet','rocket','satellite','space station','telescope','microscope','lab','experiment','research','study','thesis','dissertation','paper','journal','magazine','newspaper','blog','podcast','video','stream','channel','subscriber','follower','like','comment','share','post','tweet','story','reel','live','broadcast','webinar','course','class','lesson','tutorial','guide','manual','documentation','specification','standard','regulation','policy','law','rule','guideline','procedure','process','method','technique','strategy','plan','project','task','goal','objective','metric','kpi','benchmark','baseline','target','forecast','budget','schedule','timeline','milestone','deliverable','outcome','impact','result','finding','conclusion','recommendation','action item','next step','follow-up','review','retrospective','lessons learned','best practice','case study','success story','failure analysis','root cause','corrective action','preventive action','continuous improvement','optimization','automation','digital transformation','innovation','disruption','competitive advantage','market share','revenue','profit','cost','savings','roi','npv','irr','payback','breakeven','margin','markup','discount','tax','depreciation','amortization','cash flow','balance sheet','income statement','profit and loss','statement of financial position','statement of comprehensive income','statement of changes in equity','statement of cash flows','notes to financial statements','auditor report','management discussion and analysis','corporate governance','sustainability','esg','csr','diversity','equity','inclusion','belonging','wellbeing','engagement','retention','turnover','recruitment','onboarding','training','development','performance','compensation','benefits','perks','culture','values','mission','vision','strategy','goals','objectives','initiatives','programs','portfolios','projects','products','services','features','requirements','user stories','acceptance criteria','test cases','defects','bugs','issues','risks','dependencies','assumptions','constraints','stakeholders','sponsors','customers','users','partners','vendors','suppliers','contractors','consultants','advisors','board','executives','managers','team members','individual contributors','interns','contractors','freelancers','agencies','firms','companies','organizations','institutions','governments','regulators','industry groups','professional associations','accreditation bodies','standards organizations','open source communities','developer communities','user communities','customer communities','partner communities','ecosystem','platform','marketplace','network','community','forum','group','team','department','division','business unit','subsidiary','joint venture','merger','acquisition','divestiture','spin-off','ipo','funding','investment','loan','debt','equity','bond','stock','option','warrant','derivative','future','forward','swap','cap','floor','collar','straddle','strangle','butterfly','condor','iron condor','box','jade lizard','broken wing','christmas tree','diagonal','calendar','vertical','horizontal','covered call','protective put','cash-secured put','naked call','naked put','ratio spread','backspread','ladder','guts','straddle','strangle','synthetic long','synthetic short','synthetic call','synthetic put','conversion','reversal','box spread','butterfly spread','condor spread','iron butterfly','iron condor','jade lizard','broken wing butterfly','christmas tree','diagonal spread','calendar spread','vertical spread','horizontal spread'];
          const isIrrelevant = IRRELEVANT_TAGS.some(tag => lower.includes(tag));
          return !isShorts && !isIndonesiaApi && !isIrrelevant;
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
      },
      { hedgeDelay: 1500, timeout: 8000 }
    ),
    { maxRetries: 2, baseDelay: 1000 }
  );
}

async function redditSearch(topic, maxResults = 5){
  return retry(
    () => hedge(
      async (signal) => {
        const url = `https://www.reddit.com/search.json?q=${encodeURIComponent(topic)}&sort=relevance&t=all&limit=${maxResults}`;
        const res = await httpGet(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'application/json',
          },
          signal,
        });
        if (res.status === 403) {
          console.warn('[Reddit] 403 Forbidden — Reddit may be blocking automated requests. Returning empty results.');
          return [];
        }
        if (!res.ok) throw new Error(`Reddit search ${res.status}`);
        const j = await res.json();
        return (j.data?.children || []).map((item) => ({
          id: item.data.id,
          title: item.data.title,
          subreddit: item.data.subreddit,
          selftext: item.data.selftext || '',
          score: item.data.score || 0,
          url: `https://www.reddit.com${item.data.permalink}`,
        })).filter((post) => post.title || post.selftext);
      },
      { hedgeDelay: 1500, timeout: 8000 }
    ),
    { maxRetries: 2, baseDelay: 1000 }
  );
}

async function stackOverflowSearch(topic, maxResults = 5){
  return retry(
    () => hedge(
      async (signal) => {
        const url = `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q=${encodeURIComponent(topic)}&site=stackoverflow&pagesize=${maxResults}&filter=withbody`;
        const res = await httpGet(url);
        if (!res.ok) throw new Error(`StackOverflow search ${res.status}`);
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
      },
      { hedgeDelay: 1500, timeout: 8000 }
    ),
    { maxRetries: 2, baseDelay: 1000 }
  );
}

async function hackerNewsSearch(topic, maxResults = 5){
  return retry(
    () => hedge(
      async (signal) => {
        const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(topic)}&tags=story&hitsPerPage=${maxResults}`;
        const res = await fetchWithRetry(url, { signal });
        if (!res.ok) throw new Error(`Hacker News search ${res.status}`);
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
      },
      { hedgeDelay: 1500, timeout: 8000 }
    ),
    { maxRetries: 2, baseDelay: 1000 }
  );
}

async function analyzeWebItemAndUpsert(itemKey, metadata, text, category = 'Backend'){
  const slug = itemKey.replace(/[^a-zA-Z0-9]+/g, '-').slice(0, 120);
  const baseDir = path.resolve('./artifacts', `${metadata.type || 'web'}-${slug}`);
  await fs.mkdir(baseDir, { recursive: true });
  const sourcePath = path.join(baseDir, 'source.txt');
  await fs.writeFile(sourcePath, text, 'utf8');
  const analysisMetadata = `${metadata.source || metadata.url || ''}`;
  let summary = '';
  let categoryGuess = category;
  try{
    const { analyzeText } = await import('./lib/repo_analyzer.js');
    const analysis = await analyzeText(text, metadata.type || 'web', { source: itemKey });
    if (analysis?.summary?.length) {
      summary = analysis.summary.join('\n');
      await fs.writeFile(path.join(baseDir, 'summary.txt'), summary, 'utf8');
    }
    if (['Backend','AI','DevOps','Math','Algorithms'].includes(analysis?.category)) categoryGuess = analysis.category;
  }catch(e){
    console.warn('Web item analysis failed for', itemKey, e.message||e);
  }
  const chunks = chunkText(text, 1000, 100);
  const embeddings = await embedChunksSafe(chunks);
  const docId = `${metadata.type || 'web'}:${itemKey}`;
  // Đảm bảo trích xuất chính xác vào không gian 'academic'
  await upsertDocument(docId, { url: metadata.url || metadata.link || '', project: metadata.title || metadata.name || itemKey, category: categoryGuess, space: 'academic' }, chunks, embeddings);
  return { summary, category: categoryGuess };
}

async function arxivSearch(topic, maxResults = 3){
  return retry(
    () => hedge(
      async (signal) => {
        // Tech keywords → chỉ tìm trong CS/ML categories
  const TECH_SIGNALS = ['infrastructure', 'kubernetes', 'docker', 'deployment', 'microservice',
    'devops', 'terraform', 'serverless', 'distributed', 'database', 'algorithm',
    'machine learning', 'neural', 'compiler', 'operating system', 'cloud native',
    'software engineering', 'api', 'backend', 'frontend', 'security'];
  const lowerTopic = topic.toLowerCase();
  const isTech = TECH_SIGNALS.some(s => lowerTopic.includes(s));

  let query;
  if (isTech) {
    // Chỉ tìm trong CS + ML categories
    query = encodeURIComponent(`all:${topic} AND cat:cs.*`);
  } else {
    query = encodeURIComponent(`all:${topic}`);
  }
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
  const entries = Array.from(xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)).slice(0, maxResults * 2); // lấy nhiều hơn để filter

  // Post-filter: loại bỏ papers không liên quan (vật lý, khí quyển, etc.)
  const IRRELEVANT = ['cosmic ray', 'cloud chamber', 'cern', 'particle physics', 'hadron',
    'neutrino', 'quantum chromodynamics', 'aerosol', 'meteorolog', 'climatolog',
    'atmospheric physics', 'geophysic', 'astrophysic'];

  const results = entries.map((match) => {
    const entry = match[1];
    const idMatch = entry.match(/<id>([^<]+)<\/id>/);
    const titleMatch = entry.match(/<title>([\s\S]*?)<\/title>/);
    const summaryMatch = entry.match(/<summary>([\s\S]*?)<\/summary>/);
    const publishedMatch = entry.match(/<published>([^<]+)<\/published>/);
    const authors = Array.from(entry.matchAll(/<name>([^<]+)<\/name>/g)).map((m) => m[1].trim());
    const pdfMatch = entry.match(/<link[^>]*title="pdf"[^>]*href="([^"]+)"/);
    const title = titleMatch?.[1]?.trim().replace(/\s+/g, ' ') || 'No title';
    const summary = summaryMatch?.[1]?.trim().replace(/\s+/g, ' ') || '';

    // Loại bỏ papers không liên quan (vật lý, khí quyển, etc.)
    const text = `${title} ${summary}`.toLowerCase();
    if (IRRELEVANT.some(kw => text.includes(kw))) return null;

    return {
      id: idMatch?.[1]?.trim() || 'unknown',
      title,
      summary,
      published: publishedMatch?.[1]?.trim() || '',
      authors,
      pdf_url: pdfMatch?.[1] || null,
      link: idMatch?.[1]?.trim() || null,
    };
  }).filter(Boolean).slice(0, maxResults); // filter null + limit
      },
      { hedgeDelay: 2000, timeout: 10000 }
    ),
    { maxRetries: 2, baseDelay: 2000 }
  );
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
    if (analysis?.summary) {
      summary = analysis.summary.join('\n');
      await fs.writeFile(path.resolve('./artifacts', `video-${videoId}`, 'summary.txt'), summary, 'utf8');
    }
    if (['Backend', 'AI', 'DevOps', 'Math', 'Algorithms'].includes(analysis?.category)) category = analysis.category;
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
  // ── Dedup: Kiểm tra query đã gửi trong ngày ──
  const DEDUP_FILE = './.query_dedup.json';
  async function isQuerySentToday(q) {
    try {
      const data = JSON.parse(await fs.readFile(DEDUP_FILE, 'utf8'));
      const today = new Date().toISOString().slice(0, 10);
      return data[today]?.includes(q.toLowerCase().trim());
    } catch { return false; }
  }
  async function markQuerySent(q) {
    try {
      let data = {};
      try { data = JSON.parse(await fs.readFile(DEDUP_FILE, 'utf8')); } catch {}
      const today = new Date().toISOString().slice(0, 10);
      if (!data[today]) data[today] = [];
      data[today].push(q.toLowerCase().trim());
      await fs.writeFile(DEDUP_FILE, JSON.stringify(data, null, 2), 'utf8');
    } catch { /* ignore */ }
  }

  // ── Chọn topic: ưu tiên từ env/args, nếu không thì pick unique từ history ──
  let chosenTopic;
  if (topic && String(topic).trim()) {
    chosenTopic = String(topic).trim();
  } else {
    try {
      chosenTopic = await pickUniqueTopic();
    } catch {
      chosenTopic = DEV_TOPICS[Math.floor(Math.random() * DEV_TOPICS.length)];
    }
  }
  if(!topic || !String(topic).trim()){
    console.log('No topic argument provided. Selected random topic:', chosenTopic);
  }

  // ── Lưu topic vào history ──
  await saveTopicHistory(chosenTopic);

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
    return retry(
      () => hedge(
        async (signal) => {
          try {
            const tavilyKey = process.env.TAVILY_API_KEY;
            if (!tavilyKey) {
              console.log('[search] Facebook/Tavily: No TAVILY_API_KEY, skipping');
              return [];
            }
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
        },
        { hedgeDelay: 1500, timeout: 8000 }
      ),
      { maxRetries: 2, baseDelay: 1000 }
    );
  }

  // // ── Google Custom Search (broad web search, up to 10 results per query) ──
  // async function googleSearch(topic, maxResults = 10) {
  //   const apiKey = process.env.GOOGLE_SEARCH_API_KEY;
  //   const cx = process.env.GOOGLE_CSE_ID || process.env.GOOGLE_CX || '';
  //   if (!apiKey || !cx) {
  //     console.log('[search] Google: No GOOGLE_SEARCH_API_KEY or GOOGLE_CSE_ID, skipping');
  //     return [];
  //   }
  //   try {
  //     const url = `https://customsearch.googleapis.com/customsearch/v1?key=${apiKey}&cx=${encodeURIComponent(cx)}&q=${encodeURIComponent(topic)}&num=${maxResults}`;
  //     const res = await fetchWithRetry(url);
  //     if (!res.ok) throw new Error(`Google search ${res.status}`);
  //     const data = await res.json();
  //     return (data.items || []).map(r => ({
  //       id: r.link,
  //       title: r.title || 'Web Result',
  //       url: r.link,
  //       snippet: r.snippet?.slice(0, 300) || '',
  //       score: 0.5,
  //       source: 'google',
  //     }));
  //   } catch (err) {
  //     console.warn('[search] Google failed:', err.message);
  //     return [];
  //   }
  // }

  // ── Tier 3: Circuit Breaker (inline, circuit_breaker.js removed) ──
  const getBreaker = () => ({ execute: (fn) => fn(), getState: () => 'CLOSED' });
  const withBreaker = (name, fn, fallback = []) => {
    const breaker = getBreaker(name, {
      failureThreshold: 3,
      resetTimeout: 60000,
      fallback: () => fallback,
    });
    return breaker.execute(fn);
  };

  const searchResults = await Promise.allSettled([
    withBreaker('github', () => githubSearch(chosenTopic)),
    withBreaker('youtube', () => youtubeSearchVideos(chosenTopic)),
    withBreaker('arxiv', () => arxivSearch(chosenTopic)),
    withBreaker('reddit', () => redditSearch(chosenTopic)),
    withBreaker('stackoverflow', () => stackOverflowSearch(chosenTopic)),
    withBreaker('hackernews', () => hackerNewsSearch(chosenTopic)),
    withBreaker('tavily', () => facebookWebSearch(chosenTopic)),
  ]);

  const repos = searchResults[0]?.status === 'fulfilled' ? (searchResults[0].value || []) : [];
  const videos = searchResults[1]?.status === 'fulfilled' ? (searchResults[1].value || []) : [];
  const papers = searchResults[2]?.status === 'fulfilled' ? (searchResults[2].value || []) : [];
  const reddits = searchResults[3]?.status === 'fulfilled' ? (searchResults[3].value || []) : [];
  const stackoverflow = searchResults[4]?.status === 'fulfilled' ? (searchResults[4].value || []) : [];
  const hackerNews = searchResults[5]?.status === 'fulfilled' ? (searchResults[5].value || []) : [];
  const facebookPosts = searchResults[6]?.status === 'fulfilled' ? (searchResults[6].value || []) : [];

  // Detailed logging for debugging
  const sourceSummary = [
    { name: 'GitHub', count: repos?.length || 0, failed: searchResults[0]?.status === 'rejected', error: searchResults[0]?.reason?.message },
    { name: 'YouTube', count: videos?.length || 0, failed: searchResults[1]?.status === 'rejected', error: searchResults[1]?.reason?.message },
    { name: 'arXiv', count: papers?.length || 0, failed: searchResults[2]?.status === 'rejected', error: searchResults[2]?.reason?.message },
    { name: 'Reddit', count: reddits?.length || 0, failed: searchResults[3]?.status === 'rejected', error: searchResults[3]?.reason?.message },
    { name: 'StackOverflow', count: stackoverflow?.length || 0, failed: searchResults[4]?.status === 'rejected', error: searchResults[4]?.reason?.message },
    { name: 'HackerNews', count: hackerNews?.length || 0, failed: searchResults[5]?.status === 'rejected', error: searchResults[5]?.reason?.message },
    { name: 'Facebook/Tavily', count: facebookPosts?.length || 0, failed: searchResults[6]?.status === 'rejected', error: searchResults[6]?.reason?.message },
  ];
  for (const s of sourceSummary) {
    if (s.failed) console.warn(`[search] ❌ ${s.name} FAILED: ${s.error}`);
    else if (s.count === 0) console.log(`[search] ⚠ ${s.name}: 0 results`);
    else console.log(`[search] ✓ ${s.name}: ${s.count} results`);
  }
  console.log(`[search] Total: ${repos?.length || 0} repos, ${videos?.length || 0} videos, ${papers?.length || 0} papers, ${reddits?.length || 0} reddits, ${stackoverflow?.length || 0} SO, ${hackerNews?.length || 0} HN, ${facebookPosts?.length || 0} FB`);

  // ═══════════════════════════════════════════════════════════════
  // AGGREGATION: Thu thập tất cả results vào 1 mảng
  // ═══════════════════════════════════════════════════════════════
  const allResults = [];

  for(const r of repos){
    const owner = r.owner.login; const name = r.name;
    const id = `repo::${r.full_name}`;
    const hash = String(r.stargazers_count);
    const { exists, needsUpdate } = await checkSourceStatus(id, hash);
    if(!isForce && exists && !needsUpdate){
      console.log('Skipped unchanged repo', r.full_name, '⭐', r.stargazers_count);
      continue;
    }
    if(exists && needsUpdate){
      console.log('Updating repo', r.full_name, '⭐', r.stargazers_count, '(stars changed)');
    }
    if(isForce && exists){
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
    const hash = String(video.viewCount);
    const { exists, needsUpdate } = await checkSourceStatus(id, hash);
    if(!isForce && exists && !needsUpdate){
      console.log('Skipped unchanged video', video.title, '👁', video.viewCount);
      continue;
    }
    if(exists && needsUpdate){
      console.log('Updating video', video.title, '👁', video.viewCount, '(views changed)');
    }
    if(isForce && exists){
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
    const hash = String(post.score || 0);
    const { exists, needsUpdate } = await checkSourceStatus(id, hash);
    if(!isForce && exists && !needsUpdate){
      console.log('Skipped unchanged Reddit post', post.title);
      continue;
    }
    if(exists && needsUpdate){
      console.log('Updating Reddit post', post.title, '(score changed)');
    }
    if(isForce && exists){
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
    const hash = String(question.score || 0);
    const { exists, needsUpdate } = await checkSourceStatus(id, hash);
    if(!isForce && exists && !needsUpdate){
      console.log('Skipped unchanged StackOverflow question', question.title);
      continue;
    }
    if(exists && needsUpdate){
      console.log('Updating StackOverflow question', question.title, '(score changed)');
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
    const hash = String(story.points || 0);
    const { exists, needsUpdate } = await checkSourceStatus(id, hash);
    if(!isForce && exists && !needsUpdate){
      console.log('Skipped unchanged Hacker News story', story.title);
      continue;
    }
    if(exists && needsUpdate){
      console.log('Updating Hacker News story', story.title, '(points changed)');
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
    const hash = post.snippet?.slice(0, 100) || '';
    const { exists, needsUpdate } = await checkSourceStatus(id, hash);
    if(!isForce && exists && !needsUpdate){
      console.log('Skipped unchanged Facebook post', post.title);
      continue;
    }
    if(exists && needsUpdate){
      console.log('Updating Facebook post', post.title);
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
    const hash = paper.published || '';
    const { exists, needsUpdate } = await checkSourceStatus(id, hash);
    if(!isForce && exists && !needsUpdate){
      console.log('Skipped unchanged arXiv paper', paper.id);
      continue;
    }
    if(exists && needsUpdate){
      console.log('Updating arXiv paper', paper.id);
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

      // ── Dedup: Loại bỏ sources đã có trong DB (theo URL) ──
      const freshResults = [];
      for (const r of allResults) {
        const url = r.url || r.link || '';
        if (url && await isProcessed(`url:${url.slice(0, 100)}`)) {
          continue; // Skip sources đã có
        }
        freshResults.push(r);
        // Mark as processed
        if (url) await markProcessed({ id: `url:${url.slice(0, 100)}`, type: 'source', url, hash: '' });
      }

      console.log(`[Pipeline] ${freshResults.length}/${allResults?.length || 0} fresh sources (deduped ${(allResults?.length || 0) - freshResults.length})`);

      if (freshResults.length > 0) {
        // Có source mới → gửi thông báo
        await sendAggregatedWebhook({
          topic: chosenTopic,
          results: freshResults,
          bullets: `${freshResults.length} sources found across YouTube, GitHub, StackOverflow, HackerNews, arXiv, Facebook`,
        });
        console.log(`[Webhook] ✓ Sent aggregated embed with ${freshResults.length} sources`);
      } else {
        // ── Fallback: Không có source mới → lấy cũ nhất từ DB phù hợp query ──
        console.log('[Pipeline] No new sources — fetching oldest from DB for query:', chosenTopic);
        try {
          const { getSourcesByQuery } = await import('./lib/vector_store.js');
          const cachedSources = await getSourcesByQuery(chosenTopic, 10);
          if (cachedSources.length > 0) {
            const fallbackResults = cachedSources.map(s => ({
              title: s.project || s.doc_id || 'Cached Source',
              url: s.url || '',
              type: 'cached',
              score: 0.5,
              category: s.category || 'Backend',
            }));
            await sendAggregatedWebhook({
              topic: chosenTopic + ' (Cached — No new sources)',
              results: fallbackResults,
              bullets: fallbackResults.length + ' sources từ cache (oldest first)',
              isError: false,
            });
            console.log('[Webhook] ✓ Sent ' + fallbackResults.length + ' cached sources from DB');
          } else {
            console.log('[Pipeline] No cached sources found either');
          }
        } catch (cacheErr) {
          console.warn('[Pipeline] Cache fallback failed:', cacheErr.message);
        }
      }
      if ((allResults?.length || 0) > 0 && freshResults.length === 0) {
        // Không có source → gửi thông báo server status (để biết pipeline đã chạy)
        const errorSources = [];
        if (repos.length === 0) errorSources.push('GitHub');
        if (videos.length === 0) errorSources.push('YouTube');
        if (reddits.length === 0) errorSources.push('Reddit');
        if (stackoverflow.length === 0) errorSources.push('StackOverflow');
        if (hackerNews.length === 0) errorSources.push('HackerNews');
        if (papers.length === 0) errorSources.push('arXiv');
        if (facebookPosts.length === 0) errorSources.push('Facebook/Tavily');

        // ── Fallback 1: Lấy sources cũ từ database (oldest → newest) ──
        console.log('[Pipeline] Search APIs failed — fetching cached sources from database...');
        try {
          const { getSourcesByDate } = await import('./lib/vector_store.js');
          const cachedSources = await getSourcesByDate('academic', 10, 'asc');

          if (cachedSources.length > 0) {
            console.log(`[Pipeline] Found ${cachedSources.length} cached sources (oldest → newest)`);
            const fallbackResults = cachedSources.map(s => ({
              title: s.project || s.doc_id || 'Cached Source',
              url: s.url || '',
              type: 'cached',
              score: 0.5,
              category: s.category || 'Backend',
            }));

            await sendAggregatedWebhook({
              topic: `${chosenTopic} (Cached — Search APIs unavailable)`,
              results: fallbackResults,
              bullets: `📦 ${cachedSources.length} sources từ cache (oldest → newest)`,
              isError: false,
            });
            console.log('[Webhook] ✓ Sent cached sources from database');
          } else {
            throw new Error('No cached sources in database');
          }
        } catch (cacheErr) {
          // ── Fallback 2: LLM generate từ knowledge base ──
          console.log('[Pipeline] No cached sources — generating from knowledge base...');
          try {
            const { ask: llmAsk } = await import('./lib/llm.js');
            const fallbackReport = await llmAsk(
              `Hãy tạo một báo tổng hợp về chủ đề "${chosenTopic}" dựa trên kiến thức của bạn. Bao gồm: 1) Tổng quan chủ đề, 2) Các khái niệm quan trọng, 3) Best practices, 4) Tài liệu tham khảo gợi ý. Trả lời bằng tiếng Việt, định dạng Markdown.`,
              { maxTokens: 2000, temperature: 0.3 }
            );

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
            // ── Fallback 3: Error notification ──
            await sendAggregatedWebhook({
              topic: chosenTopic,
              results: [],
              bullets: '',
              isError: true,
              errorMessage: `All search APIs failed (${errorSources.join(', ')}). Cache: ${cacheErr.message}. LLM: ${llmErr?.message || 'unknown'}`,
            });
            console.log('[Webhook] ⚠️ Sent error notification — all fallbacks failed');
          }
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

run(topicArg, isForce).catch(e=>{ console.error('Pipeline error:', e.message||e); console.error(e.stack); process.exit(1); });