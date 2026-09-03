// landing.js
// Logic for the minimal entry page (index.html). Its only job is to open
// the real application (app.html) in a dedicated window - all capture,
// detection, and settings UI lives there, not on this page.

const APP_URL = 'app.html';
const WINDOW_NAME = 'detectionCounterAppWindow';
const WINDOW_FEATURES = 'width=760,height=920,popup=yes';

const launchBtn = document.getElementById('btn-launch-app');
const statusEl = document.getElementById('launch-status');

launchBtn.addEventListener('click', () => {
  // A named window.open() call reuses the same window (and just focuses
  // it) if one is already open, instead of creating a second one - so
  // clicking this repeatedly can't spawn duplicate app windows.
  const appWindow = window.open(APP_URL, WINDOW_NAME, WINDOW_FEATURES);
  if (!appWindow) {
    statusEl.textContent = '専用ウィンドウを開けませんでした。ブラウザのポップアップブロック機能が働いている場合は、このサイトからのポップアップを許可してください。';
    return;
  }
  appWindow.focus();
  statusEl.textContent = '専用ウィンドウでアプリを開きました。このタブは閉じても構いません。';
});
