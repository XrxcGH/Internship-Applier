/**
 * Evidence retrieval, from the guard's point of view.
 *
 * Retrieval decides what FactGuard is allowed to see, so anything it drops is — at gate
 * G3, where `unsupported` blocks and there is no override — something the student never
 * did. Every case below was a TRUE sentence about a fact the profile stores verbatim,
 * returned to a young applicant as an invention:
 *
 *   "I am conversational in Spanish."                     languages were never emitted
 *   "I am certified in First Aid/CPR/AED..."              clubs ate the budget
 *   "I designed the intake mechanism in Onshape."         late bullets were unreachable
 *
 * So each block asserts the consequence and not only the ref list, and each is paired
 * with the opposite direction: a fabrication of the same shape that must still be caught.
 * A bigger corpus that let inventions through would be a worse bug than the one it fixed.
 *
 * All synthetic data. The clock is pinned because ongoing entries accrue months against
 * "now" and the duration ceilings here would otherwise drift.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ConfirmedProfile } from '@ia/shared';
import { ResumeExtraction } from '../src/core/ingestion/extractProfile';
import { toDraftProfile } from '../src/core/ingestion/toProfile';
import { formatEvidence, retrieveEvidence } from '../src/core/writing/retrieve';
import { guardDraft } from '../src/core/writing/factGuard';

const NOW = new Date('2026-08-08T00:00:00Z');

beforeAll(() => {
  vi.useFakeTimers({ now: NOW });
});
afterAll(() => {
  vi.useRealTimers();
});

function confirm(extraction: unknown): ConfirmedProfile {
  const draft = toDraftProfile(ResumeExtraction.parse(extraction), NOW);
  return { ...draft, confirmedAt: NOW.toISOString() } as unknown as ConfirmedProfile;
}

/** The posting the answers are being written for. Mirrors routes/answers.ts. */
const POSTING =
  'Summer Marketing Intern at Northwind Retail Group. Help the marketing team with ' +
  'social posts, store events and customer research. Ohio, part time, summer 2026.';
const CONTEXT_NAMES = ['Northwind Retail Group', 'Summer Marketing Intern'];

/**
 * The questions a young applicant actually meets. Every finding here reproduced on ALL of
 * them, including the one that names the missing category outright — `overlap` divides by
 * the evidence token count, so "certifications" shares nothing with "first aid cpr aed"
 * and a question about the card could not pull the card into the set.
 */
const QUESTIONS = [
  'Tell us about yourself.',
  'Why do you want this internship?',
  'What makes you a good fit for this role?',
  'List any certifications you hold.',
  'Do you speak any languages other than English?',
];

const BASE = {
  fullName: 'Rosa M. Delgado',
  pronouns: null,
  email: 'rosa.delgado@example.com',
  phone: null,
  location: 'Columbus, OH',
  links: { github: null, linkedin: null, portfolio: null },
  education: [
    {
      institution: 'St. Sample High School',
      level: 'high_school',
      fieldOfStudy: null,
      startDate: '2022-08',
      endDate: '2026-05',
      gpaValue: 3.8,
      gpaScale: 4,
      gpaWeighted: null,
      coursework: ['AP Statistics'],
      honors: ['National Honor Society'],
    },
  ],
  experience: [],
  projects: [],
  skills: [],
  certifications: [],
  languages: [],
  needsReview: [],
};

function club(n: number) {
  return {
    organization: `Sample Club ${n}`,
    title: `Member ${n}`,
    type: 'club',
    startDate: '2024-09',
    endDate: '2025-05',
    location: null,
    bullets: [] as string[],
  };
}

const REAL_JOB = {
  organization: 'Bright Minds Tutoring Center',
  title: 'Math Tutor',
  type: 'job',
  startDate: '2025-06',
  endDate: null,
  location: 'Columbus, OH',
  bullets: ['Tutored middle school students in pre-algebra twice a week'],
};

/** Retrieval exactly as core/writing/draft.ts performs it — production default limit. */
const retrieve = (p: ConfirmedProfile, q: string) =>
  retrieveEvidence(p, q, { postingContext: POSTING });

/**
 * What the G3 gate passes. routes/answers.ts declares `const WHOLE_PROFILE =
 * Number.MAX_SAFE_INTEGER` to mean "no cut at the gate" and hands it to `retrieveEvidence`,
 * because the gate reads nothing to a model and a fact outside the corpus is a fact it will
 * call an invention. Everything above this line exercises the DEFAULT path; the block at the
 * bottom of this file exercises this one, which is where the gate's own false reds live.
 */
const WHOLE_PROFILE = Number.MAX_SAFE_INTEGER;

/** Retrieval exactly as routes/answers.ts performs it at G3. */
const retrieveAtGate = (p: ConfirmedProfile, q: string) =>
  retrieveEvidence(p, q, { postingContext: POSTING, limit: WHOLE_PROFILE });

/** Guarding exactly as routes/answers.ts:134 performs it. */
const blockingFor = (p: ConfirmedProfile, q: string, text: string) =>
  guardDraft(text, retrieve(p, q), CONTEXT_NAMES).blocking;

const refsFor = (p: ConfirmedProfile, q: string) => retrieve(p, q).map((e) => e.ref);

// ─────────────────────────────────────────── C1: languages

describe('languages on the profile are evidence', () => {
  const p = confirm({
    ...BASE,
    experience: [
      {
        organization: 'Sample Community Health Clinic',
        title: 'Front Desk Volunteer',
        type: 'volunteer',
        startDate: '2025-06',
        endDate: '2025-08',
        location: 'Columbus, OH',
        bullets: ['Greeted patients and logged intake forms at the reception desk'],
      },
    ],
    languages: [
      { name: 'Spanish', proficiency: 'Conversational' },
      { name: 'Tagalog', proficiency: 'Native' },
    ],
  });

  /**
   * `languages` reached ConfirmedProfile through extraction, toProfile and the database
   * and then stopped: nothing in writing/ read it. The guard had never been shown the
   * word, so it reported one the profile stores verbatim as an invented name.
   */
  it('emits a languages item for every question, not only a language question', () => {
    for (const q of QUESTIONS) {
      expect(refsFor(p, q)).toContain('languages');
    }
  });

  it('names every language, with its proficiency, in the item text', () => {
    const item = retrieve(p, QUESTIONS[0]!).find((e) => e.ref === 'languages');
    expect(item?.kind).toBe('language');
    expect(item?.text).toBe('Languages: Spanish (Conversational), Tagalog (Native)');
    expect(item?.facts.skills).toEqual(['Spanish', 'Tagalog']);
  });

  /**
   * Tagalog is the case that mattered. A language echoed by an AP course escaped through
   * the education text by accident; a heritage language with no course or club to echo it
   * never did, so the block landed hardest on the students most likely to have one.
   */
  it('clears true sentences about a language, on every question shape', () => {
    for (const q of QUESTIONS) {
      for (const claim of [
        'I am conversational in Spanish.',
        'I grew up speaking Tagalog at home.',
        'I speak Spanish and Tagalog.',
        'I have experience with Tagalog.',
      ]) {
        expect(blockingFor(p, q, claim)).toEqual([]);
      }
    }
  });

  /** Opposite direction: a language the profile does not hold is still an invention. */
  it('still blocks a language the profile does not hold', () => {
    const g = blockingFor(p, QUESTIONS[0]!, 'I am fluent in Mandarin and Portuguese.');
    expect(g.length).toBeGreaterThan(0);
    expect(g[0]!.verdict).toBe('unsupported');
    expect(g[0]!.reason).toMatch(/Mandarin/);
  });

  it('emits nothing when the profile holds no languages', () => {
    const none = confirm({ ...BASE, experience: [REAL_JOB] });
    expect(refsFor(none, QUESTIONS[0]!)).not.toContain('languages');
  });
});

// ─────────────────────────────────────────── C12: every kind survives volume

describe('every kind of evidence survives a busy activity list', () => {
  const build = (clubs: number) =>
    confirm({
      ...BASE,
      experience: [...Array.from({ length: clubs }, (_, i) => club(i + 1)), REAL_JOB],
      projects: [
        {
          name: 'Trail Tracker',
          description: 'A trail-condition map for the county park system',
          url: null,
          bullets: [],
        },
      ],
      skills: [
        { name: 'Python', category: 'language' },
        { name: 'Microsoft Excel', category: 'tool' },
      ],
      certifications: [
        { name: 'First Aid/CPR/AED', issuer: 'American Red Cross', date: '2024-01' },
      ],
      languages: [{ name: 'Tagalog', proficiency: 'Native' }],
    });

  /**
   * The volumes that broke it. A bullet-less club role line scores +0.3 against the skills
   * line's +0.2, a project's +0.1 and a certification's +0.05, and a young applicant's
   * resume is made of bullet-less role lines — so on a generic question the clubs ate the
   * whole budget. The certification was gone at eight activities plus one job.
   */
  const VOLUMES = [0, 5, 8, 10, 12, 16, 24];

  it('keeps the skills, project, certification and languages items at every volume', () => {
    for (const clubs of VOLUMES) {
      const p = build(clubs);
      for (const q of QUESTIONS) {
        const refs = refsFor(p, q);
        expect({ clubs, q, refs }).toMatchObject({ refs: expect.arrayContaining(['skills']) });
        expect(refs).toContain('projects.0');
        expect(refs).toContain('certifications.0');
        expect(refs).toContain('languages');
      }
    }
  });

  it('clears the true sentences that used to block at those volumes', () => {
    for (const clubs of VOLUMES) {
      const p = build(clubs);
      for (const q of QUESTIONS) {
        for (const claim of [
          'I am certified in First Aid/CPR/AED through the American Red Cross.',
          'I built Trail Tracker, a trail-condition map for the county park system.',
          'I have experience with Python and use it for data work.',
          'I use Microsoft Excel.',
          'I grew up speaking Tagalog at home.',
        ]) {
          expect({ clubs, q, claim, blocking: blockingFor(p, q, claim) }).toMatchObject({
            blocking: [],
          });
        }
      }
    }
  });

  /**
   * The rescue this replaced. A sixteen-activity resume dropped the student's only real
   * job, and "I worked as a math tutor at Bright Minds Tutoring Center" came back red at
   * G3 as an invented employer. Round-robin keeps it for a different reason than the old
   * top-up did, so it is worth asserting again here.
   */
  it('still keeps the one real job and the school among many clubs', () => {
    const p = build(16);
    for (const q of QUESTIONS) {
      expect(refsFor(p, q)).toContain('experience.16');
      expect(refsFor(p, q)).toContain('education.0');
      expect(
        blockingFor(p, q, 'I worked as a math tutor at Bright Minds Tutoring Center.'),
      ).toEqual([]);
      expect(blockingFor(p, q, 'I have a 3.8 GPA at St. Sample High School.')).toEqual([]);
    }
  });

  /** Opposite direction: none of these categories became a licence to invent. */
  it('still blocks a certification, a project, a skill and a language it does not hold', () => {
    const p = build(16);
    for (const claim of [
      'I am a certified Amazon Web Services Solutions Architect.',
      'I built Nightingale Scheduler for the county hospital.',
      'I have experience with Kubernetes.',
      'I am fluent in Mandarin.',
    ]) {
      const blocking = blockingFor(p, QUESTIONS[0]!, claim);
      expect({ claim, count: blocking.length }).toMatchObject({ count: 1 });
      expect(blocking[0]!.verdict).toBe('unsupported');
    }
  });

  /**
   * The stated guarantee, structurally: every kind the profile holds is represented
   * before any kind is given a second slot. Asserting it directly is what stops the next
   * repair from quietly re-introducing a ranked cut for one category.
   */
  it('gives every kind a slot before any kind gets a second', () => {
    const p = build(16);
    const ev = retrieve(p, QUESTIONS[0]!);
    const kinds = new Set(ev.map((e) => e.kind));
    expect([...kinds].sort()).toEqual([
      'certification',
      'education',
      'experience',
      'identity',
      'language',
      'project',
      'skill',
    ]);
  });
});

// ─────────────────────────────────────────── C13: bullets are not lesser facts

describe('bullets past the first handful stay reachable', () => {
  /** Ordinary resume prose. Bullets name tools, competitions and awards — proper nouns
   *  the guard reads as inventions the moment their line falls out of the set. */
  const BULLETS = [
    'Joined the build subteam as a freshman and learned to use the bandsaw',
    'Ran the pit checklist before every match',
    'Kept the team build calendar and posted weekly reminders',
    'Sorted and labelled the hardware bins so parts could be found mid-match',
    'Trained two new members on shop safety rules',
    'Wrote the match scouting sheet the drive team used',
    'Machined bracket plates on the lathe for the drivetrain',
    'Designed the intake mechanism in Onshape and iterated through four prototypes',
    'Competed at the Buckeye Regional and won the Creativity Award',
    'Presented the robot to sponsors at the fall showcase',
    'Mentored the middle school FLL team through their qualifier',
    'Rebuilt the swerve modules after the Perrysburg district event',
    'Kept the bill of materials in a shared spreadsheet',
    'Ran the safety inspection with the team mentor before Worlds',
  ];

  const build = (bullets: string[], clubs: number) =>
    confirm({
      ...BASE,
      experience: [
        {
          organization: 'Riverbend Robotics',
          title: 'Build Team Member',
          type: 'club',
          startDate: '2023-09',
          endDate: '2026-04',
          location: 'Columbus, OH',
          bullets,
        },
        ...Array.from({ length: clubs }, (_, i) => club(i + 1)),
      ],
      projects: [
        { name: 'Trail Tracker', description: 'A trail-condition map', url: null, bullets: [] },
      ],
      skills: [{ name: 'Python', category: 'language' }],
    });

  /**
   * The real threshold was not "the eleventh bullet". It was
   * limit - 1 - roleLines - schools - the skills line, which on an unremarkable
   * five-activity resume is the seventh bullet on the one activity the student cares
   * about. Eight bullets under one club is all it took.
   */
  it('keeps every bullet on a resume-shaped entry, at several activity counts', () => {
    for (const clubs of [0, 4, 8, 12]) {
      for (const count of [8, 12, 14]) {
        const p = build(BULLETS.slice(0, count), clubs);
        const refs = refsFor(p, 'Tell us about a time you solved a problem.');
        for (let j = 0; j < count; j++) {
          expect({ clubs, count, j, refs }).toMatchObject({
            refs: expect.arrayContaining([`experience.0.bullets.${j}`]),
          });
        }
      }
    }
  });

  it('clears true sentences quoting the late bullets', () => {
    const p = build(BULLETS, 4);
    for (const q of QUESTIONS) {
      for (const claim of [
        'I designed the intake mechanism in Onshape and iterated through four prototypes.',
        'We competed at the Buckeye Regional and won the Creativity Award.',
        'I mentored the middle school FLL team through their qualifier.',
        'I rebuilt the swerve modules after the Perrysburg district event.',
      ]) {
        expect({ q, claim, blocking: blockingFor(p, q, claim) }).toMatchObject({ blocking: [] });
      }
    }
  });

  /**
   * The extreme the finding used: thirty bullets differing only by an invented token, so
   * nothing but the bullet's own presence can vouch for the sentence. Bullets 11 to 29
   * were invisible to the guard for any question that did not lexically hit them.
   */
  it('reaches the twenty-eighth bullet of thirty', () => {
    const p = confirm({
      ...BASE,
      experience: [
        {
          organization: 'Riverbend Robotics',
          title: 'Build Team Member',
          type: 'club',
          startDate: '2023-09',
          endDate: '2026-04',
          location: null,
          bullets: Array.from(
            { length: 30 },
            (_, i) => `Bullet ${i}: machined a Widget${i} bracket on the lathe`,
          ),
        },
      ],
    });
    for (const i of [0, 11, 14, 27, 29]) {
      expect(blockingFor(p, 'Tell us about yourself.', `I machined a Widget${i} bracket.`)).toEqual(
        [],
      );
    }
  });

  /** Opposite direction: a bullet-shaped sentence about work never done is still red. */
  it('still blocks a bullet the profile does not contain', () => {
    const p = build(BULLETS, 4);
    const blocking = blockingFor(
      p,
      'Tell us about a time you solved a problem.',
      'I programmed the autonomous routine in LabVIEW and won at the Buckeye Valley Invitational.',
    );
    expect(blocking.length).toBeGreaterThan(0);
    expect(blocking[0]!.verdict).toBe('unsupported');
  });
});

// ─────────────────────────────────────────── the cost side of the trade

describe('corpus and prompt are bounded separately', () => {
  /** 26 honors, 16 activities, 40 skills, 12 schools and a 30-bullet flagship entry. */
  const MONSTER = confirm({
    ...BASE,
    education: Array.from({ length: 12 }, (_, i) => ({
      institution: `Sample Institution ${i + 1}`,
      level: 'high_school',
      fieldOfStudy: null,
      startDate: '2022-08',
      endDate: '2026-05',
      gpaValue: null,
      gpaScale: null,
      gpaWeighted: null,
      coursework: [],
      honors: i === 0 ? Array.from({ length: 26 }, (_, h) => `Sample Honor Number ${h + 1}`) : [],
    })),
    experience: [
      {
        organization: 'Riverbend Robotics',
        title: 'Build Team Member',
        type: 'club',
        startDate: '2023-09',
        endDate: '2026-04',
        location: null,
        bullets: Array.from({ length: 30 }, (_, i) => `Bullet ${i}: machined a bracket`),
      },
      ...Array.from({ length: 15 }, (_, i) => club(i + 1)),
      REAL_JOB,
    ],
    projects: [
      { name: 'Trail Tracker', description: 'A trail-condition map', url: null, bullets: [] },
    ],
    skills: Array.from({ length: 40 }, (_, i) => ({ name: `Skill${i + 1}`, category: 'tool' })),
    certifications: [{ name: 'First Aid/CPR/AED', issuer: 'American Red Cross', date: '2024-01' }],
    languages: [{ name: 'Tagalog', proficiency: 'Native' }],
  });

  /** MAX_EVIDENCE_ITEMS. The ceiling holds however large the resume gets. */
  it('never returns more than sixty items', () => {
    for (const q of QUESTIONS) {
      expect(retrieve(MONSTER, q).length).toBeLessThanOrEqual(60);
    }
  });

  /**
   * PROMPT_EVIDENCE_LINES. This is the half of the trade that keeps a corpus sized for
   * the guard from landing on every draft and every revision the model performs.
   */
  it('never prints more than twenty-four evidence lines into the prompt', () => {
    const block = formatEvidence(retrieve(MONSTER, QUESTIONS[0]!));
    expect(block.split('\n').length).toBeLessThanOrEqual(24);
  });

  it('prints one fact about each entry rather than many facts about one', () => {
    // The prompt head is the round-robin's first round, so a busy resume gives the model
    // breadth. Before, eleven bullets of one activity crowded out fifteen other entries.
    const block = formatEvidence(retrieve(MONSTER, QUESTIONS[0]!));
    const bulletLines = block.split('\n').filter((l) => l.includes('.bullets.'));
    expect(bulletLines.length).toBeLessThanOrEqual(1);
  });

  it('still shows the drafting model every kind on an ordinary busy resume', () => {
    const p = confirm({
      ...BASE,
      experience: [...Array.from({ length: 12 }, (_, i) => club(i + 1)), REAL_JOB],
      projects: [
        { name: 'Trail Tracker', description: 'A trail-condition map', url: null, bullets: [] },
      ],
      skills: [{ name: 'Python', category: 'language' }],
      certifications: [
        { name: 'First Aid/CPR/AED', issuer: 'American Red Cross', date: '2024-01' },
      ],
      languages: [{ name: 'Tagalog', proficiency: 'Native' }],
    });
    const block = formatEvidence(retrieve(p, QUESTIONS[0]!));
    for (const ref of ['identity', 'skills', 'projects.0', 'certifications.0', 'languages']) {
      expect(block).toContain(`[${ref}]`);
    }
  });

  /**
   * `limit` is a floor, not a cut. It used to be a hard cap, and a caller asking for a
   * small prompt therefore silently decided which of the student's facts were true.
   */
  it('keeps one fact per entry even when the caller asks for a smaller set', () => {
    const p = confirm({
      ...BASE,
      experience: [...Array.from({ length: 14 }, (_, i) => club(i + 1)), REAL_JOB],
      certifications: [
        { name: 'First Aid/CPR/AED', issuer: 'American Red Cross', date: '2024-01' },
      ],
      languages: [{ name: 'Tagalog', proficiency: 'Native' }],
    });
    const refs = retrieveEvidence(p, QUESTIONS[0]!, { limit: 5 }).map((e) => e.ref);
    expect(refs).toContain('certifications.0');
    expect(refs).toContain('languages');
    expect(refs).toContain('experience.14');
    expect(refs).toContain('education.0');
  });

  /**
   * The false-green side of a larger corpus, pinned. More evidence means a larger token
   * union for FactGuard's lexical coverage score, so the exact checks — names, GPAs,
   * durations, skills — have to keep doing the work at this size.
   */
  it('still catches fabrications against the largest corpus it can build', () => {
    for (const claim of [
      'I interned at Stripe on the payments platform.',
      'I have a 4.0 GPA.',
      'I have experience with Kubernetes and Terraform.',
      'I worked at Google Research for three years.',
      'I won the Intel International Science and Engineering Fair grand award.',
    ]) {
      const blocking = blockingFor(MONSTER, QUESTIONS[0]!, claim);
      expect({ claim, count: blocking.length }).toMatchObject({ count: 1 });
    }
  });
});

// ─────────────────────────────────────── the gate's own call shape, not the default one

/**
 * Everything above asks for the default corpus. The G3 gate does not: it asks for the whole
 * profile, and a ceiling that clamped that ask put the gate back where the file started.
 * `MAX_EVIDENCE_ITEMS` used to be applied with `Math.min` over the caller's number, so
 * `limit: Number.MAX_SAFE_INTEGER` returned sixty — and on a sixteen-activity resume ten
 * real bullets fell outside, so "I repaired damaged spines with the Gaylord book tape the
 * librarian ordered" came back `unsupported` at the one gate that has no override.
 */
describe('the corpus the G3 gate asks for', () => {
  const ACTIVITIES = [
    'Riverbend Robotics',
    'Model United Nations',
    'Marching Band',
    'Key Club',
    'Science Olympiad',
    'Debate Team',
    'Spanish Club',
    'Yearbook',
    'Math League',
    'Environmental Club',
    'Theater Tech Crew',
    'Student Council',
    'Chess Club',
    'Red Cross Club',
    'Cross Country',
    'Library Volunteers',
  ];

  /** The last entry is the one the ceiling used to cut into. */
  const bulletsFor = (i: number): string[] =>
    i === ACTIVITIES.length - 1
      ? [
          'Shelved returned books and reset the reading room every Saturday morning',
          'Ran the summer reading raffle for the Overbrook branch',
          'Repaired damaged spines with the Gaylord book tape the librarian ordered',
        ]
      : [
          `Attended weekly meetings and helped plan the group calendar in year ${i + 1}`,
          'Recruited new members at the club fair each September',
          'Kept the shared notes document current for everyone in the group',
        ];

  const BUSY = confirm({
    ...BASE,
    experience: ACTIVITIES.map((organization, i) => ({
      organization,
      title: `Member ${i + 1}`,
      type: 'club',
      startDate: '2024-09',
      endDate: '2025-05',
      location: null,
      bullets: bulletsFor(i),
    })),
    projects: [
      { name: 'Trail Tracker', description: 'A trail-condition map', url: null, bullets: [] },
    ],
    skills: [{ name: 'Python', category: 'language' }],
    certifications: [{ name: 'First Aid/CPR/AED', issuer: 'American Red Cross', date: '2024-01' }],
    languages: [{ name: 'Tagalog', proficiency: 'Native' }],
  });

  it('hands the gate every fact the profile emits, past the default ceiling', () => {
    for (const q of QUESTIONS) {
      const refs = retrieveAtGate(BUSY, q).map((e) => e.ref);
      for (let i = 0; i < ACTIVITIES.length; i++) {
        for (let j = 0; j < 3; j++) {
          expect({ q, i, j, refs }).toMatchObject({
            refs: expect.arrayContaining([`experience.${i}.bullets.${j}`]),
          });
        }
      }
      expect(refs.length).toBeGreaterThan(60);
    }
  });

  it('clears the verbatim bullet the clamped corpus called an invention', () => {
    for (const q of QUESTIONS) {
      for (const claim of [
        'I repaired damaged spines with the Gaylord book tape the librarian ordered.',
        'I ran the summer reading raffle for the Overbrook branch.',
      ]) {
        expect({
          q,
          claim,
          blocking: guardDraft(claim, retrieveAtGate(BUSY, q), CONTEXT_NAMES).blocking,
        }).toMatchObject({ blocking: [] });
      }
    }
  });

  /**
   * The contract routes/answers.ts and core/filling/plan.ts both rely on. A larger number
   * than the ceiling has to mean what it says, or `limit` is a hard cut wearing a floor's
   * documentation and the corpus stops growing with the profile at a magic number.
   */
  it('never clamps an explicit ask, and still bounds the caller who states none', () => {
    const sizeAt = (limit?: number) =>
      retrieveEvidence(BUSY, QUESTIONS[0]!, {
        postingContext: POSTING,
        ...(limit === undefined ? {} : { limit }),
      }).length;

    const whole = sizeAt(WHOLE_PROFILE);
    expect(sizeAt(80)).toBe(whole);
    expect(sizeAt(200)).toBe(whole);
    expect(sizeAt(40)).toBe(40);
    expect(sizeAt(60)).toBe(60);
    // No caller stated a preference, so MAX_EVIDENCE_ITEMS is what holds.
    expect(sizeAt()).toBeLessThanOrEqual(60);
  });

  /**
   * The cost the line above re-admits, pinned. The corpus is unbounded on purpose; the
   * PROMPT is what costs money on every draft and every revision, and `formatEvidence`
   * bounds it whatever array it is handed — so the split between the two is what keeps an
   * uncut verification corpus from landing in a model prompt.
   */
  it('leaves the drafting prompt bounded even off the gate corpus', () => {
    const gate = retrieveAtGate(BUSY, QUESTIONS[0]!);
    expect(gate.length).toBeGreaterThan(60);
    const block = formatEvidence(gate);
    const lines = block.split('\n');
    expect(lines.length).toBeLessThanOrEqual(24);

    // And it is still the round-robin's first round, so the model reads one fact about each
    // entry rather than the flagship activity's bullets twice over.
    const bucket = (ref: string) => ref.replace(/\.bullets\.\d+$/, '');
    const inPrompt = new Set(lines.map((l) => bucket(l.slice(1, l.indexOf(']')))));
    const inCorpus = new Set(gate.map((e) => bucket(e.ref)));
    expect(inPrompt.size).toBe(Math.min(lines.length, inCorpus.size));
  });

  /** Opposite direction: the uncut corpus is not a licence to invent. */
  it('still blocks fabrications against the uncut corpus', () => {
    for (const claim of [
      'I interned at Stripe on the payments platform.',
      'I have a 4.0 GPA.',
      'I have experience with Kubernetes.',
      'I repaired damaged spines with the Demco book tape the librarian ordered.',
      'I ran the summer reading raffle for the Kittiwake branch.',
    ]) {
      const blocking = guardDraft(
        claim,
        retrieveAtGate(BUSY, QUESTIONS[0]!),
        CONTEXT_NAMES,
      ).blocking;
      expect({ claim, count: blocking.length }).toMatchObject({ count: 1 });
    }
  });

  /**
   * A one-entry profile must not gain items from a huge ask. `limit` is a floor on what is
   * kept, never an instruction to emit facts the profile does not hold.
   */
  it('emits nothing the profile does not hold, however large the ask', () => {
    const thin = confirm({ ...BASE, experience: [REAL_JOB] });
    const refs = retrieveAtGate(thin, QUESTIONS[0]!).map((e) => e.ref);
    expect(refs.sort()).toEqual(
      ['identity', 'education.0', 'experience.0', 'experience.0.bullets.0'].sort(),
    );
  });
});

// ─────────────────────────────────────── the proficiency the profile records

/**
 * The languages line is the one item whose text carries a JUDGEMENT — Conversational,
 * Native, Fluent — and not just a fact, so it is the one item a claim can contradict while
 * still scoring lexically against it. Retrieval's half of that is supplying both values in
 * structure, so the comparison is a lookup rather than a re-parse of prose this file just
 * formatted. Making the verdict is factGuard's half and is not done here: see the note on
 * `Evidence['facts'].languages`.
 */
describe('the languages item carries the recorded proficiency as structure', () => {
  const p = confirm({
    ...BASE,
    experience: [REAL_JOB],
    languages: [
      { name: 'Spanish', proficiency: 'Conversational' },
      { name: 'Tagalog', proficiency: 'Native' },
    ],
  });

  it('pairs each language with the proficiency the profile stores', () => {
    const item = retrieve(p, QUESTIONS[0]!).find((e) => e.ref === 'languages');
    expect(item?.facts.languages).toEqual([
      { name: 'Spanish', proficiency: 'Conversational' },
      { name: 'Tagalog', proficiency: 'Native' },
    ]);
    // Still in the text as well: it is what a reviewer at G3 reads the sentence against.
    expect(item?.text).toBe('Languages: Spanish (Conversational), Tagalog (Native)');
    // And still in facts.skills, which is what "I have experience with Tagalog" is checked
    // against — the false red this item was added to close.
    expect(item?.facts.skills).toEqual(['Spanish', 'Tagalog']);
  });

  it('is absent, rather than empty, when the profile holds no languages', () => {
    const none = confirm({ ...BASE, experience: [REAL_JOB] });
    expect(retrieve(none, QUESTIONS[0]!).some((e) => e.facts.languages)).toBe(false);
  });
});

/**
 * What the drafting prompt gets when one kind of evidence outnumbers every other.
 *
 * Taking the head of the retrieved array was not enough. The array is round-robin over
 * ENTRIES, but the buckets come out ordered by their best item, and a bare role line scores
 * +0.3 against a school's +0.25 and a certification's +0.05. On the resume this was found
 * with — twenty-seven activities, twenty-six of them with no bullets at all — the first
 * twenty-four lines were twenty-four bare "Title at Org (dates)" strings. The eleven honors
 * and four certifications, which on that profile are the only substance it holds, were in
 * the corpus and never in the prompt: the model was asked to write about a person and shown
 * nothing they had done.
 */
describe('the drafting prompt on an activity-heavy profile', () => {
  function activityProfile(): ConfirmedProfile {
    return toDraftProfile(
      ResumeExtraction.parse({
        fullName: 'Rosa Sample',
        pronouns: null,
        email: 'rosa@example.com',
        phone: null,
        location: 'Boston, MA',
        links: { github: null, linkedin: null, portfolio: null },
        education: [
          {
            institution: 'Sample High School',
            level: 'high_school',
            fieldOfStudy: null,
            startDate: '2022-08',
            endDate: '2026-06',
            gpaValue: 3.9,
            gpaScale: 4,
            gpaWeighted: null,
            coursework: ['AP Biology'],
            honors: ['National Merit Semifinalist', 'Eagle Scout'],
          },
        ],
        // Twenty-seven bare entries, which is the shape that broke it.
        experience: Array.from({ length: 27 }, (_, i) => ({
          organization: `Club ${i + 1}`,
          title: 'Member',
          type: 'club',
          startDate: '2024-09',
          endDate: null,
          location: null,
          bullets: [],
        })),
        projects: [],
        skills: [{ name: 'SolidWorks', category: 'tool' }],
        certifications: [{ name: 'First Aid/CPR/AED', issuer: 'American Red Cross', date: '2023' }],
        languages: [],
        needsReview: [],
      }),
    ) as ConfirmedProfile;
  }

  const block = (): string =>
    formatEvidence(retrieveEvidence(activityProfile(), 'Tell us about yourself.', { limit: 200 }));

  it('shows the honors, which on this profile are the only substance there is', () => {
    expect(block()).toMatch(/National Merit Semifinalist/);
  });

  it('shows the certification, the skill and the school', () => {
    const b = block();
    expect(b).toMatch(/First Aid/);
    expect(b).toMatch(/SolidWorks/);
    expect(b).toMatch(/Sample High School/);
  });

  it('still leads with experience, which is what most questions ask about', () => {
    const lines = block().split('\n');
    expect(lines.filter((l) => l.startsWith('[experience')).length).toBeGreaterThan(0);
    // And identity is always first, since a draft that cannot use the writer's own name or
    // city gets those blocked at G3.
    expect(lines[0]).toMatch(/^\[identity\]/);
  });

  it('does not let one kind take every line', () => {
    const kinds = new Set(
      block()
        .split('\n')
        .map((l) => /^\[(\w+)/.exec(l)?.[1]),
    );
    expect(kinds.size).toBeGreaterThanOrEqual(4);
  });
});

// ─────────────────────────────────────────── the dates a project carries

/**
 * A project's dates never reached the evidence corpus, and a project is the one dated kind
 * with no other way in: FactGuard pools duration evidence on `facts.startDate` and scopes a
 * claim to the entry whose NAME it uses, so an undated project is in neither pool nor scope.
 * "I worked on Trail Tracker for two years" — about a project the profile records as running
 * exactly two years — was therefore measured against the longest entry the profile DID date,
 * and on a young applicant's resume that is a two-month internship or a four-year club,
 * never the project itself. Both directions failed:
 *
 *   a TRUE two-year claim, blocked at G3 by a two-month internship, with no override;
 *   an INFLATED three-year claim about a two-month project, cleared by a four-year club.
 *
 * The dates reach the profile at gate G1 rather than from the resume: `ResumeExtraction`
 * carries no date field on a project, while the shared `ProjectEntry` holds `startDate` and
 * `endDate` and the G1 wizard validates them ("Project 1 started", "Project 1 finished" in
 * Onboarding.tsx). So the fixtures confirm a profile and then put the dates on, which is the
 * shape the database actually holds.
 */
function withProjectDates(
  p: ConfirmedProfile,
  dates: Array<{ startDate?: string; endDate?: string }>,
): ConfirmedProfile {
  return { ...p, projects: p.projects.map((proj, i) => ({ ...proj, ...(dates[i] ?? {}) })) };
}

describe('project dates are evidence', () => {
  /** Two months of real work, and two dated projects — one long, one short. */
  const SHORT_WORK = withProjectDates(
    confirm({
      ...BASE,
      experience: [
        {
          organization: 'Sample Community Health Clinic',
          title: 'Front Desk Intern',
          type: 'internship',
          startDate: '2025-06',
          endDate: '2025-08',
          location: 'Columbus, OH',
          bullets: ['Greeted patients and logged intake forms at the reception desk'],
        },
      ],
      projects: [
        {
          name: 'Trail Tracker',
          description: 'A trail-condition map for the county park system',
          url: null,
          bullets: [],
        },
        {
          name: 'Tide Chart',
          description: 'A tide table for the sailing club',
          url: null,
          bullets: [],
        },
      ],
    }),
    // Two years on the first, two months on the second.
    [
      { startDate: '2023-06', endDate: '2025-06' },
      { startDate: '2025-01', endDate: '2025-03' },
    ],
  );

  it('puts the span in the item text and the dates in facts', () => {
    const item = retrieve(SHORT_WORK, QUESTIONS[0]!).find((e) => e.ref === 'projects.0');
    expect(item?.facts.startDate).toBe('2023-06');
    expect(item?.facts.endDate).toBe('2025-06');
    // In the text too: it is what a reviewer at G3 reads the sentence against, and what is
    // quoted beside a claim the duration check blocks.
    expect(item?.text).toBe(
      'Trail Tracker: A trail-condition map for the county park system (2023-06 to 2025-06)',
    );
  });

  /**
   * An ongoing project has no end date and is measured to now, exactly as an ongoing job is
   * — the convention the profile itself uses. An UNDATED project prints no span at all
   * rather than "(date not stated to present)", which would assert an ongoing project the
   * profile never claimed, in an item whose whole job is to be true.
   */
  it('prints an open span for an ongoing project and none at all for an undated one', () => {
    const ongoing = withProjectDates(
      confirm({
        ...BASE,
        experience: [REAL_JOB],
        projects: [
          { name: 'Tide Chart', description: 'A tide table', url: null, bullets: [] },
          { name: 'Trail Tracker', description: 'A trail-condition map', url: null, bullets: [] },
        ],
      }),
      [{ startDate: '2024-08' }],
    );
    const ev = retrieve(ongoing, QUESTIONS[0]!);
    expect(ev.find((e) => e.ref === 'projects.0')?.text).toBe(
      'Tide Chart: A tide table (2024-08 to present)',
    );
    expect(ev.find((e) => e.ref === 'projects.1')?.text).toBe(
      'Trail Tracker: A trail-condition map',
    );
    // Two years to the pinned clock, so the true sentence clears and the inflated one does not.
    expect(blockingFor(ongoing, QUESTIONS[0]!, 'I worked on Tide Chart for two years.')).toEqual(
      [],
    );
    expect(
      blockingFor(ongoing, QUESTIONS[0]!, 'I worked on Tide Chart for six years.'),
    ).toHaveLength(1);
  });

  /**
   * The false RED. Without the project's dates the only thing left to measure the sentence
   * against was the two-month internship, and a true sentence came back `overstated` at the
   * one gate that has no override.
   */
  it('clears a true tenure claim about a project the profile dates', () => {
    for (const q of QUESTIONS) {
      for (const claim of [
        'I worked on Trail Tracker for two years.',
        'I spent two years building Trail Tracker.',
        'I have worked on Trail Tracker for about 24 months.',
      ]) {
        expect({ q, claim, blocking: blockingFor(SHORT_WORK, q, claim) }).toMatchObject({
          blocking: [],
        });
      }
    }
  });

  /**
   * Opposite direction, in the same fixture: the short project is now the ceiling for a claim
   * that names it. This blocked before as well — but against the INTERNSHIP, so the reviewer
   * was shown the wrong entry as the reason. The ref is the assertion that matters.
   */
  it('measures an inflated claim against the project it names, and says so', () => {
    const blocking = blockingFor(
      SHORT_WORK,
      QUESTIONS[0]!,
      'I worked on Tide Chart for two years.',
    );
    expect(blocking).toHaveLength(1);
    expect(blocking[0]!.verdict).toBe('overstated');
    expect(blocking[0]!.profileRef).toBe('projects.1');
    expect(blocking[0]!.quote).toContain('Tide Chart');
  });

  /**
   * The false GREEN, which is the same missing pair of fields seen from the other side. This
   * resume's longest dated entry is a four-year club, so an unscoped claim was measured
   * against 43 months and three years about a two-month project went to an employer clean.
   */
  it('stops a four-year club vouching for a two-month project', () => {
    const LONG_CLUB = withProjectDates(
      confirm({
        ...BASE,
        experience: [
          {
            organization: 'Riverbend Robotics',
            title: 'Build Team Member',
            type: 'club',
            startDate: '2022-09',
            endDate: '2026-04',
            location: 'Columbus, OH',
            bullets: ['Machined bracket plates on the lathe for the drivetrain'],
          },
        ],
        projects: [
          {
            name: 'Tide Chart',
            description: 'A tide table for the sailing club',
            url: null,
            bullets: [],
          },
        ],
      }),
      [{ startDate: '2025-01', endDate: '2025-03' }],
    );

    const blocking = blockingFor(
      LONG_CLUB,
      QUESTIONS[0]!,
      'I worked on Tide Chart for three years.',
    );
    expect(blocking).toHaveLength(1);
    expect(blocking[0]!.verdict).toBe('overstated');
    expect(blocking[0]!.profileRef).toBe('projects.0');

    // And the club's own true tenure still clears: a project ceiling binds only a claim that
    // names the project.
    expect(
      blockingFor(
        LONG_CLUB,
        QUESTIONS[0]!,
        'I was on the Riverbend Robotics build team for three years.',
      ),
    ).toEqual([]);
  });
});
