const CACHE_NAME = 'brigade-v1';
const urlsToCache = [
  '/',
  '/index.html',
  '/styles.css',
  '/js/app.js',
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

  event.respondWith(
    caches.match(event.request)
      .then(response => {
        // Если в кэше есть - возвращаем оттуда
        if (response) {
          return response;
        }

        return fetch(event.request).then(response => {
          // Если это не валидный ответ - возвращаем как есть
          if (!response || response.status !== 200 || response.type !== 'basic') {
            return response;
          }

          // Кэшируем успешные запросы
          const responseToCache = response.clone();
          caches.open(CACHE_NAME)
            .then(cache => {
              cache.put(event.request, responseToCache);
            });

          return response;
        });
      })
      .catch(() => {
        // Если нет интернета и нет в кэше, показываем offline страницу
        return caches.match('/index.html');
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
