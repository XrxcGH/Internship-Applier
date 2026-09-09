import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/lib/api';
import { allowedFrom, recordSubmittedByHand, refusal, REPORTABLE } from '../src/lib/tracker';

/** What the tracker route sends when the status machine says no. */
function refused(reason: string): ApiError {
  return new ApiError(reason, 409, 'ILLEGAL_TRANSITION');
}

/**
 * The board offers all six reportable statuses on every row, so a refusal can arrive from
 * any state for any target. The sentence shown has to be true of the row it appears on —
 * it used to be a single fixed sentence about the fill step, which was true of one case
 * out of the thirty-six the menu can produce.
 */
describe('refusal', () => {
  it('names what can actually be reported instead, from the server’s own list', () => {
    const msg = refusal(
      refused('Cannot go from offer to interview. From here: rejected, withdrawn.'),
      'interview',
    );
    expect(msg).toContain('"Rejected"');
    expect(msg).toContain('"Withdrawn"');
    // The old sentence went out here too, telling someone whose application had reached an
    // offer that it had never been through the fill step.
    expect(msg).not.toContain('fill step');
  });

  it('keeps the fill-step explanation for the one case it is true of', () => {
    const msg = refusal(
      refused('Cannot go from draft to submitted. From here: answers_ready, withdrawn.'),
      'submitted',
    );
    expect(msg).toContain('fill step');
    expect(msg).toContain('"Withdrawn"');
  });

  it('does not offer statuses that are not on the menu', () => {
    // `answers_ready` and `filled` are steps this tool walks by itself. Listing them as
    // things to report sends the user looking for a control that does not exist.
    const msg = refusal(
      refused(
        'Cannot go from filled to rejected. From here: awaiting_submit, answers_ready, withdrawn.',
      ),
      'rejected',
    );
    expect(msg).not.toContain('answers_ready');
    expect(msg).not.toContain('awaiting_submit');
    expect(msg).toContain('The one status you can report for it now is "Withdrawn".');
  });

  it('passes a refusal it cannot parse through in the server’s words', () => {
    // A finished application has no list of alternatives at all, and Withdrawn is not one
    // of them either — which is exactly what the old fixed sentence promised.
    const reason =
      'An application that is rejected has finished. Reopening it is not a state change.';
    const msg = refusal(refused(reason), 'withdrawn');
    expect(msg).toContain(reason);
    expect(msg).not.toContain('The one status you can report');
  });

  it('leaves errors that are not refusals alone', () => {
    expect(refusal(new Error('Failed to fetch'), 'offer')).toBe('Failed to fetch');
    expect(refusal(new ApiError('Server error.', 500, 'INTERNAL'), 'offer')).toBe('Server error.');
  });
});

describe('allowedFrom', () => {
  it('reads the list the server appends, and only that shape', () => {
    expect(
      allowedFrom('Cannot go from draft to submitted. From here: answers_ready, withdrawn.'),
    ).toEqual(['answers_ready', 'withdrawn']);
    expect(allowedFrom('An application that is withdrawn has finished.')).toBeNull();
  });

  it('every status on the menu is one the parser can recognise', () => {
    // The two halves of this module have to move together: a status added to the menu
    // that never matches a name in the server's list would be offered on every row and
    // then left out of every explanation of what can be reported instead.
    const listed = REPORTABLE.map((r) => r.value).join(', ');
    expect(allowedFrom(`Cannot go from x to y. From here: ${listed}.`)).toEqual(
      REPORTABLE.map((r) => r.value),
    );
  });
});

/**
 * Recording an application the student sent themselves — which is what G4 is.
 *
 * The case it happens in most is the one where this tool could NOT fill the form: an
 * aggregator redirect it refuses to open, a login wall, a bot check, a run that filled
 * nothing. All of those leave the application short of `awaiting_submit`, the status menu
 * asked for a single hop, and the server refused it — so the only status a student could pick
 * for an application they had actually sent was "Withdrawn".
 *
 * The server always allowed the walk: `canTransition` lets a USER go answers_ready → filled →
 * awaiting_submit → submitted, refusing only the one-move jump from `draft` (the stray-POST
 * guard) and the same moves made by the tool. Nothing here weakens that — each hop is the same
 * call the menu already made, and routes/tracker.ts still applies the G3 answers-approved
 * check on the way through.
 */
describe('recording a submission made by hand', () => {
  it('walks the fill steps in order from wherever the application stands', async () => {
    const posted: string[] = [];
    await recordSubmittedByHand('app-1', 'answers_ready', (_id, status) => {
      posted.push(status);
      return Promise.resolve();
    });
    expect(posted).toEqual(['filled', 'awaiting_submit', 'submitted']);
  });

  it('starts from the beginning of the walk for a status outside it', async () => {
    // `draft` is not on the path — the server refuses draft → submitted outright as the
    // stray-POST guard — so the walk offers the first legal hop and lets the server judge it.
    const posted: string[] = [];
    await recordSubmittedByHand('app-1', 'draft', (_id, status) => {
      posted.push(status);
      return Promise.resolve();
    });
    expect(posted[0]).toBe('answers_ready');
    expect(posted.at(-1)).toBe('submitted');
  });

  it('asks for nothing when the application is already there', async () => {
    const posted: string[] = [];
    await recordSubmittedByHand('app-1', 'submitted', (_id, status) => {
      posted.push(status);
      return Promise.resolve();
    });
    expect(posted).toEqual([]);
  });

  it('stops at the first refusal, so the student sees the reason for it', async () => {
    // A hop the student genuinely cannot take — answers not approved at G3 — has to surface
    // as itself, not as a generic failure from three calls later.
    const posted: string[] = [];
    await expect(
      recordSubmittedByHand('app-1', 'answers_ready', (_id, status) => {
        posted.push(status);
        return status === 'filled'
          ? Promise.reject(new Error('Every answer needs your approval at gate G3.'))
          : Promise.resolve();
      }),
    ).rejects.toThrow(/gate G3/);
    expect(posted).toEqual(['filled']);
  });
});
