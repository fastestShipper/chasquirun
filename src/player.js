// Player physics + collision. Character visuals live in character.js;
// this moves the group and exposes state for main to drive animations.

import * as THREE from 'three';
import { CONFIG } from './config.js';
import { damp } from './util.js';

const _box = new THREE.Box3();
const _obBox = new THREE.Box3();

export class Player {
  constructor(chasqui) {
    this.chasqui = chasqui;
    // Event hooks assigned by main.
    this.onJump = null;
    this.onLand = null;
    this.onSlide = null;
    this.onCrash = null; // (obstacle) - main decides shield vs death
    this.onFall = null;  // fell into a gap
    this.reset();
  }

  reset() {
    this.laneIdx = 1;
    this.x = 0;
    this.y = 0;
    this.vy = 0;
    this.grounded = true;
    this.sliding = false;
    this.slideT = 0;
    this.coyoteT = 0;
    this.buffered = null;
    this.bufferT = 0;
    this.airT = 0;
    this.dead = false;
    this.deathCause = null;
    this.invulnT = 0;
    this.leanX = 0;
    this._crashCooldown = 0;
    this._edgeFall = false;
    // Only position is ours; the character owns its group rotation channels.
    this.chasqui.group.position.set(0, 0, 0);
  }

  get invulnerable() { return this.invulnT > 0; }

  left() {
    if (this.dead) return;
    if (this.laneIdx > 0) this.laneIdx--;
  }

  right() {
    if (this.dead) return;
    if (this.laneIdx < CONFIG.lanes.length - 1) this.laneIdx++;
  }

  jump() {
    if (this.dead) return;
    if (this.grounded || (this.coyoteT < CONFIG.coyoteTime && this.vy <= 0 && !this.grounded)) {
      this._doJump();
    } else {
      this.buffered = 'jump';
      this.bufferT = CONFIG.inputBuffer;
    }
  }

  slide() {
    if (this.dead) return;
    if (this.grounded) {
      this._doSlide();
    } else {
      // Fast-fall, then slide on landing.
      this.vy = Math.min(this.vy, -15);
      this.buffered = 'slide';
      this.bufferT = CONFIG.inputBuffer + 0.25;
    }
  }

  _doJump() {
    this.vy = CONFIG.jumpVel;
    this.grounded = false;
    this.sliding = false;
    this.coyoteT = CONFIG.coyoteTime + 1;
    this.airT = 0;
    this._edgeFall = false; // a real jump earns a landing
    if (this.onJump) this.onJump();
  }

  _doSlide() {
    this.sliding = true;
    this.slideT = CONFIG.slideTime;
    if (this.onSlide) this.onSlide();
  }

  update(dt, track, frameTravel = 0) {
    // Lane movement.
    const targetX = CONFIG.lanes[this.laneIdx];
    this._prevX = this.x;
    this.x = damp(this.x, targetX, 15, dt);
    this.leanX = (targetX - this.x) * 0.55;

    // Swept ground sample: at high speed a short gap can cross z=0 entirely
    // between two frames; probe the swept interval too.
    let solid;
    if (this.dead && this.deathCause === 'fall') solid = false;
    else {
      solid = track.isGroundSolid(this.x, 0);
      if (solid && frameTravel > 1.2) {
        solid = track.isGroundSolid(this.x, frameTravel * 0.33) &&
                track.isGroundSolid(this.x, frameTravel * 0.66);
      }
    }

    if (this.grounded && !solid) {
      // Ran off an edge. Arcade law: without a jump you are falling, and no
      // far rim will catch you (at high speed the parabola barely dips, so a
      // depth check alone cannot tell a gap crossing from a landing).
      this.grounded = false;
      this.coyoteT = 0;
      this.vy = 0;
      this._edgeFall = true;
    }

    if (!this.grounded) {
      this.coyoteT += dt;
      this.airT += dt;
      this.vy += CONFIG.gravity * dt;
      const yPrev = this.y;
      this.y += this.vy * dt;

      // Ground-crossing detection (a single fast frame can step straight
      // through any fixed band); an edge-fall can never land, and a deep
      // faller (yPrev already below the rim) cannot be caught by a far rim.
      if (this.y <= 0 && yPrev > -0.5 && this.vy <= 0 && solid && !this._edgeFall) {
        this.y = 0;
        this.vy = 0;
        this.grounded = true;
        this.airT = 0;
        if (this.onLand) this.onLand();
        if (this.buffered && this.bufferT > 0) {
          const b = this.buffered;
          this.buffered = null;
          if (b === 'jump') this._doJump();
          else this._doSlide();
        }
      }

      if (this.y < -2.2 && !this.dead) {
        this.dead = true;
        this.deathCause = 'fall';
        if (this.onFall) this.onFall();
      }
      // Keep falling visually after any death, but never unbounded.
      if (this.dead && this.y < -60) {
        this.y = -60;
        this.vy = 0;
      }
    }

    if (this.bufferT > 0) {
      this.bufferT -= dt;
      if (this.bufferT <= 0) this.buffered = null;
    }

    if (this.sliding) {
      this.slideT -= dt;
      if (this.slideT <= 0) this.sliding = false;
    }

    if (this.invulnT > 0) this.invulnT -= dt;
    if (this._crashCooldown > 0) this._crashCooldown -= dt;

    // Position the character.
    this.chasqui.group.position.set(this.x, this.y, 0);
  }

  // World-space AABB.
  getBox() {
    const hb = CONFIG.hitbox;
    const hy = this.sliding ? hb.ySlide : hb.yStand;
    _box.min.set(this.x - hb.x, this.y + 0.04, -hb.z);
    _box.max.set(this.x + hb.x, this.y + 0.04 + hy * 2, hb.z);
    return _box;
  }

  // Test against track colliders; emits onCrash at most once per cooldown.
  // Two tests per obstacle: the current state, and the pre-frame state
  // (obstacle back by frameTravel, player at the pre-frame x). Together they
  // cover tunneling without falsely killing a lane change that cut behind an
  // obstacle the player already passed.
  checkCollisions(track, frameTravel = 0) {
    if (this.dead || this.invulnT > 0 || this._crashCooldown > 0) return;
    const box = this.getBox();
    const cols = track.getColliders();
    const dxPrev = (this._prevX === undefined ? this.x : this._prevX) - this.x;
    for (let i = 0; i < cols.length; i++) {
      const c = cols[i];
      _obBox.min.set(c.minX, c.minY, c.minZ);
      _obBox.max.set(c.maxX, c.maxY, c.maxZ);
      let hit = box.intersectsBox(_obBox);
      if (!hit && frameTravel > 0.01) {
        _obBox.min.set(c.minX - dxPrev, c.minY, c.minZ - frameTravel);
        _obBox.max.set(c.maxX - dxPrev, c.maxY, c.maxZ - frameTravel);
        hit = box.intersectsBox(_obBox);
      }
      if (hit) {
        // Short cooldown: just enough to not double-fire on one obstacle.
        // 0.4s was 17 m of ghost mode at top speed and read as "no collision".
        this._crashCooldown = 0.15;
        if (this.onCrash) this.onCrash(c.ob);
        return;
      }
    }
  }

  die(cause) {
    if (this.dead) return;
    this.dead = true;
    this.deathCause = cause;
    if (cause === 'hit') {
      this.vy = 4.2;
      this.grounded = false;
    }
  }
}
