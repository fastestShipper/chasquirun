// Glacial Andean water: rivers and lakes sharing one animated ShaderMaterial.
// Vertex waves + shared world curvature; fresnel teal, sparkle and sun glint.

import * as THREE from 'three';
import { CONFIG } from './config.js';
import { Curve } from './materials.js';

const WATER_VERT = /* glsl */ `
uniform float uTime;
uniform float uCurveY;
uniform float uCurveX;
varying vec3 vWorldPos;
varying vec3 vNormal;
varying vec2 vLocal;
varying float vFogDepth;

void main() {
  vec3 p = position;
  float t = uTime;
  // Three overlapping traveling waves, small amplitudes, distinct headings.
  vec2 d2 = vec2(0.32, 0.61);
  vec2 d3 = vec2(-0.55, 0.38);
  float p1 = p.x * 0.85 + t * 1.4;
  float p2 = dot(p.xz, d2) + t * 0.9;
  float p3 = dot(p.xz, d3) + t * 1.8;
  float a1 = 0.045;
  float a2 = 0.06;
  float a3 = 0.035;
  p.y += a1 * sin(p1) + a2 * sin(p2) + a3 * sin(p3);
  // Analytic wave normal.
  float dhdx = a1 * 0.85 * cos(p1) + a2 * d2.x * cos(p2) + a3 * d3.x * cos(p3);
  float dhdz = a2 * d2.y * cos(p2) + a3 * d3.y * cos(p3);
  vNormal = normalize(mat3(modelMatrix) * normalize(vec3(-dhdx, 1.0, -dhdz)));
  vLocal = position.xz;

  vec4 wp = modelMatrix * vec4(p, 1.0);
  vWorldPos = wp.xyz;
  vec4 mvPosition = viewMatrix * wp;
  // Shared curved-world bend (must match materials.js).
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
varying vec3 vWorldPos;
varying vec3 vNormal;
varying vec2 vLocal;
varying float vFogDepth;

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

void main() {
  vec3 N = normalize(vNormal);
  vec3 V = normalize(cameraPosition - vWorldPos);
  float ndv = max(dot(N, V), 0.0);
  float fres = pow(1.0 - ndv, 3.0);

  // Deep teal looking straight down, shallow teal + sky tint at grazing angles.
  vec3 col = mix(uDeep, uShallow, 0.55 - 0.35 * fres);
  col = mix(col, uSky, fres * 0.28);

  // Moving sparkle: two scrolling noise fields multiplied, sharpened.
  vec2 suv = vLocal * 1.7;
  float n1 = vnoise(suv * 3.1 + vec2(uTime * 0.55, uTime * 0.22));
  float n2 = vnoise(suv * 4.3 + vec2(-uTime * 0.40, uTime * 0.60));
  float sp = pow(max(n1 * n2, 0.0), 9.0) * 5.0;
  col += uSky * sp * 0.5 + vec3(sp * 0.16);

  // Sun glint, Blinn-style.
  vec3 H = normalize(V + uSunDir);
  float glint = pow(max(dot(N, H), 0.0), 140.0);
  col += uSunColor * glint * (0.35 + 0.65 * fres) * 1.6;

  // Manual fog (material.fog is off; uniforms synced from scene.fog).
  float fogF = smoothstep(uFogNear, uFogFar, vFogDepth);
  col = mix(col, uFogColor, fogF);

  gl_FragColor = vec4(col, uOpacity);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export class WaterSystem {
  constructor() {
    this._time = 0;
    this._meshes = [];
    this._skyBright = new THREE.Color(0.90, 0.97, 1.0);

    this._mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uCurveY: Curve.uniforms.uCurveY,
        uCurveX: Curve.uniforms.uCurveX,
        uShallow: { value: new THREE.Color(CONFIG.colors.waterTeal) },
        uDeep: { value: new THREE.Color(CONFIG.colors.waterDeep) },
        uSky: { value: new THREE.Color(0xbfd8e6) },
        uSunColor: { value: new THREE.Color(1.0, 0.92, 0.72) },
        uSunDir: { value: new THREE.Vector3(0.3, 0.8, -0.5).normalize() },
        uFogColor: { value: new THREE.Color(CONFIG.colors.fogValley) },
        uFogNear: { value: 60 },
        uFogFar: { value: 180 },
        uOpacity: { value: 0.95 }, // milky glacial water, nearly opaque
      },
      vertexShader: WATER_VERT,
      fragmentShader: WATER_FRAG,
      transparent: true,
      depthWrite: true,
      side: THREE.FrontSide,
      fog: false,
    });
  }

  _register(geo) {
    geo.rotateX(-Math.PI / 2);
    geo.computeBoundingSphere();
    geo.boundingSphere.radius += 1.5; // waves displace vertices slightly
    const mesh = new THREE.Mesh(geo, this._mat);
    this._meshes.push(mesh);
    return mesh;
  }

  makeRiver({ width = 8, length = 36 } = {}) {
    const ws = Math.max(6, Math.round(width / 1.1));
    const ls = Math.max(16, Math.round(length / 1.4));
    return this._register(new THREE.PlaneGeometry(width, length, ws, ls));
  }

  makeLake({ radius = 30 } = {}) {
    const rings = Math.max(10, Math.round(radius / 2));
    return this._register(new THREE.RingGeometry(0.05, radius, 56, rings));
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
        u.uSky.value.copy(o.fog.color).lerp(this._skyBright, 0.45);
      }
    }
  }

  dispose() {
    for (const m of this._meshes) {
      if (m.parent) m.parent.remove(m);
      m.geometry.dispose();
    }
    this._meshes.length = 0;
    this._mat.dispose();
  }
}
