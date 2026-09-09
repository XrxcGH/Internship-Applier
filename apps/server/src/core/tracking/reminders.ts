/**
 * Reminders and follow-up drafts — docs/11 § M7.
 *
 * NOTHING HERE SENDS ANYTHING. A follow-up is drafted, shown, and left in the user's hands
 * exactly the way an application answer is. This is the same line as gate G4: an email
 * going out under someone's name is theirs to send.
 *
 * It also means no mail credentials, no SMTP configuration, and no outbox — the drafts are
 * text the user copies. That is a deliberate feature rather than an unfinished piece.
 */
import type { TrackedApplication } from './status';
import { derive, GHOST_AFTER_DAYS } from './status';

export type ReminderKind = 'deadline' | 'follow_up' | 'still_open';

export interface Reminder {
  applicationId: string;
  kind: ReminderKind;
  /** Lower sorts first. */
  urgency: number;
  headline: string;
  detail: string;
}

/** Days after submitting before a follow-up is reasonable rather than pushy. */
export const FOLLOW_UP_AFTER_DAYS = 14;

export function buildReminders(apps: TrackedApplication[], now = new Date()): Reminder[] {
  const out: Reminder[] = [];

  for (const app of apps) {
    const d = derive(app, now);

    if (d.attention === 'deadline_passed') {
      out.push({
        applicationId: app.id,
        kind: 'deadline',
        urgency: 0,
        headline: `${app.company} closed without being submitted`,
        detail:
          d.nudge ??
          'The posting closed while this was still in progress. Worth withdrawing it to clear the board.',
      });
      continue;
    }

    if (d.attention === 'deadline_soon') {
      out.push({
        applicationId: app.id,
        kind: 'deadline',
        urgency: 1,
        headline: `${app.company} closes soon`,
        detail: `${d.nudge ?? ''} ${app.title}`.trim(),
      });
      continue;
    }

    if (d.attention === 'awaiting_your_submit') {
      out.push({
        applicationId: app.id,
        kind: 'still_open',
        urgency: 2,
        headline: `${app.company} is filled and waiting for you`,
        detail: 'The form is ready. Read it on the real page and submit it yourself.',
      });
      continue;
    }

    /**
     * A follow-up becomes reasonable at two weeks of silence and stops being useful once
     * silence has run long enough to mean no.
     *
     * Counted from `daysQuiet`, not `daysSinceSubmitted`, and offered for all three statuses
     * that are waiting on an employer rather than for `submitted` alone. Only `submitted`
     * used to qualify, so the two states where a follow-up is most obviously worth sending
     * — they acknowledged it and then went quiet, they interviewed you and then went quiet —
     * were the two that never produced a nudge. An interview that went silent got nothing at
     * all: no reminder, no ghosting, and a card still sitting under "Talking".
     *
     * For `submitted` the two counts are the same number, so nothing about that case moves.
     */
    if (
      (app.status === 'submitted' || app.status === 'acknowledged' || app.status === 'interview') &&
      d.daysQuiet !== null &&
      d.daysQuiet >= FOLLOW_UP_AFTER_DAYS &&
      d.daysQuiet < GHOST_AFTER_DAYS
    ) {
      const days = String(d.daysQuiet);
      out.push({
        applicationId: app.id,
        kind: 'follow_up',
        urgency: 3,
        // Each headline names the thing the clock is actually counting from. "days since you
        // applied" over a count that starts at the interview would be a number attached to
        // the wrong event, which is the kind of small lie this tracker keeps finding.
        headline:
          app.status === 'submitted'
            ? `${days} days since you applied to ${app.company}`
            : app.status === 'acknowledged'
              ? `${days} days since ${app.company} acknowledged your application`
              : `${days} days since you reached the interview stage with ${app.company}`,
        detail:
          app.status === 'interview'
            ? 'Long enough to ask where the decision stands. A draft is below.'
            : 'Long enough that a short follow-up is reasonable. A draft is below.',
      });
    }
  }

  return out.sort((a, b) => a.urgency - b.urgency);
}

/**
 * A follow-up email, as text for the user to send themselves.
 *
 * Written short and plain on purpose. A long follow-up reads as anxious, and every
 * flourish is another thing the recipient did not ask for. No em dashes, no "I wanted to
 * reach out", no "circling back" — the same vocabulary the tell-scrub blocks in answers.
 */
export function draftFollowUp(app: TrackedApplication, now = new Date()): string {
  const d = derive(app, now);

  /**
   * An application that has reached an interview gets a different note, and a dateless one.
   *
   * "I applied for the X role two weeks ago and wanted to check whether the position is
   * still open" is the wrong question to put to someone who has already interviewed you, and
   * it reads as though the interview never happened.
   *
   * There is no timing phrase in it because there is no date here worth standing behind.
   * All the tracker knows is when the user recorded reaching the interview stage, which is
   * not when the interview was and may not even be when the invitation arrived. "I
   * interviewed with you three weeks ago" built out of that stamp is a fabricated sentence
   * in outgoing mail, and this app does not let those through anywhere else either.
   */
  if (app.status === 'interview') {
    return [
      `Subject: Following up on my ${app.title} application`,
      '',
      'Hello,',
      '',
      `I am in the interview process for the ${app.title} role and wanted to ask whether there is any update on where things stand.`,
      '',
      'I am still very interested, and happy to send anything else that would be useful.',
      '',
      'Thank you for your time.',
    ].join('\n');
  }

  const days = d.daysSinceSubmitted;

  /**
   * The timing phrase comes from the actual number of days.
   *
   * It used to be "two weeks ago" for anything under 21 days, so a follow-up drafted the
   * day after applying opened with a claim that was simply untrue. In a tool that checks
   * every drafted sentence against the profile before letting it near an employer, a
   * hardcoded false statement in outgoing correspondence is the wrong kind of exception.
   */
  const when =
    days === null
      ? 'recently'
      : days <= 1
        ? 'yesterday'
        : days < 7
          ? `${String(days)} days ago`
          : days < 14
            ? 'last week'
            : days < 21
              ? 'two weeks ago'
              : days < 45
                ? 'a few weeks ago'
                : 'some time ago';

  return [
    `Subject: Following up on my ${app.title} application`,
    '',
    'Hello,',
    '',
    `I applied for the ${app.title} role ${when} and wanted to check whether the position is still open.`,
    '',
    'I am still very interested, and happy to send anything else that would be useful.',
    '',
    'Thank you for your time.',
  ].join('\n');
}

/** A short note for a withdrawal, when the user has taken something else. */
export function draftWithdrawal(app: TrackedApplication): string {
  return [
    `Subject: Withdrawing my ${app.title} application`,
    '',
    'Hello,',
    '',
    `I am writing to withdraw my application for the ${app.title} role. I have accepted another offer.`,
    '',
    'Thank you for considering me.',
  ].join('\n');
}
