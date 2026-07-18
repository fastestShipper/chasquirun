// Chasqui Run: one-shot sound effects and looping biome ambiences.
// Internal module: imported only by src/audio/engine.js. Everything is
// synthesized from oscillators and one shared looping noise buffer; every
// envelope is a ramp (never a hard stop), so nothing clicks.

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
