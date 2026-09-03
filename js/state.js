// state.js
// Central in-memory store for the whole application. All other modules read
// and mutate application data through this single store instead of using
// scattered global variables.

export const AppStatus = Object.freeze({
  NO_SCREEN: 'noScreen',
  LOADING_OPENCV: 'loadingOpenCv',
  SHARING: 'sharing',
  REGISTERING: 'registering',
  COUNTING: 'counting',
  COUNT_STOPPED: 'countStopped',
  SHARE_ENDED: 'shareEnded',
  ERROR: 'error',
});

export const DetectionState = Object.freeze({
  NOT_DETECTED: 'notDetected',
  DETECTION_CANDIDATE: 'detectionCandidate',
  DETECTED: 'detected',
  MISSING_CANDIDATE: 'missingCandidate',
});

export const DEFAULT_GLOBAL_SETTINGS = Object.freeze({
  enterThreshold: 0.85,
  exitThreshold: 0.70,
  cooldownMs: 3000,
  analysisFps: 2,
  enterFrameCount: 2,
  exitFrameCount: 2,
  downscale: 0.5,
  grayscale: true,
  multiScale: 'off', // 'off' | '3' | '5'
  debug: false,
  sound: false,
  minTemplateSize: 8,
  maxTemplateCount: 20,
});

let idCounter = 0;
export function createId(prefix) {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * A detection target holds both persisted fields (name, count, image, settings)
 * and runtime-only fields (detection state machine, live score, cv.Mat handles).
 * Runtime fields are excluded whenever the target is serialized for storage.
 */
export function createTarget({
  id = createId('target'),
  name,
  unit = '回',
  count = 0,
  enabled = true,
  imageBlob,
  sourceType = 'capture',
  originalWidth = 0,
  originalHeight = 0,
  useGlobalSettings = true,
  settings = {},
  createdAt = Date.now(),
} = {}) {
  return {
    id,
    name,
    unit,
    count,
    enabled,
    imageBlob,
    thumbnailUrl: '',
    sourceType,
    originalWidth,
    originalHeight,
    useGlobalSettings,
    settings: {
      enterThreshold: settings.enterThreshold ?? null,
      exitThreshold: settings.exitThreshold ?? null,
      cooldownMs: settings.cooldownMs ?? null,
      enterFrameCount: settings.enterFrameCount ?? null,
      exitFrameCount: settings.exitFrameCount ?? null,
    },
    createdAt,

    // --- runtime-only (never persisted) ---
    detectionState: DetectionState.NOT_DETECTED,
    currentScore: 0,
    maxScoreLocation: null,
    lastDetectedAt: null,
    lastCountedAt: null,
    consecutiveDetectedFrames: 0,
    consecutiveMissingFrames: 0,
    templateTooLarge: false,
    runtime: {
      mat: null,
      matWidth: 0,
      matHeight: 0,
      scaledMats: [], // [{scale, mat, width, height}]
      preprocessedFor: null, // signature of settings used to build mats
    },
  };
}

export const PERSISTED_TARGET_FIELDS = [
  'id', 'name', 'unit', 'count', 'enabled', 'imageBlob', 'sourceType',
  'originalWidth', 'originalHeight', 'useGlobalSettings', 'settings', 'createdAt',
];

export function serializeTarget(target) {
  const out = {};
  for (const key of PERSISTED_TARGET_FIELDS) {
    out[key] = target[key];
  }
  return out;
}

export function effectiveSettings(target, globalSettings) {
  if (target.useGlobalSettings) {
    return {
      enterThreshold: globalSettings.enterThreshold,
      exitThreshold: globalSettings.exitThreshold,
      cooldownMs: globalSettings.cooldownMs,
      enterFrameCount: globalSettings.enterFrameCount,
      exitFrameCount: globalSettings.exitFrameCount,
    };
  }
  const s = target.settings || {};
  return {
    enterThreshold: s.enterThreshold ?? globalSettings.enterThreshold,
    exitThreshold: s.exitThreshold ?? globalSettings.exitThreshold,
    cooldownMs: s.cooldownMs ?? globalSettings.cooldownMs,
    enterFrameCount: s.enterFrameCount ?? globalSettings.enterFrameCount,
    exitFrameCount: s.exitFrameCount ?? globalSettings.exitFrameCount,
  };
}

class Store extends EventTarget {
  constructor() {
    super();
    this.status = AppStatus.NO_SCREEN;
    this.statusMessage = '画面がまだ選択されていません。';
    this.captureResolution = null; // {width, height}
    this.searchRegion = { mode: 'full', rect: null }; // rect: ratio {x,y,width,height}
    this.searchRegionVisible = true;
    this.globalSettings = { ...DEFAULT_GLOBAL_SETTINGS };
    this.targets = [];
    this.history = [];
    // Bumped whenever the shared screen or a setting that invalidates
    // in-flight analysis changes, so stale async results can be discarded.
    this.generation = 0;
    this.counting = false;
    this.lastActionForUndo = null; // {type, targetId, previousValue, newValue}
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  setStatus(status, message) {
    this.status = status;
    if (message !== undefined) this.statusMessage = message;
    this.emit('status');
  }

  bumpGeneration() {
    this.generation += 1;
    return this.generation;
  }

  addTarget(target) {
    this.targets.push(target);
    this.emit('targets');
  }

  removeTarget(id) {
    this.targets = this.targets.filter((t) => t.id !== id);
    this.emit('targets');
  }

  getTarget(id) {
    return this.targets.find((t) => t.id === id) || null;
  }

  updateTarget(id, patch) {
    const t = this.getTarget(id);
    if (!t) return null;
    Object.assign(t, patch);
    this.emit('targets');
    return t;
  }

  replaceTargets(targets) {
    this.targets = targets;
    this.emit('targets');
  }

  addHistoryEntry(entry) {
    this.history.unshift(entry);
    this.emit('history');
  }

  replaceHistory(history) {
    this.history = history;
    this.emit('history');
  }

  clearHistory() {
    this.history = [];
    this.emit('history');
  }
}

export const store = new Store();
