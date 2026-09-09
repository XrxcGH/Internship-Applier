/**
 * The manual paste-a-URL path — docs/04 § Tier C.
 *
 * This is how a posting from LinkedIn, Indeed, or anywhere else this tool deliberately
 * does not crawl gets into the system: the user brings it. One user-directed fetch of a
 * page they are already looking at, not a crawler.
 *
 * Most career pages embed schema.org JobPosting JSON-LD, which gives us structured
 * fields for free. When it's absent we fall back to the page text and let the same
 * deterministic parsers do their work.
 */
import { politeFetch } from '../../infra/http/fetcher';
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
} from './normalize';
import { decodeEntities, stripHtml, type NormalizedPosting } from './sources/types';

interface JsonLdJobPosting {
  '@type'?: string | string[];
  title?: string;
  description?: string;
  datePosted?: string;
  validThrough?: string;
  employmentType?: string | string[];
  // Meant to be an Organization node, and plenty of career pages write the name directly as a
  // string instead — see `readOrganizationName`, which is why this is not typed as the object
  // alone any more.
  hiringOrganization?: string | { name?: string; sameAs?: string };
  jobLocation?: unknown;
  jobLocationType?: string;
  applicantLocationRequirements?: unknown;
  baseSalary?: {
    currency?: string;
    value?: { minValue?: number; maxValue?: number; unitText?: string };
  };
}

function collectJsonLd(html: string): JsonLdJobPosting[] {
  const out: JsonLdJobPosting[] = [];
  for (const m of html.matchAll(
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    try {
      const parsed: unknown = JSON.parse(m[1]!.trim());
      const queue = Array.isArray(parsed) ? parsed : [parsed];
      for (const node of queue) {
        const n = node as JsonLdJobPosting & { '@graph'?: unknown[] };
        if (Array.isArray(n['@graph'])) queue.push(...(n['@graph'] as never[]));
        const type = n['@type'];
        const types = Array.isArray(type) ? type : [type];
        if (types.includes('JobPosting')) out.push(n);
      }
    } catch {
      // A malformed block is skipped; another may still parse.
    }
  }
  return out;
}

function flattenLocations(
  loc: unknown,
): Array<{ city?: string; region?: string; country?: string; remote: boolean }> {
  const nodes = Array.isArray(loc) ? loc : [loc];
  const out: Array<{ city?: string; region?: string; country?: string; remote: boolean }> = [];
  for (const n of nodes) {
    const addr = (n as { address?: Record<string, unknown> })?.address;
    if (!addr) continue;
    out.push({
      city: typeof addr['addressLocality'] === 'string' ? addr['addressLocality'] : undefined,
      region: typeof addr['addressRegion'] === 'string' ? addr['addressRegion'] : undefined,
      country: readCountry(addr['addressCountry']),
      remote: false,
    });
  }
  return out;
}

/**
 * schema.org allows addressCountry to be a plain string or a Country object, and plenty
 * of career pages use the object. Reading only the string form and defaulting everything
 * else to "US" stored a Toronto posting with the right city, the right region, and the
 * country "US" — which is then what the database keeps and the privacy export shows.
 * This is the path the user points at any URL on earth, so an absent country stays absent.
 */
function readCountry(value: unknown): string | undefined {
  const raw = typeof value === 'string' ? value : (value as { name?: unknown } | null)?.name;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
}

/**
 * The employer's name out of schema.org `hiringOrganization`, or nothing.
 *
 * Two silences used to be read as names. `hiringOrganization` is meant to be an Organization
 * node and plenty of career pages write the name directly as a string, which `?.name` read as
 * absent — so a page that DID name its employer fell through to the address, which on a board
 * names the vendor. And `??` only falls through on null and undefined, so a node with an empty
 * or whitespace `name` was stored as the posting's company: an application addressed to nobody,
 * with `namedByJsonLd.company` saying beside it that the page had named someone.
 */
function readOrganizationName(value: unknown): string | null {
  const raw = typeof value === 'string' ? value : (value as { name?: unknown } | null)?.name;
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null;
}

/** The employer's own site, when `hiringOrganization` is a node rather than a bare name. */
function readOrganizationSite(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const site = (value as { sameAs?: unknown }).sameAs;
  return typeof site === 'string' && site.trim() !== '' ? site : null;
}

/**
 * The places a remote posting says you may live, from schema.org
 * `applicantLocationRequirements` — a Country or State node, or a list of them.
 *
 * The field was read off the page and then thrown away: `remoteEligibleIn` was written as
 * an empty list on every manual posting, so a page that said in structured data "remote,
 * but you must be resident in the United States" was stored as knowing nothing about where
 * it would take people, and that is what the privacy export showed back.
 */
function readApplicantLocations(value: unknown): string[] {
  const nodes = Array.isArray(value) ? value : [value];
  const out: string[] = [];
  for (const node of nodes) {
    const name = typeof node === 'string' ? node : (node as { name?: unknown } | null)?.name;
    if (typeof name === 'string' && name.trim()) out.push(name.trim());
  }
  return out;
}

export interface ManualResult {
  posting: NormalizedPosting;
  usedJsonLd: boolean;
  /**
   * Which of the two naming fields the structured data actually supplied.
   *
   * `usedJsonLd` is `Boolean(ld)` and a node is admitted on its @type alone, while the title
   * and the company are filled per field with their own fallbacks. So a JobPosting node that
   * carries a description and no `hiringOrganization` reports `usedJsonLd: true` while its
   * company is `guessCompany(url)` — literally "job-boards" for a Greenhouse address. A
   * caller repairing names on the strength of the page-level flag skipped that field because
   * some OTHER field was structured.
   */
  namedByJsonLd: { title: boolean; company: boolean };
  notes: string[];
}

/**
 * Titles that belong to a LISTING, not to a job.
 *
 * `guessTitle` falls back to the page's own `<title>`, which on a search-results page is the
 * site's furniture. A real run stored a posting called "Jobs search — Google Careers", company
 * "Google", and it came back as one of fifteen eligible matches — a row naming a role that does
 * not exist, in a queue the student is meant to work through.
 *
 * Only consulted when the page carried no structured JobPosting data, because a page that
 * states it IS a posting whatever its `<title>` says. The phrases are ones no role is called:
 * a "Search Engineer" posting is untouched, "job search" as a unit is never a job.
 */
const LISTING_TITLE = /\b(?:jobs?\s+search|search\s+jobs?|search\s+results?|job\s+search)\b/i;

export async function fetchManualPosting(url: string): Promise<ManualResult> {
  const notes: string[] = [];
  // A user-directed fetch of a single page. robots.txt still applies.
  const html = await politeFetch(url, { rps: 1, timeoutMs: 20_000 });

  const ld = collectJsonLd(html)[0];
  const pageText = stripHtml(html);

  const ldTitle = typeof ld?.title === 'string' ? ld.title.trim() : '';
  const titleFromLd = ldTitle !== '';
  const ldCompany = readOrganizationName(ld?.hiringOrganization);
  const companyFromLd = ldCompany !== null;
  const title = titleFromLd ? ldTitle : (guessTitle(html) ?? 'Untitled posting');

  /**
   * A page that does not name one job is not a posting, and storing it as one is a lie the
   * user then has to spot. Refused rather than kept: `webSearch` counts a refusal against the
   * candidate, and a hand-pasted URL gets a sentence saying what to paste instead.
   */
  if (!titleFromLd && LISTING_TITLE.test(title)) {
    throw new Error(
      `That page does not name a single job — its title is "${title.slice(0, 60)}". If it is a ` +
        'search or results page, open the posting itself and use that address.',
    );
  }
  const company = ldCompany ?? guessCompany(url);
  const description = ld?.description ? stripHtml(ld.description) : pageText;

  if (!ld) {
    notes.push(
      'No structured JobPosting data on the page, so the title, company, and dates were ' +
        'read from the page text and may need correcting.',
    );
  } else if (!companyFromLd) {
    // The page states it is a posting and still does not say whose, so the company below came
    // out of the address. Said out loud rather than shown as though the page had supplied it.
    notes.push(
      "The page's structured data does not name the employer, so the company was read from " +
        'the address and may need correcting.',
    );
  }
  if (description.length < 200) {
    notes.push('Very little text was readable at that URL — the page may require JavaScript.');
  }

  const hay = `${title}\n${description}`;
  const dates = parseTermDates(hay);
  const duration = parseDurationWeeks(hay);

  /**
   * Remoteness, from the structured signal first and the text through the shared parser.
   *
   * This used to be a bare /\bremote\b/ over the title and the first 500 characters,
   * which fired on "no remote work" and "this role is not remote" as readily as on the
   * real thing — and then threw away the structured jobLocation and the parsed
   * arrangement to replace both with "remote". The manual path is the one the user
   * invoked deliberately; it has no business being less careful than the automated one.
   */
  const arrangement = parseWorkArrangement(hay);
  const remote = ld?.jobLocationType === 'TELECOMMUTE' || arrangement === 'remote';
  // A posting can be remote AND name a city ("New York or Remote"). Keeping the stated
  // locations is what lets the eligibility rule tell those two cases apart.
  const stated = flattenLocations(ld?.jobLocation);
  const locations = remote
    ? stated.length > 0
      ? stated.map((l) => ({ ...l, remote: true }))
      : [{ remote: true }]
    : stated;

  const salary = ld?.baseSalary?.value;

  const posting: NormalizedPosting = {
    externalId: null,
    canonicalUrl: canonicalUrl(url),
    applyUrl: url,
    company,
    companyDomain: safeHost(readOrganizationSite(ld?.hiringOrganization) ?? url),
    title,
    descriptionText: description,
    descriptionHtml: ld?.description ?? null,
    locations,
    positionType: parsePositionType(title, description),
    workArrangement: remote ? 'remote' : arrangement,
    hybridDaysOnsite: parseHybridDays(hay),
    remoteEligibleIn: readApplicantLocations(ld?.applicantLocationRequirements),
    programFlags: [],
    term: {
      season: parseSeason(hay),
      year: parseYear(hay),
      ...(dates ?? {}),
      durationWeeks: duration,
      multiTerm: duration !== null && duration > 20,
    },
    compensation: salary?.minValue
      ? {
          min: salary.minValue,
          max: salary.maxValue,
          currency: ld?.baseSalary?.currency ?? 'USD',
          period: mapUnit(salary.unitText),
        }
      : (parseCompensation(hay) as Record<string, unknown> | null),
    requires: parseRequirements(description),
    postedAt: ld?.datePosted ?? null,
    closesAt: ld?.validThrough ?? null,
    atsVendor: detectVendor(url, html),
  };

  return {
    posting,
    usedJsonLd: Boolean(ld),
    namedByJsonLd: { title: titleFromLd, company: companyFromLd },
    notes,
  };
}

function mapUnit(unit?: string): 'hour' | 'week' | 'month' | 'year' {
  switch ((unit ?? '').toUpperCase()) {
    case 'HOUR':
      return 'hour';
    case 'WEEK':
      return 'week';
    case 'MONTH':
      return 'month';
    default:
      return 'year';
  }
}

function guessTitle(html: string): string | null {
  const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  // Trimmed AFTER decoding and turned back into "nothing" if that is what it is: a page whose
  // title is a lone `&nbsp;` named the job as surely as an empty one did, which is to say not
  // at all, and an empty string is a worse posting name than "Untitled posting" is.
  if (og?.[1]) return decodeEntities(og[1]).trim() || null;
  const t = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return t?.[1] ? decodeEntities(t[1]).trim() || null : null;
}

/**
 * THE EMPLOYER, OUT OF THE ADDRESS, when the page did not name one itself.
 *
 * On a multi-tenant board the hostname belongs to the VENDOR: `job-boards.greenhouse.io` gave
 * "job-boards", and `boards.greenhouse.io` gave "greenhouse", because the prefix strip below
 * eats "boards." and leaves the vendor's own name standing where the employer's should be. A
 * student pasting a Greenhouse or Lever link therefore got a posting whose company was the
 * applicant-tracking system — and at G3 the most ordinary sentence a "why this company" answer
 * contains, the employer's own name, is then a name the application has never heard of, and it
 * is refused there with NO override. It also broke cross-source dedupe, since the same posting
 * reached us from the Greenhouse adapter under the employer's slug.
 */
export function guessCompany(url: string): string {
  return boardTenant(url) ?? hostFragment(url);
}

/**
 * The boards that host many employers on one hostname, with the employer first in the path.
 *
 * Every multi-tenant vendor `detectVendor` knows by hostname is here, because each one had the
 * reported bug and not just Greenhouse: `job-boards.greenhouse.io/acme-robotics/jobs/4512`,
 * `jobs.lever.co/acme/<id>`, `jobs.ashbyhq.com/acme/<id>`, `jobs.smartrecruiters.com/Acme/<id>`,
 * `apply.workable.com/acme/j/<id>`. The regional hosts (`job-boards.eu.greenhouse.io`,
 * `jobs.eu.lever.co`) are the same shape, which is why this matches on the registrable domain
 * rather than the whole host.
 *
 * Workday, Taleo and iCIMS are deliberately absent: their tenant is the SUBDOMAIN, which the
 * hostname reading already gets right.
 */
const TENANT_IN_PATH =
  /(?:^|\.)(?:greenhouse\.io|lever\.co|ashbyhq\.com|smartrecruiters\.com|workable\.com)$/;

/**
 * First path segments that are the board's own furniture rather than an employer.
 *
 * `apply.workable.com/j/AB12CD` is a short link with no employer in it at all, and storing "j"
 * as the company would be a worse lie than the vendor's name. When nothing in the address names
 * an employer this falls back to the hostname fragment ON PURPOSE: webSearch's `isHostFragment`
 * repair keys on the stored company being part of the hostname, so answering "unknown" here
 * would quietly switch that repair off for exactly the pages that need it most.
 */
const NOT_A_TENANT =
  /^(?:jobs?|careers?|apply|application|embed|search|postings?|openings?|[a-z]|\d+|[0-9a-f]{8}-[0-9a-f-]+)$/i;

function boardTenant(url: string): string | null {
  if (!URL.canParse(url)) return null;
  const parsed = new URL(url);
  if (!TENANT_IN_PATH.test(parsed.hostname.toLowerCase())) return null;

  const first = parsed.pathname.split('/').find((segment) => segment !== '');
  // Greenhouse's embedded application form names the board in a query parameter instead of the
  // path: `boards.greenhouse.io/embed/job_app?for=acme&token=4512`.
  const slug =
    first !== undefined && !NOT_A_TENANT.test(first)
      ? first
      : (parsed.searchParams.get('for') ?? '');
  return slug.trim() === '' ? null : slug.trim();
}

/**
 * The employer's own careers host, read as the employer — `careers.acme.com` is Acme's, and so
 * is a Workday tenant at `acme.wd5.myworkdayjobs.com`.
 */
function hostFragment(url: string): string {
  const host = safeHost(url) ?? 'unknown';
  return host.replace(/^(www|jobs|careers|boards|apply)\./, '').split('.')[0] ?? 'unknown';
}

function safeHost(u: string): string | null {
  try {
    return new URL(u).host.toLowerCase();
  } catch {
    return null;
  }
}

export function detectVendor(url: string, html = ''): string {
  const h = `${url} ${html.slice(0, 4000)}`.toLowerCase();
  if (h.includes('greenhouse.io')) return 'greenhouse';
  if (h.includes('lever.co')) return 'lever';
  if (h.includes('ashbyhq.com')) return 'ashby';
  if (h.includes('myworkdayjobs.com') || h.includes('workday')) return 'workday';
  if (h.includes('smartrecruiters.com')) return 'smartrecruiters';
  if (h.includes('icims.com')) return 'icims';
  if (h.includes('taleo.net')) return 'taleo';
  if (h.includes('workable.com')) return 'workable';
  return 'unknown';
}

/**
 * A posting the user read on a site this tool will not fetch, pasted in as text.
 *
 * THE HANDSHAKE PATH, and the honest answer to "make Handshake, LinkedIn and Indeed part of
 * this program". Those three prohibit automated access in their terms, and Handshake sits
 * behind a university login besides — so this tool does not fetch them, and a stored
 * credential replaying a login would be exactly the automated access the terms forbid, with
 * the student's own account carrying the ban if it were noticed. Handshake bans are worse
 * than most: the account is the university's careers office, not a website signup.
 *
 * None of which stops the STUDENT from reading the posting. They are signed in as themselves,
 * doing what the account is for. So the tool takes the text from them instead of taking it
 * from the site: every parser below is the same one `fetchManualPosting` runs, because the
 * pipeline downstream of here only ever worked on a title and a body of text. What the
 * student pastes is what the employer wrote, which is the same standard the rest of this file
 * holds to — the difference is only who did the fetching, and a human reading their own
 * Handshake account is not a robot.
 *
 * The URL is required and is never fetched. A Handshake or LinkedIn job address exists and is
 * copyable out of the address bar even though the page behind it refuses us — so it is stored
 * as the posting's identity (dedupe keys on it) and as the student's way back to it at G4.
 * Storing an address is not visiting one. Nothing here guesses a URL: a fabricated apply link
 * is a dead end discovered at the last gate, which is the worst possible moment for it.
 */
export interface PastedPosting {
  text: string;
  /** What the site called it. Required, because a title cannot be read out of a bare body. */
  title: string;
  company: string;
  /**
   * The address the student copied. Stored and shown, NEVER fetched — that is the whole point
   * of this path. Also the dedupe key, so it cannot be omitted.
   */
  url: string;
  /** Where the student read it, for the note that says so. */
  readOn?: string;
}

export function readPastedPosting(input: PastedPosting): ManualResult {
  const notes: string[] = [];
  const description = input.text.trim();
  const title = input.title.trim();
  const company = input.company.trim();

  if (description.length < 200) {
    notes.push(
      'That is very little text for a posting. Requirements are read out of the body, so a ' +
        'partial paste means a partial answer at the eligibility step.',
    );
  }
  notes.push(
    input.readOn
      ? `Read from ${input.readOn} and pasted in by you, so every fact below is the text you ` +
          'pasted — nothing was fetched. Correct anything that came through wrong.'
      : 'Pasted in by you rather than fetched, so every fact below comes from that text.',
  );

  const hay = `${title}\n${description}`;
  const dates = parseTermDates(hay);
  const duration = parseDurationWeeks(hay);
  const arrangement = parseWorkArrangement(hay);

  const posting: NormalizedPosting = {
    externalId: null,
    canonicalUrl: canonicalUrl(input.url),
    applyUrl: input.url,
    company,
    companyDomain: safeHost(input.url),
    title,
    descriptionText: description,
    descriptionHtml: null,
    locations: arrangement === 'remote' ? [{ remote: true }] : [],
    positionType: parsePositionType(title, description),
    workArrangement: arrangement,
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
    requires: parseRequirements(description),
    postedAt: null,
    closesAt: null,
    atsVendor: 'unknown',
  };

  // Pasted text has no structured data by definition, and the student supplied both names.
  return { posting, usedJsonLd: false, namedByJsonLd: { title: true, company: true }, notes };
}
