'use strict';

function parseRowsCsv(s) {
  return String(s || '').split(',').map(x => x.trim()).filter(Boolean);
}
const round2 = (n) => Math.round(n * 100) / 100;

// Тип записи: механизированная (прямой ввод га) или ручная (ряды).
function kindOf(measure_mode) {
  return measure_mode === 'hectares' ? 'mech' : 'manual';
}

function isTodayLog(r, todayDate) {
  if (!todayDate) return false;
  const d = r.date;
  if (!d) return false;
  // date может быть Date или строкой YYYY-MM-DD / ISO
  const s = (d instanceof Date) ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
  return s === todayDate;
}

// logRows: [{ date?, estate_id, work_type, quarter, cell, rows, measure_mode, hectares }]
// cellHa(estate, quarter, cell, uniqueRowsArr) -> га
// quarterTotalHa(estate, quarter) -> вся площадь квартала, га
// opts.todayDate: 'YYYY-MM-DD' — для today_ha; без даты today_ha = 0
function buildHectaresReport(logRows, cellHa, quarterTotalHa, opts = {}) {
  const todayDate = opts.todayDate || null;
  const groups = new Map();
  for (const r of logRows) {
    const estate = r.estate_id;
    const wt = String(r.work_type || '').trim() || '(без вида работ)';
    const quarter = String(r.quarter);
    const kind = kindOf(r.measure_mode);
    const key = [kind, estate, wt, quarter].join('\x00');
    let g = groups.get(key);
    if (!g) {
      g = {
        kind, estate, work_type: wt, quarter,
        cells: new Map(), doneHa: 0,
        todayCells: new Map(), todayDoneHa: 0,
        cellKeys: new Set(),
      };
      groups.set(key, g);
    }
    const onToday = isTodayLog(r, todayDate);
    if (kind === 'mech') {
      const ha = Number(r.hectares);
      if (isFinite(ha) && ha > 0) {
        g.doneHa += ha;
        if (onToday) g.todayDoneHa += ha;
      }
      const cell = String(r.cell ?? '').trim();
      if (cell) {
        // mech может быть «1,2,3» в одной записи
        for (const c of cell.split(',').map(x => x.trim()).filter(Boolean)) {
          g.cellKeys.add(c);
        }
      }
    } else {
      const cell = String(r.cell ?? '');
      if (cell) g.cellKeys.add(cell);
      let set = g.cells.get(cell);
      if (!set) { set = new Set(); g.cells.set(cell, set); }
      for (const num of parseRowsCsv(r.rows)) set.add(num);
      if (onToday) {
        let tset = g.todayCells.get(cell);
        if (!tset) { tset = new Set(); g.todayCells.set(cell, tset); }
        for (const num of parseRowsCsv(r.rows)) tset.add(num);
      }
    }
  }

  const result = [];
  for (const g of groups.values()) {
    let done = 0;
    let today = 0;
    if (g.kind === 'mech') {
      done = g.doneHa;
      today = g.todayDoneHa;
    } else {
      for (const [cell, set] of g.cells) {
        let ha;
        try { ha = cellHa(g.estate, g.quarter, cell, Array.from(set)); }
        catch { continue; }
        if (isFinite(ha)) done += ha;
      }
      for (const [cell, set] of g.todayCells) {
        let ha;
        try { ha = cellHa(g.estate, g.quarter, cell, Array.from(set)); }
        catch { continue; }
        if (isFinite(ha)) today += ha;
      }
    }
    done = round2(done);
    today = round2(today);
    const total = round2(Number(quarterTotalHa(g.estate, g.quarter)) || 0);
    const remaining = round2(Math.max(0, total - done));
    const cells = Array.from(g.cellKeys).sort((a, b) => {
      const na = parseInt(a, 10); const nb = parseInt(b, 10);
      if (!Number.isNaN(na) && !Number.isNaN(nb) && na !== nb) return na - nb;
      return String(a).localeCompare(String(b), 'ru');
    });
    result.push({
      estate: g.estate, work_type: g.work_type, quarter: g.quarter,
      kind: g.kind, done_ha: done, total_ha: total, remaining_ha: remaining,
      today_ha: today, cells,
    });
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
