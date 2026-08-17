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

  // Явка должна доехать до связанных рабочих записей. Внутри каждой группы
  // сохраняем исходный FIFO-порядок (POST → PATCH → DELETE и т.п.).
  function orderReplayItems(items) {
    return (items || []).map((item, index) => ({ item, index }))
      .sort((a, b) => {
        const ap = a.item && a.item.kind === 'attendance' ? 0 : 1;
        const bp = b.item && b.item.kind === 'attendance' ? 0 : 1;
        if (ap !== bp) return ap - bp;
        const at = Number(a.item && a.item.created_at) || 0;
        const bt = Number(b.item && b.item.created_at) || 0;
        return at - bt || a.index - b.index;
      })
      .map((x) => x.item);
  }

  // Накладывает ожидающие операции явки на ответ GET /api/attendance из кэша.
  // Благодаря этому повторный рендер офлайн не стирает сделанный в поле выбор.
  function applyPendingAttendance(present, items, date, employees) {
    const byId = new Map((present || []).map((p) => [Number(p.employee_id), { ...p }]));
    const employeeNames = new Map((employees || []).map((e) => [Number(e.id), e.name]));
    const attendanceItems = (items || [])
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => item && item.kind === 'attendance' && item.body && item.body.date === date)
      .sort((a, b) => (Number(a.item.created_at) || 0) - (Number(b.item.created_at) || 0) || a.index - b.index)
      .map(({ item }) => item);

    for (const item of attendanceItems) {
      const body = item.body || {};
      const employeeId = Number(body.employee_id);
      if (!Number.isInteger(employeeId)) continue;
      const method = String(item.method || '').toUpperCase();
      if (method === 'POST') {
        const existing = byId.get(employeeId) || {};
        byId.set(employeeId, {
          ...existing,
          employee_id: employeeId,
          name: existing.name || body.employee_name || employeeNames.get(employeeId) || '',
        });
      } else if (method === 'DELETE') {
        byId.delete(employeeId);
      } else if (method === 'PATCH' && byId.has(employeeId)) {
        byId.get(employeeId).people_count = body.people_count == null ? null : body.people_count;
      }
    }
    return Array.from(byId.values()).sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'ru'));
  }

  return {
    classifyWriteOutcome, classifyReplayResult, makeQueueItem,
    orderReplayItems, applyPendingAttendance,
  };
});
