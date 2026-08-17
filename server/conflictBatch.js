const { withTransaction } = require('./db');

// Единственная точка транзакционной обработки группы: ошибка любого ряда
// приводит к ROLLBACK всего диапазона.
async function applyBatchAtomically(pool, rows, applyRow) {
  return withTransaction(pool, async (client) => {
    const results = [];
    for (const row of rows) results.push(await applyRow(client, row));
    return results;
  });
}

module.exports = { applyBatchAtomically };
