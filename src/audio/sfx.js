// Chasqui Run: one-shot sound effects and looping biome ambiences.
// Internal module: imported only by src/audio/engine.js. Everything is
// synthesized from oscillators and one shared looping noise buffer; every
// envelope is a ramp (never a hard stop), so nothing clicks.

// The KILLA sting is a music event, not an SFX one: it takes the whole mix
// over. sfx.js only forwards the trigger so AudioSys.play('killaSting') works
// without widening the engine API.
import { killaSting as triggerKillaSting } from './music.js';

const midiHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

// Rising coin ladder: E minor pentatonic from E5 upward, one step per combo.
const COIN_SCALE = [76, 79, 81, 83, 86, 88, 91, 93, 95, 98];

// ---------------------------------------------------------------------------
// Tiny node helpers (module scope, shared by SFX and ambience).
// ---------------------------------------------------------------------------
function gainAt(ctx, v) {
  const g = ctx.createGain();
  g.gain.value = v;
  return g;
}

function filt(ctx, type, freq, Q) {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = Q === undefined ? 1 : Q;
  return f;
}

function chain(nodes) {
  for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
  return nodes[nodes.length - 1];
}

// Percussive envelope: exponential attack to peak, exponential tail to zero.
function perc(p, t, peak, a, tEnd) {
  p.setValueAtTime(0.0001, t);
  p.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + a);
  p.exponentialRampToValueAtTime(0.0001, tEnd);
}

// Small deterministic RNG so a caller can ask for the same variation twice
// (cutscene beats, replays) and still get identical audio.
function seededRng(seed) {
  let a = (Math.imul(seed | 0, 2654435761) >>> 0) || 0x9e3779b9;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

// Every KILLA vocalization pulls its jitter from here. Pass opts.variation to
// pin it, leave it out for a fresh roll. Never returns NaN.
function rndFor(o) {
  const v = o ? o.variation : undefined;
  if (typeof v === 'number' && isFinite(v)) return seededRng(Math.round(v));
  return Math.random;
}

// Sanitize opts.vol. A NaN or a zero reaching an exponential ramp target is a
// RangeError, and one throw here takes down every later sound in the game.
function volOf(o) {
  const v = o ? o.vol : undefined;
  if (typeof v !== 'number' || !isFinite(v) || v < 0) return 1;
  return Math.min(4, v);
}

// Exponential ramps cannot reach zero; this is the floor every peak goes through.
const lvl = (x) => Math.max(0.0002, x);

// ---------------------------------------------------------------------------
// One-shot SFX. A = { ctx, sfxBus, reverbIn, noise } from the engine.
// ---------------------------------------------------------------------------
export function createSfx(A) {
  const { ctx, sfxBus, reverbIn, noise } = A;

  function osc(type, freq, t0, t1) {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    o.start(t0);
    o.stop(t1);
    return o;
  }

  function nz(t0, t1, rate) {
    const s = ctx.createBufferSource();
    s.buffer = noise;
    s.loop = true;
    if (rate) s.playbackRate.value = rate;
    s.start(t0, Math.random() * 1.3);
    s.stop(t1);
    return s;
  }

  function pan(v) {
    const p = ctx.createStereoPanner();
    p.pan.value = v;
    return p;
  }

  // -------------------------------------------------------------------------
  // KILLA, the smug diva llama. One patch, many envelopes.
  //
  // A llama is a nasal instrument: everything she says leaves a sawtooth
  // larynx (165-200 Hz), travels a long tube and exits a small opening. That
  // tube is a bandpass at 850 Hz with Q 6, a parallel bandpass at 1900 Hz at
  // half gain, and about 8 percent filtered breath noise. Nothing below adds
  // a new timbre; each vocalization is only a different envelope on this.
  //
  // Returns the live nodes so callers can shape saw.frequency, lp.frequency
  // and amp.gain. The caller owns every envelope; this builds no envelope of
  // its own beyond a silent starting gain.
  function killaVoice(t, tEnd, cfg) {
    const c = cfg || {};
    const f1 = c.f1 || 850;
    const f2 = c.f2 || 1900;
    const stop = tEnd + 0.06;
    const saw = osc('sawtooth', c.hz || 180, t, stop);
    const mix = gainAt(ctx, 1);
    const b1 = filt(ctx, 'bandpass', f1, 6);
    const b1g = gainAt(ctx, 1);
    const b2 = filt(ctx, 'bandpass', f2, 6);
    const b2g = gainAt(ctx, 0.5);
    chain([saw, b1, b1g, mix]);
    chain([saw, b2, b2g, mix]);
    // Breath, sitting between the two formants.
    const bn = filt(ctx, 'bandpass', f2 * 0.7, 1.2);
    const bng = gainAt(ctx, 0.08 * (c.breath === undefined ? 1 : c.breath));
    chain([nz(t, stop, 1), bn, bng, mix]);
    // The mouth opening. Callers that turn away sweep this down.
    const lp = filt(ctx, 'lowpass', c.lp || 6000, 0.9);
    const amp = gainAt(ctx, 0.0001);
    chain([mix, lp, amp, sfxBus]);
    const rs = gainAt(ctx, c.send === undefined ? 0.18 : c.send);
    amp.connect(rs);
    rs.connect(reverbIn);
    return { saw, mix, lp, amp, b1, b2 };
  }

  const H = {
    jump(o, t) {
      const v = o.vol === undefined ? 1 : o.vol;
      const g = gainAt(ctx, 0);
      const f = filt(ctx, 'bandpass', 420, 1.2);
      f.frequency.setValueAtTime(420, t);
      f.frequency.exponentialRampToValueAtTime(1600, t + 0.18);
      chain([nz(t, t + 0.3), f, g, sfxBus]);
      perc(g.gain, t, 0.15 * v, 0.02, t + 0.28);
      const b = osc('sine', 660, t, t + 0.18);
      b.frequency.exponentialRampToValueAtTime(880, t + 0.12);
      const bg = gainAt(ctx, 0);
      chain([b, bg, sfxBus]);
      perc(bg.gain, t, 0.05 * v, 0.01, t + 0.16);
    },

    slide(o, t) {
      const v = o.vol === undefined ? 1 : o.vol;
      const f = filt(ctx, 'lowpass', 900, 0.7);
      f.frequency.exponentialRampToValueAtTime(340, t + 0.4);
      const g = gainAt(ctx, 0);
      chain([nz(t, t + 0.5, 0.85), f, g, sfxBus]);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.2 * v, t + 0.03);
      g.gain.exponentialRampToValueAtTime(0.12 * v, t + 0.25);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
      const grit = filt(ctx, 'bandpass', 2100, 2);
      const gg = gainAt(ctx, 0);
      chain([nz(t, t + 0.3), grit, gg, sfxBus]);
      perc(gg.gain, t, 0.03 * v, 0.02, t + 0.28);
    },

    footstep(o, t) {
      const v = (o.vol === undefined ? 1 : o.vol) * 0.9;
      const foot = o.foot ? 1 : 0;
      const f = filt(ctx, 'lowpass', foot ? 350 : 300, 0.8);
      const g = gainAt(ctx, 0);
      chain([nz(t, t + 0.12), f, g, pan(foot ? 0.12 : -0.12), sfxBus]);
      perc(g.gain, t, 0.13 * v, 0.008, t + 0.09);
      const tick = filt(ctx, 'bandpass', 2000, 2);
      const tg = gainAt(ctx, 0);
      chain([nz(t, t + 0.05), tick, tg, sfxBus]);
      perc(tg.gain, t, 0.015 * v, 0.004, t + 0.04);
    },

    coin(o, t) {
      const idx = Math.min(COIN_SCALE.length - 1, Math.max(0, o.combo | 0));
      const hz = midiHz(COIN_SCALE[idx]);
      const v = o.vol === undefined ? 1 : o.vol;
      const g = gainAt(ctx, 0);
      g.connect(sfxBus);
      const rs = gainAt(ctx, 0.12);
      g.connect(rs);
      rs.connect(reverbIn);
      chain([osc('sine', hz, t, t + 0.34), g]);
      const h2 = gainAt(ctx, 0.35);
      chain([osc('sine', hz * 2.01, t, t + 0.34), h2, g]);
      perc(g.gain, t, 0.2 * v, 0.008, t + 0.3);
      const sp = filt(ctx, 'bandpass', Math.min(11000, hz * 4), 8);
      const sg = gainAt(ctx, 0);
      chain([nz(t, t + 0.12), sp, sg, sfxBus]);
      perc(sg.gain, t, 0.02 * v, 0.005, t + 0.1);
    },

    chakana(o, t) {
      // Three ascending bell tones with mountain air behind them.
      const notes = [88, 91, 95]; // E6 G6 B6
      for (let i = 0; i < 3; i++) {
        const hz = midiHz(notes[i]);
        const tt = t + i * 0.07;
        const g = gainAt(ctx, 0);
        g.connect(sfxBus);
        const rs = gainAt(ctx, 0.3);
        g.connect(rs);
        rs.connect(reverbIn);
        chain([osc('sine', hz, tt, tt + 0.6), g]);
        const h2 = gainAt(ctx, 0.3);
        chain([osc('sine', hz * 2.01, tt, tt + 0.6), h2, g]);
        perc(g.gain, tt, 0.14, 0.01, tt + 0.55);
      }
    },

    powerup(o, t) {
      const g = gainAt(ctx, 0);
      const f = filt(ctx, 'bandpass', 800, 1.6);
      f.frequency.exponentialRampToValueAtTime(2600, t + 0.4);
      const o1 = osc('triangle', 659.25, t, t + 0.5);
      const o2 = osc('sine', 662, t, t + 0.5);
      o1.frequency.exponentialRampToValueAtTime(1318.5, t + 0.4);
      o2.frequency.exponentialRampToValueAtTime(1325, t + 0.4);
      o1.connect(f);
      o2.connect(f);
      chain([f, g, sfxBus]);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.16, t + 0.06);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
      const sp = filt(ctx, 'bandpass', 4200, 3);
      const sg = gainAt(ctx, 0);
      chain([nz(t, t + 0.5), sp, sg, sfxBus]);
      const rs = gainAt(ctx, 0.3);
      g.connect(rs);
      rs.connect(reverbIn);
      perc(sg.gain, t + 0.1, 0.03, 0.08, t + 0.48);
    },

    shieldSave(o, t) {
      // Inharmonic golden clang: the shield takes the hit.
      const f0 = 320;
      const parts = [1, 2.76, 5.4, 8.93];
      const amps = [0.2, 0.12, 0.07, 0.035];
      for (let i = 0; i < parts.length; i++) {
        const g = gainAt(ctx, 0);
        chain([osc('sine', f0 * parts[i], t, t + 0.6), g, sfxBus]);
        perc(g.gain, t, amps[i], 0.006, t + 0.55 - i * 0.08);
      }
      const cl = filt(ctx, 'bandpass', 1900, 2);
      const cg = gainAt(ctx, 0);
      chain([nz(t, t + 0.08), cl, cg, sfxBus]);
      perc(cg.gain, t, 0.1, 0.004, t + 0.06);
      const rs = gainAt(ctx, 0.25);
      cg.connect(rs);
      rs.connect(reverbIn);
    },

    crash(o, t) {
      // Stone hits stone: low drop, heavy rubble, sharp crack.
      const low = osc('sine', 130, t, t + 0.55);
      low.frequency.exponentialRampToValueAtTime(45, t + 0.25);
      const lg = gainAt(ctx, 0);
      chain([low, lg, sfxBus]);
      perc(lg.gain, t, 0.45, 0.008, t + 0.5);
      const rf = filt(ctx, 'lowpass', 1200, 0.8);
      rf.frequency.exponentialRampToValueAtTime(250, t + 0.35);
      const rg = gainAt(ctx, 0);
      chain([nz(t, t + 0.5), rf, rg, sfxBus]);
      perc(rg.gain, t, 0.38, 0.01, t + 0.42);
      const ck = filt(ctx, 'bandpass', 2400, 2);
      const cg = gainAt(ctx, 0);
      chain([nz(t, t + 0.06), ck, cg, sfxBus]);
      perc(cg.gain, t, 0.18, 0.003, t + 0.05);
    },

    fall(o, t) {
      // Comedic descending whistle with wind rushing up.
      const w = osc('sine', 660, t, t + 0.85);
      w.frequency.exponentialRampToValueAtTime(240, t + 0.8);
      const lfo = osc('sine', 7, t, t + 0.85);
      const lg = gainAt(ctx, 14);
      lfo.connect(lg);
      lg.connect(w.frequency);
      const wg = gainAt(ctx, 0);
      chain([w, wg, sfxBus]);
      wg.gain.setValueAtTime(0.0001, t);
      wg.gain.exponentialRampToValueAtTime(0.12, t + 0.05);
      wg.gain.exponentialRampToValueAtTime(0.0001, t + 0.85);
      const nf = filt(ctx, 'bandpass', 900, 1);
      const ng = gainAt(ctx, 0);
      chain([nz(t, t + 1), nf, ng, sfxBus]);
      ng.gain.setValueAtTime(0.0001, t);
      ng.gain.exponentialRampToValueAtTime(0.1, t + 0.5);
      ng.gain.exponentialRampToValueAtTime(0.0001, t + 1);
    },

    splash(o, t) {
      const f = filt(ctx, 'lowpass', 1500, 0.8);
      f.frequency.exponentialRampToValueAtTime(500, t + 0.45);
      const g = gainAt(ctx, 0);
      chain([nz(t, t + 0.55, 1.1), f, g, sfxBus]);
      perc(g.gain, t, 0.3, 0.012, t + 0.5);
      for (let i = 0; i < 3; i++) {
        const tt = t + 0.12 + i * 0.09 + Math.random() * 0.05;
        const d = osc('sine', 900 + Math.random() * 1000, tt, tt + 0.07);
        d.frequency.exponentialRampToValueAtTime(d.frequency.value * 1.6, tt + 0.05);
        const dg = gainAt(ctx, 0);
        chain([d, dg, sfxBus]);
        perc(dg.gain, tt, 0.04, 0.008, tt + 0.06);
      }
    },

    whoosh(o, t) {
      const f = filt(ctx, 'bandpass', 350, 1.3);
      f.frequency.setValueAtTime(350, t);
      f.frequency.exponentialRampToValueAtTime(2200, t + 0.14);
      f.frequency.exponentialRampToValueAtTime(500, t + 0.3);
      const g = gainAt(ctx, 0);
      chain([nz(t, t + 0.35, 1.2), f, g, sfxBus]);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.18, t + 0.1);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
    },

    pututu(o, t) {
      // The conch horn: layered near-harmonic sines with a pitch scoop into
      // the note, two formant bands, and a breathy attack. 1.2 seconds.
      const v = o.vol === undefined ? 1 : o.vol;
      const dur = 1.2;
      const f0 = 205;
      const mix = gainAt(ctx, 1);
      const g = gainAt(ctx, 0);
      const fm1 = filt(ctx, 'bandpass', 480, 3);
      const fm2 = filt(ctx, 'bandpass', 950, 4);
      const body = filt(ctx, 'lowpass', 1400, 0.6);
      const g1 = gainAt(ctx, 0.9), g2 = gainAt(ctx, 0.5), g3 = gainAt(ctx, 0.55);
      chain([mix, fm1, g1, g]);
      chain([mix, fm2, g2, g]);
      chain([mix, body, g3, g]);
      g.connect(sfxBus);
      const rs = gainAt(ctx, 0.35);
      g.connect(rs);
      rs.connect(reverbIn);
      const lfo = osc('sine', 4.6, t, t + dur + 0.1);
      const lg = gainAt(ctx, 0);
      lg.gain.setValueAtTime(0, t);
      lg.gain.setValueAtTime(0, t + 0.35);
      lg.gain.linearRampToValueAtTime(2.6, t + 0.8);
      lfo.connect(lg);
      const parts = [1, 2, 3, 4.02];
      const amps = [1, 0.5, 0.22, 0.09];
      for (let i = 0; i < parts.length; i++) {
        const p = osc('sine', f0 * parts[i], t, t + dur + 0.15);
        p.frequency.setValueAtTime(f0 * parts[i] * 0.92, t);
        p.frequency.exponentialRampToValueAtTime(f0 * parts[i], t + 0.09);
        lg.connect(p.frequency);
        const pg = gainAt(ctx, amps[i]);
        chain([p, pg, mix]);
      }
      const bf = filt(ctx, 'bandpass', 600, 0.8);
      const bg = gainAt(ctx, 0);
      chain([nz(t, t + dur, 0.9), bf, bg, mix]);
      bg.gain.setValueAtTime(0.0001, t);
      bg.gain.linearRampToValueAtTime(0.5, t + 0.06);
      bg.gain.exponentialRampToValueAtTime(0.12, t + 0.5);
      bg.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.5 * v, t + 0.16);
      g.gain.linearRampToValueAtTime(0.62 * v, t + 0.75);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.08);
    },

    uiClick(o, t) {
      const g = gainAt(ctx, 0);
      chain([osc('sine', 1150, t, t + 0.07), g, sfxBus]);
      perc(g.gain, t, 0.08, 0.004, t + 0.055);
      const tk = filt(ctx, 'highpass', 3000, 0.7);
      const tg = gainAt(ctx, 0);
      chain([nz(t, t + 0.03), tk, tg, sfxBus]);
      perc(tg.gain, t, 0.025, 0.003, t + 0.02);
    },

    record(o, t) {
      // A bright two-note quena fanfare: B5 up to a long E6.
      const notes = [[987.77, 0, 0.18], [1318.5, 0.16, 0.6]];
      for (let i = 0; i < 2; i++) {
        const hz = notes[i][0];
        const tt = t + notes[i][1];
        const dd = notes[i][2];
        const g = gainAt(ctx, 0);
        g.connect(sfxBus);
        const rs = gainAt(ctx, 0.3);
        g.connect(rs);
        rs.connect(reverbIn);
        const o1 = osc('triangle', hz, tt, tt + dd + 0.05);
        const o2 = osc('sine', hz * 1.004, tt, tt + dd + 0.05);
        const g2 = gainAt(ctx, 0.5);
        o1.connect(g);
        chain([o2, g2, g]);
        g.gain.setValueAtTime(0.0001, tt);
        g.gain.exponentialRampToValueAtTime(0.16, tt + 0.03);
        g.gain.exponentialRampToValueAtTime(0.0001, tt + dd);
        if (i === 1) {
          const lfo = osc('sine', 5.5, tt, tt + dd);
          const lg = gainAt(ctx, 0);
          lg.gain.setValueAtTime(0, tt);
          lg.gain.linearRampToValueAtTime(hz * 0.007, tt + 0.3);
          lfo.connect(lg);
          lg.connect(o1.frequency);
          lg.connect(o2.frequency);
        }
      }
      const sp = filt(ctx, 'bandpass', 5200, 5);
      const sg = gainAt(ctx, 0);
      chain([nz(t, t + 0.7), sp, sg, sfxBus]);
      perc(sg.gain, t + 0.14, 0.03, 0.06, t + 0.65);
    },

    gust(o, t) {
      const f = filt(ctx, 'bandpass', 300, 0.8);
      f.frequency.setValueAtTime(300, t);
      f.frequency.exponentialRampToValueAtTime(900, t + 0.4);
      f.frequency.exponentialRampToValueAtTime(350, t + 0.85);
      const p = pan(-0.3);
      p.pan.linearRampToValueAtTime(0.3, t + 0.85);
      const g = gainAt(ctx, 0);
      chain([nz(t, t + 0.95), f, g, p, sfxBus]);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.16, t + 0.3);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
    },

    llama(o, t) {
      // Comedic bleat: buzzy saw through throat formants with fast tremolo.
      const dur = 0.42;
      const s = osc('sawtooth', 430, t, t + dur + 0.05);
      s.frequency.setValueAtTime(430, t);
      s.frequency.exponentialRampToValueAtTime(500, t + 0.06);
      s.frequency.exponentialRampToValueAtTime(380, t + 0.38);
      const am = gainAt(ctx, 0.55);
      const lfo = osc('sine', 14, t, t + dur + 0.05);
      const lg = gainAt(ctx, 0.38);
      lfo.connect(lg);
      lg.connect(am.gain);
      const f1 = filt(ctx, 'bandpass', 850, 2.5);
      const f2 = filt(ctx, 'bandpass', 1700, 3);
      const f2g = gainAt(ctx, 0.4);
      s.connect(f1);
      s.connect(f2);
      const g = gainAt(ctx, 0);
      f1.connect(am);
      chain([f2, f2g, am]);
      chain([am, g, sfxBus]);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.15, t + 0.03);
      g.gain.exponentialRampToValueAtTime(0.11, t + 0.3);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    },

    // ---- RAYO DE INTI. Both take opts.vol and opts.variation. -------------

    // The sun god strikes the runner. Three stages, about 1.5 s total:
    //   1. GATHER  (130 ms) air rushes inward, then a sliver of silence.
    //   2. STRIKE  (the hit) crack + chest-thump body + golden shimmer.
    //   3. BLESSING (1.25 s) an open chord on A blooms and decays while the
    //      boost runs.
    // Everything is rooted on A so it sits inside the E minor pentatonic the
    // music engine plays (E G A B D). The shimmer and the chord are strict
    // octaves and fifths: harmonic and open reads as golden and sacred, while
    // inharmonic bell ratios would read as an electric zap.
    intiStrike(o, t) {
      const r = rndFor(o);
      const v = volOf(o);
      const A0 = 110;            // A2, the root of the whole event
      const tHit = t + 0.13;     // stage 2 lands here
      const tB = tHit + 0.05;    // stage 3 blooms just behind the hit
      const dur = 1.25;          // length of the blessing tail

      // --- Stage 1: the gather -------------------------------------------
      // Filtered noise sweeping up as the air is pulled in. It cuts out at
      // 118 ms, so there are 12 ms of near silence before the hit: that gap
      // is what makes the strike land.
      const gf = filt(ctx, 'bandpass', 240, 1.1);
      gf.frequency.setValueAtTime(240 * (0.92 + r() * 0.16), t);
      gf.frequency.exponentialRampToValueAtTime(4200, t + 0.105);
      const gg = gainAt(ctx, 0);
      chain([nz(t, tHit + 0.02, 1.35), gf, gg, sfxBus]);
      gg.gain.setValueAtTime(0.0001, t);
      gg.gain.exponentialRampToValueAtTime(lvl(0.17 * v), t + 0.095);
      gg.gain.exponentialRampToValueAtTime(0.0001, t + 0.118);

      // The suck: a thin tone climbing with the noise.
      const sk = osc('triangle', 220, t, t + 0.13);
      sk.frequency.setValueAtTime(220, t);
      sk.frequency.exponentialRampToValueAtTime(1500, t + 0.105);
      const skg = gainAt(ctx, 0);
      chain([sk, skg, sfxBus]);
      skg.gain.setValueAtTime(0.0001, t);
      skg.gain.exponentialRampToValueAtTime(lvl(0.06 * v), t + 0.09);
      skg.gain.exponentialRampToValueAtTime(0.0001, t + 0.118);

      // --- Stage 2a: the crack -------------------------------------------
      const hp = filt(ctx, 'highpass', 2600, 0.7);
      hp.frequency.setValueAtTime(2600 * (0.9 + r() * 0.2), tHit);
      hp.frequency.exponentialRampToValueAtTime(5400, tHit + 0.05);
      const cg = gainAt(ctx, 0);
      chain([nz(tHit, tHit + 0.1, 1.5), hp, cg, sfxBus]);
      perc(cg.gain, tHit, 0.3 * v, 0.002, tHit + 0.06);
      const crs = gainAt(ctx, 0.2);
      cg.connect(crs);
      crs.connect(reverbIn);

      // --- Stage 2b: the body --------------------------------------------
      // Sine dropping 190 -> 41 Hz in 110 ms. Short on purpose: any longer
      // and the thunder turns into mud under the chord.
      const low = osc('sine', 190, tHit, tHit + 0.5);
      low.frequency.setValueAtTime(190, tHit);
      low.frequency.exponentialRampToValueAtTime(55, tHit + 0.11);
      low.frequency.exponentialRampToValueAtTime(41, tHit + 0.4);
      const lg = gainAt(ctx, 0);
      chain([low, lg, sfxBus]);
      perc(lg.gain, tHit, 0.5 * v, 0.006, tHit + 0.42);
      // A triangle an octave under the root gives the drop some edge.
      const tri = osc('triangle', A0, tHit, tHit + 0.28);
      tri.frequency.setValueAtTime(A0, tHit);
      tri.frequency.exponentialRampToValueAtTime(52, tHit + 0.12);
      const trlp = filt(ctx, 'lowpass', 900, 0.8);
      const trg = gainAt(ctx, 0);
      chain([tri, trlp, trg, sfxBus]);
      perc(trg.gain, tHit, 0.16 * v, 0.005, tHit + 0.24);

      // --- Stage 2c: the golden shimmer ----------------------------------
      // A E A E stacked over A4, each partial doubled a few cents apart so it
      // glitters instead of ringing like metal.
      const shim = gainAt(ctx, 0);
      shim.connect(sfxBus);
      const shrs = gainAt(ctx, 0.3);
      shim.connect(shrs);
      shrs.connect(reverbIn);
      const SH = [4, 6, 8, 12];          // A4 E5 A5 E6 against A2
      const SHA = [0.5, 0.34, 0.24, 0.13];
      for (let i = 0; i < SH.length; i++) {
        const hz = A0 * SH[i];
        const det = 1 + (0.002 + r() * 0.003);
        const pg = gainAt(ctx, SHA[i]);
        pg.connect(shim);
        chain([osc('sine', hz, tHit, tHit + 0.62), pg]);
        chain([osc('sine', hz * det, tHit, tHit + 0.62), gainAt(ctx, SHA[i] * 0.6), pg]);
      }
      perc(shim.gain, tHit, 0.19 * v, 0.004, tHit + 0.58);

      // --- Stage 3: the blessing -----------------------------------------
      // Octaves and fifths on A, opened by a slow lowpass and pushed into the
      // reverb. This is the "you are empowered" bed under the boost.
      const mix = gainAt(ctx, 1);
      const clp = filt(ctx, 'lowpass', 420, 0.9);
      clp.frequency.setValueAtTime(420, tB);
      clp.frequency.exponentialRampToValueAtTime(5200, tB + 0.6);
      clp.frequency.exponentialRampToValueAtTime(1500, tB + dur);
      const cout = gainAt(ctx, 0);
      chain([mix, clp, cout, sfxBus]);
      const brs = gainAt(ctx, 0.45);
      cout.connect(brs);
      brs.connect(reverbIn);

      // Quena-style vibrato with a delayed onset. vg carries a 0..1 envelope;
      // each partial scales it by its own frequency so the depth stays even.
      const vib = osc('sine', 5.5, tB, tB + dur + 0.1);
      const vg = gainAt(ctx, 0);
      vg.gain.setValueAtTime(0, tB);
      vg.gain.setValueAtTime(0, tB + 0.3);
      vg.gain.linearRampToValueAtTime(1, tB + 0.85);
      vib.connect(vg);

      const CH = [1, 2, 3, 4, 6, 8];     // A2 A3 E4 A4 E5 A5
      const CHA = [0.2, 0.3, 0.2, 0.26, 0.16, 0.1];
      for (let i = 0; i < CH.length; i++) {
        const hz = A0 * CH[i];
        const pg = gainAt(ctx, CHA[i]);
        pg.connect(mix);
        const main = osc(hz < 500 ? 'triangle' : 'sine', hz, tB, tB + dur + 0.08);
        main.connect(pg);
        const det = osc('sine', hz * (1 + 0.003 + r() * 0.002), tB, tB + dur + 0.08);
        chain([det, gainAt(ctx, 0.4), pg]);
        const vd = gainAt(ctx, hz * 0.005);
        vg.connect(vd);
        vd.connect(main.frequency);
        vd.connect(det.frequency);
      }

      // Quena breath sitting on the chord's formant region.
      const bf = filt(ctx, 'bandpass', 1250 * (0.94 + r() * 0.12), 1.5);
      const bg = gainAt(ctx, 0);
      chain([nz(tB, tB + dur, 0.95), bf, bg, mix]);
      bg.gain.setValueAtTime(0.0001, tB);
      bg.gain.exponentialRampToValueAtTime(lvl(0.055), tB + 0.32);
      bg.gain.exponentialRampToValueAtTime(0.0001, tB + dur * 0.92);

      // The bloom is fast (130 ms) so it fills the hole the strike body leaves
      // as it dies. The long decay is LINEAR on purpose: an exponential ramp
      // to the floor loses 90 percent of its level in the first third of the
      // interval, which collapsed this tail to about 0.5 s in the render.
      cout.gain.setValueAtTime(0.0001, tB);
      cout.gain.exponentialRampToValueAtTime(lvl(0.26 * v), tB + 0.13);
      cout.gain.linearRampToValueAtTime(lvl(0.2 * v), tB + 0.5);
      cout.gain.linearRampToValueAtTime(lvl(0.06 * v), tB + dur * 0.82);
      cout.gain.exponentialRampToValueAtTime(0.0001, tB + dur);
    },

    // The boost expires: the radiance withdraws. Same open chord on A, but it
    // thins from the top down onto the root while the filter closes and the
    // air drifts away. Consonant and unhurried, so it never reads as damage.
    intiEnd(o, t) {
      const r = rndFor(o);
      const v = volOf(o);
      const dur = 0.4;
      const mix = gainAt(ctx, 1);
      const lp = filt(ctx, 'lowpass', 4200, 0.8);
      lp.frequency.setValueAtTime(4200, t);
      lp.frequency.exponentialRampToValueAtTime(900, t + dur + 0.04);
      const out = gainAt(ctx, 1);
      chain([mix, lp, out, sfxBus]);
      const rs = gainAt(ctx, 0.35);
      out.connect(rs);
      rs.connect(reverbIn);

      // A5, E5, A4. The top voice leaves first, the root holds longest.
      // Hand-written envelopes rather than perc(): a percussive exponential
      // would snap the light off in 100 ms, and this has to ebb, not stop.
      const HZ = [880, 659.25, 440];
      const AMP = [0.05, 0.07, 0.09];
      const END = [0.2, 0.29, dur];
      for (let i = 0; i < HZ.length; i++) {
        const hz = HZ[i] * (1 + (r() - 0.5) * 0.004);
        const g = gainAt(ctx, 0);
        chain([osc(i === 2 ? 'triangle' : 'sine', hz, t, t + END[i] + 0.06), g, mix]);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(lvl(AMP[i] * v), t + 0.045);
        g.gain.linearRampToValueAtTime(lvl(AMP[i] * v * 0.35), t + END[i] * 0.75);
        g.gain.exponentialRampToValueAtTime(0.0001, t + END[i]);
      }

      // The light leaving as air, sweeping down and out.
      const af = filt(ctx, 'bandpass', 2600, 1.2);
      af.frequency.setValueAtTime(2600 * (0.92 + r() * 0.16), t);
      af.frequency.exponentialRampToValueAtTime(700, t + dur);
      const ag = gainAt(ctx, 0);
      chain([nz(t, t + dur + 0.05, 0.9), af, ag, mix]);
      ag.gain.setValueAtTime(0.0001, t);
      ag.gain.exponentialRampToValueAtTime(lvl(0.035 * v), t + 0.08);
      ag.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    },

    // ---- KILLA. All of these take opts.vol and opts.variation. ------------

    // Neutral hum, her first appearance. The pitch sags, then bends UP 40
    // cents on the last breath. That terminal rise is a raised eyebrow.
    killaOrgle(o, t) {
      const r = rndFor(o);
      const v = volOf(o);
      const dur = 0.7 * (0.94 + r() * 0.14);
      const hz0 = 180 * (0.97 + r() * 0.06);
      const hz1 = 165 * (0.97 + r() * 0.06);
      const hz2 = hz1 * Math.pow(2, 40 / 1200); // the eyebrow
      const k = killaVoice(t, t + dur, {
        hz: hz0,
        f1: 850 * (0.95 + r() * 0.1),
        f2: 1900 * (0.95 + r() * 0.1),
      });
      const f = k.saw.frequency;
      f.setValueAtTime(hz0, t);
      f.exponentialRampToValueAtTime(hz1, t + dur * 0.78);
      f.exponentialRampToValueAtTime(hz2, t + dur);
      const g = k.amp.gain;
      g.setValueAtTime(0.0001, t);
      g.exponentialRampToValueAtTime(lvl(0.26 * v), t + 0.07);
      g.exponentialRampToValueAtTime(lvl(0.2 * v), t + dur * 0.8);
      g.exponentialRampToValueAtTime(0.0001, t + dur + 0.05);
    },

    // The laugh. The same patch gated by a 9 Hz square (55 ms on, 55 ms off),
    // scheduled by hand so it is EXACTLY four pulses: five sounds like a
    // machine, three sounds like a hiccup. Each pulse drops a semitone and the
    // mouth closes from 2 kHz to 700 Hz, so she is turning away as she laughs.
    killaChuckle(o, t) {
      const r = rndFor(o);
      const v = volOf(o);
      const ON = 0.055;
      const OFF = 0.055;
      const N = 4;
      const span = N * (ON + OFF);
      const base = 192 * (0.96 + r() * 0.09);
      const k = killaVoice(t, t + span, {
        hz: base,
        f1: 880 * (0.95 + r() * 0.1),
        f2: 1900 * (0.95 + r() * 0.1),
        lp: 2000,
      });
      k.lp.frequency.setValueAtTime(2000, t);
      k.lp.frequency.exponentialRampToValueAtTime(700, t + span);
      const f = k.saw.frequency;
      const g = k.amp.gain;
      g.setValueAtTime(0.0001, t);
      for (let i = 0; i < N; i++) {
        const ts = t + i * (ON + OFF);
        f.setValueAtTime(base * Math.pow(2, -i / 12), ts);
        g.setValueAtTime(0.0001, ts);
        g.exponentialRampToValueAtTime(lvl(0.3 * v * (1 - i * 0.08)), ts + 0.012);
        g.exponentialRampToValueAtTime(0.0001, ts + ON);
      }
    },

    // Spit: a 40 ms hiss of air, a 90 ms wet body falling fast, then the
    // landing 120 ms later. The gap between them is what sells the distance.
    killaSpit(o, t) {
      const r = rndFor(o);
      const v = volOf(o);
      const hp = filt(ctx, 'highpass', 3500 * (0.92 + r() * 0.16), 0.8);
      const hg = gainAt(ctx, 0);
      chain([nz(t, t + 0.06, 1.1), hp, hg, sfxBus]);
      perc(hg.gain, t, 0.13 * v, 0.004, t + 0.04);
      const bp = filt(ctx, 'bandpass', 380, 3.5);
      bp.frequency.setValueAtTime(380 * (0.9 + r() * 0.2), t);
      bp.frequency.exponentialRampToValueAtTime(150, t + 0.09);
      const wg = gainAt(ctx, 0);
      chain([nz(t, t + 0.12, 0.8), bp, wg, sfxBus]);
      perc(wg.gain, t, 0.22 * v, 0.006, t + 0.09);
      const tl = t + 0.09 + 0.12 + r() * 0.05;
      const lp = filt(ctx, 'lowpass', 200 * (0.9 + r() * 0.2), 1);
      const lg = gainAt(ctx, 0);
      chain([nz(tl, tl + 0.09), lp, lg, sfxBus]);
      perc(lg.gain, tl, 0.1 * v, 0.005, tl + 0.06);
    },

    // A short jeering orgle: pitched up, contour flipped into a taunt, and a
    // rude buzz on the larynx. Ends on the same eyebrow, ruder.
    killaTaunt(o, t) {
      const r = rndFor(o);
      const v = volOf(o);
      const dur = 0.34 * (0.88 + r() * 0.3);
      const hz0 = 205 * (1 + r() * 0.14);
      const k = killaVoice(t, t + dur, {
        hz: hz0,
        f1: 1000 * (0.94 + r() * 0.14),
        f2: 2200 * (0.94 + r() * 0.14),
        breath: 1.3,
        lp: 5200,
      });
      const buzz = osc('square', 21 + r() * 8, t, t + dur + 0.06);
      const bzg = gainAt(ctx, hz0 * 0.05);
      buzz.connect(bzg);
      bzg.connect(k.saw.frequency);
      const f = k.saw.frequency;
      f.setValueAtTime(hz0 * 0.88, t);
      f.exponentialRampToValueAtTime(hz0 * 1.12, t + dur * 0.3);
      f.exponentialRampToValueAtTime(hz0 * 0.95, t + dur * 0.75);
      f.exponentialRampToValueAtTime(hz0 * 1.2, t + dur);
      const g = k.amp.gain;
      g.setValueAtTime(0.0001, t);
      g.exponentialRampToValueAtTime(lvl(0.28 * v), t + 0.025);
      g.exponentialRampToValueAtTime(lvl(0.21 * v), t + dur * 0.7);
      g.exponentialRampToValueAtTime(0.0001, t + dur + 0.05);
    },

    // Hoof paw on dirt: a filtered noise thump over a soft low body.
    killaStamp(o, t) {
      const r = rndFor(o);
      const v = volOf(o);
      const f = filt(ctx, 'lowpass', 420 * (0.9 + r() * 0.2), 1.1);
      const g = gainAt(ctx, 0);
      chain([nz(t, t + 0.14), f, g, sfxBus]);
      perc(g.gain, t, 0.2 * v, 0.006, t + 0.1);
      const body = osc('sine', 120 * (0.92 + r() * 0.16), t, t + 0.2);
      body.frequency.exponentialRampToValueAtTime(58, t + 0.1);
      const bg = gainAt(ctx, 0);
      chain([body, bg, sfxBus]);
      perc(bg.gain, t, 0.22 * v, 0.005, t + 0.16);
      const gr = filt(ctx, 'bandpass', 2600 * (0.9 + r() * 0.2), 1.6);
      const gg = gainAt(ctx, 0);
      chain([nz(t, t + 0.06), gr, gg, sfxBus]);
      perc(gg.gain, t, 0.05 * v, 0.003, t + 0.05);
    },

    // She trips: a yelp, then an undignified descending squeal with a comic
    // wobble that deepens on the way down, and a soft landing at the bottom.
    killaPanic(o, t) {
      const r = rndFor(o);
      const v = volOf(o);
      const dur = 1.2 * (0.94 + r() * 0.14);
      const hz0 = 330 * (0.94 + r() * 0.14);
      const hz1 = 105 * (0.92 + r() * 0.16);
      const k = killaVoice(t, t + dur, {
        hz: hz0,
        f1: 1150 * (0.94 + r() * 0.12),
        f2: 2100 * (0.94 + r() * 0.12),
        breath: 1.6,
        lp: 4500,
        send: 0.3,
      });
      const f = k.saw.frequency;
      f.setValueAtTime(hz0, t);
      f.exponentialRampToValueAtTime(hz0 * 1.18, t + 0.1);
      f.exponentialRampToValueAtTime(hz1, t + dur * 0.88);
      const wob = osc('sine', 5.5 + r() * 2.5, t, t + dur + 0.06);
      const wg = gainAt(ctx, 0);
      wg.gain.setValueAtTime(hz0 * 0.02, t);
      wg.gain.linearRampToValueAtTime(hz0 * 0.09, t + dur * 0.7);
      wg.gain.linearRampToValueAtTime(hz0 * 0.03, t + dur);
      wob.connect(wg);
      wg.connect(f);
      k.lp.frequency.setValueAtTime(4500, t);
      k.lp.frequency.exponentialRampToValueAtTime(900, t + dur);
      const g = k.amp.gain;
      g.setValueAtTime(0.0001, t);
      g.exponentialRampToValueAtTime(lvl(0.28 * v), t + 0.05);
      g.exponentialRampToValueAtTime(lvl(0.19 * v), t + dur * 0.75);
      g.exponentialRampToValueAtTime(0.0001, t + dur + 0.06);
      const tl = t + dur * 0.92;
      const lf = filt(ctx, 'lowpass', 260, 1);
      const lg = gainAt(ctx, 0);
      chain([nz(tl, tl + 0.25), lf, lg, sfxBus]);
      perc(lg.gain, tl, 0.16 * v, 0.008, tl + 0.22);
    },

    // Her entrance sting. Not a sound effect: it takes over the music mix.
    // Forwarded to music.js, which owns the duck and the restore.
    killaSting() {
      triggerKillaSting();
    },
  };

  return {
    play(name, opts) {
      const h = H[name];
      if (!h) return;
      try { h(opts || {}, ctx.currentTime + 0.005); } catch (e) { /* stay silent */ }
    },
  };
}

// ---------------------------------------------------------------------------
// Ambience loops with 1.5 s crossfades. A = { ctx, ambBus, noise }.
// ---------------------------------------------------------------------------
export function createAmbience(A) {
  const { ctx, ambBus, noise } = A;
  const FADE = 1.5;
  let cur = null;

  function loopNoise(rate) {
    const s = ctx.createBufferSource();
    s.buffer = noise;
    s.loop = true;
    if (rate) s.playbackRate.value = rate;
    s.start(ctx.currentTime, Math.random() * 1.3);
    return s;
  }

  function lfoTo(freq, depth, param, st) {
    const o = ctx.createOscillator();
    o.frequency.value = freq;
    const g = gainAt(ctx, depth);
    o.connect(g);
    g.connect(param);
    o.start(ctx.currentTime);
    st.srcs.push(o);
  }

  // A steady filtered-noise layer into out; returns the filter for LFO mods.
  function bed(st, out, type, freq, Q, lvl, rate) {
    const s = loopNoise(rate);
    const f = filt(ctx, type, freq, Q);
    const g = gainAt(ctx, lvl);
    chain([s, f, g, out]);
    st.srcs.push(s);
    return f;
  }

  function later(st, fn, minMs, varMs) {
    st.timer = setTimeout(() => {
      if (cur !== st) return;
      fn();
      later(st, fn, minMs, varMs);
    }, minMs + Math.random() * varMs);
  }

  function build(kind) {
    const t = ctx.currentTime;
    const out = gainAt(ctx, 0.0001);
    out.connect(ambBus);
    const st = { kind, out, srcs: [], timer: 0 };

    if (kind === 'valley') {
      // River bed plus a babbling band that wanders, and bird calls.
      bed(st, out, 'lowpass', 480, 0.7, 0.14);
      const bf = bed(st, out, 'bandpass', 1100, 1.8, 0.05, 1.18);
      lfoTo(0.35, 320, bf.frequency, st);
      later(st, () => {
        const t0 = ctx.currentTime + 0.05;
        const f0 = 2300 + Math.random() * 1300;
        const o = ctx.createOscillator();
        const g = gainAt(ctx, 0.0001);
        const p = ctx.createStereoPanner();
        p.pan.value = Math.random() * 1.4 - 0.7;
        chain([o, g, p, out]);
        const reps = 2 + ((Math.random() * 3) | 0);
        for (let i = 0; i < reps; i++) {
          const ts = t0 + i * 0.13;
          o.frequency.setValueAtTime(f0, ts);
          o.frequency.linearRampToValueAtTime(f0 * 1.3, ts + 0.05);
          g.gain.setValueAtTime(0.0001, ts);
          g.gain.linearRampToValueAtTime(0.045, ts + 0.02);
          g.gain.linearRampToValueAtTime(0.0001, ts + 0.1);
        }
        o.start(t0);
        o.stop(t0 + reps * 0.13 + 0.12);
      }, 1800, 4200);
    } else if (kind === 'puna') {
      // High plain wind, slow swells, occasional stronger gusts.
      const wf = bed(st, out, 'bandpass', 420, 0.55, 0.13);
      lfoTo(0.08, 160, wf.frequency, st);
      const gf = filt(ctx, 'bandpass', 700, 0.8);
      const gg = gainAt(ctx, 0.0001);
      const gs = loopNoise(1.3);
      chain([gs, gf, gg, out]);
      st.srcs.push(gs);
      later(st, () => {
        const t0 = ctx.currentTime;
        gg.gain.cancelScheduledValues(t0);
        gg.gain.setValueAtTime(Math.max(gg.gain.value, 0.0001), t0);
        gg.gain.exponentialRampToValueAtTime(0.1, t0 + 1.2);
        gg.gain.exponentialRampToValueAtTime(0.0001, t0 + 3.2);
      }, 3500, 4500);
    } else if (kind === 'citadel') {
      // Thin quiet air with distant brazier crackle.
      bed(st, out, 'lowpass', 260, 0.6, 0.05);
      bed(st, out, 'bandpass', 3800, 1.2, 0.006);
      later(st, () => {
        const t0 = ctx.currentTime + 0.02;
        const s = loopNoise(1);
        const f = filt(ctx, 'highpass', 2200, 0.7);
        const g = gainAt(ctx, 0);
        const p = ctx.createStereoPanner();
        p.pan.value = Math.random() - 0.5;
        chain([s, f, g, p, out]);
        perc(g.gain, t0, 0.02 + Math.random() * 0.025, 0.003, t0 + 0.02 + Math.random() * 0.02);
        s.stop(t0 + 0.06);
      }, 250, 900);
    } else if (kind === 'bridge') {
      // Strong canyon wind, a thin whistle, rope creaks.
      const wf = bed(st, out, 'bandpass', 520, 0.6, 0.19);
      lfoTo(0.12, 260, wf.frequency, st);
      const hf = bed(st, out, 'bandpass', 1300, 6, 0.018);
      lfoTo(0.2, 300, hf.frequency, st);
      later(st, () => {
        const n = Math.random() < 0.45 ? 2 : 1;
        for (let i = 0; i < n; i++) {
          const t0 = ctx.currentTime + 0.02 + i * 0.19;
          const o = ctx.createOscillator();
          o.type = 'sawtooth';
          o.frequency.setValueAtTime(150 + Math.random() * 30, t0);
          o.frequency.exponentialRampToValueAtTime(105, t0 + 0.26);
          const f = filt(ctx, 'bandpass', 420, 5);
          const g = gainAt(ctx, 0);
          chain([o, f, g, out]);
          perc(g.gain, t0, 0.05 * (i ? 0.7 : 1), 0.05, t0 + 0.3);
          o.start(t0);
          o.stop(t0 + 0.34);
        }
      }, 2500, 4000);
    }

    out.gain.linearRampToValueAtTime(1, t + FADE);
    return st;
  }

  function fadeOut(st) {
    if (!st) return;
    clearTimeout(st.timer);
    const t = ctx.currentTime;
    st.out.gain.cancelScheduledValues(t);
    st.out.gain.setValueAtTime(Math.max(st.out.gain.value, 0.0001), t);
    st.out.gain.exponentialRampToValueAtTime(0.0001, t + FADE);
    for (let i = 0; i < st.srcs.length; i++) {
      try { st.srcs[i].stop(t + FADE + 0.2); } catch (e) { /* already stopped */ }
    }
    setTimeout(() => {
      try { st.out.disconnect(); } catch (e) { /* fine */ }
    }, (FADE + 0.4) * 1000);
  }

  return {
    set(kind) {
      const next = kind && kind !== 'none' ? kind : null;
      if ((cur ? cur.kind : null) === next) return;
      fadeOut(cur);
      cur = next ? build(next) : null;
    },
  };
}
