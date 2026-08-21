import { describe, expect, it } from 'vitest';
import type { ConfirmedProfile } from '@ia/shared';
import { scoreMatch, type ScoreInput } from '../src/core/matching/score';

/**
 * How much a location is worth to THIS student.
 *
 * "Remote" used to score 0.9 whatever else the posting said, so a role advertised as "remote,
 * Leipzig" ranked almost as well for someone in Half Moon Bay as one in Half Moon Bay. Found by
 * running a real search: six of the fifteen eligible matches were German roles, five of them
 * naming a city, and they were there because a German board sets `remote` on anything that is
 * not fully in-office.
 *
 * A posting that names a city has anchored itself to that city. Whether its remote reaches
 * California is exactly what it has not said, so the score sits between "as good as home" and
 * "plainly out of range", and the note says which part is unknown instead of picking one.
 */
const PROFILE = {
  id: 'p1',
  fullName: 'Eric Dean',
  skills: [],
  experience: [],
  projects: [],
  preferences: { companySizes: [], roleFamilies: [], industries: [], excludeCompanies: [] },
  locationPrefs: {
    base: { city: 'Half Moon Bay', region: 'CA', country: 'US' },
    additionalBases: [{ city: 'Los Angeles', region: 'CA', country: 'US' }],
    maxCommuteKm: 50,
    remoteOk: true,
    hybridOk: true,
    relocateTo: ['Seattle'],
  },
  derived: { seniorityBand: 'entry_intern', academicLevel: 'undergrad' },
} as unknown as ConfirmedProfile;

const score = (
  locations: Array<{ city?: string; remote: boolean }>,
  workArrangement: string | null = null,
) =>
  scoreMatch({
    profile: PROFILE,
    posting: {
      id: 'j1',
      company: 'Acme',
      title: 'Operations Intern',
      isOpen: true,
      closesAt: null,
      locations,
      workArrangement,
      term: { season: null, year: null },
      descriptionText: 'An internship.',
      compensation: null,
      applyEffort: null,
      positionType: 'internship',
    },
    requirements: [],
  } as unknown as ScoreInput);

describe('what a location is worth', () => {
  const location = (r: ReturnType<typeof score>) => r.breakdown.locationDesirability;
  const note = (r: ReturnType<typeof score>) => r.notes.locationDesirability;

  it('scores a job in a city the student works from as the best there is', () => {
    expect(location(score([{ city: 'Half Moon Bay', remote: false }]))).toBe(1);
    // Every place they work from, not only the primary one.
    expect(location(score([{ city: 'Los Angeles', remote: false }]))).toBe(1);
  });

  it('scores unanchored remote nearly as well, because it really is anywhere', () => {
    expect(location(score([{ remote: true }]))).toBe(0.9);
    expect(location(score([], 'remote'))).toBe(0.9);
    expect(note(score([{ remote: true }]))).toBe('remote');
  });

  it('does NOT treat remote-in-Leipzig as remote-from-anywhere', () => {
    // The bug, exactly. A German board flags this remote; the posting names Leipzig; nothing
    // in it says whether remote reaches California.
    const anchored = score([{ city: 'Leipzig', remote: true }]);
    expect(location(anchored)).toBeLessThan(0.9);
    expect(location(anchored)).toBeGreaterThan(0.4);
    // And it ranks below a genuinely unanchored remote job, which is the whole point.
    expect(location(anchored)).toBeLessThan(location(score([{ remote: true }])));
  });

  it('says which part it does not know, rather than picking one and asserting it', () => {
    const said = note(score([{ city: 'Leipzig', remote: true }]));
    expect(said).toContain('Leipzig');
    expect(said).toMatch(/does not say where remote is allowed/);
  });

  it('still favours a remote job anchored somewhere the student would go', () => {
    // Anchoring only costs when the anchor is out of reach. A remote job based in a city they
    // work from is a home match, and one in a relocation target keeps its credit.
    expect(location(score([{ city: 'Half Moon Bay', remote: true }]))).toBe(1);
    expect(location(score([{ city: 'Seattle', remote: true }]))).toBe(0.9);
  });

  it('leaves a plain out-of-range job where it was', () => {
    expect(location(score([{ city: 'Leipzig', remote: false }]))).toBe(0.4);
    expect(note(score([{ city: 'Leipzig', remote: false }]))).toBe('outside your stated areas');
  });
});
