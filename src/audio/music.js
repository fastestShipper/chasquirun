// Chasqui Run: procedural Andean music, composed and scheduled with WebAudio.
// Internal module: imported only by src/audio/engine.js.
//
// 96 BPM, 2/4 huayno feel, E minor pentatonic (E G A B D).
// Lookahead scheduler: 25 ms interval, 180 ms horizon. Every gain move rides
// an exponential or linear ramp and sources get scheduled stops, never hard
// cuts, so the output is click free.

const BPM = 96;
const SIXT = 60 / BPM / 4; // one sixteenth: 0.15625 s, exact in binary
const BAR = SIXT * 8;      // one 2/4 bar: 1.25 s
const LOOKAHEAD = 0.18;
const TICK_MS = 25;

const midiHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

// ---------------------------------------------------------------------------
// Composition. Notes are [midi, sixteenths, velocity, legato]; midi 0 rests.
// Each 2/4 bar sums to 8 sixteenths. Quena range E5 (76, 659.25 Hz) to E6 (88).
// ---------------------------------------------------------------------------

// Section A, the theme: a rising call in three reaches (E-G-A, then up to D6,
// then the E6 peak), answered by the huayno signature falling resolution that
// lands back home on E5 with a breath at the phrase end.
const THEME_A = [
  [76, 3, 0.85], [79, 1, 0.6], [81, 4, 0.8],
  [83, 3, 0.9], [81, 1, 0.6, 1], [79, 4, 0.75, 1],
  [81, 3, 0.8], [83, 1, 0.65, 1], [86, 4, 0.95],
  [83, 2, 0.8], [81, 2, 0.7, 1], [79, 2, 0.65, 1], [76, 2, 0.6, 1],
  [88, 3, 1.0], [86, 1, 0.7, 1], [83, 4, 0.85, 1],
  [86, 3, 0.9], [83, 1, 0.65, 1], [81, 4, 0.8, 1],
  [79, 2, 0.7], [81, 2, 0.75], [83, 2, 0.8], [81, 2, 0.7, 1],
  [79, 2, 0.65, 1], [76, 4, 0.8, 1], [0, 2],
];

// Section A': the same story told with more ornament, sixteenth turns around
// the beam notes and a longer sigh at the end.
const THEME_A2 = [
  [76, 2, 0.8], [79, 1, 0.6], [81, 1, 0.65], [83, 4, 0.9],
  [81, 1, 0.6, 1], [83, 1, 0.7, 1], [81, 1, 0.6, 1], [79, 1, 0.55, 1], [76, 4, 0.75, 1],
  [81, 2, 0.75], [83, 2, 0.8, 1], [86, 3, 0.95, 1], [88, 1, 0.8, 1],
  [86, 2, 0.85, 1], [83, 2, 0.75, 1], [81, 2, 0.7, 1], [79, 2, 0.6, 1],
  [88, 2, 0.95], [88, 1, 0.75], [86, 1, 0.7, 1], [83, 2, 0.8, 1], [86, 2, 0.85, 1],
  [83, 1, 0.7, 1], [81, 1, 0.65, 1], [79, 2, 0.6, 1], [81, 4, 0.8, 1],
  [79, 1, 0.6], [81, 1, 0.7, 1], [83, 2, 0.8, 1], [81, 2, 0.7, 1], [79, 2, 0.6, 1],
  [76, 6, 0.85, 1], [0, 2],
];

// Section B: the zampona answers in a lower, rounder voice. Longer notes,
// wide breaths, an unhurried reply to the quena's call.
const THEME_B = [
  [71, 4, 0.7], [74, 4, 0.75],
  [76, 6, 0.85], [0, 2],
  [79, 4, 0.8], [76, 2, 0.7, 1], [74, 2, 0.65, 1],
  [76, 6, 0.8, 1], [0, 2],
  [74, 4, 0.7], [76, 4, 0.8, 1],
  [79, 3, 0.85], [76, 1, 0.65, 1], [74, 4, 0.7, 1],
  [71, 2, 0.6], [74, 2, 0.7], [76, 2, 0.75, 1], [74, 2, 0.65, 1],
  [71, 6, 0.7, 1], [0, 2],
];

// Menu phrases: rubato fragments of the theme, durations in beats.
const MENU_PHRASES = [
  [[76, 0.5], [79, 0.5], [81, 1.8]],
  [[81, 0.4], [83, 0.4], [86, 1.4], [0, 0.3], [83, 0.5], [81, 1.7]],
  [[79, 0.45], [81, 0.45], [79, 0.4], [76, 2.2]],
  [[83, 0.5], [86, 0.5], [88, 1.8], [86, 0.4], [83, 1.5]],
  [[76, 0.4], [79, 0.4], [81, 0.6], [83, 1.6], [0, 0.4], [81, 0.5], [79, 1.8]],
];

// Charango voicings, bright register, five strings low to high.
const CHORDS = {
  Em: [67, 71, 76, 79, 83],
  G:  [67, 71, 74, 79, 83],
  Am: [69, 72, 76, 81, 84],
  C:  [67, 72, 76, 79, 84],
  D:  [69, 74, 78, 81, 86],
};

// Soft zampona pad roots for section B (octave 3).
const PAD_ROOT = { Em: 52, G: 55, Am: 57, C: 48, D: 50 };

// KILLA's leitmotif: three quena notes, E5 down to C#5 (a minor third), then
// down again to Bb4, the flat second of A minor. Against the E of the drone
// that last note is a tritone: the sourest interval in reach. It is a wrong
// note played on purpose by someone very pleased with herself.
const KILLA_MOTIF = [[76, 0.26, 0.62], [73, 0.22, 0.58], [70, 0.9, 0.85]];

// Huayno strum pattern over 8 sixteenths: down accent on 1, the classic
// short-short push into beat 2, an up-brush at the bar's tail.
const STRUM = [
  { d: 1, v: 1.0 }, null, { d: 1, v: 0.65 }, { d: -1, v: 0.45 },
  { d: 1, v: 0.85 }, null, { d: 1, v: 0.6 }, { d: -1, v: 0.5 },
];
const STRUM_BREAK = [
  { d: 1, v: 1.0 }, { d: -1, v: 0.35 }, { d: 1, v: 0.7 }, { d: -1, v: 0.45 },
  { d: 1, v: 0.9 }, { d: -1, v: 0.4 }, { d: 1, v: 0.65 }, { d: -1, v: 0.55 },
];

// Section B charango rolls chord tones instead of strumming.
const ARP_IDX = [0, 2, 4, 3, 4, 2, 3, 4];

const SECTIONS = {
  INTRO: { mel: null, inst: null, chords: ['Em', 'Em'] },
  A:     { mel: null, inst: 'quena', chords: ['Em', 'G', 'Am', 'Em', 'C', 'G', 'D', 'Em'] },
  A2:    { mel: null, inst: 'quena', chords: ['Em', 'G', 'Am', 'Em', 'C', 'Am', 'D', 'Em'] },
  B:     { mel: null, inst: 'zampona', chords: ['Em', 'G', 'C', 'G', 'Am', 'C', 'D', 'Em'] },
  BREAK: { mel: null, inst: null, chords: ['Em', 'Em', 'G', 'Em', 'Am', 'Em', 'D', 'Em'] },
};

// Compile a note list into a 64-slot (8 bars of sixteenths) event array.
function compile(notes) {
  const evs = new Array(64).fill(null);
  let s = 0;
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    if (n[0] > 0) evs[s] = { midi: n[0], d16: n[1], vel: n[2] || 0.8, leg: !!n[3] };
    s += n[1];
  }
  return evs;
}
SECTIONS.A.mel = compile(THEME_A);
SECTIONS.A2.mel = compile(THEME_A2);
SECTIONS.B.mel = compile(THEME_B);

// The live music instance. engine.js calls createMusic exactly once; keeping
// the handle here lets sfx.js fire the KILLA sting without the engine growing
// a new public method. Safe to call at any time, including before init().
let liveMusic = null;

// KILLA's entrance: ducks the mix, drops the drums, plays the motif naked,
// then brings everything back. Returns true if it actually fired.
export function killaSting() {
  if (!liveMusic) return false;
  try { return liveMusic.killaSting(); } catch (e) { return false; }
}

// ---------------------------------------------------------------------------
// Factory. A = { ctx, musicBus, quenaDelayIn, noise } from the engine.
// ---------------------------------------------------------------------------
export function createMusic(A) {
  const { ctx, musicBus, quenaDelayIn, noise } = A;
  const ksCache = new Map();
  let ses = null;     // active session
  let stingEnd = 0;   // KILLA sting: absolute time the mix is fully back

  // ---- Karplus-Strong charango: rendered once per pitch into a buffer, so
  // every pluck at play time is a single cheap AudioBufferSourceNode.
  function getKS(midi) {
    let b = ksCache.get(midi);
    if (b) return b;
    const sr = ctx.sampleRate;
    const len = (sr * 0.9) | 0;
    b = ctx.createBuffer(1, len, sr);
    const d = b.getChannelData(0);
    const hz = midiHz(midi);
    const period = Math.max(2, Math.round(sr / hz));
    const ring = new Float32Array(period);
    let mean = 0;
    for (let i = 0; i < period; i++) { ring[i] = Math.random() * 2 - 1; mean += ring[i]; }
    mean /= period;
    for (let i = 0; i < period; i++) ring[i] -= mean;
    const rho = Math.pow(0.001, 1 / (1.15 * hz)); // roughly T60 = 1.15 s
    for (let i = 0, j = 0; i < len; i++) {
      const cur = ring[j];
      const nj = j + 1 === period ? 0 : j + 1;
      ring[j] = rho * 0.5 * (cur + ring[nj]);
      d[i] = cur;
      j = nj;
    }
    const fade = Math.min(len, (sr * 0.04) | 0);
    for (let i = 0; i < fade; i++) d[len - 1 - i] *= i / fade;
    ksCache.set(midi, b);
    return b;
  }

  // ---- Instruments. All take an absolute AudioContext time.

  // Quena: triangle plus slightly detuned sine, delayed vibrato, breath noise,
  // a light portamento when the phrase marks legato.
  function quena(dest, t, hz, dur, vel, slideHz, breathy) {
    const lvl = 0.2 * vel;
    const g = ctx.createGain();
    g.connect(dest);
    const gp = g.gain;
    const sustT = t + Math.min(dur * 0.8, Math.max(0.07, dur * 0.7));
    gp.setValueAtTime(0.0001, t);
    gp.exponentialRampToValueAtTime(lvl, t + 0.045);
    gp.exponentialRampToValueAtTime(lvl * 0.78, sustT);
    gp.exponentialRampToValueAtTime(0.0001, t + dur + 0.06);
    const o1 = ctx.createOscillator();
    o1.type = 'triangle';
    const o2 = ctx.createOscillator();
    o2.type = 'sine';
    o2.detune.value = 7;
    const g2 = ctx.createGain();
    g2.gain.value = 0.5;
    o1.connect(g);
    o2.connect(g2);
    g2.connect(g);
    const oscs = [o1, o2];
    for (let i = 0; i < 2; i++) {
      const f = oscs[i].frequency;
      if (slideHz) {
        f.setValueAtTime(slideHz, t);
        f.exponentialRampToValueAtTime(hz, t + 0.055);
      } else {
        f.setValueAtTime(hz * 0.986, t);
        f.exponentialRampToValueAtTime(hz, t + 0.03);
      }
    }
    // Delayed-onset vibrato at 5.5 Hz.
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 5.5;
    const lg = ctx.createGain();
    lg.gain.setValueAtTime(0, t);
    lg.gain.setValueAtTime(0, t + Math.min(0.16, dur * 0.3));
    lg.gain.linearRampToValueAtTime(hz * 0.0075, t + Math.min(0.42, Math.max(0.2, dur * 0.8)));
    lfo.connect(lg);
    lg.connect(o1.frequency);
    lg.connect(o2.frequency);
    // Breath: bandpassed noise with its own soft envelope, straight to dest.
    const n = ctx.createBufferSource();
    n.buffer = noise;
    n.loop = true;
    const bf = ctx.createBiquadFilter();
    bf.type = 'bandpass';
    bf.frequency.value = Math.min(9000, hz * 2.5);
    bf.Q.value = 1.1;
    const bg = ctx.createGain();
    const bl = vel * (breathy || 0.06);
    bg.gain.setValueAtTime(0.0001, t);
    bg.gain.exponentialRampToValueAtTime(Math.max(0.0002, bl), t + 0.03);
    bg.gain.exponentialRampToValueAtTime(Math.max(0.0002, bl * 0.3), t + Math.min(0.25, dur));
    bg.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.05);
    n.connect(bf);
    bf.connect(bg);
    bg.connect(dest);
    const end = t + dur + 0.12;
    o1.start(t); o1.stop(end);
    o2.start(t); o2.stop(end);
    lfo.start(t); lfo.stop(end);
    n.start(t, Math.random() * 1.3); n.stop(end);
  }

  // Zampona: two detuned triangles chorusing, plus breathy noise band at the
  // fundamental. Rounder attack than the quena.
  function zampona(dest, t, hz, dur, vel) {
    const lvl = 0.16 * vel;
    const g = ctx.createGain();
    g.connect(dest);
    const sustT = t + Math.min(dur * 0.85, Math.max(0.1, dur * 0.7));
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(lvl, t + 0.07);
    g.gain.exponentialRampToValueAtTime(lvl * 0.8, sustT);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.09);
    const o1 = ctx.createOscillator();
    const o2 = ctx.createOscillator();
    o1.type = 'triangle'; o2.type = 'triangle';
    o1.frequency.value = hz; o2.frequency.value = hz;
    o1.detune.value = -6; o2.detune.value = 7;
    const g2 = ctx.createGain();
    g2.gain.value = 0.8;
    o1.connect(g);
    o2.connect(g2);
    g2.connect(g);
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 4.8;
    const lg = ctx.createGain();
    lg.gain.value = hz * 0.004;
    lfo.connect(lg);
    lg.connect(o1.frequency);
    lg.connect(o2.frequency);
    const n = ctx.createBufferSource();
    n.buffer = noise;
    n.loop = true;
    const bf = ctx.createBiquadFilter();
    bf.type = 'bandpass';
    bf.frequency.value = hz;
    bf.Q.value = 12;
    const bg = ctx.createGain();
    const bl = vel * 0.12;
    bg.gain.setValueAtTime(0.0001, t);
    bg.gain.exponentialRampToValueAtTime(Math.max(0.0002, bl), t + 0.05);
    bg.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.08);
    n.connect(bf);
    bf.connect(bg);
    bg.connect(dest);
    const end = t + dur + 0.15;
    o1.start(t); o1.stop(end);
    o2.start(t); o2.stop(end);
    lfo.start(t); lfo.stop(end);
    n.start(t, Math.random() * 1.3); n.stop(end);
  }

  function pluck(dest, t, midi, vel) {
    const src = ctx.createBufferSource();
    src.buffer = getKS(midi);
    const g = ctx.createGain();
    g.gain.value = 0.16 * vel;
    src.connect(g);
    g.connect(dest);
    src.start(t);
  }

  // Five strings, ~12 ms apart; an up strum reverses string order.
  function strum(dest, t, chordName, dir, vel) {
    const tones = CHORDS[chordName];
    for (let i = 0; i < tones.length; i++) {
      const k = dir > 0 ? i : tones.length - 1 - i;
      const v = vel * (i === 0 ? 1 : 0.72 + Math.random() * 0.2);
      pluck(dest, t + i * 0.012, tones[k], v);
    }
  }

  // Bombo: sine pitch drop 90 to 45 Hz plus a soft noise thump.
  function bombo(dest, t, vel) {
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(90, t);
    o.frequency.exponentialRampToValueAtTime(45, t + 0.13);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.55 * vel, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
    o.connect(g);
    g.connect(dest);
    o.start(t); o.stop(t + 0.45);
    const n = ctx.createBufferSource();
    n.buffer = noise;
    n.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 200;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.0001, t);
    ng.gain.exponentialRampToValueAtTime(0.18 * vel, t + 0.005);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    n.connect(f);
    f.connect(ng);
    ng.connect(dest);
    n.start(t, Math.random() * 1.3); n.stop(t + 0.12);
  }

  // Chajchas: two tight bright noise grains, the hoof shell rattle.
  function chajchas(dest, t, vel) {
    for (let i = 0; i < 2; i++) {
      const tt = t + i * 0.025;
      const n = ctx.createBufferSource();
      n.buffer = noise;
      n.loop = true;
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = i ? 6300 : 5400;
      f.Q.value = 1.4;
      const g = ctx.createGain();
      const v = 0.09 * vel * (i ? 0.55 : 1);
      g.gain.setValueAtTime(0.0001, tt);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, v), tt + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, tt + 0.07);
      n.connect(f);
      f.connect(g);
      g.connect(dest);
      n.start(tt, Math.random() * 1.3); n.stop(tt + 0.09);
    }
  }

  // ---- Sessions -----------------------------------------------------------

  function newSession(kind) {
    const t = ctx.currentTime;
    const song = ctx.createGain();
    song.gain.setValueAtTime(0.0001, t);
    song.gain.linearRampToValueAtTime(1, t + 0.4);
    song.connect(musicBus);
    const mk = () => { const g = ctx.createGain(); g.connect(song); return g; };
    const qBus = mk(), zBus = mk(), cBus = mk(), pBus = mk();
    const qEcho = ctx.createGain();
    qEcho.gain.value = kind === 'menu' ? 0.55 : 0.3;
    qBus.connect(qEcho);
    qEcho.connect(quenaDelayIn);
    const zEcho = ctx.createGain();
    zEcho.gain.value = 0.18;
    zBus.connect(zEcho);
    zEcho.connect(quenaDelayIn);
    return {
      kind, song, qBus, zBus, cBus, pBus,
      tails: [song, qEcho, zEcho],
      timer: 0,
      step: 0,
      nextT: t + 0.12,
      lastMel: null,
      srcs: [],          // persistent sources (menu drone) to stop on fade
      menuNext: t + 1.4,
      phraseIdx: 0,
      drumsHold: false,  // KILLA sting: percussion is dropped, not faded
      drumsUntil: 0,     // earliest time the bombo may re-enter
    };
  }

  // Menu drone: low E with a fifth and a shimmering octave, plus soft wind.
  function buildDrone(s) {
    const t = ctx.currentTime;
    const dg = ctx.createGain();
    dg.gain.setValueAtTime(0.0001, t);
    dg.gain.linearRampToValueAtTime(0.075, t + 2.5);
    dg.connect(s.song);
    const add = (midi, type, lvl, det) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = midiHz(midi);
      if (det) o.detune.value = det;
      const g = ctx.createGain();
      g.gain.value = lvl;
      o.connect(g);
      g.connect(dg);
      o.start(t);
      s.srcs.push(o);
      return o;
    };
    add(40, 'sine', 1.0, 0);        // E2
    add(47, 'sine', 0.4, 0);        // B2
    const o3 = add(52, 'triangle', 0.3, 5); // E3, slowly shimmering
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.06;
    const lg = ctx.createGain();
    lg.gain.value = 9;
    lfo.connect(lg);
    lg.connect(o3.detune);
    lfo.start(t);
    s.srcs.push(lfo);
    // Wind bed.
    const n = ctx.createBufferSource();
    n.buffer = noise;
    n.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 320;
    f.Q.value = 0.6;
    const wg = ctx.createGain();
    wg.gain.setValueAtTime(0.0001, t);
    wg.gain.linearRampToValueAtTime(0.05, t + 3);
    n.connect(f);
    f.connect(wg);
    wg.connect(s.song);
    const wl = ctx.createOscillator();
    wl.frequency.value = 0.05;
    const wlg = ctx.createGain();
    wlg.gain.value = 130;
    wl.connect(wlg);
    wlg.connect(f.frequency);
    n.start(t, Math.random() * 1.3);
    wl.start(t);
    s.srcs.push(n, wl);
  }

  // ---- Game arrangement ---------------------------------------------------
  // Bars 0-1: intro vamp. Then 24-bar cycles of A, A', B; every 4th cycle
  // swaps B for an 8-bar percussion and charango breakdown.
  function sectionAt(bar) {
    if (bar < 2) return { sec: SECTIONS.INTRO, barIn: bar };
    const b = bar - 2;
    const cyc = (b / 24) | 0;
    const bc = b % 24;
    let key;
    if (bc < 8) key = 'A';
    else if (bc < 16) key = 'A2';
    else key = (cyc & 3) === 3 ? 'BREAK' : 'B';
    return { sec: SECTIONS[key], barIn: bc & 7, brk: key === 'BREAK' };
  }

  function scheduleGameStep(s, step, t) {
    const bar = (step / 8) | 0;
    const sb = step & 7;
    const { sec, barIn, brk } = sectionAt(bar);
    const chordName = sec.chords[barIn % sec.chords.length];

    // KILLA sting: the drums are gone until the first downbeat at or after the
    // mix has come back, so the bombo always re-enters on beat 1, never mid bar.
    if (s.drumsHold) {
      if (sb === 0 && t >= s.drumsUntil) {
        s.drumsHold = false;
        const pg = s.pBus.gain;
        pg.cancelScheduledValues(t);
        pg.setValueAtTime(1, t); // silent bus, so a step here cannot click
      }
    }

    // Percussion: strong beat 1, supportive beat 2, ghost tail on odd bars.
    if (!s.drumsHold) {
      if (sb === 0) bombo(s.pBus, t, 1.0);
      if (sb === 4) bombo(s.pBus, t, brk ? 0.7 : 0.5);
      if (sb === 6 && (barIn & 1)) bombo(s.pBus, t, 0.28);
      if (brk && sb === 2) bombo(s.pBus, t, 0.4);
      if (sb === 2 || sb === 6) chajchas(s.pBus, t, 0.55);
      if (brk && (sb & 1)) chajchas(s.pBus, t, 0.32);
    }

    // Charango: huayno strums, or rolled arpeggios under the zampona.
    if (sec === SECTIONS.B) {
      const tones = CHORDS[chordName];
      pluck(s.cBus, t, tones[ARP_IDX[sb]], sb === 0 || sb === 4 ? 0.62 : 0.42);
    } else {
      const pat = brk ? STRUM_BREAK : STRUM;
      const hit = pat[sb];
      if (hit) strum(s.cBus, t, chordName, hit.d, hit.v * (brk ? 1.05 : 1));
    }

    // Melody.
    if (sec.mel) {
      const idx = barIn * 8 + sb;
      const ev = sec.mel[idx];
      if (ev) {
        const hz = midiHz(ev.midi);
        const dur = ev.d16 * SIXT * 0.96;
        let slide = 0;
        if (ev.leg && s.lastMel && s.lastMel.end === idx) slide = s.lastMel.hz;
        if (sec.inst === 'quena') quena(s.qBus, t, hz, dur, ev.vel, slide, 0.06);
        else zampona(s.zBus, t, hz, dur, ev.vel);
        s.lastMel = { hz, end: (idx + ev.d16) % 64 };
      }
      // Zampona pad root under section B, very quiet warmth.
      if (sec.inst === 'zampona' && sb === 0) {
        zampona(s.zBus, t, midiHz(PAD_ROOT[chordName]), BAR * 0.95, 0.3);
      }
    }
  }

  // ---- Menu: sparse rubato quena over the drone, echo heavy.
  function scheduleMenu(s, now) {
    if (s.menuNext > now + 0.25) return;
    let tt = Math.max(s.menuNext, now + 0.05);
    const phrase = MENU_PHRASES[s.phraseIdx % MENU_PHRASES.length];
    s.phraseIdx++;
    let prevHz = 0;
    for (let i = 0; i < phrase.length; i++) {
      const midi = phrase[i][0];
      const dur = phrase[i][1] * (60 / BPM) * (0.95 + Math.random() * 0.28);
      if (midi > 0) {
        const hz = midiHz(midi);
        const slide = prevHz && Math.random() < 0.6 ? prevHz : 0;
        quena(s.qBus, tt, hz, dur * 0.92, 0.4 + Math.random() * 0.15, slide, 0.05);
        prevHz = hz;
      } else {
        prevHz = 0;
      }
      tt += dur;
    }
    s.menuNext = tt + 2.5 + Math.random() * 4;
  }

  function tick() {
    const s = ses;
    if (!s) return;
    const now = ctx.currentTime;
    if (s.kind === 'game') {
      while (s.nextT < now + LOOKAHEAD) {
        scheduleGameStep(s, s.step, s.nextT);
        s.step++;
        s.nextT += SIXT;
      }
    } else {
      scheduleMenu(s, now);
    }
  }

  // ---- Public (to the engine) --------------------------------------------

  function start(kind) {
    if (ses && ses.kind === kind) return;
    stop(0.5);
    stingEnd = 0; // the old session took its duck with it
    ses = newSession(kind);
    if (kind === 'menu') buildDrone(ses);
    ses.timer = setInterval(tick, TICK_MS);
  }

  function stop(fade) {
    if (!ses) return;
    const s = ses;
    ses = null;
    clearInterval(s.timer);
    const t = ctx.currentTime;
    const f = Math.max(0.05, fade === undefined ? 0.8 : fade);
    const gp = s.song.gain;
    // Read the live value BEFORE cancel: cancelScheduledValues rolls the
    // param back to its pre-ramp value, which would hard-cut a fade-in.
    const live = Math.max(gp.value, 0.0001);
    gp.cancelScheduledValues(t);
    gp.setValueAtTime(live, t);
    gp.exponentialRampToValueAtTime(0.0001, t + f);
    for (let i = 0; i < s.srcs.length; i++) {
      try { s.srcs[i].stop(t + f + 0.2); } catch (e) { /* already stopped */ }
    }
    setTimeout(() => {
      for (let i = 0; i < s.tails.length; i++) {
        try { s.tails[i].disconnect(); } catch (e) { /* fine */ }
      }
    }, (f + 0.5) * 1000);
  }

  // Game-over sting: a short falling quena phrase, echoing away.
  function sting() {
    const t0 = ctx.currentTime + 0.03;
    const bus = ctx.createGain();
    bus.connect(musicBus);
    const echo = ctx.createGain();
    echo.gain.value = 0.4;
    bus.connect(echo);
    echo.connect(quenaDelayIn);
    const seq = [[83, 0.2], [81, 0.2], [79, 0.24], [76, 1.0]];
    let tt = t0;
    let prev = 0;
    for (let i = 0; i < seq.length; i++) {
      const hz = midiHz(seq[i][0]);
      const dur = seq[i][1];
      quena(bus, tt, hz, dur, i === seq.length - 1 ? 0.8 : 0.6, prev, 0.07);
      prev = hz;
      tt += dur * 0.96;
    }
    setTimeout(() => {
      try { bus.disconnect(); echo.disconnect(); } catch (e) { /* fine */ }
    }, 4000);
  }

  // KILLA's entrance sting. The motif is NOT layered over the arrangement:
  // the music stops to look at her. The mix ducks 12 dB in 80 ms, the bombo
  // and chajchas drop out completely, the three quena notes ring naked over
  // whatever drone is left, then the mix returns over 400 ms and the bombo
  // comes back in on the downbeat. The silence is the sting.
  //
  // Every gain move is scheduled up front, so the mix restores itself even if
  // nothing ever calls back in. Overlapping calls are refused, never stacked.
  function killaSting() {
    const now = ctx.currentTime;
    if (now < stingEnd) return false; // one diva at a time
    const t0 = now + 0.03;
    const DUCK = 0.2512;   // -12 dB
    const DUCK_T = 0.08;
    const REST_T = 0.4;

    // The motif rides its own bus straight into musicBus, so the duck applied
    // to the session below can never touch it.
    const bus = ctx.createGain();
    bus.connect(musicBus);
    const echo = ctx.createGain();
    echo.gain.value = 0.5;
    bus.connect(echo);
    echo.connect(quenaDelayIn);

    let tt = t0 + DUCK_T + 0.03;
    let prev = 0;
    for (let i = 0; i < KILLA_MOTIF.length; i++) {
      const hz = midiHz(KILLA_MOTIF[i][0]);
      // Slight length jitter so repeated stings are never bit identical.
      const dur = KILLA_MOTIF[i][1] * (0.96 + Math.random() * 0.08);
      quena(bus, tt, hz, dur, KILLA_MOTIF[i][2], prev, 0.08);
      prev = hz;
      tt += dur * 0.98;
    }
    const tailEnd = tt + 0.3;          // let the last note hang, alone
    const restoreEnd = tailEnd + REST_T;
    stingEnd = restoreEnd;

    const s = ses;
    if (s) {
      // Read the live value BEFORE cancel, same hazard as stop().
      const gp = s.song.gain;
      const live = Math.max(gp.value, 0.0001);
      gp.cancelScheduledValues(t0);
      gp.setValueAtTime(live, t0);
      gp.exponentialRampToValueAtTime(DUCK, t0 + DUCK_T);
      gp.setValueAtTime(DUCK, tailEnd);
      gp.exponentialRampToValueAtTime(1, restoreEnd);
      if (s.kind === 'game') {
        // Kill drum hits already sitting in the lookahead window, then stop
        // scheduling new ones until the downbeat after the restore.
        const pg = s.pBus.gain;
        pg.cancelScheduledValues(t0);
        pg.setValueAtTime(Math.max(pg.value, 0.0001), t0);
        pg.exponentialRampToValueAtTime(0.0001, t0 + 0.05);
        s.drumsHold = true;
        // The first downbeat at or after the restore BEGINS, not after it
        // ends: otherwise a downbeat landing just short of the restore costs a
        // whole extra bar of drumless music. This way the bombo lands inside
        // the 400 ms ramp and is what brings the mix back up.
        s.drumsUntil = tailEnd;
      }
      // Paranoia: if anything went sideways with the scheduled ramps, force
      // the mix back. Skipped when the session is gone or a sting is running.
      setTimeout(() => {
        if (ses !== s) return;
        const n2 = ctx.currentTime;
        if (n2 < stingEnd) return;
        if (s.song.gain.value > 0.98) return;
        s.song.gain.cancelScheduledValues(n2);
        s.song.gain.setTargetAtTime(1, n2, 0.08);
      }, (restoreEnd - now + 0.6) * 1000);
    }

    setTimeout(() => {
      try { bus.disconnect(); echo.disconnect(); } catch (e) { /* fine */ }
    }, (restoreEnd - now + 3) * 1000);
    return true;
  }

  const api = { start, stop, sting, killaSting };
  liveMusic = api;
  return api;
}
