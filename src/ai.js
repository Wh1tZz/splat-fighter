// CPU opponent: a small state machine that drives a Fighter through the same
// input object the player uses, so it never touches combat state directly.
export const DIFFICULTY = {
  easy:   { label: '入门', react: 0.55, guard: 0.18, evade: 0.06, aggression: 0.35, maxChain: 1, special: 0.25 },
  normal: { label: '普通', react: 0.32, guard: 0.42, evade: 0.14, aggression: 0.55, maxChain: 2, special: 0.6 },
  hard:   { label: '高手', react: 0.18, guard: 0.62, evade: 0.22, aggression: 0.75, maxChain: 3, special: 1.0 },
};

// button strings: b = back, f = forward. Each fighter's own combo table
// decides what they become (and drops presses that lead nowhere).
const ROUTES = [
  ['P'], ['P', 'P'], ['P', 'P', 'P'], ['P', 'P', 'K'], ['P', 'K', 'K'], ['K'], ['K', 'K'], ['bP'], ['bK'],
  ['P', 'P', 'P', 'P'], ['P', 'P', 'P', 'K'], ['K', 'K', 'K'], ['fP', 'P'], ['fK', 'P'],
];
// lunging openers for when the opponent stands just out of reach
const LUNGES = [['fP'], ['fP', 'P'], ['fK'], ['fK', 'K']];

export class AI {
  constructor(fighter, level) {
    this.f = fighter;
    this.cfg = DIFFICULTY[level] || DIFFICULTY.normal;
    this.think = 0;
    this.intent = 'approach';
    this.intentTime = 0;
    this.route = null;
    this.routeStep = 0;
    this.reactTimer = -1;
    this.seenMove = null;
    this.holdBlock = 0;
    this.strafeDir = Math.random() < 0.5 ? -1 : 1;
  }

  input(dt) {
    const f = this.f, o = f.opponent, c = this.cfg;
    const inp = { fwd: 0, side: 0, P: false, K: false, block: false, dodge: false, special: false };
    const dist = f.dirToOpponent().dist;
    this.think -= dt;
    this.intentTime -= dt;

    // keep feeding a combo route while attacking
    if (f.state === 'attack' && this.route) {
      const mv = f.moves[f.move];
      const progress = (f.moveFrame - mv.start) / (mv.end - mv.start);
      if (progress > 0.35 && this.routeStep < this.route.length) {
        const b = this.route[this.routeStep];
        // S1 / S2: end the string in a skill (cancels a strike that landed)
        if (b === 'S1') inp.skill1 = true;
        else if (b === 'S2') inp.skill2 = true;
        else inp[b.replace(/[bf]/, '')] = true;
        if (b[0] === 'f') inp.fwd = 1;
        if (b[0] === 'b') inp.fwd = -1;
        this.routeStep++;
      }
      return inp;
    }
    if (f.state !== 'attack') this.route = null;

    // in the air: throw the planned flying kick once off the ground
    if (f.state === 'jump') {
      if (this.jumpKick && f.jump && f.jump.frame >= f.jump.air[0]) { inp.K = true; this.jumpKick = false; }
      return inp;
    }

    // defence: react to the player's strike after a human-ish delay
    if (o.state === 'attack' && o.move !== this.seenMove) {
      this.seenMove = o.move;
      this.reactTimer = c.react * (0.7 + Math.random() * 0.6);
      this.defence = Math.random();
    }
    if (o.state !== 'attack') this.seenMove = null;
    if (this.reactTimer >= 0) {
      this.reactTimer -= dt;
      if (this.reactTimer < 0 && dist < (o.moves[o.move]?.reach ?? 1.4) + 0.35) {
        if (this.defence < c.evade) inp.dodge = true;
        else if (this.defence < c.evade + c.guard) this.holdBlock = 0.45 + Math.random() * 0.3;
      }
    }
    if (this.holdBlock > 0) {
      this.holdBlock -= dt;
      inp.block = true;
      return inp;
    }
    if (f.state !== 'idle') return inp;

    // skills: which of the two does what for this fighter
    const skills = ['skill1', 'skill2'].filter((s) => f.moves[s]);
    const pickSkill = (test) => skills.find((s) => test(f.moves[s]));
    const useSkill = (s) => { inp[s] = true; return inp; };
    // anti-air: a rising, invincible skill against a jump-in
    if (o.state === 'jump' && dist < 2.2) {
      const aa = pickSkill((m) => m.invuln === true);
      if (aa && Math.random() < c.special * dt * 6) return useSkill(aa);
    }
    // a held guard invites a throw
    if (o.state === 'block' && dist < 1.15 && f.moves.throw && Math.random() < c.aggression * dt * 3) {
      inp.block = true; inp.P = true;
      return inp;
    }

    // offence
    if (this.think <= 0) {
      this.think = 0.12 + Math.random() * 0.25;
      if (f.meter >= 100 && dist < 1.55 && Math.random() < c.special * 0.5) {
        inp.special = true;
        return inp;
      }
      // from range: throw the projectile, or rush in with a dash skill
      const proj = pickSkill((m) => m.projectile);
      if (proj && dist > 1.8 && dist < 5 && Math.random() < c.aggression * 0.4) return useSkill(proj);
      const dash = pickSkill((m) => m.advance >= 1.8);
      if (dash && dist > 1.5 && dist < 2.8 && Math.random() < c.aggression * 0.3) return useSkill(dash);
      // up close, the rising skill now and then (it's invincible on the way up)
      const rise = pickSkill((m) => m.invuln === true);
      if (rise && dist < 1.3 && Math.random() < c.aggression * 0.08) return useSkill(rise);
      // up close: a throw now and then
      if (f.moves.throw && dist < 1.1 && Math.random() < c.aggression * 0.12) {
        inp.block = true; inp.P = true;
        return inp;
      }
      // now and then close a gap with a jumping flying kick
      if (dist > 1.6 && dist < 2.4 && Math.random() < c.aggression * 0.12) {
        inp.jump = true; inp.fwd = 1;
        this.jumpKick = Math.random() < 0.8;
        return inp;
      }
      const inRange = dist < 1.25;
      const kickRange = dist >= 1.25 && dist < 1.6;
      const lungeRange = dist >= 1.6 && dist < 2.3;
      if ((inRange || kickRange || (lungeRange && Math.random() < 0.35)) && Math.random() < c.aggression) {
        const pool = lungeRange ? LUNGES : kickRange ? [['K'], ['K', 'K'], ['bK'], ['fP'], ['fK']] : ROUTES;
        let r = pool[Math.floor(Math.random() * pool.length)].slice(0, c.maxChain + 1);
        // strings that end in a skill (normal and up)
        if (inRange && c.maxChain >= 2 && Math.random() < 0.25) r = [...r.slice(0, 2), Math.random() < 0.5 ? 'S1' : 'S2'];
        this.route = r;
        this.routeStep = 1;
        const first = r[0];
        if (first[0] === 'b') inp.fwd = -1;
        if (first[0] === 'f') inp.fwd = 1;
        inp[first.replace(/[bf]/, '')] = true;
        return inp;
      }
      if (this.intentTime <= 0) {
        this.intentTime = 0.5 + Math.random() * 1.2;
        const roll = Math.random();
        if (dist > 1.6) this.intent = roll < 0.75 ? 'approach' : 'circle';
        else if (dist < 1.0) this.intent = roll < 0.5 ? 'retreat' : 'wait';
        else this.intent = roll < 0.4 ? 'circle' : roll < 0.7 ? 'wait' : 'approach';
        if (this.intent === 'circle' && Math.random() < 0.5) this.strafeDir *= -1;
      }
    }
    if (this.intent === 'approach') inp.fwd = dist > 1.1 ? 1 : 0;
    else if (this.intent === 'retreat') inp.fwd = -1;
    else if (this.intent === 'circle') inp.side = this.strafeDir;
    return inp;
  }
}
