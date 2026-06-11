const test = require('node:test');
const assert = require('node:assert/strict');
const { withTransaction } = require('../server/db');

// Фейковый клиент: пишет все SQL-вызовы в calls; release() помечает released.
// Если задан failOn — query с таким текстом бросает ошибку (имитация сбоя).
function makeFakeClient(opts = {}) {
  const state = { calls: [], released: false };
  const client = {
    state,
    async query(sql) {
      state.calls.push(sql);
      if (opts.failOn && sql === opts.failOn) {
        throw new Error('fail:' + sql);
      }
      return { rows: [] };
    },
    release() { state.released = true; },
  };
  return client;
}

function makeFakePool(client) {
  return { async connect() { return client; } };
}

test('withTransaction: успех → BEGIN, работа, COMMIT; release; результат проброшен', async () => {
  const client = makeFakeClient();
  const pool = makeFakePool(client);
  const result = await withTransaction(pool, async (db) => {
    await db.query('INSERT 1');
    return 'ok';
  });
  assert.equal(result, 'ok');
  assert.deepEqual(client.state.calls, ['BEGIN', 'INSERT 1', 'COMMIT']);
  assert.equal(client.state.released, true);
});

test('withTransaction: fn бросает → BEGIN, ROLLBACK (без COMMIT); ошибка проброшена; release', async () => {
  const client = makeFakeClient();
  const pool = makeFakePool(client);
  await assert.rejects(
    () => withTransaction(pool, async (db) => {
      await db.query('INSERT 1');
      throw new Error('boom');
    }),
    /boom/
  );
  assert.deepEqual(client.state.calls, ['BEGIN', 'INSERT 1', 'ROLLBACK']);
  assert.ok(!client.state.calls.includes('COMMIT'), 'COMMIT не должен вызываться');
  assert.equal(client.state.released, true);
});

test('withTransaction: сбой самого ROLLBACK не маскирует исходную ошибку; release всё равно', async () => {
  const client = makeFakeClient({ failOn: 'ROLLBACK' });
  const pool = makeFakePool(client);
  await assert.rejects(
    () => withTransaction(pool, async (db) => {
      await db.query('INSERT 1');
      throw new Error('original');
    }),
    /original/   // проброшена исходная ошибка fn, не ошибка ROLLBACK
  );
  assert.equal(client.state.released, true);
});
