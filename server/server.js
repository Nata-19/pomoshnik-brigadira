const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const { Pool } = require('pg');
const fs = require('fs');
const DataParser = require('./parser');
const rowControl = require('./rowControl');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const auth = require('./auth');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();
app.set('trust proxy', 1); // за HTTPS-прокси Render

// Security-заголовки. CSP отключаем — inline-скрипты PWA ломаются дефолтным CSP,
// а настройка под наш набор файлов отдельная история. HSTS, X-Frame-Options,
// X-Content-Type-Options, Referrer-Policy и пр. — включены.
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));

const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ limit: '10mb', extended: true }));
app.use(cookieParser());

// Защита от перебора пароля: 5 попыток входа в минуту с одного IP.
// Применяется к POST /api/login, /api/register, /api/setup (см. ниже).
const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Слишком много попыток. Подожди минуту и попробуй снова.' },
});

// Статические файлы
app.use(express.static(path.join(__dirname, '../public')));

// Postgres (Neon на проде, можно локально)
if (!process.env.DATABASE_URL) {
  console.error('❌ DATABASE_URL не задан. Укажи строку подключения к Postgres.');
  process.exit(1);
}

// Защита от случайного включения DEMO_MODE с боевой БД.
// PROD_DB_FINGERPRINT — короткая подстрока из connection string боевого Neon
// (например, имя его endpoint типа 'ep-cool-cloud-xxx'). Задаётся в env
// демо-деплоя. Если задано и совпадает в DATABASE_URL — отказ запуска.
const { DEMO_MODE } = require('./config');
const { BRAND_NAME, BRAND_LOGO, CONTACT_PHONE, MEASURE_MODES } = require('./config');
const prodFingerprint = process.env.PROD_DB_FINGERPRINT || '';
if (DEMO_MODE && prodFingerprint && process.env.DATABASE_URL.includes(prodFingerprint)) {
  console.error('❌ DEMO_MODE=true И DATABASE_URL содержит PROD_DB_FINGERPRINT — это похоже на боевую БД. Запуск отменён.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

pool.on('error', (err) => console.error('PG pool error:', err));

let SESSION_SECRET = null;
const getSecret = () => SESSION_SECRET;

(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS work_logs (
        id SERIAL PRIMARY KEY,
        date TEXT NOT NULL,
        quarter TEXT NOT NULL,
        cell TEXT NOT NULL,
        employee TEXT NOT NULL,
        rows TEXT NOT NULL,
        bushes INTEGER NOT NULL,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`
      ALTER TABLE work_logs ADD COLUMN IF NOT EXISTS estate_id TEXT NOT NULL DEFAULT 'estate1'
    `);
    await pool.query(`
      ALTER TABLE work_logs ADD COLUMN IF NOT EXISTS brigadier_id INTEGER
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS brigadiers (
        id SERIAL PRIMARY KEY,
        login TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        is_admin BOOLEAN NOT NULL DEFAULT false,
        label TEXT,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
    const secretRow = await pool.query(
      "SELECT value FROM app_settings WHERE key = 'session_secret'"
    );
    if (secretRow.rows.length > 0) {
      SESSION_SECRET = secretRow.rows[0].value;
    } else {
      SESSION_SECRET = crypto.randomBytes(48).toString('hex');
      await pool.query(
        "INSERT INTO app_settings (key, value) VALUES ('session_secret', $1)",
        [SESSION_SECRET]
      );
    }
    // --- Этап 2: списки и колонки для структурированного ввода ---
    await pool.query(`ALTER TABLE work_logs ADD COLUMN IF NOT EXISTS work_type TEXT NOT NULL DEFAULT ''`);
    await pool.query(`ALTER TABLE work_logs ADD COLUMN IF NOT EXISTS measure_mode TEXT NOT NULL DEFAULT 'rows_bushes'`);
    await pool.query(`ALTER TABLE work_logs ADD COLUMN IF NOT EXISTS hours INTEGER`);
    await pool.query(`ALTER TABLE work_logs ADD COLUMN IF NOT EXISTS hectares NUMERIC(8,2)`);
    await pool.query(`ALTER TABLE work_logs ADD COLUMN IF NOT EXISTS kilometers NUMERIC(8,2)`);
    await pool.query(`ALTER TABLE work_logs ADD COLUMN IF NOT EXISTS row_weights TEXT`);
    // Бэкфилл: существующим записям с рядами проставить вес каждого ряда = 1
    // (каждый ряд как целый). Ничего не удаляем и не меняем в rows/bushes.
    await pool.query(`
      UPDATE work_logs
      SET row_weights = (
        SELECT jsonb_object_agg(t.r, 1)::text
        FROM unnest(string_to_array(rows, ',')) AS t(r)
        WHERE t.r <> ''
      )
      WHERE row_weights IS NULL AND rows IS NOT NULL AND rows <> ''
    `);
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
    await pool.query(`
      CREATE TABLE IF NOT EXISTS disputed_rows (
        id SERIAL PRIMARY KEY,
        brigadier_id INTEGER,
        demo_session_id TEXT,
        estate_id TEXT NOT NULL,
        quarter TEXT NOT NULL,
        cell TEXT NOT NULL,
        work_type TEXT NOT NULL,
        row_num INTEGER NOT NULL,
        measure_mode TEXT NOT NULL DEFAULT 'rows_bushes',
        claimed_by TEXT NOT NULL,
        claimed_date TEXT NOT NULL,
        note TEXT,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
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
    // Пост-релизные ограничения целостности: CHECK на режим и FK с каскадом
    // на явку. Сначала чистим возможные сироты (на случай старых данных),
    // потом добавляем ограничения только если их ещё нет — идемпотентно.
    await pool.query(`DELETE FROM attendance WHERE employee_id NOT IN (SELECT id FROM employees)`);
    await pool.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_measure_mode') THEN
          ALTER TABLE work_logs
            ADD CONSTRAINT chk_measure_mode
            CHECK (measure_mode IN ('rows_bushes', 'rows_only', 'hours'));
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_attendance_employee') THEN
          ALTER TABLE attendance
            ADD CONSTRAINT fk_attendance_employee
            FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE;
        END IF;
      END $$;
    `);

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
    // disputed_rows.demo_session_id создаётся без FK в общем CREATE (в боевом demo_sessions нет).
    // В демо навешиваем каскад отдельно и идемпотентно — чтобы спорные чистились вместе с сессией.
    await pool.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'disputed_rows_demo_session_fk') THEN
          ALTER TABLE disputed_rows
            ADD CONSTRAINT disputed_rows_demo_session_fk
            FOREIGN KEY (demo_session_id) REFERENCES demo_sessions(id) ON DELETE CASCADE;
        END IF;
      END $$;
    `);

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
    // Хозяйство одно (одна demo-сессия), но культур внутри несколько.
    // Колонка culture группирует кварталы по культурам — каждая культура
    // становится отдельной «плашкой» в выпадающем «Выбор культуры».
    await pool.query(`ALTER TABLE demo_quarters ADD COLUMN IF NOT EXISTS culture TEXT`);
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
    // Уникальность учитывает kind: «Опрыскивание» бывает и ручное, и механизированное —
    // это разные виды работ. Старые индексы (без kind) дропаем если они есть.
    await pool.query(`DROP INDEX IF EXISTS work_types_prod_name_uniq`);
    await pool.query(`DROP INDEX IF EXISTS work_types_demo_name_uniq`);
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS work_types_prod_name_kind_uniq
        ON work_types(name, kind) WHERE demo_session_id IS NULL
    `);
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS work_types_demo_name_kind_uniq
        ON work_types(demo_session_id, name, kind) WHERE demo_session_id IS NOT NULL
    `);

    // Аналогично для employees: исходный UNIQUE (brigadier_id, name) не учитывал
    // demo_session_id, поэтому две демо-сессии не могли иметь одного и того же
    // «Иванова» (brigadier_id=0 в обеих). Дропаем старое ограничение и делаем
    // два partial-unique-index'а: прод (demo_session_id IS NULL) и демо (с учётом сессии).
    await pool.query(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'employees_brigadier_id_name_key') THEN
          ALTER TABLE employees DROP CONSTRAINT employees_brigadier_id_name_key;
        END IF;
      END $$;
    `);
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS employees_prod_brig_name_uniq
        ON employees(brigadier_id, name) WHERE demo_session_id IS NULL
    `);
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS employees_demo_sess_name_uniq
        ON employees(demo_session_id, name) WHERE demo_session_id IS NOT NULL
    `);

    console.log('✅ Connected to Postgres');
  } catch (err) {
    console.error('❌ Postgres init failed:', err.message);
    process.exit(1);
  }
})();

// Загружаем инвентаризацию (на Render — из Secret Files, локально — из корня проекта)
const inventoryPath = process.env.INVENTORY_PATH || path.join(__dirname, '../inventory.json');
const inventory = JSON.parse(fs.readFileSync(inventoryPath, 'utf8'));
if (!inventory.estates || typeof inventory.estates !== 'object') {
  console.error('❌ inventory.json должен содержать поле "estates" (новый формат с namespace по хозяйствам).');
  process.exit(1);
}
const parser = new DataParser(inventory);

// Middleware «требуется вход» — переиспользуется на всех защищённых маршрутах.
const requireAuthMw = auth.requireAuth(pool, getSecret);

// В демо-режиме requireDemo (глобальный) уже отработал и положил req.demo_session_id.
// В проде — используем обычный requireAuthMw. Эта обёртка применяется на data-endpoints.
function authOrDemo(req, res, next) {
  if (DEMO_MODE) return next();
  return requireAuthMw(req, res, next);
}

function setAuthCookie(res, token) {
  res.cookie('token', token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: 365 * 24 * 60 * 60 * 1000,
  });
}

app.get('/api/config', (req, res) => {
  res.json({
    demoMode: DEMO_MODE,
    brandName: BRAND_NAME,
    brandLogo: BRAND_LOGO,
    contactPhone: CONTACT_PHONE,
    measureModes: MEASURE_MODES,
  });
});

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

  // Все API кроме /api/demo/session и /api/config требуют валидной сессии.
  const requireDemo = demo.requireDemoSession(pool);
  app.use((req, res, next) => {
    if (!req.path.startsWith('/api/')) return next();
    if (req.path === '/api/demo/session') return next();
    if (req.path === '/api/config') return next();
    return requireDemo(req, res, next);
  });

  app.post('/api/demo/culture', requireDemo, async (req, res) => {
    try {
      const { culture, unit } = req.body;
      if (!culture || !culture.trim()) {
        return res.status(400).json({ error: 'Укажи культуру' });
      }
      const detectedUnit = unit || demo.detectUnit(culture);
      if (!detectedUnit) {
        return res.json({ needUnit: true });
      }
      if (!['bush', 'tree', 'other'].includes(detectedUnit)) {
        return res.status(400).json({ error: 'unit должен быть bush/tree/other' });
      }
      const name = culture.trim();
      if (req.demo_session.culture) {
        // Уже была культура — это «+ ещё культура»: добавляем 1 квартал
        // с инвентарём, не пересоздаём хозяйство.
        const existing = req.demo_session.culture.split(/\s*\+\s*/).filter(Boolean);
        if (existing.includes(name)) {
          return res.status(400).json({ error: 'Эта культура уже добавлена' });
        }
        await demo.addCulture(pool, req.demo_session_id, name, detectedUnit);
        return res.json({ culture: name, unit: detectedUnit, added: true });
      }
      await demo.seedEstate(pool, req.demo_session_id, name, detectedUnit);
      res.json({ culture: name, unit: detectedUnit });
    } catch (err) {
      console.error('demo/culture error:', err);
      res.status(500).json({ error: err.message });
    }
  });

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
}

// API endpoints
app.get('/api/estates', authOrDemo, async (req, res) => {
  try {
    if (DEMO_MODE) {
      const inv = await demo.getDemoInventory(pool, req.demo_session_id);
      const estates = Object.keys(inv.estates).map(id => ({ id, name: inv.estates[id].name }));
      return res.json(estates);
    }
    const estates = Object.keys(inventory.estates).map(id => ({
      id,
      name: inventory.estates[id].name
    }));
    res.json(estates);
  } catch (err) {
    console.error('GET /api/estates error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/quarters', authOrDemo, async (req, res) => {
  try {
    const estateId = req.query.estate;
    if (!estateId) {
      return res.status(400).json({ error: 'Укажи estate' });
    }
    let estate;
    if (DEMO_MODE) {
      const inv = await demo.getDemoInventory(pool, req.demo_session_id);
      estate = inv.estates[estateId];
    } else {
      estate = inventory.estates[estateId];
    }
    if (!estate) {
      return res.status(404).json({ error: 'Хозяйство не найдено' });
    }
    const quarters = Object.keys(estate.quarters).map(key => ({
      id: key,
      name: estate.quarters[key].name,
      unit: estate.quarters[key].unit || null,
    }));
    res.json(quarters);
  } catch (err) {
    console.error('GET /api/quarters error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/inventory/:estate/:quarter', authOrDemo, async (req, res) => {
  try {
    let estate;
    if (DEMO_MODE) {
      const inv = await demo.getDemoInventory(pool, req.demo_session_id);
      estate = inv.estates[req.params.estate];
    } else {
      estate = inventory.estates[req.params.estate];
    }
    if (!estate) {
      return res.status(404).json({ error: 'Estate not found' });
    }
    const quarter = estate.quarters[req.params.quarter];
    if (!quarter) {
      return res.status(404).json({ error: 'Quarter not found' });
    }
    res.json(quarter);
  } catch (err) {
    console.error('GET /api/inventory error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Обработка ввода данных (текстовый формат)
app.post('/api/process', authOrDemo, async (req, res) => {
  try {
    const { date, input, estate, quarter, cell } = req.body;

    if (!date || !input) {
      return res.status(400).json({ error: 'Некорректный формат ввода' });
    }
    if (!estate) {
      return res.status(400).json({ error: 'Не выбрано хозяйство' });
    }

    let invForParser, parserToUse;
    if (DEMO_MODE) {
      invForParser = await demo.getDemoInventory(pool, req.demo_session_id);
      parserToUse = new DataParser(invForParser);
    } else {
      invForParser = inventory;
      parserToUse = parser;
    }

    const { entries } = parserToUse.parse(input, date, { estate, quarter, cell });
    const report = parserToUse.formatReport(date, entries, invForParser);

    for (const entry of entries) {
      if (DEMO_MODE) {
        await pool.query(
          `INSERT INTO work_logs (date, estate_id, quarter, cell, employee, rows, bushes, brigadier_id, demo_session_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [date, entry.estate, entry.quarter, entry.cell, entry.employee,
           entry.rows.join(','), entry.bushes, 0, req.demo_session_id]
        );
      } else {
        await pool.query(
          `INSERT INTO work_logs (date, estate_id, quarter, cell, employee, rows, bushes, brigadier_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [date, entry.estate, entry.quarter, entry.cell, entry.employee,
           entry.rows.join(','), entry.bushes, req.brigadier.id]
        );
      }
    }

    res.json({ success: true, report });
  } catch (error) {
    console.error(error);
    res.status(400).json({ error: error.message });
  }
});

// Первичная настройка: создание админ-аккаунта (работает, пока админа нет).
app.get('/api/setup-needed', async (req, res) => {
  try {
    const r = await pool.query("SELECT 1 FROM brigadiers WHERE is_admin = true LIMIT 1");
    res.json({ needed: r.rows.length === 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/setup', authLimiter, async (req, res) => {
  try {
    const adminExists = await pool.query(
      "SELECT 1 FROM brigadiers WHERE is_admin = true LIMIT 1"
    );
    if (adminExists.rows.length > 0) {
      return res.status(400).json({ error: 'Настройка уже выполнена' });
    }
    const { login, password } = req.body;
    if (!login || !login.trim()) {
      return res.status(400).json({ error: 'Укажи логин' });
    }
    if (!password || password.length < 8) {
      return res.status(400).json({ error: 'Пароль не короче 8 символов' });
    }
    const ins = await pool.query(
      `INSERT INTO brigadiers (login, password_hash, status, is_admin)
       VALUES ($1, $2, 'active', true) RETURNING id`,
      [login.trim(), auth.hashPassword(password)]
    );
    const adminId = ins.rows[0].id;
    // Существующие записи привязываем к админу.
    await pool.query(
      'UPDATE work_logs SET brigadier_id = $1 WHERE brigadier_id IS NULL',
      [adminId]
    );
    setAuthCookie(res, auth.signToken(adminId, SESSION_SECRET));
    res.json({ success: true });
  } catch (err) {
    console.error('Setup error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Регистрация — создаёт аккаунт в статусе «ожидает подтверждения».
app.post('/api/register', authLimiter, async (req, res) => {
  try {
    const { login, password } = req.body;
    if (!login || !login.trim()) {
      return res.status(400).json({ error: 'Укажи логин' });
    }
    if (!password || password.length < 8) {
      return res.status(400).json({ error: 'Пароль не короче 8 символов' });
    }
    const exists = await pool.query(
      'SELECT 1 FROM brigadiers WHERE LOWER(login) = LOWER($1)',
      [login.trim()]
    );
    if (exists.rows.length > 0) {
      return res.status(400).json({ error: 'Логин занят' });
    }
    await pool.query(
      "INSERT INTO brigadiers (login, password_hash, status) VALUES ($1, $2, 'pending')",
      [login.trim(), auth.hashPassword(password)]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Вход — разрешён только для статуса active.
app.post('/api/login', authLimiter, async (req, res) => {
  try {
    const { login, password } = req.body;
    if (!login || !password) {
      return res.status(400).json({ error: 'Укажи логин и пароль' });
    }
    const r = await pool.query(
      'SELECT * FROM brigadiers WHERE LOWER(login) = LOWER($1)',
      [login.trim()]
    );
    const brigadier = r.rows[0];
    if (!brigadier || !auth.verifyPassword(password, brigadier.password_hash)) {
      return res.status(401).json({ error: 'Неверный логин или пароль' });
    }
    if (brigadier.status === 'pending') {
      return res.status(403).json({ error: 'Заявка ещё не подтверждена администратором' });
    }
    if (brigadier.status === 'disabled') {
      return res.status(403).json({ error: 'Аккаунт отключён, обратитесь к администратору' });
    }
    setAuthCookie(res, auth.signToken(brigadier.id, SESSION_SECRET));
    res.json({ success: true });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/logout', (req, res) => {
  // Express clearCookie сматчит куку только если опции совпадают с теми,
  // что были при установке. Без этих флагов браузер игнорировал удаление
  // и Set-Cookie от login оставался жить (баг найден 2026-05-21).
  res.clearCookie('token', {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
  });
  res.json({ success: true });
});

app.get('/api/me', requireAuthMw, (req, res) => {
  res.json({ login: req.brigadier.login, is_admin: req.brigadier.is_admin });
});

// --- Админские endpoint'ы (только для is_admin) ---
app.get('/api/admin/brigadiers', requireAuthMw, auth.requireAdmin, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, login, status, is_admin, label, created_at
       FROM brigadiers ORDER BY created_at DESC`
    );
    res.json({ brigadiers: r.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/brigadiers/:id/approve', requireAuthMw, auth.requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    await pool.query(
      "UPDATE brigadiers SET status = 'active' WHERE id = $1 AND status = 'pending'",
      [id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/brigadiers/:id/disable', requireAuthMw, auth.requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (id === req.brigadier.id) {
      return res.status(400).json({ error: 'Нельзя отключить свой аккаунт' });
    }
    await pool.query("UPDATE brigadiers SET status = 'disabled' WHERE id = $1", [id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/brigadiers/:id/enable', requireAuthMw, auth.requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    await pool.query(
      "UPDATE brigadiers SET status = 'active' WHERE id = $1 AND status = 'disabled'",
      [id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/brigadiers/:id/label', requireAuthMw, auth.requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const label = (req.body.label || '').trim() || null;
    await pool.query('UPDATE brigadiers SET label = $1 WHERE id = $2', [label, id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/brigadiers/:id/reset-password', requireAuthMw, auth.requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { password } = req.body;
    if (!password || password.length < 8) {
      return res.status(400).json({ error: 'Пароль не короче 8 символов' });
    }
    await pool.query(
      'UPDATE brigadiers SET password_hash = $1 WHERE id = $2',
      [auth.hashPassword(password), id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Этап 2: сотрудники (личный список бригадира) ---
app.get('/api/employees', authOrDemo, async (req, res) => {
  try {
    let r;
    if (DEMO_MODE) {
      r = await pool.query('SELECT id, name FROM employees WHERE demo_session_id=$1 ORDER BY name', [req.demo_session_id]);
    } else {
      r = await pool.query('SELECT id, name FROM employees WHERE brigadier_id = $1 ORDER BY name', [req.brigadier.id]);
    }
    res.json({ employees: r.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/employees', authOrDemo, async (req, res) => {
  try {
    const name = (req.body.name || '').trim();
    if (!name) {
      return res.status(400).json({ error: 'Укажи фамилию' });
    }
    if (DEMO_MODE) {
      const exists = await pool.query(
        'SELECT 1 FROM employees WHERE demo_session_id = $1 AND name = $2',
        [req.demo_session_id, name]
      );
      if (exists.rows.length > 0) {
        return res.status(400).json({ error: 'Такой сотрудник уже есть' });
      }
      const ins = await pool.query(
        'INSERT INTO employees (brigadier_id, name, demo_session_id) VALUES ($1, $2, $3) RETURNING id, name',
        [0, name, req.demo_session_id]
      );
      return res.json({ employee: ins.rows[0] });
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

app.delete('/api/employees/:id', authOrDemo, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: 'Неверный id' });
    }
    // FK с ON DELETE CASCADE сам уберёт записи явки этого сотрудника.
    let result;
    if (DEMO_MODE) {
      result = await pool.query(
        'DELETE FROM employees WHERE id = $1 AND demo_session_id = $2 RETURNING id',
        [id, req.demo_session_id]
      );
    } else {
      result = await pool.query(
        'DELETE FROM employees WHERE id = $1 AND brigadier_id = $2 RETURNING id',
        [id, req.brigadier.id]
      );
    }
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Сотрудник не найден' });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Этап 2: виды работ (общий список) ---
app.get('/api/work-types', authOrDemo, async (req, res) => {
  try {
    let r;
    if (DEMO_MODE) {
      r = await pool.query('SELECT id, name, default_measure_mode, kind FROM work_types WHERE demo_session_id=$1 ORDER BY name', [req.demo_session_id]);
    } else {
      r = await pool.query('SELECT id, name, default_measure_mode, kind FROM work_types ORDER BY name');
    }
    res.json({ work_types: r.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/work-types', authOrDemo, async (req, res) => {
  try {
    const name = (req.body.name || '').trim();
    const mode = (req.body.default_measure_mode || '').trim() || 'rows_bushes';
    // На боевом механизированные виды работ запрещены — даже если приходит
    // kind='mechanized' через прямой запрос, форсим 'manual'. Это покрытие
    // на случай если кто-то обратится к API минуя UI.
    const requestedKind = (req.body.kind === 'mechanized') ? 'mechanized' : 'manual';
    const kind = DEMO_MODE ? requestedKind : 'manual';
    if (!name) {
      return res.status(400).json({ error: 'Укажи название вида работ' });
    }
    if (!MEASURE_MODES.includes(mode)) {
      return res.status(400).json({ error: 'Неизвестный режим подсчёта' });
    }
    if (DEMO_MODE) {
      const exists = await pool.query(
        'SELECT 1 FROM work_types WHERE demo_session_id = $1 AND LOWER(name) = LOWER($2) AND kind = $3',
        [req.demo_session_id, name, kind]
      );
      if (exists.rows.length > 0) {
        return res.status(400).json({ error: 'Такой вид работ уже есть' });
      }
      const ins = await pool.query(
        'INSERT INTO work_types (name, default_measure_mode, kind, demo_session_id) VALUES ($1, $2, $3, $4) RETURNING id, name, default_measure_mode, kind',
        [name, mode, kind, req.demo_session_id]
      );
      return res.json({ work_type: ins.rows[0] });
    }
    const exists = await pool.query(
      'SELECT 1 FROM work_types WHERE LOWER(name) = LOWER($1) AND kind = $2',
      [name, kind]
    );
    if (exists.rows.length > 0) {
      return res.status(400).json({ error: 'Такой вид работ уже есть' });
    }
    const ins = await pool.query(
      'INSERT INTO work_types (name, default_measure_mode, kind) VALUES ($1, $2, $3) RETURNING id, name, default_measure_mode, kind',
      [name, mode, kind]
    );
    res.json({ work_type: ins.rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ error: 'Такой вид работ уже есть' });
    }
    res.status(500).json({ error: err.message });
  }
});

// --- Этап 2: явка (кто сегодня на работе) ---
app.get('/api/attendance', authOrDemo, async (req, res) => {
  try {
    const date = req.query.date;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'Дата в формате YYYY-MM-DD' });
    }
    let r;
    if (DEMO_MODE) {
      r = await pool.query(
        `SELECT a.employee_id, e.name
         FROM attendance a JOIN employees e ON e.id = a.employee_id
         WHERE a.demo_session_id = $1 AND a.date = $2
         ORDER BY e.name`,
        [req.demo_session_id, date]
      );
    } else {
      r = await pool.query(
        `SELECT a.employee_id, e.name
         FROM attendance a JOIN employees e ON e.id = a.employee_id
         WHERE a.brigadier_id = $1 AND a.date = $2
         ORDER BY e.name`,
        [req.brigadier.id, date]
      );
    }
    res.json({ present: r.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/attendance', authOrDemo, async (req, res) => {
  try {
    const { date, employee_id } = req.body;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'Дата в формате YYYY-MM-DD' });
    }
    const eid = parseInt(employee_id, 10);
    if (!Number.isInteger(eid)) {
      return res.status(400).json({ error: 'Неверный id сотрудника' });
    }
    if (DEMO_MODE) {
      const own = await pool.query(
        'SELECT 1 FROM employees WHERE id = $1 AND demo_session_id = $2',
        [eid, req.demo_session_id]
      );
      if (own.rows.length === 0) {
        return res.status(404).json({ error: 'Сотрудник не найден' });
      }
      await pool.query(
        `INSERT INTO attendance (brigadier_id, date, employee_id, demo_session_id) VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING`,
        [0, date, eid, req.demo_session_id]
      );
    } else {
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
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/attendance', authOrDemo, async (req, res) => {
  try {
    const { date, employee_id } = req.body;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'Дата в формате YYYY-MM-DD' });
    }
    const eid = parseInt(employee_id, 10);
    if (!Number.isInteger(eid)) {
      return res.status(400).json({ error: 'Неверный id сотрудника' });
    }
    if (DEMO_MODE) {
      await pool.query(
        'DELETE FROM attendance WHERE demo_session_id = $1 AND date = $2 AND employee_id = $3',
        [req.demo_session_id, date, eid]
      );
    } else {
      await pool.query(
        'DELETE FROM attendance WHERE brigadier_id = $1 AND date = $2 AND employee_id = $3',
        [req.brigadier.id, date, eid]
      );
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Возвращает плоский список занятых рядов в разрезе хозяйство+квартал+клетка+вид работ.
// ownerCol — внутреннее имя колонки владельца ('demo_session_id' или 'brigadier_id'),
// не пользовательский ввод, поэтому подставляется в SQL напрямую.
async function getOccupiedRows(ownerCol, ownerVal, estate, quarter, cell, workType) {
  const r = await pool.query(
    `SELECT id, date, employee, rows, measure_mode FROM work_logs
     WHERE ${ownerCol} = $1 AND estate_id = $2 AND quarter = $3 AND cell = $4
       AND work_type = $5 AND measure_mode IN ('rows_bushes', 'rows_only')`,
    [ownerVal, estate, String(quarter), String(cell), workType]
  );
  const occ = [];
  for (const rec of r.rows) {
    const nums = String(rec.rows || '')
      .split(',')
      .map((s) => parseInt(s, 10))
      .filter((n) => Number.isInteger(n));
    for (const n of nums) {
      occ.push({ row: n, date: rec.date, employee: rec.employee, logId: rec.id, measure_mode: rec.measure_mode });
    }
  }
  return occ;
}

// Владелец записей в текущем режиме (демо — по сессии, прод — по бригадиру).
function rowOwner(req) {
  return DEMO_MODE
    ? { col: 'demo_session_id', val: req.demo_session_id }
    : { col: 'brigadier_id', val: req.brigadier.id };
}

// Снимает ряд rowNum из записи logId (того же владельца) и пишет результат в БД:
// если рядов не осталось — удаляет запись, иначе обновляет rows + bushes.
// removedRowBushes — кусты ряда по инвентаризации (rows_only → 0). Возвращает true,
// если запись найдена и обработана, иначе false.
async function applyRowRemoval(ownerCol, ownerVal, logId, rowNum, rowBushes) {
  const rec = await pool.query(
    `SELECT rows, row_weights, bushes FROM work_logs WHERE id = $1 AND ${ownerCol} = $2`,
    [logId, ownerVal]
  );
  if (rec.rowCount === 0) return false;
  const out = rowControl.removeRowFromRecord(
    rec.rows[0].rows, rec.rows[0].row_weights, rec.rows[0].bushes, rowNum, rowBushes
  );
  if (!out.found) return false;
  if (out.deleted) {
    await pool.query(`DELETE FROM work_logs WHERE id = $1 AND ${ownerCol} = $2`, [logId, ownerVal]);
  } else {
    await pool.query(
      `UPDATE work_logs SET rows = $1, row_weights = $2, bushes = $3 WHERE id = $4 AND ${ownerCol} = $5`,
      [out.rows, out.weights, out.bushes, logId, ownerVal]
    );
  }
  return true;
}

// Заносит ряд в disputed_rows с учётом владельца (демо — по сессии, прод — по бригадиру).
async function insertDisputed(d, owner, req) {
  if (DEMO_MODE) {
    await pool.query(
      `INSERT INTO disputed_rows
        (estate_id, quarter, cell, work_type, row_num, measure_mode, claimed_by, claimed_date, demo_session_id, brigadier_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [d.estate, d.quarter, d.cell, d.work_type, d.row_num, d.measure_mode,
       d.claimed_by, d.claimed_date, req.demo_session_id, 0]
    );
    return;
  }
  await pool.query(
    `INSERT INTO disputed_rows
      (estate_id, quarter, cell, work_type, row_num, measure_mode, claimed_by, claimed_date, brigadier_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [d.estate, d.quarter, d.cell, d.work_type, d.row_num, d.measure_mode,
     d.claimed_by, d.claimed_date, req.brigadier.id]
  );
}

// Записывает ряд rowNum рабочему emp в указанном разрезе (ctx) с долей кустов bushes.
// «Одна плашка на рабочего в клетке»: если у рабочего уже есть запись в этом
// разрезе и дате — ряд добавляется к ней и кусты прибавляются; иначе создаётся
// новая запись на один ряд. Демо/прод по DEMO_MODE.
// ctx: { date, estate, quarter, cell, work_type, measure_mode }.
async function upsertWorkLog(ownerCol, ownerVal, req, ctx, emp, rowNum, bushes, weight) {
  const ex = await pool.query(
    `SELECT id, rows, row_weights, bushes FROM work_logs
     WHERE ${ownerCol} = $1 AND date = $2 AND estate_id = $3 AND quarter = $4
       AND cell = $5 AND work_type = $6 AND measure_mode = $7 AND employee = $8
     ORDER BY id LIMIT 1`,
    [ownerVal, ctx.date, ctx.estate, String(ctx.quarter), String(ctx.cell), ctx.work_type, ctx.measure_mode, emp]
  );
  if (ex.rowCount > 0) {
    const rec = ex.rows[0];
    const nums = String(rec.rows || '').split(',').map((s) => parseInt(s, 10)).filter((n) => Number.isInteger(n));
    if (!nums.includes(rowNum)) nums.push(rowNum);
    nums.sort((a, b) => a - b);
    const w = rowControl.parseRowWeights(rec.row_weights);
    w[rowNum] = weight;
    await pool.query(
      `UPDATE work_logs SET rows = $1, row_weights = $2, bushes = $3 WHERE id = $4 AND ${ownerCol} = $5`,
      [nums.join(','), rowControl.serializeRowWeights(w), (rec.bushes || 0) + bushes, rec.id, ownerVal]
    );
    return;
  }
  const wjson = rowControl.serializeRowWeights({ [rowNum]: weight });
  if (DEMO_MODE) {
    await pool.query(
      `INSERT INTO work_logs
        (date, estate_id, quarter, cell, employee, rows, row_weights, bushes, brigadier_id, demo_session_id, work_type, measure_mode, hours)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [ctx.date, ctx.estate, String(ctx.quarter), String(ctx.cell), emp, String(rowNum), wjson, bushes, 0, req.demo_session_id, ctx.work_type, ctx.measure_mode, null]
    );
  } else {
    await pool.query(
      `INSERT INTO work_logs
        (date, estate_id, quarter, cell, employee, rows, row_weights, bushes, brigadier_id, work_type, measure_mode, hours)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [ctx.date, ctx.estate, String(ctx.quarter), String(ctx.cell), emp, String(rowNum), wjson, bushes, req.brigadier.id, ctx.work_type, ctx.measure_mode, null]
    );
  }
}

// --- Этап 2: создание одной записи журнала (структурированный ввод) ---
app.post('/api/logs', authOrDemo, async (req, res) => {
  try {
    const { date, estate, quarter, cell, work_type, measure_mode, employee, rows, hours } = req.body;

    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'Дата в формате YYYY-MM-DD' });
    }

    let invForParser, parserToUse;
    if (DEMO_MODE) {
      invForParser = await demo.getDemoInventory(pool, req.demo_session_id);
      parserToUse = new DataParser(invForParser);
    } else {
      invForParser = inventory;
      parserToUse = parser;
    }

    if (!estate || !invForParser.estates[estate]) {
      return res.status(400).json({ error: 'Не выбрано хозяйство' });
    }
    if (!employee || !employee.trim()) {
      return res.status(400).json({ error: 'Выбери сотрудника' });
    }
    if (!work_type || !work_type.trim()) {
      return res.status(400).json({ error: 'Выбери вид работ' });
    }
    if (!MEASURE_MODES.includes(measure_mode)) {
      return res.status(400).json({ error: 'Неизвестный режим подсчёта' });
    }

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
      // Бригадир отмечает ряды и несколько клеток сразу (трактор проходит
      // по нескольким клеткам одного квартала). cell приходит строкой
      // вида «1,2,3». Считаем гектары на каждую клетку и суммируем —
      // одна запись с диапазоном клеток и общими гектарами.
      if (!quarter || !cell) {
        return res.status(400).json({ error: 'Выбери клетку' });
      }
      const cellsArr = String(cell).split(',').map(x => x.trim()).filter(Boolean);
      if (cellsArr.length === 0) {
        return res.status(400).json({ error: 'Выбери клетку' });
      }
      let rowNums;
      try {
        rowNums = parserToUse.parseRowList(rows);
      } catch (e) {
        return res.status(400).json({ error: e.message });
      }
      rowsStr = rowNums.join(',');
      let totalHa = 0;
      for (const c of cellsArr) {
        try {
          totalHa += parserToUse.getHectaresForRows(estate, String(quarter), c, rowNums);
        } catch (e) {
          return res.status(400).json({ error: `Клет.${c}: ` + e.message });
        }
      }
      hectaresVal = Math.round(totalHa * 100) / 100;
      if (!isFinite(hectaresVal) || hectaresVal <= 0) {
        return res.status(400).json({ error: 'Не удалось посчитать гектары' });
      }
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

      // Контроль пересечений — только для режимов с кустами/рядами, под которые
      // он спроектирован (rows_bushes / rows_only). Прочие «рядовые» режимы демо
      // (столбы, тонны, погонные метры и т.п.) попадают в этот же else, но их не
      // трогаем — для них деление/разрешение конфликта не предусмотрено.
      if (measure_mode === 'rows_bushes' || measure_mode === 'rows_only') {
        // Детект пересечений рядов в разрезе вида работ (по владельцу режима).
        const owner = rowOwner(req);
        const occupied = await getOccupiedRows(owner.col, owner.val, estate, String(quarter), String(cell), work_type.trim());
        const cls = rowControl.classifyRows(rowNums, occupied, date);

        // К каждому конфликту добавляем кусты ряда (для подсказки в окне деления).
        const withBushes = (arr) => arr.map((c) => {
          let rb = 0;
          if (measure_mode === 'rows_bushes') {
            try { rb = parserToUse.getBushesCount(estate, String(quarter), String(cell), [c.row]); } catch { rb = 0; }
          }
          return { ...c, rowBushes: rb };
        });
        const conflictsOut = { sameDay: withBushes(cls.sameDay), otherDay: withBushes(cls.otherDay) };

        // Все ряды заняты — ничего не сохраняем, отдаём конфликты на разрешение.
        if (cls.free.length === 0 && (cls.sameDay.length || cls.otherDay.length)) {
          return res.json({ success: false, savedRows: [], conflicts: conflictsOut });
        }

        // Сохраняем только свободные ряды; конфликтные вернём клиенту.
        rowNums = cls.free;
        req._rowConflicts = conflictsOut;
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

    // Вес каждого введённого ряда = 1 (целый ряд). Для hours/без рядов — null.
    let rowWeightsStr = null;
    if (rowsStr) {
      const wobj = {};
      for (const n of rowsStr.split(',')) if (n.trim()) wobj[n.trim()] = 1;
      rowWeightsStr = rowControl.serializeRowWeights(wobj);
    }

    // Защита от непреднамеренных дублей: если ровно такая же запись была
    // создана в последние 10 секунд — отказываем. Случайный повторный тап
    // через несколько секунд после ответа не пройдёт, а намеренная одинаковая
    // запись позже этого окна — пройдёт.
    if (DEMO_MODE) {
      const dup = await pool.query(
        `SELECT id FROM work_logs
         WHERE demo_session_id = $1 AND date = $2 AND estate_id = $3
           AND quarter = $4 AND cell = $5 AND employee = $6
           AND work_type = $7 AND measure_mode = $8
           AND COALESCE(rows, '') = COALESCE($9, '')
           AND COALESCE(hours, -1) = COALESCE($10, -1)
           AND created_at > NOW() - INTERVAL '10 seconds'
         LIMIT 1`,
        [req.demo_session_id, date, estate,
         quarter ? String(quarter) : '', cell ? String(cell) : '',
         employee.trim(), work_type.trim(), measure_mode,
         rowsStr, hoursVal]
      );
      if (dup.rows.length > 0) {
        return res.status(409).json({ error: 'Такая же запись только что добавлена' });
      }
      const ins = await pool.query(
        `INSERT INTO work_logs
          (date, estate_id, quarter, cell, employee, rows, row_weights, bushes, brigadier_id, demo_session_id, work_type, measure_mode, hours, hectares, kilometers)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
         RETURNING id`,
        [date, estate, quarter ? String(quarter) : '', cell ? String(cell) : '',
         employee.trim(), rowsStr, rowWeightsStr, bushes, 0, req.demo_session_id,
         work_type.trim(), measure_mode, hoursVal, hectaresVal, kilometersVal]
      );
      return res.json({
        success: true,
        id: ins.rows[0].id,
        savedRows: rowsStr ? rowsStr.split(',') : [],
        conflicts: req._rowConflicts || { sameDay: [], otherDay: [] },
      });
    }

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
        (date, estate_id, quarter, cell, employee, rows, row_weights, bushes, brigadier_id, work_type, measure_mode, hours, hectares, kilometers)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING id`,
      [date, estate, quarter ? String(quarter) : '', cell ? String(cell) : '',
       employee.trim(), rowsStr, rowWeightsStr, bushes, req.brigadier.id,
       work_type.trim(), measure_mode, hoursVal, hectaresVal, kilometersVal]
    );
    res.json({
      success: true,
      id: ins.rows[0].id,
      savedRows: rowsStr ? rowsStr.split(',') : [],
      conflicts: req._rowConflicts || { sameDay: [], otherDay: [] },
    });
  } catch (error) {
    console.error('Create log error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Разрешение конфликта рядов: деление «тот же день» и запись «другой день».
// Демо-осознанно: владелец и парсер выбираются по DEMO_MODE, как в /api/logs.
app.post('/api/logs/resolve', authOrDemo, async (req, res) => {
  try {
    const { action, date, estate, quarter, cell, work_type, measure_mode, row, employee, firstLogId, assignments } = req.body;

    let invForParser, parserToUse;
    if (DEMO_MODE) {
      invForParser = await demo.getDemoInventory(pool, req.demo_session_id);
      parserToUse = new DataParser(invForParser);
    } else {
      invForParser = inventory;
      parserToUse = parser;
    }

    if (!estate || !invForParser.estates[estate]) {
      return res.status(400).json({ error: 'Не выбрано хозяйство' });
    }
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'Дата в формате YYYY-MM-DD' });
    }
    if (!['rows_bushes', 'rows_only'].includes(measure_mode)) {
      return res.status(400).json({ error: 'Режим должен быть с рядами' });
    }
    if (!quarter || !cell) {
      return res.status(400).json({ error: 'Не указаны квартал и клетка' });
    }
    if (!work_type || !work_type.trim()) {
      return res.status(400).json({ error: 'Не выбран вид работ' });
    }
    const rowNum = parseInt(row, 10);
    if (!Number.isInteger(rowNum)) {
      return res.status(400).json({ error: 'Неверный номер ряда' });
    }
    if (!employee || !employee.trim()) {
      return res.status(400).json({ error: 'Не указан рабочий' });
    }

    // Кусты ряда из инвентаризации текущего режима (для rows_only — 0).
    let rowBushes = 0;
    if (measure_mode === 'rows_bushes') {
      try {
        rowBushes = parserToUse.getBushesCount(estate, String(quarter), String(cell), [rowNum]);
      } catch (e) {
        return res.status(400).json({ error: e.message });
      }
    }

    const owner = rowOwner(req);
    const ctx = { date, estate, quarter, cell, work_type: work_type.trim(), measure_mode };

    if (action === 'reassign' || action === 'postpone') {
      // «Разные дни»: оба варианта снимают ряд с первого рабочего (firstLogId),
      // отличаются тем, что делать дальше — записать второму или отложить в спорные.
      const fid = parseInt(firstLogId, 10);
      if (!Number.isInteger(fid)) {
        return res.status(400).json({ error: 'Не указана запись первого рабочего' });
      }
      // Запись первого должна принадлежать тому же владельцу и тому же разрезу
      // (без фильтра по дате — у первого она в ДРУГОЙ день).
      const firstRec = await pool.query(
        `SELECT employee, date FROM work_logs
         WHERE id = $1 AND ${owner.col} = $2 AND estate_id = $3
           AND quarter = $4 AND cell = $5 AND work_type = $6`,
        [fid, owner.val, estate, String(quarter), String(cell), work_type.trim()]
      );
      if (firstRec.rowCount === 0) {
        return res.status(404).json({ error: 'Запись первого рабочего не найдена' });
      }

      if (action === 'reassign') {
        if (firstRec.rows[0].employee === employee.trim()) {
          return res.status(400).json({ error: 'Ряд уже записан на этого рабочего' });
        }
        const removed = await applyRowRemoval(owner.col, owner.val, fid, rowNum, rowBushes);
        if (!removed) {
          return res.status(409).json({ error: 'Ряд уже снят с первого рабочего' });
        }
        // Ряд целиком — второму рабочему (одна плашка: слияние с его записью).
        await upsertWorkLog(owner.col, owner.val, req, ctx, employee.trim(), rowNum, rowBushes, 1);
        return res.json({ success: true });
      }

      // postpone: снимаем ряд с первого; если снять нечего — 409; иначе в «Спорные».
      const removed = await applyRowRemoval(owner.col, owner.val, fid, rowNum, rowBushes);
      if (!removed) {
        return res.status(409).json({ error: 'Ряд уже снят с первого рабочего' });
      }
      await insertDisputed({
        estate, quarter: String(quarter), cell: String(cell),
        work_type: work_type.trim(), row_num: rowNum, measure_mode,
        claimed_by: firstRec.rows[0].employee, claimed_date: firstRec.rows[0].date,
      }, owner, req);
      return res.json({ success: true });
    }

    if (action === 'divide') {
      // Поделить ряд между НЕСКОЛЬКИМИ рабочими. Ряд снимается со ВСЕХ его
      // текущих держателей в этом разрезе (это делает повторное деление верным),
      // затем раздаётся отмеченным. Вес ряда у каждого: rows_bushes — кусты/всего;
      // rows_only — поровну (или ручная доля). Сумма весов ряда = 1.
      const list = Array.isArray(assignments) ? assignments : [];
      const cleaned = list
        .map((a) => ({
          employee: a && a.employee ? String(a.employee).trim() : '',
          bushes: (a && a.bushes !== null && a.bushes !== undefined && a.bushes !== '') ? parseInt(a.bushes, 10) : null,
          weight: (a && a.weight !== null && a.weight !== undefined && a.weight !== '') ? Number(a.weight) : null,
        }))
        .filter((a) => a.employee);
      if (cleaned.length === 0) {
        return res.status(400).json({ error: 'Выбери хотя бы одного рабочего' });
      }

      // Считаем кусты и веса по режиму.
      let toAssign;
      if (measure_mode !== 'rows_bushes') {
        const weights = rowControl.fillWeights(cleaned.map((a) => a.weight));
        toAssign = cleaned.map((a, i) => ({ employee: a.employee, bushes: 0, weight: weights[i] }));
      } else {
        for (const a of cleaned) {
          if (a.bushes !== null && (!Number.isInteger(a.bushes) || a.bushes < 0)) {
            return res.status(400).json({ error: 'Кусты должны быть неотрицательным числом' });
          }
        }
        const explicitSum = cleaned.reduce((s, a) => s + (a.bushes !== null ? a.bushes : 0), 0);
        const blanksCount = cleaned.filter((a) => a.bushes === null).length;
        const remaining = Math.max(rowBushes - explicitSum, 0);
        const shares = rowControl.distributeBushes(remaining, blanksCount);
        let bi = 0;
        const withBushes = cleaned.map((a) => ({
          employee: a.employee,
          bushes: a.bushes !== null ? a.bushes : shares[bi++],
        }));
        const weights = rowControl.weightsFromBushes(rowBushes, withBushes.map((a) => a.bushes));
        toAssign = withBushes.map((a, i) => ({ employee: a.employee, bushes: a.bushes, weight: weights[i] }));
      }

      // Снимаем ряд со всех держателей этого разреза — БЕЗ фильтра по дате:
      // при делении «другой день» запись занявшего лежит на другую дату, а при
      // повторном делении держателей может быть несколько. id уникален, разрез
      // (владелец+хозяйство+квартал+клетка+вид работ+режим) ограничивает выборку.
      const holders = await pool.query(
        `SELECT id, rows FROM work_logs
         WHERE ${owner.col} = $1 AND estate_id = $2
           AND quarter = $3 AND cell = $4 AND work_type = $5 AND measure_mode = $6`,
        [owner.val, estate, String(quarter), String(cell), work_type.trim(), measure_mode]
      );
      let strippedAny = false;
      for (const h of holders.rows) {
        const nums = String(h.rows || '').split(',').map((s) => parseInt(s, 10)).filter((n) => Number.isInteger(n));
        if (nums.includes(rowNum)) {
          const ok = await applyRowRemoval(owner.col, owner.val, h.id, rowNum, rowBushes);
          if (ok) strippedAny = true;
        }
      }
      if (!strippedAny) {
        return res.status(409).json({ error: 'Ряд уже снят' });
      }

      for (const a of toAssign) {
        await upsertWorkLog(owner.col, owner.val, req, ctx, a.employee, rowNum, a.bushes, a.weight);
      }
      return res.json({ success: true });
    }

    return res.status(400).json({ error: 'Неизвестное действие' });
  } catch (error) {
    console.error('Resolve error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Список спорных рядов владельца по хозяйству.
app.get('/api/disputed', authOrDemo, async (req, res) => {
  try {
    const { estate } = req.query;
    if (!estate) return res.status(400).json({ error: 'Укажи estate' });
    let result;
    if (DEMO_MODE) {
      result = await pool.query(
        `SELECT id, estate_id, quarter, cell, work_type, row_num, measure_mode, claimed_by, claimed_date
         FROM disputed_rows WHERE demo_session_id = $1 AND estate_id = $2
         ORDER BY created_at DESC`,
        [req.demo_session_id, estate]
      );
    } else {
      result = await pool.query(
        `SELECT id, estate_id, quarter, cell, work_type, row_num, measure_mode, claimed_by, claimed_date
         FROM disputed_rows WHERE brigadier_id = $1 AND estate_id = $2
         ORDER BY created_at DESC`,
        [req.brigadier.id, estate]
      );
    }
    let parserToUse;
    if (DEMO_MODE) parserToUse = new DataParser(await demo.getDemoInventory(pool, req.demo_session_id));
    else parserToUse = parser;
    const disputed = result.rows.map((d) => {
      let rb = 0;
      if (d.measure_mode === 'rows_bushes') {
        try { rb = parserToUse.getBushesCount(d.estate_id, String(d.quarter), String(d.cell), [d.row_num]); } catch { rb = 0; }
      }
      return { ...d, row_bushes: rb };
    });
    res.json({ disputed });
  } catch (error) {
    console.error('Disputed list error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Разбор спорного ряда:
//   'assign-actual' — записать тем, кто реально делал: один или несколько рабочих,
//      кусты ряда делятся (assignments: [{employee, bushes?}], пустые доли — поровну);
//   'return-first'  — вернуть заявителю (одна запись с полными кустами ряда).
// Все записи создаются на дату claimed_date; ряд считается одним. После — ряд
// убирается из спорных.
app.post('/api/disputed/:id/resolve', authOrDemo, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Некорректный id' });
    }
    const { action, assignments, date } = req.body;
    if (!['assign-actual', 'return-first'].includes(action)) {
      return res.status(400).json({ error: 'Неизвестное действие' });
    }

    const owner = rowOwner(req);
    const rec = await pool.query(
      `SELECT * FROM disputed_rows WHERE id = $1 AND ${owner.col} = $2`,
      [id, owner.val]
    );
    if (rec.rowCount === 0) {
      return res.status(404).json({ error: 'Спорный ряд не найден' });
    }
    const d = rec.rows[0];

    // Кусты ряда из инвентаризации текущего режима (для rows_only = 0).
    let parserToUse;
    if (DEMO_MODE) {
      parserToUse = new DataParser(await demo.getDemoInventory(pool, req.demo_session_id));
    } else {
      parserToUse = parser;
    }
    let rowBushes = 0;
    if (d.measure_mode === 'rows_bushes') {
      try {
        rowBushes = parserToUse.getBushesCount(d.estate_id, String(d.quarter), String(d.cell), [d.row_num]);
      } catch (e) {
        return res.status(400).json({ error: e.message });
      }
    }

    // Формируем список (рабочий, кусты) для вставки.
    let toInsert = [];
    if (action === 'return-first') {
      toInsert = [{ employee: d.claimed_by, bushes: rowBushes, weight: 1 }];
    } else {
      const list = Array.isArray(assignments) ? assignments : [];
      const cleaned = list
        .map((a) => ({
          employee: a && a.employee ? String(a.employee).trim() : '',
          bushes: (a && a.bushes !== null && a.bushes !== undefined && a.bushes !== '') ? parseInt(a.bushes, 10) : null,
          weight: (a && a.weight !== null && a.weight !== undefined && a.weight !== '') ? Number(a.weight) : null,
        }))
        .filter((a) => a.employee);
      if (cleaned.length === 0) {
        return res.status(400).json({ error: 'Выбери хотя бы одного рабочего' });
      }
      if (d.measure_mode !== 'rows_bushes') {
        const weights = rowControl.fillWeights(cleaned.map((a) => a.weight));
        toInsert = cleaned.map((a, i) => ({ employee: a.employee, bushes: 0, weight: weights[i] }));
      } else {
        for (const a of cleaned) {
          if (a.bushes !== null && (!Number.isInteger(a.bushes) || a.bushes < 0)) {
            return res.status(400).json({ error: 'Кусты должны быть неотрицательным числом' });
          }
        }
        const explicitSum = cleaned.reduce((s, a) => s + (a.bushes !== null ? a.bushes : 0), 0);
        const blanksCount = cleaned.filter((a) => a.bushes === null).length;
        const remaining = Math.max(rowBushes - explicitSum, 0);
        const shares = rowControl.distributeBushes(remaining, blanksCount);
        let bi = 0;
        const withBushes = cleaned.map((a) => ({
          employee: a.employee,
          bushes: a.bushes !== null ? a.bushes : shares[bi++],
        }));
        const weights = rowControl.weightsFromBushes(rowBushes, withBushes.map((a) => a.bushes));
        toInsert = withBushes.map((a, i) => ({ employee: a.employee, bushes: a.bushes, weight: weights[i] }));
      }
    }

    // Записываем долю каждому рабочему — одна плашка на рабочего в клетке (слияние).
    // Дата разбора — «сегодня» (клиент шлёт date); если не пришла/некорректна —
    // запасной вариант дата заявки.
    const resolveDate = (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) ? date : d.claimed_date;
    const ctx = {
      date: resolveDate, estate: d.estate_id, quarter: d.quarter,
      cell: d.cell, work_type: d.work_type, measure_mode: d.measure_mode,
    };
    for (const a of toInsert) {
      await upsertWorkLog(owner.col, owner.val, req, ctx, a.employee, d.row_num, a.bushes, a.weight);
    }

    await pool.query(
      `DELETE FROM disputed_rows WHERE id = $1 AND ${owner.col} = $2`,
      [id, owner.val]
    );
    res.json({ success: true });
  } catch (error) {
    console.error('Disputed resolve error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Health-check для UptimeRobot и Render
app.get('/health', (req, res) => res.json({ ok: true }));

// Список записей за день (для журнала + удаления). Фильтр по хозяйству обязателен.
app.get('/api/logs', authOrDemo, async (req, res) => {
  try {
    const { date, from, to, estate } = req.query;
    // В демо estate может быть не задан (плашка «Всего за день» хочет ВСЁ
    // за день по всем культурам сразу). В проде estate обязателен — бригадир
    // явно выбирает хозяйство.
    if (!DEMO_MODE && !estate) {
      return res.status(400).json({ error: 'Укажи estate' });
    }
    let result;
    if (DEMO_MODE) {
      if (date) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          return res.status(400).json({ error: 'Дата в формате YYYY-MM-DD' });
        }
        if (estate) {
          result = await pool.query(
            `SELECT id, date, estate_id, quarter, cell, employee, rows, bushes, work_type, measure_mode, hours, hectares, kilometers, created_at
             FROM work_logs WHERE date = $1 AND estate_id = $2 AND demo_session_id = $3
             ORDER BY created_at DESC`,
            [date, estate, req.demo_session_id]
          );
        } else {
          result = await pool.query(
            `SELECT id, date, estate_id, quarter, cell, employee, rows, bushes, work_type, measure_mode, hours, hectares, kilometers, created_at
             FROM work_logs WHERE date = $1 AND demo_session_id = $2
             ORDER BY created_at DESC`,
            [date, req.demo_session_id]
          );
        }
      } else if (from && to) {
        if (estate) {
          result = await pool.query(
            `SELECT id, date, estate_id, quarter, cell, employee, rows, bushes, work_type, measure_mode, hours, hectares, kilometers, created_at
             FROM work_logs WHERE date >= $1 AND date <= $2 AND estate_id = $3 AND demo_session_id = $4
             ORDER BY date DESC, created_at DESC`,
            [from, to, estate, req.demo_session_id]
          );
        } else {
          result = await pool.query(
            `SELECT id, date, estate_id, quarter, cell, employee, rows, bushes, work_type, measure_mode, hours, hectares, kilometers, created_at
             FROM work_logs WHERE date >= $1 AND date <= $2 AND demo_session_id = $3
             ORDER BY date DESC, created_at DESC`,
            [from, to, req.demo_session_id]
          );
        }
      } else {
        return res.status(400).json({ error: 'Укажи date или from+to' });
      }
    } else {
      if (date) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          return res.status(400).json({ error: 'Дата в формате YYYY-MM-DD' });
        }
        result = await pool.query(
          `SELECT id, date, estate_id, quarter, cell, employee, rows, bushes, work_type, measure_mode, hours, hectares, kilometers, created_at
           FROM work_logs WHERE date = $1 AND estate_id = $2 AND brigadier_id = $3
           ORDER BY created_at DESC`,
          [date, estate, req.brigadier.id]
        );
      } else if (from && to) {
        result = await pool.query(
          `SELECT id, date, estate_id, quarter, cell, employee, rows, bushes, work_type, measure_mode, hours, hectares, kilometers, created_at
           FROM work_logs WHERE date >= $1 AND date <= $2 AND estate_id = $3 AND brigadier_id = $4
           ORDER BY date DESC, created_at DESC`,
          [from, to, estate, req.brigadier.id]
        );
      } else {
        return res.status(400).json({ error: 'Укажи date или from+to' });
      }
    }
    res.json({ logs: result.rows });
  } catch (error) {
    console.error('Logs list error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Удаление записи
app.delete('/api/logs/:id', authOrDemo, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Некорректный id' });
    }
    let result;
    if (DEMO_MODE) {
      result = await pool.query(
        'DELETE FROM work_logs WHERE id = $1 AND demo_session_id = $2 RETURNING *',
        [id, req.demo_session_id]
      );
    } else {
      result = await pool.query(
        'DELETE FROM work_logs WHERE id = $1 AND brigadier_id = $2 RETURNING *',
        [id, req.brigadier.id]
      );
    }
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Запись не найдена' });
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Delete error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Отчёт за период: группировка по сотруднику → квартал/клетка (в рамках одного хозяйства)
app.get('/api/report', authOrDemo, async (req, res) => {
  try {
    const { from, to, estate } = req.query;
    if (!from || !to) {
      return res.status(400).json({ error: 'Укажи даты from и to (YYYY-MM-DD)' });
    }
    if (!estate) {
      return res.status(400).json({ error: 'Укажи estate' });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      return res.status(400).json({ error: 'Даты в формате YYYY-MM-DD' });
    }
    if (from > to) {
      return res.status(400).json({ error: 'Дата "От" позже даты "До"' });
    }

    let result;
    if (DEMO_MODE) {
      result = await pool.query(
        `SELECT date, estate_id, quarter, cell, employee, rows, row_weights, bushes, work_type, measure_mode, hours
         FROM work_logs
         WHERE date >= $1 AND date <= $2 AND estate_id = $3 AND demo_session_id = $4
         ORDER BY employee, work_type, date`,
        [from, to, estate, req.demo_session_id]
      );
    } else {
      result = await pool.query(
        `SELECT date, estate_id, quarter, cell, employee, rows, row_weights, bushes, work_type, measure_mode, hours
         FROM work_logs
         WHERE date >= $1 AND date <= $2 AND estate_id = $3 AND brigadier_id = $4
         ORDER BY employee, work_type, date`,
        [from, to, estate, req.brigadier.id]
      );
    }

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

    const newSlot = () => ({ rows: 0, bushes: 0, hours: 0, hasRows: false, hasBushes: false, hasHours: false });
    const unitText = (s) => {
      const p = [];
      if (s.hasRows) p.push(`${rowControl.formatRows(s.rows)} рядов`);
      if (s.hasBushes) p.push(`${s.bushes} кустов`);
      if (s.hasHours) p.push(`${s.hours} часов`);
      return p.join(', ');
    };
    const addRec = (slot, r) => {
      if (r.measure_mode === 'hours') {
        slot.hours += r.hours || 0;
        slot.hasHours = true;
      } else {
        slot.rows += rowControl.weightOfRecord(r.rows, r.row_weights);
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

    // Сводка «Всего за день» — для каждого дня в периоде агрегируем
    // по (квартал, клетка) поверх всех сотрудников и видов работ. При
    // выборе одного дня (from === to) выходит одна такая секция в конце.
    const byDay = {};
    for (const r of result.rows) {
      if (!byDay[r.date]) byDay[r.date] = {};
      const ck = (r.quarter || '') + '|' + (r.cell || '');
      if (!byDay[r.date][ck]) byDay[r.date][ck] = { quarter: r.quarter, cell: r.cell, slot: newSlot() };
      addRec(byDay[r.date][ck].slot, r);
    }
    const days = Object.keys(byDay).sort();
    for (const day of days) {
      report += `Всего за день ${day}:\n`;
      for (const ck of Object.keys(byDay[day])) {
        const c = byDay[day][ck];
        const where = c.quarter ? `Кв.${c.quarter}, кл.${c.cell}` : 'без клетки';
        report += `  ${where} — ${unitText(c.slot)}\n`;
      }
      report += `\n`;
    }
    report += 'Ряды, кусты и часы суммируются раздельно — каждая единица своя.';
    res.json({ report });
  } catch (error) {
    console.error('Report error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Распознавание речи через Hugging Face Inference API (free tier).
// Браузер шлёт сырой аудио-blob (WebM/Opus), мы прокидываем в HF.
const HF_MODEL = 'openai/whisper-small';
app.post('/api/transcribe',
  requireAuthMw,
  express.raw({ type: ['audio/*', 'application/octet-stream'], limit: '20mb' }),
  async (req, res) => {
    try {
      if (!process.env.HF_TOKEN) {
        return res.status(500).json({
          error: 'HF_TOKEN не задан. Добавь его в переменные окружения Render.'
        });
      }
      if (!req.body || req.body.length === 0) {
        return res.status(400).json({ error: 'Пустой запрос' });
      }

      const contentType = req.get('content-type') || 'audio/webm';
      const r = await fetch(`https://api-inference.huggingface.co/models/${HF_MODEL}`, {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + process.env.HF_TOKEN,
          'Content-Type': contentType,
          'X-Wait-For-Model': 'true', // подождём, если модель «холодная»
        },
        body: req.body,
      });

      if (!r.ok) {
        const errText = await r.text();
        console.error('HF API error:', r.status, errText);
        return res.status(502).json({
          error: 'Hugging Face: ' + r.status + ' ' + errText.slice(0, 200)
        });
      }

      const data = await r.json();
      const text = (data.text || '').trim();
      res.json({ text });
    } catch (error) {
      console.error('Transcribe error:', error);
      res.status(500).json({ error: error.message });
    }
  }
);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🍇 Brigade Assistant запущен на порту ${PORT}`);
});
