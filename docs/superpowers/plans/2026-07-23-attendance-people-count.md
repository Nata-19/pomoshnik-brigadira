# К-во чел. в явке — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Бригадир на явке вписывает к-во чел. напротив фамилии на сегодня; в «Всего за день» видно `Халил 10 чел. — 60 рядов, 3000 кустов`.

**Architecture:** Число хранится только в `attendance.people_count` (на дату + сотрудника), не в `employees` и не в `work_logs`. Сервер: колонка + `GET` отдаёт число + `PATCH` обновляет. Фронт: поле на плашке явки; подпись в плашках «Всего за день» через lookup по имени из `this.present`. Чистая валидация/форматирование — в `server/peopleCount.js` (тесты node:test).

**Tech Stack:** Node ≥20, Express, PostgreSQL (`pg`), vanilla JS в `public/js/app.js`, `node --test`.

**Spec:** `docs/superpowers/specs/2026-07-23-attendance-people-count-design.md`

## Global Constraints

- Не добавлять тип «устроенный/приезжий» в справочник сотрудников.
- Не дублировать `people_count` в `work_logs`.
- Не менять вечерний ввод рядов, контроль рядов, спорные, бухгалтерию, Excel.
- `people_count`: `null` или целое 1…999.
- Демо и прод — один код (ветки `DEMO_MODE` как у текущей явки).
- Репозиторий публичный: без реальных фамилий клиентов в коммитах/тестах (в тестах — вымышленные «Халил»/«Ivanov» ок как в спеке).

## File map

| File | Role |
|------|------|
| `server/peopleCount.js` | `normalizePeopleCount`, `formatEmployeeWithCount` |
| `test/peopleCount.test.js` | unit-тесты хелперов |
| `server/server.js` | миграция колонки; GET/PATCH attendance |
| `public/js/app.js` | плашки с полем; PATCH; подпись в отчёте дня |
| `public/styles.css` | стили `.chip-count` |

---

### Task 1: Хелперы peopleCount + тесты

**Files:**
- Create: `server/peopleCount.js`
- Create: `test/peopleCount.test.js`

**Interfaces:**
- Produces:
  - `normalizePeopleCount(raw: unknown): number | null` — бросает `Error` с `statusCode = 400` при невалидном значении
  - `formatEmployeeWithCount(name: string, peopleCount: number | null | undefined): string`

- [ ] **Step 1: Write the failing tests**

```js
// test/peopleCount.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizePeopleCount, formatEmployeeWithCount } = require('../server/peopleCount');

test('normalizePeopleCount: пустое → null', () => {
  assert.equal(normalizePeopleCount(null), null);
  assert.equal(normalizePeopleCount(undefined), null);
  assert.equal(normalizePeopleCount(''), null);
});

test('normalizePeopleCount: целое 1…999 → число', () => {
  assert.equal(normalizePeopleCount(1), 1);
  assert.equal(normalizePeopleCount(10), 10);
  assert.equal(normalizePeopleCount('999'), 999);
});

test('normalizePeopleCount: невалидное → Error statusCode 400', () => {
  for (const bad of [0, -1, 1000, 1.5, 'abc', '10.5']) {
    assert.throws(() => normalizePeopleCount(bad), (err) => err.statusCode === 400);
  }
});

test('formatEmployeeWithCount: с числом и без', () => {
  assert.equal(formatEmployeeWithCount('Халил', 10), 'Халил 10 чел.');
  assert.equal(formatEmployeeWithCount('Халил', null), 'Халил');
  assert.equal(formatEmployeeWithCount('Халил', undefined), 'Халил');
});
```

- [ ] **Step 2: Run tests — expect FAIL (module missing)**

Run: `node --test test/peopleCount.test.js`  
Expected: FAIL — cannot find module `../server/peopleCount`

- [ ] **Step 3: Implement helpers**

```js
// server/peopleCount.js
'use strict';

function normalizePeopleCount(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isInteger(n) || n < 1 || n > 999) {
    const err = new Error('К-во чел.: целое от 1 до 999 или пусто');
    err.statusCode = 400;
    throw err;
  }
  return n;
}

function formatEmployeeWithCount(name, peopleCount) {
  const label = name == null || name === '' ? '—' : String(name);
  const n = peopleCount == null || peopleCount === '' ? null : Number(peopleCount);
  if (Number.isInteger(n) && n >= 1) return `${label} ${n} чел.`;
  return label;
}

module.exports = { normalizePeopleCount, formatEmployeeWithCount };
```

- [ ] **Step 4: Run tests — expect PASS**

Run: `node --test test/peopleCount.test.js`  
Expected: all tests pass

- [ ] **Step 5: Commit**

```bash
git add server/peopleCount.js test/peopleCount.test.js
git commit -m "feat(attendance): helpers for people_count validate/format"
```

---

### Task 2: БД + GET/PATCH attendance

**Files:**
- Modify: `server/server.js` (init schema ~строка 224 рядом с другими `ALTER TABLE attendance`; блок явки ~926–1020)
- Consumes: `normalizePeopleCount` from `./peopleCount`

**Interfaces:**
- Consumes: `normalizePeopleCount(raw)`
- Produces:
  - `GET /api/attendance?date=` → `{ present: [{ employee_id, name, people_count }] }` где `people_count` — `number | null`
  - `PATCH /api/attendance` body `{ date, employee_id, people_count }` → `{ success: true, people_count }`

- [ ] **Step 1: Require helper at top of server.js**

Рядом с другими `require`:

```js
const { normalizePeopleCount } = require('./peopleCount');
```

- [ ] **Step 2: Add migration after existing attendance demo_session_id alter (~строка 224)**

```js
await pool.query(`ALTER TABLE attendance ADD COLUMN IF NOT EXISTS people_count INTEGER`);
```

- [ ] **Step 3: Update GET /api/attendance SELECT**

В обоих запросах (demo и prod) заменить список колонок:

```sql
SELECT a.employee_id, e.name, a.people_count
```

В JSON клиент получит `people_count: null` или число (pg вернёт integer).

- [ ] **Step 4: Add PATCH /api/attendance после POST/DELETE блока явки**

```js
app.patch('/api/attendance', authOrDemo, async (req, res) => {
  try {
    const { date, employee_id, people_count: rawCount } = req.body || {};
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'Дата в формате YYYY-MM-DD' });
    }
    const eid = parseInt(employee_id, 10);
    if (!Number.isInteger(eid)) {
      return res.status(400).json({ error: 'Неверный id сотрудника' });
    }
    let peopleCount;
    try {
      peopleCount = normalizePeopleCount(rawCount);
    } catch (e) {
      return res.status(e.statusCode || 400).json({ error: e.message });
    }

    let result;
    if (DEMO_MODE) {
      result = await pool.query(
        `UPDATE attendance SET people_count = $1
         WHERE demo_session_id = $2 AND date = $3 AND employee_id = $4`,
        [peopleCount, req.demo_session_id, date, eid]
      );
    } else {
      result = await pool.query(
        `UPDATE attendance SET people_count = $1
         WHERE brigadier_id = $2 AND date = $3 AND employee_id = $4`,
        [peopleCount, req.brigadier.id, date, eid]
      );
    }
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Сначала отметьте сотрудника в явке' });
    }
    res.json({ success: true, people_count: peopleCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

- [ ] **Step 5: Run unit tests (regression)**

Run: `node --test`  
Expected: PASS (включая `peopleCount` и существующие тесты)

- [ ] **Step 6: Commit**

```bash
git add server/server.js
git commit -m "feat(attendance): people_count column, GET field, PATCH endpoint"
```

---

### Task 3: UI плашки явки + сохранение числа

**Files:**
- Modify: `public/js/app.js` — `renderInput` chips (~836–841), новые методы `savePeopleCount`, правки `selectWorker` не трогать логику рядов
- Modify: `public/styles.css` — `.chip`, `.chip-name`, `.chip-count`

**Interfaces:**
- Consumes: `GET` с `people_count`; `PATCH /api/attendance`
- Produces: плашка с полем; `this.present[].people_count` актуален после сохранения

- [ ] **Step 1: CSS для поля на плашке**

В `public/styles.css` после `.chip.on`:

```css
.chip-name {
    cursor: pointer;
}

.chip-count {
    width: 3.2em;
    border: 1px solid #ccc;
    border-radius: 8px;
    padding: 2px 4px;
    font-size: 13px;
    text-align: center;
    background: #fff;
    color: #222;
}

.chip.on .chip-count {
    border-color: #fff;
}
```

В существующем правиле `.chip` заменить `display: inline-block` на:

```css
display: inline-flex;
align-items: center;
gap: 6px;
```

- [ ] **Step 2: Рендер плашек с полем**

Заменить map плашек в `renderInput` (~839–841):

```js
this.present.map(p => {
  const on = p.employee_id === this.selectedEmployeeId ? 'on' : '';
  const val = (p.people_count != null && p.people_count !== '') ? String(p.people_count) : '';
  return `<span class="chip ${on}">
    <span class="chip-name" onclick="app.selectWorker(${p.employee_id})">${this.escapeHtml(p.name)}</span>
    <input class="chip-count" type="number" min="1" max="999" inputmode="numeric"
      placeholder="чел." title="К-во человек сегодня"
      value="${this.escapeHtml(val)}"
      onclick="event.stopPropagation()"
      onchange="app.savePeopleCount(${p.employee_id}, this.value)">
  </span>`;
}).join('')
```

- [ ] **Step 3: Метод savePeopleCount**

Рядом с `markPresent` / `selectWorker`:

```js
async savePeopleCount(employeeId, rawValue) {
  let people_count;
  const trimmed = String(rawValue == null ? '' : rawValue).trim();
  if (trimmed === '') {
    people_count = null;
  } else {
    const n = Number(trimmed);
    if (!Number.isInteger(n) || n < 1 || n > 999) {
      alert('К-во чел.: целое от 1 до 999 или пусто');
      await this.loadAttendance(this.inputDate);
      this.renderInput();
      return;
    }
    people_count = n;
  }
  try {
    const r = await this.apiFetch('/api/attendance', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        date: this.inputDate,
        employee_id: employeeId,
        people_count,
      }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'Не удалось сохранить к-во чел.');
    const row = this.present.find(p => p.employee_id === employeeId);
    if (row) row.people_count = people_count;
  } catch (e) {
    alert('Ошибка: ' + e.message);
    await this.loadAttendance(this.inputDate);
    this.renderInput();
  }
}
```

- [ ] **Step 4: Manual check (локально / демо)**

1. Отметить сотрудника в явке → на плашке пустое поле.
2. Вписать `10`, уйти с поля (change) → перезагрузить страницу → `10` на месте.
3. Очистить поле → после reload пусто.
4. Тап по имени → синяя плашка, ввод рядов работает как раньше.

- [ ] **Step 5: Commit**

```bash
git add public/js/app.js public/styles.css
git commit -m "feat(attendance): people count input on present chips"
```

---

### Task 4: Подпись в «Всего за день»

**Files:**
- Modify: `public/js/app.js` — `renderManualBlockHtml`, `renderMechBlockHtml`, `renderPlatesReportHtml` / `renderDailyTotalsHtml`

**Interfaces:**
- Consumes: `this.present` с `people_count`; lookup по `name`
- Produces: строка `Халил 10 чел. — …` только в дневном итоге

- [ ] **Step 1: Helper на классе App**

```js
peopleCountForName(name) {
  const p = (this.present || []).find(x => x.name === name);
  if (!p || p.people_count == null || p.people_count === '') return null;
  const n = Number(p.people_count);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

formatEmployeeLabel(name) {
  const n = this.peopleCountForName(name);
  if (n != null) return `${name} ${n} чел.`;
  return name || '—';
}
```

(Дублирует логику `formatEmployeeWithCount` на клиенте — браузерный бандл без require; не подключать `server/peopleCount.js` в `index.html`.)

- [ ] **Step 2: Флаг withPeopleCount в ручном/мех рендере**

Сигнатуры:

```js
renderManualBlockHtml(logs, { withPeopleCount = false } = {})
renderMechBlockHtml(logs, { withPeopleCount = false } = {})
```

В строке работника:

```js
const empLabel = withPeopleCount
  ? this.formatEmployeeLabel(r.employee)
  : (r.employee || '—');
return `<div class="report-line">${this.escapeHtml(empLabel)} — ${measure}${place}</div>`;
```

- [ ] **Step 3: Прокинуть флаг только для дня**

Найти `renderPlatesReportHtml` / `renderDailyTotalsHtml` / `renderTwoBlocksReportHtml` — для дневного вызова передавать `withPeopleCount: true`. Для «Отчёт за период» — не передавать (остаётся `false`).

Пример, если есть общий рендерер:

```js
renderPlatesReportHtml(logs, { grandLabel, withPeopleCount = false } = {}) {
  // …
  const manualBlock = manualLogs.length > 0
    ? this.renderManualBlockHtml(manualLogs, { withPeopleCount })
    : '';
  const mechBlock = mechLogs.length > 0
    ? this.renderMechBlockHtml(mechLogs, { withPeopleCount })
    : '';
  // …
}

renderDailyTotalsHtml() {
  return this.renderPlatesReportHtml(this.entries, {
    grandLabel: 'Всего за день',
    withPeopleCount: true,
  });
}
```

Период — `withPeopleCount` не ставить (имена без «N чел.»; показ в периоде вне скоупа MVP).

- [ ] **Step 4: Проверка**

1. Явка: Халил, к-во 10; запись рядов → «Всего за день»: `Халил 10 чел. — …`.
2. «Отчёт за период» — имена **без** «N чел.».
3. `node --test` — PASS.

- [ ] **Step 5: Commit**

```bash
git add public/js/app.js
git commit -m "feat(report): show people count in daily totals labels"
```

- [ ] **Step 6: Update _progress.md локально (если в gitignore — не коммитить)**

Отметить: спека+план+реализация к-во чел. в явке; бухгалтерия — позже.

---

## Spec coverage (self-review)

| Spec requirement | Task |
|------------------|------|
| `attendance.people_count` | Task 2 |
| GET возвращает число | Task 2 |
| PATCH обновляет | Task 2 |
| Плашка: имя + поле | Task 3 |
| Число не в employees / не на завтра | Task 2–3 (хранение по date) |
| Вечерний ввод без изменений | Task 3 (только chips) |
| «Всего за день»: `Имя N чел. — …` | Task 4 |
| Не бухгалтерия / не период (MVP) | Task 4 флаг `withPeopleCount` |
| Валидация 1…999 / null | Task 1–3 |

## Placeholder scan

Нет TBD/TODO в шагах; код вставлен целиком.

## Type consistency

- Поле везде: `people_count`
- API body: `{ date, employee_id, people_count }`
- Present row: `{ employee_id, name, people_count }`
