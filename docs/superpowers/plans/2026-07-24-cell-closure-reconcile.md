# Закрытие клетки на «Сверке» — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Бригадир на «Сверке» закрывает/открывает клетку по виду работ (метка) и видит обзор всех клеток квартала со статусами и кнопками Закрыть/Открыть.

**Architecture:** Таблица `cell_closures` + API POST/DELETE; `GET /api/rows-status` отдаёт `closed`; новый `GET /api/rows-status/quarter` считает сверку по каждой клетке квартала. UI: клетка необязательна; кнопки в детальном виде и в списке квартала. Ввод рядов не блокируется.

**Tech Stack:** Node ≥20, Express, PostgreSQL, vanilla `public/js/app.js`, `node --test`.

**Spec:** `docs/superpowers/specs/2026-07-24-cell-closure-reconcile-design.md`

## Global Constraints

- Метка только для бригадира; **не** запрет `POST /api/logs`.
- Закрыть только если `fullyDone` (нет пропусков и нет спорных).
- Ключ: estate + quarter + cell + work_type + владелец (demo_session_id | brigadier_id).
- Демо и прод — один код (`DEMO_MODE` / `rowOwner` как у rows-status).
- Мелкие коммиты (свет могут отключить).
- Репозиторий публичный: без реальных клиентских данных в тестах.

## File map

| File | Role |
|------|------|
| `server/cellClosure.js` | `closureStatusLabel`, `canCloseCell` (pure) |
| `test/cellClosure.test.js` | unit-тесты хелперов |
| `server/server.js` | миграция, GET closed, quarter endpoint, POST/DELETE |
| `public/js/app.js` | Сверка UI |
| `public/styles.css` | кнопки/строки списка при необходимости |

---

### Task 1: Хелперы статуса + тесты

**Files:**
- Create: `server/cellClosure.js`
- Create: `test/cellClosure.test.js`

**Interfaces:**
- Produces:
  - `canCloseCell({ fullyDone, closed }): boolean` — true только если fullyDone && !closed
  - `closureStatusLabel({ closed, fullyDone, disputedCount, missedRowsLength }): string` — одна из: `Закрыта` | `Готова` | `Есть спорные` | `Есть пропуски` | `В работе` (fallback)

- [ ] **Step 1: Write failing tests**

```js
// test/cellClosure.test.js
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
```

- [ ] **Step 2: Run — expect FAIL (module missing)**

`node --test test/cellClosure.test.js`

- [ ] **Step 3: Implement**

```js
// server/cellClosure.js
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
```

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add server/cellClosure.js test/cellClosure.test.js
git commit -m "feat(reconcile): helpers for cell closure status labels"
```

---

### Task 2: БД + API closures + closed в rows-status

**Files:**
- Modify: `server/server.js`
- Consumes: `canCloseCell`, `rowOwner`, `computeCellReconciliation`

**Interfaces:**
- Produces:
  - `GET /api/rows-status` → существующие поля + `closed: boolean` + `canClose: boolean`
  - `POST /api/cell-closures` body `{ estate, quarter, cell, work_type }` → `{ success, closed: true }` или 400
  - `DELETE /api/cell-closures` body `{ estate, quarter, cell, work_type }` → `{ success, closed: false }`

- [ ] **Step 1: require**

```js
const { canCloseCell, closureStatusLabel } = require('./cellClosure');
```

- [ ] **Step 2: Migration** (паттерн как `disputed_rows`: без FK в общем CREATE; FK в демо-блоке)

```js
await pool.query(`
  CREATE TABLE IF NOT EXISTS cell_closures (
    id SERIAL PRIMARY KEY,
    estate_id TEXT NOT NULL,
    quarter TEXT NOT NULL,
    cell TEXT NOT NULL,
    work_type TEXT NOT NULL,
    brigadier_id INTEGER,
    demo_session_id TEXT,
    closed_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
  )
`);
await pool.query(`
  CREATE UNIQUE INDEX IF NOT EXISTS cell_closures_prod_uniq
  ON cell_closures (brigadier_id, estate_id, quarter, cell, work_type)
  WHERE demo_session_id IS NULL
`);
await pool.query(`
  CREATE UNIQUE INDEX IF NOT EXISTS cell_closures_demo_uniq
  ON cell_closures (demo_session_id, estate_id, quarter, cell, work_type)
  WHERE demo_session_id IS NOT NULL
`);
```

В DEMO_MODE секции:

```js
await pool.query(`
  DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cell_closures_demo_session_fk') THEN
      ALTER TABLE cell_closures
        ADD CONSTRAINT cell_closures_demo_session_fk
        FOREIGN KEY (demo_session_id) REFERENCES demo_sessions(id) ON DELETE CASCADE;
    END IF;
  END $$;
`);
```

- [ ] **Step 3: Helper `isCellClosed`**

```js
async function isCellClosed(pool, owner, estate, quarter, cell, workType) {
  const r = await pool.query(
    `SELECT 1 FROM cell_closures
     WHERE estate_id = $1 AND quarter = $2 AND cell = $3 AND work_type = $4 AND ${owner.col} = $5
     LIMIT 1`,
    [estate, String(quarter), String(cell), workType, owner.val]
  );
  return r.rowCount > 0;
}
```

- [ ] **Step 4: Extend GET /api/rows-status**

```js
const closed = await isCellClosed(pool, owner, estate, quarter, cell, work_type);
res.json({
  ...result,
  closed,
  canClose: canCloseCell({ fullyDone: result.fullyDone, closed }),
});
```

- [ ] **Step 5: POST /api/cell-closures**

Валидация как rows-status → пересчёт сверки → если `!fullyDone` → 400  
`Нельзя закрыть: есть пропуски или спорные` → INSERT (идемпотентно при уже закрытой) → `{ success: true, closed: true }`.

- [ ] **Step 6: DELETE /api/cell-closures**

DELETE по ключу+owner → всегда `{ success: true, closed: false }`.

- [ ] **Step 7: `node --test` PASS → commit**

```bash
git add server/server.js
git commit -m "feat(reconcile): cell_closures table and close/open API"
```

---

### Task 3: GET quarter overview

**Files:**
- Modify: `server/server.js`

**Interfaces:**
- `GET /api/rows-status/quarter?estate&quarter&work_type`
- `{ cells: [{ cell, ...reconcile, closed, canClose, statusLabel }] }`
- Список клеток: ключи `quarters[quarter].cells` из инвентаря parser/demo, сортировка.

- [ ] **Step 1: Endpoint** — для каждой клетки reconcile + closed + labels

- [ ] **Step 2: `node --test` PASS**

- [ ] **Step 3: Commit**

```bash
git add server/server.js
git commit -m "feat(reconcile): quarter overview endpoint for cell statuses"
```

---

### Task 4: UI Сверки — клетка + квартал + кнопки

**Files:**
- Modify: `public/js/app.js`, `public/styles.css`

- [ ] **Step 1:** Заголовок «Сверка»; опция клетки `value=""` — «Все клетки...»

- [ ] **Step 2:** `loadRowsStatus` — без cell → quarter API; с cell → rows-status + кнопки

- [ ] **Step 3:** `renderRowsStatus` — статус + Закрыть/Открыть; `this._rcLast` для перезагрузки

- [ ] **Step 4:** `renderQuarterRowsStatus` — список клеток со `statusLabel` и кнопками; тап по номеру → детальная клетка

- [ ] **Step 5:** `closeCellClosure(cell?)` / `openCellClosure(cell?)` — POST/DELETE, затем reload

- [ ] **Step 6:** Одна подсказка гида про Сверку

- [ ] **Step 7: Commit**

```bash
git add public/js/app.js public/styles.css
git commit -m "feat(reconcile): close/open UI and quarter cell list"
```

---

## Spec coverage

| Spec | Task |
|------|------|
| cell_closures | 2 |
| POST/DELETE + fullyDone | 2 |
| closed on GET cell | 2 |
| GET quarter | 3 |
| UI buttons cell + quarter | 4 |
| No log blocking | (не делаем) |
