/**
 * api_server.js — Orchestrator API Server (Tier 2: Tách Não khỏi Xác)
 *
 * Đưa Orchestrator + RouterAgent + 20 Agents lên HTTP API server.
 * Discord bot bây giờ chỉ là "dumb client" gọi HTTP thay vì import trực tiếp.
 *
 * Endpoints:
 *   POST /api/ask          — Hỏi AI (RAG + Web Search)
 *   POST /api/route       — Route intent đến agent
 *   GET  /api/health      — Health check
 *   GET  /api/agentstats  — Agent usage statistics
 *
 * Usage: node api_server.js
 */

import 'dotenv/config';
import http from 'http';
import { URL } from 'url';
import { orchestratorGuard } from './lib/orchestrator_guard.js';
import { getLogger } from './lib/logger.js';

const logger = getLogger('ApiServer');
const PORT = process.env.API_PORT || 3006;

// ── Simple HTTP router ──
const routes = {};

function register(method, path, handler) {
  const key = `${method}:${path}`;
  routes[key] = handler;
}

function matchRoute(method, pathname) {
  // Exact match first
  const exact = `${method}:${pathname}`;
  if (routes[exact]) return { handler: routes[exact], params: {} };

  // Parametric match /api/users/:id
  for (const [key, handler] of Object.entries(routes)) {
    const [m, p] = key.split(':');
    if (m !== method) continue;
    const pattern = p.replace(/:([^/]+)/g, '([^/]+)');
    const regex = new RegExp(`^${pattern}$`);
    const match = pathname.match(regex);
    if (match) {
      const paramNames = [...p.matchAll(/:([^/]+)/g)].map(m => m[1]);
      const params = {};
      paramNames.forEach((name, i) => { params[name] = match[i + 1]; });
      return { handler, params };
    }
  }

  return null;
}

// ── Request parser ──
async function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); } catch { resolve({}); }
    });
  });
}

// ── Response helper ──
function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function error(res, message, status = 500) {
  json(res, { error: message }, status);
}

// ── Routes ──

// Health check
register('GET', '/api/health', async (req, res) => {
  const health = await orchestratorGuard.healthCheck();
  json(res, {
    status: health.healthy ? 'healthy' : 'degraded',
    circuitOpen: health.circuitOpen,
    failureCount: health.failureCount,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// Agent usage stats
register('GET', '/api/agentstats', (req, res) => {
  const usage = orchestratorGuard.getAgentUsage();
  const sorted = [...usage.entries()].sort(([,a],[,b]) => b-a);
  json(res, { agents: Object.fromEntries(sorted) });
});

// Main route endpoint — nhận intent + context, trả kết quả
register('POST', '/api/route', async (req, res) => {
  try {
    const { intent, context, userId } = req.body;
    if (!intent) {
      return error(res, 'Missing intent', 400);
    }

    const result = await orchestratorGuard.routeWithGuard(intent, context || {}, userId);
    json(res, result);

  } catch (err) {
    logger.error('[API] Route error:', err.message);
    error(res, err.message);
  }
});

// Ask endpoint — shortcut cho RAG
register('POST', '/api/ask', async (req, res) => {
  try {
    const { query, userId, options = {} } = req.body;
    if (!query) {
      return error(res, 'Missing query', 400);
    }

    const result = await orchestratorGuard.routeWithGuard('RAG', {
      query,
      options,
    }, userId);

    json(res, result);

  } catch (err) {
    logger.error('[API] Ask error:', err.message);
    error(res, err.message);
  }
});

// ── Server ──
const server = http.createServer(async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const { handler, params } = matchRoute(req.method, url.pathname);

  if (!handler) {
    return error(res, 'Not found', 404);
  }

  // Attach params to req
  req.params = params;
  req.body = await parseBody(req);

  await handler(req, res);
});

server.listen(PORT, () => {
  logger.info(`[ApiServer] Running on port ${PORT}`);
  logger.info(`[ApiServer] Health check: http://localhost:${PORT}/api/health`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('[ApiServer] SIGTERM received, shutting down...');
  server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
  logger.info('[ApiServer] SIGINT received, shutting down...');
  server.close(() => process.exit(0));
});

export { server };
