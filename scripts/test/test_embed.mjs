// Test localEmbedText directly
const EMBED_DIM = 768;

function localEmbedText(text) {
  const vec = new Float32Array(EMBED_DIM);
  const str = String(text || '');
  console.log('Input text length:', str.length, 'first chars:', str.slice(0, 20));
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    const idx = (code * 31 + i * 17) % EMBED_DIM;
    vec[idx] += (code % 100) / 100;
  }
  let norm = 0;
  for (let i = 0; i < EMBED_DIM; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm) || 1;
  console.log('Norm:', norm, 'non-zero count:', vec.filter(v => v !== 0).length);
  for (let i = 0; i < EMBED_DIM; i++) vec[i] /= norm;
  return vec;
}

const result = localEmbedText('microservices and distributed systems');
console.log('Result length:', result.length);
console.log('Sample:', result.slice(0, 10));
console.log('Max:', Math.max(...result));
console.log('Min:', Math.min(...result));
