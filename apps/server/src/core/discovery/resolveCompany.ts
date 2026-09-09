/**
 * Company → ATS board resolution — docs/04 § Company target list.
 *
 * Probes the public board endpoints for a slug and returns whichever PROVED it has a board
 * there — see the ProbeAnswer comment, because a 200 is not that proof at every vendor.
 * Nothing here writes to the database; the caller does. `routes/discovery.ts` turns each
 * resolution into a `source` row, which is how a resolved board reaches the query planner,
 * and that row used to appear only once a discovery run had pulled postings off the board.
 * Caching the mapping so a second resolve is a single request is not built, so resolving
 * the same company twice re-probes every vendor.
 *
 * The whole resolve is bounded: five GET probes plus at most six Workday POSTs per slug
 * candidate, and `slugCandidates` yields at most three candidates, so one resolve tops out
 * at 33 requests. The bound is stated because the Workday probe below could grow without
 * one, and an unbounded probe is a crawl wearing a resolver's name.
 */
import type { SourceKind } from '@ia/shared';
import { fetchJson, HttpError } from '../../infra/http/fetcher';
import { robotsRefusal } from './sources/types';
import { logger } from '../../infra/logger';

/**
 * The vendors a company can resolve to. Written against the shared SourceKind rather than
 * the ATS registry's key type, because a resolution names a vendor whether or not this
 * process has that vendor's adapter loaded — and because the registry and this file are
 * routinely extended in separate changes.
 */
export type ResolvedVendor = Extract<
  SourceKind,
  'greenhouse' | 'lever' | 'ashby' | 'smartrecruiters' | 'workable' | 'workday'
>;

export interface Resolution {
  source: ResolvedVendor;
  board: string;
  jobCount: number;
  /**
   * Whether the slug that found this board is the company's whole name, or only its first
   * word.
   *
   * `slugCandidates` tries the first word last, because plenty of companies really are
   * addressed that way. But a first word is also somebody else's whole name: "Vector Health"
   * yields "vector", and ashby:vector is a real board with real openings belonging to a
   * different company. Ten of ten realistic two-word names hit a live board under their
   * first word when this was measured.
   *
   * So the answer is worth SHOWING — it may well be the right board, and the user can tell at
   * a glance — and it is not worth WRITING DOWN as a fact the app then acts on by itself.
   * Callers that persist a resolution must persist only the ones found under the full name.
   * A one-word company name is not a truncation, and is never marked as one.
   */
  fromFullName: boolean;
}

export interface ResolveResult {
  matches: Resolution[];
  /**
   * Coverage this resolve could not get, in plain sentences. `matches` on its own cannot
   * say it: an empty list reads as "this company has no board at any of these vendors",
   * and for SmartRecruiters that is a claim these probes are not able to make.
   */
  notes: string[];
}

/**
 * What one vendor's answer proved.
 *
 * A 200 is not by itself evidence that a board is there, and treating it as one is how a
 * phantom board reached the user. Probed live against all five GET endpoints with names
 * that are not companies ("zzqqwwxxnotacompany", "qqq-www-eee-not-real", "acmewidget"):
 *
 *   greenhouse       404 {"status":404,"error":"Job not found"}
 *   lever            404 {"ok":false,"error":"Document not found"}
 *   ashby            404 Not Found
 *   workable         404 Not Found
 *   smartrecruiters  200 {"offset":0,"limit":1,"totalFound":0,"content":[]}
 *
 * So four vendors say no by saying 404, and a 200 from them carries the board's own shape
 * (an array of jobs) whether or not anything is posted — `{"name":"Stripe","jobs":[]}` from
 * Workable is a real account with nothing open, and that is worth returning. SmartRecruiters
 * is the one vendor that answers 200 for every id there is, and it gives nothing to tell a
 * company with no board apart from a board with nothing posted: `Ubisoft` and `McDonalds`,
 * both real SmartRecruiters companies, answer `totalFound: 0` exactly as the invented names
 * above do, and there is no company-level endpoint to ask instead (`/v1/companies/{id}`
 * is 404 for real and invented ids alike). Only `totalFound > 0` is evidence there.
 *
 * That costs a real SmartRecruiters board with nothing posted today, which the file's other
 * rule — a board with zero jobs is still returned, because it answers which vendor the
 * company uses — would otherwise keep. It is the right way to lose: the alternative returned
 * a SmartRecruiters board for EVERY name typed into Discover, including names of companies
 * that do not exist, and an invented board is a fact the student cannot check. The loss is
 * said out loud in `notes` rather than swallowed.
 */
type ProbeAnswer =
  /** This vendor has a board for this slug. `jobCount` is what it says is posted today. */
  | { kind: 'board'; jobCount: number }
  /**
   * The answer proved nothing. `note` is the sentence the caller must be told, for the case
   * where the vendor genuinely cannot be checked and an empty result would otherwise read as
   * "no board there"; `null` means the body was not this vendor's board shape at all, which
   * is API drift and gets logged like any other "never actually checked" answer.
   */
  | { kind: 'unproven'; note: string | null };

/**
 * Greenhouse, Ashby and Workable all prove a board the same way: the body carries a `jobs`
 * array, empty or not. A body without one is not a board answer, however healthy its status
 * code — the previous `jobs?.length ?? 0` read a 200 carrying `{"errors":[...]}` as a board
 * with zero jobs and reported the vendor as this company's ATS.
 */
function fromJobsArray(data: unknown): ProbeAnswer {
  const jobs = (data as { jobs?: unknown } | null)?.jobs;
  return Array.isArray(jobs)
    ? { kind: 'board', jobCount: jobs.length }
    : { kind: 'unproven', note: null };
}

const PROBES: Array<{
  source: ResolvedVendor;
  url: (slug: string) => string;
  read: (data: unknown) => ProbeAnswer;
  /**
   * Ask this host's robots.txt before probing it.
   *
   * Only SmartRecruiters, because it is the only one of these that says no:
   * `api.smartrecruiters.com` answers `User-agent: * / Disallow: /`, its single
   * `Allow: /v1/companies/` being scoped to LinkedInBot. The other four were asked under the
   * agent string this tool sends and permit the paths used — `boards-api.greenhouse.io`
   * disallows only `/embed/`, `api.lever.co` answers `Allow: /`, `apply.workable.com` an
   * empty `Disallow:`, and `api.ashbyhq.com` 401s, which RFC 9309 and this repo both read as
   * allow-all. Their flag is left alone rather than flipped on the strength of one reading:
   * turning politeness on for a host that permits changes nothing today and quietly makes
   * four more sources fail closed if one of those files ever changes shape.
   */
  asksRobots?: boolean;
}> = [
  {
    source: 'greenhouse',
    url: (s) => `https://boards-api.greenhouse.io/v1/boards/${s}/jobs`,
    read: fromJobsArray,
  },
  {
    source: 'lever',
    // No limit. The count is what the resolution sort ranks boards by, and limit=1
    // capped every Lever board at a jobCount of 1 — so an almost-empty Greenhouse board
    // outranked a Lever board with two hundred openings, and the number shown to the
    // caller was wrong for every Lever result.
    url: (s) => `https://api.lever.co/v0/postings/${s}?mode=json`,
    // The board IS the array, so an array proves it and anything else does not.
    read: (d) =>
      Array.isArray(d) ? { kind: 'board', jobCount: d.length } : { kind: 'unproven', note: null },
  },
  {
    source: 'ashby',
    url: (s) => `https://api.ashbyhq.com/posting-api/job-board/${s}`,
    read: fromJobsArray,
  },
  {
    source: 'smartrecruiters',
    // limit=1, because the count comes from `totalFound`, not from the rows: the endpoint
    // pages at 100, so counting `content` would rank a 400-opening company as if it had
    // 100 — the same wrong-number-shown-to-the-caller mistake the Lever comment above
    // records — while the true total rides along on a one-row page.
    url: (s) => `https://api.smartrecruiters.com/v1/companies/${s}/postings?limit=1`,
    asksRobots: true,
    read: (d) => {
      const total = (d as { totalFound?: unknown } | null)?.totalFound;
      if (typeof total !== 'number') return { kind: 'unproven', note: null };
      if (total > 0) return { kind: 'board', jobCount: total };
      return {
        kind: 'unproven',
        // The fact, without the advice. What the reader should DO about it depends on
        // whether anything else answered, so the caller adds that half — see `notes` below.
        note:
          'SmartRecruiters answers a name it has no company for exactly as it answers a ' +
          'company with nothing posted today, so no SmartRecruiters board is listed above ' +
          'for this name.',
      };
    },
  },
  {
    source: 'workable',
    url: (s) => `https://apply.workable.com/api/v1/widget/accounts/${s}`,
    read: fromJobsArray,
  },
];

/**
 * The two Workday hosts worth probing blind. Workday spreads tenants across many wdN data
 * centers, but wd1 and wd5 hold the bulk of them, and each extra host multiplies the
 * request count of every resolve that ends in "not Workday" — which is most of them.
 */
const WORKDAY_HOSTS = ['wd1', 'wd5'] as const;

/** Site-name candidates: the tenant's own name and the two names Workday's setup suggests. */
function workdaySiteCandidates(slug: string): string[] {
  return [...new Set([slug, 'External', 'careers'])];
}

/**
 * A fetch that died because the host name does not resolve.
 *
 * For a speculative `{slug}.wd1.myworkdayjobs.com` probe this is the ordinary "no such
 * tenant" answer, exactly as a 404 is for the GET probes above — undici wraps the
 * getaddrinfo failure in a TypeError whose cause carries ENOTFOUND. Only that code counts:
 * EAI_AGAIN is the resolver having trouble, which means the vendor was never actually
 * checked, and that still deserves the warning the generic path logs.
 */
function isAbsentHost(err: unknown): boolean {
  const cause = (err as { cause?: unknown } | null)?.cause;
  return (cause as { code?: unknown } | null)?.code === 'ENOTFOUND';
}

/**
 * Probes for a Workday board, deliberately bounded.
 *
 * A Workday board is addressed by (tenant, host, site), the site name is chosen freely by
 * the company, and Workday runs many wdN hosts — so the honest search space is infinite
 * and this is a resolver, not a crawler. The deliberate set: two hosts × at most three
 * site candidates = at most six POSTs per slug, each asking the cxs jobs endpoint for a
 * single posting. That endpoint is the same query every visitor's browser sends to render
 * the company's own careers page; a hit answers with the board's true `total`.
 *
 * Two answers mean "not this board" and pass silently: a 404 or 422 from the cxs service
 * (tenant exists, site or tenant name wrong — the wd1/wd5 wildcard DNS answers for names
 * that have no tenant behind them), and a host that fails DNS outright. A host that fails
 * DNS is also skipped for its remaining site candidates, because no site can live on a
 * host that is not there, and each dead-host fetch costs the fetcher's full retry budget.
 */
async function probeWorkday(slug: string, fromFullName: boolean): Promise<Resolution | null> {
  for (const host of WORKDAY_HOSTS) {
    for (const site of workdaySiteCandidates(slug)) {
      const url = `https://${slug}.${host}.myworkdayjobs.com/wday/cxs/${slug}/${site}/jobs`;
      try {
        const data = await fetchJson<{ total?: unknown }>(url, {
          rps: 2,
          timeoutMs: 8000,
          jsonBody: { appliedFacets: {}, limit: 1, offset: 0, searchText: '' },
        });
        if (typeof data.total === 'number') {
          // The board address the workday adapter takes: "tenant@host/site".
          return {
            source: 'workday',
            board: `${slug}@${host}/${site}`,
            jobCount: data.total,
            fromFullName,
          };
        }
        // Answered 200 without a total: whatever this is, it is not the jobs endpoint,
        // and a speculative probe that found something else found nothing. Unlike the same
        // shape from a GET probe above, this one is not logged: those five URLs are the
        // vendor's own documented API, where an unexpected body means the API moved under
        // us, while `{slug}.wd1.myworkdayjobs.com` is a host this file GUESSED at, and
        // something else answering there is the ordinary way a guess turns out wrong.
      } catch (err) {
        if (isAbsentHost(err)) break;
        if (err instanceof HttpError && (err.status === 404 || err.status === 422)) continue;
        logger.warn({ err, source: 'workday', slug, host, site }, 'company board probe failed');
      }
    }
  }
  return null;
}

/** Slug candidates, most likely first. */
export function slugCandidates(name: string): string[] {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/\b(inc|llc|ltd|corp|corporation|co)\b\.?/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

  return [
    ...new Set([base.replace(/\s+/g, ''), base.replace(/\s+/g, '-'), base.split(' ')[0] ?? base]),
  ].filter(Boolean);
}

export async function resolveCompany(name: string): Promise<ResolveResult> {
  const found: Resolution[] = [];
  /** Vendor → the sentence to print if no board of that vendor was found anywhere. */
  const unproven = new Map<ResolvedVendor, string>();

  // The first word on its own, when the name has more than one word — the candidate whose
  // answers are guesses rather than resolutions. See `Resolution.fromFullName`.
  const candidates = slugCandidates(name);
  const firstWordOnly = candidates.length > 1 ? (candidates[candidates.length - 1] ?? null) : null;

  for (const slug of candidates) {
    for (const probe of PROBES) {
      try {
        const data = await fetchJson<unknown>(probe.url(slug), {
          rps: 2,
          timeoutMs: 8000,
          isDocumentedApi: probe.asksRobots !== true,
        });
        const answer = probe.read(data);
        if (answer.kind === 'board') {
          // A board that answered but has nothing posted today still answers the question
          // the caller asked — which vendor this company uses — so it is returned with a
          // count of zero rather than dropped. The sort at the end puts it last. This is
          // sound only for the four vendors that 404 a name they have no company for; see
          // the ProbeAnswer comment for why SmartRecruiters cannot join them.
          found.push({
            source: probe.source,
            board: slug,
            jobCount: answer.jobCount,
            fromFullName: slug !== firstWordOnly,
          });
        } else if (answer.note !== null) {
          unproven.set(probe.source, answer.note);
        } else {
          // A 200 that is not this vendor's board shape means the endpoint changed under
          // us. Same class as a 503 below: the vendor was not actually checked, and an
          // empty answer would read as "this company has no board there".
          logger.warn(
            { source: probe.source, slug },
            'company board probe answered 200 with something that is not a board',
          );
        }
      } catch (err) {
        /**
         * Being told not to look is not a failure, and must not be logged as one.
         *
         * With `asksRobots` on, a refusal arrives as the same 403 a broken host would send,
         * and the branch below would file it under "company board probe failed" — a sentence
         * about the vendor being unreachable, when the vendor is fine and this tool chose not
         * to ask. It goes to `unproven` instead, which is the channel that already carries
         * "no SmartRecruiters board is listed above for this name" to the user, so the reason
         * reaches the screen rather than only the log.
         */
        const refusal = robotsRefusal(probe.source, err);
        if (refusal !== null) {
          unproven.set(probe.source, refusal);
          continue;
        }
        // A 404 is the ordinary answer to "does this company use this vendor?" and needs
        // no comment. Anything else — DNS failure, timeout, a 503, a rate limit that
        // outlasted the retries — means the vendor was never actually checked, and the
        // caller sees the same empty result as a company that genuinely has no board
        // there. The condition used to be `continue`, which did nothing at all.
        if (!(err instanceof HttpError) || err.status !== 404) {
          logger.warn({ err, source: probe.source, slug }, 'company board probe failed');
        }
      }
    }
    // Workday joins the same per-candidate round as the GET probes: every vendor is asked
    // about one slug before the next slug is tried, so a company that lives on Workday
    // AND somewhere else surfaces both boards for the user to choose between.
    const workday = await probeWorkday(slug, slug !== firstWordOnly);
    if (workday) found.push(workday);
    /**
     * A board with openings ends the walk. A board with NOTHING posted does not.
     *
     * The exit is here to bound requests, and a hit answers the caller's question, so
     * stopping is right when the hit is strong. A zero-count hit is not strong: `apply
     * .workable.com/api/v1/widget/accounts/stripe` is a real account named "Stripe" with an
     * empty jobs array that belongs to somebody other than the Stripe on Greenhouse, and a
     * slug some other company owns is exactly the case the second and third candidates
     * exist for. Stopping on one buried the 41-job board under the hyphenated slug that the
     * caller was asking for. The stated bound does not move: three candidates at eleven
     * requests each is still the worst case, and it was already paid in full by every
     * company that has no board anywhere.
     */
    if (found.some((f) => f.jobCount > 0)) break;
  }

  /**
   * The note states a fact; the sentence after it depends on what else was found.
   *
   * SmartRecruiters answers 200 with `totalFound: 0` for every id there is, so this note is
   * on essentially every resolve — and it used to end by telling the reader to go and open
   * the company's board and paste a URL. That is the right thing to do when nothing answered
   * and quite wrong when the same response has just handed them a Greenhouse board with 233
   * openings on it.
   *
   * Dropping the note whenever something answered was the other tempting fix, and it gives up
   * something real: one board found is not "and nowhere else", and a reader has no way to know
   * a vendor went unchecked unless told. So the fact is always said, and only the advice moves.
   */
  const notes: string[] = [];
  for (const [source, note] of unproven) {
    // A vendor that answered for one slug candidate and proved nothing for another has been
    // checked, so its note would be noise. The note is for the vendor found nowhere at all.
    if (found.some((f) => f.source === source)) continue;
    notes.push(
      found.length === 0
        ? `${note} If you know this company hires through SmartRecruiters, open its board ` +
            'yourself and paste one of its job URLs.'
        : `${note} The boards above are what could be confirmed, not everywhere this ` +
            'company posts.',
    );
  }

  return { matches: found.sort((a, b) => b.jobCount - a.jobCount), notes };
}
