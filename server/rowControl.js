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

// Убирает ряд removedRow из записи: правит CSV рядов, JSON весов и кусты.
// rowBushes — кусты ВСЕГО ряда по инвентаризации (rows_only → 0); вычитаем
// долю снимаемого рабочего = вес_ряда * rowBushes (вес отсутствует → 1).
// Возвращает { rows, weights, bushes, deleted, found }.
function removeRowFromRecord(rowsCsv, weightsText, currentBushes, removedRow, rowBushes) {
  const nums = String(rowsCsv || '')
    .split(',').map((s) => parseInt(s, 10)).filter((n) => Number.isInteger(n));
  const weights = parseRowWeights(weightsText);
  if (!nums.includes(removedRow)) {
    return { rows: nums.join(','), weights: serializeRowWeights(weights), bushes: currentBushes, deleted: false, found: false };
  }
  const w = (typeof weights[removedRow] === 'number' && isFinite(weights[removedRow])) ? weights[removedRow] : 1;
  const remaining = nums.filter((n) => n !== removedRow);
  if (remaining.length === 0) {
    return { rows: null, weights: null, bushes: 0, deleted: true, found: true };
  }
  const newWeights = {};
  for (const n of remaining) if (weights[n] !== undefined) newWeights[n] = weights[n];
  const subtract = Math.round(w * (Number(rowBushes) || 0));
  return {
    rows: remaining.join(','),
    weights: serializeRowWeights(newWeights),
    bushes: Math.max(currentBushes - subtract, 0),
    deleted: false, found: true,
  };
}

// --- Веса рядов (дробный учёт) ---
function parseRowWeights(text) {
  if (!text) return {};
  try {
    const o = JSON.parse(text);
    return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {};
  } catch { return {}; }
}

function serializeRowWeights(obj) {
  return JSON.stringify(obj || {});
}

// Вес записи для подсчёта рядов: сумма весов; ряд без веса считается как 1.
function weightOfRecord(rowsCsv, weightsText) {
  const nums = String(rowsCsv || '').split(',').map((s) => s.trim()).filter(Boolean);
  const w = parseRowWeights(weightsText);
  let sum = 0;
  for (const n of nums) sum += (typeof w[n] === 'number' && isFinite(w[n])) ? w[n] : 1;
  return sum;
}

// Веса по кустам (rows_bushes): доля = кусты/всего. total<=0 → поровну.
function weightsFromBushes(totalRowBushes, bushesArr) {
  const n = bushesArr.length;
  if (!(Number(totalRowBushes) > 0)) return fillWeights(new Array(n).fill(null));
  return bushesArr.map((b) => (Number(b) || 0) / Number(totalRowBushes));
}

// Заполняет веса: явные (число) уважаются, пустые (null) делят остаток поровну.
function fillWeights(arr) {
  const provided = arr.filter((w) => w !== null && w !== undefined);
  const explicitSum = provided.reduce((s, w) => s + Number(w), 0);
  const blanks = arr.filter((w) => w === null || w === undefined).length;
  const each = blanks > 0 ? Math.max(1 - explicitSum, 0) / blanks : 0;
  return arr.map((w) => (w === null || w === undefined) ? each : Number(w));
}

// Показ числа рядов: округление до 2 знаков, без лишних нулей.
function formatRows(n) {
  return String(Math.round((Number(n) || 0) * 100) / 100);
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

// Сверка по клетке (Фаза 3). Считает по инвентарю с учётом долей.
// inventoryRows: [{row:Number, bushes:Number}] — ряды клетки из инвентаря.
// weightByRow: Map<Number,Number> | {row: weightSum} — суммарный вес ряда из журнала
//   (целый ряд = 1, поделённый = доля, ряд без записи отсутствует/0).
// disputedSet: Set<Number> — номера спорных рядов клетки (в этом разрезе).
// Возвращает сводку + списки несделанных. «сделано + осталось = всего» при весах в [0,1]
// (доменная норма); remaining зажат в ≥0. Done намеренно НЕ клампим — аномалии (вес >1
// из-за дубля записи) остаются видны, а не маскируются.
function computeCellReconciliation(inventoryRows, weightByRow, disputedSet) {
  const rows = Array.isArray(inventoryRows) ? inventoryRows : [];
  const disputed = disputedSet instanceof Set ? disputedSet : new Set(disputedSet || []);
  const weightOf = (row) => {
    const w = (weightByRow instanceof Map) ? weightByRow.get(row)
      : (weightByRow ? weightByRow[row] : undefined);
    return (typeof w === 'number' && isFinite(w)) ? w : 0;
  };

  let totalRows = 0, totalBushes = 0, doneRows = 0, doneBushesRaw = 0;
  const missedRows = [];
  const disputedRows = [];
  for (const item of rows) {
    const row = Number(item.row);
    if (!Number.isFinite(row)) continue; // пропускаем мусорные записи инвентаря
    const bushes = Number(item.bushes) || 0;
    totalRows += 1;
    totalBushes += bushes;
    const w = weightOf(row);
    doneRows += w;
    doneBushesRaw += w * bushes;
    if (disputed.has(row)) disputedRows.push(row);
    if (w === 0 && !disputed.has(row)) missedRows.push(row);
  }

  const doneBushes = Math.round(doneBushesRaw);
  const remainingRows = Math.max(totalRows - doneRows, 0);
  const remainingBushes = Math.max(totalBushes - doneBushes, 0);
  missedRows.sort((a, b) => a - b);
  disputedRows.sort((a, b) => a - b);
  const fullyDone = Math.round(remainingRows * 100) / 100 === 0
    && missedRows.length === 0 && disputedRows.length === 0;

  return {
    totalRows, totalBushes, doneRows, doneBushes,
    remainingRows, remainingBushes,
    missedRows, disputedRows, disputedCount: disputedRows.length, fullyDone,
  };
}

module.exports = {
  splitBushes, classifyRows, removeRowFromRecord, distributeBushes,
  parseRowWeights, serializeRowWeights, weightOfRecord,
  weightsFromBushes, fillWeights, formatRows,
  computeCellReconciliation,
};
