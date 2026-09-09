import { describe, expect, it } from 'vitest';
import { LINEAR_CEILING, measureGrowth } from './support/growth';

/**
 * The instrument the performance tests are built on.
 *
 * Two of those tests were wrong before this existed — a wall-clock bound that failed at 38
 * seconds on work taking 15ms, and a ratio measured at a size where the allocator rather than
 * the algorithm dominates. A measuring tool nothing measures is how that happens twice.
 */
describe('measureGrowth', () => {
  /** Deliberately quadratic: for each character, scan the whole string. */
  const quadratic = (s: string): number => {
    let n = 0;
    for (let i = 0; i < s.length; i++) if (s.indexOf('\u0000', i) === -1) n++;
    return n;
  };

  /** Deliberately linear. */
  const linear = (s: string): number => {
    let n = 0;
    for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 60) n++;
    return n;
  };

  const build = (units: number) => (m: number, salt: string) => salt + '<'.repeat(units * m);

  it('separates quadratic work from linear work', () => {
    // The whole point: the two must land on opposite sides of LINEAR_CEILING, or the tests
    // built on this are measuring nothing. Linear is about 4 and quadratic about 16.
    const slow = measureGrowth(build(20_000), quadratic, { bailAboveMs: 60_000 });
    const fast = measureGrowth(build(200_000), linear);

    expect(fast.ratio, `linear measured ${fast.ratio.toFixed(1)}`).toBeLessThan(LINEAR_CEILING);
    expect(slow.ratio, `quadratic measured ${slow.ratio.toFixed(1)}`).toBeGreaterThan(
      LINEAR_CEILING,
    );
  }, 120_000);

  it('bails on the small case rather than running the 4x one', () => {
    // The bail exists so a regression fails in seconds rather than minutes: the large case
    // would take roughly sixteen times as long to say what the small one already said. It is
    // checked after EVERY run, not once at the end, because a run over the line cannot come
    // back under it.
    let largestSeen = 0;
    let runs = 0;
    const work = (s: string): void => {
      runs++;
      largestSeen = Math.max(largestSeen, s.length);
      const until = performance.now() + 30;
      while (performance.now() < until) {
        /* burn */
      }
    };

    expect(() => measureGrowth(build(10), work, { bailAboveMs: 10 })).toThrow(
      /the small input alone took/,
    );
    // The 4x input was never built, so the largest string it saw is the small one.
    expect(largestSeen).toBeLessThan(build(10)(4, '').length);
    // And it stopped after the FIRST run rather than completing all five. Checking the bail
    // only at the end still throws, so the outer assertion above cannot tell the two apart —
    // this is the one that holds the early return, and the early return is the whole reason a
    // regression now fails in seconds instead of a minute.
    expect(runs).toBe(1);
  }, 60_000);

  it('gives each measurement a distinct input, so a memo cannot answer for the work', () => {
    // Several of the functions under test memoize per string. Handing the same one back would
    // measure the cache.
    const seen: string[] = [];
    measureGrowth(build(4), (s) => seen.push(s));
    expect(new Set(seen).size).toBe(seen.length);
  });
});

/**
 * The retry, and the two things that make it a fix rather than a loosening.
 *
 * The pair is measured up to three times and the LOWEST ratio wins, because the per-run
 * minimum inside each half does not defend the ratio BETWEEN them: the 4x case runs about ten
 * times longer, so on a busy machine it is far likelier that all five of its runs are
 * interrupted while one of the small case's slips through clean, and that bias only ever
 * inflates the ratio. The extraction suite failed at 9.46 against a ceiling of 8 that way, on
 * a commit that measured 666ms idle.
 *
 * A retry that could rescue genuinely quadratic work would be worse than the flake it fixes,
 * so that is the first thing asserted here. The second is that honest work does not pay for
 * it.
 */
describe('measuring the pair more than once', () => {
  const quadratic = (s: string): number => {
    let n = 0;
    for (let i = 0; i < s.length; i++) for (let j = 0; j < s.length; j++) if (i === j) n++;
    return n;
  };
  const linear = (s: string): number => {
    let n = 0;
    for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 60) n++;
    return n;
  };
  const build = (units: number) => (m: number, salt: string) => salt + '<'.repeat(units * m);

  it('cannot bring quadratic work under the ceiling, however many attempts it gets', () => {
    // The whole safety of the retry. Quadratic is about 16 on EVERY attempt, so taking the
    // best of several changes nothing about the verdict — it only costs wall clock, which is
    // why the input here is smaller than the one above: this test pays for the extra attempts
    // and has nothing to prove by being slow.
    const slow = measureGrowth(build(5_000), quadratic, { bailAboveMs: 60_000, attempts: 4 });
    expect(slow.ratio, `quadratic measured ${slow.ratio.toFixed(1)}`).toBeGreaterThan(
      LINEAR_CEILING,
    );
  }, 120_000);

  it('stops at the first attempt when the work is honestly linear', () => {
    // The case that runs on every commit must not pay three times over for a defence against
    // a machine that is not busy.
    let calls = 0;
    const counted = (s: string): number => {
      calls++;
      return linear(s);
    };
    measureGrowth(build(200_000), counted, { attempts: 3 });
    // Five runs for the small input and five for the large: one attempt, not three.
    expect(calls).toBe(10);
  }, 60_000);
});
