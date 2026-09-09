import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { ulid } from 'ulid';
import type { AnswerFlag, ConfirmedProfile } from '@ia/shared';
import { CandidateProfile } from '@ia/shared';
import { db, schema } from '../infra/db/client';
import { logger } from '../infra/logger';
import {
  confirmProfile,
  getProfile,
  getProfileHeader,
  saveProfile,
} from '../core/profile/repository';
import {
  gatePostingContext,
  recheckApproval,
  withdrawnApprovalColumns,
} from '../core/filling/plan';
import { dismissalRefusal } from '../core/profile/reviewFlags';

/**
 * Which door the profile write came through, recorded on the `approval_withdrawn` event.
 *
 * Worth distinguishing because the two read very differently on a history screen: a user who
 * edited one field expects a small consequence, and a user who re-uploaded their resume
 * replaced every fact at once. Recording both as `profile_edited` said the wrong thing about
 * the second.
 */
type WriteCause = 'profile_edited' | 'resume_reextracted';

/** One answer whose G3 approval this write took away, and the claims that cost it. */
interface WithdrawnApproval {
  answerId: string;
  applicationId: string;
  question: string;
  claims: Array<{ claim: string; reason: string }>;
}

/**
 * Re-checks every approved answer against the profile that was just written, and takes the
 * approval off the ones it no longer supports.
 *
 * THE FAILURE THIS EXISTS FOR. A user approved "I interned at Kestrel Analytics, where I
 * built internal tooling in TypeScript" at G3, then went back to the profile wizard and
 * deleted that job. The answer kept its green tick, kept an evidence panel citing
 * `experience.0` while `experience` was empty, and the fill planner went on offering the
 * sentence as something to type into the employer's form. G3 is supposed to mean "a human
 * checked this against the profile"; after that edit it meant "a human checked this against
 * a profile that no longer exists". Every trigger that re-ran verification was a change to
 * the ANSWER — a redraft, a user edit, an explicit unapprove — and there was no trigger at
 * all on the other side.
 *
 * Only answers that FAIL lose their stamp. Blanket-invalidating everything on any profile
 * write would be simpler and would be its own small cruelty: correcting a postal code would
 * send the user back through a dozen answers that were never in question. The check is the
 * same deterministic pass the approve route runs, so an edit that touches nothing an answer
 * relies on turns nothing over.
 *
 * Answers on an application the user has already sent are left alone. That text reached the
 * employer; marking it "not approved" afterwards would be the tool telling a story about
 * something it cannot change, on a card whose only honest state is what was submitted.
 */
function withdrawStaleApprovals(profile: CandidateProfile, cause: WriteCause): WithdrawnApproval[] {
  const rows = db
    .select()
    .from(schema.applicationAnswer)
    .innerJoin(
      schema.application,
      eq(schema.applicationAnswer.applicationId, schema.application.id),
    )
    .innerJoin(schema.match, eq(schema.application.matchId, schema.match.id))
    .innerJoin(schema.jobPosting, eq(schema.match.postingId, schema.jobPosting.id))
    .all();

  const withdrawn: WithdrawnApproval[] = [];

  for (const row of rows) {
    const answer = row.application_answer;
    if (!answer.approvedAt) continue;
    if (row.application.submittedAt) continue;

    const recheck = recheckApproval({
      text: answer.finalText || answer.draftText,
      questionText: answer.questionText,
      /**
       * The facts, whether or not the stamp on them is still there.
       *
       * `recheckApproval` is typed for a `ConfirmedProfile` because everything else that
       * reads a profile PRODUCES something from it — a draft, a filled form — and none of
       * that may run on facts a human has not signed off. This pass only ever takes a green
       * tick AWAY, so reading a profile whose confirmation was revoked a moment ago is the
       * conservative direction rather than the forbidden one.
       *
       * The concrete case is the resume re-upload: `routes/resumes.ts` replaces the whole
       * profile and resets `confirmedAt` to null, and while this function refused to look at
       * an unconfirmed profile the sweep on that path did nothing at all — leaving every G3
       * card showing a green tick over an evidence panel quoting a profile that no longer
       * existed.
       */
      profile: profile as ConfirmedProfile,
      // The employer's name and the role title, exactly as the approve route passes them.
      // Without them the company's own name reads as an invention and a "why this company"
      // answer would lose its approval on every profile save.
      contextNames: [row.job_posting.company, row.job_posting.title],
      // The role title and the company in front of the description, exactly as the approve
      // route builds it. Passing the description alone ranked the same profile against a
      // different query, and on a profile with more facts than retrieval's ceiling that is a
      // different corpus — which means this sweep could withdraw a tick over a fact the
      // approve route had in front of it and this one did not.
      postingContext: gatePostingContext({
        title: row.job_posting.title,
        company: row.job_posting.company,
        description: row.job_posting.descriptionText,
      }),
    });
    if (recheck.ok) continue;

    db.update(schema.applicationAnswer)
      .set(withdrawnApprovalColumns(answer.flags as AnswerFlag[] | null, recheck))
      .where(eq(schema.applicationAnswer.id, answer.id))
      .run();

    db.insert(schema.applicationEvent)
      .values({
        id: ulid(),
        applicationId: answer.applicationId,
        type: 'approval_withdrawn',
        payload: {
          answerId: answer.id,
          question: answer.questionText,
          cause,
          claims: recheck.blocking,
        },
      })
      .run();

    withdrawn.push({
      answerId: answer.id,
      applicationId: answer.applicationId,
      question: answer.questionText,
      claims: recheck.blocking,
    });
  }

  if (withdrawn.length > 0) {
    logger.info(
      { count: withdrawn.length },
      'profile write withdrew approvals that no longer pass FactGuard against it',
    );
  }
  return withdrawn;
}

/**
 * The sweep, run after any write that can change what the profile says.
 *
 * Exported because this route is not the only writer. A resume re-extraction saves a whole
 * new profile from `routes/resumes.ts`, which is the same event by a different door, and it
 * calls this on the profile it just saved rather than growing a second copy of the rule.
 *
 * It used to return early on an unconfirmed profile, on the reasoning that an unconfirmed
 * profile cannot have produced an approval. That is true of a profile that was never
 * confirmed and false of the one case where it mattered: a re-extraction resets `confirmedAt`
 * to null on a profile that HAD been confirmed and whose approvals are still on the answers,
 * so the guard switched the sweep off at exactly the door it was exported for. Nothing
 * false-green ever reached an employer — `load()` in routes/filling.ts catches that path
 * before a key is pressed — but between the re-upload and the next fill attempt the review
 * screen showed a green tick beside an evidence panel quoting a profile that no longer
 * existed, and the user had no reason to look again.
 *
 * A never-confirmed profile still costs nothing here: no answer can carry `approvedAt`
 * without a confirmation having happened, so the loop below skips every row.
 */
export function sweepApprovals(
  profile: CandidateProfile,
  cause: WriteCause = 'profile_edited',
): WithdrawnApproval[] {
  return withdrawStaleApprovals(profile, cause);
}

export async function profileRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/profile', async (_req, reply) => {
    const p = getProfile();
    if (!p) {
      return reply
        .code(404)
        .send({ error: { code: 'NOT_FOUND', message: 'No profile yet. Upload a resume first.' } });
    }
    return p;
  });

  /**
   * A profile to fill in by hand, for anyone who cannot have one read for them.
   *
   * `GET /api/model-access` has always answered a machine with no model by saying "Resume
   * reading is unavailable, so profile fields must be entered by hand." There was no by-hand
   * path. Onboarding.tsx moves off its first step only through `onExtracted`, which only a
   * successful model call fires, so a user with no Claude CLI and no API key met a dropzone
   * that could not work, an error telling them to do something the interface did not offer,
   * and no way forward — and because everything downstream is gated on G1, that was the whole
   * application. The advice was right; the route it assumed was missing.
   *
   * Built from the same `toDraftProfile` an extraction goes through, on purpose. A blank
   * profile assembled anywhere else would have to restate the derived fields and the review
   * flags, and the copy that drifted would be the one deciding whether G1 can be passed.
   * Everything unset arrives flagged, so this is a longer road to G1, never a way around it.
   *
   * Nothing is stored. Like an extraction, the draft goes to the client, which sends it back
   * through `PUT /api/profile` once the user has put something in it.
   */
  app.post('/api/profile/blank', async () => {
    const { ResumeExtraction } = await import('../core/ingestion/extractProfile');
    const { toDraftProfile } = await import('../core/ingestion/toProfile');
    const empty = ResumeExtraction.parse({
      fullName: null,
      pronouns: null,
      email: null,
      phone: null,
      location: null,
      links: { github: null, linkedin: null, portfolio: null },
      education: [],
      experience: [],
      projects: [],
      skills: [],
      certifications: [],
      languages: [],
      needsReview: [],
    });
    const profile = toDraftProfile(empty);
    return { profile, needsReview: profile.needsReview, withdrawnApprovals: [] };
  });

  app.put('/api/profile', async (req, reply) => {
    const parsed = CandidateProfile.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Profile did not match the expected shape.',
          details: { issues: parsed.error.issues },
        },
      });
    }
    // Confirmation is a separate, explicit action — a PUT can never confirm.
    //
    // Read through the header rather than the whole profile: only `confirmedAt` is wanted,
    // and decrypting-and-parsing the stored row to get it made this route fail on exactly
    // the rows it exists to repair. One field the schema will not take — a year-only
    // graduation date, a link with no scheme — and the PUT carrying the correction threw on
    // the way IN, before it had looked at the body, so the profile could be neither fixed
    // nor replaced.
    const existing = getProfileHeader();
    const saved = saveProfile({ ...parsed.data, confirmedAt: existing?.confirmedAt ?? null });

    /**
     * The G3 approvals this edit just outlived, alongside the profile it was asked to save.
     *
     * Nothing in apps/web reads this yet; the place it belongs is the toast Onboarding.tsx
     * shows after `persist()` succeeds. The user is still told, on the screen where it
     * matters: each answer is back to "not approved" on its application card with the
     * withdrawal sentence beside the claim that lost it. This field is here so that a
     * caller driving the local API — which is a supported way to use this server — does not
     * have to diff the answers itself to discover that a save had consequences.
     */
    return { ...saved, withdrawnApprovals: sweepApprovals(saved) };
  });

  /** Gate G1. */
  app.post('/api/profile/confirm', async (_req, reply) => {
    try {
      return confirmProfile();
    } catch (err) {
      const code = (err as Error & { code?: string }).code;
      if (code === 'PROFILE_INCOMPLETE') {
        return reply.code(400).send({
          error: {
            code: 'PROFILE_INCOMPLETE',
            message: (err as Error).message,
            details: { needsReview: getProfile()?.needsReview ?? [] },
          },
        });
      }
      /**
       * A missing profile is a 404. A broken one is not.
       *
       * `confirmProfile` can throw four different things and only one of them means "nothing
       * is there": the other three are a stored row that will not decrypt, one that will not
       * parse, and a write that failed. All four landed on this hardcoded 404 with the
       * message "No profile yet. Upload a resume first." — so a student whose profile was
       * CORRUPT was told to do the thing they had already done, and doing it again would not
       * have helped, because a re-upload merges over the row that will not read.
       */
      if (code === 'NOT_FOUND') {
        return reply
          .code(404)
          .send({ error: { code: 'NOT_FOUND', message: (err as Error).message } });
      }
      logger.error({ err }, 'profile confirmation failed');
      return reply.code(500).send({
        error: {
          code: 'INTERNAL',
          message:
            'Your profile could not be confirmed: it is stored but could not be read back. ' +
            'The server log has the details.',
        },
      });
    }
  });

  /** Clear one review flag — the UI calls this when the user edits a flagged field. */
  app.post<{ Params: { path: string } }>('/api/profile/reviewed/:path', async (req, reply) => {
    const p = getProfile();
    if (!p) {
      return reply
        .code(404)
        .send({ error: { code: 'NOT_FOUND', message: 'No profile yet. Upload a resume first.' } });
    }
    // The router has already decoded this segment, and decoding it a second time was wrong
    // in both directions. A flag containing a percent sign — the extractor writes whatever
    // it read, and "honors.0.top 5%" is a real honour — arrived as `100%off`, threw a
    // URIError out of the handler and came back as a 500 saying the server had broken;
    // since G1 refuses to confirm a profile while any flag is outstanding, that flag could
    // never be cleared and the wizard could not be finished. A flag containing `%2F` was
    // quietly turned into `a/b`, matched nothing, and was left in place just as permanently.
    const target = req.params.path;

    // A flag is dismissible only where there is nowhere to answer it. This endpoint used to
    // drop whichever flag it was handed no matter what the field held, so a field with a
    // control of its own could be marked reviewed while still empty — one call on
    // `dateOfBirth` and G1 confirmed a profile with no date of birth in it. The wizard hides
    // its button for those paths, but a rule that lives only in the client is a suggestion.
    const refusal = dismissalRefusal(p, target);
    if (refusal) {
      return reply.code(409).send({ error: { code: 'ANSWER_REQUIRED', message: refusal } });
    }

    const saved = saveProfile({ ...p, needsReview: p.needsReview.filter((f) => f !== target) });

    // Swept here too, even though clearing a review flag provably changes no fact this
    // profile holds. The write path is what has to be safe, not the one call site somebody
    // remembered: the PUT above was the only fact-changing write on the day this was
    // written, and a guard that covered only it would be one refactor away from a profile
    // edit slipping past again. On an unchanged set of facts the sweep withdraws nothing,
    // because the check is deterministic.
    return { ...saved, withdrawnApprovals: sweepApprovals(saved) };
  });
}
