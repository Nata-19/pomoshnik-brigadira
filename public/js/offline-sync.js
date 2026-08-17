// Досыл очереди: по очереди (FIFO) отправляет накопленные действия.
// Останавливается на первом 'retry' (нет сети / 5xx), сохраняя порядок.
// Привязка к self → используется и страницей (событие online), и SW (sync).
(function () {
  let running = false;

  function notifyChanged() {
    try { self.dispatchEvent(new Event('offline-queue-changed')); } catch (e) { /* нет dispatchEvent — игнор */ }
  }

  async function sendItem(item) {
    try {
      const r = await fetch(item.url, {
        method: item.method,
        headers: item.body ? { 'Content-Type': 'application/json' } : undefined,
        body: item.body ? JSON.stringify(item.body) : undefined,
        credentials: 'same-origin',
      });
      const data = await r.json().catch(() => ({}));
      return { networkError: false, ok: r.ok, status: r.status, data };
    } catch (e) {
      return { networkError: true };
    }
  }

  // handlers.onLogConflict(item, data) → Promise<bool>: разрешить спорные ряды лога.
  async function syncQueue(handlers) {
    if (running) return { sent: 0, remaining: await self.OfflineStore.count() };
    running = true;
    let sent = 0;
    try {
      const queued = await self.OfflineStore.getAll();
      const items = self.OfflineQueueLogic.orderReplayItems
        ? self.OfflineQueueLogic.orderReplayItems(queued)
        : queued;
      for (const item of items) {
        const result = await sendItem(item);
        const verdict = self.OfflineQueueLogic.classifyReplayResult(result);
        if (verdict === 'retry') break; // нет сети / 5xx — порядок сохраняем

        // Лог со спорными рядами: свободные сервер уже сохранил (client_uuid от дублей),
        // спорные разрешаем интерактивно — только если есть обработчик (страница онлайн).
        // Без обработчика (фоновый SW) — оставляем лог в очереди до открытия приложения.
        if (item.kind === 'log') {
          const c = (result.data && result.data.conflicts) || { sameDay: [], otherDay: [] };
          const hasConflict = (c.sameDay && c.sameDay.length) || (c.otherDay && c.otherDay.length);
          if (hasConflict) {
            if (handlers && handlers.onLogConflict) {
              const resolved = await handlers.onLogConflict(item, result.data);
              if (resolved) { await self.OfflineStore.remove(item.id); sent++; notifyChanged(); }
              else break; // отмена диапазона: не перескакиваем к следующим операциям
            }
            continue; // не разрешили здесь — оставляем (повторная отправка идемпотентна)
          }
        }
        await self.OfflineStore.remove(item.id);
        sent++;
        notifyChanged();
      }
    } finally {
      running = false;
    }
    const remaining = await self.OfflineStore.count();
    return { sent, remaining };
  }

  self.OfflineSync = { syncQueue };
})();
