# Предупреждение о фантомных рядах — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Показывать мягкое inline-предупреждение прямо при вводе, если бригадир вводит номер ряда больше инвентарного максимума клетки.

**Architecture:** Чисто клиентская фича. Расширяем уже существующий кеш инвентаря в `app.js` (данные уже приходят в `loadCells` — просто не сохранялись). Добавляем `oninput`-обработчик на поле рядов и inline warn-div. Предупреждение не блокирует отправку. Сервер не трогаем.

**Tech Stack:** Vanilla JS (app.js), CSS (styles.css), Service Worker (service-worker.js). Тесты сервера: `node --test` (CommonJS). Клиентских автотестов нет — верификация ручная.

**Spec:** `docs/superpowers/specs/2026-06-12-phantom-rows-warning-design.md`

---

## Файлы

| Файл | Что меняем |
|---|---|
| `public/js/app.js` | constructor (новое поле), `loadCells` (кеш maxRow), `onI2CellChange` (ctxCellMaxRow), шаблон поля рядов (oninput+warn-div), новый метод `onRowsInput` |
| `public/styles.css` | новый класс `.rows-warn` после `.measure-hint` (line 1051) |
| `public/service-worker.js` | бамп `CACHE_NAME`: `brigade-v22` → `brigade-v23` (line 1) |

---

## Task 1: Расширить кеш инвентаря — maxRow на клетку

**Files:**
- Modify: `public/js/app.js:7` (constructor), `public/js/app.js:138-150` (loadCells), `public/js/app.js:1511-1513` (onI2CellChange)

- [ ] **Step 1: Добавить поле `cellMaxRow` в конструктор**

В `public/js/app.js` строка 7 выглядит так:
```js
    this.cellsByQuarter = {}; // кэш клеток по (estate|quarter)
```

Добавить строку ПОСЛЕ неё:
```js
    this.cellsByQuarter = {}; // кэш клеток по (estate|quarter)
    this.cellMaxRow = {};     // кэш: "estate|quarter|cell" → макс. ряд
```

- [ ] **Step 2: Заполнять `cellMaxRow` в `loadCells`**

В `public/js/app.js` строки 138-150:
```js
  async loadCells(quarterId) {
    const key = this.estate + '|' + quarterId;
    if (this.cellsByQuarter[key]) return this.cellsByQuarter[key];
    try {
      const r = await fetch('/api/inventory/' + encodeURIComponent(this.estate) + '/' + encodeURIComponent(quarterId));
      const data = await r.json();
      const cells = Object.keys(data.cells || {}).sort((a, b) => +a - +b);
      this.cellsByQuarter[key] = cells;
      return cells;
    } catch (e) {
      return [];
    }
  }
```

Заменить на:
```js
  async loadCells(quarterId) {
    const key = this.estate + '|' + quarterId;
    if (this.cellsByQuarter[key]) return this.cellsByQuarter[key];
    try {
      const r = await fetch('/api/inventory/' + encodeURIComponent(this.estate) + '/' + encodeURIComponent(quarterId));
      const data = await r.json();
      const cells = Object.keys(data.cells || {}).sort((a, b) => +a - +b);
      this.cellsByQuarter[key] = cells;
      for (const [cell, cellData] of Object.entries(data.cells || {})) {
        const rows = Array.isArray(cellData) ? cellData : (cellData.rows || []);
        if (rows.length) {
          this.cellMaxRow[this.estate + '|' + quarterId + '|' + cell] =
            Math.max(...rows.map(r => typeof r === 'object' ? r.row : r));
        }
      }
      return cells;
    } catch (e) {
      return [];
    }
  }
```

Примечание: `cellData` может быть массивом (старый формат) или объектом `{hectares, rows:[...]}` (новый). Оба обрабатываются.

- [ ] **Step 3: Сохранять `ctxCellMaxRow` при смене клетки**

В `public/js/app.js` строки 1511-1513:
```js
  onI2CellChange() {
    this.ctxCell = document.getElementById('i2-cell').value;
  }
```

Заменить на:
```js
  onI2CellChange() {
    this.ctxCell = document.getElementById('i2-cell').value;
    this.ctxCellMaxRow = this.cellMaxRow[this.estate + '|' + this.ctxQuarter + '|' + this.ctxCell] ?? null;
  }
```

- [ ] **Step 4: Убедиться что `ctxCellMaxRow` объявлен в конструкторе**

Проверь в конструкторе (область строк 14-21) что там уже есть `this.ctxCell = ''`. Рядом с ним добавить:
```js
    this.ctxCellMaxRow = null;    // макс. ряд выбранной клетки (из инвентаря)
```

Точная вставка — после строки `this.ctxCell = '';` (line 15).

- [ ] **Step 5: Запустить серверные тесты — убедиться что ничего не сломали**

```bash
cd C:/Users/service/Documents/Projects/помощник-бригадира-демо
npm test
```

Ожидаем: все тесты зелёные (сейчас 55 тестов). Клиент не тронут в части логики — сервер не меняли, тесты должны пройти.

- [ ] **Step 6: Коммит**

```bash
git add public/js/app.js
git commit -m "feat(rows): cache maxRow per cell from inventory response"
```

---

## Task 2: UI — oninput на поле рядов и метод `onRowsInput`

**Files:**
- Modify: `public/js/app.js:695-697` (шаблон), добавить метод после строки ~1513

- [ ] **Step 1: Изменить шаблон поля рядов**

В `public/js/app.js` строки 695-697 выглядят так:
```js
          : (this.measureMode === 'rows_bushes' || this.measureMode === 'rows_only' || this.measureMode === 'hectares')
            ? `<div class="form-group"><label>Ряды (например: 1-5, 9, 11 или 1-5.9.11):</label><input type="text" id="i2-rows" inputmode="numeric">${this.measureMode === 'hectares' ? '<div class="measure-hint">Гектары посчитаются автоматически из выбранных рядов и площади клетки.</div>' : ''}</div>`
          : '<div class="form-group"><label>Ряды (например: 1-5, 9, 11 или 1-5.9.11):</label><input type="text" id="i2-rows" inputmode="numeric"></div>'
```

Заменить только строки 695-697 (весь этот кусок) на:
```js
          : (this.measureMode === 'rows_bushes' || this.measureMode === 'rows_only' || this.measureMode === 'hectares')
            ? `<div class="form-group"><label>Ряды (например: 1-5, 9, 11 или 1-5.9.11):</label><input type="text" id="i2-rows" inputmode="numeric"${this.measureMode !== 'hectares' ? ' oninput="app.onRowsInput()"' : ''}>${this.measureMode === 'hectares' ? '<div class="measure-hint">Гектары посчитаются автоматически из выбранных рядов и площади клетки.</div>' : '<div id="i2-rows-warn" class="rows-warn"></div>'}</div>`
          : '<div class="form-group"><label>Ряды (например: 1-5, 9, 11 или 1-5.9.11):</label><input type="text" id="i2-rows" inputmode="numeric"></div>'
```

Что изменилось:
- Для `rows_bushes`/`rows_only`: добавлен `oninput="app.onRowsInput()"` на input и `<div id="i2-rows-warn" class="rows-warn"></div>` вместо пустой строки
- Для `hectares`: input и measure-hint остаются без изменений (нет oninput, нет warn-div)
- Строка 697 (fallback для других режимов) не меняется

- [ ] **Step 2: Добавить метод `onRowsInput()`**

В `public/js/app.js` после строки 1513 (конец `onI2CellChange`) вставить новый метод:

```js

  onRowsInput() {
    const warn = document.getElementById('i2-rows-warn');
    if (!warn) return;
    const maxRow = this.ctxCellMaxRow;
    if (!maxRow) { warn.textContent = ''; return; }

    const val = (document.getElementById('i2-rows')?.value || '').trim();
    if (!val) { warn.textContent = ''; return; }

    const nums = [];
    for (const part of val.split(/[,.;\s]+/).filter(Boolean)) {
      const range = part.match(/^(\d+)-(\d+)$/);
      if (range) {
        for (let i = +range[1]; i <= +range[2]; i++) nums.push(i);
      } else if (/^\d+$/.test(part)) {
        nums.push(+part);
      }
    }

    const phantoms = [...new Set(nums.filter(n => n > maxRow))].sort((a, b) => a - b);
    if (phantoms.length) {
      warn.textContent = `⚠️ Ряды ${phantoms.join(', ')} — нет в инвентаре клетки (всего ${maxRow}). Возможно, опечатка?`;
    } else {
      warn.textContent = '';
    }
  }
```

- [ ] **Step 3: Ручная проверка в браузере**

Запустить сервер локально:
```bash
cd C:/Users/service/Documents/Projects/помощник-бригадира-демо
node server/server.js
```

Открыть http://localhost:3001 (или порт из `.env`), войти в демо.

Проверить:
1. Режим `rows_bushes` или `rows_only` → выбрать квартал Виноград / кв1 / кл1 (7 рядов)
2. Ввести `8` → появляется предупреждение `⚠️ Ряды 8 — нет в инвентаре клетки (всего 7). Возможно, опечатка?`
3. Изменить на `1-5` → предупреждение исчезает
4. Ввести `1-5, 9` → предупреждение для ряда 9
5. Ввести `1-5, 9, 10` → предупреждение для рядов 9, 10
6. Нажать «Добавить» при предупреждении — запись всё равно сохраняется (не блокирует)
7. Переключить на режим `hectares` → warn-div и oninput отсутствуют
8. Переключить на `hours` → нет поля рядов, нет warn

- [ ] **Step 4: Коммит**

```bash
git add public/js/app.js
git commit -m "feat(rows): inline phantom-row warning on input (rows_bushes/rows_only)"
```

---

## Task 3: CSS и бамп SW-кеша

**Files:**
- Modify: `public/styles.css:1051` (после `.measure-hint`)
- Modify: `public/service-worker.js:1` (бамп CACHE_NAME)

- [ ] **Step 1: Добавить `.rows-warn` в styles.css**

В `public/styles.css` строки 1043-1051 — блок `.measure-hint`:
```css
.measure-hint {
  font-size: 0.82rem;
  color: #777;
  background: #f5f5f5;
  padding: 6px 8px;
  border-radius: 6px;
  margin: 6px 0;
  line-height: 1.4;
}
```

После этого блока (строка 1051, перед пустой строкой и комментарием `/* Модалка...*/`) вставить:

```css

.rows-warn {
  color: #b45309;
  font-size: 0.85em;
  margin-top: 4px;
  min-height: 1.2em;
}
```

`min-height: 1.2em` предотвращает «прыжок» формы когда warn появляется/исчезает.

- [ ] **Step 2: Бамп CACHE_NAME в service-worker.js**

В `public/service-worker.js` строка 1:
```js
const CACHE_NAME = 'brigade-v22';
```

Заменить на:
```js
const CACHE_NAME = 'brigade-v23';
```

- [ ] **Step 3: Финальная ручная проверка стилей**

Открыть http://localhost:3001, убедиться:
1. Предупреждение при вводе отображается янтарным цветом (не красным, не серым)
2. При пустом warn-div форма не «прыгает» (min-height держит место)
3. Текст читаем, размер шрифта уменьшен относительно основного текста

- [ ] **Step 4: Запустить серверные тесты последний раз**

```bash
npm test
```

Ожидаем: все тесты зелёные (55/55).

- [ ] **Step 5: Коммит**

```bash
git add public/styles.css public/service-worker.js
git commit -m "feat(rows): styles for rows-warn, bump SW cache to v23"
```

---

## После реализации

Задеплоить демо-контур:
```bash
# из worktree помощник-бригадира-демо
git push demo demo-five-modes
# на VPS: pm2 restart pomoshnik-demo
```

Проверить на https://demo.smart-assistantai.ru через PWA.
