// Chasqui Run, SCENERY module.
// Static prop builders for the Inca world: andenes (terraces), trapezoidal
// gateways, polygonal walls, ruins with niches, chullpa watchtowers,
// q'eswachaka rope-bridge sides, braziers, chakana monuments and instanced
// Andean flora (ichu, qantu, totora, maize, grass fringes) plus boulders.
// Landscape set: queuna and molle tree patches (one InstancedMesh each,
// vertex-colored merged templates), the tambo relay station, waterfalls and
// foam strips (small self-animating ShaderMaterials on AnimU.time), and
// megalithic walls. Instanced flora sways via applyWindCurvature.
// Architecture keeps crisp Inca edges; organic shapes (grass, thatch, tier
// tops, blossoms) get arcs, undulation and rounded silhouettes.
//
// Conventions honored here:
// - Every builder returns a Group (or Mesh) with its origin at base center.
// - Curvature comes for free through Mats.* / makeMat materials.
// - castShadow only on large silhouette pieces, receiveShadow on tops.
// - Static children get matrixAutoUpdate = false after positioning.
// - A per-call incrementing seed feeds mulberry32 so repeated props vary.
// - No update loops live here, so there are no per-frame allocations at all.

import * as THREE from 'three';
import { CONFIG } from './config.js';
import { mulberry32, TAU, lerp, clamp, smoothstep } from './util.js';
import {
  Mats, Tex, makeMat, applyCurvatureSprite, applyWindCurvature, Curve, AnimU,
} from './materials.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

// ---------------------------------------------------------------------------
// Shared constants, seed stream, temp objects
// ---------------------------------------------------------------------------

// World meters covered by one repeat of each texture, keeps texel density sane.
const STONE_TILE = 2.6;
const ASHLAR_TILE = 2.4;
const GRASS_TILE = 4.0;
const MEGA_TILE = 4.4; // huge cyclopean stones per texture repeat

// Wind sway strengths, tuned to a gentle mountain breeze. Materials sharing a
// strength stay visually attached (the bend scales identically with height),
// which is why stalks and their tassels, or stems and blossoms, pair up.
const WIND_SOFT = 0.05; // stiff qantu stems and blossoms
const WIND_TUFT = 0.08; // ichu tussocks and small grass tufts
const WIND_TALL = 0.12; // reeds, maize stalks, maize tassels
const WIND_CORD = 0.16; // hanging quipu cords (built tip-up, hung rotated)

// Qantu blossoms are magenta; CONFIG.colors has no magenta token, so this is
// the single deliberate off-palette hue in the module.
const QANTU_MAGENTA = 0xc73a6f;

// Per-call incrementing seed stream. Each builder pulls a fresh deterministic
// RNG, so two calls to the same builder produce sibling but distinct props.
let seedCursor = 0x51ce7a;
function nextRnd() {
  seedCursor = (seedCursor + 0x9e3779b9) >>> 0;
  return mulberry32(seedCursor);
}

// Reused scratch (build-time only, never per-frame).
const _dummy = new THREE.Object3D();
const _color = new THREE.Color();
const _c2 = new THREE.Color();

// ---------------------------------------------------------------------------
// Local caches (module-lifetime materials and template geometries)
// ---------------------------------------------------------------------------

const localMats = new Map();
function localMat(key, maker) {
  if (!localMats.has(key)) localMats.set(key, maker());
  return localMats.get(key);
}

const templates = new Map();
function template(key, maker) {
  if (!templates.has(key)) templates.set(key, maker());
  return templates.get(key);
}

const localTexs = new Map();
function localTex(key, maker) {
  if (!localTexs.has(key)) localTexs.set(key, maker());
  return localTexs.get(key);
}

// Wind-swayed local material with a distinct GPU program per strength.
// Needed because the default program cache key is onBeforeCompile.toString(),
// and applyWindCurvature bakes the strength through a template literal, so
// the SOURCE text (and therefore the key) is identical for every strength.
// Without this override, equal-parameter materials with different strengths
// would silently share one compiled shader and one of them would sway wrong.
function windLocalMat(key, strength, opts) {
  return localMat(key, () => {
    const m = applyWindCurvature(makeMat(opts), strength);
    m.customProgramCacheKey = () => 'sceneryWind:' + strength;
    return m;
  });
}

function matRope() {
  return localMat('rope', () =>
    makeMat({ map: Tex.thatch(), color: 0xd9bd85, roughness: 1, metalness: 0 })
  );
}
function matDarkInset() {
  // Very dark flat stone used for niches, doors, windows (reads as recess).
  return localMat('darkInset', () =>
    makeMat({ color: 0x27211a, roughness: 1, metalness: 0 })
  );
}
function matLeaf() {
  // Qantu stems and leaves; soft sway matched to the blossoms so the merged
  // plant never tears apart at the cluster joints.
  return windLocalMat('leaf', WIND_SOFT, {
    color: CONFIG.colors.grassGreen, roughness: 0.95, metalness: 0,
  });
}
function matMaize() {
  // Maize stalks want a taller, livelier sway than qantu stems, so they get
  // their own material instead of sharing matLeaf.
  return windLocalMat('maize', WIND_TALL, {
    color: CONFIG.colors.grassGreen, roughness: 0.95, metalness: 0,
  });
}
function matReedOlive() {
  return windLocalMat('reedOlive', WIND_TALL, {
    color: 0x6d7f3a, roughness: 0.95, metalness: 0,
  });
}
function matQantu() {
  return windLocalMat('qantu', WIND_SOFT, {
    color: QANTU_MAGENTA, roughness: 0.8, metalness: 0,
    emissive: 0x40101f, emissiveIntensity: 0.25,
  });
}
function matTassel() {
  return windLocalMat('tassel', WIND_TALL, {
    color: CONFIG.colors.accentYellow, roughness: 0.9, metalness: 0,
  });
}
function matIchu() {
  // Local puna-grass twin of Mats.puna() so the sway stays OFF the shared
  // ground material (Mats.puna also skins terrain; winding it would ripple
  // the ground). Texture is cached in Tex, so no duplicate canvas work.
  return windLocalMat('ichu', WIND_TUFT, {
    map: Tex.grass({ base: [132, 112, 56] }), roughness: 1, metalness: 0,
  });
}
function matQuipu() {
  return windLocalMat('quipu', WIND_CORD, {
    color: 0xd9c8a4, roughness: 0.95, metalness: 0,
  });
}
function matTreeVC() {
  return localMat('treeVC', () =>
    makeMat({ vertexColors: true, roughness: 0.92, metalness: 0 })
  );
}
function matClay() {
  return localMat('clay', () =>
    makeMat({ color: 0x9a5230, roughness: 1, metalness: 0 })
  );
}
function matMegalith() {
  return localMat('megalith', () => {
    const { map, bumpMap } = Tex.masonry({
      size: 256, cells: 3, joint: 8, seed: 29, base: [136, 127, 114],
    });
    return makeMat({ map, bumpMap, bumpScale: 2.6, roughness: 0.95, metalness: 0 });
  });
}
function matEmber() {
  return localMat('ember', () =>
    makeMat({
      color: 0x3a2418, roughness: 1, metalness: 0,
      emissive: CONFIG.colors.flameOrange, emissiveIntensity: 0.9,
    })
  );
}
function matFringe() {
  // White base; per-instance colors (golden-green range) tint each tuft.
  // Swayed: serves the grass fringe rows and the terrace lip tufts.
  return windLocalMat('fringe', WIND_TUFT, {
    color: 0xffffff, roughness: 0.95, metalness: 0,
  });
}

// Optional teardown for the module-lifetime caches above. Per-prop geometries
// (walls, tubes, boulders) belong to the returned props and travel with them.
export function disposeScenery() {
  for (const m of localMats.values()) m.dispose();
  localMats.clear();
  for (const g of templates.values()) g.dispose();
  templates.clear();
  for (const t of localTexs.values()) t.dispose();
  localTexs.clear();
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

function scaleUV(geo, su, sv) {
  const uv = geo.attributes.uv;
  if (!uv) return geo;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  }
  return geo;
}

// Box with world-scale UVs. su follows the longest horizontal face.
function boxGeo(w, h, d, tile) {
  const g = new THREE.BoxGeometry(w, h, d);
  if (tile) scaleUV(g, Math.max(w, d) / tile, h / tile);
  return g;
}

// Box tapering in x with height (Inca batter), origin at BASE center,
// y spans 0..h. topShift slides the top face sideways (for jamb lean-in).
function trapezoidBox(wBot, wTop, h, d, topShift = 0, su = 1, sv = 1) {
  const g = new THREE.BoxGeometry(1, 1, 1);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const t = y + 0.5; // 0 at base, 1 at top (box verts are exactly +-0.5)
    p.setXYZ(i, x * lerp(wBot, wTop, t) + topShift * t, t * h, z * d);
  }
  g.computeVertexNormals();
  scaleUV(g, su, sv);
  return g;
}

// Minimal non-indexed merge (BufferGeometryUtils is not vendored).
// All three.js primitives used here carry position/normal/uv.
function mergeGeoms(parts) {
  const flat = [];
  for (const p of parts) flat.push(p.index ? p.toNonIndexed() : p);
  let count = 0;
  for (const p of flat) count += p.attributes.position.count;
  const pos = new Float32Array(count * 3);
  const nor = new Float32Array(count * 3);
  const uv = new Float32Array(count * 2);
  let o3 = 0, o2 = 0;
  for (const p of flat) {
    pos.set(p.attributes.position.array, o3);
    nor.set(p.attributes.normal.array, o3);
    uv.set(p.attributes.uv.array, o2);
    o3 += p.attributes.position.count * 3;
    o2 += p.attributes.position.count * 2;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  for (const p of parts) p.dispose();
  for (const p of flat) { if (!parts.includes(p)) p.dispose(); }
  return out;
}

// Paint a per-vertex color attribute. fn(x, y, z, outColor) writes into the
// shared scratch color, called on the geometry's CURRENT positions, so paint
// before the final world translate when the color depends on local shape.
function vcolor(geo, fn) {
  const p = geo.attributes.position;
  const arr = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    fn(p.getX(i), p.getY(i), p.getZ(i), _color);
    arr[i * 3] = _color.r;
    arr[i * 3 + 1] = _color.g;
    arr[i * 3 + 2] = _color.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

// Vertex-colored sibling of mergeGeoms: merges position/normal/color (no uv,
// the tree material is untextured). Every part must be vcolor()-painted.
function mergeGeomsVC(parts) {
  const flat = [];
  for (const p of parts) flat.push(p.index ? p.toNonIndexed() : p);
  let count = 0;
  for (const p of flat) count += p.attributes.position.count;
  const pos = new Float32Array(count * 3);
  const nor = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  let o3 = 0;
  for (const p of flat) {
    pos.set(p.attributes.position.array, o3);
    nor.set(p.attributes.normal.array, o3);
    col.set(p.attributes.color.array, o3);
    o3 += p.attributes.position.count * 3;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  for (const p of parts) p.dispose();
  for (const p of flat) { if (!parts.includes(p)) p.dispose(); }
  return out;
}

function addMesh(parent, geo, mat, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}

// Freeze all static children: bake local matrices, stop auto updates.
// The root stays auto-updating so track.js can place the prop freely.
// Anything flagged userData.flicker (brazier flames) stays live.
function freeze(root) {
  root.traverse((o) => {
    if (o === root || o.userData.flicker) return;
    o.updateMatrix();
    o.matrixAutoUpdate = false;
  });
  return root;
}

// Scatter helper for instanced flora. Random position inside [w, d] centered
// at origin, random yaw, slight tilt, scale range with extra y variance.
function scatterInstances(im, count, rnd, halfW, halfD, sMin, sMax, tilt, yVar) {
  for (let i = 0; i < count; i++) {
    _dummy.position.set((rnd() * 2 - 1) * halfW, 0, (rnd() * 2 - 1) * halfD);
    _dummy.rotation.set((rnd() * 2 - 1) * tilt, rnd() * TAU, (rnd() * 2 - 1) * tilt);
    const s = sMin + rnd() * (sMax - sMin);
    _dummy.scale.set(s, s * (1 + (rnd() - 0.5) * yVar), s);
    _dummy.updateMatrix();
    im.setMatrixAt(i, _dummy.matrix);
  }
  im.instanceMatrix.needsUpdate = true;
  im.computeBoundingSphere();
  return im;
}

// ---------------------------------------------------------------------------
// Template geometries for instanced flora (built once, shared by all patches)
// ---------------------------------------------------------------------------

// Single grass blade with a gentle outward arc: open thin cone, tip bent
// along +x by bend * y^2, then leaned and yawed. Base sits just below grade.
function bladeGeo(r, h, lean, bend, yaw) {
  const c = new THREE.ConeGeometry(r, h, 4, 3, true);
  c.translate(0, h / 2 - 0.03, 0);
  const p = c.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const y = Math.max(0, p.getY(i));
    p.setX(i, p.getX(i) + bend * y * y);
  }
  c.rotateZ(-lean);
  c.rotateY(yaw);
  c.computeVertexNormals();
  return c;
}

function ichuTuftGeo() {
  return template('ichu', () => {
    // Fuller tussock: one near-vertical heart blade plus six arcing outward.
    const parts = [bladeGeo(0.11, 1.05, 0.06, 0.16, 0)];
    for (let i = 0; i < 6; i++) {
      const h = 0.72 + (i % 3) * 0.15;
      parts.push(bladeGeo(
        0.09, h,
        0.18 + (i % 4) * 0.08,
        0.45 + (i % 3) * 0.2,
        i * (TAU / 6) + 0.4
      ));
    }
    return mergeGeoms(parts);
  });
}

// Small roadside tuft: three short arcing blades (fringe + terrace lips).
function fringeTuftGeo() {
  return template('fringeTuft', () => {
    const parts = [];
    for (let i = 0; i < 3; i++) {
      parts.push(bladeGeo(0.045, 0.24 + i * 0.06, 0.24 + i * 0.14, 1.1, i * 2.09 + 0.5));
    }
    return mergeGeoms(parts);
  });
}

function flowerStemGeo() {
  return template('flowerStem', () => {
    const stem = new THREE.CylinderGeometry(0.012, 0.02, 0.55, 4);
    stem.translate(0, 0.275, 0);
    // Two thin side branches carrying the extra blossom clusters.
    const branchA = new THREE.CylinderGeometry(0.009, 0.014, 0.3, 4);
    branchA.translate(0, 0.15, 0);
    branchA.rotateZ(-0.5);
    branchA.translate(0, 0.3, 0);
    const branchB = new THREE.CylinderGeometry(0.009, 0.014, 0.3, 4);
    branchB.translate(0, 0.15, 0);
    branchB.rotateZ(0.5);
    branchB.rotateY(2.2);
    branchB.translate(0, 0.3, 0);
    const parts = [stem, branchA, branchB];
    for (let i = 0; i < 2; i++) {
      const leaf = new THREE.ConeGeometry(0.05, 0.3, 4);
      leaf.scale(1, 1, 0.3);
      leaf.translate(0, 0.15, 0);
      leaf.rotateZ(1.0);
      leaf.rotateY(i * 2.6 + 0.4);
      leaf.translate(0, 0.1 + i * 0.14, 0);
      parts.push(leaf);
    }
    return mergeGeoms(parts);
  });
}

function flowerBloomGeo() {
  return template('flowerBloom', () => {
    // Qantu: three blossom clusters (stem tip + both branch tips), each a
    // trio of tubular blossoms hanging down-out around a bud.
    const parts = [];
    const addCluster = (x, y, z, s, yaw0) => {
      for (let i = 0; i < 3; i++) {
        const c = new THREE.ConeGeometry(0.05 * s, 0.18 * s, 5);
        c.translate(0, 0.09 * s, 0); // pivot at the flower base
        c.rotateZ(2.55);             // hang the tube down-out
        c.rotateY(yaw0 + i * 2.09);
        c.translate(x, y, z);
        parts.push(c);
      }
      const bud = new THREE.SphereGeometry(0.05 * s, 6, 4);
      bud.translate(x, y, z);
      parts.push(bud);
    };
    addCluster(0, 0.56, 0, 1, 0);
    addCluster(0.14, 0.54, 0, 0.78, 1.1);     // branchA tip
    addCluster(0.085, 0.55, 0.115, 0.7, 2.4); // branchB tip
    return mergeGeoms(parts);
  });
}

function reedGeo() {
  return template('reed', () => {
    const stalk = new THREE.CylinderGeometry(0.014, 0.035, 2.2, 4);
    stalk.translate(0, 1.1, 0);
    const head = new THREE.ConeGeometry(0.045, 0.4, 4);
    head.translate(0, 2.4, 0);
    // Totora leaf blades arcing off the base.
    const leafA = bladeGeo(0.04, 1.3, 0.28, 0.2, 0.9);
    const leafB = bladeGeo(0.036, 1.05, 0.4, 0.28, 3.6);
    return mergeGeoms([stalk, head, leafA, leafB]);
  });
}

function maizeStalkGeo() {
  return template('maizeStalk', () => {
    const stalk = new THREE.CylinderGeometry(0.03, 0.05, 1.7, 5);
    stalk.translate(0, 0.85, 0);
    const parts = [stalk];
    for (let i = 0; i < 4; i++) {
      const leaf = new THREE.ConeGeometry(0.06, 0.6, 4);
      leaf.scale(1, 1, 0.28);
      leaf.translate(0, 0.3, 0);     // pivot at leaf base
      leaf.rotateZ(1.2 + i * 0.13);  // arc out and droop
      leaf.rotateY(i * 1.7 + 0.6);
      leaf.translate(0, 0.5 + i * 0.28, 0);
      parts.push(leaf);
    }
    return mergeGeoms(parts);
  });
}

function maizeTasselGeo() {
  return template('maizeTassel', () => {
    const t = new THREE.ConeGeometry(0.035, 0.4, 5);
    t.translate(0, 1.9, 0);
    return t;
  });
}

function cordGeo() {
  // Unit-height cylinder centered at origin, scaled per instance.
  return template('cord', () => new THREE.CylinderGeometry(0.018, 0.018, 1, 5));
}

// Queuna (Polylepis): twisted papery red-brown trunk of stacked bent
// segments plus a low fork, crowned by rounded deep-green blobs with golden
// tips. ONE merged vertex-colored geometry; fixed seed so the cached
// template never depends on builder call order. Height about 3.0.
function queunaTreeGeo() {
  return template('queuna', () => {
    const rnd = mulberry32(0x517a1);
    const parts = [];
    const bark = (x, y, z, c) => {
      c.setHex(0x9a5b3f);
      _c2.setHex(0xc4805a); // peeling papery highlight
      c.lerp(_c2, rnd() * 0.4);
      c.multiplyScalar(0.72 + rnd() * 0.36);
    };
    let bx = 0, by = 0, bz = 0, ax = 0, az = 0;
    const lens = [0.85, 0.7, 0.55];
    const rads = [0.17, 0.12, 0.085, 0.05];
    for (let i = 0; i < lens.length; i++) {
      const len = lens[i];
      ax = clamp(ax + (rnd() - 0.5) * 0.6, -0.38, 0.38);
      az = clamp(az + (rnd() - 0.5) * 0.6, -0.38, 0.38);
      const seg = new THREE.CylinderGeometry(rads[i + 1], rads[i], len, 6, 1, true);
      seg.translate(0, len / 2, 0);
      seg.rotateX(ax);
      seg.rotateZ(az);
      vcolor(seg, bark);
      seg.translate(bx, by, bz);
      parts.push(seg);
      // Top of this segment: (0, len, 0) through rotateX then rotateZ.
      bx += -len * Math.cos(ax) * Math.sin(az);
      by += len * Math.cos(ax) * Math.cos(az);
      bz += len * Math.sin(ax);
    }
    // Low fork stem carrying its own small crown blob.
    const fLen = 1.05;
    const fTilt = 0.55 + rnd() * 0.25;
    const fYaw = rnd() * TAU;
    const fork = new THREE.CylinderGeometry(0.045, 0.09, fLen, 5, 1, true);
    fork.translate(0, fLen / 2, 0);
    fork.rotateZ(fTilt);
    fork.rotateY(fYaw);
    vcolor(fork, bark);
    fork.translate(0, lens[0] * 0.9, 0);
    parts.push(fork);
    const fx = -fLen * Math.sin(fTilt) * Math.cos(fYaw);
    const fz = fLen * Math.sin(fTilt) * Math.sin(fYaw);
    const fy = lens[0] * 0.9 + fLen * Math.cos(fTilt);
    // Rounded canopy blobs: deep green shading to golden tips near the top.
    const crown = (cx, cy, cz, r) => {
      const blob = new THREE.SphereGeometry(r, 7, 5);
      blob.scale(1, 0.78, 1);
      vcolor(blob, (x, y, z, c) => {
        const t = smoothstep(0.05, 0.9, (y / (r * 0.78) + 1) * 0.5);
        c.setHex(0x2f5d33);
        _c2.setHex(0x9b8a3d);
        c.lerp(_c2, t * (0.35 + rnd() * 0.3));
        c.multiplyScalar(0.8 + rnd() * 0.3);
      });
      blob.translate(cx, cy, cz);
      parts.push(blob);
    };
    crown(bx, by + 0.4, bz, 0.62);
    crown(bx + 0.5, by + 0.15, bz + 0.1, 0.5);
    crown(bx - 0.42, by + 0.2, bz - 0.28, 0.46);
    crown(fx, fy + 0.1, fz, 0.42);
    return mergeGeomsVC(parts);
  });
}

// Molle (Peruvian pepper): single gnarled trunk, wide drooping soft canopy
// with tiny red berry specks baked into the vertex colors. Height about 2.2.
function molleTreeGeo() {
  return template('molle', () => {
    const rnd = mulberry32(0x3011e5);
    const parts = [];
    const bark = (x, y, z, c) => {
      c.setHex(0x7a5a44);
      c.multiplyScalar(0.75 + rnd() * 0.35);
    };
    let bx = 0, by = 0, bz = 0, ax = 0, az = 0;
    const lens = [0.8, 0.65];
    const rads = [0.15, 0.1, 0.06];
    for (let i = 0; i < lens.length; i++) {
      const len = lens[i];
      ax = clamp(ax + (rnd() - 0.5) * 0.45, -0.3, 0.3);
      az = clamp(az + (rnd() - 0.5) * 0.45, -0.3, 0.3);
      const seg = new THREE.CylinderGeometry(rads[i + 1], rads[i], len, 6, 1, true);
      seg.translate(0, len / 2, 0);
      seg.rotateX(ax);
      seg.rotateZ(az);
      vcolor(seg, bark);
      seg.translate(bx, by, bz);
      parts.push(seg);
      bx += -len * Math.cos(ax) * Math.sin(az);
      by += len * Math.cos(ax) * Math.cos(az);
      bz += len * Math.sin(ax);
    }
    const crown = (cx, cy, cz, r) => {
      const blob = new THREE.SphereGeometry(r, 8, 5);
      blob.scale(1, 0.55, 1); // squashed and drooping
      vcolor(blob, (x, y, z, c) => {
        const tn = y / (r * 0.55); // -1 lower rim .. 1 top
        if (rnd() < 0.06 && tn < 0.45) {
          c.setHex(0xa8332a); // pepper berry speck
          c.multiplyScalar(0.9 + rnd() * 0.3);
          return;
        }
        c.setHex(0x5f7c36);
        c.multiplyScalar((0.78 + rnd() * 0.3) * (0.86 + 0.14 * smoothstep(-1, 0.6, tn)));
      });
      blob.translate(cx, cy, cz);
      parts.push(blob);
    };
    crown(bx, by + 0.32, bz, 0.85);
    crown(bx + 0.55, by + 0.12, bz + 0.2, 0.62);
    crown(bx - 0.5, by + 0.18, bz - 0.25, 0.58);
    return mergeGeomsVC(parts);
  });
}

// Irregular rock geometry, base at y = 0, seam-consistent vertex jitter.
function boulderGeometry(rnd, scale) {
  const geo = new THREE.IcosahedronGeometry(0.62 * scale, 1);
  const pos = geo.attributes.position;
  const seen = new Map(); // same source vertex -> same displacement (no cracks)
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const key =
      ((Math.round(x * 997) * 31 + Math.round(y * 997)) * 31 + Math.round(z * 997)) | 0;
    let f = seen.get(key);
    if (f === undefined) { f = 0.78 + rnd() * 0.5; seen.set(key, f); }
    pos.setXYZ(i, x * f, y * f * 0.82, z * f);
  }
  geo.rotateY(rnd() * TAU);
  geo.computeVertexNormals(); // non-indexed icosahedron -> faceted rock look
  geo.computeBoundingBox();
  geo.translate(0, -geo.boundingBox.min.y - 0.06 * scale, 0); // slightly buried
  return geo;
}

// ---------------------------------------------------------------------------
// buildTerraces: the iconic andenes
// ---------------------------------------------------------------------------

export function buildTerraces({ side = 1, length = CONFIG.chunkLen, tiers = 4 } = {}) {
  const rnd = nextRnd();
  const g = new THREE.Group();
  const ashlar = Mats.ashlar();
  const grass = Mats.grass();
  const dark = Mats.stoneDark();
  const earth = Mats.earth();

  let topY = 0;
  let inner = 4.6; // first wall face, safely outside the run corridor
  const tierTops = [];
  const fringeMats = [];

  for (let i = 0; i < tiers; i++) {
    const h = 0.95 + rnd() * 0.45;
    const depth = 2.5 + rnd() * 1.5;
    const len = Math.max(6, length * (1 - i * 0.045) - rnd() * 2.4);
    const zOff = (rnd() - 0.5) * 2.2;
    const wx = inner + (rnd() - 0.5) * 0.24; // per-tier front-line stagger
    const yaw = (rnd() - 0.5) * 0.024;       // tiny drift breaks the ruler line

    // Retaining wall, sunk below grade, slight inward batter for the classic
    // stepped Inca silhouette.
    const wall = addMesh(
      g, boxGeo(0.55, h + 0.5, len, ASHLAR_TILE), ashlar,
      side * (wx + 0.27), topY + (h + 0.5) / 2 - 0.5, zOff
    );
    wall.rotation.z = -side * 0.06;
    wall.rotation.y = yaw;
    wall.castShadow = true;

    // Darker coping course riding the wall crest, edges softly rounded.
    const coping = addMesh(
      g,
      scaleUV(new RoundedBoxGeometry(0.72, 0.13, len + 0.1, 1, 0.04), (len + 0.1) / STONE_TILE, 0.1),
      dark, side * (wx + 0.24), topY + h + 0.065, zOff
    );
    coping.rotation.y = yaw;
    coping.receiveShadow = true;

    // Grass tier top: gently undulating plane, front edge tucked into the
    // wall body, back edge under the next tier's wall.
    const topW = depth + 0.6;
    const topGeo = new THREE.PlaneGeometry(topW, len, 3, 4);
    topGeo.rotateX(-Math.PI / 2);
    {
      const p = topGeo.attributes.position;
      for (let v = 0; v < p.count; v++) p.setY(v, (rnd() * 2 - 1) * 0.06);
      topGeo.computeVertexNormals();
    }
    scaleUV(topGeo, topW / GRASS_TILE, len / GRASS_TILE);
    const top = addMesh(
      g, topGeo, grass,
      side * (wx + 0.3 + depth / 2), topY + h + 0.01, zOff
    );
    top.receiveShadow = true;

    // Soil bed under the grass: seals tier ends and shows as dark earth in
    // the undulation dips instead of open sky.
    addMesh(
      g, boxGeo(topW - 0.1, 0.22, len - 0.06, GRASS_TILE), earth,
      side * (wx + 0.3 + depth / 2), topY + h - 0.17, zOff
    );

    // Grass tufts spilling over the wall lip (gathered into one InstancedMesh).
    const nF = Math.max(3, Math.floor(len / 1.6));
    for (let k = 0; k < nF; k++) {
      if (rnd() < 0.18) continue;
      const t = (k + 0.5) / nF;
      _dummy.position.set(
        side * (wx + 0.3 + (rnd() - 0.5) * 0.14),
        topY + h + 0.08,
        zOff - len / 2 + t * len + (rnd() - 0.5) * 0.9
      );
      // rotation.z leans the tuft out over the coping toward the track;
      // small x/y jitter varies the hang without flipping that direction.
      _dummy.rotation.set((rnd() - 0.5) * 0.2, (rnd() - 0.5) * 0.8, side * (0.35 + rnd() * 0.3));
      const s = 0.8 + rnd() * 0.5;
      _dummy.scale.set(s, s * (0.85 + rnd() * 0.4), s);
      _dummy.updateMatrix();
      fringeMats.push(_dummy.matrix.clone());
    }

    tierTops.push({
      x: side * (wx + 0.6 + depth / 2),
      y: topY + h,
      halfW: depth * 0.3,
      halfL: len * 0.4,
      z: zOff,
    });
    topY += h;
    inner += depth;
  }

  if (fringeMats.length) {
    const fim = new THREE.InstancedMesh(fringeTuftGeo(), matFringe(), fringeMats.length);
    for (let i = 0; i < fringeMats.length; i++) {
      fim.setMatrixAt(i, fringeMats[i]);
      _color.setHex(0x6f9440);
      _color.offsetHSL((rnd() - 0.5) * 0.03, 0, (rnd() - 0.5) * 0.1);
      fim.setColorAt(i, _color);
    }
    fim.instanceMatrix.needsUpdate = true;
    if (fim.instanceColor) fim.instanceColor.needsUpdate = true;
    fim.computeBoundingSphere();
    g.add(fim);
  }

  // Occasional maize tufts growing on the tiers (one InstancedMesh).
  const mats4 = [];
  for (const t of tierTops) {
    const n = (rnd() * 2.4) | 0; // 0..2 tufts per tier
    for (let k = 0; k < n; k++) {
      _dummy.position.set(
        t.x + (rnd() * 2 - 1) * t.halfW,
        t.y,
        t.z + (rnd() * 2 - 1) * t.halfL
      );
      _dummy.rotation.set(0, rnd() * TAU, 0);
      const s = 0.5 + rnd() * 0.3;
      _dummy.scale.set(s, s, s);
      _dummy.updateMatrix();
      mats4.push(_dummy.matrix.clone());
    }
  }
  if (mats4.length) {
    const im = new THREE.InstancedMesh(maizeStalkGeo(), matMaize(), mats4.length);
    for (let i = 0; i < mats4.length; i++) im.setMatrixAt(i, mats4[i]);
    im.instanceMatrix.needsUpdate = true;
    im.computeBoundingSphere();
    g.add(im);
  }
  return freeze(g);
}

// ---------------------------------------------------------------------------
// buildStoneWall: freestanding polygonal masonry wall along z
// ---------------------------------------------------------------------------

export function buildStoneWall({ length = 8, height = 2.2 } = {}) {
  const rnd = nextRnd();
  const g = new THREE.Group();
  const stone = Mats.stone();

  const wall = new THREE.Mesh(
    trapezoidBox(0.62, 0.45, height, length, 0, length / STONE_TILE, height / STONE_TILE),
    stone
  );
  wall.castShadow = true;
  g.add(wall);

  const coping = addMesh(
    g, boxGeo(0.72, 0.15, length + 0.12, STONE_TILE), Mats.stoneDark(),
    0, height + 0.075, 0
  );
  coping.receiveShadow = true;

  // Chunky end posts give the wall a deliberate, finished rhythm.
  for (let s = -1; s <= 1; s += 2) {
    const ph = height + 0.25 + rnd() * 0.18;
    const post = new THREE.Mesh(
      trapezoidBox(0.92, 0.72, ph, 0.92, 0, 0.4, ph / STONE_TILE),
      stone
    );
    post.position.set(0, 0, s * (length / 2));
    post.castShadow = true;
    g.add(post);
  }
  return freeze(g);
}

// ---------------------------------------------------------------------------
// buildGateway: trapezoidal portal spanning the whole track
// ---------------------------------------------------------------------------
// Clearance contract: opening stays clear for x in [-3.4, 3.4] below y 3.2.
// Inner faces: half-width 4.1 at grade narrowing to 3.45 under the lintel at
// y 3.9, which leaves 3.57 of half-clearance at y 3.2.

export function buildGateway() {
  const g = new THREE.Group();
  const stone = Mats.stone();
  const dark = Mats.stoneDark();

  const H = 3.9;        // underside of the lintel
  const innerB = 4.1;   // half opening at the base
  const innerT = 3.45;  // half opening at the top
  const w = 1.7;        // jamb thickness in x

  for (let s = -1; s <= 1; s += 2) {
    const cB = innerB + w / 2;
    const cT = innerT + w / 2;
    const jamb = new THREE.Mesh(
      trapezoidBox(w, w, H, 1.3, s * (cT - cB), w / STONE_TILE, H / STONE_TILE),
      stone
    );
    jamb.position.set(s * cB, 0, 0);
    jamb.castShadow = true;
    g.add(jamb);

    // Protruding plinth course at the jamb foot.
    const plinth = addMesh(g, boxGeo(2.1, 0.55, 1.7, STONE_TILE), stone, s * (innerB + 0.95), 0.275, 0);
    plinth.castShadow = true;
    plinth.receiveShadow = true;
  }

  // Massive single lintel stone, slightly deeper than the jambs.
  const lintel = addMesh(g, boxGeo(10.7, 0.9, 1.6, STONE_TILE), dark, 0, H + 0.45, 0);
  lintel.castShadow = true;
  lintel.receiveShadow = true;

  // Small stepped crown over the lintel center.
  const c1 = addMesh(g, boxGeo(3.0, 0.4, 1.2, STONE_TILE), stone, 0, H + 1.1, 0);
  c1.castShadow = true;
  const c2 = addMesh(g, boxGeo(1.7, 0.38, 1.0, STONE_TILE), stone, 0, H + 1.49, 0);
  c2.castShadow = true;
  c2.receiveShadow = true;

  return freeze(g);
}

// ---------------------------------------------------------------------------
// buildRuin: broken walls with trapezoidal niches
// ---------------------------------------------------------------------------

export function buildRuin() {
  const rnd = nextRnd();
  const g = new THREE.Group();
  const stone = Mats.stone();
  const dark = Mats.stoneDark();
  const inset = matDarkInset();

  // Two broken courses of the main wall (runs along x, faces +z).
  const h1 = 2.0 + rnd() * 0.5;
  const h2 = 1.05 + rnd() * 0.4;
  const wallA = addMesh(g, boxGeo(2.6, h1, 0.55, STONE_TILE), stone, -0.9, h1 / 2, 0);
  wallA.rotation.y = (rnd() - 0.5) * 0.05;
  wallA.castShadow = true;
  const wallB = addMesh(g, boxGeo(1.9, h2, 0.55, STONE_TILE), stone, 1.35, h2 / 2, 0.06);
  wallB.rotation.y = (rnd() - 0.5) * 0.07;
  wallB.castShadow = true;

  // Side wall closing an L corner.
  const h3 = 1.5 + rnd() * 0.4;
  const wallC = addMesh(g, boxGeo(0.55, h3, 2.6, STONE_TILE), stone, -2.1, h3 / 2, -1.25);
  wallC.rotation.y = (rnd() - 0.5) * 0.05;
  wallC.castShadow = true;

  // Trapezoidal niches as children of their wall so they track the jitter.
  // The dark panel sits a touch proud of the face and reads as a recess.
  const nicheA = new THREE.Mesh(trapezoidBox(0.62, 0.46, 0.85, 0.1, 0, 0.25, 0.35), inset);
  nicheA.position.set(0.25, -h1 / 2 + 0.7, 0.24);
  wallA.add(nicheA);
  const lintelA = new THREE.Mesh(boxGeo(0.85, 0.15, 0.2, STONE_TILE), dark);
  lintelA.position.set(0.25, -h1 / 2 + 1.62, 0.24);
  wallA.add(lintelA);

  const nicheB = new THREE.Mesh(trapezoidBox(0.5, 0.38, 0.6, 0.1, 0, 0.2, 0.25), inset);
  nicheB.position.set(-0.3, -h2 / 2 + 0.3, 0.24);
  wallB.add(nicheB);
  const lintelB = new THREE.Mesh(boxGeo(0.7, 0.13, 0.2, STONE_TILE), dark);
  lintelB.position.set(-0.3, -h2 / 2 + 0.96, 0.24);
  wallB.add(lintelB);

  // Tumbled rubble at the foot.
  const r1 = new THREE.Mesh(boulderGeometry(rnd, 0.5), Mats.stoneDark());
  r1.position.set(0.4, 0, 0.95);
  g.add(r1);
  const r2 = new THREE.Mesh(boulderGeometry(rnd, 0.38), Mats.stoneDark());
  r2.position.set(-1.7, 0, 0.7);
  g.add(r2);

  return freeze(g);
}

// ---------------------------------------------------------------------------
// buildWatchtower: round chullpa-like tower with thatch cone roof
// ---------------------------------------------------------------------------

export function buildWatchtower() {
  const g = new THREE.Group();
  const stone = Mats.stone();
  const dark = Mats.stoneDark();

  const body = new THREE.Mesh(
    scaleUV(new THREE.CylinderGeometry(1.55, 1.95, 4.0, 14, 1), 4.2, 4.0 / STONE_TILE),
    stone
  );
  body.position.y = 2.0;
  body.castShadow = true;
  g.add(body);

  // Corbel ring under the eaves.
  const rim = new THREE.Mesh(
    scaleUV(new THREE.CylinderGeometry(1.85, 1.58, 0.35, 14, 1), 4.2, 0.3),
    dark
  );
  rim.position.y = 4.15;
  rim.receiveShadow = true;
  g.add(rim);

  // Thatch roof: lathe with a gently convex profile (bulging shoulders,
  // soft apex) instead of a hard straight cone. Same footprint and apex
  // height as the old cone (base y 4.32, apex y 6.22).
  const roofPts = [];
  for (let i = 0; i <= 6; i++) {
    const t = i / 6;
    roofPts.push(new THREE.Vector2(2.35 * Math.pow(1 - t, 0.72), t * 1.9));
  }
  const roof = new THREE.Mesh(
    scaleUV(new THREE.LatheGeometry(roofPts, 14), 3, 1),
    Mats.thatch()
  );
  roof.position.y = 4.32;
  roof.castShadow = true;
  g.add(roof);
  // Underside disc seals the eaves (the cone's base cap used to do this).
  const soffit = new THREE.Mesh(
    scaleUV(new THREE.CircleGeometry(2.33, 14), 2, 2),
    Mats.thatch()
  );
  soffit.rotation.x = Math.PI / 2; // normal faces down
  soffit.position.y = 4.33;
  g.add(soffit);

  // Trapezoidal doorway and window (dark insets), facing +z toward the track.
  const door = new THREE.Mesh(trapezoidBox(0.78, 0.58, 1.4, 0.15, 0, 0.3, 0.55), matDarkInset());
  door.position.set(0, 0.02, 1.79);
  g.add(door);
  const doorLintel = addMesh(g, boxGeo(1.05, 0.22, 0.32), dark, 0, 1.5, 1.78);
  doorLintel.castShadow = true;
  const win = new THREE.Mesh(trapezoidBox(0.42, 0.3, 0.55, 0.12, 0, 0.16, 0.22), matDarkInset());
  win.position.set(0, 2.55, 1.62);
  g.add(win);

  return freeze(g);
}

// ---------------------------------------------------------------------------
// buildChakanaMonument: stepped Andean cross on a plinth
// ---------------------------------------------------------------------------

export function buildChakanaMonument() {
  const g = new THREE.Group();
  const ashlar = Mats.ashlar();
  const stone = Mats.stone();

  const p1 = addMesh(g, boxGeo(2.6, 0.45, 1.5, ASHLAR_TILE), ashlar, 0, 0.225, 0);
  p1.castShadow = true;
  p1.receiveShadow = true;
  const p2 = addMesh(g, boxGeo(2.0, 0.4, 1.1, ASHLAR_TILE), ashlar, 0, 0.65, 0);
  p2.receiveShadow = true;

  // Three overlapped slabs make the stepped-cross silhouette.
  const cy = 1.9;
  const s1 = addMesh(g, boxGeo(2.1, 0.62, 0.45, STONE_TILE), stone, 0, cy, 0);
  s1.castShadow = true;
  const s2 = addMesh(g, boxGeo(1.5, 1.4, 0.45, STONE_TILE), stone, 0, cy, 0);
  s2.castShadow = true;
  const s3 = addMesh(g, boxGeo(0.78, 2.0, 0.45, STONE_TILE), stone, 0, cy, 0);
  s3.castShadow = true;

  // Gold sun disc through the center, proud of both faces.
  const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.52, 14), Mats.gold());
  disc.rotation.x = Math.PI / 2;
  disc.position.y = cy;
  g.add(disc);

  return freeze(g);
}

// ---------------------------------------------------------------------------
// buildRopeBridgeSides: q'eswachaka woven bridge sides (no deck)
// ---------------------------------------------------------------------------

function cableMesh(x, endY, sag, length, radius, segs, mat) {
  const pts = [];
  const n = 9;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    pts.push(new THREE.Vector3(
      x,
      endY - sag * 4 * t * (1 - t), // parabolic catenary approximation
      -length / 2 + t * length
    ));
  }
  const geo = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), segs, radius, 6, false);
  scaleUV(geo, length / 1.1, 1);
  return new THREE.Mesh(geo, mat);
}

export function buildRopeBridgeSides(length = CONFIG.chunkLen) {
  const g = new THREE.Group();
  const rope = matRope();
  const stone = Mats.stone();

  const sag = clamp(length * 0.012, 0.2, 1.2);
  const railY = 1.28;
  const deckY = 0.14;
  const segs = Math.max(16, Math.min(48, Math.round(length / 1.4)));

  for (let s = -1; s <= 1; s += 2) {
    const x = s * 3.55; // outside the x [-3.2, 3.2] corridor
    g.add(cableMesh(x, railY, sag * 1.05, length, 0.075, segs, rope)); // handrail
    g.add(cableMesh(x, deckY, sag, length, 0.14, segs, rope));        // main cable

    // Chunky stone anchor posts at both ends.
    for (let e = -1; e <= 1; e += 2) {
      const post = new THREE.Mesh(trapezoidBox(1.0, 0.75, 1.6, 1.0, 0, 0.45, 0.65), stone);
      post.position.set(s * 3.95, 0, e * (length / 2 - 0.55));
      post.castShadow = true;
      g.add(post);
    }
  }

  // Vertical cords every ~1.2 m tying handrail to the deck cable.
  const per = Math.max(2, Math.floor(length / 1.2) - 1);
  const im = new THREE.InstancedMesh(cordGeo(), rope, per * 2);
  let idx = 0;
  for (let s = -1; s <= 1; s += 2) {
    for (let i = 1; i <= per; i++) {
      const t = i / (per + 1);
      const bow = 4 * t * (1 - t);
      const yTop = railY - sag * 1.05 * bow;
      const yBot = deckY - sag * bow + 0.02;
      _dummy.position.set(s * 3.55, (yTop + yBot) / 2, -length / 2 + t * length);
      _dummy.rotation.set(0, 0, 0);
      _dummy.scale.set(1, Math.max(0.2, yTop - yBot), 1);
      _dummy.updateMatrix();
      im.setMatrixAt(idx++, _dummy.matrix);
    }
  }
  im.instanceMatrix.needsUpdate = true;
  im.computeBoundingSphere();
  g.add(im);

  return freeze(g);
}

// ---------------------------------------------------------------------------
// buildBrazier: stone bowl with a live Sprite flame
// ---------------------------------------------------------------------------

export function buildBrazier() {
  const g = new THREE.Group();
  const dark = Mats.stoneDark();

  // Worn slab base (soft edges) under a smoother turned bowl.
  const slab = addMesh(
    g, scaleUV(new RoundedBoxGeometry(0.9, 0.18, 0.9, 1, 0.04), 0.35, 0.07),
    dark, 0, 0.09, 0
  );
  slab.receiveShadow = true;
  addMesh(g, new THREE.CylinderGeometry(0.16, 0.22, 0.45, 12), dark, 0, 0.405, 0);
  const bowl = addMesh(g, new THREE.CylinderGeometry(0.52, 0.24, 0.4, 16), dark, 0, 0.83, 0);
  bowl.castShadow = true;
  // Glowing coal bed just under the rim.
  addMesh(g, new THREE.CylinderGeometry(0.42, 0.42, 0.1, 16), matEmber(), 0, 0.99, 0);

  // Sprite flame. Material is per-brazier so track.js can animate each flame
  // (opacity/scale) independently; the texture itself is shared. It gets the
  // shared curvature bend or it would float above the bent bowl at distance.
  const flame = new THREE.Sprite(applyCurvatureSprite(new THREE.SpriteMaterial({
    map: Tex.flame(),
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  })));
  flame.position.set(0, 1.34, 0);
  flame.scale.set(0.8, 1.15, 1);
  flame.userData.flicker = true;
  flame.userData.baseScale = { x: 0.8, y: 1.15 }; // handy for the animator
  g.add(flame);

  return freeze(g); // freeze skips the flame (userData.flicker)
}

// ---------------------------------------------------------------------------
// Instanced flora patches
// ---------------------------------------------------------------------------

export function buildIchuPatch({ count = 60, area = [10, 30] } = {}) {
  const rnd = nextRnd();
  const g = new THREE.Group();
  const im = new THREE.InstancedMesh(ichuTuftGeo(), matIchu(), count);
  scatterInstances(im, count, rnd, area[0] / 2, area[1] / 2, 0.65, 1.35, 0.16, 0.4);
  g.add(im);
  return freeze(g);
}

export function buildFlowers({ count = 24, area = [8, 30] } = {}) {
  const rnd = nextRnd();
  const g = new THREE.Group();
  const stems = new THREE.InstancedMesh(flowerStemGeo(), matLeaf(), count);
  const blooms = new THREE.InstancedMesh(flowerBloomGeo(), matQantu(), count);
  for (let i = 0; i < count; i++) {
    _dummy.position.set((rnd() * 2 - 1) * area[0] / 2, 0, (rnd() * 2 - 1) * area[1] / 2);
    _dummy.rotation.set((rnd() * 2 - 1) * 0.1, rnd() * TAU, (rnd() * 2 - 1) * 0.1);
    const s = 0.75 + rnd() * 0.55;
    _dummy.scale.set(s, s, s);
    _dummy.updateMatrix();
    stems.setMatrixAt(i, _dummy.matrix);
    blooms.setMatrixAt(i, _dummy.matrix);
  }
  stems.instanceMatrix.needsUpdate = true;
  blooms.instanceMatrix.needsUpdate = true;
  stems.computeBoundingSphere();
  blooms.computeBoundingSphere();
  g.add(stems);
  g.add(blooms);
  return freeze(g);
}

export function buildReeds({ count = 20, area = [4, 30] } = {}) {
  const rnd = nextRnd();
  const g = new THREE.Group();
  const im = new THREE.InstancedMesh(reedGeo(), matReedOlive(), count);
  scatterInstances(im, count, rnd, area[0] / 2, area[1] / 2, 0.7, 1.2, 0.1, 0.45);
  g.add(im);
  return freeze(g);
}

export function buildMaizePatch({ count = 20, area = [6, 20] } = {}) {
  const rnd = nextRnd();
  const g = new THREE.Group();
  const stalks = new THREE.InstancedMesh(maizeStalkGeo(), matMaize(), count);
  const tassels = new THREE.InstancedMesh(maizeTasselGeo(), matTassel(), count);
  for (let i = 0; i < count; i++) {
    _dummy.position.set((rnd() * 2 - 1) * area[0] / 2, 0, (rnd() * 2 - 1) * area[1] / 2);
    _dummy.rotation.set((rnd() * 2 - 1) * 0.07, rnd() * TAU, (rnd() * 2 - 1) * 0.07);
    const s = 0.8 + rnd() * 0.45;
    _dummy.scale.set(s, s * (0.9 + rnd() * 0.3), s);
    _dummy.updateMatrix();
    stalks.setMatrixAt(i, _dummy.matrix);
    tassels.setMatrixAt(i, _dummy.matrix);
  }
  stalks.instanceMatrix.needsUpdate = true;
  tassels.instanceMatrix.needsUpdate = true;
  stalks.computeBoundingSphere();
  tassels.computeBoundingSphere();
  g.add(stalks);
  g.add(tassels);
  return freeze(g);
}

// ---------------------------------------------------------------------------
// buildGrassFringe: soft seam where the gravel path meets terrain
// ---------------------------------------------------------------------------
// One InstancedMesh row of small golden-green tufts scattered inside a
// [width x length] band centered at the origin, +Z along the length.
// Random lean, scale and hue per tuft. ~70 instances at length 36.

export function buildGrassFringe({ length = 36, width = 1.2 } = {}) {
  const rnd = nextRnd();
  const g = new THREE.Group();
  const count = Math.max(10, Math.round(length * (70 / 36)));
  const im = new THREE.InstancedMesh(fringeTuftGeo(), matFringe(), count);
  for (let i = 0; i < count; i++) {
    _dummy.position.set(
      (rnd() * 2 - 1) * width / 2,
      0,
      (rnd() * 2 - 1) * length / 2
    );
    _dummy.rotation.set((rnd() - 0.5) * 0.5, rnd() * TAU, (rnd() - 0.5) * 0.5);
    const s = 0.7 + rnd() * 0.7;
    _dummy.scale.set(s, s * (0.8 + rnd() * 0.5), s);
    _dummy.updateMatrix();
    im.setMatrixAt(i, _dummy.matrix);
    // Golden-green drift between valley grass and puna gold.
    _color.setHex(0x8a9a48);
    _color.offsetHSL((rnd() - 0.5) * 0.05, (rnd() - 0.5) * 0.12, (rnd() - 0.5) * 0.12);
    im.setColorAt(i, _color);
  }
  im.instanceMatrix.needsUpdate = true;
  if (im.instanceColor) im.instanceColor.needsUpdate = true;
  im.computeBoundingSphere();
  g.add(im);
  return freeze(g);
}

// ---------------------------------------------------------------------------
// buildBoulder: irregular faceted rock
// ---------------------------------------------------------------------------

export function buildBoulder(scale = 1) {
  const rnd = nextRnd();
  const m = new THREE.Mesh(boulderGeometry(rnd, scale), Mats.stoneDark());
  m.castShadow = scale >= 0.7;
  return m; // root mesh stays auto-updating for track.js placement
}

// ---------------------------------------------------------------------------
// Water accents: waterfall streaks, landing foam, bank foam strips
// ---------------------------------------------------------------------------
// Tiny ShaderMaterials sharing AnimU.time (advanced once per frame by main)
// and the shared curvature uniforms, bent exactly like water.js. Fully
// self-animating: zero update functions, zero per-frame JS on this module.
// Instead of syncing scene.fog uniforms every frame, alpha fades out over a
// fixed view-depth band that sits inside the game's fog range.

const ACCENT_VERT = /* glsl */ `
uniform float uCurveY;
uniform float uCurveX;
varying vec2 vUv;
varying float vDepth;
void main() {
  vUv = uv;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  mvPosition.y += uCurveY * mvPosition.z * mvPosition.z;
  mvPosition.x += uCurveX * mvPosition.z * mvPosition.z;
  vDepth = -mvPosition.z;
  gl_Position = projectionMatrix * mvPosition;
}
`;

// NOTE: every smoothstep below keeps edge0 < edge1 (descending edges are
// undefined behavior per the GLSL spec), hence the 1.0 - smoothstep forms.
const FALL_FRAG = /* glsl */ `
uniform sampler2D uStreak;
uniform float uTime;
varying vec2 vUv;
varying float vDepth;
void main() {
  float s1 = texture2D(uStreak, vec2(vUv.x, vUv.y * 2.5 + uTime * 0.9)).r;
  float s2 = texture2D(uStreak, vec2(vUv.x * 1.6 + 0.33, vUv.y * 1.7 + uTime * 0.55)).r;
  float w = s1 * 0.75 + s2 * 0.55;
  w += (1.0 - smoothstep(0.0, 0.35, vUv.y)) * 0.45; // churn near the base
  float ex = smoothstep(0.0, 0.16, vUv.x) * (1.0 - smoothstep(0.84, 1.0, vUv.x));
  float ey = smoothstep(0.0, 0.05, vUv.y) * (1.0 - smoothstep(0.9, 1.0, vUv.y));
  float fade = 1.0 - smoothstep(55.0, 130.0, vDepth);
  vec3 col = mix(vec3(0.62, 0.78, 0.85), vec3(1.0), clamp(w, 0.0, 1.0));
  gl_FragColor = vec4(col, clamp(w, 0.0, 1.0) * 0.6 * ex * ey * fade);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const FOAM_DISC_FRAG = /* glsl */ `
uniform sampler2D uFoam;
uniform float uTime;
varying vec2 vUv;
varying float vDepth;
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  float ang = atan(p.y, p.x) * 0.1591549 + 0.5;
  float f1 = texture2D(uFoam, vec2(ang * 3.0, r * 1.4 - uTime * 0.28)).r;
  float f2 = texture2D(uFoam, vec2(ang * 5.0 + 0.37, r * 2.2 - uTime * 0.45)).r;
  float w = f1 * 0.8 + f2 * 0.6;
  float ring = (1.0 - smoothstep(0.7, 1.0, r)) * smoothstep(0.02, 0.2, r);
  float fade = 1.0 - smoothstep(55.0, 130.0, vDepth);
  gl_FragColor = vec4(vec3(0.96), clamp(w, 0.0, 1.0) * 0.85 * ring * fade);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const FOAM_STRIP_FRAG = /* glsl */ `
uniform sampler2D uFoam;
uniform float uTime;
varying vec2 vUv;
varying float vDepth;
void main() {
  float f1 = texture2D(uFoam, vec2(vUv.x * 0.8 + 0.1, vUv.y + uTime * 0.10)).r;
  float f2 = texture2D(uFoam, vec2(vUv.x * 1.3 + 0.45, vUv.y * 1.7 - uTime * 0.06)).r;
  float w = f1 * 0.75 + f2 * 0.55;
  float ex = smoothstep(0.0, 0.3, vUv.x) * (1.0 - smoothstep(0.7, 1.0, vUv.x));
  float fade = 1.0 - smoothstep(55.0, 130.0, vDepth);
  gl_FragColor = vec4(vec3(0.95), clamp(w, 0.0, 1.0) * 0.5 * ex * fade);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// Falling-water streaks: faint full-height threads (trivially tiling) plus
// brighter dashes drawn at wrapped offsets on both axes for seamless repeat.
// 128x256, within the 256 px canvas budget.
function streakTex() {
  return localTex('streak', () => {
    const w = 128, h = 256;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    const rnd = mulberry32(0xfa11);
    ctx.fillStyle = 'rgb(0,0,0)';
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 26; i++) {
      const x = rnd() * w;
      const a = 0.05 + rnd() * 0.09;
      const lw = 1 + rnd() * 2.5;
      for (const ox of [-w, 0, w]) {
        ctx.strokeStyle = `rgba(255,255,255,${a})`;
        ctx.lineWidth = lw;
        ctx.beginPath();
        ctx.moveTo(x + ox, 0);
        ctx.lineTo(x + ox, h); // same x at both ends keeps the v-wrap seamless
        ctx.stroke();
      }
    }
    for (let i = 0; i < 46; i++) {
      const x = rnd() * w, y = rnd() * h;
      const len = 20 + rnd() * 70;
      const lw = 1.5 + rnd() * 3.5;
      const a = 0.25 + rnd() * 0.5;
      for (const ox of [-w, 0, w]) {
        for (const oy of [-h, 0, h]) {
          const grad = ctx.createLinearGradient(0, y + oy, 0, y + oy + len);
          grad.addColorStop(0, 'rgba(255,255,255,0)');
          grad.addColorStop(0.5, `rgba(255,255,255,${a})`);
          grad.addColorStop(1, 'rgba(255,255,255,0)');
          ctx.strokeStyle = grad;
          ctx.lineWidth = lw;
          ctx.beginPath();
          ctx.moveTo(x + ox, y + oy);
          ctx.lineTo(x + ox, y + oy + len);
          ctx.stroke();
        }
      }
    }
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    return t;
  });
}

// Foam lace: wrapped bubble rings and specks. Mipmaps are OFF because the
// foam disc samples it through a polar mapping whose atan seam makes texture
// derivatives explode and would draw a visible mip-line across the disc.
function foamTex() {
  return localTex('foam', () => {
    const s = 128;
    const c = document.createElement('canvas');
    c.width = c.height = s;
    const ctx = c.getContext('2d');
    const rnd = mulberry32(0xf0a3);
    ctx.fillStyle = 'rgb(0,0,0)';
    ctx.fillRect(0, 0, s, s);
    for (let i = 0; i < 42; i++) {
      const x = rnd() * s, y = rnd() * s;
      const r = 3 + rnd() * 14;
      const a = 0.2 + rnd() * 0.5;
      const lw = 1 + rnd() * 2.2;
      for (const ox of [-s, 0, s]) {
        for (const oy of [-s, 0, s]) {
          ctx.strokeStyle = `rgba(255,255,255,${a})`;
          ctx.lineWidth = lw;
          ctx.beginPath();
          ctx.arc(x + ox, y + oy, r, 0, TAU);
          ctx.stroke();
        }
      }
    }
    for (let i = 0; i < 90; i++) {
      const x = rnd() * s, y = rnd() * s;
      const r = 0.6 + rnd() * 1.6;
      const a = 0.3 + rnd() * 0.5;
      for (const ox of [-s, 0, s]) {
        for (const oy of [-s, 0, s]) {
          ctx.fillStyle = `rgba(255,255,255,${a})`;
          ctx.beginPath();
          ctx.arc(x + ox, y + oy, r, 0, TAU);
          ctx.fill();
        }
      }
    }
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.generateMipmaps = false;
    t.minFilter = THREE.LinearFilter;
    return t;
  });
}

function matWaterfall() {
  return localMat('waterfall', () => new THREE.ShaderMaterial({
    uniforms: {
      uTime: AnimU.time,
      uCurveY: Curve.uniforms.uCurveY,
      uCurveX: Curve.uniforms.uCurveX,
      uStreak: { value: streakTex() },
    },
    vertexShader: ACCENT_VERT,
    fragmentShader: FALL_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: false,
  }));
}

function matFoamDisc() {
  return localMat('foamDisc', () => new THREE.ShaderMaterial({
    uniforms: {
      uTime: AnimU.time,
      uCurveY: Curve.uniforms.uCurveY,
      uCurveX: Curve.uniforms.uCurveX,
      uFoam: { value: foamTex() },
    },
    vertexShader: ACCENT_VERT,
    fragmentShader: FOAM_DISC_FRAG,
    transparent: true,
    depthWrite: false,
    fog: false,
  }));
}

function matFoamStrip() {
  return localMat('foamStrip', () => new THREE.ShaderMaterial({
    uniforms: {
      uTime: AnimU.time,
      uCurveY: Curve.uniforms.uCurveY,
      uCurveX: Curve.uniforms.uCurveX,
      uFoam: { value: foamTex() },
    },
    vertexShader: ACCENT_VERT,
    fragmentShader: FOAM_STRIP_FRAG,
    transparent: true,
    depthWrite: false,
    fog: false,
  }));
}

// ---------------------------------------------------------------------------
// buildQueunaPatch / buildMollePatch: instanced Andean trees
// ---------------------------------------------------------------------------
// One InstancedMesh per patch over a shared vertex-colored template, so a
// whole grove costs a single draw call and casts no shadows.

export function buildQueunaPatch({ count = 5, area = [8, 30] } = {}) {
  const rnd = nextRnd();
  const g = new THREE.Group();
  const im = new THREE.InstancedMesh(queunaTreeGeo(), matTreeVC(), count);
  // Template measures 2.93 m; 0.86..1.5 lands inside the 2.5..4.5 m band.
  scatterInstances(im, count, rnd, area[0] / 2, area[1] / 2, 0.86, 1.5, 0.03, 0.2);
  g.add(im);
  return freeze(g);
}

export function buildMollePatch({ count = 3, area = [8, 30] } = {}) {
  const rnd = nextRnd();
  const g = new THREE.Group();
  const im = new THREE.InstancedMesh(molleTreeGeo(), matTreeVC(), count);
  scatterInstances(im, count, rnd, area[0] / 2, area[1] / 2, 0.85, 1.5, 0.03, 0.2);
  g.add(im);
  return freeze(g);
}

// ---------------------------------------------------------------------------
// buildTambo: chasqui relay station, the thematic landmark
// ---------------------------------------------------------------------------
// 10 meshes. As a near-track landmark, the hut WALLS and ROOF are the only
// shadow casters here; everything else stays out of the shadow pass.

export function buildTambo() {
  const rnd = nextRnd();
  const g = new THREE.Group();
  const ashlar = Mats.ashlar();
  const dark = Mats.stoneDark();

  // Stone plinth the whole station sits on.
  const plinth = addMesh(g, boxGeo(5.2, 0.35, 4.4, ASHLAR_TILE), ashlar, 0, 0.175, 0);
  plinth.receiveShadow = true;

  // Hut: battered ashlar walls, door face toward +z.
  const hutX = -0.6, hutZ = -0.35;
  const walls = new THREE.Mesh(
    trapezoidBox(2.9, 2.55, 2.05, 2.3, 0, 2.9 / ASHLAR_TILE, 2.05 / ASHLAR_TILE),
    ashlar
  );
  walls.position.set(hutX, 0.35, hutZ);
  walls.castShadow = true;
  g.add(walls);

  // Trapezoid doorway (dark inset reads as the opening), protruding lintel,
  // and a small trapezoid window beside the door.
  const door = new THREE.Mesh(trapezoidBox(0.72, 0.54, 1.35, 0.14, 0, 0.3, 0.5), matDarkInset());
  door.position.set(hutX, 0.37, hutZ + 1.11);
  g.add(door);
  addMesh(g, boxGeo(1.0, 0.2, 0.3, STONE_TILE), dark, hutX, 1.82, hutZ + 1.13);
  const win = new THREE.Mesh(trapezoidBox(0.36, 0.28, 0.42, 0.12, 0, 0.15, 0.2), matDarkInset());
  win.position.set(hutX + 0.85, 1.35, hutZ + 1.12);
  g.add(win);

  // Convex thatch roof, watchtower-style lathe squashed to the rectangular
  // footprint, plus a soffit disc sealing the eaves from below.
  const roofPts = [];
  for (let i = 0; i <= 6; i++) {
    const t = i / 6;
    roofPts.push(new THREE.Vector2(2.1 * Math.pow(1 - t, 0.72), t * 1.35));
  }
  const roof = new THREE.Mesh(scaleUV(new THREE.LatheGeometry(roofPts, 12), 3, 1), Mats.thatch());
  roof.position.set(hutX, 2.34, hutZ);
  roof.scale.z = 0.82;
  roof.castShadow = true;
  g.add(roof);
  const soffit = new THREE.Mesh(scaleUV(new THREE.CircleGeometry(2.08, 12), 2, 2), Mats.thatch());
  soffit.rotation.x = Math.PI / 2; // normal faces down
  soffit.position.set(hutX, 2.35, hutZ);
  soffit.scale.y = 0.82; // local y is world z once rotated flat
  g.add(soffit);

  // Quipu post: wooden upright with a crossarm, merged into one mesh.
  const post = new THREE.CylinderGeometry(0.05, 0.07, 1.9, 6);
  post.translate(0, 0.95, 0);
  const arm = new THREE.CylinderGeometry(0.035, 0.035, 1.1, 6);
  arm.rotateZ(Math.PI / 2);
  arm.translate(0, 1.78, 0);
  const postMesh = new THREE.Mesh(mergeGeoms([post, arm]), Mats.wood());
  postMesh.position.set(1.6, 0.35, 0.9);
  g.add(postMesh);

  // Hanging quipu cords with knot spheres, merged into one wind-swayed mesh.
  // Built tip-up from y 0 (the wind bend scales with height above the base),
  // then hung upside down, so the free ends swing and the knots ride along.
  const cordParts = [];
  for (let k = 0; k < 4; k++) {
    const cx = -0.42 + k * 0.28 + (rnd() - 0.5) * 0.05;
    const cz = (rnd() - 0.5) * 0.06;
    const len = 0.55 + rnd() * 0.35;
    const cord = new THREE.CylinderGeometry(0.013, 0.013, len, 5);
    cord.translate(cx, len / 2, cz);
    cordParts.push(cord);
    const knots = 2 + ((rnd() * 2) | 0);
    for (let n = 0; n < knots; n++) {
      const knot = new THREE.SphereGeometry(0.028, 6, 4);
      knot.translate(cx, len * (0.25 + 0.65 * (n + rnd() * 0.5) / knots), cz);
      cordParts.push(knot);
    }
  }
  const quipu = new THREE.Mesh(mergeGeoms(cordParts), matQuipu());
  quipu.position.set(1.6, 2.13, 0.9); // crossarm height
  quipu.rotation.x = Math.PI;
  g.add(quipu);

  // Clay pots by the door, merged into one mesh.
  const potA = new THREE.SphereGeometry(0.24, 8, 6);
  potA.scale(1, 0.85, 1);
  potA.translate(0, 0.21, 0);
  const neckA = new THREE.CylinderGeometry(0.1, 0.14, 0.16, 8, 1, true);
  neckA.translate(0, 0.44, 0);
  const potB = new THREE.SphereGeometry(0.17, 8, 6);
  potB.scale(1, 0.9, 1);
  potB.translate(0.48, 0.15, 0.14);
  const neckB = new THREE.CylinderGeometry(0.07, 0.1, 0.12, 8, 1, true);
  neckB.translate(0.48, 0.32, 0.14);
  const pots = new THREE.Mesh(mergeGeoms([potA, neckA, potB, neckB]), matClay());
  pots.position.set(0.95, 0.35, 0.8);
  g.add(pots);

  return freeze(g);
}

// ---------------------------------------------------------------------------
// buildWaterfall: far-bank cascade, 4 draw calls, zero shadows
// ---------------------------------------------------------------------------
// Slab backing + merged flanking boulders + curved streak plane + foam ring.
// Fully self-animating through AnimU.time; no update function.

export function buildWaterfall({ height = 6, width = 3 } = {}) {
  const rnd = nextRnd();
  const g = new THREE.Group();

  // Stone slab backing the cascade, slight batter.
  const slab = new THREE.Mesh(
    trapezoidBox(width + 1.8, width + 0.7, height + 0.5, 1.6,
      0, (width + 1.8) / STONE_TILE, (height + 0.5) / STONE_TILE),
    Mats.stone()
  );
  slab.position.set(0, 0, -0.75);
  slab.rotation.y = (rnd() - 0.5) * 0.06;
  g.add(slab);

  // Two flanking boulders merged into a single mesh (one draw call).
  const bA = boulderGeometry(rnd, 0.9);
  bA.translate(-(width / 2 + 0.55), 0, 0.35);
  const bB = boulderGeometry(rnd, 0.7);
  bB.translate(width / 2 + 0.45, 0, 0.5);
  g.add(new THREE.Mesh(mergeGeoms([bA, bB]), Mats.stoneDark()));

  // Falling water: gently curved plane, kicks out at the base.
  const fall = new THREE.PlaneGeometry(width, height, 4, 12);
  {
    const p = fall.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const t = (p.getY(i) + height / 2) / height; // 0 base .. 1 lip
      p.setZ(i, 0.55 * Math.pow(1 - t, 2.4) + 0.1 * Math.sin(t * Math.PI));
    }
    fall.translate(0, height / 2, 0);
  }
  const fallMesh = new THREE.Mesh(fall, matWaterfall());
  fallMesh.position.set(0, 0, 0.12);
  fallMesh.renderOrder = 2; // after the river surface
  g.add(fallMesh);

  // Churning foam ring where the water lands, above any river wave crest.
  const disc = new THREE.CircleGeometry(width * 0.7, 18);
  disc.rotateX(-Math.PI / 2);
  const foam = new THREE.Mesh(disc, matFoamDisc());
  foam.position.set(0, 0.26, 0.85);
  foam.renderOrder = 2;
  g.add(foam);

  return freeze(g);
}

// ---------------------------------------------------------------------------
// buildFoamStrip: scrolling foam lace for river banks, 1 draw call
// ---------------------------------------------------------------------------
// Texture offset on a shared material is forbidden (offset state is shared),
// so the scroll lives in the shader via AnimU.time. The lace density rides in
// the geometry's v coordinates, which keeps ONE material for every length.

export function buildFoamStrip({ length = 36 } = {}) {
  const geo = new THREE.PlaneGeometry(0.7, length, 1, Math.max(6, Math.round(length / 3)));
  scaleUV(geo, 1, length / 3); // u stays 0..1 for the edge fade
  geo.rotateX(-Math.PI / 2);
  const m = new THREE.Mesh(geo, matFoamStrip());
  m.renderOrder = 2; // above the water surface
  return m; // root mesh stays auto-updating for track.js placement
}

// ---------------------------------------------------------------------------
// buildMegalithWall: Sacsayhuaman-style cyclopean set piece
// ---------------------------------------------------------------------------
// 3 meshes; castShadow only on the battered main face.

export function buildMegalithWall({ length = 14, height = 4 } = {}) {
  const rnd = nextRnd();
  const g = new THREE.Group();

  // Battered main face of few, huge stones (cells 3 masonry at a giant tile).
  const wall = new THREE.Mesh(
    trapezoidBox(1.15, 0.78, height, length, 0, length / MEGA_TILE, height / MEGA_TILE),
    matMegalith()
  );
  wall.rotation.y = (rnd() - 0.5) * 0.02;
  wall.castShadow = true;
  g.add(wall);

  // Protruding foundation course.
  addMesh(g, boxGeo(1.5, 0.7, length + 0.4, MEGA_TILE), Mats.stoneDark(), 0, 0.35, 0);

  // Rounded top coping.
  const coping = addMesh(
    g,
    scaleUV(new RoundedBoxGeometry(1.02, 0.42, length + 0.3, 2, 0.14),
      (length + 0.3) / MEGA_TILE, 0.42 / MEGA_TILE),
    Mats.stoneDark(), 0, height + 0.21, 0
  );
  coping.receiveShadow = true;

  return freeze(g);
}

// ---------------------------------------------------------------------------
// buildTunnel: rock gallery carved through a mountainside shoulder
// ---------------------------------------------------------------------------
// Rare set piece the runner passes THROUGH. 8 meshes total: two battered
// side walls and a continuous roof slab (megalith stone), two merged portal
// faces (jambs + lintel + battered crown, the ONLY shadow casters), one
// merged torch-glow strip mesh, one merged roof-rock mesh and one ichu
// InstancedMesh on the roof top.
// HARD CLEARANCE contract with track.js: the interior stays free for
// x in [-3.6, 3.6] below y 3.6 along the entire length. The numbers keep
// every surface outside that box: wall inner faces run x 4.0 at grade to
// 3.66 at the roof (3.678 clear at y 3.6), portal jambs 4.15 to 3.75
// (3.766 clear at y 3.6), torch strips stay outside x 3.72, the roof slab
// underside sits at y 3.8 and the portal lintels at y 3.75.

function matTorchGlow() {
  // Warm emissive "torchlight" strips for the tunnel interior. Emissive
  // only, NO lights involved; reads as a glow under the roof shadow.
  return localMat('torchGlow', () =>
    makeMat({
      color: 0x54301a, roughness: 1, metalness: 0,
      emissive: 0xff9540, emissiveIntensity: 0.8,
    })
  );
}

export function buildTunnel({ length = 16 } = {}) {
  const rnd = nextRnd();
  const g = new THREE.Group();
  const dark = Mats.stoneDark();
  const rock = matMegalith();

  const roofY = 3.8;   // roof slab underside (interior ceiling)
  const innerB = 4.0;  // wall inner half-width at grade
  const lean = 0.34;   // inward slide of the wall top (cave-like batter)
  const wallW = 1.35;

  // Side walls leaning in toward the roof, running the full length.
  for (let s = -1; s <= 1; s += 2) {
    const wall = new THREE.Mesh(
      trapezoidBox(wallW, wallW, roofY, length, -s * lean,
        length / MEGA_TILE, roofY / MEGA_TILE),
      rock
    );
    wall.position.set(s * (innerB + wallW / 2), 0, 0);
    g.add(wall);
  }

  // Continuous roof slab; its top face is the walkable "mountain shoulder".
  const roof = addMesh(g, boxGeo(11.4, 0.85, length, MEGA_TILE), rock, 0, roofY + 0.425, 0);
  roof.receiveShadow = true;

  // Portal faces at both ends: two battered jambs, a massive lintel and a
  // battered crown mass, merged into ONE mesh per end (the shadow casters).
  const pInnerB = 4.15, pInnerT = 3.75; // opening half-widths, grade / top
  const pH = 3.75;                      // lintel underside
  const jambW = 1.75;
  for (let e = -1; e <= 1; e += 2) {
    const parts = [];
    for (let s = -1; s <= 1; s += 2) {
      const jamb = trapezoidBox(jambW, jambW, pH, 1.5, -s * (pInnerB - pInnerT),
        jambW / STONE_TILE, pH / STONE_TILE);
      jamb.translate(s * (pInnerB + jambW / 2), 0, 0);
      parts.push(jamb);
    }
    const lintel = boxGeo(11.6, 0.95, 1.6, STONE_TILE);
    lintel.translate(0, pH + 0.475, 0);
    parts.push(lintel);
    // Crown base sinks 0.08 into the lintel so no top faces are coplanar.
    const crown = trapezoidBox(9.6, 6.2, 1.5, 1.35, (rnd() - 0.5) * 0.5,
      9.6 / STONE_TILE, 1.5 / STONE_TILE);
    crown.translate(0, pH + 0.87, 0);
    parts.push(crown);
    const portal = new THREE.Mesh(mergeGeoms(parts), dark);
    portal.position.set(0, 0, e * (length / 2 - 0.8)); // outer face at the end
    portal.castShadow = true;
    g.add(portal);
  }

  // Torch-glow strips: thin emissive boxes riding the interior walls,
  // alternating sides down the gallery, merged into one mesh. The outer
  // half of each strip sinks into the leaning wall so the slab stays
  // attached over its whole height while the face stays proud.
  const nStrips = length >= 14 ? 4 : 3;
  const zSpan = Math.max(1, length / 2 - 2.6);
  const stripParts = [];
  let stripSide = rnd() < 0.5 ? -1 : 1;
  for (let i = 0; i < nStrips; i++) {
    const t = nStrips > 1 ? (i / (nStrips - 1)) * 2 - 1 : 0;
    const z = t * zSpan + (rnd() - 0.5) * 0.8;
    const y0 = 1.5 + rnd() * 0.25;           // strip bottom
    const face = innerB - lean * (y0 / roofY); // wall inner face at y0
    const strip = boxGeo(0.14, 0.85, 0.35);
    strip.translate(stripSide * (face - 0.05), y0 + 0.425, z);
    stripParts.push(strip);
    stripSide = -stripSide;
  }
  g.add(new THREE.Mesh(mergeGeoms(stripParts), matTorchGlow()));

  // Rock chunks scattered over the roof top (one merged mesh)...
  const topY = roofY + 0.85;
  const rockParts = [];
  for (let i = 0; i < 5; i++) {
    const b = boulderGeometry(rnd, 0.45 + rnd() * 0.5);
    b.translate(
      (rnd() * 2 - 1) * 4.3, topY,
      (rnd() * 2 - 1) * Math.max(1, length / 2 - 2.4)
    );
    rockParts.push(b);
  }
  g.add(new THREE.Mesh(mergeGeoms(rockParts), dark));

  // ...and a couple of ichu tufts up there, catching the wind.
  const ichu = new THREE.InstancedMesh(ichuTuftGeo(), matIchu(), 3);
  for (let i = 0; i < 3; i++) {
    _dummy.position.set(
      (rnd() * 2 - 1) * 4.2, topY,
      (rnd() * 2 - 1) * Math.max(1, length / 2 - 2.2)
    );
    _dummy.rotation.set((rnd() - 0.5) * 0.2, rnd() * TAU, (rnd() - 0.5) * 0.2);
    const sc = 0.7 + rnd() * 0.5;
    _dummy.scale.set(sc, sc * (0.9 + rnd() * 0.3), sc);
    _dummy.updateMatrix();
    ichu.setMatrixAt(i, _dummy.matrix);
  }
  ichu.instanceMatrix.needsUpdate = true;
  ichu.computeBoundingSphere();
  g.add(ichu);

  return freeze(g);
}

// ---------------------------------------------------------------------------
// buildVillageSet: tiny Andean hamlet flanking the corridor
// ---------------------------------------------------------------------------
// Rare set piece the path runs through. 24 meshes: 5 stone houses (battered
// ashlar walls, convex lathe thatch roof + soffit, trapezoid door inset)
// alternating sides with varied yaw and scale, ONE merged ashlar fence mesh
// linking neighbors (with walk-through gaps), merged clay pots and a quipu
// post with wind-swayed cords (tambo technique). Spans about one chunk in z,
// centered on the origin.
// Corridor contract: house walls stay at |x| in [6, 11], nothing enters
// |x| < 4.5, everything stays below y 4. castShadow ONLY on house walls
// and roofs.

export function buildVillageSet() {
  const rnd = nextRnd();
  const g = new THREE.Group();
  const ashlar = Mats.ashlar();
  const thatch = Mats.thatch();

  // Five house slots along one chunk, alternating sides of the corridor.
  const slots = [-13.4, -6.6, 0.2, 6.8, 13.6];
  const flip = rnd() < 0.5 ? -1 : 1;
  const houses = [];
  for (let i = 0; i < slots.length; i++) {
    const side = (i % 2 === 0 ? -1 : 1) * flip;
    const w = 2.6 + rnd() * 0.5;     // footprint width (door face)
    const d = 2.2 + rnd() * 0.4;     // footprint depth
    const hWall = 1.85 + rnd() * 0.25;
    const s = 0.92 + rnd() * 0.16;

    const house = new THREE.Group();

    const walls = new THREE.Mesh(
      trapezoidBox(w, w - 0.3, hWall, d, 0, w / ASHLAR_TILE, hWall / ASHLAR_TILE),
      ashlar
    );
    walls.castShadow = true;
    house.add(walls);

    // Trapezoid doorway inset, slightly proud of the track-facing wall.
    const door = new THREE.Mesh(
      trapezoidBox(0.6, 0.46, 1.15, 0.14, 0, 0.25, 0.45), matDarkInset());
    door.position.set((rnd() - 0.5) * (w - 1.8), 0.01, d / 2 - 0.02);
    house.add(door);

    // Convex thatch roof (watchtower lathe technique) squashed so the eaves
    // overhang both footprint axes evenly, sealed underneath by a soffit.
    const rr = (w + 1.1) / 2;
    const squash = (d + 1.05) / (w + 1.1);
    const roofPts = [];
    for (let k = 0; k <= 6; k++) {
      const t = k / 6;
      roofPts.push(new THREE.Vector2(rr * Math.pow(1 - t, 0.72), t * 1.2));
    }
    const roof = new THREE.Mesh(scaleUV(new THREE.LatheGeometry(roofPts, 10), 3, 1), thatch);
    roof.position.y = hWall - 0.05;
    roof.scale.z = squash;
    roof.castShadow = true;
    house.add(roof);
    const soffit = new THREE.Mesh(scaleUV(new THREE.CircleGeometry(rr - 0.02, 10), 2, 2), thatch);
    soffit.rotation.x = Math.PI / 2; // normal faces down
    soffit.position.y = hWall - 0.04;
    soffit.scale.y = squash;         // local y is world z once rotated flat
    house.add(soffit);

    // Place: walls stay inside |x| [6, 11] even with yaw and scale extremes;
    // the door face turns toward the track.
    const cx = 8.35 + rnd() * 0.7;
    house.position.set(side * cx, 0, slots[i] + (rnd() - 0.5) * 1.4);
    house.rotation.y = -side * (Math.PI / 2) + (rnd() - 0.5) * 0.24;
    house.scale.setScalar(s);
    g.add(house);
    houses.push({ side, z: house.position.z });
  }

  // Low stone fences linking neighboring houses on each side, all segments
  // merged into ONE mesh. Long runs get a walk-through gap at the middle.
  const fenceParts = [];
  const addRun = (fx, z0, z1) => {
    const len = z1 - z0;
    if (len < 1.6) return;
    const zc = (z0 + z1) / 2;
    const rail = boxGeo(0.34, 0.72, len, ASHLAR_TILE);
    rail.translate(fx, 0.34, zc);
    fenceParts.push(rail);
    const cop = boxGeo(0.42, 0.1, len + 0.08, ASHLAR_TILE);
    cop.translate(fx, 0.75, zc);
    fenceParts.push(cop);
    for (const e of [z0 + 0.1, z1 - 0.1]) {
      const post = trapezoidBox(0.52, 0.4, 0.98, 0.52, 0, 0.2, 0.4);
      post.translate(fx, -0.03, e);
      fenceParts.push(post);
    }
  };
  for (const side of [-1, 1]) {
    const zs = houses.filter((h) => h.side === side).map((h) => h.z).sort((a, b) => a - b);
    for (let i = 0; i + 1 < zs.length; i++) {
      const z0 = zs[i] + 1.35, z1 = zs[i + 1] - 1.35;
      const fx = side * (7.9 + (rnd() - 0.5) * 0.5);
      if (z1 - z0 > 7) {
        const zm = (z0 + z1) / 2;
        addRun(fx, z0, zm - 0.8);
        addRun(fx, zm + 0.8, z1);
      } else {
        addRun(fx, z0, z1);
      }
    }
  }
  if (fenceParts.length) g.add(new THREE.Mesh(mergeGeoms(fenceParts), ashlar));

  // Two clay pots by one of the doorways (merged, tambo technique).
  const potHouse = houses[(rnd() * houses.length) | 0];
  const potA = new THREE.SphereGeometry(0.26, 8, 6);
  potA.scale(1, 0.85, 1);
  potA.translate(0, 0.22, 0);
  const neckA = new THREE.CylinderGeometry(0.1, 0.15, 0.16, 8, 1, true);
  neckA.translate(0, 0.46, 0);
  const potB = new THREE.SphereGeometry(0.18, 8, 6);
  potB.scale(1, 0.9, 1);
  potB.translate(0.5, 0.16, 0.12);
  const neckB = new THREE.CylinderGeometry(0.07, 0.11, 0.12, 8, 1, true);
  neckB.translate(0.5, 0.34, 0.12);
  const pots = new THREE.Mesh(mergeGeoms([potA, neckA, potB, neckB]), matClay());
  pots.position.set(potHouse.side * (6.1 + rnd() * 0.5), 0, potHouse.z + 2.1 + rnd());
  g.add(pots);

  // Quipu post opposite the pots: wooden upright + crossarm (merged), with
  // hanging wind-swayed cords built tip-up and hung rotated, exactly like
  // the tambo's. Kept unyawed so the cords hang along the crossarm.
  const qSide = -potHouse.side;
  const qz = (rnd() * 2 - 1) * 5;
  const post = new THREE.CylinderGeometry(0.05, 0.07, 1.9, 6);
  post.translate(0, 0.95, 0);
  const arm = new THREE.CylinderGeometry(0.035, 0.035, 1.1, 6);
  arm.rotateZ(Math.PI / 2);
  arm.translate(0, 1.78, 0);
  const postMesh = new THREE.Mesh(mergeGeoms([post, arm]), Mats.wood());
  postMesh.position.set(qSide * 5.7, 0, qz);
  g.add(postMesh);

  const cordParts = [];
  for (let k = 0; k < 4; k++) {
    const ccx = -0.42 + k * 0.28 + (rnd() - 0.5) * 0.05;
    const ccz = (rnd() - 0.5) * 0.06;
    const len = 0.55 + rnd() * 0.35;
    const cord = new THREE.CylinderGeometry(0.013, 0.013, len, 5);
    cord.translate(ccx, len / 2, ccz);
    cordParts.push(cord);
    const knots = 2 + ((rnd() * 2) | 0);
    for (let n = 0; n < knots; n++) {
      const knot = new THREE.SphereGeometry(0.028, 6, 4);
      knot.translate(ccx, len * (0.25 + 0.65 * (n + rnd() * 0.5) / knots), ccz);
      cordParts.push(knot);
    }
  }
  const quipu = new THREE.Mesh(mergeGeoms(cordParts), matQuipu());
  quipu.position.set(qSide * 5.7, 1.78, qz); // crossarm height
  quipu.rotation.x = Math.PI;
  g.add(quipu);

  return freeze(g);
}
