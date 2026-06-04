const test = require('node:test');
const assert = require('node:assert');
const { splitBushes, classifyRows } = require('../server/rowControl');

test('splitBushes делит поровну, чётное', () => {
  assert.deepStrictEqual(splitBushes(100, null), { first: 50, second: 50 });
});

test('splitBushes делит поровну, нечётное — остаток первому', () => {
  assert.deepStrictEqual(splitBushes(101, null), { first: 51, second: 50 });
});

test('splitBushes принимает явную долю второму', () => {
  assert.deepStrictEqual(splitBushes(100, 70), { first: 30, second: 70 });
});

test('splitBushes: доля всё второму', () => {
  assert.deepStrictEqual(splitBushes(100, 100), { first: 0, second: 100 });
});

test('splitBushes отвергает долю вне диапазона', () => {
  assert.throws(() => splitBushes(100, 101), /диапазон/);
  assert.throws(() => splitBushes(100, -1), /диапазон/);
});

const occ = (row, date, employee) => ({ row, date, employee, logId: row * 10, measure_mode: 'rows_bushes' });

test('classifyRows: свободные ряды', () => {
  const r = classifyRows([1, 2, 3], [], '2026-06-04');
  assert.deepStrictEqual(r.free, [1, 2, 3]);
  assert.deepStrictEqual(r.sameDay, []);
  assert.deepStrictEqual(r.otherDay, []);
});

test('classifyRows: занят сегодня → sameDay', () => {
  const r = classifyRows([5], [occ(5, '2026-06-04', 'Иванов')], '2026-06-04');
  assert.deepStrictEqual(r.free, []);
  assert.strictEqual(r.sameDay.length, 1);
  assert.strictEqual(r.sameDay[0].row, 5);
  assert.strictEqual(r.sameDay[0].occupant.employee, 'Иванов');
});

test('classifyRows: занят в другой день → otherDay', () => {
  const r = classifyRows([5], [occ(5, '2026-06-02', 'Иванов')], '2026-06-04');
  assert.deepStrictEqual(r.free, []);
  assert.deepStrictEqual(r.sameDay, []);
  assert.strictEqual(r.otherDay.length, 1);
  assert.strictEqual(r.otherDay[0].occupant.date, '2026-06-02');
});

test('classifyRows: занят и сегодня, и в другой день → приоритет sameDay', () => {
  const r = classifyRows([5], [occ(5, '2026-06-02', 'Иванов'), occ(5, '2026-06-04', 'Петров')], '2026-06-04');
  assert.strictEqual(r.sameDay.length, 1);
  assert.strictEqual(r.sameDay[0].occupant.employee, 'Петров');
  assert.strictEqual(r.otherDay.length, 0);
});

test('classifyRows: otherDay берёт самую свежую дату', () => {
  const r = classifyRows([5], [occ(5, '2026-06-01', 'А'), occ(5, '2026-06-03', 'Б')], '2026-06-04');
  assert.strictEqual(r.otherDay[0].occupant.date, '2026-06-03');
  assert.strictEqual(r.otherDay[0].occupant.employee, 'Б');
});

test('classifyRows: смешанный набор', () => {
  const r = classifyRows([1, 5, 7], [occ(5, '2026-06-04', 'Иванов'), occ(7, '2026-06-02', 'Сидоров')], '2026-06-04');
  assert.deepStrictEqual(r.free, [1]);
  assert.strictEqual(r.sameDay[0].row, 5);
  assert.strictEqual(r.otherDay[0].row, 7);
});
