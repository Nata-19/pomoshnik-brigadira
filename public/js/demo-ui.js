function renderDemoBanner(config) {
  if (!config.demoMode) return '';
  return `
    <div class="demo-banner">
      🎯 Это демо. Данные удалятся через сутки. Понравилось — звоните Натали
      <a href="tel:${config.contactPhone}">${config.contactPhone}</a>
    </div>
  `;
}

function renderDemoResetButton() {
  return `
    <button class="demo-reset-btn" onclick="app.resetDemo()">🔄 Начать сначала</button>
  `;
}

window.DemoUI = { renderDemoBanner, renderDemoResetButton };
