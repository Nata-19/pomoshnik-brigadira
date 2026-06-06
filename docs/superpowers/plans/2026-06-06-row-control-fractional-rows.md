# Дробный учёт рядов при делении — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Поделённый ряд считается дробью (вес ряда = доля), а не целым у каждого рабочего; «всего за день» и отчёт перестают задваивать.

**Architecture:** В `work_logs` новая колонка `row_weights` (TEXT, JSON `{ряд: вес}`). Вес проставляется на всех путях записи; снятие/деление снимают ряд со всех держателей и раздают веса заново. Отчёт суммирует веса. Расчёт долей — в чистом ядре `server/rowControl.js` под юнит-тесты. Миграция неразрушающая.

**Tech Stack:** Node.js/Express, `pg`, ванильный JS PWA. Тесты — `node --test`. Кусты ряда — `parser.getBushesCount`.

**Спека:** `docs/superpowers/specs/2026-06-06-row-control-fractional-rows-design.md`.

**База:** worktree `row-control-fractional` от `origin/main` (84a4c86).

---

## File Structure

- **Modify:** `server/rowControl.js` — добавить чистые функции весов; изменить `removeRowFromRecord` (учёт весов).
- **Modify:** `test/rowControl.test.js` — тесты новых функций и изменённой `removeRowFromRecord`.
- **Modify:** `server/server.js` — миграция (ALTER+бэкфилл); `applyRowRemoval`/`upsertWorkLog`; INSERT в `POST /api/logs`; действия `divide`/`reassign`/`postpone`; `POST /api/disputed/:id/resolve`; ответы с `rowBushes` в конфликтах и `GET /api/disputed`; отчёт `GET /api/report`.
- **Modify:** `public/js/app.js` — `showDivideModal` (подсказка про кусты, поле доли для `rows_only`); прокидывание `rowBushes` из конфликтов/спорных.

---

## Task 1: Чистое ядро весов в `server/rowControl.js`

**Files:**
- Modify: `server/rowControl.js`
- Test: `test/rowControl.test.js`

- [ ] **Step 0: Обновить существующие тесты `removeRowFromRecord` под новую сигнатуру**

Сигнатура меняется с `(rowsCsv, currentBushes, removedRow, removedRowBushes)` на `(rowsCsv, weightsText, currentBushes, removedRow, rowBushes)`. В уже существующих тестах (в `test/rowControl.test.js`, ~строки 71–96) вставить вторым аргументом `null` (вес отсутствует → трактуется как 1, ожидания не меняются):
- `removeRowFromRecord('1,2,3,4,5', 685, 3, 140)` → `removeRowFromRecord('1,2,3,4,5', null, 685, 3, 140)`
- `removeRowFromRecord('7', 130, 7, 130)` → `removeRowFromRecord('7', null, 130, 7, 130)`
- `removeRowFromRecord('1,2', 50, 2, 200)` → `removeRowFromRecord('1,2', null, 50, 2, 200)`
- `removeRowFromRecord('1,2,3', 300, 9, 100)` → `removeRowFromRecord('1,2,3', null, 300, 9, 100)`

- [ ] **Step 1: Дописать тесты** (добавить в конец `test/rowControl.test.js`)

`removeRowFromRecord` уже импортирован сверху (строка 3) — НЕ объявлять повторно. Снизу импортируем только новые функции:

```js
const {
  parseRowWeights, serializeRowWeights, weightOfRecord,
  weightsFromBushes, fillWeights, formatRows,
} = require('../server/rowControl');

test('parse/serialize round-trip и мусор', () => {
  assert.deepStrictEqual(parseRowWeights('{"1":1,"2":0.5}'), { '1': 1, '2': 0.5 });
  assert.deepStrictEqual(parseRowWeights(''), {});
  assert.deepStrictEqual(parseRowWeights('не json'), {});
  assert.deepStrictEqual(parseRowWeights('[1,2]'), {});
  assert.strictEqual(serializeRowWeights({ '1': 1 }), '{"1":1}');
});

test('weightOfRecord: нет весов → считаем по числу рядов (по 1)', () => {
  assert.strictEqual(weightOfRecord('1,2,3', null), 3);
  assert.strictEqual(weightOfRecord('1,2,3', ''), 3);
});

test('weightOfRecord: смесь целых и долей суммируется точно', () => {
  assert.strictEqual(weightOfRecord('1,2,5', '{"1":1,"2":1,"5":0.5}'), 2.5);
  // отсутствующий вес ряда трактуется как 1
  assert.strictEqual(weightOfRecord('1,2', '{"1":0.5}'), 1.5);
});

test('weightsFromBushes: 100 кустов 25/75 → 0.25/0.75', () => {
  assert.deepStrictEqual(weightsFromBushes(100, [25, 75]), [0.25, 0.75]);
});

test('weightsFromBushes: total<=0 → поровну', () => {
  assert.deepStrictEqual(weightsFromBushes(0, [0, 0]), [0.5, 0.5]);
});

test('fillWeights: все пустые → поровну', () => {
  assert.deepStrictEqual(fillWeights([null, null]), [0.5, 0.5]);
  const three = fillWeights([null, null, null]);
  assert.ok(Math.abs(three.reduce((s, w) => s + w, 0) - 1) < 1e-9);
});

test('fillWeights: явные уважаются, остаток поровну по пустым', () => {
  assert.deepStrictEqual(fillWeights([0.5, null, null]), [0.5, 0.25, 0.25]);
});

test('formatRows: 2 знака без лишних нулей', () => {
  assert.strictEqual(formatRows(2), '2');
  assert.strictEqual(formatRows(0.5), '0.5');
  assert.strictEqual(formatRows(1 / 3), '0.33');
  assert.strictEqual(formatRows(0.999999), '1');
});

test('removeRowFromRecord: учитывает вес при вычете кустов', () => {
  // ряд 5 с весом 0.5, всего в ряду 100 кустов → вычесть 50
  const out = removeRowFromRecord('1,5', '{"1":1,"5":0.5}', 130, 5, 100);
  assert.strictEqual(out.found, true);
  assert.strictEqual(out.deleted, false);
  assert.strictEqual(out.rows, '1');
  assert.strictEqual(out.bushes, 80); // 130 - round(0.5*100)
  assert.deepStrictEqual(JSON.parse(out.weights), { '1': 1 });
});

test('removeRowFromRecord: последний ряд → запись на удаление', () => {
  const out = removeRowFromRecord('5', '{"5":0.5}', 50, 5, 100);
  assert.strictEqual(out.deleted, true);
  assert.strictEqual(out.rows, null);
  assert.strictEqual(out.weights, null);
});

test('removeRowFromRecord: ряда нет → found=false', () => {
  const out = removeRowFromRecord('1,2', '{"1":1,"2":1}', 50, 9, 100);
  assert.strictEqual(out.found, false);
});

test('removeRowFromRecord: старая запись без весов → вес ряда = 1', () => {
  // вес отсутствует → трактуем как 1, вычитаем полные кусты ряда
  const out = removeRowFromRecord('1,2', null, 80, 2, 30);
  assert.strictEqual(out.bushes, 50); // 80 - 1*30
  assert.strictEqual(out.found, true);
});
```

- [ ] **Step 2: Запустить тесты — убедиться, что падают**

Run: `node --test test/rowControl.test.js`
Expected: FAIL — новые функции не экспортированы / старая сигнатура `removeRowFromRecord`.

- [ ] **Step 3: Реализовать функции и изменить `removeRowFromRecord`**

В `server/rowControl.js` заменить функцию `removeRowFromRecord` на версию с весами и добавить новые функции. Итоговый `removeRowFromRecord`:

```js
// Убирает ряд removedRow из записи: правит CSV рядов, JSON весов и кусты.
// rowBushes — кусты ВСЕГО ряда по инвентаризации (rows_only → 0); вычитаем
// долю снимаемого рабочего = вес_ряда * rowBushes (вес отсутствует → 1).
// Возвращает { rows, weights, bushes, deleted, found }.
function removeRowFromRecord(rowsCsv, weightsText, currentBushes, removedRow, rowBushes) {
  const nums = String(rowsCsv || '')
    .split(',').map((s) => parseInt(s, 10)).filter((n) => Number.isInteger(n));
  const weights = parseRowWeights(weightsText);
  if (!nums.includes(removedRow)) {
    return { rows: nums.join(','), weights: serializeRowWeights(weights), bushes: currentBushes, deleted: false, found: false };
  }
  const w = (typeof weights[removedRow] === 'number' && isFinite(weights[removedRow])) ? weights[removedRow] : 1;
  const remaining = nums.filter((n) => n !== removedRow);
  if (remaining.length === 0) {
    return { rows: null, weights: null, bushes: 0, deleted: true, found: true };
  }
  const newWeights = {};
  for (const n of remaining) if (weights[n] !== undefined) newWeights[n] = weights[n];
  const subtract = Math.round(w * (Number(rowBushes) || 0));
  return {
    rows: remaining.join(','),
    weights: serializeRowWeights(newWeights),
    bushes: Math.max(currentBushes - subtract, 0),
    deleted: false, found: true,
  };
}

// --- Веса рядов (дробный учёт) ---
function parseRowWeights(text) {
  if (!text) return {};
  try {
    const o = JSON.parse(text);
    return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {};
  } catch { return {}; }
}

function serializeRowWeights(obj) {
  return JSON.stringify(obj || {});
}

// Вес записи для подсчёта рядов: сумма весов; ряд без веса считается как 1.
function weightOfRecord(rowsCsv, weightsText) {
  const nums = String(rowsCsv || '').split(',').map((s) => s.trim()).filter(Boolean);
  const w = parseRowWeights(weightsText);
  let sum = 0;
  for (const n of nums) sum += (typeof w[n] === 'number' && isFinite(w[n])) ? w[n] : 1;
  return sum;
}

// Веса по кустам (rows_bushes): доля = кусты/всего. total<=0 → поровну.
function weightsFromBushes(totalRowBushes, bushesArr) {
  const n = bushesArr.length;
  if (!(Number(totalRowBushes) > 0)) return fillWeights(new Array(n).fill(null));
  return bushesArr.map((b) => (Number(b) || 0) / Number(totalRowBushes));
}

// Заполняет веса: явные (число) уважаются, пустые (null) делят остаток поровну.
function fillWeights(arr) {
  const provided = arr.filter((w) => w !== null && w !== undefined);
  const explicitSum = provided.reduce((s, w) => s + Number(w), 0);
  const blanks = arr.filter((w) => w === null || w === undefined).length;
  const each = blanks > 0 ? Math.max(1 - explicitSum, 0) / blanks : 0;
  return arr.map((w) => (w === null || w === undefined) ? each : Number(w));
}

// Показ числа рядов: округление до 2 знаков, без лишних нулей.
function formatRows(n) {
  return String(Math.round((Number(n) || 0) * 100) / 100);
}
```

Обновить `module.exports`:

```js
module.exports = {
  splitBushes, classifyRows, removeRowFromRecord, distributeBushes,
  parseRowWeights, serializeRowWeights, weightOfRecord,
  weightsFromBushes, fillWeights, formatRows,
};
```

- [ ] **Step 4: Запустить тесты — убедиться, что проходят**

Run: `node --test`
Expected: PASS (старые 22 + новые ~12; ни одного fail). Если падают старые тесты `removeRowFromRecord` со старой сигнатурой — обновить их вызовы под новую сигнатуру `(rowsCsv, weightsText, currentBushes, removedRow, rowBushes)` (раньше было `(rowsCsv, currentBushes, removedRow, removedRowBushes)`): вставить вторым аргументом `null` и убедиться в тех же ожиданиях.

- [ ] **Step 5: Коммит**

```bash
git add server/rowControl.js test/rowControl.test.js
git commit -m "feat(rows): чистое ядро весов рядов + учёт веса в removeRowFromRecord"
```

---

## Task 2: Миграция — колонка `row_weights` + бэкфилл

**Files:**
- Modify: `server/server.js` (рядом с ALTER'ами `work_logs`, ~строки 124–126)

- [ ] **Step 1: Добавить ALTER и неразрушающий бэкфилл**

После строки `await pool.query(\`ALTER TABLE work_logs ADD COLUMN IF NOT EXISTS hours INTEGER\`);` (стр. 126) добавить:

```js
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
```

- [ ] **Step 2: Проверить синтаксис**

Run: `node --check server/server.js`
Expected: без вывода.

- [ ] **Step 3: Коммит**

```bash
git add server/server.js
git commit -m "feat(rows): миграция row_weights (ADD COLUMN + неразрушающий бэкфилл)"
```

---

## Task 3: `applyRowRemoval`, `upsertWorkLog` и обычный ввод — поддержка весов

**Files:**
- Modify: `server/server.js` (`applyRowRemoval` ~987; `upsertWorkLog` ~1037; INSERT в `POST /api/logs` ~1170 и ~1205)

- [ ] **Step 1: `applyRowRemoval` — читать/писать `row_weights`**

Заменить тело `applyRowRemoval` (стр. 987–1009) на:

```js
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
```

- [ ] **Step 2: `upsertWorkLog` — принять `weight` и писать `row_weights`**

Заменить тело `upsertWorkLog` (стр. 1037–1071) на (сигнатура получает `weight`):

```js
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
```

- [ ] **Step 3: Обычный ввод `POST /api/logs` — писать веса = 1 на ряд**

В `POST /api/logs` перед INSERT'ами (после вычисления `rowsStr`, ~стр. 1146) добавить вычисление JSON весов:

```js
    // Вес каждого введённого ряда = 1 (целый ряд). Для hours/без рядов — null.
    let rowWeightsStr = null;
    if (rowsStr) {
      const wobj = {};
      for (const n of rowsStr.split(',')) if (n.trim()) wobj[n.trim()] = 1;
      rowWeightsStr = rowControl.serializeRowWeights(wobj);
    }
```

В демо-INSERT (стр. 1170–1178) добавить колонку `row_weights` со значением `rowWeightsStr` (после `rows`):

```js
      const ins = await pool.query(
        `INSERT INTO work_logs
          (date, estate_id, quarter, cell, employee, rows, row_weights, bushes, brigadier_id, demo_session_id, work_type, measure_mode, hours)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         RETURNING id`,
        [date, estate, quarter ? String(quarter) : '', cell ? String(cell) : '',
         employee.trim(), rowsStr, rowWeightsStr, bushes, 0, req.demo_session_id,
         work_type.trim(), measure_mode, hoursVal]
      );
```

Аналогично в прод-INSERT (стр. 1205–1213) добавить `row_weights` = `rowWeightsStr`:

```js
    const ins = await pool.query(
      `INSERT INTO work_logs
        (date, estate_id, quarter, cell, employee, rows, row_weights, bushes, brigadier_id, work_type, measure_mode, hours)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING id`,
      [date, estate, quarter ? String(quarter) : '', cell ? String(cell) : '',
       employee.trim(), rowsStr, rowWeightsStr, bushes, req.brigadier.id,
       work_type.trim(), measure_mode, hoursVal]
    );
```

- [ ] **Step 4: Синтаксис**

Run: `node --check server/server.js`
Expected: без вывода.

- [ ] **Step 5: Коммит**

```bash
git add server/server.js
git commit -m "feat(rows): row_weights в applyRowRemoval/upsertWorkLog и обычном вводе"
```

---

## Task 4: Действие `divide` — снять со всех держателей + веса

**Files:**
- Modify: `server/server.js` (блок `if (action === 'divide')` ~1322–1381)

- [ ] **Step 1: Переписать блок `divide`**

Заменить блок целиком на:

```js
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
```

(Переменная `firstLogId` для `divide` больше не используется — снятие идёт по всем держателям; деструктуризация в начале обработчика её всё ещё содержит, это ок.)

- [ ] **Step 2: Синтаксис**

Run: `node --check server/server.js`
Expected: без вывода.

- [ ] **Step 3: Коммит**

```bash
git add server/server.js
git commit -m "feat(rows): divide снимает ряд со всех держателей и раздаёт веса"
```

---

## Task 5: `reassign`/`postpone` и разбор спорных — веса

**Files:**
- Modify: `server/server.js` (`reassign` ~1305; `POST /api/disputed/:id/resolve` ~1461–1508)

- [ ] **Step 1: `reassign` — целый ряд новому (вес 1)**

В блоке `reassign` строку записи второму рабочему (стр. 1305):

```js
        await upsertWorkLog(owner.col, owner.val, req, ctx, employee.trim(), rowNum, rowBushes);
```

заменить на (вес 1 — ряд целиком):

```js
        await upsertWorkLog(owner.col, owner.val, req, ctx, employee.trim(), rowNum, rowBushes, 1);
```

(`postpone` только снимает ряд — `applyRowRemoval` уже учитывает веса, менять не нужно.)

- [ ] **Step 2: Разбор спорных — веса**

В `POST /api/disputed/:id/resolve` заменить формирование `toInsert` и запись (стр. 1462–1508). Сделать так, чтобы у каждого вставляемого был `weight`:

`return-first` (стр. 1463–1464):

```js
    if (action === 'return-first') {
      toInsert = [{ employee: d.claimed_by, bushes: rowBushes, weight: 1 }];
    } else {
```

В ветке `else` (несколько рабочих) после вычисления `toInsert` с кустами добавить веса. Заменить блок вычисления `toInsert` (стр. 1466–1495) на:

```js
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
```

И в цикле записи (стр. 1506–1508) передать вес:

```js
    for (const a of toInsert) {
      await upsertWorkLog(owner.col, owner.val, req, ctx, a.employee, d.row_num, a.bushes, a.weight);
    }
```

- [ ] **Step 3: Синтаксис**

Run: `node --check server/server.js`
Expected: без вывода.

- [ ] **Step 4: Коммит**

```bash
git add server/server.js
git commit -m "feat(rows): веса в reassign и разборе спорных"
```

---

## Task 6: Отчёт — суммировать веса вместо подсчёта номеров

**Files:**
- Modify: `server/server.js` (`GET /api/report`: SELECT и счётчик рядов ~1640–1683)

- [ ] **Step 1: Добавить `row_weights` в SELECT отчёта**

В запросе(ах) `GET /api/report` добавить `row_weights` в список колонок (рядом с `rows`). Найти `SELECT ... rows, bushes, work_type, measure_mode, hours FROM work_logs` (обе ветки DEMO/прод) и вставить `row_weights`:

```sql
SELECT date, estate_id, quarter, cell, employee, rows, row_weights, bushes, work_type, measure_mode, hours
```

- [ ] **Step 2: Считать ряды по весам и форматировать**

Заменить `rowCountOf` и его использование (стр. 1662, 1676) и формат (стр. 1666). Конкретно:

Убрать строку `const rowCountOf = (r) => String(r.rows || '').split(',').filter(x => x.trim()).length;`

В `addRec` строку `slot.rows += rowCountOf(r);` заменить на:

```js
        slot.rows += rowControl.weightOfRecord(r.rows, r.row_weights);
```

В `unitText` строку `if (s.hasRows) p.push(\`${s.rows} рядов\`);` заменить на:

```js
      if (s.hasRows) p.push(`${rowControl.formatRows(s.rows)} рядов`);
```

(Суммы `slot.rows` накапливаются точными весами; округление — только в `formatRows` при показе → Вариант Б.)

- [ ] **Step 3: Синтаксис**

Run: `node --check server/server.js`
Expected: без вывода.

- [ ] **Step 4: Коммит**

```bash
git add server/server.js
git commit -m "feat(rows): отчёт суммирует веса рядов (дробный показ)"
```

---

## Task 7: Прокинуть кусты ряда (`rowBushes`) в конфликты и спорные

**Files:**
- Modify: `server/server.js` (конфликты в `POST /api/logs` ~1125–1145; `GET /api/disputed`)

- [ ] **Step 1: Добавить `rowBushes` к каждому конфликту**

В `POST /api/logs`, где формируются конфликты (стр. 1128–1145), обогатить элементы `sameDay`/`otherDay` числом кустов ряда (для `rows_bushes`; иначе 0). Заменить участок:

```js
      const cls = rowControl.classifyRows(rowNums, occupied, date);
```

…оставить, а перед формированием ответа добавить хелпер и применить к спискам. Заменить блок `if (cls.free.length === 0 ...)` и присвоение `req._rowConflicts` так, чтобы конфликты несли `rowBushes`:

```js
      const withBushes = (arr) => arr.map((c) => {
        let rb = 0;
        if (measure_mode === 'rows_bushes') {
          try { rb = parserToUse.getBushesCount(estate, String(quarter), String(cell), [c.row]); } catch { rb = 0; }
        }
        return { ...c, rowBushes: rb };
      });
      const conflictsOut = { sameDay: withBushes(cls.sameDay), otherDay: withBushes(cls.otherDay) };

      if (cls.free.length === 0 && (cls.sameDay.length || cls.otherDay.length)) {
        return res.json({ success: false, savedRows: [], conflicts: conflictsOut });
      }
      rowNums = cls.free;
      rowsStr = rowNums.join(',');
      if (measure_mode === 'rows_bushes') {
        try {
          bushes = parserToUse.getBushesCount(estate, String(quarter), String(cell), rowNums);
        } catch (e) {
          return res.status(400).json({ error: e.message });
        }
      }
      req._rowConflicts = conflictsOut;
```

(Обе ветки ответа `success:true` уже возвращают `conflicts: req._rowConflicts` — менять их не нужно.)

- [ ] **Step 2: Добавить `row_bushes` в `GET /api/disputed`**

В `GET /api/disputed` после получения `result.rows` обогатить каждый спорный ряд числом кустов (для `rows_bushes`). Нужен парсер: построить как в других endpoint'ах (DEMO/прод). Перед `res.json(...)` заменить на:

```js
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
```

Также добавить `estate_id` в SELECT `GET /api/disputed`, если его там нет (нужен для `getBushesCount`). Проверить список колонок (`id, quarter, cell, work_type, row_num, measure_mode, claimed_by, claimed_date`) и добавить `estate_id`.

- [ ] **Step 3: Синтаксис**

Run: `node --check server/server.js`
Expected: без вывода.

- [ ] **Step 4: Коммит**

```bash
git add server/server.js
git commit -m "feat(rows): отдаём кусты ряда в конфликтах и спорных (для подсказки)"
```

---

## Task 8: Клиент — подсказка про кусты и доля для «только ряды»

**Files:**
- Modify: `public/js/app.js` (`showDivideModal` ~1291; вызовы в `resolveSameDay` ~1025, `resolveOtherDay` ~1065, `openDisputedAssign` ~1276–1283)

- [ ] **Step 1: `showDivideModal` — параметр `rowBushes`, подсказка и доля**

Изменить сигнатуру и тело `showDivideModal({ row, askShare, preselect = [] })`:
- добавить параметр `rowBushes = 0`;
- под `hint` (после строки `box.appendChild(hint)`) добавить подсказку про кусты для режима с кустами:

```js
      if (askShare && rowBushes > 0) {
        const bhint = document.createElement('div');
        bhint.className = 'modal-text';
        bhint.style.marginTop = '-6px';
        bhint.textContent = `В этом ряду ${rowBushes} кустов.`;
        box.appendChild(bhint);
      }
```

- для режима «только ряды» (`!askShare`) добавить рабочему поле «доля» (по умолчанию пусто = поровну). В цикле построения `rowEl`, в ветке, где сейчас `shareInput` создаётся только при `askShare`, добавить альтернативу: если `!askShare` — создать поле доли:

```js
        let shareInput = null;
        if (askShare) {
          shareInput = document.createElement('input');
          shareInput.className = 'modal-input';
          shareInput.inputMode = 'numeric';
          shareInput.placeholder = 'кусты';
          shareInput.style.width = '90px';
          shareInput.style.margin = '0';
          rowEl.appendChild(shareInput);
        } else {
          shareInput = document.createElement('input');
          shareInput.className = 'modal-input';
          shareInput.inputMode = 'decimal';
          shareInput.placeholder = 'доля';
          shareInput.style.width = '90px';
          shareInput.style.margin = '0';
          rowEl.appendChild(shareInput);
        }
```

- при сборе результата (обработчик `primary`): для `askShare` собирать `bushes` (как сейчас), для `!askShare` — `weight` (дробь). Заменить формирование `chosen`:

```js
      primary.addEventListener('click', () => {
        const chosen = rows.filter((r) => r.cb.checked).map((r) => {
          if (askShare) {
            let bushes = null;
            if (r.shareInput && r.shareInput.value.trim() !== '') {
              const n = parseInt(r.shareInput.value, 10);
              if (Number.isInteger(n) && n >= 0) bushes = n;
            }
            return { employee: r.name, bushes };
          }
          let weight = null;
          if (r.shareInput && r.shareInput.value.trim() !== '') {
            const x = parseFloat(r.shareInput.value.replace(',', '.'));
            if (isFinite(x) && x >= 0) weight = x;
          }
          return { employee: r.name, weight };
        });
        if (chosen.length === 0) return;
        close(chosen);
      });
```

- [ ] **Step 2: Прокинуть `rowBushes` в вызовы `showDivideModal`**

В `resolveSameDay(c, employee, body)` (вызов ~1025) и `resolveOtherDay` (вызов ~1065) добавить `rowBushes: c.rowBushes || 0` в объект параметров:

```js
    const assignments = await this.showDivideModal({
      row: c.row,
      askShare: body.measure_mode === 'rows_bushes',
      preselect: [c.occupant.employee, employee],
      rowBushes: c.rowBushes || 0,
    });
```

В `openDisputedAssign(id)` (~1279) — передать кусты спорного ряда:

```js
    const assignments = await this.showDivideModal({
      row: d.row_num,
      askShare: d.measure_mode === 'rows_bushes',
      preselect: [],
      rowBushes: d.row_bushes || 0,
    });
```

- [ ] **Step 3: Синтаксис**

Run: `node --check public/js/app.js`
Expected: без вывода.

- [ ] **Step 4: Ручная проверка (после поднятия приложения / на деплое)**

- `rows_bushes`: вызвать конфликт на 1 ряд, открыть деление → видна подсказка «В этом ряду N кустов»; поделить кусты пополам → отчёт показывает 0.5/0.5, «всего за день» = заданному; второй с доп. полным рядом → 1.5.
- `rows_only`: ряд на двоих без ввода → 0.5/0.5; с вводом доли 0.3/0.7 → так и считается.
- Повторное деление того же ряда на троих → по 0.33, «всего за день» ровный.
- Разбор спорного: подсказка про кусты видна, доли корректны.

- [ ] **Step 5: Коммит**

```bash
git add public/js/app.js
git commit -m "feat(rows): подсказка про кусты + поле доли (rows_only) в окне деления"
```

---

## Task 9: Финал, демо-порт, деплой

- [ ] **Финальное ревью ветки** (spec + code-quality) согласно subagent-driven-development. Проверить, что все пути записи проставляют `row_weights` и `weightOfRecord` нигде не считает поделённый ряд дважды.
- [ ] **Полный прогон:** `node --test` (зелёный) + `node --check server/server.js public/js/app.js`.
- [ ] **Боевой:** PR ветки `row-control-fractional` → `origin/main` → merge → Render автодеплой. Миграция (ADD COLUMN + бэкфилл) выполнится на старте; боевые данные не меняются.
- [ ] **Демо-порт:** перенести те же изменения на `demo-five-modes` (cherry-pick кодовых коммитов; конфликтов не ждём — общие файлы), `node --test`, push в SourceCraft, на VPS `git pull && pm2 restart`, smoke `/health` 200 и `/api/report` 200.
- [ ] **Живая проверка Натали** на боевом и демо (телефон): сценарии из Task 8 Step 4.

## Self-Review

- **Покрытие спеки:** §3 модель → Task 2 (колонка) + Task 3/4/5 (запись весов). §4 миграция → Task 2. §5 ядро → Task 1. §6 пути записи → Task 3/4/5. §7 подсказка → Task 7/8. §8 отчёт → Task 6. §9 крайние случаи → Task 1 (fallback even, отсутствие веса=1) + Task 4 (strip-all). §10 тесты → Task 1 + ручные Task 8/9.
- **Типы согласованы:** `removeRowFromRecord(rowsCsv, weightsText, currentBushes, removedRow, rowBushes)` — одна сигнатура везде (Task 1 опр., Task 3 вызов). `upsertWorkLog(..., bushes, weight)` — опр. Task 3, вызовы Task 4/5 передают `weight`. `weightOfRecord(rows, row_weights)` — Task 1/6. Конфликты несут `rowBushes` (Task 7) → клиент читает `c.rowBushes` (Task 8). Спорные несут `row_bushes` (Task 7) → клиент `d.row_bushes` (Task 8). assignments несут `bushes` (rows_bushes) или `weight` (rows_only) — клиент Task 8, сервер Task 4/5.
- **Без плейсхолдеров:** код приведён во всех изменяющих шагах.
- **Принятые ограничения (не баги):** при ручном вводе бригадиром доль (rows_only) с суммой >1 или кустов больше, чем всего в ряду, сумма весов ряда может выйти за 1 — нормализации нет (та же модель, что и сейчас с кустами; ввод на ответственности бригадира). `divide` снимает ряд по разрезу БЕЗ фильтра по дате (иначе ломается «Поделить» для разных дней) — это корректно, т.к. ряд по модели «делается один раз» и не должен висеть на нескольких датах.
