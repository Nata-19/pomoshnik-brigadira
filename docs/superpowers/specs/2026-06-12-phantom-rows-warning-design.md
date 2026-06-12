# Предупреждение о фантомных рядах — Design Spec

**Дата:** 2026-06-12  
**Ветка:** demo-five-modes  
**Статус:** approved

---

## Контекст

Бригадиры могут случайно ввести номер ряда больше, чем есть в инвентаре клетки (например, «8,9» когда клетка имеет только 7 рядов). Сервер (`getBushesCount` в `parser.js`) трактует такие ряды как «ряд существует физически, но не учтён в инвентаризации» — сохраняет запись, считает 0 кустов. Это корректное поведение по дизайну, но опечатки ничем не отлавливаются.

**Цель:** мягкое inline-предупреждение прямо при вводе, не блокирующее отправку.

---

## Scope

- Только демо-контур (`demo-five-modes`)
- Только режимы `rows_bushes` и `rows_only` (где вводятся номера рядов)
- Только клиентская сторона — сервер не трогаем, новых API нет

---

## Архитектура

Чисто клиентская: расширяем кеш инвентаря в `app.js`, добавляем `oninput`-обработчик и CSS-класс. Данные уже есть в ответе `/api/inventory/:estate/:quarter`, который `loadCells()` получает — просто не кешировал максимальный ряд.

---

## Изменяемые файлы

| Файл | Что меняем |
|---|---|
| `public/js/app.js` | `loadCells` (кеш maxRow), `onI2CellChange` (сохранить ctxCellMaxRow), шаблон поля рядов (oninput + warn-div), новый метод `onRowsInput` |
| `public/css/styles.css` | новый класс `.rows-warn` |
| `public/service-worker.js` | бамп `CACHE_NAME` (правим JS+CSS клиента) |

Сервер: **не трогаем**.

---

## Слой данных

### Новое поле кеша

```js
this.cellMaxRow = {};  // ключ: "estate|quarter|cell" → number
```

Инициализируется рядом с `this.cellsByQuarter = {}`.

### Расширение `loadCells(quarterId)`

После `const cells = Object.keys(data.cells || {})...` добавить:

```js
for (const [cell, cellData] of Object.entries(data.cells || {})) {
  const rows = Array.isArray(cellData) ? cellData : (cellData.rows || []);
  if (rows.length) {
    this.cellMaxRow[this.estate + '|' + quarterId + '|' + cell] =
      Math.max(...rows.map(r => typeof r === 'object' ? r.row : r));
  }
}
```

Поддерживает оба формата cellData (старый массив и новый `{hectares, rows:[...]}`).

### Расширение `onI2CellChange()`

```js
this.ctxCellMaxRow = this.cellMaxRow[this.estate + '|' + this.ctxQuarter + '|' + this.ctxCell] ?? null;
```

`null` означает «данных нет — предупреждение не показываем».

---

## UI-слой

### Шаблон поля рядов

Добавить `oninput` и warn-div (только для `rows_bushes` / `rows_only`):

```html
<input type="text" id="i2-rows" inputmode="numeric" oninput="app.onRowsInput()">
...
<div id="i2-rows-warn" class="rows-warn"></div>
```

### Метод `onRowsInput()`

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

**Поведение парсера в `onRowsInput`:**
- Разбивает по `/[,.;\s]+/` (запятая, точка, точка с запятой, пробел)
- Поддерживает диапазоны `N-M`
- Невалидные токены (буквы, пустые части) — игнорирует (не бросает исключений)
- Дубликаты убираются через `Set`

**Важно:** `onRowsInput` не блокирует отправку — только показывает/скрывает текст.

При смене клетки `ctxCellMaxRow` обновляется, warn очистится автоматически при следующем вводе.

---

## CSS

```css
.rows-warn {
  color: #b45309;
  font-size: 0.85em;
  margin-top: 4px;
  min-height: 1.2em;
}
```

`min-height` предотвращает «прыжок» формы при появлении/исчезновении предупреждения.

---

## SW-кеш

При правке `app.js` и `styles.css` обязательно бампить `CACHE_NAME` в `service-worker.js` (сейчас `brigade-v22` → `brigade-v23`).

---

## Тестирование (вручную)

1. Войти в демо, выбрать режим `rows_bushes` или `rows_only`
2. Выбрать квартал и клетку (например, Виноград / кв1 / кл1 — 7 рядов)
3. В поле «Ряды» ввести `8` → появляется предупреждение
4. Изменить на `1-5` → предупреждение исчезает
5. Ввести `1-5, 9` → предупреждение для ряда 9
6. Нажать «Добавить» — запись сохраняется несмотря на предупреждение (не блокирует)
7. Переключить на режим `hours` — предупреждения нет (поле рядов отсутствует)
8. Установить как PWA и проверить что кеш обновился (новая версия SW)
