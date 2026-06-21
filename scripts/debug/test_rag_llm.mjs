import { config } from 'dotenv';
config();
import { ask } from './lib/llm.js';

// Test 1: Query đơn giản
console.log('=== Test 1: Query đơn giản ===');
const r1 = await ask('Backend programming là gì?', {
  systemPrompt: 'Bạn là Serena, trợ lý AI. Trả lời ngắn gọn trong 2-3 câu.',
  temperature: 0.2,
  maxTokens: 512,
});
console.log('Provider:', r1.provider, '| Model:', r1.model);
console.log('Answer:', r1.answer?.slice(0, 200));

// Test 2: Query với context dài (như RagAgent)
console.log('\n=== Test 2: Query với context dài ===');
const longContext = `
## Knowledge Base Context:
- Backend programming: server-side development, APIs, databases
- Languages: Python, Java, Go, Node.js, Rust
- Frameworks: Django, Spring, Express, Gin, FastAPI
- Databases: PostgreSQL, MongoDB, Redis
- DevOps: Docker, Kubernetes, CI/CD

## User Question:
Backend programming là gì? Những ngôn ngữ và framework phổ biến nhất?

## Instructions:
Trả lời bằng tiếng Việt, ngắn gọn trong 2-3 câu.`;
const r2 = await ask(longContext, {
  systemPrompt: 'Bạn là Serena, trợ lý AI chuyên về lập trình.',
  temperature: 0.2,
  maxTokens: 512,
});
console.log('Provider:', r2.provider, '| Model:', r2.model);
console.log('Answer:', r2.answer?.slice(0, 200));

// Test 3: Query thực tế từ user
console.log('\n=== Test 3: Query thực tế ===');
const r3 = await ask('Backend open source projects cho beginner?', {
  systemPrompt: 'Bạn là Serena, trợ lý AI. Gợi ý 3-5 dự án backend open source cho beginner. Trả lời bằng tiếng Việt.',
  temperature: 0.3,
  maxTokens: 512,
});
console.log('Provider:', r3.provider, '| Model:', r3.model);
console.log('Answer:', r3.answer?.slice(0, 300));
