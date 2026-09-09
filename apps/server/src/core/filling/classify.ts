/**
 * Field classification — docs/07-form-automation.md § Classification.
 *
 * Turns "what is this input?" into a `FieldSemantic`. Two stages were specified, cheap
 * first, and only the first of them exists:
 *
 *   1. This file. A rule table over the normalized label + name + id + autocomplete.
 *      Free, instant, unit-testable, and it handles the large majority of real fields.
 *   2. Not built. docs/07 § Classification specifies an LLM fallback over the fields stage 1
 *      cannot name, returning its own semantic and confidence. Until it exists, a field
 *      stage 1 does not recognize stays `unknown` and is handed back to the user, which is
 *      the safe half of that design and the reason its absence is not urgent.
 *
 * THE ORDER OF CHECKS IS THE DESIGN. Redlines are consulted before anything else, so a
 * field can never be classified into something fillable and then filled — a mislabeled SSN
 * box is refused before the question "is this a text field?" is even asked.
 *
 * WHY `autocomplete` WINS. When a form says `autocomplete="family-name"` it is telling us
 * what the field is, in a standard vocabulary, on purpose. That beats any guess made from
 * prose. Regexes only run when the attribute is absent or unrecognized — or, in the single
 * case spelled out at NOT_A_MAILING_ADDRESS, when the label is asking about someone's
 * origins and the token can only describe where they get their post.
 *
 * UNRECOGNIZED IS A REAL ANSWER. Anything below the confidence floor is treated as
 * `unknown` by the planner, left blank, and surfaced for the user. A wrong guess in a job
 * application is worse than a blank the user fills in themselves, so this file never
 * reaches for a default.
 */
import type { FieldSemantic } from '@ia/shared';
import { checkRedline, normalizeField } from './redlines';

export interface FieldDescriptor {
  label?: string;
  name?: string;
  id?: string;
  autocomplete?: string;
  placeholder?: string;
  type?: string;
  /**
   * The kind of control, when the scanner knows it.
   *
   * Needed because a contenteditable rich-text editor has no `type` attribute at all, so
   * shape-based essay detection could not see one — and every ATS that ships a rich-text
   * essay box got "could not tell what this field is asking for" instead of the answer
   * the user approved for exactly that question.
   */
  control?: string;
  /**
   * The heading of the block this control sits inside, when the scanner found one.
   *
   * A label on its own cannot tell two identical questions apart. The "Start Date" column of
   * a work-history table and the "Start date" this internship asks about are the same six
   * characters — so a row of the applicant's employment history received the date they become
   * AVAILABLE, at 0.92 confidence, verified by read-back and shown in the review as a field
   * that went right. That is a false statement about their work history, in a document
   * submitted in their name, with the review screen arguing it is correct.
   *
   * The label rules can only disqualify the phrasings that name the container out loud
   * ("Previous employer start date"); a bare column heading has to know what it is a column
   * of. Optional, and `undefined` means "no container known" rather than "top level" — the
   * scanner cannot always find one.
   */
  section?: string;
}

export interface Classification {
  semantic: FieldSemantic;
  confidence: number;
  /** Which rule decided, so a surprising fill can be traced back. */
  via: 'redline' | 'autocomplete' | 'rule' | 'none';
}

/** Below this, a guess is not worth acting on. docs/07 sets it at 0.75. */
export const CONFIDENCE_FLOOR = 0.75;

/**
 * The HTML autocomplete vocabulary, mapped to our semantics.
 *
 * Only tokens with an unambiguous meaning for us are listed. `organization` is
 * deliberately absent: on an application form it may be the applicant's current employer
 * or the school, and guessing between them is exactly the mistake worth not making.
 *
 * `url` is absent for exactly the same reason, and it used to be here. The token says the box
 * holds a web address and never whose, and a declared token is resolved before the rule table
 * — so it defeated the linkedin, github and portfolio rules that the table deliberately
 * orders above the generic "website". A GitHub box carrying `autocomplete="url"` was
 * classified `website` at 0.99 and filled with the applicant's portfolio address, which reads
 * back identically to what was typed and so was reported as a field filled correctly. A URL
 * field whose label names no host still reaches the website rule below, so nothing is lost.
 *
 * EVERY TOKEN LEFT IN THIS TABLE NAMES SOMETHING READ OFF THE APPLICANT'S OWN PROFILE, which
 * is why `classifyField` refuses a declared token on a label that is asking about somebody
 * else. See NOT_THE_APPLICANT.
 */
const AUTOCOMPLETE: Record<string, FieldSemantic> = {
  'given-name': 'first_name',
  'family-name': 'last_name',
  name: 'full_name',
  email: 'email',
  tel: 'phone',
  'tel-national': 'phone',
  'address-line1': 'address_line1',
  'street-address': 'address_line1',
  'address-level2': 'city',
  'address-level1': 'region',
  'postal-code': 'postal',
  country: 'country',
  'country-name': 'country',
};

interface Rule {
  semantic: FieldSemantic;
  test: RegExp;
  /** Rules matching a strong, unambiguous phrase are trusted more. */
  confidence: number;
  /** When this matches too, the rule does not apply and matching carries on. */
  unless?: RegExp;
}

/**
 * One regex out of several, so a disqualifier can be assembled from named pieces.
 *
 * Worth having because the same wording is a disqualifier for one rule and the whole
 * question for another — "University graduation date" must not name a school, and it must
 * name a graduation date. Writing the shared half twice is how the two halves drift apart,
 * and a drift here is silent: one rule stops matching and the field is filled by whichever
 * rule catches it next.
 */
const anyOf = (...parts: RegExp[]): RegExp => new RegExp(parts.map((p) => p.source).join('|'), 'i');

/**
 * Qualifiers that mean an address word is not asking where the user lives.
 *
 * "City of birth", "Country of birth" and "Country of citizenship" all contain the word the
 * city and country rules look for, and the address on the profile answers none of them. A
 * student who moved to Columbus for school had Columbus entered as the city they were born
 * in, and a permanent resident whose only citizenship is Indian had "US" — read straight off
 * their home address — typed into a citizenship box at 0.92 confidence. That is a false
 * statement about someone's immigration status on an employer's form, and it came back to
 * them in the review as a field filled successfully, with no reason to look at it twice.
 *
 * These fall through to `unknown` rather than to a redline, and the difference is not
 * cosmetic. A redline is a refusal to fill something the tool could fill; this is the tool
 * not having the answer. There is no birthplace anywhere in the profile, so `unknown` is the
 * honest result — the planner leaves the box empty and shows it to the user, which is the
 * treatment a box labelled "Place of birth" already got, purely because no rule happened to
 * match those words. If a birthplace is ever collected, it belongs on the redline list beside
 * the other origin questions rather than in this table. Citizenship is the one that could be
 * answered honestly one day, because the profile does carry `citizenships` — but it would
 * have to come from that field, and only when it names exactly one country. Never from an
 * address.
 */
const NOT_A_MAILING_ADDRESS =
  /\bbirth\b|\bborn\b|\bcitizen(ship)?s?\b|\bnationalit(y|ies)\b|\bnational origin\b/i;

/**
 * Labels that are asking about somebody who is not the applicant.
 *
 * A references section, a work-history row and a parent/guardian block ask for a name, an
 * email address, a phone number and sometimes a profile link — the same words the
 * applicant's own fields use, which is all the rules below were matching on. So "Reference 1
 * Email" was filled with the applicant's own address at 0.97, "Supervisor's phone" with their
 * mobile, "Reference full name" and "Reference first name" with their own name, "Employer
 * city" with the city they live in, and "Supervisor's LinkedIn profile" with their own
 * profile. Read-back compares against the value the plan chose, so every one of those came
 * back in the pre-submit review as a field filled correctly. The result is a form that tells
 * an employer a professor's email address is rosa@example.edu, and a referee who is never
 * contacted because nobody's real details were ever on the page.
 *
 * These fall to `unknown` rather than to a redline, and the difference matters. A redline is
 * a refusal to fill something the tool could fill; here the profile simply does not hold
 * anyone else's contact details, so `unknown` is the honest answer — the box is left empty
 * and shown to the user, which is the treatment "Referee name" already got purely because no
 * rule happened to match the word.
 *
 * TWO RULES FOR ANYONE EXTENDING THIS. Every rule whose value is read off the applicant's own
 * profile carries this disqualifier, including the declared-autocomplete shortcut, because a
 * form is free to put `autocomplete="email"` on a referee's box. And every noun here spells
 * its plural: forms number these rows ("Reference 2 Email") and pluralize the headings
 * ("References"), so a singular on its own leaves half the shapes still being filled.
 */
const NOT_THE_APPLICANT =
  /\breferences?\b|\brefs?\b|\breferees?\b|\brecommend(ers?|ations?)\b|\bsupervisors?\b|\bmanagers?\b|\bprofessors?\b|\binstructors?\b|\badvis(o|e)rs?\b|\bmentors?\b|\bemployers?\b|\bcompan(y|ies)\b|\bguardians?\b|\bparents?\b|\bspouse\b|\bnext of kin\b|\bemergency\b|\bschools?\b|\buniversit(y|ies)\b|\bcolleges?\b|\binstitutions?\b|\bregistrars?\b|\bdepartments?\b|\bteachers?\b|\bcoach(es)?\b|\bcounsel(l)?ors?\b/i;

/**
 * A graduation word that is actually asking WHEN.
 *
 * This is both the graduation_date rule's own test and half of the school rule's
 * disqualifier, which is why it is named once and used twice. The bare adjective is not
 * enough on its own: while the rule matched a lone "graduate", "Are you an undergraduate or
 * graduate student?", "Graduate degree" and "Graduate program of interest" were all
 * classified graduation_date at 0.93 and answered with "2028-05" — a date typed into a
 * degree-level question, sitting above the degree and enrollment_status rules that were
 * written for exactly those labels and could never be reached.
 *
 * "Expected graduation" carries no date word at all and is still a date question, so the
 * expectation words count as the date sense on their own.
 */
const GRADUATION_IS_A_DATE =
  /\bgraduat\w*\b.{0,20}\b(dates?|years?|months?|terms?|semesters?)\b|\b(date|year|month|term|semester|when)\b.{0,20}\bgraduat|\b(expected|anticipated|projected|planned|upcoming)\b.{0,12}\bgraduat/i;

/**
 * A school word attached to the school's own contact details rather than to its name.
 *
 * "School website" and "University homepage" are asking for the institution's address on the
 * web. Whichever rule claims them, the answer is wrong in a different way — the school rule
 * types "Cornell University" into a URL box, the website rule types the applicant's own
 * portfolio address into the school's — so the field belongs to nobody here and the honest
 * answer is `unknown`.
 *
 * An email address, a phone number or a postal address behind a school word is the same
 * shape with the same two wrong answers. This tool holds contact details for nobody but the
 * applicant, and offering those is how "University email address" came to be answered with
 * the student's own.
 */
const THE_SCHOOLS_OWN_LINK =
  /\b(website|web site|url|homepage|blog|e-?mail|phone|telephone|fax|contact|address)\b/i;

/** Class-standing questions: "Year in school" asks how far along, not which school. */
const ASKS_HOW_FAR_ALONG =
  /\byear\b.{0,20}\bin school\b|\bclass (standing|year)\b|\bacademic year\b/i;

/**
 * The date columns of a repeating history row.
 *
 * An education row is "School / Degree / Start date / End date", and each of those column
 * headings is a label of its own. "School start date" and "Institution start date" matched
 * the school rule, which sits above every date rule and wins first — so the name of the
 * user's university was typed into a date box and read back unchanged. "Degree start date"
 * did the same thing with the degree rule.
 */
const A_ROW_DATE_COLUMN =
  /\b(start|end|from|to|begin|beginning|completion) ?dates?\b|\bdates? (attended|of attendance|of employment|of enrollment)\b/i;

/**
 * Wording that turns a school word into context rather than the question.
 *
 * "University graduation date" asks when, not where; "Year in school" asks how far along;
 * "College end date" is a column in a table of history. None of the three is answered by the
 * name of the institution. See the `unless` on the school rule for what went wrong while
 * these were missing.
 */
const ASKS_WHEN_NOT_WHICH = anyOf(GRADUATION_IS_A_DATE, ASKS_HOW_FAR_ALONG, A_ROW_DATE_COLUMN);

/** Everything that stops a school word from being a request for the institution's name. */
const NOT_WHICH_SCHOOL = anyOf(ASKS_WHEN_NOT_WHICH, THE_SCHOOLS_OWN_LINK);

/**
 * A date that belongs to a row of history rather than to this internship.
 *
 * `start_date` and `end_date` are answered from the profile's availability window, and they
 * matched any label containing "start date" or "end date" — which is precisely how every
 * work-history and education table labels its date columns. "Previous employer start date",
 * a label that says in so many words that it is history, was filled with the date the user
 * becomes available, verified by read-back, and reported to them as correct. That is a false
 * statement about someone's employment history, made in their name, in the document they are
 * about to submit, with the review screen arguing the field is right.
 *
 * The lookahead is the other half of the rule and it is not optional. A history word does not
 * settle it when the label ALSO says it is asking about availability: "Desired employment
 * start date" and "Preferred position start date" are asking when the applicant can begin,
 * and refusing those would hand back the one date the profile can actually answer. So the
 * availability sense, wherever it appears in the label, wins — and only in its absence does a
 * history word disqualify the date.
 */
const A_HISTORY_ROW_DATE = new RegExp(
  // "when can you start" joined the availability half once the CONTAINER could disqualify a
  // date. It is as unambiguous as "earliest start" and needs the same protection: asked inside
  // a block captioned "Employment History" — which is where a form puts it often enough — the
  // container was taking away the one date the profile can actually answer, and the student
  // got an empty box on a question about themselves.
  String.raw`^(?!.*\b(availab(le|ility)|earliest|soonest|desired|preferred|anticipated` +
    String.raw`|when can you start)\b).*` +
    String.raw`(\bemploy(ment|er|ers|ed)\b|\bcompan(y|ies)\b|\bpositions?\b|\bjobs?\b|\broles?\b` +
    // "education" is the caption every school-history table carries, and the word list had
    // every synonym for one but not the heading itself — so "Start Date" under a legend
    // reading "Education" was still answered with the applicant's availability.
    String.raw`|\bschools?\b|\buniversit(y|ies)\b|\bcolleges?\b|\binstitutions?\b|\bdegrees?\b` +
    String.raw`|\beducation(al)?\b|\bacademics?\b|\bqualifications?\b` +
    String.raw`|\bprograms?\b|\battend(ed|ance)?\b|\benrolled\b|\bexperiences?\b` +
    String.raw`|\bhistor(y|ies)\b|\bprevious(ly)?\b|\bprior\b|\bformer\b|\bmost recent\b)`,
  'i',
);

/** The semantics whose value is read off the profile's address, whatever named them. */
const FROM_MAILING_ADDRESS = new Set<FieldSemantic>([
  'address_line1',
  'city',
  'region',
  'postal',
  'country',
]);

/**
 * Ordered narrow to broad. The first match wins, so anything that could be a prefix of a
 * more specific rule must come after it — "name" after "first name", "school name", and
 * "company name", or it swallows all of them.
 */
const RULES: Rule[] = [
  // ── Identity. Every one of these answers with the applicant's own details, so every one
  //    of them carries the same disqualifier: see NOT_THE_APPLICANT above.
  {
    semantic: 'first_name',
    test: /\b(first|given|fore) ?name\b|\bfname\b/i,
    confidence: 0.97,
    unless: NOT_THE_APPLICANT,
  },
  {
    semantic: 'last_name',
    test: /\b(last|family|sur) ?name\b|\blname\b|\bsurname\b/i,
    confidence: 0.97,
    unless: NOT_THE_APPLICANT,
  },
  {
    semantic: 'full_name',
    test: /\b(full|legal|preferred|display) ?name\b|\byour name\b|\bname of applicant\b/i,
    confidence: 0.9,
    unless: NOT_THE_APPLICANT,
  },
  { semantic: 'email', test: /\be-?mail\b/i, confidence: 0.97, unless: NOT_THE_APPLICANT },
  {
    semantic: 'phone',
    test: /\b(phone|mobile|cell|telephone|contact number)\b/i,
    confidence: 0.94,
    unless: NOT_THE_APPLICANT,
  },

  // ── Address. Region before city, because "state" is the more distinctive word.
  //    Every rule here answers from the profile's mailing address, so every one of them
  //    carries the same two disqualifiers: the address answers no origin question (see
  //    NOT_A_MAILING_ADDRESS) and it is not the address of the company, the school or the
  //    referee whose row the column belongs to (see NOT_THE_APPLICANT).
  {
    semantic: 'address_line1',
    test: /\b(street|mailing|home|current) address\b|\baddress ?(line ?)?1\b|\baddr1\b/i,
    confidence: 0.9,
    unless: anyOf(NOT_A_MAILING_ADDRESS, NOT_THE_APPLICANT),
  },
  {
    semantic: 'postal',
    test: /\b(zip|postal)( ?code)?\b|\bpostcode\b/i,
    confidence: 0.95,
    unless: anyOf(NOT_A_MAILING_ADDRESS, NOT_THE_APPLICANT),
  },
  {
    semantic: 'region',
    test: /\b(state|province|region|county)\b/i,
    confidence: 0.85,
    unless: anyOf(NOT_A_MAILING_ADDRESS, NOT_THE_APPLICANT),
  },
  {
    semantic: 'city',
    test: /\b(city|town|locality)\b/i,
    confidence: 0.9,
    unless: anyOf(NOT_A_MAILING_ADDRESS, NOT_THE_APPLICANT),
  },
  {
    semantic: 'country',
    test: /\bcountry\b/i,
    confidence: 0.92,
    unless: anyOf(NOT_A_MAILING_ADDRESS, NOT_THE_APPLICANT),
  },

  // ── Links. Specific hosts before the generic "website", and none of them is the link of
  //    the reference or the employer whose row it sits in.
  {
    semantic: 'linkedin',
    test: /\blinked ?in\b/i,
    confidence: 0.98,
    unless: NOT_THE_APPLICANT,
  },
  {
    semantic: 'github',
    test: /\bgit ?hub\b|\bgitlab\b/i,
    confidence: 0.98,
    unless: NOT_THE_APPLICANT,
  },
  {
    semantic: 'portfolio',
    test: /\bportfolio\b|\bpersonal (site|website)\b|\bbehance\b|\bdribbble\b/i,
    confidence: 0.92,
    unless: NOT_THE_APPLICANT,
  },
  // The generic link rule, and the one that needed the widest disqualifier: it matches the
  // bare word "URL", which is how a form labels the address of the company, the school, the
  // job posting and the place the applicant heard about the role. Every one of those was
  // answered with the applicant's own portfolio address, read back identically, and reported
  // filled correctly — an employer's website box telling them their own URL is rosa.dev.
  {
    semantic: 'website',
    test: /\b(website|web site|url|homepage|blog)\b/i,
    confidence: 0.8,
    unless: anyOf(
      NOT_THE_APPLICANT,
      /\borgani[sz]ations?\b|\bschools?\b|\buniversit(y|ies)\b|\bcolleges?\b|\bpostings?\b|\bjob (ad|ads|listing|listings)\b|\b(how|where) did you hear\b/,
    ),
  },

  // ── Education. Uploads first, since "transcript" also appears in prose.
  {
    semantic: 'transcript_upload',
    test: /\btranscript\b/i,
    confidence: 0.9,
  },
  {
    semantic: 'school',
    test: /\b(school|university|college|institution|alma mater)\b/i,
    confidence: 0.9,
    // A school word names a school only when the question asks WHICH one. This rule sits
    // above graduation_date and enrollment_status, and matching is first-wins, so
    // "University graduation date", "College graduation year" and "When did you graduate
    // from college?" were all answered with the institution — the school's name typed into
    // a date box, read back unchanged, and reported to the user as filled successfully.
    // The same shadowing hid "Year in school", which is a class-standing question and had
    // its own branch in enrollment_status that nothing could ever reach.
    //
    // The disqualifier needs the graduation word paired with a date, a year or a "when".
    // The bare adjective must not disqualify anything, or "Graduate school" — which is
    // asking which one — would fall through to a date rule. It also has to cover the date
    // columns of an education row, because "School start date" and "College end date" are
    // asking when just as plainly as "graduation date" is, and the school's own web address.
    unless: NOT_WHICH_SCHOOL,
  },
  // graduation_date sits ABOVE degree deliberately. Matching is first-wins, and the
  // broad /\bdegree\b/ swallowed "Degree date" and "Degree completion date" — typing a
  // degree level into a date field and making this rule's own \bdegree date\b branch
  // unreachable.
  //
  // What it must NOT swallow in return is the bare adjective in "Graduate degree" or "Are
  // you an undergraduate or graduate student?", which is what GRADUATION_IS_A_DATE is for.
  {
    semantic: 'graduation_date',
    test: anyOf(GRADUATION_IS_A_DATE, /\bdegree (date|completion)\b|\bcompletion date\b/),
    confidence: 0.93,
  },
  {
    semantic: 'degree',
    test: /\bdegree\b|\bqualification\b|\b(bachelor|master|doctora|phd)\b/i,
    confidence: 0.9,
    // Same reason as the school rule above it: "Degree start date" is a date column in a
    // history row, and while this rule claimed it the user's degree level — "Bachelor of
    // Science" — was typed into a date box and reported back as filled correctly.
    unless: ASKS_WHEN_NOT_WHICH,
  },
  {
    semantic: 'major',
    test: /\bmajor\b|\bfield of study\b|\bcourse of study\b|\bdiscipline\b|\bconcentration\b/i,
    confidence: 0.92,
  },
  { semantic: 'gpa', test: /\bgpa\b|\bgrade point average\b/i, confidence: 0.97 },
  {
    semantic: 'enrollment_status',
    test: /\b(currently )?enrolled\b|\benrollment status\b|\bclass (standing|year)\b|\byear\b.{0,20}\bin school\b|\bacademic year\b/i,
    confidence: 0.9,
  },

  // ── Work eligibility. Sponsorship before the broader authorization phrasing.
  {
    semantic: 'sponsorship_needed',
    test: /\bsponsor(ship|ed)?\b|\bh-?1b\b|\brequire.{0,20}visa\b/i,
    confidence: 0.94,
  },
  {
    semantic: 'work_auth',
    test: /\b(legally )?authoriz(ed|ation) to work\b|\bwork (authorization|eligibility|permit)\b|\beligible to work\b|\bright to work\b/i,
    confidence: 0.94,
  },

  // ── Uploads ───────────────────────────────────────────────────────────────
  {
    semantic: 'resume_upload',
    test: /\b(resume|résumé|\bcv\b|curriculum vitae)\b/i,
    confidence: 0.95,
  },
  { semantic: 'cover_letter_upload', test: /\bcover letter\b/i, confidence: 0.95 },

  // ── Logistics ─────────────────────────────────────────────────────────────
  // Both date rules answer from the profile's availability window, so both carry the same
  // disqualifier: a date column in a table of past jobs or past schooling is not it. See
  // A_HISTORY_ROW_DATE.
  {
    semantic: 'start_date',
    test: /\b(start|available|availability|commence|join)( ?ing)? date\b|\bearliest start\b|\bwhen can you start\b/i,
    confidence: 0.92,
    unless: A_HISTORY_ROW_DATE,
  },
  {
    semantic: 'end_date',
    test: /\b(end|finish|until) date\b|\bavailable until\b/i,
    confidence: 0.9,
    unless: A_HISTORY_ROW_DATE,
  },
  {
    semantic: 'hours_available',
    test: /\bhours (per|a) week\b|\bweekly hours\b|\bhours available\b/i,
    confidence: 0.93,
  },
  {
    semantic: 'salary_expectation',
    test: /\b(salary|compensation|pay|rate) (expectation|requirement|range)\b|\b(desired|expected|target) (salary|compensation|pay|rate)\b/i,
    confidence: 0.92,
  },
  // The word "source" has to arrive carrying the referral sense. On its own it claimed
  // "Open source contributions", "Source code repository" and "Funding source", and the user
  // was shown the planner's no-value sentence beside a box asking about their open-source
  // work — a sentence that is not true of the field it is printed next to. Those fields were
  // also counted as fillable in the summary line, having been recognized as something the
  // planner can never fill.
  //
  // No profile this tool holds can answer a genuine referral question either, so the planner
  // gives this semantic a note of its own rather than blaming a gap in the profile — see
  // `NO_PROFILE_SOURCE` in plan.ts. Recognizing the field is still worth doing: it tells the
  // user precisely which box is theirs and why.
  {
    semantic: 'referral_source',
    test: /\bhow did you hear\b|\bhow (did|do) you (find|learn)\b|\bwhere did you hear\b|\b(referral|lead|traffic|application|candidate) sources?\b|\bsources? of (referral|application)\b/i,
    confidence: 0.88,
  },
];

/**
 * Free-text questions that route to the writing engine.
 *
 * Recognized by shape rather than keyword: a long-form control whose label asks something is
 * an essay, whatever it happens to ask about. A keyword list would never keep up with what
 * companies invent.
 *
 * THE SHAPE TEST RUNS BEFORE THE RULE TABLE, and that ordering is the whole point. When the
 * rules went first, any essay prompt that merely MENTIONED a word in the table was answered
 * with the value behind that word: "Describe a leadership role you have held in college."
 * had the string "Cornell University" typed into a 600-character box, "Why did you choose
 * your major?" got "Computer Science", and "Share a link to something you have built
 * (GitHub, portfolio, etc.) and describe it." got a bare profile URL. The answer the user had
 * written and approved for that exact question was dropped without a word, and the field came
 * back in the review as successfully filled — so the wrong answer was also the one nobody was
 * asked to look at.
 *
 * A label that NAMES a field is still a field, which is why the test needs the question and
 * not just the big box. "Cover letter" over a textarea asks nothing, so it stays
 * cover_letter_upload and a pasted letter still lands there.
 */
function isLongFormControl(d: FieldDescriptor): boolean {
  return d.type === 'textarea' || d.control === 'textarea' || d.control === 'richtext';
}

function asksSomething(d: FieldDescriptor, normalized: string): boolean {
  return (
    /\?/.test(d.label ?? '') ||
    /\b(tell us|describe|explain|why|what|how|share|walk us through|in your own words)\b/i.test(
      normalized,
    )
  );
}

/** Stage 1. No model, no network. */
export function classifyField(d: FieldDescriptor): Classification {
  // Refusal outranks recognition. Always.
  const red = checkRedline(d);
  if (red) return { semantic: 'REDLINE', confidence: 1, via: 'redline' };

  // The placeholder joins the haystack here but not in the redline check: it is a weaker
  // signal, and a placeholder reading "e.g. 123-45-6789" should not be the only thing
  // standing between us and typing an SSN.
  const normalized = normalizeField({
    label: [d.label, d.placeholder].filter(Boolean).join(' '),
    name: d.name,
    id: d.id,
    autocomplete: d.autocomplete,
  });

  const auto = d.autocomplete?.trim().toLowerCase();
  const declared = auto ? AUTOCOMPLETE[auto] : undefined;
  // The two places a declared token is not the last word, and both are the same mistake:
  // the token says what KIND of thing the box holds and never whose, or about whom.
  //
  // `autocomplete="country"` is the browser's vocabulary for the country of a postal
  // address, so a form that puts it on a "Country of birth" box has answered a different
  // question than the one on screen — and trusting it would type the user's home country
  // into their birthplace by the same route the label rules used to.
  //
  // Every token in AUTOCOMPLETE is answered from the applicant's own profile, so a label
  // naming somebody else disqualifies all of them equally. A references section that marks
  // its boxes `autocomplete="name"` and `autocomplete="email"` — which is exactly what a form
  // does to make the browser's own autofill work — would otherwise walk straight past the
  // disqualifier the rule table carries and put the applicant's details in a referee's row at
  // 0.99, the highest confidence this file hands out.
  if (declared) {
    const aboutSomeoneElse = NOT_THE_APPLICANT.test(normalized);
    const wrongAddressSense =
      FROM_MAILING_ADDRESS.has(declared) && NOT_A_MAILING_ADDRESS.test(normalized);
    if (!aboutSomeoneElse && !wrongAddressSense) {
      return { semantic: declared, confidence: 0.99, via: 'autocomplete' };
    }
  }

  if (!normalized) return { semantic: 'unknown', confidence: 0, via: 'none' };

  if (isLongFormControl(d) && asksSomething(d, normalized)) {
    return { semantic: 'essay', confidence: 0.85, via: 'rule' };
  }

  /**
   * THE SECTION MAY ONLY EVER DISQUALIFY, NEVER QUALIFY.
   *
   * A container heading answers the question a bare column label cannot — "Start Date" under
   * a caption reading "Employment History" is a date in a row of past jobs, and filling it
   * with the applicant's availability is a false statement about their work history made in
   * their name. But letting a heading satisfy a rule's positive test would be far worse in
   * the other direction: every control inside a block headed "Previous Employment" would
   * start matching employment rules whatever its own label said, and a heading is one string
   * shared by a dozen fields.
   *
   * So `test` still reads the field's own words and only `unless` sees the container. The
   * section can take a semantic away; it can never hand one out.
   */
  const withSection = d.section
    ? `${normalized} ${normalizeField({ label: d.section })}`
    : normalized;

  for (const r of RULES) {
    if (r.test.test(normalized) && !r.unless?.test(withSection))
      return { semantic: r.semantic, confidence: r.confidence, via: 'rule' };
  }

  // A label longer than a line is the weakest of the essay signals, and it stays BELOW the
  // rule table on purpose. Plenty of dropdowns and radio groups ask a wordy question — "Will
  // you now or in the future require sponsorship for employment visa status?" is seventy
  // characters of yes/no — and if length alone outranked the rules, the profile's answer to
  // exactly that question would be replaced by a demand for an essay the user never wrote.
  if ((d.label?.length ?? 0) > 60 && asksSomething(d, normalized)) {
    return { semantic: 'essay', confidence: 0.85, via: 'rule' };
  }

  return { semantic: 'unknown', confidence: 0, via: 'none' };
}

/**
 * Anything at or above the floor may be acted on.
 *
 * Takes the semantic and the confidence rather than a whole `Classification`, because the
 * planner asks this question of a `FormField` that has already been through the scanner and
 * no longer carries which rule decided it. The floor has to be enforced there — the plan is
 * the last thing between a guess and a keystroke.
 */
export function isActionable(c: { semantic: FieldSemantic; confidence: number }): boolean {
  return c.semantic !== 'unknown' && c.semantic !== 'REDLINE' && c.confidence >= CONFIDENCE_FLOOR;
}
