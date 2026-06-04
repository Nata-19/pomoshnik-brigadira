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

module.exports = { splitBushes, classifyRows };
