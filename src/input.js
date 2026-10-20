// Keyboard + gamepad + on-screen touch controls. Movement is read in screen
// space and converted to fighter space by the game, so controls stay intuitive
// while the camera orbits.
import { TouchControls, isTouchDevice } from './touch.js';

const KEYMAP = {
  left: ['KeyA', 'ArrowLeft'], right: ['KeyD', 'ArrowRight'],
  up: ['KeyW', 'ArrowUp'], down: ['KeyS', 'ArrowDown'],
  // J punch, U kick, K jump, I special, L block, O / Y skills
  P: ['KeyJ', 'Numpad4'], K: ['KeyU', 'Numpad5'], block: ['KeyL', 'Numpad6'],
  dodge: ['Space', 'Numpad0'], special: ['KeyI', 'Numpad8'], jump: ['KeyK', 'Numpad9'],
  skill1: ['KeyO', 'Numpad7'], skill2: ['KeyY', 'Numpad1'],
};

export class Input {
  constructor() {
    this.down = new Set();
    this.pressed = new Set();
    this.handlers = {};
    this.prevPad = [];
    this.lastP = -1;
    this.lastK = -1;
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
      this.down.add(e.code);
      this.pressed.add(e.code);
      this.handlers[e.code]?.(e);
    });
    window.addEventListener('keyup', (e) => this.down.delete(e.code));
    window.addEventListener('blur', () => { this.down.clear(); this.touch?.reset(); });
    this.touch = isTouchDevice() ? new TouchControls(document.getElementById('touch')) : null;
  }

  on(code, fn) { this.handlers[code] = fn; }

  isDown(action) { return KEYMAP[action].some((c) => this.down.has(c)); }
  wasPressed(action) { return KEYMAP[action].some((c) => this.pressed.has(c)); }

  pad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads) if (p && p.connected) return p;
    return null;
  }

  // returns screen-space intent + action edges for this frame
  poll(now) {
    const pad = this.pad();
    const btn = (i) => !!pad?.buttons[i]?.pressed;
    const edge = (i) => btn(i) && !this.prevPad[i];

    let sx = (this.isDown('right') ? 1 : 0) - (this.isDown('left') ? 1 : 0);
    let sy = (this.isDown('up') ? 1 : 0) - (this.isDown('down') ? 1 : 0);
    let cam = { x: 0, y: 0 };
    if (pad) {
      const ax = pad.axes[0] || 0, ay = pad.axes[1] || 0;
      if (Math.abs(ax) > 0.35) sx = Math.sign(ax);
      if (Math.abs(ay) > 0.35) sy = -Math.sign(ay);
      if (btn(15)) sx = 1; if (btn(14)) sx = -1; if (btn(12)) sy = 1; if (btn(13)) sy = -1;
      cam = { x: pad.axes[2] || 0, y: pad.axes[3] || 0 };
    }

    // touch: the joystick overrides the keys while a thumb is on it
    const t = this.touch;
    const tp = t ? t.take() : new Set();
    if (t?.stick) { sx = t.sx; sy = t.sy; }

    let P = this.wasPressed('P') || edge(2) || tp.has('P');
    let K = this.wasPressed('K') || edge(3) || tp.has('K');
    const block = this.isDown('block') || btn(5) || !!t?.held.has('block');
    const dodge = this.wasPressed('dodge') || edge(0) || tp.has('dodge');
    const jump = this.wasPressed('jump') || edge(1) || tp.has('jump');
    let special = this.wasPressed('special') || edge(7) || tp.has('special');
    // pad: LB / LT are the two skills
    const skill1 = this.wasPressed('skill1') || edge(4) || tp.has('skill1');
    const skill2 = this.wasPressed('skill2') || edge(6) || tp.has('skill2');

    // pressing punch and kick (J+U) together also fires the special
    if (P) this.lastP = now;
    if (K) this.lastK = now;
    if ((P || K) && Math.abs(this.lastP - this.lastK) < 0.09) { special = true; }

    const sys = { photo: edge(8), pause: edge(9) };
    if (pad) this.prevPad = pad.buttons.map((b) => b.pressed);
    this.pressed.clear();
    return { sx, sy, P, K, block, dodge, jump, special, skill1, skill2, cam, sys };
  }
}
