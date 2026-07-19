// Andean animals: llama, alpaca, condor, plus Killa the nemesis llama.
// API (ARCHITECTURE.md):
//   buildLlama({sitting = false}) -> { group, update(dt), dispose() }
//   buildAlpaca()                 -> { group, update(dt), dispose() }
//   buildCondor()                 -> { group, update(dt), dispose() }
//   buildKilla()                  -> full rigged character, see below
// Origin at ground under the body center, animals face -Z. Zero per-frame allocs.
// Sculpt pass: capsule bodies with overlapping fluff spheres, curved tube
// necks (llama gently S-curved), rounded sphere muzzles, lens-shaped condor
// body and wing panels with rounded leading edges.

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { clamp, damp, lerp, smoothstep, TAU } from './util.js';
import { makeMat, Mats } from './materials.js';

const HALF_PI = Math.PI / 2;

// Scratch for per-animal world position lookups. Never allocate in update().
const _camelidV = new THREE.Vector3();

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
    // Killa: darker, richer wool so she never reads as decorative scenery.
    killaWool: makeMat({ color: 0xdccbab, roughness: 0.98 }),
    // The lower leg used to be 0x4c3b2b, near black against 0xdccbab wool. At
    // any distance that value break severed the leg at the knee and left four
    // black sticks floating under a pale balloon. It is now a shaded-wool tone
    // that stays attached, and the dark accent moved to the hoof where a real
    // camelid carries it.
    killaLeg: makeMat({ color: 0xc2ab88, roughness: 0.94 }),
    killaHoof: makeMat({ color: 0x4a3a2a, roughness: 0.85 }),
    killaMuzzle: makeMat({ color: 0x8d7860, roughness: 0.95 }),
    eyeWhite: makeMat({ color: 0xf7f3e9, roughness: 0.32 }),
    pupil: makeMat({ color: 0x100d0a, roughness: 0.22 }),
    lash: makeMat({ color: 0x18120d, roughness: 0.9, side: THREE.DoubleSide }),
    killaBlanket: Mats.cloth(['#7d1f3d', '#e8c14d', '#1b2b3a', '#c8892b']),
    fringe: makeMat({ color: 0xe8c14d, roughness: 0.85 }),
  };
  return AM;
}

// castShadow defaults to true to preserve the decorative animals. Killa passes
// false on everything except her body and legs (she is permanently on camera).
function addMesh(parent, geo, mat, x = 0, y = 0, z = 0, cast = true) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = cast;
  parent.add(m);
  return m;
}

// Minimal geometry merge (BufferGeometryUtils is not vendored). Takes
// [{ geo, m }] with an optional Matrix4 and returns one non-indexed geometry.
// Source geometries are consumed and disposed. Build time only.
function mergeGeos(parts) {
  const prepared = [];
  let total = 0;
  for (let i = 0; i < parts.length; i++) {
    const src = parts[i].geo;
    const g = src.index ? src.toNonIndexed() : src.clone();
    src.dispose();
    if (parts[i].m) g.applyMatrix4(parts[i].m);
    prepared.push(g);
    total += g.attributes.position.count;
  }
  const pos = new Float32Array(total * 3);
  const nor = new Float32Array(total * 3);
  const uv = new Float32Array(total * 2);
  let o3 = 0;
  let o2 = 0;
  for (let i = 0; i < prepared.length; i++) {
    const g = prepared[i];
    pos.set(g.attributes.position.array, o3);
    if (g.attributes.normal) nor.set(g.attributes.normal.array, o3);
    if (g.attributes.uv) uv.set(g.attributes.uv.array, o2);
    o3 += g.attributes.position.count * 3;
    o2 += g.attributes.position.count * 2;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.computeBoundingSphere();
  return out;
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
  const rig = !!o.rig;
  const wool = rig ? MT.killaWool : o.fluffy ? MT.woolFluff : MT.wool;
  const muzzleMat = rig ? MT.killaMuzzle : MT.muzzle;
  // Killa gets an inner root so poses can swing her whole body without
  // disturbing the placement transform the caller owns on `group`.
  const rootPiv = rig ? addPivot(group, 0, 0, 0) : group;

  // Body: horizontal capsule (axis along Z) with overlapping fluff spheres.
  const R = o.bodyR * 0.82;
  const bodyY = o.sitting ? o.bodyR * 0.75 + 0.05 : o.legLen + o.bodyR * 0.42;
  const body = addPivot(rootPiv, 0, bodyY, 0);
  const bodyGeo = G(new THREE.CapsuleGeometry(R, o.bodyLen * 1.1, 4, 12));
  bodyGeo.rotateX(HALF_PI);
  const bodyMesh = addMesh(body, bodyGeo, wool);
  if (rig) bodyMesh.scale.set(1.14, 1.1, 1); // rounder, plumper barrel

  // Fluff rides bodyMesh so it breathes with it.
  const fluffGeo = G(new THREE.SphereGeometry(R * 0.55, 10, 8));
  const fluffSpots = rig
    ? [
        [0, R * 0.42, -o.bodyLen * 0.4, 1.35, 1.0, 1.35],
        [0, R * 0.3, o.bodyLen * 0.52, 1.4, 1.05, 1.2],
        [0, -R * 0.1, -o.bodyLen * 0.72, 1.2, 1.2, 0.95],
      ]
    : [
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

  // Killa's neck is her main instrument: a chain of segments so it ARCS
  // instead of hinging, which lets her do the 180 degree over-the-shoulder
  // look that real llamas do and that reads as pure contempt.
  const neckSegs = [];
  let head = null;
  if (rig) {
    const NSEG = 4;
    const segLen = nl / NSEG;
    let parent = neck;
    for (let i = 0; i < NSEG; i++) {
      const seg = addPivot(parent, 0, i === 0 ? 0 : segLen, 0);
      const r0 = lerp(o.neckR * 1.25, o.neckR * 0.86, i / NSEG);
      const r1 = lerp(o.neckR * 1.25, o.neckR * 0.86, (i + 1) / NSEG);
      const sg = G(new THREE.CylinderGeometry(r1, r0, segLen * 1.14, 9, 1));
      sg.translate(0, segLen * 0.5, 0);
      addMesh(seg, sg, wool, 0, 0, 0, false);
      neckSegs.push(seg);
      parent = seg;
    }
    const nBase = addMesh(neck, G(new THREE.SphereGeometry(o.neckR * 1.9, 10, 8)), wool, 0, 0, 0.01, false);
    nBase.scale.set(1, 0.9, 1.2);
    neck.rotation.x = -0.08;
    head = addPivot(neckSegs[NSEG - 1], 0, segLen, -0.02);
  }

  if (!rig) {
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
    head = addPivot(neck, 0, nl, o.sCurve ? -0.05 : -0.02);
  }

  const skull = addMesh(head, G(new THREE.SphereGeometry(o.headR, 12, 9)), wool, 0, 0, 0, !rig);
  skull.scale.set(0.95, 0.95, 1.12);
  // Rounded muzzle: squashed sphere reaching forward, soft sphere jaw below.
  const muzzle = addMesh(head, G(new THREE.SphereGeometry(o.headR * 0.6, 10, 8)), muzzleMat, 0, -o.headR * 0.15, -o.headR * 0.95, !rig);
  muzzle.scale.set(0.78, 0.72, 1.5);
  const jaw = addPivot(head, 0, -o.headR * 0.5, -o.headR * 0.6);
  let jawMesh;
  if (rig) {
    // Hard-angled box jaw: the flat underside plane is what makes her read as
    // judgmental rather than soft.
    jawMesh = addMesh(jaw, G(new RoundedBoxGeometry(o.headR * 0.72, o.headR * 0.46, o.headR * 1.15, 2, o.headR * 0.05)), muzzleMat, 0, -o.headR * 0.12, -o.headR * 0.52, false);
    jawMesh.rotation.x = 0.1;
  } else {
    jawMesh = addMesh(jaw, G(new THREE.SphereGeometry(o.headR * 0.42, 9, 7)), muzzleMat, 0, -o.headR * 0.1, -o.headR * 0.5);
    jawMesh.scale.set(0.8, 0.55, 1.35);
  }
  if (o.fluffy) {
    const topknot = addMesh(head, G(new THREE.SphereGeometry(o.headR * 0.72, 8, 6)), wool, 0, o.headR * 0.75, 0.01);
    topknot.scale.set(1.15, 0.75, 1.1);
  }

  // Eyes. Decorative animals get two dark beads. Killa gets the full diva eye:
  // eyeball, outward-offset pupil (permanent side-eye), a geometric upper lid
  // cap sitting a third of the way down and rotated forward at the outer
  // corner, and three flat lash quads merged into one strip.
  const lids = [];
  if (rig) {
    const er = o.headR * 0.21;
    const ballGeo = G(new THREE.SphereGeometry(er, 10, 8));
    const pupGeo = G(new THREE.SphereGeometry(er * 0.5, 8, 6));
    const lidGeo = G(new THREE.SphereGeometry(er * 1.07, 10, 6, 0, TAU, 0, 1.22));
    const dummy = new THREE.Object3D();
    for (const sx of [1, -1]) {
      const eye = addPivot(head, sx * o.headR * 0.62, o.headR * 0.24, -o.headR * 0.4);
      eye.rotation.y = sx * 0.28;
      addMesh(eye, ballGeo, MT.eyeWhite, 0, 0, 0, false);
      const pup = addMesh(eye, pupGeo, MT.pupil, sx * er * 0.54, 0, -er * 0.74, false);
      pup.scale.set(1, 1.1, 0.6);
      // Lid cap: tipped forward, outer corner dropped. This does most of the
      // personality work and has to survive being 12 pixels tall.
      const lid = addPivot(eye, 0, 0, 0);
      lid.rotation.set(-0.24, 0, -sx * 0.4);
      addMesh(lid, lidGeo, wool, 0, 0, 0, false);
      const lashParts = [];
      for (let i = 0; i < 3; i++) {
        const a = 0.35 + i * 0.42;
        dummy.position.set(sx * er * 1.02 * Math.sin(a), er * 1.0 * Math.cos(a), -er * 0.5);
        dummy.rotation.set(-0.5, 0, -sx * (0.5 + i * 0.3));
        dummy.updateMatrix();
        lashParts.push({ geo: new THREE.PlaneGeometry(er * 0.55, er * 0.14), m: dummy.matrix.clone() });
      }
      addMesh(lid, G(mergeGeos(lashParts)), MT.lash, 0, 0, 0, false);
      lids.push(lid);
    }
  } else {
    const eyeGeo = G(new THREE.SphereGeometry(o.headR * 0.18, 8, 6));
    addMesh(head, eyeGeo, MT.dark, o.headR * 0.62, o.headR * 0.2, -o.headR * 0.42);
    addMesh(head, eyeGeo, MT.dark, -o.headR * 0.62, o.headR * 0.2, -o.headR * 0.42);
  }

  // Ears. Decorative: banana/teardrop bent sphere. Killa: a hard 4-sided
  // wedge at ~1.4x length so the angle still reads from across the track.
  let earGeo;
  if (rig) {
    const el = o.headR * 1.3;
    earGeo = G(new THREE.ConeGeometry(o.headR * 0.3, el, 4, 1));
    earGeo.rotateY(Math.PI / 4);
    earGeo.scale(1, 1, 0.42);
    earGeo.translate(0, el * 0.5, 0);
  } else {
    earGeo = G(new THREE.SphereGeometry(o.headR * 0.42, 7, 6));
    earGeo.scale(0.42, 1.15, 0.3);
    earGeo.translate(0, o.headR * 0.42, 0);
  }
  const ears = [];
  for (const sx of [1, -1]) {
    const ear = addPivot(head, sx * o.headR * 0.48, o.headR * 0.72, 0.02);
    ear.rotation.z = sx * 0.42;
    ear.rotation.x = -0.12;
    const em = addMesh(ear, earGeo, wool, 0, 0, 0, !rig);
    if (!rig) em.rotation.z = sx * -0.3; // tips curve inward, banana style
    ears.push(ear);
  }

  // Legs: slim capsules whose rounded tips just kiss the ground. The rig path
  // splits each leg into hip and knee pivots so gaits get a real bend, and
  // gives the lower legs a dark tone (also hides the hoof seam).
  const lr = o.bodyR * 0.16;
  const legs = [];
  const knees = [];
  if (rig) {
    const upLen = o.legLen * 0.52;
    const loLen = o.legLen - upLen;
    // Cylinder length excludes the two hemispherical caps so the rounded hoof
    // tip lands exactly on y = 0 rather than sinking through it.
    const upGeo = G(new THREE.CapsuleGeometry(lr * 1.15, upLen - lr * 2.3, 4, 8));
    upGeo.translate(0, -upLen / 2, 0);
    const loGeo = G(new THREE.CapsuleGeometry(lr * 0.86, loLen - lr * 1.72, 4, 8));
    loGeo.translate(0, -loLen / 2, 0);
    // The upper capsule ends at r*1.15 and the lower starts at r*0.86, so the
    // silhouette stepped in at the knee and the tone change made that step
    // read as a break with the hoof floating below it. A knee ball spanning
    // both radii closes the joint.
    // Sized to the LOWER leg, not between the two: a ball wider than the shin
    // adds a third diameter to the limb and the leg reads as a lathe-turned
    // table leg. This just fills the joint.
    const kneeGeo = G(new THREE.SphereGeometry(lr * 0.90, 9, 7));
    // Dark hoof at the very bottom: the accent a camelid actually carries,
    // and it stops the pale leg from dissolving into the ground.
    const hoofGeo = G(new THREE.CylinderGeometry(lr * 0.92, lr * 0.82, lr * 1.0, 8, 1));
    hoofGeo.translate(0, -loLen + lr * 0.55, 0);
    // Index order is fixed and public: 0 FL, 1 FR, 2 BL, 3 BR (she faces -Z,
    // so +X is her left).
    for (const sz of [-1, 1]) {
      for (const sx of [1, -1]) {
        // Wider stance than the decorative llama, but the hip height must stay
        // at 0.42 so hip + legLen lands the hoof exactly on y = 0.
        const hip = addPivot(body, sx * o.bodyR * 0.52, -o.bodyR * 0.42, sz * o.bodyLen * 0.66);
        addMesh(hip, upGeo, wool);
        const knee = addPivot(hip, 0, -upLen, 0);
        // No shadow: the ball is sandwiched between two capsules that both
        // cast, so it would only pay for a duplicate.
        addMesh(knee, kneeGeo, wool, 0, 0, 0, false);
        addMesh(knee, loGeo, MT.killaLeg);
        addMesh(knee, hoofGeo, MT.killaHoof, 0, 0, 0, false);
        legs.push(hip);
        knees.push(knee);
      }
    }
  } else {
    const legGeo = G(new THREE.CapsuleGeometry(lr, o.legLen - lr * 2, 4, 8));
    legGeo.translate(0, -o.legLen / 2, 0);
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
  }

  // Tail puff.
  const tail = addPivot(body, 0, o.bodyR * 0.32, o.bodyLen * 0.95);
  const tailMesh = addMesh(tail, G(new THREE.SphereGeometry(o.bodyR * 0.3, 8, 6)), wool, 0, 0, 0, !rig);
  tailMesh.scale.set(0.85, 1.05, 0.7);

  // Woven saddle blanket (llama only): rounded top pad + draped side panels.
  // Killa's is fringed and carries two gold-tone discs on the flanks.
  if (o.blanket) {
    const bMat = rig ? MT.killaBlanket : MT.blanket;
    // Seated a little deeper: a flat pad on a round back shows daylight at its
    // outer edges if it rides the very top of the barrel.
    const bk = addMesh(body, G(new RoundedBoxGeometry(o.bodyR * 1.9, o.bodyR * 0.18, o.bodyLen * 1.12, 2, o.bodyR * 0.055)), bMat, 0, R * 0.88, 0.05, !rig);
    bk.rotation.z = 0.03;
    if (rig) {
      // Both draped panels merged into one mesh, both fringe curtains into
      // another, both discs into a third. Four meshes total for the outfit.
      const dummy = new THREE.Object3D();
      const panelParts = [];
      const fringeParts = [];
      const discParts = [];
      const pw = o.bodyR * 0.8;
      // Panels used to sit at 0.98 rad, i.e. 56 degrees off vertical, so they
      // stuck out sideways like wings with daylight under them instead of
      // hanging on the flanks. DROP is near vertical and the anchor is pulled
      // in and down onto the barrel so the cloth actually touches the animal.
      const DROP = 1.11;
      const sinD = Math.sin(DROP), cosD = Math.cos(DROP);
      const ax = R * 1.02, ay = R * 0.35;
      for (const sx of [1, -1]) {
        dummy.position.set(sx * ax, ay, 0.05);
        dummy.rotation.set(0, 0, -sx * DROP);
        dummy.updateMatrix();
        panelParts.push({ geo: new RoundedBoxGeometry(pw, o.bodyR * 0.14, o.bodyLen * 1.04, 2, o.bodyR * 0.05), m: dummy.matrix.clone() });
        for (let i = 0; i < 7; i++) {
          const z = (i / 6 - 0.5) * o.bodyLen * 0.96;
          dummy.position.set(sx * (ax + sinD * pw * 0.52), ay - cosD * pw * 0.52 - o.bodyR * 0.11, 0.05 + z);
          dummy.rotation.set(0, 0, -sx * 0.14);
          dummy.updateMatrix();
          fringeParts.push({ geo: new THREE.CylinderGeometry(o.bodyR * 0.016, o.bodyR * 0.012, o.bodyR * 0.24, 4, 1), m: dummy.matrix.clone() });
        }
        dummy.position.set(sx * (ax + sinD * pw * 0.3), ay - cosD * pw * 0.3, 0.05);
        dummy.rotation.set(HALF_PI, 0, -sx * DROP + HALF_PI);
        dummy.updateMatrix();
        discParts.push({ geo: new THREE.CylinderGeometry(o.bodyR * 0.2, o.bodyR * 0.2, o.bodyR * 0.05, 12, 1), m: dummy.matrix.clone() });
      }
      addMesh(body, G(mergeGeos(panelParts)), bMat, 0, 0, 0, false);
      addMesh(body, G(mergeGeos(fringeParts)), MT.fringe, 0, 0, 0, false);
      addMesh(body, G(mergeGeos(discParts)), Mats.gold(), 0, 0, 0, false);
    } else {
      // Same correction as Killa's: at 0.95 rad the panels stood out sideways
      // like a table top with daylight under them. 1.11 lays them on the flank.
      const sideGeo = G(new RoundedBoxGeometry(o.bodyR * 0.72, o.bodyR * 0.13, o.bodyLen * 1.0, 2, o.bodyR * 0.05));
      for (const sx of [1, -1]) {
        const panel = addMesh(body, sideGeo, MT.blanket, sx * R * 0.94, R * 0.34, 0.05);
        panel.rotation.z = -sx * 1.11;
      }
    }
  }

  function dispose() { for (const g of geos) g.dispose(); }

  // Killa path: hand back the raw rig and let buildKilla drive everything.
  if (rig) {
    return {
      group, dispose,
      joints: { root: rootPiv, body, bodyMesh, neck, neckSegs, head, jaw, ears, lids, legs, knees, tail },
    };
  }

  // Animation state. `graze` is the per-animal personality: a herd where every
  // member is doing the same thing at the same time reads as a row of props,
  // so each one gets its own bout timing and its own resting pose.
  const S = {
    t: Math.random() * 20,
    chewT: Math.random() * 3, chewing: true,
    earNext: [1 + Math.random() * 4, 2 + Math.random() * 5],
    earFlick: [-1, -1],
    graze: Math.random() < 0.55,
    grazeT: 2 + Math.random() * 6,
    grazeAmt: Math.random() < 0.55 ? 1 : 0,
    look: 0,
    shift: Math.random() * TAU,
  };

  function update(dt) {
    if (!(dt > 0)) return;
    dt = Math.min(dt, 0.05);
    S.t += dt;
    const t = S.t;

    // Grazing bouts: head goes down to the grass, then back up to chew and
    // look around. This is the single biggest "alive" cue for a standing herd.
    S.grazeT -= dt;
    if (S.grazeT <= 0) {
      S.graze = !S.graze;
      S.grazeT = S.graze ? 3 + Math.random() * 5 : 2.5 + Math.random() * 4;
    }
    S.grazeAmt = damp(S.grazeAmt, S.graze ? 1 : 0, 2.2, dt);

    // The runner goes past: they lift their heads and track him. Computed
    // from their own world position so it lands as he actually draws level.
    group.getWorldPosition(_camelidV);
    const near = _camelidV.z > -34 && _camelidV.z < 8;
    S.look = damp(S.look, near ? 1 : 0, 3.2, dt);

    // Slow neck sway + gentle breathing, folded together with the graze dip.
    const dip = S.grazeAmt * (1 - S.look);
    neck.rotation.z = 0.07 * Math.sin(t * 0.7) + 0.05 * Math.sin(t * 0.23 + S.shift);
    neck.rotation.x = -0.14 + 0.05 * Math.sin(t * 0.43 + 1.7) + dip * 1.05;
    bodyMesh.scale.y = 1 + 0.015 * Math.sin(t * 1.6);
    // Head aims at the road when he is near, otherwise wanders idly.
    const idleYaw = 0.25 * Math.sin(t * 0.31 + 2.2);
    const watchYaw = Math.atan2(-_camelidV.x, -(_camelidV.z + 2)) * 0.5;
    head.rotation.y = lerp(idleYaw, watchYaw, S.look);
    head.rotation.x = -dip * 0.5 + S.look * 0.12;
    // Weight shift: a standing animal is never perfectly still.
    body.rotation.z = 0.02 * Math.sin(t * 0.37 + S.shift);

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

    // Ears come forward while they watch him go by.
    if (S.look > 0.05) {
      for (let i = 0; i < 2; i++) {
        if (S.earFlick[i] < 0) ears[i].rotation.x = -0.12 - S.look * 0.3;
      }
    }

    // Tail happy wag, occasionally.
    tail.rotation.x = 0.25 + 0.15 * Math.sin(t * 2.1) * smoothstep(0.2, 0.8, Math.sin(t * 0.23) * 0.5 + 0.5);
  }

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
// Pose track system (used by Killa)
//
// Cycles want sine curves. Gags do not. A gag needs anticipation, a snap, a
// HOLD, and a settle, and the only honest way to get that is authored
// keyframes. Tracks are evaluated into a preallocated channel bag and applied
// ADDITIVELY on top of locomotion, so she can trot and taunt at the same time.
// ---------------------------------------------------------------------------

// Every channel is an additive offset in radians, meters, or a 0..1 weight.
const CH = [
  'headYaw', 'headPitch', 'headRoll',
  'neckPitch', 'neckYaw', 'neckRoll',
  'earL', 'earR', 'lidL', 'lidR', 'jaw',
  'bodyPitch', 'bodyRoll', 'bodyYaw', 'bodyY', 'bodyZ', 'rootYaw',
  'legFL', 'legFR', 'legBL', 'legBR',
  'kneeFL', 'kneeFR', 'kneeBL', 'kneeBR',
  'clapX', 'tail', 'lookW', 'lookMute', 'gallop', 'shake',
  'frontMute', 'backMute',
];
const LEG_CH = ['legFL', 'legFR', 'legBL', 'legBR'];
const KNEE_CH = ['kneeFL', 'kneeFR', 'kneeBL', 'kneeBR'];

// `ease` describes the curve used to REACH that key. 'hold' is a step: the
// previous value is held for the whole span and then snaps. That step is what
// makes the tantrum give-up land.
const EASES = {
  linear: (t) => t,
  in: (t) => t * t,
  out: (t) => 1 - (1 - t) * (1 - t),
  inout: (t) => t * t * (3 - 2 * t),
  snap: (t) => 1 - (1 - t) * (1 - t) * (1 - t) * (1 - t),
  back: (t) => t * t * (2.7 * t - 1.7),
  hold: () => 0,
};

// Shared by the three applause claps: reared up, both front hooves in the air.
const CLAP_UP = {
  bodyPitch: 0.4, legFL: 1.0, legFR: 1.0, kneeFL: -0.62, kneeFR: -0.62,
  frontMute: 1, lidL: 0.62, lidR: 0.62, neckPitch: 0.12, headPitch: -0.06,
  earL: -0.2, earR: -0.2,
};
const CLAP_OPEN = { ...CLAP_UP, clapX: 0.06 };
const CLAP_SHUT = { ...CLAP_UP, clapX: 0.44 };

const TRACKS = {
  // The core telegraph. Snaps and then just sits there looking at you.
  look: {
    d: 0.5,
    keys: [
      { t: 0 },
      { t: 0.09, ease: 'snap', j: { lookW: 0.5, earL: -1, earR: -1, headPitch: 0.06, neckPitch: 0.06 } },
      { t: 0.5, ease: 'linear', j: { lookW: 0.5, earL: -1, earR: -1, headPitch: 0.06, neckPitch: 0.06 } },
    ],
  },
  smirk: {
    d: 0.7,
    keys: [
      { t: 0 },
      { t: 0.22, ease: 'out', j: { headRoll: 0.3, headYaw: 0.14, neckRoll: 0.1, earR: -0.7, earL: 0.3, lidL: 0.85, lidR: 0.85 } },
      { t: 0.44, ease: 'inout', j: { headRoll: 0.32, headYaw: 0.14, neckRoll: 0.1, earR: -0.7, earL: 0.3, lidL: 0.08, lidR: 0.08 } },
      { t: 0.7, ease: 'inout', j: { headRoll: 0.26, headYaw: 0.12, neckRoll: 0.08, earR: -0.75, earL: 0.3, lidL: 0.4, lidR: 0.4 } },
    ],
  },
  // 600 ms of coil, then a 250 ms snap. The 'snap' event is the frame the
  // head reaches full extension, which is when the projectile should leave.
  spit: {
    d: 0.9,
    events: [{ t: 0.85, name: 'snap' }],
    keys: [
      { t: 0 },
      { t: 0.12, ease: 'out', j: { neckPitch: 0.08, headPitch: 0.05, earL: -0.6, earR: -0.6 } },
      { t: 0.6, ease: 'in', j: { neckPitch: 0.62, headPitch: 0.38, jaw: -0.12, earL: -1, earR: -1, bodyPitch: 0.07, bodyZ: 0.05 } },
      { t: 0.85, ease: 'snap', j: { neckPitch: -0.6, headPitch: -0.28, jaw: 0.55, earL: -1, earR: -1, bodyPitch: -0.05, bodyZ: -0.06 } },
      { t: 0.9, ease: 'out', j: { neckPitch: -0.45, headPitch: -0.2, jaw: 0.3, earL: -0.9, earR: -0.9 } },
    ],
  },
  // Four bobs, each smaller, while she turns away and shakes.
  chuckle: {
    d: 1.1,
    keys: [
      { t: 0 },
      { t: 0.14, ease: 'in', j: { headPitch: -0.34, bodyYaw: 0.06, shake: 1, lidL: 0.5, lidR: 0.5 } },
      { t: 0.26, ease: 'out', j: { headPitch: 0.05, bodyYaw: 0.1, shake: 1, lidL: 0.5, lidR: 0.5 } },
      { t: 0.37, ease: 'in', j: { headPitch: -0.24, bodyYaw: 0.14, shake: 1, lidL: 0.5, lidR: 0.5 } },
      { t: 0.49, ease: 'out', j: { headPitch: 0.04, bodyYaw: 0.18, shake: 1, lidL: 0.5, lidR: 0.5 } },
      { t: 0.6, ease: 'in', j: { headPitch: -0.16, bodyYaw: 0.22, shake: 0.8, lidL: 0.5, lidR: 0.5 } },
      { t: 0.71, ease: 'out', j: { headPitch: 0.03, bodyYaw: 0.25, shake: 0.6, lidL: 0.5, lidR: 0.5 } },
      { t: 0.83, ease: 'in', j: { headPitch: -0.09, bodyYaw: 0.28, shake: 0.4, lidL: 0.5, lidR: 0.5 } },
      { t: 1.1, ease: 'out', j: { headPitch: 0, bodyYaw: 0.3, headYaw: -0.2, lidL: 0.4, lidR: 0.4, earL: -0.3, earR: -0.3 } },
    ],
  },
  stamp: {
    d: 0.5,
    events: [{ t: 0.16, name: 'stamp' }, { t: 0.37, name: 'stamp' }],
    keys: [
      { t: 0 },
      { t: 0.09, ease: 'out', j: { legFL: 0.52, kneeFL: -0.55, frontMute: 1, bodyPitch: 0.03, earL: -0.5, earR: -0.5 } },
      { t: 0.16, ease: 'snap', j: { legFL: -0.2, kneeFL: 0, frontMute: 1, earL: -0.5, earR: -0.5 } },
      { t: 0.3, ease: 'out', j: { legFL: 0.52, kneeFL: -0.55, frontMute: 1, earL: -0.5, earR: -0.5 } },
      { t: 0.37, ease: 'snap', j: { legFL: -0.2, kneeFL: 0, frontMute: 1, earL: -0.5, earR: -0.5 } },
      { t: 0.5, ease: 'out', j: { legFL: 0, kneeFL: 0, frontMute: 1 } },
    ],
  },
  kick: {
    d: 0.6,
    events: [{ t: 0.34, name: 'kick' }],
    keys: [
      { t: 0 },
      { t: 0.2, ease: 'out', j: { rootYaw: 0.85, legBL: 0.35, legBR: 0.35, kneeBL: 0.4, kneeBR: 0.4, backMute: 1, tail: 0.4 } },
      { t: 0.34, ease: 'snap', j: { rootYaw: 0.85, legBL: -1, legBR: -0.9, kneeBL: -0.5, kneeBR: -0.45, backMute: 1, bodyPitch: 0.25, tail: 0.7 } },
      { t: 0.6, ease: 'out', j: { rootYaw: 0.4, legBL: 0, legBR: 0, backMute: 1, bodyPitch: 0.05 } },
    ],
  },
  // Three stages. The joke is entirely the 'hold' step at 1.6 s: the effort
  // does not decay, it is abandoned between two frames.
  tantrum: {
    d: 2.8,
    events: [{ t: 0.1, name: 'offense' }, { t: 1.6, name: 'giveup' }],
    keys: [
      { t: 0 },
      // 0.4 s of genuine offense.
      { t: 0.1, ease: 'snap', j: { headPitch: 0.5, neckPitch: 0.35, earL: 1, earR: 1, lidL: -0.55, lidR: -0.55, bodyPitch: 0.1 } },
      { t: 0.4, ease: 'inout', j: { headPitch: 0.42, neckPitch: 0.3, earL: 1, earR: 1, lidL: -0.5, lidR: -0.5, bodyPitch: 0.06 } },
      // 1.2 s of undignified, genuinely trying gallop.
      { t: 0.55, ease: 'in', j: { gallop: 1, shake: 1, headPitch: -0.15, neckPitch: -0.2, earL: -0.9, earR: -0.6, lidL: -0.3, lidR: -0.3, bodyPitch: -0.05 } },
      { t: 1.55, ease: 'linear', j: { gallop: 1, shake: 1, headPitch: -0.2, neckPitch: -0.25, earL: -0.9, earR: -0.6, lidL: -0.3, lidR: -0.3 } },
      // Instant drop to a smooth walk, admiring the mountains, no transition.
      { t: 1.6, ease: 'hold', j: { headYaw: -0.55, headPitch: 0.22, neckYaw: -0.5, neckPitch: 0.12, earL: 0.4, earR: 0.4, lookMute: 1, lidL: 0.35, lidR: 0.35 } },
      { t: 2.8, ease: 'inout', j: { headYaw: -0.75, headPitch: 0.26, neckYaw: -0.7, neckPitch: 0.14, earL: 0.5, earR: 0.5, lookMute: 1, lidL: 0.3, lidR: 0.3 } },
    ],
  },
  // Claps at 0.4, 1.3 and 2.2: EXACTLY 0.9 s apart. The spacing is wrong on
  // paper and right on screen. Do not tighten it. She stops on the third clap
  // and leaves with her hooves still up, hence the very slow release.
  applaud: {
    d: 3.2, fade: 1.1,
    events: [
      { t: 0.4, name: 'clap' }, { t: 1.3, name: 'clap' }, { t: 2.2, name: 'clap' },
      { t: 2.55, name: 'walkoff' },
    ],
    keys: [
      { t: 0 },
      { t: 0.22, ease: 'out', j: CLAP_OPEN },
      { t: 0.4, ease: 'snap', j: CLAP_SHUT },
      { t: 0.8, ease: 'out', j: CLAP_OPEN },
      { t: 1.3, ease: 'snap', j: CLAP_SHUT },
      { t: 1.7, ease: 'out', j: CLAP_OPEN },
      { t: 2.2, ease: 'snap', j: CLAP_SHUT },
      { t: 2.55, ease: 'linear', j: CLAP_SHUT },
      { t: 3.2, ease: 'linear', j: CLAP_SHUT },
    ],
  },
  // Death screen hold. Ends on a key and stays there; base idle sway, breath
  // and chew keep running underneath because poses are additive.
  trophy: {
    d: 1.2, hold: true,
    keys: [
      { t: 0 },
      { t: 0.5, ease: 'out', j: { bodyPitch: 0.12, legFR: 0.62, kneeFR: -0.25, frontMute: 1, neckPitch: 0.22, headPitch: 0.62, lidL: 0.3, lidR: 0.3, earL: 0.6, earR: 0.6, bodyY: 0.02, lookMute: 1 } },
      { t: 1.2, ease: 'inout', j: { bodyPitch: 0.14, legFR: 0.6, kneeFR: -0.22, frontMute: 1, neckPitch: 0.24, headPitch: 0.66, lidL: 0.28, lidR: 0.28, earL: 0.6, earR: 0.6, bodyY: 0.02, lookMute: 1 } },
    ],
  },
  // Pause screen hold: down, chin flat, eyes shut.
  kush: {
    d: 1.4, hold: true,
    keys: [
      { t: 0 },
      { t: 0.35, ease: 'in', j: { bodyY: -0.06, neckPitch: -0.15, legFL: 0.2, legFR: 0.2, frontMute: 1, backMute: 1, lidL: 0.4, lidR: 0.4 } },
      { t: 0.95, ease: 'inout', j: { bodyY: -0.62, legFL: 1.5, legFR: 1.5, kneeFL: -1.5, kneeFR: -1.5, legBL: -1.3, legBR: -1.3, kneeBL: 1.4, kneeBR: 1.4, frontMute: 1, backMute: 1, neckPitch: -0.5, headPitch: -0.2, lidL: 0.9, lidR: 0.9, lookMute: 1 } },
      { t: 1.4, ease: 'out', j: { bodyY: -0.66, legFL: 1.55, legFR: 1.55, kneeFL: -1.55, kneeFR: -1.55, legBL: -1.35, legBR: -1.35, kneeBL: 1.45, kneeBR: 1.45, frontMute: 1, backMute: 1, neckPitch: -1.55, headPitch: -0.32, lidL: 1, lidR: 1, lookMute: 1, jaw: 0.05 } },
    ],
  },
};

// Gait tables. Leg order is [FL, FR, BL, BR]; phases are cycle fractions.
const GAITS = {
  idle: { hz: 0.9, ph: [0, 0.5, 0.5, 0], hip: 0, knee: 0, bob: 0, beats: 2 },
  walk: { hz: 1.05, ph: [0, 0.5, 0.75, 0.25], hip: 0.3, knee: 0.34, bob: 0.018, beats: 2 },
  trot: { hz: 1.85, ph: [0, 0.5, 0.5, 0], hip: 0.46, knee: 0.5, bob: 0.045, beats: 2 },
  gallop: { hz: 2.45, ph: [0.5, 0.6, 0, 0.1], hip: 0.62, knee: 0.74, bob: 0.1, beats: 1 },
};
// Front carpus folds back, hind hock folds forward.
const KNEE_SIGN = [-1, -1, 1, 1];
// Bend weights up the neck chain: most of the arc happens near the head, which
// is what turns a hinge into a curve.
const NECK_W = [0.16, 0.22, 0.29, 0.33];

// ---------------------------------------------------------------------------
// Killa: the nemesis llama. Smug diva, trolls the player, has opinions.
//
// buildKilla() -> {
//   group, update(dt), setGait(kind, speed01), setLook(yaw, pitch),
//   setEars(mode), playPose(name), poseTime(name), isPosing(),
//   setAttitude(v), dispose(),
//   // beyond the contract, for SFX hookup:
//   poseSnapTime(name), onPoseEvent(cb), stopPose()
// }
// ---------------------------------------------------------------------------

export function buildKilla() {
  const rig = buildCamelid({
    rig: true, sitting: false,
    bodyR: 0.42, bodyLen: 0.58, legLen: 0.82,
    neckR: 0.1, neckLen: 0.72, headR: 0.145,
    blanket: true, fluffy: false, sCurve: false,
  });
  const J = rig.joints;
  const NSEG = J.neckSegs.length;
  const BODY_Y0 = J.body.position.y;
  const EAR_X_UP = -0.2;
  const EAR_X_FLAT = 1.3;
  const EAR_Z_UP = 0.3;
  const EAR_Z_FLAT = 0.95;
  const LID_X0 = J.lids[0].rotation.x;
  const HIP_Z0 = 0;

  // Preallocated channel bags. Nothing in update() allocates.
  const pose = {};
  const held = {};
  for (let i = 0; i < CH.length; i++) { pose[CH[i]] = 0; held[CH[i]] = 0; }

  const EAR_MODES = { up: [1, 1], flat: [-1, -1], mock: [1, -1] };

  const S = {
    t: Math.random() * 20,
    phase: 0,
    gait: GAITS.idle, speed01: 0,
    hz: GAITS.idle.hz, hip: 0, knee: 0, bob: 0, beats: 2,
    ph: [0, 0.5, 0.5, 0],
    lookYawT: 0, lookPitchT: 0, lookYaw: 0, lookPitch: 0,
    earTarget: EAR_MODES.up,
    earFlick: [-1, -1], earNext: [1 + Math.random() * 4, 2 + Math.random() * 5],
    earL: 1, earR: 1,
    blink: 0, blinkT: 1 + Math.random() * 3, blinking: false,
    chewT: Math.random() * 3, chewing: true, chewPhase: 0,
    attitude: 0,
    track: null, trackName: '', trackT: 0, evIdx: 0, fade: 0, fadeLambda: 6,
    tailLag: 0,
    onEvent: null,
  };

  // Pose track playback.

  function evalTrack(tr, time) {
    const keys = tr.keys;
    let i = 0;
    for (let k = 0; k < keys.length - 1; k++) if (time >= keys[k].t) i = k;
    const a = keys[i];
    const b = keys[i + 1];
    if (!b) {
      for (let c = 0; c < CH.length; c++) {
        const k = CH[c];
        pose[k] = a.j ? a.j[k] || 0 : 0;
      }
      return;
    }
    const span = b.t - a.t;
    let u = span > 0 ? (time - a.t) / span : 1;
    u = (EASES[b.ease] || EASES.inout)(clamp(u, 0, 1));
    for (let c = 0; c < CH.length; c++) {
      const k = CH[c];
      const av = a.j ? a.j[k] || 0 : 0;
      const bv = b.j ? b.j[k] || 0 : 0;
      pose[k] = av + (bv - av) * u;
    }
  }

  function playPose(name) {
    const tr = TRACKS[name];
    if (!tr) return 0;
    S.track = tr;
    S.trackName = name;
    S.trackT = 0;
    S.evIdx = 0;
    S.fade = 1;
    S.fadeLambda = tr.fade ? 1 / tr.fade : 6;
    return tr.d;
  }

  function stopPose() {
    if (!S.track) return;
    for (let c = 0; c < CH.length; c++) held[CH[c]] = pose[CH[c]];
    S.track = null;
    S.trackName = '';
    S.fade = 1;
  }

  function poseTime(name) { return TRACKS[name] ? TRACKS[name].d : 0; }
  function poseSnapTime(name) {
    const tr = TRACKS[name];
    if (!tr || !tr.events) return 0;
    for (let i = 0; i < tr.events.length; i++) {
      if (tr.events[i].name === 'snap') return tr.events[i].t;
    }
    return 0;
  }
  function isPosing() { return S.track !== null; }
  function onPoseEvent(cb) { S.onEvent = cb; }

  // Public setters.

  function setGait(kind, speed01 = 0) {
    S.gait = GAITS[kind] || GAITS.idle;
    S.speed01 = clamp(speed01, 0, 1);
  }
  function setLook(yaw, pitch) {
    // Clamped just short of a full half turn; llamas really do get there.
    S.lookYawT = clamp(yaw, -3.05, 3.05);
    S.lookPitchT = clamp(pitch, -0.7, 0.8);
  }
  function setEars(mode) { S.earTarget = EAR_MODES[mode] || EAR_MODES.up; }
  function setAttitude(v) { S.attitude = clamp(v, 0, 1); }

  // Per-frame driver.

  function update(dt) {
    if (!(dt > 0)) return;
    dt = Math.min(dt, 0.05);
    S.t += dt;
    const t = S.t;
    const att = S.attitude;

    // 1. Pose channels, then a damped release so nothing ever pops to zero.
    if (S.track) {
      S.trackT += dt;
      const tr = S.track;
      if (tr.events) {
        while (S.evIdx < tr.events.length && S.trackT >= tr.events[S.evIdx].t) {
          if (S.onEvent) S.onEvent(S.trackName, tr.events[S.evIdx].name);
          S.evIdx++;
        }
      }
      evalTrack(tr, Math.min(S.trackT, tr.d));
      if (S.trackT >= tr.d && !tr.hold) stopPose();
    } else if (S.fade > 0.001) {
      S.fade = damp(S.fade, 0, S.fadeLambda, dt);
      for (let c = 0; c < CH.length; c++) pose[CH[c]] = held[CH[c]] * S.fade;
    } else if (S.fade !== 0) {
      S.fade = 0;
      for (let c = 0; c < CH.length; c++) pose[CH[c]] = 0;
    }

    // 2. Locomotion. Gait params are damped so transitions blend; the gallop
    //    channel overrides instantly on top (the tantrum needs that).
    const g = S.gait;
    S.hz = damp(S.hz, g.hz, 6, dt);
    S.hip = damp(S.hip, g.hip, 6, dt);
    S.knee = damp(S.knee, g.knee, 6, dt);
    S.bob = damp(S.bob, g.bob, 6, dt);
    S.beats = g.beats;
    for (let i = 0; i < 4; i++) S.ph[i] = damp(S.ph[i], g.ph[i], 7, dt);

    const gal = clamp(pose.gallop, 0, 1);
    const GG = GAITS.gallop;
    const hz = lerp(S.hz, GG.hz * 1.15, gal);
    const hipAmp = lerp(S.hip, GG.hip * 1.3, gal);
    const kneeAmp = lerp(S.knee, GG.knee * 1.25, gal);
    const bobAmp = lerp(S.bob, GG.bob * 1.35, gal);
    const beats = gal > 0.5 ? GG.beats : S.beats;

    S.phase += dt * hz * (0.65 + 0.7 * S.speed01);
    if (S.phase > 1) S.phase -= Math.floor(S.phase);
    const moving = smoothstep(0.02, 0.2, hipAmp);
    const bob = bobAmp * (0.5 - 0.5 * Math.cos(S.phase * TAU * beats));

    const frontMute = 1 - clamp(pose.frontMute, 0, 1);
    const backMute = 1 - clamp(pose.backMute, 0, 1);
    for (let i = 0; i < 4; i++) {
      const mute = i < 2 ? frontMute : backMute;
      const a = (S.phase + lerp(S.ph[i], GG.ph[i], gal)) * TAU;
      const lift = Math.max(0, Math.sin(a + 0.9));
      J.legs[i].rotation.x = Math.sin(a) * hipAmp * mute + pose[LEG_CH[i]];
      J.knees[i].rotation.x = KNEE_SIGN[i] * lift * kneeAmp * mute + pose[KNEE_CH[i]];
      if (i < 2) {
        const sx = i === 0 ? 1 : -1;
        J.legs[i].rotation.z = HIP_Z0 - sx * pose.clapX;
      }
    }

    // 3. Body: bob, ugly shake, pose offsets.
    const shake = clamp(pose.shake, 0, 1);
    J.body.position.y = BODY_Y0 + bob + pose.bodyY;
    J.body.position.z = pose.bodyZ;
    J.body.rotation.x = -bob * 1.6 + pose.bodyPitch + shake * 0.05 * Math.sin(S.phase * TAU * 3.1);
    J.body.rotation.z = 0.04 * moving * Math.sin(S.phase * TAU) + pose.bodyRoll + shake * 0.07 * Math.sin(S.phase * TAU * 2.3 + 1.1);
    J.body.rotation.y = pose.bodyYaw + shake * 0.05 * Math.sin(S.phase * TAU * 1.7);
    J.bodyMesh.scale.y = 1.1 * (1 + 0.016 * Math.sin(t * (1.6 + att * 0.9)));
    J.root.rotation.y = pose.rootYaw;

    // 4. Look aim. Base weight is a lazy glance; the 'look' pose pushes it to
    //    a hard snap. lookMute lets the tantrum ignore the player entirely.
    const lookW = clamp((0.55 + pose.lookW) * (1 - clamp(pose.lookMute, 0, 1)), 0, 1);
    const lam = lerp(4, 42, clamp(pose.lookW * 2, 0, 1));
    S.lookYaw = damp(S.lookYaw, S.lookYawT, lam, dt);
    S.lookPitch = damp(S.lookPitch, S.lookPitchT, lam, dt);
    const lyaw = S.lookYaw * lookW;
    const lpitch = S.lookPitch * lookW;

    // 5. Neck arc. The whole chain shares the bend so she curves over her own
    //    shoulder instead of hinging at the base.
    const neckPitch = lerp(-0.1, 0.14, att) + pose.neckPitch - bob * 2.0
      + 0.05 * Math.sin(t * 0.43 + 1.7) + lpitch * 0.45;
    const neckYaw = pose.neckYaw + lyaw * 0.62 + 0.06 * moving * Math.sin(S.phase * TAU + 0.6);
    const neckRoll = pose.neckRoll + 0.06 * Math.sin(t * 0.7);
    for (let i = 0; i < NSEG; i++) {
      const w = NECK_W[i];
      J.neckSegs[i].rotation.x = neckPitch * w;
      J.neckSegs[i].rotation.y = neckYaw * w;
      J.neckSegs[i].rotation.z = neckRoll * w;
    }

    // 6. Head.
    J.head.rotation.y = pose.headYaw + lyaw * 0.38 + 0.12 * (1 - lookW) * Math.sin(t * 0.31 + 2.2);
    J.head.rotation.x = pose.headPitch + lpitch * 0.55;
    J.head.rotation.z = pose.headRoll;

    // 7. Chew. Attitude speeds up the grind: bored smug chewing becomes an
    //    irritated one.
    S.chewT -= dt;
    if (S.chewT <= 0) {
      S.chewing = !S.chewing;
      S.chewT = S.chewing ? 2.5 + Math.random() * 3 : 1.2 + Math.random() * 2;
    }
    const chewRate = lerp(5.5, 9.5, att);
    if (S.chewing) {
      S.chewPhase += dt * chewRate;
      J.jaw.rotation.x = 0.15 * Math.abs(Math.sin(S.chewPhase)) + pose.jaw;
      J.jaw.position.x = 0.016 * Math.sin(S.chewPhase * 0.5);
      J.jaw.rotation.z = 0.09 * Math.sin(S.chewPhase * 0.5);
    } else {
      J.jaw.rotation.x = damp(J.jaw.rotation.x - pose.jaw, 0, 8, dt) + pose.jaw;
      J.jaw.position.x = damp(J.jaw.position.x, 0, 8, dt);
      J.jaw.rotation.z = damp(J.jaw.rotation.z, 0, 8, dt);
    }

    // 8. Ears. Base from setEars biased by attitude, plus idle flicks, plus
    //    the pose channel with enough authority to override the base entirely.
    for (let i = 0; i < 2; i++) {
      let flick = 0;
      if (S.earFlick[i] < 0) {
        S.earNext[i] -= dt;
        if (S.earNext[i] <= 0) { S.earFlick[i] = 0; S.earNext[i] = 2 + Math.random() * 5; }
      } else {
        S.earFlick[i] += dt;
        flick = Math.sin((S.earFlick[i] / 0.3) * Math.PI);
        if (S.earFlick[i] > 0.3) S.earFlick[i] = -1;
      }
      const base = clamp(S.earTarget[i] - att * 0.55, -1, 1);
      const want = clamp(base + (i === 0 ? pose.earL : pose.earR) * 2 - flick * 0.5, -1, 1);
      const cur = i === 0 ? (S.earL = damp(S.earL, want, 18, dt)) : (S.earR = damp(S.earR, want, 18, dt));
      const u = (cur + 1) * 0.5;
      const sx = i === 0 ? 1 : -1;
      J.ears[i].rotation.x = lerp(EAR_X_FLAT, EAR_X_UP, u);
      J.ears[i].rotation.z = sx * lerp(EAR_Z_FLAT, EAR_Z_UP, u);
    }

    // 9. Blink. Negative lid values open the eyes wide (the tantrum uses it).
    S.blinkT -= dt;
    if (!S.blinking && S.blinkT <= 0) { S.blinking = true; S.blinkT = 0.13; }
    else if (S.blinking && S.blinkT <= 0) { S.blinking = false; S.blinkT = 2 + Math.random() * 3.5; }
    S.blink = damp(S.blink, S.blinking ? 1 : 0, 26, dt);
    for (let i = 0; i < 2; i++) {
      const v = clamp(S.blink + (i === 0 ? pose.lidL : pose.lidR), -0.6, 1);
      J.lids[i].rotation.x = LID_X0 + v * 1.85;
    }

    // 10. Tail counterweight: lags the body so it swings after the bob.
    S.tailLag = damp(S.tailLag, J.body.rotation.x + bob * 3, 9, dt);
    J.tail.rotation.x = 0.28 - S.tailLag * 0.9 + pose.tail;
    J.tail.rotation.z = 0.18 * moving * Math.sin(S.phase * TAU * 2 + 0.4);
  }

  // The stolen encomienda, clamped in her jaw. Hidden until she actually takes
  // it. Parented to the head so it swings with every taunt and head toss,
  // which is most of what sells the theft at speed.
  const carryGeo = new THREE.CapsuleGeometry(0.085, 0.13, 4, 10);
  const carry = new THREE.Mesh(carryGeo, getMats().blanket);
  carry.position.set(0, -0.1, -0.3);
  carry.rotation.z = 1.2;
  carry.castShadow = true;
  carry.visible = false;
  J.head.add(carry);

  function setCarry(v) { carry.visible = !!v; }

  function disposeAll() {
    carryGeo.dispose();
    rig.dispose();
  }

  return {
    group: rig.group,
    update, setGait, setLook, setEars, setAttitude,
    playPose, poseTime, poseSnapTime, isPosing, stopPose, onPoseEvent,
    setCarry,
    dispose: disposeAll,
  };
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
