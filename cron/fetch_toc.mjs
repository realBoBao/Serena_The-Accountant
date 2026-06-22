/**
 * scripts/fetch_toc.mjs — Fetch README TOC from 3 repos for Lazy Knowledge Pointers
 * Run: node scripts/fetch_toc.mjs
 */
const repos = [
  { name: 'awesome-scalability', url: 'https://raw.githubusercontent.com/binhnguyennus/awesome-scalability/master/README.md' },
  { name: 'TeachYourselfCS-vi', url: 'https://raw.githubusercontent.com/htdat/TeachYourselfCS-vi/main/README.md' },
  { name: 'the-book-of-secret-knowledge', url: 'https://raw.githubusercontent.com/trimstray/the-book-of-secret-knowledge/master/README.md' },
];

for (const repo of repos) {
  try {
    const res = await fetch(repo.url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) { console.log(repo.name + ': HTTP ' + res.status); continue; }
    const md = await res.text();

    // Extract headings and list items with links
    const lines = md.split('\n');
    const toc = [];
    for (const line of lines) {
      const trimmed = line.trim();
      // Headings: ## Heading
      const headingMatch = trimmed.match(/^#{1,3}\s+(.+)/);
      if (headingMatch) {
        toc.push({ type: 'heading', text: headingMatch[1], level: trimmed.match(/^#+/)[0].length });
        continue;
      }
      // List items with links: - [text](url)
      const linkMatch = trimmed.match(/^[-*]\s+\[([^\]]+)\]\(([^)]+)\)/);
      if (linkMatch) {
        toc.push({ type: 'link', text: linkMatch[1], url: linkMatch[2] });
      }
    }

    console.log(`\n=== ${repo.name} ===`);
    console.log('Total chars:', md.length, '| TOC entries:', toc.length);
    // Save to file
    const fs = await import('fs');
    fs.writeFileSync(`./data/toc_${repo.name.replace(/-/g, '_')}.json`, JSON.stringify(toc, null, 2));
    console.log('Saved to data/toc_' + repo.name.replace(/-/g, '_') + '.json');
    // Show first 5
    toc.slice(0, 5).forEach(t => console.log('  ' + (t.type === 'heading' ? '#'.repeat(t.level) + ' ' + t.text : '- ' + t.text + ' -> ' + t.url?.slice(0, 60))));
  } catch (err) {
    console.log(repo.name + ': ERROR -', err.message);
  }
}
