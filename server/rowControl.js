// Делит кусты ряда между первым (исходным) и вторым (новым) рабочим.
// shareToSecond === null/undefined → поровну, остаток первому (101 → 51/50).
function splitBushes(total, shareToSecond) {
  if (!Number.isInteger(total) || total < 0) {
    throw new Error('Неверное число кустов');
  }
  let second;
  if (shareToSecond === null || shareToSecond === undefined) {
    second = Math.floor(total / 2);
  } else {
    second = shareToSecond;
  }
  if (!Number.isInteger(second) || second < 0 || second > total) {
    throw new Error(`Доля кустов вне диапазона 0..${total}`);
  }
  return { first: total - second, second };
}

// requestedRows: number[]; occupied: [{row, date, employee, logId, measure_mode}];
// today: 'YYYY-MM-DD'.
// Возвращает { free:number[], sameDay:[{row, occupant}], otherDay:[{row, occupant}] }.
function classifyRows(requestedRows, occupied, today) {
  const byRow = new Map();
  for (const o of occupied) {
    if (!byRow.has(o.row)) byRow.set(o.row, []);
    byRow.get(o.row).push(o);
  }
  const free = [];
  const sameDay = [];
  const otherDay = [];
  for (const row of requestedRows) {
    const list = byRow.get(row) || [];
    const todayOcc = list.find((o) => o.date === today);
    if (todayOcc) {
      sameDay.push({ row, occupant: todayOcc });
      continue;
    }
    if (list.length > 0) {
      const recent = list.slice().sort((a, b) => (a.date < b.date ? 1 : -1))[0];
      otherDay.push({ row, occupant: recent });
      continue;
    }
    free.push(row);
  }
  return { free, sameDay, otherDay };
}

// Убирает ряд removedRow из CSV-списка рядов записи и пересчитывает кусты.
// rowsCsv — строка вида '1,2,3'; currentBushes — текущие кусты записи;
// removedRowBushes — кусты снимаемого ряда по инвентаризации (для rows_only = 0).
// Возвращает { rows, bushes, deleted, found }:
//   found=false  → ряда в записи не было, ничего не меняем;
//   deleted=true → рядов не осталось, запись надо удалить (rows=null, bushes=0);
//   иначе        → rows = новый CSV, bushes = max(currentBushes - removedRowBushes, 0).
// Кусты вычитаем (а не пересчитываем по инвентаризации), чтобы сохранить ранее
// заданные вручную доли — так же, как делает деление (split).
function removeRowFromRecord(rowsCsv, currentBushes, removedRow, removedRowBushes) {
  const nums = String(rowsCsv || '')
    .split(',')
    .map((s) => parseInt(s, 10))
    .filter((n) => Number.isInteger(n));
  if (!nums.includes(removedRow)) {
    return { rows: nums.join(','), bushes: currentBushes, deleted: false, found: false };
  }
  const remaining = nums.filter((n) => n !== removedRow);
  if (remaining.length === 0) {
    return { rows: null, bushes: 0, deleted: true, found: true };
  }
  return {
    rows: remaining.join(','),
    bushes: Math.max(currentBushes - removedRowBushes, 0),
    deleted: false,
    found: true,
  };
}

// Делит total кустов на n равных долей; остаток раздаётся первым долям по одной.
// distributeBushes(101, 2) → [51, 50]; distributeBushes(100, 3) → [34, 33, 33].
// n <= 0 → пустой массив.
function distributeBushes(total, n) {
  if (!Number.isInteger(n) || n <= 0) return [];
  if (!Number.isInteger(total) || total < 0) return [];
  const base = Math.floor(total / n);
  let rem = total - base * n;
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(base + (rem > 0 ? 1 : 0));
    if (rem > 0) rem--;
  }
  return out;
}

module.exports = { splitBushes, classifyRows, removeRowFromRecord, distributeBushes };
