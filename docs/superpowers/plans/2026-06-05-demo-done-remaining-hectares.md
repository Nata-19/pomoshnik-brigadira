# Демо-отчёт «Выполнение» (сделано/осталось в гектарах) — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Добавить в демо вкладку «Выполнение» — отчёт по виду работ × квартал, переводящий записанные ряды в гектары (сделано/осталось), накопительно.

**Architecture:** Чистый агрегатор (`server/hectaresReport.js`, юнит-тесты без БД) → серверный endpoint `GET /api/report/hectares` (demo-aware, читает `work_logs` + инвентарь, зовёт агрегатор) → клиентская вкладка (отрисовка + фильтры-чипы). Расчёт только на сервере; клиент рисует и фильтрует.

**Tech Stack:** Node.js/Express, `pg`, ванильный JS PWA. Тесты — встроенный `node --test`. Перевод рядов в га — существующий `parser.getHectaresForRows` (parser.js:331).

**Спека:** `docs/superpowers/specs/2026-06-05-demo-done-remaining-hectares-design.md`.

**Реализуем ПОСЛЕ Фазы 3 контроля рядов.** Метод — Subagent-Driven в git worktree от `demo-five-modes`.

**Обновление 2026-06-07 — план сверен с текущим кодом `demo-five-modes` @ `e17760b`** (после дробного учёта и Фазы 3 «Сверка»). Освежены якоря/пути/имена (см. ниже). Техбаза подтверждена: `getDemoInventory` (demo.js:234) отдаёт клетку объектом `{ hectares, rows }`, `getHectaresForRows` (parser.js:331) читает `cellData.hectares` — перевод рядов→га работает. Алгоритм «уникальные ряды» из спеки СОХРАНЁН (не переходим на дробные веса): для делённого ряда веса покрывают его целиком, поэтому «уникальные ряды» дают тот же результат, что фракционная «Сверка» (полностью покрытый ряд = 1, спорный = не сделан). Расхождение возможно только при редком ручном частичном вводе (<1 на ряд) — несущественно для демо.

---

## ⚠️ ИТОГОВЫЙ КОД v2 (2026-06-07) — ПЕРЕКРЫВАЕТ блоки ниже, где расходится

Решения Натали: (А) все культуры **с группировкой по культуре-заголовку**; механизированные (`measure_mode='hectares'`) — **отдельной плашкой** (`kind='mech'`, «сделано» = сумма колонки `hectares`), ручные ряды — своей (`kind='manual'`). `hours`/`kilometers` не входят. Поля строки: `{ estate, work_type, quarter, kind, done_ha, total_ha, remaining_ha }`. Тесты Task 1 Step 1 уже под это (12 шт). **Используй код ИЗ ЭТОГО раздела** (ниже по тексту блоки могут быть частично старыми).

### `server/hectaresReport.js` (целиком)

```js
'use strict';

function parseRowsCsv(s) {
  return String(s || '').split(',').map(x => x.trim()).filter(Boolean);
}
const round2 = (n) => Math.round(n * 100) / 100;

// Тип записи: механизированная (прямой ввод га) или ручная (ряды).
function kindOf(measure_mode) {
  return measure_mode === 'hectares' ? 'mech' : 'manual';
}

// logRows: [{ estate_id, work_type, quarter, cell, rows, measure_mode, hectares }] — площадные записи.
// cellHa(estate, quarter, cell, uniqueRowsArr) -> га (может бросить -> клетку пропускаем).
// quarterTotalHa(estate, quarter) -> вся площадь квартала, га.
// Группировка по (тип, культура, вид, квартал). manual и mech одной пары — разные строки.
function buildHectaresReport(logRows, cellHa, quarterTotalHa) {
  const groups = new Map();
  for (const r of logRows) {
    const estate = r.estate_id;
    const wt = (r.work_type && String(r.work_type).trim()) ? r.work_type : '(без вида работ)';
    const quarter = String(r.quarter);
    const kind = kindOf(r.measure_mode);
    const key = `${kind} ${estate} ${wt} ${quarter}`;
    let g = groups.get(key);
    if (!g) { g = { kind, estate, work_type: wt, quarter, cells: new Map(), doneHa: 0 }; groups.set(key, g); }
    if (kind === 'mech') {
      const ha = Number(r.hectares);
      if (isFinite(ha)) g.doneHa += ha;
    } else {
      const cell = String(r.cell);
      let set = g.cells.get(cell);
      if (!set) { set = new Set(); g.cells.set(cell, set); }
      for (const num of parseRowsCsv(r.rows)) set.add(num);
    }
  }

  const result = [];
  for (const g of groups.values()) {
    let done = 0;
    if (g.kind === 'mech') {
      done = g.doneHa;
    } else {
      for (const [cell, set] of g.cells) {
        let ha;
        try { ha = cellHa(g.estate, g.quarter, cell, Array.from(set)); }
        catch { continue; }
        if (isFinite(ha)) done += ha;
      }
    }
    done = round2(done);
    const total = round2(Number(quarterTotalHa(g.estate, g.quarter)) || 0);
    const remaining = round2(Math.max(0, total - done));
    result.push({ estate: g.estate, work_type: g.work_type, quarter: g.quarter,
      kind: g.kind, done_ha: done, total_ha: total, remaining_ha: remaining });
  }

  const qnum = (q) => { const n = parseInt(q, 10); return Number.isNaN(n) ? Infinity : n; };
  result.sort((a, b) =>
    a.estate.localeCompare(b.estate, 'ru') ||
    qnum(a.quarter) - qnum(b.quarter) ||
    a.quarter.localeCompare(b.quarter, 'ru') ||
    a.work_type.localeCompare(b.work_type, 'ru') ||
    a.kind.localeCompare(b.kind));
  return result;
}

module.exports = { buildHectaresReport, parseRowsCsv, kindOf };
```

### Endpoint `GET /api/report/hectares` — SQL выборки (вместо старой в Task 2)

Запрос тянет ОБА типа площадных записей (ручные ряды + механизированные гектары):

```js
    // demo-ветка:
    result = await pool.query(
      `SELECT estate_id, quarter, cell, work_type, rows, measure_mode, hectares
       FROM work_logs
       WHERE demo_session_id = $1
         AND ( (measure_mode IN ('rows_bushes','rows_only') AND rows IS NOT NULL AND rows <> '')
            OR (measure_mode = 'hectares' AND hectares IS NOT NULL) )`,
      [req.demo_session_id]
    );
```

(в не-demo ветке — то же, но `WHERE brigadier_id = $1 AND (...)`). `cellHa`/`quarterTotalHa` и вызов `buildHectaresReport(result.rows, cellHa, quarterTotalHa)` — без изменений.

### Клиент `renderPerformance()` — группировка по культуре + метка типа (вместо плоского списка в Task 3 Step 4)

```js
  renderPerformance() {
    const filters = document.getElementById('perf-filters');
    const list = document.getElementById('perf-list');
    if (!filters || !list) return;
    if (!this.perfRows || this.perfRows.length === 0) {
      filters.innerHTML = '';
      list.innerHTML = '<p style="color:#888;padding:10px;">Пока ничего не записано — заполни журнал, и тут появятся гектары.</p>';
      return;
    }
    const allQ = [...new Set(this.perfRows.map(x => String(x.quarter)))]
      .sort((a, b) => (parseInt(a, 10) || 0) - (parseInt(b, 10) || 0));
    const allWt = [...new Set(this.perfRows.map(x => x.work_type))].sort((a, b) => a.localeCompare(b, 'ru'));
    const chip = (kind, val, on) =>
      `<button class="filter-chip ${on ? 'active' : ''}" onclick="app.togglePerfFilter('${kind}', '${this.escapeAttr(val)}')">${this.escapeHtml(val)}</button>`;
    filters.innerHTML =
      `<div class="perf-filter-row"><span class="filter-label">Виды работ:</span>` +
      allWt.map(wt => chip('wt', wt, this.perfWorkTypes.has(wt))).join('') + `</div>` +
      `<div class="perf-filter-row"><span class="filter-label">Кварталы:</span>` +
      allQ.map(q => chip('q', q, this.perfQuarters.has(q))).join('') + `</div>`;

    const shown = this.perfRows.filter(x =>
      this.perfWorkTypes.has(x.work_type) && this.perfQuarters.has(String(x.quarter)));
    if (shown.length === 0) {
      list.innerHTML = '<p style="color:#888;padding:10px;">Ничего не выбрано в фильтрах.</p>';
      return;
    }
    // Группировка по культуре (estate) с заголовком; порядок строк уже отсортирован сервером.
    const byEstate = new Map();
    for (const x of shown) {
      if (!byEstate.has(x.estate)) byEstate.set(x.estate, []);
      byEstate.get(x.estate).push(x);
    }
    let html = '';
    for (const [estate, rows] of byEstate) {
      html += `<div class="perf-culture-title">🌱 ${this.escapeHtml(estate)}</div>`;
      html += rows.map(x => {
        const kindLabel = x.kind === 'mech' ? 'механизировано' : 'ряды';
        return `<div class="log-group">
          <div><b>${this.escapeHtml(x.work_type)}</b> · Кв.${this.escapeHtml(String(x.quarter))} <span class="perf-kind">· ${kindLabel}</span></div>
          <div style="margin-top:4px;">Сделано: <b>${x.done_ha}</b> га · Осталось: <b>${x.remaining_ha}</b> га</div>
        </div>`;
      }).join('');
    }
    list.innerHTML = html;
  }
```

### Стили `public/styles.css` (вместо блока в Task 3 Step 6)

```css
.perf-filter-row { display:flex; flex-wrap:wrap; gap:6px; align-items:center; margin:6px 0; }
.filter-label { color:#888; font-size:13px; margin-right:4px; }
.filter-chip { padding:4px 10px; border:1px solid #ccc; border-radius:14px; background:#fff; font-size:13px; cursor:pointer; }
.filter-chip.active { background:#2e7d32; color:#fff; border-color:#2e7d32; }
.perf-culture-title { font-weight:600; margin:12px 0 4px; }
.perf-kind { color:#888; font-size:12px; }
```

Task 1 Step 4 ожидание: PASS (12 тестов). Остальное в Task 1/2/3 ниже — фон/контекст; при расхождении приоритет у этого раздела.

---

## File Structure

- **Create:** `server/hectaresReport.js` — чистая функция агрегации (без БД, без Express). Единственная ответственность: из плоского списка записей + двух колбэков перевода построить строки отчёта.
- **Create:** `test/hectaresReport.test.js` — юнит-тесты агрегатора.
- **Modify:** `server/server.js` — новый endpoint `GET /api/report/hectares` (сразу после `app.get('/api/report'`, **строка 1850**) + `require` агрегатора вверху файла.
- **Modify:** `public/js/app.js` — кнопка вкладки (после кнопки «Сверка», **строка 509**), блок `tab-content#perf-tab` (после блока `id="reconcile-tab"`, **строка 547**), методы `loadPerformance()`/`togglePerfFilter()`/`renderPerformance()` (рядом с `renderRowsStatus`, **~строка 2080**), состояние фильтров в конструкторе.
- **Modify:** `public/styles.css` — стили чипов фильтров (файл лежит в `public/styles.css`, НЕ в `public/css/`).
- **Modify:** `public/service-worker.js` — бамп `CACHE_NAME` v21→v22 (правим клиент → иначе установленный PWA крутит старое).

---

## Task 1: Чистый агрегатор `server/hectaresReport.js`

**Files:**
- Create: `server/hectaresReport.js`
- Test: `test/hectaresReport.test.js`

- [ ] **Step 1: Написать падающий тест**

Создать `test/hectaresReport.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { buildHectaresReport, parseRowsCsv, kindOf } = require('../server/hectaresReport');

// Фейковые колбэки перевода: площадь клетки = (уникальных рядов) * 0.1 га;
// всего по кварталу = 1 га для кв.2/кв.7, иначе 0.5 га.
const fakeCellHa = (estate, q, c, rowsArr) => {
  if (c === 'NOHA') throw new Error('нет площади');
  return Math.round(rowsArr.length * 0.1 * 100) / 100;
};
const fakeQuarterTotalHa = (estate, q) => (q === '2' || q === '7' ? 1.0 : 0.5);

test('kindOf: hectares -> mech, остальное -> manual', () => {
  assert.strictEqual(kindOf('hectares'), 'mech');
  assert.strictEqual(kindOf('rows_bushes'), 'manual');
  assert.strictEqual(kindOf('rows_only'), 'manual');
});

test('manual: дедупликация — один ряд двум рабочим считается один раз', () => {
  const logs = [
    { estate_id: 'Яблоня', work_type: 'Обрезка', quarter: '2', cell: 'A', rows: '1,2', measure_mode: 'rows_bushes' },
    { estate_id: 'Яблоня', work_type: 'Обрезка', quarter: '2', cell: 'A', rows: '2,3', measure_mode: 'rows_bushes' },
  ];
  const out = buildHectaresReport(logs, fakeCellHa, fakeQuarterTotalHa);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].kind, 'manual');
  assert.strictEqual(out[0].done_ha, 0.3); // {1,2,3} -> 3*0.1
  assert.strictEqual(out[0].total_ha, 1.0);
  assert.strictEqual(out[0].remaining_ha, 0.7);
});

test('manual: накопление по клеткам внутри пары вид×квартал', () => {
  const logs = [
    { estate_id: 'Яблоня', work_type: 'Полив', quarter: '2', cell: 'A', rows: '1,2,3,4,5', measure_mode: 'rows_only' },
    { estate_id: 'Яблоня', work_type: 'Полив', quarter: '2', cell: 'B', rows: '1,2,3,4,5', measure_mode: 'rows_only' },
  ];
  const out = buildHectaresReport(logs, fakeCellHa, fakeQuarterTotalHa);
  assert.strictEqual(out[0].done_ha, 1.0); // 0.5 + 0.5
  assert.strictEqual(out[0].remaining_ha, 0.0);
});

test('manual: осталось зажато в 0, не уходит в минус', () => {
  const logs = [
    { estate_id: 'Яблоня', work_type: 'Полив', quarter: '5', cell: 'A', rows: '1,2,3,4,5,6,7,8', measure_mode: 'rows_bushes' },
  ];
  const out = buildHectaresReport(logs, fakeCellHa, fakeQuarterTotalHa);
  assert.strictEqual(out[0].remaining_ha, 0.0); // done 0.8 > total 0.5 -> 0
});

test('manual: клетка без площади пропускается, остальные считаются', () => {
  const logs = [
    { estate_id: 'Яблоня', work_type: 'Обрезка', quarter: '2', cell: 'NOHA', rows: '1,2,3', measure_mode: 'rows_bushes' },
    { estate_id: 'Яблоня', work_type: 'Обрезка', quarter: '2', cell: 'A', rows: '1,2', measure_mode: 'rows_bushes' },
  ];
  const out = buildHectaresReport(logs, fakeCellHa, fakeQuarterTotalHa);
  assert.strictEqual(out[0].done_ha, 0.2); // только клетка A
});

test('mech: гектары суммируются напрямую, kind=mech', () => {
  const logs = [
    { estate_id: 'Яблоня', work_type: 'Вспашка', quarter: '2', cell: '', rows: '', measure_mode: 'hectares', hectares: 0.3 },
    { estate_id: 'Яблоня', work_type: 'Вспашка', quarter: '2', cell: '', rows: '', measure_mode: 'hectares', hectares: 0.2 },
  ];
  const out = buildHectaresReport(logs, fakeCellHa, fakeQuarterTotalHa);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].kind, 'mech');
  assert.strictEqual(out[0].done_ha, 0.5); // 0.3 + 0.2
  assert.strictEqual(out[0].total_ha, 1.0);
  assert.strictEqual(out[0].remaining_ha, 0.5);
});

test('mech и manual для одной пары вид×квартал — две отдельные плашки', () => {
  const logs = [
    { estate_id: 'Яблоня', work_type: 'Обработка', quarter: '2', cell: 'A', rows: '1,2', measure_mode: 'rows_bushes' },
    { estate_id: 'Яблоня', work_type: 'Обработка', quarter: '2', cell: '', rows: '', measure_mode: 'hectares', hectares: 0.4 },
  ];
  const out = buildHectaresReport(logs, fakeCellHa, fakeQuarterTotalHa);
  assert.strictEqual(out.length, 2);
  assert.deepStrictEqual(out.map(r => r.kind).sort(), ['manual', 'mech']);
});

test('несколько культур: одинаковый вид работ -> отдельные строки с разным estate', () => {
  const logs = [
    { estate_id: 'Яблоня',  work_type: 'Обрезка', quarter: '2', cell: 'A', rows: '1,2', measure_mode: 'rows_bushes' },
    { estate_id: 'Виноград', work_type: 'Обрезка', quarter: '7', cell: 'A', rows: '1',  measure_mode: 'rows_bushes' },
  ];
  const out = buildHectaresReport(logs, fakeCellHa, fakeQuarterTotalHa);
  assert.strictEqual(out.length, 2);
  const estates = out.map(r => r.estate);
  assert.ok(estates.includes('Яблоня') && estates.includes('Виноград'));
});

test('пустой ввод -> пустой массив', () => {
  assert.deepStrictEqual(buildHectaresReport([], fakeCellHa, fakeQuarterTotalHa), []);
});

test('parseRowsCsv чистит пробелы и пустые', () => {
  assert.deepStrictEqual(parseRowsCsv(' 1, 2 ,,3 '), ['1', '2', '3']);
  assert.deepStrictEqual(parseRowsCsv(null), []);
});

test('сортировка: по культуре, кварталу (числом), виду работ', () => {
  const logs = [
    { estate_id: 'Яблоня', work_type: 'Полив',   quarter: '10', cell: 'A', rows: '1', measure_mode: 'rows_bushes' },
    { estate_id: 'Яблоня', work_type: 'Полив',   quarter: '2',  cell: 'A', rows: '1', measure_mode: 'rows_bushes' },
    { estate_id: 'Яблоня', work_type: 'Обрезка', quarter: '2',  cell: 'A', rows: '1', measure_mode: 'rows_bushes' },
  ];
  const out = buildHectaresReport(logs, fakeCellHa, fakeQuarterTotalHa);
  assert.deepStrictEqual(
    out.map(r => `${r.quarter}|${r.work_type}`),
    ['2|Обрезка', '2|Полив', '10|Полив']
  );
});
```

- [ ] **Step 2: Запустить тест — убедиться, что падает**

Run: `node --test test/hectaresReport.test.js`
Expected: FAIL — `Cannot find module '../server/hectaresReport'`.

- [ ] **Step 3: Реализовать агрегатор**

Создать `server/hectaresReport.js`:

```js
'use strict';

// Разбирает CSV рядов ("1, 2 ,,3") в массив непустых строк-номеров.
function parseRowsCsv(s) {
  return String(s || '').split(',').map(x => x.trim()).filter(Boolean);
}

const round2 = (n) => Math.round(n * 100) / 100;

// Тип записи: механизированная (прямой ввод га) или ручная (ряды).
function kindOf(measure_mode) {
  return measure_mode === 'hectares' ? 'mech' : 'manual';
}

// Строит строки отчёта «Выполнение». kind: 'manual' (ряды) | 'mech' (гектары).
// logRows: [{ estate_id, work_type, quarter, cell, rows, measure_mode, hectares }].
// cellHa/quarterTotalHa — колбэки перевода (см. ниже). Группировка по (тип,культура,вид,квартал).
//   logRows: [{ estate_id, work_type, quarter, cell, rows(CSV) }] — записи work_logs c непустыми rows.
//   cellHa(estate, quarter, cell, uniqueRowsArr) -> число га (может бросить -> клетку пропускаем).
//   quarterTotalHa(estate, quarter) -> вся площадь квартала, га.
// Возвращает [{ estate, work_type, quarter, done_ha, total_ha, remaining_ha }],
// отсортированные по estate, виду работ (ru), кварталу (числом, затем строкой).
function buildHectaresReport(logRows, cellHa, quarterTotalHa) {
  // manual: g.cells = Map<cell,Set<row>>; mech: g.doneHa = sum of hectares.
  const groups = new Map();
  for (const r of logRows) {
    const estate = r.estate_id;
    const wt = (r.work_type && String(r.work_type).trim()) ? r.work_type : '(без вида работ)';
    const quarter = String(r.quarter);
    const kind = kindOf(r.measure_mode);
    const key = `${estate}${wt}${quarter}`;
    let g = groups.get(key);
    if (!g) { g = { kind, estate, work_type: wt, quarter, cells: new Map(), doneHa: 0 }; groups.set(key, g); }
    if (kind === 'mech') {
      const ha = Number(r.hectares);
      if (isFinite(ha)) g.doneHa += ha;
    } else {
      const cell = String(r.cell);
      let set = g.cells.get(cell);
      if (!set) { set = new Set(); g.cells.set(cell, set); }
      for (const num of parseRowsCsv(r.rows)) set.add(num);
    }
  }

  const result = [];
  for (const g of groups.values()) {
    let done = 0;
    for (const [cell, set] of g.cells) {
      let ha;
      try { ha = cellHa(g.estate, g.quarter, cell, Array.from(set)); }
      catch { continue; } // клетка без площади / нет в инвентаре — пропускаем
      if (isFinite(ha)) done += ha;
    }
    done = round2(done);
    const total = round2(Number(quarterTotalHa(g.estate, g.quarter)) || 0);
    const remaining = round2(Math.max(0, total - done));
    result.push({ estate: g.estate, work_type: g.work_type, quarter: g.quarter,
      done_ha: done, total_ha: total, remaining_ha: remaining });
  }

  const qnum = (q) => { const n = parseInt(q, 10); return Number.isNaN(n) ? Infinity : n; };
  result.sort((a, b) =>
    a.estate.localeCompare(b.estate, 'ru') ||
    a.work_type.localeCompare(b.work_type, 'ru') ||
    qnum(a.quarter) - qnum(b.quarter) ||
    a.quarter.localeCompare(b.quarter, 'ru'));
  return result;
}

module.exports = { buildHectaresReport, parseRowsCsv, kindOf };
```

- [ ] **Step 4: Запустить тест — убедиться, что проходит**

Run: `node --test test/hectaresReport.test.js`
Expected: PASS (7 тестов).

- [ ] **Step 5: Коммит**

```bash
git add server/hectaresReport.js test/hectaresReport.test.js
git commit -m "feat(demo): чистый агрегатор отчёта Выполнение (га) + тесты"
```

---

## Task 2: Серверный endpoint `GET /api/report/hectares`

**Files:**
- Modify: `server/server.js` (require вверху; новый endpoint после `GET /api/report`, ~строка 1858)

- [ ] **Step 1: Подключить агрегатор**

В шапке `server/server.js`, рядом с другими `require` модулей `server/` (например где подключается `parser`/`rowControl`), добавить:

```js
const { buildHectaresReport } = require('./hectaresReport');
```

- [ ] **Step 2: Добавить endpoint**

Сразу ПОСЛЕ блока `app.get('/api/report', ...)` (после его закрывающей `});`, **строка 1850**) вставить:

```js
// Отчёт «Выполнение»: по виду работ × квартал — сколько гектаров сделано
// (накопительно, уникальные ряды -> га) и сколько осталось до площади квартала.
// Только демо; ввод остаётся в рядах, это лишь экран-пересчёт.
app.get('/api/report/hectares', authOrDemo, async (req, res) => {
  try {
    let parserToUse;
    if (DEMO_MODE) {
      parserToUse = new DataParser(await demo.getDemoInventory(pool, req.demo_session_id));
    } else {
      parserToUse = parser;
    }

    let result;
    if (DEMO_MODE) {
      result = await pool.query(
        `SELECT estate_id, quarter, cell, work_type, rows
         FROM work_logs
         WHERE demo_session_id = $1 AND rows IS NOT NULL AND rows <> ''`,
        [req.demo_session_id]
      );
    } else {
      result = await pool.query(
        `SELECT estate_id, quarter, cell, work_type, rows
         FROM work_logs
         WHERE brigadier_id = $1 AND rows IS NOT NULL AND rows <> ''`,
        [req.brigadier.id]
      );
    }

    // Перевод рядов клетки в га (бросает, если у клетки нет площади — агрегатор ловит).
    const cellHa = (estate, quarter, cell, rowsArr) =>
      parserToUse.getHectaresForRows(estate, String(quarter), String(cell), rowsArr);

    // Вся площадь квартала = сумма hectares известных клеток квартала из инвентаря.
    const quarterTotalHa = (estate, quarter) => {
      const edata = parserToUse.inventory && parserToUse.inventory.estates
        ? parserToUse.inventory.estates[estate] : null;
      if (!edata) return 0;
      const qdata = edata.quarters[String(quarter)];
      if (!qdata || !qdata.cells) return 0;
      let sum = 0;
      for (const ck of Object.keys(qdata.cells)) {
        const cellData = qdata.cells[ck];
        const ha = (cellData && typeof cellData === 'object' && !Array.isArray(cellData))
          ? cellData.hectares : null;
        if (ha != null && isFinite(Number(ha))) sum += Number(ha);
      }
      return sum;
    };

    const rows = buildHectaresReport(result.rows, cellHa, quarterTotalHa);
    res.json({ rows });
  } catch (error) {
    console.error('Hectares report error:', error);
    res.status(500).json({ error: error.message });
  }
});
```

- [ ] **Step 3: Проверить синтаксис**

Run: `node --check server/server.js`
Expected: без вывода (OK).

- [ ] **Step 4: Smoke — endpoint на пустой сессии отвечает 200 и `{rows:[]}`**

Демо-сессия создаётся через `POST /api/demo/session` (НЕ `/api/demo/start`); без валидной сессии любой `/api/...` (кроме `/api/demo/session` и `/api/config`) вернёт 401 «no demo session» (см. server.js:403-407). Проще всего проверить при деплое на VPS, где БД и сессии уже есть:

Run (на VPS, порт **3001**): `curl -s -X POST http://127.0.0.1:3001/api/demo/session -H 'Content-Type: application/json' -d '{}' -c cj.txt >/dev/null; curl -s -b cj.txt http://127.0.0.1:3001/api/report/hectares`
Expected: `{"rows":[]}` (пустая новая сессия), статус 200.

(Локально без демо-БД шаг не блокирует коммит — логика покрыта юнит-тестами Task 1; финальная проверка — на VPS и живая Натали.)

- [ ] **Step 5: Коммит**

```bash
git add server/server.js
git commit -m "feat(demo): endpoint GET /api/report/hectares"
```

---

## Task 3: Клиентская вкладка «Выполнение»

**Files:**
- Modify: `public/js/app.js` (кнопка вкладки ~строка 508; блок `tab-content` ~строка 544; новые методы рядом с `loadDisputed`/`renderDisputed` ~строка 1858)

- [ ] **Step 1: Добавить кнопку вкладки**

В блоке `<div class="tabs">` (после кнопки «Сверка», **строка 509**, перед условной кнопкой «Админ») добавить:

```js
          <button class="tab-button" onclick="app.switchTab(event, 'perf'); app.loadPerformance()">Выполнение</button>
```

- [ ] **Step 2: Добавить контейнер вкладки**

После блока `<div class="tab-content" id="reconcile-tab"> ... </div>` (блок Фазы 3 начинается на **строке 547**; вставлять ПОСЛЕ его закрывающего `</div>`) вставить:

```js
        <div class="tab-content" id="perf-tab">
          <button onclick="app.loadPerformance()">Обновить</button>
          <div id="perf-filters"></div>
          <div id="perf-list" class="logs-list"></div>
        </div>
```

- [ ] **Step 3: Инициализировать состояние фильтров в конструкторе**

В конструкторе класса (где задаются прочие поля состояния, напр. рядом с `this.disputed = []`) добавить:

```js
    this.perfRows = [];
    this.perfQuarters = new Set();   // выбранные кварталы (пусто трактуем как «все»)
    this.perfWorkTypes = new Set();  // выбранные виды работ
```

- [ ] **Step 4: Добавить методы загрузки и отрисовки**

Рядом с методами вкладок «Спорные»/«Сверка» (`renderDisputed` ~строка 1963, `renderRowsStatus` ~строка 2058; вставить после `renderRowsStatus`, **~строка 2080**) добавить:

```js
  // Загружает отчёт «Выполнение» (га сделано/осталось) и рисует с фильтрами.
  async loadPerformance() {
    const list = document.getElementById('perf-list');
    if (!list) return;
    try {
      const r = await this.apiFetch('/api/report/hectares');
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        list.innerHTML = `<p style="color:#c00;padding:10px;">${this.escapeHtml(data.error || 'Ошибка')}</p>`;
        return;
      }
      this.perfRows = data.rows || [];
      // По умолчанию выбраны ВСЕ кварталы и виды работ из ответа.
      this.perfQuarters = new Set(this.perfRows.map(x => String(x.quarter)));
      this.perfWorkTypes = new Set(this.perfRows.map(x => x.work_type));
      this.renderPerformance();
    } catch (e) {
      list.innerHTML = `<p style="color:#c00;padding:10px;">${this.escapeHtml(e.message)}</p>`;
    }
  }

  // Переключает чип-фильтр (квартал или вид работ) и перерисовывает.
  togglePerfFilter(kind, value) {
    const set = kind === 'q' ? this.perfQuarters : this.perfWorkTypes;
    if (set.has(value)) set.delete(value); else set.add(value);
    this.renderPerformance();
  }

  renderPerformance() {
    const filters = document.getElementById('perf-filters');
    const list = document.getElementById('perf-list');
    if (!filters || !list) return;

    if (!this.perfRows || this.perfRows.length === 0) {
      filters.innerHTML = '';
      list.innerHTML = '<p style="color:#888;padding:10px;">Пока ничего не записано — заполни журнал, и тут появятся гектары.</p>';
      return;
    }

    // Чипы фильтров: уникальные виды работ и кварталы.
    const allQ = [...new Set(this.perfRows.map(x => String(x.quarter)))]
      .sort((a, b) => (parseInt(a, 10) || 0) - (parseInt(b, 10) || 0));
    const allWt = [...new Set(this.perfRows.map(x => x.work_type))]
      .sort((a, b) => a.localeCompare(b, 'ru'));
    const chip = (kind, val, on) =>
      `<button class="filter-chip ${on ? 'active' : ''}" onclick="app.togglePerfFilter('${kind}', '${this.escapeAttr(val)}')">${this.escapeHtml(val)}</button>`;
    filters.innerHTML =
      `<div class="perf-filter-row"><span class="filter-label">Виды работ:</span>` +
      allWt.map(wt => chip('wt', wt, this.perfWorkTypes.has(wt))).join('') + `</div>` +
      `<div class="perf-filter-row"><span class="filter-label">Кварталы:</span>` +
      allQ.map(q => chip('q', q, this.perfQuarters.has(q))).join('') + `</div>`;

    const shown = this.perfRows.filter(x =>
      this.perfWorkTypes.has(x.work_type) && this.perfQuarters.has(String(x.quarter)));
    if (shown.length === 0) {
      list.innerHTML = '<p style="color:#888;padding:10px;">Ничего не выбрано в фильтрах.</p>';
      return;
    }
    list.innerHTML = shown.map(x => `
      <div class="log-group">
        <div><b>${this.escapeHtml(x.work_type)}</b> · Кв.${this.escapeHtml(String(x.quarter))}</div>
        <div style="margin-top:4px;">Сделано: <b>${x.done_ha}</b> га · Осталось: <b>${x.remaining_ha}</b> га</div>
      </div>
    `).join('');
  }
```

- [ ] **Step 5: Добавить `escapeAttr` (в текущем `app.js` её НЕТ — добавить обязательно)**

Сверено 2026-06-07: метода `escapeAttr` в `app.js` нет. Добавить рядом с `escapeHtml`:

```js
  // Экранирует значение для подстановки в одинарные кавычки onclick-атрибута.
  escapeAttr(s) {
    return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '&quot;');
  }
```

(Если `escapeHtml` уже даёт безопасный результат и значения — только цифры кварталов и имена видов работ, можно переиспользовать существующий механизм; но виды работ вводятся пользователем, поэтому экранирование атрибута обязательно.)

- [ ] **Step 6: Добавить минимальные стили чипов**

В `public/styles.css` (в конец; файл лежит именно в `public/styles.css`, каталога `public/css/` нет) добавить, если классов нет:

```css
.perf-filter-row { display:flex; flex-wrap:wrap; gap:6px; align-items:center; margin:6px 0; }
.filter-label { color:#888; font-size:13px; margin-right:4px; }
.filter-chip { padding:4px 10px; border:1px solid #ccc; border-radius:14px; background:#fff; font-size:13px; cursor:pointer; }
.filter-chip.active { background:#2e7d32; color:#fff; border-color:#2e7d32; }
```

- [ ] **Step 6b: Поднять версию кеша PWA (обязательно — правили клиент)**

В `public/service-worker.js` (строка 1) заменить:

```js
const CACHE_NAME = 'brigade-v21';
```

на:

```js
const CACHE_NAME = 'brigade-v22';
```

Без этого установленный PWA на телефоне будет крутить старый клиент без вкладки «Выполнение» (известный урок проекта). Демо-SW на момент составления плана = `brigade-v21`; ПЕРЕД правкой убедиться `grep CACHE_NAME public/service-worker.js` и поднять на следующий номер.

- [ ] **Step 7: Проверить синтаксис JS**

Run: `node --check public/js/app.js`
Expected: без вывода (OK).

- [ ] **Step 8: Ручная проверка в браузере**

Поднять демо локально (или дождаться деплоя). Записать в журнал несколько рядов по 1-2 видам работ в одном квартале → открыть вкладку «Выполнение»:
- появились строки вид работ × квартал с «Сделано»/«Осталось»;
- чипы фильтров кварталов и видов работ переключаются, список реагирует;
- разделить один ряд между двумя рабочими и убедиться, что площадь не задвоилась;
- на пустой сессии — дружелюбная заглушка.

- [ ] **Step 9: Коммит**

```bash
git add public/js/app.js public/styles.css public/service-worker.js
git commit -m "feat(demo): вкладка Выполнение (сделано/осталось в га) + фильтры, бамп кеша SW"
```

---

## Финал

- [ ] Холистическое ревью всей ветки (spec + code-quality) согласно subagent-driven-development.
- [ ] Прогон: `node --test` (весь набор) + `node --check` ключевых файлов.
- [ ] **Деплой — отдельным шагом, после живой проверки Натали:** merge ветки в `demo-five-modes`, push в приватный SourceCraft (`git push demo demo-five-modes`), на VPS (`root@213.139.210.254`, `/opt/pomoshnik-demo`, pm2 `pomoshnik-demo`, **порт 3001**) `git pull && pm2 restart pomoshnik-demo`, smoke `/api/report/hectares` → 200, публичный health https://demo.smart-assistantai.ru/health → 200. **Боевого (GitHub/Render) НЕ касаемся — фича только демо.**

## Self-Review (заполняется автором плана)

- **Покрытие спеки:** §3 правила расчёта → Task 1 (дедуп, накопление, осталось≥0, пропуск клетки без площади) + Task 2 (источник данных, quarterTotalHa). §4 архитектура → Task 1/2/3. §2 вкладка/фильтры/две цифры → Task 3. §5 крайние случаи → Task 1 (try/catch клетки, clamp 0), Task 2 (quarterTotalHa=0 при отсутствии), Task 3 (заглушка пустой сессии). §6 тесты → Task 1 + smoke Task 2.
- **Типы согласованы:** агрегатор возвращает `{estate, work_type, quarter, done_ha, total_ha, remaining_ha}` — те же поля читает клиент (`x.work_type`, `x.quarter`, `x.done_ha`, `x.remaining_ha`) и отдаёт endpoint (`{rows}`).
- **Без плейсхолдеров:** код приведён полностью во всех шагах, изменяющих код.
