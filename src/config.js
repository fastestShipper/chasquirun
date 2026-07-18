// Central tunables and shared design tokens for Chasqui Run.

export const CONFIG = {
  lanes: [-2.2, 0, 2.2],
  laneChangeTime: 0.16,     // seconds to cross one lane
  chunkLen: 36,             // meters per track chunk
  visibleChunks: 10,        // active chunk count (360 m of world)
  chunkRecycleBehind: 44,   // world z beyond which a chunk recycles

  // Run physics
  baseSpeed: 17.5,          // m/s at start: Olympic-sprinter pace immediately
  maxSpeed: 42,
  accelRampMeters: 2200,    // distance over which speed ramps to max
  gravity: -32,
  jumpVel: 11.8,
  slideTime: 0.8,
  coyoteTime: 0.10,         // grace after leaving an edge
  inputBuffer: 0.14,        // buffered jump/slide before landing

  // Player collision box (half extents), standing
  hitbox: { x: 0.42, yStand: 0.78, ySlide: 0.38, z: 0.35 },

  // Collectibles
  coinValue: 1,
  chakanaValue: 25,
  magnetRadius: 6.5,
  powerupDuration: { inti: 999, wayra: 5.5, quri: 8.0 }, // inti lasts until used
  nitro: { duration: 2.4, cooldown: 20, boost: 0.55 },   // Shift: +55% speed, invulnerable
  powerupEveryMeters: [340, 520],
  chakanaEveryMeters: [380, 640],

  // Difficulty: obstacle action slots per chunk gated by tier
  difficulty: [
    { atMeters: 0,    slots: 1, movers: false, rollerChance: 0 },
    { atMeters: 250,  slots: 2, movers: false, rollerChance: 0 },
    { atMeters: 700,  slots: 2, movers: true,  rollerChance: 0.14 },
    { atMeters: 1400, slots: 3, movers: true,  rollerChance: 0.18 },
    { atMeters: 2400, slots: 3, movers: true,  rollerChance: 0.28 },
    { atMeters: 4000, slots: 3, movers: true,  rollerChance: 0.34 },
    { atMeters: 7000, slots: 3, movers: true,  rollerChance: 0.42 },
  ],

  // Biomes cycle in this order; lengths in chunks
  biomeOrder: ['VALLEY', 'CLIFF', 'PUNA', 'BRIDGE'],
  biomeChunks: { VALLEY: 9, CLIFF: 8, PUNA: 8, BRIDGE: 5 },
  biomeNames: {
    VALLEY: 'Valle Sagrado',
    CLIFF: 'La Cornisa',
    PUNA: 'La Puna',
    BRIDGE: 'El Gran Puente',
  },

  // Shared palette (hex ints for three, strings for canvas/CSS)
  colors: {
    stone: 0x8a8175,
    stoneDark: 0x6e675e,
    grassGreen: 0x5f8a3c,
    punaGold: 0xb89b4a,
    earthBrown: 0x7a5b3a,
    pathTan: 0xa89272,
    waterTeal: 0x2fc9c9,  // Laguna 69 turquoise (glacial rock flour)
    waterDeep: 0x0f8fa0,
    gold: 0xe9b44c,
    coinGold: 0xffcc44,
    ponchoRed: 0xb03a2e,
    accentOrange: 0xd97b29,
    accentYellow: 0xe8c14d,
    accentNavy: 0x2c3e50,
    skinBrown: 0xa8744a,
    hairBlack: 0x241a12,
    tunicWhite: 0xe8e0cf,
    snowWhite: 0xf4f7fa,
    woodBrown: 0x6b4a2c,
    flameOrange: 0xff8c2e,
    skyZenith: 0x2c6bb3,
    skyHorizon: 0xffd9a0,
    fogValley: 0xd9c9a8,
  },

  // Fixed crystal sierra day (the day/night cycle is retired).
  timeOfDayStart: 0.48,
  timeOfDayPerMeter: 0,

  quality: {
    high: { pixelRatioCap: 2, shadows: true, shadowMap: 4096, bloom: true },
    low:  { pixelRatioCap: 1.25, shadows: false, shadowMap: 0, bloom: false },
  },

  cameraShakeCrash: 0.5,
  fov: { base: 64, max: 85 },
};
