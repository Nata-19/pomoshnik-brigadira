const test = require('node:test');
const assert = require('node:assert');
const { buildHectaresReport, parseRowsCsv, kindOf } = require('../server/hectaresReport');

// Фейковые колбэки перевода: площадь клетки = (уникальных рядов) * 0.1 га;
// всего по кварталу = 1 га для кв.2/кв.7, иначе 0.5 га.
const fakeCellHa = (estate, q, c, rowsArr) => {
  if (c === 'NOHA') throw new Error('нет площади');
  return Math.round(rowsArr.length * 0.1 * 100) / 100;
};
const fakeQuarterTotalHa = (estate, q) => (q === '2' || q === '7' ? 1.0 : 0.5);

test('kindOf: hectares -> mech, остальное -> manual', () => {
  assert.strictEqual(kindOf('hectares'), 'mech');
  assert.strictEqual(kindOf('rows_bushes'), 'manual');
  assert.strictEqual(kindOf('rows_only'), 'manual');
});

test('manual: дедупликация — один ряд двум рабочим считается один раз', () => {
  const logs = [
    { estate_id: 'Яблоня', work_type: 'Обрезка', quarter: '2', cell: 'A', rows: '1,2', measure_mode: 'rows_bushes' },
    { estate_id: 'Яблоня', work_type: 'Обрезка', quarter: '2', cell: 'A', rows: '2,3', measure_mode: 'rows_bushes' },
  ];
  const out = buildHectaresReport(logs, fakeCellHa, fakeQuarterTotalHa);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].kind, 'manual');
  assert.strictEqual(out[0].done_ha, 0.3);
  assert.strictEqual(out[0].total_ha, 1.0);
  assert.strictEqual(out[0].remaining_ha, 0.7);
});

test('manual: накопление по клеткам внутри пары вид×квартал', () => {
  const logs = [
    { estate_id: 'Яблоня', work_type: 'Полив', quarter: '2', cell: 'A', rows: '1,2,3,4,5', measure_mode: 'rows_only' },
    { estate_id: 'Яблоня', work_type: 'Полив', quarter: '2', cell: 'B', rows: '1,2,3,4,5', measure_mode: 'rows_only' },
  ];
  const out = buildHectaresReport(logs, fakeCellHa, fakeQuarterTotalHa);
  assert.strictEqual(out[0].done_ha, 1.0);
  assert.strictEqual(out[0].remaining_ha, 0.0);
});

test('manual: осталось зажато в 0, не уходит в минус', () => {
  const logs = [
    { estate_id: 'Яблоня', work_type: 'Полив', quarter: '5', cell: 'A', rows: '1,2,3,4,5,6,7,8', measure_mode: 'rows_bushes' },
  ];
  const out = buildHectaresReport(logs, fakeCellHa, fakeQuarterTotalHa);
  assert.strictEqual(out[0].remaining_ha, 0.0);
});

test('manual: клетка без площади пропускается, остальные считаются', () => {
  const logs = [
    { estate_id: 'Яблоня', work_type: 'Обрезка', quarter: '2', cell: 'NOHA', rows: '1,2,3', measure_mode: 'rows_bushes' },
    { estate_id: 'Яблоня', work_type: 'Обрезка', quarter: '2', cell: 'A', rows: '1,2', measure_mode: 'rows_bushes' },
  ];
  const out = buildHectaresReport(logs, fakeCellHa, fakeQuarterTotalHa);
  assert.strictEqual(out[0].done_ha, 0.2);
});

test('mech: гектары суммируются напрямую, kind=mech', () => {
  const logs = [
    { estate_id: 'Яблоня', work_type: 'Вспашка', quarter: '2', cell: '', rows: '', measure_mode: 'hectares', hectares: 0.3 },
    { estate_id: 'Яблоня', work_type: 'Вспашка', quarter: '2', cell: '', rows: '', measure_mode: 'hectares', hectares: 0.2 },
  ];
  const out = buildHectaresReport(logs, fakeCellHa, fakeQuarterTotalHa);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].kind, 'mech');
  assert.strictEqual(out[0].done_ha, 0.5);
  assert.strictEqual(out[0].total_ha, 1.0);
  assert.strictEqual(out[0].remaining_ha, 0.5);
});

test('mech и manual для одной пары вид×квартал — две отдельные плашки', () => {
  const logs = [
    { estate_id: 'Яблоня', work_type: 'Обработка', quarter: '2', cell: 'A', rows: '1,2', measure_mode: 'rows_bushes' },
    { estate_id: 'Яблоня', work_type: 'Обработка', quarter: '2', cell: '', rows: '', measure_mode: 'hectares', hectares: 0.4 },
  ];
  const out = buildHectaresReport(logs, fakeCellHa, fakeQuarterTotalHa);
  assert.strictEqual(out.length, 2);
  assert.deepStrictEqual(out.map(r => r.kind).sort(), ['manual', 'mech']);
});

test('несколько культур: одинаковый вид работ -> отдельные строки с разным estate', () => {
  const logs = [
    { estate_id: 'Яблоня',  work_type: 'Обрезка', quarter: '2', cell: 'A', rows: '1,2', measure_mode: 'rows_bushes' },
    { estate_id: 'Виноград', work_type: 'Обрезка', quarter: '7', cell: 'A', rows: '1',  measure_mode: 'rows_bushes' },
  ];
  const out = buildHectaresReport(logs, fakeCellHa, fakeQuarterTotalHa);
  assert.strictEqual(out.length, 2);
  const estates = out.map(r => r.estate);
  assert.ok(estates.includes('Яблоня') && estates.includes('Виноград'));
});

test('пустой ввод -> пустой массив', () => {
  assert.deepStrictEqual(buildHectaresReport([], fakeCellHa, fakeQuarterTotalHa), []);
});

test('parseRowsCsv чистит пробелы и пустые', () => {
  assert.deepStrictEqual(parseRowsCsv(' 1, 2 ,,3 '), ['1', '2', '3']);
  assert.deepStrictEqual(parseRowsCsv(null), []);
});

test('сортировка: по культуре, кварталу (числом), виду работ', () => {
  const logs = [
    { estate_id: 'Яблоня', work_type: 'Полив',   quarter: '10', cell: 'A', rows: '1', measure_mode: 'rows_bushes' },
    { estate_id: 'Яблоня', work_type: 'Полив',   quarter: '2',  cell: 'A', rows: '1', measure_mode: 'rows_bushes' },
    { estate_id: 'Яблоня', work_type: 'Обрезка', quarter: '2',  cell: 'A', rows: '1', measure_mode: 'rows_bushes' },
  ];
  const out = buildHectaresReport(logs, fakeCellHa, fakeQuarterTotalHa);
  assert.deepStrictEqual(
    out.map(r => `${r.quarter}|${r.work_type}`),
    ['2|Обрезка', '2|Полив', '10|Полив']
  );
});
