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

module.exports = {
  COOKIE_NAME,
  SEED_EMPLOYEES,
  SEED_WORK_TYPES_MANUAL,
  SEED_WORK_TYPES_MECH,
  detectUnit,
  newSessionId,
  createSessionWithSeed,
  DEMO_SESSION_TTL_MS,
  requireDemoSession,
  seedEstate,
};
