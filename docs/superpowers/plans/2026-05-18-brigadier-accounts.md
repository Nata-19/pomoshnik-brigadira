# Brigadier Accounts & Data Isolation (Stage 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add multi-tenant accounts to the vineyard app — brigadiers register, an admin approves them, each brigadier logs in with a password and sees only their own work logs.

**Architecture:** A new `server/auth.js` module holds password hashing (bcryptjs), JWT cookie signing (jsonwebtoken) and auth middleware. `server/server.js` gains a `brigadiers` table, an `app_settings` table (auto-generated cookie secret), a `brigadier_id` column on `work_logs`, auth/admin/setup endpoints, and a per-brigadier filter on every data endpoint. The client (`public/js/app.js`) gains setup / login / register screens and an admin tab; the main app renders only after login.

**Tech Stack:** Node.js, Express, PostgreSQL (Neon), bcryptjs, jsonwebtoken, cookie-parser. Vanilla-JS PWA client.

**Testing note:** The project has no test framework and one is not being added (per the spec). Pure functions in `server/auth.js` are verified with a one-off `node -e` script. Everything else is verified with `node --check` (syntax) plus the manual checklist in Task 9.

**Repo is public:** never commit passwords, logins, secrets, company names, grape varieties, or Excel filenames.

---

### Task 1: Add dependencies

**Files:**
- Modify: `package.json` — `dependencies`

- [ ] **Step 1: Add the three packages to package.json**

Replace the `dependencies` block in `package.json` with:

```json
  "dependencies": {
    "bcryptjs": "^2.4.3",
    "body-parser": "^1.20.2",
    "cookie-parser": "^1.4.7",
    "cors": "^2.8.5",
    "express": "^4.18.2",
    "jsonwebtoken": "^9.0.2",
    "multer": "^2.1.1",
    "pg": "^8.20.0"
  }
```

- [ ] **Step 2: Install**

Run: `npm install`
Expected: completes without errors; `bcryptjs`, `cookie-parser`, `jsonwebtoken` appear in `node_modules`.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "Add bcryptjs, jsonwebtoken, cookie-parser dependencies

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 2: Auth module (`server/auth.js`)

**Files:**
- Create: `server/auth.js`

- [ ] **Step 1: Create `server/auth.js`**

```js
// Аутентификация: хэширование паролей, JWT-токены входа, middleware.
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const TOKEN_TTL = '365d'; // вход живёт 1 год

function hashPassword(plain) {
  return bcrypt.hashSync(plain, 10);
}

function verifyPassword(plain, hash) {
  return bcrypt.compareSync(plain, hash);
}

function signToken(brigadierId, secret) {
  return jwt.sign({ id: brigadierId }, secret, { expiresIn: TOKEN_TTL });
}

function verifyToken(token, secret) {
  try {
    return jwt.verify(token, secret); // { id, iat, exp }
  } catch (e) {
    return null;
  }
}

// Фабрика middleware: требует вошедшего активного бригадира.
// getSecret — функция, возвращающая текущий секрет подписи.
function requireAuth(pool, getSecret) {
  return async (req, res, next) => {
    try {
      const token = req.cookies && req.cookies.token;
      if (!token) return res.status(401).json({ error: 'Требуется вход' });
      const payload = verifyToken(token, getSecret());
      if (!payload) return res.status(401).json({ error: 'Требуется вход' });
      const r = await pool.query(
        'SELECT id, login, status, is_admin FROM brigadiers WHERE id = $1',
        [payload.id]
      );
      const brigadier = r.rows[0];
      if (!brigadier || brigadier.status !== 'active') {
        return res.status(401).json({ error: 'Требуется вход' });
      }
      req.brigadier = brigadier;
      next();
    } catch (err) {
      console.error('Auth error:', err);
      res.status(500).json({ error: err.message });
    }
  };
}

// Требует, чтобы вошедший был администратором. Ставится после requireAuth.
function requireAdmin(req, res, next) {
  if (!req.brigadier || !req.brigadier.is_admin) {
    return res.status(403).json({ error: 'Доступ только для администратора' });
  }
  next();
}

module.exports = {
  hashPassword, verifyPassword, signToken, verifyToken, requireAuth, requireAdmin,
};
```

- [ ] **Step 2: Verify syntax**

Run: `node --check server/auth.js`
Expected: no output, exit code 0.

- [ ] **Step 3: Test the pure functions with a one-off script**

Run this exact command:

```bash
node -e "
const a = require('./server/auth');
const h = a.hashPassword('secret123');
console.log('verify correct =>', a.verifyPassword('secret123', h) === true ? 'OK' : 'FAIL');
console.log('verify wrong   =>', a.verifyPassword('wrong', h) === false ? 'OK' : 'FAIL');
const t = a.signToken(42, 'test-secret');
const p = a.verifyToken(t, 'test-secret');
console.log('token id       =>', p && p.id === 42 ? 'OK' : 'FAIL');
console.log('wrong secret   =>', a.verifyToken(t, 'other') === null ? 'OK' : 'FAIL');
console.log('garbage token  =>', a.verifyToken('garbage', 'test-secret') === null ? 'OK' : 'FAIL');
"
```

Expected: five lines, all ending in `OK`.

- [ ] **Step 4: Commit**

```bash
git add server/auth.js
git commit -m "Add auth module: password hashing and JWT cookie tokens

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 3: Database tables and session secret

**Files:**
- Modify: `server/server.js` — the startup block (the `(async () => { ... })()` IIFE around lines 32-51) and the requires near the top

- [ ] **Step 1: Add requires**

In `server/server.js`, just after the line `const DataParser = require('./parser');`, add:

```js
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const auth = require('./auth');
```

- [ ] **Step 2: Add `trust proxy` and cookie-parser middleware**

In `server/server.js`, just after `const app = express();`, add:

```js
app.set('trust proxy', 1); // за HTTPS-прокси Render
```

And just after the `app.use(bodyParser.urlencoded(...))` line, add:

```js
app.use(cookieParser());
```

- [ ] **Step 3: Add a SESSION_SECRET holder**

In `server/server.js`, just before the `(async () => {` startup block, add:

```js
let SESSION_SECRET = null;
const getSecret = () => SESSION_SECRET;
```

- [ ] **Step 4: Extend the startup block with the new tables and secret**

In the startup `(async () => { ... })()` block, replace the body of the `try` (the `await pool.query(\`CREATE TABLE IF NOT EXISTS work_logs ...\`)` and the `ALTER TABLE` and `console.log` lines) with:

```js
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
    console.log('✅ Connected to Postgres');
```

- [ ] **Step 5: Verify syntax**

Run: `node --check server/server.js`
Expected: no output, exit code 0.

- [ ] **Step 6: Commit**

```bash
git add server/server.js
git commit -m "Add brigadiers and app_settings tables, work_logs.brigadier_id

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 4: Setup endpoints and auth middleware wiring

**Files:**
- Modify: `server/server.js`

- [ ] **Step 1: Add the shared middleware instance and cookie helper**

In `server/server.js`, just after the `const parser = new DataParser(inventory);` line, add:

```js
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
```

- [ ] **Step 2: Add the setup endpoints**

In `server/server.js`, just before the `// Health-check` comment, add:

```js
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
```

- [ ] **Step 3: Verify syntax**

Run: `node --check server/server.js`
Expected: no output, exit code 0.

- [ ] **Step 4: Commit**

```bash
git add server/server.js
git commit -m "Add first-run setup endpoints and auth cookie helper

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 5: Register / login / logout / me endpoints

**Files:**
- Modify: `server/server.js`

- [ ] **Step 1: Add the four endpoints**

In `server/server.js`, just after the `app.post('/api/setup', ...)` block from Task 4, add:

```js
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
```

- [ ] **Step 2: Verify syntax**

Run: `node --check server/server.js`
Expected: no output, exit code 0.

- [ ] **Step 3: Commit**

```bash
git add server/server.js
git commit -m "Add register, login, logout and me endpoints

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 6: Auth-gate data endpoints and isolate by brigadier

**Files:**
- Modify: `server/server.js` — `/api/estates`, `/api/quarters`, `/api/inventory/:estate/:quarter`, `/api/process`, `/api/logs`, `/api/logs/:id`, `/api/report`, `/api/transcribe`

Every data endpoint gets `requireAuthMw` as its first handler. Inventory endpoints get auth but no brigadier filter. Work-log endpoints additionally filter/insert by `req.brigadier.id`.

- [ ] **Step 1: Gate the inventory endpoints**

Change the three route signatures:

`app.get('/api/estates', (req, res) => {` → `app.get('/api/estates', requireAuthMw, (req, res) => {`

`app.get('/api/quarters', (req, res) => {` → `app.get('/api/quarters', requireAuthMw, (req, res) => {`

`app.get('/api/inventory/:estate/:quarter', (req, res) => {` → `app.get('/api/inventory/:estate/:quarter', requireAuthMw, (req, res) => {`

- [ ] **Step 2: Gate and isolate `/api/process`**

Change `app.post('/api/process', async (req, res) => {` to `app.post('/api/process', requireAuthMw, async (req, res) => {`.

Inside it, replace the INSERT loop. The current code (it already inserts
`estate_id`) is:

```js
    for (const entry of entries) {
      await pool.query(
        `INSERT INTO work_logs (date, estate_id, quarter, cell, employee, rows, bushes)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [date, entry.estate, entry.quarter, entry.cell, entry.employee, entry.rows.join(','), entry.bushes]
      );
    }
```

Replace it with (adds `brigadier_id` as the 8th column):

```js
    for (const entry of entries) {
      await pool.query(
        `INSERT INTO work_logs (date, estate_id, quarter, cell, employee, rows, bushes, brigadier_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [date, entry.estate, entry.quarter, entry.cell, entry.employee,
         entry.rows.join(','), entry.bushes, req.brigadier.id]
      );
    }
```

- [ ] **Step 3: Gate and isolate `/api/logs`**

Change `app.get('/api/logs', async (req, res) => {` to `app.get('/api/logs', requireAuthMw, async (req, res) => {`.

In the two `pool.query` calls inside it, add the brigadier filter. The `date` branch query becomes:

```js
      result = await pool.query(
        `SELECT id, date, estate_id, quarter, cell, employee, rows, bushes, created_at
         FROM work_logs WHERE date = $1 AND estate_id = $2 AND brigadier_id = $3
         ORDER BY created_at DESC`,
        [date, estate, req.brigadier.id]
      );
```

and the `from`/`to` branch becomes:

```js
      result = await pool.query(
        `SELECT id, date, estate_id, quarter, cell, employee, rows, bushes, created_at
         FROM work_logs WHERE date >= $1 AND date <= $2 AND estate_id = $3 AND brigadier_id = $4
         ORDER BY date DESC, created_at DESC`,
        [from, to, estate, req.brigadier.id]
      );
```

- [ ] **Step 4: Gate and isolate `/api/logs/:id` (delete)**

Change `app.delete('/api/logs/:id', async (req, res) => {` to `app.delete('/api/logs/:id', requireAuthMw, async (req, res) => {`.

Replace the delete query:

```js
    const result = await pool.query(
      'DELETE FROM work_logs WHERE id = $1 RETURNING *',
      [id]
    );
```

with:

```js
    const result = await pool.query(
      'DELETE FROM work_logs WHERE id = $1 AND brigadier_id = $2 RETURNING *',
      [id, req.brigadier.id]
    );
```

- [ ] **Step 5: Gate and isolate `/api/report`**

Change `app.get('/api/report', async (req, res) => {` to `app.get('/api/report', requireAuthMw, async (req, res) => {`.

Replace the report query:

```js
    const result = await pool.query(
      `SELECT date, estate_id, quarter, cell, employee, rows, bushes
       FROM work_logs
       WHERE date >= $1 AND date <= $2 AND estate_id = $3
       ORDER BY employee, quarter::int, cell::int, date`,
      [from, to, estate]
    );
```

with:

```js
    const result = await pool.query(
      `SELECT date, estate_id, quarter, cell, employee, rows, bushes
       FROM work_logs
       WHERE date >= $1 AND date <= $2 AND estate_id = $3 AND brigadier_id = $4
       ORDER BY employee, quarter::int, cell::int, date`,
      [from, to, estate, req.brigadier.id]
    );
```

- [ ] **Step 6: Gate `/api/transcribe`**

Change `app.post('/api/transcribe',` so `requireAuthMw` is the first handler after the path:

```js
app.post('/api/transcribe',
  requireAuthMw,
  express.raw({ type: ['audio/*', 'application/octet-stream'], limit: '20mb' }),
  async (req, res) => {
```

- [ ] **Step 7: Verify syntax**

Run: `node --check server/server.js`
Expected: no output, exit code 0.

- [ ] **Step 8: Commit**

```bash
git add server/server.js
git commit -m "Gate data endpoints behind login and isolate logs per brigadier

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 7: Admin endpoints

**Files:**
- Modify: `server/server.js`

- [ ] **Step 1: Add the admin endpoints**

In `server/server.js`, just after the `app.get('/api/me', ...)` block from Task 5, add:

```js
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
```

- [ ] **Step 2: Verify syntax**

Run: `node --check server/server.js`
Expected: no output, exit code 0.

- [ ] **Step 3: Commit**

```bash
git add server/server.js
git commit -m "Add admin endpoints: list, approve, disable, enable, label, reset password

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 8: Client — setup / login / register screens and gating

**Files:**
- Modify: `public/js/app.js`

The client must, on load, decide which screen to show. We add an `apiFetch` helper (so a 401 anywhere bounces to the login screen), rewrite `init()`, and add screen renderers.

- [ ] **Step 1: Add auth state fields to the constructor**

In `public/js/app.js`, in the `constructor()`, add `this.me = null;` as the first line of the constructor body (before `this.estates = [];`).

- [ ] **Step 2: Replace `init()`**

Replace the whole `async init() { ... }` method with:

```js
  async init() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/service-worker.js').catch(e => console.log('SW error:', e));
    }
    // Нужна ли первичная настройка (нет ни одного администратора)?
    try {
      const sr = await fetch('/api/setup-needed');
      const sd = await sr.json();
      if (sd.needed) { this.renderSetup(); return; }
    } catch (e) { /* сервер недоступен — упадём в экран входа ниже */ }
    // Вошёл ли пользователь?
    try {
      const mr = await fetch('/api/me');
      if (mr.ok) {
        this.me = await mr.json();
      } else {
        this.renderAuth(); return;
      }
    } catch (e) {
      this.renderAuth(); return;
    }
    // Вошёл — грузим приложение.
    await this.loadEstates();
    if (this.estate && !this.estates.find(e => e.id === this.estate)) {
      this.estate = '';
      localStorage.removeItem('selectedEstate');
    }
    if (this.estate) {
      await this.loadQuarters();
    }
    this.render();
  }

  // Обёртка над fetch: при 401 (вошёл — но больше не активен) — экран входа.
  async apiFetch(url, options) {
    const r = await fetch(url, options);
    if (r.status === 401) {
      this.me = null;
      this.renderAuth();
      throw new Error('Требуется вход');
    }
    return r;
  }
```

- [ ] **Step 3: Add the setup screen renderer**

Add this method to the `BrigadeAssistant` class (anywhere among the methods):

```js
  renderSetup() {
    const root = document.getElementById('root');
    root.innerHTML = `
      <div class="container auth-box">
        <h1>🍇 Первичная настройка</h1>
        <p class="auth-hint">Создайте аккаунт администратора. Это делается один раз.</p>
        <div class="form-group">
          <label>Логин администратора:</label>
          <input type="text" id="setup-login" autocomplete="username">
        </div>
        <div class="form-group">
          <label>Пароль (не короче 6 символов):</label>
          <input type="password" id="setup-password" autocomplete="new-password">
        </div>
        <button onclick="app.submitSetup()">Создать администратора</button>
        <div id="auth-msg" class="auth-msg"></div>
      </div>
    `;
  }

  async submitSetup() {
    const login = document.getElementById('setup-login').value.trim();
    const password = document.getElementById('setup-password').value;
    const msg = document.getElementById('auth-msg');
    if (!login || !password) { msg.textContent = '❌ Укажи логин и пароль'; return; }
    try {
      const r = await fetch('/api/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ login, password }),
      });
      const data = await r.json();
      if (r.ok) {
        location.reload();
      } else {
        msg.textContent = '❌ ' + (data.error || 'Ошибка');
      }
    } catch (e) {
      msg.textContent = '❌ ' + e.message;
    }
  }
```

- [ ] **Step 4: Add the login/register screen renderer**

Add these methods to the class:

```js
  renderAuth(mode) {
    this.authMode = mode === 'register' ? 'register' : 'login';
    const root = document.getElementById('root');
    const isReg = this.authMode === 'register';
    root.innerHTML = `
      <div class="container auth-box">
        <h1>🍇 Помощьник Бригадира</h1>
        <div class="tabs">
          <button class="tab-button ${isReg ? '' : 'active'}" onclick="app.renderAuth('login')">Войти</button>
          <button class="tab-button ${isReg ? 'active' : ''}" onclick="app.renderAuth('register')">Зарегистрироваться</button>
        </div>
        <div class="form-group">
          <label>Логин:</label>
          <input type="text" id="auth-login" autocomplete="username">
        </div>
        <div class="form-group">
          <label>Пароль${isReg ? ' (не короче 6 символов)' : ''}:</label>
          <input type="password" id="auth-password" autocomplete="${isReg ? 'new-password' : 'current-password'}">
        </div>
        <button onclick="app.${isReg ? 'submitRegister' : 'submitLogin'}()">${isReg ? 'Зарегистрироваться' : 'Войти'}</button>
        <div id="auth-msg" class="auth-msg"></div>
      </div>
    `;
  }

  async submitLogin() {
    const login = document.getElementById('auth-login').value.trim();
    const password = document.getElementById('auth-password').value;
    const msg = document.getElementById('auth-msg');
    if (!login || !password) { msg.textContent = '❌ Укажи логин и пароль'; return; }
    try {
      const r = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ login, password }),
      });
      const data = await r.json();
      if (r.ok) {
        location.reload();
      } else {
        msg.textContent = '❌ ' + (data.error || 'Ошибка');
      }
    } catch (e) {
      msg.textContent = '❌ ' + e.message;
    }
  }

  async submitRegister() {
    const login = document.getElementById('auth-login').value.trim();
    const password = document.getElementById('auth-password').value;
    const msg = document.getElementById('auth-msg');
    if (!login || !password) { msg.textContent = '❌ Укажи логин и пароль'; return; }
    try {
      const r = await fetch('/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ login, password }),
      });
      const data = await r.json();
      if (r.ok) {
        msg.className = 'auth-msg auth-ok';
        msg.textContent = '✅ Заявка отправлена. Ожидайте подтверждения администратором.';
      } else {
        msg.className = 'auth-msg';
        msg.textContent = '❌ ' + (data.error || 'Ошибка');
      }
    } catch (e) {
      msg.textContent = '❌ ' + e.message;
    }
  }
```

- [ ] **Step 5: Verify syntax**

Run: `node --check public/js/app.js`
Expected: no output, exit code 0.

- [ ] **Step 6: Commit**

```bash
git add public/js/app.js
git commit -m "Add client setup, login and register screens with auth gating

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 9: Client — header, logout, admin tab, styles, SW bump

**Files:**
- Modify: `public/js/app.js`, `public/styles.css`, `public/service-worker.js`

- [ ] **Step 1: Add a header with login name and logout to the main `render()`**

In `public/js/app.js`, in `render()`, replace the opening line `<h1>🍇 Помощьник Бригадира</h1>` with:

```js
        <div class="app-header">
          <h1>🍇 Помощьник Бригадира</h1>
          <div class="app-user">
            <span>${this.escapeHtml(this.me ? this.me.login : '')}</span>
            <button class="logout-btn" onclick="app.logout()">Выйти</button>
          </div>
        </div>
```

- [ ] **Step 2: Add the admin tab button (only for admins)**

In `render()`, in the `<div class="tabs">` block, after the `Журнал` tab button, add:

```js
          ${this.me && this.me.is_admin ? `<button class="tab-button" onclick="app.switchTab(event, 'admin'); app.loadBrigadiers()">Админ</button>` : ''}
```

- [ ] **Step 3: Add the admin tab content**

In `render()`, after the closing `</div>` of the `logs-tab` content block, add:

```js
        ${this.me && this.me.is_admin ? `
        <div class="tab-content" id="admin-tab">
          <button onclick="app.loadBrigadiers()">Обновить список</button>
          <div id="brigadiers-list" class="logs-list"></div>
        </div>` : ''}
```

- [ ] **Step 4: Add logout and admin methods**

Add these methods to the `BrigadeAssistant` class:

```js
  async logout() {
    try { await fetch('/api/logout', { method: 'POST' }); } catch (e) {}
    location.reload();
  }

  async loadBrigadiers() {
    const list = document.getElementById('brigadiers-list');
    if (!list) return;
    list.innerHTML = '<p style="padding:10px;">⏳ Загрузка...</p>';
    try {
      const r = await this.apiFetch('/api/admin/brigadiers');
      const data = await r.json();
      if (!r.ok) {
        list.innerHTML = '<p style="color:#c0392b;padding:10px;">❌ ' + (data.error || 'Ошибка') + '</p>';
        return;
      }
      if (!data.brigadiers || data.brigadiers.length === 0) {
        list.innerHTML = '<p style="color:#888;padding:10px;">Аккаунтов нет.</p>';
        return;
      }
      const statusText = { pending: 'ожидает', active: 'активен', disabled: 'отключён' };
      list.innerHTML = data.brigadiers.map(b => `
        <div class="log-entry">
          <div class="log-info">
            <div class="log-employee">${this.escapeHtml(b.login)}${b.is_admin ? ' (админ)' : ''}</div>
            <div class="log-meta">Статус: ${statusText[b.status] || b.status}</div>
            <input class="brigadier-label" type="text" placeholder="Пометка"
              value="${this.escapeHtml(b.label || '')}"
              onchange="app.setBrigadierLabel(${b.id}, this.value)">
          </div>
          <div class="brigadier-actions">
            ${b.status === 'pending' ? `<button class="mini-btn" onclick="app.brigadierAction(${b.id}, 'approve')">Одобрить</button>` : ''}
            ${b.status === 'active' && !b.is_admin ? `<button class="mini-btn delete-btn" onclick="app.brigadierAction(${b.id}, 'disable')">Отключить</button>` : ''}
            ${b.status === 'disabled' ? `<button class="mini-btn" onclick="app.brigadierAction(${b.id}, 'enable')">Включить</button>` : ''}
            <button class="mini-btn" onclick="app.resetBrigadierPassword(${b.id})">Сброс пароля</button>
          </div>
        </div>
      `).join('');
    } catch (e) {
      list.innerHTML = '<p style="color:#c0392b;padding:10px;">❌ ' + e.message + '</p>';
    }
  }

  async brigadierAction(id, action) {
    try {
      const r = await this.apiFetch('/api/admin/brigadiers/' + id + '/' + action, { method: 'POST' });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        alert('Ошибка: ' + (data.error || 'не удалось'));
      }
      this.loadBrigadiers();
    } catch (e) {
      alert('Ошибка: ' + e.message);
    }
  }

  async setBrigadierLabel(id, label) {
    try {
      await this.apiFetch('/api/admin/brigadiers/' + id + '/label', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label }),
      });
    } catch (e) {
      alert('Ошибка: ' + e.message);
    }
  }

  async resetBrigadierPassword(id) {
    const password = prompt('Новый пароль для этого аккаунта (не короче 6 символов):');
    if (password === null) return;
    try {
      const r = await this.apiFetch('/api/admin/brigadiers/' + id + '/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const data = await r.json().catch(() => ({}));
      if (r.ok) {
        alert('Пароль изменён. Сообщите его бригадиру.');
      } else {
        alert('Ошибка: ' + (data.error || 'не удалось'));
      }
    } catch (e) {
      alert('Ошибка: ' + e.message);
    }
  }
```

- [ ] **Step 5: Add styles**

Append to `public/styles.css`:

```css
.auth-box {
    max-width: 420px;
    margin: 40px auto;
}

.auth-hint {
    color: #555;
    font-size: 14px;
    margin-bottom: 16px;
}

.auth-msg {
    margin-top: 14px;
    font-size: 14px;
    color: #c0392b;
}

.auth-msg.auth-ok {
    color: #229954;
}

.app-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
    margin-bottom: 20px;
}

.app-header h1 {
    margin-bottom: 0;
}

.app-user {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 14px;
    color: #555;
}

.logout-btn {
    width: auto;
    margin: 0;
    padding: 6px 12px;
    font-size: 13px;
    background: #7f8c8d;
}

.logout-btn:hover {
    background: #636e72;
}

.brigadier-actions {
    display: flex;
    flex-direction: column;
    gap: 6px;
}

.mini-btn {
    width: auto;
    margin: 0;
    padding: 6px 10px;
    font-size: 12px;
}

.brigadier-label {
    margin-top: 6px;
    font-size: 13px;
    padding: 6px 8px;
}
```

- [ ] **Step 6: Bump the service worker cache**

In `public/service-worker.js`, line 1, change `const CACHE_NAME = 'brigade-v13';` to `const CACHE_NAME = 'brigade-v14';`.

- [ ] **Step 7: Verify syntax**

Run: `node --check public/js/app.js && node --check public/service-worker.js`
Expected: no output, exit code 0.

- [ ] **Step 8: Commit**

```bash
git add public/js/app.js public/styles.css public/service-worker.js
git commit -m "Add client header, logout, admin tab; bump SW cache to v14

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

- [ ] **Step 9: Push and run the manual verification checklist**

```bash
git push
```

Wait for Render to show a green "Deploy live", then verify on the deployed app (`https://pomoshnik-brigadira.onrender.com`):

1. **First-run setup:** On first open the app shows «Первичная настройка». Create the admin account (login + password). The main app opens, logged in as admin.
2. **Existing logs preserved:** Open «Журнал» for a date that had records before — the admin sees them.
3. **Admin tab:** The «Админ» tab is visible. It lists the admin account.
4. **Registration:** In a separate incognito window, open the app, choose «Зарегистрироваться», create a test brigadier. It shows «Заявка отправлена».
5. **Pending cannot log in:** In that incognito window, try «Войти» with the test brigadier — message «Заявка ещё не подтверждена».
6. **Approve:** Back in the admin window, «Админ» tab → the test brigadier shows status «ожидает» → tap «Одобрить».
7. **Brigadier logs in clean:** In incognito, log in as the test brigadier — login succeeds, «Журнал» is empty (does not show the admin's records).
8. **Isolation:** As the test brigadier, add a work entry. Confirm the admin does NOT see it in their journal, and the brigadier does NOT see the admin's.
9. **Reset password:** In the admin tab, «Сброс пароля» for the test brigadier, set a new one; confirm the brigadier can log in with the new password.
10. **Disable:** In the admin tab, «Отключить» the test brigadier; confirm they can no longer log in («Аккаунт отключён»). «Включить» restores access.
11. **Logout:** The «Выйти» button returns to the login screen.

---

## Notes for the engineer

- Russian UI strings and emoji are intentional — match the existing style in `app.js`.
- `server/parser.js` is not changed by this plan.
- The voice methods in `app.js` stay as they are (dormant) — do not remove them.
- Commit messages end with the `Co-Authored-By` trailer, matching recent `git log`.
- This repository is **public** — do not put passwords, logins, secrets, company names, grape varieties, or Excel filenames in any committed file.
- The admin account is created through the in-app setup screen; no environment variables are needed for it. The cookie-signing secret is auto-generated and stored in the `app_settings` table.
