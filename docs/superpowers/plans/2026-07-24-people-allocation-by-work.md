# Разбивка к-во чел. по виду+кварталу — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Бригадир задаёт необязательную разбивку общего N из явки по парам «вид работ + квартал»; может менять N в течение дня (сняли / опоздали); сумма кусков не превышает N.

**Architecture:** Общее N остаётся в `attendance.people_count`. Куски — таблица `people_allocations` (дата, сотрудник, work_type, quarter, people_count + владелец демо/прод). Чистая логика суммы/предупреждений — в `server/peopleAllocations.js` (тесты node:test). API GET/PUT/DELETE; PATCH/DELETE явки дополняются проверкой суммы и каскадом. UI: поле «чел. на этот вид/квартал» при выбранных сотруднике + виде + квартале; список кусков и «Разбивка X из N».

**Tech Stack:** Node ≥20, Express, PostgreSQL (`pg`), vanilla JS в `public/js/app.js`, `node --test`.

**Spec:** `docs/superpowers/specs/2026-07-24-people-allocation-by-work-design.md`

## Global Constraints

- Разбивка **необязательна**: день без кусков валиден.
- Сумма кусков **≤ N**; сумма **> N** — отказ API 400.
- Сумма **< N** при наличии кусков — сохранять можно; на клиенте предупреждение.
- Не менять вечерний ввод рядов/часов, контроль рядов, спорные, сверку, бухгалтерию, Excel.
- Не дублировать куски в `work_logs`.
- Демо и прод — один код (`DEMO_MODE` как у явки).
- Репозиторий публичный: без реальных фамилий клиентов в коммитах (в тестах «Халил» ок).

## File map

| File | Role |
|------|------|
| `server/peopleAllocations.js` | сумма кусков, проверка ≤ N, текст предупреждения, нормализация числа куска |
| `test/peopleAllocations.test.js` | unit-тесты хелперов |
| `server/server.js` | таблица + индексы; GET/PUT/DELETE allocations; каскад/проверка в PATCH/DELETE attendance |
| `public/js/app.js` | загрузка кусков; поле разбивки; список; предупреждение; save/delete |
| `public/styles.css` | стили блока разбивки / предупреждения |

---

### Task 1: Хелперы peopleAllocations + тесты

**Files:**
- Create: `server/peopleAllocations.js`
- Create: `test/peopleAllocations.test.js`

**Interfaces:**
- Produces:
  - `normalizeAllocationCount(raw: unknown): number` — целое 1…999; иначе Error `statusCode=400` (пусто/`null` **не** допускается)
  - `sumAllocationCounts(rows: Array<{ people_count: number|string }>): number`
  - `assertSumWithinCap(sum: number, cap: number): void` — если `sum > cap`, Error `statusCode=400` с русским текстом
  - `formatAllocationProgress(sum: number, cap: number): string | null` — `null` если sum===0 или sum===cap; иначе `"Разбивка ${sum} из ${cap}"`

- [ ] **Step 1: Write the failing tests**

```js
// test/peopleAllocations.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeAllocationCount,
  sumAllocationCounts,
  assertSumWithinCap,
  formatAllocationProgress,
} = require('../server/peopleAllocations');

test('normalizeAllocationCount: 1…999', () => {
  assert.equal(normalizeAllocationCount(1), 1);
  assert.equal(normalizeAllocationCount('10'), 10);
  assert.equal(normalizeAllocationCount(999), 999);
});

test('normalizeAllocationCount: невалидное → 400', () => {
  for (const bad of [null, undefined, '', 0, -1, 1000, 1.5, 'abc']) {
    assert.throws(() => normalizeAllocationCount(bad), (err) => err.statusCode === 400);
  }
});

test('sumAllocationCounts', () => {
  assert.equal(sumAllocationCounts([]), 0);
  assert.equal(sumAllocationCounts([{ people_count: 6 }, { people_count: '4' }]), 10);
});

test('assertSumWithinCap: ok и отказ', () => {
  assert.doesNotThrow(() => assertSumWithinCap(0, 10));
  assert.doesNotThrow(() => assertSumWithinCap(10, 10));
  assert.throws(() => assertSumWithinCap(11, 10), (err) => err.statusCode === 400);
});

test('formatAllocationProgress', () => {
  assert.equal(formatAllocationProgress(0, 10), null);
  assert.equal(formatAllocationProgress(10, 10), null);
  assert.equal(formatAllocationProgress(6, 10), 'Разбивка 6 из 10');
});
```

- [ ] **Step 2: Run tests — expect FAIL**

Run: `node --test test/peopleAllocations.test.js`  
Expected: FAIL — cannot find module `../server/peopleAllocations`

- [ ] **Step 3: Implement helpers**

```js
// server/peopleAllocations.js
'use strict';

function normalizeAllocationCount(raw) {
  const n = typeof raw === 'number' ? raw : Number(String(raw == null ? '' : raw).trim());
  if (!Number.isInteger(n) || n < 1 || n > 999) {
    const err = new Error('К-во чел. на вид/квартал: целое от 1 до 999');
    err.statusCode = 400;
    throw err;
  }
  return n;
}

function sumAllocationCounts(rows) {
  let s = 0;
  for (const r of rows || []) {
    s += Number(r.people_count) || 0;
  }
  return s;
}

function assertSumWithinCap(sum, cap) {
  if (sum > cap) {
    const err = new Error(`Сумма разбивки больше явки (${cap})`);
    err.statusCode = 400;
    throw err;
  }
}

function formatAllocationProgress(sum, cap) {
  if (!cap || sum === 0 || sum === cap) return null;
  return `Разбивка ${sum} из ${cap}`;
}

module.exports = {
  normalizeAllocationCount,
  sumAllocationCounts,
  assertSumWithinCap,
  formatAllocationProgress,
};
```

- [ ] **Step 4: Run tests — expect PASS**

Run: `node --test test/peopleAllocations.test.js`  
Expected: all pass

- [ ] **Step 5: Commit**

```bash
git add server/peopleAllocations.js test/peopleAllocations.test.js
git commit -m "feat(allocations): helpers for people split validate/sum"
```

---

### Task 2: Таблица people_allocations + API GET/PUT/DELETE

**Files:**
- Modify: `server/server.js` (ensureTables + маршруты рядом с attendance; `require('./peopleAllocations')`)
- Reuse: `server/peopleCount.js` → `normalizePeopleCount` уже есть (для чтения N явки)

**Interfaces:**
- Consumes: `normalizeAllocationCount`, `sumAllocationCounts`, `assertSumWithinCap` из Task 1; `normalizePeopleCount` из `peopleCount.js`
- Produces:
  - `GET /api/people-allocations?date=YYYY-MM-DD` → `{ allocations: [{ employee_id, work_type, quarter, people_count }] }`
  - `PUT /api/people-allocations` body `{ date, employee_id, work_type, quarter, people_count }` → `{ success: true, people_count }`
  - `DELETE /api/people-allocations` body `{ date, employee_id, work_type, quarter }` → `{ success: true }`

- [ ] **Step 1: В ensureTables — CREATE TABLE + UNIQUE индексы**

После блока `cell_closures` (или рядом с attendance) добавить:

```js
await pool.query(`
  CREATE TABLE IF NOT EXISTS people_allocations (
    id SERIAL PRIMARY KEY,
    date TEXT NOT NULL,
    employee_id INTEGER NOT NULL,
    work_type TEXT NOT NULL,
    quarter TEXT NOT NULL,
    people_count INTEGER NOT NULL,
    brigadier_id INTEGER,
    demo_session_id TEXT
  )
`);
await pool.query(`
  CREATE UNIQUE INDEX IF NOT EXISTS people_allocations_prod_uniq
  ON people_allocations (brigadier_id, date, employee_id, work_type, quarter)
  WHERE demo_session_id IS NULL
`);
await pool.query(`
  CREATE UNIQUE INDEX IF NOT EXISTS people_allocations_demo_uniq
  ON people_allocations (demo_session_id, date, employee_id, work_type, quarter)
  WHERE demo_session_id IS NOT NULL
`);
```

В демо-блоке (где уже вешают FK на `demo_sessions` для других таблиц) — добавить FK CASCADE для `people_allocations.demo_session_id`, по тому же паттерну что `cell_closures` / `attendance`.

- [ ] **Step 2: require хелперов вверху server.js**

```js
const {
  normalizeAllocationCount,
  sumAllocationCounts,
  assertSumWithinCap,
} = require('./peopleAllocations');
```

(рядом с существующим `normalizePeopleCount`)

- [ ] **Step 3: Реализовать GET**

После `app.patch('/api/attendance'...)`:

```js
app.get('/api/people-allocations', authOrDemo, async (req, res) => {
  try {
    const date = req.query.date;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'Дата в формате YYYY-MM-DD' });
    }
    let r;
    if (DEMO_MODE) {
      r = await pool.query(
        `SELECT employee_id, work_type, quarter, people_count
         FROM people_allocations
         WHERE demo_session_id = $1 AND date = $2
         ORDER BY work_type, quarter`,
        [req.demo_session_id, date]
      );
    } else {
      r = await pool.query(
        `SELECT employee_id, work_type, quarter, people_count
         FROM people_allocations
         WHERE brigadier_id = $1 AND date = $2
         ORDER BY work_type, quarter`,
        [req.brigadier.id, date]
      );
    }
    res.json({ allocations: r.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

- [ ] **Step 4: Реализовать PUT (upsert + проверка суммы ≤ N)**

Логика:

1. Валидация date, employee_id, work_type (trim, непустой), quarter (непустой string), people_count через `normalizeAllocationCount`.
2. Проверить явку: сотрудник есть на дату у владельца; `people_count` явки не null. Иначе 400/404 с понятным текстом («Сначала отметьте в явке» / «Сначала укажите общее к-во чел.»).
3. В транзакции (`withTransaction` из `db.js`, если уже используется в проекте; иначе begin/commit вручную):
   - upsert куска (DEMO: `brigadier_id=0` + demo_session_id, как attendance insert; PROD: brigadier_id);
   - SELECT всех кусков сотрудника+даты; `assertSumWithinCap(sum, attendanceN)`.
4. При нарушении суммы — rollback, 400.

Upsert SQL (демо):

```sql
INSERT INTO people_allocations
  (date, employee_id, work_type, quarter, people_count, brigadier_id, demo_session_id)
VALUES ($1,$2,$3,$4,$5,0,$6)
ON CONFLICT (demo_session_id, date, employee_id, work_type, quarter)
  WHERE demo_session_id IS NOT NULL
DO UPDATE SET people_count = EXCLUDED.people_count
```

PostgreSQL: `ON CONFLICT` по partial unique index требует указания constraint/index name или колонок, совпадающих с индексом. Если `ON CONFLICT` с partial index капризничает — сделать: `UPDATE ... IF FOUND; else INSERT` в транзакции (проще и надёжнее для этого проекта).

Рекомендуемый паттерн без ON CONFLICT:

```js
const updated = await client.query(
  `UPDATE people_allocations SET people_count = $1
   WHERE demo_session_id = $2 AND date = $3 AND employee_id = $4
     AND work_type = $5 AND quarter = $6`,
  [count, demoSessionId, date, eid, workType, quarter]
);
if (updated.rowCount === 0) {
  await client.query(
    `INSERT INTO people_allocations
      (date, employee_id, work_type, quarter, people_count, brigadier_id, demo_session_id)
     VALUES ($1,$2,$3,$4,$5,0,$6)`,
    [date, eid, workType, quarter, count, demoSessionId]
  );
}
```

Аналог для прода с `brigadier_id`.

- [ ] **Step 5: Реализовать DELETE куска**

После delete — пересчёт суммы не нужен (уменьшение всегда ≤ N). 404 если строки не было — по желанию; достаточно `success: true` если rowCount 0 или 1.

- [ ] **Step 6: Ручная проверка API (или короткий smoke-скрипт не обязателен)**

Поднять сервер локально / на уже бегущем:  
`GET` пустой список; выставить явку+N; `PUT` кусок 6; `PUT` ещё 4 на другой вид; `PUT` 11 на один вид → 400.

- [ ] **Step 7: Commit**

```bash
git add server/server.js
git commit -m "feat(allocations): table and GET/PUT/DELETE API"
```

---

### Task 3: Каскад и проверка N в PATCH/DELETE attendance

**Files:**
- Modify: `server/server.js` — `app.patch('/api/attendance')`, `app.delete('/api/attendance')`

**Interfaces:**
- Consumes: `sumAllocationCounts`, `assertSumWithinCap` (логика: перед UPDATE N — если новое N число и sum(кусков) > N → 400; если N=null → DELETE кусков; DELETE attendance → DELETE кусков)

- [ ] **Step 1: В PATCH attendance — перед UPDATE**

После успешного `normalizePeopleCount`:

```js
// псевдокод внутри существующего handler
const alloc = await pool.query(
  DEMO_MODE
    ? `SELECT people_count FROM people_allocations
       WHERE demo_session_id=$1 AND date=$2 AND employee_id=$3`
    : `SELECT people_count FROM people_allocations
       WHERE brigadier_id=$1 AND date=$2 AND employee_id=$3`,
  DEMO_MODE ? [req.demo_session_id, date, eid] : [req.brigadier.id, date, eid]
);
const sum = sumAllocationCounts(alloc.rows);

if (peopleCount === null) {
  // каскад: удалить куски, затем UPDATE people_count = null
  await pool.query(
    DEMO_MODE
      ? `DELETE FROM people_allocations WHERE demo_session_id=$1 AND date=$2 AND employee_id=$3`
      : `DELETE FROM people_allocations WHERE brigadier_id=$1 AND date=$2 AND employee_id=$3`,
    ...
  );
} else {
  try {
    assertSumWithinCap(sum, peopleCount);
  } catch (e) {
    return res.status(400).json({
      error: `Разбивка ${sum} больше нового N (${peopleCount}); поправьте куски`,
    });
  }
}
// затем существующий UPDATE attendance
```

Лучше обернуть delete+update в одну транзакцию.

- [ ] **Step 2: В DELETE attendance — сначала удалить куски**

Перед или сразу после DELETE attendance — `DELETE FROM people_allocations WHERE ... date + employee_id + owner`.

- [ ] **Step 3: Commit**

```bash
git add server/server.js
git commit -m "feat(attendance): cascade allocations on N clear/remove"
```

---

### Task 4: UI разбивки на «Ввод данных»

**Files:**
- Modify: `public/js/app.js`
- Modify: `public/styles.css`
- Возможно: `public/service-worker.js` — бамп `CACHE_NAME`, если так принято при правках app.js

**Interfaces:**
- Consumes: API Task 2; `this.present`, `this.ctxWorkType`, `this.ctxQuarter`, `this.selectedEmployeeId`, `this.inputDate`
- Produces: `this.allocations` (массив за день); методы `loadAllocations`, `saveAllocation`, `deleteAllocation`, `renderAllocationUi`

- [ ] **Step 1: Состояние и загрузка**

В конструкторе/инициализации:

```js
this.allocations = []; // { employee_id, work_type, quarter, people_count }
```

`loadAllocations(date)` → `GET /api/people-allocations?date=` → `this.allocations = data.allocations || []`.

Вызывать вместе с `loadAttendance` (после логина, смены даты, сброса).

- [ ] **Step 2: Блок UI в renderInput**

В блоке «Добавить запись» (после строки «Сотрудник: …»), если есть выбранный сотрудник с N и выбраны вид+квартал:

```html
<div class="form-group alloc-row">
  <label>Чел. на этот вид / квартал:</label>
  <input type="number" id="i2-alloc-count" min="1" max="999" inputmode="numeric"
    value="...текущий кусок или пусто...">
  <button type="button" class="mini-btn" onclick="app.saveAllocation()">Сохранить чел.</button>
  <button type="button" class="mini-btn" onclick="app.clearAllocation()" ...>✕</button>
</div>
```

Если вид или квартал не выбраны — disabled + подсказка «Сначала вид работ и квартал».  
Если у выбранного нет N — поле скрыто/неактивно («Сначала общее к-во чел. на плашке»).

Под плашками явки или под этим полем — список кусков **выбранного** (или всех за день) + предупреждение:

```js
formatAllocationProgress(sumForEmployee, N) // можно скопировать ту же формулу на клиенте одной функцией
```

Клиентская копия прогресса:

```js
allocationProgress(sum, cap) {
  if (!cap || sum === 0 || sum === cap) return null;
  return `Разбивка ${sum} из ${cap}`;
}
```

- [ ] **Step 3: saveAllocation / clearAllocation**

`saveAllocation`: читает `#i2-alloc-count`, `PUT` с `work_type: this.ctxWorkType`, `quarter: this.ctxQuarter`, `employee_id: this.selectedEmployeeId`, `date: this.inputDate`. При ошибке — показать `error` в `#i2-msg`. Успех → `loadAllocations` + лёгкий re-render нужного куска (или `renderInput`).

`clearAllocation`: `DELETE` того же ключа.

Не менять `selectWorker` / ввод рядов.

- [ ] **Step 4: Стили**

Минимально: `.alloc-warn { color: … }` для предупреждения; не раздувать CSS.

- [ ] **Step 5: Бамп SW cache** (если в проекте бампят при правках `app.js`)

Найти `CACHE_NAME` в `public/service-worker.js`, увеличить суффикс.

- [ ] **Step 6: Ручной smoke на демке/локально**

1. Явка Халил, N=10, без разбивки → ряды добавляются как раньше.  
2. Вид+квартал → чел. 6 → сохранить; другой вид → 4; предупреждение пропало.  
3. Попытка 11 → ошибка.  
4. N 10→8 при сумме 10 → ошибка; поправить куски → ок.  
5. N 10→12 → «Разбивка 10 из 12».  
6. Снять с явки → куски исчезли после перезагрузки.

- [ ] **Step 7: Commit**

```bash
git add public/js/app.js public/styles.css public/service-worker.js
git commit -m "feat(input): UI for people allocation by work type and quarter"
```

---

## Self-review (plan vs spec)

| Спека | Задача |
|-------|--------|
| Таблица people_allocations | Task 2 |
| GET/PUT/DELETE API, сумма ≤ N | Task 2 |
| Разбивка необязательна | Task 2–4 (нет кусков = ок) |
| Предупреждение X из N | Task 1 + 4 |
| Правка N ↑/↓, каскад при сбросе N | Task 3 |
| DELETE явки чистит куски | Task 3 |
| UI поле при виде+квартале, тап имени = выбор | Task 4 |
| Не трогать бухгалтерию / ряды | Global Constraints |

Нет TBD/placeholder-шагов без кода.
