// Chasqui Run, ASSETS module.
// Real photogrammetry props: CC0 glTF models from Poly Haven (1k textures),
// bundled under assets/models/ (see LICENSE.txt there). Loaded ONCE during
// boot into a template registry; callers clone templates cheaply (clones
// share geometry and materials). Every load is optional: a missing or broken
// file simply leaves its registry slot empty, getModel/cloneModel return
// null, and scenery.js falls back to its procedural builders.
//
// Template contract (mirrors the procedural props):
// - Origin at base center, +Y up, base at y = 0 (rocks sink slightly below
//   grade like boulderGeometry does, so they seat into undulating terrain).
// - Canonical size baked into the SHARED geometry at load time, so
//   cloneModel(name, s) means the same thing as the procedural builders'
//   scale parameter (rocks: ~1.24 m footprint at s = 1, matching
//   boulderGeometry(rnd, 1); trees/shrubs: canonical height in meters).
// - Single-mesh templates are bare THREE.Mesh instances, so callers may
//   override .material exactly like they do on procedural boulders.
// - Materials are patched with the shared world curvature, castShadow goes
//   on meshes taller than 1.5 m, receiveShadow on flatish ones.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { applyCurvature } from './materials.js';

// Each file yields one or more named templates. `node` extracts a single
// named child (shrub_02 ships four bush variants in one scene). Exactly one
// of `footprint` (max horizontal extent, meters) or `height` (meters) sets
// the canonical size. `sink` buries the base by that fraction of the height.
const FILES = [
  {
    url: 'assets/models/moon_rock_02/moon_rock_02_1k.gltf',
    templates: { rock_a: { footprint: 1.24, sink: 0.06 } },
  },
  {
    url: 'assets/models/moon_rock_06/moon_rock_06_1k.gltf',
    templates: { rock_b: { footprint: 1.24, sink: 0.06 } },
  },
  {
    url: 'assets/models/rock_07/rock_07_1k.gltf',
    templates: { rock_c: { footprint: 1.24, sink: 0.06 } },
  },
  {
    url: 'assets/models/dead_quiver_trunk/dead_quiver_trunk_1k.gltf',
    templates: { tree_dead: { height: 2.9, sink: 0.02 } },
  },
  {
    url: 'assets/models/shrub_02/shrub_02_1k.gltf',
    templates: {
      shrub_a: { height: 2.05, sink: 0.03, node: 'shrub_02_a' },
      shrub_b: { height: 2.05, sink: 0.03, node: 'shrub_02_b' },
      shrub_c: { height: 2.05, sink: 0.03, node: 'shrub_02_c' },
      shrub_d: { height: 2.05, sink: 0.03, node: 'shrub_02_d' },
    },
  },
];

const registry = new Map(); // name -> template (bare Mesh)
let loadPromise = null;

// Bake the source mesh's world transform, the canonical size and the
// base-center origin into its geometry (done ONCE; every clone shares it),
// then wrap it in a bare Mesh so callers can treat it like a procedural one.
function meshTemplate(src, spec) {
  const geo = src.geometry;
  geo.applyMatrix4(src.matrixWorld);
  geo.computeBoundingBox();
  let bb = geo.boundingBox;
  let k = 1;
  if (spec.footprint) {
    k = spec.footprint / Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z, 1e-6);
  } else if (spec.height) {
    k = spec.height / Math.max(bb.max.y - bb.min.y, 1e-6);
  }
  if (k !== 1) geo.scale(k, k, k);
  geo.computeBoundingBox();
  bb = geo.boundingBox;
  const sink = (spec.sink || 0) * (bb.max.y - bb.min.y);
  geo.translate(
    -(bb.min.x + bb.max.x) / 2,
    -bb.min.y - sink,
    -(bb.min.z + bb.max.z) / 2
  );
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return new THREE.Mesh(geo, src.material);
}

// Curvature, texture sampling and shadow flags, judged at canonical size.
function patchTemplate(t) {
  t.traverse((o) => {
    if (!o.isMesh) return;
    const m = o.material;
    if (m && m.isMeshStandardMaterial) {
      applyCurvature(m);
      for (const key of ['map', 'normalMap', 'aoMap', 'roughnessMap', 'metalnessMap']) {
        if (m[key]) m[key].anisotropy = 4;
      }
    }
    o.geometry.computeBoundingBox();
    const bb = o.geometry.boundingBox;
    const h = bb.max.y - bb.min.y;
    const w = Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z);
    if (h > 1.5) o.castShadow = true;
    if (h <= 0.75 * w) o.receiveShadow = true;
  });
  return t;
}

function registerFrom(scene, templates) {
  scene.updateMatrixWorld(true);
  for (const [name, spec] of Object.entries(templates)) {
    const root = spec.node ? scene.getObjectByName(spec.node) : scene;
    if (!root) continue;
    const meshes = [];
    root.traverse((o) => { if (o.isMesh) meshes.push(o); });
    // One mesh per template keeps clones one draw call and lets callers
    // override .material; anything else falls back to procedural props.
    if (meshes.length !== 1) continue;
    registry.set(name, patchTemplate(meshTemplate(meshes[0], spec)));
  }
}

// Called by main during boot, AFTER loadPhotoTextures. Idempotent. Never
// rejects: each file that is missing or corrupt just stays procedural.
export function loadModels() {
  if (loadPromise) return loadPromise;
  const loader = new GLTFLoader();
  const one = (file) =>
    new Promise((resolve) => {
      try {
        loader.load(
          file.url,
          (gltf) => {
            try {
              registerFrom(gltf.scene, file.templates);
            } catch (e) {
              // Corrupt asset: keep the procedural fallback.
            }
            resolve(null);
          },
          undefined,
          () => resolve(null)
        );
      } catch (e) {
        resolve(null);
      }
    });
  loadPromise = Promise.all(FILES.map(one));
  return loadPromise;
}

// Template Object3D (shared, do NOT mutate or add to the scene) or null.
export function getModel(name) {
  return registry.get(name) || null;
}

// Cheap clone sharing the template's geometry and materials, uniformly
// scaled. Null when the model is unavailable (callers must fall back).
export function cloneModel(name, scale = 1) {
  const t = registry.get(name);
  if (!t) return null;
  const c = t.clone(true);
  if (scale !== 1) c.scale.setScalar(scale);
  return c;
}

export function disposeModels() {
  const mats = new Set();
  for (const t of registry.values()) {
    t.traverse((o) => {
      if (!o.isMesh) return;
      o.geometry.dispose();
      if (o.material) mats.add(o.material);
    });
  }
  for (const m of mats) {
    for (const key of ['map', 'normalMap', 'aoMap', 'roughnessMap', 'metalnessMap']) {
      if (m[key]) m[key].dispose();
    }
    m.dispose();
  }
  registry.clear();
  loadPromise = null;
}
