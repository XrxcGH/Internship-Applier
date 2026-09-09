/**
 * Field classification. Deterministic stage only — no model runs here.
 *
 * The interesting assertions are the ones about ORDER and about refusing to guess. A rule
 * table is easy to write and easy to get subtly wrong: "name" swallows "school name",
 * "state" swallows nothing until someone adds a "current state of employment" field, and
 * a default of `text` would quietly type a phone number into whatever came last.
 */
import { describe, expect, it } from 'vitest';
import { classifyField, isActionable, CONFIDENCE_FLOOR } from '../src/core/filling/classify';

const of = (label: string, extra = {}) => classifyField({ label, ...extra });

describe('recognizes ordinary fields', () => {
  const CASES: Array<[string, string]> = [
    ['First name', 'first_name'],
    ['Given name', 'first_name'],
    ['Last name', 'last_name'],
    ['Surname', 'last_name'],
    ['Full legal name', 'full_name'],
    ['Email address', 'email'],
    ['Mobile phone', 'phone'],
    ['Street address', 'address_line1'],
    ['City', 'city'],
    ['State / Province', 'region'],
    ['Zip code', 'postal'],
    ['Country', 'country'],
    ['LinkedIn profile', 'linkedin'],
    ['GitHub URL', 'github'],
    ['Portfolio', 'portfolio'],
    ['Personal website', 'portfolio'],
    ['University', 'school'],
    ['Degree', 'degree'],
    ['Field of study', 'major'],
    ['GPA', 'gpa'],
    ['Expected graduation date', 'graduation_date'],
    ['Are you currently enrolled?', 'enrollment_status'],
    ['Are you legally authorized to work in the US?', 'work_auth'],
    ['Will you require sponsorship?', 'sponsorship_needed'],
    ['Upload your resume', 'resume_upload'],
    ['Cover letter', 'cover_letter_upload'],
    ['Official transcript', 'transcript_upload'],
    ['Earliest start date', 'start_date'],
    ['Hours per week', 'hours_available'],
    ['Salary expectation', 'salary_expectation'],
    ['How did you hear about us?', 'referral_source'],
  ];

  for (const [label, semantic] of CASES) {
    it(`reads "${label}" as ${semantic}`, () => {
      const c = of(label);
      expect(c.semantic, label).toBe(semantic);
      expect(c.confidence, label).toBeGreaterThanOrEqual(CONFIDENCE_FLOOR);
    });
  }
});

describe('rule ordering', () => {
  it('does not let the generic name rule swallow the specific ones', () => {
    expect(of('First name').semantic).toBe('first_name');
    expect(of('Last name').semantic).toBe('last_name');
    // A school field mentioning "name" must stay a school.
    expect(of('School name').semantic).toBe('school');
    expect(of('University name').semantic).toBe('school');
  });

  it('prefers sponsorship over the broader work-authorization rule', () => {
    // "Will you require sponsorship for employment visa status?" contains both ideas.
    expect(of('Will you now or in the future require sponsorship?').semantic).toBe(
      'sponsorship_needed',
    );
    expect(of('Are you legally authorized to work?').semantic).toBe('work_auth');
  });

  it('prefers a specific link host over the generic website rule', () => {
    expect(of('LinkedIn URL').semantic).toBe('linkedin');
    expect(of('GitHub website').semantic).toBe('github');
    expect(of('Other website').semantic).toBe('website');
  });

  it('reads transcript as an upload rather than a school field', () => {
    expect(of('Upload your transcript').semantic).toBe('transcript_upload');
  });
});

describe('the autocomplete attribute wins', () => {
  it('is trusted over a misleading label', () => {
    // The form declared what this is. That beats prose.
    const c = classifyField({ label: 'Name', autocomplete: 'family-name' });
    expect(c.semantic).toBe('last_name');
    expect(c.via).toBe('autocomplete');
    expect(c.confidence).toBeGreaterThan(0.95);
  });

  it('ignores tokens whose meaning is ambiguous on an application', () => {
    // `organization` could be the current employer or the school. Guessing between them
    // is exactly the mistake worth not making, so it falls through to the rules.
    const c = classifyField({ label: 'University', autocomplete: 'organization' });
    expect(c.semantic).toBe('school');
    expect(c.via).toBe('rule');
  });
});

describe('refusal outranks recognition', () => {
  it('classifies a redline as REDLINE even when it looks fillable', () => {
    const c = of('Social Security Number');
    expect(c.semantic).toBe('REDLINE');
    expect(c.via).toBe('redline');
    expect(isActionable(c)).toBe(false);
  });

  it('refuses a password field whatever its label claims', () => {
    const c = classifyField({ label: 'Email', type: 'password' });
    expect(c.semantic).toBe('REDLINE');
  });

  it('does not let a placeholder alone unlock a sensitive field', () => {
    // A placeholder is a weak signal, so it is excluded from the redline haystack. The
    // label and name still catch this one.
    const c = classifyField({ label: 'Identifier', name: 'ssn', placeholder: 'e.g. 123-45-6789' });
    expect(c.semantic).toBe('REDLINE');
  });
});

describe('refuses to guess', () => {
  it('returns unknown rather than defaulting', () => {
    for (const label of ['Question 14', 'q_9812', 'Additional field', '']) {
      const c = of(label);
      expect(c.semantic, label).toBe('unknown');
      expect(isActionable(c), label).toBe(false);
    }
  });

  it('survives a field with no describing attributes at all', () => {
    const c = classifyField({});
    expect(c.semantic).toBe('unknown');
    expect(c.via).toBe('none');
  });
});

describe('essay detection by shape, not keyword', () => {
  it('recognizes a long-form question whatever it asks about', () => {
    expect(
      classifyField({ label: 'Tell us about a time you changed your mind.', type: 'textarea' })
        .semantic,
    ).toBe('essay');
    expect(
      classifyField({ label: 'What would you build with a free week?', type: 'textarea' }).semantic,
    ).toBe('essay');
  });

  it('does not call a short text input an essay', () => {
    expect(classifyField({ label: 'City', type: 'text' }).semantic).toBe('city');
  });

  it('does not call a labelled textarea an essay when the label names a known field', () => {
    // Cover letter pasted into a textarea is still a cover letter.
    expect(classifyField({ label: 'Cover letter', type: 'textarea' }).semantic).toBe(
      'cover_letter_upload',
    );
    expect(classifyField({ label: 'Paste your resume below', type: 'textarea' }).semantic).toBe(
      'resume_upload',
    );
  });

  /**
   * The ordering assertion that matters most, because getting it wrong is silent.
   *
   * An essay prompt is allowed to MENTION anything. When the rule table ran first, every
   * prompt containing a word from it was answered with that word's value: a 600-character
   * box asking about a leadership role in college received the string "Cornell University",
   * and the answer the user had written and approved for that question was dropped without
   * a skip or a note.
   */
  it('is not fooled by a keyword the essay question merely mentions', () => {
    const PROMPTS = [
      'Why are you interested in interning at LinkedIn?',
      'Describe a project you are proud of. Feel free to include a GitHub link.',
      'Share a link to something you have built (GitHub, portfolio, etc.) and describe it.',
      'Why did you choose your university and major?',
      'Why did you choose your major?',
      'Describe a leadership role you have held in college.',
      'What have you learned outside of school that prepares you for this role?',
      'What is the most interesting class you have taken at university?',
      'Please describe any relevant coursework or school activities.',
      'What excites you about working at our college sports startup?',
      'Tell us about your salary expectations and why.',
    ];
    for (const label of PROMPTS) {
      expect(classifyField({ label, control: 'textarea' }).semantic, label).toBe('essay');
      // Rich text boxes carry no `type` at all, so they have to be checked separately.
      expect(classifyField({ label, control: 'richtext' }).semantic, label).toBe('essay');
    }
  });

  it('leaves a wordy question on a short control to the rules', () => {
    // A long label is the weakest essay signal, and a dropdown asking this in seventy-six
    // characters is still a yes/no the profile can answer.
    const sponsorship =
      'Will you now or in the future require sponsorship for employment visa status?';
    expect(sponsorship.length).toBeGreaterThan(60);
    expect(classifyField({ label: sponsorship, control: 'select' }).semantic).toBe(
      'sponsorship_needed',
    );
    expect(
      classifyField({
        label: 'Are you legally authorized to work in the United States? Please answer yes or no.',
        control: 'select',
      }).semantic,
    ).toBe('work_auth');
  });
});

/**
 * Where someone was born, and where they hold citizenship, are not where they get their post.
 *
 * The city and country rules matched the word anywhere in the label, so "City of birth" was
 * filled with the city the user currently lives in and "Country of Citizenship" with the
 * country of their home address — for a permanent resident, a false statement about their
 * immigration status, entered at high confidence and reported back as a field successfully
 * filled. `unknown` is the right answer: nothing in the profile answers these, so the box is
 * left empty and handed to the user.
 */
describe('origin questions are not the mailing address', () => {
  const NOT_ADDRESS = [
    'City of birth',
    'Country of birth',
    'Birth city',
    'Birth country',
    'Town of birth',
    'City/Town of Birth',
    'State of birth',
    'Country of Citizenship',
    'What is your country of citizenship?',
    'Country of nationality',
    'Dual citizenship country',
    'Country of national origin',
  ];

  for (const label of NOT_ADDRESS) {
    it(`leaves "${label}" for the user`, () => {
      const c = of(label);
      expect(c.semantic, label).toBe('unknown');
      expect(isActionable(c), label).toBe(false);
    });
  }

  it('is not talked round by an address autocomplete token', () => {
    // A form that declares `autocomplete="country"` on a birthplace box has answered a
    // different question than the one printed above it.
    const c = classifyField({ label: 'Country of birth', autocomplete: 'country' });
    expect(c.semantic).toBe('unknown');
    expect(isActionable(c)).toBe(false);
  });

  it('still fills an ordinary address', () => {
    expect(of('City').semantic).toBe('city');
    expect(of('Country').semantic).toBe('country');
    expect(of('State / Province').semantic).toBe('region');
    expect(of('Zip code').semantic).toBe('postal');
    expect(of('Street address').semantic).toBe('address_line1');
    expect(classifyField({ label: 'Country', autocomplete: 'country' }).via).toBe('autocomplete');
  });
});

/**
 * A referee's email address is not the applicant's, and the rules were matching on the word
 * "email" alone.
 *
 * "Reference 1 Email" was filled with the applicant's own address at 0.97, "Supervisor's
 * phone" with their mobile, "Reference full name" and "Reference first name" with their own
 * name, and "Employer city" with the city they live in. Read-back compares against the value
 * the plan chose, so every one came back in the pre-submit review as filled correctly: an
 * employer is told a professor's email is rosa@example.edu, and the referee is never
 * contacted. `unknown` is the honest answer — the profile does not hold anyone else's
 * details, so the box is left empty and handed to the user.
 */
describe('fields that belong to somebody who is not the applicant', () => {
  const NOT_YOURS = [
    // The school is a party to the application too, and its contact details are no more the
    // applicant's than a referee's are. This half was missing while the employer and
    // reference words were listed, so "University email address" was answered with the
    // student's own address — the exact substitution this rule exists to prevent.
    'University email address',
    'School phone number',
    'Registrar email',
    'Institution contact email',
    'Department phone number',
    'Counselor email',
    'College email address',
    'Reference 1 Email',
    'Reference 2 Email',
    'References email address',
    'Recommender email',
    'Recommendation contact email',
    "Supervisor's email",
    'Professor email',
    'Instructor email address',
    'Academic advisor email',
    'Manager phone',
    'Reference phone',
    'Recommender phone number',
    'Employer phone number',
    'Reference full name',
    'Reference legal name',
    'Reference first name',
    'Supervisor last name',
    'Parent/guardian email',
    'Mentor email',
    "Reference's LinkedIn URL",
    "Supervisor's LinkedIn profile",
    'Employer city',
    'Company zip code',
    'Previous employer country',
    'Employer street address',
    'Company website',
    'Previous employer URL',
  ];

  for (const label of NOT_YOURS) {
    it(`leaves "${label}" for the user`, () => {
      const c = of(label);
      expect(c.semantic, label).toBe('unknown');
      expect(isActionable(c), label).toBe(false);
    });
  }

  /**
   * The declared-token shortcut resolves BEFORE the rule table, so a disqualifier that only
   * lived on the rules was half a fix. A references section marking its boxes
   * `autocomplete="email"` — which is exactly what a form does to make the browser's own
   * autofill work — walked past it and filled the referee's row at 0.99.
   */
  it('is not talked round by an autocomplete token on a referee’s box', () => {
    for (const [label, token] of [
      ['Reference email', 'email'],
      ['Reference name', 'name'],
      ['Supervisor phone', 'tel'],
      ['Employer city', 'address-level2'],
    ] as const) {
      const c = classifyField({ label, autocomplete: token });
      expect(c.semantic, label).toBe('unknown');
      expect(isActionable(c), label).toBe(false);
    }
  });

  it('still fills the applicant’s own contact details', () => {
    expect(of('Email address').semantic).toBe('email');
    expect(of('Mobile phone').semantic).toBe('phone');
    expect(of('Full legal name').semantic).toBe('full_name');
    expect(of('Preferred name').semantic).toBe('full_name');
    expect(of('LinkedIn profile').semantic).toBe('linkedin');
    expect(of('City').semantic).toBe('city');
    expect(classifyField({ label: 'Email', autocomplete: 'email' }).via).toBe('autocomplete');
  });
});

/**
 * The date columns of a work-history or education row are not the internship's dates.
 *
 * `start_date` and `end_date` are answered from the profile's availability window, and they
 * matched any label containing "start date" — which is how every history table labels its
 * columns. "Previous employer start date", a label that says in so many words that it is
 * history, was filled with the date the user becomes available, verified by read-back and
 * reported correct: a false statement about someone's employment history, in their name, in
 * the document they are about to submit.
 *
 * The school and degree rules sit above the date rules and win first, so the same row put the
 * name of the university into "School start date" and the degree level into "Degree start
 * date". Both are the same bug wearing a different rule, and both belong in this list.
 */
describe('a row of history is not this internship', () => {
  const HISTORY = [
    'Employment start date',
    'Employment end date',
    'Position start date',
    'Previous employer start date',
    'Prior employment end date',
    'Most recent position start date',
    'Job start date',
    'Company end date',
    'Role start date',
    'School start date',
    'University end date',
    'College end date',
    'Institution start date',
    'Degree start date',
    'Program end date',
    'Work experience start date',
  ];

  for (const label of HISTORY) {
    it(`leaves "${label}" for the user`, () => {
      const c = of(label);
      expect(c.semantic, label).toBe('unknown');
      expect(isActionable(c), label).toBe(false);
    });
  }

  /**
   * The other half of the rule, and the reason it is a lookahead rather than a word list. A
   * history word does not settle it when the label also says it is asking about availability
   * — refusing "Desired employment start date" would hand back the one date the profile can
   * actually answer.
   */
  it('still answers the availability question, however it is worded', () => {
    expect(of('Start date').semantic).toBe('start_date');
    expect(of('Earliest start date').semantic).toBe('start_date');
    expect(of('When can you start?').semantic).toBe('start_date');
    expect(of('Available start date').semantic).toBe('start_date');
    expect(of('Preferred start date').semantic).toBe('start_date');
    expect(of('Desired employment start date').semantic).toBe('start_date');
    expect(of('End date').semantic).toBe('end_date');
    expect(of('Available until').semantic).toBe('end_date');
  });

  it('still reads the education row’s own columns', () => {
    // Which school and which degree ARE answerable from the profile. Only the dates are not.
    expect(of('School name').semantic).toBe('school');
    expect(of('Degree').semantic).toBe('degree');
    expect(of('Expected graduation date').semantic).toBe('graduation_date');
  });
});

/**
 * "Graduate" is an adjective at least as often as it is a date question.
 *
 * While graduation_date matched the bare word, "Are you an undergraduate or graduate
 * student?", "Graduate degree" and "Graduate program of interest" were all classified
 * graduation_date at 0.93 and answered with a year-month — a date typed into a degree-level
 * question. The rule sits above `degree` and `enrollment_status`, and matching is first-wins,
 * so the rules written for exactly those labels could never be reached.
 */
describe('a graduation word has to be asking when', () => {
  it('does not read a degree level or an enrollment question as a date', () => {
    for (const label of [
      'Are you an undergraduate or graduate student?',
      'Graduate/Undergraduate',
      'Graduate program of interest',
      'Are you a graduating senior?',
      'Post-graduate plans',
    ]) {
      expect(of(label).semantic, label).not.toBe('graduation_date');
    }
    expect(of('Graduate degree').semantic).toBe('degree');
    // "Graduate school" asks WHICH one, which is why the bare adjective must not disqualify
    // the school rule either.
    expect(of('Graduate school').semantic).toBe('school');
    expect(of('Undergraduate GPA').semantic).toBe('gpa');
  });

  it('still reads every ordinary way of asking when someone graduates', () => {
    for (const label of [
      'Expected graduation date',
      'Expected graduation',
      'Anticipated graduation',
      'Graduation year',
      'Graduation month',
      'Expected graduation term',
      'University graduation date',
      'When did you graduate?',
      'Degree completion date',
      'Completion date',
    ]) {
      expect(of(label).semantic, label).toBe('graduation_date');
    }
  });
});

/**
 * A URL field says what kind of thing it holds and never whose.
 *
 * `autocomplete="url"` was mapped to `website` and resolved before the rule table, so it beat
 * the linkedin, github and portfolio rules the table deliberately orders above the generic
 * link rule: a GitHub box declaring that token was filled with the applicant's portfolio
 * address at 0.99, which reads back identically and is reported filled correctly. The rule
 * itself had the mirror-image problem — it matched the bare word "URL", so the company's, the
 * school's and the job posting's own addresses were all answered with the applicant's.
 */
describe('a link field is not automatically the applicant’s link', () => {
  it('lets the host rules win over a declared url token', () => {
    expect(classifyField({ label: 'GitHub URL', autocomplete: 'url' }).semantic).toBe('github');
    expect(classifyField({ label: 'LinkedIn', autocomplete: 'url' }).semantic).toBe('linkedin');
    expect(classifyField({ label: 'Portfolio link', autocomplete: 'url' }).semantic).toBe(
      'portfolio',
    );
  });

  it('leaves somebody else’s web address alone', () => {
    for (const label of [
      'Company website',
      'Employer website',
      'Previous employer URL',
      'Job posting URL',
      'School website',
      'University homepage',
      'Company blog',
    ]) {
      expect(of(label).semantic, label).toBe('unknown');
    }
  });

  it('still fills a plain website box', () => {
    expect(of('Other website').semantic).toBe('website');
    expect(classifyField({ label: 'Website', autocomplete: 'url' }).semantic).toBe('website');
    expect(of('Personal website').semantic).toBe('portfolio');
  });

  it('reads "Where did you hear about this job? (URL)" as the referral question it is', () => {
    expect(of('Where did you hear about this job? (URL)').semantic).toBe('referral_source');
  });
});

/**
 * The word "source" had to arrive carrying the referral sense.
 *
 * A bare `\bsource\b` claimed "Open source contributions", "Source code repository" and
 * "Funding source". The planner has no value for referral_source at all, so what the user
 * read beside a box asking about their open-source work was "Your profile has no referral
 * source to fill in." — a sentence that is not true of the field it is printed next to. Those
 * fields were also counted as fillable in the summary line, having been recognized as
 * something that can never be filled.
 */
describe('"source" alone is not a referral question', () => {
  it('does not claim every field that mentions the word', () => {
    for (const label of [
      'Open source contributions',
      'Open Source Projects',
      'Source code repository',
      'Funding source',
      'Data source',
    ]) {
      expect(of(label).semantic, label).toBe('unknown');
    }
  });

  it('still recognizes the referral question', () => {
    for (const label of [
      'How did you hear about us?',
      'Where did you hear about this role?',
      'Referral source',
      'Application source',
      'Source of referral',
      'How did you find this role?',
    ]) {
      expect(of(label).semantic, label).toBe('referral_source');
    }
  });
});

/**
 * THE CONTAINER ANSWERS WHAT A BARE COLUMN HEADING CANNOT.
 *
 * `start_date` and `end_date` are answered from the profile's availability window, and the
 * label rules could only refuse the phrasings that name their container out loud ("Previous
 * employer start date"). A work-history table does not label its columns that way — it labels
 * them "Start Date" — so a row of the applicant's employment history was filled with the date
 * they become AVAILABLE, at 0.92 confidence, verified by read-back, and shown in the review as
 * a field that went right. A false statement about their work history, in a document
 * submitted in their name, with the review screen arguing it is correct.
 *
 * `FormField.section` had been declared for exactly this and populated by nothing. It is now
 * read off the enclosing legend, caption or heading, and it may only ever DISQUALIFY: letting
 * a heading satisfy a positive test would make every control under "Previous Employment" match
 * employment rules whatever its own label said.
 */
describe('a date column inside a history table', () => {
  const semanticOf = (label: string, section?: string): string =>
    classifyField({ label, section, control: 'text', type: 'date' }).semantic;

  it('is not answered from the availability window, whatever the table is called', () => {
    for (const section of [
      'Employment History',
      'Work Experience',
      'Previous Employment',
      'Education',
      'Academic History',
      'Educational Qualifications',
    ]) {
      expect({ section, start: semanticOf('Start Date', section) }).toEqual({
        section,
        start: 'unknown',
      });
      expect({ section, end: semanticOf('End Date', section) }).toEqual({
        section,
        end: 'unknown',
      });
    }
  });

  /**
   * The other direction, and the reason the container cannot simply outrank the label. Every
   * one of these is the form asking when the applicant can begin, and refusing them hands back
   * an empty box on the one date the profile can actually answer.
   */
  it('still answers the question when the label itself is unambiguous', () => {
    expect(semanticOf('When can you start?', 'Employment History')).toBe('start_date');
    expect(semanticOf('Desired start date', 'Employment History')).toBe('start_date');
    expect(semanticOf('Earliest start date', 'Education')).toBe('start_date');
    expect(semanticOf('Availability date', 'Work History')).toBe('start_date');
  });

  it('is unchanged when the scanner found no container', () => {
    // `undefined` means "no container known", never "top level" — the scanner cannot always
    // find one, and treating that as permission to refuse would empty the field on every form
    // whose markup it cannot read.
    expect(semanticOf('Start Date')).toBe('start_date');
    expect(semanticOf('Start Date', '')).toBe('start_date');
  });

  it('lets a container take a semantic away but never hand one out', () => {
    // A heading is one string shared by every control in the block. If it could satisfy a
    // rule, a box labelled "Notes" under "Employment History" would start classifying as
    // employment — so the positive test reads the field's own words only.
    expect(semanticOf('Notes', 'Employment History')).not.toBe('start_date');
    expect(classifyField({ label: 'Notes', section: 'Email Address' }).semantic).not.toBe('email');
  });
});
