import 'dotenv/config';

const key = process.env.OPENROUTER_API_KEY;
const models = ['google/gemma-4-31b-it:free', 'qwen/qwen3-next-80b-a3b-instruct:free', 'nvidia/nemotron-3-nano-30b-a3b:free'];

for (const model of models) {
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Xin chào, tên bạn là gì?' }], max_tokens: 50 }),
    });
    const data = await res.json();
    if (res.ok && data.choices?.[0]?.message?.content) {
      console.log(`✅ ${model}: "${data.choices[0].message.content.slice(0, 60)}"`);
    } else {
      console.log(`❌ ${model} ${res.status}:`, JSON.stringify(data).slice(0, 100));
    }
  } catch (err) {
    console.log(`❌ ${model}: ${err.message}`);
  }
}
