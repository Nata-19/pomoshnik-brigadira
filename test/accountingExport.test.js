'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ACCOUNTING_HEADERS,
  formatAccountingDate,
  factForLine,
  aggregateManualLines,
  buildAccountingTsv,
} = require('../server/accountingExport');

test('formatAccountingDate', () => {
  assert.equal(formatAccountingDate('2026-07-20'), '20.07.2026');
});

test('factForLine: кусты / часы / ряды', () => {
  assert.equal(factForLine({ measure_mode: 'rows_bushes', bushes: 1452, rowCount: 7 }), 1452);
  assert.equal(factForLine({ measure_mode: 'hours', hours: 6 }), 6);
  assert.equal(factForLine({ measure_mode: 'rows_only', rowCount: 3.5 }), 3.5);
  assert.equal(factForLine({ measure_mode: 'rows_only', rowCount: 1 / 3 }), 0.33);
  assert.equal(factForLine({ measure_mode: 'rows_only', rowCount: 0.999999 }), 1);
});

test('aggregateManualLines: без механизированных; ключ с датой', () => {
  const mech = new Set(['Опрыскивание мех']);
  const lines = aggregateManualLines([
    { date: '2026-07-20', employee: 'Иванов', work_type: 'Обрезка', quarter: '2', cell: '2',
      measure_mode: 'rows_bushes', bushes: 100, rows: '1-2', row_weights: null },
    { date: '2026-07-20', employee: 'Иванов', work_type: 'Обрезка', quarter: '2', cell: '2',
      measure_mode: 'rows_bushes', bushes: 50, rows: '3', row_weights: null },
    { date: '2026-07-20', employee: 'Иванов', work_type: 'Опрыскивание мех', quarter: '1', cell: '1',
      measure_mode: 'hectares', hectares: 1.2, rows: '', row_weights: null },
  ], mech);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].bushes, 150);
  assert.equal(lines[0].employee, 'Иванов');
});

test('buildAccountingTsv: два листа, к-во чел. из кусков, колонки 10–15 пустые', () => {
  const { text, sheetNames, rowCount } = buildAccountingTsv({
    logs: [
      { date: '2026-07-20', employee: 'Иванов', work_type: 'Обрезка', quarter: '2', cell: '2',
        measure_mode: 'rows_bushes', bushes: 982, rows: '1-7', row_weights: null },
      { date: '2026-07-20', employee: 'Иванов', work_type: 'хоз работы', quarter: '', cell: '',
        measure_mode: 'hours', hours: 6, rows: '', row_weights: null },
      { date: '2026-07-20', employee: 'Панова', work_type: 'Обрезка', quarter: '9', cell: '1',
        measure_mode: 'rows_bushes', bushes: 100, rows: '1', row_weights: null },
    ],
    present: [
      { date: '2026-07-20', employee_id: 1, name: 'Иванов', people_count: 8 },
      { date: '2026-07-20', employee_id: 2, name: 'Панова', people_count: 3 },
    ],
    allocations: [
      { date: '2026-07-20', employee_id: 1, work_type: 'Обрезка', quarter: '2', people_count: 7 },
      { date: '2026-07-20', employee_id: 1, work_type: 'хоз работы', quarter: '', people_count: 1 },
    ],
    mechanizedNames: [],
    enterprise: 'ООО «Демо-Агро»',
    varietyStub: 'Ркацители',
    yearStub: '2020',
  });
  assert.deepEqual(sheetNames, ['Иванов', 'Панова']);
  assert.equal(rowCount, 3);
  assert.ok(text.includes('--- Иванов ---'));
  assert.ok(text.includes('--- Панова ---'));
  assert.ok(text.includes(ACCOUNTING_HEADERS.join('\t')));
  const ivanovBlock = text.split('--- Панова ---')[0];
  assert.ok(ivanovBlock.includes('Обрезка'));
  assert.ok(ivanovBlock.includes('\t7\t')); // к-во чел. обрезка
  assert.ok(ivanovBlock.includes('\t1\t')); // к-во чел. хоз
  // хвост строки: 6 пустых полей после Факта
  const dataLine = ivanovBlock.split('\n').find((l) => l.includes('Обрезка') && l.includes('982'));
  assert.ok(dataLine);
  const parts = dataLine.split('\t');
  assert.equal(parts.length, 15);
  assert.equal(parts[9], '');
  assert.equal(parts[14], '');
});
