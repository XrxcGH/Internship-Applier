/**
 * What the source adapters record about a posting's location.
 *
 * This exists because a wrong country is not a cosmetic error here. It reaches the
 * eligibility location rule, it reaches the queue where the user decides whether to apply,
 * and it reaches the privacy export as a fact the tool claims to know. Every parser in
 * this path is supposed to leave a field null rather than guess it; these tests hold that
 * line, because the guess was previously hardcoded in four separate places.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { adzuna, usajobs } from '../src/core/discovery/sources/aggregators';
import {
  ashby,
  ashbyPay,
  ATS_SOURCES,
  greenhouse,
  internshipShaped,
  lever,
  parseLocation,
  parseWorkdayBoard,
  smartrecruiters,
  workable,
  workday,
} from '../src/core/discovery/sources/ats';
import { decodeEntities, stripHtml } from '../src/core/discovery/sources/types';

/**
 * Routes every fetch to a canned JSON answer and records what was asked, so a test can
 * assert not just what an adapter returned but which requests it chose to spend. The
 * fetcher caches GET bodies by URL, so every test below uses a board token nothing else
 * uses — the same reason the Greenhouse test names its board 'ordering-fixture'.
 *
 * A route may answer with a `Response` of its own when the test is about a status rather
 * than a body. It has to be a 404 rather than a thrown error for anything the fetcher
 * retries: a thrown one is a network failure and costs five attempts with backoff.
 */
function stubFetch(route: (url: string, body: unknown) => unknown) {
  const real = globalThis.fetch;
  const calls: Array<{ url: string; body: unknown }> = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ url, body });
    const answer = route(url, body);
    if (answer instanceof Response) return answer;
    return new Response(JSON.stringify(answer), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = real;
    },
  };
}

describe('parseLocation', () => {
  it('reads city and region without inventing a country', () => {
    expect(parseLocation('New York, NY')).toMatchObject({
      city: 'New York',
      region: 'NY',
      remote: false,
    });
    expect(parseLocation('New York, NY').country).toBeUndefined();
  });

  /**
   * The case the old `'US'` default got wrong. Greenhouse and Lever boards are used by
   * companies all over the world, and a London posting stored as American is a posting the
   * location rule reasons about incorrectly.
   */
  it('does not stamp a non-US location as American', () => {
    expect(parseLocation('London, England').country).toBeUndefined();
    expect(parseLocation('Toronto, ON').country).toBeUndefined();
    expect(parseLocation('Berlin').country).toBeUndefined();
  });

  it('keeps a country the string actually names', () => {
    expect(parseLocation('Toronto, ON, Canada').country).toBe('Canada');
    expect(parseLocation('Austin, TX, US').country).toBe('US');
  });

  /**
   * The three-part branch returned the trailing part as the country verbatim, with no
   * name-check — so "New York, NY, Hybrid" and "Austin, TX, Onsite" (an arrangement or a metro
   * area in the third slot, at least as common on real boards as a spelled-out country) filed
   * "Hybrid" as the country and the privacy export claimed it as a fact. The last part goes
   * through the same name-check the two-part branch uses; when it is not a country, it is
   * dropped, not guessed.
   */
  it('does not read a third part that is not a country as one', () => {
    expect(parseLocation('New York, NY, Hybrid').country).toBeUndefined();
    expect(parseLocation('Austin, TX, Onsite').country).toBeUndefined();
    expect(parseLocation('Brooklyn, New York, NY').country).toBeUndefined();
    expect(parseLocation('New York, NY, Hybrid')).toMatchObject({ city: 'New York', region: 'NY' });
  });

  it('reads remote out of the string and drops the word from the parts', () => {
    const remote = parseLocation('Remote');
    expect(remote.remote).toBe(true);
    expect(remote.city).toBeUndefined();

    // "New York, NY or Remote" is one Greenhouse location string, and both halves matter:
    // the eligibility rule needs the city to tell "offers remote" from "remote only".
    const both = parseLocation('New York, NY or Remote');
    expect(both.remote).toBe(true);
    expect(both.city).toBe('New York');
  });

  /**
   * "OR" is Oregon. The remote-token cleanup trims a dangling conjunction, and trimming
   * both ends at once reduced the part "OR or Remote" to nothing — so a Portland posting
   * recorded a city in no state, and the location rule had nothing to compare against.
   */
  it('does not mistake Oregon for a conjunction', () => {
    expect(parseLocation('Portland, OR')).toMatchObject({ city: 'Portland', region: 'OR' });
    expect(parseLocation('Portland, OR or Remote')).toMatchObject({
      city: 'Portland',
      region: 'OR',
      remote: true,
    });
  });

  it('keeps the geography when a part also says remote', () => {
    expect(parseLocation('Remote (US)')).toMatchObject({ country: 'US', remote: true });
    expect(parseLocation('Berlin, Germany')).toMatchObject({ city: 'Berlin', country: 'Germany' });
  });

  it('trusts an explicit remote flag over the text', () => {
    expect(parseLocation('New York, NY', true).remote).toBe(true);
    expect(parseLocation('Remote', false).remote).toBe(false);
  });

  /**
   * The preposition the remote wording leaves holding a country.
   *
   * A live run over 2,941 postings stored forty of them as based in a town called "in USA",
   * "in Canada" or "in UK": stripRemoteToken took "Remote" out of "Remote in USA" and handed
   * back "in USA", which is not a country name, so the country the string actually stated was
   * discarded and the leftover was filed as the CITY. The same shape as the "Remote job" bug
   * one word further on, which is exactly why it survived that fix.
   */
  it('reads the country out of a remote string, rather than a town called "in USA"', () => {
    for (const [raw, country] of [
      ['Remote in USA', 'USA'],
      ['Remote in Canada', 'Canada'],
      ['Remote in UK', 'UK'],
      ['Remote within USA', 'USA'],
      ['Remote anywhere in Canada', 'Canada'],
      ['Remote based in Germany', 'Germany'],
    ] as const) {
      expect(parseLocation(raw), raw).toEqual({ country, remote: true });
    }
  });

  it('keeps the city when a preposition introduces a real one', () => {
    expect(parseLocation('Remote in Portland, OR')).toMatchObject({
      city: 'Portland',
      region: 'OR',
      remote: true,
    });
  });

  /**
   * The guard against the rule reaching too far. Independence, Indianapolis and Inglewood are
   * real towns that begin with the letters of a preposition, and the space is the only thing
   * standing between them and being trimmed down to "dependence", "dianapolis" and "glewood".
   */
  it('leaves a town alone whose name merely starts with a preposition', () => {
    expect(parseLocation('Remote or Independence, MO')).toMatchObject({ city: 'Independence' });
    expect(parseLocation('Indianapolis, IN')).toMatchObject({ city: 'Indianapolis', region: 'IN' });
    expect(parseLocation('Inglewood, CA')).toMatchObject({ city: 'Inglewood', region: 'CA' });
  });
});

/**
 * The note a keyed source leaves when it skips is the only place a user finds out why federal
 * internships, or half the aggregator coverage, were missing from a run. It used to tell them
 * to add the key "in Settings" — a screen with no key field and no mention of either source —
 * so the instruction sent them looking for a box that does not exist and there was no second
 * one to fall back on.
 */
describe('what an unconfigured keyed source tells the user', () => {
  const keys = ['ADZUNA_APP_ID', 'ADZUNA_APP_KEY', 'USAJOBS_API_KEY', 'USAJOBS_USER_AGENT'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));

  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('names the file the keys are read from, and no screen that cannot hold them', async () => {
    for (const k of keys) delete process.env[k];

    for (const source of [adzuna, usajobs]) {
      const result = await source.fetch({ board: '' });
      const note = result.notes.join(' ');
      expect(result.postings, source.kind).toEqual([]);
      expect(note, source.kind).toMatch(/\.env/);
      expect(note, source.kind).not.toMatch(/in Settings/i);
    }
  });
});

describe('reading a description out of a feed', () => {
  /**
   * What the two helpers do when they are composed in this order. It is a test of
   * `decodeEntities` and `stripHtml`, not of any adapter: the order is written here in the
   * test body, so nothing in `ats.ts` can break it and nothing here would notice if it did.
   * The adapter's own ordering is pinned below.
   */
  it('an escaped document decoded first has no markup left after stripping', () => {
    const escaped =
      '&lt;p&gt;About the role&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Python&lt;/li&gt;&lt;/ul&gt;';
    const text = stripHtml(decodeEntities(escaped));
    expect(text).not.toMatch(/<[a-z/]/i);
    expect(text).toMatch(/About the role/);
    expect(text).toMatch(/Python/);
  });

  /**
   * The Greenhouse adapter, driven end to end, because it is the adapter that gets this
   * wrong and the two helper tests could not see it.
   *
   * Greenhouse returns `content` HTML-escaped. Stripping the tags first finds none to strip
   * and `stripHtml`'s own decode step then puts the markup back as literal text — so every
   * requirement parser and the model read "<p>" and "<li>" as part of the job description,
   * and the queue rendered them on screen. Swapping the two calls in `ats.ts` restores that
   * bug with both composition tests above still green.
   */
  it('leaves no markup in the text a Greenhouse posting is stored with', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            jobs: [
              {
                id: 1,
                title: 'Software Engineer Intern',
                absolute_url: 'https://boards.greenhouse.io/ordering/jobs/1',
                content:
                  '&lt;p&gt;About the role&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Python&lt;/li&gt;&lt;/ul&gt;',
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )) as typeof globalThis.fetch;

    try {
      // A board token nothing else uses, because the fetcher caches response bodies by URL.
      const { postings } = await greenhouse.fetch({ board: 'ordering-fixture' });
      const text = postings[0]?.descriptionText ?? '';
      expect(text).not.toMatch(/<[a-z/]/i);
      expect(text).toMatch(/About the role/);
      expect(text).toMatch(/Python/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

/**
 * The pay Ashby states, which the adapter asks for and did not read for the whole of M2.
 *
 * No test covered any of this when it landed — it was checked once against the live board and
 * never pinned — and the rule it turns on is one the code itself calls worse than the regex if
 * it goes wrong: a bonus or an equity figure landing in `min` is a number the queue would sort
 * on and a student would decide against a posting with.
 */
describe('ashbyPay', () => {
  const job = (components: unknown[]) =>
    ({ compensation: { summaryComponents: components } }) as never;

  it('reads the salary band and the interval it is quoted at', () => {
    // Ramp's Android internship, verbatim from the live board: the case that exposed the
    // bug, where the text parser found an unrelated "$10,000 per year" further down the page.
    expect(
      ashbyPay(
        job([
          {
            compensationType: 'Salary',
            interval: '1 MONTH',
            currencyCode: 'USD',
            minValue: 11700,
            maxValue: 11700,
          },
        ]),
      ),
    ).toMatchObject({ min: 11700, period: 'month', currency: 'USD' });
  });

  it('does not print a range when both ends are the same figure', () => {
    // "$11,700–$11,700/mo" reads as a range somebody forgot to finish.
    const pay = ashbyPay(
      job([
        {
          compensationType: 'Salary',
          interval: '1 MONTH',
          currencyCode: 'USD',
          minValue: 11700,
          maxValue: 11700,
        },
      ]),
    );
    expect(pay).not.toHaveProperty('max');
  });

  it('keeps a real band', () => {
    expect(
      ashbyPay(
        job([
          {
            compensationType: 'Salary',
            interval: '1 YEAR',
            currencyCode: 'USD',
            minValue: 211400,
            maxValue: 290600,
          },
        ]),
      ),
    ).toMatchObject({ min: 211400, max: 290600, period: 'year' });
  });

  it('never reads equity, bonus or commission as pay', () => {
    // Every one of these is a real number answering a different question. The live board
    // returns all four types alongside Salary.
    for (const type of ['EquityPercentage', 'EquityCashValue', 'Commission', 'Bonus']) {
      expect(
        ashbyPay(
          job([
            { compensationType: type, interval: '1 YEAR', currencyCode: 'USD', minValue: 50000 },
          ]),
        ),
        type,
      ).toBeNull();
    }
  });

  it('picks the salary out of a list that leads with equity', () => {
    expect(
      ashbyPay(
        job([
          { compensationType: 'EquityPercentage', interval: 'NONE', minValue: null },
          {
            compensationType: 'Salary',
            interval: '1 YEAR',
            currencyCode: 'GBP',
            minValue: 60000,
            maxValue: 70000,
          },
        ]),
      ),
    ).toMatchObject({ min: 60000, currency: 'GBP', period: 'year' });
  });

  it('says nothing rather than guessing when the interval is one it cannot map', () => {
    // "NONE" is what the live board sends for a component with no period. A figure with no
    // period would be shown against the wrong one, which is worse than showing none.
    expect(
      ashbyPay(
        job([
          { compensationType: 'Salary', interval: 'NONE', currencyCode: 'USD', minValue: 5000 },
        ]),
      ),
    ).toBeNull();
  });

  it('says nothing when there is no compensation block at all', () => {
    expect(ashbyPay({} as never)).toBeNull();
    expect(ashbyPay({ compensation: {} } as never)).toBeNull();
    expect(ashbyPay({ compensation: { summaryComponents: 'nope' } } as never)).toBeNull();
  });
});

/**
 * The registry is what run.ts spreads into its dispatch map and what the planner's
 * AtsSourceName union is derived from, so a new adapter registered under the wrong key
 * would be reachable by a name that contradicts its own kind.
 */
describe('ATS_SOURCES', () => {
  it('registers every adapter under its own kind', () => {
    for (const [name, source] of Object.entries(ATS_SOURCES)) {
      expect({ name, kind: source.kind }).toEqual({ name, kind: name });
    }
    expect(Object.keys(ATS_SOURCES)).toEqual(
      expect.arrayContaining(['workday', 'smartrecruiters', 'workable']),
    );
  });
});

describe('workday', () => {
  it('parses the tenant@wdHost/site board address strictly', () => {
    expect(parseWorkdayBoard('nvidia@wd5/NVIDIAExternalCareerSite')).toEqual({
      tenant: 'nvidia',
      host: 'wd5',
      site: 'NVIDIAExternalCareerSite',
    });
    // Tenant and host are DNS labels; the site is a path segment whose case must survive.
    expect(parseWorkdayBoard('ACME@WD1/External')?.tenant).toBe('acme');
    expect(parseWorkdayBoard('ACME@WD1/External')?.site).toBe('External');

    for (const bad of ['nvidia', 'nvidia/wd5@Site', 'https://nvidia.wd5.myworkdayjobs.com', '']) {
      expect(parseWorkdayBoard(bad), bad).toBeNull();
    }
  });

  it('reports a missing or malformed board as a gap and fetches nothing', async () => {
    const stub = stubFetch(() => ({}));
    try {
      const none = await workday.fetch({ board: '' });
      expect(none.postings).toEqual([]);
      expect(none.gaps?.join(' ')).toMatch(/never asked/);

      const malformed = await workday.fetch({ board: 'linkedin.com/jobs' });
      expect(malformed.postings).toEqual([]);
      // The gap is where the user learns the encoding, so it has to teach it.
      expect(malformed.gaps?.join(' ')).toMatch(/tenant@wdHost\/site/);
      expect(stub.calls).toHaveLength(0);
    } finally {
      stub.restore();
    }
  });
});

/**
 * The one definition of "internship shaped", which both source files now read.
 *
 * It was English-only while its sibling in aggregators.ts was German-aware, so the repo held
 * a correct and an incorrect answer to the same question at once, and the incorrect one was
 * the one gating detail fetches on SmartRecruiters — a Europe-heavy board where `?q=Praktikum`
 * alone answers 202 matches. Every title below is one a real board publishes. The false side
 * matters exactly as much: "Internal Audit Manager" is not an internship, and neither is a
 * theatre "Stage Manager".
 */
describe('internshipShaped', () => {
  const KEEP = [
    // English.
    'Software Engineering Intern',
    'Internship in Product Engineering',
    '2027 Co-op, Hardware',
    'Working Student Data Science',
    'PhD Intern, Generative AI',
    'University Recruiting Program',
    'Apprentice Technician',
    // German. The compound is the form a German student most needs, and `\bpraktik` could
    // not see it; `\bstudent\b` could not see itself inside "Werkstudent".
    'Praktikum',
    'Praktikant (m/w/d) Softwareentwicklung',
    'Pflichtpraktikum im Einkauf mit Schwerpunkt Lagerwirtschaft',
    'Praktikum - Indirekter Einkauf (w/m/div.) ab Februar 2027',
    'Auslandspraktika',
    'Werkstudent (m/w/d) Data Science',
    'Werkstudent*in IT-Automatisierung',
    'Praxissemester Elektrotechnik',
    // French and Dutch.
    'Stagiaire Ingenieur, Developpement Software',
    'Stagiair Marketing',
    'Stage - Ingenieur Logiciel',
    'Stage HSE H/F/N',
    'Stage 6 mois - Data',
    'Developpeur Web (Stage)',
    'Ingenieur Logiciel - Stage',
    'Alternance - Data Analyst',
    // Spanish, Portuguese, Italian.
    'Practicas en Mejora Continua y Operaciones',
    'Prácticas en Departamento de Compras Mecanizado',
    'Estudiante en prácticas - Departamento de Logística',
    'Becario de Recursos Humanos',
    'Pasante de Logística',
    'Tirocinio Curriculare',
    'Estágio em Engenharia',
  ];

  const DROP = [
    'Senior Staff Engineer',
    // The word boundary on "intern", in both of the shapes that break it.
    'Internal Audit Manager',
    'International Sales Lead',
    // "Stage" is an ordinary English noun as well as the French and Dutch word for an
    // internship, and these are the three English shapes it takes.
    'Stage Manager',
    'Stage Technicians',
    'Early Stage Sales Lead',
    'Late-Stage Clinical Program Director',
    'Head of Stage Operations',
    // Near misses of the stems: none of these is a student position.
    'Practical Nurse',
    'Praktische Umsetzung von Marketingstrategien',
    /**
     * The full-time roles a "Summer Analyst" programme feeds into. The season is what makes
     * the title a student post, and without it these are the careers themselves — matching
     * them would fill the queue with jobs no student can hold, which is the overcorrection
     * that pays for the coverage below.
     */
    'Analyst',
    'Associate',
    'Senior Analyst',
    'Data Analyst',
    'Business Associate',
    'Associate Director',
    // A summer job, but not one of these programmes, and no other word here catches it.
    'Summer Camp Counselor',
  ];

  /**
   * What finance, consulting and law call theirs. Neither word appears anywhere else in
   * INTERNSHIP_TITLE, so a real run dropped every one of these and said in its own note that
   * they were "not internships" — a posting lost silently, under a sentence asserting the
   * opposite.
   */
  const SEASONAL_PROGRAMMES = [
    'Summer Analyst',
    'Summer Analyst Program 2027',
    'Summer Associate',
    '2027 Summer Analyst - Investment Banking',
    'Spring Fellow',
    'Summer Scholar',
  ];

  it('reads the seasonal programme names finance and law use', () => {
    for (const title of SEASONAL_PROGRAMMES)
      expect({ title, shaped: internshipShaped(title) }).toEqual({ title, shaped: true });
  });

  it('reads an internship title in the languages these boards are written in', () => {
    for (const title of KEEP)
      expect({ title, shaped: internshipShaped(title) }).toEqual({
        title,
        shaped: true,
      });
  });

  it('does not read a senior role, or an English "stage", as an internship', () => {
    for (const title of DROP)
      expect({ title, shaped: internshipShaped(title) }).toEqual({
        title,
        shaped: false,
      });
  });

  it('answers the same for a title asked twice', () => {
    // None of the patterns may carry /g: `test` on a global regex advances lastIndex and
    // leaves it there, so the second answer would depend on the first.
    expect(internshipShaped('Praktikum')).toBe(internshipShaped('Praktikum'));
    expect(internshipShaped('Software Engineering Intern')).toBe(true);
    expect(internshipShaped('Software Engineering Intern')).toBe(true);
  });
});

describe('workday fetch', () => {
  it('reads the list and enriches only the internship-shaped rows from their details', async () => {
    const list = {
      total: 3,
      jobPostings: [
        {
          title: 'Software Engineering Intern - Summer 2027',
          externalPath: '/job/US-CA-Santa-Clara/SWE-Intern_JR100',
          locationsText: 'US, CA, Santa Clara',
          postedOn: 'Posted 3 Days Ago',
          bulletFields: ['JR100'],
        },
        {
          title: 'Senior Staff Engineer',
          externalPath: '/job/US-CA-Santa-Clara/Senior_JR200',
          locationsText: 'Munich, Germany',
          postedOn: 'Posted Today',
          bulletFields: ['JR200'],
        },
        {
          title: 'Staff Engineer, Platform',
          externalPath: '/job/Multi/Platform_JR300',
          locationsText: '2 Locations',
          postedOn: 'Posted Today',
          bulletFields: ['JR300'],
        },
      ],
    };
    const detail = {
      jobPostingInfo: {
        id: 'c59b9491',
        jobDescription: '<p>Build tools</p><ul><li>Python</li></ul>',
        location: 'US, CA, Santa Clara',
        postedOn: 'Posted 3 Days Ago',
        startDate: '2027-01-05',
        timeType: 'Full time',
        jobReqId: 'JR100',
        externalUrl:
          'https://acmefix.wd5.myworkdayjobs.com/Careers/job/US-CA-Santa-Clara/SWE-Intern_JR100',
        jobRequisitionLocation: {
          descriptor: 'US, CA, Santa Clara',
          country: { alpha2Code: 'US' },
        },
      },
    };
    const stub = stubFetch((_url, body) => (body === undefined ? detail : list));
    try {
      const result = await workday.fetch({
        board: 'acmefix@wd5/Careers',
        keywords: ['software intern'],
      });
      expect(result.postings).toHaveLength(3);

      const intern = result.postings[0]!;
      expect(intern.descriptionText).toMatch(/Python/);
      expect(intern.descriptionText).not.toMatch(/<[a-z/]/i);
      // "US, CA, Santa Clara" is largest-first; read as written it files "US" as a city.
      expect(intern.locations[0]).toMatchObject({
        city: 'Santa Clara',
        region: 'CA',
        country: 'US',
      });
      // The machine-readable startDate, never the "Posted 3 Days Ago" prose.
      expect(intern.postedAt).toBe('2027-01-05T00:00:00.000Z');
      expect(intern.externalId).toBe('JR100');
      expect(intern.applyUrl).toBe(detail.jobPostingInfo.externalUrl);
      expect(intern.atsVendor).toBe('workday');

      // The senior rows were kept as postings but never cost a detail request, and their
      // prose postedOn stores nothing rather than a guess.
      const senior = result.postings[1]!;
      expect(senior.descriptionText).toBe('');
      expect(senior.postedAt).toBeNull();
      expect(senior.externalId).toBeNull();
      expect(senior.locations[0]).toMatchObject({ city: 'Munich', country: 'Germany' });
      expect(senior.locations[0]?.region).toBeUndefined();
      expect(senior.canonicalUrl).toContain('/Careers/job/US-CA-Santa-Clara/Senior_JR200');

      // "2 Locations" is a count, not a place: nothing is stored for it.
      expect(result.postings[2]!.locations).toEqual([]);

      const detailCalls = stub.calls.filter((c) => c.body === undefined);
      expect(detailCalls).toHaveLength(1);
      expect(detailCalls[0]!.url).toContain('JR100');
      // The list POST carried the planned keywords as the server-side search.
      expect((stub.calls[0]!.body as { searchText: string }).searchText).toBe('software intern');
      expect(result.notes.join(' ')).toMatch(/2 of 3/);
    } finally {
      stub.restore();
    }
  });

  it('walks offsets and reports what the walk did not reach as a gap', async () => {
    const pageOf = (offset: number, n: number) => ({
      total: 1000,
      jobPostings: Array.from({ length: n }, (_, i) => ({
        title: `Analyst ${offset + i}`,
        externalPath: `/job/x/A${offset + i}`,
        locationsText: 'Austin, TX',
      })),
    });
    const stub = stubFetch((_url, body) => {
      const { offset } = body as { offset: number };
      // The board promises 1000 but the second page comes back empty; the walk must stop
      // rather than loop against the promise, and must say what it did not reach.
      return offset === 0 ? pageOf(0, 20) : pageOf(offset, 0);
    });
    try {
      // One planned keyword is one search, so the walk under test is a single walk.
      const result = await workday.fetch({ board: 'paging@wd1/Ext', keywords: ['analyst'] });
      expect(result.postings).toHaveLength(20);
      expect((stub.calls[1]!.body as { offset: number }).offset).toBe(20);
      expect(result.gaps?.join(' ')).toMatch(/20 of 1000 matches for "analyst"/);
      // "Austin, TX" names no country, so none is stored.
      expect(result.postings[0]!.locations[0]).toMatchObject({ city: 'Austin', region: 'TX' });
      expect(result.postings[0]!.locations[0]?.country).toBeUndefined();
    } finally {
      stub.restore();
    }
  });

  /**
   * The total a board states is learned ONCE.
   *
   * It used to be reassigned on every page, with `rows.length` as the fallback for a page
   * that omits the key — so a second page without a `total` overwrote the 1000 the first
   * page stated with the 40 rows read so far. That satisfied `rows.length >= total` and
   * broke the walk, then failed `total > rows.length` so no gap was pushed: 960 unread
   * matches reported as a complete search, which is the exact silence `gaps` exists for.
   */
  /**
   * A page that fails partway must not cost the run the pages that succeeded.
   *
   * The fetch inside the walk was uncontained, so an HTTP error on a later page escaped the
   * whole adapter and every row already read was discarded. That became far worse once the
   * runner learned to treat a 404/410/422 as "this board address is gone" and switch the
   * source row off: the user was told the address no longer answers, and the board was
   * dropped from every future plan, about an address that had just answered twenty rows in
   * the same call.
   */
  it('keeps the rows it read when a later page fails, and says where it stopped', async () => {
    const stub = stubFetch((_url, body) => {
      const { offset } = body as { offset: number };
      if (offset >= 20) return new Response('gone', { status: 404 });
      return {
        total: 1000,
        jobPostings: Array.from({ length: 20 }, (_, i) => ({
          title: `Analyst ${offset + i}`,
          externalPath: `/job/x/B${offset + i}`,
        })),
      };
    });
    try {
      const result = await workday.fetch({ board: 'half@wd1/Ext', keywords: ['analyst'] });
      expect(result.postings).toHaveLength(20);
      expect(result.gaps?.join(' ')).toMatch(/offset 20 could not be read/);
      expect(result.gaps?.join(' ')).toMatch(/Results before it are included/);
    } finally {
      stub.restore();
    }
  });

  /**
   * ...but a first page that fails is the address itself being unreadable, and the error has
   * to reach the runner so its judgement — and its disable — still stand.
   */
  it('rethrows when the FIRST page fails, so a dead address is still reported as dead', async () => {
    const stub = stubFetch(() => new Response('gone', { status: 404 }));
    try {
      await expect(workday.fetch({ board: 'dead@wd1/Ext', keywords: ['analyst'] })).rejects.toThrow(
        /404/,
      );
    } finally {
      stub.restore();
    }
  });

  it('keeps the total the first page stated when a later page omits it', async () => {
    const stub = stubFetch((_url, body) => {
      const { offset } = body as { offset: number };
      const jobPostings = Array.from({ length: 20 }, (_, i) => ({
        title: `Analyst ${offset + i}`,
        externalPath: `/job/x/B${offset + i}`,
      }));
      return offset === 0 ? { total: 1000, jobPostings } : { jobPostings };
    });
    try {
      const result = await workday.fetch({ board: 'notot@wd1/Ext', keywords: ['analyst'] });
      expect(result.gaps?.join(' ')).toMatch(/of 1000 matches for "analyst"/);
      expect(result.postings.length).toBeGreaterThan(20);
    } finally {
      stub.restore();
    }
  });

  /**
   * A walk that stopped at its own ceiling on a board that never stated a total.
   *
   * `total > rows.length` cannot see this case, because there is no total to compare
   * against, so without its own branch it is a silent truncation: a board the walk stopped
   * reading reported as a board it read to the end.
   */
  it('reports stopping at the row ceiling even when the board states no total', async () => {
    const stub = stubFetch((_url, body) => {
      if (body === undefined) return { jobPostingInfo: { jobDescription: '<p>Build</p>' } };
      const { offset } = body as { offset: number };
      return {
        jobPostings: Array.from({ length: 20 }, (_, i) => ({
          title: `Analyst ${offset + i}`,
          externalPath: `/job/x/N${offset + i}`,
        })),
      };
    });
    try {
      const result = await workday.fetch({ board: 'nototal@wd1/Ext', keywords: ['analyst'] });
      expect(result.postings).toHaveLength(200);
      expect(result.gaps?.join(' ')).toMatch(/Stopped at 200 rows for "analyst"/);
      expect(result.gaps?.join(' ')).toMatch(/did not say how many more/);
    } finally {
      stub.restore();
    }
  }, 20_000);

  /**
   * The single search is deliberate, and the limitation is said out loud.
   *
   * Workday's `searchText` is a fuzzy match, not a term match: the live tenant that answers
   * 919 postings for "intern" answers 1779 for "prácticas" and 504 for "stage", all of them
   * senior engineering roles. Asking it the multilingual vocabulary the SmartRecruiters
   * adapter sends read 189 rows holding 9 internships where this one search read 200 holding
   * most of the board's real ones. A board that answers nothing gets a note saying which
   * word it was asked, because "0 found" alone cannot tell "nothing open" from "nothing we
   * asked for".
   */
  it('asks one search, and says which word when the board answers nothing', async () => {
    const stub = stubFetch(() => ({ total: 0, jobPostings: [] }));
    try {
      const result = await workday.fetch({ board: 'quiet@wd3/Ext' });
      const asked = stub.calls
        .filter((c) => c.body !== undefined)
        .map((c) => (c.body as { searchText: string }).searchText);
      expect(asked).toEqual(['intern']);
      expect(result.postings).toEqual([]);
      expect(result.notes.join(' ')).toMatch(/answered nothing for "intern"/);
      expect(result.notes.join(' ')).toMatch(/Praktikum/);
      // Nothing open is the ordinary answer here, so it is not a gap: marking every such
      // board degraded would leave the degraded flag meaning nothing.
      expect(result.gaps ?? []).toEqual([]);
    } finally {
      stub.restore();
    }
  });

  /**
   * The same silence one adapter over, and worse: Workday asks one term and names it, while
   * SmartRecruiters asks up to six and said nothing at all. A board that answered every one
   * of them with nothing came back postings 0, notes 0, gaps 0 — which cannot be told apart
   * from a board nobody asked, and the run summary's "0 found" then reads to the student as
   * "this company has no internships".
   */
  it('says which words it asked when a SmartRecruiters board answers nothing', async () => {
    const stub = stubFetch(() => ({ totalFound: 0, content: [] }));
    try {
      const result = await smartrecruiters.fetch({ board: 'quietco' });
      expect(result.postings).toEqual([]);
      const said = result.notes.join(' ');
      expect(said).toMatch(/answered nothing for/);
      // Every term it actually spent a request on is named, not just the first.
      for (const term of ['praktikum', 'werkstudent', 'internship', 'intern']) {
        expect(said, term).toContain(`"${term}"`);
      }
      expect(result.gaps ?? []).toEqual([]);
    } finally {
      stub.restore();
    }
  });

  /**
   * A board that ignores `offset`, or that shifts under a walk, answers the same posting on
   * two pages. A row seen twice is one posting, not two.
   */
  it('keeps a row the walk saw on more than one page only once', async () => {
    const stub = stubFetch((_url, body) =>
      body === undefined
        ? { jobPostingInfo: { jobDescription: '<p>Build</p>' } }
        : {
            total: 100,
            jobPostings: Array.from({ length: 20 }, () => ({
              title: 'Praktikum / Internship',
              externalPath: '/job/x/DUP',
            })),
          },
    );
    try {
      const result = await workday.fetch({ board: 'dupes@wd1/Ext', keywords: ['intern'] });
      expect(stub.calls.filter((c) => c.body !== undefined).length).toBeGreaterThan(1);
      expect(result.postings).toHaveLength(1);
    } finally {
      stub.restore();
    }
  }, 20_000);

  /**
   * The detail-fetch cap is a GAP, not a note.
   *
   * A note sets neither `degraded` nor `skipped` (run.ts), so a board of thirty internships
   * where ten came back with descriptionText '' read as a complete search. The identical
   * user-visible outcome from a FAILED detail fetch has always been a gap. Worse downstream:
   * matching/run.ts stamps requirementsExtractedAt after extracting from the empty text and
   * never re-extracts, so the empty requirement set sticks.
   */
  it('reports the detail-fetch cap as a gap, and still ships the capped postings', async () => {
    const jobPostings = Array.from({ length: 30 }, (_, i) => ({
      title: `Software Engineering Intern ${i}`,
      externalPath: `/job/x/C${i}`,
    }));
    const stub = stubFetch((_url, body) => {
      if (body === undefined) {
        return { jobPostingInfo: { jobDescription: '<p>Build tools</p>', jobReqId: 'JR1' } };
      }
      const { offset } = body as { offset: number };
      return { total: 30, jobPostings: jobPostings.slice(offset, offset + 20) };
    });
    try {
      const result = await workday.fetch({ board: 'capped@wd1/Ext', keywords: ['intern'] });
      expect(result.postings).toHaveLength(30);
      // Shipped, not dropped: a title, a company and a link the student can open is real
      // coverage, and dropping them would turn a thin posting into no posting at all.
      expect(result.postings.filter((p) => p.descriptionText === '')).toHaveLength(10);
      expect(result.gaps?.join(' ')).toMatch(/the other 10 are in these results with no/);
      // The old wording lived in `notes`, which is what made it invisible.
      expect(result.notes.join(' ')).not.toMatch(/detail pages/);
    } finally {
      stub.restore();
    }
    // Twenty detail fetches at the adapter's own two-per-second rate is ten seconds of
    // deliberate politeness, which is longer than the default per-test timeout.
  }, 30_000);

  /**
   * A bad row costs its own row. run.ts catches per target, so a TypeError out of the
   * adapter did not kill the run, but it did cost the whole board: the source reported an
   * error and contributed nothing when 29 of its 30 rows were perfectly readable.
   */
  it('skips and counts a row it cannot read rather than losing the board', async () => {
    const stub = stubFetch((_url, body) =>
      body === undefined
        ? { jobPostingInfo: { jobDescription: 42, location: 7 } }
        : {
            total: 3,
            jobPostings: [
              null,
              { title: 'SWE Intern', externalPath: '/job/x/G1' },
              { title: 99, externalPath: '/job/x/G2' },
            ],
          },
    );
    try {
      const result = await workday.fetch({ board: 'badrow@wd1/Ext', keywords: ['intern'] });
      expect(result.postings).toHaveLength(1);
      expect(result.postings[0]!.title).toBe('SWE Intern');
      // A non-string description is not a description; nothing is invented for it.
      expect(result.postings[0]!.descriptionText).toBe('');
      expect(result.gaps?.join(' ')).toMatch(/skipped 2 rows/);
    } finally {
      stub.restore();
    }
  });

  /**
   * A board that cannot be read is not a board with nothing on it. It has to reach the run
   * as an error, which run.ts turns into `degraded` and a line in `skipped`, rather than as
   * a clean empty result that reads as "this company has no internships".
   */
  it('reports a board it could not read as a failure, not as an empty board', async () => {
    const stub = stubFetch(() => new Response('gone', { status: 404 }));
    try {
      await expect(workday.fetch({ board: 'alldown@wd1/Ext' })).rejects.toThrow(/404/);
    } finally {
      stub.restore();
    }
  });
});

describe('smartrecruiters', () => {
  it('reports a missing company identifier as a gap', async () => {
    const result = await smartrecruiters.fetch({ board: '' });
    expect(result.postings).toEqual([]);
    expect(result.gaps?.join(' ')).toMatch(/never asked/);
  });

  it('reads the board and enriches only the internship-shaped rows from their details', async () => {
    const list = {
      totalFound: 2,
      content: [
        {
          id: '111',
          name: 'Software Engineering Intern',
          releasedDate: '2027-02-01T10:00:00.000Z',
          company: { identifier: 'acmesr', name: 'Acme Corp' },
          location: { city: 'Berlin', country: 'de', remote: false },
        },
        {
          id: '222',
          name: 'Senior Staff Engineer',
          location: { city: 'Poland', region: 'REMOTE', country: 'pl', remote: true },
        },
      ],
    };
    const detail = {
      postingUrl: 'https://jobs.smartrecruiters.com/acmesr/111-software-engineering-intern',
      applyUrl: 'https://jobs.smartrecruiters.com/acmesr/111-software-engineering-intern?oga=true',
      jobAd: {
        sections: {
          companyDescription: { title: 'Company Description', text: '<p>About Acme</p>' },
          jobDescription: { title: 'Job Description', text: '<p>Build tools</p>' },
          qualifications: { title: 'Qualifications', text: '<ul><li>Python</li></ul>' },
        },
      },
    };
    const stub = stubFetch((url) => (url.includes('/postings/111') ? detail : list));
    try {
      const result = await smartrecruiters.fetch({ board: 'acmesr' });
      expect(result.postings).toHaveLength(2);

      const intern = result.postings[0]!;
      expect(intern.canonicalUrl).toBe(detail.postingUrl);
      expect(intern.applyUrl).toBe(detail.applyUrl);
      expect(intern.descriptionText).toMatch(/Build tools/);
      expect(intern.descriptionText).toMatch(/Python/);
      expect(intern.descriptionText).not.toMatch(/<[a-z/]/i);
      // The company boilerplate section repeats on every posting and is left out, so the
      // text parsers cannot read a company-wide figure as this posting's pay.
      expect(intern.descriptionText).not.toMatch(/About Acme/);
      expect(intern.company).toBe('Acme Corp');
      expect(intern.postedAt).toBe('2027-02-01T10:00:00.000Z');
      // The lowercase ISO code arrives as "de"; the app stores codes uppercase.
      expect(intern.locations[0]).toMatchObject({ city: 'Berlin', country: 'DE' });

      const senior = result.postings[1]!;
      // No detail was fetched for it, so its page is the documented public pattern.
      expect(senior.canonicalUrl).toBe('https://jobs.smartrecruiters.com/acmesr/222');
      expect(senior.descriptionText).toBe('');
      // "REMOTE" in the region slot is the remote flag restated, not a place.
      expect(senior.locations[0]?.region).toBeUndefined();
      expect(senior.locations[0]).toMatchObject({ country: 'PL', remote: true });

      const detailCalls = stub.calls.filter((c) => /\/postings\/\d+$/.test(c.url));
      expect(detailCalls).toHaveLength(1);
      expect(detailCalls[0]!.url).toContain('/postings/111');
    } finally {
      stub.restore();
    }
  });

  it('walks offsets and reports what the walk did not reach as a gap', async () => {
    const pageOf = (offset: number, n: number) => ({
      totalFound: 250,
      content: Array.from({ length: n }, (_, i) => ({
        id: String(offset + i),
        name: `Engineer ${offset + i}`,
      })),
    });
    const stub = stubFetch((url) => {
      const offset = Number(/offset=(\d+)/.exec(url)?.[1]);
      return offset === 0 ? pageOf(0, 100) : pageOf(offset, 30);
    });
    try {
      // One planned keyword is one search, so the walk under test is a single walk.
      const result = await smartrecruiters.fetch({ board: 'bigboardsr', keywords: ['engineer'] });
      expect(result.postings).toHaveLength(130);
      expect(stub.calls[1]!.url).toContain('offset=100');
      expect(result.gaps?.join(' ')).toMatch(/130 of 250 matches for "engineer"/);
      // No location was stated, so none is stored.
      expect(result.postings[0]!.locations).toEqual([]);
    } finally {
      stub.restore();
    }
  });

  /**
   * The keyword this endpoint has always supported and this adapter never sent.
   *
   * Without it a run read an arbitrary first 200 rows of a board holding 4805, in whatever
   * order the API returned them: of one real board's first 200 rows, fifteen were internship
   * shaped, while `?q=Praktikum` alone answers 202 dead-on matches. The searches are the same
   * multilingual vocabulary the Workday adapter sends, so the two cannot go looking for
   * different things and then filter with the same rule.
   */
  it('asks the board with a keyword rather than reading it from the top', async () => {
    const stub = stubFetch((url) => {
      const q = decodeURIComponent(/[?&]q=([^&]*)/.exec(url)?.[1] ?? '');
      if (q !== 'praktikum') return { totalFound: 0, content: [] };
      return { totalFound: 1, content: [{ id: '900', name: 'Praktikum Einkauf' }] };
    });
    try {
      const result = await smartrecruiters.fetch({ board: 'keywordsr' });
      const asked = stub.calls.map((c) =>
        decodeURIComponent(/[?&]q=([^&]*)/.exec(c.url)?.[1] ?? ''),
      );
      expect(asked).toContain('praktikum');
      expect(asked).toContain('internship');
      // Every list request carries a q; none reads the board from the top.
      expect(
        stub.calls.filter((c) => c.url.includes('/postings?')).every((c) => c.url.includes('&q=')),
      ).toBe(true);
      expect(result.postings.map((p) => p.title)).toEqual(['Praktikum Einkauf']);
    } finally {
      stub.restore();
    }
  });

  /** The same "learn the total once" rule as Workday, for the same reason. */
  it('keeps the total the first page stated when a later page omits it', async () => {
    const stub = stubFetch((url) => {
      const offset = Number(/offset=(\d+)/.exec(url)?.[1] ?? 0);
      const content = Array.from({ length: 100 }, (_, i) => ({
        id: String(offset + i),
        name: `Engineer ${offset + i}`,
      }));
      return offset === 0 ? { totalFound: 4805, content } : { content };
    });
    try {
      const result = await smartrecruiters.fetch({ board: 'nototsr', keywords: ['engineer'] });
      expect(result.gaps?.join(' ')).toMatch(/of 4805 matches for "engineer"/);
      expect(result.postings.length).toBeGreaterThan(100);
    } finally {
      stub.restore();
    }
  });

  /** The detail-fetch cap is a gap here too, and the capped postings still ship. */
  it('reports the detail-fetch cap as a gap, and still ships the capped postings', async () => {
    const content = Array.from({ length: 30 }, (_, i) => ({
      id: String(3000 + i),
      name: `Software Engineering Intern ${i}`,
    }));
    const stub = stubFetch((url) =>
      /\/postings\/\d+$/.test(url)
        ? { jobAd: { sections: { jobDescription: { text: '<p>Build tools</p>' } } } }
        : { totalFound: 30, content },
    );
    try {
      const result = await smartrecruiters.fetch({ board: 'cappedsr', keywords: ['intern'] });
      expect(result.postings).toHaveLength(30);
      expect(result.postings.filter((p) => p.descriptionText === '')).toHaveLength(10);
      expect(result.gaps?.join(' ')).toMatch(/the other 10 are in these results with no/);
      expect(result.notes.join(' ')).not.toMatch(/detail pages/);
    } finally {
      stub.restore();
    }
    // Twenty detail fetches at two per second, the same as the Workday case above.
  }, 30_000);

  /** A null row, and a section whose text is not text: neither may cost the board. */
  it('skips and counts a row it cannot read rather than losing the board', async () => {
    const stub = stubFetch((url) =>
      /\/postings\/\d+$/.test(url)
        ? { jobAd: { sections: { jobDescription: { text: 7 } } } }
        : {
            totalFound: 3,
            content: [
              null,
              { id: '1', name: 'SWE Intern', location: 'Berlin' },
              { id: {}, name: 'Broken Intern' },
            ],
          },
    );
    try {
      const result = await smartrecruiters.fetch({ board: 'badrowsr', keywords: ['intern'] });
      expect(result.postings).toHaveLength(1);
      expect(result.postings[0]!.title).toBe('SWE Intern');
      // A location that is a string where an object belongs states no place, and inventing
      // an empty one would put a location with no fields in the privacy export.
      expect(result.postings[0]!.locations).toEqual([]);
      expect(result.postings[0]!.descriptionText).toBe('');
      expect(result.gaps?.join(' ')).toMatch(/skipped 2 rows/);
    } finally {
      stub.restore();
    }
  });

  /**
   * Asking a board six searches is six chances to fail, a failure surface one search did not
   * have. One bad answer must cost that search and no more: the rows the other five returned
   * are real, and losing them would trade a reported gap for a lost board. What the failed
   * search would have found is named, because a term never successfully asked is a language
   * the run did not cover.
   */
  it('loses only the failed search when one search cannot be read', async () => {
    const stub = stubFetch((url) => {
      if (/\/postings\/[^/?]+$/.test(url)) {
        return { jobAd: { sections: { jobDescription: { text: '<p>Bauen</p>' } } } };
      }
      const term = decodeURIComponent(/[?&]q=([^&]*)/.exec(url)?.[1] ?? '');
      if (term === 'praktikum') return new Response('gone', { status: 404 });
      if (term === 'stage') return { totalFound: 1, content: { not: 'an array' } };
      return { totalFound: 1, content: [{ id: term, name: `Intern ${term}` }] };
    });
    try {
      const result = await smartrecruiters.fetch({ board: 'onebadsr' });
      expect(result.postings.length).toBeGreaterThan(0);
      const gaps = result.gaps?.join(' ') ?? '';
      expect(gaps).toMatch(/"praktikum"/);
      expect(gaps).toMatch(/"stage"/);
      expect(gaps).toMatch(/could not be read/);
    } finally {
      stub.restore();
    }
  }, 20_000);

  /**
   * A board where EVERY search failed is not a board with nothing on it. It has to reach the
   * run as an error, which run.ts turns into `degraded` and a line in `skipped`, rather than
   * as a clean empty result that reads as "this company has no internships".
   */
  it('reports a board whose every search failed as a failure, not as an empty board', async () => {
    const stub = stubFetch(() => new Response('gone', { status: 404 }));
    try {
      await expect(smartrecruiters.fetch({ board: 'alldownsr' })).rejects.toThrow(/404/);
    } finally {
      stub.restore();
    }
  }, 20_000);
});

describe('workable', () => {
  it('reports a missing account name as a gap', async () => {
    const result = await workable.fetch({ board: '' });
    expect(result.postings).toEqual([]);
    expect(result.gaps?.join(' ')).toMatch(/never asked/);
  });

  it('reads the whole board from the one details=true response', async () => {
    const data = {
      name: 'Acme',
      jobs: [
        {
          title: 'Marketing Intern',
          shortcode: 'AB12',
          url: 'https://apply.workable.com/j/AB12',
          application_url: 'https://apply.workable.com/j/AB12/apply',
          published_on: '2027-03-01',
          created_at: '2027-02-20',
          telecommuting: true,
          employment_type: 'Temporary',
          experience: 'Internship',
          description: '<p>Write copy</p><ul><li>SEO</li></ul>',
          locations: [
            { country: 'France', countryCode: 'FR', city: 'Paris', region: 'Île-de-France' },
          ],
        },
        {
          title: 'Office Manager',
          shortcode: 'CD34',
          url: 'https://apply.workable.com/j/CD34',
          city: 'Athens',
          state: 'Attica',
          description: '',
        },
      ],
    };
    const stub = stubFetch(() => data);
    try {
      const result = await workable.fetch({ board: 'acmewk' });
      expect(result.postings).toHaveLength(2);
      // One request carries the descriptions, so the board never costs detail fetches.
      expect(stub.calls).toHaveLength(1);
      expect(stub.calls[0]!.url).toContain('details=true');

      const intern = result.postings[0]!;
      expect(intern.descriptionText).toMatch(/SEO/);
      expect(intern.descriptionText).not.toMatch(/<[a-z/]/i);
      expect(intern.externalId).toBe('AB12');
      expect(intern.applyUrl).toBe('https://apply.workable.com/j/AB12/apply');
      expect(intern.postedAt).toBe('2027-03-01T00:00:00.000Z');
      // The machine-readable countryCode, not the spelled-out name beside it.
      expect(intern.locations[0]).toMatchObject({
        city: 'Paris',
        region: 'Île-de-France',
        country: 'FR',
        remote: true,
      });
      // telecommuting is structural and outranks the text heuristic, as on Ashby.
      expect(intern.workArrangement).toBe('remote');
      expect(intern.company).toBe('Acme');

      // The flat fields name no country, so none is stored.
      const manager = result.postings[1]!;
      expect(manager.locations[0]).toMatchObject({ city: 'Athens', region: 'Attica' });
      expect(manager.locations[0]?.country).toBeUndefined();
      expect(manager.postedAt).toBeNull();
    } finally {
      stub.restore();
    }
  });

  /**
   * Three separate rows used to take the whole board down with them: a null entry in `jobs`,
   * a null entry in a job's `locations`, and a `description` that is a number rather than
   * HTML. All three are one row's problem now, and the skipped ones are counted.
   */
  it('skips and counts a row it cannot read rather than losing the board', async () => {
    const stub = stubFetch(() => ({
      name: 'Acme',
      jobs: [
        null,
        { title: 'Data Intern', url: 'https://apply.workable.com/j/OK1', description: 42 },
        {
          title: 'Design Intern',
          url: 'https://apply.workable.com/j/OK2',
          locations: [null, { city: 'Berlin', countryCode: 'DE' }],
        },
        { title: 'No Link Intern' },
      ],
    }));
    try {
      const result = await workable.fetch({ board: 'badrowwk' });
      expect(result.postings.map((p) => p.title)).toEqual(['Data Intern', 'Design Intern']);
      // A number is not a description, and nothing is invented in its place.
      expect(result.postings[0]!.descriptionText).toBe('');
      expect(result.postings[0]!.descriptionHtml).toBeNull();
      // The one readable location survives; the null entry states no place.
      expect(result.postings[1]!.locations).toEqual([
        { city: 'Berlin', region: undefined, country: 'DE', remote: false },
      ]);
      expect(result.gaps?.join(' ')).toMatch(/skipped 2 rows/);
    } finally {
      stub.restore();
    }
  });
});

/**
 * The three older adapters share the shape the new ones copied, so they share the hole: one
 * null row in the array threw out of the whole board.
 */
describe('greenhouse, lever and ashby row safety', () => {
  it('skips a null row and counts it, on every adapter that reads an array', async () => {
    const gh = stubFetch(() => ({
      jobs: [null, { id: 7, title: 'SWE Intern', absolute_url: 'https://example.com/jobs/7' }],
    }));
    try {
      const result = await greenhouse.fetch({ board: 'nullrowgh' });
      expect(result.postings.map((p) => p.title)).toEqual(['SWE Intern']);
      expect(result.postings[0]!.externalId).toBe('7');
      expect(result.gaps?.join(' ')).toMatch(/skipped 1 rows/);
    } finally {
      gh.restore();
    }

    const lv = stubFetch(() => [
      null,
      { id: 'a1', text: 'Data Intern', hostedUrl: 'https://jobs.lever.co/x/a1', createdAt: 'nope' },
    ]);
    try {
      const result = await lever.fetch({ board: 'nullrowlv' });
      expect(result.postings.map((p) => p.title)).toEqual(['Data Intern']);
      // An epoch that is not a number is not a date: `new Date(NaN).toISOString()` throws.
      expect(result.postings[0]!.postedAt).toBeNull();
      expect(result.gaps?.join(' ')).toMatch(/skipped 1 rows/);
    } finally {
      lv.restore();
    }

    const as = stubFetch(() => ({
      jobs: [
        null,
        {
          id: 'b2',
          title: 'ML Intern',
          jobUrl: 'https://jobs.ashbyhq.com/x/b2',
          compensation: { summaryComponents: [null, { compensationType: 'Salary' }] },
        },
      ],
    }));
    try {
      const result = await ashby.fetch({ board: 'nullrowas' });
      expect(result.postings.map((p) => p.title)).toEqual(['ML Intern']);
      expect(result.postings[0]!.compensation).toBeNull();
      expect(result.gaps?.join(' ')).toMatch(/skipped 1 rows/);
    } finally {
      as.restore();
    }
  });
});

/**
 * A location string that says somebody has to be there.
 *
 * Several boards set a `remote` boolean on anything that is not fully in-office — Arbeitnow
 * flags a Munich hybrid role remote — and `parseLocation` took that boolean over the words
 * beside it. So "München (Hybrid)" was stored as remote, scored as well as a job at home for a
 * student in Half Moon Bay, and six of the fifteen eligible matches in a real run were German
 * roles that arrived this way.
 *
 * The words are the more specific statement about the same job, so where the two disagree the
 * words win. Where the text says nothing either way the hint still stands, which is the case
 * it was added for.
 */
describe('a location that names an arrangement', () => {
  it('lets the words overrule a board flag that says remote', () => {
    expect(parseLocation('München (Hybrid)', true)).toEqual({ city: 'München', remote: false });
    expect(parseLocation('Austin, TX — Onsite', true)).toEqual({
      city: 'Austin',
      region: 'TX',
      remote: false,
    });
  });

  it('keeps the flag when the text says nothing about arrangement', () => {
    // The case the hint exists for: a bare city on a feed that states remoteness structurally.
    expect(parseLocation('Berlin', true)).toEqual({ city: 'Berlin', remote: true });
    expect(parseLocation('Berlin', false)).toEqual({ city: 'Berlin', remote: false });
  });

  it('does not leave the arrangement word sitting in the place', () => {
    // The city is what gets shown to the user and matched against where they live. "München
    // (Hybrid)" and "NY —" are not places.
    expect(parseLocation('Los Angeles (Hybrid)').city).toBe('Los Angeles');
    expect(parseLocation('New York, NY — Onsite').region).toBe('NY');
    // A part that was ONLY an arrangement word is not a place at all. This used to be filed
    // as the region and reported to the user as one.
    expect(parseLocation('Austin, Hybrid')).toEqual({ city: 'Austin', remote: false });
    // And where the word does not sit at the END of its part, so trimming the tail cannot
    // reach it — "Hybrid work" and "On-site only" are how boards write the same thing.
    expect(parseLocation('Austin, Hybrid work')).toEqual({ city: 'Austin', remote: false });
    expect(parseLocation('Austin, On-site only')).toEqual({ city: 'Austin', remote: false });
    expect(parseLocation('Munich, Vor Ort')).toEqual({ city: 'Munich', remote: false });
  });

  it('leaves every remote spelling it already read alone', () => {
    expect(parseLocation('Remote - US')).toEqual({ country: 'US', remote: true });
    expect(parseLocation('New York, NY or Remote')).toEqual({
      city: 'New York',
      region: 'NY',
      remote: true,
    });
    expect(parseLocation('Remote')).toEqual({ remote: true });
    // Oregon's state code survives, which is the reason stripRemoteToken is careful.
    expect(parseLocation('Portland, OR')).toEqual({
      city: 'Portland',
      region: 'OR',
      remote: false,
    });
  });
});

/**
 * Whatever is left after the strippers have run is not automatically a place.
 *
 * Arbeitnow writes a fully-remote job's location as "Remote job". Stripping the remote
 * wording leaves "job", and "job" was stored as the city: a real run has a posting whose
 * recorded location reads exactly that, shown to the student as where the work is. It also
 * cost the posting rank, because a remote role that names a city is treated as anchored to
 * it — so a word that was never a place was pushing a genuinely-anywhere job down the queue.
 */
describe('a location that names no place', () => {
  it('does not record the leftover word as a city', () => {
    expect(parseLocation('Remote job', true)).toEqual({ remote: true });
    // The same shape without the feed's flag to lean on.
    expect(parseLocation('Remote position')).toEqual({ remote: true });
    expect(parseLocation('Remote opportunity')).toEqual({ remote: true });
  });

  it('reads "nowhere in particular" as remote rather than as a town', () => {
    // No flag passed: the words are all there is, and they do say something.
    expect(parseLocation('Homeoffice')).toEqual({ remote: true });
    expect(parseLocation('Worldwide')).toEqual({ remote: true });
    expect(parseLocation('Anywhere')).toEqual({ remote: true });
    expect(parseLocation('Work from home')).toEqual({ remote: true });
  });

  it('drops the furniture without dropping the geography beside it', () => {
    expect(parseLocation('Berlin, Homeoffice')).toEqual({ city: 'Berlin', remote: true });
  });

  it('does not mistake a place for furniture', () => {
    // The edge this rule has to stay clear of. These are real towns, and two of them are
    // one letter from words in the list.
    expect(parseLocation('Vogt').city).toBe('Vogt');
    expect(parseLocation('Leer').city).toBe('Leer');
    expect(parseLocation('York, PA').city).toBe('York');
  });
});
