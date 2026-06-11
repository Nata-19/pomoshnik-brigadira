# Транзакции для путей разрешения рядов — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Обернуть многозаписьные обработчики разрешения рядов в БД-транзакции, чтобы сбой посреди серии откатывался целиком (никаких «полузаписей»). Поведение для пользователя не меняется.

**Architecture:** Новый изолированный helper `withTransaction(pool, fn)` в `server/db.js` (BEGIN→fn(client)→COMMIT, при ошибке ROLLBACK+проброс, release всегда). Три общих хелпера (`applyRowRemoval`, `insertDisputed`, `upsertWorkLog`) принимают «исполнитель запросов» `db` первым аргументом (клиент транзакции или сам pool). Два реальных многозаписьных пути оборачиваются в `withTransaction`; пишущие запросы и гейтящие SELECT идут через `client`, валидация и чтение инвентаря/парсера — вне транзакции.

**Tech Stack:** Node.js, Express, PostgreSQL (`pg` Pool), `node --test` (встроенный раннер).

---

## ⚠️ Поправка спека↔код (важно для исполнителя)

Спека (`docs/superpowers/specs/2026-06-10-transaction-hardening-design.md`, §2) перечисляет **три** пути, включая «`POST /api/logs` — ветка деления». Сверка с реальным кодом `origin/main` (база этого worktree, f1cd93d) показала:

- **`POST /api/logs`** (server.js:1086) на самом деле **однозаписьный**: детект конфликтов (чистое чтение) + дедуп-`SELECT` + **один** `INSERT` свободных рядов. «Полузаписи» здесь быть не может. Транзакция ничего не добавляет (дедуп-гонку READ COMMITTED всё равно не закрывает — нет уникального индекса). **НЕ оборачиваем** (YAGNI).
- «Ветка деления (divide)» из спеки физически находится **внутри `POST /api/logs/resolve`** (server.js:1352), а не в `POST /api/logs`.

Итог: реальных многозаписьных путей **ДВА** —
1. **`POST /api/logs/resolve`** (server.js:1258) — `reassign` / `postpone` / `divide`.
2. **`POST /api/disputed/:id/resolve`** (server.js:1534) — `assign-actual` / `return-first`.

Цель спеки (атомарность всех серий записи) полностью достигается обёрткой этих двух путей.

**Номера строк** даны по f1cd93d для ориентира; после Task 1–2 они почти не сдвинутся (db.js — новый файл; рефактор хелперов не добавляет строк). В Task 3–4 ищи места по приведённым уникальным строкам кода, а не только по номеру.

---

## File Structure

- **Create** `server/db.js` — крошечный модуль с единственной экспортируемой функцией `withTransaction(pool, fn)`. Без побочных эффектов, без подключения к реальной БД, без зависимостей от `server.js`. Тестируется изолированно.
- **Create** `test/db.test.js` — юнит-тесты `withTransaction` с фейковым pool/client.
- **Modify** `server/server.js`:
  - добавить `require('./db')` к верхним локальным require (после строки 8);
  - рефактор 3 хелперов `applyRowRemoval` / `insertDisputed` / `upsertWorkLog` (строки 999–1083) — `db` первым параметром, внутри `pool.query`→`db.query`;
  - обновить все 7 вызовов хелперов (изначально передают `pool` — без смены поведения);
  - обернуть `POST /api/logs/resolve` (1258) и `POST /api/disputed/:id/resolve` (1534) в `withTransaction`, заменив на этих путях `pool`→`client` и сделав внешние `catch` чувствительными к `error.httpStatus`.

**Тесты обработчиков:** в репозитории нет интеграционных тестов с реальной БД (тесты покрывают только чистые модули — `rowControl`). Поэтому автоматическая проверка Task 3–4 = `node --check server/server.js` (синтаксис) + `node --test` остаётся зелёным (40 + новые тесты из Task 1). Поведение путей проверяется **вручную на демо** при выкате (так и записано в спеке §5). НЕ пиши интеграционные тесты против БД — её в тестовой среде нет.

---

## Task 1: Helper `withTransaction` + юнит-тесты

**Files:**
- Create: `server/db.js`
- Test: `test/db.test.js`

- [ ] **Step 1: Написать падающие тесты**

Создай `test/db.test.js`:

```js
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
```

- [ ] **Step 2: Запустить тесты — убедиться, что падают**

Run: `node --test test/db.test.js`
Expected: FAIL — `Cannot find module '../server/db'` (модуль ещё не создан).

- [ ] **Step 3: Написать минимальную реализацию**

Создай `server/db.js`:

```js
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
```

- [ ] **Step 4: Запустить тесты — убедиться, что проходят**

Run: `node --test test/db.test.js`
Expected: PASS — 3 теста.

- [ ] **Step 5: Прогнать весь набор и синтаксис**

Run: `node --test` → ожидаем 43 passing, 0 fail (было 40 + 3 новых).
Run: `node --check server/db.js` → без вывода (ок).

- [ ] **Step 6: Коммит**

```bash
git add server/db.js test/db.test.js
git commit -m "feat(db): helper withTransaction + юнит-тесты"
```

---

## Task 2: Рефактор 3 хелперов под `db`-первый-аргумент (без смены поведения)

Цель: хелперы перестают обращаться к глобальному `pool` напрямую — принимают `db` (клиент или pool) первым аргументом. На этом шаге **все вызовы передают `pool`**, поэтому поведение идентично и все тесты остаются зелёными. Обёртка путей — в Task 3–4.

**Files:**
- Modify: `server/server.js` (хелперы 999–1083; добавить require; вызовы 1330,1335,1340,1344,1407,1416,1619)

- [ ] **Step 1: Подключить модуль db**

Найди (server.js:8):

```js
const rowControl = require('./rowControl');
```

Замени на:

```js
const rowControl = require('./rowControl');
const { withTransaction } = require('./db');
```

- [ ] **Step 2: `applyRowRemoval` — db-параметр + db.query**

Найди сигнатуру (server.js:999):

```js
async function applyRowRemoval(ownerCol, ownerVal, logId, rowNum, rowBushes) {
  const rec = await pool.query(
```

Замени первые две строки на:

```js
async function applyRowRemoval(db, ownerCol, ownerVal, logId, rowNum, rowBushes) {
  const rec = await db.query(
```

В теле этой же функции замени оставшиеся два `await pool.query(` на `await db.query(` (строки удаления и обновления — `DELETE FROM work_logs ...` и `UPDATE work_logs SET rows = $1 ...`). После правки в `applyRowRemoval` НЕ должно остаться `pool.query`.

- [ ] **Step 3: `insertDisputed` — db-параметр + db.query**

Найди сигнатуру (server.js:1021):

```js
async function insertDisputed(d, owner, req) {
```

Замени на:

```js
async function insertDisputed(db, d, owner, req) {
```

Внутри функции замени оба `await pool.query(` на `await db.query(` (демо-INSERT и прод-INSERT в `disputed_rows`).

- [ ] **Step 4: `upsertWorkLog` — db-параметр + db.query**

Найди сигнатуру (server.js:1046):

```js
async function upsertWorkLog(ownerCol, ownerVal, req, ctx, emp, rowNum, bushes, weight) {
  const ex = await pool.query(
```

Замени на:

```js
async function upsertWorkLog(db, ownerCol, ownerVal, req, ctx, emp, rowNum, bushes, weight) {
  const ex = await db.query(
```

В теле замени оставшиеся три `await pool.query(` на `await db.query(` (UPDATE существующей записи + демо-INSERT + прод-INSERT). После правки в `upsertWorkLog` НЕ должно остаться `pool.query`.

- [ ] **Step 5: Обновить все 7 вызовов — передать `pool` первым аргументом**

Это механическая правка: к каждому вызову добавь `pool, ` в начало аргументов. Точные замены:

server.js:1330 (reassign):
```js
const removed = await applyRowRemoval(owner.col, owner.val, fid, rowNum, rowBushes);
```
→
```js
const removed = await applyRowRemoval(pool, owner.col, owner.val, fid, rowNum, rowBushes);
```

server.js:1335 (reassign):
```js
await upsertWorkLog(owner.col, owner.val, req, ctx, employee.trim(), rowNum, rowBushes, 1);
```
→
```js
await upsertWorkLog(pool, owner.col, owner.val, req, ctx, employee.trim(), rowNum, rowBushes, 1);
```

server.js:1340 (postpone):
```js
const removed = await applyRowRemoval(owner.col, owner.val, fid, rowNum, rowBushes);
```
→
```js
const removed = await applyRowRemoval(pool, owner.col, owner.val, fid, rowNum, rowBushes);
```

server.js:1344 (postpone) — добавь `pool` первым аргументом к `insertDisputed`:
```js
      await insertDisputed({
```
→
```js
      await insertDisputed(pool, {
```

server.js:1407 (divide):
```js
const ok = await applyRowRemoval(owner.col, owner.val, h.id, rowNum, rowBushes);
```
→
```js
const ok = await applyRowRemoval(pool, owner.col, owner.val, h.id, rowNum, rowBushes);
```

server.js:1416 (divide):
```js
await upsertWorkLog(owner.col, owner.val, req, ctx, a.employee, rowNum, a.bushes, a.weight);
```
→
```js
await upsertWorkLog(pool, owner.col, owner.val, req, ctx, a.employee, rowNum, a.bushes, a.weight);
```

server.js:1619 (disputed-resolve):
```js
await upsertWorkLog(owner.col, owner.val, req, ctx, a.employee, d.row_num, a.bushes, a.weight);
```
→
```js
await upsertWorkLog(pool, owner.col, owner.val, req, ctx, a.employee, d.row_num, a.bushes, a.weight);
```

- [ ] **Step 6: Проверка — никаких осиротевших pool.query в хелперах, синтаксис, тесты**

Run: `node --check server/server.js` → без вывода.
Run: `node --test` → 43 passing, 0 fail (поведение не изменилось).
Сверь глазами: в телах `applyRowRemoval`, `insertDisputed`, `upsertWorkLog` все обращения теперь `db.query`, а 7 вызовов передают `pool` первым аргументом.

- [ ] **Step 7: Коммит**

```bash
git add server/server.js
git commit -m "refactor(rows): хелперы принимают db первым аргументом (поведение прежнее)"
```

---

## Task 3: Обернуть `POST /api/logs/resolve` в транзакции

В каждой ветке (`reassign` / `postpone` / `divide`) пишущая серия + гейтящий SELECT уходят внутрь `withTransaction(pool, async (client) => {...})`; вызовы хелперов и прямые запросы на этом пути используют `client`. Валидация, расчёт кустов/весов и чтение инвентаря остаются снаружи. 409-гейты, срабатывающие до фактической записи, реализуются броском ошибки с `httpStatus` (откат — no-op, ничего ещё не записано), который ловит внешний `catch`.

**Files:**
- Modify: `server/server.js` (`POST /api/logs/resolve`, 1258–1426)

- [ ] **Step 1: Сделать внешний `catch` чувствительным к httpStatus**

Найди (server.js:1422, конец `/api/logs/resolve`):

```js
  } catch (error) {
    console.error('Resolve error:', error);
    res.status(500).json({ error: error.message });
  }
});
```

Замени на:

```js
  } catch (error) {
    if (error && error.httpStatus) {
      return res.status(error.httpStatus).json({ error: error.message });
    }
    console.error('Resolve error:', error);
    res.status(500).json({ error: error.message });
  }
});
```

- [ ] **Step 2: Обернуть ветку `reassign`**

Найди блок (server.js:1326–1336):

```js
      if (action === 'reassign') {
        if (firstRec.rows[0].employee === employee.trim()) {
          return res.status(400).json({ error: 'Ряд уже записан на этого рабочего' });
        }
        const removed = await applyRowRemoval(pool, owner.col, owner.val, fid, rowNum, rowBushes);
        if (!removed) {
          return res.status(409).json({ error: 'Ряд уже снят с первого рабочего' });
        }
        // Ряд целиком — второму рабочему (одна плашка: слияние с его записью).
        await upsertWorkLog(pool, owner.col, owner.val, req, ctx, employee.trim(), rowNum, rowBushes, 1);
        return res.json({ success: true });
      }
```

Замени на:

```js
      if (action === 'reassign') {
        if (firstRec.rows[0].employee === employee.trim()) {
          return res.status(400).json({ error: 'Ряд уже записан на этого рабочего' });
        }
        await withTransaction(pool, async (client) => {
          const removed = await applyRowRemoval(client, owner.col, owner.val, fid, rowNum, rowBushes);
          if (!removed) {
            const e = new Error('Ряд уже снят с первого рабочего');
            e.httpStatus = 409;
            throw e;
          }
          // Ряд целиком — второму рабочему (одна плашка: слияние с его записью).
          await upsertWorkLog(client, owner.col, owner.val, req, ctx, employee.trim(), rowNum, rowBushes, 1);
        });
        return res.json({ success: true });
      }
```

- [ ] **Step 3: Обернуть ветку `postpone`**

Найди блок (server.js:1339–1349):

```js
      // postpone: снимаем ряд с первого; если снять нечего — 409; иначе в «Спорные».
      const removed = await applyRowRemoval(pool, owner.col, owner.val, fid, rowNum, rowBushes);
      if (!removed) {
        return res.status(409).json({ error: 'Ряд уже снят с первого рабочего' });
      }
      await insertDisputed(pool, {
        estate, quarter: String(quarter), cell: String(cell),
        work_type: work_type.trim(), row_num: rowNum, measure_mode,
        claimed_by: firstRec.rows[0].employee, claimed_date: firstRec.rows[0].date,
      }, owner, req);
      return res.json({ success: true });
```

Замени на:

```js
      // postpone: снимаем ряд с первого; если снять нечего — 409; иначе в «Спорные».
      await withTransaction(pool, async (client) => {
        const removed = await applyRowRemoval(client, owner.col, owner.val, fid, rowNum, rowBushes);
        if (!removed) {
          const e = new Error('Ряд уже снят с первого рабочего');
          e.httpStatus = 409;
          throw e;
        }
        await insertDisputed(client, {
          estate, quarter: String(quarter), cell: String(cell),
          work_type: work_type.trim(), row_num: rowNum, measure_mode,
          claimed_by: firstRec.rows[0].employee, claimed_date: firstRec.rows[0].date,
        }, owner, req);
      });
      return res.json({ success: true });
```

Примечание: `firstRec` (гейтящий SELECT) остаётся снаружи транзакции — он питает 404-гейт и чистые данные (`employee`/`date`), которые лишь передаются внутрь; сама запись (`applyRowRemoval` + `insertDisputed`) обёрнута.

- [ ] **Step 4: Обернуть ветку `divide`**

Найди блок (server.js:1393–1418) — от комментария про снятие держателей до `return res.json`:

```js
      // Снимаем ряд со всех держателей этого разреза — БЕЗ фильтра по дате:
      // при делении «другой день» запись занявшего лежит на другую дату, а при
      // повторном делении держателей может быть несколько. id уникален, разрез
      // (владелец+хозяйство+квартал+клетка+вид работ+режим) ограничивает выборку.
      const holders = await pool.query(
        `SELECT id, rows FROM work_logs
         WHERE ${owner.col} = $1 AND estate_id = $2
           AND quarter = $3 AND cell = $4 AND work_type = $5 AND measure_mode = $6`,
        [owner.val, estate, String(quarter), String(cell), work_type.trim(), measure_mode]
      );
      let strippedAny = false;
      for (const h of holders.rows) {
        const nums = String(h.rows || '').split(',').map((s) => parseInt(s, 10)).filter((n) => Number.isInteger(n));
        if (nums.includes(rowNum)) {
          const ok = await applyRowRemoval(pool, owner.col, owner.val, h.id, rowNum, rowBushes);
          if (ok) strippedAny = true;
        }
      }
      if (!strippedAny) {
        return res.status(409).json({ error: 'Ряд уже снят' });
      }

      for (const a of toAssign) {
        await upsertWorkLog(pool, owner.col, owner.val, req, ctx, a.employee, rowNum, a.bushes, a.weight);
      }
      return res.json({ success: true });
```

Замени на:

```js
      // Снимаем ряд со всех держателей этого разреза — БЕЗ фильтра по дате:
      // при делении «другой день» запись занявшего лежит на другую дату, а при
      // повторном делении держателей может быть несколько. id уникален, разрез
      // (владелец+хозяйство+квартал+клетка+вид работ+режим) ограничивает выборку.
      await withTransaction(pool, async (client) => {
        const holders = await client.query(
          `SELECT id, rows FROM work_logs
           WHERE ${owner.col} = $1 AND estate_id = $2
             AND quarter = $3 AND cell = $4 AND work_type = $5 AND measure_mode = $6`,
          [owner.val, estate, String(quarter), String(cell), work_type.trim(), measure_mode]
        );
        let strippedAny = false;
        for (const h of holders.rows) {
          const nums = String(h.rows || '').split(',').map((s) => parseInt(s, 10)).filter((n) => Number.isInteger(n));
          if (nums.includes(rowNum)) {
            const ok = await applyRowRemoval(client, owner.col, owner.val, h.id, rowNum, rowBushes);
            if (ok) strippedAny = true;
          }
        }
        if (!strippedAny) {
          const e = new Error('Ряд уже снят');
          e.httpStatus = 409;
          throw e;
        }

        for (const a of toAssign) {
          await upsertWorkLog(client, owner.col, owner.val, req, ctx, a.employee, rowNum, a.bushes, a.weight);
        }
      });
      return res.json({ success: true });
```

- [ ] **Step 5: Проверка**

Run: `node --check server/server.js` → без вывода.
Run: `node --test` → 43 passing, 0 fail (чистые модули не затронуты).
Сверь глазами: в `/api/logs/resolve` все три ветки используют `client` (не `pool`) для `applyRowRemoval`/`insertDisputed`/`upsertWorkLog` и прямого `holders`-SELECT; `firstRec`-SELECT и расчёт `rowBushes`/`toAssign` остались снаружи `withTransaction`.

- [ ] **Step 6: Коммит**

```bash
git add server/server.js
git commit -m "feat(rows): транзакции в /api/logs/resolve (reassign/postpone/divide)"
```

---

## Task 4: Обернуть `POST /api/disputed/:id/resolve` в транзакцию

Атомарная единица — цикл `upsertWorkLog` (раздача долей рабочим) + `DELETE` спорного ряда. Гейтящий SELECT `rec` остаётся снаружи: он питает 404-гейт и чтение инвентаря/расчёт `toInsert`, которые по спеке (§4) идут вне транзакции. `d.*` лишь передаются внутрь.

**Files:**
- Modify: `server/server.js` (`POST /api/disputed/:id/resolve`, 1534–1631)

- [ ] **Step 1: Обернуть запись + удаление**

Найди блок (server.js:1618–1626):

```js
    for (const a of toInsert) {
      await upsertWorkLog(pool, owner.col, owner.val, req, ctx, a.employee, d.row_num, a.bushes, a.weight);
    }

    await pool.query(
      `DELETE FROM disputed_rows WHERE id = $1 AND ${owner.col} = $2`,
      [id, owner.val]
    );
    res.json({ success: true });
```

Замени на:

```js
    await withTransaction(pool, async (client) => {
      for (const a of toInsert) {
        await upsertWorkLog(client, owner.col, owner.val, req, ctx, a.employee, d.row_num, a.bushes, a.weight);
      }
      await client.query(
        `DELETE FROM disputed_rows WHERE id = $1 AND ${owner.col} = $2`,
        [id, owner.val]
      );
    });
    res.json({ success: true });
```

- [ ] **Step 2: Сделать внешний `catch` чувствительным к httpStatus (консистентность)**

Найди (server.js:1627, конец `/api/disputed/:id/resolve`):

```js
  } catch (error) {
    console.error('Disputed resolve error:', error);
    res.status(500).json({ error: error.message });
  }
});
```

Замени на:

```js
  } catch (error) {
    if (error && error.httpStatus) {
      return res.status(error.httpStatus).json({ error: error.message });
    }
    console.error('Disputed resolve error:', error);
    res.status(500).json({ error: error.message });
  }
});
```

- [ ] **Step 3: Проверка**

Run: `node --check server/server.js` → без вывода.
Run: `node --test` → 43 passing, 0 fail.
Сверь глазами: цикл `upsertWorkLog` и `DELETE FROM disputed_rows` теперь внутри `withTransaction` и используют `client`; `rec`-SELECT, чтение инвентаря и расчёт `toInsert` — снаружи.

- [ ] **Step 4: Коммит**

```bash
git add server/server.js
git commit -m "feat(rows): транзакция в /api/disputed/:id/resolve (запись долей + удаление спорного)"
```

---

## Финальная проверка (после всех задач)

- [ ] `node --test` → 43 passing, 0 fail.
- [ ] `node --check server/server.js` и `node --check server/db.js` — без вывода.
- [ ] Grep-самоконтроль: внутри `/api/logs/resolve` и `/api/disputed/:id/resolve` не осталось `pool.query`/`applyRowRemoval(pool`/`insertDisputed(pool`/`upsertWorkLog(pool` (всё переведено на `client`). Хелперы при этом по-прежнему умеют принимать любой `db` (на случай будущих вызовов вне транзакции).
- [ ] Холистическое ревью всей ветки.

**Ручная проверка при выкате (по спеке §5):** на демо обычные деление ряда / переписать / отложить / разбор спорного работают как прежде, кусты сходятся, дублей нет — видимых изменений быть не должно.

---

## Что НЕ делаем (YAGNI, из спеки §6)

- `POST /api/logs` не оборачиваем (однозаписьный — см. поправку выше).
- Прочие однозаписьные обработчики не трогаем.
- Ретраи при сериализационных конфликтах не добавляем.
- Коды/тексты ответов и поведение для пользователя не меняем.
- Схему/миграции БД не трогаем.
