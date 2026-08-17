const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {
  orderReplayItems,
  applyPendingAttendance,
} = require('../public/js/offline-queue-logic');

test('явка отправляется перед рабочими записями с сохранением FIFO', () => {
  const ordered = orderReplayItems([
    { id: 'log-1', kind: 'log', created_at: 1 },
    { id: 'att-post', kind: 'attendance', method: 'POST', created_at: 2 },
    { id: 'log-2', kind: 'log', created_at: 3 },
    { id: 'att-patch', kind: 'attendance', method: 'PATCH', created_at: 4 },
  ]);
  assert.deepEqual(ordered.map((x) => x.id), ['att-post', 'att-patch', 'log-1', 'log-2']);
});

test('ожидающие операции явки накладываются на кэшированный список', () => {
  const present = [{ employee_id: 1, name: 'Анна', people_count: null }];
  const employees = [{ id: 1, name: 'Анна' }, { id: 2, name: 'Борис' }];
  const items = [
    { kind: 'attendance', method: 'DELETE', created_at: 1, body: { date: '2026-08-17', employee_id: 1 } },
    { kind: 'attendance', method: 'POST', created_at: 2, body: { date: '2026-08-17', employee_id: 2, employee_name: 'Борис' } },
    { kind: 'attendance', method: 'PATCH', created_at: 3, body: { date: '2026-08-17', employee_id: 2, people_count: 7 } },
    { kind: 'attendance', method: 'POST', created_at: 4, body: { date: '2026-08-18', employee_id: 1 } },
  ];
  assert.deepEqual(
    applyPendingAttendance(present, items, '2026-08-17', employees),
    [{ employee_id: 2, name: 'Борис', people_count: 7 }]
  );
});

test('повторный выбор и снятие выбора офлайн дают итоговое состояние', () => {
  const items = [
    { kind: 'attendance', method: 'POST', created_at: 1, body: { date: '2026-08-17', employee_id: 2, employee_name: 'Борис' } },
    { kind: 'attendance', method: 'DELETE', created_at: 2, body: { date: '2026-08-17', employee_id: 2 } },
  ];
  assert.deepEqual(applyPendingAttendance([], items, '2026-08-17', []), []);
});

function makeAssistant() {
  const filename = path.join(__dirname, '../public/js/app.js');
  const source = fs.readFileSync(filename, 'utf8').replace(
    /const app = new BrigadeAssistant\(\);\s*$/,
    'globalThis.BrigadeAssistant = BrigadeAssistant;'
  );
  const context = { console, alert() {} };
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename });
  return Object.create(context.BrigadeAssistant.prototype);
}

test('выбор человека отображается до завершения сетевого запроса', async () => {
  const app = makeAssistant();
  app.present = [];
  app.allocations = [];
  app.employees = [{ id: 2, name: 'Борис' }];
  app.inputDate = '2026-08-17';
  app.selectedEmployeeId = null;
  app.renderInput = () => {};
  let finish;
  app.sendOrQueue = () => new Promise((resolve) => { finish = resolve; });

  const pending = app.togglePresent(2);
  assert.equal(app.present.length, 1);
  assert.equal(app.present[0].name, 'Борис');
  finish({ queued: true });
  await pending;
});

test('количество людей отображается до завершения сетевого запроса', async () => {
  const app = makeAssistant();
  app.present = [{ employee_id: 2, name: 'Борис', people_count: null }];
  app.allocations = [];
  app.employees = [{ id: 2, name: 'Борис' }];
  app.inputDate = '2026-08-17';
  app.renderInput = () => {};
  let finish;
  app.sendOrQueue = () => new Promise((resolve) => { finish = resolve; });

  const pending = app.savePeopleCount(2, '7');
  assert.equal(app.present[0].people_count, 7);
  finish({ queued: true });
  await pending;
});

function loadOfflineSync(items, responseFor) {
  const source = fs.readFileSync(path.join(__dirname, '../public/js/offline-sync.js'), 'utf8');
  const removed = [];
  const sentUrls = [];
  const context = {
    Event: class Event { constructor(type) { this.type = type; } },
    fetch: async (url) => { sentUrls.push(url); return responseFor(url); },
  };
  context.self = {
    OfflineStore: {
      getAll: async () => items,
      remove: async (id) => { removed.push(id); },
      count: async () => items.length - removed.length,
    },
    OfflineQueueLogic: require('../public/js/offline-queue-logic'),
    dispatchEvent() {},
  };
  vm.runInNewContext(source, context);
  return { sync: context.self.OfflineSync, removed, sentUrls };
}

test('досыл реально отправляет явку раньше накопленной рабочей записи', async () => {
  const items = [
    { id: 'log', kind: 'log', method: 'POST', url: '/api/logs', body: {}, created_at: 1 },
    { id: 'attendance', kind: 'attendance', method: 'POST', url: '/api/attendance', body: {}, created_at: 2 },
  ];
  const harness = loadOfflineSync(items, () => ({ ok: true, status: 200, json: async () => ({}) }));
  await harness.sync.syncQueue();
  assert.deepEqual(harness.sentUrls, ['/api/attendance', '/api/logs']);
  assert.deepEqual(harness.removed, ['attendance', 'log']);
});

test('отмена конфликтного диапазона не пропускает вперёд следующую запись', async () => {
  const items = [
    { id: 'first', kind: 'log', method: 'POST', url: '/api/logs', body: {}, created_at: 1 },
    { id: 'second', kind: 'log', method: 'POST', url: '/api/logs', body: {}, created_at: 2 },
  ];
  const harness = loadOfflineSync(items, () => ({
    ok: true,
    status: 200,
    json: async () => ({ conflicts: { sameDay: [{ row: 5 }], otherDay: [] } }),
  }));
  await harness.sync.syncQueue({ onLogConflict: async () => false });
  assert.deepEqual(harness.sentUrls, ['/api/logs']);
  assert.deepEqual(harness.removed, []);
});
