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
  { name: 'Вспашка',          default_measure_mode: 'hectares'   },
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

// Middleware: требует валидный demo_session cookie. Прикрепляет req.demo_session_id.
// Возвращает 401 если cookie нет или сессия не найдена.
function requireDemoSession(pool) {
  return async (req, res, next) => {
    await maybeCleanup(pool); // не чаще раза в 10 минут
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
// 2 квартала по 5 клеток с инвентарём. Журнал пустой (см. ниже).
//
// unit: 'bush' | 'tree' | 'other' (для термина "растений")
async function seedEstate(pool, sessionId, culture, unit) {
  await pool.query(
    'UPDATE demo_sessions SET culture=$1, unit=$2 WHERE id=$3',
    [culture, unit, sessionId]
  );

  // 2 квартала, привязанные к культуре. Хозяйство одно, а культур внутри
  // может быть несколько — отдельная колонка culture позволяет группировать
  // кварталы по культуре в выпадающем «Выбор культуры».
  for (let q = 1; q <= 2; q++) {
    const qres = await pool.query(
      'INSERT INTO demo_quarters (demo_session_id, quarter_key, name, unit, culture) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [sessionId, String(q), `Кв.${q}`, unit, culture]
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

  // Журнал и явку намеренно НЕ засеиваем.
  // Раньше сюда клали примеры (Иванов ряды 1–5 и т.п.) — после «Начать сначала»
  // контроль рядов блокировал те же ряды («уже отмечал Иванов»). Чистый старт
  // нужен и для тестов, и для показа: посетитель сам делает первые записи.
}

// Добавляет ещё одну культуру в уже созданное демо-хозяйство: 2 квартала
// с 5 клетками × 7 рядов под эту культуру. Существующие культуры/квартала
// не трогает. demo_sessions.culture обновляется конкатенацией через " + "
// (только для отображения в баннере; группировка идёт по demo_quarters.culture).
async function addCulture(pool, sessionId, culture, unit) {
  // Найти следующий quarter_key — берём max + 1 среди существующих.
  const maxQ = await pool.query(
    "SELECT COALESCE(MAX((quarter_key)::int), 0) AS m FROM demo_quarters WHERE demo_session_id=$1",
    [sessionId]
  );
  const start = maxQ.rows[0].m + 1;

  for (let i = 0; i < 2; i++) {
    const qKey = start + i;
    const qres = await pool.query(
      'INSERT INTO demo_quarters (demo_session_id, quarter_key, name, unit, culture) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [sessionId, String(qKey), `Кв.${qKey}`, unit, culture]
    );
    const quarterId = qres.rows[0].id;
    const sampleBushes = [137, 140, 145, 142, 138, 141, 139];
    for (let c = 1; c <= 5; c++) {
      const cres = await pool.query(
        'INSERT INTO demo_cells (quarter_id, cell_key, hectares) VALUES ($1, $2, $3) RETURNING id',
        [quarterId, String(c), 1.5 + c * 0.3]
      );
      const cellId = cres.rows[0].id;
      for (let row = 1; row <= 7; row++) {
        await pool.query(
          'INSERT INTO demo_rows (cell_id, row_num, bushes) VALUES ($1, $2, $3)',
          [cellId, row, sampleBushes[row - 1]]
        );
      }
    }
  }

  // Обновляем demo_sessions.culture — добавляем новую в конец через " + ".
  // Не дублируем, если уже есть. Используется только для баннера.
  const sess = await pool.query('SELECT culture FROM demo_sessions WHERE id=$1', [sessionId]);
  const existing = (sess.rows[0] && sess.rows[0].culture) || '';
  const parts = existing.split(/\s*\+\s*/).filter(Boolean);
  if (!parts.includes(culture)) parts.push(culture);
  await pool.query(
    'UPDATE demo_sessions SET culture=$1 WHERE id=$2',
    [parts.join(' + '), sessionId]
  );
}

// Возвращает объект инвентаря в формате DataParser, где каждое «estate» —
// это отдельная культура внутри одного демо-хозяйства. ID estate = название
// культуры (используется как work_logs.estate_id для жёсткой привязки записей
// к культуре). В выпадающем UI это будет «Выбор культуры», а не «хозяйства».
async function getDemoInventory(pool, sessionId) {
  const sess = await pool.query('SELECT culture FROM demo_sessions WHERE id=$1', [sessionId]);
  if (sess.rows.length === 0) return { estates: {} };
  if (!sess.rows[0].culture) {
    return { estates: {} }; // ни одной культуры ещё не добавлено
  }
  const qs = await pool.query(
    'SELECT id, quarter_key, name, unit, culture FROM demo_quarters WHERE demo_session_id=$1 ORDER BY id',
    [sessionId]
  );
  // Группируем кварталы по культуре. Каждая культура становится отдельной
  // записью в estates с тем же набором полей (quarters), что и боевой формат.
  const estates = {};
  for (const q of qs.rows) {
    const cultureKey = q.culture || 'без культуры';
    if (!estates[cultureKey]) {
      estates[cultureKey] = { name: cultureKey, unit: q.unit, quarters: {} };
    }
    const cs = await pool.query(
      'SELECT id, cell_key, hectares FROM demo_cells WHERE quarter_id=$1 ORDER BY id',
      [q.id]
    );
    const cells = {};
    for (const c of cs.rows) {
      const rs = await pool.query(
        'SELECT row_num, bushes FROM demo_rows WHERE cell_id=$1 ORDER BY row_num',
        [c.id]
      );
      // Новый формат: клетка = { hectares, rows } вместо просто массива rows.
      // Парсер умеет читать оба формата (см. parser.js). hectares клетки нужны
      // чтобы в режиме «Гектары» переводить выбранные ряды в гектары.
      cells[c.cell_key] = {
        hectares: c.hectares != null ? Number(c.hectares) : null,
        rows: rs.rows.map(r => ({ row: r.row_num, bushes: r.bushes })),
      };
    }
    estates[cultureKey].quarters[q.quarter_key] = { name: q.name, unit: q.unit, cells };
  }
  return { estates };
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
  addCulture,
  getDemoInventory,
};
