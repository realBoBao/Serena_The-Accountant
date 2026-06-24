import { httpGet, httpScrape } from '../../lib/http_client.js';

console.log('=== Test http_client ===\n');

// Test 1: httpGet
console.log('[1] httpGet GitHub API...');
const data = await httpGet('https://api.github.com/repos/nodejs/node');
if (data && data.full_name) {
  console.log('  OK:', data.full_name, '⭐', data.stargazers_count);
} else {
  console.log('  FAIL: no data');
}

// Test 2: httpScrape
console.log('\n[2] httpScrape example.com...');
const md = await httpScrape('https://example.com', { maxLength: 500 });
if (md && md.length > 10) {
  console.log('  OK:', md.slice(0, 100));
} else {
  console.log('  FAIL: empty markdown');
}

console.log('\n=== Done ===');
