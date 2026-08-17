const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function makeAssistant() {
  const filename = path.join(__dirname, '../public/js/app.js');
  const source = fs.readFileSync(filename, 'utf8').replace(
    /const app = new BrigadeAssistant\(\);\s*$/,
    'globalThis.BrigadeAssistant = BrigadeAssistant;'
  );
  const context = { console };
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename });
  return Object.create(context.BrigadeAssistant.prototype);
}

test('инвентарь всех кварталов загружается заранее для офлайн-выбора клетки', async () => {
  const app = makeAssistant();
  app.estate = 'vineyard';
  app.quarters = [{ id: '1' }, { id: '2' }, { id: '3' }];
  const requested = [];
  app.loadCells = async (quarterId) => {
    requested.push(String(quarterId));
    if (String(quarterId) === '2') throw new Error('temporary network error');
    return ['1'];
  };

  await app.preloadCells();

  assert.deepEqual(requested.sort(), ['1', '2', '3']);
});

test('предзагрузка инвентаря безопасна до выбора культуры', async () => {
  const app = makeAssistant();
  app.estate = '';
  app.quarters = [{ id: '1' }];
  let requested = false;
  app.loadCells = async () => { requested = true; };

  await app.preloadCells();

  assert.equal(requested, false);
});
