import 'dotenv/config';
import { sendAggregatedWebhook } from '../notify_discord.js';

const topic = 'microservices and distributed systems';
const mockResults = [
  { title: 'Transactions across REST microservices?', url: 'https://stackoverflow.com/questions/30213456', type: 'so', score: 0.96 },
  { title: 'System Design One Shot Full Course', url: 'https://youtu.be/Vnm-ycSfJx4', type: 'video', score: 0.88 },
];

console.log('=== Test 1: First send ===');
const r1 = await sendAggregatedWebhook({ topic, results: mockResults });
console.log('Result:', r1);

console.log('\n=== Test 2: Same topic within 24h (should skip) ===');
const r2 = await sendAggregatedWebhook({ topic, results: mockResults });
console.log('Result:', r2);

console.log('\n=== Test 3: Different topic (should send) ===');
const r3 = await sendAggregatedWebhook({ topic: 'rust async programming', results: mockResults });
console.log('Result:', r3);
