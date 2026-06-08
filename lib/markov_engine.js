import fs from 'fs/promises';
import path from 'path';

const statePath = path.resolve('./user_state.json');
const matrixPath = path.resolve('./transition_matrix.json');

async function readJson(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
}

async function writeJson(filePath, data) {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}

export async function initializeMarkovFiles() {
  const defaultState = { lastTopic: null, history: [], transitionCounts: {} };
  const defaultMatrix = {};
  const state = await readJson(statePath, defaultState);
  const matrix = await readJson(matrixPath, defaultMatrix);
  await writeJson(statePath, state);
  await writeJson(matrixPath, matrix);
  return { state, matrix };
}

function normalizeTransitionCounts(counts) {
  const matrix = {};
  for (const [from, targets] of Object.entries(counts || {})) {
    const total = Object.values(targets).reduce((sum, value) => sum + value, 0);
    matrix[from] = {};
    for (const [to, value] of Object.entries(targets)) {
      matrix[from][to] = total > 0 ? Number((value / total).toFixed(4)) : 0;
    }
  }
  return matrix;
}

export async function recordInteraction(topic) {
  if (!topic || typeof topic !== 'string' || !topic.trim()) return null;
  const normalizedTopic = topic.trim();
  const state = await readJson(statePath, { lastTopic: null, history: [], transitionCounts: {} });
  const matrix = await readJson(matrixPath, {});
  const now = new Date().toISOString();

  if (state.lastTopic) {
    state.transitionCounts[state.lastTopic] = state.transitionCounts[state.lastTopic] || {};
    state.transitionCounts[state.lastTopic][normalizedTopic] = (state.transitionCounts[state.lastTopic][normalizedTopic] || 0) + 1;
  }

  state.lastTopic = normalizedTopic;
  state.history = state.history.concat([{ topic: normalizedTopic, timestamp: now }]).slice(-100);

  const newMatrix = normalizeTransitionCounts(state.transitionCounts);

  await writeJson(statePath, state);
  await writeJson(matrixPath, newMatrix);
  return { state, matrix: newMatrix };
}

export async function getPredictedTopic() {
  const state = await readJson(statePath, { lastTopic: null, history: [], transitionCounts: {} });
  const matrix = await readJson(matrixPath, {});
  if (!state.lastTopic) {
    const counts = {};
    for (const [from, targets] of Object.entries(state.transitionCounts || {})) {
      for (const [to, value] of Object.entries(targets)) {
        counts[to] = (counts[to] || 0) + value;
      }
    }
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    return sorted.length ? sorted[0][0] : null;
  }
  const row = matrix[state.lastTopic] || {};
  const sorted = Object.entries(row).sort((a, b) => b[1] - a[1]);
  return sorted.length ? sorted[0][0] : null;
}

export async function getTransitionMatrix() {
  return await readJson(matrixPath, {});
}

export async function getUserState() {
  return await readJson(statePath, { lastTopic: null, history: [], transitionCounts: {} });
}
