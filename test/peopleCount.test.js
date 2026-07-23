const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizePeopleCount, formatEmployeeWithCount } = require('../server/peopleCount');

test('normalizePeopleCount: пустое → null', () => {
  assert.equal(normalizePeopleCount(null), null);
  assert.equal(normalizePeopleCount(undefined), null);
  assert.equal(normalizePeopleCount(''), null);
});

test('normalizePeopleCount: целое 1…999 → число', () => {
  assert.equal(normalizePeopleCount(1), 1);
  assert.equal(normalizePeopleCount(10), 10);
  assert.equal(normalizePeopleCount('999'), 999);
});

test('normalizePeopleCount: невалидное → Error statusCode 400', () => {
  for (const bad of [0, -1, 1000, 1.5, 'abc', '10.5']) {
    assert.throws(() => normalizePeopleCount(bad), (err) => err.statusCode === 400);
  }
});

test('formatEmployeeWithCount: с числом и без', () => {
  assert.equal(formatEmployeeWithCount('Халил', 10), 'Халил 10 чел.');
  assert.equal(formatEmployeeWithCount('Халил', null), 'Халил');
  assert.equal(formatEmployeeWithCount('Халил', undefined), 'Халил');
});
