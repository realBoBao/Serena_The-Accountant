/**
 * Service Worker — Phase 18: Mobile Companion PWA
 * Caches flashcards, static assets, and API responses for offline use.
 */

const CACHE_NAME = 'ai-brain-v1';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/css/app.css',
  '/js/app.js',
  '/manifest.json',
];

// ── Install: Cache static assets ──
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    })
  );
  self.skipWaiting();
});

// ── Activate: Clean old caches ──
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    })
  );
  self.clients.claim();
});

// ── Fetch: Cache-first for static, network-first for API ──
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // API calls: network first, fallback to cache
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          // Cache successful GET responses
          if (request.method === 'GET' && response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  // Static assets: cache first, fallback to network
  event.respondWith(
    caches.match(request).then((cached) => {
      return cached || fetch(request).then((response) => {
        // Cache new static assets
        if (response.ok && request.method === 'GET') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        }
        return response;
      });
    })
  );
});

// ── Push Notifications ──
self.addEventListener('push', (event) => {
  const data = event.data?.json() || {};
  const options = {
    body: data.body || 'Flashcard đến hạn ôn tập!',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    vibrate: [200, 100, 200],
    data: { url: data.url || '/' },
    actions: [
      { action: 'review', title: 'Ôn tập ngay' },
      { action: 'dismiss', title: 'Để sau' },
    ],
  };
  event.waitUntil(
    self.registration.showNotification(data.title || 'AI Brain', options)
  );
});

// ── Notification Click ──
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  if (event.action === 'review' || !event.action) {
    event.waitUntil(
      clients.openWindow(event.notification.data?.url || '/')
    );
  }
});

// ── Background Sync ──
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-reviews') {
    event.waitUntil(syncReviewsFromSW());
  }
});

async function syncReviewsFromSW() {
  // Open IndexedDB from SW context
  const db = await new Promise((resolve, reject) => {
    const req = indexedDB.open('ai_brain_offline', 1);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  const tx = db.transaction('syncQueue', 'readonly');
  const store = tx.objectStore('syncQueue');
  const pending = await new Promise((resolve) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => resolve([]);
  });

  for (const item of pending) {
    try {
      const res = await fetch(`/api/flashcards/${item.cardId}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ correct: item.correct }),
      });
      if (res.ok) {
        const delTx = db.transaction('syncQueue', 'readwrite');
        delTx.objectStore('syncQueue').delete(item.id);
      }
    } catch { /* retry next sync */ }
  }

  db.close();
}

// ── Message from App ──
self.addEventListener('message', (event) => {
  if (event.data?.type === 'FLASHCARD_REMINDER') {
    const count = event.data.count || 0;
    if (count > 0) {
      self.registration.showNotification('AI Brain — Ôn tập', {
        body: `Bạn có ${count} flashcard đến hạn ôn tập!`,
        icon: '/icons/icon-192.png',
        badge: '/icons/icon-192.png',
        vibrate: [200, 100, 200],
        data: { url: '/#flashcards' },
        actions: [
          { action: 'review', title: 'Ôn tập ngay' },
          { action: 'dismiss', title: 'Để sau' },
        ],
      });
    }
  }
});
