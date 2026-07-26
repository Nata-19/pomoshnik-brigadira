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

// Квартал куска: trim; пустая строка = «без квартала» (хозработы/часы).
function normalizeAllocationQuarter(raw) {
  if (raw == null) return '';
  return String(raw).trim();
}

function attendancePeopleCount(presentRow) {
  if (!presentRow || presentRow.people_count == null || presentRow.people_count === '') return null;
  const n = Number(presentRow.people_count);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

// Число чел. для строки отчёта: кусок (сотрудник+вид+квартал), иначе общее N явки.
function resolvePeopleCountForLine(line, { present, allocations } = {}) {
  const name = line && line.name;
  const presentRow = (present || []).find((x) => x.name === name);
  if (!presentRow) return null;

  const wt = typeof line.work_type === 'string' ? line.work_type.trim() : '';
  const q = normalizeAllocationQuarter(line.quarter);
  const piece = (allocations || []).find(
    (a) =>
      a.employee_id === presentRow.employee_id &&
      a.work_type === wt &&
      normalizeAllocationQuarter(a.quarter) === q
  );
  if (piece) {
    const n = Number(piece.people_count);
    return Number.isInteger(n) && n >= 1 ? n : null;
  }
  return attendancePeopleCount(presentRow);
}

module.exports = {
  normalizeAllocationCount,
  sumAllocationCounts,
  assertSumWithinCap,
  formatAllocationProgress,
  normalizeAllocationQuarter,
  resolvePeopleCountForLine,
};
