// Andean animals: llama, alpaca, condor. Procedural, low mesh count, charming.
// API (ARCHITECTURE.md):
//   buildLlama({sitting = false}) -> { group, update(dt), dispose() }
//   buildAlpaca()                 -> { group, update(dt), dispose() }
//   buildCondor()                 -> { group, update(dt), dispose() }
// Origin at ground under the body center, animals face -Z. Zero per-frame allocs.
// Sculpt pass: capsule bodies with overlapping fluff spheres, curved tube
// necks (llama gently S-curved), rounded sphere muzzles, lens-shaped condor
// body and wing panels with rounded leading edges.

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { damp, lerp, smoothstep } from './util.js';
import { makeMat, Mats } from './materials.js';

const HALF_PI = Math.PI / 2;

let AM = null;
function getMats() {
  if (AM) return AM;
  AM = {
    wool: makeMat({ color: 0xece2cf, roughness: 1 }),
    woolFluff: makeMat({ color: 0xf5efe0, roughness: 1 }),
    muzzle: makeMat({ color: 0xb5a48e, roughness: 0.95 }),
    dark: makeMat({ color: 0x35291d, roughness: 0.8 }),
    blanket: Mats.cloth(['#b03a2e', '#e8c14d', '#2c3e50', '#d97b29']),
    feather: makeMat({ color: 0x1d1a17, roughness: 0.92 }),
    featherWhite: makeMat({ color: 0xf2ede1, roughness: 0.95 }),
    condorHead: makeMat({ color: 0xc97f62, roughness: 0.85 }),
    beak: makeMat({ color: 0xd9c9a6, roughness: 0.6 }),
  };
  return AM;
}

function addMesh(parent, geo, mat, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  parent.add(m);
  return m;
}

function addPivot(parent, x = 0, y = 0, z = 0) {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  parent.add(g);
  return g;
}

// ---------------------------------------------------------------------------
// Camelids (llama and alpaca share one builder)
// ---------------------------------------------------------------------------

function buildCamelid(o) {
  const MT = getMats();
  const group = new THREE.Group();
  const geos = [];
  const G = (g) => { geos.push(g); return g; };
  const wool = o.fluffy ? MT.woolFluff : MT.wool;

  // Body: horizontal capsule (axis along Z) with overlapping fluff spheres.
  const R = o.bodyR * 0.82;
  const bodyY = o.sitting ? o.bodyR * 0.75 + 0.05 : o.legLen + o.bodyR * 0.42;
  const body = addPivot(group, 0, bodyY, 0);
  const bodyGeo = G(new THREE.CapsuleGeometry(R, o.bodyLen * 1.1, 4, 12));
  bodyGeo.rotateX(HALF_PI);
  const bodyMesh = addMesh(body, bodyGeo, wool);

  // Fluff rides bodyMesh so it breathes with it.
  const fluffGeo = G(new THREE.SphereGeometry(R * 0.55, 10, 8));
  const fluffSpots = [
    [0, R * 0.38, -o.bodyLen * 0.42, 1.15, 0.85, 1.3],
    [R * 0.45, R * 0.12, o.bodyLen * 0.18, 1.0, 0.9, 1.35],
    [-R * 0.45, R * 0.12, -o.bodyLen * 0.12, 1.05, 0.9, 1.3],
    [0, R * 0.34, o.bodyLen * 0.5, 1.1, 0.85, 1.15],
  ];
  for (const s of fluffSpots) {
    const fl = addMesh(bodyMesh, fluffGeo, wool, s[0], s[1], s[2]);
    fl.scale.set(s[3], s[4], s[5]);
  }
  if (o.fluffy) {
    const chestFluff = addMesh(bodyMesh, fluffGeo, wool, 0, -R * 0.08, -o.bodyLen * 0.6);
    chestFluff.scale.set(1.1, 1.15, 1.0);
  }

  // Neck: tube along a gentle curve (S-shaped for the llama), rooted in a
  // soft base sphere; head pivot sits at the curve's top end.
  const neck = addPivot(body, 0, o.bodyR * 0.4, -o.bodyLen * 0.72);
  const nl = o.neckLen;
  const nPts = o.sCurve
    ? [
        new THREE.Vector3(0, -0.04, 0.02),
        new THREE.Vector3(0, nl * 0.32, 0.05),
        new THREE.Vector3(0, nl * 0.68, -0.045),
        new THREE.Vector3(0, nl, -0.05),
      ]
    : [
        new THREE.Vector3(0, -0.04, 0.01),
        new THREE.Vector3(0, nl * 0.5, 0.025),
        new THREE.Vector3(0, nl, -0.02),
      ];
  const nCurve = new THREE.CatmullRomCurve3(nPts);
  // Tube radius stays below the skull half-extent so the open end is hidden.
  addMesh(neck, G(new THREE.TubeGeometry(nCurve, 10, o.neckR * (o.fluffy ? 1.18 : 1.12), 8, false)), wool);
  const nBase = addMesh(neck, G(new THREE.SphereGeometry(o.neckR * 1.7, 9, 7)), wool, 0, 0, 0.01);
  nBase.scale.set(1, 0.85, 1.15);
  neck.rotation.x = -0.14;

  const headZ = o.sCurve ? -0.05 : -0.02;
  const head = addPivot(neck, 0, nl, headZ);
  const skull = addMesh(head, G(new THREE.SphereGeometry(o.headR, 12, 9)), wool);
  skull.scale.set(0.95, 0.95, 1.12);
  // Rounded muzzle: squashed sphere reaching forward, soft sphere jaw below.
  const muzzle = addMesh(head, G(new THREE.SphereGeometry(o.headR * 0.6, 10, 8)), MT.muzzle, 0, -o.headR * 0.15, -o.headR * 0.95);
  muzzle.scale.set(0.78, 0.72, 1.5);
  const jaw = addPivot(head, 0, -o.headR * 0.5, -o.headR * 0.6);
  const jawMesh = addMesh(jaw, G(new THREE.SphereGeometry(o.headR * 0.42, 9, 7)), MT.muzzle, 0, -o.headR * 0.1, -o.headR * 0.5);
  jawMesh.scale.set(0.8, 0.55, 1.35);
  if (o.fluffy) {
    const topknot = addMesh(head, G(new THREE.SphereGeometry(o.headR * 0.72, 8, 6)), wool, 0, o.headR * 0.75, 0.01);
    topknot.scale.set(1.15, 0.75, 1.1);
  }
  const eyeGeo = G(new THREE.SphereGeometry(o.headR * 0.18, 8, 6));
  addMesh(head, eyeGeo, MT.dark, o.headR * 0.62, o.headR * 0.2, -o.headR * 0.42);
  addMesh(head, eyeGeo, MT.dark, -o.headR * 0.62, o.headR * 0.2, -o.headR * 0.42);

  // Banana/teardrop ears: bent, scaled sphere on a base pivot.
  const earGeo = G(new THREE.SphereGeometry(o.headR * 0.42, 7, 6));
  earGeo.scale(0.42, 1.15, 0.3);
  earGeo.translate(0, o.headR * 0.42, 0);
  const ears = [];
  for (const sx of [1, -1]) {
    const ear = addPivot(head, sx * o.headR * 0.48, o.headR * 0.72, 0.02);
    ear.rotation.z = sx * 0.42;
    ear.rotation.x = -0.12;
    const em = addMesh(ear, earGeo, wool);
    em.rotation.z = sx * -0.3; // tips curve inward, banana style
    ears.push(ear);
  }

  // Legs: slim capsules whose rounded tips just kiss the ground.
  const lr = o.bodyR * 0.16;
  const legGeo = G(new THREE.CapsuleGeometry(lr, o.legLen - lr * 2, 4, 8));
  legGeo.translate(0, -o.legLen / 2, 0);
  const legs = [];
  for (const sz of [-1, 1]) {
    for (const sx of [1, -1]) {
      const leg = addPivot(body, sx * o.bodyR * 0.5, -o.bodyR * 0.42, sz * o.bodyLen * 0.62);
      addMesh(leg, legGeo, wool);
      if (o.sitting) {
        leg.rotation.x = sz < 0 ? -1.62 : 1.62; // folded flat under the body
        leg.position.y = -o.bodyR * 0.62;
      }
      legs.push(leg);
    }
  }

  // Tail puff.
  const tail = addMesh(body, G(new THREE.SphereGeometry(o.bodyR * 0.3, 8, 6)), wool, 0, o.bodyR * 0.32, o.bodyLen * 0.95);
  tail.scale.set(0.85, 1.05, 0.7);

  // Woven saddle blanket (llama only): rounded top pad + draped side panels.
  if (o.blanket) {
    const bk = addMesh(body, G(new RoundedBoxGeometry(o.bodyR * 1.9, o.bodyR * 0.18, o.bodyLen * 1.12, 2, o.bodyR * 0.055)), MT.blanket, 0, R * 0.98, 0.05);
    bk.rotation.z = 0.03;
    const sideGeo = G(new RoundedBoxGeometry(o.bodyR * 0.72, o.bodyR * 0.13, o.bodyLen * 1.0, 2, o.bodyR * 0.05));
    for (const sx of [1, -1]) {
      const panel = addMesh(body, sideGeo, MT.blanket, sx * R * 0.92, R * 0.5, 0.05);
      panel.rotation.z = -sx * 0.95;
    }
  }

  // Animation state.
  const S = {
    t: Math.random() * 20,
    chewT: Math.random() * 3, chewing: true,
    earNext: [1 + Math.random() * 4, 2 + Math.random() * 5],
    earFlick: [-1, -1],
  };

  function update(dt) {
    if (!(dt > 0)) return;
    dt = Math.min(dt, 0.05);
    S.t += dt;
    const t = S.t;

    // Slow neck sway + gentle breathing.
    neck.rotation.z = 0.07 * Math.sin(t * 0.7);
    neck.rotation.x = -0.14 + 0.05 * Math.sin(t * 0.43 + 1.7);
    bodyMesh.scale.y = 1 + 0.015 * Math.sin(t * 1.6);
    head.rotation.y = 0.25 * Math.sin(t * 0.31 + 2.2);

    // Chewing bouts: lateral camelid grind.
    S.chewT -= dt;
    if (S.chewT <= 0) {
      S.chewing = !S.chewing;
      S.chewT = S.chewing ? 2.5 + Math.random() * 3 : 1.5 + Math.random() * 2.5;
    }
    if (S.chewing) {
      jaw.rotation.x = 0.14 * Math.abs(Math.sin(t * 6.5));
      jaw.position.x = 0.014 * Math.sin(t * 3.25);
      jaw.rotation.z = 0.08 * Math.sin(t * 3.25);
    } else {
      jaw.rotation.x = damp(jaw.rotation.x, 0, 8, dt);
      jaw.position.x = damp(jaw.position.x, 0, 8, dt);
      jaw.rotation.z = damp(jaw.rotation.z, 0, 8, dt);
    }

    // Ear flicks: quick 0.3 s twitch on a random timer, per ear.
    for (let i = 0; i < 2; i++) {
      const sx = i === 0 ? 1 : -1;
      if (S.earFlick[i] < 0) {
        S.earNext[i] -= dt;
        if (S.earNext[i] <= 0) { S.earFlick[i] = 0; S.earNext[i] = 2 + Math.random() * 5; }
        ears[i].rotation.z = damp(ears[i].rotation.z, sx * 0.42, 10, dt);
      } else {
        S.earFlick[i] += dt;
        const p = Math.sin((S.earFlick[i] / 0.3) * Math.PI);
        ears[i].rotation.z = sx * (0.42 + 0.55 * p);
        ears[i].rotation.x = -0.12 - 0.3 * p;
        if (S.earFlick[i] > 0.3) { S.earFlick[i] = -1; ears[i].rotation.x = -0.12; }
      }
    }

    // Tail happy wag, occasionally.
    tail.rotation.x = 0.25 + 0.15 * Math.sin(t * 2.1) * smoothstep(0.2, 0.8, Math.sin(t * 0.23) * 0.5 + 0.5);
  }

  function dispose() { for (const g of geos) g.dispose(); }
  return { group, update, dispose };
}

export function buildLlama({ sitting = false } = {}) {
  return buildCamelid({
    sitting,
    bodyR: 0.36, bodyLen: 0.52, legLen: 0.68,
    neckR: 0.095, neckLen: 0.62, headR: 0.13,
    blanket: true, fluffy: false, sCurve: true,
  });
}

export function buildAlpaca() {
  return buildCamelid({
    sitting: false,
    bodyR: 0.32, bodyLen: 0.36, legLen: 0.42,
    neckR: 0.085, neckLen: 0.36, headR: 0.11,
    blanket: false, fluffy: true, sCurve: false,
  });
}

// ---------------------------------------------------------------------------
// Condor: 3 m wingspan, two-part majestic flap. Caller positions the group.
// ---------------------------------------------------------------------------

export function buildCondor() {
  const MT = getMats();
  const group = new THREE.Group();
  const geos = [];
  const G = (g) => { geos.push(g); return g; };

  const body = addPivot(group, 0, 0, 0);
  const bodyGeo = G(new THREE.SphereGeometry(0.17, 14, 10));
  const bodyMesh = addMesh(body, bodyGeo, MT.feather);
  bodyMesh.scale.set(0.85, 0.64, 1.9); // lens-shaped fuselage

  // Tail: flattened lens fan instead of a plank.
  const tailGeo = G(new THREE.SphereGeometry(1, 12, 8));
  const tail = addMesh(body, tailGeo, MT.feather, 0, 0.01, 0.44);
  tail.scale.set(0.16, 0.012, 0.22);
  tail.rotation.x = 0.08;

  // White neck ruff, then a small bare head with a hooked beak.
  const ruff = addMesh(body, G(new THREE.TorusGeometry(0.085, 0.05, 8, 14)), MT.featherWhite, 0, 0.05, -0.28);
  ruff.rotation.x = Math.PI / 2 - 0.25;
  const headPiv = addPivot(body, 0, 0.09, -0.36);
  addMesh(headPiv, G(new THREE.SphereGeometry(0.068, 10, 8)), MT.condorHead);
  const beak = addMesh(headPiv, G(new THREE.ConeGeometry(0.028, 0.1, 8)), MT.beak, 0, -0.005, -0.095);
  beak.rotation.x = -Math.PI / 2 - 0.25;

  // Wings: lens-shaped inner + outer panels (rounded leading edges), finger
  // feathers as thin rounded slats with white tips.
  const innerGeo = G(new THREE.SphereGeometry(1, 14, 9));
  innerGeo.scale(0.35, 0.021, 0.23);
  innerGeo.translate(0.30, 0, 0);
  const outerGeo = G(new THREE.SphereGeometry(1, 12, 8));
  outerGeo.scale(0.32, 0.016, 0.185);
  outerGeo.translate(0.27, 0, 0.02);
  const fingerGeo = G(new RoundedBoxGeometry(0.3, 0.014, 0.05, 2, 0.006));
  fingerGeo.translate(0.15, 0, 0);
  const tipGeo = G(new RoundedBoxGeometry(0.1, 0.015, 0.048, 2, 0.006));
  tipGeo.translate(0.25, 0, 0);

  const wings = [];
  for (const sx of [1, -1]) {
    const inner = addPivot(body, sx * 0.12, 0.05, -0.02);
    addMesh(inner, innerGeo, MT.feather);
    const outer = addPivot(inner, 0.6, 0, 0);
    addMesh(outer, outerGeo, MT.feather);
    for (let i = 0; i < 3; i++) {
      const ang = -0.3 + i * 0.28;
      const f = addMesh(outer, fingerGeo, MT.feather, 0.5, 0, -0.06 + i * 0.09);
      f.rotation.y = ang;
      const tp = addMesh(outer, tipGeo, MT.featherWhite, 0.5, 0, -0.06 + i * 0.09);
      tp.rotation.y = ang;
    }
    if (sx < 0) { inner.scale.x = -1; }
    wings.push({ inner, outer, sx });
  }

  const S = { t: Math.random() * 30 };

  function update(dt) {
    if (!(dt > 0)) return;
    dt = Math.min(dt, 0.05);
    S.t += dt;
    const t = S.t;
    // Long soar/flap cycle: mostly gliding, then a few slow, deep beats.
    const soar = smoothstep(0.15, 0.55, Math.sin(t * 0.16) * 0.5 + 0.5);
    const amp = lerp(0.1, 0.55, soar);
    const w = 2.9; // ~0.46 Hz, slow and majestic
    const fl = Math.sin(t * w);
    const flLag = Math.sin(t * w - 0.75);
    for (let i = 0; i < 2; i++) {
      const wing = wings[i];
      wing.inner.rotation.z = wing.sx * (0.12 + fl * amp);
      wing.outer.rotation.z = 0.06 + flLag * amp * 0.9;
    }
    body.position.y = 0.03 * Math.sin(t * w - 1.3) * soar;
    body.rotation.x = 0.05 * Math.sin(t * w - 1.6) * soar;
    body.rotation.z = 0.06 * Math.sin(t * 0.31);
    headPiv.rotation.y = 0.3 * Math.sin(t * 0.21 + 1.2);
  }

  function dispose() { for (const g of geos) g.dispose(); }
  return { group, update, dispose };
}
