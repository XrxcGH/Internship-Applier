/**
 * Measuring the SHAPE of a cost curve rather than a stopwatch reading.
 *
 * A test that asserts "this finished in under N milliseconds" is a test that fails on a busy
 * machine. One of these was written as a wall-clock bound with what looked like two orders of
 * magnitude of headroom, and it failed at 38 SECONDS on work that takes 15ms — the suite was
 * sharing twenty cores with a pile of other processes at the time. The bound was not too tight;
 * a wall clock was the wrong instrument.
 *
 * What these tests are really about is whether a cost grew with the SQUARE of the input, and
 * that is a ratio. Quadruple the input: linear work takes about 4 times as long, quadratic work
 * about 16. A machine under load slows both measurements by the same factor, so the ratio
 * survives what the stopwatch cannot.
 */

export interface Growth {
  small: number;
  large: number;
  /** How much longer the 4x input took. About 4 if linear, about 16 if quadratic. */
  ratio: number;
}

/**
 * Runs `work` on a small input and on one four times the size, and reports the ratio.
 *
 * `sizeOf` is given a multiplier and returns the input to use. Each measurement gets a DISTINCT
 * input, because the code under test memoizes per string and handing it the same one twice
 * would measure the cache instead of the work.
 *
 * `bailAboveMs` bounds how long a failure takes: if the small case is already slower than this,
 * the large one would take sixteen times as long to tell us what we already know, so it is not
 * run. Without it, a regression turns a fast test into a five-minute one.
 */
export function measureGrowth<T>(
  build: (multiplier: number, salt: string) => T,
  work: (input: T) => unknown,
  opts: { bailAboveMs?: number; attempts?: number; acceptBelow?: number } = {},
): Growth {
  const bailAboveMs = opts.bailAboveMs ?? 2000;
  const attempts = opts.attempts ?? 3;
  const acceptBelow = opts.acceptBelow ?? LINEAR_CEILING;

  /**
   * THE MINIMUM IS TAKEN OVER THE PAIR, NOT ONLY OVER EACH HALF OF IT.
   *
   * "A machine under load slows both measurements by the same factor" is the assumption this
   * whole file rests on, and it is only true when both halves have the same chance of catching
   * a quiet moment. They do not. The 4x case takes roughly ten times as long per run, so on a
   * busy machine it is far likelier that ALL FIVE of its runs are interrupted while one of the
   * small case's five slips through clean — and the bias runs one way only, always inflating
   * the ratio. That is not hypothetical: this test failed at 9.46 against a ceiling of 8
   * (75.7ms -> 716.5ms) during a run that had a hundred other processes on the machine, and
   * passed at 666ms on the same commit with the machine idle.
   *
   * So the pair is measured again, up to `attempts` times, and the LOWEST ratio wins — the same
   * argument the per-run minimum already makes, one level up: contention only ever adds time,
   * so the smallest ratio observed is the one closest to the truth.
   *
   * This cannot rescue a genuine regression. Quadratic work reports about 16 on every attempt,
   * so no number of tries brings it under the ceiling; it costs a real failure `attempts` times
   * the wall clock and nothing else. The early exit means an honest linear result still pays
   * for exactly one attempt, which is the case that runs on every commit.
   */
  let best: Growth | null = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const measured = measureOnce();
    if (best === null || measured.ratio < best.ratio) best = measured;
    if (best.ratio < acceptBelow) return best;
  }
  return best!;

  function measureOnce(): Growth {
    /**
     * The FASTEST of several runs, not the median.
     *
     * Descheduling only ever adds time, so the minimum is the run that came closest to having the
     * machine to itself and is the best estimate of what the work actually costs. A median still
     * carries whatever contention was going on for half the runs, and with a base measurement of
     * a few milliseconds one interrupted run is enough to move a ratio past any threshold — which
     * is exactly how the median version of this failed in a full-suite run while passing alone.
     *
     * There is no separate warm-up run, for the same reason: taking the minimum already discards
     * the first measurement, which is the one paying for JIT compilation. A warm-up would only be
     * a sixth run of the same work — and on the failure path, a sixth run of work already known
     * to be far too slow.
     */
    const fastest = (multiplier: number): number => {
      let best = Infinity;
      for (let i = 0; i < 5; i++) {
        const input = build(multiplier, `run${String(i)}`);
        const started = performance.now();
        work(input);
        best = Math.min(best, performance.now() - started);
        // Checked after EVERY run, not once at the end. The bail exists to make a regression
        // fail fast, and checking it only after all five made it five times slower than it
        // needed to be: measured with the clamps reverted, this test took 62 seconds to report
        // a failure the first run already knew about. A run that is over the line cannot come
        // back under it — `best` only ever falls — so there is nothing to wait for.
        if (best > bailAboveMs) return best;
      }
      return best;
    };

    const small = fastest(1);
    if (small > bailAboveMs) {
      throw new Error(
        `the small input alone took ${small.toFixed(0)}ms, which is already far past anything ` +
          'this work should cost; the 4x case was not run because it would only take longer to ' +
          'say the same thing',
      );
    }

    const large = fastest(4);
    // A floor on the denominator: at sub-millisecond timings the ratio is measuring the clock,
    // not the work. Callers pick sizes that put `small` in the tens of milliseconds, so this is
    // a backstop rather than something normally in play.
    return { small, large, ratio: large / Math.max(small, 1) };
  }
}

/**
 * The ratio a linear cost is allowed to reach before it counts as super-linear.
 *
 * Linear is about 4 and quadratic about 16, so 8 sits halfway in log space — double the
 * headroom over honest linear work, and a clear half of the distance to the bug.
 */
export const LINEAR_CEILING = 8;
