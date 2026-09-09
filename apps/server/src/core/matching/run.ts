/**
 * Matching orchestration — extract requirements, evaluate eligibility, score, persist.
 *
 * Requirements are cached per posting: they depend only on the job description, so a
 * profile edit re-runs eligibility and scoring without paying for extraction again.
 */
import { eq } from 'drizzle-orm';
import { ulid } from 'ulid';
import type { ConfirmedProfile, JobRequirement } from '@ia/shared';
import { db, schema, sqlite } from '../../infra/db/client';
import { logger } from '../../infra/logger';
import { deriveProfile } from '../ingestion/deriveFields';
import { getProfile } from '../profile/repository';
import { evaluateEligibility, type PostingFacts } from './eligibility';
import { extractRequirements } from './extractRequirements';
import { buildRationale } from './rationale';
import { scoreMatch } from './score';

export interface MatchRunSummary {
  runId: string;
  postingsConsidered: number;
  matched: number;
  eligible: number;
  unknown: number;
  ineligible: number;
  requirementsExtracted: number;
  requirementsDropped: number;
  /** Postings that exist but were not matched this run, because a limit was set. */
  postingsSkipped: number;
  usedModel: boolean;
  errors: string[];
}

type PostingRow = typeof schema.jobPosting.$inferSelect;

function toFacts(row: PostingRow): PostingFacts {
  return {
    id: row.id,
    company: row.company,
    title: row.title,
    isOpen: row.isOpen,
    closesAt: row.closesAt,
    locations: (row.locations as PostingFacts['locations']) ?? [],
    workArrangement: row.workArrangement,
    term: (row.term as PostingFacts['term']) ?? { season: null, year: null },
  };
}

function loadRequirements(postingId: string): JobRequirement[] {
  return db
    .select()
    .from(schema.jobRequirement)
    .where(eq(schema.jobRequirement.postingId, postingId))
    .all()
    .map((r) => ({
      id: r.id,
      postingId: r.postingId,
      kind: r.kind,
      operator: r.operator,
      value: r.value,
      necessity: r.necessity,
      sourceQuote: r.sourceQuote,
      // Stored as an integer percentage to keep the column typed.
      confidence: r.confidence / 100,
    })) as JobRequirement[];
}

/**
 * All of a posting's requirements, or none of them.
 *
 * The delete and the inserts were separate statements, so a throw partway through left the
 * posting holding SOME of its requirements — and on the re-extract path the cache stamp from
 * the previous run survives, so every later run reads the partial set from cache and never
 * looks again. The age patterns are why that matters: a hard 18+ floor is emitted followed by
 * its 16-with-a-work-permit alternative, and a failure landing between the two leaves only the
 * floor. A sixteen-year-old is then hard-failed on a posting written to admit them, which is
 * the outcome this repo calls the worst thing it can do to somebody, from a partial write a
 * transaction removes for free.
 */
export const saveRequirements = sqlite.transaction(
  (postingId: string, reqs: JobRequirement[]): void => {
    db.delete(schema.jobRequirement).where(eq(schema.jobRequirement.postingId, postingId)).run();
    for (const r of reqs) {
      db.insert(schema.jobRequirement)
        .values({
          id: r.id,
          postingId,
          kind: r.kind,
          operator: r.operator,
          value: r.value,
          necessity: r.necessity,
          sourceQuote: r.sourceQuote,
          confidence: Math.round(r.confidence * 100),
        })
        .run();
    }
  },
);

export async function runMatching(
  opts: { limit?: number; reextract?: boolean; useModel?: boolean; now?: Date } = {},
): Promise<MatchRunSummary> {
  const profile = getProfile();
  if (!profile?.confirmedAt) {
    throw Object.assign(new Error('Profile is not confirmed (gate G1).'), {
      code: 'PROFILE_NOT_CONFIRMED',
    });
  }
  const now = opts.now ?? new Date();

  /**
   * `derived` is stored as it was computed on the day the profile was last saved, and the
   * parts of it that depend on a clock keep drifting after that. Scoring reads
   * `derived.seniorityBand`, which flips to `new_grad` the month the user's expected
   * graduation passes — so a student who saved their profile in March and graduated in May
   * was still scored as an `entry_intern` in August, which drops the seniority component of
   * every new-grad posting from 1.0 to 0.25, and the breakdown note told them so in as many
   * words: "new_grad vs your entry_intern band". Recomputing against the same `now` the
   * rules are given means every half of every comparison in this run reads the same clock.
   */
  const confirmed = { ...profile, derived: deriveProfile(profile, now) } as ConfirmedProfile;

  /**
   * Every posting, unless a caller explicitly asks for fewer.
   *
   * This used to cap at 500 with no way to raise it from the UI, which meant that with
   * more postings than the cap the surplus got no `match` row at all — invisible in the
   * queue AND in the filtered drawer, with nothing in the summary to say so. A silent
   * drop is precisely what the tri-state eligible/unknown/ineligible model exists to
   * prevent, so the default is now "all of them" and any shortfall is reported.
   */
  const total = db.select({ id: schema.jobPosting.id }).from(schema.jobPosting).all().length;
  const postings = opts.limit
    ? db.select().from(schema.jobPosting).limit(opts.limit).all()
    : db.select().from(schema.jobPosting).all();

  const summary: MatchRunSummary = {
    runId: ulid(),
    postingsConsidered: postings.length,
    postingsSkipped: Math.max(0, total - postings.length),
    matched: 0,
    eligible: 0,
    unknown: 0,
    ineligible: 0,
    requirementsExtracted: 0,
    requirementsDropped: 0,
    usedModel: false,
    errors: [],
  };

  for (const row of postings) {
    try {
      let requirements = loadRequirements(row.id);

      // Keyed on "has this been extracted", not "did it produce anything". A posting
      // whose description states no requirements is a correct, common outcome; treating
      // the empty result as a cache miss re-ran a model call against it on every recompute.
      if (row.requirementsExtractedAt === null || opts.reextract) {
        const extracted = await extractRequirements(row.id, row.descriptionText, {
          useModel: opts.useModel,
        });
        saveRequirements(row.id, extracted.requirements);
        db.update(schema.jobPosting)
          .set({ requirementsExtractedAt: new Date().toISOString() })
          .where(eq(schema.jobPosting.id, row.id))
          .run();
        requirements = extracted.requirements;
        summary.requirementsExtracted += extracted.requirements.length;
        summary.requirementsDropped += extracted.dropped.length;
        summary.usedModel ||= extracted.usedModel;
      }

      const facts = toFacts(row);
      const outcome = evaluateEligibility({
        profile: confirmed,
        posting: facts,
        requirements,
        now,
      });

      const score = scoreMatch({
        profile: confirmed,
        posting: {
          ...facts,
          descriptionText: row.descriptionText,
          compensation: row.compensation as Record<string, unknown> | null,
          applyEffort: row.applyEffort as {
            steps: number;
            essayCount: number;
            estMinutes: number;
          } | null,
          positionType: row.positionType,
        },
        requirements,
      });

      const rationale = buildRationale({
        company: row.company,
        title: row.title,
        eligibility: outcome.eligibility,
        rules: outcome.rules,
        score,
      });

      const existing = db
        .select({ id: schema.match.id })
        .from(schema.match)
        .where(eq(schema.match.postingId, row.id))
        .all();

      const values = {
        postingId: row.id,
        profileId: confirmed.id,
        eligibility: outcome.eligibility,
        rules: outcome.rules,
        blockers: outcome.blockers,
        score: score.score,
        breakdown: { ...score.breakdown, notes: score.notes },
        rationale,
        computedAt: now.toISOString(),
      };

      if (existing[0]) {
        db.update(schema.match).set(values).where(eq(schema.match.id, existing[0].id)).run();
      } else {
        db.insert(schema.match)
          .values({ id: ulid(), ...values })
          .run();
      }

      summary.matched++;
      summary[outcome.eligibility === 'ineligible' ? 'ineligible' : outcome.eligibility]++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      summary.errors.push(`${row.company} — ${row.title}: ${message}`);
      logger.warn({ err, postingId: row.id }, 'matching failed for posting');
    }
  }

  logger.info(
    {
      runId: summary.runId,
      matched: summary.matched,
      eligible: summary.eligible,
      unknown: summary.unknown,
      ineligible: summary.ineligible,
    },
    'matching run complete',
  );
  return summary;
}
