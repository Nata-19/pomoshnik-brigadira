const CACHE_NAME = 'brigade-v23';
const urlsToCache = [
  '/',
  '/index.html',
  '/styles.css',
  '/styles.css?v=23',
  '/js/app.js',
  '/js/app.js?v=23',
  '/js/demo-ui.js',
  '/js/demo-ui.js?v=23',
  '/manifest.json'
];

function fetchWithTimeout(request, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(request, { signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

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

  // API-запросы — всегда сеть, не кэшируем (данные меняются)
  if (url.pathname.startsWith('/api/')) {
    return; // браузер обработает сам, без вмешательства SW
  }

  // Статика: сеть с таймаутом, иначе кэш. Без таймаута телефон может висеть вечно.
  event.respondWith(
    fetchWithTimeout(event.request, 10000)
      .then(response => {
        if (response && response.status === 200 && response.type === 'basic') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => {
        return caches.match(event.request).then(cached => cached || caches.match('/index.html'));
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
    // TODO: синхронизировать данные с сервером
    console.log('Data synced');
  } catch (error) {
    console.error('Sync failed:', error);
  }
}
