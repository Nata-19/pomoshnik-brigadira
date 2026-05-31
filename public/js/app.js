class BrigadeAssistant {
  constructor() {
    this.me = null;
    this.estates = [];
    this.estate = localStorage.getItem('selectedEstate') || '';
    this.quarters = [];
    this.cellsByQuarter = {}; // кэш клеток по (estate|quarter)
    // Этап 2 — структурированный ввод
    this.employees = [];          // [{id, name}] — полный список бригады
    this.workTypes = [];          // [{id, name}] — общий список видов работ
    this.present = [];            // [{employee_id, name}] — отмеченные сегодня
    this.entries = [];            // записи журнала за выбранную дату
    this.inputDate = this.getTodayDate();
    this.ctxQuarter = '';         // «держащийся» контекст
    this.ctxCell = '';
    this.ctxWorkType = '';
    this.measureMode = 'rows_bushes';
    this.selectedEmployeeId = null;
    this.rosterOpen = false;
    this.adding = false;          // защита от двойного «Добавить»
    this.init();
  }

  async init() {
    await this.loadConfig();
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/service-worker.js').catch(e => console.log('SW error:', e));
    }

    if (this.config.demoMode) {
      // Демо: убедимся что сессия создана
      await fetch('/api/demo/session', { method: 'POST' });
      // Проверим есть ли культура
      const r = await fetch('/api/estates');
      const estates = await r.json();
      if (estates.length === 0) {
        this.renderCultureModal();
        return;
      }
      this.estate = estates[0].id;
      this.estates = estates;
      await this.loadQuarters();
      await this.loadEmployees();
      await this.loadWorkTypes();
      await this.loadAttendance(this.inputDate);
      await this.loadTodayEntries(this.inputDate);
      this.render();
      return;
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
    await this.loadEmployees();
    await this.loadWorkTypes();
    await this.loadAttendance(this.inputDate);
    await this.loadTodayEntries(this.inputDate);
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

  async loadConfig() {
    try {
      const r = await fetch('/api/config');
      this.config = await r.json();
    } catch (e) {
      this.config = { demoMode: false, brandName: 'Помощьник Бригадира', brandLogo: '🍇', measureModes: ['rows_bushes', 'rows_only', 'hours'] };
    }
    if (!this.config.measureModes) {
      this.config.measureModes = ['rows_bushes', 'rows_only', 'hours'];
    }
  }

  async loadEstates() {
    try {
      const r = await fetch('/api/estates');
      this.estates = await r.json();
    } catch (error) {
      console.error('Failed to load estates:', error);
      this.estates = [];
    }
  }

  async loadQuarters() {
    if (!this.estate) {
      this.quarters = [];
      return;
    }
    try {
      const r = await fetch('/api/quarters?estate=' + encodeURIComponent(this.estate));
      this.quarters = await r.json();
    } catch (error) {
      console.error('Failed to load quarters:', error);
      this.quarters = [];
    }
  }

  async loadCells(quarterId) {
    const key = this.estate + '|' + quarterId;
    if (this.cellsByQuarter[key]) return this.cellsByQuarter[key];
    try {
      const r = await fetch('/api/inventory/' + encodeURIComponent(this.estate) + '/' + encodeURIComponent(quarterId));
      const data = await r.json();
      const cells = Object.keys(data.cells || {}).sort((a, b) => +a - +b);
      this.cellsByQuarter[key] = cells;
      return cells;
    } catch (e) {
      return [];
    }
  }

  async loadEmployees() {
    try {
      const r = await this.apiFetch('/api/employees');
      const data = await r.json();
      this.employees = data.employees || [];
    } catch (e) {
      this.employees = [];
    }
  }

  async loadWorkTypes() {
    try {
      const r = await this.apiFetch('/api/work-types');
      const data = await r.json();
      this.workTypes = data.work_types || [];
    } catch (e) {
      this.workTypes = [];
    }
  }

  async loadAttendance(date) {
    try {
      const r = await this.apiFetch('/api/attendance?date=' + encodeURIComponent(date));
      const data = await r.json();
      this.present = data.present || [];
    } catch (e) {
      this.present = [];
    }
  }

  async loadTodayEntries(date) {
    if (!this.estate) { this.entries = []; return; }
    try {
      const r = await this.apiFetch('/api/logs?date=' + encodeURIComponent(date) +
        '&estate=' + encodeURIComponent(this.estate));
      const data = await r.json();
      this.entries = (r.ok && data.logs) ? data.logs : [];
    } catch (e) {
      this.entries = [];
    }
  }

  async onEstateChange() {
    const eSel = document.getElementById('estate-sel');
    this.estate = eSel.value;
    if (this.estate) {
      localStorage.setItem('selectedEstate', this.estate);
    } else {
      localStorage.removeItem('selectedEstate');
    }
    this.cellsByQuarter = {};
    await this.loadQuarters();
    // Сбрасываем контекст и записи журнала — они привязаны к хозяйству.
    this.ctxQuarter = '';
    this.ctxCell = '';
    this.selectedEmployeeId = null;
    await this.loadTodayEntries(this.inputDate);
    this.renderInput();
  }

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
          <label>Пароль (не короче 8 символов):</label>
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

  renderAuth(mode) {
    this.authMode = mode === 'register' ? 'register' : 'login';
    const root = document.getElementById('root');
    const isReg = this.authMode === 'register';
    root.innerHTML = `
      <div class="container auth-box">
        <h1>${this.config.brandLogo} ${this.config.brandName}</h1>
        <div class="tabs">
          <button class="tab-button ${isReg ? '' : 'active'}" onclick="app.renderAuth('login')">Войти</button>
          <button class="tab-button ${isReg ? 'active' : ''}" onclick="app.renderAuth('register')">Зарегистрироваться</button>
        </div>
        <div class="form-group">
          <label>Логин:</label>
          <input type="text" id="auth-login" autocomplete="username">
        </div>
        <div class="form-group">
          <label>Пароль${isReg ? ' (не короче 8 символов)' : ''}:</label>
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

  renderCultureModal() {
    const root = document.getElementById('root');
    root.innerHTML = `
      <div class="container auth-box">
        ${window.DemoUI.renderDemoBanner(this.config)}
        <h1>${this.config.brandLogo} ${this.config.brandName}</h1>
        <p class="auth-hint">Введи свою культуру — что у тебя растёт?</p>
        <div class="form-group">
          <label>Например: виноград, яблоня, черешня, клубника</label>
          <input type="text" id="culture-input" autofocus>
        </div>
        <button id="culture-submit" onclick="app.submitCulture()">Продолжить</button>
        <div id="culture-msg" class="auth-msg"></div>
      </div>
    `;
  }

  async submitCulture() {
    const culture = document.getElementById('culture-input').value.trim();
    const msg = document.getElementById('culture-msg');
    const btn = document.getElementById('culture-submit');
    if (!culture) { msg.textContent = '❌ Укажи культуру'; return; }
    msg.textContent = '⏳ Готовим твою песочницу…';
    if (btn) btn.disabled = true;
    try {
      const r = await fetch('/api/demo/culture', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ culture }),
      });
      const data = await r.json();
      if (data.needUnit) {
        this.renderUnitChoice(culture);
        return;
      }
      if (!r.ok) {
        msg.textContent = '❌ ' + (data.error || 'Ошибка');
        if (btn) btn.disabled = false;
        return;
      }
      location.reload();
    } catch (e) {
      msg.textContent = '❌ ' + e.message;
      if (btn) btn.disabled = false;
    }
  }

  renderUnitChoice(culture) {
    const root = document.getElementById('root');
    root.innerHTML = `
      <div class="container auth-box">
        ${window.DemoUI.renderDemoBanner(this.config)}
        <h1>${this.config.brandLogo} ${this.config.brandName}</h1>
        <p class="auth-hint">У культуры «${culture}» — что считаем?</p>
        <button onclick="app.submitCultureWithUnit('${culture}', 'bush')">🌱 Кусты</button>
        <button onclick="app.submitCultureWithUnit('${culture}', 'tree')">🌳 Деревья</button>
        <button onclick="app.submitCultureWithUnit('${culture}', 'other')">🌾 Другое (растения)</button>
        <div id="unit-msg" class="auth-msg"></div>
      </div>
    `;
  }

  async submitCultureWithUnit(culture, unit) {
    const msg = document.getElementById('unit-msg');
    if (msg) msg.textContent = '⏳ Готовим твою песочницу…';
    await fetch('/api/demo/culture', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ culture, unit }),
    });
    location.reload();
  }

  render() {
    const root = document.getElementById('root');
    root.innerHTML = `
      <div class="container">
        <div class="app-header">
          ${window.DemoUI.renderDemoBanner(this.config)}
          <h1>${this.config.brandLogo} ${this.config.brandName}</h1>
          <div class="app-user">
            ${!this.config.demoMode ? `<span>${this.escapeHtml(this.me ? this.me.login : '')}</span>` : ''}
            ${this.config.demoMode ? window.DemoUI.renderDemoResetButton() : ''}
            ${!this.config.demoMode ? `<button class="logout-btn" onclick="app.logout()">Выйти</button>` : ''}
            <select id="estate-sel" class="estate-chip" required onchange="app.onEstateChange()">
              <option value="">📍 Выбор хозяйства</option>
              ${this.estates.map(e => `<option value="${e.id}" ${e.id === this.estate ? 'selected' : ''}>${this.escapeHtml(e.name)}</option>`).join('')}
            </select>
          </div>
        </div>

        <div class="date-row">
          <input type="date" id="i2-date" class="date-chip" value="${this.inputDate}" onchange="app.onInputDateChange()">
        </div>

        <div class="tabs">
          <button class="tab-button active" onclick="app.switchTab(event, 'input')">Ввод данных</button>
          <button class="tab-button" onclick="app.switchTab(event, 'report')">Отчет за период</button>
          <button class="tab-button" onclick="app.switchTab(event, 'logs'); app.loadLogs()">Журнал</button>
          ${this.me && this.me.is_admin ? `<button class="tab-button" onclick="app.switchTab(event, 'admin'); app.loadBrigadiers()">Админ</button>` : ''}
        </div>

        <div class="tab-content active" id="input-tab"></div>

        <div class="tab-content" id="report-tab">
          <div class="form-group">
            <label>От (YYYY-MM-DD):</label>
            <input type="date" id="from-date">
          </div>

          <div class="form-group">
            <label>До (YYYY-MM-DD):</label>
            <input type="date" id="to-date">
          </div>

          <button onclick="app.getReport()">Получить отчет</button>

          <div id="report-result" class="result" style="display:none;"></div>
        </div>

        <div class="tab-content" id="logs-tab">
          <div class="form-group">
            <label>Дата:</label>
            <input type="date" id="logs-date" value="${this.getTodayDate()}" onchange="app.loadLogs()">
          </div>

          <button onclick="app.loadLogs()">Обновить</button>

          <div id="logs-list" class="logs-list"></div>
        </div>

        ${this.me && this.me.is_admin ? `
        <div class="tab-content" id="admin-tab">
          <button onclick="app.loadBrigadiers()">Обновить список</button>
          <div id="brigadiers-list" class="logs-list"></div>
        </div>` : ''}
      </div>
    `;
    this.renderInput();
  }

  switchTab(evt, tab) {
    document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.tab-button').forEach(el => el.classList.remove('active'));

    document.getElementById(tab + '-tab').classList.add('active');
    evt.currentTarget.classList.add('active');
  }

  getTodayDate() {
    const today = new Date();
    return today.toISOString().split('T')[0];
  }

  // Собирает HTML вкладки «Ввод данных» из текущего состояния.
  renderInput() {
    const tab = document.getElementById('input-tab');
    if (!tab) return;
    const modeBtn = (m, label) =>
      `<button class="mode-btn ${this.measureMode === m ? 'active' : ''}" onclick="app.setMeasureMode('${m}')">${label}</button>`;
    const selName = this.selectedName();
    tab.innerHTML = `
      <div class="ctx-block">
        <div class="block-label">Контекст</div>
        <div class="chips-row">
          <select id="i2-quarter" class="chip-select" required onchange="app.onI2QuarterChange()">
            <option value="">Квартал...</option>
            ${this.quarters.map(q => `<option value="${q.id}" ${q.id === this.ctxQuarter ? 'selected' : ''}>${this.escapeHtml(q.name)}</option>`).join('')}
          </select>
          <select id="i2-cell" class="chip-select" required onchange="app.onI2CellChange()">
            <option value="">Клетка...</option>
          </select>
          <select id="i2-worktype" class="chip-select" required onchange="app.onI2WorkTypeChange()">
            <option value="">Вид работ...</option>
            ${this.workTypes.map(w => `<option value="${this.escapeHtml(w.name)}" ${w.name === this.ctxWorkType ? 'selected' : ''}>${this.escapeHtml(w.name)}</option>`).join('')}
          </select>
        </div>
        <div class="add-inline">
          <input type="text" id="i2-new-worktype" placeholder="Новый вид работ" autocomplete="off">
          <button class="mini-btn" onclick="app.addWorkType()">+ вид работ</button>
        </div>
        <div class="block-label">Как считать:</div>
        <div class="mode-row">
          ${(this.config.measureModes || []).map(m => modeBtn(m, this.measureModeLabel(m))).join('')}
        </div>
        ${this.config.demoMode ? `
          <div class="measure-hint">
            ❓ Нужны другие единицы (тонны, столбы, погонные метры, комбинированные)?
            Настраивается под предприятие — звоните Натали ${this.escapeHtml(this.config.contactPhone || '+79783116389')}
          </div>
        ` : ''}
      </div>

      <div class="ctx-block">
        <div class="block-label">Сегодня на работе</div>
        <button class="roster-toggle" onclick="app.toggleRoster()">
          ${this.rosterOpen ? 'Скрыть список бригады ▲' : 'Выбрать рабочих из бригады ▾'}
        </button>
        ${this.rosterOpen ? this.renderRosterHtml() : ''}
        <div class="chips">
          ${this.present.length === 0
            ? '<span class="chips-empty">Пока никто не отмечен</span>'
            : this.present.map(p =>
                `<span class="chip ${p.employee_id === this.selectedEmployeeId ? 'on' : ''}" onclick="app.selectWorker(${p.employee_id})">${this.escapeHtml(p.name)}</span>`
              ).join('')}
        </div>
      </div>

      <div class="ctx-block">
        <div class="block-label">Добавить запись</div>
        <div class="sel-emp">Сотрудник: <b>${selName ? this.escapeHtml(selName) : '— выбери плашку выше'}</b></div>
        ${this.measureMode === 'hours'
          ? '<div class="form-group"><label>Часы:</label><input type="number" id="i2-hours" min="1" inputmode="numeric"></div>'
          : '<div class="form-group"><label>Ряды (например: 1-5, 9, 11 или 1-5.9.11):</label><input type="text" id="i2-rows" inputmode="numeric"></div>'}
        <button id="i2-add-btn" onclick="app.addEntry()">Добавить</button>
        <div id="i2-msg" class="auth-msg"></div>
      </div>

      <div class="ctx-block">
        <div class="block-label">Записи за ${this.escapeHtml(this.inputDate)}</div>
        <div id="i2-entries">${this.renderEntriesHtml()}</div>
      </div>

      <div class="ctx-block daily-totals">
        <div class="block-label">Всего за день</div>
        <div id="i2-totals">${this.renderDailyTotalsHtml()}</div>
      </div>
    `;
    this.refreshI2Cells();
  }

  // Имя выбранного сотрудника (по id из this.present).
  selectedName() {
    const p = this.present.find(x => x.employee_id === this.selectedEmployeeId);
    return p ? p.name : '';
  }

  // HTML выпадающего списка всей бригады с отметками явки.
  renderRosterHtml() {
    const presentIds = new Set(this.present.map(p => p.employee_id));
    const rows = this.employees.map(e => `
      <div class="roster-row ${presentIds.has(e.id) ? 'present' : ''}">
        <span class="roster-name" onclick="app.togglePresent(${e.id})">${presentIds.has(e.id) ? '☑️' : '⬜'} ${this.escapeHtml(e.name)}</span>
        <span class="roster-del" onclick="app.deleteEmployee(${e.id})">✕</span>
      </div>
    `).join('');
    return `
      <div class="roster">
        ${rows || '<div class="roster-row">В списке бригады пока никого нет.</div>'}
        <div class="add-inline roster-add">
          <input type="text" id="i2-new-emp" placeholder="Фамилия нового" autocomplete="off">
          <button class="mini-btn" onclick="app.addEmployee()">+ добавить</button>
        </div>
      </div>
    `;
  }

  // Группирует плоский массив log-записей в структуру для отображения:
  // [ { work_type, quarter, cell, workers: [{ employee, measure_mode, rows, bushes, hours, hectares, kilometers, id }] }, ... ]
  // Сортировка: вид работ алфавитно, внутри — квартал, клетка.
  // Пустые quarter/cell (часовые/механизированные без клетки) попадают в свою группу.
  groupLogsForDisplay(logs) {
    if (!logs || logs.length === 0) return [];
    const groups = new Map();
    for (const log of logs) {
      const wt = log.work_type || '';
      const q = log.quarter || '';
      const c = log.cell || '';
      const key = `${wt}||${q}||${c}`;
      if (!groups.has(key)) {
        groups.set(key, { work_type: wt, quarter: q, cell: c, workers: [] });
      }
      groups.get(key).workers.push(log);
    }
    const arr = Array.from(groups.values());
    arr.sort((a, b) => {
      const byWt = (a.work_type || '').localeCompare(b.work_type || '', 'ru');
      if (byWt !== 0) return byWt;
      const aq = Number(a.quarter) || 0;
      const bq = Number(b.quarter) || 0;
      if (aq !== bq) return aq - bq;
      const ac = Number(a.cell) || 0;
      const bc = Number(b.cell) || 0;
      return ac - bc;
    });
    return arr;
  }

  // Рисует список групп записей в новом формате.
  // deleteFnName — строка с именем метода удаления ('deleteEntry' / 'deleteLog'), или null/'' если кнопку удаления не нужна (отчёт за период).
  // multilineRows — если true, строка работника разбивается: имя+кнопка сверху, измерение (номера рядов) отдельной строкой ниже с переносом по словам. Используется в Журнале, чтобы длинный список рядов не обрезался.
  // Возвращает готовый HTML строкой.
  renderLogGroupsHtml(groups, deleteFnName, multilineRows = false) {
    if (!groups || groups.length === 0) {
      return '<p class="chips-empty">Записей пока нет.</p>';
    }
    return groups.map(g => {
      const place = (g.quarter || g.cell)
        ? `Кв.${this.escapeHtml(g.quarter)}${g.cell ? ', клет.' + this.escapeHtml(g.cell) : ''}`
        : '';
      const head = `<div class="log-group-head">${this.escapeHtml(g.work_type || '—')}${place ? ' · ' + place : ''}</div>`;
      const rows = g.workers.map(w => {
        let measure;
        if (w.measure_mode === 'hours') {
          measure = `${w.hours} часов`;
        } else if (w.measure_mode === 'hectares') {
          measure = `${w.hectares != null ? w.hectares : 0} гектаров`;
        } else if (w.measure_mode === 'kilometers') {
          measure = `${w.kilometers != null ? w.kilometers : 0} км`;
        } else {
          measure = String(w.rows || '')
            .split(',')
            .map(s => s.trim())
            .filter(Boolean)
            .join(', ') || '—';
        }
        const deleteBtn = deleteFnName
          ? `<button class="delete-btn-mini" onclick="app.${deleteFnName}(${w.id})">✕</button>`
          : '';
        if (multilineRows) {
          return `
            <div class="log-worker-row multiline">
              <div class="log-worker-head">
                <span class="log-worker-name">${this.escapeHtml(w.employee)}</span>
                ${deleteBtn}
              </div>
              <div class="log-worker-measure">${measure}</div>
            </div>
          `;
        }
        return `
          <div class="log-worker-row">
            <span class="log-worker-name">${this.escapeHtml(w.employee)} — ${measure}</span>
            ${deleteBtn}
          </div>
        `;
      }).join('');
      return `<div class="log-group">${head}${rows}</div>`;
    }).join('');
  }

  // Возвращает множественное «кустов»/«деревьев»/«растений» для подписи в журнале и плашке записей.
  // Ищем unit в кварталах текущего хозяйства; если не найден (старая запись или прод-данные без unit) — fallback «кустов».
  getUnitLabel(log) {
    if (!log) return 'кустов';
    const q = this.quarters && this.quarters.find(q => String(q.id) === String(log.quarter) || (q.name && q.name.endsWith('.' + log.quarter)));
    const unit = q ? q.unit : null;
    if (unit === 'tree') return 'деревьев';
    if (unit === 'other') return 'растений';
    return 'кустов';
  }

  // Подпись на кнопке режима подсчёта. Меняется только для rows_bushes
  // в зависимости от unit текущего выбранного квартала.
  measureModeLabel(mode) {
    if (mode === 'rows_bushes') {
      const q = this.quarters && this.quarters.find(q => String(q.id) === String(this.ctxQuarter));
      const unit = q ? q.unit : null;
      if (unit === 'tree') return 'Ряды + деревья';
      if (unit === 'other') return 'Ряды + растения';
      return 'Ряды + кусты';
    }
    if (mode === 'rows_only') return 'Только ряды';
    if (mode === 'hours') return 'Только часы';
    if (mode === 'hectares') return 'Гектары';
    if (mode === 'kilometers') return 'Километры';
    return mode;
  }

  // Группировка логов по работнику для Отчёта за период.
  // Возвращает Map: имя работника → массив активностей.
  // Каждая активность = уникальная пара (вид работ, квартал, клетка, режим) с суммированными цифрами.
  groupLogsByEmployee(logs) {
    const byEmp = new Map();
    if (!logs || logs.length === 0) return byEmp;
    for (const log of logs) {
      const emp = log.employee || '—';
      if (!byEmp.has(emp)) byEmp.set(emp, new Map());
      const acts = byEmp.get(emp);
      const key = [log.work_type || '', log.quarter || '', log.cell || '', log.measure_mode || ''].join('||');
      if (!acts.has(key)) {
        acts.set(key, {
          work_type: log.work_type || '',
          quarter: log.quarter || '',
          cell: log.cell || '',
          measure_mode: log.measure_mode || '',
          rowCount: 0,
          bushes: 0,
          hours: 0,
          hectares: 0,
          kilometers: 0,
        });
      }
      const a = acts.get(key);
      a.rowCount += String(log.rows || '').split(',').filter(x => x.trim()).length;
      a.bushes += Number(log.bushes) || 0;
      a.hours += Number(log.hours) || 0;
      a.hectares += Number(log.hectares) || 0;
      a.kilometers += Number(log.kilometers) || 0;
    }
    const sorted = new Map();
    const names = Array.from(byEmp.keys()).sort((a, b) => a.localeCompare(b, 'ru'));
    for (const emp of names) {
      const acts = Array.from(byEmp.get(emp).values());
      acts.sort((a, b) => {
        const byWt = (a.work_type || '').localeCompare(b.work_type || '', 'ru');
        if (byWt !== 0) return byWt;
        const aq = Number(a.quarter) || 0;
        const bq = Number(b.quarter) || 0;
        if (aq !== bq) return aq - bq;
        const ac = Number(a.cell) || 0;
        const bc = Number(b.cell) || 0;
        return ac - bc;
      });
      sorted.set(emp, acts);
    }
    return sorted;
  }

  // Рисует Отчёт за период в формате «работник → его активности» (по запросу Натали).
  // Каждая активность: вид работ · квартал/клетка — сумма (рядов/кустов, часов, га, км).
  renderEmployeeReportHtml(byEmp) {
    if (!byEmp || byEmp.size === 0) {
      return '<p class="chips-empty">За этот период записей нет.</p>';
    }
    const blocks = [];
    for (const [emp, acts] of byEmp) {
      const empHead = `<div class="report-emp-head">${this.escapeHtml(emp)}</div>`;
      const lines = acts.map(a => {
        const place = (a.quarter || a.cell)
          ? `Кв.${this.escapeHtml(a.quarter)}${a.cell ? ', клет.' + this.escapeHtml(a.cell) : ''}`
          : '';
        let measure;
        if (a.measure_mode === 'hours') {
          measure = `${a.hours} часов`;
        } else if (a.measure_mode === 'hectares') {
          measure = `${a.hectares} гектаров`;
        } else if (a.measure_mode === 'kilometers') {
          measure = `${a.kilometers} км`;
        } else if (a.measure_mode === 'rows_bushes') {
          measure = `${a.rowCount} рядов, ${a.bushes} кустов`;
        } else {
          measure = `${a.rowCount} рядов`;
        }
        const wtPlace = `${this.escapeHtml(a.work_type || '—')}${place ? ' · ' + place : ''}`;
        return `<div class="report-emp-act">${wtPlace} — ${measure}</div>`;
      }).join('');
      blocks.push(`<div class="report-emp-block">${empHead}${lines}</div>`);
    }
    return blocks.join('');
  }

  // Плашка «Всего за день» на Вводе данных.
  // Группировка: вид работ → квартал/клетка. Суммы рядов и кустов по записям rows_bushes/rows_only.
  // Часовые/гектарные/километровые записи в эту плашку не входят.
  // Общий итог по всем видам работ НЕ показываем — это семантически некорректно (нельзя складывать ряды разных работ).
  renderDailyTotalsHtml() {
    if (!this.entries || this.entries.length === 0) {
      return '<p class="chips-empty">Пока пусто.</p>';
    }
    const byWt = new Map();
    for (const log of this.entries) {
      if (log.measure_mode !== 'rows_bushes' && log.measure_mode !== 'rows_only') continue;
      const rowCount = String(log.rows || '').split(',').filter(x => x.trim()).length;
      const bushes = Number(log.bushes) || 0;
      const wt = log.work_type || '—';
      if (!byWt.has(wt)) byWt.set(wt, new Map());
      const byCell = byWt.get(wt);
      const cellKey = `Кв.${log.quarter || '?'}, клет.${log.cell || '?'}`;
      if (!byCell.has(cellKey)) byCell.set(cellKey, { rows: 0, bushes: 0 });
      const agg = byCell.get(cellKey);
      agg.rows += rowCount;
      agg.bushes += bushes;
    }
    if (byWt.size === 0) {
      return '<p class="chips-empty">Ручных записей пока нет.</p>';
    }
    const wtBlocks = [];
    for (const [wt, byCell] of byWt) {
      const cellLines = [];
      for (const [cellKey, agg] of byCell) {
        cellLines.push(`<div class="total-cell-row"><span>${this.escapeHtml(cellKey)}</span><span>${agg.rows} рядов, ${agg.bushes} кустов</span></div>`);
      }
      wtBlocks.push(`<div class="total-wt-block"><div class="total-wt-head">${this.escapeHtml(wt)}</div>${cellLines.join('')}</div>`);
    }
    return wtBlocks.join('');
  }

  // HTML карточек записей за выбранную дату.
  renderEntriesHtml() {
    if (!this.entries || this.entries.length === 0) {
      return '<p class="chips-empty">Записей пока нет.</p>';
    }
    return this.entries.map(log => {
      let measure;
      if (log.measure_mode === 'hours') {
        measure = `${log.hours} часов`;
      } else {
        const rowCount = String(log.rows || '').split(',').filter(x => x.trim()).length;
        measure = `${rowCount} рядов`;
        if (log.measure_mode === 'rows_bushes') measure += ` · ${log.bushes} кустов`;
      }
      const place = log.measure_mode === 'hours' && !log.quarter
        ? '' : ` · Кв.${this.escapeHtml(log.quarter)} кл.${this.escapeHtml(log.cell)}`;
      return `
        <div class="entry-card">
          <div class="log-info">
            <div class="log-employee">${this.escapeHtml(log.employee)}</div>
            <div class="log-meta">${this.escapeHtml(log.work_type || '')}${place}</div>
            <div class="log-meta">${measure}</div>
          </div>
          <button class="delete-btn" onclick="app.deleteEntry(${log.id})">Удалить</button>
        </div>
      `;
    }).join('');
  }

  // Загружает клетки выбранного квартала в селект #i2-cell.
  async refreshI2Cells() {
    const cSel = document.getElementById('i2-cell');
    if (!cSel) return;
    if (!this.ctxQuarter) {
      cSel.innerHTML = '<option value="">Клетка...</option>';
      return;
    }
    const cells = await this.loadCells(this.ctxQuarter);
    cSel.innerHTML = '<option value="">Клетка...</option>' +
      cells.map(c => `<option value="${c}" ${String(c) === String(this.ctxCell) ? 'selected' : ''}>Клетка ${c}</option>`).join('');
  }

  async onInputDateChange() {
    this.inputDate = document.getElementById('i2-date').value || this.getTodayDate();
    await this.loadAttendance(this.inputDate);
    await this.loadTodayEntries(this.inputDate);
    this.renderInput();
  }

  async onI2QuarterChange() {
    this.ctxQuarter = document.getElementById('i2-quarter').value;
    this.ctxCell = '';
    await this.refreshI2Cells();
  }

  onI2CellChange() {
    this.ctxCell = document.getElementById('i2-cell').value;
  }

  onI2WorkTypeChange() {
    this.ctxWorkType = document.getElementById('i2-worktype').value;
    // Автоподстановка дефолтного режима подсчёта, если он есть у выбранного вида работ
    // и присутствует в списке разрешённых режимов из конфига.
    const wt = this.workTypes.find(w => w.name === this.ctxWorkType);
    if (wt && wt.default_measure_mode && (this.config.measureModes || []).includes(wt.default_measure_mode)) {
      this.measureMode = wt.default_measure_mode;
      this.renderInput();
    }
  }

  setMeasureMode(mode) {
    this.measureMode = mode;
    this.renderInput();
  }

  toggleRoster() {
    this.rosterOpen = !this.rosterOpen;
    this.renderInput();
  }

  async addWorkType() {
    const input = document.getElementById('i2-new-worktype');
    const name = input ? input.value.trim() : '';
    const msg = document.getElementById('i2-msg');
    if (!name) { if (msg) msg.textContent = '❌ Впиши название вида работ'; return; }
    try {
      const r = await this.apiFetch('/api/work-types', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) { if (msg) msg.textContent = '❌ ' + (data.error || 'Ошибка'); return; }
      await this.loadWorkTypes();
      this.ctxWorkType = data.work_type ? data.work_type.name : name;
      this.renderInput();
    } catch (e) {
      if (msg) msg.textContent = '❌ ' + e.message;
    }
  }

  async addEmployee() {
    const input = document.getElementById('i2-new-emp');
    const name = input ? input.value.trim() : '';
    if (!name) return;
    try {
      const r = await this.apiFetch('/api/employees', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) { alert('Ошибка: ' + (data.error || 'не удалось')); return; }
      await this.loadEmployees();
      // Нового сразу отмечаем присутствующим.
      if (data.employee) {
        await this.markPresent(data.employee.id);
        await this.loadAttendance(this.inputDate);
      }
      this.renderInput();
    } catch (e) {
      alert('Ошибка: ' + e.message);
    }
  }

  async deleteEmployee(id) {
    if (!confirm('Удалить этого сотрудника из списка бригады?')) return;
    try {
      const r = await this.apiFetch('/api/employees/' + id, { method: 'DELETE' });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        alert('Ошибка: ' + (data.error || 'не удалось'));
        return;
      }
      if (this.selectedEmployeeId === id) this.selectedEmployeeId = null;
      await this.loadEmployees();
      await this.loadAttendance(this.inputDate);
      this.renderInput();
    } catch (e) {
      alert('Ошибка: ' + e.message);
    }
  }

  async togglePresent(employeeId) {
    const isPresent = this.present.some(p => p.employee_id === employeeId);
    try {
      if (isPresent) {
        await this.apiFetch('/api/attendance', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ date: this.inputDate, employee_id: employeeId }),
        });
        if (this.selectedEmployeeId === employeeId) this.selectedEmployeeId = null;
      } else {
        await this.markPresent(employeeId);
      }
      await this.loadAttendance(this.inputDate);
      this.renderInput();
    } catch (e) {
      alert('Ошибка: ' + e.message);
    }
  }

  async markPresent(employeeId) {
    const r = await this.apiFetch('/api/attendance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: this.inputDate, employee_id: employeeId }),
    });
    if (!r.ok) {
      const data = await r.json().catch(() => ({}));
      throw new Error(data.error || 'Не удалось отметить присутствующим');
    }
  }

  selectWorker(employeeId) {
    this.selectedEmployeeId = employeeId;
    this.renderInput();
  }

  async addEntry() {
    if (this.adding) return;
    const msg = document.getElementById('i2-msg');
    const setMsg = (t) => { if (msg) { msg.className = 'auth-msg'; msg.textContent = t; } };
    if (!this.estate) { setMsg('❌ Сначала выбери хозяйство'); return; }
    const employee = this.selectedName();
    if (!employee) { setMsg('❌ Выбери сотрудника (плашку выше)'); return; }
    if (!this.ctxWorkType) { setMsg('❌ Выбери вид работ'); return; }

    const body = {
      date: this.inputDate,
      estate: this.estate,
      quarter: this.ctxQuarter,
      cell: this.ctxCell,
      work_type: this.ctxWorkType,
      measure_mode: this.measureMode,
      employee: employee,
    };
    if (this.measureMode === 'hours') {
      const hoursEl = document.getElementById('i2-hours');
      body.hours = hoursEl ? hoursEl.value : '';
    } else {
      if (!this.ctxCell) { setMsg('❌ Выбери клетку'); return; }
      const rowsEl = document.getElementById('i2-rows');
      body.rows = rowsEl ? rowsEl.value : '';
    }

    const btn = document.getElementById('i2-add-btn');
    this.adding = true;
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Добавляю...'; }
    try {
      const r = await this.apiFetch('/api/logs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) { setMsg('❌ ' + (data.error || 'Ошибка')); return; }
      await this.loadTodayEntries(this.inputDate);
      this.selectedEmployeeId = null;
      this.renderInput();
    } catch (e) {
      setMsg('❌ ' + e.message);
    } finally {
      this.adding = false;
      const b = document.getElementById('i2-add-btn');
      if (b) { b.disabled = false; b.textContent = 'Добавить'; }
    }
  }

  async deleteEntry(id) {
    if (!confirm('Удалить эту запись? Действие нельзя отменить.')) return;
    try {
      const r = await this.apiFetch('/api/logs/' + id, { method: 'DELETE' });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        alert('Ошибка удаления: ' + (data.error || 'не удалось'));
        return;
      }
      await this.loadTodayEntries(this.inputDate);
      this.renderInput();
    } catch (e) {
      alert('Ошибка: ' + e.message);
    }
  }

  showResult(text, isError, element) {
    element.textContent = text;
    element.classList.remove('error', 'success');
    element.classList.add(isError ? 'error' : 'success');
    element.style.display = 'block';
  }

  async loadLogs() {
    const date = document.getElementById('logs-date').value;
    const list = document.getElementById('logs-list');
    if (!this.estate) {
      list.innerHTML = '<p style="color:#888;padding:10px;">Сначала выбери хозяйство</p>';
      return;
    }
    if (!date) {
      list.innerHTML = '<p style="color:#888;padding:10px;">Выбери дату</p>';
      return;
    }
    list.innerHTML = '<p style="padding:10px;">⏳ Загрузка...</p>';
    try {
      const r = await fetch('/api/logs?date=' + encodeURIComponent(date) + '&estate=' + encodeURIComponent(this.estate));
      const data = await r.json();
      if (!r.ok) {
        list.innerHTML = '<p style="color:#c0392b;padding:10px;">❌ ' + (data.error || 'Ошибка') + '</p>';
        return;
      }
      if (!data.logs || data.logs.length === 0) {
        list.innerHTML = '<p style="color:#888;padding:10px;">За эту дату записей нет.</p>';
        return;
      }
      const groups = this.groupLogsForDisplay(data.logs);
      list.innerHTML = this.renderLogGroupsHtml(groups, 'deleteLog', true);
    } catch (e) {
      list.innerHTML = '<p style="color:#c0392b;padding:10px;">❌ ' + e.message + '</p>';
    }
  }

  async deleteLog(id) {
    if (!confirm('Удалить эту запись? Действие нельзя отменить.')) return;
    try {
      const r = await fetch('/api/logs/' + id, { method: 'DELETE' });
      if (r.ok) {
        this.loadLogs();
      } else {
        const data = await r.json().catch(() => ({}));
        alert('Ошибка удаления: ' + (data.error || 'не удалось'));
      }
    } catch (e) {
      alert('Ошибка: ' + e.message);
    }
  }

  escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
  }

  async getReport() {
    const from = document.getElementById('from-date').value;
    const to = document.getElementById('to-date').value;
    const resultDiv = document.getElementById('report-result');

    if (!this.estate) {
      this.showResult('❌ Сначала выбери хозяйство', true, resultDiv);
      return;
    }
    if (!from || !to) {
      this.showResult('❌ Укажите обе даты', true, resultDiv);
      return;
    }
    if (from > to) {
      this.showResult('❌ Дата «От» позже даты «До»', true, resultDiv);
      return;
    }

    resultDiv.style.display = 'block';
    resultDiv.classList.remove('error', 'success');
    resultDiv.innerHTML = '<p style="padding:10px;">⏳ Загрузка отчёта...</p>';

    try {
      const r = await fetch(`/api/logs?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&estate=${encodeURIComponent(this.estate)}`);
      const data = await r.json();
      if (!r.ok) {
        resultDiv.innerHTML = '<p style="color:#c0392b;padding:10px;">❌ ' + (data.error || 'Не удалось получить отчёт') + '</p>';
        return;
      }
      if (!data.logs || data.logs.length === 0) {
        resultDiv.innerHTML = '<p style="color:#888;padding:10px;">За этот период записей нет.</p>';
        return;
      }
      const byEmp = this.groupLogsByEmployee(data.logs);
      const header = `<div class="report-header">Отчёт с ${this.escapeHtml(from)} по ${this.escapeHtml(to)}</div>`;
      resultDiv.innerHTML = header + this.renderEmployeeReportHtml(byEmp);
    } catch (e) {
      resultDiv.innerHTML = '<p style="color:#c0392b;padding:10px;">❌ ' + e.message + '</p>';
    }
  }

  async logout() {
    try { await fetch('/api/logout', { method: 'POST' }); } catch (e) {}
    location.reload();
  }

  async resetDemo() {
    if (!confirm('Точно? Все твои записи удалятся, начнётся новая чистая сессия.')) return;
    try {
      await fetch('/api/demo/reset', { method: 'POST' });
      location.reload();
    } catch (e) {
      alert('Не удалось сбросить: ' + e.message);
    }
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
            <input class="reset-pw-input" type="text" id="reset-pw-${b.id}" placeholder="Новый пароль" autocomplete="off">
            <button class="mini-btn" onclick="app.resetBrigadierPassword(${b.id})">Сброс пароля</button>
            <span class="reset-msg" id="reset-msg-${b.id}"></span>
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
    // Ввод нового пароля — через поле в строке аккаунта, а не prompt():
    // системное окошко prompt() не показывается в установленном на телефон
    // приложении (standalone-режим Android Chrome).
    const inputEl = document.getElementById('reset-pw-' + id);
    const msgEl = document.getElementById('reset-msg-' + id);
    const password = inputEl ? inputEl.value : '';
    const showMsg = (text, ok) => {
      if (msgEl) {
        msgEl.textContent = text;
        msgEl.className = 'reset-msg' + (ok ? ' reset-ok' : '');
      }
    };
    if (!password || password.length < 8) {
      showMsg('❌ Пароль не короче 8 символов', false);
      return;
    }
    try {
      const r = await this.apiFetch('/api/admin/brigadiers/' + id + '/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const data = await r.json().catch(() => ({}));
      if (r.ok) {
        if (inputEl) inputEl.value = '';
        showMsg('✅ Пароль изменён — сообщите его бригадиру', true);
      } else {
        showMsg('❌ ' + (data.error || 'не удалось'), false);
      }
    } catch (e) {
      showMsg('❌ ' + e.message, false);
    }
  }
}

const app = new BrigadeAssistant();
