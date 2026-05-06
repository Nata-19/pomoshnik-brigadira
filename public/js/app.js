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
            <label>Ввод данных (голосом или вручную):</label>
            <textarea id="input" placeholder="Примеры:&#10;квартал 1 клетка 1 иванов с 1 по 5&#10;Лена с 6 по 10            (квартал/клетка наследуются)&#10;Петров 11, 12, 13&#10;&#10;Или строгий формат:&#10;Квартал 1, Клетка 1: Иванов - с 1 по 3; Петров - 6, 8"></textarea>
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
    this.recognition.interimResults = true;
    this.shouldKeepRecording = false;

    this.recognition.onresult = (e) => {
      let finalChunk = '';
      let interimChunk = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const text = e.results[i][0].transcript;
        if (e.results[i].isFinal) {
          finalChunk += text;
        } else {
          interimChunk += text;
        }
      }
      if (finalChunk.trim()) {
        const textarea = document.getElementById('input');
        textarea.value += (textarea.value ? '\n' : '') + finalChunk.trim();
      }
      // Показываем «живой» текст в строке статуса, чтобы пользователь видел,
      // что распознаётся прямо сейчас
      const statusEl = document.getElementById('voice-status');
      if (statusEl && this.isRecording) {
        statusEl.textContent = interimChunk.trim()
          ? '🔴 ' + interimChunk.trim()
          : '🔴 Запись...';
      }
    };

    this.recognition.onend = () => {
      // Если пользователь не нажимал «Стоп» — автоматически перезапускаем,
      // потому что браузер сам глушит сессию после паузы в речи.
      if (this.shouldKeepRecording) {
        setTimeout(() => {
          if (this.shouldKeepRecording) {
            try {
              this.recognition.start();
            } catch (err) {
              // start() кидает, если сессия ещё не успела закрыться — повторим чуть позже
              setTimeout(() => {
                if (this.shouldKeepRecording) {
                  try { this.recognition.start(); } catch (_) {}
                }
              }, 300);
            }
          }
        }, 100);
        return;
      }
      this.isRecording = false;
      this.updateVoiceUI();
    };

    this.recognition.onerror = (e) => {
      const statusEl = document.getElementById('voice-status');
      // 'no-speech' — нормальная пауза, продолжаем (onend перезапустит)
      // 'aborted' — браузер просто прервал, тоже продолжаем
      if (e.error === 'no-speech' || e.error === 'aborted') {
        if (statusEl) statusEl.textContent = '🔴 Запись... (пауза)';
        return;
      }
      // Реальные ошибки — останавливаемся
      this.shouldKeepRecording = false;
      this.isRecording = false;
      this.updateVoiceUI();
      if (statusEl) statusEl.textContent = '❌ Ошибка: ' + e.error;
    };
  }

  toggleVoice() {
    if (!this.recognition) return;
    if (this.isRecording) {
      this.shouldKeepRecording = false;
      this.recognition.stop();
    } else {
      this.shouldKeepRecording = true;
      try {
        this.recognition.start();
      } catch (err) {
        // Если уже запущено — игнорируем
      }
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
