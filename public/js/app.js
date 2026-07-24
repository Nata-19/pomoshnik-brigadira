class BrigadeAssistant {
  constructor() {
    this.me = null;
    this.estates = [];
    this.estate = localStorage.getItem('selectedEstate') || '';
    this.quarters = [];
    this.cellsByQuarter = {}; // кэш клеток по (estate|quarter)
    this.cellMaxRow = {};     // кэш: "estate|quarter|cell" → макс. ряд
    // Этап 2 — структурированный ввод
    this.employees = [];          // [{id, name}] — полный список бригады
    this.workTypes = [];          // [{id, name}] — общий список видов работ
    this.present = [];            // [{employee_id, name}] — отмеченные сегодня
    this.allocations = [];        // [{employee_id, work_type, quarter, people_count}] — куски разбивки за день
    this.entries = [];            // записи журнала за выбранную дату
    this.inputDate = this.getTodayDate();
    this.ctxQuarter = '';         // «держащийся» контекст
    this.ctxCell = '';
    this.ctxCellMaxRow = null;    // макс. ряд выбранной клетки (из инвентаря)
    this.ctxCells = [];           // мульти-выбор клеток для режима «Гектары»
    this.ctxWorkType = '';
    this.measureMode = 'rows_bushes';
    this.selectedEmployeeId = null;
    this.rosterOpen = false;
    this.adding = false;          // защита от двойного «Добавить»
    this.perfRows = [];
    this.perfQuarters = new Set();
    this.perfWorkTypes = new Set();
    this.perfDate = this.getTodayDate();
    this.perfFiltersOpen = false;
    this.init();
  }

  async init() {
    await this.loadConfig();
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/service-worker.js').catch(e => console.log('SW error:', e));
    }

    // Офлайн: реагируем на возврат сети и на изменения очереди.
    self.addEventListener('online', () => { this.syncNow(); });
    self.addEventListener('offline', () => { this.updateOfflineIndicator(); });
    self.addEventListener('offline-queue-changed', () => { this.updateOfflineIndicator(); });

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
        this.scheduleInitialSync();
        return;
      }
      this.estate = estates[0].id;
      this.estates = estates;
      await this.loadQuarters();
      await this.loadEmployees();
      await this.loadWorkTypes();
      await this.loadAttendance(this.inputDate);
      await this.loadAllocations(this.inputDate);
      await this.loadTodayEntries(this.inputDate);
      this.render();
      this._maybeAutoStartGuide();
      this.scheduleInitialSync();
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
    await this.loadAllocations(this.inputDate);
    await this.loadTodayEntries(this.inputDate);
    this.render();
    this.scheduleInitialSync();
  }

  // Досыл очереди — только после первого рендера (нужны куки сессии / готовый DOM).
  scheduleInitialSync() {
    this.updateOfflineIndicator();
    if (!navigator.onLine) return;
    queueMicrotask(() => { this.syncNow().catch(() => {}); });
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

  // Пишущий запрос: пробуем отправить; нет сети → кладём в очередь.
  // Возврат: { queued:true, client_uuid } | { queued:false, ok, status, data }.
  async sendOrQueue({ kind, method, url, body }) {
    const uuid = (self.crypto && crypto.randomUUID)
      ? crypto.randomUUID() : String(Date.now()) + '-' + Math.random();
    const sendBody = body ? { ...body } : null;
    if (kind === 'log' && sendBody) sendBody.client_uuid = uuid; // дедуп на сервере
    let outcome;
    try {
      const r = await fetch(url, {
        method,
        headers: sendBody ? { 'Content-Type': 'application/json' } : undefined,
        body: sendBody ? JSON.stringify(sendBody) : undefined,
        credentials: 'same-origin',
      });
      const data = await r.json().catch(() => ({}));
      outcome = { networkError: false, ok: r.ok, status: r.status, data };
    } catch (e) {
      outcome = { networkError: true };
    }
    if (OfflineQueueLogic.classifyWriteOutcome(outcome) === 'queue') {
      const item = OfflineQueueLogic.makeQueueItem({ kind, method, url, body: sendBody }, uuid, Date.now());
      await OfflineStore.enqueue(item);
      await this.updateOfflineIndicator();
      return { queued: true, client_uuid: uuid };
    }
    return { queued: false, ok: outcome.ok, status: outcome.status, data: outcome.data };
  }

  // Карточка записи из тела офлайн-очереди — бригадир видит сразу, что ввёл.
  logFromQueueBody(body, clientUuid) {
    return {
      id: 'pending:' + clientUuid,
      client_uuid: clientUuid,
      _pending: true,
      date: body.date,
      estate_id: body.estate || '',
      quarter: body.quarter != null ? String(body.quarter) : '',
      cell: body.cell != null ? String(body.cell) : '',
      employee: body.employee || '',
      work_type: body.work_type || '',
      measure_mode: body.measure_mode || '',
      rows: body.rows != null ? String(body.rows) : '',
      row_weights: null,
      bushes: null,
      hours: body.hours != null && body.hours !== '' ? Number(body.hours) : null,
      hectares: body.hectares != null ? Number(body.hectares) : null,
      kilometers: body.kilometers != null ? Number(body.kilometers) : null,
      created_at: new Date().toISOString(),
    };
  }

  // Добавляет к серверным записям те, что ещё ждут отправки в IndexedDB.
  async mergePendingLogs(serverLogs, date) {
    let pending = [];
    try {
      if (!self.OfflineStore) return serverLogs || [];
      const items = await OfflineStore.getAll();
      pending = items
        .filter(it => it.kind === 'log' && it.body && it.body.date === date)
        .map(it => this.logFromQueueBody(it.body, it.id));
    } catch (e) { /* IndexedDB недоступна */ }
    const demoMode = !!(this.config && this.config.demoMode);
    if (!demoMode && this.estate) {
      pending = pending.filter(p => p.estate_id === this.estate);
    }
    const pendingUuids = new Set(pending.map(p => p.client_uuid));
    const serverOnly = (serverLogs || []).filter(l => !l.client_uuid || !pendingUuids.has(l.client_uuid));
    return [...pending, ...serverOnly].sort((a, b) => {
      const ta = a.created_at ? new Date(a.created_at).getTime() : 0;
      const tb = b.created_at ? new Date(b.created_at).getTime() : 0;
      return tb - ta;
    });
  }

  // Обновляет бейдж «📤 N» и баннер «нет сети» в шапке.
  async updateOfflineIndicator() {
    let n = 0;
    try { n = await OfflineStore.count(); } catch (e) { n = 0; }
    const badge = document.getElementById('offline-badge');
    if (badge) {
      badge.textContent = n > 0 ? `📤 ${n}` : '';
      badge.style.display = n > 0 ? 'inline-block' : 'none';
    }
    const banner = document.getElementById('offline-banner');
    if (banner) banner.style.display = navigator.onLine ? 'none' : 'block';
  }

  // Досылает очередь и обновляет индикатор. Безопасно дёргать многократно.
  // Спорные ряды отложенного лога разрешаем теми же модалками, что и онлайн.
  async syncNow() {
    let result = null;
    try {
      if (self.OfflineSync) {
        result = await OfflineSync.syncQueue({
          onLogConflict: async (item, data) => {
            const body = item.body || {};
            const resolved = await this.resolveRowConflicts(
              data.conflicts || { sameDay: [], otherDay: [] }, body.employee, body
            );
            await this.loadTodayEntries(this.inputDate);
            return resolved; // false = отмена → элемент остаётся в очереди
          },
        });
      }
    } catch (e) { console.warn('[offline] sync skipped:', e); /* нет сети/занят/закрыл модалку — попробуем позже */ }
    await this.updateOfflineIndicator();
    // После досыла перечитываем день, чтобы доехавшие записи появились на
    // «Ввод данных» (список «ЗАПИСИ ЗА …» с рядами/кустами), а не только в «Журнале».
    if (result && result.sent > 0) {
      try {
        await this.loadAttendance(this.inputDate);
        await this.loadAllocations(this.inputDate);
        await this.loadTodayEntries(this.inputDate);
        this.renderInput();
      } catch (e) { console.warn('[offline] refresh after sync failed:', e); }
    }
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
      for (const [cell, cellData] of Object.entries(data.cells || {})) {
        const rows = Array.isArray(cellData) ? cellData : (cellData.rows || []);
        if (rows.length) {
          this.cellMaxRow[this.estate + '|' + quarterId + '|' + cell] =
            Math.max(...rows.map(r => typeof r === 'object' ? r.row : r));
        }
      }
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

  // Куски разбивки численности (вид работ + квартал) за день — грузим вместе с явкой.
  async loadAllocations(date) {
    try {
      const r = await this.apiFetch('/api/people-allocations?date=' + encodeURIComponent(date));
      const data = await r.json();
      this.allocations = data.allocations || [];
    } catch (e) {
      this.allocations = [];
    }
  }

  async loadTodayEntries(date) {
    // В демо: плашка «Всего за день» показывает ВСЁ за день по хозяйству,
    // по всем культурам сразу — один рабочий может работать утром на яблоне,
    // потом на винограде, обе записи должны быть видны. Поэтому здесь без
    // фильтра по estate. В проде у бригадира пока одно хозяйство — фильтруем
    // как раньше для совместимости.
    const demoMode = !!(this.config && this.config.demoMode);
    if (!demoMode && !this.estate) {
      this.entries = await this.mergePendingLogs([], date);
      return;
    }
    try {
      let url = '/api/logs?date=' + encodeURIComponent(date);
      if (!demoMode && this.estate) {
        url += '&estate=' + encodeURIComponent(this.estate);
      }
      const r = await this.apiFetch(url);
      const data = await r.json();
      const logs = (r.ok && data.logs) ? data.logs : [];
      this.entries = await this.mergePendingLogs(logs, date);
    } catch (e) {
      this.entries = await this.mergePendingLogs([], date);
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
    this.cellMaxRow = {};       // clear cache when estate changes
    await this.loadQuarters();
    // Сбрасываем контекст и записи журнала — они привязаны к хозяйству.
    this.ctxQuarter = '';
    this.ctxCell = '';
    this.ctxCellMaxRow = null;  // clear cache when estate changes
    this.selectedEmployeeId = null;
    await this.loadAllocations(this.inputDate);
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
            ${this.config.demoMode ? `<button id="help-guide-btn" class="mini-btn" onclick="app.startGuide()">❓ Как пользоваться</button>` : ''}
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
          <button id="tab-input" class="tab-button active" onclick="app.switchTab(event, 'input')">Ввод данных</button>
          <button id="tab-report" class="tab-button" onclick="app.switchTab(event, 'report')">Отчет за период</button>
          <button id="tab-logs" class="tab-button" onclick="app.switchTab(event, 'logs'); app.loadLogs()">Журнал</button>
          <button id="tab-disputed" class="tab-button" onclick="app.switchTab(event, 'disputed'); app.loadDisputed()">Спорные</button>
          <button id="tab-reconcile" class="tab-button" onclick="app.switchTab(event, 'reconcile'); app.onReconcileTabOpen()">Сверка</button>
          <button id="tab-perf" class="tab-button" onclick="app.switchTab(event, 'perf'); app.loadPerformance()">Выполнение</button>
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

        <div class="tab-content" id="reconcile-tab">
          <div class="ctx-block">
            <div class="block-label">Сверка</div>
            <div class="chips-row">
              <select id="rc-quarter" class="chip-select" onchange="app.onReconcileQuarterChange()">
                <option value="">Квартал...</option>
              </select>
              <select id="rc-cell" class="chip-select">
                <option value="">Все клетки...</option>
              </select>
              <select id="rc-worktype" class="chip-select">
                <option value="">Вид работ...</option>
              </select>
            </div>
            <button onclick="app.loadRowsStatus()">Показать</button>
          </div>
          <div id="reconcile-result" class="result" style="display:none;"></div>
        </div>

        <div class="tab-content" id="perf-tab">
          <div class="perf-toolbar">
            <label class="perf-date-label">Отчёт за
              <input type="date" id="perf-date" class="date-chip" value="${this.perfDate || this.inputDate}" onchange="app.onPerfDateChange()">
            </label>
            <button onclick="app.loadPerformance()">Обновить</button>
            <button id="perf-copy-all" class="mini-btn" onclick="app.copyAllPerfReports()" style="display:none;">Скопировать всё</button>
          </div>
          <div id="perf-filters"></div>
          <div id="perf-list" class="logs-list"></div>
          <div id="perf-copy-msg" class="auth-msg"></div>
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
            : this.present.map(p => {
                const on = p.employee_id === this.selectedEmployeeId ? 'on' : '';
                const val = (p.people_count != null && p.people_count !== '') ? String(p.people_count) : '';
                return `<span class="chip ${on}">
    <span class="chip-name" onclick="app.selectWorker(${p.employee_id})">${this.escapeHtml(p.name)}</span>
    <input class="chip-count" type="number" min="1" max="999" inputmode="numeric"
      placeholder="чел." title="К-во человек сегодня"
      value="${this.escapeHtml(val)}"
      onclick="event.stopPropagation()"
      onchange="app.savePeopleCount(${p.employee_id}, this.value)">
  </span>`;
              }).join('')}
        </div>
      </div>

      <div class="ctx-block">
        <div class="block-label">Добавить запись</div>
        <div class="sel-emp">Сотрудник: <b>${selName ? this.escapeHtml(selName) : '— выбери плашку выше'}</b></div>
        ${this.renderAllocationSection()}
        ${
          this.measureMode === 'hours'
            ? '<div class="form-group"><label>Часы:</label><input type="number" id="i2-hours" min="1" inputmode="numeric"></div>'
          : this.measureMode === 'kilometers'
            ? '<div class="form-group"><label>Километры:</label><input type="number" id="i2-kilometers" min="0.01" step="0.01" inputmode="decimal"></div>'
          : (this.measureMode === 'rows_bushes' || this.measureMode === 'rows_only' || this.measureMode === 'hectares')
            ? `<div class="form-group"><label>Ряды (например: 1-5, 9, 11 или 1-5.9.11):</label><input type="text" id="i2-rows" inputmode="numeric"${this.measureMode !== 'hectares' ? ' oninput="app.onRowsInput()"' : ''}>${this.measureMode === 'hectares' ? '<div class="measure-hint">Гектары посчитаются автоматически из выбранных рядов и площади клетки.</div>' : '<div id="i2-rows-warn" class="rows-warn"></div>'}</div>`
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

  peopleCountForName(name) {
    const p = (this.present || []).find(x => x.name === name);
    if (!p || p.people_count == null || p.people_count === '') return null;
    const n = Number(p.people_count);
    return Number.isInteger(n) && n >= 1 ? n : null;
  }

  formatEmployeeLabel(name) {
    const n = this.peopleCountForName(name);
    if (n != null) return `${name} ${n} чел.`;
    return name || '—';
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
      { target: null, text: 'Привет! Это демо «Помощник Бригадира». Покажу за пару минут, как пользоваться.' },
      { target: '#estate-sel', text: 'В шапке выбери культуру: у каждой свои кварталы, клетки и записи.' },
      { target: '.chips-row', text: 'Выбери квартал, клетку, вид работ.' },
      { target: '.mode-row', text: 'Выбери режим «Как считать»: ряды+кусты, ряды, часы, гектары или километры. Активный подсветится синим.' },
      { target: '.roster-toggle', text: 'Открой список бригады и отметь галочками кто сегодня на работе.' },
      { target: '.chips', text: 'Нажми на фамилию рабочего — она подсветится синим, значит выбран.' },
      { target: '#i2-rows', text: 'Введи ряды (например «1-5, 9»). Если ряд за пределами клетки — увидишь предупреждение «фантомный ряд».' },
      { target: '#i2-add-btn', text: 'Жми «Добавить» — запись попадёт в плашку «Всего за день» внизу.' },
      { target: '#tab-logs', text: 'Журнал: здесь видно номера рядов, которые делал каждый работник — на каком квартале, клетке и виде работ. Помогает найти, кто делал конкретный ряд.' },
      { target: '#tab-report', text: 'Отчёт за период: отчёт по диапазону дат — для бухгалтерии, итоги.' },
      { target: '#tab-reconcile', text: 'Сверка: клетка или весь квартал по виду работ. Закрыть — метка, что бригада здесь уже не работает.' },
      { target: '#tab-disputed', text: 'Спорные: если двое работали на одном ряду — конфликт попадает сюда. Можно поделить долю или вернуть ряд одному.' },
      { target: '#tab-perf', text: 'Выполнение: сколько гектаров сделано и осталось по культурам. Под кнопкой 🔍 Фильтры — выбор по видам работ и кварталам.' },
      { target: null, text: 'Если ввёл что-то по ошибке — открой запись в Журнале и нажми «Удалить» или «Спорный».' },
      { target: null, text: 'Деление куста: если двое работали на одном ряду — в окне деления указываешь кому сколько кустов.' },
      { target: '#help-guide-btn', text: 'Готово! Если что-то забудешь — жми «❓ Как пользоваться» в шапке, и гайд откроется снова.' },
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

  // Эмодзи культуры по названию (конкретные, не группами). Спека 2026-07-20.
  cultureEmoji(name) {
    const lc = (name || '').toLowerCase().trim();
    if (!lc) return '🌱';
    if (lc.includes('виноград')) return '🍇';
    if (lc.includes('яблон')) return '🍎';
    if (lc.includes('груш')) return '🍐';
    if (lc.includes('малин')) return '🫐';
    if (lc.includes('клубник')) return '🍓';
    if (lc.includes('черешн') || lc.includes('вишн')) return '🍒';
    if (lc.includes('персик') || lc.includes('абрикос')) return '🍑';
    if (lc.includes('слив') || lc.includes('алыч')) return '🟣';
    if (lc.includes('орех')) return '🥜';
    if (lc.includes('смородин') || lc.includes('ежевик') || lc.includes('голубик') || lc.includes('жимолост')) return '🫐';
    if (lc.includes('крыжовник')) return '🟢';
    return '🌱';
  }

  // Сумма «весов рядов» записи (дробный учёт): поделённый ряд = доля.
  // row_weights — JSON {ряд: вес}; ряд без веса (старые записи) = 1.
  rowWeightSum(log) {
    const nums = String(log.rows || '').split(',').map(s => s.trim()).filter(Boolean);
    let w = {};
    try {
      const o = JSON.parse(log.row_weights || '{}');
      if (o && typeof o === 'object' && !Array.isArray(o)) w = o;
    } catch {}
    let sum = 0;
    for (const n of nums) sum += (typeof w[n] === 'number' && isFinite(w[n])) ? w[n] : 1;
    return sum;
  }

  // Показ числа рядов: 2 знака, без лишних нулей (2 / 0.5 / 0.33).
  fmtRows(n) {
    return String(Math.round((Number(n) || 0) * 100) / 100);
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
      a.rowCount += this.rowWeightSum(log);
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
          measure = `${this.fmtRows(a.rowCount)} рядов, ${a.bushes} кустов`;
        } else {
          measure = `${this.fmtRows(a.rowCount)} рядов`;
        }
        // estate_id в демо = культура; в проде — хозяйство. Эмодзи — cultureEmoji.
        const culture = a.estate_id
          ? `${this.cultureEmoji(a.estate_id)} ${this.escapeHtml(a.estate_id)}` : '';
        const parts = [this.escapeHtml(a.work_type || '—'), culture, place].filter(Boolean);
        const wtPlace = parts.join(' · ');
        return `<div class="report-emp-act">${wtPlace} — ${measure}</div>`;
      }).join('');
      blocks.push(`<div class="report-emp-block">${empHead}${lines}</div>`);
    }
    return blocks.join('');
  }

  // Единые плашки 🛠/🚜 для «Всего за день» и «Отчёт за период» (спека 2026-07-20).
  renderPlatesReportHtml(logs, opts = {}) {
    const grandLabel = opts.grandLabel || 'Всего за период';
    const emptyText = opts.emptyText || 'За этот период записей нет.';
    const withPeopleCount = !!opts.withPeopleCount;
    const manualLogs = (logs || []).filter(l => this.kindOfWorkType(l.work_type) !== 'mechanized');
    const mechLogs = (logs || []).filter(l => this.kindOfWorkType(l.work_type) === 'mechanized');
    const manualBlock = manualLogs.length > 0 ? this.renderManualBlockHtml(manualLogs, { withPeopleCount }) : '';
    const mechBlock = mechLogs.length > 0 ? this.renderMechBlockHtml(mechLogs, { withPeopleCount }) : '';
    if (!manualBlock && !mechBlock) {
      return `<p class="chips-empty">${this.escapeHtml(emptyText)}</p>`;
    }
    const grand = this.renderGrandTotalsHtml(manualLogs, mechLogs, grandLabel);
    return manualBlock + mechBlock + grand;
  }

  // Алиас для старых вызовов.
  renderTwoBlocksReportHtml(logs) {
    return this.renderPlatesReportHtml(logs, { grandLabel: 'Всего за период' });
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
      it.rowCount += this.rowWeightSum(log);
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

  renderManualBlockHtml(logs, { withPeopleCount = false } = {}) {
    const groups = this.groupManualLogs(logs);
    const groupBlocks = groups.map(g => {
      const emoji = this.cultureEmoji(g.estate);
      const cultureLabel = g.estate
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
          measure = `${this.fmtRows(r.rowCount)} рядов, ${r.bushes} кустов`;
        } else {
          measure = `${this.fmtRows(r.rowCount)} рядов`;
        }
        const empLabel = withPeopleCount
          ? this.formatEmployeeLabel(r.employee)
          : (r.employee || '—');
        return `<div class="report-line">${this.escapeHtml(empLabel)} — ${measure}${place}</div>`;
      }).join('');
      // Итого только внутри пары «вид работ + культура» — культуры не смешиваем.
      const gTot = g.rowsList.reduce((t, r) => {
        t.rowCount += Number(r.rowCount) || 0;
        t.bushes += Number(r.bushes) || 0;
        if (r.measure_mode === 'hours') t.hours += Number(r.hours) || 0;
        return t;
      }, { rowCount: 0, bushes: 0, hours: 0 });
      const gParts = [];
      if (gTot.rowCount > 0) gParts.push(`${this.fmtRows(gTot.rowCount)} рядов`);
      if (gTot.bushes > 0) gParts.push(`${gTot.bushes} кустов`);
      if (gTot.hours > 0) gParts.push(`${gTot.hours} часов`);
      const gTotal = gParts.length
        ? `<div class="report-group-totals">Итого: ${gParts.join(', ')}</div>`
        : '';
      return `<div class="report-group">${head}${lines}${gTotal}</div>`;
    }).join('');
    return `<div class="report-block">
      <div class="report-block-head">🛠 Ручные работы</div>
      ${groupBlocks}
    </div>`;
  }

  // Мехраб: та же ось, что у ручных — внешний ключ вид работ + культура,
  // внутри трактористы. Культуры не складываем вместе.
  groupMechLogs(logs) {
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
          hectares: 0,
          kilometers: 0,
          hours: 0,
          rows: log.rows || '',
        });
      }
      const it = innerMap.get(inKey);
      it.hectares += Number(log.hectares) || 0;
      it.kilometers += Number(log.kilometers) || 0;
      if (log.measure_mode === 'hours') it.hours += Number(log.hours) || 0;
    }
    const arr = Array.from(groups.values()).map(g => ({
      work_type: g.work_type,
      estate: g.estate,
      rowsList: Array.from(g.rows.values()).map(r => ({
        ...r,
        hectares: Math.round(r.hectares * 100) / 100,
        kilometers: Math.round(r.kilometers * 100) / 100,
      })).sort((a, b) => {
        const byEmp = (a.employee || '').localeCompare(b.employee || '', 'ru');
        if (byEmp !== 0) return byEmp;
        const aq = Number(a.quarter) || 0;
        const bq = Number(b.quarter) || 0;
        if (aq !== bq) return aq - bq;
        return (Number(a.cell) || 0) - (Number(b.cell) || 0);
      }),
    }));
    arr.sort((a, b) => {
      const byWt = (a.work_type || '').localeCompare(b.work_type || '', 'ru');
      if (byWt !== 0) return byWt;
      return (a.estate || '').localeCompare(b.estate || '', 'ru');
    });
    return arr;
  }

  renderMechBlockHtml(logs, { withPeopleCount = false } = {}) {
    const groups = this.groupMechLogs(logs);
    const groupBlocks = groups.map(g => {
      const emoji = this.cultureEmoji(g.estate);
      const cultureLabel = g.estate
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
        } else if (r.measure_mode === 'kilometers') {
          measure = `${r.kilometers} км`;
        } else {
          const rowsRange = r.rows ? `ряды ${this.escapeHtml(this.formatRange(r.rows))}, ` : '';
          measure = `${rowsRange}${r.hectares} га`;
        }
        const empLabel = withPeopleCount
          ? this.formatEmployeeLabel(r.employee)
          : (r.employee || '—');
        return `<div class="report-line">${this.escapeHtml(empLabel)} — ${measure}${place}</div>`;
      }).join('');
      const gTot = g.rowsList.reduce((t, r) => {
        t.hectares += Number(r.hectares) || 0;
        t.kilometers += Number(r.kilometers) || 0;
        t.hours += Number(r.hours) || 0;
        return t;
      }, { hectares: 0, kilometers: 0, hours: 0 });
      gTot.hectares = Math.round(gTot.hectares * 100) / 100;
      gTot.kilometers = Math.round(gTot.kilometers * 100) / 100;
      const gParts = [];
      if (gTot.hectares > 0) gParts.push(`${gTot.hectares} га`);
      if (gTot.kilometers > 0) gParts.push(`${gTot.kilometers} км`);
      if (gTot.hours > 0) gParts.push(`${gTot.hours} часов`);
      const gTotal = gParts.length
        ? `<div class="report-group-totals">Итого: ${gParts.join(', ')}</div>`
        : '';
      return `<div class="report-group">${head}${lines}${gTotal}</div>`;
    }).join('');
    return `<div class="report-block">
      <div class="report-block-head">🚜 Механизированные работы</div>
      ${groupBlocks}
    </div>`;
  }

  // Итог внизу — отдельная строка на каждую пару «вид работ + культура», без схлопывания культур.
  renderGrandTotalsHtml(manualLogs, mechLogs, grandLabel = 'Всего за период') {
    const lines = [];
    for (const g of this.groupManualLogs(manualLogs)) {
      const t = g.rowsList.reduce((acc, r) => {
        acc.rowCount += Number(r.rowCount) || 0;
        acc.bushes += Number(r.bushes) || 0;
        if (r.measure_mode === 'hours') acc.hours += Number(r.hours) || 0;
        return acc;
      }, { rowCount: 0, bushes: 0, hours: 0 });
      const parts = [];
      if (t.rowCount > 0) parts.push(`${this.fmtRows(t.rowCount)} рядов`);
      if (t.bushes > 0) parts.push(`${t.bushes} кустов`);
      if (t.hours > 0) parts.push(`${t.hours} часов`);
      if (parts.length === 0) continue;
      const emoji = this.cultureEmoji(g.estate);
      const culture = g.estate ? ` · ${emoji} ${this.escapeHtml(g.estate)}` : '';
      lines.push(`🛠 ${this.escapeHtml(g.work_type || '—')}${culture} — ${parts.join(', ')}`);
    }
    for (const g of this.groupMechLogs(mechLogs)) {
      const t = g.rowsList.reduce((acc, r) => {
        acc.hectares += Number(r.hectares) || 0;
        acc.kilometers += Number(r.kilometers) || 0;
        acc.hours += Number(r.hours) || 0;
        return acc;
      }, { hectares: 0, kilometers: 0, hours: 0 });
      t.hectares = Math.round(t.hectares * 100) / 100;
      t.kilometers = Math.round(t.kilometers * 100) / 100;
      const parts = [];
      if (t.hectares > 0) parts.push(`${t.hectares} га`);
      if (t.kilometers > 0) parts.push(`${t.kilometers} км`);
      if (t.hours > 0) parts.push(`${t.hours} часов`);
      if (parts.length === 0) continue;
      const emoji = this.cultureEmoji(g.estate);
      const culture = g.estate ? ` · ${emoji} ${this.escapeHtml(g.estate)}` : '';
      lines.push(`🚜 ${this.escapeHtml(g.work_type || '—')}${culture} — ${parts.join(', ')}`);
    }
    if (lines.length === 0) return '';
    return `<div class="report-grand-totals"><div class="report-grand-label">${this.escapeHtml(grandLabel)}</div>${
      lines.map(l => `<div class="report-grand-line">${l}</div>`).join('')
    }</div>`;
  }

  _manualTotals(logs) {
    const t = { rowCount: 0, bushes: 0, hours: 0 };
    for (const log of logs || []) {
      t.rowCount += this.rowWeightSum(log);
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

  // Плашка «Всего за день» — те же плашки 🛠/🚜, что и в отчёте за период.
  renderDailyTotalsHtml() {
    return this.renderPlatesReportHtml(this.entries, {
      grandLabel: 'Всего за день',
      emptyText: 'Пока пусто.',
      withPeopleCount: true,
    });
  }

  // HTML карточек записей за выбранную дату.
  renderEntriesHtml() {
    if (!this.entries || this.entries.length === 0) {
      return '<p class="chips-empty">Записей пока нет.</p>';
    }
    return this.entries.map(log => {
      let measure;
      if (log.measure_mode === 'hours') {
        measure = `${log.hours != null ? log.hours : 0} часов`;
      } else if (log.measure_mode === 'hectares') {
        const rowsRange = log.rows ? `ряды ${this.escapeHtml(this.formatRange(log.rows))}, ` : '';
        const ha = log.hectares != null ? log.hectares : (log._pending ? '—' : 0);
        measure = `${rowsRange}${ha} гектаров`;
      } else if (log.measure_mode === 'kilometers') {
        measure = `${log.kilometers != null ? log.kilometers : 0} км`;
      } else {
        const rowCount = this.rowWeightSum(log);
        measure = `${this.fmtRows(rowCount)} рядов`;
        if (log.measure_mode === 'rows_bushes' && log.bushes != null) measure += ` · ${log.bushes} кустов`;
      }
      const place = (!log.quarter)
        ? '' : ` · Кв.${this.escapeHtml(log.quarter)}${log.cell ? ' кл.' + this.escapeHtml(this.formatRange(log.cell)) : ''}`;
      // В демо estate_id = название культуры. Показываем в карточке записи,
      // чтобы было ясно к какой культуре относится Кв./клет. — номера могут
      // совпадать между культурами. Эмодзи по культуре — см. cultureEmoji.
      const culture = (this.config.demoMode && log.estate_id)
        ? ` · ${this.cultureEmoji(log.estate_id)} ${this.escapeHtml(log.estate_id)}` : '';
      const pendingBadge = log._pending
        ? '<span class="entry-pending-badge">📤 не отправлено</span> ' : '';
      const cardClass = log._pending ? 'entry-card entry-pending' : 'entry-card';
      const deleteBtn = log._pending
        ? `<button class="delete-btn" onclick="app.cancelPendingEntry('${log.client_uuid}')">Убрать</button>`
        : `<button class="delete-btn" onclick="app.deleteEntry(${log.id})">Удалить</button>`;
      return `
        <div class="${cardClass}">
          <div class="log-info">
            <div class="log-employee">${pendingBadge}${this.escapeHtml(log.employee)}</div>
            <div class="log-meta">${this.escapeHtml(log.work_type || '')}${culture}${place}</div>
            <div class="log-meta">${measure}</div>
          </div>
          ${deleteBtn}
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
    await this.loadAllocations(this.inputDate);
    await this.loadTodayEntries(this.inputDate);
    this.renderInput();
  }

  async onI2QuarterChange() {
    this.ctxQuarter = document.getElementById('i2-quarter').value;
    this.ctxCell = '';
    this.ctxCellMaxRow = null;
    this.ctxCells = [];
    await this.refreshI2Cells();
  }

  onI2CellChange() {
    this.ctxCell = document.getElementById('i2-cell').value;
    this.ctxCellMaxRow = this.cellMaxRow[this.estate + '|' + this.ctxQuarter + '|' + this.ctxCell] ?? null;
  }

  onRowsInput() {
    const warn = document.getElementById('i2-rows-warn');
    if (!warn) return;
    const maxRow = this.ctxCellMaxRow;
    if (!maxRow) { warn.textContent = ''; return; }

    const val = (document.getElementById('i2-rows')?.value || '').trim();
    if (!val) { warn.textContent = ''; return; }

    const nums = [];
    for (const part of val.split(/[,.;\s]+/).filter(Boolean)) {
      const range = part.match(/^(\d+)-(\d+)$/);
      if (range) {
        const [lo, hi] = [+range[1], +range[2]];
        if (lo <= hi) for (let i = lo; i <= hi; i++) nums.push(i);
      } else if (/^\d+$/.test(part)) {
        nums.push(+part);
      }
    }

    const phantoms = [...new Set(nums.filter(n => n > maxRow))].sort((a, b) => a - b);
    if (phantoms.length) {
      warn.textContent = `⚠️ Ряды ${phantoms.join(', ')} — нет в инвентаре клетки (всего ${maxRow}). Возможно, опечатка?`;
    } else {
      warn.textContent = '';
    }
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
      this.ctxCellMaxRow = null;
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
      await this.loadAllocations(this.inputDate);
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
      await this.loadAllocations(this.inputDate); // снятие с явки каскадно удаляет куски разбивки
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

  async savePeopleCount(employeeId, rawValue) {
    let people_count;
    const trimmed = String(rawValue == null ? '' : rawValue).trim();
    if (trimmed === '') {
      people_count = null;
    } else {
      const n = Number(trimmed);
      if (!Number.isInteger(n) || n < 1 || n > 999) {
        alert('К-во чел.: целое от 1 до 999 или пусто');
        await this.loadAttendance(this.inputDate);
        this.renderInput();
        return;
      }
      people_count = n;
    }
    try {
      const r = await this.apiFetch('/api/attendance', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date: this.inputDate,
          employee_id: employeeId,
          people_count,
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || 'Не удалось сохранить к-во чел.');
      const row = this.present.find(p => p.employee_id === employeeId);
      if (row) row.people_count = people_count;
      // Новое N могло сделать сумму кусков разбивки другой относительно потолка —
      // перечитываем куски (сервер мог их каскадно почистить при сбросе N) и
      // обновляем предупреждение «Разбивка X из N».
      await this.loadAllocations(this.inputDate);
      this.renderInput();
    } catch (e) {
      alert('Ошибка: ' + e.message);
      await this.loadAttendance(this.inputDate);
      await this.loadAllocations(this.inputDate);
      this.renderInput();
    }
  }

  // «Разбивка X из N» — предупреждение, пока сумма кусков меньше общего N.
  // Клиентская копия formatAllocationProgress из server/peopleAllocations.js.
  allocationProgress(sum, cap) {
    if (!cap || sum === 0 || sum === cap) return null;
    return `Разбивка ${sum} из ${cap}`;
  }

  // Блок «Чел. на этот вид / квартал» + список кусков выбранного сотрудника.
  // Виден только когда есть выбранный (тапнутый) сотрудник из явки.
  renderAllocationSection() {
    if (this.selectedEmployeeId == null) return '';
    const p = this.present.find(x => x.employee_id === this.selectedEmployeeId);
    if (!p) return '';
    const hasCtx = !!(this.ctxWorkType && this.ctxQuarter);
    const N = (p.people_count != null && p.people_count !== '') ? Number(p.people_count) : null;
    const rows = this.allocations.filter(a => a.employee_id === this.selectedEmployeeId);
    const currentAlloc = hasCtx
      ? rows.find(a => a.work_type === this.ctxWorkType && a.quarter === this.ctxQuarter)
      : null;

    let fieldHtml;
    if (!hasCtx) {
      fieldHtml = '<div class="rows-warn">Сначала вид работ и квартал</div>';
    } else if (!N) {
      fieldHtml = '<div class="rows-warn">Сначала общее к-во чел. на плашке</div>';
    } else {
      const currentVal = currentAlloc ? String(currentAlloc.people_count) : '';
      fieldHtml = `
        <div class="add-inline">
          <input type="number" id="i2-alloc-count" min="1" max="999" inputmode="numeric" value="${this.escapeHtml(currentVal)}">
          <button type="button" class="mini-btn" onclick="app.saveAllocation()">Сохранить чел.</button>
          <button type="button" class="mini-btn" onclick="app.clearAllocation()" ${currentAlloc ? '' : 'disabled'}>✕</button>
        </div>`;
    }

    const listHtml = rows.map(a => `
        <div class="roster-row">
          <span class="roster-name" style="cursor:default">${this.escapeHtml(a.work_type)} · ${this.escapeHtml(a.quarter)} — ${a.people_count}</span>
          <span class="roster-del" onclick="app.deleteAllocationRow(${a.employee_id}, '${this.escapeAttr(a.work_type)}', '${this.escapeAttr(a.quarter)}')">✕</span>
        </div>`).join('');

    const sum = rows.reduce((s, a) => s + (Number(a.people_count) || 0), 0);
    const warnMsg = N ? this.allocationProgress(sum, N) : null;

    return `
      <div class="form-group alloc-row">
        <label>Чел. на этот вид / квартал:</label>
        ${fieldHtml}
      </div>
      ${listHtml}
      ${warnMsg ? `<div class="alloc-warn">⚠️ ${this.escapeHtml(warnMsg)}</div>` : ''}
    `;
  }

  async saveAllocation() {
    const msg = document.getElementById('i2-msg');
    const setMsg = (t) => { if (msg) { msg.className = 'auth-msg'; msg.textContent = t; } };
    if (this.selectedEmployeeId == null) { setMsg('❌ Выбери сотрудника (плашку выше)'); return; }
    if (!this.ctxWorkType) { setMsg('❌ Выбери вид работ'); return; }
    if (!this.ctxQuarter) { setMsg('❌ Выбери квартал'); return; }
    const input = document.getElementById('i2-alloc-count');
    const raw = input ? input.value : '';
    try {
      const r = await this.apiFetch('/api/people-allocations', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date: this.inputDate,
          employee_id: this.selectedEmployeeId,
          work_type: this.ctxWorkType,
          quarter: this.ctxQuarter,
          people_count: raw,
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) { setMsg('❌ ' + (data.error || 'Ошибка')); return; }
      setMsg('');
      await this.loadAllocations(this.inputDate);
      this.renderInput();
    } catch (e) {
      setMsg('❌ ' + e.message);
    }
  }

  // Удаляет кусок разбивки для текущего контекста (вид+квартал выбранного сотрудника).
  async clearAllocation() {
    if (this.selectedEmployeeId == null || !this.ctxWorkType || !this.ctxQuarter) return;
    await this.deleteAllocationRow(this.selectedEmployeeId, this.ctxWorkType, this.ctxQuarter);
  }

  // Удаляет конкретный кусок разбивки (используется и списком, и clearAllocation).
  async deleteAllocationRow(employeeId, workType, quarter) {
    const msg = document.getElementById('i2-msg');
    const setMsg = (t) => { if (msg) { msg.className = 'auth-msg'; msg.textContent = t; } };
    try {
      const r = await this.apiFetch('/api/people-allocations', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: this.inputDate, employee_id: employeeId, work_type: workType, quarter: quarter }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) { setMsg('❌ ' + (data.error || 'Ошибка')); return; }
      await this.loadAllocations(this.inputDate);
      this.renderInput();
    } catch (e) {
      setMsg('❌ ' + e.message);
    }
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
      const res = await this.sendOrQueue({ kind: 'log', method: 'POST', url: '/api/logs', body });
      if (res.queued) {
        const pending = this.logFromQueueBody(body, res.client_uuid);
        this.entries = [pending, ...this.entries.filter(e => e.client_uuid !== res.client_uuid)];
        setMsg('📤 Записано офлайн — отправлю, когда будет сеть');
        this.selectedEmployeeId = null;
        if (this.measureMode === 'hectares') this.ctxCells = [];
        this.renderInput();
        return;
      }
      const data = res.data || {};
      if (!res.ok) { setMsg('❌ ' + (data.error || 'Ошибка')); return; }

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
    // Тот же день: делим ряд между рабочими (предотмечены занявший и текущий).
    const assignments = await this.showDivideModal({
      row: c.row,
      askShare: body.measure_mode === 'rows_bushes',
      preselect: [c.occupant.employee, employee],
      rowBushes: c.rowBushes || 0,
    });
    if (!assignments) return;

    const r = await this.apiFetch('/api/logs/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'divide',
        date: body.date, estate: body.estate, quarter: body.quarter, cell: body.cell,
        work_type: body.work_type, measure_mode: body.measure_mode,
        row: c.row, employee, firstLogId: c.occupant.logId, assignments,
      }),
    });
    if (!r.ok) {
      const data = await r.json().catch(() => ({}));
      await this.showInfoModal(`Ряд ${c.row}: ${data.error || 'не удалось разделить ряд'}`);
    }
  }

  // Другой день: широкое меню — переписать / поделить / отложить в спорные / отменить.
  async resolveOtherDay(c, employee, body) {
    const res = await this.showOtherDayMenu({
      row: c.row,
      occupantName: c.occupant.employee,
      occupantDate: c.occupant.date,
      employee,
    });
    if (!res || res.action === 'cancel') return;

    const payload = {
      date: body.date, estate: body.estate, quarter: body.quarter, cell: body.cell,
      work_type: body.work_type, measure_mode: body.measure_mode,
      row: c.row, employee, firstLogId: c.occupant.logId,
    };
    if (res.action === 'divide') {
      // Открываем окно деления: кто делал ряд + доли (предотмечены занявший и текущий).
      const assignments = await this.showDivideModal({
        row: c.row,
        askShare: body.measure_mode === 'rows_bushes',
        preselect: [c.occupant.employee, employee],
        rowBushes: c.rowBushes || 0,
      });
      if (!assignments) return;
      payload.action = 'divide';
      payload.assignments = assignments;
    } else if (res.action === 'reassign') {
      payload.action = 'reassign';
    } else if (res.action === 'postpone') {
      payload.action = 'postpone';
    }

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
  // { action: 'cancel' | 'postpone' | 'reassign' | 'divide' }; либо null при закрытии по фону.
  showOtherDayMenu({ row, occupantName, occupantDate, employee }) {
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
      mkBtn('Поделить кусты', 'modal-secondary', () => close({ action: 'divide' }));
      mkBtn('Отложить в «Спорные»', 'modal-secondary', () => close({ action: 'postpone' }));
      mkBtn('Отменить запись', 'modal-cancel', () => close({ action: 'cancel' }));

      box.appendChild(actions);
      overlay.appendChild(box);
      document.body.appendChild(overlay);
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

  async cancelPendingEntry(clientUuid) {
    if (!confirm('Убрать запись из очереди? Она ещё не отправлена на сервер.')) return;
    try {
      await OfflineStore.remove(clientUuid);
      await this.loadTodayEntries(this.inputDate);
      await this.updateOfflineIndicator();
      this.renderInput();
    } catch (e) {
      alert('Ошибка: ' + e.message);
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
        <div><b>Ряд ${Number(d.row_num)}</b> · Кв.${this.escapeHtml(String(d.quarter))} клетка ${this.escapeHtml(String(d.cell))} · ${this.escapeHtml(d.work_type)}</div>
        <div style="color:#888;font-size:13px;">Заявлял ${this.escapeHtml(d.claimed_by)} (${this.escapeHtml(d.claimed_date)})</div>
        <div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap;align-items:center;">
          <button onclick="app.openDisputedAssign(${Number(d.id)})">Записать делавшим</button>
          <button onclick="app.resolveDisputed(${Number(d.id)}, 'return-first')">Вернуть ${this.escapeHtml(d.claimed_by)}</button>
        </div>
      </div>
    `).join('');
  }

  // Вкладка «Сверка» открыта: (пере)заполнить селекторы актуальными кварталами и
  // видами работ. Делаем при каждом открытии, т.к. контейнер вкладок строится один
  // раз, а хозяйство могло смениться. Сохранённое значение восстанавливаем, если ещё валидно.
  onReconcileTabOpen() {
    const qSel = document.getElementById('rc-quarter');
    const wSel = document.getElementById('rc-worktype');
    const res = document.getElementById('reconcile-result');
    if (qSel) {
      const prev = qSel.value;
      qSel.innerHTML = '<option value="">Квартал...</option>' +
        this.quarters.map(q => `<option value="${q.id}">${this.escapeHtml(q.name)}</option>`).join('');
      if (prev && this.quarters.some(q => String(q.id) === prev)) qSel.value = prev;
    }
    if (wSel) {
      const prev = wSel.value;
      wSel.innerHTML = '<option value="">Вид работ...</option>' +
        this.workTypes.map(w => `<option value="${this.escapeHtml(w.name)}">${this.escapeHtml(w.name)}</option>`).join('');
      if (prev && this.workTypes.some(w => w.name === prev)) wSel.value = prev;
    }
    // Клетки зависят от квартала: сбрасываем и, если квартал сохранён, перезагружаем.
    const cSel = document.getElementById('rc-cell');
    if (cSel) cSel.innerHTML = '<option value="">Все клетки...</option>';
    if (qSel && qSel.value) this.onReconcileQuarterChange();
    if (res && !this.estate) {
      res.style.display = 'block';
      res.innerHTML = '<p style="color:#888;padding:10px;">Сначала выбери хозяйство</p>';
    }
  }

  // Смена квартала — подгрузить клетки.
  async onReconcileQuarterChange() {
    const qSel = document.getElementById('rc-quarter');
    const cSel = document.getElementById('rc-cell');
    if (!qSel || !cSel) return;
    cSel.innerHTML = '<option value="">Все клетки...</option>';
    if (!qSel.value) return;
    const cells = await this.loadCells(qSel.value);
    cSel.innerHTML = '<option value="">Все клетки...</option>' +
      cells.map(c => `<option value="${this.escapeHtml(c)}">${this.escapeHtml(c)}</option>`).join('');
  }

  // Запросить сверку: одна клетка или весь квартал (клетка пустая).
  async loadRowsStatus() {
    const res = document.getElementById('reconcile-result');
    if (!res) return;
    res.style.display = 'block';
    if (!this.estate) {
      res.innerHTML = '<p style="color:#888;padding:10px;">Сначала выбери хозяйство</p>';
      return;
    }
    const quarter = (document.getElementById('rc-quarter') || {}).value || '';
    const cell = (document.getElementById('rc-cell') || {}).value || '';
    const workType = (document.getElementById('rc-worktype') || {}).value || '';
    if (!quarter || !workType) {
      res.innerHTML = '<p style="color:#888;padding:10px;">Выбери квартал и вид работ (клетку — по желанию)</p>';
      return;
    }
    res.innerHTML = '<p style="padding:10px;">⏳ Загрузка...</p>';
    this._rcLast = { estate: this.estate, quarter, cell, workType };
    try {
      if (!cell) {
        const url = '/api/rows-status/quarter?estate=' + encodeURIComponent(this.estate) +
          '&quarter=' + encodeURIComponent(quarter) +
          '&work_type=' + encodeURIComponent(workType);
        const r = await this.apiFetch(url);
        const data = await r.json().catch(() => ({}));
        if (!r.ok) {
          res.innerHTML = `<p style="color:#c00;padding:10px;">${this.escapeHtml(data.error || 'Ошибка')}</p>`;
          return;
        }
        this.renderQuarterRowsStatus(data);
        return;
      }
      const url = '/api/rows-status?estate=' + encodeURIComponent(this.estate) +
        '&quarter=' + encodeURIComponent(quarter) +
        '&cell=' + encodeURIComponent(cell) +
        '&work_type=' + encodeURIComponent(workType);
      const r = await this.apiFetch(url);
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        res.innerHTML = `<p style="color:#c00;padding:10px;">${this.escapeHtml(data.error || 'Ошибка')}</p>`;
        return;
      }
      this.renderRowsStatus(data);
    } catch (e) {
      res.innerHTML = `<p style="color:#c00;padding:10px;">${this.escapeHtml(e.message)}</p>`;
    }
  }

  // Рендер сверки одной клетки: сводка + несделанные + Закрыть/Открыть.
  renderRowsStatus(data) {
    const res = document.getElementById('reconcile-result');
    if (!res) return;
    const dispNote = data.disputedCount > 0
      ? ` <span style="color:#c60;">· в т.ч. ${Number(data.disputedCount)} спорных — см. вкладку Спорные</span>`
      : '';
    let summary;
    if (data.fullyDone) {
      summary = `<div><b>Клетка сделана полностью:</b> ${this.fmtRows(data.totalRows)} рядов, ${data.totalBushes} кустов.</div>`;
    } else {
      summary = `<div><b>Сделано:</b> ${this.fmtRows(data.doneRows)} рядов, ${data.doneBushes} кустов`
        + ` · <b>Осталось:</b> ${this.fmtRows(data.remainingRows)} рядов, ${data.remainingBushes} кустов${dispNote}</div>`;
    }

    const undone = [
      ...(data.missedRows || []).map((n) => ({ row: Number(n), disputed: false })),
      ...(data.disputedRows || []).map((n) => ({ row: Number(n), disputed: true })),
    ].sort((a, b) => a.row - b.row);

    let listHtml;
    if (undone.length === 0) {
      listHtml = '<div style="color:#888;padding:6px 0;">Несделанных рядов нет.</div>';
    } else {
      listHtml = '<div style="margin-top:8px;"><b>Не сделаны:</b> '
        + undone.map((u) => u.disputed
          ? `${u.row} <span style="color:#c60;" title="спорный">⚠️</span>`
          : `${u.row}`).join(', ')
        + '</div>';
    }

    const closed = !!data.closed;
    const statusLine = `<div class="rc-closure-bar"><b>Статус:</b> ${closed ? 'Закрыта' : (data.fullyDone ? 'Готова к закрытию' : 'Открыта')}`
      + (closed
        ? ` <button type="button" class="mini-btn" onclick="app.openCellClosure()">Открыть</button>`
        : (data.canClose
          ? ` <button type="button" class="mini-btn" onclick="app.closeCellClosure()">Закрыть</button>`
          : ` <span class="rc-closure-hint">Закрыть нельзя: есть пропуски или спорные</span>`))
      + `</div>`;

    res.innerHTML = statusLine + summary + listHtml;
  }

  // Обзор квартала: все клетки + статусы + кнопки.
  renderQuarterRowsStatus(data) {
    const res = document.getElementById('reconcile-result');
    if (!res) return;
    const cells = data.cells || [];
    if (cells.length === 0) {
      res.innerHTML = '<p style="color:#888;padding:10px;">В квартале нет клеток.</p>';
      return;
    }
    const rows = cells.map((c) => {
      const cellEsc = this.escapeHtml(String(c.cell));
      const label = this.escapeHtml(c.statusLabel || '—');
      const nums = `сделано ${this.fmtRows(c.doneRows)} / осталось ${this.fmtRows(c.remainingRows)}`;
      let btn = '';
      if (c.closed) {
        btn = `<button type="button" class="mini-btn" onclick="event.stopPropagation(); app.openCellClosure('${cellEsc}')">Открыть</button>`;
      } else if (c.canClose) {
        btn = `<button type="button" class="mini-btn" onclick="event.stopPropagation(); app.closeCellClosure('${cellEsc}')">Закрыть</button>`;
      }
      return `<div class="rc-cell-row">
        <button type="button" class="rc-cell-link" onclick="app.openReconcileCell('${cellEsc}')">Клетка ${cellEsc}</button>
        <span class="rc-cell-status">${label}</span>
        <span class="rc-cell-nums">${nums}</span>
        ${btn}
      </div>`;
    }).join('');
    res.innerHTML = `<div class="rc-quarter-list">${rows}</div>`;
  }

  openReconcileCell(cell) {
    const cSel = document.getElementById('rc-cell');
    if (cSel) cSel.value = String(cell);
    this.loadRowsStatus();
  }

  async closeCellClosure(cellArg) {
    const last = this._rcLast || {};
    const cell = cellArg != null && cellArg !== '' ? String(cellArg) : (last.cell || '');
    const estate = last.estate || this.estate;
    const quarter = last.quarter || ((document.getElementById('rc-quarter') || {}).value || '');
    const workType = last.workType || ((document.getElementById('rc-worktype') || {}).value || '');
    if (!estate || !quarter || !cell || !workType) {
      alert('Не хватает квартала, клетки или вида работ');
      return;
    }
    try {
      const r = await this.apiFetch('/api/cell-closures', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ estate, quarter, cell, work_type: workType }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || 'Не удалось закрыть');
      await this.loadRowsStatus();
    } catch (e) {
      alert(e.message);
    }
  }

  async openCellClosure(cellArg) {
    const last = this._rcLast || {};
    const cell = cellArg != null && cellArg !== '' ? String(cellArg) : (last.cell || '');
    const estate = last.estate || this.estate;
    const quarter = last.quarter || ((document.getElementById('rc-quarter') || {}).value || '');
    const workType = last.workType || ((document.getElementById('rc-worktype') || {}).value || '');
    if (!estate || !quarter || !cell || !workType) {
      alert('Не хватает квартала, клетки или вида работ');
      return;
    }
    try {
      const r = await this.apiFetch('/api/cell-closures', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ estate, quarter, cell, work_type: workType }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || 'Не удалось открыть');
      await this.loadRowsStatus();
    } catch (e) {
      alert(e.message);
    }
  }

  // Загружает отчёт «Выполнение» (га сделано/сегодня/осталось) и рисует плашки агронома.
  async loadPerformance() {
    const list = document.getElementById('perf-list');
    const filters = document.getElementById('perf-filters');
    if (!list) return;
    const dateEl = document.getElementById('perf-date');
    if (dateEl && dateEl.value) this.perfDate = dateEl.value;
    if (!this.perfDate) this.perfDate = this.getTodayDate();
    list.innerHTML = '<p style="padding:10px;">⏳ Загрузка...</p>';
    try {
      const r = await this.apiFetch('/api/report/hectares?date=' + encodeURIComponent(this.perfDate));
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        if (filters) filters.innerHTML = '';
        list.innerHTML = `<p style="color:#c00;padding:10px;">${this.escapeHtml(data.error || 'Ошибка')}</p>`;
        return;
      }
      this.perfRows = data.rows || [];
      if (data.date) this.perfDate = data.date;
      this.perfQuarters = new Set(this.perfRows.map(x => String(x.quarter)));
      this.perfWorkTypes = new Set(this.perfRows.map(x => x.work_type));
      this.renderPerformance();
      this.applyFlatpickr();
    } catch (e) {
      if (filters) filters.innerHTML = '';
      list.innerHTML = `<p style="color:#c00;padding:10px;">${this.escapeHtml(e.message)}</p>`;
    }
  }

  onPerfDateChange() {
    const el = document.getElementById('perf-date');
    this.perfDate = (el && el.value) || this.getTodayDate();
    this.loadPerformance();
  }

  // Метка бригады для текста агроному.
  perfBrigadeLabel() {
    if (this.config && this.config.demoMode) return 'демо';
    if (this.me && this.me.name) return this.me.name;
    if (this.me && this.me.login) return this.me.login;
    return '—';
  }

  // Число га для буфера: «4,20» (запятая как в MAX).
  fmtHaComma(n) {
    return (Math.round((Number(n) || 0) * 100) / 100).toFixed(2).replace('.', ',');
  }

  // «21.07» из YYYY-MM-DD.
  fmtDayMonth(iso) {
    const s = String(iso || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    return `${s.slice(8, 10)}.${s.slice(5, 7)}`;
  }

  // Текст одной плашки — как сообщение в группу «АГРО Отчет».
  formatAgronomistReportText(row, dateIso) {
    const cells = (row.cells || []).map(String).filter(Boolean);
    const cellPart = cells.length
      ? `, клет.${this.formatRange(cells.join(','))}`
      : '';
    const place = `Кв.${row.quarter}${cellPart} · Бр.${this.perfBrigadeLabel()} (${this.fmtHaComma(row.total_ha)}га)`;
    return [
      `За ${this.fmtDayMonth(dateIso)}`,
      place,
      String(row.work_type || '—'),
      `Сделано-${this.fmtHaComma(row.done_ha)}га`,
      `Сегодня -${this.fmtHaComma(row.today_ha)}га`,
      `Осталось-${this.fmtHaComma(row.remaining_ha)}га`,
    ].join('\n');
  }

  async copyPerfReport(idx) {
    const shown = this._perfShownRows();
    const row = shown[idx];
    if (!row) return;
    const text = this.formatAgronomistReportText(row, this.perfDate);
    await this._copyText(text);
  }

  async copyAllPerfReports() {
    const shown = this._perfShownRows();
    if (!shown.length) return;
    const text = shown.map(r => this.formatAgronomistReportText(r, this.perfDate)).join('\n\n');
    await this._copyText(text);
  }

  _perfShownRows() {
    if (!this.perfRows || !this.perfRows.length) return [];
    return this.perfRows.filter(x =>
      this.perfWorkTypes.has(x.work_type) && this.perfQuarters.has(String(x.quarter)));
  }

  async _copyText(text) {
    const msg = document.getElementById('perf-copy-msg');
    const show = (t) => { if (msg) { msg.className = 'auth-msg'; msg.textContent = t; } };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      show('✓ Скопировано — вставь в группу MAX');
      setTimeout(() => { if (msg && msg.textContent.startsWith('✓')) msg.textContent = ''; }, 2500);
    } catch (e) {
      show('❌ Не удалось скопировать: ' + (e.message || e));
    }
  }

  // Переключает чип-фильтр (квартал 'q' или вид работ 'wt') и перерисовывает.
  togglePerfFilter(kind, value) {
    const set = kind === 'q' ? this.perfQuarters : this.perfWorkTypes;
    if (set.has(value)) set.delete(value); else set.add(value);
    this.renderPerformance();
  }

  togglePerfFiltersPanel() {
    this.perfFiltersOpen = !this.perfFiltersOpen;
    this.renderPerformance();
  }

  // Рендер: фильтры + плашки в формате отчёта агроному.
  renderPerformance() {
    const filters = document.getElementById('perf-filters');
    const list = document.getElementById('perf-list');
    const copyAll = document.getElementById('perf-copy-all');
    if (!filters || !list) return;
    if (!this.perfRows || this.perfRows.length === 0) {
      filters.innerHTML = '';
      if (copyAll) copyAll.style.display = 'none';
      list.innerHTML = '<p style="color:#888;padding:10px;">Пока ничего не записано — заполни журнал, и тут появятся гектары.</p>';
      return;
    }
    const allQ = [...new Set(this.perfRows.map(x => String(x.quarter)))]
      .sort((a, b) => (parseInt(a, 10) || 0) - (parseInt(b, 10) || 0));
    const allWt = [...new Set(this.perfRows.map(x => x.work_type))].sort((a, b) => a.localeCompare(b, 'ru'));
    const chip = (kind, val, on) =>
      `<button class="filter-chip ${on ? 'active' : ''}" onclick="app.togglePerfFilter('${kind}', '${this.escapeAttr(val)}')">${this.escapeHtml(val)}</button>`;
    const filterActive = this.perfWorkTypes.size < allWt.length || this.perfQuarters.size < allQ.length;
    const filtersOpen = !!this.perfFiltersOpen;
    filters.innerHTML =
      `<button class="mini-btn perf-toggle-filters" onclick="app.togglePerfFiltersPanel()">🔍 Фильтры${filterActive ? ' •' : ''} ${filtersOpen ? '▲' : '▼'}</button>` +
      `<div class="perf-filter-panel"${filtersOpen ? '' : ' style="display:none;"'}>` +
      `<div class="perf-filter-row"><span class="filter-label">Виды работ:</span>` +
      allWt.map(wt => chip('wt', wt, this.perfWorkTypes.has(wt))).join('') + `</div>` +
      `<div class="perf-filter-row"><span class="filter-label">Кварталы:</span>` +
      allQ.map(q => chip('q', q, this.perfQuarters.has(q))).join('') + `</div>` +
      `</div>`;

    const shown = this._perfShownRows();
    if (copyAll) copyAll.style.display = shown.length ? '' : 'none';
    if (shown.length === 0) {
      list.innerHTML = '<p style="color:#888;padding:10px;">Ничего не выбрано в фильтрах.</p>';
      return;
    }
    list.innerHTML = shown.map((x, idx) => {
      const text = this.formatAgronomistReportText(x, this.perfDate);
      const kindLabel = x.kind === 'mech' ? '🚜' : '🛠';
      return `<div class="perf-agro-card">
        <pre class="perf-agro-text">${this.escapeHtml(text)}</pre>
        <div class="perf-agro-actions">
          <span class="perf-kind">${kindLabel}</span>
          <button class="mini-btn" onclick="app.copyPerfReport(${idx})">Скопировать</button>
        </div>
      </div>`;
    }).join('');
  }

  // Открывает модалку выбора рабочих (одного или нескольких) с долями кустов,
  // затем отправляет разбор. Деление — выбор бригадира: отметил несколько → кусты
  // делятся (пустые доли = поровну, остаток первым).
  async openDisputedAssign(id) {
    const d = (this.disputed || []).find((x) => x.id === id);
    if (!d) return;
    const assignments = await this.showDivideModal({
      row: d.row_num,
      askShare: d.measure_mode === 'rows_bushes',
      preselect: [],
      rowBushes: d.row_bushes || 0,
    });
    if (!assignments) return;
    await this.resolveDisputed(id, 'assign-actual', assignments);
  }

  // Окно деления ряда между рабочими: чекбоксы + доли кустов (пусто = поровну).
  // preselect — имена, отмеченные заранее (занявший ряд и текущий рабочий).
  // Возвращает Promise: массив [{employee, bushes|null}] (≥1) или null при отмене.
  showDivideModal({ row, askShare, preselect = [], rowBushes = 0 }) {
    return new Promise((resolve) => {
      if (!this.employees || this.employees.length === 0) {
        this.showInfoModal('Список рабочих не загружен');
        resolve(null);
        return;
      }
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      const box = document.createElement('div');
      box.className = 'modal-box';

      const title = document.createElement('div');
      title.className = 'modal-title';
      title.textContent = `Ряд ${row} — кто делал?`;
      box.appendChild(title);

      const hint = document.createElement('div');
      hint.className = 'modal-text';
      hint.textContent = askShare
        ? 'Отметь рабочих. Если несколько — кусты делятся поровну; можно задать долю вручную.'
        : 'Отметь рабочих, которые делали ряд.';
      box.appendChild(hint);

      if (askShare && rowBushes > 0) {
        const bhint = document.createElement('div');
        bhint.className = 'modal-text';
        bhint.style.marginTop = '-6px';
        bhint.textContent = `В этом ряду ${rowBushes} кустов.`;
        box.appendChild(bhint);
      }

      // Список рабочих — в прокручиваемом контейнере, чтобы на телефоне
      // кнопки действий снизу оставались видны при длинном списке.
      const listEl = document.createElement('div');
      listEl.className = 'modal-list';
      const rows = [];
      (this.employees || []).forEach((e) => {
        const rowEl = document.createElement('label');
        rowEl.style.display = 'flex';
        rowEl.style.alignItems = 'center';
        rowEl.style.gap = '8px';
        rowEl.style.margin = '6px 0';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        if (preselect.includes(e.name)) cb.checked = true;
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
        } else {
          shareInput = document.createElement('input');
          shareInput.className = 'modal-input';
          shareInput.inputMode = 'decimal';
          shareInput.placeholder = 'доля';
          shareInput.style.width = '90px';
          shareInput.style.margin = '0';
          rowEl.appendChild(shareInput);
        }
        listEl.appendChild(rowEl);
        rows.push({ name: e.name, cb, shareInput });
      });
      box.appendChild(listEl);

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
        if (chosen.length === 0) return; // нечего записывать — ждём выбора
        close(chosen);
      });
      cancel.addEventListener('click', () => close(null));
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });
    });
  }

  async resolveDisputed(id, action, assignments) {
    // Разобранный ряд ложится на сегодня (день, когда бригадир разобрался).
    const body = { action, date: this.getTodayDate() };
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

  // Экранирует значение для подстановки в одинарные кавычки onclick-атрибута.
  escapeAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '&quot;');
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
      resultDiv.innerHTML = header + this.renderPlatesReportHtml(data.logs, {
        grandLabel: 'Всего за период',
      });
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
