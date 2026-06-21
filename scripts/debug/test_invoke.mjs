import { config } from 'dotenv';
config();
import { openDb } from './lib/sqlite_adapter.js';
import { HumanMessage } from '@langchain/core/messages';
await openDb();

// Import RagAgent internals
const RagAgent = await import('./agents/RagAgent.js');

// Test invokeLlm with same params as synthesizeAnswer
const systemInstruction = 'You are Serena_Project00, a helpful AI assistant. Answer in Vietnamese when asked in Vietnamese.';
const prompt = `Use the system Context below to answer the question in natural Vietnamese with Vietnamese diacritics.

Context:
Backend programming is the server-side development of web applications. It involves databases, APIs, and server logic. Popular languages include Python, Java, Go, Node.js, and Rust.

Question: Backend programming la gi?

Answer:`;

console.log('Testing invokeLlm...');
const start = Date.now();
try {
  const result = await RagAgent.invokeLlm(
    [new HumanMessage(systemInstruction), new HumanMessage(prompt)],
    'test'
  );
  console.log(`Result (${Date.now() - start}ms):`, result?.slice(0, 200));
} catch (err) {
  console.log(`Error (${Date.now() - start}ms):`, err.message);
}
