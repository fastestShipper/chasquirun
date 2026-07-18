// Chasqui Run audio engine: the single public audio surface (AudioSys).
// Owns the AudioContext, the bus layout, the generated-impulse reverb and the
// quena feedback delay. Music and SFX synthesis live in music.js / sfx.js.
//
// Graph:
//   music instruments -> musicBus -> duck -> musicVol -+-> master -> comp -> out
//   sfx one-shots     -> sfxBus  ----------> sfxVol  --+
//   ambience loops    -> ambBus  ----------> ambVol  --+
//   musicVol/sfxVol --(sends)--> convolver (2.2 s generated IR) -> master
//   quenaDelayIn -> delay 0.28 s (lowpass + fb 0.3 in loop) -> musicBus
//
// Every public method is a safe no-op before init() and never throws.

import { createMusic } from './music.js';
import { createSfx, createAmbience } from './sfx.js';

let ctx = null;
let nodes = null;
let music = null;
let sfx = null;
let amb = null;

// Settings that may arrive before the first user gesture.
const pending = { muted: false, musicVol: 1, sfxVol: 1 };

function makeNoiseBuffer(c) {
  const sr = c.sampleRate;
  const len = (sr * 2) | 0;
  const buf = c.createBuffer(1, len, sr);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * 0.8;
  return buf;
}

// Mountain air: 2.2 s of exponentially decaying stereo noise, progressively
// darkened with a one-pole lowpass whose cutoff falls along the tail.
function makeImpulse(c) {
  const sr = c.sampleRate;
  const len = Math.max(1, (sr * 2.2) | 0);
  const buf = c.createBuffer(2, len, sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lpv = 0;
    for (let i = 0; i < len; i++) {
      const p = i / len;
      const k = 0.62 - 0.5 * p;
      const w = (Math.random() * 2 - 1) * Math.exp(-4.2 * p);
      lpv += k * (w - lpv);
      d[i] = lpv;
    }
    const soft = Math.min(200, len);
    for (let i = 0; i < soft; i++) d[i] *= i / soft;
  }
  return buf;
}

function build() {
  const g = () => ctx.createGain();

  const master = g();
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -16;
  comp.knee.value = 18;
  comp.ratio.value = 3.5;
  comp.attack.value = 0.004;
  comp.release.value = 0.22;
  master.connect(comp);
  comp.connect(ctx.destination);

  const musicBus = g();
  const duck = g();
  const musicVol = g();
  musicVol.gain.value = 0.9;
  musicBus.connect(duck);
  duck.connect(musicVol);
  musicVol.connect(master);

  const sfxBus = g();
  const sfxVol = g();
  sfxBus.connect(sfxVol);
  sfxVol.connect(master);

  const ambBus = g();
  const ambVol = g();
  ambVol.gain.value = 0.8;
  ambBus.connect(ambVol);
  ambVol.connect(master);

  // Generated impulse-response reverb, fed by post-volume sends.
  const convolver = ctx.createConvolver();
  convolver.buffer = makeImpulse(ctx);
  const reverbIn = g();
  reverbIn.connect(convolver);
  const revOut = g();
  convolver.connect(revOut);
  revOut.connect(master);
  const mSend = g();
  mSend.gain.value = 0.22;
  musicVol.connect(mSend);
  mSend.connect(reverbIn);
  const sSend = g();
  sSend.gain.value = 0.16;
  sfxVol.connect(sSend);
  sSend.connect(reverbIn);

  // Quena feedback delay: 0.28 s, feedback 0.3, warmed by a lowpass.
  const quenaDelayIn = g();
  const delay = ctx.createDelay(1.0);
  delay.delayTime.value = 0.28;
  const dlp = ctx.createBiquadFilter();
  dlp.type = 'lowpass';
  dlp.frequency.value = 3500;
  const fb = g();
  fb.gain.value = 0.3;
  quenaDelayIn.connect(delay);
  delay.connect(dlp);
  dlp.connect(fb);
  fb.connect(delay);
  const dWet = g();
  dWet.gain.value = 0.55;
  dlp.connect(dWet);
  dWet.connect(musicBus);

  const noise = makeNoiseBuffer(ctx);

  return { master, comp, musicBus, duck, musicVol, sfxBus, sfxVol, ambBus, ambVol, reverbIn, quenaDelayIn, noise };
}

export const AudioSys = {
  muted: false,

  // Diagnostic only: 'none' before init, else the AudioContext state.
  get ctxState() { return ctx ? ctx.state : 'none'; },

  // Create (or resume) the AudioContext. Call on the first user gesture.
  // Idempotent; if WebAudio is unavailable, everything stays a silent no-op.
  init() {
    if (ctx) { this.resume(); return; }
    try {
      const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AC) return;
      ctx = new AC({ latencyHint: 'interactive' });
      nodes = build();
      const A = {
        ctx,
        musicBus: nodes.musicBus,
        sfxBus: nodes.sfxBus,
        ambBus: nodes.ambBus,
        reverbIn: nodes.reverbIn,
        quenaDelayIn: nodes.quenaDelayIn,
        noise: nodes.noise,
      };
      music = createMusic(A);
      sfx = createSfx(A);
      amb = createAmbience(A);
      this.setMuted(pending.muted);
      this.setMusicVol(pending.musicVol);
      this.setSfxVol(pending.sfxVol);
      this.resume();
    } catch (e) {
      // Leave whatever was built; guards below keep every call safe.
    }
  },

  resume() {
    if (!ctx || ctx.state !== 'suspended') return;
    try { ctx.resume().catch(() => {}); } catch (e) { /* fine */ }
  },

  // Hard-silence everything (hidden tab); resume() undoes it.
  suspend() {
    if (!ctx || ctx.state !== 'running') return;
    try { ctx.suspend().catch(() => {}); } catch (e) { /* fine */ }
  },

  startMusic(kind) {
    if (!music) return;
    this.resume();
    try { music.start(kind === 'menu' ? 'menu' : 'game'); } catch (e) { /* fine */ }
  },

  stopMusic(fadeSec) {
    if (!music) return;
    try { music.stop(fadeSec === undefined ? 0.8 : fadeSec); } catch (e) { /* fine */ }
  },

  // One-shot SFX. Extra names beyond the game list: 'gameOver' (alias
  // 'sting') plays the descending quena game-over phrase.
  play(name, opts) {
    if (!ctx) return;
    try {
      if (name === 'gameOver' || name === 'sting') {
        if (music) music.sting();
        return;
      }
      if (sfx) sfx.play(name, opts || {});
    } catch (e) { /* fine */ }
  },

  setAmbience(kind) {
    if (!amb) return;
    try { amb.set(kind); } catch (e) { /* fine */ }
  },

  // Sidechain-style dip of the music bus for big moments.
  duckMusic(seconds) {
    if (!nodes) return;
    const hold = Math.max(0, seconds === undefined ? 0.7 : seconds);
    const p = nodes.duck.gain;
    const t = ctx.currentTime;
    p.cancelScheduledValues(t);
    p.setValueAtTime(p.value, t);
    p.linearRampToValueAtTime(0.32, t + 0.06);
    p.setValueAtTime(0.32, t + 0.06 + hold);
    p.linearRampToValueAtTime(1, t + 0.06 + hold + 0.7);
  },

  setMuted(m) {
    this.muted = !!m;
    pending.muted = this.muted;
    if (!nodes) return;
    const p = nodes.master.gain;
    const t = ctx.currentTime;
    p.cancelScheduledValues(t);
    p.setValueAtTime(p.value, t);
    p.linearRampToValueAtTime(this.muted ? 0.0001 : 1, t + 0.12);
  },

  setMusicVol(v) {
    const vol = Math.min(1, Math.max(0, v === undefined ? 1 : v));
    pending.musicVol = vol;
    if (!nodes) return;
    nodes.musicVol.gain.setTargetAtTime(0.9 * vol, ctx.currentTime, 0.04);
  },

  setSfxVol(v) {
    const vol = Math.min(1, Math.max(0, v === undefined ? 1 : v));
    pending.sfxVol = vol;
    if (!nodes) return;
    nodes.sfxVol.gain.setTargetAtTime(vol, ctx.currentTime, 0.04);
  },
};
