/**
 * scripts/test_catchup.mjs — Test catch-up logic
 */
import { readJsonSafe, writeJsonAtomic } from '../lib/atomic_write.js';

const CATCH_UP_FILE = './.scheduler_last_run.json';

// Test 1: Pipeline ran 5 hours ago (within 12h threshold → skip)
console.log('── Test 1: Pipeline 5h ago ──');
await writeJsonAtomic(CATCH_UP_FILE, {
  pipeline: { ts: new Date(Date.now() - 5 * 3600000).toISOString(), status: 'done' }
});
let runs = await readJsonSafe(CATCH_UP_FILE, {});
let h = (Date.now() - new Date(runs.pipeline.ts).getTime()) / 3600000;
console.log(`Hours: ${h.toFixed(1)} → catch-up? ${h > 12}`);

// Test 2: Pipeline ran 15 hours ago (exceeds 12h → run catch-up)
console.log('\n── Test 2: Pipeline 15h ago ──');
await writeJsonAtomic(CATCH_UP_FILE, {
  pipeline: { ts: new Date(Date.now() - 15 * 3600000).toISOString(), status: 'done' }
});
runs = await readJsonSafe(CATCH_UP_FILE, {});
h = (Date.now() - new Date(runs.pipeline.ts).getTime()) / 3600000;
console.log(`Hours: ${h.toFixed(1)} → catch-up? ${h > 12}`);

// Test 3: Pipeline never run (null → run catch-up)
console.log('\n── Test 3: Pipeline never run ──');
await writeJsonAtomic(CATCH_UP_FILE, {});
runs = await readJsonSafe(CATCH_UP_FILE, {});
const last = runs.pipeline?.ts ? new Date(runs.pipeline.ts) : null;
console.log(`Last run: ${last} → catch-up? ${!last}`);

console.log('\n✅ Catch-up logic test complete');
