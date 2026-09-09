/**
 * Answer drafting and review — gate G3.
 *
 * The invariant this file enforces (docs/03, invariant 2): an answer cannot be approved
 * while FactGuard holds a blocking verdict against it. That check lives on the server,
 * not in the browser, because a client-side gate is a suggestion.
 *
 * There is deliberately no endpoint that approves in bulk, and none that approves as a
 * side effect of drafting. Approval is one answer, one person, one click.
 */
import type { FastifyInstance } from 'fastify';
import { desc, eq } from 'drizzle-orm';
import { ulid } from 'ulid';
import { z } from 'zod';
import type {
  AnswerEvidence,
  AnswerFlag,
  ApplicationStatus,
  ConfirmedProfile,
  StyleProfile,
} from '@ia/shared';
import { db, schema } from '../infra/db/client';
import { decryptField } from '../infra/crypto/fieldCrypto';
import {
  claudeCliSelfTest,
  describeAccess,
  NoModelAccessError,
  resetBackend,
  resetCliProbe,
  resolveBackend,
} from '../infra/llm';
import { publish } from '../infra/events';
import { logger } from '../infra/logger';
import { getProfile } from '../core/profile/repository';
import { SET_BY } from '../core/tracking/status';
import { gatePostingContext, WHOLE_PROFILE } from '../core/filling/plan';
import { draftAnswer } from '../core/writing/draft';
import { guardDraft, type GuardResult } from '../core/writing/factGuard';
import { retrieveEvidence } from '../core/writing/retrieve';
import { critiqueStyle, describeMatch } from '../core/writing/styleCritic';
import { findTells } from '../core/writing/tellScrub';
import {
  classifyQuestion,
  describeEditing,
  editFraction,
  findReusable,
  listLibrary,
  saveApproved,
  wordEditDistance,
} from '../core/writing/answerLibrary';

// ─────────────────────────────────────────────────────────────────── loaders

function loadStyle(): StyleProfile | undefined {
  const row = db
    .select()
    .from(schema.styleProfile)
    .orderBy(desc(schema.styleProfile.computedAt))
    .all()[0];
  return row ? (row.metrics as StyleProfile) : undefined;
}

function loadSamples(): string[] {
  return db
    .select()
    .from(schema.writingSample)
    .orderBy(desc(schema.writingSample.wordCount))
    .all()
    .map((r) => decryptField(r.content, r.id));
}

interface ApplicationContext {
  applicationId: string;
  company: string;
  title: string;
  description: string;
  applyUrl: string;
  status: string;
  submittedAt: string | null;
}

function loadContext(applicationId: string): ApplicationContext | null {
  const row = db
    .select()
    .from(schema.application)
    .innerJoin(schema.match, eq(schema.application.matchId, schema.match.id))
    .innerJoin(schema.jobPosting, eq(schema.match.postingId, schema.jobPosting.id))
    .where(eq(schema.application.id, applicationId))
    .all()[0];

  if (!row) return null;
  return {
    applicationId,
    company: row.job_posting.company,
    title: row.job_posting.title,
    description: row.job_posting.descriptionText,
    applyUrl: row.application.applyUrl,
    /**
     * Where this application has got to, sent by the endpoint that knows.
     *
     * It was not here, and the detail screen said so out loud: Applications.tsx carried the
     * comment "The list row is the only thing that knows whether this one has been
     * submitted" and looked the answer up in the summary list beside it. That works only
     * while the list happens to be loaded and happens to contain this row — open the detail
     * before the list settles, or by a link, and `submittedAt` reads null, so an application
     * the user has already sent renders as unsent and the fill panel offers to fill it again.
     * G4 is not breached by that — a human still submits — but the screen is telling them
     * something untrue about their own application at the moment they are deciding what to do
     * with it.
     */
    status: row.application.status,
    submittedAt: row.application.submittedAt,
  };
}

/** The confirmed profile, or null. Nothing downstream may read an unconfirmed one. */
function confirmedProfile(): ConfirmedProfile | null {
  const p = getProfile();
  return p?.confirmedAt ? (p as ConfirmedProfile) : null;
}

// ───────────────────────────────────────────── the record, once it has been sent

/**
 * The statuses this tool sets for itself, worked out from who is allowed to set each one.
 *
 * Derived rather than listed, and derived a second time here rather than shared out of
 * routes/matches.ts, which needs the same set for the same reason: both read the one table in
 * core/tracking/status.ts, so a status added to the model later reaches both at once. A
 * hand-written list is how it would reach neither.
 */
const TOOL_STATUSES: ReadonlySet<ApplicationStatus> = new Set(
  (Object.keys(SET_BY) as ApplicationStatus[]).filter((s) => SET_BY[s] === 'tool'),
);

/**
 * Refuses to touch the answers of an application the user has already sent.
 *
 * Every endpoint under `/api/answers/:id` rewrote or destroyed rows with no idea what the
 * application beneath them had become. The worst was DELETE, which took the id, ran the
 * delete and answered 204 whatever it hit: an essay approved at G3, filled into an employer's
 * form and submitted six weeks ago was one request away from being gone, and it is the ONLY
 * copy — `draft_text` and `final_text` are where what the employer was told is written down,
 * and nothing else in this app keeps a version of it. The same hole let a redraft overwrite
 * that text with a fresh model answer, an edit save over it, and unapprove strip the G3 stamp
 * off a sent application so the tracker asked for approval on something already gone.
 *
 * So the whole mutation surface is covered, not just the reported DELETE: DELETE, PATCH,
 * POST :id/draft, POST :id/approve, POST :id/unapprove, and POST
 * /api/applications/:id/questions — the last because a question added to a sent application
 * can no longer be drafted or deleted by the rules above, leaving a permanently unapproved
 * answer that reads on the tracker as work still owed.
 *
 * The rule itself is not new here, only its reach: `withdrawStaleApprovals` in
 * routes/profile.ts already leaves a sent application's answers alone, because "that text
 * reached the employer" and re-flagging it would be the tool telling a story about something
 * it cannot change. That held for the one pass that runs by itself while every endpoint a
 * client can call walked straight past it. "Already sent" is then the definition
 * routes/matches.ts uses to refuse reversing a G2 approval: `submitted_at` written, or a
 * status only the user can set. Reading endpoints are untouched — a sent application stays
 * fully readable, which is the entire point of keeping it.
 */
function refuseIfSent(
  applicationId: string,
  attempt: string,
): { error: { code: 'APPLICATION_IN_PROGRESS'; message: string; details: unknown } } | null {
  const row = db
    .select({ status: schema.application.status, submittedAt: schema.application.submittedAt })
    .from(schema.application)
    .where(eq(schema.application.id, applicationId))
    .all()[0];
  if (!row) return null;
  if (row.submittedAt === null && TOOL_STATUSES.has(row.status as ApplicationStatus)) return null;

  return {
    error: {
      code: 'APPLICATION_IN_PROGRESS',
      // Two sentences, because the two cases are not the same claim. An application the user
      // withdrew was quite possibly never sent to anybody, and telling them these answers are
      // "what this employer was told" would be the app asserting something it does not know —
      // the mistake this repo cares most about not making.
      message:
        row.submittedAt !== null
          ? `You have already sent application ${applicationId}, so its answers are the record ` +
            `of what this employer was actually told. ${attempt} is refused: this is the only ` +
            'copy of that text.'
          : `Application ${applicationId} is ${row.status.replace(/_/g, ' ')}, which is past ` +
            `the point this tool acts on it. ${attempt} is refused: its answers stay as the ` +
            'record of what was prepared.',
      details: { applicationId, status: row.status },
    },
  };
}

/** What the posting contributes to a draft and to the gate. */
interface PostingWords {
  /** Retrieval context: the role title, the company, then the description. */
  postingContext: string | undefined;
  /** The two names the profile cannot supply, for FactGuard. */
  contextNames: string[];
}

/**
 * The posting's words, derived once and used by every path.
 *
 * The drafting call and the gate each built their own version of this and they disagreed, in
 * both of the ways a disagreement can hurt.
 *
 * Drafting passed `<title> at <company>\n\n<description>` to retrieval and the gate passed
 * the description alone, so the two ends of one request scored the same profile against
 * different queries. Retrieval ranks by keyword overlap, and the employer's name and the role
 * title are precisely the words that promote the entries an answer is going to be about: a
 * club named for the same thing the company is named for ("Northside Robotics Boosters"
 * against Nova Robotics) sat near the top of the evidence the draft was written from and near
 * the bottom of the evidence the gate checked it against. Anything past the ceiling on either
 * side then differs, and a claim built from an item only one side holds is a fabrication to
 * the other. The gate is the side with no override.
 *
 * The company and the title were the other half. The gate was handed them as `contextNames`
 * and the drafting guard was not, so the draft's one revision round was spent deleting the
 * only sentence that named the employer, and "why do you want to work here" reached the user
 * with the answer to it removed.
 *
 * One function, so a caller cannot supply half of this again.
 */
function postingWords(ctx: ApplicationContext | null): PostingWords {
  if (!ctx) return { postingContext: undefined, contextNames: [] };
  return {
    // The shared builder, not a second copy of the same template string. The re-check that
    // can withdraw an approval calls it too, and when the two built their own the gate and
    // the re-check ranked the same profile against different queries.
    postingContext: gatePostingContext(ctx),
    contextNames: [ctx.company, ctx.title],
  };
}

// ────────────────────────────────────────────────────────── verification pass

interface Verified {
  guard: GuardResult;
  evidence: AnswerEvidence[];
  flags: AnswerFlag[];
  style: ReturnType<typeof critiqueStyle>;
  styleNote: string;
}

/**
 * Re-verifies text against the profile. Runs on every draft AND on every user edit —
 * an approved answer must be verified as it stands, not as it was generated.
 *
 * Takes the whole application context rather than the posting description on its own. The
 * description was threaded through here for retrieval while the company and the role title
 * — which FactGuard needs for a different reason — were not, and that half-wired mechanism
 * is what produced the bug below. One argument carrying everything the posting knows means
 * a caller cannot supply part of it again.
 */
function verify(
  text: string,
  question: string,
  profile: ConfirmedProfile,
  style: StyleProfile | undefined,
  ctx: ApplicationContext | null,
): Verified {
  const posting = postingWords(ctx);
  // `WHOLE_PROFILE` is imported from core/filling/plan.ts rather than declared here, and the
  // reason is the whole point of it: `recheckApproval` in that file re-runs this exact pass
  // at the last gate before an employer's form, and when the two files each chose their own
  // corpus size the re-check withdrew ticks this pass had just granted. One constant, both
  // gates. It means what it says — retrieve.ts applies its own ceiling only to a caller that
  // states no limit, so this pass really does check against every fact the profile holds.
  const evidence = retrieveEvidence(profile, question, {
    postingContext: posting.postingContext,
    limit: WHOLE_PROFILE,
  });
  // The employer's name and the role title come from the posting and are nowhere on the
  // profile, so FactGuard has to be told them or it reads them as inventions. Nobody passed
  // them, and the result was that "What draws me to Stripe is the documentation" could not
  // be approved: G3 came back with `"Stripe" does not appear anywhere on your profile` and
  // has no override, so the only way to satisfy the message it printed — add the fact to
  // your profile — was to claim a job at Stripe the user had never had, which is the exact
  // thing FactGuard exists to stop. Naming the company is the most ordinary sentence a
  // "why this company" answer contains. Mentioning is all this buys: "I interned at Stripe"
  // is still blocked, by `affiliationFrame` in factGuard.ts.
  const guard = guardDraft(text, evidence, posting.contextNames);
  // Em-dash density and sentence rhythm are tells only relative to how this person writes,
  // which is why the drafting side hands the same baselines over. Measured against the
  // generic defaults instead, someone who genuinely writes with em dashes opened the review
  // screen to "1.9 per 100. Swap some for a period or a comma." against their own prose —
  // and the flags shown at G3 come from here, so the fix on the drafting side never reached
  // the screen the user actually reads.
  const tells = findTells(text, {
    baselineEmDashPer100: style?.punctuation.emDash,
    baselineSentenceStdev: style?.sentenceLengthStdev,
  });
  const styleReport = critiqueStyle(text, style);

  const flags: AnswerFlag[] = [
    ...guard.blocking.map((c) => ({
      type: c.verdict === 'overstated' ? ('overstated' as const) : ('unsupported' as const),
      span: c.span,
      note: c.reason ?? 'Not supported by your profile.',
    })),
    ...tells.map((t) => ({ type: 'ai_tell' as const, span: t.span, note: t.note })),
    ...styleReport.drift
      .filter((d) => d.severity > 0.4)
      .map((d) => ({ type: 'style_drift' as const, span: { start: 0, end: 0 }, note: d.note })),
  ];

  return {
    guard,
    evidence: guard.claims.map((c) => ({
      claim: c.claim,
      verdict: c.verdict,
      profileRef: c.profileRef,
      quote: c.quote,
    })),
    flags,
    style: styleReport,
    styleNote: describeMatch(styleReport),
  };
}

function answerPayload(row: typeof schema.applicationAnswer.$inferSelect): Record<string, unknown> {
  const text = row.finalText || row.draftText;
  return {
    id: row.id,
    applicationId: row.applicationId,
    questionText: row.questionText,
    fieldKey: row.fieldKey,
    answerType: row.answerType,
    draftText: row.draftText,
    finalText: row.finalText,
    text,
    editDistance: row.editDistance,
    editSummary: describeEditing(editFraction(row.draftText, text)),
    evidence: row.evidence ?? [],
    flags: row.flags ?? [],
    approvedAt: row.approvedAt,
    archetype: classifyQuestion(row.questionText).archetype,
  };
}

// ─────────────────────────────────────────────────────────────────── schemas

const QuestionBody = z.object({
  questionText: z.string().min(3, 'A question needs some text.'),
  fieldKey: z.string().default(''),
  answerType: z.enum(['short_text', 'long_text', 'select', 'boolean']).default('long_text'),
  maxWords: z.number().int().positive().max(2000).optional(),
});

const EditBody = z.object({ text: z.string() });

// ────────────────────────────────────────────────────────────────────── routes

export async function answerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/applications', async () => {
    const rows = db
      .select()
      .from(schema.application)
      .innerJoin(schema.match, eq(schema.application.matchId, schema.match.id))
      .innerJoin(schema.jobPosting, eq(schema.match.postingId, schema.jobPosting.id))
      .orderBy(desc(schema.application.createdAt))
      .all();

    /**
     * One grouped read of the answers rather than a query per application, the same way
     * the tracker board counts them. This list is fetched every time the Applications
     * screen opens, and a season's worth of applications turned that into a hundred round
     * trips against the local SQLite file for three numbers.
     */
    const counts = new Map<string, { total: number; approved: number; blocked: number }>();
    for (const a of db.select().from(schema.applicationAnswer).all()) {
      const cur = counts.get(a.applicationId) ?? { total: 0, approved: 0, blocked: 0 };
      counts.set(a.applicationId, {
        total: cur.total + 1,
        approved: cur.approved + (a.approvedAt ? 1 : 0),
        blocked: cur.blocked + (((a.flags ?? []) as AnswerFlag[]).some(isBlocking) ? 1 : 0),
      });
    }

    return {
      applications: rows.map((r) => {
        const c = counts.get(r.application.id) ?? { total: 0, approved: 0, blocked: 0 };
        return {
          id: r.application.id,
          status: r.application.status,
          company: r.job_posting.company,
          title: r.job_posting.title,
          applyUrl: r.application.applyUrl,
          deadlineAt: r.application.deadlineAt,
          submittedAt: r.application.submittedAt,
          createdAt: r.application.createdAt,
          answerCount: c.total,
          approvedCount: c.approved,
          blockedCount: c.blocked,
        };
      }),
    };
  });

  app.get<{ Params: { id: string } }>('/api/applications/:id', async (req, reply) => {
    const ctx = loadContext(req.params.id);
    if (!ctx) {
      return reply
        .code(404)
        .send({ error: { code: 'NOT_FOUND', message: 'No such application.' } });
    }

    const answers = db
      .select()
      .from(schema.applicationAnswer)
      .where(eq(schema.applicationAnswer.applicationId, req.params.id))
      .all();

    /**
     * What the last fill run could not fill.
     *
     * The live version of this list belongs to the in-memory run, and that run is gone the
     * moment the browser is closed, a second run starts or the server restarts — after any
     * of which the nine fields the user still has to type by hand existed only in a column
     * no endpoint returned. Reading it back here is what makes the copy on the application
     * worth writing.
     */
    const stored = db
      .select({ skippedFields: schema.application.skippedFields })
      .from(schema.application)
      .where(eq(schema.application.id, req.params.id))
      .all()[0];

    const access = await describeAccess();
    return {
      ...ctx,
      id: req.params.id,
      answers: answers.map(answerPayload),
      skippedFields: stored?.skippedFields ?? [],
      canDraft: access.available,
      modelAccess: access,
    };
  });

  /**
   * Adds a question by hand.
   *
   * A fill run does read the form, but it maps essay boxes to answers that already exist
   * here; it never turns a question it found on the page into a workspace question. So
   * pasting the question from the application page is still the only way one gets in.
   */
  app.post<{ Params: { id: string } }>('/api/applications/:id/questions', async (req, reply) => {
    const ctx = loadContext(req.params.id);
    if (!ctx) {
      return reply
        .code(404)
        .send({ error: { code: 'NOT_FOUND', message: 'No such application.' } });
    }

    const sent = refuseIfSent(req.params.id, 'Adding a question to it');
    if (sent) return reply.code(409).send(sent);

    const parsed = QuestionBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: {
          code: 'VALIDATION_FAILED',
          message: parsed.error.issues[0]?.message ?? 'Invalid question.',
        },
      });
    }

    const id = ulid();
    const { questionText, fieldKey, answerType, maxWords } = parsed.data;

    // Offer a previously approved answer, if one is safe to reuse for this company.
    const reusable = findReusable(questionText, ctx.company);
    const profile = confirmedProfile();

    let evidence: AnswerEvidence[] = [];
    let flags: AnswerFlag[] = [];
    if (reusable && profile) {
      const v = verify(reusable.text, questionText, profile, loadStyle(), ctx);
      evidence = v.evidence;
      flags = v.flags;
    }

    db.insert(schema.applicationAnswer)
      .values({
        id,
        applicationId: req.params.id,
        questionText,
        fieldKey: fieldKey || `q_${id.slice(-6).toLowerCase()}`,
        answerType,
        draftText: reusable?.text ?? '',
        finalText: reusable?.text ?? '',
        evidence,
        flags,
        // Reuse pre-fills. It never approves — G3 applies per application.
        approvedAt: null,
      })
      .run();

    const row = db
      .select()
      .from(schema.applicationAnswer)
      .where(eq(schema.applicationAnswer.id, id))
      .all()[0]!;

    return reply.code(201).send({
      ...answerPayload(row),
      reusedFrom: reusable ? { useCount: reusable.useCount, company: reusable.company } : null,
      /**
       * The word ceiling, handed straight back, because there is nowhere to put it.
       *
       * `maxWords` was validated here — a caller sending 3000 got a 400 naming the field —
       * and then dropped on the floor, which is the one behaviour that cannot be right: a
       * limit worth rejecting is a limit somebody believes is being honoured. There is no
       * `max_words` column on `application_answer` to store it in, and drafting takes the
       * ceiling per request (`POST /api/answers/:id/draft`, docs/06 § ③), so this is as far
       * as the question route can carry it: echoed, with the sentence below saying who has
       * to carry it the rest of the way. Same answer as `ignoredFilters` in
       * routes/discovery.ts gives for the filters the query planner does not read — say it
       * out loud rather than let an API caller infer it by reading the source.
       */
      maxWords: maxWords ?? null,
      notes:
        maxWords === undefined
          ? []
          : [
              `The ${String(maxWords)}-word limit is not stored with the question. Send it as ` +
                `{ "maxWords": ${String(maxWords)} } on POST /api/answers/${id}/draft, which is ` +
                'the only place a ceiling reaches the prompt.',
            ],
    });
  });

  app.delete<{ Params: { id: string } }>('/api/answers/:id', async (req, reply) => {
    // The row is read before it is deleted, which it was not: the delete ran against
    // whatever id arrived and answered 204 either way, so a caller could not tell a deleted
    // answer from one that never existed — and a typo in an id read as success.
    const row = db
      .select({ applicationId: schema.applicationAnswer.applicationId })
      .from(schema.applicationAnswer)
      .where(eq(schema.applicationAnswer.id, req.params.id))
      .all()[0];
    if (!row) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'No such answer.' } });
    }

    const sent = refuseIfSent(row.applicationId, 'Deleting this answer');
    if (sent) return reply.code(409).send(sent);

    db.delete(schema.applicationAnswer).where(eq(schema.applicationAnswer.id, req.params.id)).run();
    return reply.code(204).send();
  });

  /** Drafts (or redrafts) one answer. Never approves it. */
  app.post<{ Params: { id: string }; Body: { maxWords?: number } }>(
    '/api/answers/:id/draft',
    async (req, reply) => {
      const row = db
        .select()
        .from(schema.applicationAnswer)
        .where(eq(schema.applicationAnswer.id, req.params.id))
        .all()[0];
      if (!row) {
        return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'No such answer.' } });
      }

      const sent = refuseIfSent(row.applicationId, 'Redrafting it');
      if (sent) return reply.code(409).send(sent);

      const profile = confirmedProfile();
      if (!profile) {
        return reply.code(400).send({
          error: {
            code: 'PROFILE_INCOMPLETE',
            message: 'Confirm your profile first. Drafts are built from confirmed facts only.',
          },
        });
      }
      if (!(await resolveBackend())) {
        const access = await describeAccess();
        return reply.code(400).send({
          error: {
            code: 'NO_MODEL_ACCESS',
            message:
              'Drafting needs either the Claude Code CLI (signed in with your Claude account) ' +
              'or an Anthropic API key. You can also write the answer yourself, and it will ' +
              'still be fact-checked against your profile.',
            details: { modelAccess: access },
          },
        });
      }

      const ctx = loadContext(row.applicationId);
      const emit = (stage: 'retrieve' | 'generate' | 'factguard' | 'style' | 'done'): void =>
        publish({
          type: 'draft.progress',
          applicationId: row.applicationId,
          questionId: row.id,
          stage,
        });

      emit('retrieve');
      const posting = postingWords(ctx);
      let result;
      try {
        emit('generate');
        result = await draftAnswer({
          profile,
          question: row.questionText,
          maxWords: req.body?.maxWords,
          postingContext: posting.postingContext,
          // Same two names the gate is given below. Without them the drafting guard read
          // the employer's own name as an invented organisation, spent the single revision
          // round telling the model to drop the sentence that named it, and the answer to
          // "Why do you want to intern at Nova Robotics?" arrived at G3 with Nova Robotics
          // taken out of it. Mentioning is all this buys: "I interned at Nova Robotics" is
          // still refused, here and at the gate, by `affiliationFrame` in factGuard.ts.
          contextNames: posting.contextNames,
          style: loadStyle(),
          samples: loadSamples(),
        });
      } catch (err) {
        logger.error({ err, answerId: row.id }, 'drafting failed');
        // A usage limit or a missing CLI already carries a message written for the user;
        // passing it through beats replacing it with a generic failure.
        if (err instanceof NoModelAccessError) {
          return reply.code(503).send({ error: { code: 'NO_MODEL_ACCESS', message: err.message } });
        }
        return reply.code(502).send({
          error: {
            code: 'DRAFT_FAILED',
            message: 'The model call failed. Try again, or write the answer yourself.',
          },
        });
      }

      emit('factguard');
      emit('style');
      const v = verify(result.text, row.questionText, profile, loadStyle(), ctx);

      db.update(schema.applicationAnswer)
        .set({
          draftText: result.text,
          finalText: result.text,
          editDistance: 0,
          evidence: v.evidence,
          flags: v.flags,
          // A redraft invalidates any prior approval. The text changed.
          approvedAt: null,
        })
        .where(eq(schema.applicationAnswer.id, row.id))
        .run();

      emit('done');

      const updated = db
        .select()
        .from(schema.applicationAnswer)
        .where(eq(schema.applicationAnswer.id, row.id))
        .all()[0]!;

      return {
        ...answerPayload(updated),
        revised: result.revised,
        // Reported from the pass that produced the flags on this row, not from the drafting
        // loop's own copy. The two ran against different evidence and different names, so the
        // response could say the draft still had unverified claims while the flags beside it
        // were empty and the approve endpoint would have taken it. They agree now, and saying
        // it once means they cannot drift apart again.
        unresolved: v.guard.blocking.length > 0,
        styleNote: v.styleNote,
        styleMatch: v.style.match,
      };
    },
  );

  /** Saves the user's edit and re-verifies it. Editing always clears approval. */
  app.patch<{ Params: { id: string } }>('/api/answers/:id', async (req, reply) => {
    const row = db
      .select()
      .from(schema.applicationAnswer)
      .where(eq(schema.applicationAnswer.id, req.params.id))
      .all()[0];
    if (!row) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'No such answer.' } });
    }

    const sent = refuseIfSent(row.applicationId, 'Editing it');
    if (sent) return reply.code(409).send(sent);

    const parsed = EditBody.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: { code: 'VALIDATION_FAILED', message: 'Expected { text }.' } });
    }

    const profile = confirmedProfile();
    const ctx = loadContext(row.applicationId);
    const text = parsed.data.text;

    // Verification needs a confirmed profile. Without one, the edit is saved but nothing
    // is marked verified — better than showing stale flags against new text.
    const v = profile ? verify(text, row.questionText, profile, loadStyle(), ctx) : null;

    db.update(schema.applicationAnswer)
      .set({
        finalText: text,
        editDistance: wordEditDistance(row.draftText, text),
        // Editing is allowed without a confirmed profile; approving is not. An
        // unverified edit stores no flags rather than stale ones.
        evidence: v?.evidence ?? [],
        flags: v?.flags ?? [],
        approvedAt: null,
      })
      .where(eq(schema.applicationAnswer.id, row.id))
      .run();

    const updated = db
      .select()
      .from(schema.applicationAnswer)
      .where(eq(schema.applicationAnswer.id, row.id))
      .all()[0]!;

    return { ...answerPayload(updated), styleNote: v?.styleNote ?? null, verified: v !== null };
  });

  /**
   * Gate G3.
   *
   * Refuses while any blocking flag stands. The user's route past a false positive is to
   * edit the sentence or add the fact to their profile — not to click through the
   * warning. There is no override parameter, on purpose.
   */
  app.post<{ Params: { id: string } }>('/api/answers/:id/approve', async (req, reply) => {
    const row = db
      .select()
      .from(schema.applicationAnswer)
      .where(eq(schema.applicationAnswer.id, req.params.id))
      .all()[0];
    if (!row) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'No such answer.' } });
    }

    const sent = refuseIfSent(row.applicationId, 'Approving it now');
    if (sent) return reply.code(409).send(sent);

    const text = row.finalText || row.draftText;
    if (text.trim().length === 0) {
      return reply.code(400).send({
        error: { code: 'VALIDATION_FAILED', message: 'There is nothing to approve yet.' },
      });
    }

    // Re-verify at approval time rather than trusting stored flags. Cheap, and it closes
    // the window where a profile edit invalidates an answer nobody re-checked.
    const profile = confirmedProfile();
    // Without a confirmed profile there is nothing to check a claim against, and a
    // verification that cannot run must not read as a verification that passed. Refusing
    // is the only safe reading: `v` being null once meant "zero blocking flags", which
    // let any text through the gate.
    if (!profile) {
      return reply.code(400).send({
        error: {
          code: 'PROFILE_INCOMPLETE',
          message:
            'Confirm your profile first (gate G1). Until then there is nothing to check this ' +
            'answer against, and approving it would mean approving something unverified.',
        },
      });
    }

    const ctx = loadContext(row.applicationId);
    const v = verify(text, row.questionText, profile, loadStyle(), ctx);
    const blocking = v.guard.blocking;
    if (blocking.length > 0) {
      db.update(schema.applicationAnswer)
        .set({ evidence: v.evidence, flags: v.flags })
        .where(eq(schema.applicationAnswer.id, row.id))
        .run();

      return reply.code(409).send({
        error: {
          code: 'UNVERIFIED_CLAIMS',
          message:
            blocking.length === 1
              ? 'One sentence claims something your profile does not support. Fix it, or add the fact to your profile.'
              : `${blocking.length} sentences claim things your profile does not support. Fix them, or add the facts to your profile.`,
          details: {
            claims: blocking.map((c) => ({ claim: c.claim, reason: c.reason, span: c.span })),
          },
        },
      });
    }

    const now = new Date().toISOString();
    db.update(schema.applicationAnswer)
      .set({
        approvedAt: now,
        evidence: v.evidence,
        flags: v.flags,
        editDistance: wordEditDistance(row.draftText, text),
      })
      .where(eq(schema.applicationAnswer.id, row.id))
      .run();

    if (ctx) saveApproved(row.questionText, text, ctx.company);

    db.insert(schema.applicationEvent)
      .values({
        id: ulid(),
        applicationId: row.applicationId,
        type: 'answer_approved',
        payload: { answerId: row.id, question: row.questionText },
      })
      .run();

    const updated = db
      .select()
      .from(schema.applicationAnswer)
      .where(eq(schema.applicationAnswer.id, row.id))
      .all()[0]!;
    return answerPayload(updated);
  });

  app.post<{ Params: { id: string } }>('/api/answers/:id/unapprove', async (req, reply) => {
    // Read, then check, then write — it used to clear the approval first and look for the
    // row afterwards, so the one endpoint that strips a G3 stamp did its write before it
    // knew whose answer it was writing to.
    const row = db
      .select()
      .from(schema.applicationAnswer)
      .where(eq(schema.applicationAnswer.id, req.params.id))
      .all()[0];
    if (!row) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'No such answer.' } });
    }

    const sent = refuseIfSent(row.applicationId, 'Withdrawing your approval of it');
    if (sent) return reply.code(409).send(sent);

    db.update(schema.applicationAnswer)
      .set({ approvedAt: null })
      .where(eq(schema.applicationAnswer.id, row.id))
      .run();

    const updated = db
      .select()
      .from(schema.applicationAnswer)
      .where(eq(schema.applicationAnswer.id, row.id))
      .all()[0]!;
    return answerPayload(updated);
  });

  /** What model access this install has, and why drafting may be unavailable. */
  app.get('/api/model-access', async () => describeAccess());

  /**
   * Runs one real round trip through the configured backend.
   *
   * Worth having as its own endpoint because the CLI path can fail in a way that is not
   * an error: if the prompt never reaches the model, generation still "succeeds" and
   * quietly answers the wrong question. This checks the answer came back.
   */
  app.post('/api/model-access/test', async () => {
    resetBackend();
    resetCliProbe();
    const access = await describeAccess();
    if (access.provider !== 'claude_cli') {
      return { ...access, tested: false, detail: 'Nothing to test for this provider.' };
    }
    // 200 even when the answer is no. The test RAN and produced a verdict, which `ok`
    // carries; a 5xx would say the endpoint is broken, and it would also drop the useful
    // detail, since the client's error path reads a different response shape.
    const result = await claudeCliSelfTest();
    return { ...access, tested: true, ...result };
  });

  app.get('/api/answer-library', async () => ({ entries: listLibrary() }));

  app.delete<{ Params: { id: string } }>('/api/answer-library/:id', async (req, reply) => {
    // The same existence check as DELETE /api/answers/:id above, for the same reason: a 204
    // over an id that was never there tells the caller their delete worked. No sent-record
    // guard, though — a library entry is a copy kept for reuse, and removing it changes
    // nothing about what any employer was told.
    const row = db
      .select({ id: schema.answerTemplate.id })
      .from(schema.answerTemplate)
      .where(eq(schema.answerTemplate.id, req.params.id))
      .all()[0];
    if (!row) {
      return reply
        .code(404)
        .send({ error: { code: 'NOT_FOUND', message: 'No such saved answer.' } });
    }

    db.delete(schema.answerTemplate).where(eq(schema.answerTemplate.id, req.params.id)).run();
    return reply.code(204).send();
  });
}

function isBlocking(f: AnswerFlag): boolean {
  return f.type === 'unsupported' || f.type === 'overstated';
}
