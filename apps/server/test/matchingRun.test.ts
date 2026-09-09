/**
 * The matching orchestrator, which had no test of its own at all.
 *
 * Every rule in eligibility.ts is covered individually, and the queue that reads the results
 * is covered over the wire, but the thing that runs the one over the other — reading postings,
 * extracting requirements, storing them and scoring — was held by nothing. The piece that
 * matters most in here is the transaction, and its own docstring says why: the delete and the
 * inserts used to be separate statements, so a throw partway through left a posting holding
 * SOME of its requirements, and the cache stamp from the earlier run survives, so every later
 * run reads the partial set from cache and never looks again.
 *
 * The age patterns are the reason that is worth a test rather than a comment. A hard 18+ floor
 * is emitted followed by its "16 with a work permit" alternative, and a failure landing between
 * the two leaves only the floor on the posting — so a sixteen-year-old is hard-failed on a
 * posting written to admit them. This repo calls a false `ineligible` the worst thing it can
 * do to somebody, and this is a way to produce one from a half-finished write.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { JobRequirement } from '@ia/shared';
import { eq } from 'drizzle-orm';
import { db, schema } from '../src/infra/db/client';
import { runMigrations } from '../src/infra/db/migrate';
import { saveRequirements } from '../src/core/matching/run';
import { evaluateEligibility } from '../src/core/matching/eligibility';

const POSTING_ID = 'post_matching_run';

function requirement(over: Partial<JobRequirement> & { id: string }): JobRequirement {
  return {
    kind: 'age',
    operator: 'min',
    value: { min: 18 },
    necessity: 'required',
    sourceQuote: 'Applicants must be at least 18 years of age.',
    confidence: 0.9,
    ...over,
  } as JobRequirement;
}

/** The pair the docstring is about: the hard floor, then the alternative that admits a minor. */
const FLOOR = requirement({ id: 'req_floor' });
const ALTERNATIVE = requirement({
  id: 'req_alternative',
  value: { min: 16 },
  sourceQuote: 'Applicants aged 16 and 17 may apply with a work permit.',
});

function storedFor(postingId: string): JobRequirement[] {
  return db
    .select()
    .from(schema.jobRequirement)
    .where(eq(schema.jobRequirement.postingId, postingId))
    .all() as unknown as JobRequirement[];
}

beforeEach(() => {
  runMigrations();
  db.delete(schema.jobRequirement).where(eq(schema.jobRequirement.postingId, POSTING_ID)).run();
  db.delete(schema.jobPosting).where(eq(schema.jobPosting.id, POSTING_ID)).run();
  db.insert(schema.jobPosting)
    .values({
      id: POSTING_ID,
      source: 'test',
      company: 'Sample Robotics',
      title: 'Summer Engineering Intern',
      descriptionText:
        'Applicants must be at least 18 years of age. Applicants aged 16 and 17 may apply ' +
        'with a work permit.',
      applyUrl: 'https://example.test/apply',
      canonicalUrl: 'https://example.test/apply',
      fingerprint: 'fp_matching_run',
      isOpen: true,
    } as never)
    .run();
});

describe('a posting keeps all of its requirements or none of them', () => {
  it('stores the whole set on a clean write', () => {
    saveRequirements(POSTING_ID, [FLOOR, ALTERNATIVE]);
    expect(
      storedFor(POSTING_ID)
        .map((r) => r.id)
        .sort(),
    ).toEqual(['req_alternative', 'req_floor']);
  });

  /**
   * THE HALF-WRITE THAT PRODUCES A FALSE INELIGIBLE.
   *
   * The second insert is made to fail — two rows with one id — so the write throws after the
   * delete and after the first insert have already run. Without the transaction the posting is
   * left holding the 18+ floor and nothing else, which is the exact state that hard-fails a
   * sixteen-year-old on a posting that admits them. With it, the previous set is still there.
   */
  it('rolls back to the previous set when a write fails partway through', () => {
    saveRequirements(POSTING_ID, [FLOOR, ALTERNATIVE]);

    const duplicated = [requirement({ id: 'req_new' }), requirement({ id: 'req_new' })];
    expect(() => saveRequirements(POSTING_ID, duplicated)).toThrow();

    const after = storedFor(POSTING_ID);
    // Not one row, and not zero: the delete must have been rolled back with the inserts.
    expect(after.map((r) => r.id).sort()).toEqual(['req_alternative', 'req_floor']);
  });

  /**
   * The same failure said in the terms that matter, so the test survives a refactor that
   * changes how requirements are stored: after a failed write, a sixteen-year-old must still
   * not be ineligible for this posting.
   */
  it('leaves a sixteen-year-old eligible-or-unknown after a failed write, never ineligible', () => {
    saveRequirements(POSTING_ID, [FLOOR, ALTERNATIVE]);
    try {
      saveRequirements(POSTING_ID, [requirement({ id: 'dup' }), requirement({ id: 'dup' })]);
    } catch {
      // The point of the test is what the database looks like afterwards.
    }

    const minor = {
      id: 'p_minor',
      derived: {
        age: 16,
        isMinor: true,
        academicLevel: 'high_school',
        yearsProfessionalExperience: 0,
      },
      locationPrefs: {
        base: { city: '', region: '', country: 'US' },
        additionalBases: [],
        relocateTo: [],
        remoteOk: true,
        hybridOk: true,
        maxCommuteKm: 50,
      },
      availability: { flexible: true },
      preferences: { excludeCompanies: [] },
      citizenships: [],
      workAuthorization: { country: 'US', status: 'citizen', needsSponsorship: false },
      education: [],
    } as never;

    const outcome = evaluateEligibility({
      profile: minor,
      posting: {
        title: 'Summer Engineering Intern',
        company: 'Sample Robotics',
        locations: [],
        isOpen: true,
        term: {},
        closesAt: null,
      } as never,
      requirements: storedFor(POSTING_ID),
      now: new Date('2026-09-08T00:00:00Z'),
    } as never);

    expect(outcome.eligibility).not.toBe('ineligible');
  });
});
