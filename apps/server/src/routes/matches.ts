import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { ulid } from 'ulid';
import type { ApplicationStatus } from '@ia/shared';
import { db, schema, sqlite } from '../infra/db/client';
import { isProfileConfirmed } from '../core/profile/repository';
import { runMatching } from '../core/matching/run';
import { logger } from '../infra/logger';
import { discardRun } from '../core/filling/run';
import { SET_BY } from '../core/tracking/status';

/**
 * The statuses this tool sets for itself, worked out from who is allowed to set each one
 * rather than listed again here. A hand-written list is how the next status gets added to
 * the model and missed here, and everything below turns on the difference between an
 * application the tool has been preparing and one the user has acted on in the world.
 */
const TOOL_STATUSES: ReadonlySet<ApplicationStatus> = new Set(
  (Object.keys(SET_BY) as ApplicationStatus[]).filter((s) => SET_BY[s] === 'tool'),
);

const ListQuery = z.object({
  eligibility: z.enum(['eligible', 'eligible_and_unknown', 'all']).default('eligible_and_unknown'),
  minScore: z.coerce.number().min(0).max(100).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
  // Not `z.coerce.boolean()`: coercion is JavaScript's `Boolean()`, and `Boolean('false')`
  // is true, so `?hideDecided=false` asked for decided matches and got them hidden anyway.
  // The only string that turned the filter off was an empty one.
  hideDecided: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
});

const DecisionBody = z.object({
  action: z.enum(['approved', 'skipped', 'rejected', 'saved']),
  reason: z.string().optional(),
  reasonTags: z.array(z.string()).default([]),
});

type Decision = z.infer<typeof DecisionBody>;

/** The G2 answer itself: one decision per match, so the old row goes before the new one. */
function replaceDecision(matchId: string, d: Decision): void {
  db.delete(schema.decision).where(eq(schema.decision.matchId, matchId)).run();
  db.insert(schema.decision)
    .values({
      id: ulid(),
      matchId,
      action: d.action,
      reason: d.reason ?? null,
      reasonTags: d.reasonTags,
    })
    .run();
}

/**
 * A G2 decision and whatever it takes with it, or none of it.
 *
 * Used by every path that does not create an application: a reversal (which passes the
 * application to delete with it) and a re-affirmed approval (which passes null, and still
 * needs the wrapper — replacing a decision is a delete and an insert, and losing the race
 * between them would leave the posting with no decision at all).
 *
 * Every write this route makes is several statements that only mean something together, and
 * they were run loose. Two ways that half-applied, both of them producing the exact state the
 * long comment on the reversal below says must never exist — the match decided and gone from
 * the queue while a live application for it stays on the tracker:
 *
 *   * The decision row was replaced BEFORE the "have you already sent this?" check, so a
 *     reversal that came back 409 APPLICATION_IN_PROGRESS had already recorded the user as
 *     having rejected the posting. The response said the reversal was refused; the database
 *     said it went through.
 *   * The three deletes sat after `await discardRun(...)`. That await hands the event loop
 *     over between the decision write and the deletes, so a browser session that throws on
 *     close — or a process that stops there — left the decision replaced and the application
 *     untouched.
 *
 * `discardRun` closes a real browser window and cannot join a transaction, so it moves OUT of
 * this, ahead of the first write, where a failure means nothing has happened yet. What is left
 * is synchronous, which is what makes better-sqlite3's transaction wrapper hold: an `async`
 * body would commit at its first await. Same wrapper and same reasoning as `saveRequirements`
 * in core/matching/run.ts.
 */
const recordDecision = sqlite.transaction(
  (matchId: string, d: Decision, applicationId: string | null): void => {
    replaceDecision(matchId, d);
    if (applicationId === null) return;
    // Explicitly, child rows first, rather than trusting ON DELETE CASCADE: SQLite
    // enforces foreign keys only when the pragma is on, and an orphaned answer would be
    // invisible work attached to an application nobody can open.
    db.delete(schema.applicationAnswer)
      .where(eq(schema.applicationAnswer.applicationId, applicationId))
      .run();
    db.delete(schema.applicationEvent)
      .where(eq(schema.applicationEvent.applicationId, applicationId))
      .run();
    db.delete(schema.application).where(eq(schema.application.id, applicationId)).run();
  },
);

/** The approval half of the same rule: the decision and the application it creates, together. */
const approveIntoApplication = sqlite.transaction(
  (
    matchId: string,
    d: Decision,
    created: {
      id: string;
      applyUrl: string;
      atsVendor: string;
      deadlineAt: string | null;
      company: string;
      title: string;
    },
  ): void => {
    replaceDecision(matchId, d);
    db.insert(schema.application)
      .values({
        id: created.id,
        matchId,
        status: 'draft',
        applyUrl: created.applyUrl,
        atsVendor: created.atsVendor,
        deadlineAt: created.deadlineAt,
      })
      .run();
    db.insert(schema.applicationEvent)
      .values({
        id: ulid(),
        applicationId: created.id,
        type: 'created',
        payload: { via: 'gate_g2', company: created.company, title: created.title },
      })
      .run();
  },
);

export async function matchRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', async (req, reply) => {
    // Safe to compare against a literal path because app.ts has already rewritten the
    // target to its one canonical spelling. Before it did, `GET /%61pi/matches` routed here
    // and slipped past this line, so gate G1 was one percent-escape away from being off.
    if (!req.url.startsWith('/api/matches')) return;
    if (!isProfileConfirmed()) {
      return reply.code(409).send({
        error: {
          code: 'PROFILE_NOT_CONFIRMED',
          message: 'Confirm your profile first (gate G1).',
        },
      });
    }
  });

  app.post('/api/matches/recompute', async (req, reply) => {
    const body = z
      .object({ reextract: z.boolean().default(false), useModel: z.boolean().default(true) })
      .safeParse(req.body ?? {});
    if (!body.success) {
      return reply.code(400).send({
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Expected { reextract?: boolean, useModel?: boolean }.',
          details: { issues: body.error.issues },
        },
      });
    }
    try {
      return await runMatching(body.data);
    } catch (err) {
      /**
       * Mapped, not passed through.
       *
       * `code ?? 'INTERNAL'` handed whatever `.code` the thrown error happened to carry
       * straight into the envelope — and `runMatching` writes to tables with foreign keys
       * under `PRAGMA foreign_keys = ON`, so a better-sqlite3 failure arrives wearing
       * `SQLITE_CONSTRAINT_FOREIGNKEY`. That is not one of the twenty codes `ApiErrorCode`
       * declares, and `audit:error-codes` cannot see it because the audit scans for literals
       * in the source rather than for what reaches the wire. A client switching on the code
       * would meet a value no schema of ours contains, and the message beside it is a SQL
       * engine's, addressed to nobody.
       *
       * Only the one code this route can legitimately produce leaves it; everything else is
       * an internal failure and says so, with the detail going to the log.
       */
      const declared = (err as Error & { code?: string }).code === 'PROFILE_NOT_CONFIRMED';
      if (declared) {
        return reply.code(409).send({
          error: { code: 'PROFILE_NOT_CONFIRMED', message: (err as Error).message },
        });
      }
      logger.error({ err }, 'match recompute failed');
      return reply.code(500).send({
        error: {
          code: 'INTERNAL',
          message: 'Scoring did not finish. The server log has the details.',
        },
      });
    }
  });

  app.get('/api/matches', async (req, reply) => {
    // A bad query string is the client's mistake. Left to throw, it reached the app-level
    // error handler, which has no status on a ZodError and so reported a 500 INTERNAL —
    // telling the user the server broke when what broke was their `?limit=1000`.
    const parsed = ListQuery.safeParse(req.query ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        error: {
          code: 'VALIDATION_FAILED',
          message: parsed.error.issues[0]?.message ?? 'Invalid query.',
          details: { issues: parsed.error.issues },
        },
      });
    }
    const q = parsed.data;

    const bands =
      q.eligibility === 'all'
        ? ['eligible', 'unknown', 'ineligible']
        : q.eligibility === 'eligible'
          ? ['eligible']
          : ['eligible', 'unknown'];

    const decided = q.hideDecided
      ? db
          .select({ matchId: schema.decision.matchId })
          .from(schema.decision)
          .all()
          .map((d) => d.matchId)
      : [];

    const rows = db
      .select({
        id: schema.match.id,
        eligibility: schema.match.eligibility,
        score: schema.match.score,
        rationale: schema.match.rationale,
        breakdown: schema.match.breakdown,
        blockers: schema.match.blockers,
        postingId: schema.jobPosting.id,
        company: schema.jobPosting.company,
        title: schema.jobPosting.title,
        applyUrl: schema.jobPosting.applyUrl,
        canonicalUrl: schema.jobPosting.canonicalUrl,
        locations: schema.jobPosting.locations,
        positionType: schema.jobPosting.positionType,
        workArrangement: schema.jobPosting.workArrangement,
        term: schema.jobPosting.term,
        compensation: schema.jobPosting.compensation,
        closesAt: schema.jobPosting.closesAt,
        atsVendor: schema.jobPosting.atsVendor,
      })
      .from(schema.match)
      .innerJoin(schema.jobPosting, eq(schema.match.postingId, schema.jobPosting.id))
      .where(
        and(
          inArray(schema.match.eligibility, bands),
          gte(schema.match.score, q.minScore),
          decided.length > 0 ? sql`${schema.match.id} NOT IN ${decided}` : undefined,
        ),
      )
      .orderBy(desc(schema.match.score))
      .limit(q.limit)
      .offset(q.offset)
      .all();

    /**
     * The whole scored store, by band — deliberately NOT a description of `matches` above.
     *
     * It has been read as a bug twice now, so: this answers "what is in the store", while the
     * list answers "what is left to triage". They are different questions and the screen asks
     * both at once. Matches.tsx renders it as "12 eligible · 5 to check · 3 filtered" beside
     * the band chips, and the third number is the giveaway — `ineligible` is shown while the
     * `eligible` band is selected, so this can never have been the list's own tally. Nor could
     * it be: narrowing it by `hideDecided` and `minScore` and the chosen band would leave a
     * chip that changes with every filter and cannot say how much triage is left, and a triaged
     * queue would read "0 eligible" on a store holding a hundred eligible postings.
     *
     * The one thing that HAS to be right is what the empty queue says, since an empty list
     * under a non-zero count is the case that reads as a contradiction. Matches.tsx handles it
     * there, with `decided`: it tells "nothing searched yet" and "you have triaged all of it"
     * apart rather than sending someone back to Discover over postings they just decided.
     */
    const counts = db
      .select({ eligibility: schema.match.eligibility, n: sql<number>`count(*)` })
      .from(schema.match)
      .groupBy(schema.match.eligibility)
      .all();

    return {
      matches: rows,
      counts: Object.fromEntries(counts.map((c) => [c.eligibility, c.n])),
    };
  });

  /** Full detail: every rule with its verbatim JD quote. This is the trust surface. */
  app.get<{ Params: { id: string } }>('/api/matches/:id', async (req, reply) => {
    const rows = db
      .select()
      .from(schema.match)
      .innerJoin(schema.jobPosting, eq(schema.match.postingId, schema.jobPosting.id))
      .where(eq(schema.match.id, req.params.id))
      .all();

    const row = rows[0];
    if (!row) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'No such match.' } });
    }

    const requirements = db
      .select()
      .from(schema.jobRequirement)
      .where(eq(schema.jobRequirement.postingId, row.job_posting.id))
      .all();

    const decision = db
      .select()
      .from(schema.decision)
      .where(eq(schema.decision.matchId, row.match.id))
      .all()[0];

    return {
      match: row.match,
      posting: row.job_posting,
      requirements: requirements.map((r) => ({ ...r, confidence: r.confidence / 100 })),
      decision: decision ?? null,
    };
  });

  /**
   * Gate G2. `approved` creates an application record; it does NOT submit anything and
   * does not draft anything on its own.
   */
  app.post<{ Params: { id: string } }>('/api/matches/:id/decision', async (req, reply) => {
    const parsed = DecisionBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: 'VALIDATION_FAILED', message: 'Expected { action, reason?, reasonTags? }.' },
      });
    }

    const matchRows = db
      .select()
      .from(schema.match)
      .innerJoin(schema.jobPosting, eq(schema.match.postingId, schema.jobPosting.id))
      .where(eq(schema.match.id, req.params.id))
      .all();
    const row = matchRows[0];
    if (!row) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'No such match.' } });
    }

    /**
     * The application this match's approval created, if there is one.
     *
     * Read before anything is written, because both branches below need it and the reversal
     * has to be able to refuse without the decision row having already moved.
     */
    const created = db
      .select({
        id: schema.application.id,
        status: schema.application.status,
        submittedAt: schema.application.submittedAt,
      })
      .from(schema.application)
      .where(eq(schema.application.matchId, req.params.id))
      .all()[0];

    /**
     * Reversing a G2 approval has to take the application with it.
     *
     * Approving a match creates an application; changing that decision to skipped, rejected
     * or saved used to replace the decision row and stop there, answering
     * `applicationId: null` while the application it had created went on existing. That
     * reading of the response was simply false — there was an id, and the client had no way
     * to learn it — and the consequences were worse than the wrong number. The posting
     * vanished from the match queue, because that list hides anything decided, while the
     * application stayed on the tracker and in the applications list, every fill gate still
     * passed for it, and it could be walked all the way to `submitted`. Gate G2 is the user
     * saying yes to this posting; once they have said no, nothing downstream may still be
     * holding a live application for it.
     *
     * Work is never deleted out from under someone: an application the user has already
     * submitted, or moved into a status only they can set, refuses the reversal and says so
     * rather than being removed. What goes is an application still inside the tool's own
     * statuses, which is one the user has not acted on in the world.
     */
    if (parsed.data.action !== 'approved') {
      if (created) {
        const undoable =
          created.submittedAt === null && TOOL_STATUSES.has(created.status as ApplicationStatus);
        if (!undoable) {
          // Nothing has been written yet, and nothing will be: a refusal that had already
          // replaced the decision row would leave the posting decided — hidden from the
          // queue by `hideDecided` — beside the live application it refused to remove.
          return reply.code(409).send({
            error: {
              code: 'APPLICATION_IN_PROGRESS',
              message:
                `You have already taken application ${created.id} for this posting past the ` +
                `point this tool can undo — it is ${created.status}. Withdraw it from the ` +
                'tracker instead; changing the decision here would leave it running.',
              details: { applicationId: created.id, status: created.status },
            },
          });
        }

        // A fill run holds a real browser window pointed at this employer's form. Closing it
        // is the same courtesy the tracker pays when an application leaves the tool's hands.
        // It happens here, before the first write, because it is the one part of a reversal
        // that cannot be done inside the transaction — see `recordDecision`.
        await discardRun(created.id);
      }

      recordDecision(req.params.id, parsed.data, created?.id ?? null);

      if (!created) return { action: parsed.data.action, applicationId: null };
      return { action: parsed.data.action, applicationId: null, deletedApplicationId: created.id };
    }

    if (created) {
      recordDecision(req.params.id, parsed.data, null);
      return { action: 'approved', applicationId: created.id };
    }

    const applicationId = ulid();
    approveIntoApplication(req.params.id, parsed.data, {
      id: applicationId,
      applyUrl: row.job_posting.applyUrl,
      atsVendor: row.job_posting.atsVendor,
      deadlineAt: row.job_posting.closesAt,
      company: row.job_posting.company,
      title: row.job_posting.title,
    });

    return { action: 'approved', applicationId };
  });
}
