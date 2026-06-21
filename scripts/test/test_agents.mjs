/**
 * scripts/test_agents.mjs — Test all agents load correctly
 * Kiểm tra tất cả agents có import được không.
 *
 * Usage:
 *   node scripts/test_agents.mjs
 */

const agents = [
  'AnalysisAgent', 'CoderAgent', 'DebateAgent', 'EvoAgent', 'GraphAgent',
  'GraphAgentLauncher', 'IncidentAgent', 'InteractionAgent', 'ManimAgent',
  'MentorAgent', 'PdfAgent', 'PlannerAgent', 'PlannerWorker', 'RagAgent',
  'RouterAgent', 'SecurityAuditor', 'SocraticAgent', 'SuggestionAgent',
  'VisionAgent', 'VoiceAgent',
];

let ok = 0, fail = 0;
const results = [];

for (const agent of agents) {
  try {
    const mod = await import(`../agents/${agent}.js`);
    const exports = Object.keys(mod);
    ok++;
    results.push({ agent, status: 'OK', exports: exports.slice(0, 5).join(', ') });
  } catch (e) {
    fail++;
    results.push({ agent, status: 'FAIL', error: e.message.split('\n')[0] });
  }
}

console.log('═'.repeat(60));
console.log('Agent Import Test');
console.log('═'.repeat(60));

for (const r of results) {
  const icon = r.status === 'OK' ? '✅' : '❌';
  const detail = r.status === 'OK' ? `exports: ${r.exports}` : r.error;
  console.log(`${icon} ${r.agent.padEnd(20)} ${detail}`);
}

console.log('');
console.log(`Result: ${ok} OK, ${fail} FAIL out of ${agents.length} agents`);

if (fail > 0) process.exit(1);
