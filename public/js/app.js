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

  async getReport() {
    const from = document.getElementById('from-date').value;
    const to = document.getElementById('to-date').value;
    const resultDiv = document.getElementById('report-result');

    if (!from || !to) {
      this.showResult('❌ Укажите даты', true, resultDiv);
      return;
    }

    this.showResult('📋 Функция отчета в разработке', false, resultDiv);
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
      // Декодируем WebM/Opus → PCM, ресемплируем в 16 кГц моно для Whisper
      const arrayBuffer = await blob.arrayBuffer();
      const AC = window.AudioContext || window.webkitAudioContext;
      const audioCtx = new AC();
      const decoded = await audioCtx.decodeAudioData(arrayBuffer);
      try { audioCtx.close(); } catch {}

      const targetRate = 16000;
      const offlineCtx = new OfflineAudioContext(1, Math.ceil(decoded.duration * targetRate), targetRate);
      const source = offlineCtx.createBufferSource();
      source.buffer = decoded;
      source.connect(offlineCtx.destination);
      source.start(0);
      const resampled = await offlineCtx.startRendering();
      const samples = resampled.getChannelData(0); // Float32Array @ 16kHz mono

      // Отправляем сырые байты Float32 на сервер
      const response = await fetch('/api/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: samples.buffer,
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
