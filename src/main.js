// Chasqui Run: bootstrap, game state machine, main loop.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

import { CONFIG } from './config.js';
import { initMaterials, loadPhotoTextures, AnimU, Curve } from './materials.js';
import { clamp, lerp, damp } from './util.js';
import { Save } from './save.js';
import { Input } from './input.js';
import { CameraRig } from './camera.js';
import { Track } from './track.js';
import { Player } from './player.js';
import { buildChasqui } from './character.js';
import { SkySystem } from './sky.js';
import { Midground } from './midground.js';
import { WaterSystem } from './water.js';
import { Particles } from './particles.js';
import { UI } from './ui.js';
import { AudioSys } from './audio/engine.js';
import { Scores } from './scores.js';
import { loadModels } from './assets.js';
import { setEnv as setTerrainEnv, setWorldOrigin as setTerrainOrigin } from './terrain.js';
import { buildKilla } from './animals.js';
import { Nemesis } from './nemesis.js';
import { IntiStrike } from './intistrike.js';

const STATE = { MENU: 0, COUNTDOWN: 1, RUN: 2, PAUSED: 3, DEAD: 4 };

const AMBIENCE_BY_BIOME = {
  VALLEY: 'valley', CLIFF: 'puna', PUNA: 'puna', BRIDGE: 'bridge',
};

async function boot() {
  const bootEl = document.getElementById('boot');
  const bootSub = bootEl ? bootEl.querySelector('.boot-sub') : null;
  const setBoot = (t) => { if (bootSub) bootSub.textContent = t; };

  // ---- Quality ----
  const isMobile =
    matchMedia('(pointer: coarse)').matches || /Android|iPhone|iPad/i.test(navigator.userAgent);
  let qualityName = Save.quality || (isMobile ? 'low' : 'high');
  const Q = CONFIG.quality[qualityName] || CONFIG.quality.high;

  // ---- Renderer / scene / camera ----
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, Q.pixelRatioCap));
  renderer.setSize(innerWidth, innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;
  if (Q.shadows) {
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  }
  document.getElementById('app').appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  // High-altitude air: fog stays thin and far; 400 still masks the chunk
  // frontier at ~396 m while everything nearer reads crystal clear.
  scene.fog = new THREE.Fog(CONFIG.colors.fogValley, 90, 400);

  const camera = new THREE.PerspectiveCamera(CONFIG.fov.base, innerWidth / innerHeight, 0.1, 1100);

  initMaterials(renderer);

  // Photo PBR sets must be in before any material is built.
  setBoot('Cargando texturas reales...');
  await loadPhotoTextures();
  setBoot('Cargando modelos 3D...');
  await loadModels();
  // Recorded SFX. Never rejects, and the synthesized patches cover every sound
  // until (or if) the buffers land, so this can never block or break boot.
  setBoot('Afinando los sonidos...');
  await AudioSys.preloadSamples();

  // ---- World systems ----
  setBoot('Pintando el cielo de los Andes...');
  const sky = new SkySystem(scene, renderer);
  if (sky.sunLight) {
    sky.sunLight.castShadow = !!Q.shadows;
    if (Q.shadows && sky.sunLight.shadow) {
      sky.sunLight.shadow.mapSize.set(Q.shadowMap, Q.shadowMap);
    }
  }
  sky.setTimeOfDay(CONFIG.timeOfDayStart);

  // Image-based ambient light: a tiny gradient world PMREM-captured once.
  // Metals and roughness now respond to sky/ground bounce instead of a flat
  // hemisphere; this is most of the "plastic vs material" difference.
  {
    const envScene = new THREE.Scene();
    const geo = new THREE.SphereGeometry(10, 24, 16);
    const cols = new Float32Array(geo.attributes.position.count * 3);
    const zen = new THREE.Color(0x2b63c4);
    const hor = new THREE.Color(0xcfe2f2);
    const gnd = new THREE.Color(0x6f7a4e);
    const c = new THREE.Color();
    for (let i = 0; i < geo.attributes.position.count; i++) {
      const y = geo.attributes.position.getY(i) / 10;
      if (y >= 0) c.copy(hor).lerp(zen, Math.min(1, y * 1.4));
      else c.copy(hor).lerp(gnd, Math.min(1, -y * 2.2));
      cols[i * 3] = c.r; cols[i * 3 + 1] = c.g; cols[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    envScene.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })));
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(envScene, 0.02).texture;
    scene.environmentIntensity = 0.45;
    geo.dispose();
    pmrem.dispose();
  }

  const midground = new Midground(scene);
  const water = new WaterSystem();
  const particles = new Particles(scene);
  const syncParticleScale = () => {
    if (particles.setPixelScale) {
      particles.setPixelScale(540 * (innerHeight * Math.min(devicePixelRatio || 1, Q.pixelRatioCap)) / 1080);
    }
  };
  syncParticleScale();

  setBoot('Levantando la ciudadela...');
  const track = new Track(scene, water);
  await track.build((p) => setBoot(`Construyendo el camino... ${Math.round(p * 100)}%`));

  setBoot('Despertando al chasqui...');
  const chasqui = buildChasqui();
  // The character owns chasqui.group rotation channels; yaw goes on a parent.
  const chasquiRoot = new THREE.Group();
  chasquiRoot.add(chasqui.group);
  scene.add(chasquiRoot);
  const player = new Player(chasqui);
  const rig = new CameraRig(camera);


  // ---- Post ----
  let composer = null;
  let bloomPass = null;
  let gradePass = null;   // null on the low tier: no composer, no grade pass
  if (Q.bloom) {
    // Explicit MSAA target: the composer default has samples:0 and would
    // silently drop the canvas antialiasing.
    const rt = new THREE.WebGLRenderTarget(innerWidth, innerHeight, {
      type: THREE.HalfFloatType,
      samples: 4,
    });
    composer = new EffectComposer(renderer, rt);
    composer.addPass(new RenderPass(scene, camera));
    // Ground-truth ambient occlusion: contact darkening between objects is
    // the single biggest "grounded vs floating" cue.
    const gtao = new GTAOPass(scene, camera, innerWidth, innerHeight);
    gtao.updateGtaoMaterial({ radius: 0.35, thickness: 1, samples: 12, distanceExponent: 1 });
    gtao.blendIntensity = 0.55;
    // Sprites ignore override materials, so they smear garbage into the AO
    // depth/normal buffers and read back as ghost rectangles in the sky.
    // Hide every sprite for the AO pass only.
    const _gtaoHidden = [];
    const _gtaoOrigRender = gtao.render.bind(gtao);
    gtao.render = (...args) => {
      _gtaoHidden.length = 0;
      scene.traverse((o) => {
        if (o.isSprite && o.visible) { o.visible = false; _gtaoHidden.push(o); }
      });
      _gtaoOrigRender(...args);
      for (const o of _gtaoHidden) o.visible = true;
    };
    composer.addPass(gtao);
    bloomPass = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.32, 0.55, 0.85);
    composer.addPass(bloomPass);
    // Final grade: gentle vignette + split toning (cool shadows, warm
    // highlights) + a whisper of saturation. One cheap full-screen pass.
    gradePass = new ShaderPass({
      name: 'GradeShader',
      uniforms: {
        tDiffuse: { value: null },
        uVig: { value: 0.22 },
        // Speed feel. uBoost 0..1 is the eased Rayo curve, uHit is a decaying
        // impact impulse. Both drive screen-space effects that cost one pass
        // and no extra render targets, which is why they live here rather than
        // as separate passes.
        uBoost: { value: 0 },
        uHit: { value: 0 },
        uAber: { value: 0 },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform sampler2D tDiffuse;
        uniform float uVig;
        uniform float uBoost;
        uniform float uHit;
        uniform float uAber;
        varying vec2 vUv;

        void main() {
          vec2 uv = vUv;
          vec2 toC = uv - 0.5;
          float d = length(toC);

          // Impact punch: a brief radial squeeze of the whole image. Reads as
          // the shockwave hitting the camera itself.
          uv -= toC * uHit * 0.06 * smoothstep(0.0, 0.9, d);

          // Radial speed blur while boosting. Samples march back along the
          // vector to the centre, so the world streaks outward past you and
          // the middle of the screen stays readable, which matters because the
          // player still has to see the road.
          float amt = uBoost * 0.055 + uHit * 0.05;
          vec4 color = vec4(0.0);
          if (amt > 0.001) {
            float w = 0.0;
            for (int i = 0; i < 8; i++) {
              float t = float(i) / 7.0;
              // Weight the streak by distance from centre: none in the middle,
              // strong at the edges.
              vec2 su = uv - toC * t * amt * smoothstep(0.10, 0.75, d);
              float wt = 1.0 - t * 0.65;
              color += texture2D(tDiffuse, su) * wt;
              w += wt;
            }
            color /= w;
          } else {
            color = texture2D(tDiffuse, uv);
          }

          // Chromatic aberration, scaled by radius so the centre stays clean.
          float ab = (uAber + uBoost * 0.35 + uHit * 0.6) * 0.0032;
          if (ab > 0.00001) {
            vec2 off = toC * ab * smoothstep(0.06, 0.9, d);
            color.r = texture2D(tDiffuse, uv + off).r;
            color.b = texture2D(tDiffuse, uv - off).b;
          }

          // Vignette tightens while boosting: tunnel vision under power.
          float vig = uVig + uBoost * 0.16 + uHit * 0.10;
          color.rgb *= 1.0 - vig * smoothstep(0.34, 0.86, d);

          float lum = dot(color.rgb, vec3(0.299, 0.587, 0.114));
          vec3 tint = mix(vec3(0.94, 0.98, 1.05), vec3(1.045, 1.0, 0.95),
                          smoothstep(0.18, 0.72, lum));
          color.rgb *= tint;
          color.rgb = mix(vec3(lum), color.rgb, 1.06);

          // Inti's warmth washes the frame while the blessing is on.
          color.rgb += vec3(0.16, 0.10, 0.02) * uBoost * (0.35 + d);
          gl_FragColor = color;
        }`,
    });
    composer.addPass(gradePass);
    composer.addPass(new SMAAPass(innerWidth, innerHeight));
    composer.addPass(new OutputPass());
  }

  // ---- Game state ----
  const G = {
    state: STATE.MENU,
    dist: 0,
    runCoins: 0,
    combo: 0,
    comboT: 0,
    shield: false,
    wayraT: 0,
    quriT: 0,
    boost: 0,
    intiRayT: 0,
    intiRayCd: 0,
    intiRayBoost: 0,
    roadPhase: { a: 0, b: 2, c: 0, d: 1, e: 0, f: 0 },
    timeScale: 1,
    deathT: 0,
    gameOverShown: false,
    timeOfDay: CONFIG.timeOfDayStart,
    todDir: 1,
    audioStarted: false,
    isRecord: false,
  };

  const playerPos = { x: 0, y: 0, z: 0 };
  const _dustV = new THREE.Vector3();
  const _fxV = new THREE.Vector3();
  const _envV = new THREE.Vector3();
  const _envC1 = new THREE.Color();
  const _envC2 = new THREE.Color();
  const _terrainEnv = { sunDir: null, sunColor: null, hemiColor: null, fogColor: null, fogNear: 90, fogFar: 400 };

  // ---- UI ----
  const click = () => AudioSys.play('uiClick');
  const ui = new UI(document.getElementById('ui'), {
    onPlay: () => { click(); if (G.state === STATE.MENU) startRun(); },
    onResume: () => { click(); resumeGame(); },
    onRestart: () => { click(); hideAllPanels(); startRun(); },
    onMenu: () => { click(); toMenu(); },
    onPause: () => { click(); pauseGame(); },
    onIntiRay: () => fireIntiRay(),
    onMute: (m) => { AudioSys.setMuted(m); Save.muted = m; click(); },
    onQuality: (q) => {
      click();
      Save.quality = q;
      ui.toast('Calidad guardada. Recargando...');
      setTimeout(() => location.reload(), 650);
    },
  });
  ui.setMuted(Save.muted);
  ui.setQuality(qualityName);
  AudioSys.setMuted(Save.muted);

  function hideAllPanels() {
    ui.hideGameOver();
    ui.hidePause();
    ui.hideTitle();
  }

  // ---- Audio bootstrapping on first gesture ----
  function ensureAudio() {
    if (!G.audioStarted) {
      G.audioStarted = true;
      AudioSys.init();
      if (G.state === STATE.MENU) {
        AudioSys.startMusic('menu');
        AudioSys.setAmbience('valley');
      }
    }
    AudioSys.resume();
  }

  // ---- Player events ----
  chasqui.onFootstep((foot) => {
    if (G.state === STATE.RUN && !player.dead && player.grounded) {
      AudioSys.play('footstep', { foot, vol: 0.5 });
      _dustV.set(player.x + (foot ? 0.15 : -0.15), 0.04, 0.2);
      particles.dust(_dustV, 3);
    }
  });

  player.onJump = () => {
    AudioSys.play('jump');
    _dustV.set(player.x, 0.05, 0);
    particles.dust(_dustV, 6);
  };
  player.onLand = () => {
    _dustV.set(player.x, 0.05, 0);
    particles.dust(_dustV, 5);
  };
  player.onSlide = () => {
    AudioSys.play('slide');
    _dustV.set(player.x, 0.08, 0.3);
    particles.dust(_dustV, 8);
  };
  player.onCrash = (ob) => {
    // Invulnerable through the boosts AND their eased decay tails: the speed
    // is still super-human for ~0.3 s after the timers expire.
    if (G.wayraT > 0 || G.intiRayT > 0 || G.boost > 0.25 || G.intiRayBoost > 0.25) return;
    if (ob && ob.kind === 'llama') AudioSys.play('llama');
    if (G.shield) {
      G.shield = false;
      player.invulnT = 1.3;
      AudioSys.play('shieldSave');
      _fxV.set(player.x, 1.2, 0);
      particles.burst(_fxV, 0xffc23e, 24);
      rig.shake(0.28);
      ui.flashGold();
      return;
    }
    player.die('hit');
    G.state = STATE.DEAD;
    G.deathT = 0;
    G.timeScale = 0.32;
    rig.setMode('dead');
    rig.shake(CONFIG.cameraShakeCrash);
    AudioSys.play('crash');
    AudioSys.stopMusic(0.5);
    punch(0.85);
    herdLaugh();
    ui.flashDamage();
    ui.hideHUD();
    _fxV.set(player.x, 1.0, 0);
    particles.debris(_fxV);
  };
  player.onFall = () => {
    G.state = STATE.DEAD;
    G.deathT = 0;
    rig.setMode('dead');
    AudioSys.play('fall');
    AudioSys.stopMusic(0.5);
    herdLaugh();
    ui.hideHUD();
  };


  // ---- Killa, the nemesis ----
  const killa = buildKilla();
  const intiStrike = new IntiStrike(scene);
  // Parented to the scene (player space) rather than worldGroup, so chunk
  // recycling can never touch her. Hooks keep nemesis.js free of direct
  // dependencies on audio, particles and the UI.
  const nemesis = new Nemesis(scene, killa, {
    spit: () => AudioSys.play('killaSpit'),
    chuckle: () => AudioSys.play('killaChuckle'),
    taunt: (v) => AudioSys.play('killaTaunt', { variation: v }),
    orgle: () => AudioSys.play('killaOrgle'),
    stamp: () => AudioSys.play('killaStamp'),
    panic: () => AudioSys.play('killaPanic'),
    sting: () => AudioSys.killaSting && AudioSys.killaSting(),
    splatter: (side) => ui.splatter(side),
    toast: (txt) => ui.killaToast(txt),
    portrait: (on) => ui.killaPortrait && ui.killaPortrait(on),
    // Reading her lunge and not being there is a real save; make it feel like
    // one rather than a non-event.
    dodged: () => {
      AudioSys.play('powerup', { vol: 0.5 });
      ui.flashGold();
      rig.shake(0.12);
    },
    stealQipi: () => {
      // The bundle leaves his back and rides her. Coins stop banking while she
      // has it: the delivery is the job, so nothing else counts until it is
      // back. That is a real cost with zero risk of an unfair death.
      chasqui.setQipiVisible(false);
      G.qipiLost = true;
      G.combo = 0;
      rig.shake(0.32);
      ui.flashDamage();
      AudioSys.play('crash', { vol: 0.45 });
    },
    returnQipi: (caught) => {
      chasqui.setQipiVisible(true);
      G.qipiLost = false;
      if (caught) {
        AudioSys.play('powerup');
        ui.flashGold();
        _fxV.set(player.x, 1.2, 0);
        particles.burst(_fxV, 0xffd76a, 34);
      }
    },
    armed: (on) => {
      G.pututuArmed = on;
      // The mountain tells you what you can do. She only ever tells you what
      // you failed to do.
      if (on) ui.apuToast('El pututu ha despertado. Invocalo con Shift.');
    },
    // She robs the run, never the life. Coins, combo, tempo and charge are
    // hers to take; survival is not.
    steal: (n) => {
      const got = Math.min(n * CONFIG.coinValue, G.runCoins);
      G.runCoins -= got;
      G.combo = 0;
      ui.flashDamage();
      return got;
    },
    siphon: () => {
      // Half the banked Rayo charge, never a full reset.
      if (G.intiRayCd <= 0) {
        G.intiRayCd = (CONFIG.intiRay.duration + CONFIG.intiRay.cooldown) * 0.5;
      } else {
        G.intiRayCd = Math.min(
          CONFIG.intiRay.duration + CONFIG.intiRay.cooldown,
          G.intiRayCd + 6
        );
      }
    },
    headbutt: (dir) => {
      // The shove: lose the lane, the combo and a slice of the purse. Never
      // a death state, no matter the speed.
      player.laneIdx = clamp(player.laneIdx + dir, 0, CONFIG.lanes.length - 1);
      G.combo = 0;
      G.runCoins = Math.max(0, Math.round(G.runCoins * 0.85));
      G.timeScale = 0.82;
      rig.shake(0.3);
      AudioSys.play('crash', { vol: 0.5 });
      ui.flashDamage();
      _fxV.set(player.x, 1.0, 0);
      particles.dust(_fxV, 12);
    },
  });

  // ---- Biome events ----
  let splashDone = false;
  const MIDGROUND_TINT = {
    VALLEY: 0x8fa86a, CLIFF: 0x99876a, PUNA: 0xb7a468, BRIDGE: 0x9aa4ac,
  };
  track.onBiomeChange = (biome, name) => {
    particles.setSnow(false);
    particles.setMist(false);
    particles.setEmbers(false);
    if (midground.setTint) midground.setTint(MIDGROUND_TINT[biome]);
    sky.setSnowcapNear(biome === 'PUNA' ? 1 : 0);
    if (G.audioStarted) AudioSys.setAmbience(AMBIENCE_BY_BIOME[biome]);
    if (G.state === STATE.RUN) {
      ui.toast(name);
      if (G.dist > 10) AudioSys.play('pututu', { vol: 0.35 });
    }
  };

  // ---- State transitions ----
  // Gameplay reminders. Two schedules, and the wording follows the actual
  // input the player has: telling a phone user to press Shift is worse than
  // saying nothing. BASICS stop hard at 200 m, past which a tip is just noise.
  // KILLA tips fire once, when she first appears and the rules change.
  const TIP_LIMIT = 200;
  const TIPS_TOUCH = [
    'Desliza izquierda o derecha para cambiar de carril',
    'Desliza arriba para saltar, abajo para deslizarte',
    'Toca el boton RAYO para invocar al sol',
    'Recoge soles sin romper la racha',
  ];
  const TIPS_KEYS = [
    'Flechas o WASD para cambiar de carril',
    'Arriba para saltar, abajo para deslizarte',
    'Shift: invoca el Rayo de Inti',
    'Recoge soles sin romper la racha',
  ];
  const TIP_AT = [18, 62, 118, 168];
  const tipText = isMobile ? TIPS_TOUCH : TIPS_KEYS;
  const basicTips = TIP_AT.map((at, i) => ({ at, said: false, text: tipText[i] }));
  const killaTipText = [
    'Killa quiere tu encomienda, no tus soles',
    'Cuando te mire fijo, va a atacar un carril',
    isMobile
      ? 'Lee el carril y deslizate a otro: fallara'
      : 'Lee el carril y cambiate a otro: fallara',
  ];
  const killaTips = [0, 4.5, 9].map((after, i) => ({ after, said: false, text: killaTipText[i] }));
  let killaSeen = false;
  let killaTipT = 0;
  function resetTips() {
    for (const t of basicTips) t.said = false;
    for (const t of killaTips) t.said = false;
    killaSeen = false;
    killaTipT = 0;
    ui.tip(null);
  }

  // The Apu's guidance beats. Distance-gated, fired once per run, and always
  // about something the player can act on right now.
  const apuBeats = [
    { at: 3, said: false, line: 'Lleva el quipu al Inca. Cueste lo que cueste.' },
    { at: 60, said: false, line: isMobile
      ? 'Pide ayuda al sol cuando necesites correr.'
      : 'Pide ayuda al sol cuando necesites correr. Shift.' },
    { at: 1500, said: false, line: 'El camino se estrecha. Manten el paso, chasqui.' },
  ];
  function resetApuBeats() { for (const b of apuBeats) b.said = false; }

  function startRun() {
    track.reset();
    player.reset();
    chasquiRoot.rotation.y = 0;
    chasqui.setMode('idle');
    G.dist = 0;
    G.runCoins = 0;
    G.combo = 0;
    G.shield = false;
    G.wayraT = 0;
    G.quriT = 0;
    G.boost = 0;
    G.intiRayT = 0;
    G.intiRayCd = 0;
    G.intiRayBoost = 0;
    G.timeScale = 1;
    G.gameOverShown = false;
    G.isRecord = false;
    G.killaLine = '';
    G.qipiLost = false;
    // Re-roll the road's character so a repeated route never feels repeated.
    G.roadPhase.a = Math.random() * 6.283;
    G.roadPhase.b = Math.random() * 6.283;
    G.roadPhase.c = Math.random() * 6.283;
    G.roadPhase.d = Math.random() * 6.283;
    G.roadPhase.e = Math.random() * 6.283;
    G.roadPhase.f = Math.random() * 6.283;
    resetApuBeats();
    resetTips();
    chasqui.setQipiVisible(true);
    nemesis.reset((Math.random() * 0xffffffff) >>> 0);
    splashDone = false;
    hideAllPanels();
    ui.hideHUD(); // no stale previous-run stats behind the countdown
    rig.setMode('run');
    G.state = STATE.COUNTDOWN;
    ensureAudio();
    AudioSys.stopMusic(0.4);
    beginCountdown();
  }

  function beginCountdown() {
    ui.countdown(() => {
      G.state = STATE.RUN;
      chasqui.setMode('run');
      AudioSys.play('pututu');
      AudioSys.startMusic('game');
      ui.showHUD();
    });
  }

  function pauseGame() {
    if (G.state !== STATE.RUN) return;
    G.state = STATE.PAUSED;
    AudioSys.stopMusic(0.25);
    ui.showPause();
  }

  function resumeGame() {
    if (G.state !== STATE.PAUSED) return;
    ui.hidePause();
    G.state = STATE.RUN;
    AudioSys.startMusic('game');
    AudioSys.resume();
  }

  function toMenu() {
    nemesis.park();
    hideAllPanels();
    ui.hideHUD();
    track.reset();
    player.reset();
    chasqui.setMode('menu');
    chasquiRoot.rotation.y = Math.PI * 0.88; // face the menu camera
    rig.setMode('menu');
    G.state = STATE.MENU;
    G.timeScale = 1;
    ui.showTitle({ best: Save.best, coins: Save.coins });
    Scores.top().then(({ scores, source }) => {
      if (G.state === STATE.MENU) ui.showTitleScores(scores, source);
    });
    if (G.audioStarted) {
      AudioSys.startMusic('menu');
      AudioSys.setAmbience('valley');
    }
  }

  // Every llama on the road gets to enjoy this. Staggered starts and distinct
  // variation seeds so it reads as a herd reacting, not one sound retriggered.
  function herdLaugh() {
    const n = 3 + ((Math.random() * 3) | 0);
    for (let i = 0; i < n; i++) {
      setTimeout(() => {
        AudioSys.play('killaChuckle', {
          variation: Math.random(),
          vol: 0.3 + Math.random() * 0.3,
        });
      }, 140 + i * (90 + Math.random() * 150));
    }
  }

  function finishRun() {
    const best = Save.best;
    const d = Math.floor(G.dist);
    G.isRecord = d > best;
    if (G.isRecord) Save.best = d;
    Save.coins = Save.coins + G.runCoins;
    AudioSys.play('gameOver');
    if (G.isRecord) AudioSys.play('record');

    // Killa stages the death screen. She takes credit for kills she did not
    // commit (any death within 2.5 s of an intervention reads as hers), which
    // makes her feel lethal while staying provably non-lethal in code. The
    // cause line stays honest so the player is never actually lied to.
    const line = nemesis.gloat(player.deathCause, G.isRecord);
    G.killaLine = line;
    ui.showGameOver({
      dist: d, coins: G.runCoins, best: Math.max(best, d), isRecord: G.isRecord,
    });
    if (ui.showGloat) {
      ui.showGloat({
        dist: d, coins: G.runCoins, isRecord: G.isRecord,
        cause: nemesis.causeLine(player.deathCause), line,
      });
    }

    // Arcade hi-score: shared global board; 4-letter tag when you make it.
    Scores.top().then(({ scores, source }) => {
      if (G.state !== STATE.DEAD || !G.gameOverShown) return; // already left
      if (Scores.qualifies(scores, d)) {
        ui.showScoreEntry(Scores.lastTag, (tag) => {
          Scores.lastTag = tag;
          AudioSys.play('record');
          Scores.submit(tag, d).then(({ rank, scores: s2, source: src2 }) => {
            if (G.state === STATE.DEAD) ui.showScoreTable(s2, rank, src2);
          });
        });
      } else {
        ui.showScoreTable(scores, 0, source);
      }
    });
  }

  // ---- Input ----
  const input = new Input((action) => {
    if (action === 'any') { ensureAudio(); return; }
    if (action === 'pause') {
      if (G.state === STATE.RUN) pauseGame();
      else if (G.state === STATE.PAUSED) resumeGame();
      return;
    }
    if (G.state === STATE.MENU) {
      if (action === 'jump') startRun();
      return;
    }
    if (G.state !== STATE.RUN) return;
    if (action === 'left' || action === 'right') {
      const before = player.laneIdx;
      if (action === 'left') player.left(); else player.right();
      if (player.laneIdx !== before) AudioSys.play('whoosh', { vol: 0.4 });
    } else if (action === 'jump') player.jump();
    else if (action === 'slide') player.slide();
    else if (action === 'intiRay') fireIntiRay();
  });

  // ---- Resize ----
  // Render scale, driven by measured frame time. Phones vary enormously and a
  // fixed pixel ratio either wastes a good device or drowns a weak one, so the
  // resolution adapts instead. Only ever scales DOWN from the tier cap.
  let renderScale = 1;
  const MIN_SCALE = isMobile ? 0.62 : 0.75;

  function applySize() {
    const cap = Math.min(devicePixelRatio || 1, Q.pixelRatioCap) * renderScale;
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(cap);
    renderer.setSize(innerWidth, innerHeight);
    syncParticleScale();
    if (composer) {
      composer.setPixelRatio(cap);
      composer.setSize(innerWidth, innerHeight);
    }
  }

  // Debounced: iOS fires resize continuously while the URL bar slides, and
  // reallocating the render targets on every one of those events is a far
  // bigger stall than the resize itself.
  let resizeTimer = 0;
  const onResize = () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(applySize, 120);
  };
  addEventListener('resize', onResize);
  addEventListener('orientationchange', onResize);

  let countdownInterrupted = false;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (G.state === STATE.RUN) pauseGame();
      else if (G.state === STATE.COUNTDOWN) {
        // Freeze the countdown; it restarts when the tab returns.
        countdownInterrupted = true;
        if (ui.cancelCountdown) ui.cancelCountdown();
      }
      AudioSys.suspend && AudioSys.suspend(); // no sound from a hidden tab
    } else {
      AudioSys.resume();
      if (countdownInterrupted) {
        countdownInterrupted = false;
        beginCountdown();
      }
    }
  });

  // ---- Scratch ----
  // Reused every frame; the nemesis update must never allocate.
  const nemesisCtx = {
    dist: 0, speed: 0, state: 0, playerX: 0, playerLane: 1,
    grounded: true, sliding: false, nitroT: 0, nearGap: false, track: null,
  };
  const hudPowerups = [];
  const hudIntiRay = { state: 'ready', t01: 1 };
  let rayoWasCooling = false;
  // Screen impact impulse. Set to 1 by big events and decays every frame; the
  // grade pass turns it into a radial squeeze, aberration and vignette pulse.
  let screenHit = 0;
  const punch = (v) => { screenHit = Math.max(screenHit, v); };
  const hudData = { dist: 0, coins: 0, mult: 1, powerups: hudPowerups, intiRay: hudIntiRay };

  // ---- Main loop ----
  const clock = new THREE.Clock();
  const charState = { mode: 'menu', speed01: 0, airT: 0, leanX: 0, dead: false };

  function speedNow() {
    const t = clamp(G.dist / CONFIG.accelRampMeters, 0, 1);
    let s = lerp(CONFIG.baseSpeed, CONFIG.maxSpeed, Math.pow(t, 0.8));
    // Wayra and intiRay, both eased so speed never steps in a single frame.
    s *= 1 + 0.35 * G.boost + CONFIG.intiRay.boost * G.intiRayBoost;
    return s;
  }

  function fireIntiRay() {
    if (G.state !== STATE.RUN || player.dead) return;
    // An armed pututu takes priority over the dash. This is the revenge beat:
    // Killa panics, trips, and coughs up everything she stole from this run.
    if (nemesis.armed) {
      const payout = nemesis.blastPututu();
      AudioSys.play('pututu');
      G.runCoins += payout;
      G.timeScale = 0.45;
      rig.shake(0.35);
      _fxV.set(player.x, 1.2, 0);
      particles.burst(_fxV, 0xffd76a, 46);
      ui.flashGold();
      return;
    }
    if (G.intiRayCd > 0) return;
    G.intiRayT = CONFIG.intiRay.duration;
    G.intiRayCd = CONFIG.intiRay.duration + CONFIG.intiRay.cooldown;
    // The sun god actually arrives: a bolt out of the sky, a shockwave on the
    // ground, and a sound built for the moment instead of a recycled whoosh.
    AudioSys.play('intiStrike');
    AudioSys.duckMusic(0.6);   // the mix gets out of the way for the god
    intiStrike.strike();
    punch(1);
    _fxV.set(player.x, 1.1, 0);
    particles.burst(_fxV, 0xffc247, 44);
    rig.shake(0.42);
    G.timeScale = 0.55;   // brief hitch so the strike lands with weight
    ui.flashGold();
  }

  let perfAccum = 0;
  let perfFrames = 0;
  let perfCooldown = 0;

  // Adapt the render scale to the device. Measured over a whole second so one
  // hitch (a chunk build, a GC pause) can never trigger a resolution change.
  function adaptPerf(dtRaw) {
    if (G.state !== STATE.RUN) return;
    if (perfCooldown > 0) { perfCooldown -= dtRaw; return; }
    perfAccum += dtRaw;
    perfFrames++;
    if (perfAccum < 1) return;
    const avg = perfAccum / perfFrames;
    perfAccum = 0;
    perfFrames = 0;
    // Below ~45 fps: drop resolution. Comfortably above 58: give it back.
    if (avg > 0.0222 && renderScale > MIN_SCALE) {
      renderScale = Math.max(MIN_SCALE, renderScale - 0.1);
      applySize();
      perfCooldown = 2.5;
    } else if (avg < 0.0166 && renderScale < 1) {
      renderScale = Math.min(1, renderScale + 0.05);
      applySize();
      perfCooldown = 4;
    }
  }

  function frame() {
    requestAnimationFrame(frame);
    const dtRaw = Math.min(clock.getDelta(), 0.05);
    adaptPerf(dtRaw);
    if (G.state === STATE.PAUSED) {
      renderFrame();
      return;
    }
    G.timeScale = damp(G.timeScale, 1, 2.2, dtRaw);
    const dt = dtRaw * G.timeScale;

    // Shared animation clock: wind sway, waterfalls, cloud-shadow drift.
    AnimU.time.value = (AnimU.time.value + dtRaw) % 14400;
    AnimU.cloudOff.value.x += dtRaw * 0.0021;
    AnimU.cloudOff.value.y += dtRaw * 0.0008;

    // The road sweeps: the shared curvature uniforms bend the whole world
    // into long lateral curves, crests and dips as distance advances. The
    // mountains stay unbent, anchoring the horizon, so the road reads as
    // winding THROUGH the landscape. Purely visual: physics never changes.
    // Andean roads are not graded highways: they roll, crest, dip and bank.
    // Three octaves per axis with per-run phase offsets, so the SAME chunk
    // geometry reads as a different stretch of mountain on every run. This is
    // purely a vertex bend; physics, lanes and collision never move, which is
    // why it can be this aggressive without ever being unfair.
    const ph = G.roadPhase;
    const swp =
      Math.sin(G.dist * 0.0021 + ph.a) * 0.62 +
      Math.sin(G.dist * 0.00057 + ph.b) * 0.30 +
      Math.sin(G.dist * 0.0049 + ph.c) * 0.14;
    // Vertical: a long swell, a medium roll, and a short chop that reads as
    // the road actually being broken up underfoot.
    const rise =
      Math.sin(G.dist * 0.0013 + ph.d) * 6.2e-5 +
      Math.sin(G.dist * 0.0037 + ph.e) * 3.1e-5 +
      Math.sin(G.dist * 0.0092 + ph.f) * 1.5e-5;
    Curve.uniforms.uCurveX.value = swp * 2.9e-4;
    Curve.uniforms.uCurveY.value = -1.15e-4 + rise;

    G.boost = damp(G.boost, G.state === STATE.RUN && G.wayraT > 0 ? 1 : 0, 6, dtRaw);
    G.intiRayBoost = damp(G.intiRayBoost, G.state === STATE.RUN && G.intiRayT > 0 ? 1 : 0, 8, dtRaw);
    const speed = G.state === STATE.RUN ? speedNow() : 0;
    const speed01 = clamp((speed - CONFIG.baseSpeed) / (CONFIG.maxSpeed - CONFIG.baseSpeed), 0, 1);

    playerPos.x = player.x;
    playerPos.y = player.y;
    playerPos.z = 0;

    if (G.state === STATE.RUN) {
      G.dist += speed * dt;
      const frameTravel = speed * dt;
      track.update(dt, speed);
      player.update(dt, track, frameTravel);
      player.checkCollisions(track, frameTravel);

      // Killa runs AFTER the track (so worldGroup z is current) and AFTER the
      // player (so she reads settled state). Her collider is her own; it never
      // goes near track.getColliders().
      nemesisCtx.dist = G.dist;
      nemesisCtx.speed = speed;
      nemesisCtx.state = G.state;
      nemesisCtx.playerX = player.x;
      nemesisCtx.playerLane = player.laneIdx;
      nemesisCtx.grounded = player.grounded;
      nemesisCtx.sliding = player.sliding;
      nemesisCtx.nitroT = G.intiRayT;
      nemesisCtx.nearGap = !track.isGroundSolid(player.x, 34);
      nemesisCtx.track = track;
      nemesis.update(dt, nemesisCtx);
      // Ramming her at speed is a humiliation, not a crash: she throws a
      // three stage tantrum and the player pays nothing.
      if (nemesis.hasQipi) {
        // The chase: touching her at all wins the bundle back, Rayo or not.
        if (nemesis.overlapsPlayer(player)) nemesis.dropQipi(false);
      } else if (G.intiRayT > 0 || G.intiRayBoost > 0.5) {
        if (nemesis.overlapsPlayer(player)) nemesis.nitroRam();
      } else {
        nemesis.collide(player);
      }

      // Coins.
      const magnetOn = G.quriT > 0;
      const got = track.coins.update(dt, playerPos, magnetOn, speed * dt * 0.5);
      for (const c of got) {
        G.combo++;
        G.comboT = 1.2;
        // No encomienda, no delivery, no pay. Coins still collect visually so
        // the road does not feel dead, they just do not bank until she gives
        // the bundle back.
        if (!G.qipiLost) G.runCoins += CONFIG.coinValue * (G.wayraT > 0 ? 2 : 1);
        AudioSys.play('coin', { combo: G.combo });
        _fxV.set(c.x, c.y, c.z);
        particles.sparkle(_fxV, 0xffd76a);
      }
      if (G.comboT > 0) { G.comboT -= dt; if (G.comboT <= 0) G.combo = 0; }

      // Specials.
      const specials = track.specials.update(dt, playerPos);
      for (const s of specials) {
        _fxV.set(s.x, s.y, s.z);
        if (s.kind === 'chakana') {
          G.runCoins += CONFIG.chakanaValue;
          AudioSys.play('chakana');
          particles.burst(_fxV, 0xffd76a, 30);
          ui.flashGold();
          ui.toast('¡Chakana sagrada!');
        } else if (s.kind === 'inti') {
          G.shield = true;
          AudioSys.play('powerup');
          particles.burst(_fxV, 0xffc23e, 22);
        } else if (s.kind === 'wayra') {
          G.wayraT = CONFIG.powerupDuration.wayra;
          AudioSys.play('gust');
          particles.burst(_fxV, 0x7de8ff, 22);
        } else if (s.kind === 'quri') {
          G.quriT = CONFIG.powerupDuration.quri;
          AudioSys.play('powerup');
          particles.burst(_fxV, 0xc79bff, 22);
        }
      }
      if (G.dist < TIP_LIMIT) {
        for (let i = 0; i < basicTips.length; i++) {
          const t = basicTips[i];
          if (!t.said && G.dist >= t.at) { t.said = true; ui.tip(t.text); break; }
        }
      }
      if (!killaSeen && killa.group.visible) killaSeen = true;
      if (killaSeen) {
        killaTipT += dt;
        for (let i = 0; i < killaTips.length; i++) {
          const t = killaTips[i];
          if (!t.said && killaTipT >= t.after) { t.said = true; ui.tip(t.text, 3400); break; }
        }
      }

      for (let i = 0; i < apuBeats.length; i++) {
        const b = apuBeats[i];
        if (!b.said && G.dist >= b.at) { b.said = true; ui.apuToast(b.line); }
      }

      if (G.wayraT > 0) G.wayraT -= dt;
      if (G.quriT > 0) G.quriT -= dt;
      if (G.intiRayT > 0) G.intiRayT -= dt;
      if (G.intiRayCd > 0) G.intiRayCd -= dt;

      // Permanent crystal sierra daytime; the cycle is retired by request.

      // HUD.
      hudPowerups.length = 0;
      if (G.shield) hudPowerups.push({ kind: 'inti', t01: 1 });
      if (G.wayraT > 0) hudPowerups.push({ kind: 'wayra', t01: G.wayraT / CONFIG.powerupDuration.wayra });
      if (G.quriT > 0) hudPowerups.push({ kind: 'quri', t01: G.quriT / CONFIG.powerupDuration.quri });
      hudData.dist = Math.floor(G.dist);
      hudData.coins = G.runCoins;
      hudData.mult = G.wayraT > 0 ? 2 : 1;
      if (G.intiRayT > 0) {
        hudIntiRay.state = 'active';
        hudIntiRay.t01 = G.intiRayT / CONFIG.intiRay.duration;
      } else if (G.intiRayCd > 0) {
        rayoWasCooling = true;
        hudIntiRay.state = 'cooldown';
        hudIntiRay.t01 = 1 - G.intiRayCd / (CONFIG.intiRay.duration + CONFIG.intiRay.cooldown);
      } else {
        // The moment it comes back. Easy to miss mid-run, so it gets both a
        // sound and a visible pulse rather than silently becoming available.
        if (rayoWasCooling) {
          rayoWasCooling = false;
          AudioSys.play('powerup', { vol: 0.55 });
          if (ui.rayoReady) ui.rayoReady();
        }
        hudIntiRay.state = 'ready';
        hudIntiRay.t01 = 1;
      }
      hudData.intiRay = hudIntiRay;
      ui.updateHUD(hudData);
    } else if (G.state === STATE.DEAD) {
      track.update(dt, 0); // world halts, ambient anims continue
      player.update(dt, track);
      // She keeps animating through the death screen: the gloat IS the beat.
      nemesisCtx.dist = G.dist;
      nemesisCtx.speed = 0;
      nemesisCtx.state = G.state;
      nemesisCtx.playerX = player.x;
      nemesisCtx.track = track;
      nemesis.update(dtRaw, nemesisCtx);
      G.deathT += dtRaw;
      if (player.deathCause === 'fall' && !splashDone && player.y < -24 && track.currentBiome === 'BRIDGE') {
        splashDone = true;
        _fxV.set(player.x, -26, 0);
        particles.splash(_fxV);
        AudioSys.play('splash');
      }
      if (G.deathT > 1.5 && !G.gameOverShown) {
        G.gameOverShown = true;
        finishRun();
      }
    } else {
      // MENU / COUNTDOWN: ambient world only.
      track.update(dt, 0);
    }

    // Character animation state.
    charState.speed01 = speed01;
    charState.airT = player.airT;
    charState.leanX = player.leanX;
    charState.dead = player.dead;
    if (G.state === STATE.MENU) charState.mode = 'menu';
    else if (G.state === STATE.COUNTDOWN) charState.mode = 'idle';
    else if (player.dead) charState.mode = 'fall';
    else if (!player.grounded) charState.mode = 'jump';
    else if (player.sliding) charState.mode = 'slide';
    else charState.mode = 'run';
    chasqui.update(dt, charState);
    // Inti's blessing rides the same eased curve as the speed boost.
    chasqui.setIntiGlow(G.intiRayBoost);
    intiStrike.setGlow(G.intiRayBoost);
    intiStrike.update(dtRaw, player.x, player.y);

    screenHit = Math.max(0, screenHit - dtRaw * 3.4);
    if (gradePass) {
      gradePass.uniforms.uBoost.value = G.intiRayBoost;
      gradePass.uniforms.uHit.value = screenHit * screenHit;
    }
    // FOV kick. The camera itself has to react or the screen effects are just
    // decoration bolted onto a static lens.
    const fovWant = CONFIG.fov.base
      + (CONFIG.fov.max - CONFIG.fov.base) * (speed01 * 0.55 + G.intiRayBoost * 0.45);
    if (Math.abs(camera.fov - fovWant) > 0.01) {
      camera.fov = damp(camera.fov, fovWant, 4.5, dtRaw);
      camera.updateProjectionMatrix();
    }

    // Atmosphere.
    sky.update(dtRaw, camera, G.dist);
    midground.update(dtRaw, camera);
    // Splat terrain lighting/fog/anchor sync (single source of truth: sky).
    _terrainEnv.sunDir = sky.getSunDir(_envV);
    _terrainEnv.sunColor = _envC1.copy(sky.sunLight.color).multiplyScalar(sky.sunLight.intensity * 0.32);
    _terrainEnv.hemiColor = _envC2.copy(sky.hemi.color).multiplyScalar(sky.hemi.intensity * 0.32);
    _terrainEnv.fogColor = scene.fog.color;
    _terrainEnv.fogNear = scene.fog.near;
    _terrainEnv.fogFar = scene.fog.far;
    setTerrainEnv(_terrainEnv);
    setTerrainOrigin(track.worldGroup.position.x, track.worldGroup.position.z);
    if (sky.getSunDir && water.setSunDir) {
      sky.getSunDir(_fxV);
      water.setSunDir(_fxV);
    }
    water.update(dtRaw);
    if (particles.setWorldVel) particles.setWorldVel(G.state === STATE.RUN ? speed : 0);
    particles.update(dtRaw, camera);
    rig.update(dtRaw, player, speed01);

    renderFrame();
  }

  function renderFrame() {
    if (composer) composer.render();
    else renderer.render(scene, camera);
  }

  // Hidden debug handle (harmless in production, used by tests).
  window.__cq = { G, player, track, sky, AudioSys, startRun, renderer, nemesis, killa };

  // ---- Go ----
  setBoot('Listo.');
  if (bootEl) {
    bootEl.classList.add('hide'); // css/style.css defines #boot.hide fade
    setTimeout(() => bootEl.remove(), 650);
  }
  toMenu();
  frame();
}

boot().catch((err) => {
  console.error('Boot failed:', err);
  const bootEl = document.getElementById('boot');
  if (bootEl) {
    const sub = bootEl.querySelector('.boot-sub');
    if (sub) sub.textContent = 'Error al iniciar. Revisa la consola.';
  }
});
