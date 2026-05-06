const DataParser = require('./server/parser');
const inv = JSON.parse(require('fs').readFileSync('./inventory.json', 'utf8'));
const p = new DataParser(inv);

const tests = [
  ['Одна строка с диапазоном',
    'квартал 9 клетка 1 иванов с первого по второй ряд'],
  ['Две строки — вторая БЕЗ повтора квартала',
    'квартал 9 клетка 1 иванов с 1 по 2\nЛена с 3 по 4'],
  ['Три строки — продолжения',
    'квартал 1 клетка 1 петров с 1 по 5\nИванова с 6 по 10\nСидоров с 11 по 15'],
  ['Старый строгий формат',
    'Квартал 9, Клетка 1: Иванов - с 1 по 2; Петров - 3, 4'],
  ['Смешанный: голос потом строгий',
    'квартал 1 клетка 2 иванов с 1 по 3\nКвартал 2, Клетка 1: Петров - с 5 по 7'],
];

for (const [desc, input] of tests) {
  console.log('\n--- ' + desc + ' ---');
  console.log('INPUT:', JSON.stringify(input));
  try {
    const r = p.parse(input, '2026-05-07');
    for (const e of r.entries) {
      console.log('  ✓ ' + e.employee + ' (кв.' + e.quarter + ', кл.' + e.cell + ', ряды [' + e.rows.join(',') + ']) = ' + e.bushes + ' кустов');
    }
  } catch (e) {
    console.log('  ✗ ERR: ' + e.message);
  }
}
