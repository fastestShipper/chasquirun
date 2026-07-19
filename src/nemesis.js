// Killa: the llama nemesis. A smug diva who has decided the Qhapaq Nan is her
// personal runway and cannot stand that a round boy in a knitted hat is faster
// than her. She is a persistent passenger on the run, not an obstacle you meet.
//
// API (ARCHITECTURE.md):
//   new Nemesis(scene, killa, hooks) -> { update(dt, ctx), reset(), park(),
//                                         gloat(cause), collide(player), dispose() }
//
// TWO ARCHITECTURAL RULES, both load bearing:
//
// 1. She is parented to the SCENE, in player space alongside the chasqui, and
//    NEVER to worldGroup. Her z is an offset relative to the player (who sits
//    at z ~ 0 while the world scrolls under him). Parenting her to worldGroup
//    would fight chunk recycling and drift toward mutating worldGroup, which
//    is forbidden. The curved-world bend is a per-material view-space vertex
//    effect, not a parent transform, so she bends correctly regardless.
//
// 2. She NEVER goes through track.getColliders(). That pool is a fixed 96
//    entries and silently breaks when full, so pushing her in would drop real
//    obstacle colliders and make actual obstacles pass-through. She owns her
//    own soft-collider test against the player box instead.
//
// THE CENTRAL DESIGN LAW: she randomizes BEFORE the tell and is deterministic
// AFTER it. Once locked, her collider lane and height are frozen for the whole
// approach while she is still free to animate chaotically on top. The player
// reads a chaotic animal and is objectively facing a static obstacle. The
// trolling is a perception layer; the collision is deterministic. Break this
// and the beloved nemesis becomes the reason people uninstall.

import * as THREE from 'three';
import { CONFIG } from './config.js';
import { damp, clamp, lerp } from './util.js';

const LANES = CONFIG.lanes;            // x = -2.2 / 0 / +2.2

// --- Fairness constants -----------------------------------------------------
// The tell is measured in TIME, not distance, so the reaction budget stays
// constant across the whole speed ramp. Derived from real reaction data:
// ~120ms onset detection + ~450ms choice across options + ~60ms motor +
// ~160ms to actually arrive somewhere else. That rounds to 800. Ship at 900.
const TELL_TIME = 0.9;
const TELL_TIME_NEAR_GAP = 1.2;
const FIRST_VISIBLE_Z = -90;    // she may never fade in closer than this
const LOCK_DISTANCE = 38;       // collider frozen inside this range, no exceptions
const MIN_GAP_METERS = 110;     // minimum distance between interventions
// She does not exist before this. No foreshadowing, no HUD hint, nothing on
// the title screen: the first time she appears it should genuinely rattle you.
// The player has had 400 m of a calm, empty road to get comfortable first, and
// her whole system depends on them already owning a baseline read of the track.
const DEBUT_METERS = 420;
const GRACE_AFTER_HIT = 0.6;
const GRACE_NITRO_START = 0.5;

// --- States -----------------------------------------------------------------
const S = {
  ABSENT: 0, DEBUT: 1, ESCORT: 2, TELL: 3, COMMIT: 4,
  RECOVER: 5, TANTRUM: 6, GLOAT: 7, PARKED: 8, FLEE: 9, EXIT: 10, GONE: 11,
};

// --- Stations she idles at (x lane index or side, z offset from player) ------
const STATION = {
  LEFT: { x: -4.2, z: -3.5 },
  RIGHT: { x: 4.2, z: -3.5 },
  AHEAD: { x: 0, z: -16 },
  BEHIND: { x: 3.0, z: 7 },
};

// --- Interventions ----------------------------------------------------------
const I = {
  BLOQUEO: 'bloqueo',      // parks in a lane, soft body, costs coins on contact
  ESCUPITAJO: 'escupitajo',// spits at the lens, costs nothing, pure humiliation
  ATRACO: 'atraco',        // hoovers a coin line ahead of you
  GOLOSA: 'golosa',        // the bait: leads a rich lane that terminates badly
  SIFON: 'sifon',          // siphons your banked Rayo charge
  BURLA: 'burla',          // pure theater, takes nothing, wants you to look
  ROBO: 'robo',            // she goes for the encomienda itself, the real stake
};

// Vocabulary unlocks by distance. She goes physical first, psychological later.
function phaseOf(dist) {
  if (dist < DEBUT_METERS) return null;
  if (dist < 1200) return { name: 'ACOSO', every: [380, 460], attitude: 0.15,
    pool: [I.BLOQUEO, I.BLOQUEO, I.ESCUPITAJO, I.ATRACO] };
  if (dist < 2400) return { name: 'BURLA', every: [280, 340], attitude: 0.4,
    pool: [I.BLOQUEO, I.ESCUPITAJO, I.ATRACO, I.GOLOSA, I.SIFON, I.BURLA] };
  if (dist < 4000) return { name: 'MANADA', every: [210, 250], attitude: 0.7,
    pool: [I.BLOQUEO, I.ROBO, I.ESCUPITAJO, I.ATRACO, I.GOLOSA, I.SIFON, I.BURLA] };
  return { name: 'RABIA', every: [165, 195], attitude: 1,
    pool: [I.BLOQUEO, I.ROBO, I.ATRACO, I.GOLOSA, I.SIFON, I.BURLA, I.ESCUPITAJO] };
}

// WHY SHE DOES ANY OF THIS: she is not malicious and she does not hate him.
// She is a llama, she can smell the bundle on his back, and she is completely
// convinced it is food. Her opening question is a genuine one, "what have you
// got in there, potatoes?", and every escalation after it is just a hungry
// animal being increasingly unreasonable about a snack she has decided exists.
//
// This is funnier than malice and it makes the whole arc cohere: the theft is
// a food raid, and the punchline is that the bundle holds a quipu, which is
// knotted cord and worth nothing at all to a llama.
//
// Her lines are aimed at GUINEO, never at the human holding the keyboard.
const TAUNTS = [
  '¿Seguro que no son papas?',
  'Huele a choclo. No me mientas.',
  'Comparte, pues. Un bocadito.',
  'Yo se que ahi hay comida.',
  'Solo quiero oler. Un poquito.',
  'Corre, corre. El bulto igual es mio.',
  '¿Y si me das la mitad?',
];
const ROASTS = [
  'Descansa. Yo te cuido el bulto.',
  'Se te cayo el encargo. Que pena.',
  'Corriste bonito. Corto, pero bonito.',
  'Ahora si puedo revisar con calma.',
  'Vuelve cuando te crezcan las piernas.',
  'Yo camino mas rapido que eso. Y camino.',
  'Tu chullo era lo mejor de ti.',
  '¿Ves? Debiste compartir.',
];
// When she went home with your things, she thanks you for them.
// She got the bundle and it was, of course, knotted cord. She is still
// pleased with herself, which is the joke.
const ROASTS_ROBBED = [
  'Gracias por la chicha.',
  'No eran papas. Igual me lo quedo.',
  'Puros nudos. Que decepcion.',
  'Dile al Inca que su encargo sabe feo.',
];
// A record does not make her gracious, it makes her furious. Flat delivery,
// one syllable of enthusiasm, which is funnier than an insult.
const ROAST_RECORD = 'Felicidades.';

// Scratch objects. Nothing in update() may allocate.
const _box = new THREE.Box3();
const _min = new THREE.Vector3();
const _max = new THREE.Vector3();

export class Nemesis {
  // hooks: { spit, chuckle, taunt, orgle, stamp, panic, sting, splatter,
  //          toast, steal(n), siphon(), headbutt(dir), portrait(bool) }
  constructor(scene, killa, hooks = {}) {
    this.scene = scene;
    this.k = killa;
    this.h = hooks;
    this.enabled = true;

    scene.add(killa.group);
    killa.group.visible = false;

    // Live pose. x/z are player-relative; the world scrolls, she does not.
    this.x = STATION.LEFT.x;
    this.z = FIRST_VISIBLE_Z;
    this.targetX = this.x;
    this.targetZ = this.z;

    this.state = S.ABSENT;
    this.stateT = 0;
    this.nextAt = DEBUT_METERS;
    this.kind = null;
    this.lockedLane = -1;    // frozen at lock time; -1 means no body in a lane
    this.locked = false;
    this.solid = false;      // soft collider active
    this.hitCd = 0;
    this.sinceHit = 99;
    this.attitude = 0;
    this.tellT = 0;
    this.tellLen = TELL_TIME;
    this.seedCursor = 0;
    this.stolen = 0;         // her stash, feeds the revenge payout
    this.sinceCommit = 99;   // seconds since her last intervention, for attribution
    // Karma: the revenge economy. Wile E. Coyote is beloved because he loses.
    // Target ratio is at least one humiliation per two of her victories, so
    // clean counters have to pay out visibly and often.
    this.karma = 0;
    this.armed = false;
    this.paid = false;       // did the player pay during the current intervention
    this.lastDist = 0;
    this.y = 0;              // hop height; she vaults what she cannot dodge
    this.vy = 0;
    this.hopCd = 0;
    // Vanishing: she gets bored, drops back, and is gone for a while. Her
    // returning has to feel like an event, and it cannot if she never left.
    this.gone = false;
    this.returnAt = 0;
    this.runsSinceExit = 0;
    // The encomienda. A chasqui exists to deliver it, so this is the real
    // stake: coins are what she nibbles, the bundle is what she wants.
    this.hasQipi = false;     // true when SHE is carrying it
    this.fleeT = 0;
    this.lastKind = null;
    this.debutDone = false;
    this.spitPending = -1;

    // Habit model for the RABIA phase. Bounded influence, see _pickLane.
    this.laneUse = [0, 0, 0];
  }

  // Deterministic per-run stream so a seed reproduces a run exactly, which
  // also makes shared-seed screenshots and daily challenges possible later.
  _rnd() {
    this.seedCursor = (this.seedCursor * 1664525 + 1013904223) >>> 0;
    return this.seedCursor / 4294967296;
  }

  reset(seed = 1) {
    this.seedCursor = seed >>> 0;
    this.state = S.ABSENT;
    this.stateT = 0;
    this.nextAt = DEBUT_METERS;
    this.kind = null;
    this.locked = false;
    this.lockedLane = -1;
    this.solid = false;
    this.hitCd = 0;
    this.sinceHit = 99;
    this.attitude = 0;
    this.stolen = 0;
    this.sinceCommit = 99;
    this.karma = 0;
    this.armed = false;
    this.paid = false;
    this.hasQipi = false;
    this.fleeT = 0;
    this.lungeT = -1;
    this.lunged = false;
    this.y = 0; this.vy = 0; this.hopCd = 0;
    this.gone = false;
    this.returnAt = 0;
    this.runsSinceExit = 0;
    if (this.k.setCarry) this.k.setCarry(false);
    this.debutDone = false;
    this.spitPending = -1;
    this.lungeT = -1;
    this.lunged = false;
    this.lastKind = null;
    this.laneUse[0] = this.laneUse[1] = this.laneUse[2] = 0;
    this.x = this.targetX = STATION.LEFT.x;
    this.z = this.targetZ = FIRST_VISIBLE_Z;
    this.k.group.visible = false;
    this.k.setAttitude(0);
    if (this.h.portrait) this.h.portrait(false);
  }

  park() {
    this.state = S.PARKED;
    this.k.group.visible = false;
    this.solid = false;
    if (this.h.portrait) this.h.portrait(false);
  }

  // ---- Survivability -------------------------------------------------------
  // LAW: her lane plus the static colliders may never cover all three lanes.
  // Read the track colliders (READ ONLY, never push) in the band where she is
  // about to commit and count which lanes already have something in them.
  // If taking `lane` would leave the player nowhere to go, she must not take
  // it. When no lane is safe she downgrades to pure theater, because the llama
  // is premium content and obstacles are fungible.
  _laneIsSafe(track, lane, aheadZ) {
    if (!track || !track.getColliders) return true;
    const cols = track.getColliders();
    const zNear = -aheadZ - 14;
    const zFar = -aheadZ + 14;
    let blocked = 0;
    for (let li = 0; li < LANES.length; li++) {
      if (li === lane) { blocked++; continue; }
      const lx = LANES[li];
      for (let i = 0; i < cols.length; i++) {
        const c = cols[i];
        if (c.maxZ < zNear || c.minZ > zFar) continue;
        if (c.maxX < lx - 1.0 || c.minX > lx + 1.0) continue;
        // Anything the player can duck or hop is not a lane blocker.
        if (c.maxY < 1.0 || c.minY > 1.6) continue;
        blocked++;
        break;
      }
    }
    return blocked < LANES.length;
  }

  // Is anything solid sitting at this spot? Read-only pass over the track
  // colliders. She is an animal in the world, not an overlay, so she has to
  // respect the same rocks and walls the player does.
  _blockedAt(track, x, z, pad) {
    if (!track || !track.getColliders) return false;
    const cols = track.getColliders();
    const zw = -z;               // her z is player-relative, colliders are world
    const r = pad === undefined ? 0.75 : pad;
    for (let i = 0; i < cols.length; i++) {
      const c = cols[i];
      if (c.maxZ < zw - 1.3 || c.minZ > zw + 1.3) continue;
      if (c.maxX < x - r || c.minX > x + r) continue;
      if (c.maxY < 0.35) continue;   // low enough that she clears it in stride
      return true;
    }
    return false;
  }

  // Nearest free x to `want`, searching outward. Returns null when boxed in,
  // which is the caller's cue to make her jump instead of slide sideways.
  _freeX(track, want, z) {
    if (!this._blockedAt(track, want, z)) return want;
    for (let step = 1; step <= 4; step++) {
      const d = step * 1.1;
      if (!this._blockedAt(track, want - d, z)) return want - d;
      if (!this._blockedAt(track, want + d, z)) return want + d;
    }
    return null;
  }

  _pickLane(ctx) {
    const p = ctx.playerLane;
    // Base preference: the lane the player is in or drifting toward, because
    // being where they were going is the whole joke.
    const cands = [];
    for (let i = 0; i < LANES.length; i++) cands.push(i);
    // RABIA nudges against habits, capped so it reads as personality and never
    // as an unwinnable read. Blue-shell logic is banned: punishing skill is
    // exactly what stops players pushing for distance.
    let bias = 0;
    if (this.attitude > 0.85) bias = 0.3;
    const total = this.laneUse[0] + this.laneUse[1] + this.laneUse[2] + 1;
    let best = p, bestScore = -1;
    for (const i of cands) {
      let s = i === p ? 1 : 0.45;
      s += bias * (this.laneUse[i] / total);
      s += this._rnd() * 0.5;
      if (s > bestScore) { bestScore = s; best = i; }
    }
    return best;
  }

  // ---- Scheduling ----------------------------------------------------------
  _canStart(ctx) {
    if (ctx.dist < DEBUT_METERS) return false;
    if (this.sinceHit < GRACE_AFTER_HIT) return false;         // no kicking them while down
    if (ctx.nitroT > 0 && ctx.nitroT > CONFIG.intiRay.duration - GRACE_NITRO_START) return false;
    if (!ctx.grounded || ctx.sliding) return false;            // vertical state is sacred
    return true;
  }

  _begin(ctx) {
    const ph = phaseOf(ctx.dist);
    if (!ph) return;
    this.attitude = ph.attitude;
    this.k.setAttitude(ph.attitude);

    let kind = ph.pool[(this._rnd() * ph.pool.length) | 0];
    if (kind === this.lastKind && this._rnd() < 0.6) {
      kind = ph.pool[(this._rnd() * ph.pool.length) | 0];
    }

    // Lane-bodied interventions must prove a survivable line exists first.
    let lane = -1;
    if (kind === I.BLOQUEO || kind === I.GOLOSA || kind === I.ROBO) {
      lane = this._pickLane(ctx);
      if (!this._laneIsSafe(ctx.track, lane, 40)) {
        // Downgrade rather than remove her. La Burla is the safety valve and
        // it is a mechanic, not flavor.
        kind = I.BURLA;
        lane = -1;
      }
    }

    this.kind = kind;
    this.lastKind = kind;
    this.lockedLane = lane;
    this.locked = false;
    this.state = S.TELL;
    this.stateT = 0;
    this.tellT = 0;
    this.tellLen = ctx.nearGap ? TELL_TIME_NEAR_GAP : TELL_TIME;

    // THE LOOK. Her head snaps to camera, ears pin, she smirks. Everything
    // downstream is the player answering this one beat.
    this.k.playPose('look');
    this.k.setEars('flat');
    if (this.h.sting) this.h.sting();
    if (kind === I.BURLA) {
      // The honest tell: taunt stings are major key, real threats are minor.
      if (this.h.taunt) this.h.taunt(this._rnd());
    } else if (this.h.orgle) {
      this.h.orgle();
    }

    // Move out ahead so the commit has somewhere to travel from. A blockade
    // that materialises beside the player is not a blockade, it is an ambush.
    this.targetZ = lane >= 0 ? -34 : -18;
    if (lane >= 0) this.targetX = LANES[lane];
    else this.targetX = this._rnd() < 0.5 ? STATION.LEFT.x : STATION.RIGHT.x;
  }

  _commit(ctx) {
    this.state = S.COMMIT;
    this.stateT = 0;
    this.sinceCommit = 0;
    this.paid = false;
    this.runsSinceExit++;
    const k = this.kind;

    if (k === I.BLOQUEO) {
      // She may only go live from a position the player can still answer. If
      // she never got far enough ahead during the tell, the honest move is to
      // drop the blockade and just taunt: obstacles are fungible, and an
      // unfair hit costs more than a skipped joke.
      if (this.z > -9) {
        this.kind = I.BURLA;
        this.lockedLane = -1;
        this.targetZ = -11;
        this.k.playPose('chuckle');
        if (this.h.chuckle) this.h.chuckle();
        return;
      }
      this.solid = true;                 // soft body: a headbutt, never a death
      this.targetZ = -0.5;               // drifts back into the lane he is in
      this.k.setGait('trot', 1);
    } else if (k === I.ESCUPITAJO) {
      const dur = this.k.playPose('spit');
      // The snap lands at roughly two thirds through the wind-up pose.
      this.spitPending = dur * 0.66;
      this.targetZ = -9;
    } else if (k === I.ATRACO) {
      this.targetZ = -22;
      this.k.setGait('gallop', 1);
      const take = 6 + ((this._rnd() * 7) | 0);
      if (this.h.steal) {
        const got = this.h.steal(take);
        this.stolen += got;
      }
      if (this.h.chuckle) this.h.chuckle();
    } else if (k === I.SIFON) {
      this.targetZ = -8;
      if (this.h.siphon) this.h.siphon();
      if (this.h.chuckle) this.h.chuckle();
    } else if (k === I.GOLOSA) {
      // She trots ahead of the rich lane looking BACK at you. That is the
      // universal follow-me animation and it is the only cue needed, because
      // the payoff is always visible before the player is committed.
      this.targetZ = -26;
      this.k.setGait('trot', 0.8);
      this.k.setLook(Math.PI * 0.92, 0);
    } else if (k === I.ROBO) {
      // The snatch is a LUNGE, not a glide. She commits to ONE lane during the
      // tell, then strikes for a heartbeat. Previously she simply drifted
      // alongside with her collider live, so the theft could not be avoided by
      // playing well, which made it feel like a tax rather than a duel.
      if (this.lockedLane < 0 || this.z > -9) {
        // Never enough room to make it readable: drop it and just taunt.
        this.kind = I.BURLA;
        this.lockedLane = -1;
        this.targetZ = -11;
        this.k.playPose('chuckle');
        if (this.h.chuckle) this.h.chuckle();
        return;
      }
      this.solid = false;         // goes live only at the strike, see update()
      this.lungeT = 0;
      this.lunged = false;
      this.targetZ = -0.6;
      this.k.setGait('gallop', 1);
      this.k.playPose('look');
      this.k.setEars('flat');
      if (this.h.orgle) this.h.orgle();
      if (this.h.toast) this.h.toast('A ver esas papas.');
    } else if (k === I.BURLA) {
      this.targetZ = -11;
      this.k.playPose('chuckle');
      if (this.h.chuckle) this.h.chuckle();
      if (this.h.toast) this.h.toast(TAUNTS[(this._rnd() * TAUNTS.length) | 0]);
    }
  }

  _endIntervention(ctx) {
    // Resolved without paying: that is a clean counter and it earns revenge.
    if (this.kind && !this.paid) this.addKarma(0.34);
    this.paid = false;
    this.solid = false;
    this.locked = false;
    this.lockedLane = -1;
    this.kind = null;
    this.spitPending = -1;
    this.state = S.RECOVER;
    this.stateT = 0;
    this.k.setEars('up');
    this.k.setLook(0, 0);
    this.k.setGait('trot', 0.55);
    const ph = phaseOf(ctx.dist);
    const span = ph ? ph.every : [250, 300];
    const gap = Math.max(MIN_GAP_METERS, lerp(span[0], span[1], this._rnd()));
    this.nextAt = ctx.dist + gap;
    // Drift back to a shoulder station and just keep pace, chewing.
    const side = this._rnd() < 0.5 ? STATION.LEFT : STATION.RIGHT;
    this.targetX = side.x;
    this.targetZ = side.z;
  }

  // ---- Leaving and coming back ---------------------------------------------
  _exit(ctx) {
    this.state = S.EXIT;
    this.stateT = 0;
    this.solid = false;
    this.locked = false;
    this.lockedLane = -1;
    this.kind = null;
    this.runsSinceExit = 0;
    // A dismissive little performance on the way out: she did not lose
    // interest, obviously, she simply has better things to do.
    this.k.playPose('smirk');
    this.k.setEars('mock');
    this.k.setGait('walk', 0.4);
    if (this.h.toast) this.h.toast('Me aburri. Sigue corriendo.');
    this.targetX = this._rnd() < 0.5 ? -9.5 : 9.5;
    this.targetZ = 16;
  }

  _return(ctx) {
    this.gone = false;
    this.state = S.ESCORT;
    this.stateT = 0;
    this.k.group.visible = true;
    this.k.setGait('gallop', 1);
    // She comes back in from a side, at speed, already looking at you.
    this.x = this.targetX = this._rnd() < 0.5 ? -8 : 8;
    this.z = this.targetZ = -22;
    this.k.playPose('look');
    if (this.h.sting) this.h.sting();
    if (this.h.portrait) this.h.portrait(true);
    const ph = phaseOf(ctx.dist);
    this.nextAt = ctx.dist + (ph ? ph.every[0] * 0.5 : 120);
  }

  // ---- The scripted debut --------------------------------------------------
  // Identical every run, costs nothing. This is the free tutorial for the tell
  // grammar and it is the clip people post, so it gets real staging.
  _debut(dt, ctx) {
    this.stateT += dt;
    const t = this.stateT;
    if (t < 0.05) {
      this.k.group.visible = true;
      this.x = STATION.LEFT.x - 3;
      this.z = -14;
      this.k.setGait('gallop', 1);
      if (this.h.sting) this.h.sting();
      if (this.h.portrait) this.h.portrait(true);
    }
    this.targetX = STATION.LEFT.x;
    this.targetZ = -5;
    if (t > 1.1 && t < 1.2) {
      this.k.playPose('look');           // the over-the-shoulder stare
      this.k.setEars('flat');
      if (this.h.orgle) this.h.orgle();
    }
    if (t > 2.0 && t < 2.1) {
      this.k.playPose('spit');
      if (this.h.spit) this.h.spit('left');
      // She misses on purpose. Deliberately wide, no splatter, no cost.
    }
    if (t > 2.9 && t < 3.0) {
      // The question that starts the whole feud. She is not threatening him,
      // she is nosy and hungry and has decided the bundle is lunch.
      if (this.h.toast) this.h.toast('¿Que llevas ahi? ¿Papas?');
    }
    if (t > 3.9 && t < 4.0) {
      this.k.playPose('chuckle');
      if (this.h.chuckle) this.h.chuckle();
      if (this.h.toast) this.h.toast('Yo se que es comida. Lo huelo.');
    }
    if (t > 5.4) {
      this.debutDone = true;
      this._endIntervention(ctx);
    }
  }

  // She went for the bag and got nothing but air. This is the payoff for
  // reading the lane correctly, so it has to be loud: she stumbles, the player
  // banks karma toward the pututu, and she is off your back for a while.
  _missedLunge() {
    this.k.playPose('tantrum');
    this.k.setEars('up');
    this.addKarma(0.4);
    if (this.h.panic) this.h.panic();
    if (this.h.toast) this.h.toast('¡Casi! Se me escapo el almuerzo.');
    if (this.h.dodged) this.h.dodged();
    this.targetZ = 5;
    this.lockedLane = -1;
  }

  // Give the bundle back. `bored` means she got tired of the game rather than
  // being caught, which is a softer beat and a quieter sound.
  dropQipi(bored) {
    if (!this.hasQipi) return false;
    // Give the getaway a moment to read before a recovery can land.
    if (!bored && this.fleeT < 0.9) return false;
    this.hasQipi = false;
    this.fleeT = 0;
    if (this.k.setCarry) this.k.setCarry(false);
    if (this.h.returnQipi) this.h.returnQipi(!bored);
    if (bored) {
      if (this.h.toast) this.h.toast('No se come. Toma tu cosa.');
    } else {
      this.addKarma(0.5);
      if (this.h.panic) this.h.panic();
      if (this.h.toast) this.h.toast('¡Ya! Ni sabia rico igual.');
    }
    this._endIntervention({ dist: this.lastDist });
    return true;
  }

  // ---- Revenge: the pututu --------------------------------------------------
  // Karma fills on clean counters. At full it arms the conch horn Guineo
  // already carries, and the next Rayo press blasts it instead of dashing:
  // Killa panics, trips over her own legs, and vomits her entire stolen stash
  // into a coin fountain the player runs straight through.
  addKarma(v) {
    if (this.armed) return;
    this.karma = clamp(this.karma + v, 0, 1);
    if (this.karma >= 1) {
      this.armed = true;
      if (this.h.armed) this.h.armed(true);
    }
  }

  // Returns the coin payout, or 0 if the horn is not armed.
  blastPututu() {
    if (!this.armed) return 0;
    this.armed = false;
    this.karma = 0;
    if (this.h.armed) this.h.armed(false);
    const payout = this.stolen;
    this.stolen = 0;
    this.state = S.TANTRUM;
    this.stateT = 0;
    this.solid = false;
    this.locked = false;
    this.lockedLane = -1;
    this.k.playPose('tantrum');
    if (this.h.panic) this.h.panic();
    if (this.h.toast) this.h.toast('¡Ay! Mi merienda no.');
    // She is pushed back and humiliated, and the next intervention is delayed
    // so the player gets to enjoy having won for a moment.
    this.targetZ = 9;
    this.nextAt = Math.max(this.nextAt, this.lastDist + 160);
    return payout;
  }

  // ---- Player rammed her with the Rayo -------------------------------------
  // Three stages and the comedy is entirely in the timing of the giving-up.
  nitroRam() {
    if (this.state === S.GLOAT || this.state === S.PARKED) return;
    this.state = S.TANTRUM;
    this.stateT = 0;
    this.solid = false;
    this.k.playPose('tantrum');
    this.k.setEars('up');
    this.addKarma(0.5);
    if (this.h.panic) this.h.panic();
  }

  // LAW: attribution is disclosed. The death cause is named honestly, so a
  // player is never told the llama killed them when the wall did. She still
  // gets to CLAIM it (she appears in frame laughing at crashes she had nothing
  // to do with), which is funnier and also proves she was innocent.
  causeLine(cause) {
    const mine = this.sinceCommit < 2.5;
    if (cause === 'fall') return mine ? 'Killa te dejo sin piso.' : 'Caiste al abismo.';
    if (cause === 'hit') return mine ? 'Killa te empujo al muro.' : 'Chocaste con el camino.';
    return mine ? 'Killa te barrio.' : 'Fin del camino.';
  }

  // ---- Death staging -------------------------------------------------------
  gloat(cause, isRecord) {
    this.state = S.GLOAT;
    this.stateT = 0;
    this.solid = false;
    this.k.group.visible = true;
    if (isRecord) {
      // She reads the number, then applauds with dead eyes.
      this.k.playPose('applaud');
      this.line = ROAST_RECORD;
    } else {
      this.k.playPose('trophy');
      const robbed = this.hasQipi || this.stolen > 0;
      const pool = robbed ? ROASTS_ROBBED : ROASTS;
      this.line = pool[(this._rnd() * pool.length) | 0];
    }
    if (this.h.chuckle) this.h.chuckle();
    return this.line;
  }

  // ---- Soft collider -------------------------------------------------------
  // Hitting Killa is a headbutt, never a death state: shove, coin drop,
  // multiplier break, comedy stagger. At 42 m/s an actor whose whole appeal is
  // unpredictable intent cannot also have lethal touch, because the only
  // rational response to an unpredictable lethal actor is maximum conservative
  // play, which deletes every interesting decision this system creates.
  // Pure overlap test with no side effects. Used by the Rayo ram path, which
  // wants to know she was hit without charging the player for it.
  overlapsPlayer(player) {
    if (player.dead || this.state === S.GLOAT || this.state === S.PARKED) return false;
    if (!this.k.group.visible) return false;
    if (this.z < -3.2 || this.z > 3.2) return false;
    const box = player.getBox();
    _min.set(this.x - 0.62, 0.0, this.z - 0.95);
    _max.set(this.x + 0.62, 1.75, this.z + 0.95);
    _box.min.copy(_min);
    _box.max.copy(_max);
    return box.intersectsBox(_box);
  }

  collide(player) {
    if (!this.solid || this.hitCd > 0 || player.dead) return false;
    if (!this.locked) return false;
    const box = player.getBox();
    _min.set(this.x - 0.62, 0.0, this.z - 0.95);
    _max.set(this.x + 0.62, 1.75, this.z + 0.95);
    _box.min.copy(_min);
    _box.max.copy(_max);
    if (!box.intersectsBox(_box)) return false;

    this.hitCd = 1.1;
    this.sinceHit = 0;
    this.paid = true;

    // During a ROBO the contact is not a shove, it is the theft. She takes the
    // encomienda and runs. The run does NOT end: a chasqui who lost the bundle
    // chases it down, and that inversion (you hunting her) is the point.
    if (this.kind === I.ROBO && !this.hasQipi) {
      // She landed it. Long breather afterwards so a successful theft never
      // chains into another one while the player is still recovering.
      this.nextAt = Math.max(this.nextAt, this.lastDist + 420);
      this.hasQipi = true;
      if (this.k.setCarry) this.k.setCarry(true);
      this.state = S.FLEE;
      this.stateT = 0;
      this.fleeT = 0;
      // Bolt. Without this she is still overlapping him on the very next
      // frame and hands the bundle straight back, which reads as nothing
      // happening at all.
      this.z = -11;
      this.targetZ = -11;
      this.k.setGait('gallop', 1);
      this.solid = false;
      this.locked = false;
      this.lockedLane = -1;
      this.k.playPose('chuckle');
      if (this.h.stealQipi) this.h.stealQipi();
      if (this.h.chuckle) this.h.chuckle();
      if (this.h.toast) this.h.toast('¡Mio! ... ¿Nudos? ¿Puros nudos?');
      return true;
    }
    // Shove them out of her lane, toward whichever side has room.
    let dir = player.x < this.x ? -1 : 1;
    if (player.laneIdx + dir < 0) dir = 1;
    if (player.laneIdx + dir > LANES.length - 1) dir = -1;
    if (this.h.headbutt) this.h.headbutt(dir);
    if (this.h.chuckle) this.h.chuckle();
    this.k.playPose('smirk');
    return true;
  }

  // ---- Main update ---------------------------------------------------------
  update(dt, ctx) {
    if (!this.enabled || this.state === S.PARKED) return;
    if (!(dt > 0)) return;
    if (this.hitCd > 0) this.hitCd -= dt;
    this.sinceHit += dt;
    this.sinceCommit += dt;
    this.lastDist = ctx.dist;

    // Track lane habits for the late-game bias, cheaply.
    if (ctx.playerLane >= 0 && ctx.playerLane < 3) {
      this.laneUse[ctx.playerLane] += dt;
    }

    switch (this.state) {
      case S.ABSENT:
        if (ctx.dist >= DEBUT_METERS && ctx.state === 2) {
          this.state = S.DEBUT;
          this.stateT = 0;
        }
        break;

      case S.DEBUT:
        this._debut(dt, ctx);
        break;

      case S.ESCORT:
      case S.RECOVER: {
        this.stateT += dt;
        if (this.state === S.RECOVER && this.stateT > 1.2) this.state = S.ESCORT;
        // Idle drift between stations so she feels alive rather than pinned.
        if (this.state === S.ESCORT && this.stateT > 4 + this._rnd() * 4) {
          this.stateT = 0;
          const r = this._rnd();
          const st = r < 0.4 ? STATION.LEFT : r < 0.8 ? STATION.RIGHT : STATION.BEHIND;
          this.targetX = st.x;
          this.targetZ = st.z;
          if (this._rnd() < 0.3) this.k.playPose('smirk');
        }
        if (ctx.dist >= this.nextAt && this._canStart(ctx)) {
          // Three or four rounds is enough before she takes a break. Leaving
          // costs her nothing and buys the next entrance real impact.
          if (this.runsSinceExit >= 3 + ((this._rnd() * 2) | 0)) this._exit(ctx);
          else this._begin(ctx);
        }
        break;
      }

      case S.TELL: {
        this.tellT += dt;
        this.stateT += dt;
        // Inside the feint window she may animate arbitrarily: head whipping
        // to the other lane, hooves scrabbling, a fake lunge that leans out of
        // lane. The collider does not move one centimeter, because it is not
        // live yet. This is the bluff layer and it is purely cosmetic.
        if (this.tellT >= this.tellLen) {
          this.locked = true;              // LAW 1: frozen from here on
          this._commit(ctx);
        }
        break;
      }

      case S.COMMIT: {
        this.stateT += dt;
        // Delayed spit snap, so the wind-up actually telegraphs the hit.
        if (this.spitPending >= 0) {
          this.spitPending -= dt;
          if (this.spitPending <= 0) {
            this.spitPending = -1;
            const side = this.x < 0 ? 'left' : 'right';
            if (this.h.spit) this.h.spit(side);
            if (this.h.splatter) this.h.splatter(side);
            if (this.h.chuckle) this.h.chuckle();
          }
        }
        // The lunge: a short live window, then she is committed and can miss.
        if (this.kind === I.ROBO && this.lungeT >= 0) {
          this.lungeT += dt;
          // 0.45 s of wind-up you can still read, then 0.35 s of live strike.
          const striking = this.lungeT > 0.45 && this.lungeT < 0.80;
          this.solid = striking;
          if (this.lungeT >= 0.80 && !this.lunged) {
            this.lunged = true;
            this.solid = false;
            if (!this.hasQipi) this._missedLunge();
          }
        }

        const dur = this.kind === I.BLOQUEO ? 2.5
          : this.kind === I.GOLOSA ? 3.2
          : this.kind === I.BURLA ? 2.2
          : 1.6;
        if (this.stateT >= dur) this._endIntervention(ctx);
        break;
      }

      case S.TANTRUM: {
        this.stateT += dt;
        // She falls behind while she throws her fit, then recovers her dignity.
        this.targetZ = 6;
        this.targetX = this.x < 0 ? STATION.LEFT.x : STATION.RIGHT.x;
        if (this.stateT > 2.8) {
          this.k.setGait('walk', 0.5);
          this._endIntervention(ctx);
        }
        break;
      }

      case S.EXIT: {
        // She saunters off the side of the road and out of the world.
        this.stateT += dt;
        if (this.stateT > 2.6) {
          this.state = S.GONE;
          this.gone = true;
          this.k.group.visible = false;
          this.z = FIRST_VISIBLE_Z;
          if (this.h.portrait) this.h.portrait(false);
          // Long enough that the player relaxes and starts to forget her.
          this.returnAt = ctx.dist + 320 + this._rnd() * 380;
        }
        break;
      }

      case S.GONE: {
        // Genuinely absent: no collider, no sound, nothing on the HUD.
        if (ctx.dist >= this.returnAt) this._return(ctx);
        break;
      }

      case S.FLEE: {
        // She runs ahead with the bundle, weaving between lanes, staying just
        // catchable. This inverts the whole game for a few seconds: the runner
        // becomes the chaser. Touch her (or ram her with the Rayo) to take it
        // back. She taunts on a timer so the pressure is audible.
        this.stateT += dt;
        this.fleeT += dt;
        this.targetZ = -7.5 - Math.sin(this.stateT * 0.9) * 2.5;
        if (this.stateT > 1.4) {
          this.stateT = 0;
          this.targetX = LANES[(this._rnd() * LANES.length) | 0];
          if (this._rnd() < 0.6 && this.h.taunt) this.h.taunt(this._rnd());
        }
        // She never keeps it forever. If the player cannot close the gap she
        // eventually drops it out of sheer boredom, because a permanent loss
        // for a skill the player may not have yet is a quit, not a challenge.
        if (this.fleeT > 14) this.dropQipi(true);
        break;
      }

      case S.GLOAT: {
        this.stateT += dt;
        // Portrait staging: she plants herself beside the fallen chasqui.
        this.targetX = 1.5;
        this.targetZ = 1.2;
        break;
      }
    }

    // ---- Motion --------------------------------------------------------
    // Once locked she is deterministic: her lane snaps to target instantly
    // rather than finishing an interpolation inside the reaction window.
    if (this.locked && this.lockedLane >= 0) {
      this.x = LANES[this.lockedLane];
    } else {
      // Steer around whatever is actually in the world. She is faster and
      // more agile than the player, so she reads the road early and picks a
      // clean line rather than ploughing through a wall.
      let want = this.targetX;
      if (ctx.track && !this.locked) {
        const free = this._freeX(ctx.track, want, this.z - 3);
        if (free !== null) want = free;
      }
      this.x = damp(this.x, want, 4.2, dt);
    }
    this.z = damp(this.z, this.targetZ, 2.6, dt);

    // Vault anything she could not go around, rather than clipping through it.
    if (this.hopCd > 0) this.hopCd -= dt;
    if (this.y <= 0 && this.hopCd <= 0 && ctx.track &&
        this._blockedAt(ctx.track, this.x, this.z - 1.5, 0.6)) {
      this.vy = 7.4;
      this.hopCd = 0.7;
    }
    if (this.vy !== 0 || this.y > 0) {
      this.vy += CONFIG.gravity * dt;
      this.y += this.vy * dt;
      if (this.y <= 0) { this.y = 0; this.vy = 0; }
    }

    // NOTE: no positional clamp here on purpose. She is a persistent on-screen
    // character, not a spawned obstacle, so snapping her z to the lock range
    // would teleport her backward the instant a tell began. LAW 3 is enforced
    // in _commit() instead: she only becomes SOLID once she is safely ahead of
    // the player, and only after the full tell has elapsed.

    // While she is gone, nothing about her runs: no collider, no gait, no look.
    if (this.state === S.GONE) return;

    const g = this.k.group;
    g.position.set(this.x, this.y, this.z);
    // Face the way she travels; in gloat she squares up to the camera.
    if (this.state === S.GLOAT) {
      g.rotation.y = Math.PI * 0.82;
    } else {
      const drift = clamp((this.targetX - this.x) * 0.25, -0.5, 0.5);
      g.rotation.y = damp(g.rotation.y, drift, 5, dt);
    }

    // She keeps pace by definition (she is in player space), so gait speed is
    // driven by the run speed, not by her own displacement.
    if (this.state !== S.TANTRUM && !this.k.isPosing()) {
      this.k.setGait(ctx.speed > 26 ? 'gallop' : 'trot', clamp(ctx.speed / 42, 0, 1));
    }

    // Head aim: she watches the player whenever she is not mid-pose.
    if (!this.k.isPosing() && this.state !== S.GLOAT) {
      const dx = ctx.playerX - this.x;
      const dz = 0 - this.z;
      this.k.setLook(Math.atan2(dx, dz) * 0.85, 0);
    }

    // Drive the carried bundle from state rather than from transitions, so no
    // path can ever leave a ghost bundle stuck in her mouth.
    if (this.k.setCarry) this.k.setCarry(this.hasQipi);

    this.k.update(dt);
    if (this._dbg) this._drawDebug();
  }

  // ---- Debug overlay -------------------------------------------------------
  // Draws her soft collider (green when inert, red when live), the 38 m lock
  // line, and her current state. Without this there is no way to tell a fair
  // build from an unfair one by eye, and the whole system degrades into
  // argument. Toggle with window.__cq.nemesis.setDebug(true).
  setDebug(on) {
    if (on && !this._dbg) {
      const g = new THREE.Group();
      const box = new THREE.Mesh(
        new THREE.BoxGeometry(1.24, 1.75, 1.9),
        new THREE.MeshBasicMaterial({ color: 0x22ff55, wireframe: true, depthTest: false })
      );
      box.position.y = 0.875;
      g.add(box);
      const lockGeo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-6, 0.05, -LOCK_DISTANCE),
        new THREE.Vector3(6, 0.05, -LOCK_DISTANCE),
      ]);
      const lock = new THREE.Line(
        lockGeo,
        new THREE.LineBasicMaterial({ color: 0xff3366, depthTest: false })
      );
      this.scene.add(lock);
      this.scene.add(g);
      this._dbg = { g, box, lock, lockGeo };
      this._dbg.g.renderOrder = 999;
    } else if (!on && this._dbg) {
      this.scene.remove(this._dbg.g);
      this.scene.remove(this._dbg.lock);
      this._dbg.box.geometry.dispose();
      this._dbg.box.material.dispose();
      this._dbg.lockGeo.dispose();
      this._dbg.lock.material.dispose();
      this._dbg = null;
    }
  }

  _drawDebug() {
    const d = this._dbg;
    if (!d) return;
    d.g.visible = this.k.group.visible;
    d.g.position.set(this.x, 0, this.z);
    d.box.material.color.setHex(this.solid && this.locked ? 0xff2222 : 0x22ff55);
  }

  // Live state readout for the debug HUD.
  debugInfo() {
    const names = ['ABSENT', 'DEBUT', 'ESCORT', 'TELL', 'COMMIT', 'RECOVER',
      'TANTRUM', 'GLOAT', 'PARKED', 'FLEE', 'EXIT', 'GONE'];
    return {
      state: names[this.state],
      kind: this.kind,
      lane: this.lockedLane,
      locked: this.locked,
      solid: this.solid,
      z: +this.z.toFixed(1),
      nextAt: Math.round(this.nextAt),
      tell: +this.tellT.toFixed(2),
    };
  }

  dispose() {
    this.setDebug(false);
    this.scene.remove(this.k.group);
    this.k.dispose();
  }
}
