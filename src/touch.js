// On-screen controls for phones and tablets: a floating joystick on the left
// half of the screen and a cluster of action buttons on the right. They feed
// the same screen-space intent and button edges as the keyboard (see Input),
// so every key combination (S + J, W + J, J + U...) works the same way.

// (the primary pointer is a finger: phones and tablets, not a laptop that
// merely has a touch screen)
// (?touch=1 forces it, to try the phone layout on a computer)
export const isTouchDevice = () => /[?&]touch=1/.test(location.search)
  || (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches);

// joystick travel (px) for full deflection, and the dead zone per axis
const RADIUS = 46;
const DEAD = 0.38;

export class TouchControls {
  constructor(root) {
    this.root = root;
    this.sx = 0; this.sy = 0;
    this.held = new Set();     // buttons currently under a finger
    this.pressed = new Set();  // buttons pressed since the last poll
    this.stick = null;         // { id, x0, y0 }
    if (!root) return;
    this.zone = root.querySelector('.stick-zone');
    this.base = root.querySelector('.stick-base');
    this.knob = root.querySelector('.stick-knob');
    this.bindStick();
    for (const b of root.querySelectorAll('[data-act]')) this.bindButton(b);
  }

  bindStick() {
    const z = this.zone;
    z.addEventListener('pointerdown', (e) => {
      if (this.stick) return;
      e.preventDefault();
      try { z.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
      // the stick appears under the thumb, wherever it lands in the zone
      const r = z.getBoundingClientRect();
      this.stick = { id: e.pointerId, x0: e.clientX, y0: e.clientY };
      this.base.style.left = `${e.clientX - r.left}px`;
      this.base.style.top = `${e.clientY - r.top}px`;
      this.base.classList.add('on');
      this.move(e);
    });
    z.addEventListener('pointermove', (e) => { if (this.stick?.id === e.pointerId) this.move(e); });
    const end = (e) => {
      if (this.stick?.id !== e.pointerId) return;
      this.stick = null;
      this.sx = this.sy = 0;
      this.knob.style.transform = 'translate(-50%, -50%)';
      this.base.classList.remove('on');
    };
    z.addEventListener('pointerup', end);
    z.addEventListener('pointercancel', end);
  }

  move(e) {
    let dx = e.clientX - this.stick.x0, dy = e.clientY - this.stick.y0;
    const len = Math.hypot(dx, dy);
    if (len > RADIUS) { dx *= RADIUS / len; dy *= RADIUS / len; }
    this.knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
    const nx = dx / RADIUS, ny = -dy / RADIUS; // screen up = +1, like W
    this.sx = nx > DEAD ? 1 : nx < -DEAD ? -1 : 0;
    this.sy = ny > DEAD ? 1 : ny < -DEAD ? -1 : 0;
  }

  bindButton(b) {
    const act = b.dataset.act;
    const fingers = new Set();
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      try { b.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
      fingers.add(e.pointerId);
      this.held.add(act);
      this.pressed.add(act);
      b.classList.add('down');
      navigator.vibrate?.(8);
    });
    const up = (e) => {
      fingers.delete(e.pointerId);
      if (fingers.size) return;
      this.held.delete(act);
      b.classList.remove('down');
    };
    b.addEventListener('pointerup', up);
    b.addEventListener('pointercancel', up);
    b.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  // read and clear this frame's button presses
  take() {
    const p = this.pressed;
    this.pressed = new Set();
    return p;
  }

  reset() {
    this.held.clear(); this.pressed.clear();
    this.sx = this.sy = 0;
    this.stick = null;
    this.base?.classList.remove('on');
    this.root?.querySelectorAll('.down').forEach((b) => b.classList.remove('down'));
  }
}
