// Own at most one prepared pair. Serialize replacements so rapid menu taps
// cannot create an unbounded queue of live GPU characters.
export class MatchLoader {
  constructor(dispose) { this.dispose = dispose; this.wanted = null; this.ready = null; this.running = null; this.error = null; }
  prepare(key, create) {
    if (this.wanted?.key === key && !this.error) return;
    this.wanted = { key, create };
    this.error = null;
    if (this.ready) { this.dispose(this.ready.value); this.ready = null; }
    if (!this.running) {
      this.running = this.run().finally(() => { this.running = null; });
      this.running.catch(() => {});
    }
  }
  async run() {
    while (this.wanted && !this.ready) {
      const job = this.wanted;
      let value;
      try { value = await job.create(); }
      catch (error) {
        if (job !== this.wanted) continue;
        this.error = error; return;
      }
      if (job !== this.wanted) this.dispose(value);
      else this.ready = { key: job.key, value };
    }
  }
  async take(key, create) {
    this.prepare(key, create);
    await this.running;
    if (this.error) throw this.error;
    if (this.ready?.key !== key) throw new Error('角色选择已改变，请重试');
    const value = this.ready.value;
    this.ready = null; this.wanted = null;
    return value;
  }
}
