// Sky dome, sun, far Andes ridgelines, drifting clouds and ambient condors.
// Owns time-of-day palette blending; drives scene fog color and light colors.

import * as THREE from 'three';
import { CONFIG } from './config.js';
import { clamp, lerp, damp, smoothstep, mulberry32, randRange, TAU } from './util.js';
import { Tex } from './materials.js';
import { buildCondor } from './animals.js';

const WHITE = new THREE.Color(0xffffff);

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
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  float h = max(d.y, 0.0);
  vec3 col = mix(uBot, uMid, smoothstep(0.0, 0.24, h));
  col = mix(col, uTop, smoothstep(0.24, 0.85, h));
  if (d.y < 0.0) col = uBot * (1.0 + d.y * 0.35);
  float s = max(dot(d, uSunDir), 0.0);
  col += uGlow * (pow(s, 14.0) * 0.45 + pow(s, 90.0) * 0.35);
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

const MTN_VERT = /* glsl */ `
varying vec3 vColor;
varying float vY;
void main() {
  vColor = color;
  vY = position.y;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const MTN_FRAG = /* glsl */ `
uniform vec3 uHaze;
uniform vec3 uTint;
uniform float uHazeAmt;
uniform float uHazeH;
varying vec3 vColor;
varying float vY;
void main() {
  float hz = uHazeAmt * (1.0 - smoothstep(0.0, uHazeH, vY));
  hz = min(hz + uHazeAmt * 0.08, 0.96);
  vec3 col = mix(vColor * uTint, uHaze, hz);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// ---------------------------------------------------------------------------
// Far mountain ring geometry: craggy ridged massifs with baked snow caps.
// Each peak stacks three jittered rings (base, low shoulder, high shoulder)
// under a summit fan; per-face brightness variance bakes rock strata into
// the vertex colors, and bare foothills layer in front of the major summits.
// ---------------------------------------------------------------------------

function buildRidgeRing({ radius, count, hMin, hMax, seed, baseY, dramatic, peaksOut, snowMulBase = 1, vegTop = 0.42 }) {
  const rnd = mulberry32(seed);
  const positions = [];
  const colors = [];
  // Photo-real palette (Ausangate / Salkantay / Valle Sagrado references):
  // the mass of the mountain is warm brown rock; snow lives only in the
  // upper reaches, patchy, with tongues running down the couloirs.
  const rockA = new THREE.Color(0x6b573c);
  const rockB = new THREE.Color(0x7d6a52);
  const crag = new THREE.Color(0x5c5450);
  // Vegetated lower slopes: sierra forest and field greens (Huascaran ref).
  const vegA = new THREE.Color(0x437028);
  const vegB = new THREE.Color(0x64943a);
  const veg = new THREE.Color();
  const snow = new THREE.Color(0xf8fbff);
  const ice = new THREE.Color(0xc2d8ee);
  const rock = new THREE.Color();
  const tmp = new THREE.Color();
  const tmp2 = new THREE.Color();
  const tmp3 = new THREE.Color();
  const S = 20;

  // snowMul > 1 lifts the snowline above the summit (bare rocky foothills).
  function addPeak(cx, cz, h, rb, snowMul = snowMulBase) {
    rock.lerpColors(rockA, rockB, rnd());
    veg.lerpColors(vegA, vegB, rnd());
    const rot = rnd() * TAU;
    // Heavy glaciation on the giants (the white wall of the reference);
    // snowMul > 1 pushes it above the summit for the green front ranges.
    const snowLine = h * (0.47 + rnd() * 0.09) * snowMul;
    const blend = h * 0.1;

    // Octave 1: four coarse radius lobes blended smoothly around the ring.
    const lobes = [
      0.72 + rnd() * 0.55, 0.72 + rnd() * 0.55,
      0.72 + rnd() * 0.55, 0.72 + rnd() * 0.55,
    ];
    function coarseAt(t) {
      const f = (t - Math.floor(t)) * 4;
      const i0 = f | 0;
      const u = f - i0;
      const su = u * u * (3 - 2 * u);
      return lerp(lobes[i0 % 4], lobes[(i0 + 1) % 4], su);
    }

    // Octave 2: per-spoke jitter on every ring (angles, radii, heights).
    const ang = [], br = [], lr = [], ly = [], mr = [], my = [], sh = [], rib = [];
    const ur = [], uy = [];
    for (let s = 0; s < S; s++) {
      const c1 = coarseAt(s / S);
      ang.push(rot + (s / S) * TAU + (rnd() - 0.5) * (TAU / S) * 0.5);
      br.push(rb * c1 * (0.86 + rnd() * 0.3));
      lr.push(rb * c1 * 0.6 * (0.76 + rnd() * 0.48));
      ly.push(h * (0.15 + rnd() * 0.15));
      mr.push(rb * c1 * 0.3 * (0.66 + rnd() * 0.62));
      my.push(h * (0.42 + rnd() * 0.22));
      // Upper shoulder: puts real vertices at the snowline so the summit
      // band is white-on-vertices instead of a half-mountain gradient.
      ur.push(rb * c1 * 0.15 * (0.6 + rnd() * 0.5));
      uy.push(h * (0.68 + rnd() * 0.12));
      sh.push(0.82 + rnd() * 0.3);
      // Couloir snow tongue: some gullies carry snow well below the line.
      // (Both draws are unconditional to keep the RNG stream deterministic.)
      const tb = rnd();
      const tv = h * (0.34 + rnd() * 0.08);
      rib.push(tb < 0.26 ? tv : -1);
    }
    const ax = cx + (rnd() - 0.5) * rb * 0.12;
    const az = cz + (rnd() - 0.5) * rb * 0.12;

    function pushV(x, y, z, shade, tongueY, patch) {
      positions.push(x, y, z);
      // Patchy snow above an irregular high line, plus couloir tongues.
      let k = clamp((y - (snowLine - blend)) / (2 * blend), 0, 1);
      k = k * k * (3 - 2 * k);
      if (tongueY >= 0 && y > tongueY) {
        k = Math.max(k, 0.9 * clamp((y - tongueY) / (h * 0.14), 0, 1));
      }
      const kk = clamp(k * patch, 0, 1);
      // Slopes: green forest low, brown rock band, gray crags at the snow
      // margins. vegTop sets how high the green climbs (front ranges: high).
      const hy = clamp((y - baseY) / ((h - baseY) || 1), 0, 1);
      tmp3.copy(veg).lerp(rock, smoothstep(vegTop * 0.55, vegTop, hy));
      tmp3.lerp(crag, clamp((hy - 0.52) * 1.7, 0, 1) * 0.5);
      // Shaded snow leans glacial blue.
      const iceK = clamp((1 - shade) * 2, 0, 0.6) * kk;
      tmp2.copy(snow).lerp(ice, iceK);
      tmp.lerpColors(tmp3, tmp2, kk);
      const m = lerp(shade, 0.94 + shade * 0.06, kk);
      colors.push(tmp.r * m, tmp.g * m, tmp.b * m);
    }
    // One flat-shaded face; per-face brightness variance reads as strata and
    // per-face snow patchiness breaks the snowline into an irregular edge.
    function tri(x0, y0, z0, x1, y1, z1, x2, y2, z2, shade, band, tongueY) {
      const f = shade * band * (0.92 + rnd() * 0.16);
      const patch = 0.5 + rnd() * 0.75;
      pushV(x0, y0, z0, f, tongueY, patch);
      pushV(x1, y1, z1, f, tongueY, patch);
      pushV(x2, y2, z2, f, tongueY, patch);
    }

    for (let s = 0; s < S; s++) {
      const s1 = (s + 1) % S;
      const c0 = Math.cos(ang[s]), n0 = Math.sin(ang[s]);
      const c1a = Math.cos(ang[s1]), n1 = Math.sin(ang[s1]);
      const b0x = cx + c0 * br[s], b0z = cz + n0 * br[s];
      const b1x = cx + c1a * br[s1], b1z = cz + n1 * br[s1];
      const l0x = cx + c0 * lr[s], l0z = cz + n0 * lr[s];
      const l1x = cx + c1a * lr[s1], l1z = cz + n1 * lr[s1];
      const m0x = cx + c0 * mr[s], m0z = cz + n0 * mr[s];
      const m1x = cx + c1a * mr[s1], m1z = cz + n1 * mr[s1];
      const u0x = cx + c0 * ur[s], u0z = cz + n0 * ur[s];
      const u1x = cx + c1a * ur[s1], u1z = cz + n1 * ur[s1];
      const shade = sh[s];
      const tongueS = rib[s];
      // Foot band.
      tri(b0x, baseY, b0z, b1x, baseY, b1z, l1x, ly[s1], l1z, shade, 0.96, tongueS);
      tri(b0x, baseY, b0z, l1x, ly[s1], l1z, l0x, ly[s], l0z, shade, 0.96, tongueS);
      // Mid-slope shoulder band.
      tri(l0x, ly[s], l0z, l1x, ly[s1], l1z, m1x, my[s1], m1z, shade, 1.0, tongueS);
      tri(l0x, ly[s], l0z, m1x, my[s1], m1z, m0x, my[s], m0z, shade, 1.0, tongueS);
      // Upper shoulder band (crags to snowline).
      tri(m0x, my[s], m0z, m1x, my[s1], m1z, u1x, uy[s1], u1z, shade, 1.02, tongueS);
      tri(m0x, my[s], m0z, u1x, uy[s1], u1z, u0x, uy[s], u0z, shade, 1.02, tongueS);
      // Summit cap.
      tri(u0x, uy[s], u0z, u1x, uy[s1], u1z, ax, h, az, shade, 1.05, tongueS);
    }
  }

  // Two recognizable dramatic peaks sit ahead of the runner (angle ~ 3/4 TAU).
  const majors = [];
  const kd1 = Math.round(count * 0.69);
  const kd2 = Math.round(count * 0.81);
  for (let k = 0; k < count; k++) {
    const ang = (k / count) * TAU + (rnd() - 0.5) * (TAU / count) * 0.6;
    const rad = radius + (rnd() - 0.5) * radius * 0.12;
    const cx = Math.cos(ang) * rad;
    const cz = Math.sin(ang) * rad;
    let h = randRange(rnd, hMin, hMax);
    let rb = h * randRange(rnd, 0.9, 1.4);
    if (dramatic && (k === kd1 || k === kd2)) {
      h *= 1.6;
      rb *= 1.25;
      if (peaksOut) peaksOut.push({ x: cx, z: cz, h });
      addPeak(cx, cz, h, rb);
      // Twin shoulder summit for a recognizable silhouette.
      addPeak(cx + Math.cos(ang + 1.35) * rb * 0.55,
              cz + Math.sin(ang + 1.35) * rb * 0.55, h * 0.62, rb * 0.55);
      majors.push({ ang, rad, h, rb });
    } else {
      addPeak(cx, cz, h, rb);
      if (h > hMax * 0.92) majors.push({ ang, rad, h, rb });
    }
  }

  // Second, lower foothill band in front of the major summits: bare rock
  // (lifted snowline), tighter bases, so the big massifs rise from layered
  // ridgelines instead of standing as lone cones.
  for (const M of majors) {
    const n = 3 + ((rnd() * 2) | 0);
    for (let f = 0; f < n; f++) {
      const fa = M.ang + (rnd() - 0.5) * 0.26;
      const fr = M.rad * (0.74 + rnd() * 0.14);
      addPeak(
        Math.cos(fa) * fr, Math.sin(fa) * fr,
        M.h * (0.26 + rnd() * 0.18), M.rb * (0.38 + rnd() * 0.24), 2.5
      );
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(colors), 3));
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

    // Blended palette state. Dome and mountain uniforms reference these
    // Color instances directly, so _applyTime updates propagate for free.
    this._cur = {
      top: new THREE.Color(), mid: new THREE.Color(), bot: new THREE.Color(),
      sun: new THREE.Color(), glow: new THREE.Color(), fog: new THREE.Color(),
      hemiSky: new THREE.Color(), hemiGround: new THREE.Color(),
      cloud: new THREE.Color(), mtn: new THREE.Color(),
      sunI: 1, hemiI: 1, cloudOp: 0.4, haze: 0.5, elev: 0.5, az: 0,
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
      },
      vertexShader: DOME_VERT,
      fragmentShader: DOME_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });
    this._dome = new THREE.Mesh(new THREE.SphereGeometry(800, 32, 18), this._domeMat);
    this._dome.frustumCulled = false;
    this._dome.renderOrder = -1000;
    scene.add(this._dome);

    // --- Far mountains: two concentric parallax rings ---
    const mkMtnMat = (hazeH) => new THREE.ShaderMaterial({
      uniforms: {
        uHaze: { value: this._cur.fog },
        uTint: { value: this._cur.mtn },
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
      buildRidgeRing({ radius: 380, count: 20, hMin: 50, hMax: 95, seed: 502, baseY: -10, dramatic: false, snowMulBase: 2.6, vegTop: 0.8 }),
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
      spr.scale.set(w, w * randRange(crnd, 0.3, 0.42), 1);
      spr.frustumCulled = false;
      this._scene.add(spr);
      this._clouds.push({
        spr, m,
        ang: crnd() * TAU,
        rad: randRange(crnd, 240, 430),
        y: randRange(crnd, 100, 175),
        spd: randRange(crnd, 0.0015, 0.005) * (crnd() < 0.5 ? -1 : 1),
        opMul: randRange(crnd, 0.55, 1),
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

    for (let k = 0; k < this._clouds.length; k++) {
      const cl = this._clouds[k];
      cl.m.color.copy(c.cloud);
      cl.m.opacity = c.cloudOp * cl.opMul;
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

    // Fog eases toward the palette horizon color.
    if (this._scene.fog) {
      this._scene.fog.color.lerp(this._cur.fog, 1 - Math.exp(-2.5 * dt));
    }

    // Clouds drift in slow arcs around the camera.
    for (let i = 0; i < this._clouds.length; i++) {
      const cl = this._clouds[i];
      cl.ang += cl.spd * dt;
      cl.spr.position.set(
        cp.x + Math.cos(cl.ang) * cl.rad,
        cl.y,
        cp.z + Math.sin(cl.ang) * cl.rad
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
      s.remove(cl.spr);
      cl.m.dispose();
    }
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
