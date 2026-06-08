export function chunkText(text, chunkSize = 1000, overlap = 100) {
  if (!text) return [];
  const chunks = [];
  let start = 0;
  const len = text.length;
  while (start < len) {
    const end = Math.min(start + chunkSize, len);
    const chunk = text.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    if (end === len) break;
    start = end - overlap;
    if (start < 0) start = 0;
  }
  return chunks;
}
