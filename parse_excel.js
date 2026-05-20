// Парсер Excel-файлов инвентаризации в единый inventory.json.
//
// Конфигурация (имена Excel-файлов, листов, расположение колонок) лежит
// в parse_config.json — этот файл исключён из репозитория, так как может
// содержать внутренние имена / названия сортов / гектарность.
//
// Пример parse_config.json:
//   {
//     "estates": [
//       { "id": "estate1", "name": "Хозяйство A" },
//       { "id": "estate2", "name": "Хозяйство B" }
//     ],
//     "quarters": [
//       {
//         "estate": "estate1",
//         "file": "имя.xlsx",
//         "sheet": "имя листа",
//         "quarter": "1",
//         "name": "Произвольное название",
//         "rowCol": 1,          // индекс колонки с номером ряда (от 0)
//         "dataStartRow": 3,    // индекс первой строки данных
//         "cellMap": { "1": 2, "2": 3, ... }  // cellId → индекс колонки
//       },
//       ...
//     ]
//   }

const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = 'parse_config.json';
if (!fs.existsSync(CONFIG_PATH)) {
  console.error(`❌ Не найден ${CONFIG_PATH}. Создай его рядом со скриптом.`);
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
if (!config.quarters || !Array.isArray(config.quarters)) {
  console.error('❌ В parse_config.json должно быть поле "quarters" — массив.');
  process.exit(1);
}
if (!config.estates || !Array.isArray(config.estates) || config.estates.length === 0) {
  console.error('❌ В parse_config.json должно быть поле "estates" — непустой массив объектов { id, name }.');
  process.exit(1);
}

const estatesByID = Object.fromEntries(config.estates.map(e => [e.id, e]));

function extractCells(sheet, opts) {
  const data = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, blankrows: false });
  const cells = {};

  for (let i = opts.dataStartRow; i < data.length; i++) {
    const row = data[i];
    if (!row) continue;
    const rowNum = row[opts.rowCol];
    if (typeof rowNum !== 'number' || !Number.isInteger(rowNum) || rowNum < 0) continue;

    for (const [cellNum, colIdx] of Object.entries(opts.cellMap)) {
      const bushes = row[colIdx];
      if (typeof bushes === 'number' && bushes > 0 && Number.isInteger(bushes)) {
        if (!cells[cellNum]) cells[cellNum] = [];
        cells[cellNum].push({ row: rowNum, bushes });
      }
    }
  }

  for (const k of Object.keys(cells)) {
    cells[k].sort((a, b) => a.row - b.row);
  }
  return cells;
}

const wbCache = {};
function loadWB(file) {
  if (!wbCache[file]) wbCache[file] = XLSX.readFile(file);
  return wbCache[file];
}

const inventory = { estates: {} };

for (const q of config.quarters) {
  const estateId = q.estate;
  if (!estateId || !estatesByID[estateId]) {
    console.warn(`⚠ Квартал ${q.quarter}: estate "${estateId}" не описан в estates — пропускаю`);
    continue;
  }
  if (!fs.existsSync(q.file)) {
    console.warn(`⚠ Файл "${q.file}" не найден — пропускаю квартал ${q.quarter} (${estateId})`);
    continue;
  }
  const wb = loadWB(q.file);
  const sheet = wb.Sheets[q.sheet];
  if (!sheet) {
    console.warn(`⚠ Лист "${q.sheet}" не найден в "${q.file}" — пропускаю`);
    continue;
  }
  const cells = extractCells(sheet, q);
  if (!inventory.estates[estateId]) {
    inventory.estates[estateId] = { name: estatesByID[estateId].name, quarters: {} };
  }
  const existing = inventory.estates[estateId].quarters[q.quarter];
  if (!existing) {
    inventory.estates[estateId].quarters[q.quarter] = { name: q.name, cells };
  } else {
    // Тот же quarter встречается повторно (другой год посадки / другой файл) —
    // сливаем клетки и ряды. Конфликтующий номер ряда в одной клетке —
    // ошибка, кричим и оставляем первый.
    for (const [cellId, rows] of Object.entries(cells)) {
      if (!existing.cells[cellId]) {
        existing.cells[cellId] = rows;
        continue;
      }
      const existingRowNums = new Set(existing.cells[cellId].map(r => r.row));
      for (const r of rows) {
        if (existingRowNums.has(r.row)) {
          console.warn(`⚠ Кв.${q.quarter} (${estateId}), клетка ${cellId}: ряд ${r.row} уже есть из другого файла — оставляю первый`);
        } else {
          existing.cells[cellId].push(r);
          existingRowNums.add(r.row);
        }
      }
      existing.cells[cellId].sort((a, b) => a.row - b.row);
    }
  }
}

console.log('=== Итоги парсинга ===');
let grandTotal = 0;
for (const [eid, estate] of Object.entries(inventory.estates)) {
  console.log(`\n— ${estate.name} (${eid}) —`);
  let estateBushes = 0;
  for (const [qid, q] of Object.entries(estate.quarters)) {
    let qBushes = 0;
    let qRows = 0;
    for (const rows of Object.values(q.cells)) {
      for (const r of rows) qBushes += r.bushes;
      qRows += rows.length;
    }
    estateBushes += qBushes;
    const cellList = Object.keys(q.cells).sort((a, b) => +a - +b).join(', ');
    console.log(`  Кв.${qid}: клеток=${Object.keys(q.cells).length} [${cellList}], строк-ряды=${qRows}, кустов=${qBushes}`);
  }
  console.log(`  Итого по хозяйству: ${estateBushes}`);
  grandTotal += estateBushes;
}
console.log(`\nВСЕГО кустов: ${grandTotal}`);

fs.writeFileSync('inventory.json', JSON.stringify(inventory), 'utf8');
const sizeKb = (fs.statSync('inventory.json').size / 1024).toFixed(0);
console.log(`\n✅ inventory.json перезаписан (${sizeKb} КБ)`);
