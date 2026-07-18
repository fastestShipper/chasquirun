// localStorage persistence. Every read is guarded; storage can be disabled.

const KEYS = {
  best: 'chasqui.best',
  coins: 'chasqui.coins',
  muted: 'chasqui.muted',
  quality: 'chasqui.quality',
};

function read(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage unavailable; play on without persistence.
  }
}

export const Save = {
  get best() { return read(KEYS.best, 0); },
  set best(v) { write(KEYS.best, v); },
  get coins() { return read(KEYS.coins, 0); },
  set coins(v) { write(KEYS.coins, v); },
  get muted() { return read(KEYS.muted, false); },
  set muted(v) { write(KEYS.muted, v); },
  get quality() { return read(KEYS.quality, null); },
  set quality(v) { write(KEYS.quality, v); },
};
