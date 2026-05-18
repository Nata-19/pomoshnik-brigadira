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

// API endpoints
app.get('/api/estates', (req, res) => {
  const estates = Object.keys(inventory.estates).map(id => ({
    id,
    name: inventory.estates[id].name
  }));
  res.json(estates);
});

app.get('/api/quarters', (req, res) => {
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

app.get('/api/inventory/:estate/:quarter', (req, res) => {
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
app.post('/api/process', async (req, res) => {
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
        `INSERT INTO work_logs (date, estate_id, quarter, cell, employee, rows, bushes)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [date, entry.estate, entry.quarter, entry.cell, entry.employee, entry.rows.join(','), entry.bushes]
      );
    }

    res.json({ success: true, report });
  } catch (error) {
    console.error(error);
    res.status(400).json({ error: error.message });
  }
});

// Health-check для UptimeRobot и Render
app.get('/health', (req, res) => res.json({ ok: true }));

// Список записей за день (для журнала + удаления). Фильтр по хозяйству обязателен.
app.get('/api/logs', async (req, res) => {
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
         FROM work_logs WHERE date = $1 AND estate_id = $2
         ORDER BY created_at DESC`,
        [date, estate]
      );
    } else if (from && to) {
      result = await pool.query(
        `SELECT id, date, estate_id, quarter, cell, employee, rows, bushes, created_at
         FROM work_logs WHERE date >= $1 AND date <= $2 AND estate_id = $3
         ORDER BY date DESC, created_at DESC`,
        [from, to, estate]
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
app.delete('/api/logs/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Некорректный id' });
    }
    const result = await pool.query(
      'DELETE FROM work_logs WHERE id = $1 RETURNING *',
      [id]
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
app.get('/api/report', async (req, res) => {
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
       WHERE date >= $1 AND date <= $2 AND estate_id = $3
       ORDER BY employee, quarter::int, cell::int, date`,
      [from, to, estate]
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
