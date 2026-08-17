const test = require('node:test');
const assert = require('node:assert/strict');
const {
  groupConflicts,
  normalizeBatchWeights,
  allocateBushesByWeights,
} = require('../server/rowControl');
const { applyBatchAtomically } = require('../server/conflictBatch');

test('два раздельных блока конфликтов превращаются в два диапазона', () => {
  const occupant = { employee: 'Иванов', date: '2026-08-16', logId: 10 };
  const groups = groupConflicts({
    sameDay: [],
    otherDay: [5, 6, 7, 8, 9, 10, 11, 12, 18, 19, 20, 21, 22, 23, 24, 25]
      .map((row) => ({ row, occupant: { ...occupant, logId: 10 + row } })),
  }, { estate: 'виноград', quarter: '1', cell: '2', work_type: 'Обрезка' });
  assert.deepEqual(groups.map((g) => g.range), ['5–12', '18–25']);
  assert.deepEqual(groups[0].items.map((x) => x.row), [5, 6, 7, 8, 9, 10, 11, 12]);
  assert.deepEqual(groups[1].items.map((x) => x.row), [18, 19, 20, 21, 22, 23, 24, 25]);
});

test('разные работники, даты и типы конфликта дают разные группы', () => {
  const groups = groupConflicts({
    sameDay: [{ row: 1, occupant: { employee: 'Иванов', date: '2026-08-17' } }],
    otherDay: [
      { row: 2, occupant: { employee: 'Иванов', date: '2026-08-16' } },
      { row: 3, occupant: { employee: 'Петров', date: '2026-08-16' } },
      { row: 4, occupant: { employee: 'Петров', date: '2026-08-15' } },
    ],
  }, { estate: 'виноград', quarter: '1', cell: '2', work_type: 'Обрезка' });
  assert.deepEqual(groups.map((g) => g.range), ['1', '2', '3', '4']);
});

test('единая доля переводится в кусты каждого ряда отдельно', () => {
  const weights = normalizeBatchWeights([0.5, 0.5]);
  assert.deepEqual(allocateBushesByWeights(101, weights), [51, 50]);
  assert.deepEqual(allocateBushesByWeights(80, weights), [40, 40]);
  assert.deepEqual(normalizeBatchWeights([null, null]), [0.5, 0.5]);
});

test('ошибка одного ряда откатывает весь пакет', async () => {
  const calls = [];
  const client = {
    async query(sql) { calls.push(sql); return { rows: [] }; },
    release() { calls.push('RELEASE'); },
  };
  const pool = { async connect() { return client; } };
  await assert.rejects(
    () => applyBatchAtomically(pool, [5, 6, 7], async (_db, row) => {
      calls.push('ROW ' + row);
      if (row === 6) throw new Error('row 6 failed');
    }),
    /row 6 failed/
  );
  assert.deepEqual(calls, ['BEGIN', 'ROW 5', 'ROW 6', 'ROLLBACK', 'RELEASE']);
  assert.ok(!calls.includes('ROW 7'));
  assert.ok(!calls.includes('COMMIT'));
});
