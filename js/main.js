// main.js
// Wires together capture, OpenCV template matching, storage, and the DOM.
// This is the only module that touches event listeners on concrete DOM
// elements; state lives in state.js and rendering logic lives in ui.js.

import { store, createTarget, DEFAULT_GLOBAL_SETTINGS } from './state.js';
import { CaptureManager } from './capture.js';
import { loadOpenCv } from './opencvLoader.js';
import { RegionSelector } from './regionSelect.js';
import { DetectionEngine, releaseTargetMats } from './detection.js';
import {
  isIndexedDbAvailable, saveAppState, loadAppState, exportStateToJson, parseImportedJson,
} from './storage.js';
import { createHistoryEntry, historyToJson, historyToCsv, downloadTextFile, actionLabel } from './history.js';
import * as ui from './ui.js';

const MAX_IMAGE_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_IMAGE_EDGE = 4096; // px

let captureManager = null;
let detectionEngine = null;

let videoEl = null;
let previewStage = null;
let overlayCanvas = null;

let cropRegionSelector = null;
let cropRect = null; // native pixel rect within the captured frame

let regionSelectSelector = null;
let regionSelectRatioRect = null; // ratio rect {x,y,width,height} pending confirmation

let lastDebugInfo = null;
let audioCtx = null;

const ERROR_MESSAGES = {
  UNSUPPORTED: 'お使いのブラウザは画面共有に対応していません。Google ChromeまたはMicrosoft Edgeの最新版をご利用ください。',
  PERMISSION_DENIED: '画面の共有が許可されませんでした。もう一度「画面を選択」を押し、共有する画面を選んでください。',
  CAPTURE_FAILED: '選択した画面を取得できませんでした。対象のウィンドウが開いていることを確認し、もう一度「画面を選択」を押してください。',
  SCRIPT_LOAD_FAILED: '画像処理機能(OpenCV.js)を読み込めませんでした。vendorフォルダにファイルが配置されているか確認し、ページを再読み込みしてください。',
  CV_NOT_FOUND: '画像処理機能の初期化に失敗しました。ページを再読み込みしてください。',
  WASM_INIT_FAILED: '画像処理機能の初期化に失敗しました。ブラウザを最新版に更新し、再読み込みしてください。',
  TIMEOUT: '画像処理機能の読み込みが時間内に完了しませんでした。ネットワークやファイルの配置を確認し、再読み込みしてください。',
  INDEXEDDB_UNAVAILABLE: 'このブラウザでは設定の保存機能が利用できません。プライベートブラウジングモードなどをご利用の場合は解除してください。',
  INDEXEDDB_OPEN_FAILED: '保存領域を開けませんでした。ブラウザの設定をご確認ください。',
  INDEXEDDB_WRITE_FAILED: '設定の保存に失敗しました。',
  INDEXEDDB_READ_FAILED: '保存された設定の読み込みに失敗しました。',
  INVALID_JSON: '選択したファイルはJSON形式として読み込めませんでした。書き出したファイルをそのまま選択してください。',
  INVALID_SCHEMA: '選択したファイルは想定した設定ファイルの形式と異なります。',
  INVALID_IMAGE_DATA: 'ファイル内の画像データを読み込めませんでした。',
};

function friendlyErrorMessage(err) {
  if (err && err.code && ERROR_MESSAGES[err.code]) return ERROR_MESSAGES[err.code];
  return (err && err.message) || '不明なエラーが発生しました。';
}

function debugText(err) {
  return String((err && (err.stack || err.cause)) || err || '');
}

// ---- persistence ----

let persistTimer = null;
function persist() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(async () => {
    try {
      await saveAppState(store);
    } catch (e) {
      // Non-fatal: counting/registration can continue even if a save fails.
      console.error('save failed', e);
    }
  }, 300);
}

function sanitizeGlobalSettings(raw) {
  const out = {};
  for (const key of Object.keys(DEFAULT_GLOBAL_SETTINGS)) {
    if (raw && key in raw) out[key] = raw[key];
  }
  return out;
}

// ---- rendering ----

function renderAll() {
  ui.renderStepIndicator(store);
  ui.renderStatusBanner(store);
  ui.renderTargetList(store);
  ui.renderHistory(store);
  updateUndoButtonState();
  updateCountingButtonState();
  drawMainOverlay();
}

function updateUndoButtonState() {
  document.getElementById('btn-undo').disabled = store.history.length === 0;
}

function updateCountingButtonState() {
  const canCount = !!(captureManager && captureManager.isActive()) && store.targets.length > 0 && !!detectionEngine;
  const startBtn = document.getElementById('btn-start-counting');
  if (!store.counting) startBtn.disabled = !canCount;
}

function reflectSettingsIntoForm() {
  const g = store.globalSettings;
  document.getElementById('setting-enter-threshold').value = g.enterThreshold;
  document.getElementById('enter-threshold-value').textContent = g.enterThreshold.toFixed(2);
  document.getElementById('setting-exit-threshold').value = g.exitThreshold;
  document.getElementById('exit-threshold-value').textContent = g.exitThreshold.toFixed(2);
  document.getElementById('setting-cooldown').value = g.cooldownMs;
  document.getElementById('setting-analysis-fps').value = String(g.analysisFps);
  document.getElementById('setting-enter-frames').value = g.enterFrameCount;
  document.getElementById('setting-exit-frames').value = g.exitFrameCount;
  document.getElementById('setting-downscale').value = String(g.downscale);
  document.getElementById('setting-grayscale').checked = g.grayscale;
  document.getElementById('setting-multiscale').value = g.multiScale;
  document.getElementById('setting-debug').checked = g.debug;
  document.getElementById('debug-panel').hidden = !g.debug;
  document.getElementById('setting-sound').checked = g.sound;
  document.getElementById('setting-min-template-size').value = g.minTemplateSize;
  document.getElementById('setting-max-template-count').value = g.maxTemplateCount;
}

function updateRegionInfoText() {
  const info = document.getElementById('region-info');
  if (store.searchRegion.mode !== 'custom' || !store.searchRegion.rect) {
    info.textContent = '現在の探索範囲: 画面全体';
    return;
  }
  const r = store.searchRegion.rect;
  let pixelText = '';
  if (store.captureResolution) {
    const w = Math.round(r.width * store.captureResolution.width);
    const h = Math.round(r.height * store.captureResolution.height);
    pixelText = `（約 ${w}x${h}px 相当）`;
  }
  info.textContent = `現在の探索範囲: 幅${Math.round(r.width * 100)}% 高さ${Math.round(r.height * 100)}% ${pixelText}`;
}

// ---- overlay drawing on the live preview ----

function sizeOverlayToStage() {
  if (!overlayCanvas || !previewStage) return;
  const box = previewStage.getBoundingClientRect();
  overlayCanvas.width = Math.max(1, Math.round(box.width));
  overlayCanvas.height = Math.max(1, Math.round(box.height));
}

function drawMainOverlay() {
  if (!overlayCanvas) return;
  const ctx = overlayCanvas.getContext('2d');
  ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);

  if (store.searchRegionVisible && store.searchRegion.mode === 'custom' && store.searchRegion.rect) {
    const r = store.searchRegion.rect;
    const x = r.x * overlayCanvas.width;
    const y = r.y * overlayCanvas.height;
    const w = r.width * overlayCanvas.width;
    const h = r.height * overlayCanvas.height;
    ctx.strokeStyle = '#15803d';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);
    ctx.fillStyle = '#15803d';
    ctx.font = '12px sans-serif';
    ctx.fillText('探索範囲', x + 4, Math.max(12, y - 4));
  }

  if (store.globalSettings.debug && lastDebugInfo && lastDebugInfo.analysisResolution) {
    const scaleX = overlayCanvas.width / lastDebugInfo.analysisResolution.width;
    const scaleY = overlayCanvas.height / lastDebugInfo.analysisResolution.height;
    for (const target of store.targets) {
      const d = lastDebugInfo.targets ? lastDebugInfo.targets[target.id] : null;
      if (d && d.loc && target.detectionState !== 'notDetected') {
        const tw = (target.runtime.matWidth || 20) * scaleX;
        const th = (target.runtime.matHeight || 20) * scaleY;
        ctx.strokeStyle = '#b91c1c';
        ctx.lineWidth = 2;
        ctx.strokeRect(d.loc.x * scaleX, d.loc.y * scaleY, tw, th);
        ctx.fillStyle = '#b91c1c';
        ctx.font = '12px sans-serif';
        ctx.fillText(target.name, d.loc.x * scaleX, Math.max(12, d.loc.y * scaleY - 4));
      }
    }
  }
}

// ---- capture flow ----

async function startOrChangeCapture() {
  const wasCounting = store.counting;
  try {
    await captureManager.start();
  } catch (e) {
    ui.showErrorDialog(friendlyErrorMessage(e), debugText(e));
    return;
  }
  if (wasCounting && detectionEngine) {
    detectionEngine.stop();
    detectionEngine.invalidate();
  }

  store.captureResolution = captureManager.getResolution();
  videoEl.play().catch(() => {});
  sizeOverlayToStage();

  document.getElementById('btn-start-capture').hidden = true;
  document.getElementById('btn-change-capture').hidden = false;
  document.getElementById('btn-stop-capture').hidden = false;
  document.getElementById('preview-wrapper').hidden = false;
  document.getElementById('btn-crop-from-capture').disabled = false;
  document.getElementById('btn-select-region').disabled = !document.getElementById('region-mode-custom').checked;
  updatePreviewResolutionText();
  updateRegionInfoText();

  detectionEngine && detectionEngine.setVideoElement(videoEl);
  store.setStatus('sharing');
  updateCountingButtonState();

  if (wasCounting && detectionEngine) {
    store.counting = true;
    detectionEngine.start();
    document.getElementById('btn-start-counting').hidden = true;
    document.getElementById('btn-stop-counting').hidden = false;
    store.setStatus('counting');
  }
  persist();
}

function updatePreviewResolutionText() {
  const r = store.captureResolution;
  document.getElementById('preview-resolution').textContent = r ? `解像度: ${r.width}x${r.height}` : '解像度: -';
}

function stopCapture(statusMessage) {
  if (store.counting) {
    store.counting = false;
    if (detectionEngine) detectionEngine.stop();
    document.getElementById('btn-start-counting').hidden = false;
    document.getElementById('btn-stop-counting').hidden = true;
  }
  captureManager.stop();
  document.getElementById('btn-start-capture').hidden = false;
  document.getElementById('btn-change-capture').hidden = true;
  document.getElementById('btn-stop-capture').hidden = true;
  document.getElementById('preview-wrapper').hidden = true;
  document.getElementById('btn-crop-from-capture').disabled = true;
  document.getElementById('crop-hint').textContent = '画面を選択すると利用できます。';
  document.getElementById('btn-select-region').disabled = true;
  store.captureResolution = null;
  store.setStatus('shareEnded', statusMessage);
  updateCountingButtonState();
}

// ---- crop-from-capture flow ----

function openCropDialog() {
  if (!captureManager.isActive()) return;
  if (!document.getElementById('crop-dialog-backdrop').hidden) return; // already open
  videoEl.pause();

  const frameCanvas = document.getElementById('crop-frame-canvas');
  const nativeW = videoEl.videoWidth;
  const nativeH = videoEl.videoHeight;
  frameCanvas.width = nativeW;
  frameCanvas.height = nativeH;
  frameCanvas.getContext('2d').drawImage(videoEl, 0, 0, nativeW, nativeH);

  document.getElementById('crop-dialog-backdrop').hidden = false;
  document.getElementById('crop-preview-row').hidden = true;
  document.getElementById('btn-crop-add').disabled = true;
  document.getElementById('btn-crop-reselect').hidden = true;
  document.getElementById('crop-size-info').textContent = '範囲を選択してください。';
  document.getElementById('crop-target-name').value = `検出対象${store.targets.length + 1}`;
  cropRect = null;

  requestAnimationFrame(() => {
    const overlay = document.getElementById('crop-overlay-canvas');
    const box = overlay.getBoundingClientRect();
    overlay.width = Math.max(1, Math.round(box.width));
    overlay.height = Math.max(1, Math.round(box.height));

    cropRegionSelector = new RegionSelector(overlay, {
      onChange: (rect, final) => {
        drawCropOverlay(rect);
        if (final && rect) {
          commitCropSelection();
        } else if (!rect) {
          document.getElementById('crop-preview-row').hidden = true;
          document.getElementById('btn-crop-add').disabled = true;
        }
      },
    });
  });
}

function drawCropOverlay(rect) {
  const overlay = document.getElementById('crop-overlay-canvas');
  const ctx = overlay.getContext('2d');
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  if (!rect) return;
  ctx.strokeStyle = '#2563eb';
  ctx.fillStyle = 'rgba(37, 99, 235, 0.15)';
  ctx.lineWidth = 2;
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
}

function commitCropSelection() {
  const frameCanvas = document.getElementById('crop-frame-canvas');
  const ratio = cropRegionSelector.getRatioRect();
  if (!ratio) return;
  const x = Math.round(ratio.x * frameCanvas.width);
  const y = Math.round(ratio.y * frameCanvas.height);
  const w = Math.round(ratio.width * frameCanvas.width);
  const h = Math.round(ratio.height * frameCanvas.height);
  cropRect = { x, y, width: w, height: h };

  const sizeInfo = document.getElementById('crop-size-info');
  const addBtn = document.getElementById('btn-crop-add');
  const minSize = store.globalSettings.minTemplateSize;
  if (w < minSize || h < minSize) {
    sizeInfo.textContent = `選択範囲: 幅${w}px 高さ${h}px (最低${minSize}px以上を選択してください)`;
    addBtn.disabled = true;
  } else {
    sizeInfo.textContent = `選択範囲: 幅${w}px 高さ${h}px`;
    addBtn.disabled = false;
  }

  const thumbCanvas = document.getElementById('crop-thumb-canvas');
  const thumbSize = 160;
  const scale = Math.min(thumbSize / w, thumbSize / h, 1);
  thumbCanvas.width = Math.max(1, Math.round(w * scale));
  thumbCanvas.height = Math.max(1, Math.round(h * scale));
  thumbCanvas.getContext('2d').drawImage(frameCanvas, x, y, w, h, 0, 0, thumbCanvas.width, thumbCanvas.height);

  document.getElementById('crop-preview-row').hidden = false;
  document.getElementById('btn-crop-reselect').hidden = false;
}

function closeCropDialog(resume) {
  document.getElementById('crop-dialog-backdrop').hidden = true;
  if (cropRegionSelector) {
    cropRegionSelector.destroy();
    cropRegionSelector = null;
  }
  cropRect = null;
  if (resume && captureManager.isActive()) videoEl.play().catch(() => {});
}

async function addCropTarget() {
  if (!cropRect) return;
  if (store.targets.length >= store.globalSettings.maxTemplateCount) {
    ui.showErrorDialog(`検出対象は最大${store.globalSettings.maxTemplateCount}個までです。詳細設定から上限を変更するか、不要な対象を削除してください。`);
    return;
  }
  const frameCanvas = document.getElementById('crop-frame-canvas');
  const cutCanvas = document.createElement('canvas');
  cutCanvas.width = cropRect.width;
  cutCanvas.height = cropRect.height;
  cutCanvas.getContext('2d').drawImage(
    frameCanvas, cropRect.x, cropRect.y, cropRect.width, cropRect.height, 0, 0, cropRect.width, cropRect.height,
  );

  const blob = await new Promise((resolve) => cutCanvas.toBlob(resolve, 'image/png'));
  if (!blob) {
    ui.showErrorDialog('検出対象の画像を作成できませんでした。もう一度お試しください。');
    return;
  }
  const name = document.getElementById('crop-target-name').value.trim() || `検出対象${store.targets.length + 1}`;
  const target = createTarget({
    name,
    imageBlob: blob,
    sourceType: 'capture',
    originalWidth: cropRect.width,
    originalHeight: cropRect.height,
  });
  target.thumbnailUrl = URL.createObjectURL(blob);
  store.addTarget(target);
  persist();
  closeCropDialog(true);
}

// ---- file registration flow ----

function addFileError(message) {
  const li = document.createElement('li');
  li.textContent = message;
  document.getElementById('file-errors').appendChild(li);
}

async function handleFileInput(e) {
  const files = Array.from(e.target.files || []);
  document.getElementById('file-errors').textContent = '';

  for (const file of files) {
    if (store.targets.length >= store.globalSettings.maxTemplateCount) {
      addFileError(`検出対象の上限(${store.globalSettings.maxTemplateCount}個)に達したため、「${file.name}」以降は追加されませんでした。`);
      break;
    }
    if (!file.type || !file.type.startsWith('image/') || file.type === 'image/svg+xml') {
      addFileError(`「${file.name}」は対応していない形式のため読み込めませんでした。`);
      continue;
    }
    if (file.size > MAX_IMAGE_FILE_SIZE) {
      addFileError(`「${file.name}」はサイズが大きすぎます（上限10MB）。`);
      continue;
    }

    let bitmap;
    try {
      bitmap = await createImageBitmap(file);
    } catch (err) {
      addFileError(`「${file.name}」を画像として読み込めませんでした。ファイルが壊れている可能性があります。`);
      continue;
    }
    const { width, height } = bitmap;
    if (width > MAX_IMAGE_EDGE || height > MAX_IMAGE_EDGE) {
      addFileError(`「${file.name}」は画像サイズが大きすぎます（最大辺${MAX_IMAGE_EDGE}px）。`);
      bitmap.close();
      continue;
    }
    if (width < store.globalSettings.minTemplateSize || height < store.globalSettings.minTemplateSize) {
      addFileError(`「${file.name}」は小さすぎるため、検出精度が低くなる可能性があります。登録はされました。`);
    }
    bitmap.close();

    const name = file.name.replace(/\.[^./\\]+$/, '') || `検出対象${store.targets.length + 1}`;
    const target = createTarget({
      name, imageBlob: file, sourceType: 'file', originalWidth: width, originalHeight: height,
    });
    target.thumbnailUrl = URL.createObjectURL(file);
    store.addTarget(target);
  }
  persist();
  e.target.value = '';
}

// ---- search region selection ----
//
// Selection happens in a modal dialog against a frozen snapshot, the same
// pattern as the target-crop dialog, rather than on the live preview
// in-place. Users initially tried dragging on the *shared* window itself
// (mistaking it for the interactive surface) because the inline preview can
// be scrolled out of view by the time they reach this control, and "screen"
// wording is ambiguous. A modal removes that ambiguity: it is always in
// view and unmistakably shows a still image to drag on.

function openRegionSelectDialog() {
  if (!captureManager.isActive()) return;
  if (!document.getElementById('region-select-dialog-backdrop').hidden) return; // already open
  videoEl.pause();

  const frameCanvas = document.getElementById('region-select-frame-canvas');
  const nativeW = videoEl.videoWidth;
  const nativeH = videoEl.videoHeight;
  frameCanvas.width = nativeW;
  frameCanvas.height = nativeH;
  frameCanvas.getContext('2d').drawImage(videoEl, 0, 0, nativeW, nativeH);

  document.getElementById('region-select-dialog-backdrop').hidden = false;
  document.getElementById('btn-region-select-confirm').disabled = true;
  document.getElementById('btn-region-select-reselect').hidden = true;
  document.getElementById('region-select-size-info').textContent = '範囲を選択してください。';
  regionSelectRatioRect = null;

  requestAnimationFrame(() => {
    const overlay = document.getElementById('region-select-overlay-canvas');
    const box = overlay.getBoundingClientRect();
    overlay.width = Math.max(1, Math.round(box.width));
    overlay.height = Math.max(1, Math.round(box.height));

    regionSelectSelector = new RegionSelector(overlay, {
      onChange: (rect, final) => {
        drawRegionSelectOverlay(rect);
        if (final) commitRegionSelectDrag();
      },
    });
  });
}

function drawRegionSelectOverlay(rect) {
  const overlay = document.getElementById('region-select-overlay-canvas');
  const ctx = overlay.getContext('2d');
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  if (!rect) return;
  ctx.strokeStyle = '#2563eb';
  ctx.fillStyle = 'rgba(37, 99, 235, 0.15)';
  ctx.lineWidth = 2;
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
}

function commitRegionSelectDrag() {
  const ratio = regionSelectSelector.getRatioRect();
  const sizeInfo = document.getElementById('region-select-size-info');
  const confirmBtn = document.getElementById('btn-region-select-confirm');
  const reselectBtn = document.getElementById('btn-region-select-reselect');
  if (!ratio) {
    regionSelectRatioRect = null;
    sizeInfo.textContent = '範囲を選択してください。';
    confirmBtn.disabled = true;
    reselectBtn.hidden = true;
    return;
  }
  regionSelectRatioRect = ratio;
  const frameCanvas = document.getElementById('region-select-frame-canvas');
  const w = Math.round(ratio.width * frameCanvas.width);
  const h = Math.round(ratio.height * frameCanvas.height);
  sizeInfo.textContent = `選択範囲: 幅${w}px 高さ${h}px (画面全体の${Math.round(ratio.width * 100)}% x ${Math.round(ratio.height * 100)}%)`;
  confirmBtn.disabled = false;
  reselectBtn.hidden = false;
}

function closeRegionSelectDialog(resume) {
  document.getElementById('region-select-dialog-backdrop').hidden = true;
  if (regionSelectSelector) {
    regionSelectSelector.destroy();
    regionSelectSelector = null;
  }
  regionSelectRatioRect = null;
  if (resume && captureManager.isActive()) videoEl.play().catch(() => {});
}

function confirmRegionSelection() {
  if (!regionSelectRatioRect) return;
  store.searchRegion = { mode: 'custom', rect: regionSelectRatioRect };
  updateRegionInfoText();
  persist();
  drawMainOverlay();
  closeRegionSelectDialog(true);
}

// ---- manual count adjustments ----

function manualAdjust(targetId, delta) {
  const target = store.getTarget(targetId);
  if (!target) return;
  const previousValue = target.count;
  const newValue = Math.max(0, previousValue + delta);
  if (newValue === previousValue) return;
  target.count = newValue;
  store.addHistoryEntry(createHistoryEntry({
    targetId, targetName: target.name, action: delta > 0 ? 'increment' : 'decrement', source: 'manual', previousValue, newValue,
  }));
  store.emit('targets');
  persist();
}

/** Sets a target's count to an exact value (e.g. from the compact view's text input). */
function setTargetCount(targetId, newValue) {
  const target = store.getTarget(targetId);
  if (!target || !Number.isFinite(newValue)) return;
  const previousValue = target.count;
  const clamped = Math.max(0, Math.floor(newValue));
  if (clamped === previousValue) return;
  target.count = clamped;
  store.addHistoryEntry(createHistoryEntry({
    targetId,
    targetName: target.name,
    action: clamped > previousValue ? 'increment' : 'decrement',
    source: 'manual',
    previousValue,
    newValue: clamped,
    reason: '直接入力で変更',
  }));
  store.emit('targets');
  persist();
}

function undoLast() {
  const last = store.history[0];
  if (!last) return;
  const target = store.getTarget(last.targetId);
  if (!target) return;
  target.count = last.previousValue;
  store.addHistoryEntry(createHistoryEntry({
    targetId: target.id,
    targetName: target.name,
    action: 'undo',
    source: 'manual',
    previousValue: last.newValue,
    newValue: last.previousValue,
    reason: `${actionLabel(last.action)}(${last.source === 'auto' ? '自動検出' : '手動操作'})を取り消し`,
  }));
  store.emit('targets');
  persist();
}

async function resetOneTarget(targetId) {
  const target = store.getTarget(targetId);
  if (!target) return;
  const ok = await ui.showConfirmDialog(`「${target.name}」のカウントをリセットします。よろしいですか？`);
  if (!ok) return;
  const previousValue = target.count;
  target.count = 0;
  target.detectionState = 'notDetected';
  target.consecutiveDetectedFrames = 0;
  target.consecutiveMissingFrames = 0;
  target.lastCountedAt = null;
  store.addHistoryEntry(createHistoryEntry({
    targetId, targetName: target.name, action: 'reset', source: 'manual', previousValue, newValue: 0,
  }));
  store.emit('targets');
  persist();
}

async function deleteTarget(targetId) {
  const target = store.getTarget(targetId);
  if (!target) return;
  const ok = await ui.showConfirmDialog(`「${target.name}」を削除します。よろしいですか？`);
  if (!ok) return;
  if (detectionEngine) detectionEngine.invalidate();
  releaseTargetMats(target);
  if (target.thumbnailUrl) URL.revokeObjectURL(target.thumbnailUrl);
  store.removeTarget(targetId);
  persist();
}

function toggleTargetEnabled(targetId) {
  const target = store.getTarget(targetId);
  if (!target) return;
  target.enabled = !target.enabled;
  if (!target.enabled) {
    target.detectionState = 'notDetected';
    target.consecutiveDetectedFrames = 0;
    target.consecutiveMissingFrames = 0;
  }
  store.emit('targets');
  persist();
}

function moveTarget(targetId, direction) {
  store.moveEnabledTarget(targetId, direction);
  persist();
}

function renameTarget(targetId, newName) {
  const target = store.getTarget(targetId);
  if (!target) return;
  target.name = newName;
  store.emit('targets');
  persist();
}

// ---- detection engine callbacks ----

function playDetectionSound() {
  if (!store.globalSettings.sound) return;
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.frequency.value = 880;
    gain.gain.value = 0.15;
    osc.connect(gain).connect(audioCtx.destination);
    osc.start();
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.2);
    osc.stop(audioCtx.currentTime + 0.2);
  } catch (e) {
    // Sound is a non-essential nicety; ignore failures (e.g. autoplay policy).
  }
}

function handleDetectionEvent(target, score) {
  store.addHistoryEntry(createHistoryEntry({
    targetId: target.id, targetName: target.name, action: 'increment', source: 'auto', previousValue: target.count - 1, newValue: target.count, score,
  }));
  ui.showNotification(`「${target.name}」を検出しました カウント: ${target.count}${target.unit || ''}`);
  ui.flashTargetCard(target.id);
  playDetectionSound();
  persist();
}

function handleFrameAnalyzed(debugInfo) {
  lastDebugInfo = debugInfo;
  if (store.globalSettings.debug) {
    ui.renderDebugInfo(store, debugInfo);
    drawMainOverlay();
  }
}

// ---- compact view ----
//
// app.html holds two mutually-exclusive sections, #full-view-root (the
// normal setup/settings UI) and #compact-view (just a live count readout).
// Toggling their `hidden` property switches which one is shown, and resizes
// this same window - there is only ever one window, so the capture stream
// and all app state are completely undisturbed by the switch. (This uses
// `hidden` directly rather than a body class + display rule, since a class
// -based rule would be overridden by the global `[hidden] { display: none
// !important }` rule elsewhere in style.css.)

const COMPACT_SIZE = { width: 300, height: 380 };
const FULL_SIZE = { width: 760, height: 920 };

// While the user is typing in a compact-view count input, renderCompactResults()
// is skipped (see the 'targets' listener in bindStaticEventListeners) so an
// in-progress edit isn't wiped out by a detection tick rebuilding the list -
// the same guard the full target list uses for inline rename editing.
let compactEditingTargetId = null;

function isCompactMode() {
  return !document.getElementById('compact-view').hidden;
}

function renderCompactResults() {
  const root = document.getElementById('compact-results-list');
  if (!root) return;
  root.textContent = '';
  const enabledTargets = store.targets.filter((t) => t.enabled);
  if (enabledTargets.length === 0) {
    const p = document.createElement('p');
    p.className = 'empty-state';
    p.textContent = '有効な検出対象がありません。';
    root.appendChild(p);
    return;
  }
  enabledTargets.forEach((target, index) => {
    root.appendChild(buildCompactResultRow(target, index, enabledTargets.length));
  });
}

function buildCompactResultRow(target, index, total) {
  const row = document.createElement('div');
  row.className = 'compact-result-row';

  const nameRow = document.createElement('div');
  nameRow.className = 'compact-name-row';

  const name = document.createElement('span');
  name.className = 'compact-result-name';
  name.textContent = target.name;
  nameRow.appendChild(name);

  const moveControls = document.createElement('div');
  moveControls.className = 'compact-move-controls';
  const upBtn = document.createElement('button');
  upBtn.type = 'button';
  upBtn.className = 'btn compact-move-btn';
  upBtn.textContent = '▲';
  upBtn.setAttribute('aria-label', `${target.name}を上へ移動`);
  upBtn.disabled = index === 0;
  upBtn.addEventListener('click', () => moveTarget(target.id, -1));
  const downBtn = document.createElement('button');
  downBtn.type = 'button';
  downBtn.className = 'btn compact-move-btn';
  downBtn.textContent = '▼';
  downBtn.setAttribute('aria-label', `${target.name}を下へ移動`);
  downBtn.disabled = index === total - 1;
  downBtn.addEventListener('click', () => moveTarget(target.id, 1));
  moveControls.appendChild(upBtn);
  moveControls.appendChild(downBtn);
  nameRow.appendChild(moveControls);
  row.appendChild(nameRow);

  const controls = document.createElement('div');
  controls.className = 'compact-count-controls';

  const minusBtn = document.createElement('button');
  minusBtn.type = 'button';
  minusBtn.className = 'btn compact-count-btn';
  minusBtn.textContent = '-1';
  minusBtn.addEventListener('click', () => manualAdjust(target.id, -1));

  const input = document.createElement('input');
  input.type = 'number';
  input.className = 'compact-count-input';
  input.min = '0';
  input.step = '1';
  input.value = String(target.count);
  input.setAttribute('aria-label', `${target.name} のカウント`);
  input.addEventListener('focus', () => {
    compactEditingTargetId = target.id;
  });
  input.addEventListener('blur', () => {
    compactEditingTargetId = null;
    const parsed = parseInt(input.value, 10);
    if (Number.isFinite(parsed)) {
      setTargetCount(target.id, parsed);
    } else {
      input.value = String(target.count); // revert invalid/empty input
    }
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      input.blur(); // commits via the blur handler above
    } else if (e.key === 'Escape') {
      input.value = String(target.count);
      input.blur();
    }
  });

  const plusBtn = document.createElement('button');
  plusBtn.type = 'button';
  plusBtn.className = 'btn compact-count-btn';
  plusBtn.textContent = '+1';
  plusBtn.addEventListener('click', () => manualAdjust(target.id, 1));

  controls.appendChild(minusBtn);
  controls.appendChild(input);
  controls.appendChild(plusBtn);
  row.appendChild(controls);

  return row;
}

function updateCompactStatus() {
  const el = document.getElementById('compact-status');
  const mainStatusEl = document.getElementById('status-text');
  if (!el || !mainStatusEl) return;
  // Mirror the main status banner's text (already computed by
  // ui.renderStatusBanner, which runs before this) instead of recomputing
  // it, so the two never drift out of sync.
  el.textContent = mainStatusEl.textContent;
}

function resizeWindowBestEffort(width, height) {
  try {
    window.resizeTo(width, height);
  } catch (e) {
    // Some browsers refuse programmatic resize; the layout below still
    // adapts to whatever size the window actually ends up at.
  }
}

function enterCompactMode() {
  if (isCompactMode()) return;
  document.getElementById('full-view-root').hidden = true;
  document.getElementById('compact-view').hidden = false;
  renderCompactResults();
  updateCompactStatus();
  resizeWindowBestEffort(COMPACT_SIZE.width, COMPACT_SIZE.height);
}

function exitCompactMode() {
  if (!isCompactMode()) return;
  document.getElementById('compact-view').hidden = true;
  document.getElementById('full-view-root').hidden = false;
  resizeWindowBestEffort(FULL_SIZE.width, FULL_SIZE.height);
}

// ---- bootstrap ----

function checkBrowserSupport() {
  const warning = document.getElementById('browser-warning');
  const messages = [];
  if (!CaptureManager.isSupported()) {
    messages.push('お使いのブラウザは画面共有に対応していないため、このアプリを利用できません。Google ChromeまたはMicrosoft Edgeの最新版でお試しください。');
    document.getElementById('btn-start-capture').disabled = true;
  } else {
    const ua = navigator.userAgent;
    const isChromium = /Chrome|Chromium|Edg\//.test(ua) && !/Firefox|OPR/.test(ua);
    if (!isChromium) {
      messages.push('このブラウザでは一部の機能が利用できない可能性があります。Google ChromeまたはMicrosoft Edgeの最新版を推奨します。');
    }
  }
  if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
    messages.push('画面共有にはHTTPS環境が必要です。');
  }
  if (messages.length) {
    warning.hidden = false;
    warning.textContent = messages.join(' ');
  }
}

function bindStaticEventListeners() {
  document.getElementById('btn-start-capture').addEventListener('click', startOrChangeCapture);
  document.getElementById('btn-change-capture').addEventListener('click', startOrChangeCapture);
  document.getElementById('btn-stop-capture').addEventListener('click', () => stopCapture('画面共有を停止しました。'));

  document.getElementById('btn-crop-from-capture').addEventListener('click', openCropDialog);
  document.getElementById('btn-crop-cancel').addEventListener('click', () => closeCropDialog(true));
  document.getElementById('btn-crop-reselect').addEventListener('click', () => {
    if (cropRegionSelector) cropRegionSelector.reset();
    document.getElementById('crop-preview-row').hidden = true;
    document.getElementById('btn-crop-add').disabled = true;
    document.getElementById('btn-crop-reselect').hidden = true;
  });
  document.getElementById('btn-crop-add').addEventListener('click', addCropTarget);

  document.getElementById('file-input').addEventListener('change', handleFileInput);

  document.getElementById('region-mode-full').addEventListener('change', () => {
    store.searchRegion.mode = 'full';
    document.getElementById('btn-select-region').disabled = true;
    updateRegionInfoText();
    persist();
    drawMainOverlay();
  });
  document.getElementById('region-mode-custom').addEventListener('change', () => {
    document.getElementById('btn-select-region').disabled = !captureManager.isActive();
    if (store.searchRegion.rect) store.searchRegion.mode = 'custom';
    updateRegionInfoText();
  });
  document.getElementById('btn-select-region').addEventListener('click', openRegionSelectDialog);
  document.getElementById('btn-region-select-cancel').addEventListener('click', () => closeRegionSelectDialog(true));
  document.getElementById('btn-region-select-reselect').addEventListener('click', () => {
    if (regionSelectSelector) regionSelectSelector.reset();
    document.getElementById('region-select-size-info').textContent = '範囲を選択してください。';
    document.getElementById('btn-region-select-confirm').disabled = true;
    document.getElementById('btn-region-select-reselect').hidden = true;
  });
  document.getElementById('btn-region-select-confirm').addEventListener('click', confirmRegionSelection);
  document.getElementById('btn-reset-region').addEventListener('click', () => {
    store.searchRegion = { mode: 'full', rect: null };
    document.getElementById('region-mode-full').checked = true;
    document.getElementById('btn-select-region').disabled = true;
    updateRegionInfoText();
    persist();
    drawMainOverlay();
  });
  document.getElementById('toggle-region-visible').addEventListener('change', (e) => {
    store.searchRegionVisible = e.target.checked;
    persist();
    drawMainOverlay();
  });

  document.getElementById('btn-start-counting').addEventListener('click', () => {
    if (!captureManager.isActive() || !detectionEngine) return;
    store.counting = true;
    detectionEngine.setVideoElement(videoEl);
    detectionEngine.start();
    document.getElementById('btn-start-counting').hidden = true;
    document.getElementById('btn-stop-counting').hidden = false;
    store.setStatus('counting');
    enterCompactMode();
  });
  document.getElementById('btn-stop-counting').addEventListener('click', () => {
    store.counting = false;
    if (detectionEngine) detectionEngine.stop();
    document.getElementById('btn-start-counting').hidden = false;
    document.getElementById('btn-stop-counting').hidden = true;
    store.setStatus('countStopped');
  });
  document.getElementById('btn-undo').addEventListener('click', undoLast);
  document.getElementById('btn-reset-all').addEventListener('click', async () => {
    const ok = await ui.showConfirmDialog('すべての検出対象のカウントをリセットします。よろしいですか？');
    if (!ok) return;
    for (const target of store.targets) {
      if (target.count === 0) continue;
      store.addHistoryEntry(createHistoryEntry({
        targetId: target.id, targetName: target.name, action: 'reset', source: 'manual', previousValue: target.count, newValue: 0,
      }));
      target.count = 0;
      target.detectionState = 'notDetected';
      target.consecutiveDetectedFrames = 0;
      target.consecutiveMissingFrames = 0;
      target.lastCountedAt = null;
    }
    store.emit('targets');
    persist();
  });

  document.getElementById('btn-toggle-history').addEventListener('click', (e) => {
    const body = document.getElementById('history-body');
    const btn = e.currentTarget;
    const expanded = btn.getAttribute('aria-expanded') === 'true';
    btn.setAttribute('aria-expanded', String(!expanded));
    body.hidden = expanded;
    btn.textContent = expanded ? 'カウント履歴を表示' : 'カウント履歴を非表示';
  });
  document.getElementById('btn-clear-history').addEventListener('click', async () => {
    const ok = await ui.showConfirmDialog('履歴をすべて削除します。よろしいですか？');
    if (!ok) return;
    store.clearHistory();
    persist();
  });
  document.getElementById('btn-export-json').addEventListener('click', () => {
    downloadTextFile(`count-history-${Date.now()}.json`, historyToJson(store.history), 'application/json');
  });
  document.getElementById('btn-export-csv').addEventListener('click', () => {
    downloadTextFile(`count-history-${Date.now()}.csv`, historyToCsv(store.history), 'text/csv');
  });

  document.getElementById('btn-export-settings').addEventListener('click', async () => {
    try {
      const json = await exportStateToJson(store);
      downloadTextFile(`detection-counter-settings-${Date.now()}.json`, json, 'application/json');
      document.getElementById('save-status').textContent = '設定を書き出しました。';
    } catch (e) {
      ui.showErrorDialog('設定の書き出しに失敗しました。', debugText(e));
    }
  });
  document.getElementById('import-settings-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = parseImportedJson(text);
      for (const t of store.targets) {
        releaseTargetMats(t);
        if (t.thumbnailUrl) URL.revokeObjectURL(t.thumbnailUrl);
      }
      if (detectionEngine) detectionEngine.invalidate();
      if (parsed.globalSettings) {
        store.globalSettings = { ...store.globalSettings, ...sanitizeGlobalSettings(parsed.globalSettings) };
      }
      if (parsed.searchRegion) store.searchRegion = parsed.searchRegion;
      if (typeof parsed.searchRegionVisible === 'boolean') store.searchRegionVisible = parsed.searchRegionVisible;
      const targets = parsed.targets.map((t) => {
        const target = createTarget(t);
        target.thumbnailUrl = URL.createObjectURL(t.imageBlob);
        return target;
      });
      store.replaceTargets(targets);
      store.replaceHistory(parsed.history);
      reflectSettingsIntoForm();
      updateRegionInfoText();
      document.getElementById('save-status').textContent = '設定を読み込みました。';
      persist();
    } catch (err) {
      ui.showErrorDialog(friendlyErrorMessage(err), debugText(err));
    }
  });

  const enterSlider = document.getElementById('setting-enter-threshold');
  const exitSlider = document.getElementById('setting-exit-threshold');
  const applyThresholds = () => {
    let enter = parseFloat(enterSlider.value);
    let exit = parseFloat(exitSlider.value);
    const hint = document.getElementById('threshold-hint');
    if (exit >= enter) {
      exit = Math.max(0.1, Math.round((enter - 0.01) * 100) / 100);
      exitSlider.value = exit;
      hint.textContent = '検出終了閾値は検出開始閾値より小さい必要があるため、自動的に調整しました。';
    } else {
      hint.textContent = '';
    }
    store.globalSettings.enterThreshold = enter;
    store.globalSettings.exitThreshold = exit;
    document.getElementById('enter-threshold-value').textContent = enter.toFixed(2);
    document.getElementById('exit-threshold-value').textContent = exit.toFixed(2);
    persist();
  };
  enterSlider.addEventListener('input', applyThresholds);
  exitSlider.addEventListener('input', applyThresholds);

  document.getElementById('setting-cooldown').addEventListener('change', (e) => {
    const v = Math.max(0, parseInt(e.target.value, 10) || 0);
    store.globalSettings.cooldownMs = v;
    e.target.value = v;
    persist();
  });
  document.getElementById('setting-analysis-fps').addEventListener('change', (e) => {
    store.globalSettings.analysisFps = parseFloat(e.target.value);
    persist();
  });
  document.getElementById('setting-enter-frames').addEventListener('change', (e) => {
    store.globalSettings.enterFrameCount = Math.max(1, parseInt(e.target.value, 10) || 1);
    e.target.value = store.globalSettings.enterFrameCount;
    persist();
  });
  document.getElementById('setting-exit-frames').addEventListener('change', (e) => {
    store.globalSettings.exitFrameCount = Math.max(1, parseInt(e.target.value, 10) || 1);
    e.target.value = store.globalSettings.exitFrameCount;
    persist();
  });
  document.getElementById('setting-downscale').addEventListener('change', (e) => {
    store.globalSettings.downscale = parseFloat(e.target.value);
    persist();
  });
  document.getElementById('setting-grayscale').addEventListener('change', (e) => {
    store.globalSettings.grayscale = e.target.checked;
    persist();
  });
  document.getElementById('setting-multiscale').addEventListener('change', (e) => {
    store.globalSettings.multiScale = e.target.value;
    persist();
  });
  document.getElementById('setting-debug').addEventListener('change', (e) => {
    store.globalSettings.debug = e.target.checked;
    document.getElementById('debug-panel').hidden = !e.target.checked;
    persist();
    drawMainOverlay();
  });
  document.getElementById('setting-sound').addEventListener('change', (e) => {
    store.globalSettings.sound = e.target.checked;
    persist();
  });
  document.getElementById('setting-min-template-size').addEventListener('change', (e) => {
    store.globalSettings.minTemplateSize = Math.max(1, parseInt(e.target.value, 10) || 8);
    e.target.value = store.globalSettings.minTemplateSize;
    persist();
  });
  document.getElementById('setting-max-template-count').addEventListener('change', (e) => {
    store.globalSettings.maxTemplateCount = Math.max(1, parseInt(e.target.value, 10) || 20);
    e.target.value = store.globalSettings.maxTemplateCount;
    persist();
  });

  document.getElementById('btn-reload-opencv').addEventListener('click', () => window.location.reload());
  document.getElementById('btn-enter-compact').addEventListener('click', enterCompactMode);
  document.getElementById('btn-exit-compact').addEventListener('click', exitCompactMode);

  window.addEventListener('beforeunload', () => {
    for (const target of store.targets) releaseTargetMats(target);
    if (captureManager) captureManager.stop();
  });

  document.addEventListener('visibilitychange', () => {
    if (!detectionEngine || !store.counting) return;
    if (document.hidden) {
      // Force an immediate switch off requestVideoFrameCallback (which the
      // browser stops delivering once this window isn't being composited,
      // e.g. minimized) onto a plain timer, so counting keeps going - at a
      // throttled rate the browser imposes on background tabs - instead of
      // stalling until this window is foregrounded again. Waiting for the
      // in-flight rVFC wait to resolve on its own isn't an option: it may
      // simply never fire while hidden.
      detectionEngine.reschedule();
    } else if (detectionEngine.running) {
      detectionEngine.reschedule(); // switch back to requestVideoFrameCallback now that we're visible
    } else {
      detectionEngine.start(); // was fully stopped for some other reason; resume
    }
  });
}

async function bootstrap() {
  videoEl = document.getElementById('preview-video');
  previewStage = document.getElementById('preview-stage');
  overlayCanvas = document.getElementById('overlay-canvas');
  overlayCanvas.style.pointerEvents = 'none';

  captureManager = new CaptureManager();
  captureManager.attachVideoElement(videoEl);
  captureManager.addEventListener('ended', () => stopCapture('画面の共有が終了しました。「画面を選択」からもう一度共有を開始できます。'));

  ui.bindTargetListHandlers({
    onIncrement: (id) => manualAdjust(id, 1),
    onDecrement: (id) => manualAdjust(id, -1),
    onRename: renameTarget,
    onToggleEnabled: toggleTargetEnabled,
    onResetOne: resetOneTarget,
    onDelete: deleteTarget,
    onRerender: () => ui.renderTargetList(store),
  });

  store.addEventListener('status', () => {
    ui.renderStatusBanner(store);
    ui.renderStepIndicator(store);
    if (isCompactMode()) updateCompactStatus();
  });
  store.addEventListener('targets', () => {
    if (!ui.isEditingTarget()) ui.renderTargetList(store);
    ui.renderStepIndicator(store);
    updateUndoButtonState();
    updateCountingButtonState();
    if (isCompactMode() && !compactEditingTargetId) renderCompactResults();
  });
  store.addEventListener('history', () => {
    ui.renderHistory(store);
    updateUndoButtonState();
  });

  new ResizeObserver(() => {
    sizeOverlayToStage();
    drawMainOverlay();
  }).observe(previewStage);

  checkBrowserSupport();
  bindStaticEventListeners();

  let restored = null;
  if (isIndexedDbAvailable()) {
    try {
      restored = await loadAppState();
    } catch (e) {
      ui.showErrorDialog(friendlyErrorMessage(e), debugText(e));
    }
  } else {
    document.getElementById('save-status').textContent = 'このブラウザでは自動保存が利用できません。設定の書き出し機能をご利用ください。';
  }

  if (restored) {
    store.globalSettings = { ...store.globalSettings, ...sanitizeGlobalSettings(restored.globalSettings) };
    if (restored.searchRegion) store.searchRegion = restored.searchRegion;
    if (typeof restored.searchRegionVisible === 'boolean') store.searchRegionVisible = restored.searchRegionVisible;
    store.replaceTargets((restored.targets || []).map((t) => {
      const target = createTarget(t);
      if (t.imageBlob) target.thumbnailUrl = URL.createObjectURL(t.imageBlob);
      return target;
    }));
    store.replaceHistory(restored.history || []);
    document.getElementById('region-mode-custom').checked = store.searchRegion.mode === 'custom' && !!store.searchRegion.rect;
    document.getElementById('region-mode-full').checked = !(store.searchRegion.mode === 'custom' && !!store.searchRegion.rect);
    document.getElementById('toggle-region-visible').checked = store.searchRegionVisible;
  }

  reflectSettingsIntoForm();
  updateRegionInfoText();
  renderAll();

  document.getElementById('opencv-loading-banner').hidden = false;
  store.setStatus('loadingOpenCv');
  loadOpenCv(
    (cv) => {
      document.getElementById('opencv-loading-banner').hidden = true;
      detectionEngine = new DetectionEngine(store, cv);
      detectionEngine.onDetectionEvent = handleDetectionEvent;
      detectionEngine.onFrameAnalyzed = handleFrameAnalyzed;
      detectionEngine.onError = (e) => ui.showErrorDialog(friendlyErrorMessage(e), debugText(e));
      store.setStatus('noScreen');
      updateCountingButtonState();
    },
    (e) => {
      document.getElementById('opencv-loading-banner').hidden = true;
      const banner = document.getElementById('opencv-error-banner');
      banner.hidden = false;
      document.getElementById('opencv-error-message').textContent = friendlyErrorMessage(e);
      store.setStatus('error', friendlyErrorMessage(e));
    },
  );
}

bootstrap();
