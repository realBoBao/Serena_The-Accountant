/**
 * scripts/test_webhook.js — Test Discord webhook notification
 * Gửi test message đến Discord mà không cần đợi cron schedule.
 *
 * Usage:
 *   node scripts/test_webhook.js
 *
 * Yêu cầu: DISCORD_WEBHOOK trong .env
 */

import 'dotenv/config';
import { sendAggregatedWebhook } from '../notify_discord.js';

const testResults = [
  { title: 'Rust Async Runtime Deep Dive', url: 'https://github.com/tokio-rs/tokio', type: 'repo', score: 0.95, category: 'Backend' },
  { title: 'Understanding Zero-Cost Abstractions', url: 'https://www.youtube.com/watch?v=abc123', type: 'video', score: 0.88, category: 'Algorithms' },
  { title: 'Why Rust is the Future of Systems Programming', url: 'https://stackoverflow.com/q/12345', type: 'stackoverflow', score: 0.82, category: 'Backend' },
  { title: 'LLM Inference Optimization Techniques', url: 'https://arxiv.org/abs/2401.12345', type: 'arxiv', score: 0.76, category: 'AI' },
  { title: 'The State of WebAssembly in 2026', url: 'https://news.ycombinator.com/item?id=12345', type: 'hackernews', score: 0.71, category: 'DevOps' },
  { title: 'Microservices vs Monolith: A Data-Driven Analysis', url: 'https://reddit.com/r/programming/comments/abc', type: 'reddit', score: 0.65, category: 'Backend' },
];

const testBullets = [
  '📌 Rust async/await giảm 40% latency so với thread-per-request',
  '📌 Zero-cost abstraction = không overhead runtime',
  '📌 LLM inference có thể optimize qua KV-cache + quantization',
];

console.log('[TestWebhook] Sending test notification to Discord...');
console.log(`[TestWebhook] Webhook URL: ${process.env.DISCORD_WEBHOOK ? '✅ Set' : '❌ NOT SET'}`);
console.log(`[TestWebhook] Results: ${testResults.length} items`);

try {
  await sendAggregatedWebhook({
    topic: `🧪 TEST — ${new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}`,
    results: testResults,
    bullets: testBullets,
  });
  console.log('[TestWebhook] ✅ Sent successfully! Check Discord.');
} catch (err) {
  console.error('[TestWebhook] ❌ Failed:', err.message);
  process.exit(1);
}
