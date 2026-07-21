# Единые плашки отчётов — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Один рендер плашек (🛠 ручные / 🚜 техника) для «Всего за день» и «Отчёт за период», с конкретными эмодзи культур.

**Architecture:** Обобщаем существующий `renderTwoBlocksReportHtml` → `renderPlatesReportHtml(logs, { grandLabel })`. Дневной блок и период вызывают его. `cultureEmoji` — словарь по подстрокам. Сервер не трогаем.

**Tech Stack:** Vanilla JS (`public/js/app.js`), CSS (`public/styles.css`), SW cache bump.

**Spec:** `docs/superpowers/specs/2026-07-20-daily-period-report-plates-design.md`

## Global Constraints

- Не менять «Записи за дату» с ✕, контроль рядов, API.
- Демо и прод — один вид плашек.
- Пустой блок manual/mech не рендерить.

---

## Файлы

| Файл | Что меняем |
|---|---|
| `public/js/app.js` | `cultureEmoji`, `renderGrandTotalsHtml`, `renderTwoBlocksReportHtml` → plates, `renderDailyTotalsHtml`, `getReport`, показ культуры не только в demo |
| `public/styles.css` | стили `#i2-totals` как у `#report-result` при необходимости |
| `public/service-worker.js` | бамп `CACHE_NAME` |

---

### Task 1: cultureEmoji — конкретные смайлы

**Files:** Modify `public/js/app.js` (`cultureEmoji`)

- [ ] Заменить тело `cultureEmoji` на словарь из спеки §3 (порядок проверок: виноград → яблон → груш → малин → клубник → черешн/вишн → персик/абрикос → слив/алыч → орех → смородин/ежевик/голубик/жимолост → крыжовник → иначе 🌱).

### Task 2: Единый рендер плашек

**Files:** Modify `public/js/app.js`

- [ ] `renderGrandTotalsHtml(manualLogs, mechLogs, grandLabel = 'Всего за период')` — подпись из аргумента.
- [ ] `renderPlatesReportHtml(logs, { grandLabel })` — обёртка над текущей логикой двух блоков; пустой ответ: «Записей нет» / для дня «Пока пусто» через параметр `emptyText`.
- [ ] `renderTwoBlocksReportHtml` оставить тонким алиасом на `renderPlatesReportHtml(logs, { grandLabel: 'Всего за период' })` или удалить и заменить вызовы.
- [ ] В `renderManualBlockHtml` / `renderEmployeeReportHtml`: показывать культуру при наличии `estate_id` (не только `demoMode`).
- [ ] `renderDailyTotalsHtml()` → `return this.renderPlatesReportHtml(this.entries, { grandLabel: 'Всего за день', emptyText: 'Пока пусто.' });`
- [ ] `getReport()`: и демо, и прод → `header + renderPlatesReportHtml(data.logs, { grandLabel: 'Всего за период' })`.

### Task 3: CSS + SW

**Files:** `public/styles.css`, `public/service-worker.js`

- [ ] `#i2-totals` — `white-space: normal; font-family: inherit;` если нужно.
- [ ] Бамп `CACHE_NAME`.

### Task 4: Деплой на демку

- [ ] Залить изменённые файлы на VPS `/opt/pomoshnik-demo`, `pm2 restart pomoshnik-demo`.
- [ ] Ручная проверка: «Начать сначала» → ручная запись + мех → плашки в «Всего за день»; период — тот же вид; эмодзи 🍇/🍎.
