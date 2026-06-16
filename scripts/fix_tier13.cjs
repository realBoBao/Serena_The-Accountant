const fs = require('fs');

// ── Tier 3: Add V8 flags to all PM2 processes ──
let eco = fs.readFileSync('ecosystem.config.cjs', 'utf8');
eco = eco.replace(/^\uFEFF/, '');

// Add node_args to each app config
const v8Flags = 'node_args: "--optimize_for_size --max-old-space-size=256",';

// Add to each app that doesn't have node_args yet
eco = eco.replace(
  /(max_memory_restart: "\d+M",)\n(\s+env:)/g,
  `$1\n      ${v8Flags}\n$2`
);

fs.writeFileSync('ecosystem.config.cjs', eco, 'utf8');
console.log('✅ Tier 3: V8 flags added to ecosystem.config.cjs');

// ── Tier 1: Create Event Bus for inter-agent communication ──
const eventBusCode = `/**
 * lib/event_bus.js — Monolithic Event Bus for inter-agent communication
 *
 * Tier 1: Chia sẻ lõi V8 Engine thay vì tách process.
 * Các Agent giao tiếp qua EventEmitter thay vì PM2 IPC hoặc HTTP.
 *
 * Usage:
 *   import { eventBus } from './event_bus.js';
 *   eventBus.emit('pipeline:complete', { topic, results });
 *   eventBus.on('pipeline:complete', (data) => { ... });
 */

import { getLogger } from './logger.js';
import EventEmitter from 'events';

const logger = getLogger('EventBus');

// Singleton EventBus — shared across all agents in same process
class EventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(50); // Allow many listeners
    this._stats = { eventsEmitted: 0, eventsHandled: 0 };
  }

  emit(event, ...args) {
    this._stats.eventsEmitted++;
    logger.debug(\`[EventBus] Emit: \${event}\`);
    return super.emit(event, ...args);
  }

  on(event, handler) {
    this._stats.eventsHandled++;
    return super.on(event, handler);
  }

  getStats() {
    return { ...this._stats, listenerCount: this.eventNames().length };
  }
}

export const eventBus = new EventBus();
export default eventBus;
`;

fs.writeFileSync('lib/event_bus.js', eventBusCode, 'utf8');
console.log('✅ Tier 1: Event Bus created at lib/event_bus.js');

// ── Update scheduler.js to emit events on task completion ──
let scheduler = fs.readFileSync('scheduler.js', 'utf8');
scheduler = scheduler.replace(/^\uFEFF/, '');

// Add eventBus import after other imports
scheduler = scheduler.replace(
  "import { writeJsonSafe, readJsonSafe, cleanupStaleTempFiles } from './lib/safe_json.js';",
  "import { writeJsonSafe, readJsonSafe, cleanupStaleTempFiles } from './lib/safe_json.js';\nimport { eventBus } from './lib/event_bus.js';"
);

// Emit event after pipeline run
scheduler = scheduler.replace(
  "await saveLastRun('pipeline');",
  "await saveLastRun('pipeline');\n      eventBus.emit('pipeline:complete', { topic: 'pipeline', ts: new Date().toISOString() });"
);

// Emit event after memory consolidation
scheduler = scheduler.replace(
  "await saveLastRun('memory');",
  "await saveLastRun('memory');\n      eventBus.emit('memory:complete', { topic: 'memory', ts: new Date().toISOString() });"
);

// Emit event after backup
scheduler = scheduler.replace(
  "await saveLastRun('backup');",
  "await saveLastRun('backup');\n      eventBus.emit('backup:complete', { topic: 'backup', ts: new Date().toISOString() });"
);

fs.writeFileSync('scheduler.js', scheduler, 'utf8');
console.log('✅ Tier 1: Event emitters added to scheduler.js');

console.log('\n🎉 Tier 1 + Tier 3 fixes applied!');
