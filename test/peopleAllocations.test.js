'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeAllocationCount,
  sumAllocationCounts,
  assertSumWithinCap,
  formatAllocationProgress,
  resolvePeopleCountForLine,
  normalizeAllocationQuarter,
} = require('../server/peopleAllocations');

test('normalizeAllocationCount: 1…999', () => {
  assert.equal(normalizeAllocationCount(1), 1);
  assert.equal(normalizeAllocationCount('10'), 10);
  assert.equal(normalizeAllocationCount(999), 999);
});

test('normalizeAllocationCount: невалидное → 400', () => {
  for (const bad of [null, undefined, '', 0, -1, 1000, 1.5, 'abc']) {
    assert.throws(() => normalizeAllocationCount(bad), (err) => err.statusCode === 400);
  }
});

test('sumAllocationCounts', () => {
  assert.equal(sumAllocationCounts([]), 0);
  assert.equal(sumAllocationCounts([{ people_count: 6 }, { people_count: '4' }]), 10);
});

test('assertSumWithinCap: ok и отказ', () => {
  assert.doesNotThrow(() => assertSumWithinCap(0, 10));
  assert.doesNotThrow(() => assertSumWithinCap(10, 10));
  assert.throws(() => assertSumWithinCap(11, 10), (err) => err.statusCode === 400);
});

test('formatAllocationProgress', () => {
  assert.equal(formatAllocationProgress(0, 10), null);
  assert.equal(formatAllocationProgress(10, 10), null);
  assert.equal(formatAllocationProgress(6, 10), 'Разбивка 6 из 10');
});

test('resolvePeopleCountForLine: кусок по сотрудник+вид+квартал', () => {
  const present = [{ employee_id: 1, name: 'Иванов', people_count: 8 }];
  const allocations = [
    { employee_id: 1, work_type: 'Обрезка', quarter: '9', people_count: 7 },
    { employee_id: 1, work_type: 'Хозработы', quarter: '', people_count: 1 },
  ];
  assert.equal(
    resolvePeopleCountForLine(
      { name: 'Иванов', work_type: 'Обрезка', quarter: '9' },
      { present, allocations }
    ),
    7
  );
  assert.equal(
    resolvePeopleCountForLine(
      { name: 'Иванов', work_type: 'Хозработы', quarter: '' },
      { present, allocations }
    ),
    1
  );
});

test('resolvePeopleCountForLine: нет кусков → общее N явки', () => {
  const present = [{ employee_id: 1, name: 'Иванов', people_count: 8 }];
  assert.equal(
    resolvePeopleCountForLine(
      { name: 'Иванов', work_type: 'Обрезка', quarter: '9' },
      { present, allocations: [] }
    ),
    8
  );
});

test('normalizeAllocationQuarter: пустой → «без квартала»', () => {
  assert.equal(normalizeAllocationQuarter('9'), '9');
  assert.equal(normalizeAllocationQuarter('  '), '');
  assert.equal(normalizeAllocationQuarter(null), '');
  assert.equal(normalizeAllocationQuarter(undefined), '');
});
