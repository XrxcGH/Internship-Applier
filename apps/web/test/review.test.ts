import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  flagLabel,
  ANSWERED_IN_WIZARD,
  isAnswered,
  isDismissible,
  OPTIONAL_WIZARD_FIELDS,
} from '../src/lib/review';
import type { AnswerEvidence, AnswerFlag } from '../src/lib/api';
import {
  AnswerReview,
  evidenceNote,
  wasChecked,
  type ReviewedAnswer,
} from '../src/components/AnswerReview';

/**
 * G1 clears a review flag only when the field it names actually holds something. These
 * cases are the four shapes "unanswered" arrives in from the onboarding controls.
 */
describe('isAnswered', () => {
  it('treats a cleared date picker as unanswered', () => {
    // The date inputs store null (date of birth) or undefined (the availability window)
    // when emptied, so a check that only looked at strings let a user type a date, delete
    // it, and confirm a profile that had no date in it at all.
    expect(isAnswered(null)).toBe(false);
    expect(isAnswered(undefined)).toBe(false);
  });

  it('treats an empty or whitespace-only text field as unanswered', () => {
    expect(isAnswered('')).toBe(false);
    expect(isAnswered('   ')).toBe(false);
  });

  it("treats the work-authorization select's own placeholder as unanswered", () => {
    expect(isAnswered('unknown')).toBe(false);
  });

  it('accepts a real value', () => {
    expect(isAnswered('2027-06-01')).toBe(true);
    expect(isAnswered('Boston')).toBe(true);
    expect(isAnswered('citizen')).toBe(true);
  });
});

/**
 * The other half of the same gate. "I have checked this" posts to an endpoint that drops
 * the flag whatever the field holds, so it must never appear beside a field the wizard can
 * answer — otherwise one click marks a fact as reviewed while it is still blank, and G1
 * confirms a profile with a hole in it.
 */
describe('isDismissible', () => {
  it('refuses to wave off any of the six facts G1 exists to collect', () => {
    // These are exactly the six controls on the wizard's facts step. If a control is added
    // or its path changes, this list and ANSWERED_IN_WIZARD change together.
    for (const path of [
      'dateOfBirth',
      'workAuthorization.status',
      'availability.start',
      'availability.end',
      'locationPrefs.base.city',
      'locationPrefs.base.region',
    ]) {
      expect(isDismissible(path)).toBe(false);
      expect(ANSWERED_IN_WIZARD[path]).toBeTruthy();
    }
  });

  it('refuses to wave off the identity fields the schema insists on', () => {
    // `fullName: z.string()` and `email: EmailAddress` — neither is optional, so a blank is
    // not an answer and the flag has to stay until there is one.
    expect(isDismissible('fullName')).toBe(false);
    expect(isDismissible('email')).toBe(false);
  });

  it('DOES wave off phone, whose blank the schema accepts as an answer', () => {
    // This asserted `false` and was pinning a bug. `phone: z.string().optional()`, so
    // declining to give a number is a complete answer — but the flag raised on clearing the
    // box was non-dismissible, and the server will not confirm a profile while a flag stands.
    // The only way out of G1 was to type a number the user had chosen not to give.
    expect(isDismissible('phone')).toBe(true);
  });

  it('decides on presence in the map, not on whether the hint reads as truthy', () => {
    // The wizard used to make this same call inline, as `ANSWERED_IN_WIZARD[path] ? …`.
    // Every path with an entry has a control on the wizard and must come back
    // non-dismissible whatever its hint says — including a hint written as an empty
    // string, which is falsy but still means there is somewhere to answer the flag.
    for (const path of Object.keys(ANSWERED_IN_WIZARD)) {
      expect(isDismissible(path)).toBe(false);
    }
  });

  it('still lets a flag with no control anywhere be cleared, so G1 cannot lock shut', () => {
    // The extractor flags these and the wizard has no input for either, so without the
    // button there is no way past the gate at all.
    expect(isDismissible('experience.0.startDate')).toBe(true);
    expect(isDismissible('education.2.endDate')).toBe(true);
  });

  it('leaves an optional wizard control dismissible, since its blank is a real answer', () => {
    // Pronouns has a control on the confirm step, but a person with none to give answers by
    // leaving it blank. Forcing it into ANSWERED_IN_WIZARD would drop the button and trap
    // them behind a flag they could never make non-empty, so it stays dismissible — and the
    // two lists must never both claim it.
    for (const path of OPTIONAL_WIZARD_FIELDS) {
      expect(isDismissible(path)).toBe(true);
      expect(ANSWERED_IN_WIZARD[path]).toBeUndefined();
    }
    expect(OPTIONAL_WIZARD_FIELDS.has('pronouns')).toBe(true);
  });
});

/**
 * The sign-off list is the last thing between a student and a confirmed profile, and it was
 * printing schema paths at them: `education.0.gpa`, `experience.2.startDate`. Nine paths had
 * a hint beside them; every flag nested in education or experience had an identifier and a
 * button, and nothing said which box on which row.
 */
describe('flagLabel', () => {
  it('names the field and the row, counting from one', () => {
    // The paths are zero-based and the list on screen is not, so an index printed raw makes
    // the student do the compiler's counting.
    expect(flagLabel('education.0.gpa')).toBe('GPA on your 1st school');
    expect(flagLabel('experience.2.startDate')).toBe('start date on your 3rd job');
    expect(flagLabel('projects.1.description')).toBe('description on your 2nd project');
  });

  it('gets the awkward ordinals right', () => {
    expect(flagLabel('education.10.gpa')).toBe('GPA on your 11th school');
    expect(flagLabel('education.20.gpa')).toBe('GPA on your 21st school');
    expect(flagLabel('education.11.gpa')).toBe('GPA on your 12th school');
  });

  it('reads an un-indexed section path', () => {
    expect(flagLabel('experience.bullets')).toBe('the bullet points in your jobs');
  });

  it('splits a camelCase field it has no name for, rather than printing it raw', () => {
    expect(flagLabel('education.0.someOtherThing')).toBe('some other thing on your 1st school');
  });

  it('hands back anything it cannot read, unchanged', () => {
    // A wrong label is worse than a raw one: it sends the user to the wrong box confidently.
    expect(flagLabel('workAuthorization.status')).toBe('workAuthorization.status');
    expect(flagLabel('locationPrefs.base.city')).toBe('locationPrefs.base.city');
    expect(flagLabel('somethingUnexpected')).toBe('somethingUnexpected');
  });
});

/**
 * Gate G3's evidence column, and the one sentence that stood for four different facts.
 *
 * "Nothing to check yet. Claims appear here as soon as there is text." was printed whenever
 * `evidence` came back empty. That is true of an answer nobody has written, reassuring and
 * FALSE about an answer saved without a confirmed profile and so never read against one, and
 * self-contradicting about a checked answer that needed no backing — there is text, and the
 * sentence says there is not. Opposite meanings behind one line, on the screen whose job is
 * telling someone what has been checked before they stand behind it.
 */
function answer(over: Partial<ReviewedAnswer> = {}): ReviewedAnswer {
  return {
    id: 'ans1',
    applicationId: 'app1',
    questionText: 'Why do you want to work here?',
    fieldKey: 'q_why',
    answerType: 'long_text',
    draftText: 'I wrote a parser for our robotics team.',
    finalText: 'I wrote a parser for our robotics team.',
    text: 'I wrote a parser for our robotics team.',
    editDistance: 0,
    editSummary: 'Unedited so far.',
    evidence: [],
    flags: [],
    approvedAt: null,
    archetype: 'motivation',
    ...over,
  };
}

const claim: AnswerEvidence = {
  claim: 'I wrote a parser',
  verdict: 'supported',
  profileRef: 'projects.0',
  quote: 'Wrote the telemetry parser.',
};

const tell: AnswerFlag = {
  type: 'ai_tell',
  span: { start: 0, end: 4 },
  note: 'Reads as machine-written.',
};

describe('wasChecked', () => {
  it('declines to answer when nothing in the payload says either way', () => {
    // The important case. An unchecked answer and a checked one with nothing to flag both
    // arrive holding `evidence: []`, so a guess here is a false GREEN half the time.
    expect(wasChecked(answer())).toBeNull();
  });

  it('believes the server when the save response says so, in both directions', () => {
    // PATCH /api/answers/:id answers with `verified: false` when the edit was stored without
    // a confirmed profile, which stores `evidence: []` and `flags: []` — exactly the shape
    // that used to render as "nothing to check".
    expect(wasChecked(answer({ verified: false }))).toBe(false);
    expect(wasChecked(answer({ verified: true }))).toBe(true);
  });

  it('takes a listed claim or any flag as proof the guard ran', () => {
    expect(wasChecked(answer({ evidence: [claim] }))).toBe(true);
    expect(wasChecked(answer({ flags: [tell] }))).toBe(true);
  });

  it('takes `unresolved` as proof by its presence, not by its value', () => {
    // The draft response always sends it, and `false` there means "checked, nothing left
    // unresolved" — reading it as falsy would throw away proof on every clean draft.
    expect(wasChecked(answer({ unresolved: false }))).toBe(true);
    expect(wasChecked(answer({ unresolved: true }))).toBe(true);
  });

  it('takes a style note as proof, and a missing one as nothing either way', () => {
    expect(wasChecked(answer({ styleNote: 'Longer sentences than you usually write.' }))).toBe(
      true,
    );
    expect(wasChecked(answer({ styleNote: null }))).toBeNull();
  });

  it('lets the server overrule the inferences, since it is talking about this text', () => {
    expect(wasChecked(answer({ verified: false, evidence: [claim] }))).toBe(false);
  });
});

describe('evidenceNote', () => {
  it('keeps the original sentence for the case it was always true of', () => {
    const note = evidenceNote(answer({ text: '   ', evidence: [] }));
    expect(note.state).toBe('no-text');
    expect(note.text).toMatch(/as soon as there is text/);
  });

  it('says a checked answer was checked, instead of that there is nothing to check', () => {
    const note = evidenceNote(answer({ verified: true }));
    expect(note.state).toBe('checked');
    expect(note.text).toMatch(/Read against your profile/);
    expect(note.text).not.toMatch(/Nothing to check yet/);
  });

  it('says an unchecked answer was NOT checked — the false green this existed to hide', () => {
    const note = evidenceNote(answer({ verified: false }));
    expect(note.state).toBe('unchecked');
    expect(note.text).toMatch(/Not read against your profile/);
    expect(note.text).not.toMatch(/Nothing to check yet/);
  });

  it('claims neither when the payload cannot say, and offers the move that settles it', () => {
    // Reloading the application re-reads a payload with no `verified` in it at all, so this
    // is a state the screen really reaches. Asserting either way here would be the same bug
    // with a different sentence.
    const note = evidenceNote(answer());
    expect(note.state).toBe('unknown');
    expect(note.text).toMatch(/nothing here says which/);
    expect(note.text).toMatch(/Saving it again/);
  });

  it('never says "nothing to check" over an answer that has text', () => {
    for (const a of [
      answer(),
      answer({ verified: true }),
      answer({ verified: false }),
      answer({ unresolved: false }),
    ]) {
      expect(evidenceNote(a).text, evidenceNote(a).state).not.toMatch(/Nothing to check yet/);
    }
  });
});

describe('the evidence column as it renders', () => {
  const render = (a: ReviewedAnswer): string =>
    renderToStaticMarkup(
      createElement(AnswerReview, {
        answer: a,
        canDraft: true,
        busy: null,
        onDraft: () => undefined,
        onSave: () => undefined,
        onApprove: () => undefined,
        onUnapprove: () => undefined,
        onDelete: () => undefined,
      }),
    );

  it('prints the note the state earns, not the one sentence for all of them', () => {
    expect(render(answer({ verified: true }))).toContain('Read against your profile');
    expect(render(answer({ verified: false }))).toContain('Not read against your profile');
    expect(render(answer())).toContain('No claims are listed against this text');
  });

  /**
   * The fourth state never reaches the evidence column, and that is the right answer rather
   * than a gap: an answer with no text at all renders the "No answer yet" placeholder and
   * the two buttons that make one, so a note about claims would be talking about something
   * that does not exist. `evidenceNote` still returns it — the function is also read by
   * callers that are not this component — and the state is asserted on the function above.
   */
  it('offers to write the answer rather than reporting on the claims of an empty one', () => {
    const empty = render(answer({ text: '', draftText: '', finalText: '' }));
    expect(empty).toContain('No answer yet');
    expect(empty).not.toContain('Nothing to check yet');
  });

  it('colours the definite negative and leaves plain absence plain', () => {
    // An answer that has not been read against the profile is a warning. An answer whose
    // payload cannot say is an absence of information, and dressing that as bad news at a
    // gate with no override teaches people to ignore the colour.
    expect(render(answer({ verified: false }))).toContain('text-caution');
    expect(render(answer())).not.toContain('text-caution');
  });

  it('lists the claims when there are claims, and drops the note entirely', () => {
    const html = render(answer({ evidence: [claim] }));
    expect(html).toContain('Wrote the telemetry parser.');
    expect(html).not.toContain('Nothing to check yet');
    expect(html).not.toContain('nothing here says which');
  });
});

/**
 * The flag that says whether THIS text has been read against the profile.
 *
 * `verified` is sent by the two routes that re-check an answer — PATCH /api/answers/:id and
 * the draft endpoint — and deliberately not by the list payload, which reports stored rows
 * and cannot know whether the check has run on the text now on screen.
 *
 * The client had no field for it, so an edit that came back `verified: false` was dropped on
 * the way through and `wasChecked` fell back to its "cannot tell" branch. G3 then printed "No
 * claims are listed against this text" — the wording that means "checked, and nothing needed
 * backing" — about text nothing had looked at, on the screen whose only job is telling the
 * student what has been checked before they stand behind it.
 */
describe('the verified flag on an edited answer', () => {
  it('reports an unchecked edit as unchecked, not as "nothing to check"', () => {
    // An edit clears the stored evidence and flags, so nothing else in the payload can tell
    // the two states apart — this flag is the whole signal.
    expect(wasChecked({ evidence: [], flags: [], verified: false })).toBe(false);
    expect(
      evidenceNote({ text: 'I rewrote this myself.', evidence: [], flags: [], verified: false })
        .state,
    ).toBe('unchecked');
  });

  it('reports a checked answer that needed no backing as checked', () => {
    expect(wasChecked({ evidence: [], flags: [], verified: true })).toBe(true);
    expect(
      evidenceNote({ text: 'Some text.', evidence: [], flags: [], verified: true }).state,
    ).toBe('checked');
  });

  it('still says it cannot tell when the flag is absent', () => {
    // The list payload does not send it, and inventing an answer for that case is what the
    // three-state wording exists to avoid.
    expect(wasChecked({ evidence: [], flags: [] })).toBeNull();
    expect(evidenceNote({ text: 'Some text.', evidence: [], flags: [] }).state).toBe('unknown');
  });
});
