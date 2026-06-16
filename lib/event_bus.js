/**
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
    logger.debug(`[EventBus] Emit: ${event}`);
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
