// Splat Fighter - a 1v1 fighting game whose fighters and arena are PINOC
// Gaussian splats rendered by @viggle/splat-engine on PlayCanvas.
import { Scene, Character, Animation, Environment, setAssetFetch } from '@viggle/splat-engine';
import { Quat, Vec3, GSPLAT_RENDERER_RASTER_GPU_SORT } from 'playcanvas';
import { ROSTER, CLIPS, TUNING, ARENA, STAGES, MOVES, STARTERS, COMBOS } from './config.js';
import { Fighter } from './fighter.js';
import { MatchLoader } from './match-loader.js';
import { AI, DIFFICULTY } from './ai.js';
import { FightCamera } from './camera.js';
import { FX } from './fx.js';
import { Input } from './input.js';
import { isTouchDevice } from './touch.js';

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MOTION_VERSION = 15;

// Where a strike can actually touch someone. For every frame of the move it
// samples each striking joint (fists, feet, elbows, knees) around the move's
// starting pelvis, keeping the pelvis travel only along the facing, as the game
// applies it. It then finds the smallest turn away from squarely facing the
// opponent that puts one of those joints on a body standing in front, and the
// furthest distance that still connects. Turning the whole body until the
// furthest-out limb pointed at the target made roundhouses and hooks face
// 70-90 degrees off to the side.
const STRIKE_JOINTS = ['hand_l', 'hand_r', 'foot_l', 'foot_r', 'lowerarm_l', 'lowerarm_r', 'calf_l', 'calf_r'];
function measureStrike(probe, numFrames, start, heading, joints = STRIKE_JOINTS, low = false) {
  const arm = probe.armature;
  const pel = arm.boneNames.indexOf('pelvis');
  const js = joints.map((n) => arm.boneNames.indexOf(n)).filter((i) => i >= 0);
  if (pel < 0 || !js.length) return null;
  const P = (i) => { const t = arm.getBoneWorldMatrix(i).getTranslation(); return [t.x, t.y, t.z]; };
  const NEED = -0.08; // solid contact: 8 cm into the body's surface
  const f0 = Math.max(1, Math.round(start));
  const f1 = Math.min(numFrames - 6, f0 + Math.round((numFrames - f0) * 0.7));
  probe.animationTime = f0; arm.update(0.0001);
  const o = P(pel);
  const frames = [];
  for (let f = f0 + 2; f <= f1; f++) {
    probe.animationTime = f; arm.update(0.0001);
    const q = P(pel);
    const j = js.map((i) => { const p = P(i); return [p[0] - q[0], p[1], p[2] - q[2]]; });
    // each joint's speed against the body (m per clip frame)
    const prev = frames.at(-1)?.j;
    const v = j.map((p, k) => (prev ? Math.hypot(p[0] - prev[k][0], p[1] - prev[k][1], p[2] - prev[k][2]) : 0));
    frames.push({ f, px: q[0] - o[0], pz: q[2] - o[2], j, v });
  }
  // closest joint-to-body gap (m, negative = touching) with direction `phi`
  // (degrees, clip frame) pointed at a body `D` metres away. `first` is the
  // first frame a SWINGING joint (>= 1.5 m/s) lands solidly: the blow itself.
  // The closest frame alone picked a haymaker's follow-through wrapping
  // across the body (impact frame 40 for a punch that lands at 13) and guard
  // hands resting on a target placed close (impact before the wind-up).
  const gapAt = (phi, D) => {
    const a = (phi * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    let gap = 9, f = -1, first = -1;
    for (const fr of frames) {
      const travel = Math.max(-0.4, Math.min(0.8, fr.px * s + fr.pz * c));
      fr.j.forEach((j, k) => {
        const x = j[0] * c - j[2] * s, z = j[0] * s + j[2] * c + travel;
        // (the body spans hips to head; a low attack may also land on the legs)
        const y = Math.min(1.55, Math.max(low ? 0.1 : 0.95, j[1]));
        const d = Math.hypot(x, z - D, j[1] - y) - 0.32;
        if (d < gap) { gap = d; f = fr.f; }
        if (first < 0 && d <= NEED && fr.v[k] >= 0.05) first = fr.f;
      });
    }
    return { gap, f, first };
  };
  // furthest distance at which the blow still lands solidly
  const reachAt = (p) => { for (let D = 1.75; D >= 0.7; D -= 0.05) if (gapAt(p, D).gap <= NEED) return D; return 0; };
  // most reach for the least turn: each degree off square costs 3 mm
  let phi = heading, reach = 0, best = -9;
  for (let k = -12; k <= 12; k++) {
    const p = heading + k * 5, r = reachAt(p);
    const score = r - Math.abs(k) * 5 * 0.003;
    if (r && score > best) { best = score; phi = p; reach = r; }
  }
  if (!reach) reach = Math.max(0.7, 0.7 - (gapAt(phi, 0.7).gap - NEED));
  const at = gapAt(phi, Math.min(reach - 0.05, 1.0));
  return { yaw: Math.round(phi), impact: at.first >= 0 ? at.first : at.f, reach: +reach.toFixed(2) };
}
window.__measureStrike = measureStrike;

class Game {
  constructor() {
    this.canvas = $('view');
    this.phase = 'boot';
    // high (48K splats) | perf (16K) | low (16K, 70% resolution, light effects)
    // - a saved choice wins, else a guess from the device (see detectQuality)
    this.quality = Game.savedQuality() || Game.detectQuality();
    // lighter scenes on phones / tablets and on machines that start on the
    // light tier (?full forces the full scenes, ?lite the light ones)
    const qs = new URLSearchParams(location.search);
    this.useLiteStages = qs.has('lite') || (!qs.has('full') && (isTouchDevice() || this.quality === 'low'));
    this.difficulty = 'normal';
    this.showGhosts = true;
    this.p1Index = 0;
    this.cpuIndex = 1;
    this.previews = [];
    this.fighters = [];
    this.matchLoader = new MatchLoader((pair) => pair.forEach((f) => f.destroy()));
    this.wins = [0, 0];
    this.round = 1;
    this.timeScale = 1;
    this.hitstop = 0;
    this.slow = null;
    this.paused = false;
    this.photo = false;
    this.hudHidden = false;
    this.events = [];
    this.fps = 60;
    this.clock = 0;
    this.input = new Input();
  }

  // ---------------------------------------------------------------- boot
  progress(p, text) {
    $('loadFill').style.width = `${Math.round(p * 100)}%`;
    if (text) $('loadText').textContent = text;
    window.splatCompatibility?.progress();
  }

  async boot() {
    this.progress(0.03, '正在启动 PlayCanvas + Viggle Splat Engine…');
    this.scene = await Scene.create(this.canvas, {
      fov: 46, near: 0.05, far: 200, maxPixelRatio: 1, gsplatCulling: !new URLSearchParams(location.search).has('nocull'),
      // ?webgl forces the WebGL2 path older machines get (for testing)
      ...(window.splatCompatibility?.mode === 'webgl' ? { backend: 'webgl' } : {}),
      preserveDrawingBuffer: new URLSearchParams(location.search).has('debug'),
      bgColor: { r: 0.02, g: 0.02, b: 0.03, a: 1 },
      cameraPosition: { x: 0, y: 1.6, z: 5 }, cameraTarget: { x: 0, y: 1, z: 0 },
    });
    window.splatCompatibility?.watch(this.scene);
    if (window.splatCompatibility?.mode === 'raster' && this.scene.graphicsDevice.isWebGPU) {
      // Retain GPU sorting and all splats, avoiding the compute tile renderer.
      this.scene.app.scene.gsplat.renderer = GSPLAT_RENDERER_RASTER_GPU_SORT;
    }
    this.scene.start();
    this.camera = new FightCamera(this.scene, this.canvas);
    this.fx = new FX($('fx'), this.camera);
    // effects behind either fighter's body are hidden (splats write no depth)
    this.fx.bodies = () => (this.fighters.length === 2 ? this.fighters.flatMap((f) => f.bodyCapsules()) : null);

    this.progress(0.08, '正在载入 PINOC 高斯擂台…');
    this.stageId = Game.savedStage();
    const stageReady = this.loadStage(this.stageId);
    // Observe failures immediately while independent animation work proceeds.
    stageReady.catch(() => {});

    // shared clips plus every character's own stance, signature moves, special and win pose
    const own = new Set();
    for (const def of ROSTER) {
      for (const c of Object.values(def.clips || {})) if (!CLIPS.includes(c)) own.add(c);
      for (const mv of Object.values(def.moves || {})) if (mv.clip) own.add(mv.clip);
    }
    // ?v= busts the browser cache whenever motion files are swapped
    const urls = CLIPS.map((c) => [c, `./assets/motions/${c}.glb?v=${MOTION_VERSION}`]).concat([...own].map((c) => [c, `./assets/motions/chars/${c}.glb?v=${MOTION_VERSION}`]));
    this.progress(0.45, `正在载入 PINOC 动作（${urls.length} 段）…`);
    let done = 0;
    await Promise.all(urls.map(async ([name, url]) => {
      await Animation.loadGlb(this.scene, url, name);
      done++;
      this.progress(0.45 + 0.3 * (done / urls.length));
    }));

    await stageReady;
    this.progress(0.74, '正在校准动作朝向…');
    await this.measureClipHeadings();
    // A clip can't be crossfaded into itself, so loops alternate between the
    // clip and an alias of it ("name~") to re-enter smoothly.
    const lib = this.scene.skeletalAnimationLibrary;
    for (const name of [...lib.keys()]) if (!name.endsWith('~')) lib.set(`${name}~`, lib.get(name));
    this.trimClipMemory();

    this.progress(0.76, '正在载入 4 名高斯格斗家…');
    done = 0;
    // (phones show the menu fighters at 16K splats: a third of the memory and download)
    const mobile = isTouchDevice();
    this.previews = await Promise.all(ROSTER.map(async (def) => {
      const c = await Character.load(this.scene, mobile ? def.perf : def.high, { name: `preview_${def.id}` });
      c.prepareReveal();
      c.setActive(false);
      done++;
      this.progress(0.76 + 0.22 * (done / ROSTER.length));
      return c;
    }));

    await this.warmTileRenderer();
    this.progress(1, '完成');
    this.bindUI();
    this.scene.app.on('update', (dt) => this.update(dt));
    await sleep(250);
    $('loading').classList.add('hidden');
    this.enterMenu();
    window.splatCompatibility?.ready();
  }

  // Memory: PINOC clips carry tracks for all 441 bones of the full MetaHuman
  // skeleton (the face included), but the fighters' rig has 86 and reads only
  // tracks 0-85. The rest - 80% of ~170 MB of keyframes - never move and are
  // never read: drop them. The engine also keeps every downloaded clip file
  // (~67 MB for 118 clips) for re-use; all clips are parsed by now, so let
  // those go too. Together that was about a third of the page's memory, the
  // difference between running and crashing on many phones.
  trimClipMemory() {
    const keep = this.rigBones || 86;
    const seen = new Set();
    for (const anim of this.scene.skeletalAnimationLibrary.values()) {
      const ks = anim.skeletalStore?.keyframes;
      if (!ks || seen.has(ks)) continue;
      seen.add(ks);
      for (const bi of [...ks.keys()]) if (bi >= keep) ks.delete(bi);
    }
    Animation._bufferCache?.clear();
    Animation._convertedCache?.clear();
  }

  // WebGPU's tile-based splat renderer sizes its per-tile lists to what it has
  // drawn so far. The first time the camera came in close (a super's close-up,
  // a heavy blow's FOV punch) splats covered far more tiles than ever before,
  // the lists overflowed and whole rows of tiles dropped out for that moment -
  // fighters' heads cut off flat, blocky patches. Once grown, they stay grown.
  // So grow them now, under the loading screen: every fighter overlapped at
  // the origin, filmed from half a metre away for a few frames.
  async warmTileRenderer() {
    // Raster backends have no tile lists to grow.
    if (!this.scene.graphicsDevice.isWebGPU || window.splatCompatibility?.mode === 'raster') return;
    const cam = this.scene.cameraEntity;
    if (!cam) return;
    const pos = cam.getPosition().clone(), rot = cam.getRotation().clone();
    try {
      this.previews.forEach((c, i) => { c.setActive(true); c.setReveal(1); c.setPosition(i * 0.05, 0, 0); c.setRotation(0, 0, 0); });
      for (const [y, d] of [[1.4, 0.45], [1.0, 0.5], [0.6, 0.5]]) {
        cam.setPosition(0, y, d);
        cam.lookAt(0, y - 0.05, 0);
        // Let the app perform frameStart / render / frameEnd normally.
        // Calling render() repeatedly here reuses a WebGPU backbuffer outside
        // its frame lifecycle and can invalidate commands on some drivers.
        for (let k = 0; k < 3; k++) await new Promise((resolve) => requestAnimationFrame(resolve));
      }
    } catch (e) {
      console.warn('tile warm-up skipped', e);
    } finally {
      cam.setPosition(pos); cam.setRotation(rot);
      this.previews.forEach((c) => { c.setReveal(0); c.setActive(false); });
    }
  }

  // PINOC library clips (walk_fwd/back, block, hits, knockdown, getup, roll,
  // backstep, the shared kicks...) carry a constant 180-degree yaw on the ROOT
  // bone with the pelvis turned back the other way; text-generated clips
  // (every stance and signature move) have an identity root. A crossfade
  // blends root and pelvis separately, each the short way, so their turns
  // added up to a full spin of the body in 0.2 s whenever play passed between
  // the two kinds - "walking left turns the fighter around". The root's yaw is
  // baked into the pelvis track (rotation and position) and the root reset to
  // identity, so every clip shares one convention. The world pose is
  // unchanged, and so is root motion: the engine maps the pelvis offset
  // through the root rotation, and the offset is now pre-rotated instead.
  bakeRootYaw(boneNames) {
    const lib = this.scene.skeletalAnimationLibrary;
    const rootIdx = boneNames.indexOf('root'), pelvisIdx = boneNames.indexOf('pelvis');
    if (rootIdx < 0 || pelvisIdx < 0) return;
    const R = new Quat(), P = new Quat(), v = new Vec3();
    const baked = [];
    for (const [name, anim] of lib) {
      if (name.endsWith('~')) continue; // aliases share the same data
      const K = anim.skeletalStore?.keyframes;
      const rk = K?.get(rootIdx), pk = K?.get(pelvisIdx);
      if (!rk?.rotations || !pk?.rotations) continue;
      const r = rk.rotations;
      if (Math.abs(r[3]) > 0.9999) continue; // identity root already
      // only a constant root rotation can be folded into the pelvis exactly
      let constant = true;
      for (let i = 4; i < r.length; i += 4) if (Math.abs(r[i] * r[0] + r[i + 1] * r[1] + r[i + 2] * r[2] + r[i + 3] * r[3]) < 0.9999) { constant = false; break; }
      if (!constant) continue;
      R.set(r[0], r[1], r[2], r[3]);
      const pr = pk.rotations, pp = pk.positions;
      for (let i = 0; i + 3 < pr.length; i += 4) {
        P.set(pr[i], pr[i + 1], pr[i + 2], pr[i + 3]);
        P.mul2(R, P);
        pr[i] = P.x; pr[i + 1] = P.y; pr[i + 2] = P.z; pr[i + 3] = P.w;
      }
      if (pp) for (let i = 0; i + 2 < pp.length; i += 3) {
        v.set(pp[i], pp[i + 1], pp[i + 2]);
        R.transformVector(v, v);
        pp[i] = v.x; pp[i + 1] = v.y; pp[i + 2] = v.z;
      }
      for (let i = 0; i + 3 < r.length; i += 4) { r[i] = 0; r[i + 1] = 0; r[i + 2] = 0; r[i + 3] = 1; }
      baked.push(name);
    }
    this.rootYawBaked = baked;
  }

  // Measure which way each clip's body faces (hip + shoulder lines) so clips
  // authored turned away from +Z can be rotated back toward the opponent.
  // Attacks and reactions are judged by their opening frames (the pose they
  // start from); loops by their whole length.
  async measureClipHeadings() {
    this.clipHeading = {};
    this.clipLanding = {};
    this.strikeYaw = {};
    this.clipImpact = {};
    this.clipReach = {};
    this.clipSpeed = {};
    let probe;
    try {
      probe = await Character.load(this.scene, ROSTER[0].perf, { name: '__heading_probe' });
      probe.setActive(false);
      probe.detachAutoUpdate();
      const arm = probe.armature;
      this.rigBones = arm.boneNames.length; // the fighters' rig: tracks past this are never read
      // one root convention for every clip before anything is measured
      this.bakeRootYaw(arm.boneNames);
      const ids = ['thigh_l', 'thigh_r', 'upperarm_l', 'upperarm_r'].map((n) => arm.boneNames.indexOf(n));
      if (ids.some((i) => i < 0)) return;
      const pos = (i) => arm.getBoneWorldMatrix(i).getTranslation();
      // (supers too: they open from the side-on stance, and judged by the hips
      // the whole sequence played 45 degrees off, toward the camera)
      // (and the skills thrown or grabbed from the stance: a fireball pushed
      // from side-on hips must still fly where the face looks)
      const loopLike = /stance|walk|strafe|block|idle|win|cheer|intro|super|blast|kunai|_throw|clinch|slam/;
      const pelvisId = arm.boneNames.indexOf('pelvis');
      const headId = arm.boneNames.indexOf('head');
      const limbIds = ['hand_l', 'hand_r', 'foot_l', 'foot_r'].map((n) => arm.boneNames.indexOf(n));
      // the frame each attack clip lands on, from every move table
      const strikeFrames = new Map();
      const tables = [MOVES, ...ROSTER.map((d) => d.moves || {})];
      for (const t of tables) for (const [slot, own] of Object.entries(t)) {
        // a character's move inherits the shared move's fields (e.g. which joints strike)
        const mv = t === MOVES ? own : { ...MOVES[slot], ...own };
        if (!mv.clip) continue;
        strikeFrames.set(mv.clip, { start: mv.start || 0, multi: !!mv.hitFrames, limbs: mv.limbs, low: !!mv.low, strike: mv.hitFrames ? mv.hitFrames[0] : Math.round((mv.hit[0] + mv.hit[1]) / 2) });
      }
      const groundIds = ['ball_l', 'ball_r', 'hand_l', 'hand_r', 'head', 'pelvis'].map((b) => arm.boneNames.indexOf(b)).filter((i) => i >= 0);
      const toeIds = ['ball_l', 'ball_r'].map((b) => arm.boneNames.indexOf(b));
      for (const [name, anim] of this.scene.skeletalAnimationLibrary) {
        probe.playAnimation(name, { loop: false });
        arm.update(0);
        const n = anim.numFrames;
        // Some generated clips are authored floating above the floor: the KO
        // fall "ko_spin" starts with the feet 0.65 m up and ends lying in mid-air,
        // so the body jumped up half a metre toward the camera on a knockout.
        // A clip whose first pose is off the floor is lowered frame by frame so
        // its lowest joint stays on the floor (smoothed, to keep it fluid).
        const lowAt = (f) => {
          probe.animationTime = f;
          arm.update(0.0001);
          // toes rest a few cm above the floor; a head, hand or hip lying on it
          // sits ~10 cm up (the body's own thickness)
          let low = Infinity;
          for (const i of groundIds) low = Math.min(low, pos(i).y - (toeIds.includes(i) ? 0.04 : 0.1));
          return low;
        };
        const pelKeys = anim.skeletalStore?.keyframes.get(pelvisId);
        // average ground speed of walk cycles (m/s at 30 fps), so walking can
        // glide at the gait's own pace instead of lurching step by step
        if (/^(walk|strafe)/.test(name) && pelKeys?.positions?.length >= 6) {
          const p = pelKeys.positions, e = p.length - 3;
          const secs = (pelKeys.frames.at(-1) - pelKeys.frames[0]) / 30;
          if (secs > 0) this.clipSpeed[name] = Math.hypot(p[e] - p[0], p[e + 2] - p[2]) / secs;
        }
        // entrances: net pelvis travel (clip frame), so the start can be offset back
        if (/intro/.test(name) && pelKeys?.positions?.length >= 6) {
          const p = pelKeys.positions, e = p.length - 3;
          (this.clipTravel ??= {})[name] = { dx: p[e] - p[0], dz: p[e + 2] - p[2] };
        }
        // falls and reactions only: other clips may start in the air on purpose
        if (/^ko|knock|launch|react/.test(name) && pelKeys?.positions && pelKeys.frames?.length && lowAt(pelKeys.frames[0]) > 0.2) {
          let off = Array.from(pelKeys.frames, (f) => lowAt(f));
          for (let pass = 0; pass < 3; pass++) off = off.map((v, k) => (off[Math.max(0, k - 1)] + 2 * v + off[Math.min(off.length - 1, k + 1)]) / 4);
          off.forEach((v, k) => { pelKeys.positions[k * 3 + 1] -= v; });
          this.clipGrounded = { ...this.clipGrounded, [name]: +off[0].toFixed(2) };
        }
        const last = loopLike.test(name) ? n - 2 : Math.max(3, Math.floor(n * 0.15));
        let sx = 0, sz = 0;
        for (let f = 1; f <= last; f += Math.max(1, Math.floor(last / 12))) {
          probe.animationTime = f;
          arm.update(0.0001);
          for (const [l, r] of [[0, 1], [2, 3]]) {
            const a = pos(ids[l]).clone(), b = pos(ids[r]);
            const vx = b.x - a.x, vz = b.z - a.z, len = Math.hypot(vx, vz) || 1;
            sx += vx / len; sz += vz / len;
          }
        }
        let h = (Math.atan2(-sz, sx) * 180) / Math.PI + 180;
        if (h > 180) h -= 360;
        // Stances and walks are aimed by the face, not the hips: a side-on
        // karate or ninja stance turns the hips 30-50 degrees away while the head
        // looks straight at the opponent. (The head bone's first axis points
        // where the face looks.)
        if (loopLike.test(name) && headId >= 0) {
          let fx = 0, fz = 0;
          for (let f = 1; f <= last; f += Math.max(1, Math.floor(last / 12))) {
            probe.animationTime = f;
            arm.update(0.0001);
            const m = arm.getBoneWorldMatrix(headId).data;
            const len = Math.hypot(m[0], m[2]);
            // skip frames where the head is bowed toward the floor
            if (len > 0.6) { fx += m[0] / len; fz += m[2] / len; }
          }
          h = (Math.atan2(fx, fz) * 180) / Math.PI;
        }
        if (Math.abs(h) > 8) this.clipHeading[name] = Math.round(h);
        // strikes: which way the striking hand/foot points at the moment of
        // impact, so the fighter can be turned to put the blow ON the opponent
        // (aligning the torso instead makes twisting punches land beside him)
        const sf = strikeFrames.get(name);
        if (sf !== undefined && !sf.multi) {
          const r = measureStrike(probe, anim.numFrames, sf.start, this.clipHeading[name] ?? 0, sf.limbs, sf.low);
          if (r) {
            this.strikeYaw[name] = r.yaw;
            this.clipImpact[name] = r.impact;
            this.clipReach[name] = r.reach;
          }
        }
        // falls: the frame where the pelvis reaches the floor, to hold the body there
        if (/knockdown|launch|^ko/.test(name)) {
          const key = anim.skeletalStore?.keyframes.get(arm.boneNames.indexOf('pelvis'));
          if (key) {
            let minY = Infinity;
            for (let i = 1; i < key.positions.length; i += 3) minY = Math.min(minY, key.positions[i]);
            const lastF = key.frames[key.frames.length - 1] || 1;
            for (let k = 0; k < key.frames.length; k++) {
              // the body has to have fallen first: ignore low frames at the very start
              if (key.frames[k] >= lastF * 0.25 && key.positions[k * 3 + 1] <= minY + 0.06) { this.clipLanding[name] = key.frames[k]; break; }
            }
          }
        }
      }
    } catch (e) {
      console.warn('clip heading measurement skipped', e);
    } finally {
      probe?.destroy();
    }
  }

  // ---------------------------------------------------------------- menu
  bindUI() {
    const roster = $('roster');
    ROSTER.forEach((def, i) => {
      const card = document.createElement('div');
      card.className = 'card';
      card.innerHTML = `<img src="${def.portrait}" alt=""><span>${def.name}</span><b class="tagp"></b>`;
      // tap / click: your fighter. Right-click or a long press (phones): the opponent
      let pressT = null, longPressed = false;
      card.addEventListener('pointerdown', (e) => {
        if (e.pointerType !== 'touch') return;
        longPressed = false;
        pressT = setTimeout(() => { longPressed = true; navigator.vibrate?.(20); this.cpuIndex = i; this.refreshMenu(true); }, 450);
      });
      const cancel = () => clearTimeout(pressT);
      card.addEventListener('pointerup', cancel);
      card.addEventListener('pointercancel', cancel);
      card.addEventListener('pointerleave', cancel);
      card.addEventListener('click', () => { if (longPressed) { longPressed = false; return; } this.p1Index = i; if (this.cpuIndex === i && ROSTER.length > 1) this.cpuIndex = (i + 1) % ROSTER.length; this.refreshMenu(true); });
      card.addEventListener('contextmenu', (e) => { e.preventDefault(); if (e.pointerType === 'touch' || longPressed) return; this.cpuIndex = i; this.refreshMenu(true); });
      roster.appendChild(card);
    });
    const seg = (id, key, after) => $(id).querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
      $(id).querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      this[key] = b.dataset.v;
      after?.();
    }));
    seg('diff', 'difficulty');
    // stages: one button each; picking one swaps the scene behind the menu
    const stageSeg = $('stage');
    for (const st of STAGES) {
      const b = document.createElement('button');
      b.dataset.v = st.id;
      b.textContent = st.name;
      b.classList.toggle('on', st.id === this.stageId);
      stageSeg.appendChild(b);
    }
    seg('stage', 'stageId', async () => {
      $('start').disabled = true;
      this.toast('正在载入地图…', 8000);
      try { await this.loadStage(this.stageId); } finally { $('start').disabled = false; this.toast(''); }
    });
    seg('qual', 'quality', () => this.applyQuality(this.quality));
    this.applyQuality(this.quality, false);
    // 柔和: dimmer screen flashes and gentler camera shake (photosensitivity)
    const applyFx = () => {
      const soft = this.fxMode === 'soft';
      this.fx.flashScale = soft ? 0.3 : 1;
      this.camera.shakeScale = soft ? 0.45 : 1;
      this.camera.punchScale = soft ? 0.4 : 1;
      try { localStorage.setItem('splatFighter.fx', this.fxMode); } catch { /* storage blocked */ }
    };
    seg('fxmode', 'fxMode', applyFx);
    try { this.fxMode = localStorage.getItem('splatFighter.fx') || 'full'; } catch { this.fxMode = 'full'; }
    $('fxmode').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === this.fxMode));
    applyFx();
    $('start').addEventListener('click', () => { this.goFullscreen(); this.startMatch(); });
    // phones and tablets: on-screen joystick and buttons, a pause button
    if (isTouchDevice()) {
      document.body.classList.add('touch');
      document.querySelector('.row-label').textContent = '点按选择你的角色 · 长按选择对手 · 拖动画面旋转查看';
      $('pauseBtn').addEventListener('click', () => { if (this.inMatch) this.setPaused(true); });
      // the start button joins the fullscreen button in the top-right corner
      document.querySelector('.menu-actions').appendChild($('start'));
      for (const id of ['fsMenu', 'fsGame']) $(id).addEventListener('click', () => this.toggleFullscreen());
      const sync = () => {
        const on = !!(document.fullscreenElement || document.webkitFullscreenElement);
        for (const id of ['fsMenu', 'fsGame']) { $(id).querySelector('span').textContent = on ? '退出全屏' : '全屏'; $(id).setAttribute('aria-label', on ? '退出全屏' : '全屏'); }
      };
      document.addEventListener('fullscreenchange', sync);
      document.addEventListener('webkitfullscreenchange', sync);
    }
    $('resume').addEventListener('click', () => this.setPaused(false));
    $('restart').addEventListener('click', () => { this.setPaused(false); this.startMatch(); });
    $('toMenu').addEventListener('click', () => { this.setPaused(false); this.enterMenu(); });
    $('again').addEventListener('click', () => this.startMatch());
    $('resultMenu').addEventListener('click', () => this.enterMenu());

    this.input.on('Escape', () => { if (this.inMatch) this.setPaused(!this.paused); });
    this.input.on('KeyP', () => this.togglePhoto());
    this.input.on('KeyH', () => { this.hudHidden = !this.hudHidden; $('hud').style.opacity = this.hudHidden ? '0' : '1'; $('stats').style.opacity = this.hudHidden ? '0' : '1'; });
    this.input.on('KeyQ', () => this.toggleQuality());
    this.input.on('KeyG', () => { this.showGhosts = !this.showGhosts; this.toast(this.showGhosts ? '残影：开' : '残影：关'); });
    document.addEventListener('visibilitychange', () => { if (document.hidden && this.inMatch && !this.paused) this.setPaused(true); });
  }

  get inMatch() {
    return ['intro', 'fight', 'ko', 'roundEnd'].includes(this.phase);
  }

  enterMenu() {
    this.clearMatch();
    this.phase = 'menu';
    $('menu').classList.remove('hidden');
    $('hud').classList.add('hidden');
    $('result').classList.add('hidden');
    $('stats').classList.remove('hidden');
    this.camera.free = true;
    this.camera.userYaw = 0;
    this.camera.userPitch = 0.05;
    this.camera.zoom = 0.9;
    this.camera.idle = 0;
    this.camera.pos.set(0, 1.8, 5.5);
    this.camera.look.set(0, 1.05, 0);
    this.refreshMenu(true);
  }

  refreshMenu(reveal) {
    const cards = $('roster').children;
    [...cards].forEach((c, i) => {
      c.classList.toggle('p1', i === this.p1Index);
      c.classList.toggle('cpu', i === this.cpuIndex && i !== this.p1Index);
      c.querySelector('.tagp').textContent = i === this.p1Index ? 'P1' : i === this.cpuIndex ? 'CPU' : '';
    });
    const def = ROSTER[this.p1Index];
    $('infoName').textContent = def.name;
    $('infoName').style.color = def.color;
    $('infoTitle').textContent = def.title;
    $('infoStyle').textContent = def.style;
    $('infoSig').textContent = def.signature || '';
    $('stPow').style.width = `${Math.round(def.power * 70)}%`;
    $('stSpd').style.width = `${Math.round(def.speed * 70)}%`;
    $('stHp').style.width = `${Math.round((def.hp / 115) * 90)}%`;
    $('infoBadge').innerHTML = `这个角色由 PINOC 从一张图片重建为 <b>${this.quality === 'high' ? '48,000' : '16,000'}</b> 个带骨骼权重的 3D 高斯点（「标准」「流畅」画质为 16,000 个），不是多边形模型。拖动画面可以从任意角度查看。`;

    // show the two chosen fighters in the arena, revealed with PINOC's skeleton sweep
    const show = [this.p1Index, this.cpuIndex];
    this.previews.forEach((c, i) => {
      const slot = show.indexOf(i);
      if (slot < 0) { c.setActive(false); return; }
      // hide before activating so a character never shows for a frame before its reveal
      const needReveal = reveal && (c._shownSlot !== slot || !c._revealed);
      if (needReveal) c.setReveal(0);
      c.setActive(true);
      // reposition with root motion off, so 'apply' re-captures its baseline here
      c.armature.rootMotionMode = 'off';
      const x = slot === 0 ? -0.85 : 0.85;
      c.setPosition(x, 0, 0);
      c.setRotation(0, slot === 0 ? 18 : -18, 0);
      const stance = ROSTER[i].clips?.stance ?? 'stance';
      // rootMotion 'apply': the body follows the stance's own weight shifts
      // (absolute, so it never drifts) and the feet stay planted on the floor
      if (c.currentAnimationName?.replace('~', '') !== stance) c.playAnimation(stance, { loop: false, rootMotion: true });
      c.armature.rootMotionMode = 'apply';
      c._loopClip = stance;
      c.playbackSpeed = 1;
      if (needReveal) {
        c._revealed = true;
        this.runReveal(c, 1.4);
      }
      c._shownSlot = slot;
    });
    this.scheduleMatchPreparation();
  }

  runReveal(ch, dur, { inverse = false, delay = 0 } = {}) {
    this.events.push({ t: -delay, dur, fn: (k) => ch.setReveal(inverse ? k : k, inverse) });
    ch.setReveal(inverse ? 0 : 0, inverse);
  }

  // ---------------------------------------------------------------- match
  clearMatch() {
    for (const f of this.fighters) f.destroy();
    this.fighters = [];
    this.events = [];
    this.slow = null;
    this.hitstop = 0;
    this.heldInput = null;
    this.fx?.clear();
    this.freeze = 0;
    if (this.dim) { this.dim.target = 0; this.dimLevel = 0; this.env?.setTint(0); }
    $('superDim')?.classList.remove('on');
    $('cutin')?.classList.remove('show');
    if (this.canvas) this.canvas.style.filter = '';
    this.timeScale = 1;
    if (this.photo) this.togglePhoto();
  }

  matchRequest() {
    const indices = [this.p1Index, this.cpuIndex];
    const quality = this.quality;
    return { key: indices.join(':') + ':' + quality, create: async () => {
      const pair = indices.map((index, slot) => new Fighter(this, ROSTER[index], slot));
      pair[0].opponent = pair[1]; pair[1].opponent = pair[0];
      // Capture the tier: menu selections may change while this batch loads.
      const results = await Promise.allSettled(pair.map((f) => f.load(this.scene, { inactive: true, quality })));
      const failed = results.find((r) => r.status === 'rejected');
      if (failed) { pair.forEach((f) => f.destroy()); throw failed.reason; }
      return pair;
    }};
  }

  scheduleMatchPreparation() {
    clearTimeout(this.prepareMatchTimer);
    if (this.phase !== 'menu') return;
    this.prepareMatchTimer = setTimeout(() => {
      if (this.phase !== 'menu') return;
      const request = this.matchRequest();
      this.matchLoader.prepare(request.key, request.create);
    }, 180);
  }

  async startMatch() {
    if (this.phase === 'loadingMatch') return;
    clearTimeout(this.prepareMatchTimer);
    this.clearMatch();
    this.phase = 'loadingMatch';
    // Keep the selected models visible until the fully prepared pair takes over.
    // No empty arena while the phone decodes characters and ghost copies.
    const start = $('start');
    const label = start.textContent;
    start.disabled = true; start.textContent = '正在准备战斗…';
    $('menu').inert = true;
    this.toast('正在准备战斗…', 60000);
    try {
      const request = this.matchRequest();
      const [a, b] = await this.matchLoader.take(request.key, request.create);
      $('menu').classList.add('hidden');
      $('result').classList.add('hidden');
      for (const c of this.previews) c.setActive(false);
      a.character.setActive(true); b.character.setActive(true);
      a.meter = 0; b.meter = 0;
      this.fighters = [a, b];
      this.p1 = a; this.cpu = b;
      this.ai = new AI(b, this.difficulty);
      this.wins = [0, 0];
      this.round = 1;

      $('nameL').textContent = a.def.name; $('nameL').style.color = a.def.color;
      $('nameR').textContent = b.def.name; $('nameR').style.color = b.def.color;
      $('portL').src = a.def.portrait; $('portR').src = b.def.portrait;
      $('hud').classList.remove('hidden');
      this.camera.free = false;
      this.camera.userYaw = 0; this.camera.userPitch = 0; this.camera.zoom = 1;
      this.toast('');
      this.startRound();
    } catch (error) {
      this.enterMenu();
      this.toast('角色准备失败，请重试：' + (error.message || error), 6000);
      console.error('match preparation failed', error);
    } finally {
      start.disabled = false; start.textContent = label;
      $('menu').inert = false;
    }
  }

  startRound() {
    const [a, b] = this.fighters;
    const revealBoth = this.round === 1;
    for (const f of this.fighters) {
      const needReveal = revealBoth || f._dissolved;
      f.resetForRound();
      f.placeForRound();
      // round one: each fighter's own PINOC entrance while it materialises
      const entered = revealBoth && f.playIntro();
      if (!entered) f.play('stance', { loop: true, fade: 0.1 });
      if (needReveal) { f._dissolved = false; this.runReveal(f.character, 1.5, { delay: f.slot * 0.35 }); }
    }
    // the entrance takes ~3 s: hold ROUND / FIGHT until it has played out
    this.introDelay = revealBoth && this.fighters.some((f) => f.introPlaying) ? 1.0 : 0;
    this.timer = TUNING.roundTime;
    this.phase = 'intro';
    this.phaseTime = 0;
    // start on the +Z side so P1 (at -X) is on the left of the screen
    this.camera.pos.set((a.x + b.x) / 2, 2.0, 6.0);
    this.camera.look.set((a.x + b.x) / 2, 1.08, 0);
    this.camera.cinematic({ duration: 3.0 + this.introDelay, yawAdd: 0.85, distMul: 0.78, pitch: 0.05 });
    this.introStage = 0;
  }

  // ---------------------------------------------------------------- combat
  tryHit(attacker, mv, info) {
    const d = attacker.dirToOpponent();
    const def = attacker.opponent;
    // a measured limb contact already proves the blow reached; otherwise
    // (multi-hit specials) fall back to distance + facing - except inside a
    // super that has already connected: the defender is locked in, every blow lands
    // (a clinch holds the same way: its knees can't miss)
    const locked = def.lockedBy === attacker && attacker.holding && (!mv.special || attacker.superLanded);
    if (!info.contact && !locked) {
      if (d.dist > mv.reach) return false;
      const f = attacker.facingVec();
      if (f.x * d.x + f.z * d.z < 0.45) return false;
    }
    if (def.invulnerable) {
      if (def.state === 'dodge') {
        this.toast('闪避!');
        this.setSlow(0.35, 0.35);
        attacker.combo = 0;
      }
      return true;
    }
    // spark on the striking limb when it is actually at the body, else on the body surface
    let pos = { x: def.x - d.x * 0.18, y: mv.height, z: def.z - d.z * 0.18 };
    if (info.contact) pos = { x: info.contact.x, y: info.contact.y, z: info.contact.z };
    else {
      const limb = attacker.strikePoint(def.x, mv.height, def.z);
      if (limb && Math.hypot(limb.x - def.x, limb.z - def.z) < 0.55) pos = limb;
      else if (limb) pos.y = Math.max(0.8, Math.min(1.75, limb.y));
    }
    // which side of the defender's body the blow lands on (+1 = their right):
    // picks the directional head reaction and the way the body flinches
    const dr = def.rightVec();
    const side = Math.sign((pos.x - def.x) * dr.x + (pos.z - def.z) * dr.z) || 1;

    // COUNTER: caught in the wind-up of their own strike. PUNISH: caught in
    // its recovery (after a whiff or a blocked blow)
    let bonus = null;
    if (def.state === 'attack' && def.move) {
      const dm = def.moves[def.move];
      if (def.moveFrame < (dm.hitFrames ? dm.hitFrames[0] : dm.hit[0])) bonus = 'counter';
      else if (def.moveFrame > (dm.hitFrames ? dm.hitFrames.at(-1) : dm.hit[1])) bonus = 'punish';
    }

    // (a super's damage is fixed: no combo scaling inside it)
    const scale = mv.special ? 1 : Math.max(0.5, 1 - attacker.combo * 0.1);
    const bonusDmg = bonus === 'counter' ? TUNING.counterDmg : bonus === 'punish' ? TUNING.punishDmg : 1;
    const dmg = info.dmg * attacker.def.power * scale * bonusDmg;
    // a counter-hit staggers like a heavy blow
    const heavyHit = !!mv.heavy || bonus === 'counter';
    const result = def.receiveHit(attacker, { dmg, react: info.react, heavy: heavyHit, push: mv.push, side, height: pos.y });
    const dir = { x: d.x, z: d.z };
    const hs = TUNING.hitstop;
    // A super that connects locks on: the defender is held at striking distance
    // so the whole sequence lands (pushback would carry them out of the flurry)
    if (mv.special && result !== 'ko' && result !== 'blocked') {
      attacker.superLanded = true;
      def.lockedBy = attacker; // held in hitstun at arm's length until the super ends
    }

    // armour soaks the blow: a dull thud, and the charge keeps coming
    if (result === 'armor') {
      this.fx.impact(pos, { color: '#ffb35c', tier: 'light', dir });
      this.hitstop = hs.light;
      def.hitShake(this.hitstop + 0.05, dir, 0.4);
      return true;
    }

    if (result === 'blocked') {
      this.fx.impact(pos, { blocked: true, dir });
      this.hitstop = hs.block + (mv.heavy ? 0.02 : 0);
      def.hitShake(this.hitstop + 0.05, dir, 0.5);
      this.camera.addShake(mv.heavy ? 0.4 : 0.25, dir);
      if (!mv.special) for (const f of [attacker, def]) f.meter = Math.min(TUNING.meterMax, f.meter + TUNING.meterBlock);
      return true;
    }

    if (!mv.special) {
      attacker.meter = Math.min(TUNING.meterMax, attacker.meter + (mv.meter || 4) * TUNING.meterHit);
      def.meter = Math.min(TUNING.meterMax, def.meter + TUNING.meterTaken);
    }
    attacker.combo = result === 'combo' || attacker.combo > 0 && attacker.comboTimer > 0 ? attacker.combo + 1 : 1;
    attacker.comboTimer = 1.1;

    const heavy = heavyHit || info.react === 'down';
    // weight of the blow: light jabs, mid crosses/kicks, heavy finishers
    // (a special's flurry hits as mid blows; only its finisher lands heavy)
    const tier = mv.hitFrames && !info.last ? 'mid' : heavy ? 'heavy' : info.dmg >= 8 ? 'mid' : 'light';
    // (a skill shouts its own word on the blow that ends it)
    this.fx.impact(pos, { color: attacker.def.color, style: attacker.def.fx, tier, counter: bonus === 'counter', dir });
    if (mv.slash) this.fx.cut(pos, attacker.def.fx, -0.35, 1.8, 0.45, 1.5);
    if (mv.auraBurst && attacker.def.fx === 'fire') this.fx.flameBurst(pos, 8, 0.7);
    // (a super's flurry freezes briefly per blow so it keeps its rhythm)
    this.hitstop = mv.special && !info.last ? 0.06 : hs[tier] + (bonus ? hs.counter : 0);
    // smear frame: the striking fist/foot shoots out longer for the impact; a
    // heavy blow folds the defender's body. Bone stretch only - free on old GPUs
    const finisher = mv.special && info.last;
    const smearAmt = info.projectile ? 0 : mv.special ? 0.4 : tier === 'heavy' ? 0.3 : tier === 'mid' ? 0.18 : 0;
    if (smearAmt) attacker.smear(attacker.strikingLimb(pos), smearAmt, (finisher ? 0.32 : this.hitstop) + 0.06);
    if (tier === 'heavy') def.squash(finisher ? 0.22 : 0.14, (finisher ? 0.32 : this.hitstop) + 0.1);
    def.hitShake(this.hitstop + 0.1, dir, tier === 'heavy' ? 1 : tier === 'mid' ? 0.75 : 0.5);
    this.camera.addShake(tier === 'heavy' ? 0.9 : tier === 'mid' ? 0.6 : 0.42, dir);
    if (bonus) this.callout(attacker, bonus === 'counter' ? 'COUNTER' : 'PUNISH');
    if (bonus === 'counter' && !heavy) this.camera.punch(3, 1.2);
    if (heavy) {
      this.fx.floorShock(def.x, def.z, mv.special ? 0.8 : 0.5);
      this.camera.punch(5, 2.5);
    }

    if (mv.special && info.last) this.onSuperFinish(attacker, def, pos);
    if (result === 'ko') {
      this.onKO(attacker, def);
    } else if (attacker.combo === 3 && !mv.special) {
      // the signature slow-motion orbit: watch the Gaussian body mid-combo
      this.setSlow(0.25, 0.9);
      this.camera.cinematic({ duration: 1.3, yawAdd: 0.8, distMul: 0.6, pitch: 0.05, focus: { x: (attacker.x + def.x) / 2, y: 1.3, z: (attacker.z + def.z) / 2 } });
    }
    return true;
  }

  onDodge() { /* afterimages are spawned by the fighter */ }

  // ---------------------------------------------------------------- skills
  // Projectiles: KENJI's fireball, SHADE's kunai, GRIZZLY's ground wave. They
  // fly straight at where the opponent stood at release; one per fighter at a
  // time; two meeting cancel out. Drawn by the FX layer (fx.projs).
  spawnProjectile(owner, mv) {
    const p = mv.projectile;
    this.projectiles ??= this.fx.projs;
    if (this.projectiles.some((q) => q.owner === owner)) return;
    const d = owner.dirToOpponent();
    const start = 0.55;
    const pr = {
      owner, mv, kind: p.kind, seed: Math.random() * 233280,
      x: owner.x + d.x * start, y: p.y, z: owner.z + d.z * start,
      vx: d.x * p.speed, vz: d.z * p.speed, t: 0, life: p.range / p.speed, spawnT: 0,
    };
    this.projectiles.push(pr);
    const pos = { x: pr.x, y: pr.y, z: pr.z };
    if (p.kind === 'fireball') { this.fx.splash(pos, 'fire', { size: 0.22, life: 0.25, dir: d, core: false }); this.fx.flameBurst(pos, 4, 0.35, d); }
    if (p.kind === 'kunai') this.fx.cut(pos, 'shadow', -0.2, 0.5, 0.18, 0.6);
    if (p.kind === 'quake') {
      this.fx.floorCracks(owner.x + d.x * 0.6, owner.z + d.z * 0.6, 1.0, 0.8);
      this.fx.floorShock(owner.x + d.x * 0.6, owner.z + d.z * 0.6, 0.6, 0.7);
      this.camera.addShake(0.7, d);
    }
  }

  updateProjectiles(dt) {
    const list = this.projectiles;
    if (!list?.length || dt <= 0) return;
    for (const p of list) {
      if (p.dead) continue;
      p.t += dt;
      p.x += p.vx * dt; p.z += p.vz * dt;
      // trail
      if (p.kind === 'fireball' && Math.random() < dt * 40) {
        this.fx.addPart({ x: p.x, y: p.y + (Math.random() - 0.5) * 0.15, z: p.z, vx: -p.vx * 0.15, vy: 0.4 + Math.random() * 0.6, vz: -p.vz * 0.15, life: 0, max: 0.35 + Math.random() * 0.25, g: 1.5, color: Math.random() < 0.5 ? '#ffd36b' : '#ff6a1a', w: 3, kind: 'ember' });
      }
      if (p.kind === 'quake') {
        p.spawnT -= dt;
        if (p.spawnT <= 0) {
          p.spawnT = 0.05;
          this.fx.rockSpike(p.x + (Math.random() - 0.5) * 0.3, p.z + (Math.random() - 0.5) * 0.3, 0.42);
          // chips thrown up out of the floor
          this.fx.addPart({ x: p.x, y: 0.05, z: p.z, vx: (Math.random() - 0.5) * 2, vy: 2 + Math.random() * 2, vz: (Math.random() - 0.5) * 2, life: 0, max: 0.6, g: -12, color: Math.random() < 0.5 ? '#8a6a4a' : '#c98a4a', w: 4 + Math.random() * 3, kind: 'chunk' });
        }
      }
      const gone = () => { p.dead = true; };
      // two projectiles meeting cancel out
      const other = list.find((q) => q !== p && !q.dead && q.owner !== p.owner && Math.hypot(q.x - p.x, q.z - p.z) < 0.5);
      if (other) {
        const pos = { x: (p.x + other.x) / 2, y: p.y, z: (p.z + other.z) / 2 };
        this.fx.burst(pos, '#e8e2d4', 0.5, 0.35);
        this.fx.cut(pos, null, 1.2, 0.9, 0.3, 1);
        other.dead = true;
        gone();
        continue;
      }
      const def = p.owner.opponent;
      // jumped over (a fireball or kunai flies at chest height; the ground wave can be jumped too)
      const airborne = def.state === 'jump' || (def.lift || 0) > 0.15;
      if (!airborne && Math.hypot(def.x - p.x, def.z - p.z) < 0.42 && !def.invulnerable) {
        const pos = { x: p.x, y: p.kind === 'quake' ? 0.5 : p.y, z: p.z };
        this.tryHit(p.owner, p.mv, { index: 0, last: true, dmg: p.mv.dmg, react: p.mv.react, contact: pos, projectile: true });
        gone();
        continue;
      }
      if (p.t >= p.life || Math.hypot(p.x, p.z) > TUNING.arenaRadius + 1) {
        if (p.kind === 'fireball') this.fx.burst({ x: p.x, y: p.y, z: p.z }, '#ff8a2a', 0.2, 0.18, 10);
        gone();
      }
    }
    // (in place: the FX layer holds the same array)
    for (let i = list.length - 1; i >= 0; i--) if (list[i].dead) list.splice(i, 1);
  }

  // A throw's grab: point blank, in front, and the target on its feet. Throws
  // go through a guard (that's their job) but not through a jump or a dodge.
  tryGrab(a, mv, secsToSlam) {
    const def = a.opponent, d = a.dirToOpponent();
    const f = a.facingVec();
    const ok = d.dist <= mv.reach + 0.1 && f.x * d.x + f.z * d.z > 0.4 && !def.invulnerable
      && !['jump', 'down', 'getup', 'ko', 'thrown'].includes(def.state) && !(def.lift > 0.1);
    if (!ok) return false;
    const pos = def.bonePos('spine_05') || { x: def.x, y: 1.2, z: def.z };
    this.fx.burst(pos, '#ffffff', 0.25, 0.18, 10);
    this.callout(a, mv.grab === 'clinch' ? 'CLINCH' : 'THROW');
    if (mv.grab === 'throw') def.beThrown(a, secsToSlam);
    else {
      // clinch: held upright in a stagger while the knees come in
      def.queue.length = 0;
      def.move = null;
      def.setState('hit');
      def.play('react_heavy', { speed: 0.6, fade: 0.08 });
      def.hitDur = 0.9;
      def.lockedBy = a;
    }
    return true;
  }

  // the slam: unblockable damage, the floor cracks under the body
  throwSlam(a, def, mv) {
    if (def.state !== 'thrown' || def.thrownBy !== a) return;
    def.slammed = true;
    def.animSpeed = 1.1;
    const dmg = mv.dmg * a.def.power;
    def.hp = Math.max(0, def.hp - dmg);
    const d = a.dirToOpponent();
    const pos = def.bonePos('spine_03') || { x: def.x, y: 0.4, z: def.z };
    this.fx.impact(pos, { color: a.def.color, style: a.def.fx, tier: 'heavy', dir: d });
    this.fx.floorCracks(def.x, def.z, 1.4, 1.0, a.def.fx);
    this.fx.floorShock(def.x, def.z, 0.9, 0.9);
    this.hitstop = 0.17;
    this.camera.punch(6, 3);
    this.camera.addShake(1.0, d);
    def.squash(0.2, 0.3);
    a.meter = Math.min(TUNING.meterMax, a.meter + 10 * TUNING.meterHit);
    def.meter = Math.min(TUNING.meterMax, def.meter + TUNING.meterTaken);
    if (def.hp <= 0) {
      // knocked out by the slam: lie where the throw put them
      def.setState('ko');
      def.koFreezeAt = 40;
      this.onKO(a, def);
    }
  }

  // ---------------------------------------------------------------- supers
  // A super plays as a sequence of its own:
  //   activation - the arena darkens (env tint: the fighters stay lit), the
  //                cut-in band sweeps across with portrait and move name
  //   charge     - at the clip's power-up pose time stops, energy streaks into
  //                the body and the camera closes on the fighter
  //   sequence   - invincible until the first blow; if it lands the defender
  //                is locked in and every blow connects, with an aura,
  //                afterimages and heavy fist trails throughout
  //   finisher   - an anime impact frame (the image inverts for a beat), a
  //                long freeze and the character's own signature effect
  onSpecialStart(f) {
    const s = f.def.moves.special;
    this.dimArena(f, true);
    const el = $('cutin');
    el.className = f.slot === 0 ? 'left' : 'right';
    el.style.setProperty('--sc', f.def.color);
    el.style.setProperty('--cf', f.slot === 0 ? '-60%' : '60%');
    el.style.setProperty('--ct', f.slot === 0 ? '30%' : '-30%');
    el.querySelector('img').src = f.def.portrait;
    el.querySelector('b').textContent = s.superName || f.def.moveNames?.special || 'SPLAT BREAKER';
    el.querySelector('small').textContent = s.superNameEn || 'SPLAT BREAKER';
    void el.offsetWidth;
    el.classList.add('show');
    this.fx.screenFlash(`${f.def.color}66`, 90);
    // close on the fighter for the power-up
    this.camera.cinematic({ duration: 1.6, yawAdd: f.slot === 0 ? 0.95 : -0.95, distMul: 0.42, pitch: 0.02, focus: { x: f.x, y: 1.35, z: f.z }, focusWeight: 0.95 });
  }

  // the power-up pose: time stops, energy rushes in
  onSuperCharge(f) {
    this.freeze = Math.max(this.freeze || 0, 0.7);
    const chest = f.bonePos('spine_05') || { x: f.x, y: 1.3, z: f.z };
    this.fx.chargeBurst(chest, f.def.color);
    // power swell: chest and arms bulk up while time stands still
    const swell = { width: 1.12, thickness: 1.12 };
    f.stretch('swell', { spine_04: swell, spine_05: swell, upperarm_l: { width: 1.2, thickness: 1.2 }, upperarm_r: { width: 1.2, thickness: 1.2 } }, 0.75);
    this.fx.floorShock(f.x, f.z, 0.45, 0.6);
    this.camera.punch(4, 0);
    // then pull out to a low side angle that keeps both bodies in frame
    const o = f.opponent, s = f.def.moves.special;
    const dur = ((s.end - (s.charge || 0)) / 30) / (s.speed * f.def.speed) + 0.9;
    setTimeout(() => {
      if (!f.superActive) return;
      this.camera.cinematic({ duration: dur, yawAdd: f.slot === 0 ? 0.55 : -0.55, distMul: 0.72, pitch: 0.12, focus: { x: (f.x + o.x) / 2, y: 1.15, z: (f.z + o.z) / 2 } });
    }, 700);
  }

  onSuperFinish(f, def, pos) {
    const soft = this.fxMode === 'soft';
    this.freeze = Math.max(this.freeze || 0, 0.32);
    this.setSlow(0.3, 0.9);
    this.impactFrame(f.def.color, soft);
    this.fx.finisher(f.def.fx, pos, f.def.color);
    this.fx.floorShock(def.x, def.z, 1.3, 1.1);
    this.camera.punch(10, 4);
    this.camera.addShake(1.3, { x: def.x - f.x, z: def.z - f.z });
    if (f.def.fx === 'shadow') f.spawnClones(def);
    this.banner(`<small>${f.def.moves.special.superNameEn || 'SPLAT BREAKER'}</small>`, 1100);
  }

  onSuperEnd(f) {
    this.dimArena(f, false);
    if (f.opponent?.lockedBy === f) f.opponent.lockedBy = null;
  }

  // Anime impact frame: the image flips to a high-contrast negative for a
  // couple of frames, then a colour flash. Soft mode: just the flash.
  impactFrame(color, soft) {
    const v = this.canvas;
    if (!soft) {
      v.style.filter = 'grayscale(1) contrast(4) invert(1)';
      setTimeout(() => { v.style.filter = 'grayscale(1) contrast(2.5)'; }, 70);
      setTimeout(() => { v.style.filter = ''; }, 140);
    }
    this.fx.screenFlash(`${color}aa`, soft ? 80 : 140);
  }

  // darken the arena around a super (the env splat is tinted toward black with
  // a trace of the fighter's colour; the characters keep their own light)
  dimArena(f, on) {
    this.dim = { target: on ? 1 : 0, color: f.color };
    $('superDim').classList.toggle('on', on);
  }

  updateDim(dt) {
    if (!this.dim || !this.env) return;
    this.dimLevel = this.dimLevel ?? 0;
    const prev = this.dimLevel;
    this.dimLevel += Math.max(-dt * 3, Math.min(dt * 5, this.dim.target - this.dimLevel));
    if (this.dimLevel === prev) return;
    const c = this.dim.color;
    this.env.setTint(this.dimLevel * 0.82, { r: 0.02 + c.r * 0.06, g: 0.02 + c.g * 0.06, b: 0.03 + c.b * 0.06 });
  }

  onKO(winner, loser) {
    if (this.phase !== 'fight') return;
    this.phase = 'ko';
    this.phaseTime = 0;
    this.koWinner = winner;
    this.koLoser = loser;
    // finisher: a frozen beat at impact, then a long slow-motion orbit around
    // the falling Gaussian body
    this.freeze = 0.32;
    this.setSlow(0.2, 2.6);
    this.fx.screenFlash('rgba(255,255,255,0.85)', 180);
    this.fx.floorShock(loser.x, loser.z, 0.9);
    this.camera.punch(9, 5);
    // the focus follows the falling body live (getters), weighted toward the loser
    const focus = {
      get x() { return winner.x * 0.3 + loser.x * 0.7; },
      get z() { return winner.z * 0.3 + loser.z * 0.7; },
      y: 0.75,
    };
    // stay side-on (never behind either body) and look down a little on the fall
    this.camera.cinematic({ duration: 4.6, yawAdd: winner.slot === 0 ? 0.7 : -0.7, distMul: 0.78, pitch: 0.4, focus, focusWeight: 0.9 });
    this.fx.burst(loser.bonePos('spine_05') || { x: loser.x, y: 1.2, z: loser.z }, winner.def.color, 0.6, 0.5);
    setTimeout(() => this.banner('K.O.', 2400), 350);
    this.wins[winner.slot]++;
  }

  setSlow(scale, duration) {
    if (!this.slow || scale <= this.slow.scale) this.slow = { scale, t: duration };
  }

  // ---------------------------------------------------------------- update
  update(rawDt) {
    const dt = Math.min(rawDt, 0.05);
    this.clock += dt;
    this.fps = this.fps * 0.95 + (1 / Math.max(rawDt, 1e-4)) * 0.05;
    const inp = this.input.poll(this.clock);
    if (inp.sys.pause && this.inMatch) this.setPaused(!this.paused);
    if (inp.sys.photo) this.togglePhoto();

    // time scale: hitstop < slow motion < normal; photo/pause freezes the fight
    if (this.hitstop > 0) this.hitstop -= dt;
    let ts = 1;
    if (this.freeze > 0) { this.freeze -= dt; ts = 0; }
    else if (this.slow) { this.slow.t -= dt; if (this.slow.t <= 0) this.slow = null; }
    if (this.slow) ts = Math.min(ts, this.slow.scale);
    // hitstop is a true freeze: both bodies hold the impact pose
    if (this.hitstop > 0) ts = 0;
    if (this.paused || this.photo) ts = 0;
    this.timeScale = ts;

    // timed effects (reveals) run on real time
    for (let i = this.events.length - 1; i >= 0; i--) {
      const e = this.events[i];
      e.t += dt;
      if (e.t < 0) continue;
      const k = Math.min(1, e.t / e.dur);
      e.fn(k);
      if (k >= 1) this.events.splice(i, 1);
    }

    if (this.phase === 'menu') this.updateMenu(dt);
    else if (this.fighters.length === 2) this.updateMatch(dt, inp);

    this.camera.nudge(inp.cam.x, inp.cam.y, dt);
    // sparks keep flying (slowed) through a freeze; swing trails hold with the bodies
    this.fx.update(this.photo || this.paused ? 0 : dt * Math.max(ts, 0.3), this.photo || this.paused ? 0 : dt * ts);
    this.updateDim(dt);
    this.watchFrameRate(rawDt);
    this.updateStats();
  }

  updateMenu(dt) {
    // re-enter each preview's stance with a crossfade before it ends: no loop pop
    for (const c of this.previews) {
      if (!c.active || !c._loopClip) continue;
      const n = this.scene.skeletalAnimationLibrary.get(c._loopClip)?.numFrames ?? 0;
      if (n && c.animationTime >= n - 10) {
        c._alt = !c._alt;
        c.crossfadeTo(c._alt ? `${c._loopClip}~` : c._loopClip, { duration: 0.3, loop: false, rootMotion: true });
      }
    }
    if (!this.camera.dragging && this.camera.idle > 1.5) this.camera.userYaw += dt * 0.18;
    this.camera.update(dt, { x: -0.85, z: 0 }, { x: 0.85, z: 0 });
  }

  playerInput(raw) {
    const p = this.p1;
    const r = this.camera.groundRight(), f = this.camera.groundForward();
    const wx = r.x * raw.sx + f.x * raw.sy, wz = r.z * raw.sx + f.z * raw.sy;
    const d = p.dirToOpponent();
    const fwdDot = wx * d.x + wz * d.z;
    const sideDot = wx * -d.z + wz * d.x;
    return {
      fwd: fwdDot > 0.38 ? 1 : fwdDot < -0.38 ? -1 : 0,
      side: sideDot > 0.38 ? 1 : sideDot < -0.38 ? -1 : 0,
      P: raw.P, K: raw.K, block: raw.block, dodge: raw.dodge, jump: raw.jump, special: raw.special,
      skill1: raw.skill1, skill2: raw.skill2,
      // W / S held as keys (screen up / down), for the W/S + J/U combinations
      up: raw.sy > 0, down: raw.sy < 0,
    };
  }

  updateMatch(dt, raw) {
    const [a, b] = this.fighters;
    const idle = { fwd: 0, side: 0, P: false, K: false, block: false, dodge: false, special: false };
    this.phaseTime += dt;

    if (this.phase === 'intro') {
      const d = this.introDelay || 0;
      if (this.introStage === 0 && this.phaseTime > 1.0 + d) { this.introStage = 1; this.banner(`ROUND ${this.round}`, 1100); }
      if (this.introStage === 1 && this.phaseTime > 2.3 + d) { this.introStage = 2; this.banner('FIGHT!', 700); }
      if (this.introStage === 2 && this.phaseTime > 2.7 + d) {
        this.phase = 'fight';
        for (const f of this.fighters) { f.setState('idle'); f.loopAnim('stance'); }
      }
      a.update(dt, idle); b.update(dt, idle);
    } else if (this.phase === 'fight') {
      // presses made during a hitstop freeze are held and delivered on the
      // first frame after it, so a combo can be buffered on the impact
      let pin = idle;
      if (this.timeScale > 0) {
        const held = this.heldInput;
        this.heldInput = null;
        pin = this.playerInput(held ? { ...raw, P: raw.P || held.P, K: raw.K || held.K, dodge: raw.dodge || held.dodge, jump: raw.jump || held.jump, special: raw.special || held.special, skill1: raw.skill1 || held.skill1, skill2: raw.skill2 || held.skill2 } : raw);
      } else if (!this.paused && !this.photo) {
        const h = (this.heldInput ??= {});
        for (const k of ['P', 'K', 'dodge', 'jump', 'special', 'skill1', 'skill2']) h[k] = h[k] || raw[k];
      }
      const cin = this.timeScale > 0 ? this.ai.input(dt * this.timeScale) : idle;
      a.update(dt, pin);
      b.update(dt, cin);
      this.updateProjectiles(dt * this.timeScale);
      this.timer -= dt * this.timeScale;
      if (this.timer <= 0 && this.phase === 'fight') this.timeOver();
    } else if (this.phase === 'ko') {
      a.update(dt, idle); b.update(dt, idle);
      const w = this.koWinner, l = this.koLoser;
      // let the slow-motion fall play out before celebrating and dissolving
      if (this.phaseTime > 3.4 && w.state !== 'win') {
        w.setState('win');
        w.play('cheer', { loop: true, fade: 0.35 });
      }
      if (this.phaseTime > 4.2 && !l._dissolved) {
        l._dissolved = true;
        this.runReveal(l.character, 1.4, { inverse: true });
      }
      if (this.phaseTime > 6.6) this.endRound();
    }

    this.camera.update(dt, a, b);
    this.updateHUD();
  }

  timeOver() {
    const [a, b] = this.fighters;
    const pa = a.hp / a.maxHp, pb = b.hp / b.maxHp;
    this.phase = 'fight';
    if (Math.abs(pa - pb) < 0.001) { this.banner('DRAW', 1600); this.wins[0]++; this.wins[1]++; this.phase = 'ko'; this.phaseTime = 4.6; this.koWinner = a; this.koLoser = b; return; }
    const winner = pa > pb ? a : b, loser = winner === a ? b : a;
    this.phase = 'fight';
    this.onKO(winner, loser);
    this.banner('TIME', 1600);
  }

  endRound() {
    const need = TUNING.roundsToWin;
    if (this.wins[0] >= need || this.wins[1] >= need) return this.endMatch();
    this.round++;
    this.koWinner = this.koLoser = null;
    this.startRound();
  }

  endMatch() {
    this.phase = 'result';
    const won = this.wins[0] > this.wins[1];
    $('resultTitle').textContent = won ? 'YOU WIN' : this.wins[0] === this.wins[1] ? 'DRAW' : 'YOU LOSE';    $('resultTitle').style.color = won ? '#ffd34d' : '#ff5a5a';
    $('resultSub').textContent = `${this.p1.def.name}  ${this.wins[0]} - ${this.wins[1]}  ${this.cpu.def.name}`;
    $('result').classList.remove('hidden');
    this.camera.free = true;
  }

  // ---------------------------------------------------------------- UI
  banner(html, ms = 1000) {
    const el = $('banner');
    el.innerHTML = html;
    el.classList.remove('show');
    void el.offsetWidth;
    el.classList.add('show');
    clearTimeout(this._bannerT);
    this._bannerT = setTimeout(() => el.classList.remove('show'), ms);
  }

  // COUNTER / PUNISH text on the attacker's side of the screen
  callout(f, text) {
    const el = $(f.slot === 0 ? 'calloutL' : 'calloutR');
    el.textContent = text;
    el.style.setProperty('--cc', f.def.color);
    el.classList.remove('show');
    void el.offsetWidth;
    el.classList.add('show');
  }

  toast(text, ms = 700) {
    const el = $('toast');
    el.textContent = text;
    el.classList.toggle('show', !!text);
    clearTimeout(this._toastT);
    if (text) this._toastT = setTimeout(() => el.classList.remove('show'), ms);
  }

  setPaused(p) {
    this.paused = p;
    $('pause').classList.toggle('hidden', !p);
    if (p && this.p1) this.renderMoveList(this.p1);
    this.input.touch?.reset(); // no button stays "held" across the pause screen
  }

  // Phones: play fullscreen and sideways where the browser allows it (Android
  // Chrome; iOS Safari has neither and keeps the "turn your phone" prompt)
  goFullscreen() {
    if (!isTouchDevice() || document.fullscreenElement || document.webkitFullscreenElement) return;
    this.enterFullscreen(false);
  }

  // The fullscreen buttons. iPhone Safari has no fullscreen for web pages:
  // the way there is adding the game to the home screen, so say how.
  toggleFullscreen() {
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
      return;
    }
    this.enterFullscreen(true);
  }

  enterFullscreen(explain) {
    const el = document.documentElement;
    const req = el.requestFullscreen || el.webkitRequestFullscreen;
    const fail = () => {
      if (!explain) return;
      // its own notice: the HUD toast is hidden while the menu is up
      let n = $('fsNote');
      if (!n) { n = document.createElement('div'); n.id = 'fsNote'; document.body.appendChild(n); }
      n.textContent = '这个浏览器没有进入全屏。iPhone：点 Safari 的「分享」→「添加到主屏幕」，从主屏幕图标打开就是全屏；其他手机可以换用 Chrome 打开。';
      n.classList.add('show');
      clearTimeout(this._fsNoteT);
      this._fsNoteT = setTimeout(() => n.classList.remove('show'), 5000);
    };
    if (!req) return fail();
    // a browser that silently ignores the request gets the instructions too
    if (explain) setTimeout(() => { if (!document.fullscreenElement && !document.webkitFullscreenElement) fail(); }, 1500);
    try {
      const p = req.call(el, { navigationUI: 'hide' });
      Promise.resolve(p)
        .then(() => screen.orientation?.lock?.('landscape').catch(() => {}))
        .catch(fail);
    } catch { fail(); }
  }

  // The fighter's moves and every combo string, read from its starter and
  // combo tables (so the list can never disagree with what the game does)
  renderMoveList(f) {
    const def = f.def, names = def.moveNames || {};
    const st = { ...STARTERS, ...(def.starters || {}) };
    const routes = def.combos || COMBOS;
    const key = (k) => `${k[0] === 'f' ? '<kbd>→</kbd>' : k[0] === 'b' ? '<kbd>←</kbd>' : ''}<kbd>${k.endsWith('P') ? 'J' : 'U'}</kbd>`;
    const label = (m) => names[m] || m;
    const rows = [];
    // single strikes
    for (const k of ['P', 'K', 'fP', 'fK', 'bP', 'bK']) if (st[k] && f.moves[st[k]]) rows.push([key(k), label(st[k]), st[k] === 'finisher']);
    // combo strings: every maximal path from a starter, up to 4 hits
    const seen = new Set();
    const walk = (move, keys, path) => {
      const next = routes[move] || {};
      const branches = Object.entries(next).filter(([, m]) => f.moves[m] && !path.includes(m));
      if ((!branches.length || path.length >= 4) && path.length > 1) {
        const id = path.join('>');
        if (!seen.has(id)) { seen.add(id); rows.push([keys.join(''), path.map(label).join(' → '), path.at(-1) === 'finisher']); }
        return;
      }
      for (const [b, m] of branches) walk(m, [...keys, key(b)], [...path, m]);
    };
    for (const k of ['P', 'K', 'fP', 'fK']) if (st[k] && f.moves[st[k]]) walk(st[k], [key(k)], [st[k]]);
    rows.push(['<kbd>K</kbd> 空中 <kbd>J</kbd>/<kbd>U</kbd>', label('jump_kick'), false]);
    // skills: also cancel a strike that landed (J J then the skill)
    const tip = { projectile: '飞行道具', invuln: '起身无敌·对空', advance: '突进', armor: '霸体' };
    const kind = (m) => (m.projectile ? tip.projectile : m.armor ? `${tip.advance}·${tip.armor}` : m.invuln === true ? tip.invuln : m.advance ? tip.advance : '');
    if (f.moves.skill1) rows.push(['<kbd>S</kbd>+<kbd>J</kbd> / <kbd>O</kbd>', `${label('skill1')}<small>（${kind(f.moves.skill1)}）</small>`, true]);
    if (f.moves.skill2) rows.push(['<kbd>S</kbd>+<kbd>U</kbd>', `${label('skill2')}<small>（${kind(f.moves.skill2)}）</small>`, true]);
    if (f.moves.throw) rows.push(['近身 <kbd>W</kbd>+<kbd>J</kbd> / <kbd>L</kbd>+<kbd>J</kbd>', `${label('throw')}<small>（投技，无视防御）</small>`, true]);
    if (f.moves.spin_kick) rows.push(['<kbd>W</kbd>+<kbd>U</kbd>', label('spin_kick'), false]);
    rows.push(['<kbd>J</kbd><kbd>J</kbd> → <kbd>S</kbd>+<kbd>J</kbd>', '打中后接技能取消', false]);
    rows.push(['<kbd>I</kbd> / <kbd>J</kbd>+<kbd>U</kbd>', `${label('special')}（必杀槽满）`, true]);
    $('moveList').innerHTML = `<h3 style="color:${def.color}">${def.name} 招式表</h3>` +
      rows.map(([k, t, fin]) => `<div class="row"><span class="keys">${k}</span><span class="${fin ? 'fin' : ''}">${t}</span></div>`).join('');
  }

  togglePhoto() {
    if (!this.inMatch && !this.photo) return;
    this.photo = !this.photo;
    this.camera.free = this.photo;
    $('photoHint').classList.toggle('hidden', !this.photo);
    $('keys').classList.toggle('hidden', this.photo);
  }

  // ---------------------------------------------------------------- stages
  static savedStage() {
    try { const s = localStorage.getItem('splatFighter.stage'); return STAGES.some((x) => x.id === s) ? s : STAGES[0].id; } catch { return STAGES[0].id; }
  }

  // Load a stage's Gaussian scene, replacing the current one. A raw PINOC
  // scene is in arbitrary units with the capture point at its origin and the
  // floor ~1.5 m below: probe the floor straight down and scale so it lands at y=0.
  async loadStage(id) {
    const st = STAGES.find((x) => x.id === id) || STAGES[0];
    const ticket = (this.stageTicket = (this.stageTicket || 0) + 1);
    // (?v= busts the browser cache when a scene file is replaced)
    // Phones and the light tier load each scene's lite copy: the 35% of its
    // splats that carry the picture (big and opaque ones), each grown a little
    // to close the gaps - a third of the sorting and drawing, 5 MB not 16 MB
    const url = this.useLiteStages ? st.url.replace(/\.spz$/, '.lite.spz') : st.url;
    const env = await Environment.load(this.scene, `${url}?v=${MOTION_VERSION}`, { name: `stage_${st.id}`, filename: url.split('/').pop() });
    // a newer pick arrived while this one loaded
    if (ticket !== this.stageTicket) { env.destroy(); return; }
    let depth = st.floorDepthUnits ?? ARENA.floorDepthUnits;
    if (!st.noProbe) {
      try {
        const g = env.probeGroundDepth(-1);
        if (g && g.depth && g.flatness > 0.6) depth = g.depth;
      } catch { /* keep the fallback */ }
    }
    this.stageDepth = depth;
    const s = ARENA.captureHeight / depth;
    env.entity.setLocalScale(s, s, s);
    env.entity.setLocalPosition(0, ARENA.captureHeight, 0);
    env.entity.setLocalEulerAngles(0, st.yaw || 0, 0);
    // swap: the old scene goes only once the new one is in place
    const old = this.env;
    if (this.fx.shock) { try { old?.setShock(null); } catch { /* gone */ } this.fx.shock = null; }
    this.env = env;
    this.stage = st;
    this.fx.setEnv(env);
    this.dimLevel = 0;
    old?.destroy();
    // warm the env tint path (supers darken the arena with it): its first use
    // rebuilt the env's work buffer mid-fight and left a band of stale tiles
    try {
      env.setTint(0.01);
      await new Promise((resolve) => requestAnimationFrame(resolve));
      env.setTint(0);
    } catch { /* optional */ }
    try { this.envSplats = env.asset.resource.gsplatData?.numSplats ?? env.asset.resource.numSplats ?? 0; } catch { this.envSplats = 0; }
    try { localStorage.setItem('splatFighter.stage', st.id); } catch { /* storage blocked */ }
  }

  // ---------------------------------------------------------------- quality
  static savedQuality() {
    try { const q = localStorage.getItem('splatFighter.quality'); return ['high', 'perf', 'low'].includes(q) ? q : null; } catch { return null; }
  }

  // Older machines start on the light tier: no WebGPU (the WebGL2 fallback
  // sorts splats on the CPU), or few cores / little memory
  static detectQuality() {
    const webgpu = !!navigator.gpu;
    const cores = navigator.hardwareConcurrency || 4;
    const mem = navigator.deviceMemory || 8;
    // phones and tablets: mobile GPUs and batteries start on the light tier
    if (isTouchDevice()) return 'low';
    if (!webgpu || cores <= 4 || mem <= 4) return 'low';
    return 'high';
  }

  // Apply a tier everywhere: splat count per fighter, render resolution (splat
  // rendering is fill-bound, so 70% resolution is the biggest saving on an old
  // GPU), and how much the effects spawn.
  // Resolution: high renders at the screen's real pixel density (a 150-175%
  // Windows display scale or a Retina screen; capped at 2x) - capped at 1x the
  // scene was drawn at ~57% of the screen's pixels on a 175% display and
  // stretched, which blurred the backgrounds. The frame-rate guard steps down
  // if that is too much for the GPU.
  applyQuality(q, save = true) {
    this.quality = q;
    for (const f of this.fighters) f.setQuality(q);
    const dev = this.scene?.app.graphicsDevice;
    if (dev) {
      const dpr = window.devicePixelRatio || 1;
      // phones have 3x screens and small GPUs: splat drawing is fill-bound, so
      // they render nearer 1x (high 1.5x, standard 1x, light 0.75x)
      const ratio = isTouchDevice()
        ? Math.min(dpr, q === 'low' ? 0.75 : q === 'perf' ? 1 : 1.5)
        : q === 'low' ? 0.7 : q === 'perf' ? Math.min(dpr, 1.25) : Math.min(dpr, 2);
      // (the engine sizes the canvas from a ResizeObserver that only fires when
      // the element changes size, and app.resizeCanvas is a no-op there: set
      // the new resolution directly; later window resizes keep the cap)
      dev.maxPixelRatio = ratio;
      const c = this.canvas, px = Math.min(dpr, ratio);
      const w = Math.ceil(c.clientWidth * px), h = Math.ceil(c.clientHeight * px);
      if (w > 0 && h > 0 && (c.width !== w || c.height !== h)) { dev.setResolution(w, h); this.scene.app.renderNextFrame = true; }
    }
    if (this.fx) { this.fx.density = q === 'low' ? 0.4 : 1; this.fx.lite = q === 'low'; }
    $('qual')?.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === q));
    if (save) try { localStorage.setItem('splatFighter.quality', q); } catch { /* storage blocked */ }
    this.scheduleMatchPreparation();
  }

  toggleQuality() {
    const next = { high: 'perf', perf: 'low', low: 'high' }[this.quality];
    this.applyQuality(next);
    this.toast({ high: '画质：高（每个角色 48,000 高斯）', perf: '画质：标准（每个角色 16,000 高斯）', low: '画质：流畅（老机型：降低分辨率与特效）' }[next], 1400);
  }

  // Frame-rate guard: a fight that runs under 30 fps for 5 s steps down a tier
  watchFrameRate(dt) {
    if (this.phase !== 'fight' || this.quality === 'low' || this.paused) { this.slowTime = 0; return; }
    this.slowTime = this.fps < 30 ? (this.slowTime || 0) + dt : Math.max(0, (this.slowTime || 0) - dt * 2);
    if (this.slowTime > 5) {
      this.slowTime = 0;
      const next = this.quality === 'high' ? 'perf' : 'low';
      this.applyQuality(next);
      this.toast(next === 'low' ? '帧率偏低，已切换到「流畅」画质' : '帧率偏低，已切换到「标准」画质', 2200);
    }
  }

  updateHUD() {
    const [a, b] = this.fighters;
    const setSide = (f, s) => {
      const hp = $(`hp${s}`);
      const pct = Math.max(0, f.hp / f.maxHp) * 100;
      hp.querySelector('.fill').style.width = `${pct}%`;
      hp.querySelector('.lag').style.width = `${pct}%`;
      hp.classList.toggle('low', pct < 25);
      const m = $(`meter${s}`);
      m.querySelector('.m').style.width = `${f.meter}%`;
      m.classList.toggle('full', f.meter >= TUNING.meterMax);
      $(`meterLabel${s}`).textContent = f.meter >= TUNING.meterMax ? (f.slot === 0 ? (this.input.touch ? '必杀就绪 · 点「必杀」' : '必杀就绪 · 按 I') : '必杀就绪') : '必杀槽';
      // the on-screen 必杀 button glows when the player's meter is full
      if (f.slot === 0) document.body.classList.toggle('meter-full', f.meter >= TUNING.meterMax);
      [...$(`wins${s}`).children].forEach((pip, i) => pip.classList.toggle('on', i < this.wins[f.slot]));
      const combo = $(`combo${s}`);
      const show = f.combo >= 2 && f.comboTimer > 0;
      combo.classList.toggle('show', show);
      if (show) combo.querySelector('b').textContent = f.combo;
    };
    setSide(a, 'L');
    setSide(b, 'R');
    const t = Math.max(0, Math.ceil(this.timer));
    $('timer').textContent = t;
    $('timer').classList.toggle('low', t <= 10);
  }

  updateStats() {
    if ((this._statT = (this._statT || 0) + 1) % 15) return;
    let chars = 0;
    if (this.phase === 'menu') chars = this.previews.filter((c) => c.active).reduce((n, c) => n + c.splat.numSplats, 0);
    else chars = this.fighters.reduce((n, f) => n + f.splatCount, 0);
    $('stats').innerHTML = `${Math.round(this.fps)} FPS<br>角色高斯 ${chars.toLocaleString()}<br>场景高斯 ${this.envSplats ? this.envSplats.toLocaleString() : '—'}`;
  }
}

// Every engine download (scenes, fighters, ~130 motion clips) goes through
// here. Phones on a weak connection drop requests - iPhone Safari reports it
// as "Load failed" - and starting all of them at once made that likelier;
// one lost clip used to stop the whole start-up. So: a few downloads at a
// time, and a dropped one is retried with a growing pause.
const MAX_PARALLEL = isTouchDevice() ? 6 : 12;
let running = 0;
const waiting = [];
const slot = () => (running < MAX_PARALLEL ? (running++, Promise.resolve()) : new Promise((r) => waiting.push(r)));
const release = () => { const next = waiting.shift(); if (next) next(); else running--; };
let lastFailedUrl = '';
// ?flaky=0.25 drops that share of downloads on purpose, to test the retries
const FLAKY = Number(new URLSearchParams(location.search).get('flaky')) || 0;
let dropped = 0;
setAssetFetch(async (url, init) => {
  await slot();
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        if (FLAKY && Math.random() < FLAKY) { dropped++; window.__droppedDownloads = dropped; throw new TypeError('Load failed (simulated)'); }
        const res = await fetch(url, init);
        // server hiccups are worth another try; a missing file is not
        if ((res.status >= 500 || res.status === 429) && attempt < 5) throw new Error(`HTTP ${res.status}`);
        return res;
      } catch (e) {
        if (init?.signal?.aborted || attempt >= 5) { lastFailedUrl = String(url); throw e; }
        await sleep(600 * 2 ** attempt); // 0.6 s, 1.2 s, 2.4 s, 4.8 s, 9.6 s
      }
    }
  } finally { release(); }
});

const game = new Game();
window.__game = game;
game.boot().catch((e) => {
  window.splatCompatibility.bootFailed(e, lastFailedUrl);
});
