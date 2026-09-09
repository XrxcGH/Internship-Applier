/**
 * The application status model — docs/11 § M7.
 *
 * ONE RULE SHAPES THIS FILE. The tool may move an application forward only as far as
 * `awaiting_submit`. Everything from `submitted` onward is the user reporting what
 * happened in the world, because the tool never submitted anything and has no way to know.
 * That is gate G4 extended into the tracker rather than a separate policy.
 *
 * `ghosted` is the exception in the other direction: it is DERIVED, never set. An employer
 * does not send a rejection you can record. Silence past a threshold is what it is, and
 * calling it a status the user has to click would be asking them to declare their own
 * rejection.
 */
import type { ApplicationStatus } from '@ia/shared';

/** Who is allowed to move an application into each status. */
export const SET_BY: Record<ApplicationStatus, 'tool' | 'user' | 'derived'> = {
  draft: 'tool',
  answers_ready: 'tool',
  filled: 'tool',
  awaiting_submit: 'tool',
  // Everything below happened outside this app.
  submitted: 'user',
  acknowledged: 'user',
  interview: 'user',
  offer: 'user',
  rejected: 'user',
  withdrawn: 'user',
  ghosted: 'derived',
};

/**
 * Legal next statuses.
 *
 * Deliberately permissive after `submitted`: real hiring processes skip stages, and a
 * state machine that refuses "submitted → interview" because no acknowledgement was
 * recorded would be wrong about the world rather than protecting anything.
 *
 * `ghosted` is a legal next status from nowhere. It is worked out from silence as the tracker
 * is read and never written down, so canTransition refuses it above, before this table is
 * ever consulted — listing it here said the opposite for no gain. Its own row stays a real
 * recovery path in case a stored row ever does hold it, which nothing in this app writes.
 */
const NEXT: Record<ApplicationStatus, ApplicationStatus[]> = {
  draft: ['answers_ready', 'withdrawn'],
  answers_ready: ['filled', 'draft', 'withdrawn'],
  filled: ['awaiting_submit', 'answers_ready', 'withdrawn'],
  awaiting_submit: ['submitted', 'filled', 'withdrawn'],
  submitted: ['acknowledged', 'interview', 'offer', 'rejected', 'withdrawn'],
  acknowledged: ['interview', 'offer', 'rejected', 'withdrawn'],
  interview: ['interview', 'offer', 'rejected', 'withdrawn'],
  offer: ['rejected', 'withdrawn'],
  rejected: [],
  withdrawn: [],
  ghosted: ['acknowledged', 'interview', 'offer', 'rejected', 'withdrawn'],
};

export interface TransitionRefusal {
  ok: false;
  reason: string;
}

export type TransitionResult = { ok: true } | TransitionRefusal;

export function canTransition(
  from: ApplicationStatus,
  to: ApplicationStatus,
  by: 'tool' | 'user',
): TransitionResult {
  if (from === to) return { ok: true };

  if (SET_BY[to] === 'derived') {
    return {
      ok: false,
      reason: 'Ghosted is worked out from how long it has been quiet, not set by hand.',
    };
  }

  if (by === 'tool' && SET_BY[to] === 'user') {
    return {
      ok: false,
      reason:
        `Only you can mark an application ${to}. This tool never submitted it and has no ` +
        'way to know what happened after.',
    };
  }

  if (!NEXT[from].includes(to)) {
    return {
      ok: false,
      reason:
        NEXT[from].length === 0
          ? `An application that is ${from} has finished. Reopening it is not a state change.`
          : `Cannot go from ${from} to ${to}. From here: ${NEXT[from].join(', ')}.`,
    };
  }

  return { ok: true };
}

// ────────────────────────────────────────────────────────────── derived state

/** Silence past this many days reads as ghosted. */
export const GHOST_AFTER_DAYS = 45;

/** A deadline closer than this is worth surfacing. */
export const DEADLINE_SOON_DAYS = 7;

export const DAY_MS = 24 * 60 * 60 * 1000;

export function daysBetween(from: string, to: Date | string): number {
  const end = to instanceof Date ? to.getTime() : new Date(to).getTime();
  return Math.floor((end - new Date(from).getTime()) / DAY_MS);
}

export interface TrackedApplication {
  id: string;
  status: ApplicationStatus;
  company: string;
  title: string;
  applyUrl: string;
  source: string | null;
  createdAt: string;
  updatedAt: string;
  submittedAt: string | null;
  /**
   * When the employer first responded, from the status-change history.
   *
   * Needed because reply time was being measured from submission to NOW, which is not a
   * reply time at all — it climbed by a day every day for applications answered months
   * ago. Null when nothing has come back yet.
   */
  respondedAt: string | null;
  /**
   * When this application first reached an interview or an offer, from the status-change
   * history.
   *
   * The sibling of `respondedAt`, and needed for the same reason. `interview` is a status an
   * application passes THROUGH: it becomes `rejected` or `offer` the moment the outcome is
   * known, and the transition rules allow exactly that. So counting who is sitting in
   * `interview` right now answers "who is mid-process today", not "who ever got that far" —
   * a student who interviewed four times and was turned down four times saw "Reached
   * interview: 0%" and concluded they had never once got past the screen.
   *
   * It is also where the silence clock starts once an application reaches `interview` — see
   * `derive` — which is why an absent value is left as no verdict rather than guessed at.
   *
   * Optional only because a caller that has not read the event history has nothing to put
   * here; when it is absent the present status is all there is to go on, and the undercount
   * is back.
   */
  advancedAt?: string | null;
  deadlineAt: string | null;
  answerCount: number;
  approvedCount: number;
}

export type Attention =
  | 'deadline_soon'
  | 'deadline_passed'
  | 'unfinished'
  | 'ready_to_fill'
  | 'awaiting_your_submit'
  | 'silent'
  | 'none';

export interface Derived {
  /** `ghosted` when silence has run long, otherwise the stored status. */
  effectiveStatus: ApplicationStatus;
  attention: Attention;
  /** One sentence, in the second person, saying what to do. Null when nothing is needed. */
  nudge: string | null;
  daysSinceSubmitted: number | null;
  /**
   * Days since the last thing that happened, which is what the silence nudge counts.
   *
   * Separate from `daysSinceSubmitted` because the two genuinely differ once an employer
   * has acknowledged: the card said "No word for 12 days" next to a `daysSinceSubmitted`
   * of 60, and anything reading the number rather than the sentence disagreed with the
   * sentence. Null when there is nothing to count from.
   */
  daysQuiet: number | null;
  daysUntilDeadline: number | null;
}

/**
 * What this application needs from the user right now.
 *
 * Returns exactly one thing. A tracker that reports four concurrent concerns per row is a
 * tracker nobody reads, so the checks are ordered by urgency and the first one wins.
 */
export function derive(app: TrackedApplication, now = new Date()): Derived {
  const daysSinceSubmitted = app.submittedAt ? daysBetween(app.submittedAt, now) : null;
  const daysUntilDeadline = app.deadlineAt ? -daysBetween(app.deadlineAt, now) : null;

  const openStatuses: ApplicationStatus[] = ['draft', 'answers_ready', 'filled', 'awaiting_submit'];
  const isOpen = openStatuses.includes(app.status);

  /**
   * Silence runs from the last thing that happened, not always from submission.
   *
   * `submitted` used to be the only status that could go quiet, so an application the
   * employer had acknowledged sat in "Waiting" for ever: forty-five days of nothing after an
   * automated "we received this" left the card with no nudge and no way out, and the one
   * status that describes it could not be reached by hand either. An acknowledgement also
   * restarts the clock — someone who wrote back on day ten was not silent for those ten days
   * — so the anchor moves to when that was recorded.
   *
   * That moment is `respondedAt`, read out of the status-change history. It is emphatically
   * not `updatedAt`, which is the row's generic last-modified stamp and gets rewritten by
   * every single status write — including re-setting the status the application already has,
   * which the transition rules allow. Anchored on `updatedAt`, opening the tracker and
   * clicking "Acknowledged" on a card that already said Acknowledged pushed the silence
   * clock back to zero, so an employer who had said nothing for four months looked like they
   * had answered today and the application could never be worked out as ghosted at all.
   *
   * Falls back to the submission date when nothing has come back yet, which is also what a
   * row carried over from before the history was read looks like.
   *
   * `interview` is the third of these and had the same hole `acknowledged` had: an interview
   * that goes quiet never ghosted, never nudged, and went on being counted as an interview
   * in progress, so a student who was screened in March and never heard another word still
   * had that card sitting under "Talking" in September with nothing written on it.
   *
   * Its anchor is `advancedAt` — when the application reached the interview stage — and
   * there is deliberately NO fallback to the submission date for it. Someone who applied in
   * January and interviewed last week is not silent for eight months, and anchoring on
   * `submittedAt` would have dropped a live interview into "Closed" under "No word for 230
   * days. Worth following up, or letting go." A false ghost on a live interview is far worse
   * than no verdict at all, so an interview we cannot date is left alone: `daysQuiet` is
   * null, and `silent` below needs a number.
   *
   * `advancedAt` is the FIRST round, so a loop running past forty-five days reads as quiet
   * even while it is live. That is the same trade the acknowledged clock makes and it is
   * taken for the same reason: a second round and a stray re-click of "Interviewing" write
   * an identical `interview → interview` event, so anchoring on the latest one would hand
   * back the way to postpone the verdict for ever by touching the row. The cost here is a
   * card moved to "Closed" with a follow-up offered beside it, which after that much silence
   * is worth doing anyway, and the stored status is untouched so an offer can still be
   * recorded against it.
   */
  const quietSince =
    app.status === 'acknowledged'
      ? (app.respondedAt ?? app.submittedAt)
      : app.status === 'interview'
        ? (app.advancedAt ?? null)
        : app.submittedAt;
  const daysQuiet = quietSince === null ? null : daysBetween(quietSince, now);

  // The three statuses that are waiting on an employer to say something. `offer` is not one
  // of them — the silence there is the student's to break, and calling an offer ghosted
  // would be telling them an offer they still hold has evaporated.
  const waitingOnThem =
    app.status === 'submitted' || app.status === 'acknowledged' || app.status === 'interview';

  const silent = waitingOnThem && daysQuiet !== null && daysQuiet >= GHOST_AFTER_DAYS;

  const effectiveStatus: ApplicationStatus = silent ? 'ghosted' : app.status;

  // Urgency order. A closing deadline on an unfinished application beats everything,
  // because it is the only concern here with a hard stop.
  if (isOpen && daysUntilDeadline !== null && daysUntilDeadline < 0) {
    return {
      effectiveStatus,
      attention: 'deadline_passed',
      nudge:
        `This closed ${String(Math.abs(daysUntilDeadline))} ` +
        `day${Math.abs(daysUntilDeadline) === 1 ? '' : 's'} ago and was never submitted.`,
      daysSinceSubmitted,
      daysQuiet,
      daysUntilDeadline,
    };
  }

  if (isOpen && daysUntilDeadline !== null && daysUntilDeadline <= DEADLINE_SOON_DAYS) {
    return {
      effectiveStatus,
      attention: 'deadline_soon',
      nudge:
        daysUntilDeadline === 0
          ? 'This closes today.'
          : `This closes in ${String(daysUntilDeadline)} day${daysUntilDeadline === 1 ? '' : 's'}.`,
      daysSinceSubmitted,
      daysQuiet,
      daysUntilDeadline,
    };
  }

  if (app.status === 'awaiting_submit') {
    return {
      effectiveStatus,
      attention: 'awaiting_your_submit',
      nudge: 'The form is filled. Read it and submit it yourself.',
      daysSinceSubmitted,
      daysQuiet,
      daysUntilDeadline,
    };
  }

  if (isOpen && app.answerCount > 0 && app.approvedCount === app.answerCount) {
    return {
      effectiveStatus,
      attention: 'ready_to_fill',
      nudge: 'Every answer is approved. This one is ready to fill.',
      daysSinceSubmitted,
      daysQuiet,
      daysUntilDeadline,
    };
  }

  if (isOpen) {
    const left = app.answerCount - app.approvedCount;
    return {
      effectiveStatus,
      attention: 'unfinished',
      nudge:
        app.answerCount === 0
          ? 'No questions added yet.'
          : // The verb has to agree too, not just the noun.
            `${String(left)} answer${left === 1 ? '' : 's'} still need${left === 1 ? 's' : ''} your approval.`,
      daysSinceSubmitted,
      daysQuiet,
      daysUntilDeadline,
    };
  }

  if (silent) {
    return {
      effectiveStatus,
      attention: 'silent',
      nudge: `No word for ${String(daysQuiet)} days. Worth following up, or letting go.`,
      daysSinceSubmitted,
      daysQuiet,
      daysUntilDeadline,
    };
  }

  return {
    effectiveStatus,
    attention: 'none',
    nudge: null,
    daysSinceSubmitted,
    daysQuiet,
    daysUntilDeadline,
  };
}

/** Board columns, in the order a person thinks about them. */
export const BOARD_COLUMNS: Array<{ key: string; label: string; statuses: ApplicationStatus[] }> = [
  { key: 'preparing', label: 'Preparing', statuses: ['draft', 'answers_ready', 'filled'] },
  { key: 'to_submit', label: 'Ready for you', statuses: ['awaiting_submit'] },
  { key: 'waiting', label: 'Waiting', statuses: ['submitted', 'acknowledged'] },
  { key: 'talking', label: 'Talking', statuses: ['interview'] },
  { key: 'closed', label: 'Closed', statuses: ['offer', 'rejected', 'withdrawn', 'ghosted'] },
];

export function columnFor(status: ApplicationStatus): string {
  return BOARD_COLUMNS.find((c) => c.statuses.includes(status))?.key ?? 'closed';
}
