const CACHE_NAME = 'lifeos-v2';
const PRECACHE_URLS = [
  '/',
  '/index.html',
];

// ============================================================
// IndexedDB helpers for offline mutation queue
// ============================================================

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('lifeos-offline', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('mutations')) {
        db.createObjectStore('mutations', { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains('api-cache')) {
        db.createObjectStore('api-cache', { keyPath: 'url' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function queueMutation(request) {
  const db = await openDB();
  const body = await request.clone().text();
  const mutation = {
    url: request.url,
    method: request.method,
    headers: Object.fromEntries(request.headers.entries()),
    body,
    timestamp: Date.now(),
  };
  return new Promise((resolve, reject) => {
    const tx = db.transaction('mutations', 'readwrite');
    tx.objectStore('mutations').add(mutation);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function getPendingMutations() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('mutations', 'readonly');
    const req = tx.objectStore('mutations').getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function clearMutation(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('mutations', 'readwrite');
    tx.objectStore('mutations').delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function cacheAPIResponse(url, response) {
  try {
    const db = await openDB();
    const body = await response.clone().text();
    const entry = {
      url,
      body,
      contentType: response.headers.get('content-type') || 'application/json',
      timestamp: Date.now(),
    };
    const tx = db.transaction('api-cache', 'readwrite');
    tx.objectStore('api-cache').put(entry);
  } catch (e) {
    // Silently fail cache writes
  }
}

async function getCachedAPI(url) {
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction('api-cache', 'readonly');
      const req = tx.objectStore('api-cache').get(url);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch (e) {
    return null;
  }
}

// ============================================================
// Replay queued mutations when back online
// ============================================================

async function replayMutations() {
  const mutations = await getPendingMutations();
  for (const mutation of mutations) {
    try {
      await fetch(mutation.url, {
        method: mutation.method,
        headers: mutation.headers,
        body: mutation.body || undefined,
      });
      await clearMutation(mutation.id);
    } catch (e) {
      // Still offline, stop trying
      break;
    }
  }
  // Notify clients that sync is complete
  const remaining = await getPendingMutations();
  const clients = await self.clients.matchAll();
  clients.forEach(client => {
    client.postMessage({ type: 'SYNC_COMPLETE', remaining: remaining.length });
  });
}

// ============================================================
// Service Worker Lifecycle
// ============================================================

// Install — precache shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS))
  );
  self.skipWaiting();
});

// Activate — clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ============================================================
// Fetch handler — offline-aware
// ============================================================

// GET API endpoints that should be cached for offline use
const CACHEABLE_API = [
  '/api/profiles', '/api/tasks', '/api/trackers', '/api/expenses',
  '/api/events', '/api/habits', '/api/obligations', '/api/journal',
  '/api/goals', '/api/documents', '/api/statistics', '/api/memories',
];

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // API mutations (POST/PUT/PATCH/DELETE) — queue if offline
  if (url.pathname.startsWith('/api/') && event.request.method !== 'GET') {
    event.respondWith(
      fetch(event.request.clone())
        .catch(async () => {
          // Offline: queue the mutation
          await queueMutation(event.request);
          return new Response(JSON.stringify({
            queued: true,
            message: 'You\'re offline. This action has been saved and will sync when you\'re back online.',
          }), {
            status: 202,
            headers: { 'Content-Type': 'application/json' },
          });
        })
    );
    return;
  }

  // API GET requests — network first, fallback to IndexedDB cache
  if (url.pathname.startsWith('/api/') && CACHEABLE_API.some(p => url.pathname.startsWith(p))) {
    event.respondWith(
      fetch(event.request.clone())
        .then(async (response) => {
          // Cache successful GET responses in IndexedDB
          await cacheAPIResponse(url.pathname, response);
          return response;
        })
        .catch(async () => {
          // Offline: serve from IndexedDB cache
          const cached = await getCachedAPI(url.pathname);
          if (cached) {
            return new Response(cached.body, {
              status: 200,
              headers: { 'Content-Type': cached.contentType, 'X-Offline-Cache': 'true' },
            });
          }
          return new Response(JSON.stringify({ error: 'Offline and no cached data available' }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' },
          });
        })
    );
    return;
  }

  // Non-cacheable API calls — pass through
  if (url.pathname.startsWith('/api/')) {
    return;
  }

  // For navigation and assets: network first, fall back to cache
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});

// ============================================================
// Background sync — replay mutations when online
// ============================================================

self.addEventListener('sync', (event) => {
  if (event.tag === 'lifeos-sync') {
    event.waitUntil(replayMutations());
  }
});

// Listen for online message from clients
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'REPLAY_MUTATIONS') {
    replayMutations();
  }
});
