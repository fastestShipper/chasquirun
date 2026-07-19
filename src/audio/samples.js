// Chasqui Run: the recorded-sample layer for SFX.
//
// The game's audio is synthesized (music.js / sfx.js). This module adds an
// optional layer of real recorded one-shots on top: when a sample exists for a
// sound name it plays instead of the synth patch, and when it does not, or the
// file is missing, or the fetch or the decode fails, the synth patch plays
// exactly as before. The procedural path is the floor, never the exception.
//
// Nothing here throws. Every entry point is guarded, so a broken or absent
// assets/sfx directory degrades to the original 100 percent procedural game.
//
// Samples are peak-normalized to about -1 dBFS on disk, so the per-sound gain
// below is the whole mix balance against the synth voices.

// Game sound name -> file in assets/sfx. Names not listed here (footstep,
// chakana, powerup, shieldSave, fall, splash, whoosh, uiClick, gust, llama,
// intiEnd and the rest of the KILLA set) stay fully procedural.
const FILES = {
  intiStrike: 'inti-strike.mp3',
  coin: 'coin.mp3',
  crash: 'crash.mp3',
  jump: 'jump.mp3',
  land: 'land.mp3',
  slide: 'slide.mp3',
  killaSpit: 'llama-spit.mp3',
  killaChuckle: 'llama-chuckle.mp3',
  pututu: 'pututu.mp3',
  record: 'record.mp3',
  gameOver: 'gameover.mp3',
};

// Per-sound playback gain and reverb send, matched by ear to the synth mix.
// A sample at -1 dBFS is far hotter than the synth patches, which peak around
// 0.2 to 0.5, so these are all well under 1.
const MIX = {
  intiStrike: { gain: 0.62, send: 0.34 },
  coin: { gain: 0.3, send: 0.1 },
  crash: { gain: 0.5, send: 0.16 },
  jump: { gain: 0.26, send: 0.06 },
  land: { gain: 0.28, send: 0.06 },
  slide: { gain: 0.32, send: 0.08 },
  killaSpit: { gain: 0.4, send: 0.12 },
  killaChuckle: { gain: 0.38, send: 0.16 },
  pututu: { gain: 0.5, send: 0.34 },
  record: { gain: 0.42, send: 0.28 },
  gameOver: { gain: 0.5, send: 0.3 },
};

const DEFAULT_MIX = { gain: 0.35, send: 0.12 };

// The synth coin walks up an E minor pentatonic ladder with the combo counter,
// and that climb is a big part of why a streak feels good, so the sample path
// has to keep it. These are the synth's own scale degrees
// (0 3 5 7 10 12 15 17 19 22 semitones) compressed by about 0.41 so the whole
// ladder fits inside 9 semitones.
//
// The contour is kept rather than the exact intervals for two reasons: the
// full 22 semitones would transpose a 0.42 s recording into a 0.12 s chirp,
// and a struck-metal clink is inharmonic, so it reads as "higher" rather than
// as a specific scale degree. What matters perceptually is a clear monotonic
// rise that steps wider where the pentatonic steps wider.
const COIN_SEMITONES = [0, 1.2, 2.0, 2.9, 4.1, 4.9, 6.1, 7.0, 7.8, 9.0];

// Per-pickup jitter. A line of coins that fires the identical buffer over and
// over is the classic cause of listener fatigue, so every pickup is detuned by
// up to a quarter tone and nudged in level. Small enough that it never reads
// as a wrong note, large enough to break the machine-gun effect.
const COIN_PITCH_JITTER = 0.05;  // +/- 2.5 percent
const COIN_GAIN_JITTER = 0.18;   // +/- 9 percent

// Decoded buffers by game sound name. Absent key means "use the synth".
const buffers = Object.create(null);

let loadPromise = null;
let loadedCount = 0;

function assetUrl(file) {
  try {
    return new URL('../../assets/sfx/' + file, import.meta.url).href;
  } catch (e) {
    return 'assets/sfx/' + file;
  }
}

// decodeAudioData has a promise form and an older callback-only form; support
// both so an old Safari still gets samples rather than silence.
function decode(c, arrayBuffer) {
  return new Promise((resolve, reject) => {
    let p;
    try {
      p = c.decodeAudioData(arrayBuffer, resolve, reject);
    } catch (e) {
      reject(e);
      return;
    }
    if (p && typeof p.then === 'function') p.then(resolve, reject);
  });
}

// A context purely to decode with. Samples are loaded during boot, long before
// the first user gesture creates the real AudioContext, and an
// OfflineAudioContext can be constructed without a gesture. AudioBuffers are
// not bound to the context that decoded them, so these play fine later on the
// live context.
function decodeContext() {
  const OAC = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!OAC) return null;
  try {
    return new OAC(1, 1, 44100);
  } catch (e) {
    return null;
  }
}

// Fetch and decode every sample. Idempotent: repeated calls share one promise.
// Always resolves, never rejects; the resolved number is how many samples are
// available, and any that failed simply stay procedural.
export function loadSamples(liveCtx) {
  if (loadPromise) return loadPromise;
  const c = liveCtx || decodeContext();
  if (!c || typeof fetch !== 'function') {
    loadPromise = Promise.resolve(0);
    return loadPromise;
  }
  const names = Object.keys(FILES);
  loadPromise = Promise.all(names.map((name) => (
    fetch(assetUrl(FILES[name]))
      .then((res) => {
        if (!res || !res.ok) throw new Error('http');
        return res.arrayBuffer();
      })
      .then((ab) => decode(c, ab))
      .then((buf) => {
        // A zero-length decode would be a silent sample masking the synth.
        if (buf && buf.length > 0) {
          buffers[name] = buf;
          loadedCount++;
        }
      })
      .catch(() => { /* stays procedural */ })
  ))).then(() => loadedCount, () => loadedCount);
  return loadPromise;
}

export function hasSample(name) {
  return !!buffers[name];
}

export function sampleCount() {
  return loadedCount;
}

// Drop every loaded buffer, so the next loadSamples() refetches. Used by the
// fallback test to prove the synth still covers a sound whose file vanished.
export function clearSamples() {
  for (const k in buffers) delete buffers[k];
  loadedCount = 0;
  loadPromise = null;
}

// ---------------------------------------------------------------------------
// Playback. A = { ctx, sfxBus, reverbIn } from the engine, so samples ride the
// same sfx bus and reverb send as the synth and therefore obey setSfxVol and
// setMuted with no extra work.
// ---------------------------------------------------------------------------
export function createSamplePlayer(A) {
  const { ctx, sfxBus, reverbIn } = A;

  return {
    // Returns true when a sample handled the sound, false when the caller
    // should fall through to the synth patch.
    play(name, opts) {
      const buf = buffers[name];
      if (!buf) return false;
      try {
        const o = opts || {};
        const mix = MIX[name] || DEFAULT_MIX;

        const src = ctx.createBufferSource();
        src.buffer = buf;

        // Sanitize vol the same way the synth path does: a NaN or a negative
        // reaching a gain would poison the node.
        let v = o.vol;
        if (typeof v !== 'number' || !isFinite(v) || v < 0) v = 1;
        v = Math.min(4, v);

        if (name === 'coin') {
          const step = Math.min(COIN_SEMITONES.length - 1, Math.max(0, o.combo | 0));
          const semis = COIN_SEMITONES[step];
          const detune = 1 + (Math.random() - 0.5) * COIN_PITCH_JITTER;
          src.playbackRate.value = Math.pow(2, semis / 12) * detune;
          v *= 1 + (Math.random() - 0.5) * COIN_GAIN_JITTER;
        }

        const g = ctx.createGain();
        g.gain.value = mix.gain * v;
        src.connect(g);
        g.connect(sfxBus);

        let rs = null;
        if (reverbIn && mix.send > 0) {
          rs = ctx.createGain();
          rs.gain.value = mix.send;
          g.connect(rs);
          rs.connect(reverbIn);
        }

        // One-shots are fire and forget, so release the nodes when the source
        // ends. Without this every coin would leave a live graph behind.
        src.onended = () => {
          try { src.disconnect(); } catch (e) { /* already gone */ }
          try { g.disconnect(); } catch (e) { /* already gone */ }
          if (rs) { try { rs.disconnect(); } catch (e) { /* already gone */ } }
        };

        src.start(ctx.currentTime + 0.005);
        return true;
      } catch (e) {
        // Anything unexpected hands the sound back to the synth.
        return false;
      }
    },
  };
}
