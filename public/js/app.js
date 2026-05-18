class BrigadeAssistant {
  constructor() {
    this.me = null;
    this.estates = [];
    this.estate = localStorage.getItem('selectedEstate') || '';
    this.quarters = [];
    this.cellsByQuarter = {}; // кэш клеток по (estate|quarter)
    this.init();
  }

  async init() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/service-worker.js').catch(e => console.log('SW error:', e));
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
    // Перерисовываем выпадающие списки кварталов/клеток
    const qSel = document.getElementById('quarter-sel');
    if (qSel) {
      qSel.innerHTML = '<option value="">Квартал...</option>' +
        this.quarters.map(q => `<option value="${q.id}">${this.escapeHtml(q.name)}</option>`).join('');
    }
    const cSel = document.getElementById('cell-sel');
    if (cSel) cSel.innerHTML = '<option value="">Клетка...</option>';
    // Подсвечиваем текущее хозяйство в бейдже
    const badge = document.getElementById('estate-badge');
    if (badge) {
      const est = this.estates.find(e => e.id === this.estate);
      badge.textContent = est ? est.name : '';
    }
  }

  async onQuarterChange() {
    const qSel = document.getElementById('quarter-sel');
    const cSel = document.getElementById('cell-sel');
    cSel.innerHTML = '<option value="">Клетка...</option>';
    if (!qSel.value) return;
    const cells = await this.loadCells(qSel.value);
    for (const c of cells) {
      const opt = document.createElement('option');
      opt.value = c;
      opt.textContent = 'Клетка ' + c;
      cSel.appendChild(opt);
    }
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
          <label>Пароль (не короче 6 символов):</label>
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
        <h1>🍇 Помощьник Бригадира</h1>
        <div class="tabs">
          <button class="tab-button ${isReg ? '' : 'active'}" onclick="app.renderAuth('login')">Войти</button>
          <button class="tab-button ${isReg ? 'active' : ''}" onclick="app.renderAuth('register')">Зарегистрироваться</button>
        </div>
        <div class="form-group">
          <label>Логин:</label>
          <input type="text" id="auth-login" autocomplete="username">
        </div>
        <div class="form-group">
          <label>Пароль${isReg ? ' (не короче 6 символов)' : ''}:</label>
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

  render() {
    const root = document.getElementById('root');
    const currentEstate = this.estates.find(e => e.id === this.estate);
    root.innerHTML = `
      <div class="container">
        <div class="app-header">
          <h1>🍇 Помощьник Бригадира</h1>
          <div class="app-user">
            <span>${this.escapeHtml(this.me ? this.me.login : '')}</span>
            <button class="logout-btn" onclick="app.logout()">Выйти</button>
          </div>
        </div>

        <div class="form-group estate-picker">
          <label>Хозяйство:</label>
          <select id="estate-sel" onchange="app.onEstateChange()">
            <option value="">— выберите хозяйство —</option>
            ${this.estates.map(e => `<option value="${e.id}" ${e.id === this.estate ? 'selected' : ''}>${this.escapeHtml(e.name)}</option>`).join('')}
          </select>
          <span id="estate-badge" class="estate-badge">${currentEstate ? this.escapeHtml(currentEstate.name) : ''}</span>
        </div>

        <div class="tabs">
          <button class="tab-button active" onclick="app.switchTab(event, 'input')">Ввод данных</button>
          <button class="tab-button" onclick="app.switchTab(event, 'report')">Отчет за период</button>
          <button class="tab-button" onclick="app.switchTab(event, 'logs'); app.loadLogs()">Журнал</button>
          ${this.me && this.me.is_admin ? `<button class="tab-button" onclick="app.switchTab(event, 'admin'); app.loadBrigadiers()">Админ</button>` : ''}
        </div>

        <div class="tab-content active" id="input-tab">
          <div class="form-group">
            <label>Дата (YYYY-MM-DD):</label>
            <input type="date" id="date" value="${this.getTodayDate()}">
          </div>

          <div class="form-group">
            <label>Квартал и клетка (по умолчанию — для строк без явного указания):</label>
            <div class="row-2cols">
              <select id="quarter-sel" onchange="app.onQuarterChange()">
                <option value="">Квартал...</option>
                ${this.quarters.map(q => `<option value="${q.id}">${q.name}</option>`).join('')}
              </select>
              <select id="cell-sel">
                <option value="">Клетка...</option>
              </select>
            </div>
          </div>

          <div class="form-group">
            <label>Сотрудники (голосом или вручную):</label>
            <textarea id="input" placeholder="Иванов с 1 по 5; Лена 6, 7&#10;Петров с 8 по 10&#10;&#10;Голосом: «иванов с первого по пятый», (пауза) «лена шестой седьмой»"></textarea>
            <div class="voice-row">
              <button type="button" id="voice-btn" onclick="app.toggleVoice()" class="voice-btn">🎤 Голос</button>
              <span id="voice-status"></span>
            </div>
          </div>

          <button onclick="app.process()">Обработать</button>

          <div id="result" class="result" style="display:none;"></div>
        </div>

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
    this.initVoiceInput();
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

  async process() {
    const date = document.getElementById('date').value;
    const input = document.getElementById('input').value;
    const quarter = document.getElementById('quarter-sel').value;
    const cell = document.getElementById('cell-sel').value;
    const resultDiv = document.getElementById('result');

    if (!this.estate) {
      this.showResult('❌ Сначала выбери хозяйство', true, resultDiv);
      return;
    }
    if (!date || !input.trim()) {
      this.showResult('❌ Введи дату и хотя бы одну строку с сотрудником', true, resultDiv);
      return;
    }

    try {
      const response = await fetch('/api/process', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date, input, estate: this.estate, quarter, cell })
      });

      const result = await response.json();

      if (response.ok) {
        this.showResult(result.report, false, resultDiv);
      } else {
        this.showResult('❌ ' + result.error, true, resultDiv);
      }
    } catch (error) {
      this.showResult('❌ ' + error.message, true, resultDiv);
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
      // Сортируем по кварталу/клетке/сотруднику для удобства
      const sorted = data.logs.slice().sort((a, b) =>
        (+a.quarter - +b.quarter) || (+a.cell - +b.cell) || a.employee.localeCompare(b.employee, 'ru')
      );
      list.innerHTML = sorted.map(log => `
        <div class="log-entry">
          <div class="log-info">
            <div class="log-employee">${this.escapeHtml(log.employee)}</div>
            <div class="log-meta">Кв.${log.quarter}, кл.${log.cell} · ряды [${this.escapeHtml(log.rows)}] · ${log.bushes} кустов</div>
          </div>
          <button class="delete-btn" onclick="app.deleteLog(${log.id})">Удалить</button>
        </div>
      `).join('');
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

    this.showResult('⏳ Загрузка отчёта...', false, resultDiv);

    try {
      const response = await fetch(`/api/report?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&estate=${encodeURIComponent(this.estate)}`);
      const data = await response.json();
      if (response.ok) {
        this.showResult(data.report, false, resultDiv);
      } else {
        this.showResult('❌ ' + (data.error || 'Не удалось получить отчёт'), true, resultDiv);
      }
    } catch (error) {
      this.showResult('❌ ' + error.message, true, resultDiv);
    }
  }

  initVoiceInput() {
    // Web Speech API: распознавание речи прямо в браузере, без сервера.
    // Если браузер не поддерживает (старый Android, часть iPhone) —
    // прячем кнопку, остаётся ручной ввод.
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      const btn = document.getElementById('voice-btn');
      if (btn) btn.style.display = 'none';
    }
  }

  toggleVoice() {
    if (this.isRecording) {
      this.stopRecording();
    } else {
      this.startRecording();
    }
  }

  startRecording() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      this.setVoiceStatus('❌ Браузер не поддерживает распознавание речи');
      return;
    }

    const textarea = document.getElementById('input');
    // Базовый текст — то, что уже было в поле до начала записи.
    this.voiceBaseText = textarea.value;

    const recognition = new SR();
    recognition.lang = 'ru-RU';
    recognition.continuous = true;      // не обрывается на паузах
    recognition.interimResults = true;  // живой текст по ходу речи

    recognition.onresult = (event) => {
      // Пересобираем текст с нуля на каждом событии — идемпотентно.
      // На Android Chrome event.resultIndex ненадёжен, и уже распознанные
      // фразы приходят повторно; накапливать нельзя — строки задвоятся.
      let finalText = '';
      let interimText = '';
      for (let i = 0; i < event.results.length; i++) {
        const res = event.results[i];
        const transcript = (res[0].transcript || '').trim();
        if (!transcript) continue;
        if (res.isFinal) {
          finalText += (finalText ? '\n' : '') + transcript;
        } else {
          interimText += (interimText ? ' ' : '') + transcript;
        }
      }
      // Базовый текст + завершённые фразы (каждая на своей строке) + текущая.
      const parts = [];
      if (this.voiceBaseText) parts.push(this.voiceBaseText);
      if (finalText) parts.push(finalText);
      if (interimText) parts.push(interimText);
      textarea.value = parts.join('\n');
    };

    recognition.onerror = (event) => {
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        this.setVoiceStatus('❌ Нет доступа к микрофону');
      } else if (event.error === 'no-speech') {
        this.setVoiceStatus('⚠ Речь не распознана');
      } else if (event.error === 'network') {
        this.setVoiceStatus('❌ Нет сети');
      } else {
        this.setVoiceStatus('❌ Ошибка распознавания');
      }
    };

    recognition.onend = () => {
      this.isRecording = false;
      this.recognition = null;
      this.updateVoiceUI();
    };

    this.recognition = recognition;
    this.isRecording = true;
    this.updateVoiceUI();
    this.setVoiceStatus('🔴 Запись... жми «⏹ Стоп», когда закончишь');

    try {
      recognition.start();
    } catch (err) {
      this.isRecording = false;
      this.recognition = null;
      this.updateVoiceUI();
      this.setVoiceStatus('❌ ' + err.message);
    }
  }

  stopRecording() {
    if (this.recognition) {
      try { this.recognition.stop(); } catch (e) {}
    }
    this.isRecording = false;
    this.updateVoiceUI();
    this.setVoiceStatus('');
  }

  setVoiceStatus(text) {
    const el = document.getElementById('voice-status');
    if (el) el.textContent = text;
  }

  updateVoiceUI() {
    const btn = document.getElementById('voice-btn');
    if (!btn) return;
    if (this.isRecording) {
      btn.textContent = '⏹ Стоп';
      btn.classList.add('recording');
    } else {
      btn.textContent = '🎤 Голос';
      btn.classList.remove('recording');
    }
  }

  async logout() {
    try { await fetch('/api/logout', { method: 'POST' }); } catch (e) {}
    location.reload();
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
            <button class="mini-btn" onclick="app.resetBrigadierPassword(${b.id})">Сброс пароля</button>
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
    const password = prompt('Новый пароль для этого аккаунта (не короче 6 символов):');
    if (password === null) return;
    try {
      const r = await this.apiFetch('/api/admin/brigadiers/' + id + '/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const data = await r.json().catch(() => ({}));
      if (r.ok) {
        alert('Пароль изменён. Сообщите его бригадиру.');
      } else {
        alert('Ошибка: ' + (data.error || 'не удалось'));
      }
    } catch (e) {
      alert('Ошибка: ' + e.message);
    }
  }
}

const app = new BrigadeAssistant();
