// Glacial Andean water: rivers and lakes, each built as a SURFACE plus a BED.
//
// The reason the old water read as a painted stripe was not the shader. It was
// that there was nothing underneath it. Water only looks like water when you
// can see INTO it, and a translucent sheet over flat ground has nothing to see.
// So every water body is now a two mesh group built in one factory call:
//
//   bed     opaque gravel/silt channel that dips in the middle, carries
//           scattered stones, rises into a wet gravel margin at the bank and
//           then plunges so its outer edge is buried under the terrain.
//   surface the animated shader plane, whose `aShore` attribute is baked from
//           the SAME bed height function, so transparency, colour and foam
//           track the real depth instead of a guess.
//
// Because both meshes come out of one call they can never drift apart.
//
// The other half of the read is the SHORE. Real water goes pale, shallow and
// see-through where it meets the bank and deep and saturated further out. The
// `aShore` attribute is 0 at the waterline and 1 out in the deep channel; it
// drives colour, opacity and the foam band.
//
// Surface detail is carried by the NORMAL, not by vertex displacement. High
// frequency vertex waves would need a dense mesh to survive; perturbing the
// normal costs nothing per vertex and gives the specular breakup that makes a
// surface read as liquid at any distance.
//
// TILING: chunk geometry is baked once and POOLED, reused at many world
// positions, so everything baked here must tile seamlessly in z. The bed height
// field samples noise around a circle of circumference `period`, exactly the
// trick track.js uses for its terrain heightfield, which makes the field
// periodic in z. Bed geometry spans exactly one period so adjacent chunks meet
// edge to edge with no overlap and no z-fighting.

import * as THREE from 'three';
import { CONFIG } from './config.js';
import { clamp, smoothstep, mulberry32, TAU } from './util.js';
import { Curve, Tex, makeMat } from './materials.js';
import { SimplexNoise } from 'three/addons/math/SimplexNoise.js';

const WATER_VERT = /* glsl */ `
uniform float uTime;
uniform float uCurveY;
uniform float uCurveX;
attribute float aShore;
varying vec3 vWorldPos;
varying vec3 vNormal;
varying vec2 vLocal;
varying float vFogDepth;
varying float vShore;

void main() {
  vec3 p = position;
  float t = uTime;
  // Big slow swell only. Everything finer lives in the fragment normal.
  vec2 d2 = vec2(0.32, 0.61);
  vec2 d3 = vec2(-0.55, 0.38);
  float p1 = p.x * 0.85 + t * 1.4;
  float p2 = dot(p.xz, d2) + t * 0.9;
  float p3 = dot(p.xz, d3) + t * 1.8;
  // Swell is damped to nothing at the bank so the waterline never lifts off
  // the bed and shows a gap under itself.
  float amp = aShore;
  float a1 = 0.040 * amp;
  float a2 = 0.055 * amp;
  float a3 = 0.030 * amp;
  p.y += a1 * sin(p1) + a2 * sin(p2) + a3 * sin(p3);

  float dhdx = a1 * 0.85 * cos(p1) + a2 * d2.x * cos(p2) + a3 * d3.x * cos(p3);
  float dhdz = a2 * d2.y * cos(p2) + a3 * d3.y * cos(p3);
  vNormal = normalize(mat3(modelMatrix) * normalize(vec3(-dhdx, 1.0, -dhdz)));
  vLocal = position.xz;
  vShore = aShore;

  vec4 wp = modelMatrix * vec4(p, 1.0);
  vWorldPos = wp.xyz;
  vec4 mvPosition = viewMatrix * wp;
  // Shared curved-world bend (must match materials.js exactly).
  mvPosition.y += uCurveY * mvPosition.z * mvPosition.z;
  mvPosition.x += uCurveX * mvPosition.z * mvPosition.z;
  vFogDepth = -mvPosition.z;
  gl_Position = projectionMatrix * mvPosition;
}
`;

const WATER_FRAG = /* glsl */ `
uniform vec3 uShallow;
uniform vec3 uDeep;
uniform vec3 uSky;
uniform vec3 uSunColor;
uniform vec3 uSunDir;
uniform vec3 uFogColor;
uniform float uFogNear;
uniform float uFogFar;
uniform float uTime;
uniform float uOpacity;
uniform float uFlow;
varying vec3 vWorldPos;
varying vec3 vNormal;
varying vec2 vLocal;
varying float vFogDepth;
varying float vShore;

float hash21(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x),
    mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}

// Ripple field. The trap here is that a sum of directional sine waves lines up
// into clean parallel bands and reads as combed hair, not water. Two things
// stop that: the domain is warped by a low frequency noise so no wavefront
// stays straight, and the total slope is kept tiny. Water is nearly flat; it
// is the SPECULAR response to small slopes that sells it, not big geometry.
vec2 ripples(vec2 uv, float t) {
  // Warp first: bends every wavefront into an irregular, braided flow.
  float w1 = vnoise(uv * 0.35 + vec2(t * 0.09, t * 0.13));
  float w2 = vnoise(uv * 0.52 - vec2(t * 0.07, t * 0.11));
  vec2 warped = uv + vec2(w1 - 0.5, w2 - 0.5) * 2.1;

  vec2 s = vec2(0.0);
  vec2 d1 = vec2(0.97, 0.26);
  vec2 d2 = vec2(-0.21, 0.98);
  vec2 d3 = vec2(0.66, -0.75);
  // Slope amplitude is a * f. Kept around 0.02 each so the surface stays
  // almost level and the highlights stay small and mobile.
  s += d1 * (0.0070 * 3.1 * cos(dot(warped, d1) * 3.1 + t * 1.6));
  s += d2 * (0.0042 * 5.3 * cos(dot(warped, d2) * 5.3 - t * 2.2));
  s += d3 * (0.0022 * 8.7 * cos(dot(warped, d3) * 8.7 + t * 3.1));
  return s;
}

void main() {
  float t = uTime;
  // The river runs: everything scrolls downstream, which is most of what
  // separates a river from a puddle.
  vec2 flowUV = vLocal + vec2(0.0, t * uFlow);

  // Perturb the swell normal with the fine ripple field.
  vec2 slope = ripples(flowUV, t);
  vec3 N = normalize(vNormal + vec3(-slope.x, 0.0, -slope.y));
  vec3 V = normalize(cameraPosition - vWorldPos);
  float ndv = max(dot(N, V), 0.0);
  float fres = pow(1.0 - ndv, 4.0);

  // Depth: pale and thin at the waterline, saturated glacial turquoise out in
  // the channel. vShore is baked from the real bed height, so this ramp
  // follows the actual channel, including where it meanders. The ramp is
  // deliberately long: if it saturates early the whole river goes one flat
  // tone again and the bed underneath might as well not exist.
  float depth = smoothstep(0.0, 0.88, vShore);
  vec3 col = mix(uShallow, uDeep, depth);

  // Sky reflection. Capped hard: water reflects the sky, it does not BECOME
  // the sky. At this camera height nearly every pixel of the river is at a
  // grazing angle, so a generous cap turns the whole surface into a pale sheen
  // and hides the bed that the rest of this module exists to show.
  col = mix(col, uSky, clamp(fres * 0.34, 0.0, 0.22));

  // Sun specular off the ripple normal. Because the normal actually moves,
  // this breaks into travelling glitter on its own instead of needing a
  // separate faked sparkle layer.
  // Fresnel-weighted, which is the whole point: water mirrors hard at grazing
  // angles and reflects about 2% head on. Without this weight, looking DOWN
  // into the gorge or the cliff canyon puts almost the entire surface inside
  // the sun's reflection lobe at once and the river blows out to a white
  // sheet. With it, the valley river keeps its full travelling glitter.
  float F = 0.02 + 0.98 * fres;
  vec3 H = normalize(V + uSunDir);
  float spec = pow(max(dot(N, H), 0.0), 300.0);
  col += uSunColor * spec * 2.0 * F;
  // A softer, wider sheen keeps the surface from going matte between glints.
  float sheen = pow(max(dot(N, H), 0.0), 48.0);
  col += uSunColor * sheen * 0.10 * F;

  // Shore foam: a soft broken band riding the waterline. Noise-bitten so it
  // never reads as a drawn stripe, and it is what hides the contact between
  // the surface and the bed.
  float fn = vnoise(flowUV * 2.4 + vec2(t * 0.35, t * 0.6));
  float fn2 = vnoise(flowUV * 5.5 - vec2(t * 0.5, t * 0.2));
  float band = 1.0 - smoothstep(0.0, 0.20, vShore);
  float foam = band * smoothstep(0.48, 0.92, fn * 0.65 + fn2 * 0.55);
  col = mix(col, vec3(0.93, 0.97, 0.99), foam * 0.7);

  // Alpha: genuinely see-through at the edge so the bed and its pebbles read
  // underneath, near opaque out in the channel. Foam is solid where it lands.
  float alpha = mix(0.03, uOpacity, depth);
  alpha = clamp(alpha + foam * 0.5, 0.0, 1.0);

  float fogF = smoothstep(uFogNear, uFogFar, vFogDepth);
  col = mix(col, uFogColor, fogF);

  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// ---------------------------------------------------------------------------
// Bed height fields
// ---------------------------------------------------------------------------

const _noise = new SimplexNoise();

// Noise that is EXACTLY periodic in z with the given period: z is mapped onto a
// circle of circumference `period` in noise space, so z and z + period sample
// the same point. Same trick as fbmHeight in track.js, and the only reason a
// pooled chunk can bake a bed at all.
function pnoise(x, z, period, freq, phase) {
  const R = period / TAU;
  const a = (z / period) * TAU;
  return _noise.noise3d((x + phase) * freq, Math.cos(a) * R * freq, Math.sin(a) * R * freq);
}

// Skirt: outside the waterline the bed rises into a wet gravel margin, then
// plunges hard so the geometry edge finishes well below the surrounding
// terrain and is never visible as a cut edge.
function skirtTerm(over, skirt, rise) {
  const s = clamp(over / skirt, 0, 1);
  return rise * smoothstep(0.0, 0.45, s) - 1.4 * smoothstep(0.55, 1.0, s);
}

function riverBed(half, depth, period, skirt) {
  const rise = 0.20;
  return function bedY(x, z) {
    // A constant width ribbon reads as a texture strip, so the channel both
    // meanders and breathes along its length. Both terms are periodic in z.
    const mid = pnoise(0, z, period, 0.055, 0) * half * 0.26;
    const wob = 1 + pnoise(0, z, period, 0.041, 91.3) * 0.20;
    const t = Math.abs(x - mid) / (half * wob);
    let y;
    if (t < 1) y = -depth * Math.pow(Math.cos(t * Math.PI * 0.5), 1.35);
    else y = rise * (1 - Math.exp(-(t - 1) * 2.5));
    const over = Math.abs(x) - half;
    if (over > 0) y += skirtTerm(over, skirt, rise);
    // Relief: coarse humps plus a fine gravel wobble.
    y += pnoise(x, z, period, 0.14, 5.1) * depth * 0.17;
    y += pnoise(x, z, period, 0.55, 17.7) * 0.05;
    return y;
  };
}

function lakeBed(waterline, radius, depth, skirt) {
  const rise = 0.18;
  return function bedY(x, z) {
    const r = Math.hypot(x, z);
    // Irregular shoreline: a perfect circle is as fake as a perfect ribbon.
    const wob = 1 + _noise.noise(x * 0.11, z * 0.11) * 0.10;
    const w = waterline * wob;
    const t = r / w;
    let y;
    if (t < 1) y = -depth * Math.pow(Math.cos(t * Math.PI * 0.5), 1.3);
    else y = rise * (1 - Math.exp(-(t - 1) * 2.5));
    const over = r - waterline;
    if (over > 0) y += skirtTerm(over, skirt, rise);
    y += _noise.noise(x * 0.17 + 11, z * 0.17 - 4) * depth * 0.16;
    y += _noise.noise(x * 0.7, z * 0.7) * 0.045;
    return y;
  };
}

// ---------------------------------------------------------------------------
// Bed geometry assembly
//
// Grid and stones go into ONE indexed BufferGeometry, so a whole riverbed with
// its boulders is a single draw call. BufferGeometryUtils is not vendored, so
// the merge is done by writing into shared arrays from the start.
// ---------------------------------------------------------------------------

// Multiplied over the gravel map. Dry bank, wet margin, and a deep tint that
// pulls what shows through the water toward the water colour, so a submerged
// bed never looks like a dry riverbed with a blue sheet laid over it.
// Held well under 1.0: at full brightness the gravel map reads as a white sand
// beach rather than a river bank.
const C_DRY = [0.84, 0.82, 0.76];
const C_WET = [0.50, 0.47, 0.43];
const C_DEEP = [0.17, 0.38, 0.40];

function bedColor(y, depth, out) {
  if (y >= 0) {
    // Above the waterline: dries out over the first 30 cm. This dark, damp
    // band right at the contact is what sells the bank meeting the water.
    const d = smoothstep(0.0, 0.30, y);
    out[0] = C_WET[0] + (C_DRY[0] - C_WET[0]) * d;
    out[1] = C_WET[1] + (C_DRY[1] - C_WET[1]) * d;
    out[2] = C_WET[2] + (C_DRY[2] - C_WET[2]) * d;
  } else {
    const d = Math.min(1, Math.pow(-y / Math.max(0.25, depth), 0.65));
    out[0] = C_WET[0] + (C_DEEP[0] - C_WET[0]) * d;
    out[1] = C_WET[1] + (C_DEEP[1] - C_WET[1]) * d;
    out[2] = C_WET[2] + (C_DEEP[2] - C_WET[2]) * d;
  }
}

// Four lumpy stone shapes, baked once at module scope and reused by every bed.
// Jitter is keyed by vertex position so shared corners move together and the
// solid never cracks open.
let _stoneShapes = null;
function stoneShapes() {
  if (_stoneShapes) return _stoneShapes;
  _stoneShapes = [];
  for (let s = 0; s < 4; s++) {
    const g = new THREE.IcosahedronGeometry(1, 0);
    const p = g.attributes.position;
    const rnd = mulberry32(1013 + s * 137);
    const seen = new Map();
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const key = x.toFixed(3) + ',' + y.toFixed(3) + ',' + z.toFixed(3);
      let j = seen.get(key);
      if (!j) {
        j = [0.70 + rnd() * 0.55, 0.70 + rnd() * 0.55, 0.70 + rnd() * 0.55];
        seen.set(key, j);
      }
      p.setXYZ(i, x * j[0], y * j[1], z * j[2]);
    }
    _stoneShapes.push(new Float32Array(p.array));
    g.dispose();
  }
  return _stoneShapes;
}

class BedBuilder {
  constructor(depth) {
    this.pos = [];
    this.uv = [];
    this.col = [];
    this.idx = [];
    this.depth = depth;
    this._c = [0, 0, 0];
  }

  _push(x, y, z, u, v) {
    this.pos.push(x, y, z);
    this.uv.push(u, v);
    bedColor(y, this.depth, this._c);
    this.col.push(this._c[0], this._c[1], this._c[2]);
  }

  // Rectangular bed grid (rivers).
  strip(x0, x1, nx, z0, z1, nz, bedY, uvScale) {
    const base = this.pos.length / 3;
    for (let iz = 0; iz <= nz; iz++) {
      const z = z0 + (z1 - z0) * (iz / nz);
      for (let ix = 0; ix <= nx; ix++) {
        const x = x0 + (x1 - x0) * (ix / nx);
        this._push(x, bedY(x, z), z, x * uvScale, z * uvScale);
      }
    }
    const row = nx + 1;
    for (let iz = 0; iz < nz; iz++) {
      for (let ix = 0; ix < nx; ix++) {
        const a = base + iz * row + ix;
        this.idx.push(a, a + row, a + 1, a + 1, a + row, a + row + 1);
      }
    }
  }

  // Polar bed grid (lakes). Centre vertex plus rings, so no degenerate faces.
  disc(radius, rings, segs, bedY, uvScale) {
    const base = this.pos.length / 3;
    this._push(0, bedY(0, 0), 0, 0, 0);
    for (let ir = 1; ir <= rings; ir++) {
      const r = radius * (ir / rings);
      for (let is = 0; is < segs; is++) {
        const a = (is / segs) * TAU;
        const x = Math.cos(a) * r, z = Math.sin(a) * r;
        this._push(x, bedY(x, z), z, x * uvScale, z * uvScale);
      }
    }
    const ringStart = (ir) => base + 1 + (ir - 1) * segs;
    for (let is = 0; is < segs; is++) {
      const n = (is + 1) % segs;
      this.idx.push(base, ringStart(1) + n, ringStart(1) + is);
    }
    for (let ir = 1; ir < rings; ir++) {
      const a0 = ringStart(ir), a1 = ringStart(ir + 1);
      for (let is = 0; is < segs; is++) {
        const n = (is + 1) % segs;
        this.idx.push(a0 + is, a1 + n, a1 + is, a0 + is, a0 + n, a1 + n);
      }
    }
  }

  // One lumpy stone, transformed and appended. Kept non-shared so it stays
  // faceted after computeVertexNormals.
  stone(shape, cx, cy, cz, sx, sy, sz, yaw, tilt) {
    const cy1 = Math.cos(yaw), sy1 = Math.sin(yaw);
    const ct = Math.cos(tilt), st = Math.sin(tilt);
    const base = this.pos.length / 3;
    for (let i = 0; i < shape.length; i += 3) {
      let px = shape[i] * sx, py = shape[i + 1] * sy, pz = shape[i + 2] * sz;
      // Tilt about X, then yaw about Y.
      const ty = py * ct - pz * st;
      const tz = py * st + pz * ct;
      py = ty;
      pz = tz;
      const rx = px * cy1 + pz * sy1;
      const rz = -px * sy1 + pz * cy1;
      this._push(cx + rx, cy + py, cz + rz, (cx + rx) * 0.55, (cz + rz) * 0.55);
    }
    const n = shape.length / 3;
    for (let i = 0; i < n; i++) this.idx.push(base + i);
  }

  build() {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    geo.setIndex(this.pos.length / 3 > 65535
      ? new THREE.Uint32BufferAttribute(this.idx, 1)
      : new THREE.Uint16BufferAttribute(this.idx, 1));
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    return geo;
  }
}

export class WaterSystem {
  constructor() {
    this._time = 0;
    this._meshes = [];   // surface meshes only (fog sync reads the first)
    this._groups = [];   // every group handed out, for dispose
    this._geos = [];     // every geometry created here, for dispose
    this._seed = 1;
    this._skyTint = new THREE.Color(0x6ea8d8);

    this._mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uCurveY: Curve.uniforms.uCurveY,
        uCurveX: Curve.uniforms.uCurveX,
        // Shallow is a pale, almost milky glacial rinse; deep is the Laguna 69
        // turquoise. The gap between them is what gives the channel its read.
        uShallow: { value: new THREE.Color(0x8fd8cf) },
        uDeep: { value: new THREE.Color(0x07576a) },
        uSky: { value: new THREE.Color(0x6ea8d8) },
        uSunColor: { value: new THREE.Color(1.0, 0.92, 0.72) },
        uSunDir: { value: new THREE.Vector3(0.3, 0.8, -0.5).normalize() },
        uFogColor: { value: new THREE.Color(CONFIG.colors.fogValley) },
        uFogNear: { value: 60 },
        uFogFar: { value: 180 },
        // Measured on screen, not guessed. Above about 0.8 the deep channel
        // goes solid and the bed might as well not be there; the water goes
        // back to reading as a painted sheet. 0.68 keeps body in the channel
        // while submerged cobbles still show through it.
        uOpacity: { value: 0.68 },
        uFlow: { value: 0.85 }, // downstream scroll, metres per second
      },
      vertexShader: WATER_VERT,
      fragmentShader: WATER_FRAG,
      transparent: true,
      // Transparent water must not write depth or it punches holes in whatever
      // is drawn behind it, including the bed and its own foam.
      depthWrite: false,
      side: THREE.FrontSide,
      fog: false,
    });

    // One shared bed material for every water body in the world: a single
    // gravel map modulated entirely by baked vertex colour, so wet margin,
    // shallow pebbles and deep tint all come free of extra draw state.
    this._bedMat = makeMat({
      map: Tex.gravel(),
      vertexColors: true,
      roughness: 0.78,
      metalness: 0,
    });
  }

  // Bake the shore attribute straight from the bed height field, so surface
  // transparency and the real channel can never disagree.
  _bakeShore(geo, bedY, falloff) {
    const pos = geo.attributes.position;
    const n = pos.count;
    const shore = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      shore[i] = clamp(-bedY(pos.getX(i), pos.getZ(i)) / falloff, 0, 1);
    }
    geo.setAttribute('aShore', new THREE.BufferAttribute(shore, 1));
  }

  _assemble(surfGeo, bedGeo) {
    surfGeo.computeBoundingSphere();
    surfGeo.boundingSphere.radius += 1.5; // waves displace vertices slightly

    const group = new THREE.Group();
    const bed = new THREE.Mesh(bedGeo, this._bedMat);
    bed.receiveShadow = true;
    bed.matrixAutoUpdate = false;
    bed.updateMatrix();
    group.add(bed);

    const surf = new THREE.Mesh(surfGeo, this._mat);
    surf.matrixAutoUpdate = false;
    surf.updateMatrix();
    group.add(surf);

    this._meshes.push(surf);
    this._groups.push(group);
    this._geos.push(surfGeo, bedGeo);
    return group;
  }

  // Stones scattered over the bed. Two thirds sit in the channel as submerged
  // cobbles, one third clusters on the banks where the bigger ones break the
  // surface. Kept clear of the z seam so pooled chunks never cut one in half.
  _scatterStones(b, rnd, count, halfX, skirt, z0, z1, bedY) {
    const shapes = stoneShapes();
    for (let i = 0; i < count; i++) {
      const bank = rnd() > 0.62;
      const x = bank
        ? (rnd() < 0.5 ? -1 : 1) * (halfX * 0.72 + rnd() * (skirt * 0.7 + halfX * 0.26))
        : (rnd() * 2 - 1) * halfX * 0.95;
      const z = z0 + rnd() * (z1 - z0);
      const s = bank
        ? 0.17 + rnd() * rnd() * 0.78
        : 0.09 + rnd() * rnd() * 0.44;
      const sx = s * (0.85 + rnd() * 0.5);
      const sy = s * (0.52 + rnd() * 0.48);
      const sz = s * (0.85 + rnd() * 0.5);
      b.stone(
        shapes[(rnd() * shapes.length) | 0],
        x, bedY(x, z) + sy * 0.34, z,
        sx, sy, sz,
        rnd() * TAU, (rnd() - 0.5) * 0.5
      );
    }
  }

  // `period` is the chunk stride the bed must tile at. It defaults to `length`,
  // which is right for a standalone river but wrong inside a pooled chunk where
  // the water plane deliberately overhangs the chunk; pass the chunk length.
  makeRiver({ width = 8, length = 36, period = 0, depth = 0, detail = 1 } = {}) {
    const half = width * 0.5;
    const per = period > 0 ? period : length;
    // Andean rivers are shallow and rocky. A deep channel sounds better but
    // saturates the depth ramp across most of the width, which is exactly the
    // flat-stripe read this whole system exists to kill.
    const dep = depth > 0 ? depth : clamp(width * 0.115, 0.35, 1.8);
    const skirt = 1.5;
    const bedY = riverBed(half, dep, per, skirt);

    // Surface. Denser across the stream so the shore ramp has vertices to live
    // on, and dense enough along it to resolve the meander.
    const ws = Math.max(12, Math.round(width / 0.55));
    const ls = Math.max(18, Math.round(length / 1.1));
    const surfGeo = new THREE.PlaneGeometry(width, length, ws, ls);
    surfGeo.rotateX(-Math.PI / 2);
    this._bakeShore(surfGeo, bedY, dep * 0.90);

    // Bed spans exactly one period so neighbouring chunks tile edge to edge.
    const b = new BedBuilder(dep);
    const outer = half + skirt;
    const nx = Math.max(8, Math.round((outer * 2) / (0.55 / detail)));
    const nz = Math.max(8, Math.round(per / (1.1 / detail)));
    // Integer UV repeats over one period, or the gravel seams at every chunk.
    const uvScale = Math.max(1, Math.round(per * 0.28)) / per;
    b.strip(-outer, outer, nx, -per / 2, per / 2, nz, bedY, uvScale);
    const rnd = mulberry32((this._seed++ * 2654435761) >>> 0);
    const stones = Math.round(width * per * 0.085 * detail);
    this._scatterStones(b, rnd, stones, half, skirt, -per / 2 + 1.0, per / 2 - 1.0, bedY);

    return this._assemble(surfGeo, b.build());
  }

  // `waterline` is where the bed actually reaches the surface; the ring goes
  // out to `radius` but everything past the waterline bakes to shore 0 and
  // fades out, which lets the plane hide under the surrounding terrain.
  makeLake({ radius = 30, waterline = 0, depth = 0, detail = 1 } = {}) {
    const wl = waterline > 0 ? waterline : radius * 0.84;
    const dep = depth > 0 ? depth : clamp(radius * 0.13, 0.5, 2.2);
    const skirt = Math.min(1.5, Math.max(0.4, radius - wl));
    const bedY = lakeBed(wl, radius, dep, skirt);

    const rings = Math.max(14, Math.round(radius / 1.0));
    const surfGeo = new THREE.RingGeometry(0.05, radius, 60, rings);
    surfGeo.rotateX(-Math.PI / 2);
    this._bakeShore(surfGeo, bedY, dep * 0.90);

    const b = new BedBuilder(dep);
    const outer = wl + skirt;
    b.disc(outer, Math.max(8, Math.round(outer / (0.8 / detail))), 52, bedY, 0.28);
    const rnd = mulberry32((this._seed++ * 2654435761) >>> 0);
    const stones = Math.round(Math.PI * outer * outer * 0.05 * detail);
    const shapes = stoneShapes();
    for (let i = 0; i < stones; i++) {
      // Ring-biased sampling: sqrt keeps the density even over the disc, and
      // the bias pushes most of them toward the shallows where they show.
      const r = outer * Math.pow(rnd(), 0.42);
      const a = rnd() * TAU;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      const bank = r > wl * 0.74;
      const s = bank ? 0.16 + rnd() * rnd() * 0.7 : 0.09 + rnd() * rnd() * 0.38;
      const sy = s * (0.52 + rnd() * 0.48);
      b.stone(
        shapes[(rnd() * shapes.length) | 0],
        x, bedY(x, z) + sy * 0.34, z,
        s * (0.85 + rnd() * 0.5), sy, s * (0.85 + rnd() * 0.5),
        rnd() * TAU, (rnd() - 0.5) * 0.5
      );
    }

    return this._assemble(surfGeo, b.build());
  }

  setSunDir(vec3) {
    this._mat.uniforms.uSunDir.value.copy(vec3).normalize();
  }

  update(dt) {
    // Wrap hourly: keeps the fract/sin sparkle hash precise on long sessions.
    // The once-per-hour phase jump on the slow sine waves is imperceptible.
    this._time = (this._time + dt) % 14400;
    const u = this._mat.uniforms;
    u.uTime.value = this._time;

    // Sync manual fog uniforms from the scene the meshes live in.
    const first = this._meshes[0];
    if (first) {
      let o = first;
      let guard = 0;
      while (o.parent && guard++ < 32) o = o.parent;
      if (o.isScene && o.fog && o.fog.isFog) {
        u.uFogColor.value.copy(o.fog.color);
        u.uFogNear.value = o.fog.near;
        u.uFogFar.value = o.fog.far;
        // Grazing-angle sky tint follows the horizon/fog color.
        // Follow the horizon only slightly. Copying the pale fog colour in
        // wholesale is what bleached the surface in the first place.
        u.uSky.value.copy(this._skyTint).lerp(o.fog.color, 0.18);
      }
    }
  }

  dispose() {
    for (const g of this._groups) if (g.parent) g.parent.remove(g);
    for (const geo of this._geos) geo.dispose();
    this._groups.length = 0;
    this._geos.length = 0;
    this._meshes.length = 0;
    this._mat.dispose();
    // Tex.gravel() is a shared cached texture owned by materials.js; only the
    // material instance created here is ours to free.
    this._bedMat.dispose();
  }
}
