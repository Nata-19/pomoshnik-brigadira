const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const { Pool } = require('pg');
const fs = require('fs');
const DataParser = require('./parser');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ limit: '10mb', extended: true }));

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
    console.log('✅ Connected to Postgres');
  } catch (err) {
    console.error('❌ Postgres init failed:', err.message);
    process.exit(1);
  }
})();

// Загружаем инвентаризацию (на Render — из Secret Files, локально — из корня проекта)
const inventoryPath = process.env.INVENTORY_PATH || path.join(__dirname, '../inventory.json');
const inventory = JSON.parse(fs.readFileSync(inventoryPath, 'utf8'));
const parser = new DataParser(inventory);

// API endpoints
app.get('/api/quarters', (req, res) => {
  const quarters = Object.keys(inventory.quarters).map(key => ({
    id: key,
    name: inventory.quarters[key].name
  }));
  res.json(quarters);
});

app.get('/api/inventory/:quarter', (req, res) => {
  const quarter = inventory.quarters[req.params.quarter];
  if (!quarter) {
    return res.status(404).json({ error: 'Quarter not found' });
  }
  res.json(quarter);
});

// Обработка ввода данных (текстовый формат)
app.post('/api/process', async (req, res) => {
  try {
    const { date, input, quarter, cell } = req.body;

    if (!date || !input) {
      return res.status(400).json({ error: 'Некорректный формат ввода' });
    }

    const { entries } = parser.parse(input, date, { quarter, cell });
    const report = parser.formatReport(date, entries, inventory);

    for (const entry of entries) {
      await pool.query(
        `INSERT INTO work_logs (date, quarter, cell, employee, rows, bushes)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [date, entry.quarter, entry.cell, entry.employee, entry.rows.join(','), entry.bushes]
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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🍇 Brigade Assistant запущен на порту ${PORT}`);
});
