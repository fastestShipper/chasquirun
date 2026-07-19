// Rayo de Inti: the sun god's power striking the runner.
//
// The boost used to be signalled by a small emissive lift on the character and
// a puff of particles, which read as nothing at all. The power is the game's
// signature move, so it gets an actual event: a bolt of light comes DOWN out
// of the sky and hits him, the ground kicks a shockwave ring, and he keeps a
// visible corona for as long as the blessing lasts.
//
// API: new IntiStrike(scene) -> { strike(), setGlow(t01), update(dt, x, y), dispose() }
// All meshes are additive and depth-write off, so nothing here can punch holes
// in the world or fight the transparent sort.
//
// Everything is built once and reused. strike() only resets timers.

import * as THREE from 'three';

// Additive gold. Kept a touch under pure white so the bloom pass has somewhere
// to go: pushing the source to 1,1,1 is what blows highlights into the black
// speckling the coins already suffer from.
const GOLD = new THREE.Color(0xffc247);
const GOLD_HOT = new THREE.Color(0xfff0c0);

// A glow VOLUME. Alpha follows how directly the surface faces the camera, so
// a sphere renders as a soft round ball of light that fades to nothing at its
// own silhouette. No texture, no billboard, and therefore no square edges and
// no popping when the camera turns.
function glowMat(color, power) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uOpacity: { value: 0 },
      uPower: { value: power },
    },
    vertexShader: `
      varying vec3 vN;
      varying vec3 vV;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal);
        vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uOpacity;
      uniform float uPower;
      varying vec3 vN;
      varying vec3 vV;
      void main() {
        // 1 through the centre of the ball, 0 at the rim.
        float f = pow(max(dot(normalize(vN), normalize(vV)), 0.0), uPower);
        gl_FragColor = vec4(uColor * f, f * uOpacity);
      }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.FrontSide,
    fog: false,
    toneMapped: false,
  });
}

// Expanding shockwave. Driven per-pixel rather than by geometry, because a
// ring made of flat geometry can only ever look like a drawn circle.
//
// uProg 0..1 is the life of the wave. Radius, thickness, brightness and
// erosion are all functions of it, so one uniform animates the whole thing.
function shockMat(color) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uProg: { value: 0 },
      uOpacity: { value: 0 },
      uSeed: { value: Math.random() * 10 },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uProg;
      uniform float uOpacity;
      uniform float uSeed;
      varying vec2 vUv;

      float h(vec2 p) {
        p = fract(p * vec2(233.34, 851.73));
        p += dot(p, p + 23.45);
        return fract(p.x * p.y);
      }
      float n(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(h(i), h(i + vec2(1, 0)), f.x),
                   mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), f.x), f.y);
      }
      float fbm(vec2 p) {
        float s = 0.0, a = 0.5;
        for (int i = 0; i < 3; i++) { s += a * n(p); p *= 2.13; a *= 0.5; }
        return s;
      }

      void main() {
        // Polar coordinates from the quad centre.
        vec2 d = vUv - 0.5;
        float r = length(d) * 2.0;
        if (r > 1.0) discard;
        float ang = atan(d.y, d.x);

        // The wave front travels outward as uProg climbs, and THINS as it
        // goes, the way a real expanding front loses energy.
        float front = uProg;
        float thick = mix(0.34, 0.07, uProg);

        // Irregular thickness around the circumference so the ring is never a
        // perfect machine-drawn annulus.
        float wob = fbm(vec2(ang * 2.4 + uSeed, uProg * 1.6)) - 0.5;
        float rr = r + wob * 0.11 * (0.4 + uProg);

        // Soft falloff on BOTH sides of the front. This is the single biggest
        // difference between a shockwave and a drawn circle.
        float band = 1.0 - smoothstep(0.0, thick, abs(rr - front));
        band = pow(band, 1.7);

        // Hot leading edge: the outer side of the front runs brighter and
        // whiter, the trailing side falls away into the base colour.
        float lead = smoothstep(front - thick * 0.35, front + thick * 0.15, rr);
        vec3 col = mix(uColor, vec3(1.0, 0.96, 0.85), lead * 0.65);

        // Erosion: the wave breaks up as it dies instead of dimming evenly.
        float burn = fbm(vec2(ang * 3.7 - uSeed, r * 5.0));
        float alive = 1.0 - smoothstep(0.55, 1.0, uProg);
        float erode = smoothstep(0.0, 0.45, burn + alive - 0.55);

        float a = band * erode * uOpacity * (1.0 - smoothstep(0.85, 1.0, uProg));
        if (a <= 0.001) discard;
        gl_FragColor = vec4(col * a, a);
      }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false,
    toneMapped: false,
  });
}

function addMat(color, opacity) {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    fog: false,
    toneMapped: false,
  });
}

export class IntiStrike {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.visible = false;
    this.group.frustumCulled = false;
    scene.add(this.group);

    this._t = -1;        // strike animation clock, negative means idle
    this._glow = 0;      // sustained corona, driven by the boost curve
    this._geos = [];
    const G = (g) => { this._geos.push(g); return g; };

    // The bolt: a tall tapered column dropping out of the sky onto his head.
    // Open-ended cylinder so it never shows a cap, and wide enough at the top
    // that it reads as coming FROM somewhere rather than starting in mid-air.
    this._boltMat = addMat(GOLD_HOT, 0);
    const boltGeo = G(new THREE.CylinderGeometry(1.5, 0.34, 46, 12, 1, true));
    this._bolt = new THREE.Mesh(boltGeo, this._boltMat);
    this._bolt.position.y = 23.4;
    this.group.add(this._bolt);

    // An inner core, brighter and thinner, so the bolt has a hot centre.
    this._coreMat = addMat(GOLD_HOT, 0);
    const coreGeo = G(new THREE.CylinderGeometry(0.5, 0.12, 46, 8, 1, true));
    this._core = new THREE.Mesh(coreGeo, this._coreMat);
    this._core.position.y = 23.4;
    this.group.add(this._core);

    // Ground shockwave. A flat quad carrying the shader above, NOT ring
    // geometry: the shape lives in the fragment program, so the front can be
    // soft, irregular and eroding instead of a hard machine-drawn annulus.
    const waveGeo = G(new THREE.PlaneGeometry(1, 1));
    waveGeo.rotateX(-Math.PI / 2);
    this._ringMat = shockMat(GOLD);
    this._ring = new THREE.Mesh(waveGeo, this._ringMat);
    this._ring.position.y = 0.07;
    this._ring.frustumCulled = false;
    this.group.add(this._ring);

    // A second, slower, wider wave so the blast has weight and depth.
    this._ring2Mat = shockMat(new THREE.Color(0xffa838));
    this._ring2 = new THREE.Mesh(waveGeo, this._ring2Mat);
    this._ring2.position.y = 0.05;
    this._ring2.frustumCulled = false;
    this.group.add(this._ring2);

    // A dome front rising off the ground, so the blast reads as a volume of
    // displaced air rather than as a decal painted on the floor.
    this._domeMat = shockMat(GOLD_HOT);
    const domeGeo = G(new THREE.SphereGeometry(0.5, 24, 12, 0, Math.PI * 2, 0, Math.PI * 0.5));
    this._dome = new THREE.Mesh(domeGeo, this._domeMat);
    this._dome.position.y = 0.04;
    this._dome.frustumCulled = false;
    this.group.add(this._dome);

    // Impact flare: a real sphere, not a sprite. A SpriteMaterial with no
    // map draws its full quad, which is exactly why the old one looked like a
    // square. This is a volume with a shader falloff, so it has no edges at
    // any angle.
    this._flareMat = glowMat(GOLD_HOT, 1.7);
    const flareGeo = G(new THREE.SphereGeometry(1, 20, 14));
    this._flare = new THREE.Mesh(flareGeo, this._flareMat);
    this._flare.position.y = 0.9;
    this._flare.frustumCulled = false;
    this.group.add(this._flare);

    // Sustained corona while the power is active: a soft ellipsoid wrapped
    // around him, brightest through the middle and feathering to nothing at
    // the silhouette, so it reads as light rather than as a decal.
    this._auraMat = glowMat(GOLD, 2.4);
    const auraGeo = G(new THREE.SphereGeometry(1, 24, 16));
    this._aura = new THREE.Mesh(auraGeo, this._auraMat);
    this._aura.position.y = 0.95;
    this._aura.scale.set(1.15, 1.5, 1.15);
    this._aura.frustumCulled = false;
    this.group.add(this._aura);
  }

  // Fire the bolt. Cheap: just rewinds the clock.
  strike() {
    this._t = 0;
    this.group.visible = true;
  }

  // Sustained corona strength, 0..1. Driven by the eased boost curve so it
  // fades with the power rather than snapping off.
  setGlow(t01) {
    this._glow = t01 < 0 ? 0 : t01 > 1 ? 1 : t01;
  }

  update(dt, x, y) {
    const active = this._t >= 0;
    if (!active && this._glow <= 0.001) {
      if (this.group.visible) this.group.visible = false;
      return;
    }
    this.group.visible = true;
    this.group.position.set(x, y, 0);

    // ---- The strike animation -------------------------------------------
    if (active) {
      this._t += dt;
      const t = this._t;

      // Bolt: snaps in over 60 ms, holds briefly, then falls away fast. The
      // sharp attack is what makes it read as a strike rather than a fade.
      const boltIn = Math.min(t / 0.06, 1);
      const boltOut = 1 - Math.min(Math.max((t - 0.10) / 0.34, 0), 1);
      const bolt = boltIn * boltOut;
      this._boltMat.opacity = bolt * 0.72;
      this._coreMat.opacity = bolt * 0.95;
      // Thins as it discharges.
      const sq = 1 - 0.55 * (1 - boltOut);
      this._bolt.scale.set(sq, 1, sq);
      this._core.scale.set(sq * 0.9, 1, sq * 0.9);

      // Flare at the point of contact: brightest at impact, gone quickly.
      const fl = 1 - Math.min(t / 0.30, 1);
      this._flareMat.uniforms.uOpacity.value = fl * fl * 1.5;
      this._flare.scale.setScalar(1.6 + (1 - fl) * 3.4);

      // The waves. Progress drives the shader; the quad only has to be big
      // enough to contain the front at its widest.
      const r1 = Math.min(t / 0.62, 1);
      this._ring.scale.setScalar(16);
      this._ringMat.uniforms.uProg.value = r1;
      this._ringMat.uniforms.uOpacity.value = 1.15;

      const r2 = Math.min(Math.max((t - 0.10) / 0.85, 0), 1);
      this._ring2.scale.setScalar(24);
      this._ring2Mat.uniforms.uProg.value = r2;
      this._ring2Mat.uniforms.uOpacity.value = 0.7;

      const r3 = Math.min(t / 0.45, 1);
      this._dome.scale.set(9 * r3 + 1, 5.5 * r3 + 1, 9 * r3 + 1);
      this._domeMat.uniforms.uProg.value = r3;
      this._domeMat.uniforms.uOpacity.value = (1 - r3) * 0.5;

      if (t > 0.9) this._t = -1;
    } else {
      this._boltMat.opacity = 0;
      this._coreMat.opacity = 0;
      this._flareMat.uniforms.uOpacity.value = 0;
      this._ringMat.uniforms.uOpacity.value = 0;
      this._ring2Mat.uniforms.uOpacity.value = 0;
      this._domeMat.uniforms.uOpacity.value = 0;
    }

    // ---- Sustained corona -----------------------------------------------
    // Breathes slightly so it feels alive rather than pasted on.
    const pulse = 0.86 + 0.14 * Math.sin(performance.now() * 0.011);
    this._auraMat.uniforms.uOpacity.value = this._glow * 1.15 * pulse;
    const s = 1.05 + this._glow * 0.45;
    this._aura.scale.set(s, s * 1.32, s);
  }

  dispose() {
    this.scene.remove(this.group);
    for (const g of this._geos) g.dispose();
    this._boltMat.dispose();
    this._coreMat.dispose();
    this._ringMat.dispose();
    this._ring2Mat.dispose();
    this._domeMat.dispose();
    this._auraMat.dispose();

  }
}
