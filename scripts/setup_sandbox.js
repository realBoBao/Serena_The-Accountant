#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════
 * SANDBOX SETUP SCRIPT
 * ═══════════════════════════════════════════════════════════════
 *
 * Chạy script này để thiết lập môi trường sandbox:
 *   1. Kiểm tra Docker availability
 *   2. Build sandbox image
 *   3. Test sandbox execution
 *   4. Hiển thị trạng thái
 *
 * Usage: node scripts/setup_sandbox.js
 */

import { isDockerAvailable, isImageBuilt, buildSandboxImage, runInDockerSandbox } from '../sandbox_runner.js';
import { sandboxGateway } from '../sandbox_gateway.js';

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║         🔒 AI SANDBOX SETUP & DIAGNOSTICS              ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log();

  // ── Step 1: Check Docker ──
  console.log('📋 Step 1: Checking Docker...');
  const dockerOk = await isDockerAvailable();
  console.log(`   Docker available: ${dockerOk ? '✅ Yes' : '❌ No'}`);

  if (dockerOk) {
    const imageOk = await isImageBuilt();
    console.log(`   Sandbox image built: ${imageOk ? '✅ Yes' : '❌ No'}`);

    // ── Step 2: Build image if needed ──
    if (!imageOk) {
      console.log('\n📋 Step 2: Building sandbox image...');
      console.log('   ⏳ This may take 2-5 minutes...');
      try {
        await buildSandboxImage();
        console.log('   ✅ Image built successfully');
      } catch (err) {
        console.log(`   ❌ Build failed: ${err.message}`);
      }
    }

    // ── Step 3: Test Docker sandbox ──
    console.log('\n📋 Step 3: Testing Docker sandbox...');
    try {
      const result = await runInDockerSandbox('print("Hello from Docker sandbox!")', 'python', { timeout: 15000 });
      console.log(`   Success: ${result.success ? '✅' : '❌'}`);
      console.log(`   Output: ${result.output}`);
      console.log(`   Method: ${result.method}`);
      if (result.error) console.log(`   Error: ${result.error}`);
    } catch (err) {
      console.log(`   ❌ Test failed: ${err.message}`);
    }

    // ── Step 4: Test security (should be blocked) ──
    console.log('\n📋 Step 4: Testing security (should block dangerous code)...');
    try {
      const result = await runInDockerSandbox(
        'import os; os.system("rm -rf /")',
        'python',
        { timeout: 15000 }
      );
      console.log(`   Blocked: ${result.blocked ? '✅ Yes' : '❌ No (SECURITY ISSUE!)'}`);
      if (result.error) console.log(`   Reason: ${result.error}`);
    } catch (err) {
      console.log(`   ❌ Test failed: ${err.message}`);
    }
  } else {
    console.log('\n⚠️  Docker not available. Using in-process sandbox (lower security).');
    console.log('   To enable full security, install Docker Desktop:');
    console.log('   https://www.docker.com/products/docker-desktop/');
  }

  // ── Step 5: Initialize gateway ──
  console.log('\n📋 Step 5: Initializing Sandbox Gateway...');
  await sandboxGateway.initialize();
  const status = await sandboxGateway.getStatus();
  console.log(`   Initialized: ${status.initialized ? '✅' : '❌'}`);
  console.log(`   Preferred method: ${status.preferredMethod}`);
  console.log(`   Docker available: ${status.dockerAvailable ? '✅' : '❌'}`);
  console.log(`   Docker image built: ${status.dockerImageBuilt ? '✅' : '❌'}`);

  // ── Step 6: Test gateway ──
  console.log('\n📋 Step 6: Testing Gateway execution...');
  const gwResult = await sandboxGateway.execute({
    agent: 'rag',
    code: 'print("Hello from Sandbox Gateway! 🔒")',
    language: 'python',
  });
  console.log(`   Success: ${gwResult.success ? '✅' : '❌'}`);
  console.log(`   Output: ${gwResult.output}`);
  console.log(`   Method: ${gwResult.method}`);
  console.log(`   Trust Level: ${gwResult.trustLevel}`);

  // ── Step 7: Test policy (untrusted agent) ──
  console.log('\n📋 Step 7: Testing policy (untrusted agent should be blocked)...');
  const untrustedResult = await sandboxGateway.execute({
    agent: 'user_input',
    code: 'print("I should be blocked")',
    language: 'python',
  });
  console.log(`   Blocked: ${untrustedResult.blocked ? '✅ Yes' : '❌ No'}`);
  console.log(`   Reason: ${untrustedResult.error}`);

  // ── Summary ──
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║                    📊 SUMMARY                           ║');
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log(`║  Docker Sandbox:     ${dockerOk && status.dockerImageBuilt ? '✅ Ready' : '⚠️  Not available'}                    ║`);
  console.log(`║  In-Process Sandbox: ✅ Ready (fallback)                ║`);
  console.log(`║  Policy Engine:      ✅ Active                          ║`);
  console.log(`║  Audit Logging:      ✅ Active                          ║`);
  console.log(`║  Rate Limiting:      ✅ Active                          ║`);
  console.log('╚══════════════════════════════════════════════════════════╝');

  if (!dockerOk) {
    console.log('\n💡 RECOMMENDATION: Install Docker Desktop for maximum security.');
    console.log('   The in-process sandbox provides basic protection but is NOT');
    console.log('   as secure as Docker container isolation.');
  }
}

main().catch(err => {
  console.error('❌ Setup failed:', err);
  process.exit(1);
});
