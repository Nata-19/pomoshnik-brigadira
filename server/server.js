const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const DataParser = require('./parser');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ limit: '10mb', extended: true }));

// Статические файлы
app.use(express.static(path.join(__dirname, '../public')));

// Инициализация БД (на Fly.io том монтируется в /data)
const dbPath = process.env.DB_PATH || path.join(__dirname, '../data.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) console.error(err.message);
  else console.log('✅ Connected to SQLite database');
});

// Инициализируем таблицу для хранения данных
db.run(`
  CREATE TABLE IF NOT EXISTS work_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    quarter TEXT NOT NULL,
    cell INTEGER NOT NULL,
    employee TEXT NOT NULL,
    rows TEXT NOT NULL,
    bushes INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// Загружаем инвентаризацию
const inventory = JSON.parse(fs.readFileSync(path.join(__dirname, '../inventory.json'), 'utf8'));
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
app.post('/api/process', (req, res) => {
  try {
    const { date, input } = req.body;

    if (!date || !input) {
      return res.status(400).json({ error: 'Некорректный формат ввода' });
    }

    // Парсим входные данные
    const { entries } = parser.parse(input, date);

    // Формируем отчет
    const report = parser.formatReport(date, entries, inventory);

    // Сохраняем в БД
    for (const entry of entries) {
      db.run(
        `INSERT INTO work_logs (date, quarter, cell, employee, rows, bushes)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [date, entry.quarter, entry.cell, entry.employee, entry.rows.join(','), entry.bushes],
        (err) => {
          if (err) console.error('DB Error:', err);
        }
      );
    }

    res.json({ success: true, report });
  } catch (error) {
    console.error(error);
    res.status(400).json({ error: error.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🍇 Brigade Assistant запущен на порту ${PORT}`);
});
