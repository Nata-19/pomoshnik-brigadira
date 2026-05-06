const XLSX = require('xlsx');
const fs = require('fs');

const inventory = { quarters: {} };

// Универсальная функция: проходит строки, для каждого row собирает {row, bushes} по cellMap
function extractCells(sheet, opts) {
  // opts: { rowCol, dataStartRow, cellMap: {cellNum -> colIdx} }
  const data = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, blankrows: false });
  const cells = {};

  for (let i = opts.dataStartRow; i < data.length; i++) {
    const row = data[i];
    if (!row) continue;
    const rowNum = row[opts.rowCol];
    // Пропускаем "Итого" и любые нечисловые строки
    if (typeof rowNum !== 'number' || !Number.isInteger(rowNum) || rowNum <= 0) continue;

    for (const [cellNum, colIdx] of Object.entries(opts.cellMap)) {
      const bushes = row[colIdx];
      if (typeof bushes === 'number' && bushes > 0 && Number.isInteger(bushes)) {
        if (!cells[cellNum]) cells[cellNum] = [];
        cells[cellNum].push({ row: rowNum, bushes });
      }
    }
  }

  // Сортируем ряды по возрастанию
  for (const k of Object.keys(cells)) {
    cells[k].sort((a, b) => a.row - b.row);
  }
  return cells;
}

// === Файл 2016 года: кварталы 1, 2, 3, 4 ===
{
  const wb = XLSX.readFile('Инвент. 2025 г.Жемчужина  2016год.xlsx');

  // Квартал 1 (Каберне совиньон), колонки A=пусто, B=№ряда, C-F=клетки 1-4
  const sh1 = wb.Sheets['Кв. 1 каберне совиньон'];
  const cells1 = extractCells(sh1, {
    rowCol: 1, // колонка B
    dataStartRow: 3,
    cellMap: { '1': 2, '2': 3, '3': 4, '4': 5 }
  });
  inventory.quarters['1'] = { name: 'Кв. 1 Каберне совиньон', cells: cells1 };

  // Квартал 2 (Совиньон белый)
  const sh2 = wb.Sheets['Кв. 2 совиньон белый '];
  const cells2 = extractCells(sh2, {
    rowCol: 1,
    dataStartRow: 3,
    cellMap: { '1': 2, '2': 3, '3': 4, '4': 5 }
  });
  inventory.quarters['2'] = { name: 'Кв. 2 Совиньон белый', cells: cells2 };

  // Кварталы 3 и 4 (общий лист "3-4 Колекция", диапазон B1:J737 — нет колонки A)
  // Индексы (после sheet_to_json): 0=№ряда, 1-4=кв.3 клетки 1-4, 5-7=кв.4 клетки 1-3, 8=Итого
  const sh34 = wb.Sheets['3-4 Колекция'];
  const cells3 = extractCells(sh34, {
    rowCol: 0,
    dataStartRow: 3,
    cellMap: { '1': 1, '2': 2, '3': 3, '4': 4 }
  });
  inventory.quarters['3'] = { name: 'Кв. 3 Мерло', cells: cells3 };

  const cells4 = extractCells(sh34, {
    rowCol: 0,
    dataStartRow: 3,
    cellMap: { '1': 5, '2': 6, '3': 7 }
  });
  inventory.quarters['4'] = { name: 'Кв. 4 Пино нуар', cells: cells4 };
}

// === Файл 2020 года: кварталы 8, 9, 10 ===
{
  const wb = XLSX.readFile('Инвен.2025  г. Жемчужина  2020 год.xlsx');

  // Квартал 8 (Мерло), колонки: A-C пусто/сорт/№ряда, D-G = клетки 1-4
  // По логу: ["сорт","№ряда","Клетка 1","Клетка 2","Клетка 3","Клетка 4","Итого"]
  // Колонки сдвинуты от A — заголовок в колонках A=сорт(индекс0), B=№ряда(1), C-F=клетки(2-5)
  const sh8 = wb.Sheets['ПОсадка 2020г кв.8'];
  const cells8 = extractCells(sh8, {
    rowCol: 1,
    dataStartRow: 2,
    cellMap: { '1': 2, '2': 3, '3': 4, '4': 5 }
  });
  inventory.quarters['8'] = { name: 'Кв. 8 Мерло', cells: cells8 };

  // Квартал 9 (Ркацители, Рислинг рейнский), 11 клеток
  // Заголовок: ["ряда", 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, "Итог"]
  // Колонка 0 = №ряда, колонки 1-11 = клетки 1-11
  const sh9 = wb.Sheets['Посадка 2020г кв.9 (2)'];
  const cells9 = extractCells(sh9, {
    rowCol: 0,
    dataStartRow: 3,
    cellMap: {
      '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6,
      '7': 7, '8': 8, '9': 9, '10': 10, '11': 11
    }
  });
  inventory.quarters['9'] = { name: 'Кв. 9 Ркацители/Рислинг', cells: cells9 };

  // Квартал 10, 14 клеток
  // Заголовок: ["№ кварт.","№ ряда","клетка 1",...,"клетка 14","Итого"]
  // Колонки: 0=№кварт, 1=№ряда, 2-15=клетки 1-14
  const sh10 = wb.Sheets['Посадка 2020 г кв.10 '];
  const cells10 = extractCells(sh10, {
    rowCol: 1,
    dataStartRow: 3,
    cellMap: {
      '1': 2, '2': 3, '3': 4, '4': 5, '5': 6, '6': 7, '7': 8,
      '8': 9, '9': 10, '10': 11, '11': 12, '12': 13, '13': 14, '14': 15
    }
  });
  inventory.quarters['10'] = { name: 'Кв. 10 (молодой)', cells: cells10 };
}

// Печатаем сводку
console.log('=== Итоги парсинга ===');
let totalBushes = 0;
for (const [qid, q] of Object.entries(inventory.quarters)) {
  let qBushes = 0;
  let qRows = 0;
  for (const [cid, rows] of Object.entries(q.cells)) {
    for (const r of rows) qBushes += r.bushes;
    qRows += rows.length;
  }
  totalBushes += qBushes;
  const cellList = Object.keys(q.cells).sort((a,b)=>+a-+b).join(', ');
  console.log(`Квартал ${qid} (${q.name}): клеток=${Object.keys(q.cells).length} [${cellList}], строк-ряды=${qRows}, всего кустов=${qBushes}`);
}
console.log(`\nВСЕГО кустов в инвентаризации: ${totalBushes}`);

fs.writeFileSync('inventory.json', JSON.stringify(inventory, null, 2), 'utf8');
console.log('\n✅ inventory.json перезаписан');
