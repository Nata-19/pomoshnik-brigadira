# Контроль рядов — Фаза 2 (Спорные ряды + широкое меню «разные дни») Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Достроить конфликт «разные дни» до полного меню (отменить / отложить в спорные / переписать на другого / поделить) и добавить сущность «Спорные ряды» с экраном их разбора.

**Architecture:** Один демо-осознанный кодовый ствол (как Фаза 1): сервер ветвится по `DEMO_MODE` (владелец `demo_session_id` либо `brigadier_id`). Чистая логика — в `server/rowControl.js` (юнит-тесты `node --test`), HTTP/БД — в `server/server.js`, UI — в `public/js/app.js`. Новая таблица `disputed_rows` создаётся идемпотентно при старте. План пишется против ствола `origin/main`; перенос в демо — последняя задача.

**Tech Stack:** Node.js/Express, PostgreSQL (`pg`), ванильный JS PWA-клиент, `node --test`.

**Спека:** `docs/superpowers/specs/2026-06-04-row-control-design.md` (разделы 8–9). Раздел 10/12 (пропущенные ряды, уникальные ряды в отчёте) — это Фаза 3, в этот план НЕ входит.

**Ключевые решения по объёму (YAGNI):**
- Пересчёт кустов при снятии ряда = `текущие_кусты − кусты_снимаемого_ряда_по_инвентаризации` (с полом 0). Это сохраняет ранее заданные вручную доли «best-effort» и совпадает с уже работающим `split` (`bushes − parts.second`). Полный перерасчёт по инвентаризации не делаем — он затёр бы ручные доли.
- Из «Спорных» ряд можно записать на **одного или нескольких** рабочих — выбор за бригадиром. При нескольких кусты ряда делятся: по умолчанию поровну (остаток первым), с возможностью задать долю каждому вручную. Ряд при этом считается **одним** (сделан один раз), кусты — суммой долей.
- Действие «переписать на другого» (`reassign`) полностью заменяет прежний `assign` («записать на текущего, не трогая первого») — в спеке раздела 8 варианта «оба оставляют» нет. `assign` удаляется.
- Колонка номера ряда в новой таблице называется `row_num` (не `row` — `ROW` зарезервировано в PostgreSQL).

---

## File Structure

- `server/rowControl.js` (modify) — добавить чистую `removeRowFromRecord(...)`.
- `test/rowControl.test.js` (modify) — тесты на `removeRowFromRecord`.
- `server/server.js` (modify) — таблица `disputed_rows`; серверный хелпер снятия ряда; новые действия `reassign`/`postpone` в `/api/logs/resolve`; удалить `assign`; новые endpoint'ы `GET /api/disputed` и `POST /api/disputed/:id/resolve`.
- `public/js/app.js` (modify) — меню «разные дни» из 4 действий; вкладка «Спорные» + загрузка/рендер/разбор.
- `public/styles.css` (modify) — пара классов для вторичных кнопок модалки.

---

## Task 1: Чистая функция снятия ряда из записи

**Files:**
- Modify: `server/rowControl.js`
- Test: `test/rowControl.test.js`

- [ ] **Step 1: Написать падающие тесты**

Добавить в конец `test/rowControl.test.js` (перед возможным завершающим кодом; файл использует `node:test` и `node:assert`, и уже импортирует из `../server/rowControl`). Сначала расширить строку импорта, затем добавить тесты.

Найти существующую строку импорта:
```js
const { splitBushes, classifyRows } = require('../server/rowControl');
```
Заменить на:
```js
const { splitBushes, classifyRows, removeRowFromRecord, distributeBushes } = require('../server/rowControl');
```

Добавить тесты в конец файла:
```js
test('removeRowFromRecord: убирает ряд из середины и вычитает его кусты', () => {
  const out = removeRowFromRecord('1,2,3,4,5', 685, 3, 140);
  assert.strictEqual(out.rows, '1,2,4,5');
  assert.strictEqual(out.bushes, 545);
  assert.strictEqual(out.deleted, false);
  assert.strictEqual(out.found, true);
});

test('removeRowFromRecord: последний ряд → запись помечается на удаление', () => {
  const out = removeRowFromRecord('7', 130, 7, 130);
  assert.strictEqual(out.rows, null);
  assert.strictEqual(out.bushes, 0);
  assert.strictEqual(out.deleted, true);
  assert.strictEqual(out.found, true);
});

test('removeRowFromRecord: кусты не уходят ниже нуля', () => {
  const out = removeRowFromRecord('1,2', 50, 2, 200);
  assert.strictEqual(out.rows, '1');
  assert.strictEqual(out.bushes, 0);
  assert.strictEqual(out.deleted, false);
});

test('removeRowFromRecord: ряда нет в записи → ничего не меняем', () => {
  const out = removeRowFromRecord('1,2,3', 300, 9, 100);
  assert.strictEqual(out.rows, '1,2,3');
  assert.strictEqual(out.bushes, 300);
  assert.strictEqual(out.deleted, false);
  assert.strictEqual(out.found, false);
});

test('removeRowFromRecord: режим rows_only (кусты 0) остаётся 0', () => {
  const out = removeRowFromRecord('4,5,6', 0, 5, 0);
  assert.strictEqual(out.rows, '4,6');
  assert.strictEqual(out.bushes, 0);
  assert.strictEqual(out.deleted, false);
});

test('distributeBushes: поровну без остатка', () => {
  assert.deepStrictEqual(distributeBushes(100, 2), [50, 50]);
});

test('distributeBushes: остаток уходит первым', () => {
  assert.deepStrictEqual(distributeBushes(101, 2), [51, 50]);
  assert.deepStrictEqual(distributeBushes(100, 3), [34, 33, 33]);
});

test('distributeBushes: один получатель — все кусты', () => {
  assert.deepStrictEqual(distributeBushes(140, 1), [140]);
});

test('distributeBushes: ноль кустов', () => {
  assert.deepStrictEqual(distributeBushes(0, 3), [0, 0, 0]);
});

test('distributeBushes: ноль получателей — пустой массив', () => {
  assert.deepStrictEqual(distributeBushes(100, 0), []);
});
```

- [ ] **Step 2: Запустить тесты — убедиться, что падают**

Run: `node --test`
Expected: FAIL — `removeRowFromRecord is not a function` (или TypeError на новых тестах). Старые 11 тестов проходят.

- [ ] **Step 3: Реализовать `removeRowFromRecord`**

В `server/rowControl.js` добавить функцию перед `module.exports`:
```js
// Убирает ряд removedRow из CSV-списка рядов записи и пересчитывает кусты.
// rowsCsv — строка вида '1,2,3'; currentBushes — текущие кусты записи;
// removedRowBushes — кусты снимаемого ряда по инвентаризации (для rows_only = 0).
// Возвращает { rows, bushes, deleted, found }:
//   found=false  → ряда в записи не было, ничего не меняем;
//   deleted=true → рядов не осталось, запись надо удалить (rows=null, bushes=0);
//   иначе        → rows = новый CSV, bushes = max(currentBushes - removedRowBushes, 0).
// Кусты вычитаем (а не пересчитываем по инвентаризации), чтобы сохранить ранее
// заданные вручную доли — так же, как делает деление (split).
function removeRowFromRecord(rowsCsv, currentBushes, removedRow, removedRowBushes) {
  const nums = String(rowsCsv || '')
    .split(',')
    .map((s) => parseInt(s, 10))
    .filter((n) => Number.isInteger(n));
  if (!nums.includes(removedRow)) {
    return { rows: nums.join(','), bushes: currentBushes, deleted: false, found: false };
  }
  const remaining = nums.filter((n) => n !== removedRow);
  if (remaining.length === 0) {
    return { rows: null, bushes: 0, deleted: true, found: true };
  }
  return {
    rows: remaining.join(','),
    bushes: Math.max(currentBushes - removedRowBushes, 0),
    deleted: false,
    found: true,
  };
}
```

Добавить рядом функцию равномерного деления (для записи спорного ряда на нескольких):
```js
// Делит total кустов на n равных долей; остаток раздаётся первым долям по одной.
// distributeBushes(101, 2) → [51, 50]; distributeBushes(100, 3) → [34, 33, 33].
// n <= 0 → пустой массив.
function distributeBushes(total, n) {
  if (!Number.isInteger(n) || n <= 0) return [];
  const base = Math.floor(total / n);
  let rem = total - base * n;
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(base + (rem > 0 ? 1 : 0));
    if (rem > 0) rem--;
  }
  return out;
}
```

Обновить экспорт:
```js
module.exports = { splitBushes, classifyRows, removeRowFromRecord, distributeBushes };
```

- [ ] **Step 4: Запустить тесты — убедиться, что проходят**

Run: `node --test`
Expected: PASS — все тесты (11 старых + 10 новых) зелёные.

- [ ] **Step 5: Commit**

```bash
git add server/rowControl.js test/rowControl.test.js
git commit -m "feat(rows): pure removeRowFromRecord + distributeBushes + tests (Phase 2 core)"
```

---

## Task 2: Таблица disputed_rows (идемпотентно при старте)

**Files:**
- Modify: `server/server.js` (блок инициализации БД, рядом с `CREATE TABLE IF NOT EXISTS work_logs`/`attendance`).

> Автотеста нет — в проекте схема проверяется на старте приложения (как и остальные `CREATE TABLE`). Корректность подтверждается тем, что сервер стартует без ошибок и Задачи 3–4 успешно пишут/читают таблицу.

- [ ] **Step 1: Добавить создание таблицы**

Найти в `server/server.js` блок инициализации, где идут `CREATE TABLE IF NOT EXISTS attendance (...)` и последующие `ALTER TABLE`. После создания `attendance` (и связанных с ним alter'ов) добавить:
```js
    await pool.query(`
      CREATE TABLE IF NOT EXISTS disputed_rows (
        id SERIAL PRIMARY KEY,
        brigadier_id INTEGER,
        demo_session_id TEXT,
        estate_id TEXT NOT NULL,
        quarter TEXT NOT NULL,
        cell TEXT NOT NULL,
        work_type TEXT NOT NULL,
        row_num INTEGER NOT NULL,
        measure_mode TEXT NOT NULL DEFAULT 'rows_bushes',
        claimed_by TEXT NOT NULL,
        claimed_date TEXT NOT NULL,
        note TEXT,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      )
    `);
```

> Примечание: внешний ключ на `demo_sessions(id) ON DELETE CASCADE` для `demo_session_id` намеренно НЕ ставим в общем CREATE — в боевом этой таблицы нет, а демо-ветка добавляет каскад своим `ALTER TABLE ... ADD COLUMN` отдельно (см. Задачу 8/перенос). В боевом `demo_session_id` остаётся NULL.

- [ ] **Step 2: Проверить, что сервер парсится без синтаксических ошибок**

Run: `node -e "require('./server/server.js')" ` — НЕ запускать (требует БД/окружение). Вместо этого синтаксис-чек:
Run: `node --check server/server.js`
Expected: без вывода (синтаксис корректен).

- [ ] **Step 3: Commit**

```bash
git add server/server.js
git commit -m "feat(rows): disputed_rows table (idempotent init)"
```

---

## Task 3: Серверные действия reassign / postpone + хелпер снятия ряда; удалить assign

**Files:**
- Modify: `server/server.js` — endpoint `app.post('/api/logs/resolve', ...)` и рядом с `getOccupiedRows`/`rowOwner` добавить хелпер.

- [ ] **Step 1: Добавить серверный хелпер снятия ряда**

Рядом с `getOccupiedRows`/`rowOwner` (там же, где живут хелперы рядов) добавить:
```js
// Снимает ряд rowNum из записи logId (того же владельца) и пишет результат в БД:
// если рядов не осталось — удаляет запись, иначе обновляет rows + bushes.
// removedRowBushes — кусты ряда по инвентаризации (rows_only → 0). Возвращает true,
// если запись найдена и обработана, иначе false.
async function applyRowRemoval(ownerCol, ownerVal, logId, rowNum, removedRowBushes) {
  const rec = await pool.query(
    `SELECT rows, bushes FROM work_logs WHERE id = $1 AND ${ownerCol} = $2`,
    [logId, ownerVal]
  );
  if (rec.rowCount === 0) return false;
  const out = rowControl.removeRowFromRecord(
    rec.rows[0].rows, rec.rows[0].bushes, rowNum, removedRowBushes
  );
  if (out.deleted) {
    await pool.query(
      `DELETE FROM work_logs WHERE id = $1 AND ${ownerCol} = $2`,
      [logId, ownerVal]
    );
  } else {
    await pool.query(
      `UPDATE work_logs SET rows = $1, bushes = $2 WHERE id = $3 AND ${ownerCol} = $4`,
      [out.rows, out.bushes, logId, ownerVal]
    );
  }
  return true;
}
```

- [ ] **Step 2: Заменить блок `assign` на `reassign` и `postpone`**

В `app.post('/api/logs/resolve', ...)` найти блок:
```js
    if (action === 'assign') {
      // «Другой день»: записать ряд целиком на текущего рабочего, первого не трогаем.
      const id = await insertLog(employee.trim(), rowBushes);
      return res.json({ success: true, id });
    }
```
Заменить его на:
```js
    if (action === 'reassign' || action === 'postpone') {
      // «Разные дни»: оба варианта снимают ряд с первого рабочего (firstLogId),
      // отличаются тем, что делать дальше — записать второму или отложить в спорные.
      const fid = parseInt(firstLogId, 10);
      if (!Number.isInteger(fid)) {
        return res.status(400).json({ error: 'Не указана запись первого рабочего' });
      }
      // Запись первого должна принадлежать тому же владельцу и тому же разрезу
      // (без фильтра по дате — у первого она в ДРУГОЙ день).
      const firstRec = await pool.query(
        `SELECT employee, date FROM work_logs
         WHERE id = $1 AND ${owner.col} = $2 AND estate_id = $3
           AND quarter = $4 AND cell = $5 AND work_type = $6`,
        [fid, owner.val, estate, String(quarter), String(cell), work_type.trim()]
      );
      if (firstRec.rowCount === 0) {
        return res.status(404).json({ error: 'Запись первого рабочего не найдена' });
      }

      if (action === 'reassign') {
        if (firstRec.rows[0].employee === employee.trim()) {
          return res.status(400).json({ error: 'Ряд уже записан на этого рабочего' });
        }
        await applyRowRemoval(owner.col, owner.val, fid, rowNum, rowBushes);
        const id = await insertLog(employee.trim(), rowBushes);
        return res.json({ success: true, id });
      }

      // postpone: ряд уходит в «Спорные», снимается с первого, второму не пишется.
      await insertDisputed({
        estate, quarter: String(quarter), cell: String(cell),
        work_type: work_type.trim(), row_num: rowNum, measure_mode,
        claimed_by: firstRec.rows[0].employee, claimed_date: firstRec.rows[0].date,
      }, owner, req);
      await applyRowRemoval(owner.col, owner.val, fid, rowNum, rowBushes);
      return res.json({ success: true });
    }
```

- [ ] **Step 3: Добавить хелпер `insertDisputed` (демо-осознанный)**

Рядом с `applyRowRemoval` добавить:
```js
// Заносит ряд в disputed_rows с учётом владельца (демо — по сессии, прод — по бригадиру).
async function insertDisputed(d, owner, req) {
  if (DEMO_MODE) {
    await pool.query(
      `INSERT INTO disputed_rows
        (estate_id, quarter, cell, work_type, row_num, measure_mode, claimed_by, claimed_date, demo_session_id, brigadier_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [d.estate, d.quarter, d.cell, d.work_type, d.row_num, d.measure_mode,
       d.claimed_by, d.claimed_date, req.demo_session_id, 0]
    );
    return;
  }
  await pool.query(
    `INSERT INTO disputed_rows
      (estate_id, quarter, cell, work_type, row_num, measure_mode, claimed_by, claimed_date, brigadier_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [d.estate, d.quarter, d.cell, d.work_type, d.row_num, d.measure_mode,
     d.claimed_by, d.claimed_date, req.brigadier.id]
  );
}
```

- [ ] **Step 4: Синтаксис-чек**

Run: `node --check server/server.js`
Expected: без вывода.

- [ ] **Step 5: Commit**

```bash
git add server/server.js
git commit -m "feat(rows): reassign/postpone actions + row removal helper, drop assign"
```

---

## Task 4: Endpoint'ы списка и разбора спорных рядов

**Files:**
- Modify: `server/server.js` — добавить `GET /api/disputed` и `POST /api/disputed/:id/resolve` (после блока `/api/logs/resolve`).

- [ ] **Step 1: Добавить `GET /api/disputed`**

После endpoint'а `app.post('/api/logs/resolve', ...)` добавить:
```js
// Список спорных рядов владельца по хозяйству.
app.get('/api/disputed', authOrDemo, async (req, res) => {
  try {
    const { estate } = req.query;
    if (!estate) return res.status(400).json({ error: 'Укажи estate' });
    let result;
    if (DEMO_MODE) {
      result = await pool.query(
        `SELECT id, quarter, cell, work_type, row_num, measure_mode, claimed_by, claimed_date
         FROM disputed_rows WHERE demo_session_id = $1 AND estate_id = $2
         ORDER BY created_at DESC`,
        [req.demo_session_id, estate]
      );
    } else {
      result = await pool.query(
        `SELECT id, quarter, cell, work_type, row_num, measure_mode, claimed_by, claimed_date
         FROM disputed_rows WHERE brigadier_id = $1 AND estate_id = $2
         ORDER BY created_at DESC`,
        [req.brigadier.id, estate]
      );
    }
    res.json({ disputed: result.rows });
  } catch (error) {
    console.error('Disputed list error:', error);
    res.status(500).json({ error: error.message });
  }
});
```

- [ ] **Step 2: Добавить `POST /api/disputed/:id/resolve`**

Сразу после `GET /api/disputed` добавить:
```js
// Разбор спорного ряда:
//   'assign-actual' — записать тем, кто реально делал: один или несколько рабочих,
//      кусты ряда делятся (assignments: [{employee, bushes?}], пустые доли — поровну);
//   'return-first'  — вернуть заявителю (одна запись с полными кустами ряда).
// Все записи создаются на дату claimed_date; ряд считается одним. После — ряд
// убирается из спорных.
app.post('/api/disputed/:id/resolve', authOrDemo, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Некорректный id' });
    }
    const { action, assignments } = req.body;
    if (!['assign-actual', 'return-first'].includes(action)) {
      return res.status(400).json({ error: 'Неизвестное действие' });
    }

    const owner = rowOwner(req);
    const rec = await pool.query(
      `SELECT * FROM disputed_rows WHERE id = $1 AND ${owner.col} = $2`,
      [id, owner.val]
    );
    if (rec.rowCount === 0) {
      return res.status(404).json({ error: 'Спорный ряд не найден' });
    }
    const d = rec.rows[0];

    // Кусты ряда из инвентаризации текущего режима (для rows_only = 0).
    let invForParser, parserToUse;
    if (DEMO_MODE) {
      invForParser = await demo.getDemoInventory(pool, req.demo_session_id);
      parserToUse = new DataParser(invForParser);
    } else {
      invForParser = inventory;
      parserToUse = parser;
    }
    let rowBushes = 0;
    if (d.measure_mode === 'rows_bushes') {
      try {
        rowBushes = parserToUse.getBushesCount(d.estate_id, String(d.quarter), String(d.cell), [d.row_num]);
      } catch (e) {
        return res.status(400).json({ error: e.message });
      }
    }

    // Формируем список (рабочий, кусты) для вставки.
    let toInsert = [];
    if (action === 'return-first') {
      toInsert = [{ employee: d.claimed_by, bushes: rowBushes }];
    } else {
      const list = Array.isArray(assignments) ? assignments : [];
      const cleaned = list
        .map((a) => ({
          employee: a && a.employee ? String(a.employee).trim() : '',
          bushes: (a && a.bushes !== null && a.bushes !== undefined && a.bushes !== '')
            ? parseInt(a.bushes, 10) : null,
        }))
        .filter((a) => a.employee);
      if (cleaned.length === 0) {
        return res.status(400).json({ error: 'Выбери хотя бы одного рабочего' });
      }
      if (d.measure_mode !== 'rows_bushes') {
        toInsert = cleaned.map((a) => ({ employee: a.employee, bushes: 0 }));
      } else {
        for (const a of cleaned) {
          if (a.bushes !== null && (!Number.isInteger(a.bushes) || a.bushes < 0)) {
            return res.status(400).json({ error: 'Кусты должны быть неотрицательным числом' });
          }
        }
        // Явные доли уважаем, остаток раздаём поровну по пустым.
        const explicitSum = cleaned.reduce((s, a) => s + (a.bushes !== null ? a.bushes : 0), 0);
        const blanksCount = cleaned.filter((a) => a.bushes === null).length;
        const remaining = Math.max(rowBushes - explicitSum, 0);
        const shares = rowControl.distributeBushes(remaining, blanksCount);
        let bi = 0;
        toInsert = cleaned.map((a) => ({
          employee: a.employee,
          bushes: a.bushes !== null ? a.bushes : shares[bi++],
        }));
      }
    }

    // Вставка записей журнала (демо/прод) — одна на каждого рабочего.
    const insertOne = async (emp, bushes) => {
      if (DEMO_MODE) {
        await pool.query(
          `INSERT INTO work_logs
            (date, estate_id, quarter, cell, employee, rows, bushes, brigadier_id, demo_session_id, work_type, measure_mode, hours)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [d.claimed_date, d.estate_id, String(d.quarter), String(d.cell), emp,
           String(d.row_num), bushes, 0, req.demo_session_id, d.work_type, d.measure_mode, null]
        );
      } else {
        await pool.query(
          `INSERT INTO work_logs
            (date, estate_id, quarter, cell, employee, rows, bushes, brigadier_id, work_type, measure_mode, hours)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [d.claimed_date, d.estate_id, String(d.quarter), String(d.cell), emp,
           String(d.row_num), bushes, req.brigadier.id, d.work_type, d.measure_mode, null]
        );
      }
    };
    for (const a of toInsert) {
      await insertOne(a.employee, a.bushes);
    }

    await pool.query(
      `DELETE FROM disputed_rows WHERE id = $1 AND ${owner.col} = $2`,
      [id, owner.val]
    );
    res.json({ success: true });
  } catch (error) {
    console.error('Disputed resolve error:', error);
    res.status(500).json({ error: error.message });
  }
});
```

- [ ] **Step 3: Синтаксис-чек**

Run: `node --check server/server.js`
Expected: без вывода.

- [ ] **Step 4: Commit**

```bash
git add server/server.js
git commit -m "feat(rows): disputed list + resolve endpoints (assign-actual / return-first)"
```

---

## Task 5: Клиент — меню «разные дни» из 4 действий

**Files:**
- Modify: `public/js/app.js` — `resolveOtherDay` + новый метод `showOtherDayMenu`.
- Modify: `public/styles.css` — класс вторичной кнопки модалки.

> Клиентских юнит-тестов в проекте нет (как и в Фазе 1) — проверка ручная (Задача 7).

- [ ] **Step 1: Заменить `resolveOtherDay`**

Найти в `public/js/app.js` метод `resolveOtherDay(c, employee, body)` (целиком, от сигнатуры до закрывающей `}` перед `showConflictModal`) и заменить на:
```js
  // Другой день: широкое меню — отменить / отложить в спорные / переписать / поделить.
  async resolveOtherDay(c, employee, body) {
    const res = await this.showOtherDayMenu({
      row: c.row,
      occupantName: c.occupant.employee,
      occupantDate: c.occupant.date,
      employee,
      askShare: body.measure_mode === 'rows_bushes',
    });
    if (!res || res.action === 'cancel') return;

    const payload = {
      date: body.date, estate: body.estate, quarter: body.quarter, cell: body.cell,
      work_type: body.work_type, measure_mode: body.measure_mode,
      row: c.row, employee, firstLogId: c.occupant.logId,
    };
    if (res.action === 'split') payload.action = 'split';
    else if (res.action === 'reassign') payload.action = 'reassign';
    else if (res.action === 'postpone') payload.action = 'postpone';
    if (res.action === 'split') payload.shareToSecond = res.shareToSecond;

    const r = await this.apiFetch('/api/logs/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      const data = await r.json().catch(() => ({}));
      await this.showInfoModal(`Ряд ${c.row}: ${data.error || 'не удалось обработать ряд'}`);
    }
  }

  // Модалка «разные дни»: 4 действия. Возвращает Promise с одним из:
  // { action: 'cancel' } | { action: 'postpone' } | { action: 'reassign' } |
  // { action: 'split', shareToSecond } ; либо null при закрытии по фону.
  showOtherDayMenu({ row, occupantName, occupantDate, employee, askShare }) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      const box = document.createElement('div');
      box.className = 'modal-box';

      const title = document.createElement('div');
      title.className = 'modal-title';
      title.textContent = `Ряд ${row}`;
      box.appendChild(title);

      const text = document.createElement('div');
      text.className = 'modal-text';
      text.textContent = `Этот ряд уже отмечал ${occupantName} (${occupantDate}). Что делаем?`;
      box.appendChild(text);

      let shareInput = null;
      if (askShare) {
        shareInput = document.createElement('input');
        shareInput.className = 'modal-input';
        shareInput.inputMode = 'numeric';
        shareInput.placeholder = `Кусты для ${employee} при делении (пусто = поровну)`;
        box.appendChild(shareInput);
      }

      const actions = document.createElement('div');
      actions.className = 'modal-actions modal-actions-col';

      const mkBtn = (label, cls, onClick) => {
        const b = document.createElement('button');
        b.className = cls;
        b.textContent = label;
        b.addEventListener('click', onClick);
        actions.appendChild(b);
      };

      const close = (result) => { overlay.remove(); resolve(result); };

      mkBtn(`Переписать на ${employee}`, 'modal-primary', () => close({ action: 'reassign' }));
      mkBtn('Поделить кусты', 'modal-secondary', () => {
        let shareToSecond = null;
        if (shareInput && shareInput.value.trim() !== '') {
          const n = parseInt(shareInput.value, 10);
          if (Number.isInteger(n) && n >= 0) shareToSecond = n;
        }
        close({ action: 'split', shareToSecond });
      });
      mkBtn('Отложить в «Спорные»', 'modal-secondary', () => close({ action: 'postpone' }));
      mkBtn('Отменить запись', 'modal-cancel', () => close({ action: 'cancel' }));

      box.appendChild(actions);
      overlay.appendChild(box);
      document.body.appendChild(overlay);
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });
    });
  }
```

- [ ] **Step 2: Добавить CSS для вертикальных кнопок и вторичной кнопки**

В конец `public/styles.css` добавить:
```css
.modal-actions-col {
  flex-direction: column;
}
.modal-secondary {
  padding: 12px;
  border: 1px solid #2c3e50;
  border-radius: 8px;
  background: #fff;
  color: #2c3e50;
  font-size: 15px;
  cursor: pointer;
}
```

- [ ] **Step 3: Проверить вручную в браузере (демо-режим локально или после деплоя)**

Сценарий: ввести ряд, который другой рабочий делал в другой день → должно появиться меню с 4 кнопками. Полная проверка — в Задаче 7.

- [ ] **Step 4: Commit**

```bash
git add public/js/app.js public/styles.css
git commit -m "feat(rows): other-day 4-option menu (reassign/split/postpone/cancel)"
```

---

## Task 6: Клиент — вкладка «Спорные»

**Files:**
- Modify: `public/js/app.js` — кнопка вкладки + контейнер в основном рендере; методы `loadDisputed`, `renderDisputed`, `resolveDisputed`.

- [ ] **Step 1: Добавить кнопку вкладки и контейнер**

Найти блок `<div class="tabs"> ... </div>` в основном рендере (там кнопки «Ввод данных»/«Отчет за период»/«Журнал»/«Админ»). После кнопки «Журнал» добавить кнопку:
```js
          <button class="tab-button" onclick="app.switchTab(event, 'disputed'); app.loadDisputed()">Спорные</button>
```
Затем найти контейнер вкладки «Журнал»:
```js
        <div class="tab-content" id="logs-tab">
```
…и **перед** ним (или сразу после закрытия `logs-tab`) добавить контейнер спорных. Конкретно — после закрывающего `</div>` блока `logs-tab` добавить:
```js
        <div class="tab-content" id="disputed-tab">
          <button onclick="app.loadDisputed()">Обновить</button>
          <div id="disputed-list" class="logs-list"></div>
        </div>
```

- [ ] **Step 2: Добавить методы загрузки и рендера**

Рядом с `loadLogs` (или после `resolveOtherDay`-блока) добавить:
```js
  async loadDisputed() {
    const list = document.getElementById('disputed-list');
    if (!list) return;
    if (!this.estate) {
      list.innerHTML = '<p style="color:#888;padding:10px;">Сначала выбери хозяйство</p>';
      return;
    }
    try {
      const r = await this.apiFetch('/api/disputed?estate=' + encodeURIComponent(this.estate));
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        list.innerHTML = `<p style="color:#c00;padding:10px;">${this.escapeHtml(data.error || 'Ошибка')}</p>`;
        return;
      }
      this.disputed = data.disputed || [];
      this.renderDisputed();
    } catch (e) {
      list.innerHTML = `<p style="color:#c00;padding:10px;">${this.escapeHtml(e.message)}</p>`;
    }
  }

  renderDisputed() {
    const list = document.getElementById('disputed-list');
    if (!list) return;
    if (!this.disputed || this.disputed.length === 0) {
      list.innerHTML = '<p style="color:#888;padding:10px;">Спорных рядов нет</p>';
      return;
    }
    list.innerHTML = this.disputed.map((d) => `
      <div class="log-item">
        <div><b>Ряд ${d.row_num}</b> · Кв.${this.escapeHtml(String(d.quarter))} клетка ${this.escapeHtml(String(d.cell))} · ${this.escapeHtml(d.work_type)}</div>
        <div style="color:#888;font-size:13px;">Заявлял ${this.escapeHtml(d.claimed_by)} (${this.escapeHtml(d.claimed_date)})</div>
        <div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap;align-items:center;">
          <button onclick="app.openDisputedAssign(${d.id})">Записать делавшим</button>
          <button onclick="app.resolveDisputed(${d.id}, 'return-first')">Вернуть ${this.escapeHtml(d.claimed_by)}</button>
        </div>
      </div>
    `).join('');
  }

  // Открывает модалку выбора рабочих (одного или нескольких) с долями кустов,
  // затем отправляет разбор. Деление — выбор бригадира: отметил несколько → кусты
  // делятся (пустые доли = поровну, остаток первым).
  async openDisputedAssign(id) {
    const d = (this.disputed || []).find((x) => x.id === id);
    if (!d) return;
    const assignments = await this.showDisputedAssignModal(d);
    if (!assignments) return;
    await this.resolveDisputed(id, 'assign-actual', assignments);
  }

  // Возвращает Promise: массив [{employee, bushes|null}] (≥1) или null при отмене.
  showDisputedAssignModal(d) {
    return new Promise((resolve) => {
      const askShare = d.measure_mode === 'rows_bushes';
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      const box = document.createElement('div');
      box.className = 'modal-box';

      const title = document.createElement('div');
      title.className = 'modal-title';
      title.textContent = `Ряд ${d.row_num} — кто делал?`;
      box.appendChild(title);

      const hint = document.createElement('div');
      hint.className = 'modal-text';
      hint.textContent = askShare
        ? 'Отметь рабочих. Если несколько — кусты делятся поровну; можно задать долю вручную.'
        : 'Отметь рабочих, которые делали ряд.';
      box.appendChild(hint);

      const rows = [];
      (this.employees || []).forEach((e) => {
        const rowEl = document.createElement('label');
        rowEl.style.display = 'flex';
        rowEl.style.alignItems = 'center';
        rowEl.style.gap = '8px';
        rowEl.style.margin = '6px 0';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        const nameSpan = document.createElement('span');
        nameSpan.textContent = e.name;
        nameSpan.style.flex = '1';
        rowEl.appendChild(cb);
        rowEl.appendChild(nameSpan);
        let shareInput = null;
        if (askShare) {
          shareInput = document.createElement('input');
          shareInput.className = 'modal-input';
          shareInput.inputMode = 'numeric';
          shareInput.placeholder = 'кусты';
          shareInput.style.width = '90px';
          shareInput.style.margin = '0';
          rowEl.appendChild(shareInput);
        }
        box.appendChild(rowEl);
        rows.push({ name: e.name, cb, shareInput });
      });

      const actions = document.createElement('div');
      actions.className = 'modal-actions';
      const primary = document.createElement('button');
      primary.className = 'modal-primary';
      primary.textContent = 'Записать';
      const cancel = document.createElement('button');
      cancel.className = 'modal-cancel';
      cancel.textContent = 'Отмена';
      actions.appendChild(primary);
      actions.appendChild(cancel);
      box.appendChild(actions);

      overlay.appendChild(box);
      document.body.appendChild(overlay);

      const close = (result) => { overlay.remove(); resolve(result); };
      primary.addEventListener('click', () => {
        const chosen = rows.filter((r) => r.cb.checked).map((r) => {
          let bushes = null;
          if (r.shareInput && r.shareInput.value.trim() !== '') {
            const n = parseInt(r.shareInput.value, 10);
            if (Number.isInteger(n) && n >= 0) bushes = n;
          }
          return { employee: r.name, bushes };
        });
        if (chosen.length === 0) return; // нечего записывать — ждём выбора
        close(chosen);
      });
      cancel.addEventListener('click', () => close(null));
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });
    });
  }

  async resolveDisputed(id, action, assignments) {
    const body = { action };
    if (action === 'assign-actual') body.assignments = assignments || [];
    try {
      const r = await this.apiFetch('/api/disputed/' + id + '/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        await this.showInfoModal(data.error || 'Не удалось разобрать ряд');
        return;
      }
      await this.loadDisputed();
    } catch (e) {
      await this.showInfoModal(e.message);
    }
  }
```

> Зависимости уже есть в классе: `this.estate`, `this.employees` (`[{id,name}]`), `this.apiFetch`, `this.escapeHtml`, `this.showInfoModal`, `switchTab`. Класс `.log-item` используется журналом — проверить его наличие в `styles.css`; если рендер журнала использует другой класс, взять тот же, что в `loadLogs`/рендере логов. Переиспользуются классы модалки `.modal-*` из Фазы 1.

- [ ] **Step 3: Сверить класс элемента списка с журналом**

Открыть рендер журнала (метод, который строит `#logs-list`) и убедиться, что класс карточки записи (`.log-item` или иной) совпадает с использованным в `renderDisputed`. Если в журнале другой класс — заменить `log-item` на него в `renderDisputed`.

- [ ] **Step 4: Проверить вручную**

Полная проверка — Задача 7.

- [ ] **Step 5: Commit**

```bash
git add public/js/app.js
git commit -m "feat(rows): Disputed rows tab (list + assign-actual/return-first)"
```

---

## Task 7: Ручная проверка на живом приложении (Наталия)

> Автоматически прогнать нельзя — нужна БД и живая сессия. Чек-лист для Наталии после деплоя боевого (и потом демо).

- [ ] **Step 1: «Разные дни» — меню**

Ввести ряд, который другой рабочий делал в ДРУГОЙ день, тем же видом работ, в той же клетке. Должно появиться меню: «Переписать на …», «Поделить кусты», «Отложить в Спорные», «Отменить запись».

- [ ] **Step 2: Переписать**

Нажать «Переписать на …». Проверить в журнале: у первого рабочего этот ряд исчез (кусты уменьшились на кусты ряда), у текущего появилась запись на этот ряд с полными кустами.

- [ ] **Step 3: Поделить**

Повторить конфликт, нажать «Поделить» (с пустым полем = поровну). Проверить: ряд остался у первого с уменьшенными кустами, у второго запись с долей.

- [ ] **Step 4: Отложить**

Повторить конфликт, нажать «Отложить в Спорные». Проверить: у первого ряд снят; во вкладке «Спорные» появился ряд с контекстом (кто заявлял, дата).

- [ ] **Step 5: Разбор спорного — записать делавшим (один и несколько)**

Во вкладке «Спорные» нажать «Записать делавшим». В модалке отметить ОДНОГО рабочего → записать; ряд исчезает из спорных, в журнале запись на него за дату заявки с полными кустами.
Повторить с ДВУМЯ-ТРЕМЯ отмеченными рабочими (доли оставить пустыми) → кусты ряда делятся поровну между ними; затем повторить, задав долю вручную одному → проверить, что доли распределились как заданы, остаток — поровну по пустым.

- [ ] **Step 6: Разбор спорного — вернуть первому**

Создать ещё один спорный, нажать «Вернуть …». Ряд исчезает из спорных, в журнале появляется запись на первого рабочего за дату заявки.

- [ ] **Step 7: Отмена**

Повторить конфликт, нажать «Отменить запись». Ничего не меняется ни у кого; свободные ряды из той же отправки сохранены.

---

## Task 8: Перенос в демо и деплой

**Files:** те же изменения на ветке `demo-five-modes`.

> Как в Фазе 1: cherry-pick коммитов Задач 1–6 на `demo-five-modes`, разрулить хвост `styles.css` при конфликте, учесть демо-специфику.

- [ ] **Step 1: Cherry-pick коммитов Фазы 2 на `demo-five-modes`**

```bash
git checkout demo-five-modes
git cherry-pick <sha Task1> <sha Task2> <sha Task3> <sha Task4> <sha Task5> <sha Task6>
```
При конфликте в хвосте `public/styles.css` (демо дописывает свои правила в конец) — оставить оба набора правил корректно закрытыми.

- [ ] **Step 2: Демо-специфика — каскад на demo_session_id**

В демо-ветке после `CREATE TABLE ... disputed_rows` добавить (в стиле остальных демо-таблиц), чтобы спорные чистились вместе с сессией:
```js
    await pool.query(`ALTER TABLE disputed_rows ADD COLUMN IF NOT EXISTS demo_session_id TEXT REFERENCES demo_sessions(id) ON DELETE CASCADE`);
```
> Колонка `demo_session_id` уже создаётся в общем CREATE (Задача 2) как TEXT без FK; этот ALTER в демо-ветке добавляет именно каскадный внешний ключ. Если `ADD COLUMN IF NOT EXISTS` не навешивает FK на существующую колонку — вместо него добавить отдельный `ADD CONSTRAINT ... FOREIGN KEY` идемпотентно (через проверку `pg_constraint`, как сделано для `chk_measure_mode`). Реализатор проверяет фактическое поведение на демо-БД.

- [ ] **Step 3: Прогнать тесты на демо-ветке**

Run: `node --test`
Expected: PASS (ядро `rowControl.js` идентично).

- [ ] **Step 4: Запушить в приватный SourceCraft и развернуть**

```bash
git push demo demo-five-modes
```
На VPS (Excellent Elara): `cd /opt/pomoshnik-demo && git pull && pm2 restart pomoshnik-demo`.
Проверить `https://demo.smart-assistantai.ru/health` → `{"ok":true}`.

- [ ] **Step 5: Деплой боевого**

Слить ветку Фазы 2 в `origin/main` (PR, как Фаза 1) → Render выкатит автоматически. Деплой/PR/merge — на ассистенте, живую проверку (Задача 7) делает Наталия.

---

## Self-Review

**1. Покрытие спеки (разделы 8–9):**
- 8.1 Отменить — `cancel` (клиент, без запроса). ✅ (Task 5)
- 8.2 Отложить до выяснения — `postpone` + `disputed_rows`. ✅ (Tasks 3, 2)
- 8.3 Переписать на другого — `reassign` + снятие ряда с пересчётом. ✅ (Tasks 3, 1)
- 8.4 Поделить — `split` (уже был, переиспользован в меню). ✅ (Task 5)
- 9 Список «Спорные»: снятие с первого, ряд ничей, экран в любой день, решения «записать делавшим» (один ИЛИ несколько рабочих с делением кустов — выбор бригадира) / «вернуть первому», удаление после решения, таблица `disputed_rows`. ✅ (Tasks 1, 2, 4, 6)
- «Отчёт обновляется сразу» — записи журнала меняются немедленно (UPDATE/DELETE/INSERT), отчёт читает их при следующем запросе. ✅
- Раздел 10/12 (пропущенные ряды, уникальные ряды в отчёте) — вне объёма (Фаза 3). Намеренно.

**2. Плейсхолдеры:** не обнаружено — весь код приведён.

**3. Согласованность типов/имён:** `removeRowFromRecord(rowsCsv, currentBushes, removedRow, removedRowBushes) → {rows, bushes, deleted, found}` — одинаково в Task 1 (определение/тесты) и Task 3 (`applyRowRemoval`). `distributeBushes(total, n) → number[]` — Task 1 (определение/тесты) и Task 4 (`assign-actual`). Действия `reassign`/`postpone`/`split`/`cancel` — согласованы между клиентом (Task 5) и сервером (Task 3). Endpoint'ы `assign-actual` (тело `{assignments:[{employee, bushes?}]}`) / `return-first` — согласованы между сервером (Task 4) и клиентом (Task 6: `showDisputedAssignModal` отдаёт `[{employee, bushes|null}]`). Колонка `row_num` — единообразно во всех задачах. `insertDisputed`/`insertLog`/`applyRowRemoval`/`insertOne` через прямые INSERT — демо-осознанны.
