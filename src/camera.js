// Camera rig: menu orbit, run follow with spring lag, FOV speed kick, shake.

import * as THREE from 'three';
import { CONFIG } from './config.js';
import { damp, clamp } from './util.js';

const _pos = new THREE.Vector3();
const _look = new THREE.Vector3();

export class CameraRig {
  constructor(camera) {
    this.camera = camera;
    this.mode = 'menu'; // 'menu' | 'run' | 'dead'
    this.trauma = 0;
    this.t = 0;
    this._fov = CONFIG.fov.base;
    this._shakeSeed = Math.random() * 100;
    camera.position.set(3.5, 2.1, 5.6);
    camera.lookAt(0, 1.2, 0);
    this._lookCur = new THREE.Vector3(0, 1.2, 0);
  }

  setMode(mode) {
    this.mode = mode;
  }

  shake(amount) {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  update(dt, player, speed01) {
    this.t += dt;
    const cam = this.camera;

    if (this.mode === 'menu') {
      const a = this.t * 0.1;
      _pos.set(
        Math.sin(a) * 3.4,
        1.75 + Math.sin(this.t * 0.23) * 0.22,
        4.3 + Math.cos(a * 0.7) * 0.7
      );
      // Look target biased +x so the chasqui frames in the left third,
      // clear of the centered title UI.
      _look.set(1.55, 1.05, -2.2);
      var lambda = 1.6;
      var targetFov = 50;
    } else if (this.mode === 'run') {
      const px = player ? player.x : 0;
      const py = player ? player.y : 0;
      _pos.set(px * 0.55, 2.86 + py * 0.28, 6.0);
      _look.set(px * 0.8, 1.28 + py * 0.45, -9);
      lambda = 7.5;
      targetFov = CONFIG.fov.base + (CONFIG.fov.max - CONFIG.fov.base) * speed01;
    } else {
      // dead: pull up and back, keep watching the fallen runner
      const px = player ? player.x : 0;
      const py = player ? Math.max(player.y, -3) : 0;
      _pos.set(px * 0.4, 4.6, 8.6);
      _look.set(px, 0.6 + py * 0.5, -2);
      lambda = 2.4;
      targetFov = 54;
    }

    cam.position.x = damp(cam.position.x, _pos.x, lambda, dt);
    cam.position.y = damp(cam.position.y, _pos.y, lambda, dt);
    cam.position.z = damp(cam.position.z, _pos.z, lambda, dt);
    this._lookCur.x = damp(this._lookCur.x, _look.x, lambda + 2, dt);
    this._lookCur.y = damp(this._lookCur.y, _look.y, lambda + 2, dt);
    this._lookCur.z = damp(this._lookCur.z, _look.z, lambda + 2, dt);

    // Shake: decaying trauma, smooth pseudo-noise offsets.
    if (this.trauma > 0.001) {
      const s = this.trauma * this.trauma;
      const ts = this.t * 31 + this._shakeSeed;
      cam.position.x += Math.sin(ts * 1.13) * 0.14 * s;
      cam.position.y += Math.sin(ts * 1.71 + 2) * 0.11 * s;
      this._lookCur.x += Math.sin(ts * 1.41 + 4) * 0.2 * s;
      this.trauma = Math.max(0, this.trauma - dt * 1.8);
    }

    cam.lookAt(this._lookCur);

    this._fov = damp(this._fov, targetFov, 3.5, dt);
    if (Math.abs(cam.fov - this._fov) > 0.01) {
      cam.fov = this._fov;
      cam.updateProjectionMatrix();
    }
  }
}
