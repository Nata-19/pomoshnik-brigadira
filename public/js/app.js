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
    this.ctxCells = [];           // мульти-выбор клеток для режима «Гектары»
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
        // На стартовой странице ввода культур гайд не запускаем — там и так
        // одно понятное поле ввода, облако только мешало бы.
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
      this._maybeAutoStartGuide();
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
    // В демо: плашка «Всего за день» показывает ВСЁ за день по хозяйству,
    // по всем культурам сразу — один рабочий может работать утром на яблоне,
    // потом на винограде, обе записи должны быть видны. Поэтому здесь без
    // фильтра по estate. В проде у бригадира пока одно хозяйство — фильтруем
    // как раньше для совместимости.
    if (!this.config.demoMode && !this.estate) { this.entries = []; return; }
    try {
      let url = '/api/logs?date=' + encodeURIComponent(date);
      if (!this.config.demoMode && this.estate) {
        url += '&estate=' + encodeURIComponent(this.estate);
      }
      const r = await this.apiFetch(url);
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

  renderCultureModal(mode) {
    // mode: 'initial' (по умолчанию) — нет ни одной культуры в сессии,
    //         одно поле, культуры через запятую («яблоня, виноград, клубника»);
    //       'add' — добавляем одну ещё в существующее хозяйство (тоже одно поле).
    const isAdd = mode === 'add';
    const root = document.getElementById('root');
    root.innerHTML = `
      <div class="container auth-box">
        ${window.DemoUI.renderDemoBanner(this.config)}
        <h1>${this.config.brandLogo} ${this.config.brandName}</h1>
        <p class="auth-hint">${isAdd
          ? 'Какую культуру добавить в хозяйство?'
          : 'Какие культуры у тебя растут? Перечисли через запятую.'}</p>
        <div class="form-group">
          <input type="text" id="culture-input" autofocus autocomplete="off"
                 placeholder="${isAdd ? 'яблоня' : 'яблоня, виноград, клубника'}">
        </div>
        <div>
          <button id="culture-submit" onclick="app.submitCultures()">${isAdd ? 'Добавить' : 'Готово — создать хозяйство'}</button>
          ${isAdd ? `<button class="logout-btn" onclick="location.reload()" style="margin-left:8px">← Назад</button>` : ''}
        </div>
        <div id="culture-msg" class="auth-msg"></div>
      </div>
    `;
  }

  // Разбирает строку из поля #culture-input по запятой и отправляет каждую
  // культуру по очереди. Сервер сам угадывает (яблоня → дерево и т.д.);
  // если культуру не узнал — покажем одноразовый выбор «дерево/куст/другое»
  // только для неё, потом продолжаем очередь.
  async submitCultures() {
    const input = document.getElementById('culture-input');
    const msg = document.getElementById('culture-msg');
    const btn = document.getElementById('culture-submit');
    if (!input) return;
    const raw = input.value || '';
    const names = [];
    for (const part of raw.split(',')) {
      const name = part.trim();
      if (name && !names.find(n => n.toLowerCase() === name.toLowerCase())) names.push(name);
    }
    if (names.length === 0) {
      msg.textContent = '❌ Укажи хотя бы одну культуру';
      return;
    }
    msg.textContent = '⏳ Готовим твоё хозяйство…';
    if (btn) btn.disabled = true;
    this._cultureQueue = names;
    await this._processCultureQueue();
  }

  async _processCultureQueue() {
    while (this._cultureQueue && this._cultureQueue.length > 0) {
      const name = this._cultureQueue[0];
      try {
        const r = await fetch('/api/demo/culture', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ culture: name }),
        });
        const data = await r.json().catch(() => ({}));
        if (data.needUnit) {
          this._renderUnitChoiceForQueue(name);
          return;
        }
        if (!r.ok) {
          const msg = document.getElementById('culture-msg');
          if (msg) msg.textContent = `❌ «${name}»: ${data.error || 'ошибка'}`;
          const btn = document.getElementById('culture-submit');
          if (btn) btn.disabled = false;
          return;
        }
        this._cultureQueue.shift();
      } catch (e) {
        const msg = document.getElementById('culture-msg');
        if (msg) msg.textContent = '❌ ' + e.message;
        const btn = document.getElementById('culture-submit');
        if (btn) btn.disabled = false;
        return;
      }
    }
    location.reload();
  }

  _renderUnitChoiceForQueue(culture) {
    const root = document.getElementById('root');
    root.innerHTML = `
      <div class="container auth-box">
        ${window.DemoUI.renderDemoBanner(this.config)}
        <h1>${this.config.brandLogo} ${this.config.brandName}</h1>
        <p class="auth-hint">Не узнал культуру «${this.escapeHtml(culture)}». Что считаем?</p>
        <button onclick="app._answerQueueUnit('bush')">🌱 Кусты</button>
        <button onclick="app._answerQueueUnit('tree')">🌳 Деревья</button>
        <button onclick="app._answerQueueUnit('other')">🌾 Другое (растения)</button>
        <div id="unit-msg" class="auth-msg"></div>
      </div>
    `;
    this._pendingUnitFor = culture;
  }

  async _answerQueueUnit(unit) {
    const culture = this._pendingUnitFor;
    if (!culture) return;
    const msgEl = document.getElementById('unit-msg');
    if (msgEl) msgEl.textContent = '⏳ Готовим…';
    try {
      const r = await fetch('/api/demo/culture', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ culture, unit }),
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        if (msgEl) msgEl.textContent = `❌ «${culture}»: ${data.error || 'ошибка'}`;
        return;
      }
      this._cultureQueue.shift();
      this._pendingUnitFor = null;
      await this._processCultureQueue();
    } catch (e) {
      if (msgEl) msgEl.textContent = '❌ ' + e.message;
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
    if (msg) msg.textContent = '⏳ Готовим твоё хозяйство…';
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
            ${this.config.demoMode ? `<button class="mini-btn" onclick="app.renderCultureModal('add')">+ ещё культура</button>` : ''}
            ${this.config.demoMode ? `<button class="mini-btn" onclick="app.startGuide()">❓ Как пользоваться</button>` : ''}
            ${!this.config.demoMode ? `<button class="logout-btn" onclick="app.logout()">Выйти</button>` : ''}
            <select id="estate-sel" class="estate-chip" required onchange="app.onEstateChange()">
              <option value="">${this.config.demoMode ? '🌳 Выбор культуры' : '📍 Выбор хозяйства'}</option>
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
          <button class="tab-button" onclick="app.switchTab(event, 'disputed'); app.loadDisputed()">Спорные</button>
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

        <div class="tab-content" id="disputed-tab">
          <button onclick="app.loadDisputed()">Обновить</button>
          <div id="disputed-list" class="logs-list"></div>
        </div>

        ${this.me && this.me.is_admin ? `
        <div class="tab-content" id="admin-tab">
          <button onclick="app.loadBrigadiers()">Обновить список</button>
          <div id="brigadiers-list" class="logs-list"></div>
        </div>` : ''}
      </div>
    `;
    this.renderInput();
    this.applyFlatpickr();
  }

  // Превращает нативные <input type="date"> в красивый календарь flatpickr
  // с русскими названиями месяцев («15 января 2026»). Внутренние значения
  // остаются YYYY-MM-DD, бэкенду ничего менять не надо.
  applyFlatpickr() {
    if (typeof flatpickr === 'undefined') return;
    document.querySelectorAll('input[type="date"]').forEach(el => {
      if (el._flatpickr) return; // уже применено
      flatpickr(el, {
        locale: 'ru',
        dateFormat: 'Y-m-d',
        altInput: true,
        altFormat: 'j F Y',
        allowInput: true,
      });
    });
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
          ${this.measureMode === 'hectares' ? '' : `
          <select id="i2-cell" class="chip-select" required onchange="app.onI2CellChange()">
            <option value="">Клетка...</option>
          </select>`}
          <select id="i2-worktype" class="chip-select" required onchange="app.onI2WorkTypeChange('manual')">
            <option value="">${this.config.demoMode ? 'Вид работ (ручные)...' : 'Вид работ...'}</option>
            ${this.workTypes.filter(w => (w.kind || 'manual') !== 'mechanized').map(w => `<option value="${this.escapeHtml(w.name)}" ${w.name === this.ctxWorkType ? 'selected' : ''}>${this.escapeHtml(w.name)}</option>`).join('')}
          </select>
          ${this.config.demoMode ? `
          <select id="i2-worktype-mech" class="chip-select" onchange="app.onI2WorkTypeChange('mechanized')">
            <option value="">🚜 Механизированные...</option>
            ${this.workTypes.filter(w => w.kind === 'mechanized').map(w => `<option value="${this.escapeHtml(w.name)}" ${w.name === this.ctxWorkType ? 'selected' : ''}>${this.escapeHtml(w.name)}</option>`).join('')}
          </select>` : ''}
        </div>
        <div class="add-inline">
          <input type="text" id="i2-new-worktype" placeholder="Новый вид работ" autocomplete="off">
          ${this.config.demoMode ? `
          <select id="i2-new-worktype-kind" class="chip-select" style="max-width:160px">
            <option value="manual">Ручной</option>
            <option value="mechanized">🚜 Механизированный</option>
          </select>` : ''}
          <button class="mini-btn" onclick="app.addWorkType()">+ вид работ</button>
        </div>
        <div class="block-label">Как считать:</div>
        <div class="mode-row">
          ${(this.config.measureModes || []).map(m => modeBtn(m, this.measureModeLabel(m))).join('')}
        </div>
        ${this.measureMode === 'hectares' ? `
          <div class="cells-multi-block">
            <div class="block-label">Клетки (отметь все, на которых работал трактор)</div>
            <div id="i2-cells-multi" class="cells-multi">Сначала выбери квартал.</div>
          </div>` : ''}
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
        ${
          this.measureMode === 'hours'
            ? '<div class="form-group"><label>Часы:</label><input type="number" id="i2-hours" min="1" inputmode="numeric"></div>'
          : this.measureMode === 'kilometers'
            ? '<div class="form-group"><label>Километры:</label><input type="number" id="i2-kilometers" min="0.01" step="0.01" inputmode="decimal"></div>'
          : (this.measureMode === 'rows_bushes' || this.measureMode === 'rows_only' || this.measureMode === 'hectares')
            ? `<div class="form-group"><label>Ряды (например: 1-5, 9, 11 или 1-5.9.11):</label><input type="text" id="i2-rows" inputmode="numeric">${this.measureMode === 'hectares' ? '<div class="measure-hint">Гектары посчитаются автоматически из выбранных рядов и площади клетки.</div>' : ''}</div>`
          : '<div class="form-group"><label>Ряды (например: 1-5, 9, 11 или 1-5.9.11):</label><input type="text" id="i2-rows" inputmode="numeric"></div>'
        }
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
    this.applyFlatpickr();
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
  // Возвращает unit (tree/bush/other) для подписей. Если в записи/контексте
  // указан конкретный квартал — берём из него. Иначе fallback на unit первого
  // квартала хозяйства (для демо все кварталы одного хозяйства имеют одинаковый unit).
  currentUnit(quarterId) {
    if (!this.quarters || this.quarters.length === 0) return null;
    if (quarterId) {
      const q = this.quarters.find(q =>
        String(q.id) === String(quarterId) ||
        (q.name && q.name.endsWith('.' + quarterId))
      );
      if (q) return q.unit || null;
    }
    return this.quarters[0].unit || null;
  }

  getUnitLabel(log) {
    const unit = this.currentUnit(log && log.quarter);
    if (unit === 'tree') return 'деревьев';
    if (unit === 'other') return 'растений';
    return 'кустов';
  }

  // Подпись на кнопке режима подсчёта. Меняется только для rows_bushes
  // в зависимости от unit текущего выбранного квартала (или первого, если ничего не выбрано).
  measureModeLabel(mode) {
    if (mode === 'rows_bushes') {
      const unit = this.currentUnit(this.ctxQuarter);
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

  // Сжимает строку списка вида «1,2,3,5,7,8» в «1-3, 5, 7-8» — компактный
  // диапазон. Используем и для клеток, и для рядов в отчёте.
  formatRange(str) {
    if (!str) return '';
    const nums = String(str).split(',').map(x => x.trim()).filter(Boolean)
      .map(Number).filter(n => Number.isFinite(n)).sort((a, b) => a - b);
    if (nums.length === 0) return String(str);
    const groups = [];
    let start = nums[0], prev = nums[0];
    for (let i = 1; i < nums.length; i++) {
      if (nums[i] === prev + 1) {
        prev = nums[i];
      } else {
        groups.push(start === prev ? `${start}` : `${start}-${prev}`);
        start = nums[i];
        prev = nums[i];
      }
    }
    groups.push(start === prev ? `${start}` : `${start}-${prev}`);
    return groups.join(', ');
  }

  // Демо: обучающее облачко с хвостиком, который указывает на нужный элемент
  // на странице. target — CSS-селектор; если null, облачко по центру экрана.
  _guideSteps() {
    return [
      { target: null, text: 'Привет! Это демо «Помощник Бригадира». Покажу за минуту, как пользоваться.' },
      { target: '#estate-sel', text: 'В шапке выбери культуру: у каждой свои кварталы, клетки и записи.' },
      { target: '.chips-row', text: 'Выбери квартал, клетку, вид работ.' },
      { target: '.mode-row', text: 'Выбери режим «Как считать»: ряды+кусты, ряды, часы, гектары или километры. Активный подсветится синим.' },
      { target: '.roster-toggle', text: 'Открой список бригады и отметь галочками кто сегодня на работе.' },
      { target: '.chips', text: 'Нажми на фамилию рабочего — она подсветится синим, значит выбран.' },
      { target: '#i2-rows', text: 'Введи ряды (например «1-5, 9»).' },
      { target: '#i2-add-btn', text: 'Жми «Добавить» — запись попадёт в плашку «Всего за день» внизу.' },
      { target: '.tabs', text: 'Вкладки «Журнал» и «Отчёт за период» покажут что бригадир ввёл.' },
    ];
  }

  startGuide() {
    if (!this.config || !this.config.demoMode) return;
    this._guideStep = 0;
    try { localStorage.setItem('demo_guide_step', '0'); } catch (e) {}
    this._renderGuide();
  }

  _maybeAutoStartGuide() {
    if (!this.config || !this.config.demoMode) return;
    let done = false;
    let saved = 0;
    try {
      done = localStorage.getItem('demo_guide_done') === 'true';
      saved = parseInt(localStorage.getItem('demo_guide_step') || '0', 10) || 0;
    } catch (e) {}
    if (done) return;
    this._guideStep = Math.max(0, Math.min(saved, this._guideSteps().length - 1));
    this._renderGuide();
  }

  nextGuideStep() {
    this._guideStep = (this._guideStep || 0) + 1;
    if (this._guideStep >= this._guideSteps().length) {
      this.closeGuide();
      return;
    }
    try { localStorage.setItem('demo_guide_step', String(this._guideStep)); } catch (e) {}
    this._renderGuide();
  }

  closeGuide() {
    try {
      localStorage.setItem('demo_guide_done', 'true');
      localStorage.removeItem('demo_guide_step');
    } catch (e) {}
    const el = document.getElementById('demo-guide');
    if (el) el.remove();
    this._clearGuideSpotlight();
    if (this._guideResizeHandler) {
      window.removeEventListener('resize', this._guideResizeHandler);
      window.removeEventListener('scroll', this._guideResizeHandler, true);
      this._guideResizeHandler = null;
    }
  }

  _clearGuideSpotlight() {
    document.querySelectorAll('.guide-spotlight').forEach(el => el.classList.remove('guide-spotlight'));
  }

  _renderGuide() {
    let el = document.getElementById('demo-guide');
    if (!el) {
      el = document.createElement('div');
      el.id = 'demo-guide';
      document.body.appendChild(el);
    }
    const steps = this._guideSteps();
    const total = steps.length;
    const idx = this._guideStep || 0;
    const step = steps[idx];
    const isLast = idx === total - 1;
    el.className = 'demo-guide';
    el.innerHTML = `
      <div class="demo-guide-inner">
        <div class="demo-guide-head">Как пользоваться — шаг ${idx + 1} из ${total}</div>
        <div class="demo-guide-text">${this.escapeHtml(step.text)}</div>
        <div class="demo-guide-buttons">
          <button class="demo-guide-next" onclick="app.nextGuideStep()">${isLast ? 'Понятно' : 'Дальше →'}</button>
          <button class="demo-guide-close" onclick="app.closeGuide()">Закрыть</button>
        </div>
      </div>
    `;
    this._clearGuideSpotlight();
    this._positionGuide(el, step.target);
    // При ресайзе/скролле — перепозиционируем облачко, чтобы не «убежало».
    if (!this._guideResizeHandler) {
      this._guideResizeHandler = () => {
        const steps2 = this._guideSteps();
        const s = steps2[this._guideStep || 0];
        const e = document.getElementById('demo-guide');
        if (e && s) this._positionGuide(e, s.target);
      };
      window.addEventListener('resize', this._guideResizeHandler);
      window.addEventListener('scroll', this._guideResizeHandler, true);
    }
  }

  _positionGuide(el, targetSelector) {
    const CLOUD_W = 380;
    const CLOUD_H_EST = 220; // примерная высота — реальная меряется после
    const GAP = 70;          // отступ от цели до облака (под длинный уголок-хвостик)
    const MARGIN = 12;       // от края экрана
    el.style.transform = '';
    // Если цели нет — центруем по экрану, без хвостика.
    if (!targetSelector) {
      el.classList.remove('tail-top', 'tail-bottom', 'tail-left', 'tail-right');
      el.style.left = '50%';
      el.style.top = '50%';
      el.style.transform = 'translate(-50%, -50%)';
      return;
    }
    const tgt = document.querySelector(targetSelector);
    if (!tgt) {
      // Цель не найдена в DOM — деградируем к центру.
      el.classList.remove('tail-top', 'tail-bottom', 'tail-left', 'tail-right');
      el.style.left = '50%';
      el.style.top = '50%';
      el.style.transform = 'translate(-50%, -50%)';
      return;
    }
    tgt.classList.add('guide-spotlight');
    const r = tgt.getBoundingClientRect();
    const realH = el.offsetHeight || CLOUD_H_EST;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // Решаем где разместить облачко: предпочитаем СНИЗУ цели (хвостик вверху).
    // Если снизу не помещается — пробуем сверху. Иначе — справа/слева.
    el.classList.remove('tail-top', 'tail-bottom', 'tail-left', 'tail-right');
    let top, left, tailKind;
    const fitsBelow = (r.bottom + GAP + realH + MARGIN) < vh;
    const fitsAbove = (r.top - GAP - realH - MARGIN) > 0;
    if (fitsBelow) {
      top = r.bottom + GAP;
      tailKind = 'tail-top';
    } else if (fitsAbove) {
      top = r.top - realH - GAP;
      tailKind = 'tail-bottom';
    } else {
      // Не помещается ни сверху, ни снизу — справа от цели.
      top = Math.max(MARGIN, Math.min(vh - realH - MARGIN, r.top));
      const fitsRight = (r.right + GAP + CLOUD_W + MARGIN) < vw;
      if (fitsRight) {
        left = r.right + GAP;
        tailKind = 'tail-left';
      } else {
        left = Math.max(MARGIN, r.left - CLOUD_W - GAP);
        tailKind = 'tail-right';
      }
      el.classList.add(tailKind);
      el.style.top = top + 'px';
      el.style.left = left + 'px';
      // Хвостик на уровне центра цели по вертикали.
      const tailY = (r.top + r.height / 2) - top;
      el.style.setProperty('--tail-y', tailY + 'px');
      return;
    }
    // Горизонтальная позиция: центруем по центру цели, не выходим за края.
    left = r.left + r.width / 2 - CLOUD_W / 2;
    left = Math.max(MARGIN, Math.min(vw - CLOUD_W - MARGIN, left));
    el.classList.add(tailKind);
    el.style.top = top + 'px';
    el.style.left = left + 'px';
    // Хвостик по горизонтали — указываем на центр цели.
    const tailX = (r.left + r.width / 2) - left;
    el.style.setProperty('--tail-x', tailX + 'px');
  }

  // Определяет kind ('manual'|'mechanized') по name из загруженного списка
  // видов работ. Если работа не нашлась (удалена) — считаем manual.
  kindOfWorkType(name) {
    if (!name) return 'manual';
    const wt = (this.workTypes || []).find(w => w.name === name);
    return wt && wt.kind === 'mechanized' ? 'mechanized' : 'manual';
  }

  // Возвращает эмодзи для значка культуры в пометках. По запросу Натали:
  // деревья (яблоня, груша, слива…) — 🌳, виноград — 🍇 (кисточка),
  // остальные кусты-ягоды (клубника, малина, смородина и пр.) — 🍓.
  cultureEmoji(name) {
    const lc = (name || '').toLowerCase().trim();
    if (!lc) return '🌳';
    if (lc.includes('виноград')) return '🍇';
    const TREES = ['яблон', 'груш', 'слив', 'персик', 'абрикос', 'вишн', 'черешн', 'алыч', 'орех'];
    if (TREES.some(t => lc.includes(t))) return '🌳';
    const BERRIES = ['малин', 'смородин', 'ежевик', 'крыжовник', 'клубник', 'голубик', 'жимолост'];
    if (BERRIES.some(b => lc.includes(b))) return '🍓';
    return '🌳';
  }

  // Группировка логов по работнику для Отчёта за период / Всего за день.
  // Возвращает Map: имя работника → массив активностей.
  // Активность = уникальная пара (культура, вид работ, квартал, клетка, режим)
  // с суммированными цифрами. Культуру (estate_id) включаем в ключ — кварталы
  // и клетки могут совпадать на разных культурах, без неё записи Иванова на
  // Кв.1 яблоня и Кв.1 виноград слиплись бы в одну строку.
  groupLogsByEmployee(logs) {
    const byEmp = new Map();
    if (!logs || logs.length === 0) return byEmp;
    for (const log of logs) {
      const emp = log.employee || '—';
      if (!byEmp.has(emp)) byEmp.set(emp, new Map());
      const acts = byEmp.get(emp);
      const key = [log.estate_id || '', log.work_type || '', log.quarter || '', log.cell || '', log.measure_mode || ''].join('||');
      if (!acts.has(key)) {
        acts.set(key, {
          estate_id: log.estate_id || '',
          work_type: log.work_type || '',
          quarter: log.quarter || '',
          cell: log.cell || '',
          measure_mode: log.measure_mode || '',
          rows: log.rows || '',
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
          ? `Кв.${this.escapeHtml(a.quarter)}${a.cell ? ', клет.' + this.escapeHtml(this.formatRange(a.cell)) : ''}`
          : '';
        let measure;
        if (a.measure_mode === 'hours') {
          measure = `${a.hours} часов`;
        } else if (a.measure_mode === 'hectares') {
          const rowsRange = a.rows ? `ряды ${this.escapeHtml(this.formatRange(a.rows))}, ` : '';
          measure = `${rowsRange}${a.hectares} гектаров`;
        } else if (a.measure_mode === 'kilometers') {
          measure = `${a.kilometers} км`;
        } else if (a.measure_mode === 'rows_bushes') {
          measure = `${a.rowCount} рядов, ${a.bushes} кустов`;
        } else {
          measure = `${a.rowCount} рядов`;
        }
        // В демо estate_id = название культуры. Показываем её в строке
        // чтобы различать Кв.1 яблоня и Кв.1 виноград (одинаковые номера —
        // разные культуры). Эмодзи зависит от названия — см. cultureEmoji.
        const culture = (this.config.demoMode && a.estate_id)
          ? `${this.cultureEmoji(a.estate_id)} ${this.escapeHtml(a.estate_id)}` : '';
        const parts = [this.escapeHtml(a.work_type || '—'), culture, place].filter(Boolean);
        const wtPlace = parts.join(' · ');
        return `<div class="report-emp-act">${wtPlace} — ${measure}</div>`;
      }).join('');
      blocks.push(`<div class="report-emp-block">${empHead}${lines}</div>`);
    }
    return blocks.join('');
  }

  // Демо Этап 6: Отчёт за период двумя блоками — 🛠 Ручные и 🚜 Мехраб.
  // Главная точка входа: getReport вызывает её при demoMode.
  renderTwoBlocksReportHtml(logs) {
    const manualLogs = (logs || []).filter(l => this.kindOfWorkType(l.work_type) !== 'mechanized');
    const mechLogs = (logs || []).filter(l => this.kindOfWorkType(l.work_type) === 'mechanized');
    const manualBlock = manualLogs.length > 0 ? this.renderManualBlockHtml(manualLogs) : '';
    const mechBlock = mechLogs.length > 0 ? this.renderMechBlockHtml(mechLogs) : '';
    if (!manualBlock && !mechBlock) {
      return '<p class="chips-empty">За этот период записей нет.</p>';
    }
    const grand = this.renderGrandTotalsHtml(manualLogs, mechLogs);
    return manualBlock + mechBlock + grand;
  }

  // Группировка для ручного блока: внешний ключ — вид работ + культура,
  // внутри — работники с агрегированными цифрами по (работник, кв, клет, режим).
  groupManualLogs(logs) {
    const groups = new Map();
    for (const log of logs) {
      const wt = log.work_type || '';
      const est = log.estate_id || '';
      const gKey = `${wt}||${est}`;
      if (!groups.has(gKey)) {
        groups.set(gKey, { work_type: wt, estate: est, rows: new Map() });
      }
      const innerMap = groups.get(gKey).rows;
      const inKey = [log.employee || '—', log.quarter || '', log.cell || '', log.measure_mode || ''].join('|');
      if (!innerMap.has(inKey)) {
        innerMap.set(inKey, {
          employee: log.employee || '—',
          quarter: log.quarter || '',
          cell: log.cell || '',
          measure_mode: log.measure_mode || '',
          rowCount: 0,
          bushes: 0,
          hours: 0,
        });
      }
      const it = innerMap.get(inKey);
      it.rowCount += String(log.rows || '').split(',').filter(x => x.trim()).length;
      it.bushes += Number(log.bushes) || 0;
      it.hours += Number(log.hours) || 0;
    }
    const arr = Array.from(groups.values()).map(g => ({
      work_type: g.work_type,
      estate: g.estate,
      rowsList: Array.from(g.rows.values()).sort((a, b) => {
        const byEmp = (a.employee || '').localeCompare(b.employee || '', 'ru');
        if (byEmp !== 0) return byEmp;
        const aq = Number(a.quarter) || 0;
        const bq = Number(b.quarter) || 0;
        if (aq !== bq) return aq - bq;
        const ac = Number(a.cell) || 0;
        const bc = Number(b.cell) || 0;
        return ac - bc;
      }),
    }));
    arr.sort((a, b) => {
      const byWt = (a.work_type || '').localeCompare(b.work_type || '', 'ru');
      if (byWt !== 0) return byWt;
      return (a.estate || '').localeCompare(b.estate || '', 'ru');
    });
    return arr;
  }

  renderManualBlockHtml(logs) {
    const groups = this.groupManualLogs(logs);
    const groupBlocks = groups.map(g => {
      const emoji = this.cultureEmoji(g.estate);
      const cultureLabel = this.config.demoMode && g.estate
        ? ` · ${emoji} ${this.escapeHtml(g.estate)}`
        : '';
      const head = `<div class="report-group-head">${this.escapeHtml(g.work_type || '—')}${cultureLabel}</div>`;
      const lines = g.rowsList.map(r => {
        const place = (r.quarter || r.cell)
          ? ` · Кв.${this.escapeHtml(r.quarter)}${r.cell ? ', клет.' + this.escapeHtml(this.formatRange(r.cell)) : ''}`
          : '';
        let measure;
        if (r.measure_mode === 'hours') {
          measure = `${r.hours} часов`;
        } else if (r.measure_mode === 'rows_bushes') {
          measure = `${r.rowCount} рядов, ${r.bushes} кустов`;
        } else {
          measure = `${r.rowCount} рядов`;
        }
        return `<div class="report-line">${this.escapeHtml(r.employee)} — ${measure}${place}</div>`;
      }).join('');
      return `<div class="report-group">${head}${lines}</div>`;
    }).join('');
    const totals = this._manualTotals(logs);
    const parts = [];
    if (totals.rowCount > 0) parts.push(`${totals.rowCount} рядов`);
    if (totals.bushes > 0) parts.push(`${totals.bushes} кустов`);
    if (totals.hours > 0) parts.push(`${totals.hours} часов`);
    const totalLine = parts.length > 0
      ? `<div class="report-block-totals">Итого руками: ${parts.join(', ')}</div>`
      : '';
    return `<div class="report-block">
      <div class="report-block-head">🛠 Ручные работы</div>
      ${groupBlocks}
      ${totalLine}
    </div>`;
  }

  renderMechBlockHtml(logs) {
    // Мехраб группируется по работнику — переиспользуем существующий рендер.
    const byEmp = this.groupLogsByEmployee(logs);
    const inner = this.renderEmployeeReportHtml(byEmp);
    const totals = this._mechTotals(logs);
    const parts = [];
    if (totals.hectares > 0) parts.push(`${totals.hectares} га`);
    if (totals.kilometers > 0) parts.push(`${totals.kilometers} км`);
    if (totals.hours > 0) parts.push(`${totals.hours} часов`);
    const totalLine = parts.length > 0
      ? `<div class="report-block-totals">Итого техникой: ${parts.join(', ')}</div>`
      : '';
    return `<div class="report-block">
      <div class="report-block-head">🚜 Механизированные работы</div>
      ${inner}
      ${totalLine}
    </div>`;
  }

  renderGrandTotalsHtml(manualLogs, mechLogs) {
    const m = this._manualTotals(manualLogs);
    const e = this._mechTotals(mechLogs);
    const manualParts = [];
    if (m.rowCount > 0) manualParts.push(`${m.rowCount} рядов`);
    if (m.bushes > 0) manualParts.push(`${m.bushes} кустов`);
    if (m.hours > 0) manualParts.push(`${m.hours} часов`);
    const mechParts = [];
    if (e.hectares > 0) mechParts.push(`${e.hectares} га`);
    if (e.kilometers > 0) mechParts.push(`${e.kilometers} км`);
    if (e.hours > 0) mechParts.push(`${e.hours} часов`);
    const bits = [];
    if (manualParts.length > 0) bits.push(`руками — ${manualParts.join(', ')}`);
    if (mechParts.length > 0) bits.push(`техникой — ${mechParts.join(', ')}`);
    if (bits.length === 0) return '';
    return `<div class="report-grand-totals">Всего за период: ${bits.join('; ')}.</div>`;
  }

  _manualTotals(logs) {
    const t = { rowCount: 0, bushes: 0, hours: 0 };
    for (const log of logs || []) {
      t.rowCount += String(log.rows || '').split(',').filter(x => x.trim()).length;
      t.bushes += Number(log.bushes) || 0;
      if (log.measure_mode === 'hours') t.hours += Number(log.hours) || 0;
    }
    return t;
  }

  _mechTotals(logs) {
    const t = { hectares: 0, kilometers: 0, hours: 0 };
    for (const log of logs || []) {
      if (log.measure_mode === 'hectares') t.hectares += Number(log.hectares) || 0;
      else if (log.measure_mode === 'kilometers') t.kilometers += Number(log.kilometers) || 0;
      else if (log.measure_mode === 'hours') t.hours += Number(log.hours) || 0;
    }
    t.hectares = Math.round(t.hectares * 100) / 100;
    t.kilometers = Math.round(t.kilometers * 100) / 100;
    return t;
  }

  // Плашка «Всего за день» на Вводе данных.
  // Группировка такая же как в Отчёте за период, только за один день — по запросу
  // Натали: «всё что бригадир ввёл во Вводе данных» с разрезом работник → вид работ.
  renderDailyTotalsHtml() {
    if (!this.entries || this.entries.length === 0) {
      return '<p class="chips-empty">Пока пусто.</p>';
    }
    const byEmp = this.groupLogsByEmployee(this.entries);
    return this.renderEmployeeReportHtml(byEmp);
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
      } else if (log.measure_mode === 'hectares') {
        const rowsRange = log.rows ? `ряды ${this.escapeHtml(this.formatRange(log.rows))}, ` : '';
        measure = `${rowsRange}${log.hectares != null ? log.hectares : 0} гектаров`;
      } else if (log.measure_mode === 'kilometers') {
        measure = `${log.kilometers != null ? log.kilometers : 0} км`;
      } else {
        const rowCount = String(log.rows || '').split(',').filter(x => x.trim()).length;
        measure = `${rowCount} рядов`;
        if (log.measure_mode === 'rows_bushes') measure += ` · ${log.bushes} кустов`;
      }
      const place = (!log.quarter)
        ? '' : ` · Кв.${this.escapeHtml(log.quarter)}${log.cell ? ' кл.' + this.escapeHtml(this.formatRange(log.cell)) : ''}`;
      // В демо estate_id = название культуры. Показываем в карточке записи,
      // чтобы было ясно к какой культуре относится Кв./клет. — номера могут
      // совпадать между культурами. Эмодзи по культуре — см. cultureEmoji.
      const culture = (this.config.demoMode && log.estate_id)
        ? ` · ${this.cultureEmoji(log.estate_id)} ${this.escapeHtml(log.estate_id)}` : '';
      return `
        <div class="entry-card">
          <div class="log-info">
            <div class="log-employee">${this.escapeHtml(log.employee)}</div>
            <div class="log-meta">${this.escapeHtml(log.work_type || '')}${culture}${place}</div>
            <div class="log-meta">${measure}</div>
          </div>
          <button class="delete-btn" onclick="app.deleteEntry(${log.id})">Удалить</button>
        </div>
      `;
    }).join('');
  }

  // Загружает клетки выбранного квартала. В режиме «Гектары» заполняет блок
  // чекбоксов (#i2-cells-multi) для мульти-выбора — трактор обрабатывает
  // несколько клеток сразу. В остальных режимах — обычный <select> #i2-cell.
  async refreshI2Cells() {
    const multi = document.getElementById('i2-cells-multi');
    if (multi) {
      if (!this.ctxQuarter) {
        multi.innerHTML = '<span class="chips-empty">Сначала выбери квартал.</span>';
        return;
      }
      const cells = await this.loadCells(this.ctxQuarter);
      if (cells.length === 0) {
        multi.innerHTML = '<span class="chips-empty">В этом квартале нет клеток.</span>';
        return;
      }
      multi.innerHTML = cells.map(c => `
        <label class="cell-check">
          <input type="checkbox" value="${c}" ${this.ctxCells.includes(String(c)) ? 'checked' : ''}
                 onchange="app.toggleCellCheckbox('${c}', this.checked)">
          <span>Клетка ${c}</span>
        </label>`).join('');
      return;
    }
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

  toggleCellCheckbox(cell, checked) {
    const key = String(cell);
    if (checked) {
      if (!this.ctxCells.includes(key)) this.ctxCells.push(key);
    } else {
      this.ctxCells = this.ctxCells.filter(x => x !== key);
    }
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
    this.ctxCells = [];
    await this.refreshI2Cells();
  }

  onI2CellChange() {
    this.ctxCell = document.getElementById('i2-cell').value;
  }

  onI2WorkTypeChange(kind) {
    // Две плашки: ручные (i2-worktype) и механизированные (i2-worktype-mech).
    // При выборе из одной — сбрасываем вторую, чтобы было однозначно один выбор.
    const selfId = kind === 'mechanized' ? 'i2-worktype-mech' : 'i2-worktype';
    const otherId = kind === 'mechanized' ? 'i2-worktype' : 'i2-worktype-mech';
    const selfEl = document.getElementById(selfId);
    const otherEl = document.getElementById(otherId);
    this.ctxWorkType = selfEl ? selfEl.value : '';
    if (this.ctxWorkType && otherEl) otherEl.value = '';
    // Автоподстановка дефолтного режима подсчёта, если он есть у выбранного вида работ
    // и присутствует в списке разрешённых режимов из конфига.
    const wt = this.workTypes.find(w => w.name === this.ctxWorkType);
    if (wt && wt.default_measure_mode && (this.config.measureModes || []).includes(wt.default_measure_mode)) {
      this.measureMode = wt.default_measure_mode;
      this.renderInput();
    }
  }

  setMeasureMode(mode) {
    // При смене режима сбрасываем «противоположный» выбор клеток, чтобы
    // не таскать невидимое состояние между режимами.
    if (mode === 'hectares') {
      this.ctxCell = '';
    } else {
      this.ctxCells = [];
    }
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
    const kindEl = document.getElementById('i2-new-worktype-kind');
    const kind = kindEl ? kindEl.value : 'manual';
    const default_measure_mode = kind === 'mechanized' ? 'hectares' : 'rows_bushes';
    const msg = document.getElementById('i2-msg');
    if (!name) { if (msg) msg.textContent = '❌ Впиши название вида работ'; return; }
    try {
      const r = await this.apiFetch('/api/work-types', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, kind, default_measure_mode }),
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
    } else if (this.measureMode === 'kilometers') {
      if (!this.ctxQuarter) { setMsg('❌ Выбери квартал'); return; }
      const kEl = document.getElementById('i2-kilometers');
      body.kilometers = kEl ? Number(kEl.value || 0) : 0;
    } else if (this.measureMode === 'hectares') {
      // Мульти-клетки: одна запись с cell = «1,2,3», сервер суммирует гектары.
      if (!this.ctxQuarter) { setMsg('❌ Выбери квартал'); return; }
      if (!this.ctxCells || this.ctxCells.length === 0) {
        setMsg('❌ Отметь хотя бы одну клетку, где работал трактор'); return;
      }
      const rowsEl = document.getElementById('i2-rows');
      body.rows = rowsEl ? rowsEl.value : '';
      body.cell = this.ctxCells.slice().sort((a, b) => Number(a) - Number(b)).join(',');
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

      const conflicts = data.conflicts || { sameDay: [], otherDay: [] };
      if (conflicts.sameDay.length || conflicts.otherDay.length) {
        await this.resolveRowConflicts(conflicts, employee, body);
      }

      await this.loadTodayEntries(this.inputDate);
      this.selectedEmployeeId = null;
      if (this.measureMode === 'hectares') this.ctxCells = [];
      this.renderInput();
    } catch (e) {
      setMsg('❌ ' + e.message);
    } finally {
      this.adding = false;
      const b = document.getElementById('i2-add-btn');
      if (b) { b.disabled = false; b.textContent = 'Добавить'; }
    }
  }

  // Последовательно проводит бригадира по конфликтным рядам.
  async resolveRowConflicts(conflicts, employee, body) {
    for (const c of conflicts.sameDay) {
      await this.resolveSameDay(c, employee, body);
    }
    for (const c of conflicts.otherDay) {
      await this.resolveOtherDay(c, employee, body);
    }
  }

  // Тот же день: показываем модалку «поделить?» с полем кустов (для rows_bushes).
  async resolveSameDay(c, employee, body) {
    const res = await this.showConflictModal({
      row: c.row,
      occupantName: c.occupant.employee,
      employee,
      askShare: body.measure_mode === 'rows_bushes',
    });
    if (!res) return;

    const r = await this.apiFetch('/api/logs/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'split',
        date: body.date, estate: body.estate, quarter: body.quarter, cell: body.cell,
        work_type: body.work_type, measure_mode: body.measure_mode,
        row: c.row, employee, firstLogId: c.occupant.logId, shareToSecond: res.shareToSecond,
      }),
    });
    if (!r.ok) {
      const data = await r.json().catch(() => ({}));
      await this.showInfoModal(`Ряд ${c.row}: ${data.error || 'не удалось разделить ряд'}`);
    }
  }

  // Другой день: модалка-предупреждение «уже делал такой-то, дата». Записать на текущего?
  // Другой день: широкое меню — отменить / отложить в спорные / переписать / поделить.
  async resolveOtherDay(c, employee, body) {
    const res = await this.showOtherDayMenu({
      row: c.row,
      occupantName: c.occupant.employee,
      occupantDate: c.occupant.date,
      employee,
      askShare: body.measure_mode === 'rows_bushes',
    });
    if (!res || res.action === 'cancel') return;

    const payload = {
      date: body.date, estate: body.estate, quarter: body.quarter, cell: body.cell,
      work_type: body.work_type, measure_mode: body.measure_mode,
      row: c.row, employee, firstLogId: c.occupant.logId,
    };
    if (res.action === 'split') payload.action = 'split';
    else if (res.action === 'reassign') payload.action = 'reassign';
    else if (res.action === 'postpone') payload.action = 'postpone';
    if (res.action === 'split') payload.shareToSecond = res.shareToSecond;

    const r = await this.apiFetch('/api/logs/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      const data = await r.json().catch(() => ({}));
      await this.showInfoModal(`Ряд ${c.row}: ${data.error || 'не удалось обработать ряд'}`);
    }
  }

  // Модалка «разные дни»: 4 действия. Возвращает Promise с одним из:
  // { action: 'cancel' } | { action: 'postpone' } | { action: 'reassign' } |
  // { action: 'split', shareToSecond } ; либо null при закрытии по фону.
  showOtherDayMenu({ row, occupantName, occupantDate, employee, askShare }) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      const box = document.createElement('div');
      box.className = 'modal-box';

      const title = document.createElement('div');
      title.className = 'modal-title';
      title.textContent = `Ряд ${row}`;
      box.appendChild(title);

      const text = document.createElement('div');
      text.className = 'modal-text';
      text.textContent = `Этот ряд уже отмечал ${occupantName} (${occupantDate}). Что делаем?`;
      box.appendChild(text);

      let shareInput = null;
      if (askShare) {
        shareInput = document.createElement('input');
        shareInput.className = 'modal-input';
        shareInput.inputMode = 'numeric';
        shareInput.placeholder = `Кусты для ${employee} при делении (пусто = поровну)`;
        box.appendChild(shareInput);
      }

      const actions = document.createElement('div');
      actions.className = 'modal-actions modal-actions-col';

      const mkBtn = (label, cls, onClick) => {
        const b = document.createElement('button');
        b.className = cls;
        b.textContent = label;
        b.addEventListener('click', onClick);
        actions.appendChild(b);
      };

      const close = (result) => { overlay.remove(); resolve(result); };

      mkBtn(`Переписать на ${employee}`, 'modal-primary', () => close({ action: 'reassign' }));
      mkBtn('Поделить кусты', 'modal-secondary', () => {
        let shareToSecond = null;
        if (shareInput && shareInput.value.trim() !== '') {
          const n = parseInt(shareInput.value, 10);
          if (Number.isInteger(n) && n >= 0) shareToSecond = n;
        }
        close({ action: 'split', shareToSecond });
      });
      mkBtn('Отложить в «Спорные»', 'modal-secondary', () => close({ action: 'postpone' }));
      mkBtn('Отменить запись', 'modal-cancel', () => close({ action: 'cancel' }));

      box.appendChild(actions);
      overlay.appendChild(box);
      document.body.appendChild(overlay);
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });
    });
  }

  // Внутристраничная модалка разрешения конфликта (работает в установленном PWA,
  // в отличие от confirm()/prompt(), которые в standalone Android не показываются).
  // Возвращает Promise: { action, shareToSecond } для подтверждения, либо null при отмене.
  // Имена подставляются через textContent — без innerHTML, чтобы имя не сломало разметку.
  showConflictModal({ row, occupantName, employee, askShare }) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      const box = document.createElement('div');
      box.className = 'modal-box';

      const title = document.createElement('div');
      title.className = 'modal-title';
      title.textContent = `Ряд ${row}`;
      box.appendChild(title);

      const text = document.createElement('div');
      text.className = 'modal-text';
      text.textContent = `Сегодня этот ряд уже записан на ${occupantName}. Поделить ряд между ними?`;
      box.appendChild(text);

      let shareInput = null;
      if (askShare) {
        shareInput = document.createElement('input');
        shareInput.className = 'modal-input';
        shareInput.inputMode = 'numeric';
        shareInput.placeholder = `Кусты для ${employee} (пусто = поровну)`;
        box.appendChild(shareInput);
      }

      const actions = document.createElement('div');
      actions.className = 'modal-actions';
      const primary = document.createElement('button');
      primary.className = 'modal-primary';
      primary.textContent = 'Поделить';
      const cancel = document.createElement('button');
      cancel.className = 'modal-cancel';
      cancel.textContent = 'Отмена';
      actions.appendChild(primary);
      actions.appendChild(cancel);
      box.appendChild(actions);

      overlay.appendChild(box);
      document.body.appendChild(overlay);

      const close = (result) => {
        overlay.remove();
        resolve(result);
      };

      primary.addEventListener('click', () => {
        let shareToSecond = null;
        if (shareInput && shareInput.value.trim() !== '') {
          const n = parseInt(shareInput.value, 10);
          if (Number.isInteger(n) && n >= 0) shareToSecond = n;
        }
        close({ action: 'split', shareToSecond });
      });
      cancel.addEventListener('click', () => close(null));
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });
    });
  }

  // Простое информационное окно (например, ошибка разрешения конфликта).
  // Тоже внутристраничное — чтобы работало в установленном PWA.
  showInfoModal(message) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      const box = document.createElement('div');
      box.className = 'modal-box';

      const text = document.createElement('div');
      text.className = 'modal-text';
      text.textContent = `❌ ${message}`;
      box.appendChild(text);

      const actions = document.createElement('div');
      actions.className = 'modal-actions';
      const ok = document.createElement('button');
      ok.className = 'modal-primary';
      ok.textContent = 'Понятно';
      actions.appendChild(ok);
      box.appendChild(actions);

      overlay.appendChild(box);
      document.body.appendChild(overlay);

      const close = () => { overlay.remove(); resolve(); };
      ok.addEventListener('click', close);
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    });
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
    // В демо журнал показывает ВСЕ записи бригадира за день по всем культурам.
    // В проде у бригадира одно хозяйство — фильтруем по estate как раньше.
    if (!this.config.demoMode && !this.estate) {
      list.innerHTML = '<p style="color:#888;padding:10px;">Сначала выбери хозяйство</p>';
      return;
    }
    if (!date) {
      list.innerHTML = '<p style="color:#888;padding:10px;">Выбери дату</p>';
      return;
    }
    list.innerHTML = '<p style="padding:10px;">⏳ Загрузка...</p>';
    try {
      let url = '/api/logs?date=' + encodeURIComponent(date);
      if (!this.config.demoMode && this.estate) {
        url += '&estate=' + encodeURIComponent(this.estate);
      }
      const r = await fetch(url);
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

  async loadDisputed() {
    const list = document.getElementById('disputed-list');
    if (!list) return;
    if (!this.estate) {
      list.innerHTML = '<p style="color:#888;padding:10px;">Сначала выбери хозяйство</p>';
      return;
    }
    try {
      const r = await this.apiFetch('/api/disputed?estate=' + encodeURIComponent(this.estate));
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        list.innerHTML = `<p style="color:#c00;padding:10px;">${this.escapeHtml(data.error || 'Ошибка')}</p>`;
        return;
      }
      this.disputed = data.disputed || [];
      this.renderDisputed();
    } catch (e) {
      list.innerHTML = `<p style="color:#c00;padding:10px;">${this.escapeHtml(e.message)}</p>`;
    }
  }

  renderDisputed() {
    const list = document.getElementById('disputed-list');
    if (!list) return;
    if (!this.disputed || this.disputed.length === 0) {
      list.innerHTML = '<p style="color:#888;padding:10px;">Спорных рядов нет</p>';
      return;
    }
    list.innerHTML = this.disputed.map((d) => `
      <div class="log-group">
        <div><b>Ряд ${d.row_num}</b> · Кв.${this.escapeHtml(String(d.quarter))} клетка ${this.escapeHtml(String(d.cell))} · ${this.escapeHtml(d.work_type)}</div>
        <div style="color:#888;font-size:13px;">Заявлял ${this.escapeHtml(d.claimed_by)} (${this.escapeHtml(d.claimed_date)})</div>
        <div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap;align-items:center;">
          <button onclick="app.openDisputedAssign(${d.id})">Записать делавшим</button>
          <button onclick="app.resolveDisputed(${d.id}, 'return-first')">Вернуть ${this.escapeHtml(d.claimed_by)}</button>
        </div>
      </div>
    `).join('');
  }

  // Открывает модалку выбора рабочих (одного или нескольких) с долями кустов,
  // затем отправляет разбор. Деление — выбор бригадира: отметил несколько → кусты
  // делятся (пустые доли = поровну, остаток первым).
  async openDisputedAssign(id) {
    const d = (this.disputed || []).find((x) => x.id === id);
    if (!d) return;
    const assignments = await this.showDisputedAssignModal(d);
    if (!assignments) return;
    await this.resolveDisputed(id, 'assign-actual', assignments);
  }

  // Возвращает Promise: массив [{employee, bushes|null}] (≥1) или null при отмене.
  showDisputedAssignModal(d) {
    return new Promise((resolve) => {
      const askShare = d.measure_mode === 'rows_bushes';
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      const box = document.createElement('div');
      box.className = 'modal-box';

      const title = document.createElement('div');
      title.className = 'modal-title';
      title.textContent = `Ряд ${d.row_num} — кто делал?`;
      box.appendChild(title);

      const hint = document.createElement('div');
      hint.className = 'modal-text';
      hint.textContent = askShare
        ? 'Отметь рабочих. Если несколько — кусты делятся поровну; можно задать долю вручную.'
        : 'Отметь рабочих, которые делали ряд.';
      box.appendChild(hint);

      const rows = [];
      (this.employees || []).forEach((e) => {
        const rowEl = document.createElement('label');
        rowEl.style.display = 'flex';
        rowEl.style.alignItems = 'center';
        rowEl.style.gap = '8px';
        rowEl.style.margin = '6px 0';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        const nameSpan = document.createElement('span');
        nameSpan.textContent = e.name;
        nameSpan.style.flex = '1';
        rowEl.appendChild(cb);
        rowEl.appendChild(nameSpan);
        let shareInput = null;
        if (askShare) {
          shareInput = document.createElement('input');
          shareInput.className = 'modal-input';
          shareInput.inputMode = 'numeric';
          shareInput.placeholder = 'кусты';
          shareInput.style.width = '90px';
          shareInput.style.margin = '0';
          rowEl.appendChild(shareInput);
        }
        box.appendChild(rowEl);
        rows.push({ name: e.name, cb, shareInput });
      });

      const actions = document.createElement('div');
      actions.className = 'modal-actions';
      const primary = document.createElement('button');
      primary.className = 'modal-primary';
      primary.textContent = 'Записать';
      const cancel = document.createElement('button');
      cancel.className = 'modal-cancel';
      cancel.textContent = 'Отмена';
      actions.appendChild(primary);
      actions.appendChild(cancel);
      box.appendChild(actions);

      overlay.appendChild(box);
      document.body.appendChild(overlay);

      const close = (result) => { overlay.remove(); resolve(result); };
      primary.addEventListener('click', () => {
        const chosen = rows.filter((r) => r.cb.checked).map((r) => {
          let bushes = null;
          if (r.shareInput && r.shareInput.value.trim() !== '') {
            const n = parseInt(r.shareInput.value, 10);
            if (Number.isInteger(n) && n >= 0) bushes = n;
          }
          return { employee: r.name, bushes };
        });
        if (chosen.length === 0) return; // нечего записывать — ждём выбора
        close(chosen);
      });
      cancel.addEventListener('click', () => close(null));
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });
    });
  }

  async resolveDisputed(id, action, assignments) {
    const body = { action };
    if (action === 'assign-actual') body.assignments = assignments || [];
    try {
      const r = await this.apiFetch('/api/disputed/' + id + '/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        await this.showInfoModal(data.error || 'Не удалось разобрать ряд');
        return;
      }
      await this.loadDisputed();
    } catch (e) {
      await this.showInfoModal(e.message);
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

    // В демо отчёт показывает все культуры сразу — рабочие работают на разных
    // культурах, и в отчёте должны быть все. В проде у бригадира одно
    // хозяйство, фильтруем по нему как раньше.
    if (!this.config.demoMode && !this.estate) {
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
      let url = `/api/logs?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
      if (!this.config.demoMode && this.estate) {
        url += `&estate=${encodeURIComponent(this.estate)}`;
      }
      const r = await fetch(url);
      const data = await r.json();
      if (!r.ok) {
        resultDiv.innerHTML = '<p style="color:#c0392b;padding:10px;">❌ ' + (data.error || 'Не удалось получить отчёт') + '</p>';
        return;
      }
      if (!data.logs || data.logs.length === 0) {
        resultDiv.innerHTML = '<p style="color:#888;padding:10px;">За этот период записей нет.</p>';
        return;
      }
      const header = `<div class="report-header">Отчёт с ${this.escapeHtml(from)} по ${this.escapeHtml(to)}</div>`;
      if (this.config.demoMode) {
        // Этап 6: два блока — 🛠 Ручные и 🚜 Механизированные.
        resultDiv.innerHTML = header + this.renderTwoBlocksReportHtml(data.logs);
      } else {
        // Прод: один блок «по работникам» как раньше.
        const byEmp = this.groupLogsByEmployee(data.logs);
        resultDiv.innerHTML = header + this.renderEmployeeReportHtml(byEmp);
      }
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
      // Сбрасываем флаг «гайд просмотрен» и текущий шаг — новая сессия = снова
      // показать подсказки клиенту с самого начала.
      try {
        localStorage.removeItem('demo_guide_done');
        localStorage.removeItem('demo_guide_step');
      } catch (e) {}
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
