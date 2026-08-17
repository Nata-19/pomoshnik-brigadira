const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function makeAssistant() {
  const filename = path.join(__dirname, '../public/js/app.js');
  const source = fs.readFileSync(filename, 'utf8').replace(
    /const app = new BrigadeAssistant\(\);\s*$/,
    'globalThis.BrigadeAssistant = BrigadeAssistant;'
  );
  const context = { console };
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename });
  return Object.create(context.BrigadeAssistant.prototype);
}

test('клиент объединяет соседние ряды одного владельца', () => {
  const app = makeAssistant();
  const occupant = { employee: 'Иванов', date: '2026-08-16', logId: 1 };
  const groups = app.groupConflictsForUi({
    sameDay: [],
    otherDay: [5, 6, 7, 10].map((row) => ({ row, occupant: { ...occupant, logId: row } })),
  }, { estate: 'e', quarter: '1', cell: '2', work_type: 'Обрезка', measure_mode: 'rows_bushes' });
  assert.deepEqual(Array.from(groups, (group) => group.range), ['5–7', '10']);
});

test('диапазон отправляется одним batch-запросом', async () => {
  const app = makeAssistant();
  let request;
  app.showOtherDayMenu = async () => ({ action: 'reassign' });
  app.apiFetch = async (url, options) => { request = { url, body: JSON.parse(options.body) }; return { ok: true }; };
  const group = {
    range: '5–7', occupant: { employee: 'Иванов', date: '2026-08-16' },
    items: [5, 6, 7].map((row) => ({ row, occupant: { logId: row + 10 } })),
  };
  const ok = await app.resolveConflictGroup(group, 'Петров', {
    date: '2026-08-17', estate: 'e', quarter: '1', cell: '2',
    work_type: 'Обрезка', measure_mode: 'rows_bushes',
  });
  assert.equal(ok, true);
  assert.equal(request.url, '/api/logs/resolve-batch');
  assert.deepEqual(Array.from(request.body.conflicts, (item) => item.row), [5, 6, 7]);
});

test('отмена диапазона останавливает последующие группы и офлайн-очередь', async () => {
  const app = makeAssistant();
  const calls = [];
  app.resolveConflictGroup = async (group) => { calls.push(group.range); return group.range !== '5–7'; };
  const result = await app.resolveRowConflicts({ sameDay: [], otherDay: [] }, 'Петров', {}, [
    { range: '5–7', items: [] },
    { range: '10–12', items: [] },
  ]);
  assert.equal(result, false);
  assert.deepEqual(calls, ['5–7']);
});
