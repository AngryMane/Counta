// detection.js
// Template-matching engine: turns registered target images into OpenCV
// templates, samples the shared screen at a throttled rate, and runs a
// hysteresis state machine per target so that a continuously-visible target
// is counted exactly once per appearance.
//
// All cv.Mat objects created here are released with .delete() as soon as
// they are no longer needed; long-lived template mats are cached on
// target.runtime and only rebuilt when settings that affect them change.

import { DetectionState, effectiveSettings } from './state.js';

const MULTI_SCALE_FACTORS = {
  off: [1],
  3: [0.9, 1, 1.1],
  5: [0.8, 0.9, 1, 1.1, 1.2],
};

export class DetectionEngine {
  constructor(store, cv) {
    this.store = store;
    this.cv = cv;
    this.videoEl = null;
    this.frameCanvas = document.createElement('canvas');
    this.frameCtx = this.frameCanvas.getContext('2d', { willReadFrequently: true });

    this.running = false;
    this.isAnalyzingFrame = false;
    this.generation = 0;
    this.lastAnalysisTime = 0;
    this.rvfcId = null;
    this.timerId = null;
    this.tickIntervalMs = 500;

    this.debugInfo = {
      analysisFps: 0,
      captureResolution: null,
      analysisResolution: null,
      searchRegionPx: null,
      lastFrameDurationMs: 0,
      lastAnalysisAt: null,
      targets: {},
    };
    this._frameTimestamps = [];

    this.onDetectionEvent = null; // (target, score) => void, called on count-worthy transition
    this.onFrameAnalyzed = null; // () => void, called after every analysis tick
    this.onError = null; // (error) => void
  }

  setVideoElement(videoEl) {
    this.videoEl = videoEl;
  }

  /** Starts the throttled analysis loop. Safe to call once; guards against double start. */
  start() {
    if (this.running) return;
    this.running = true;
    this.generation = this.store.bumpGeneration();
    this.lastAnalysisTime = 0;
    this._scheduleNext();
  }

  stop() {
    this.running = false;
    this._cancelPendingSchedule();
  }

  /**
   * Re-evaluates how the next tick should be scheduled without stopping the
   * loop - call this right after a visibility change. Cancelling the
   * pending wait first (rather than letting it resolve on its own) matters
   * because a requestVideoFrameCallback registered just before the window
   * was hidden may simply never fire; waiting for it to "naturally"
   * reschedule would stall the whole loop until it's foregrounded again.
   */
  reschedule() {
    if (!this.running) return;
    this._cancelPendingSchedule();
    this._scheduleNext();
  }

  _cancelPendingSchedule() {
    if (this.rvfcId != null && this.videoEl && this.videoEl.cancelVideoFrameCallback) {
      this.videoEl.cancelVideoFrameCallback(this.rvfcId);
    }
    this.rvfcId = null;
    if (this.timerId != null) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
  }

  /** Invalidates in-flight results (e.g. after a screen change or target deletion). */
  invalidate() {
    this.generation = this.store.bumpGeneration();
  }

  _scheduleNext() {
    if (!this.running) return;
    const fps = Number(this.store.globalSettings.analysisFps) || 2;
    this.tickIntervalMs = 1000 / fps;

    // requestVideoFrameCallback is tied to the video element's own render
    // pipeline: once this window stops being composited (minimized / tab
    // hidden), the browser simply stops delivering it. So it's only used
    // while visible; a plain timer takes over otherwise, which the browser
    // throttles but does not fully stop, so counting keeps going (if more
    // slowly) even while minimized.
    const useRvfc = !document.hidden && this.videoEl && typeof this.videoEl.requestVideoFrameCallback === 'function';
    if (useRvfc) {
      this.rvfcId = this.videoEl.requestVideoFrameCallback(() => this._onFrameTick());
    } else {
      this.timerId = setTimeout(() => this._onFrameTick(), this.tickIntervalMs);
    }
  }

  _onFrameTick() {
    if (!this.running) return;
    const now = performance.now();
    const dueForAnalysis = now - this.lastAnalysisTime >= this.tickIntervalMs;
    if (dueForAnalysis && !this.isAnalyzingFrame) {
      this.lastAnalysisTime = now;
      this._analyzeFrameOnce().catch((e) => {
        if (this.onError) this.onError(e);
      });
    }
    this._scheduleNext();
  }

  async _analyzeFrameOnce() {
    if (this.isAnalyzingFrame) return;
    const myGeneration = this.generation;
    this.isAnalyzingFrame = true;
    const frameStart = performance.now();

    const cv = this.cv;
    let frameMat = null;
    let grayFrameMat = null;
    let roiMat = null;

    try {
      const video = this.videoEl;
      if (!video || video.readyState < 2 || !video.videoWidth) {
        return;
      }
      const nativeW = video.videoWidth;
      const nativeH = video.videoHeight;
      const downscale = this.store.globalSettings.downscale || 1;
      const analysisW = Math.max(1, Math.round(nativeW * downscale));
      const analysisH = Math.max(1, Math.round(nativeH * downscale));

      this.frameCanvas.width = analysisW;
      this.frameCanvas.height = analysisH;
      this.frameCtx.drawImage(video, 0, 0, analysisW, analysisH);

      frameMat = cv.imread(this.frameCanvas);

      if (this.store.globalSettings.grayscale) {
        grayFrameMat = new cv.Mat();
        cv.cvtColor(frameMat, grayFrameMat, cv.COLOR_RGBA2GRAY);
      }
      const workingFrame = grayFrameMat || frameMat;

      const regionPx = this._resolveSearchRegionPx(analysisW, analysisH);
      roiMat = workingFrame.roi(new cv.Rect(regionPx.x, regionPx.y, regionPx.width, regionPx.height));

      if (myGeneration !== this.generation) return; // stale before we even start matching

      const now = Date.now();
      const targetDebug = {};
      for (const target of this.store.targets) {
        if (myGeneration !== this.generation) break;
        if (!target.enabled) {
          target.currentScore = 0;
          continue;
        }
        await this._ensureTemplateReady(target);
        if (myGeneration !== this.generation) break;

        const result = this._matchTarget(target, roiMat, regionPx);
        targetDebug[target.id] = result;

        if (result.tooLarge) {
          target.templateTooLarge = true;
          target.currentScore = 0;
          continue;
        }
        target.templateTooLarge = false;
        target.currentScore = result.score;
        target.maxScoreLocation = result.loc;

        const settings = effectiveSettings(target, this.store.globalSettings);
        const counted = updateTargetDetection(target, result.score, settings, now);
        if (counted && this.onDetectionEvent) {
          this.onDetectionEvent(target, result.score);
        }
      }

      this.debugInfo = {
        analysisFps: this._computeRollingFps(),
        captureResolution: { width: nativeW, height: nativeH },
        analysisResolution: { width: analysisW, height: analysisH },
        searchRegionPx: regionPx,
        lastFrameDurationMs: Math.round(performance.now() - frameStart),
        lastAnalysisAt: now,
        targets: targetDebug,
      };

      if (myGeneration === this.generation) {
        this.store.emit('targets');
        if (this.onFrameAnalyzed) this.onFrameAnalyzed(this.debugInfo);
      }
    } finally {
      if (roiMat) roiMat.delete();
      if (grayFrameMat) grayFrameMat.delete();
      if (frameMat) frameMat.delete();
      this.isAnalyzingFrame = false;
    }
  }

  _computeRollingFps() {
    const now = performance.now();
    this._frameTimestamps.push(now);
    this._frameTimestamps = this._frameTimestamps.filter((t) => now - t < 5000);
    if (this._frameTimestamps.length < 2) return 0;
    const span = (this._frameTimestamps[this._frameTimestamps.length - 1] - this._frameTimestamps[0]) / 1000;
    return span > 0 ? Math.round(((this._frameTimestamps.length - 1) / span) * 10) / 10 : 0;
  }

  _resolveSearchRegionPx(frameW, frameH) {
    const region = this.store.searchRegion;
    if (!region || region.mode !== 'custom' || !region.rect) {
      return { x: 0, y: 0, width: frameW, height: frameH };
    }
    const r = region.rect;
    const x = clampInt(Math.round(r.x * frameW), 0, frameW - 1);
    const y = clampInt(Math.round(r.y * frameH), 0, frameH - 1);
    const width = clampInt(Math.round(r.width * frameW), 1, frameW - x);
    const height = clampInt(Math.round(r.height * frameH), 1, frameH - y);
    return { x, y, width, height };
  }

  _matchTarget(target, roiMat, regionPx) {
    const cv = this.cv;
    const rt = target.runtime;
    const variants = [{ scale: 1, mat: rt.mat }, ...rt.scaledMats];

    let bestScore = -1;
    let bestLoc = null;
    let anyFits = false;

    for (const variant of variants) {
      const tmpl = variant.mat;
      if (!tmpl || tmpl.cols > regionPx.width || tmpl.rows > regionPx.height || tmpl.cols < 1 || tmpl.rows < 1) {
        continue;
      }
      anyFits = true;
      let result = null;
      try {
        result = new cv.Mat();
        cv.matchTemplate(roiMat, tmpl, result, cv.TM_CCOEFF_NORMED);
        const mm = cv.minMaxLoc(result);
        if (mm.maxVal > bestScore) {
          bestScore = mm.maxVal;
          bestLoc = { x: mm.maxLoc.x + regionPx.x, y: mm.maxLoc.y + regionPx.y, scale: variant.scale };
        }
      } finally {
        if (result) result.delete();
      }
    }

    if (!anyFits) {
      return { tooLarge: true, score: 0, loc: null };
    }
    return { tooLarge: false, score: Math.max(0, bestScore), loc: bestLoc };
  }

  /** (Re)builds the cv.Mat template(s) for a target if settings changed since last build. */
  async _ensureTemplateReady(target) {
    const signature = JSON.stringify({
      downscale: this.store.globalSettings.downscale,
      grayscale: this.store.globalSettings.grayscale,
      multiScale: this.store.globalSettings.multiScale,
      blobSize: target.imageBlob ? target.imageBlob.size : 0,
    });
    if (target.runtime.preprocessedFor === signature && target.runtime.mat) {
      return;
    }
    await preprocessTarget(target, this.cv, this.store.globalSettings);
    target.runtime.preprocessedFor = signature;
  }
}

/**
 * Loads a target's source image and produces the cv.Mat template(s) used for
 * matching, at the same downscale factor as analysis frames so pixel sizes
 * stay proportional. Releases any previously-held mats first.
 */
export async function preprocessTarget(target, cv, globalSettings) {
  releaseTargetMats(target);

  const bitmap = await createImageBitmap(target.imageBlob);
  const downscale = globalSettings.downscale || 1;
  const w = Math.max(1, Math.round(bitmap.width * downscale));
  const h = Math.max(1, Math.round(bitmap.height * downscale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();

  let baseMat = cv.imread(canvas);
  if (globalSettings.grayscale) {
    const gray = new cv.Mat();
    cv.cvtColor(baseMat, gray, cv.COLOR_RGBA2GRAY);
    baseMat.delete();
    baseMat = gray;
  }

  const factors = MULTI_SCALE_FACTORS[globalSettings.multiScale] || MULTI_SCALE_FACTORS.off;
  const scaledMats = [];
  for (const factor of factors) {
    if (factor === 1) continue;
    const sw = Math.max(1, Math.round(baseMat.cols * factor));
    const sh = Math.max(1, Math.round(baseMat.rows * factor));
    const resized = new cv.Mat();
    cv.resize(baseMat, resized, new cv.Size(sw, sh), 0, 0, cv.INTER_LINEAR);
    scaledMats.push({ scale: factor, mat: resized });
  }

  target.runtime.mat = baseMat;
  target.runtime.matWidth = baseMat.cols;
  target.runtime.matHeight = baseMat.rows;
  target.runtime.scaledMats = scaledMats;
}

export function releaseTargetMats(target) {
  const rt = target.runtime;
  if (rt.mat) {
    rt.mat.delete();
    rt.mat = null;
  }
  for (const variant of rt.scaledMats) {
    if (variant.mat) variant.mat.delete();
  }
  rt.scaledMats = [];
  rt.preprocessedFor = null;
}

/**
 * Hysteresis state machine: a target must stay above enterThreshold for
 * enterFrameCount consecutive analyses to be counted, and must stay below
 * exitThreshold for exitFrameCount consecutive analyses before it can be
 * counted again. Returns true exactly on the frame that causes a new count.
 */
export function updateTargetDetection(target, score, settings, now) {
  let counted = false;

  switch (target.detectionState) {
    case DetectionState.NOT_DETECTED: {
      if (score >= settings.enterThreshold) {
        target.consecutiveDetectedFrames += 1;
        target.lastDetectedAt = now;
        if (target.consecutiveDetectedFrames >= settings.enterFrameCount) {
          counted = enterDetected(target, settings, now);
        } else {
          target.detectionState = DetectionState.DETECTION_CANDIDATE;
        }
      } else {
        target.consecutiveDetectedFrames = 0;
      }
      break;
    }
    case DetectionState.DETECTION_CANDIDATE: {
      if (score >= settings.enterThreshold) {
        target.consecutiveDetectedFrames += 1;
        target.lastDetectedAt = now;
        if (target.consecutiveDetectedFrames >= settings.enterFrameCount) {
          counted = enterDetected(target, settings, now);
        }
      } else {
        target.detectionState = DetectionState.NOT_DETECTED;
        target.consecutiveDetectedFrames = 0;
      }
      break;
    }
    case DetectionState.DETECTED: {
      target.lastDetectedAt = now;
      if (score < settings.exitThreshold) {
        target.consecutiveMissingFrames = 1;
        target.detectionState = DetectionState.MISSING_CANDIDATE;
      }
      break;
    }
    case DetectionState.MISSING_CANDIDATE: {
      if (score >= settings.exitThreshold) {
        target.detectionState = DetectionState.DETECTED;
        target.consecutiveMissingFrames = 0;
        target.lastDetectedAt = now;
      } else {
        target.consecutiveMissingFrames += 1;
        if (target.consecutiveMissingFrames >= settings.exitFrameCount) {
          target.detectionState = DetectionState.NOT_DETECTED;
          target.consecutiveMissingFrames = 0;
        }
      }
      break;
    }
    default: {
      target.detectionState = DetectionState.NOT_DETECTED;
    }
  }

  return counted;
}

function enterDetected(target, settings, now) {
  target.detectionState = DetectionState.DETECTED;
  target.consecutiveDetectedFrames = 0;
  target.consecutiveMissingFrames = 0;
  const cooldownActive = target.lastCountedAt && now - target.lastCountedAt < settings.cooldownMs;
  if (cooldownActive) {
    return false;
  }
  target.lastCountedAt = now;
  target.count += 1;
  return true;
}

function clampInt(v, min, max) {
  return Math.min(Math.max(v, min), Math.max(min, max));
}
