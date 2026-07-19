// Endless track: pooled biome chunks, obstacle/coin spawning, collision data.
//
// Coordinates: worldGroup moves toward +Z while the player stays near z = 0.
// Chunk k sits at worldGroup-local z = -k * chunkLen, geometry built in
// local range [-chunkLen, 0]. The player plays chunk k while
// worldGroup.position.z is in [k * chunkLen, (k+1) * chunkLen).

import * as THREE from 'three';
import { CONFIG } from './config.js';
import { mulberry32, randRange, pick, smoothstep } from './util.js';
import { Mats, applyGroundExtras, applyCurvature } from './materials.js';
import { createObstacle, KIND_INFO } from './obstacles.js';
import {
  buildTerraces, buildGateway, buildRuin, buildWatchtower, buildFarmer,
  buildRopeBridgeSides, buildIchuPatch, buildFlowers,
  buildBoulder, buildReeds, buildMaizePatch,
  buildGrassFringe, buildQueunaPatch, buildMollePatch, buildTambo,
  buildWaterfall, buildMegalithWall,
  buildTunnel, buildVillageSet, buildGapVoid,
} from './scenery.js';
import { buildLlama, buildAlpaca } from './animals.js';
import { SimplexNoise } from 'three/addons/math/SimplexNoise.js';
import { CoinField, Specials } from './collectibles.js';
import { makeSplatMaterial, makeTerrainGeometry } from './terrain.js';

const L = CONFIG.chunkLen;
const AHEAD_CHUNKS = 11;

// A sitting llama in your lane is the signature Andean obstacle, so it carries
// real weight in the two biomes camelids actually live in (about 2 draws in 7
// for the valley, 1 in 3 on the puna). It is a 'jump' obstacle, so a full row
// of three is legal and clearable.
const BIOME_OBSTACLES = {
  VALLEY: ['lowWall', 'boulder', 'llama', 'lintel', 'lowWall', 'boulder', 'lintel'],
  CLIFF: ['boulder', 'boulder', 'lowWall', 'lintel', 'highWall', 'boulder'],
  PUNA: ['boulder', 'llama', 'lowWall', 'boulder', 'lowWall', 'boulder'],
  BRIDGE: ['lintelWood', 'lowWallWood', 'lowWallWood', 'lintelWood'],
};

// Llamas are back in the tables and can fill a whole row, so the pool is sized
// for that up front: _getObstacle grows on demand, but building a rigged
// camelid mid-run is exactly the kind of hitch a runner cannot afford.
const OBSTACLE_POOL_SIZES = {
  lowWall: 20, lowWallWood: 12, highWall: 10, lintel: 12, lintelWood: 12,
  boulder: 24, llama: 22, roller: 10,
};

// variant 2 is the "gap" variant for VALLEY / PUNA / BRIDGE.
const VARIANT_COUNTS = { VALLEY: [5, 3, 3], CLIFF: [3, 3, 3], PUNA: [4, 2, 3], BRIDGE: [3, 2, 2] };

const SLOTS = [-6, -18, -30];

// ---------------------------------------------------------------------------
// Qhapaq Nan road surface.
//
// The old road was one flat box wearing a gravel photo: a uniform ribbon with
// no edges and no structure, which is not what the Inca highway through the
// sierra looks like. The real thing is engineered. Large fitted flagstones
// laid without mortar over a rounded-stone bedding layer, kerb lines retaining
// both shoulders, stone drainage channels crossing it and running alongside,
// and stretches where the paving gives way to compacted earth.
//
// Everything below is baked into TWO merged meshes per chunk, so the whole
// road costs one extra draw call over the single box it replaces:
//   bedding  Mats.path()      substrate under the joints, plus a slab under
//                             every compacted-earth stretch
//   stone    stoneDark + VC   paving tops, kerbs, channels, loose stones
//
// TILING. Chunk geometry is baked once and reused at many world z, so the
// layout may be randomised per CHUNK OBJECT (there are several per biome, so
// the pattern does not repeat every 36 m) but it must end flush at both chunk
// boundaries. Row boundary lines wobble in z so no joint is ruled straight,
// EXCEPT lines 0 and n, which are pinned dead flat at z = 0 and z = -L. Chunk
// N's last row then meets chunk N+1's first row across exactly one joint
// width, in whatever order the pool recycles them.
//
// NOTHING here changes gameplay: the corridor is the same 7.8 m, the walkable
// surface is still y ~ 0.01, and no collider or isGroundSolid path is touched.
// ---------------------------------------------------------------------------

const ROAD_HALF = 3.9;      // road half width, unchanged
const PAVE_HALF = 3.42;     // paving stops here; kerb and gutter run outside
const KERB_IN = 3.44, KERB_OUT = 3.72;
// The bedding course stops at BED_HALF so the gutter outside it is not simply
// filled in; a deeper sub-base spans the full width underneath so there is
// still no angle that sees through the road.
const BED_HALF = 3.74;
const GUTTER_IN = 3.66, GUTTER_OUT = 3.90;
const ROAD_TOP = 0.01;      // walkable surface height, unchanged
const BED_TOP = -0.055;     // bedding course, shows dark in every joint
const EARTH_TOP = -0.012;   // compacted-earth stretches sit just under the slabs
const GUTTER_FLOOR = -0.115;
const SUB_TOP = -0.127;     // sub-base, just under the gutter lining
const JOINT = 0.075;        // mortarless joint width
const ROAD_UVK = 6.24;      // world meters per uv unit (rock map repeat is 2.6)
const ROAD_BOTTOM = -0.34;

function rbNew() {
  return { pos: [], nor: [], uv: [], col: [], idx: [], n: 0 };
}

function rbVert(B, x, y, z, nx, ny, nz, r, g, b) {
  B.pos.push(x, y, z);
  B.nor.push(nx, ny, nz);
  B.uv.push(x / ROAD_UVK, z / ROAD_UVK); // world-space uv: stone grain runs
  B.col.push(r, g, b);                   // across joints instead of per slab
  B.n++;
}

// Quad given in counter-clockwise order seen from outside; normal is derived.
function rbQuad(B, ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz, r, g, b) {
  const ux = bx - ax, uy = by - ay, uz = bz - az;
  const wx = cx - ax, wy = cy - ay, wz = cz - az;
  let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
  const len = Math.hypot(nx, ny, nz) || 1;
  nx /= len; ny /= len; nz /= len;
  const i0 = B.n;
  rbVert(B, ax, ay, az, nx, ny, nz, r, g, b);
  rbVert(B, bx, by, bz, nx, ny, nz, r, g, b);
  rbVert(B, cx, cy, cz, nx, ny, nz, r, g, b);
  rbVert(B, dx, dy, dz, nx, ny, nz, r, g, b);
  B.idx.push(i0, i0 + 1, i0 + 2, i0, i0 + 2, i0 + 3);
}

// Axis-aligned box. zN is the near edge (larger z), zF the far one. The bottom
// face is omitted: every box here is sunk into the bedding or the ground.
function rbBox(B, x0, x1, y0, y1, zN, zF, r, g, b) {
  rbQuad(B, x0, y1, zN, x1, y1, zN, x1, y1, zF, x0, y1, zF, r, g, b);
  rbQuad(B, x0, y0, zN, x1, y0, zN, x1, y1, zN, x0, y1, zN, r, g, b);
  rbQuad(B, x1, y0, zF, x0, y0, zF, x0, y1, zF, x1, y1, zF, r, g, b);
  rbQuad(B, x1, y0, zN, x1, y0, zF, x1, y1, zF, x1, y1, zN, r, g, b);
  rbQuad(B, x0, y0, zF, x0, y0, zN, x0, y1, zN, x0, y1, zF, r, g, b);
}

function rbGeo(B) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(B.pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(B.nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(B.uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(B.col, 3));
  g.setIndex(B.idx);
  g.computeBoundingSphere();
  return g;
}

// A row boundary line, wobbling in z across the road width.
function lineZ(ln, x) {
  return ln.z + ln.amp * Math.sin(x * ln.f + ln.p);
}

// ---------------------------------------------------------------------------
// Terrain heightfield.
//
// The old field was a product of sines seeded per chunk. Sine products have a
// signature wavy uniformity that never reads as land, and the per-chunk seed
// meant adjacent chunks did not agree at the seam, so the shoulders creased
// every 36 m.
//
// This is fractal Brownian motion over three.js's own SimplexNoise addon,
// which gives real terrain statistics instead. The trick that makes it work in
// a POOLED chunk system: chunk geometry is baked once and reused at many
// different world z, so the field cannot simply be world-space continuous.
// Instead z is sampled around a circle of circumference L, which makes the
// field exactly periodic in z. Every chunk edge then matches every other chunk
// edge, whatever order they are recycled in, with no bookkeeping at all.
// ---------------------------------------------------------------------------
const _simplex = new SimplexNoise();
const TWO_PI = Math.PI * 2;

function fbmHeight(wx, lz, len, amp) {
  const R = len / TWO_PI;          // arc length along the circle == distance in z
  const a = (lz / len) * TWO_PI;
  const cz = Math.cos(a) * R;
  const sz = Math.sin(a) * R;
  let h = 0, w = 1, f = 0.038, norm = 0;
  for (let o = 0; o < 4; o++) {
    h += w * _simplex.noise3d(wx * f, cz * f, sz * f);
    norm += w;
    w *= 0.5;
    f *= 2.07;                     // non-integer lacunarity, avoids octave alignment
  }
  h /= norm;
  // Bias toward valley floors with occasional rises, which reads more like a
  // river plain than symmetric dunes do.
  h = h * 0.72 + h * h * h * 0.28;
  return h * amp;
}

export class Track {
  constructor(scene, waterSystem) {
    this.scene = scene;
    this.water = waterSystem;
    this.worldGroup = new THREE.Group();
    scene.add(this.worldGroup);

    this.coins = new CoinField(this.worldGroup);
    this.specials = new Specials(this.worldGroup);

    this.rnd = mulberry32(20260718);
    this.onBiomeChange = null;

    // Procedural biome sequencing: variable order and lengths, reseeded per
    // run, so the geography never loops. Pool safety: max run length per
    // biome stays at or below its chunk pool size.
    this._seqCounter = 0;
    this._resetSequence();

    this._chunkPools = { VALLEY: [], CLIFF: [], PUNA: [], BRIDGE: [] };
    this._obstaclePools = {};
    this._active = new Map(); // chunkIndex -> chunk
    this._nextIndex = 0;
    this._playerBiome = null;

    this._cols = [];
    this._colPool = [];
    for (let i = 0; i < 96; i++) {
      this._colPool.push({ minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0, ob: null });
    }

    this._nextPowerupAt = randRange(this.rnd, ...CONFIG.powerupEveryMeters);
    this._nextChakanaAt = randRange(this.rnd, ...CONFIG.chakanaEveryMeters);
    this._powerCycle = 0;

    this._built = false;
  }

  get distance() { return this.worldGroup.position.z; }

  _resetSequence() {
    this._seqCounter++;
    this._seqRnd = mulberry32(0x9e3d + this._seqCounter * 7919);
    // Always open with a valley runway.
    const len0 = 6 + ((this._seqRnd() * 4) | 0);
    this._runs = [{ biome: 'VALLEY', start: 0, len: len0 }];
    // Same-biome runs must sit >= 6 chunks apart or the 13-chunk active
    // window could hold more chunks of one biome than its pool provides.
    this._lastEnd = { VALLEY: len0, CLIFF: -99, PUNA: -99, BRIDGE: -99 };
  }

  biomeOf(index) {
    if (index < 0) index = 0;
    const RUN_LEN = { VALLEY: [4, 10], CLIFF: [4, 8], PUNA: [4, 8], BRIDGE: [3, 5] };
    let last = this._runs[this._runs.length - 1];
    while (index >= last.start + last.len) {
      const start = last.start + last.len;
      const cands = ['VALLEY', 'CLIFF', 'PUNA', 'BRIDGE'].filter((b) => b !== last.biome);
      let eligible = cands.filter((b) => start - this._lastEnd[b] >= 6);
      if (!eligible.length) {
        eligible = [cands.reduce((best, b) => (this._lastEnd[b] < this._lastEnd[best] ? b : best))];
      }
      // Bridges stay rare: everything else gets double weight.
      const weighted = [];
      for (const b of eligible) { weighted.push(b); if (b !== 'BRIDGE') weighted.push(b); }
      const biome = weighted[(this._seqRnd() * weighted.length) | 0];
      const [lo, hi] = RUN_LEN[biome];
      last = { biome, start, len: lo + ((this._seqRnd() * (hi - lo + 1)) | 0) };
      this._lastEnd[biome] = last.start + last.len;
      this._runs.push(last);
    }
    for (let i = this._runs.length - 1; i >= 0; i--) {
      const r = this._runs[i];
      if (index >= r.start && index < r.start + r.len) {
        return { biome: r.biome, runIdx: index - r.start };
      }
    }
    return { biome: 'VALLEY', runIdx: 1 };
  }

  // ------------------------------------------------------------------
  // Build-time: pools (call once, may take a moment; yield between biomes)
  // ------------------------------------------------------------------

  async build(onProgress) {
    for (const kind of Object.keys(OBSTACLE_POOL_SIZES)) {
      const arr = [];
      for (let i = 0; i < OBSTACLE_POOL_SIZES[kind]; i++) {
        const ob = createObstacle(kind);
        arr.push(ob);
      }
      this._obstaclePools[kind] = arr;
    }
    let done = 0;
    const biomes = Object.keys(this._chunkPools);
    for (const biome of biomes) {
      const counts = VARIANT_COUNTS[biome];
      for (let v = 0; v < counts.length; v++) {
        for (let i = 0; i < counts[v]; i++) {
          this._chunkPools[biome].push(this._buildChunk(biome, v));
        }
      }
      done++;
      if (onProgress) onProgress(done / biomes.length);
      await new Promise((r) => setTimeout(r, 0));
    }
    this._built = true;
  }

  // Scale a BoxGeometry's UVs so a texture tiles every ~`tile` meters.
  _tileUV(geo, w, h, tile = 4) {
    const uv = geo.attributes.uv;
    for (let i = 0; i < uv.count; i++) {
      uv.setXY(i, uv.getX(i) * (w / tile), uv.getY(i) * (h / tile));
    }
    return geo;
  }

  // Shared clone of a base material with vertex colors, for terrain shading.
  _terrainMat(base) {
    if (!this._terrainMats) this._terrainMats = new Map();
    if (!this._terrainMats.has(base.uuid)) {
      const m = base.clone();
      m.vertexColors = true;
      applyGroundExtras(m); // clone() drops onBeforeCompile; restore the full ground patch
      this._terrainMats.set(base.uuid, m);
    }
    return this._terrainMats.get(base.uuid);
  }

  // Organic ground: noise-displaced plane, flat near the run corridor.
  // opts.shape(worldX, chunkLocalZ) may add extra height (banks, lake beds).

  // Wide flat backstop under an open-landscape chunk. Sits below the sculpted
  // strips and simply guarantees that no camera angle can ever see sky through
  // the ground. Cheap: two triangles, no splat, never animated.
  _groundBackstop(mat, y = -0.5, width = 240) {
    const geo = new THREE.PlaneGeometry(width, L + 4, 1, 1);
    geo.rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(geo, mat);
    m.position.set(0, y, -L / 2);
    m.receiveShadow = true;
    m.matrixAutoUpdate = false;
    m.updateMatrix();
    return m;
  }

  _terrain(w, d, baseMat, x, z = -L / 2, opts = {}) {
    const amp = opts.amp === undefined ? 0.55 : opts.amp;
    if (opts.splat) {
      // Splat-mapped terrain: photo layers blended by slope + noise in the
      // shader; same displacement field as the classic path below.
      const geo = makeTerrainGeometry({
        width: w, depth: d,
        // Denser across the strip: fBm has real detail to resolve, and the
        // old 1.6 m spacing smeared it into mush.
        segsW: Math.max(6, Math.round(w / 1.1)),
        segsD: Math.max(10, Math.round(d / 1.5)),
        height: (lx, lz) => {
          const wx = lx + x;
          const flat = smoothstep(4.1, 7.5, Math.abs(wx));
          let h = fbmHeight(wx, lz, d, amp) * flat;
          if (opts.shape) h += opts.shape(wx, lz + z);
          return h;
        },
        dirtMask: () => 0,
      });
      const m = new THREE.Mesh(geo, makeSplatMaterial());
      m.position.set(x, opts.y === undefined ? -0.02 : opts.y, z);
      m.matrixAutoUpdate = false;
      m.updateMatrix();
      return m;
    }
    const geo = new THREE.PlaneGeometry(w, d, Math.max(4, Math.round(w / 1.6)), Math.max(8, Math.round(d / 1.8)));
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const s1 = this.rnd() * 10, s2 = this.rnd() * 10, s3 = this.rnd() * 10;
    for (let i = 0; i < pos.count; i++) {
      const vx = pos.getX(i), vz = pos.getZ(i);
      const wx = vx + x;
      const flat = smoothstep(4.1, 7.5, Math.abs(wx)); // corridor stays level
      let h =
        (Math.sin(wx * 0.16 + s1) * Math.sin(vz * 0.13 + s2) * 0.6 +
          Math.sin(wx * 0.43 + s3) * Math.sin(vz * 0.37 + s1) * 0.28 +
          Math.sin(wx * 1.05 + s2) * Math.sin(vz * 0.92 + s3) * 0.12) * amp * flat;
      if (opts.shape) h += opts.shape(wx, vz + z);
      pos.setY(i, h);
      const c = 0.93 + 0.11 * (0.5 + 0.5 * Math.sin(wx * 0.7 + s3 + Math.sin(vz * 0.5 + s1) * 1.7));
      colors[i * 3] = colors[i * 3 + 1] = colors[i * 3 + 2] = c;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, this._terrainMat(baseMat));
    m.position.set(x, opts.y === undefined ? -0.02 : opts.y, z);
    m.receiveShadow = true;
    m.matrixAutoUpdate = false;
    m.updateMatrix();
    return m;
  }

  // The inside of a lethal drop. Flat, unmapped and almost black, so nothing
  // in the shaft ever reads as a surface you could land on.
  _voidMat() {
    if (!this._void) {
      this._void = applyCurvature(new THREE.MeshStandardMaterial({
        // DoubleSide because the player FALLS INTO this box. A BoxGeometry only
        // faces outward, so from inside the shaft every wall was back-facing
        // and culled, and the fall showed sky through the sides.
        color: 0x0a0b0d, roughness: 1, metalness: 0, side: THREE.DoubleSide,
      }));
    }
    return this._void;
  }

  // Road paving stone. The shared rock photo is a warm red-brown, which is
  // wrong for a sierra highway, so this clone cools it toward Andean granite
  // and turns on vertex colors for the per-slab tone variation.
  _roadStoneMat() {
    if (!this._roadStone) {
      const m = Mats.stoneDark().clone();
      m.color.set(0xb9bec0);
      m.vertexColors = true;
      applyGroundExtras(m); // clone() drops onBeforeCompile; restore it
      this._roadStone = m;
    }
    return this._roadStone;
  }

  // One paved row: irregular stone widths, per-stone tone and corner heights.
  _paveRow(rnd) {
    // Walk the width laying stones of genuinely varied size, rather than
    // jittering a regular grid: an even split reads as tiling, and tiling is
    // the one thing mortarless Inca paving never looks like.
    const nominal = 0.95 + rnd() * 0.8;
    const bx = [-PAVE_HALF];
    let x = -PAVE_HALF;
    while (PAVE_HALF - x > nominal * 1.55) {
      x += nominal * (0.62 + rnd() * 0.78);
      bx.push(x);
    }
    bx.push(PAVE_HALF);
    const st = [];
    for (let s = 0; s < bx.length - 1; s++) {
      const cx = (bx[s] + bx[s + 1]) / 2;
      // Centuries of feet polish the middle of the road; moss creeps into the
      // joints out at the kerbs, where nobody walks.
      const worn = Math.abs(cx) < 2.7 ? -0.07 : 0.03;
      const tone = 0.72 + rnd() * 0.56 + worn;
      const moss = Math.abs(cx) > 2.5 ? 0.03 + rnd() * 0.07 : 0;
      const warm = (rnd() - 0.5) * 0.07;
      st.push({
        y: ROAD_TOP + (rnd() - 0.5) * 0.03,
        cr: tone * (0.98 + warm),
        cg: tone + moss * 0.8,
        cb: tone * (1.06 - warm) - moss * 0.5,
        j0: (rnd() - 0.5) * 0.02, j1: (rnd() - 0.5) * 0.02,
        j2: (rnd() - 0.5) * 0.02, j3: (rnd() - 0.5) * 0.02,
      });
    }
    return { kind: 'pave', bx, st };
  }

  // Full road layout for ONE pooled chunk. See the header block above for the
  // tiling contract; the only hard rule is that lines 0 and n stay flat.
  _roadLayout(rnd) {
    const depths = [];
    let total = 0;
    while (total < L - 1.0) {
      const d = 0.85 + rnd() * 0.8;
      depths.push(d);
      total += d;
    }
    // One narrow row becomes the drainage channel crossing the road. Kept
    // well inside the chunk so it never lands on a seam.
    const ci = 2 + ((rnd() * Math.max(1, depths.length - 4)) | 0);
    total += 0.6 - depths[ci];
    depths[ci] = 0.6;
    const k = L / total;
    for (let i = 0; i < depths.length; i++) depths[i] *= k;

    const lines = [];
    let z = 0;
    for (let i = 0; i <= depths.length; i++) {
      const pinned = i === 0 || i === depths.length;
      lines.push({
        z: i === depths.length ? -L : z,
        amp: pinned ? 0 : 0.08 + rnd() * 0.15,
        f: 0.35 + rnd() * 0.9,
        p: rnd() * TWO_PI,
      });
      if (i < depths.length) z -= depths[i];
    }

    // Paved and compacted-earth stretches alternate in runs, so the road has
    // rhythm instead of being one infinite ribbon of the same treatment.
    const rows = [];
    let paved = rnd() < 0.82;
    let run = paved ? 6 + ((rnd() * 9) | 0) : 2 + ((rnd() * 3) | 0);
    for (let i = 0; i < depths.length; i++) {
      if (i === ci) { rows.push({ kind: 'channel' }); continue; }
      if (run <= 0) {
        paved = !paved;
        run = paved ? 6 + ((rnd() * 9) | 0) : 2 + ((rnd() * 3) | 0);
      }
      run--;
      // The channel is always framed by paving: its lips are the road edging.
      const force = i === ci - 1 || i === ci + 1;
      if (paved || force) { rows.push(this._paveRow(rnd)); continue; }
      // The unpaved base course is soil mixed with small stones, so an earth
      // stretch is never a blank slab: a scatter of half-buried stones sits
      // in it, which is also what stops it reading as the old flat ribbon.
      const grit = [];
      const n = 5 + ((rnd() * 5) | 0);
      for (let s = 0; s < n; s++) {
        grit.push({
          x: (rnd() * 2 - 1) * (PAVE_HALF - 0.2),
          t: 0.12 + rnd() * 0.76,          // fraction across the row depth
          rx: 0.07 + rnd() * 0.16,
          rz: 0.06 + rnd() * 0.13,
          h: 0.014 + rnd() * 0.026,
          c: 0.72 + rnd() * 0.42,
        });
      }
      rows.push({ kind: 'earth', grit });
    }

    // Kerb stones, walked from z = 0 and closed exactly on z = -L.
    const kerb = [];
    let kz = 0;
    while (kz > -L + 0.1) {
      let d = 1.2 + rnd() * 0.9;
      if (kz - d < -L + 0.8) d = kz + L;
      kerb.push({ zN: kz, zF: kz - d, h: 0.10 + rnd() * 0.03, t: 0.88 + rnd() * 0.2 });
      kz -= d;
    }

    // Loose stones shed off the paving.
    const peb = [];
    for (let i = 0; i < 14; i++) {
      peb.push({
        x: (rnd() * 2 - 1) * (PAVE_HALF - 0.25),
        z: -0.5 - rnd() * (L - 1),
        r: 0.06 + rnd() * 0.09,
        c: 0.8 + rnd() * 0.35,
      });
    }
    return { lines, rows, kerb, peb };
  }

  _roadBuild(group, layout, gap) {
    const gs = gap ? gap[0] : 1;  // near rim (larger z)
    const ge = gap ? gap[1] : 1;  // far rim
    const mid = (gs + ge) / 2;
    // Snap anything inside the collapsed section back to the nearer rim, so
    // stones straddling the edge are squared off instead of hanging in air.
    const clip = (z) => (gap && z < gs && z > ge ? (z > mid ? gs : ge) : z);
    const segs = [];
    if (!gap) segs.push([0, -L]);
    else {
      if (-gs > 0.3) segs.push([0, gs]);
      if (L + ge > 0.3) segs.push([ge, -L]);
    }

    const S = rbNew();   // paving tops, kerbs, channels, loose stones
    const Bd = rbNew();  // bedding course and compacted-earth stretches

    // Sub-base first, full width: this is the guarantee that no camera angle
    // can ever see through the road, whatever the paving does above it. Then
    // the bedding course on top of it, stopping short of the gutters.
    for (const [zN, zF] of segs) {
      rbBox(Bd, -ROAD_HALF, ROAD_HALF, ROAD_BOTTOM, SUB_TOP, zN, zF, 0.44, 0.42, 0.39);
      // Deliberately dark: this is what shows at the bottom of every joint,
      // and a joint that is not darker than the slab reads as a painted line.
      rbBox(Bd, -BED_HALF, BED_HALF, ROAD_BOTTOM, BED_TOP, zN, zF, 0.52, 0.49, 0.45);
    }

    const lines = layout.lines;
    for (let r = 0; r < layout.rows.length; r++) {
      const row = layout.rows[r];
      const LN = lines[r], LF = lines[r + 1];
      if (gap && LN.z <= gs && LF.z >= ge) continue; // wholly inside the gap

      if (row.kind === 'earth') {
        // Overlap the neighbouring rows a little so the wobbling joint line
        // never opens a strip of bare bedding between earth and paving.
        const zN = clip(Math.min(0, LN.z + 0.16));
        const zF = clip(Math.max(-L, LF.z - 0.16));
        if (zN - zF < 0.14) continue;
        // Five bands across: the two walking lines are worn darker and sit a
        // few millimetres lower than the untrodden crown and shoulders.
        // Outer edges run to 3.50, INSIDE the kerb (3.44 to 3.72), so the slab
        // edge is buried rather than coplanar with the kerb face.
        const cuts = [-3.5, -2.9, -1.1, 1.1, 2.9, 3.5];
        const band = [0.99, 0.83, 0.94, 0.83, 0.99];
        const drop = [0, 0.008, 0.002, 0.008, 0];
        for (let c = 0; c < 5; c++) {
          const t = band[c];
          rbBox(Bd, cuts[c], cuts[c + 1], ROAD_BOTTOM, EARTH_TOP - drop[c], zN, zF,
            t * 1.03, t, t * 0.9);
        }
        for (const gr of row.grit) {
          const gz = zN - (zN - zF) * gr.t;
          rbBox(S, gr.x - gr.rx, gr.x + gr.rx, -0.1, EARTH_TOP + gr.h,
            gz + gr.rz, gz - gr.rz, gr.c * 1.03, gr.c, gr.c * 0.96);
        }
      } else if (row.kind === 'channel') {
        const zN = clip(Math.min(0, LN.z));
        const zF = clip(Math.max(-L, LF.z));
        if (zN - zF < 0.2) continue;
        // Stone-lined drainage slot: dark bed between two raised lips, which
        // double as the edging course for the paving on either side.
        rbBox(S, -PAVE_HALF, PAVE_HALF, ROAD_BOTTOM, BED_TOP + 0.004,
          zN - 0.02, zF + 0.02, 0.68, 0.7, 0.72);
        rbBox(S, -PAVE_HALF, PAVE_HALF, ROAD_BOTTOM, ROAD_TOP + 0.03,
          clip(Math.min(0, zN + 0.11)), zN - 0.02, 0.93, 0.92, 0.88);
        rbBox(S, -PAVE_HALF, PAVE_HALF, ROAD_BOTTOM, ROAD_TOP + 0.03,
          zF + 0.02, clip(Math.max(-L, zF - 0.11)), 0.93, 0.92, 0.88);
      } else {
        const bx = row.bx;
        for (let s = 0; s < bx.length - 1; s++) {
          const st = row.st[s];
          const x0 = bx[s] + JOINT / 2, x1 = bx[s + 1] - JOINT / 2;
          if (x1 - x0 < 0.12) continue;
          const zn0 = clip(Math.min(0, lineZ(LN, x0) - JOINT / 2));
          const zn1 = clip(Math.min(0, lineZ(LN, x1) - JOINT / 2));
          const zf0 = clip(Math.max(-L, lineZ(LF, x0) + JOINT / 2));
          const zf1 = clip(Math.max(-L, lineZ(LF, x1) + JOINT / 2));
          if (Math.min(zn0, zn1) - Math.max(zf0, zf1) < 0.14) continue;
          // Approach telegraph: the road SUBSIDES and darkens as it nears a
          // rim, so the player is warned a good 3 m before the lip itself
          // rather than at the edge, where there is no time left to react.
          let sag = 0;
          if (gap) {
            const zc = (zn0 + zf0) / 2;
            const d = Math.min(Math.abs(zc - gs), Math.abs(zc - ge));
            if (d < 3.0) sag = 1 - d / 3.0;
          }
          const dy = st.y - 0.075 * sag * sag;
          const dim = 1 - 0.42 * sag;
          rbQuad(S,
            x0, dy + st.j0, zn0,
            x1, dy + st.j1, zn1,
            x1, dy + st.j2, zf1,
            x0, dy + st.j3, zf0,
            st.cr * dim, st.cg * dim, st.cb * dim);
        }
      }
    }

    for (let side = -1; side <= 1; side += 2) {
      const kIn = side > 0 ? KERB_IN : -KERB_OUT;
      const kOut = side > 0 ? KERB_OUT : -KERB_IN;
      for (const k of layout.kerb) {
        const zN = clip(k.zN - JOINT / 2);
        const zF = clip(k.zF + JOINT / 2);
        if (zN - zF < 0.18) continue;
        rbBox(S, kIn, kOut, ROAD_BOTTOM, k.h, zN, zF, k.t * 1.03, k.t, k.t * 0.94);
      }
      // Stone-lined drainage channel running the length of the road outside
      // the kerb. Its inner edge starts at 3.66, buried under the kerb, so no
      // face is coplanar with anything; what the player sees is the 16 cm of
      // lining between the bedding edge (3.74) and the shoulder (3.90).
      const gIn = side > 0 ? GUTTER_IN : -GUTTER_OUT;
      const gOut = side > 0 ? GUTTER_OUT : -GUTTER_IN;
      for (const [zN, zF] of segs) {
        rbBox(S, gIn, gOut, ROAD_BOTTOM, GUTTER_FLOOR, zN, zF, 0.72, 0.74, 0.72);
      }
    }

    for (const p of layout.peb) {
      if (gap && p.z < gs && p.z > ge) continue;
      rbBox(S, p.x - p.r, p.x + p.r, -0.1, ROAD_TOP + 0.016 + p.r * 0.25,
        p.z + p.r, p.z - p.r, p.c * 1.03, p.c, p.c * 0.95);
    }

    // Bright broken lip along both rims. Deliberately over-bright: a pale
    // ragged edge against the near-black throat is the cue that survives fog,
    // distance and a 42 m/s approach, and it is the LAST thing the player
    // sees before committing to the jump.
    if (gap) {
      for (const rim of [gs, ge]) {
        const dir = rim === gs ? 1 : -1; // slabs sit on the intact side
        let x = -ROAD_HALF;
        while (x < ROAD_HALF - 0.1) {
          const w = 0.5 + this.rnd() * 0.75;
          const x1 = Math.min(ROAD_HALF, x + w);
          const d = 0.24 + this.rnd() * 0.3;   // how far back onto the road
          const t = 1.16 + this.rnd() * 0.28;  // sunlit pale stone
          rbBox(S, x + 0.03, x1 - 0.03, -0.5, ROAD_TOP + 0.05 + this.rnd() * 0.07,
            rim + (dir > 0 ? d : 0.02), rim - (dir > 0 ? 0.02 : d),
            t * 1.02, t, t * 0.97);
          x = x1;
        }
      }
    }

    const stone = new THREE.Mesh(rbGeo(S), this._roadStoneMat());
    stone.receiveShadow = true;
    stone.matrixAutoUpdate = false;
    stone.updateMatrix();
    group.add(stone);
    const bed = new THREE.Mesh(rbGeo(Bd), this._terrainMat(Mats.path()));
    bed.receiveShadow = true;
    bed.matrixAutoUpdate = false;
    bed.updateMatrix();
    group.add(bed);
  }

  _pathStrip(chunk, gap) {
    const group = chunk.group;
    // Grass fringe: one strip, side re-picked on every activation.
    const fringe = buildGrassFringe({ length: L, width: 1.0 });
    fringe.position.set(4.3, -0.02, -L / 2);
    this._loose(chunk, fringe, { x: [4.3, 4.3], ax: true });
    if (!gap) {
      this._roadBuild(group, this._roadLayout(this.rnd), null);
      return;
    }
    const [gs, ge] = gap;
    this._roadBuild(group, this._roadLayout(this.rnd), gap);
    // Pit shaft under the collapsed section so a fall reads as an abyss, not
    // as floating in front of the sky dome. Three fixes here, all of which
    // were working against readability:
    //   COLOR  stoneDark is a LIGHT rock, so the "void" sat at nearly the same
    //          value as the road it was supposed to interrupt. Now near black.
    //   DEPTH  the box top used to sit at y -0.35, and a BoxGeometry's top face
    //          IS visible from above, so looking into a gap you were looking at
    //          a lit floor 35 cm down. It was a shallow tray, not a hole. The
    //          top now sits at -5.0, inside the black part of the throat ramp.
    //   WIDTH  8.2 rather than 7.8 keeps its walls off the throat lining at
    //          +-3.9, which would otherwise z-fight along the whole pit.
    const gapLen = gs - ge;
    const shaft = new THREE.Mesh(new THREE.BoxGeometry(8.2, 26, gapLen + 5), this._voidMat());
    shaft.position.set(0, -18.0, (gs + ge) / 2);
    shaft.matrixAutoUpdate = false;
    shaft.updateMatrix();
    group.add(shaft);
    // Lit throat lining plus rising silt and trickling grit. Motion is the
    // strongest cue the eye has, and it costs no per-frame work here: the
    // shader rides the shared AnimU.time uniform.
    const void3 = buildGapVoid({ width: 7.8, length: gapLen });
    void3.position.set(0, 0, (gs + ge) / 2);
    group.add(void3);
    // Broken rim stones on both edges of the gap, pale so the void reads
    // from far away even at dusk.
    for (const edgeZ of [gs, ge]) {
      for (let x = -3.2; x <= 3.2; x += 1.1) {
        if (this.rnd() < 0.35) continue;
        const s = buildBoulder(0.28 + this.rnd() * 0.2);
        s.material = Mats.stone();
        s.position.set(x + (this.rnd() - 0.5) * 0.4, -0.05, edgeZ + (this.rnd() - 0.5) * 0.3);
        s.matrixAutoUpdate = false;
        s.updateMatrix();
        group.add(s);
      }
    }
  }

  // Register a movable prop: re-scattered inside its envelope on every
  // activation, so recycled chunks never repeat their decor layout.
  // env: { x: [lo,hi], ax: true (random sign on x), z: [lo,hi], rot: true }
  _loose(chunk, obj, env) {
    chunk.loose.push({ obj, env });
    chunk.group.add(obj);
  }

  _scatterLoose(chunk) {
    for (const it of chunk.loose) {
      const e = it.env;
      if (e.x) {
        let x = randRange(this.rnd, e.x[0], e.x[1]);
        if (e.ax && this.rnd() < 0.5) x = -x;
        it.obj.position.x = x;
      }
      if (e.z) it.obj.position.z = randRange(this.rnd, e.z[0], e.z[1]);
      if (e.rot) it.obj.rotation.y = this.rnd() * Math.PI * 2;
      if (!it.obj.matrixAutoUpdate && it.obj.updateMatrix) it.obj.updateMatrix();
    }
  }

  // Roadside life on the andenes. Only some of them greet you, which is the
  // entire point: a wave that always happens is scenery, a wave that sometimes
  // happens is a person.
  _addFarmer(chunk, x, z, rotY, friendly) {
    const f = buildFarmer({ friendly });
    f.group.position.set(x, 0, z);
    f.group.rotation.y = rotY;
    chunk.group.add(f.group);
    chunk.anims.push(f);
  }

  _addAnimal(chunk, kind, x, z, rotY) {
    const a = kind === 'llama' ? buildLlama() : buildAlpaca();
    a.group.position.set(x, 0, z);
    a.group.rotation.y = rotY;
    chunk.group.add(a.group);
    chunk.anims.push(a);
  }

  // The three andene banks of a valley chunk. Position, base height and TIER
  // COUNT are fixed constants shared by every variant, because a bank that
  // changes x or tier count between neighbouring chunks steps sideways at the
  // seam and shows its open flank. Everything that varies (crops, workers,
  // animals, ruins) sits in front of them instead.
  //
  // The numbers are derived from the shared profile, not guessed. With that
  // profile a 5-tier bank rises 5.714 m and its top shelf runs back to local
  // x 21.199; the hillside under it is 5.0 * smoothstep(10, 40, x) plus up to
  // +-0.55 m of fBm. So:
  //   near  base 1.35 keeps its first shelf (y 2.475) clear of the highest
  //         ground its footprint can reach (about 2.17 at x 21.4)
  //   high  base 7.064 = 1.35 + 5.714, exactly the near bank's top shelf, so
  //         the two banks read as one flight of terraces; x 29.3 puts its
  //         first wall UNDER the near bank's top shelf, sealing the join
  _valleyTerraces(group) {
    const near = buildTerraces({ side: 1, length: L, tiers: 5 });
    near.position.set(13.2, 1.35, -L / 2);
    group.add(near);
    // A second bank climbing further up the valley wall: real andenes stack up
    // the slope rather than stopping at one tier group.
    const high = buildTerraces({ side: 1, length: L, tiers: 4 });
    high.position.set(29.3, 7.06, -L / 2);
    group.add(high);
    // Mirror bank across the river so the valley reads as cultivated on both
    // sides instead of one dressed wall and one empty one.
    const far = buildTerraces({ side: -1, length: L, tiers: 3 });
    far.position.set(-21.5, 0, -L / 2);
    group.add(far);
  }

  // Shadow budget. Every mesh with castShadow is drawn TWICE: once into the
  // shadow map and once in the main pass. A census of a live frame found 519
  // casters with a bounding radius under 0.45 m (pebbles, grass tufts, tiny
  // trim pieces). Their shadows are imperceptible from the gameplay camera at
  // 42 m/s, so they were pure cost. Big silhouette objects keep theirs, which
  // is what actually grounds the scene.
  _trimShadows(root) {
    root.traverse((o) => {
      if (!o.isMesh || !o.castShadow || !o.geometry) return;
      if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere();
      const bs = o.geometry.boundingSphere;
      if (bs && bs.radius < 0.5) o.castShadow = false;
    });
  }

  _buildChunk(biome, variant) {
    const rnd = this.rnd;
    const group = new THREE.Group();
    group.visible = false;
    this.worldGroup.add(group);
    const chunk = {
      biome, variant, group,
      gaps: [], anims: [], obstacles: [], coinIds: [], loose: [],
      index: -1, inUse: false,
    };

    let gap = null;
    if (variant === 2) {
      const gc = -randRange(rnd, 13, 22);
      const glen = randRange(rnd, 3.0, 3.6);
      gap = [gc + glen / 2, gc - glen / 2];
      chunk.gaps.push(gap);
    }

    if (biome === 'VALLEY') {
      // Backstop sits BELOW the deepest riverbed point (about -2.3 here), or
      // it caps the channel off and the water goes back to being a flat sheet
      // laid on a plane. It only ever shows through cracks anyway.
      group.add(this._groundBackstop(Mats.grass(), -2.6));
      this._pathStrip(chunk, gap);
      // Rolling grass shoulders; the left one slopes down into the river.
      // Ground must be CONTINUOUS. These strips are the actual floor, and any
      // x they do not cover is a hole you can see the sky through, which is
      // exactly what the pale blue bands along the terraces were. The right
      // shoulder now runs from the road edge out past the furthest terrace.
      // Widened to reach past the FURTHEST terrace tier (the high bank now
      // ends near x 50); the old 30 m strip stopped at x 33.9, so everything
      // beyond it was terraces standing over nothing.
      group.add(this._terrain(48, L, Mats.grass(), 27.9, -L / 2, {
        splat: true,
        // Valley wall rising away from the road. The terraces are then carved
        // into a real slope instead of standing free on a flat plain, which is
        // how andenes actually work: cut into the hillside, stepping up it.
        shape: (wx) => 5.0 * smoothstep(10.0, 40.0, wx),
      }));
      group.add(this._terrain(5.4, L, Mats.grass(), -6.4, -L / 2, {
        splat: true,
        shape: (wx) => -0.62 * smoothstep(7.9, 8.9, -wx),
      }));
      // River to the left, far bank beyond (sloping up out of the water).
      // `period: L` is the chunk stride: the bed geometry tiles at exactly that
      // pitch, so pooled chunks meet edge to edge whatever order they recycle
      // in. The plane itself still overhangs by 1 m at each end.
      const river = this.water.makeRiver({ width: 9, length: L + 2, period: L });
      river.position.set(-13.4, -0.55, -L / 2);
      group.add(river);
      group.add(this._terrain(24, L, Mats.grass(), -29.9, -L / 2, {
        splat: true, amp: 0.8,
        shape: (wx) => -0.62 * smoothstep(-18.8, -17.9, wx),
      }));
      const reeds = buildReeds({ count: 8, area: [2.5, L - 6] });
      reeds.position.set(-9.3, -0.1, -L / 2);
      group.add(reeds);

      // Foam lace along both river banks.
      // Foam strips retired: the water shader now grows its own noise-bitten
      // foam along the real waterline from the aShore attribute. The old flat
      // additive strips sat proud of the bank as pale blue slabs and were the
      // main source of stray sky-blue in the valley.

      this._valleyTerraces(group);
      if (variant === 0) {
        // Two or three workers on the near bank, only some of them friendly.
        const crew = 2 + ((rnd() * 2) | 0);
        for (let i = 0; i < crew; i++) {
          // Close enough to the road to actually be seen at speed. Beyond
          // about 9 m out they are a few pixels tall and read as litter.
          this._addFarmer(
            chunk,
            5.8 + rnd() * 2.6,
            -6 - rnd() * (L - 12),
            -1.35 + rnd() * 0.6,
            rnd() < 0.5
          );
        }
        const fl = buildFlowers({ count: 8, area: [4, L - 8] });
        fl.position.set(5.6, 0, -L / 2);
        this._loose(chunk, fl, { x: [5.0, 6.4], z: [-L / 2 - 4, -L / 2 + 4] });
        // Queunas at the terrace feet, molles on the far bank.
        const q = buildQueunaPatch({ count: 3, area: [4, L - 8] });
        q.position.set(8.9, 0, -L / 2);
        this._loose(chunk, q, { x: [8.2, 9.6], z: [-L / 2 - 3, -L / 2 + 3] });
        const mo = buildMollePatch({ count: 2, area: [5, L - 10] });
        mo.position.set(-21.5, -0.2, -L / 2);
        this._loose(chunk, mo, { x: [-22.5, -20.5], z: [-L / 2 - 4, -L / 2 + 4] });
        // One or two grazing camelids, loosely grouped so they read as animals
        // that chose to stand near each other. Kept deliberately sparse: the
        // llamas that matter are the ones sitting in your lane, and a field of
        // ornamental ones only made those harder to pick out.
        const herd = 1 + ((rnd() * 2) | 0);
        const herdZ = -6 - rnd() * (L - 14);
        for (let h = 0; h < herd; h++) {
          this._addAnimal(chunk, rnd() < 0.75 ? 'llama' : 'alpaca',
            5.8 + rnd() * 3.4, herdZ - rnd() * 3.5, rnd() * Math.PI * 2);
        }
      } else if (variant === 1) {
        const ruin = buildRuin();
        ruin.position.set(7.6, 0, -18);
        this._loose(chunk, ruin, { x: [6.9, 8.3], z: [-24, -10], rot: true });
        const maize = buildMaizePatch({ count: 18, area: [5, L - 10] });
        maize.position.set(12.5, 0, -L / 2);
        this._loose(chunk, maize, { z: [-L / 2 - 4, -L / 2 + 4] });
        // Megalithic set piece behind the maize, cascade on the far bank.
        const mega = buildMegalithWall({ length: 14, height: 4 });
        mega.position.set(12.8, 0, -26);
        mega.rotation.y = randRange(rnd, -0.12, 0.12);
        group.add(mega);
        const wf = buildWaterfall({ height: 5.5, width: 3 });
        wf.position.set(-18.3, -0.55, -18);
        wf.rotation.y = Math.PI / 2;
        this._loose(chunk, wf, { z: [-26, -8] });
        const q = buildQueunaPatch({ count: 2, area: [4, L - 12] });
        q.position.set(-21.8, -0.2, -L / 2);
        group.add(q);
        // Same sparse grazing pair as variant 0: roadside life, not a field.
        const herd2 = 1 + ((rnd() * 2) | 0);
        const herd2Z = -6 - rnd() * 20;
        for (let h = 0; h < herd2; h++) {
          this._addAnimal(chunk, rnd() < 0.5 ? 'alpaca' : 'llama',
            5.6 + rnd() * 3.2, herd2Z - rnd() * 3.5, rnd() * Math.PI * 2);
        }
      } else {
        if (rnd() < 0.4) {
          this._addFarmer(chunk, -6.2 - rnd() * 2.4, -8 - rnd() * 16, 1.25, rnd() < 0.5);
        }
        const fl = buildFlowers({ count: 6, area: [3, L - 10] });
        fl.position.set(-5.8, 0, -L / 2);
        group.add(fl);
        const mo = buildMollePatch({ count: 2, area: [4, L - 10] });
        mo.position.set(-22, -0.2, -L / 2);
        group.add(mo);
      }
      for (let i = 0; i < 2; i++) {
        const b = buildBoulder(randRange(rnd, 0.5, 1.1));
        this._loose(chunk, b, { x: [5.2, 8.5], ax: true, z: [-L + 3, -3], rot: true });
      }
    } else if (biome === 'CLIFF') {
      // La Cornisa: a ledge carved into the mountainside. Rock wall left,
      // sheer drop right into a CANYON.
      //
      // The drop needs a floor or the player looks over the edge straight into
      // the sky dome. But a 320 m wide flat plane is worse than the hole it
      // fixed: it runs out to where scene.fog (near 90, far 400) bleaches it
      // to near white, so the abyss read as a sheet of milk. A canyon has a
      // FAR SIDE. Everything below is now framed by an opposite mountainside
      // that closes the composition at about 55 m, comfortably inside the fog
      // near plane, so none of it ever fogs out.
      //
      // The floor stays a visual backstop only: isGroundSolid is untouched, so
      // the drop is still a lethal fall.
      group.add(this._groundBackstop(Mats.stoneDark(), -39.5, 150));
      this._pathStrip(chunk, gap);
      // Narrow shoulder between path and wall.
      group.add(this._terrain(3.2, L, Mats.grass(), -5.4, -L / 2, { splat: true, amp: 0.2 }));
      // The cliff wall: two stepped rock faces leaning over the road.
      const wall1 = new THREE.Mesh(this._tileUV(new THREE.BoxGeometry(9, 30, L + 0.4), L, 30, 5), Mats.stoneDark());
      wall1.position.set(-11.4, 13.5, -L / 2);
      wall1.rotation.z = -0.06;
      wall1.castShadow = true;
      wall1.matrixAutoUpdate = false;
      wall1.updateMatrix();
      group.add(wall1);
      const wall2 = new THREE.Mesh(this._tileUV(new THREE.BoxGeometry(10, 44, L + 0.4), L, 44, 6), Mats.stoneDark());
      wall2.position.set(-18.5, 18, -L / 2);
      wall2.matrixAutoUpdate = false;
      wall2.updateMatrix();
      group.add(wall2);
      const tufts = buildIchuPatch({ count: 10, area: [2.2, L - 4] });
      tufts.position.set(-5.6, 0, -L / 2);
      group.add(tufts);
      // Narrow rim, then the abyss: crumbling stones mark the edge.
      group.add(this._terrain(2.8, L, Mats.grass(), 5.2, -L / 2, { splat: true, amp: 0.1 }));
      for (let z = -2; z > -L; z -= 5.5) {
        if (rnd() < 0.62) continue;
        const rs = buildBoulder(0.24 + rnd() * 0.22);
        rs.material = Mats.stone();
        rs.position.set(4.9 + (rnd() - 0.5) * 0.5, -0.05, z + (rnd() - 0.5) * 1.2);
        rs.matrixAutoUpdate = false;
        rs.updateMatrix();
        group.add(rs);
      }
      // The mountainside continues BELOW the ledge: falling shows rock all
      // the way down, never bare sky. Widened to x = 8.5 so it reaches under
      // the rim strip instead of leaving the grass overhanging into nothing.
      const face = new THREE.Mesh(this._tileUV(new THREE.BoxGeometry(19, 34, L + 0.4), L, 34, 5), Mats.stoneDark());
      face.position.set(-1.0, -17.2, -L / 2);
      face.matrixAutoUpdate = false;
      face.updateMatrix();
      group.add(face);
      // Where the shoulder ends the ground has to visibly BREAK. An exposed
      // dirt-and-rock lip tipping over the edge, then loose crumbling stones
      // along it, so grass does not simply stop in mid air.
      group.add(this._terrain(2.8, L, Mats.earth(), 6.4, -L / 2, {
        amp: 0.14, y: -0.05,
        shape: (wx) => -0.85 * smoothstep(5.5, 7.7, wx),
      }));
      for (let z = -1.5; z > -L; z -= 3.1) {
        if (rnd() < 0.55) continue;
        const rs = buildBoulder(0.2 + rnd() * 0.42);
        rs.material = Mats.stoneDark();
        rs.position.set(6.0 + rnd() * 1.5, -0.35 - rnd() * 0.5, z + (rnd() - 0.5) * 1.4);
        rs.rotation.set(rnd() * 0.6, rnd() * 3.1, rnd() * 0.6);
        rs.matrixAutoUpdate = false;
        rs.updateMatrix();
        group.add(rs);
      }
      // The canyon floor: shaped, not flat. It falls away into the river
      // channel and climbs the far side, so the eye reads a valley section
      // instead of a plain. Reaches out to meet the far wall.
      group.add(this._terrain(56, L, Mats.grass(), 31, -L / 2, {
        splat: true, amp: 0.9, y: -34,
        shape: (wx) => {
          const d = (wx - 24) / 8.5;
          return -3.6 * Math.exp(-d * d) + 3.2 * smoothstep(34, 56, wx);
        },
      }));
      // Wider and set deeper into the cut so the bed reads from up here as a
      // real channel. `detail` thins the bed grid and its stones: at 34 m
      // below the ledge nobody is counting pebbles.
      const deepRiver = this.water.makeRiver({
        width: 11, length: L + 2, period: L, depth: 1.75, detail: 0.75,
      });
      deepRiver.position.set(24, -35.4, -L / 2);
      group.add(deepRiver);
      // Opposite mountainside, in three steps so the abyss reads as a canyon
      // and not as a second corridor wall:
      //   ridge    a spur rising off the canyon floor, top still well BELOW
      //            eye level, so it only shows when looking down
      //   buttress per-variant height, purely to break the skyline: a single
      //            slab running unbroken for 250 m reads as a flat
      //   farWall  tops out about 20 m above the ledge at 50 m out, which is
      //            high enough to cover the horizon (and its fog-bleached
      //            white) while still leaving sky and peaks visible above it
      const ridge = new THREE.Mesh(this._tileUV(new THREE.BoxGeometry(11, 30, L + 0.5), L, 30, 4), Mats.stoneDark());
      ridge.position.set(41, -21, -L / 2);
      ridge.rotation.z = 0.10;
      ridge.matrixAutoUpdate = false;
      ridge.updateMatrix();
      group.add(ridge);
      const bh = 34 + variant * 10;
      const butt = new THREE.Mesh(this._tileUV(new THREE.BoxGeometry(9, bh, L + 0.5), L, bh, 5), Mats.stoneDark());
      butt.position.set(49, -22 + variant * 3, -L / 2);
      butt.rotation.z = -0.04;
      butt.matrixAutoUpdate = false;
      butt.updateMatrix();
      group.add(butt);
      const farWall = new THREE.Mesh(this._tileUV(new THREE.BoxGeometry(24, 60, L + 0.5), L, 60, 7), Mats.stoneDark());
      farWall.position.set(62, -10, -L / 2);
      farWall.rotation.z = -0.08;
      farWall.matrixAutoUpdate = false;
      farWall.updateMatrix();
      group.add(farWall);
      const dq = buildQueunaPatch({ count: 3, area: [10, L - 6] });
      dq.position.set(16, -34.6, -L / 2);
      group.add(dq);
      if (variant === 1) {
        const ruin = buildRuin();
        ruin.position.set(-5.8, 0, -26);
        ruin.rotation.y = randRange(rnd, 0.2, 0.6);
        group.add(ruin);
      }
      if (variant === 0) {
        const gate = buildGateway();
        gate.position.set(0, 0, -L + 1.4);
        group.add(gate);
      }
    } else if (biome === 'PUNA') {
      // Below the lake basin, same reason as the valley: a backstop drawn over
      // the bed turns the lake back into a painted disc.
      group.add(this._groundBackstop(Mats.puna(), -4.2));
      this._pathStrip(chunk, gap);
      group.add(this._terrain(30, L, Mats.puna(), 18.9, -L / 2, { amp: 0.75 }));
      // The basin must be deeper and wider than the water's own bed, or the
      // ground pokes up through it. Cut it to 3.4 m and let the bed sit inside.
      const lakeShape = variant === 1
        ? (wx, cz) => {
            const dist = Math.hypot(wx + 15.5, cz + L / 2);
            return -3.4 * (1 - smoothstep(0, 11.5, dist));
          }
        : null;
      group.add(this._terrain(30, L, Mats.puna(), -18.9, -L / 2,
        lakeShape ? { amp: 0.75, shape: lakeShape } : { amp: 0.75 }));
      const ichuL = buildIchuPatch({ count: 40, area: [9, L - 4] });
      ichuL.position.set(-8.8, 0, -L / 2);
      group.add(ichuL);
      const ichuR = buildIchuPatch({ count: 40, area: [9, L - 4] });
      ichuR.position.set(8.8, 0, -L / 2);
      group.add(ichuR);
      for (let i = 0; i < 2; i++) {
        const b = buildBoulder(randRange(rnd, 0.6, 1.6));
        this._loose(chunk, b, { x: [5.4, 12], ax: true, z: [-L + 3, -3], rot: true });
      }
      if (variant === 1) {
        // waterline is where the bed actually surfaces; it is set just outside
        // where the basin crosses the water level so the bed's wet gravel ring
        // shows before the ichu takes over, and its outer edge stays buried.
        const lake = this.water.makeLake({ radius: 10, waterline: 8.6, depth: 1.6 });
        lake.position.set(-15.5, -0.4, -L / 2);
        group.add(lake);
      }
      if (variant === 0 && rnd() < 0.7) {
        // Sparse on purpose. The puna obstacle table now spawns sitting llamas
        // in the lanes, and a crowded roadside made those read as decor.
        const punaHerd = 1 + ((rnd() * 2) | 0);
        const punaZ = -8 - rnd() * (L - 16);
        for (let h = 0; h < punaHerd; h++) {
          this._addAnimal(chunk, rnd() < 0.55 ? 'alpaca' : 'llama',
            -6.2 - rnd() * 3.6, punaZ - rnd() * 3.5, rnd() * Math.PI * 2);
        }
      }
      if (variant === 0 && rnd() < 0.4) {
        const tower = buildWatchtower();
        tower.position.set(10.8, 0, -18);
        group.add(tower);
      }
      // Hardy queunas survive up here too, sparse.
      if (variant !== 1) {
        const q = buildQueunaPatch({ count: 3, area: [6, L - 8] });
        q.position.set((rnd() < 0.5 ? -1 : 1) * 11.5, 0, -L / 2);
        group.add(q);
      }
    } else { // BRIDGE
      // Plank deck with optional missing section.
      const plankMat = Mats.wood();
      let z = -0.5;
      while (z > -L + 0.4) {
        const inGap = gap && z <= gap[0] + 0.4 && z >= gap[1] - 0.4;
        if (!inGap) {
          const p = new THREE.Mesh(new THREE.BoxGeometry(7.8, 0.16, 0.86), plankMat);
          p.position.set((this.rnd() - 0.5) * 0.12, -0.1, z);
          p.rotation.y = (this.rnd() - 0.5) * 0.03;
          p.receiveShadow = true;
          p.matrixAutoUpdate = false;
          p.updateMatrix();
          group.add(p);
        }
        z -= 0.98;
      }
      const sides = buildRopeBridgeSides(L);
      sides.position.set(0, 0, -L / 2);
      group.add(sides);
      // Gorge walls and the river far below.
      for (const side of [-1, 1]) {
        const wall = new THREE.Mesh(this._tileUV(new THREE.BoxGeometry(14, 34, L + 0.5), L, 34, 5), Mats.stoneDark());
        wall.position.set(side * 14.5, -17.5, -L / 2);
        wall.rotation.z = side * -0.12;
        wall.matrixAutoUpdate = false;
        wall.updateMatrix();
        group.add(wall);
      }
      // Gorge floor under the river, so looking down past the water's edge
      // shows canyon bed rather than sky.
      // Dropped clear of the gorge riverbed so the channel is not capped off.
      group.add(this._groundBackstop(Mats.stoneDark(), -29.2, 120));
      const river = this.water.makeRiver({
        width: 16, length: L + 2, period: L, depth: 2.2, detail: 0.7,
      });
      river.position.set(0, -26, -L / 2);
      group.add(river);
    }

    // Biome-entry gateway on the first chunk of every biome run gets added
    // dynamically at activation (see _activateChunk) to avoid double-building.
    this._trimShadows(group);
    return chunk;
  }

  // ------------------------------------------------------------------
  // Runtime
  // ------------------------------------------------------------------

  _getObstacle(kind) {
    const pool = this._obstaclePools[kind];
    for (const ob of pool) if (!ob.inUse) { ob.inUse = true; return ob; }
    // Grow on demand: the pool adapts to the session high-water mark, so a
    // slot never silently spawns empty (QA measured 112 empty slots per run
    // with fixed pools). Amortized: a handful of builds per session.
    const ob = createObstacle(kind);
    ob.inUse = true;
    pool.push(ob);
    return ob;
  }

  _freeChunkContent(chunk) {
    for (const ob of chunk.obstacles) {
      ob.inUse = false;
      ob.group.visible = false;
      chunk.group.remove(ob.group);
    }
    chunk.obstacles.length = 0;
    chunk.hasMover = false;
    this.coins.freeIds(chunk.coinIds);
  }

  _difficulty(dist) {
    let tier = CONFIG.difficulty[0];
    for (const t of CONFIG.difficulty) if (dist >= t.atMeters) tier = t;
    return tier;
  }

  _spawnContent(chunk, index) {
    const rnd = this.rnd;
    const dist = index * L;
    const tier = this._difficulty(dist);
    if (index < 2) return; // starting runway stays clear

    const kinds = BIOME_OBSTACLES[chunk.biome];
    const gapZ = chunk.gaps.length ? (chunk.gaps[0][0] + chunk.gaps[0][1]) / 2 : null;

    // Pick obstacle slots, avoiding the gap and any set-piece bore.
    const fz = chunk.featureZ === undefined ? null : chunk.featureZ;
    const slots = SLOTS.filter((s) =>
      (gapZ === null || Math.abs(s - gapZ) > 6) &&
      (fz === null || Math.abs(s - fz) > 10));
    const nSlots = Math.min(tier.slots, slots.length);
    const chosen = [];
    const avail = slots.slice();
    for (let i = 0; i < nSlots; i++) {
      if (!avail.length) break;
      const s = avail.splice((rnd() * avail.length) | 0, 1)[0];
      chosen.push(s);
    }

    for (const slotZ of chosen) {
      let kind = pick(rnd, kinds);
      const canRoll = tier.movers && chunk.biome !== 'BRIDGE' && gapZ === null && rnd() < ((tier.rollerChance || 0.16) * (chunk.biome === 'CLIFF' ? 1.6 : 1));
      if (canRoll) kind = 'roller';
      const info = KIND_INFO[kind];

      if (info.action === 'dodge') {
        // Block 1-2 lanes, never all three.
        const blockTwo = kind !== 'roller' && rnd() < 0.25 && tier.slots >= 2;
        const freeLane = (rnd() * 3) | 0;
        const lanes = [0, 1, 2].filter((l) => l !== freeLane);
        const useLanes = blockTwo ? lanes : [lanes[(rnd() * lanes.length) | 0]];
        for (const lane of useLanes) {
          const ob = this._getObstacle(kind);
          if (!ob) continue;
          const zOff = kind === 'roller' ? slotZ - 14 : slotZ;
          ob.group.position.set(CONFIG.lanes[lane], 0, zOff);
          ob.group.visible = true;
          if (kind === 'roller') {
            ob.travel = 0;
            chunk.hasMover = true;
          }
          chunk.group.add(ob.group);
          chunk.obstacles.push(ob);
          if (kind === 'roller') break; // one roller max per slot
        }
        // Coins in the free lane.
        this._coinLine(chunk, CONFIG.lanes[freeLane], slotZ, 5);
      } else {
        // Jump/slide obstacle: single lane, double, or full row (jumpable only).
        const roll = rnd();
        let lanes;
        if (roll < 0.5) lanes = [(rnd() * 3) | 0];
        else if (roll < 0.8 || info.action === 'slide') {
          const freeLane = (rnd() * 3) | 0;
          lanes = [0, 1, 2].filter((l) => l !== freeLane);
        } else lanes = [0, 1, 2];
        for (const lane of lanes) {
          const ob = this._getObstacle(kind);
          if (!ob) continue;
          ob.group.position.set(CONFIG.lanes[lane], 0, slotZ);
          ob.group.visible = true;
          chunk.group.add(ob.group);
          chunk.obstacles.push(ob);
        }
        if (lanes.length === 3 && info.action === 'jump') {
          this._coinArc(chunk, CONFIG.lanes[(rnd() * 3) | 0], slotZ);
        } else if (lanes.length < 3) {
          const freeLanes = [0, 1, 2].filter((l) => !lanes.includes(l));
          this._coinLine(chunk, CONFIG.lanes[pick(rnd, freeLanes)], slotZ, 5);
        }
      }
    }

    // Coin arc over the gap.
    if (gapZ !== null) this._coinArc(chunk, CONFIG.lanes[(rnd() * 3) | 0], gapZ, 2.3);

    // Free-run coin lines between slots; never through an obstacle slot,
    // so a coin trail cannot lure the player into a crash.
    if (rnd() < 0.55) {
      const z = -randRange(rnd, 10, 26);
      const clear =
        (gapZ === null || Math.abs(z - gapZ) > 6) &&
        chosen.every((s) => Math.abs(z - s) > 7);
      if (clear) this._coinLine(chunk, CONFIG.lanes[(rnd() * 3) | 0], z, 6);
    }

    // Specials cadence.
    const chunkStart = index * L;
    if (chunkStart > this._nextPowerupAt) {
      const kinds2 = ['quri', 'inti', 'wayra'];
      const kind = kinds2[this._powerCycle++ % 3];
      const slot = avail.length ? avail[0] : -12;
      if (this.specials.spawn(kind, CONFIG.lanes[(rnd() * 3) | 0], 1.2, chunk.group.position.z + slot)) {
        this._nextPowerupAt = chunkStart + randRange(rnd, ...CONFIG.powerupEveryMeters);
      }
    }
    if (chunkStart > this._nextChakanaAt) {
      const slot = avail.length ? avail[avail.length - 1] : -24;
      if (this.specials.spawn('chakana', CONFIG.lanes[(rnd() * 3) | 0], 1.25, chunk.group.position.z + slot)) {
        this._nextChakanaAt = chunkStart + randRange(rnd, ...CONFIG.chakanaEveryMeters);
      }
    }
  }

  _coinLine(chunk, laneX, centerZ, n) {
    const zLocal = chunk.group.position.z + centerZ;
    for (let i = 0; i < n; i++) {
      const id = this.coins.alloc(laneX, 0.8, zLocal + (i - (n - 1) / 2) * 1.9);
      if (id >= 0) chunk.coinIds.push(id);
    }
  }

  _coinArc(chunk, laneX, centerZ, apex = 2.0) {
    const zLocal = chunk.group.position.z + centerZ;
    const n = 7;
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const z = (t - 0.5) * 7.4;
      const y = 0.7 + apex * Math.sin(t * Math.PI) * 0.85;
      const id = this.coins.alloc(laneX, y, zLocal + z);
      if (id >= 0) chunk.coinIds.push(id);
    }
  }

  _activateChunk(index) {
    // Negative indices back the start line so the camera never sees the void.
    const { biome, runIdx } = this.biomeOf(Math.max(0, index));
    const pool = this._chunkPools[biome];
    const wantGap = index >= 4 && this.rnd() < 0.3;
    let chunk =
      pool.find((c) => !c.inUse && (wantGap ? c.variant === 2 : c.variant !== 2)) ||
      pool.find((c) => !c.inUse);
    if (!chunk) return; // should not happen; sized pools
    chunk.inUse = true;
    chunk.index = index;
    chunk.group.position.z = -index * L;
    chunk.group.visible = true;

    // Biome-entry gateway (lazy-built once per chunk instance, reused after).
    if (runIdx === 0 && index >= 0 && biome !== 'BRIDGE') {
      if (!chunk.entryGate) {
        chunk.entryGate = buildGateway();
        // Far enough in that the menu camera never sits inside the lintel.
        chunk.entryGate.position.set(0, 0, -9);
        chunk.group.add(chunk.entryGate);
      }
      chunk.entryGate.visible = true;
    } else if (chunk.entryGate) {
      chunk.entryGate.visible = false;
    }

    // Tambo relay station every ~500 m on open-country biomes: the places
    // where real chasquis handed off their messages.
    const wantTambo =
      index >= 3 && index % 14 === 5 &&
      (biome === 'VALLEY' || biome === 'PUNA' || biome === 'CLIFF');
    if (wantTambo) {
      if (!chunk.tambo) {
        chunk.tambo = buildTambo();
        // On the ledge the tambo hugs the wall side; elsewhere the open side.
        if (biome === 'CLIFF') {
          chunk.tambo.position.set(-7.4, 0, -20);
          chunk.tambo.rotation.y = 0.2;
        } else {
          chunk.tambo.position.set(7.6, 0, -20);
          chunk.tambo.rotation.y = -0.35;
        }
        chunk.group.add(chunk.tambo);
      }
      chunk.tambo.visible = true;
    } else if (chunk.tambo) {
      chunk.tambo.visible = false;
    }

    // Rare set-pieces (lazy-built per chunk instance): a rock tunnel bored
    // through the mountain biomes, a hamlet straddling the valley road.
    chunk.featureZ = null;
    const wantFeature = !wantTambo && index >= 4 && chunk.variant !== 2 && this.rnd() < 0.1;
    if (wantFeature && (biome === 'PUNA' || biome === 'CLIFF')) {
      if (!chunk.tunnel) {
        chunk.tunnel = buildTunnel({ length: 16 });
        chunk.tunnel.position.set(0, 0, -18);
        chunk.group.add(chunk.tunnel);
      }
      chunk.tunnel.visible = true;
      chunk.featureZ = -18;
    } else if (chunk.tunnel) chunk.tunnel.visible = false;
    if (wantFeature && biome === 'VALLEY') {
      if (!chunk.village) {
        chunk.village = buildVillageSet();
        chunk.village.position.set(0, 0, -18);
        chunk.group.add(chunk.village);
      }
      chunk.village.visible = true;
    } else if (chunk.village) chunk.village.visible = false;

    this._scatterLoose(chunk);
    this._spawnContent(chunk, index);
    this._active.set(index, chunk);
  }

  reset() {
    for (const [, chunk] of this._active) {
      this._freeChunkContent(chunk);
      chunk.inUse = false;
      chunk.group.visible = false;
    }
    this._active.clear();
    this.coins.reset();
    this.specials.reset();
    this.worldGroup.position.z = 0;
    this._nextIndex = 0;
    this._resetSequence();
    this._playerBiome = null;
    this._nextPowerupAt = randRange(this.rnd, ...CONFIG.powerupEveryMeters);
    this._nextChakanaAt = randRange(this.rnd, ...CONFIG.chakanaEveryMeters);
    for (let i = -1; i <= AHEAD_CHUNKS + 1; i++) this._activateChunk(i);
    this._nextIndex = AHEAD_CHUNKS + 2;
    this._emitBiome();
  }

  _emitBiome() {
    const k = Math.max(0, Math.floor(this.worldGroup.position.z / L));
    const { biome } = this.biomeOf(k);
    if (biome !== this._playerBiome) {
      this._playerBiome = biome;
      if (this.onBiomeChange) this.onBiomeChange(biome, CONFIG.biomeNames[biome]);
    }
  }

  update(dt, speed) {
    const wg = this.worldGroup;
    wg.position.z += speed * dt;

    // Recycle chunks that fell behind; keep the frontier stocked.
    for (const [index, chunk] of this._active) {
      if (wg.position.z + chunk.group.position.z > CONFIG.chunkRecycleBehind) {
        this._freeChunkContent(chunk);
        chunk.inUse = false;
        chunk.group.visible = false;
        this._active.delete(index);
      }
    }
    const playerChunk = Math.floor(wg.position.z / L);
    while (this._nextIndex <= playerChunk + AHEAD_CHUNKS) {
      // A huge forward jump (debug teleport) must not activate hundreds of
      // already-behind indices in one frame and drain the pools.
      if (this._nextIndex < playerChunk - 1) { this._nextIndex++; continue; }
      this._activateChunk(this._nextIndex++);
    }

    this._emitBiome();

    // Animate near chunks (decor + obstacles). Rollers gate on their own
    // world z with a speed-dependent start so they cross the player right at
    // their slot after ~14 m of rolling, at any game speed.
    const rollerStartZ = -(14 * (speed + 7.5) / 7.5 + 2);
    for (const [, chunk] of this._active) {
      const backZ = wg.position.z + chunk.group.position.z;
      if (backZ < -220 || backZ > 60) continue;
      const near = backZ >= -140;
      for (const a of chunk.anims) if (near) a.update(dt);
      for (const ob of chunk.obstacles) {
        if (!ob.update) continue;
        if (ob.kind === 'roller') {
          const obZ = backZ + ob.group.position.z;
          if (obZ < rollerStartZ || obZ > 12) continue;
        } else if (!near) continue;
        ob.update(dt);
      }
    }
  }

  // World-space collider list near the player (reused objects).
  getColliders() {
    const wg = this.worldGroup.position.z;
    this._cols.length = 0;
    let ci = 0;
    for (const [, chunk] of this._active) {
      const chunkZ = wg + chunk.group.position.z;
      // Chunks with a roller stay collidable early: the roller drifts +z far
      // beyond its chunk's own play window.
      if ((chunkZ < -8 && !chunk.hasMover) || chunkZ > L + 8) continue;
      for (const ob of chunk.obstacles) {
        const oz = chunkZ + ob.group.position.z;
        if (oz < -6 || oz > 6) continue;
        const ox = ob.group.position.x;
        for (const b of ob.boxes) {
          if (ci >= this._colPool.length) break;
          const c = this._colPool[ci++];
          c.minX = ox + b.min.x; c.maxX = ox + b.max.x;
          c.minY = b.min.y; c.maxY = b.max.y;
          c.minZ = oz + b.min.z; c.maxZ = oz + b.max.z;
          c.ob = ob;
          this._cols.push(c);
        }
      }
    }
    return this._cols;
  }

  // Is there floor under world-space (x, zWorld)?
  isGroundSolid(x, zWorld) {
    const wg = this.worldGroup.position.z;
    const zl = zWorld - wg; // worldGroup-local
    const k = Math.floor(-zl / L);
    const chunk = this._active.get(k);
    if (!chunk) return true;
    if (!chunk.gaps.length) return true;
    const local = zl + k * L; // 0 .. -L within chunk
    for (const [gs, ge] of chunk.gaps) {
      if (local <= gs && local >= ge) return false;
    }
    return true;
  }

  get currentBiome() { return this._playerBiome; }
}
