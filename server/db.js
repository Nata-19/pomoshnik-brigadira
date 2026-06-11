// Выполняет fn(client) внутри транзакции. COMMIT при успехе, ROLLBACK при ошибке.
// Клиент всегда освобождается. Результат fn пробрасывается наверх.
// db (аргумент fn) — клиент транзакции с методом .query(...).
async function withTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* откат — лучшее усилие */ }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { withTransaction };
