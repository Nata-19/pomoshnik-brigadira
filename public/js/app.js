class BrigadeAssistant {
  constructor() {
    this.quarters = [];
    this.cellsByQuarter = {}; // кэш клеток по кварталу
    this.init();
  }

  async init() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/service-worker.js').catch(e => console.log('SW error:', e));
    }
    await this.loadQuarters();
    this.render();
  }

  async loadQuarters() {
    try {
      const response = await fetch('/api/quarters');
      this.quarters = await response.json();
    } catch (error) {
      console.error('Failed to load quarters:', error);
    }
  }

  async loadCells(quarterId) {
    if (this.cellsByQuarter[quarterId]) return this.cellsByQuarter[quarterId];
    try {
      const r = await fetch('/api/inventory/' + encodeURIComponent(quarterId));
      const data = await r.json();
      const cells = Object.keys(data.cells || {}).sort((a, b) => +a - +b);
      this.cellsByQuarter[quarterId] = cells;
      return cells;
    } catch (e) {
      return [];
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

  render() {
    const root = document.getElementById('root');
    root.innerHTML = `
      <div class="container">
        <h1>🍇 Помощьник Бригадира</h1>
        
        <div class="tabs">
          <button class="tab-button active" onclick="app.switchTab(event, 'input')">Ввод данных</button>
          <button class="tab-button" onclick="app.switchTab(event, 'report')">Отчет за период</button>
          <button class="tab-button" onclick="app.switchTab(event, 'logs'); app.loadLogs()">Журнал</button>
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

    if (!date || !input.trim()) {
      this.showResult('❌ Введи дату и хотя бы одну строку с сотрудником', true, resultDiv);
      return;
    }

    try {
      const response = await fetch('/api/process', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date, input, quarter, cell })
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
    if (!date) {
      list.innerHTML = '<p style="color:#888;padding:10px;">Выбери дату</p>';
      return;
    }
    list.innerHTML = '<p style="padding:10px;">⏳ Загрузка...</p>';
    try {
      const r = await fetch('/api/logs?date=' + encodeURIComponent(date));
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
      const response = await fetch(`/api/report?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
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
    // Для записи используем MediaRecorder (доступен везде, кроме совсем старых браузеров)
    if (!navigator.mediaDevices || !window.MediaRecorder) {
      const btn = document.getElementById('voice-btn');
      if (btn) btn.style.display = 'none';
      return;
    }
  }

  async toggleVoice() {
    if (this.isRecording) {
      this.stopRecording();
    } else {
      await this.startRecording();
    }
  }

  async startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.audioStream = stream;
      this.audioChunks = [];

      // Подбираем поддерживаемый формат — Android и iOS могут различаться
      const mimes = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];
      let mime = '';
      for (const m of mimes) {
        if (window.MediaRecorder.isTypeSupported && window.MediaRecorder.isTypeSupported(m)) {
          mime = m;
          break;
        }
      }
      this.mediaRecorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);

      this.mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) this.audioChunks.push(e.data);
      };

      this.mediaRecorder.onstop = async () => {
        // Закрываем поток микрофона
        try { stream.getTracks().forEach(t => t.stop()); } catch {}

        const blob = new Blob(this.audioChunks, { type: this.mediaRecorder.mimeType || 'audio/webm' });
        if (blob.size === 0) {
          this.setVoiceStatus('');
          return;
        }
        await this.transcribeBlob(blob);
      };

      this.mediaRecorder.start();
      this.isRecording = true;
      this.updateVoiceUI();
      this.setVoiceStatus('🔴 Запись... жми «⏹ Стоп», когда закончишь');
    } catch (err) {
      this.setVoiceStatus('❌ Микрофон: ' + err.message);
    }
  }

  stopRecording() {
    if (!this.mediaRecorder) return;
    try { this.mediaRecorder.stop(); } catch {}
    this.isRecording = false;
    this.updateVoiceUI();
    this.setVoiceStatus('⏳ Распознаю...');
  }

  setVoiceStatus(text) {
    const el = document.getElementById('voice-status');
    if (el) el.textContent = text;
  }

  async transcribeBlob(blob) {
    try {
      // Просто шлём аудио-blob на сервер; сервер передаст его в Hugging Face API.
      const response = await fetch('/api/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': blob.type || 'audio/webm' },
        body: blob,
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        this.setVoiceStatus('❌ ' + (data.error || ('HTTP ' + response.status)));
        return;
      }
      const data = await response.json();
      const text = (data.text || '').trim();
      if (!text) {
        this.setVoiceStatus('⚠ Ничего не распознано — попробуй ещё раз');
        return;
      }
      const textarea = document.getElementById('input');
      textarea.value += (textarea.value ? '\n' : '') + text;
      this.setVoiceStatus('');
    } catch (err) {
      this.setVoiceStatus('❌ ' + err.message);
    }
  }

  updateVoiceUI() {
    const btn = document.getElementById('voice-btn');
    const status = document.getElementById('voice-status');
    if (!btn || !status) return;

    if (this.isRecording) {
      btn.textContent = '⏹ Стоп';
      btn.classList.add('recording');
      status.textContent = '🔴 Запись...';
    } else {
      btn.textContent = '🎤 Голос';
      btn.classList.remove('recording');
      status.textContent = '';
    }
  }
}

const app = new BrigadeAssistant();
