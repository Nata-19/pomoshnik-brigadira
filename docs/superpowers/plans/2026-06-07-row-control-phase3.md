# Контроль рядов Фаза 3 «Сверка» — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Добавить вкладку «Сверка» — просмотр по клетке: сделано/осталось (рядов и кустов, с учётом долей) и список несделанных рядов (пропущенные без пометки, спорные с пометкой).

**Architecture:** Чистая функция `computeCellReconciliation` в `server/rowControl.js` (под юнит-тесты), новый GET-эндпоинт `/api/rows-status` (demo-aware, считает из инвентаря + `work_logs.row_weights` + `disputed_rows`), новая вкладка «Сверка» в клиенте — только просмотр. Модель данных не меняем.

**Tech Stack:** Node.js + Express, PostgreSQL (`pg`), ванильный JS-клиент (`public/js/app.js`), тесты `node:test`. Демо использует тот же общий код контроля рядов.

**Контекст спеки:** `docs/superpowers/specs/2026-06-07-row-control-phase3-design.md`. Реализация в worktree `row-control-phase3` (от `origin/main`). Выкат: **сначала демо → проверка Натали → потом боевой**.

---

## File Structure

- `server/rowControl.js` — **добавить** чистую функцию `computeCellReconciliation(inventoryRows, weightByRow, disputedSet)` и экспорт. Никакой БД/HTTP.
- `test/rowControl.test.js` — **добавить** юнит-тесты на `computeCellReconciliation` (импорт расширить).
- `server/parser.js` — **добавить** метод `getCellRows(estate, quarter, cell)` → `[{row, bushes}]` (ряды клетки из инвентаря, та же валидация, что в `getBushesCount`).
- `server/server.js` — **добавить** маршрут `GET /api/rows-status` (рядом с `/api/disputed`, ~стр. 1464). Использует `rowOwner`, `parser`/demo-парсер, `rowControl`.
- `public/js/app.js` — **добавить** кнопку вкладки + блок `reconcile-tab` (рядом со «Спорные», ~стр. 414/450) и методы `onReconcileQuarterChange`, `loadRowsStatus`, `renderRowsStatus`.
- `public/service-worker.js` — **изменить** `CACHE_NAME` `brigade-v20` → `brigade-v21` (правки клиента).

Разрез везде один: **estate + quarter + cell + work_type**, накопительно (дата не фильтруется).

---

## Task 1: Чистое ядро `computeCellReconciliation` (TDD)

**Files:**
- Modify: `server/rowControl.js` (добавить функцию + в `module.exports`)
- Test: `test/rowControl.test.js`

- [ ] **Step 1: Расширить импорт в тесте**

В начале `test/rowControl.test.js` заменить строку импорта:

```js
const { splitBushes, classifyRows, removeRowFromRecord, distributeBushes, computeCellReconciliation } = require('../server/rowControl');
```

- [ ] **Step 2: Написать падающие тесты**

Добавить в конец `test/rowControl.test.js`:

```js
// --- computeCellReconciliation (Фаза 3 «Сверка») ---
const inv3 = [{ row: 1, bushes: 100 }, { row: 2, bushes: 100 }, { row: 3, bushes: 100 }];

test('reconcile: клетка сделана полностью', () => {
  const r = computeCellReconciliation(inv3, { 1: 1, 2: 1, 3: 1 }, new Set());
  assert.strictEqual(r.fullyDone, true);
  assert.deepStrictEqual(r.missedRows, []);
  assert.strictEqual(r.doneRows, 3);
  assert.strictEqual(r.remainingRows, 0);
  assert.strictEqual(r.totalBushes, 300);
  assert.strictEqual(r.doneBushes, 300);
  assert.strictEqual(r.remainingBushes, 0);
});

test('reconcile: частично — забытые ряды попадают в missed', () => {
  const r = computeCellReconciliation(inv3, { 1: 1 }, new Set());
  assert.strictEqual(r.fullyDone, false);
  assert.deepStrictEqual(r.missedRows, [2, 3]);
  assert.strictEqual(r.doneRows, 1);
  assert.strictEqual(r.remainingRows, 2);
  assert.strictEqual(r.doneBushes, 100);
  assert.strictEqual(r.remainingBushes, 200);
});

test('reconcile: спорные не в missed, но в disputedRows и в остатке', () => {
  const r = computeCellReconciliation(inv3, { 1: 1 }, new Set([2]));
  assert.deepStrictEqual(r.missedRows, [3]);        // 2 спорный → не в missed
  assert.deepStrictEqual(r.disputedRows, [2]);
  assert.strictEqual(r.disputedCount, 1);
  assert.strictEqual(r.remainingRows, 2);           // 2 и 3 не сделаны
  assert.strictEqual(r.doneRows + r.remainingRows, r.totalRows); // сходимость
  assert.strictEqual(r.doneBushes + r.remainingBushes, r.totalBushes);
  assert.strictEqual(r.fullyDone, false);
});

test('reconcile: дробный ряд (вес 0.5) — не в missed, остаток учитывает половину', () => {
  const r = computeCellReconciliation(inv3, { 1: 1, 2: 0.5 }, new Set());
  assert.strictEqual(r.doneRows, 1.5);
  assert.deepStrictEqual(r.missedRows, [3]);        // 2 записан частично → не забыт
  assert.strictEqual(r.doneBushes, 150);            // 100 + 50
  assert.strictEqual(r.remainingBushes, 150);
  assert.strictEqual(r.remainingRows, 1.5);
});

test('reconcile: пустой инвентарь рядов — безопасно', () => {
  const r = computeCellReconciliation([], {}, new Set());
  assert.strictEqual(r.totalRows, 0);
  assert.strictEqual(r.totalBushes, 0);
  assert.deepStrictEqual(r.missedRows, []);
  assert.deepStrictEqual(r.disputedRows, []);
  assert.strictEqual(r.fullyDone, true);
});

test('reconcile: weightByRow как Map тоже работает', () => {
  const r = computeCellReconciliation(inv3, new Map([[1, 1], [2, 1], [3, 1]]), new Set());
  assert.strictEqual(r.fullyDone, true);
});
```

- [ ] **Step 3: Запустить тесты — убедиться, что падают**

Run: `npm test`
Expected: FAIL — `computeCellReconciliation is not a function` (или `undefined`).

- [ ] **Step 4: Реализовать функцию**

Добавить в `server/rowControl.js` перед `module.exports`:

```js
// Сверка по клетке (Фаза 3). Считает по инвентарю с учётом долей.
// inventoryRows: [{row:Number, bushes:Number}] — ряды клетки из инвентаря.
// weightByRow: Map<Number,Number> | {row: weightSum} — суммарный вес ряда из журнала
//   (целый ряд = 1, поделённый = доля, ряд без записи отсутствует/0).
// disputedSet: Set<Number> — номера спорных рядов клетки (в этом разрезе).
// Возвращает сводку + списки несделанных. «сделано + осталось = всего».
function computeCellReconciliation(inventoryRows, weightByRow, disputedSet) {
  const rows = Array.isArray(inventoryRows) ? inventoryRows : [];
  const disputed = disputedSet instanceof Set ? disputedSet : new Set(disputedSet || []);
  const weightOf = (row) => {
    const w = (weightByRow instanceof Map) ? weightByRow.get(row)
      : (weightByRow ? weightByRow[row] : undefined);
    return (typeof w === 'number' && isFinite(w)) ? w : 0;
  };

  let totalRows = 0, totalBushes = 0, doneRows = 0, doneBushesRaw = 0;
  const missedRows = [];
  const disputedRows = [];
  for (const item of rows) {
    const row = Number(item.row);
    const bushes = Number(item.bushes) || 0;
    totalRows += 1;
    totalBushes += bushes;
    const w = weightOf(row);
    doneRows += w;
    doneBushesRaw += w * bushes;
    if (disputed.has(row)) disputedRows.push(row);
    if (w === 0 && !disputed.has(row)) missedRows.push(row);
  }

  const doneBushes = Math.round(doneBushesRaw);
  const remainingRows = Math.max(totalRows - doneRows, 0);
  const remainingBushes = Math.max(totalBushes - doneBushes, 0);
  missedRows.sort((a, b) => a - b);
  disputedRows.sort((a, b) => a - b);
  const fullyDone = Math.round(remainingRows * 100) / 100 === 0
    && missedRows.length === 0 && disputedRows.length === 0;

  return {
    totalRows, totalBushes, doneRows, doneBushes,
    remainingRows, remainingBushes,
    missedRows, disputedRows, disputedCount: disputedRows.length, fullyDone,
  };
}
```

В `module.exports` добавить `computeCellReconciliation` в список:

```js
module.exports = {
  splitBushes, classifyRows, removeRowFromRecord, distributeBushes,
  parseRowWeights, serializeRowWeights, weightOfRecord,
  weightsFromBushes, fillWeights, formatRows,
  computeCellReconciliation,
};
```

- [ ] **Step 5: Запустить тесты — убедиться, что проходят**

Run: `npm test`
Expected: PASS — все тесты, включая новые `reconcile: ...`.

- [ ] **Step 6: Commit**

```bash
git add server/rowControl.js test/rowControl.test.js
git commit -m "feat(rows): чистое ядро сверки по клетке computeCellReconciliation + тесты"
```

---

## Task 2: Хелпер инвентаря `getCellRows` в парсере

**Files:**
- Modify: `server/parser.js` (добавить метод рядом с `getBushesCount`, ~стр. 315)

- [ ] **Step 1: Добавить метод**

В классе `DataParser`, сразу после метода `getBushesCount` (после строки `return totalBushes;` и её `}`), добавить:

```js
  // Ряды клетки из инвентаризации: [{row, bushes}]. Та же валидация, что getBushesCount.
  getCellRows(estate, quarter, cell) {
    const edata = this.inventory.estates[estate];
    if (!edata) {
      throw new Error(`Хозяйство "${estate}" не найдено в инвентаризации`);
    }
    const qdata = edata.quarters[quarter];
    if (!qdata) {
      throw new Error(`Ряды отсутствуют в инвентаризации для квартала ${quarter}`);
    }
    const cellData = qdata.cells[cell];
    if (!cellData) {
      throw new Error(`Клетка ${cell} не найдена в квартале ${quarter}`);
    }
    return cellData.map((item) => ({ row: item.row, bushes: item.bushes }));
  }
```

- [ ] **Step 2: Проверить, что ничего не сломалось**

Run: `npm test`
Expected: PASS (метод новый, существующие тесты не затронуты; синтаксис файла корректен).

- [ ] **Step 3: Commit**

```bash
git add server/parser.js
git commit -m "feat(rows): DataParser.getCellRows — ряды клетки из инвентаря"
```

---

## Task 3: Эндпоинт `GET /api/rows-status`

**Files:**
- Modify: `server/server.js` (добавить маршрут после `/api/disputed`, после стр. 1464)

Примечание: HTTP-тестов в репозитории нет — корректность расчёта закрыта юнит-тестами ядра (Task 1), эндпоинт проверяем вручную (Task 5) и живой проверкой Натали. `rowControl`, `parser`, `DataParser`, `demo`, `DEMO_MODE`, `rowOwner` уже доступны в `server.js`.

Известное ограничение (по §5/§7 спеки, отдельный гард НЕ делаем): если выбрать не-рядовой вид работ (почасовой и т.п.), журнал по нему рядов не содержит → выборка пустая → всё покажется «осталось». Экран рассчитан на рядовые виды; это не ошибка расчёта.

- [ ] **Step 1: Добавить маршрут**

Вставить после закрывающей `});` маршрута `app.get('/api/disputed', ...)` (стр. 1464):

```js
// Сверка по клетке (Фаза 3): сделано/осталось + список несделанных рядов.
// Только просмотр. Разрез: estate+quarter+cell+work_type, накопительно.
app.get('/api/rows-status', authOrDemo, async (req, res) => {
  try {
    const { estate, quarter, cell } = req.query;
    // work_type в work_logs/disputed_rows хранится обрезанным (.trim()) — сравниваем так же.
    const work_type = String(req.query.work_type || '').trim();
    if (!estate || quarter == null || quarter === '' || cell == null || cell === '' || !work_type) {
      return res.status(400).json({ error: 'Укажи хозяйство, квартал, клетку и вид работ' });
    }

    let parserToUse;
    if (DEMO_MODE) parserToUse = new DataParser(await demo.getDemoInventory(pool, req.demo_session_id));
    else parserToUse = parser;

    let inventoryRows;
    try {
      inventoryRows = parserToUse.getCellRows(estate, String(quarter), String(cell));
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
    if (!inventoryRows || inventoryRows.length === 0) {
      return res.status(400).json({ error: 'Нет данных по клетке' });
    }

    const owner = rowOwner(req);

    // Журнал в разрезе: только рядовые режимы, непустые ряды.
    const logs = await pool.query(
      `SELECT rows, row_weights FROM work_logs
       WHERE estate_id = $1 AND quarter = $2 AND cell = $3 AND work_type = $4
         AND measure_mode IN ('rows_bushes','rows_only')
         AND rows IS NOT NULL AND rows <> '' AND ${owner.col} = $5`,
      [estate, String(quarter), String(cell), work_type, owner.val]
    );
    const weightByRow = {};
    for (const r of logs.rows) {
      const nums = String(r.rows || '').split(',').map((s) => parseInt(s, 10)).filter(Number.isInteger);
      const w = rowControl.parseRowWeights(r.row_weights);
      for (const n of nums) {
        const wv = (typeof w[n] === 'number' && isFinite(w[n])) ? w[n] : 1;
        weightByRow[n] = (weightByRow[n] || 0) + wv;
      }
    }

    // Спорные ряды того же разреза.
    const disp = await pool.query(
      `SELECT row_num FROM disputed_rows
       WHERE estate_id = $1 AND quarter = $2 AND cell = $3 AND work_type = $4 AND ${owner.col} = $5`,
      [estate, String(quarter), String(cell), work_type, owner.val]
    );
    const disputedSet = new Set(disp.rows.map((d) => Number(d.row_num)));

    const result = rowControl.computeCellReconciliation(inventoryRows, weightByRow, disputedSet);
    res.json(result);
  } catch (error) {
    console.error('Rows status error:', error);
    res.status(500).json({ error: error.message });
  }
});
```

- [ ] **Step 2: Проверить запуск сервера**

Run: `node -e "require('./server/server.js')"` — затем `Ctrl+C` (или проверить, что процесс стартует без синтаксических ошибок). Если требуется БД/окружение для полного старта — достаточно убедиться, что нет `SyntaxError` при загрузке модуля.
Expected: модуль грузится без `SyntaxError`.

- [ ] **Step 3: Commit**

```bash
git add server/server.js
git commit -m "feat(rows): GET /api/rows-status — сверка по клетке (demo-aware)"
```

---

## Task 4: Клиентская вкладка «Сверка»

**Files:**
- Modify: `public/js/app.js` (кнопка вкладки ~стр. 414; блок вкладки ~стр. 450; методы рядом с `loadDisputed` ~стр. 1255)

- [ ] **Step 1: Добавить кнопку вкладки**

В `public/js/app.js`, в блоке `<div class="tabs">` (стр. 410–416), после кнопки «Спорные» (стр. 414) добавить:

```js
          <button class="tab-button" onclick="app.switchTab(event, 'reconcile'); app.onReconcileTabOpen()">Сверка</button>
```

- [ ] **Step 2: Добавить блок вкладки**

После блока `<div class="tab-content" id="disputed-tab"> ... </div>` (стр. 447–450) добавить:

```js
        <div class="tab-content" id="reconcile-tab">
          <div class="ctx-block">
            <div class="block-label">Сверка по клетке</div>
            <div class="chips-row">
              <select id="rc-quarter" class="chip-select" onchange="app.onReconcileQuarterChange()">
                <option value="">Квартал...</option>
              </select>
              <select id="rc-cell" class="chip-select">
                <option value="">Клетка...</option>
              </select>
              <select id="rc-worktype" class="chip-select">
                <option value="">Вид работ...</option>
              </select>
            </div>
            <button onclick="app.loadRowsStatus()">Показать</button>
          </div>
          <div id="reconcile-result" class="result" style="display:none;"></div>
        </div>
```

> **Важно:** опции кварталов и видов работ НЕ запекаем в шаблон. Контейнер вкладок строится один раз в `render()`, а `onEstateChange` перерисовывает только `#input-tab` — поэтому запечённые опции устарели бы после смены хозяйства. Заполняем их динамически в `onReconcileTabOpen()` (Step 3) при каждом открытии вкладки, читая актуальные `this.quarters`/`this.workTypes`.

- [ ] **Step 3: Добавить методы вкладки**

В классе приложения, рядом с `loadDisputed` (после `renderDisputed`, ~стр. 1293), добавить:

```js
  // Вкладка «Сверка» открыта: (пере)заполнить селекторы актуальными кварталами и
  // видами работ. Делаем при каждом открытии, т.к. контейнер вкладок строится один
  // раз, а хозяйство могло смениться. Сохранённое значение восстанавливаем, если ещё валидно.
  onReconcileTabOpen() {
    const qSel = document.getElementById('rc-quarter');
    const wSel = document.getElementById('rc-worktype');
    const res = document.getElementById('reconcile-result');
    if (qSel) {
      const prev = qSel.value;
      qSel.innerHTML = '<option value="">Квартал...</option>' +
        this.quarters.map(q => `<option value="${q.id}">${this.escapeHtml(q.name)}</option>`).join('');
      if (prev && this.quarters.some(q => String(q.id) === prev)) qSel.value = prev;
    }
    if (wSel) {
      const prev = wSel.value;
      wSel.innerHTML = '<option value="">Вид работ...</option>' +
        this.workTypes.map(w => `<option value="${this.escapeHtml(w.name)}">${this.escapeHtml(w.name)}</option>`).join('');
      if (prev && this.workTypes.some(w => w.name === prev)) wSel.value = prev;
    }
    if (res && !this.estate) {
      res.style.display = 'block';
      res.innerHTML = '<p style="color:#888;padding:10px;">Сначала выбери хозяйство</p>';
    }
  }

  // Смена квартала — подгрузить клетки.
  async onReconcileQuarterChange() {
    const qSel = document.getElementById('rc-quarter');
    const cSel = document.getElementById('rc-cell');
    if (!qSel || !cSel) return;
    cSel.innerHTML = '<option value="">Клетка...</option>';
    if (!qSel.value) return;
    const cells = await this.loadCells(qSel.value);
    cSel.innerHTML = '<option value="">Клетка...</option>' +
      cells.map(c => `<option value="${this.escapeHtml(c)}">${this.escapeHtml(c)}</option>`).join('');
  }

  // Запросить сверку по выбранному разрезу.
  async loadRowsStatus() {
    const res = document.getElementById('reconcile-result');
    if (!res) return;
    res.style.display = 'block';
    if (!this.estate) {
      res.innerHTML = '<p style="color:#888;padding:10px;">Сначала выбери хозяйство</p>';
      return;
    }
    const quarter = (document.getElementById('rc-quarter') || {}).value || '';
    const cell = (document.getElementById('rc-cell') || {}).value || '';
    const workType = (document.getElementById('rc-worktype') || {}).value || '';
    if (!quarter || !cell || !workType) {
      res.innerHTML = '<p style="color:#888;padding:10px;">Выбери квартал, клетку и вид работ</p>';
      return;
    }
    try {
      const url = '/api/rows-status?estate=' + encodeURIComponent(this.estate) +
        '&quarter=' + encodeURIComponent(quarter) +
        '&cell=' + encodeURIComponent(cell) +
        '&work_type=' + encodeURIComponent(workType);
      const r = await this.apiFetch(url);
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        res.innerHTML = `<p style="color:#c00;padding:10px;">${this.escapeHtml(data.error || 'Ошибка')}</p>`;
        return;
      }
      this.renderRowsStatus(data);
    } catch (e) {
      res.innerHTML = `<p style="color:#c00;padding:10px;">${this.escapeHtml(e.message)}</p>`;
    }
  }

  // Рендер сверки: сводка + единый список несделанных (спорные с пометкой).
  renderRowsStatus(data) {
    const res = document.getElementById('reconcile-result');
    if (!res) return;
    const dispNote = data.disputedCount > 0
      ? ` <span style="color:#c60;">· в т.ч. ${data.disputedCount} спорных — см. вкладку Спорные</span>`
      : '';
    let summary;
    if (data.fullyDone) {
      summary = `<div><b>Клетка сделана полностью:</b> ${this.fmtRows(data.totalRows)} рядов, ${data.totalBushes} кустов.</div>`;
    } else {
      summary = `<div><b>Сделано:</b> ${this.fmtRows(data.doneRows)} рядов, ${data.doneBushes} кустов`
        + ` · <b>Осталось:</b> ${this.fmtRows(data.remainingRows)} рядов, ${data.remainingBushes} кустов${dispNote}</div>`;
    }

    const disputedSet = new Set((data.disputedRows || []).map(Number));
    const undone = [
      ...(data.missedRows || []).map((n) => ({ row: Number(n), disputed: false })),
      ...(data.disputedRows || []).map((n) => ({ row: Number(n), disputed: true })),
    ].sort((a, b) => a.row - b.row);

    let listHtml;
    if (undone.length === 0) {
      listHtml = '<div style="color:#888;padding:6px 0;">Несделанных рядов нет.</div>';
    } else {
      listHtml = '<div style="margin-top:8px;"><b>Не сделаны:</b> '
        + undone.map((u) => u.disputed
          ? `${u.row} <span style="color:#c60;" title="спорный">⚠️</span>`
          : `${u.row}`).join(', ')
        + '</div>';
    }

    res.innerHTML = summary + listHtml;
  }
```

- [ ] **Step 4: Проверить синтаксис клиента**

Run: `node --check public/js/app.js`
Expected: без ошибок (тихий выход, код 0).

- [ ] **Step 5: Commit**

```bash
git add public/js/app.js
git commit -m "feat(rows): клиентская вкладка «Сверка» — просмотр сделано/осталось + несделанные"
```

---

## Task 5: Бамп кеша PWA + ручная проверка

**Files:**
- Modify: `public/service-worker.js:1`

- [ ] **Step 1: Поднять версию кеша**

В `public/service-worker.js` заменить:

```js
const CACHE_NAME = 'brigade-v20';
```

на:

```js
const CACHE_NAME = 'brigade-v21';
```

- [ ] **Step 2: Прогнать весь тест-набор**

Run: `npm test`
Expected: PASS — все тесты зелёные.

- [ ] **Step 3: Ручная проверка**

Основная живая проверка — **на демо тобой/Натали** (локальный запуск боевого требует Postgres + `inventory.json`; на демо БД и данные уже есть). Открыть вкладку «Сверка»:
- Выбрать квартал + клетку + вид работ → «Показать».
- Полностью сделанная клетка → «Клетка сделана полностью: N рядов, M кустов».
- Частично сделанная → «Сделано … · Осталось …», список несделанных; забытые без пометки, спорные с ⚠️ и припиской про вкладку Спорные.
- Записать пропущенный ряд на «Вводе» → вернуться в «Сверку», «Показать» → ряд исчез из списка, сводка обновилась.
- Сменить хозяйство → открыть «Сверку» → в списке кварталов уже кварталы нового хозяйства (проверка фикса устаревших селекторов).
- Сходимость: «сделано + осталось = всего» по рядам и кустам.

Зафиксировать результат проверки (что именно проверено и что сошлось).

- [ ] **Step 4: Commit**

```bash
git add public/service-worker.js
git commit -m "chore(pwa): bump CACHE_NAME brigade-v20 → v21 (вкладка Сверка)"
```

---

## Развёртывание (после реализации)

1. **Демо первым:** портировать общий код контроля рядов на ветку `demo-five-modes` (worktree демо-репо), поднять `CACHE_NAME` и там, push в приватный SourceCraft, деплой на VPS (`git pull` + `pm2 restart`).
2. **Проверка Натали** на демо (живой PWA).
3. После «ок» — **боевой:** PR в `origin/main` (Render автодеплой). В публичный боевой НЕ коммитим бизнес-данные/секреты (`.gitignore` уже покрывает `inventory.json`, `parse_config.json`, `*.xlsx`, `.env`).

---

## Self-Review (сверка плана со спекой)

- **§2 Что показываем** — сводка (полностью / сделано·осталось / пометка спорных) и единый список несделанных: Task 4 (`renderRowsStatus`). ✓
- **§3 Правила расчёта** (всего/вес ряда/сделано/осталось/missed/disputed/fullyDone, доли, старые записи без весов = 1) — Task 1 (`computeCellReconciliation`) + сбор `weightByRow` в Task 3. ✓
- **§4 Архитектура** — чистое ядро (Task 1), сервер demo-aware + `authOrDemo` + инвентарь через парсер + `disputed_rows` (Task 3), клиент-вкладка (Task 4). Сигнатура ядра и поля результата совпадают со спекой. ✓
- **§5 Крайние случаи** — клетка без рядов → 400 «Нет данных по клетке» (Task 3); частичный ряд не в missed, доля в остатке (тест в Task 1); ряд журнала вне инвентаря игнорируется (ядро считает только по `inventoryRows`); не-рядовые режимы отсечены `measure_mode IN ('rows_bushes','rows_only')` (Task 3); «пересчёт уникальных» — не делаем. ✓
- **§6 Тестирование** — юнит-тесты ядра (Task 1, все пять сценариев + Map), ручная проверка (Task 5). ✓
- **§7 YAGNI** — экран только просмотр; список только несделанных; разбора спорных тут нет; модель данных не меняем. ✓
- **§8 Развёртывание** — демо→Натали→боевой, бамп кеша (Task 5), безопасность публичного репо. ✓
