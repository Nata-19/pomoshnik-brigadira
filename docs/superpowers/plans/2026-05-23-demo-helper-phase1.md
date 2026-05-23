# Demo Helper — Implementation Plan (Phase 1: Этапы 0-2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Базовая инфраструктура демо-витрины «Помощник Бригадира»: переключатель `DEMO_MODE`, миграции БД, изоляция данных по cookie-сессиям, заводское наполнение, UI-отличия (название, лого, баннер, кнопка сброса), ввод культуры. После завершения этой фазы локально работает минимальный демо-режим: посетитель заходит, видит баннер «это демо», вводит культуру, попадает в приложение с заводскими сотрудниками и видами работ, может добавлять/удалять, всё изолировано от других посетителей.

**Architecture:** Один код, два деплоя. Демо-режим включается переменной окружения `DEMO_MODE=true`. Изоляция через колонку `demo_session_id` во всех data-таблицах + middleware-фильтрация. Cookie `demo_session` с TTL 24ч хранит идентификатор сессии. Ленивая очистка устаревших сессий при входящих запросах. Инвентарь демо хранится в таблицах `demo_quarters`/`demo_cells`/`demo_rows` (а не в JSON-файле), `getDemoInventory(session_id)` строит из БД объект формата как у `inventory.json` — чтобы существующий `DataParser` работал без изменений.

**Tech Stack:** Node.js (Express), PostgreSQL (Neon, `pg`), vanilla JS PWA, существующие helmet/express-rate-limit/bcryptjs/jsonwebtoken. Без новых runtime-зависимостей. Тесты — ручной smoke через `curl` и браузер локально.

**Reference spec:** `docs/superpowers/specs/2026-05-23-demo-helper-design.md`

**Phase scope:** Этапы 0, 1, 2 из спеки. Этапы 3-4 (режимы подсчёта + журнал в новом формате в боевом) — отдельный план Фазы 2. Этапы 5-9 — Фаза 3, после ответа мужа Натали и выбора хостинга.

**Phase exit criteria** (что должно работать после Фазы 1):
- При запуске `DEMO_MODE=true node server/server.js` сервер запускается, миграции проходят.
- При запуске без `DEMO_MODE` (или `DEMO_MODE=false`) сервер работает как сейчас — никаких regressions.
- В демо-режиме на главной странице — название «Демо Помощник», лого 🌱, баннер «🎯 Это демо. Данные удалятся через сутки…»
- При первом заходе в демо появляется модалка «Введи культуру». После ввода создаётся хозяйство «Демо: <культура>» с заводским наполнением.
- Сотрудники Иванов/Петров/Сидоров и виды работ Обрезка/Полив/Прополка/Опрыскивание/Культивация/Перегон трактора уже есть в сессии.
- Кнопка «🔄 Начать сначала» в шапке (только в демо) сбрасывает сессию после подтверждения.
- Два браузера (или один + инкогнито) видят независимые песочницы.

---

## File Structure

**Создаём:**
- `server/config.js` — экспорт `DEMO_MODE`, `BRAND_NAME`, `BRAND_LOGO`, `CONTACT_PHONE`, `MEASURE_MODES`.
- `server/demo.js` — модуль с функциями демо-режима: `requireDemoSession` middleware, `seedSessionReferences`, `seedDemoEstate`, `getDemoInventory`, `cleanupOldDemoSessions`, `resetDemoSession`.
- `public/js/demo-ui.js` — UI-helper фронта: рендеринг баннера, кнопки «Начать сначала», модалки ввода культуры.

**Модифицируем:**
- `server/server.js` — миграции для демо-таблиц, mounting demo endpoints, ветвления по `DEMO_MODE` в существующих endpoints.
- `public/index.html` — подключение `demo-ui.js`, динамическое title/название.
- `public/js/app.js` — чтение `/api/config`, ветвления на demo-режим (отключение auth-flow, использование демо-инвентаря).
- `public/styles.css` — стили баннера, кнопки сброса, модалки культуры.

**Не трогаем в этой фазе:**
- `server/auth.js`, `server/parser.js` — без изменений (изменения парсера для гектаров/километров — Фаза 2).
- Существующие маршруты `/api/login`, `/api/register`, `/api/setup` — но в демо-режиме middleware-обёртка вернёт 404.

---

## Этап 0: Подготовка (1-2 часа)

### Task 0.1: Создать модуль конфигурации с флагом DEMO_MODE

**Files:**
- Create: `server/config.js`

- [ ] **Step 1: Создать файл `server/config.js`**

```js
// Глобальная конфигурация — читается из env при старте, экспортируется один раз.
// DEMO_MODE решает много ветвлений ниже: миграции, middleware, UI-флаги.

const DEMO_MODE = process.env.DEMO_MODE === 'true';

const BRAND_NAME = DEMO_MODE ? 'Демо Помощник' : 'Помощьник Бригадира';
const BRAND_LOGO = DEMO_MODE ? '🌱' : '🍇';
const CONTACT_PHONE = '+79783116389';

// Список единиц измерения, доступных в текущем режиме.
// В демо — 5 базовых, в проде — все 11. Расширенные «продаются» как
// «настраивается под предприятие».
const MEASURE_MODES_DEMO = ['rows_bushes', 'rows_only', 'hours', 'hectares', 'kilometers'];
const MEASURE_MODES_FULL = [
  'rows_bushes', 'rows_only', 'hours', 'hectares', 'kilometers',
  'poles', 'tons', 'linear_meters', 'tons_km', 'hours_km', 'hectares_tons',
];
const MEASURE_MODES = DEMO_MODE ? MEASURE_MODES_DEMO : MEASURE_MODES_FULL;

// TTL демо-сессии в миллисекундах (24 часа).
const DEMO_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

module.exports = {
  DEMO_MODE,
  BRAND_NAME,
  BRAND_LOGO,
  CONTACT_PHONE,
  MEASURE_MODES,
  DEMO_SESSION_TTL_MS,
};
```

- [ ] **Step 2: Проверить syntax**

```
node --check server/config.js
```

- [ ] **Step 3: Smoke — что модуль читает env**

```
node -e "console.log(require('./server/config'))"
```
Ожидаемо: `DEMO_MODE: false`, `BRAND_NAME: 'Помощьник Бригадира'`, `BRAND_LOGO: '🍇'`.

На Windows PowerShell:
```
$env:DEMO_MODE='true'; node -e "console.log(require('./server/config'))"; $env:DEMO_MODE=$null
```
Ожидаемо: `DEMO_MODE: true`, `BRAND_NAME: 'Демо Помощник'`, `BRAND_LOGO: '🌱'`.

- [ ] **Step 4: Commit**

```
git add server/config.js
git commit -m "feat(demo): add config module with DEMO_MODE flag and brand"
```

---

### Task 0.2: Ассерт безопасности «DEMO_MODE + боевая БД = отказ запуска»

**Files:**
- Modify: `server/server.js:24-28` (блок проверки DATABASE_URL)

**Контекст.** Защита от случайного запуска демо-режима с боевой БД. Боевая Neon-инстанция имеет в connection string уникальную подстроку (Натали может уточнить в Neon Dashboard, например это часть hostname вроде `ep-cool-cloud-xxx`). Сравниваем подстроку из env, и если совпадает + `DEMO_MODE=true` — отказ.

- [ ] **Step 1: Добавить env-переменную `PROD_DB_FINGERPRINT`**

В `render.yaml` (для боевого деплоя) — НЕ нужна. Просто документируем что для демо-деплоя её надо задать.

В `server/server.js` после строки `if (!process.env.DATABASE_URL)` (строка ~25) добавить:

```js
// Защита от случайного включения DEMO_MODE с боевой БД.
// PROD_DB_FINGERPRINT — короткая подстрока из connection string боевого Neon
// (например, имя его endpoint типа 'ep-cool-cloud-xxx'). Задаётся в env
// демо-деплоя. Если задано и совпадает в DATABASE_URL — отказ запуска.
const { DEMO_MODE } = require('./config');
const prodFingerprint = process.env.PROD_DB_FINGERPRINT || '';
if (DEMO_MODE && prodFingerprint && process.env.DATABASE_URL.includes(prodFingerprint)) {
  console.error('❌ DEMO_MODE=true И DATABASE_URL содержит PROD_DB_FINGERPRINT — это похоже на боевую БД. Запуск отменён.');
  process.exit(1);
}
```

- [ ] **Step 2: Проверить syntax**

```
node --check server/server.js
```

- [ ] **Step 3: Smoke — обычный запуск без переменных**

Запустить `npm start` локально (без `DEMO_MODE`, без `PROD_DB_FINGERPRINT`) — должен стартовать как обычно. Открыть `http://localhost:3000` — приложение работает.

Остановить сервер (Ctrl+C).

- [ ] **Step 4: Smoke — симуляция «опасной» комбинации должна заблокировать запуск**

```
$env:DEMO_MODE='true'; $env:PROD_DB_FINGERPRINT='localhost'; npm start
```

(Подставлен `localhost` как fingerprint, потому что локальная БД содержит `localhost` в connection string — это имитирует «случайную попытку запустить демо с боевой БД».)

Ожидаемо: вывод `❌ DEMO_MODE=true И DATABASE_URL содержит PROD_DB_FINGERPRINT…`, exit code 1.

```
$env:DEMO_MODE=$null; $env:PROD_DB_FINGERPRINT=$null
```

- [ ] **Step 5: Commit**

```
git add server/server.js
git commit -m "feat(demo): refuse startup when DEMO_MODE + PROD_DB_FINGERPRINT match"
```

---

### Task 0.3: Миграции БД для демо-режима

**Files:**
- Modify: `server/server.js:61-169` (startup-блок миграций)

**Контекст.** Добавляем идемпотентные DDL для демо: новая таблица `demo_sessions`, колонки `demo_session_id` в существующих таблицах, новые таблицы `demo_quarters`/`demo_cells`/`demo_rows`. Все миграции выполняются всегда (и в проде, и в демо) — потому что код один. В проде колонки `demo_session_id` останутся NULL и не помешают.

- [ ] **Step 1: Добавить миграции в startup-блок `(async () => {`**

В файле `server/server.js` найти строку:
```js
console.log('✅ Connected to Postgres');
```

**Прямо перед ней** вставить:

```js
    // --- Демо-режим: таблицы и колонки для изолированных сессий ---
    await pool.query(`
      CREATE TABLE IF NOT EXISTS demo_sessions (
        id TEXT PRIMARY KEY,
        culture TEXT,
        unit TEXT,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS demo_session_id TEXT REFERENCES demo_sessions(id) ON DELETE CASCADE`);
    await pool.query(`ALTER TABLE work_types ADD COLUMN IF NOT EXISTS demo_session_id TEXT REFERENCES demo_sessions(id) ON DELETE CASCADE`);
    await pool.query(`ALTER TABLE work_types ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'manual'`);
    await pool.query(`ALTER TABLE work_types ADD COLUMN IF NOT EXISTS default_measure_mode TEXT NOT NULL DEFAULT 'rows_bushes'`);
    await pool.query(`ALTER TABLE attendance ADD COLUMN IF NOT EXISTS demo_session_id TEXT REFERENCES demo_sessions(id) ON DELETE CASCADE`);
    await pool.query(`ALTER TABLE work_logs ADD COLUMN IF NOT EXISTS demo_session_id TEXT REFERENCES demo_sessions(id) ON DELETE CASCADE`);

    // Инвентарь демо — в БД, не в JSON-файле, чтобы каждая сессия имела свой.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS demo_quarters (
        id SERIAL PRIMARY KEY,
        demo_session_id TEXT NOT NULL REFERENCES demo_sessions(id) ON DELETE CASCADE,
        quarter_key TEXT NOT NULL,
        name TEXT NOT NULL,
        unit TEXT NOT NULL,
        UNIQUE (demo_session_id, quarter_key)
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS demo_cells (
        id SERIAL PRIMARY KEY,
        quarter_id INTEGER NOT NULL REFERENCES demo_quarters(id) ON DELETE CASCADE,
        cell_key TEXT NOT NULL,
        hectares NUMERIC(10,2),
        UNIQUE (quarter_id, cell_key)
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS demo_rows (
        id SERIAL PRIMARY KEY,
        cell_id INTEGER NOT NULL REFERENCES demo_cells(id) ON DELETE CASCADE,
        row_num INTEGER NOT NULL,
        bushes INTEGER NOT NULL,
        UNIQUE (cell_id, row_num)
      )
    `);

    // Расширяем CHECK measure_mode (старый ограничивал 3 значениями — теперь надо
    // 11). Дропаем старый, добавляем новый.
    await pool.query(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_measure_mode') THEN
          ALTER TABLE work_logs DROP CONSTRAINT chk_measure_mode;
        END IF;
        ALTER TABLE work_logs ADD CONSTRAINT chk_measure_mode
          CHECK (measure_mode IN (
            'rows_bushes', 'rows_only', 'hours', 'hectares', 'kilometers',
            'poles', 'tons', 'linear_meters', 'tons_km', 'hours_km', 'hectares_tons'
          ));
      END $$;
    `);
```

- [ ] **Step 2: Запустить сервер локально, посмотреть что миграции прошли**

```
npm start
```
Ожидаемо: `✅ Connected to Postgres`, никаких SQL-ошибок.

Остановить (Ctrl+C). Запустить ещё раз — миграции должны быть идемпотентными (никаких «column already exists»).

- [ ] **Step 3: Проверить что новые таблицы появились**

Через psql или Neon Dashboard:
```sql
SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name LIKE 'demo_%';
```
Ожидаемо: `demo_sessions`, `demo_quarters`, `demo_cells`, `demo_rows`.

```sql
SELECT column_name FROM information_schema.columns
WHERE table_name='work_logs' AND column_name='demo_session_id';
```
Ожидаемо: одна строка.

- [ ] **Step 4: Commit**

```
git add server/server.js
git commit -m "feat(demo): migrations for demo sessions, isolated inventory tables, expanded measure_mode CHECK"
```

---

## Этап 1: Изоляция сессий и заводское наполнение (4-6 часов)

### Task 1.1: Модуль `server/demo.js` — каркас

**Files:**
- Create: `server/demo.js`

- [ ] **Step 1: Создать модуль с заглушками функций**

```js
// Модуль демо-режима. Подключается из server.js только если DEMO_MODE=true.
// Никаких сайд-эффектов на проде — там этот файл просто не используется.

const crypto = require('crypto');
const { DEMO_SESSION_TTL_MS } = require('./config');

const COOKIE_NAME = 'demo_session';

// Список заводских сотрудников и видов работ — справочники Этапа А.
const SEED_EMPLOYEES = ['Иванов', 'Петров', 'Сидоров'];

const SEED_WORK_TYPES_MANUAL = [
  { name: 'Обрезка',  default_measure_mode: 'rows_bushes' },
  { name: 'Полив',    default_measure_mode: 'rows_bushes' },
  { name: 'Прополка', default_measure_mode: 'rows_bushes' },
];
const SEED_WORK_TYPES_MECH = [
  { name: 'Опрыскивание',     default_measure_mode: 'hectares'   },
  { name: 'Культивация',      default_measure_mode: 'hectares'   },
  { name: 'Перегон трактора', default_measure_mode: 'kilometers' },
];

// Словарь автодетекции единицы учёта по культуре.
const BUSH_CULTURES = ['виноград', 'малина', 'смородина', 'ежевика', 'крыжовник', 'клубника', 'голубика', 'жимолость'];
const TREE_CULTURES = ['яблоня', 'груша', 'слива', 'персик', 'абрикос', 'вишня', 'черешня', 'алыча', 'орех'];

function detectUnit(culture) {
  const lc = (culture || '').toLowerCase().trim();
  if (BUSH_CULTURES.some(c => lc.includes(c))) return 'bush';
  if (TREE_CULTURES.some(c => lc.includes(c))) return 'tree';
  return null; // неизвестное — спросим у посетителя
}

function newSessionId() {
  return 'demo-' + crypto.randomBytes(8).toString('hex');
}

module.exports = {
  COOKIE_NAME,
  SEED_EMPLOYEES,
  SEED_WORK_TYPES_MANUAL,
  SEED_WORK_TYPES_MECH,
  detectUnit,
  newSessionId,
  DEMO_SESSION_TTL_MS,
};
```

- [ ] **Step 2: Проверить syntax + smoke**

```
node --check server/demo.js
node -e "const d=require('./server/demo'); console.log(d.detectUnit('виноград'), d.detectUnit('яблоня'), d.detectUnit('помидор'), d.newSessionId())"
```
Ожидаемо: `bush tree null demo-xxxxxxxx`.

- [ ] **Step 3: Commit**

```
git add server/demo.js
git commit -m "feat(demo): module skeleton with seed lists and unit detection"
```

---

### Task 1.2: Функция `seedSessionReferences` — заводское наполнение Этапа А

**Files:**
- Modify: `server/demo.js`

**Контекст.** Когда посетитель впервые заходит в демо, создаётся `demo_sessions` строка + копируются справочники: 3 сотрудника, 6 видов работ. Этот блок не зависит от культуры (Этап А спеки).

- [ ] **Step 1: Добавить функцию `createSessionWithSeed` в `server/demo.js`**

В конец файла, перед `module.exports`:

```js
// Создаёт новую demo_sessions запись и копирует справочные данные (Этап А спеки):
// сотрудников и виды работ. Возвращает id сессии.
//
// pool — pg Pool из server.js, переданный сюда чтобы не плодить модули БД.
async function createSessionWithSeed(pool) {
  const sessionId = newSessionId();
  await pool.query(
    'INSERT INTO demo_sessions (id) VALUES ($1)',
    [sessionId]
  );
  for (const name of SEED_EMPLOYEES) {
    await pool.query(
      'INSERT INTO employees (brigadier_id, name, demo_session_id) VALUES ($1, $2, $3)',
      [0, name, sessionId]
    );
  }
  for (const wt of [...SEED_WORK_TYPES_MANUAL, ...SEED_WORK_TYPES_MECH]) {
    const kind = SEED_WORK_TYPES_MANUAL.includes(wt) ? 'manual' : 'mechanized';
    await pool.query(
      'INSERT INTO work_types (name, kind, default_measure_mode, demo_session_id) VALUES ($1, $2, $3, $4)',
      [wt.name, kind, wt.default_measure_mode, sessionId]
    );
  }
  return sessionId;
}
```

Расширить `module.exports`:
```js
module.exports = {
  COOKIE_NAME,
  SEED_EMPLOYEES,
  SEED_WORK_TYPES_MANUAL,
  SEED_WORK_TYPES_MECH,
  detectUnit,
  newSessionId,
  createSessionWithSeed,
  DEMO_SESSION_TTL_MS,
};
```

**Замечание про `employees.brigadier_id`:** существующая таблица требует NOT NULL `brigadier_id`. Для демо используем фиктивное значение `0` — оно не будет коллидировать с реальными `brigadiers.id` (там SERIAL начинается с 1) и не используется в demo-фильтрации (фильтруем по `demo_session_id`).

**Замечание про `work_types.name UNIQUE`:** существующий constraint UNIQUE на `work_types.name` будет мешать — два посетителя с «Обрезка» конфликтуют. Надо изменить уникальность. Делаем это в следующей под-задаче.

- [ ] **Step 2: Поправить уникальность `work_types.name`**

Сейчас `name TEXT UNIQUE NOT NULL` в существующей миграции (server.js строка ~126). Надо переделать на `UNIQUE (demo_session_id, name)` чтобы у каждой demo-сессии могло быть «Обрезка».

В `server/server.js` найти блок миграций и **добавить** (после уже добавленных в Task 0.3):

```js
    // Уникальность work_types.name — теперь по паре (demo_session_id, name).
    // В проде demo_session_id NULL, и нам нужна уникальность только по name среди NULL.
    // PostgreSQL: NULL не сравниваются, поэтому два work_types с одинаковым name и
    // demo_session_id=NULL пройдут UNIQUE. Чтобы прод сохранил эксклюзивность,
    // делаем два partial-unique-index'а.
    await pool.query(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'work_types_name_key') THEN
          ALTER TABLE work_types DROP CONSTRAINT work_types_name_key;
        END IF;
      END $$;
    `);
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS work_types_prod_name_uniq
        ON work_types(name) WHERE demo_session_id IS NULL
    `);
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS work_types_demo_name_uniq
        ON work_types(demo_session_id, name) WHERE demo_session_id IS NOT NULL
    `);
```

- [ ] **Step 3: Запустить сервер локально, миграции должны пройти**

```
npm start
```
Ожидаемо: `✅ Connected to Postgres`. Остановить.

- [ ] **Step 4: Smoke `createSessionWithSeed` через скрипт**

Создать временный файл `/tmp/test-seed.js` (или в проекте `_test_seed.js`, потом удалим):

```js
const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const { createSessionWithSeed } = require('./server/demo');

(async () => {
  const sid = await createSessionWithSeed(pool);
  console.log('Created session:', sid);
  const emp = await pool.query('SELECT name FROM employees WHERE demo_session_id=$1', [sid]);
  console.log('Employees:', emp.rows.map(r => r.name));
  const wt = await pool.query('SELECT name, kind, default_measure_mode FROM work_types WHERE demo_session_id=$1', [sid]);
  console.log('Work types:', wt.rows);
  await pool.query('DELETE FROM demo_sessions WHERE id=$1', [sid]); // cascade удалит остальное
  await pool.end();
})();
```

Запустить: `node _test_seed.js`. Ожидаемо: 3 сотрудника, 6 видов работ с правильными kind и default_measure_mode.

Удалить тестовый файл: `Remove-Item _test_seed.js`.

- [ ] **Step 5: Commit**

```
git add server/demo.js server/server.js
git commit -m "feat(demo): createSessionWithSeed + per-session work_types uniqueness"
```

---

### Task 1.3: Endpoint `POST /api/demo/session` — создание сессии и cookie

**Files:**
- Modify: `server/server.js`

**Контекст.** Фронт при первой загрузке (если cookie `demo_session` нет) вызывает этот endpoint. Сервер создаёт сессию, копирует справочники, ставит cookie.

- [ ] **Step 1: Добавить endpoint в server.js**

Найти место где висят `/api/setup`, `/api/login` (примерно строка 240). **После** блока инициализации (`pool` готов) и **рядом** с другими endpoint'ами добавить:

```js
// === DEMO endpoints ===
const demo = DEMO_MODE ? require('./demo') : null;

if (DEMO_MODE) {
  app.post('/api/demo/session', async (req, res) => {
    try {
      const existing = req.cookies && req.cookies[demo.COOKIE_NAME];
      if (existing) {
        const r = await pool.query('SELECT id FROM demo_sessions WHERE id=$1', [existing]);
        if (r.rows.length > 0) {
          return res.json({ session_id: existing, isNew: false });
        }
        // cookie указывает на исчезнувшую сессию — выдадим новую
      }
      const sessionId = await demo.createSessionWithSeed(pool);
      res.cookie(demo.COOKIE_NAME, sessionId, {
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        maxAge: demo.DEMO_SESSION_TTL_MS,
      });
      res.json({ session_id: sessionId, isNew: true });
    } catch (err) {
      console.error('demo/session error:', err);
      res.status(500).json({ error: err.message });
    }
  });
}
```

- [ ] **Step 2: Перезапустить сервер с `DEMO_MODE=true`**

```
$env:DEMO_MODE='true'; npm start
```

В отдельном терминале (cmd / curl):
```
curl -i -X POST http://localhost:3000/api/demo/session -c demo_cookies.txt
```
Ожидаемо: HTTP 200, тело `{"session_id":"demo-...","isNew":true}`, в ответе Set-Cookie с именем `demo_session`.

Повторный запрос с тем же cookie:
```
curl -i -X POST http://localhost:3000/api/demo/session -b demo_cookies.txt
```
Ожидаемо: `{"session_id":"demo-...","isNew":false}`, тот же session_id.

Удалить `demo_cookies.txt`. Остановить сервер. `$env:DEMO_MODE=$null`.

- [ ] **Step 3: Smoke что в проде endpoint НЕ существует**

Запустить без DEMO_MODE: `npm start`. `curl -i -X POST http://localhost:3000/api/demo/session` → ожидаемо 404. Остановить.

- [ ] **Step 4: Commit**

```
git add server/server.js
git commit -m "feat(demo): POST /api/demo/session endpoint with cookie"
```

---

### Task 1.4: Middleware `requireDemoSession` — фильтр всех запросов

**Files:**
- Modify: `server/demo.js`, `server/server.js`

**Контекст.** В демо-режиме все API-запросы (кроме `/api/demo/*` и `/api/config`) должны иметь валидный `demo_session_id` cookie. Если нет — middleware вернёт 401 с просьбой к фронту вызвать `/api/demo/session`.

- [ ] **Step 1: Добавить middleware в `server/demo.js`**

В конец файла, перед `module.exports`:

```js
// Middleware: требует валидный demo_session cookie. Прикрепляет req.demo_session_id.
// Возвращает 401 если cookie нет или сессия не найдена.
function requireDemoSession(pool) {
  return async (req, res, next) => {
    try {
      const sessionId = req.cookies && req.cookies[COOKIE_NAME];
      if (!sessionId) {
        return res.status(401).json({ error: 'no demo session', action: 'create_session' });
      }
      const r = await pool.query('SELECT id, culture, unit FROM demo_sessions WHERE id=$1', [sessionId]);
      if (r.rows.length === 0) {
        return res.status(401).json({ error: 'demo session expired', action: 'create_session' });
      }
      req.demo_session_id = sessionId;
      req.demo_session = r.rows[0];
      next();
    } catch (err) {
      console.error('requireDemoSession error:', err);
      res.status(500).json({ error: err.message });
    }
  };
}
```

Добавить в `module.exports`: `requireDemoSession`.

- [ ] **Step 2: Применить middleware в `server/server.js`**

В демо-блоке (после `if (DEMO_MODE) { app.post('/api/demo/session', ...) }`) добавить:

```js
  // Все API кроме /api/demo/session и /api/config требуют валидной сессии.
  const requireDemo = demo.requireDemoSession(pool);
  app.use((req, res, next) => {
    if (!req.path.startsWith('/api/')) return next();
    if (req.path === '/api/demo/session') return next();
    if (req.path === '/api/config') return next();
    return requireDemo(req, res, next);
  });
```

- [ ] **Step 3: Smoke**

Запустить с `DEMO_MODE=true`. Без cookie сделать `curl -i http://localhost:3000/api/estates`. Ожидаемо: 401 с телом `{"error":"no demo session","action":"create_session"}`.

Получить cookie через `POST /api/demo/session`, потом с этим cookie сделать `curl -b demo_cookies.txt http://localhost:3000/api/estates` — ожидаемо 200 (даже если пустой массив).

- [ ] **Step 4: Commit**

```
git add server/demo.js server/server.js
git commit -m "feat(demo): requireDemoSession middleware filters all /api except demo+config"
```

---

### Task 1.5: Endpoint `POST /api/demo/culture` — ввод культуры и Этап Б seed

**Files:**
- Modify: `server/demo.js`, `server/server.js`

**Контекст.** После создания сессии у посетителя есть справочники, но нет хозяйства. Фронт показывает модалку «Введи культуру». Посетитель отправляет POST с `{ culture, unit }` (unit может быть `null` если он выбрал автодетекцию — тогда сервер пытается угадать). Создаётся `demo_quarters` (2 квартала по 5 клеток), `demo_cells`, `demo_rows`, явка и примеры записей в журнале.

- [ ] **Step 1: Функция `seedEstate(pool, sessionId, culture, unit)` в `server/demo.js`**

В конец, перед `module.exports`:

```js
// Заводское наполнение Этапа Б: создаёт хозяйство (= культуру в demo_sessions),
// 2 квартала по 5 клеток с инвентарём, 2-3 примера записей в журнале.
//
// unit: 'bush' | 'tree' | 'other' (для термина "растений")
async function seedEstate(pool, sessionId, culture, unit) {
  await pool.query(
    'UPDATE demo_sessions SET culture=$1, unit=$2 WHERE id=$3',
    [culture, unit, sessionId]
  );

  // 2 квартала
  for (let q = 1; q <= 2; q++) {
    const qres = await pool.query(
      'INSERT INTO demo_quarters (demo_session_id, quarter_key, name, unit) VALUES ($1, $2, $3, $4) RETURNING id',
      [sessionId, String(q), `Кв.${q}`, unit]
    );
    const quarterId = qres.rows[0].id;
    // 5 клеток в каждом
    for (let c = 1; c <= 5; c++) {
      const cres = await pool.query(
        'INSERT INTO demo_cells (quarter_id, cell_key, hectares) VALUES ($1, $2, $3) RETURNING id',
        [quarterId, String(c), 1.5 + c * 0.3]
      );
      const cellId = cres.rows[0].id;
      // 7 рядов в каждой клетке, реалистичные цифры
      const sampleBushes = [137, 140, 145, 142, 138, 141, 139];
      for (let row = 1; row <= 7; row++) {
        await pool.query(
          'INSERT INTO demo_rows (cell_id, row_num, bushes) VALUES ($1, $2, $3)',
          [cellId, row, sampleBushes[row - 1]]
        );
      }
    }
  }

  // Явка Иванова, Петрова, Сидорова на вчера и позавчера
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const dayBefore = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const empRows = await pool.query(
    'SELECT id, name FROM employees WHERE demo_session_id=$1 ORDER BY id',
    [sessionId]
  );
  for (const date of [yesterday, dayBefore]) {
    for (const emp of empRows.rows) {
      await pool.query(
        'INSERT INTO attendance (brigadier_id, date, employee_id, demo_session_id) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
        [0, date, emp.id, sessionId]
      );
    }
  }

  // 3 примера записей в журнале
  // Вчера: Иванов — Обрезка — Кв.1 клет.1 ряды 1-5
  // Вчера: Петров — Обрезка — Кв.1 клет.2 ряды 1-4
  // Позавчера: Сидоров — Опрыскивание — Кв.2 5 гектаров
  await pool.query(
    `INSERT INTO work_logs (date, estate_id, quarter, cell, employee, rows, bushes, work_type, measure_mode, brigadier_id, demo_session_id)
     VALUES ($1, 'demo', '1', '1', 'Иванов', '1,2,3,4,5', 685, 'Обрезка', 'rows_bushes', 0, $2)`,
    [yesterday, sessionId]
  );
  await pool.query(
    `INSERT INTO work_logs (date, estate_id, quarter, cell, employee, rows, bushes, work_type, measure_mode, brigadier_id, demo_session_id)
     VALUES ($1, 'demo', '1', '2', 'Петров', '1,2,3,4', 555, 'Обрезка', 'rows_bushes', 0, $2)`,
    [yesterday, sessionId]
  );
  await pool.query(
    `INSERT INTO work_logs (date, estate_id, quarter, cell, employee, rows, bushes, work_type, measure_mode, hours, brigadier_id, demo_session_id)
     VALUES ($1, 'demo', '2', NULL, 'Сидоров', NULL, 0, 'Опрыскивание', 'hectares', 5, 0, $2)`,
    [dayBefore, sessionId]
  );
}
```

Добавить в `module.exports`: `seedEstate`.

**Замечание про `hours` колонку:** мы используем существующее поле `hours` для записи «единиц измерения» отличных от рядов+кустов (тут — гектары). В Фазе 2 переименуем/расширим колонку, в Фазе 1 живём с этим.

- [ ] **Step 2: Endpoint `POST /api/demo/culture` в server.js**

В demo-блоке после `requireDemo` middleware:

```js
  app.post('/api/demo/culture', requireDemo, async (req, res) => {
    try {
      const { culture, unit } = req.body;
      if (!culture || !culture.trim()) {
        return res.status(400).json({ error: 'Укажи культуру' });
      }
      if (req.demo_session.culture) {
        return res.status(400).json({ error: 'Культура уже выбрана для этой сессии' });
      }
      const detectedUnit = unit || demo.detectUnit(culture);
      if (!detectedUnit) {
        return res.json({ needUnit: true });
      }
      if (!['bush', 'tree', 'other'].includes(detectedUnit)) {
        return res.status(400).json({ error: 'unit должен быть bush/tree/other' });
      }
      await demo.seedEstate(pool, req.demo_session_id, culture.trim(), detectedUnit);
      res.json({ culture: culture.trim(), unit: detectedUnit });
    } catch (err) {
      console.error('demo/culture error:', err);
      res.status(500).json({ error: err.message });
    }
  });
```

- [ ] **Step 3: Smoke**

```
# Создать сессию
curl -X POST http://localhost:3000/api/demo/session -c demo.txt

# Известная культура
curl -X POST http://localhost:3000/api/demo/culture -b demo.txt -H "Content-Type: application/json" -d "{\"culture\":\"виноград\"}"
# Ожидаемо: {"culture":"виноград","unit":"bush"}

# Проверить что записи появились
psql или Neon: SELECT COUNT(*) FROM demo_quarters WHERE demo_session_id='demo-...' → 2
                SELECT COUNT(*) FROM demo_cells WHERE quarter_id IN (...) → 10
                SELECT COUNT(*) FROM work_logs WHERE demo_session_id='demo-...' → 3
```

Создать новую сессию для теста «неизвестная культура»:
```
curl -X POST http://localhost:3000/api/demo/session -c demo2.txt
curl -X POST http://localhost:3000/api/demo/culture -b demo2.txt -H "Content-Type: application/json" -d "{\"culture\":\"помидор\"}"
# Ожидаемо: {"needUnit":true}

curl -X POST http://localhost:3000/api/demo/culture -b demo2.txt -H "Content-Type: application/json" -d "{\"culture\":\"помидор\",\"unit\":\"other\"}"
# Ожидаемо: {"culture":"помидор","unit":"other"}
```

Удалить `demo*.txt`.

- [ ] **Step 4: Commit**

```
git add server/demo.js server/server.js
git commit -m "feat(demo): POST /api/demo/culture seeds estate with quarters, cells, inventory, examples"
```

---

### Task 1.6: Функция `getDemoInventory` — собрать inventory.json из БД

**Files:**
- Modify: `server/demo.js`, `server/server.js`

**Контекст.** Существующий `DataParser` ожидает объект `{estates: {estateId: {name, quarters: {...}}}}` из inventory.json. В демо у нас это лежит в БД (demo_quarters, demo_cells, demo_rows). Функция строит тот же формат на лету.

- [ ] **Step 1: Функция `getDemoInventory(pool, sessionId)`**

В `server/demo.js` перед `module.exports`:

```js
// Возвращает объект инвентаря в формате DataParser:
// { estates: { demo: { name, quarters: { '1': { name, cells: { '1': [{row, bushes}, ...] } } } } } }
async function getDemoInventory(pool, sessionId) {
  const sess = await pool.query('SELECT culture, unit FROM demo_sessions WHERE id=$1', [sessionId]);
  if (sess.rows.length === 0) return { estates: {} };
  const culture = sess.rows[0].culture;
  if (!culture) {
    return { estates: {} }; // культура ещё не выбрана
  }
  const qs = await pool.query(
    'SELECT id, quarter_key, name, unit FROM demo_quarters WHERE demo_session_id=$1 ORDER BY id',
    [sessionId]
  );
  const quarters = {};
  for (const q of qs.rows) {
    const cs = await pool.query(
      'SELECT id, cell_key FROM demo_cells WHERE quarter_id=$1 ORDER BY id',
      [q.id]
    );
    const cells = {};
    for (const c of cs.rows) {
      const rs = await pool.query(
        'SELECT row_num, bushes FROM demo_rows WHERE cell_id=$1 ORDER BY row_num',
        [c.id]
      );
      cells[c.cell_key] = rs.rows.map(r => ({ row: r.row_num, bushes: r.bushes }));
    }
    quarters[q.quarter_key] = { name: q.name, unit: q.unit, cells };
  }
  return {
    estates: {
      demo: { name: `Демо: ${culture}`, unit: sess.rows[0].unit, quarters }
    }
  };
}
```

Экспортировать.

- [ ] **Step 2: Использовать в endpoint`/api/inventory/...` в демо-режиме**

В `server/server.js` найти `app.get('/api/inventory/:estate/:quarter', ...)` (примерно строка 196). **Обернуть** его в `if (DEMO_MODE)` ветвление:

```js
app.get('/api/inventory/:estate/:quarter', requireAuthMw, async (req, res) => {
  let estate;
  if (DEMO_MODE) {
    const inv = await demo.getDemoInventory(pool, req.demo_session_id);
    estate = inv.estates[req.params.estate];
  } else {
    estate = inventory.estates[req.params.estate];
  }
  if (!estate) return res.status(404).json({ error: 'Estate not found' });
  const quarter = estate.quarters[req.params.quarter];
  // ... остальное как было
});
```

**Важно:** в демо-режиме `requireAuthMw` не нужен (нет auth), но `requireDemo` глобальный уже даёт `req.demo_session_id`. Поэтому в `if (DEMO_MODE)` пути просто не вызываем requireAuthMw — или делаем conditional middleware. Самый простой способ:

```js
function authOrDemo(req, res, next) {
  if (DEMO_MODE) return next(); // requireDemo уже сделал свою работу глобально
  return requireAuthMw(req, res, next);
}
```

И использовать `authOrDemo` вместо `requireAuthMw` на всех data-endpoints (`/api/estates`, `/api/inventory/...`, `/api/logs`, `/api/employees`, `/api/work-types`, `/api/attendance`).

**Это большое изменение по объёму** — потенциально 10+ маршрутов. Делаем массово.

- [ ] **Step 3: Заменить `requireAuthMw` на `authOrDemo` во всех data-endpoints**

В `server/server.js` найти все вызовы `requireAuthMw` и заменить на `authOrDemo`, кроме:
- `/api/me` — в демо не нужен (auth-функция), пусть в демо возвращает 404 (через middleware-фильтр или явный `if (!DEMO_MODE)`).
- `/api/admin/*` — в демо не нужны.

Конкретные маршруты которые получают `authOrDemo`:
- `/api/estates`
- `/api/inventory/:estate`
- `/api/inventory/:estate/:quarter`
- `/api/logs` (POST + GET + DELETE)
- `/api/employees` (GET + POST + DELETE)
- `/api/work-types` (GET + POST + DELETE)
- `/api/attendance` (GET + POST + DELETE)
- `/api/report`

Также в `/api/estates` для демо возвращать список из `getDemoInventory`:
```js
app.get('/api/estates', authOrDemo, async (req, res) => {
  if (DEMO_MODE) {
    const inv = await demo.getDemoInventory(pool, req.demo_session_id);
    const estates = Object.keys(inv.estates).map(id => ({ id, name: inv.estates[id].name }));
    return res.json(estates);
  }
  const estates = Object.keys(inventory.estates).map(id => ({
    id, name: inventory.estates[id].name
  }));
  res.json(estates);
});
```

И аналогично для `/api/inventory/:estate`.

**ПРИМЕЧАНИЕ для исполнителя:** это большой шаг по объёму редактирования. Если есть сомнения — сделать в несколько коммитов: сначала `/api/estates`+`/api/inventory/*`, отдельно `/api/logs`, отдельно остальное. Каждый под-коммит — smoke-тест через `curl`.

- [ ] **Step 4: Также — фильтрация по `demo_session_id` в SQL внутри endpoints**

Это критично для изоляции. В endpoint'ах `/api/employees`, `/api/work-types`, `/api/attendance`, `/api/logs` сейчас фильтруется по `brigadier_id`. В демо надо вместо этого фильтровать по `demo_session_id`. Пример для `/api/employees` GET:

```js
app.get('/api/employees', authOrDemo, async (req, res) => {
  try {
    let r;
    if (DEMO_MODE) {
      r = await pool.query('SELECT id, name FROM employees WHERE demo_session_id=$1 ORDER BY name', [req.demo_session_id]);
    } else {
      r = await pool.query('SELECT id, name FROM employees WHERE brigadier_id=$1 ORDER BY name', [req.brigadier.id]);
    }
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
```

И аналогично для POST/DELETE — при создании добавлять `demo_session_id`, при поиске/удалении фильтровать.

**Это паттерн, который повторяется во всех data-endpoints.** Применить везде.

- [ ] **Step 5: Smoke полный**

С `DEMO_MODE=true`:
- Создать сессию.
- Ввести культуру.
- `GET /api/estates` — увидеть `[{id:"demo", name:"Демо: <культура>"}]`.
- `GET /api/employees` — увидеть 3 сотрудника.
- `GET /api/work-types` — увидеть 6 видов работ.
- `GET /api/inventory/demo/1` — увидеть кварталы и клетки.
- Создать вторую сессию в другом браузере/инкогнито, ввести другую культуру — увидеть **другие** данные.

- [ ] **Step 6: Commit (можно несколько коммитов внутри этой task)**

```
git add server/demo.js server/server.js
git commit -m "feat(demo): authOrDemo middleware, per-session filtering in all data endpoints"
```

---

### Task 1.7: Ленивая очистка устаревших сессий

**Files:**
- Modify: `server/demo.js`, `server/server.js`

**Контекст.** Раз в N запросов (с малой вероятностью) или раз в N минут вычищаем `demo_sessions` старше 24ч. Каскады удалят зависимые строки.

- [ ] **Step 1: Функция `cleanupOldSessions(pool)` в `server/demo.js`**

```js
let lastCleanup = 0;
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000; // не чаще раза в 10 минут

async function maybeCleanup(pool) {
  const now = Date.now();
  if (now - lastCleanup < CLEANUP_INTERVAL_MS) return;
  lastCleanup = now;
  try {
    const r = await pool.query(
      `DELETE FROM demo_sessions WHERE created_at < NOW() - INTERVAL '24 hours' RETURNING id`
    );
    if (r.rows.length > 0) {
      console.log(`🧹 Demo cleanup: удалено ${r.rows.length} устаревших сессий`);
    }
  } catch (err) {
    console.error('demo cleanup error:', err);
  }
}
```

Экспортировать.

- [ ] **Step 2: Вызывать в middleware `requireDemoSession`**

В `server/demo.js` в `requireDemoSession` ДО SELECT-запроса:
```js
return async (req, res, next) => {
  await maybeCleanup(pool); // не чаще раза в 10 минут
  // ... остальное как было
};
```

- [ ] **Step 3: Smoke**

Локально установить TTL на 1 минуту (временно), сделать запросы — увидеть лог cleanup. Вернуть TTL обратно.

Или просто проверить вручную через psql — создать «старую» запись:
```sql
UPDATE demo_sessions SET created_at = NOW() - INTERVAL '25 hours' WHERE id='demo-...';
```
Сделать любой API-запрос (после 10 минут после прошлого cleanup) — увидеть в логе сервера сообщение о cleanup. Проверить что записи исчезли.

- [ ] **Step 4: Commit**

```
git add server/demo.js
git commit -m "feat(demo): lazy cleanup of demo sessions older than 24h"
```

---

### Task 1.8: Endpoint `POST /api/demo/reset` — сброс сессии

**Files:**
- Modify: `server/server.js`

- [ ] **Step 1: Добавить endpoint**

```js
  app.post('/api/demo/reset', requireDemo, async (req, res) => {
    try {
      await pool.query('DELETE FROM demo_sessions WHERE id=$1', [req.demo_session_id]);
      const newId = await demo.createSessionWithSeed(pool);
      res.cookie(demo.COOKIE_NAME, newId, {
        httpOnly: true, secure: true, sameSite: 'lax',
        maxAge: demo.DEMO_SESSION_TTL_MS,
      });
      res.json({ session_id: newId });
    } catch (err) {
      console.error('demo/reset error:', err);
      res.status(500).json({ error: err.message });
    }
  });
```

- [ ] **Step 2: Smoke**

Создать сессию, ввести культуру, добавить пару записей. Вызвать `POST /api/demo/reset`. Проверить что в новой сессии — только заводское наполнение, добавленных записей нет.

- [ ] **Step 3: Commit**

```
git add server/server.js
git commit -m "feat(demo): POST /api/demo/reset clears session and creates new"
```

---

## Этап 2: UI отличия в демо-режиме (2-3 часа)

### Task 2.1: Endpoint `GET /api/config` — конфиг для фронта

**Files:**
- Modify: `server/server.js`

- [ ] **Step 1: Endpoint**

В `server/server.js`, ДО блока demo (потому что `/api/config` доступен и без сессии):

```js
const { BRAND_NAME, BRAND_LOGO, CONTACT_PHONE, MEASURE_MODES } = require('./config');

app.get('/api/config', (req, res) => {
  res.json({
    demoMode: DEMO_MODE,
    brandName: BRAND_NAME,
    brandLogo: BRAND_LOGO,
    contactPhone: CONTACT_PHONE,
    measureModes: MEASURE_MODES,
  });
});
```

- [ ] **Step 2: Smoke**

Без DEMO_MODE: `curl http://localhost:3000/api/config` → `{"demoMode":false, "brandName":"Помощьник Бригадира", ...}`.

С DEMO_MODE=true: `{"demoMode":true, "brandName":"Демо Помощник", "brandLogo":"🌱", ...}`.

- [ ] **Step 3: Commit**

```
git add server/server.js
git commit -m "feat(demo): GET /api/config exposes brand/mode/measure modes to frontend"
```

---

### Task 2.2: Фронт читает config при старте и подставляет название/лого

**Files:**
- Modify: `public/js/app.js`, `public/index.html`

- [ ] **Step 1: Прочитать config в начале `app.js`**

Найти метод инициализации приложения (примерно `init()` или конструктор класса App). В самом начале добавить:

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

Вызывать `await this.loadConfig()` в самом начале `init()`.

- [ ] **Step 2: Подставлять название/лого**

Во всех местах где сейчас в шаблонах строки типа `<h1>🍇 Помощьник Бригадира</h1>` — заменить на `<h1>${this.config.brandLogo} ${this.config.brandName}</h1>`.

В `public/index.html` в `<title>` поставить дефолт «Помощник», но добавить script который меняет на лету:
```html
<script>
fetch('/api/config').then(r => r.json()).then(c => { document.title = c.brandName; });
</script>
```

- [ ] **Step 3: Smoke в браузере**

С `DEMO_MODE=true`: открыть `http://localhost:3000`, увидеть «🌱 Демо Помощник» в шапке и в title вкладки.

Без `DEMO_MODE`: то же что было раньше («🍇 Помощьник Бригадира»).

- [ ] **Step 4: Commit**

```
git add public/index.html public/js/app.js
git commit -m "feat(demo): frontend reads /api/config for brand name and logo"
```

---

### Task 2.3: Баннер «🎯 Это демо…» в шапке

**Files:**
- Create: `public/js/demo-ui.js`
- Modify: `public/js/app.js`, `public/styles.css`

- [ ] **Step 1: Создать `public/js/demo-ui.js` с функцией рендера баннера**

```js
// UI-хелперы для демо-режима. Безопасны на проде — функции просто не вызываются.

function renderDemoBanner(config) {
  if (!config.demoMode) return '';
  return `
    <div class="demo-banner">
      🎯 Это демо. Данные удалятся через сутки. Понравилось — звоните Натали
      <a href="tel:${config.contactPhone}">${config.contactPhone}</a>
    </div>
  `;
}

function renderDemoResetButton() {
  return `
    <button class="demo-reset-btn" onclick="app.resetDemo()">🔄 Начать сначала</button>
  `;
}

window.DemoUI = { renderDemoBanner, renderDemoResetButton };
```

- [ ] **Step 2: Подключить в `index.html` ДО app.js**

```html
<script src="js/demo-ui.js"></script>
<script src="js/app.js"></script>
```

- [ ] **Step 3: Вставить баннер в верх шаблона главной**

В `app.js`, в функции рендера главной (где `<h1>${this.config.brandLogo}...`), **перед** `<h1>` добавить:

```js
${window.DemoUI.renderDemoBanner(this.config)}
```

- [ ] **Step 4: Стили баннера в `public/styles.css`**

```css
.demo-banner {
  background: #fff3cd;
  border-left: 4px solid #f0ad4e;
  padding: 8px 12px;
  font-size: 14px;
  color: #5a3a00;
  margin: 0 0 8px;
  border-radius: 4px;
}
.demo-banner a { color: #4a8fc2; text-decoration: none; }
.demo-banner a:hover { text-decoration: underline; }

.demo-reset-btn {
  background: #6ab0e3;
  color: #fff;
  border: none;
  border-radius: 4px;
  padding: 4px 10px;
  font-size: 13px;
  cursor: pointer;
}
.demo-reset-btn:hover { background: #4a8fc2; }
```

- [ ] **Step 5: Реализовать `app.resetDemo()`**

В классе App в `app.js`:

```js
async resetDemo() {
  if (!confirm('Точно? Все твои записи удалятся, начнётся новая чистая сессия.')) return;
  try {
    await fetch('/api/demo/reset', { method: 'POST' });
    location.reload();
  } catch (e) {
    alert('Не удалось сбросить: ' + e.message);
  }
}
```

И встроить кнопку рядом с baner-ом или в шапку:

```js
${this.config.demoMode ? window.DemoUI.renderDemoResetButton() : ''}
```

- [ ] **Step 6: Smoke в браузере**

С `DEMO_MODE=true`: открыть, увидеть баннер вверху, увидеть кнопку «Начать сначала». Нажать кнопку — confirm → reload → новая сессия с заводским наполнением.

- [ ] **Step 7: Commit**

```
git add public/js/demo-ui.js public/js/app.js public/index.html public/styles.css
git commit -m "feat(demo): banner + reset button with confirm"
```

---

### Task 2.4: Скрытие auth-элементов в демо-режиме

**Files:**
- Modify: `public/js/app.js`

- [ ] **Step 1: Найти все места рендера auth-UI**

Это: кнопка «Выйти», плашка имени бригадира, формы login/register, экран setup. Обернуть в `if (!this.config.demoMode)`.

В демо-режиме главный экран сразу показывает «приложение» (если есть культура) или «модалку ввода культуры» (если нет).

- [ ] **Step 2: Логика «есть культура / нет культуры»**

В init() после `loadConfig()`:

```js
if (this.config.demoMode) {
  // Демо: убедимся что сессия создана
  await fetch('/api/demo/session', { method: 'POST' });
  // Проверим есть ли культура
  const r = await fetch('/api/estates');
  const estates = await r.json();
  if (estates.length === 0) {
    this.renderCultureModal();
    return;
  }
  this.estate = estates[0].id;
  this.renderMain();
  return;
}

// Прод-флоу: как раньше — проверка /api/me и логин
// ...
```

- [ ] **Step 3: Реализовать `renderCultureModal()`**

```js
renderCultureModal() {
  const root = document.getElementById('root');
  root.innerHTML = `
    <div class="container auth-box">
      ${window.DemoUI.renderDemoBanner(this.config)}
      <h1>${this.config.brandLogo} ${this.config.brandName}</h1>
      <p class="auth-hint">Введи свою культуру — что у тебя растёт?</p>
      <div class="form-group">
        <label>Например: виноград, яблоня, черешня, клубника</label>
        <input type="text" id="culture-input" autofocus>
      </div>
      <button onclick="app.submitCulture()">Продолжить</button>
      <div id="culture-msg" class="auth-msg"></div>
    </div>
  `;
}

async submitCulture() {
  const culture = document.getElementById('culture-input').value.trim();
  const msg = document.getElementById('culture-msg');
  if (!culture) { msg.textContent = '❌ Укажи культуру'; return; }
  try {
    const r = await fetch('/api/demo/culture', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ culture }),
    });
    const data = await r.json();
    if (data.needUnit) {
      this.renderUnitChoice(culture);
      return;
    }
    if (!r.ok) { msg.textContent = '❌ ' + (data.error || 'Ошибка'); return; }
    location.reload();
  } catch (e) { msg.textContent = '❌ ' + e.message; }
}

renderUnitChoice(culture) {
  const root = document.getElementById('root');
  root.innerHTML = `
    <div class="container auth-box">
      ${window.DemoUI.renderDemoBanner(this.config)}
      <h1>${this.config.brandLogo} ${this.config.brandName}</h1>
      <p class="auth-hint">У культуры «${culture}» — что считаем?</p>
      <button onclick="app.submitCultureWithUnit('${culture}', 'bush')">🌱 Кусты</button>
      <button onclick="app.submitCultureWithUnit('${culture}', 'tree')">🌳 Деревья</button>
      <button onclick="app.submitCultureWithUnit('${culture}', 'other')">🌾 Другое (растения)</button>
    </div>
  `;
}

async submitCultureWithUnit(culture, unit) {
  await fetch('/api/demo/culture', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ culture, unit }),
  });
  location.reload();
}
```

- [ ] **Step 4: Smoke**

С DEMO_MODE=true:
1. Открыть `http://localhost:3000` в инкогнито.
2. Увидеть модалку ввода культуры.
3. Ввести «виноград» → попадаешь в приложение, в выпадашке «Кв.1», «Кв.2», в плашке сотрудников Иванов/Петров/Сидоров.
4. В другом инкогнито-окне ввести «яблоня» → у меня в первом окне виноград, во втором — яблоня, не пересекаются.

- [ ] **Step 5: Commit**

```
git add public/js/app.js
git commit -m "feat(demo): culture input modal, unit choice, auth UI hidden in demo mode"
```

---

## Self-Review Checklist (выполнить после реализации всех task'ов перед merge)

- [ ] **Spec coverage:**
  - Этап 0 (Подготовка): покрыт Task 0.1, 0.2, 0.3 ✓
  - Этап 1 (Изоляция): покрыт Task 1.1–1.8 ✓
  - Этап 2 (UI отличия): покрыт Task 2.1–2.4 ✓
  - Этапы 3–9: НЕ покрыты этой фазой (это правильно, см. Phase scope).

- [ ] **Никаких placeholders в реализации.** Поиск по проекту: `grep -r 'TODO\|FIXME\|TBD' server/ public/` — должен показать только спеку.

- [ ] **Не сломан прод.** Без `DEMO_MODE`: `npm start` стартует, миграции применяются, существующие endpoints работают, регистрация/логин не сломаны.

- [ ] **Изоляция реально работает.** Два инкогнито-окна: каждое со своими данными.

- [ ] **Cookie корректна.** В DevTools видна cookie `demo_session` с `HttpOnly`, `Secure`, `SameSite=Lax`, `Max-Age` ~86400.

- [ ] **Cleanup срабатывает.** Симулировать «старую» сессию (UPDATE created_at), сделать запрос через 10+ минут — увидеть в логе сервера сообщение об удалении.

---

## Что дальше — Фаза 2

После завершения Фазы 1 пишем `2026-05-23-demo-helper-phase2.md`:
- Этап 3: 5 режимов подсчёта в UI, default_measure_mode у видов работ, переключение терминологии куст/дерево/растения, мягкая ссылка «❓ Нужны другие единицы».
- Этап 4: Журнал в новом формате — сначала в боевом, потом копируется в демо.

Фаза 3 — после ответа мужа Натали и выбора хостинга:
- Этап 5: Механизированные работы (вторая плашка, новые поля).
- Этап 6: Отчёт двумя блоками.
- Этап 7: Пошаговый гайд.
- Этап 8: Локальные тесты полного сценария.
- Этап 9: Деплой.
