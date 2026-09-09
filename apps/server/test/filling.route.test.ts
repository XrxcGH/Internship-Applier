/**
 * The gates around filling, over the wire.
 *
 * Nothing here opens a browser: these assert that the server REFUSES before it would. The
 * behavioural fill tests live in fill.test.ts against the fixture.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { CandidateProfile, FormField } from '@ia/shared';
import { ulid } from 'ulid';
import { buildApp } from '../src/app';
import { eq } from 'drizzle-orm';
import { config } from '../src/config';
import { db, schema } from '../src/infra/db/client';
import { runMigrations } from '../src/infra/db/migrate';
import { encryptField, isEncrypted } from '../src/infra/crypto/fieldCrypto';
import { confirmProfile, getProfile, saveProfile } from '../src/core/profile/repository';
import { buildFillPlan, WHOLE_PROFILE } from '../src/core/filling/plan';
import { retrieveEvidence } from '../src/core/writing/retrieve';
import { load } from '../src/routes/filling';
import { sweepApprovals } from '../src/routes/profile';

let app: FastifyInstance;
let applicationId: string;

const PROFILE = {
  id: 'prof_fill',
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
      endDate: '2028-05',
      coursework: [],
      honors: [],
    },
  ],
  experience: [],
  projects: [],
  skills: [],
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
    yearsProfessionalExperience: 0,
    seniorityBand: 'entry_intern',
  },
  confirmedAt: null,
  needsReview: [],
  createdAt: '2026-08-03T00:00:00Z',
  updatedAt: '2026-08-03T00:00:00Z',
} as CandidateProfile;

beforeAll(async () => {
  runMigrations();
  app = await buildApp({ skipAuth: true });
  await app.ready();

  saveProfile(PROFILE);
  confirmProfile();

  const postingId = ulid();
  db.insert(schema.jobPosting)
    .values({
      id: postingId,
      canonicalUrl: `https://example.com/j/${postingId}`,
      applyUrl: `https://example.com/j/${postingId}/apply`,
      company: 'Northwind Systems',
      title: 'Software Engineering Intern',
      descriptionText: 'Summer internship.',
      fingerprint: postingId,
    })
    .run();

  const matchId = ulid();
  db.insert(schema.match)
    .values({
      id: matchId,
      postingId,
      profileId: PROFILE.id,
      eligibility: 'eligible',
      rules: [],
      blockers: [],
      score: 80,
      breakdown: {},
      rationale: 'test',
    })
    .run();

  applicationId = ulid();
  db.insert(schema.application)
    .values({
      id: applicationId,
      matchId,
      status: 'draft',
      applyUrl: `https://example.com/j/${postingId}/apply`,
    })
    .run();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  db.delete(schema.applicationAnswer).run();
});

function addAnswer(approved: boolean, question = 'Why do you want this internship?') {
  const id = ulid();
  db.insert(schema.applicationAnswer)
    .values({
      id,
      applicationId,
      questionText: question,
      fieldKey: 'q1',
      answerType: 'long_text',
      draftText: 'Because the work is interesting.',
      finalText: 'Because the work is interesting.',
      approvedAt: approved ? new Date().toISOString() : null,
    })
    .run();
  return id;
}

/**
 * Gate G1, over the wire.
 *
 * Every other test in this file runs with the profile already confirmed, so the check that
 * refuses a run built on facts the user has never looked at was never once exercised. It is
 * the gate standing between the extractor's guesses — a misread graduation date, a phone
 * number picked out of a footer — and an employer's form, and it needs a test of its own so
 * that dropping it is a failure rather than a silent change of behaviour.
 */
describe('gate G1 blocks filling', () => {
  beforeEach(() => {
    // The fixture is declared with `confirmedAt: null`, so writing it back is exactly what
    // an unconfirmed profile looks like from the route's side.
    saveProfile(PROFILE);
  });

  afterEach(() => {
    confirmProfile();
  });

  it('refuses a run against a profile the user has not confirmed', async () => {
    addAnswer(true);
    for (const url of [
      `/api/applications/${applicationId}/fill`,
      `/api/applications/${applicationId}/fill/continue`,
    ]) {
      const res = await app.inject({ method: 'POST', url });
      expect(res.statusCode, url).toBe(400);
      expect(res.json().error.code, url).toBe('PROFILE_INCOMPLETE');
      // Says which gate, because "incomplete" on its own does not tell anyone what to do.
      expect(res.json().error.message, url).toMatch(/confirm your profile/i);
    }
  });

  it('checks the profile before it checks the answers', async () => {
    // The other order would let an unapproved answer stand in for the missing confirmation:
    // the user fixes the answer, gets a second refusal, and only then learns about G1.
    addAnswer(false);
    const res = await app.inject({
      method: 'POST',
      url: `/api/applications/${applicationId}/fill`,
    });
    expect(res.json().error.code).toBe('PROFILE_INCOMPLETE');
  });
});

describe('gate G3 blocks filling', () => {
  it('refuses to open a browser while an answer is unapproved', async () => {
    addAnswer(false);
    const res = await app.inject({
      method: 'POST',
      url: `/api/applications/${applicationId}/fill`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('ANSWERS_NOT_APPROVED');
    // Names the question, so the user knows which one to go and review.
    expect(res.json().error.details.questions[0]).toMatch(/why do you want/i);
  });

  it('names the count when several are unapproved', async () => {
    addAnswer(false, 'Question one?');
    addAnswer(false, 'Question two?');
    const res = await app.inject({
      method: 'POST',
      url: `/api/applications/${applicationId}/fill`,
    });
    expect(res.json().error.message).toMatch(/2 answers/);
  });

  it('refuses on continue as well, not just on start', async () => {
    // Otherwise approving, starting a run, then unapproving would slip past the gate.
    addAnswer(false);
    const res = await app.inject({
      method: 'POST',
      url: `/api/applications/${applicationId}/fill/continue`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('ANSWERS_NOT_APPROVED');
  });
});

/**
 * G3 approval is a point in time. The profile is not.
 *
 * The user approves "I interned at Kestrel Analytics", then goes back to the wizard — which
 * stays reachable from the nav after G1, and whose Save button PUTs the whole profile — and
 * deletes that job. Before these tests, the answer kept its green tick, kept an evidence
 * panel citing `experience.0` while `experience` was empty, and the fill planner went on
 * offering the sentence as something to type into an employer's form. Every trigger that
 * re-ran verification was a change to the ANSWER; nothing watched the profile.
 *
 * Both directions are asserted here on purpose. An edit that touches nothing an answer
 * relies on must leave every tick where it is, and an answer that names the employer must
 * survive a profile save — re-checking it without the company's name would turn "What draws
 * me to Northwind Systems" red at the last gate, where there is no override.
 */
describe('an approval does not outlive the profile it was checked against', () => {
  const RICH = {
    ...PROFILE,
    education: [
      {
        institution: 'Rutgers University',
        level: 'bachelor',
        fieldOfStudy: 'Computer Science',
        endDate: '2028-05',
        gpa: { value: 3.9, scale: 4 },
        coursework: [],
        honors: ['National Merit Finalist'],
      },
    ],
    experience: [
      {
        type: 'internship',
        organization: 'Kestrel Analytics',
        title: 'Software Engineering Intern',
        startDate: '2026-06',
        endDate: '2026-08',
        bullets: ['Built internal tooling in TypeScript.'],
        skills: ['TypeScript'],
      },
    ],
    skills: [{ name: 'TypeScript', category: 'language', evidence: [] }],
  } as CandidateProfile;

  const ESSAY: FormField = {
    id: 'f_essay',
    locator: '#essay',
    label: 'Tell us about a project you are proud of',
    control: 'textarea',
    required: true,
    semantic: 'essay',
    confidence: 0.9,
  };

  const KESTREL_QUESTION = 'Tell us about a project you are proud of.';
  const KESTREL_TEXT =
    'I interned at Kestrel Analytics, where I built internal tooling in TypeScript.';

  beforeEach(() => {
    // `submittedAt` matters: an answer on an application the user has already sent is left
    // alone on purpose, and the G4 tests below share this row.
    db.update(schema.application)
      .set({ status: 'draft', submittedAt: null })
      .where(eq(schema.application.id, applicationId))
      .run();
    saveProfile(RICH);
    confirmProfile();
  });

  afterEach(() => {
    db.delete(schema.applicationEvent).run();
    saveProfile(PROFILE);
    confirmProfile();
  });

  /** Seeds one answer and takes it through the real G3 gate, evidence and all. */
  async function approved(question: string, text: string): Promise<string> {
    const id = ulid();
    db.insert(schema.applicationAnswer)
      .values({
        id,
        applicationId,
        questionText: question,
        fieldKey: 'q1',
        answerType: 'long_text',
        draftText: text,
        finalText: text,
      })
      .run();
    const res = await app.inject({ method: 'POST', url: `/api/answers/${id}/approve` });
    expect(res.statusCode, res.body).toBe(200);
    return id;
  }

  const answerRow = (id: string) =>
    db.select().from(schema.applicationAnswer).where(eq(schema.applicationAnswer.id, id)).all()[0]!;

  const savedProfile = (): CandidateProfile => getProfile()!;

  const put = (edit: (p: CandidateProfile) => CandidateProfile) =>
    app.inject({ method: 'PUT', url: '/api/profile', payload: edit(savedProfile()) });

  const planFor = (id: string) =>
    buildFillPlan({
      fields: [ESSAY],
      profile: getProfile() as never,
      answers: [answerRow(id)] as never,
    });

  it('withdraws the tick when the job the answer names is deleted, and says why', async () => {
    const id = await approved(KESTREL_QUESTION, KESTREL_TEXT);
    expect(answerRow(id).approvedAt).toBeTruthy();

    const res = await put((p) => ({ ...p, experience: [] }));
    expect(res.statusCode).toBe(200);

    const row = answerRow(id);
    expect(row.approvedAt).toBeNull();

    // The claim's own reason, and the sentence that explains why a card the user approved
    // is suddenly not approved. Without the second one this reads as lost work.
    const flags = (row.flags ?? []) as Array<{ type: string; note: string }>;
    expect(flags[0]?.type).toBe('unsupported');
    expect(flags[0]?.note).toContain('Kestrel Analytics');
    expect(flags[0]?.note).toMatch(/your profile changed after you approved this answer/i);

    // The stored evidence is the new verdict, not the one from before the edit. A panel
    // still quoting `experience.0` beside an empty experience list is the shape of this bug.
    const evidence = (row.evidence ?? []) as Array<{ verdict: string; profileRef: string | null }>;
    expect(evidence[0]?.verdict).toBe('unsupported');
    expect(evidence[0]?.profileRef).toBeNull();

    // And the write said so in its own reply.
    expect(res.json().withdrawnApprovals).toHaveLength(1);
    expect(res.json().withdrawnApprovals[0].question).toBe(KESTREL_QUESTION);
  });

  it('refuses the fill and types nothing after a withdrawal', async () => {
    const id = await approved(KESTREL_QUESTION, KESTREL_TEXT);
    await put((p) => ({ ...p, experience: [] }));

    const res = await app.inject({
      method: 'POST',
      url: `/api/applications/${applicationId}/fill`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('ANSWERS_NOT_APPROVED');

    const plan = planFor(id);
    expect(plan.actions).toEqual([]);
    expect(plan.skips[0]?.reason).toBe('needs_answer');
  });

  /**
   * The family, not the instance. The reported case was a deleted job; a corrected GPA, a
   * deleted award, a corrected home city and a replaced school are the same failure through
   * different fields, and the home city is reachable from a single TextField on the G1
   * wizard — the smallest edit the shipped UI can make.
   */
  it.each([
    [
      'the job is deleted',
      KESTREL_QUESTION,
      KESTREL_TEXT,
      (p: CandidateProfile) => ({ ...p, experience: [] }),
    ],
    [
      'the GPA is corrected downward',
      'What are you proudest of academically?',
      'I hold a 3.9 GPA at Rutgers University.',
      (p: CandidateProfile) => ({
        ...p,
        education: [{ ...p.education[0]!, gpa: { value: 3.1, scale: 4 } }],
      }),
    ],
    [
      'the award is deleted',
      'Tell us about an honour you have received.',
      'I was named a National Merit Finalist.',
      (p: CandidateProfile) => ({ ...p, education: [{ ...p.education[0]!, honors: [] }] }),
    ],
    [
      'the home city is corrected in the wizard',
      'Why are you interested in this location?',
      'I am based in New Brunswick, so the commute is short.',
      (p: CandidateProfile) => ({
        ...p,
        locationPrefs: {
          ...p.locationPrefs,
          base: { city: 'Trenton', region: 'NJ', country: 'US' },
          additionalBases: [],
        },
      }),
    ],
    [
      'the school is replaced',
      'Where do you study?',
      'I study Computer Science at Rutgers University.',
      (p: CandidateProfile) => ({
        ...p,
        education: [{ ...p.education[0]!, institution: 'Montclair State University' }],
      }),
    ],
  ])('withdraws the tick when %s', async (_name, question, text, edit) => {
    const id = await approved(question, text);
    const res = await put(edit);
    expect(res.statusCode).toBe(200);

    expect(answerRow(id).approvedAt).toBeNull();
    expect(res.json().withdrawnApprovals).toHaveLength(1);
    expect(load(applicationId)).toMatchObject({ ok: false, code: 'ANSWERS_NOT_APPROVED' });
  });

  /**
   * The profile route is not the only writer. A resume re-extraction goes straight to
   * `saveProfile` from routes/resumes.ts, so a sweep that lived only in the route would let
   * a whole new profile land under a set of approvals untouched. The fill loader is the last
   * place to catch that, and it has to catch it whatever wrote the profile.
   */
  it('catches a profile written past the profile route, at the fill gate', async () => {
    const id = await approved(KESTREL_QUESTION, KESTREL_TEXT);
    saveProfile({ ...savedProfile(), experience: [] });

    // The route-level sweep really was bypassed, so this is the loader's catch and nothing else.
    expect(answerRow(id).approvedAt).toBeTruthy();

    const refusal = load(applicationId);
    expect(refusal.ok).toBe(false);
    if (refusal.ok) throw new Error('unreachable');
    expect(refusal.code).toBe('ANSWERS_NOT_APPROVED');
    expect(refusal.message).toMatch(/older version of your profile/i);
    expect(refusal.message).toMatch(/nothing was typed/i);

    // The row is repaired on the way past, so the review screen the message sends the user
    // to does not still show a green tick with nothing wrong on it.
    const row = answerRow(id);
    expect(row.approvedAt).toBeNull();
    expect((row.flags ?? []) as unknown[]).not.toEqual([]);
  });

  /**
   * The other direction, which is weighted the same. Nothing here changed a fact any of
   * these answers leans on, so every tick must survive. A tool that dropped approvals on
   * every save would teach the user to re-approve without reading, which is the same
   * failure as never checking.
   */
  it.each([
    [
      'a skill is added',
      (p: CandidateProfile) => ({
        ...p,
        skills: [...p.skills, { name: 'Python', category: 'language' as const, evidence: [] }],
      }),
    ],
    [
      'a postal code is filled in',
      (p: CandidateProfile) => ({ ...p, address: { ...p.address, postal: '08901' } }),
    ],
    ['the profile is saved back unchanged', (p: CandidateProfile) => p],
  ])('keeps the tick when %s', async (_name, edit) => {
    const id = await approved(KESTREL_QUESTION, KESTREL_TEXT);
    const res = await put(edit);

    expect(res.statusCode).toBe(200);
    expect(res.json().withdrawnApprovals).toEqual([]);
    expect(answerRow(id).approvedAt).toBeTruthy();
    expect(load(applicationId).ok).toBe(true);
    expect(planFor(id).actions[0]?.value).toBe(KESTREL_TEXT);
  });

  /**
   * The false red this whole mechanism is one mistake away from.
   *
   * The employer's name is nowhere on the candidate's profile, so a re-check that forgets to
   * pass it reads "Northwind Systems" as an invention and pulls the approval off the most
   * ordinary sentence a "why this company" answer contains — at a gate with no override,
   * on an answer G3 approved and would approve again.
   */
  it('keeps the tick on an answer that names the employer', async () => {
    const id = await approved(
      'Why do you want to work at Northwind Systems?',
      'What draws me to Northwind Systems is the internal tooling work. ' +
        'I built internal tooling in TypeScript at Kestrel Analytics and want more of it.',
    );

    const res = await put((p) => ({ ...p, address: { ...p.address, postal: '08901' } }));
    expect(res.json().withdrawnApprovals).toEqual([]);
    expect(answerRow(id).approvedAt).toBeTruthy();
    expect(load(applicationId).ok).toBe(true);
  });

  /**
   * The planner's own gate, on the one row shape nothing legitimate produces: an approval
   * stamp beside a blocking verdict. Approval writes `guard.blocking` empty by definition,
   * so the two can only meet where the verdicts were recomputed after the stamp was granted
   * — and reading the stamp alone is what let a deleted job's sentence reach a form.
   */
  it('will not type an approved answer that is carrying a rejection', async () => {
    const id = await approved(KESTREL_QUESTION, KESTREL_TEXT);
    db.update(schema.applicationAnswer)
      .set({
        flags: [{ type: 'unsupported', span: { start: 0, end: 10 }, note: 'Not on your profile.' }],
      })
      .where(eq(schema.applicationAnswer.id, id))
      .run();

    const plan = planFor(id);
    expect(plan.actions).toEqual([]);
    expect(plan.skips[0]?.note).toMatch(/older version of your profile/i);
  });

  it('reads the evidence column too, not only the flags', async () => {
    // A writer that refreshed the verdicts and forgot the flags would otherwise hand the
    // planner the one field it was not reading and get a green tick back for it.
    const id = await approved(KESTREL_QUESTION, KESTREL_TEXT);
    db.update(schema.applicationAnswer)
      .set({
        evidence: [{ claim: KESTREL_TEXT, verdict: 'unsupported', profileRef: null, quote: null }],
      })
      .where(eq(schema.applicationAnswer.id, id))
      .run();

    expect(planFor(id).actions).toEqual([]);
  });

  /** Amber is not red. A style flag has never blocked anything and must not start now. */
  it('still types an approved answer carrying only a style flag', async () => {
    const id = await approved(KESTREL_QUESTION, KESTREL_TEXT);
    db.update(schema.applicationAnswer)
      .set({
        flags: [{ type: 'ai_tell', span: { start: 0, end: 4 }, note: 'Reads a little formal.' }],
      })
      .where(eq(schema.applicationAnswer.id, id))
      .run();

    expect(planFor(id).actions[0]?.value).toBe(KESTREL_TEXT);
  });

  /**
   * The amber flags survive the withdrawal. They were measured against how this person
   * writes, which a profile edit does not touch, and dropping them would quietly empty half
   * the review screen every time a fact changed.
   */
  it('keeps the style flags it did not recompute', async () => {
    const id = await approved(KESTREL_QUESTION, KESTREL_TEXT);
    db.update(schema.applicationAnswer)
      .set({
        flags: [{ type: 'ai_tell', span: { start: 0, end: 4 }, note: 'Reads a little formal.' }],
      })
      .where(eq(schema.applicationAnswer.id, id))
      .run();

    await put((p) => ({ ...p, experience: [] }));

    const flags = (answerRow(id).flags ?? []) as Array<{ type: string }>;
    expect(flags.map((f) => f.type)).toContain('ai_tell');
    expect(flags.map((f) => f.type)).toContain('unsupported');
  });

  /** An answer already in front of an employer is history, and history is not re-litigated. */
  it('leaves an application the user has already sent alone', async () => {
    const id = await approved(KESTREL_QUESTION, KESTREL_TEXT);
    db.update(schema.application)
      .set({ status: 'submitted', submittedAt: new Date().toISOString() })
      .where(eq(schema.application.id, applicationId))
      .run();

    const res = await put((p) => ({ ...p, experience: [] }));
    expect(res.json().withdrawnApprovals).toEqual([]);
    expect(answerRow(id).approvedAt).toBeTruthy();
  });

  /**
   * The false red that comes from the two gates sizing their own evidence corpus.
   *
   * `RICH` above is one job, one school and one skill — about eight buckets, comfortably
   * inside retrieval's default floor — so the approve pass and the re-check happened to
   * return the same corpus and no assertion here could see them diverge. The population this
   * tool is built for does not look like that. A sixteen-activity resume with three bullets
   * each is fifty-odd facts, and while `recheckApproval` took the default floor while
   * `verify()` in routes/answers.ts passed `WHOLE_PROFILE`, the re-check verified against
   * twenty items fewer than the pass that granted the tick — and the twenty it lost were the
   * second and third bullets of the lower-ranked entries, which is exactly where the tool
   * names and award names FactGuard treats as distinctive proper nouns live.
   *
   * Measured before the fix on this shape: fourteen of thirty-three true, G3-approved
   * sentences were withdrawn by a profile save that changed nothing at all, and the fill was
   * refused with no profile edit anywhere in between. `Ran the Larkspur fundraiser for Math
   * League.` is one of them, and it is a sentence the student typed into their own profile.
   */
  describe('a busy activities resume, where the two gates can size their corpus differently', () => {
    const CLUBS = [
      'Debate Team',
      'Math League',
      'Science Olympiad',
      'Model UN',
      'Key Club',
      'Marching Band',
      'Yearbook',
      'Environmental Club',
      'Coding Club',
      'Red Cross Club',
      'Chess Club',
      'Volunteer Tutoring',
      'Food Bank',
      'Student Government',
      'Track Team',
      'Art Club',
    ];
    // One distinctive proper noun per entry, on the LAST bullet — the one that falls off the
    // end of a corpus sized for a prompt rather than for the gate.
    const FUNDS = [
      'Calloway',
      'Larkspur',
      'Marchmont',
      'Ainsley',
      'Ferndale',
      'Winsford',
      'Orchard Street',
      'Bellingham',
      'Kittiwake',
      'Highbury',
      'Ravenswood',
      'Thornbury',
      'Ellesmere',
      'Wexford',
      'Cranbourne',
      'Pemberton',
    ];

    const BUSY = {
      ...PROFILE,
      experience: CLUBS.map((org, i) => ({
        type: 'club' as const,
        organization: org,
        title: 'Member',
        startDate: '2024-09',
        endDate: '2025-06',
        bullets: [
          `Attended weekly meetings for ${org}.`,
          `Helped organise the annual ${org} showcase.`,
          `Ran the ${FUNDS[i]} fundraiser for ${org}.`,
        ],
        skills: [],
      })),
    } as CandidateProfile;

    beforeEach(() => {
      saveProfile(BUSY);
      confirmProfile();
    });

    it.each(
      // The last bullet of the lower-ranked entries. The first two are inside any corpus.
      [1, 4, 9, 15].map((i) => [CLUBS[i]!, `Ran the ${FUNDS[i]} fundraiser for ${CLUBS[i]}.`]),
    )('keeps the tick on a verbatim bullet from %s', async (_club, text) => {
      const id = await approved(KESTREL_QUESTION, text);
      expect(answerRow(id).approvedAt).toBeTruthy();

      // A save that changes nothing. Anything withdrawn here was withdrawn by the re-check
      // disagreeing with the approval, not by an edit.
      const res = await put((p) => p);
      expect(res.statusCode).toBe(200);
      expect(res.json().withdrawnApprovals).toEqual([]);
      expect(answerRow(id).approvedAt).toBeTruthy();

      // And the last gate before the form agrees with G3 rather than overruling it.
      expect(load(applicationId).ok).toBe(true);
      expect(planFor(id).actions[0]?.value).toBe(text);
    });

    /**
     * Why the approvals above hold, asserted directly, so that a retrieval ceiling put back
     * over an explicit limit fails with its cause named instead of showing up as one
     * approval case going red for no visible reason.
     *
     * `WHOLE_PROFILE` is only worth passing if retrieval honours it, and for a while it did
     * not: `retrieveEvidence` clamped every caller to its own ceiling, so this profile's last
     * bullets sat outside the corpus at G3 and `Ran the Pemberton fundraiser for Art Club.`
     * came back `"Pemberton" does not appear anywhere on your profile` from a route with no
     * override, over a sentence the student typed into their own profile.
     *
     * No number is written down here on purpose. The claim is the relation — an explicit ask
     * beats whatever a caller who states no preference gets, and every bullet is in it —
     * which stays the assertion this file wants whatever those two numbers become.
     */
    it('gives the gate every bullet on the profile, not the default corpus', () => {
      // The profile the gate itself reads: the one `beforeEach` saved and confirmed.
      const confirmed = getProfile() as never;
      const asked = retrieveEvidence(confirmed, KESTREL_QUESTION, { limit: WHOLE_PROFILE });
      const noPreference = retrieveEvidence(confirmed, KESTREL_QUESTION, {});
      expect(asked.length).toBeGreaterThan(noPreference.length);

      const corpus = asked.map((e) => e.text).join('\n');
      for (const bullet of BUSY.experience.flatMap((e) => e.bullets ?? [])) {
        expect(corpus).toContain(bullet);
      }
    });

    /**
     * The other direction on the same profile, so the agreement above is not agreement by
     * way of a corpus that swallows everything. A fabrication placed beside real bullets is
     * still refused at G3, and the re-check still refuses it.
     */
    it('still refuses a fabrication sitting beside those bullets', async () => {
      const id = ulid();
      const text = 'I ran the Gaylord fundraiser for the Debate Team.';
      db.insert(schema.applicationAnswer)
        .values({
          id,
          applicationId,
          questionText: KESTREL_QUESTION,
          fieldKey: 'q1',
          answerType: 'long_text',
          draftText: text,
          finalText: text,
        })
        .run();

      const res = await app.inject({ method: 'POST', url: `/api/answers/${id}/approve` });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.details.claims[0].reason).toContain('Gaylord');
      expect(answerRow(id).approvedAt).toBeNull();
    });
  });

  /**
   * The other door onto the same event: a resume re-upload.
   *
   * `routes/resumes.ts` replaces the whole profile through `saveProfile` and, because a
   * re-extraction is a machine read that has not been confirmed, resets `confirmedAt` to
   * null. The sweep used to open with `if (!profile.confirmedAt) return []`, which switched
   * it off at exactly the door it was exported for: every G3 card went on showing a green
   * tick beside an evidence panel quoting entries the new extraction had not produced.
   *
   * The extract route itself cannot be driven here — reading a resume needs a model and the
   * suite pins `LLM_PROVIDER=none` — so this asserts the sweep on the profile shape that
   * route saves, which is the part that was switched off. The route wiring is one call.
   */
  it('withdraws the tick when a resume re-extraction replaces the profile', async () => {
    const id = await approved(KESTREL_QUESTION, KESTREL_TEXT);
    expect(answerRow(id).approvedAt).toBeTruthy();

    // Exactly what routes/resumes.ts stores: a fresh draft, the old id, confirmedAt null.
    const reExtracted = saveProfile({
      ...PROFILE,
      id: savedProfile().id,
      experience: [],
      confirmedAt: null,
    });
    expect(reExtracted.confirmedAt).toBeNull();

    const withdrawn = sweepApprovals(reExtracted, 'resume_reextracted');
    expect(withdrawn).toHaveLength(1);
    expect(withdrawn[0]?.question).toBe(KESTREL_QUESTION);
    expect(withdrawn[0]?.claims[0]?.reason).toContain('Kestrel Analytics');

    const row = answerRow(id);
    expect(row.approvedAt).toBeNull();
    const flags = (row.flags ?? []) as Array<{ note: string }>;
    expect(flags[0]?.note).toMatch(/your profile changed after you approved this answer/i);

    // G4 is untouched: with no confirmed profile, the fill loader still refuses outright.
    expect(load(applicationId)).toMatchObject({ ok: false, code: 'PROFILE_INCOMPLETE' });
  });

  /** Whatever else changed, nothing here submits anything. */
  it('adds no way to submit and moves no application forward', async () => {
    await approved(KESTREL_QUESTION, KESTREL_TEXT);
    await put((p) => ({ ...p, experience: [] }));

    const status = db
      .select({ status: schema.application.status, submittedAt: schema.application.submittedAt })
      .from(schema.application)
      .where(eq(schema.application.id, applicationId))
      .all()[0]!;
    expect(status.status).toBe('draft');
    expect(status.submittedAt).toBeNull();
  });
});

describe('no run, no fill', () => {
  it('will not type into a page it never opened', async () => {
    addAnswer(true);
    const res = await app.inject({
      method: 'POST',
      url: `/api/applications/${applicationId}/fill/continue`,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('NO_RUN');
  });

  it('reports no open run rather than inventing one', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/applications/${applicationId}/fill` });
    expect(res.statusCode).toBe(404);
  });
});

/**
 * What the run is told to attach.
 *
 * `resume_document.path` is encrypted at rest, and the loader used to pass that column
 * through untouched: the filler was handed `v1:RUBjO4-OGVlnZuT4:...` as a filename, so
 * every resume upload field on every form came back red with a raw ENOENT, and nobody
 * could get a resume attached at all. These run against the loader rather than the route
 * because the route opens a browser.
 */
describe('the resume a fill run attaches', () => {
  function addResume({ onDisk = true } = {}) {
    const id = ulid();
    mkdirSync(config.paths.resumes, { recursive: true });
    const stored = path.join(config.paths.resumes, `${id}.txt`);
    if (onDisk) writeFileSync(stored, 'Rosa Alvarez\nRutgers University\n');
    // Stored exactly the way POST /api/resumes stores it, ciphertext and all.
    db.insert(schema.resumeDocument)
      .values({
        id,
        filename: 'rosa.txt',
        path: encryptField(stored, id),
        mime: 'text/plain',
        bytes: 30,
        sha256: 'a'.repeat(64),
        isPrimary: true,
      })
      .run();
    return stored;
  }

  function loadOk() {
    const result = load(applicationId);
    if (!result.ok) throw new Error(`load refused: ${result.code} ${result.message}`);
    return result.data;
  }

  const RESUME_FIELD: FormField = {
    id: 'f_resume',
    locator: '#resume',
    label: 'Resume',
    control: 'file',
    required: true,
    semantic: 'resume_upload',
    confidence: 0.95,
  };

  afterEach(() => {
    db.delete(schema.resumeDocument).run();
  });

  it('is a file that exists on disk, not the encrypted column', () => {
    const stored = addResume();
    const { resumePath } = loadOk();

    expect(resumePath).toBe(stored);
    expect(isEncrypted(resumePath ?? '')).toBe(false);
    expect(existsSync(resumePath ?? '')).toBe(true);
  });

  function planFor(field: FormField) {
    const data = loadOk();
    return buildFillPlan({
      fields: [field],
      profile: data.profile,
      answers: data.answers,
      resumePath: data.resumePath,
    });
  }

  it('reaches the plan as the path the browser will be given', () => {
    const stored = addResume();
    const plan = planFor(RESUME_FIELD);

    expect(plan.skips).toEqual([]);
    expect(plan.actions[0]?.filePath).toBe(stored);
  });

  it('is nothing at all when the file has been deleted from under the row', () => {
    // Better to say "no resume" than to hand the browser a path it cannot open: the first
    // is a skip the user can act on, the second is a failed field full of internals.
    addResume({ onDisk: false });

    expect(loadOk().resumePath).toBeUndefined();
    const plan = planFor(RESUME_FIELD);
    expect(plan.actions).toEqual([]);
    expect(plan.skips[0]?.note).toMatch(/no resume file is attached/i);
  });
});

describe('gate G4', () => {
  it('exposes no endpoint that submits an application', async () => {
    for (const url of [
      `/api/applications/${applicationId}/submit`,
      `/api/applications/${applicationId}/fill/submit`,
      `/api/applications/${applicationId}/send`,
    ]) {
      expect((await app.inject({ method: 'POST', url })).statusCode, url).toBe(404);
    }
  });

  it('records that the USER submitted, without touching a browser', async () => {
    // The row is seeded as `draft` for the G3 tests above, and draft → submitted is not a
    // transition the state machine allows. Advancing it here keeps those fixtures intact
    // while putting this application where a real one would be by the time anybody could
    // have clicked Submit on the employer's page.
    db.update(schema.application)
      .set({ status: 'awaiting_submit' })
      .where(eq(schema.application.id, applicationId))
      .run();

    const res = await app.inject({
      method: 'POST',
      url: `/api/applications/${applicationId}/mark-submitted`,
      payload: { confirmed: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('submitted');
    expect(res.json().submittedAt).toBeTruthy();

    const row = db.select().from(schema.application).all()[0]!;
    expect(row.submittedAt).toBeTruthy();

    // The event log says who did it, because that distinction is the whole design.
    const events = db.select().from(schema.applicationEvent).all();
    const marked = events.find((e) => e.type === 'marked_submitted')!;
    expect((marked.payload as { by: string }).by).toBe('user');
  });

  /**
   * The confirmation is the whole point of this endpoint.
   *
   * `{ confirmed: true }` used to be declared in the shared schema and never read, so the
   * one machine-checkable half of gate G4 was decorative: any POST at all stamped an
   * application submitted. These two tests exist so it cannot quietly become decorative
   * again.
   */
  it('refuses to record a submission nobody confirmed', async () => {
    db.update(schema.application)
      .set({ status: 'awaiting_submit', submittedAt: null })
      .where(eq(schema.application.id, applicationId))
      .run();

    for (const payload of [undefined, {}, { confirmed: false }, { confirmed: 'yes' }]) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/applications/${applicationId}/mark-submitted`,
        payload,
      });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json().error.code).toBe('CONFIRMATION_REQUIRED');
    }

    // And nothing was recorded on the way past.
    const row = db.select().from(schema.application).all()[0]!;
    expect(row.submittedAt).toBeNull();
    expect(row.status).toBe('awaiting_submit');
  });

  it('refuses a transition the state machine does not allow', async () => {
    db.update(schema.application)
      .set({ status: 'draft', submittedAt: null })
      .where(eq(schema.application.id, applicationId))
      .run();

    const res = await app.inject({
      method: 'POST',
      url: `/api/applications/${applicationId}/mark-submitted`,
      payload: { confirmed: true },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('ILLEGAL_TRANSITION');
    expect(db.select().from(schema.application).all()[0]!.submittedAt).toBeNull();
  });
});

/**
 * Gate G2, reversed.
 *
 * Approving a match creates an application. Changing that decision to skipped or rejected
 * used to replace the decision row, answer `applicationId: null` and leave the application
 * standing — so the posting disappeared from the match queue, which hides anything decided,
 * while the tracker went on showing the card, every gate in `load()` went on passing for it,
 * and it could be walked all the way to `submitted`. The response saying there was no
 * application was the only part a client could see, and it was false.
 */
describe('gate G2 — undoing an approval takes the application with it', () => {
  let matchId: string;

  beforeEach(() => {
    const postingId = ulid();
    db.insert(schema.jobPosting)
      .values({
        id: postingId,
        canonicalUrl: `https://example.com/j/${postingId}`,
        applyUrl: `https://example.com/j/${postingId}/apply`,
        company: 'Kestrel Analytics',
        title: 'Backend Intern',
        descriptionText: 'Summer internship.',
        fingerprint: postingId,
      })
      .run();

    matchId = ulid();
    db.insert(schema.match)
      .values({
        id: matchId,
        postingId,
        profileId: PROFILE.id,
        eligibility: 'eligible',
        rules: [],
        blockers: [],
        score: 70,
        breakdown: {},
        rationale: 'test',
      })
      .run();
  });

  afterEach(() => {
    // Leave the file's own fixture as the only application again — several tests above read
    // `db.select().from(schema.application).all()[0]`.
    for (const row of db.select().from(schema.application).all()) {
      if (row.matchId !== matchId) continue;
      db.delete(schema.applicationAnswer)
        .where(eq(schema.applicationAnswer.applicationId, row.id))
        .run();
      db.delete(schema.applicationEvent)
        .where(eq(schema.applicationEvent.applicationId, row.id))
        .run();
      db.delete(schema.application).where(eq(schema.application.id, row.id)).run();
    }
    db.delete(schema.decision).where(eq(schema.decision.matchId, matchId)).run();
  });

  const decide = (action: string) =>
    app.inject({
      method: 'POST',
      url: `/api/matches/${matchId}/decision`,
      payload: { action, reason: 'changed my mind' },
    });

  it.each(['rejected', 'skipped', 'saved'])(
    'deletes the application it created when the decision becomes %s',
    async (action) => {
      const approved = await decide('approved');
      const created = approved.json().applicationId as string;
      expect(created).toBeTruthy();

      const reversed = await decide(action);
      expect(reversed.statusCode).toBe(200);
      expect(reversed.json().applicationId).toBeNull();
      expect(reversed.json().deletedApplicationId).toBe(created);

      // The claim in that body is now true: there is no application for this match.
      expect(
        db.select().from(schema.application).where(eq(schema.application.matchId, matchId)).all(),
      ).toEqual([]);

      // And nothing downstream is still holding one.
      expect(load(created)).toMatchObject({ ok: false, code: 'NOT_FOUND' });
      const list = await app.inject({ method: 'GET', url: '/api/applications' });
      expect((list.json().applications as Array<{ id: string }>).map((a) => a.id)).not.toContain(
        created,
      );
      const tracker = await app.inject({ method: 'GET', url: '/api/tracker' });
      expect((tracker.json().applications as Array<{ id: string }>).map((a) => a.id)).not.toContain(
        created,
      );
    },
  );

  it('takes the answers with it rather than orphaning them', async () => {
    const created = (await decide('approved')).json().applicationId as string;
    db.insert(schema.applicationAnswer)
      .values({
        id: ulid(),
        applicationId: created,
        questionText: 'Why here?',
        fieldKey: 'q1',
        answerType: 'long_text',
        draftText: 'Because.',
        finalText: 'Because.',
      })
      .run();

    await decide('rejected');
    expect(
      db
        .select()
        .from(schema.applicationAnswer)
        .where(eq(schema.applicationAnswer.applicationId, created))
        .all(),
    ).toEqual([]);
  });

  it('refuses instead of deleting an application the user has already submitted', async () => {
    const created = (await decide('approved')).json().applicationId as string;
    db.update(schema.application)
      .set({ status: 'submitted', submittedAt: new Date().toISOString() })
      .where(eq(schema.application.id, created))
      .run();

    const reversed = await decide('rejected');
    expect(reversed.statusCode).toBe(409);
    expect(reversed.json().error.code).toBe('APPLICATION_IN_PROGRESS');
    expect(reversed.json().error.details.applicationId).toBe(created);

    // Still there, and still submitted. Nothing the user did in the world was thrown away.
    const row = db
      .select()
      .from(schema.application)
      .where(eq(schema.application.id, created))
      .all();
    expect(row).toHaveLength(1);
    expect(row[0]!.status).toBe('submitted');
  });

  it('says nothing was deleted when the match was never approved', async () => {
    const res = await decide('rejected');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ action: 'rejected', applicationId: null });
    expect(res.json().deletedApplicationId).toBeUndefined();
  });
});

/**
 * The list of fields the user still has to fill in by hand.
 *
 * A finished run writes it onto the application, and the panel that shows it reads the run
 * in memory — which is gone when the browser is closed, when a second run starts and when
 * the server restarts. Nothing returned the stored copy, so after any of those the fields
 * still needing a person existed only in a column no endpoint would give back.
 */
describe('skipped fields survive the run that found them', () => {
  it('comes back from GET /api/applications/:id', async () => {
    const skipped = [
      { label: 'Social Security Number', reason: 'redline', category: 'government_id' },
      { label: 'Preferred pronouns', reason: 'unclassified' },
    ];
    db.update(schema.application)
      .set({ skippedFields: skipped })
      .where(eq(schema.application.id, applicationId))
      .run();

    const res = await app.inject({ method: 'GET', url: `/api/applications/${applicationId}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().skippedFields).toEqual(skipped);
  });

  it('is an empty list, not missing, when no run has finished yet', async () => {
    db.update(schema.application)
      .set({ skippedFields: null })
      .where(eq(schema.application.id, applicationId))
      .run();

    const res = await app.inject({ method: 'GET', url: `/api/applications/${applicationId}` });
    expect(res.json().skippedFields).toEqual([]);
  });
});

/**
 * What the detail endpoint says about the application itself.
 *
 * GET /api/applications/:id answered with the posting and the answers and nothing about the
 * application's own state, and apps/web/src/pages/Applications.tsx carried a comment saying
 * so: it looked `submittedAt` up in the summary list rendered beside the detail. That is
 * right only while the list happens to be loaded and happens to contain this row — open the
 * detail before the list settles and the lookup returns undefined, so an application the user
 * had already told the tool they submitted rendered as unsubmitted and the fill panel offered
 * to open and fill the form again.
 *
 * G4 is not breached by that: the fill engine has no submit path and a human still presses
 * the button. What is wrong is the screen asserting something untrue about the user's own
 * application at the moment they are deciding what to do with it.
 */
describe('the application detail carries the application’s own state', () => {
  afterEach(() => {
    db.update(schema.application)
      .set({ status: 'draft', submittedAt: null })
      .where(eq(schema.application.id, applicationId))
      .run();
  });

  it('sends the status and submittedAt, so the screen need not look them up elsewhere', async () => {
    const when = '2026-09-01T10:00:00.000Z';
    db.update(schema.application)
      .set({ status: 'submitted', submittedAt: when })
      .where(eq(schema.application.id, applicationId))
      .run();

    const res = await app.inject({ method: 'GET', url: `/api/applications/${applicationId}` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { status?: string; submittedAt?: string | null };
    expect(body.status).toBe('submitted');
    expect(body.submittedAt).toBe(when);
  });

  it('says draft and null for one that has not been sent', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/applications/${applicationId}` });
    const body = res.json() as { status?: string; submittedAt?: string | null };
    expect(body.status).toBe('draft');
    expect(body.submittedAt).toBeNull();
  });
});

/**
 * The list of fields the student still has to fill in themselves, and when it is written down.
 *
 * The write used to sit inside `if (run.state === 'done' && run.result && run.result.filled >
 * 0)`, together with the status advance and the `filled` event. Those two want that guard —
 * a form nothing was typed into must not be walked to `awaiting_submit`, and a `filled` event
 * over it tells the tracker the form is ready to submit when it is not.
 *
 * The skipped list does not. A form whose every field is redlined — an SSN, an EEO block, an
 * attestation, nothing this tool may type — fills ZERO and produces the longest such list
 * there is. It was computed, shown once in the review panel, and never persisted: that panel
 * reads the run held in memory, which is gone when the browser closes, when a second run
 * starts and when the server stops. The student came back and the column
 * `GET /api/applications/:id` reads was empty, so the app had nothing to say about the work
 * it had left them.
 *
 * Asserted against the source because the alternative is driving a real Chromium through a
 * redline-only form to observe one column — the same reason runConflicts.test.ts reads
 * core/filling/run.ts rather than provoking each conflict. What is being pinned is which
 * condition each write sits under.
 */
describe('what a fill run records when it filled nothing', () => {
  const source = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/routes/filling.ts'),
    'utf8',
  );

  it('records the skipped fields on any finished run, not only a productive one', () => {
    // The outer condition is the one that says a run finished at all.
    expect(source).toMatch(/if \(run\.state === 'done' && run\.result\) \{/);
    // And the fill count is a separate decision, taken once and named.
    expect(source).toMatch(/const filledSomething = run\.result\.filled > 0;/);
  });

  it('still holds the status and the event behind an actual fill', () => {
    // `next && filledSomething` — a status advance needs both a legal transition and a form
    // that was really filled.
    expect(source).toMatch(/\.\.\.\(next && filledSomething \? \{ status: next \} : \{\}\)/);
    expect(source).toMatch(/if \(filledSomething\) \{[\s\S]*?type: 'filled'/);
  });

  it('does not put the skipped list behind the fill count again', () => {
    // The regression this exists to catch, stated as the shape it would take.
    expect(source).not.toMatch(/run\.result\.filled > 0\) \{[\s\S]{0,600}skippedFields: skipped/);
  });
});
