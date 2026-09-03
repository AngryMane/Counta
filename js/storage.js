// storage.js
// Persistence layer. Everything stays local to the browser:
//  - IndexedDB holds the working state (targets incl. image blobs, settings,
//    search region, history) so a page reload restores it automatically.
//  - JSON export/import lets the user carry a configuration between browsers
//    or machines by hand; images are embedded as base64 data URLs.
// No network requests are made anywhere in this module.

import { createId, PERSISTED_TARGET_FIELDS } from './state.js';

const DB_NAME = 'detection-counter-db';
const DB_VERSION = 1;
const STORE_NAME = 'app-state';
const RECORD_KEY = 'current';
const SCHEMA_VERSION = 1;

export function isIndexedDbAvailable() {
  return 'indexedDB' in window;
}

function openDb() {
  return new Promise((resolve, reject) => {
    if (!isIndexedDbAvailable()) {
      reject(makeError('INDEXEDDB_UNAVAILABLE', 'このブラウザではIndexedDBが利用できません'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(makeError('INDEXEDDB_OPEN_FAILED', 'IndexedDBを開けませんでした', req.error));
  });
}

function serializeTargetForStorage(target) {
  const out = {};
  for (const key of PERSISTED_TARGET_FIELDS) {
    out[key] = target[key];
  }
  return out;
}

export function buildAppStateSnapshot(store) {
  return {
    schemaVersion: SCHEMA_VERSION,
    savedAt: Date.now(),
    globalSettings: store.globalSettings,
    searchRegion: store.searchRegion,
    searchRegionVisible: store.searchRegionVisible,
    targets: store.targets.map(serializeTargetForStorage),
    history: store.history,
  };
}

export async function saveAppState(store) {
  const db = await openDb();
  const data = buildAppStateSnapshot(store);
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(data, RECORD_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(makeError('INDEXEDDB_WRITE_FAILED', '設定の保存に失敗しました', tx.error));
  });
  db.close();
}

export async function loadAppState() {
  const db = await openDb();
  const result = await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(RECORD_KEY);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(makeError('INDEXEDDB_READ_FAILED', '保存されたデータの読み込みに失敗しました', req.error));
  });
  db.close();
  return result;
}

export async function clearAppState() {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(RECORD_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(makeError('INDEXEDDB_WRITE_FAILED', 'データの削除に失敗しました', tx.error));
  });
  db.close();
}

// --- JSON export / import (no fetch, no network) ---

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = () => reject(makeError('BLOB_READ_FAILED', '画像データの変換に失敗しました', reader.error));
    reader.readAsDataURL(blob);
  });
}

function dataUrlToBlob(dataUrl) {
  const match = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl || '');
  if (!match) {
    throw makeError('INVALID_IMAGE_DATA', '画像データの形式が不正です');
  }
  const mime = match[1];
  const binary = atob(match[2]);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mime });
}

export async function exportStateToJson(store) {
  const snapshot = buildAppStateSnapshot(store);
  const targets = [];
  for (const t of snapshot.targets) {
    targets.push({
      ...t,
      imageBlob: undefined,
      imageDataUrl: t.imageBlob ? await blobToDataUrl(t.imageBlob) : null,
    });
  }
  return JSON.stringify({ ...snapshot, targets }, null, 2);
}

/**
 * Parses and validates a previously exported JSON configuration. Invalid or
 * unrecognized entries are skipped rather than throwing, so a partially
 * corrupt file does not take down the whole app; only a completely
 * unparsable / wrongly-shaped file raises an error.
 */
export function parseImportedJson(jsonText) {
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (e) {
    throw makeError('INVALID_JSON', '設定ファイルの形式が正しくありません（JSONとして読み込めません）');
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.targets)) {
    throw makeError('INVALID_SCHEMA', '設定ファイルの内容が想定した形式と異なります');
  }

  const targets = [];
  for (const raw of parsed.targets) {
    if (!raw || typeof raw !== 'object') continue;
    if (typeof raw.name !== 'string' || typeof raw.imageDataUrl !== 'string') continue;
    let blob;
    try {
      blob = dataUrlToBlob(raw.imageDataUrl);
    } catch (e) {
      continue; // skip this one target, keep the rest of the import going
    }
    targets.push({
      id: typeof raw.id === 'string' ? raw.id : createId('target'),
      name: raw.name,
      unit: typeof raw.unit === 'string' ? raw.unit : '回',
      count: Number.isFinite(raw.count) && raw.count >= 0 ? Math.floor(raw.count) : 0,
      enabled: raw.enabled !== false,
      imageBlob: blob,
      sourceType: raw.sourceType === 'file' ? 'file' : 'capture',
      originalWidth: Number(raw.originalWidth) || 0,
      originalHeight: Number(raw.originalHeight) || 0,
      useGlobalSettings: raw.useGlobalSettings !== false,
      settings: raw.settings && typeof raw.settings === 'object' ? {
        enterThreshold: numOrNull(raw.settings.enterThreshold),
        exitThreshold: numOrNull(raw.settings.exitThreshold),
        cooldownMs: numOrNull(raw.settings.cooldownMs),
        enterFrameCount: numOrNull(raw.settings.enterFrameCount),
        exitFrameCount: numOrNull(raw.settings.exitFrameCount),
      } : {},
      createdAt: Number(raw.createdAt) || Date.now(),
    });
  }

  return {
    globalSettings: parsed.globalSettings && typeof parsed.globalSettings === 'object' ? parsed.globalSettings : null,
    searchRegion: parsed.searchRegion && typeof parsed.searchRegion === 'object' ? parsed.searchRegion : null,
    searchRegionVisible: parsed.searchRegionVisible !== false,
    targets,
    history: Array.isArray(parsed.history) ? parsed.history : [],
  };
}

function numOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function makeError(code, message, cause) {
  const err = new Error(message);
  err.code = code;
  if (cause) err.cause = cause;
  return err;
}
