// Парсер Excel-файлов инвентаризации в единый inventory.json.
//
// Конфигурация (имена Excel-файлов, листов, расположение колонок) лежит
// в parse_config.json — этот файл исключён из репозитория, так как может
// содержать внутренние имена / названия сортов / гектарность.
//
// Пример parse_config.json:
//   {
//     "quarters": [
//       {
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

function extractCells(sheet, opts) {
  const data = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, blankrows: false });
  const cells = {};

  for (let i = opts.dataStartRow; i < data.length; i++) {
    const row = data[i];
    if (!row) continue;
    const rowNum = row[opts.rowCol];
    if (typeof rowNum !== 'number' || !Number.isInteger(rowNum) || rowNum <= 0) continue;

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

const inventory = { quarters: {} };

for (const q of config.quarters) {
  if (!fs.existsSync(q.file)) {
    console.warn(`⚠ Файл "${q.file}" не найден — пропускаю квартал ${q.quarter}`);
    continue;
  }
  const wb = loadWB(q.file);
  const sheet = wb.Sheets[q.sheet];
  if (!sheet) {
    console.warn(`⚠ Лист "${q.sheet}" не найден в "${q.file}" — пропускаю`);
    continue;
  }
  const cells = extractCells(sheet, q);
  inventory.quarters[q.quarter] = { name: q.name, cells };
}

console.log('=== Итоги парсинга ===');
let totalBushes = 0;
for (const [qid, q] of Object.entries(inventory.quarters)) {
  let qBushes = 0;
  let qRows = 0;
  for (const rows of Object.values(q.cells)) {
    for (const r of rows) qBushes += r.bushes;
    qRows += rows.length;
  }
  totalBushes += qBushes;
  const cellList = Object.keys(q.cells).sort((a, b) => +a - +b).join(', ');
  console.log(`Кв.${qid}: клеток=${Object.keys(q.cells).length} [${cellList}], строк-ряды=${qRows}, кустов=${qBushes}`);
}
console.log(`\nВСЕГО кустов: ${totalBushes}`);

fs.writeFileSync('inventory.json', JSON.stringify(inventory), 'utf8');
const sizeKb = (fs.statSync('inventory.json').size / 1024).toFixed(0);
console.log(`\n✅ inventory.json перезаписан (${sizeKb} КБ)`);
