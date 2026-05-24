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
};
