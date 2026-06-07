const test = require('node:test');
const assert = require('node:assert');
const { splitBushes, classifyRows, removeRowFromRecord, distributeBushes, computeCellReconciliation } = require('../server/rowControl');

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
  const out = removeRowFromRecord('1,2,3,4,5', null, 685, 3, 140);
  assert.strictEqual(out.rows, '1,2,4,5');
  assert.strictEqual(out.bushes, 545);
  assert.strictEqual(out.deleted, false);
  assert.strictEqual(out.found, true);
});

test('removeRowFromRecord: последний ряд → запись помечается на удаление', () => {
  const out = removeRowFromRecord('7', null, 130, 7, 130);
  assert.strictEqual(out.rows, null);
  assert.strictEqual(out.bushes, 0);
  assert.strictEqual(out.deleted, true);
  assert.strictEqual(out.found, true);
});

test('removeRowFromRecord: кусты не уходят ниже нуля', () => {
  const out = removeRowFromRecord('1,2', null, 50, 2, 200);
  assert.strictEqual(out.rows, '1');
  assert.strictEqual(out.bushes, 0);
  assert.strictEqual(out.deleted, false);
  assert.strictEqual(out.found, true);
});

test('removeRowFromRecord: ряда нет в записи → ничего не меняем', () => {
  const out = removeRowFromRecord('1,2,3', null, 300, 9, 100);
  assert.strictEqual(out.rows, '1,2,3');
  assert.strictEqual(out.bushes, 300);
  assert.strictEqual(out.deleted, false);
  assert.strictEqual(out.found, false);
});

test('removeRowFromRecord: режим rows_only (кусты 0) остаётся 0', () => {
  const out = removeRowFromRecord('4,5,6', null, 0, 5, 0);
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

const {
  parseRowWeights, serializeRowWeights, weightOfRecord,
  weightsFromBushes, fillWeights, formatRows,
} = require('../server/rowControl');

test('parse/serialize round-trip и мусор', () => {
  assert.deepStrictEqual(parseRowWeights('{"1":1,"2":0.5}'), { '1': 1, '2': 0.5 });
  assert.deepStrictEqual(parseRowWeights(''), {});
  assert.deepStrictEqual(parseRowWeights('не json'), {});
  assert.deepStrictEqual(parseRowWeights('[1,2]'), {});
  assert.strictEqual(serializeRowWeights({ '1': 1 }), '{"1":1}');
});

test('weightOfRecord: нет весов → считаем по числу рядов (по 1)', () => {
  assert.strictEqual(weightOfRecord('1,2,3', null), 3);
  assert.strictEqual(weightOfRecord('1,2,3', ''), 3);
});

test('weightOfRecord: смесь целых и долей суммируется точно', () => {
  assert.strictEqual(weightOfRecord('1,2,5', '{"1":1,"2":1,"5":0.5}'), 2.5);
  assert.strictEqual(weightOfRecord('1,2', '{"1":0.5}'), 1.5);
});

test('weightsFromBushes: 100 кустов 25/75 → 0.25/0.75', () => {
  assert.deepStrictEqual(weightsFromBushes(100, [25, 75]), [0.25, 0.75]);
});

test('weightsFromBushes: total<=0 → поровну', () => {
  assert.deepStrictEqual(weightsFromBushes(0, [0, 0]), [0.5, 0.5]);
});

test('fillWeights: все пустые → поровну', () => {
  assert.deepStrictEqual(fillWeights([null, null]), [0.5, 0.5]);
  const three = fillWeights([null, null, null]);
  assert.ok(Math.abs(three.reduce((s, w) => s + w, 0) - 1) < 1e-9);
});

test('fillWeights: явные уважаются, остаток поровну по пустым', () => {
  assert.deepStrictEqual(fillWeights([0.5, null, null]), [0.5, 0.25, 0.25]);
});

test('formatRows: 2 знака без лишних нулей', () => {
  assert.strictEqual(formatRows(2), '2');
  assert.strictEqual(formatRows(0.5), '0.5');
  assert.strictEqual(formatRows(1 / 3), '0.33');
  assert.strictEqual(formatRows(0.999999), '1');
});

test('removeRowFromRecord: учитывает вес при вычете кустов', () => {
  const out = removeRowFromRecord('1,5', '{"1":1,"5":0.5}', 130, 5, 100);
  assert.strictEqual(out.found, true);
  assert.strictEqual(out.deleted, false);
  assert.strictEqual(out.rows, '1');
  assert.strictEqual(out.bushes, 80);
  assert.deepStrictEqual(JSON.parse(out.weights), { '1': 1 });
});

test('removeRowFromRecord: последний ряд → запись на удаление', () => {
  const out = removeRowFromRecord('5', '{"5":0.5}', 50, 5, 100);
  assert.strictEqual(out.deleted, true);
  assert.strictEqual(out.rows, null);
  assert.strictEqual(out.weights, null);
});

test('removeRowFromRecord: ряда нет → found=false', () => {
  const out = removeRowFromRecord('1,2', '{"1":1,"2":1}', 50, 9, 100);
  assert.strictEqual(out.found, false);
});

test('removeRowFromRecord: старая запись без весов → вес ряда = 1', () => {
  const out = removeRowFromRecord('1,2', null, 80, 2, 30);
  assert.strictEqual(out.bushes, 50);
  assert.strictEqual(out.found, true);
});

// --- computeCellReconciliation (Фаза 3 «Сверка») ---
const inv3 = [{ row: 1, bushes: 100 }, { row: 2, bushes: 100 }, { row: 3, bushes: 100 }];

test('reconcile: клетка сделана полностью', () => {
  const r = computeCellReconciliation(inv3, { 1: 1, 2: 1, 3: 1 }, new Set());
  assert.strictEqual(r.fullyDone, true);
  assert.deepStrictEqual(r.missedRows, []);
  assert.strictEqual(r.doneRows, 3);
  assert.strictEqual(r.remainingRows, 0);
  assert.strictEqual(r.totalBushes, 300);
  assert.strictEqual(r.doneBushes, 300);
  assert.strictEqual(r.remainingBushes, 0);
});

test('reconcile: частично — забытые ряды попадают в missed', () => {
  const r = computeCellReconciliation(inv3, { 1: 1 }, new Set());
  assert.strictEqual(r.fullyDone, false);
  assert.deepStrictEqual(r.missedRows, [2, 3]);
  assert.strictEqual(r.doneRows, 1);
  assert.strictEqual(r.remainingRows, 2);
  assert.strictEqual(r.doneBushes, 100);
  assert.strictEqual(r.remainingBushes, 200);
});

test('reconcile: спорные не в missed, но в disputedRows и в остатке', () => {
  const r = computeCellReconciliation(inv3, { 1: 1 }, new Set([2]));
  assert.deepStrictEqual(r.missedRows, [3]);        // 2 спорный → не в missed
  assert.deepStrictEqual(r.disputedRows, [2]);
  assert.strictEqual(r.disputedCount, 1);
  assert.strictEqual(r.remainingRows, 2);           // 2 и 3 не сделаны
  assert.strictEqual(r.doneRows + r.remainingRows, r.totalRows); // сходимость
  assert.strictEqual(r.doneBushes + r.remainingBushes, r.totalBushes);
  assert.strictEqual(r.fullyDone, false);
});

test('reconcile: дробный ряд (вес 0.5) — не в missed, остаток учитывает половину', () => {
  const r = computeCellReconciliation(inv3, { 1: 1, 2: 0.5 }, new Set());
  assert.strictEqual(r.doneRows, 1.5);
  assert.deepStrictEqual(r.missedRows, [3]);        // 2 записан частично → не забыт
  assert.strictEqual(r.doneBushes, 150);            // 100 + 50
  assert.strictEqual(r.remainingBushes, 150);
  assert.strictEqual(r.remainingRows, 1.5);
});

test('reconcile: пустой инвентарь рядов — безопасно', () => {
  const r = computeCellReconciliation([], {}, new Set());
  assert.strictEqual(r.totalRows, 0);
  assert.strictEqual(r.totalBushes, 0);
  assert.deepStrictEqual(r.missedRows, []);
  assert.deepStrictEqual(r.disputedRows, []);
  assert.strictEqual(r.fullyDone, true);
});

test('reconcile: weightByRow как Map тоже работает', () => {
  const r = computeCellReconciliation(inv3, new Map([[1, 1], [2, 1], [3, 1]]), new Set());
  assert.strictEqual(r.fullyDone, true);
});
