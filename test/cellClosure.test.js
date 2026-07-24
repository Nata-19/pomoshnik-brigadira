const test = require('node:test');
const assert = require('node:assert/strict');
const { canCloseCell, closureStatusLabel } = require('../server/cellClosure');

test('canCloseCell: только fullyDone и не closed', () => {
  assert.equal(canCloseCell({ fullyDone: true, closed: false }), true);
  assert.equal(canCloseCell({ fullyDone: true, closed: true }), false);
  assert.equal(canCloseCell({ fullyDone: false, closed: false }), false);
});

test('closureStatusLabel: приоритет closed > спорные > пропуски > готова', () => {
  assert.equal(closureStatusLabel({ closed: true, fullyDone: true, disputedCount: 0, missedRowsLength: 0 }), 'Закрыта');
  assert.equal(closureStatusLabel({ closed: false, fullyDone: false, disputedCount: 2, missedRowsLength: 1 }), 'Есть спорные');
  assert.equal(closureStatusLabel({ closed: false, fullyDone: false, disputedCount: 0, missedRowsLength: 3 }), 'Есть пропуски');
  assert.equal(closureStatusLabel({ closed: false, fullyDone: true, disputedCount: 0, missedRowsLength: 0 }), 'Готова');
});
