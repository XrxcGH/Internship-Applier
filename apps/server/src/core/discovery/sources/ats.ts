/**
 * Adapters for the public ATS job-board APIs — docs/04 § Tier A.
 *
 * These are documented, keyless, public endpoints that exist to be consumed
 * programmatically. Between them they cover most of the companies a student would
 * apply to. Nothing here touches a site whose terms prohibit automated access.
 */
import { fetchJson } from '../../../infra/http/fetcher';
import {
  canonicalUrl,
  parseCompensation,
  parseDurationWeeks,
  parseHybridDays,
  parsePositionType,
  parseRequirements,
  parseSeason,
  parseTermDates,
  parseWorkArrangement,
  parseYear,
} from '../normalize';
import {
  decodeEntities,
  stripHtml,
  type JobSource,
  type NormalizedPosting,
  type SourceQuery,
  wrongShape,
  type SourceResult,
} from './types';

/**
 * What a target with no board token is: a hole in the search, not an empty board.
 *
 * These three adapters fetch a named company's whole board, so without the name there is
 * nothing to fetch. Reported as a `note` this was invisible — `notes` alone sets neither
 * `degraded` nor `skipped` (run.ts), so the run summary read "greenhouse: 0 found" and the
 * user concluded the company had nothing open, when in truth nothing had been asked.
 */
function noBoard(source: string, what: string): SourceResult {
  return {
    postings: [],
    notes: [],
    gaps: [
      `${source}: no ${what} was supplied, so this target fetched nothing. It is not that ` +
        'the board is empty — it was never asked.',
    ],
  };
}

/**
 * A row read off a source's JSON, checked before anything is read out of it.
 *
 * Every adapter in this file used to index straight into whatever the array held. A single
 * null entry in a postings array threw a TypeError out of the adapter and cost the whole
 * board: run.ts catches per target so the run itself survived, but that source reported an
 * error and contributed nothing, when the other 199 of its 200 rows were perfectly
 * readable. The three helpers here are what make a bad row cost its own row and no more.
 */
function isRow(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** A string the source actually sent. An empty one carries nothing and reads as absent. */
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

/**
 * An id the rest of the app can store.
 *
 * Boards state ids as strings and as numbers and both are real, so both are taken. Anything
 * else is not an id, and the bare `String(...)` this replaced stored the literal
 * "[object Object]" as one, which then became half of a posting URL.
 */
function idOf(v: unknown): string | null {
  if (typeof v === 'string' && v !== '') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

/**
 * Turns rows into postings, dropping only the rows that cannot become one.
 *
 * The guards above cover the fields these adapters read by name; this covers everything
 * else. A `url` that is a string but not a URL makes `canonicalUrl` throw, and that threw
 * out of the whole adapter. The count comes back so the caller can report it as a gap:
 * rows that silently vanish are coverage the run would otherwise claim it had.
 */
function buildRows<T>(
  rows: T[],
  make: (row: T) => NormalizedPosting,
): { postings: NormalizedPosting[]; dropped: number } {
  const postings: NormalizedPosting[] = [];
  let dropped = 0;
  for (const row of rows) {
    try {
      postings.push(make(row));
    } catch {
      dropped++;
    }
  }
  return { postings, dropped };
}

/** The gap the count above earns. Worded the same for every adapter that can hit it. */
function unreadableRowsGap(source: string, dropped: number): string {
  return (
    `${source}: ${dropped} rows could not be read into a posting and are missing from these ` +
    'results. The API may have changed.'
  );
}

function build(
  partial: Pick<
    NormalizedPosting,
    'externalId' | 'canonicalUrl' | 'applyUrl' | 'company' | 'title'
  > &
    Partial<NormalizedPosting>,
  text: string,
): NormalizedPosting {
  const haystack = `${partial.title}\n${text}`;
  const dates = parseTermDates(haystack);
  const comp = parseCompensation(haystack);
  const season = parseSeason(haystack);
  const duration = parseDurationWeeks(haystack);

  return {
    companyDomain: null,
    descriptionText: text,
    descriptionHtml: null,
    locations: [],
    positionType: parsePositionType(partial.title, text),
    workArrangement: parseWorkArrangement(haystack),
    hybridDaysOnsite: parseHybridDays(haystack),
    remoteEligibleIn: [],
    programFlags: [],
    term: {
      season,
      year: parseYear(haystack),
      ...(dates ?? {}),
      durationWeeks: duration,
      // A co-op or anything past ~20 weeks spans more than one academic term.
      multiTerm: duration !== null && duration > 20,
    },
    compensation: comp as Record<string, unknown> | null,
    requires: parseRequirements(text),
    postedAt: null,
    closesAt: null,
    atsVendor: 'unknown',
    ...partial,
  };
}

// ---------------------------------------------------------------- Greenhouse

interface GhJob {
  id: number;
  title: string;
  absolute_url: string;
  content?: string;
  updated_at?: string;
  location?: { name?: string };
}

/** The two fields without which there is no posting: what to call it and where it lives. */
function isGhJob(v: unknown): v is GhJob {
  return isRow(v) && str(v['title']) !== undefined && str(v['absolute_url']) !== undefined;
}

export const greenhouse: JobSource = {
  kind: 'greenhouse',
  requiresKey: false,
  isConfigured: () => true,
  async fetch(q: SourceQuery): Promise<SourceResult> {
    if (!q.board) return noBoard('greenhouse', 'board token');
    const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(q.board)}/jobs?content=true`;
    const data = await fetchJson<{ jobs?: unknown }>(url, { rps: 2 });
    const drift = wrongShape('greenhouse', data.jobs);
    if (drift) return drift;

    const rows = Array.isArray(data.jobs) ? (data.jobs as unknown[]) : [];
    const usable = rows.filter(isGhJob);
    const gaps: string[] = [];
    if (usable.length < rows.length) {
      gaps.push(
        `greenhouse: skipped ${rows.length - usable.length} rows the board answered with no ` +
          'title or link. The API may have changed.',
      );
    }

    const { postings, dropped } = buildRows(usable, (j) => {
      // Greenhouse returns `content` HTML-escaped. Decoded first, or stripHtml finds no
      // tags to strip and its own decode step reintroduces them as visible text.
      const raw = str(j.content);
      const html = raw ? decodeEntities(raw) : '';
      const text = stripHtml(html);
      const link = str(j.absolute_url)!;
      return build(
        {
          externalId: idOf(j.id),
          canonicalUrl: canonicalUrl(link),
          applyUrl: link,
          company: q.board!,
          title: str(j.title)!,
          atsVendor: 'greenhouse',
          descriptionHtml: html || null,
          postedAt: str(j.updated_at) ?? null,
          locations: str(j.location?.name) ? [parseLocation(j.location!.name!)] : [],
        },
        text,
      );
    });
    if (dropped > 0) gaps.push(unreadableRowsGap('greenhouse', dropped));

    return { postings, notes: [], gaps };
  },
};

// ---------------------------------------------------------------- Lever

interface LeverPost {
  id: string;
  text: string;
  hostedUrl: string;
  applyUrl?: string;
  descriptionPlain?: string;
  createdAt?: number;
  categories?: { location?: string; commitment?: string; team?: string };
}

/** Lever states the title in `text` and the page in `hostedUrl`; both have to be there. */
function isLeverPost(v: unknown): v is LeverPost {
  return isRow(v) && str(v['text']) !== undefined && str(v['hostedUrl']) !== undefined;
}

export const lever: JobSource = {
  kind: 'lever',
  requiresKey: false,
  isConfigured: () => true,
  async fetch(q: SourceQuery): Promise<SourceResult> {
    if (!q.board) return noBoard('lever', 'company slug');
    const url = `https://api.lever.co/v0/postings/${encodeURIComponent(q.board)}?mode=json`;
    const data = await fetchJson<unknown>(url, { rps: 2 });
    // Lever's root IS the array, so `data.map` already threw on drift and the runner
    // reported it as an error — loud, but as a stack-shaped message about `.map`. Named
    // here instead, in the same words as its siblings.
    const drift = wrongShape('lever', data);
    if (drift) return drift;

    const rows = Array.isArray(data) ? (data as unknown[]) : [];
    const usable = rows.filter(isLeverPost);
    const gaps: string[] = [];
    if (usable.length < rows.length) {
      gaps.push(
        `lever: skipped ${rows.length - usable.length} rows the board answered with no title ` +
          'or link. The API may have changed.',
      );
    }

    const { postings, dropped } = buildRows(usable, (p) => {
      const text = str(p.descriptionPlain) ?? '';
      const hosted = str(p.hostedUrl)!;
      const created = typeof p.createdAt === 'number' ? new Date(p.createdAt) : null;
      const location = str(p.categories?.location);
      return build(
        {
          externalId: idOf(p.id),
          canonicalUrl: canonicalUrl(hosted),
          applyUrl: str(p.applyUrl) ?? hosted,
          company: q.board!,
          title: str(p.text)!,
          atsVendor: 'lever',
          // An epoch that is not a real instant stores nothing rather than "Invalid Date":
          // `new Date(NaN).toISOString()` throws, and it threw out of the whole board.
          postedAt: created && !Number.isNaN(created.getTime()) ? created.toISOString() : null,
          locations: location ? [parseLocation(location)] : [],
        },
        `${text}\n${str(p.categories?.commitment) ?? ''}`,
      );
    });
    if (dropped > 0) gaps.push(unreadableRowsGap('lever', dropped));

    return { postings, notes: [], gaps };
  },
};

// ---------------------------------------------------------------- Ashby

export interface AshbyJob {
  id: string;
  title: string;
  jobUrl: string;
  location?: string;
  descriptionPlain?: string;
  employmentType?: string;
  isRemote?: boolean;
  publishedAt?: string;
  compensation?: { summaryComponents?: AshbyPayComponent[] };
}

interface AshbyPayComponent {
  /** Salary, EquityPercentage, EquityCashValue, Commission, Bonus. Only the first is pay. */
  compensationType?: string;
  /** "1 YEAR", "1 MONTH", "1 HOUR", or "NONE" for a component with no period. */
  interval?: string;
  currencyCode?: string | null;
  minValue?: number | null;
  maxValue?: number | null;
}

const ASHBY_INTERVAL: Record<string, 'hour' | 'week' | 'month' | 'year'> = {
  '1 HOUR': 'hour',
  '1 WEEK': 'week',
  '1 MONTH': 'month',
  '1 YEAR': 'year',
};

/**
 * The pay Ashby states, rather than the pay a regex can find in the prose.
 *
 * The URL above has always asked for this — `includeCompensation=true` — and nothing read
 * the answer, so every Ashby posting's pay came from running the text parser over the
 * description. On a real board that is not a near miss: Ramp's Android internship states
 * $11,700 a month here, and the text pass found an unrelated "$10,000 per year" further
 * down the page and stored that. The queue showed the student a figure fourteen times too
 * small, and the sort that puts better-paid postings first believed it.
 *
 * Only a `Salary` component is pay. Equity, bonus and commission are real numbers that
 * answer a different question, and one of them landing in `min` would be worse than the
 * regex ever was. A component with no interval is skipped rather than guessed at.
 */
// Exported for its tests. The Salary-vs-equity rule is one this file itself calls worse
// than the regex if it goes wrong, and it had no test at all.
export function ashbyPay(job: AshbyJob): Record<string, unknown> | null {
  const components = job.compensation?.summaryComponents;
  if (!Array.isArray(components)) return null;

  for (const c of components as unknown[]) {
    // A null entry in the components array read its `compensationType` and threw, which
    // cost the whole Ashby board rather than this one figure.
    if (!isRow(c)) continue;
    if (c.compensationType !== 'Salary') continue;
    if (typeof c.minValue !== 'number') continue;
    const period = ASHBY_INTERVAL[String(c.interval ?? '').toUpperCase()];
    if (!period) continue;
    return {
      min: c.minValue,
      // A single-figure band arrives as min === max. Storing the pair anyway would render
      // as "$11,700–$11,700/mo", which reads as a range somebody forgot to finish.
      ...(typeof c.maxValue === 'number' && c.maxValue !== c.minValue ? { max: c.maxValue } : {}),
      currency: c.currencyCode ?? 'USD',
      period,
      raw: 'stated by the employer on the job board',
    };
  }
  return null;
}

/** Ashby names the page `jobUrl`; without it and a title there is nothing to store. */
function isAshbyJob(v: unknown): v is AshbyJob {
  return isRow(v) && str(v['title']) !== undefined && str(v['jobUrl']) !== undefined;
}

export const ashby: JobSource = {
  kind: 'ashby',
  requiresKey: false,
  isConfigured: () => true,
  async fetch(q: SourceQuery): Promise<SourceResult> {
    if (!q.board) return noBoard('ashby', 'board name');
    const url = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(q.board)}?includeCompensation=true`;
    const data = await fetchJson<{ jobs?: unknown }>(url, { rps: 2 });
    const drift = wrongShape('ashby', data.jobs);
    if (drift) return drift;

    const rows = Array.isArray(data.jobs) ? (data.jobs as unknown[]) : [];
    const usable = rows.filter(isAshbyJob);
    const gaps: string[] = [];
    if (usable.length < rows.length) {
      gaps.push(
        `ashby: skipped ${rows.length - usable.length} rows the board answered with no title ` +
          'or link. The API may have changed.',
      );
    }

    const { postings, dropped } = buildRows(usable, (j) => {
      const text = str(j.descriptionPlain) ?? '';
      const link = str(j.jobUrl)!;
      const location = str(j.location);
      // Absent, not false: a board that does not state remoteness must leave parseLocation
      // reading it out of the string, which is what an unconditional `=== true` would stop.
      const remoteHint = typeof j.isRemote === 'boolean' ? j.isRemote : undefined;
      const p = build(
        {
          externalId: idOf(j.id),
          canonicalUrl: canonicalUrl(link),
          applyUrl: link,
          company: q.board!,
          title: str(j.title)!,
          atsVendor: 'ashby',
          postedAt: str(j.publishedAt) ?? null,
          locations: location ? [parseLocation(location, remoteHint)] : [],
        },
        `${text}\n${str(j.employmentType) ?? ''}`,
      );
      // Ashby states remoteness structurally; trust that over the text heuristic.
      if (j.isRemote === true && !p.workArrangement) p.workArrangement = 'remote';
      // And it states the pay, which is why the request asks for it. Only when it does:
      // a board that publishes no band leaves the text reading in place rather than
      // replacing a figure that was found with nothing.
      p.compensation = ashbyPay(j) ?? p.compensation;
      return p;
    });
    if (dropped > 0) gaps.push(unreadableRowsGap('ashby', dropped));

    return { postings, notes: [], gaps };
  },
};

// ---------------------------------------------------------------- Workday

/**
 * How a Workday board fits in the one string `SourceQuery.board` carries.
 *
 * A Workday board is not a slug: it is a (tenant, wdHost, site) triple, and all three are
 * needed to build a request. They are encoded here as "tenant@wdHost/site" — the three
 * pieces of the board's own URL, so "https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite"
 * is written "nvidia@wd5/NVIDIAExternalCareerSite". Parsed strictly and rejected through
 * the gaps channel otherwise, because a guessed tenant or site is a URL that 404s and the
 * user would read "0 found" as a company with nothing open.
 */
export function parseWorkdayBoard(
  board: string,
): { tenant: string; host: string; site: string } | null {
  const m = /^([a-z0-9-]+)@(wd\d+)\/([A-Za-z0-9_-]+)$/i.exec(board.trim());
  if (!m) return null;
  // Tenant and host are DNS labels and case-insensitive; the site is a path segment and
  // its case is preserved exactly as given.
  return { tenant: m[1]!.toLowerCase(), host: m[2]!.toLowerCase(), site: m[3]! };
}

/**
 * "Stage" is the French, Dutch and Italian word for an internship, and an ordinary English
 * noun for a phase or a platform, so it is the one word here that has to be read in place.
 *
 * As an internship it opens the title ("Stage - Ingenieur Logiciel", "Stage 6 mois") or sits
 * behind a separator ("Developpeur Web (Stage)", "Ingenieur Logiciel - Stage"). As an
 * English phase it sits mid-phrase behind its modifier ("Early Stage Sales", "Late-Stage
 * Clinical"), which is why a bare `\bstage\b` cannot be used; and as a venue it takes an
 * occupation straight after it ("Stage Manager", "Stage Technician"), which the lookahead
 * refuses. A hyphen counts as a separator only with a space in front of it, because
 * "Late-Stage" has none.
 */
const STAGE_AS_INTERNSHIP =
  /(?:^\s*|[/([]\s*|\s[-–—:,|]\s+)stages?\b(?!\s+(?:manager|management|director|technician|hand|crew|lead|designer|design|production|producer|coordinator|supervisor|electrician|carpenter|door|gate|left|right)s?\b)/i;

/**
 * Whether a title looks like something a student could hold, in the languages these boards
 * are actually written in.
 *
 * ONE definition, exported, because there were two: this file tested an English-only
 * pattern while aggregators.ts tested a German-aware one, and the repo therefore held a
 * correct and an incorrect answer to the same question at the same time. Everything that
 * asks "is this internship shaped" asks here.
 *
 * The English side alone drops real internships wholesale. SmartRecruiters is Europe-heavy
 * and one real board answers `?q=Praktikum` with 202 matches; `\bstudent\b` cannot see
 * itself inside the German "Werkstudent", so `student` is matched as a substring instead.
 * Both directions matter equally: "Internal Audit Manager" and "International Sales Lead"
 * are kept out by the trailing word boundary on `intern`, and losing that boundary would
 * fill the queue with management roles.
 *
 * Gating on this is what keeps one board from costing hundreds of requests: a Workday or
 * SmartRecruiters list row carries no description at all, and a detail page costs one
 * request per posting. Only detail fetches are gated on it — every row a search returned is
 * still kept as a posting.
 */
const INTERNSHIP_TITLE: RegExp[] = [
  // English.
  /\bintern(?:ship)?s?\b/i,
  /\bco-?ops?\b/i,
  /\bnew grad\b/i,
  /\buniversity\b/i,
  /\bapprentice/i,
  // Unanchored, so it also reads the German compounds "Werkstudent", "Werkstudentin" and
  // "Studentische Hilfskraft". No English word other than "student" itself contains it.
  /student/i,
  // German. Not anchored at the front either, because the form a German student most needs
  // is the compound: Pflichtpraktikum, Auslandspraktikum, Vorpraktikum. The suffixes are
  // spelled out so that "praktisch" (practical) does not read as an internship, and the
  // plural "Praktika" counts only as a whole word so that "praktikabel" does not.
  /praktik(?:um|ant|a\b)/i,
  /praxissemester/i,
  // French and Dutch. "Stagiair" is the stem shared by stagiair, stagiaire and the plurals;
  // "alternan" is the work-study contract and cannot reach English "alternate" or
  // "alternating".
  /stagiair/i,
  /alternan(?:ce|t)/i,
  STAGE_AS_INTERNSHIP,
  // Spanish and Portuguese. Both accented and bare spellings, because boards write both.
  // "Prácticas" is plural-only so that the English "practical" and "practice" stay out.
  /pr[áa]cticas/i,
  /becari[oa]/i,
  /pasante/i,
  /estudiante/i,
  /est[áa]gi/i,
  // Italian.
  /tirocin/i,
];

export function internshipShaped(title: string): boolean {
  // None of these carry /g, so `test` keeps no lastIndex between calls and one title's
  // answer cannot depend on the title asked about before it.
  return INTERNSHIP_TITLE.some((re) => re.test(title));
}

/**
 * The searches a SmartRecruiters board is asked when the caller planned no keywords.
 *
 * One term per search, because the endpoint cannot express "any of these words" in one
 * query: measured live, it ORs two words ("internship praktikum" answers 490, which is
 * 288 + 202 dead on) and collapses at three ("internship praktikum werkstudent" answers 1).
 * So a multilingual search has to be several searches, and the board's row budget is shared
 * between them.
 *
 * Rarest first. A search that answers nothing costs one request and hands its whole share to
 * the searches after it, so a board that posts only in English still spends its entire
 * budget on English. The broad English terms come last because their matches are the
 * noisiest: on one real board "intern" matches 1261 postings, most of them "internal" and
 * "international", where "internship" matches 288.
 *
 * NOT used for Workday, which is why this list lives beside the SmartRecruiters adapter
 * rather than in the shared section. Workday's `searchText` is a fuzzy match, not a term
 * match: the same live tenant that answers 919 for "intern" answers 1779 for "prácticas"
 * and 504 for "stage", and those answers are ordinary senior engineering roles, not Spanish
 * or French internships. Spending a shared row budget on them read a board of 189 rows that
 * held 9 internships where the single "intern" search had read 200 that held most of the
 * board's real ones. What is precise on one API is noise on the other, so only the title
 * vocabulary is shared between them.
 *
 * The list is deliberately shorter than `internshipShaped` reads. A word in the filter costs
 * nothing; a word here costs one request per board per run, so only the words that earn a
 * request are here, and the filter stays wide enough that nothing a search returns is
 * dropped for being in a language the search list does not name.
 */
/** The searched terms, quoted, for a sentence the student reads. */
function listSearches(terms: readonly string[]): string {
  const quoted = terms.map((t) => `"${t}"`);
  if (quoted.length <= 1) return quoted[0] ?? 'anything';
  return `${quoted.slice(0, -1).join(', ')} or ${quoted[quoted.length - 1]!}`;
}

const INTERNSHIP_SEARCHES = [
  'praktikum',
  'werkstudent',
  'stage',
  'prácticas',
  'internship',
  'intern',
] as const;

/**
 * The single search term a caller planned, or nothing when they planned none.
 *
 * Blank keywords count as none. Joining them would send an empty search term, and an empty
 * term is the whole board in whatever order it comes back, which is the reading these
 * adapters exist to replace.
 */
function plannedSearchText(keywords: string[] | undefined): string | null {
  const planned = (keywords ?? []).map((k) => k.trim()).filter(Boolean);
  return planned.length > 0 ? planned.join(' ') : null;
}

/**
 * What one search of a board covered, so the run can say what it did not read.
 *
 * `stated` is the total the board claims for that search, or null when it never said one.
 * `capped` is the walk having stopped at its row ceiling rather than at the end of the
 * results, which is coverage lost even when the board never stated a total to compare
 * against. A search that never ran at all — the board's row budget was spent before its
 * turn — is `ran: false`, which is lost just as surely and is reported next to both.
 */
interface SearchCoverage {
  term: string;
  read: number;
  stated: number | null;
  ran: boolean;
  capped: boolean;
}

/**
 * How many rows the next search may read out of a board's remaining budget.
 *
 * Several searches share one per-board ceiling, and letting the first one have all of it
 * starves the rest: on a German board "praktikum" alone would fill the budget and the
 * English "internship" search would never run, and on an American board the reverse. An
 * even share of what is LEFT gives every language a turn and still lets a board that posts
 * in one language spend the whole budget on it, because the searches that answer nothing
 * consume nothing. Never less than one page, or a search would be asked for no rows.
 */
function searchShare(remaining: number, searchesLeft: number, page: number): number {
  if (remaining <= 0) return 0;
  return Math.min(remaining, Math.max(page, Math.ceil(remaining / Math.max(1, searchesLeft))));
}

/**
 * The one gap that says what the searches of a board did not reach.
 *
 * Written as a single gap rather than one per search because six of them would bury the
 * run summary, and the numbers are what matter: which search, how much of it was read, and
 * how much there was. A board where every search was read to the end returns null and says
 * nothing, because there is nothing that was not covered.
 */
function coverageGap(
  source: string,
  coverage: SearchCoverage[],
  boardCap: number,
  perSearchCap = boardCap,
): string | null {
  const short = coverage.filter((c) => c.ran && c.stated !== null && c.stated > c.read);
  // A walk that stopped at its ceiling on a board that never stated a total. Nothing can be
  // compared against, so `short` cannot see it, and without this it is a silent truncation:
  // the run would report a board it stopped reading as a board it read to the end.
  const blind = coverage.filter((c) => c.ran && c.stated === null && c.capped);
  const unrun = coverage.filter((c) => !c.ran);
  if (short.length === 0 && blind.length === 0 && unrun.length === 0) return null;

  const sentences: string[] = [];
  if (short.length > 0) {
    sentences.push(
      `Kept ${short.map((c) => `${c.read} of ${c.stated} matches for "${c.term}"`).join('; ')}.`,
    );
  }
  if (blind.length > 0) {
    sentences.push(
      `Stopped at ${blind.map((c) => `${c.read} rows for "${c.term}"`).join('; ')}, and the ` +
        'board did not say how many more there are.',
    );
  }
  if (unrun.length > 0) {
    sentences.push(
      `No search was run for ${unrun.map((c) => `"${c.term}"`).join(', ')}, because the ` +
        'per-board ceiling was already reached.',
    );
  }
  /**
   * The ceiling QUOTED has to be the ceiling that bound this run, and the advice has to be
   * advice.
   *
   * A board searched with one planned keyword stops at the per-search cap, and the sentence
   * quoted the whole-board cap regardless: a run that stopped at 200 told the student it
   * reads up to 600, so it appeared to have given up 400 rows inside its own budget for no
   * reason. The closing line was backwards in the same case — planning a keyword is what
   * reduced the board to one search, so "narrow the plan's keywords" was advice to do more
   * of what had just cost the coverage.
   */
  const effective = Math.min(boardCap, coverage.length * perSearchCap);
  const advice =
    coverage.length > 1
      ? "Narrow the plan's keywords to see the rest."
      : 'This run searched once, for the keyword the plan named. Searching for something ' +
        'narrower is what reads further into a board this size.';
  return (
    `${source}: this board has more matches than one run reads. ${sentences.join(' ')} ` +
    `A run reads at most ${String(effective)} rows per board across every search. ${advice}`
  );
}

/**
 * The gap a search that could not be read at all earns.
 *
 * Asking a board several searches means several chances to fail, and a board that answers
 * five of six searches has been searched five times, not zero: throwing the whole board away
 * over one bad answer would lose the rows the other searches did return. Only a board where
 * EVERY search failed is reported as a failed source, by the callers below. What one failed
 * search costs is named here rather than passed over, because a term that was never
 * successfully asked is a language the run did not cover.
 */
function unreadableSearchGap(source: string, terms: string[]): string {
  const one = terms.length === 1;
  return (
    `${source}: the search${one ? '' : 'es'} for ${terms.map((t) => `"${t}"`).join(', ')} ` +
    `could not be read, so anything only ${one ? 'it' : 'they'} would have found is missing ` +
    'from these results.'
  );
}

/** The cxs jobs endpoint answers at most 20 rows per page, whatever `limit` asks for. */
const WORKDAY_PAGE = 20;
/** A sane per-board ceiling: 10 pages, shared by every search. Reported in gaps. */
const WORKDAY_MAX_ROWS = 200;
/** Detail pages cost one request each; what was not fetched is reported in gaps. */
const WORKDAY_MAX_DETAILS = 20;

interface WdListRow {
  title?: string;
  externalPath?: string;
  locationsText?: string;
  /** Prose like "Posted 3 Days Ago" — never machine-readable, never used. */
  postedOn?: string;
  bulletFields?: string[];
}

/** A list row worth keeping: something to call it, and a path to fetch or link to. */
function isWdRow(v: unknown): v is WdListRow & { title: string; externalPath: string } {
  return isRow(v) && str(v['title']) !== undefined && str(v['externalPath']) !== undefined;
}

interface WdInfo {
  id?: string;
  jobDescription?: string;
  location?: string;
  /** The date the posting went live, as "2026-05-27" — the readable form of postedOn. */
  startDate?: string;
  timeType?: string;
  jobReqId?: string;
  externalUrl?: string;
  jobRequisitionLocation?: { descriptor?: string; country?: { alpha2Code?: string } };
}

/**
 * A calendar date a board states, as the ISO instant the rest of the app stores.
 *
 * Workday's `startDate` and Workable's `published_on` are dates with no time part.
 * `postedAt` is a datetime everywhere else in the pipeline, and midnight UTC of the stated
 * day adds no information the date did not carry — unlike the list row's "Posted 3 Days
 * Ago" prose, which would need arithmetic against a clock to become a date and is left
 * unread. Anything that does not parse stores null rather than a guess.
 */
function isoDate(day: string | undefined): string | null {
  if (!day) return null;
  const t = Date.parse(day);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/**
 * A Workday location string, read without trusting its word order.
 *
 * Tenants write these largest-first as often as city-first: NVIDIA's board says
 * "US, CA, Santa Clara" where another says "Santa Clara, CA". Fed to parseLocation as-is,
 * the first form files "US" as the city and "CA" as the region — two wrong facts in the
 * queue and the privacy export. When the FIRST part names a country the string can only be
 * largest-first, so it is reversed into the "City, Region, Country" shape parseLocation
 * reads; when it does not, the string is read as written. "2 Locations" is a count, not a
 * place, and stores nothing it does not know.
 *
 * `alpha2` is the machine-readable country the detail page states. It fills the country
 * only when the text named none, because the text is what the employer wrote.
 */
function workdayLocation(
  raw: string | undefined,
  alpha2: string | undefined,
): Array<{ city?: string; region?: string; country?: string; remote: boolean }> {
  if (!raw || /^\d+\s+locations?$/i.test(raw.trim())) {
    return alpha2 ? [{ country: alpha2, remote: false }] : [];
  }
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const largestFirst = parts.length >= 2 && asCountry(parts[0]) !== undefined;
  const loc = parseLocation(largestFirst ? parts.slice().reverse().join(', ') : raw);
  if (!loc.country && alpha2) loc.country = alpha2;
  return [loc];
}

export const workday: JobSource = {
  kind: 'workday',
  requiresKey: false,
  isConfigured: () => true,
  async fetch(q: SourceQuery): Promise<SourceResult> {
    if (!q.board) return noBoard('workday', 'board address');
    const addr = parseWorkdayBoard(q.board);
    if (!addr) {
      return {
        postings: [],
        notes: [],
        gaps: [
          `workday: "${q.board}" is not a Workday board address, so this target fetched ` +
            'nothing. Write it as tenant@wdHost/site, the three pieces of the board URL: ' +
            'https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite is written as ' +
            'nvidia@wd5/NVIDIAExternalCareerSite.',
        ],
      };
    }

    const base = `https://${addr.tenant}.${addr.host}.myworkdayjobs.com`;
    const cxs = `${base}/wday/cxs/${addr.tenant}/${addr.site}`;
    /**
     * One search, not the multilingual set the SmartRecruiters adapter sends.
     *
     * `searchText` here is a fuzzy match rather than a term match: a live tenant answering
     * 919 postings for "intern" answers 1779 for "prácticas" and 504 for "stage", and those
     * answers are senior engineering roles, not Spanish or French internships. Asking this
     * board the vocabulary read 189 rows holding 9 internships where the single "intern"
     * search read 200 holding most of the board's real ones, so the vocabulary is left to
     * the API it is precise on. "intern" is the same default the usajobs adapter uses.
     */
    const searchText = plannedSearchText(q.keywords) ?? 'intern';

    const notes: string[] = [];
    const gaps: string[] = [];
    const rows: unknown[] = [];
    let read = 0;
    // The total the board states, learned ONCE. It used to be assigned on every page with
    // `rows.length` as the fallback, so a later page that simply omitted the key erased a
    // total the walk already knew: 960 unread matches then satisfied `rows.length >= total`,
    // broke the walk, and failed `total > rows.length`, so the truncation gap never fired
    // and a 4% read of the board reported itself as a complete search.
    let stated: number | null = null;
    let capped = false;

    // This endpoint is the same query every visitor's browser sends to render the
    // company's own careers page, and it answers only to POST — the jsonBody option
    // exists for exactly this shape (fetcher.ts).
    for (let offset = 0; ; offset += WORKDAY_PAGE) {
      /**
       * A page that fails partway keeps the rows already read, exactly as drift does below.
       *
       * The fetch used to sit uncontained, so an HTTP error on page three escaped the whole
       * adapter: every row already fetched was discarded, and the runner — which now reads a
       * 404/410/422 as "this board address is gone" and switches the source row off — told
       * the user the address no longer answers about an address that had just answered
       * twenty rows in the same call. The drift branch ten lines down already states the
       * rule this was breaking: rows already fetched are real, and throwing them away
       * reports less than we know.
       *
       * At offset 0 the address really is unreadable, so the error is rethrown and the
       * runner's judgement stands.
       */
      let data: { total?: unknown; jobPostings?: unknown };
      try {
        data = await fetchJson<{ total?: unknown; jobPostings?: unknown }>(`${cxs}/jobs`, {
          rps: 2,
          timeoutMs: 15_000,
          jsonBody: { appliedFacets: {}, limit: WORKDAY_PAGE, offset, searchText },
        });
      } catch (err) {
        if (rows.length === 0) throw err;
        // Stated out loud rather than left to `coverageGap`, which answers null when the
        // board never declared a total — a board that died on page two would otherwise be
        // reported as a complete read.
        gaps.push(
          `workday: the page at offset ${offset} could not be read ` +
            `(${err instanceof Error ? err.message : String(err)}), so the walk stopped there. ` +
            'Results before it are included.',
        );
        break;
      }
      const drift = wrongShape('workday', data.jobPostings);
      if (drift) {
        // Drift on the first page means the endpoint could not be read at all. Drift on a
        // later page keeps what was read and says where the walk stopped, because rows
        // already fetched are real and throwing them away reports less than we know.
        if (rows.length === 0) return drift;
        gaps.push(
          `workday: the page at offset ${offset} answered with an unexpected shape, so the ` +
            'walk stopped there. Results before it are included.',
        );
        break;
      }
      const page = Array.isArray(data.jobPostings) ? (data.jobPostings as unknown[]) : [];
      rows.push(...page);
      read += page.length;
      if (stated === null && typeof data.total === 'number') stated = data.total;
      // A short page ends the walk even when `total` promises more: trusting a total the
      // pages do not deliver would loop forever against an empty answer.
      if (page.length < WORKDAY_PAGE) break;
      if (stated !== null && read >= stated) break;
      if (read >= WORKDAY_MAX_ROWS) {
        capped = true;
        break;
      }
    }

    const shortfall = coverageGap(
      'workday',
      [{ term: searchText, read, stated, ran: true, capped }],
      WORKDAY_MAX_ROWS,
    );
    if (shortfall) gaps.push(shortfall);

    if (rows.length === 0) {
      // A note, not a gap: a company with no internships open is the ordinary answer here,
      // and marking every such board degraded would make the degraded flag meaningless. But
      // the board was asked in one language, and the run summary's "0 found" does not say
      // so, which is the difference between "nothing open" and "nothing we asked for".
      notes.push(
        `workday: this board answered nothing for "${searchText}". A board that posts its ` +
          'internships in another language, as "Praktikum" or "Stage", would not answer ' +
          'that search either.',
      );
    }

    const readable = rows.filter(isWdRow);
    if (readable.length < rows.length) {
      gaps.push(
        `workday: skipped ${rows.length - readable.length} rows the board answered with no ` +
          'title or link. The API may have changed.',
      );
    }
    // A board that ignores `offset`, or that shifts under a walk, answers the same posting
    // on two pages, and a row seen twice is one posting, not two. Deduped on the board's own
    // path rather than on the title, because two distinct requisitions share a title all the
    // time.
    const seen = new Set<string>();
    const usable = readable.filter((r) => {
      if (seen.has(r.externalPath)) return false;
      seen.add(r.externalPath);
      return true;
    });

    const wanted = usable.filter((r) => internshipShaped(r.title));
    const toFetch = wanted.slice(0, WORKDAY_MAX_DETAILS);
    if (usable.length > wanted.length) {
      // A note, not a gap. These rows were deliberately left out of the detail spend because
      // they are not internships, which is the targeting this product exists to do, and they
      // still ship with their title and link. Nothing the student came for was lost.
      notes.push(
        `workday: ${usable.length - wanted.length} of ${usable.length} postings have titles ` +
          'that do not look internship shaped, so their detail pages were not fetched and ' +
          'they carry only their board row.',
      );
    }
    if (wanted.length > toFetch.length) {
      // A GAP, not a note. These ARE internships and they ship with descriptionText '',
      // which is the same thing the student sees when a detail fetch FAILED — and that case
      // has always been a gap. A note sets neither `degraded` nor `skipped` (types.ts,
      // run.ts), so thirty internships of which ten are empty shells read as a complete
      // search of the board. They still ship rather than being dropped: a title, a company
      // and a link the student can open is real coverage, and dropping them would turn a
      // thin posting into no posting at all.
      gaps.push(
        `workday: fetched detail pages for the first ${toFetch.length} internship shaped ` +
          `postings; the other ${wanted.length - toFetch.length} are in these results with no ` +
          'description at all, so nothing could be read from them about requirements, dates ' +
          'or pay. Detail pages cost one request each.',
      );
    }

    const details = new Map<string, WdInfo>();
    let unreadableDetails = 0;
    for (const r of toFetch) {
      try {
        const d = await fetchJson<{ jobPostingInfo?: unknown }>(`${cxs}${r.externalPath}`, {
          rps: 2,
          timeoutMs: 15_000,
        });
        // Shape-checked, not truth-checked: the fields are read one by one below, so this
        // only has to be something fields can be read off at all.
        if (isRow(d.jobPostingInfo)) details.set(r.externalPath, d.jobPostingInfo as WdInfo);
        else unreadableDetails++;
      } catch {
        // One unreadable posting must not take down the board; but it is counted, because
        // a description silently missing reads as a posting that never had one.
        unreadableDetails++;
      }
    }
    if (unreadableDetails > 0) {
      gaps.push(
        `workday: could not read the detail pages for ${unreadableDetails} postings, so ` +
          'their descriptions are missing from these results.',
      );
    }

    const { postings, dropped } = buildRows(usable, (r) => {
      const info = details.get(r.externalPath);
      const html = str(info?.jobDescription) ?? null;
      const text = html ? stripHtml(html) : '';
      // The page a HUMAN lands on, which the detail states outright as externalUrl and
      // which is base/site + externalPath when no detail was fetched. The cxs URL answers
      // JSON and is no use at G4, where the user opens this link to apply themselves.
      const humanUrl = str(info?.externalUrl) ?? `${base}/${addr.site}${r.externalPath}`;
      return build(
        {
          // The req id comes only from the detail. The list row's bulletFields LOOK like
          // they carry it, but which fields a tenant puts there is configurable, so
          // reading bulletFields[0] as an id would store a location or a schedule as one.
          externalId: idOf(info?.jobReqId) ?? idOf(info?.id),
          canonicalUrl: canonicalUrl(humanUrl),
          applyUrl: humanUrl,
          company: addr.tenant,
          title: r.title,
          atsVendor: 'workday',
          descriptionHtml: html,
          postedAt: isoDate(str(info?.startDate)),
          locations: workdayLocation(
            str(info?.location) ?? str(r.locationsText),
            str(info?.jobRequisitionLocation?.country?.alpha2Code),
          ),
        },
        // Joined only from the parts that exist: a list-only posting has no text at all,
        // and `${text}\n${timeType}` stored a lone newline as its "description".
        [text, str(info?.timeType)].filter(Boolean).join('\n'),
      );
    });
    if (dropped > 0) gaps.push(unreadableRowsGap('workday', dropped));

    return { postings, notes, gaps };
  },
};

// ---------------------------------------------------------------- SmartRecruiters

/** The postings endpoint answers at most 100 rows per page. */
const SR_PAGE = 100;
/**
 * The per-board ceiling, shared by every search of that board.
 *
 * Larger than Workday's because a SmartRecruiters page is five times the size, so the same
 * number of requests reads five times the rows: six searches of one page each cost six
 * requests, which is what the old two-request whole-board scan bought a fraction of.
 */
const SR_MAX_ROWS = 600;
/** Rows any one search may take of that ceiling, so no single broad word eats it all. */
const SR_MAX_ROWS_PER_SEARCH = 200;
const SR_MAX_DETAILS = 20;

interface SrRow {
  id?: string | number;
  name?: string;
  releasedDate?: string;
  company?: { identifier?: string; name?: string };
  location?: { city?: string; region?: string; country?: string; remote?: boolean };
}

/** A row with neither an id nor a title is not a posting; both are read below. */
function isSrRow(v: unknown): v is SrRow & { name: string } {
  return isRow(v) && idOf(v['id']) !== null && str(v['name']) !== undefined;
}

interface SrDetail {
  postingUrl?: string;
  applyUrl?: string;
  jobAd?: { sections?: Record<string, { title?: string; text?: string }> };
}

/**
 * A SmartRecruiters location, read field by field rather than parsed out of prose.
 *
 * `country` arrives as a lowercase ISO code ("us", "pl"). The app writes country codes
 * uppercase — the Adzuna adapter stamps 'US' and the USAJOBS one normalizes to 'US' — so
 * a two-letter code is uppercased into that convention; anything longer is a name and is
 * stored as given. `region` is sometimes the literal word "REMOTE", which is the remote
 * flag restated where a region belongs — the flag is already carried, so the word is
 * dropped rather than stored as a place.
 */
function srLocation(
  loc: unknown,
): Array<{ city?: string; region?: string; country?: string; remote: boolean }> {
  if (!isRow(loc)) return [];
  const stated = str(loc['country']);
  const country = stated ? (stated.length === 2 ? stated.toUpperCase() : stated) : undefined;
  const region = str(loc['region']);
  return [
    {
      city: str(loc['city']),
      region: region && !/^remote$/i.test(region) ? region : undefined,
      country,
      remote: loc['remote'] === true,
    },
  ];
}

export const smartrecruiters: JobSource = {
  kind: 'smartrecruiters',
  requiresKey: false,
  isConfigured: () => true,
  async fetch(q: SourceQuery): Promise<SourceResult> {
    if (!q.board) return noBoard('smartrecruiters', 'company identifier');
    const listBase = `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(q.board)}/postings`;

    // This endpoint supports `q=`, and the adapter used to drop the keywords on the floor
    // and read an arbitrary first 200 rows of a board that holds thousands: one real board
    // answers 4805 postings, of whose first 200 rows fifteen were internship shaped, while
    // `?q=Praktikum` alone answers 202 dead-on matches. Measured on that same board, the
    // vocabulary below reads 644 rows of which 437 are internship shaped, for six requests
    // where the old scan spent two. Everything the searches return is still filtered by
    // `internshipShaped`, which reads every language they ask for and more.
    const planned = plannedSearchText(q.keywords);
    const searches = planned !== null ? [planned] : [...INTERNSHIP_SEARCHES];

    const notes: string[] = [];
    const gaps: string[] = [];
    const rows: unknown[] = [];
    const coverage: SearchCoverage[] = [];

    // One failed search must not cost the rows the others returned. See the Workday adapter
    // above, which carries the same three and answers them the same way.
    const unreadable: string[] = [];
    let firstDrift: SourceResult | null = null;
    let firstError: unknown = null;

    for (const [i, term] of searches.entries()) {
      const perSearch = Math.min(
        SR_MAX_ROWS_PER_SEARCH,
        searchShare(SR_MAX_ROWS - rows.length, searches.length - i, SR_PAGE),
      );
      if (perSearch <= 0) {
        coverage.push({ term, read: 0, stated: null, ran: false, capped: true });
        continue;
      }

      let read = 0;
      let capped = false;
      // Learned once, for the same reason as the Workday walk above: reassigning it on every
      // page let a later page that omits `totalFound` erase a total already known, which
      // then broke the walk AND suppressed the truncation gap, so a 4% read of the board
      // reported itself as a complete search.
      let stated: number | null = null;

      try {
        for (let offset = 0; ; offset += SR_PAGE) {
          const data = await fetchJson<{ totalFound?: unknown; content?: unknown }>(
            `${listBase}?limit=${SR_PAGE}&offset=${offset}&q=${encodeURIComponent(term)}`,
            { rps: 2, timeoutMs: 15_000 },
          );
          const drift = wrongShape('smartrecruiters', data.content);
          if (drift) {
            firstDrift ??= drift;
            if (read === 0) unreadable.push(term);
            else {
              gaps.push(
                `smartrecruiters: the page at offset ${offset} of the search for "${term}" ` +
                  'answered with an unexpected shape, so that search stopped there. Results ' +
                  'before it are included.',
              );
            }
            break;
          }
          const page = Array.isArray(data.content) ? (data.content as unknown[]) : [];
          rows.push(...page);
          read += page.length;
          if (stated === null && typeof data.totalFound === 'number') stated = data.totalFound;
          if (page.length < SR_PAGE) break;
          if (stated !== null && read >= stated) break;
          if (read >= perSearch) {
            capped = true;
            break;
          }
        }
      } catch (err) {
        firstError ??= err;
        unreadable.push(term);
      }
      // Recorded even when it ended badly, so whatever it did read still counts towards the
      // totals the coverage gap reports.
      coverage.push({ term, read, stated, ran: true, capped });
    }

    if (rows.length === 0 && unreadable.length === searches.length) {
      if (firstError !== null) throw firstError;
      if (firstDrift !== null) return firstDrift;
    }
    if (unreadable.length > 0) gaps.push(unreadableSearchGap('smartrecruiters', unreadable));

    const shortfall = coverageGap('smartrecruiters', coverage, SR_MAX_ROWS, SR_MAX_ROWS_PER_SEARCH);
    if (shortfall) gaps.push(shortfall);

    if (rows.length === 0) {
      /**
       * The same sentence the Workday adapter says, for the same reason, because the silence
       * was worse here: Workday asks one term and says which, while this asks up to six and
       * said nothing at all. A board that answered every one of them with nothing came back
       * postings 0, notes 0, gaps 0 — indistinguishable from a board nobody asked, and the
       * run summary's "0 found" then reads as "this company has no internships".
       *
       * A note rather than a gap: a company with no internships open is the ordinary answer,
       * and marking every such board degraded would empty that flag of meaning.
       */
      notes.push(
        `smartrecruiters: this board answered nothing for ${listSearches(searches)}. A board ` +
          'that posts its internships under a word none of those searches name would not ' +
          'answer them either.',
      );
    }

    const readable = rows.filter(isSrRow);
    if (readable.length < rows.length) {
      /**
       * Counted as DISTINCT rows, not as row reads.
       *
       * Up to six searches run over one board and they overlap heavily, so the same row comes
       * back several times. Readable duplicates are collapsed a few lines below, by id — but
       * an unreadable row has no id to collapse on, so it was counted once per search that
       * saw it: one bad row on a two-row board was reported to the student as six, and a
       * board with a hundred would have claimed six hundred. That number reaches the run
       * summary as a statement about how far this board has drifted from its own API.
       *
       * Serialising is sound here because these rows came out of JSON.parse a moment ago, so
       * they carry no cycles and no functions. An unserialisable row falls back to being
       * counted on its own, which is the old behaviour for that one row rather than for all
       * of them.
       */
      const distinctBad = new Set(
        rows
          .filter((r) => !isSrRow(r))
          .map((r, i) => {
            try {
              return JSON.stringify(r) ?? `undefined:${String(i)}`;
            } catch {
              return `unserialisable:${String(i)}`;
            }
          }),
      ).size;
      gaps.push(
        `smartrecruiters: skipped ${String(distinctBad)} rows the board answered ` +
          'with no id or title. The API may have changed.',
      );
    }
    // Several searches over one board return the same posting more than once, and a row seen
    // twice is one posting, not two.
    const seen = new Set<string>();
    const usable = readable.filter((r) => {
      const id = idOf(r.id)!;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });

    // The list rows carry no text at all, and a detail page costs one request per posting
    // — the same economics as Workday, gated the same way so the two cannot disagree
    // about which postings deserve the spend.
    const wanted = usable.filter((r) => internshipShaped(r.name));
    const toFetch = wanted.slice(0, SR_MAX_DETAILS);
    if (usable.length > wanted.length) {
      // A note: these rows are the full-text search's own false positives, they are not
      // internships, and they still ship with their title and link. See the Workday adapter
      // for why the next one is a gap and this one is not.
      notes.push(
        `smartrecruiters: ${usable.length - wanted.length} of ${usable.length} postings ` +
          'have titles that do not look internship shaped, so their detail pages were not ' +
          'fetched and they carry only their board row.',
      );
    }
    if (wanted.length > toFetch.length) {
      gaps.push(
        `smartrecruiters: fetched detail pages for the first ${toFetch.length} internship ` +
          `shaped postings; the other ${wanted.length - toFetch.length} are in these results ` +
          'with no description at all, so nothing could be read from them about ' +
          'requirements, dates or pay. Detail pages cost one request each.',
      );
    }

    const details = new Map<string, SrDetail>();
    let unreadableDetails = 0;
    for (const r of toFetch) {
      const id = idOf(r.id)!;
      try {
        const detail = await fetchJson<unknown>(`${listBase}/${encodeURIComponent(id)}`, {
          rps: 2,
          timeoutMs: 15_000,
        });
        if (isRow(detail)) details.set(id, detail as SrDetail);
        else unreadableDetails++;
      } catch {
        unreadableDetails++;
      }
    }
    if (unreadableDetails > 0) {
      gaps.push(
        `smartrecruiters: could not read the detail pages for ${unreadableDetails} ` +
          'postings, so their descriptions are missing from these results.',
      );
    }

    const { postings, dropped } = buildRows(usable, (r) => {
      const id = idOf(r.id)!;
      const detail = details.get(id);
      const sections = detail?.jobAd?.sections;
      // The job's own sections, not the whole ad: companyDescription is boilerplate that
      // repeats on every posting, and the text parsers downstream would read a
      // company-wide figure in it as this posting's pay.
      const html =
        [str(sections?.['jobDescription']?.text), str(sections?.['qualifications']?.text)]
          .filter(Boolean)
          .join('\n') || null;
      const text = html ? stripHtml(html) : '';
      // The public posting page, which the detail states as postingUrl. When no detail was
      // fetched the page still exists at jobs.smartrecruiters.com/{company}/{id} — the
      // documented public pattern, which redirects onto the slugged form of the same URL.
      // The API's own `ref` URL answers JSON and is no use to the human at G4.
      const humanUrl =
        str(detail?.postingUrl) ??
        `https://jobs.smartrecruiters.com/${encodeURIComponent(q.board!)}/${id}`;
      return build(
        {
          externalId: id,
          canonicalUrl: canonicalUrl(humanUrl),
          applyUrl: str(detail?.applyUrl) ?? humanUrl,
          company: str(r.company?.name) ?? q.board!,
          title: r.name,
          atsVendor: 'smartrecruiters',
          descriptionHtml: html,
          postedAt: str(r.releasedDate) ?? null,
          locations: srLocation(r.location),
        },
        text,
      );
    });
    if (dropped > 0) gaps.push(unreadableRowsGap('smartrecruiters', dropped));

    return { postings, notes, gaps };
  },
};

// ---------------------------------------------------------------- Workable

interface WorkableJob {
  title?: string;
  shortcode?: string;
  url?: string;
  application_url?: string;
  /** Dates with no time part, "2026-06-10". */
  published_on?: string;
  created_at?: string;
  city?: string;
  state?: string;
  country?: string;
  telecommuting?: boolean;
  employment_type?: string;
  /** "Internship", "Entry level", … — Workable states the level structurally. */
  experience?: string;
  description?: string;
  locations?: Array<{
    country?: string;
    countryCode?: string;
    city?: string;
    region?: string;
  }>;
}

/** The widget names the page `url`; without it and a title there is nothing to store. */
function isWorkableJob(v: unknown): v is WorkableJob {
  return isRow(v) && str(v['title']) !== undefined && str(v['url']) !== undefined;
}

/**
 * Workable states locations structurally, so nothing here is parsed out of prose.
 *
 * The `locations` array carries a machine-readable countryCode ("FR") alongside the
 * written-out country, and the code is preferred because the rest of the app stores codes.
 * Older responses carry only the flat city/state/country fields, where the country is a
 * spelled-out name and is stored as given — the same rule parseLocation applies to a name
 * a string actually states. A job with neither stores no location at all.
 */
function workableLocations(
  j: WorkableJob,
): Array<{ city?: string; region?: string; country?: string; remote: boolean }> {
  const remote = j.telecommuting === true;
  // A null entry in this array read `l.city` off it and threw, taking the whole board with
  // it. An entry that is not a record states no place and is left out; an entry that states
  // one is read field by field.
  const locs = (Array.isArray(j.locations) ? (j.locations as unknown[]) : []).filter(isRow);
  if (locs.length > 0) {
    return locs.map((l) => ({
      city: str(l['city']),
      region: str(l['region']),
      country: str(l['countryCode']) ?? str(l['country']),
      remote,
    }));
  }
  const city = str(j.city);
  const region = str(j.state);
  const country = str(j.country);
  if (city || region || country) return [{ city, region, country, remote }];
  return remote ? [{ remote: true }] : [];
}

export const workable: JobSource = {
  kind: 'workable',
  requiresKey: false,
  isConfigured: () => true,
  async fetch(q: SourceQuery): Promise<SourceResult> {
    if (!q.board) return noBoard('workable', 'account name');
    // `details=true` is what puts each job's description in this one response — without
    // it the widget answers titles alone and every description would cost a page fetch
    // this adapter never has to make.
    const url = `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(q.board)}?details=true`;
    const data = await fetchJson<{ name?: unknown; jobs?: unknown }>(url, {
      rps: 2,
      timeoutMs: 15_000,
    });
    const drift = wrongShape('workable', data.jobs);
    if (drift) return drift;

    const rows = Array.isArray(data.jobs) ? (data.jobs as unknown[]) : [];
    const usable = rows.filter(isWorkableJob);
    const gaps: string[] = [];
    if (usable.length < rows.length) {
      gaps.push(
        `workable: skipped ${rows.length - usable.length} rows the board answered with no ` +
          'title or link. The API may have changed.',
      );
    }

    const { postings, dropped } = buildRows(usable, (j) => {
      const html = str(j.description) ?? null;
      const text = html ? stripHtml(html) : '';
      const link = str(j.url)!;
      const p = build(
        {
          externalId: idOf(j.shortcode),
          canonicalUrl: canonicalUrl(link),
          applyUrl: str(j.application_url) ?? link,
          company: str(data.name) ?? q.board!,
          title: str(j.title)!,
          atsVendor: 'workable',
          descriptionHtml: html,
          postedAt: isoDate(str(j.published_on) ?? str(j.created_at)),
          locations: workableLocations(j),
        },
        // The structural fields join the haystack so the deterministic parsers can read
        // them: "Internship" in `experience` is what tells parsePositionType about a job
        // whose title does not say the word. Joined only from the parts that exist, so a
        // job with no description stores an empty text rather than stray newlines.
        [text, str(j.employment_type), str(j.experience)].filter(Boolean).join('\n'),
      );
      // Workable states remoteness structurally; trust that over the text heuristic, the
      // same way the Ashby adapter does.
      if (j.telecommuting === true && !p.workArrangement) p.workArrangement = 'remote';
      return p;
    });
    if (dropped > 0) gaps.push(unreadableRowsGap('workable', dropped));

    return { postings, notes: [], gaps };
  },
};

// ---------------------------------------------------------------- shared

const REMOTE_RE = /\bremote\b/i;

/**
 * A location string saying, in so many words, that somebody has to be there.
 *
 * Boards attach this to the place: "München (Hybrid)", "Austin, TX — Onsite". It is the more
 * specific statement than a feed's `remote` boolean, which several boards set on anything not
 * fully in-office — Arbeitnow flags a Munich hybrid role remote — so where the two disagree
 * the words win. Read the wrong way round it is not a small error: a hybrid job in Munich
 * scored as high as one at home for a student in Half Moon Bay, and six of the fifteen
 * eligible matches in a real run were German roles that had arrived this way.
 */
const ONSITE_RE = /\b(?:hybrid|on[-\s]?site|in[-\s]?office|vor\s+ort)\b/i;

/**
 * The same words where they trail a place, so the CITY does not keep them.
 *
 * The separator goes with them. Boards write "New York, NY — Onsite" as often as they use a
 * comma, and removing only the word left the region recorded as "NY —".
 */
const ONSITE_TOKEN =
  /[\s\-–—/|]*[([]?\b(?:hybrid|on[-\s]?site|in[-\s]?office|vor\s+ort)\b[)\]]?[\s\-–—/|]*$/i;

/**
 * Words a board leaves behind that are furniture, not geography.
 *
 * Arbeitnow writes a fully-remote job's location as "Remote job", so stripping the remote
 * wording left "job" — and "job" was stored as the CITY. The posting then told the student it
 * was based in a place called job, and once a named city started costing a remote role rank
 * (see score.ts) it cost this one too, on the strength of a word that was never a place.
 */
const NOT_A_PLACE = new Set([
  'job',
  'jobs',
  'position',
  'positions',
  'role',
  'roles',
  'opening',
  'openings',
  'vacancy',
  'vacancies',
  'opportunity',
  'opportunities',
  'work',
  'various',
  'multiple',
  'unknown',
  'n/a',
  'na',
  'tbd',
]);

/**
 * Ways of writing "nowhere in particular", which state remoteness rather than a place.
 *
 * The same mistake as NOT_A_PLACE with one addition: these carry the meaning the feed's
 * `remote` flag would have, so they are read as remoteness before being dropped. German
 * boards write it "Homeoffice", and a real run has a posting whose recorded city is exactly
 * that.
 */
const ANYWHERE_RE =
  /^(?:anywhere|worldwide|global(?:ly)?|home[-\s]?office|work\s+from\s+home|wfh)$/i;

/** A part that survived the strippers above without naming a place. */
function namesNoPlace(part: string): boolean {
  return NOT_A_PLACE.has(part.toLowerCase()) || ANYWHERE_RE.test(part);
}

/** The word itself plus the qualifiers boards habitually attach to it. */
const REMOTE_TOKEN = /\b(?:fully\s+|100%\s+)?remote(?:[- ](?:only|first|work|position|role))?\b/gi;

/**
 * The same pattern without `/g`, for asking rather than replacing.
 *
 * `test` on a global regex advances `lastIndex` and leaves it there, so reusing
 * REMOTE_TOKEN to ask the question would make each answer depend on which part was asked
 * about before it.
 */
const MENTIONS_REMOTE = new RegExp(REMOTE_TOKEN.source, 'i');

/**
 * Removes the remote wording from one comma-separated part and keeps whatever geography
 * was sitting next to it.
 *
 * A part that so much as mentioned remoteness used to be dropped whole, so "Remote - US"
 * lost the country entirely and "New York, NY or Remote" lost the state. Both are ordinary
 * Greenhouse and Lever location strings, and both left the posting looking like it names
 * nowhere at all.
 */
function stripRemoteToken(part: string): string {
  // Nothing to strip means nothing to tidy. This runs over EVERY comma-part, and the
  // conjunction trim below would otherwise eat a part that is exactly "OR" — Oregon's
  // state code — leaving "Portland, OR" recorded as a city in no state at all. A part that
  // never mentioned remoteness is returned untouched.
  if (!MENTIONS_REMOTE.test(part)) return part.trim();

  return (
    part
      .replace(REMOTE_TOKEN, ' ')
      .replace(/\s+/g, ' ')
      .replace(/^[\s\-–—/|]+|[\s\-–—/|]+$/g, '')
      // One conjunction, from one end, and never down to nothing. Trimming both ends at
      // once turned "OR or Remote" — Portland's state followed by the conjunction — into an
      // empty string, so a Portland posting recorded a city in no state at all.
      .replace(/\s+(?:or|and)$/i, '')
      .replace(/^(?:or|and)\s+/i, '')
      // "Remote (US)" leaves a lone bracketed country behind. Only a part that is bracketed
      // end to end is unwrapped, so "New York (NY)" keeps both of its brackets.
      .replace(/^[([{]([^()[\]{}]*)[)\]}]$/, '$1')
      // The word that joined the two halves, left holding the place it introduced.
      //
      // Same shape as NOT_A_PLACE, one word further on: "Remote in USA" lost the remote
      // wording and handed back "in USA", which parseLocation filed as the CITY. A live run
      // over 2,941 postings recorded forty of them as based in a town called "in USA", "in
      // Canada" or "in UK" — and the country each of those strings actually named was
      // thrown away, because "in USA" is not a country name and "USA" is.
      //
      // Only a preposition with a place after it goes. The `\s+` is what makes that safe:
      // Independence, Indianapolis and Inglewood have nothing after the "in" to match, and
      // nothing reaches here at all unless the part mentioned remoteness.
      .replace(/^(?:in|within|across|throughout|around|based\s+in|anywhere\s+in)\s+/i, '')
      .trim()
  );
}

/**
 * Country names as boards write them, used to tell "Berlin, Germany" from "Austin, TX".
 *
 * Two-letter ISO codes are deliberately absent. CA, IN, DE, LA, MD, MT, NE and PA are all
 * US state abbreviations as well as country codes, and the state reading is overwhelmingly
 * the more common one on these boards — treating "San Francisco, CA" as a Canadian posting
 * would be a far worse error than the one this table is here to fix. England, Scotland and
 * Wales are absent for the same reason in reverse: they are the region half of "London,
 * England", not the country.
 */
const COUNTRY_NAMES = new Set([
  'us',
  'u s',
  'usa',
  'u s a',
  'united states',
  'united states of america',
  'uk',
  'united kingdom',
  'great britain',
  'ireland',
  'canada',
  'mexico',
  'brazil',
  'argentina',
  'chile',
  'colombia',
  'costa rica',
  'germany',
  'france',
  'spain',
  'italy',
  'portugal',
  'netherlands',
  'the netherlands',
  'belgium',
  'luxembourg',
  'switzerland',
  'austria',
  'denmark',
  'sweden',
  'norway',
  'finland',
  'iceland',
  'poland',
  'czechia',
  'czech republic',
  'slovakia',
  'hungary',
  'romania',
  'bulgaria',
  'greece',
  'croatia',
  'serbia',
  'ukraine',
  'estonia',
  'latvia',
  'lithuania',
  'turkey',
  'india',
  'china',
  'japan',
  'korea',
  'south korea',
  'taiwan',
  'hong kong',
  'singapore',
  'malaysia',
  'thailand',
  'vietnam',
  'indonesia',
  'philippines',
  'pakistan',
  'bangladesh',
  'israel',
  'saudi arabia',
  'qatar',
  'uae',
  'united arab emirates',
  'egypt',
  'morocco',
  'nigeria',
  'kenya',
  'ghana',
  'south africa',
  'australia',
  'new zealand',
]);

function asCountry(part: string | undefined): string | undefined {
  if (!part) return undefined;
  return COUNTRY_NAMES.has(part.replace(/\./g, '').trim().toLowerCase()) ? part : undefined;
}

export function parseLocation(
  raw: string,
  remoteHint?: boolean,
): { city?: string; region?: string; country?: string; remote: boolean } {
  const saysOnsite = ONSITE_RE.test(raw);
  const cleaned = raw
    .split(/[,|]/)
    .map((s) => stripRemoteToken(s.trim()).replace(ONSITE_TOKEN, '').trim())
    // A part that was ONLY an arrangement word is not a place. "Austin, TX, Hybrid" used to
    // file "Hybrid" as the country — asCountry drops it — but "Austin, Hybrid" filed it as the
    // REGION, and that is what the posting then claimed to the user.
    .filter((s) => s !== '' && !ONSITE_RE.test(s));

  // The hint is a board's boolean and the text is the board's own words about the same job.
  // Where they disagree the words win — see ONSITE_RE. When the text says nothing either way
  // the hint stands, which is the case it was added for.
  const remote = saysOnsite
    ? false
    : (remoteHint ?? (REMOTE_RE.test(raw) || cleaned.some((s) => ANYWHERE_RE.test(s))));

  // Read for remoteness first, dropped as geography second: a string that named nowhere in
  // particular has now said everything it had to say.
  const parts = cleaned.filter((s) => !namesNoPlace(s));

  // "Berlin, Germany" and "London, UK" are as common on these boards as "Austin, TX", and
  // reading the second part positionally as a region filed the country under region — so a
  // posting the user opened said "Based in Berlin Germany" with no country recorded at all,
  // and the privacy export showed the same. Only the last part is tested, and only against
  // names, so a two-part string that really is "City, Region" is untouched.
  if (parts.length <= 2) {
    const country = asCountry(parts.at(-1));
    if (country) return { city: parts.length === 2 ? parts[0] : undefined, country, remote };
  }

  // No country unless the string names one. These boards usually give "City, Region" and
  // nothing more, so filling the gap with "US" recorded "London, England" and "Toronto,
  // Ontario" as American — and that is what gets stored on the posting and handed back in
  // the privacy export. An unknown country stays unknown, the same as every other parser
  // in the discovery path.
  //
  // The trailing part goes through asCountry too, exactly like the two-part branch above: a
  // three-part free-text string is as often "City, Region, <arrangement/metro>" as it is
  // "City, Region, Country" — "New York, NY, Hybrid", "Austin, TX, Onsite", "San Francisco,
  // CA, Bay Area" — and taking parts[2] verbatim filed "Hybrid" as the country and exported
  // it as a fact. When the last part is not a country name it is dropped, not guessed at.
  return { city: parts[0], region: parts[1], country: asCountry(parts[2]), remote };
}

export const ATS_SOURCES = {
  greenhouse,
  lever,
  ashby,
  workday,
  smartrecruiters,
  workable,
} as const;
export type AtsSourceName = keyof typeof ATS_SOURCES;
