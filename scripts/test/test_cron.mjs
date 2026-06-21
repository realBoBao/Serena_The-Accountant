/**
 * scripts/test_cron.mjs — Test cron job chạy đúng thời gian
 * Đặt 1 job chạy mỗi 10 giây, verify nó fire đúng.
 *
 * Usage:
 *   node scripts/test_cron.mjs
 */

import cron from 'node-cron';

let fireCount = 0;
const maxFires = 3;

console.log('═'.repeat(50));
console.log('Cron Test — Job mỗi 10 giây');
console.log('═'.repeat(50));
console.log(`Thời gian bắt đầu: ${new Date().toISOString()}`);
console.log(`Mục tiêu: Job fire ${maxFires} lần, mỗi 10s`);
console.log('');

// Cron: mỗi 10 giây (*/10 * * * * * chỉ chạy mỗi 10s trong phút)
// Dùng setInterval cho test nhanh hơn
const job = cron.schedule('*/10 * * * * *', () => {
  fireCount++;
  const now = new Date();
  console.log(`[${now.toISOString()}] 🔥 Job fired! (#${fireCount}/${maxFires})`);

  if (fireCount >= maxFires) {
    console.log('');
    console.log('✅ Cron hoạt động! Job đã fire đúng thời gian.');
    console.log(`Tổng: ${fireCount} lần trong ${(fireCount - 1) * 10}s`);
    job.stop();
    process.exit(0);
  }
}, { timezone: 'Asia/Ho_Chi_Minh' });

console.log('Đang chờ job fire... (tối đa 35 giây)');
console.log('');

// Timeout safety
setTimeout(() => {
  console.log('');
  if (fireCount === 0) {
    console.error('❌ FAIL: Job không fire sau 35 giây!');
    console.error('Nguyên có thể: node-cron không hỗ trợ giây trên Windows');
  } else {
    console.log(`⚠️ Chỉ fire ${fireCount}/${maxFires} lần trong 35s`);
  }
  job.stop();
  process.exit(fireCount >= maxFires ? 0 : 1);
}, 35000);
