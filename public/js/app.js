/**
 * AI Brain PWA — Mobile Companion App (Phase 18)
 * Connects to REST API for flashcards, Q&A, knowledge graph, and stats.
 * Features: Voice input, Graph visualization, Offline flashcard sync.
 */

import { KnowledgeGraphViz } from './graph_viz.js';

const API_BASE = window.location.origin;
let API_KEY = localStorage.getItem('ai_brain_api_key') || '';
let currentCard = null;
let dueCards = [];
let graphViz = null;
let recognition = null;
let db = null; // IndexedDB for offline flashcards

// ── IndexedDB for Offline Flashcards ──
const DB_NAME = 'ai_brain_offline';
const DB_VERSION = 1;
const STORE_CARDS = 'flashcards';
const STORE_QUEUE = 'syncQueue';

function openDB() {
  return new Promise((resolve, reject) => {
    if (db) { resolve(db); return; }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const database = e.target.result;
      if (!database.objectStoreNames.contains(STORE_CARDS)) {
        database.createObjectStore(STORE_CARDS, { keyPath: 'id' });
      }
      if (!database.objectStoreNames.contains(STORE_QUEUE)) {
        database.createObjectStore(STORE_QUEUE, { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = (e) => { db = e.target.result; resolve(db); };
    req.onerror = () => reject(req.error);
  });
}

async function saveCardsOffline(cards) {
  try {
    const database = await openDB();
    const tx = database.transaction(STORE_CARDS, 'readwrite');
    const store = tx.objectStore(STORE_CARDS);
    for (const card of cards) {
      store.put({ ...card, _synced: true, _cachedAt: Date.now() });
    }
    return new Promise((resolve) => { tx.oncomplete = resolve; });
  } catch { /* offline storage is best-effort */ }
}

async function getOfflineCards() {
  try {
    const database = await openDB();
    const tx = database.transaction(STORE_CARDS, 'readonly');
    const store = tx.objectStore(STORE_CARDS);
    return new Promise((resolve) => {
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    });
  } catch { return []; }
}

async function queueReviewOffline(cardId, correct) {
  try {
    const database = await openDB();
    const tx = database.transaction(STORE_QUEUE, 'readwrite');
    tx.objectStore(STORE_QUEUE).add({ cardId, correct, timestamp: Date.now() });
  } catch { /* best-effort */ }
}

async function syncPendingReviews() {
  try {
    const database = await openDB();
    const tx = database.transaction(STORE_QUEUE, 'readonly');
    const store = tx.objectStore(STORE_QUEUE);
    const pending = await new Promise((resolve) => {
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    });

    for (const item of pending) {
      const res = await api(`/api/flashcards/${item.cardId}/review`, {
        method: 'POST',
        body: JSON.stringify({ correct: item.correct }),
      });
      if (res?.ok) {
        const delTx = database.transaction(STORE_QUEUE, 'readwrite');
        delTx.objectStore(STORE_QUEUE).delete(item.id);
      }
    }
  } catch { /* will retry next time */ }
}

// ── API Helper ──
async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (API_KEY) headers['Authorization'] = `Bearer ${API_KEY}`;

  try {
    const res = await fetch(`${API_BASE}${path}`, { ...options, headers });
    if (res.status === 401) {
      const key = prompt('Nhập API Key:');
      if (key) { API_KEY = key; localStorage.setItem('ai_brain_api_key', key); return api(path, options); }
      return null;
    }
    return await res.json();
  } catch (err) {
    showToast('⚠️ Không kết nối được server');
    return null;
  }
}

// ── Toast ──
function showToast(msg, duration = 3000) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  setTimeout(() => t.classList.add('hidden'), duration);
}

// ── Tab Switching ──
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`${tab.dataset.tab}-tab`).classList.add('active');

    // Lazy load tab content
    if (tab.dataset.tab === 'flashcards') loadFlashcards();
    if (tab.dataset.tab === 'stats') loadStats();
    if (tab.dataset.tab === 'graph') loadGraphPreview();
  });
});

// ── Flashcards (with Offline Support) ──
async function loadFlashcards() {
  const data = await api('/api/flashcards/due');

  if (data?.cards) {
    // Online: use API data and cache for offline
    dueCards = data.cards;
    saveCardsOffline(dueCards);
  } else {
    // Offline: load from IndexedDB
    dueCards = await getOfflineCards();
    if (dueCards.length > 0) {
      showToast('📴 Chế độ offline — dùng dữ liệu đã lưu');
    }
  }

  document.getElementById('dueCount').textContent = dueCards.length;

  const list = document.getElementById('flashcardList');
  if (dueCards.length === 0) {
    list.innerHTML = '<div class="empty-state">🎉 Không có flashcard nào đến hạn!</div>';
    return;
  }

  list.innerHTML = dueCards.slice(0, 10).map((c, i) => `
    <div class="card" onclick="startReview(${i})">
      <div class="card-title">${escapeHtml(c.question.slice(0, 80))}</div>
      <div class="card-meta">${c.category || 'general'} · ID: ${c.id}</div>
    </div>
  `).join('');
}

function startReview(index) {
  currentCard = dueCards[index];
  document.getElementById('cardQuestion').textContent = currentCard.question;
  document.getElementById('cardAnswer').textContent = currentCard.answer;
  document.getElementById('reviewArea').classList.remove('hidden');
  document.getElementById('flashcardList').classList.add('hidden');
  document.querySelector('.flashcard-front').classList.remove('hidden');
  document.querySelector('.flashcard-back').classList.add('hidden');
}

document.getElementById('showAnswerBtn')?.addEventListener('click', () => {
  document.querySelector('.flashcard-front').classList.add('hidden');
  document.querySelector('.flashcard-back').classList.remove('hidden');
});

async function reviewCard(correct) {
  if (!currentCard) return;

  // Try online first, fall back to offline queue
  const result = await api(`/api/flashcards/${currentCard.id}/review`, {
    method: 'POST',
    body: JSON.stringify({ correct }),
  });

  if (!result?.ok) {
    // Offline: queue for later sync
    await queueReviewOffline(currentCard.id, correct);
    showToast('📴 Đã lưu offline — đồng bộ khi có mạng');
  } else {
    showToast(correct ? '✅ Đúng!' : '❌ Sai — sẽ ôn lại sau');
  }

  document.getElementById('reviewArea').classList.add('hidden');
  document.getElementById('flashcardList').classList.remove('hidden');
  loadFlashcards();
}

document.getElementById('correctBtn')?.addEventListener('click', () => reviewCard(true));
document.getElementById('wrongBtn')?.addEventListener('click', () => reviewCard(false));
document.getElementById('hardBtn')?.addEventListener('click', () => reviewCard(true));

// ── Voice Input (Phase 18) ──
function initVoiceInput() {
  const voiceBtn = document.getElementById('voiceInputBtn');
  const voiceStatus = document.getElementById('voiceStatus');
  const askInput = document.getElementById('askInput');

  if (!voiceBtn) return;

  // Check for Web Speech API support
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    voiceBtn.style.display = 'none';
    return;
  }

  recognition = new SpeechRecognition();
  recognition.lang = 'vi-VN';
  recognition.continuous = false;
  recognition.interimResults = true;

  let isListening = false;

  voiceBtn.addEventListener('click', () => {
    if (isListening) {
      recognition.stop();
      return;
    }

    try {
      recognition.start();
      isListening = true;
      voiceBtn.textContent = '⏹️';
      voiceBtn.classList.add('listening');
      voiceStatus?.classList.remove('hidden');
      voiceStatus.textContent = '🎤 Đang nghe...';
    } catch (err) {
      showToast('⚠️ Không thể truy cập microphone');
    }
  });

  recognition.onresult = (event) => {
    let transcript = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      transcript += event.results[i][0].transcript;
    }

    if (event.results[event.results.length - 1].isFinal) {
      askInput.value = transcript;
      voiceStatus.textContent = '✅ Đã ghi nhận: "' + transcript.slice(0, 40) + '"';
      // Auto-submit after a short delay
      setTimeout(() => {
        document.getElementById('askBtn')?.click();
      }, 800);
    } else {
      voiceStatus.textContent = '🎤 Đang nghe: "' + transcript.slice(0, 40) + '..."';
    }
  };

  recognition.onerror = (event) => {
    isListening = false;
    voiceBtn.textContent = '🎤';
    voiceBtn.classList.remove('listening');
    voiceStatus?.classList.add('hidden');
    if (event.error !== 'no-speech') {
      showToast('⚠️ Lỗi nhận diện giọng nói: ' + event.error);
    }
  };

  recognition.onend = () => {
    isListening = false;
    voiceBtn.textContent = '🎤';
    voiceBtn.classList.remove('listening');
    setTimeout(() => voiceStatus?.classList.add('hidden'), 3000);
  };
}

// ── Ask AI ──
document.getElementById('askBtn')?.addEventListener('click', async () => {
  const input = document.getElementById('askInput');
  const query = input.value.trim();
  if (!query) return;

  const btn = document.getElementById('askBtn');
  btn.textContent = 'Đang suy nghĩ...';
  btn.disabled = true;

  const data = await api('/api/ask', {
    method: 'POST',
    body: JSON.stringify({ query }),
  });

  btn.textContent = 'Hỏi AI 🧠';
  btn.disabled = false;

  if (data?.ok) {
    document.getElementById('answerText').textContent = data.answer;
    document.getElementById('answerSource').textContent = data.source ? `Nguồn: ${data.source}` : '';
    document.getElementById('askResult').classList.remove('hidden');
  } else {
    showToast('⚠️ Không nhận được câu trả lời');
  }
});

// ── Knowledge Graph Visualization (Phase 19) ──
function initGraphViz() {
  const container = document.getElementById('graphViz');
  if (!container) return;

  graphViz = new KnowledgeGraphViz('graphViz', {
    width: container.clientWidth || 600,
    height: 400,
  });

  // Load button
  document.getElementById('graphLoadBtn')?.addEventListener('click', () => {
    showToast('🔄 Đang tải knowledge graph...');
    graphViz.loadGraph().then(() => showToast('✅ Đã tải đồ thị!'));
  });

  // Search with graph focus
  document.getElementById('graphSearch')?.addEventListener('input', debounce(async (e) => {
    const query = e.target.value.trim();
    const results = document.getElementById('graphResults');

    if (query.length < 2) {
      results.innerHTML = '<div class="empty-state">Tìm kiếm entities trong knowledge graph...</div>';
      if (graphViz) graphViz.loadGraph();
      return;
    }

    // Update search results list
    const data = await api(`/api/graph/search?q=${encodeURIComponent(query)}`);
    if (data?.entities?.length > 0) {
      results.innerHTML = data.entities.map(ent => `
        <div class="graph-node" data-id="${ent.id}">
          <div class="graph-node-name">${escapeHtml(ent.name)}</div>
          <div class="graph-node-type">${ent.type}</div>
          <div class="graph-node-desc">${escapeHtml(ent.description || '')}</div>
        </div>
      `).join('');
    } else {
      results.innerHTML = '<div class="empty-state">Không tìm thấy entity nào</div>';
    }

    // Update graph visualization with search focus
    if (graphViz) {
      graphViz.searchAndFocus(query);
    }
  }, 300));

  // Node detail panel
  document.addEventListener('graphNodeSelected', async (e) => {
    const node = e.detail.node;
    const detail = document.getElementById('graphNodeDetail');
    if (!detail) return;

    document.getElementById('detailName').textContent = node.name;
    const typeEl = document.getElementById('detailType');
    typeEl.textContent = node.type;
    typeEl.style.background = getTypeColor(node.type);
    document.getElementById('detailDesc').textContent = node.description || 'Không có mô tả.';

    // Load relationships
    const relData = await api(`/api/graph/search?q=${encodeURIComponent(node.name)}&limit=1`);
    const relDiv = document.getElementById('detailRelations');
    if (relData?.entities?.length > 0) {
      const entity = relData.entities[0];
      // Fetch relationships via the search results
      relDiv.innerHTML = `<div class="relation-list">Entity: ${escapeHtml(entity.name)} (${entity.type})</div>`;
    } else {
      relDiv.innerHTML = '';
    }

    detail.classList.remove('hidden');
  });

  document.getElementById('detailClose')?.addEventListener('click', () => {
    document.getElementById('graphNodeDetail')?.classList.add('hidden');
  });

  // Auto-load graph on tab switch
  const graphTab = document.querySelector('[data-tab="graph"]');
  graphTab?.addEventListener('click', () => {
    setTimeout(() => {
      if (graphViz && graphViz.nodes.length === 0) {
        graphViz.loadGraph();
      }
    }, 100);
  });
}

function getTypeColor(type) {
  const colors = {
    concept: '#6366f1', algorithm: '#22c55e', technology: '#f59e0b',
    person: '#ec4899', system: '#06b6d4', data_structure: '#8b5cf6',
    organization: '#f97316', event: '#14b8a6', place: '#a855f7', other: '#64748b',
  };
  return colors[type] || '#64748b';
}

async function loadGraphPreview() {
  const data = await api('/api/graph/stats');
  if (data?.stats) {
    document.getElementById('statEntities').textContent = data.stats.totalEntities || 0;
    document.getElementById('statRelationships').textContent = data.stats.totalEdges || 0;
  }
}

// ── Stats ──
async function loadStats() {
  // Flashcard stats
  const fcStats = await api('/api/flashcards/stats');
  if (fcStats?.stats) {
    document.getElementById('statTotalCards').textContent = fcStats.stats.total || 0;
    document.getElementById('statDueCards').textContent = fcStats.stats.due || 0;
  }

  // Evolution stats
  const evo = await api('/api/evolution/stats');
  const evoDiv = document.getElementById('evolutionStats');
  if (evo) {
    evoDiv.innerHTML = `
      <div class="evolution-item"><span>Đánh giá phản hồi</span><span>${evo.evaluation?.total || 0}</span></div>
      <div class="evolution-item"><span>Điểm TB</span><span>${evo.evaluation?.avgScore || 0}/1.0</span></div>
      <div class="evolution-item"><span>Tỷ lệ chất lượng thấp</span><span>${((evo.evaluation?.lowQualityRate || 0) * 100).toFixed(0)}%</span></div>
      <div class="evolution-item"><span>Knowledge Gaps</span><span>${evo.knowledgeGaps?.gaps?.length || 0}</span></div>
      <div class="evolution-item"><span>A/B Tests</span><span>${Object.keys(evo.abTests || {}).length}</span></div>
    `;
  }
}

// ── Sync Button ──
document.getElementById('syncBtn')?.addEventListener('click', async () => {
  showToast('🔄 Đang đồng bộ...');
  await loadFlashcards();
  await loadStats();
  showToast('✅ Đồng bộ xong!');
});

// ── Settings ──
document.getElementById('settingsBtn')?.addEventListener('click', () => {
  const key = prompt('API Key hiện tại:', API_KEY ? '••••••' : '');
  if (key && key !== '••••••') {
    API_KEY = key;
    localStorage.setItem('ai_brain_api_key', key);
    showToast('✅ Đã lưu API Key');
  }
});

// ── Service Worker Registration ──
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// ── Push Notification Permission ──
async function requestNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    await Notification.requestPermission();
  }
}

// ── Helpers ──
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function debounce(fn, ms) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}

// ── Background Sync for Offline Reviews ──
async function registerBackgroundSync() {
  if ('serviceWorker' in navigator && 'SyncManager' in window) {
    try {
      const reg = await navigator.serviceWorker.ready;
      // Sync when coming back online
      window.addEventListener('online', async () => {
        showToast('🔄 Đang đồng bộ dữ liệu...');
        await syncPendingReviews();
        await loadFlashcards();
        await loadStats();
        showToast('✅ Đồng bộ xong!');
        // Register background sync for future
        reg.sync?.register('sync-reviews').catch(() => {});
      });
    } catch { /* best-effort */ }
  }
}

// ── Push Notifications for Flashcard Reminders ──
async function scheduleFlashcardReminder() {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  // The service worker handles push events; this is a fallback
  // using local notification for due cards
  const cards = await getOfflineCards();
  if (cards.length > 0 && 'serviceWorker' in navigator) {
    const reg = await navigator.serviceWorker.ready;
    reg.active?.postMessage({
      type: 'FLASHCARD_REMINDER',
      count: cards.length,
    });
  }
}

// ── Init ──
loadFlashcards();
requestNotificationPermission();
initVoiceInput();
initGraphViz();
registerBackgroundSync();
scheduleFlashcardReminder();
