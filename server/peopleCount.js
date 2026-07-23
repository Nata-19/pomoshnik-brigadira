'use strict';

function normalizePeopleCount(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isInteger(n) || n < 1 || n > 999) {
    const err = new Error('К-во чел.: целое от 1 до 999 или пусто');
    err.statusCode = 400;
    throw err;
  }
  return n;
}

function formatEmployeeWithCount(name, peopleCount) {
  const label = name == null || name === '' ? '—' : String(name);
  const n = peopleCount == null || peopleCount === '' ? null : Number(peopleCount);
  if (Number.isInteger(n) && n >= 1) return `${label} ${n} чел.`;
  return label;
}

module.exports = { normalizePeopleCount, formatEmployeeWithCount };
