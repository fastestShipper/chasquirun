// Sky dome, sun, far Andes ridgelines, drifting clouds and ambient condors.
// Owns time-of-day palette blending; drives scene fog color and light colors.

import * as THREE from 'three';
import { CONFIG } from './config.js';
import { clamp, lerp, damp, smoothstep, mulberry32, randRange, TAU } from './util.js';
import { Tex } from './materials.js';
import { buildCondor } from './animals.js';

const WHITE = new THREE.Color(0xffffff);
// Alpenglow rose. Real low-sun light on snow goes further toward magenta than
// the sky glow does, so the palette glow is pulled toward this rather than
// used raw.
const ALPEN_ROSE = new THREE.Color(0xff5c78);

// Scratch for the mid-blend re-saturation (zero alloc per call).
const _hsl = { h: 0, s: 0, l: 0 };
function _resat(color, amount) {
  color.getHSL(_hsl);
  color.setHSL(_hsl.h, Math.min(1, _hsl.s * (1 + amount)), _hsl.l);
}

// ---------------------------------------------------------------------------
// Time-of-day keyframes. t: 0 dawn, 0.5 noon, 0.75 golden hour, 1 dusk.
// ---------------------------------------------------------------------------

function makeKey(t, o) {
  return {
    t,
    top: new THREE.Color(o.top),
    mid: new THREE.Color(o.mid),
    bot: new THREE.Color(o.bot),
    sun: new THREE.Color(o.sun),
    glow: new THREE.Color(o.glow),
    fog: new THREE.Color(o.fog),
    hemiSky: new THREE.Color(o.hemiSky),
    hemiGround: new THREE.Color(o.hemiGround),
    cloud: new THREE.Color(o.cloud),
    mtn: new THREE.Color(o.mtn),
    sunI: o.sunI, hemiI: o.hemiI, cloudOp: o.cloudOp,
    haze: o.haze, elev: o.elev, az: o.az,
  };
}

const KEYS = [
  // Dawn: rose over indigo.
  makeKey(0.0, {
    top: 0x2a2f63, mid: 0xa06188, bot: 0xffb894,
    sun: 0xffc9a2, glow: 0xff9a66, fog: 0xe0b09a,
    hemiSky: 0x9083ad, hemiGround: 0x4d3c30,
    cloud: 0xf6c9bb, mtn: 0xbcaacb,
    sunI: 1.3, hemiI: 0.55, cloudOp: 0.30, haze: 0.36, elev: 0.16, az: -0.85,
  }),
  // Noon: crystal sierra day. Deep ultramarine zenith (Ausangate reference),
  // pale blue horizon, razor-thin haze, brilliant cumulus.
  makeKey(0.5, {
    top: 0x1557c8, mid: 0x3d85e0, bot: 0xa9cdf0,
    sun: 0xfff6e4, glow: 0xfff4d4, fog: 0xd5e4f2,
    hemiSky: 0xcfe2f5, hemiGround: 0x77694a,
    cloud: 0xffffff, mtn: 0xffffff,
    sunI: 2.7, hemiI: 0.95, cloudOp: 0.5, haze: 0.11, elev: 0.9, az: 0.30,
  }),
  // Golden hour: amber and peach.
  makeKey(0.75, {
    top: 0x395d99, mid: 0xe89f5b, bot: 0xffd9a0,
    sun: 0xffdda6, glow: 0xffb35c, fog: 0xe9c497,
    hemiSky: 0xdcb68d, hemiGround: 0x604b34,
    cloud: 0xffd9b4, mtn: 0xf6e2c9,
    sunI: 1.9, hemiI: 0.72, cloudOp: 0.34, haze: 0.33, elev: 0.35, az: 0.72,
  }),
  // Dusk: violet and ember.
  makeKey(1.0, {
    top: 0x1f1739, mid: 0x5e3d72, bot: 0xed7440,
    sun: 0xff8c4c, glow: 0xff7038, fog: 0xa8664f,
    hemiSky: 0x584d7c, hemiGround: 0x352520,
    cloud: 0xd98d70, mtn: 0x8d7a9c,
    sunI: 1.15, hemiI: 0.62, cloudOp: 0.30, haze: 0.44, elev: 0.09, az: 1.05,
  }),
];

// ---------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------

const DOME_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const DOME_FRAG = /* glsl */ `
uniform vec3 uTop;
uniform vec3 uMid;
uniform vec3 uBot;
uniform vec3 uGlow;
uniform vec3 uSunDir;
uniform float uNight;
uniform float uDesat;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  float h = max(d.y, 0.0);
  // Rayleigh-flavored optical depth proxy: the air column thickens sharply
  // toward the horizon, so zenith blue deepens fast and the horizon band
  // stays compressed (calibrated so t=0.48 keeps the crystal-noon palette,
  // with more depth overhead than the old linear 3-stop gradient).
  float od = pow(1.0 - h, 1.7);
  vec3 col = mix(uTop, uMid, smoothstep(0.0, 0.62, od));
  col = mix(col, uBot, smoothstep(0.55, 0.96, od));
  if (d.y < 0.0) col = uBot * (1.0 + d.y * 0.35);
  // Mie forward-scattering lobe (Henyey-Greenstein, g = 0.76): a warm haze
  // pools around the sun and strengthens in the thicker horizon air. A tight
  // pow term keeps the bright aureole right at the disc.
  float cosT = dot(d, uSunDir);
  float g = 0.76;
  float mie = (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * cosT, 1.5);
  float s = max(cosT, 0.0);
  col += uGlow * (mie * 0.02 * (0.6 + 0.4 * od) + pow(s, 90.0) * 0.35);
  // Horizon desaturation: distant scattered light drifts toward neutral.
  float lum = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(col, vec3(lum), uDesat * smoothstep(0.5, 0.98, od));
  // Milky Way: faint band around a fixed tilted great circle, plus a
  // 2-octave hash sparkle inside it. Gated to zero by day via uNight.
  if (uNight > 0.001) {
    vec3 gn = normalize(vec3(0.22, 0.77, 0.6));
    float bd = abs(dot(d, gn));
    float band = 1.0 - smoothstep(0.06, 0.46, bd);
    band *= smoothstep(0.03, 0.3, d.y);
    vec2 gp = vec2(atan(d.x, d.z) * 2.2, d.y * 3.1);
    float n1 = fract(sin(dot(floor(gp * 110.0), vec2(12.9898, 78.233))) * 43758.5453);
    float n2 = fract(sin(dot(floor(gp * 233.0) + 5.0, vec2(26.651, 41.53))) * 12951.361);
    float spark = pow(n1, 30.0) * 0.8 + pow(n2, 38.0) * 0.6;
    col += (vec3(0.5, 0.56, 0.72) * (band * band * 0.085)
          + vec3(0.78, 0.83, 0.95) * (band * band * spark * 0.45)) * uNight;
  }
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// Mountains are lit for real: flat per-face normals from the ridge builder,
// a sun diffuse term plus a hemispheric sky term, and snow decided in the
// fragment shader from normalized peak height, face slope and fbm noise.
// aAux packs the per-vertex data the shading needs:
//   x = hy, height normalized inside its own peak (0 at the foot, 1 at summit)
//   y = snow threshold in hy space (>1 means this peak never gets snow)
//   z = per-peak random seed, decorrelates the noise fields between massifs
const MTN_VERT = /* glsl */ `
attribute vec3 aAux;
varying vec3 vColor;
varying vec3 vNrm;
varying vec3 vLPos;
varying vec3 vAux;
varying float vY;
varying float vDist;
void main() {
  vColor = color;
  vAux = aAux;
  vY = position.y;
  // OBJECT space, deliberately. The rings follow the camera every frame, so
  // sampling the detail noise in world space would make it crawl across the
  // mountains as the player runs. Local coords keep the rock nailed down.
  vLPos = position;
  // Rings are only ever scaled near-uniformly, so the plain model rotation
  // is an adequate normal transform and saves a normalMatrix upload.
  vNrm = normalize(mat3(modelMatrix) * normal);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vDist = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

const MTN_FRAG = /* glsl */ `
uniform vec3 uHaze;
uniform vec3 uTint;
uniform vec3 uSunDir;
uniform vec3 uSunCol;
uniform vec3 uSkyCol;
uniform vec3 uGndCol;
uniform vec3 uAlpenCol;
uniform float uHazeAmt;
uniform float uHazeH;
uniform float uSunI;
uniform float uAlpen;
varying vec3 vColor;
varying vec3 vNrm;
varying vec3 vLPos;
varying vec3 vAux;
varying float vY;
varying float vDist;

// Sin-free hash. The usual fract(sin(dot(p,k))*43758.0) collapses into
// banding once the coordinates get large, and these rings span +/-500 units,
// so the fine octaves were degenerating into near-constant mush. This one
// stays well behaved across the whole ring and is cheaper besides.
float h21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = h21(i);
  float b = h21(i + vec2(1.0, 0.0));
  float c = h21(i + vec2(0.0, 1.0));
  float d = h21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
// Three octaves is the ceiling worth paying for on background geometry.
float fbm(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 3; i++) {
    s += a * vnoise(p);
    p *= 2.07;
    a *= 0.5;
  }
  return s;
}

void main() {
  vec3 N = normalize(vNrm);
  float hy = vAux.x;
  float snowBias = vAux.y;
  float seed = vAux.z;

  // Two noise scales: fine for rock mottling and gullies, coarse for the
  // snowline wander and broad hue drift across a face.
  vec2 sOff = vec2(seed * 91.7, seed * 57.3);
  // One 2D frame whose second axis is mostly VERTICAL. Sampling plain XZ
  // collapses on steep faces (both coords barely move as you climb) and
  // smears the detail into long vertical streaks; folding height in gives
  // real 2D variation on the faces for the cost of the same single fbm.
  vec2 np = vec2(vLPos.x * 0.72 + vLPos.z * 0.69,
                 vLPos.y * 1.15 + (vLPos.x - vLPos.z) * 0.22);
  float fine = fbm(np * 0.13 + sOff);
  // The snowline wander stays on XZ: it should vary AROUND the massif, not
  // up it, or the threshold fights the altitude term it is modulating.
  float coarse = vnoise(vLPos.xz * 0.012 + sOff * 0.4);

  // --- Albedo ---------------------------------------------------------
  vec3 alb = vColor;
  // Mottling: gullies read darker, ribs catch a little more light.
  alb *= 0.74 + 0.50 * fine;
  // Slow hue drift so a big face is never one flat field of colour.
  alb.r *= 0.96 + 0.09 * coarse;
  alb.b *= 1.04 - 0.09 * coarse;

  // --- Snow by altitude and slope --------------------------------------
  // The threshold wanders with the coarse noise so the snowline is a ragged
  // edge rather than a clean horizontal cut, and dips a little in gullies.
  float line = snowBias + (0.5 - coarse) * 0.20 - (fine - 0.5) * 0.10;
  float alt = smoothstep(line, line + 0.16, hy);
  // Steep faces shed snow and stay bare rock; flatter shelves hold it.
  float flatness = smoothstep(0.05, 0.52, N.y);
  float snowK = alt * mix(0.10, 1.0, flatness);
  // The summit crown keeps a rime coating even where it is steep.
  snowK = clamp(max(snowK, alt * alt * alt * 0.62), 0.0, 1.0);
  // Wind-scoured snow on steep ground goes blue-grey glacier ice.
  vec3 snowAlb = mix(vec3(0.58, 0.66, 0.80), vec3(0.86, 0.89, 0.95), flatness);
  // Sastrugi: wind-carved streaks. Stretched hard along the horizontal axis
  // so the grain combs ACROSS the slope the way a prevailing wind lays it
  // down, rather than running up and down the fall line.
  float sast = vnoise(vec2(np.x * 0.04, np.y * 0.18) + sOff);
  // Wind-packed crests sit bright and hard against softer lee drifts.
  float packed = smoothstep(0.40, 0.78, fine);
  snowAlb *= 0.86 + 0.18 * sast + 0.10 * packed;
  alb = mix(alb, snowAlb, snowK);

  // --- Lighting ---------------------------------------------------------
  float ndl = dot(N, uSunDir);
  float diff = max(ndl, 0.0);
  // Snow scatters light through itself, so it wraps past the terminator.
  float wrapped = max((ndl + 0.32) / 1.32, 0.0);
  float lam = mix(diff, wrapped, 0.20 + 0.30 * snowK);
  // Pseudo-relief: modulating the LIGHT term with the noise (not just the
  // albedo) is what stops the big triangles reading as flat paper panels.
  // Snow swaps in a sastrugi-dominated field so it gets its own form rather
  // than borrowing the rock's; bright albedo alone reads as plaster.
  float relief = mix(fine, 0.32 * fine + 0.68 * sast, snowK);
  lam *= 0.74 + 0.50 * relief;
  // Hemispheric fill: sky above, warm bounce from the valley below.
  vec3 amb = mix(uGndCol, uSkyCol, N.y * 0.5 + 0.5);
  // Snow shadows are famously blue: where the sun cannot reach, what is left
  // is skylight. Applied as a HUE shift, weighted by how shadowed the point
  // actually is, and NOT as a brightness lift. hemiSky is near-white at noon,
  // so lifting toward it just blows the snow out into flat milk and destroys
  // exactly the form this section exists to create.
  float shadowed = 1.0 - smoothstep(0.0, 0.45, diff);
  vec3 ambTerm = mix(amb, amb * vec3(0.80, 0.93, 1.24), snowK * shadowed);
  // Contact darkening at the feet, where ridges overlap and self-shadow.
  float foot = 0.68 + 0.32 * smoothstep(0.0, 0.16, hy);
  vec3 col = alb * (uSunCol * (uSunI * 0.40) * lam + ambTerm * 0.52) * foot;
  // Palette tint keeps the massifs inside the time-of-day colour scheme.
  col = mix(col, col * uTint, 0.4);

  // --- Alpenglow ---------------------------------------------------------
  // With the sun near the horizon its light is long-path red, and only the
  // high ground still sees it while the valleys have already gone into
  // shadow. Gated hard by sun elevation on the JS side, so this contributes
  // exactly nothing at midday and the branch is uniform across the draw.
  if (uAlpen > 0.001) {
    float high = smoothstep(0.38, 0.80, hy);
    float facing = smoothstep(-0.10, 0.40, ndl);
    float glowK = uAlpen * high * facing;
    // Snow takes it hardest; bare rock catches a weaker warm wash.
    col += uAlpenCol * (glowK * (0.18 + 0.82 * snowK) * 0.9);
    // Everything below the glow band sinks further into shadow, which is
    // what makes the lit summits read as floating above a dark valley.
    col *= mix(1.0, 0.60 + 0.40 * high, uAlpen);
  }

  // --- Aerial perspective -----------------------------------------------
  // Hugs the feet of the ridges; capped low so summits never bleach out.
  float hz = uHazeAmt * (1.0 - smoothstep(0.0, uHazeH, vY));
  hz = min(hz + uHazeAmt * 0.10 + smoothstep(380.0, 950.0, vDist) * uHazeAmt * 0.34, 0.90);
  col = mix(col, uHaze, hz);

  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// ---------------------------------------------------------------------------
// Far mountain ring geometry: a CONNECTED cordillera, not a row of cones.
//
// A real range is one continuous crest. Summits are local maxima ALONG that
// crest, joined to their neighbours by cols and saddles, with spurs and
// gullies running down the flanks. Building peaks as independent radial cones
// (the old approach) can never produce that, however much jitter you add: it
// gives a row of party hats. So the crest comes first here, and the surface
// is swept off it.
//
// Per sweep:
//   1. Place summits at angles around the ring.
//   2. crestAt(theta) = a continuous base ridge + the tallest nearby summit
//      bump. Where two bumps overlap you get a col; the base ridge is what
//      keeps the chain joined instead of letting it drop to the valley floor.
//   3. Sweep a cross-section profile off the crest, falling away on both
//      sides, with the flank half-width modulated by angle so the flanks grow
//      ribs and gullies rather than staying smooth cones.
//
// The builder emits a flat per-face NORMAL and the aAux attribute so the
// existing lighting/snow shader keeps working unchanged.
// ---------------------------------------------------------------------------

// Periodic 1D noise around the ring: a small stack of harmonics. Exactly
// periodic, so there is no seam at theta = 0, and band-limited, so the
// angular sampling below cannot alias it into spikes.
function makeRingNoise(rnd, freqs) {
  const n = freqs.length;
  const fr = new Float64Array(n);
  const ph = new Float64Array(n);
  const am = new Float64Array(n);
  let tot = 0;
  for (let i = 0; i < n; i++) {
    fr[i] = Math.max(1, Math.round(freqs[i]));
    ph[i] = rnd() * TAU;
    am[i] = 1 / Math.sqrt(fr[i]);
    tot += am[i];
  }
  for (let i = 0; i < n; i++) am[i] /= tot;
  return (th) => {
    let s = 0;
    for (let i = 0; i < n; i++) s += am[i] * Math.sin(fr[i] * th + ph[i]);
    return s;
  };
}

function buildRidgeRing({ radius, count, hMin, hMax, seed, baseY, dramatic, peaksOut, snowMulBase = 1, vegTop = 0.26 }) {
  const rnd = mulberry32(seed);
  const positions = [];
  const colors = [];
  const normals = [];
  const aux = [];
  // Photo-real palette (Ausangate / Salkantay / Valle Sagrado references):
  // the mass of the mountain is warm brown rock; snow lives only in the
  // upper reaches, patchy, with tongues running down the couloirs.
  const rockA = new THREE.Color(0x6b573c);
  const rockB = new THREE.Color(0x7d6a52);
  const crag = new THREE.Color(0x5c5450);
  const slate = new THREE.Color(0x6a6a68);
  // Vegetated lower slopes. Sierra hillsides are muted olive and dry
  // eucalyptus green, NOT tropical lime: saturated greens up here read as
  // painted plastic and were the single worst thing about the old look.
  const vegA = new THREE.Color(0x3c4a25);
  const vegB = new THREE.Color(0x56682f);
  const veg = new THREE.Color();
  const rock = new THREE.Color();

  // Snow is decided by ABSOLUTE altitude, normalized against the ring's own
  // tallest crest. A real cordillera has ONE snowline running level across
  // every peak in it; normalizing per peak (the old way) gave every cone its
  // own private snowline, which is exactly the wrong read. hRef is filled in
  // once the main crest exists.
  let hRef = 1;
  let span = 1;
  const snowHy = 0.46 * snowMulBase;

  // Build one continuous crest: summit placement plus every angular field the
  // sweep needs. Returns closures rather than baked arrays so the caller can
  // scan it for hRef before committing to a sampling rate.
  function makeCrest({ nS, hLo, hHi, rad, radAmp, major }) {
    const summits = [];
    for (let k = 0; k < nS; k++) {
      // Uneven spacing. Evenly spaced summits of similar height read as a
      // repeating sawtooth, which was the last thing making this look built
      // rather than eroded.
      const th = (k / nS) * TAU + (rnd() - 0.5) * (TAU / nS) * 0.9;
      const isMajor = !!major && major(k);
      // Skewed low: a real range is mostly modest summits with a few giants,
      // not a uniform draw across the whole height band.
      const h = lerp(hLo, hHi, Math.pow(rnd(), 1.8)) * (isMajor ? 1.6 : 1);
      // Influence wider than the spacing, so neighbouring bumps overlap and
      // meet at a col instead of each decaying to nothing in isolation. The
      // wide spread matters: broad shallow massifs next to narrow sharp peaks.
      summits.push({ th, h, w: (TAU / nS) * (0.62 + rnd() * 0.85), isMajor });
    }
    // A subsidiary summit hangs off each giant, joined by a high col. That
    // shoulder is what makes a massif read as a massif and not a spike.
    const shoulders = [];
    for (const S2 of summits) {
      if (!S2.isMajor) continue;
      shoulders.push({
        th: S2.th + (rnd() < 0.5 ? -1 : 1) * S2.w * 0.52,
        h: S2.h * 0.66, w: S2.w * 0.6, isMajor: false,
      });
    }
    for (const s of shoulders) summits.push(s);

    const hMean = (hLo + hHi) * 0.5;
    // The connective tissue. Its own variation is what makes some links high
    // shoulders and others deep passes.
    const baseRidge = makeRingNoise(rnd, [1, 2, 3, 5, 8]);
    const cragN = makeRingNoise(rnd, [nS, nS * 1.6, nS * 2.4]);
    const radN = makeRingNoise(rnd, [1, 2, 3, 5]);
    // Spurs and gullies. Frequencies stay well inside the angular sampling
    // rate: alias these and the flanks turn into noise spikes.
    const spurN = makeRingNoise(rnd, [nS * 0.7, nS * 1.2, nS * 1.8]);
    const gullyN = makeRingNoise(rnd, [nS * 0.9, nS * 1.5, nS * 2.1]);
    const corN = makeRingNoise(rnd, [nS * 0.5, nS]);
    const rockN = makeRingNoise(rnd, [1, 2, 3]);
    const rockN2 = makeRingNoise(rnd, [1, 3, 5]);
    const snowN = makeRingNoise(rnd, [2, 3, 5]);

    function crestAt(th) {
      let bump = 0;
      for (let k = 0; k < summits.length; k++) {
        const S2 = summits[k];
        let d = th - S2.th;
        d -= TAU * Math.round(d / TAU);
        const a = Math.abs(d) / S2.w;
        if (a < 1) {
          // (1 - a) rather than cos: it has a corner at the summit, so peaks
          // come to a point instead of doming over into meringue.
          const b = S2.h * Math.pow(1 - a, 1.45);
          if (b > bump) bump = b;
        }
      }
      const ridge = hMean * (0.30 + 0.16 * (0.5 + 0.5 * baseRidge(th)));
      // Crest roughness: sub-summits and notches along the ridgeline. This is
      // what keeps the skyline craggy rather than a run of smooth arcs.
      return ridge + bump * 0.95 + hMean * 0.13 * cragN(th);
    }
    const radAt = (th) => rad * (1 + radAmp * radN(th));
    return {
      crestAt, radAt, summits,
      // Kept deliberately gentle. A big width swing corrugates the flank into
      // sharp dark wedges that read as spikes, not as ridge-and-gully.
      spurAt: (th) => 0.84 + 0.32 * (0.5 + 0.5 * spurN(th)),
      gullyAt: gullyN,
      corAt: (th) => Math.max(0, corN(th)),
      rockAt: (th) => 0.5 + 0.5 * rockN(th),
      slateAt: (th) => Math.max(0, rockN2(th)) * 0.8,
      snowAt: (th) => snowN(th) * 0.05,
    };
  }

  // Sweep a cross-section along a crest and append it to the buffers.
  // s runs -1 (inner base, toward the camera) through 0 (the crest line)
  // to +1 (outer base), sampled denser near the crest so the ridge stays
  // crisp without spending vertices on the flat feet.
  function sweep(C, { NA, NU, wInMul, wOutMul, cornice, seedZ, vegLocal }) {
    const rows = NU + 1;
    const sv = new Float64Array(rows);
    for (let j = 0; j < rows; j++) {
      const u = -1 + (2 * j) / NU;
      sv[j] = Math.sign(u) * Math.pow(Math.abs(u), 1.7);
    }
    // Per-column fields, evaluated once instead of per vertex.
    const cth = new Float64Array(NA);
    const cch = new Float64Array(NA);
    const cwi = new Float64Array(NA);
    const cwo = new Float64Array(NA);
    const cgu = new Float64Array(NA);
    const cco = new Float64Array(NA);
    const cbi = new Float64Array(NA);
    const crx = new Float64Array(NA);
    const crz = new Float64Array(NA);
    const crr = new Float64Array(NA);
    const rkR = new Float64Array(NA);
    const rkG = new Float64Array(NA);
    const rkB = new Float64Array(NA);
    for (let i = 0; i < NA; i++) {
      const th = (i / NA) * TAU;
      const ch = C.crestAt(th);
      const rr = C.radAt(th);
      const sp = C.spurAt(th);
      cth[i] = th;
      cch[i] = ch;
      crx[i] = Math.cos(th);
      crz[i] = Math.sin(th);
      cwi[i] = (ch - baseY) * wInMul * sp;
      cwo[i] = (ch - baseY) * wOutMul * (1.9 - sp);
      cgu[i] = C.gullyAt(th);
      // Cornices only form up where there is snow to blow around.
      const chy = (ch - baseY) / span;
      cco[i] = cornice * C.corAt(th) * clamp((chy - snowHy + 0.12) / 0.3, 0, 1);
      cbi[i] = snowHy + C.snowAt(th);
      rock.lerpColors(rockA, rockB, C.rockAt(th));
      rock.lerp(slate, C.slateAt(th));
      rkR[i] = rock.r; rkG[i] = rock.g; rkB[i] = rock.b;
      crr[i] = rr;
    }

    // Height of the swept surface at column i, cross-section row j.
    function yAt(i, j) {
      const s = sv[j];
      const t = Math.abs(s);
      const rise = cch[i] - baseY;
      let y = baseY + rise * Math.pow(1 - t, 1.2);
      // Mid-flank ripple: ribs and gullies, zero at the crest and the foot.
      y += rise * 0.09 * cgu[i] * 4 * t * (1 - t);
      // Cornice: a wind-built lip overhanging the lee side of a high crest.
      if (s > 0 && s < 0.4 && cco[i] > 0) {
        const e = (s - 0.13) / 0.11;
        y += rise * 0.07 * cco[i] * Math.exp(-e * e);
      }
      return y;
    }
    function rAt(i, j) {
      const s = sv[j];
      return crr[i] + (s < 0 ? s * cwi[i] : s * cwo[i]);
    }

    function pushV(i, j, ci, nx, ny, nz) {
      const r = rAt(i, j);
      const y = yAt(i, j);
      positions.push(crx[i] * r, y, crz[i] * r);
      normals.push(nx, ny, nz);
      const hy = clamp((y - baseY) / span, 0, 1);
      aux.push(hy, cbi[ci], seedZ);
      // Base albedo only: olive slopes low, rock band above, grey crags in
      // the upper reaches. Snow and all lighting live in the shader.
      const g = smoothstep(vegLocal * 0.5, vegLocal, hy);
      const cg = clamp((hy - 0.46) * 1.8, 0, 1) * 0.45;
      const r0 = lerp(lerp(veg.r, rkR[ci], g), crag.r, cg);
      const g0 = lerp(lerp(veg.g, rkG[ci], g), crag.g, cg);
      const b0 = lerp(lerp(veg.b, rkB[ci], g), crag.b, cg);
      colors.push(r0, g0, b0);
    }

    // One flat-shaded face. Emission order is fixed: the sweep is a regular
    // (angle, cross-section) parameterization, so d/dtheta x d/ds points
    // outward everywhere and a single winding is correct for the whole
    // surface. The normal is flipped only as a shading safety net.
    function tri(i0, j0, i1, j1, i2, j2, ci) {
      const r0 = rAt(i0, j0), r1 = rAt(i1, j1), r2 = rAt(i2, j2);
      const ax = crx[i0] * r0, ay = yAt(i0, j0), az = crz[i0] * r0;
      const bx = crx[i1] * r1, by = yAt(i1, j1), bz = crz[i1] * r1;
      const cx2 = crx[i2] * r2, cy = yAt(i2, j2), cz2 = crz[i2] * r2;
      let nx = (by - ay) * (cz2 - az) - (bz - az) * (cy - ay);
      let ny = (bz - az) * (cx2 - ax) - (bx - ax) * (cz2 - az);
      let nz = (bx - ax) * (cy - ay) - (by - ay) * (cx2 - ax);
      const L = Math.hypot(nx, ny, nz) || 1;
      nx /= L; ny /= L; nz /= L;
      if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }
      pushV(i0, j0, ci, nx, ny, nz);
      pushV(i1, j1, ci, nx, ny, nz);
      pushV(i2, j2, ci, nx, ny, nz);
    }

    for (let i = 0; i < NA; i++) {
      const i1 = (i + 1) % NA;
      for (let j = 0; j < NU; j++) {
        tri(i, j, i1, j, i, j + 1, i);
        tri(i1, j, i1, j + 1, i, j + 1, i);
      }
    }
  }

  // --- Main crest -------------------------------------------------------
  const kd1 = Math.round(count * 0.69) % count;
  const kd2 = Math.round(count * 0.81) % count;
  const main = makeCrest({
    nS: count, hLo: hMin, hHi: hMax, rad: radius, radAmp: 0.10,
    major: dramatic ? (k) => (k === kd1 || k === kd2) : null,
  });
  // Scan the finished crest for its true maximum: everything downstream
  // (snowline, vegetation line, alpenglow band) is normalized against it.
  for (let i = 0; i < 720; i++) {
    const h = main.crestAt((i / 720) * TAU);
    if (h > hRef) hRef = h;
  }
  span = (hRef - baseY) || 1;

  veg.lerpColors(vegA, vegB, rnd());
  sweep(main, {
    NA: dramatic ? 448 : 352, NU: dramatic ? 10 : 8,
    wInMul: 0.95, wOutMul: 0.95, cornice: 1, seedZ: 0.0, vegLocal: vegTop,
  });

  // --- Foothill crest ---------------------------------------------------
  // A second, lower connected chain in front of the main one. It falls below
  // the shared snowline on its own merits, so the big massifs rise out of
  // layered ridgelines instead of standing straight up off the valley floor.
  const foot = makeCrest({
    nS: Math.round(count * 1.35), hLo: hMin * 0.22, hHi: hMax * 0.30,
    rad: radius * 0.80, radAmp: 0.13, major: null,
  });
  veg.lerpColors(vegA, vegB, 0.35 + rnd() * 0.5);
  sweep(foot, {
    NA: dramatic ? 256 : 192, NU: dramatic ? 6 : 4,
    wInMul: 1.25, wOutMul: 1.0, cornice: 0, seedZ: 0.37,
    // Rockier than the main range despite sitting lower: these read as the
    // dry front ranges, and an all-green apron swamps the massifs behind it.
    vegLocal: vegTop * 0.7,
  });

  // Twin peak anchors for the lenticular cloud stacks.
  if (peaksOut) {
    for (const S2 of main.summits) {
      if (!S2.isMajor) continue;
      const r = main.radAt(S2.th);
      peaksOut.push({
        x: Math.cos(S2.th) * r, z: Math.sin(S2.th) * r, h: main.crestAt(S2.th),
      });
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(colors), 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(normals), 3));
  geo.setAttribute('aAux', new THREE.BufferAttribute(new Float32Array(aux), 3));
  geo.computeBoundingSphere();
  return geo;
}

// ---------------------------------------------------------------------------
// Small canvas textures for the lenticular lens discs and the phase moon.
// ---------------------------------------------------------------------------

function makeLensTexture() {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 64;
  const ctx = c.getContext('2d');
  ctx.save();
  ctx.translate(128, 34);
  ctx.scale(1, 0.27);
  let g = ctx.createRadialGradient(0, 0, 0, 0, 0, 122);
  g.addColorStop(0, 'rgba(255,255,255,0.85)');
  g.addColorStop(0.55, 'rgba(255,255,255,0.45)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(-128, -128, 256, 256);
  // Brighter smooth core slightly above center: stacked-lens illusion.
  g = ctx.createRadialGradient(0, -6, 0, 0, -6, 70);
  g.addColorStop(0, 'rgba(255,255,255,0.7)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(-128, -128, 256, 256);
  ctx.restore();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

function makeCirrusTexture() {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 64;
  const ctx = c.getContext('2d');
  const rnd = mulberry32(913);
  // Layered near-horizontal streaks with soft radial falloff: ice-crystal
  // veil combed by high-altitude wind.
  for (let i = 0; i < 11; i++) {
    const cx = 26 + rnd() * 204;
    const cy = 10 + rnd() * 44;
    const rx = 36 + rnd() * 82;
    const ry = 2 + rnd() * 4.5;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate((rnd() - 0.5) * 0.14);
    ctx.scale(1, ry / rx);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
    g.addColorStop(0, 'rgba(255,255,255,0.42)');
    g.addColorStop(0.6, 'rgba(255,255,255,0.18)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(-rx, -rx, rx * 2, rx * 2);
    ctx.restore();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

function makeMoonTexture() {
  const s = 128;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(56, 56, 6, 64, 64, 46);
  g.addColorStop(0, 'rgb(238,242,248)');
  g.addColorStop(0.75, 'rgb(214,222,234)');
  g.addColorStop(1, 'rgb(188,199,216)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(64, 64, 44, 0, TAU);
  ctx.fill();
  // Mare blotches.
  ctx.fillStyle = 'rgba(150,160,180,0.35)';
  ctx.beginPath(); ctx.arc(52, 52, 12, 0, TAU); ctx.fill();
  ctx.beginPath(); ctx.arc(74, 68, 9, 0, TAU); ctx.fill();
  ctx.beginPath(); ctx.arc(58, 82, 6, 0, TAU); ctx.fill();
  // Phase: erase a soft-edged offset disc for a waxing gibbous.
  ctx.globalCompositeOperation = 'destination-out';
  const ph = ctx.createRadialGradient(20, 74, 26, 20, 74, 52);
  ph.addColorStop(0, 'rgba(0,0,0,0.95)');
  ph.addColorStop(0.8, 'rgba(0,0,0,0.6)');
  ph.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = ph;
  ctx.beginPath();
  ctx.arc(20, 74, 52, 0, TAU);
  ctx.fill();
  ctx.globalCompositeOperation = 'source-over';
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

// ---------------------------------------------------------------------------
// SkySystem
// ---------------------------------------------------------------------------

export class SkySystem {
  constructor(scene, renderer) {
    this._scene = scene;
    this._renderer = renderer;
    this._time = 0;
    this._tod = 0;
    this._snowNear = 0;
    this._snowNearTarget = 0;
    this._sunDir = new THREE.Vector3(0, 1, 0);
    // Alpenglow tint, rebuilt in place by _applyTime (never reallocated).
    this._alpenCol = new THREE.Color();

    // Blended palette state. Dome and mountain uniforms reference these
    // Color instances directly, so _applyTime updates propagate for free.
    this._cur = {
      top: new THREE.Color(), mid: new THREE.Color(), bot: new THREE.Color(),
      sun: new THREE.Color(), glow: new THREE.Color(), fog: new THREE.Color(),
      hemiSky: new THREE.Color(), hemiGround: new THREE.Color(),
      cloud: new THREE.Color(), mtn: new THREE.Color(),
      sunI: 1, hemiI: 1, cloudOp: 0.4, haze: 0.5, elev: 0.5, az: 0,
    };

    // Aerial-perspective snapshot handed out by getEnv(). One cached object:
    // the Vector3/Color fields are LIVE references into _sunDir/_cur (so
    // palette updates propagate for free); fogNear/fogFar mirror scene.fog,
    // which main.js owns. Consumers treat everything as read-only.
    this._env = {
      sunDir: this._sunDir,
      sunColor: this._cur.sun,
      hemiSky: this._cur.hemiSky,
      hemiGround: this._cur.hemiGround,
      fogColor: this._cur.fog,
      fogNear: 90,
      fogFar: 400,
    };

    // --- Sun light (main.js may toggle castShadow per quality tier) ---
    const q = CONFIG.quality.high;
    this.sunLight = new THREE.DirectionalLight(0xffffff, 2.0);
    this.sunLight.castShadow = !!q.shadows;
    this.sunLight.shadow.mapSize.set(q.shadowMap || 1024, q.shadowMap || 1024);
    const sc = this.sunLight.shadow.camera;
    sc.left = -28; sc.right = 28; sc.top = 34; sc.bottom = -12;
    sc.near = 1; sc.far = 140;
    sc.updateProjectionMatrix();
    this.sunLight.shadow.bias = -0.0004;
    this.sunLight.shadow.normalBias = 0.5;
    this.sunLight.shadow.radius = 3;
    scene.add(this.sunLight);
    scene.add(this.sunLight.target);

    this.hemi = new THREE.HemisphereLight(0xbdd9f0, 0x6f6146, 0.8);
    scene.add(this.hemi);

    // --- Sky dome (no curvature, no fog) ---
    this._domeMat = new THREE.ShaderMaterial({
      uniforms: {
        uTop: { value: this._cur.top },
        uMid: { value: this._cur.mid },
        uBot: { value: this._cur.bot },
        uGlow: { value: this._cur.glow },
        uSunDir: { value: this._sunDir },
        uNight: { value: 0 },
        uDesat: { value: 0 },
      },
      vertexShader: DOME_VERT,
      fragmentShader: DOME_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });
    this._dome = new THREE.Mesh(new THREE.SphereGeometry(800, 32, 18), this._domeMat);
    this._dome.name = 'skyDome'; // stable handle for the integrator's PMREM capture
    this._dome.frustumCulled = false;
    this._dome.renderOrder = -1000;
    scene.add(this._dome);

    // --- Far mountains: two concentric parallax rings ---
    const mkMtnMat = (hazeH) => new THREE.ShaderMaterial({
      uniforms: {
        uHaze: { value: this._cur.fog },
        uTint: { value: this._cur.mtn },
        // Live references into the blended palette and sun direction, so
        // _applyTime/update propagate to the shading with zero extra work.
        uSunDir: { value: this._sunDir },
        uSunCol: { value: this._cur.sun },
        uSkyCol: { value: this._cur.hemiSky },
        uGndCol: { value: this._cur.hemiGround },
        uAlpenCol: { value: this._alpenCol },
        uSunI: { value: 1 },
        uAlpen: { value: 0 },
        uHazeAmt: { value: 0.5 },
        uHazeH: { value: hazeH },
      },
      vertexShader: MTN_VERT,
      fragmentShader: MTN_FRAG,
      vertexColors: true,
      fog: false,
    });
    // Haze hugs only the mountain FEET; bodies and summits stay crisp so
    // the rock browns read true instead of bleaching into the sky color.
    this._farMat = mkMtnMat(48);
    this._midMat = mkMtnMat(36);
    this._twinPeaks = [];
    this._farRing = new THREE.Mesh(
      buildRidgeRing({
        radius: 500, count: 26, hMin: 90, hMax: 175, seed: 501, baseY: -14,
        dramatic: true, peaksOut: this._twinPeaks,
      }),
      this._farMat
    );
    this._midRing = new THREE.Mesh(
      buildRidgeRing({ radius: 380, count: 20, hMin: 50, hMax: 95, seed: 502, baseY: -10, dramatic: false, snowMulBase: 2.6, vegTop: 0.52 }),
      this._midMat
    );
    this._farRing.frustumCulled = false;
    this._midRing.frustumCulled = false;
    this._farRing.renderOrder = -900;
    this._midRing.renderOrder = -890;
    scene.add(this._farRing);
    scene.add(this._midRing);

    // --- Sun disc and glow sprites ---
    const mkSun = (scale, opacity) => {
      const m = new THREE.SpriteMaterial({
        map: Tex.softCircle('#ffffff'),
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
        opacity,
        fog: false,
      });
      const s = new THREE.Sprite(m);
      s.scale.set(scale, scale, 1);
      s.frustumCulled = false;
      scene.add(s);
      return s;
    };
    this._sunDisc = mkSun(26, 1.0);
    this._sunGlowIn = mkSun(95, 0.5);
    this._sunGlowOut = mkSun(250, 0.26);

    // --- Cloud layer: 14 sierra cumulus sprites ---
    // Puffy tops, flat shaded bases, drawn once on canvas (256 px).
    const crnd = mulberry32(2027);
    this._clouds = [];
    const cc = document.createElement('canvas');
    cc.width = 256; cc.height = 128;
    const cctx = cc.getContext('2d');
    const cpr = mulberry32(41);
    for (let p = 0; p < 26; p++) {
      const px = 24 + cpr() * 208;
      const baseline = 92;
      const r = 12 + cpr() * 26;
      const py = baseline - r * (0.35 + cpr() * 0.75);
      const g = cctx.createRadialGradient(px, py, r * 0.1, px, py, r);
      g.addColorStop(0, 'rgba(255,255,255,0.95)');
      g.addColorStop(0.72, 'rgba(255,255,255,0.55)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      cctx.fillStyle = g;
      cctx.fillRect(px - r, Math.max(0, py - r), r * 2, Math.min(r * 2, baseline - (py - r)));
    }
    // Soft gray shading along the flat base.
    const shade = cctx.createLinearGradient(0, 70, 0, 96);
    shade.addColorStop(0, 'rgba(178,192,208,0)');
    shade.addColorStop(1, 'rgba(178,192,208,0.35)');
    cctx.globalCompositeOperation = 'source-atop';
    cctx.fillStyle = shade;
    cctx.fillRect(0, 0, 256, 128);
    cctx.globalCompositeOperation = 'source-over';
    const cloudTex = new THREE.CanvasTexture(cc);
    cloudTex.colorSpace = THREE.SRGBColorSpace;
    this._cloudTex = cloudTex;
    for (let i = 0; i < 14; i++) {
      const m = new THREE.SpriteMaterial({
        map: cloudTex,
        transparent: true,
        depthWrite: false,
        opacity: 0.35,
        fog: false,
      });
      const spr = new THREE.Sprite(m);
      const w = randRange(crnd, 140, 340);
      const hh = w * randRange(crnd, 0.3, 0.42);
      spr.scale.set(w, hh, 1);
      spr.frustumCulled = false;
      // Positive order keeps the lit top above its shaded base twin. The
      // base must NOT use a negative order: sprites sorted ahead of the
      // whole transparent pass render as hard alpha-less slabs here.
      spr.renderOrder = 1;
      this._scene.add(spr);
      // Darker underside twin: shared texture, tinted in _applyTime, offset
      // a few texels down and drawn first so the cumulus reads as a lit top
      // over a shaded flat base (cheap 2-layer volume).
      const mU = new THREE.SpriteMaterial({
        map: cloudTex,
        transparent: true,
        depthWrite: false,
        opacity: 0.3,
        fog: false,
      });
      const sprU = new THREE.Sprite(mU);
      sprU.scale.set(w * 1.03, hh * 1.03, 1);
      sprU.frustumCulled = false;
      this._scene.add(sprU);
      this._clouds.push({
        spr, m, sprU, mU,
        dy: hh * 0.055,
        ang: crnd() * TAU,
        // BEYOND the range, not inside it. The connected crest sits at radius
        // 500 with flanks reaching well inward, so the old 240-430 deck was
        // literally embedded in the mountains, drawing huge soft sprites
        // across their faces and milking the whole frame out.
        rad: randRange(crnd, 545, 700),
        y: randRange(crnd, 150, 300),
        spd: randRange(crnd, 0.0015, 0.005) * (crnd() < 0.5 ? -1 : 1),
        opMul: randRange(crnd, 0.55, 1),
      });
    }

    // --- High cirrus veil: 6 stretched wisps far above the cumulus deck ---
    this._cirrusTex = makeCirrusTexture();
    this._cirrus = [];
    for (let i = 0; i < 6; i++) {
      const m = new THREE.SpriteMaterial({
        map: this._cirrusTex,
        transparent: true,
        depthWrite: false,
        opacity: 0.14,
        fog: false,
      });
      const spr = new THREE.Sprite(m);
      const w = randRange(crnd, 360, 640);
      spr.scale.set(w, w * randRange(crnd, 0.055, 0.085), 1);
      spr.frustumCulled = false;
      this._scene.add(spr);
      this._cirrus.push({
        spr, m,
        ang: crnd() * TAU,
        rad: randRange(crnd, 600, 760),
        y: randRange(crnd, 330, 430),
        spd: randRange(crnd, 0.0008, 0.002) * (crnd() < 0.5 ? -1 : 1),
        opMul: randRange(crnd, 0.5, 1),
      });
    }

    // --- Ambient condors circling at distance ---
    this._condors = [];
    for (let i = 0; i < 3; i++) {
      const c = buildCondor();
      c.group.scale.setScalar(2.2);
      scene.add(c.group);
      this._condors.push({
        obj: c,
        ang: (i / 3) * TAU,
        rad: 70 + i * 26,
        h: 55 + i * 16,
        spd: 0.05 + i * 0.016,
        dir: i % 2 === 0 ? 1 : -1,
        phase: i * 2.1,
      });
    }

    // --- Lenticular cloud stacks over the two dramatic twin peaks ---
    // The far ring follows the camera 1:1, so fixed offsets keep these
    // hovering over those exact summits. 6 sprites total.
    this._lensTex = makeLensTexture();
    this._lenti = [];
    for (let p = 0; p < this._twinPeaks.length && p < 2; p++) {
      const pk = this._twinPeaks[p];
      for (let i = 0; i < 3; i++) {
        const m = new THREE.SpriteMaterial({
          map: this._lensTex,
          transparent: true,
          depthWrite: false,
          opacity: 0.2,
          fog: false,
        });
        const spr = new THREE.Sprite(m);
        const w = pk.h * (0.62 - i * 0.13);
        spr.scale.set(w, w * 0.17, 1);
        spr.frustumCulled = false;
        scene.add(spr);
        this._lenti.push({
          spr, m,
          px: pk.x, pz: pk.z,
          y: pk.h * 1.03 + 10 + i * 15,
          w, h: w * 0.17,
          ph: p * 2.6 + i * 1.9,
          op0: 0.28 - i * 0.055,
        });
      }
    }

    // --- Moon: one phase-lit sprite opposite the sun azimuth ---
    this._moonTex = makeMoonTexture();
    this._moonMat = new THREE.SpriteMaterial({
      map: this._moonTex,
      transparent: true,
      depthWrite: false,
      opacity: 0,
      fog: false,
    });
    this._moon = new THREE.Sprite(this._moonMat);
    this._moon.scale.set(34, 34, 1);
    this._moon.frustumCulled = false;
    this._moonDir = new THREE.Vector3(0, 1, 0);
    scene.add(this._moon);

    this.setTimeOfDay(CONFIG.timeOfDayStart);
  }

  setTimeOfDay(t) {
    this._tod = clamp(t, 0, 1);
    this._applyTime(this._tod);
  }

  setSnowcapNear(f) {
    this._snowNearTarget = clamp(f, 0, 1);
  }

  getSunDir(outVec3) {
    return outVec3.copy(this._sunDir);
  }

  // Single source of truth for aerial perspective. Returns the SAME cached
  // object every call (zero alloc): { sunDir, sunColor, hemiSky, hemiGround,
  // fogColor, fogNear, fogFar }. sunDir/colors are live references kept in
  // sync by _applyTime; fogColor is the palette target scene.fog.color eases
  // toward; fogNear/fogFar mirror scene.fog (owned by main.js). Read-only.
  getEnv() {
    return this._env;
  }

  _applyTime(t) {
    let i = 0;
    while (i < KEYS.length - 2 && t > KEYS[i + 1].t) i++;
    const a = KEYS[i];
    const b = KEYS[i + 1];
    const u = clamp((t - a.t) / (b.t - a.t), 0, 1);
    const s = u * u * (3 - 2 * u);
    const c = this._cur;

    c.top.lerpColors(a.top, b.top, s);
    c.mid.lerpColors(a.mid, b.mid, s);
    c.bot.lerpColors(a.bot, b.bot, s);
    c.sun.lerpColors(a.sun, b.sun, s);
    c.glow.lerpColors(a.glow, b.glow, s);
    c.fog.lerpColors(a.fog, b.fog, s);
    c.hemiSky.lerpColors(a.hemiSky, b.hemiSky, s);
    c.hemiGround.lerpColors(a.hemiGround, b.hemiGround, s);
    c.cloud.lerpColors(a.cloud, b.cloud, s);
    c.mtn.lerpColors(a.mtn, b.mtn, s);
    c.sunI = lerp(a.sunI, b.sunI, s);
    c.hemiI = lerp(a.hemiI, b.hemiI, s);
    c.cloudOp = lerp(a.cloudOp, b.cloudOp, s);
    c.haze = lerp(a.haze, b.haze, s);
    c.elev = lerp(a.elev, b.elev, s);
    c.az = lerp(a.az, b.az, s);

    // Palette lerps dip through gray mid-blend; re-saturate the atmosphere
    // colors there so transitions stay crystal clear, never muddy.
    const dip = 4 * s * (1 - s) * 0.24;
    if (dip > 0.003) {
      _resat(c.top, dip);
      _resat(c.mid, dip);
      _resat(c.bot, dip);
      _resat(c.fog, dip);
      _resat(c.mtn, dip * 0.7);
      _resat(c.cloud, dip * 0.5);
    }

    const ce = Math.cos(c.elev);
    this._sunDir.set(ce * Math.sin(c.az), Math.sin(c.elev), -ce * Math.cos(c.az)).normalize();

    this.sunLight.color.copy(c.sun);
    this.sunLight.intensity = c.sunI;
    this.hemi.color.copy(c.hemiSky);
    this.hemi.groundColor.copy(c.hemiGround);
    this.hemi.intensity = c.hemiI;

    this._sunDisc.material.color.copy(c.sun).lerp(WHITE, 0.5);
    this._sunGlowIn.material.color.copy(c.glow);
    this._sunGlowOut.material.color.copy(c.glow);

    this._farMat.uniforms.uHazeAmt.value = c.haze;
    this._midMat.uniforms.uHazeAmt.value = c.haze * 0.7;
    this._farMat.uniforms.uSunI.value = c.sunI;
    this._midMat.uniforms.uSunI.value = c.sunI;

    // Alpenglow ramps in purely on SUN ELEVATION, so it fires at dawn, golden
    // hour and dusk and is exactly zero around midday (elev 0.9 at t = 0.5).
    // The shipping default t = 0.48 sits at elev ~0.90, so it never shows in
    // normal play; it is still correct for when the clock does move.
    const alpen = 1 - smoothstep(0.05, 0.62, c.elev);
    this._alpenCol.copy(c.glow).lerp(ALPEN_ROSE, 0.55).multiplyScalar(0.5);
    this._farMat.uniforms.uAlpen.value = alpen;
    this._midMat.uniforms.uAlpen.value = alpen * 0.7;
    // Horizon desaturation scales with the palette haze (thin at noon).
    this._domeMat.uniforms.uDesat.value = c.haze * 0.28;

    for (let k = 0; k < this._clouds.length; k++) {
      const cl = this._clouds[k];
      cl.m.color.copy(c.cloud);
      cl.m.opacity = c.cloudOp * cl.opMul;
      // Underside: shaded cloud color pulled toward the haze (all in place).
      cl.mU.color.copy(c.cloud).multiplyScalar(0.66).lerp(c.fog, 0.28);
      cl.mU.opacity = c.cloudOp * cl.opMul * 0.85;
    }
    for (let k = 0; k < this._cirrus.length; k++) {
      const ci = this._cirrus[k];
      ci.m.color.copy(c.cloud).lerp(WHITE, 0.4);
      ci.m.opacity = c.cloudOp * ci.opMul * 0.42;
    }

    // Keep the env snapshot's fog scalars honest (main.js owns near/far).
    const fog = this._scene.fog;
    if (fog) {
      this._env.fogNear = fog.near;
      this._env.fogFar = fog.far;
    }

    // Night gate for the Milky Way band (late dusk and pre-dawn only).
    let night = 0;
    if (t > 0.88) night = smoothstep(0.88, 0.965, t);
    else if (t < 0.08) night = 1 - smoothstep(0.015, 0.08, t);
    this._domeMat.uniforms.uNight.value = night;

    // Moon rides opposite the sun azimuth; fades in with the same gates.
    let moonUp = 0;
    if (t > 0.82) moonUp = smoothstep(0.82, 0.93, t);
    else if (t < 0.12) moonUp = 1 - smoothstep(0.03, 0.12, t);
    const mce = Math.cos(0.5);
    this._moonDir.set(-Math.sin(c.az) * mce, Math.sin(0.5), Math.cos(c.az) * mce);
    this._moonMat.opacity = moonUp * 0.85;
    this._moonMat.color.copy(WHITE).lerp(c.fog, 0.12);

    // Lenticular stacks tint with the cloud palette, kept subtle.
    for (let k = 0; k < this._lenti.length; k++) {
      const L = this._lenti[k];
      L.m.color.copy(c.cloud);
      L.m.opacity = clamp(L.op0 * (0.6 + c.cloudOp), 0.15, 0.3);
    }
  }

  update(dt, camera, distance) {
    this._time += dt;
    const cp = camera.position;

    // Dome and mountain rings follow the camera (mid ring lags = parallax).
    this._dome.position.set(cp.x, 0, cp.z);
    this._farRing.position.set(cp.x, 0, cp.z);
    this._snowNear = damp(this._snowNear, this._snowNearTarget, 3, dt);
    const sn = this._snowNear;
    this._midRing.position.set(cp.x * 0.92, sn * 5, cp.z * 0.92);
    this._midRing.scale.set(1 - 0.05 * sn, 1 + 0.22 * sn, 1 - 0.05 * sn);

    // Sun light rides with the camera; its target tracks the lane ahead.
    this.sunLight.position.copy(cp).addScaledVector(this._sunDir, 55);
    this.sunLight.target.position.set(cp.x, 0, cp.z - 16);

    // Sun disc and glows sit on the dome shell.
    this._sunDisc.position.copy(cp).addScaledVector(this._sunDir, 730);
    this._sunGlowIn.position.copy(this._sunDisc.position);
    this._sunGlowOut.position.copy(this._sunDisc.position);

    // Moon opposite the sun, also on the dome shell.
    this._moon.position.copy(cp).addScaledVector(this._moonDir, 730);

    // Lenticular lens stacks breathe slowly over the twin peaks.
    for (let i = 0; i < this._lenti.length; i++) {
      const L = this._lenti[i];
      const b = 1 + Math.sin(this._time * 0.05 + L.ph) * 0.045;
      L.spr.scale.set(L.w * b, L.h * (2 - b), 1);
      L.spr.position.set(cp.x + L.px, L.y, cp.z + L.pz);
    }

    // Fog eases toward the palette horizon color (near/far owned by main.js;
    // we only mirror them into the cached env snapshot).
    const fog = this._scene.fog;
    if (fog) {
      fog.color.lerp(this._cur.fog, 1 - Math.exp(-2.5 * dt));
      this._env.fogNear = fog.near;
      this._env.fogFar = fog.far;
    }

    // Clouds drift in slow arcs around the camera; each underside twin rides
    // just below its parent for the 2-layer parallax volume.
    for (let i = 0; i < this._clouds.length; i++) {
      const cl = this._clouds[i];
      cl.ang += cl.spd * dt;
      const cx = cp.x + Math.cos(cl.ang) * cl.rad;
      const cz = cp.z + Math.sin(cl.ang) * cl.rad;
      cl.spr.position.set(cx, cl.y, cz);
      cl.sprU.position.set(cx, cl.y - cl.dy, cz);
    }

    // Cirrus veil drifts slower and higher (distinct parallax band).
    for (let i = 0; i < this._cirrus.length; i++) {
      const ci = this._cirrus[i];
      ci.ang += ci.spd * dt;
      ci.spr.position.set(
        cp.x + Math.cos(ci.ang) * ci.rad,
        ci.y,
        cp.z + Math.sin(ci.ang) * ci.rad
      );
    }

    // Condors circle a point slightly ahead of the runner.
    for (let i = 0; i < this._condors.length; i++) {
      const cd = this._condors[i];
      cd.ang += cd.spd * cd.dir * dt;
      const ca = Math.cos(cd.ang);
      const sa = Math.sin(cd.ang);
      cd.obj.group.position.set(
        cp.x + ca * cd.rad,
        cd.h + Math.sin(this._time * 0.35 + cd.phase) * 4,
        cp.z - 45 + sa * cd.rad
      );
      const tx = -sa * cd.dir;
      const tz = ca * cd.dir;
      cd.obj.group.rotation.y = Math.atan2(-tx, -tz);
      cd.obj.group.rotation.z = 0.22 * cd.dir;
      cd.obj.update(dt);
    }
  }

  dispose() {
    const s = this._scene;
    s.remove(this.sunLight, this.sunLight.target, this.hemi);
    s.remove(this._dome, this._farRing, this._midRing);
    s.remove(this._sunDisc, this._sunGlowIn, this._sunGlowOut);
    this._dome.geometry.dispose();
    this._domeMat.dispose();
    this._farRing.geometry.dispose();
    this._midRing.geometry.dispose();
    this._farMat.dispose();
    this._midMat.dispose();
    this._sunDisc.material.dispose();
    this._sunGlowIn.material.dispose();
    this._sunGlowOut.material.dispose();
    s.remove(this._moon);
    this._moonMat.dispose();
    this._moonTex.dispose();
    for (const L of this._lenti) {
      s.remove(L.spr);
      L.m.dispose();
    }
    this._lenti.length = 0;
    this._lensTex.dispose();
    for (const cl of this._clouds) {
      s.remove(cl.spr, cl.sprU);
      cl.m.dispose();
      cl.mU.dispose();
    }
    for (const ci of this._cirrus) {
      s.remove(ci.spr);
      ci.m.dispose();
    }
    this._cirrus.length = 0;
    this._cirrusTex.dispose();
    this._cloudTex.dispose();
    for (const cd of this._condors) {
      s.remove(cd.obj.group);
      cd.obj.group.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
      });
    }
    this._clouds.length = 0;
    this._condors.length = 0;
  }
}
