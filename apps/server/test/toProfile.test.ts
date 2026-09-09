/**
 * Dates on the way in.
 *
 * The extractor is told to write YYYY-MM and it does not always: it writes "June 2025",
 * "06/2025", "Summer 2025", "2025-6", a full ISO day, or a bare year, because that is what
 * the resume in front of it says. Everything that was not exactly YYYY-MM used to become
 * `undefined`, and on an end date `undefined` is the schema's "still there" — so a finished
 * nine-month job read as ongoing, its span grew every month the file sat there, and a draft
 * claiming twice the real tenure came back green with the entry quoted beside it as proof.
 * The same silence on a certification date pushed a true sentence the other way and blocked
 * it at G3, where there is no override.
 *
 * Both directions are asserted here on purpose. A repair that stops the false green by
 * shortening every span would just move the damage to the other gate.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CandidateProfile } from '@ia/shared';
import { ResumeExtraction } from '../src/core/ingestion/extractProfile';
import { REQUIRED_BY_G1, toDraftProfile } from '../src/core/ingestion/toProfile';
import { retrieveEvidence } from '../src/core/writing/retrieve';
import { guardDraft } from '../src/core/writing/factGuard';

// FactGuard reads a clock of its own for open-ended entries, so the whole file runs on a
// pinned one: otherwise every span in here grows by a month each month and the green way to
// fix the resulting failure is to edit the expectation.
const NOW = new Date('2026-08-09T00:00:00Z');

beforeAll(() => {
  vi.useFakeTimers({ now: NOW });
});
afterAll(() => {
  vi.useRealTimers();
});

const SCHOOL = {
  institution: 'Sample High School',
  level: 'high_school' as const,
  fieldOfStudy: null,
  startDate: '2022-08',
  endDate: '2026-06',
  gpaValue: 3.9,
  gpaScale: 4,
  gpaWeighted: null,
  coursework: [],
  honors: [],
};

/** A school-store job that really ran nine months, September 2024 to June 2025. */
const STORE = {
  organization: 'Sample High School Store',
  title: 'Student Associate',
  type: 'job' as const,
  startDate: '2024-09',
  endDate: '2025-06',
  location: null,
  bullets: ['Ran the register at lunch'],
};

const BASE = {
  fullName: 'Rosa Sample',
  pronouns: null,
  email: 'rosa.sample@example.com',
  phone: null,
  location: 'Columbus, OH',
  links: { github: null, linkedin: null, portfolio: null },
  education: [SCHOOL],
  experience: [STORE],
  projects: [],
  skills: [],
  certifications: [],
  languages: [],
  needsReview: [],
};

function draft(over: Record<string, unknown> = {}): CandidateProfile {
  return toDraftProfile(ResumeExtraction.parse({ ...BASE, ...over }), NOW);
}

function withStoreEnd(endDate: string | null): CandidateProfile {
  return draft({ experience: [{ ...STORE, endDate }] });
}

function confirmed(p: CandidateProfile) {
  return { ...p, confirmedAt: NOW.toISOString() };
}

function guard(p: CandidateProfile, claim: string, question = 'Tell us about your experience.') {
  const evidence = retrieveEvidence(confirmed(p) as never, question, { limit: 20 });
  return guardDraft(claim, evidence);
}

/** Every spelling of June 2025 a model has been seen to emit for one and the same month. */
const JUNE_2025 = [
  '2025-06',
  '2025-6',
  '2025/06',
  '2025.06',
  '06/2025',
  '6/2025',
  '2025-06-14',
  '2025-06-14T00:00:00Z',
  '6/14/2025',
  '14/06/2025',
  'June 2025',
  'Jun 2025',
  'Jun. 2025',
  'JUNE 2025',
  'June 14, 2025',
  'Expected June 2025',
];

/**
 * Stated dates that name a range of months rather than one.
 *
 * The seasons are the OUTER edge of the ordinary reading, not the meteorological one. They
 * used to be the narrow reading — fall to November, summer to August, spring to May — and
 * that made a September-to-December term two months long, so a student's true "I tutored
 * there for four months" came back `overstated` at G3, where there is no override. Both
 * edges matter: `latest` becomes the month an experience finished and `earliest` the month a
 * card was earned, and neither may fall inside the span the words actually allow.
 */
const WIDE_2025: Array<[string, { earliest: string; latest: string }]> = [
  ['2025', { earliest: '2025-01', latest: '2025-12' }],
  ['Summer 2025', { earliest: '2025-05', latest: '2025-09' }],
  ['Spring 2025', { earliest: '2025-01', latest: '2025-06' }],
  ['Fall 2025', { earliest: '2025-08', latest: '2025-12' }],
  ['Autumn 2025', { earliest: '2025-08', latest: '2025-12' }],
  // Winter straddles New Year, so it narrows to nothing and stays the whole year.
  ['Winter 2025', { earliest: '2025-01', latest: '2025-12' }],
  ['Class of 2025', { earliest: '2025-01', latest: '2025-12' }],
];

/**
 * A range the extractor copied into one field, and the month each end of it names.
 *
 * This is the shape a resume line has — "Ohio State University, Aug 2026 - May 2030" — and
 * the extractor puts the whole line in `endDate` often enough that it is the input class
 * this reader exists to absorb. `first` is `undefined` where that half names a year and no
 * month, which is a start date this file will not invent.
 */
const RANGES: Array<[string, string | undefined, string]> = [
  ['Aug 2026 - May 2030', '2026-08', '2030-05'],
  ['2026-08 - 2030-05', '2026-08', '2030-05'],
  ['August 2026 - May 2030', '2026-08', '2030-05'],
  ['2026-08 to 2030-05', '2026-08', '2030-05'],
  ['2026-08 until 2030-05', '2026-08', '2030-05'],
  ['2026-08 through 2030-05', '2026-08', '2030-05'],
  ['08/2026 - 05/2030', '2026-08', '2030-05'],
  ['Aug 2026 – May 2030', '2026-08', '2030-05'],
  ['Aug 2026–May 2030', '2026-08', '2030-05'],
  ['Aug 2026 — May 2030', '2026-08', '2030-05'],
  ['Aug 2026 -- May 2030', '2026-08', '2030-05'],
  // A bare year on one side and a month on the other. "2026 - May 2030" was read as
  // 2026-05, a month that appears in neither half of the string.
  ['2026 - May 2030', undefined, '2030-05'],
  ['2026 to May 2030', undefined, '2030-05'],
];

/** The ways a resume says "I am still there". These mean exactly what an absent date means. */
const STILL_THERE = [
  'Present',
  'present',
  'Current',
  'Currently',
  'Ongoing',
  'now',
  'to date',
  // Two-word answers, which are the ones a range reader can cut in half by mistake: the
  // space inside "until now" is the same character that joins "2026-08 Present".
  'until now',
  'until present',
  'till date',
  'to present',
];

describe('a date the schema will not take verbatim', () => {
  it('reads every spelling of one month down to that month, and asks nothing of the user', () => {
    for (const raw of JUNE_2025) {
      const d = withStoreEnd(raw);
      expect(d.experience[0]?.endDate, raw).toBe('2025-06');
      expect(d.needsReview, raw).not.toContain('experience.0.endDate');
      expect(d.derived.yearsProfessionalExperience, raw).toBe(0.8);
    }
  });

  it('reads the same spellings on every other date field this file maps', () => {
    for (const raw of JUNE_2025) {
      expect(draft({ experience: [{ ...STORE, startDate: raw }] }).experience[0]?.startDate, raw) //
        .toBe('2025-06');
      expect(draft({ education: [{ ...SCHOOL, startDate: raw }] }).education[0]?.startDate, raw) //
        .toBe('2025-06');
      expect(draft({ education: [{ ...SCHOOL, endDate: raw }] }).education[0]?.endDate, raw) //
        .toBe('2025-06');
      const cert = draft({
        certifications: [{ name: 'CPR', issuer: 'American Red Cross', date: raw }],
      });
      expect(cert.certifications[0]?.date, raw).toBe('2025-06');
      for (const path of [
        'experience.0.startDate',
        'education.0.startDate',
        'education.0.endDate',
        'certifications.0.date',
      ]) {
        expect(cert.needsReview, `${raw} ${path}`).not.toContain(path);
      }
    }
  });

  it('never lets a stated end date become "still working there"', () => {
    // The regression itself: with the date dropped, nine real months were measured to
    // today and grew from there. Whatever is stored now, it must be an end date the user
    // was told about, and the span must not outrun the ongoing reading.
    const ongoing = withStoreEnd(null).derived.yearsProfessionalExperience;
    for (const [raw, window] of WIDE_2025) {
      const d = withStoreEnd(raw);
      expect(d.experience[0]?.endDate, raw).toBeDefined();
      expect(d.needsReview, raw).toContain('experience.0.endDate');
      expect(d.derived.yearsProfessionalExperience, raw).toBeLessThan(ongoing);
      // And never below the shortest reading the same words allow, which is the other half
      // of the deal: whichever month inside that window the job really ended, the figure on
      // file is not short of the truth. A figure short of the truth drops a student under a
      // "requires N years" minimum and marks a posting they qualify for ineligible.
      const shortest = withStoreEnd(window.earliest).derived.yearsProfessionalExperience;
      expect(d.derived.yearsProfessionalExperience, raw).toBeGreaterThanOrEqual(shortest);
    }
  });

  it('widens an end date to the last month its window allows, and no further', () => {
    for (const [raw, window] of WIDE_2025) {
      // Later than the truth, never earlier, so widening cannot block a true sentence
      // about the job while it does bound the span the old `undefined` left open.
      expect(withStoreEnd(raw).experience[0]?.endDate, raw).toBe(window.latest);
    }
  });

  it('widens a certification year to its first month, which is where the claim starts', () => {
    for (const [raw, window] of WIDE_2025) {
      const cert = draft({
        certifications: [{ name: 'CPR', issuer: 'American Red Cross', date: raw }],
      });
      expect(cert.certifications[0]?.date, raw).toBe(window.earliest);
      expect(cert.needsReview, raw).toContain('certifications.0.date');
    }
  });

  it('reads both ends of a range, and never a month from the wrong end of it', () => {
    // The worst thing this file has done. "Ohio State University, Aug 2026 - May 2030"
    // arrives with the whole line in `endDate`, the reader took the FIRST month it could
    // find, and the month the student STARTS college became `derived.expectedGraduation`:
    // a posting for the class of 2030 came back `ineligible`, which this repo documents as
    // the worst bug the app can have. The result looked like a clean month, so nothing
    // reached `needsReview` and G1 never got the chance to correct it either.
    for (const [raw, first, last] of RANGES) {
      const school = draft({ education: [{ ...SCHOOL, endDate: raw }] });
      expect(school.education[0]?.endDate, raw).toBe(last);
      expect(school.derived.expectedGraduation, raw).toBe(last);
      const job = draft({ experience: [{ ...STORE, startDate: raw }] });
      expect(job.experience[0]?.startDate, raw).toBe(first);
      // The months are the resume's, but which half of the string each field wanted is this
      // file's reading, so both fields go to G1 whatever they came out as.
      expect(school.needsReview, raw).toContain('education.0.endDate');
      expect(job.needsReview, raw).toContain('experience.0.startDate');
    }
  });

  it('leaves a range that runs to "Present" running, and asks about it', () => {
    // The same string with the other ending. Read as one date this recorded a programme
    // still in progress as finished in the month it began.
    //
    // The joiner is enumerated here rather than assumed, because the separator list is what
    // this family kept escaping through. "2024-08 Present" and "Aug 2024 / Present" carry no
    // separator the range reader knows AND no second year to give the second date away, so
    // the ISO branch swallowed " Present" as a timestamp and the word branch took the first
    // month word: a club the student still attends was stored as finished in the month it
    // began, with nothing on `needsReview`, and a true "for two years" about it came back
    // `overstated` at G3 where there is no override.
    for (const raw of [
      'Aug 2026 - Present',
      '2026-08 - Present',
      '2026-08 to present',
      'Fall 2025 - present',
      'Aug 2026 – current',
      'Aug 2026 Present',
      '2026-08 Present',
      '2026 Present',
      'Aug 2026 / Present',
      '2026-08 / present',
      '2026-08; Present',
      '2026-08 & now',
      '2026-08 | ongoing',
      '2026-08-Present',
      'Aug 2026, currently',
    ]) {
      const school = draft({ education: [{ ...SCHOOL, endDate: raw }] });
      expect(school.education[0]?.endDate, raw).toBeUndefined();
      expect(school.derived.expectedGraduation, raw).toBeNull();
      expect(school.needsReview, raw).toContain('education.0.endDate');
      const job = draft({ experience: [{ ...STORE, endDate: raw }] });
      expect(job.experience[0]?.endDate, raw).toBeUndefined();
      expect(job.needsReview, raw).toContain('experience.0.endDate');
    }
    // The first half of the same strings is still a start date, and still asks: which half
    // the field wanted is this file's reading either way.
    for (const raw of ['Aug 2026 Present', '2026-08 / Present', '2026-08-Present']) {
      const job = draft({ experience: [{ ...STORE, startDate: raw }] });
      expect(job.experience[0]?.startDate, raw).toBe('2026-08');
      expect(job.needsReview, raw).toContain('experience.0.startDate');
    }
  });

  it('stores nothing from two dates it cannot split, rather than picking one of them', () => {
    // A separator this file does not know is not a licence to guess. Two years in one field
    // is two dates however they were joined, and `unreadable` plus the flag is the answer
    // the repo's own rule asks for when the data cannot decide it.
    for (const raw of ['2026-08 2030-05', 'Aug 2026 / May 2030', '2026-08; 2030-05']) {
      const school = draft({ education: [{ ...SCHOOL, endDate: raw }] });
      expect(school.education[0]?.endDate, raw).toBeUndefined();
      expect(school.needsReview, raw).toContain('education.0.endDate');
      const job = draft({ experience: [{ ...STORE, endDate: raw }] });
      expect(job.experience[0]?.endDate, raw).toBeUndefined();
      expect(job.needsReview, raw).toContain('experience.0.endDate');
    }
    // And the half a field asks for has to name a date of its own: "Jun" alone belongs to
    // whichever year the other half carries, and that is the guess this reader refuses.
    const start = draft({ experience: [{ ...STORE, startDate: 'Jun - Aug 2025' }] });
    expect(start.experience[0]?.startDate).toBeUndefined();
    expect(start.needsReview).toContain('experience.0.startDate');
    expect(draft({ experience: [{ ...STORE, endDate: 'Jun - Aug 2025' }] }).experience[0]?.endDate) //
      .toBe('2025-08');
  });

  it('does not mistake the hyphen inside a date for the hyphen between two', () => {
    // The other half of the range reader: an ASCII hyphen separates a range only when it
    // carries whitespace or has a whole year on its left, because it is also what YYYY-MM
    // is built out of.
    for (const raw of ['2025-06', '2025-06-14', '2025-06-14T00:00:00Z', '2025-06-14 09:30']) {
      const d = withStoreEnd(raw);
      expect(d.experience[0]?.endDate, raw).toBe('2025-06');
      expect(d.needsReview, raw).not.toContain('experience.0.endDate');
    }
  });

  it('reads a certification range as the month the card was earned, not when it lapses', () => {
    // A card prints "issued - expires", and the claim it can support starts at the issue.
    for (const [raw, earned] of [
      ['2023-05 - 2026-05', '2023-05'],
      ['May 2023 - May 2026', '2023-05'],
      ['2023 - 2026', '2023-01'],
    ] as const) {
      const cert = draft({
        certifications: [{ name: 'CPR', issuer: 'American Red Cross', date: raw }],
      });
      expect(cert.certifications[0]?.date, raw).toBe(earned);
      expect(cert.needsReview, raw).toContain('certifications.0.date');
    }
  });

  it('does not widen a start date, because a widened start makes an inflation green', () => {
    // The other direction of the same coin, and the reason the widening is not applied
    // uniformly. An entry stated as beginning "2024" and still running becomes thirty-one
    // months if January is assumed, FactGuard adds its quarter of rounding slack on top,
    // and a thirty-six month claim no reading of "2024" could support comes back
    // supported. Undated, the entry bounds nothing and the claim falls back to the
    // profile's real spans, which is the conservative answer. The flag is what carries it
    // to the user.
    for (const [raw] of WIDE_2025) {
      const exp = draft({ experience: [{ ...STORE, startDate: raw }] });
      expect(exp.experience[0]?.startDate, raw).toBeUndefined();
      expect(exp.needsReview, raw).toContain('experience.0.startDate');
      const school = draft({ education: [{ ...SCHOOL, startDate: raw }] });
      expect(school.education[0]?.startDate, raw).toBeUndefined();
      expect(school.needsReview, raw).toContain('education.0.startDate');
    }
  });

  it('leaves an ongoing role ongoing, and flags none of them', () => {
    // Flagging every ongoing role would leave a student clearing a flag for every club
    // they have ever joined, which is the fastest way to make G1 unusable.
    for (const raw of [...STILL_THERE, null, '', '   ']) {
      const d = withStoreEnd(raw);
      expect(d.experience[0]?.endDate, JSON.stringify(raw)).toBeUndefined();
      expect(d.needsReview, JSON.stringify(raw)).not.toContain('experience.0.endDate');
    }
    // `skills` is here because BASE states none, not because of anything the end date did.
    // Asserting the whole list rather than just the absence of the end-date flag is the
    // point of this line — a repair that quietly added a flag for every entry would pass a
    // narrower assertion — so the expectation names it.
    const clean = withStoreEnd(null);
    expect(clean.needsReview).toEqual([...REQUIRED_BY_G1, 'skills']);
  });

  it('will not read "Present" as a start date or as the day a card was earned', () => {
    for (const raw of STILL_THERE) {
      expect(draft({ experience: [{ ...STORE, startDate: raw }] }).needsReview, raw) //
        .toContain('experience.0.startDate');
      expect(draft({ education: [{ ...SCHOOL, startDate: raw }] }).needsReview, raw) //
        .toContain('education.0.startDate');
      const cert = draft({
        certifications: [{ name: 'CPR', issuer: 'American Red Cross', date: raw }],
      });
      expect(cert.certifications[0]?.date, raw).toBeUndefined();
      expect(cert.needsReview, raw).toContain('certifications.0.date');
    }
  });

  it('flags a stated date that names nothing at all, and stores none of it', () => {
    for (const raw of ['sometime after school', 'n/a', 'TBD', '??', 'senior year']) {
      const d = withStoreEnd(raw);
      expect(d.experience[0]?.endDate, raw).toBeUndefined();
      expect(d.needsReview, raw).toContain('experience.0.endDate');
      const cert = draft({
        certifications: [{ name: 'CPR', issuer: 'American Red Cross', date: raw }],
      });
      expect(cert.certifications[0]?.date, raw).toBeUndefined();
      expect(cert.needsReview, raw).toContain('certifications.0.date');
    }
  });

  it('does not announce a job finished that the calendar has not finished', () => {
    // December of this year has not happened, so a role stated as ending "2026" may well
    // still be running. Ongoing, and flagged, is the honest pair.
    for (const raw of ['2026', '2027', 'Fall 2026']) {
      const d = withStoreEnd(raw);
      expect(d.experience[0]?.endDate, raw).toBeUndefined();
      expect(d.needsReview, raw).toContain('experience.0.endDate');
    }
    // An end year that finished before the role began is a contradiction only the user can
    // settle. It is not stored as a zero-month span, which would block true sentences.
    const backwards = draft({ experience: [{ ...STORE, startDate: '2025-09', endDate: '2024' }] });
    expect(backwards.experience[0]?.endDate).toBeUndefined();
    expect(backwards.needsReview).toContain('experience.0.endDate');
  });

  it('refuses to invent a graduation month, and says so on the flag list', () => {
    // Deliberately unlike the three other date fields: an education end date becomes
    // `derived.expectedGraduation`, which the graduation-window rule compares against the
    // range a posting accepts. With no date the rule asks the user; with a month this file
    // invented it can mark a real posting ineligible, and there is no override for that.
    for (const raw of ['2027', 'Spring 2027', 'Class of 2027', '2024', 'Summer 2024']) {
      const d = draft({ education: [{ ...SCHOOL, endDate: raw }] });
      expect(d.education[0]?.endDate, raw).toBeUndefined();
      expect(d.needsReview, raw).toContain('education.0.endDate');
      expect(d.derived.expectedGraduation, raw).toBeNull();
    }
  });

  it('flags an absent start date and no absent end date', () => {
    // An undated job contributes nothing to the seniority band or the experience ceiling,
    // so its silence is a loss worth telling the user about. A missing END date is not a
    // loss at all: it is the resume saying the role is current.
    const d = draft({ experience: [{ ...STORE, startDate: null, endDate: null }] });
    expect(d.needsReview).toContain('experience.0.startDate');
    expect(d.needsReview).not.toContain('experience.0.endDate');
    // Education is the other way round on the start date, and always has been: a school
    // with no start month on the resume is ordinary.
    const school = draft({ education: [{ ...SCHOOL, startDate: null, endDate: null }] });
    expect(school.needsReview).not.toContain('education.0.startDate');
    expect(school.needsReview).not.toContain('education.0.endDate');
  });

  it('keeps the dotted path pointing at the entry it belongs to', () => {
    const d = draft({
      experience: [STORE, { ...STORE, organization: 'Riverside Robotics', endDate: '2025' }],
      certifications: [
        { name: 'Lifeguarding', issuer: 'American Red Cross', date: '2024-05' },
        { name: 'CPR', issuer: 'American Red Cross', date: '2023' },
      ],
    });
    expect(d.needsReview).toContain('experience.1.endDate');
    expect(d.needsReview).not.toContain('experience.0.endDate');
    expect(d.needsReview).toContain('certifications.1.date');
    expect(d.needsReview).not.toContain('certifications.0.date');
  });

  it('still produces a profile the schema accepts, whatever it was handed', () => {
    for (const raw of [...JUNE_2025, ...WIDE_2025.map(([r]) => r), ...STILL_THERE, 'n/a', '9999']) {
      const d = draft({
        education: [{ ...SCHOOL, startDate: raw, endDate: raw }],
        experience: [{ ...STORE, startDate: raw, endDate: raw }],
        certifications: [{ name: 'CPR', issuer: 'American Red Cross', date: raw }],
      });
      const parsed = CandidateProfile.safeParse(d);
      expect(parsed.success, `${raw} ${JSON.stringify(parsed.success ? '' : parsed.error.issues)}`) //
        .toBe(true);
    }
  });
});

describe('what those dates do at G3', () => {
  const DOUBLED = 'I have worked at the Sample High School Store for two years.';
  const TRUE_SPAN = 'I worked at the Sample High School Store for nine months.';

  it('blocks the doubled tenure that a dropped end date used to wave through', () => {
    for (const raw of ['2025-06', '2025', 'June 2025', 'Summer 2025', '06/2025']) {
      const g = guard(withStoreEnd(raw), DOUBLED);
      expect(
        g.blocking.map((c) => c.verdict),
        raw,
      ).toEqual(['overstated']);
    }
  });

  it('lets the true nine months through, on every one of those spellings', () => {
    for (const raw of ['2025-06', '2025', 'June 2025', '06/2025']) {
      expect(guard(withStoreEnd(raw), TRUE_SPAN).blocking, raw).toEqual([]);
    }
  });

  /**
   * Two months inside ONE year is the shape the two-dates test cannot see, because that test
   * counts years. A resume writes a summer job exactly this way, and the first month word was
   * being stored, unflagged, as the month the job ENDED — so a June-to-August internship
   * became a zero-month entry and the student's true sentence about it was blocked at G3,
   * where there is no override.
   */
  it('reads a month-to-month range that shares one year', () => {
    const TRUE_SUMMER = 'I interned at Harborview Marine Lab for two months.';
    const INFLATED = 'I interned at Harborview Marine Lab for two years.';

    for (const raw of [
      'Jun - Aug 2025',
      'Jun–Aug 2025',
      'Jun-Aug 2025',
      'June-August 2025',
      // No separator this file knows, and one shared year: nothing is stored and G1 is asked,
      // which is what it does with every other pair of dates it cannot separate.
      'Jun 2025 Aug 2025',
    ]) {
      const p = draft({
        experience: [
          {
            organization: 'Harborview Marine Lab',
            title: 'Summer Research Intern',
            type: 'internship',
            startDate: '2025-06',
            endDate: raw,
            location: null,
            bullets: ['Logged tide-pool species counts each morning'],
          },
        ],
      });
      expect(p.needsReview, raw).toContain('experience.0.endDate');
      expect(guard(p, TRUE_SUMMER).blocking, raw).toEqual([]);
      expect(
        guard(p, INFLATED).blocking.map((c) => c.verdict),
        raw,
      ).toEqual(['overstated']);
    }
  });

  it('measures a summer internship against the summer, not against today', () => {
    // The way a resume writes a summer internship, and the way the extractor copies it
    // down. Both dates used to be dropped, the entry read as running from an unknown start
    // to today, and a two-year claim about eleven weeks of work came back supported.
    for (const [startDate, endDate, stored] of [
      ['June 2025', 'August 2025', '2025-08'],
      // A season is stored at the outer edge of what those words allow, so this row ends in
      // September and the two rows around it in August. What matters is the same either
      // way: the entry is bounded by the summer instead of running to today.
      ['2025-06', 'Summer 2025', '2025-09'],
      ['6/2025', '08/2025', '2025-08'],
    ]) {
      const p = draft({
        experience: [
          {
            ...STORE,
            organization: 'Riverside Robotics Lab',
            title: 'Intern',
            type: 'internship',
            startDate,
            endDate,
          },
        ],
      });
      expect(p.experience[0]?.startDate, startDate).toBe('2025-06');
      expect(p.experience[0]?.endDate, endDate).toBe(stored);
      const g = guard(p, 'I have interned at Riverside Robotics Lab for two years.');
      expect(
        g.blocking.map((c) => c.verdict),
        `${startDate} ${endDate}`,
      ).toEqual(['overstated']);
      // Two months is what it was, and saying so is not blocked.
      expect(guard(p, 'I interned at Riverside Robotics Lab for two months.').blocking).toEqual([]);
    }
  });

  it('does not block the true length of a term the resume stated as a season', () => {
    // The direction the season windows exist for, and the one a table of narrow boundaries
    // gets wrong. A fall term capped at November made a September-to-December term two
    // months long, and the student's true "four months" came back `overstated` at a gate
    // with no override — a false red the app manufactured out of its own guess at the
    // calendar. The last row of each pair is the sentence that still has to block: widening
    // to the outer edge of the words is not the same as not bounding the entry at all.
    for (const [startDate, endDate, tRue, inflated] of [
      ['September 2025', 'Fall 2025', 'four months', 'five months'],
      ['2025-09', 'Autumn 2025', 'four months', 'five months'],
      ['January 2025', 'Spring 2025', 'five months', 'nine months'],
      ['June 2025', 'Summer 2025', 'four months', 'five months'],
    ] as const) {
      const p = draft({
        experience: [
          { ...STORE, organization: 'Riverside Robotics Lab', title: 'Tutor', startDate, endDate },
        ],
      });
      const say = (n: string) => `I tutored at Riverside Robotics Lab for ${n}.`;
      expect(guard(p, say(tRue)).blocking, `${endDate} ${tRue}`).toEqual([]);
      expect(
        guard(p, say(inflated)).blocking.map((c) => c.verdict),
        `${endDate} ${inflated}`,
      ).toEqual(['overstated']);
    }
  });

  it('stops blocking the true sentence about an undated-looking certification', () => {
    // The mirror image of the finding above, and the reason the year is widened rather
    // than dropped: with "2023" gone the card fell out of the duration pool, the claim was
    // measured against the longest JOB on the profile, and a true sentence was blocked at
    // a gate with no override.
    const p = draft({
      experience: [{ ...STORE, startDate: '2026-06', endDate: null }],
      certifications: [
        { name: 'CPR and First Aid Certification', issuer: 'American Red Cross', date: '2023' },
      ],
    });
    const question = 'Tell us about your certifications.';
    for (const claim of [
      'I have served as a CPR certified responder for three years.',
      'I have volunteered as a CPR certified first aid responder for three years.',
    ]) {
      expect(guard(p, claim, question).blocking, claim).toEqual([]);
    }
    // And the other direction still holds: a decade against a card earned in 2023 is a
    // fabrication and stays blocked.
    const over = guard(p, 'I have served as a CPR certified responder for ten years.', question);
    expect(over.blocking.map((c) => c.verdict)).toEqual(['overstated']);
  });

  it('pins the eleven months a bare certification year costs, both ends of the ledger', () => {
    // The price of reading "2023" as January, written down rather than left to be
    // rediscovered. A card actually earned in December 2023 has its span inflated by up to
    // eleven months, and FactGuard's rounding slack on top of that lets "four years" past on
    // a card three years and eight months old — a fabrication with a green tick beside it.
    // The trade is kept because the failure it prevents has no override anywhere in the
    // product while this one is flagged to G1 as `certifications.N.date` before anything is
    // sent, and because extractProfile is already told to make the same repair itself ("If
    // only a year is given, use YYYY-01"), so refusing it here would only make the profile
    // depend on whether the model obeyed. This test exists so that the size of the band is
    // visible: if it ever has to be narrowed, the middle of the year is NOT the answer,
    // because that shortens the span below the truth for a January card and blocks a true
    // sentence instead.
    const question = 'Tell us about your certifications.';
    const withDate = (date: string) =>
      draft({
        experience: [{ ...STORE, startDate: '2026-06', endDate: null }],
        certifications: [
          { name: 'CPR and First Aid Certification', issuer: 'American Red Cross', date },
        ],
      });
    const say = (n: string) => `I have served as a CPR certified responder for ${n}.`;

    const stated = withDate('2023');
    expect(stated.certifications[0]?.date).toBe('2023-01');
    expect(stated.needsReview).toContain('certifications.0.date');
    // Everything inside the band passes on the bare year and blocks once the real month is
    // on file. That difference IS the eleven months.
    for (const claim of ['three and a half years', 'four years']) {
      expect(guard(stated, say(claim), question).blocking, `2023 ${claim}`).toEqual([]);
    }
    const december = withDate('2023-12');
    expect(december.certifications[0]?.date).toBe('2023-12');
    expect(
      guard(december, say('four years'), question).blocking.map((c) => c.verdict),
      '2023-12 four years',
    ).toEqual(['overstated']);
    // And the reading the user is asked to confirm never runs the other way: January is the
    // earliest month the year allows, so no true sentence about the card is ever short.
    expect(guard(withDate('2023-01'), say('three years'), question).blocking).toEqual([]);
  });
});

/**
 * The header line, split into a city and a state the rest of the app can use.
 *
 * "Portland, OR 97214" is the ordinary way a US resume writes it, and splitting on the comma
 * alone put the whole of "OR 97214" in the region. That value does not just sit there:
 * `valueFor` in core/filling/plan.ts falls back to `locationPrefs.base.region` for a form's
 * State field, so a real application got "OR 97214" typed into a control that wanted "OR" —
 * a state no dropdown offers, asserted in the user's name on a screen with no state control
 * to correct it on.
 *
 * Both directions are pinned. Trimming harder than this is its own bug: "Brooklyn, New York"
 * and "Region 5, CA" have to come through untouched, and a part that is nothing BUT a
 * postcode is left where the user can see it rather than silently emptied.
 */
describe('a resume header that prints the postcode next to the state', () => {
  const base = (location: string) => draft({ location }).locationPrefs.base;

  it('keeps the state and drops the postcode printed beside it', () => {
    expect(base('Portland, OR 97214')).toMatchObject({ city: 'Portland', region: 'OR' });
    expect(base('Austin, TX 78701-1234')).toMatchObject({ city: 'Austin', region: 'TX' });
    expect(base('Toronto, ON M5V 3A8')).toMatchObject({ city: 'Toronto', region: 'ON' });
  });

  it('leaves a region alone that is not a state followed by a postcode', () => {
    expect(base('Columbus, OH').region).toBe('OH');
    expect(base('Brooklyn, New York').region).toBe('New York');
    expect(base('Region 5, CA').region).toBe('CA');
    // Nothing precedes it, so there is no state to keep — and emptying the box would throw
    // away the one thing the line did say. It stays, flagged, for the user to sort out.
    expect(base('Portland, 97214').region).toBe('97214');
  });

  /**
   * The reason this matters, asserted where the damage actually happened rather than only on
   * the parser. A guard on `splitLocation` alone would not notice if `valueFor` started
   * reading some other field.
   */
  it('so the State field of a form is offered a state', async () => {
    const { valueFor } = await import('../src/core/filling/plan');
    const profile = confirmed(draft({ location: 'Portland, OR 97214' }));
    const field = { semantic: 'region' } as never;
    expect(valueFor(field, profile as never)).toBe('OR');
  });
});
