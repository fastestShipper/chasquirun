// Procedural texture factory + shared materials + curved-world vertex patch.
// Everything is generated on canvas at boot. No external assets.

import * as THREE from 'three';
import { CONFIG } from './config.js';
import { mulberry32, clamp } from './util.js';

let maxAniso = 4;
const texCache = new Map();
const matCache = new Map();

export function initMaterials(renderer) {
  maxAniso = renderer.capabilities.getMaxAnisotropy();
  for (const t of texCache.values()) {
    t.anisotropy = maxAniso;
    t.needsUpdate = true;
  }
}

// ---------------------------------------------------------------------------
// Curved-world bend (view space). Shared uniforms so the whole world agrees.
// ---------------------------------------------------------------------------

export const Curve = {
  uniforms: {
    uCurveY: { value: -1.15e-4 },
    uCurveX: { value: 0.0 },
  },
};

const CURVE_CHUNK = `
vec4 mvPosition = vec4( transformed, 1.0 );
#ifdef USE_BATCHING
	mvPosition = batchingMatrix * mvPosition;
#endif
#ifdef USE_INSTANCING
	mvPosition = instanceMatrix * mvPosition;
#endif
mvPosition = modelViewMatrix * mvPosition;
mvPosition.y += uCurveY * mvPosition.z * mvPosition.z;
mvPosition.x += uCurveX * mvPosition.z * mvPosition.z;
gl_Position = projectionMatrix * mvPosition;
`;

function curvePatch(shader) {
  shader.uniforms.uCurveY = Curve.uniforms.uCurveY;
  shader.uniforms.uCurveX = Curve.uniforms.uCurveX;
  shader.vertexShader = shader.vertexShader
    .replace(
      '#include <common>',
      '#include <common>\nuniform float uCurveY;\nuniform float uCurveX;'
    )
    .replace('#include <project_vertex>', CURVE_CHUNK);
}

export function applyCurvature(mat) {
  mat.onBeforeCompile = curvePatch;
  return mat;
}

// Same bend for SpriteMaterial (world-anchored sprites: flames, pickup glows).
function spriteCurvePatch(shader) {
  shader.uniforms.uCurveY = Curve.uniforms.uCurveY;
  shader.uniforms.uCurveX = Curve.uniforms.uCurveX;
  shader.vertexShader = shader.vertexShader
    .replace('void main() {', 'uniform float uCurveY;\nuniform float uCurveX;\nvoid main() {')
    .replace(
      'gl_Position = projectionMatrix * mvPosition;',
      'mvPosition.y += uCurveY * mvPosition.z * mvPosition.z;\n\tmvPosition.x += uCurveX * mvPosition.z * mvPosition.z;\n\tgl_Position = projectionMatrix * mvPosition;'
    );
}

export function applyCurvatureSprite(mat) {
  mat.onBeforeCompile = spriteCurvePatch;
  return mat;
}

export function makeMat(opts = {}) {
  return applyCurvature(new THREE.MeshStandardMaterial(opts));
}

// ---------------------------------------------------------------------------
// Photo textures (CC0, PolyHaven, bundled in assets/tex). Loaded once during
// boot; every getter falls back to the procedural texture when a file is
// missing or fails, so the game still boots from a partial deploy.
// ---------------------------------------------------------------------------

const photo = {}; // short name -> { map, nor, arm } (any may be null)
export const photoImages = {}; // short name -> HTMLImageElement of the diffuse

export function loadPhotoTextures() {
  const loader = new THREE.TextureLoader();
  const one = (file, srgb) =>
    new Promise((resolve) => {
      loader.load(
        'assets/tex/' + file,
        (t) => {
          t.wrapS = t.wrapT = THREE.RepeatWrapping;
          if (srgb) t.colorSpace = THREE.SRGBColorSpace;
          t.anisotropy = maxAniso;
          resolve(t);
        },
        undefined,
        () => resolve(null)
      );
    });
  const sets = ['path', 'grassrock', 'rock', 'masonry'];
  return Promise.all(
    sets.map(async (name) => {
      const detailOnly = name === 'masonry'; // diffuse-only detail layer
      const [map, nor, arm] = await Promise.all([
        one(name + '_diff.jpg', true),
        detailOnly ? null : one(name + '_nor.jpg', false),
        detailOnly ? null : one(name + '_arm.jpg', false),
      ]);
      photo[name] = { map, nor, arm };
      if (map && map.image) photoImages[name] = map.image;
    })
  );
}

// Clone that shares the image but carries its own repeat.
function rep(tex, rx, ry) {
  if (!tex) return null;
  const t = tex.clone();
  t.repeat.set(rx, ry);
  t.needsUpdate = true;
  return t;
}

// Standard opts for a photo-PBR material; null when the set is unavailable.
function photoOpts(name, rx, ry, extra = {}) {
  const p = photo[name];
  if (!p || !p.map) return null;
  const o = {
    map: rep(p.map, rx, ry),
    roughness: 1,
    metalness: 0,
    ...extra,
  };
  if (p.nor) {
    o.normalMap = rep(p.nor, rx, ry);
    o.normalScale = new THREE.Vector2(extra.normalScaleV || 1.1, extra.normalScaleV || 1.1);
  }
  if (p.arm) {
    // AO only. The roughness channel turned bright quartz pebbles into
    // square specular pings under the noon sun ("particulas blancas feas");
    // dirt and turf read best fully matte.
    o.aoMap = rep(p.arm, rx, ry);
    o.aoMap.channel = 0; // our geometry has a single UV set
    o.aoMapIntensity = 0.65;
  }
  delete o.normalScaleV;
  return o;
}

// ---------------------------------------------------------------------------
// Shared animation uniforms (main.js advances them once per frame).
// ---------------------------------------------------------------------------

export const AnimU = {
  time: { value: 0 },                          // seconds, wraps hourly
  cloudOff: { value: new THREE.Vector2(0, 0) }, // cloud-shadow drift
  cloudAmt: { value: 0.16 },                    // cloud-shadow strength
};

// ---------------------------------------------------------------------------
// Wind sway for instanced vegetation: bend scales with height above the base,
// phase varies per instance. Chained with the curvature bend.
// ---------------------------------------------------------------------------

export function applyWindCurvature(mat, strength = 0.08) {
  const s = strength.toFixed(4);
  mat.onBeforeCompile = (shader) => {
    curvePatch(shader);
    shader.uniforms.uWindT = AnimU.time;
    shader.vertexShader = shader.vertexShader
      .replace('uniform float uCurveY;', 'uniform float uCurveY;\nuniform float uWindT;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
{
	float windH = max( transformed.y, 0.0 );
	float wp = uWindT * 1.7 + position.x * 0.8 + position.z * 1.1;
	#ifdef USE_INSTANCING
		wp += instanceMatrix[3][0] * 0.41 + instanceMatrix[3][2] * 0.29;
	#endif
	float wg = sin( wp ) * 0.6 + sin( wp * 2.33 + 1.7 ) * 0.4;
	transformed.x += wg * windH * ${s};
	transformed.z += cos( wp * 0.77 ) * windH * ${s} * 0.6;
}`
      );
  };
  return mat;
}

// ---------------------------------------------------------------------------
// Ground materials: curvature + drifting cloud shadows (fake, no shadow maps).
// ---------------------------------------------------------------------------

const GROUND_CURVE_CHUNK = `
vec4 gwp = vec4( transformed, 1.0 );
#ifdef USE_INSTANCING
	gwp = instanceMatrix * gwp;
#endif
gwp = modelMatrix * gwp;
vCloudXZ = gwp.xz;
` + CURVE_CHUNK;

function groundPatch(shader) {
  shader.uniforms.uCurveY = Curve.uniforms.uCurveY;
  shader.uniforms.uCurveX = Curve.uniforms.uCurveX;
  shader.uniforms.uCloudTex = { value: Tex.cloudNoise() };
  shader.uniforms.uCloudOff = AnimU.cloudOff;
  shader.uniforms.uCloudAmt = AnimU.cloudAmt;
  shader.vertexShader = shader.vertexShader
    .replace(
      '#include <common>',
      '#include <common>\nuniform float uCurveY;\nuniform float uCurveX;\nvarying vec2 vCloudXZ;'
    )
    .replace('#include <project_vertex>', GROUND_CURVE_CHUNK);
  shader.fragmentShader = shader.fragmentShader
    .replace(
      '#include <common>',
      '#include <common>\nuniform sampler2D uCloudTex;\nuniform vec2 uCloudOff;\nuniform float uCloudAmt;\nvarying vec2 vCloudXZ;'
    )
    .replace(
      '#include <map_fragment>',
      `#include <map_fragment>
{
	float cs = texture2D( uCloudTex, vCloudXZ * 0.0045 + uCloudOff ).r;
	diffuseColor.rgb *= 1.0 - uCloudAmt * smoothstep( 0.45, 0.85, cs );
}`
    );
}

export function applyGroundExtras(mat) {
  mat.onBeforeCompile = groundPatch;
  return mat;
}

export function makeGroundMat(opts = {}) {
  return applyGroundExtras(new THREE.MeshStandardMaterial(opts));
}

// ---------------------------------------------------------------------------
// Canvas helpers
// ---------------------------------------------------------------------------

function makeCanvas(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
}

function finishTexture(canvas, { srgb = true, repeat = [1, 1] } = {}) {
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat[0], repeat[1]);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = maxAniso;
  return t;
}

function grain(ctx, size, amount, rnd) {
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rnd() - 0.5) * 2 * amount;
    d[i] = clamp(d[i] + n, 0, 255);
    d[i + 1] = clamp(d[i + 1] + n, 0, 255);
    d[i + 2] = clamp(d[i + 2] + n, 0, 255);
  }
  ctx.putImageData(img, 0, 0);
}

function blotches(ctx, size, count, color, alphaLo, alphaHi, rLo, rHi, rnd) {
  for (let i = 0; i < count; i++) {
    const x = rnd() * size;
    const y = rnd() * size;
    const r = rLo + rnd() * (rHi - rLo);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    const a = alphaLo + rnd() * (alphaHi - alphaLo);
    g.addColorStop(0, `rgba(${color[0]},${color[1]},${color[2]},${a})`);
    g.addColorStop(1, `rgba(${color[0]},${color[1]},${color[2]},0)`);
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
}

function cachedTex(key, maker) {
  if (!texCache.has(key)) texCache.set(key, maker());
  return texCache.get(key);
}

// ---------------------------------------------------------------------------
// Textures
// ---------------------------------------------------------------------------

// Polygonal Inca masonry: toroidal Voronoi so it tiles seamlessly.
// Returns { map, bumpMap }.
function masonryPair({ size = 512, cells = 5, base = [140, 131, 119], seed = 7, joint = 10 } = {}) {
  const rnd = mulberry32(seed);
  const seeds = [];
  const cell = size / cells;
  for (let gy = 0; gy < cells; gy++) {
    for (let gx = 0; gx < cells; gx++) {
      seeds.push({
        x: (gx + 0.5) * cell + (rnd() - 0.5) * cell * 0.85,
        y: (gy + 0.5) * cell + (rnd() - 0.5) * cell * 0.85,
        shade: 0.82 + rnd() * 0.3,
      });
    }
  }
  const colorC = makeCanvas(size);
  const bumpC = makeCanvas(size);
  const cctx = colorC.getContext('2d');
  const bctx = bumpC.getContext('2d');
  const cimg = cctx.createImageData(size, size);
  const bimg = bctx.createImageData(size, size);
  const cd = cimg.data;
  const bd = bimg.data;
  const half = size / 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let d1 = 1e9, d2 = 1e9, s1 = null;
      for (let i = 0; i < seeds.length; i++) {
        const s = seeds[i];
        let dx = Math.abs(x - s.x); if (dx > half) dx = size - dx;
        let dy = Math.abs(y - s.y); if (dy > half) dy = size - dy;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < d1) { d2 = d1; d1 = d; s1 = s; }
        else if (d < d2) { d2 = d; }
      }
      const edge = d2 - d1;
      // Pillow shading: bright center, dark tight joints.
      const jointT = clamp(edge / joint, 0, 1);
      const pillow = 0.5 + 0.5 * (jointT * jointT * (3 - 2 * jointT));
      // Directional light from top-left for subtle 3D bulge.
      let ddx = x - s1.x; if (ddx > half) ddx -= size; if (ddx < -half) ddx += size;
      let ddy = y - s1.y; if (ddy > half) ddy -= size; if (ddy < -half) ddy += size;
      const dl = d1 > 0.001 ? -(ddx * -0.707 + ddy * -0.707) / d1 : 0;
      const lum = s1.shade * (0.45 + 0.55 * pillow) * (1 + dl * 0.07);
      const o = (y * size + x) * 4;
      cd[o] = clamp(base[0] * lum, 0, 255);
      cd[o + 1] = clamp(base[1] * lum, 0, 255);
      cd[o + 2] = clamp(base[2] * lum, 0, 255);
      cd[o + 3] = 255;
      const h = clamp(40 + 215 * pillow, 0, 255);
      bd[o] = bd[o + 1] = bd[o + 2] = h;
      bd[o + 3] = 255;
    }
  }
  cctx.putImageData(cimg, 0, 0);
  bctx.putImageData(bimg, 0, 0);
  grain(cctx, size, 9, rnd);
  // Real rock micro-detail under the procedural joints (hybrid realism).
  // The AI-generated granite is mirror-symmetric, but at overlay alpha under
  // the Voronoi joints the symmetry is imperceptible; the grain is what sells.
  const detail = photoImages.masonry || photoImages.rock;
  if (detail) {
    cctx.globalAlpha = 0.5;
    cctx.globalCompositeOperation = 'overlay';
    cctx.drawImage(detail, 0, 0, size, size);
    cctx.globalCompositeOperation = 'source-over';
    cctx.globalAlpha = 1;
  }
  return { colorC, bumpC };
}

// Coursed rectangular stone (terrace retaining walls, plazas).
function ashlarPair({ size = 512, rows = 6, base = [150, 141, 128], seed = 11 } = {}) {
  const rnd = mulberry32(seed);
  const colorC = makeCanvas(size);
  const bumpC = makeCanvas(size);
  const cctx = colorC.getContext('2d');
  const bctx = bumpC.getContext('2d');
  const rowH = size / rows;
  cctx.fillStyle = 'rgb(52,48,42)';
  cctx.fillRect(0, 0, size, size);
  bctx.fillStyle = 'rgb(30,30,30)';
  bctx.fillRect(0, 0, size, size);
  for (let r = 0; r < rows; r++) {
    const y = r * rowH;
    let x = -((r % 2) * 0.5 + rnd() * 0.3) * rowH * 1.6;
    while (x < size) {
      const w = rowH * (1.2 + rnd() * 1.3);
      const shade = 0.8 + rnd() * 0.34;
      const g = cctx.createLinearGradient(0, y, 0, y + rowH);
      g.addColorStop(0, `rgb(${(base[0] * shade * 1.08) | 0},${(base[1] * shade * 1.08) | 0},${(base[2] * shade * 1.08) | 0})`);
      g.addColorStop(1, `rgb(${(base[0] * shade * 0.86) | 0},${(base[1] * shade * 0.86) | 0},${(base[2] * shade * 0.86) | 0})`);
      cctx.fillStyle = g;
      const gap = 2.5;
      cctx.fillRect(x + gap, y + gap, w - gap * 2, rowH - gap * 2);
      cctx.strokeStyle = 'rgba(255,255,255,0.10)';
      cctx.lineWidth = 1.5;
      cctx.strokeRect(x + gap + 1, y + gap + 1, w - gap * 2 - 2, rowH - gap * 2 - 2);
      const bshade = (200 * shade) | 0;
      bctx.fillStyle = `rgb(${bshade},${bshade},${bshade})`;
      bctx.fillRect(x + gap, y + gap, w - gap * 2, rowH - gap * 2);
      x += w;
    }
  }
  grain(cctx, size, 8, rnd);
  if (photoImages.rock) {
    cctx.globalAlpha = 0.45;
    cctx.globalCompositeOperation = 'overlay';
    cctx.drawImage(photoImages.rock, 0, 0, size, size);
    cctx.globalCompositeOperation = 'source-over';
    cctx.globalAlpha = 1;
  }
  return { colorC, bumpC };
}

export const Tex = {
  masonry(opts = {}) {
    const key = 'masonry:' + JSON.stringify(opts);
    return cachedTex(key, () => {
      const { colorC, bumpC } = masonryPair(opts);
      const map = finishTexture(colorC, { repeat: opts.repeat || [1, 1] });
      const bumpMap = finishTexture(bumpC, { srgb: false, repeat: opts.repeat || [1, 1] });
      return { map, bumpMap };
    });
  },

  ashlar(opts = {}) {
    const key = 'ashlar:' + JSON.stringify(opts);
    return cachedTex(key, () => {
      const { colorC, bumpC } = ashlarPair(opts);
      const map = finishTexture(colorC, { repeat: opts.repeat || [1, 1] });
      const bumpMap = finishTexture(bumpC, { srgb: false, repeat: opts.repeat || [1, 1] });
      return { map, bumpMap };
    });
  },

  grass(opts = {}) {
    const key = 'grass:' + JSON.stringify(opts);
    return cachedTex(key, () => {
      const size = 512;
      const rnd = mulberry32(21);
      const c = makeCanvas(size);
      const ctx = c.getContext('2d');
      const base = opts.base || [88, 142, 52];
      ctx.fillStyle = `rgb(${base[0]},${base[1]},${base[2]})`;
      ctx.fillRect(0, 0, size, size);
      blotches(ctx, size, 26, [60, 92, 38], 0.12, 0.3, 40, 130, rnd);
      blotches(ctx, size, 20, [140, 168, 82], 0.08, 0.2, 30, 90, rnd);
      // Sierra patchwork: dry tan fields and saturated irrigated greens.
      blotches(ctx, size, 7, [172, 148, 96], 0.18, 0.34, 60, 150, rnd);
      blotches(ctx, size, 5, [58, 122, 30], 0.16, 0.3, 40, 110, rnd);
      for (let i = 0; i < 2600; i++) {
        const x = rnd() * size, y = rnd() * size;
        const len = 3 + rnd() * 5;
        const a = -Math.PI / 2 + (rnd() - 0.5) * 0.9;
        const l = 0.75 + rnd() * 0.5;
        ctx.strokeStyle = `rgba(${(base[0] * l) | 0},${(base[1] * l) | 0},${(base[2] * l * 0.9) | 0},0.5)`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
        ctx.stroke();
      }
      grain(ctx, size, 7, rnd);
      return finishTexture(c, { repeat: opts.repeat || [1, 1] });
    });
  },

  earth(opts = {}) {
    const key = 'earth:' + JSON.stringify(opts);
    return cachedTex(key, () => {
      const size = 512;
      const rnd = mulberry32(33);
      const c = makeCanvas(size);
      const ctx = c.getContext('2d');
      ctx.fillStyle = 'rgb(122,91,58)';
      ctx.fillRect(0, 0, size, size);
      blotches(ctx, size, 30, [86, 62, 38], 0.15, 0.35, 30, 110, rnd);
      blotches(ctx, size, 22, [156, 122, 82], 0.1, 0.22, 25, 80, rnd);
      for (let i = 0; i < 380; i++) {
        const x = rnd() * size, y = rnd() * size, r = 1 + rnd() * 2.6;
        const l = 0.6 + rnd() * 0.7;
        ctx.fillStyle = `rgba(${(130 * l) | 0},${(104 * l) | 0},${(74 * l) | 0},0.7)`;
        ctx.beginPath();
        ctx.ellipse(x, y, r, r * 0.7, rnd() * Math.PI, 0, Math.PI * 2);
        ctx.fill();
      }
      grain(ctx, size, 9, rnd);
      return finishTexture(c, { repeat: opts.repeat || [1, 1] });
    });
  },

  gravel(opts = {}) {
    const key = 'gravel:' + JSON.stringify(opts);
    return cachedTex(key, () => {
      const size = 512;
      const rnd = mulberry32(45);
      const c = makeCanvas(size);
      const ctx = c.getContext('2d');
      ctx.fillStyle = 'rgb(168,146,114)';
      ctx.fillRect(0, 0, size, size);
      blotches(ctx, size, 24, [120, 102, 78], 0.1, 0.25, 40, 120, rnd);
      // Worn foot-traffic streaks along V (track length).
      for (let i = 0; i < 26; i++) {
        const x = rnd() * size;
        ctx.strokeStyle = `rgba(110,94,70,${0.05 + rnd() * 0.08})`;
        ctx.lineWidth = 6 + rnd() * 22;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x + (rnd() - 0.5) * 40, size);
        ctx.stroke();
      }
      for (let i = 0; i < 520; i++) {
        const x = rnd() * size, y = rnd() * size, r = 1.2 + rnd() * 3.4;
        const l = 0.62 + rnd() * 0.65;
        ctx.fillStyle = `rgba(${(172 * l) | 0},${(154 * l) | 0},${(126 * l) | 0},0.85)`;
        ctx.beginPath();
        ctx.ellipse(x, y, r, r * 0.75, rnd() * Math.PI, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = `rgba(255,255,255,${0.06 + rnd() * 0.08})`;
        ctx.beginPath();
        ctx.ellipse(x - r * 0.25, y - r * 0.3, r * 0.4, r * 0.3, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      grain(ctx, size, 8, rnd);
      return finishTexture(c, { repeat: opts.repeat || [1, 1] });
    });
  },

  snow(opts = {}) {
    const key = 'snow:' + JSON.stringify(opts);
    return cachedTex(key, () => {
      const size = 256;
      const rnd = mulberry32(52);
      const c = makeCanvas(size);
      const ctx = c.getContext('2d');
      ctx.fillStyle = 'rgb(238,243,248)';
      ctx.fillRect(0, 0, size, size);
      blotches(ctx, size, 18, [200, 214, 230], 0.15, 0.3, 20, 80, rnd);
      for (let i = 0; i < 160; i++) {
        ctx.fillStyle = `rgba(255,255,255,${0.3 + rnd() * 0.5})`;
        ctx.fillRect(rnd() * size, rnd() * size, 1.5, 1.5);
      }
      grain(ctx, size, 5, rnd);
      return finishTexture(c, { repeat: opts.repeat || [1, 1] });
    });
  },

  thatch(opts = {}) {
    const key = 'thatch:' + JSON.stringify(opts);
    return cachedTex(key, () => {
      const size = 512;
      const rnd = mulberry32(63);
      const c = makeCanvas(size);
      const ctx = c.getContext('2d');
      ctx.fillStyle = 'rgb(146,116,64)';
      ctx.fillRect(0, 0, size, size);
      // Vertical ichu strands (V runs down the roof slope).
      for (let i = 0; i < 900; i++) {
        const x = rnd() * size;
        const y = rnd() * size;
        const len = 26 + rnd() * 60;
        const l = 0.6 + rnd() * 0.75;
        ctx.strokeStyle = `rgba(${(176 * l) | 0},${(142 * l) | 0},${(78 * l) | 0},0.55)`;
        ctx.lineWidth = 1 + rnd() * 1.6;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + (rnd() - 0.5) * 7, y + len);
        ctx.stroke();
      }
      // Layered row shadows.
      for (let y = 0; y < size; y += 42) {
        const g = ctx.createLinearGradient(0, y, 0, y + 42);
        g.addColorStop(0, 'rgba(60,44,20,0.35)');
        g.addColorStop(0.35, 'rgba(60,44,20,0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, y, size, 42);
      }
      grain(ctx, size, 8, rnd);
      return finishTexture(c, { repeat: opts.repeat || [1, 1] });
    });
  },

  wood(opts = {}) {
    const key = 'wood:' + JSON.stringify(opts);
    return cachedTex(key, () => {
      const size = 256;
      const rnd = mulberry32(74);
      const c = makeCanvas(size);
      const ctx = c.getContext('2d');
      ctx.fillStyle = 'rgb(107,74,44)';
      ctx.fillRect(0, 0, size, size);
      for (let i = 0; i < 90; i++) {
        const x = rnd() * size;
        const l = 0.65 + rnd() * 0.75;
        ctx.strokeStyle = `rgba(${(112 * l) | 0},${(78 * l) | 0},${(46 * l) | 0},0.6)`;
        ctx.lineWidth = 1 + rnd() * 3;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        const bend = (rnd() - 0.5) * 26;
        ctx.bezierCurveTo(x + bend, size * 0.33, x - bend, size * 0.66, x + (rnd() - 0.5) * 12, size);
        ctx.stroke();
      }
      for (let i = 0; i < 5; i++) {
        const x = rnd() * size, y = rnd() * size;
        const g = ctx.createRadialGradient(x, y, 1, x, y, 9);
        g.addColorStop(0, 'rgba(56,36,20,0.9)');
        g.addColorStop(1, 'rgba(56,36,20,0)');
        ctx.fillStyle = g;
        ctx.fillRect(x - 9, y - 9, 18, 18);
      }
      grain(ctx, size, 8, rnd);
      return finishTexture(c, { repeat: opts.repeat || [1, 1] });
    });
  },

  gold(opts = {}) {
    const key = 'gold:' + JSON.stringify(opts);
    return cachedTex(key, () => {
      const size = 256;
      const rnd = mulberry32(85);
      const c = makeCanvas(size);
      const ctx = c.getContext('2d');
      const g = ctx.createRadialGradient(size / 2, size / 2, 8, size / 2, size / 2, size * 0.7);
      g.addColorStop(0, 'rgb(255,233,168)');
      g.addColorStop(0.55, 'rgb(233,180,76)');
      g.addColorStop(1, 'rgb(186,132,44)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, size, size);
      // Brushed concentric arcs.
      for (let i = 0; i < 70; i++) {
        const r = rnd() * size * 0.7;
        ctx.strokeStyle = `rgba(255,255,255,${0.03 + rnd() * 0.06})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(size / 2, size / 2, r, rnd() * Math.PI * 2, rnd() * Math.PI * 2 + 1.2);
        ctx.stroke();
      }
      grain(ctx, size, 6, rnd);
      return finishTexture(c);
    });
  },

  // Andean textile stripes with stepped-diamond motifs.
  woven(colors = ['#b03a2e', '#d97b29', '#e8c14d', '#2c3e50'], opts = {}) {
    const key = 'woven:' + colors.join(',') + JSON.stringify(opts);
    return cachedTex(key, () => {
      const size = 256;
      const rnd = mulberry32(96);
      const c = makeCanvas(size);
      const ctx = c.getContext('2d');
      const bandH = 32;
      let ci = 0;
      for (let y = 0; y < size; y += bandH) {
        ctx.fillStyle = colors[ci % colors.length];
        ctx.fillRect(0, y, size, bandH);
        // Thin separator cords.
        ctx.fillStyle = 'rgba(20,16,12,0.55)';
        ctx.fillRect(0, y, size, 2);
        ctx.fillRect(0, y + bandH - 2, size, 2);
        // Stepped diamonds on alternating bands.
        if (ci % 2 === 1) {
          ctx.fillStyle = 'rgba(240,228,200,0.85)';
          for (let x = 10; x < size; x += 32) {
            const cy = y + bandH / 2;
            for (let s = 0; s < 3; s++) {
              const w = (3 - s) * 4;
              ctx.fillRect(x - w / 2, cy - 6 + s * 2, w, 2);
              ctx.fillRect(x - w / 2, cy + 4 - s * 2, w, 2);
            }
            ctx.fillRect(x - 6, cy - 1, 12, 2);
          }
        }
        ci++;
      }
      // Weave texture: fine alternating row shading.
      for (let y = 0; y < size; y += 2) {
        ctx.fillStyle = `rgba(0,0,0,${y % 4 === 0 ? 0.06 : 0})`;
        ctx.fillRect(0, y, size, 1);
      }
      grain(ctx, size, 7, rnd);
      return finishTexture(c, { repeat: opts.repeat || [1, 1] });
    });
  },

  softCircle(color = '#ffffff') {
    const key = 'softCircle:' + color;
    return cachedTex(key, () => {
      const size = 128;
      const c = makeCanvas(size);
      const ctx = c.getContext('2d');
      const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
      g.addColorStop(0, color);
      g.addColorStop(0.4, color);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      // Fade alpha manually so the tint keeps its hue.
      const c2 = makeCanvas(size);
      const ctx2 = c2.getContext('2d');
      const gg = ctx2.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
      gg.addColorStop(0, 'rgba(255,255,255,1)');
      gg.addColorStop(0.35, 'rgba(255,255,255,0.8)');
      gg.addColorStop(1, 'rgba(255,255,255,0)');
      ctx2.fillStyle = gg;
      ctx2.fillRect(0, 0, size, size);
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, size, size);
      ctx.globalCompositeOperation = 'destination-in';
      ctx.drawImage(c2, 0, 0);
      const t = finishTexture(c);
      t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
      return t;
    });
  },

  // Soft blobby noise for drifting cloud shadows (linear, tiling).
  cloudNoise() {
    return cachedTex('cloudNoise', () => {
      const size = 128;
      const rnd = mulberry32(777);
      const c = makeCanvas(size);
      const ctx = c.getContext('2d');
      ctx.fillStyle = 'rgb(0,0,0)';
      ctx.fillRect(0, 0, size, size);
      // Wrapping blobs: draw each at 4 mirrored positions for seamless tiling.
      for (let i = 0; i < 26; i++) {
        const x = rnd() * size, y = rnd() * size;
        const r = 14 + rnd() * 34;
        const a = 0.14 + rnd() * 0.22;
        for (const ox of [-size, 0, size]) {
          for (const oy of [-size, 0, size]) {
            const g = ctx.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
            g.addColorStop(0, `rgba(255,255,255,${a})`);
            g.addColorStop(1, 'rgba(255,255,255,0)');
            ctx.fillStyle = g;
            ctx.fillRect(x + ox - r, y + oy - r, r * 2, r * 2);
          }
        }
      }
      return finishTexture(c, { srgb: false });
    });
  },

  flame() {
    return cachedTex('flame', () => {
      const size = 128;
      const c = makeCanvas(size);
      const ctx = c.getContext('2d');
      const g = ctx.createRadialGradient(size / 2, size * 0.62, 4, size / 2, size * 0.55, size * 0.5);
      g.addColorStop(0, 'rgba(255,240,190,1)');
      g.addColorStop(0.35, 'rgba(255,150,50,0.9)');
      g.addColorStop(0.7, 'rgba(220,60,20,0.45)');
      g.addColorStop(1, 'rgba(120,20,10,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, size, size);
      const t = finishTexture(c);
      t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
      return t;
    });
  },
};

// ---------------------------------------------------------------------------
// Shared materials (lazy singletons, curvature applied)
// ---------------------------------------------------------------------------

function cachedMat(key, maker) {
  if (!matCache.has(key)) matCache.set(key, maker());
  return matCache.get(key);
}

export const Mats = {
  stone: () =>
    cachedMat('stone', () => {
      const { map, bumpMap } = Tex.masonry();
      return makeMat({ map, bumpMap, bumpScale: 2.2, roughness: 0.94, metalness: 0 });
    }),
  stoneDark: () =>
    cachedMat('stoneDark', () => {
      const ph = photoOpts('rock', 2.6, 2.6, { color: 0xcfc6ba, normalScaleV: 1.4 });
      if (ph) return makeMat(ph);
      const { map, bumpMap } = Tex.masonry({ seed: 19 });
      return makeMat({ map, bumpMap, bumpScale: 2.2, color: 0x9a938a, roughness: 0.96, metalness: 0 });
    }),
  ashlar: () =>
    cachedMat('ashlar', () => {
      const { map, bumpMap } = Tex.ashlar();
      return makeGroundMat({ map, bumpMap, bumpScale: 1.8, roughness: 0.95, metalness: 0 });
    }),
  path: () =>
    cachedMat('path', () =>
      makeGroundMat(photoOpts('path', 3.4, 15, { normalScaleV: 1.5 }) || { map: Tex.gravel(), roughness: 1, metalness: 0 })
    ),
  grass: () =>
    cachedMat('grass', () =>
      makeGroundMat(photoOpts('grassrock', 3.8, 13, { color: 0xcde2b4, normalScaleV: 1.4 }) || { map: Tex.grass(), roughness: 1, metalness: 0 })
    ),
  puna: () =>
    cachedMat('puna', () =>
      makeGroundMat(
        photoOpts('grassrock', 3.8, 13, { color: 0xcdb579, normalScaleV: 1.4 }) ||
        { map: Tex.grass({ base: [132, 112, 56] }), roughness: 1, metalness: 0 }
      )
    ),
  earth: () =>
    cachedMat('earth', () => makeGroundMat({ map: Tex.earth(), roughness: 1, metalness: 0 })),
  gold: () =>
    cachedMat('gold', () =>
      makeMat({
        map: Tex.gold(), metalness: 0.75, roughness: 0.34,
        emissive: 0x3a2606, emissiveIntensity: 0.4,
      })
    ),
  coinGold: () =>
    cachedMat('coinGold', () =>
      makeMat({
        map: Tex.gold(), metalness: 1.0, roughness: 0.12,
        emissive: 0xffc040, emissiveIntensity: 0.7,
      })
    ),
  wood: () =>
    cachedMat('wood', () => makeMat({ map: Tex.wood(), roughness: 0.9, metalness: 0 })),
  snow: () =>
    cachedMat('snow', () => makeMat({ map: Tex.snow(), roughness: 0.85, metalness: 0 })),
  thatch: () =>
    cachedMat('thatch', () => makeMat({ map: Tex.thatch(), roughness: 1, metalness: 0 })),
  cloth: (colors) => {
    const key = 'cloth:' + (colors ? colors.join(',') : 'default');
    return cachedMat(key, () =>
      makeMat({ map: Tex.woven(colors), roughness: 0.92, metalness: 0 })
    );
  },
};

export function disposeAll() {
  for (const t of texCache.values()) {
    if (t.map) { t.map.dispose(); t.bumpMap && t.bumpMap.dispose(); }
    else t.dispose && t.dispose();
  }
  for (const m of matCache.values()) m.dispose();
  texCache.clear();
  matCache.clear();
}
