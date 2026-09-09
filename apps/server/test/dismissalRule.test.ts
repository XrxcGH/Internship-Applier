/**
 * The server half of the G1 dismissal rule, which nothing tested.
 *
 * "I have checked this" clears a review flag, and gate G1 refuses to confirm a profile while
 * any flag stands. So a flag that can be dropped while its field is still empty is a hole
 * straight through the gate: one click marks a fact as reviewed, the flag disappears, and the
 * profile confirms with the fact missing. Everything downstream — eligibility, drafting,
 * filling — then reasons about a profile with a hole in it.
 *
 * `apps/web/test/review.test.ts` covers the WEB copy of this table thoroughly. It does not
 * cover this one. Two tables spelling the same rule are exactly the shape that drifts, and
 * the server's is the one that decides: a client can be edited, a curl can skip the client
 * altogether, and the route is a supported way to drive this server.
 *
 * The rule is tested here rather than through the route because this is the function that
 * holds it — routes/profile.ts asks this and reports what it says. That the two tables name
 * the same paths is pinned separately, in docsFacts.test.ts § "the two copies of
 * ANSWERED_IN_WIZARD", which compares them by reading both sources rather than importing
 * across apps — so it is not repeated here.
 */
import { describe, expect, it } from 'vitest';
import type { CandidateProfile } from '@ia/shared';
import { ANSWERED_IN_WIZARD, dismissalRefusal, isAnswered } from '../src/core/profile/reviewFlags';

/** A profile with every wizard-answerable field EMPTY, in the shape each one empties to. */
function blank(over: Record<string, unknown> = {}): CandidateProfile {
  return {
    id: 'p1',
    fullName: '',
    email: '',
    dateOfBirth: null,
    address: { country: 'US' },
    links: { other: [] },
    workAuthorization: { country: 'US', status: 'unknown', needsSponsorship: false },
    citizenships: [],
    education: [],
    experience: [],
    projects: [],
    skills: [],
    certifications: [],
    languages: [],
    availability: { flexible: true },
    locationPrefs: {
      base: { city: '', region: '', country: 'US' },
      additionalBases: [],
      maxCommuteKm: 50,
      remoteOk: true,
      hybridOk: true,
      relocateTo: [],
    },
    preferences: { companySizes: [], roleFamilies: [], industries: [], excludeCompanies: [] },
    derived: {
      age: null,
      isMinor: false,
      academicLevel: 'none',
      academicYear: null,
      expectedGraduation: null,
      yearsProfessionalExperience: 0,
      seniorityBand: 'entry_intern',
    },
    needsReview: [],
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...over,
  } as unknown as CandidateProfile;
}

describe('a flag the wizard can answer', () => {
  it('refuses to be dismissed while its own field is empty — every one of them', () => {
    // Driven off the table itself rather than a list written here, so adding a row to
    // ANSWERED_IN_WIZARD without a way to answer it turns this red rather than shipping a
    // flag the user can wave away.
    for (const path of Object.keys(ANSWERED_IN_WIZARD)) {
      const refusal = dismissalRefusal(blank(), path);
      expect({ path, refused: refusal !== null }).toEqual({ path, refused: true });
      // The refusal has to say what to do, or it is a wall. It names the field and the path.
      expect(refusal, path).toContain(path);
    }
  });

  it('allows it once the field holds a real answer', () => {
    expect(dismissalRefusal(blank({ fullName: 'Maya Okonkwo' }), 'fullName')).toBeNull();
    expect(dismissalRefusal(blank({ dateOfBirth: '2010-04-17' }), 'dateOfBirth')).toBeNull();
    expect(
      dismissalRefusal(
        blank({ workAuthorization: { country: 'US', status: 'citizen', needsSponsorship: false } }),
        'workAuthorization.status',
      ),
    ).toBeNull();
    expect(
      dismissalRefusal(
        blank({
          locationPrefs: {
            ...blank().locationPrefs,
            base: { city: 'Portland', region: 'OR', country: 'US' },
          },
        }),
        'locationPrefs.base.city',
      ),
    ).toBeNull();
  });

  /**
   * The other direction, and the reason the rule is not simply "refuse everything". The
   * extractor flags fields the wizard has no control for — a start date it could not read on
   * one experience row — and without a way to clear those, G1 locks shut and there is no way
   * into the rest of the product at all.
   */
  it('leaves a flag with no control anywhere dismissible, so the gate cannot lock shut', () => {
    for (const path of ['experience.0.startDate', 'education.2.endDate', 'projects.0.url']) {
      expect({ path, refusal: dismissalRefusal(blank(), path) }).toEqual({ path, refusal: null });
    }
  });

  /**
   * "Unanswered" is not one shape, and this is the half that made the rule real. The
   * work-authorization enum spells its own placeholder as the string "unknown", the text
   * fields empty to '', and the date pickers to null or undefined — a predicate that only
   * understood strings read a cleared date as an answer.
   */
  it('knows every shape an empty answer arrives in', () => {
    expect(isAnswered(null)).toBe(false);
    expect(isAnswered(undefined)).toBe(false);
    expect(isAnswered('')).toBe(false);
    expect(isAnswered('   ')).toBe(false);
    expect(isAnswered('unknown')).toBe(false);
    expect(isAnswered([])).toBe(false);

    expect(isAnswered('Portland')).toBe(true);
    expect(isAnswered('citizen')).toBe(true);
    expect(isAnswered(['US'])).toBe(true);
  });
});
