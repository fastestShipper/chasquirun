// Chasqui Run: bootstrap, game state machine, main loop.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
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
  if (Q.bloom) {
    // Explicit MSAA target: the composer default has samples:0 and would
    // silently drop the canvas antialiasing.
    const rt = new THREE.WebGLRenderTarget(innerWidth, innerHeight, {
      type: THREE.HalfFloatType,
      samples: 4,
    });
    composer = new EffectComposer(renderer, rt);
    composer.addPass(new RenderPass(scene, camera));
    bloomPass = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.32, 0.55, 0.85);
    composer.addPass(bloomPass);
    // Final grade: gentle vignette + split toning (cool shadows, warm
    // highlights) + a whisper of saturation. One cheap full-screen pass.
    const gradePass = new ShaderPass({
      name: 'GradeShader',
      uniforms: {
        tDiffuse: { value: null },
        uVig: { value: 0.22 },
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
        varying vec2 vUv;
        void main() {
          vec4 color = texture2D(tDiffuse, vUv);
          float d = distance(vUv, vec2(0.5));
          color.rgb *= 1.0 - uVig * smoothstep(0.34, 0.86, d);
          float lum = dot(color.rgb, vec3(0.299, 0.587, 0.114));
          vec3 tint = mix(vec3(0.94, 0.98, 1.05), vec3(1.045, 1.0, 0.95),
                          smoothstep(0.18, 0.72, lum));
          color.rgb *= tint;
          color.rgb = mix(vec3(lum), color.rgb, 1.06);
          gl_FragColor = color;
        }`,
    });
    composer.addPass(gradePass);
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
    nitroT: 0,
    nitroCd: 0,
    nitroBoost: 0,
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

  // ---- UI ----
  const click = () => AudioSys.play('uiClick');
  const ui = new UI(document.getElementById('ui'), {
    onPlay: () => { click(); if (G.state === STATE.MENU) startRun(); },
    onResume: () => { click(); resumeGame(); },
    onRestart: () => { click(); hideAllPanels(); startRun(); },
    onMenu: () => { click(); toMenu(); },
    onPause: () => { click(); pauseGame(); },
    onNitro: () => fireNitro(),
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
    if (G.wayraT > 0 || G.nitroT > 0 || G.boost > 0.25 || G.nitroBoost > 0.25) return;
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
    ui.hideHUD();
  };

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
    G.nitroT = 0;
    G.nitroCd = 0;
    G.nitroBoost = 0;
    G.timeScale = 1;
    G.gameOverShown = false;
    G.isRecord = false;
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

  function finishRun() {
    const best = Save.best;
    const d = Math.floor(G.dist);
    G.isRecord = d > best;
    if (G.isRecord) Save.best = d;
    Save.coins = Save.coins + G.runCoins;
    AudioSys.play('gameOver');
    if (G.isRecord) AudioSys.play('record');
    ui.showGameOver({ dist: d, coins: G.runCoins, best: Math.max(best, d), isRecord: G.isRecord });

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
    else if (action === 'nitro') fireNitro();
  });

  // ---- Resize ----
  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, Q.pixelRatioCap));
    renderer.setSize(innerWidth, innerHeight);
    syncParticleScale();
    if (composer) {
      composer.setPixelRatio(Math.min(devicePixelRatio || 1, Q.pixelRatioCap));
      composer.setSize(innerWidth, innerHeight);
    }
  });

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

  // ---- HUD scratch ----
  const hudPowerups = [];
  const hudNitro = { state: 'ready', t01: 1 };
  const hudData = { dist: 0, coins: 0, mult: 1, powerups: hudPowerups, nitro: hudNitro };

  // ---- Main loop ----
  const clock = new THREE.Clock();
  const charState = { mode: 'menu', speed01: 0, airT: 0, leanX: 0, dead: false };

  function speedNow() {
    const t = clamp(G.dist / CONFIG.accelRampMeters, 0, 1);
    let s = lerp(CONFIG.baseSpeed, CONFIG.maxSpeed, Math.pow(t, 0.8));
    // Wayra and nitro, both eased so speed never steps in a single frame.
    s *= 1 + 0.35 * G.boost + CONFIG.nitro.boost * G.nitroBoost;
    return s;
  }

  function fireNitro() {
    if (G.state !== STATE.RUN || player.dead || G.nitroCd > 0) return;
    G.nitroT = CONFIG.nitro.duration;
    G.nitroCd = CONFIG.nitro.duration + CONFIG.nitro.cooldown;
    AudioSys.play('gust');
    AudioSys.play('whoosh', { vol: 0.7 });
    _fxV.set(player.x, 1.1, 0);
    particles.burst(_fxV, 0x9df2ff, 26);
    rig.shake(0.14);
  }

  function frame() {
    requestAnimationFrame(frame);
    const dtRaw = Math.min(clock.getDelta(), 0.05);
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
    const swp = Math.sin(G.dist * 0.0021) * 0.7 + Math.sin(G.dist * 0.00057 + 2.0) * 0.3;
    Curve.uniforms.uCurveX.value = swp * 2.4e-4;
    Curve.uniforms.uCurveY.value = -1.15e-4 + Math.sin(G.dist * 0.0013 + 1.0) * 5.5e-5;

    G.boost = damp(G.boost, G.state === STATE.RUN && G.wayraT > 0 ? 1 : 0, 6, dtRaw);
    G.nitroBoost = damp(G.nitroBoost, G.state === STATE.RUN && G.nitroT > 0 ? 1 : 0, 8, dtRaw);
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

      // Coins.
      const magnetOn = G.quriT > 0;
      const got = track.coins.update(dt, playerPos, magnetOn, speed * dt * 0.5);
      for (const c of got) {
        G.combo++;
        G.comboT = 1.2;
        G.runCoins += CONFIG.coinValue * (G.wayraT > 0 ? 2 : 1);
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
      if (G.wayraT > 0) G.wayraT -= dt;
      if (G.quriT > 0) G.quriT -= dt;
      if (G.nitroT > 0) G.nitroT -= dt;
      if (G.nitroCd > 0) G.nitroCd -= dt;

      // Permanent crystal sierra daytime; the cycle is retired by request.

      // HUD.
      hudPowerups.length = 0;
      if (G.shield) hudPowerups.push({ kind: 'inti', t01: 1 });
      if (G.wayraT > 0) hudPowerups.push({ kind: 'wayra', t01: G.wayraT / CONFIG.powerupDuration.wayra });
      if (G.quriT > 0) hudPowerups.push({ kind: 'quri', t01: G.quriT / CONFIG.powerupDuration.quri });
      hudData.dist = Math.floor(G.dist);
      hudData.coins = G.runCoins;
      hudData.mult = G.wayraT > 0 ? 2 : 1;
      if (G.nitroT > 0) {
        hudNitro.state = 'active';
        hudNitro.t01 = G.nitroT / CONFIG.nitro.duration;
      } else if (G.nitroCd > 0) {
        hudNitro.state = 'cooldown';
        hudNitro.t01 = 1 - G.nitroCd / (CONFIG.nitro.duration + CONFIG.nitro.cooldown);
      } else {
        hudNitro.state = 'ready';
        hudNitro.t01 = 1;
      }
      hudData.nitro = hudNitro;
      ui.updateHUD(hudData);
    } else if (G.state === STATE.DEAD) {
      track.update(dt, 0); // world halts, ambient anims continue
      player.update(dt, track);
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

    // Atmosphere.
    sky.update(dtRaw, camera, G.dist);
    midground.update(dtRaw, camera);
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
  window.__cq = { G, player, track, sky, AudioSys, startRun, renderer };

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
