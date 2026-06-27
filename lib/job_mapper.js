/**
 * lib/job_mapper.js — Data Normalization Pipeline
 * Chuẩn hóa dữ liệu từ nhiều nguồn ATS về 1 schema duy nhất
 *
 * Output schema:
 * {
 *   id: string,           // unique identifier
 *   title: string,        // job title
 *   company: string,      // company name
 *   location: string,     // remote / city / country
 *   url: string,          // apply URL
 *   source: string,       // SimplifyJobs | Greenhouse | Lever | HN | RemoteOK
 *   posted_date: string,  // ISO date
 *   salary: string,       // salary range if available
 *   tags: string[],       // tech tags
 * }
 */

function extractTags(text) {
  if (!text) return [];
  const lower = text.toLowerCase();
  const tags = [];
  const keywords = [
    'javascript', 'typescript', 'python', 'java', 'go', 'golang', 'rust',
    'react', 'vue', 'angular', 'node', 'nodejs', 'express', 'nextjs',
    'aws', 'gcp', 'azure', 'docker', 'kubernetes', 'terraform',
    'sql', 'postgresql', 'mongodb', 'redis', 'elasticsearch',
    'machine learning', 'ml', 'ai', 'deep learning',
    'backend', 'frontend', 'fullstack', 'devops', 'sre',
    'api', 'microservices', 'distributed systems',
    'security', 'cybersecurity', 'pentesting',
    'data', 'analytics', 'big data', 'spark', 'hadoop',
    'mobile', 'ios', 'android', 'react native', 'flutter',
    'blockchain', 'web3', 'solidity',
    'figma', 'design', 'ux', 'ui',
    'agile', 'scrum', 'jira',
    'ci/cd', 'jenkins', 'github actions',
    'linux', 'unix', 'bash',
  ];
  for (const kw of keywords) {
    if (lower.includes(kw)) tags.push(kw);
  }
  return [...new Set(tags)].slice(0, 10);
}

function mapSimplifyJob(raw) {
  return {
    id: `simplify:${raw.company}:${raw.role}`.replace(/\s+/g, '-').toLowerCase(),
    title: raw.role || 'Unknown',
    company: raw.company || 'Unknown',
    location: raw.location || 'Remote',
    url: raw.link || '#',
    source: raw.source || 'SimplifyJobs',
    posted_date: new Date().toISOString(),
    salary: '',
    tags: extractTags(raw.role),
  };
}

function mapGreenhouseJob(raw) {
  return {
    id: `greenhouse:${raw.id || raw.title}`,
    title: raw.title || 'Unknown',
    company: raw.company?.name || raw.company || 'Unknown',
    location: raw.location?.name || raw.location || 'Remote',
    url: raw.absolute_url || raw.hostedUrl || raw.url || '#',
    source: 'Greenhouse',
    posted_date: raw.published_at || raw.created_at || new Date().toISOString(),
    salary: raw.salary || '',
    tags: extractTags(raw.title + ' ' + (raw.description || '')),
  };
}

function mapLeverJob(raw) {
  return {
    id: `lever:${raw.id || raw.title}`,
    title: raw.title || 'Unknown',
    company: raw.company?.name || raw.company || 'Unknown',
    location: raw.location?.name || raw.location || 'Remote',
    url: raw.applyUrl || raw.hostedUrl || raw.url || '#',
    source: 'Lever',
    posted_date: raw.publishedAt || raw.createdAt || new Date().toISOString(),
    salary: raw.salary || '',
    tags: extractTags(raw.title + ' ' + (raw.description || '')),
  };
}

function mapHNJob(raw) {
  return {
    id: `hn:${raw.id || raw.company}`,
    title: raw.role || raw.title || 'Unknown',
    company: raw.company || 'HN Company',
    location: raw.location || 'Remote',
    url: raw.link || raw.url || '#',
    source: 'HackerNews',
    posted_date: new Date().toISOString(),
    salary: '',
    tags: extractTags(raw.role + ' ' + (raw.description || '')),
  };
}

function mapRemoteOKJob(raw) {
  return {
    id: `remoteok:${raw.id || raw.company}`,
    title: raw.position || raw.title || 'Unknown',
    company: raw.company || 'Unknown',
    location: raw.location || 'Remote',
    url: raw.url || raw.apply_url || '#',
    source: 'RemoteOK',
    posted_date: raw.date || new Date().toISOString(),
    salary: raw.salary || '',
    tags: extractTags(raw.position + ' ' + (raw.description || '')),
  };
}

function mapWeWorkRemotelyJob(raw) {
  return {
    id: `wework:${raw.company}:${raw.role}`.replace(/\s+/g, '-').toLowerCase(),
    title: raw.role || raw.title || 'Unknown',
    company: raw.company || 'Unknown',
    location: 'Remote',
    url: raw.link || raw.url || '#',
    source: 'WeWorkRemotely',
    posted_date: new Date().toISOString(),
    salary: '',
    tags: extractTags(raw.role),
  };
}

function mapLinkedInJob(raw) {
  return {
    id: `linkedin:${raw.company}:${raw.title}`.replace(/\s+/g, '-').toLowerCase(),
    title: raw.title || 'Unknown',
    company: raw.company || 'Unknown',
    location: raw.location || 'Remote',
    url: raw.link || raw.url || '#',
    source: 'LinkedIn',
    posted_date: new Date().toISOString(),
    salary: '',
    tags: extractTags(raw.title),
  };
}

function mapIndeedJob(raw) {
  return {
    id: `indeed:${raw.company}:${raw.title}`.replace(/\s+/g, '-').toLowerCase(),
    title: raw.title || 'Unknown',
    company: raw.company || 'Unknown',
    location: raw.location || 'Remote',
    url: raw.link || raw.url || '#',
    source: 'Indeed',
    posted_date: new Date().toISOString(),
    salary: '',
    tags: extractTags(raw.title),
  };
}

export function mapJob(raw, source) {
  switch (source) {
    case 'SimplifyJobs':
    case 'NewGradPositions':
      return mapSimplifyJob({ ...raw, source });
    case 'Greenhouse':
      return mapGreenhouseJob(raw);
    case 'Lever':
      return mapLeverJob(raw);
    case 'HackerNews':
      return mapHNJob(raw);
    case 'RemoteOK':
      return mapRemoteOKJob(raw);
    case 'WeWorkRemotely':
      return mapWeWorkRemotelyJob(raw);
    case 'LinkedIn':
      return mapLinkedInJob(raw);
    case 'Indeed':
      return mapIndeedJob(raw);
    default:
      return {
        id: `unknown:${Date.now()}`,
        title: raw.title || raw.role || 'Unknown',
        company: raw.company || 'Unknown',
        location: raw.location || 'Remote',
        url: raw.url || raw.link || '#',
        source: source || 'Unknown',
        posted_date: raw.posted_date || new Date().toISOString(),
        salary: raw.salary || '',
        tags: raw.tags || extractTags(raw.title || ''),
      };
  }
}

export function mapJobs(rawJobs, source) {
  return rawJobs.map(j => mapJob(j, source));
}

export { extractTags };
