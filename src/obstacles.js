// Obstacle builders + collision metadata. Instances are pooled by track.js.
// Collider boxes are LOCAL to the obstacle group (origin at base center);
// track.js translates them to world space. Boxes are slightly smaller than
// the visuals for forgiving collisions.

import * as THREE from 'three';
import { Mats, Tex, applyCurvature } from './materials.js';
import { buildLlama } from './animals.js';
import { buildBrazier, buildBoulder } from './scenery.js';

// Obstacle rocks are lighter than scenery rocks so they read at dusk.
let _obRockMat = null;
function obRockMat() {
  if (!_obRockMat) {
    _obRockMat = Mats.stoneDark().clone();
    _obRockMat.color.set(0xd6cec1);
    applyCurvature(_obRockMat); // clone() drops onBeforeCompile
  }
  return _obRockMat;
}

function box3(x0, y0, z0, x1, y1, z1) {
  return new THREE.Box3(new THREE.Vector3(x0, y0, z0), new THREE.Vector3(x1, y1, z1));
}

// action: what clears it. 'jump' | 'slide' | 'dodge'
export const KIND_INFO = {
  lowWall: { action: 'jump' },
  lowWallWood: { action: 'jump' },
  highWall: { action: 'dodge' },
  lintel: { action: 'slide' },
  lintelWood: { action: 'slide' },
  boulder: { action: 'jump' },
  llama: { action: 'jump' },
  brazier: { action: 'jump' },
  roller: { action: 'dodge', moving: true },
};

const ROLLER_SPEED = 7.5; // m/s toward the player, on top of world speed

export function createObstacle(kind) {
  const group = new THREE.Group();
  const ob = { kind, group, boxes: [], update: null, action: KIND_INFO[kind].action };

  switch (kind) {
    case 'lowWall': {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(2.0, 1.0, 0.6), Mats.ashlar());
      wall.position.y = 0.5;
      wall.castShadow = true;
      const cap = new THREE.Mesh(new THREE.BoxGeometry(2.15, 0.14, 0.75), Mats.stoneDark());
      cap.position.y = 1.05;
      cap.castShadow = true;
      group.add(wall, cap);
      ob.boxes.push(box3(-0.9, 0.02, -0.28, 0.9, 1.02, 0.28));
      break;
    }
    case 'lowWallWood': {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.16, 0.16), Mats.wood());
      rail.position.y = 0.85;
      rail.castShadow = true;
      const rail2 = rail.clone();
      rail2.position.y = 0.45;
      const p1 = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.95, 0.14), Mats.wood());
      p1.position.set(-0.85, 0.475, 0);
      const p2 = p1.clone();
      p2.position.x = 0.85;
      group.add(rail, rail2, p1, p2);
      ob.boxes.push(box3(-0.9, 0.1, -0.14, 0.9, 0.95, 0.14));
      break;
    }
    case 'highWall': {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(2.05, 2.7, 0.7), Mats.stone());
      wall.position.y = 1.35;
      wall.castShadow = true;
      const cap = new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.35, 0.95), Mats.thatch());
      cap.position.y = 2.85;
      cap.castShadow = true;
      group.add(wall, cap);
      ob.boxes.push(box3(-0.92, 0.02, -0.32, 0.92, 3.0, 0.32));
      break;
    }
    case 'lintel':
    case 'lintelWood': {
      const wood = kind === 'lintelWood';
      if (wood) {
        // Bridge version stays timber.
        const beam = new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.5, 0.5), Mats.wood());
        beam.position.y = 1.5;
        beam.castShadow = true;
        const postGeo = new THREE.CylinderGeometry(0.09, 0.12, 1.85, 6);
        const p1 = new THREE.Mesh(postGeo, Mats.wood());
        p1.position.set(-1.05, 0.925, 0);
        const p2 = p1.clone();
        p2.position.x = 1.05;
        group.add(beam, p1, p2);
      } else {
        // Trapezoidal Inca doorframe fragment: battered jamb blocks leaning
        // inward under a massive overhanging lintel with a stepped cap.
        for (const side of [-1, 1]) {
          const jamb = new THREE.Mesh(new THREE.BoxGeometry(0.34, 1.85, 0.5), Mats.stone());
          jamb.position.set(side * 1.06, 0.925, 0);
          jamb.rotation.z = side * -0.07;
          jamb.castShadow = true;
          group.add(jamb);
        }
        const beam = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.5, 0.62), Mats.stoneDark());
        beam.position.y = 1.5;
        beam.castShadow = true;
        const cap = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.22, 0.5), Mats.stone());
        cap.position.y = 1.86;
        group.add(beam, cap);
      }
      ob.boxes.push(box3(-1.0, 1.24, -0.24, 1.0, 1.78, 0.24));
      ob.boxes.push(box3(-1.26, 0, -0.14, -0.88, 1.8, 0.14));
      ob.boxes.push(box3(0.88, 0, -0.14, 1.26, 1.8, 0.14));
      break;
    }
    case 'boulder': {
      const rock = buildBoulder(1.0);
      rock.material = obRockMat();
      rock.scale.setScalar(1.35);
      group.add(rock);
      ob.boxes.push(box3(-0.58, 0.02, -0.58, 0.58, 1.22, 0.58));
      break;
    }
    case 'llama': {
      const llama = buildLlama({ sitting: true });
      llama.group.rotation.y = Math.PI * (Math.random() < 0.5 ? 0.06 : -0.06);
      group.add(llama.group);
      ob.update = (dt) => llama.update(dt);
      ob.boxes.push(box3(-0.5, 0.02, -0.68, 0.5, 1.18, 0.68));
      break;
    }
    case 'brazier': {
      const b = buildBrazier();
      group.add(b);
      let flame = null;
      b.traverse((c) => { if (c.isSprite && c.userData.flicker) flame = c; });
      if (flame) {
        const baseX = flame.scale.x;
        const baseY = flame.scale.y;
        let ft = Math.random() * 10;
        ob.update = (dt) => {
          ft += dt;
          flame.scale.x = baseX * (1 + Math.sin(ft * 13.1) * 0.08);
          flame.scale.y = baseY * (1 + Math.sin(ft * 9.7) * 0.14 + Math.sin(ft * 23.3) * 0.06);
          flame.material.opacity = 0.8 + Math.sin(ft * 17.3) * 0.12;
        };
      }
      ob.boxes.push(box3(-0.44, 0.02, -0.44, 0.44, 1.5, 0.44));
      break;
    }
    case 'roller': {
      const rock = buildBoulder(1.0);
      rock.material = obRockMat();
      rock.scale.setScalar(1.6);
      rock.position.y = 0.15;
      group.add(rock);
      ob.roller = rock;
      ob.rollPhase = 0;
      ob.travel = 0; // reset by track on spawn; bounds the rolling distance
      ob.update = (dt) => {
        if (ob.travel > 40) return; // runaway safety only; track gates timing
        group.position.z += ROLLER_SPEED * dt;
        ob.travel += ROLLER_SPEED * dt;
        ob.rollPhase += (ROLLER_SPEED * dt) / 0.8;
        rock.rotation.x = ob.rollPhase;
      };
      ob.boxes.push(box3(-0.66, 0.02, -0.66, 0.66, 1.5, 0.66));
      break;
    }
    default:
      throw new Error('Unknown obstacle kind: ' + kind);
  }

  group.visible = false;
  return ob;
}
