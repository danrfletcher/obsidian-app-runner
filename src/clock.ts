/** Time as the process code sees it, so tests can drive the 5 s, 2 s, 1 s and 60 s timings without waiting. */
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};
