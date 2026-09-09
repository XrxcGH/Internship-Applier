/**
 * Maps a ResumeExtraction onto a draft CandidateProfile.
 *
 * Everything the resume cannot tell us — date of birth, work authorization, availability
 * window — is left at a neutral default and added to `needsReview` so gate G1 forces the
 * user to supply it. Guessing any of these would silently corrupt eligibility. Home city and
 * state are the exception: a resume usually does print them, so they arrive as a suggestion
 * and stay flagged until the user has looked at them.
 */
import { z } from 'zod';
import { ulid } from 'ulid';
import { lostTheEvidence } from '@ia/shared';
import type { CandidateProfile, Skill } from '@ia/shared';
import type { ResumeExtraction } from './extractProfile';
import { deriveProfile } from './deriveFields';

/** Facts eligibility depends on that a resume never contains. */
export const REQUIRED_BY_G1 = [
  'dateOfBirth',
  'workAuthorization.status',
  'availability.start',
  'availability.end',
  'locationPrefs.base.city',
  'locationPrefs.base.region',
] as const;

/**
 * A URL the schema will accept, or nothing.
 *
 * Resumes print links the way people read them — "linkedin.com/in/rosa", "github.com/rosa"
 * — and `z.string().url()` rejects both. Stored anyway (nothing validates on write), they
 * made every subsequent read of the profile throw. A missing scheme is the one repair
 * worth making automatically; anything else is dropped rather than guessed at.
 */
function asUrl(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  return URL.canParse(candidate) ? candidate : undefined;
}

/**
 * An address the schema will accept, or the empty string it treats as "not known yet".
 *
 * Every other field the extractor produces is either repaired on the way in or flagged for
 * the user; the email address was neither. A resume that prints "rosa.dean [at] gmail.com"
 * to dodge scrapers — or "rosa.dean(at)gmail.com", or a line break landing mid-address —
 * was stored verbatim, and since nothing validates on write, the row only failed on the way
 * back OUT. Every read of the profile threw, including the G1 screen where the address would
 * have been corrected, so the tool was unusable and the one obvious remedy, re-uploading the
 * resume, went through the same failing read first.
 *
 * '' is a legal, meaningful value here: the schema documents it as "no readable address",
 * and `needsReview` below turns it into something G1 refuses to pass until the user types
 * one. Stripping a `mailto:` is mechanical, the same class of repair as adding a missing
 * scheme to a URL. Anything beyond that would be guessing at somebody's address.
 */
const EMAIL = z.string().email();

function asEmail(raw: string | null | undefined): string {
  const trimmed = (raw ?? '').trim().replace(/^mailto:/i, '');
  return EMAIL.safeParse(trimmed).success ? trimmed : '';
}

/**
 * What a date string on a resume actually tells us.
 *
 * The schema stores YYYY-MM and nothing else, and the old reader took only that exact
 * shape: everything else became `undefined`. On an END date `undefined` is not "unknown",
 * it is the schema's documented "still there" (packages/shared/src/profile.ts), so a
 * finished nine-month school-store job written "2024-09 to June 2025" was stored as
 * ongoing, measured to today, and a draft claiming two years at that store came back
 * `supported` with the entry quoted beside it as proof. The same silence on a
 * certification date pushed a true sentence the other way: with "2023" dropped, "I have
 * served as a CPR certified responder for three years" was measured against the longest
 * JOB on the profile and blocked at G3 as overstated, where there is no override.
 *
 * So a date is read as the window of months it names, and the window is what the callers
 * below reason about:
 *   `month`      — the resume named one month, however it spelled it. Nothing is lost.
 *   `window`     — a year or a season names a range, not a month.
 *   `ongoing`    — "Present" and its synonyms mean exactly what an absent end date means.
 *   `absent`     — nothing was stated, which is a legitimate answer.
 *   `unreadable` — something was stated and it names no date at all.
 *
 * `ranged` says the field held a whole range — "Aug 2026 - May 2030" — and this file picked
 * the half the field asked for. The month is the resume's, but the decomposition is ours, so
 * it goes to G1 exactly like a year or a season does.
 */
type ReadDate =
  | { kind: 'absent' }
  | { kind: 'ongoing'; ranged?: boolean }
  | { kind: 'month'; ym: string; ranged?: boolean }
  | { kind: 'window'; earliest: string; latest: string; ranged?: boolean }
  | { kind: 'unreadable' };

/** Outside this range a four-digit run is a street number or a club name, not a year. */
const EARLIEST_PLAUSIBLE_YEAR = 1950;
const LATEST_PLAUSIBLE_YEAR = 2100;

/** Every spelling of a month a resume actually prints, including the "Sept" nobody agrees on. */
const MONTH_WORDS: Record<string, number> = {
  january: 1,
  jan: 1,
  february: 2,
  feb: 2,
  march: 3,
  mar: 3,
  april: 4,
  apr: 4,
  may: 5,
  june: 6,
  jun: 6,
  july: 7,
  jul: 7,
  august: 8,
  aug: 8,
  september: 9,
  sept: 9,
  sep: 9,
  october: 10,
  oct: 10,
  november: 11,
  nov: 11,
  december: 12,
  dec: 12,
};

/**
 * Seasons, as the months they can cover. A student resume writes "Summer 2025" far more
 * often than it writes a month, and every summer internship on it is dated that way.
 *
 * These are the OUTER edge of the ordinary reading, not the meteorological one, because both
 * consumers of a window need the edge that cannot fall inside the truth. `endYearMonth`
 * stores `latest` as the month a role finished, and a fall term capped at November made a
 * true "I tutored there for four months" about a September-to-December term come back
 * `overstated` at G3, where there is no override — the season branch broke the very
 * invariant the bare-year branch was widened to keep. `earliestYearMonth` stores `earliest`
 * as the month a card was earned, and a spring semester capped at March would shorten a
 * January card's span the same way. So a fall term runs to mid-December, a spring semester
 * begins in January and a spring quarter ends in June, and a summer job runs from the end of
 * exams to Labor Day. Every season is flagged for G1 regardless, so the user gets the last
 * word on the month; what this table must never do is pick a boundary that blocks a sentence
 * the resume supports.
 *
 * Winter is deliberately missing. It straddles New Year, so "Winter 2025" names months in
 * two different years and any narrowing would be a guess about which; it falls through to
 * the whole-year window below, which is the honest answer.
 */
const SEASON_MONTHS: Record<string, [number, number]> = {
  spring: [1, 6],
  summer: [5, 9],
  fall: [8, 12],
  autumn: [8, 12],
};

/**
 * The ways a resume says "I am still there". On an end date these mean absent, not unknown.
 *
 * Kept as one alternation because it is read in two places — a field that says nothing else,
 * and the tail of a range — and a phrase that reached only one of them was how "2024-08
 * Present" came to be stored as a job that finished in the month it started.
 */
const ONGOING =
  'present|presently|current|currently|ongoing|now|to\\s+(?:date|present)|till\\s+(?:date|now|present)|until\\s+(?:now|present)';
const ONGOING_WORDS = new RegExp(`^(?:${ONGOING})$`);

function yearMonth(year: number, month: number): string {
  return `${String(year)}-${String(month).padStart(2, '0')}`;
}

function toYearMonth(d: Date): string {
  return `${String(d.getUTCFullYear())}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function plausibleYear(year: number): boolean {
  return year >= EARLIEST_PLAUSIBLE_YEAR && year <= LATEST_PLAUSIBLE_YEAR;
}

function namedMonth(year: number, month: number): ReadDate {
  if (!plausibleYear(year) || month < 1 || month > 12) return { kind: 'unreadable' };
  return { kind: 'month', ym: yearMonth(year, month) };
}

function wholeYear(year: number): ReadDate {
  if (!plausibleYear(year)) return { kind: 'unreadable' };
  return { kind: 'window', earliest: yearMonth(year, 1), latest: yearMonth(year, 12) };
}

/**
 * The all-digit forms, which are the ones a model emits when it does not follow the
 * instruction to write YYYY-MM: an unpadded month ("2025-6"), a slash ("2025/06"), the
 * American order ("06/2025", "6/14/2025"), a full ISO day, or a bare year.
 */
function readNumericDate(text: string): ReadDate | undefined {
  const iso = /^(\d{4})[-/.](\d{1,2})(?:[-/.](\d{1,2}))?(?:[T ].*)?$/.exec(text);
  if (iso) return namedMonth(Number(iso[1]), Number(iso[2]));

  // "06/14/2025" is month-first and "14/06/2025" cannot be: a first part over twelve is a
  // day whichever convention the writer had in mind. US order wins the ambiguous case,
  // since these are US postings read off US resumes.
  const dayMonthYear = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})(?:[T ].*)?$/.exec(text);
  if (dayMonthYear) {
    const first = Number(dayMonthYear[1]);
    const second = Number(dayMonthYear[2]);
    return namedMonth(Number(dayMonthYear[3]), first <= 12 ? first : second);
  }

  const monthYear = /^(\d{1,2})[-/.](\d{4})$/.exec(text);
  if (monthYear) return namedMonth(Number(monthYear[2]), Number(monthYear[1]));

  const bare = /^(\d{4})$/.exec(text);
  if (bare) return wholeYear(Number(bare[1]));

  return undefined;
}

/** Every four-digit year in a string, which is how a second date announces itself. */
const ALL_YEARS = /(?<!\d)(?:19|20)\d{2}(?!\d)/g;

/**
 * The separators a resume puts between the two ends of a range.
 *
 * An ASCII hyphen has to carry whitespace, because it is also the separator INSIDE
 * "2025-06"; an en or em dash does not, because nothing else uses one. The tight pattern
 * below is the no-whitespace hyphen, admitted only where the thing on its left is a complete
 * four-digit year and the thing on its right starts another date — "2024-2025" and
 * "Aug 2026-May 2030" are ranges, "2024-09" and "2025-06-14" are not.
 */
const RANGE_SEPARATOR = /\s+(?:-{1,2}|to|until|through|thru)\s+|\s*[–—]\s*/i;
const TIGHT_RANGE_SEPARATOR = /(?<=(?:19|20)\d{2})-(?=[A-Za-z]|(?:19|20)\d{2})/;

/**
 * A range whose right-hand end is "Present" and whose joiner is one this file does not know.
 *
 * The two rules above find a range by its separator, and a resume line joins its two ends
 * with anything: "2024-08 Present", "Aug 2024 / Present", "2024-08; Present",
 * "2024-08-Present". None of those separators is in the list, and a "still there" tail
 * carries no second YEAR either, so the two-dates test below saw one date and read it: the
 * ISO branch swallowed " Present" as if it were a timestamp and the word branch took the
 * first month word. A club a student is still in every week was stored as having finished in
 * the month it began, unflagged, so G1 never asked — and a true "I have volunteered there for
 * two years" was then measured against that one-month span and came back `overstated` at G3,
 * where there is no override. That is "Aug 2026 - Present" again, one joiner over.
 *
 * The `(?<=\d)` is what keeps this from splitting the phrase itself: "until now" and "till
 * date" are whole answers to an end date, and without a digit in front of the space they stay
 * whole. Nothing but a trailing "still there" phrase can match, so a date this file already
 * reads correctly is untouched.
 */
const TRAILING_ONGOING = new RegExp(`(?<=\\d)[\\s/;&,|-]+(?=(?:${ONGOING})$)`, 'i');

/**
 * A range between two month WORDS that shares one year: "Jun-Aug 2025", "June–August 2025",
 * "May/June 2025".
 *
 * The tight rule above needs a four-digit year on the left of the hyphen, and a summer job
 * puts a month there instead — so the whole range read as one date, the FIRST month word was
 * stored as the month the job ENDED, and nothing was flagged. A real June-to-August internship
 * became a zero-month entry and the student's true sentence about it was `overstated` at G3,
 * where there is no override. Both sides must be month names, so an ordinary hyphenated word
 * cannot split.
 */
const MONTH_RANGE_SEPARATOR = new RegExp(
  `(?<=\\b(?:${Object.keys(MONTH_WORDS).join('|')}))\\s*[-/](?=(?:${Object.keys(MONTH_WORDS).join('|')})\\b)`,
  'i',
);

/** The two halves of a range, or nothing if the string names one date. */
function splitRange(text: string): [string, string] | undefined {
  for (const separator of [
    RANGE_SEPARATOR,
    TIGHT_RANGE_SEPARATOR,
    MONTH_RANGE_SEPARATOR,
    TRAILING_ONGOING,
  ]) {
    const m = separator.exec(text);
    if (!m) continue;
    const left = text.slice(0, m.index).trim();
    const right = text.slice(m.index + m[0].length).trim();
    if (left && right) return [left, right];
  }
  return undefined;
}

/** What one date string says, once we know it is one date and not two. */
function readOneDate(text: string): ReadDate {
  if (!text) return { kind: 'unreadable' };

  const lower = text.toLowerCase();
  if (ONGOING_WORDS.test(lower)) return { kind: 'ongoing' };

  // A second year in the same field means a second date, and the separator between them was
  // one this file does not know. Two dates are not a date: reading either half would be a
  // guess about which one the field wanted, so nothing is stored and G1 is asked.
  const years = lower.match(ALL_YEARS);
  if (years && new Set(years).size > 1) return { kind: 'unreadable' };

  const numeric = readNumericDate(text);
  if (numeric) return numeric;

  // Anything with a word in it: "June 2025", "Expected May 2027", "Summer 2025",
  // "Class of 2026". The year anchors it, and the words say how much of that year.
  const year = years?.[0];
  if (year === undefined) return { kind: 'unreadable' };

  const words = lower.split(/[^a-z]+/).filter(Boolean);

  // Two MONTHS in one field is two dates, exactly as two years is — and a summer job states
  // both of them inside a single year, which is the one shape the year test above cannot
  // see. "Jun-Aug 2025", "June-August 2025", "Jun 2025 Aug 2025" and "May/June 2025" all
  // took the FIRST month word and stored it, unflagged, as the month the job ENDED: a real
  // June-to-August internship became a zero-month entry, and the student's true sentence
  // about it was blocked at G3 with no override. Nothing is stored and G1 is asked, which is
  // what this function does with every other pair of dates it cannot separate.
  const named = [...new Set(words.map((w) => MONTH_WORDS[w]).filter((m) => m !== undefined))];
  if (named.length > 1) return { kind: 'unreadable' };
  if (named.length === 1) return namedMonth(Number(year), named[0]!);
  for (const w of words) {
    const season = SEASON_MONTHS[w];
    if (season) {
      if (!plausibleYear(Number(year))) return { kind: 'unreadable' };
      return {
        kind: 'window',
        earliest: yearMonth(Number(year), season[0]),
        latest: yearMonth(Number(year), season[1]),
      };
    }
  }
  return wholeYear(Number(year));
}

/**
 * What one date string from the extraction says, in the terms the callers below use.
 *
 * `half` is which end of a range this field is asking for, and it exists because the
 * extractor routinely copies a resume's whole date line into one field: "Ohio State
 * University, Aug 2026 - May 2030" arrives with the entire range in `endDate`. Read as one
 * date, that string gave up its FIRST month — the day the student STARTS college became the
 * month they graduate, `derived.expectedGraduation` became 2026-08, and a posting wanting
 * the class of 2030 came back `ineligible`, which this repo documents as the worst thing the
 * app can do to somebody. Worse, the result looked like a clean month, so nothing reached
 * `needsReview` and G1 never asked. "2026 - May 2030" was read as 2026-05, a month that is
 * in neither half of the string, and "Aug 2026 - Present" recorded a programme still running
 * as finished.
 *
 * A range has a start and an end, so a field asking for an end date takes the last half and
 * a field asking for a start date takes the first: that is reading the string, not guessing
 * at it. When the half this field wants names no date — "Jun - Aug 2025" asked for a start —
 * the answer is `unreadable`, because which year "Jun" belongs to is exactly the guess that
 * is not available. Either way the flag is raised, since the split is this file's reading.
 */
function readDate(raw: string | null | undefined, half: 'first' | 'last' = 'first'): ReadDate {
  const text = (raw ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[.,]+$/, '');
  if (!text) return { kind: 'absent' };

  const halves = splitRange(text);
  if (!halves) return readOneDate(text);

  const read = readOneDate(halves[half === 'first' ? 0 : 1]);
  switch (read.kind) {
    case 'month':
      return { kind: 'month', ym: read.ym, ranged: true };
    case 'window':
      return { kind: 'window', earliest: read.earliest, latest: read.latest, ranged: true };
    case 'ongoing':
      return { kind: 'ongoing', ranged: true };
    default:
      return { kind: 'unreadable' };
  }
}

/**
 * The month a date is stored as when only a month the resume actually named will do.
 *
 * Three of the five date fields take this and not the widening below, because for them a
 * span longer than the truth is the dangerous direction. A year-only START date widened to
 * January stretches the entry to the longest span its year allows, and FactGuard then adds
 * a quarter on top as rounding slack: an entry stated as beginning "2024" and still running
 * became thirty-one months, and "I volunteered at Pageturners Literacy Project for three
 * years" — thirty-six months, which no reading of "2024" can support — came back
 * `supported` with the entry quoted as proof. Undated, that entry bounds nothing and the
 * claim is measured against the profile's real work spans instead, which is the
 * conservative answer. The year is flagged either way, so G1 asks for the month.
 */
function statedMonth(read: ReadDate): string | undefined {
  return read.kind === 'month' ? read.ym : undefined;
}

/**
 * The month a CERTIFICATION date is stored as: the earliest the stated window allows.
 *
 * A card is a point in time, and the only duration claim it can support runs from that
 * point to today, so the earliest month of the stated year is the reading that cannot make
 * that span shorter than the truth.
 *
 * This repair is made HERE and only here, and the extractor is now told the opposite — copy
 * every date exactly as printed, never turn a bare year into a month. It used to be told to
 * write YYYY-01 itself, which was the one remaining way a wrong date reached the profile
 * with nothing flagged: a model that normalized "2026" to "2026-01" but forgot to add the
 * path to `needsReview` handed this file a clean, unranged month it could not tell from a
 * genuinely stated January. On a certification that is the safe direction; on an education
 * END date it is not, and it made a June graduate `ineligible` for a posting wanting the
 * class of 2026 with no flag anywhere to show for it. Widening belongs in the reader that
 * knows which field it is widening.
 *
 * Unlike the experience entries above there is no conservative fallback here: a dated
 * certification is what scopes the claim to itself, and with the date dropped the sentence
 * was measured against the longest JOB on the profile instead. "I have served as a CPR
 * certified responder for three years" was blocked at G3 by a two-month camp job, and G3
 * has no override. The year is guessed at the month, so it is flagged for G1 as well.
 *
 * The price of that January, stated plainly because it is a real one: a card actually earned
 * in December of the stated year has its span inflated by up to ELEVEN MONTHS, and with
 * FactGuard's quarter of rounding slack on top, "four years" about a three-year card comes
 * back green. The trade is kept anyway, on three grounds. The false red it closes has no
 * override anywhere in the product; the false green it opens is flagged onto `needsReview`
 * as `certifications.N.date`, so G1 asks for the month before anything is sent. And the
 * extractor is already instructed to make this exact repair itself ("If only a year is
 * given, use YYYY-01"), so refusing it here would only make the profile depend on whether
 * the model obeyed. What is NOT available is narrowing to the middle of the year to split
 * the difference: that shortens the span below the truth for a January card and hands the
 * student a blocked true sentence instead.
 */
function earliestYearMonth(read: ReadDate): string | undefined {
  if (read.kind === 'month') return read.ym;
  if (read.kind === 'window') return read.earliest;
  return undefined;
}

/**
 * The month an experience END date is stored as: the latest the stated window allows.
 *
 * This one IS widened, because here the alternative is not "bounds nothing" but "still
 * working there", which is a longer span than any month of the stated year and an ever
 * growing one. "2024-09 to 2025" stored as ending 2025-12 measures fifteen months against a
 * nine-month job, and a two-year claim about it is blocked as it should be; stored as
 * ongoing it measured twenty-three, the same claim came back green, and the figure grew by
 * one every month the file sat there. December of the stated year is also never shorter
 * than the truth, so widening cannot block a true sentence about the job either.
 *
 * A window that has not finished yet is left ongoing instead. December of this year has
 * not happened, so a role stated as ending "2026" may well still be running, and writing
 * an end date the calendar has not reached would announce a job finished that is not.
 * A window ending before the entry's own start date is a contradiction the user has to
 * settle; it is flagged either way, and reading it as ongoing errs toward the longer span.
 */
function endYearMonth(
  read: ReadDate,
  startYm: string | undefined,
  nowYm: string,
): string | undefined {
  if (read.kind === 'month') return read.ym;
  if (read.kind !== 'window') return undefined;
  if (read.latest > nowYm) return undefined;
  if (startYm !== undefined && read.latest < startYm) return undefined;
  return read.latest;
}

/**
 * Whether G1 has to ask about this date.
 *
 * Stated but not a month — a year, a season, a phrase nothing could read — always reaches
 * `needsReview`, because whatever was stored for it above is this file's reading and not
 * the user's. Absent never does: a resume that gives no end date is saying the role is
 * ongoing, and flagging every ongoing role would leave a student clearing flags on every
 * club they have ever joined. `ongoingIsMeaningful` is the one difference between an end
 * date, where "Present" is a real answer, and a start date or a certification date, where
 * it is not.
 *
 * A `ranged` reading always asks, whatever it came out as. "Aug 2026 - May 2030" yields a
 * clean month for an end date, but only because this file decided which half of the string
 * the field meant; that decision is not the user's, and an unflagged wrong graduation month
 * is an `ineligible` with no override behind it.
 */
function needsUserConfirmation(read: ReadDate, ongoingIsMeaningful: boolean): boolean {
  if (read.kind === 'absent') return false;
  if (read.kind === 'month') return read.ranged === true;
  if (read.kind === 'ongoing') return read.ranged === true || !ongoingIsMeaningful;
  return true;
}

/** A trailing "USA" on a location line is a country, not a state. */
const US_TAIL = /^(u\.?s\.?a?\.?|united states( of america)?)$/i;

/**
 * Countries named often enough on a resume that "Berlin, Germany" has to be read as a city
 * and a country rather than a city and a state.
 *
 * A two-part line is normally "City, State", so only a name listed here is promoted out of
 * the state slot; anything unrecognised keeps today's reading rather than being guessed at.
 * Names that are also US states — Georgia — are deliberately absent, because "Atlanta,
 * Georgia" is by far the likelier line to meet.
 */
const COUNTRY_NAMES: Record<string, string> = {
  canada: 'Canada',
  mexico: 'Mexico',
  'united kingdom': 'United Kingdom',
  uk: 'United Kingdom',
  'u.k.': 'United Kingdom',
  england: 'United Kingdom',
  scotland: 'United Kingdom',
  wales: 'United Kingdom',
  ireland: 'Ireland',
  germany: 'Germany',
  france: 'France',
  spain: 'Spain',
  portugal: 'Portugal',
  italy: 'Italy',
  netherlands: 'Netherlands',
  belgium: 'Belgium',
  switzerland: 'Switzerland',
  austria: 'Austria',
  sweden: 'Sweden',
  norway: 'Norway',
  denmark: 'Denmark',
  finland: 'Finland',
  poland: 'Poland',
  romania: 'Romania',
  ukraine: 'Ukraine',
  greece: 'Greece',
  turkey: 'Turkey',
  israel: 'Israel',
  india: 'India',
  pakistan: 'Pakistan',
  bangladesh: 'Bangladesh',
  china: 'China',
  japan: 'Japan',
  'south korea': 'South Korea',
  taiwan: 'Taiwan',
  singapore: 'Singapore',
  vietnam: 'Vietnam',
  philippines: 'Philippines',
  indonesia: 'Indonesia',
  malaysia: 'Malaysia',
  thailand: 'Thailand',
  australia: 'Australia',
  'new zealand': 'New Zealand',
  brazil: 'Brazil',
  argentina: 'Argentina',
  chile: 'Chile',
  colombia: 'Colombia',
  peru: 'Peru',
  nigeria: 'Nigeria',
  ghana: 'Ghana',
  kenya: 'Kenya',
  egypt: 'Egypt',
  'south africa': 'South Africa',
  morocco: 'Morocco',
  uae: 'United Arab Emirates',
  'united arab emirates': 'United Arab Emirates',
  'saudi arabia': 'Saudi Arabia',
  qatar: 'Qatar',
  russia: 'Russia',
};

/** The country a trailing part of a location line names, if it names one at all. */
function asCountry(part: string): string | undefined {
  if (US_TAIL.test(part)) return 'US';
  return COUNTRY_NAMES[part.toLowerCase()];
}

/**
 * The candidate's own location line, split into the home city, state and country the
 * profile keeps.
 *
 * The extractor is asked for this on every run and the answer used to be dropped on the
 * floor, so at G1 the user retyped a city the tool had already read off the page. City and
 * state stay in `needsReview`: this is a suggestion to check, not a fact being asserted. A
 * line that is not recognisably "City, State" leaves the state empty rather than inventing
 * one.
 *
 * A country the resume states used to be thrown away and the profile filled in with "US"
 * regardless — so "Berlin, Germany" was stored as somebody living in the state of Germany,
 * in the United States, and the fill engine went on to type "US" into the country field of
 * their applications. That is a wrong fact asserted in the user's name, on a screen that
 * shows no country control for them to correct it on.
 */
function splitLocation(raw: string | null | undefined): {
  city: string;
  region: string;
  country?: string;
} {
  const parts = (raw ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);

  /**
   * A country is only ever taken from a name we recognise, at any part count.
   *
   * Position alone used to be enough for a third part — "Toronto, ON, Canada" reads that
   * way — but a resume header is not a structured address. "Apt 4, Austin, TX" and
   * "Brooklyn, New York, NY" are equally ordinary, and both stored the state abbreviation
   * as the country. That value goes on to be typed into the Country field of a real
   * application, on a screen with no country control to correct it, so the tool would have
   * asserted "TX" as a country in the user's name.
   *
   * When the trailing part is not a country we know, it stays where it is and the country
   * is left absent — the same refusal to guess the two-part branch already made.
   */
  let country: string | undefined;
  const last = parts[parts.length - 1];
  if (last && parts.length >= 2) {
    country = asCountry(last);
    if (country) parts.pop();
  }

  return {
    city: parts[0] ?? '',
    region: withoutPostcode(parts[1] ?? ''),
    ...(country ? { country } : {}),
  };
}

/**
 * The state, without the postcode printed beside it.
 *
 * "Portland, OR 97214" is the ordinary way a US resume writes its header, and splitting on
 * the comma alone put the whole of "OR 97214" in the REGION. That value is not only stored:
 * `valueFor` in core/filling/plan.ts falls back to `locationPrefs.base.region` for a form's
 * State field, so the tool typed "OR 97214" into a control that wanted "OR" — a state no
 * dropdown offers and no employer recognises, asserted in the user's name.
 *
 * Only a postcode at the END of the part goes, and only where something precedes it, so a
 * region that is nothing but a postcode is left for the user rather than emptied. Nothing
 * here invents a region: a part that is not "STATE 12345" comes back exactly as it went in.
 *
 * The postcode itself is dropped rather than moved. `locationPrefs.base` has nowhere to put
 * one, and `address` is the block the user fills in at G1 — writing a postcode there would
 * be this file asserting a piece of the user's address that nobody has checked.
 */
function withoutPostcode(region: string): string {
  // US ZIP or ZIP+4, and Canada's "A1A 1A1", each with a real region in front of it.
  return region
    .replace(/\s+\d{5}(?:-\d{4})?$/, '')
    .replace(/\s+[A-Za-z]\d[A-Za-z][ -]?\d[A-Za-z]\d$/, '')
    .trim();
}

export function toDraftProfile(x: ResumeExtraction, now: Date = new Date()): CandidateProfile {
  const ts = now.toISOString();
  const nowYm = toYearMonth(now);
  const home = splitLocation(x.location);
  const email = asEmail(x.email);

  // Dates are read once, here, and both the stored value and the review flag come out of
  // that single reading. They used to be read twice — once for the field, once for
  // `needsReview` — which is how an experience end date came to be dropped by one branch
  // and flagged by neither.
  const dateFlags: string[] = [];

  const education = x.education.map((e, i) => {
    const start = readDate(e.startDate);
    const end = readDate(e.endDate, 'last');
    // A stated education start date the schema will not take ("2023" alone) used to be
    // dropped in silence: academicYear quietly degraded from a number to null and nobody
    // was asked. Flag only what was stated but unusable, since a start date absent from
    // the resume is normal. "Present" is not an answer to when school began, so it counts
    // as stated-but-unusable here; on the end date it is a real answer and is left alone.
    if (needsUserConfirmation(start, false)) dateFlags.push(`education.${i}.startDate`);
    if (needsUserConfirmation(end, true)) dateFlags.push(`education.${i}.endDate`);
    return {
      institution: e.institution,
      level: e.level,
      fieldOfStudy: e.fieldOfStudy ?? undefined,
      startDate: statedMonth(start),
      // A school's end date becomes `derived.expectedGraduation`, and the graduation-window
      // rule compares that one month against the range a posting will accept. With no date
      // on file the rule returns `unknown` and asks; with a month this file invented it can
      // return `fail`. "Expected 2027" widened to December would miss a posting wanting
      // graduation by August 2027, and a wrongly ineligible posting is the worst thing this
      // app can do to somebody, so the year is flagged rather than narrowed.
      endDate: statedMonth(end),
      gpa:
        e.gpaValue !== null && e.gpaScale !== null
          ? { value: e.gpaValue, scale: e.gpaScale, weighted: e.gpaWeighted ?? undefined }
          : undefined,
      coursework: e.coursework,
      honors: e.honors,
    };
  });

  const experience = x.experience.map((e, i) => {
    const start = readDate(e.startDate);
    const end = readDate(e.endDate, 'last');
    const startDate = statedMonth(start);
    // Experience duration feeds the seniority band and the experience-ceiling rule, so a
    // start date the extractor could not read — or wrote in a form the schema will not
    // take — has to reach the user rather than be filled in with a guess. An absent one is
    // flagged too, and always has been: an undated job contributes nothing to either
    // figure, which is a loss the user should be told about.
    if (start.kind !== 'month' || start.ranged === true) {
      dateFlags.push(`experience.${i}.startDate`);
    }
    // The end date had no flag at all until a nine-month job written "2024-09 to June
    // 2025" was stored as ongoing and a draft claiming two years there came back green.
    if (needsUserConfirmation(end, true)) dateFlags.push(`experience.${i}.endDate`);
    return {
      organization: e.organization,
      title: e.title,
      type: e.type,
      startDate,
      endDate: endYearMonth(end, startDate, nowYm),
      location: e.location ?? undefined,
      bullets: e.bullets,
    };
  });

  // The date a card was earned is where "I have been CPR certified for N years" starts
  // counting, which is why it takes the earliest reading of a stated year. Dropped in
  // silence, a card the student has held since freshman year fell out of the duration pool
  // entirely and the sentence was measured against the longest job on the profile instead:
  // a true claim blocked at G3, where there is no override.
  const certifications = x.certifications.map((c, i) => {
    const at = readDate(c.date);
    if (needsUserConfirmation(at, false)) dateFlags.push(`certifications.${i}.date`);
    return {
      name: c.name,
      issuer: c.issuer ?? undefined,
      date: earliestYearMonth(at),
    };
  });

  const skills: Skill[] = x.skills.map((s) => ({
    name: s.name,
    category: s.category,
    // Evidence is attached during confirmation, when experience/project ids are stable.
    evidence: [],
  }));

  /**
   * Two ways an extraction can come back the right shape and still be missing the substance.
   *
   * A real reading of an activity-heavy student resume produced twenty-seven experience
   * entries, none of which carried a single one of the lines printed under it, and no skills
   * at all. Every count on the G1 screen was a number, so nothing looked wrong: "Experience —
   * 27 entries" beside "Skills — none found". What it actually meant is that the retrieval
   * step had twenty-seven titles and no description of anything the person did, so any
   * sentence about the work itself would be refused at G3 — which has no override — while
   * `inferRoleFamilies` read an empty skills list and planned a narrower search than the
   * resume warranted.
   *
   * One aggregate flag each rather than one per entry. Every one of those entries was already
   * flagged for its own missing start date, and twenty-seven "I have checked this" clicks is
   * how a gate stops being read.
   *
   * `lostTheEvidence` is the threshold, and it lives in @ia/shared because the G1 screen shows
   * the paragraph explaining what it costs and the two must not disagree about one profile. It
   * is deliberately not "every entry is bare": the resume this was written for had twenty-seven
   * entries carrying ONE line between them, which an exact-zero test reads as fine. `skills`
   * fires on a resume that produced something, since a document with neither education nor
   * experience has bigger problems and gets flagged for them.
   */
  const corpusFlags: string[] = [];
  if (lostTheEvidence(experience)) corpusFlags.push('experience.bullets');
  if (skills.length === 0 && (experience.length > 0 || education.length > 0)) {
    corpusFlags.push('skills');
  }

  const draft: CandidateProfile = {
    id: ulid(),
    fullName: x.fullName ?? '',
    pronouns: x.pronouns ?? null,
    email,
    phone: x.phone ?? undefined,
    dateOfBirth: null,
    address: { country: home.country ?? 'US' },
    links: {
      github: asUrl(x.links.github),
      linkedin: asUrl(x.links.linkedin),
      portfolio: asUrl(x.links.portfolio),
      other: [],
    },
    // This is the country the authorization question is *about*, not where the user lives:
    // the tool only searches US postings, so the question every posting asks is whether
    // they may work in the US. The answer itself stays 'unknown' and G1 makes them give it.
    workAuthorization: { country: 'US', status: 'unknown', needsSponsorship: false },
    citizenships: [],
    education,
    experience,
    projects: x.projects.map((p) => ({
      name: p.name,
      description: p.description,
      // The schema demands a real URL here for exactly the same reason it does under
      // `links`, and a resume writes a project's address the same way it writes a profile's
      // — "github.com/rosa/parser". Repairing the three under `links` and not this one left
      // half the mechanism working: one bare host name in a projects section still made
      // every read of the profile throw.
      url: asUrl(p.url),
      bullets: p.bullets,
    })),
    skills,
    certifications,
    languages: x.languages,
    availability: { flexible: true },
    locationPrefs: {
      base: { city: home.city, region: home.region, country: home.country ?? 'US' },
      // A resume names one home. The user adds any others they can work from at G1.
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
    confirmedAt: null,
    needsReview: dedupe([
      ...x.needsReview,
      ...REQUIRED_BY_G1,
      ...(x.fullName ? [] : ['fullName']),
      // Flagged whether the resume had no address at all or had one this app cannot use.
      // From the user's side those are the same thing — the tool does not know how to reach
      // them — and only one of the two used to reach the screen that asks.
      ...(email ? [] : ['email']),
      // Every date the resume stated and this file could not store exactly as written —
      // see the readers above, which decide both the stored month and this flag together.
      ...dateFlags,
      // An extraction that came back the right shape with the substance missing.
      ...corpusFlags,
      // Level "other" is the extraction's honest answer for a homeschool co-op or a
      // dual-enrollment academy, and derivation cannot rank it: academicLevel degrades to
      // 'none', the seniority band to entry_intern, and an actively enrolled student
      // silently loses pre-college treatment. Only the user can say what the entry is.
      ...x.education.flatMap((e, i) => (e.level === 'other' ? [`education.${i}.level`] : [])),
      // A GPA the profile shape cannot store — a weighted figure with no unweighted
      // number (a transcript that prints only "4.321 weighted"), or either number missing
      // its scale — used to vanish here with nothing said. The stored gpa keeps a
      // value+scale pair, so anything less than that pair fell through the branch below and
      // was dropped: the number the resume stated was simply gone, and a later true
      // "4.32 weighted GPA" sentence came back red at G3 with no GPA on the profile to
      // match it. Flag any stated-but-unstorable GPA so the user completes the missing half
      // at G1 instead of the figure disappearing in silence.
      ...x.education.flatMap((e, i) => {
        const stated = e.gpaValue !== null || e.gpaScale !== null || e.gpaWeighted !== null;
        const stored = e.gpaValue !== null && e.gpaScale !== null;
        return stated && !stored ? [`education.${i}.gpa`] : [];
      }),
    ]),
    createdAt: ts,
    updatedAt: ts,
  };

  return { ...draft, derived: deriveProfile(draft, now) };
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs)];
}
