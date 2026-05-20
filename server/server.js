const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const { Pool } = require('pg');
const fs = require('fs');
const DataParser = require('./parser');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const auth = require('./auth');

const app = express();
app.set('trust proxy', 1); // за HTTPS-прокси Render
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ limit: '10mb', extended: true }));
app.use(cookieParser());

// Статические файлы
app.use(express.static(path.join(__dirname, '../public')));

// Postgres (Neon на проде, можно локально)
if (!process.env.DATABASE_URL) {
  console.error('❌ DATABASE_URL не задан. Укажи строку подключения к Postgres.');
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

function setAuthCookie(res, token) {
  res.cookie('token', token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: 365 * 24 * 60 * 60 * 1000,
  });
}

// API endpoints
app.get('/api/estates', requireAuthMw, (req, res) => {
  const estates = Object.keys(inventory.estates).map(id => ({
    id,
    name: inventory.estates[id].name
  }));
  res.json(estates);
});

app.get('/api/quarters', requireAuthMw, (req, res) => {
  const estateId = req.query.estate;
  if (!estateId) {
    return res.status(400).json({ error: 'Укажи estate' });
  }
  const estate = inventory.estates[estateId];
  if (!estate) {
    return res.status(404).json({ error: 'Хозяйство не найдено' });
  }
  const quarters = Object.keys(estate.quarters).map(key => ({
    id: key,
    name: estate.quarters[key].name
  }));
  res.json(quarters);
});

app.get('/api/inventory/:estate/:quarter', requireAuthMw, (req, res) => {
  const estate = inventory.estates[req.params.estate];
  if (!estate) {
    return res.status(404).json({ error: 'Estate not found' });
  }
  const quarter = estate.quarters[req.params.quarter];
  if (!quarter) {
    return res.status(404).json({ error: 'Quarter not found' });
  }
  res.json(quarter);
});

// Обработка ввода данных (текстовый формат)
app.post('/api/process', requireAuthMw, async (req, res) => {
  try {
    const { date, input, estate, quarter, cell } = req.body;

    if (!date || !input) {
      return res.status(400).json({ error: 'Некорректный формат ввода' });
    }
    if (!estate) {
      return res.status(400).json({ error: 'Не выбрано хозяйство' });
    }

    const { entries } = parser.parse(input, date, { estate, quarter, cell });
    const report = parser.formatReport(date, entries, inventory);

    for (const entry of entries) {
      await pool.query(
        `INSERT INTO work_logs (date, estate_id, quarter, cell, employee, rows, bushes, brigadier_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [date, entry.estate, entry.quarter, entry.cell, entry.employee,
         entry.rows.join(','), entry.bushes, req.brigadier.id]
      );
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

app.post('/api/setup', async (req, res) => {
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
    if (!password || password.length < 6) {
      return res.status(400).json({ error: 'Пароль не короче 6 символов' });
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
app.post('/api/register', async (req, res) => {
  try {
    const { login, password } = req.body;
    if (!login || !login.trim()) {
      return res.status(400).json({ error: 'Укажи логин' });
    }
    if (!password || password.length < 6) {
      return res.status(400).json({ error: 'Пароль не короче 6 символов' });
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
app.post('/api/login', async (req, res) => {
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
  res.clearCookie('token');
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
    if (!password || password.length < 6) {
      return res.status(400).json({ error: 'Пароль не короче 6 символов' });
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

// Health-check для UptimeRobot и Render
app.get('/health', (req, res) => res.json({ ok: true }));

// Список записей за день (для журнала + удаления). Фильтр по хозяйству обязателен.
app.get('/api/logs', requireAuthMw, async (req, res) => {
  try {
    const { date, from, to, estate } = req.query;
    if (!estate) {
      return res.status(400).json({ error: 'Укажи estate' });
    }
    let result;
    if (date) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({ error: 'Дата в формате YYYY-MM-DD' });
      }
      result = await pool.query(
        `SELECT id, date, estate_id, quarter, cell, employee, rows, bushes, created_at
         FROM work_logs WHERE date = $1 AND estate_id = $2 AND brigadier_id = $3
         ORDER BY created_at DESC`,
        [date, estate, req.brigadier.id]
      );
    } else if (from && to) {
      result = await pool.query(
        `SELECT id, date, estate_id, quarter, cell, employee, rows, bushes, created_at
         FROM work_logs WHERE date >= $1 AND date <= $2 AND estate_id = $3 AND brigadier_id = $4
         ORDER BY date DESC, created_at DESC`,
        [from, to, estate, req.brigadier.id]
      );
    } else {
      return res.status(400).json({ error: 'Укажи date или from+to' });
    }
    res.json({ logs: result.rows });
  } catch (error) {
    console.error('Logs list error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Удаление записи
app.delete('/api/logs/:id', requireAuthMw, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Некорректный id' });
    }
    const result = await pool.query(
      'DELETE FROM work_logs WHERE id = $1 AND brigadier_id = $2 RETURNING *',
      [id, req.brigadier.id]
    );
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
app.get('/api/report', requireAuthMw, async (req, res) => {
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

    const result = await pool.query(
      `SELECT date, estate_id, quarter, cell, employee, rows, bushes
       FROM work_logs
       WHERE date >= $1 AND date <= $2 AND estate_id = $3 AND brigadier_id = $4
       ORDER BY employee, quarter::int, cell::int, date`,
      [from, to, estate, req.brigadier.id]
    );

    if (result.rows.length === 0) {
      return res.json({
        report: `Отчёт за период: ${from} — ${to}\n\nЗа указанный период данных нет.`
      });
    }

    // Группируем: сотрудник → "кв-клетка" → {rows: число, bushes: число}
    const byEmployee = {};
    for (const r of result.rows) {
      if (!byEmployee[r.employee]) byEmployee[r.employee] = {};
      const key = `${r.quarter}|${r.cell}`;
      if (!byEmployee[r.employee][key]) {
        byEmployee[r.employee][key] = { quarter: r.quarter, cell: r.cell, rows: 0, bushes: 0 };
      }
      // rows хранятся как "1,2,3" — считаем количество элементов
      const rowCount = String(r.rows).split(',').filter(x => x.trim()).length;
      byEmployee[r.employee][key].rows += rowCount;
      byEmployee[r.employee][key].bushes += r.bushes;
    }

    // Формируем текст
    let report = `Отчёт за период: ${from} — ${to}\n\n`;
    let totalRows = 0;
    let totalBushes = 0;
    const employees = Object.keys(byEmployee).sort((a, b) => a.localeCompare(b, 'ru'));

    for (const name of employees) {
      report += `${name}\n`;
      let empRows = 0;
      let empBushes = 0;
      const cells = Object.values(byEmployee[name])
        .sort((a, b) => (+a.quarter - +b.quarter) || (+a.cell - +b.cell));
      for (const c of cells) {
        report += `  Кв.${c.quarter}, кл.${c.cell} — ${c.rows} рядов, ${c.bushes} кустов\n`;
        empRows += c.rows;
        empBushes += c.bushes;
      }
      report += `  Итого: ${empRows} рядов, ${empBushes} кустов\n\n`;
      totalRows += empRows;
      totalBushes += empBushes;
    }

    report += `ВСЕГО ЗА ПЕРИОД:\nРяды: ${totalRows}\nКусты: ${totalBushes}`;
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
