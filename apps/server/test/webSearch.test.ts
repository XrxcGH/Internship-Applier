import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tier B: the model finds candidate URLs, and this process decides what becomes a posting.
 *
 * The properties held here are the sourcing policy itself. The model's word is never stored —
 * every posting comes out of `fetchManualPosting`, the robots-respecting reader — and the
 * boards whose terms refuse automated reads are dropped even when the model returns them
 * anyway. The model and the fetcher are both mocked because neither is what is under test:
 * what is under test is the adapter's refusals, its counts, and its honesty when either
 * dependency misbehaves.
 */

const h = vi.hoisted(() => ({
  answer: null as unknown,
  generateError: null as Error | null,
  generateCalls: [] as Array<Record<string, unknown>>,
  fetched: [] as string[],
  /** URLs whose fetch should throw, mapped to the message. */
  refuse: new Map<string, string>(),
}));

vi.mock('../src/infra/llm', async (importOriginal) => {
  // The real module, so NoModelAccessError stays the class the adapter's instanceof sees.
  const real = await importOriginal<object>();
  return {
    ...real,
    modelAccessLikely: vi.fn(() => true),
    generate: vi.fn(async (req: Record<string, unknown>) => {
      h.generateCalls.push(req);
      if (h.generateError) throw h.generateError;
      return { text: '', structured: h.answer, stopReason: 'end_turn', provider: 'claude_cli' };
    }),
  };
});

vi.mock('../src/core/discovery/manualPosting', () => ({
  fetchManualPosting: vi.fn(async (url: string) => {
    h.fetched.push(url);
    const refusal = h.refuse.get(url);
    if (refusal) throw new Error(refusal);
    return {
      posting: {
        externalId: null,
        canonicalUrl: url,
        applyUrl: url,
        company: 'Acme',
        companyDomain: null,
        title: 'Software Engineering Intern',
        descriptionHtml: null,
        descriptionText: 'Build things.',
        locations: [],
        positionType: 'internship',
        workArrangement: null,
        hybridDaysOnsite: null,
        remoteEligibleIn: [],
        programFlags: [],
        term: { season: null, year: null },
        compensation: null,
        requires: {},
        postedAt: null,
        closesAt: null,
        atsVendor: 'unknown',
      },
      usedJsonLd: true,
      namedByJsonLd: { title: true, company: true },
      notes: [],
    };
  }),
}));

const { isAggregatorUrl, isFurnitureTitle, isHostFragment, siftCandidates, webSearch } =
  await import('../src/core/discovery/sources/webSearch');
const { NoModelAccessError } = await import('../src/infra/llm');

function found(urls: string[]): unknown {
  return {
    results: urls.map((url, i) => ({ url, title: `Role ${i + 1}`, company: `Company ${i + 1}` })),
  };
}

beforeEach(() => {
  h.answer = found(['https://boards.greenhouse.io/acme/jobs/1']);
  h.generateError = null;
  h.generateCalls = [];
  h.fetched = [];
  h.refuse = new Map();
});

describe('isAggregatorUrl', () => {
  it('recognises the boards whose terms refuse automated reads, at any depth', () => {
    for (const url of [
      'https://www.linkedin.com/jobs/view/123',
      'https://indeed.com/viewjob?jk=abc',
      'https://de.indeed.com/viewjob?jk=abc',
      'https://app.joinhandshake.com/jobs/456',
      'https://www.glassdoor.com/job-listing/x',
    ]) {
      expect(isAggregatorUrl(url), url).toBe(true);
    }
  });

  it('recognises them on their country domains too, which the .com list did not', () => {
    // Every entry used to be a .com host matched by equality or dot-suffix, so these were
    // not dropped — they were FETCHED, and a robots.txt refusal then landed in the count of
    // pages that could not be read rather than in the policy-refusal count the sift keeps
    // separate on purpose.
    for (const url of [
      'https://www.glassdoor.co.uk/job-listing/x',
      'https://www.monster.de/jobs/1',
      'https://linkedin.cn/jobs/view/1',
      'https://au.indeed.com.au/viewjob?jk=x',
      'https://uk.talent.com/view?id=1',
    ]) {
      expect(isAggregatorUrl(url), url).toBe(true);
    }
  });

  it('does not read a company that merely contains the word', () => {
    // The registrable brand, not a substring and not any label: monster.com is refused,
    // monsterenergy.com and notlinkedin.example are somebody's own sites.
    expect(isAggregatorUrl('https://careers.monsterenergy.com/jobs/1')).toBe(false);
    expect(isAggregatorUrl('https://notlinkedin.example/jobs/1')).toBe(false);
    expect(isAggregatorUrl('https://boards.greenhouse.io/acme/jobs/1')).toBe(false);
  });

  it('does not drop an employer whose SUBDOMAIN happens to be a brand on the list', () => {
    // The trap in matching any label: "talent" is on the list, and talent.acme.com is an
    // ordinary careers subdomain. Dropping it would lose the employer's own page and report
    // the loss to the student as a policy refusal — a false statement about somebody's terms.
    expect(isAggregatorUrl('https://talent.acme.com/jobs/1')).toBe(false);
    expect(isAggregatorUrl('https://indeed.acme.com/careers')).toBe(false);
  });
});

describe('siftCandidates', () => {
  it('drops aggregators, junk and repeats, and counts each by reason', () => {
    // Each reason is reported differently — a policy refusal gets its own sentence, noise
    // rides in the headline — and lumping them together would hide the one that matters.
    const sift = siftCandidates(
      [
        { url: 'https://boards.greenhouse.io/acme/jobs/1' },
        { url: 'https://www.linkedin.com/jobs/view/9' },
        { url: 'not a url' },
        { url: 'https://boards.greenhouse.io/acme/jobs/1?utm_source=x' },
        { url: 'https://jobs.lever.co/beta/2' },
      ],
      10,
    );
    expect(sift.candidates.map((c) => c.url)).toEqual([
      'https://boards.greenhouse.io/acme/jobs/1',
      'https://jobs.lever.co/beta/2',
    ]);
    expect(sift.aggregators).toBe(1);
    expect(sift.malformed).toBe(1);
    // The utm-tagged copy canonicalizes onto the first URL, which is how search results
    // ordinarily repeat themselves.
    expect(sift.duplicates).toBe(1);
    expect(sift.overCap).toBe(0);
  });

  it('counts what falls past the cap rather than hiding it', () => {
    const urls = Array.from({ length: 8 }, (_, i) => ({
      url: `https://boards.greenhouse.io/c${i}/jobs/1`,
    }));
    const sift = siftCandidates(urls, 5);
    expect(sift.candidates.map((c) => c.url)).toHaveLength(5);
    expect(sift.overCap).toBe(3);
  });

  it('refuses non-http schemes outright', () => {
    const sift = siftCandidates(
      [{ url: 'ftp://example.com/x' }, { url: 'javascript:alert(1)' }],
      5,
    );
    expect(sift.candidates.map((c) => c.url)).toEqual([]);
    expect(sift.malformed).toBe(2);
  });
});

describe('the web_search adapter', () => {
  it('stores what the PAGES say, fetched by this process — never the model’s word', async () => {
    h.answer = found(['https://boards.greenhouse.io/acme/jobs/1', 'https://jobs.lever.co/beta/2']);
    const result = await webSearch.fetch({ keywords: ['robotics intern'], location: 'Boston' });

    expect(result.postings).toHaveLength(2);
    // Every posting came through the mocked fetchManualPosting, which is the robots path.
    expect(h.fetched).toEqual([
      'https://boards.greenhouse.io/acme/jobs/1',
      'https://jobs.lever.co/beta/2',
    ]);
    // And the model was actually asked to search.
    expect(h.generateCalls[0]).toMatchObject({ purpose: 'web_discovery', webSearch: true });
  });

  it('drops an aggregator link the model returned anyway, and says so', async () => {
    h.answer = found([
      'https://www.linkedin.com/jobs/view/9',
      'https://boards.greenhouse.io/acme/jobs/1',
    ]);
    const result = await webSearch.fetch({});

    expect(h.fetched).toEqual(['https://boards.greenhouse.io/acme/jobs/1']);
    expect(result.notes.join(' ')).toMatch(/dropped 1 aggregator link/i);
  });

  it('reports pages it could not read as a gap, and keeps the ones it could', async () => {
    h.answer = found([
      'https://boards.greenhouse.io/acme/jobs/1',
      'https://careers.blocked.example/jobs/2',
    ]);
    h.refuse.set('https://careers.blocked.example/jobs/2', 'robots.txt disallows /jobs/2');
    const result = await webSearch.fetch({});

    expect(result.postings).toHaveLength(1);
    expect(result.gaps?.join(' ')).toMatch(/1 of 2 pages/);
    expect(result.gaps?.join(' ')).toMatch(/robots\.txt disallows/);
  });

  it('answers missing model access with a gap, not a throw', async () => {
    // The web not being searched is coverage the user asked for and did not get. A quiet
    // zero would read as "the web had nothing".
    h.generateError = new NoModelAccessError('No ANTHROPIC_API_KEY is configured.');
    const result = await webSearch.fetch({});
    expect(result.postings).toEqual([]);
    expect(result.gaps?.join(' ')).toMatch(/no model access/i);
    expect(h.fetched).toEqual([]);
  });

  it('answers an unreadable model reply with a gap, not garbage', async () => {
    h.answer = { shrug: true };
    const result = await webSearch.fetch({});
    expect(result.postings).toEqual([]);
    expect(result.gaps?.join(' ')).toMatch(/could not be read/i);
  });

  it('says plainly when the search found nothing, without calling it a gap', async () => {
    // Nothing was truncated or refused; the web genuinely had no answer for this brief.
    h.answer = found([]);
    const result = await webSearch.fetch({ keywords: ['underwater basket weaving intern'] });
    expect(result.postings).toEqual([]);
    expect(result.gaps).toBeUndefined();
    expect(result.notes.join(' ')).toMatch(/found no open postings/i);
  });

  /**
   * Reported as a GAP, because a note sets neither `degraded` nor `skipped`.
   *
   * A run that named fourteen pages, read three and left eleven unfetched used to report
   * itself as complete: the summary said "web_search: 3 found" with a green tick, and the
   * sentence about the other eleven sat among the ordinary status lines. Coverage that was
   * not obtained belongs in `gaps` — which is where the Workday and SmartRecruiters
   * detail-page caps already put theirs.
   */
  it('honours the candidate cap and reports the remainder as a gap', async () => {
    h.answer = found(
      Array.from({ length: 14 }, (_, i) => `https://boards.greenhouse.io/c${i}/jobs/1`),
    );
    const result = await webSearch.fetch({ limit: 3 });
    expect(h.fetched).toHaveLength(3);
    expect(result.gaps?.join(' ')).toMatch(/left 11 unfetched/);
    // And not left in the status lines as well, or the run says it twice.
    expect(result.notes.join(' ')).not.toMatch(/left 11 unfetched/);
  });

  it('sends the brief it was given, and defaults to the product’s premise', async () => {
    await webSearch.fetch({ keywords: ['summer 2027 internship', 'robotics'] });
    expect(String(h.generateCalls[0]?.['user'])).toMatch(/summer 2027 internship, robotics/);

    h.generateCalls = [];
    await webSearch.fetch({});
    // "internship" is not an invented role; it is what the tool exists to find, and the
    // same default the keyed aggregators use.
    expect(String(h.generateCalls[0]?.['user'])).toMatch(/Roles and keywords: internship/);
  });
});

describe('naming a posting whose page states none', () => {
  it('keeps the search result’s name only when the page yields furniture', async () => {
    // The first live run stored "Untitled posting @ salesforce" and "Jobs @ ashbyhq" for
    // real Summer 2027 roles: JS-rendered pages hand the raw-HTML reader nothing, and the
    // real names sat unread in the search results the model had already returned. The page
    // stays the authority on every fact; this only fills a name the page did not state.
    const { fetchManualPosting } = await import('../src/core/discovery/manualPosting');
    vi.mocked(fetchManualPosting).mockResolvedValueOnce({
      posting: {
        canonicalUrl: 'https://acme.wd5.myworkdayjobs.com/ext/job/x',
        applyUrl: 'https://acme.wd5.myworkdayjobs.com/ext/job/x',
        company: 'acme',
        title: 'Untitled posting',
      } as never,
      usedJsonLd: false,
      namedByJsonLd: { title: false, company: false },
      notes: [],
    });
    h.answer = {
      results: [
        {
          url: 'https://acme.wd5.myworkdayjobs.com/ext/job/x',
          title: 'Summer 2027 Intern - Software Engineer',
          company: 'Acme Corporation',
        },
      ],
    };

    const result = await webSearch.fetch({});
    expect(result.postings[0]).toMatchObject({
      title: 'Summer 2027 Intern - Software Engineer',
      company: 'Acme Corporation',
    });
    expect(result.notes.join(' ')).toMatch(/kept the search result's own name/);
  });

  it('never overrides a page that names itself', async () => {
    // The default mock returns a real title and a company that is not a hostname fragment,
    // with usedJsonLd true — the model's flashier naming must lose to it.
    h.answer = {
      results: [
        {
          url: 'https://boards.greenhouse.io/acme/jobs/1',
          title: 'A Grander-Sounding Title',
          company: 'A Different Company',
        },
      ],
    };
    const result = await webSearch.fetch({});
    expect(result.postings[0]).toMatchObject({
      title: 'Software Engineering Intern',
      company: 'Acme',
    });
    expect(result.notes.join(' ')).not.toMatch(/kept the search result/);
  });
});

describe('the naming heuristics', () => {
  it('reads page furniture as furniture', () => {
    for (const t of ['Untitled posting', 'Jobs', 'Careers', 'Open Positions', 'x']) {
      expect(isFurnitureTitle(t), t).toBe(true);
    }
    for (const t of ['Software Engineering Intern', 'Robotics Intern (Summer 2027)']) {
      expect(isFurnitureTitle(t), t).toBe(false);
    }
  });

  it('reads a vendor hostname fragment as no company at all', () => {
    // "job-boards" and "ashbyhq" name the ATS, not the employer — and a fingerprint built
    // from them will not merge with the same posting found through the real adapter.
    expect(isHostFragment('job-boards', 'https://job-boards.greenhouse.io/spacex/jobs/1')).toBe(
      true,
    );
    expect(isHostFragment('ashbyhq', 'https://jobs.ashbyhq.com/skydio/1')).toBe(true);
    expect(isHostFragment('salesforce', 'https://salesforce.wd12.myworkdayjobs.com/x')).toBe(true);
    expect(isHostFragment('', 'https://example.com/x')).toBe(true);
    // A company the page genuinely stated survives, even when it happens to match nothing.
    expect(isHostFragment('Verne Robotics', 'https://jobs.ashbyhq.com/Verne%20Robotics/1')).toBe(
      false,
    );
  });
});

describe('the counts that used to vanish', () => {
  it('accounts for repeats and unreadable URLs in the headline', async () => {
    // The sift counted four reasons and the docstring promised a sentence for each; only two
    // ever appeared, so a run of mostly junk showed an unexplained gap between "named N" and
    // "M read cleanly" with nothing explaining where the rest went.
    h.answer = {
      results: [
        { url: 'https://boards.greenhouse.io/acme/jobs/1', title: 'A', company: 'A' },
        { url: 'https://boards.greenhouse.io/acme/jobs/1?utm_source=x', title: 'A', company: 'A' },
        { url: 'not a url', title: 'B', company: 'B' },
      ],
    };
    const result = await webSearch.fetch({});
    const headline = result.notes[0] ?? '';
    expect(headline).toMatch(/named 3 pages/);
    expect(headline).toMatch(/1 was a repeat/);
    expect(headline).toMatch(/1 had a URL that could not be read/);
    expect(headline).toMatch(/1 read cleanly/);
  });

  it('says nothing about noise when there was none', () => {
    // A parenthetical on every ordinary run is the warning fatigue the rest of this avoided.
    return webSearch.fetch({}).then((result) => {
      expect(result.notes[0]).not.toMatch(/repeat|could not be read/);
    });
  });
});

/**
 * Which half of the gap message a failure gets, which is the whole point of the reason.
 *
 * The setup half was covered; the other was not — and the other is the one the split exists
 * for. A 32-turn sweep that exceeded the CLI ceiling threw the same error class as "no CLI
 * installed", so a signed-in student with a working setup was told to go and set one up.
 */
describe('what the gap says when the web was not searched', () => {
  it('tells a student with no setup to set one up', async () => {
    h.generateError = new NoModelAccessError('No ANTHROPIC_API_KEY is configured.', 'no_key');
    const result = await webSearch.fetch({});
    expect(result.gaps?.join(' ')).toMatch(/no model access/i);
    expect(result.gaps?.join(' ')).toMatch(/Sign in to the Claude Code CLI/);
  });

  it('does NOT say that to a student whose working setup timed out', async () => {
    // The case that shipped wrong. Advice naming a cause that is not the cause, and an action
    // that changes nothing, on the channel this file keeps for admitting what it did not do.
    h.generateError = new NoModelAccessError(
      'The Claude CLI did not finish within 900s and was stopped.',
      'timed_out',
    );
    const result = await webSearch.fetch({});
    const gap = result.gaps?.join(' ') ?? '';
    expect(gap).not.toMatch(/Sign in to the Claude Code CLI/);
    expect(gap).toMatch(/the live web was not searched/);
    expect(gap).toMatch(/did not finish within 900s/);
  });

  it('passes the real cause through for every non-setup reason', async () => {
    for (const reason of ['usage_limit', 'cli_error', 'unreadable', 'timed_out'] as const) {
      h.generateError = new NoModelAccessError(`distinctive ${reason} text`, reason);
      const gap = (await webSearch.fetch({})).gaps?.join(' ') ?? '';
      expect(gap, reason).toContain(`distinctive ${reason} text`);
      expect(gap, reason).not.toMatch(/ANTHROPIC_API_KEY/);
    }
  });

  it('still reports it as a gap, not a note — the web was not searched', async () => {
    // Whichever half it takes, this is coverage the user asked for and did not get. A quiet
    // zero would read as "the web had nothing".
    h.generateError = new NoModelAccessError('anything', 'cli_error');
    const result = await webSearch.fetch({});
    expect(result.gaps?.length).toBeGreaterThan(0);
    expect(result.postings).toHaveLength(0);
  });
});
