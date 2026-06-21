import { config } from 'dotenv';
config();
import { openDb } from './lib/sqlite_adapter.js';
import { HumanMessage } from '@langchain/core/messages';
await openDb();

const RagAgent = await import('./agents/RagAgent.js');

// Simulate synthesizeAnswer with long context
const systemInstruction = 'You are Serena_Project00, a helpful AI assistant. Answer in Vietnamese when asked in Vietnamese.';

// Build a long context like RagAgent does
let context = '';
for (let i = 0; i < 10; i++) {
  context += `[${i + 1}] test-doc-${i}: Backend programming is the server-side development. It involves databases, APIs, and server logic. Popular languages include Python, Java, Go, Node.js, and Rust. Frameworks include Django, Spring, Express, Gin, and FastAPI.\n\n`;
}

const prompt = `Use the system Context below to answer the question in natural Vietnamese with Vietnamese diacritics. If the context is not enough, clearly say that you could not find suitable data and suggest how to search or rephrase.

Context:
${context}

Question: Backend programming la gi?

Answer:`;

console.log('Prompt length:', prompt.length, 'chars');
console.log('Testing invokeLlm with long prompt...');

const start = Date.now();
try {
  const result = await RagAgent.invokeLlm(
    [new HumanMessage(systemInstruction), new HumanMessage(prompt)],
    'test-long'
  );
  console.log(`Result (${Date.now() - start}ms):`, result?.slice(0, 200) || 'NULL');
} catch (err) {
  console.log(`Error (${Date.now() - start}ms):`, err.message);
}
