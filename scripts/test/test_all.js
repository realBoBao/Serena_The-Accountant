import 'dotenv/config';

console.log('=== Serena System Test ===\n');

// 1. Test LLM
console.log('--- 1. LLM Chain ---');
try {
  const { ask } = await import('../lib/llm.js');
  const result = await ask('Xin chào, tên bạn là gì?', { maxTokens: 50, timeoutMs: 10000 });
  console.log(`✅ LLM: provider=${result.provider}, model=${result.model}`);
  console.log(`   Answer: "${result.answer.slice(0, 80)}..."`);
} catch (err) {
  console.log(`❌ LLM: ${err.message}`);
}

// 2. Test Quality Tracker
console.log('\n--- 2. Quality Tracker ---');
try {
  const { trackResponse, getQualityReport, formatQualityReport } = await import('../lib/quality_tracker.js');
  trackResponse('Test question', 'Test answer from Groq', { score: 0.8 }, 'rag', 'groq', 'backend');
  console.log('✅ trackResponse: OK');
  const report = getQualityReport(7);
  if (report) {
    console.log(`✅ getQualityReport: ${report.overview.total} records`);
    console.log(formatQualityReport(report).slice(0, 200));
  }
} catch (err) {
  console.log(`❌ Quality Tracker: ${err.message}`);
}

// 3. Test Health Check
console.log('\n--- 3. Health Check ---');
try {
  const { runHealthCheck, formatHealthMessage } = await import('../lib/health_check.js');
  const result = await runHealthCheck();
  console.log(`✅ Health check: ${result.healthy ? 'HEALTHY' : 'ISSUES'}`);
  console.log(formatHealthMessage(result));
} catch (err) {
  console.log(`❌ Health Check: ${err.message}`);
}

// 4. Test Job Scraper (just fetch, no webhook)
console.log('\n--- 4. Job Scraper ---');
try {
  const { findLatestRepo, fetchSimplifyJobs } = await import('../scripts/job_scraper.js');
  // Can't test full flow without webhook, just check import
  console.log('✅ Job scraper: imports OK');
} catch (err) {
  console.log(`❌ Job Scraper: ${err.message}`);
}

console.log('\n=== Test Complete ===');
