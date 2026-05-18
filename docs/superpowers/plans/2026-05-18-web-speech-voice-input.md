# Web Speech Voice Input Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace server-side Hugging Face transcription with in-browser speech recognition via the Web Speech API.

**Architecture:** All voice work moves to the client. `public/js/app.js` uses `webkitSpeechRecognition` to recognise Russian speech directly in the browser, streaming interim results into the textarea live. The server endpoint `/api/transcribe` is left in place but dormant. The service worker cache version is bumped so clients pull the new `app.js`.

**Tech Stack:** Vanilla JS, Web Speech API (`SpeechRecognition` / `webkitSpeechRecognition`), PWA service worker.

**Testing note:** The Web Speech API is a browser-only API — it cannot run under Node, so there are no unit tests. Automated verification is limited to `node --check` (syntax). Functional verification is a manual checklist on an Android phone (Task 3).

---

### Task 1: Replace voice input methods in app.js

**Files:**
- Modify: `public/js/app.js` — the voice methods block (`initVoiceInput`, `toggleVoice`, `startRecording`, `stopRecording`, `setVoiceStatus`, `transcribeBlob`, `updateVoiceUI`)

The current file has these seven methods at the end of the `BrigadeAssistant` class. They implement the old `MediaRecorder` → server flow. Replace the **entire contiguous block** — from the line `  initVoiceInput() {` through the closing brace of `updateVoiceUI()` — with the new implementation below. Do not touch any code above `initVoiceInput()` or the `const app = new BrigadeAssistant();` line at the very end.

- [ ] **Step 1: Replace the voice methods block**

Replace the whole block with exactly this:

```js
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
    // Накопитель завершённых фраз: каждая пауза в речи = новая строка.
    this.voiceFinalText = '';

    const recognition = new SR();
    recognition.lang = 'ru-RU';
    recognition.continuous = true;      // не обрывается на паузах
    recognition.interimResults = true;  // живой текст по ходу речи

    recognition.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        const transcript = res[0].transcript.trim();
        if (res.isFinal) {
          if (transcript) {
            this.voiceFinalText += (this.voiceFinalText ? '\n' : '') + transcript;
          }
        } else {
          interim += res[0].transcript;
        }
      }
      // Пересобираем textarea: базовый текст + финальные фразы + промежуточная.
      const parts = [];
      if (this.voiceBaseText) parts.push(this.voiceBaseText);
      if (this.voiceFinalText) parts.push(this.voiceFinalText);
      let combined = parts.join('\n');
      if (interim.trim()) {
        combined += (combined ? '\n' : '') + interim.trim();
      }
      textarea.value = combined;
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
```

Note: the old `transcribeBlob` method is intentionally gone — it sent audio to the server and is no longer used. `updateVoiceUI` no longer touches the status element (`startRecording`/`stopRecording` set the status explicitly).

- [ ] **Step 2: Verify syntax**

Run: `node --check public/js/app.js`
Expected: no output, exit code 0 (syntax valid).

- [ ] **Step 3: Commit**

```bash
git add public/js/app.js
git commit -m "Replace voice input with browser Web Speech API"
```

---

### Task 2: Bump service worker cache version

**Files:**
- Modify: `public/service-worker.js:1` — `CACHE_NAME`

Clients cache `app.js`. Without a cache bump they keep the old voice code. Bump the version so the service worker fetches the new file.

- [ ] **Step 1: Change the cache version**

In `public/service-worker.js`, line 1, change:

```js
const CACHE_NAME = 'brigade-v12';
```

to:

```js
const CACHE_NAME = 'brigade-v13';
```

- [ ] **Step 2: Verify syntax**

Run: `node --check public/service-worker.js`
Expected: no output, exit code 0.

- [ ] **Step 3: Commit**

```bash
git add public/service-worker.js
git commit -m "Bump service worker cache to v13"
```

---

### Task 3: Manual verification on Android

This task has no code. It is a manual checklist done after the changes are pushed and Render has redeployed. Web Speech API cannot be tested any other way.

- [ ] **Step 1: Push and wait for deploy**

```bash
git push
```

Then open the Render dashboard → service `pomoshnik-brigadira` → Events, and wait for a green "Deploy live" entry.

- [ ] **Step 2: Verify on an Android phone (Chrome)**

Open `https://pomoshnik-brigadira.onrender.com` on an Android phone in Chrome. Confirm each item:

- The «🎤 Голос» button is visible.
- Tapping it asks for microphone permission (first time) and the button changes to «⏹ Стоп» with a pulsing animation.
- Speaking a phrase such as «иванов с первого по пятый» makes text appear in the textarea **while speaking** (live).
- Pausing and speaking a second phrase puts it on a **new line**.
- Tapping «⏹ Стоп» finalises the text and the button returns to «🎤 Голос».
- Tapping «Обработать» parses the dictated lines without error.

- [ ] **Step 3: Verify the no-permission path**

In Chrome, deny the microphone permission for the site (site settings → Microphone → Block), reload, tap «🎤 Голос». Expected: status shows «❌ Нет доступа к микрофону» and the app stays usable for manual input. Restore the permission afterwards.

---

## Notes for the engineer

- Russian-language UI strings and emoji are intentional — match the existing style in `app.js`.
- The server (`server/server.js`) and `server/parser.js` are **not** touched in this plan. `/api/transcribe` and `HF_TOKEN` stay in place, just unused.
- Commit messages end with the project's standard `Co-Authored-By` trailer if that is the repo convention; follow whatever the recent `git log` shows.
- This repository is **public** — do not add company names, grape varieties, or Excel filenames to any committed file.
