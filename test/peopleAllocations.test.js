'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeAllocationCount,
  sumAllocationCounts,
  assertSumWithinCap,
  formatAllocationProgress,
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
