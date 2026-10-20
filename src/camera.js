// Fight camera: frames both fighters from the side, lets the player orbit
// freely (drag / wheel), drifts back after a pause, and runs short cinematic
// orbits for combos, specials and KOs.
import { Vec3 } from 'playcanvas';

const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export class FightCamera {
  constructor(scene, canvas) {
    this.scene = scene;
    this.entity = scene.cameraEntity;
    this.canvas = canvas;
    this.userYaw = 0;
    this.userPitch = 0;
    this.zoom = 1;
    this.idle = 99;
    this.free = false;     // photo mode: no auto-return
    this.side = 1;
    this.shake = 0;
    this.cine = null;
    this.pos = new Vec3(0, 1.6, 5);
    this.look = new Vec3(0, 1.1, 0);
    this.tmp = new Vec3();
    this.dragging = false;
    this.attach();
  }

  attach() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => {
      if (e.target !== c) return;
      this.dragging = true; this.lx = e.clientX; this.ly = e.clientY;
      c.setPointerCapture(e.pointerId);
    });
    c.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      const dx = e.clientX - this.lx, dy = e.clientY - this.ly;
      this.lx = e.clientX; this.ly = e.clientY;
      this.userYaw -= dx * 0.006;
      this.userPitch = clamp(this.userPitch + dy * 0.004, -0.35, 1.1);
      this.idle = 0;
    });
    const up = () => { this.dragging = false; };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.zoom = clamp(this.zoom * Math.exp(e.deltaY * 0.0012), 0.45, 2.2);
      this.idle = 0;
    }, { passive: false });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  // Gamepad right stick
  nudge(dx, dy, dt) {
    if (Math.abs(dx) < 0.15 && Math.abs(dy) < 0.15) return;
    this.userYaw -= dx * dt * 2.2;
    this.userPitch = clamp(this.userPitch + dy * dt * 1.4, -0.35, 1.1);
    this.idle = 0;
  }

  // yawAdd in radians, distMul < 1 moves closer
  cinematic({ duration = 1.2, yawAdd = 1.1, distMul = 0.6, pitch = 0.05, focus = null, focusWeight } = {}) {
    this.cine = { t: 0, duration, yawAdd, distMul, pitch, focus, focusWeight };
  }

  // dir: world-space unit vector of the blow (attacker -> defender), optional
  addShake(a, dir = null) {
    if (a >= this.shake || dir) { this.shakeT = 0; this.shakeDir = dir; }
    this.shake = Math.max(this.shake, a);
  }

  // Screen-space right vector projected on the ground plane, for input mapping
  groundRight() {
    const r = this.entity.right;
    const l = Math.hypot(r.x, r.z) || 1;
    return { x: r.x / l, z: r.z / l };
  }
  groundForward() {
    const f = this.entity.forward;
    const l = Math.hypot(f.x, f.z) || 1;
    return { x: f.x / l, z: f.z / l };
  }

  update(dt, a, b, opts = {}) {
    this.idle += dt;
    const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
    let dx = b.x - a.x, dz = b.z - a.z;
    const sep = Math.hypot(dx, dz) || 1;
    dx /= sep; dz /= sep;
    // Side normal with a FIXED handedness: fighter `a` always stays on the left.
    // (Choosing the side from the camera's current position made the camera
    // flip back and forth every frame once an orbit passed 90 degrees.)
    const nx = -dz, nz = dx;
    const baseYaw = Math.atan2(nx, nz);

    if (!this.free && !this.dragging && this.idle > 2.5) {
      const k = Math.min(1, dt * 1.6);
      this.userYaw = lerp(this.userYaw, 0, k);
      this.userPitch = lerp(this.userPitch, 0, k);
      this.zoom = lerp(this.zoom, 1, k * 0.6);
    }

    // Tekken-style framing: square to the fight axis, camera at chest height
    // (~1.4 m) looking almost level, pulling back as the fighters separate
    let yaw = baseYaw + this.userYaw;
    let pitch = 0.045 + this.userPitch;
    let dist = (2.2 + sep * 0.85) * this.zoom;
    let fx = mx, fz = mz, fy = 0.98;

    if (this.cine) {
      const c = this.cine;
      c.t += dt;
      const p = clamp(c.t / c.duration, 0, 1);
      const w = Math.sin(p * Math.PI); // ease in and back out
      yaw += c.yawAdd * w;
      pitch += c.pitch * w;
      dist *= lerp(1, c.distMul, w);
      if (c.focus) {
        const fw = w * (c.focusWeight ?? 0.6);
        fx = lerp(mx, c.focus.x, fw); fz = lerp(mz, c.focus.z, fw); fy = lerp(1.08, c.focus.y ?? 1.2, fw);
      }
      if (p >= 1) this.cine = null;
    }

    dist = Math.max(dist, 1.1);
    const tx = fx + Math.sin(yaw) * Math.cos(pitch) * dist;
    const tz = fz + Math.cos(yaw) * Math.cos(pitch) * dist;
    const ty = fy + 0.18 + Math.sin(pitch) * dist;

    const k = opts.snap ? 1 : Math.min(1, dt * 5);
    this.pos.set(lerp(this.pos.x, tx, k), lerp(this.pos.y, ty, k), lerp(this.pos.z, tz, k));
    this.look.set(lerp(this.look.x, fx, k), lerp(this.look.y, fy, k), lerp(this.look.z, fz, k));

    // Shake: a damped spring kick along the blow's direction (the frame jolts
    // the way the hit travels, then settles) plus a smooth low-frequency wobble.
    // Random per-frame jitter read as noise rather than impact.
    this.shakeT = (this.shakeT ?? 9) + dt;
    this.shake = Math.max(0, this.shake - dt * 2.4);
    const amp = this.shake * this.shake * (this.shakeScale ?? 1);
    const t = this.shakeT, sd = this.shakeDir;
    const kick = amp * 0.11 * Math.exp(-t * 9) * Math.cos(t * 34);
    const n = (a, b, c) => Math.sin(t * a + c) * 0.6 + Math.sin(t * b + c * 2.3) * 0.4;
    const wob = amp * 0.035;
    const ox = (sd ? sd.x * kick : 0) + n(23, 41, 1.7) * wob;
    const oy = -Math.abs(kick) * 0.35 + n(29, 47, 4.1) * wob;
    const oz = (sd ? sd.z * kick : 0) + n(19, 37, 2.9) * wob;
    this.entity.setPosition(this.pos.x + ox, this.pos.y + oy, this.pos.z + oz);
    this.entity.lookAt(this.look.x + ox * 0.5, this.look.y + oy * 0.5, this.look.z + oz * 0.5);

    // impact punch: a quick FOV squeeze that springs back, plus a dutch roll
    const cam = this.entity.camera;
    if (this.baseFov === undefined) this.baseFov = cam.fov;
    this.kick = (this.kick || 0) * Math.max(0, 1 - dt * 9);
    this.roll = (this.roll || 0) * Math.max(0, 1 - dt * 4);
    cam.fov = this.baseFov - this.kick;
    if (Math.abs(this.roll) > 0.01) this.entity.rotateLocal(0, 0, this.roll);
  }

  // heavy hit: FOV squeeze (degrees) and a roll (degrees) in a random direction
  punch(fov = 5, roll = 3) {
    const s = this.punchScale ?? 1;
    this.kick = Math.max(this.kick || 0, fov * s);
    this.roll = (Math.random() < 0.5 ? -1 : 1) * roll * s;
  }

  // world -> CSS pixel position on the canvas
  toScreen(x, y, z, out) {
    this.tmp.set(x, y, z);
    const cam = this.entity.camera;
    const v = cam.worldToScreen(this.tmp, new Vec3());
    const rect = this.canvas.getBoundingClientRect();
    const sx = rect.width / (this.canvas.clientWidth || rect.width);
    out.x = v.x * sx; out.y = v.y * sx; out.z = v.z;
    return out;
  }
}
