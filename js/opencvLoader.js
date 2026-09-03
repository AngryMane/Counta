// opencvLoader.js
// Loads the single-threaded WebAssembly build of OpenCV.js from the local
// vendor/ directory (never from a CDN) and calls back once the runtime is
// ready.
//
// This intentionally uses plain callbacks instead of a Promise/async chain.
// In some browser builds, creating or resolving a native Promise from inside
// the callback that fires right after WebAssembly instantiation completes
// (Module.onRuntimeInitialized) causes the page's microtask queue to hang
// permanently - every future click and render silently stops. A plain
// callback here sidesteps that entirely, regardless of whether a given
// browser build is affected.

let started = false;
let readyCv = null;
let pendingCallbacks = [];
let failedError = null;

export function loadOpenCv(onReady, onError) {
  if (readyCv) {
    onReady(readyCv);
    return;
  }
  if (failedError) {
    onError(failedError);
    return;
  }
  pendingCallbacks.push({ onReady, onError });
  if (started) return;
  started = true;

  const succeed = (cv) => {
    readyCv = cv;
    window.cv = cv;
    const callbacks = pendingCallbacks;
    pendingCallbacks = [];
    for (const cb of callbacks) cb.onReady(cv);
  };

  const fail = (err) => {
    failedError = err;
    const callbacks = pendingCallbacks;
    pendingCallbacks = [];
    for (const cb of callbacks) cb.onError(err);
  };

  if (window.cv && window.cv.Mat) {
    succeed(window.cv);
    return;
  }

  const script = document.createElement('script');
  script.src = 'vendor/opencv.js';
  script.async = true;

  const timeoutId = setTimeout(() => {
    fail(makeError('TIMEOUT', 'OpenCV.jsの読み込みがタイムアウトしました'));
  }, 30000);

  script.onerror = () => {
    clearTimeout(timeoutId);
    fail(makeError('SCRIPT_LOAD_FAILED', 'vendor/opencv.js を読み込めませんでした'));
  };

  script.onload = () => {
    const cv = window.cv;
    if (!cv) {
      clearTimeout(timeoutId);
      fail(makeError('CV_NOT_FOUND', 'OpenCV.jsが正しく読み込まれませんでした'));
      return;
    }
    const finish = (resolvedCv) => {
      clearTimeout(timeoutId);
      succeed(resolvedCv);
    };
    if (cv.calledRun) {
      finish(cv);
    } else if (!(cv instanceof Promise)) {
      // Standard Emscripten Module object (including the official single-file
      // build with Base64-embedded Wasm, and builds that also carry a legacy,
      // non-Promise `Module.then()` back-compat shim). Assigning this
      // callback is always safe and is the mechanism these builds actually
      // fire on completion.
      const prevOnRuntimeInitialized = cv.onRuntimeInitialized;
      cv.onRuntimeInitialized = () => {
        if (prevOnRuntimeInitialized) prevOnRuntimeInitialized();
        finish(cv);
      };
    } else {
      // Only a genuine Promise-returning (ES6 MODULARIZE) build has no other
      // way to signal readiness.
      cv.then(finish).catch((e) => fail(makeError('WASM_INIT_FAILED', 'OpenCV.jsの初期化に失敗しました', e)));
    }
  };

  document.head.appendChild(script);
}

export function resetOpenCvLoader() {
  started = false;
  readyCv = null;
  pendingCallbacks = [];
  failedError = null;
}

function makeError(code, message, cause) {
  const err = new Error(message);
  err.code = code;
  if (cause) err.cause = cause;
  return err;
}
