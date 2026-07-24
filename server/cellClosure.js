'use strict';

function canCloseCell({ fullyDone, closed }) {
  return !!fullyDone && !closed;
}

function closureStatusLabel({ closed, fullyDone, disputedCount, missedRowsLength }) {
  if (closed) return 'Закрыта';
  if ((disputedCount || 0) > 0) return 'Есть спорные';
  if ((missedRowsLength || 0) > 0) return 'Есть пропуски';
  if (fullyDone) return 'Готова';
  return 'В работе';
}

module.exports = { canCloseCell, closureStatusLabel };
