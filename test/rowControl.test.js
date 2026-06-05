const test = require('node:test');
const assert = require('node:assert');
const { splitBushes, classifyRows, removeRowFromRecord, distributeBushes } = require('../server/rowControl');

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

test('removeRowFromRecord: убирает ряд из середины и вычитает его кусты', () => {
  const out = removeRowFromRecord('1,2,3,4,5', 685, 3, 140);
  assert.strictEqual(out.rows, '1,2,4,5');
  assert.strictEqual(out.bushes, 545);
  assert.strictEqual(out.deleted, false);
  assert.strictEqual(out.found, true);
});

test('removeRowFromRecord: последний ряд → запись помечается на удаление', () => {
  const out = removeRowFromRecord('7', 130, 7, 130);
  assert.strictEqual(out.rows, null);
  assert.strictEqual(out.bushes, 0);
  assert.strictEqual(out.deleted, true);
  assert.strictEqual(out.found, true);
});

test('removeRowFromRecord: кусты не уходят ниже нуля', () => {
  const out = removeRowFromRecord('1,2', 50, 2, 200);
  assert.strictEqual(out.rows, '1');
  assert.strictEqual(out.bushes, 0);
  assert.strictEqual(out.deleted, false);
  assert.strictEqual(out.found, true);
});

test('removeRowFromRecord: ряда нет в записи → ничего не меняем', () => {
  const out = removeRowFromRecord('1,2,3', 300, 9, 100);
  assert.strictEqual(out.rows, '1,2,3');
  assert.strictEqual(out.bushes, 300);
  assert.strictEqual(out.deleted, false);
  assert.strictEqual(out.found, false);
});

test('removeRowFromRecord: режим rows_only (кусты 0) остаётся 0', () => {
  const out = removeRowFromRecord('4,5,6', 0, 5, 0);
  assert.strictEqual(out.rows, '4,6');
  assert.strictEqual(out.bushes, 0);
  assert.strictEqual(out.deleted, false);
});

test('distributeBushes: поровну без остатка', () => {
  assert.deepStrictEqual(distributeBushes(100, 2), [50, 50]);
});

test('distributeBushes: остаток уходит первым', () => {
  assert.deepStrictEqual(distributeBushes(101, 2), [51, 50]);
  assert.deepStrictEqual(distributeBushes(100, 3), [34, 33, 33]);
});

test('distributeBushes: один получатель — все кусты', () => {
  assert.deepStrictEqual(distributeBushes(140, 1), [140]);
});

test('distributeBushes: ноль кустов', () => {
  assert.deepStrictEqual(distributeBushes(0, 3), [0, 0, 0]);
});

test('distributeBushes: ноль получателей — пустой массив', () => {
  assert.deepStrictEqual(distributeBushes(100, 0), []);
});

test('distributeBushes: некорректный total → пустой массив', () => {
  assert.deepStrictEqual(distributeBushes(-5, 2), []);
  assert.deepStrictEqual(distributeBushes(1.5, 2), []);
});
