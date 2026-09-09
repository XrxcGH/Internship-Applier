/**
 * Aggregator sources and the community internship list — docs/04 § Tier A.
 *
 * Adzuna and USAJOBS both need a free API key. When one isn't configured the adapter
 * reports itself unconfigured and the run summary says so explicitly, rather than
 * quietly contributing nothing — an invisible gap in coverage reads as "we searched
 * everywhere" when we didn't.
 *
 * Those notes name the .env file because that is where the keys are read from. They used to
 * say "in Settings", and Settings has no key field and no mention of either source: the one
 * place a user finds out why federal internships were missing sent them looking for a box
 * that does not exist, with no second instruction to fall back on.
 *
 * Arbeitnow and Remotive need no key at all — both publish documented public JSON endpoints
 * — but "documented" is not the same as "welcome", and nobody had asked either host. Both
 * were fetched through fetchJson, which defaults `isDocumentedApi: true` and so skips the
 * robots.txt check outright; fetchJson's own docstring calls that default "a convenience,
 * not a claim about the URL". remotive.com/robots.txt carries `Disallow: /api/*` and
 * `Disallow: /*search=`, and the URL this file built was matched by both, so the tool was
 * reading a path the site asks automated clients to leave alone. docs/04 § Politeness is
 * what a user reads to believe this tool obeys robots.txt, so both keyless adapters now go
 * through the robots-respecting path and let each host's own file answer: Arbeitnow's allows
 * the feed, Remotive's refuses, and a refusal is reported as a plain gap in the student's
 * words rather than as a source that searched and found nothing.
 *
 * Unlike the two keyed sources they are firehoses of every seniority, so each filters
 * to internship-shaped rows before normalizing and says in its notes how many rows the
 * filter dropped. Without that count a run that read four hundred jobs and kept three would
 * look like a source that was barely consulted.
 */
import { DEFAULT_FILTERS } from '@ia/shared';
import { fetchJson, HttpError, politeFetch } from '../../../infra/http/fetcher';
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
import { internshipShaped, parseLocation } from './ats';
import {
  decodeEntities,
  stripHtml,
  wrongShape,
  type JobSource,
  type NormalizedPosting,
  type SourceQuery,
  type SourceResult,
} from './types';

function build(
  partial: Pick<
    NormalizedPosting,
    'externalId' | 'canonicalUrl' | 'applyUrl' | 'company' | 'title'
  > &
    Partial<NormalizedPosting>,
  text: string,
): NormalizedPosting {
  const hay = `${partial.title}\n${text}`;
  const dates = parseTermDates(hay);
  const duration = parseDurationWeeks(hay);
  return {
    companyDomain: null,
    descriptionText: text,
    descriptionHtml: null,
    locations: [],
    positionType: parsePositionType(partial.title, text),
    workArrangement: parseWorkArrangement(hay),
    hybridDaysOnsite: parseHybridDays(hay),
    remoteEligibleIn: [],
    programFlags: [],
    term: {
      season: parseSeason(hay),
      year: parseYear(hay),
      ...(dates ?? {}),
      durationWeeks: duration,
      multiTerm: duration !== null && duration > 20,
    },
    compensation: parseCompensation(hay) as Record<string, unknown> | null,
    requires: parseRequirements(text),
    postedAt: null,
    closesAt: null,
    atsVendor: 'unknown',
    ...partial,
  };
}

// ------------------------------------------------- reading rows off an untrusted feed

/**
 * The entries of a jobs array that can be read as a posting at all, and a count of the rest.
 *
 * Every adapter in this file used to walk the array straight, so a single `null` entry threw
 * a TypeError out of the whole source: "Cannot read properties of null (reading 'job_type')"
 * cost four hundred readable siblings their run. The rest of these adapters are written to
 * survive drift row by row — the kept/usable filters, wrongShape, the per-row catch below —
 * and this was the one hole in that intent. An entry that is not an object is coverage we
 * did not get from that entry and nothing more, so it is skipped, counted, and reported.
 *
 * Arrays are excluded along with primitives and null: `[...]` is not a posting either, and
 * `typeof [] === 'object'` would have let one through to be read field by field as blanks.
 */
function readableRows<T>(value: unknown): { rows: T[]; unusable: number; sent: number } {
  const all = Array.isArray(value) ? value : [];
  const rows = all.filter(
    (row): row is T => typeof row === 'object' && row !== null && !Array.isArray(row),
  );
  // `sent` is what the response carried, which is what the truncation checks have to compare
  // a declared total against: comparing against the rows we could read reports a source as
  // truncated when the only thing that went wrong was one unreadable row, and the rows we
  // could not read are already reported on their own.
  return { rows, unusable: all.length - rows.length, sent: all.length };
}

/**
 * A field a feed documents as text, used only when it really is text.
 *
 * A description that arrived as a number reached stripHtml and threw "html.replace is not a
 * function"; a numeric `location` threw the same way out of parseLocation. Neither is worth
 * a whole board. An empty string reads everywhere below as "the feed did not say", which is
 * exactly what a field of the wrong type tells us.
 */
function textField(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * A row whose TITLE is not text cannot be judged internship-shaped at all.
 *
 * `textField` turns such a title into an empty string, the internship filter reads nothing
 * in it, and the row was dropped and then counted in the note as one of the rows "that are
 * not internships" — a statement about a posting nobody could read. One row is noise; a feed
 * that changed the type of its title field would drop every row in the source and the run
 * would still report a complete search of it. So these are separated out before the filter
 * runs and reported as what they are.
 */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function titleUnreadable(value: unknown): boolean {
  return value !== undefined && value !== null && typeof value !== 'string';
}

/**
 * The same read, plus whether the feed put something there that was not text.
 *
 * textField alone turns a description that arrived as a number into an empty one, and an
 * empty description is the posting the student opens to find nothing in it. One such row is
 * noise; a feed that changed the type of the field would empty out every posting in the
 * source and the run would still read as a complete search of it, which is the failure the
 * gaps channel exists to prevent. So the row is kept (its link and title are real and the
 * student can still open it) and the count is reported.
 *
 * An absent field and a null one are not drift: they are the feed saying it has nothing for
 * this posting, which it is entitled to do and which the empty string already means.
 */
function driftedText(value: unknown): { text: string; drifted: boolean } {
  if (typeof value === 'string') return { text: value, drifted: false };
  return { text: '', drifted: value !== undefined && value !== null };
}

/** What to say about postings that kept their link but lost a field to a type change. */
function driftedFieldGap(source: string, count: number): string[] {
  if (count === 0) return [];
  const rows = count === 1 ? 'posting' : 'postings';
  return [
    `${source}: kept ${count} ${rows} whose description or location did not arrive as text, ` +
      'so those fields are empty here even though the source may have filled them. The feed ' +
      'format may have changed.',
  ];
}

/**
 * An id these feeds write as either a string or a number, and nothing else counts as one.
 *
 * `String(value)` on its own turns an absent id into the literal "null" and an object into
 * "[object Object]", and externalId is matched against on the next run — a stable-looking
 * id that is really the same placeholder for every row would merge unrelated postings.
 */
function idField(value: unknown): string | null {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : null;
}

/**
 * What to say about rows that could not be read, as a gap rather than a note.
 *
 * These rows are postings that exist on the board and are not in the results, which is
 * coverage not obtained: `notes` alone sets neither `degraded` nor `skipped` (run.ts), so
 * a feed that changed shape mid-list would have reported the survivors as a complete search.
 */
function unusableRowGap(source: string, count: number): string[] {
  if (count === 0) return [];
  const rows = count === 1 ? 'row' : 'rows';
  const they = count === 1 ? 'it is' : 'they are';
  return [
    `${source}: skipped ${count} ${rows} that could not be read as a job posting, so ` +
      `${they} not in these results. The feed format may have changed.`,
  ];
}

/**
 * Whether a failed fetch is robots.txt refusing us, put into words for the student.
 *
 * politeFetch raises both robots outcomes as a 403 — the path is disallowed, or the file
 * could not be read and so nothing may be assumed — and a 403 the server itself sent is
 * also a 403, so the message is what separates them. Returning null for anything else lets
 * a real HTTP failure travel on to the runner's own error handling, which already reports
 * it; only the robots case needs saying differently, because "we chose not to ask" is not
 * the same story as "we asked and it broke".
 */
function robotsRefusal(source: string, err: unknown): string | null {
  if (!(err instanceof HttpError) || err.status !== 403) return null;
  if (!/robots\.txt/i.test(err.message)) return null;
  if (/disallow/i.test(err.message)) {
    return (
      `${source}: not read. This site's robots.txt asks automated clients to stay off the ` +
      'address this source uses, and this tool does what a site asks, so nothing from it is ' +
      'in these results. You can search the site yourself and paste a job URL directly.'
    );
  }
  return `${source}: not read this run. ${err.message}`;
}

// ---------------------------------------------------------------- Adzuna

interface AdzunaJob {
  id: string;
  title: string;
  description: string;
  redirect_url: string;
  created?: string;
  company?: { display_name?: string };
  location?: { display_name?: string; area?: string[] };
  salary_min?: number;
  salary_max?: number;
}

/**
 * Adzuna splits its API by country and this adapter only ever asks the US partition — the
 * `us` segment in the search URL below. The country stamped on each result is derived from
 * that same constant so the two cannot drift apart: point this at another partition and
 * the locations follow, instead of quietly labelling Berlin and Manchester postings as
 * American the way a separately written `country: 'US'` would.
 */
const ADZUNA_COUNTRY = 'us';

export const adzuna: JobSource = {
  kind: 'adzuna',
  requiresKey: true,
  isConfigured: () => Boolean(process.env.ADZUNA_APP_ID && process.env.ADZUNA_APP_KEY),
  async fetch(q: SourceQuery): Promise<SourceResult> {
    if (!adzuna.isConfigured()) {
      return {
        postings: [],
        notes: [
          'adzuna: skipped — no API key. Get a free one at developer.adzuna.com and set ' +
            'ADZUNA_APP_ID / ADZUNA_APP_KEY in the .env file at the root of this project, ' +
            'then restart the server.',
        ],
      };
    }

    const what = encodeURIComponent(q.keywords?.join(' ') ?? 'internship');
    const where = encodeURIComponent(q.location ?? '');
    const perPage = Math.min(q.limit ?? 50, 50);
    const url =
      `https://api.adzuna.com/v1/api/jobs/${ADZUNA_COUNTRY}/search/1` +
      `?app_id=${process.env.ADZUNA_APP_ID}&app_key=${process.env.ADZUNA_APP_KEY}` +
      `&results_per_page=${perPage}&what=${what}${where ? `&where=${where}` : ''}` +
      `&content-type=application/json`;

    const data = await fetchJson<{ results?: AdzunaJob[]; count?: number }>(url, { rps: 1 });
    const drift = wrongShape('adzuna', data.results);
    if (drift) return drift;

    // A row at a time, with the row's own failure costing only that row. The `.map` this
    // replaces threw the entire page away on one null entry or one absent redirect_url,
    // which canonicalUrl turns into "Invalid URL".
    const { rows, unusable: unreadable, sent } = readableRows<AdzunaJob>(data.results);
    const postings: NormalizedPosting[] = [];
    let unusable = unreadable;
    for (const j of rows) {
      try {
        postings.push(
          build(
            {
              externalId: idField(j.id),
              canonicalUrl: canonicalUrl(j.redirect_url),
              applyUrl: j.redirect_url,
              company: textField(j.company?.display_name) || 'Unknown',
              title: textField(j.title),
              postedAt: textField(j.created) || null,
              locations: j.location?.display_name ? [adzunaLocation(j.location)] : [],
              compensation:
                typeof j.salary_min === 'number'
                  ? { min: j.salary_min, max: j.salary_max, currency: 'USD', period: 'year' }
                  : null,
            },
            textField(j.description),
          ),
        );
      } catch {
        unusable++;
      }
    }

    const gaps = [
      ...truncationGaps('adzuna', sent, perPage, data.count),
      ...unusableRowGap('adzuna', unusable),
    ];
    return { postings, notes: [], gaps };
  },
};

/**
 * Adzuna's `area` is a hierarchy written largest first — country, state, county, city — and
 * it is not always four deep. Reading it from the end put the county in the region field
 * for a full-depth listing, and for a state-wide one ("US", "California") it put the state
 * in the city field and the country in the region: the queue then offered a posting
 * "in California, US" as though California were a town. Anything shallower than three
 * levels names no city at all, so none is claimed.
 */
function adzunaLocation(loc: { display_name?: string; area?: string[] }): {
  city?: string;
  region?: string;
  country?: string;
  remote: boolean;
} {
  // Array.isArray rather than `?? []`: an `area` present but not an array kept its own
  // undefined `.length`, every comparison below read false, and the hierarchy silently
  // contributed nothing instead of saying so.
  const area = Array.isArray(loc.area) ? loc.area : [];
  return {
    city: area.length >= 3 ? textField(area.at(-1)) || undefined : undefined,
    region: area.length >= 2 ? textField(area[1]) || undefined : undefined,
    country: ADZUNA_COUNTRY.toUpperCase(),
    remote: /remote/i.test(textField(loc.display_name)),
  };
}

/**
 * What to say when a paginated source had more to give.
 *
 * Both keyed sources ask for one page and stop. That is a defensible limit — it keeps a
 * single run from hammering a free API — but it was invisible: the run summary said
 * "50 found" with no note and no degradation, which reads as everything the source had.
 * When the API tells us the true total we quote it; when it doesn't, a full page is itself
 * the signal that there is probably more behind it.
 *
 * `sent` is how many rows the response carried, not how many postings came out of them.
 * Both questions this asks are about the API's side of the exchange: whether it held rows
 * back, and whether it filled the page. Rows we could not read are our side and are reported
 * on their own, and counting them here would have announced a truncation that never happened.
 */
function truncationGaps(source: string, sent: number, perPage: number, total?: number): string[] {
  if (typeof total === 'number' && total > sent) {
    return [
      `${source}: showing the first ${sent} of ${total} matches — this run reads one ` +
        'page. Narrow the search with more specific keywords or a location to see the rest.',
    ];
  }
  if (typeof total !== 'number' && sent >= perPage) {
    return [
      `${source}: returned a full page of ${sent} results and did not say how many ` +
        'matched in total, so there are probably more. Narrow the search to see them.',
    ];
  }
  return [];
}

// ---------------------------------------------------------------- USAJOBS

interface UsaJob {
  MatchedObjectId: string;
  MatchedObjectDescriptor: {
    PositionTitle: string;
    PositionURI: string;
    ApplyURI?: string[];
    OrganizationName?: string;
    PositionLocation?: Array<{
      CityName?: string;
      CountrySubDivisionCode?: string;
      CountryCode?: string;
    }>;
    PublicationStartDate?: string;
    ApplicationCloseDate?: string;
    UserArea?: { Details?: { JobSummary?: string; MajorDuties?: string[] } };
  };
}

export const usajobs: JobSource = {
  kind: 'usajobs',
  requiresKey: true,
  isConfigured: () => Boolean(process.env.USAJOBS_API_KEY && process.env.USAJOBS_USER_AGENT),
  async fetch(q: SourceQuery): Promise<SourceResult> {
    if (!usajobs.isConfigured()) {
      return {
        postings: [],
        notes: [
          'usajobs: skipped — no API key. Register free at developer.usajobs.gov and set ' +
            'USAJOBS_API_KEY / USAJOBS_USER_AGENT in the .env file at the root of this ' +
            'project, then restart the server. This is the source for federal internships ' +
            'and Pathways.',
        ],
      };
    }

    const keyword = encodeURIComponent(q.keywords?.join(' ') ?? 'intern');
    const perPage = Math.min(q.limit ?? 50, 100);
    const url =
      `https://data.usajobs.gov/api/search?Keyword=${keyword}` +
      `&ResultsPerPage=${perPage}&HiringPath=student`;

    // HiringPath, not WhoMayApply. WhoMayApply takes All/Public/Status; "student" is
    // not one of them, so the filter was ignored and this source returned general
    // federal vacancies rather than the Pathways postings it promises. Untested against
    // the live API — it needs a key this machine does not have.

    const raw = await politeFetch(url, {
      isDocumentedApi: true,
      rps: 1,
      headers: {
        'Authorization-Key': process.env.USAJOBS_API_KEY!,
        'User-Agent': process.env.USAJOBS_USER_AGENT!,
        Host: 'data.usajobs.gov',
      },
    });
    const data = JSON.parse(raw) as {
      SearchResult?: { SearchResultItems?: UsaJob[]; SearchResultCountAll?: number };
    };

    const drift = wrongShape('usajobs', data.SearchResult?.SearchResultItems);
    if (drift) return drift;

    // Same row-at-a-time rule as the sibling adapters: one null item, or one descriptor
    // that is not an object, used to throw the whole federal search away.
    const {
      rows,
      unusable: unreadable,
      sent,
    } = readableRows<UsaJob>(data.SearchResult?.SearchResultItems);
    const postings: NormalizedPosting[] = [];
    let unusable = unreadable;
    for (const item of rows) {
      try {
        const d = item.MatchedObjectDescriptor;
        const duties = Array.isArray(d.UserArea?.Details?.MajorDuties)
          ? d.UserArea.Details.MajorDuties
          : [];
        const text = [textField(d.UserArea?.Details?.JobSummary), ...duties]
          .filter(Boolean)
          .join('\n');
        postings.push(
          build(
            {
              externalId: idField(item.MatchedObjectId),
              canonicalUrl: canonicalUrl(d.PositionURI),
              applyUrl: textField(d.ApplyURI?.[0]) || d.PositionURI,
              company: textField(d.OrganizationName) || 'US Federal Government',
              title: textField(d.PositionTitle),
              postedAt: textField(d.PublicationStartDate) || null,
              closesAt: textField(d.ApplicationCloseDate) || null,
              // The country comes from the posting, like everywhere else in the discovery
              // path. Every federal location used to be stamped 'US', and the federal
              // government hires into embassies, consulates and overseas bases — a duty
              // station in Ramstein or Yokosuka was stored as American and exported that
              // way. 'US' remains the fallback when the field is missing, because this is
              // the US federal government's own hiring system.
              locations: (Array.isArray(d.PositionLocation) ? d.PositionLocation : [])
                .filter((l): l is NonNullable<typeof l> => typeof l === 'object' && l !== null)
                .map((l) => ({
                  city: textField(l.CityName) || undefined,
                  region: textField(l.CountrySubDivisionCode) || undefined,
                  country: usaJobsCountry(textField(l.CountryCode)),
                  remote: false,
                })),
            },
            text,
          ),
        );
      } catch {
        unusable++;
      }
    }

    const total = data.SearchResult?.SearchResultCountAll;
    const gaps = [
      ...truncationGaps('usajobs', sent, perPage, total),
      ...unusableRowGap('usajobs', unusable),
    ];
    return { postings, notes: [], gaps };
  },
};

/** USAJOBS writes the country out in full ("United States"); the rest of the app uses codes. */
function usaJobsCountry(raw?: string): string {
  const value = (raw ?? '').trim();
  if (!value) return 'US';
  return /^(?:united states(?: of america)?|usa|u\.?s\.?a?\.?)$/i.test(value) ? 'US' : value;
}

// ---------------------------------------------------------------- Arbeitnow

interface ArbeitnowJob {
  slug?: string;
  company_name?: string;
  title?: string;
  description?: string;
  remote?: boolean;
  url?: string;
  /** Usually string[], but the live feed also carries rows where it is a keyed object. */
  job_types?: unknown;
  location?: string;
  /** Epoch seconds. */
  created_at?: number;
}

/**
 * How many pages of the Arbeitnow feed one run reads.
 *
 * The feed is every job on the board, newest first, 175 to a page, with no server-side
 * keyword filter — so reading it to the end would mean walking the whole board on every
 * run for a handful of internships. Three pages is the newest ~500 jobs; whatever lies
 * beyond the cap is reported as a gap below, never silently left unread.
 */
const ARBEITNOW_MAX_PAGES = 3;
const ARBEITNOW_API = 'https://www.arbeitnow.com/api/job-board-api';

/**
 * What counts as internship-shaped is decided in ONE place for the whole discovery path.
 *
 * This file used to carry its own definition and the repo held two answers to one question:
 * the ATS side read sixteen words across six languages while this side read three, so a
 * Werkstudent, a Stagiaire, a Praktikum's Spanish and Portuguese cousins and every co-op
 * were "not an internship" here and an internship one file over. Whichever source happened
 * to find the row decided whether the student ever saw it.
 *
 * `internshipShaped` lives in ./ats because that is where the detail-fetch budget it also
 * gates is spent. This file already imports parseLocation from there and ats.ts imports
 * nothing back, so there is no cycle.
 */

function arbeitnowIsInternship(j: ArbeitnowJob): boolean {
  // Anything that is not an array of strings contributes nothing to the check rather than
  // throwing the row (or the page) away: the live feed has rows whose job_types is an
  // object, and the title test below still gets its say.
  const types = Array.isArray(j.job_types) ? j.job_types : [];
  return (
    types.some((t) => typeof t === 'string' && internshipShaped(t)) ||
    internshipShaped(j.title ?? '')
  );
}

export const arbeitnow: JobSource = {
  kind: 'arbeitnow',
  requiresKey: false,
  isConfigured: () => true,
  // The feed takes no keyword or location parameters, so the query is unused: filtering
  // happens here, after the fetch, and the note below says what it dropped.
  async fetch(_q: SourceQuery): Promise<SourceResult> {
    const rows: unknown[] = [];
    const gaps: string[] = [];
    let url: string | null = ARBEITNOW_API;
    let pagesRead = 0;

    while (url && pagesRead < ARBEITNOW_MAX_PAGES) {
      // isDocumentedApi: false, so www.arbeitnow.com's own robots.txt decides rather than
      // this adapter deciding on its behalf. It reads "Disallow:" (an empty rule, meaning
      // allow all) plus /*?__hstc and /jobs/companies/*/apply, none of which touch the feed
      // path, so today the answer is yes and nothing changes. Checked live rather than
      // assumed, and now checked on every run: if that file ever changes, this degrades
      // into the gap below instead of quietly going on fetching.
      let data: { data?: unknown; links?: { next?: string | null } };
      try {
        data = await fetchJson(url, { rps: 2, isDocumentedApi: false });
      } catch (err) {
        const refusal = robotsRefusal('arbeitnow', err);
        if (refusal === null) throw err;
        // Page one refused is the whole source; a later page refused still leaves the pages
        // already read standing, so the loss is reported and the readable part kept.
        if (rows.length === 0) return { postings: [], notes: [], gaps: [refusal] };
        gaps.push(refusal);
        url = null;
        break;
      }
      const drift = wrongShape('arbeitnow', data.data);
      if (drift) {
        // Page one drifting is the whole source drifting. A later page drifting loses only
        // the tail, and wrongShape's "nothing from it is in these results" would be a false
        // statement about a run still holding the readable pages — so the partial coverage
        // is reported as its own gap instead.
        if (rows.length === 0) return drift;
        gaps.push(
          `arbeitnow: page ${pagesRead + 1} of the feed answered with an unexpected shape, ` +
            `so only the ${pagesRead === 1 ? 'first page is' : `first ${pagesRead} pages are`} ` +
            'in these results. The API may have changed.',
        );
        url = null;
        break;
      }
      rows.push(...(Array.isArray(data.data) ? data.data : []));
      pagesRead++;

      // links.next comes out of the response body, so only a link back into the same API is
      // followed — anything else would have this adapter fetching wherever the body points.
      const next = typeof data.links?.next === 'string' ? data.links.next : null;
      url = next !== null && next.startsWith(`${ARBEITNOW_API}?`) ? next : null;
      if (next !== null && url === null) {
        gaps.push(
          'arbeitnow: the feed pointed its next page outside its own API, so pagination ' +
            'stopped early. The API may have changed.',
        );
      }
    }

    /**
     * Remembered rather than reported here, because `notes` is declared further down. And a
     * note — not a gap — deliberately: the feed is every job on the board newest first, and
     * the page bound is this adapter's DESIGN. Reading deeper pages means reading staler
     * postings, which for a jobs feed is coverage of the past. Reported as a gap it put
     * "This search was not complete" on every ordinary run, and a warning that fires every
     * time teaches the user to stop reading warnings. Gaps here are reserved for reads that
     * FAILED — a page that would not parse, pagination that broke — as the pushes above are.
     */
    const moreBeyondTheBound = url !== null;

    // The internship filter runs over readable rows only. Running it over the raw array put
    // a `null` entry into arbeitnowIsInternship, which read `.job_types` off it and threw
    // the entire three-page walk away; and counting an unreadable row as "dropped, not an
    // internship" would state as fact something nobody could have known about it.
    const { rows: allRows, unusable: notARow } = readableRows<ArbeitnowJob>(rows);
    let unusable = notARow;

    // Separated before the filter, so a row nobody could read is never counted as a row that
    // is "not an internship". See `titleUnreadable`.
    const usable = allRows.filter((j) => !titleUnreadable(j.title));
    const badTitles = allRows.length - usable.length;
    if (badTitles > 0) {
      gaps.push(
        `arbeitnow: ${badTitles} rows arrived with a title that is not text, so nothing ` +
          'could be judged about them and they are missing from these results. The feed ' +
          'format may have changed.',
      );
    }

    const kept = usable.filter(arbeitnowIsInternship);
    // The filter count is the proof the source was consulted: a feed of everything at every
    // seniority keeps very few rows, and "3 found" with no context reads as a source that
    // was barely asked. Counted over `usable` so kept + dropped always adds up to the number
    // stated; anything unreadable is its own gap below rather than a silent adjustment here.
    const notes = [
      `arbeitnow: read ${usable.length} jobs, kept ${kept.length} internship-shaped, ` +
        `dropped ${usable.length - kept.length} that are not internships.`,
    ];
    if (moreBeyondTheBound) {
      notes.push(`arbeitnow: only the newest ${rows.length} jobs were read; older ones age out.`);
    }

    const postings: NormalizedPosting[] = [];
    let unreadable = 0;
    let drifted = 0;
    for (const j of kept) {
      try {
        const link = textField(j.url);
        const title = textField(j.title);
        if (!link.startsWith('http')) {
          unreadable++;
          continue;
        }
        // A row with no readable title is a blank line in the student's queue, not a
        // posting: it cannot be scored, searched or recognised. Counted as unreadable
        // rather than shipped as an empty shell.
        if (!title) {
          unusable++;
          continue;
        }
        // Arbeitnow returns the description HTML-escaped, exactly like Greenhouse: decoded
        // first, or stripHtml finds no tags to strip and its own decode step reintroduces
        // the markup as literal text.
        const description = driftedText(j.description);
        const html = description.text ? decodeEntities(description.text) : '';
        const text = stripHtml(html);
        const types = Array.isArray(j.job_types)
          ? j.job_types.filter((t): t is string => typeof t === 'string')
          : [];
        const place = driftedText(j.location);
        const location = place.text;
        if (description.drifted || place.drifted) drifted++;
        const p = build(
          {
            externalId: idField(j.slug),
            canonicalUrl: canonicalUrl(link),
            applyUrl: link,
            company: textField(j.company_name) || 'Unknown',
            title,
            descriptionHtml: html || null,
            postedAt:
              typeof j.created_at === 'number' && Number.isFinite(j.created_at)
                ? new Date(j.created_at * 1000).toISOString()
                : null,
            // The feed states remoteness structurally; the flag is passed as the hint the
            // way the Ashby adapter does, and parseLocation's own text reading is the
            // fallback when the flag is missing. No country is stamped: the board is
            // German-heavy but not German-only, and its location strings name the country
            // when they name one ("Munich, Bayern, Germany" sits beside plain "Berlin").
            locations: location
              ? [parseLocation(location, typeof j.remote === 'boolean' ? j.remote : undefined)]
              : j.remote === true
                ? [{ remote: true }]
                : [],
          },
          // job_types appended so the position-type and arrangement parsers can read labels
          // like "Working student", the same way the Lever adapter appends commitment.
          `${text}\n${types.join(', ')}`,
        );
        // The feed's own label fills the gap only where the title heuristic read nothing —
        // a row kept because job_types says "Intern" can still have a title that never
        // says so.
        if (!p.positionType && types.some((t) => internshipShaped(t))) {
          p.positionType = 'internship';
        }
        postings.push(p);
      } catch {
        // The net under the field-by-field reads above. Whatever shape the feed invents
        // next, it costs one row and is counted, not the whole board.
        unusable++;
      }
    }

    if (unreadable > 0) {
      gaps.push(
        `arbeitnow: skipped ${unreadable} internship-shaped ${unreadable === 1 ? 'row' : 'rows'} ` +
          'with no readable job URL. The feed format may have changed.',
      );
    }
    gaps.push(...unusableRowGap('arbeitnow', unusable));
    gaps.push(...driftedFieldGap('arbeitnow', drifted));

    return { postings, notes, gaps };
  },
};

// ---------------------------------------------------------------- Remotive

interface RemotiveJob {
  id?: number | string;
  url?: string;
  title?: string;
  company_name?: string;
  candidate_required_location?: string;
  /** 'internship', 'full_time', 'contract', ... */
  job_type?: string;
  publication_date?: string;
  /** Free text, e.g. "$120 - $170 /hour". */
  salary?: string;
  /** Raw HTML, unlike Arbeitnow's escaped HTML. */
  description?: string;
}

/**
 * Where a Remotive posting says the applicant may live, as a location entry.
 *
 * Every Remotive job is remote by definition — it is a remote-only board — so
 * `remote: true` is a fact of the source, not a reading. `candidate_required_location`
 * is free text and is usually a region list ("Americas, Europe, Israel") or "Worldwide",
 * neither of which is a city or a country: fed through the comma-splitting parser,
 * "Americas" would be stored as a city and exported as one. Only a string that parses to
 * a bare country name keeps geography; anything else keeps only the remoteness, and the
 * verbatim eligibility statement goes into remoteEligibleIn instead — the same field the
 * manual path fills from schema.org applicantLocationRequirements.
 */
function remotiveLocation(raw: unknown): { country?: string; remote: true } {
  // `raw` is unknown, not string, because the field is whatever the response carried: a
  // numeric value reached `raw.trim()` and threw "raw?.trim is not a function", losing the
  // board over one row's type.
  const stated = textField(raw);
  if (!stated.trim()) return { remote: true };
  const parsed = parseLocation(stated, true);
  return parsed.country !== undefined && parsed.city === undefined && parsed.region === undefined
    ? { country: parsed.country, remote: true }
    : { remote: true };
}

/**
 * The Remotive endpoint, with no `search=` on it.
 *
 * The adapter used to append `search=<keywords>` and a comment claimed the endpoint ran a
 * full-text search. It does not. Probed live on 2026-08-17, `search=intern`, `search=nurse`
 * and `search=python` each answered with the identical sixteen rows, top row "Senior
 * Independent AI Engineer / Architect [contract]" every time, and `limit=` was ignored too.
 * A parameter the server discards is not a search, and leaving it on the URL made the
 * request match a SECOND rule in remotive.com/robots.txt ("Disallow: /*search=") on top of
 * "Disallow: /api/*" for no coverage at all. Whatever the board sends is filtered here, by
 * `internshipShaped`, which is the only filter that has ever actually run on this source.
 */
const REMOTIVE_API = 'https://remotive.com/api/remote-jobs';

export const remotive: JobSource = {
  kind: 'remotive',
  requiresKey: false,
  isConfigured: () => true,
  // The query is unused: the endpoint ignores every parameter it is given (see above), so
  // filtering happens here, after the fetch, and the note below says what it dropped.
  async fetch(_q: SourceQuery): Promise<SourceResult> {
    // isDocumentedApi: false, so remotive.com's robots.txt decides whether this runs. It
    // says "Disallow: /api/*", which covers this URL, and it is the most explicit statement
    // of intent the host publishes. Fetching anyway would have made docs/04's politeness
    // section untrue, and the alternative of sending someone else's user-agent to get past
    // the rule is worse than not reading the source at all. So the source is not read, and
    // the student is told so in plain words instead of being shown a clean "0 found".
    let data: { 'job-count'?: unknown; 'total-job-count'?: unknown; jobs?: unknown };
    try {
      data = await fetchJson(REMOTIVE_API, { rps: 1, isDocumentedApi: false });
    } catch (err) {
      const refusal = robotsRefusal('remotive', err);
      if (refusal === null) throw err;
      return { postings: [], notes: [], gaps: [refusal] };
    }

    const drift = wrongShape('remotive', data.jobs);
    if (drift) return drift;

    // Readable rows first, for the same reason as Arbeitnow: a null entry in `jobs` reached
    // `j.job_type` in the filter below and threw the whole board away.
    const { rows: allJobs, unusable: notARow, sent } = readableRows<RemotiveJob>(data.jobs);
    let unusable = notARow;
    const gaps: string[] = [];

    // Separated before the filter, for the same reason as Arbeitnow: a title that is not
    // text cannot be judged internship-shaped, and counting it among the rows that "are not
    // internships" states something about a posting nobody could read.
    const jobs = allJobs.filter((j) => !titleUnreadable(j.title));
    const badTitles = allJobs.length - jobs.length;
    if (badTitles > 0) {
      gaps.push(
        `remotive: ${badTitles} rows arrived with a title that is not text, so nothing ` +
          'could be judged about them and they are missing from these results. The feed ' +
          'format may have changed.',
      );
    }

    const kept = jobs.filter(
      (j) => j.job_type === 'internship' || internshipShaped(textField(j.title)),
    );
    // "read", not "matched": nothing was matched server-side, so saying so would describe a
    // search that never ran.
    const notes = [
      `remotive: read ${jobs.length} jobs from the board, kept ${kept.length} ` +
        `internship-shaped, dropped ${jobs.length - kept.length} that are not internships.`,
    ];

    const postings: NormalizedPosting[] = [];
    let unreadable = 0;
    let drifted = 0;
    for (const j of kept) {
      try {
        const link = textField(j.url);
        const title = textField(j.title);
        if (!link.startsWith('http')) {
          unreadable++;
          continue;
        }
        // A row with no readable title is a blank line in the student's queue rather than a
        // posting, so it is counted as unreadable instead of shipped as an empty shell.
        if (!title) {
          unusable++;
          continue;
        }
        const description = driftedText(j.description);
        const html = description.text;
        const where = driftedText(j.candidate_required_location);
        const eligibility = where.text;
        if (description.drifted || where.drifted) drifted++;
        const p = build(
          {
            externalId: idField(j.id),
            // Remotive's API terms require anyone using the feed to link back to the
            // Remotive listing page, so their URL is deliberately BOTH the canonical and the
            // apply link. Pointing applyUrl at the employer's own page would break the
            // condition the data is published under; the Remotive page carries the real
            // apply button.
            canonicalUrl: canonicalUrl(link),
            applyUrl: link,
            company: textField(j.company_name) || 'Unknown',
            title,
            descriptionHtml: html || null,
            postedAt: textField(j.publication_date) || null,
            locations: [remotiveLocation(j.candidate_required_location)],
            // The source's own eligibility statement, verbatim and comma-split, exactly as
            // published. "Worldwide" and "Americas" are what it said, not a guess of ours.
            remoteEligibleIn: eligibility
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean),
          },
          // salary is free text; appended so parseCompensation gets to read it, the same
          // way the Lever adapter appends commitment. job_type rides along for the
          // position-type parser.
          `${stripHtml(html)}\n${textField(j.salary)}\n${textField(j.job_type)}`,
        );
        // A remote-only board states the arrangement by existing; only filled where the
        // text heuristic read nothing, in case a description says "hybrid" outright.
        if (!p.workArrangement) p.workArrangement = 'remote';
        // The API's own label fills the gap only where the title heuristic read nothing.
        if (!p.positionType && j.job_type === 'internship') p.positionType = 'internship';
        postings.push(p);
      } catch {
        // The net under the field-by-field reads above: one row, counted, never the board.
        unusable++;
      }
    }

    /**
     * The truncation check, over both counts the body carries rather than one.
     *
     * `job-count` is what the earlier version read on its own, and on every live probe it
     * was exactly the number of rows sent, so the check could not fire and the honesty it
     * describes was theoretical. `total-job-count` is the board's own total and is the
     * field that would say "there are more than this" if either ever did, so both are read
     * and the larger decides. It still may never fire against today's endpoint; that costs
     * nothing, and the day the response does report more than it sends, the run says so
     * rather than reading as complete coverage.
     */
    const declared = [data['job-count'], data['total-job-count']].filter(
      (n): n is number => typeof n === 'number' && Number.isFinite(n),
    );
    const total = declared.length > 0 ? Math.max(...declared) : null;
    if (total !== null && total > sent) {
      gaps.push(
        `remotive: the API said ${total} jobs are on the board but sent ${sent}, so the rest ` +
          'were not seen. This source answers in one response and ignores paging and search ' +
          'parameters, so there is no way from here to ask for the remainder.',
      );
    }
    if (unreadable > 0) {
      gaps.push(
        `remotive: skipped ${unreadable} internship-shaped ${unreadable === 1 ? 'row' : 'rows'} ` +
          'with no readable job URL. The feed format may have changed.',
      );
    }
    gaps.push(...unusableRowGap('remotive', unusable));
    gaps.push(...driftedFieldGap('remotive', drifted));

    return { postings, notes, gaps };
  },
};

// ---------------------------------------------------------------- community list

/**
 * Which cycle the default list covers, read from the default term filter so that one
 * place decides what "the upcoming season" is. The repo name used to be written out as
 * Summer 2026, so a run with no repo override fetched an archived list of a season that
 * had already closed while every filter in the app was set to Summer 2027.
 */
const DEFAULT_LIST_YEAR = DEFAULT_FILTERS.term.years[0] ?? new Date().getUTCFullYear() + 1;
const DEFAULT_LIST_REPO = `SimplifyJobs/Summer${DEFAULT_LIST_YEAR}-Internships`;

/**
 * SimplifyJobs maintains a well-structured, publicly published list of summer internship
 * postings specifically so tools can consume it. Read-only fetch of a raw JSON file.
 */
export const githubList: JobSource = {
  kind: 'github_list',
  requiresKey: false,
  isConfigured: () => true,
  async fetch(q: SourceQuery): Promise<SourceResult> {
    // `??` only catches null and undefined. The run route declares board as a string
    // with a default of '', so an omitted board arrives as an empty string and was
    // used verbatim — producing a raw.githubusercontent.com URL with nothing where the
    // repo goes. The sibling adapters all use a truthiness check for this reason.
    const repo = q.board || DEFAULT_LIST_REPO;
    const url = `https://raw.githubusercontent.com/${repo}/dev/.github/scripts/listings.json`;

    let data: Array<Record<string, unknown>>;
    try {
      data = await fetchJson<Array<Record<string, unknown>>>(url, { rps: 1 });
    } catch (err) {
      // A gap, not just a note. Losing this source loses more postings than every other
      // source in the app combined, and `notes` alone sets neither `degraded` nor `skipped`
      // (run.ts) — so a dead repo, a rename, or an outage at raw.githubusercontent.com was
      // reported to the user as "github_list: 0 found", indistinguishable from a list with
      // nothing on it. That is the unreported partial search this whole file's header calls
      // the failure that makes an automated search tool untrustworthy.
      const message =
        `github_list: could not read ${repo} (${(err as Error).message}). ` +
        'Nothing from this source is in these results.';
      return { postings: [], notes: [], gaps: [message] };
    }

    // The same silence one level down: an endpoint that answers with JSON of the wrong shape
    // is not an empty list. `.map`-style adapters throw here and the runner reports it; this
    // one iterates, so a `{}` or a `{"error": …}` body would produce zero postings, no error,
    // and a clean-looking report.
    if (!Array.isArray(data)) {
      return {
        postings: [],
        notes: [],
        gaps: [
          `github_list: ${repo} answered with something that is not a list of postings, so ` +
            'nothing from this source is in these results. The list format may have changed.',
        ],
      };
    }

    const postings: NormalizedPosting[] = [];
    const closed: string[] = [];
    let unreadable = 0;
    for (const row of data) {
      /**
       * The row-level guards the two feeds above got, which this source never did — and it
       * carries more postings than every other source combined.
       *
       * A `null` entry read `.active` off nothing and threw the whole list away. A row whose
       * `url` is a number went through `String(...)`, failed the http test, and vanished
       * without a word: `continue` on its own is a posting the run silently does not have,
       * and if the list changed the type of that field every row would leave the same way
       * while the run reported a clean, complete read of the community list.
       */
      if (!isRecord(row)) {
        unreadable++;
        continue;
      }
      const active = row['active'];
      const rawUrl = row['url'];
      const link = typeof rawUrl === 'string' ? rawUrl : '';
      if (!link.startsWith('http')) {
        unreadable++;
        continue;
      }

      /**
       * The whole row under ONE net, the way every other adapter in this file reads a row.
       *
       * The `active: false` branch below used to sit outside this try, and it calls
       * canonicalUrl, which is `new URL()` underneath. The `startsWith('http')` gate above is
       * far weaker than it looks: "https://" — a scheme with no host — passes it and throws
       * "Invalid URL", and so does "https://exa mple.com/apply". One such row threw straight
       * out of fetch() and took the entire community list with it, and on a fresh install
       * that list IS the search: a live run read 3,141 of its 3,225 postings from here. All
       * of them lost to one row that was closed anyway and would never have been shown to
       * anybody.
       *
       * Skipped and COUNTED, like the isRecord and non-http guards above it, because the two
       * branches lose different things and both are worth saying out loud: an active row we
       * cannot read is a posting missing from these results, and a closed row we cannot read
       * is the CLOSURE missing — a posting stored by an earlier run then stays open until the
       * staleness window expires it and the queue goes on offering an application that can no
       * longer be made, which is the exact failure the branch below exists to prevent.
       */
      try {
        /**
         * `active: false` is the list saying this role has closed, and it was thrown away.
         *
         * The row was skipped and nothing else happened, so a posting stored by an earlier run
         * stayed open — for forty-five days, until the staleness window expired it — and the
         * queue went on offering a student an application they could no longer make. This is
         * the best closure evidence in the whole pipeline: an explicit statement from the
         * source, costing no request, where `refreshPostings` can only ask a URL whether it
         * 404s and most closed postings answer 200 with "no longer accepting applications".
         */
        if (active === false) {
          closed.push(canonicalUrl(link));
          continue;
        }

        const title = String(row['title'] ?? '');
        const company = String(row['company_name'] ?? '');
        const locations = Array.isArray(row['locations']) ? (row['locations'] as string[]) : [];
        const terms = Array.isArray(row['terms']) ? (row['terms'] as string[]) : [];

        postings.push(
          build(
            {
              externalId: String(row['id'] ?? ''),
              canonicalUrl: canonicalUrl(link),
              applyUrl: link,
              company,
              title,
              postedAt: row['date_posted']
                ? new Date(Number(row['date_posted']) * 1000).toISOString()
                : null,
              // The same parser the ATS adapters use, rather than a second splitter that
              // filled the country in as "US" for every row. This list is not US-only —
              // it carries Toronto, London and Zurich postings among the rest — and being
              // the highest-volume source it put more wrongly-Americanised locations into
              // the database than everything else combined, all of them visible to the
              // user in the privacy export. A location that does not name its country now
              // leaves the field empty instead of asserting the wrong one.
              locations: locations.map((l) => parseLocation(l)),
            },
            `${title} at ${company}. ${terms.join(', ')}. ${locations.join('; ')}`,
          ),
        );
      } catch {
        // A malformed row is skipped rather than failing the whole source, but it is
        // counted. If the list changes date_posted from epoch seconds to an ISO string,
        // every dated row throws here — and reporting only the survivors made a run that
        // lost hundreds of listings read as complete coverage of a very short list. The
        // closed-row branch above is inside this net too now; there the loss was not partial
        // but total, because that call was the one this catch did not cover.
        unreadable++;
      }
    }

    const notes = [`github_list: ${postings.length} active listings from ${repo}`];
    const gaps =
      unreadable > 0
        ? [
            `github_list: skipped ${unreadable} ${unreadable === 1 ? 'row' : 'rows'} in ${repo} ` +
              'that could not be read. The list format may have changed.',
          ]
        : [];

    // The count above is a status line; the rows we lost are a hole in the search, and only
    // the second kind belongs in the run summary's list of what was missed.
    return { postings, notes, gaps, closed };
  },
};

export const AGGREGATOR_SOURCES = {
  adzuna,
  usajobs,
  arbeitnow,
  remotive,
  github_list: githubList,
} as const;
