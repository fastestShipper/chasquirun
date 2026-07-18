// Splat-mapped terrain for the stylized-realism pass. One shared
// ShaderMaterial blends three photo ground layers (grass / dirt path / rock)
// by slope, low-frequency noise and a painted per-vertex dirt mask.
// UVs are world-anchored (position-based, TILE-meter tiles) so chunks placed
// anywhere tile seamlessly with no UV authoring. Includes the shared
// curved-world bend, the drifting cloud shadows from materials.js, manual
// scene-compatible fog and tangent-free normal mapping.
//
// Exports: makeSplatMaterial, setEnv, setWorldOrigin, makeTerrainGeometry,
// dispose.

import * as THREE from 'three';
import { CONFIG } from './config.js';
import { Curve, AnimU, Tex } from './materials.js';

// Meters per texture tile; ground UV = (worldPos.xz - uWorldOrigin) / TILE.
const TILE = 4;
// setWorldOrigin wraps at WRAP meters so UVs stay small (fp32-safe on long
// runs). WRAP / TILE = 36 tiles, an exact multiple of both noise lattice
// periods below (9 and 27), so a rewrap lands on the identical pattern.
const WRAP = 144;

// Environment uniforms live at module scope so setEnv / setWorldOrigin work
// whether or not the material exists yet. Color values are linear
// (THREE.Color applies color management to hex input).
const U = {
  uWorldOrigin: { value: new THREE.Vector2(0, 0) },
  uSunDir: { value: new THREE.Vector3(0.35, 0.8, 0.49).normalize() },
  uSunColor: { value: new THREE.Color(1.05, 0.98, 0.86) },
  uHemi: { value: new THREE.Color(0.55, 0.63, 0.74) },
  uFogColor: { value: new THREE.Color(CONFIG.colors.fogValley) },
  uFogNear: { value: 90 },
  uFogFar: { value: 400 },
  uGrassTint: { value: new THREE.Color(0xcde2b4) }, // matches Mats.grass
  uDirtTint: { value: new THREE.Color(0xffffff) },
  uRockTint: { value: new THREE.Color(0xcfc6ba) }, // matches Mats.stoneDark
  uNormalScale: { value: 1.2 },
};

const TERRAIN_VERT = /* glsl */ `
uniform float uCurveY;
uniform float uCurveX;
uniform vec2 uWorldOrigin;

attribute float dirtMask;

varying vec2 vGroundUV;
varying vec2 vCloudXZ;
varying vec3 vNormalW;
varying vec3 vWorldPos;
varying float vDirt;
varying float vFogDepth;

void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  // Assumes uniform mesh scale (terrain meshes are placed, not stretched).
  vNormalW = normalize(mat3(modelMatrix) * normal);
  vCloudXZ = wp.xz;
  vGroundUV = (wp.xz - uWorldOrigin) * ${(1 / TILE).toFixed(6)};
  vDirt = dirtMask;

  vec4 mvPosition = viewMatrix * wp;
  // Shared curved-world bend (must match materials.js).
  mvPosition.y += uCurveY * mvPosition.z * mvPosition.z;
  mvPosition.x += uCurveX * mvPosition.z * mvPosition.z;
  vFogDepth = -mvPosition.z;
  gl_Position = projectionMatrix * mvPosition;
}
`;

const TERRAIN_FRAG = /* glsl */ `
uniform sampler2D uGrassMap;
uniform sampler2D uGrassNor;
uniform sampler2D uDirtMap;
uniform sampler2D uDirtNor;
uniform sampler2D uRockMap;
uniform sampler2D uRockNor;
uniform sampler2D uCloudTex;
uniform vec2 uCloudOff;
uniform float uCloudAmt;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uHemi;
uniform vec3 uFogColor;
uniform float uFogNear;
uniform float uFogFar;
uniform vec3 uGrassTint;
uniform vec3 uDirtTint;
uniform vec3 uRockTint;
uniform float uNormalScale;

varying vec2 vGroundUV;
varying vec2 vCloudXZ;
varying vec3 vNormalW;
varying vec3 vWorldPos;
varying float vDirt;
varying float vFogDepth;

float hash2(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

// Value noise on a lattice wrapped at rep cells. The world-origin rewrap
// shifts these coords by an exact multiple of rep, landing on the same
// pattern, so the wrap never shows.
float pnoise(vec2 p, float rep) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash2(mod(i, rep));
  float b = hash2(mod(i + vec2(1.0, 0.0), rep));
  float c = hash2(mod(i + vec2(0.0, 1.0), rep));
  float d = hash2(mod(i + vec2(1.0, 1.0), rep));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// Tangent-free normal mapping: build the tangent frame from screen-space
// derivatives of world position and ground UV (three.js style).
vec3 perturbNormal(vec3 pos, vec3 N, vec3 mapN, vec2 st) {
  vec3 q0 = dFdx(pos);
  vec3 q1 = dFdy(pos);
  vec2 st0 = dFdx(st);
  vec2 st1 = dFdy(st);
  vec3 q1perp = cross(q1, N);
  vec3 q0perp = cross(N, q0);
  vec3 T = q1perp * st0.x + q0perp * st1.x;
  vec3 B = q1perp * st0.y + q0perp * st1.y;
  float det = max(dot(T, T), dot(B, B));
  float scale = (det == 0.0) ? 0.0 : inversesqrt(det);
  return normalize(T * (mapN.x * scale) + B * (mapN.y * scale) + N * mapN.z);
}

void main() {
  vec3 Ng = normalize(vNormalW);
  vec2 st = vGroundUV;

  // Blend weights: slope pushes rock, the painted mask pushes dirt,
  // low-frequency noise breaks both borders up (ALU only, no fetch).
  float bn = pnoise(st * 0.25, 9.0) * 0.65 + pnoise(st * 0.75, 27.0) * 0.35;
  float slope = 1.0 - Ng.y;
  float wRock = smoothstep(0.47, 0.62, slope + (bn - 0.5) * 0.24);
  float wDirt = smoothstep(0.32, 0.68, vDirt + (bn - 0.5) * 0.30) * (1.0 - wRock);
  float wGrass = 1.0 - wRock - wDirt;

  // Budget: 3 diffuse + 3 normal fetches (rock at half frequency: larger,
  // calmer features on steep faces; the wrap jump stays an exact tile count).
  vec3 alb = texture2D(uGrassMap, st).rgb * uGrassTint * wGrass
           + texture2D(uDirtMap, st).rgb * uDirtTint * wDirt
           + texture2D(uRockMap, st * 0.5).rgb * uRockTint * wRock;
  vec3 nm = texture2D(uGrassNor, st).xyz * wGrass
          + texture2D(uDirtNor, st).xyz * wDirt
          + texture2D(uRockNor, st * 0.5).xyz * wRock;

  // Large-scale patchiness kills the tiling read at distance.
  alb *= 0.9 + 0.2 * bn;

  vec3 mapN = nm * 2.0 - 1.0;
  mapN.xy *= uNormalScale;
  vec3 N = perturbNormal(vWorldPos, Ng, mapN, st);

  // Drifting cloud shadows, identical to the materials.js ground patch.
  float cs = texture2D(uCloudTex, vCloudXZ * 0.0045 + uCloudOff).r;
  alb *= 1.0 - uCloudAmt * smoothstep(0.45, 0.85, cs);

  // Lambert-ish: hemisphere ambient + one directional sun.
  float ndl = max(dot(N, uSunDir), 0.0);
  vec3 col = alb * (uHemi * (0.55 + 0.45 * N.y) + uSunColor * ndl);

  // Manual fog (material.fog is off; uniforms synced via setEnv).
  float fogF = smoothstep(uFogNear, uFogFar, vFogDepth);
  col = mix(col, uFogColor, fogF);

  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

let splatMat = null;

function loadTex(loader, file, srgb) {
  const t = loader.load('assets/tex/' + file);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4; // renderer clamps to device max
  return t;
}

// Singleton splat material shared by every terrain mesh.
export function makeSplatMaterial() {
  if (splatMat) return splatMat;
  const loader = new THREE.TextureLoader();
  splatMat = new THREE.ShaderMaterial({
    name: 'TerrainSplat',
    uniforms: {
      ...U,
      uCurveY: Curve.uniforms.uCurveY,
      uCurveX: Curve.uniforms.uCurveX,
      uCloudOff: AnimU.cloudOff,
      uCloudAmt: AnimU.cloudAmt,
      uCloudTex: { value: Tex.cloudNoise() },
      uGrassMap: { value: loadTex(loader, 'grassrock_diff.jpg', true) },
      uGrassNor: { value: loadTex(loader, 'grassrock_nor.jpg', false) },
      uDirtMap: { value: loadTex(loader, 'path_diff.jpg', true) },
      uDirtNor: { value: loadTex(loader, 'path_nor.jpg', false) },
      uRockMap: { value: loadTex(loader, 'rock_diff.jpg', true) },
      uRockNor: { value: loadTex(loader, 'rock_nor.jpg', false) },
    },
    vertexShader: TERRAIN_VERT,
    fragmentShader: TERRAIN_FRAG,
    fog: false, // manual fog via uFog*, synced in setEnv
  });
  return splatMat;
}

// Per-frame environment sync (call once per frame from the integrator).
// All fields optional; copies into existing uniform objects, no allocation.
// sunDir points from the surface TOWARD the sun. sunColor / hemiColor should
// arrive premultiplied by light intensity (see integration notes).
export function setEnv(env = {}) {
  if (env.sunDir) U.uSunDir.value.copy(env.sunDir).normalize();
  if (env.sunColor) U.uSunColor.value.copy(env.sunColor);
  if (env.hemiColor) U.uHemi.value.copy(env.hemiColor);
  if (env.fogColor) U.uFogColor.value.copy(env.fogColor);
  if (env.fogNear !== undefined) U.uFogNear.value = env.fogNear;
  if (env.fogFar !== undefined) U.uFogFar.value = env.fogFar;
}

// Anchor the ground pattern to the moving worldGroup: pass
// worldGroup.position.x / .z once per frame so textures ride the ground
// instead of crawling under it. Wrapped internally (invisibly) at WRAP.
export function setWorldOrigin(x, z) {
  U.uWorldOrigin.value.set(
    x - WRAP * Math.floor(x / WRAP),
    z - WRAP * Math.floor(z / WRAP)
  );
}

// Displaced ground patch: origin centered, rotated flat (+Y up), spans
// [-width/2, width/2] in x and [-depth/2, depth/2] in z. height(x, z) and
// dirtMask(x, z) receive local coordinates; dirtMask is clamped to [0, 1]
// and stored as the 'dirtMask' vertex attribute the splat shader reads.
export function makeTerrainGeometry({
  width = 36,
  depth = 36,
  segsW = 24,
  segsD = 24,
  height = null,
  dirtMask = null,
} = {}) {
  const geo = new THREE.PlaneGeometry(
    width, depth, Math.max(1, segsW | 0), Math.max(1, segsD | 0)
  );
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const mask = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    // Always write Y: zeroes the ~1e-16 rotateX residue when height is null.
    pos.setY(i, height ? height(x, z) : 0);
    if (dirtMask) {
      const m = dirtMask(x, z);
      mask[i] = m < 0 ? 0 : m > 1 ? 1 : m;
    }
  }
  geo.setAttribute('dirtMask', new THREE.BufferAttribute(mask, 1));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

// Disposes the singleton material and the six textures it loaded. The shared
// cloud-noise texture belongs to materials.js and is left alone.
export function dispose() {
  if (!splatMat) return;
  const u = splatMat.uniforms;
  for (const k of ['uGrassMap', 'uGrassNor', 'uDirtMap', 'uDirtNor', 'uRockMap', 'uRockNor']) {
    if (u[k].value) u[k].value.dispose();
  }
  splatMat.dispose();
  splatMat = null;
}
