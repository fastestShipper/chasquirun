// Coins (single InstancedMesh) + special pickups (chakana, powerups), pooled.
// All positions are LOCAL to worldGroup; world z = local z + worldGroup.position.z.

import * as THREE from 'three';
import { CONFIG } from './config.js';
import { makeMat, Mats, Tex, applyCurvatureSprite } from './materials.js';

const COIN_CAP = 512;

// A jewel, not clipart: beveled disc with a raised rim, merged into one
// geometry (single instanced draw call for the whole field).
function sunCoinGeometry() {
  const parts = [];
  const disc = new THREE.CylinderGeometry(0.3, 0.3, 0.06, 24);
  disc.rotateX(Math.PI / 2);
  parts.push(disc.toNonIndexed());
  const rim = new THREE.TorusGeometry(0.3, 0.05, 10, 24);
  parts.push(rim.toNonIndexed());
  let count = 0;
  for (const p of parts) count += p.attributes.position.count;
  const pos = new Float32Array(count * 3);
  const nor = new Float32Array(count * 3);
  const uv = new Float32Array(count * 2);
  let o3 = 0, o2 = 0;
  for (const p of parts) {
    pos.set(p.attributes.position.array, o3);
    nor.set(p.attributes.normal.array, o3);
    uv.set(p.attributes.uv.array, o2);
    o3 += p.attributes.position.count * 3;
    o2 += p.attributes.position.count * 2;
    p.dispose();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}
const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _scale1 = new THREE.Vector3(1, 1, 1);
const _scale0 = new THREE.Vector3(0.0001, 0.0001, 0.0001);
const _axisY = new THREE.Vector3(0, 1, 0);

export class CoinField {
  constructor(worldGroup) {
    this.worldGroup = worldGroup;
    // Radiant sun-sol: disc plus eight rays merged into one geometry so the
    // whole field stays a single instanced draw call.
    const geo = sunCoinGeometry();
    this.mesh = new THREE.InstancedMesh(geo, Mats.coinGold(), COIN_CAP);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    worldGroup.add(this.mesh);

    this.pos = new Float32Array(COIN_CAP * 3);
    this.active = new Uint8Array(COIN_CAP);
    // Floating origin: stored z values stay small; the mesh carries the
    // large offset, which the CPU composes in float64. Without this the
    // fp32 instanceMatrix shimmers visibly past ~30 km.
    this.origin = 0;
    // Generation counter per slot: alloc() hands out tokens (id + gen*4096) so
    // a recycled chunk freeing its stale list cannot kill a re-used slot.
    this.gen = new Uint32Array(COIN_CAP);
    this.free = [];
    for (let i = COIN_CAP - 1; i >= 0; i--) this.free.push(i);
    this.spin = 0;
    this._collected = [];
    for (let i = 0; i < COIN_CAP; i++) {
      _m4.compose(new THREE.Vector3(0, -999, 0), _q.identity(), _scale0);
      this.mesh.setMatrixAt(i, _m4);
    }
  }

  // Returns a token (>= 4096) or -1 when the pool is full.
  alloc(x, y, z) {
    if (this.free.length === 0) return -1;
    // Rebase when the incoming absolute z drifts far from the origin.
    if (Math.abs(z - this.origin) > 2400) this._rebase(z);
    const id = this.free.pop();
    this.active[id] = 1;
    this.gen[id]++;
    this.pos[id * 3] = x;
    this.pos[id * 3 + 1] = y;
    this.pos[id * 3 + 2] = z - this.origin;
    return id + this.gen[id] * 4096;
  }

  _rebase(newOrigin) {
    const delta = this.origin - newOrigin;
    for (let id = 0; id < COIN_CAP; id++) {
      if (this.active[id]) this.pos[id * 3 + 2] += delta;
    }
    this.origin = newOrigin;
    this.mesh.position.z = newOrigin;
  }

  freeId(id) {
    if (id < 0 || !this.active[id]) return;
    this.active[id] = 0;
    this.free.push(id);
    _m4.compose(new THREE.Vector3(0, -999, 0), _q.identity(), _scale0);
    this.mesh.setMatrixAt(id, _m4);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  freeToken(token) {
    if (token < 0) return;
    const id = token % 4096;
    const g = (token - id) / 4096;
    if (this.gen[id] === g) this.freeId(id);
  }

  freeIds(tokens) {
    for (const t of tokens) this.freeToken(t);
    tokens.length = 0;
  }

  // Returns array of collected {x, y, z} in world space (reused, consume immediately).
  // sweep = half the world travel this frame, widening the collect window so
  // coins cannot tunnel past the runner between frames at boost speeds.
  update(dt, playerPos, magnetOn, sweep = 0) {
    this.spin += dt * 3.2;
    const offZ = this.worldGroup.position.z + this.origin;
    const collected = this._collected;
    collected.length = 0;
    const magR2 = CONFIG.magnetRadius * CONFIG.magnetRadius;

    for (let id = 0; id < COIN_CAP; id++) {
      if (!this.active[id]) continue;
      const ix = id * 3;
      let x = this.pos[ix], y = this.pos[ix + 1];
      const zw = this.pos[ix + 2] + offZ;

      if (zw > -60 && zw < 30) {
        const dx = x - playerPos.x;
        const dy = y - (playerPos.y + 0.9);
        const dz = zw - playerPos.z;
        const d2 = dx * dx + dy * dy + dz * dz;

        if (magnetOn && d2 < magR2) {
          const d = Math.sqrt(d2) || 0.001;
          const pull = (22 + (CONFIG.magnetRadius - d) * 10) * dt;
          x -= (dx / d) * Math.min(pull, d);
          y -= (dy / d) * Math.min(pull, d);
          this.pos[ix] = x;
          this.pos[ix + 1] = y;
          this.pos[ix + 2] -= (dz / d) * Math.min(pull, Math.abs(dz));
        }

        const dzEff = Math.max(0, Math.abs(dz) - sweep);
        if (dx * dx + dy * dy + dzEff * dzEff < 1.1) {
          collected.push({ x, y, z: zw });
          this.freeId(id);
          continue;
        }
      }

      _q.setFromAxisAngle(_axisY, this.spin + id * 0.37);
      const bob = Math.sin(this.spin * 1.3 + id * 0.7) * 0.07;
      _m4.compose(_setV(x, y + bob, this.pos[ix + 2]), _q, _scale1);
      this.mesh.setMatrixAt(id, _m4);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    return collected;
  }

  reset() {
    for (let id = 0; id < COIN_CAP; id++) if (this.active[id]) this.freeId(id);
    this.origin = 0;
    this.mesh.position.z = 0;
  }
}

const _tmpV = new THREE.Vector3();
function _setV(x, y, z) {
  return _tmpV.set(x, y, z);
}

// ---------------------------------------------------------------------------
// Specials: chakana tokens + powerups, small pooled meshes with glow sprites.
// ---------------------------------------------------------------------------

function buildSpecialMesh(kind) {
  const g = new THREE.Group();
  let color, glowColor;
  if (kind === 'chakana') {
    color = 0xffd76a; glowColor = '#ffd76a';
    const mat = makeMat({ map: Tex.gold(), metalness: 0.8, roughness: 0.25, emissive: 0xa87616, emissiveIntensity: 0.6 });
    const steps = [
      [0.5, 0.16], [0.36, 0.32], [0.2, 0.48],
    ];
    for (const [w, h] of steps) {
      const m1 = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.1), mat);
      g.add(m1);
      const m2 = new THREE.Mesh(new THREE.BoxGeometry(h, w, 0.1), mat);
      g.add(m2);
    }
    const center = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.12, 12), mat);
    center.rotation.x = Math.PI / 2;
    g.add(center);
  } else if (kind === 'inti') {
    color = 0xffc23e; glowColor = '#ffb62e';
    const mat = makeMat({ map: Tex.gold(), metalness: 0.85, roughness: 0.2, emissive: 0xb87d12, emissiveIntensity: 0.85 });
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 0.09, 24), mat);
    disc.rotation.x = Math.PI / 2;
    g.add(disc);
    const rayGeo = new THREE.ConeGeometry(0.08, 0.28, 4);
    for (let i = 0; i < 8; i++) {
      const ray = new THREE.Mesh(rayGeo, mat);
      const a = (i / 8) * Math.PI * 2;
      ray.position.set(Math.cos(a) * 0.56, Math.sin(a) * 0.56, 0);
      ray.rotation.z = a - Math.PI / 2;
      g.add(ray);
    }
  } else if (kind === 'wayra') {
    // Pututu conch: the Andean wind horn. Cyan glow keeps the color language.
    color = 0x7de8ff; glowColor = '#7de8ff';
    const mat = makeMat({ color: 0xd9f6ff, metalness: 0.35, roughness: 0.3, emissive: 0x2fa8c9, emissiveIntensity: 0.85 });
    let r = 0.24;
    for (let i = 0; i < 4; i++) {
      const whorl = new THREE.Mesh(new THREE.SphereGeometry(r, 12, 10), mat);
      whorl.position.set(i * 0.11 - 0.14, i * 0.05, 0);
      g.add(whorl);
      r *= 0.62;
    }
    const horn = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.11, 0.3, 10), mat);
    horn.position.set(0.34, 0.24, 0);
    horn.rotation.z = -0.9;
    g.add(horn);
  } else { // quri (magnet)
    // Golden tumi, the ceremonial axe: half-moon blade, handle, tiny idol.
    color = 0xc79bff; glowColor = '#b57dff';
    const mat = makeMat({ map: Tex.gold(), metalness: 0.8, roughness: 0.28, emissive: 0x6a36b8, emissiveIntensity: 0.8 });
    const blade = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.05, 20, 1, false, Math.PI, Math.PI), mat);
    blade.rotation.x = Math.PI / 2;
    blade.position.y = -0.18;
    g.add(blade);
    const handle = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.42, 0.06), mat);
    handle.position.y = 0.03;
    g.add(handle);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.08, 10, 8), mat);
    head.position.y = 0.3;
    g.add(head);
    const crown = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.05, 0.08, 8), mat);
    crown.position.y = 0.4;
    g.add(crown);
  }
  const glowMat = applyCurvatureSprite(new THREE.SpriteMaterial({
    map: Tex.softCircle(glowColor),
    color: 0xffffff,
    transparent: true,
    opacity: 0.5,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  }));
  const glow = new THREE.Sprite(glowMat);
  glow.scale.setScalar(2.0);
  g.add(glow);
  return { g, glow, color };
}

export class Specials {
  constructor(worldGroup) {
    this.worldGroup = worldGroup;
    this.pool = [];
    const kinds = ['chakana', 'chakana', 'inti', 'inti', 'wayra', 'wayra', 'quri', 'quri'];
    for (const kind of kinds) {
      const { g, glow } = buildSpecialMesh(kind);
      g.visible = false;
      worldGroup.add(g);
      this.pool.push({ kind, group: g, glow, active: false, baseY: 0, t: Math.random() * 10 });
    }
    this._collected = [];
  }

  spawn(kind, x, y, z) {
    const item = this.pool.find((p) => p.kind === kind && !p.active);
    if (!item) return false;
    item.active = true;
    item.group.visible = true;
    item.group.position.set(x, y, z);
    item.baseY = y;
    return true;
  }

  // Returns collected [{kind, x, y, z}] in world space (reused array).
  update(dt, playerPos) {
    const offZ = this.worldGroup.position.z;
    const collected = this._collected;
    collected.length = 0;
    for (const item of this.pool) {
      if (!item.active) continue;
      item.t += dt;
      item.group.rotation.y += dt * 1.6;
      item.group.position.y = item.baseY + Math.sin(item.t * 2.1) * 0.14;
      item.glow.material.opacity = 0.4 + Math.sin(item.t * 3.3) * 0.15;
      const zw = item.group.position.z + offZ;
      if (zw > 24) { // passed and gone
        item.active = false;
        item.group.visible = false;
        continue;
      }
      const dx = item.group.position.x - playerPos.x;
      const dy = item.group.position.y - (playerPos.y + 0.9);
      const dz = zw - playerPos.z;
      if (dx * dx + dy * dy + dz * dz < 1.35) {
        collected.push({ kind: item.kind, x: item.group.position.x, y: item.group.position.y, z: zw });
        item.active = false;
        item.group.visible = false;
      }
    }
    return collected;
  }

  reset() {
    for (const item of this.pool) {
      item.active = false;
      item.group.visible = false;
    }
  }
}
