'use strict';

function normalizeAllocationCount(raw) {
  const n = typeof raw === 'number' ? raw : Number(String(raw == null ? '' : raw).trim());
  if (!Number.isInteger(n) || n < 1 || n > 999) {
    const err = new Error('К-во чел. на вид/квартал: целое от 1 до 999');
    err.statusCode = 400;
    throw err;
  }
  return n;
}

function sumAllocationCounts(rows) {
  let s = 0;
  for (const r of rows || []) {
    s += Number(r.people_count) || 0;
  }
  return s;
}

function assertSumWithinCap(sum, cap) {
  if (sum > cap) {
    const err = new Error(`Сумма разбивки больше явки (${cap})`);
    err.statusCode = 400;
    throw err;
  }
}

function formatAllocationProgress(sum, cap) {
  if (!cap || sum === 0 || sum === cap) return null;
  return `Разбивка ${sum} из ${cap}`;
}

module.exports = {
  normalizeAllocationCount,
  sumAllocationCounts,
  assertSumWithinCap,
  formatAllocationProgress,
};
