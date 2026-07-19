// The chasqui: star of the game. Fully procedural build + animation.
// API (ARCHITECTURE.md): buildChasqui() -> { group, update(dt, state), setMode(mode), onFootstep(cb), setIntiGlow(t01), setQipiVisible(v), dispose() }
// state: { mode: 'idle'|'run'|'jump'|'slide'|'fall'|'menu', speed01, airT, leanX, dead }
// Group origin at feet, character faces -Z. Zero allocations inside update().
//
// Guineo 2.0 (skinned body): the segmented capsule limbs are replaced by ONE
// continuous THREE.SkinnedMesh (torso + arms + legs in a single low-poly
// BufferGeometry, ~1600 verts) driven by a real THREE.Bone hierarchy at the
// exact pivots of the old rig (hips 0.62, knees 0.38, feet 0.12, shoulders
// ~1.04 world). Limbs are capsule-ish ring-loop tubes; every vertex carries a
// 2-bone skin blend with soft falloff across the elbow/knee/shoulder/hip/neck
// joints (dense ring loops at knees and elbows keep the fold smooth), so the
// body DEFORMS instead of hinging like a puppet. The bind pose IS the rest
// pose (all bone rotations zero), so frame one shows no T-pose flash.
// Rigid pieces stay rigid, parented to bones: head + face rig, chullo +
// pompoms, poncho flaps, unku skirt + sleeves (cloth), qipi, cord, pututu,
// sandals. The animation system is the original one, ported 1:1: it drives
// bone.rotation / bone.position with the same names and the same math (run
// cycle, jump tuck, slide, tumble, wave, blink, breathing, pompom spring,
// footstep events).

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { CONFIG } from './config.js';
import { clamp, damp, lerp, smoothstep, TAU } from './util.js';
import { applyCurvature, makeMat, Tex } from './materials.js';

// ---------------------------------------------------------------------------
// Rim light. Guineo's skin sat at almost the same LIGHTNESS as the compacted
// earth road, so from the gameplay camera his silhouette dissolved into the
// surface he runs on, which is fatal in a runner. A warm fresnel edge picks
// him out against earth, stone, grass and snow alike without touching his
// albedo, and reads as hard high-altitude sun rather than as an outline.
//
// It chains ONTO the material's existing onBeforeCompile instead of replacing
// it, so the shared curved-world vertex bend from materials.js still runs.
// Injected before <dithering_fragment>, i.e. after tone mapping and the
// colorspace conversion, so the strength is in display space and cannot blow
// through the bloom threshold the way a pre-tonemap add would.
// ---------------------------------------------------------------------------
const RIM_CHUNK = `
{
  float rimF = 1.0 - clamp( dot( normalize( normal ), normalize( vViewPosition ) ), 0.0, 1.0 );
  rimF = pow( rimF, uRimPower );
  gl_FragColor.rgb += uRimColor * ( rimF * uRimStrength );
}
`;

// Every rim material shares one program: the patch source is identical and the
// tuning values are per-material uniforms, so this is a single extra compile.
function rimPatch(shader) {
  shader.uniforms.uRimColor = { value: new THREE.Color(0xffd9a0) };
  shader.uniforms.uRimStrength = { value: 0.22 };
  shader.uniforms.uRimPower = { value: 2.6 };
  shader.fragmentShader = shader.fragmentShader
    .replace(
      '#include <common>',
      '#include <common>\nuniform vec3 uRimColor;\nuniform float uRimStrength;\nuniform float uRimPower;'
    )
    .replace('#include <dithering_fragment>', RIM_CHUNK + '\n#include <dithering_fragment>');
}

function applyRim(mat) {
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = function (shader, renderer) {
    if (prev) prev.call(this, shader, renderer);
    rimPatch(shader);
  };
  // Distinct from the curvature-only key so rimmed and plain materials do not
  // collide in the program cache.
  mat.customProgramCacheKey = () => 'chasquiRim';
  return mat;
}

const HALF_PI = Math.PI / 2;
const HIP_Y = 0.62;
// Eyelid cap rotation. The cap poles at +Y, so a more negative rotation.x tips
// it forward over the pupil. The old rest value (-0.35) was already a heavy
// hood that buried the iris; open is now barely a hood at all.
// Measured in the canted eye pivot's own frame, so it carries the pivot's
// -0.27 x cant: 0.72 here lands as a lid that just kisses the top of the iris.
const LID_OPEN = 0.72;
const LID_SHUT = -1.30;

let sharedMats = null;
function getMats() {
  if (sharedMats) return sharedMats;
  const C = CONFIG.colors;
  // CONFIG.colors.skinBrown (0xa8744a) sits within ~20 points of luminance of
  // CONFIG.colors.pathTan, the compacted-earth road, so from behind at speed
  // Guineo's arms and legs merged into the surface. Deepened a step: value is
  // what separates a silhouette, and going DARKER separates him further from
  // the road than going lighter would, while staying a natural warm brown.
  const SKIN = 0x96603a;
  sharedMats = {
    skin: makeMat({ color: SKIN, roughness: 0.72 }),
    // Dedicated instance for the SkinnedMesh so the skinned shader program
    // never has to share a material with rigid meshes.
    skinBody: makeMat({ color: SKIN, roughness: 0.72 }),
    hair: makeMat({ color: C.hairBlack, roughness: 0.95 }),
    eyeWhite: makeMat({ color: 0xffffff, roughness: 0.25 }),
    // Warm dark brown rather than near black: at this size the iris is a large
    // shape, and a true void reads as a hole punched in his face.
    iris: makeMat({ color: 0x46301c, roughness: 0.35 }),
    glint: makeMat({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.9 }),
    lid: makeMat({ color: SKIN, roughness: 0.8, side: THREE.DoubleSide }),
    cheek: makeMat({ color: 0xc9705a, roughness: 1 }),
    mouth: makeMat({ color: 0x3a231a, roughness: 0.8 }),
    // Warmed a step off CONFIG.tunicWhite: the token value reads cold grey
    // against the blue sky fill, which is most of why the unku looked like
    // cardboard. Detail comes from the woven hem and cuff bands instead of a
    // map: Tex.woven over a near-tone cream just produces corrugated stripes.
    tunic: makeMat({ color: 0xe6d8bb, roughness: 0.95 }),
    // Open tunic cloth sheets (unku skirt, sleeves) are seen from both sides.
    tunicCloth: makeMat({ color: 0xe6d8bb, roughness: 0.95, side: THREE.DoubleSide }),
    shorts: makeMat({ color: C.accentNavy, roughness: 0.95 }),
    // Open cloth sheets are seen from both sides.
    poncho: makeMat({ color: C.ponchoRed, roughness: 0.9, side: THREE.DoubleSide }),
    ponchoTrim: makeMat({
      map: Tex.woven(['#d97b29', '#e8c14d', '#2c3e50', '#b03a2e']),
      roughness: 0.92, side: THREE.DoubleSide,
    }),
    // Private instances rather than the shared Mats.cloth singletons: these
    // carry Guineo's rim patch, and rimming a cached material would put the
    // edge light on every other prop that happens to ask for the same weave.
    trim: makeMat({
      map: Tex.woven(['#d97b29', '#e8c14d', '#2c3e50', '#b03a2e']), roughness: 0.92,
    }),
    chullo: makeMat({ color: 0x8c2f24, roughness: 0.95 }),
    band: makeMat({
      map: Tex.woven(['#e8c14d', '#b03a2e', '#2c3e50', '#d97b29']), roughness: 0.92,
    }),
    pomRed: makeMat({ color: 0xd6493c, roughness: 1 }),
    pomYellow: makeMat({ color: C.accentYellow, roughness: 1 }),
    sandal: makeMat({ color: C.woodBrown, roughness: 0.95 }),
    conch: makeMat({ color: 0xe8d7bd, roughness: 0.55 }),
    // Contact shadow. He already casts a real shadow, but at the gameplay
    // camera it is soft and offset, so nothing pins him to the road. This adds
    // the dark band directly under the feet that anchors him. Unlit on
    // purpose, and it still takes the world bend so it stays glued to a
    // curving road.
    contact: applyCurvature(new THREE.MeshBasicMaterial({
      map: Tex.softCircle('#000000'),
      transparent: true, opacity: 0.34, depthWrite: false,
    })),
  };
  // Skin, cloth and gear take the rim. The eye parts and the mouth interior
  // are deliberately left out: an edge light on a 5 cm sphere just frosts the
  // eye and undoes the soft dark iris.
  const RIMMED = [
    'skin', 'skinBody', 'hair', 'lid', 'cheek', 'tunic', 'tunicCloth',
    'shorts', 'poncho', 'ponchoTrim', 'trim', 'chullo', 'band',
    'pomRed', 'pomYellow', 'sandal', 'conch',
  ];
  for (const k of RIMMED) applyRim(sharedMats[k]);
  return sharedMats;
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

function addBone(parent, name, x = 0, y = 0, z = 0) {
  const b = new THREE.Bone();
  b.name = name;
  b.position.set(x, y, z);
  parent.add(b);
  return b;
}

// Curved poncho cloth: an open partial cone wrapped around the torso axis,
// with baked-in hem waviness and rounded lower corners. Centered on +Z;
// the front sheet is rotated PI at the mesh level. refTop/refH let the trim
// band sample the same wave field as the flap it rides on.
function makeFlapGeo(rT, rB, yTop, yBot, sweep, waveAmp, cornerLift, refTop, refH) {
  const h = yTop - yBot;
  const geo = new THREE.CylinderGeometry(rT, rB, h, 10, 4, true, -sweep / 2, sweep);
  geo.translate(0, yTop - h / 2, 0);
  if (refTop === undefined) { refTop = yTop; refH = h; }
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const s = clamp(Math.atan2(x, z) / sweep + 0.5, 0, 1);
    const d = clamp((refTop - y) / refH, 0, 1);
    const wave = 1 + waveAmp * d * Math.sin(s * Math.PI * 5.2 + 0.4);
    pos.setX(i, x * wave);
    pos.setZ(i, z * wave);
    const corner = 1 - Math.sin(Math.PI * s);
    pos.setY(i, y + cornerLift * corner * corner * d);
  }
  geo.computeVertexNormals();
  return geo;
}

// ---------------------------------------------------------------------------
// Skinned body geometry. Bone indices into the skeleton bone list:
// ---------------------------------------------------------------------------
const B = {
  hips: 0, torso: 1, neck: 2, head: 3,
  legL: 4, kneeL: 5, footL: 6,
  legR: 7, kneeR: 8, footR: 9,
  armL: 10, elbowL: 11, armR: 12, elbowR: 13,
};

// One continuous low-poly body (torso + both arms + both legs) built from
// capsule-ish tubes of ring loops. Every ring stores a 2-bone blend
// (w0 on b0, 1-w0 on b1) computed by distance along the limb to the joint,
// with a soft graded falloff (7 rings, 0.01-0.02 m spacing, across each knee
// and elbow: this is what keeps the fold from collapsing into a crease).
// Vertices are authored in character space (origin at feet), which is also
// the bind pose: all bone rotations zero.
function buildBodyGeometry() {
  const pos = [], idx = [], sIdx = [], sWgt = [];

  // rings: [y, r, b0, b1, w0, cx = 0, sx = 1, sz = 1], ordered bottom to top.
  function tube(radial, rings, poleBotY, poleTopY) {
    const start = pos.length / 3;
    for (let i = 0; i < rings.length; i++) {
      const ring = rings[i];
      const y = ring[0], r = ring[1], b0 = ring[2], b1 = ring[3], w0 = ring[4];
      const cx = ring[5] || 0, sx = ring[6] || 1, sz = ring[7] || 1;
      for (let k = 0; k < radial; k++) {
        const a = (k / radial) * TAU;
        pos.push(cx + Math.cos(a) * r * sx, y, Math.sin(a) * r * sz);
        sIdx.push(b0, b1, 0, 0);
        sWgt.push(w0, 1 - w0, 0, 0);
      }
    }
    // Side quads (outward winding).
    for (let i = 0; i < rings.length - 1; i++) {
      for (let k = 0; k < radial; k++) {
        const a = start + i * radial + k;
        const b = start + i * radial + ((k + 1) % radial);
        const c = a + radial;
        const d = b + radial;
        idx.push(a, c, b, b, c, d);
      }
    }
    // Bottom pole cap.
    const r0 = rings[0], rN = rings[rings.length - 1];
    const pBot = pos.length / 3;
    pos.push(r0[5] || 0, poleBotY, 0);
    sIdx.push(r0[2], r0[3], 0, 0);
    sWgt.push(r0[4], 1 - r0[4], 0, 0);
    for (let k = 0; k < radial; k++) {
      idx.push(pBot, start + k, start + ((k + 1) % radial));
    }
    // Top pole cap.
    const pTop = pos.length / 3;
    const lastRow = start + (rings.length - 1) * radial;
    pos.push(rN[5] || 0, poleTopY, 0);
    sIdx.push(rN[2], rN[3], 0, 0);
    sWgt.push(rN[4], 1 - rN[4], 0, 0);
    for (let k = 0; k < radial; k++) {
      idx.push(pTop, lastRow + ((k + 1) % radial), lastRow + k);
    }
  }

  // Leg tube: foot dome region, ankle blend, shin, dense knee loops, thigh,
  // hip blend embedded in the pelvis. cx = +-0.095.
  function leg(cx, T, K, F, H) {
    tube(18, [
      [0.050, 0.048, F, F, 1.00, cx],
      [0.080, 0.054, F, F, 1.00, cx],
      [0.105, 0.057, F, K, 0.72, cx],
      [0.130, 0.058, F, K, 0.42, cx],
      [0.160, 0.060, F, K, 0.15, cx],
      [0.200, 0.061, K, K, 1.00, cx],
      [0.255, 0.063, K, K, 1.00, cx],
      [0.305, 0.065, K, K, 1.00, cx],
      [0.340, 0.066, K, T, 0.82, cx],
      [0.360, 0.067, K, T, 0.66, cx],
      [0.370, 0.068, K, T, 0.58, cx],
      [0.380, 0.068, K, T, 0.50, cx],
      [0.390, 0.069, K, T, 0.42, cx],
      [0.400, 0.070, K, T, 0.34, cx],
      [0.420, 0.072, K, T, 0.18, cx],
      [0.455, 0.076, T, T, 1.00, cx],
      [0.510, 0.081, T, T, 1.00, cx],
      [0.565, 0.084, T, T, 1.00, cx],
      [0.615, 0.080, T, H, 0.80, cx],
      [0.650, 0.074, T, H, 0.55, cx],
    ], 0.030, 0.664);
  }
  leg(0.095, B.legL, B.kneeL, B.footL, B.hips);
  leg(-0.095, B.legR, B.kneeR, B.footR, B.hips);

  // Arm tube: hand bulge (replaces the old rigid hand sphere), wrist pinch,
  // forearm, dense elbow loops, upper arm, shoulder blend leaning into the
  // torso under the yoke and sleeve. s = +-1.
  function arm(s, A, E) {
    const cx = s * 0.225;
    tube(18, [
      [0.600, 0.030, E, E, 1.00, cx, 0.95, 1.05],
      [0.622, 0.050, E, E, 1.00, cx, 0.95, 1.08],
      [0.650, 0.058, E, E, 1.00, cx, 0.95, 1.08],
      [0.678, 0.052, E, E, 1.00, cx, 0.95, 1.05],
      [0.706, 0.044, E, E, 1.00, cx],
      [0.745, 0.048, E, E, 1.00, cx],
      [0.795, 0.050, E, E, 1.00, cx],
      [0.830, 0.051, E, A, 0.85, cx],
      [0.850, 0.052, E, A, 0.68, cx],
      [0.860, 0.052, E, A, 0.59, cx],
      [0.870, 0.053, E, A, 0.50, cx],
      [0.880, 0.053, E, A, 0.41, cx],
      [0.890, 0.054, E, A, 0.32, cx],
      [0.910, 0.054, E, A, 0.15, cx],
      [0.945, 0.055, A, A, 1.00, cx],
      [0.985, 0.057, A, A, 1.00, cx],
      [1.020, 0.059, A, B.torso, 0.85, s * 0.223],
      [1.045, 0.056, A, B.torso, 0.62, s * 0.215],
      [1.062, 0.042, A, B.torso, 0.40, s * 0.205],
    ], 0.585, 1.072);
  }
  arm(1, B.armL, B.elbowL);
  arm(-1, B.armR, B.elbowR);

  // Torso tube: pelvis (hips bone) to neck (neck/head blend). Sits a few mm
  // INSIDE the rigid tunic chest lathe so they never z-fight; the tube only
  // surfaces at the collar, where it reads as the neck emerging from the
  // tunic, and it is what welds shoulders, hips and head into one body.
  tube(20, [
    [0.575, 0.118, B.hips, B.hips, 1.00, 0, 1, 0.88],
    [0.605, 0.150, B.hips, B.hips, 1.00, 0, 1, 0.88],
    [0.635, 0.161, B.hips, B.torso, 0.66, 0, 1, 0.88],
    [0.665, 0.167, B.hips, B.torso, 0.40, 0, 1, 0.88],
    [0.700, 0.170, B.torso, B.torso, 1.00, 0, 1, 0.88],
    [0.760, 0.172, B.torso, B.torso, 1.00, 0, 1, 0.88],
    [0.825, 0.168, B.torso, B.torso, 1.00, 0, 1, 0.88],
    [0.885, 0.160, B.torso, B.torso, 1.00, 0, 1, 0.88],
    [0.945, 0.147, B.torso, B.torso, 1.00, 0, 1, 0.88],
    [1.000, 0.128, B.torso, B.torso, 1.00, 0, 1, 0.88],
    [1.035, 0.098, B.torso, B.torso, 1.00, 0, 1, 0.88],
    [1.060, 0.072, B.torso, B.neck, 0.62, 0, 1, 0.90],
    [1.085, 0.062, B.neck, B.torso, 0.75, 0, 1, 0.92],
    [1.110, 0.058, B.neck, B.neck, 1.00, 0, 1, 0.95],
    [1.135, 0.056, B.neck, B.head, 0.72, 0, 1, 0.95],
    [1.160, 0.055, B.neck, B.head, 0.50, 0, 1, 0.95],
  ], 0.558, 1.175);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(sIdx, 4));
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sWgt, 4));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

export function buildChasqui() {
  const MT = getMats();
  const group = new THREE.Group();
  const geos = [];
  const G = (g) => { geos.push(g); return g; };

  // ---- Skeleton: THREE.Bone hierarchy at the original pivots --------------
  const hips = addBone(group, 'hips', 0, HIP_Y, 0);
  const torso = addBone(hips, 'torso', 0, 0, 0);
  const neck = addBone(torso, 'neck', 0, 0.46, 0);
  const head = addBone(neck, 'head', 0, 0.13, 0);

  const legL = addBone(hips, 'legL', 0.095, 0.02, 0);
  const kneeL = addBone(legL, 'kneeL', 0, -0.26, 0);
  const footL = addBone(kneeL, 'footL', 0, -0.26, 0);
  const legR = addBone(hips, 'legR', -0.095, 0.02, 0);
  const kneeR = addBone(legR, 'kneeR', 0, -0.26, 0);
  const footR = addBone(kneeR, 'footR', 0, -0.26, 0);

  const armL = addBone(torso, 'armL', 0.225, 0.42, 0);
  const elbowL = addBone(armL, 'elbowL', 0, -0.17, 0);
  const armR = addBone(torso, 'armR', -0.225, 0.42, 0);
  const elbowR = addBone(armR, 'elbowR', 0, -0.17, 0);

  const bones = [
    hips, torso, neck, head,
    legL, kneeL, footL,
    legR, kneeR, footR,
    armL, elbowL, armR, elbowR,
  ];

  // ---- Skinned body (bind pose = rest pose = current zero rotations) ------
  const body = new THREE.SkinnedMesh(G(buildBodyGeometry()), MT.skinBody);
  body.castShadow = true;
  // The body deforms around the origin the character sits at; culling by the
  // static bind-pose bounds would pop it during tumbles.
  body.frustumCulled = false;
  group.add(body);
  group.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(bones);
  body.bind(skeleton);

  // ---- Rigid attachments (parented to bones) ------------------------------
  // Sandal: flat rounded sole, soft foot dome, toe strap arc, and a tall
  // ojota strap cuff that dresses the skinned ankle. Foot pivot world y =
  // 0.12; sole bottom rests at y ~0.007 (never below 0).
  // segments 1: same silhouette on a 3 cm-thick sole, a third of the verts.
  const soleGeo = G(new RoundedBoxGeometry(0.105, 0.03, 0.19, 1, 0.012));
  const domeGeo = G(new THREE.SphereGeometry(0.054, 12, 9));
  const strapGeo = G(new THREE.TorusGeometry(0.048, 0.009, 5, 10, Math.PI));
  const cuffGeo = G(new THREE.CylinderGeometry(0.068, 0.075, 0.085, 10));
  for (const f of [footL, footR]) {
    addMesh(f, soleGeo, MT.sandal, 0, -0.098, -0.02);
    const dome = addMesh(f, domeGeo, MT.skin, 0, -0.072, -0.028);
    dome.scale.set(0.92, 0.62, 1.3);
    const strap = addMesh(f, strapGeo, MT.sandal, 0, -0.086, -0.062);
    strap.scale.set(1, 0.6, 1);
    strap.rotation.x = -0.12;
    addMesh(f, cuffGeo, MT.sandal, 0, -0.03, -0.004);
  }

  // Rounded shorts over the skinned pelvis.
  const shortsMesh = addMesh(torso, G(new THREE.SphereGeometry(0.175, 14, 10)), MT.shorts, 0, 0.045, 0);
  shortsMesh.scale.set(0.94, 0.62, 0.9);

  // Tunic chest: lathe barrel worn OVER the skinned torso.
  const chestPts = [
    new THREE.Vector2(0.115, 0.035),
    new THREE.Vector2(0.158, 0.10),
    new THREE.Vector2(0.176, 0.19),
    new THREE.Vector2(0.172, 0.27),
    new THREE.Vector2(0.150, 0.35),
    new THREE.Vector2(0.118, 0.415),
    new THREE.Vector2(0.062, 0.455),
    new THREE.Vector2(0.0, 0.465),
  ];
  const chest = addMesh(torso, G(new THREE.LatheGeometry(chestPts, 14)), MT.tunic);

  // Yoke: soft cone collar draping over the shoulders (elliptical).
  const yokePts = [
    new THREE.Vector2(0.085, 0.515),
    new THREE.Vector2(0.14, 0.49),
    new THREE.Vector2(0.19, 0.452),
    new THREE.Vector2(0.225, 0.41),
    new THREE.Vector2(0.243, 0.375),
  ];
  const yoke = addMesh(torso, G(new THREE.LatheGeometry(yokePts, 14)), MT.poncho);
  yoke.scale.z = 0.78;

  // Unku skirt: the white tunic extended to just above the knees, hiding the
  // hip joints. Front/back waist-hinged cloth flaps with side slits (as on a
  // real unku); update() rides them on the thighs so the hem never eats the
  // legs at full stride. Hem rests at world y ~0.455 (knee tops at ~0.44).
  const skirtGeo = G(makeFlapGeo(0.173, 0.21, 0, -0.28, 2.5, 0.04, 0.05));
  // Woven hem band riding the same wave field, so the unku ends in a real
  // selvedge instead of a raw cut edge. Without it the skirt is the biggest
  // untextured mass on the character and reads as a paper cone.
  const skirtTrimGeo = G(makeFlapGeo(0.202, 0.212, -0.196, -0.262, 2.5, 0.04, 0.05, 0, 0.28));
  const skirtF = addPivot(torso, 0, 0.115, -0.12);
  const skirtFront = addMesh(skirtF, skirtGeo, MT.tunicCloth, 0, 0, 0.12);
  skirtFront.rotation.y = Math.PI;
  const skirtTrimFront = addMesh(skirtF, skirtTrimGeo, MT.ponchoTrim, 0, 0, 0.12);
  skirtTrimFront.rotation.y = Math.PI;
  const skirtB = addPivot(torso, 0, 0.115, 0.12);
  addMesh(skirtB, skirtGeo, MT.tunicCloth, 0, 0, -0.12);
  addMesh(skirtB, skirtTrimGeo, MT.ponchoTrim, 0, 0, -0.12);

  // Poncho flaps: curved cloth sheets with wavy rounded hems + woven trim.
  const SWEEP = 2.1;
  const flapGeo = G(makeFlapGeo(0.19, 0.25, 0, -0.33, SWEEP, 0.05, 0.10));
  const trimGeo = G(makeFlapGeo(0.240, 0.251, -0.235, -0.298, SWEEP, 0.05, 0.10, 0, 0.33));
  const ponchoF = addPivot(torso, 0, 0.43, -0.19);
  const flapFront = addMesh(ponchoF, flapGeo, MT.poncho, 0, 0, 0.19);
  flapFront.rotation.y = Math.PI;
  const trimFront = addMesh(ponchoF, trimGeo, MT.ponchoTrim, 0, 0, 0.19);
  trimFront.rotation.y = Math.PI;
  const ponchoB = addPivot(torso, 0, 0.43, 0.19);
  addMesh(ponchoB, flapGeo, MT.poncho, 0, 0, -0.19);
  addMesh(ponchoB, trimGeo, MT.ponchoTrim, 0, 0, -0.19);

  // ---- Qipi: diagonal cloth bundle with rope wrap and knots ---------------
  const qipi = addPivot(torso, 0, 0.31, 0.30);
  qipi.rotation.z = 1.2;
  qipi.rotation.x = 0.10;
  addMesh(qipi, G(new THREE.CapsuleGeometry(0.105, 0.16, 4, 12)), MT.trim);
  const wrap = addMesh(qipi, G(new THREE.TorusGeometry(0.108, 0.013, 6, 14)), MT.sandal, 0, 0.005, 0);
  wrap.rotation.x = HALF_PI;
  const knotA = addMesh(qipi, G(new THREE.SphereGeometry(0.05, 9, 7)), MT.trim, 0, 0.155, 0.02);
  knotA.scale.set(1, 0.8, 0.9);
  const knotB = addMesh(qipi, G(new THREE.SphereGeometry(0.043, 9, 7)), MT.trim, 0, -0.15, -0.015);
  knotB.scale.set(1, 0.82, 0.9);

  // Chest cord: curved tube from shoulder to hip, hugging the tunic.
  const cordCurve = new THREE.QuadraticBezierCurve3(
    new THREE.Vector3(0.10, 0.465, -0.08),
    new THREE.Vector3(0.0, 0.29, -0.225),
    new THREE.Vector3(-0.13, 0.10, -0.09)
  );
  addMesh(torso, G(new THREE.TubeGeometry(cordCurve, 10, 0.016, 6, false)), MT.sandal);

  // Pututu conch at the right hip: lathe spiral shell. Hangs low and out so
  // it sits in the unku's side slit instead of vanishing under the skirt.
  const conchPts = [];
  for (let i = 0; i <= 8; i++) {
    const t = i / 8;
    conchPts.push(new THREE.Vector2(0.012 + Math.sin(t * Math.PI) * 0.052 * (1 - t * 0.3), t * 0.17));
  }
  const conch = addMesh(hips, G(new THREE.LatheGeometry(conchPts, 10)), MT.conch, -0.215, -0.09, 0.05);
  conch.rotation.set(0.4, 0, -1.2);

  // ---- Sleeves + shoulder fill (rigid cloth riding the upper arm bones) ---
  // The old sleeve flared from r 0.074 to r 0.096 over 0.29 m while the arm
  // beneath it is only r ~0.05, so it hung off the limb as an open-ended
  // cardboard bell. It is now a short unku sleeve that tapers back IN toward
  // the arm and closes on a woven cuff, so it reads as worn cloth.
  const shoulderGeo = G(new THREE.SphereGeometry(0.066, 10, 8));
  const sleeveGeo = G(new THREE.CylinderGeometry(0.076, 0.066, 0.20, 10, 1, true));
  sleeveGeo.translate(0, -0.075, 0);
  const sleeveTrimGeo = G(new THREE.CylinderGeometry(0.0675, 0.0705, 0.032, 10, 1, true));
  sleeveTrimGeo.translate(0, -0.166, 0);
  addMesh(armL, shoulderGeo, MT.tunic);
  addMesh(armR, shoulderGeo, MT.tunic);
  addMesh(armL, sleeveGeo, MT.tunicCloth);
  addMesh(armR, sleeveGeo, MT.tunicCloth);
  addMesh(armL, sleeveTrimGeo, MT.ponchoTrim);
  addMesh(armR, sleeveTrimGeo, MT.ponchoTrim);

  // Hands. The skinned arm tube already carries a hand bulge, but on its own
  // it reads as a rounded stump at any distance. A flattened palm plus a
  // thumb gives the silhouette an actual terminus, which is what sells the
  // arm swing during the run and the wave on the title screen. Parented to
  // the elbow bone so they follow the forearm.
  // A scaled sphere, not a RoundedBoxGeometry: at segments 2 that primitive
  // costs 900 verts, which is absurd for a part the size of a coin, and a
  // soft mitten reads better on a stylized kid than a box anyway. The scale
  // reproduces the same 62 x 78 x 46 mm envelope for 80 verts.
  const palmGeo = G(new THREE.SphereGeometry(0.036, 9, 7));
  const thumbGeo = G(new THREE.CapsuleGeometry(0.014, 0.022, 2, 6));
  for (const s of [1, -1]) {
    const e = s > 0 ? elbowL : elbowR;
    const palm = addMesh(e, palmGeo, MT.skin, 0, -0.232, -0.004);
    palm.scale.set(0.86, 1.08, 0.64);
    palm.rotation.set(0.10, 0, s * 0.12);
    const thumb = addMesh(e, thumbGeo, MT.skin, s * 0.034, -0.212, -0.020);
    thumb.rotation.set(0.35, 0, s * 0.55);
  }

  // ---- Head and face ------------------------------------------------------
  const skull = addMesh(head, G(new THREE.SphereGeometry(0.20, 20, 16)), MT.skin, 0, 0.02, 0);
  skull.scale.set(1, 0.96, 0.99);
  // Soft jaw: squashed lower sphere merged into the skull. Pulled down and in
  // so it never swallows the lower half of the eyeballs.
  const jawSoft = addMesh(head, G(new THREE.SphereGeometry(0.15, 16, 12)), MT.skin, 0, -0.092, -0.018);
  jawSoft.scale.set(0.88, 0.74, 0.92);
  // Hair: a narrow band peeking under the hat, plus a fringe that stops at the
  // BROW line. The old ring reached y = -0.028 and the old fringe y = 0.025,
  // i.e. both hung across the eyes and merged into one black bar that read as
  // a blindfold. Everything above the brows now, nothing across the eyes.
  const hairRing = addMesh(head, G(new THREE.SphereGeometry(0.206, 16, 10)), MT.hair, 0, 0.098, 0);
  hairRing.scale.set(1, 0.33, 1);
  const fringe = addMesh(head, G(new THREE.SphereGeometry(0.10, 12, 8)), MT.hair, 0, 0.095, -0.150);
  fringe.scale.set(1.42, 0.20, 0.74);

  // Eyes. The eyeball centre used to sit 0.176 from the skull centre inside a
  // 0.20 skull, so only 29% of the ball cleared the face and the lid hood ate
  // most of what was left: two dark slots. Pushed forward and enlarged so a
  // real white-and-iris eye reads at gameplay distance.
  // Eyes. A small pupil floating in a big white ball is the universal read of
  // shock, and a ball that protrudes past the face reads as stuck on rather
  // than set in: together they made him look alarmed and monstrous. Inverted
  // to the appealing-stylized ratio instead (Alto's Odyssey, A Short Hike):
  // a LARGE soft-dark iris filling almost the whole aperture, only a thin rim
  // of sclera at the edges, and the ball seated deep enough in the skull that
  // the side silhouette stays a clean cheek line.
  const EYE_R = 0.048;
  const eyeGeo = G(new THREE.SphereGeometry(EYE_R, 14, 10));
  // The iris is a CAP concentric with the eyeball, not a sphere poked through
  // it, so it lies flush on the surface at any size. thetaLength 1.05 rad puts
  // the iris edge at ~60 degrees off the eye axis, slightly WIDER than the
  // ~56 degree aperture the skull cuts, so the iris fills the opening and the
  // sclera survives only as a thin rim at the very corners.
  const irisGeo = G(new THREE.SphereGeometry(EYE_R * 1.012, 14, 9, 0, TAU, 0, 1.05));
  irisGeo.rotateX(-HALF_PI);
  const glintGeo = G(new THREE.SphereGeometry(0.0095, 6, 5));
  const lidGeo = G(new THREE.SphereGeometry(EYE_R * 1.05, 12, 7, 0, TAU, 0, Math.PI * 0.54));
  const eyes = [];
  const lids = [];
  for (const sx of [1, -1]) {
    const eye = addPivot(head, sx * 0.068, -0.020, -0.150);
    // The ball sits deep in the skull, so the aperture the face actually cuts
    // is centred on the OUTWARD radial direction, not on straight ahead. The
    // pivot is canted onto that axis so the iris cap fills the opening evenly
    // instead of leaving a sclera crescent down one side, and the lid (a child
    // of this pivot) follows the same axis.
    eye.rotation.set(-0.27, -sx * 0.41, 0);
    addMesh(eye, eyeGeo, MT.eyeWhite);
    addMesh(eye, irisGeo, MT.iris);
    addMesh(eye, glintGeo, MT.glint, sx * 0.006, 0.021, -0.042);
    const lid = addPivot(eye, 0, 0, 0);
    addMesh(lid, lidGeo, MT.lid);
    lid.rotation.x = LID_OPEN;
    eyes.push(eye);
    lids.push(lid);
  }

  // Softer brows: thinner, flatter and less angled than the heavy wedges that
  // were adding to the alarmed read. Warm and friendly with a hint of resolve.
  const brows = addPivot(head, 0, 0.052, -0.155);
  // segments 1, not 2: on a 2 cm bar the corner subdivision is invisible and
  // segments 2 costs 900 verts per brow.
  const browGeo = G(new RoundedBoxGeometry(0.074, 0.018, 0.022, 1, 0.008));
  const browL = addMesh(brows, browGeo, MT.hair, 0.069, 0, -0.038);
  browL.rotation.set(0, 0.26, -0.08);
  const browR = addMesh(brows, browGeo, MT.hair, -0.069, 0, -0.038);
  browR.rotation.set(0, -0.26, 0.08);

  // Tiny rounded button nose: soft cone + sphere tip.
  const nose = addMesh(head, G(new THREE.ConeGeometry(0.020, 0.044, 10)), MT.skin, 0, -0.072, -0.198);
  nose.rotation.x = -HALF_PI;
  addMesh(head, G(new THREE.SphereGeometry(0.0135, 8, 6)), MT.skin, 0, -0.072, -0.219);

  const smile = addMesh(head, G(new THREE.TorusGeometry(0.048, 0.0085, 5, 10, 1.9)), MT.mouth, 0, -0.112, -0.174);
  smile.rotation.set(-0.22, 0, -HALF_PI - 0.95);
  const cheekGeo = G(new THREE.SphereGeometry(0.030, 8, 6));
  const cheekL = addMesh(head, cheekGeo, MT.cheek, 0.128, -0.090, -0.132);
  cheekL.scale.set(1, 0.70, 0.40);
  cheekL.rotation.y = -0.6;
  const cheekR = addMesh(head, cheekGeo, MT.cheek, -0.128, -0.090, -0.132);
  cheekR.scale.set(1, 0.70, 0.40);
  cheekR.rotation.y = 0.6;

  // ---- Chullo hat: sphere-slice cap, knitted band, teardrop ear flaps -----
  // Raised so the band clears the fringe instead of sitting on the brows.
  addMesh(head, G(new THREE.SphereGeometry(0.222, 16, 10, 0, TAU, 0, Math.PI * 0.55)), MT.chullo, 0, 0.142, 0);
  addMesh(head, G(new THREE.CylinderGeometry(0.226, 0.232, 0.095, 16, 1, true)), MT.band, 0, 0.148, 0);
  const earflapGeo = G(new THREE.SphereGeometry(0.08, 9, 8));
  earflapGeo.scale(0.55, 1.3, 0.36);
  earflapGeo.translate(0, -0.085, 0);
  for (const sx of [1, -1]) {
    const flap = addPivot(head, sx * 0.198, 0.108, -0.015);
    flap.rotation.z = sx * 0.3;
    addMesh(flap, earflapGeo, MT.band);
    addMesh(flap, G(new THREE.SphereGeometry(0.033, 8, 6)), MT.pomYellow, 0, -0.185, 0);
  }
  const pompom = addPivot(head, 0, 0.345, 0);
  addMesh(pompom, G(new THREE.SphereGeometry(0.056, 10, 8)), MT.pomRed, 0, 0.035, 0);

  // ---- Contact shadow ------------------------------------------------------
  // Parented to `group` so it follows lane changes and inherits the land
  // squash (which reads as the blob spreading on impact). Hidden during the
  // death tumble, when `group` spins and a ground-locked decal would spin
  // with it.
  const contactGeo = G(new THREE.PlaneGeometry(0.66, 0.66));
  const contact = new THREE.Mesh(contactGeo, MT.contact);
  contact.rotation.x = -HALF_PI;
  contact.position.y = 0.012;
  contact.renderOrder = -1;
  contact.castShadow = false;
  group.add(contact);

  // ---- Animation state (all scalars, zero per-frame allocation) -----------
  const S = {
    mode: 'idle', t: 0, phase: 0, stepIdx: 0,
    wIdle: 1, wRun: 0, wJump: 0, wSlide: 0, wFall: 0,
    squash: 0, tumbleA: 0, tumbleV: 0,
    blinkNext: 1.2, blinkT: -1,
    lookNext: 2.5, lookY: 0, lookTargetY: 0,
    waveNext: 4.5, waveT: -1,
    eyeScale: 1, browLift: 0, bank: 0,
    pomX: 0, pomZ: 0, pomVX: 0, pomVZ: 0,
  };
  const footstepCbs = [];
  const defaultState = { mode: 'idle', speed01: 0, airT: 0, leanX: 0, dead: false };

  function setMode(mode) {
    if (mode === S.mode) return;
    const prev = S.mode;
    S.mode = mode;
    if (prev === 'jump' && (mode === 'run' || mode === 'idle' || mode === 'menu')) S.squash = 1;
    if (mode === 'fall') { S.tumbleA = 0; S.tumbleV = 8.5; }
    if (prev === 'fall') { S.tumbleA = 0; S.tumbleV = 0; group.rotation.x = 0; }
    if (mode === 'idle' || mode === 'menu') S.waveNext = 2.5 + Math.random() * 3;
  }

  function onFootstep(cb) { footstepCbs.push(cb); }

  function update(dt, state) {
    if (!(dt > 0)) return;
    dt = Math.min(dt, 0.05);
    state = state || defaultState;
    if (state.mode && state.mode !== S.mode) setMode(state.mode);
    S.t += dt;
    const t = S.t;
    const sp = clamp(state.speed01 || 0, 0, 1);
    const airT = state.airT || 0;
    const mode = state.dead && S.mode !== 'fall' ? 'fall' : S.mode;
    if (mode === 'fall' && S.mode !== 'fall') setMode('fall');

    // Mode weights, smoothly blended for phase-continuous transitions.
    const idleT = mode === 'idle' || mode === 'menu' ? 1 : 0;
    S.wIdle = damp(S.wIdle, idleT, 12, dt);
    S.wRun = damp(S.wRun, mode === 'run' ? 1 : 0, 12, dt);
    S.wJump = damp(S.wJump, mode === 'jump' ? 1 : 0, 14, dt);
    S.wSlide = damp(S.wSlide, mode === 'slide' ? 1 : 0, 14, dt);
    S.wFall = damp(S.wFall, mode === 'fall' ? 1 : 0, 10, dt);
    const wI = S.wIdle, wR = S.wRun, wJ = S.wJump, wS = S.wSlide, wF = S.wFall;

    // Single stride phase accumulator (continuity across mode changes).
    // Sprint cadence: ~5.6 footfalls/s at base speed, ~8.4 flat out.
    const strideHz = 2.8 + 1.4 * sp;
    if (wR > 0.02 || wJ > 0.02) S.phase += dt * strideHz * TAU;
    const ph = S.phase;

    // Footstep events exactly at foot plants (run only).
    if (mode === 'run' && wR > 0.5) {
      const idx = Math.floor((ph - HALF_PI * 0.9) / Math.PI);
      while (S.stepIdx < idx) {
        S.stepIdx++;
        const foot = S.stepIdx & 1;
        for (let i = 0; i < footstepCbs.length; i++) footstepCbs[i](foot);
      }
      S.stepIdx = idx;
    } else {
      S.stepIdx = Math.floor((ph - HALF_PI * 0.9) / Math.PI);
    }

    // Accumulators for every joint.
    let thL = 0, knL = 0, ftL = 0, thR = 0, knR = 0, ftR = 0;
    let aLx = 0, aLz = 0, eLx = 0, eLz = 0, aRx = 0, aRz = 0, eRx = 0, eRz = 0;
    let tX = 0, tY = 0, hipDy = 0, hdX = 0, hdY = 0, hdZ = 0, hdDy = 0;
    let pFx = 0, pBx = 0, browT = 0, eyeT = 1, breathe = 0;

    // ---- RUN --------------------------------------------------------------
    if (wR > 0.003) {
      const sL = Math.sin(ph), sR = -sL;
      const legAmp = 0.62 + 0.5 * sp;
      const armAmp = 0.62 + 0.48 * sp;
      const bob = Math.sin(2 * ph + 0.7) * (0.02 + 0.028 * sp);
      thL += wR * sL * legAmp;
      thR += wR * sR * legAmp;
      knL += wR * -(0.2 + Math.max(0, Math.sin(ph + 1.25)) * (0.85 + 0.6 * sp));
      knR += wR * -(0.2 + Math.max(0, Math.sin(ph + Math.PI + 1.25)) * (0.85 + 0.6 * sp));
      ftL += wR * (0.18 + 0.22 * Math.sin(ph - 1.7));
      ftR += wR * (0.18 + 0.22 * Math.sin(ph + Math.PI - 1.7));
      aLx += wR * (-sL * armAmp + 0.1);
      aRx += wR * (-sR * armAmp + 0.1);
      aLz += wR * 0.14; aRz += wR * -0.14;
      eLx += wR * (1.05 + 0.3 * sR);
      eRx += wR * (1.05 + 0.3 * sL);
      tX += wR * -(0.14 + 0.11 * sp);           // 8 to 14 deg forward lean
      tY += wR * 0.11 * sL;
      hipDy += wR * bob;
      hdX += wR * (0.12 + 0.09 * sp);           // head counters the lean
      hdDy += wR * -bob * 0.45;                 // subtle counter-bob
      pBx += wR * (-(0.35 + 0.9 * sp) + 0.1 * sp * Math.sin(2 * ph + 1.3));
      pFx += wR * (-(0.08 + 0.32 * sp) + 0.05 * sp * Math.sin(2 * ph));
    }

    // ---- JUMP (tuck, arms swept back, poncho flare) -------------------------
    if (wJ > 0.003) {
      const tuck = Math.sin(clamp(airT * 3.4, 0, Math.PI));
      thL += wJ * 1.5 * tuck;
      knL += wJ * -2.0 * tuck;
      thR += wJ * -0.5 * tuck;
      knR += wJ * -0.9 * tuck;
      ftL += wJ * -0.3 * tuck;
      aLx += wJ * (-0.95 * tuck - 0.15);
      aRx += wJ * (-0.95 * tuck - 0.15);
      aLz += wJ * 0.3; aRz += wJ * -0.3;
      eLx += wJ * 0.35; eRx += wJ * 0.35;
      tX += wJ * -0.3 * tuck;
      hdX += wJ * 0.22 * tuck;
      pBx += wJ * -1.25 * tuck;
      pFx += wJ * -0.5 * tuck;
      browT += wJ * 1;
      eyeT += wJ * 0.12;
    }

    // ---- SLIDE (torso back and low, one arm trailing) -----------------------
    if (wS > 0.003) {
      hipDy += wS * -0.30;
      tX += wS * 1.05;
      hdX += wS * -0.92;
      thL += wS * 1.3; knL += wS * -0.12; ftL += wS * -0.5;
      thR += wS * 1.05; knR += wS * -0.3; ftR += wS * -0.5;
      aLx += wS * 0.65;
      aRx += wS * -1.5; aRz += wS * -0.4;
      eRx += wS * 0.25;
      pBx += wS * (-0.9 + 0.18 * Math.sin(t * 13));
      pFx += wS * (-0.6 + 0.12 * Math.sin(t * 11 + 1));
    }

    // ---- FALL (comedic forward tumble, loose limbs, wide eyes) --------------
    if (wF > 0.003) {
      S.tumbleV *= Math.exp(-1.6 * dt);
      S.tumbleA = Math.min(S.tumbleA + S.tumbleV * dt, TAU * 1.15);
      const fl = Math.sin(t * 15);
      thL += wF * 0.9 * fl; knL += wF * -0.5;
      thR += wF * -0.9 * fl; knR += wF * -0.5;
      aLx += wF * 2.0 * Math.sin(t * 13);
      aRx += wF * 2.0 * Math.sin(t * 13 + 2.1);
      aLz += wF * 0.5; aRz += wF * -0.5;
      eLx += wF * 0.5; eRx += wF * 0.5;
      hdX += wF * -0.25;
      pBx += wF * (-1.1 + 0.3 * fl);
      pFx += wF * (-0.8 - 0.3 * fl);
      browT += wF * 0.7;
      eyeT += wF * 0.33;
    }
    group.rotation.x = -S.tumbleA * wF;
    // Ground decal: fades out as he leaves the ground and is dropped entirely
    // once the tumble starts rotating the group it is parented to.
    contact.visible = wF < 0.5;
    MT.contact.opacity = 0.34 * (1 - clamp(airT * 1.5, 0, 0.8)) * (1 - wS * 0.35);

    // ---- IDLE / MENU (breathing, look-around, friendly wave) ----------------
    if (wI > 0.003) {
      breathe = Math.sin(t * 2.3);
      aLx += wI * (0.04 + 0.05 * breathe);
      aRx += wI * (0.04 + 0.05 * breathe);
      aLz += wI * 0.1; aRz += wI * -0.1;
      eLx += wI * 0.18; eRx += wI * 0.18;
      hipDy += wI * 0.006 * breathe;
      hdX += wI * 0.03 * Math.sin(t * 2.3 - 0.8);

      S.lookNext -= dt;
      if (S.lookNext <= 0) {
        S.lookNext = 2.5 + Math.random() * 3.5;
        S.lookTargetY = (Math.random() - 0.5) * 1.1;
      }
      S.lookY = damp(S.lookY, S.lookTargetY, 3.5, dt);

      // Wave at the camera (behind, +Z) roughly every 8 seconds.
      if (S.waveT < 0) {
        S.waveNext -= dt;
        if (S.waveNext <= 0) { S.waveT = 0; S.waveNext = 7 + Math.random() * 2.5; }
      } else {
        S.waveT += dt;
        if (S.waveT > 1.8) S.waveT = -1;
      }
      let k = 0;
      if (S.waveT >= 0) k = smoothstep(0, 0.3, S.waveT) * (1 - smoothstep(1.45, 1.8, S.waveT));
      hdY += wI * (S.lookY * (1 - k) + 0.75 * k);
      hdZ += wI * 0.07 * k;
      tY += wI * 0.5 * k;
      // Raise up-forward, angle outward, and fold the elbow toward the head
      // (a positive bend after the 166-degree arm flip reads as a backwards,
      // hyperextended elbow).
      aRx += wI * k * -2.55;
      aRz += wI * k * -0.45;
      eRx += wI * k * -0.5;
      eRz += wI * k * Math.sin(t * 11) * 0.55;
      browT += wI * k;
    }

    // ---- Unku skirt rides the thighs ---------------------------------------
    // The flaps hinge at the waist under the torso pivot, so they inherit tX;
    // subtracting it makes the lift track the WORLD-space leg swing (gravity
    // keeps cloth vertical when the torso leans). Front flap lifts with the
    // forward thigh, back flap kicks with the rear one. Scalars only.
    const thMax = thL > thR ? thL : thR;
    const thMin = thL < thR ? thL : thR;
    skirtF.rotation.x = clamp((thMax > 0 ? thMax : 0) * 0.92 + 0.10 - tX, -0.25, 1.9);
    skirtB.rotation.x = clamp((thMin < 0 ? thMin : 0) * 0.92 - 0.08 - tX, -1.9, 0.25);

    // ---- Apply skeleton (bone rotations; the SkinnedMesh follows) -----------
    legL.rotation.x = thL; kneeL.rotation.x = knL; footL.rotation.x = ftL;
    legR.rotation.x = thR; kneeR.rotation.x = knR; footR.rotation.x = ftR;
    armL.rotation.x = aLx; armL.rotation.z = aLz;
    armR.rotation.x = aRx; armR.rotation.z = aRz;
    elbowL.rotation.x = eLx; elbowL.rotation.z = eLz;
    elbowR.rotation.x = eRx; elbowR.rotation.z = eRz;
    torso.rotation.x = tX; torso.rotation.y = tY;
    hips.position.y = HIP_Y + hipDy;
    head.rotation.x = hdX; head.rotation.y = hdY; head.rotation.z = hdZ;
    head.position.y = 0.13 + hdDy;
    ponchoF.rotation.x = pFx;
    ponchoB.rotation.x = pBx;
    chest.scale.x = chest.scale.z = 1 + 0.03 * breathe * wI;
    chest.scale.y = 1 + 0.012 * breathe * wI;

    // Lane-change bank.
    S.bank = damp(S.bank, -(state.leanX || 0) * 0.3, 10, dt);
    group.rotation.z = S.bank;

    // Land squash (0.1 s).
    S.squash *= Math.exp(-11 * dt);
    group.scale.y = 1 - 0.2 * S.squash;
    group.scale.x = group.scale.z = 1 + 0.1 * S.squash;

    // ---- Face life ----------------------------------------------------------
    // Blink every 2 to 5 seconds, quick 0.12 s close-open.
    if (S.blinkT < 0) {
      S.blinkNext -= dt;
      if (S.blinkNext <= 0) { S.blinkT = 0; S.blinkNext = 2 + Math.random() * 3; }
    } else {
      S.blinkT += dt;
      if (S.blinkT > 0.12) S.blinkT = -1;
    }
    let close = S.blinkT >= 0 ? Math.sin((S.blinkT / 0.12) * Math.PI) : 0;
    if (wF > 0.4) close = 0; // eyes locked wide open during a fall
    const lidRot = lerp(LID_OPEN, LID_SHUT, close);
    lids[0].rotation.x = lidRot;
    lids[1].rotation.x = lidRot;

    S.eyeScale = damp(S.eyeScale, eyeT, 14, dt);
    eyes[0].scale.setScalar(S.eyeScale);
    eyes[1].scale.setScalar(S.eyeScale);
    S.browLift = damp(S.browLift, clamp(browT, 0, 1) * 0.032, 16, dt);
    brows.position.y = 0.112 + S.browLift;

    // ---- Pompom spring lag (critically damped) ------------------------------
    const tgtX = S.bank * 0.35 + hdY * 0.06;
    const tgtZ = tX * 0.3 + hdX * 0.08;
    const k = 90, c = 2 * Math.sqrt(k);
    S.pomVX += (-k * (S.pomX - tgtX) - c * S.pomVX) * dt;
    S.pomVZ += (-k * (S.pomZ - tgtZ) - c * S.pomVZ) * dt;
    S.pomX += S.pomVX * dt;
    S.pomZ += S.pomVZ * dt;
    pompom.position.x = clamp(S.pomX - tgtX, -0.08, 0.08);
    pompom.position.z = clamp(S.pomZ - tgtZ, -0.08, 0.08);
    pompom.rotation.x = pompom.position.z * -3;
    pompom.rotation.z = pompom.position.x * 3;
  }

  function dispose() {
    for (const g of geos) g.dispose();
    intiLight.dispose();
    skeleton.dispose();
  }

  // ---- Rayo de Inti: the sun god lights Guineo from within ----------------
  // Every body material ramps a warm gold emissive with the boost. The eye
  // materials stay out of it so the face keeps its own highlights instead of
  // blowing out into a featureless glowing blob. Emissive is a uniform, so
  // this never triggers a shader recompile.
  // Each material glows in its OWN color pushed toward gold, never in flat
  // gold: a uniform emissive turns Guineo into a featureless gold statue and
  // throws away the red chullo, the poncho and the woven trim that make him
  // readable. This way he radiates while still looking like himself.
  const GLOW = new THREE.Color(0xffb03c);
  const glowMats = [
    MT.skin, MT.skinBody, MT.hair, MT.lid, MT.cheek, MT.tunic, MT.tunicCloth,
    MT.shorts, MT.poncho, MT.ponchoTrim, MT.trim, MT.chullo, MT.band,
    MT.pomRed, MT.pomYellow, MT.sandal, MT.conch,
  ];
  for (const m of glowMats) {
    m.emissive.copy(m.color).lerp(GLOW, 0.35);
    m.emissiveIntensity = 0;
  }
  let glowT = 0;

  // Emissive alone only reads as an overexposed character. The blessing sells
  // itself when he becomes a real light source and throws gold onto the road
  // and the props beside him. Built once at intensity 0 and never added or
  // removed, so animating it never triggers a shader recompile. No shadows:
  // this is a fill light, and a second shadow map is not worth the cost.
  // Height is tightly constrained: below ~1.7 it sits inside his own hat and
  // leaves black patches on the surfaces facing away from it, above ~2.6 it
  // ends up inside gateway lintels and tunnel ceilings and speckles those
  // instead. 2.2 clears his head and stays under anything he can run through.
  const intiLight = new THREE.PointLight(0xffb14a, 0, 22, 2);
  intiLight.position.set(0, 2.2, 0.2);
  intiLight.castShadow = false;
  group.add(intiLight);

  function setIntiGlow(t01) {
    const t = t01 < 0 ? 0 : t01 > 1 ? 1 : t01;
    if (t === glowT) return;
    glowT = t;
    // Enough to push the bright cloth over the bloom threshold so he throws
    // light, low enough that albedo still reads.
    const e = t * 0.42;
    for (let i = 0; i < glowMats.length; i++) glowMats[i].emissiveIntensity = e;
    // Kept deliberately low. Push this much past ~10 and the surfaces nearest
    // the light overdrive the bloom pass and break up into black speckles, the
    // same artifact the hot emissive coins already show.
    intiLight.intensity = t * 6;
  }

  // The encomienda. A chasqui exists to deliver it, so it is the one thing
  // worth stealing, and the one thing he can visibly lose.
  function setQipiVisible(v) { qipi.visible = !!v; }

  return { group, update, setMode, onFootstep, setIntiGlow, setQipiVisible, dispose };
}
