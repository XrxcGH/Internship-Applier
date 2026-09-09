import { ApiError } from './api';

/**
 * Statuses a person can report on the board, and how a refused report is explained.
 *
 * Both live here rather than in the page because the second is worked out from the first
 * and the two have to move together: a status added to the menu that the explanation
 * below does not know about would be offered and then refused in words that never mention
 * it.
 */

/** Statuses a person can select. `ghosted` is absent because it is derived, not chosen. */
export const REPORTABLE: Array<{ value: string; label: string }> = [
  { value: 'submitted', label: 'I submitted it' },
  { value: 'acknowledged', label: 'They acknowledged it' },
  { value: 'interview', label: 'Interviewing' },
  { value: 'offer', label: 'Offer' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'withdrawn', label: 'Withdrawn' },
];

/**
 * The statuses this tool moves an application through by itself, before it has been sent.
 *
 * None of them is on the menu above, so none can be reported; they are here because an
 * application that can still reach one of them is an application that has not been
 * submitted yet, which is the one thing the refusal below can say more about.
 */
const BEFORE_SENDING = ['draft', 'answers_ready', 'filled', 'awaiting_submit'];

/**
 * The server's list of what IS allowed, pulled out of its refusal message.
 *
 * The refusal reads "Cannot go from draft to submitted. From here: answers_ready,
 * withdrawn." — internal names, in a sentence written for a log rather than for a person.
 * The names are the only part worth keeping. Returns null when the message is not of that
 * shape, which is how the caller knows it has nothing better to say than what the server
 * said.
 */
export function allowedFrom(message: string): string[] | null {
  const listed = /From here: ([^.]+)\./.exec(message)?.[1];
  if (listed === undefined) return null;
  return listed.split(',').map((s) => s.trim());
}

/**
 * A refused status change, said in words this screen has used before.
 *
 * Two jobs, and the second is the one that has bitten. The first is translation: the
 * server answers in its own vocabulary and nobody using this board has ever seen
 * `answers_ready`. The second is not inventing a reason. This used to answer every refusal
 * with a single sentence — that only an application which has been through the fill step
 * can be reported as sent, and until then the one status available is Withdrawn — and the
 * menu offers all six statuses on every row, so that sentence went out for refusals it was
 * simply wrong about. Someone at Offer who picked "Interviewing" was told their
 * application had not been through the fill step when it had been all the way through and
 * back. Someone at Rejected, where nothing at all can be recorded and Withdrawn least of
 * all, was told to record Withdrawn.
 *
 * So the alternatives come from the server's own list, filtered to the ones that are
 * actually on the menu; the fill-step sentence is kept for the case it was true of and
 * only that case; and a refusal this cannot parse — the finished-application one, the
 * derived-status one, anything added later — is passed through in the server's words
 * rather than paraphrased into a guess.
 */
export function refusal(err: unknown, status: string): string {
  if (!(err instanceof ApiError) || err.code !== 'ILLEGAL_TRANSITION') {
    return err instanceof Error ? err.message : String(err);
  }

  const label = REPORTABLE.find((r) => r.value === status)?.label ?? status;
  const opening = `This one cannot be moved to "${label}" from where it stands. `;

  const allowed = allowedFrom(err.message);
  if (allowed === null) return opening + err.message;

  // Only where it is true: the application is still somewhere in the fill steps AND what
  // the user tried to record is that they sent it. Anywhere past that, saying this would
  // be telling someone their application has not been submitted when it plainly has.
  const notSentYet = status === 'submitted' && allowed.some((n) => BEFORE_SENDING.includes(n));
  /**
   * This sentence used to end "even when you sent it on the employer's own site", and that
   * was true of the interface and false of the server.
   *
   * `canTransition` lets a USER walk answers_ready to filled to awaiting_submit to submitted
   * — it refuses only the one-move jump from draft, which is the stray-POST guard, and the
   * same moves made by the tool. So a student whose fill was refused (an aggregator redirect,
   * a login wall, a run that filled nothing) and who then applied on the employer's site by
   * hand could always have recorded it; nothing offered them the way. `recordSubmittedByHand`
   * below is that way, and this sentence now points at it instead of denying it.
   */
  const why = notSentYet
    ? 'A submission is recorded through the fill steps, so this one has to walk through them ' +
      'first — “I submitted it” does that for you if you sent it on the employer’s own site. '
    : '';

  const alternatives = REPORTABLE.filter((r) => allowed.includes(r.value)).map((r) => r.label);

  // Singular and plural both, and the empty case as well: every open status can be
  // withdrawn today, so nothing reaches the last branch — but a status table that stopped
  // allowing that would leave the sentence reading "what you can report for it now: .".
  if (alternatives.length === 0) {
    return (
      opening +
      why +
      'There is nothing on this menu to report for it yet — it moves on as you work through ' +
      'the application.'
    );
  }
  if (alternatives.length === 1) {
    return `${opening}${why}The one status you can report for it now is "${String(alternatives[0])}".`;
  }
  return `${opening}${why}What you can report for it now: ${alternatives.map((a) => `"${a}"`).join(', ')}.`;
}

/**
 * Recording an application the student sent themselves, from wherever it stands.
 *
 * G4 is the whole point of this product — the student presses Submit on the real page — and
 * the case it happens in most is the one where this tool could NOT fill the form: an
 * aggregator redirect it refuses to open, a login wall, a bot check, a run that filled
 * nothing. All of those leave the application short of `awaiting_submit`, and the status menu
 * offered one hop, so "I submitted it" was refused and the only pickable status was
 * "Withdrawn" — for an application the student had actually sent.
 *
 * The server has always allowed this: `canTransition` permits a USER to walk answers_ready →
 * filled → awaiting_submit → submitted, and refuses only the single jump from `draft` (the
 * stray-POST guard) and the same moves attempted by the tool. So this walks the hops in order
 * rather than asking for a new endpoint, and NOTHING is weakened — every hop is the same call
 * the menu already makes, and routes/tracker.ts still applies the G3 answers-approved check
 * on the way through.
 *
 * The first refusal stops the walk and is thrown as-is, so a student who genuinely cannot
 * take a hop — answers not approved at G3 — gets that reason rather than a generic failure
 * from three calls later.
 */
const TO_SUBMITTED = ['answers_ready', 'filled', 'awaiting_submit', 'submitted'] as const;

export async function recordSubmittedByHand(
  id: string,
  from: string,
  post: (id: string, status: string) => Promise<unknown>,
): Promise<void> {
  const at = TO_SUBMITTED.indexOf(from as (typeof TO_SUBMITTED)[number]);
  // A status already past the walk, or one the walk does not pass through, is not this
  // function's business — the caller's ordinary single hop is.
  const hops = at === -1 ? TO_SUBMITTED : TO_SUBMITTED.slice(at + 1);
  for (const hop of hops) await post(id, hop);
}
