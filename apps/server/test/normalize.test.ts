import { describe, expect, it } from 'vitest';
import { LINEAR_CEILING, measureGrowth } from './support/growth';
import {
  canonicalUrl,
  fingerprintTitle,
  normalizeCompany,
  normalizeTitle,
  parseCompensation,
  parseDurationWeeks,
  parseHybridDays,
  parsePositionType,
  parseRequirements,
  parseSeason,
  parseTermDates,
  parseWorkArrangement,
  parseYear,
} from '../src/core/discovery/normalize';
import { decodeEntities, stripHtml } from '../src/core/discovery/sources/types';

const NOW = new Date('2026-08-03T00:00:00Z');

describe('season and year', () => {
  it('reads season and year out of a title', () => {
    expect(parseSeason('Software Engineer Intern - Summer 2027')).toBe('summer');
    expect(parseYear('Software Engineer Intern - Summer 2027', NOW)).toBe(2027);
  });

  it('prefers the year adjacent to the season word', () => {
    // "founded in 2019" must not win over the actual term.
    expect(parseYear('Intern, Summer 2027 — a team founded in 2019', NOW)).toBe(2027);
  });

  it('handles a two-digit year', () => {
    expect(parseYear("Summer '27 Analyst", NOW)).toBe(2027);
  });

  it('returns null rather than guessing', () => {
    expect(parseSeason('Software Engineer')).toBeNull();
    expect(parseYear('Software Engineer', NOW)).toBeNull();
    // Out of a plausible hiring range.
    expect(parseYear('Copyright 2011 Acme', NOW)).toBeNull();
  });
});

describe('position type', () => {
  it('recognises the full range, not just "internship"', () => {
    expect(parsePositionType('Co-op Engineer')).toBe('co_op');
    expect(parsePositionType('Research Experience for Undergraduates (REU)')).toBe('research');
    expect(parsePositionType('Summer Analyst Fellowship')).toBe('fellowship');
    expect(parsePositionType('Software Apprentice')).toBe('apprenticeship');
    expect(parsePositionType('New Grad Software Engineer')).toBe('new_grad');
    expect(parsePositionType('Externship - 2 weeks')).toBe('externship');
    expect(parsePositionType('SWE Intern')).toBe('internship');
  });

  /**
   * "programme?" made the `?` bind to the final "e" alone, so the pattern matched the British
   * spelling and the typo "programm" and missed "Graduate Program" — which is how most of the
   * boards this reads from write it. A posting with no position type scores as a half-match on
   * type fit and reports no seniority explanation at all.
   */
  it('reads a programme and a program, and a new grad hyphenated or not', () => {
    expect(parsePositionType('Graduate Program 2027')).toBe('new_grad');
    expect(parsePositionType('Graduate Programme 2027')).toBe('new_grad');
    expect(parsePositionType('New-Grad Software Engineer')).toBe('new_grad');
    expect(parsePositionType('Rotational Program 2027')).toBe('trainee_program');
    expect(parsePositionType('Rotational Programme 2027')).toBe('trainee_program');
  });

  it('prefers the title over a passing mention in the body', () => {
    expect(
      parsePositionType('Co-op Software Engineer', 'Our internship program also exists.'),
    ).toBe('co_op');
  });

  it('falls back to the description when the title is uninformative', () => {
    expect(parsePositionType('Engineering, Students', 'This is a 12-week internship.')).toBe(
      'internship',
    );
  });

  it('returns null when nothing matches', () => {
    expect(parsePositionType('Staff Engineer', 'Lead a team.')).toBeNull();
  });
});

describe('work arrangement', () => {
  it('distinguishes the arrangements', () => {
    expect(parseWorkArrangement('This is a hybrid role')).toBe('hybrid');
    expect(parseWorkArrangement('Fully remote position')).toBe('remote');
    expect(parseWorkArrangement('On-site in Boston')).toBe('onsite');
  });

  it('catches geo-restricted remote', () => {
    expect(parseWorkArrangement('Fully remote — must reside in California')).toBe(
      'remote_geo_restricted',
    );
    expect(parseWorkArrangement('Fully remote. Open to residents of the EU only.')).toBe(
      'remote_geo_restricted',
    );
    expect(parseWorkArrangement('Fully remote, open only to US-based candidates.')).toBe(
      'remote_geo_restricted',
    );
  });

  /**
   * The geo test used to run `/(only|located in|based in)/` over the whole description, so
   * stating where the COMPANY sits — near-universal boilerplate — fenced a genuinely open
   * remote role. Eligibility then dropped its clean "Remote, which you accept." pass to
   * "unknown" and the queue badge asserted a restriction the posting never made. Only a
   * requirement on the applicant restricts them.
   */
  it('does not read a company location as a geographic restriction on a remote role', () => {
    for (const text of [
      'This internship is fully remote. Our company is based in Austin, TX.',
      'Fully remote internship. Our headquarters are located in Boston.',
      'This is a 100% remote role. The team is based in San Francisco.',
      'Fully remote — open to applicants anywhere in the US.',
    ]) {
      expect(parseWorkArrangement(text), text).toBe('remote');
    }
  });

  /**
   * Real postings phrase this a dozen ways, and every one of them used to come back
   * `remote`. For a student who has remote turned off that is a filtered-out posting with
   * the explanation "This posting is remote and you have remote turned off." — the literal
   * opposite of what the posting says — and for everyone else it is a row labelled
   * "Remote" with the stated city discarded.
   */
  /**
   * A claim about this role beats a mention of another one, whichever arrangement is
   * mentioned. The remote half of this was fixed first and the onsite half was not, so
   * "This role is onsite in Boston. Our hybrid teams meet on Wednesdays" still came back
   * hybrid — telling a student who can commute that a job in their own city was out of
   * reach, because a sentence about somebody else's team was ranked above the one about
   * theirs.
   */
  it('lets a claim about this role beat a passing mention of another', () => {
    const cases: Array<[string, string | null]> = [
      ['This internship is 100% remote. Our hybrid employees get a commuter benefit.', 'remote'],
      ['This role is onsite in Boston. Our hybrid teams meet on Wednesdays.', 'onsite'],
      ['You will work on-site five days a week. We also have hybrid roles elsewhere.', 'onsite'],
      ["You'll be based in the office. Some teams are hybrid.", 'onsite'],
    ];
    for (const [text, want] of cases) {
      expect(parseWorkArrangement(text), text).toBe(want);
    }
  });

  /** A bare mention is still worth something when nothing claims anything. */
  it('falls back to a bare mention only when no claim is made', () => {
    expect(parseWorkArrangement('Hybrid.')).toBe('hybrid');
    expect(parseWorkArrangement('This position is hybrid, three days a week in office.')).toBe(
      'hybrid',
    );
  });

  it('does not read a negation as remote, however it is worded', () => {
    for (const text of [
      'This role is not remote.',
      'no remote work',
      'Remote work is not available for this position',
      'Remote work is not offered.',
      'We do not offer remote work for this internship.',
      'This is an in-office role. Remote work is not available.',
      'Please note: remote work is not permitted.',
      'This position is not eligible for remote work.',
      'Candidates must work on-site; we are unable to accommodate remote arrangements.',
      'This role is 100% onsite in our New York office. This is not a remote internship.',
      'This is not a fully remote role; you will be in office 5 days',
    ]) {
      expect(parseWorkArrangement(text), text).toBe('onsite');
    }
  });

  /** "hybrid" appearing inside the list of things on offer is not an offer of hybrid. */
  it('does not read a negation as hybrid', () => {
    expect(parseWorkArrangement('No remote or hybrid options are available.')).toBe('onsite');
  });

  /**
   * The negation window stops at clause punctuation, so a "not" about something else in a
   * later sentence cannot cost a genuinely remote posting its arrangement.
   */
  it('does not let an unrelated negation cancel a real remote offer', () => {
    expect(parseWorkArrangement('Fully remote. You will not be required to relocate.')).toBe(
      'remote',
    );
    expect(parseWorkArrangement('This role is remote and is not restricted to any state.')).toBe(
      'remote',
    );
    expect(parseWorkArrangement('This is a hybrid role, not a remote one.')).toBe('hybrid');
  });

  /**
   * The hybrid branch used to run first on the bare word, so one "hybrid" anywhere in the text
   * beat an explicit "100% remote". The word turns up in benefits paragraphs, in culture prose
   * about other teams, and in comparisons — and a student with hybrid turned off, which is the
   * ordinary setting for someone who cannot commute, was told the posting was hybrid and never
   * saw a job that was open to them.
   */
  it('does not let a passing mention of hybrid beat an explicit remote offer', () => {
    for (const text of [
      'This internship is 100% remote. Our hybrid employees receive a commuter benefit.',
      'This role is fully remote. Other teams at the company work a hybrid schedule.',
      'Unlike our hybrid roles, this position is fully remote.',
      'Remote-first internship. We reimburse coworking space for hybrid staff.',
    ]) {
      expect(parseWorkArrangement(text), text).toBe('remote');
    }
  });

  /** A hybrid claim about THIS job still wins; only the passing mention loses. */
  it('keeps hybrid when the posting says the role itself is hybrid', () => {
    expect(parseWorkArrangement('This position is hybrid, 3 days a week onsite.')).toBe('hybrid');
    expect(parseWorkArrangement('Hybrid: 2 days a week in the office.')).toBe('hybrid');
  });

  /**
   * A description that states two arrangements is describing two jobs, and neither answer is
   * true of the one in front of the user. Unknown shows a badge; picking one filters the
   * posting out of somebody's queue with a confident sentence about it.
   */
  it('answers unknown when the text states two arrangements for two roles', () => {
    expect(
      parseWorkArrangement(
        'We are hiring two interns: one role is hybrid with 3 days onsite, and one is 100% remote.',
      ),
    ).toBeNull();
    expect(
      parseWorkArrangement('This position is onsite in Austin; the other opening is 100% remote.'),
    ).toBeNull();
  });

  /**
   * The negation used to be any "no"/"not" within forty characters of the word, which is a
   * rule about distance rather than meaning. Each of these is a genuinely remote posting that
   * came back `onsite`: labelled with the opposite of what it says, ranked lower for it, and
   * shown with a sentence about commuting from the user's home city.
   */
  it('does not read an unrelated negation in the same sentence as a denial of remote', () => {
    for (const text of [
      'This is a fully remote internship. No relocation support for this remote position.',
      'We do not have an office - this is a remote position.',
      'This is a remote role. There is no fixed schedule for remote team members.',
      'This is a remote role. There is no dress code for remote employees.',
    ]) {
      expect(parseWorkArrangement(text), text).toBe('remote');
    }
  });

  /**
   * The same rule has to hold for the other direction, because a posting wrongly labelled
   * remote is filtered out of the queue of everyone who has remote turned off — with the
   * sentence "This posting is remote and you have remote turned off." on a job in their city.
   */
  it('does not let a passing mention of remote beat an explicit onsite role', () => {
    expect(
      parseWorkArrangement('This position is onsite in Austin. Some remote work may be possible.'),
    ).toBe('onsite');
    expect(parseWorkArrangement('This role is 100% on-site. Our recruiters work remote.')).toBe(
      'onsite',
    );
  });

  /**
   * The two denial lists were written out separately and drifted: hybrid never learned the
   * "unavailable" spelling remote knew, so a posting saying hybrid was unavailable was read as
   * an offer of hybrid. They are built from one template now, and both spellings have to work
   * for both words.
   */
  it('denies hybrid in every wording it denies remote', () => {
    expect(parseWorkArrangement('Hybrid work is unavailable for this position.')).not.toBe(
      'hybrid',
    );
    expect(parseWorkArrangement('We do not offer hybrid schedules for interns.')).not.toBe(
      'hybrid',
    );
    expect(parseWorkArrangement('This role is on-site. Hybrid work is unavailable.')).toBe(
      'onsite',
    );
    expect(parseWorkArrangement('Remote work is unavailable for this position.')).toBe('onsite');
  });

  /**
   * The location word is written on either side of the count, and the pattern only read one of
   * them — so a posting parseWorkArrangement called hybrid had no number saying how much
   * commuting that meant. The bare "in" it used to accept for "in office" matched the "in"
   * inside "internship", which turned a full-time job into five days of commuting.
   */
  it('reads hybrid days whichever side the office is written on', () => {
    expect(parseHybridDays('3 days per week in office')).toBe(3);
    expect(parseHybridDays('3 days onsite per week.')).toBe(3);
    expect(parseHybridDays('Hybrid: 3 days in office per week.')).toBe(3);
    expect(parseHybridDays('Hybrid: 2 days a week onsite.')).toBe(2);
    expect(parseHybridDays('Employees are in the office 4 days per week.')).toBe(4);
    expect(parseHybridDays('hybrid role')).toBeNull();
    expect(parseHybridDays('This is a 5 days a week internship.')).toBeNull();
  });

  /**
   * Widening the count-to-"per week" gap let "2 days working from home per week" match, and
   * with "in the office" in the same clause the onsite test passed on it — so two REMOTE days
   * were recorded as the onsite count and a role onsite three days read as onsite two, the
   * flattering direction the field is meant never to invent. A count whose own words say
   * from-home is not an onsite count.
   */
  it('does not record work-from-home days as onsite days', () => {
    expect(
      parseHybridDays(
        'Employees work in the office, with 2 days working from home per week permitted.',
      ),
    ).toBeNull();
    expect(
      parseHybridDays('You will be in the office except 2 days working from home per week.'),
    ).toBeNull();
    expect(parseHybridDays('2 days remote per week.')).toBeNull();
  });
});

describe('term dates and duration', () => {
  it('parses an explicit window', () => {
    expect(parseTermDates('Runs June 2027 - August 2027')).toEqual({
      start: '2027-06',
      end: '2027-08',
    });
  });

  /**
   * The first "<month> <year> to <month> <year>" in the text used to become the term whatever
   * introduced it — and a posting dates far more than the job.
   *
   * "Summer 2027 Software Engineering Internship. Applications open March 2027 to June 2027 and
   * are reviewed on a rolling basis." was stored as a term of 2027-03..2027-06. Those months
   * overlap the Summer 2027 season window, so `deriveTermWindow` counted them as corroborated —
   * an EXACT window, the only kind term_overlap is allowed to reject on — and a student free
   * 2027-06-01 to 2027-08-20, who could have taken that internship outright, was hard-failed
   * with "Overlaps your availability by only about 4.2 weeks; 6 are needed." docs/05 says an
   * inferred window may raise a question and never hard-fail anyone.
   *
   * The application window is only the reported shape. The hiring calendar is written a dozen
   * ways and every one of them reads to the old parser as the term.
   */
  it('does not read the hiring calendar as the term the job runs', () => {
    for (const text of [
      'Summer 2027 Software Engineering Internship. Applications open March 2027 to June 2027.',
      'Applications are accepted from September 2026 through November 2026 for our Summer 2027 program.',
      'Application window: September 2026 - November 2026. Summer 2027 internship.',
      'Applications for this role are open March 2027 to June 2027.',
      'Apply between September 2026 and November 2026 for the Summer 2027 cohort.',
      'We accept applications on a rolling basis from October 2026 until January 2027.',
      'The review period runs January 2027 to March 2027.',
      'Interviews take place October 2026 to December 2026 for the Summer 2027 cohort.',
      'Decisions will be sent March 2027 through May 2027.',
      'Offers are extended November 2026 through January 2027.',
      'Shortlisted candidates are contacted October 2026 to November 2026.',
      'You will be notified February 2027 through April 2027.',
      // The windows a posting dates that are not the hiring calendar either. These are the
      // same words parseDurationWeeks already refuses to read as the length of the job, and
      // the two lists are built from one source so they cannot drift apart again.
      'Onboarding runs May 2027 to June 2027.',
      'There is a probation period from June 2027 to August 2027.',
    ]) {
      expect(parseTermDates(text), text).toBeNull();
    }
  });

  /** The guard has to leave a real term alone, however the posting introduces it. */
  it('still reads a term the posting states as its own dates for the job', () => {
    const cases: Array<[string, { start: string; end: string }]> = [
      ['The internship runs June 2027 through August 2027.', { start: '2027-06', end: '2027-08' }],
      ['Program dates: June 2027 – August 2027.', { start: '2027-06', end: '2027-08' }],
      ['This co-op runs from January 2027 until June 2027.', { start: '2027-01', end: '2027-06' }],
      ['Summer 2027 (June 2027 - August 2027)', { start: '2027-06', end: '2027-08' }],
      ['You will work June 2027 to August 2027, full-time.', { start: '2027-06', end: '2027-08' }],
      [
        'Our fellowship is scheduled for Sept. 2026 - Dec. 2026.',
        { start: '2026-09', end: '2026-12' },
      ],
      [
        'June 2027 - August 2027 internship, 40 hours per week.',
        { start: '2027-06', end: '2027-08' },
      ],
    ];
    for (const [text, want] of cases) {
      expect(parseTermDates(text), text).toEqual(want);
    }
  });

  /**
   * Both halves of the guard, on one posting: the application window loses and the term two
   * sentences later still wins. The old parser stopped at the first range it found, so a
   * posting that states its hiring calendar before its dates — the ordinary ordering — never
   * got as far as the sentence that answers the question.
   */
  it('keeps looking past a range that is not the term', () => {
    expect(
      parseTermDates(
        'Applications are reviewed on a rolling basis from October 2026 until January 2027. ' +
          'The internship runs June 2027 to August 2027.',
      ),
    ).toEqual({ start: '2027-06', end: '2027-08' });
    // Same loop, second bug: a first match whose words are not months used to abandon the
    // search outright. "Fall 2026 to Spring 2027" matches the range pattern and resolves to no
    // months at all, so a co-op that then spells its dates out was stored with no term.
    expect(
      parseTermDates(
        'This co-op runs Fall 2026 to Spring 2027 — September 2026 through April 2027.',
      ),
    ).toEqual({ start: '2026-09', end: '2027-04' });
  });

  /**
   * An unlabelled range is exactly the one that cannot be told from an application window, and
   * the consumer of this field can hard-fail on it. Saying nothing costs the posting its exact
   * dates and leaves the season-and-year window, which can raise a question and never rejects.
   */
  it('says nothing rather than guess when a range has no context at all', () => {
    expect(parseTermDates('June 2027 - August 2027')).toBeNull();
    expect(parseTermDates('Acme Corp. September 2026 – December 2026. New York, NY.')).toBeNull();
  });

  it('parses weeks and months', () => {
    expect(parseDurationWeeks('a 12 week internship')).toBe(12);
    expect(parseDurationWeeks('10-12 weeks')).toBe(11);
    expect(parseDurationWeeks('6 month co-op')).toBe(26);
  });

  /**
   * The first week figure in the text used to win outright, so a posting that mentions its
   * leave policy, its onboarding or its application deadline before its own length was stored
   * as a two-week internship. Nothing filters on the field yet; the day a "at least 8 weeks"
   * filter is switched on, those are the postings that vanish.
   */
  it('takes the length of the job, not the first span of time in the text', () => {
    expect(
      parseDurationWeeks(
        'Interns receive 2 weeks of paid time off. The program runs 12 weeks over the summer.',
      ),
    ).toBe(12);
    expect(parseDurationWeeks('Our onboarding takes 1 week. This is a 12 week internship.')).toBe(
      12,
    );
    expect(parseDurationWeeks('Applications close in 2 weeks. The internship runs 12 weeks.')).toBe(
      12,
    );
    expect(parseDurationWeeks('The internship is 12 weeks long.')).toBe(12);
  });

  /**
   * When the ONLY figure in the text is one the clause scores as not-the-term — a reply
   * window, a leave policy, a probation period — the sort still handed it back, so a posting
   * that says "hear back within 2 weeks" was stored as a two-week internship. A negatively
   * scored span is the text saying "this is not the length"; the parser says null rather than
   * record a duration the posting denies.
   */
  it('returns null when the only span is scored as not-the-term', () => {
    expect(parseDurationWeeks('You will hear back within 2 weeks.')).toBeNull();
    expect(
      parseDurationWeeks('Applications close in 2 weeks. We look forward to hearing from you.'),
    ).toBeNull();
    expect(parseDurationWeeks('Benefits include 3 weeks of vacation.')).toBeNull();
    expect(parseDurationWeeks('There is a 3 month probation period.')).toBeNull();
  });
});

describe('compensation', () => {
  it('reads hourly ranges', () => {
    expect(parseCompensation('$25 - $35 per hour')).toMatchObject({
      min: 25,
      max: 35,
      period: 'hour',
    });
  });

  it('marks unpaid and credit-only explicitly', () => {
    expect(parseCompensation('This is an unpaid internship')).toMatchObject({ unpaid: true });
    expect(parseCompensation('Offered for academic credit only')).toMatchObject({
      academicCreditOnly: true,
    });
  });

  it('infers a period from magnitude when the unit is missing', () => {
    expect(parseCompensation('$30')).toMatchObject({ period: 'hour' });
    expect(parseCompensation('$95,000')).toMatchObject({ period: 'year' });
  });

  /** Silence about pay is not a claim of unpaid — see the filter rules in docs/05. */
  it('returns null when pay is simply not mentioned', () => {
    expect(parseCompensation('Great team, great mission.')).toBeNull();
  });

  /**
   * The word "unpaid" used to decide the pay on its own, ahead of every other check. It fires
   * on benefits boilerplate that a large share of US postings carry, and each hit scored the
   * posting 0.1 on pay and told the user "the pay is low or unpaid" about a job paying $45
   * an hour.
   */
  it('does not read unpaid leave, or a denial of unpaid work, as an unpaid internship', () => {
    for (const text of [
      'Software Engineering Intern. Pay: $45/hour. Benefits include paid and unpaid leave options.',
      'Interns are paid $50 per hour. We also support unpaid volunteer days.',
      'This internship pays $38/hour. Note: we never ask interns to work unpaid overtime.',
      'Compensation: $42/hour. Unpaid time off may be requested with manager approval.',
      'This is not an unpaid internship; interns are paid $30/hour.',
      'Unlike unpaid internships, ours pays $45 per hour.',
    ]) {
      expect(parseCompensation(text), text).not.toMatchObject({ unpaid: true });
      expect(parseCompensation(text)?.period, text).toBe('hour');
    }
  });

  /** A posting that really is unpaid still says so, and a stray dollar figure does not undo it. */
  it('still reads a genuinely unpaid internship', () => {
    expect(parseCompensation('This is an unpaid internship')).toMatchObject({ unpaid: true });
    expect(
      parseCompensation('This is an unpaid internship. Transportation is reimbursed up to $200.'),
    ).toMatchObject({ unpaid: true });
  });
});

describe('application demands', () => {
  /**
   * Every key spelled its own negation rule and each got it wrong in its own direction: a
   * posting saying it does not want a cover letter was recorded as demanding one, and the
   * commonest way of asking for references — "a cover letter and two references" — was
   * recorded as not asking for them.
   */
  it('reads a demand and a release of one, in either wording', () => {
    expect(parseRequirements('A cover letter is not required.')).toMatchObject({
      coverLetter: false,
    });
    expect(parseRequirements('A cover letter is not necessary.')).toMatchObject({
      coverLetter: false,
    });
    expect(parseRequirements('No cover letter needed.')).toMatchObject({ coverLetter: false });
    expect(parseRequirements('Cover letter optional.')).toMatchObject({ coverLetter: false });
    expect(parseRequirements('References are not required at this stage.')).toMatchObject({
      references: false,
    });
    expect(parseRequirements('Please submit a cover letter and two references.')).toMatchObject({
      coverLetter: true,
      references: true,
    });
    expect(parseRequirements('An unofficial transcript is required.')).toMatchObject({
      transcript: true,
    });
    expect(parseRequirements('A transcript is not required.')).toMatchObject({ transcript: false });
  });

  /**
   * The firm-portfolio release fired on a bare "of their/the", which is exactly how an
   * applicant is asked for their own work in the third person — "a portfolio of their work",
   * "a portfolio of the work you are proud of". The commonest genuine demand was read as no
   * demand, and the user was never warned. A firm noun has to follow for the release to hold.
   */
  it('reads a portfolio demand written in the third person, and still ignores a firm portfolio', () => {
    for (const text of [
      'The ideal candidate will provide a portfolio of their work.',
      'Applicants must include a portfolio of their best work.',
      'Please include a portfolio of the work you are most proud of.',
      'Please include a portfolio of your work.',
    ]) {
      expect(parseRequirements(text), text).toMatchObject({ portfolio: true });
    }
    for (const text of [
      'You will support our portfolio companies.',
      'Work with the portfolio manager on live deals.',
      'Analysts review a portfolio of our clients each quarter.',
    ]) {
      expect(parseRequirements(text), text).toMatchObject({ portfolio: false });
    }
  });
});

describe('identity normalisation', () => {
  it('strips tracking params and normalises the host', () => {
    expect(canonicalUrl('https://WWW.Example.com/jobs/1?utm_source=x&gh_src=y&b=2#top')).toBe(
      'https://example.com/jobs/1?b=2',
    );
  });

  it('collapses title noise so the same req matches', () => {
    expect(normalizeTitle('Software Engineer Intern (Summer 2027) - Req #12345')).toBe(
      'software engineer intern',
    );
    expect(normalizeTitle('Software Engineer II')).toBe('software engineer');
  });

  /**
   * On a Greenhouse board the team name in brackets is often the only difference between
   * two separate requisitions. Deleting it made them the same title, dedupe treated the
   * second as a copy, and the user never saw that the other opening existed.
   */
  it('keeps a bracketed team name, because it is what tells two openings apart', () => {
    expect(normalizeTitle('Software Engineer Intern (Backend)')).not.toBe(
      normalizeTitle('Software Engineer Intern (Frontend)'),
    );
    expect(normalizeTitle('Research Intern [Ads]')).not.toBe(
      normalizeTitle('Research Intern [Payments]'),
    );
    expect(normalizeTitle('Software Engineer Intern (Backend)')).toBe(
      'software engineer intern backend',
    );
  });

  /**
   * The dedupe fingerprint merges on this key alone, so it has to hold on to every token
   * that could mean a second opening — a level, or a term. A Summer and a Fall requisition
   * merging is not just a lost row: the survivor is the Summer one, and a student who is
   * only free in the fall is then told they are ineligible for a job that was open to them.
   */
  it('keeps levels and terms in the identity form, which stage-2 dedupe merges on', () => {
    expect(fingerprintTitle('Machine Learning Intern I')).not.toBe(
      fingerprintTitle('Machine Learning Intern II'),
    );
    expect(fingerprintTitle('Software Engineer Intern - Summer 2026')).not.toBe(
      fingerprintTitle('Software Engineer Intern - Fall 2026'),
    );
    expect(fingerprintTitle('Software Engineer Intern (Backend)')).not.toBe(
      fingerprintTitle('Software Engineer Intern (Frontend)'),
    );
  });

  /**
   * Boards write the term inside brackets at least as often as after a dash, so a rule that
   * only protects the dashed form protects the rarer half. "(Summer 2026)" and "(Fall 2026)"
   * are two openings a year apart, and "(II)" and "(III)" are two levels.
   */
  it('keeps a level or a term that is written inside the brackets', () => {
    expect(fingerprintTitle('Software Engineer Intern (Summer 2026)')).not.toBe(
      fingerprintTitle('Software Engineer Intern (Fall 2026)'),
    );
    expect(fingerprintTitle('Data Science Intern [Summer 2026]')).not.toBe(
      fingerprintTitle('Data Science Intern [Summer 2027]'),
    );
    expect(fingerprintTitle('Software Engineer Intern (II)')).not.toBe(
      fingerprintTitle('Software Engineer Intern (III)'),
    );
    expect(fingerprintTitle('Software Engineer Intern (Summer 2026)')).toBe(
      'software engineer intern summer 2026',
    );
  });

  /**
   * A requisition id is the one part of a title that belongs to the listing rather than to
   * the job, so it is the only thing the identity form is allowed to throw away — otherwise
   * one board's "Req #9931" would be enough to make the same opening look like two.
   */
  it('still drops requisition ids from the identity form, bracketed or not', () => {
    expect(fingerprintTitle('Software Engineer Intern - Req #9931')).toBe(
      'software engineer intern',
    );
    expect(fingerprintTitle('Software Engineer Intern (Req #9931)')).toBe(
      'software engineer intern',
    );
    expect(fingerprintTitle('Software Engineer Intern (Job ID 4471)')).toBe(
      'software engineer intern',
    );
  });

  /**
   * Two boards spelling one job differently are a different source by definition, so the
   * pair that has to collapse is stage 3's problem, and stage 3 uses the aggressive form.
   */
  it('collapses two spellings of one job in the token-matching form', () => {
    expect(normalizeTitle('Software Engineer Intern (Summer 2027)')).toBe(
      normalizeTitle('Software Engineer Intern - Req #9931'),
    );
  });

  it('collapses company suffixes', () => {
    expect(normalizeCompany('Acme, Inc.')).toBe('acme');
    expect(normalizeCompany('ACME LLC')).toBe('acme');
  });
});

describe('reading HTML out of a feed', () => {
  /**
   * What the two helpers do when they are composed in this order, which is all this can
   * check: the order is written here in the test body, so it is `decodeEntities` and
   * `stripHtml` under test and not the caller that has to get the order right. The
   * Greenhouse adapter's own ordering is pinned in sources.test.ts, where the adapter is
   * actually driven.
   */
  /**
   * A page that is one long run of `<` used to freeze the server for as long as it took.
   *
   * `/<[^>]+>/g` backtracked: at every `<` it ran to the end of the input looking for a `>`,
   * failed, and gave back a character at a time. Measured before the rewrite — 10 KB of `<`
   * took 61ms, 20 KB 221ms, 40 KB 909ms and 80 KB EIGHTEEN SECONDS. This is pointed at whatever
   * a fetch returned, Node is single-threaded, and no timeout can fire to end it because a
   * timeout needs the event loop too.
   *
   * The assertion is on the SHAPE of the curve rather than a stopwatch reading, because a
   * wall-clock bound fails on a busy machine for reasons that have nothing to do with the bug.
   * Four times the input costs about four times as much when the work is linear and about
   * sixteen when it is quadratic; load slows both measurements equally, so the ratio holds.
   *
   * THE SIZES ARE CHOSEN TO MEASURE THE ALGORITHM AND NOT THE ALLOCATOR. Measured across five
   * doublings, this is a clean x2.00 per doubling up to about three megabytes and then bends
   * upward — x3.4 at 4.6MB — because at that size the cost is dominated by allocating and
   * collecting multi-megabyte strings rather than by the scan. The first version of this test
   * used a 4.8MB large case and failed at a ratio of 8.3 against a threshold of 8, which was
   * true of the measurement and false of the code. Both cases now sit inside the linear region.
   */
  it('costs about four times as much for four times the markup, not sixteen', () => {
    for (const [name, unit] of [
      ['bare <', '<'],
      ['unterminated <script', '<script'],
      ['unterminated <style', '<style'],
      ['repeated <meta ', '<meta '],
      ['repeated <p', '<p'],
    ] as const) {
      const growth = measureGrowth(
        (multiplier, salt) => salt + unit.repeat(50_000 * multiplier),
        (html) => stripHtml(html),
      );
      expect(
        growth.ratio,
        `${name}: ${growth.small.toFixed(1)}ms -> ${growth.large.toFixed(1)}ms`,
      ).toBeLessThan(LINEAR_CEILING);
    }
  }, 120_000);

  it('still gets through a megabyte of it at all', () => {
    // The ratio above would also be satisfied by a function that got fast by giving up.
    expect(stripHtml(`<p>Real text</p>${'<'.repeat(1024 * 1024)}`)).toContain('Real text');
  }, 60_000);

  /**
   * The passes have to stay in this order and stay separate.
   *
   * A first attempt at the rewrite folded them into one scan, and 1,150 of 20,000 generated
   * documents came out different. Removing `<br>` BEFORE the general tag pass is what stops a
   * stray `<` swallowing it — otherwise the general pass reads `< b<br/` as a single tag and
   * takes the line break with it.
   */
  it('keeps the parts of a document a stray angle bracket used to be able to eat', () => {
    expect(stripHtml('a < b<br/>')).toBe('a < b');
    expect(stripHtml('trailing <')).toBe('trailing <');
    expect(stripHtml('<unclosed')).toBe('<unclosed');
    // `<>` is not a tag: the old pattern needed at least one character between the brackets.
    expect(stripHtml('a<>b')).toBe('a<>b');
    /**
     * AN OPENER WITH NO CLOSER TAKES ITS CONTENTS WITH IT.
     *
     * This used to assert the opposite — an unclosed opener "is left where it was found,
     * markup and all" — and that was the bug, not the rule. A page whose script tag is never
     * closed leaked its JavaScript source into description_text, and a string inside it
     * ("Applicants must be U.S. citizens.") was then read by the deterministic requirement
     * pass as a real citizenship rule and hard-failed every non-citizen: a false ineligible
     * built out of somebody's tracking script. Unclosed markup is malformed either way, and
     * dropping to the end of the document is the reading that cannot invent a requirement.
     */
    expect(stripHtml('<style>.a{color:red}')).toBe('');
    expect(stripHtml('<style>.a{color:red}</style>x')).toBe('x');
    expect(stripHtml('<p>Real text</p><script>var a = "Applicants must be U.S. citizens."')).toBe(
      'Real text',
    );
    // Case is ignored.
    expect(stripHtml('<SCRIPT>x</SCRIPT>y')).toBe('y');
    // `<scriptural>` is its own tag and no longer opens a script span: the pattern this
    // replaced had no word boundary, so an ordinary word starting with "script" swallowed
    // everything after it. Prose that merely says "script" is untouched.
    expect(stripHtml('a<scriptural>b</script>c')).toBe('a b c');
    expect(stripHtml('<p>Keep this</p><p>and this script word</p>')).toMatch(/script word/);
  });

  it('an escaped document decoded first has no markup left after stripping', () => {
    const escaped =
      '&lt;p&gt;About the role&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Python&lt;/li&gt;&lt;/ul&gt;';
    const text = stripHtml(decodeEntities(escaped));
    expect(text).not.toMatch(/<[a-z]/i);
    expect(text).toMatch(/About the role/);
    expect(text).toMatch(/Python/);
  });

  it('leaves an already-plain document alone', () => {
    expect(stripHtml(decodeEntities('<p>About the role</p>'))).toBe('About the role');
  });

  it('decodes the ampersand last, so an escaped entity does not become a tag', () => {
    expect(decodeEntities('&amp;lt;script&amp;gt;')).toBe('&lt;script&gt;');
  });

  it('handles the quotes and apostrophes a job description is full of', () => {
    expect(decodeEntities('We&#39;re hiring &quot;interns&quot; &amp; grads')).toBe(
      'We\'re hiring "interns" & grads',
    );
  });
});

/**
 * Money that is not written in dollars, and money written the way an ATS abbreviates it.
 *
 * The regex opened on `\$` and nothing else, so "£25 per hour" and "€2,000 per month" both
 * came back null and the posting entered the queue as pay not disclosed. That is not an edge
 * case — Ashby hands back GBP and SEK on an ordinary board. The fractional part was
 * `\.\d{2}`, exactly two places or none, which is the one shape these boards never use for a
 * range: "$211.4K – $290.6K a year" matched only "$211", the K fell outside the match, and a
 * posting paying two hundred thousand a year was stored as $211 a MONTH.
 */
describe('parseCompensation, beyond the dollar sign', () => {
  it('reads the symbols other currencies are written with', () => {
    expect(parseCompensation('The rate is £25 per hour.')).toMatchObject({
      min: 25,
      currency: 'GBP',
      period: 'hour',
    });
    expect(parseCompensation('A stipend of €2,000 per month.')).toMatchObject({
      min: 2000,
      currency: 'EUR',
      period: 'month',
    });
  });

  it('reads no currency whose magnitudes the period guess is not calibrated for', () => {
    // ¥ and ₹ were added here on a guess and taken out again on evidence. With no stated
    // period the parser infers one from magnitude — under 200 hourly, under 20,000 monthly —
    // which holds for dollars, pounds and euros and not remotely for yen: an ordinary
    // ¥1,200 hourly wage came out as ¥1,200 a MONTH and ¥280,000 a month as a yearly salary.
    // Reading a figure and labelling its period wrong is worse than not reading it.
    expect(parseCompensation('Hourly wage: ¥1,200.')).toBeNull();
    expect(parseCompensation('₹40,000 per month')).toBeNull();
  });

  it('reads a figure written in the European convention', () => {
    // The separators are the other way round on the continent, and these strings were
    // unmatchable until £/€ were added — so the widening turned "no reading" into a wrong
    // one 1000x out, on the figure a student decides against a posting with.
    expect(parseCompensation('Internship allowance of €2.000 per month.')).toMatchObject({
      min: 2000,
      period: 'month',
    });
    expect(parseCompensation('You will earn €9,50 per hour.')).toMatchObject({
      min: 9.5,
      period: 'hour',
    });
    expect(parseCompensation('Salary: €3.000 - €3.500 per month.')).toMatchObject({
      min: 3000,
      max: 3500,
    });
  });

  it('still reads the US convention, which shares every separator', () => {
    expect(parseCompensation('Pays $1,200 per week.')).toMatchObject({ min: 1200 });
    expect(parseCompensation('Pays $1,234.56 per week.')).toMatchObject({ min: 1234.56 });
  });

  it('does not read a perk quoted in money as the wage', () => {
    // A benefits section is full of figures. Widening to £/€ imported the whole problem into
    // the postings whose real pay the parser previously could not read at all — and the
    // tie-break went to whichever came first in the text, so a learning budget beat a wage.
    expect(parseCompensation('Everyone gets £1,000 a year to spend on learning.')).toBeNull();
    expect(parseCompensation('€50 monthly wellness allowance')).toBeNull();
    expect(
      parseCompensation('Perks: £1,000 a year for learning. You will receive £11.44 per hour.'),
    ).toMatchObject({ min: 11.44, period: 'hour' });
  });

  it('still reads a dollar, and still reads which dollar', () => {
    expect(parseCompensation('Pays $30/hour.')).toMatchObject({ min: 30, currency: 'USD' });
    expect(parseCompensation('Pays CA$30/hour.')).toMatchObject({ min: 30, currency: 'CAD' });
  });

  it('reads an abbreviated range with one decimal place', () => {
    // Stored as $211 a month before, in the pane where someone decides whether to apply.
    expect(parseCompensation('Salary range: $211.4K – $290.6K a year')).toMatchObject({
      min: 211_400,
      max: 290_600,
      period: 'year',
      currency: 'USD',
    });
  });

  it('keeps the cents on a figure that has them', () => {
    expect(parseCompensation('Pays $22.50 per hour.')).toMatchObject({ min: 22.5 });
  });
});
