# CHASQUI RUN — Architecture Contract

Endless runner (Temple Run style, modernized lane-based) set in the Inca world.
Final product quality: menus, HUD, save data, full procedural Andean music, SFX,
photoreal-leaning stylized visuals. 100% self-contained: NO network requests at
runtime, NO external assets, NO CDN. Everything is generated procedurally
(canvas textures, WebAudio synthesis, primitive-built models).

## Hard rules for every module author

1. Three.js r170, vendored at `lib/three.module.js`. Import ONLY via the import
   map specifiers: `import * as THREE from 'three'` and
   `import { X } from 'three/addons/postprocessing/X.js'`.
2. Plain JavaScript ES modules. NO TypeScript syntax. `package.json` has
   `"type": "module"`, so verify your file with `node --check src/yourfile.js`
   before you finish. It MUST pass.
3. Code, comments, identifiers: English.
4. User-facing UI text: neutral Latin American Spanish ("tú" forms). NEVER
   Argentine voseo ("vos", "che", "dale"). NEVER use em dashes in UI text.
5. Touch ONLY the files you own (see Ownership). Other modules exist or will
   exist; code against the exact APIs in this contract.
6. No `fetch`, no `XMLHttpRequest`, no external URLs, no Google Fonts.
7. Dispose discipline: every module that creates geometries/textures/materials
   at runtime (not shared cached ones) must provide `dispose()` or reuse pools.
8. Performance budget: total draw calls under ~350. Merge static geometry per
   prop where reasonable (`BufferGeometryUtils` is NOT vendored, so merge by
   building single BufferGeometries or use `InstancedMesh` for repeated bits;
   groups of a few meshes per prop are fine). Canvas textures max 1024px.
9. r170 API notes: `renderer.outputColorSpace = THREE.SRGBColorSpace`,
   `texture.colorSpace = THREE.SRGBColorSpace` for color maps,
   `ACESFilmicToneMapping`, `CapsuleGeometry` exists. No deprecated `Geometry`.

## World conventions

- 1 unit = 1 meter. Ground plane y = 0. Player runs toward NEGATIVE Z.
- Lanes at x = -2.2, 0, +2.2 (CONFIG.lanes). Track corridor total width ~7.5.
- The world is grouped under a `worldGroup` that main.js moves toward +Z
  (player stays near z = 0). Chunks are children with fixed local z.
- Camera sits behind player at approx (playerX*0.6, 3.1, 6.4) looking ahead.
- Curved-world illusion: ALL world materials get a view-space vertex bend.
  For MeshStandardMaterial etc. use `applyCurvature(mat)` from
  `src/materials.js`. Custom ShaderMaterials (sky excluded, water included)
  must implement the same bend using the SHARED uniforms
  `Curve.uniforms.uCurveY` / `uCurveX`:

  ```glsl
  vec4 mvPosition = modelViewMatrix * vec4( position, 1.0 );
  mvPosition.y += uCurveY * mvPosition.z * mvPosition.z;
  mvPosition.x += uCurveX * mvPosition.z * mvPosition.z;
  gl_Position = projectionMatrix * mvPosition;
  ```

## File ownership

CORE (owned by the integrator, do not touch):
`index.html`, `src/main.js`, `src/config.js`, `src/util.js`,
`src/materials.js`, `src/track.js`, `src/obstacles.js`, `src/collectibles.js`,
`src/player.js`, `src/camera.js`, `src/input.js`, `src/save.js`.

MODULES (one owner each):
- AUDIO: `src/audio/engine.js`, `src/audio/music.js`, `src/audio/sfx.js`
- CHARACTER: `src/character.js`, `src/animals.js`
- SCENERY: `src/scenery.js`
- ATMOSPHERE: `src/sky.js`, `src/water.js`, `src/particles.js`
- UI: `src/ui.js`, `css/style.css`

## Shared foundation (already written, READ these files)

### src/util.js
`clamp, lerp, damp, smoothstep, mulberry32, randRange, pick, TAU`

### src/config.js
`CONFIG` object: lanes, speeds, physics, palette (`CONFIG.colors`), quality
tiers. Read it. Use `CONFIG.colors.*` tokens instead of inventing hex values.

### src/materials.js (the material/texture factory)
```js
initMaterials(renderer)        // called once by main before anything renders
Curve.uniforms.uCurveY/.uCurveX  // shared curvature uniforms (see above)
applyCurvature(mat) -> mat     // patches a built-in material with the bend
makeMat(opts) -> MeshStandardMaterial  // curvature applied automatically
Tex.masonry(opts) -> {map, bumpMap}  // tiling polygonal Inca masonry
Tex.ashlar(opts) -> {map, bumpMap}   // coursed rectangular stone
Tex.grass() Tex.earth() Tex.gravel() Tex.snow() Tex.thatch() Tex.wood()
Tex.gold() Tex.woven(colors[]) Tex.softCircle(color) Tex.flame()
Mats.stone() Mats.stoneDark() Mats.ashlar() Mats.path() Mats.grass()
Mats.earth() Mats.gold() Mats.coinGold() Mats.wood() Mats.snow()
Mats.thatch() Mats.cloth(colorsArray)   // all cached, curvature applied
```
All `Tex.*` return textures with RepeatWrapping and correct colorSpace.
`Mats.*()` are lazy singletons; `Mats.cloth(colors)` caches per color key.

## Game flow (main.js, for reference)

States: `MENU -> COUNTDOWN -> RUN -> DEAD -> (MENU | COUNTDOWN)`.
Menu shows the live world with the chasqui idling on a start platform.
First user gesture calls `AudioSys.init()`.

---

## MODULE SPECS

### AUDIO (src/audio/engine.js + music.js + sfx.js)

Public API (from `src/audio/engine.js`):
```js
export const AudioSys = {
  init(),                 // create/resume AudioContext; idempotent; safe pre-gesture no-op guard
  resume(),               // resume if suspended (visibility changes)
  startMusic(kind),       // 'menu' | 'game'
  stopMusic(fadeSec = 0.8),
  play(name, opts = {}),  // one-shot SFX, see list
  setAmbience(kind),      // 'valley' | 'puna' | 'citadel' | 'bridge' | 'none'
  duckMusic(seconds),     // sidechain-style dip for big moments
  setMuted(m), get muted state via AudioSys.muted,
  setMusicVol(v), setSfxVol(v),  // 0..1
}
```
Architecture: one AudioContext; master DynamicsCompressor -> destination;
music bus, sfx bus, ambience bus (GainNodes). A generated impulse-response
reverb (2.2 s exponentially decaying noise buffer, Convolver, ~20% wet on
music/sfx sends) for "mountain air". A feedback delay (~0.28 s, fb 0.3) on the
quena lead.

MUSIC (music.js). A real composition, not noodling. Lookahead scheduler
(setInterval 25 ms, schedule 120 ms ahead). Tempo 96 BPM, 2/4 huayno feel.
Key: E minor pentatonic (E G A B D).
Instruments, all synthesized:
- Quena (lead flute): triangle + detuned sine, 5.5 Hz vibrato with delayed
  onset, breath noise (bandpassed white noise envelope), slight portamento,
  expressive note velocities. Range E5-E6.
- Zampona (panpipes): two detuned triangles + bandpassed noise at the
  fundamental, chorused; plays answer phrases and pads.
- Charango: Karplus-Strong plucked strings (noise burst into a feedback
  delay line with lowpass in the loop). Strummed chords (Em, G, Am, C/D),
  huayno strum pattern in 16ths, 5 strings with ~12 ms strum offsets.
- Bombo (bass drum): sine pitch-drop 90->45 Hz + soft noise thump. Strong on
  beat 1, ghost on the offbeat.
- Chajchas (hoof shaker): short bandpassed noise bursts on offbeats.
Structure: intro vamp (2 bars percussion+charango), section A (8 bars quena
melody, a singable huayno-style theme with descending phrase ends), A'
(variation), B (zampona answers + charango arpeggios), percussion breakdown
every 4th cycle. Write the melody as note data arrays, not random picks.
Menu music: sparse rubato quena phrases + soft drone + wind, echo-heavy.
Game-over sting: short descending quena phrase.

SFX (sfx.js), names used by the game:
`jump, slide, footstep (opts.foot 0|1, opts.vol), coin (opts.combo int,
rising pentatonic pitch), chakana, powerup, shieldSave, crash, fall, splash,
whoosh, pututu (conch horn blast, layered sines + formant, 1.2 s), uiClick,
record, gust, llama (comedic bleat)`.
Ambiences are loops built from filtered noise: valley = river + bird chirps,
puna = wind with gusts, citadel = quiet air + faint crackle, bridge = strong
wind + rope creaks. Crossfade between ambiences over ~1.5 s.
All must be safe to call before init() (no-op) and never throw.

### CHARACTER (src/character.js + animals.js)

The star. A young chasqui, stylized-cute (about 4 heads tall, total height
1.55 m), instantly lovable. Origin at feet, faces -Z.

```js
export function buildChasqui() -> {
  group,                    // THREE.Group
  update(dt, state),        // state: {mode, speed01, airT, leanX, dead}
                            // mode: 'idle'|'run'|'jump'|'slide'|'fall'|'menu'
  setMode(mode),            // also called on mode transitions for poses
  onFootstep(cb),           // cb(footIndex) at each foot plant during run
}
```
Design (use CONFIG.colors and Mats/Tex from materials.js):
- Chullo hat (earflap hat) with pompom on top and small pompoms on the flaps,
  woven band pattern (Tex.woven), black hair fringe under it.
- Warm brown skin, big expressive eyes (white sphere + dark brown iris +
  specular highlight dot), eyelids that BLINK every 2-5 s, thick friendly
  eyebrows, subtle smile, rosy cheeks.
- Red poncho (CONFIG.colors.ponchoRed) with woven accent bands; the poncho is
  separate front/back flap meshes that bounce and flare with speed.
- White tunic under, dark shorts, ojota sandals.
- Qipi: striped carrying bundle on the back (the messenger's payload) with a
  cord across the chest. A pututu conch shell hangs at the hip.
- Animations, all procedural (sin-phase based, phase continuity kept):
  run cycle with knee bend and opposite arm swing scaling with speed01,
  torso bob + forward lean, pompom spring-lag wobble, poncho flap;
  jump = tuck with arms back, land squash; slide = lean way back, low;
  fall = tumble forward, limbs loose (comedic but sympathetic);
  idle/menu = breathing, occasional look-around, and a WAVE at the camera
  every ~8 s. Footstep events fire on phase crossings during run.

```js
// animals.js
export function buildLlama({sitting = false} = {}) -> {group, update(dt)}
export function buildAlpaca() -> {group, update(dt)}
export function buildCondor() -> {group, update(dt)}  // flapping; caller positions it
```
Llama: elegant long neck, banana ears that flick, woven saddle blanket, tail
puff, idle chew + neck sway. Sitting variant used as an obstacle. Alpaca:
rounder, fluffier, shorter neck. Condor: 3 m wingspan, white neck ruff,
finger-feather tips, slow majestic flap. Keep each under ~30 meshes.

### SCENERY (src/scenery.js)

Static prop builders, all using Mats/Tex, all cheap, curvature comes free via
shared materials. Every builder returns a `THREE.Group` (or Mesh) with origin
at its base center, +X right, built to be placed by track.js. Set
`castShadow` on large silhouette meshes only, `receiveShadow` on tops.

```js
export function buildTerraces({side, length, tiers = 4}) -> Group
// andenes: stepped agricultural terraces climbing away from the track on
// side (-1 left, +1 right); stone retaining walls (Tex.ashlar), grass tops,
// slight organic curve; occasional maize tufts.
export function buildStoneWall({length, height = 2.2}) -> Group  // polygonal masonry
export function buildGateway() -> Group  // trapezoidal Inca portal spanning the full track (opening wider at base), lintel stone, sits at chunk boundary
export function buildRuin() -> Group     // partial walls with trapezoidal niches
export function buildWatchtower() -> Group // round chullpa-like tower, thatch roof
export function buildRopeBridgeSides(length) -> Group // q'eswachaka style: thick woven side cables, vertical cords, wooden posts; NO deck (track provides planks)
export function buildBrazier() -> Group  // stone bowl; a Sprite flame (Tex.flame) with userData.flicker = true so track can animate opacity/scale
export function buildIchuPatch({count = 60, area = [10, 30]}) -> Group // golden puna grass tufts, InstancedMesh, gentle static lean variance
export function buildFlowers({count = 24, area = [8, 30]}) -> Group // qantu flowers, magenta/red, instanced
export function buildBoulder(scale = 1) -> Mesh
export function buildReeds({count = 20, area = [4, 30]}) -> Group // totora reeds for riverbanks
export function buildChakanaMonument() -> Group // stepped-cross stone monument on a plinth
export function buildMaizePatch({count = 20, area = [6, 20]}) -> Group
```
Aesthetic: tight mortarless joints, trapezoidal openings (Inca signature),
weathered but precise. No cartoon outlines. Vary stone tones subtly.

### ATMOSPHERE (src/sky.js + water.js + particles.js)

```js
export class SkySystem {
  constructor(scene, renderer)
  sunLight   // THREE.DirectionalLight, shadows configured from CONFIG.quality
  hemi       // HemisphereLight
  setTimeOfDay(t)   // 0 dawn .. 0.5 midday .. 0.75 golden hour .. 1 dusk
  setSnowcapNear(f) // 0..1, puna biome pulls the peaks visually closer (subtle)
  update(dt, camera, distance)
  getSunDir(outVec3)
  dispose()
}
```
Owns: giant sky dome (BackSide ShaderMaterial, fog:false, NO curvature) with
3-stop gradient blended between time-of-day keyframes (dawn, noon, golden,
dusk palettes), sun disc + glow sprites (additive, Tex.softCircle), drifting
volumetric-looking cloud sprites, TWO parallax rings of far Andes mountains
with snow caps (vertex colors or shader height mix; they softly follow the
camera), 2-3 ambient condors circling far away (import buildCondor from
animals.js). SkySystem also drives `scene.fog.color` and hemi/sun colors to
match the palette. Default start ~0.68 (late golden morning). main.js slowly
advances time-of-day with distance.

```js
export class WaterSystem {
  constructor()
  makeRiver({width = 8, length = 36}) -> Mesh  // registered for updates
  makeLake({radius = 30}) -> Mesh
  setSunDir(vec3)
  update(dt)
  dispose()
}
```
Custom ShaderMaterial water: 2-3 overlapping sine waves in the vertex shader,
fresnel sky-color blend, sun specular glint, scrolling sparkle noise, teal
Andean glacial color (CONFIG.colors.waterTeal), transparent 0.92. MUST apply
the shared curvature uniforms (see snippet at top).

```js
export class Particles {
  constructor(scene)
  dust(pos, n = 6)          // footfalls, slides, landings
  sparkle(pos, color)       // coin pickups
  burst(pos, color, n)      // powerups, chakana
  debris(pos)               // crash stone bits
  splash(pos)               // water fall-in
  setSnow(on)               // gentle highland snow field around camera
  setMist(on)               // soft river mist sprites
  setEmbers(on)             // citadel brazier ambience
  update(dt, camera)
  dispose()
}
```
Pooled Points/Sprites, additive where it glows, depthWrite false, soft canvas
textures (Tex.softCircle). Budgets: dust 64, sparkle 128, debris 48, snow 600,
mist 10 large sprites, embers 80. Zero allocation per frame.

### UI (src/ui.js + css/style.css)

```js
export class UI {
  constructor(root, cb)
  // cb: {onPlay, onResume, onRestart, onMenu, onMute, onQuality}
  showTitle({best, coins}); hideTitle()
  showHUD(); hideHUD()
  updateHUD({dist, coins, mult, powerups}) // powerups: [{kind, t01}] kind: 'inti'|'wayra'|'quri'
  countdown(done)                          // 3, 2, 1, CORRE with pututu timing
  showGameOver({dist, coins, best, isRecord}); hideGameOver()
  showPause(); hidePause()
  toast(text)                              // small transient message (biome names)
  flashDamage(); flashGold()
  setMuted(m); setQuality(q)               // reflect state on toggles
}
```
`root` is the `#ui` div in index.html; build ALL DOM in JS, style in
css/style.css (already linked). Aesthetic: premium Inca: deep stone browns,
gold (#e9b44c range) borders and accents, chakana (stepped cross) SVG motifs
in corners, CSS-gradient stone texture panels, subtle backdrop-filter blur,
serif display caps (Georgia/'Palatino Linotype' stack, letterspaced), smooth
fade/scale transitions. Fully responsive, touch friendly, safe-area aware.
NO external fonts/images; inline SVG is fine.

Title screen: logotype "CHASQUI RUN" (big, gold, layered text-shadow relief),
subtitle "El mensajero del Inca", primary button "CORRER", best-distance and
total-coin chips, controls hint (arrows/WASD + swipe), mute and quality
toggles, tiny credit line "Hecho con Three.js".
HUD: distance top-center "1 234 m", coins top-right with a small sun icon,
powerup pill timers bottom-center, pause button top-left.
Game over panel: "Fin del camino", stats rows, "¡Nuevo récord!" ribbon when
earned, buttons "Reintentar" and "Menú". Exact Spanish strings, neutral.
Pause: "Pausa", buttons "Reanudar", "Reiniciar", "Menú".
Toasts for biomes: "Valle Sagrado", "La Ciudadela", "La Puna", "El Gran Puente".

---

## Integration notes (core side, FYI)

- track.js builds chunks per biome (VALLEY, CITADEL, PUNA, BRIDGE), calling
  scenery/water/animal builders, and spawns obstacles/coins with fair
  action-spacing based on speed.
- player.js runs lane physics, jump/slide, AABB collision vs track colliders.
- Powerups: inti (shield), wayra (speed burst + brief invulnerable),
  quri (coin magnet).
- Save: localStorage `chasqui.best`, `chasqui.coins`, `chasqui.muted`,
  `chasqui.quality`.
