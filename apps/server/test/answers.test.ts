/**
 * Gate G3, over the wire.
 *
 * `factGuard.test.ts` proves the checker catches fabrications. This proves the server
 * refuses to approve an answer that holds one — the check has to be enforced where a
 * modified client cannot route around it.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { CandidateProfile } from '@ia/shared';
import { ulid } from 'ulid';
import type * as llm from '../src/infra/llm';
import { buildApp } from '../src/app';
import { db, schema } from '../src/infra/db/client';
import { runMigrations } from '../src/infra/db/migrate';
import { confirmProfile, saveProfile } from '../src/core/profile/repository';
import {
  classifyQuestion,
  describeEditing,
  editFraction,
  findReusable,
  saveApproved,
  wordEditDistance,
} from '../src/core/writing/answerLibrary';

/**
 * A reply is the text, or the text together with the reason the model stopped producing it.
 *
 * `stopReason` was hardcoded to null here, and null is the one value that can never show the
 * defect: `draft.ts` returned `res.text` and dropped the stop reason, so an answer cut off at
 * the token limit was stored as a finished draft and shown at G3 with nothing to say it ended
 * where the budget did. A bare string still means a whole answer, which is what nearly every
 * case in this file is about.
 */
type Reply = string | { text: string; stopReason: string | null };

/**
 * A model that answers with whatever the test hands it.
 *
 * The suite pins LLM_PROVIDER=none, which is right for every other file but meant the
 * drafting loop — the retrieve, guard, revise-once sequence in `draft.ts` — never ran under
 * test at all. That is where the defect below lived: the drafting guard was never told the
 * employer's name, so it read "Northwind Systems" as an invented organisation and spent the
 * single revision round telling the model to delete the one sentence that answered "why do
 * you want to work here". Nothing caught it, because nothing exercised it.
 *
 * The stub stays off unless a test switches it on, so the "no model access" cases below
 * still see the real resolution and still get their 400.
 */
const modelStub = vi.hoisted(() => ({
  enabled: false,
  replies: [] as Array<string | { text: string; stopReason: string | null }>,
  calls: [] as Array<{ system: string; user: string }>,
}));

vi.mock('../src/infra/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof llm>();
  return {
    ...actual,
    resolveBackend: async () =>
      modelStub.enabled
        ? {
            kind: 'api',
            available: async () => true,
            generate: async () => ({}),
            describe: () => 'stub',
          }
        : actual.resolveBackend(),
    generate: async (req: { system: string; user: string }) => {
      modelStub.calls.push({ system: req.system, user: req.user });
      const reply: Reply = modelStub.replies.shift() ?? '';
      const { text, stopReason } =
        typeof reply === 'string' ? { text: reply, stopReason: 'end_turn' } : reply;
      return { text, stopReason, provider: 'api' as const };
    },
  };
});

let app: FastifyInstance;
let applicationId: string;

const PROFILE: CandidateProfile = {
  id: 'prof_g3',
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
      coursework: [],
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
      ],
      skills: ['TypeScript'],
    },
  ],
  projects: [],
  skills: [{ name: 'TypeScript', category: 'language', evidence: [] }],
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
      canonicalUrl: `https://example.com/jobs/${postingId}`,
      applyUrl: `https://example.com/jobs/${postingId}/apply`,
      company: 'Northwind Systems',
      title: 'Software Engineering Intern, Summer 2027',
      descriptionText: 'We are hiring summer interns to work on internal developer tooling.',
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
      applyUrl: `https://example.com/jobs/${postingId}/apply`,
    })
    .run();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  db.delete(schema.applicationAnswer).run();
  db.delete(schema.answerTemplate).run();
});

async function addQuestion(questionText: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/applications/${applicationId}/questions`,
    payload: { questionText },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

async function write(id: string, text: string): Promise<void> {
  const res = await app.inject({ method: 'PATCH', url: `/api/answers/${id}`, payload: { text } });
  expect(res.statusCode).toBe(200);
}

describe('G3 — approval is blocked by unverified claims', () => {
  it('refuses to approve an answer with an invented employer', async () => {
    const id = await addQuestion('Tell us about a project you are proud of.');
    await write(id, 'I spent last summer at Google building search infrastructure.');

    const res = await app.inject({ method: 'POST', url: `/api/answers/${id}/approve` });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('UNVERIFIED_CLAIMS');
    expect(res.json().error.details.claims[0].reason).toContain('Google');

    const after = await app.inject({ method: 'GET', url: `/api/applications/${applicationId}` });
    expect(after.json().answers[0].approvedAt).toBeNull();
  });

  it('refuses to approve an inflated duration', async () => {
    const id = await addQuestion('Describe your most relevant experience.');
    await write(id, 'I worked at Kestrel Analytics for three years on their billing systems.');

    const res = await app.inject({ method: 'POST', url: `/api/answers/${id}/approve` });
    expect(res.statusCode).toBe(409);
  });

  it('approves an answer the profile supports', async () => {
    const id = await addQuestion('Tell us about a project you are proud of.');
    await write(
      id,
      'I interned at Kestrel Analytics, where I built internal tooling in TypeScript. ' +
        'The support team had been filing tickets at engineers to answer billing questions, ' +
        'so I gave them a way to resolve those themselves.',
    );

    const res = await app.inject({ method: 'POST', url: `/api/answers/${id}/approve` });
    expect(res.statusCode).toBe(200);
    expect(res.json().approvedAt).toBeTruthy();
  });

  it('drops approval when the text is edited afterwards', async () => {
    const id = await addQuestion('Tell us about a project you are proud of.');
    await write(id, 'I interned at Kestrel Analytics and built internal tooling in TypeScript.');
    expect(
      (await app.inject({ method: 'POST', url: `/api/answers/${id}/approve` })).statusCode,
    ).toBe(200);

    await write(
      id,
      'I interned at Kestrel Analytics and built internal tooling in TypeScript. Also I led the team.',
    );
    const after = await app.inject({ method: 'GET', url: `/api/applications/${applicationId}` });
    expect(after.json().answers[0].approvedAt).toBeNull();
  });

  it('refuses to approve an empty answer', async () => {
    const id = await addQuestion('Anything else you would like us to know?');
    const res = await app.inject({ method: 'POST', url: `/api/answers/${id}/approve` });
    expect(res.statusCode).toBe(400);
  });

  it('exposes no endpoint that approves every answer at once', async () => {
    for (const url of [
      `/api/applications/${applicationId}/approve`,
      `/api/applications/${applicationId}/answers/approve-all`,
      '/api/answers/approve-all',
    ]) {
      expect((await app.inject({ method: 'POST', url })).statusCode).toBe(404);
    }
  });
});

/**
 * Naming the employer you are writing to.
 *
 * The company and the role title come from the posting and are nowhere on the profile, so
 * FactGuard has to be handed them or it reads them as inventions. It was not, on any code
 * path: every answer that named Northwind Systems came back from G3 with `"Northwind
 * Systems" does not appear anywhere on your profile`, and since G3 has no override the only
 * way to satisfy that message was to add a job at Northwind the user never had — which is
 * the fabrication FactGuard exists to stop. Mentioning is all this buys, which is the second
 * half of these tests: claiming to have WORKED there is still refused.
 */
describe('G3 — the posting supplies names the profile cannot', () => {
  const approve = (id: string) => app.inject({ method: 'POST', url: `/api/answers/${id}/approve` });

  it('approves an answer that names the company it is addressed to', async () => {
    const id = await addQuestion('Why do you want to intern here?');
    await write(
      id,
      'What draws me to Northwind Systems is the quality of their developer documentation.',
    );
    const res = await approve(id);
    expect(res.statusCode, JSON.stringify(res.json())).toBe(200);
    expect(res.json().approvedAt).toBeTruthy();
  });

  it('approves it wherever in the sentence the name falls', async () => {
    // The company opening the sentence goes down a different branch of the name extractor
    // (`extractProperNouns` drops a lone capitalised opener), so a fix proved only on a
    // mid-sentence mention would leave this one blocked.
    const id = await addQuestion('Why do you want to intern here?');
    await write(
      id,
      'Northwind Systems builds the kind of internal tooling I spent last summer building.',
    );
    expect((await approve(id)).statusCode).toBe(200);
  });

  it('extends the same allowance to the role title', async () => {
    const id = await addQuestion('Why are you interested in this role?');
    await write(
      id,
      'I am applying for the Software Engineering Intern role because Northwind Systems ' +
        'works on developer tooling.',
    );
    expect((await approve(id)).statusCode).toBe(200);
  });

  it('still refuses a claim of having worked there', async () => {
    const id = await addQuestion('Describe your most relevant experience.');
    await write(id, 'I interned at Northwind Systems last summer and shipped their billing tools.');
    const res = await approve(id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('UNVERIFIED_CLAIMS');
    expect(res.json().error.details.claims[0].reason).toMatch(/employer you are applying to/);
  });

  it('still refuses an employer that is neither on the profile nor on the posting', async () => {
    const id = await addQuestion('Tell us about a project you are proud of.');
    await write(id, 'I spent last summer at Google building search infrastructure.');
    expect((await approve(id)).statusCode).toBe(409);
  });

  it('stores no blocking flag for the mention when the answer is merely edited', async () => {
    // The PATCH route re-verifies too, and it was the same call with the same missing
    // argument. Left unfixed, approval would succeed while the review screen went on
    // showing a red "does not appear anywhere on your profile" against the same sentence.
    const id = await addQuestion('Why do you want to intern here?');
    await write(id, 'What draws me to Northwind Systems is their developer documentation.');

    const after = await app.inject({ method: 'GET', url: `/api/applications/${applicationId}` });
    const flags = after.json().answers[0].flags as Array<{ type: string }>;
    expect(flags.filter((f) => f.type === 'unsupported' || f.type === 'overstated')).toEqual([]);
  });
});

/**
 * Gate G1, from the approval side.
 *
 * The fact check runs against the confirmed profile, so with no confirmed profile there is
 * nothing to check a claim against. A verification that could not run must not read as a
 * verification that passed: a null result once meant "zero blocking flags", which let any
 * text at all through the gate and on towards an employer's form.
 */
describe('G1 — approval needs a confirmed profile', () => {
  afterEach(() => {
    confirmProfile();
  });

  it('refuses to approve while the profile is unconfirmed', async () => {
    const id = await addQuestion('Tell us about a project you are proud of.');
    // Text the profile fully supports, so G1 is the only thing that can refuse it.
    await write(id, 'I interned at Kestrel Analytics and built internal tooling in TypeScript.');

    // The fixture is declared with `confirmedAt: null`, so writing it back un-confirms it.
    saveProfile(PROFILE);

    const res = await app.inject({ method: 'POST', url: `/api/answers/${id}/approve` });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('PROFILE_INCOMPLETE');
    expect(res.json().error.message).toMatch(/confirm your profile/i);

    // And nothing was stamped on the way past.
    expect(db.select().from(schema.applicationAnswer).all()[0]!.approvedAt).toBeNull();
  });
});

/**
 * The suite pins LLM_PROVIDER=none (see vitest.setup.ts), so "no model available" is the
 * deterministic state here regardless of what is installed on the machine running it.
 */
describe('drafting without model access', () => {
  it('explains the situation instead of failing opaquely', async () => {
    const id = await addQuestion('Why do you want to intern here?');
    const res = await app.inject({ method: 'POST', url: `/api/answers/${id}/draft` });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('NO_MODEL_ACCESS');
    // Names both routes in, and the fallback. A dead end here is a dead end for the app.
    expect(res.json().error.message).toContain('Claude Code CLI');
    expect(res.json().error.message).toContain('write the answer yourself');
  });

  it('reports what is and is not available, without pretending', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/model-access' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.available).toBe(false);
    expect(body.provider).toBe('none');
    // The limitations have to say the rest of the app still works, or a user with no
    // model access will reasonably assume the whole tool is broken.
    expect(body.limitations.join(' ')).toMatch(/Everything else works/);
  });

  it('still fact-checks an answer the user wrote by hand', async () => {
    const id = await addQuestion('Tell us about a project you are proud of.');
    await write(id, 'I spent last summer at Google building search infrastructure.');
    const res = await app.inject({ method: 'POST', url: `/api/answers/${id}/approve` });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('UNVERIFIED_CLAIMS');
  });
});

describe('answer library', () => {
  it('classifies the questions that actually get asked', () => {
    expect(classifyQuestion('Why do you want to work at Northwind?').archetype).toBe('why_company');
    expect(classifyQuestion('Why are you interested in this role?').archetype).toBe('why_role');
    expect(classifyQuestion('Tell us about a project you are proud of.').archetype).toBe(
      'proud_of',
    );
    expect(classifyQuestion('Describe a challenging bug you fixed.').archetype).toBe('challenge');
    expect(classifyQuestion('How did you hear about this opening?').archetype).toBe('how_heard');
  });

  it('gives unrecognised questions a key that survives rewording', () => {
    const a = classifyQuestion('What is your favorite text editor?');
    const b = classifyQuestion('Please, briefly: what is your favorite text editor? (100 words)');
    expect(a.archetype).toBe('other');
    expect(a.key).toBe(b.key);
  });

  it('reuses a general answer across companies', () => {
    saveApproved('Tell us about a project you are proud of.', 'The tide chart.', 'Kestrel');
    expect(findReusable('Tell us about a project you are proud of.', 'Northwind')?.text).toBe(
      'The tide chart.',
    );
  });

  it('never reuses a company-specific answer for a different company', () => {
    saveApproved('Why do you want to work at Kestrel?', 'Because Kestrel does X.', 'Kestrel');
    expect(findReusable('Why do you want to work at Northwind?', 'Northwind')).toBeNull();
    expect(findReusable('Why do you want to work at Kestrel?', 'Kestrel')?.text).toBe(
      'Because Kestrel does X.',
    );
  });

  it('offers nothing that was never approved', () => {
    expect(findReusable('Tell us about a project you are proud of.', 'Northwind')).toBeNull();
  });

  it('never reuses an answer whose own text names the company it was written for', () => {
    // The archetype flag says whether a good answer to this QUESTION names the company;
    // it says nothing about what the writer actually typed. A `proud_of` answer is
    // reusable by archetype, so before this check one that happened to name Kestrel was
    // handed to the next application verbatim and the Northwind form went out talking
    // about Kestrel. Reuse is a convenience; a letter addressed to the wrong employer
    // ends the application, so the ambiguous case is refused and the user writes fresh.
    saveApproved(
      'Tell us about a project you are proud of.',
      'I built internal tooling at Kestrel.',
      'Kestrel',
    );
    expect(findReusable('Tell us about a project you are proud of.', 'Northwind')).toBeNull();
    expect(findReusable('Tell us about a project you are proud of.', 'Kestrel')?.text).toContain(
      'Kestrel',
    );
  });

  /**
   * The two shapes of company name the whole-string check could not see.
   *
   * Companies are stored exactly as the posting writes them — "IBM Corp.", "Box, Inc." —
   * while the sentence a person types says "IBM" or "Box". Looking for the stored string as
   * one run therefore hunted for "ibm corp", which appears in nobody's prose, and the answer
   * was handed to the next employer. Whether reuse was refused turned on whether the posting
   * happened to carry a full stop, which is not a distinction anyone could have predicted
   * from the outside.
   *
   * The short name is the second half of it. A three-letter word is normally too common to
   * treat as a company mention, but IBM, SAP, AWS and GE are the whole distinctive name
   * rather than a fragment of one, so an all-caps run is exempt from that floor. "Box" is
   * the case in the other direction: short, ordinary, and still the company's entire name.
   *
   * The cases are picked so each half of the check is the one deciding somewhere. "Box,
   * Inc." is caught only by dropping the legal suffix and looking for the whole remaining
   * run; "IBM Watson Health" is caught only by the per-word pass, where the three-letter
   * exemption is what keeps "IBM" in the running.
   */
  it.each([['IBM'], ['IBM Corp.'], ['IBM Corporation'], ['IBM Watson Health']])(
    'refuses to reuse an answer naming IBM when it was written for %s',
    (stored) => {
      saveApproved(
        'Tell us about a project you are proud of.',
        'IBM is where mainframes still matter, and that is exactly the kind of unfashionable ' +
          'problem I want.',
        stored,
      );
      expect(findReusable('Tell us about a project you are proud of.', 'Northwind')).toBeNull();
      // And it is still offered back to the company it was written for.
      expect(findReusable('Tell us about a project you are proud of.', stored)?.text).toContain(
        'IBM',
      );
    },
  );

  it.each([['Box'], ['Box, Inc.']])(
    'refuses to reuse an answer naming Box when it was written for %s',
    (stored) => {
      saveApproved(
        'Tell us about a project you are proud of.',
        'The Box integration is the piece of that project I am proudest of.',
        stored,
      );
      expect(findReusable('Tell us about a project you are proud of.', 'Northwind')).toBeNull();
    },
  );

  it('does not treat a longer name that merely starts the same as a mention', () => {
    // The check matches whole word runs, not substrings. "Boxer Holdings" shares its opening
    // with "Box" and appears nowhere in this text, so refusing here would cost the user a
    // reuse for nothing — and a check that refused everything would stop being consulted.
    saveApproved(
      'Tell us about a project you are proud of.',
      'The Box integration is the piece of that project I am proudest of.',
      'Boxer Holdings',
    );
    expect(findReusable('Tell us about a project you are proud of.', 'Northwind')?.text).toContain(
      'Box integration',
    );
  });

  it('pre-fills from the library but does not approve', async () => {
    // The stored text deliberately does not name Kestrel, the company it was written for.
    // Reuse across companies is refused for text that names its own company (see the test
    // above), and this case is about the pre-fill/approve split, not about that refusal.
    saveApproved(
      'Tell us about a project you are proud of.',
      'I built internal tooling that let support close billing tickets without an engineer.',
      'Kestrel',
    );
    const res = await app.inject({
      method: 'POST',
      url: `/api/applications/${applicationId}/questions`,
      payload: { questionText: 'Tell us about a project you are proud of.' },
    });
    expect(res.json().text).toContain('internal tooling');
    expect(res.json().approvedAt).toBeNull();
    expect(res.json().reusedFrom).not.toBeNull();
  });
});

describe('edit distance', () => {
  it('counts words, not characters', () => {
    expect(wordEditDistance('I built a parser', 'I built a parser')).toBe(0);
    expect(wordEditDistance('I built a parser', 'I built a compiler')).toBe(1);
    expect(wordEditDistance('', 'three words here')).toBe(3);
  });

  it('reports a fraction the meter can show', () => {
    expect(editFraction('I built a parser', 'I built a parser')).toBe(0);
    expect(editFraction('a b c d', 'w x y z')).toBe(1);
    expect(describeEditing(0)).toContain('unchanged');
    expect(describeEditing(0.9)).toContain('writing sample');
  });
});

/**
 * The resume this tool actually gets: sixteen activities, one school, and bullets stacked on
 * the two or three things the student really did.
 *
 * Retrieval builds a corpus sized for a drafting prompt, and the gate was taking that size as
 * its own. It also took a different query — drafting scores the profile against "<title> at
 * <company>\n\n<description>" and the gate scored it against the description alone — so the
 * two ends of one request ranked the same resume differently and kept different tails of it.
 * This fixture holds fifty-one facts against a corpus of forty; the twelve outside it were
 * facts no answer could be checked against, and quoting one came back from approval as
 * `"Orchard Street" does not appear anywhere on your profile`, at a gate with no override,
 * about a line the student typed into their own profile.
 *
 * Both halves are covered below, in both directions: every entry and several of the late
 * bullets have to approve, and an invented organisation, an invented bullet, an inflated
 * duration, a wrong GPA and a claim of having worked at the company being applied to all have
 * to keep coming back 409.
 */
/**
 * The busy entries, with the bullets the student typed under them.
 *
 * Enough of them that the profile carries more facts than the retrieval floor: fifty-one
 * facts against a corpus of forty. The gate was taking that cut, so twelve of this student's
 * own bullets were facts their answer could not be checked against, and quoting one of them
 * came back `"Orchard Street" does not appear anywhere on your profile`.
 */
const BULLETS: Record<string, string[]> = {
  'The Sample Sentinel (Student Newspaper)': [
    'Ran the weekly budget meeting for a staff of twenty-two',
    'Filed public records requests to the Maplewood school board',
    'Rebuilt the paper site on Eleventy after the old host shut down',
    'Started the Ledger column tracking district spending',
    'Trained six freshman reporters on interviewing',
    'Covered the Fairhaven levy campaign from filing to certification',
    'Set the Orchard Street photo essay in print for the spring issue',
    'Wrote the Founders Day retrospective from the 1974 archive',
  ],
  'Model United Nations, St. Sample High School': [
    'Chaired the Kellerman crisis committee for eighty delegates',
    'Wrote the position paper on the Tanzania delegation',
    'Ran novice training every Thursday in the Bellweather room',
    'Booked the Harrowgate hotel block for the spring conference',
    'Kept the gavel roster for four regional conferences',
    'Raised the delegation fee waiver with the Whitmore fund',
    'Drafted the Sandpiper resolution adopted in committee',
    'Recruited eleven freshmen at the Larkspur activities fair',
  ],
  'DECA, St. Sample Chapter': [
    'Built the Pemberton marketing plan for the state series',
    'Ran the Coldbrook fundraiser for chapter travel',
    'Kept the Ashfield sponsor list current all season',
    'Led role-play practice in the Thornbury lab twice a week',
    'Organised the Winterset chapter banquet for ninety guests',
    'Wrote the Marchmont chapter newsletter each month',
    'Trained the Ellery novice team before districts',
    'Tracked the Ravenswood budget through two audits',
  ],
  'Science Olympiad': [
    'Built the Halloway mousetrap vehicle for regionals',
    'Studied the Ardsley anatomy set with a partner weekly',
    'Ran the Fernhill build night in the machine shop',
    'Kept the Grimsby event roster for twenty-three members',
    'Wrote the Ferndale study guide for Disease Detectives',
    'Repaired the Kingsbury tower after the state tournament',
    'Scheduled the Merribell practice tests each January',
    'Coached the Northgate freshmen on Anatomy and Physiology',
  ],
  'Northside Robotics Boosters': [
    'Ran the Founders Day fundraiser that paid for competition travel',
    'Kept the parts ledger for the Vex team',
  ],
};

const ACTIVITIES: Array<[org: string, title: string, type: 'club' | 'volunteer' | 'job']> = [
  ['St. Sample High School Speech & Debate Team', 'Captain', 'club'],
  ['Model United Nations, St. Sample High School', 'Secretary-General', 'club'],
  ['The Sample Sentinel (Student Newspaper)', 'Editor-in-Chief', 'club'],
  ['DECA, St. Sample Chapter', 'Chapter President', 'club'],
  ['FBLA', 'Vice President of Finance', 'club'],
  ['Science Olympiad', 'Team Captain', 'club'],
  ['St. Sample Players (Theatre)', 'Stage Manager', 'club'],
  ['St. Sample Players (Theatre)', 'Lighting Designer', 'club'],
  ['St. Sample High School Concert and Jazz Band', 'Section Leader, Trumpet', 'club'],
  ['Sample Valley Medical Center', 'Volunteer, Emergency Department', 'volunteer'],
  ['Riverbend Youth Soccer League', 'Assistant Coach', 'volunteer'],
  ['St. Sample High School Varsity Soccer', 'Team Captain', 'club'],
  ['Bright Minds Tutoring Center', 'Math Tutor', 'job'],
  ['Oakwood Community Pool', 'Lifeguard', 'job'],
  ['Key Club International', 'Chapter Treasurer', 'volunteer'],
  ['Northside Robotics Boosters', 'Fundraising Chair', 'club'],
];

const CLUBS_PROFILE: CandidateProfile = {
  ...PROFILE,
  fullName: 'Priya Ramanathan-Cole',
  email: 'priya.rc@example.edu',
  dateOfBirth: '2009-04-02',
  education: [
    {
      institution: 'St. Sample High School',
      level: 'high_school',
      startDate: '2022-08',
      endDate: '2026-05',
      gpa: { value: 3.972, scale: 4 },
      coursework: ['AP Calculus BC', 'AP Biology'],
      honors: ['National Merit Semifinalist (2025)'],
    },
  ],
  experience: ACTIVITIES.map(([organization, title, type]) => ({
    organization,
    title,
    type,
    // The Lifeguard job is a real summer, deliberately short: it is what the inflated
    // duration below is measured against.
    startDate: title === 'Lifeguard' ? '2025-05' : '2023-09',
    endDate: title === 'Lifeguard' ? '2025-08' : '2026-05',
    bullets: BULLETS[organization] ?? [],
    skills: [],
  })),
  projects: [],
  skills: [],
} as CandidateProfile;

describe('G3 — a resume that is mostly clubs, and the ranking that hid half of it', () => {
  let clubsApplicationId: string;

  beforeAll(() => {
    saveProfile(CLUBS_PROFILE);
    confirmProfile();

    const postingId = ulid();
    db.insert(schema.jobPosting)
      .values({
        id: postingId,
        canonicalUrl: `https://example.com/jobs/${postingId}`,
        applyUrl: `https://example.com/jobs/${postingId}/apply`,
        company: 'Nova Robotics',
        title: 'Summer Communications Intern',
        descriptionText:
          'A summer programme for high school students in Ohio. The intern helps with ' +
          'outreach writing and event logistics.',
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

    clubsApplicationId = ulid();
    db.insert(schema.application)
      .values({
        id: clubsApplicationId,
        matchId,
        status: 'draft',
        applyUrl: `https://example.com/jobs/${postingId}/apply`,
      })
      .run();
  });

  afterAll(() => {
    saveProfile(PROFILE);
    confirmProfile();
  });

  async function ask(questionText: string, text: string): Promise<string> {
    const created = await app.inject({
      method: 'POST',
      url: `/api/applications/${clubsApplicationId}/questions`,
      payload: { questionText },
    });
    const id = created.json().id as string;
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/answers/${id}`,
      payload: { text },
    });
    expect(patched.statusCode).toBe(200);
    return id;
  }

  const approve = (id: string) => app.inject({ method: 'POST', url: `/api/answers/${id}/approve` });

  // Every entry, not the one from the bug report. The ranking dropped a different pair for
  // every question, so a fix proved on one activity says nothing about the other fifteen.
  it.each(ACTIVITIES)('approves a true sentence about %s', async (organization, title) => {
    const id = await ask(
      'Tell us about a time you took responsibility for something.',
      `I was ${title} at ${organization}.`,
    );
    const res = await approve(id);
    expect(res.statusCode, JSON.stringify(res.json())).toBe(200);
  });

  it('approves the club that only the employer name ranks into view', async () => {
    // The reported case, verbatim. "robotics" appears in Nova Robotics and in Northside
    // Robotics Boosters, which is exactly why the drafting query kept this entry and the
    // description-only query did not.
    const id = await ask(
      'Tell us about a time you took responsibility for something.',
      'I am the Fundraising Chair of the Northside Robotics Boosters.',
    );
    const res = await approve(id);
    expect(res.statusCode, JSON.stringify(res.json())).toBe(200);
  });

  // Retrieval keeps one fact from every entry before any entry gets a second, so the entry
  // headlines above survive any cut. The bullets do not: this profile holds fifty-one facts
  // and the corpus floor is forty, and the twelve that fall past it were the gate's blind
  // spot. A student quoting their own resume line got `"Orchard Street" does not appear
  // anywhere on your profile`.
  it.each([
    'I set the Orchard Street photo essay in print for the spring issue.',
    'I drafted the Sandpiper resolution that was adopted in committee.',
    'I tracked the Ravenswood budget through two audits.',
    'I coached the Northgate freshmen on Anatomy and Physiology.',
  ])('approves a bullet that falls past the corpus floor: %s', async (text) => {
    const id = await ask('What are you most proud of?', text);
    const res = await approve(id);
    expect(res.statusCode, JSON.stringify(res.json())).toBe(200);
  });

  it('approves a sentence that names the company being applied to', async () => {
    const id = await ask(
      'Why do you want to intern at Nova Robotics?',
      'What draws me to Nova Robotics is the outreach programme you run with public high schools.',
    );
    expect((await approve(id)).statusCode).toBe(200);
  });

  it('stores no blocking flag against any of it', async () => {
    const id = await ask(
      'Tell us about a time you took responsibility for something.',
      'I am the Fundraising Chair of the Northside Robotics Boosters, and I was Assistant ' +
        'Coach at Riverbend Youth Soccer League.',
    );
    const res = await app.inject({ method: 'GET', url: `/api/applications/${clubsApplicationId}` });
    const row = (res.json().answers as Array<{ id: string; flags: Array<{ type: string }> }>).find(
      (a) => a.id === id,
    )!;
    expect(row.flags.filter((f) => f.type === 'unsupported' || f.type === 'overstated')).toEqual(
      [],
    );
  });

  /**
   * The other direction, on the same profile and the same posting. A wider evidence set at
   * the gate must not become a wider gate: an organisation the profile has never heard of is
   * still refused, and so is a real one stretched past what its dates say.
   */
  it.each([
    [
      'an employer nowhere on the profile',
      'I spent last summer at Google building search infrastructure.',
    ],
    [
      'a club that sounds like one of theirs but is not',
      'I was the Fundraising Chair of the Westside Robotics Boosters.',
    ],
    [
      'a claim of having worked at the company applied to',
      'I interned at Nova Robotics last summer and ran their outreach programme.',
    ],
    [
      'a summer job stretched into six years',
      'I have worked as a lifeguard at Oakwood Community Pool for six years.',
    ],
    ['a GPA that is not theirs', 'I kept a 3.5 GPA through high school.'],
    // The two written to sit beside a real bullet, since the corpus the gate now holds is a
    // bigger token union and lexical coverage is the one check a bigger union can soften.
    [
      'a photo essay they never set',
      'I set the Bellingham photo essay in print for the spring issue.',
    ],
    ['a resolution they never drafted', 'I drafted the Kittiwake resolution in committee.'],
  ])('still refuses %s', async (_label, text) => {
    const id = await ask('Tell us about a time you took responsibility for something.', text);
    const res = await approve(id);
    expect(res.statusCode, text).toBe(409);
    expect(res.json().error.code).toBe('UNVERIFIED_CLAIMS');
  });
});

/**
 * The drafting loop, with a stub model.
 *
 * `draftAnswer` guards its own first draft and gets one revision to fix what it finds. That
 * guard was never handed the company and the role title, so it reported the employer's own
 * name as an invention, the revision message quoted the sentence back and told the model to
 * drop it, and the shortened draft passed the better-than check because it had one fewer
 * blocking claim. The user opened G3 and read an answer to "why do you want to work here"
 * with the employer taken out of it. Nothing was red, so nothing said why.
 */
describe('drafting — the two names the profile cannot supply', () => {
  beforeEach(() => {
    modelStub.enabled = true;
    modelStub.replies = [];
    modelStub.calls = [];
  });
  afterEach(() => {
    modelStub.enabled = false;
  });

  const draft = (id: string) => app.inject({ method: 'POST', url: `/api/answers/${id}/draft` });

  it('keeps the sentence naming the company, and spends no revision on it', async () => {
    modelStub.replies = [
      'What draws me to Northwind Systems is the developer tooling. Last summer I built ' +
        'internal tooling at Kestrel Analytics that let the support team resolve billing ' +
        'tickets without an engineer, and that is the work I want more of.',
    ];
    const id = await addQuestion('Why do you want to intern at Northwind Systems?');
    const res = await draft(id);

    expect(res.statusCode, JSON.stringify(res.json())).toBe(200);
    expect(modelStub.calls, 'a second call means the revision round was spent').toHaveLength(1);
    expect(res.json().text).toContain('Northwind Systems');
    expect(res.json().revised).toBe(false);
    expect(res.json().unresolved).toBe(false);
    expect(
      (await app.inject({ method: 'POST', url: `/api/answers/${id}/approve` })).statusCode,
    ).toBe(200);
  });

  it('still sends a fabricated employer back, and names it rather than the company', async () => {
    modelStub.replies = [
      'What draws me to Northwind Systems is the developer tooling they build. I spent last ' +
        'summer at Google building search infrastructure.',
      'What draws me to Northwind Systems is the developer tooling they build. Last summer I ' +
        'built internal tooling at Kestrel Analytics so the support team could close billing ' +
        'tickets without an engineer.',
    ];
    const id = await addQuestion('Why do you want to intern at Northwind Systems?');
    const res = await draft(id);

    expect(modelStub.calls).toHaveLength(2);
    const revision = modelStub.calls[1]!.user;
    expect(revision).toContain('Google');
    expect(revision).not.toContain('"Northwind Systems" does not appear');
    expect(res.json().text).toContain('Kestrel Analytics');
    expect(res.json().text).toContain('Northwind Systems');
    expect(res.json().revised).toBe(true);
    expect(res.json().unresolved).toBe(false);
  });

  it('reports unresolved only when the flags stored beside it block', async () => {
    // Both attempts invent the same employer, so the revision is no better and the first
    // draft stands. The response said `unresolved` from the drafting loop's own guard while
    // the flags on the row came from the gate's, and the two ran against different evidence
    // and different names: the client could be told an answer still had unverified claims
    // while the row beside it was clean and the approve endpoint would have taken it.
    modelStub.replies = [
      'I spent last summer at Google building search infrastructure for a team of thirty.',
      'I spent two years at Google, mostly on search.',
    ];
    const id = await addQuestion('Tell us about a project you are proud of.');
    const res = await draft(id);
    const body = res.json();

    expect(body.unresolved).toBe(true);
    const blocking = (body.flags as Array<{ type: string }>).filter(
      (f) => f.type === 'unsupported' || f.type === 'overstated',
    );
    expect(blocking.length).toBeGreaterThan(0);
    expect(
      (await app.inject({ method: 'POST', url: `/api/answers/${id}/approve` })).statusCode,
    ).toBe(409);
  });

  it('drafts the evidence the gate will check it against', async () => {
    // The drafting prompt carries the evidence block verbatim, so the refs in it are the set
    // the model was told it may write from. Every one of them has to still be a fact about
    // this person when the same text comes back to the gate; that is the whole invariant.
    modelStub.replies = ['I built internal tooling at Kestrel Analytics.'];
    const id = await addQuestion('Tell us about a project you are proud of.');
    await draft(id);

    const evidenceBlock = modelStub.calls[0]!.system;
    expect(evidenceBlock).toContain('[experience.0]');
    expect(evidenceBlock).toContain('Kestrel Analytics');
    // The posting's words reach retrieval, which is what made the two sets disagree.
    expect(modelStub.calls[0]!.user).toContain('Northwind Systems');
  });
});

/**
 * A draft the model was still writing.
 *
 * `draftAnswer` asked for the text and threw the stop reason away. So a model that ran out of
 * output budget — `maxTokens` is `max(1500, maxWords * 6)`, and an adaptive-thinking call
 * spends part of that before writing a word — stopped mid-sentence, and the fragment was
 * written over `draftText`, `finalText` and `approvedAt` and rendered at G3 as a finished
 * draft. Nothing was red, because half of a true sentence is still true: FactGuard has no
 * opinion about an answer that stops, and the style pass reads it as a terse one. The student
 * approves what they are shown.
 *
 * `extractProfile.ts` has named `max_tokens` as its own failure since the resume path was
 * written. This is the same stop reason on the path where the text goes on to an employer.
 */
describe('drafting — an answer that did not come back whole', () => {
  beforeEach(() => {
    modelStub.enabled = true;
    modelStub.replies = [];
    modelStub.calls = [];
  });
  afterEach(() => {
    modelStub.enabled = false;
  });

  const draft = (id: string) => app.inject({ method: 'POST', url: `/api/answers/${id}/draft` });
  const stored = async (): Promise<Record<string, unknown>> => {
    const res = await app.inject({ method: 'GET', url: `/api/applications/${applicationId}` });
    return res.json().answers[0] as Record<string, unknown>;
  };

  const CUT_OFF =
    'What draws me to Northwind Systems is the developer tooling. Last summer I built ' +
    'internal tooling at Kestrel Analytics that let the support team resolve billing tickets ' +
    'without an engineer, and the part I keep coming back to is the';

  it('does not hand over a draft that stopped at the token limit', async () => {
    modelStub.replies = [{ text: CUT_OFF, stopReason: 'max_tokens' }];
    const id = await addQuestion('Why do you want to intern at Northwind Systems?');
    const res = await draft(id);

    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe('DRAFT_FAILED');

    // The fragment reached neither the row nor the workspace that renders it.
    const row = await stored();
    expect(row.text).toBe('');
    expect(row.draftText).toBe('');
  });

  it('leaves an already approved answer exactly where it was when a redraft is cut off', async () => {
    // The reason this fails rather than returning the fragment with a flag on it: the route
    // writes the returned text over draftText, finalText AND approvedAt before anything looks
    // at a flag. A student redrafting an answer they had already approved lost it to a
    // sentence that stops mid-word, and the tick with it.
    const approved =
      'I interned at Kestrel Analytics, where I built internal tooling in TypeScript. ' +
      'The support team had been filing tickets at engineers to answer billing questions, ' +
      'so I gave them a way to resolve those themselves.';
    const id = await addQuestion('Tell us about a project you are proud of.');
    await write(id, approved);
    expect(
      (await app.inject({ method: 'POST', url: `/api/answers/${id}/approve` })).statusCode,
    ).toBe(200);

    modelStub.replies = [{ text: CUT_OFF, stopReason: 'max_tokens' }];
    expect((await draft(id)).statusCode).toBe(502);

    const row = await stored();
    expect(row.text).toBe(approved);
    expect(row.approvedAt).toBeTruthy();
  });

  it('does not store an empty answer as a draft', async () => {
    modelStub.replies = [''];
    const id = await addQuestion('Anything else you would like us to know?');
    const res = await draft(id);

    expect(res.statusCode).toBe(502);
    expect((await stored()).text).toBe('');
  });

  it('does not store what the model wrote before it declined', async () => {
    // A refusal is named rather than left to the empty case, because the API path can return
    // the part it had written before it stopped — not empty, and not an answer either.
    modelStub.replies = [{ text: 'I can help with that, but I should say', stopReason: 'refusal' }];
    const id = await addQuestion('Why do you want to intern at Northwind Systems?');

    expect((await draft(id)).statusCode).toBe(502);
    expect((await stored()).text).toBe('');
  });

  it('keeps a whole first draft rather than a revision that stopped mid-word', async () => {
    /**
     * The sibling, and the one the revision loop was biased towards.
     *
     * `better` counts blocking claims and tells, and half an answer carries fewer of both — so
     * a truncated revision beats a complete first draft by construction, every time. The first
     * draft here invents Google, which the user needs to see and fix at G3; the revision
     * stops mid-sentence with nothing left to flag, and used to replace it. The user was then
     * shown a fragment with a clean bill, and the sentence that was wrong had been dropped
     * rather than corrected.
     */
    modelStub.replies = [
      'What draws me to Northwind Systems is the developer tooling they build. I spent last ' +
        'summer at Google building search infrastructure.',
      {
        text:
          'What draws me to Northwind Systems is the developer tooling they build. Last ' +
          'summer I built internal tooling at',
        stopReason: 'max_tokens',
      },
    ];
    const id = await addQuestion('Why do you want to intern at Northwind Systems?');
    const res = await draft(id);
    const body = res.json();

    expect(res.statusCode).toBe(200);
    expect(modelStub.calls, 'the revision was still asked for').toHaveLength(2);
    expect(body.text).toContain('Google');
    expect(body.text.trim().endsWith('.')).toBe(true);
    // And the fabrication it carries is still the user's to resolve at G3.
    expect(body.unresolved).toBe(true);
  });
});
