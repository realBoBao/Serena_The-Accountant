import 'dotenv/config';
import { ask } from '../lib/llm.js';

console.log('=== LLM Provider Test ===\n');

const testQuery = 'Xin chào, bạn tên gì?';

// Test từng provider riêng lẻ
const providers = ['groq', 'openrouter', 'gemini', 'local'];

for (const provider of providers) {
  console.log(`\n--- Testing: ${provider} ---`);
  try {
    const result = await ask(testQuery, {
      provider,
      maxTokens: 100,
      timeoutMs: 10000,
    });
    console.log(`✅ ${provider}: "${result.answer.slice(0, 80)}..."`);
    console.log(`   model: ${result.model}`);
  } catch (err) {
    console.log(`❌ ${provider}: ${err.message}`);
  }
}

// Test auto (full fallback chain)
console.log('\n--- Testing: auto (full chain) ---');
try {
  const result = await ask(testQuery, { maxTokens: 100, timeoutMs: 15000 });
  console.log(`✅ auto: "${result.answer.slice(0, 80)}..."`);
  console.log(`   provider: ${result.provider}, model: ${result.model}`);
} catch (err) {
  console.log(`❌ auto: ${err.message}`);
}
