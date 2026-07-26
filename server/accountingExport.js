'use strict';
const { resolvePeopleCountForLine, normalizeAllocationQuarter } = require('./peopleAllocations');
const rowControl = require('./rowControl');

const ACCOUNTING_HEADERS = [
  'Технологическая операция, Условное обозначение',
  'год посадки',
  'квартал',
  'сорт',
  'Услуга (работа)',
  'Дата',
  'к-во чел.',
  'Бригада',
  'Факт',
  'Норма',
  'Расценка',
  'оплата людям',
  'транспорт 150;450/чел.',
  'Бригадирские 150/чел.',
  'Сумма итого',
];

function formatAccountingDate(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return String(iso || '');
  return `${m[3]}.${m[2]}.${m[1]}`;
}

function rowWeightSum(log) {
  return rowControl.weightOfRecord(log.rows, log.row_weights);
}

function factForLine(line) {
  if (line.measure_mode === 'hours') return Number(line.hours) || 0;
  if (line.measure_mode === 'rows_bushes') return Number(line.bushes) || 0;
  const n = Number(line.rowCount);
  if (!Number.isFinite(n)) return '';
  return Math.round(n * 100) / 100;
}

function aggregateManualLines(logs, mechanizedNames) {
  const mech = mechanizedNames instanceof Set
    ? mechanizedNames
    : new Set(mechanizedNames || []);
  const map = new Map();
  for (const log of logs || []) {
    const wt = log.work_type || '';
    if (mech.has(wt)) continue;
    const date = log.date || '';
    const employee = log.employee || '—';
    const quarter = normalizeAllocationQuarter(log.quarter);
    const cell = log.cell != null ? String(log.cell) : '';
    const mode = log.measure_mode || '';
    const key = [date, employee, wt, quarter, cell, mode].join('|');
    if (!map.has(key)) {
      map.set(key, {
        date, employee, work_type: wt, quarter, cell, measure_mode: mode,
        rowCount: 0, bushes: 0, hours: 0,
      });
    }
    const it = map.get(key);
    it.rowCount += rowWeightSum(log);
    it.bushes += Number(log.bushes) || 0;
    it.hours += Number(log.hours) || 0;
  }
  return Array.from(map.values());
}

function buildAccountingTsv({
  logs,
  present,
  allocations,
  mechanizedNames,
  enterprise,
  varietyStub,
  yearStub,
}) {
  const lines = aggregateManualLines(logs, mechanizedNames);
  const byEmp = new Map();
  for (const line of lines) {
    const name = line.employee || '—';
    if (!byEmp.has(name)) byEmp.set(name, []);
    byEmp.get(name).push(line);
  }
  const sheetNames = Array.from(byEmp.keys()).sort((a, b) => a.localeCompare(b, 'ru'));
  const header = ACCOUNTING_HEADERS.join('\t');
  const chunks = [];
  let rowCount = 0;

  for (const name of sheetNames) {
    chunks.push(`--- ${name} ---`);
    chunks.push(header);
    const rows = byEmp.get(name).slice().sort((a, b) => {
      if (a.date !== b.date) return (a.date || '').localeCompare(b.date || '');
      const byWt = (a.work_type || '').localeCompare(b.work_type || '', 'ru');
      if (byWt) return byWt;
      return (Number(a.quarter) || 0) - (Number(b.quarter) || 0);
    });
    for (const line of rows) {
      const presentForDate = (present || []).filter((p) => p.date === line.date);
      const allocForDate = (allocations || []).filter(
        (a) => !a.date || a.date === line.date
      );
      const people = resolvePeopleCountForLine(
        { name: line.employee, work_type: line.work_type, quarter: line.quarter },
        { present: presentForDate, allocations: allocForDate }
      );
      const fact = factForLine(line);
      const cells = [
        line.work_type || '',
        yearStub || '',
        line.quarter || '',
        varietyStub || '',
        enterprise || '',
        formatAccountingDate(line.date),
        people == null ? '' : String(people),
        line.employee || '',
        fact === '' ? '' : String(fact),
        '', '', '', '', '', '',
      ];
      chunks.push(cells.join('\t'));
      rowCount += 1;
    }
  }

  return { text: chunks.join('\n'), sheetNames, rowCount };
}

module.exports = {
  ACCOUNTING_HEADERS,
  formatAccountingDate,
  factForLine,
  aggregateManualLines,
  buildAccountingTsv,
};
