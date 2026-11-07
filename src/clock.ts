/** Time as the process code sees it, so tests can drive the 5 s, 2 s, 1 s and 60 s timings without waiting. */
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Run `fn` once after `ms`. The returned function cancels it; cancelling after it ran does nothing. */
  after(ms: number, fn: () => void): () => void;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  after: (ms, fn) => {
    const handle = setTimeout(fn, ms);
    return () => clearTimeout(handle);
  },
};
