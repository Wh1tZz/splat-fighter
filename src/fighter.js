// One fighter: a PINOC Gaussian character plus its combat state machine.
//
// Movement comes from the animation itself (root motion): the engine hands us
// the pelvis travel of the playing clip each frame and we move the fighter by
// it, so feet never slide. Walk speed is set by playback rate, not by pushing
// the body around.
import { Character } from '@viggle/splat-engine';
import { Quat, Vec3 } from 'playcanvas';
import { MOVES, COMBOS, STARTERS, TUNING, JUMP, SKILL_INPUT } from './config.js';

const FPS = 30;
// Gaussian copies for afterimages, kept for the moments they mean something:
// a dodge (two) and SHADE's shadow clones (three). Hits use drawn effects.
const GHOSTS = 3;
const DODGE_GHOSTS = 2;

// Strike phases: the wind-up plays a touch slower than the move's speed and
// the active frames snap through faster, so the blow reads as anticipation ->
// impact. After the last hit frame the clip follows through at a natural rate
// for this many clip frames, then blends back to stance (instead of running
// the whole return at ~1.9x, which looked fast-forwarded).
const WINDUP_RATE = 0.95, ACTIVE_RATE = 1.18, FOLLOW_RATE = 0.9;
const FOLLOW_FRAMES = { light: 12, mid: 15, heavy: 18, spin: 21 };

// Additive flinch layered on whatever reaction clip plays: the upper body
// snaps away from the blow on the impact frame, then springs back.
// [bone, lean weight, twist weight]
const FLINCH_HEAD = [['spine_03', 0.12, 0], ['spine_05', 0.22, 0.2], ['neck_01', 0.26, 0.35], ['head', 0.4, 0.45]];
const FLINCH_BODY = [['spine_01', -0.15, 0], ['spine_03', -0.35, 0.15], ['spine_05', -0.25, 0.1], ['head', 0.25, 0]];
const FLINCH_GUARD = [['spine_03', 0.35, 0], ['spine_05', 0.35, 0], ['head', 0.3, 0]];
// limbs whose fast swings leave a trail
const TRAIL_LIMBS = ['hand_l', 'hand_r', 'foot_l', 'foot_r'];
// the bones a smear frame lengthens for each striking fist / foot
const SMEAR_CHAIN = {
  hand_l: ['upperarm_l', 'lowerarm_l'], hand_r: ['upperarm_r', 'lowerarm_r'],
  foot_l: ['thigh_l', 'calf_l'], foot_r: ['thigh_r', 'calf_r'],
};
// bone capsules that hide effects behind a body: [from, to, radius m]
const BODY_CAPSULES = [
  ['pelvis', 'spine_05', 0.17], ['spine_05', 'head', 0.12],
  ['thigh_l', 'calf_l', 0.09], ['calf_l', 'foot_l', 0.07], ['thigh_r', 'calf_r', 0.09], ['calf_r', 'foot_r', 0.07],
  ['upperarm_l', 'lowerarm_l', 0.06], ['lowerarm_l', 'hand_l', 0.05], ['upperarm_r', 'lowerarm_r', 0.06], ['lowerarm_r', 'hand_r', 0.05],
];
const _q = new Quat(), _p = new Quat(), _pi = new Quat(), _t = new Quat(), _ax = new Vec3(), _la = new Vec3();

// Playback rate per looping clip (root speed at 1x was measured: walk_fwd 1.55,
// walk_back 0.79, strafe_left 0.75, strafe_right 1.08 m/s).
const LOOP_RATE = {
  stance: 1.0, walk_fwd: 0.9, walk_back: 1.05, strafe_left: 1.35, strafe_right: 0.95,
  block: 1.0, cheer: 1.0, idle: 1.0,
};

// Loops that only cycle a clean span of their clip [first, last frame]. The
// library "walk_back" opens with the hips turned ~72 degrees and squares up
// over its first 40 frames (its last frames turn the head 64 degrees away),
// so walking backwards visibly spun the body every cycle. Frames 53-113 are
// exactly two steps with matching poses (4 cm apart): a seamless loop.
const LOOP_RANGE = { walk_back: [53, 113] };

// How a state uses the clip's root motion:
//   along: scale on the component toward/away from the opponent
//   side:  scale on the sideways component
//   fwd/back: total travel caps in metres for the whole state
const ROOT = {
  idle:   { along: 1, side: 1, fwd: Infinity, back: Infinity },
  attack: { along: 1, side: 0, fwd: 0.8, back: 0.4 },
  dodge:  { along: 1, side: 0, fwd: 1.6, back: 1.0 },
  hit:    { along: 1, side: 0, fwd: 0.6, back: 0.9 },
  // (thrown: the body is carried by the thrower, the clip's own travel is ignored)
  down:   { along: 1, side: 0, fwd: 0.6, back: 1.4 },
  ko:     { along: 1, side: 0, fwd: 0.4, back: 1.2 },
  getup:  { along: 1, side: 0, fwd: 0.2, back: 0.2 },
  // entrances travel by their own steps (the start is pre-offset, see playIntro)
  intro:  { along: 1, side: 1, fwd: Infinity, back: Infinity },
};

// States whose body heading is corrected from the live pose every frame
// (not 'win': a bow or a cheer is held at its clip's measured facing; chasing
// the head through a bow swung the whole body around)
const LIVE_FACING = new Set(['idle', 'block', 'hit', 'getup', 'intro']);

// Fallback heading corrections (degrees); the game measures every clip at load
// and passes its own table in game.clipHeading.
const CLIP_HEADING = { block: 20, kenji_win: -40, valeria_win: 24 };

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const hexToRgb = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
};

export class Fighter {
  constructor(game, def, slot) {
    this.game = game;
    this.def = def;
    this.slot = slot; // 0 = player, 1 = cpu
    this.color = hexToRgb(def.color);
    // shared move table with this character's signature moves layered on top
    this.moves = { ...MOVES };
    for (const [slotName, mv] of Object.entries(def.moves || {})) this.moves[slotName] = { ...MOVES[slotName], ...mv };
    // hit windows centred on each clip's measured impact frame (see
    // Game.measureClipHeadings): damage lands when the limb is really out
    for (const [slotName, mv] of Object.entries(this.moves)) {
      const f = game.clipImpact?.[mv.clip];
      const reach = game.clipReach?.[mv.clip];
      let m = mv;
      // (a gliding air move keeps its own start: earlier frames are the take-off crouch.
      // A lunging move keeps its authored strike frame: measured standing still,
      // the guard hand brushing the target during the step-in reads as the hit)
      // (`fixedHit`: a move whose wind-up raises the fists past the target first)
      if (f !== undefined && mv.hit && !mv.advance && !mv.fixedHit) m ={ ...m, hit: [f - 3, f + 3], start: mv.glide ? mv.start : Math.min(m.start, Math.max(0, f - 22)) };
      if (reach !== undefined && mv.hit) m = { ...m, reach: clamp(reach, 0.72, 1.75) };
      this.moves[slotName] = m;
    }
    this.x = slot === 0 ? -1.2 : 1.2;
    this.z = 0;
    this.yaw = 0;
    this.clipYaw = 0;
    this.opponent = null;
    this.ghosts = [];
    this.ghostAnims = [];
    this.resetForRound();
  }

  async load(scene) {
    this.character = await Character.load(scene, [this.def.high, this.def.perf], { name: `${this.def.id}_${this.slot}` });
    this.character.disableRenderLod();
    this.character.prepareReveal();
    this.character.setReveal(0);
    const loads = [];
    // (the light tier keeps two: each copy is a whole 16K-splat character)
    const ghosts = this.game.quality === 'low' ? 2 : GHOSTS;
    for (let i = 0; i < ghosts; i++) loads.push(Character.load(scene, this.def.perf, { name: `${this.def.id}_${this.slot}_ghost${i}` }));
    this.ghosts = await Promise.all(loads);
    for (const g of this.ghosts) {
      g.prepareReveal();
      g.setActive(false);
    }
    this.setQuality(this.game.quality);
    this.installFlinch();
    this.play('stance', { loop: true, fade: 0 });
    this.applyTransform(true);
  }

  // ---- procedural flinch -------------------------------------------------
  // A pose modifier runs after the clip is evaluated and before the bones are
  // composed: it rotates spine, neck and head about world axes (away from the
  // blow, and the head turned off a hook), converted into each bone's parent
  // frame. Every hit looks a little different and the impact frame snaps.
  installFlinch() {
    const arm = this.character.armature;
    const names = arm.boneNames, parents = arm.skeleton.parents;
    const resolve = (list) => list.map(([n, lean, twist]) => [names.indexOf(n), lean, twist]).filter(([i]) => i >= 0 && parents[i] >= 0);
    this.flinchSets = { head: resolve(FLINCH_HEAD), body: resolve(FLINCH_BODY), guard: resolve(FLINCH_GUARD) };
    arm.poseModifier = (pose) => {
      const fl = this.flinch;
      if (!fl) return;
      // full on the impact frame, a quick spring back with a small overshoot
      const env = Math.exp(-fl.t * 7.5) * Math.cos(fl.t * 8.5);
      if (fl.t > 0.7) { this.flinch = null; return; }
      for (const [bi, lean, twist] of fl.bones) {
        const m = arm.getBoneWorldMatrix(parents[bi]);
        if (!m) continue;
        _p.setFromMat4(m).normalize();
        _pi.copy(_p).invert();
        const r = pose.rotations[bi];
        if (lean) {
          _ax.set(fl.axis.x, 0, fl.axis.z);
          _pi.transformVector(_ax, _la);
          _q.setFromAxisAngle(_la.normalize(), fl.lean * lean * env);
          _t.mul2(_q, r); r.copy(_t);
        }
        if (twist && fl.twist) {
          _ax.set(0, 1, 0);
          _pi.transformVector(_ax, _la);
          _q.setFromAxisAngle(_la.normalize(), fl.twist * twist * env);
          _t.mul2(_q, r); r.copy(_t);
        }
      }
    };
  }

  // dir: blow direction (attacker -> defender); kind: head | body | guard
  // side: +1 when struck on the right side of the body
  startFlinch(dir, kind, deg, side = 0) {
    // lean axis: up x dir, so a positive angle tips the upper body along the blow
    this.flinch = {
      t: 0, bones: this.flinchSets?.[kind] ?? [], axis: { x: dir.z, z: -dir.x },
      lean: deg, twist: kind === 'head' ? side * deg * 0.9 : kind === 'body' ? side * deg * 0.3 : 0,
    };
  }

  // the body shudders in place through the hitstop freeze (real time)
  hitShake(dur, dir, amp = 1) {
    this.shakeFx = { t: 0, dur, dir, amp };
  }

  // capsules around the body bones (world space), for effect occlusion
  bodyCapsules() {
    const arm = this.character?.armature;
    if (!arm) return [];
    if (!this.capIds) this.capIds = BODY_CAPSULES.map(([a, b, r]) => [arm.boneNames.indexOf(a), arm.boneNames.indexOf(b), r]).filter(([a, b]) => a >= 0 && b >= 0);
    const out = [];
    for (const [a, b, r] of this.capIds) {
      const ma = arm.getBoneWorldMatrix(a), mb = arm.getBoneWorldMatrix(b);
      if (!ma || !mb) continue;
      const pa = ma.getTranslation(), pb = mb.getTranslation();
      out.push([{ x: pa.x, y: pa.y, z: pa.z }, { x: pb.x, y: pb.y, z: pb.z }, r]);
    }
    return out;
  }

  // Fast-moving fists and feet during a strike leave a trail
  sampleTrails(sdt) {
    if (sdt <= 0) return;
    const mv = this.moves[this.move];
    const first = mv.hitFrames ? mv.hitFrames[0] : mv.hit[0];
    const last = mv.hitFrames ? mv.hitFrames.at(-1) : mv.hit[1];
    if (this.moveFrame < first - 9 || this.moveFrame > last + 4) { this.trailPrev = null; return; }
    const arm = this.character.armature;
    if (!this.trailIds) this.trailIds = TRAIL_LIMBS.map((n) => arm.boneNames.indexOf(n));
    const pel = arm.getBoneWorldMatrix(this.pelvisId ??= arm.boneNames.indexOf('pelvis'))?.getTranslation();
    if (!pel) return;
    const prev = this.trailPrev;
    this.trailPrev = [];
    this.trailIds.forEach((bi, j) => {
      const m = bi >= 0 ? arm.getBoneWorldMatrix(bi) : null;
      if (!m) return;
      const p = m.getTranslation();
      const rel = [p.x - pel.x, p.y - pel.y, p.z - pel.z];
      this.trailPrev[j] = rel;
      const q = prev?.[j];
      if (!q) return;
      // speed against the body, in clip time: only a real swing draws
      const v = Math.hypot(rel[0] - q[0], rel[1] - q[1], rel[2] - q[2]) / sdt;
      // (a foot pivoting on the floor is not a kick)
      if (v > 3.0 && p.y > 0.4) this.game.fx.trail(`${this.slot}_${j}`, p.x, p.y, p.z, this.def.color, (j > 1 ? 1.3 : 1) * Math.min(1.4, v / 5) * (mv.special ? 1.6 : 1), this.def.fx);
    });
  }

  destroy() {
    this.character?.destroy();
    for (const g of this.ghosts) g.destroy();
    this.ghosts = [];
  }

  setQuality(q) {
    if (!this.character) return;
    this.character.setRenderLevel(q === 'high' ? 0 : 1);
  }

  get splatCount() {
    return this.character ? this.character.splat.numSplats : 0;
  }

  resetForRound() {
    this.maxHp = this.def.hp;
    this.hp = this.maxHp;
    this.meter = this.meter ?? 0;
    this.state = 'intro';
    this.introPlaying = false;
    if (this.stretches?.size) { this.stretches.clear(); this.character?.armature.setBoneStretch(null); }
    this.flinch = null;
    this.shakeFx = null;
    this.koFreezeAt = undefined;
    this.grabbed = false;
    this.lockedBy = null;
    this.thrownBy = null;
    this.dirLog = [];
    this.stateTime = 0;
    this.move = null;
    this.moveFrame = 0;
    this.moveHits = new Set();
    this.queue = [];
    this.combo = 0;
    this.comboTimer = 0;
    this.flash = 0;
    this.flashColor = { r: 1, g: 1, b: 1 };
    this.push = { x: 0, z: 0, t: 0 };
    this.dodgeCd = 0;
    this.blockStun = 0;
    this.curClip = null;
    this.curLogical = null;
    this.animSpeed = 1;
    this.travel = { fwd: 0, back: 0 };
  }

  placeForRound() {
    this.x = this.slot === 0 ? -1.2 : 1.2;
    this.z = 0;
    this.faceOpponent(1);
    this.character?.consumeRootMotionDelta();
    this.applyTransform(true);
  }

  // Round-one entrance (PINOC clip per character). An entrance can travel
  // (SHADE springs forward ~1.5 m), so the fighter starts back by the clip's
  // own net travel and its steps carry it onto its mark - feet stay planted.
  playIntro() {
    if (!this.def.clips?.intro || !this.game.scene.skeletalAnimationLibrary.has(this.def.clips.intro)) return false;
    this.play('intro', { fade: 0 });
    this.introPlaying = true;
    const t = this.game.clipTravel?.[this.def.clips.intro];
    if (t) {
      const th = this.yaw - (this.headingFor(this.curClip) * Math.PI) / 180;
      const c = Math.cos(th), s = Math.sin(th);
      this.x -= t.dx * c + t.dz * s;
      this.z -= -t.dx * s + t.dz * c;
    }
    this.clipYaw = this.headingFor(this.curClip);
    this.applyTransform(true);
    return true;
  }

  // ---- animation ---------------------------------------------------------
  // `clip` is a logical name (stance, cheer, ...); a character may map it to its own clip
  play(clip, { loop = false, speed, fade = 0.12, start = 0 } = {}) {
    const ch = this.character;
    if (!ch) return;
    const name = this.def.clips?.[clip] ?? clip;
    if (loop && !start && LOOP_RANGE[name]) start = LOOP_RANGE[name][0];
    // loops are played one-shot and re-entered with a crossfade near the end
    // (see updateLoop), so clips that aren't authored seamlessly never pop
    if (fade > 0 && this.curClip) ch.crossfadeTo(name, { duration: fade, loop: false });
    else ch.playAnimation(name, { loop: false });
    if (start) ch.animationTime = start;
    // play/crossfade reset the root-motion routing; we always extract it
    ch.armature.rootMotionMode = 'extract';
    this.skipRoot = 2;
    this.curClip = name;
    this.curLogical = clip;
    this.looping = loop;
    this.clipFrames = this.game.scene.skeletalAnimationLibrary.get(name)?.numFrames ?? 0;
    this.animSpeed = speed ?? LOOP_RATE[clip] ?? 1;
    this.travel = { fwd: 0, back: 0 };
  }

  loopAnim(clip, fade = 0.25) {
    if (this.curLogical !== clip) this.play(clip, { loop: true, fade });
  }

  updateLoop() {
    if (!this.looping || !this.clipFrames) return;
    const base = this.curClip.endsWith('~') ? this.curClip.slice(0, -1) : this.curClip;
    const range = LOOP_RANGE[base];
    if (this.character.animationTime >= (range ? range[1] : this.clipFrames - 10)) {
      // alternate between the clip and its alias: a clip can't crossfade into itself
      const name = this.curClip.endsWith('~') ? base : `${base}~`;
      this.curClip = name;
      this.character.crossfadeTo(name, { duration: range ? 0.2 : 0.3, loop: false });
      if (range) this.character.animationTime = range[0];
      this.character.armature.rootMotionMode = 'extract';
      this.skipRoot = 2;
    }
  }

  // ---- geometry ----------------------------------------------------------
  dirToOpponent() {
    const dx = this.opponent.x - this.x, dz = this.opponent.z - this.z;
    const d = Math.hypot(dx, dz) || 1;
    return { x: dx / d, z: dz / d, dist: d };
  }

  faceOpponent(rate) {
    const d = this.dirToOpponent();
    const target = Math.atan2(d.x, d.z);
    let diff = target - this.yaw;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    this.yaw += diff * clamp(rate, 0, 1);
  }

  facingVec() {
    return { x: Math.sin(this.yaw), z: Math.cos(this.yaw) };
  }

  // the fighter's own right-hand side (facing +Z, the right hand is at -X)
  rightVec() {
    return { x: -Math.cos(this.yaw), z: Math.sin(this.yaw) };
  }

  // World position of the hand/foot closest to a point - where a strike lands
  strikePoint(tx, ty, tz) {
    const arm = this.character.armature;
    if (!this.limbIds) this.limbIds = ['hand_l', 'hand_r', 'foot_l', 'foot_r'].map((n) => arm.boneNames.indexOf(n)).filter((i) => i >= 0);
    let best = null, bd = Infinity;
    for (const i of this.limbIds) {
      const m = arm.getBoneWorldMatrix(i);
      if (!m) continue;
      const t = m.getTranslation();
      const d = (t.x - tx) ** 2 + (t.y - ty) ** 2 + (t.z - tz) ** 2;
      if (d < bd) { bd = d; best = { x: t.x, y: t.y, z: t.z }; }
    }
    return best;
  }

  // Closest touch between this fighter's hands/feet and the opponent's head and
  // torso bones; returns the contact point when within reach, else null
  limbContact(minStep = 0, limbs = null, low = false) {
    const arm = this.character.armature, oa = this.opponent.character.armature;
    // fists and feet, plus elbows and knees for close-range strikes (a move can
    // name its own striking joints, e.g. feet only for the flying kick)
    if (!this.strikeIds) this.strikeIds = ['hand_l', 'hand_r', 'foot_l', 'foot_r', 'lowerarm_l', 'lowerarm_r', 'calf_l', 'calf_r'].map((n) => arm.boneNames.indexOf(n)).filter((i) => i >= 0);
    const ids = limbs ? limbs.map((n) => arm.boneNames.indexOf(n)).filter((i) => i >= 0) : this.strikeIds;
    if (!this.opponent.targetIds) {
      // radii are bone-centre to bone-centre: torso/head half-thickness plus
      // fist/foot size, so a hit registers when skin meets skin
      this.opponent.targetIds = [['head', 0.3], ['neck_01', 0.28], ['spine_05', 0.33], ['spine_03', 0.33], ['pelvis', 0.31]]
        .map(([n, r]) => [oa.boneNames.indexOf(n), r]).filter(([i]) => i >= 0);
      // low attacks (sweeps, leg kicks) also land on the legs
      this.opponent.legTargetIds = [['thigh_l', 0.2], ['thigh_r', 0.2], ['calf_l', 0.16], ['calf_r', 0.16], ['foot_l', 0.14], ['foot_r', 0.14]]
        .map(([n, r]) => [oa.boneNames.indexOf(n), r]).filter(([i]) => i >= 0);
    }
    const targets = low ? [...this.opponent.targetIds, ...this.opponent.legTargetIds] : this.opponent.targetIds;
    // only a joint that is swinging can strike: a guard hand or elbow resting
    // against the opponent at close range is not a blow
    const pel = arm.getBoneWorldMatrix(this.pelvisId ??= arm.boneNames.indexOf('pelvis'))?.getTranslation();
    const prev = this.prevJoints;
    this.prevJoints = new Map();
    let best = null;
    for (const li of ids) {
      const lm = arm.getBoneWorldMatrix(li);
      if (!lm) continue;
      const p = lm.getTranslation();
      if (pel) {
        const rel = [p.x - pel.x, p.y - pel.y, p.z - pel.z];
        this.prevJoints.set(li, rel);
        const q = prev?.get(li);
        if (!q || Math.hypot(rel[0] - q[0], rel[1] - q[1], rel[2] - q[2]) < minStep) continue;
      }
      for (const [ti, r] of targets) {
        const tm = oa.getBoneWorldMatrix(ti);
        if (!tm) continue;
        const t = tm.getTranslation();
        const d = Math.hypot(p.x - t.x, p.y - t.y, p.z - t.z);
        if (d < r && (!best || d - r < best.slack)) best = { x: p.x, y: p.y, z: p.z, slack: d - r };
      }
    }
    return best;
  }

  // How far (m) this fighter's striking joints are from the opponent's body
  // right now, negative when touching - whatever the joints are doing
  // (limbContact counts only joints that are swinging)
  strikeGap(limbs = null, low = false) {
    const arm = this.character.armature, oa = this.opponent.character.armature;
    if (!this.opponent.targetIds) this.limbContact(Infinity, limbs, low); // builds the target lists
    const ids = limbs ? limbs.map((n) => arm.boneNames.indexOf(n)).filter((i) => i >= 0) : this.strikeIds;
    const targets = low ? [...this.opponent.targetIds, ...this.opponent.legTargetIds] : this.opponent.targetIds;
    let gap = Infinity;
    for (const li of ids) {
      const p = arm.getBoneWorldMatrix(li)?.getTranslation();
      if (!p) continue;
      const px = p.x, py = p.y, pz = p.z;
      for (const [ti, r] of targets) {
        const t = oa.getBoneWorldMatrix(ti)?.getTranslation();
        if (t) gap = Math.min(gap, Math.hypot(px - t.x, py - t.y, pz - t.z) - r);
      }
    }
    return gap;
  }

  // The next beat of a multi-blow move (special, clinch knees) still to land
  pendingBeat() {
    const mv = this.state === 'attack' && this.move ? this.moves[this.move] : null;
    if (!mv?.hitFrames || mv.projectile) return null;
    const i = mv.hitFrames.findIndex((_, k) => !this.moveHits.has(k));
    return i < 0 ? null : { i, f: mv.hitFrames[i], mv };
  }

  headingFor(clip) {
    const base = clip?.endsWith('~') ? clip.slice(0, -1) : clip;
    return this.game.clipHeading?.[base] ?? CLIP_HEADING[base] ?? 0;
  }

  // World heading (radians, same convention as yaw) of the torso, from the
  // hip and shoulder lines of the pose the engine evaluated last frame
  bodyHeading() {
    const arm = this.character.armature;
    if (!this.headIds) this.headIds = ['thigh_l', 'thigh_r', 'upperarm_l', 'upperarm_r'].map((n) => arm.boneNames.indexOf(n));
    if (this.headIds.some((i) => i < 0)) return null;
    let sx = 0, sz = 0;
    for (const [l, r] of [[0, 1], [2, 3]]) {
      const ma = arm.getBoneWorldMatrix(this.headIds[l]), mb = arm.getBoneWorldMatrix(this.headIds[r]);
      if (!ma || !mb) return null;
      const a = ma.getTranslation().clone(), b = mb.getTranslation();
      const vx = b.x - a.x, vz = b.z - a.z, len = Math.hypot(vx, vz) || 1;
      sx += vx / len; sz += vz / len;
    }
    return Math.atan2(-sz, sx) + Math.PI;
  }

  // World heading (radians, same convention as yaw) the face looks along: the
  // head bone's first axis
  faceHeading() {
    const arm = this.character.armature;
    if (this.headBone === undefined) this.headBone = arm.boneNames.indexOf('head');
    const m = this.headBone >= 0 ? arm.getBoneWorldMatrix(this.headBone) : null;
    if (!m) return null;
    const d = m.data;
    // a head bowed or ducked looks at the floor: its direction means nothing
    return Math.hypot(d[0], d[2]) > 0.6 ? Math.atan2(d[0], d[2]) : null;
  }

  applyTransform(snap = false) {
    if (!this.character) return;
    let target = this.headingFor(this.curClip);
    // Attacks: turn the body so the striking hand/foot, at its moment of impact,
    // points straight at the opponent. A hook or roundhouse arcs from the side,
    // so lining up the torso would put the blow beside the target.
    let rate = 6;
    let aimed = false;
    if (this.state === 'attack' && this.move) {
      const mv = this.moves[this.move];
      const base = this.curClip?.endsWith('~') ? this.curClip.slice(0, -1) : this.curClip;
      const sy = mv.special ? undefined : this.game.strikeYaw?.[base];
      if (sy !== undefined) { target = sy; rate = 9; aimed = true; }
    }
    // Live correction from the pose while standing, guarding, reeling, and in
    // the wind-up of strikes with no measured aim. Walking keeps the clip's
    // fixed offset: a gait swings the hips every step, and chasing that swing
    // made the whole body twist while moving.
    let live = LIVE_FACING.has(this.state) && !(this.state === 'idle' && this.curLogical !== 'stance');
    if (this.state === 'attack' && this.move && !aimed) {
      const mv = this.moves[this.move];
      live = !mv.spin && !mv.special && this.moveFrame < (mv.hitFrames ? mv.hitFrames[0] : mv.hit[0]);
    }
    if (live && !snap) {
      // standing and guarding keep the FACE on the opponent (a side-on stance
      // turns the hips well away); reeling and wind-ups follow the torso
      const useFace = this.state === 'idle' || this.state === 'intro' || this.state === 'block';
      const h = useFace ? this.faceHeading() : this.bodyHeading();
      if (h !== null) {
        let err = h - this.yaw;
        while (err > Math.PI) err -= Math.PI * 2;
        while (err < -Math.PI) err += Math.PI * 2;
        // bounded: never more than 90 degrees of correction in total
        target = clamp(this.clipYaw + (err * 180) / Math.PI, -90, 90);
        // the head moves with every feint and breath: follow it slowly
        if (useFace) target = this.faceTarget = this.faceTarget === undefined ? target : this.faceTarget + (target - this.faceTarget) * 0.05;
      } else if (useFace && this.faceTarget !== undefined) target = this.faceTarget; // head bowed: hold
    } else this.faceTarget = undefined;
    if (snap) this.clipYaw = target;
    else this.clipYaw += clamp((target - this.clipYaw) * 0.15, -rate, rate); // bounded turn rate
    // hitstop shudder: a fast decaying shake along the blow, a little across it
    let sx = 0, sz = 0;
    const sh = this.shakeFx;
    if (sh && sh.t < sh.dur) {
      const k = 1 - sh.t / sh.dur;
      const a = Math.sin(sh.t * 95) * 0.032 * sh.amp * k, b = Math.sin(sh.t * 71 + 1.3) * 0.014 * sh.amp * k;
      sx = sh.dir.x * a - sh.dir.z * b;
      sz = sh.dir.z * a + sh.dir.x * b;
    }
    this.character.setPosition(this.x + sx, this.lift || 0, this.z + sz);
    this.character.setRotation(0, (this.yaw * 180) / Math.PI - this.clipYaw, 0);
  }

  // Walking glides at the gait's own average speed with a quick ramp up and
  // down. Raw root motion from a walk cycle comes in step-sized bursts, which
  // felt like the fighter stalling for a moment after each key press.
  // Returns true while it is driving the fighter.
  walk(sdt) {
    const mi = this.moveIntent || { fwd: 0, side: 0 };
    const clip = mi.fwd > 0 ? 'walk_fwd' : mi.fwd < 0 ? 'walk_back' : mi.side > 0 ? 'strafe_right' : mi.side < 0 ? 'strafe_left' : null;
    const v = clip ? clamp(this.game.clipSpeed?.[clip] ?? 1, 0.6, 2.2) * this.animSpeed : 0;
    const want = { along: mi.fwd * v, side: mi.fwd ? 0 : mi.side * v };
    const wv = (this.walkVel ??= { along: 0, side: 0 });
    const k = Math.min(1, sdt * 14);
    wv.along += (want.along - wv.along) * k;
    wv.side += (want.side - wv.side) * k;
    if (!clip && Math.hypot(wv.along, wv.side) < 0.02) { wv.along = wv.side = 0; return false; }
    const d = this.dirToOpponent();
    let along = wv.along * sdt;
    const side = wv.side * sdt;
    // never walk into the opponent
    if (along > 0) along = Math.min(along, Math.max(0, d.dist - this.sepLimit));
    this.x += d.x * along - d.z * side;
    this.z += d.z * along + d.x * side;
    return true;
  }

  // Move by the clip's own pelvis travel, filtered for the current state
  applyRootMotion(sdt) {
    const local = this.character.consumeRootMotionDelta();
    // Discontinuities are not travel: right after a clip change (or a loop
    // re-entry) the pelvis jumps from one clip's offset to another's, and the
    // engine reports that jump as one huge step. Drop the first frames after a
    // switch and anything faster than a sprint.
    if (this.state === 'idle' && this.walk(sdt)) { this.skipRoot = Math.max(0, this.skipRoot - 1); return; }
    // a gliding move's travel is all scripted (see updateAttack)
    if (this.state === 'attack' && this.glide) return;
    if (this.skipRoot > 0) { this.skipRoot--; return; }
    const step = Math.hypot(local.dx, local.dz);
    if (step > 7 * Math.max(sdt, 1 / 120) + 0.01) return;
    let rule = ROOT[this.state];
    if (!rule || (!local.dx && !local.dz)) return;
    // lunging strikes (forward + button) carry the body further in
    const adv = this.state === 'attack' && this.move ? this.moves[this.move]?.advance : 0;
    if (adv) rule = { ...rule, fwd: adv };
    // Idle stances shift their weight a little. Applying that sway keeps the
    // feet planted on the floor; a slow running average removes the clip's net
    // drift so the fighter doesn't creep across the arena.
    if (this.state === 'idle' && this.curLogical === 'stance') {
      const k = 0.004;
      this.swayAvg = this.swayAvg || { dx: 0, dz: 0 };
      this.swayAvg.dx += (local.dx - this.swayAvg.dx) * k;
      this.swayAvg.dz += (local.dz - this.swayAvg.dz) * k;
      local.dx -= this.swayAvg.dx;
      local.dz -= this.swayAvg.dz;
    }
    // the delta comes back in the character's own frame (clip forward = +Z);
    // rotate it by the body's world rotation
    const th = this.yaw - (this.clipYaw * Math.PI) / 180;
    const c = Math.cos(th), s = Math.sin(th);
    const dx = local.dx * c + local.dz * s;
    const dz = -local.dx * s + local.dz * c;
    const d = this.dirToOpponent();
    let along = (dx * d.x + dz * d.z) * rule.along;
    const side = (dx * -d.z + dz * d.x) * rule.side;
    // walking keeps the clip's true path (feet stay planted) but never moves
    // against the player's intent: "back" can't drift toward the opponent
    if (this.state === 'idle' && this.moveIntent) {
      if (this.moveIntent.fwd < 0) along = Math.min(along, 0);
      if (this.moveIntent.fwd > 0) along = Math.max(along, 0);
    }
    if (along > 0) {
      along = Math.min(along, rule.fwd - this.travel.fwd);
      // never walk into the opponent
      along = Math.min(along, Math.max(0, d.dist - this.sepLimit));
      this.travel.fwd += Math.max(0, along);
    } else if (along < 0) {
      along = -Math.min(-along, rule.back - this.travel.back);
      this.travel.back += Math.max(0, -along);
    }
    this.x += d.x * along - d.z * side;
    this.z += d.z * along + d.x * side;
  }

  // ---- state -------------------------------------------------------------
  setState(s) {
    // leaving a super (finished, or knocked out of it) lifts its staging
    if (this.superActive && s !== 'attack') { this.superActive = false; this.game.onSuperEnd?.(this); }
    // letting go of a clinch
    if (this.grabbed && s !== 'attack') this.releaseGrab();
    this.state = s;
    this.stateTime = 0;
    if (s !== 'idle') this.walkVel = null;
  }

  // How close the two pelvises may get. Elbows and knees have to step in
  // nearer than the normal spacing to land.
  get sepLimit() {
    if (this.state === 'attack' && this.move) {
      const mv = this.moves[this.move];
      if (mv.reach < TUNING.minSep) return Math.max(0.72, mv.reach - 0.04);
      // a flurry's short blows (elbows, knees) are thrown from close in
      if (mv.hitFrames && !mv.projectile) return 0.72;
    }
    // held in a super or clinch: kept where the blows land
    if (this.lockedBy?.holding) return 0.72;
    return TUNING.minSep;
  }

  get isFree() {
    return this.state === 'idle';
  }

  get invulnerable() {
    if (this.state === 'dodge') return this.stateTime < TUNING.dodgeInvuln;
    // a super can't be stuffed: invincible until its first blow comes out
    if (this.state === 'attack' && this.move === 'special') return this.moveFrame < this.moves.special.hitFrames[0];
    // anti-air skills (dragon fist, flying knee) and SHADE's phasing slash pass
    // through blows on the way up: invuln = true (until the strike) or a frame
    if (this.state === 'attack' && this.move) {
      const mv = this.moves[this.move];
      if (mv.invuln && this.moveFrame < (mv.invuln === true ? mv.hit[0] : mv.invuln)) return true;
    }
    return this.state === 'down' || this.state === 'getup' || this.state === 'ko' || this.state === 'intro' || this.state === 'win' || this.state === 'thrown';
  }

  // holding the opponent in place: a super that connected, or a clinch
  get holding() {
    return this.superActive || (this.state === 'attack' && !!this.grabbed);
  }

  releaseGrab() {
    this.grabbed = false;
    const o = this.opponent;
    if (o?.lockedBy === this && !this.superActive) o.lockedBy = null;
  }

  // Which skill an input asks for: the O / Y keys, back-then-forward + J / U,
  // or J while holding the guard (throw). Null when none.
  skillFor(input) {
    if (input.skill1 && this.moves.skill1) return 'skill1';
    if (input.skill2 && this.moves.skill2) return 'skill2';
    // key combinations: S + J / S + U for the skills, W + J to throw
    if (input.down && input.P && this.moves.skill1) return 'skill1';
    if (input.down && input.K && this.moves.skill2) return 'skill2';
    if (input.up && input.P && this.moves.throw) return 'throw';
    if ((input.P || input.K) && this.motionDone()) return input.P ? 'skill1' : 'skill2';
    if (input.P && input.block && this.moves.throw) return 'throw';
    return null;
  }

  // back, then forward, within the window, and the button just after: consumed
  motionDone() {
    const log = this.dirLog;
    if (!log || log.length < 2) return false;
    const f = log[log.length - 1], b = log[log.length - 2];
    if (!(f.d > 0 && b.d < 0 && f.t - b.t <= SKILL_INPUT.window && this.inputClock - f.t <= SKILL_INPUT.hold)) return false;
    log.length = 0;
    return true;
  }

  // the defender's side of a throw: lifted and flipped by the thrower, landing
  // on the slam frame (`secs` from now), then up again with the clip's own getup
  beThrown(by, secs) {
    this.queue.length = 0;
    this.move = null;
    this.setState('thrown');
    this.thrownBy = by;
    this.lockedBy = by;
    this.slammed = false;
    const from = 8, land = 24;
    this.play('thrown', { fade: 0.08, start: from, speed: clamp((land - from) / Math.max(0.1, secs * FPS), 0.5, 2.2) });
    this.yaw = Math.atan2(by.x - this.x, by.z - this.z);
  }

  startMove(name) {
    const mv = this.moves[name];
    if (!mv) return;
    if (mv.special) {
      if (this.meter < TUNING.meterMax) return;
      this.meter = 0;
    }
    const fromNeutral = this.state !== 'attack';
    this.chained = !fromNeutral;
    if (this.grabbed) this.releaseGrab();
    this.grabMissed = false;
    this.move = name;
    this.moveFrame = mv.start;
    this.moveHits.clear();
    this.prevJoints = null;
    // gliding moves: cover just the gap to striking range, no more
    this.glide = null;
    if (mv.glide) {
      const span = Math.max(1, mv.hit[0] + 2 - mv.start);
      this.glide = { total: clamp(this.dirToOpponent().dist - (mv.reach - 0.12), 0, mv.glide + (this.carry || 0)), span };
    }
    this.setState('attack');
    // longer blend into the strike when coming from neutral; quick when chaining a combo
    this.play(mv.clip, { loop: false, speed: mv.speed * this.def.speed, fade: fromNeutral ? 0.17 : 0.11, start: mv.start });
    // a skill calls its name
    if (name === 'skill1' || name === 'skill2') this.game.callout?.(this, this.def.moveNames?.[name] || '');
    if (mv.special) {
      this.superActive = true;
      this.superLanded = false;
      this.superCharged = false;
      this.superT = 0;
      this.afterT = 0;
      this.game.onSpecialStart(this);
    }
  }

  // ---- bone stretch: anime smear frames, hit squash, power swell -------------
  // Each effect scales a few bones for a moment. Stretch is set once and
  // cleared once (~0.5 ms per call), so it costs next to nothing per frame -
  // which is why these, not post-processing, carry the impact on old machines.
  // Timed in real time: a smear holds through the hitstop freeze.
  stretch(key, factors, dur) {
    (this.stretches ??= new Map()).set(key, { factors, t: dur });
    this.applyStretch();
  }

  applyStretch() {
    const all = {};
    for (const s of this.stretches.values()) {
      for (const [bone, f] of Object.entries(s.factors)) {
        // where two effects touch the same bone, multiply them
        const o = all[bone] || { along: 1, width: 1, thickness: 1 };
        all[bone] = { along: o.along * (f.along ?? 1), width: o.width * (f.width ?? 1), thickness: o.thickness * (f.thickness ?? 1) };
      }
    }
    this.character.armature.setBoneStretch(Object.keys(all).length ? all : null);
  }

  updateStretch(dt) {
    if (!this.stretches?.size) return;
    let changed = false;
    for (const [k, s] of this.stretches) { s.t -= dt; if (s.t <= 0) { this.stretches.delete(k); changed = true; } }
    if (changed) this.applyStretch();
  }

  // the fist or foot nearest a point - the one that struck
  strikingLimb(p) {
    let best = null, bd = Infinity;
    for (const n of Object.keys(SMEAR_CHAIN)) {
      const q = this.bonePos(n);
      if (!q) continue;
      const d = (q.x - p.x) ** 2 + (q.y - p.y) ** 2 + (q.z - p.z) ** 2;
      if (d < bd) { bd = d; best = n; }
    }
    return best;
  }

  // smear frame: the striking limb shoots out longer for the instant of impact
  smear(limb, amount, dur) {
    const chain = SMEAR_CHAIN[limb];
    if (!chain) return;
    this.stretch('smear', { [chain[0]]: { along: 1 + amount * 0.5 }, [chain[1]]: { along: 1 + amount, width: 1 - amount * 0.25, thickness: 1 - amount * 0.25 } }, dur);
  }

  // the body folds under a heavy blow, then springs back
  squash(amount, dur) {
    const s = { along: 1 - amount, width: 1 + amount * 0.8, thickness: 1 + amount * 0.8 };
    this.stretch('squash', { spine_03: s, spine_04: s, spine_05: { along: 1 - amount * 0.5, width: 1 + amount * 0.5, thickness: 1 + amount * 0.5 } }, dur);
  }

  // world position of a named bone (null if the rig lacks it)
  bonePos(name) {
    const arm = this.character?.armature;
    const i = arm ? arm.boneNames.indexOf(name) : -1;
    const m = i >= 0 ? arm.getBoneWorldMatrix(i) : null;
    if (!m) return null;
    const t = m.getTranslation();
    return { x: t.x, y: t.y, z: t.z };
  }

  // first strike for a button and direction: forward/back variants when this
  // fighter has one, else the plain move
  starterFor(b, fwd) {
    const st = { ...STARTERS, ...(this.def.starters || {}) };
    const key = fwd > 0 ? `f${b}` : fwd < 0 ? `b${b}` : b;
    const name = st[key];
    return name && this.moves[name] ? name : st[b];
  }

  // combo route out of `move` for a press (direction-specific routes first)
  nextInCombo(move, b, fwd) {
    const routes = (this.def.combos || COMBOS)[move];
    if (!routes) return null;
    const name = (fwd > 0 && routes[`f${b}`]) || (fwd < 0 && routes[`b${b}`]) || routes[b];
    return name && this.moves[name] ? name : null;
  }

  startDodge(forward) {
    if (this.dodgeCd > 0) return;
    this.dodgeCd = this.def.dodgeCooldown ?? TUNING.dodgeCooldown;
    this.setState('dodge');
    this.dodgeForward = forward;
    if (forward) this.play('roll', { speed: 1.25, fade: 0.08 });
    else this.play('backstep', { speed: 1.35, fade: 0.08 });
    this.dodgeDur = forward ? 32 / FPS / 1.25 : 28 / FPS / 1.35;
    this.ghostTimer = 0;
    this.ghostIndex = 0;
    this.game.onDodge(this);
  }

  // Jump straight up, or forward/back while holding a direction. The PINOC
  // clips jump in place; the game carries the body across the airborne frames.
  startJump(dir) {
    const j = JUMP[dir > 0 ? 'fwd' : dir < 0 ? 'back' : 'up'];
    this.jump = { ...j, frame: j.start };
    this.arc = null;
    this.setState('jump');
    this.play(j.clip, { loop: false, speed: j.speed * this.def.speed, fade: 0.1, start: j.start });
  }

  updateJump(dt, input) {
    const j = this.jump;
    const prev = j.frame;
    const rate = FPS * j.speed * this.def.speed;
    j.frame += dt * rate;
    // extra height: a smooth arc from just before take-off to just after
    // landing, carried on into a flying kick
    if (!this.arc && j.lift && j.frame >= j.air[0] - 2) this.arc = { t: 0, dur: (j.air[1] - j.air[0] + 6) / rate, h: j.lift };
    // travel spread from the take-off push to the landing, not just the
    // airborne frames: squeezed into those it looked like a lunge
    const t0 = j.air[0] - 4, t1 = j.air[1] + 4;
    const a = Math.max(prev, t0), b = Math.min(j.frame, t1);
    if (j.travel && b > a) {
      const d = this.dirToOpponent();
      let along = (j.travel * (b - a)) / (t1 - t0);
      if (along > 0) along = Math.min(along, Math.max(0, d.dist - this.sepLimit));
      this.x += d.x * along; this.z += d.z * along;
    }
    // punch or kick in the air: flying kick, carrying the jump's remaining travel
    if ((input.K || input.P) && j.frame >= j.air[0] - 4 && j.frame < j.air[1] - 2) {
      this.carry = Math.max(0, (j.travel * (t1 - Math.max(j.frame, t0))) / (t1 - t0));
      this.startMove('jump_kick');
      this.carry = 0;
      return;
    }
    if (j.frame >= j.end) {
      this.jump = null;
      this.setState('idle');
      this.loopAnim('stance', 0.2);
    }
  }

  // ---- per-frame ---------------------------------------------------------
  update(dt, input) {
    const ts = this.game.timeScale;
    const sdt = dt * ts;
    this.stateTime += sdt;
    this.inputClock = (this.inputClock || 0) + sdt;
    // direction changes, for back-then-forward skill inputs
    if (input.fwd !== this.lastFwd) {
      this.lastFwd = input.fwd;
      if (input.fwd) {
        (this.dirLog ??= []).push({ d: input.fwd, t: this.inputClock });
        if (this.dirLog.length > 4) this.dirLog.shift();
      }
    }
    this.updateStretch(dt);
    if (this.shakeFx) { this.shakeFx.t += dt; if (this.shakeFx.t >= this.shakeFx.dur) this.shakeFx = null; }
    // the flinch holds its impact pose through the freeze, then springs back
    if (this.flinch) this.flinch.t += sdt;
    this.dodgeCd = Math.max(0, this.dodgeCd - sdt);
    this.comboTimer -= sdt;
    if (this.comboTimer <= 0) this.combo = 0;

    this.applyRootMotion(sdt);

    if (this.arc) {
      this.arc.t += sdt;
      const p = this.arc.t / this.arc.dur;
      this.lift = p >= 1 ? 0 : this.arc.h * Math.sin(Math.PI * p);
      if (p >= 1) this.arc = null;
    } else this.lift = 0;

    // short block push (the block clip has no travel of its own)
    if (this.push.t > 0) {
      const k = Math.min(1, sdt / this.push.t);
      this.x += this.push.x * k; this.z += this.push.z * k;
      this.push.x *= 1 - k; this.push.z *= 1 - k;
      this.push.t = Math.max(0, this.push.t - sdt);
    }

    switch (this.state) {
      case 'idle': this.updateFree(sdt, input); break;
      case 'block': this.updateBlock(sdt, input); break;
      case 'attack': this.updateAttack(sdt, input); break;
      case 'dodge': this.updateDodge(sdt); break;
      case 'jump': this.updateJump(sdt, input); break;
      case 'hit':
        // caught in a super: the stagger lasts until the sequence lets go, and
        // the body is held at the attacker's arm's length
        if (this.lockedBy?.holding) {
          this.stateTime = Math.min(this.stateTime, this.hitDur * 0.6);
          const a = this.lockedBy, d = a.dirToOpponent();
          // held at the distance the attacker's NEXT blow actually reaches: drawn
          // in toward a short elbow, let out for a long kick (a fixed 0.95 m
          // left half the blows of some supers striking the air)
          const beat = a.pendingBeat();
          let want = 0.95;
          if (beat && a.moveFrame >= beat.f - 12) want = clamp(d.dist - a.strikeGap(beat.mv.limbs, beat.mv.low) - 0.04, 0.72, 1.3);
          this.holdDist = (this.holdDist ?? d.dist) + (want - (this.holdDist ?? d.dist)) * Math.min(1, sdt * 8);
          const k = Math.min(1, sdt * 10), keep = this.holdDist;
          this.x += (a.x + d.x * keep - this.x) * k;
          this.z += (a.z + d.z * keep - this.z) * k;
        } else if (this.stateTime >= this.hitDur) { this.lockedBy = null; this.holdDist = undefined; this.setState('idle'); this.loopAnim('stance', 0.3); }
        break;
      case 'down':
        if (this.stateTime >= (this.downDur ?? 39 / FPS + 0.7)) {
          this.setState('getup');
          this.play('getup', { speed: 1.2, fade: 0.2 });
        }
        break;
      case 'getup':
        if (this.stateTime >= 50 / FPS / 1.2) { this.setState('idle'); this.loopAnim('stance', 0.35); }
        break;
      case 'thrown': {
        // carried in front of the thrower until the slam, then the clip lies,
        // rolls and gets up on its own
        const a = this.thrownBy;
        if (!this.slammed && a) {
          const d = a.dirToOpponent(), k = Math.min(1, sdt * 12), keep = 0.95;
          this.x += (a.x + d.x * keep - this.x) * k;
          this.z += (a.z + d.z * keep - this.z) * k;
        }
        if (this.character.animationTime >= this.clipFrames - 5) {
          this.lockedBy = null; this.thrownBy = null;
          this.setState('idle'); this.loopAnim('stance', 0.3);
        }
        break;
      }
      case 'intro':
        // the entrance ends in the fighter's stance: blend into its loop
        if (this.introPlaying && this.character.animationTime >= this.clipFrames - 12) {
          this.introPlaying = false;
          this.loopAnim('stance', 0.4);
        }
        break;
      default: break;
    }

    // keep facing the opponent; attacks track hard until the strike lands
    if (this.state === 'attack') {
      const mv = this.moves[this.move];
      const lastHit = mv ? (mv.hitFrames ? mv.hitFrames.at(-1) : mv.hit[1]) : 0;
      this.faceOpponent(Math.min(1, sdt * (this.moveFrame < lastHit ? 9 : 3)));
    } else if (this.state !== 'ko' && this.state !== 'down' && this.state !== 'thrown') {
      this.faceOpponent(Math.min(1, sdt * 12));
    }
    this.resolveSpacing(sdt);
    this.updateLoop();

    // hit flash fades out (a super glows instead, see updateSuperFx)
    this.flash = Math.max(0, this.flash - dt * 3.5);
    if (this.superActive) this.updateSuperFx(dt);
    else this.character.setTint(this.flash, this.flashColor);

    // animation speed follows the global time scale (hitstop, slow motion, photo mode)
    let speed = this.animSpeed;
    // lie still once the fall has landed
    if (this.state === 'down' && this.character.animationTime >= (this.game.clipLanding?.[this.curClip] ?? 38)) speed = 0;
    if (this.state === 'ko' && this.character.animationTime >= (this.koFreezeAt ?? this.clipFrames - 2)) speed = 0;
    this.character.playbackSpeed = speed * ts;

    this.updateGhosts(dt);
    this.applyTransform();
  }

  updateFree(dt, input) {
    if (input.special && this.meter >= TUNING.meterMax) return this.startMove('special');
    const skill = this.skillFor(input);
    if (skill) return this.startMove(skill);
    // W + U: the spinning kick straight from neutral (otherwise a combo ender)
    if (input.up && input.K && this.moves.spin_kick) return this.startMove('spin_kick');
    if (input.dodge) return this.startDodge(input.fwd > 0);
    if (input.jump) return this.startJump(input.fwd);
    // a press made in the last moments of a previous strike starts the next one
    let P = input.P, K = input.K, fwd = input.fwd;
    if (!P && !K && this.queue.length) {
      const q = this.queue.shift();
      this.queue.length = 0;
      if (this.inputClock - q.t < 0.25) {
        if (q.skill) return this.startMove(q.skill);
        P = q.b === 'P'; K = q.b === 'K'; fwd = q.fwd;
      }
    }
    if (P || K) return this.startMove(this.starterFor(P ? 'P' : 'K', fwd));
    if (input.block) {
      this.setState('block');
      this.play('block', { loop: true, fade: 0.1 });
      return;
    }
    // walking is root motion: pick the clip, set its rate, the feet do the rest
    this.moveIntent = { fwd: input.fwd, side: input.fwd ? 0 : input.side };
    let clip = 'stance';
    if (input.fwd > 0) clip = 'walk_fwd';
    else if (input.fwd < 0) clip = 'walk_back';
    else if (input.side > 0) clip = 'strafe_right';
    else if (input.side < 0) clip = 'strafe_left';
    this.loopAnim(clip, 0.22);
    this.animSpeed = (LOOP_RATE[clip] ?? 1) * (clip === 'stance' ? 1 : this.def.speed);
  }

  updateBlock(dt, input) {
    this.blockStun = Math.max(0, this.blockStun - dt);
    // J while holding the guard: throw
    if (input.P && this.blockStun <= 0 && this.moves.throw) return this.startMove('throw');
    // after the guard jolt, settle back into the held guard
    if (this.guardHitT > 0) {
      this.guardHitT -= dt;
      if (this.guardHitT <= 0) this.play('block', { loop: true, fade: 0.15 });
    }
    if (!input.block && this.blockStun <= 0) {
      this.setState('idle');
      this.loopAnim('stance', 0.2);
    }
  }

  updateAttack(dt, input) {
    const mv = this.moves[this.move];
    const lastHit = mv.hitFrames ? mv.hitFrames.at(-1) : mv.hit[1];
    const firstHit = mv.hitFrames ? mv.hitFrames[0] : mv.hit[0];
    // grounded single strikes: anticipation -> snap -> natural follow-through
    // (flying kicks and specials keep their own timing: they're choreographed)
    const phased = !mv.hitFrames && !mv.glide;
    let rate;
    if (this.moveFrame > lastHit) rate = phased ? mv.speed * FOLLOW_RATE : (mv.recover ?? mv.speed);
    else if (!phased) rate = mv.speed;
    else rate = mv.speed * (this.moveFrame >= firstHit - 3 ? ACTIVE_RATE : WINDUP_RATE);
    const sp = rate * this.def.speed;
    this.animSpeed = sp;
    const advance = dt * FPS * sp;
    this.moveFrame += advance;
    this.sampleTrails(dt);

    // the flying kick sails the distance worked out at take-off, evenly over
    // its wind-up (the PINOC clip kicks in place)
    if (this.glide && this.moveFrame < mv.hit[0] + 2) {
      const d = this.dirToOpponent();
      // never faster than a jumping dive (3.2 m/s): from too far, it falls short
      const along = Math.min((this.glide.total * advance) / this.glide.span, 3.2 * dt, Math.max(0, d.dist - this.sepLimit));
      this.x += d.x * along; this.z += d.z * along;
    }

    // step in during the wind-up when the target stands just beyond this
    // blow's reach, so it lands on the body instead of the air in front of it
    // (a lunging move covers up to its own `advance`, and faster)
    if (!mv.glide && !mv.hitFrames && !this.moveHits.has(0) && this.moveFrame < (mv.advance ? mv.hit[1] : mv.hit[0])) {
      const d = this.dirToOpponent();
      // a follow-up in a string chases further: the last blow pushed them back.
      // After a blow that landed, the next one always reaches (a combo that
      // connects shouldn't drop on the defender's pushback): it closes to a
      // sure distance rather than the edge of its measured reach
      const confirmed = this.chained && this.combo > 0 && this.comboTimer > 0;
      const want = Math.max(this.sepLimit, confirmed ? Math.min(mv.reach - 0.06, 0.95) : mv.reach - 0.06);
      const chase = this.chained ? (confirmed ? 1.2 : 0.9) : 0.5;
      if (d.dist > want && d.dist < want + Math.max(chase, mv.advance || 0)) {
        const step = Math.min(d.dist - want, (mv.advance ? 4.5 : 2.4) * dt);
        this.x += d.x * step; this.z += d.z * step;
      }
    }

    // strike windows
    // a super's power-up pose: time stops there (see Game.onSuperCharge)
    if (mv.special && !this.superCharged && this.moveFrame >= (mv.charge ?? 0)) {
      this.superCharged = true;
      this.game.onSuperCharge(this);
    }
    // a skill's element streams off the limbs that carry it
    if (mv.aura && this.moveFrame < lastHit + 4) {
      const pts = mv.aura.map((n) => this.bonePos(n)).filter(Boolean);
      this.game.fx.aura(this.def.fx, pts, this.def.color, dt * (mv.auraBurst && this.moveFrame >= firstHit - 8 ? 1.2 : 0.45));
    }
    if (mv.hitFrames) {
      // the opening blow of a flurry: step in when the target stands just out of
      // its reach (like a single strike), so it lands on the body, not the air
      if (!mv.projectile && !mv.grab && !this.moveHits.has(0) && this.moveFrame >= mv.hitFrames[0] - 12) {
        const gap = this.strikeGap(mv.limbs, mv.low);
        if (gap > 0 && gap < 0.7) {
          const d = this.dirToOpponent();
          const step = Math.min(gap, 3 * dt, Math.max(0, d.dist - this.sepLimit));
          this.x += d.x * step; this.z += d.z * step;
        }
      }
      mv.hitFrames.forEach((f, i) => {
        if (this.moveHits.has(i)) return;
        const last = i === mv.hitFrames.length - 1;
        const info = { index: i, last, dmg: last ? (mv.finalDmg ?? mv.dmg) : mv.dmg, react: last ? (mv.finalReact ?? mv.react) : mv.react };
        // projectiles and grabs fire on their frame: they have their own collision
        if (mv.projectile || (mv.grab && (i === 0 || !this.grabbed || mv.grab === 'throw'))) {
          if (this.moveFrame < f) return;
          this.moveHits.add(i);
          // projectile skills: the fireball / kunai / ground wave leaves the hand
          if (mv.projectile) return this.game.spawnProjectile(this, mv);
          // throws: the first frame is the grab, the rest only follow a grab that held
          if (i === 0) {
            const secs = ((mv.hitFrames.at(-1) - f) / FPS) / (mv.speed * this.def.speed);
            this.grabbed = this.game.tryGrab(this, mv, secs);
            this.grabMissed = !this.grabbed;
            return;
          }
          if (this.grabbed && mv.grab === 'throw') this.game.throwSlam(this, this.opponent, mv);
          return;
        }
        // Every blow of a flurry lands only when a fist/foot/elbow/knee reaches
        // the body (a 5 cm graze counts), from a little before its beat to a
        // little after. Before, a blow counted on its frame from 1.6 m away and
        // struck the air. Blows are judged strictly in order (two close beats
        // can't both take the same touch), and a super whose opening blow
        // missed can still catch on a later blow that really connects.
        if (mv.hitFrames.some((_, k) => k < i && !this.moveHits.has(k))) return;
        const prevF = i > 0 ? mv.hitFrames[i - 1] : -Infinity;
        if (this.moveFrame < Math.max(f - 8, (prevF + f) / 2)) return;
        const gap = this.strikeGap(mv.limbs, mv.low);
        const contact = this.limbContact(0, mv.limbs, mv.low);
        const late = this.moveFrame > f + 10;
        if (!contact && gap > 0.05 && !late) return;
        this.moveHits.add(i);
        const held = this.opponent.lockedBy === this && this.holding;
        if (contact) info.contact = contact;
        else if (gap <= 0.05) info.contact = this.strikePoint(this.opponent.x, mv.height, this.opponent.z);
        // the beat passed untouched: a held opponent still takes it if the
        // limb is right at the body (a frame-rate miss), anyone else dodged it
        else if (!held || gap > 0.1) return;
        this.game.tryHit(this, mv, info);
      });
      // a grab on air: let go and recover quickly (a short, punishable whiff)
      if (this.grabMissed && this.moveFrame >= mv.hitFrames[0] + 10) {
        this.move = null;
        this.setState('idle');
        this.loopAnim('stance', 0.25);
        return;
      }
    } else if (!this.moveHits.has(0) && this.moveFrame >= mv.hit[0] - 6 && this.moveFrame <= mv.hit[1] + 8) {
      // contact-based: the blow lands the frame a fist/foot actually touches the
      // opponent's head or torso - never on air, and never through the body
      // swinging = moving at least ~0.9 m/s of animation time against the body
      const contact = this.limbContact(0.015 * dt * FPS * sp, mv.limbs, mv.low);
      if (contact && this.game.tryHit(this, mv, { index: 0, last: true, dmg: mv.dmg, react: mv.react, contact })) this.moveHits.add(0);
    }

    // Combo input: every press joins a short queue (the old single-slot buffer
    // let the third press overwrite the second, so J J J came out as two hits).
    // Each strike takes the oldest press once its blow has landed or whiffed;
    // a press with no follow-up from this move is dropped.
    // (timed in game time: a hitstop or slow motion doesn't age the presses.
    // Inside a string each press waits its turn - a mashed J J J J must outlive
    // three wind-ups - so only a press left over when the string ends goes
    // stale, see updateFree.)
    if (input.P || input.K || input.skill1 || input.skill2) {
      const sk = this.skillFor(input);
      this.queue.push({ b: input.P ? 'P' : 'K', fwd: input.fwd, t: this.inputClock, skill: sk === 'throw' ? null : sk });
      if (this.queue.length > 3) this.queue.shift();
    }
    while (this.queue.length && this.inputClock - this.queue[0].t > 3) this.queue.shift();
    if (this.queue.length && this.moveFrame >= lastHit + 3) {
      const q = this.queue.shift();
      // a skill cancels a normal strike that landed (J J -> fireball)
      const landed = this.combo > 0 && this.comboTimer > 0;
      if (q.skill && landed && !mv.special && !this.move.startsWith('skill')) return this.startMove(q.skill);
      const next = q.skill ? null : this.nextInCombo(this.move, q.b, q.fwd);
      if (next) return this.startMove(next);
    }

    // after the follow-through, hand back control and blend into the stance
    // from wherever the limb is (the clip's own return was the slow part)
    const endF = phased ? Math.min(mv.end, lastHit + this.followFrames(mv)) : mv.end;
    if (this.moveFrame >= endF) {
      const early = endF < mv.end;
      this.move = null;
      this.setState('idle');
      this.loopAnim('stance', early ? 0.32 : 0.28);
    }
  }

  followFrames(mv) {
    if (mv.follow) return mv.follow;
    return FOLLOW_FRAMES[mv.spin ? 'spin' : mv.heavy ? 'heavy' : mv.dmg >= 8 ? 'mid' : 'light'];
  }

  updateDodge(dt) {
    // afterimages at the start of the dodge
    this.ghostTimer -= dt;
    if (this.ghostIndex < DODGE_GHOSTS && this.ghostTimer <= 0) {
      this.spawnGhost();
      this.ghostTimer = 0.1;
    }
    if (this.stateTime >= this.dodgeDur) { this.setState('idle'); this.loopAnim('stance', 0.25); }
  }

  resolveSpacing(sdt = 1 / 60) {
    const o = this.opponent;
    const dx = this.x - o.x, dz = this.z - o.z;
    const d = Math.hypot(dx, dz) || 0.0001;
    const sep = Math.min(this.sepLimit, o.sepLimit);
    // after a close-range strike the two ease back apart instead of snapping
    const push = sep < TUNING.minSep ? sep - d : Math.min(sep - d, Math.max(1.2 * sdt, sep - d - 0.2));
    if (d < sep) {
      const pushOut = push / 2;
      this.x += (dx / d) * pushOut; this.z += (dz / d) * pushOut;
      o.x -= (dx / d) * pushOut; o.z -= (dz / d) * pushOut;
    }
    const r = Math.hypot(this.x, this.z);
    if (r > TUNING.arenaRadius) { this.x *= TUNING.arenaRadius / r; this.z *= TUNING.arenaRadius / r; }
  }

  // ---- being hit ---------------------------------------------------------
  receiveHit(attacker, info) {
    const dir = attacker.dirToOpponent();
    const facing = this.facingVec();
    const frontal = facing.x * -dir.x + facing.z * -dir.z > 0.2;
    const lib = this.game.scene.skeletalAnimationLibrary;
    const has = (c) => lib.has(c);
    // armour (GRIZZLY's charge): the blow hurts but doesn't stop the move
    if (this.state === 'attack' && this.move) {
      const mv = this.moves[this.move];
      if (mv.armor && this.moveFrame < mv.hit[1]) {
        this.hp = Math.max(1, this.hp - info.dmg * 0.6);
        this.flash = 0.5; this.flashColor = { r: 1, g: 0.6, b: 0.2 };
        return 'armor';
      }
    }
    this.queue.length = 0; // getting hit (or blocking) drops pending combo presses
    if (this.state === 'block' && frontal) {
      this.blockStun = info.heavy ? 0.3 : 0.2;
      this.hp = Math.max(1, this.hp - info.dmg * TUNING.blockReduce);
      this.push = { x: dir.x * (info.heavy ? 0.28 : 0.18), z: dir.z * (info.heavy ? 0.28 : 0.18), t: 0.15 };
      this.flash = 0.35; this.flashColor = { r: 0.5, g: 0.8, b: 1 };
      // the guard gives a little: a forearm jolt clip when we have one, plus the
      // additive lean back, then the held guard resumes (see updateBlock)
      // (only two-handed high guards: the jolt clip is a boxing guard)
      const gh = this.def.clips?.guardHit;
      if (gh && has(gh)) {
        this.play(gh, { speed: 1.5, fade: 0.05 });
        this.guardHitT = 0.32;
      }
      this.startFlinch(dir, 'guard', info.heavy ? 9 : 6);
      return 'blocked';
    }
    const wasInHit = this.state === 'hit';
    this.hp = Math.max(0, this.hp - info.dmg);
    this.flash = info.heavy ? 0.42 : 0.28;
    this.flashColor = { r: 1, g: 1, b: 1 };
    this.move = null;
    // additive snap on top of the reaction clip: head blows whip the head off
    // the line of the punch, body blows fold the torso
    const kind = info.react === 'body' ? 'body' : 'head';
    this.startFlinch(dir, kind, (info.heavy ? 22 : 15) * (info.react === 'down' || this.hp <= 0 ? 0.7 : 1), info.side || 0);
    // pushback comes from the reaction clip's own root motion
    if (this.hp <= 0) {
      // execution fall: spun face-down by head blows, thrown back by the rest
      this.setState('ko');
      const koClip = info.react === 'head' && has('ko_spin') ? 'ko_spin' : has('ko_launch') ? 'ko_launch' : 'ko';
      this.play(koClip, { speed: 1.0, fade: 0.06 });
      return 'ko';
    }
    if (info.react === 'down') {
      this.setState('down');
      const launch = has('react_launch');
      this.play(launch ? 'react_launch' : 'knockdown', { speed: 1.0, fade: 0.06 });
      this.downDur = launch ? (this.game.clipLanding?.react_launch ?? 60) / FPS + 0.5 : 39 / FPS + 0.7;
    } else {
      this.setState('hit');
      let clip;
      if (!frontal) clip = 'hit_back';
      else if (info.heavy && has('react_heavy')) clip = 'react_heavy';
      else if (info.react === 'body') clip = has('react_body') ? 'react_body' : 'hit_body';
      // a hook from the side snaps the head the other way
      else if (info.side > 0 && has('react_head_r') && Math.random() < 0.85) clip = 'react_head_r';
      else if (info.side < 0 && has('react_head_l') && Math.random() < 0.85) clip = 'react_head_l';
      else clip = has('react_head') ? 'react_head' : 'hit_head';
      this.play(clip, { speed: 1.3, fade: 0.05 });
      this.hitDur = clip === 'react_heavy' ? 0.85 : clip === 'react_body' ? 0.62 : info.heavy ? 0.55 : 0.45;
    }
    return wasInHit ? 'combo' : 'hit';
  }

  // ---- afterimages -------------------------------------------------------
  spawnGhost() {
    const g = this.ghosts[this.ghostIndex];
    this.ghostIndex++;
    if (!g || !this.game.showGhosts) return;
    g.setActive(true);
    g.setPosition(this.x, 0, this.z);
    g.setRotation(0, (this.yaw * 180) / Math.PI - this.clipYaw, 0);
    g.playAnimation(this.curClip, { loop: false });
    g.animationTime = this.character.animationTime;
    g.playbackSpeed = 0;
    g.setTint(0.45 - this.ghostIndex * 0.08, this.color);
    g.setReveal(0, true);
    this.ghostAnims.push({ g, t: 0, dur: 0.42 });
  }

  // Heavy strikes leave a Gaussian copy of the attacker frozen at impact
  // (a super leaves a fainter one every tenth of a second)
  strikeTrail(tint = 0.55, dur = 0.55, lag = 2) {
    if (!this.game.showGhosts) return;
    const g = this.freeGhost();
    if (!g) return;
    g.setActive(true);
    g.setPosition(this.x, this.lift || 0, this.z);
    g.setRotation(0, (this.yaw * 180) / Math.PI - this.clipYaw, 0);
    g.playAnimation(this.curClip, { loop: false });
    g.animationTime = Math.max(0, this.character.animationTime - lag);
    g.playbackSpeed = 0;
    g.setTint(tint, this.color);
    g.setReveal(0, true);
    this.ghostAnims.push({ g, t: 0, dur });
  }

  freeGhost() {
    const busy = new Set(this.ghostAnims.map((a) => a.g));
    return this.ghosts.find((x) => !busy.has(x)) || null;
  }

  // ---- super ----------------------------------------------------------------
  updateSuperFx(dt) {
    this.superT += dt;
    // a pulsing glow in the fighter's colour (a hit flash still shows through)
    const glow = 0.1 + 0.06 * Math.sin(this.superT * 18);
    if (this.flash > glow) this.character.setTint(this.flash, this.flashColor);
    else this.character.setTint(glow, this.color);
    // energy shed off the fists, feet and spine, in the fighter's style
    const pts = ['hand_l', 'hand_r', 'foot_l', 'foot_r', 'spine_05', 'head'].map((n) => this.bonePos(n)).filter(Boolean);
    this.game.fx.aura(this.def.fx, pts, this.def.color, dt);
  }

  // SHADE's finisher: shadow clones caught mid-strike all around the defender
  spawnClones(def) {
    if (!this.game.showGhosts) return;
    // stand them on the far side of the defender from the camera: a clone
    // between the lens and the target filled the frame with a giant hand
    const base = Math.atan2(this.x - def.x, this.z - def.z);
    const cam = this.game.camera.entity.getPosition();
    const spots = [];
    for (let s = 1; s < 8; s++) {
      const a = base + (s * Math.PI * 2) / 8;
      const x = def.x + Math.sin(a) * 1.0, z = def.z + Math.cos(a) * 1.0;
      spots.push({ x, z, far: Math.hypot(x - cam.x, z - cam.z) });
    }
    spots.sort((p, q) => q.far - p.far);
    for (let k = 1; k <= 3; k++) {
      const g = this.freeGhost();
      if (!g) return;
      const { x, z } = spots[k - 1];
      const yaw = Math.atan2(def.x - x, def.z - z);
      g.setActive(true);
      g.setPosition(x, 0, z);
      g.setRotation(0, (yaw * 180) / Math.PI - this.clipYaw, 0);
      g.playAnimation(this.curClip, { loop: false });
      g.animationTime = Math.max(0, this.character.animationTime - k * 2);
      g.playbackSpeed = 0;
      g.setTint(0.65, this.color);
      g.setReveal(0, true);
      this.ghostAnims.push({ g, t: -k * 0.04, dur: 0.75 });
    }
  }

  updateGhosts(dt) {
    for (let i = this.ghostAnims.length - 1; i >= 0; i--) {
      const a = this.ghostAnims[i];
      a.t += dt;
      const k = a.t / a.dur;
      if (k >= 1) {
        a.g.setActive(false);
        this.ghostAnims.splice(i, 1);
      } else {
        a.g.setReveal(Math.max(0, k), true);
      }
    }
  }
}
