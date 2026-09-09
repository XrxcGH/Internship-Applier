import { describe, expect, it } from 'vitest';
import { dedupe, fingerprint, titlesMatch } from '../src/core/discovery/dedupe';
import type { NormalizedPosting } from '../src/core/discovery/sources/types';

function posting(over: Partial<NormalizedPosting> = {}): NormalizedPosting {
  return {
    externalId: '1',
    canonicalUrl: 'https://example.com/jobs/1',
    applyUrl: 'https://example.com/jobs/1',
    company: 'Acme',
    companyDomain: null,
    title: 'Software Engineer Intern',
    descriptionText: 'desc',
    descriptionHtml: null,
    locations: [{ city: 'Boston', remote: false }],
    positionType: 'internship',
    workArrangement: 'onsite',
    hybridDaysOnsite: null,
    remoteEligibleIn: [],
    programFlags: [],
    term: { season: 'summer', year: 2027, durationWeeks: 12, multiTerm: false },
    compensation: null,
    requires: {},
    postedAt: null,
    closesAt: null,
    atsVendor: 'greenhouse',
    ...over,
  };
}

describe('fingerprint', () => {
  it('ignores requisition ids, casing and legal suffixes', () => {
    const a = fingerprint({
      company: 'Acme, Inc.',
      title: 'Software Engineer Intern',
      locations: [{ city: 'Boston' }],
    });
    const b = fingerprint({
      company: 'ACME LLC',
      title: 'Software Engineer Intern - Req #9931',
      locations: [{ city: 'boston' }],
    });
    expect(a).toBe(b);
  });

  /**
   * This used to assert that "(Summer 2027)" collapsed away too, which is the behaviour the
   * key must NOT have. Stage 2 merges on this alone, with no different-source guard, so a
   * Summer and a Fall requisition sharing a title would become one row and the user would
   * be shown whichever arrived first — possibly the one they are ineligible for, with the
   * one they could take never appearing at all.
   */
  it('keeps two requisitions apart when only the term distinguishes them', () => {
    const summer = fingerprint({
      company: 'Acme',
      title: 'Software Engineer Intern (Summer 2027)',
      locations: [{ city: 'Boston' }],
    });
    const fall = fingerprint({
      company: 'Acme',
      title: 'Software Engineer Intern (Fall 2027)',
      locations: [{ city: 'Boston' }],
    });
    expect(summer).not.toBe(fall);
  });

  it('keeps numbered levels of the same role apart', () => {
    const one = fingerprint({
      company: 'Acme',
      title: 'Machine Learning Intern I',
      locations: [{ city: 'Boston' }],
    });
    const two = fingerprint({
      company: 'Acme',
      title: 'Machine Learning Intern II',
      locations: [{ city: 'Boston' }],
    });
    expect(one).not.toBe(two);
  });
});

describe('titlesMatch', () => {
  it('matches inflection and suffix-noise variants of the same role', () => {
    expect(titlesMatch('Software Engineer Intern', 'Software Engineering Intern')).toBe(true);
    expect(titlesMatch('Software Engineer Intern', 'Software Engineer Intern - Summer 2027')).toBe(
      true,
    );
    expect(titlesMatch('Software Engineer Intern (Req #4021)', 'Software Engineer Intern II')).toBe(
      true,
    );
  });

  /**
   * These are exactly the cases character-similarity got wrong. A discriminating token
   * means a different requisition, and merging would hide one of them from the user.
   * "Intern" vs "Intern, Backend" scored 0.758 on trigrams — higher than some pairs that
   * genuinely are the same job.
   */
  it('refuses to merge roles separated by a discriminating token', () => {
    expect(titlesMatch('Software Engineer Intern', 'Software Engineer Intern, Backend')).toBe(
      false,
    );
    expect(titlesMatch('Software Engineer Intern', 'Hardware Engineer Intern')).toBe(false);
    expect(titlesMatch('Frontend Engineer Intern', 'Backend Engineer Intern')).toBe(false);
    expect(titlesMatch('Product Manager Intern', 'Product Design Intern')).toBe(false);
    expect(titlesMatch('Data Science Intern', 'Data Scientist Intern')).toBe(false);
  });

  it('rejects unrelated roles', () => {
    expect(titlesMatch('Software Engineer Intern', 'Marketing Analyst')).toBe(false);
  });
});

describe('dedupe', () => {
  it('merges by canonical url and keeps both sources', () => {
    const { unique, duplicates } = dedupe([
      { posting: posting(), source: 'greenhouse:acme' },
      { posting: posting(), source: 'adzuna:us' },
    ]);
    expect(unique).toHaveLength(1);
    expect(duplicates).toBe(1);
    expect(unique[0]!.sources).toEqual(['greenhouse:acme', 'adzuna:us']);
  });

  /**
   * Named for what it checks. "(Summer 2027)" survives `fingerprintTitle` on purpose — the
   * test above pins that — so these two get different fingerprints and it is stage 3, the
   * cross-source title match, that merges them. Calling it a fingerprint merge left stage 2
   * with no coverage at all while reading as though it had some.
   */
  it('merges a near-duplicate title across two sources', () => {
    const { unique } = dedupe([
      { posting: posting({ canonicalUrl: 'https://a.com/1' }), source: 's1' },
      {
        posting: posting({
          canonicalUrl: 'https://b.com/2',
          title: 'Software Engineer Intern (Summer 2027)',
        }),
        source: 's2',
      },
    ]);
    expect(unique).toHaveLength(1);
    expect(unique[0]!.sources).toEqual(['s1', 's2']);
    expect(unique[0]!.mergedBy).toContain('title');
  });

  /**
   * Stage 2, which is the only stage that merges within a single source. One board hands
   * back the same requisition twice under two URLs — once bare, once with the req number
   * appended — and stage 1 cannot see it because the URLs differ while stage 3 refuses to
   * look, because both sightings came from the same source.
   */
  it('merges two urls from one source onto a single fingerprint', () => {
    const { unique, duplicates } = dedupe([
      { posting: posting({ canonicalUrl: 'https://acme.com/jobs/1' }), source: 'greenhouse:acme' },
      {
        posting: posting({
          canonicalUrl: 'https://acme.com/jobs/2',
          title: 'Software Engineer Intern - Req #9931',
        }),
        source: 'greenhouse:acme',
      },
    ]);
    // Both titles reduce to the same key, which is what makes this stage 2 and not stage 3.
    expect(fingerprint(posting())).toBe('acme|software engineer intern|boston');
    expect(fingerprint(posting({ title: 'Software Engineer Intern - Req #9931' }))).toBe(
      'acme|software engineer intern|boston',
    );

    expect(unique).toHaveLength(1);
    expect(duplicates).toBe(1);
    expect(unique[0]!.mergedBy).toContain('fingerprint');
  });

  /**
   * Stage 3's reason for existing: one job, two boards, two spellings of the title. The
   * aggregator carries no location at all, which is the ordinary shape — it contradicts
   * nothing, so it still merges.
   */
  it('catches near-duplicate titles across different sources', () => {
    const { unique } = dedupe([
      { posting: posting({ canonicalUrl: 'https://a.com/1' }), source: 'greenhouse:acme' },
      {
        posting: posting({
          canonicalUrl: 'https://b.com/2',
          title: 'Software Engineering Intern',
          locations: [],
        }),
        source: 'adzuna:us',
      },
    ]);
    expect(unique).toHaveLength(1);
    expect(unique[0]!.mergedBy).toContain('title');
  });

  /**
   * The same title in two offices is two requisitions with two apply URLs, and this used to
   * be one row. Stage 3 ignored the city entirely, so the Boston sighting survived, the
   * Seattle one was discarded whole — its location, its URL, its apply link — and a student
   * in Seattle was shown the job in Boston instead of the one down the road. Stage 2 cannot
   * catch it: its key already holds the city, so these two never meet there.
   *
   * This test previously asserted the opposite, with Boston and Cambridge.
   */
  it('keeps the same role in two cities as two postings', () => {
    const { unique, duplicates } = dedupe([
      { posting: posting({ canonicalUrl: 'https://a.com/1' }), source: 'greenhouse:acme' },
      {
        posting: posting({
          canonicalUrl: 'https://b.com/2',
          applyUrl: 'https://b.com/2/apply',
          title: 'Software Engineering Intern',
          locations: [{ city: 'Seattle', region: 'WA', remote: false }],
        }),
        source: 'adzuna:us',
      },
    ]);
    expect(unique).toHaveLength(2);
    expect(duplicates).toBe(0);
    // Both apply URLs survive, which is the half of this the student actually clicks.
    expect(unique.map((u) => u.posting.applyUrl)).toEqual([
      'https://example.com/jobs/1',
      'https://b.com/2/apply',
    ]);
  });

  it('is not fooled by two cities that share a name on different continents', () => {
    // Cambridge, MA and Cambridge, GB are the same word and a visa apart. The city alone
    // matches, so only the country stops these merging into one row.
    const { unique } = dedupe([
      {
        posting: posting({
          canonicalUrl: 'https://a.com/1',
          locations: [{ city: 'Cambridge', region: 'MA', country: 'US', remote: false }],
        }),
        source: 'greenhouse:acme',
      },
      {
        posting: posting({
          canonicalUrl: 'https://b.com/2',
          title: 'Software Engineering Intern',
          locations: [{ city: 'Cambridge', country: 'GB', remote: false }],
        }),
        source: 'adzuna:uk',
      },
    ]);
    expect(unique).toHaveLength(2);
  });

  /**
   * The other direction, which the guard above must not break: one office, written two ways.
   * A board that states the region and an aggregator that gives the bare city are still the
   * same posting, and leaving them apart would be the duplicate stage 3 exists to remove.
   */
  it('still merges one office written with and without its region', () => {
    const { unique } = dedupe([
      {
        posting: posting({
          canonicalUrl: 'https://a.com/1',
          locations: [{ city: 'Boston', region: 'MA', remote: false }],
        }),
        source: 'greenhouse:acme',
      },
      {
        posting: posting({
          canonicalUrl: 'https://b.com/2',
          title: 'Software Engineering Intern',
          locations: [{ city: 'boston ', remote: false }],
        }),
        source: 'adzuna:us',
      },
    ]);
    expect(unique).toHaveLength(1);
    expect(unique[0]!.mergedBy).toContain('title');
  });

  /**
   * A merge must not throw away where the other source said the job is.
   *
   * The eligibility `location` rule fails a posting outright when every location it has is
   * remote and the user has remote turned off. The survivor here is a remote-only listing, so
   * keeping only its own locations turned a job with an office in the student's city into a
   * hard ineligible with no override.
   */
  it('keeps the city the other sighting named', () => {
    const { unique } = dedupe([
      {
        posting: posting({ canonicalUrl: 'https://a.com/1', locations: [{ remote: true }] }),
        source: 'greenhouse:acme',
      },
      {
        posting: posting({
          canonicalUrl: 'https://b.com/2',
          title: 'Software Engineering Intern',
          locations: [{ city: 'Boston', region: 'MA', remote: false }],
        }),
        source: 'adzuna:us',
      },
    ]);
    expect(unique).toHaveLength(1);
    expect(unique[0]!.posting.locations).toEqual([
      { remote: true },
      { city: 'Boston', region: 'MA', remote: false },
    ]);
    // Appended, never prepended: `fingerprint` keys on locations[0].city, and persistence
    // matches stored rows on that key across runs.
    expect(fingerprint(unique[0]!.posting)).toBe(fingerprint(posting({ locations: [] })));
  });

  it('does not stack a place both sightings named', () => {
    const { unique } = dedupe([
      { posting: posting({ canonicalUrl: 'https://a.com/1' }), source: 'greenhouse:acme' },
      {
        posting: posting({
          canonicalUrl: 'https://a.com/1',
          locations: [{ city: 'Boston', remote: false }],
        }),
        source: 'adzuna:us',
      },
    ]);
    expect(unique[0]!.posting.locations).toEqual([{ city: 'Boston', remote: false }]);
  });

  it('leaves the postings it was handed alone', () => {
    // These objects belong to the adapters that built them. Growing their `locations` in
    // place would leak one run's merges into the next sighting of the same object.
    const remote = posting({ canonicalUrl: 'https://a.com/1', locations: [{ remote: true }] });
    dedupe([
      { posting: remote, source: 'greenhouse:acme' },
      {
        posting: posting({
          canonicalUrl: 'https://b.com/2',
          title: 'Software Engineering Intern',
          locations: [{ city: 'Boston', remote: false }],
        }),
        source: 'adzuna:us',
      },
    ]);
    expect(remote.locations).toEqual([{ remote: true }]);
  });

  /**
   * Two similar titles from the SAME source are usually genuinely distinct requisitions
   * (a frontend and a backend intern posting, say). Merging them would silently hide one.
   */
  it('does not merge similar titles within a single source', () => {
    // Same city on purpose, so the only thing keeping these apart is the source guard. With
    // two different cities this passed whether that guard existed or not.
    const { unique } = dedupe([
      { posting: posting({ canonicalUrl: 'https://a.com/1' }), source: 'greenhouse:acme' },
      {
        posting: posting({
          canonicalUrl: 'https://a.com/2',
          title: 'Software Engineering Intern',
        }),
        source: 'greenhouse:acme',
      },
    ]);
    expect(unique).toHaveLength(2);
  });

  it('keeps genuinely different roles apart', () => {
    const { unique, duplicates } = dedupe([
      { posting: posting(), source: 's1' },
      {
        posting: posting({
          canonicalUrl: 'https://example.com/jobs/2',
          title: 'Marketing Intern',
        }),
        source: 's1',
      },
    ]);
    expect(unique).toHaveLength(2);
    expect(duplicates).toBe(0);
  });
});
