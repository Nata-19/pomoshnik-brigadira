class BrigadeAssistant {
  constructor() {
    this.quarters = [];
    this.inventory = {};
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
            <label>Ввод данных (Квартал N, Клетка N: Фамилия - с X по Y, A; ...):</label>
            <textarea id="input" placeholder="Квартал 1, Клетка 1: Иванов - с 1 по 3, 5; Петров - с 6 по 8&#10;Квартал 2, Клетка 2: Сидоров - с 1 по 2"></textarea>
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
    const resultDiv = document.getElementById('result');

    if (!date || !input.trim()) {
      this.showResult('❌ Некорректный формат ввода', true, resultDiv);
      return;
    }

    try {
      const response = await fetch('/api/process', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date, input })
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
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      const btn = document.getElementById('voice-btn');
      if (btn) btn.style.display = 'none';
      return;
    }

    this.recognition = new SpeechRecognition();
    this.recognition.lang = 'ru-RU';
    this.recognition.continuous = true;
    this.recognition.interimResults = false;

    this.recognition.onresult = (e) => {
      let transcript = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) {
          transcript += e.results[i][0].transcript;
        }
      }
      if (!transcript.trim()) return;
      const textarea = document.getElementById('input');
      textarea.value += (textarea.value ? '\n' : '') + transcript.trim();
    };

    this.recognition.onend = () => {
      this.isRecording = false;
      this.updateVoiceUI();
    };

    this.recognition.onerror = (e) => {
      this.isRecording = false;
      this.updateVoiceUI();
      const statusEl = document.getElementById('voice-status');
      if (statusEl) statusEl.textContent = '❌ Ошибка: ' + e.error;
    };
  }

  toggleVoice() {
    if (!this.recognition) return;
    if (this.isRecording) {
      this.recognition.stop();
    } else {
      this.recognition.start();
      this.isRecording = true;
      this.updateVoiceUI();
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
