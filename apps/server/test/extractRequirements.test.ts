/**
 * The false-`ineligible` cluster in the DETERMINISTIC pass — docs/05 § Stage 0.
 *
 * `useModel: false` is not an edge case: `extractRequirements` gates the model pass on
 * `hasApiKey()`, so a user signed in through the Claude Code CLI gets these regexes and
 * nothing else. Every bug below therefore hits the common case, and each one ends in the
 * verdict docs/11 calls the worst this app can produce — an `ineligible` the user cannot
 * override at G3, printed beside a quote that says the opposite.
 *
 * Two defects, both of them the project's signature shape of a guard that exists and is
 * wired to one caller:
 *
 *   1. `statedAsPreferred` had been written, documented and tested — and called from two of
 *      the twelve places that decide a necessity. "U.S. citizenship preferred." and
 *      "Preferably currently enrolled in a degree program." came back `required`, and the
 *      rules in eligibility.ts have branches for the softer reading that no keyless user
 *      could ever reach.
 *   2. Nothing asked WHO a sentence was about. "You will be mentored by engineers with 10+
 *      years of experience" produced a ten-year minimum on an internship, and "You will work
 *      alongside PhD researchers" a doctorate requirement on a summer job.
 *
 * Every case here is paired with its opposite, because the cheap way to pass any one of them
 * is to stop failing anybody — and a queue with no filtering in it is its own bug.
 */
import { describe, expect, it } from 'vitest';
import {
  deterministicRequirements,
  extractRequirements,
} from '../src/core/matching/extractRequirements';
import { verifyQuote } from '../src/core/matching/quoteGuard';

const found = (text: string) => deterministicRequirements(text);
const kinds = (text: string) => found(text).map((r) => r.kind);
const necessityOf = (kind: string, text: string) =>
  found(text).find((r) => r.kind === kind)?.necessity;
const valueOf = (kind: string, text: string) => found(text).find((r) => r.kind === kind)?.value;

// ───────────────────────────────── the four reported postings, end to end

describe('the reported postings, through extractRequirements with no API key', () => {
  const extract = (description: string) =>
    extractRequirements('j1', description, { useModel: false });

  it('reads "U.S. citizenship preferred." as a preference and "Must be a U.S. citizen." as a rule', async () => {
    const soft = await extract('U.S. citizenship preferred.');
    expect(soft.requirements.map((r) => [r.kind, r.necessity])).toEqual([
      ['citizenship', 'preferred'],
    ]);

    const hard = await extract('Must be a U.S. citizen.');
    expect(hard.requirements.map((r) => [r.kind, r.necessity])).toEqual([
      ['citizenship', 'required'],
    ]);
  });

  it('reads "Preferably currently enrolled in a degree program." as a preference', async () => {
    const { requirements } = await extract('Preferably currently enrolled in a degree program.');
    expect(requirements.map((r) => [r.kind, r.necessity])).toEqual([['enrollment', 'preferred']]);
  });

  /**
   * The posting says "no prior experience necessary" one line above, and the ten years
   * belong to the people doing the mentoring. Two independent reasons not to record it, and
   * the assertion is that nothing is recorded at all rather than that it is recorded softly:
   * a requirement that exists can be failed on later, by a rule nobody has written yet.
   */
  it('records no experience minimum from the mentors of a no-experience-needed posting', async () => {
    const { requirements } = await extract(
      'No prior experience necessary; we teach everything on the job.\n' +
        'You will be mentored by engineers with 10+ years of experience.',
    );
    expect(requirements.filter((r) => r.kind === 'experience_years')).toEqual([]);
  });

  it('records no degree requirement from "You will work alongside PhD researchers."', async () => {
    const { requirements } = await extract('You will work alongside PhD researchers.');
    expect(requirements.filter((r) => r.kind === 'education_level')).toEqual([]);
  });

  /** The evidence contract still holds for everything that does survive. */
  it('still quotes real text for what it does keep', async () => {
    const description =
      'U.S. citizenship preferred. You will work alongside PhD researchers. ' +
      'Applicants must be at least 18 years of age.';
    const { requirements } = await extract(description);
    expect(requirements.length).toBeGreaterThan(0);
    for (const r of requirements) {
      expect(verifyQuote(r.sourceQuote, description).ok, `bad quote for ${r.kind}`).toBe(true);
    }
  });
});

// ───────────────────────────────── defect 1: necessity was hardcoded

/**
 * Ten call sites said `required` whatever the posting said, and the helper that reads the
 * softener sat above them, already used by the experience and degree blocks. Each pair below
 * pins the wish and the rule for one of those sites, because applying the helper is only half
 * of it: a change that softens everything passes the left column and empties the right one.
 */
describe('a requirement the posting only wishes for, at every kind the regexes read', () => {
  it.each([
    ['citizenship', 'U.S. citizenship preferred.', 'U.S. citizenship is required.'],
    [
      'citizenship',
      'Preferred qualifications\nUnited States citizens\nFamiliarity with Python',
      'Requirements\nUnited States citizens\nFamiliarity with Python',
    ],
    [
      'enrollment',
      'Preferably currently enrolled in a degree program.',
      'Must be currently enrolled in a degree program.',
    ],
    [
      'enrollment',
      'Nice to have: currently enrolled in a CS degree program.',
      'Required: currently enrolled in a CS degree program.',
    ],
    [
      'graduation_window',
      'Ideally graduating between December 2027 and June 2028.',
      'Graduating between December 2027 and June 2028.',
    ],
  ])('reads %s as preferred in %j and required in %j', (kind, wish, rule) => {
    expect(necessityOf(kind, wish)).toBe('preferred');
    expect(necessityOf(kind, rule)).toBe('required');
  });

  /**
   * workAuthorization() in eligibility.ts already has the branch for this — "the posting
   * would rather you did not, but it does not rule it out" — and nothing could reach it,
   * because the sponsorship block was one of the ten. A student who needs a visa was
   * hard-failed on a sentence that never closed the door.
   */
  const refusal = (text: string) =>
    found(text).find(
      (r) => r.kind === 'work_auth' && (r.value as { sponsorshipUnavailable?: boolean }),
    );

  it('reads a sponsorship refusal the posting merely prefers as preferred', () => {
    const soft = refusal('Preferred qualifications\nAble to work in the US without sponsorship');
    expect(soft?.value).toEqual({ sponsorshipUnavailable: true });
    expect(soft?.necessity).toBe('preferred');
  });

  it('still reads a plain sponsorship refusal as required', () => {
    const hard = refusal('We do not provide visa sponsorship for this role.');
    expect(hard?.value).toEqual({ sponsorshipUnavailable: true });
    expect(hard?.necessity).toBe('required');
  });

  it('reads an authorization line under a preferred heading as preferred', () => {
    expect(
      necessityOf(
        'work_auth',
        'Preferred qualifications:\n- Authorized to work in the United States',
      ),
    ).toBe('preferred');
    expect(
      necessityOf('work_auth', 'Requirements:\n- Must be authorized to work in the United States'),
    ).toBe('required');
  });

  it('reads a clearance the posting only prefers as preferred', () => {
    expect(necessityOf('citizenship', 'Preferred: an active security clearance is required.')).toBe(
      'preferred',
    );
    expect(necessityOf('citizenship', 'An active security clearance is required.')).toBe(
      'required',
    );
  });

  /**
   * An age gate is the requirement this population is most often measured against, so a
   * preferred one hidden under a heading was a hard rejection of the 16-year-old the
   * programme was written for. `unclear` — the unnumbered "legal working age" gate — is left
   * exactly as it was, being already the softest reading there is.
   */
  it('reads an age floor stated as a preference as preferred, and a plain one as required', () => {
    expect(necessityOf('age', 'Preferred qualifications\n18 years of age or older')).toBe(
      'preferred',
    );
    expect(necessityOf('age', 'Must be at least 18.')).toBe('required');
    expect(necessityOf('age', 'Minimum age: 18.')).toBe('required');
    expect(necessityOf('age', 'Applicants must be of legal working age.')).toBe('unclear');
  });

  /** The floor itself is unchanged; only how binding the posting says it is moved. */
  it('keeps the number when it softens the age', () => {
    expect(valueOf('age', 'Preferred qualifications\n18 years of age or older')).toEqual({
      min: 18,
    });
  });
});

// ───────────────────────────────── defect 2: the sentence is about somebody else

/**
 * The "what you'll do" paragraph of an internship posting is mostly a description of the
 * people the intern will meet, and every qualification in it was read as a demand. Both
 * reported sentences are here with their siblings: the shapes share one grammar — the
 * applicant is the subject, the qualified stranger is the object — so whichever marker is
 * left out is the one the next posting will use.
 */
describe('a qualification belonging to the team, not the applicant', () => {
  it.each([
    ['mentored by', 'You will be mentored by engineers with 10+ years of experience.'],
    ['work alongside', 'You will work alongside PhD researchers.'],
    ['work with', 'You will work with scientists holding doctoral degrees.'],
    ['join a team of', 'You will join a team of engineers with 8 years of experience each.'],
    ['our engineers', 'Our engineers have 12 years of experience on average.'],
    ['report to', 'You will report to a director with 15 years of experience.'],
    ['led by', 'This lab is led by researchers with doctoral degrees.'],
    ['supervised by', 'You will be supervised by a manager with a PhD degree.'],
    ['surrounded by', 'You will be surrounded by PhD students.'],
    ['staffed by', 'The team you join is staffed by engineers with 9 years of experience.'],
    ["the team's", "The team's researchers all hold a Master's degree."],
    ['learn from', 'You will learn from mentors with 7 years of experience.'],
    ['collaborate with', 'You will collaborate with U.S. citizens on classified work.'],
    ['under the guidance of', 'Under the guidance of engineers with 11 years of experience.'],
    [
      'enrolment, third party',
      'You will be mentored by graduate students enrolled in a PhD programme.',
    ],
    [
      'graduation window, third party',
      'You will work alongside analysts graduating between May 2026 and June 2027.',
    ],
    ['age, third party', 'You will work alongside staff 21 years of age and over.'],
  ])('states no requirement at all: %s', (_label, text) => {
    expect(found(text)).toEqual([]);
  });

  /**
   * The other direction, which is the whole reason the check is scoped to the clause. A
   * posting can describe the team and then state a real rule in the same breath, and
   * `clauseBounds` is what separates them: the comma and the "and" are hard breaks, so the
   * requirement is read with an empty lead-in and survives.
   */
  it.each([
    [
      'a rule after the description',
      'You will work alongside our researchers, and you must be enrolled in a PhD programme.',
      ['enrollment', 'education_level'],
    ],
    ['a bare demand', '5+ years of experience required', ['experience_years']],
    [
      'the vacancy introduced by the team that has it',
      'Our team is looking for a candidate with 5 years of experience.',
      ['experience_years'],
    ],
    [
      'a team that states the rule itself',
      "Our engineering team requires a Bachelor's degree.",
      ['education_level'],
    ],
    [
      'a new sentence',
      'Join a team of great people. You must have 3 years of experience.',
      ['experience_years'],
    ],
    [
      'a new clause after a semicolon',
      'We are a team of 40 engineers; candidates must be currently enrolled in a degree program.',
      ['enrollment'],
    ],
    [
      'a citizenship rule after a participial opener',
      'Working alongside our designers, you must be a U.S. citizen.',
      ['citizenship'],
    ],
  ])('still states one: %s', (_label, text, expected) => {
    expect(kinds(text).sort()).toEqual([...expected].sort());
    for (const kind of expected) expect(necessityOf(kind, text)).toBe('required');
  });

  /**
   * The degree loop keeps only one requirement per level and `break`s out as soon as it has
   * it, so skipping a third-party match rather than stopping is load-bearing: a posting that
   * introduces the lab before it states its own bar would otherwise record neither.
   */
  it('finds the real degree requirement stated after a third-party mention of another', () => {
    const text =
      "You will work alongside PhD researchers.\nApplicants must hold a Bachelor's degree.";
    expect(valueOf('education_level', text)).toEqual({ levels: ['bachelor'] });
    expect(necessityOf('education_level', text)).toBe('required');
  });
});

// ───────────────────────────────── the disclaimer one line above the number

/**
 * A posting whose whole point is that it wants beginners cannot also be demanding years, and
 * the softener machinery could never see it: `softenerWindow` clips to the line and the full
 * stop on purpose, so that a "plus" on one bullet cannot soften the next, and this disclaimer
 * is always its own sentence. It is a claim about the role, so it is read at the scope the
 * claim has — the whole description.
 *
 * `unclear` rather than `preferred`, because the posting has contradicted itself and only the
 * student can say which line is aimed at her. eligibility.ts routes that to `unknown` — a
 * question, printed with the posting still in front of her — instead of the hard fail it was.
 */
describe('an explicit "no experience needed" disclaimer beside a number of years', () => {
  it.each([
    'No prior experience necessary. Requirements: 2 years of experience with Python.',
    'No experience required.\nRequirements\n3 years of experience with Java.',
    'Experience is not required. 4 years of relevant experience.',
    'We do not require any prior experience. 5 years of professional experience.',
  ])('does not let the number hard-fail anyone: %j', (text) => {
    expect(necessityOf('experience_years', text)).toBe('unclear');
  });

  /**
   * The overcorrection, pinned. A disclaimer scoped to ONE technology waives that technology
   * and nothing else, so nothing may sit between "experience" and the word that waives it —
   * otherwise a posting could disclaim Kubernetes and quietly lose its three-year rule.
   */
  it('keeps the requirement when the disclaimer is about one particular skill', () => {
    expect(
      necessityOf(
        'experience_years',
        'No prior experience with Kubernetes is necessary. 3 years of professional experience required.',
      ),
    ).toBe('required');
    expect(
      necessityOf(
        'experience_years',
        'No experience with our internal tools is expected. Candidates need 4 years of experience.',
      ),
    ).toBe('required');
  });

  /** An ordinary softener still reads as a plain preference, not as a question. */
  it('does not turn a plainly preferred number into an ambiguity', () => {
    expect(
      necessityOf(
        'experience_years',
        'No prior experience necessary. 3 years of professional experience is a plus.',
      ),
    ).toBe('preferred');
  });
});
