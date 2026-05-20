# Этап 2: Быстрый структурированный ввод — План реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Заменить текстовый ввод работы структурированным: личный список сотрудников, общий список видов работ, ежедневная явка, ввод записей карточками с тремя режимами подсчёта (ряды+кусты / только ряды / только часы).

**Architecture:** На сервере — три новые таблицы (`employees`, `work_types`, `attendance`), три новые колонки в `work_logs` (`work_type`, `measure_mode`, `hours`) и набор endpoint'ов. Разбор рядов «1-5, 9» и подсчёт кустов переиспользуют `server/parser.js`. На клиенте вкладка «Ввод данных» переписывается в экран структурированного ввода; старый текстовый и голосовой ввод удаляются.

**Tech Stack:** Node.js, Express, PostgreSQL (Neon). Vanilla-JS PWA клиент.

**Testing note:** Тест-фреймворка в проекте нет и не добавляется (как в Этапе 1). Чистые функции проверяются одноразовым `node -e`; всё остальное — `node --check` (синтаксис) плюс ручной чек-лист в Задаче 10.

**Репозиторий публичный:** не коммить пароли, логины, секреты, фамилии, названия Excel-файлов.

---

### Task 1: Таблицы Этапа 2 и колонки `work_logs`

**Files:**
- Modify: `server/server.js` — стартовый блок `(async () => { ... })()`

- [ ] **Step 1: Добавить DDL в стартовый блок**

В `server/server.js` найди строку `    console.log('✅ Connected to Postgres');` внутри `try` стартового блока. **Прямо перед ней** вставь:

```js
    // --- Этап 2: списки и колонки для структурированного ввода ---
    await pool.query(`ALTER TABLE work_logs ADD COLUMN IF NOT EXISTS work_type TEXT NOT NULL DEFAULT ''`);
    await pool.query(`ALTER TABLE work_logs ADD COLUMN IF NOT EXISTS measure_mode TEXT NOT NULL DEFAULT 'rows_bushes'`);
    await pool.query(`ALTER TABLE work_logs ADD COLUMN IF NOT EXISTS hours INTEGER`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS employees (
        id SERIAL PRIMARY KEY,
        brigadier_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (brigadier_id, name)
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS work_types (
        id SERIAL PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS attendance (
        brigadier_id INTEGER NOT NULL,
        date TEXT NOT NULL,
        employee_id INTEGER NOT NULL,
        PRIMARY KEY (brigadier_id, date, employee_id)
      )
    `);
    // Заполняем общий список видов работ основными — один раз, если он пуст.
    const wtCount = await pool.query('SELECT COUNT(*)::int AS n FROM work_types');
    if (wtCount.rows[0].n === 0) {
      const basics = ['Обрезка', 'Подвязка', 'Опрыскивание', 'Уборка территории', 'Подготовка саженцев'];
      for (const name of basics) {
        await pool.query('INSERT INTO work_types (name) VALUES ($1) ON CONFLICT (name) DO NOTHING', [name]);
      }
    }
```

- [ ] **Step 2: Проверить синтаксис**

Run: `node --check server/server.js`
Expected: нет вывода, код возврата 0.

- [ ] **Step 3: Коммит**

```bash
git add server/server.js
git commit -m "Add Stage 2 tables (employees, work_types, attendance) and work_logs columns

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 2: Разбор списка рядов в `parser.js`

**Files:**
- Modify: `server/parser.js` — класс `DataParser`

- [ ] **Step 1: Добавить метод `parseRowList`**

В `server/parser.js` найди строку `  getBushesCount(estate, quarter, cell, rows) {`. **Прямо перед ней** вставь метод:

```js
  // Разбирает строку рядов вида "1-5, 9, 11" в отсортированный массив чисел.
  // Бросает понятную ошибку при неразборчивом вводе.
  parseRowList(spec) {
    const rows = new Set();
    const parts = String(spec == null ? '' : spec).split(',').map(p => p.trim()).filter(Boolean);
    if (parts.length === 0) {
      throw new Error('Укажи ряды, например: 1-5, 9, 11');
    }
    for (const part of parts) {
      const range = part.match(/^(\d+)\s*-\s*(\d+)$/);
      if (range) {
        const from = parseInt(range[1], 10);
        const to = parseInt(range[2], 10);
        if (from < 1) throw new Error(`Номер ряда начинается с 1: ${part}`);
        if (from > to) throw new Error(`Неверный диапазон рядов: ${part}`);
        for (let i = from; i <= to; i++) rows.add(i);
      } else if (/^\d+$/.test(part)) {
        const n = parseInt(part, 10);
        if (n < 1) throw new Error(`Номер ряда начинается с 1: ${part}`);
        rows.add(n);
      } else {
        throw new Error(`Не понял ряды: ${part}`);
      }
    }
    return Array.from(rows).sort((a, b) => a - b);
  }

```

- [ ] **Step 2: Проверить синтаксис**

Run: `node --check server/parser.js`
Expected: нет вывода, код возврата 0.

- [ ] **Step 3: Проверить функцию одноразовым скриптом**

Run эту команду из корня проекта:

```bash
node -e "
const P = require('./server/parser');
const p = new P({ estates: {} });
const eq = (a,b) => JSON.stringify(a) === JSON.stringify(b);
console.log('range+singles =>', eq(p.parseRowList('1-5, 9, 11, 15'), [1,2,3,4,5,9,11,15]) ? 'OK' : 'FAIL');
console.log('single        =>', eq(p.parseRowList('7'), [7]) ? 'OK' : 'FAIL');
console.log('dedup+sort    =>', eq(p.parseRowList('3, 1-2, 2'), [1,2,3]) ? 'OK' : 'FAIL');
let t = false; try { p.parseRowList('abc'); } catch (e) { t = true; }
console.log('bad input     =>', t ? 'OK' : 'FAIL');
t = false; try { p.parseRowList(''); } catch (e) { t = true; }
console.log('empty         =>', t ? 'OK' : 'FAIL');
t = false; try { p.parseRowList('0'); } catch (e) { t = true; }
console.log('zero single   =>', t ? 'OK' : 'FAIL');
t = false; try { p.parseRowList('0-3'); } catch (e) { t = true; }
console.log('zero range    =>', t ? 'OK' : 'FAIL');
"
```

Expected: семь строк, все заканчиваются на `OK`.

- [ ] **Step 4: Коммит**

```bash
git add server/parser.js
git commit -m "Add parseRowList: parse '1-5, 9, 11' row spec into number array

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 3: Endpoint'ы списка сотрудников

**Files:**
- Modify: `server/server.js`

- [ ] **Step 1: Добавить endpoint'ы сотрудников**

В `server/server.js` найди строку `// Health-check для UptimeRobot и Render`. **Прямо перед ней** вставь:

```js
// --- Этап 2: сотрудники (личный список бригадира) ---
app.get('/api/employees', requireAuthMw, async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT id, name FROM employees WHERE brigadier_id = $1 ORDER BY name',
      [req.brigadier.id]
    );
    res.json({ employees: r.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/employees', requireAuthMw, async (req, res) => {
  try {
    const name = (req.body.name || '').trim();
    if (!name) {
      return res.status(400).json({ error: 'Укажи фамилию' });
    }
    const exists = await pool.query(
      'SELECT 1 FROM employees WHERE brigadier_id = $1 AND name = $2',
      [req.brigadier.id, name]
    );
    if (exists.rows.length > 0) {
      return res.status(400).json({ error: 'Такой сотрудник уже есть' });
    }
    const ins = await pool.query(
      'INSERT INTO employees (brigadier_id, name) VALUES ($1, $2) RETURNING id, name',
      [req.brigadier.id, name]
    );
    res.json({ employee: ins.rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ error: 'Такой сотрудник уже есть' });
    }
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/employees/:id', requireAuthMw, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const result = await pool.query(
      'DELETE FROM employees WHERE id = $1 AND brigadier_id = $2 RETURNING id',
      [id, req.brigadier.id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Сотрудник не найден' });
    }
    await pool.query(
      'DELETE FROM attendance WHERE employee_id = $1 AND brigadier_id = $2',
      [id, req.brigadier.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

```

- [ ] **Step 2: Проверить синтаксис**

Run: `node --check server/server.js`
Expected: нет вывода, код возврата 0.

- [ ] **Step 3: Коммит**

```bash
git add server/server.js
git commit -m "Add employees endpoints (list, add, delete)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 4: Endpoint'ы видов работ

**Files:**
- Modify: `server/server.js`

- [ ] **Step 1: Добавить endpoint'ы видов работ**

В `server/server.js` найди закрывающую `});` endpoint'а `app.delete('/api/employees/:id', ...)` из Задачи 3. **Сразу после неё** вставь:

```js
// --- Этап 2: виды работ (общий список) ---
app.get('/api/work-types', requireAuthMw, async (req, res) => {
  try {
    const r = await pool.query('SELECT id, name FROM work_types ORDER BY name');
    res.json({ work_types: r.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/work-types', requireAuthMw, async (req, res) => {
  try {
    const name = (req.body.name || '').trim();
    if (!name) {
      return res.status(400).json({ error: 'Укажи название вида работ' });
    }
    const exists = await pool.query(
      'SELECT 1 FROM work_types WHERE LOWER(name) = LOWER($1)',
      [name]
    );
    if (exists.rows.length > 0) {
      return res.status(400).json({ error: 'Такой вид работ уже есть' });
    }
    const ins = await pool.query(
      'INSERT INTO work_types (name) VALUES ($1) RETURNING id, name',
      [name]
    );
    res.json({ work_type: ins.rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ error: 'Такой вид работ уже есть' });
    }
    res.status(500).json({ error: err.message });
  }
});

```

- [ ] **Step 2: Проверить синтаксис**

Run: `node --check server/server.js`
Expected: нет вывода, код возврата 0.

- [ ] **Step 3: Коммит**

```bash
git add server/server.js
git commit -m "Add work-types endpoints (list, add)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 5: Endpoint'ы явки

**Files:**
- Modify: `server/server.js`

- [ ] **Step 1: Добавить endpoint'ы явки**

В `server/server.js` найди закрывающую `});` endpoint'а `app.post('/api/work-types', ...)` из Задачи 4. **Сразу после неё** вставь:

```js
// --- Этап 2: явка (кто сегодня на работе) ---
app.get('/api/attendance', requireAuthMw, async (req, res) => {
  try {
    const date = req.query.date;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'Дата в формате YYYY-MM-DD' });
    }
    const r = await pool.query(
      `SELECT a.employee_id, e.name
       FROM attendance a JOIN employees e ON e.id = a.employee_id
       WHERE a.brigadier_id = $1 AND a.date = $2
       ORDER BY e.name`,
      [req.brigadier.id, date]
    );
    res.json({ present: r.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/attendance', requireAuthMw, async (req, res) => {
  try {
    const { date, employee_id } = req.body;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'Дата в формате YYYY-MM-DD' });
    }
    const eid = parseInt(employee_id, 10);
    const own = await pool.query(
      'SELECT 1 FROM employees WHERE id = $1 AND brigadier_id = $2',
      [eid, req.brigadier.id]
    );
    if (own.rows.length === 0) {
      return res.status(404).json({ error: 'Сотрудник не найден' });
    }
    await pool.query(
      `INSERT INTO attendance (brigadier_id, date, employee_id) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [req.brigadier.id, date, eid]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/attendance', requireAuthMw, async (req, res) => {
  try {
    const { date, employee_id } = req.body;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'Дата в формате YYYY-MM-DD' });
    }
    const eid = parseInt(employee_id, 10);
    if (!Number.isInteger(eid)) {
      return res.status(400).json({ error: 'Неверный id сотрудника' });
    }
    await pool.query(
      'DELETE FROM attendance WHERE brigadier_id = $1 AND date = $2 AND employee_id = $3',
      [req.brigadier.id, date, eid]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

```

- [ ] **Step 2: Проверить синтаксис**

Run: `node --check server/server.js`
Expected: нет вывода, код возврата 0.

- [ ] **Step 3: Коммит**

```bash
git add server/server.js
git commit -m "Add attendance endpoints (list, mark, unmark)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 6: Endpoint создания записи `POST /api/logs`

**Files:**
- Modify: `server/server.js`

- [ ] **Step 1: Добавить endpoint создания записи**

В `server/server.js` найди закрывающую `});` endpoint'а `app.delete('/api/attendance', ...)` из Задачи 5. **Сразу после неё** вставь:

```js
// --- Этап 2: создание одной записи журнала (структурированный ввод) ---
app.post('/api/logs', requireAuthMw, async (req, res) => {
  try {
    const { date, estate, quarter, cell, work_type, measure_mode, employee, rows, hours } = req.body;

    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'Дата в формате YYYY-MM-DD' });
    }
    if (!estate || !inventory.estates[estate]) {
      return res.status(400).json({ error: 'Не выбрано хозяйство' });
    }
    if (!employee || !employee.trim()) {
      return res.status(400).json({ error: 'Выбери сотрудника' });
    }
    if (!work_type || !work_type.trim()) {
      return res.status(400).json({ error: 'Выбери вид работ' });
    }
    if (!['rows_bushes', 'rows_only', 'hours'].includes(measure_mode)) {
      return res.status(400).json({ error: 'Неизвестный режим подсчёта' });
    }

    let rowsStr = '';
    let bushes = 0;
    let hoursVal = null;

    if (measure_mode === 'hours') {
      const h = parseInt(hours, 10);
      if (!Number.isInteger(h) || h <= 0) {
        return res.status(400).json({ error: 'Укажи часы числом' });
      }
      hoursVal = h;
    } else {
      if (!quarter || !cell) {
        return res.status(400).json({ error: 'Выбери клетку' });
      }
      let rowNums;
      try {
        rowNums = parser.parseRowList(rows);
      } catch (e) {
        return res.status(400).json({ error: e.message });
      }
      rowsStr = rowNums.join(',');
      if (measure_mode === 'rows_bushes') {
        try {
          bushes = parser.getBushesCount(estate, String(quarter), String(cell), rowNums);
        } catch (e) {
          return res.status(400).json({ error: e.message });
        }
      }
    }

    // Защита от непреднамеренных дублей: если ровно такая же запись была
    // создана в последние 10 секунд — отказываем. Случайный повторный тап
    // через несколько секунд после ответа не пройдёт, а намеренная одинаковая
    // запись позже этого окна — пройдёт.
    const dup = await pool.query(
      `SELECT id FROM work_logs
       WHERE brigadier_id = $1 AND date = $2 AND estate_id = $3
         AND quarter = $4 AND cell = $5 AND employee = $6
         AND work_type = $7 AND measure_mode = $8
         AND COALESCE(rows, '') = COALESCE($9, '')
         AND COALESCE(hours, -1) = COALESCE($10, -1)
         AND created_at > NOW() - INTERVAL '10 seconds'
       LIMIT 1`,
      [req.brigadier.id, date, estate,
       quarter ? String(quarter) : '', cell ? String(cell) : '',
       employee.trim(), work_type.trim(), measure_mode,
       rowsStr, hoursVal]
    );
    if (dup.rows.length > 0) {
      return res.status(409).json({ error: 'Такая же запись только что добавлена' });
    }

    const ins = await pool.query(
      `INSERT INTO work_logs
        (date, estate_id, quarter, cell, employee, rows, bushes, brigadier_id, work_type, measure_mode, hours)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id`,
      [date, estate, quarter ? String(quarter) : '', cell ? String(cell) : '',
       employee.trim(), rowsStr, bushes, req.brigadier.id,
       work_type.trim(), measure_mode, hoursVal]
    );
    res.json({ success: true, id: ins.rows[0].id });
  } catch (error) {
    console.error('Create log error:', error);
    res.status(500).json({ error: error.message });
  }
});

```

- [ ] **Step 2: Проверить синтаксис**

Run: `node --check server/server.js`
Expected: нет вывода, код возврата 0.

- [ ] **Step 3: Коммит**

```bash
git add server/server.js
git commit -m "Add POST /api/logs: create one structured work-log entry

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 7: Обновить `GET /api/logs` и `GET /api/report`

**Files:**
- Modify: `server/server.js` — endpoint'ы `GET /api/logs` и `GET /api/report`

- [ ] **Step 1: Добавить новые колонки в `GET /api/logs`**

В `server/server.js` в endpoint'е `app.get('/api/logs', ...)` две `pool.query`. В **обоих** SELECT'ах замени список колонок `id, date, estate_id, quarter, cell, employee, rows, bushes, created_at` на `id, date, estate_id, quarter, cell, employee, rows, bushes, work_type, measure_mode, hours, created_at`.

Ветка `date` становится:

```js
      result = await pool.query(
        `SELECT id, date, estate_id, quarter, cell, employee, rows, bushes, work_type, measure_mode, hours, created_at
         FROM work_logs WHERE date = $1 AND estate_id = $2 AND brigadier_id = $3
         ORDER BY created_at DESC`,
        [date, estate, req.brigadier.id]
      );
```

Ветка `from`/`to` становится:

```js
      result = await pool.query(
        `SELECT id, date, estate_id, quarter, cell, employee, rows, bushes, work_type, measure_mode, hours, created_at
         FROM work_logs WHERE date >= $1 AND date <= $2 AND estate_id = $3 AND brigadier_id = $4
         ORDER BY date DESC, created_at DESC`,
        [from, to, estate, req.brigadier.id]
      );
```

- [ ] **Step 2: Переписать тело `GET /api/report`**

В `server/server.js` в endpoint'е `app.get('/api/report', ...)` замени блок начиная со строки `    const result = await pool.query(` и до строки `    res.json({ report });` включительно (это SQL-запрос, группировка и формирование текста) на:

```js
    const result = await pool.query(
      `SELECT date, estate_id, quarter, cell, employee, rows, bushes, work_type, measure_mode, hours
       FROM work_logs
       WHERE date >= $1 AND date <= $2 AND estate_id = $3 AND brigadier_id = $4
       ORDER BY employee, work_type, date`,
      [from, to, estate, req.brigadier.id]
    );

    if (result.rows.length === 0) {
      return res.json({
        report: `Отчёт за период: ${from} — ${to}\n\nЗа указанный период данных нет.`
      });
    }

    // Группируем: сотрудник → вид работ → "квартал|клетка" → записи.
    const byEmp = {};
    for (const r of result.rows) {
      const wt = r.work_type && r.work_type.trim() ? r.work_type : '(без вида работ)';
      if (!byEmp[r.employee]) byEmp[r.employee] = {};
      if (!byEmp[r.employee][wt]) byEmp[r.employee][wt] = [];
      byEmp[r.employee][wt].push(r);
    }

    const rowCountOf = (r) => String(r.rows || '').split(',').filter(x => x.trim()).length;
    const newSlot = () => ({ rows: 0, bushes: 0, hours: 0, hasRows: false, hasBushes: false, hasHours: false });
    const unitText = (s) => {
      const p = [];
      if (s.hasRows) p.push(`${s.rows} рядов`);
      if (s.hasBushes) p.push(`${s.bushes} кустов`);
      if (s.hasHours) p.push(`${s.hours} часов`);
      return p.join(', ');
    };
    const addRec = (slot, r) => {
      if (r.measure_mode === 'hours') {
        slot.hours += r.hours || 0;
        slot.hasHours = true;
      } else {
        slot.rows += rowCountOf(r);
        slot.hasRows = true;
        if (r.measure_mode === 'rows_bushes') {
          slot.bushes += r.bushes || 0;
          slot.hasBushes = true;
        }
      }
    };

    let report = `Отчёт за период: ${from} — ${to}\n\n`;
    const employees = Object.keys(byEmp).sort((a, b) => a.localeCompare(b, 'ru'));
    for (const name of employees) {
      report += `${name}\n`;
      const workTypes = Object.keys(byEmp[name]).sort((a, b) => a.localeCompare(b, 'ru'));
      for (const wt of workTypes) {
        report += `  ${wt}\n`;
        const byCell = {};
        const wtTotal = newSlot();
        for (const r of byEmp[name][wt]) {
          const ck = (r.quarter || '') + '|' + (r.cell || '');
          if (!byCell[ck]) byCell[ck] = { quarter: r.quarter, cell: r.cell, slot: newSlot() };
          addRec(byCell[ck].slot, r);
          addRec(wtTotal, r);
        }
        for (const ck of Object.keys(byCell)) {
          const c = byCell[ck];
          const where = c.quarter ? `Кв.${c.quarter}, кл.${c.cell}` : 'без клетки';
          report += `    ${where} — ${unitText(c.slot)}\n`;
        }
        report += `    Итого: ${unitText(wtTotal)}\n`;
      }
      report += `\n`;
    }
    report += 'Ряды, кусты и часы суммируются раздельно — каждая единица своя.';
    res.json({ report });
```

- [ ] **Step 3: Проверить синтаксис**

Run: `node --check server/server.js`
Expected: нет вывода, код возврата 0.

- [ ] **Step 4: Коммит**

```bash
git add server/server.js
git commit -m "Extend /api/logs and rewrite /api/report for work types and modes

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 8: Клиент — состояние и загрузка списков

**Files:**
- Modify: `public/js/app.js` — `constructor()` и `init()`, новые методы

- [ ] **Step 1: Заменить тело конструктора**

В `public/js/app.js` замени блок:

```js
  constructor() {
    this.me = null;
    this.processing = false; // идёт ли сейчас отправка /api/process
    this.estates = [];
    this.estate = localStorage.getItem('selectedEstate') || '';
    this.quarters = [];
    this.cellsByQuarter = {}; // кэш клеток по (estate|quarter)
    this.init();
  }
```

на:

```js
  constructor() {
    this.me = null;
    this.estates = [];
    this.estate = localStorage.getItem('selectedEstate') || '';
    this.quarters = [];
    this.cellsByQuarter = {}; // кэш клеток по (estate|quarter)
    // Этап 2 — структурированный ввод
    this.employees = [];          // [{id, name}] — полный список бригады
    this.workTypes = [];          // [{id, name}] — общий список видов работ
    this.present = [];            // [{employee_id, name}] — отмеченные сегодня
    this.entries = [];            // записи журнала за выбранную дату
    this.inputDate = this.getTodayDate();
    this.ctxQuarter = '';         // «держащийся» контекст
    this.ctxCell = '';
    this.ctxWorkType = '';
    this.measureMode = 'rows_bushes';
    this.selectedEmployeeId = null;
    this.rosterOpen = false;
    this.adding = false;          // защита от двойного «Добавить»
    this.init();
  }
```

- [ ] **Step 2: Заменить хвост `init()`**

В `init()` замени блок:

```js
    // Вошёл — грузим приложение.
    await this.loadEstates();
    if (this.estate && !this.estates.find(e => e.id === this.estate)) {
      this.estate = '';
      localStorage.removeItem('selectedEstate');
    }
    if (this.estate) {
      await this.loadQuarters();
    }
    this.render();
  }
```

на:

```js
    // Вошёл — грузим приложение.
    await this.loadEstates();
    if (this.estate && !this.estates.find(e => e.id === this.estate)) {
      this.estate = '';
      localStorage.removeItem('selectedEstate');
    }
    if (this.estate) {
      await this.loadQuarters();
    }
    await this.loadEmployees();
    await this.loadWorkTypes();
    await this.loadAttendance(this.inputDate);
    await this.loadTodayEntries(this.inputDate);
    this.render();
  }
```

- [ ] **Step 3: Добавить методы загрузки списков**

В `public/js/app.js` найди метод `loadCells(quarterId)`. **Сразу после его закрывающей `}`** (перед `async onEstateChange()`) вставь:

```js
  async loadEmployees() {
    try {
      const r = await this.apiFetch('/api/employees');
      const data = await r.json();
      this.employees = data.employees || [];
    } catch (e) {
      this.employees = [];
    }
  }

  async loadWorkTypes() {
    try {
      const r = await this.apiFetch('/api/work-types');
      const data = await r.json();
      this.workTypes = data.work_types || [];
    } catch (e) {
      this.workTypes = [];
    }
  }

  async loadAttendance(date) {
    try {
      const r = await this.apiFetch('/api/attendance?date=' + encodeURIComponent(date));
      const data = await r.json();
      this.present = data.present || [];
    } catch (e) {
      this.present = [];
    }
  }

  async loadTodayEntries(date) {
    if (!this.estate) { this.entries = []; return; }
    try {
      const r = await this.apiFetch('/api/logs?date=' + encodeURIComponent(date) +
        '&estate=' + encodeURIComponent(this.estate));
      const data = await r.json();
      this.entries = (r.ok && data.logs) ? data.logs : [];
    } catch (e) {
      this.entries = [];
    }
  }

```

- [ ] **Step 4: Проверить синтаксис**

Run: `node --check public/js/app.js`
Expected: нет вывода, код возврата 0.

- [ ] **Step 5: Коммит**

```bash
git add public/js/app.js
git commit -m "Client: Stage 2 state fields and list loaders

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 9: Клиент — экран структурированного ввода

**Files:**
- Modify: `public/js/app.js` — `render()`, удаление старого ввода, новые методы экрана ввода

- [ ] **Step 1: Заменить блок вкладки «Ввод данных» в `render()`**

В `public/js/app.js` в методе `render()` замени весь блок:

```js
        <div class="tab-content active" id="input-tab">
          <div class="form-group">
            <label>Дата (YYYY-MM-DD):</label>
            <input type="date" id="date" value="${this.getTodayDate()}">
          </div>

          <div class="form-group">
            <label>Квартал и клетка (по умолчанию — для строк без явного указания):</label>
            <div class="row-2cols">
              <select id="quarter-sel" onchange="app.onQuarterChange()">
                <option value="">Квартал...</option>
                ${this.quarters.map(q => `<option value="${q.id}">${q.name}</option>`).join('')}
              </select>
              <select id="cell-sel">
                <option value="">Клетка...</option>
              </select>
            </div>
          </div>

          <div class="form-group">
            <label>Сотрудники (голосом или вручную):</label>
            <textarea id="input" placeholder="Иванов с 1 по 5; Лена 6, 7&#10;Петров с 8 по 10&#10;&#10;Голосом: «иванов с первого по пятый», (пауза) «лена шестой седьмой»"></textarea>
            <div class="voice-row">
              <button type="button" id="voice-btn" onclick="app.toggleVoice()" class="voice-btn">🎤 Голос</button>
              <span id="voice-status"></span>
            </div>
          </div>

          <button id="process-btn" onclick="app.process()">Обработать</button>

          <div id="result" class="result" style="display:none;"></div>
        </div>
```

на:

```js
        <div class="tab-content active" id="input-tab"></div>
```

- [ ] **Step 2: Убрать вызов `initVoiceInput()` из `render()`**

В конце метода `render()` замени строку:

```js
    this.initVoiceInput();
  }
```

на:

```js
    this.renderInput();
  }
```

- [ ] **Step 3: Удалить старый текстовый и голосовой ввод**

В `public/js/app.js` удали целиком следующие методы (они больше не нужны — текстовый и голосовой ввод заменены):
- `process()` — весь метод.
- `initVoiceInput()` — весь метод.
- `toggleVoice()` — весь метод.
- `startRecording()` — весь метод.
- `stopRecording()` — весь метод.
- `setVoiceStatus(text)` — весь метод.
- `updateVoiceUI()` — весь метод.

Метод `showResult(...)` **оставить** — его использует вкладка «Отчёт». Метод `loadLogs()` **оставить**.

- [ ] **Step 4: Добавить методы экрана ввода**

В `public/js/app.js` найди метод `getTodayDate()`. **Сразу после его закрывающей `}`** вставь все методы экрана ввода:

```js
  // Собирает HTML вкладки «Ввод данных» из текущего состояния.
  renderInput() {
    const tab = document.getElementById('input-tab');
    if (!tab) return;
    const modeBtn = (m, label) =>
      `<button class="mode-btn ${this.measureMode === m ? 'active' : ''}" onclick="app.setMeasureMode('${m}')">${label}</button>`;
    const selName = this.selectedName();
    tab.innerHTML = `
      <div class="form-group">
        <label>Дата:</label>
        <input type="date" id="i2-date" value="${this.inputDate}" onchange="app.onInputDateChange()">
      </div>

      <div class="ctx-block">
        <div class="block-label">Контекст</div>
        <div class="row-2cols">
          <select id="i2-quarter" onchange="app.onI2QuarterChange()">
            <option value="">Квартал...</option>
            ${this.quarters.map(q => `<option value="${q.id}" ${q.id === this.ctxQuarter ? 'selected' : ''}>${this.escapeHtml(q.name)}</option>`).join('')}
          </select>
          <select id="i2-cell" onchange="app.onI2CellChange()">
            <option value="">Клетка...</option>
          </select>
        </div>
        <select id="i2-worktype" onchange="app.onI2WorkTypeChange()">
          <option value="">Вид работ...</option>
          ${this.workTypes.map(w => `<option value="${this.escapeHtml(w.name)}" ${w.name === this.ctxWorkType ? 'selected' : ''}>${this.escapeHtml(w.name)}</option>`).join('')}
        </select>
        <div class="add-inline">
          <input type="text" id="i2-new-worktype" placeholder="Новый вид работ" autocomplete="off">
          <button class="mini-btn" onclick="app.addWorkType()">+ вид работ</button>
        </div>
        <div class="block-label">Как считать:</div>
        <div class="mode-row">
          ${modeBtn('rows_bushes', 'Ряды + кусты')}
          ${modeBtn('rows_only', 'Только ряды')}
          ${modeBtn('hours', 'Только часы')}
        </div>
      </div>

      <div class="ctx-block">
        <div class="block-label">Сегодня на работе</div>
        <button class="roster-toggle" onclick="app.toggleRoster()">
          ${this.rosterOpen ? 'Скрыть список бригады ▲' : 'Выбрать рабочих из бригады ▾'}
        </button>
        ${this.rosterOpen ? this.renderRosterHtml() : ''}
        <div class="chips">
          ${this.present.length === 0
            ? '<span class="chips-empty">Пока никто не отмечен</span>'
            : this.present.map(p =>
                `<span class="chip ${p.employee_id === this.selectedEmployeeId ? 'on' : ''}" onclick="app.selectWorker(${p.employee_id})">${this.escapeHtml(p.name)}</span>`
              ).join('')}
        </div>
      </div>

      <div class="ctx-block">
        <div class="block-label">Добавить запись</div>
        <div class="sel-emp">Сотрудник: <b>${selName ? this.escapeHtml(selName) : '— выбери плашку выше'}</b></div>
        ${this.measureMode === 'hours'
          ? '<div class="form-group"><label>Часы:</label><input type="number" id="i2-hours" min="1" inputmode="numeric"></div>'
          : '<div class="form-group"><label>Ряды (например: 1-5, 9, 11):</label><input type="text" id="i2-rows" inputmode="numeric"></div>'}
        <button id="i2-add-btn" onclick="app.addEntry()">Добавить</button>
        <div id="i2-msg" class="auth-msg"></div>
      </div>

      <div class="ctx-block">
        <div class="block-label">Записи за ${this.escapeHtml(this.inputDate)}</div>
        <div id="i2-entries">${this.renderEntriesHtml()}</div>
      </div>
    `;
    this.refreshI2Cells();
  }

  // Имя выбранного сотрудника (по id из this.present).
  selectedName() {
    const p = this.present.find(x => x.employee_id === this.selectedEmployeeId);
    return p ? p.name : '';
  }

  // HTML выпадающего списка всей бригады с отметками явки.
  renderRosterHtml() {
    const presentIds = new Set(this.present.map(p => p.employee_id));
    const rows = this.employees.map(e => `
      <div class="roster-row ${presentIds.has(e.id) ? 'present' : ''}">
        <span class="roster-name" onclick="app.togglePresent(${e.id})">${presentIds.has(e.id) ? '☑️' : '⬜'} ${this.escapeHtml(e.name)}</span>
        <span class="roster-del" onclick="app.deleteEmployee(${e.id})">✕</span>
      </div>
    `).join('');
    return `
      <div class="roster">
        ${rows || '<div class="roster-row">В списке бригады пока никого нет.</div>'}
        <div class="add-inline roster-add">
          <input type="text" id="i2-new-emp" placeholder="Фамилия нового" autocomplete="off">
          <button class="mini-btn" onclick="app.addEmployee()">+ добавить</button>
        </div>
      </div>
    `;
  }

  // HTML карточек записей за выбранную дату.
  renderEntriesHtml() {
    if (!this.entries || this.entries.length === 0) {
      return '<p class="chips-empty">Записей пока нет.</p>';
    }
    return this.entries.map(log => {
      let measure;
      if (log.measure_mode === 'hours') {
        measure = `${log.hours} часов`;
      } else {
        const rowCount = String(log.rows || '').split(',').filter(x => x.trim()).length;
        measure = `ряды ${this.escapeHtml(log.rows)} · ${rowCount} рядов`;
        if (log.measure_mode === 'rows_bushes') measure += ` · ${log.bushes} кустов`;
      }
      const place = log.measure_mode === 'hours' && !log.quarter
        ? '' : ` · Кв.${this.escapeHtml(log.quarter)} кл.${this.escapeHtml(log.cell)}`;
      return `
        <div class="entry-card">
          <div class="log-info">
            <div class="log-employee">${this.escapeHtml(log.employee)}</div>
            <div class="log-meta">${this.escapeHtml(log.work_type || '')}${place}</div>
            <div class="log-meta">${measure}</div>
          </div>
          <button class="delete-btn" onclick="app.deleteEntry(${log.id})">Удалить</button>
        </div>
      `;
    }).join('');
  }

  // Загружает клетки выбранного квартала в селект #i2-cell.
  async refreshI2Cells() {
    const cSel = document.getElementById('i2-cell');
    if (!cSel) return;
    if (!this.ctxQuarter) {
      cSel.innerHTML = '<option value="">Клетка...</option>';
      return;
    }
    const cells = await this.loadCells(this.ctxQuarter);
    cSel.innerHTML = '<option value="">Клетка...</option>' +
      cells.map(c => `<option value="${c}" ${String(c) === String(this.ctxCell) ? 'selected' : ''}>Клетка ${c}</option>`).join('');
  }

  async onInputDateChange() {
    this.inputDate = document.getElementById('i2-date').value || this.getTodayDate();
    await this.loadAttendance(this.inputDate);
    await this.loadTodayEntries(this.inputDate);
    this.renderInput();
  }

  async onI2QuarterChange() {
    this.ctxQuarter = document.getElementById('i2-quarter').value;
    this.ctxCell = '';
    await this.refreshI2Cells();
  }

  onI2CellChange() {
    this.ctxCell = document.getElementById('i2-cell').value;
  }

  onI2WorkTypeChange() {
    this.ctxWorkType = document.getElementById('i2-worktype').value;
  }

  setMeasureMode(mode) {
    this.measureMode = mode;
    this.renderInput();
  }

  toggleRoster() {
    this.rosterOpen = !this.rosterOpen;
    this.renderInput();
  }

  async addWorkType() {
    const input = document.getElementById('i2-new-worktype');
    const name = input ? input.value.trim() : '';
    const msg = document.getElementById('i2-msg');
    if (!name) { if (msg) msg.textContent = '❌ Впиши название вида работ'; return; }
    try {
      const r = await this.apiFetch('/api/work-types', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) { if (msg) msg.textContent = '❌ ' + (data.error || 'Ошибка'); return; }
      await this.loadWorkTypes();
      this.ctxWorkType = data.work_type ? data.work_type.name : name;
      this.renderInput();
    } catch (e) {
      if (msg) msg.textContent = '❌ ' + e.message;
    }
  }

  async addEmployee() {
    const input = document.getElementById('i2-new-emp');
    const name = input ? input.value.trim() : '';
    if (!name) return;
    try {
      const r = await this.apiFetch('/api/employees', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) { alert('Ошибка: ' + (data.error || 'не удалось')); return; }
      await this.loadEmployees();
      // Нового сразу отмечаем присутствующим.
      if (data.employee) {
        await this.markPresent(data.employee.id);
        await this.loadAttendance(this.inputDate);
      }
      this.renderInput();
    } catch (e) {
      alert('Ошибка: ' + e.message);
    }
  }

  async deleteEmployee(id) {
    if (!confirm('Удалить этого сотрудника из списка бригады?')) return;
    try {
      const r = await this.apiFetch('/api/employees/' + id, { method: 'DELETE' });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        alert('Ошибка: ' + (data.error || 'не удалось'));
        return;
      }
      if (this.selectedEmployeeId === id) this.selectedEmployeeId = null;
      await this.loadEmployees();
      await this.loadAttendance(this.inputDate);
      this.renderInput();
    } catch (e) {
      alert('Ошибка: ' + e.message);
    }
  }

  async togglePresent(employeeId) {
    const isPresent = this.present.some(p => p.employee_id === employeeId);
    try {
      if (isPresent) {
        await this.apiFetch('/api/attendance', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ date: this.inputDate, employee_id: employeeId }),
        });
        if (this.selectedEmployeeId === employeeId) this.selectedEmployeeId = null;
      } else {
        await this.markPresent(employeeId);
      }
      await this.loadAttendance(this.inputDate);
      this.renderInput();
    } catch (e) {
      alert('Ошибка: ' + e.message);
    }
  }

  async markPresent(employeeId) {
    await this.apiFetch('/api/attendance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: this.inputDate, employee_id: employeeId }),
    });
  }

  selectWorker(employeeId) {
    this.selectedEmployeeId = employeeId;
    this.renderInput();
  }

  async addEntry() {
    if (this.adding) return;
    const msg = document.getElementById('i2-msg');
    const setMsg = (t) => { if (msg) { msg.className = 'auth-msg'; msg.textContent = t; } };
    if (!this.estate) { setMsg('❌ Сначала выбери хозяйство'); return; }
    const employee = this.selectedName();
    if (!employee) { setMsg('❌ Выбери сотрудника (плашку выше)'); return; }
    if (!this.ctxWorkType) { setMsg('❌ Выбери вид работ'); return; }

    const body = {
      date: this.inputDate,
      estate: this.estate,
      quarter: this.ctxQuarter,
      cell: this.ctxCell,
      work_type: this.ctxWorkType,
      measure_mode: this.measureMode,
      employee: employee,
    };
    if (this.measureMode === 'hours') {
      const hoursEl = document.getElementById('i2-hours');
      body.hours = hoursEl ? hoursEl.value : '';
    } else {
      if (!this.ctxCell) { setMsg('❌ Выбери клетку'); return; }
      const rowsEl = document.getElementById('i2-rows');
      body.rows = rowsEl ? rowsEl.value : '';
    }

    const btn = document.getElementById('i2-add-btn');
    this.adding = true;
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Добавляю...'; }
    try {
      const r = await this.apiFetch('/api/logs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) { setMsg('❌ ' + (data.error || 'Ошибка')); return; }
      await this.loadTodayEntries(this.inputDate);
      this.selectedEmployeeId = null;
      this.renderInput();
    } catch (e) {
      setMsg('❌ ' + e.message);
    } finally {
      this.adding = false;
      const b = document.getElementById('i2-add-btn');
      if (b) { b.disabled = false; b.textContent = 'Добавить'; }
    }
  }

  async deleteEntry(id) {
    if (!confirm('Удалить эту запись? Действие нельзя отменить.')) return;
    try {
      const r = await this.apiFetch('/api/logs/' + id, { method: 'DELETE' });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        alert('Ошибка удаления: ' + (data.error || 'не удалось'));
        return;
      }
      await this.loadTodayEntries(this.inputDate);
      this.renderInput();
    } catch (e) {
      alert('Ошибка: ' + e.message);
    }
  }

```

- [ ] **Step 5: Проверить синтаксис**

Run: `node --check public/js/app.js`
Expected: нет вывода, код возврата 0.

- [ ] **Step 6: Коммит**

```bash
git add public/js/app.js
git commit -m "Client: structured input screen (context, attendance, card entry)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 10: Журнал с видом работ, стили, service worker, проверка

**Files:**
- Modify: `public/js/app.js` — `loadLogs()`
- Modify: `public/styles.css`
- Modify: `public/service-worker.js`

- [ ] **Step 1: Показать вид работ и режим в журнале**

В `public/js/app.js` в методе `loadLogs()` замени блок `list.innerHTML = sorted.map(log => ` ... `).join('');` на:

```js
      list.innerHTML = sorted.map(log => {
        let measure;
        if (log.measure_mode === 'hours') {
          measure = `${log.hours} часов`;
        } else {
          const rowCount = String(log.rows || '').split(',').filter(x => x.trim()).length;
          measure = `ряды [${this.escapeHtml(log.rows)}] · ${rowCount} рядов`;
          if (log.measure_mode === 'rows_bushes') measure += ` · ${log.bushes} кустов`;
        }
        const place = (log.measure_mode === 'hours' && !log.quarter)
          ? '' : `Кв.${this.escapeHtml(log.quarter)}, кл.${this.escapeHtml(log.cell)} · `;
        return `
        <div class="log-entry">
          <div class="log-info">
            <div class="log-employee">${this.escapeHtml(log.employee)}</div>
            <div class="log-meta">${this.escapeHtml(log.work_type || '')}</div>
            <div class="log-meta">${place}${measure}</div>
          </div>
          <button class="delete-btn" onclick="app.deleteLog(${log.id})">Удалить</button>
        </div>
      `;
      }).join('');
```

- [ ] **Step 2: Добавить стили экрана ввода**

В конец `public/styles.css` добавь:

```css
.ctx-block {
    border: 1px solid #e2e2e2;
    border-radius: 10px;
    padding: 12px;
    margin-bottom: 14px;
}

.block-label {
    font-size: 12px;
    text-transform: uppercase;
    color: #999;
    letter-spacing: 0.04em;
    margin: 4px 0 8px;
}

.mode-row {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
}

.mode-btn {
    width: auto;
    margin: 0;
    padding: 7px 10px;
    font-size: 13px;
    background: #fff;
    color: #333;
    border: 1px solid #bbb;
}

.mode-btn.active {
    background: #2e7d32;
    color: #fff;
    border-color: #2e7d32;
}

.add-inline {
    display: flex;
    gap: 6px;
    margin-top: 8px;
}

.add-inline input {
    flex: 1;
    margin: 0;
}

.roster-toggle {
    width: 100%;
    margin: 0 0 8px;
    background: #f7f7f7;
    color: #333;
    border: 1px solid #bbb;
}

.roster {
    border: 1px solid #ddd;
    border-radius: 8px;
    margin-bottom: 8px;
    max-height: 260px;
    overflow-y: auto;
}

.roster-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 2px 10px;
    border-bottom: 1px solid #f0f0f0;
    font-size: 14px;
}

.roster-row.present {
    background: #f1f8f1;
}

.roster-name {
    flex: 1;
    padding: 8px 0;
    cursor: pointer;
}

.roster-del {
    color: #c0392b;
    padding: 8px;
    cursor: pointer;
}

.roster-add {
    padding: 8px;
}

.chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
}

.chip {
    display: inline-block;
    border: 1px solid #bbb;
    border-radius: 14px;
    padding: 6px 12px;
    font-size: 14px;
    background: #fff;
    cursor: pointer;
}

.chip.on {
    background: #2e7d32;
    color: #fff;
    border-color: #2e7d32;
}

.chips-empty {
    color: #888;
    font-size: 13px;
}

.sel-emp {
    font-size: 14px;
    margin-bottom: 8px;
}

.entry-card {
    border: 1px solid #e2e2e2;
    border-left: 4px solid #2e7d32;
    border-radius: 8px;
    padding: 9px 11px;
    margin: 7px 0;
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
}
```

- [ ] **Step 3: Поднять версию кэша service worker**

В `public/service-worker.js`, строка 1, замени `const CACHE_NAME = 'brigade-v16';` на `const CACHE_NAME = 'brigade-v17';`.

- [ ] **Step 4: Проверить синтаксис**

Run: `node --check public/js/app.js && node --check public/service-worker.js`
Expected: нет вывода, код возврата 0.

- [ ] **Step 5: Коммит**

```bash
git add public/js/app.js public/styles.css public/service-worker.js
git commit -m "Client: work type in journal, Stage 2 styles, bump SW to v17

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

- [ ] **Step 6: Запушить и пройти ручную проверку**

```bash
git push
```

Дождись зелёного «Deploy live» на Render, затем проверь на `https://pomoshnik-brigadira.onrender.com` (войдя под бригадиром):

1. **Сотрудники:** на вкладке «Ввод данных» открой «Выбрать рабочих из бригады» → «+ добавить» — заведи 2-3 фамилии. Они появляются в списке. Удали одну через ✕ — она исчезает.
2. **Явка:** отметь сотрудника в списке — он появляется плашкой ниже. Сними отметку — плашка исчезает.
3. **Виды работ:** в «Вид работ» есть основные (Обрезка, Подвязка и т. д.). Добавь свой через «+ вид работ» — он появляется в списке.
4. **Режим «Ряды + кусты»:** выбери квартал, клетку, вид работ, режим «Ряды + кусты»; ткни плашку сотрудника; впиши «1-5, 9»; «Добавить». Карточка появляется внизу с номерами рядов, количеством рядов и кустов.
5. **Режим «Только ряды»:** добавь запись в этом режиме — карточка показывает ряды и количество рядов, без кустов.
6. **Режим «Только часы»:** выбери режим «Только часы» — поле меняется на «Часы»; впиши число; «Добавить». Карточка показывает часы; клетку выбирать не требуется.
7. **Контекст держится:** добавь подряд двух сотрудников под одним кварталом/клеткой/видом — контекст не сбрасывается.
8. **Один сотрудник дважды:** добавь одного сотрудника, потом смени клетку и добавь его же — обе записи на месте.
9. **Журнал:** на вкладке «Журнал» за сегодня записи видны с видом работ и измерением.
10. **Удаление:** удали запись из карточек на вкладке ввода и из журнала — исчезает.
11. **Отчёт:** на вкладке «Отчёт за период» возьми период, включающий сегодня — отчёт сгруппирован по сотруднику и виду работ, часы и ряды не смешаны.
12. **Изоляция:** под другим бригадиром его список сотрудников и записи пусты; виды работ — общие, видны обоим.

---

## Заметки для инженера

- Русские строки и эмодзи в UI — намеренно, повторяют существующий стиль `app.js`.
- Режим подсчёта (`measure_mode`) хранится в каждой записи: `rows_bushes` / `rows_only` / `hours`.
- Квартал/клетка для режима `hours` пишутся пустой строкой — колонки `work_logs.quarter/cell` остаются `NOT NULL`.
- Старый `POST /api/process` и текстовый разбор в `parser.js` остаются в коде, но клиентом больше не вызываются — трогать их не нужно.
- Коммиты заканчиваются трейлером `Co-Authored-By`, как в недавнем `git log`.
- Репозиторий **публичный** — не коммить пароли, логины, секреты, фамилии, названия Excel-файлов.
- Задачи 1-3 уточнены после code-review: `employees` получил `UNIQUE (brigadier_id, name)`, `POST /api/employees` отклоняет дубль фамилии, `parseRowList` отклоняет номер ряда меньше 1. Код блоков выше уже учитывает эти правки.
- В `POST /api/logs` встроена защита от непреднамеренного повтора: запись с теми же ключевыми полями, созданная в последние 10 секунд, отклоняется (HTTP 409 «Такая же запись только что добавлена»). Намеренный одинаковый ввод позже окна — проходит. Хард-удаление в `DELETE /api/logs/:id` снимает блокировку, если пользователь удалил предыдущую и тут же ввёл заново.
