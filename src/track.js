// Endless track: pooled biome chunks, obstacle/coin spawning, collision data.
//
// Coordinates: worldGroup moves toward +Z while the player stays near z = 0.
// Chunk k sits at worldGroup-local z = -k * chunkLen, geometry built in
// local range [-chunkLen, 0]. The player plays chunk k while
// worldGroup.position.z is in [k * chunkLen, (k+1) * chunkLen).

import * as THREE from 'three';
import { CONFIG } from './config.js';
import { mulberry32, randRange, pick, smoothstep } from './util.js';
import { Mats, applyGroundExtras } from './materials.js';
import { createObstacle, KIND_INFO } from './obstacles.js';
import {
  buildTerraces, buildGateway, buildRuin, buildWatchtower,
  buildRopeBridgeSides, buildIchuPatch, buildFlowers,
  buildBoulder, buildReeds, buildMaizePatch,
  buildGrassFringe, buildQueunaPatch, buildMollePatch, buildTambo,
  buildWaterfall, buildFoamStrip, buildMegalithWall,
  buildTunnel, buildVillageSet,
} from './scenery.js';
import { buildLlama, buildAlpaca } from './animals.js';
import { CoinField, Specials } from './collectibles.js';
import { makeSplatMaterial, makeTerrainGeometry } from './terrain.js';

const L = CONFIG.chunkLen;
const AHEAD_CHUNKS = 11;

const BIOME_OBSTACLES = {
  VALLEY: ['lowWall', 'boulder', 'llama', 'lintel', 'lowWall', 'boulder'],
  CLIFF: ['boulder', 'boulder', 'lowWall', 'lintel', 'highWall', 'boulder'],
  PUNA: ['boulder', 'lowWall', 'llama', 'boulder', 'lowWall'],
  BRIDGE: ['lintelWood', 'lowWallWood', 'lowWallWood', 'lintelWood'],
};

const OBSTACLE_POOL_SIZES = {
  lowWall: 20, lowWallWood: 12, highWall: 10, lintel: 12, lintelWood: 12,
  boulder: 24, llama: 10, roller: 10,
};

// variant 2 is the "gap" variant for VALLEY / PUNA / BRIDGE.
const VARIANT_COUNTS = { VALLEY: [5, 3, 3], CLIFF: [3, 3, 3], PUNA: [4, 2, 3], BRIDGE: [3, 2, 2] };

const SLOTS = [-6, -18, -30];

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

  _ground(w, d, mat, x = 0, y = -0.15, z = -L / 2) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.3, d), mat);
    m.position.set(x, y, z);
    m.receiveShadow = true;
    m.matrixAutoUpdate = false;
    m.updateMatrix();
    return m;
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
  _terrain(w, d, baseMat, x, z = -L / 2, opts = {}) {
    const amp = opts.amp === undefined ? 0.55 : opts.amp;
    if (opts.splat) {
      // Splat-mapped terrain: photo layers blended by slope + noise in the
      // shader; same displacement field as the classic path below.
      const s1 = this.rnd() * 10, s2 = this.rnd() * 10, s3 = this.rnd() * 10;
      const geo = makeTerrainGeometry({
        width: w, depth: d,
        segsW: Math.max(4, Math.round(w / 1.6)),
        segsD: Math.max(8, Math.round(d / 1.8)),
        height: (lx, lz) => {
          const wx = lx + x;
          const flat = smoothstep(4.1, 7.5, Math.abs(wx));
          let h =
            (Math.sin(wx * 0.16 + s1) * Math.sin(lz * 0.13 + s2) * 0.6 +
              Math.sin(wx * 0.43 + s3) * Math.sin(lz * 0.37 + s1) * 0.28 +
              Math.sin(wx * 1.05 + s2) * Math.sin(lz * 0.92 + s3) * 0.12) * amp * flat;
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

  _pathStrip(chunk, gap) {
    const group = chunk.group;
    // Grass fringe: one strip, side re-picked on every activation.
    const fringe = buildGrassFringe({ length: L, width: 1.0 });
    fringe.position.set(4.3, -0.02, -L / 2);
    this._loose(chunk, fringe, { x: [4.3, 4.3], ax: true });
    const mat = Mats.path();
    if (!gap) {
      group.add(this._ground(7.8, L, mat, 0, -0.14));
      return;
    }
    const [gs, ge] = gap;
    // Dark pit shaft under the collapsed section so a fall reads as an abyss,
    // not as floating in front of the sky dome.
    const gapLen = gs - ge;
    const shaft = new THREE.Mesh(new THREE.BoxGeometry(7.8, 26, gapLen + 5), Mats.stoneDark());
    shaft.position.set(0, -13.35, (gs + ge) / 2);
    shaft.matrixAutoUpdate = false;
    shaft.updateMatrix();
    group.add(shaft);
    const nearLen = -gs;               // from 0 down to gs
    const farLen = L + ge;             // from ge down to -L
    if (nearLen > 0.1) group.add(this._ground(7.8, nearLen, mat, 0, -0.14, gs / 2));
    if (farLen > 0.1) group.add(this._ground(7.8, farLen, mat, 0, -0.14, ge + (-L - ge) / 2));
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

  _addAnimal(chunk, kind, x, z, rotY) {
    const a = kind === 'llama' ? buildLlama() : buildAlpaca();
    a.group.position.set(x, 0, z);
    a.group.rotation.y = rotY;
    chunk.group.add(a.group);
    chunk.anims.push(a);
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
      this._pathStrip(chunk, gap);
      // Rolling grass shoulders; the left one slopes down into the river.
      group.add(this._terrain(9, L, Mats.grass(), 8.4, -L / 2, { splat: true }));
      group.add(this._terrain(5.4, L, Mats.grass(), -6.4, -L / 2, {
        splat: true,
        shape: (wx) => -0.62 * smoothstep(7.9, 8.9, -wx),
      }));
      // River to the left, far bank beyond (sloping up out of the water).
      const river = this.water.makeRiver({ width: 9, length: L + 2 });
      river.position.set(-13.4, -0.55, -L / 2);
      group.add(river);
      group.add(this._terrain(10, L, Mats.grass(), -22.9, -L / 2, {
        splat: true, amp: 0.8,
        shape: (wx) => -0.62 * smoothstep(-18.8, -17.9, wx),
      }));
      const reeds = buildReeds({ count: 8, area: [2.5, L - 6] });
      reeds.position.set(-9.3, -0.1, -L / 2);
      group.add(reeds);

      // Foam lace along both river banks.
      const foam = buildFoamStrip({ length: L });
      foam.position.set(-8.95, -0.48, -L / 2);
      group.add(foam);
      const foamFar = buildFoamStrip({ length: L });
      foamFar.position.set(-17.85, -0.48, -L / 2);
      group.add(foamFar);

      if (variant === 0) {
        const terr = buildTerraces({ side: 1, length: L, tiers: 4 + ((rnd() * 2) | 0) });
        terr.position.set(13.2, 0, -L / 2);
        group.add(terr);
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
        if (rnd() < 0.6) this._addAnimal(chunk, 'llama', 6.5 + rnd() * 2, -8 - rnd() * 18, rnd() * Math.PI * 2);
      } else if (variant === 1) {
        const ruin = buildRuin();
        ruin.position.set(7.6, 0, -18);
        this._loose(chunk, ruin, { x: [6.9, 8.3], z: [-24, -10], rot: true });
        const maize = buildMaizePatch({ count: 18, area: [5, L - 10] });
        maize.position.set(12.5, 0, -L / 2);
        this._loose(chunk, maize, { z: [-L / 2 - 4, -L / 2 + 4] });
        const terr = buildTerraces({ side: 1, length: L, tiers: 3 });
        terr.position.set(17.5, 0, -L / 2);
        group.add(terr);
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
        if (rnd() < 0.5) this._addAnimal(chunk, 'alpaca', 6 + rnd() * 2, -6 - rnd() * 22, rnd() * Math.PI * 2);
      } else {
        const terr = buildTerraces({ side: 1, length: L, tiers: 5 });
        terr.position.set(13.8, 0, -L / 2);
        group.add(terr);
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
      // sheer drop right into a valley far below.
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
        if (rnd() < 0.35) continue;
        const rs = buildBoulder(0.24 + rnd() * 0.22);
        rs.material = Mats.stone();
        rs.position.set(4.9 + (rnd() - 0.5) * 0.5, -0.05, z + (rnd() - 0.5) * 1.2);
        rs.matrixAutoUpdate = false;
        rs.updateMatrix();
        group.add(rs);
      }
      // The mountainside continues BELOW the ledge: falling shows rock all
      // the way down, never bare sky.
      const face = new THREE.Mesh(this._tileUV(new THREE.BoxGeometry(16, 34, L + 0.4), L, 34, 5), Mats.stoneDark());
      face.position.set(-2.5, -17.2, -L / 2);
      face.matrixAutoUpdate = false;
      face.updateMatrix();
      group.add(face);
      // The valley floor far below, reaching from the cliff base outward.
      group.add(this._terrain(46, L, Mats.grass(), 26, -L / 2, {
        splat: true, amp: 1.4, y: -34,
        shape: (wx) => (wx > 19 && wx < 29 ? -1.7 * (1 - Math.abs(wx - 24) / 5) : 0),
      }));
      const deepRiver = this.water.makeRiver({ width: 8, length: L + 2 });
      deepRiver.position.set(24, -33.5, -L / 2);
      group.add(deepRiver);
      const dq = buildQueunaPatch({ count: 3, area: [12, L - 6] });
      dq.position.set(19, -34, -L / 2);
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
      this._pathStrip(chunk, gap);
      group.add(this._terrain(13, L, Mats.puna(), 10.4, -L / 2, { amp: 0.75 }));
      const lakeShape = variant === 1
        ? (wx, cz) => {
            const dist = Math.hypot(wx + 15.5, cz + L / 2);
            return -0.85 * (1 - smoothstep(6, 10.5, dist));
          }
        : null;
      group.add(this._terrain(13, L, Mats.puna(), -10.4, -L / 2,
        lakeShape ? { amp: 0.75, shape: lakeShape } : { amp: 0.75 }));
      const ichuL = buildIchuPatch({ count: 40, area: [9, L - 4] });
      ichuL.position.set(-8.8, 0, -L / 2);
      group.add(ichuL);
      const ichuR = buildIchuPatch({ count: 40, area: [9, L - 4] });
      ichuR.position.set(8.8, 0, -L / 2);
      group.add(ichuR);
      for (let i = 0; i < 4; i++) {
        const b = buildBoulder(randRange(rnd, 0.6, 1.6));
        this._loose(chunk, b, { x: [5.4, 12], ax: true, z: [-L + 3, -3], rot: true });
      }
      if (variant === 1) {
        const lake = this.water.makeLake({ radius: 10 });
        lake.position.set(-15.5, -0.4, -L / 2);
        group.add(lake);
      }
      if (variant === 0 && rnd() < 0.7) {
        this._addAnimal(chunk, 'alpaca', -6.8, -10 - rnd() * 16, rnd() * Math.PI * 2);
        if (rnd() < 0.5) this._addAnimal(chunk, 'alpaca', -8.4, -16 - rnd() * 10, rnd() * Math.PI * 2);
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
      const river = this.water.makeRiver({ width: 16, length: L + 2 });
      river.position.set(0, -26, -L / 2);
      group.add(river);
    }

    // Biome-entry gateway on the first chunk of every biome run gets added
    // dynamically at activation (see _activateChunk) to avoid double-building.
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
        const blockTwo = kind !== 'roller' && rnd() < 0.45 && tier.slots >= 2;
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
