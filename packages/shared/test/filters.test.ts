import { describe, expect, it } from 'vitest';
import { DEFAULT_FILTERS, SearchFilters, STARTER_PRESETS, upcomingCycleYear } from '../src/filters';

describe('filter defaults', () => {
  it('fills the whole tree from an empty object', () => {
    const f = SearchFilters.parse({});
    expect(f.term.seasons).toEqual(['summer']);
    expect(f.term.years).toEqual([2027]);
    expect(f.positionTypes).toEqual(['internship', 'co_op']);
    expect(f.location.countries).toEqual(['US']);
    expect(f.view.sortBy).toBe('fit');
  });

  it('parses every starter preset', () => {
    for (const p of STARTER_PRESETS) {
      expect(() => SearchFilters.parse(p.patch)).not.toThrow();
    }
  });

  /**
   * Rule 3 in filters.ts: a posting that doesn't state something is unknown, not
   * disqualified. If any of these ever default to false, the tool starts silently
   * hiding opportunities — the worst failure mode this app has.
   */
  it('never treats unstated information as disqualifying', () => {
    expect(DEFAULT_FILTERS.compensation.includeUndisclosed).toBe(true);
    expect(DEFAULT_FILTERS.eligibility.includeUnknownEligibility).toBe(true);
    expect(DEFAULT_FILTERS.arrangement.includeUnstatedArrangement).toBe(true);
    expect(DEFAULT_FILTERS.term.includeUndatedPostings).toBe(true);
  });

  it('leaves every narrowing list empty by default', () => {
    expect(DEFAULT_FILTERS.arrangement.allowed).toEqual([]);
    expect(DEFAULT_FILTERS.company.onlyCompanies).toEqual([]);
    expect(DEFAULT_FILTERS.company.sizes).toEqual([]);
    expect(DEFAULT_FILTERS.role.roleFamilies).toEqual([]);
    expect(DEFAULT_FILTERS.programFlags).toEqual([]);
  });

  it('treats season and year as ordinary values, not hardcoded', () => {
    const f = SearchFilters.parse({ term: { seasons: ['fall', 'spring'], years: [2028, 2029] } });
    expect(f.term.seasons).toEqual(['fall', 'spring']);
    expect(f.term.years).toEqual([2028, 2029]);
  });

  it('supports every position type and work arrangement', () => {
    const f = SearchFilters.parse({
      positionTypes: [
        'internship',
        'co_op',
        'fellowship',
        'apprenticeship',
        'research',
        'new_grad',
      ],
      arrangement: { allowed: ['onsite', 'hybrid', 'remote', 'remote_geo_restricted'] },
    });
    expect(f.positionTypes).toHaveLength(6);
    expect(f.arrangement.allowed).toHaveLength(4);
  });
});

/**
 * The default search cycle, read from the clock rather than written down.
 *
 * `years` defaulted to the literal `[2027]`, so every install searched summer 2027 for ever.
 * From 1 July 2027 that is a season already under way with its applications closed, and the
 * student got an empty queue with nothing on screen saying why — while docs/05 said "nothing
 * in the system hardcodes summer or 2027".
 *
 * The planner was taught to derive the cycle first, and that fix was unreachable on the
 * default path: the planner only falls back to the clock when the filters name NO year, and
 * these filters named one.
 */
describe('the term year nobody chose', () => {
  it('is the next cycle still worth applying to, at every point in the year', () => {
    // Before the term starts, the cycle is this year; from its first day, the next one. The
    // rollover is the term's start rather than when applications close, because rolling over
    // early searches a cycle nobody has posted for and finds nothing, while rolling over late
    // keeps the rolling and late postings a student in April can still get.
    expect(upcomingCycleYear('summer', new Date('2027-01-15T00:00:00Z'))).toBe(2027);
    expect(upcomingCycleYear('summer', new Date('2027-05-31T23:59:59Z'))).toBe(2027);
    expect(upcomingCycleYear('summer', new Date('2027-06-01T00:00:00Z'))).toBe(2028);
    expect(upcomingCycleYear('summer', new Date('2027-12-31T00:00:00Z'))).toBe(2028);
  });

  it('follows each season’s own calendar', () => {
    expect(upcomingCycleYear('fall', new Date('2027-08-01T00:00:00Z'))).toBe(2027);
    expect(upcomingCycleYear('fall', new Date('2027-09-01T00:00:00Z'))).toBe(2028);
    expect(upcomingCycleYear('spring', new Date('2027-01-01T00:00:00Z'))).toBe(2028);
  });

  it('gives a season with no window of its own the summer calendar', () => {
    // `year_round` and `flexible` name no term, so there is nothing to roll over — they
    // follow the cycle the product is built around rather than throwing or answering null.
    expect(upcomingCycleYear('year_round', new Date('2027-06-01T00:00:00Z'))).toBe(2028);
    expect(upcomingCycleYear('flexible', new Date('2027-01-01T00:00:00Z'))).toBe(2027);
  });

  it('is what an unspecified filter set actually parses to', () => {
    // The assertion that would have caught the original bug. Parsing `{}` must not produce a
    // year that was true when the module was written.
    const parsed = SearchFilters.parse({});
    expect(parsed.term.years).toEqual([upcomingCycleYear('summer')]);
  });
});
