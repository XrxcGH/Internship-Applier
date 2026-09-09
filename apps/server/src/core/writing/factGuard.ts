/**
 * FactGuard — docs/06 § ④.
 *
 * The reason this tool is safe to point at a job application. Every claim in a draft is
 * checked against the evidence set the draft was built from; anything that cannot be
 * traced is flagged and blocks approval at gate G3.
 *
 * TWO LAYERS, and the order matters:
 *
 *   1. DETERMINISTIC (this file, no model). Durations, GPAs, organisation and institution
 *      names, and skills are extracted from the draft and compared to the evidence. These
 *      are the highest-consequence errors and the ones a model is least reliable at
 *      catching in its own output — "I worked there for two years" when the profile says
 *      three months is a factual claim with a right answer, not a judgement call. No API
 *      key required and fully testable, so the adversarial suite runs on every commit.
 *
 *   2. MODEL (advisory) — BUILT AND TESTED, BUT NOT WIRED IN. Semantic claims the regexes
 *      cannot reach: "I led the migration" when the evidence says "helped with the
 *      migration". `mergeModelVerdicts` below implements the merge policy — the model may
 *      downgrade a verdict, never clear one — and the adversarial suite covers it, but no
 *      production path calls it. Neither `draftAnswer` nor the G3 route produces model
 *      verdicts today, so nothing at runtime ever emits a claim with decidedBy: 'model'.
 *
 *      Said plainly because the alternative is a comment that describes a check the user
 *      is relying on and that does not run: semantic overstatement is caught by the human
 *      at G3 and by nothing else. docs/06 and docs/11 say the same.
 *
 * TWO FAILURE DIRECTIONS, weighted deliberately. A missed fabrication is worse than a
 * spurious flag — but only just. A guard that lights up every other sentence trains the
 * user to click through warnings, which destroys its value entirely. So each check below
 * fires only when it can point at something specific, and the checks that cannot be made
 * precise (durations with no named employer) are deliberately permissive.
 */
import type { ClaimVerdict } from '@ia/shared';
import type { Evidence } from './retrieve';
import { tokens } from './retrieve';

export interface Claim {
  text: string;
  span: { start: number; end: number };
}

export interface CheckedClaim {
  claim: string;
  span: { start: number; end: number };
  verdict: ClaimVerdict;
  /** Which evidence item supports it, when one does. */
  profileRef: string | null;
  /** The supporting evidence text, for the G3 evidence panel. */
  quote: string | null;
  /** Why it failed, in words the user can act on. */
  reason?: string;
  /** Which layer decided. Deterministic verdicts are not overridable by the model. */
  decidedBy: 'deterministic' | 'model';
}

// ─────────────────────────────────────────────── segmentation

/**
 * "St." is an abbreviation, not a full stop. Intl.Segmenter ends a sentence at it, so
 * "St. Sample High School" — one of the most common school-name shapes there is — arrived
 * as two half-claims: the name was never checked whole, the first fragment ("I have
 * volunteered at St.") drew a "loosely tied" amber on a fully true sentence, and in the
 * other direction an invented "St. Jude" employer escaped the invented-org check entirely
 * because each half looked ordinary alone. A segment ending in one of these is glued back
 * to the segment that follows it.
 */
const ABBREVIATION_END =
  /\b(?:St|Mt|Ft|Mr|Mrs|Ms|Dr|Prof|Rev|Jr|Sr|Lt|Sgt|Capt|Col|Gen|vs|No)\.\s*$/;

/**
 * Sentence-level, with clause splitting only where punctuation makes coordination
 * unambiguous (`, and` / `, but` / `; then`). A bare "and" is left alone: splitting
 * "research and development" into two claims invents a fabrication that isn't there.
 * Under-splitting costs little — the deterministic checks scan the whole claim text
 * regardless of how it was cut, and only the lexical score gets diluted.
 */
export function splitClaims(text: string): Claim[] {
  const seg = new Intl.Segmenter('en', { granularity: 'sentence' });
  const sentences: Array<{ text: string; start: number }> = [];
  let offset = 0;

  for (const s of seg.segment(text)) {
    const segment = s.segment;
    const base = text.indexOf(segment, offset);
    if (base < 0) continue;
    offset = base + segment.length;
    if (!/\p{L}/u.test(segment)) continue;

    const prev = sentences[sentences.length - 1];
    if (prev && ABBREVIATION_END.test(prev.text)) {
      prev.text = text.slice(prev.start, base + segment.length);
    } else {
      sentences.push({ text: segment, start: base });
    }
  }

  const out: Claim[] = [];
  for (const { text: sentence, start } of sentences) {
    const parts = sentence.split(/[,;]\s+(?:and then|and also|and|but|then)\s+(?=\p{L})/giu);
    const trimmedParts = parts.map((p) => p.trim()).filter((p) => /\p{L}/u.test(p));

    /**
     * THE FLOOR DECIDES WHETHER TO SPLIT, NEVER WHETHER TO CHECK.
     *
     * It used to `continue` past any part under twelve characters, and because the sentence
     * was never re-checked as a whole, that text was then examined by NO layer of this file:
     * it produced no claim, could not block, and drew no row in the G3 evidence panel. The
     * user read an answer with a green tick on every line it did show.
     *
     * "I ran NASA." is eleven characters. So the invented-employer check — the one the
     * `normalize` comment below calls the worst thing this file can get wrong — never saw the
     * one sentence in the draft that named an employer the profile has never heard of, and
     * draft.ts actively asks the model for short sentences ("Put a four-word sentence next to
     * a twenty-five-word one"), so this is the shape the writer is being told to produce.
     *
     * Falling back to the whole sentence is the safe direction and costs almost nothing: the
     * deterministic checks scan the entire claim text however it was cut, and the header above
     * already records that under-splitting only dilutes the lexical score. Every letter of the
     * input now ends up inside some claim.
     */
    const usable = trimmedParts.length > 1 && trimmedParts.every((p) => p.length >= 12);
    const pieces = usable ? trimmedParts : [sentence.trim()];

    let local = 0;
    for (const trimmed of pieces) {
      if (!/\p{L}/u.test(trimmed)) continue;
      const idx = sentence.indexOf(trimmed, local);
      if (idx < 0) continue;
      local = idx + trimmed.length;
      out.push({ text: trimmed, span: { start: start + idx, end: start + idx + trimmed.length } });
    }
  }
  return out;
}

// ─────────────────────────────────────────────── normalisation

/** Lowercase, strip corporate and academic suffixes, collapse to comparable words. */
export function normalize(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[‘’]/g, "'")
      .replace(/\b(inc|llc|ltd|corp|corporation|co|university|college|school)\b\.?/g, ' ')
      // A possessive before the punctuation strip. The claim side strips "Dean's" down to
      // "dean" when it extracts proper nouns, while this side turned the same word into
      // "dean s" — and that orphaned letter meant "Dean's List" from a draft could never be
      // found inside "Dean's List Semi-Finalist" from the profile, so a true sentence about
      // the user's own award was blocked as an invented name. Both sides now shed the
      // possessive the same way. This is the ONLY place a lone "s" is removed: a blanket
      // `\bs\b` strip that also ran here collapsed a name whose "&" left a real lone letter
      // — "S&P" became "p", dropped below the checkable length, and a FABRICATED "S&P"
      // employer sailed past the invented-employer check with a green tick, the worst thing
      // this file can produce.
      .replace(/'s\b/g, '')
      .replace(/[^a-z0-9+#.]+/g, ' ')
      // An abbreviation dot is not part of the word. The claim side has always shed it —
      // extractProperNouns trims "St." to "St" — while this side kept it, so the profile's
      // own "St. Sample High School" normalised to "st. sample high", the same school in a
      // draft to "st sample high", and the two spellings of one name could never vouch for
      // each other: a true sentence about the student's own school was red at G3, where
      // there is no override. Word-EDGE dots come off on both sides equally; the dot inside
      // "node.js" is part of the name and stays.
      .replace(/(?<=^|\s)\.+|\.+(?=\s|$)/g, '')
      // A trailing plural "s" is not a different word, on ANY word of a name, not only the
      // last. The apostrophe strip above turns "Dean's List" into "dean list", but a draft
      // that writes the same award without the apostrophe — "Deans List" — kept its "s" and
      // read as "deans list", so the two forms of the user's own honor no longer vouched for
      // each other and a true award was blocked at G3 as an invented name. Folding the "s"
      // on both sides makes them match. Applied to both sides equally, so exact names are
      // untouched (they transform identically); only genuine plural/possessive variants
      // converge. Guarded to words of five letters or more that do not already end in "ss",
      // so short acronyms ("aws", "css", "sql") and words like "business" are left alone.
      .replace(/\b([a-z]{4,})s\b/g, (m, stem: string) => (stem.endsWith('s') ? m : stem))
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/**
 * The forms of a phrase that differ only in the number of its last word: "rest api" and
 * "rest apis", "library" and "libraries". Every other word is left exactly as written.
 */
function inflections(phrase: string): string[] {
  const cut = phrase.lastIndexOf(' ');
  const head = cut < 0 ? '' : phrase.slice(0, cut + 1);
  const last = phrase.slice(cut + 1);
  const forms = new Set([last, `${last}s`, `${last}es`]);
  if (last.endsWith('s')) forms.add(last.slice(0, -1));
  if (last.endsWith('es')) forms.add(last.slice(0, -2));
  if (last.endsWith('ies')) forms.add(`${last.slice(0, -3)}y`);
  if (last.endsWith('y')) forms.add(`${last.slice(0, -1)}ies`);
  return [...forms].filter((f) => f.length > 0).map((f) => head + f);
}

/**
 * Word-boundary containment over normalised text. Stops "rust" matching "trust".
 *
 * A trailing plural is not a different fact. A profile whose skills list said "REST APIs"
 * did not support a draft that said "a REST API", so the user was blocked at G3 by a
 * message telling them "REST API" does not appear anywhere on their profile — untrue, about
 * a term one character away, on a screen with no override, and the only remedy it offered
 * (add the fact to your profile) had already been done. The rule is that only the LAST word
 * of a phrase is allowed to differ, and only in its number, singular or plural, whichever
 * side carries the ending.
 */
function containsPhrase(haystack: string, needle: string): boolean {
  if (needle.length === 0) return false;
  const hay = ` ${haystack} `;
  return inflections(needle).some((f) => hay.includes(` ${f} `));
}

/**
 * Spelled-out counts, through ninety.
 *
 * This used to stop at twelve, which made the guard avoidable by anyone who writes numbers
 * out: "I worked at Kestrel Analytics for 20 years" was caught and blocked, while the same
 * sentence written "for twenty years" produced no duration at all, came back amber, and
 * was approvable at G3. The magnitudes worth inventing were exactly the ones missing.
 */
const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};

const TENS = ['twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const ONES = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];

/**
 * The compound form first, so "twenty-five years" is read as twenty-five rather than as a
 * bare "five" with the tens word left behind; then every single word longest-first, so
 * "seventeen" is not read as "seven" trailing a stray "teen".
 *
 * The digit branch carries its decimal tail for the same reason, and this one was worse.
 * "I worked in the lab for 2.5 years" matched at the word boundary between the dot and the
 * five, so a true sentence about a thirty-month job came back red at G3 saying: the draft
 * says "5 years". The user cannot find "5 years" in their draft, because they never wrote
 * it, and there is no override on that screen. It failed the other way round just as
 * quietly — "20.5 years" against a five-year entry also read as five, matched the profile,
 * and was waved through. The rule is that a number and its fractional part are one count,
 * never two, so nothing may be read as a count when a digit or a decimal point sits
 * directly in front of it.
 */
const COUNT_PATTERN = [
  String.raw`\d{1,2}(?:\.\d+)?`,
  String.raw`(?:${TENS.join('|')})[\s-](?:${ONES.join('|')})`,
  ...Object.keys(NUMBER_WORDS).sort((a, b) => b.length - a.length),
].join('|');

/** Digits verbatim; words summed, so "twenty-five" is 25 rather than 20 or 5. */
function countOf(raw: string): number {
  if (/^\d+(?:\.\d+)?$/.test(raw)) return Number(raw);
  return raw
    .toLowerCase()
    .split(/[\s-]+/)
    .reduce((sum, w) => sum + (NUMBER_WORDS[w] ?? 0), 0);
}

/** Months between two YYYY-MM values. */
function monthsBetween(start: string, end: string): number {
  const [sy, sm] = start.split('-').map(Number);
  const [ey, em] = end.split('-').map(Number);
  if (!sy || !sm || !ey || !em) return 0;
  return Math.max(0, (ey - sy) * 12 + (em - sm));
}

function nowYearMonth(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

// ─────────────────────────────────────────────── atom extraction

export interface DurationClaim {
  months: number;
  raw: string;
}

/**
 * "for two years", "over 18 months", "a three-month internship".
 *
 * The trailing "old" is excluded because an age is not a duration of work. Without that,
 * "I'm 19 years old and have been coding since high school" measured nineteen years
 * against the longest entry on the profile and came back red — "The draft says 19 years.
 * The longest matching entry on your profile is about 44 months." — on a sentence that is
 * both true and the most ordinary thing a student can write. The hyphenated adjective
 * ("as a 19-year-old sophomore") failed the same way, which is why the lookahead allows
 * for a hyphen as well as a space.
 */
export function extractDurations(text: string): DurationClaim[] {
  const out: DurationClaim[] = [];
  const re = new RegExp(
    String.raw`\b(?:for|over|across|spent|nearly|almost|about|around)?\s*(?<![\d.])(${COUNT_PATTERN})` +
      String.raw`[\s-]*(year|yr|month|mo|week)s?\b(?![\s-]*old\b)`,
    'gi',
  );

  for (const m of text.matchAll(re)) {
    const n = countOf(m[1]!);
    if (n <= 0) continue;
    const unit = m[2]!.toLowerCase();
    const months = unit.startsWith('y') ? n * 12 : unit.startsWith('w') ? n / 4.345 : n;
    out.push({ months, raw: m[0].trim() });
  }

  out.push(...magnitudeDurations(text), ...rangeDurations(text));
  return out;
}

/**
 * The units a student states a span in when they do not state it in months.
 *
 * The pattern above only fires on a number immediately followed by year/yr/month/mo/week, so
 * a tenure written any other way produced NO DurationClaim at all — and no claim means the
 * whole duration check is skipped, silently. On the project's own release-gate fixture (a
 * two-month internship), "I spent three summers at Kestrel Analytics" and "I worked there for
 * a decade" both came back GREEN with the two-month entry printed underneath as their
 * evidence, while the same sentence written "for six years" was correctly blocked. A guard
 * anyone can walk around by writing the number a different way is not guarding.
 *
 * Each magnitude is the SMALLEST span the word can honestly mean — a summer is the shortest
 * school holiday, a semester one term — so the comparison stays generous to the writer and
 * only a real overstatement can trip it.
 */
const MAGNITUDE_MONTHS: Array<[RegExp, number]> = [
  [/\b(?:a|one)\s+decade\b/gi, 120],
  [/\b(?:half\s+a\s+decade)\b/gi, 60],
  [/\b(COUNT)[\s-]*decades?\b/gi, 120],
  [/\b(COUNT)[\s-]*semesters?\b/gi, 4],
  [/\b(COUNT)[\s-]*(?:school|academic)\s+years?\b/gi, 9],
  [/\b(COUNT)[\s-]*summers?\b/gi, 2],
];

function magnitudeDurations(text: string): DurationClaim[] {
  const out: DurationClaim[] = [];
  for (const [pattern, unitMonths] of MAGNITUDE_MONTHS) {
    const re = new RegExp(pattern.source.replace('COUNT', COUNT_PATTERN), pattern.flags);
    for (const m of text.matchAll(re)) {
      const n = m[1] === undefined ? 1 : countOf(m[1]);
      if (n <= 0) continue;
      out.push({ months: n * unitMonths, raw: m[0].trim() });
    }
  }
  return out;
}

/**
 * A tenure stated the way a resume states it: as the two years it ran between.
 *
 * "I ran the Sample High School Robotics Team from 2020 to 2026" claims six years against an
 * entry the profile records as twenty months, and it came back supported with that entry
 * quoted as its proof. This is the most natural way there is to write a span, and it was the
 * one spelling the check could not see.
 *
 * THE SPAN IS READ AS THE SMALLEST ONE THE YEARS ALLOW, which is what keeps this from
 * becoming a false RED. Bare years say nothing about months, so "from 2024 to 2026" could be
 * anything from thirteen months (December to January) to thirty-five; a student who really
 * was on the team from the autumn of 2024 to the spring of 2026 writes exactly that sentence
 * about twenty real months, and reading it as the full twenty-four would block them at a gate
 * with no override. Taking one whole year off the difference means no true sentence is ever
 * measured as longer than it was, while "2020 to 2026" is still sixty months and still caught.
 */
const YEAR_RANGE =
  /\b(?:from\s+)?(19|20)(\d{2})\s*(?:-|–|—|to|until|through|thru)\s*(?:(19|20)(\d{2})|present|now|today)\b/gi;

function rangeDurations(text: string, now = new Date()): DurationClaim[] {
  const out: DurationClaim[] = [];
  for (const m of text.matchAll(YEAR_RANGE)) {
    const start = Number(`${m[1]}${m[2]}`);
    const end = m[3] ? Number(`${m[3]}${m[4]}`) : now.getUTCFullYear();
    const years = end - start;
    if (years <= 0) continue;
    // One year of slack, never below a single month: the claim is real, its length is not
    // knowable to better than a year, and the doubt goes to the writer.
    out.push({ months: Math.max(1, (years - 1) * 12), raw: m[0].trim() });
  }
  return out;
}

/**
 * The denominator of "3.968/4.0" or "3.968 out of 4", and the tail of "on a 4.000 scale".
 *
 * The numerator carries up to three decimals because transcripts print three, and the mask
 * has to see the whole numerator or it does not fire. When this capped the numerator at two
 * decimals while the number-leading pattern below read three, "I graduated with a 3.968/4.0
 * GPA" slipped the mask: the scale on the far side of the slash was left in place, read as a
 * second claimed GPA of 4, and a literally-true sentence came back blocking at G3 with a
 * message asserting a "4" the user never wrote. The denominator accepts its own decimals
 * ("4.0", "4.00", "4.000") so "on a 4.000 scale" is masked as a scale and not counted.
 */
const GPA_SCALE_TAIL = /\b(\d\.\d{1,3})\s*(?:\/|out of)\s*(?:4|5)(?:\.\d{1,3})?\b/gi;
const GPA_SCALE_PHRASE = /\bon\s+a\s+\d(?:\.\d{1,3})?[\s-]*(?:point\s*)?scale\b/gi;

/**
 * Nouns that make a nearby whole number a count of something rather than a grade. "GPA
 * (last 2 years): 3.4" and "My GPA in my last 2 years was 3.4" both used to hand back the
 * 2 — the first number within twelve characters of the label — and the user was blocked at
 * G3 with "The draft says GPA 2; your profile says 3.4", which is not a sentence they can
 * act on because they never claimed a GPA of 2.
 */
const COUNT_NOUN_TAIL =
  /^\s*(?:year|semester|quarter|term|month|week|credit|hour|course|class)e?s?\b/i;

/** A grade, not an SAT score or a year: one leading digit, or any decimal under ten. */
const isGradeShaped = (token: string): boolean =>
  token.includes('.') ? Number(token) < 10 : token.length === 1;

/**
 * Every number this returns is a GPA the draft CLAIMS, so a scale must never come back.
 *
 * The scale is blanked out — padded with spaces, so no other match shifts — before the two
 * value-reading patterns run. Without that, "I graduated with a 3.62/4.0 GPA" hands the
 * number-leading pattern a clean "4.0 GPA" on the far side of the slash, and the draft
 * reads as claiming a 4.0 alongside the 3.62. That used to be papered over at comparison
 * time by treating the scale as an acceptable value, which exempted it everywhere rather
 * than only where it was a denominator: an invented "I hold a perfect 4.0 GPA" on a 3.62
 * profile came back green, with the profile line that says 3.62 attached beside it as its
 * supporting quote. On a 4.0 scale that was the one wrong GPA the guard let through, and
 * it is the one a person inflating their record would actually type.
 */
export function extractGpas(text: string): number[] {
  const out: number[] = [];
  const masked = text
    .replace(GPA_SCALE_TAIL, (m, value: string) => value.padEnd(m.length, ' '))
    .replace(GPA_SCALE_PHRASE, (m) => ' '.repeat(m.length));

  // "GPA: 3.62", "my GPA is a 3.9", "GPA (last 2 years): 3.4". Read forward to the end of
  // the clause and take the first number that can be a grade, rather than the first number
  // full stop — a count of years or semesters routinely sits between the label and the
  // value, and skipping it also stops the real GPA behind it from going unchecked.
  for (const label of masked.matchAll(/\bgpa\b/gi)) {
    const from = label.index + label[0].length;
    const window = masked.slice(from, from + 40).split(/[.!?;](?=\s|$)/)[0]!;
    for (const n of window.matchAll(/\b\d+(?:\.\d+)?\b/g)) {
      if (!isGradeShaped(n[0])) continue;
      if (!n[0].includes('.') && COUNT_NOUN_TAIL.test(window.slice(n.index + n[0].length)))
        continue;
      out.push(Number(n[0]));
      break;
    }
  }
  // "3.9 GPA", "3.9 cumulative GPA", "3.968 weighted GPA" — the number can lead. Three
  // decimals, because transcripts print three: while this read two, "I have a 3.968 GPA"
  // extracted nothing at all, so the guard neither confirmed the true figure nor caught an
  // invented one — the number most worth checking was the one shape it could not see.
  for (const m of masked.matchAll(/\b(\d\.\d{1,3})\s+(?:\w+\s+){0,2}gpa\b/gi))
    out.push(Number(m[1]));
  // "3.45/4.0", "3.45 out of 4" — the numerator only, read from the unmasked text.
  for (const m of text.matchAll(GPA_SCALE_TAIL)) out.push(Number(m[1]));
  return [...new Set(out)];
}

/**
 * Capitalised words that are not proper nouns. Only ones that plausibly open a sentence
 * or follow a comma need to be here — mid-sentence capitals in English prose are
 * overwhelmingly names.
 */
const COMMON_CAPITALS = new Set(
  (
    'i we my our the a an this that it they he she there here his her its ' +
    'and but or so if then now yet also still just when while where because since ' +
    'after before during although though however whether what how why which who ' +
    'last next every each most both one two three four five several many some ' +
    'working building learning studying writing given having being doing using ' +
    'january february march april may june july august september october november december ' +
    'monday tuesday wednesday thursday friday saturday sunday ' +
    'summer spring fall autumn winter today yesterday tomorrow ' +
    'instead rather besides meanwhile later once twice often sometimes always never ' +
    'perhaps maybe within without between among across over under ' +
    // Prepositions that open a sentence. "At ICDC, I advanced to the finals" is the most
    // ordinary way a competition student opens a sentence, and with "At" missing here the
    // pair was extracted as a two-word name — mixed case, so the acronym skip never fired
    // — and "At ICDC" was reported as an invented organisation on a profile whose honors
    // print "(ICDC)" verbatim. Peeling only trims run EDGES, so "University of Akron"
    // keeps its interior "of".
    'at as in on by of to for from with ' +
    // Contraction stems: what "Don't" or "Wasn't" reduces to once its tail is removed by
    // `withoutTail`. Without these a negated sentence opener reads as a company name.
    'do does did don doesn didn won couldn shouldn wouldn isn aren wasn weren haven ' +
    'hasn hadn let'
  ).split(' '),
);

/**
 * A capitalised run, up to seven tokens.
 *
 * The cap was four, and organisations a young applicant belongs to are routinely longer:
 * "Sample Composite Squadron of Civil Air Patrol" was cut in half, and the front half —
 * "Sample Composite Squadron of Civil", a string the student never typed — was quoted back
 * at them in a blocking `unsupported` at G3, about their own unit. Ordinary capitalised
 * words are peeled off either end afterwards, so a longer cap costs nothing in the other
 * direction: a run that swallows a sentence-initial "The" or a trailing "June" still loses
 * them before anything is compared.
 */
const NAME_RUN = /\b[A-Z][\w&.'-]*(?:\s+(?:of\s+)?[A-Z][\w&.'-]*){0,6}/g;

/**
 * Trailing punctuation belongs to the sentence, not the name. Without this, a name at the
 * end of a sentence arrives as "TypeScript." and matches nothing on the profile — which
 * looks exactly like a fabrication.
 */
const trimEdges = (w: string): string => w.replace(/^[.'&-]+/, '').replace(/[.'&-]+$/, '');

/**
 * The word without its contraction or possessive tail.
 *
 * Two bugs lived here, and the first was severe. `normalize` turns an apostrophe into a
 * space, so "I've" became "i ve" — which is not in COMMON_CAPITALS, so it was treated as
 * a proper noun, found nowhere on the profile, and marked `unsupported`. That is a
 * BLOCKING verdict: any answer that opened "I've been writing Python since..." could not
 * be approved at G3. Naturally written prose was the failure case.
 *
 * The second is quieter but wrong in the other direction: "Google's search team" gave
 * "google s", which matches no employer, so a genuine fabrication about a real company
 * could be reported against the wrong name. Taking the head of the word fixes both.
 */
const withoutTail = (w: string): string => w.replace(/[’'](s|ve|m|re|ll|d|t)?$/i, '');

/**
 * Names in the shape of an employer, school, product, or technology.
 *
 * Ordinary capitalised words are peeled off either end of a run, so "Working at Acme
 * Analytics" yields "Acme Analytics" rather than a run that matches nothing.
 */
export function extractProperNouns(text: string): string[] {
  const out = new Set<string>();

  for (const m of text.matchAll(NAME_RUN)) {
    let words = m[0].split(/\s+/);

    // Contraction, possessive and punctuation tails come off before the ordinary-word
    // check, or "I've" survives it as a name (see `withoutTail`) and so does any ordinary
    // word ending a sentence: "I started there in June." reached the check as "June." —
    // which is not in the list below — and was reported as an invented organisation.
    words = words.map((w) => trimEdges(withoutTail(w)));

    let peeledFromFront = 0;
    while (words.length > 0 && COMMON_CAPITALS.has(normalize(words[0]!))) {
      words = words.slice(1);
      peeledFromFront++;
    }
    while (words.length > 0 && COMMON_CAPITALS.has(normalize(words[words.length - 1]!))) {
      words = words.slice(0, -1);
    }

    // A lone capitalised word that opens the sentence is not a name. English capitalises
    // the first word of every sentence, so "Growing up, I fixed computers for my
    // neighbours" arrived as a claim about an employer called Growing, matched nothing on
    // the profile, and could not be approved at G3 — where there is no override. The words
    // that can open a sentence are the whole language, so the list below was never going
    // to finish: Getting, Debugging, Throughout, Beyond, Nothing, Everything and hundreds
    // more each blocked an honest draft. Checked after the peel, because "Everything I
    // know about SQL" is a two-word run that becomes the same lone opener once the "I"
    // comes off, and only when nothing was peeled off the FRONT, since "The Learning
    // Center" leaves a word that is not the one the sentence started with.
    //
    // What this gives up: a one-word employer mentioned ONLY as the first word of a
    // sentence. A real name almost always arrives as a multi-word run ("Kestrel
    // Analytics") or sits somewhere other than position 0 ("a team of six at Palantir"),
    // and both are still caught.
    // An ALL-CAPS acronym is exempt: English capitalises sentence openers, it does not
    // upper-case them, so "FBLA employed me for the whole summer" is naming an organisation
    // and "Growing up, I fixed computers" is not. Dropping FBLA here made the passive
    // sentence invisible to every check below, and an award-vouched organisation was handed
    // a job the student never held. Nothing is lost in the other direction: a bare acronym
    // is only ever read as an organisation when the sentence puts the writer inside it, so
    // "SQL is the language I use most" still passes untouched.
    const acronymOpener = /^[A-Z][A-Z0-9]{1,5}$/.test(words[0] ?? '');
    if (m.index === 0 && peeledFromFront === 0 && words.length === 1 && !acronymOpener) continue;

    const name = words.filter(Boolean).join(' ').trim();
    if (name.length > 2 && normalize(name).length > 1) out.add(name);
  }
  return [...out];
}

/** Technologies presented as things the writer has used. */
export function extractClaimedSkills(text: string): string[] {
  const out = new Set<string>();
  const re =
    /\b(?:using|used|use|with|in|built\s+(?:in|with)|written\s+in|experience\s+(?:in|with)|proficient\s+(?:in|with)|familiar\s+with|worked\s+(?:in|with))\s+([A-Z][\w+#.]*)/g;
  for (const m of text.matchAll(re)) {
    const s = trimEdges(m[1]!);
    if (s.length > 1 && !COMMON_CAPITALS.has(normalize(s))) out.add(s);
  }
  return [...out];
}

// ─────────────────────────────────────────────── deterministic pass

const FIRST_PERSON = /\b(i|i'm|i've|i'd|i'll|me|my|mine|we|we've|our)\b/i;

/**
 * A duration only means "how long I did this" when the sentence is about doing
 * something. Without this, "I've followed Acme for ten years" gets measured against an
 * internship and flagged as inflated.
 *
 * Two vocabularies, because the ceiling pool differs (see the duration check):
 *
 *   - WORK_CONTEXT is holding a role: employment, service, membership. This list once
 *     held only office and engineering verbs (worked, interned, coded, built...), so
 *     "I tutored / coached / volunteered / served / performed there for five years" —
 *     the way a clubs-and-activities resume actually states tenure — was never measured
 *     at all, and a five-year claim against an eleven-month entry came back green with
 *     the real entry quoted beside it as proof.
 *   - PRACTICE_CONTEXT is doing a thing rather than holding a post ("writing code for
 *     three years", "played clarinet for six years"): still a checkable duration, but
 *     legitimately bounded by the longest thing on the profile, schooling included.
 */
const WORK_CONTEXT =
  /\b(work(?:ed|ing|s)?|intern(?:ed|ing|ship)?|employ(?:ed|ment)|role|position|job|tenure|led|ran|taught|teach(?:ing)?|tutor(?:ed|ing)?|coach(?:ed|ing)?|volunteer(?:ed|ing)?|mentor(?:ed|ing)?|serv(?:e|ed|ing)|shadow(?:ed|ing)|member(?:ship)?)\b/i;

const PRACTICE_CONTEXT =
  /\b(spent|studi(?:ed|es|ing)|experience|program(?:med|ming)|cod(?:ed|ing)|develop(?:ed|ing|ment)|build(?:ing)?|built|us(?:ed|ing)|writing|wrote|research(?:ed|ing)?|perform(?:ed|ing)|s(?:a|u)ng|sing(?:ing)?|play(?:ed|ing)?|act(?:ed|ing)|rehears(?:ed|ing|al)|danc(?:ed|ing)|march(?:ed|ing)|direct(?:ed|ing)|conduct(?:ed|ing)|compet(?:ed|ing|e)|attend(?:ed|ing)?)\b/i;

/**
 * Holding a credential. Its own vocabulary because it belongs to neither list above:
 * "certified" once sat in WORK_CONTEXT, so "I have been CPR certified for three years" was
 * measured against the longest JOB on the profile and blocked at G3 — a first-aid card is
 * not a job, and the student who has one usually has no job long enough to clear it. It
 * still has to be MEASURED, though, or an invented decade of licensure goes unchecked: the
 * ceiling is the certification's own date, and an undated one falls back to the whole
 * profile rather than to work alone.
 */
const CERT_CONTEXT =
  /\b(certified|certification|licen[cs]ed|licen[cs]e|accredited|credential(?:ed|s)?)\b/i;

/**
 * Knowing OF a place rather than working at one. "I have followed Kestrel Analytics for ten
 * years" names an entry and states a span while claiming no tenure whatever, and measuring
 * it against that entry would block a true sentence at G3 with no override.
 */
const ADMIRATION_FRAME =
  /\b(follow(?:ed|ing|s)?|admir(?:e|ed|ing)|watch(?:ed|ing|es)?|heard (?:of|about)|known (?:of|about)|been a (?:fan|customer|user|reader|subscriber|follower))\b/i;

/** The titles a name arrives under when the name belongs to a person. */
const HONORIFIC =
  /^(?:mr|mrs|ms|miss|mx|dr|prof|professor|coach|sir|dame|rev|father|sister|rabbi|imam|sgt|capt|lt|officer|coach)\b/i;

/**
 * The words that introduce somebody the writer knows, rather than somewhere they worked.
 *
 * "my physics teacher, Mrs. Delgado" and "my coach Alvarez" are the same sentence with and
 * without the title, and a young applicant writes it both ways. The possessive is required:
 * "the teacher" introduces nobody in particular, and "Sample High School's teacher" is not
 * the shape anyone writes.
 */
const KNOWS_A_PERSON =
  /\b(?:my|our)\s+(?:[\w-]+\s+){0,2}(?:teacher|coach|mentor|professor|instructor|tutor|advis[eo]r|counsell?or|principal|manager|supervisor|boss|parent|mother|father|mom|dad|grandmother|grandfather|aunt|uncle|cousin|sibling|brother|sister|friend|classmate|teammate|neighbou?r|doctor|nurse|pastor|rabbi|imam)s?\b[\s,'’-]*$/i;

/**
 * Whether this name is a person the writer named, rather than an organisation they claim.
 *
 * Two forms: the name carries its own title ("Mrs. Delgado"), or the words immediately in
 * front of it say who they are to the writer ("my physics teacher, Delgado"). Only the text
 * BEFORE the name is read for the second form, so a company that merely follows a relative
 * in some other sentence cannot borrow the exemption.
 */
function namesAPerson(claim: string, rawName: string): boolean {
  if (HONORIFIC.test(rawName.trim())) return true;
  const at = claim.toLowerCase().indexOf(rawName.toLowerCase());
  if (at < 0) return false;
  return KNOWS_A_PERSON.test(claim.slice(0, at));
}

/**
 * Words that make a duration about schooling, so the degree span may bound it even when
 * an employment verb also appears ("I worked on my thesis while studying there for four
 * years"). Bare "school" is deliberately NOT here: it names places as often as it names
 * studying — "I have worked at the school store for four years" is a work claim through
 * and through, and the word "school" in the store's name was enough to hand it the
 * education ceiling back.
 */
const STUDY_CONTEXT =
  /\b(stud(?:y|ied|ies|ying)|attend(?:ed|ing)?|enroll(?:ed|ment)?|schooling|class(?:es|work)?|course(?:s|work)?|semester|grade|gpa|graduat(?:e|ed|ing|ion))\b/i;

/**
 * Sentences of intent or feeling rather than fact. Only consulted when the sentence
 * contains nothing checkable at all — see `isVerifiableClaim`.
 */
const OPINION_MARKER =
  /\b(want|wanted|hope|hoping|wish|would love|would like|excited|eager|interested|drawn to|passionate|believe|think|feel|admire|appreciate|curious|looking forward|aim to|plan to|goal|attracted)\b/i;

/**
 * "I <did> <something>" — an assertion that the writer performed an act.
 *
 * This is the gate on whether weak lexical support is allowed to BLOCK. Low overlap on
 * "I wrote a distributed key-value store" is a fabricated project and has to be red. Low
 * overlap on "It was not glamorous work" is a person describing how a job felt, and
 * flagging that red teaches the user to ignore the guard — which is the one outcome that
 * makes every other check here worthless. Evaluative and copular sentences get amber.
 */
const ACTION_CLAIM =
  /\b(?:i|we)\s+(?:\w+ly\s+)?(?:have\s+|had\s+|also\s+)?(?:built|wrote|created|designed|developed|led|managed|shipped|launched|implemented|architected|founded|ran|organized|organised|published|presented|won|earned|received|completed|deployed|maintained|migrated|automated|scaled|reduced|increased|improved|taught|tutored|mentored|interned|worked|studied|researched|analyzed|analysed|tested|debugged|refactored|optimized|optimised|contributed|coded|programmed)\b/i;

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * "I interned at Acme", "I worked for Acme", "I spent two years at Acme" — the writer
 * placing their own history inside an organisation.
 *
 * Every verb here is past tense, and the only prepositions accepted are "at" and "for",
 * because the sentences this must NOT match are the ordinary content of a why-this-company
 * answer: "I want to intern at Acme", "I would love to work for Acme", "I have admired
 * Acme for years", "I worked with the Acme API on a side project". Those are wishes and
 * mentions, not claims of employment.
 */
/**
 * The verb list is what decides whether a bare acronym is an employer or a technology, so
 * it has to cover how people actually write about a job.
 *
 * Seven past-tense verbs was too narrow in both tense and vocabulary. "I am interning at
 * NCSA", "my internship at NASA", "I spent last summer at JPL" and "during my time at
 * MITRE" are all employment claims about an all-caps name, and every one of them slipped
 * the frame and was waved through unchecked — which is the direction that matters, because
 * this branch exists to let a technology past and a fabricated employer must not ride
 * along with it. The present and continuous forms and the noun forms are here for that
 * reason; "I deployed it to AWS" still names no affiliation and is still left alone.
 */
/**
 * Wanting the job, which is the whole point of the answer and is not a claim of having had it.
 *
 * The frame below grew present-tense and bare verb forms so "I am interning at NCSA" and "my
 * internship at NASA" would stop being waved through, and in growing them it started matching
 * the four sentences its own docstring promises it must not: "I want to intern at Acme", "I
 * would love to work for Acme", "I am applying for an internship at Acme", "my interest in an
 * internship at Acme". Those are the ordinary content of a why-this-company answer — the
 * employer name is the one thing the question is about — and every one of them came back
 * BLOCKING at G3 saying "your profile has no experience there. Say what draws you to them
 * instead", printed against a sentence already doing exactly that. G3 has no override, so the
 * only way out was deleting the sentence that answered the question.
 *
 * A veto rather than a narrowing of the frame, in the same shape as ADMIRATION_FRAME above:
 * the employment reading stays as sharp as it was, and a sentence that also carries intent is
 * read as the wish it is. `apply/applying` is here for the same reason — applying FOR a role
 * at a company is the opposite of having held one.
 */
const INTENT_FRAME =
  /\b(?:want(?:ed|s)?|wish(?:ed|es)?|hop(?:e|ed|es|ing)|plan(?:ned|s|ning)?|like|love|eager|keen|excited|thrilled|look(?:ing)? forward|aim(?:ing|s)?|intend(?:ing|s)?|plan(?:ning)?|plans?|plan|appl(?:y|ying|ied|ication)|seek(?:ing|s)?|plan to|plan on|would love|goal|ambition|dream|interest(?:ed)?)\b/i;

const affiliationFrame = (name: string): RegExp =>
  new RegExp(
    String.raw`(?:` +
      // I/we + an employment verb: "I interned at NASA", "we spent last summer at JPL".
      // "study" is a NOUN as often as a verb, and the noun sits in front of a preposition
      // that belongs to something else: "I wrote the Ferndale study guide for Disease
      // Detectives" read as employment at Disease Detectives, and once an employment frame
      // stops free prose from vouching, that true sentence about the student's own bullet
      // came back blocking at G3 with no override. The bare form now has to be followed by
      // a preposition of its own, which is what makes it the verb.
      // Split by verb, because the prepositions are not interchangeable. "with" was added so
      // "I was employed by FBLA" would stop escaping the frame, and the generic verbs took it
      // too — so "I worked with the Google Maps API on my trail project" read as employment AT
      // Google Maps API, prose vouching switched off, and a true sentence about the student's
      // own project came back blocking at G3 with the project description sitting in the
      // evidence saying "built with the Google Maps API". That is the fourth sentence this
      // frame's docstring promises never to match. Working WITH a thing is using it; interning
      // or volunteering WITH an organisation is holding a place in it.
      String.raw`\b(?:i|we)\b[\w\s,'’-]{0,30}?\b(?:intern(?:ed|ing|s)?|join(?:ed|ing)?|serv(?:ed|ing)?|hired|employed|volunteer(?:ed|ing)?|apprenticed)\b` +
      String.raw`[\w\s,'’-]{0,25}?\b(?:at|for|with|by|under)\s+` +
      String.raw`|` +
      String.raw`\b(?:i|we)\b[\w\s,'’-]{0,30}?\b(?:work(?:ed|ing|s)?|stud(?:ied|ying|y(?=\s+(?:at|in|abroad)\b))|spent|spend(?:ing)?)\b` +
      String.raw`[\w\s,'’-]{0,25}?\b(?:at|for|by|under)\s+` +
      String.raw`|` +
      // A stint the writer calls their own: "my internship at NASA", "my time at MITRE".
      String.raw`\b(?:my|our)\b[\w\s,'’-]{0,20}?\b(?:internship|apprenticeship|fellowship|placement|role|position|job|time|tenure|summer|semester)\b` +
      String.raw`[\w\s,'’-]{0,25}?\b(?:at|for|with|by|under)\s+` +
      String.raw`|` +
      // "I did an internship at NASA", "I had a fellowship at JPL", "I completed the
      // apprenticeship at MITRE" — the plainest way to state a stint, and the verb branch
      // above misses it because did/had/completed/finished are too generic to list beside
      // the ordinary "I had trouble with SQL". So only an unambiguous stint noun after
      // "i/we ... a/an/the" carries the claim here; the vaguer nouns (role, time, summer)
      // stay behind the "my/our" anchor to keep "I had a great time with SQL" from reading
      // as employment at SQL.
      String.raw`\b(?:i|we)\b[\w\s,'’-]{0,25}?\b(?:an?|the)\b[\w\s,'’-]{0,10}?\b(?:internship|apprenticeship|fellowship|placement|job|position|shift)\b` +
      String.raw`[\w\s,'’-]{0,25}?\b(?:at|for|with|by|under)\s+` +
      String.raw`)` +
      // Only the determiner is shared now; each branch above carries its own prepositions,
      // because "with" belongs to interning and not to working. "I interned at THE Plano Star
      // Courier" fell out of the frame entirely before a determiner was allowed here — and
      // outside the frame an award, or a passing mention in somebody else's bullet, was
      // allowed to vouch for a job the student never held.
      String.raw`(?:(?:the|a|an|my|our|its|their)\s+)?` +
      escapeRegExp(name) +
      String.raw`|` +
      // The passive-agent order, where the organisation is the subject: "FBLA employed me
      // for the summer", "the Plano Star Courier hired me in June". No i/we precedes the
      // verb, so every branch above misses it.
      escapeRegExp(name) +
      String.raw`\b[\w\s,'’-]{0,20}?\b(?:employ(?:ed|s)?|hire[ds]?|took me on|brought me on|paid me)\b[\w\s,'’-]{0,10}?\b(?:me|us)\b` +
      String.raw`|` +
      escapeRegExp(name) +
      String.raw`\b[\w\s,'’-]{0,10}?\b(?:employed|hired|paid)\s+(?:me|us)\b`,
    'i',
  );

/**
 * A run made only of short all-caps words: API, CSV, SQL, REST API, HTTP.
 *
 * Written this way a name is as often a file format, a protocol or a language as it is an
 * employer, and nothing about the letters themselves can tell the two apart. Anything with
 * an ordinary word beside it — "IBM Research", "Kestrel Analytics" — is a name and does not
 * come through here.
 */
const isAcronymRun = (raw: string): boolean =>
  /^[A-Z][A-Z0-9]{1,4}(?:\s+[A-Z][A-Z0-9]{1,4})*$/.test(raw);

/**
 * "Ohio" and "OH" are one place. Resumes abbreviate the state, essays spell it out, and a
 * profile holding only the abbreviation blocked "I live in Springfield, Ohio." at G3 as an
 * invented name — a true sentence about the writer's own home. The abbreviated direction
 * ("OH" against a profile that spells it out) is already saved by the acronym-run skip.
 *
 * The lookup key is built through `normalize` at load, because the plural fold rewrites
 * several state names ("illinois" → "illinoi") and a raw-string key would silently stop
 * matching the claim side.
 */
const US_STATE_NAMES: Array<[string, string]> = [
  ['alabama', 'AL'],
  ['alaska', 'AK'],
  ['arizona', 'AZ'],
  ['arkansas', 'AR'],
  ['california', 'CA'],
  ['colorado', 'CO'],
  ['connecticut', 'CT'],
  ['delaware', 'DE'],
  ['florida', 'FL'],
  ['georgia', 'GA'],
  ['hawaii', 'HI'],
  ['idaho', 'ID'],
  ['illinois', 'IL'],
  ['indiana', 'IN'],
  ['iowa', 'IA'],
  ['kansas', 'KS'],
  ['kentucky', 'KY'],
  ['louisiana', 'LA'],
  ['maine', 'ME'],
  ['maryland', 'MD'],
  ['massachusetts', 'MA'],
  ['michigan', 'MI'],
  ['minnesota', 'MN'],
  ['mississippi', 'MS'],
  ['missouri', 'MO'],
  ['montana', 'MT'],
  ['nebraska', 'NE'],
  ['nevada', 'NV'],
  ['new hampshire', 'NH'],
  ['new jersey', 'NJ'],
  ['new mexico', 'NM'],
  ['new york', 'NY'],
  ['north carolina', 'NC'],
  ['north dakota', 'ND'],
  ['ohio', 'OH'],
  ['oklahoma', 'OK'],
  ['oregon', 'OR'],
  ['pennsylvania', 'PA'],
  ['rhode island', 'RI'],
  ['south carolina', 'SC'],
  ['south dakota', 'SD'],
  ['tennessee', 'TN'],
  ['texas', 'TX'],
  ['utah', 'UT'],
  ['vermont', 'VT'],
  ['virginia', 'VA'],
  ['washington', 'WA'],
  ['west virginia', 'WV'],
  ['wisconsin', 'WI'],
  ['wyoming', 'WY'],
];
const STATE_ABBREV = new Map(US_STATE_NAMES.map(([name, ab]) => [normalize(name), ab]));

/** All-caps tokens of two to six letters read as initialisms; everything else is a word. */
const ACRONYM_TOKEN = /^[A-Z]{2,6}$/;

/** Words an expansion may bridge without consuming an initial: "Bank of America" → "BofA". */
const EXPANSION_SKIP = new Set(['of', 'the', 'and', 'for', 'in', 'at', 'to']);

/**
 * Whether a claimed name matches a full name on the profile once its all-caps tokens are
 * read as initialisms. "Model UN" is how every MUN student writes the Model United Nations
 * Club; "NSDA Academic All-American" is how the National Speech & Debate Association
 * abbreviates its own award — and both were blocked at G3 as invented names while the full
 * form sat on the profile. Only the profile's structured names and honors are searched,
 * never free prose, so a coincidental run of prose initials cannot spell a fabricated
 * employer into existence.
 */
function initialismVouched(rawName: string, fullNames: string[]): boolean {
  interface Part {
    letter?: string;
    word?: string;
  }
  const parts: Part[] = rawName.split(/\s+/).flatMap((w): Part[] =>
    ACRONYM_TOKEN.test(w)
      ? [...w.toLowerCase()].map((letter) => ({ letter }))
      : normalize(w)
          .split(' ')
          .filter(Boolean)
          .map((word) => ({ word })),
  );
  if (!parts.some((p) => p.letter !== undefined) || parts.length < 2) return false;

  const fits = (candidate: string, p: Part): boolean =>
    p.letter !== undefined ? candidate.startsWith(p.letter) : candidate === p.word;

  return fullNames.some((full) => {
    const words = full.split(' ').filter(Boolean);
    outer: for (let start = 0; start < words.length; start++) {
      let i = start;
      for (const p of parts) {
        while (i < words.length && EXPANSION_SKIP.has(words[i]!) && !fits(words[i]!, p)) i++;
        if (i >= words.length || !fits(words[i]!, p)) continue outer;
        i++;
      }
      return true;
    }
    return false;
  });
}

/**
 * Words that say how far the student actually got.
 *
 * Dropping one of these turns a placing into a win, and the word-subset rule above cannot
 * see the difference: "NSPA Individual Awards Honorable Mention, Feature Story of the Year"
 * contains every word of "NSPA Feature Story of the Year", so a draft claiming the outright
 * award was vouched for by the honorable mention and came back GREEN with the mention quoted
 * underneath as its support — the screen telling the reader it checks out. An award is one
 * of the few things on a young applicant's resume an employer can verify in a minute, so
 * this is the overstatement least worth letting through.
 *
 * Every alternative here is tested against `normalize`d text as well as raw, and normalize
 * turns punctuation into spaces. The first version wrote `runner-?up`, which matches
 * "runner-up" and "runnerup" but NOT the "runner up" that normalize actually produces — so
 * the commonest placing after second place was silently dead, and a runner-up written up as
 * an outright win came back green with the runner-up line quoted as its proof. Any
 * alternative with internal punctuation has to spell it `[ -]?`.
 */
const RANK_QUALIFIER = new RegExp(
  '\\b(?:' +
    [
      'honou?rable mention',
      '(?:semi[ -]?|quarter[ -]?)?finalists?',
      'runners?[ -]?up',
      'participants?',
      'nominees?|nominated',
      'qualifiers?|qualified for',
      'commended|shortlisted|alternate',
      // Placings by number and by metal. A profile reading "Second Place" is not diminished
      // by any of the words above, so "I won the state tournament" against it came back
      // green — the same false green the honorable mention produced, one step further up
      // the podium. Anything that is not first is a placing; "1st place" is deliberately
      // NOT here, because a first place is the win and must not be read as short of one.
      //
      // The ordinals run to twentieth and "top N" takes words as well as digits, because the
      // first version stopped at fifth and at digits: "Sixth Place", "Ninth Place" and
      // "Top Ten" were all read as outright wins — the same false green, further down the
      // results sheet, on a profile that says plainly what happened.
      '(?:second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth)\\s+place',
      '(?:[2-9]|\\d\\d+)(?:st|nd|rd|th)\\s+place',
      'top\\s+(?:\\d+|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty|twenty[ -]five|fifty|half)',
      '(?:silver|bronze)\\s+medal(?:l?ists?)?',
    ].join('|') +
    ')\\b',
  'i',
);

/**
 * Words that say the student came FIRST.
 *
 * One honor line routinely records two facts — "Regional Science Fair 1st Place, State
 * Qualifier", "Lincoln-Douglas Debate Champion, TOC Qualifier (2026)" — because extraction
 * is required to copy honors verbatim and that is how a results sheet is written. Reading
 * such a line as a placing on the strength of the word "Qualifier" alone inverted the whole
 * check: a student who WON was told at G3 that their own sentence was a placing dressed up
 * as a win, with no override, and with the remedy the message offers ("say it the way the
 * profile does") already satisfied. A win that qualifies you for the next level is the
 * commonest shape a real competitive honor takes.
 */
const WIN_MARK =
  /\b(?:champions?(?:hips?)?|winners?|won|first place|1st place|gold medal(?:l?ists?)?|grand prize|top prize|best in show|best of show|valedictorian|outstanding)\b/i;

/** An honor the profile records as short of first, and not also as a win. */
function isPlacing(honorNorm: string): boolean {
  return RANK_QUALIFIER.test(honorNorm) && !WIN_MARK.test(honorNorm);
}

/**
 * Connectors that carry no identity. Dropped from BOTH sides of the organisation-name
 * comparison so that word order is all that differs, never the joining words.
 */
const NAME_CONNECTORS = new Set(['of', 'the', 'and', 'at', 'in', 'for', 'a', 'an']);

const nameWords = (norm: string): string[] =>
  norm.split(' ').filter((w) => w.length > 0 && !NAME_CONNECTORS.has(w));

/** Every word of the claimed name inside ONE known name. See the call site for why. */
function nameVouched(norm: string, knownNames: Set<string>): boolean {
  const words = nameWords(norm);
  if (words.length < 2) return false;
  return [...knownNames].some((k) => {
    const known = new Set(nameWords(k));
    return known.size >= 2 && words.every((w) => known.has(w));
  });
}

/**
 * Does this sentence claim to have WON the thing it just named?
 *
 * The first version asked a much cheaper question — is there a win word anywhere in the
 * sentence, and does it name something the profile records as a placing — and the answer was
 * yes for a great many sentences that claim no award at all. Honors are conventionally
 * written "<Organisation> <Rank>", so merely NAMING the club in a sentence that uses "won" in
 * its everyday transitive sense satisfied both halves. All of these were hard-blocked at G3
 * with "say it the way the profile does", which is unactionable advice about a sentence that
 * is not about the honor:
 *
 *     "I won a spot on the Sample Speech Team after two rounds of tryouts."
 *     "I won the Sample Speech Team over with one argument about school lunches."
 *     "I won two of my four Lincoln-Douglas Debate rounds that weekend."
 *     "What I love about Lincoln-Douglas Debate is that the best argument wins."
 *     "The Sample Speech Team was the best in the district that year."
 *
 * The bare word "championship" was worse still, because it fired on the EVENT's name rather
 * than on any claim at all: "I placed 2nd at the ProStart Invitational California State
 * Championship" was called an overstatement of a 2nd-place finish. Nearly every competition a
 * young applicant enters is named a Championship.
 *
 * So the win language now has to GOVERN the name: sit immediately before it with nothing but
 * determiners between, or trail it as a title. Winning someone OVER is excluded outright.
 */
const WIN_GOVERNS_BEFORE = [
  // "I won the X", "we won this year's X". Only determiners may sit between.
  /\b(?:won|win|winning)\s+(?:(?:the|a|an|my|our|its|their|this|that|last|next|both|two|three|all)\s+)*$/i,
  // "first place at the X", "took 1st in the X", "came in first at X".
  /\b(?:first|1st)\s+place\s+(?:at|in|of|for)\s+(?:the\s+)?$/i,
  /\b(?:took|placed|finished|came\s+in|earned|got|claimed)\s+(?:first|1st)(?:\s+place)?\s+(?:at|in|of|for)\s+(?:the\s+)?$/i,
  // "champion of the X", "winner of the X".
  /\b(?:champions?|winners?)\s+(?:of|at|in)\s+(?:the\s+)?$/i,
  /**
   * The ways of saying "first" without the word.
   *
   * Only the four shapes above fired, so a student the profile records at 2nd or 3rd could
   * write "I swept the Oregon State Science Fair", "I topped the Oregon State Science Fair",
   * "my team came out on top at the Oregon State Science Fair", "I was the top finisher at
   * the Oregon State Science Fair" or "I beat everyone at the Oregon State Science Fair" and
   * every one came back GREEN with the third-place honor quoted underneath as its proof — a
   * fabricated win, on its way to an employer, wearing the profile's own evidence.
   *
   * These stay as tight as the four above: the phrase has to run straight into the name, so
   * an intervening qualifier keeps a sentence that may well be true. "I was the top finisher
   * from my school at the Oregon State Science Fair" does not match, and should not — a third
   * placing can be the best in a school. "I topped my personal best at the Oregon State
   * Science Fair" does not match either, because what is topped is the personal best.
   */
  /\b(?:swept|topped|dominated)\s+(?:(?:the|this|that|last|next|our|my)\s+)*$/i,
  /\bcame\s+out\s+on\s+top\s+(?:at|in|of)\s+(?:the\s+)?$/i,
  // "the top finisher at the X". The article and the placement noun are BOTH required: a bare
  // "best at the X" also matches "I topped my personal best at the X", which claims no placing
  // at all and was blocked at G3 while this pattern was loose enough to reach it.
  /\bthe\s+(?:top|best|highest)[\s-]*(?:finisher|scorer|scoring|placing|ranked|team|entry|project)\s+(?:at|in|of)\s+(?:the\s+)?$/i,
  /\b(?:was|were|am|is)\s+the\s+best\s+(?:at|in)\s+(?:the\s+)?$/i,
  /\bbeat\s+(?:everyone|everybody|all\s+(?:the\s+)?(?:others|teams|schools)|the\s+(?:whole\s+)?field)\s+(?:at|in)\s+(?:the\s+)?$/i,
];

/** "the X champion", "the X title" — the win word trailing the name instead of leading it. */
const WIN_GOVERNS_AFTER = /^\s*(?:champions?(?:hips?)?|winners?|title)\b/i;

/** Winning someone OVER is not winning anything. */
const WIN_DISCLAIMED_AFTER = /^\s*over\b/i;

function claimsOutrightWin(claim: string, rawName: string): boolean {
  const at = claim.toLowerCase().indexOf(rawName.toLowerCase());
  if (at < 0) return false;
  const after = claim.slice(at + rawName.length);
  if (WIN_DISCLAIMED_AFTER.test(after)) return false;
  const before = claim.slice(0, at);
  return WIN_GOVERNS_BEFORE.some((re) => re.test(before)) || WIN_GOVERNS_AFTER.test(after);
}

/**
 * "Championship" and "Champion" are the same award. `normalize` already folds a plural, but
 * the -ship nominal survived it, so a profile reading "Math League Champion" could not
 * vouch for a draft reading "I won the Math League Championship" and the student's own win
 * was blocked at G3 as an invented name. Applied to BOTH sides identically, so this can
 * only ever merge two spellings of one word — it never lets two different words match.
 * Deliberately not in `normalize`: employer names run through that too, and "Champion
 * Motors" is not "Champions Sports".
 */
function awardWord(w: string): string {
  return w.length > 6 ? w.replace(/ship$/, '') : w;
}

export interface HonorPhrase {
  norm: string;
  words: Set<string>;
}

/**
 * An award written short. The profile holds "NSPA Individual Awards Honorable Mention,
 * Feature Story of the Year (2024)"; the student writes "an NSPA Honorable Mention", or
 * leads with the story part. Awards lived only in the education evidence TEXT — never in
 * the structured names — so they got none of the shortening allowances organisation and
 * school names have always had, and any interior-word omission or reorder was reported as
 * an invented name at G3, sometimes quoting a mangled fragment the user never wrote.
 * Every word of the claimed name must appear in ONE honor; recombining words across two
 * different honors still fails.
 */
function awardVouched(norm: string, honors: HonorPhrase[]): boolean {
  const words = norm.split(' ').filter(Boolean).map(awardWord);
  if (words.length === 0) return false;

  return honors.some((h) => {
    if (!words.every((w) => h.words.has(w))) return false;
    // A claim that keeps the qualifier is the same fact stated shorter, and still vouches.
    return !isPlacing(h.norm) || RANK_QUALIFIER.test(norm);
  });
}

export interface DeterministicResult {
  verdict: ClaimVerdict | null;
  reason?: string;
  profileRef?: string;
  quote?: string;
}

/**
 * Returns a verdict only when it can prove something. `null` means "nothing checkable
 * here" and defers to the lexical pass — silence is never approval.
 *
 * `contextNames` are the company being applied to and the title of the role. The answer is
 * allowed to NAME them even though they are nowhere on the profile. Without that, every
 * answer that mentioned the employer it was addressed to came back with a blocking
 * `"Stripe" does not appear anywhere on your profile` — and naming the company is the most
 * ordinary thing a "why this company" answer can do. There is no override at G3, and the
 * only remedy that message leaves open is to put the company on the profile — which means
 * inventing a job there, the exact harm this file exists to prevent.
 *
 * Mentioning is all they buy. "I interned at Stripe" is still red, because that is a claim
 * about the writer's history and the profile does not contain it — see `affiliationFrame`.
 */
export function checkClaimDeterministically(
  claim: string,
  evidence: Evidence[],
  contextNames: string[] = [],
): DeterministicResult {
  const normEvidence = normalize(evidence.map((e) => e.text).join(' \n '));

  // Names the profile actually contains, from its structured fields.
  const knownNames = new Set<string>();
  for (const e of evidence) {
    for (const n of [e.facts.organization, e.facts.institution, e.facts.title]) {
      const norm = n ? normalize(n) : '';
      if (norm) knownNames.add(norm);
    }
  }

  // Awards, as structured phrases rather than only prose — see `awardVouched`. The raw
  // spelling and the owning ref are kept beside the normalised form so the rank check
  // below can quote the profile's own wording back at the user.
  const honors = evidence
    .flatMap((e) =>
      (e.facts.honors ?? []).map((raw) => ({ ref: e.ref, raw, norm: normalize(raw) })),
    )
    .filter((h) => h.norm.length > 1)
    .map((h) => ({ ...h, words: new Set(h.norm.split(' ').filter(Boolean).map(awardWord)) }));
  const honorPhrases = honors.map((h) => h.norm);

  // Names the application supplies. Kept apart from the profile's own, because they are
  // mentionable but not claimable.
  const contextNorms = contextNames.map(normalize).filter((n) => n.length > 1);

  const claimedNames = extractProperNouns(claim)
    .map((raw) => ({ raw, norm: normalize(raw) }))
    .filter((n) => n.norm.length > 1);

  // ── durations. "Two years" against a three-month internship is the classic inflation.
  const durations = extractDurations(claim);
  if (durations.length > 0 && FIRST_PERSON.test(claim)) {
    const dated = evidence
      .filter((e) => e.facts.startDate)
      .map((e) => ({
        ref: e.ref,
        kind: e.kind,
        text: e.text,
        months: monthsBetween(e.facts.startDate!, e.facts.endDate ?? nowYearMonth()),
        names: [e.facts.organization, e.facts.institution, e.facts.title]
          .filter((v): v is string => Boolean(v))
          .map(normalize),
      }));

    // Scope to the entity the claim names, when it names one the profile knows. An
    // unscoped claim is measured against the longest span on the profile — permissive on
    // purpose, since "three years of Python" isn't tied to any single entry.
    //
    // Whole words here too, for the same reason as the organisation check below: a bare
    // `includes` let a claim naming MIT scope itself to an entry at "Summit Labs" and take
    // that entry's ceiling.
    // The entry whose NAME the claim uses — the profile's own spelling standing whole inside
    // the sentence, or shortened by the writer. Whole words, never bare letters, or a claim
    // naming MIT scopes itself to an entry at "Summit Labs" and takes that entry's ceiling.
    const namesThis = (names: string[]): boolean =>
      claimedNames.some((c) => names.some((n) => n === c.norm || containsPhrase(n, c.norm)));

    /**
     * The other direction, and ONLY when the first found nothing.
     *
     * "Editor-in-Chief of The Sample Sentinel" arrives as a single capitalised run, because
     * the masthead's own name begins with a capital "The" — so it is longer than the title
     * and longer than the organisation, matched neither, scoped to nothing, and the sentence
     * escaped the duration check entirely: nine years against an eleven-month post came back
     * green. Reading the profile's name INSIDE the claimed one recovers it.
     *
     * It is a fallback rather than an equal, because a longer claimed name routinely contains
     * a DIFFERENT entry's name: "Sample High School Store" contains "Sample High School", and
     * as an equal it scoped a two-year claim about a nine-month shop job to the four-year
     * school entry and returned it clean. Whichever entry the claim names outright wins.
     */
    const namedInside = (names: string[]): boolean =>
      claimedNames.some((c) => names.some((n) => n.length > 2 && containsPhrase(c.norm, n)));

    const byName = dated.filter((d) => namesThis(d.names));
    const scoped = byName.length > 0 ? byName : dated.filter((d) => namedInside(d.names));

    /**
     * A credential is a date, not a span, and an UNDATED one bounds nothing at all.
     *
     * When the claim names a certification the profile holds but never dated, the fallback
     * measured it against the longest other entry — so "I have been CPR certified for three
     * years" was blocked at G3 by a two-month camp counsellor job. The entry the sentence is
     * actually about is right there and simply has no date on it; the honest answer is that
     * this is not checkable, not that it is false. A dated certification is still measured
     * (it lands in `scoped`), and a claim naming no certification still falls back.
     */
    const undatedCredential =
      CERT_CONTEXT.test(claim) &&
      !WORK_CONTEXT.test(claim) &&
      scoped.length === 0 &&
      evidence.some(
        (e) =>
          e.kind === 'certification' &&
          !e.facts.startDate &&
          namesThis(
            [e.facts.title, e.facts.organization]
              .filter((v): v is string => Boolean(v))
              .map(normalize),
          ),
      );

    // A work-duration claim is bounded by work, not by school. The unscoped pool used to
    // include the education entries, and every young applicant carries a roughly four-year
    // high-school span — often ending at a graduation that has not happened yet — so
    // "I have worked as a swim coach for four years" cleared a 56-month ceiling set by the
    // SCHOOL entry while the longest actual job was 26 months. For exactly the population
    // this tool serves, invented work tenure up to the length of a school career was never
    // caught. Claims about schooling itself ("I studied there for three years") still
    // measure against the degree.
    const workClaim = WORK_CONTEXT.test(claim) && !STUDY_CONTEXT.test(claim);
    const pool =
      scoped.length > 0 ? scoped : dated.filter((d) => !(workClaim && d.kind === 'education'));

    /**
     * Whether this sentence carries a tenure claim worth measuring at all.
     *
     * The vocabularies above are lists of VERBS, and the dominant tenure shape on a
     * clubs-and-titles resume uses no verb but the copula: "I have been the Team Captain of
     * the Esports Club for six years", "I was the Drum Major for four years", "I have been a
     * Cadet Commander in Civil Air Patrol for six years". None of them matched any list, so
     * `extractDurations` found the seventy-two months and the result was thrown away unread,
     * and the sentence went on to score well lexically against the very role line that
     * contradicts it — a green tick at G3 with a twelve-month entry quoted underneath as its
     * proof. Naming an entry the profile actually holds is a better signal than any verb
     * list: if the sentence names it and states a span, it is a claim about that span.
     *
     * Admiration is carved back out, because "I have followed Kestrel Analytics for ten
     * years" names an entry and states a span without claiming a day of tenure there.
     */
    const namesAnEntry = scoped.length > 0 && !ADMIRATION_FRAME.test(claim);
    const measurable =
      WORK_CONTEXT.test(claim) ||
      PRACTICE_CONTEXT.test(claim) ||
      CERT_CONTEXT.test(claim) ||
      namesAnEntry;

    if (pool.length > 0 && measurable && !undatedCredential) {
      const longest = pool.reduce((x, y) => (y.months > x.months ? y : x));
      // 25% plus a month of slack — people round honestly, and everyone calls a ten-week
      // internship "three months".
      const ceiling = Math.max(longest.months * 1.25, longest.months + 1);
      const over = durations.find((d) => d.months > ceiling);
      if (over) {
        return {
          verdict: 'overstated',
          reason:
            `The draft says "${over.raw}". The longest matching entry on your profile is ` +
            `about ${Math.round(longest.months)} month${Math.round(longest.months) === 1 ? '' : 's'}.`,
          profileRef: longest.ref,
          quote: longest.text,
        };
      }
    }
  }

  // ── GPA. A number with exactly one right answer.
  const gpas = extractGpas(claim);
  if (gpas.length > 0) {
    const known = evidence.filter((e) => e.facts.gpa).map((e) => ({ ref: e.ref, ...e.facts.gpa! }));
    if (known.length === 0) {
      return {
        verdict: 'unsupported',
        reason: 'The draft states a GPA, but there is no GPA on your profile to check it against.',
      };
    }
    // Every extracted number has to match a GPA the profile holds. The scale gets no
    // exemption here — "a perfect 4.0" against a 3.62 profile is a fabrication like any
    // other. It is `extractGpas` that keeps a denominator from ever arriving as a claim.
    //
    // The weighted figure counts as one the profile holds. A transcript line reading
    // "4.321 weighted, 3.968 unweighted" is two true numbers about one student, and while
    // only the unweighted one was consulted, writing the weighted one blocked approval at
    // G3 with a message insisting the profile said otherwise — about the higher number,
    // the one an applicant most wants to state.
    const wrong = gpas.find(
      (g) =>
        !known.some(
          (k) =>
            Math.abs(k.value - g) < 0.005 ||
            (k.weighted !== undefined && Math.abs(k.weighted - g) < 0.005),
        ),
    );
    if (wrong !== undefined) {
      // Cite the entry closest to the number the draft wrote, not always known[0]. A student
      // with two degrees on file would otherwise be told their draft disagrees with an
      // unrelated entry's GPA. And name the weighted figure when the profile holds one: the
      // message used to say only the unweighted 3.968, steering the user to rewrite toward
      // the lower number and discard the true, higher 4.321 weighted GPA they are entitled
      // to state.
      const distance = (k: (typeof known)[number]): number =>
        Math.min(
          Math.abs(k.value - wrong),
          k.weighted !== undefined ? Math.abs(k.weighted - wrong) : Infinity,
        );
      const k = known.reduce((a, b) => (distance(b) < distance(a) ? b : a));
      const held =
        k.weighted !== undefined
          ? `${k.value} (${k.weighted} weighted) on a ${k.scale}-point scale`
          : `${k.value} on a ${k.scale}-point scale`;
      return {
        verdict: 'unsupported',
        reason: `The draft says GPA ${wrong}; your profile says ${held}.`,
        profileRef: k.ref,
      };
    }
  }

  // ── organisations, schools, products. The invented-employer case.
  for (const { raw, norm } of claimedNames) {
    // Whole words, never bare letters. This used to be a plain `includes` both ways, so any
    // invented employer whose spelling happened to swallow a short name from the profile
    // was accepted in silence: a student with MIT on their profile could write "I interned
    // at Smith Barney last summer" and the guard raised nothing, because "smith barney"
    // contains "mit". "Summit Consulting" passed the same way, "Metaphor Systems" passed on
    // a profile holding Meta, and "Sapient" on one holding SAP. Green ticks on fabricated
    // employers are the worst thing this file can produce, because G3 is where the user
    // decides they have nothing left to check.
    //
    // The rule: one name vouches for another only when it appears inside it as a whole
    // word.
    const matches = (pool: string[]): boolean =>
      pool.some(
        (k) =>
          k === norm ||
          // "Rutgers" standing in for "Rutgers Learning Center" — the profile's own entity,
          // shortened by the writer.
          containsPhrase(k, norm) ||
          // "MIT Media Lab" built out of "MIT" — a division of somewhere the writer really
          // is. Two-letter runs get no say here, because the profile's titles land in this
          // pool alongside its employers and a "TA" or an "RA" would otherwise vouch for
          // any company that happens to start with those letters as a word.
          (k.length > 2 && containsPhrase(norm, k)),
      );

    /**
     * An AWARD vouches for a name being mentioned; it never vouches for having WORKED there.
     * Neither does a MENTION IN PASSING inside somebody else's bullet.
     *
     * Winning a Future Business Leaders of America event puts "Future Business Leaders of
     * America" on the profile, and its initialism is "FBLA" — so "I had an internship at
     * FBLA", a job the student never held, came back green with the award as its support.
     * The same shape covers every acronym-named organisation a student competes under: NHS,
     * DECA, HOSA, CSPA. An honor is evidence of an achievement, and an employment sentence
     * is a different claim about a different fact, so when this name sits inside an
     * employment frame only the profile's real organisations and institutions may speak for
     * it. Outside such a frame ("I competed at FBLA"), the honor is exactly the right
     * evidence and still counts.
     *
     * The prose of the evidence needed the same rule and did not have it, which was worse,
     * because a young applicant's bullets are full of other people's organisations: the
     * newspaper on the paper route, the food bank a church group drove donations to, the
     * hospital a Scout troop served, the supplier a restaurant orders from. "Mow lawns for
     * fourteen households and deliver the Plano Star Courier on weekends" was accepted as
     * proof of "I interned at the Plano Star Courier for two years" — a green tick on
     * fabricated employment, with the delivery bullet quoted underneath as its evidence.
     * Naming the place is still free; claiming a job there is not.
     */
    // Wanting the job is not having had it. See INTENT_FRAME: without this veto the
    // commonest sentence in a why-this-company answer was refused at a gate with no override.
    const claimsEmployment = affiliationFrame(raw).test(claim) && !INTENT_FRAME.test(claim);

    if (matches([...knownNames])) continue;
    if (!claimsEmployment && containsPhrase(normEvidence, norm)) continue;

    // A spelled-out state whose abbreviation the profile prints. The abbreviation must
    // appear capitalised in the raw evidence, so the preposition "in" can never vouch for
    // Indiana or an "or" for Oregon.
    const stateAb = STATE_ABBREV.get(norm);
    if (stateAb && evidence.some((e) => new RegExp(`\\b${stateAb}\\b`).test(e.text))) continue;

    /**
     * The student's own organisation, written in a different order.
     *
     * A cadet writes their unit first and the parent body second — "the Sample Composite
     * Squadron of Civil Air Patrol" — while the resume line reads "Civil Air Patrol, Sample
     * Composite Squadron". Organisation names had no reordering allowance at all (only
     * honors did), so the student's own unit was reported as an invented name at G3 where
     * there is no override. Scouting ("Sample District Chapter of the Order of the Arrow")
     * and FFA ("Sample County Chapter of Future Farmers of America") are written the same
     * way. Every word of the claimed name has to sit inside ONE known name, so words cannot
     * be recombined across two different organisations, and both sides need at least two
     * words so a single word can never buy a whole name.
     */
    if (nameVouched(norm, knownNames)) continue;

    const vouchers = claimsEmployment ? knownNames : [...knownNames, ...honorPhrases];

    // The standard short form of a name the profile holds in full — "Model UN" for the
    // Model United Nations Club, "NSDA Academic All-American" for the association's award.
    if (initialismVouched(raw, [...vouchers])) continue;

    // An award shortened or reordered by its writer, matched word-for-word inside one honor.
    if (!claimsEmployment && awardVouched(norm, honors)) continue;

    // The company being applied to may be named freely, but not worked at.
    if (matches(contextNorms)) {
      // The same veto as `claimsEmployment`, and this is the site that prints the refusal:
      // without it, "I want to work at <them>" — the one sentence a why-this-company answer
      // exists to contain — came back blocking, telling the writer to say what draws them to
      // the company in a sentence that already did.
      if (!claimsEmployment) continue;
      return {
        verdict: 'unsupported',
        reason:
          `"${raw}" is the employer you are applying to, and your profile has no ` +
          `experience there. Say what draws you to them instead.`,
      };
    }

    // A bare acronym counts as an organisation only when the sentence puts the writer
    // inside it. Without this, "It replaced a CSV export", "The HTTP layer was the easy
    // part" and "I wrote a REST API for the billing service" were each reported as an
    // invented organisation and each blocked approval at G3, where there is no override —
    // three true sentences that any engineer would write, about a format, a protocol and an
    // interface. "I interned at IBM" is still read as employment and still red; "I deployed
    // it to AWS" is not a claim about working at AWS and is left alone.
    if (isAcronymRun(raw) && !claimsEmployment) continue;

    /**
     * A PERSON IS NOT A CREDENTIAL, and nobody's teacher is on their resume.
     *
     * "My physics teacher, Mrs. Delgado, pushed me to try robotics" came back BLOCKING at
     * G3 with `"Mrs Delgado" does not appear anywhere on your profile` — a true sentence
     * about the student's own life, refused at the one gate with no override, and refused
     * for a reason that can never be satisfied: a resume lists organisations, not the people
     * in them, so no amount of profile editing would ever clear it. The only way out was
     * deleting the sentence. "My coach, Mr. Alvarez, encouraged me to keep going" is the
     * same sentence, and so is every mentor sentence a "why this field" answer is made of.
     *
     * A name is a person when it is introduced as one — by an honorific, or by the
     * relationship word that names the writer's connection to them. Both forms, because the
     * young applicants this tool serves write it either way.
     *
     * This gives up nothing in the other direction. The check exists to catch a fabricated
     * ORGANISATION on the writer's history, and a person named as a person makes no claim
     * about where the writer worked: "I interned at Delgado Engineering" carries no
     * honorific and no relationship word, states an affiliation, and is still red.
     */
    if (namesAPerson(claim, raw)) continue;

    /**
     * A THIRD-PARTY COMPANY NAMED ADMIRINGLY IS STILL RED, AND THAT IS ON PURPOSE.
     *
     * "I have admired Boeing since I was a kid" blocks here, on a profile with no Boeing.
     * ADMIRATION_FRAME and INTENT_FRAME veto exactly that shape twenty lines above — but only
     * on the `matches(contextNorms)` branch, for the ONE employer this application is
     * addressed to, where the question itself invites the name.
     *
     * Extending those vetoes to every other company was tried here and reverted. The release
     * gate above ("does not let an opinion frame smuggle a fabrication through") caught what
     * it costs: "I would love to bring the Rust experience I gained at Google to your team"
     * carries an intent frame and a fabricated job at Google in the same sentence, and
     * `affiliationFrame` does not read "gained at" as employment, so the veto passed it. The
     * blanket refusal below is the only thing standing between that sentence and an employer.
     *
     * So the trade is deliberate and documented rather than fixed: naming an unrelated
     * company you do not work for costs a G3 block, and the way out is to name the employer
     * you are writing to, or to say the thing without the company's name. Closing it properly
     * needs the employment reading to cover "the experience I gained at X" without turning
     * "the confidence I gained at the food bank" red — a widening this file's own history
     * says has produced a false RED every previous time.
     */

    return {
      verdict: 'unsupported',
      reason: `"${raw}" does not appear anywhere on your profile.`,
    };
  }

  /**
   * ── a placing written up as a win.
   *
   * The name check above cannot see this one: "NSPA Feature Story of the Year" really is on
   * the profile, so nothing was invented, and the sentence came back green with the
   * honorable mention quoted underneath as its support. The only difference between the
   * profile and the draft is the word the draft left out, and that word is the whole fact.
   *
   * Deliberately narrow, because `overstated` blocks at G3 with no override:
   *   - the win language has to GOVERN the name, not merely share a sentence with it, and
   *     the sentence must not carry the qualifier itself. See `claimsOutrightWin` for the
   *     five true sentences the looser version of this test blocked;
   *   - the name has to be at least two words, so a bare "DECA" cannot trip it;
   *   - the name must not be one of the profile's own organisations or schools, which are
   *     free to appear inside an honor's wording without the claim being about the honor;
   *   - and EVERY honor the name matches has to be a placing AND NOT ALSO A WIN. A profile
   *     holding both "Math League Champion" and "Math League Participant" says a win is on
   *     the record, and so does the single line "1st Place, State Qualifier".
   */
  if (honors.length > 0 && !RANK_QUALIFIER.test(claim)) {
    for (const { raw, norm } of claimedNames) {
      const words = norm.split(' ').filter(Boolean).map(awardWord);
      if (words.length < 2 || knownNames.has(norm)) continue;
      if (!claimsOutrightWin(claim, raw)) continue;
      const named = honors.filter((h) => words.every((w) => h.words.has(w)));
      if (named.length === 0 || !named.every((h) => isPlacing(h.norm))) continue;
      const record = named[0]!;
      return {
        verdict: 'overstated',
        reason:
          `Your profile records this as "${record.raw}", which is a placing rather than ` +
          `an outright win. Say it the way the profile does.`,
        profileRef: record.ref,
        quote: record.raw,
      };
    }
  }

  // ── skills claimed but not held.
  const heldSkills = new Set(evidence.flatMap((e) => (e.facts.skills ?? []).map(normalize)));
  for (const raw of extractClaimedSkills(claim)) {
    const norm = normalize(raw);
    if (norm.length < 2) continue;
    if (!heldSkills.has(norm) && !containsPhrase(normEvidence, norm)) {
      return {
        verdict: 'unsupported',
        reason: `The draft claims experience with "${raw}", which is not on your profile.`,
      };
    }
  }

  return { verdict: null };
}

/**
 * True when the sentence asserts something about the writer's history.
 *
 * Motivation and interest ("I'd like to work on developer tooling") cannot have profile
 * evidence and are not claims. Those are skipped rather than flagged — but only when the
 * sentence contains nothing checkable at all, so a fabrication cannot hide behind an
 * opinion frame: "I'd love to bring the Rust experience I gained at Google" still has a
 * name and a skill in it, and still gets checked.
 */
export function isVerifiableClaim(claim: string): boolean {
  const hasAtoms =
    extractProperNouns(claim).length > 0 ||
    extractDurations(claim).length > 0 ||
    extractGpas(claim).length > 0 ||
    extractClaimedSkills(claim).length > 0 ||
    /\d/.test(claim);
  if (hasAtoms) return true;
  return !OPINION_MARKER.test(claim);
}

// ─────────────────────────────────────────────── lexical support

/**
 * "tutored" and "Tutor" are one word doing two jobs. A bullet-less resume's only evidence
 * for a role is its title line, so without inflection folding the past tense a student
 * writes never met the noun their resume prints: coverage fell under the action-claim bar
 * and TRUE sentences about the profile's own volunteer-tutor role were blocked at G3.
 * Applied to both sides equally, so it can only align genuine inflections — it never
 * creates overlap that exists on one side alone. The length floors keep short words whole
 * ("string" does not become "str", "speed" does not become "spe").
 */
function fold(t: string): string {
  let w = t;
  if (w.length >= 5 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`;
  else if (w.length >= 4 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  if (w.length >= 7 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length >= 6 && w.endsWith('ed')) w = w.slice(0, -2);
  return w;
}

/**
 * How much of the claim's content is traceable to the evidence set at all. Coverage is
 * measured against the union of the evidence — a claim may legitimately draw on two
 * facts — while `ref` points at whichever single item contributed most, since that is
 * what the G3 panel shows beside the highlight.
 */
function supportFor(
  claim: string,
  evidence: Evidence[],
): { ref: string; text: string; coverage: number } | null {
  const claimTokens = [...new Set(tokens(claim).map(fold))];
  if (claimTokens.length === 0 || evidence.length === 0) return null;

  const perItem = evidence.map((e) => ({ e, set: new Set(tokens(e.text).map(fold)) }));
  const union = new Set(perItem.flatMap((p) => [...p.set]));
  const coverage = claimTokens.filter((t) => union.has(t)).length / claimTokens.length;

  let best = perItem[0]!;
  let bestHits = -1;
  for (const p of perItem) {
    const hits = claimTokens.filter((t) => p.set.has(t)).length;
    if (hits > bestHits) {
      bestHits = hits;
      best = p;
    }
  }
  return { ref: best.e.ref, text: best.e.text, coverage };
}

/**
 * "I served as X", "I was the X" — the writer naming an office they held. Position
 * inflation (president for treasurer, head coach for assistant) is exactly the lie a
 * thin resume invites, and it is semantic, so the deterministic layer cannot red it —
 * but the lexical layer must not UPGRADE it either. "I served as student body president"
 * scored three of four tokens against the Student Body TREASURER line and came back
 * 'supported', quoting the contradicting entry as its proof — telling the human at G3,
 * the only layer that catches this class, that it checks out.
 */
const ROLE_FRAME =
  /\b(?:i|we)\s+(?:have\s+|had\s+|also\s+)?(?:been|was|were|am|became|serv(?:e|ed|ing)\s+as)\s+(?:elected\s+|named\s+)?(?:the\s+|an?\s+|our\s+|its\s+)?([a-z][a-z'’ -]{2,60}?)(?=\s+(?:of|at|for|in|on|with|from|during|while|since|until|to|and|but|when|where|that|who|through|over|last|this|my|our)\b|\s*[,.;:!?]|\s*$)/i;

/**
 * Fillers that complete the frame without naming a role: "I was proud", "I was able to",
 * "I am a rising sophomore". Nothing here can be an office, so nothing here is worth an
 * amber that trains the user to click through warnings.
 */
const ROLE_NOISE = new Set(
  (
    'able willing lucky fortunate glad proud happy excited eager thrilled honored ' +
    'honoured grateful thankful responsible part one first second third new young ' +
    'involved drawn curious interested ready determined surprised amazed inspired ' +
    'raised born told taught asked given left back home alone busy free sure unsure ' +
    'there away not never always good better best ' +
    'rising freshman sophomore junior senior student graduate ' +
    // States, not offices. "I am conversational in Spanish" and "I have been certified since
    // June" are ordinary true sentences, and reporting them as an office the profile does
    // not hold is the kind of amber that teaches the user to click through warnings — which
    // costs more than the office rule earns.
    'conversational fluent bilingual native proficient certified licensed trained ' +
    'enrolled eligible available familiar comfortable'
  ).split(' '),
);

function claimedRole(text: string): string | null {
  const m = ROLE_FRAME.exec(text);
  if (!m) return null;
  const phrase = m[1]!.trim();
  const norm = normalize(phrase);
  if (norm.length < 3 || norm.split(' ').every((w) => ROLE_NOISE.has(w))) return null;
  return phrase;
}

/**
 * How well someone says they speak a language, as a ladder.
 *
 * Putting the languages on the profile into the evidence set closed a real false red — the
 * profile says Spanish and "I am conversational in Spanish" was blocked at G3 as an invented
 * name — but it also handed the lexical layer the token "spanish", and that was enough for
 * "My Spanish is fluent" and "My Spanish is native" to come back GREEN against a profile that
 * records Conversational, with the contradicting line quoted underneath as their proof. One
 * sentence was worse still: "I tutor Spanish grammar to freshmen" was green with a quote
 * about a MATH tutoring job, because the language token was all the overlap it needed.
 *
 * Capped at amber and never red, like the office rule above it. The ladder cannot be precise
 * enough to block — resumes and drafts both use these words loosely, and blocking a true
 * sentence at a gate with no override is the worse error — but the human at G3 must not be
 * shown a green tick with the profile's own quieter wording sitting beside it as evidence.
 */
const LANGUAGE_LEVELS: Array<[RegExp, number]> = [
  [/\b(?:basic|beginner|elementary|limited|some|a little|novice)\b/i, 1],
  [/\b(?:conversational|intermediate|working knowledge|comfortable)\b/i, 2],
  [/\b(?:professional|working proficiency|business|advanced|proficient|competent)\b/i, 3],
  [/\b(?:fluent|fluency|fluently)\b/i, 4],
  [/\b(?:native|bilingual|mother tongue|first language)\b/i, 5],
];

/**
 * Verbs that assert a professional command of the language whatever adjective is used.
 * Teaching it, interpreting it or translating it is a claim about level, not only about
 * an activity.
 */
const LANGUAGE_USE =
  /\b(?:interpret(?:ed|ing|s)?|translat(?:e|ed|ing|es)|teach(?:ing)?|taught|tutor(?:ed|ing|s)?|instruct(?:ed|ing|s)?)\b/i;

function levelOf(text: string): number {
  let rank = 0;
  for (const [re, n] of LANGUAGE_LEVELS) if (re.test(text)) rank = Math.max(rank, n);
  return rank;
}

function overstatedLanguage(
  claim: string,
  evidence: Evidence[],
): { name: string; held: string } | null {
  const held = evidence.flatMap((e) => e.facts.languages ?? []);
  if (held.length === 0) return null;

  const claimRank = Math.max(levelOf(claim), LANGUAGE_USE.test(claim) ? 3 : 0);
  if (claimRank === 0) return null;

  for (const lang of held) {
    const norm = normalize(lang.name);
    if (norm.length < 2 || !containsPhrase(normalize(claim), norm)) continue;
    // An unrecognised proficiency string says nothing either way, so it cannot be exceeded.
    const heldRank = levelOf(lang.proficiency);
    if (heldRank > 0 && claimRank > heldRank) {
      return { name: lang.name, held: lang.proficiency.toLowerCase() };
    }
  }
  return null;
}

/**
 * Whether a claimed role matches a title or honor the profile holds — exactly, as a
 * contained phrase, or word-for-word within one entry ("founding team captain" against
 * "Team Captain / Founding Member"). Free evidence prose deliberately does not count: the
 * head-coach fabrication scored precisely because a bullet MENTIONS the head coach — the
 * writer's boss — and a mention of somebody else's office must not vouch for claiming it.
 */
function roleOnProfile(role: string, evidence: Evidence[]): boolean {
  const norm = normalize(role);
  const held = [
    ...evidence.map((e) => e.facts.title ?? ''),
    ...evidence.flatMap((e) => e.facts.honors ?? []),
  ]
    .map(normalize)
    .filter((t) => t.length > 1);
  return held.some((t) => {
    if (t === norm || containsPhrase(t, norm) || containsPhrase(norm, t)) return true;
    const set = new Set(t.split(' '));
    return norm.split(' ').every((w) => set.has(w));
  });
}

export interface GuardResult {
  claims: CheckedClaim[];
  /** Red verdicts. A non-empty list blocks approval at G3. */
  blocking: CheckedClaim[];
  summary: { supported: number; inferred: number; unsupported: number; overstated: number };
}

function summarize(claims: CheckedClaim[]): GuardResult {
  const count = (v: ClaimVerdict): number => claims.filter((c) => c.verdict === v).length;
  return {
    claims,
    blocking: claims.filter((c) => c.verdict === 'unsupported' || c.verdict === 'overstated'),
    summary: {
      supported: count('supported'),
      inferred: count('inferred'),
      unsupported: count('unsupported'),
      overstated: count('overstated'),
    },
  };
}

/**
 * The deterministic pass. Always runs, needs no API key, and its rejections are final.
 *
 * `contextNames` is the company and role the answer is being written for — see
 * `checkClaimDeterministically`. Every caller that knows them has to pass them, and leaving
 * them out costs something different on each side. On the G3 path the answer comes back
 * with a blocking claim over the company's own name and there is no override, so the user
 * is stuck. On the drafting path the flags are recomputed later and never reach the screen,
 * but the draft still spends its one revision rewriting a sentence that was never wrong,
 * and whatever that revision traded away to lose the company name is what the user reads.
 */
export function guardDraft(
  draft: string,
  evidence: Evidence[],
  contextNames: string[] = [],
): GuardResult {
  const checked: CheckedClaim[] = [];

  for (const c of splitClaims(draft)) {
    const det = checkClaimDeterministically(c.text, evidence, contextNames);
    if (det.verdict) {
      checked.push({
        claim: c.text,
        span: c.span,
        verdict: det.verdict,
        profileRef: det.profileRef ?? null,
        quote: det.quote ?? null,
        reason: det.reason,
        decidedBy: 'deterministic',
      });
      continue;
    }

    // Nothing provably wrong. If there is also nothing to verify, it isn't a claim.
    if (!isVerifiableClaim(c.text)) continue;

    const support = supportFor(c.text, evidence);
    const coverage = support?.coverage ?? 0;

    // A GPA in this claim was just checked by the deterministic layer and MATCHED — an
    // unmatched one would have returned red above, before this line ran. The lexical
    // heuristic must not overrule a number the guard itself verified: "I maintained a
    // 3.972 unweighted GPA on a 4.000 scale while taking five AP courses" used to block
    // at G3 because "unweighted" and "scale" appear nowhere in the evidence text —
    // moments after the 3.972 had been confirmed against the profile.
    const gpaVerified = extractGpas(c.text).length > 0;

    // Weak overlap only turns red for a claim that asserts an act. Anything else stays
    // amber: the lexical layer is a heuristic, and heuristics do not get to hard-block.
    let verdict: ClaimVerdict =
      coverage >= 0.5
        ? 'supported'
        : coverage >= 0.25 || gpaVerified || !ACTION_CLAIM.test(c.text)
          ? 'inferred'
          : 'unsupported';
    let reason: string | undefined =
      verdict === 'unsupported'
        ? 'Nothing in the retrieved evidence backs this up. Rewrite it, or add the fact to your profile.'
        : coverage < 0.25
          ? 'Only loosely tied to your profile. Worth a second read before you approve it.'
          : undefined;

    // Token overlap must not put a green tick on a different office — see ROLE_FRAME.
    // Capped at amber, never red: the semantic judgement stays with the human at G3, but
    // that human must not be handed 'supported' with a contradicting quote beside it.
    if (verdict === 'supported') {
      const role = claimedRole(c.text);
      if (role && !roleOnProfile(role, evidence)) {
        verdict = 'inferred';
        reason = `The draft calls you "${role}", which does not match a title on your profile. Worth a second read before you approve it.`;
      }
    }

    // Nor on a language the writer speaks less well than the sentence says — see
    // `overstatedLanguage`.
    if (verdict === 'supported') {
      const over = overstatedLanguage(c.text, evidence);
      if (over) {
        verdict = 'inferred';
        reason =
          `Your profile records ${over.name} as ${over.held}. This sentence claims more than ` +
          `that. Worth a second read before you approve it.`;
      }
    }

    checked.push({
      claim: c.text,
      span: c.span,
      verdict,
      profileRef: verdict === 'unsupported' ? null : (support?.ref ?? null),
      quote: verdict === 'unsupported' ? null : (support?.text ?? null),
      reason,
      decidedBy: 'deterministic',
    });
  }

  return summarize(checked);
}

/**
 * Merges model verdicts into a deterministic result.
 *
 * The model may DOWNGRADE a claim — spot a semantic overstatement the regexes missed —
 * but may never UPGRADE one the deterministic layer rejected. A model that talks itself
 * out of a caught fabrication is precisely the failure this design exists to prevent.
 */
export function mergeModelVerdicts(
  base: GuardResult,
  modelVerdicts: Array<{ claim: string; verdict: ClaimVerdict; reason?: string }>,
): GuardResult {
  const SEVERITY: Record<ClaimVerdict, number> = {
    supported: 0,
    inferred: 1,
    overstated: 2,
    unsupported: 3,
  };

  return summarize(
    base.claims.map((c) => {
      const m = modelVerdicts.find((v) => v.claim.trim() === c.claim.trim());
      if (!m || SEVERITY[m.verdict] <= SEVERITY[c.verdict]) return c;
      return {
        ...c,
        verdict: m.verdict,
        reason: m.reason ?? c.reason,
        decidedBy: 'model' as const,
      };
    }),
  );
}
