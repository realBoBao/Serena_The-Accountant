import 'dotenv/config';

const key = process.env.OPENROUTER_API_KEY;
const res = await fetch('https://openrouter.ai/api/v1/models', {
  headers: { 'Authorization': 'Bearer ' + key }
});
const data = await res.json();
const free = data.data
  .filter(m => m.pricing?.prompt === '0' || m.pricing?.completion === '0')
  .map(m => m.id);
console.log('Free models (' + free.length + '):');
free.slice(0, 20).forEach(m => console.log(' ', m));
