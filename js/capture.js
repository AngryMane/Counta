// capture.js
// Wraps the screen capture (getDisplayMedia) lifecycle: starting, stopping,
// switching source, and reporting the native capture resolution.

export class CaptureManager extends EventTarget {
  constructor() {
    super();
    this.stream = null;
    this.track = null;
    this.videoEl = null;
  }

  static isSupported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
  }

  attachVideoElement(videoEl) {
    this.videoEl = videoEl;
  }

  /**
   * Must be called directly from a user gesture (click handler) - browsers
   * reject getDisplayMedia() calls that are not triggered by direct user input.
   */
  async start() {
    if (!CaptureManager.isSupported()) {
      const err = new Error('画面共有がサポートされていません');
      err.code = 'UNSUPPORTED';
      throw err;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          displaySurface: 'monitor',
          frameRate: { ideal: 15, max: 30 },
        },
        audio: false,
      });
    } catch (e) {
      const err = new Error('画面共有の取得に失敗しました');
      err.code = e && e.name === 'NotAllowedError' ? 'PERMISSION_DENIED' : 'CAPTURE_FAILED';
      err.cause = e;
      throw err;
    }
    this._bindStream(stream);
    return stream;
  }

  _bindStream(stream) {
    this.stopStreamOnly();
    this.stream = stream;
    this.track = stream.getVideoTracks()[0];
    if (this.videoEl) {
      this.videoEl.srcObject = stream;
    }
    if (this.track) {
      this.track.addEventListener('ended', () => {
        this.dispatchEvent(new CustomEvent('ended'));
      });
    }
  }

  /** Stops the current stream's tracks without touching listeners on this manager. */
  stopStreamOnly() {
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
    }
    this.stream = null;
    this.track = null;
    if (this.videoEl) {
      this.videoEl.srcObject = null;
    }
  }

  stop() {
    this.stopStreamOnly();
    this.dispatchEvent(new CustomEvent('stopped'));
  }

  isActive() {
    return !!this.track && this.track.readyState === 'live';
  }

  getResolution() {
    if (!this.track) return null;
    const settings = this.track.getSettings();
    if (settings.width && settings.height) {
      return { width: settings.width, height: settings.height };
    }
    if (this.videoEl && this.videoEl.videoWidth) {
      return { width: this.videoEl.videoWidth, height: this.videoEl.videoHeight };
    }
    return null;
  }
}
