/**
 * Deterministic parsing of posting text into structured fields — docs/04 § Normalization.
 *
 * No LLM here. These parsers return `null` rather than guessing, and every `null` shows
 * up in the UI as a badge instead of causing a silent filter-out. The cost of a wrong
 * guess (a posting hidden from the user) is much higher than the cost of an "unknown".
 */
import type { PositionType, Season, WorkArrangement } from '@ia/shared';

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

// ---------------------------------------------------------------- season & year

const SEASON_WORDS: Array<[RegExp, Season]> = [
  [/\bsummer\b/i, 'summer'],
  [/\bfall\b|\bautumn\b/i, 'fall'],
  [/\bwinter\b/i, 'winter'],
  [/\bspring\b/i, 'spring'],
  [/\byear[-\s]?round\b/i, 'year_round'],
];

export function parseSeason(text: string): Season | null {
  for (const [re, season] of SEASON_WORDS) if (re.test(text)) return season;
  return null;
}

/** A 4-digit year in a plausible hiring range, preferring one adjacent to a season word. */
export function parseYear(text: string, now: Date = new Date()): number | null {
  const min = now.getUTCFullYear() - 1;
  const max = now.getUTCFullYear() + 3;

  const nearSeason = text.match(/\b(?:summer|fall|autumn|winter|spring)\s*'?\s*(\d{2,4})\b/i);
  if (nearSeason?.[1]) {
    const y = expandYear(nearSeason[1]);
    if (y >= min && y <= max) return y;
  }

  for (const m of text.matchAll(/\b(20\d{2})\b/g)) {
    const y = Number(m[1]);
    if (y >= min && y <= max) return y;
  }
  return null;
}

function expandYear(raw: string): number {
  const n = Number(raw);
  return raw.length === 2 ? 2000 + n : n;
}

// ---------------------------------------------------------------- position type

const POSITION_PATTERNS: Array<[RegExp, PositionType]> = [
  [/\bco-?op\b/i, 'co_op'],
  [/\bapprentice(ship)?\b/i, 'apprenticeship'],
  [/\bfellow(ship)?\b/i, 'fellowship'],
  [/\bexternship\b|\bjob shadow\b|\bmicro-?internship\b/i, 'externship'],
  [/\bREU\b|\bresearch (assistant|intern|experience)\b/i, 'research'],
  // "program(?:me)?", not "programme?": the bare `?` bound to the final "e" alone, so the
  // pattern matched the British spelling and the typo "programm" while missing "Graduate
  // Program", the way most of the boards this reads from write it. Every spelling of the
  // word in this file has to carry both endings.
  [/\b(new[ -]?grad|graduate program(?:me)?|entry[- ]level)\b/i, 'new_grad'],
  [/\b(rotational|leadership development) program(?:me)?\b/i, 'trainee_program'],
  [/\bintern(ship)?\b/i, 'internship'],
  [/\bseasonal\b/i, 'seasonal'],
  [/\bpart[- ]time\b/i, 'part_time'],
  [/\bvolunteer\b/i, 'volunteer'],
  [/\bcontract(or)?\b|\btemp(orary)?\b/i, 'contract'],
];

export function parsePositionType(title: string, description = ''): PositionType | null {
  // Title first: it is far more reliable than a passing mention in the body.
  for (const [re, type] of POSITION_PATTERNS) if (re.test(title)) return type;
  for (const [re, type] of POSITION_PATTERNS) if (re.test(description.slice(0, 2000))) return type;
  return null;
}

// ---------------------------------------------------------------- work arrangement

/**
 * Postings say "no remote" in far more ways than they say "remote".
 *
 * The negation used to be three literal phrases checked *inside* the plain-"remote" branch,
 * so "Remote work is not available for this position" and "this is not a fully remote role;
 * you will be in office 5 days" both came back as `remote`. For anyone who had turned remote
 * off, eligibility then filtered the posting out and told them "This posting is remote and
 * you have remote turned off." — the exact opposite of what the posting says — and everyone
 * else saw the row labelled "Remote" with its real city thrown away.
 *
 * A denial has to land ON the arrangement, which is a question of grammar and not of
 * distance. The leading form used to be any "no"/"not" within forty characters of the word,
 * so "We do not have an office - this is a remote position", "No relocation support for this
 * remote position" and "There is no fixed schedule for remote team members" were all read as
 * onsite: a genuinely remote posting labelled with the opposite of what it says, ranked lower
 * for it, and shown to the user with a sentence about commuting from their home city. So the
 * negation must either sit against the word with nothing but articles, intensifiers and the
 * other arrangements of a list in between ("not a fully remote role", "no remote or hybrid
 * options"), or attach to a verb that puts an arrangement on the table ("we do not offer
 * remote work", "this position is not eligible for remote work").
 *
 * The window still stops at clause punctuation, so a negation in one sentence cannot cancel a
 * genuine remote offer in the next: "Fully remote. You will not be required to relocate."
 * stays remote. The trailing forms list the words that actually deny an offer, because a bare
 * "not" after "remote" is usually something else entirely — "this role is remote and is not
 * restricted to any state" is an offer, not a denial.
 *
 * Both arrangements are built from one template deliberately. The two lists were written out
 * separately and drifted: hybrid never learned the "unavailable" spelling that remote knew,
 * so "hybrid is unavailable" was read as an offer of hybrid. Anything added here has to hold
 * for every arrangement the word can stand in for.
 */
function denialPatterns(word: string): RegExp[] {
  // What may sit between the negation and the word without changing what is being denied.
  const filler =
    '(?:a|an|the|any|be|being|currently|presently|generally|typically|normally|usually|truly|' +
    'fully|entirely|completely|purely|strictly|100%|remote|hybrid|on-?site|in[- ]office|' +
    'in[- ]person|work from home|wfh|or|and|,)';
  // Verbs that put an arrangement on the table, so negating one denies the offer itself.
  const offers =
    '(?:offer|provid|allow|support|permit|accommodat|consider|entertain|eligible|available|' +
    'open to|able to)\\w*';
  // A negation bound to a verb rather than to whatever noun follows it. "no relocation
  // support" negates the support; "we do not offer" negates the offering.
  const auxNot =
    "(?:(?:do|does|did|is|are|was|were|will|would|ca|could|sha|should|has|have|had)\\s*n(?:o|')?t" +
    "|cannot|can'?t|unable to|never)";
  const denied =
    '(?:not|no longer)\\s+(?:(?:currently|presently|generally|typically|be|being)\\s+){0,2}' +
    '(?:available|offered|permitted|possible|supported|accommodated|considered|entertained|' +
    'eligible|an option)';

  return [
    new RegExp(`\\b(?:no|not|never)\\s+(?:${filler}\\s*){0,4}\\b${word}\\b`, 'i'),
    new RegExp(`\\b${auxNot}\\s+(?:\\w+\\s+){0,2}${offers}\\b[^.;:!?]{0,25}\\b${word}\\b`, 'i'),
    new RegExp(`\\b${word}\\b[^.;:!?]{0,40}\\b${denied}\\b`, 'i'),
    new RegExp(`\\b${word}\\b[^.;:!?]{0,40}\\bunavailable\\b`, 'i'),
  ];
}

const REMOTE_DENIED = denialPatterns('remote');
const HYBRID_DENIED = denialPatterns('hybrid');

/**
 * A remote offer that is fenced to where the APPLICANT may live.
 *
 * The test used to be `/(only|located in|based in)/` run over the whole description, which is
 * a rule about words appearing, not about who they are predicated on. "based in" and "located
 * in" are how a posting states its own headquarters — "fully remote; our company is based in
 * Austin" — and a bare "only" turns up in "apply only through our portal"; each one tagged a
 * genuinely unrestricted remote role as geo-restricted, so eligibility dropped its clean pass
 * to "unknown" and the queue badge asserted a restriction the posting never made. A fence is a
 * requirement placed on the reader — "must reside/live in", "residents of", "open only to" —
 * so only those applicant-facing shapes count, wherever they sit in the text.
 */
const REMOTE_GEO_RESTRICTED =
  /\bmust (?:reside|live|be (?:located|based|a resident))\b|\bresidents? of\b|\bresidents? only\b|\b(?:open|available|eligible) only (?:to|in|for)\b|\bonly (?:open|available|eligible) (?:to|in|for)\b|\b(?:located|based) in\b[^.;!?]{0,40}\bonly\b/i;
// The one shape this deliberately does NOT catch is a bare "<place> only" — "Remote,
// California only" — because recognising an arbitrary place name is a different problem, and
// the previous over-broad `\bonly\b` matched "applicants only" and "full-time only" as
// geographic fences. This only tags the badge; no eligibility rule reads the geo-restriction,
// so the cost of the miss is a slightly less specific label, never a filtered-out posting.

/** A remote claim the posting is making about the job it is advertising. */
const REMOTE_EXPLICIT =
  /\b(?:fully|100%|entirely|completely|permanently|purely|totally)[- ]remote\b|\bremote[- ](?:first|only)\b|\bwork from home\b|\bwfh\b/i;

/**
 * Claims of the form "this role is X" — the posting predicating an arrangement of the opening
 * itself, as opposed to the word turning up somewhere in the prose. The list of nouns is what
 * a posting calls itself; the verb has to sit between the noun and the arrangement, so
 * "unlike our hybrid roles, this position is fully remote" is not a hybrid claim.
 */
function thisRoleIs(arrangement: string): RegExp {
  return new RegExp(
    '\\b(?:this|the|our|one|each|another)\\s+[^.;!?]{0,30}?' +
      '\\b(?:role|position|job|internship|opportunity|posting|program(?:me)?|placement)\\b' +
      '[^.;!?]{0,20}\\b(?:is|are|will be|would be|remains?)\\b[^.;!?]{0,25}' +
      `\\b(?:${arrangement})\\b`,
    'i',
  );
}

const HYBRID_THIS_ROLE = [
  thisRoleIs('hybrid'),
  // A count of days onsite is a hybrid schedule spelled out, whichever side of the word the
  // posting writes it on.
  /\bhybrid\b[^.;!?]{0,40}\b\d\s*(?:days?|x)\b|\b\d\s*(?:days?|x)\b[^.;!?]{0,40}\bhybrid\b/i,
];

const ONSITE_THIS_ROLE = [
  thisRoleIs('on-?site|in[- ]person|in[- ]office|in the office'),
  /\b(?:100%|fully|entirely|completely|strictly|exclusively)[- ](?:on-?site|in[- ]person|in[- ]office)\b/i,
  // Postings address the reader as often as they describe the role, and "you will work
  // on-site five days a week" is as plain a claim as "this role is on-site". Without this
  // frame it counted as no claim at all, so a passing mention of hybrid elsewhere in the
  // description decided the arrangement instead.
  /\byou(?:'ll| will| would)?\s+(?:be\s+)?(?:work(?:ing)?|based|located)\s+(?:\w+\s+){0,2}?(?:on-?site|in[- ]person|in[- ]office|in the office)\b/i,
];

/**
 * Whether one of these claims is made about the job, ignoring any that the posting makes in
 * the same breath as an explicit remote offer. "This role is fully remote, with an in-person
 * onboarding week" is a remote posting with an aside about one week, not a posting that states
 * two arrangements, and treating it as the second would throw away an answer the text gives
 * plainly.
 */
function statedOf(text: string, patterns: RegExp[]): boolean {
  return patterns.some((re) => {
    const m = re.exec(text);
    return m !== null && !REMOTE_EXPLICIT.test(m[0]);
  });
}

/**
 * Which arrangement the posting is claiming for THIS job.
 *
 * Hybrid used to be decided first, on the bare word appearing anywhere in the text, so a
 * single "hybrid" beat an explicit "100% remote": "This internship is 100% remote. Our hybrid
 * employees receive a commuter benefit." was stored as hybrid, and a student with hybrid
 * turned off — the ordinary setting for someone who cannot commute — was told the posting was
 * hybrid and never saw a job they could have taken. The word turns up in benefits paragraphs,
 * in culture prose about other teams, and in comparisons ("unlike our hybrid roles, this
 * position is fully remote"). The same hole ran the other way between remote and onsite: a
 * passing "remote work may be possible later" beat "this position is onsite in Austin", which
 * is the false-remote label the negation rules above exist to prevent.
 *
 * So a claim wins by being about this job, not by being tested first. "Fully remote" and
 * "this role is hybrid" and "3 days a week onsite" are claims; a bare mention is not.
 *
 * A description that states two of them is describing more than one job, and no single answer
 * is true of the one the user is looking at — so the arrangement is left unknown and the row
 * shows a badge. An unknown costs a little ranking; picking one of two stated arrangements
 * filters the posting out of the queue with a confident sentence about it. Hybrid and onsite
 * are not a contradiction — hybrid is the more specific of the two and wins outright.
 */
export function parseWorkArrangement(text: string): WorkArrangement | null {
  // Both denials are settled before any positive branch. "No remote or hybrid options are
  // available." used to short-circuit on the bare word "hybrid" in the first line of the
  // function and never reach a negation check at all.
  const remoteDenied = REMOTE_DENIED.some((re) => re.test(text));
  const hybridDenied = HYBRID_DENIED.some((re) => re.test(text));

  const remoteClaimed = !remoteDenied && REMOTE_EXPLICIT.test(text);
  const hybridMentioned = !hybridDenied && /\bhybrid\b/i.test(text);
  const hybridClaimed = hybridMentioned && statedOf(text, HYBRID_THIS_ROLE);
  const onsiteClaimed = statedOf(text, ONSITE_THIS_ROLE);

  if (remoteClaimed && (hybridClaimed || onsiteClaimed)) return null;

  if (remoteClaimed) {
    return REMOTE_GEO_RESTRICTED.test(text) ? 'remote_geo_restricted' : 'remote';
  }

  // Claims first, in full, before any bare mention is consulted. Ranking the mention above
  // the onsite claim left half the rule unfixed: "This role is onsite in Boston. Our hybrid
  // teams meet on Wednesdays" came back hybrid, so a student who can commute but cannot do
  // a hybrid split was told a job in their own city was out of reach. A bare mention is
  // still worth something — plenty of postings say "hybrid" and nothing else — but only
  // once nothing in the text has claimed anything about this particular role.
  if (hybridClaimed) return 'hybrid';
  if (onsiteClaimed) return 'onsite';
  if (hybridMentioned) return 'hybrid';

  if (!remoteDenied && /\bremote\b/i.test(text)) return 'remote';

  if (/\b(on[- ]site|onsite|in[- ]person|in office|in-office)\b/i.test(text)) return 'onsite';
  if (/\b(field work|travel required|traveling)\b/i.test(text)) return 'field_or_travel';
  // Saying remote is not on offer is itself a statement about where the work happens, even
  // when the posting never writes "onsite" anywhere.
  if (remoteDenied) return 'onsite';
  return null;
}

/**
 * "3 days a week", "2 days per week", "3x/week" — the count, wherever the sentence puts it.
 *
 * The gap between the count and "per week" is where postings write the location, so it has to
 * be wide enough for the longest spelling ONSITE_WORD below accepts plus a word linking it to
 * the count: "in the office" is three words on its own and "working in the office" is four.
 * Two was one short of the article, so "3 days in the office per week" — the one ordering that
 * puts "the" and a trailing "per week" in the same sentence — came back with no number at all,
 * while parseWorkArrangement read that same sentence as hybrid. The posting was then labelled
 * hybrid with the one figure saying how much commuting that means left blank.
 */
const DAYS_A_WEEK = /\b(\d)\s*(?:days?|x)\s*(?:[a-z-]+\s+){0,4}?(?:per|a|each|\/)\s*week/gi;

/** Where the work happens, written the four ways postings write it. */
const ONSITE_WORD = /\b(?:on-?site|in[- ]person|in(?:\s+the)?\s+office|in-office)\b/i;

/** The count is remote days, not onsite ones, when its own words say from-home. */
const REMOTE_WORD = /\b(?:remote|remotely|from home|work from home|wfh)\b/i;

/**
 * How many days a week the role is onsite.
 *
 * The pattern used to demand the location word AFTER "per week", so "3 days onsite per week"
 * and "Hybrid: 3 days in office per week" — the ordering half of real postings use — came
 * back as no answer at all, while parseWorkArrangement called the same sentence hybrid: the
 * posting was labelled hybrid with the one number that says how much commuting it means left
 * blank. Reading the location word on either side is the point; it can also come before the
 * count entirely, as in "Employees are in the office 4 days per week".
 *
 * The word has to be there somewhere, though, and it has to be a whole word. A bare "in" was
 * standing in for "in office", and it matched the "in" inside "internship" — so "This is a
 * 5 days a week internship", which is a full-time job saying so, was recorded as five days
 * of commuting on a hybrid schedule nobody offered.
 */
export function parseHybridDays(text: string): number | null {
  for (const m of text.matchAll(DAYS_A_WEEK)) {
    const start = m.index;
    const end = start + m[0].length;
    // Only the clause the count sits in counts as its context: an office mentioned in the
    // next sentence says nothing about this number.
    const before =
      text
        .slice(Math.max(0, start - 40), start)
        .split(/[.;!?\n]/)
        .pop() ?? '';
    const after = text.slice(end, end + 40).split(/[.;!?\n]/)[0] ?? '';
    // Widening the gap between the count and "per week" to {0,4} let "2 days working from home
    // per week" match, and with "in the office" sitting in the same clause the onsite test
    // below passed on it — so two REMOTE days were recorded as the onsite count and a role
    // that is onsite three days read as onsite two, the flattering direction the old {0,2}
    // correctly declined. When the count's own span names remote, it is not an onsite count.
    if (REMOTE_WORD.test(m[0])) continue;
    if (!ONSITE_WORD.test(m[0]) && !ONSITE_WORD.test(before) && !ONSITE_WORD.test(after)) continue;

    const n = Number(m[1]);
    if (n >= 0 && n <= 7) return n;
  }
  return null;
}

// ---------------------------------------------------------------- dates & duration

/**
 * The term window a posting states for the job, e.g. "June 2027 – August 2027".
 *
 * This took the first "<month> <year> to <month> <year>" anywhere in the text on no terms at
 * all, and a posting dates far more than the job: when it opens applications, how long it
 * reviews them, when decisions go out, when onboarding runs. Everything downstream then reads
 * the result as the term. "Summer 2027 Software Engineering Internship. Applications open
 * March 2027 to June 2027 and are reviewed on a rolling basis." was stored as a term of
 * 2027-03..2027-06, and because those months overlap the Summer 2027 season window the
 * eligibility rule treated them as CORROBORATED — an exact window, the one kind it is allowed
 * to reject on. A student free 2027-06-01 to 2027-08-20, who could have taken that internship
 * outright, was hard-failed with "Overlaps your availability by only about 4.2 weeks; 6 are
 * needed." docs/05 says an inferred window may raise a question and never hard-fail; the way
 * to keep that promise is not to hand the rule a window that was never the term.
 *
 * So a range has to be introduced as the job's own dates (TERM_WINDOW_INTRO) and must not be
 * introduced as anything else the posting dates (NOT_TERM_WINDOW), and the reject wins when
 * both are present — "Applications for this role open March 2027 to June 2027" names the role
 * and is still an application window. Every range in the text gets that look rather than only
 * the first, so "Applications are reviewed on a rolling basis from October 2026 until January
 * 2027. The internship runs June 2027 to August 2027." now finds the real term instead of
 * stopping on the first thing that looked like one. (That loop also fixes a smaller bug of the
 * same shape: a first match whose words are not months — "Fall 2026 to Spring 2027" matches the
 * range pattern and resolves to no months at all — used to abandon the search outright, so a
 * co-op that then spelled its dates out was stored with no term.)
 *
 * A bare "June 2027 - August 2027" with nothing around it now yields null, and that is the
 * intended trade. An unlabelled range is exactly the one this cannot tell from an application
 * window, and the posting's season and year still give the rule an approximate window to work
 * from — which can raise a question but can never reject anyone.
 */
export function parseTermDates(text: string): { start: string; end: string } | null {
  const re =
    /\b([a-z]{3,9})\.?\s+(20\d{2})\s*(?:-|–|—|to|through|until)\s*([a-z]{3,9})\.?\s+(20\d{2})\b/gi;

  for (const m of text.matchAll(re)) {
    const sm = MONTHS[m[1]!.slice(0, 3).toLowerCase()];
    const em = MONTHS[m[3]!.slice(0, 3).toLowerCase()];
    if (!sm || !em) continue;

    // Only the clause the range sits in speaks for it, the same rule parseDurationWeeks and
    // parseCompensation use: a deadline in the next sentence says nothing about these months.
    const before = clauseBefore(text, m.index);
    const after = clauseAfter(text, m.index + m[0].length);

    if (NOT_TERM_WINDOW.test(before) || NOT_TERM_WINDOW.test(after)) continue;
    if (!TERM_WINDOW_INTRO.test(before) && !TERM_WINDOW_INTRO.test(after)) continue;

    return {
      start: `${m[2]}-${String(sm).padStart(2, '0')}`,
      end: `${m[4]}-${String(em).padStart(2, '0')}`,
    };
  }

  return null;
}

const WEEKS_RE = /\b(\d{1,2})\s*[-–]?\s*(?:to\s*)?(\d{1,2})?\s*weeks?\b/gi;
const MONTHS_RE = /\b(\d{1,2})\s*[-–]?\s*(?:to\s*)?(\d{1,2})?\s*months?\b/gi;

/** Wording that makes a span of time the length of the job. */
const TERM_CONTEXT =
  /\b(?:internship|intern program|program(?:me)?|position|role|co-?op|placement|fellowship|apprenticeship|assignment|runs?|running|lasts?|lasting|duration|term|commitment|long|over the summer)\b/i;

/** Wording that makes it the length of something else the posting mentions. */
const NOT_TERM_CONTEXT =
  /\b(?:paid time off|pto|vacation|holidays?|leave|sick|notice|onboarding|orientation|training|ramp[- ]?up|applications?\s+(?:close|closing|open)|deadline|respon(?:se|d)|hear back|review|probation|extension|notice period)\b/i;

/**
 * Wording that introduces a month range as the window the JOB runs in — what parseTermDates
 * above demands before it will call a range the term.
 *
 * The season words are in here because "Summer 2027: June 2027 – August 2027" and "Summer 2027
 * cohort, running June 2027 to August 2027" are ordinary phrasings and the range is the term in
 * both; a season word next to an application word loses anyway, since the reject is tested
 * first.
 */
const TERM_WINDOW_INTRO =
  /\b(?:internships?|interns?|co-?ops?|program(?:me)?s?|placements?|fellowships?|apprenticeships?|externships?|rotations?|cohorts?|sessions?|positions?|roles?|jobs?|assignments?|terms?|semesters?|dates?|duration|runs?|running|ran|lasts?|lasting|starts?|starting|begins?|beginning|scheduled|takes? place|taking place|works?|working|employed|summer|fall|autumn|winter|spring)\b/i;

/**
 * Wording that makes a month range some OTHER window the posting dates.
 *
 * Built on NOT_TERM_CONTEXT because the question is the same one asked of a span of weeks, and
 * the two drifting apart is how this class of bug survives a fix: an onboarding, training or
 * probation window is no more the term when it is written "May 2027 to June 2027" than when it
 * is written "6 weeks". What is added here is the hiring calendar, which a length in weeks
 * rarely describes but a month range constantly does — the reported case was an application
 * window, and the siblings that read exactly the same way are "applications are accepted from
 * September 2026 through November 2026", "the review period runs January 2027 to March 2027",
 * "decisions will be sent March 2027 through May 2027", "interviews take place October 2026 to
 * December 2026", "offers are extended November 2026 through January 2027" and every posting
 * that says applications are read on a rolling basis between two months.
 *
 * `offer` is the one word here that has to be qualified: "This internship offers a placement
 * from June 2027 to August 2027" is a term, so only an offer that is sent, made or extended
 * counts as the hiring calendar.
 */
const NOT_TERM_WINDOW = new RegExp(
  `${NOT_TERM_CONTEXT.source}|` +
    '\\b(?:appl(?:y|ies|ied|ying)|applications?|applicants?|submi(?:t|ts|tted|tting|ssions?)|' +
    'deadlines?|closes?|closed|closing|rolling|interviews?|interviewing|screening|' +
    'assessments?|decisions?|notif\\w*|recruit\\w*|selection|shortlist\\w*|offer letters?|' +
    'offers? (?:are|will|go|made|sent|extended|released))\\b',
  'i',
);

/**
 * How long the job lasts.
 *
 * This used to take the first week or month figure anywhere in the text, which is how "Interns
 * receive 2 weeks of paid time off. The program runs 12 weeks over the summer." became a
 * two-week internship, and "Our onboarding takes 1 week" a one-week one. Nothing filters on
 * the field yet, so today that is a wrong number stored rather than a posting hidden — but the
 * moment a "at least 8 weeks" filter is switched on, every posting that mentions PTO, notice
 * or an application deadline before its own length disappears from the queue.
 *
 * So every figure is weighed the way parseCompensation weighs a dollar amount: the clause
 * around it decides whether it is the term, and the first match only wins when nothing in the
 * text says otherwise.
 *
 * The weighing has to run across both units at once, not inside each one in turn. Weeks used
 * to be tried first and months consulted only when the text held no week figure at all, so
 * "Interns receive 2 weeks of paid time off. The internship runs 3 months." was still a
 * two-week internship: the PTO figure was the only one in weeks, so it won outright without
 * ever being set against the months figure the sentence about the internship carries. A
 * posting that states its own length in a different unit from its leave policy is the ordinary
 * case, not the exception, so both units go into one pool and the best-supported figure wins.
 */
interface Span {
  /** The length in weeks, whichever unit the posting wrote it in. */
  value: number;
  score: number;
  /** Where it sits in the text, so equally-supported figures resolve to the first one. */
  at: number;
}

function spans(text: string, re: RegExp, toWeeks: (avg: number) => number): Span[] {
  const found: Span[] = [];

  for (const m of text.matchAll(re)) {
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    const value = toWeeks((a + b) / 2);
    if (value < 1 || value > 104) continue;

    const before = clauseBefore(text, m.index);
    const after = clauseAfter(text, m.index + m[0].length);
    const score =
      (TERM_CONTEXT.test(before) || TERM_CONTEXT.test(after) ? 1 : 0) -
      (NOT_TERM_CONTEXT.test(before) || NOT_TERM_CONTEXT.test(after) ? 1 : 0);

    found.push({ value, score, at: m.index });
  }

  return found;
}

export function parseDurationWeeks(text: string): number | null {
  // A figure whose only nearby context is a NOT_TERM word scored -1, and the sort below has
  // no sign check — so when a posting's sole span is its PTO, notice period or reply window
  // ("You will hear back within 2 weeks."), that span won the sort and was stored as the job's
  // length. The clause has already said this number is something other than the term; dropping
  // every negative span keeps that "the parsers say null rather than guess" promise instead of
  // recording a length the text explicitly denies.
  const best = [
    ...spans(text, WEEKS_RE, (avg) => Math.round(avg)),
    ...spans(text, MONTHS_RE, (avg) => Math.round(avg * 4.345)),
  ]
    .filter((s) => s.score >= 0)
    .sort((x, y) => y.score - x.score || x.at - y.at)[0];

  return best?.value ?? null;
}

// ---------------------------------------------------------------- compensation

export interface ParsedComp {
  min?: number;
  max?: number;
  currency?: string;
  period?: 'hour' | 'week' | 'month' | 'year' | 'total';
  unpaid?: boolean;
  academicCreditOnly?: boolean;
  raw?: string;
}

/**
 * How a posting can open a money figure: a dollar sign with an optional currency prefix
 * glued to it, or a bare currency symbol.
 *
 * The symbols were missing, so this read dollars and nothing else — "£25 per hour" and
 * "€2,000 per month" both parsed to null, and the posting went into the queue as pay not
 * disclosed. Not an edge case: Ashby alone hands back GBP and SEK on an ordinary board.
 */
/**
 * `£` and `€` only, and the omissions are deliberate.
 *
 * `¥` and `₹` were here and are gone again. The period inference below — under 200 is hourly,
 * under 20,000 monthly, otherwise yearly — is calibrated to currencies whose major unit is
 * within an order of magnitude of a dollar, which is true of the pound and the euro and not
 * remotely true of the yen or the rupee: an ordinary Japanese hourly wage of ¥1,200 came out
 * as ¥1,200 a MONTH, and ¥280,000 a month as a yearly salary. Reading a figure and labelling
 * its period wrong is worse than not reading it, and these two symbols were added on a guess
 * rather than on evidence that these boards carry them. `$` keeps its letter prefixes, which
 * name the currency outright and so need no magnitude guess.
 */
const CURRENCY_TOKEN = '(?:[A-Za-z]{1,3})?\\$|[£€]';

/**
 * A money figure: a currency opener, one or two amounts with an optional "k", and an
 * optional period.
 *
 * The fractional part is `\.\d+` rather than `\.\d{2}`, which is the shape every ATS uses
 * for an abbreviated range. "$211.4K – $290.6K a year" matched only "$211" — two decimal
 * places or nothing — and the "K" was left outside the match, so a posting paying two
 * hundred thousand a year was stored as $211 a MONTH, and the queue showed it that way
 * beside the honest ones.
 */
const MONEY_RE = new RegExp(
  `(${CURRENCY_TOKEN})\\s?([\\d,]+(?:\\.\\d+)?)\\s*(k\\b)?\\s*` +
    `(?:(?:-|–|—|to)\\s*(?:${CURRENCY_TOKEN})?\\s?([\\d,]+(?:\\.\\d+)?)\\s*(k\\b)?)?\\s*` +
    `(?:\\/|per\\s+|an?\\s+)?\\s*` +
    `(hour|hourly|hrs?|week|weekly|wk|month|monthly|mo|day|daily|year|yearly|yr|annually)?`,
  'gi',
);

const PERIOD_BY_UNIT: Record<string, 'hour' | 'day' | 'week' | 'month' | 'year'> = {
  hour: 'hour',
  hourly: 'hour',
  hr: 'hour',
  hrs: 'hour',
  day: 'day',
  daily: 'day',
  week: 'week',
  weekly: 'week',
  wk: 'week',
  month: 'month',
  monthly: 'month',
  mo: 'month',
  year: 'year',
  yearly: 'year',
  yr: 'year',
  annually: 'year',
};

/**
 * What the letters in front of a dollar sign mean. Every figure used to be stamped USD, so
 * a Toronto posting offering CA$30 an hour was recorded as if it paid US dollars.
 */
const DOLLAR_PREFIX: Record<string, string> = {
  us: 'USD',
  usd: 'USD',
  ca: 'CAD',
  cad: 'CAD',
  c: 'CAD',
  au: 'AUD',
  aud: 'AUD',
  a: 'AUD',
  nz: 'NZD',
  nzd: 'NZD',
  sg: 'SGD',
  sgd: 'SGD',
  s: 'SGD',
  hk: 'HKD',
  hkd: 'HKD',
  nt: 'TWD',
  mx: 'MXN',
  r: 'BRL',
};

/** The bare symbols, which name their currency outright rather than qualifying a dollar. */
const SYMBOL_CURRENCY: Record<string, string> = {
  '£': 'GBP',
  '€': 'EUR',
  '¥': 'JPY',
  '₹': 'INR',
};

/**
 * The currency a figure is in, from whatever opened it.
 *
 * USD is still the fallback, because a bare `$` on these boards overwhelmingly is one — but
 * it is now a fallback rather than the only answer this function could give.
 */
function currencyOf(token: string | undefined): string {
  const raw = (token ?? '$').trim();
  const symbol = SYMBOL_CURRENCY[raw];
  if (symbol) return symbol;
  return DOLLAR_PREFIX[raw.replace(/\$$/, '').toLowerCase()] ?? 'USD';
}

/** Words that make the figure a company statistic rather than an offer of pay. */
const NOT_PAY_BEFORE =
  /\b(?:401\s?\(?k\)?|match(?:es|ing|ed)?|revenue|funding|funded|raised|valuation|valued|donat\w*|scholarship|tuition|fees?|prices?|costs?|budget|award|prize|grant|savings|discount|refund|deposit|loan|debt|invest\w*|acquisition|market cap)\b/i;

/** A scale word right after the figure — "$4 billion" is never somebody's wage. */
const MAGNITUDE_AFTER = /^\s*(?:billion|million|trillion|bn|[bm])\b/i;

/**
 * Wording that marks a figure as what the job pays.
 *
 * `receive` earns its place by losing a real case: "You will receive £11.44 per hour" scored
 * the same 2 as a learning budget earlier in the same posting, and the tie goes to whichever
 * comes first in the text, so the perk was stored as the wage.
 */
const PAY_CONTEXT =
  /\b(?:pay|paid|pays|salar(?:y|ies)|compensation|comp|wages?|rates?|stipend|hourly|earn\w*|receiv\w*|remuneration|base|range|offers?)\b/i;

/**
 * Perks quoted in money, which are not what the job pays.
 *
 * A benefits section is full of figures — a learning budget, a wellness allowance, a pension
 * contribution, relocation help — and each one reads to the parser exactly like a wage. This
 * was survivable while only dollars were read, because a US posting's benefits are usually
 * further from the pay line than a European one's; widening to £ and € imported the whole
 * problem into the postings whose real pay the parser previously could not read at all.
 *
 * Tested on both sides of the figure, because these words sit either way round: "£1,000 a
 * year for learning" and "a learning budget of £1,000 a year". `stipend` deliberately stays
 * out — an internship stipend IS the pay — and is only excluded where it is qualified by one
 * of these nouns.
 */
const NOT_PAY_NEAR =
  /\b(?:pension|401\s?\(?k\)?|reimburse\w*|referral|relocation|commuter|per\s?diem|gym|wellness|well-?being|home[- ]office|professional development)\b/i;

/**
 * A sum with a purpose attached, which is what makes it a perk rather than a wage.
 *
 * The noun alone is not enough to judge by, and the first version of this got it wrong in
 * the expensive direction: it excluded `allowance` outright, and "Internship allowance of
 * €2.000 per month" is the ordinary European way of writing an internship's PAY. So the
 * bare nouns above are the ones that are never a wage in any phrasing, and everything else
 * has to name what the money is for.
 */
const PERK_PURPOSE =
  /\b(?:to spend on|towards?|for)\s+(?:your\s+)?(?:learning|development|training|education|wellness|well-?being|equipment|books?|courses?|conferences?|travel|meals?|lunch|coworking)\b/i;

/** One money figure found in the text, with how much reason there is to believe it is pay. */
interface PayCandidate {
  match: RegExpExecArray;
  unit?: 'hour' | 'week' | 'month' | 'year';
  score: number;
}

/**
 * A written figure, read in whichever convention it was written in.
 *
 * This stripped commas and handed the rest to `Number`, which is the US convention and only
 * the US convention. That was survivable while the regex could open on `$` alone; adding the
 * European symbols made it a 1000× defect, because continental postings write the separators
 * the other way round. `"€2.000 per month"` came out as **€2** and `"€9,50 per hour"` as
 * **€950** — both figures a student would have read off the queue and believed.
 *
 * The rule needs no locale, only the string. Two different separators: the LAST one is the
 * decimal point and the other groups thousands, which is true in both conventions
 * ("1,234.56" and "1.234,56"). One kind of separator: exactly three digits behind the last
 * of them is a grouping mark ("2.000", "1,200", "1.234.567"), and anything else is a decimal
 * point ("22.50", "9,50", "211.4"). No money is written to three decimal places, and no
 * grouping mark is followed by one or two digits.
 */
function readFigure(raw: string): number {
  const lastComma = raw.lastIndexOf(',');
  const lastDot = raw.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) {
    const decimal = lastComma > lastDot ? ',' : '.';
    const group = decimal === ',' ? '.' : ',';
    return Number(raw.split(group).join('').replace(decimal, '.'));
  }

  const sep = lastComma >= 0 ? ',' : lastDot >= 0 ? '.' : null;
  if (sep === null) return Number(raw);

  const at = raw.lastIndexOf(sep);
  const tail = raw.slice(at + 1);
  if (tail.length === 3) return Number(raw.split(sep).join(''));
  // The head keeps any earlier separators of the same kind, which are grouping marks
  // whatever this last one turned out to be.
  return Number(`${raw.slice(0, at).split(sep).join('')}.${tail}`);
}

function amount(raw: string, thousands: string | undefined): number {
  const n = readFigure(raw);
  return thousands ? n * 1000 : n;
}

/**
 * The words immediately around a figure, stopping at the sentence it sits in.
 *
 * A flat character window reached across full stops, so "We raised $50 million in Series B.
 * The internship pays $40/hr." threw away the $40 as well: the word "raised" from the
 * previous sentence was still inside the window. Whether a number is a wage is decided by
 * the sentence that number is in.
 */
function clauseBefore(text: string, at: number): string {
  const window = text.slice(Math.max(0, at - 80), at);
  // The colon is not a boundary: "Pay: $30" puts the one word that matters in front of it.
  const cut = window.search(/[.;!?\n][^.;!?\n]*$/);
  return cut === -1 ? window : window.slice(cut + 1);
}

function clauseAfter(text: string, from: number): string {
  const window = text.slice(from, from + 40);
  const cut = window.search(/[.;!?\n]/);
  return cut === -1 ? window : window.slice(0, cut);
}

/** A denial or a comparison in front of a claim — "this is not an unpaid internship". */
const NEGATED_BEFORE =
  /\b(?:no|not|never|neither|nor|isn'?t|aren'?t|wasn'?t|don'?t|doesn'?t|won'?t|unlike|rather than|instead of|other than|as opposed to)\b[^.;!?]{0,30}$/i;

/** Benefits boilerplate that borrows the word: unpaid leave is not an unpaid job. */
const UNPAID_BENEFIT =
  /^\s*(?:\w+[- ]){0,2}(?:leave|time off|pto|vacation|holidays?|volunteer\w*|overtime|absences?|sabbatical|day|days|break)\b/i;

/**
 * Whether the text says the JOB is unpaid.
 *
 * This was a bare `\bunpaid\b` test on the first line of parseCompensation, ahead of all the
 * care below it, so one occurrence of the word anywhere decided the pay. It fired on ordinary
 * benefits boilerplate — "paid and unpaid leave options", "unpaid volunteer days", "we never
 * ask interns to work unpaid overtime" — and on postings denying the thing outright ("this is
 * not an unpaid internship; interns are paid $30/hour"). Each one scored the posting 0.1 on
 * pay and told the user "the pay is low or unpaid" about a job paying $45 an hour.
 *
 * Every occurrence gets a look, because a posting that mentions unpaid leave may also be an
 * unpaid internship, and one clean claim is enough.
 */
function saysUnpaid(text: string): boolean {
  for (const m of text.matchAll(/\bunpaid\b/gi)) {
    const before = clauseBefore(text, m.index);
    const after = clauseAfter(text, m.index + m[0].length);
    if (NEGATED_BEFORE.test(before) || UNPAID_BENEFIT.test(after)) continue;
    return true;
  }
  return false;
}

/**
 * Pulls the pay out of a description.
 *
 * Every parser here would rather say nothing than guess, and this one used to take the
 * first dollar figure anywhere in the text on any terms. "We are a $4 billion company"
 * three paragraphs above a real "$45-$50/hour" range meant the posting was recorded as
 * paying $4 an hour — which scored it near zero on pay and told the user in as many words
 * that "the pay is low or unpaid" on one of the best-paying roles in their queue. A 401(k)
 * match written as "we match $1 for $1" did the same thing.
 *
 * So every figure in the text is considered, the ones that are plainly not wages are
 * discarded, and the one with the best evidence behind it wins: a stated period beats a
 * nearby pay word, which beats a bare number. A bare number on its own still parses, since
 * plenty of postings write nothing but "$30" in a pay field.
 */
export function parseCompensation(text: string): ParsedComp | null {
  const credit = /\b(academic|course|school) credit only\b/i.exec(text);
  if (credit && !NEGATED_BEFORE.test(clauseBefore(text, credit.index))) {
    return { academicCreditOnly: true, raw: 'academic credit only' };
  }

  let best: PayCandidate | null = null;

  for (const m of text.matchAll(MONEY_RE)) {
    const start = m.index;
    const end = start + m[0].length;
    const before = clauseBefore(text, start);
    const after = clauseAfter(text, end);

    if (MAGNITUDE_AFTER.test(after) || NOT_PAY_BEFORE.test(before)) continue;
    // A perk quoted in money, on either side of the figure. See NOT_PAY_NEAR.
    if (NOT_PAY_NEAR.test(before) || NOT_PAY_NEAR.test(after)) continue;
    if (PERK_PURPOSE.test(before) || PERK_PURPOSE.test(after)) continue;

    const unit = m[6] ? PERIOD_BY_UNIT[m[6].toLowerCase()] : undefined;
    // A day rate has nowhere to go: the stored schema has hour, week, month, year and
    // total, and calling $500/day a monthly figure understated it by twenty times in the
    // queue. Saying nothing leaves the pay neutral instead of wrong.
    if (unit === 'day') continue;

    const score = (unit ? 2 : 0) + (PAY_CONTEXT.test(before) || PAY_CONTEXT.test(after) ? 1 : 0);
    if (!best || score > best.score) best = { match: m, unit, score };
  }

  // A bare figure with neither a period nor a pay word behind it is weak evidence — a
  // reimbursement cap or an equipment budget reads the same way — so an unpaid statement
  // still wins over it. A stated wage does not lose to a word.
  if (saysUnpaid(text) && (!best || best.score === 0)) return { unpaid: true, raw: 'unpaid' };

  if (!best) return null;

  const [, opener, rawMin, kMin, rawMax, kMax] = best.match;
  const min = amount(rawMin!, kMin);
  const max = rawMax ? amount(rawMax, kMax) : undefined;

  const period: ParsedComp['period'] =
    best.unit ??
    // No unit given: infer from magnitude. Interns are quoted hourly far more
    // often than annually, and the two ranges don't overlap in practice.
    (min < 200 ? 'hour' : min < 20_000 ? 'month' : 'year');

  const raw = best.match[0]
    .trim()
    .replace(/[\s/]*\b(?:per|an?)$/i, '')
    .replace(/[\s/]+$/, '');

  return {
    min,
    max,
    currency: currencyOf(opener),
    period,
    raw,
  };
}

// ---------------------------------------------------------------- application demands

/**
 * Whether a posting asks for something, given the words it uses for it.
 *
 * Each key used to spell its own rule and each got it wrong in its own direction. The cover
 * letter guard knew "no cover letter" and "optional" but not "a cover letter is not required",
 * the phrasing postings actually use — so a posting saying it does NOT want one was recorded
 * as demanding it. References went the other way and demanded the literal word "required"
 * within thirty characters, which made "References are not required" a demand for references
 * and "please submit a cover letter and two references" — the commonest positive phrasing
 * there is — no demand at all.
 *
 * So mention plus an absence of release is the rule for every key, and the ways a posting
 * releases you from something are written once here rather than three times.
 */
const NOT_DEMANDED =
  /\b(?:not|no longer)\s+(?:(?:currently|strictly|technically|always|be)\s+){0,2}(?:required|necessary|needed|requested|expected|mandatory|obligatory)\b|\boptional\b|\bnot? need(?:ed)?\b|\bwaived\b|\bnice to have\b|\bavailable\s+(?:up)?on request\b/;

/**
 * The same word used for something other than the thing an applicant would hand over.
 *
 * Mention-plus-no-release is the right rule only once the mention is about the applicant's
 * copy of the thing, and three of these five words are ordinary English with a second life in
 * posting boilerplate: a "reference" is the standard word for a requisition number, a
 * "portfolio" is what an investment firm holds, and a "transcript" is what a speech-to-text
 * pipeline produces. Each was recorded as a demand the posting never made.
 *
 * A wrong sense disqualifies the one mention, never the key: `demanded` keeps looking, so a
 * posting that prints "Job Reference: 12345" in its header and asks for three referees in its
 * last paragraph is still read as asking. Both patterns are matched against the clause on that
 * side of the word, so anchor `before` with `$` and `after` with `^`.
 */
interface OtherSense {
  before?: RegExp;
  after?: RegExp;
}

/**
 * "Job Reference: 12345", "please reference job code SWE-2027", "reference checks are run
 * after an offer" — an identifier, a verb, and a step of the hiring process. None of them asks
 * anyone for referees, and "Job Reference" alone is on a large share of ATS postings, so the
 * bare word decided the flag for postings that never raised the subject.
 *
 * The identifier form is recognised by what follows it rather than by the word in front,
 * because "three job references" is the referee sense in the same words — a requisition number
 * is followed by a number, a label like "ID" or "code", or both.
 */
const REFERENCE_NOT_REFEREE: OtherSense = {
  before:
    /\b(?:please|kindly|pls|must|should|shall)\s+$|\b(?:contact|contacts|contacted|contacting|check|checks|checked|checking|call|called|calling|verify|verifies|verified|verifying)\s+(?:(?:your|the|these|those|their|his|her|any)\s+)?$/,
  after:
    /^\s*(?:numbers?|nos?\.?|ids?|codes?|checks?|checking)\b|^\s*(?:the\s+)?(?:job|req|requisition|posting|position|vacancy)\s+(?:numbers?|nos?\b|ids?\b|codes?)\b|^\s*[:#-]?\s*(?:[a-z]{1,5}[-/]?)?\d{3,}\b/,
};

/**
 * On finance, agency and consulting postings the portfolio belongs to the firm: "our portfolio
 * companies", "the client portfolio you will support", "portfolio manager". A design intern is
 * asked for a portfolio; an analyst reading about one is not.
 *
 * The "of ..." release used to fire on `of (our|their|its|the)` with nothing after it, which
 * is exactly how an applicant is asked for their own work in the third person: "a portfolio of
 * their work", "a portfolio of the work you are proud of" — the commonest genuine phrasing of
 * the demand. That swallowed the ask and the user was never warned a portfolio was required. A
 * firm noun has to follow, so "of our clients/funds" still reads as the firm's holdings while
 * "of their/the work" stays the applicant's.
 */
const PORTFOLIO_NOT_APPLICANTS: OtherSense = {
  before:
    /\b(?:investment|investments|client|clients|customer|product|products|loan|credit|equity|asset|assets|brand|brands|stock|fund|funds|company|our|their|its)\s+$/,
  after:
    /^\s*(?:compan(?:y|ies)|managers?|management|analysts?|of\s+(?:our|their|its|the)\s+(?:clients?|companies|compan(?:y|ies)|investments?|funds?|holdings?|assets?|borrowers?|startups?|businesses|properties))/,
};

/** A transcript is an academic record here. It is also what a meeting, a call or a video
 *  produces, and postings at companies that build those tools say so in their prose. */
const TRANSCRIPT_NOT_ACADEMIC: OtherSense = {
  before:
    /\b(?:call|calls|interview|interviews|video|videos|audio|meeting|meetings|podcast|podcasts|recording|recordings|chat|chats|earnings|court)\s+$/,
};

function demanded(text: string, subject: RegExp, otherSense?: OtherSense): boolean {
  // Every mention gets a look. A posting that says a cover letter is optional in its boilerplate
  // and asks for one in the next paragraph is asking for one, and one clean ask is enough.
  for (const m of text.matchAll(new RegExp(subject.source, 'gi'))) {
    // Only the clause the thing is named in can release it: "a cover letter is not required"
    // says nothing about the transcript demanded two paragraphs down.
    const before = clauseBefore(text, m.index);
    const after = clauseAfter(text, m.index + m[0].length);
    // "No cover letter needed" is a release; "applications without a portfolio will not be
    // reviewed" is a demand, so "without" is left alone — it more often names what a posting
    // refuses to accept than what it does not want.
    if (/\bno\s+$/.test(before)) continue;
    if (otherSense?.before?.test(before) || otherSense?.after?.test(after)) continue;
    if (NOT_DEMANDED.test(before) || NOT_DEMANDED.test(after)) continue;
    return true;
  }
  return false;
}

export function parseRequirements(text: string): Record<string, boolean> {
  const t = text.toLowerCase();
  return {
    coverLetter: demanded(t, /cover letter/),
    transcript: demanded(t, /\btranscripts?\b/, TRANSCRIPT_NOT_ACADEMIC),
    portfolio: demanded(t, /\bportfolio\b|\bwork samples?\b/, PORTFOLIO_NOT_APPLICANTS),
    references: demanded(
      t,
      /\breferences?\b|\bletters? of recommendation\b/,
      REFERENCE_NOT_REFEREE,
    ),
    videoInterview: demanded(
      t,
      /\b(video interview|hirevue|one-way interview|recorded interview)\b/,
    ),
  };
}

// ---------------------------------------------------------------- identity helpers

const TRACKING_PARAMS = /^(utm_|gh_src|gh_jid|lever-|ref$|source$|src$|trk$)/i;

/** First dedupe key — see docs/04 § Dedupe. */
export function canonicalUrl(raw: string): string {
  const u = new URL(raw);
  u.hash = '';
  u.protocol = 'https:';
  u.host = u.host.toLowerCase().replace(/^www\./, '');
  for (const key of [...u.searchParams.keys()]) {
    if (TRACKING_PARAMS.test(key)) u.searchParams.delete(key);
  }
  u.searchParams.sort();
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.slice(0, -1);
  return u.toString();
}

/** Requisition ids, roman numerals, and season/year noise — the parts of a title that vary
 *  between two listings of the SAME job. Input must already be lower-cased. */
function stripTitleNoise(s: string): string {
  return s
    .replace(/\b(req|requisition|job)?\s*#?\s*\d{4,}\b/g, ' ')
    .replace(/\b(i{1,3}|iv|v|vi{1,3}|ix|x)\b/g, ' ')
    .replace(/\b(summer|fall|autumn|winter|spring)\b/g, ' ')
    .replace(/\b20\d{2}\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** A requisition id that announces itself — "Req #9931", "Job ID 4471", "#88120". */
const LABELLED_REQ_ID =
  /\b(?:req|requisition|job|posting|position)\.?\s*(?:id|no|number)?\s*#?\s*\d{3,}\b|#\s*\d{4,}\b/g;

/** Only a labelled requisition id counts as noise here — see `fingerprintTitle` for why the
 *  identity form has to keep everything else. Input must already be lower-cased. */
function stripReqIds(s: string): string {
  return s
    .replace(LABELLED_REQ_ID, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Brackets used to be deleted whole, contents and all.
 *
 * On a Greenhouse board the team name is very often the only thing telling two requisitions
 * apart — "Software Engineer Intern (Backend)" and "Software Engineer Intern (Frontend)",
 * "Research Intern [Ads]" and "Research Intern [Payments]". Both collapsed to the same
 * string, so dedupe treated the second as a copy of the first and dropped it: its title,
 * its URL and its description were gone, and the user never learned the role existed.
 *
 * So a bracketed aside is only discarded when what is inside it is pure noise. What counts
 * as noise is the caller's to decide, because the two callers below disagree about it and
 * the disagreement is the whole point: to the identity form, "(Summer 2026)" is the only
 * thing separating two real openings; to the token-matching form it is the sort of detail
 * one board prints and another leaves out.
 */
function unbracket(lower: string, isNoise: (inner: string) => boolean): string {
  const keepIfMeaningful = (_m: string, inner: string): string =>
    isNoise(inner) ? ' ' : ` ${inner} `;
  return lower.replace(/\((.*?)\)/g, keepIfMeaningful).replace(/\[(.*?)\]/g, keepIfMeaningful);
}

/** Aggressive form, for stage-3 token matching: two spellings of one job must land here. */
export function normalizeTitle(title: string): string {
  const isNoise = (inner: string): boolean => stripTitleNoise(inner) === '';
  return stripTitleNoise(unbracket(title.toLowerCase(), isNoise));
}

/**
 * Identity form, for the dedupe fingerprint and the stored `fingerprint` column.
 *
 * Stage 2 merges on this key alone, with no different-source guard, so anything erased here
 * silently costs the user a posting. That is the opposite of what stage 3 needs, which is
 * why this is a separate function: "Machine Learning Intern I" and "... Intern II" are two
 * openings and must keep two rows, and a "Summer 2026" and a "Fall 2026" requisition are
 * the difference between a student being shown a job they can take and being told they are
 * ineligible for the only one left.
 *
 * The term is written inside brackets at least as often as after a dash — "Software Engineer
 * Intern (Summer 2026)" is the ordinary Greenhouse shape — so the bracket rule has to be the
 * strict one here too, or the commonest phrasing of all is exactly the one that loses a row.
 *
 * Being this cautious costs almost nothing. Two boards listing one job under slightly
 * different titles are a different source by definition, and stage 3 still merges them on
 * the aggressive form; the worst this does is leave a duplicate visible.
 */
export function fingerprintTitle(title: string): string {
  const isNoise = (inner: string): boolean => stripReqIds(inner) === '';
  return stripReqIds(unbracket(title.toLowerCase(), isNoise));
}

export function normalizeCompany(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(inc|llc|ltd|corp|corporation|co|gmbh|plc|sa|nv|ag)\b\.?/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
