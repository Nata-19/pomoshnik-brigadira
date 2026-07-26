# Бухгалтерия: TSV-выгрузка — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Бригадир копирует (и где возможно — «делится») текстовую таблицу ручных работ в формате колонок Excel бухгалтера — с Ввода (день) и с Отчёта (период).

**Architecture:** Чистая сборка TSV в `server/accountingExport.js` (агрегация как плашка «Ручные работы» + к-во чел. через `resolvePeopleCountForLine`). HTTP `GET /api/accounting/export` подгружает логи, явку и разбивку за диапазон. Клиент — кнопки у «Всего за день» и у результата отчёта; буфер / Web Share.

**Tech Stack:** Node ≥20, Express, PostgreSQL (`pg`), vanilla JS `public/js/app.js`, `node --test`.

**Spec:** `docs/superpowers/specs/2026-07-26-accounting-export-design.md`

## Global Constraints

- Только **ручные** работы (`work_types.kind !== 'mechanized'`).
- Колонки 10–15 всегда пустые (норма, расценка, оплаты).
- 1 фамилия бригады = блок `--- Фамилия ---` (аналог листа).
- Демо: предприятие `ООО «Демо-Агро»`, сорт `Ркацители`, год посадки `2020` — заглушки; прод: предприятие из `BRAND_NAME`, сорт/год пока те же заглушки (inventory позже).
- Дата в TSV: `DD.MM.YYYY`.
- Не скачивать `.xlsx`, не слать почту в этой задаче.
- Демо и прод — один код (`authOrDemo`, как `/api/logs`).

## File map

| File | Role |
|------|------|
| `server/accountingExport.js` | агрегация строк, TSV, заглушки колонок |
| `test/accountingExport.test.js` | unit-тесты сборки |
| `server/server.js` | `GET /api/accounting/export` |
| `server/config.js` | уже есть `BRAND_NAME` — использовать |
| `public/js/app.js` | кнопки + fetch + copy/share |

---

### Task 1: Хелперы accountingExport + тесты

**Files:**
- Create: `server/accountingExport.js`
- Create: `test/accountingExport.test.js`

**Interfaces:**
- Consumes: `resolvePeopleCountForLine` from `./peopleAllocations`
- Produces:
  - `ACCOUNTING_HEADERS: string[]` — 15 заголовков колонок
  - `formatAccountingDate(iso: string): string` — `YYYY-MM-DD` → `DD.MM.YYYY`
  - `factForLine(line: { measure_mode, bushes?, hours?, rowCount? }): number | ''`
  - `aggregateManualLines(logs: Array, mechanizedNames: Set<string>): Array<{ date, employee, work_type, quarter, cell, measure_mode, rowCount, bushes, hours }>`
  - `buildAccountingTsv(opts): { text: string, sheetNames: string[], rowCount: number }`
    - opts: `{ logs, present: Array<{ date, employee_id, name, people_count }>, allocations: Array<{ date?, employee_id, work_type, quarter, people_count }>, mechanizedNames: Set<string>|string[], enterprise: string, varietyStub: string, yearStub: string }`

- [ ] **Step 1: Write the failing tests**

```js
// test/accountingExport.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ACCOUNTING_HEADERS,
  formatAccountingDate,
  factForLine,
  aggregateManualLines,
  buildAccountingTsv,
} = require('../server/accountingExport');

test('formatAccountingDate', () => {
  assert.equal(formatAccountingDate('2026-07-20'), '20.07.2026');
});

test('factForLine: кусты / часы / ряды', () => {
  assert.equal(factForLine({ measure_mode: 'rows_bushes', bushes: 1452, rowCount: 7 }), 1452);
  assert.equal(factForLine({ measure_mode: 'hours', hours: 6 }), 6);
  assert.equal(factForLine({ measure_mode: 'rows_only', rowCount: 3.5 }), 3.5);
});

test('aggregateManualLines: без механизированных; ключ с датой', () => {
  const mech = new Set(['Опрыскивание мех']);
  const lines = aggregateManualLines([
    { date: '2026-07-20', employee: 'Иванов', work_type: 'Обрезка', quarter: '2', cell: '2',
      measure_mode: 'rows_bushes', bushes: 100, rows: '1-2', row_weights: null },
    { date: '2026-07-20', employee: 'Иванов', work_type: 'Обрезка', quarter: '2', cell: '2',
      measure_mode: 'rows_bushes', bushes: 50, rows: '3', row_weights: null },
    { date: '2026-07-20', employee: 'Иванов', work_type: 'Опрыскивание мех', quarter: '1', cell: '1',
      measure_mode: 'hectares', hectares: 1.2, rows: '', row_weights: null },
  ], mech);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].bushes, 150);
  assert.equal(lines[0].employee, 'Иванов');
});

test('buildAccountingTsv: два листа, к-во чел. из кусков, колонки 10–15 пустые', () => {
  const { text, sheetNames, rowCount } = buildAccountingTsv({
    logs: [
      { date: '2026-07-20', employee: 'Иванов', work_type: 'Обрезка', quarter: '2', cell: '2',
        measure_mode: 'rows_bushes', bushes: 982, rows: '1-7', row_weights: null },
      { date: '2026-07-20', employee: 'Иванов', work_type: 'хоз работы', quarter: '', cell: '',
        measure_mode: 'hours', hours: 6, rows: '', row_weights: null },
      { date: '2026-07-20', employee: 'Панова', work_type: 'Обрезка', quarter: '9', cell: '1',
        measure_mode: 'rows_bushes', bushes: 100, rows: '1', row_weights: null },
    ],
    present: [
      { date: '2026-07-20', employee_id: 1, name: 'Иванов', people_count: 8 },
      { date: '2026-07-20', employee_id: 2, name: 'Панова', people_count: 3 },
    ],
    allocations: [
      { date: '2026-07-20', employee_id: 1, work_type: 'Обрезка', quarter: '2', people_count: 7 },
      { date: '2026-07-20', employee_id: 1, work_type: 'хоз работы', quarter: '', people_count: 1 },
    ],
    mechanizedNames: [],
    enterprise: 'ООО «Демо-Агро»',
    varietyStub: 'Ркацители',
    yearStub: '2020',
  });
  assert.deepEqual(sheetNames, ['Иванов', 'Панова']);
  assert.equal(rowCount, 3);
  assert.ok(text.includes('--- Иванов ---'));
  assert.ok(text.includes('--- Панова ---'));
  assert.ok(text.includes(ACCOUNTING_HEADERS.join('\t')));
  const ivanovBlock = text.split('--- Панова ---')[0];
  assert.ok(ivanovBlock.includes('Обрезка'));
  assert.ok(ivanovBlock.includes('\t7\t')); // к-во чел. обрезка
  assert.ok(ivanovBlock.includes('\t1\t')); // к-во чел. хоз
  // хвост строки: 6 пустых полей после Факта
  const dataLine = ivanovBlock.split('\n').find((l) => l.includes('Обрезка') && l.includes('982'));
  assert.ok(dataLine);
  const parts = dataLine.split('\t');
  assert.equal(parts.length, 15);
  assert.equal(parts[9], '');
  assert.equal(parts[14], '');
});
```

- [ ] **Step 2: Run tests — expect FAIL**

Run: `node --test test/accountingExport.test.js`  
Expected: FAIL — cannot find module `../server/accountingExport`

- [ ] **Step 3: Implement module**

```js
// server/accountingExport.js
'use strict';
const { resolvePeopleCountForLine, normalizeAllocationQuarter } = require('./peopleAllocations');

const ACCOUNTING_HEADERS = [
  'Технологическая операция, Условное обозначение',
  'год посадки',
  'квартал',
  'сорт',
  'Услуга (работа)',
  'Дата',
  'к-во чел.',
  'Бригада',
  'Факт',
  'Норма',
  'Расценка',
  'оплата людям',
  'транспорт 150;450/чел.',
  'Бригадирские 150/чел.',
  'Сумма итого',
];

function formatAccountingDate(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return String(iso || '');
  return `${m[3]}.${m[2]}.${m[1]}`;
}

function rowWeightSum(log) {
  // Минимальная копия: если есть row_weights JSON — сумма весов; иначе число сегментов rows.
  // Предпочтительно: require('./rowControl').weightOfRecord(log.rows, log.row_weights)
  const rowControl = require('./rowControl');
  return rowControl.weightOfRecord(log.rows, log.row_weights);
}

function factForLine(line) {
  if (line.measure_mode === 'hours') return Number(line.hours) || 0;
  if (line.measure_mode === 'rows_bushes') return Number(line.bushes) || 0;
  const n = Number(line.rowCount);
  return Number.isFinite(n) ? n : '';
}

function aggregateManualLines(logs, mechanizedNames) {
  const mech = mechanizedNames instanceof Set
    ? mechanizedNames
    : new Set(mechanizedNames || []);
  const map = new Map();
  for (const log of logs || []) {
    const wt = log.work_type || '';
    if (mech.has(wt)) continue;
    const date = log.date || '';
    const employee = log.employee || '—';
    const quarter = normalizeAllocationQuarter(log.quarter);
    const cell = log.cell != null ? String(log.cell) : '';
    const mode = log.measure_mode || '';
    const key = [date, employee, wt, quarter, cell, mode].join('|');
    if (!map.has(key)) {
      map.set(key, {
        date, employee, work_type: wt, quarter, cell, measure_mode: mode,
        rowCount: 0, bushes: 0, hours: 0,
      });
    }
    const it = map.get(key);
    it.rowCount += rowWeightSum(log);
    it.bushes += Number(log.bushes) || 0;
    it.hours += Number(log.hours) || 0;
  }
  return Array.from(map.values());
}

function buildAccountingTsv({
  logs,
  present,
  allocations,
  mechanizedNames,
  enterprise,
  varietyStub,
  yearStub,
}) {
  const lines = aggregateManualLines(logs, mechanizedNames);
  const byEmp = new Map();
  for (const line of lines) {
    const name = line.employee || '—';
    if (!byEmp.has(name)) byEmp.set(name, []);
    byEmp.get(name).push(line);
  }
  const sheetNames = Array.from(byEmp.keys()).sort((a, b) => a.localeCompare(b, 'ru'));
  const header = ACCOUNTING_HEADERS.join('\t');
  const chunks = [];
  let rowCount = 0;

  for (const name of sheetNames) {
    chunks.push(`--- ${name} ---`);
    chunks.push(header);
    const rows = byEmp.get(name).slice().sort((a, b) => {
      if (a.date !== b.date) return (a.date || '').localeCompare(b.date || '');
      const byWt = (a.work_type || '').localeCompare(b.work_type || '', 'ru');
      if (byWt) return byWt;
      return (Number(a.quarter) || 0) - (Number(b.quarter) || 0);
    });
    for (const line of rows) {
      const presentForDate = (present || []).filter((p) => p.date === line.date);
      const allocForDate = (allocations || []).filter(
        (a) => !a.date || a.date === line.date
      );
      const people = resolvePeopleCountForLine(
        { name: line.employee, work_type: line.work_type, quarter: line.quarter },
        { present: presentForDate, allocations: allocForDate }
      );
      const fact = factForLine(line);
      const cells = [
        line.work_type || '',
        yearStub || '',
        line.quarter || '',
        varietyStub || '',
        enterprise || '',
        formatAccountingDate(line.date),
        people == null ? '' : String(people),
        line.employee || '',
        fact === '' ? '' : String(fact),
        '', '', '', '', '', '',
      ];
      chunks.push(cells.join('\t'));
      rowCount += 1;
    }
  }

  return { text: chunks.join('\n'), sheetNames, rowCount };
}

module.exports = {
  ACCOUNTING_HEADERS,
  formatAccountingDate,
  factForLine,
  aggregateManualLines,
  buildAccountingTsv,
};
```

В реализации `rowWeightSum` — обязательно через `rowControl.weightOfRecord`, не упрощать вслепую.

- [ ] **Step 4: Run tests — expect PASS**

Run: `node --test test/accountingExport.test.js`  
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add server/accountingExport.js test/accountingExport.test.js
git commit -m "feat(accounting): helpers for TSV export of manual work rows"
```

---

### Task 2: API GET /api/accounting/export

**Files:**
- Modify: `server/server.js` — require + route рядом с `/api/report`
- Modify: использовать `BRAND_NAME` из `./config` (уже импортирован)

**Interfaces:**
- Consumes: `buildAccountingTsv` from `./accountingExport`
- Produces: HTTP JSON `{ text, sheetNames, rowCount }`

- [ ] **Step 1: Add route**

Логика валидации дат — как у `/api/logs` / `/api/report`:
- либо `date=YYYY-MM-DD`, либо `from`+`to`; иначе 400;
- `from > to` → 400;
- в проде `estate` обязателен (как логи); в демо `estate` опционален.

Псевдокод обработчика:

```js
const { buildAccountingTsv } = require('./accountingExport');
// внутри:
// 1) SELECT work_logs … (те же фильтры date/from/to/estate/owner что /api/logs)
// 2) SELECT name FROM work_types WHERE kind='mechanized' AND owner…
// 3) SELECT a.date, a.employee_id, e.name, a.people_count FROM attendance a JOIN employees e …
//    WHERE owner AND date IN range
// 4) SELECT date, employee_id, work_type, quarter, people_count FROM people_allocations …
// 5) enterprise = DEMO_MODE ? 'ООО «Демо-Агро»' : BRAND_NAME
// 6) res.json(buildAccountingTsv({ logs, present, allocations, mechanizedNames, enterprise,
//      varietyStub: 'Ркацители', yearStub: '2020' }))
```

Для attendance/allocations в режиме одного `date` — фильтр `date = $n`; для периода — `date >= from AND date <= to`.

- [ ] **Step 2: Smoke вручную (локально или на демке после деплоя)**

```bash
# после логина/демо-сессии:
curl -s "http://localhost:PORT/api/accounting/export?date=2026-07-26" -H "Cookie: …"
```

Expected: JSON с `text`, `rowCount` ≥ 0.

- [ ] **Step 3: Commit**

```bash
git add server/server.js
git commit -m "feat(accounting): GET /api/accounting/export for day or period"
```

---

### Task 3: UI — Скопировать / Поделиться на Вводе и Отчёте

**Files:**
- Modify: `public/js/app.js`
  - блок «Всего за день» в `renderInput` (~строка 892)
  - `getReport` / `#report-result` (~3104)
  - методы: `accountingExportButtonsHtml`, `copyAccountingExport`, `shareAccountingExport`, `fetchAccountingExport`

**Interfaces:**
- Consumes: `GET /api/accounting/export`, существующий `_copyText` (обобщить сообщение) или соседний хелпер
- Produces: кнопки в DOM

- [ ] **Step 1: Хелперы в классе**

```js
accountingExportButtonsHtml(msgId) {
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
  return `
    <div class="accounting-export-actions" style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
      <button type="button" class="mini-btn" onclick="app.copyAccountingExport('${msgId}')">Скопировать для бухгалтера</button>
      ${canShare ? `<button type="button" class="mini-btn" onclick="app.shareAccountingExport('${msgId}')">Поделиться</button>` : ''}
      <span id="${msgId}" class="auth-msg"></span>
    </div>`;
}

async fetchAccountingExport() {
  // Если msgId === accounting с ввода — date=this.inputDate
  // Если с отчёта — from/to из #from-date/#to-date
  // URL + estate в проде как у getReport / logs
}

async copyAccountingExport(msgId) {
  const show = (t) => { const el = document.getElementById(msgId); if (el) { el.className = 'auth-msg'; el.textContent = t; } };
  try {
    const data = await this.fetchAccountingExport(/* context from msgId */);
    if (!data.rowCount) { show('Нет ручных работ за этот период'); return; }
    // clipboard как в _copyText
    show('✓ Скопировано — вставь в Excel');
  } catch (e) { show('❌ ' + (e.message || e)); }
}

async shareAccountingExport(msgId) {
  // fetch → navigator.share({ text: data.text, title: 'Для бухгалтера' })
  // fallback: copyAccountingExport
}
```

Различать контекст: `msgId === 'i2-accounting-msg'` → день ввода; `msgId === 'report-accounting-msg'` → период отчёта.

- [ ] **Step 2: Вставить кнопки**

В `renderInput` после `#i2-totals`:

```html
${this.accountingExportButtonsHtml('i2-accounting-msg')}
```

В `getReport` после успешного `innerHTML` плашек — дописать кнопки в конец (или обернуть result + actions).

- [ ] **Step 3: Ручная проверка**

1. Ввод: Иванов обрезка 7 чел. + хоз 1 чел. → Скопировать → вставить в Excel/блокнот: две строки, к-во 7 и 1, колонки 10–15 пустые.  
2. Отчёт за период с двумя днями → даты разные в колонке Дата; блоки по фамилиям.  
3. Пустой день → сообщение без копирования.  
4. Chrome Android (если есть): «Поделиться» видно.

- [ ] **Step 4: Commit**

```bash
git add public/js/app.js
git commit -m "feat(accounting): copy/share TSV buttons on input and report"
```

---

### Task 4: _progress + (опционально) деплой demo

**Files:**
- Modify: `_progress.md` (локально; если в `.gitignore` — не коммитить)

- [ ] **Step 1: Отметить в `_progress.md`:** спека ✅, план ✅, задачи 1–3 статус.
- [ ] **Step 2:** По просьбе Наталии: `git push demo demo-five-modes` + на VPS `git pull origin demo-five-modes && pm2 restart pomoshnik-demo`.

---

## Spec coverage (self-review)

| Spec § | Task |
|--------|------|
| API day/period | Task 2 |
| TSV + headers 1–15, empty 10–15 | Task 1 |
| Sheets by surname | Task 1 `--- Name ---` |
| Manual only | Task 1 + 2 mechanizedNames |
| People count from allocations | Task 1 `resolvePeopleCountForLine` |
| Stubs enterprise/variety/year | Task 1–2 |
| UI copy + share both places | Task 3 |
| Empty → message | Task 3 |
| No xlsx/email/tab | — out of scope, not in tasks |

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-26-accounting-export.md`.

**Two execution options:**

1. **Subagent-Driven (recommended)** — свежий субагент на задачу, ревью между задачами  
2. **Inline Execution** — делаем задачи в этом чате с чекпоинтами  

Which approach?
