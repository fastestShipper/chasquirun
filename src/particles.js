// Pooled particle systems: one-shot bursts (dust, sparkle, debris, splash),
// plus ambient fields (snow, mist, embers). Zero allocations per frame:
// every buffer, vector and color is preallocated at construction.

import * as THREE from 'three';
import { CONFIG } from './config.js';
import { damp, mulberry32, TAU } from './util.js';
import { Tex, Curve } from './materials.js';

const POINTS_VERT = /* glsl */ `
attribute float aAlpha;
attribute float aSize;
attribute vec3 aColor;
uniform float uCurveY;
uniform float uCurveX;
uniform float uPxScale;
varying float vAlpha;
varying vec3 vColor;
void main() {
  vColor = aColor;
  vAlpha = aAlpha;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  mvPosition.y += uCurveY * mvPosition.z * mvPosition.z;
  mvPosition.x += uCurveX * mvPosition.z * mvPosition.z;
  float d = max(0.5, -mvPosition.z);
  gl_PointSize = aSize * uPxScale / d;
  if (mvPosition.z > -0.1) gl_PointSize = 0.0;
  gl_Position = projectionMatrix * mvPosition;
}
`;

const POINTS_FRAG = /* glsl */ `
uniform float uOpacity;
varying float vAlpha;
varying vec3 vColor;
void main() {
  // Procedural soft disc: no texture dependency, no white-square failure mode.
  float r = length(gl_PointCoord - vec2(0.5));
  float mask = smoothstep(0.5, 0.14, r);
  float a = mask * vAlpha * uOpacity;
  if (a < 0.004) discard;
  gl_FragColor = vec4(vColor, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// Ambient field bounds (local to a holder that follows the camera).
const SNOW_X = 26, SNOW_TOP = 18, SNOW_ZMIN = -38, SNOW_ZMAX = 12;
const EMB_X = 18, EMB_ZMIN = -42, EMB_ZMAX = 6;
const MIST_X = 24, MIST_ZMIN = -46, MIST_ZMAX = 6;

export class Particles {
  constructor(scene) {
    this._scene = scene;
    this._time = 0;
    this._worldVel = 0;
    this._c = new THREE.Color();
    this._tex = Tex.softCircle('#ffffff');

    // One-shot pools (budgets per ARCHITECTURE.md; burst shares sparkle).
    this._dust = this._makePool(64, THREE.NormalBlending, -1.2, 2.2, 1.8, 0.38, 10);
    this._sparkle = this._makePool(128, THREE.AdditiveBlending, -3.5, 1.2, -0.5, 1.0, 11);
    this._debris = this._makePool(48, THREE.NormalBlending, -22, 0.1, 0, 1.0, 10);
    this._splash = this._makePool(64, THREE.NormalBlending, -16, 0.4, 0.4, 0.9, 10);

    this._buildSnow();
    this._buildEmbers();
    this._buildMist();

    this._snowOn = false; this._snowFade = 0;
    this._embersOn = false; this._embersFade = 0;
    this._mistOn = false; this._mistFade = 0;
  }

  _makePointsMat(blending, opacity) {
    return new THREE.ShaderMaterial({
      uniforms: {
        uOpacity: { value: opacity },
        uPxScale: { value: 540 },
        uCurveY: Curve.uniforms.uCurveY,
        uCurveX: Curve.uniforms.uCurveX,
      },
      vertexShader: POINTS_VERT,
      fragmentShader: POINTS_FRAG,
      transparent: true,
      depthWrite: false,
      blending,
      fog: false,
    });
  }

  _makePool(cap, blending, gravity, drag, grow, opacity, renderOrder) {
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(cap * 3);
    const col = new Float32Array(cap * 3);
    const alpha = new Float32Array(cap);
    const size = new Float32Array(cap);
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    const mat = this._makePointsMat(blending, opacity);
    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    points.renderOrder = renderOrder;
    this._scene.add(points);
    return {
      points, geo, mat, cap,
      pos, col, alpha, size,
      vel: new Float32Array(cap * 3),
      life: new Float32Array(cap),
      dur: new Float32Array(cap),
      size0: new Float32Array(cap),
      cursor: 0, alive: 0, flush: false,
      g: gravity, drag, grow,
    };
  }

  // Ring-buffer emit. Long argument list keeps this allocation-free.
  _emit(p, px, py, pz, n, spread, hMin, hMax, vyMin, vyMax,
        lifeMin, lifeMax, sMin, sMax, r, g, b, jit) {
    for (let k = 0; k < n; k++) {
      const i = p.cursor;
      p.cursor = (i + 1) % p.cap;
      if (p.life[i] <= 0) p.alive++;
      const i3 = i * 3;
      p.pos[i3] = px + (Math.random() - 0.5) * 2 * spread;
      p.pos[i3 + 1] = py + (Math.random() - 0.5) * 2 * spread;
      p.pos[i3 + 2] = pz + (Math.random() - 0.5) * 2 * spread;
      const ang = Math.random() * TAU;
      const sp = hMin + Math.random() * (hMax - hMin);
      p.vel[i3] = Math.cos(ang) * sp;
      p.vel[i3 + 1] = vyMin + Math.random() * (vyMax - vyMin);
      p.vel[i3 + 2] = Math.sin(ang) * sp;
      const life = lifeMin + Math.random() * (lifeMax - lifeMin);
      p.life[i] = life;
      p.dur[i] = life;
      p.size0[i] = sMin + Math.random() * (sMax - sMin);
      p.alpha[i] = 0;
      const m = 1 - jit * Math.random();
      p.col[i3] = r * m;
      p.col[i3 + 1] = g * m;
      p.col[i3 + 2] = b * m;
    }
    p.geo.attributes.aColor.needsUpdate = true;
    p.flush = true;
  }

  _updatePool(p, dt) {
    if (p.alive === 0 && !p.flush) return;
    const wv = this._worldVel * dt;
    const dragMul = 1 / (1 + p.drag * dt);
    for (let i = 0; i < p.cap; i++) {
      let l = p.life[i];
      if (l <= 0) continue;
      l -= dt;
      if (l <= 0) {
        p.life[i] = 0;
        p.alpha[i] = 0;
        p.alive--;
        continue;
      }
      p.life[i] = l;
      const i3 = i * 3;
      p.vel[i3] *= dragMul;
      p.vel[i3 + 1] = p.vel[i3 + 1] * dragMul + p.g * dt;
      p.vel[i3 + 2] *= dragMul;
      p.pos[i3] += p.vel[i3] * dt;
      p.pos[i3 + 1] += p.vel[i3 + 1] * dt;
      p.pos[i3 + 2] += p.vel[i3 + 2] * dt + wv;
      const l01 = l / p.dur[i];
      const fadeIn = Math.min(1, (1 - l01) * 6);
      p.alpha[i] = fadeIn * l01;
      p.size[i] = p.size0[i] * (1 + (1 - l01) * p.grow);
    }
    p.geo.attributes.position.needsUpdate = true;
    p.geo.attributes.aAlpha.needsUpdate = true;
    p.geo.attributes.aSize.needsUpdate = true;
    p.flush = p.alive > 0;
  }

  // ---- one-shot API ---------------------------------------------------

  dust(pos, n = 6) {
    this._emit(this._dust, pos.x, pos.y, pos.z, n, 0.22,
      0.4, 1.4, 0.5, 1.6, 0.35, 0.6, 0.35, 0.7, 0.80, 0.72, 0.58, 0.25);
  }

  sparkle(pos, color) {
    const c = this._setC(color, 1, 0.95, 0.6);
    this._emit(this._sparkle, pos.x, pos.y, pos.z, 10, 0.15,
      0.8, 2.6, 0.6, 3.0, 0.4, 0.7, 0.12, 0.28, c.r, c.g, c.b, 0.2);
  }

  burst(pos, color, n = 24) {
    const c = this._setC(color, 1, 0.85, 0.4);
    this._emit(this._sparkle, pos.x, pos.y, pos.z, n, 0.2,
      1.6, 5.5, 1.0, 5.0, 0.5, 0.9, 0.2, 0.5, c.r, c.g, c.b, 0.25);
  }

  debris(pos) {
    this._emit(this._debris, pos.x, pos.y, pos.z, 14, 0.3,
      1.5, 4.0, 2.0, 6.0, 0.6, 1.0, 0.08, 0.18, 0.54, 0.51, 0.46, 0.35);
  }

  splash(pos) {
    this._emit(this._splash, pos.x, pos.y, pos.z, 20, 0.35,
      0.8, 2.4, 2.5, 5.5, 0.5, 0.8, 0.10, 0.22, 0.75, 0.90, 0.95, 0.15);
  }

  _setC(color, dr, dg, db) {
    const c = this._c;
    if (typeof color === 'number') c.setHex(color);
    else if (color && color.isColor) c.copy(color);
    else c.setRGB(dr, dg, db);
    return c;
  }

  // Optional: main may report the world scroll velocity (+Z m/s) so loose
  // particles recede with the ground. Defaults to 0 and is safe to ignore.
  setWorldVel(v) {
    this._worldVel = v || 0;
  }

  // ---- ambient fields -------------------------------------------------

  // Point sizes are in device pixels; main syncs this to the real viewport.
  setPixelScale(px) {
    for (const pool of [this._dust, this._sparkle, this._debris, this._splash]) {
      pool.mat.uniforms.uPxScale.value = px;
    }
    if (this._snow) this._snow.mat.uniforms.uPxScale.value = px;
    if (this._embers) this._embers.mat.uniforms.uPxScale.value = px;
  }

  setSnow(on) { this._snowOn = !!on; }
  setMist(on) { this._mistOn = !!on; }
  setEmbers(on) { this._embersOn = !!on; }

  _buildSnow() {
    const cap = 600;
    const rnd = mulberry32(99);
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(cap * 3);
    const col = new Float32Array(cap * 3);
    const alpha = new Float32Array(cap);
    const size = new Float32Array(cap);
    const speed = new Float32Array(cap);
    const seed = new Float32Array(cap);
    for (let i = 0; i < cap; i++) {
      const i3 = i * 3;
      pos[i3] = (rnd() - 0.5) * 2 * SNOW_X;
      pos[i3 + 1] = rnd() * SNOW_TOP;
      pos[i3 + 2] = SNOW_ZMIN + rnd() * (SNOW_ZMAX - SNOW_ZMIN);
      const w = 0.85 + rnd() * 0.15;
      col[i3] = w; col[i3 + 1] = w; col[i3 + 2] = w + 0.02;
      alpha[i] = 0.45 + rnd() * 0.55;
      size[i] = 0.06 + rnd() * 0.1;
      speed[i] = 1.2 + rnd() * 1.4;
      seed[i] = rnd() * TAU;
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    const mat = this._makePointsMat(THREE.NormalBlending, 0);
    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    points.renderOrder = 8;
    points.visible = false;
    this._scene.add(points);
    this._snow = { points, geo, mat, cap, pos, speed, seed };
  }

  _updateSnow(dt, camera) {
    const s = this._snow;
    this._snowFade = damp(this._snowFade, this._snowOn ? 1 : 0, 2.5, dt);
    if (this._snowFade < 0.01 && !this._snowOn) {
      s.points.visible = false;
      return;
    }
    s.points.visible = true;
    s.mat.uniforms.uOpacity.value = this._snowFade * 0.85;
    s.points.position.set(camera.position.x, 0, camera.position.z);
    const t = this._time;
    const drift = (0.5 + this._worldVel * 0.8) * dt;
    const zw = SNOW_ZMAX - SNOW_ZMIN;
    for (let i = 0; i < s.cap; i++) {
      const i3 = i * 3;
      let x = s.pos[i3] + Math.sin(t * 0.8 + s.seed[i]) * 0.9 * dt;
      let y = s.pos[i3 + 1] - s.speed[i] * dt;
      let z = s.pos[i3 + 2] + drift;
      if (y < 0) y += SNOW_TOP;
      if (x > SNOW_X) x -= SNOW_X * 2;
      else if (x < -SNOW_X) x += SNOW_X * 2;
      if (z > SNOW_ZMAX) z -= zw;
      s.pos[i3] = x;
      s.pos[i3 + 1] = y;
      s.pos[i3 + 2] = z;
    }
    s.geo.attributes.position.needsUpdate = true;
  }

  _buildEmbers() {
    const cap = 80;
    const rnd = mulberry32(131);
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(cap * 3);
    const col = new Float32Array(cap * 3);
    const alpha = new Float32Array(cap);
    const size = new Float32Array(cap);
    const baseX = new Float32Array(cap);
    const baseZ = new Float32Array(cap);
    const phase = new Float32Array(cap);
    const rate = new Float32Array(cap);
    const seed = new Float32Array(cap);
    const alphaMax = new Float32Array(cap);
    const c = this._c.setHex(CONFIG.colors.flameOrange);
    for (let i = 0; i < cap; i++) {
      const i3 = i * 3;
      baseX[i] = (rnd() - 0.5) * 2 * EMB_X;
      baseZ[i] = EMB_ZMIN + rnd() * (EMB_ZMAX - EMB_ZMIN);
      phase[i] = rnd();
      rate[i] = 0.18 + rnd() * 0.22; // full rise in ~3-5.5 s
      seed[i] = rnd() * TAU;
      alphaMax[i] = 0.5 + rnd() * 0.5;
      const warm = 0.75 + rnd() * 0.45;
      col[i3] = c.r * warm;
      col[i3 + 1] = c.g * warm * (0.8 + rnd() * 0.35);
      col[i3 + 2] = c.b * warm * 0.7;
      size[i] = 0.05 + rnd() * 0.08;
      alpha[i] = 0;
      pos[i3] = baseX[i];
      pos[i3 + 1] = 0.3;
      pos[i3 + 2] = baseZ[i];
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    const mat = this._makePointsMat(THREE.AdditiveBlending, 0);
    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    points.renderOrder = 9;
    points.visible = false;
    this._scene.add(points);
    this._embers = { points, geo, mat, cap, pos, alpha, baseX, baseZ, phase, rate, seed, alphaMax };
  }

  _updateEmbers(dt, camera) {
    const e = this._embers;
    this._embersFade = damp(this._embersFade, this._embersOn ? 1 : 0, 2.5, dt);
    if (this._embersFade < 0.01 && !this._embersOn) {
      e.points.visible = false;
      return;
    }
    e.points.visible = true;
    e.mat.uniforms.uOpacity.value = this._embersFade;
    e.points.position.set(camera.position.x, 0, camera.position.z);
    const t = this._time;
    const wv = this._worldVel * dt;
    const zw = EMB_ZMAX - EMB_ZMIN;
    const aMax = e.alphaMax;
    for (let i = 0; i < e.cap; i++) {
      const i3 = i * 3;
      let p = e.phase[i] + e.rate[i] * dt;
      if (p > 1) {
        p -= 1;
        e.baseX[i] = (Math.random() - 0.5) * 2 * EMB_X;
        e.baseZ[i] = EMB_ZMIN + Math.random() * zw;
      }
      e.phase[i] = p;
      let z = e.baseZ[i] + wv;
      if (z > EMB_ZMAX) z -= zw;
      e.baseZ[i] = z;
      e.pos[i3] = e.baseX[i] + Math.sin(t * 1.3 + e.seed[i]) * 0.45;
      e.pos[i3 + 1] = 0.3 + p * 6.5;
      e.pos[i3 + 2] = z;
      e.alpha[i] = Math.sin(p * Math.PI) * aMax[i];
    }
    e.geo.attributes.position.needsUpdate = true;
    e.geo.attributes.aAlpha.needsUpdate = true;
  }

  _buildMist() {
    const rnd = mulberry32(163);
    const group = new THREE.Group();
    group.visible = false;
    this._scene.add(group);
    const tex = Tex.softCircle('#e6eef0');
    this._mist = [];
    for (let i = 0; i < 10; i++) {
      const m = new THREE.SpriteMaterial({
        map: tex,
        transparent: true,
        depthWrite: false,
        opacity: 0,
        rotation: rnd() * TAU,
      });
      const spr = new THREE.Sprite(m);
      spr.scale.set(18 + rnd() * 16, 6 + rnd() * 4, 1);
      spr.position.set(
        (rnd() - 0.5) * 2 * MIST_X,
        1.2 + rnd() * 2,
        MIST_ZMIN + rnd() * (MIST_ZMAX - MIST_ZMIN)
      );
      spr.renderOrder = 7;
      group.add(spr);
      this._mist.push({
        spr, m,
        baseOp: 0.05 + rnd() * 0.04,
        drift: (rnd() - 0.5) * 0.6,
      });
    }
    this._mistGroup = group;
  }

  _updateMist(dt, camera) {
    this._mistFade = damp(this._mistFade, this._mistOn ? 1 : 0, 1.8, dt);
    if (this._mistFade < 0.01 && !this._mistOn) {
      this._mistGroup.visible = false;
      return;
    }
    this._mistGroup.visible = true;
    this._mistGroup.position.set(camera.position.x, 0, camera.position.z);
    const wv = this._worldVel * 0.5 * dt;
    const zw = MIST_ZMAX - MIST_ZMIN;
    for (let i = 0; i < this._mist.length; i++) {
      const d = this._mist[i];
      d.m.opacity = d.baseOp * this._mistFade;
      const pp = d.spr.position;
      pp.x += d.drift * dt;
      pp.z += wv;
      if (pp.x > MIST_X) pp.x -= MIST_X * 2;
      else if (pp.x < -MIST_X) pp.x += MIST_X * 2;
      if (pp.z > MIST_ZMAX) pp.z -= zw;
    }
  }

  // ---- frame update ----------------------------------------------------

  update(dt, camera) {
    this._time += dt;
    this._updatePool(this._dust, dt);
    this._updatePool(this._sparkle, dt);
    this._updatePool(this._debris, dt);
    this._updatePool(this._splash, dt);
    this._updateSnow(dt, camera);
    this._updateEmbers(dt, camera);
    this._updateMist(dt, camera);
  }

  dispose() {
    const pools = [this._dust, this._sparkle, this._debris, this._splash];
    for (const p of pools) {
      this._scene.remove(p.points);
      p.geo.dispose();
      p.mat.dispose();
    }
    this._scene.remove(this._snow.points);
    this._snow.geo.dispose();
    this._snow.mat.dispose();
    this._scene.remove(this._embers.points);
    this._embers.geo.dispose();
    this._embers.mat.dispose();
    this._scene.remove(this._mistGroup);
    for (const d of this._mist) d.m.dispose();
    this._mist.length = 0;
  }
}
