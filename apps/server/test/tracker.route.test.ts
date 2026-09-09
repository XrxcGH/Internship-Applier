/**
 * The tracker over the wire. The point of interest is that the status endpoint refuses
 * transitions the model forbids, rather than trusting whatever the client sends.
 *
 * The last two blocks are about the same rule seen from the other side. An application that
 * has reached a status only the USER can set has left this tool's hands (core/tracking/status
 * .ts), and everything hanging off it — its answers, the G2 decision that created it — stops
 * being a workspace and becomes the record of something that happened in the world. Both of
 * those were being rewritten by endpoints that never looked.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { ulid } from 'ulid';
import type { CandidateProfile } from '@ia/shared';
import { buildApp } from '../src/app';
import { db, schema } from '../src/infra/db/client';
import { runMigrations } from '../src/infra/db/migrate';
import { saveProfile } from '../src/core/profile/repository';

let app: FastifyInstance;
let applicationId: string;
let matchId: string;

/**
 * A profile that reads back.
 *
 * The row this file used to write by hand — `{ fullName: 'x', email: 'x' }` straight into the
 * table — held plaintext in the six encrypted columns, so `getProfile` threw "the stored
 * profile could not be decrypted" and every route that so much as looks at the profile
 * answered 500 here. That is a property of the fixture, not of the code under test, and it
 * put the add-a-question endpoint out of reach of this file entirely. Written through
 * `saveProfile`, which is also what the key material expects: a hand-written row counts as
 * stored ciphertext, so the keychain refuses to mint a key afterwards.
 *
 * The id stays `p1`, which is what the match row below points at.
 */
const PROFILE = {
  id: 'p1',
  fullName: 'Rosa Alvarez',
  pronouns: null,
  email: 'rosa@example.edu',
  dateOfBirth: '2006-03-15',
  address: { country: 'US' },
  links: { other: [] },
  workAuthorization: { country: 'US', status: 'citizen', needsSponsorship: false },
  citizenships: ['US'],
  education: [],
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
} as unknown as CandidateProfile;

beforeAll(async () => {
  runMigrations();
  app = await buildApp({ skipAuth: true });
  await app.ready();

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
      atsVendor: 'greenhouse',
    })
    .run();

  // Through the repository, sealed the way the app seals it. See PROFILE above.
  saveProfile(PROFILE);

  matchId = ulid();
  db.insert(schema.match)
    .values({
      id: matchId,
      postingId,
      profileId: 'p1',
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
      status: 'awaiting_submit',
      applyUrl: `https://example.com/j/${postingId}/apply`,
    })
    .run();
});

afterAll(async () => {
  await app.close();
});

describe('the tracker view', () => {
  it('returns applications, reminders, and stats together', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/tracker' });
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b.applications).toHaveLength(1);
    expect(b.applications[0].derived.attention).toBe('awaiting_your_submit');
    expect(b.reminders.length).toBeGreaterThan(0);
    expect(b.stats.funnel.total).toBe(1);
  });

  it('refuses to show a rate it cannot support', async () => {
    const b = (await app.inject({ method: 'GET', url: '/api/tracker' })).json();
    expect(b.stats.responseRate.value).toBeNull();
    expect(b.stats.responseRate.why).toBeTruthy();
  });
});

describe('status changes', () => {
  it('refuses a transition the model forbids', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/applications/${applicationId}/status`,
      payload: { status: 'offer' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('ILLEGAL_TRANSITION');
  });

  it('refuses to let ghosted be set by hand', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/applications/${applicationId}/status`,
      payload: { status: 'ghosted' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/worked out from how long/i);
  });

  it('accepts the user reporting a submission, and stamps the time', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/applications/${applicationId}/status`,
      payload: { status: 'submitted' },
    });
    expect(res.statusCode).toBe(200);

    const row = db.select().from(schema.application).all()[0]!;
    expect(row.submittedAt).toBeTruthy();

    // The event log records who, because that is the whole distinction.
    const ev = db
      .select()
      .from(schema.applicationEvent)
      .all()
      .find((e) => e.type === 'status_changed')!;
    expect((ev.payload as { by: string }).by).toBe('user');
  });
});

describe('drafts and export', () => {
  it('returns a follow-up as text, and says it sends nothing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/applications/${applicationId}/draft-message`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().text).toContain('Subject:');
    expect(res.json().note).toMatch(/nothing here sends email/i);
  });

  it('exports CSV with the right headers', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/tracker/export.csv' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.body).toContain('Company');
    expect(res.body).toContain('Northwind Systems');
  });
});

describe('gate G4 holds in the tracker too', () => {
  it('has no endpoint that submits', async () => {
    for (const url of ['/api/tracker/submit', `/api/applications/${applicationId}/send`]) {
      expect((await app.inject({ method: 'POST', url })).statusCode, url).toBe(404);
    }
  });
});

/**
 * A word ceiling sent when the question is added.
 *
 * `maxWords` was validated by the question route — 3000 came back a 400 naming the field —
 * and then destructured away, so the number a caller was told was too big was a number
 * nothing would ever read. A limit worth rejecting is a limit somebody believes is being
 * honoured. There is no column to store it in and drafting takes the ceiling per request, so
 * what the route owes is to hand it back and say who has to carry it the rest of the way.
 *
 * Here rather than in answers.test.ts because this file already has an application to hang a
 * question off, and the fixture is the same one the blocks below use.
 */
describe('the word ceiling on a question', () => {
  beforeEach(() => {
    db.delete(schema.applicationAnswer).run();
    db.update(schema.application)
      .set({ status: 'draft', submittedAt: null })
      .where(eq(schema.application.id, applicationId))
      .run();
  });

  it('comes back with the question, and says where to send it', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/applications/${applicationId}/questions`,
      payload: { questionText: 'Describe a project you are proud of.', maxWords: 150 },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().maxWords).toBe(150);
    // Named endpoint, not a vague caveat: the ceiling only reaches the prompt through the
    // draft call, and the caller has to be told which one.
    expect(res.json().notes.join(' ')).toContain(`/api/answers/${res.json().id as string}/draft`);
  });

  it('says nothing when no ceiling was asked for', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/applications/${applicationId}/questions`,
      payload: { questionText: 'Why this team?' },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().maxWords).toBeNull();
    expect(res.json().notes).toEqual([]);
  });
});

/**
 * The answers of an application the user has already sent.
 *
 * `draft_text` and `final_text` are the ONLY copy of what an employer was told — nothing else
 * in this app keeps a version of an answer — and every endpoint under /api/answers rewrote or
 * destroyed them without once looking at the application underneath. DELETE was the worst of
 * it: it took the id, ran the delete and answered 204 whether the row was a half-written draft,
 * an essay submitted six weeks ago, or an id that had never existed at all.
 *
 * Both directions are pinned, because the cheap way to pass the tests above is to refuse
 * everything, and an application still being prepared has to stay fully editable.
 */
describe('answers, once the application has been sent', () => {
  const SENT = 'I built a line-following robot for the county fair and it placed second.';
  const APPROVED_AT = '2026-07-01T12:00:00Z';
  let answerId: string;

  const stored = () =>
    db
      .select()
      .from(schema.applicationAnswer)
      .where(eq(schema.applicationAnswer.id, answerId))
      .all()[0];

  beforeEach(() => {
    // Set explicitly rather than relying on the status block above having run: this is the
    // state the whole rule turns on.
    db.update(schema.application)
      .set({ status: 'submitted', submittedAt: '2026-07-01T00:00:00Z' })
      .where(eq(schema.application.id, applicationId))
      .run();

    answerId = ulid();
    db.delete(schema.applicationAnswer).run();
    db.insert(schema.applicationAnswer)
      .values({
        id: answerId,
        applicationId,
        questionText: 'Why do you want to work here?',
        fieldKey: 'q1',
        answerType: 'long_text',
        draftText: SENT,
        finalText: SENT,
        approvedAt: APPROVED_AT,
      })
      .run();
  });

  it('refuses to delete one, and the text is still there afterwards', async () => {
    const res = await app.inject({ method: 'DELETE', url: `/api/answers/${answerId}` });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('APPLICATION_IN_PROGRESS');
    expect(res.json().error.details.applicationId).toBe(applicationId);
    expect(stored()?.finalText).toBe(SENT);
  });

  it.each([
    {
      what: 'a redraft',
      method: 'POST' as const,
      path: (id: string) => `/api/answers/${id}/draft`,
    },
    {
      what: 'an edit',
      method: 'PATCH' as const,
      path: (id: string) => `/api/answers/${id}`,
      payload: { text: 'Something completely different.' },
    },
    {
      what: 'a re-approval',
      method: 'POST' as const,
      path: (id: string) => `/api/answers/${id}/approve`,
    },
    {
      what: 'withdrawing the approval',
      method: 'POST' as const,
      path: (id: string) => `/api/answers/${id}/unapprove`,
    },
  ])('refuses $what, and changes nothing', async ({ method, path, payload }) => {
    const res = await app.inject({ method, url: path(answerId), payload });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('APPLICATION_IN_PROGRESS');

    const row = stored()!;
    expect(row.finalText).toBe(SENT);
    expect(row.draftText).toBe(SENT);
    // The G3 stamp is part of the record too: cleared, the tracker asks for approval on an
    // answer that has already gone to an employer.
    expect(row.approvedAt).toBe(APPROVED_AT);
  });

  /**
   * A question added to a sent application could no longer be drafted or deleted by the rules
   * above, so it would sit there for ever as an unapproved answer — which the tracker reads
   * as work the student still owes on an application they finished weeks ago.
   */
  it('refuses to add another question to it', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/applications/${applicationId}/questions`,
      payload: { questionText: 'Anything else we should know?' },
    });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('APPLICATION_IN_PROGRESS');
    expect(db.select().from(schema.applicationAnswer).all()).toHaveLength(1);
  });

  it('404s for an answer id that never existed, rather than reporting a delete', async () => {
    const res = await app.inject({ method: 'DELETE', url: `/api/answers/${ulid()}` });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('still deletes one while the application is the tool’s to change', async () => {
    db.update(schema.application)
      .set({ status: 'draft', submittedAt: null })
      .where(eq(schema.application.id, applicationId))
      .run();

    const res = await app.inject({ method: 'DELETE', url: `/api/answers/${answerId}` });
    expect(res.statusCode, res.body).toBe(204);
    expect(stored()).toBeUndefined();
  });
});

/**
 * Reversing a G2 approval is all of it or none of it.
 *
 * The decision row was replaced BEFORE the route checked whether the application could be
 * undone, so a reversal that came back 409 had already recorded the student as having rejected
 * the posting: the response said no and the database said yes, the match dropped out of the
 * queue (the list hides anything decided), and the application it refused to delete carried on
 * living on the tracker. That is precisely the state the route's own comment says must never
 * exist, produced by the guard meant to prevent it.
 */
describe('a G2 reversal that is refused', () => {
  beforeEach(() => {
    // The decision endpoint sits behind gate G1. Only the stored stamp is read for that.
    db.update(schema.profile).set({ confirmedAt: '2026-06-01T00:00:00Z' }).run();
    db.delete(schema.decision).where(eq(schema.decision.matchId, matchId)).run();
    db.update(schema.application)
      .set({ status: 'submitted', submittedAt: '2026-07-01T00:00:00Z' })
      .where(eq(schema.application.id, applicationId))
      .run();
  });

  it('writes no decision at all', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/matches/${matchId}/decision`,
      payload: { action: 'rejected', reason: 'changed my mind' },
    });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('APPLICATION_IN_PROGRESS');

    // Not "the old decision is back" — there was none, and there is none. A row here would
    // have hidden the posting from the queue over a reversal that was refused.
    expect(db.select().from(schema.decision).all()).toEqual([]);
    expect(
      db.select().from(schema.application).where(eq(schema.application.id, applicationId)).all(),
    ).toHaveLength(1);
  });

  it('still records the reversal, and deletes with it, when the reversal is allowed', async () => {
    db.update(schema.application)
      .set({ status: 'draft', submittedAt: null })
      .where(eq(schema.application.id, applicationId))
      .run();

    const res = await app.inject({
      method: 'POST',
      url: `/api/matches/${matchId}/decision`,
      payload: { action: 'skipped' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().deletedApplicationId).toBe(applicationId);

    expect(db.select().from(schema.decision).all()).toHaveLength(1);
    expect(db.select().from(schema.decision).all()[0]!.action).toBe('skipped');
    expect(db.select().from(schema.application).all()).toEqual([]);
  });
});
