// ui.js
// Pure-ish DOM rendering. All user-supplied text (target names, units) is
// inserted via textContent, never innerHTML, to avoid XSS from crafted
// filenames or imported JSON.

import { DetectionState } from './state.js';
import { actionLabel, sourceLabel } from './history.js';

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'className') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (key === 'html') { /* intentionally unsupported: use text/textContent for user data */ }
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child == null) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

const STATE_LABELS = {
  [DetectionState.NOT_DETECTED]: '未検出',
  [DetectionState.DETECTION_CANDIDATE]: '検出候補',
  [DetectionState.DETECTED]: '検出中',
  [DetectionState.MISSING_CANDIDATE]: '非検出候補',
};

export function stateLabel(state) {
  return STATE_LABELS[state] || state;
}

// ---- Step indicator ----

export function renderStepIndicator(store) {
  const hasScreen = store.status !== 'noScreen' && store.status !== 'shareEnded';
  const hasTarget = store.targets.length > 0;
  const isCounting = store.counting;

  const steps = [
    { id: 'step-indicator-1', done: hasScreen, active: !hasScreen },
    { id: 'step-indicator-2', done: hasTarget, active: hasScreen && !hasTarget },
    { id: 'step-indicator-3', done: isCounting, active: hasScreen && hasTarget && !isCounting },
  ];
  for (const s of steps) {
    const li = document.getElementById(s.id);
    if (!li) continue;
    li.classList.toggle('done', s.done);
    li.classList.toggle('active', s.active);
  }
}

// ---- Status banner ----

const STATUS_TEXT = {
  noScreen: '画面がまだ選択されていません。',
  loadingOpenCv: '画像処理機能を読み込んでいます...',
  sharing: '画面を共有中です。検出対象を登録してください。',
  registering: '検出対象を登録しています。',
  counting: 'カウントを実行中です。',
  countStopped: 'カウントを停止しています。',
  shareEnded: '画面の共有が終了しました。',
  error: 'エラーが発生しました。',
};

export function renderStatusBanner(store) {
  const banner = document.getElementById('status-banner');
  const text = document.getElementById('status-text');
  text.textContent = store.statusMessage || STATUS_TEXT[store.status] || '';
  banner.classList.remove('status-error', 'status-active');
  if (store.status === 'error') banner.classList.add('status-error');
  if (store.status === 'counting') banner.classList.add('status-active');
}

// ---- Notifications ----

export function showNotification(message) {
  const area = document.getElementById('notification-area');
  const toast = el('div', { className: 'notification-toast', role: 'status' }, [message]);
  area.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

// ---- Target list ----

let targetHandlers = null;
let editingTargetId = null;
const recentlyCountedIds = new Map(); // targetId -> timeoutId, drives the transient flash/bump classes

export function bindTargetListHandlers(handlers) {
  targetHandlers = handlers;
}

export function isEditingTarget() {
  return editingTargetId !== null;
}

function formatTime(ts) {
  if (!ts) return '-';
  return new Date(ts).toLocaleTimeString('ja-JP');
}

function buildTargetCard(target) {
  const flashing = recentlyCountedIds.has(target.id);
  const className = `target-card${target.enabled ? '' : ' disabled'}${flashing ? ' flash' : ''}`;
  const li = el('li', { className, 'data-target-id': target.id });

  const thumb = el('img', { className: 'target-thumb', alt: `${target.name}のサムネイル` });
  if (target.thumbnailUrl) thumb.src = target.thumbnailUrl;

  const main = el('div', { className: 'target-main' });

  if (editingTargetId === target.id) {
    const input = el('input', { type: 'text', value: target.name });
    input.value = target.name;
    const save = el('button', { type: 'button', className: 'btn' }, ['保存']);
    const cancel = el('button', { type: 'button', className: 'btn' }, ['キャンセル']);
    save.addEventListener('click', () => {
      const newName = input.value.trim();
      editingTargetId = null;
      if (newName && targetHandlers) targetHandlers.onRename(target.id, newName);
    });
    cancel.addEventListener('click', () => {
      editingTargetId = null;
      if (targetHandlers) targetHandlers.onRerender();
    });
    main.appendChild(el('div', { className: 'target-name-edit-row' }, [input, save, cancel]));
  } else {
    const nameRow = el('div', { className: 'target-name-row' }, [
      el('span', { className: 'target-name', text: target.name }),
      el('span', { className: `target-count${flashing ? ' bump' : ''}`, text: `${target.count}${target.unit || ''}` }),
    ]);
    main.appendChild(nameRow);
  }

  if (target.templateTooLarge) {
    main.appendChild(el('p', { className: 'target-meta-line' }, ['この検出対象は探索範囲より大きいため、検出できません。範囲を広げるか、対象を再登録してください。']));
  }

  const stateRow = el('div', { className: 'target-meta-line' }, [
    el('span', { className: 'target-state-badge', text: stateLabel(target.detectionState) }),
    ` 現在スコア: ${target.currentScore != null ? target.currentScore.toFixed(2) : '-'}`,
  ]);
  main.appendChild(stateRow);
  main.appendChild(el('p', { className: 'target-meta-line', text: `最終検出: ${formatTime(target.lastDetectedAt)}` }));

  const actions = el('div', { className: 'target-actions' });
  const mkBtn = (label, action, extraClass) => {
    const b = el('button', { type: 'button', className: `btn${extraClass ? ` ${extraClass}` : ''}` }, [label]);
    b.addEventListener('click', () => targetHandlers && targetHandlers[action](target.id));
    return b;
  };
  actions.appendChild(mkBtn('-1', 'onDecrement'));
  actions.appendChild(mkBtn('+1', 'onIncrement'));
  const renameBtn = el('button', { type: 'button', className: 'btn' }, ['名前変更']);
  renameBtn.addEventListener('click', () => {
    editingTargetId = target.id;
    targetHandlers && targetHandlers.onRerender();
  });
  actions.appendChild(renameBtn);
  actions.appendChild(mkBtn(target.enabled ? '無効化' : '有効化', 'onToggleEnabled'));
  actions.appendChild(mkBtn('リセット', 'onResetOne'));
  actions.appendChild(mkBtn('削除', 'onDelete', 'btn-danger'));
  main.appendChild(actions);

  li.appendChild(thumb);
  li.appendChild(main);
  return li;
}

export function renderTargetList(store) {
  const list = document.getElementById('target-list');
  const empty = document.getElementById('target-list-empty');
  list.textContent = '';
  empty.hidden = store.targets.length > 0;
  for (const target of store.targets) {
    list.appendChild(buildTargetCard(target));
  }
}

/**
 * Marks a target as "just counted" so the next render (and any renders that
 * happen to land within the flash window) show the highlight, then clears
 * the flag after 700ms. Tracking this by id - rather than mutating the DOM
 * node directly - keeps the effect correct even though renderTargetList may
 * fully rebuild the list on every analysis tick.
 */
export function flashTargetCard(targetId) {
  if (recentlyCountedIds.has(targetId)) {
    clearTimeout(recentlyCountedIds.get(targetId));
  }
  const timeoutId = setTimeout(() => {
    recentlyCountedIds.delete(targetId);
    const card = document.querySelector(`.target-card[data-target-id="${cssEscape(targetId)}"]`);
    if (card) {
      card.classList.remove('flash');
      const countEl = card.querySelector('.target-count');
      if (countEl) countEl.classList.remove('bump');
    }
  }, 700);
  recentlyCountedIds.set(targetId, timeoutId);

  const card = document.querySelector(`.target-card[data-target-id="${cssEscape(targetId)}"]`);
  if (card) {
    card.classList.add('flash');
    const countEl = card.querySelector('.target-count');
    if (countEl) countEl.classList.add('bump');
  }
}

function cssEscape(str) {
  return String(str).replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
}

// ---- History ----

export function renderHistory(store) {
  const tbody = document.getElementById('history-tbody');
  const empty = document.getElementById('history-empty');
  tbody.textContent = '';
  empty.hidden = store.history.length > 0;
  for (const h of store.history) {
    const tr = el('tr', {}, [
      el('td', { text: new Date(h.timestamp).toLocaleTimeString('ja-JP') }),
      el('td', { text: h.targetName }),
      el('td', { text: actionLabel(h.action) }),
      el('td', { text: sourceLabel(h.source) }),
      el('td', { text: `${h.previousValue} → ${h.newValue}` }),
      el('td', { text: h.score != null ? h.score.toFixed(2) : '-' }),
    ]);
    tbody.appendChild(tr);
  }
}

// ---- Debug panel ----

export function renderDebugInfo(store, debugInfo) {
  const list = document.getElementById('debug-info-list');
  list.textContent = '';
  const addRow = (label, value) => {
    list.appendChild(el('dt', { text: label }));
    list.appendChild(el('dd', { text: value }));
  };
  addRow('解析FPS', String(debugInfo.analysisFps ?? '-'));
  addRow('キャプチャ解像度', debugInfo.captureResolution ? `${debugInfo.captureResolution.width}x${debugInfo.captureResolution.height}` : '-');
  addRow('解析解像度', debugInfo.analysisResolution ? `${debugInfo.analysisResolution.width}x${debugInfo.analysisResolution.height}` : '-');
  addRow('探索範囲(px)', debugInfo.searchRegionPx ? `x:${debugInfo.searchRegionPx.x} y:${debugInfo.searchRegionPx.y} w:${debugInfo.searchRegionPx.width} h:${debugInfo.searchRegionPx.height}` : '-');
  addRow('1フレーム処理時間', `${debugInfo.lastFrameDurationMs ?? '-'} ms`);
  addRow('最終解析時刻', debugInfo.lastAnalysisAt ? new Date(debugInfo.lastAnalysisAt).toLocaleTimeString('ja-JP') : '-');
  if (performance.memory) {
    addRow('JSヒープ使用量', `${Math.round(performance.memory.usedJSHeapSize / 1024 / 1024)} MB`);
  }
  for (const target of store.targets) {
    const d = debugInfo.targets ? debugInfo.targets[target.id] : null;
    addRow(`[${target.name}] 状態`, stateLabel(target.detectionState));
    addRow(`[${target.name}] スコア`, target.currentScore != null ? target.currentScore.toFixed(3) : '-');
    addRow(`[${target.name}] 連続検出/非検出`, `${target.consecutiveDetectedFrames} / ${target.consecutiveMissingFrames}`);
    if (d && d.loc) {
      addRow(`[${target.name}] 最大一致位置`, `x:${d.loc.x} y:${d.loc.y} scale:${d.loc.scale}`);
    }
  }
}

// ---- Confirm / error dialogs ----

export function showConfirmDialog(message) {
  return new Promise((resolve) => {
    const backdrop = document.getElementById('confirm-dialog-backdrop');
    document.getElementById('confirm-dialog-message').textContent = message;
    backdrop.hidden = false;
    const yesBtn = document.getElementById('btn-confirm-yes');
    const noBtn = document.getElementById('btn-confirm-no');
    const cleanup = (result) => {
      backdrop.hidden = true;
      yesBtn.removeEventListener('click', onYes);
      noBtn.removeEventListener('click', onNo);
      resolve(result);
    };
    const onYes = () => cleanup(true);
    const onNo = () => cleanup(false);
    yesBtn.addEventListener('click', onYes);
    noBtn.addEventListener('click', onNo);
    yesBtn.focus();
  });
}

export function showErrorDialog(message, debugText = '') {
  const backdrop = document.getElementById('error-dialog-backdrop');
  document.getElementById('error-dialog-message').textContent = message;
  document.getElementById('error-dialog-debug').textContent = debugText;
  backdrop.hidden = false;
  const closeBtn = document.getElementById('btn-error-close');
  const onClose = () => {
    backdrop.hidden = true;
    closeBtn.removeEventListener('click', onClose);
  };
  closeBtn.addEventListener('click', onClose);
  closeBtn.focus();
}
