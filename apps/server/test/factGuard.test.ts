/**
 * FactGuard adversarial suite — the M5 release gate (docs/11).
 *
 * Every planted fabrication below must be caught. These tests are not here to describe
 * current behaviour; they are here to fail the build if the guard ever stops catching a
 * lie. Do not relax a case to make it pass — fix the guard.
 *
 * The second half matters just as much. A guard that flags honest sentences trains the
 * user to click through warnings, and a warning nobody reads protects nobody.
 */
import { describe, expect, it } from 'vitest';
import type { ConfirmedProfile } from '@ia/shared';
import {
  checkClaimDeterministically,
  extractClaimedSkills,
  extractDurations,
  extractGpas,
  extractProperNouns,
  guardDraft,
  isVerifiableClaim,
  mergeModelVerdicts,
  normalize,
  splitClaims,
} from '../src/core/writing/factGuard';
import { retrieveEvidence } from '../src/core/writing/retrieve';

const NOW = new Date('2026-08-03T00:00:00Z');

/**
 * A real-shaped student profile. Everything the guard is allowed to believe is here;
 * anything else is a fabrication by definition.
 *
 * Deliberate properties: the internship is SHORT (two months), so duration inflation has
 * something to catch; the degree spans years, so an unscoped duration claim has a
 * generous ceiling; the GPA is a specific number.
 */
function fixture(): ConfirmedProfile {
  return {
    id: 'p1',
    fullName: 'Rosa Alvarez',
    pronouns: null,
    email: 'rosa@example.edu',
    dateOfBirth: '2006-03-15',
    address: { country: 'US' },
    links: { other: [] },
    workAuthorization: { country: 'US', status: 'citizen', needsSponsorship: false },
    citizenships: ['US'],
    education: [
      {
        institution: 'Rutgers University',
        level: 'bachelor',
        fieldOfStudy: 'Computer Science',
        startDate: '2024-09',
        endDate: '2028-05',
        gpa: { value: 3.62, scale: 4 },
        coursework: ['Data Structures', 'Computer Architecture'],
        honors: [],
      },
    ],
    experience: [
      {
        organization: 'Kestrel Analytics',
        title: 'Software Engineering Intern',
        type: 'internship',
        startDate: '2026-06',
        endDate: '2026-08',
        bullets: [
          'Built internal tooling that let the support team resolve billing tickets without an engineer',
          'Migrated a nightly batch report from cron to a queue, cutting its failure rate',
        ],
        skills: ['TypeScript', 'PostgreSQL'],
      },
      {
        organization: 'Rutgers Learning Center',
        title: 'Peer Tutor',
        type: 'job',
        startDate: '2025-10',
        bullets: ['Tutored introductory programming students in weekly small-group sessions'],
        skills: ['Python'],
      },
    ],
    projects: [
      {
        name: 'Tidewater',
        description: 'A tide chart for kayakers that works offline',
        bullets: ['Caches a year of predictions so the app is useful with no signal'],
        skills: ['React', 'TypeScript'],
      },
    ],
    skills: [
      { name: 'TypeScript', category: 'language', evidence: [] },
      { name: 'Python', category: 'language', evidence: [] },
      { name: 'PostgreSQL', category: 'tool', evidence: [] },
      { name: 'React', category: 'framework', evidence: [] },
    ],
    certifications: [],
    languages: [],
    availability: { start: '2027-06-01', end: '2027-08-20', flexible: true },
    locationPrefs: {
      base: { city: 'New Brunswick', region: 'NJ', country: 'US' },
      additionalBases: [],
      maxCommuteKm: 50,
      remoteOk: true,
      hybridOk: true,
      relocateTo: [],
    },
    preferences: { companySizes: [], roleFamilies: [], industries: [], excludeCompanies: [] },
    derived: {
      age: 20,
      isMinor: false,
      academicLevel: 'undergrad',
      academicYear: 2,
      expectedGraduation: '2028-05',
      yearsProfessionalExperience: 0.2,
      seniorityBand: 'entry_intern',
    },
    confirmedAt: NOW.toISOString(),
    needsReview: [],
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  } as ConfirmedProfile;
}

const QUESTION = 'Tell us about a time you built something you are proud of.';
const EVIDENCE = retrieveEvidence(fixture(), QUESTION, { limit: 20 });

/** The same student with one field swapped, for cases that need a particular shape. */
const evidenceFor = (patch: Partial<ConfirmedProfile>) =>
  retrieveEvidence({ ...fixture(), ...patch } as ConfirmedProfile, QUESTION, { limit: 20 });

const skilledWith = (names: string[]) =>
  evidenceFor({
    skills: names.map((name) => ({ name, category: 'tool', evidence: [] })),
  } as Partial<ConfirmedProfile>);

const verdictOf = (claim: string): string | null =>
  checkClaimDeterministically(claim, EVIDENCE).verdict;

// ───────────────────────────────────────────────────────────── the gate

describe('adversarial: planted fabrications (release gate)', () => {
  /**
   * The same lie about the same two-month internship, written five ways.
   *
   * Only "for six years" was ever caught. The other four produced no duration claim at all,
   * so the comparison never ran and each came back GREEN with the two-month entry quoted
   * underneath as its proof. Kept together, in the release gate, because the point is that
   * they must all fail: the moment one spelling is cheaper than another, the guard is a
   * formality.
   */
  it('catches an inflated tenure however the number is spelled', () => {
    for (const claim of [
      'I worked at Kestrel Analytics for six years on their billing systems.',
      'I worked at Kestrel Analytics from 2020 to 2026 on their billing systems.',
      'I spent three summers at Kestrel Analytics.',
      'I worked at Kestrel Analytics for a decade.',
      'I interned at Kestrel Analytics for eight semesters.',
    ]) {
      const guard = guardDraft(claim, EVIDENCE);
      expect(guard.blocking.length, claim).toBeGreaterThan(0);
    }
  });

  it('leaves the honest version of each of those alone', () => {
    // The other direction, in the same breath. A two-month summer internship really did run
    // over a summer, and saying so must not cost the student a block.
    for (const claim of [
      'I interned at Kestrel Analytics over the summer.',
      'I spent two months at Kestrel Analytics.',
    ]) {
      expect(guardDraft(claim, EVIDENCE).blocking, claim).toEqual([]);
    }
  });

  it('catches an invented employer', () => {
    const r = checkClaimDeterministically(
      'I spent last summer at Google working on search infrastructure.',
      EVIDENCE,
    );
    expect(r.verdict).toBe('unsupported');
    expect(r.reason).toContain('Google');
  });

  it('catches an invented school', () => {
    expect(verdictOf('I transferred in from Stanford after my first year.')).toBe('unsupported');
  });

  it('catches an inflated duration against the employer it names', () => {
    const r = checkClaimDeterministically(
      'I worked at Kestrel Analytics for two years on their billing systems.',
      EVIDENCE,
    );
    expect(r.verdict).toBe('overstated');
    expect(r.profileRef).toMatch(/^experience\.0/);
    // The message has to say what the profile actually holds, or it is not actionable.
    expect(r.reason).toMatch(/2 months/);
  });

  it('catches an inflated duration with no employer named', () => {
    // Nothing on the profile spans eight years — not even the degree.
    expect(verdictOf('I have been writing code professionally for eight years.')).toBe(
      'overstated',
    );
  });

  it('catches a wrong GPA', () => {
    const r = checkClaimDeterministically('My GPA is 3.9 and I made the dean’s list.', EVIDENCE);
    expect(r.verdict).toBe('unsupported');
    expect(r.reason).toContain('3.62');
  });

  it('catches a wrong GPA written as a fraction', () => {
    expect(verdictOf('I am carrying a 3.95/4.0 while working part time.')).toBe('unsupported');
  });

  it('catches a nonexistent skill', () => {
    const r = checkClaimDeterministically('I built the whole backend in Rust.', EVIDENCE);
    expect(r.verdict).toBe('unsupported');
    expect(r.reason).toContain('Rust');
  });

  it('catches a nonexistent skill behind a softer verb', () => {
    expect(verdictOf('I am proficient with Kubernetes and ship to it weekly.')).toBe('unsupported');
  });

  it('catches an invented project', () => {
    const g = guardDraft(
      'I wrote a distributed key-value store that handles ten thousand writes a second.',
      EVIDENCE,
    );
    expect(g.blocking).toHaveLength(1);
  });

  it('does not let an opinion frame smuggle a fabrication through', () => {
    // Every one of these reads as motivation, and every one asserts something false.
    for (const smuggled of [
      'I would love to bring the Rust experience I gained at Google to your team.',
      'I am excited to build on the two years I spent at Kestrel Analytics.',
      'I am proud of the 3.9 GPA I have maintained.',
    ]) {
      expect(isVerifiableClaim(smuggled), smuggled).toBe(true);
      expect(guardDraft(smuggled, EVIDENCE).blocking.length, smuggled).toBeGreaterThan(0);
    }
  });

  it('blocks a whole draft when any one sentence is fabricated', () => {
    const draft = [
      'I interned at Kestrel Analytics last summer, where I built internal tooling in TypeScript.',
      'The work I am proudest of is Tidewater, a tide chart that caches a year of predictions so it still works with no signal.',
      'Before that I led a team of six at Palantir.',
    ].join(' ');

    const g = guardDraft(draft, EVIDENCE);
    expect(g.blocking).toHaveLength(1);
    expect(g.blocking[0]!.claim).toContain('Palantir');
  });
});

// ───────────────────────────────────────────────── the other failure direction

describe('honest drafts are not flagged', () => {
  it('passes an accurate answer end to end', () => {
    const draft = [
      'I interned at Kestrel Analytics last summer, where I built internal tooling in TypeScript.',
      'The support team had been filing tickets at engineers to get billing questions answered, so I gave them a way to resolve those themselves.',
      'It was not glamorous work. It cut a queue nobody wanted to be on.',
    ].join(' ');

    const g = guardDraft(draft, EVIDENCE);
    expect(g.blocking).toEqual([]);
  });

  it('accepts an honestly rounded duration', () => {
    // June to August is two months on paper; nobody describes it as anything but a summer.
    expect(verdictOf('I worked at Kestrel Analytics for three months over the summer.')).toBeNull();
  });

  it('accepts a correct GPA in either notation', () => {
    expect(verdictOf('I have a 3.62 GPA in computer science.')).toBeNull();
    expect(verdictOf('My GPA is 3.62 out of 4.0.')).toBeNull();
  });

  /**
   * "3.62/4.0 GPA" extracts BOTH numbers — the fraction pattern reads the value, and the
   * number-leading pattern independently matches "4.0 GPA" on the far side of the slash.
   * Comparing every extracted number against the value alone made the scale impossible to
   * satisfy, so the most natural phrasing produced a blocking "the draft says GPA 4" on a
   * sentence quoting the profile exactly.
   */
  it('does not read the scale in "3.62/4.0 GPA" as a second claimed GPA', () => {
    expect(verdictOf('I graduated with a 3.62/4.0 GPA.')).toBeNull();
    expect(verdictOf('I hold a 3.62 / 4.0 GPA in computer science.')).toBeNull();
  });

  it('still catches a wrong GPA written the same way', () => {
    const r = checkClaimDeterministically('I graduated with a 3.95/4.0 GPA.', EVIDENCE);
    expect(r?.verdict).toBe('unsupported');
  });

  it('accepts skills the profile holds', () => {
    expect(
      verdictOf('I built Tidewater in React and shipped it to a handful of friends.'),
    ).toBeNull();
    expect(verdictOf('Most of my day at Kestrel Analytics was spent in PostgreSQL.')).toBeNull();
  });

  it('does not measure a duration that is not about the writer working', () => {
    // Reading about a company for years is not a claim about employment.
    expect(verdictOf('I have been following Kestrel Analytics for four years.')).toBeNull();
  });

  it('does not treat months, seasons, or sentence openers as employers', () => {
    for (const line of [
      'Last summer I finally understood why indexes matter.',
      'During my second year I started tutoring.',
      'Working on that report taught me more than the course did.',
      'The Learning Center gave me my first teaching experience.',
    ]) {
      expect(verdictOf(line), line).toBeNull();
    }
  });

  it('skips motivation sentences instead of flagging them', () => {
    const draft =
      'I would like to spend a summer on developer tooling. Honestly, I am drawn to the unglamorous parts.';
    const g = guardDraft(draft, EVIDENCE);
    expect(g.claims).toEqual([]);
    expect(g.blocking).toEqual([]);
  });
});

// ────────────────────────────────────────────────────── names that are not employers

describe('a bare acronym is not an invented employer', () => {
  /**
   * Every line here is true, ordinary, and the sort of thing any engineer writes about
   * their own work. Each one used to come back blocking at G3 — `"CSV" does not appear
   * anywhere on your profile` about a file format, `"HTTP"` about a protocol — on the one
   * screen with no override, where the only remedy offered is to add the fact to a
   * profile that has no field for it.
   */
  it('leaves technology named in passing alone', () => {
    for (const line of [
      'The HTTP layer was the easy part.',
      'It replaced a CSV export that three people maintained by hand.',
      'The CSS on that page was awful.',
      'I deployed it to AWS one Friday afternoon.',
      'The SQL was the slowest thing in the request.',
      'I rewrote the HTML by hand because the generator kept mangling it.',
      'Our CI kept timing out on the same test.',
      'The ML side of it was mostly reading papers.',
      'I wrote a REST API for the billing service.',
      'The JSON payload was three megabytes.',
    ]) {
      expect(verdictOf(line), line).toBeNull();
    }
  });

  // The other half. IBM and NASA are employers as surely as CSV is a file format, and the
  // only thing that separates them is what the sentence says the writer did there.
  it('still catches an acronym the writer claims to have worked at', () => {
    for (const line of [
      'I interned at IBM last summer.',
      'I worked at NASA on flight software.',
      'I spent two summers at SAP.',
      'I studied at MIT before transferring.',
    ]) {
      expect(verdictOf(line), line).toBe('unsupported');
    }
  });

  it('does not exempt a name with an ordinary word beside it', () => {
    expect(verdictOf('I built the ingest layer at IBM Research last summer.')).toBe('unsupported');
  });

  /**
   * "I did/had/completed an internship at NASA" is an employment claim about an all-caps
   * name written the plainest way there is, and every one used to slip the affiliation frame
   * — which only listed employment verbs — and ride through unchecked. The stint noun now
   * carries the claim, so the frame catches it without treating "I had trouble with SQL" as
   * a job at SQL.
   */
  it('catches an acronym employer named through a stint noun, not just a verb', () => {
    for (const line of [
      'I did an internship at NASA working on flight software.',
      'I had an internship at NASA last summer.',
      'I completed an internship at IBM.',
      'I finished the apprenticeship at SAP.',
    ]) {
      expect(verdictOf(line), line).toBe('unsupported');
    }
  });

  it('does not read an ordinary "had ... with" as employment at a technology', () => {
    // The stint-noun branch must not fire on these; SQL and CSV are not employers here.
    for (const line of [
      'I had a great time at MITRE that week.',
      'I had trouble with the CSV parser.',
    ]) {
      expect(verdictOf(line), line).toBeNull();
    }
  });
});

describe('a short name on the profile does not vouch for an invented employer', () => {
  const MIT = evidenceFor({ education: [{ ...fixture().education[0]!, institution: 'MIT' }] });

  /**
   * "smith barney" contains "mit". Matching by bare characters meant the fabrication came
   * back with no verdict at all, and inside a sentence carrying any ordinary amount of
   * profile content it came back green — worse than a missed flag, because a green tick
   * is what tells the user at G3 that there is nothing left to check.
   */
  it('rejects an invented employer whose letters swallow a known one', () => {
    for (const line of [
      'I interned at Smith Barney last summer.',
      'I interned at Summit Consulting last summer.',
    ]) {
      expect(checkClaimDeterministically(line, MIT).verdict, line).toBe('unsupported');
    }
  });

  it('gives the same sentence the same answer whichever employer it invents', () => {
    const sentence = (employer: string): string =>
      `Last summer at ${employer} I built a tide chart that works offline because kayakers have no signal.`;
    for (const employer of ['Smith Barney', 'Goldman Sachs']) {
      expect(guardDraft(sentence(employer), MIT).blocking.length, employer).toBe(1);
    }
  });

  it("still accepts the profile's own name, shortened or extended", () => {
    expect(checkClaimDeterministically('I study computer science at MIT.', MIT).verdict).toBeNull();
    expect(
      checkClaimDeterministically('I ran the study at the MIT Media Lab.', MIT).verdict,
    ).toBeNull();
    expect(verdictOf('The Learning Center gave me my first teaching experience.')).toBeNull();
  });
});

describe('a plural on the profile supports the singular in the draft', () => {
  /**
   * The profile said "Design Patterns" and the draft said "Design Pattern", so the user
   * was blocked at G3 by a message saying the term does not appear anywhere on their
   * profile. It did, one letter away. The remedy the message offers — add the fact — had
   * already been done, and nothing on that screen said the plural was the whole problem.
   */
  it('does not call a term missing over one letter', () => {
    expect(
      checkClaimDeterministically(
        'The Design Pattern I leaned on was the outbox.',
        skilledWith(['Design Patterns', 'Python']),
      ).verdict,
    ).toBeNull();

    expect(
      checkClaimDeterministically(
        'The Design Patterns I leaned on saved me twice.',
        skilledWith(['Design Pattern', 'Python']),
      ).verdict,
    ).toBeNull();
  });

  it('still catches a term that really is absent', () => {
    const r = checkClaimDeterministically(
      'The Design Paradigm I leaned on was the outbox.',
      skilledWith(['Design Patterns', 'Python']),
    );
    expect(r.verdict).toBe('unsupported');
    expect(r.reason).toContain('Design Paradigm');
  });
});

// ───────────────────────────────────────────────────────────── the pieces

describe('duration extraction', () => {
  it('reads digits and words in every unit', () => {
    expect(extractDurations('for two years')[0]!.months).toBe(24);
    expect(extractDurations('over 18 months')[0]!.months).toBe(18);
    expect(extractDurations('a three-month internship')[0]!.months).toBe(3);
    expect(extractDurations('10 weeks')[0]!.months).toBeCloseTo(2.3, 1);
  });

  /**
   * THE SPELLINGS THAT PRODUCED NO CLAIM AT ALL, AND SO WERE NEVER CHECKED.
   *
   * A number immediately followed by year/month/week was the only shape this saw, and no
   * DurationClaim means the duration comparison is skipped in silence. Against the fixture's
   * two-month Kestrel Analytics internship, "I spent three summers at Kestrel Analytics",
   * "for a decade" and "from 2020 to 2026" all came back GREEN with that two-month entry
   * printed underneath as the evidence, while the identical claim written "for six years"
   * was correctly blocked. A guard anyone can walk around by writing the number a different
   * way is not guarding.
   */
  it('reads a tenure written as a magnitude rather than a count', () => {
    expect(extractDurations('for a decade')[0]!.months).toBe(120);
    expect(extractDurations('three summers')[0]!.months).toBe(6);
    expect(extractDurations('8 semesters')[0]!.months).toBe(32);
    expect(extractDurations('two school years')[0]!.months).toBe(18);
  });

  it('reads a tenure written as the years it ran between', () => {
    expect(extractDurations('from 2020 to 2026')[0]!.months).toBe(60);
    expect(extractDurations('2019-2026')[0]!.months).toBe(72);
  });

  /**
   * The half that keeps this from becoming a false RED.
   *
   * Bare years say nothing about months: a student really on the team from the autumn of
   * 2024 to the spring of 2026 — twenty months — writes "from 2024 to 2026", and reading
   * that as a full twenty-four would block a true sentence at a gate with no override. One
   * whole year comes off the difference so no true span is ever measured as longer than it
   * was, and "2020 to 2026" is still sixty months.
   */
  it('reads a year range as the shortest span those years allow', () => {
    expect(extractDurations('from 2024 to 2026')[0]!.months).toBe(12);
    expect(extractDurations('from 2025 to 2026')[0]!.months).toBe(1);
  });

  it('still refuses to read an age as a tenure', () => {
    // The pre-existing rule, re-asserted because the new patterns run over the same text.
    expect(extractDurations("I'm 19 years old and have been coding since high school")).toEqual([]);
  });

  it('ignores vague quantities rather than guessing a number', () => {
    expect(extractDurations('several years of experience')).toEqual([]);
    expect(extractDurations('many months later')).toEqual([]);
  });

  /**
   * "2.5 years" used to match at the word boundary between the dot and the 5, so a half
   * was read as a whole and the guard measured five years against a thirty-month job.
   * Half-years are how students describe their own time; every one of them was wrong.
   */
  it('reads a decimal and its fraction as one count, not two', () => {
    expect(extractDurations('for 2.5 years')[0]!.months).toBe(30);
    expect(extractDurations('for 1.5 years')[0]!.months).toBe(18);
    expect(extractDurations('about 3.5 months of work')[0]!.months).toBeCloseTo(3.5, 2);
    expect(extractDurations('over 20.5 years')[0]!.months).toBe(246);
    expect(extractDurations('a 2.5-year stint')[0]!.months).toBe(30);
    // And the raw text is the whole number, since it is quoted back to the user.
    expect(extractDurations('for 2.5 years')[0]!.raw).toContain('2.5');
  });
});

describe('service verbs are durations too', () => {
  /**
   * The duration gate once held only office and engineering verbs, so "I volunteered /
   * tutored / served there for five years" — how a clubs-and-activities resume states
   * tenure — was never measured at all. And the unscoped ceiling pool included the
   * education entry, so every young applicant's four-year school span silently vouched
   * for invented work tenure. Work claims now measure against work.
   */
  it('measures a service-verb duration against the entry it names', () => {
    expect(verdictOf('I have volunteered at Kestrel Analytics for two years.')).toBe('overstated');
    expect(verdictOf('I tutored at Kestrel Analytics for two years.')).toBe('overstated');
  });

  it('does not let the degree span vouch for an unscoped work claim', () => {
    // The degree runs 44 months; the longest job is far shorter. Ten claimed years of
    // WORK must be measured against work.
    expect(verdictOf('I have worked as a barista for ten years.')).toBe('overstated');
  });

  it('still lets the degree bound a practice claim about schooling and craft', () => {
    // "Writing code for 2.5 years" is not tenure at any employer; the degree span is
    // the honest, generous ceiling it has always had.
    expect(verdictOf('I have been writing code for 2.5 years.')).toBeNull();
  });
});

describe('a spelled-out state and its abbreviation are one place', () => {
  it('accepts the home state written out when the profile abbreviates it', () => {
    // The identity line prints "New Brunswick, NJ"; essays write "New Jersey".
    expect(guardDraft('I live in New Brunswick, New Jersey.', EVIDENCE).blocking).toEqual([]);
  });

  it('still blocks a state the profile does not hold', () => {
    expect(verdictOf('I grew up in Ohio before moving east.')).toBe('unsupported');
  });
});

describe('half-years are not read as whole ones', () => {
  // Nothing on this profile is longer than the degree, at 44 months.
  it('does not flag an honest half-year', () => {
    expect(verdictOf('I have been writing code for 2.5 years.')).toBeNull();
    expect(verdictOf('I have been writing code for 3.5 years.')).toBeNull();
  });

  it('still catches an inflated one', () => {
    expect(verdictOf('I have been writing code professionally for 8.5 years.')).toBe('overstated');
    // 10.2 read as "2 years" sat under the ceiling and was waved through.
    expect(verdictOf('I have been writing code professionally for 10.2 years.')).toBe('overstated');
  });

  /**
   * The message quotes the draft back at the user so they can find the sentence. When the
   * fraction was dropped it quoted "5 years" at someone who had written "2.5 years", and
   * G3 has no override — they were told to fix a phrase that was not in their draft.
   */
  it('quotes a phrase that is actually in the draft', () => {
    const draft = 'I have been writing code professionally for 8.5 years.';
    const r = checkClaimDeterministically(draft, EVIDENCE);
    const quoted = /"([^"]+)"/.exec(r.reason ?? '')?.[1];
    expect(quoted).toBeTruthy();
    expect(draft).toContain(quoted);
  });
});

describe('GPA extraction', () => {
  it('reads the common notations', () => {
    expect(extractGpas('GPA: 3.62')).toEqual([3.62]);
    expect(extractGpas('my GPA is a 3.9')).toEqual([3.9]);
    expect(extractGpas('3.45/4.0')).toEqual([3.45]);
    expect(extractGpas('3.45 out of 4')).toEqual([3.45]);
  });

  it('does not read arbitrary decimals as grades', () => {
    expect(extractGpas('cut latency to 1.4 seconds')).toEqual([]);
  });

  /**
   * Transcripts print three decimals, and a rising freshman quoting one exactly is the most
   * honest thing this guard sees. The scale-mask capped its numerator at two decimals while
   * the number-leading pattern read three, so "3.968/4.0" slipped the mask and the guard
   * read the SCALE on the far side of the slash — 4 — as a second claimed GPA. Every one of
   * these must return the numerator the student wrote, never the denominator.
   */
  it('reads a three-decimal GPA and never the scale beside it', () => {
    expect(extractGpas('I graduated with a 3.968/4.0 GPA.')).toEqual([3.968]);
    expect(extractGpas('I earned a 3.968 out of 4.0 GPA.')).toEqual([3.968]);
    expect(extractGpas('I hold a 4.321/5.0 weighted GPA.')).toEqual([4.321]);
    expect(extractGpas('I have a 3.968 GPA on a 4.000 scale.')).toEqual([3.968]);
    expect(extractGpas('I earned a 3.968/4 GPA')).toEqual([3.968]);
    // Two-decimal forms still read exactly as before.
    expect(extractGpas('3.62/4.0 GPA')).toEqual([3.62]);
  });
});

/**
 * A rising freshman with a three-decimal, weighted GPA — the shape the whole dossier flow
 * was built around, and the one the scale-mask regression blocked.
 */
const gpaEvidenceFor = (gpa: { value: number; scale: number; weighted?: number }) =>
  evidenceFor({
    education: [{ ...fixture().education[0]!, gpa }],
  } as Partial<ConfirmedProfile>);

describe('a true three-decimal GPA is not blocked, and its scale is never quoted back', () => {
  const EV = gpaEvidenceFor({ value: 3.968, scale: 4, weighted: 4.321 });

  it('passes the exact figure in every notation', () => {
    for (const line of [
      'I graduated with a 3.968/4.0 GPA.',
      'I earned a 3.968 out of 4.0 GPA.',
      'I have a 3.968 GPA on a 4.000 scale.',
      // The weighted figure the profile also holds is a true number about the same student.
      'I hold a 4.321/5.0 weighted GPA.',
      'I have a 3.968/4.0 GPA and a 4.321 weighted GPA.',
    ]) {
      expect(checkClaimDeterministically(line, EV).verdict, line).toBeNull();
    }
  });

  it('still catches a fabricated GPA at three decimals', () => {
    expect(checkClaimDeterministically('I graduated with a 3.100/4.0 GPA.', EV).verdict).toBe(
      'unsupported',
    );
  });

  it('names the weighted figure in the mismatch reason instead of only the lower one', () => {
    const r = checkClaimDeterministically('I have a 4.5 weighted GPA.', EV);
    expect(r.verdict).toBe('unsupported');
    // The message must not steer the student to discard their true, higher weighted number.
    expect(r.reason).toContain('4.321 weighted');
    expect(r.reason).toContain('3.968');
  });
});

describe('a name whose punctuation leaves a lone letter stays checkable', () => {
  /**
   * A blanket lone-"s" strip in `normalize` collapsed "S&P" to a single "p", dropped it
   * below the checkable length, and a FABRICATED "S&P" employer sailed past with a green
   * tick — the worst thing this file can produce. These names must survive normalisation as
   * multi-character, checkable tokens.
   */
  it('keeps ampersand and hyphen names long enough to check', () => {
    for (const raw of ['S&P', 'AT&T', 'H-E-B', 'M&S']) {
      expect(normalize(raw).length, raw).toBeGreaterThan(1);
    }
  });

  it('catches a fabricated S&P employer that the profile never held', () => {
    const g = guardDraft(
      'While a Counselor at Camp Redwood I also interned at S&P using Python and Excel.',
      evidenceFor({
        experience: [
          {
            organization: 'Camp Redwood',
            title: 'Counselor',
            type: 'job',
            startDate: '2025-06',
            endDate: '2025-08',
            bullets: ['Led activities'],
            skills: ['Python'],
          },
        ],
      } as Partial<ConfirmedProfile>),
    );
    expect(g.blocking).toHaveLength(1);
    expect(g.blocking[0]!.claim).toContain('S&P');
  });

  it('still folds a possessive so a shorter award matches a longer one', () => {
    // Removing the lone-"s" strip must not reopen the "Dean's List" false-block: the short
    // form has to remain a whole-word prefix of the long form.
    expect(normalize('Dean’s List Semi-Finalist').startsWith(normalize("Dean's List"))).toBe(true);
  });
});

describe('a possessive award reads the same with or without its apostrophe', () => {
  /**
   * Extraction may keep or drop the apostrophe in "Dean's List" depending on the resume,
   * and the drafting model may write it either way. When one side wrote "Deans List" and the
   * other "Dean's List" the two forms of the student's own honor no longer vouched for each
   * other, and a true award was blocked at G3 as an invented name — one apostrophe away.
   */
  const apos = evidenceFor({
    education: [{ ...fixture().education[0]!, honors: ["Dean's List Semi-Finalist"] }],
  } as Partial<ConfirmedProfile>);
  const plain = evidenceFor({
    education: [{ ...fixture().education[0]!, honors: ['Deans List Semi-Finalist'] }],
  } as Partial<ConfirmedProfile>);

  it('does not block whichever apostrophe form each side happens to use', () => {
    expect(
      checkClaimDeterministically('I made the Deans List that year.', apos).verdict,
    ).toBeNull();
    expect(
      checkClaimDeterministically("I made the Dean's List that year.", plain).verdict,
    ).toBeNull();
    expect(
      checkClaimDeterministically("I made the Dean's List that year.", apos).verdict,
    ).toBeNull();
    expect(
      checkClaimDeterministically('I made the Deans List that year.', plain).verdict,
    ).toBeNull();
  });

  it('still blocks an award the profile does not hold', () => {
    expect(checkClaimDeterministically("I made the Provost's List that year.", apos).verdict).toBe(
      'unsupported',
    );
  });
});

/**
 * The awards-and-activities resume, which is what a rising sophomore actually has. A
 * profile like this is mostly honors and clubs and almost no employment, and each case
 * below is a way that shape broke the guard in both directions at once.
 */
describe('honors carry a rank, and an organisation is not an employer', () => {
  const awards = evidenceFor({
    education: [
      {
        ...fixture().education[0]!,
        honors: [
          'Future Business Leaders of America State Finalist',
          'NSPA Feature Story of the Year Honorable Mention',
          'Math League Champion',
        ],
      },
    ],
  } as Partial<ConfirmedProfile>);

  it('an award does not vouch for a job at the organisation that gave it', () => {
    // Winning an FBLA event puts "Future Business Leaders of America" on the profile, and
    // its initialism is FBLA — so an internship the student never held was green.
    //
    // Every employment frame, not only the one that was reported. The first version listed
    // the prepositions at|for|with with the name immediately after, and required an "I" or
    // "we" before the verb, so "employed BY", "at THE Courier" and the passive-agent order
    // "FBLA employed me" each escaped the rule entirely.
    for (const claim of [
      'I had an internship at FBLA.',
      'I was an intern at FBLA last summer.',
      'I joined the staff at FBLA last summer.',
      'My role at FBLA was to run the front desk.',
      'I work for FBLA on weekends.',
      'I was employed by FBLA last summer.',
      'I got a job at FBLA last summer.',
      'FBLA employed me for the whole summer.',
      'FBLA hired me for the whole summer.',
    ]) {
      expect(checkClaimDeterministically(claim, awards).verdict, claim).toBe('unsupported');
    }
    expect(checkClaimDeterministically('I competed at FBLA in the spring.', awards).verdict).toBe(
      null,
    );
  });

  it('a placing may not be written up as a win', () => {
    const det = checkClaimDeterministically(
      'I won the NSPA Feature Story of the Year award.',
      awards,
    );
    expect(det.verdict).toBe('overstated');
    expect(det.quote).toBe('NSPA Feature Story of the Year Honorable Mention');
  });

  it('the same award stated at its real rank is fine, however it is shortened', () => {
    expect(
      checkClaimDeterministically('I received an NSPA Honorable Mention.', awards).verdict,
    ).toBeNull();
    expect(checkClaimDeterministically('I was an FBLA State Finalist.', awards).verdict).toBeNull();
    // An honorable mention IS an award and IS received. Nothing here is overstated.
    expect(
      checkClaimDeterministically('I received an award from NSPA that year.', awards).verdict,
    ).toBeNull();
  });

  it('a real win survives the -ship the student writes it with', () => {
    expect(
      checkClaimDeterministically('I won the Math League Championship.', awards).verdict,
    ).toBeNull();
  });

  /**
   * THE WAYS OF CLAIMING FIRST WITHOUT THE WORD "FIRST".
   *
   * The win check fired for four fixed phrasings — won / first place / took first / champion
   * of — so a student the profile records below first could claim the whole thing in any
   * other words and come back GREEN with their own honorable mention quoted underneath as
   * the proof. That is a fabricated win, carrying the profile's own evidence, on its way to
   * an employer.
   *
   * The second block is the half that keeps this honest. Every one of those sentences can be
   * literally true of somebody who placed below first, and G3 has no override, so a guard
   * that reaches them costs the student a true sentence they cannot get back.
   */
  it('catches an outright win claimed in words other than "first"', () => {
    for (const claim of [
      'I swept the NSPA Feature Story of the Year award.',
      'I topped the NSPA Feature Story of the Year award.',
      'I came out on top at the NSPA Feature Story of the Year award.',
      'I was the top finisher at the NSPA Feature Story of the Year award.',
      'I beat everyone at the NSPA Feature Story of the Year award.',
      'I was the best at the NSPA Feature Story of the Year award.',
    ]) {
      expect(checkClaimDeterministically(claim, awards).verdict, claim).toBe('overstated');
    }
  });

  it('does not reach a sentence that claims no placing at all', () => {
    for (const claim of [
      // A third placing really can be the best in one school.
      'I was the top finisher from my school at the NSPA Feature Story of the Year award.',
      // What is topped here is a personal best, not the field.
      'I topped my personal best at the NSPA Feature Story of the Year award.',
      'I did my best at the NSPA Feature Story of the Year award.',
      'I learned the most at the NSPA Feature Story of the Year award.',
    ]) {
      expect(checkClaimDeterministically(claim, awards).verdict, claim).toBeNull();
    }
  });

  /**
   * Every rank below first, not just the one that was reported. An honorable mention was
   * the example that found this; a profile reading "Second Place" was diminished by none of
   * the words the first fix added, so the identical false green survived one step further up
   * the podium.
   */
  const withHonor = (honor: string) =>
    evidenceFor({
      education: [{ ...fixture().education[0]!, honors: [honor] }],
    } as Partial<ConfirmedProfile>);

  it('sees every placing below first, however the profile spells it', () => {
    for (const honor of [
      'State Science Olympiad Second Place',
      'State Science Olympiad 3rd Place',
      'State Science Olympiad Top 10',
      'State Science Olympiad Silver Medal',
      'State Science Olympiad Semifinalist',
      'State Science Olympiad Regional Qualifier',
      // Spellings the first version could not see. Every honor-side test runs against
      // `normalize`d text, and normalize turns the hyphen into a space — so `runner-?up`
      // never matched the "runner up" it was given, and the commonest placing after second
      // place was silently dead. The ordinals stopped at fifth and "top N" at digits.
      'State Science Olympiad Runner-Up',
      'State Science Olympiad Runner Up',
      'State Science Olympiad Semi-Finalist',
      'State Science Olympiad Sixth Place',
      'State Science Olympiad Ninth Place',
      'State Science Olympiad Twelfth Place',
      'State Science Olympiad 14th Place',
      'State Science Olympiad Top Ten',
      'State Science Olympiad Bronze Medalist',
    ]) {
      expect(
        checkClaimDeterministically('I won the State Science Olympiad.', withHonor(honor)).verdict,
        honor,
      ).toBe('overstated');
    }
  });

  it('a first place is the win and is never read as short of one', () => {
    for (const honor of [
      'State Science Olympiad First Place',
      'State Science Olympiad 1st Place',
      'State Science Olympiad Champion',
      // One honor line carries two facts, because extraction copies honors verbatim and
      // that is how a results sheet is written. Reading the whole line as a placing on the
      // strength of "Qualifier" alone told a student who WON that their own sentence
      // overstated it, with no override and with the remedy already satisfied.
      'State Science Olympiad First Place, National Qualifier',
      'State Science Olympiad Championship Winner and State Qualifier',
      'State Science Olympiad 1st Place Anatomy, 4th Place Disease Detectives',
    ]) {
      expect(
        checkClaimDeterministically('I won the State Science Olympiad.', withHonor(honor)).verdict,
        honor,
      ).toBeNull();
    }
  });

  /**
   * The win language has to GOVERN the name, not merely share a sentence with it. Honors are
   * conventionally written "<Organisation> <Rank>", so before this, naming the club in any
   * sentence using "won" in its everyday transitive sense was hard-blocked at G3 with "say it
   * the way the profile does" — advice about an honor the sentence was not discussing.
   */
  it('ordinary idiom is not a claim to have won an award', () => {
    const ev = withHonor('Sample Speech Team Regional Finalist');
    for (const claim of [
      'I won a spot on the Sample Speech Team after two rounds of tryouts.',
      'I won the Sample Speech Team over with one argument about school lunches.',
      'I won two of my four Sample Speech Team rounds that weekend.',
      'What I love about the Sample Speech Team is that the best argument wins.',
      'The Sample Speech Team was the best in the district that year.',
      'Our Sample Speech Team won the judges over in the final round.',
    ]) {
      expect(checkClaimDeterministically(claim, ev).verdict, claim).toBeNull();
    }
  });

  /**
   * Nearly every competition a young applicant enters is NAMED a Championship, and the bare
   * word fired on the event's name rather than on any claim. A student writing the strictly
   * more modest truth was told they had overstated it.
   */
  it('an honest hedge is not an overstatement, whatever the event is called', () => {
    const ev = withHonor('ProStart Invitational, California State Championship, 2nd Place (2025)');
    for (const claim of [
      'I placed 2nd at the ProStart Invitational California State Championship.',
      'I placed second at the ProStart Invitational California State Championship.',
      'I came in 2nd at the ProStart Invitational California State Championship.',
      'I finished 2nd in the ProStart Invitational California State Championship.',
      'My team placed 2nd at the ProStart Invitational California State Championship.',
    ]) {
      expect(checkClaimDeterministically(claim, ev).verdict, claim).toBeNull();
    }
  });

  it('a certification is measured against its own date, not against a job', () => {
    // "certified" sat in the employment vocabulary, so a true sentence about a CPR card was
    // measured against the longest job on the profile — two months — and blocked at G3.
    const dated = evidenceFor({
      certifications: [
        { name: 'CPR Certification', issuer: 'American Red Cross', date: '2023-01' },
      ],
    } as Partial<ConfirmedProfile>);
    expect(
      checkClaimDeterministically('I have been CPR certified for three years.', dated).verdict,
    ).toBeNull();
    expect(
      checkClaimDeterministically('I have been CPR certified for eleven years.', dated).verdict,
    ).toBe('overstated');
  });

  it('an undated credential bounds nothing, so it blocks nothing', () => {
    // Undated is not the same as false. The entry the sentence is about is right there with
    // no date on it; measuring it against the longest OTHER entry answers a different
    // question, and answers it wrongly.
    const undated = evidenceFor({
      certifications: [{ name: 'CPR Certification', issuer: 'American Red Cross' }],
    } as Partial<ConfirmedProfile>);
    expect(
      checkClaimDeterministically('I have been CPR certified for three years.', undated).verdict,
    ).toBeNull();

    // Naming no certification at all still falls back to the profile-wide ceiling.
    expect(
      checkClaimDeterministically('I have been licensed for eleven years.', undated).verdict,
    ).toBe('overstated');
  });
});

/**
 * The clubs-and-titles resume states tenure with no verb but the copula, and a name rather
 * than a job description. Every case here was a green tick on a sentence the profile
 * contradicts, or a red on one it supports.
 */
describe('a title, an organisation, and a span', () => {
  const captain = evidenceFor({
    experience: [
      {
        organization: 'Sample Prairie Esports Club',
        title: 'Team Captain',
        type: 'club',
        startDate: '2025-08',
        bullets: [],
        skills: [],
      },
    ],
  } as Partial<ConfirmedProfile>);

  it('measures a tenure claim that names a title and uses only the copula', () => {
    // WORK_CONTEXT and PRACTICE_CONTEXT are lists of VERBS, and this shape has none. The
    // duration was extracted, then discarded unread, and the sentence scored well lexically
    // against the very entry that contradicts it — green, with a twelve-month entry quoted
    // underneath as its proof.
    for (const claim of [
      'I have been the Team Captain of the Sample Prairie Esports Club for six years.',
      'I was the Team Captain of the Sample Prairie Esports Club for six years.',
      'I have been at the Sample Prairie Esports Club for six years.',
    ]) {
      expect(checkClaimDeterministically(claim, captain).verdict, claim).toBe('overstated');
    }
  });

  it('leaves the honest span, and admiration, alone', () => {
    expect(
      checkClaimDeterministically(
        'I have been the Team Captain of the Sample Prairie Esports Club for a year.',
        captain,
      ).verdict,
    ).toBeNull();
    // Naming an entry and a span while claiming no tenure there at all.
    expect(
      checkClaimDeterministically(
        'I have followed the Sample Prairie Esports Club for six years.',
        captain,
      ).verdict,
    ).toBeNull();
  });

  /**
   * Putting the profile's languages into the evidence set closed a real false red — "I am
   * conversational in Spanish" was blocked at G3 as an invented name — but it also handed the
   * lexical layer the token "spanish", and that alone was enough to green-tick a sentence
   * claiming more than the profile records, with the quieter line quoted as its proof. Amber,
   * never red: the ladder is not precise enough to block, and blocking a true sentence where
   * there is no override is the worse error.
   */
  it('does not green-tick a language claimed above the level the profile records', () => {
    const speaks = evidenceFor({
      languages: [{ name: 'Spanish', proficiency: 'Conversational' }],
    } as Partial<ConfirmedProfile>);

    for (const claim of [
      'My Spanish is fluent.',
      'My Spanish is native.',
      'I am fluent in Spanish.',
      'I am a native Spanish speaker.',
      'I tutor Spanish grammar to freshmen.',
      'I teach Spanish to elementary students.',
      'I can interpret Spanish for patients.',
    ]) {
      const g = guardDraft(claim, speaks);
      expect(g.claims[0]?.verdict, claim).toBe('inferred');
      expect(g.blocking, claim).toEqual([]);
    }

    // At or below the recorded level is a true sentence and stays clean.
    for (const claim of ['I am conversational in Spanish.', 'I speak some Spanish.']) {
      expect(guardDraft(claim, speaks).claims[0]?.verdict, claim).toBe('supported');
    }

    // A language the profile does not hold at all is still a fabrication.
    expect(guardDraft('I am fluent in Mandarin.', speaks).blocking).toHaveLength(1);
  });

  it('scopes an office to its entry even when the whole phrase reads as one name', () => {
    // A masthead whose own name begins with a capital "The" makes "Editor-in-Chief of The
    // Sample Sentinel" a single capitalised run — longer than the title and longer than the
    // organisation, so it matched neither, scoped to nothing, and escaped the duration check
    // entirely. Nine years against an eleven-month post came back green.
    const paper = evidenceFor({
      experience: [
        {
          organization: 'The Sample Sentinel',
          title: 'Editor-in-Chief',
          type: 'club',
          startDate: '2025-09',
          bullets: [],
          skills: [],
        },
      ],
    } as Partial<ConfirmedProfile>);

    expect(
      checkClaimDeterministically(
        'I have been Editor-in-Chief of The Sample Sentinel for nine years.',
        paper,
      ).verdict,
    ).toBe('overstated');
    expect(
      checkClaimDeterministically(
        'I have been Editor-in-Chief of The Sample Sentinel since last September.',
        paper,
      ).verdict,
    ).toBeNull();
  });

  /**
   * A young applicant's bullets are full of OTHER people's organisations: the newspaper on
   * the route, the food bank a church group drove donations to, the hospital a Scout troop
   * served. Each one silently authorised a fabricated job there.
   */
  it("a mention inside somebody else's bullet does not vouch for a job", () => {
    const route = evidenceFor({
      experience: [
        {
          organization: 'Self-employed',
          title: 'Lawn Care and Paper Route',
          type: 'freelance',
          startDate: '2024-06',
          bullets: [
            'Mow lawns for fourteen households and deliver the Plano Star Courier on weekends',
          ],
          skills: [],
        },
      ],
    } as Partial<ConfirmedProfile>);

    for (const claim of [
      'I interned at the Plano Star Courier for two years.',
      'I worked at the Plano Star Courier last summer.',
      'I did an internship at the Plano Star Courier.',
      'I was employed by the Plano Star Courier last summer.',
      'The Plano Star Courier hired me in June.',
    ]) {
      expect(checkClaimDeterministically(claim, route).verdict, claim).toBe('unsupported');
    }

    // Naming the place is still free. Only the claim of a job there is not.
    for (const claim of [
      'I delivered the Plano Star Courier every Saturday morning.',
      'The Plano Star Courier taught me to be somewhere on time.',
    ]) {
      expect(checkClaimDeterministically(claim, route).verdict, claim).toBeNull();
    }
  });

  /**
   * Once an employment frame stops free prose from vouching, every word in that frame's
   * vocabulary has to BE a verb. "study" is a noun as often as one, and it sits right in
   * front of a preposition belonging to something else — so a true sentence quoting the
   * student's own bullet came back blocking at G3, where there is no override.
   */
  it('reads "study guide for X" as a guide, not as a job at X', () => {
    const olympiad = evidenceFor({
      experience: [
        {
          organization: 'Ferndale High School Science Olympiad',
          title: 'Science Olympiad Captain',
          type: 'club',
          startDate: '2024-08',
          bullets: ['Wrote the Ferndale study guide for Disease Detectives'],
          skills: [],
        },
      ],
    } as Partial<ConfirmedProfile>);

    for (const claim of [
      'I wrote the Ferndale study guide for Disease Detectives.',
      'I wrote the study guide for Disease Detectives.',
      'I competed in Disease Detectives for Science Olympiad.',
    ]) {
      expect(checkClaimDeterministically(claim, olympiad).verdict, claim).toBeNull();
    }

    // The verb still frames employment, and prose still cannot vouch for a job.
    expect(
      checkClaimDeterministically('I study at Phillips Exeter Academy.', olympiad).verdict,
    ).toBe('unsupported');
    expect(
      checkClaimDeterministically('I interned at Disease Detectives last summer.', olympiad)
        .verdict,
    ).toBe('unsupported');
  });

  /**
   * A cadet writes their unit first and the parent body second. Organisation names had no
   * reordering allowance, and the four-token cap on a capitalised run cut the name in half,
   * so a string the student never typed was quoted back at them in a blocking verdict.
   */
  it("accepts a long organisation name written in the student's own order", () => {
    const cap = evidenceFor({
      experience: [
        {
          organization: 'Civil Air Patrol, Sample Composite Squadron',
          title: 'Cadet Commander',
          type: 'volunteer',
          startDate: '2024-01',
          bullets: [],
          skills: [],
        },
      ],
    } as Partial<ConfirmedProfile>);

    for (const claim of [
      'I serve as Cadet Commander of the Sample Composite Squadron of Civil Air Patrol.',
      'I am Cadet Commander of my Civil Air Patrol squadron.',
      'I serve as Cadet Commander with Civil Air Patrol, Sample Composite Squadron.',
    ]) {
      expect(checkClaimDeterministically(claim, cap).verdict, claim).toBeNull();
    }

    // An invented employer is still invented, and the reordering allowance cannot reach it.
    for (const claim of [
      'I interned at the Dallas Morning News last summer.',
      'I spent last summer at Google working on search infrastructure.',
    ]) {
      expect(checkClaimDeterministically(claim, cap).verdict, claim).toBe('unsupported');
    }
  });
});

describe('proper-noun extraction', () => {
  it('finds names wherever they sit in the sentence', () => {
    expect(extractProperNouns('I worked at Kestrel Analytics.')).toContain('Kestrel Analytics');
    expect(extractProperNouns('Kestrel Analytics hired me in June.')).toContain(
      'Kestrel Analytics',
    );
    expect(extractProperNouns('I go to the University of Michigan.')).toContain(
      'University of Michigan',
    );
  });

  it('does not split a name across a conjunction', () => {
    // "Kestrel Analytics and Rutgers" as one blob would match neither.
    const names = extractProperNouns('I worked at Kestrel Analytics and Rutgers University.');
    expect(names).toContain('Kestrel Analytics');
    expect(names).toContain('Rutgers University');
  });

  it('does not read a contraction as a company name', () => {
    // This blocked G3 approval on any naturally written answer: "I've" normalised to
    // "i ve", matched nothing on the profile, and came back unsupported.
    for (const s of [
      "I've been writing Python since high school.",
      "I'm proud of that one.",
      "Don't ask me why it took so long.",
      "It's the part I liked most.",
      "We've shipped it twice.",
    ]) {
      expect(
        extractProperNouns(s).filter((n) => /['’]/.test(n)),
        s,
      ).toEqual([]);
    }
    expect(verdictOf("I've been writing code since high school.")).toBeNull();
  });

  it('reads a possessive as the name that owns it', () => {
    // "Google's" used to normalise to "google s" and match no employer at all.
    expect(extractProperNouns("I worked on Google's search team.")).toContain('Google');
    expect(verdictOf("I worked on Google's search team.")).toBe('unsupported');
  });

  it('leaves ordinary capitalised words alone', () => {
    expect(extractProperNouns('Last summer was hard.')).toEqual([]);
    expect(extractProperNouns('During June I moved.')).toEqual([]);
    expect(extractProperNouns('I did.')).toEqual([]);
  });
});

describe('claimed-skill extraction', () => {
  it('finds technologies presented as things the writer used', () => {
    expect(extractClaimedSkills('built in Rust')).toEqual(['Rust']);
    expect(extractClaimedSkills('experience with Kubernetes')).toEqual(['Kubernetes']);
    expect(extractClaimedSkills('written in Go')).toEqual(['Go']);
  });

  it('does not treat a following clause as a technology', () => {
    expect(extractClaimedSkills('worked with The team')).toEqual([]);
  });
});

describe('claim segmentation', () => {
  it('splits sentences', () => {
    expect(splitClaims('I built the parser. It was slow at first.')).toHaveLength(2);
  });

  it('splits coordinated clauses when punctuation makes them unambiguous', () => {
    const claims = splitClaims('I built the parser, and I shipped it to production that week.');
    expect(claims).toHaveLength(2);
  });

  it('does not split coordinated nouns', () => {
    // "research and development" is one thing. Splitting it invents a claim.
    expect(splitClaims('I did research and development work at the lab.')).toHaveLength(1);
  });

  it('reports spans that index back into the original text', () => {
    const text = 'I built the parser. It was slow at first.';
    for (const c of splitClaims(text)) {
      expect(text.slice(c.span.start, c.span.end)).toBe(c.text);
    }
  });

  /**
   * NOTHING THE WRITER WROTE MAY LEAVE THIS FUNCTION UNCHECKED.
   *
   * A part under twelve characters used to be skipped outright, and since the sentence was
   * never re-checked whole, that text reached no layer of the guard: no claim, no verdict,
   * no row in the G3 evidence panel. "I ran NASA." is eleven characters, so the one sentence
   * naming an employer the profile has never heard of was the one sentence nobody looked at
   * — and draft.ts asks the model for exactly these ("Put a four-word sentence next to a
   * twenty-five-word one").
   *
   * The assertion is on COVERAGE rather than on a count, so it keeps holding however the
   * splitting rules are tuned later.
   */
  it('leaves no letter of the draft outside every claim', () => {
    for (const text of [
      'I ran NASA.',
      'I mentored two students at the Rutgers Learning Center. I ran NASA. I shipped the parser.',
      'I built the parser, and I ran NASA.',
      'Yes. I tutored algebra every week at the Rutgers Learning Center.',
    ]) {
      const covered = new Array(text.length).fill(false);
      for (const c of splitClaims(text)) {
        for (let i = c.span.start; i < c.span.end; i += 1) covered[i] = true;
      }
      const orphaned = [...text]
        .map((ch, i) => (/\p{L}/u.test(ch) && !covered[i] ? ch : ''))
        .join('');
      // Only the conjunction a split consumes may fall outside a claim, and only then.
      expect(orphaned.replace(/^(?:and|but|then)$/, ''), text).toBe('');
    }
  });

  it('checks a sentence too short to survive the old floor', () => {
    const guard = guardDraft('I ran NASA.', retrieveEvidence(fixture(), QUESTION, { limit: 20 }));
    expect(guard.claims).toHaveLength(1);
    expect(guard.blocking).toHaveLength(1);
  });
});

/**
 * A PERSON THE WRITER NAMES IS NOT AN ORGANISATION THEY CLAIM.
 *
 * "My physics teacher, Mrs. Delgado, pushed me to try robotics" came back BLOCKING with
 * `"Mrs Delgado" does not appear anywhere on your profile` — a true sentence about the
 * student's own life, refused at the gate that has no override, for a reason no amount of
 * profile editing could ever satisfy: a resume lists organisations, not the people in them.
 * The only way out was deleting the sentence. Mentor sentences are most of what a "why this
 * field" answer is made of, so this was not a rare shape.
 *
 * The second block is the half that matters more. Exempting people must not exempt places,
 * and a surname is one letter away from a company name.
 */
describe('a person the writer names', () => {
  const evidence = () => retrieveEvidence(fixture(), QUESTION, { limit: 20 });

  it('is not reported as an organisation missing from the profile', () => {
    for (const claim of [
      'My physics teacher, Mrs. Delgado, pushed me to try robotics.',
      'My coach, Mr. Alvarez, encouraged me to keep going.',
      'My mentor, Dr. Okafor, showed me how to read a datasheet.',
      // The same sentence without the title, which is how half of them are written.
      'My physics teacher, Delgado, pushed me to try robotics.',
      'My manager, Whitfield, let me rewrite the intake form.',
    ]) {
      expect(guardDraft(claim, evidence()).blocking, claim).toEqual([]);
    }
  });

  it('does not let a surname smuggle an employer through', () => {
    // No honorific and no relationship word: this is a claim about where the writer worked,
    // and the profile has never heard of it.
    for (const claim of [
      'I interned at Delgado Engineering last summer.',
      'I spent two summers at Whitfield Labs.',
      'My internship at Okafor Robotics ran from June to August.',
    ]) {
      expect(guardDraft(claim, evidence()).blocking.length, claim).toBeGreaterThan(0);
    }
  });

  it('does not exempt a company merely because a relative is named elsewhere', () => {
    // The relationship word has to introduce THIS name. Only the text before the name is
    // read, so a company later in the sentence cannot borrow the exemption.
    const claim = 'My father drove me to the interview, and I interned at Kestrel Robotics.';
    expect(guardDraft(claim, evidence()).blocking.length).toBeGreaterThan(0);
  });

  /**
   * Intl.Segmenter reads the dot of "St." as a full stop, so "St. Sample High School" —
   * among the most common school-name shapes for young applicants — arrived cut in half:
   * the name was never checked whole, and an invented "St. Jude" employer escaped the
   * invented-org check because each fragment looked ordinary alone.
   */
  it('does not cut a sentence at an abbreviation dot', () => {
    const text = 'I am a member of the Chess Club at St. Sample High School. It meets weekly.';
    const claims = splitClaims(text);
    expect(claims).toHaveLength(2);
    expect(claims[0]!.text).toContain('St. Sample High School');
    for (const c of claims) {
      expect(text.slice(c.span.start, c.span.end)).toBe(c.text);
    }
  });
});

describe('an abbreviation dot does not split a name from itself', () => {
  /**
   * normalize kept the dot ("st. sample high") while the claim side stripped it
   * ("st sample high"), so the profile's own "St."-prefixed school never vouched for a
   * draft that named it — a true sentence, red at G3, where there is no override.
   */
  const ST = evidenceFor({
    education: [{ ...fixture().education[0]!, institution: 'St. Sample High School' }],
  } as Partial<ConfirmedProfile>);

  it('accepts the school with the dot, without it, and inside a whole sentence', () => {
    for (const line of [
      'I attend St. Sample High School.',
      'I attend St Sample High School.',
      'I am a member of the chess club at St. Sample High School.',
    ]) {
      expect(checkClaimDeterministically(line, ST).verdict, line).toBeNull();
    }
  });

  it('still blocks a different St. name, as one whole claim', () => {
    const g = guardDraft('I interned at St. Jude last summer.', ST);
    expect(g.blocking.some((c) => (c.reason ?? '').includes('Jude'))).toBe(true);
  });
});

// ───────────────────────────────────────────────────────── layer precedence

describe('the model layer cannot clear a deterministic rejection', () => {
  const base = guardDraft('I spent two years at Google building search infrastructure.', EVIDENCE);

  it('has something to override', () => {
    expect(base.blocking.length).toBeGreaterThan(0);
  });

  it('ignores a model that calls a caught fabrication supported', () => {
    const merged = mergeModelVerdicts(
      base,
      base.claims.map((c) => ({ claim: c.claim, verdict: 'supported' as const })),
    );
    expect(merged.blocking.length).toBe(base.blocking.length);
    expect(merged.claims.every((c) => c.decidedBy === 'deterministic')).toBe(true);
  });

  it('accepts a model that downgrades a claim the regexes could not reach', () => {
    const honest = guardDraft(
      'I built internal tooling that let the support team resolve billing tickets without an engineer.',
      EVIDENCE,
    );
    expect(honest.blocking).toEqual([]);

    const merged = mergeModelVerdicts(honest, [
      {
        claim: honest.claims[0]!.claim,
        verdict: 'overstated',
        reason:
          'The evidence says you built tooling, not that you removed engineers from the loop.',
      },
    ]);
    expect(merged.blocking).toHaveLength(1);
    expect(merged.claims[0]!.decidedBy).toBe('model');
  });

  it('leaves claims the model did not mention untouched', () => {
    const merged = mergeModelVerdicts(base, []);
    expect(merged.claims).toEqual(base.claims);
  });
});

/**
 * Wanting the job is not a claim of having had it.
 *
 * `affiliationFrame`'s own docstring names four sentences it must never match — "I want to
 * intern at Acme", "I would love to work for Acme", "I have admired Acme for years", "I
 * worked with the Acme API on a side project" — and nothing tested any of them. The frame
 * then grew present-tense forms, bare verbs and a `with` preposition so that "I am interning
 * at NCSA" and "I was employed by FBLA" would stop escaping it, and in growing them it began
 * matching all four.
 *
 * What that cost: G3 has no override. A student writing the most ordinary sentence a
 * why-this-company answer contains got back `"Nova Robotics" is the employer you are applying
 * to, and your profile has no experience there. Say what draws you to them instead.` —
 * printed against a sentence already doing exactly that, with no way out but deleting it. On
 * the drafting path the same flag burned the one revision round telling the model to remove
 * the company name from an answer about that company.
 */
describe('a why-this-company answer', () => {
  const EMPLOYER = ['Nova Robotics', 'Robotics Software Intern'];
  const blocked = (claim: string): boolean =>
    guardDraft(claim, evidenceFor({}), EMPLOYER).claims.some(
      (c) => c.verdict === 'unsupported' || c.verdict === 'overstated',
    );

  it('may say the writer wants the job, in every phrasing people use', () => {
    for (const claim of [
      'I want to work at Nova Robotics because of what I built at Kestrel Analytics.',
      'I would love to intern at Nova Robotics this summer.',
      'I am applying for an internship at Nova Robotics.',
      'I hope to intern at Nova Robotics next summer.',
      'My interest in an internship at Nova Robotics comes from my time at Kestrel Analytics.',
      'I am excited to work at Nova Robotics.',
    ]) {
      expect(blocked(claim), claim).toBe(false);
    }
  });

  it('may admire them, and may name a tool it worked with', () => {
    // The other two sentences from the frame's docstring. "worked WITH a thing" is using it;
    // the preposition belongs to interning and volunteering, not to working.
    expect(blocked('I have admired Nova Robotics for years.')).toBe(false);
    // The tool has to be one the profile holds, or a different check refuses it — correctly.
    const withTool = (claim: string): boolean =>
      guardDraft(claim, skilledWith(['Google Maps API']), EMPLOYER).claims.some(
        (c) => c.verdict === 'unsupported' || c.verdict === 'overstated',
      );
    expect(withTool('I worked with the Google Maps API on my trail project.')).toBe(false);
  });

  it('still refuses a job there that the profile does not hold', () => {
    // The whole reason the frame exists. Wanting the job must not become a way to claim it.
    for (const claim of [
      'I interned at Nova Robotics last summer.',
      'I worked at Nova Robotics for two years.',
      'My internship at Nova Robotics taught me a lot.',
      'I was employed by Nova Robotics.',
      'I volunteered with Nova Robotics for a year.',
    ]) {
      expect(blocked(claim), claim).toBe(true);
    }
  });
});
