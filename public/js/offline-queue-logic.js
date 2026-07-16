// Чистая логика очереди офлайн-синхронизации. Без IndexedDB/fetch/DOM.
// UMD: работает и в браузере (self.OfflineQueueLogic), и в node (module.exports),
// и в Service Worker (importScripts → self.OfflineQueueLogic).
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.OfflineQueueLogic = api;
})(typeof self !== 'undefined' ? self : this, function () {
  // Что делать с результатом пишущего запроса.
  function classifyWriteOutcome(outcome) {
    if (outcome.networkError) return 'queue';
    if (outcome.ok) return 'ok';
    return 'error';
  }

  // Судьба элемента очереди после попытки досыла.
  function classifyReplayResult(result) {
    if (result.networkError) return 'retry';        // сети снова нет — повторим позже
    if (result.ok) return 'done';                   // принято сервером
    if (result.status >= 400 && result.status < 500) return 'done'; // дубль/некорректно — не зацикливаемся
    return 'retry';                                 // 5xx — серверная икота, повторим
  }

  // Собирает элемент очереди из пишущего запроса.
  function makeQueueItem(req, uuid, now) {
    return {
      id: uuid,
      kind: req.kind,
      method: req.method,
      url: req.url,
      body: req.body || null,
      created_at: now,
    };
  }

  return { classifyWriteOutcome, classifyReplayResult, makeQueueItem };
});
