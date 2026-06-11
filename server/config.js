// Глобальная конфигурация — читается из env при старте, экспортируется один раз.
// DEMO_MODE решает много ветвлений ниже: миграции, middleware, UI-флаги.

const DEMO_MODE = process.env.DEMO_MODE === 'true';

const BRAND_NAME = process.env.BRAND_NAME || (DEMO_MODE ? 'Демо Помощник' : 'Помощьник Бригадира');
const BRAND_LOGO = process.env.BRAND_LOGO || (DEMO_MODE ? '🌱' : '🍇');
const CONTACT_PHONE = process.env.CONTACT_PHONE || '+79783116389';

// Список единиц измерения, доступных в текущем режиме.
// В демо — 5 базовых, в проде — все 11. Расширенные «продаются» как
// «настраивается под предприятие».
const MEASURE_MODES_DEMO = ['rows_bushes', 'rows_only', 'hours', 'hectares', 'kilometers'];
const MEASURE_MODES_PROD = ['rows_bushes', 'rows_only', 'hours'];
// Полный справочник всех поддерживаемых режимов — для расширения под клиентов.
const MEASURE_MODES_ALL = [
  'rows_bushes', 'rows_only', 'hours', 'hectares', 'kilometers',
  'poles', 'tons', 'linear_meters', 'tons_km', 'hours_km', 'hectares_tons',
];
const MEASURE_MODES = process.env.MEASURE_MODES
  ? process.env.MEASURE_MODES.split(',').map(m => m.trim()).filter(m => MEASURE_MODES_ALL.includes(m))
  : (DEMO_MODE ? MEASURE_MODES_DEMO : MEASURE_MODES_PROD);

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
