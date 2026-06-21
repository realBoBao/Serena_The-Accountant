import 'dotenv/config';

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const HEADERS = { 'User-Agent': 'Serena/1.0' };
if (GITHUB_TOKEN) HEADERS['Authorization'] = `token ${GITHUB_TOKEN}`;

async function main() {
  // 1. Get download URL
  const meta = await fetch(
    'https://api.github.com/repos/SimplifyJobs/Summer2026-Internships/contents/.github/scripts/listings.json',
    { HEADERS }
  ).then(r => r.json());

  console.log('download_url:', meta.download_url);
  console.log('size:', meta.size, 'bytes');

  // 2. Fetch first 5000 chars to see structure
  const raw = await fetch(meta.download_url).then(r => r.text());
  console.log('\n--- First 3000 chars ---');
  console.log(raw.slice(0, 3000));
}

main().catch(e => { console.error(e.message); process.exit(1); });
