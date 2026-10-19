export type RateLimiterOptions = {
  qps: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class RateLimiter {
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private nextAllowedAt = 0;

  constructor(opts: RateLimiterOptions) {
    this.intervalMs = 1000 / opts.qps;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  async acquire(): Promise<void> {
    const current = this.now();
    const scheduled = Math.max(current, this.nextAllowedAt);
    this.nextAllowedAt = scheduled + this.intervalMs;
    const waitMs = scheduled - current;
    if (waitMs > 0) await this.sleep(waitMs);
  }
}
