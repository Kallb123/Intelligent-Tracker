export interface TickerOptions {
  /** One unit of work. Called again `intervalMs` after the previous call settled. */
  run: () => Promise<void>;
  intervalMs: number;
  /** Called with whatever `run` rejects with; the ticker carries on regardless. */
  onError: (error: unknown) => void;
}

export interface Ticker {
  /** Stops scheduling and resolves once any in-flight run has finished. */
  stop(): Promise<void>;
}

/**
 * A repeating job for the backend services (the worker's tick, the bot's delivery loop). Only
 * timers, so it has no dependencies and works anywhere.
 *
 * Runs `run` right away and then `intervalMs` after each run finishes (a `setTimeout` chain, not
 * `setInterval`), so runs never overlap however long one takes. Errors go to `onError` and never
 * break the chain.
 */
export function startTicker(options: TickerOptions): Ticker {
  const { run, intervalMs, onError } = options;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> = Promise.resolve();

  const tick = (): void => {
    timer = undefined;
    inFlight = (async () => {
      try {
        await run();
      } catch (error) {
        onError(error);
      }
      if (!stopped) timer = setTimeout(tick, intervalMs);
    })();
  };

  tick();

  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      await inFlight;
    },
  };
}
