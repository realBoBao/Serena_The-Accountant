import 'dotenv/config';

const key = process.env.OPENROUTER_API_KEY;
const freeModels = [
  'google/gemma-3-27b-it:free',
  'qwen/qwen3-235b-a22b:free',
  'deepseek/deepseek-r1:free',
  'meta-llama/llama-4-maverick:free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'mistralai/mistral-7b-instruct:free',
  'microsoft/phi-4:free',
  'google/gemini-2.0-flash:free',
];

console.log('=== OpenRouter Free Models Test ===');
for (const model of freeModels) {
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'},
      body: JSON.stringify({model, messages: [{role:'user', content:'Say OK'}], max_tokens: 30})
    });
    const data = await res.json();
    if (res.status === 200 && data.choices) {
      console.log('OK:', model);
    } else {
      console.log('FAIL:', model, res.status, data.error?.message?.slice(0,80));
    }
  } catch(e) { console.log('ERROR:', model, e.message); }
}

console.log('\n=== Groq Test ===');
const groqKey = process.env.GROQ_API_KEY;
const groqModels = ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768'];
for (const model of groqModels) {
  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {'Authorization': 'Bearer ' + groqKey, 'Content-Type': 'application/json'},
      body: JSON.stringify({model, messages: [{role:'user', content:'Say OK'}], max_tokens: 30})
    });
    const data = await res.json();
    if (res.status === 200 && data.choices) {
      console.log('OK:', model);
    } else {
      console.log('FAIL:', model, res.status, data.error?.message?.slice(0,80));
    }
  } catch(e) { console.log('ERROR:', model, e.message); }
}

console.log('\n=== Gemini Test ===');
const geminiKey = process.env.GEMINI_API_KEY;
const geminiModels = ['gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-1.5-pro'];
for (const model of geminiModels) {
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({contents: [{parts: [{text: 'Say OK'}]}]})
    });
    const data = await res.json();
    if (res.status === 200 && data.candidates) {
      console.log('OK:', model);
    } else {
      console.log('FAIL:', model, res.status, data.error?.message?.slice(0,80));
    }
  } catch(e) { console.log('ERROR:', model, e.message); }
}
