/**
 * Query planning, and specifically the guard the file's own header promises: that a role
 * family only enters the plan when the profile actually evidences it.
 */
import { describe, expect, it } from 'vitest';
import type { ConfirmedProfile, SearchFilters } from '@ia/shared';
import {
  inferRoleFamilies,
  planQueries,
  termTokens,
  upcomingCycleYear,
} from '../src/core/discovery/queryPlanner';
import { AGGREGATOR_SOURCES } from '../src/core/discovery/sources/aggregators';

/**
 * The keyless, no-board sources a plan carries by default. Computed from the registry
 * rather than written out, because the planner itself gates on the registry: a default
 * only enters a plan when the runner actually has its adapter, so the expectation here
 * has to move with the registry the same way the plan does.
 */
// Remotive is deliberately NOT a default: its robots.txt refuses the feed, so planning it
// put a standing "not complete" warning on every run for a source that can never contribute.
// See queryPlanner's KEYLESS_DEFAULTS comment.
const DEFAULT_KEYLESS = (['github_list', 'arbeitnow'] as const).filter(
  (k) => k in AGGREGATOR_SOURCES,
);

function profile(over: Record<string, unknown> = {}): ConfirmedProfile {
  return {
    id: 'p1',
    fullName: 'A',
    email: 'a@b.c',
    skills: [],
    experience: [],
    projects: [],
    education: [],
    locationPrefs: {
      base: { city: 'Boston', region: 'MA', country: 'US' },
      additionalBases: [],
      maxCommuteKm: 50,
      remoteOk: true,
      hybridOk: true,
      relocateTo: [],
    },
    // Not optional on ConfirmedProfile, and the planner now reads it on every call. The
    // fixture casts through `unknown`, so omitting it typechecked and threw at runtime.
    preferences: { companySizes: [], industries: [], excludeCompanies: [], roleFamilies: [] },
    ...over,
  } as unknown as ConfirmedProfile;
}

function filters(over: Record<string, unknown> = {}): SearchFilters {
  return {
    term: { seasons: ['summer'], years: [2027] },
    positionTypes: ['internship'],
    role: { roleFamilies: [], titleIncludes: [], titleExcludes: [] },
    location: { cities: [], remote: true },
    company: { onlyCompanies: [], excludeCompanies: [] },
    ...over,
  } as unknown as SearchFilters;
}

describe('inferRoleFamilies', () => {
  /**
   * Every one of these was a real substring hit before the matcher required word
   * boundaries: "ml" inside "html", "ai" inside "email"/"training"/"detail", "ui" inside
   * "building", "lab" inside "collaborate", "pm" inside "rpm". A web-development resume
   * came back as a machine-learning candidate and got the queries to match.
   */
  it('does not read machine learning out of HTML, email and training', () => {
    const p = profile({
      skills: [{ name: 'HTML' }, { name: 'CSS' }],
      experience: [
        {
          title: 'Web Assistant',
          bullets: ['Sent email campaigns', 'Attended training', 'Collaborated on details'],
        },
      ],
    });
    expect(inferRoleFamilies(p)).not.toContain('machine learning');
  });

  it('does not read design out of "building"', () => {
    const p = profile({
      experience: [{ title: 'Helper', bullets: ['Building shelves in the workshop'] }],
    });
    expect(inferRoleFamilies(p)).not.toContain('design');
  });

  it('still finds a family the profile genuinely evidences', () => {
    const p = profile({
      skills: [{ name: 'PyTorch' }, { name: 'ML' }],
      experience: [{ title: 'Research Assistant', bullets: ['Deep learning for NLP'] }],
    });
    expect(inferRoleFamilies(p)).toContain('machine learning');
  });

  it('keeps the deliberate stems working', () => {
    const p = profile({
      education: [{ fieldOfStudy: 'Molecular Biology', coursework: ['Genomics'] }],
    });
    expect(inferRoleFamilies(p)).toContain('biology');
  });

  /**
   * The "robot" stem prefix-matched two idioms that are not robotics: "robots.txt" (an SEO
   * artefact) and "robotic process automation" (an ops one). A marketing or operations resume
   * was handed a robotics family and its queries — the substring-into-unrelated-resume failure
   * the word-boundary work in this file exists to end.
   */
  it('does not read robotics out of robots.txt or robotic process automation', () => {
    const seo = profile({
      skills: [{ name: 'SEO' }, { name: 'Content' }],
      experience: [{ title: 'Marketing Assistant', bullets: ['Configured robots.txt for SEO'] }],
    });
    expect(inferRoleFamilies(seo)).not.toContain('robotics');

    const ops = profile({
      skills: [{ name: 'Operations' }],
      experience: [
        { title: 'Ops Analyst', bullets: ['Automated invoicing with robotic process automation'] },
      ],
    });
    expect(inferRoleFamilies(ops)).not.toContain('robotics');
  });

  /**
   * Organisation names feed the corpus so a robotics club states the family in the org, but
   * under a prefix stem "Brandeis University" scored the "brand" (marketing) term and a
   * dining-services campus job — the common freshman shape — minted an evidence-free marketing
   * family. Org names match as whole words only.
   */
  it('does not mint a family from a prefix of an organisation name', () => {
    const p = profile({
      experience: [
        { title: 'Dining Services Assistant', organization: 'Brandeis University', bullets: [] },
      ],
    });
    expect(inferRoleFamilies(p)).not.toContain('marketing');
  });

  /**
   * "FIRST Robotics" is hit by "robotics", by the "robot" stem and by "first robotics" at once.
   * Counting matched terms let one water-handing line score robotics 3 and evict a family the
   * resume genuinely evidenced from the four-slot plan. Overlapping matches are one piece of
   * evidence, so a single FIRST mention must not outrank a real, separately-evidenced family.
   */
  it('does not let one robotics mention evict a genuinely evidenced family', () => {
    const p = profile({
      skills: [{ name: 'Figma' }, { name: 'pandas' }, { name: 'SQL' }],
      experience: [
        {
          title: 'Data Analyst',
          bullets: ['Handed out water at a FIRST Robotics event', 'Built dashboards in SQL'],
        },
      ],
      projects: [{ name: 'UX prototype', description: 'Designed a Figma prototype for the UI' }],
    });
    const families = inferRoleFamilies(p);
    expect(families).toContain('design');
    expect(families).toContain('data science');
  });

  /**
   * The true positive the robotics family exists for: a FIRST-shaped history states robotics in
   * the org name and in an award, and both have to keep inferring it.
   */
  it('still infers robotics from real robotics evidence in org and honors', () => {
    const p = profile({
      experience: [
        { title: 'Team Captain', organization: 'Sample Robotics', bullets: [] },
        { title: 'Mentor', organization: 'Gourd Bots, FIRST Robotics Competition', bullets: [] },
      ],
      education: [
        {
          fieldOfStudy: 'Mechanical Engineering',
          honors: ["Dean's List, FIRST Robotics Competition"],
        },
      ],
    });
    expect(inferRoleFamilies(p)).toContain('robotics');
  });

  /**
   * "Designed weekly practice plans" is among the commonest resume verbs in every
   * domain. As a bare stem it was the ONLY taxonomy hit on a swim coach's profile, so
   * the coach got UX and Figma internship queries. Design now needs design evidence.
   */
  it('does not read UX design out of the verb "designed"', () => {
    const coach = profile({
      experience: [
        {
          title: 'Assistant Swim Coach',
          organization: 'Harborview Aquatic Club',
          bullets: ['Designed weekly practice plans with the head coach'],
        },
      ],
    });
    expect(inferRoleFamilies(coach)).not.toContain('design');

    // The true positive the family exists for still infers.
    const ux = profile({
      projects: [
        { name: 'Club site', description: 'Designed Figma wireframes for the signup flow' },
      ],
    });
    expect(inferRoleFamilies(ux)).toContain('design');
  });

  it('does not read product management out of photographing products', () => {
    const etsy = profile({
      experience: [
        {
          title: 'Founder',
          organization: 'Reyes Custom Prints',
          bullets: ['Set prices, photograph products, and answer customer messages'],
        },
      ],
    });
    expect(inferRoleFamilies(etsy)).not.toContain('product management');

    const pm = profile({
      experience: [
        { title: 'Product Intern', bullets: ['Owned the product roadmap for the beta'] },
      ],
    });
    expect(inferRoleFamilies(pm)).toContain('product management');
  });

  /**
   * "Sample Regional Science and Engineering Fair" is a science fair, not a software
   * background — the "engineer" stem minted software queries for a Behavioral Sciences
   * award. Meanwhile USACO Silver plus AP Computer Science A — what a competition
   * programmer's resume actually prints — evidenced nothing.
   */
  it('reads software engineering from USACO and CS coursework, not from a fair name', () => {
    const fair = profile({
      education: [
        {
          honors: [
            'Sample Regional Science and Engineering Fair, Grand Award, Behavioral Sciences (2025)',
          ],
        },
      ],
    });
    expect(inferRoleFamilies(fair)).not.toContain('software engineering');

    const usaco = profile({
      education: [
        { coursework: ['AP Computer Science A'], honors: ['USACO Silver Division (2024)'] },
      ],
    });
    expect(inferRoleFamilies(usaco)).toContain('software engineering');
  });

  it('reads microbiology as biology', () => {
    // "biolog" is a word-START stem and cannot see itself inside "microbiology"; an ISEF
    // finalist whose resume never prints the bare word inferred no biology family.
    const p = profile({
      education: [{ honors: ['Regeneron ISEF Finalist, Microbiology (2025)'] }],
    });
    expect(inferRoleFamilies(p)).toContain('biology');
  });
});

/**
 * The four young-applicant families: each exists because a fully-loaded domain resume
 * inferred ZERO families and fell to the broad-search note — the one search its student
 * would have typed never ran. Every term is tested beside the trap it was qualified
 * against, because the last four spurious-family bugs ("ml" in "html", "brand" in
 * "Brandeis", "robot" in "robots.txt", "design" in "designed") were all one homonym away.
 */
describe('young-applicant role families: true positives and their traps', () => {
  it('education: coaching and tutoring infer it; tutorials and self-teaching do not', () => {
    const coach = profile({
      experience: [
        { title: 'Assistant Swim Coach', organization: 'Harborview Aquatic Club', bullets: [] },
        {
          title: 'Volunteer Math Tutor',
          organization: 'Bridgeview Community Center',
          bullets: ['Tutor middle school students in pre-algebra twice a week'],
        },
      ],
    });
    expect(inferRoleFamilies(coach)).toContain('education');

    // Learning is not teaching: following a tutorial, teaching yourself, being mentored.
    const learner = profile({
      experience: [
        {
          title: 'Web Assistant',
          bullets: [
            'Built the site following React tutorials',
            'Self-taught Python over the summer',
            'Mentored by senior engineers on the team',
          ],
        },
      ],
    });
    expect(inferRoleFamilies(learner)).not.toContain('education');
  });

  it('healthcare: a hospital and HOSA infer it; a patient temperament and a CPR card do not', () => {
    const premed = profile({
      experience: [
        {
          title: 'Patient Transport Volunteer',
          organization: 'Mercy Sample Regional Medical Center',
          bullets: [],
        },
      ],
      education: [
        { honors: ['HOSA State Leadership Conference Qualifier — Medical Terminology (2025)'] },
      ],
    });
    expect(inferRoleFamilies(premed)).toContain('healthcare');

    // "patient debugging" is a temperament, and First Aid/CPR is held by every coach and
    // babysitter — neither is a healthcare career signal.
    const engineer = profile({
      experience: [
        {
          title: 'QA Assistant',
          bullets: [
            'Patient and attentive debugging of flaky tests',
            'First Aid/CPR/AED certified for the summer camp job',
          ],
        },
      ],
    });
    expect(inferRoleFamilies(engineer)).not.toContain('healthcare');
  });

  it('journalism: a masthead infers it; a text editor and a WebSocket broadcast do not', () => {
    const editor = profile({
      experience: [
        {
          title: 'Editor-in-Chief',
          organization: 'The Sample Sentinel (Student Newspaper)',
          bullets: [],
        },
        { title: 'Copy Editor', organization: 'The Sampler Yearbook', bullets: [] },
      ],
      education: [{ coursework: ['Honors Journalism'] }],
    });
    expect(inferRoleFamilies(editor)).toContain('journalism');

    const dev = profile({
      skills: [{ name: 'Vim text editor' }],
      experience: [
        {
          title: 'Backend Assistant',
          bullets: ['Broadcast messages over a WebSocket to every editor session'],
        },
      ],
    });
    expect(inferRoleFamilies(dev)).not.toContain('journalism');
  });

  it('public policy: debate, MUN and student government infer it; privacy policies do not', () => {
    const debater = profile({
      experience: [
        {
          title: 'Debate Captain',
          organization: 'St. Sample High School Speech & Debate Team',
          bullets: [],
        },
        { title: 'Secretary-General', organization: 'Model United Nations Club', bullets: [] },
        {
          title: 'Student Body Treasurer',
          organization: 'St. Sample High School Student Government',
          bullets: [],
        },
      ],
      education: [
        {
          fieldOfStudy: 'Political Science',
          coursework: ['AP United States Government and Politics'],
        },
      ],
    });
    expect(inferRoleFamilies(debater)).toContain('public policy');

    // The homonyms: site policies and debated tradeoffs are not civic life.
    const web = profile({
      experience: [
        {
          title: 'Web Assistant',
          bullets: [
            'Wrote the privacy policy and return policy pages',
            'Debated tradeoffs with teammates before shipping',
          ],
        },
      ],
    });
    expect(inferRoleFamilies(web)).not.toContain('public policy');
  });

  /**
   * A school's NAME is identity, not role evidence. Young resumes write clubs as
   * "Student Ambassador, Design and Architecture Senior High", and the school's own words
   * minted a design family with zero design work behind it. The name is scrubbed from the
   * org corpus; the club text written beside it keeps counting.
   */
  it('does not mint a family from a school name used as an organisation', () => {
    const p = profile({
      education: [{ institution: 'Design and Architecture Senior High' }],
      experience: [
        {
          title: 'Student Ambassador',
          organization: 'Design and Architecture Senior High',
          bullets: [],
        },
      ],
    });
    expect(inferRoleFamilies(p)).not.toContain('design');

    // The scrub removes only the school's name: a real club after the school name in the
    // same org line still evidences its family.
    const club = profile({
      education: [{ institution: 'Design and Architecture Senior High' }],
      experience: [
        {
          title: 'Captain',
          organization: 'Design and Architecture Senior High Speech & Debate Team',
          bullets: [],
        },
      ],
    });
    expect(inferRoleFamilies(club)).toContain('public policy');
  });

  /**
   * "PM" is the product-management acronym and only two letters long, so it matches as a
   * whole word — and an hourly student writes their shift times down. A cashier who worked
   * "4 to 9 PM shifts" was handed a product-management search plan.
   */
  it('reads a clock time as hours worked, not as product management', () => {
    const cashier = profile({
      experience: [
        {
          title: 'Cashier',
          organization: 'Corner Market',
          bullets: ['Worked 4 to 9 PM shifts on weekends', 'Closed the 9am-5pm register'],
        },
      ],
    });
    expect(inferRoleFamilies(cashier)).not.toContain('product management');

    // The acronym in a title still counts — the scrub takes clock times, not the word.
    const pm = profile({
      experience: [
        {
          title: 'PM Intern',
          organization: 'Sample Software',
          bullets: ['Owned the roadmap for one surface and ran stakeholder reviews'],
        },
      ],
    });
    expect(inferRoleFamilies(pm)).toContain('product management');
  });
});

describe('pinned companies', () => {
  /**
   * A pinned name became one Greenhouse target with every non-alphanumeric character
   * deleted. A company on Lever, or one whose Greenhouse token is hyphenated, produced a
   * target that 404s — for the one company the user asked for by name.
   */
  it('tries every guessable vendor when the board has not been resolved', () => {
    const plan = planQueries(
      profile(),
      filters({
        company: { onlyCompanies: ['Acme Robotics, Inc.'], excludeCompanies: [] },
      }),
    );
    const sources = plan.targets.map((t) => t.source);
    expect(sources).toContain('greenhouse');
    expect(sources).toContain('lever');
    expect(sources).toContain('ashby');
    expect(sources).toContain('workable');
    /**
     * NOT SmartRecruiters, and the note has to say why.
     *
     * `api.smartrecruiters.com` answers `User-agent: * / Disallow: /`, the adapter honours
     * that, so a guessed target there can only ever come back refused — and planning one
     * would put "This search was not complete" on every run that pins any company, about a
     * source that cannot contribute. Silently dropping it would be its own bug: a user who
     * pinned a company that really does hire through SmartRecruiters needs to be told to go
     * and paste a URL, not left to conclude the company has nothing open.
     */
    expect(sources).not.toContain('smartrecruiters');
    expect(plan.notes.join(' ')).toMatch(/SmartRecruiters is not guessed at all/);
    expect(plan.notes.join(' ')).toMatch(/paste a job URL/);
    expect(plan.notes.join(' ')).toMatch(/no resolved board yet/i);
  });

  it('uses an already-resolved board instead of guessing, and names its vendor', () => {
    const plan = planQueries(
      profile(),
      filters({ company: { onlyCompanies: ['Acme'], excludeCompanies: [] } }),
      [{ source: 'lever', board: 'acme', reason: 'resolved' }],
    );
    // One board for the company beside the boardless defaults every plan carries. The
    // whole non-default list is asserted rather than one entry, because "guessed as well
    // as resolved" is the failure this test is for and a `toContainEqual` would not see it.
    expect(plan.targets.filter((t) => t.board !== '')).toEqual([
      { source: 'lever', board: 'acme', reason: 'company you pinned (its Lever board)' },
    ]);
    expect(plan.notes.join(' ')).not.toMatch(/no resolved board yet/i);
  });

  /**
   * "Never truncated away" was the comment; slicing the concatenated array made it false
   * as soon as the pinned list alone reached the cap.
   */
  it('never drops a pinned company to make room for a known board', () => {
    const known = Array.from({ length: 10 }, (_, i) => ({
      source: 'greenhouse' as const,
      board: `board${String(i)}`,
      reason: 'known',
    }));
    const plan = planQueries(
      profile(),
      filters({ company: { onlyCompanies: ['Pinned'], excludeCompanies: [] } }),
      known,
      { maxTargets: 4 },
    );
    // Four, not five: Greenhouse, Lever, Ashby and Workable. SmartRecruiters is no longer
    // guessed, because its host refuses this tool and a guess there could only ever refuse.
    expect(plan.targets.filter((t) => t.reason.startsWith('company you pinned'))).toHaveLength(4);
    // The guesses and the defaults survive; the cap falls entirely on the known boards.
    expect(plan.targets.filter((t) => t.reason === 'known')).toHaveLength(0);
    expect(plan.notes.join(' ')).toMatch(/\d+ targets did not fit the cap of \d+/);
  });
});

describe('Workday and the plan', () => {
  /**
   * The one vendor a slug cannot be guessed for. A Workday board is (tenant, host, site)
   * and the site name is arbitrary, so a "guessed" target would be a blind walk over
   * hosts and site names inside a discovery run — the crawl the bounded resolver probe
   * exists to avoid. A Workday target may only enter the plan through a resolution.
   */
  it('never guesses a Workday target for a pinned company', () => {
    const plan = planQueries(
      profile(),
      filters({ company: { onlyCompanies: ['Guessless'], excludeCompanies: [] } }),
    );
    expect(plan.targets.filter((t) => t.source === 'workday')).toEqual([]);
    // ...and the note says so, because five guesses that all 404 would otherwise read as
    // "this company is nowhere" to a user whose company hires through Workday.
    expect(plan.notes.join(' ')).toMatch(/Workday board cannot be guessed/);
  });

  it('promotes a resolved Workday board to the pinned company that owns its tenant', () => {
    const plan = planQueries(
      profile(),
      filters({ company: { onlyCompanies: ['Acme'], excludeCompanies: [] } }),
      [{ source: 'workday', board: 'acme@wd1/External', reason: 'already resolved' }],
    );
    // The board is "tenant@host/site", so matching it to the pinned name has to compare
    // the tenant, not the whole address — otherwise the resolved board sat unpromoted
    // while the planner emitted five guesses beside it.
    expect(plan.targets.filter((t) => t.board !== '')).toEqual([
      {
        source: 'workday',
        board: 'acme@wd1/External',
        reason: 'company you pinned (its Workday board)',
      },
    ]);
    expect(plan.notes.join(' ')).not.toMatch(/no resolved board yet/i);
  });
});

/**
 * The cold start: what a plan contains for somebody who has never run anything.
 *
 * Targets came only from pinned companies and from boards a PREVIOUS run had resolved, so a
 * fresh install planned nothing at all — and the note it printed sent the user off to name
 * companies and paste URLs without mentioning the one source that needs neither a company
 * nor a key, and which returns more postings than everything else here combined. The plan
 * could only start working after a run the plan itself could not have produced.
 */
describe('the keyless defaults', () => {
  it('are all in the plan for somebody who has run nothing and pinned nobody', () => {
    const plan = planQueries(profile(), filters());
    expect(plan.targets.map((t) => t.source).sort()).toEqual([...DEFAULT_KEYLESS].sort());
    expect(plan.targets.every((t) => t.board === '')).toBe(true);
    const list = plan.targets.find((t) => t.source === 'github_list');
    expect(list?.reason).toContain('community');
    expect(plan.notes.join(' ')).not.toMatch(/no company boards resolved/i);
  });

  it('none is planned twice once a run has resolved it as a source', () => {
    for (const source of DEFAULT_KEYLESS) {
      const plan = planQueries(profile(), filters(), [
        { source, board: '', reason: 'already resolved from a previous run' },
      ]);
      expect(plan.targets.filter((t) => t.source === source)).toHaveLength(1);
    }
  });

  it('survive truncation, because dropping them drops the whole plan of a new user', () => {
    const known = Array.from({ length: 10 }, (_, i) => ({
      source: 'greenhouse' as const,
      board: `board${String(i)}`,
      reason: 'known',
    }));
    const plan = planQueries(profile(), filters(), known, { maxTargets: 3 });
    for (const source of DEFAULT_KEYLESS) {
      expect(plan.targets.filter((t) => t.source === source)).toHaveLength(1);
    }
    expect(plan.targets.length).toBeGreaterThanOrEqual(3);
  });

  /**
   * The half of "survive the cap" that was false, and the one a real user reaches.
   *
   * A keyless default only gets a target built for it while it is ABSENT from knownBoards.
   * After one ordinary run it has a `source` row, so it arrives as a known board instead,
   * falls into the capped remainder, and eight pinned companies were enough to cut all
   * three — the community list, which returns more postings than everything else here
   * combined, silently left the plan of anyone who had both used it once and pinned eight
   * companies. The test above never saw it because it passes no source rows for them.
   */
  it('survive the cap once a run has given them source rows, not only before', () => {
    const asSourceRows = DEFAULT_KEYLESS.map((source) => ({
      source,
      board: '',
      reason: 'already resolved',
    }));
    const pinnedNames = Array.from({ length: 8 }, (_, i) => `Company${String(i)}`);
    const plan = planQueries(
      profile(),
      filters({ company: { onlyCompanies: pinnedNames, excludeCompanies: [] } }),
      asSourceRows,
    );
    for (const source of DEFAULT_KEYLESS) {
      expect(plan.targets.filter((t) => t.source === source)).toHaveLength(1);
    }
  });

  /**
   * ...and they survive it wherever the source table happens to list them. With no pinned
   * companies the old code kept them only because those rows came back before the company
   * boards and the slice reached them first, which is ordering luck, not a promise.
   */
  it('survive the cap when their source rows come last in the table', () => {
    const known = [
      ...Array.from({ length: 40 }, (_, i) => ({
        source: 'greenhouse' as const,
        board: `board${String(i)}`,
        reason: 'known',
      })),
      ...DEFAULT_KEYLESS.map((source) => ({ source, board: '', reason: 'known' })),
    ];
    const plan = planQueries(profile(), filters(), known);
    for (const source of DEFAULT_KEYLESS) {
      expect(plan.targets.filter((t) => t.source === source)).toHaveLength(1);
    }
    expect(plan.targets).toHaveLength(40);
    expect(plan.notes.join(' ')).toMatch(/\d+ targets did not fit the cap of \d+/);
  });
});

/**
 * The other side of a cap that everything important is exempt from: the plan can exceed it,
 * and nothing said so. Ten pinned companies plan fifty-three targets against a documented
 * cap of forty, and every one of those is a request the user did not ask for by number.
 */
describe('a plan that goes over its own cap', () => {
  it('says so, rather than quietly ignoring the number it documents', () => {
    const plan = planQueries(
      profile(),
      filters({
        company: {
          onlyCompanies: Array.from({ length: 10 }, (_, i) => `Company${String(i)}`),
          excludeCompanies: [],
        },
      }),
    );
    expect(plan.targets.length).toBeGreaterThan(40);
    expect(plan.notes.join(' ')).toMatch(/more than the usual cap of 40/);
  });

  it('says nothing when it is inside the cap', () => {
    const plan = planQueries(profile(), filters());
    expect(plan.notes.join(' ')).not.toMatch(/more than the usual cap/);
  });
});

describe('a company name no board slug can be built from', () => {
  /**
   * `slugCandidates` keeps [a-z0-9] and nothing else, so a name in a non-Latin script has
   * no candidates. `slugs[0]!` was `undefined`, the non-null assertion hid it from the type
   * checker, and JSON.stringify dropped the key on the way out — so the plan answered with
   * targets carrying no `board` at all, and the first `.trim()` on the client threw during
   * render. With no error boundary anywhere in the app, the screen went blank.
   */
  it('plans no target for it, and says why', () => {
    const plan = planQueries(
      profile(),
      filters({ company: { onlyCompanies: ['삼성전자'], excludeCompanies: [] } }),
    );
    // Only the boardless defaults remain: no vendor guess was minted for the name.
    expect(plan.targets.filter((t) => t.board !== '')).toEqual([]);
    expect(plan.notes.join(' ')).toMatch(/cannot be guessed/i);
  });

  it('never answers with a target whose board is missing', () => {
    for (const name of ['삼성전자', '字节跳动', 'Co.', '...', '   ']) {
      const plan = planQueries(
        profile(),
        filters({ company: { onlyCompanies: [name], excludeCompanies: [] } }),
      );
      for (const t of plan.targets) {
        expect({ name, board: typeof t.board }).toEqual({ name, board: 'string' });
      }
    }
  });
});

describe('two spellings of one company', () => {
  it('produce one target per board rather than one per spelling', () => {
    // "Stripe" and "Stripe Inc" are two strings to onlyCompanies and one slug to
    // slugCandidates, so each minted its own greenhouse, lever and ashby target. A
    // duplicated target is fetched twice, counted twice in `found`, and filed as a
    // duplicate of itself — and on the Discover screen the two chips collided on their key.
    const plan = planQueries(
      profile(),
      filters({ company: { onlyCompanies: ['Stripe', 'Stripe Inc'], excludeCompanies: [] } }),
    );
    const keys = plan.targets.map((t) => `${t.source}:${t.board}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(plan.targets.filter((t) => t.source === 'greenhouse')).toHaveLength(1);
  });
});

/**
 * The families the user CHOSE, which for the life of the project could not be un-chosen.
 *
 * `inferRoleFamilies` ran unconditionally and the planner ADDED any filter the caller passed
 * to that inference rather than letting it replace one. So a resume that mentions a single
 * coding class minted a software-engineering family, every plan searched for it, and no
 * control anywhere could remove it — while the plan's own note advised "set role families in
 * the filters", which is precisely the thing that did not work.
 */
describe('choosing what you are looking for', () => {
  const coder = () =>
    profile({
      skills: [{ name: 'Python' }],
      experience: [{ title: 'Intern', bullets: ['Wrote software in Python'] }],
    });

  it('infers from the resume when the user has chosen nothing', () => {
    expect(planQueries(coder(), filters()).roleFamilies).toContain('software engineering');
  });

  it('REPLACES the inference rather than adding to it', () => {
    const p = coder();
    p.preferences = { ...p.preferences, roleFamilies: ['journalism'] };
    const plan = planQueries(p, filters());
    expect(plan.roleFamilies).toEqual(['journalism']);
    // The point of the whole change: the inferred family is gone, not merely outvoted.
    expect(plan.roleFamilies).not.toContain('software engineering');
    expect(plan.keywords).not.toContain('software engineering');
  });

  it('says out loud that the resume was not consulted', () => {
    const p = coder();
    p.preferences = { ...p.preferences, roleFamilies: ['journalism'] };
    expect(planQueries(p, filters()).notes.join(' ')).toMatch(/resume was not consulted/i);
  });

  it('lets a per-request filter win over the stored preference', () => {
    // The more recent and more specific statement of the same intent.
    const p = coder();
    p.preferences = { ...p.preferences, roleFamilies: ['journalism'] };
    const plan = planQueries(
      p,
      filters({ role: { roleFamilies: ['finance'], titleIncludes: [], titleExcludes: [] } }),
    );
    expect(plan.roleFamilies).toEqual(['finance']);
  });

  it('does not put a chosen family into the keyword list twice', () => {
    // `filters.role.roleFamilies` used to be concatenated onto roleFamilies a second time.
    const plan = planQueries(
      coder(),
      filters({ role: { roleFamilies: ['finance'], titleIncludes: [], titleExcludes: [] } }),
    );
    expect(plan.keywords.filter((k) => k === 'finance')).toHaveLength(1);
  });

  it('goes back to reading the resume when the choice is cleared', () => {
    const p = coder();
    p.preferences = { ...p.preferences, roleFamilies: [] };
    expect(planQueries(p, filters()).roleFamilies).toContain('software engineering');
  });
});

/**
 * The search cycle, which used to be the year 2027 and never moved.
 *
 * `DEFAULT_FILTERS` states summer 2027 and the planner's own fallback was
 * `new Date().getUTCFullYear() + 1`, so from June 2027 a default run searches a season whose
 * postings closed months earlier and comes back empty, with nothing anywhere saying why —
 * while docs/05 promises "the season and year are ordinary values — nothing in the system
 * hardcodes summer or 2027". Every date below is injected: a test that reads the wall clock
 * to check a date rule is the same bug one level up.
 */
describe('the search cycle follows the calendar', () => {
  const at = (day: string) => new Date(`${day}T12:00:00Z`);

  it('turns a summer over when that summer starts, not at New Year', () => {
    // 2027-01-15 is the case the old fallback got wrong, in the direction that hides jobs:
    // it asked for "summer 2028", a cycle nobody has posted for yet, while summer 2027 was
    // still open and being applied to that week.
    const expected: Array<[string, number]> = [
      ['2026-09-09', 2027],
      ['2026-12-31', 2027],
      ['2027-01-15', 2027],
      ['2027-05-31', 2027],
      ['2027-06-01', 2028],
      ['2027-11-02', 2028],
      ['2028-03-04', 2028],
      ['2029-06-30', 2030],
      ['2031-02-01', 2031],
    ];
    for (const [day, year] of expected) {
      expect({ day, cycle: upcomingCycleYear('summer', at(day)) }).toEqual({ day, cycle: year });
    }
  });

  it('gives each season its own rollover rather than the summer one', () => {
    // Mid-September 2027: fall has started, winter has not, and summer is a year away.
    const sept = at('2027-09-15');
    expect(upcomingCycleYear('fall', sept)).toBe(2028);
    expect(upcomingCycleYear('winter', sept)).toBe(2027);
    expect(upcomingCycleYear('spring', sept)).toBe(2028);
    expect(upcomingCycleYear('summer', sept)).toBe(2028);
    // A season with no window of its own — year_round, flexible — has no rollover of its
    // own either, and follows the summer cycle the product is built around.
    expect(upcomingCycleYear('year_round', sept)).toBe(2028);
    expect(upcomingCycleYear('flexible', at('2027-01-15'))).toBe(2027);
  });

  it('dates a search that names no year from the clock it was given', () => {
    const f = filters({ term: { seasons: ['summer'], years: [] } });
    expect(termTokens(f, at('2027-01-15'))).toEqual(['summer 2027 internship']);
    expect(termTokens(f, at('2027-07-04'))).toEqual(['summer 2028 internship']);
  });

  it('dates each season in the same plan separately', () => {
    // In January the open fall cycle is this year's, and so is summer's.
    const f = filters({ term: { seasons: ['summer', 'fall'], years: [] } });
    expect(termTokens(f, at('2027-01-15'))).toEqual([
      'summer 2027 internship',
      'fall 2027 internship',
    ]);
    // By September fall has begun and rolls over on its own, while winter has not.
    const g = filters({ term: { seasons: ['fall', 'winter'], years: [] } });
    expect(termTokens(g, at('2027-09-15'))).toEqual([
      'fall 2028 internship',
      'winter 2027 internship',
    ]);
  });

  it('never falls back to a year somebody typed once', () => {
    const f = filters({ term: { seasons: ['summer', 'fall'], years: [] } });
    for (const day of ['2029-03-01', '2031-08-20', '2034-06-01']) {
      expect({ day, tokens: termTokens(f, at(day)).join(' ') }).toEqual({
        day,
        tokens: expect.not.stringContaining('2027') as unknown as string,
      });
    }
  });

  it('reads the real clock when no clock is injected', () => {
    // Deliberately not pinned to a year: an assertion about today's date rots by itself,
    // which is how a constant ends up in the code in the first place. Only the shape is pinned.
    const tokens = termTokens(filters({ term: { seasons: ['summer'], years: [] } }));
    const thisYear = new Date().getUTCFullYear();
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatch(
      new RegExp(`^summer (?:${String(thisYear)}|${String(thisYear + 1)}) internship$`),
    );
  });

  it('carries the derived cycle into the plan itself', () => {
    const plan = planQueries(profile(), filters({ term: { seasons: ['summer'], years: [] } }), [], {
      now: at('2030-02-02'),
    });
    expect(plan.termTokens).toEqual(['summer 2030 internship']);
  });

  it('leaves a year the caller did state alone', () => {
    // The plan is meant to be inspectable, so a stated filter is never quietly rewritten —
    // the note below is what a stale one gets instead.
    const plan = planQueries(
      profile(),
      filters({ term: { seasons: ['summer'], years: [2029] } }),
      [],
      { now: at('2031-03-01') },
    );
    expect(plan.termTokens).toEqual(['summer 2029 internship']);
  });
});

/**
 * The other half: a plan can still be POINTED at a closed season, because `term.years` is a
 * stated number and `DEFAULT_FILTERS` states 2027 for everyone who sends no filters — and no
 * screen sends any. Zero results from a season that ended look exactly like zero results from
 * a thin week, so the plan has to say which of the two it is.
 */
describe('a plan pointed at a season that has already begun', () => {
  const at = (day: string) => new Date(`${day}T12:00:00Z`);

  it('says so, instead of searching a closed cycle in silence', () => {
    const notes = planQueries(profile(), filters(), [], { now: at('2027-08-01') }).notes.join(' ');
    expect(notes).toMatch(/already begun: summer 2027/);
    expect(notes).toMatch(/cycle now open is summer 2028/);
  });

  it('says nothing at all while that cycle is still open', () => {
    // The cheap way to pass the test above is to warn on every plan, which would put a false
    // "your search is closed" in front of every student applying on time.
    for (const day of ['2026-09-09', '2027-01-15', '2027-05-31']) {
      const notes = planQueries(profile(), filters(), [], { now: at(day) }).notes.join(' ');
      expect({ day, warned: /already begun/.test(notes) }).toEqual({ day, warned: false });
    }
  });

  it('does not call a cycle closed while one season it asks for is open', () => {
    // Summer 2027 has gone by August; winter 2027 starts in December and is genuinely open.
    const plan = planQueries(
      profile(),
      filters({ term: { seasons: ['summer', 'winter'], years: [2027] } }),
      [],
      { now: at('2027-08-01') },
    );
    expect(plan.notes.join(' ')).not.toMatch(/already begun/);
  });

  it('never calls a year_round search closed, having no season that could have begun', () => {
    const plan = planQueries(
      profile(),
      filters({ term: { seasons: ['year_round'], years: [2027] } }),
      [],
      { now: at('2029-04-01') },
    );
    expect(plan.notes.join(' ')).not.toMatch(/already begun/);
  });

  it('never fires for a search with no year, which follows the clock already', () => {
    const plan = planQueries(profile(), filters({ term: { seasons: ['summer'], years: [] } }), [], {
      now: at('2031-08-01'),
    });
    expect(plan.notes.join(' ')).not.toMatch(/already begun/);
    expect(plan.termTokens).toEqual(['summer 2032 internship']);
  });
});
