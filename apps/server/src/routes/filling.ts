/**
 * Form filling — docs/07-form-automation.md.
 *
 * THERE IS NO SUBMIT ENDPOINT HERE, and there never will be. The closest thing is
 * `mark-submitted`, which records that the USER submitted the application on the real page.
 * It writes a timestamp; it does not touch a browser.
 *
 * Filling is gated twice over. The profile must be confirmed (G1) and every answer on the
 * application must be approved (G3) before a single key is pressed, and that check is here
 * on the server rather than in the browser.
 */
import { existsSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { ulid } from 'ulid';
import type {
  ApiErrorCode,
  ApplicationAnswer,
  ApplicationStatus,
  ConfirmedProfile,
} from '@ia/shared';
import { MarkSubmittedRequest } from '@ia/shared';
import { db, schema } from '../infra/db/client';
import { decryptField } from '../infra/crypto/fieldCrypto';
import { logger } from '../infra/logger';
import { getProfile } from '../core/profile/repository';
import { canTransition } from '../core/tracking/status';
import { isActionable } from '../core/filling/classify';
import {
  gatePostingContext,
  recheckApproval,
  withdrawnApprovalColumns,
} from '../core/filling/plan';
import type { FieldResult } from '../core/filling/fill';
import {
  continueRun,
  discardRun,
  getRun,
  serializeRun,
  SourceRefusedError,
  startRun,
  type StartInput,
} from '../core/filling/run';

/**
 * The statuses a fill run passes through, in order, and therefore the only statuses an
 * application can be filled from.
 *
 * A run genuinely covers three of them in one go: every answer is approved, the form has
 * been typed into, and the user is left to press submit themselves. Everything after
 * `awaiting_submit` describes something that happened out in the world, which no amount of
 * typing into a form can undo.
 */
const FILL_PATH: ApplicationStatus[] = ['draft', 'answers_ready', 'filled', 'awaiting_submit'];

/**
 * How each of the statuses beyond a fill run's reach is put to the user.
 *
 * Written out one by one because the status names do not survive being dropped into a
 * sentence: "This application is already interview" is not something a person would say.
 */
const PAST_FILLING: Partial<Record<ApplicationStatus, string>> = {
  submitted: 'You have already sent this one.',
  acknowledged: 'The employer has already acknowledged this one.',
  interview: 'This one has already reached the interview stage.',
  offer: 'This one has already reached an offer.',
  rejected: 'This one has already been turned down.',
  withdrawn: 'You withdrew this one.',
  ghosted: 'This one has been quiet long enough to count as gone.',
};

/**
 * Where a finished run may move an application, or nothing if the model refuses.
 *
 * The route used to write `awaiting_submit` straight over whatever was stored, without
 * asking. That is a jump the status model refuses — `draft → awaiting_submit` is not a legal
 * hop, so the one transition this tool makes on its own was the one transition nothing
 * checked. Walking the path a hop at a time is how the write earns the status it claims.
 *
 * It also refuses outright for anything past `awaiting_submit`, which is what the damage
 * was. Re-opening a fill on an application already sent dragged it from "Waiting" back to
 * "Ready for you" and put "The form is filled. Read it and submit it yourself." beside a
 * submission date — an invitation to apply to the same job twice.
 */
function advanceToAwaitingSubmit(from: ApplicationStatus): ApplicationStatus | null {
  const start = FILL_PATH.indexOf(from);
  if (start < 0) return null;

  let current = from;
  for (const next of FILL_PATH.slice(start + 1)) {
    if (!canTransition(current, next, 'tool').ok) return null;
    current = next;
  }
  return current;
}

interface Loaded {
  applyUrl: string;
  answers: ApplicationAnswer[];
  profile: ConfirmedProfile;
  resumePath?: string;
}

type LoadResult =
  { ok: true; data: Loaded } | { ok: false; code: string; message: string; details?: unknown };

/**
 * Gathers everything a run needs, and refuses if any gate is open.
 *
 * Returns the refusal rather than throwing so each caller can answer with the right status
 * code and the user gets told which gate stopped them.
 *
 * Exported so the gates and the resume lookup can be checked without opening a browser.
 */
export function load(applicationId: string): LoadResult {
  const row = db
    .select()
    .from(schema.application)
    .innerJoin(schema.match, eq(schema.application.matchId, schema.match.id))
    .innerJoin(schema.jobPosting, eq(schema.match.postingId, schema.jobPosting.id))
    .where(eq(schema.application.id, applicationId))
    .all()[0];

  if (!row) return { ok: false, code: 'NOT_FOUND', message: 'No such application.' };

  // An application the user has already sent is finished with as far as this tool is
  // concerned, and typing into its form again would be the least of it: the status write at
  // the end of a run put it back in "Ready for you" and asked the user to submit something
  // they had submitted weeks ago. Nothing here checked, and the review screen still offers
  // the buttons after a reload, because it remembers the submission only for as long as the
  // page stays open.
  const status = row.application.status as ApplicationStatus;
  if (!FILL_PATH.includes(status)) {
    return {
      ok: false,
      code: 'PAST_FILLING',
      message:
        `${PAST_FILLING[status] ?? `This application is already ${status.replace(/_/g, ' ')}.`} ` +
        'Filling the form again would move it back to "Ready for you" and ask you to submit ' +
        'something that is no longer waiting on you.',
    };
  }

  const profile = getProfile();
  if (!profile?.confirmedAt) {
    return {
      ok: false,
      code: 'PROFILE_INCOMPLETE',
      message: 'Confirm your profile first (gate G1). Forms are filled from confirmed facts only.',
    };
  }

  const answers = db
    .select()
    .from(schema.applicationAnswer)
    .where(eq(schema.applicationAnswer.applicationId, applicationId))
    .all() as unknown as ApplicationAnswer[];

  // Gate G3, and docs/03 invariant 2. An application with an unapproved answer cannot be
  // filled, because filling is what would put that answer in front of an employer.
  const unapproved = answers.filter((a) => !a.approvedAt);
  if (unapproved.length > 0) {
    return {
      ok: false,
      code: 'ANSWERS_NOT_APPROVED',
      message:
        unapproved.length === 1
          ? 'One answer has not been approved yet. Review it first (gate G3).'
          : `${unapproved.length} answers have not been approved yet. Review them first (gate G3).`,
      details: { questions: unapproved.map((a) => a.questionText) },
    };
  }

  /**
   * Gate G3 again, and this time against the profile as it stands rather than against the
   * stamp somebody left on the row.
   *
   * `approvedAt` records that a person checked this answer once. It does not record what
   * they checked it against, and the profile is editable for the whole life of an
   * application: the G1 wizard stays reachable from the nav after confirmation and its Save
   * button PUTs the whole profile. So a user could approve "I interned at Kestrel
   * Analytics", delete that entry from their profile an hour later, and the sentence went on
   * wearing this tool's green tick all the way into an employer's form, with an evidence
   * panel citing `experience.0` while `experience` was empty. Every existing trigger that
   * re-runs verification is a change to the ANSWER; nothing watched the other side.
   *
   * The re-check runs the same pass the approve route runs, so an untouched profile can
   * never turn an approval over: both are deterministic and both are handed the same
   * evidence and the same context names. Where it does turn one over, the stamp is removed
   * and the fresh verdicts are written to the row, because a refusal that left the review
   * screen still showing "approved" would send the user back to a card with nothing wrong
   * with it.
   */
  const stale = answers
    .map((a) => ({
      answer: a,
      recheck: recheckApproval({
        text: a.finalText || a.draftText,
        questionText: a.questionText,
        profile: profile as ConfirmedProfile,
        contextNames: [row.job_posting.company, row.job_posting.title],
        // Built the same way the approve route builds it. The description alone is a
        // different retrieval query and therefore, past retrieval's ceiling, a different
        // corpus — so this gate could refuse the fill over a fact G3 had in front of it.
        postingContext: gatePostingContext({
          title: row.job_posting.title,
          company: row.job_posting.company,
          description: row.job_posting.descriptionText,
        }),
      }),
    }))
    .filter((r) => !r.recheck.ok);

  if (stale.length > 0) {
    const now = new Date().toISOString();
    for (const { answer, recheck } of stale) {
      db.update(schema.applicationAnswer)
        .set(withdrawnApprovalColumns(answer.flags, recheck))
        .where(eq(schema.applicationAnswer.id, answer.id))
        .run();

      db.insert(schema.applicationEvent)
        .values({
          id: ulid(),
          applicationId,
          type: 'approval_withdrawn',
          payload: {
            answerId: answer.id,
            question: answer.questionText,
            at: now,
            claims: recheck.blocking,
          },
        })
        .run();

      logger.info(
        { applicationId, answerId: answer.id, claims: recheck.blocking.length },
        'approval withdrawn: the answer no longer passes FactGuard against the current profile',
      );
    }

    return {
      ok: false,
      code: 'ANSWERS_NOT_APPROVED',
      message:
        (stale.length === 1
          ? 'One answer was approved against an older version of your profile and no longer '
          : `${stale.length} answers were approved against an older version of your profile and no longer `) +
        'matches it, so their approval has been withdrawn and nothing was typed. ' +
        'Review them again at gate G3.',
      details: {
        questions: stale.map((s) => s.answer.questionText),
        claims: stale.flatMap((s) => s.recheck.blocking),
      },
    };
  }

  const resume = row.application.resumeDocumentId
    ? db
        .select()
        .from(schema.resumeDocument)
        .where(eq(schema.resumeDocument.id, row.application.resumeDocumentId))
        .all()[0]
    : db
        .select()
        .from(schema.resumeDocument)
        .all()
        .find((r) => r.isPrimary);

  return {
    ok: true,
    data: {
      applyUrl: row.application.applyUrl,
      answers,
      profile: profile as ConfirmedProfile,
      resumePath: resume ? readableResumePath(resume.id, resume.path) : undefined,
    },
  };
}

/**
 * The path a resume can actually be attached from, or nothing.
 *
 * `resume_document.path` is stored encrypted with the row id as its additional data, like
 * every other piece of PII in the database. Handing that column straight to the run meant
 * the filler was asked to attach a file named `v1:RUBjO4-OGVlnZuT4:...` — which is not a
 * path that exists and, with three colons in it, not even a legal one on Windows. Every
 * resume upload field on every form therefore came back red with a raw ENOENT for a note,
 * and there was no way for a user to get a resume attached at all.
 *
 * A path that cannot be produced for any reason — a row encrypted under a key that is gone,
 * a file the user deleted from data/resumes by hand — yields nothing rather than a broken
 * path, so the plan reports the honest "No resume file is attached to this application."
 * skip instead of failing the field with a message about the internals.
 */
function readableResumePath(id: string, storedPath: string): string | undefined {
  let decoded: string;
  try {
    decoded = decryptField(storedPath, id);
  } catch (err) {
    logger.warn({ err, resumeId: id }, 'could not decrypt the stored resume path');
    return undefined;
  }
  if (!existsSync(decoded)) {
    logger.warn({ resumeId: id }, 'the stored resume is no longer on disk');
    return undefined;
  }
  return decoded;
}

/**
 * Why one field was left for the user, in the four words the stored column allows.
 *
 * Everything that was not a redline and did not throw used to be recorded as
 * `unclassified`, which was a straight untruth about most of them. A field the tool
 * understood perfectly well and typed into, only for the page to hand back a different
 * value, was filed under "this tool could not tell what this field is asking for" — and so
 * was a GPA box left empty because the profile has no GPA. Someone reading their exported
 * data came away thinking the form was full of fields nothing could make sense of.
 *
 * `mismatch` shares `failed` because the honest thing both say is that the value did not
 * land, and the review screen is where the difference between them is spelled out.
 */
function skipReason(r: FieldResult): 'redline' | 'unclassified' | 'no_match' | 'failed' {
  if (r.field.semantic === 'REDLINE') return 'redline';
  if (r.status === 'failed' || r.status === 'mismatch') return 'failed';
  // The same question the planner asked before it skipped this field: could the field be
  // named at all? If it could, the tool knew what was wanted and had nothing to put there.
  return isActionable(r.field) ? 'no_match' : 'unclassified';
}

/**
 * The refusals `continueRun` throws about the run itself, rather than about the page.
 *
 * Everything out of a continue used to come back as a 502 FILL_FAILED — "the site did
 * something we could not handle" — including the two cases that are nothing of the sort:
 * there is no open run, or one is already typing. A client told 502 retries, which for the
 * second of those means a second continue racing the first over the same keyboard, and the
 * user reads a bad-gateway message about a browser that is working fine. Both are conflicts,
 * the same way NO_RUN below already is, and both are worth naming so a caller can tell
 * "wait" from "something broke".
 *
 * Matched on the message prefix because these are plain `Error`s from core/filling/run.ts.
 * Any new refusal added there that describes the run rather than the page belongs in this
 * list too — typed as `ApiErrorCode` so adding one without declaring it fails the build
 * rather than waiting for scripts/audit-error-codes.ts to notice.
 */
export const RUN_CONFLICTS: Array<{ startsWith: string; code: ApiErrorCode }> = [
  { startsWith: 'This application is already being filled', code: 'FILL_IN_PROGRESS' },
  { startsWith: 'No open fill run for this application', code: 'NO_RUN' },
  // Raised by `startRun` and by `continueRun`, both from `claimBrowser`. A 502 here would be
  // the worst answer available: it reads as "the site broke", and the client that retries it
  // is racing the very run this refusal exists to protect.
  { startsWith: 'Another application has the browser open', code: 'FILL_BROWSER_BUSY' },
  { startsWith: 'This fill run was discarded', code: 'NO_RUN' },
  // The user pressed stop. A 409 rather than the 502 that says the site broke, and — because
  // this is a conflict and not a completion — the route below never reaches the code that
  // would have recorded the abandoned fill as `filled` and walked the application on.
  { startsWith: 'This fill run was stopped', code: 'NO_RUN' },
];

function refuse(
  reply: { code: (n: number) => { send: (b: unknown) => unknown } },
  r: Extract<LoadResult, { ok: false }>,
) {
  // A conflict rather than a bad request: the call was well formed, the application is
  // simply somewhere a fill run has no business touching.
  const status = r.code === 'NOT_FOUND' ? 404 : r.code === 'PAST_FILLING' ? 409 : 400;
  return reply
    .code(status)
    .send({ error: { code: r.code, message: r.message, details: r.details } });
}

export async function fillingRoutes(app: FastifyInstance): Promise<void> {
  /** Opens the page and reads it. Types nothing. */
  app.post<{ Params: { id: string } }>('/api/applications/:id/fill', async (req, reply) => {
    const loaded = load(req.params.id);
    if (!loaded.ok) return refuse(reply, loaded);

    const input: StartInput = {
      applicationId: req.params.id,
      applyUrl: loaded.data.applyUrl,
      profile: loaded.data.profile,
      answers: loaded.data.answers,
      resumePath: loaded.data.resumePath,
    };

    /**
     * The same conflict handling continue has had, because start can now refuse too.
     *
     * `startRun` used to report every outcome through `run.state === 'failed'`, so this route
     * needed no catch. It now throws before a run exists at all for the two cases that are
     * conflicts rather than failures — this application is already opening a browser, or a
     * different one has the window — and without this those reached Fastify's handler as a
     * 500 INTERNAL, which tells the user their server is broken when what they have to do is
     * close the other browser.
     */
    try {
      const run = await startRun(input);
      if (run.state === 'failed') {
        return reply.code(502).send({ error: { code: 'FILL_FAILED', message: run.message } });
      }
      return serializeRun(run);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Our refusal, not their failure: 502 would invite a retry of something that will
      // never be allowed to happen, and the way forward is a different screen entirely.
      if (err instanceof SourceRefusedError) {
        logger.info({ applicationId: req.params.id }, 'fill start refused: host is not opened');
        return reply.code(400).send({ error: { code: 'SOURCE_REFUSED', message } });
      }
      const conflict = RUN_CONFLICTS.find((c) => message.startsWith(c.startsWith));
      if (conflict) {
        logger.info(
          { applicationId: req.params.id, code: conflict.code },
          'fill start refused: the browser is not free',
        );
        return reply.code(409).send({ error: { code: conflict.code, message } });
      }
      logger.error({ err, applicationId: req.params.id }, 'fill start failed');
      return reply.code(502).send({ error: { code: 'FILL_FAILED', message } });
    }
  });

  /**
   * Types the plan into the page that is already open.
   *
   * Also the resume point after a login wall or a bot check: the user deals with it in the
   * browser, then calls this.
   */
  app.post<{ Params: { id: string } }>(
    '/api/applications/:id/fill/continue',
    async (req, reply) => {
      const loaded = load(req.params.id);
      if (!loaded.ok) return refuse(reply, loaded);

      if (!getRun(req.params.id)) {
        return reply.code(409).send({
          error: {
            code: 'NO_RUN',
            message: 'There is no open browser for this application. Start a fill run first.',
          },
        });
      }

      try {
        const run = await continueRun({
          applicationId: req.params.id,
          applyUrl: loaded.data.applyUrl,
          profile: loaded.data.profile,
          answers: loaded.data.answers,
          resumePath: loaded.data.resumePath,
        });

        /**
         * A run that typed NOTHING has not filled the form, whatever state it ended in.
         *
         * This keyed on `state === 'done'` alone. A page that navigates after the first field
         * marks every remaining action `failed` and still ends `done`, so an application with
         * 0 filled and 18 failed was walked through `filled` to `awaiting_submit` and got a
         * `filled` event — the tracker telling the user the form was ready to submit over a
         * form nothing had been typed into. The message and `skippedFields` were honest all
         * along; the status and the event were not.
         *
         * `filled > 0` rather than "no failures", because a run that fills fourteen fields and
         * loses four to a widget genuinely did fill the form, and the review screen is where
         * the four are dealt with. Zero is the case that means nothing happened.
         */
        /**
         * THE LIST IS RECORDED WHENEVER A RUN FINISHED; ONLY THE STATUS WAITS FOR A FILL.
         *
         * Both used to sit behind `filled > 0`, and the two want different conditions. A form
         * whose every field is redlined — an SSN, an EEO block, an attestation, nothing this
         * tool may type — fills zero and produces the LONGEST list of fields the student has
         * to do themselves. That list was computed, shown once in the review panel, and never
         * written down: the panel reads the run in memory, which is gone when the browser
         * closes, a second run starts or the server stops. The student came back to the
         * application and the column `GET /api/applications/:id` reads was empty, so the app
         * had nothing to say about what it had left them.
         *
         * The status guard stays exactly as it was, for the reason its own comment gives.
         */
        if (run.state === 'done' && run.result) {
          const skipped = run.result.results
            .filter((r) => r.status !== 'ok')
            .map((r) => ({
              label: r.field.label,
              reason: skipReason(r),
              category: r.field.redlineCategory,
            }));
          const filledSomething = run.result.filled > 0;

          /**
           * The status is read again here rather than reused from `load()`.
           *
           * A run takes minutes — a login wall, a bot check, a long form — and the user
           * spends them in the browser with the tracker open in another tab. Someone who
           * finishes the form by hand and records that on the board while the run is still
           * open would, on the stale status, have had the finished run overwrite
           * `submitted` with `awaiting_submit` the moment it caught up.
           */
          const current = db
            .select({ status: schema.application.status })
            .from(schema.application)
            .where(eq(schema.application.id, req.params.id))
            .all()[0];

          // `awaiting_submit` is as far as this app will ever move an application on its
          // own. The next status is written by the user telling us they submitted it.
          const next = current
            ? advanceToAwaitingSubmit(current.status as ApplicationStatus)
            : null;
          if (!next) {
            logger.warn(
              { applicationId: req.params.id, status: current?.status },
              'fill finished on an application that has moved past filling; leaving its status alone',
            );
          }

          // What the run found is recorded either way. The form really was filled, and
          // dropping that on the floor because the status moved underneath us would lose
          // the list of fields the user still has to fill in themselves.
          //
          // This copy is the one that survives. The list the review panel shows comes from
          // the run in memory, and that is discarded when the browser is closed, when a
          // second run starts and when the server stops — so it is this column, read back
          // by GET /api/applications/:id, that can still answer the question afterwards.
          db.update(schema.application)
            .set({
              ...(next && filledSomething ? { status: next } : {}),
              skippedFields: skipped,
              updatedAt: new Date().toISOString(),
            })
            .where(eq(schema.application.id, req.params.id))
            .run();

          // The event says the form was filled, so it belongs to the same condition the
          // status does: a `filled` event over a form nothing was typed into is the tracker
          // telling the user it is ready to submit when it is not.
          if (filledSomething) {
            db.insert(schema.applicationEvent)
              .values({
                id: ulid(),
                applicationId: req.params.id,
                type: 'filled',
                payload: { filled: run.result.filled, skipped: skipped.length },
              })
              .run();
          }
        }

        return serializeRun(run);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const conflict = RUN_CONFLICTS.find((c) => message.startsWith(c.startsWith));
        if (conflict) {
          logger.info(
            { applicationId: req.params.id, code: conflict.code },
            'fill continue refused: the run is not in a state that can be continued',
          );
          return reply.code(409).send({ error: { code: conflict.code, message } });
        }
        logger.error({ err, applicationId: req.params.id }, 'fill continue failed');
        return reply.code(502).send({ error: { code: 'FILL_FAILED', message } });
      }
    },
  );

  app.get<{ Params: { id: string } }>('/api/applications/:id/fill', async (req, reply) => {
    const run = getRun(req.params.id);
    if (!run) {
      return reply.code(404).send({
        error: { code: 'NOT_FOUND', message: 'No fill run is open for this application.' },
      });
    }
    return serializeRun(run);
  });

  /** Closes the browser without filling anything. */
  app.delete<{ Params: { id: string } }>('/api/applications/:id/fill', async (req, reply) => {
    await discardRun(req.params.id);
    return reply.code(204).send();
  });

  /**
   * Gate G4, recorded rather than performed.
   *
   * The user submits the application themselves, on the real page, and then tells the
   * tracker they did. This endpoint writes a timestamp. It does not open a browser and it
   * does not click anything.
   *
   * It is not the only writer of `submitted_at` — a user moving an application to
   * `submitted` through POST /api/applications/:id/status writes it too. Both are things a
   * person did, which is what G4 actually requires; "the only endpoint" was a neater claim
   * than the truth, and docs/03 states the accurate version.
   *
   * Two things make that more than a slogan. The body must actually say `confirmed: true`,
   * and the application must be somewhere the status model allows `submitted` to follow
   * from. Neither used to be checked. Any bare POST that reached this URL — a double-click,
   * a retry after a dropped connection, a client firing on the wrong row — stamped
   * `submitted` on whatever it found, including a draft with no form filled and not one
   * answer approved, and the user was then looking at a board that said they had applied
   * somewhere they had not. All of G4 rests on a person saying they did it, and the server
   * was taking nobody's word for anything, because it never asked. The sibling /status route
   * has enforced the same state machine all along.
   */
  app.post<{ Params: { id: string } }>(
    '/api/applications/:id/mark-submitted',
    async (req, reply) => {
      const parsed = MarkSubmittedRequest.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: {
            code: 'CONFIRMATION_REQUIRED',
            message:
              'Send { "confirmed": true } to record that you submitted this yourself on the ' +
              'real page. Nothing has been recorded.',
          },
        });
      }

      const row = db
        .select()
        .from(schema.application)
        .where(eq(schema.application.id, req.params.id))
        .all()[0];
      if (!row) {
        return reply
          .code(404)
          .send({ error: { code: 'NOT_FOUND', message: 'No such application.' } });
      }

      // `user` is the honest caller: this endpoint exists precisely because a person, not
      // this tool, did the submitting. That is the same actor the /status route passes.
      const allowed = canTransition(row.status as ApplicationStatus, 'submitted', 'user');
      if (!allowed.ok) {
        return reply
          .code(409)
          .send({ error: { code: 'ILLEGAL_TRANSITION', message: allowed.reason } });
      }

      const now = new Date().toISOString();
      // The first submission is the one that happened. Overwriting the timestamp on a
      // second call restarted the silence clock the tracker measures ghosting from, so an
      // application nobody had answered in two months went back to looking freshly sent.
      const submittedAt = row.submittedAt ?? now;
      db.update(schema.application)
        .set({ status: 'submitted', submittedAt, updatedAt: now })
        .where(eq(schema.application.id, req.params.id))
        .run();

      db.insert(schema.applicationEvent)
        .values({
          id: ulid(),
          applicationId: req.params.id,
          type: 'marked_submitted',
          payload: { by: 'user', note: parsed.data.note ?? null },
        })
        .run();

      await discardRun(req.params.id);
      return { id: req.params.id, status: 'submitted', submittedAt };
    },
  );
}
