import 'dotenv/config';
const key = process.env.OPENROUTER_API_KEY;
const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
  method: 'POST',
  headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: 'nvidia/nemotron-3-nano-30b-a3b',
    messages: [{ role: 'user', content: 'Xin chào, tên bạn là gì? Trả lời ngắn.' }],
    max_tokens: 100,
  }),
});
const data = await res.json();
console.log(JSON.stringify(data, null, 2));
