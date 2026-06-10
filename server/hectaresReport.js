'use strict';

function parseRowsCsv(s) {
  return String(s || '').split(',').map(x => x.trim()).filter(Boolean);
}
const round2 = (n) => Math.round(n * 100) / 100;

// Тип записи: механизированная (прямой ввод га) или ручная (ряды).
function kindOf(measure_mode) {
  return measure_mode === 'hectares' ? 'mech' : 'manual';
}

// logRows: [{ estate_id, work_type, quarter, cell, rows, measure_mode, hectares }] — площадные записи.
// cellHa(estate, quarter, cell, uniqueRowsArr) -> га (может бросить -> клетку пропускаем).
// quarterTotalHa(estate, quarter) -> вся площадь квартала, га.
// Группировка по (тип, культура, вид, квартал). manual и mech одной пары — разные строки.
function buildHectaresReport(logRows, cellHa, quarterTotalHa) {
  const groups = new Map();
  for (const r of logRows) {
    const estate = r.estate_id;
    const wt = (r.work_type && String(r.work_type).trim()) ? r.work_type : '(без вида работ)';
    const quarter = String(r.quarter);
    const kind = kindOf(r.measure_mode);
    const key = `${kind} ${estate} ${wt} ${quarter}`;
    let g = groups.get(key);
    if (!g) { g = { kind, estate, work_type: wt, quarter, cells: new Map(), doneHa: 0 }; groups.set(key, g); }
    if (kind === 'mech') {
      const ha = Number(r.hectares);
      if (isFinite(ha)) g.doneHa += ha;
    } else {
      const cell = String(r.cell);
      let set = g.cells.get(cell);
      if (!set) { set = new Set(); g.cells.set(cell, set); }
      for (const num of parseRowsCsv(r.rows)) set.add(num);
    }
  }

  const result = [];
  for (const g of groups.values()) {
    let done = 0;
    if (g.kind === 'mech') {
      done = g.doneHa;
    } else {
      for (const [cell, set] of g.cells) {
        let ha;
        try { ha = cellHa(g.estate, g.quarter, cell, Array.from(set)); }
        catch { continue; }
        if (isFinite(ha)) done += ha;
      }
    }
    done = round2(done);
    const total = round2(Number(quarterTotalHa(g.estate, g.quarter)) || 0);
    const remaining = round2(Math.max(0, total - done));
    result.push({ estate: g.estate, work_type: g.work_type, quarter: g.quarter,
      kind: g.kind, done_ha: done, total_ha: total, remaining_ha: remaining });
  }

  const qnum = (q) => { const n = parseInt(q, 10); return Number.isNaN(n) ? Infinity : n; };
  result.sort((a, b) =>
    a.estate.localeCompare(b.estate, 'ru') ||
    qnum(a.quarter) - qnum(b.quarter) ||
    a.quarter.localeCompare(b.quarter, 'ru') ||
    a.work_type.localeCompare(b.work_type, 'ru') ||
    a.kind.localeCompare(b.kind));
  return result;
}

module.exports = { buildHectaresReport, parseRowsCsv, kindOf };
