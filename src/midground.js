// Midground depth layer: rolling foothills, tiny stone villages, cook-fire
// smoke and distant llama herds between the track scenery (0-50 m) and the
// far mountain rings (380+ m). Everything lives at radius 95..280 around the
// camera; a +-26 degree corridor around both +Z and -Z stays empty so the
// run lane reads clear to the horizon. Muted colors, fog does the blending,
// nothing casts shadows, all heights stay below y = 40.
// Worst-case main-pass draw calls: 2 hill strips + 1 house InstancedMesh
// + 1 llama InstancedMesh + 5 smoke sprites = 9 (hard cap 12).

import * as THREE from 'three';
import { CONFIG } from './config.js';
import { clamp, lerp, smoothstep, mulberry32, randRange, TAU } from './util.js';
import { makeMat, makeGroundMat, applyCurvatureSprite, Tex } from './materials.js';

const FOLLOW = 0.985;                 // camera-follow factor (parallax slip)
const EXCL = (26 * Math.PI) / 180;    // corridor half-angle around +Z / -Z
const ARC = Math.PI - 2 * EXCL;       // usable arc per side
const RADII = [95, 108, 136, 172, 216, 280];
const ASEG = 30;                      // angular segments per strip
const SMOKE_COUNT = 5;

// ---------------------------------------------------------------------------
// Analytic foothill height field, shared by the strips and every placement so
// houses and llamas always sit on the terrain they were scattered over.
// ---------------------------------------------------------------------------

function hillH(x, z) {
  const r = Math.hypot(x, z);
  const t = clamp((r - 80) / 200, 0, 1);
  let h = t * t * 24;
  h += Math.sin(x * 0.021 + 1.7) * Math.sin(z * 0.017 + 0.6) * (2.5 + 6 * t);
  h += Math.sin(x * 0.047 - 0.9) * Math.sin(z * 0.053 + 2.2) * 2.2;
  return h;
}

// Corridor taper: height fades to zero toward the +-26 degree exclusion
// edges so no ridge ever pokes into the sightline down the track.
function corridorTaper(x, z) {
  const r = Math.hypot(x, z);
  if (r < 1e-4) return 0;
  const th = Math.acos(clamp(z / r, -1, 1)); // angle from +Z, symmetric in x
  const u = (th - EXCL) / ARC;
  if (u <= 0 || u >= 1) return 0;
  return smoothstep(0, 0.14, u) * (1 - smoothstep(0.86, 1, u));
}

function groundY(x, z) {
  return hillH(x, z) * corridorTaper(x, z);
}

// u in [0,1] sweeps one side arc from the +Z exclusion edge to the -Z
// exclusion edge. side: +1 right (x > 0), -1 left (x < 0).
function arcPoint(side, u, r, out) {
  const th = EXCL + u * ARC;
  out.x = Math.sin(th) * side * r;
  out.z = Math.cos(th) * r;
  return out;
}

// ---------------------------------------------------------------------------
// Foothill strip: an indexed (ASEG+1) x RADII grid over one side arc, vertex
// colored dry-green to golden, with terraced patches painted as stepped
// brightness stripes straight into the colors (zero extra meshes).
// ---------------------------------------------------------------------------

function buildStripGeometry(side, seed, patches) {
  const rows = RADII.length;
  const vcount = (ASEG + 1) * rows;
  const pos = new Float32Array(vcount * 3);
  const col = new Float32Array(vcount * 3);
  const rnd = mulberry32(seed);
  const green = new THREE.Color(CONFIG.colors.grassGreen).lerp(new THREE.Color(0x8a8578), 0.38);
  const gold = new THREE.Color(CONFIG.colors.punaGold).lerp(new THREE.Color(0xa89f86), 0.32);
  const terrace = new THREE.Color(0x6d8a4a).lerp(new THREE.Color(0x8a8578), 0.3);
  const cc = new THREE.Color();

  let vi = 0;
  for (let a = 0; a <= ASEG; a++) {
    const u = a / ASEG;
    const th = EXCL + u * ARC;
    const sx = Math.sin(th) * side;
    const cz = Math.cos(th);
    for (let j = 0; j < rows; j++) {
      const r = RADII[j];
      const x = sx * r;
      const z = cz * r;
      // Innermost ring is a skirt sunk below the valley floor so no open
      // edge is visible under the hills from the track; the angular ends
      // also dip below the horizon so the strip never shows a flat cut.
      let y;
      if (j === 0) {
        y = -3;
      } else {
        const edge = 1 - smoothstep(0, 0.06, u) + smoothstep(0.94, 1, u);
        y = groundY(x, z) - 4 * edge;
      }
      pos[vi * 3] = x;
      pos[vi * 3 + 1] = y;
      pos[vi * 3 + 2] = z;

      // Dry-green lowlands blending to golden upper slopes.
      const k = smoothstep(-1, 22, y);
      cc.lerpColors(green, gold, k);
      let bright = 0.9 + rnd() * 0.16;

      // Terraced patches: stepped stripes as a function of height bands.
      for (let p = 0; p < patches.length; p++) {
        const pa = patches[p];
        const dist = Math.hypot(x - pa.x, z - pa.z);
        const infl = 1 - smoothstep(pa.rad * 0.5, pa.rad, dist);
        if (infl > 0.01) {
          const band = Math.floor(y / 1.35) % 2 === 0 ? 1.07 : 0.88;
          cc.lerp(terrace, infl * 0.55);
          bright *= lerp(1, band, infl);
        }
      }
      if (j === 0) bright *= 0.72; // skirt darkens into the haze

      col[vi * 3] = cc.r * bright;
      col[vi * 3 + 1] = cc.g * bright;
      col[vi * 3 + 2] = cc.b * bright;
      vi++;
    }
  }

  // Winding flips with the side mirror so normals always point up.
  const idx = [];
  for (let a = 0; a < ASEG; a++) {
    for (let j = 0; j < rows - 1; j++) {
      const i0 = a * rows + j;
      const i1 = i0 + rows;
      if (side > 0) idx.push(i0, i0 + 1, i1, i1, i0 + 1, i1 + 1);
      else idx.push(i0, i1, i0 + 1, i1, i1 + 1, i0 + 1);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

// ---------------------------------------------------------------------------
// House template: stone walls + gables + thatch roof baked into ONE geometry
// with vertex colors, instanced for every house in every village.
// ---------------------------------------------------------------------------

function buildHouseGeometry() {
  const pos = [];
  const col = [];
  const stone = new THREE.Color(0x9b917f);
  const thatch = new THREE.Color(0x8f7442);
  const cc = new THREE.Color();

  function tri(ax, ay, az, bx, by, bz, cx, cy, cz, base, shade) {
    pos.push(ax, ay, az, bx, by, bz, cx, cy, cz);
    cc.copy(base).multiplyScalar(shade);
    for (let i = 0; i < 3; i++) col.push(cc.r, cc.g, cc.b);
  }
  function quad(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz, base, shade) {
    tri(ax, ay, az, bx, by, bz, cx, cy, cz, base, shade);
    tri(ax, ay, az, cx, cy, cz, dx, dy, dz, base, shade);
  }

  const hx = 1.9, hz = 1.4, wh = 2.3, ry = 3.4, ov = 0.3, rb = wh - 0.12;

  // Walls, wound CCW seen from outside; per-face shade fakes sun sides.
  quad(-hx, 0, hz, hx, 0, hz, hx, wh, hz, -hx, wh, hz, stone, 1.0);       // +Z
  quad(hx, 0, -hz, -hx, 0, -hz, -hx, wh, -hz, hx, wh, -hz, stone, 0.8);   // -Z
  quad(hx, 0, hz, hx, 0, -hz, hx, wh, -hz, hx, wh, hz, stone, 0.9);       // +X
  quad(-hx, 0, -hz, -hx, 0, hz, -hx, wh, hz, -hx, wh, -hz, stone, 0.72);  // -X
  // Gable triangles (ridge runs along X).
  tri(hx, wh, hz, hx, wh, -hz, hx, ry, 0, stone, 0.86);
  tri(-hx, wh, -hz, -hx, wh, hz, -hx, ry, 0, stone, 0.78);
  // Thatch roof slopes with a slight overhang.
  quad(-hx - ov, rb, hz + ov, hx + ov, rb, hz + ov, hx + ov, ry, 0, -hx - ov, ry, 0, thatch, 1.0);
  quad(hx + ov, rb, -hz - ov, -hx - ov, rb, -hz - ov, -hx - ov, ry, 0, hx + ov, ry, 0, thatch, 0.82);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(col), 3));
  geo.computeVertexNormals();
  return geo;
}

// ---------------------------------------------------------------------------
// Flat camelid silhouette texture (128 px, alpha-tested quad).
// ---------------------------------------------------------------------------

function makeLlamaTexture() {
  const s = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, s, s);
  ctx.fillStyle = '#54422f';
  // Legs down to the quad base line.
  ctx.fillRect(38, 78, 7, 48);
  ctx.fillRect(52, 80, 7, 46);
  ctx.fillRect(76, 80, 7, 46);
  ctx.fillRect(90, 78, 7, 48);
  // Body.
  ctx.beginPath();
  ctx.ellipse(66, 72, 34, 17, 0, 0, TAU);
  ctx.fill();
  // Neck.
  ctx.beginPath();
  ctx.moveTo(88, 68);
  ctx.quadraticCurveTo(100, 46, 98, 26);
  ctx.lineTo(108, 28);
  ctx.quadraticCurveTo(108, 52, 100, 72);
  ctx.closePath();
  ctx.fill();
  // Head.
  ctx.beginPath();
  ctx.ellipse(104, 22, 9, 6.5, -0.25, 0, TAU);
  ctx.fill();
  // Banana ears.
  ctx.beginPath();
  ctx.moveTo(99, 18); ctx.lineTo(96, 8); ctx.lineTo(104, 14);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(107, 17); ctx.lineTo(109, 7); ctx.lineTo(113, 15);
  ctx.closePath();
  ctx.fill();
  // Tail puff.
  ctx.beginPath();
  ctx.ellipse(34, 64, 7, 6, 0, 0, TAU);
  ctx.fill();
  // Lighter wool tone across the back.
  ctx.fillStyle = 'rgba(122,100,72,0.5)';
  ctx.beginPath();
  ctx.ellipse(66, 64, 30, 10, 0, 0, TAU);
  ctx.fill();
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

// ---------------------------------------------------------------------------
// Midground
// ---------------------------------------------------------------------------

export class Midground {
  constructor(scene) {
    this._scene = scene;
    this._t = 0;
    this._group = new THREE.Group();
    this._group.name = 'midground';

    const rnd = mulberry32(9107);
    const v = new THREE.Vector3();

    // --- Foothill strips (one per side, one shared material) ---
    this._hillMat = makeGroundMat({ vertexColors: true, roughness: 1, metalness: 0 });
    const toWorld = (side, list) =>
      list.map((p) => {
        arcPoint(side, p.u, p.r, v);
        return { x: v.x, z: v.z, rad: p.rad };
      });
    const patchesR = toWorld(1, [{ u: 0.8, r: 150, rad: 34 }, { u: 0.9, r: 212, rad: 44 }]);
    const patchesL = toWorld(-1, [{ u: 0.76, r: 132, rad: 30 }, { u: 0.86, r: 178, rad: 40 }]);
    this._hillGeoR = buildStripGeometry(1, 101, patchesR);
    this._hillGeoL = buildStripGeometry(-1, 102, patchesL);
    this._hillR = new THREE.Mesh(this._hillGeoR, this._hillMat);
    this._hillL = new THREE.Mesh(this._hillGeoL, this._hillMat);
    for (const m of [this._hillR, this._hillL]) {
      m.frustumCulled = false;
      m.matrixAutoUpdate = false;
      m.updateMatrix();
      this._group.add(m);
    }

    // --- Stone villages: ONE InstancedMesh of the merged house template ---
    const villages = [
      { side: 1, u: 0.78, r: 138, n: 12 },
      { side: -1, u: 0.86, r: 182, n: 12 },
      { side: 1, u: 0.92, r: 232, n: 10 },
    ];
    let houseTotal = 0;
    for (const vg of villages) houseTotal += vg.n; // 34 <= 36
    this._houseGeo = buildHouseGeometry();
    this._houseMat = makeMat({ vertexColors: true, roughness: 0.95, metalness: 0 });
    this._houses = new THREE.InstancedMesh(this._houseGeo, this._houseMat, houseTotal);
    const dummy = new THREE.Object3D();
    const centers = [];
    let hi = 0;
    for (const vg of villages) {
      arcPoint(vg.side, vg.u, vg.r, v);
      centers.push({ x: v.x, z: v.z });
      for (let i = 0; i < vg.n; i++) {
        const a = rnd() * TAU;
        const rr = 3 + rnd() * 10;
        const x = v.x + Math.cos(a) * rr;
        const z = v.z + Math.sin(a) * rr;
        dummy.position.set(x, groundY(x, z) - 0.3, z);
        dummy.rotation.set(0, rnd() * TAU, 0);
        dummy.scale.setScalar(randRange(rnd, 0.85, 1.25));
        dummy.updateMatrix();
        this._houses.setMatrixAt(hi++, dummy.matrix);
      }
    }
    this._houses.instanceMatrix.needsUpdate = true;
    this._houses.frustumCulled = false;
    this._houses.matrixAutoUpdate = false;
    this._houses.updateMatrix();
    this._group.add(this._houses);

    // --- Llama herds: ONE InstancedMesh of a silhouette quad ---
    this._llamaTex = makeLlamaTexture();
    this._llamaGeo = new THREE.PlaneGeometry(2, 2);
    this._llamaGeo.translate(0, 1, 0);
    this._llamaMat = makeMat({
      map: this._llamaTex,
      alphaTest: 0.5,
      side: THREE.DoubleSide,
      roughness: 1,
      metalness: 0,
    });
    const herds = [
      { side: -1, u: 0.76, r: 120, n: 7 },
      { side: 1, u: 0.7, r: 262, n: 7 },
      { side: -1, u: 0.93, r: 158, n: 7 },
      { side: 1, u: 0.84, r: 205, n: 7 },
    ];
    let llamaTotal = 0;
    for (const hd of herds) llamaTotal += hd.n; // 28
    this._llamas = new THREE.InstancedMesh(this._llamaGeo, this._llamaMat, llamaTotal);
    let li = 0;
    for (const hd of herds) {
      arcPoint(hd.side, hd.u, hd.r, v);
      for (let i = 0; i < hd.n; i++) {
        const a = rnd() * TAU;
        const rr = 1.5 + rnd() * 7;
        const x = v.x + Math.cos(a) * rr;
        const z = v.z + Math.sin(a) * rr;
        dummy.position.set(x, groundY(x, z), z);
        // Roughly face the corridor so the flat quads keep silhouette area.
        dummy.rotation.set(0, Math.atan2(-x, -z) + randRange(rnd, -0.6, 0.6), 0);
        dummy.scale.setScalar(randRange(rnd, 0.8, 1.15));
        dummy.updateMatrix();
        this._llamas.setMatrixAt(li++, dummy.matrix);
      }
    }
    this._llamas.instanceMatrix.needsUpdate = true;
    this._llamas.frustumCulled = false;
    this._llamas.matrixAutoUpdate = false;
    this._llamas.updateMatrix();
    this._group.add(this._llamas);

    // --- Cook-fire smoke: pooled sprites, loop-faded in update ---
    this._smoke = [];
    const smokeTex = Tex.softCircle('#b7b2aa');
    for (let i = 0; i < SMOKE_COUNT; i++) {
      const c = centers[i % centers.length];
      const m = new THREE.SpriteMaterial({
        map: smokeTex,
        transparent: true,
        depthWrite: false,
        opacity: 0,
        rotation: rnd() * TAU,
      });
      applyCurvatureSprite(m);
      const spr = new THREE.Sprite(m);
      spr.frustumCulled = false;
      const bx = c.x + randRange(rnd, -6, 6);
      const bz = c.z + randRange(rnd, -6, 6);
      const by = groundY(bx, bz) + 2.8;
      spr.position.set(bx, by, bz);
      this._group.add(spr);
      this._smoke.push({
        spr, m, bx, by, bz,
        dur: randRange(rnd, 7, 11),
        ph: rnd() * 20,
        s0: randRange(rnd, 2.2, 3.2),
        o0: randRange(rnd, 0.16, 0.24),
        drift: randRange(rnd, -2.5, 2.5),
      });
    }

    scene.add(this._group);
  }

  // Group follows the camera at FOLLOW so the layer parallaxes gently
  // between the streaming track world and the locked mountain rings.
  update(dt, camera) {
    this._t += dt;
    const cp = camera.position;
    this._group.position.set(cp.x * FOLLOW, 0, cp.z * FOLLOW);

    for (let i = 0; i < this._smoke.length; i++) {
      const s = this._smoke[i];
      const u = ((this._t + s.ph) / s.dur) % 1;
      s.spr.position.set(s.bx + u * s.drift, s.by + u * 7, s.bz);
      const sc = s.s0 * (0.7 + u * 1.6);
      s.spr.scale.set(sc, sc, 1);
      s.m.opacity = s.o0 * smoothstep(0, 0.18, u) * (1 - smoothstep(0.45, 1, u));
    }
  }

  // Optional hook the sky can drive to keep the layer in palette. The
  // materials start white, so never calling this changes nothing.
  setTint(color) {
    if (!color) return;
    this._hillMat.color.set(color);
    this._houseMat.color.set(color);
    this._llamaMat.color.set(color);
  }

  dispose() {
    this._scene.remove(this._group);
    this._hillGeoR.dispose();
    this._hillGeoL.dispose();
    this._houseGeo.dispose();
    this._llamaGeo.dispose();
    this._hillMat.dispose();
    this._houseMat.dispose();
    this._llamaMat.dispose();
    this._llamaTex.dispose();
    for (let i = 0; i < this._smoke.length; i++) this._smoke[i].m.dispose();
    this._smoke.length = 0;
  }
}
