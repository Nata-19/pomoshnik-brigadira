# Demo Helper — Implementation Plan (Phase 2: Этапы 3-4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Закрыть два пункта спеки. (1) Журнал записей в новом формате «дата → вид работ → клетка → работники столбиком» — сначала катим в **боевой** отдельной веткой и наблюдаем, потом то же поведение получает демо как побочный эффект общего кода фронта. (2) В демо появляются 5 единиц подсчёта вместо 3, при смене вида работ режим выбирается автоматически из `default_measure_mode`, в подписях «куст / дерево / растений» появляется правильное слово в зависимости от единицы квартала, под плашкой режимов — мягкая ссылка на телефон Натали для других единиц.

**Architecture:** Обе части — один и тот же код, разное поведение по `DEMO_MODE` и по конфигу. Серверная валидация POST `/api/logs` начинает читать список допустимых режимов из `MEASURE_MODES` в `server/config.js` (там уже 5 для демо и 11 для прода). `GET /api/work-types` начинает отдавать `default_measure_mode` (колонка уже добавлена миграцией Фазы 1, поле просто не возвращалось наружу). Фронт читает `measureModes` из `/api/config` и рисует столько кнопок режимов сколько пришло. Терминология «кустов/деревьев/растений» строится из `quarter.unit`, который уже хранится в `demo_quarters` для демо; для прода в `inventory.json` поля `unit` нет, и фронт остаётся на старом слове «кустов» (fallback). Гектары и километры — две новые числовые колонки в `work_logs`, аналогично уже существующему `hours`.

**Tech Stack:** Node.js (Express), PostgreSQL (Neon, `pg`), vanilla JS PWA. **Без новых runtime-зависимостей.** Тесты — ручной smoke через браузер локально + проверка POST через curl/PowerShell где есть числовая логика.

**Reference spec:** `docs/superpowers/specs/2026-05-23-demo-helper-design.md` (разделы «Режим "Как считать" — 5 единиц в демо», «Дефолтный режим у каждого вида работ», «Журнал в новом формате»)

**Phase scope:** Этапы 3 и 4 из спеки. Этап 5 (механизированные работы — отдельная плашка, диапазон клеток, шаг) и далее — Фаза 3, после ответа мужа Натали по UX.

**Phase exit criteria** (что должно работать после Фазы 2):

- **Этап 4 в боевом проде** (промежуточная сверка перед Этапом 3):
  - Журнал на вкладке «Журнал» и список записей на вкладке «Ввод данных» отображаются группами: первая строка «<Вид работ> — Кв.X, кл.Y», ниже — столбиком работники с цифрами «Иванов — 5 рядов, 685 кустов».
  - Сортировка групп: по виду работ алфавитно, внутри — по кварталу/клетке.
  - Если записи нет — текст «Записей пока нет.» как сейчас.
  - Live-проверка на боевом сайте `pomoshnik-brigadira.onrender.com`: журнал старых записей Натали не сломан, новый формат работает.

- **Этап 3 в демо** (после того как Этап 4 пожил неделю в проде без багов):
  - В демо-режиме плашка «Как считать» содержит **5 кнопок**: «Ряды + кусты/деревья», «Только ряды», «Часы», «Гектары», «Километры». В боевом — остаются прежние 3.
  - Подпись на кнопке режима «Ряды + кусты», «Ряды + деревья» или «Ряды + растений» — зависит от единицы текущего квартала.
  - При выборе вида работ в селекте «Вид работ» — режим автоматически переключается на `default_measure_mode` этого вида (например, выбрал «Опрыскивание» → режим стал «Гектары»). Бригадир может вручную переключить.
  - В режиме «Гектары» появляется числовое поле «Гектары:», в режиме «Километры» — «Километры:».
  - В журнале и в списке записей вместо «685 кустов» отображается «685 кустов/деревьев/растений» по единице квартала.
  - Под плашкой режимов — серая строка «❓ Нужны другие единицы (тонны, столбы, погонные метры, комбинированные)? Настраивается под предприятие — звоните Натали +79783116389».
  - Smoke-сценарий: посетитель «яблоня» → видит «дерево», добавляет запись «Обрезка» (rows_bushes автоматом), затем «Опрыскивание» (hectares автоматом, вводит 5) — обе появляются в журнале в новом формате с правильной терминологией.

---

## File Structure

**Создаём:**
- Нет новых файлов.

**Модифицируем:**
- `public/js/app.js` — `renderEntriesHtml()`, `loadLogs()` (новая группировка); `renderInput()` (рендер кнопок режимов из конфига, подпись режима по единице, поля hectares/kilometers, мягкая ссылка); `onI2WorkTypeChange()` (автоподстановка дефолтного режима); `loadWorkTypes()` (читать `default_measure_mode`); `loadQuarters()` (читать `unit`); `addEntry()` (передавать hectares/kilometers); `getUnitLabel()` (новый helper); `groupLogsForDisplay()` (новый helper).
- `server/server.js` — миграция: новые колонки `hectares NUMERIC(8,2)` и `kilometers NUMERIC(8,2)` в `work_logs`; `GET /api/work-types` возвращает `default_measure_mode`; `POST /api/work-types` принимает опциональный `default_measure_mode`; `POST /api/logs` принимает `hectares`/`kilometers`, валидирует `measure_mode` через `MEASURE_MODES` из конфига; `GET /api/logs` отдаёт новые колонки в SELECT.
- `public/styles.css` — мелкие стили для нового формата журнала (заголовок группы, столбик работников) и серой мягкой ссылки.

**Не трогаем:**
- `server/parser.js` — `getBushesCount` остаётся как есть (для режима `rows_bushes` логика не меняется, термин «кусты» — это просто подпись в UI).
- `server/demo.js` — seed данные уже корректны (Phase 1).
- Аутентификация, `inventory.json`, миграции прежних колонок.

---

## Part A — Этап 4: Журнал в новом формате (БОЕВОЕ первым)

**Branch:** создаётся новая ветка `journal-format` из `main`. После мержа этой части — пауза, наблюдение боевого сайта, потом отдельная ветка для Part B.

### Task A.1: Helper `groupLogsForDisplay()` — группировка плоского списка

**Files:**
- Modify: `public/js/app.js` — добавить метод в класс `BrigadeAssistant` рядом с другими helpers (после `selectedName()` около строки 541).

- [ ] **Step 1: Создать новую ветку из main**

```bash
git checkout main
git pull
git checkout -b journal-format
```

- [ ] **Step 2: Добавить метод `groupLogsForDisplay` в `public/js/app.js`**

Найди строку 561 (конец метода `renderRosterHtml`) и сразу после её закрывающей `}` вставь новый метод:

```js
  // Группирует плоский массив log-записей в структуру для отображения:
  // [ { work_type, quarter, cell, workers: [{ employee, measure_mode, rows, bushes, hours, hectares, kilometers, id }] }, ... ]
  // Сортировка: вид работ алфавитно, внутри — квартал, клетка.
  // Пустые quarter/cell (часовые/механизированные без клетки) попадают в свою группу.
  groupLogsForDisplay(logs) {
    if (!logs || logs.length === 0) return [];
    const groups = new Map();
    for (const log of logs) {
      const wt = log.work_type || '';
      const q = log.quarter || '';
      const c = log.cell || '';
      const key = `${wt}||${q}||${c}`;
      if (!groups.has(key)) {
        groups.set(key, { work_type: wt, quarter: q, cell: c, workers: [] });
      }
      groups.get(key).workers.push(log);
    }
    const arr = Array.from(groups.values());
    arr.sort((a, b) => {
      const byWt = (a.work_type || '').localeCompare(b.work_type || '', 'ru');
      if (byWt !== 0) return byWt;
      const aq = Number(a.quarter) || 0;
      const bq = Number(b.quarter) || 0;
      if (aq !== bq) return aq - bq;
      const ac = Number(a.cell) || 0;
      const bc = Number(b.cell) || 0;
      return ac - bc;
    });
    return arr;
  }
```

- [ ] **Step 3: Быстрая ручная проверка в DevTools**

Открой `public/index.html` в браузере (можно через `file://` — для проверки чистой функции сервер не нужен). В консоли:

```js
const a = new BrigadeAssistant();
console.log(a.groupLogsForDisplay([
  { id:1, work_type:'Обрезка', quarter:'1', cell:'1', employee:'Иванов', rows:'1,2,3,4,5', bushes:685, measure_mode:'rows_bushes' },
  { id:2, work_type:'Обрезка', quarter:'1', cell:'1', employee:'Петров', rows:'1,2,3,4', bushes:555, measure_mode:'rows_bushes' },
  { id:3, work_type:'Обрезка', quarter:'1', cell:'2', employee:'Сидоров', rows:'1,2,3', bushes:410, measure_mode:'rows_bushes' },
]));
```

Ожидаемое: массив из 2 групп. Первая — «Обрезка / 1 / 1» с двумя рабочими (Иванов, Петров). Вторая — «Обрезка / 1 / 2» с одним (Сидоров).

Если что-то иначе — дебажить в этой же консоли, не коммитить.

- [ ] **Step 4: Commit**

```bash
git add public/js/app.js
git commit -m "ui(journal): helper groupLogsForDisplay для новой группировки"
```

---

### Task A.2: Helper `renderLogGroupsHtml()` — общий HTML обоих списков

**Files:**
- Modify: `public/js/app.js` — добавить метод после `groupLogsForDisplay` из Task A.1.

- [ ] **Step 1: Добавить `renderLogGroupsHtml(groups, deleteFnName)` в `public/js/app.js`**

Сразу после метода `groupLogsForDisplay` (его закрывающая `}`) вставь:

```js
  // Рисует список групп записей в новом формате.
  // deleteFnName — строка с именем метода удаления ('deleteEntry' на input-tab, 'deleteLog' на journal-tab).
  // Возвращает готовый HTML строкой.
  renderLogGroupsHtml(groups, deleteFnName) {
    if (!groups || groups.length === 0) {
      return '<p class="chips-empty">Записей пока нет.</p>';
    }
    return groups.map(g => {
      const place = (g.quarter || g.cell)
        ? `Кв.${this.escapeHtml(g.quarter)}${g.cell ? ', клет.' + this.escapeHtml(g.cell) : ''}`
        : '';
      const head = `<div class="log-group-head">${this.escapeHtml(g.work_type || '—')}${place ? ' · ' + place : ''}</div>`;
      const rows = g.workers.map(w => {
        let measure;
        if (w.measure_mode === 'hours') {
          measure = `${w.hours} часов`;
        } else if (w.measure_mode === 'hectares') {
          measure = `${w.hectares != null ? w.hectares : 0} гектаров`;
        } else if (w.measure_mode === 'kilometers') {
          measure = `${w.kilometers != null ? w.kilometers : 0} км`;
        } else {
          const rowCount = String(w.rows || '').split(',').filter(x => x.trim()).length;
          measure = `${rowCount} рядов`;
          if (w.measure_mode === 'rows_bushes') {
            const label = this.getUnitLabel(w);
            measure += `, ${w.bushes} ${label}`;
          }
        }
        return `
          <div class="log-worker-row">
            <span class="log-worker-name">${this.escapeHtml(w.employee)} — ${measure}</span>
            <button class="delete-btn-mini" onclick="app.${deleteFnName}(${w.id})">✕</button>
          </div>
        `;
      }).join('');
      return `<div class="log-group">${head}${rows}</div>`;
    }).join('');
  }
```

- [ ] **Step 2: Добавить заглушку `getUnitLabel(w)` — пока всегда возвращает «кустов»**

Сразу после `renderLogGroupsHtml` (его закрывающая `}`) вставь:

```js
  // Подпись единицы для конкретной записи. Этап А — пока всегда «кустов».
  // В Task B.8 будет читать unit из quarter и возвращать «кустов»/«деревьев»/«растений».
  getUnitLabel(log) {
    return 'кустов';
  }
```

- [ ] **Step 3: Commit**

```bash
git add public/js/app.js
git commit -m "ui(journal): helper renderLogGroupsHtml + заглушка getUnitLabel"
```

---

### Task A.3: Перевести `renderEntriesHtml()` на новые helpers

**Files:**
- Modify: `public/js/app.js` строки 563-590 — заменить тело метода `renderEntriesHtml`.

- [ ] **Step 1: Открыть `public/js/app.js`, найти метод `renderEntriesHtml`**

Это метод класса `BrigadeAssistant`, начинается с комментария `// HTML карточек записей за выбранную дату.` около строки 563.

- [ ] **Step 2: Заменить весь метод**

Полностью заменить с `// HTML карточек записей за выбранную дату.` до закрывающей `}` метода (включительно) на:

```js
  // HTML карточек записей за выбранную дату — новый формат: группами вид работ + клетка, работники столбиком.
  renderEntriesHtml() {
    const groups = this.groupLogsForDisplay(this.entries || []);
    return this.renderLogGroupsHtml(groups, 'deleteEntry');
  }
```

- [ ] **Step 3: Ручная проверка**

Локально запусти боевой режим (БЕЗ DEMO_MODE):

```powershell
$env:DEMO_MODE=$null
node server/server.js
```

В другом окне браузер → `http://localhost:3000` → войди (если не залогинен — заведи временного пользователя через /setup, если нужно). На вкладке «Ввод данных» добавь 2-3 записи в одну клетку разными сотрудниками. Проверь:
- Записи отображаются ГРУППОЙ: один заголовок «Обрезка · Кв.1, клет.1», ниже столбиком «Иванов — 5 рядов, 685 кустов» с кнопкой «✕» справа на каждой строке.
- Кнопка «✕» удаляет ту самую запись и список обновляется без перезагрузки страницы.

Если что-то не так — дебажить, не коммитить.

- [ ] **Step 4: Commit**

```bash
git add public/js/app.js
git commit -m "ui(journal): renderEntriesHtml через новый формат группировки"
```

---

### Task A.4: Перевести `loadLogs()` на новые helpers

**Files:**
- Modify: `public/js/app.js` строки 809-861 — заменить тело метода `loadLogs`.

- [ ] **Step 1: Открыть `public/js/app.js`, найти метод `loadLogs`**

Это метод класса `BrigadeAssistant`, начинается с `async loadLogs() {` около строки 809.

- [ ] **Step 2: Заменить только блок отображения**

В методе `loadLogs` найди фрагмент, начинающийся с `// Сортируем по кварталу/клетке/сотруднику для удобства` (около строки 832) и заканчивающийся на закрывающую `}` тела `try` (около строки 857), и замени на:

```js
      const groups = this.groupLogsForDisplay(data.logs);
      list.innerHTML = this.renderLogGroupsHtml(groups, 'deleteLog');
```

Финальный вид метода — `try` блок выглядит так:

```js
    try {
      const r = await fetch('/api/logs?date=' + encodeURIComponent(date) + '&estate=' + encodeURIComponent(this.estate));
      const data = await r.json();
      if (!r.ok) {
        list.innerHTML = '<p style="color:#c0392b;padding:10px;">❌ ' + (data.error || 'Ошибка') + '</p>';
        return;
      }
      if (!data.logs || data.logs.length === 0) {
        list.innerHTML = '<p style="color:#888;padding:10px;">За эту дату записей нет.</p>';
        return;
      }
      const groups = this.groupLogsForDisplay(data.logs);
      list.innerHTML = this.renderLogGroupsHtml(groups, 'deleteLog');
    } catch (e) {
      list.innerHTML = '<p style="color:#c0392b;padding:10px;">❌ ' + e.message + '</p>';
    }
```

- [ ] **Step 3: Ручная проверка**

Локально на той же дате (продолжая Task A.3): открой вкладку «Журнал», выбери ту же дату. Записи должны быть в том же новом групповом формате что и на «Ввод данных».

Открой Журнал на дате, где записей нет — «За эту дату записей нет.» (текст из старого кода).

- [ ] **Step 4: Commit**

```bash
git add public/js/app.js
git commit -m "ui(journal): loadLogs через новый формат группировки"
```

---

### Task A.5: CSS для новой структуры

**Files:**
- Modify: `public/styles.css` — добавить блок в конец файла.

- [ ] **Step 1: Открыть `public/styles.css`**

Добавь в самый конец файла:

```css
/* === Журнал: групповой формат (Этап 4) === */
.log-group {
  margin: 8px 0;
  padding: 8px 10px;
  background: #fafafa;
  border: 1px solid #eee;
  border-radius: 8px;
}
.log-group-head {
  font-weight: 600;
  color: #2c3e50;
  margin-bottom: 4px;
  font-size: 0.95rem;
}
.log-worker-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 3px 0;
  border-top: 1px dashed #e6e6e6;
}
.log-worker-row:first-of-type { border-top: none; }
.log-worker-name {
  flex: 1;
  font-size: 0.92rem;
  color: #333;
}
.delete-btn-mini {
  padding: 2px 8px;
  font-size: 0.85rem;
  background: #fff;
  border: 1px solid #ddd;
  color: #c0392b;
  border-radius: 4px;
  cursor: pointer;
}
.delete-btn-mini:hover {
  background: #fff5f5;
  border-color: #c0392b;
}
```

- [ ] **Step 2: Визуальная проверка**

Перезагрузи страницу `localhost:3000` — записи в групповом формате должны быть в светло-серых блоках с заголовком жирным и работниками строкой ниже. Кнопка «✕» — справа, мелкая, красным.

Если стили съехали — поправить инлайн.

- [ ] **Step 3: Commit**

```bash
git add public/styles.css
git commit -m "ui(journal): стили для группового формата"
```

---

### Task A.6: Push, PR, merge — БОЕВОЙ деплой

- [ ] **Step 1: Финальная локальная проверка боевого**

В боевом режиме (DEMO_MODE не выставлен) полный регрешн-чек:
- Старые записи Натали (если есть, можно проверить через её Neon-БД с осторожностью или просто после деплоя) отображаются.
- Удаление работает в обоих местах.
- Часовые записи (без клетки) образуют свою группу «Полив · » (без `Кв.X`).

- [ ] **Step 2: Push ветки**

```bash
git push -u origin journal-format
```

- [ ] **Step 3: PR через GitHub UI**

Натали открывает `https://github.com/Nata-19/pomoshnik-brigadira/pulls`, создаёт PR `journal-format` → `main`. Title: `feat(journal): группировка записей по виду работ и клетке`. Тело:

```
## Что меняется
- Журнал записей и список на «Ввод данных» отображаются группами «вид работ · клетка → работники столбиком» с цифрами рядом.
- Стили блоков групп и мини-кнопок удаления.

## Что не меняется
- Бэкенд (`/api/logs`, `/api/work-types`) — без изменений.
- Демо — тоже получит этот же формат побочно (общий код).

## План
- Этап 4 спеки. Первым в боевом, чтобы не привезти баг из демо.
- После наблюдения 3-7 дней — начинаем Part B (Этап 3) на отдельной ветке.
```

- [ ] **Step 4: Merge PR в main**

После прохождения CI (если есть) — Натали нажимает «Merge pull request». Render auto-deploy подхватит из main.

- [ ] **Step 5: Smoke-проверка боевого сайта**

Через 1-2 минуты после мержа открыть `https://pomoshnik-brigadira.onrender.com`, войти, проверить:
- Журнал старых записей виден в новом формате.
- Добавить новую запись и убедиться, что она появляется правильно.
- Удалить тестовую запись.

Если что-то сломано — откатить через `git revert <merge-commit>` + push в main. Откат **до** Part B критически важен, иначе путаница между двумя ветками.

- [ ] **Step 6: Пауза наблюдения**

После успешного деплоя — **остановиться**. Не начинать Part B. Дождаться 3-7 дней нормальной работы Натали с боевым в новом формате. Если найдутся баги — фиксы делать сразу в `main` отдельными коммитами. Только после спокойной недели — start Part B.

---

## Part B — Этап 3: 5 режимов + терминология + дефолт по виду работ (демо-фокус)

**Branch:** новая ветка `demo-five-modes` из обновлённого `main` (после Part A смержен и пожил).

Все backend-изменения этой части построены так, чтобы **в боевом ничего не поменялось внешне** — прод фронт всё ещё рендерит 3 кнопки режима из `MEASURE_MODES_FULL` (потому что фронт уже сейчас отображает кнопки статично; мы переключим прод на «читать из конфига» осторожно с пометкой).

### Task B.1: Миграция — `hectares` и `kilometers` колонки в `work_logs`

**Files:**
- Modify: `server/server.js` — секция миграций (между строкой 191 и началом первых SELECT в маршрутах). Найти существующий блок `ALTER TABLE work_logs ADD COLUMN IF NOT EXISTS hours INTEGER` (около строки 125), добавить рядом аналогичные блоки.

- [ ] **Step 1: Создать ветку из main**

```bash
git checkout main
git pull
git checkout -b demo-five-modes
```

- [ ] **Step 2: Открыть `server/server.js`, найти миграцию `hours`**

Около строки 125 есть:

```js
await pool.query(`ALTER TABLE work_logs ADD COLUMN IF NOT EXISTS hours INTEGER`);
```

- [ ] **Step 3: Добавить две новые миграции сразу после строки с `hours`**

После этой строки вставь:

```js
await pool.query(`ALTER TABLE work_logs ADD COLUMN IF NOT EXISTS hectares NUMERIC(8,2)`);
await pool.query(`ALTER TABLE work_logs ADD COLUMN IF NOT EXISTS kilometers NUMERIC(8,2)`);
```

- [ ] **Step 4: Запустить сервер и проверить миграцию**

```powershell
$env:DEMO_MODE='true'
$env:DATABASE_URL=(Get-Content .env.local | Where-Object { $_ -match 'DATABASE_URL=' }) -replace '^DATABASE_URL=', ''
$env:JWT_SECRET='dev-secret-for-local-only'
$env:COOKIE_SECRET='dev-cookie-secret'
node server/server.js
```

В логах должно быть `✅ Миграции БД успешно завершены`. Ошибок про hectares/kilometers быть не должно. Сервер можно остановить (`Ctrl+C`).

Если сервер уже работает в фоне — рестарт.

- [ ] **Step 5: Commit**

```bash
git add server/server.js
git commit -m "db: hectares и kilometers колонки в work_logs"
```

---

### Task B.2: `GET /api/work-types` возвращает `default_measure_mode`

**Files:**
- Modify: `server/server.js` строка ~780 — endpoint `GET /api/work-types`.

- [ ] **Step 1: Открыть `server/server.js`, найти GET endpoint**

Около строки 780:

```js
app.get('/api/work-types', authOrDemo, async (req, res) => {
  try {
    let r;
    if (DEMO_MODE) {
      r = await pool.query('SELECT id, name FROM work_types WHERE demo_session_id=$1 ORDER BY name', [req.demo_session_id]);
    } else {
      r = await pool.query('SELECT id, name FROM work_types ORDER BY name');
    }
    res.json({ work_types: r.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

- [ ] **Step 2: Добавить `default_measure_mode` и `kind` в оба SELECT**

Заменить две `pool.query` строки на:

```js
    if (DEMO_MODE) {
      r = await pool.query('SELECT id, name, default_measure_mode, kind FROM work_types WHERE demo_session_id=$1 ORDER BY name', [req.demo_session_id]);
    } else {
      r = await pool.query('SELECT id, name, default_measure_mode, kind FROM work_types ORDER BY name');
    }
```

(Колонка `kind` тоже добавлена миграцией Phase 1; пока мы её не используем во фронте, но пусть приедет — Этап 5 механизированных работ из Фазы 3 её попросит.)

- [ ] **Step 3: Проверить curl-ом**

Сервер локально (demo-режим):

```powershell
node server/server.js
```

В другом окне:

```powershell
$cookie = (Invoke-WebRequest http://localhost:3000/api/demo/session -Method Post -SessionVariable s).Headers
Invoke-WebRequest http://localhost:3000/api/work-types -WebSession $s | Select-Object -ExpandProperty Content
```

Ожидаемое: JSON с массивом, в каждом объекте поля `id, name, default_measure_mode, kind`. Например, `Обрезка → default_measure_mode='rows_bushes', kind='manual'`, `Опрыскивание → default_measure_mode='hectares', kind='mechanized'`.

- [ ] **Step 4: Commit**

```bash
git add server/server.js
git commit -m "api: /api/work-types отдаёт default_measure_mode и kind"
```

---

### Task B.3: `POST /api/work-types` опционально принимает `default_measure_mode`

**Files:**
- Modify: `server/server.js` ~794-832 — endpoint `POST /api/work-types`.

- [ ] **Step 1: Открыть `server/server.js`, найти POST endpoint**

Около строки 794 — `app.post('/api/work-types', authOrDemo, async (req, res) => {`.

- [ ] **Step 2: Заменить весь обработчик целиком**

С `app.post('/api/work-types'` до его закрывающей `});` — заменить на:

```js
app.post('/api/work-types', authOrDemo, async (req, res) => {
  try {
    const name = (req.body.name || '').trim();
    const mode = (req.body.default_measure_mode || '').trim() || 'rows_bushes';
    if (!name) {
      return res.status(400).json({ error: 'Укажи название вида работ' });
    }
    if (!MEASURE_MODES.includes(mode)) {
      return res.status(400).json({ error: 'Неизвестный режим подсчёта' });
    }
    if (DEMO_MODE) {
      const exists = await pool.query(
        'SELECT 1 FROM work_types WHERE demo_session_id = $1 AND LOWER(name) = LOWER($2)',
        [req.demo_session_id, name]
      );
      if (exists.rows.length > 0) {
        return res.status(400).json({ error: 'Такой вид работ уже есть' });
      }
      const ins = await pool.query(
        'INSERT INTO work_types (name, default_measure_mode, demo_session_id) VALUES ($1, $2, $3) RETURNING id, name, default_measure_mode, kind',
        [name, mode, req.demo_session_id]
      );
      return res.json({ work_type: ins.rows[0] });
    }
    const exists = await pool.query(
      'SELECT 1 FROM work_types WHERE LOWER(name) = LOWER($1)',
      [name]
    );
    if (exists.rows.length > 0) {
      return res.status(400).json({ error: 'Такой вид работ уже есть' });
    }
    const ins = await pool.query(
      'INSERT INTO work_types (name, default_measure_mode) VALUES ($1, $2) RETURNING id, name, default_measure_mode, kind',
      [name, mode]
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

- [ ] **Step 3: Убедиться, что `MEASURE_MODES` импортирован**

В верхней части `server/server.js` (около строки 6-15, где `require('./config')`) должен быть `MEASURE_MODES` в деструктуризации. Если нет — добавить:

```js
const { DEMO_MODE, BRAND_NAME, BRAND_LOGO, CONTACT_PHONE, MEASURE_MODES } = require('./config');
```

(Если `MEASURE_MODES` уже там — пропустить шаг.)

- [ ] **Step 4: Curl-проверка**

Сервер локально (demo):

```powershell
node server/server.js
```

```powershell
$cookie = (Invoke-WebRequest http://localhost:3000/api/demo/session -Method Post -SessionVariable s)
Invoke-WebRequest http://localhost:3000/api/work-types `
  -Method Post -ContentType 'application/json' `
  -Body '{"name":"Тестработа","default_measure_mode":"hectares"}' `
  -WebSession $s | Select-Object -ExpandProperty Content
```

Ожидаемое: `{"work_type":{"id":...,"name":"Тестработа","default_measure_mode":"hectares","kind":null}}`.

Затем попытка с битым режимом:

```powershell
Invoke-WebRequest http://localhost:3000/api/work-types `
  -Method Post -ContentType 'application/json' `
  -Body '{"name":"Test2","default_measure_mode":"unknown"}' `
  -WebSession $s
```

Ожидаемое: 400 «Неизвестный режим подсчёта».

- [ ] **Step 5: Commit**

```bash
git add server/server.js
git commit -m "api: POST /api/work-types принимает default_measure_mode"
```

---

### Task B.4: Валидация в `POST /api/logs` через `MEASURE_MODES`, поля hectares/kilometers

**Files:**
- Modify: `server/server.js` строки 936-1062 — endpoint `POST /api/logs`.

- [ ] **Step 1: Открыть `server/server.js`, найти валидацию measure_mode**

Около строки 962:

```js
if (!['rows_bushes', 'rows_only', 'hours'].includes(measure_mode)) {
  return res.status(400).json({ error: 'Неизвестный режим подсчёта' });
}
```

- [ ] **Step 2: Заменить на проверку по MEASURE_MODES**

```js
if (!MEASURE_MODES.includes(measure_mode)) {
  return res.status(400).json({ error: 'Неизвестный режим подсчёта' });
}
```

- [ ] **Step 3: Добавить разбор полей hectares и kilometers**

Найди блок после валидации `measure_mode`:

```js
    let rowsStr = '';
    let bushes = 0;
    let hoursVal = null;

    if (measure_mode === 'hours') {
      const h = parseInt(hours, 10);
      ...
```

Замени всю секцию вычисления значений (от `let rowsStr` до конца `else { ... if (measure_mode === 'rows_bushes') { ... } }`) на:

```js
    let rowsStr = '';
    let bushes = 0;
    let hoursVal = null;
    let hectaresVal = null;
    let kilometersVal = null;

    if (measure_mode === 'hours') {
      const h = parseInt(hours, 10);
      if (!Number.isInteger(h) || h <= 0) {
        return res.status(400).json({ error: 'Укажи часы числом' });
      }
      hoursVal = h;
    } else if (measure_mode === 'hectares') {
      const v = parseFloat(req.body.hectares);
      if (!isFinite(v) || v <= 0) {
        return res.status(400).json({ error: 'Укажи гектары числом' });
      }
      hectaresVal = v;
    } else if (measure_mode === 'kilometers') {
      const v = parseFloat(req.body.kilometers);
      if (!isFinite(v) || v <= 0) {
        return res.status(400).json({ error: 'Укажи километры числом' });
      }
      kilometersVal = v;
    } else {
      if (!quarter || !cell) {
        return res.status(400).json({ error: 'Выбери клетку' });
      }
      let rowNums;
      try {
        rowNums = parserToUse.parseRowList(rows);
      } catch (e) {
        return res.status(400).json({ error: e.message });
      }
      rowsStr = rowNums.join(',');
      if (measure_mode === 'rows_bushes') {
        try {
          bushes = parserToUse.getBushesCount(estate, String(quarter), String(cell), rowNums);
        } catch (e) {
          return res.status(400).json({ error: e.message });
        }
      }
    }
```

- [ ] **Step 4: Расширить INSERT — добавить hectares и kilometers**

Найди два INSERT в work_logs (один для demo-ветки, один для прода). Demo-ветка около строки 1018:

```js
      const ins = await pool.query(
        `INSERT INTO work_logs
          (date, estate_id, quarter, cell, employee, rows, bushes, brigadier_id, demo_session_id, work_type, measure_mode, hours)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING id`,
        [date, estate, quarter ? String(quarter) : '', cell ? String(cell) : '',
         employee.trim(), rowsStr, bushes, 0, req.demo_session_id,
         work_type.trim(), measure_mode, hoursVal]
      );
```

Замени на:

```js
      const ins = await pool.query(
        `INSERT INTO work_logs
          (date, estate_id, quarter, cell, employee, rows, bushes, brigadier_id, demo_session_id, work_type, measure_mode, hours, hectares, kilometers)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         RETURNING id`,
        [date, estate, quarter ? String(quarter) : '', cell ? String(cell) : '',
         employee.trim(), rowsStr, bushes, 0, req.demo_session_id,
         work_type.trim(), measure_mode, hoursVal, hectaresVal, kilometersVal]
      );
```

И аналогично прод-ветку (около строки 1048):

```js
    const ins = await pool.query(
      `INSERT INTO work_logs
        (date, estate_id, quarter, cell, employee, rows, bushes, brigadier_id, work_type, measure_mode, hours)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id`,
      [date, estate, quarter ? String(quarter) : '', cell ? String(cell) : '',
       employee.trim(), rowsStr, bushes, req.brigadier.id,
       work_type.trim(), measure_mode, hoursVal]
    );
```

Замени на:

```js
    const ins = await pool.query(
      `INSERT INTO work_logs
        (date, estate_id, quarter, cell, employee, rows, bushes, brigadier_id, work_type, measure_mode, hours, hectares, kilometers)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING id`,
      [date, estate, quarter ? String(quarter) : '', cell ? String(cell) : '',
       employee.trim(), rowsStr, bushes, req.brigadier.id,
       work_type.trim(), measure_mode, hoursVal, hectaresVal, kilometersVal]
    );
```

- [ ] **Step 5: Расширить SELECT в `GET /api/logs`**

Около строк 1080-1095 в `GET /api/logs` два SELECT возвращают:

```sql
SELECT id, date, estate_id, quarter, cell, employee, rows, bushes, work_type, measure_mode, hours, created_at
FROM work_logs ...
```

В обоих SELECT добавь `hectares, kilometers`:

```sql
SELECT id, date, estate_id, quarter, cell, employee, rows, bushes, work_type, measure_mode, hours, hectares, kilometers, created_at
FROM work_logs ...
```

(Аналогично если есть ещё SELECT в этом же endpoint — для `from..to` ветки.)

- [ ] **Step 6: Curl-проверка**

Демо-сессия:

```powershell
$s = $null
Invoke-WebRequest http://localhost:3000/api/demo/session -Method Post -SessionVariable s | Out-Null
Invoke-WebRequest http://localhost:3000/api/demo/culture -Method Post `
  -ContentType 'application/json' -Body '{"culture":"яблоня","unit":"tree"}' `
  -WebSession $s
```

Добавляем запись «Опрыскивание»:

```powershell
Invoke-WebRequest http://localhost:3000/api/logs -Method Post `
  -ContentType 'application/json' `
  -Body '{"date":"2026-05-25","estate":"demo","quarter":"1","cell":"","work_type":"Опрыскивание","measure_mode":"hectares","employee":"Иванов","hectares":5.5}' `
  -WebSession $s | Select-Object -ExpandProperty Content
```

Ожидаемое: `{"success":true,"id":...}`. Проверяем:

```powershell
Invoke-WebRequest 'http://localhost:3000/api/logs?date=2026-05-25&estate=demo' -WebSession $s | Select-Object -ExpandProperty Content
```

Ожидаемое: в массиве `logs` есть запись с `measure_mode:"hectares"`, `hectares:"5.50"`.

- [ ] **Step 7: Commit**

```bash
git add server/server.js
git commit -m "api: /api/logs принимает hectares/kilometers, валидация через MEASURE_MODES"
```

---

### Task B.5: Фронт — `loadQuarters()` сохраняет `unit`; `loadWorkTypes()` сохраняет `default_measure_mode`

**Files:**
- Modify: `public/js/app.js` — методы `loadQuarters` и `loadWorkTypes`.

- [ ] **Step 1: Найти `loadQuarters` в `app.js`**

Найди метод (поиск по `async loadQuarters`). Сейчас он загружает кварталы из `/api/quarters` или `/api/inventory`. В `this.quarters` приходят объекты с `id, name`.

- [ ] **Step 2: Изменить — сохранять `unit`**

Если код сейчас выглядит как:

```js
this.quarters = data.quarters || [];
```

Оставь как есть — API уже возвращает `unit` в демо (из `getDemoInventory`). Просто **убедись**, что объекты квартала имеют поле `unit`, и оно доезжает до `this.quarters`. Если сейчас фронт где-то делает `map(q => ({ id: q.id, name: q.name }))` — расширь до `map(q => ({ id: q.id, name: q.name, unit: q.unit }))`.

Сохрани файл.

- [ ] **Step 3: Найти `loadWorkTypes`**

Сейчас должно быть что-то вроде:

```js
async loadWorkTypes() {
  const r = await fetch('/api/work-types');
  const data = await r.json();
  this.workTypes = data.work_types || [];
}
```

- [ ] **Step 4: Убедиться что объекты сохраняют все поля**

`data.work_types` теперь содержит `id, name, default_measure_mode, kind` — после Task B.2. `this.workTypes = data.work_types || []` корректно сохранит всё. Если код делает `map`, оставлять `default_measure_mode` и `kind`.

- [ ] **Step 5: Проверить в DevTools**

Локально demo-сервер запущен, открыть `http://localhost:3000`, ввести культуру «яблоня». В DevTools консоли:

```js
app.workTypes
```

Ожидаемое: массив из 6 объектов с полями `id, name, default_measure_mode, kind`. `Обрезка → rows_bushes, manual`. `Опрыскивание → hectares, mechanized`.

```js
app.quarters
```

Ожидаемое: массив с `unit:'tree'` в каждом (для яблони).

- [ ] **Step 6: Commit**

(Если код менялся.)

```bash
git add public/js/app.js
git commit -m "ui: фронт сохраняет default_measure_mode и unit с бэка"
```

(Если код уже корректен — пропустить коммит.)

---

### Task B.6: Фронт — рендер кнопок режимов из конфига

**Files:**
- Modify: `public/js/app.js` — `loadConfig` (читать `measureModes`), `renderInput` (генерация кнопок).

- [ ] **Step 1: Найти `loadConfig` в `app.js` (около строки 95)**

Сейчас:

```js
async loadConfig() {
  try {
    const r = await fetch('/api/config');
    this.config = await r.json();
  } catch (e) {
    this.config = { demoMode: false, brandName: 'Помощьник Бригадира', brandLogo: '🍇' };
  }
}
```

Добавь fallback `measureModes`:

```js
async loadConfig() {
  try {
    const r = await fetch('/api/config');
    this.config = await r.json();
  } catch (e) {
    this.config = { demoMode: false, brandName: 'Помощьник Бригадира', brandLogo: '🍇', measureModes: ['rows_bushes', 'rows_only', 'hours'] };
  }
  if (!this.config.measureModes) {
    this.config.measureModes = ['rows_bushes', 'rows_only', 'hours'];
  }
}
```

- [ ] **Step 2: Добавить лейблы режимов как метод класса**

Прямо после метода `getUnitLabel` (из Task A.2), добавь:

```js
  // Подпись кнопки режима для текущего квартала.
  // Меняется только для rows_bushes — в зависимости от unit квартала.
  measureModeLabel(mode) {
    if (mode === 'rows_bushes') {
      const q = this.quarters.find(q => String(q.id) === String(this.ctxQuarter));
      const unit = q ? q.unit : null;
      if (unit === 'tree') return 'Ряды + деревья';
      if (unit === 'other') return 'Ряды + растения';
      return 'Ряды + кусты';
    }
    if (mode === 'rows_only') return 'Только ряды';
    if (mode === 'hours') return 'Только часы';
    if (mode === 'hectares') return 'Гектары';
    if (mode === 'kilometers') return 'Километры';
    return mode;
  }
```

- [ ] **Step 3: Заменить хардкод кнопок режимов в `renderInput`**

Найди строки 497-501 в `renderInput`:

```js
        <div class="block-label">Как считать:</div>
        <div class="mode-row">
          ${modeBtn('rows_bushes', 'Ряды + кусты')}
          ${modeBtn('rows_only', 'Только ряды')}
          ${modeBtn('hours', 'Только часы')}
        </div>
```

Заменить на:

```js
        <div class="block-label">Как считать:</div>
        <div class="mode-row">
          ${(this.config.measureModes || []).map(m => modeBtn(m, this.measureModeLabel(m))).join('')}
        </div>
        ${this.config.demoMode ? `
          <div class="measure-hint">
            ❓ Нужны другие единицы (тонны, столбы, погонные метры, комбинированные)?
            Настраивается под предприятие — звоните Натали ${this.escapeHtml(this.config.contactPhone || '+79783116389')}
          </div>
        ` : ''}
```

- [ ] **Step 4: Стиль для подсказки**

В конец `public/styles.css`:

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

- [ ] **Step 5: Проверка локально (демо)**

Перезагрузи фронт. На «Ввод данных» в плашке «Как считать» должно быть **5** кнопок: Ряды + деревья (для яблони) / Только ряды / Только часы / Гектары / Километры. Под ними — серая строка с телефоном Натали.

- [ ] **Step 6: Проверка локально (боевой)**

Перезапусти сервер с `$env:DEMO_MODE=$null`, открой `localhost:3000`. На «Ввод данных» — **11 кнопок** (по `MEASURE_MODES_FULL`). Подсказки с телефоном — нет.

Это потенциально неожиданное изменение в боевом UI — обсудим с Натали отдельно перед мержем (см. Task B.10). Пока что для прод-фронта мы оставим 3 режима через `/api/config`.

- [ ] **Step 7: Commit**

```bash
git add public/js/app.js public/styles.css
git commit -m "ui: рендер кнопок режимов из /api/config, мягкая ссылка в демо"
```

---

### Task B.7: Авто-подстановка режима при смене вида работ

**Files:**
- Modify: `public/js/app.js` — `onI2WorkTypeChange`.

- [ ] **Step 1: Найти `onI2WorkTypeChange` (около строки 622)**

```js
onI2WorkTypeChange() {
  this.ctxWorkType = document.getElementById('i2-worktype').value;
}
```

- [ ] **Step 2: Заменить на:**

```js
onI2WorkTypeChange() {
  this.ctxWorkType = document.getElementById('i2-worktype').value;
  // Автоподстановка дефолтного режима подсчёта, если он есть у выбранного вида работ.
  const wt = this.workTypes.find(w => w.name === this.ctxWorkType);
  if (wt && wt.default_measure_mode && (this.config.measureModes || []).includes(wt.default_measure_mode)) {
    this.measureMode = wt.default_measure_mode;
    this.renderInput();
  }
}
```

- [ ] **Step 3: Проверка**

В демо: на «Ввод данных» выбери в «Вид работ» — «Опрыскивание». Режим должен переключиться на «Гектары», поля формы — поменяться (см. Task B.8). Выбери «Обрезка» — переключение на «Ряды + деревья» (для яблони).

- [ ] **Step 4: Commit**

```bash
git add public/js/app.js
git commit -m "ui: автоподстановка measure_mode из default_measure_mode при смене вида работ"
```

---

### Task B.8: Фронт — поля для hectares/kilometers, отправка в POST

**Files:**
- Modify: `public/js/app.js` — `renderInput` (поле формы), `addEntry` (тело POST).

- [ ] **Step 1: Найти в `renderInput` блок с формой «Добавить запись» (около строки 522)**

```js
        ${this.measureMode === 'hours'
          ? '<div class="form-group"><label>Часы:</label><input type="number" id="i2-hours" min="1" inputmode="numeric"></div>'
          : '<div class="form-group"><label>Ряды (например: 1-5, 9, 11 или 1-5.9.11):</label><input type="text" id="i2-rows" inputmode="numeric"></div>'}
```

- [ ] **Step 2: Заменить на расширенный switch:**

```js
        ${
          this.measureMode === 'hours'
            ? '<div class="form-group"><label>Часы:</label><input type="number" id="i2-hours" min="1" inputmode="numeric"></div>'
          : this.measureMode === 'hectares'
            ? '<div class="form-group"><label>Гектары:</label><input type="number" id="i2-hectares" min="0.01" step="0.01" inputmode="decimal"></div>'
          : this.measureMode === 'kilometers'
            ? '<div class="form-group"><label>Километры:</label><input type="number" id="i2-kilometers" min="0.01" step="0.01" inputmode="decimal"></div>'
          : '<div class="form-group"><label>Ряды (например: 1-5, 9, 11 или 1-5.9.11):</label><input type="text" id="i2-rows" inputmode="numeric"></div>'
        }
```

- [ ] **Step 3: Найти `addEntry()` (около строки 750 — поиск по `async addEntry`)**

В сборке тела POST-запроса добавь hectares и kilometers:

Найти место где формируется тело:

```js
      const body = {
        date: this.inputDate,
        estate: this.estate,
        quarter: this.ctxQuarter,
        cell: this.ctxCell,
        work_type: this.ctxWorkType,
        measure_mode: this.measureMode,
        employee: selName,
        rows: this.measureMode === 'hours' ? null : (document.getElementById('i2-rows')?.value || ''),
        hours: this.measureMode === 'hours' ? Number(document.getElementById('i2-hours')?.value || 0) : null,
      };
```

(Точный текст найти в файле, может отличаться.) Заменить на:

```js
      const body = {
        date: this.inputDate,
        estate: this.estate,
        quarter: this.ctxQuarter,
        cell: this.ctxCell,
        work_type: this.ctxWorkType,
        measure_mode: this.measureMode,
        employee: selName,
        rows: ['hours','hectares','kilometers'].includes(this.measureMode) ? null : (document.getElementById('i2-rows')?.value || ''),
        hours: this.measureMode === 'hours' ? Number(document.getElementById('i2-hours')?.value || 0) : null,
        hectares: this.measureMode === 'hectares' ? Number(document.getElementById('i2-hectares')?.value || 0) : null,
        kilometers: this.measureMode === 'kilometers' ? Number(document.getElementById('i2-kilometers')?.value || 0) : null,
      };
```

Если оригинальное тело в коде выглядит иначе — адаптируй по факту: ключевая идея — добавить два поля hectares и kilometers, и расширить условие для rows.

- [ ] **Step 4: Если в `addEntry` есть валидация «нет квартала/клетки» — учесть hectares/kilometers**

В демо для механизированной работы клетка не обязательна (квартал — да). Найти валидацию в `addEntry` (обычно «выбери квартал»/«выбери клетку») и добавить ветвление: для `hectares`/`kilometers`/`hours` — клетка опциональна.

Пример:

```js
    if (!this.ctxQuarter && this.measureMode !== 'hours') {
      // hectares и kilometers тоже без квартала бессмысленны? — да, требуем
      // (per spec: «Куда привязывать перегон трактора (один квартал?...)» — пока пишем квартал)
      msg.textContent = '❌ Выбери квартал';
      return;
    }
    if (!this.ctxCell && !['hours','hectares','kilometers'].includes(this.measureMode)) {
      msg.textContent = '❌ Выбери клетку';
      return;
    }
```

(Точный текст подгоняем по существующей валидации.)

- [ ] **Step 5: Smoke-тест в браузере**

Демо локально, сессия с яблоней. Сценарий:
1. На «Ввод данных» выбери Кв.1, кл.1, «Обрезка». Режим должен сам стать «Ряды + деревья». Отметь Иванова (через roster), введи ряды `1-5`, нажми «Добавить». Запись должна появиться в группе «Обрезка · Кв.1, клет.1» с «Иванов — 5 рядов, 685 деревьев».
2. Смени вид работ на «Опрыскивание». Режим переключился на «Гектары». Поле «Ряды» исчезло, появилось «Гектары». Введи `5.5`, нажми «Добавить». Запись — в группе «Опрыскивание · Кв.1» (без клетки) с «Иванов — 5.5 гектаров».
3. Смени на «Перегон трактора». Режим — «Километры». Введи `120`. Запись — «120 км».
4. Открой Журнал — те же группы и форматирование.

- [ ] **Step 6: Commit**

```bash
git add public/js/app.js
git commit -m "ui: поля и отправка hectares/kilometers в форме ввода"
```

---

### Task B.9: Терминология в `getUnitLabel(log)` через `unit` квартала

**Files:**
- Modify: `public/js/app.js` — заменить заглушку `getUnitLabel` из Task A.2.

- [ ] **Step 1: Найти `getUnitLabel` (заглушку из Task A.2)**

```js
  getUnitLabel(log) {
    return 'кустов';
  }
```

- [ ] **Step 2: Заменить на:**

```js
  // Возвращает множественное «кустов»/«деревьев»/«растений» для подписи в журнале.
  // Ищем unit в кварталах текущего хозяйства; если квартал не найден (старая запись) — fallback «кустов».
  getUnitLabel(log) {
    const q = this.quarters.find(q => String(q.id) === String(log.quarter) || String(q.name).includes('.' + log.quarter));
    const unit = q ? q.unit : null;
    if (unit === 'tree') return 'деревьев';
    if (unit === 'other') return 'растений';
    return 'кустов';
  }
```

**Замечание для агента:** В демо `quarters` приходят с `id, name, unit`, где `name` — это «Кв.1»/«Кв.2», а `log.quarter` — это `'1'`/`'2'` (см. как seed-данные пишутся в `server/demo.js` строка 119). Поэтому сопоставление через `id` напрямую может не работать — мы сопоставляем по числовому ключу из `name`. Если есть гарантированный quarter_key — лучше через него. В нашем коде на фронте уже используется `q.id === this.ctxQuarter` для селектора (см. строку 482) — значит id уже строка/число совпадающее с quarter в логах. Проверь в DevTools, что `q.id` и `log.quarter` сравниваются нормально; если нет — поправь сравнение.

- [ ] **Step 3: Проверка в браузере**

В демо «яблоня»: записи «Обрезка» должны быть «N деревьев», а не «N кустов».

Создай новую демо-сессию (Начать сначала → культура «виноград»): записи должны быть «N кустов».

Создай ещё одну (культура «розы» → выбери «Другое»): записи должны быть «N растений».

- [ ] **Step 4: Commit**

```bash
git add public/js/app.js
git commit -m "ui: терминология кустов/деревьев/растений из unit квартала"
```

---

### Task B.10: Решить, оставлять ли 11 кнопок в боевом проде, или ограничить

**Файлы:**
- Optional modify: `server/config.js`.

**Это вопрос к Натали, а не код.** На момент написания плана: после Task B.6 в боевом проде на «Ввод данных» появится **11 кнопок режимов** (потому что `MEASURE_MODES_FULL` содержит 11). Натали, возможно, не хочет это видеть в боевом интерфейсе. Варианты:

A. **Оставить как есть (11 кнопок в проде).** Бэкенд готов ко всем 11. Но UX ломается — лишние кнопки.

B. **Жёстко ограничить прод тремя режимами.** В `config.js` поменять `MEASURE_MODES_FULL` на `['rows_bushes', 'rows_only', 'hours']`. Бэкенд тоже будет валидировать только 3 в проде. Демо — 5. Расширение для индивидуальных установок — отдельный конфиг.

C. **Сделать `MEASURE_MODES_PROD = ['rows_bushes', 'rows_only', 'hours']` и оставить `MEASURE_MODES_FULL` как «справочник всех вариантов».** Текущий выбор: `MEASURE_MODES = DEMO_MODE ? MEASURE_MODES_DEMO : MEASURE_MODES_PROD`.

- [ ] **Step 1: Спросить Натали перед мержем**

Сформулировать как «в боевом сейчас 3 кнопки, после изменений может стать 11 — оставить 3 или сразу видеть гектары/километры?». **По умолчанию рекомендация — вариант C** (в боевом оставить 3, добавить когда придёт первый клиент с механизированными работами).

- [ ] **Step 2: Применить вариант (если C — рекомендуемый)**

В `server/config.js`:

```js
const MEASURE_MODES_DEMO = ['rows_bushes', 'rows_only', 'hours', 'hectares', 'kilometers'];
const MEASURE_MODES_PROD = ['rows_bushes', 'rows_only', 'hours'];
// Полный справочник всех поддерживаемых режимов — для расширения под клиентов.
const MEASURE_MODES_ALL = [
  'rows_bushes', 'rows_only', 'hours', 'hectares', 'kilometers',
  'poles', 'tons', 'linear_meters', 'tons_km', 'hours_km', 'hectares_tons',
];
const MEASURE_MODES = DEMO_MODE ? MEASURE_MODES_DEMO : MEASURE_MODES_PROD;
```

Заменить экспорт `MEASURE_MODES_FULL` на новые имена; обновить any imports.

- [ ] **Step 3: Commit (если изменено)**

```bash
git add server/config.js
git commit -m "config: в проде остаются 3 режима подсчёта, MEASURE_MODES_ALL — справочник"
```

---

### Task B.11: Финальный smoke полного сценария в демо

**Files:**
- Не модифицируем — ручная проверка.

- [ ] **Step 1: Чистая демо-сессия с яблоней**

`$env:DEMO_MODE='true'; $env:DATABASE_URL=...; node server/server.js`

Открыть `http://localhost:3000` в инкогнито. Ввести культуру «яблоня».

- [ ] **Step 2: Полный сценарий**

1. Видишь шапку «🌱 Демо Помощник» + баннер «Это демо…».
2. На «Ввод данных» — 5 кнопок: «Ряды + деревья» (выбрана по умолчанию), «Только ряды», «Только часы», «Гектары», «Километры».
3. Под ними — серая подсказка с телефоном Натали.
4. Вид работ «Обрезка» → режим автоматом «Ряды + деревья». Кв.1, кл.1, Иванов, ряды 1-3 → добавить.
5. Вид работ «Опрыскивание» → режим автоматом «Гектары». Кв.2, гектары 5.5, Иванов → добавить.
6. Вид работ «Перегон трактора» → режим автоматом «Километры». Кв.1, км 120, Сидоров → добавить.
7. Журнал на сегодня показывает 3 группы в правильном формате:
   - «Обрезка · Кв.1, клет.1» с «Иванов — 3 рядов, ~415 деревьев»
   - «Опрыскивание · Кв.2» с «Иванов — 5.5 гектаров»
   - «Перегон трактора · Кв.1» с «Сидоров — 120 км»
8. Удалить запись через «✕» — список обновляется.
9. «Начать сначала» → подтвердить. Введи «виноград». Записей нет, кнопки режимов те же 5, но в случае добавления «Обрезки» — лейбл «Ряды + кусты» (не деревья).

- [ ] **Step 3: Если все шаги пройдены — фиксируем чек-листом в PR**

---

### Task B.12: Push, PR, merge

- [ ] **Step 1: Push**

```bash
git push -u origin demo-five-modes
```

- [ ] **Step 2: PR на GitHub**

`demo-five-modes` → `main`. Title: `feat(demo): 5 режимов подсчёта + default_measure_mode + терминология`. Тело:

```
## Что меняется
- Бэкенд:
  - work_logs: новые колонки hectares, kilometers (миграция IF NOT EXISTS, безопасно).
  - /api/work-types отдаёт default_measure_mode и kind.
  - POST /api/work-types опционально принимает default_measure_mode.
  - POST /api/logs принимает hectares/kilometers, валидация через MEASURE_MODES.
- Фронт:
  - /api/config используется для рендера кнопок режимов (демо — 5, прод — 3).
  - При смене вида работ режим автоматически = default_measure_mode.
  - Терминология «кустов / деревьев / растений» по unit квартала.
  - Поля гектаров и километров в форме ввода.
  - Серая подсказка с телефоном Натали под плашкой режимов (только в демо).
- CSS — стили для подсказки.

## Что не меняется
- Прод UI остаётся с 3 режимами (вариант C в плане), новые колонки в БД пусты для прод-данных.
- Аутентификация, miграции прежних колонок.

## План
- Этап 3 спеки. Идёт после Этапа 4 (журнал) который уже в проде.
- Следующий этап (Фаза 3): механизированные работы, отдельная плашка, диапазон клеток.
```

- [ ] **Step 3: Merge → Render auto-deploy**

Render задеплоит и боевой, и демо (если демо тоже на Render). Боевой не должен заметить изменений в UI.

- [ ] **Step 4: Smoke демо на проде**

После деплоя демо (если уже на Render-Free): открыть демо-URL в инкогнито, повторить шаги Task B.11.

---

## Self-review checklist (для контроллера перед запуском)

- [ ] Все задачи имеют точные `Files: Modify/Create` пути.
- [ ] Все шаги, меняющие код, содержат полный код-блок (нет «similar to Task N»).
- [ ] Имена методов согласованы между задачами: `groupLogsForDisplay`, `renderLogGroupsHtml`, `getUnitLabel`, `measureModeLabel`.
- [ ] Каждая «бите-сайз» задача завершается коммитом.
- [ ] Сценарий смоук-теста (Task B.11) покрывает все требования Этапа 3 из спеки: 5 режимов, default_measure_mode при смене вида работ, терминология куст/дерево/растение, soft-link, hectares/kilometers.
- [ ] Этап 4 идёт **первым** на отдельной ветке (Part A) — соблюдается требование спеки «сначала переделываем в боевом, потом копируем в демо».
- [ ] Между Part A и Part B — обязательная пауза наблюдения боевого (3-7 дней).

---

## Execution Handoff

После создания плана — выбор режима исполнения:

1. **Subagent-Driven Development (рекомендуется)** — контроллер запускает свежий sub-agent на каждую задачу, спустя каждую — двухстадийный ревью (spec compliance + code quality). Параллелизм не используется, но контекст не пухнет.

2. **Inline Execution** — выполнение тут же в сессии через executing-plans с чекпоинтами для ручного ревью.

Будем работать в режиме SDD, согласовано в Фазе 1. Старт — **только после паузы наблюдения** между Part A и Part B (между ними обязательная сверка с Натали).
