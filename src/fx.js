// Hit effects drawn on a 2D canvas over the WebGL view, but simulated in 3D:
// sparks are world-space particles with gravity that bounce on the arena floor,
// impact rings lie flat on the floor in perspective, and swing trails follow
// the striking fist or foot. Plus the arena's own Gaussian shockwave
// (Environment.setShock).
//
// Gaussian splats write no depth, so a WebGL particle could not be hidden by
// a body either. Instead every effect is tested against capsules around both
// fighters' bones: whatever lies behind a body from the camera is not drawn,
// so sparks that fly past the far side of the defender disappear behind them.
//
// Each fighter has an effect style (config ROSTER fx):
//   fire   - KENJI: orange sparks and embers drifting up
//   volt   - VALERIA: jagged lightning arcs from the contact
//   quake  - GRIZZLY: heavy debris, a double shock ring, floor dust
//   shadow - SHADE: a crossed slash and dark smoke
//
// The skills add glowing projectiles (fireball, kunai), flame bursts, floor
// cracks and erupting rock, all in the same light-and-spark style.

const GRAVITY = -9.8;
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

const STYLE = {
  fire:   { sparks: ['#ffd36b', '#ff8a2a', '#ff3b1f', '#ffffff'], core: '#ff6a1a' },
  volt:   { sparks: ['#e3c2ff', '#b45cff', '#7a5cff', '#ffffff'], core: '#b45cff' },
  quake:  { sparks: ['#ffc46b', '#ff9a2e', '#d9a066', '#ffffff'], core: '#ff9a2e' },
  shadow: { sparks: ['#9ff5ff', '#2ee6ff', '#1b8fb0', '#ffffff'], core: '#2ee6ff' },
};
// spark count / speed / life per blow weight
const TIER = {
  light: { n: 22, sp: 3.4, life: 0.32, core: 0.24, ring: 0.45, flare: 0 },
  mid:   { n: 36, sp: 4.4, life: 0.42, core: 0.32, ring: 0.65, flare: 6 },
  heavy: { n: 60, sp: 5.6, life: 0.55, core: 0.44, ring: 0.95, flare: 9 },
};

export class FX {
  constructor(overlay, camera) {
    this.cv = overlay;
    this.ctx = overlay.getContext('2d');
    this.camera = camera;
    this.parts = [];
    this.rings = [];
    this.flashes = [];
    this.flares = [];
    this.bolts = [];
    this.slashes = [];
    this.smoke = [];
    this.skyBolts = [];
    this.screenSlashes = [];
    this.cracks = [];
    this.projs = [];   // live projectiles (owned by the game, drawn here)
    this.trails = new Map();
    this.shock = null;
    this.env = null;
    this.flashScale = 1;
    this.density = 1;   // share of particles spawned (quality tier)
    this.lite = false;  // light tier: no smoke
    this.bodies = null;      // () => [[a, b, r], ...] world capsules, set by the game
    this.occ = [];
    this.flashEl = document.getElementById('flash');
    this.p = { x: 0, y: 0, z: 0 };
    this.q = { x: 0, y: 0, z: 0 };
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.dpr = dpr;
    this.cv.width = Math.max(1, this.cv.clientWidth * dpr);
    this.cv.height = Math.max(1, this.cv.clientHeight * dpr);
  }

  setEnv(env) {
    this.env = env;
    try { this.shockReady = env.prepareShock(); } catch { this.shockReady = false; }
  }

  // Every particle is spawned through these: the light quality tier keeps a
  // share of them (density) and drops smoke entirely (each puff is a
  // full radial-gradient fill, the costliest thing this canvas draws)
  addPart(p) {
    if (this.density < 1 && Math.random() > this.density) return;
    this.parts.push(p);
  }

  addSmoke(s) {
    if (this.lite) return;
    this.smoke.push(s);
  }

  clear() {
    this.parts = []; this.rings = []; this.flashes = []; this.flares = [];
    this.bolts = []; this.slashes = []; this.smoke = []; this.trails.clear();
    this.skyBolts = []; this.screenSlashes = []; this.cracks = [];
    this.projs.length = 0; // (shared with the game's projectile list)
  }

  // world-space impact. dir = unit vector of the blow (attacker -> defender)
  impact(pos, { color = '#fff6d0', style = null, tier = 'light', counter = false, blocked = false, dir = null } = {}) {
    if (!pos || ![pos.x, pos.y, pos.z].every(Number.isFinite)) return;
    if (blocked) return this.blockImpact(pos, dir);
    const T = TIER[tier] || TIER.light;
    const S = STYLE[style] || { sparks: [color, '#ffffff'], core: color };
    const heavy = tier === 'heavy';
    const n = Math.round(T.n * (style === 'quake' ? 0.8 : 1));
    for (let i = 0; i < n; i++) {
      // spray in a cone around the blow direction, the rest scattered
      let vx = rnd(-1, 1), vy = rnd(-0.3, 1.3), vz = rnd(-1, 1);
      if (dir) { vx += dir.x * 1.7; vz += dir.z * 1.7; }
      const l = Math.hypot(vx, vy, vz) || 1;
      const sp = T.sp * rnd(0.3, 1.3);
      this.addPart({
        x: pos.x, y: pos.y, z: pos.z,
        vx: (vx / l) * sp, vy: (vy / l) * sp, vz: (vz / l) * sp,
        life: 0, max: T.life * rnd(0.6, 1.4), g: GRAVITY,
        color: pick(S.sparks), w: heavy ? 3.2 : 2.2, kind: 'spark',
      });
    }
    // bright core and a ring around the contact, facing the camera
    this.flashes.push({ x: pos.x, y: pos.y, z: pos.z, life: 0, max: heavy ? 0.2 : 0.14, r: T.core * (counter ? 1.3 : 1), color: S.core });
    this.rings.push({ x: pos.x, y: pos.y, z: pos.z, life: 0, max: heavy ? 0.4 : 0.26, r0: 0.08, r1: T.ring, color: S.core, billboard: true });
    if (heavy) this.rings.push({ x: pos.x, y: 0.02, z: pos.z, life: 0, max: 0.6, r0: 0.2, r1: 2.4, color: S.core });
    // impact flare: thin spikes bursting out in screen space (mid and up)
    const spikes = T.flare + (counter ? 4 : 0);
    if (spikes) this.flares.push({ x: pos.x, y: pos.y, z: pos.z, life: 0, max: counter ? 0.16 : 0.11, n: spikes, len: (heavy ? 0.9 : 0.6) * (counter ? 1.35 : 1), rot: Math.random() * Math.PI, color: counter ? '#ff4040' : S.core });

    switch (style) {
      case 'fire':
        // embers that float up and fade
        for (let i = 0; i < (heavy ? 18 : 9); i++) {
          this.addPart({
            x: pos.x + rnd(-0.08, 0.08), y: pos.y + rnd(-0.08, 0.08), z: pos.z + rnd(-0.08, 0.08),
            vx: rnd(-0.6, 0.6) + (dir ? dir.x * 0.6 : 0), vy: rnd(0.4, 1.4), vz: rnd(-0.6, 0.6) + (dir ? dir.z * 0.6 : 0),
            life: 0, max: rnd(0.5, 0.9), g: 1.6, color: pick(['#ffb347', '#ff6a1a', '#ffd36b']), w: 2.6, kind: 'ember',
          });
        }
        break;
      case 'volt':
        // branching arcs out of the contact, flickering
        for (let i = 0; i < (heavy ? 6 : 3 + (tier === 'mid' ? 1 : 0)); i++) {
          const a = Math.random() * Math.PI * 2, e = rnd(-0.6, 0.9);
          const len = rnd(0.25, heavy ? 0.75 : 0.5);
          this.bolts.push({ x: pos.x, y: pos.y, z: pos.z, dx: Math.cos(a) * Math.cos(e) * len + (dir ? dir.x * 0.2 : 0), dy: Math.sin(e) * len, dz: Math.sin(a) * Math.cos(e) * len + (dir ? dir.z * 0.2 : 0), life: 0, max: rnd(0.12, 0.22), seed: Math.random() * 1000 });
        }
        break;
      case 'quake':
        // heavy chunks that tumble and bounce, plus floor dust under the defender
        for (let i = 0; i < (heavy ? 14 : 6); i++) {
          let vx = rnd(-1, 1), vz = rnd(-1, 1);
          if (dir) { vx += dir.x * 1.2; vz += dir.z * 1.2; }
          this.addPart({ x: pos.x, y: pos.y, z: pos.z, vx: vx * 2.2, vy: rnd(1, 3.2), vz: vz * 2.2, life: 0, max: rnd(0.5, 0.8), g: -14, color: pick(['#ffc46b', '#c98a4a', '#ff9a2e']), w: heavy ? 6 : 4.5, kind: 'chunk' });
        }
        this.rings.push({ x: pos.x, y: pos.y, z: pos.z, life: 0, max: heavy ? 0.5 : 0.34, r0: 0.05, r1: T.ring * 1.6, color: '#ffe0a0', billboard: true });
        this.puff(pos.x, 0.08, pos.z, '#8a6a4a', heavy ? 10 : 5, 0.35);
        break;
      case 'shadow':
        // a crossed slash through the contact and a puff of dark smoke
        this.slashes.push({ x: pos.x, y: pos.y, z: pos.z, life: 0, max: heavy ? 0.22 : 0.16, len: heavy ? 1.0 : 0.7, a: rnd(-0.9, -0.5), color: '#2ee6ff' });
        if (tier !== 'light') this.slashes.push({ x: pos.x, y: pos.y, z: pos.z, life: -0.03, max: heavy ? 0.22 : 0.16, len: heavy ? 0.9 : 0.6, a: rnd(0.5, 0.9), color: '#9ff5ff' });
        this.puff(pos.x, pos.y, pos.z, '#0b1820', heavy ? 9 : 5, 0.22);
        break;
      default: break;
    }
  }

  // guard contact: cold blue sparks that skid off the forearms
  blockImpact(pos, dir) {
    for (let i = 0; i < 18; i++) {
      let vx = rnd(-1, 1), vy = rnd(0, 1.4), vz = rnd(-1, 1);
      if (dir) { vx -= dir.x * 0.8; vz -= dir.z * 0.8; } // glance back toward the attacker
      const l = Math.hypot(vx, vy, vz) || 1, sp = rnd(1.5, 4);
      this.addPart({ x: pos.x, y: pos.y, z: pos.z, vx: (vx / l) * sp, vy: (vy / l) * sp, vz: (vz / l) * sp, life: 0, max: rnd(0.2, 0.4), g: GRAVITY, color: pick(['#9fd8ff', '#ffffff', '#5cb8ff']), w: 2, kind: 'spark' });
    }
    this.flashes.push({ x: pos.x, y: pos.y, z: pos.z, life: 0, max: 0.12, r: 0.22, color: '#9fd8ff' });
    this.rings.push({ x: pos.x, y: pos.y, z: pos.z, life: 0, max: 0.2, r0: 0.12, r1: 0.42, color: '#9fd8ff', billboard: true, hex: true });
  }

  puff(x, y, z, color, n, size) {
    for (let i = 0; i < n; i++) {
      this.addSmoke({ x: x + rnd(-0.15, 0.15), y: y + rnd(-0.05, 0.15), z: z + rnd(-0.15, 0.15), vx: rnd(-0.5, 0.5), vy: rnd(0.1, 0.6), vz: rnd(-0.5, 0.5), life: 0, max: rnd(0.45, 0.8), r: size * rnd(0.6, 1.2), color });
    }
  }

  // One sample of a swinging fist/foot. `key` identifies the limb; samples
  // age out after ~0.11 s of game time, so the trail freezes with a hitstop.
  trail(key, x, y, z, color, width = 1) {
    let t = this.trails.get(key);
    if (!t) { t = { pts: [], color }; this.trails.set(key, t); }
    t.color = color;
    t.pts.push({ x, y, z, age: 0, w: width });
  }

  floorShock(x, z, strength = 0.55, dur = 0.75) {
    if (!this.env || !this.shockReady) return;
    this.shock = { x, z, t: 0, dur, strength };
  }

  // ---- skill effects (glow style) -------------------------------------------
  // a glowing burst: core flash and a ring
  burst(pos, color, size = 0.3, life = 0.24) {
    this.flashes.push({ x: pos.x, y: pos.y, z: pos.z, life: 0, max: life * 0.8, r: size, color });
    this.rings.push({ x: pos.x, y: pos.y, z: pos.z, life: 0, max: life, r0: 0.06, r1: size * 2.2, color, billboard: true });
  }

  // the same, in a style's colour (dir/core accepted for callers, unused)
  splash(pos, style, { size = 0.24, life = 0.34, color = null } = {}) {
    this.burst(pos, color || STYLE[style]?.core || '#ffffff', size, life);
  }

  // a slash of light across a point (a: screen angle, len: metres)
  cut(pos, style, a, len, life = 0.22, w = 1, color = null) {
    this.slashes.push({ x: pos.x, y: pos.y, z: pos.z, life: 0, max: life, len, a, color: color || STYLE[style]?.core || '#ffffff' });
  }

  word() {}
  speedLines() {}

  // a spray of rising flame: embers and a hot core
  flameBurst(pos, n, len, dir = null) {
    for (let i = 0; i < n * 6; i++) {
      this.addPart({
        x: pos.x + rnd(-0.06, 0.06), y: pos.y + rnd(-0.06, 0.06), z: pos.z + rnd(-0.06, 0.06),
        vx: rnd(-0.8, 0.8) + (dir ? dir.x * 1.2 : 0), vy: rnd(1, 3) * len * 2, vz: rnd(-0.8, 0.8) + (dir ? dir.z * 1.2 : 0),
        life: 0, max: rnd(0.35, 0.7), g: 2, color: pick(['#ffd36b', '#ff8a2a', '#ff3b1f', '#ffffff']), w: rnd(2.5, 4.5), kind: 'ember',
      });
    }
    this.flashes.push({ x: pos.x, y: pos.y, z: pos.z, life: 0, max: 0.2, r: Math.min(0.6, len * 0.8), color: '#ff6a1a' });
  }

  // glowing cracks running out across the floor, with a ring
  floorCracks(x, z, reach = 1.2, life = 0.9, style = 'quake') {
    const color = STYLE[style]?.core || '#ff9a2e';
    const rays = [];
    const n = 6 + Math.floor(Math.random() * 4);
    for (let i = 0; i < n; i++) {
      let a = (i / n) * Math.PI * 2 + Math.random() * 0.5;
      const pts = [[0, 0]];
      let d = 0;
      const L = reach * rnd(0.55, 1.15);
      while (d < L) { d += rnd(0.12, 0.28); a += rnd(-0.35, 0.35); pts.push([Math.cos(a) * d, Math.sin(a) * d]); }
      rays.push(pts);
    }
    this.cracks.push({ x, z, rays, life: 0, max: life, color });
    this.rings.push({ x, y: 0.02, z, life: 0, max: life * 0.7, r0: 0.2, r1: reach * 1.6, color });
  }

  // a burst of rock out of the floor (GRIZZLY's ground wave)
  rockSpike(x, z, h = 0.5) {
    for (let i = 0; i < 3; i++) {
      this.addPart({ x: x + rnd(-0.1, 0.1), y: 0.05, z: z + rnd(-0.1, 0.1), vx: rnd(-0.6, 0.6), vy: rnd(2, 4) * (h / 0.5), vz: rnd(-0.6, 0.6), life: 0, max: rnd(0.45, 0.7), g: -12, color: pick(['#ffc46b', '#c98a4a', '#ff9a2e']), w: rnd(4, 7), kind: 'chunk' });
    }
    if (Math.random() < 0.5) this.puff(x, 0.08, z, '#8a6a4a', 1, 0.3);
  }

  // ---- super moves -----------------------------------------------------------
  // Aura: called every frame of a super with points on the fighter's body
  // (fists, feet, spine); each style sheds its own kind of energy
  aura(style, pts, color, dt) {
    if (!pts.length || dt <= 0) return;
    const n = Math.max(1, Math.round(dt * 240));
    for (let i = 0; i < n; i++) {
      const p = pick(pts);
      const o = { x: p.x + rnd(-0.08, 0.08), y: p.y + rnd(-0.08, 0.08), z: p.z + rnd(-0.08, 0.08) };
      switch (style) {
        case 'fire':
          this.addPart({ ...o, vx: rnd(-0.3, 0.3), vy: rnd(0.8, 2.2), vz: rnd(-0.3, 0.3), life: 0, max: rnd(0.35, 0.7), g: 2.5, color: pick(['#ffd36b', '#ff8a2a', '#ff3b1f']), w: rnd(2, 4.5), kind: 'ember' });
          break;
        case 'volt':
          if (Math.random() < 0.35) {
            const a = Math.random() * Math.PI * 2, e = rnd(-0.8, 0.8), l = rnd(0.15, 0.4);
            this.bolts.push({ ...o, dx: Math.cos(a) * l, dy: Math.sin(e) * l, dz: Math.sin(a) * l, life: 0, max: rnd(0.06, 0.12), seed: Math.random() * 1000 });
          } else this.addPart({ ...o, vx: rnd(-1, 1), vy: rnd(-0.5, 1), vz: rnd(-1, 1), life: 0, max: rnd(0.15, 0.3), g: 0, color: pick(['#e3c2ff', '#b45cff', '#ffffff']), w: 1.6, kind: 'spark' });
          break;
        case 'quake':
          this.addPart({ x: o.x, y: rnd(0.05, 0.4), z: o.z, vx: rnd(-0.8, 0.8), vy: rnd(0.6, 1.8), vz: rnd(-0.8, 0.8), life: 0, max: rnd(0.4, 0.8), g: -3, color: pick(['#c98a4a', '#ff9a2e', '#8a6a4a']), w: rnd(2.5, 4.5), kind: 'chunk' });
          break;
        case 'shadow':
          if (Math.random() < 0.4) this.addSmoke({ ...o, vx: rnd(-0.2, 0.2), vy: rnd(0.3, 0.8), vz: rnd(-0.2, 0.2), life: 0, max: rnd(0.4, 0.7), r: rnd(0.1, 0.2), color: '#06121a' });
          else this.addPart({ ...o, vx: rnd(-0.4, 0.4), vy: rnd(0.2, 1), vz: rnd(-0.4, 0.4), life: 0, max: rnd(0.25, 0.45), g: 0, color: pick(['#2ee6ff', '#9ff5ff']), w: 1.8, kind: 'ember' });
          break;
        default:
          this.addPart({ ...o, vx: rnd(-0.3, 0.3), vy: rnd(0.5, 1.5), vz: rnd(-0.3, 0.3), life: 0, max: 0.5, g: 1, color, w: 2.5, kind: 'ember' });
      }
    }
  }

  // Charge: energy streaking inward to the fighter from all around, then a ring
  chargeBurst(pos, color) {
    for (let i = 0; i < 70; i++) {
      const a = Math.random() * Math.PI * 2, e = rnd(-0.7, 0.9), r = rnd(1.2, 2.2), life = rnd(0.35, 0.6);
      const x = pos.x + Math.cos(a) * Math.cos(e) * r, y = pos.y + Math.sin(e) * r, z = pos.z + Math.sin(a) * Math.cos(e) * r;
      this.addPart({ x, y, z, vx: (pos.x - x) / life, vy: (pos.y - y) / life, vz: (pos.z - z) / life, life: 0, max: life, g: 0, color: Math.random() < 0.3 ? '#ffffff' : color, w: 2.6, kind: 'converge' });
    }
    this.rings.push({ ...pos, life: -0.45, max: 0.5, r0: 0.1, r1: 1.6, color, billboard: true });
    this.flashes.push({ ...pos, life: -0.45, max: 0.3, r: 0.8, color });
  }

  // The super's last blow: one signature effect per style
  finisher(style, pos, color) {
    const fl = { x: pos.x, y: 0.02, z: pos.z };
    switch (style) {
      case 'fire': // a pillar of flame erupting from the floor under the defender
        for (let i = 0; i < 160; i++) {
          const a = Math.random() * Math.PI * 2, r = rnd(0, 0.45);
          this.addPart({ x: pos.x + Math.cos(a) * r, y: rnd(0, 0.4), z: pos.z + Math.sin(a) * r, vx: Math.cos(a) * rnd(0.2, 0.8), vy: rnd(3, 8), vz: Math.sin(a) * rnd(0.2, 0.8), life: 0, max: rnd(0.6, 1.3), g: 0.5, color: pick(['#ffffff', '#ffd36b', '#ff8a2a', '#ff3b1f', '#ff3b1f']), w: rnd(3, 6), kind: 'ember' });
        }
        this.flashes.push({ x: pos.x, y: 1.2, z: pos.z, life: 0, max: 0.5, r: 1.6, color: '#ff6a1a' });
        this.rings.push({ ...fl, life: 0, max: 0.9, r0: 0.3, r1: 3.6, color: '#ff8a2a' });
        this.rings.push({ ...fl, life: -0.15, max: 0.9, r0: 0.2, r1: 2.4, color: '#ffd36b' });
        break;
      case 'volt': { // lightning falls from the sky onto the defender
        for (let b = 0; b < 3; b++) {
          this.skyBolts.push({ x0: pos.x + rnd(-1.5, 1.5), y0: 7, z0: pos.z + rnd(-1.5, 1.5), x1: pos.x + rnd(-0.1, 0.1), y1: pos.y, z1: pos.z + rnd(-0.1, 0.1), life: -b * 0.06, max: 0.45, seed: Math.random() * 1000, w: b ? 3 : 7 });
        }
        for (let i = 0; i < 8; i++) {
          const a = Math.random() * Math.PI * 2;
          this.bolts.push({ x: pos.x, y: 0.05, z: pos.z, dx: Math.cos(a) * rnd(0.8, 1.6), dy: 0, dz: Math.sin(a) * rnd(0.8, 1.6), life: 0, max: rnd(0.2, 0.35), seed: Math.random() * 1000 });
        }
        this.flashes.push({ x: pos.x, y: pos.y, z: pos.z, life: 0, max: 0.4, r: 1.4, color: '#b45cff' });
        this.rings.push({ ...fl, life: 0, max: 0.7, r0: 0.3, r1: 3.2, color: '#b45cff' });
        break;
      }
      case 'quake': // the floor caves in: staggered shock rings and erupting rock
        for (let k = 0; k < 3; k++) this.rings.push({ ...fl, life: -k * 0.12, max: 0.9, r0: 0.3, r1: 2.2 + k * 1.2, color: k ? '#c98a4a' : '#ffc46b' });
        for (let i = 0; i < 70; i++) {
          const a = Math.random() * Math.PI * 2, r = rnd(0.2, 1.4);
          this.addPart({ x: pos.x + Math.cos(a) * r, y: 0.05, z: pos.z + Math.sin(a) * r, vx: Math.cos(a) * rnd(0.5, 2.5), vy: rnd(3, 7), vz: Math.sin(a) * rnd(0.5, 2.5), life: 0, max: rnd(0.8, 1.4), g: -12, color: pick(['#c98a4a', '#8a6a4a', '#ff9a2e', '#ffc46b']), w: rnd(4, 9), kind: 'chunk' });
        }
        this.puff(pos.x, 0.15, pos.z, '#7a5a3a', 26, 0.55);
        this.flashes.push({ x: pos.x, y: 0.4, z: pos.z, life: 0, max: 0.35, r: 1.2, color: '#ff9a2e' });
        break;
      case 'shadow': // two blade-light slashes cross the whole screen
        this.screenSlashes.push({ x: pos.x, y: pos.y, z: pos.z, a: -0.45, life: 0, max: 0.55, color: '#2ee6ff' });
        this.screenSlashes.push({ x: pos.x, y: pos.y, z: pos.z, a: 0.5, life: -0.08, max: 0.55, color: '#9ff5ff' });
        this.puff(pos.x, pos.y, pos.z, '#06121a', 18, 0.35);
        this.flashes.push({ x: pos.x, y: pos.y, z: pos.z, life: 0, max: 0.3, r: 1.0, color: '#2ee6ff' });
        break;
      default:
        this.flashes.push({ x: pos.x, y: pos.y, z: pos.z, life: 0, max: 0.4, r: 1.2, color });
    }
  }

  screenFlash(color = 'rgba(255,255,255,0.55)', ms = 90) {
    // pure CSS animation: always ends at opacity 0, even if frames are throttled
    const el = this.flashEl;
    el.style.background = color;
    el.style.setProperty('--flash-peak', String(this.flashScale));
    el.style.animation = 'none';
    void el.offsetWidth;
    el.style.animation = `flashFade ${ms * 3}ms ease-out forwards`;
  }

  // world -> screen, false when behind the camera or not finite
  project(x, y, z, out) {
    const s = this.camera.toScreen(x, y, z, out);
    return s.z > 0 && Number.isFinite(s.x) && Number.isFinite(s.y);
  }

  // projected size (px) of a world length at a point
  pxPerMetre(x, y, z) {
    const a = this.camera.toScreen(x, y, z, this.p);
    const ax = a.x, ay = a.y;
    const b = this.camera.toScreen(x, y + 1, z, this.q);
    return Math.hypot(b.x - ax, b.y - ay);
  }

  // Project the fighters' body capsules once per frame for occlusion tests
  buildOccluders() {
    this.occ.length = 0;
    const caps = this.bodies?.();
    if (!caps) return;
    const a = { x: 0, y: 0, z: 0 }, b = { x: 0, y: 0, z: 0 };
    for (const [A, B, r] of caps) {
      if (!this.project(A.x, A.y, A.z, a) || !this.project(B.x, B.y, B.z, b)) continue;
      const k = this.pxPerMetre((A.x + B.x) / 2, (A.y + B.y) / 2, (A.z + B.z) / 2);
      this.occ.push({ ax: a.x, ay: a.y, az: a.z, bx: b.x, by: b.y, bz: b.z, r: r * k, rz: r });
    }
  }

  // true when screen point (sx, sy) at depth sz lies behind a body capsule
  hidden(sx, sy, sz) {
    for (const o of this.occ) {
      const ex = o.bx - o.ax, ey = o.by - o.ay;
      const len2 = ex * ex + ey * ey || 1;
      const t = Math.max(0, Math.min(1, ((sx - o.ax) * ex + (sy - o.ay) * ey) / len2));
      const dx = sx - (o.ax + ex * t), dy = sy - (o.ay + ey * t);
      if (dx * dx + dy * dy > o.r * o.r) continue;
      // behind the capsule's centre line (with half a radius of slack, so
      // effects ON the body surface facing the camera still show)
      if (sz > o.az + (o.bz - o.az) * t + o.rz * 0.5) return true;
    }
    return false;
  }

  // dt: effect time (slowed but running through a hitstop)
  // gdt: game time (0 during a hitstop) - swing trails age with the bodies
  update(dt, gdt = dt) {
    // Gaussian floor shockwave on the arena splats
    if (this.shock) {
      const s = this.shock;
      s.t += dt;
      const p = s.t / s.dur;
      if (p >= 1) { this.env.setShock(null); this.shock = null; }
      else this.env.setShock({ origin: { x: s.x, y: 0, z: s.z }, radius: 0.2 + p * 7, halfWidth: 0.45 + p * 0.6, strength: s.strength * (1 - p) });
    }

    const ctx = this.ctx, dpr = this.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.cv.width, this.cv.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.buildOccluders();

    // smoke first (normal blending, under the glow)
    ctx.globalCompositeOperation = 'source-over';
    for (let i = this.smoke.length - 1; i >= 0; i--) {
      const s = this.smoke[i];
      s.life += dt;
      const k = s.life / s.max;
      if (k >= 1) { this.smoke.splice(i, 1); continue; }
      s.x += s.vx * dt; s.y += s.vy * dt; s.z += s.vz * dt;
      s.vx *= 1 - dt * 2; s.vz *= 1 - dt * 2;
      if (!this.project(s.x, s.y, s.z, this.p) || this.hidden(this.p.x, this.p.y, this.p.z)) continue;
      const rad = this.pxPerMetre(s.x, s.y, s.z) * s.r * (0.6 + k * 0.8);
      if (!(rad > 0.5) || !Number.isFinite(rad)) continue;
      const grd = ctx.createRadialGradient(this.p.x, this.p.y, 0, this.p.x, this.p.y, rad);
      grd.addColorStop(0, s.color);
      grd.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.globalAlpha = 0.55 * (1 - k);
      ctx.fillStyle = grd;
      ctx.beginPath();
      ctx.arc(this.p.x, this.p.y, rad, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.globalCompositeOperation = 'lighter';

    // glowing floor cracks: they light up fast, then cool and fade
    for (let i = this.cracks.length - 1; i >= 0; i--) {
      const c = this.cracks[i];
      c.life += dt;
      const k = c.life / c.max;
      if (k >= 1) { this.cracks.splice(i, 1); continue; }
      const grow = Math.min(1, k * 8);
      for (const [w, col, al] of [[5, c.color, 0.45], [1.8, '#fff3d0', 0.9]]) {
        ctx.strokeStyle = col;
        ctx.lineWidth = w * (1 - k * 0.5);
        ctx.globalAlpha = al * (1 - k * k);
        ctx.beginPath();
        for (const ray of c.rays) {
          const m = Math.max(2, Math.ceil(ray.length * grow));
          for (let j = 0; j < m; j++) {
            if (!this.project(c.x + ray[j][0], 0.015, c.z + ray[j][1], this.p)) break;
            if (j) ctx.lineTo(this.p.x, this.p.y); else ctx.moveTo(this.p.x, this.p.y);
          }
        }
        ctx.stroke();
      }
    }

    this.drawTrails(ctx, gdt);

    // contact cores
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i];
      f.life += dt;
      const k = f.life / f.max;
      if (k >= 1) { this.flashes.splice(i, 1); continue; }
      if (k < 0 || !this.project(f.x, f.y, f.z, this.p)) continue; // (k < 0: not started yet)
      const sx = this.p.x, sy = this.p.y;
      // (capped on screen: with the camera in close a world-sized glow swallowed the frame)
      const rad = Math.min(this.cv.height / this.dpr * 0.22, this.pxPerMetre(f.x, f.y, f.z) * f.r * (1 - k * 0.4));
      if (!(rad > 0.5) || !Number.isFinite(rad)) continue;
      const grd = ctx.createRadialGradient(sx, sy, 0, sx, sy, rad);
      grd.addColorStop(0, 'rgba(255,255,255,0.95)');
      grd.addColorStop(0.35, f.color);
      grd.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.globalAlpha = 1 - k;
      ctx.fillStyle = grd;
      ctx.beginPath();
      ctx.arc(sx, sy, rad, 0, Math.PI * 2);
      ctx.fill();
    }

    // projectiles of the skills
    for (const pr of this.projs) this.drawProjectile(ctx, pr);

    // impact flares: thin tapered spikes bursting out of the contact
    for (let i = this.flares.length - 1; i >= 0; i--) {
      const f = this.flares[i];
      f.life += dt;
      const k = f.life / f.max;
      if (k >= 1) { this.flares.splice(i, 1); continue; }
      if (!this.project(f.x, f.y, f.z, this.p)) continue;
      const cx = this.p.x, cy = this.p.y;
      const L = Math.min(this.cv.height / this.dpr * 0.3, this.pxPerMetre(f.x, f.y, f.z) * f.len * (0.4 + 0.6 * Math.sqrt(k)));
      if (!Number.isFinite(L)) continue;
      ctx.globalAlpha = 1 - k;
      for (let s = 0; s < f.n; s++) {
        const a = f.rot + (s / f.n) * Math.PI * 2 + (s % 2) * 0.2;
        const len = L * (s % 2 ? 0.55 : 1);
        // spikes stay thin needles at any distance (they widened into wedges up close)
        const w = Math.min(3, (s % 2 ? 2.5 : 4) * (1 - k) * Math.max(0.4, L / 240));
        const ux = Math.cos(a), uy = Math.sin(a);
        ctx.fillStyle = s % 3 === 0 ? '#ffffff' : f.color;
        ctx.beginPath();
        ctx.moveTo(cx + ux * len * 0.15 - uy * w, cy + uy * len * 0.15 + ux * w);
        ctx.lineTo(cx + ux * len, cy + uy * len);
        ctx.lineTo(cx + ux * len * 0.15 + uy * w, cy + uy * len * 0.15 - ux * w);
        ctx.fill();
      }
    }

    // lightning arcs: re-jagged every few frames for a flicker
    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const b = this.bolts[i];
      b.life += dt;
      const k = b.life / b.max;
      if (k >= 1) { this.bolts.splice(i, 1); continue; }
      if (!this.project(b.x, b.y, b.z, this.p)) continue;
      const x0 = this.p.x, y0 = this.p.y;
      const ex = b.x + b.dx * (0.5 + k), ey = b.y + b.dy * (0.5 + k), ez = b.z + b.dz * (0.5 + k);
      if (!this.project(ex, ey, ez, this.q) || this.hidden(this.q.x, this.q.y, this.q.z)) continue;
      const x1 = this.q.x, y1 = this.q.y;
      const seg = 6, jitter = Math.hypot(x1 - x0, y1 - y0) * 0.18;
      let seed = b.seed + Math.floor(b.life * 40);
      const r = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280 - 0.5; };
      const nx = -(y1 - y0), ny = x1 - x0, nl = Math.hypot(nx, ny) || 1;
      const path = [[x0, y0]];
      for (let s = 1; s < seg; s++) {
        const t = s / seg, o = r() * jitter * 2;
        path.push([x0 + (x1 - x0) * t + (nx / nl) * o, y0 + (y1 - y0) * t + (ny / nl) * o]);
      }
      path.push([x1, y1]);
      for (const [w, c, al] of [[6, '#b45cff', 0.5], [2, '#ffffff', 1]]) {
        ctx.strokeStyle = c;
        ctx.lineWidth = w * (1 - k * 0.5);
        ctx.globalAlpha = al * (1 - k);
        ctx.beginPath();
        path.forEach(([px, py], j) => (j ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
        ctx.stroke();
      }
    }

    // lightning from the sky: a jagged bolt between two world points, re-jagged
    // every few frames, with a wide violet glow under a white core
    for (let i = this.skyBolts.length - 1; i >= 0; i--) {
      const b = this.skyBolts[i];
      b.life += dt;
      const k = b.life / b.max;
      if (k >= 1) { this.skyBolts.splice(i, 1); continue; }
      if (k < 0) continue;
      if (!this.project(b.x0, b.y0, b.z0, this.p) || !this.project(b.x1, b.y1, b.z1, this.q)) continue;
      const x0 = this.p.x, y0 = this.p.y, x1 = this.q.x, y1 = this.q.y;
      let seed = b.seed + Math.floor(b.life * 30);
      const r = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280 - 0.5; };
      const nx = -(y1 - y0), ny = x1 - x0, nl = Math.hypot(nx, ny) || 1, seg = 14, jit = Math.hypot(x1 - x0, y1 - y0) * 0.06;
      const path = [[x0, y0]];
      for (let s = 1; s < seg; s++) { const t = s / seg, o = r() * jit * 2; path.push([x0 + (x1 - x0) * t + (nx / nl) * o, y0 + (y1 - y0) * t + (ny / nl) * o]); }
      path.push([x1, y1]);
      const flick = 0.6 + 0.4 * Math.sin(b.life * 90);
      for (const [w, c, al] of [[b.w * 3.5, '#7a3cff', 0.45], [b.w * 1.6, '#c79cff', 0.8], [b.w * 0.6, '#ffffff', 1]]) {
        ctx.strokeStyle = c; ctx.lineWidth = w * (1 - k * 0.6); ctx.globalAlpha = al * (1 - k) * flick;
        ctx.beginPath(); path.forEach(([px, py], j) => (j ? ctx.lineTo(px, py) : ctx.moveTo(px, py))); ctx.stroke();
      }
    }

    // screen slashes: a blade of light across the whole screen through a point
    const W = this.cv.width / dpr, H = this.cv.height / dpr;
    for (let i = this.screenSlashes.length - 1; i >= 0; i--) {
      const s = this.screenSlashes[i];
      s.life += dt;
      const k = s.life / s.max;
      if (k >= 1) { this.screenSlashes.splice(i, 1); continue; }
      if (k < 0 || !this.project(s.x, s.y, s.z, this.p)) continue;
      const ux = Math.cos(s.a), uy = Math.sin(s.a), L = Math.hypot(W, H);
      const grow = Math.min(1, k * 6); // the cut sweeps across in ~0.1 s, then fades
      const ax = this.p.x - ux * L * 0.6, ay = this.p.y - uy * L * 0.6;
      const bx = ax + ux * L * 1.2 * grow, by = ay + uy * L * 1.2 * grow;
      for (const [w, c, al] of [[26, s.color, 0.35], [9, s.color, 0.8], [3, '#ffffff', 1]]) {
        ctx.strokeStyle = c; ctx.lineWidth = w * (1 - k); ctx.globalAlpha = al * (1 - k * k);
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
      }
    }

    // slashes: a long thin crescent streak across the contact, in screen space
    for (let i = this.slashes.length - 1; i >= 0; i--) {
      const s = this.slashes[i];
      s.life += dt;
      if (s.life < 0) continue;
      const k = s.life / s.max;
      if (k >= 1) { this.slashes.splice(i, 1); continue; }
      if (!this.project(s.x, s.y, s.z, this.p)) continue;
      const L = this.pxPerMetre(s.x, s.y, s.z) * s.len;
      if (!Number.isFinite(L)) continue;
      const ux = Math.cos(s.a), uy = Math.sin(s.a);
      const grow = Math.min(1, k * 4); // the cut draws across fast, then fades
      const ax = this.p.x - ux * L * 0.5, ay = this.p.y - uy * L * 0.5;
      const bx = ax + ux * L * grow, by = ay + uy * L * grow;
      const w = 7 * (1 - k);
      ctx.globalAlpha = 1 - k;
      for (const [ww, c] of [[w * 2.2, s.color], [w * 0.7, '#ffffff']]) {
        ctx.fillStyle = c;
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.quadraticCurveTo((ax + bx) / 2 - uy * ww, (ay + by) / 2 + ux * ww, bx, by);
        ctx.quadraticCurveTo((ax + bx) / 2 - uy * ww * 0.3, (ay + by) / 2 + ux * ww * 0.3, ax, ay);
        ctx.fill();
      }
    }

    // rings: billboarded around the contact, or lying on the floor in perspective
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      r.life += dt;
      const k = r.life / r.max;
      if (k >= 1) { this.rings.splice(i, 1); continue; }
      if (k < 0) continue;
      const rad = r.r0 + (r.r1 - r.r0) * (1 - (1 - k) * (1 - k));
      ctx.strokeStyle = r.color;
      ctx.globalAlpha = (1 - k) * 0.9;
      ctx.lineWidth = 5 * (1 - k) + 1;
      ctx.beginPath();
      if (r.billboard) {
        if (!this.project(r.x, r.y, r.z, this.p)) continue;
        const px = this.pxPerMetre(r.x, r.y, r.z) * rad;
        if (!Number.isFinite(px)) continue;
        if (r.hex) {
          // a guard's hexagonal "shield" ping
          for (let s = 0; s <= 6; s++) {
            const a = (s / 6) * Math.PI * 2 + Math.PI / 6;
            const hx = this.p.x + Math.cos(a) * px, hy = this.p.y + Math.sin(a) * px;
            if (s === 0) ctx.moveTo(hx, hy); else ctx.lineTo(hx, hy);
          }
        } else ctx.arc(this.p.x, this.p.y, px, 0, Math.PI * 2);
      } else {
        let ok = true;
        for (let s = 0; s <= 40; s++) {
          const a = (s / 40) * Math.PI * 2;
          if (!this.project(r.x + Math.cos(a) * rad, r.y, r.z + Math.sin(a) * rad, this.p)) { ok = false; break; }
          if (s === 0) ctx.moveTo(this.p.x, this.p.y); else ctx.lineTo(this.p.x, this.p.y);
        }
        if (!ok) continue;
      }
      ctx.stroke();
    }

    // sparks, embers and chunks: 3D particles that fall (or rise) and bounce
    for (let i = this.parts.length - 1; i >= 0; i--) {
      const p = this.parts[i];
      p.life += dt;
      const k = p.life / p.max;
      if (k >= 1) { this.parts.splice(i, 1); continue; }
      p.vy += p.g * dt;
      const drag = p.kind === 'converge' ? 0 : p.kind === 'ember' ? 2.5 : 1.5;
      p.vx *= 1 - dt * drag; p.vz *= 1 - dt * drag;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      if (p.y < 0.01) { p.y = 0.01; p.vy = Math.abs(p.vy) * (p.kind === 'chunk' ? 0.25 : 0.35); p.vx *= 0.6; p.vz *= 0.6; }
      if (!this.project(p.x, p.y, p.z, this.p)) continue;
      const ax = this.p.x, ay = this.p.y;
      if (this.hidden(ax, ay, this.p.z)) continue;
      ctx.globalAlpha = 1 - k;
      if (p.kind === 'ember') {
        // embers: soft flickering dots
        ctx.fillStyle = p.color;
        ctx.globalAlpha = (1 - k) * (0.6 + 0.4 * Math.sin(p.life * 40 + i));
        ctx.beginPath();
        ctx.arc(ax, ay, p.w * (1 - k * 0.5), 0, Math.PI * 2);
        ctx.fill();
        continue;
      }
      if (p.kind === 'chunk') {
        ctx.fillStyle = p.color;
        const s = p.w * (1 - k * 0.4);
        ctx.save();
        ctx.translate(ax, ay);
        ctx.rotate(p.life * 14 + i);
        ctx.fillRect(-s / 2, -s / 2, s, s);
        ctx.restore();
        continue;
      }
      if (!this.project(p.x - p.vx * 0.025, p.y - p.vy * 0.025, p.z - p.vz * 0.025, this.q)) continue;
      ctx.strokeStyle = p.color;
      ctx.lineWidth = p.w * (1 - k * 0.6);
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(this.q.x, this.q.y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  // Swing trails: a tapered ribbon along the last ~0.11 s of a fist or foot,
  // wide and bright at the limb, thinning to nothing at the tail
  drawTrails(ctx, gdt) {
    const LIFE = 0.11;
    for (const [key, t] of this.trails) {
      for (const p of t.pts) p.age += gdt;
      while (t.pts.length && t.pts[0].age > LIFE) t.pts.shift();
      if (t.pts.length < 3) { if (!t.pts.length) this.trails.delete(key); continue; }
      const sp = [];
      for (const p of t.pts) {
        if (!this.project(p.x, p.y, p.z, this.p)) continue;
        const k = 1 - p.age / LIFE;
        // (capped on screen so a close camera doesn't turn the ribbon into a wedge)
        const w = Math.min(16 * p.w, this.pxPerMetre(p.x, p.y, p.z) * 0.07 * p.w) * k;
        sp.push({ x: this.p.x, y: this.p.y, w, k, hid: this.hidden(this.p.x, this.p.y, this.p.z) });
      }
      if (sp.length < 3) continue;
      // too short on screen to read as a swing (a frozen limb): would draw as a blob
      let span = 0;
      for (let j = 1; j < sp.length; j++) span += Math.hypot(sp[j].x - sp[j - 1].x, sp[j].y - sp[j - 1].y);
      if (span < Math.max(14, sp.at(-1).w * 3)) continue;
      // ribbon edges from the screen-space normal at each sample
      const L = [], R = [];
      for (let j = 0; j < sp.length; j++) {
        const a = sp[Math.max(0, j - 1)], b = sp[Math.min(sp.length - 1, j + 1)];
        let nx = -(b.y - a.y), ny = b.x - a.x;
        const nl = Math.hypot(nx, ny) || 1;
        nx /= nl; ny /= nl;
        const w = sp[j].hid ? 0 : sp[j].w;
        L.push([sp[j].x + nx * w, sp[j].y + ny * w]);
        R.push([sp[j].x - nx * w, sp[j].y - ny * w]);
      }
      const head = sp[sp.length - 1], tail = sp[0];
      const grd = ctx.createLinearGradient(tail.x, tail.y, head.x, head.y);
      grd.addColorStop(0, 'rgba(0,0,0,0)');
      grd.addColorStop(0.6, t.color);
      grd.addColorStop(1, '#ffffff');
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = grd;
      ctx.beginPath();
      L.forEach(([x, y], j) => (j ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      for (let j = R.length - 1; j >= 0; j--) ctx.lineTo(R[j][0], R[j][1]);
      ctx.closePath();
      ctx.fill();
    }
  }

  // fireball: a glowing orb with a hot core; kunai: a cyan streak of light.
  // (The ground wave draws through its rock and dust particles.)
  drawProjectile(ctx, pr) {
    const P = this.p, Q = this.q;
    if (pr.kind !== 'fireball' && pr.kind !== 'kunai') return;
    if (!this.project(pr.x, pr.y, pr.z, P)) return;
    const ppm = this.pxPerMetre(pr.x, pr.y, pr.z);
    if (!Number.isFinite(ppm)) return;
    const H = this.cv.height / this.dpr;
    const cx = P.x, cy = P.y;
    // a fading streak behind it
    if (!this.project(pr.x - pr.vx * 0.06, pr.y, pr.z - pr.vz * 0.06, Q)) return;
    const color = pr.kind === 'fireball' ? '#ff6a1a' : '#2ee6ff';
    const R = Math.min(H * 0.1, ppm * (pr.kind === 'fireball' ? 0.22 : 0.08));
    const grdT = ctx.createLinearGradient(Q.x, Q.y, cx, cy);
    grdT.addColorStop(0, 'rgba(0,0,0,0)');
    grdT.addColorStop(1, color);
    ctx.globalAlpha = 0.8;
    ctx.strokeStyle = grdT;
    ctx.lineCap = 'round';
    ctx.lineWidth = R * 1.2;
    ctx.beginPath(); ctx.moveTo(Q.x, Q.y); ctx.lineTo(cx, cy); ctx.stroke();
    // the glowing body
    const flick = 0.9 + 0.1 * Math.sin(pr.t * 60);
    const grd = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 1.8 * flick);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.3, pr.kind === 'fireball' ? '#ffd36b' : '#9ff5ff');
    grd.addColorStop(0.6, color);
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.globalAlpha = 1;
    ctx.fillStyle = grd;
    ctx.beginPath(); ctx.arc(cx, cy, R * 1.8 * flick, 0, Math.PI * 2); ctx.fill();
  }
}
