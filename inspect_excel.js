const XLSX = require('xlsx');
const fs = require('fs');

const files = [
  'Инвен.2025  г. Жемчужина  2020 год.xlsx',
  'Инвент. 2025 г.Жемчужина  2016год.xlsx'
];

for (const fname of files) {
  console.log('\n===== Файл:', fname, '=====');
  const wb = XLSX.readFile(fname);
  console.log('Листы:', wb.SheetNames);

  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName];
    const range = XLSX.utils.decode_range(sheet['!ref'] || 'A1:A1');
    console.log(`\n  Лист "${sheetName}": диапазон ${sheet['!ref']}, строк=${range.e.r - range.s.r + 1}, колонок=${range.e.c - range.s.c + 1}`);

    // Печатаем первые 5 строк для понимания структуры
    const data = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, blankrows: false });
    console.log('  Первые 5 строк (заголовки и начало):');
    for (let i = 0; i < Math.min(5, data.length); i++) {
      console.log(`    [${i}]`, JSON.stringify(data[i]));
    }
    console.log(`  Всего непустых строк: ${data.length}`);
    if (data.length > 5) {
      console.log('  Последние 3 строки:');
      for (let i = Math.max(5, data.length - 3); i < data.length; i++) {
        console.log(`    [${i}]`, JSON.stringify(data[i]));
      }
    }
  }
}
