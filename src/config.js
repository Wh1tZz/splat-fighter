// Static game data: roster, animation clips, move table, tuning.
// Clip frames are at 30 fps. Hit frames were measured from each clip's peak
// limb extension (see probe.html), so damage lands when the limb is out.

// A character-specific move built from one PINOC clip that starts and ends in
// that character's own stance. `strike` is the frame where the striking limb
// is furthest out (measured); the hit window, wind-up start and playback rates
// follow from the move's weight. The clip runs to its end, so the fighter is
// back in stance when control returns - no pose snap.
//   light: jabs and quick hand strikes   mid: crosses, hooks, front kicks
//   heavy: round/side kicks, smashes     spin: spinning moves (keep their spin)
const KIND = {
  light: { lead: 14, speed: 1.55, recover: 1.9, reach: 1.22 },
  mid:   { lead: 20, speed: 1.45, recover: 1.75, reach: 1.3 },
  heavy: { lead: 26, speed: 1.35, recover: 1.6, reach: 1.5, heavy: true },
  spin:  { lead: 30, speed: 1.3,  recover: 1.55, reach: 1.5, heavy: true, spin: true },
};
function mv(clip, strike, kind, extra = {}) {
  const k = KIND[kind];
  return {
    clip, start: Math.max(0, strike - k.lead), end: 57, speed: k.speed, recover: k.recover,
    hit: [strike - 3, strike + 3], reach: k.reach, heavy: !!k.heavy, spin: !!k.spin, ...extra,
  };
}

// Every fighter has a full kit of PINOC text-generated clips in
// assets/motions/chars/: stance, victory pose, special and all eight strikes.
export const ROSTER = [
  {
    id: 'kenji', name: 'KENJI', title: '赤带空手', color: '#ff3b3b', fx: 'fire',
    style: '均衡型 · 正统空手道', hp: 100, speed: 1.0, power: 1.0,
    signature: '招牌：正拳突（J J）· 侧踹（后退+U）· 回旋后踢（U U）· 必杀：红莲千本突',
    high: './assets/characters/kenji.high.vsplat', perf: './assets/characters/kenji.perf.vsplat', portrait: './assets/characters/kenji.png',
    clips: { stance: 'kenji_stance', cheer: 'kenji_win', block: 'kenji_block', intro: 'kenji_intro' },
    moves: {
      // jab, gyaku-zuki, hook and mae-geri regenerated with explosive snap
      // (the first takes peaked at 2-5 m/s fist speed and read as pushes)
      jab:        mv('kenji_jab', 17, 'light', { dmg: 5, height: 1.5, react: 'head' }),
      cross:      mv('kenji_punch', 18, 'mid', { dmg: 9, height: 1.3, react: 'body' }),
      hook:       mv('kenji_hook', 26, 'mid', { dmg: 10, height: 1.6, react: 'head' }),
      uppercut:   mv('kenji_uppercut', 22, 'mid', { dmg: 13, height: 1.5, react: 'down', heavy: true }),
      front_kick: mv('kenji_frontkick', 29, 'mid', { dmg: 9, height: 1.05, react: 'body', reach: 1.45 }),
      lunge:      mv('kenji_lunge', 16, 'mid', { dmg: 10, height: 1.5, react: 'head', advance: 1.3, meter: 7 }),
      dash_kick:  mv('kenji_axe', 15, 'heavy', { dmg: 13, height: 1.7, react: 'head', advance: 1.0, meter: 8 }),
      finisher:   mv('kenji_finisher', 20, 'heavy', { dmg: 15, height: 1.3, react: 'down', advance: 0.8, meter: 10 }),
      round_kick: mv('kenji_roundkick', 25, 'heavy', { dmg: 12, height: 1.75, react: 'head' }),
      side_kick:  mv('kenji_sidekick', 27, 'heavy', { dmg: 12, height: 1.3, react: 'body', reach: 1.6 }),
      spin_kick:  mv('kenji_spinkick', 34, 'spin', { dmg: 16, height: 1.7, react: 'down' }),
      // flying attacks (K, then J/U in the air): entered from the air near the clip's take-off
      jump_kick:  { clip: 'kenji_jumpkick', start: 22, end: 70, speed: 1.15, recover: 0.9, hit: [36, 44], dmg: 15, height: 1.6 },
      // super: power-up pose (charge) -> five blows -> spinning back kick -> zanshin
      special:    { clip: 'kenji_super', start: 0, end: 115, speed: 1.0, charge: 12, hitFrames: [18, 30, 58, 66, 72], dmg: 5, finalDmg: 18, reach: 1.6, height: 1.3, spin: true, superName: '红莲千本突', superNameEn: 'CRIMSON THOUSAND FISTS' },
      // skills (see SKILLS below): a fireball, a rising dragon fist, a shoulder throw
      skill1:     { clip: 'kenji_blast', start: 8, end: 74, speed: 1.3, recover: 1.6, hitFrames: [44], reach: 9, dmg: 10, height: 1.3, react: 'body', projectile: { kind: 'fireball', speed: 6.5, range: 7, y: 1.25 }, word: '波!', aura: ['hand_l', 'hand_r'] },
      // (fixedHit: measured, the crouching fist brushes the target at frame 15 - the rise is at 26-34)
      skill2:     mv('kenji_dragon', 30, 'heavy', { dmg: 14, height: 1.6, react: 'down', invuln: true, fixedHit: true, hit: [25, 34], reach: 1.2, aura: ['hand_l', 'hand_r'], auraBurst: true, word: '升龙!' }),
      throw:      { clip: 'kenji_throw', start: 4, end: 89, speed: 1.15, recover: 1.3, hitFrames: [16, 36], reach: 1.15, dmg: 14, height: 0.6, react: 'down', grab: 'throw', word: '摔!' },
    },
    // karate: punch strings that end in the double-fist kime, kicks into the spin
    combos: {
      jab: { P: 'cross', K: 'front_kick' },
      cross: { P: 'hook', K: 'round_kick' },
      hook: { P: 'finisher', K: 'spin_kick' },
      front_kick: { P: 'cross', K: 'spin_kick' },
      round_kick: { K: 'spin_kick' },
      lunge: { P: 'hook', K: 'round_kick' },
      dash_kick: { P: 'finisher' },
    },
    moveNames: { jab: '刺拳', cross: '正拳突', hook: '勾拳', uppercut: '上勾拳', front_kick: '前蹴', round_kick: '回旋踢', side_kick: '侧踹', spin_kick: '回旋后踢', lunge: '追突', dash_kick: '踵落', finisher: '双手突', jump_kick: '飞身侧踹', special: '红莲千本突', skill1: '烈焰气功波', skill2: '升龙拳', throw: '过肩摔' },
  },
  {
    id: 'valeria', name: 'VALERIA', title: '紫电泰拳', color: '#b45cff', fx: 'volt',
    style: '速度型 · 泰拳肘膝，出招快', hp: 95, speed: 1.12, power: 0.92,
    signature: '招牌：平肘（J J J）· 上挑肘（后退+J）· 飞膝（后退+U）· 必杀：紫电·雷霆飞肘',
    high: './assets/characters/valeria.high.vsplat', perf: './assets/characters/valeria.perf.vsplat', portrait: './assets/characters/valeria.png',
    clips: { stance: 'valeria_stance', cheer: 'valeria_win', block: 'valeria_block', intro: 'valeria_intro', guardHit: 'guard_hit' },
    moves: {
      jab:        mv('valeria_jab', 16, 'light', { dmg: 5, height: 1.5, react: 'head' }),
      cross:      mv('valeria_cross', 28, 'mid', { dmg: 8, height: 1.55, react: 'head' }),
      hook:       { clip: 'valeria_elbow', start: 4, end: 52, speed: 1.4, recover: 1.8, hit: [16, 25], reach: 1.18, dmg: 11, height: 1.45, react: 'head', heavy: true },
      uppercut:   mv('valeria_upelbow', 20, 'mid', { dmg: 13, height: 1.45, react: 'down', heavy: true, reach: 1.15 }),
      front_kick: mv('valeria_teep', 23, 'mid', { dmg: 9, height: 1.1, react: 'body', reach: 1.5 }),
      round_kick: mv('valeria_roundkick', 22, 'heavy', { dmg: 12, height: 1.7, react: 'head' }),
      side_kick:  { clip: 'valeria_knee', start: 6, end: 54, speed: 1.4, recover: 1.8, hit: [22, 31], reach: 1.15, dmg: 11, height: 1.05, react: 'body', heavy: true },
      spin_kick:  mv('valeria_spinelbow', 20, 'spin', { dmg: 15, height: 1.55, react: 'down', reach: 1.2 }),
      lunge:      mv('valeria_superman', 28, 'mid', { dmg: 10, height: 1.55, react: 'head', advance: 1.3, meter: 7 }),
      dash_kick:  mv('valeria_switchkick', 18, 'heavy', { dmg: 12, height: 1.2, react: 'body', advance: 0.9, meter: 8 }),
      finisher:   mv('valeria_finisher', 20, 'heavy', { dmg: 15, height: 1.45, react: 'down', reach: 1.1, advance: 0.8, meter: 10, limbs: ['calf_l', 'calf_r'] }),
      jump_kick:  { clip: 'valeria_jumpkick', start: 10, end: 66, speed: 1.15, recover: 0.9, hit: [20, 30], dmg: 14, height: 1.4, react: 'down', limbs: ['calf_l', 'calf_r', 'foot_l', 'foot_r'] },
      // super: arm raised (charge) -> elbows and knees -> leaping elbow
      special:    { clip: 'valeria_super', start: 0, end: 100, speed: 1.0, charge: 14, hitFrames: [22, 32, 47, 52, 62, 69], dmg: 4.5, finalDmg: 16, reach: 1.6, height: 1.35, spin: true, superName: '紫电·雷霆飞肘', superNameEn: 'VIOLET THUNDER ELBOW' },
      // skills: a lightning dash kick, a rising flying knee, the clinch and three knees
      skill1:     mv('valeria_dashkick', 31, 'heavy', { dmg: 13, height: 1.5, react: 'head', advance: 2.2, aura: ['foot_l', 'foot_r'], word: '闪!' }),
      skill2:     mv('valeria_skyknee', 40, 'heavy', { dmg: 14, height: 1.5, react: 'down', invuln: true, limbs: ['calf_l', 'calf_r', 'foot_l', 'foot_r'], aura: ['calf_l', 'calf_r'], auraBurst: true, word: '飞膝!' }),
      throw:      { clip: 'valeria_clinch', start: 18, end: 89, speed: 1.2, recover: 1.4, hitFrames: [30, 42, 48, 56], reach: 1.1, dmg: 5, finalDmg: 9, height: 1.2, react: 'body', finalReact: 'down', grab: 'clinch', word: '膝!' },
    },
    // muay thai: punches into elbows, elbows and kicks into the flying knee
    combos: {
      jab: { P: 'cross', K: 'round_kick' },
      cross: { P: 'hook', K: 'side_kick' },
      hook: { P: 'spin_kick', K: 'finisher' },
      front_kick: { P: 'cross', K: 'round_kick' },
      round_kick: { K: 'finisher' },
      side_kick: { K: 'finisher' },
      lunge: { P: 'hook', K: 'side_kick' },
      dash_kick: { P: 'uppercut', K: 'finisher' }, // body kick doubles them over: rising elbow
    },
    moveNames: { jab: '刺拳', cross: '直拳', hook: '平肘', uppercut: '上挑肘', front_kick: '蹬踢', round_kick: '扫踢', side_kick: '膝撞', spin_kick: '回旋肘', lunge: '超人拳', dash_kick: '换步扫踢', finisher: '飞膝', jump_kick: '泰拳飞膝', special: '紫电·雷霆飞肘', skill1: '闪电扫踢', skill2: '飞膝升天', throw: '缠颈膝撞' },
  },
  {
    id: 'grizzly', name: 'GRIZZLY', title: '铁熊', color: '#ff9a2e', fx: 'quake',
    style: '力量型 · 重量级拳击，血厚稍慢', hp: 115, speed: 0.88, power: 1.18,
    signature: '招牌：抡摆重拳（J J）· 双拳砸击（后退+J）· 肩撞（后退+U）· 必杀：熊王·裂地击',
    high: './assets/characters/grizzly.high.vsplat', perf: './assets/characters/grizzly.perf.vsplat', portrait: './assets/characters/grizzly.png',
    clips: { stance: 'grizzly_stance', cheer: 'grizzly_win', block: 'grizzly_block', intro: 'grizzly_intro', guardHit: 'guard_hit' },
    moves: {
      jab:        mv('grizzly_jab', 17, 'light', { dmg: 6, height: 1.5, react: 'head' }),
      cross:      { clip: 'grizzly_haymaker', start: 0, end: 52, speed: 1.3, recover: 1.7, hit: [11, 19], reach: 1.30, dmg: 11, height: 1.5, react: 'head', heavy: true },
      hook:       mv('grizzly_hook', 24, 'mid', { dmg: 11, height: 1.5, react: 'head', heavy: true }),
      uppercut:   { clip: 'grizzly_smash', start: 0, end: 52, speed: 1.25, recover: 1.6, hit: [19, 26], reach: 1.22, dmg: 15, height: 1.4, react: 'down', heavy: true, fixedHit: true },
      front_kick: mv('grizzly_pushkick', 21, 'mid', { dmg: 10, height: 1.05, react: 'body', reach: 1.45 }),
      round_kick: mv('grizzly_roundkick', 24, 'heavy', { dmg: 13, height: 1.3, react: 'body' }),
      side_kick:  mv('grizzly_tackle', 24, 'heavy', { dmg: 13, height: 1.3, react: 'down', reach: 1.25, advance: 0.8, limbs: ['upperarm_l', 'upperarm_r', 'lowerarm_l', 'lowerarm_r', 'hand_l', 'hand_r'] }),
      spin_kick:  mv('grizzly_backfist', 27, 'spin', { dmg: 16, height: 1.6, react: 'down', reach: 1.3, fixedHit: true }),
      lunge:      mv('grizzly_overhand', 26, 'heavy', { dmg: 13, height: 1.6, react: 'head', advance: 1.3, meter: 8 }),
      dash_kick:  mv('grizzly_lowkick', 26, 'mid', { dmg: 10, height: 0.6, react: 'body', advance: 0.9, low: true, meter: 7 }),
      finisher:   mv('grizzly_finisher', 25, 'heavy', { dmg: 17, height: 1.55, react: 'down', advance: 0.8, meter: 10 }),
      jump_kick:  { clip: 'grizzly_jumpkick', start: 8, end: 62, speed: 1.05, recover: 0.85, hit: [20, 27], dmg: 17, height: 1.0, react: 'down' },
      // super: chest-pound roar (charge) -> two crushing hooks -> leap and double-fist ground smash
      special:    { clip: 'grizzly_super', start: 0, end: 112, speed: 1.0, charge: 26, hitFrames: [42, 48, 84], dmg: 7, finalDmg: 18, reach: 1.6, height: 1.3, spin: true, superName: '熊王·裂地击', superNameEn: 'URSA EARTHBREAKER' },
      // skills: an armoured shoulder charge, a ground-splitting wave, a bear-hug slam
      skill1:     mv('grizzly_charge', 28, 'heavy', { dmg: 14, height: 1.3, react: 'down', advance: 2.4, armor: true, reach: 1.25, limbs: ['upperarm_l', 'upperarm_r', 'lowerarm_l', 'lowerarm_r', 'hand_l', 'hand_r'], word: '撞!' }),
      skill2:     { clip: 'grizzly_slam', start: 0, end: 74, speed: 1.2, recover: 1.4, hitFrames: [26], reach: 9, dmg: 12, height: 0.35, react: 'down', projectile: { kind: 'quake', speed: 5, range: 5, y: 0.3 }, word: '震!' },
      throw:      { clip: 'grizzly_throw', start: 6, end: 89, speed: 1.1, recover: 1.3, hitFrames: [20, 46], reach: 1.15, dmg: 18, height: 0.6, react: 'down', grab: 'throw', word: '砸!' },
    },
    // boxing: four-punch strings ending in the wrecking-ball cross, leg kicks to set up
    combos: {
      jab: { P: 'cross', K: 'dash_kick' },
      cross: { P: 'hook', K: 'round_kick' },
      hook: { P: 'finisher', K: 'spin_kick' },
      front_kick: { P: 'cross', K: 'round_kick' },
      dash_kick: { P: 'hook', K: 'round_kick' },
      lunge: { P: 'hook', K: 'side_kick' },
      round_kick: { P: 'finisher' },
    },
    moveNames: { jab: '重刺拳', cross: '抡摆重拳', hook: '勾拳', uppercut: '双拳砸击', front_kick: '推踢', round_kick: '扫肋踢', side_kick: '肩撞', spin_kick: '回旋背拳', lunge: '跃步摆拳', dash_kick: '低扫腿', finisher: '碎岩直拳', jump_kick: '跃起踏踢', special: '熊王·裂地击', skill1: '熊冲撞', skill2: '震地重拳', throw: '熊抱摔' },
  },
  {
    id: 'shade', name: 'SHADE', title: '霓影忍者', color: '#2ee6ff', fx: 'shadow',
    style: '闪避型 · 掌法、手刀与空翻踢', hp: 92, speed: 1.08, power: 0.97, dodgeCooldown: 0.6,
    signature: '招牌：贯手（J J）· 手刀（J J J）· 后空翻踢（U U）· 必杀：霓影·千刃斩',
    high: './assets/characters/shade.high.vsplat', perf: './assets/characters/shade.perf.vsplat', portrait: './assets/characters/shade.png',
    clips: { stance: 'shade_stance', cheer: 'shade_win', block: 'shade_block', intro: 'shade_intro' },
    moves: {
      // palm and spear-hand regenerated: the first takes barely moved (0.9 m/s)
      jab:        mv('shade_palm', 15, 'light', { dmg: 5, height: 1.5, react: 'head' }),
      cross:      mv('shade_spear', 32, 'mid', { dmg: 8, height: 1.4, react: 'head' }),
      lunge:      mv('shade_dashpalm', 16, 'mid', { dmg: 10, height: 1.3, react: 'body', advance: 1.4, speed: 1.75, meter: 7 }),
      dash_kick:  mv('shade_sweep', 19, 'heavy', { dmg: 11, height: 0.25, react: 'down', advance: 1.1, low: true, meter: 8 }),
      finisher:   mv('shade_finisher', 31, 'spin', { dmg: 15, height: 1.65, react: 'down', meter: 10 }),
      hook:       { clip: 'shade_chop', start: 2, end: 46, speed: 1.45, recover: 1.8, hit: [10, 17], reach: 1.22, dmg: 9, height: 1.5, react: 'head' },
      uppercut:   mv('shade_palmrise', 29, 'mid', { dmg: 12, height: 1.5, react: 'down', heavy: true, reach: 1.18 }),
      front_kick: mv('shade_frontkick', 22, 'mid', { dmg: 9, height: 1.25, react: 'body', reach: 1.5 }),
      round_kick: mv('shade_crescent', 21, 'heavy', { dmg: 12, height: 1.6, react: 'head' }),
      side_kick:  mv('shade_sidekick', 24, 'heavy', { dmg: 12, height: 1.3, react: 'body', reach: 1.6 }),
      spin_kick:  { clip: 'shade_flip', start: 6, end: 56, speed: 1.25, recover: 1.5, hit: [30, 38], reach: 1.50, dmg: 15, height: 1.6, react: 'down', heavy: true, spin: true },
      jump_kick:  { clip: 'shade_jumpkick', start: 20, end: 66, speed: 1.2, recover: 0.9, hit: [34, 42], dmg: 14, height: 1.65, react: 'down', spin: true },
      // super: hand seal (charge) -> palm barrage -> flying knee -> towering axe kick
      special:    { clip: 'shade_super', start: 0, end: 110, speed: 1.0, charge: 16, hitFrames: [26, 42, 48, 56, 80], dmg: 5, finalDmg: 17, reach: 1.6, height: 1.4, spin: true, superName: '霓影·千刃斩', superNameEn: 'NEON PHANTOM BLADE' },
      // skills: a thrown kunai, a phasing dash slash, a spinning arm throw
      skill1:     { clip: 'shade_kunai', start: 4, end: 58, speed: 1.35, recover: 1.6, hitFrames: [22], reach: 9, dmg: 7, height: 1.35, react: 'head', projectile: { kind: 'kunai', speed: 11, range: 7.5, y: 1.3 }, word: '咻!' },
      skill2:     mv('shade_slash', 34, 'heavy', { dmg: 12, height: 1.45, react: 'body', advance: 1.9, invuln: 26, aura: ['hand_l', 'hand_r'], slash: true, word: '斩!' }),
      throw:      { clip: 'shade_throw', start: 8, end: 89, speed: 1.2, recover: 1.4, hitFrames: [20, 48], reach: 1.15, dmg: 14, height: 0.6, react: 'down', grab: 'throw', word: '投!' },
    },
    // ninjutsu: palms into chops and flips, kick strings into the spinning hook kick
    combos: {
      jab: { P: 'cross', K: 'front_kick' },
      cross: { P: 'hook', K: 'round_kick' },
      hook: { K: 'spin_kick', P: 'lunge' },
      front_kick: { K: 'round_kick', P: 'cross' },
      round_kick: { K: 'finisher' },
      side_kick: { K: 'finisher' },
      lunge: { P: 'hook', K: 'round_kick' },
    },
    moveNames: { jab: '掌击', cross: '贯手', hook: '手刀', uppercut: '上挑掌', front_kick: '前踢', round_kick: '新月踢', side_kick: '侧踢', spin_kick: '后空翻踢', lunge: '冲步双掌', dash_kick: '扫堂腿', finisher: '回旋勾踢', jump_kick: '旋风踢', special: '霓影·千刃斩', skill1: '苦无', skill2: '瞬影斩', throw: '锁臂摔' },
  },
];

export const CLIPS = [
  'stance', 'walk_fwd', 'walk_back', 'strafe_left', 'strafe_right',
  'jab', 'cross', 'hook', 'uppercut', 'front_kick', 'round_kick', 'side_kick', 'spin_kick', 'special',
  'block', 'roll', 'backstep', 'hit_body', 'hit_head', 'hit_back', 'knockdown', 'getup', 'ko', 'cheer', 'idle',
  // PINOC text-generated reactions and execution falls
  'react_head', 'react_body', 'react_heavy', 'react_launch', 'ko_spin', 'ko_launch',
  // directional hook reactions (_l: struck on the left side, head whips right) and a guard jolt
  'react_head_l', 'react_head_r', 'guard_hit',
  // thrown over and slammed down, then back up (every character's throw)
  'thrown',
  // PINOC text-generated jumps (in place: the game drives the travel)
  'jump_up', 'jump_fwd', 'jump_kick',
];

// Jumps: clip frames played (take-off crouch to landing) and the airborne span
// the horizontal travel is spread over. Measured from the PINOC clips.
// lift: extra height (m) added on top of the clip's own jump as a smooth arc
export const JUMP = {
  up:  { clip: 'jump_up',  start: 8, end: 44, speed: 1.15, air: [15, 27], travel: 0, lift: 0.4 },
  fwd: { clip: 'jump_fwd', start: 8, end: 46, speed: 1.15, air: [18, 31], travel: 1.9, lift: 0.35 },
  back: { clip: 'jump_up', start: 8, end: 44, speed: 1.15, air: [15, 27], travel: -1.4, lift: 0.3 },
};

// start/end: clip frames played. hit: frames (inclusive) where the strike can connect.
// reach: pelvis-to-pelvis distance (m) at which the extended limb meets the body
// (limb extension measured per clip + ~0.3 m torso). Fighters step in by the
// clips' own root motion; nothing slides them.
// height: where the spark lands on the defender. react: which hit reaction plays.
export const MOVES = {
  jab:        { clip: 'jab',        start: 0,  end: 24, speed: 1.35, hit: [6, 13],  reach: 1.22, dmg: 5,  height: 1.55, react: 'head', meter: 5 },
  cross:      { clip: 'cross',      start: 2,  end: 27, speed: 1.3,  hit: [11, 18], reach: 1.28, dmg: 8,  height: 1.50, react: 'head', meter: 6 },
  hook:       { clip: 'hook',       start: 0,  end: 27, speed: 1.25, hit: [8, 15],  reach: 1.22, dmg: 10, height: 1.55, react: 'head', meter: 7, heavy: true },
  uppercut:   { clip: 'uppercut',   start: 10, end: 52, speed: 1.3,  hit: [22, 31], reach: 1.18, dmg: 13, height: 1.45, react: 'down', meter: 8, heavy: true },
  front_kick: { clip: 'front_kick', start: 0,  end: 36, speed: 1.15, hit: [14, 22], reach: 1.55, dmg: 9,  height: 1.15, react: 'body', meter: 6 },
  round_kick: { clip: 'round_kick', start: 0,  end: 44, speed: 1.1,  hit: [12, 20], reach: 1.50, dmg: 12, height: 1.65, react: 'head', meter: 7, heavy: true },
  side_kick:  { clip: 'side_kick',  start: 28, end: 76, speed: 1.25, hit: [36, 49], reach: 1.60, dmg: 11, height: 1.10, react: 'body', meter: 7 },
  spin_kick:  { clip: 'spin_kick',  start: 0,  end: 46, speed: 1.05, hit: [15, 22], reach: 1.55, dmg: 16, height: 1.60, react: 'down', meter: 8, heavy: true },
  // J or U in mid-air: flying kick. glide: the body sails just far enough to
  // land the kick (max metres), evenly over the wind-up; no other travel
  jump_kick:  { clip: 'jump_kick',  start: 8,  end: 56, speed: 1.2,  recover: 0.7, hit: [22, 30], reach: 1.5, dmg: 15, height: 1.6, react: 'down', meter: 8, heavy: true, glide: 1.6, limbs: ['foot_l', 'foot_r'] },
  special:    { clip: 'special',    start: 0,  end: 88, speed: 1.0,  hitFrames: [18, 30, 42, 58], reach: 1.55, dmg: 8, finalDmg: 14, height: 1.45, react: 'head', finalReact: 'down', meter: 0, heavy: true, special: true },
};

// Combo routes: current move -> next move by button.
export const COMBOS = {
  jab:        { P: 'cross', K: 'front_kick' },
  cross:      { P: 'hook',  K: 'round_kick' },
  hook:       { K: 'spin_kick' },
  front_kick: { K: 'spin_kick', P: 'cross' },
  round_kick: { K: 'spin_kick' },
};
// first strike per button: plain, back (b) and forward (f). A fighter can
// override any of these with def.starters; forward moves exist per character.
export const STARTERS = { P: 'jab', K: 'front_kick', bP: 'uppercut', bK: 'side_kick', fP: 'lunge', fK: 'dash_kick' };

// Skills: back-then-forward + J = skill1, back-then-forward + U = skill2 (or the
// O / Y keys), J + L up close = throw. A skill can also cancel a strike that
// landed, so strings end in one (J J -> fireball).
export const SKILL_INPUT = {
  window: 0.45,   // s: the back press, then forward, must fall inside this
  hold: 0.3,      // s: how long after the forward press the button may come
};

export const TUNING = {
  roundTime: 60,
  roundsToWin: 2,
  minSep: 0.92, arenaRadius: 4.2,   // minSep: closest two pelvises get (keeps bodies from interpenetrating)
  blockReduce: 0.15,
  dodgeInvuln: 0.32, dodgeCooldown: 0.9,
  meterMax: 100,
  // super meter gain: a landed blow gives its move's `meter` x meterHit to the
  // attacker and meterTaken to the defender; a blocked one gives meterBlock to
  // each side. The meter carries over between rounds.
  meterHit: 2, meterTaken: 7, meterBlock: 3,
  // hitstop: both fighters freeze for this long on contact (seconds); the
  // defender shakes in place meanwhile. ~5 / 7 / 9 frames at 60 fps.
  hitstop: { light: 0.085, mid: 0.115, heavy: 0.15, block: 0.065, counter: 0.06 },
  // a blow that lands during the defender's own wind-up is a COUNTER, during
  // its recovery a PUNISH: bonus damage and a longer freeze
  counterDmg: 1.25, punishDmg: 1.1,
  comboWindow: 0.55,   // fraction of a move after which a buffered combo input fires
};

export const ARENA = {
  url: './assets/env/arena.spz',
  floorDepthUnits: 0.2175, // measured by Environment.probeGroundDepth(-1)
  captureHeight: 1.5,      // PINOC: floor is ~1.5 m below the capture point
};

// Stages (PINOC text-generated scenes), picked on the select screen. Each is
// scaled to metres by probing its floor at load (floorDepthUnits is the
// fallback when the probe can't find flat ground); yaw turns the scene so the
// fight line (world X) runs across its most telling view.
export const STAGES = [
  { id: 'underground', name: '地下拳场', en: 'UNDERGROUND', url: './assets/env/arena.spz', floorDepthUnits: 0.2175, yaw: 0 },
  // (all three generated at PINOC's high panorama tier: noticeably crisper far walls)
  // the Hall of Supreme Harmony and its marble stairs behind the fight
  { id: 'forbidden', name: '紫禁城·太和殿', en: 'FORBIDDEN CITY', url: './assets/env/forbidden_city.spz', floorDepthUnits: 0.178, yaw: 0 },
  // the arched tiers and stairs (yaw 0 puts a smeared weapon rack in front of the camera)
  { id: 'colosseum', name: '罗马斗兽场', en: 'COLOSSEUM', url: './assets/env/colosseum.spz', floorDepthUnits: 0.1895, yaw: 270 },
  // the neon street running away into the haze. noProbe: the wet, mirror-like
  // asphalt fools the floor probe (it found half the true depth)
  { id: 'kowloon', name: '九龙霓虹街', en: 'KOWLOON', url: './assets/env/kowloon.spz', floorDepthUnits: 0.2175, yaw: 270, noProbe: true },
];
