// regionSelect.js
// Generic pointer-drag rectangle selector used both for cropping a detection
// target out of a paused frame, and for choosing the search region on the
// live preview. Coordinates are tracked in the overlay element's own local
// pixel space; callers convert to ratios/native pixels as needed.

export class RegionSelector {
  constructor(overlayEl, { onChange, minSize = 4 } = {}) {
    this.overlayEl = overlayEl;
    this.onChange = onChange;
    this.minSize = minSize;
    this.rect = null; // {x, y, w, h} in overlay-local CSS pixels
    this.dragging = false;
    this.startPoint = null;

    this._onPointerDown = this._onPointerDown.bind(this);
    this._onPointerMove = this._onPointerMove.bind(this);
    this._onPointerUp = this._onPointerUp.bind(this);

    this.overlayEl.addEventListener('pointerdown', this._onPointerDown);
    window.addEventListener('pointermove', this._onPointerMove);
    window.addEventListener('pointerup', this._onPointerUp);
  }

  _onPointerDown(e) {
    if (e.button !== undefined && e.button !== 0) return;
    const box = this.overlayEl.getBoundingClientRect();
    this.dragging = true;
    this.startPoint = {
      x: clamp(e.clientX - box.left, 0, box.width),
      y: clamp(e.clientY - box.top, 0, box.height),
    };
    this.rect = { x: this.startPoint.x, y: this.startPoint.y, w: 0, h: 0 };
    this._emit(false);
    e.preventDefault();
  }

  _onPointerMove(e) {
    if (!this.dragging) return;
    const box = this.overlayEl.getBoundingClientRect();
    const cur = {
      x: clamp(e.clientX - box.left, 0, box.width),
      y: clamp(e.clientY - box.top, 0, box.height),
    };
    const x = Math.min(this.startPoint.x, cur.x);
    const y = Math.min(this.startPoint.y, cur.y);
    const w = Math.abs(cur.x - this.startPoint.x);
    const h = Math.abs(cur.y - this.startPoint.y);
    this.rect = { x, y, w, h };
    this._emit(false);
  }

  _onPointerUp() {
    if (!this.dragging) return;
    this.dragging = false;
    if (this.rect && (this.rect.w < this.minSize || this.rect.h < this.minSize)) {
      this.rect = null;
    }
    this._emit(true);
  }

  _emit(final) {
    if (this.onChange) this.onChange(this.rect, final);
  }

  setRect(rect) {
    this.rect = rect;
    this._emit(true);
  }

  reset() {
    this.rect = null;
    this._emit(true);
  }

  getRect() {
    return this.rect;
  }

  /** Converts the local-pixel rect to a ratio rect relative to the overlay's own size. */
  getRatioRect() {
    if (!this.rect) return null;
    const box = this.overlayEl.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return null;
    return {
      x: this.rect.x / box.width,
      y: this.rect.y / box.height,
      width: this.rect.w / box.width,
      height: this.rect.h / box.height,
    };
  }

  destroy() {
    this.overlayEl.removeEventListener('pointerdown', this._onPointerDown);
    window.removeEventListener('pointermove', this._onPointerMove);
    window.removeEventListener('pointerup', this._onPointerUp);
  }
}

function clamp(v, min, max) {
  return Math.min(Math.max(v, min), max);
}
