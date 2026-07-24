const CACHE_NAME = 'brigade-v34';
// Общие модули офлайна — те же файлы, что и на странице.
importScripts('/js/offline-queue-logic.js', '/js/offline-storage.js', '/js/offline-sync.js');
const urlsToCache = [
  '/',
  '/index.html',
  '/styles.css',
  '/js/app.js',
  '/js/demo-ui.js',
  '/js/offline-queue-logic.js',
  '/js/offline-storage.js',
  '/js/offline-sync.js',
  '/manifest.json'
];

// Установка Service Worker
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(urlsToCache))
      .then(() => self.skipWaiting())
  );
});

// Активация Service Worker
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Обработка запросов
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') {
    return;
  }

  const url = new URL(event.request.url);

  // GET /api/* — network-first с фолбэком в кэш, чтобы экран открывался офлайн.
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // Статика — cache-first со свежением в фоне.
  // Важно: для .js/.css НЕ отдаём index.html как fallback — иначе «OfflineQueueLogic is not defined».
  event.respondWith(
    caches.match(event.request).then(cached => {
      const network = fetch(event.request)
        .then(response => {
          if (response && response.status === 200 && response.type === 'basic') {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => {
          if (cached) return cached;
          const isPage = url.pathname === '/' || url.pathname.endsWith('.html');
          return isPage ? caches.match('/index.html') : Response.error();
        });
      return cached || network;
    })
  );
});

// Синхронизация при возврате онлайн
self.addEventListener('sync', event => {
  if (event.tag === 'sync-data') {
    event.waitUntil(syncData());
  }
});

async function syncData() {
  try {
    if (self.OfflineSync && self.OfflineSync.syncQueue) {
      const res = await self.OfflineSync.syncQueue();
      console.log('Sync done:', res);
    }
  } catch (error) {
    console.error('Sync failed:', error);
  }
}
