/** Single cancellable packet animation lifetime for the replay stage.
 * One owner: start() replaces any in-flight run, cancel() makes every
 * queued callback inert, and hidden/reduced-motion cancel immediately. */
export interface PacketAnimatorDeps {
  request: (fn: (now: number) => void) => number;
  cancel: (handle: number) => void;
  now?: () => number;
  durationMs?: number;
  isHidden?: () => boolean;
  prefersReducedMotion?: () => boolean;
  onProgress: (t: number) => void;
  onDone?: () => void;
}
export class StagePacketAnimator {
  private handle: number | null = null;
  private generation = 0;
  private running = false;
  constructor(private deps: PacketAnimatorDeps) {}
  get active(): boolean { return this.running; }
  get gen(): number { return this.generation; }
  cancel(): void {
    this.generation++;
    this.running = false;
    if (this.handle !== null) { try { this.deps.cancel(this.handle); } catch { /* inert */ } this.handle = null; }
    this.deps.onProgress(-1); // sentinel: hide packet
  }
  start(): void {
    this.cancel();
    if (this.deps.isHidden?.() || this.deps.prefersReducedMotion?.()) return;
    const gen = this.generation;
    const duration = this.deps.durationMs ?? 650;
    const started = this.deps.now ? this.deps.now() : 0;
    this.running = true;
    const tick = (now: number) => {
      if (gen !== this.generation || !this.running) return;
      if (this.deps.isHidden?.()) { this.cancel(); return; }
      const t = duration > 0 ? Math.min(1, Math.max(0, (now - started) / duration)) : 1;
      this.deps.onProgress(t);
      if (t < 1) this.handle = this.deps.request(tick);
      else { this.handle = null; this.running = false; this.deps.onDone?.(); }
    };
    this.handle = this.deps.request(tick);
  }
  handleHidden(): void { if (this.deps.isHidden?.()) this.cancel(); }
  handleReducedMotion(matches: boolean): void { if (matches) this.cancel(); }
  dispose(): void { this.cancel(); }
}
