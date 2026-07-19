// Unified input: keyboard + touch swipes. Emits discrete actions.

const SWIPE_MIN = 28;      // px
const SWIPE_MAX_TIME = 600; // ms

export class Input {
  // handler receives: 'left' | 'right' | 'jump' | 'slide' | 'pause' | 'any'
  constructor(handler) {
    this.handler = handler;
    this.enabled = true;
    this._touch = null;

    this._onKey = (e) => {
      if (e.repeat) return;
      let action = null;
      switch (e.code) {
        case 'ArrowLeft': case 'KeyA': action = 'left'; break;
        case 'ArrowRight': case 'KeyD': action = 'right'; break;
        case 'ArrowUp': case 'KeyW': case 'Space': action = 'jump'; break;
        case 'ArrowDown': case 'KeyS': action = 'slide'; break;
        case 'ShiftLeft': case 'ShiftRight': action = 'intiRay'; break;
        case 'Escape': case 'KeyP': action = 'pause'; break;
      }
      if (action) {
        if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
        this._emit(action);
      }
      this._emit('any');
    };

    this._onTouchStart = (e) => {
      if (e.target.closest && e.target.closest('button, a')) return;
      const t = e.changedTouches[0];
      this._touch = { x: t.clientX, y: t.clientY, t: performance.now(), id: t.identifier };
      this._emit('any');
    };

    this._onTouchEnd = (e) => {
      if (!this._touch) return;
      const t = [...e.changedTouches].find((c) => c.identifier === this._touch.id);
      if (!t) return;
      const dx = t.clientX - this._touch.x;
      const dy = t.clientY - this._touch.y;
      const dt = performance.now() - this._touch.t;
      this._touch = null;
      if (dt > SWIPE_MAX_TIME) return;
      const ax = Math.abs(dx), ay = Math.abs(dy);
      if (ax < SWIPE_MIN && ay < SWIPE_MIN) { this._emit('jump'); return; } // tap
      if (ax > ay) this._emit(dx > 0 ? 'right' : 'left');
      else this._emit(dy > 0 ? 'slide' : 'jump');
    };

    this._onPointerDown = () => this._emit('any');

    window.addEventListener('keydown', this._onKey, { passive: false });
    window.addEventListener('touchstart', this._onTouchStart, { passive: true });
    window.addEventListener('touchend', this._onTouchEnd, { passive: true });
    window.addEventListener('pointerdown', this._onPointerDown, { passive: true });
  }

  _emit(action) {
    if (this.enabled || action === 'any' || action === 'pause') this.handler(action);
  }

  destroy() {
    window.removeEventListener('keydown', this._onKey);
    window.removeEventListener('touchstart', this._onTouchStart);
    window.removeEventListener('touchend', this._onTouchEnd);
    window.removeEventListener('pointerdown', this._onPointerDown);
  }
}
