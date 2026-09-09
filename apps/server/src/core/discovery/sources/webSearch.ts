/**
 * Tier B: the live web, searched through the user's own model access — docs/04 § Tier B.
 *
 * This is the tier that was "designed, not built" for the whole life of the project, and the
 * reason the tool needed URLs pasted into it: Tier A reads boards the user already knows
 * about, and nothing searched for the ones they did not. The `web_search` kind sat reserved
 * in the shared enum with no adapter behind it.
 *
 * HOW IT KEEPS THE SOURCING POLICY, which is the part worth reading twice. The model does not
 * scrape anything: on the CLI path it uses Claude Code's WebSearch tool and on the API path
 * the server-side web-search tool, so Anthropic's own search infrastructure runs the queries.
 * The model's answer is a list of CANDIDATE URLs and nothing more — every page it names is
 * then fetched by this process through `fetchManualPosting`, the same polite,
 * robots-respecting, JSON-LD-reading path a hand-pasted URL takes. What gets stored is what
 * the employer's own page says, never what the model claims. A page whose robots.txt refuses
 * us is refused, counted, and reported.
 *
 * LinkedIn, Indeed, Handshake, Glassdoor and the like are excluded twice: the prompt tells
 * the model to return the employer's own posting instead (nearly every aggregator listing is
 * a repost of an ATS page this tool reads legitimately), and `siftCandidates` drops any that
 * come back anyway, out loud. Their terms prohibit automated reads, and this repo's promise
 * not to make them is enforced by tests.
 */
import { z } from 'zod';
import { logger } from '../../../infra/logger';
import { generate, jsonSchemaOf, modelAccessLikely, NoModelAccessError } from '../../../infra/llm';
import { canonicalUrl } from '../normalize';
import { isAggregatorUrl } from '../sourcingPolicy';
import { fetchManualPosting } from '../manualPosting';
import type { JobSource, NormalizedPosting, SourceQuery, SourceResult } from './types';

export { AGGREGATOR_BRANDS, isAggregatorUrl } from '../sourcingPolicy';

export interface Candidate {
  url: string;
  /** What the search result called it — a fallback name, never a stored fact on its own. */
  title: string;
  company: string;
}

export interface CandidateSift {
  /** Fetchable candidates, canonicalized and deduped, in the order the model gave them. */
  candidates: Candidate[];
  aggregators: number;
  malformed: number;
  duplicates: number;
  /** Candidates past the cap. Counted so the sampling is never silent. */
  overCap: number;
}

/**
 * The model's answer reduced to the URLs this process is willing to fetch.
 *
 * Everything dropped is counted by reason, because each reason is reported differently: an
 * aggregator link is a policy refusal and gets a sentence of its own, the cap is a sampling
 * bound and gets another, and a repeat or an unreadable URL is ordinary search-result noise
 * that rides along in the headline. Lumping them together as "some were skipped" would make
 * the one count that matters — the policy refusals — invisible; giving noise its own line on
 * every ordinary run is the other way to make a report stop being read.
 */
export function siftCandidates(
  results: Array<{ url?: unknown; title?: unknown; company?: unknown }>,
  cap: number,
): CandidateSift {
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  let aggregators = 0;
  let malformed = 0;
  let duplicates = 0;
  let overCap = 0;

  for (const r of results) {
    const raw = typeof r.url === 'string' ? r.url.trim() : '';
    if (!/^https?:\/\//i.test(raw) || !URL.canParse(raw)) {
      malformed++;
      continue;
    }
    if (isAggregatorUrl(raw)) {
      aggregators++;
      continue;
    }
    const key = canonicalUrl(raw);
    if (seen.has(key)) {
      duplicates++;
      continue;
    }
    seen.add(key);
    if (candidates.length >= cap) {
      overCap++;
      continue;
    }
    candidates.push({
      url: raw,
      title: typeof r.title === 'string' ? r.title.trim() : '',
      company: typeof r.company === 'string' ? r.company.trim() : '',
    });
  }

  return { candidates, aggregators, malformed, duplicates, overCap };
}

/**
 * Whether a fetched title is a page's furniture rather than a posting's name.
 *
 * A JS-rendered careers page hands the raw-HTML reader nothing, so `fetchManualPosting`
 * falls back to the page `<title>` or its own placeholder — and the first live run of this
 * tier stored "Untitled posting" for Salesforce's Summer 2027 intern role and "Jobs" for
 * Skydio's, with the real names sitting unread in the search results the model had already
 * returned.
 */
export function isFurnitureTitle(title: string): boolean {
  const t = title.trim();
  if (t.length < 3) return true;
  return /^(?:untitled posting|jobs?|careers?|job board|current openings?|open positions?|join (?:us|our team))$/i.test(
    t,
  );
}

/**
 * Whether a fetched company name is just a fragment of the page's own hostname.
 *
 * `guessCompany` in manualPosting.ts derives its fallback from the URL, which on an ATS host
 * names the VENDOR: "job-boards" for a Greenhouse page, "ashbyhq" for an Ashby one. That is
 * never the employer, and it also breaks cross-source dedupe — the same SpaceX posting found
 * through the Greenhouse adapter carries company "spacex", and a fingerprint built from
 * "job-boards" will not merge with it.
 */
export function isHostFragment(company: string, url: string): boolean {
  const c = company.trim().toLowerCase();
  if (c === '') return true;
  if (!URL.canParse(url)) return false;
  return new URL(url).hostname.toLowerCase().split('.').includes(c);
}

/** What the model is asked to return: leads, not facts. The pages themselves are the facts. */
const Findings = z.object({
  results: z
    .array(
      z.object({
        url: z.string(),
        title: z.string(),
        company: z.string(),
      }),
    )
    .max(40),
});

const SYSTEM = `You are the search step of a local tool that helps one student find internships. A human reviews everything downstream; your job is only to find candidate posting pages.

SWEEP, do not take one pass. You have several searches available and the student is relying on this to replace the browsing they would otherwise do by hand. Vary the angle between searches rather than rephrasing one query:
- the role terms with the term and year ("summer 2027 software engineering internship")
- each location in the brief, and again for remote
- recency ("posted this week", "now hiring", "applications open")
- the kinds of employer a student would not think to search for by name: startups, national labs, research groups, non-profits, mid-size firms — not only the famous ones
- the roles a student's own background would suit, not only the exact words of the brief

Rules:
- Every posting must be OPEN NOW. Skip anything closed, filled, or for a past term.
- Return the EMPLOYER'S OWN application page: their careers site, or their page on boards.greenhouse.io, jobs.lever.co, jobs.ashbyhq.com, *.myworkdayjobs.com, jobs.smartrecruiters.com, or apply.workable.com.
- NEVER return links to LinkedIn, Indeed, Glassdoor, ZipRecruiter, Handshake, or any other job aggregator. Those sites refuse automated reads. But their listings are still USEFUL TO YOU: when a search result is an aggregator listing, it names the employer and the role — search again for that employer's own posting of the same job and return THAT. This is how the student gets the postings they would have found on those sites.
- Only return URLs you actually saw in search results. Never construct or guess a URL: a plausible-looking link that 404s wastes a fetch, and an invented one is worse.
- Prefer variety across employers over many roles at one employer.
- Fewer real ones beat more doubtful ones.`;

/**
 * How many candidate pages one run will fetch.
 *
 * Each candidate is a real HTTP fetch of somebody's careers page, rate-limited per host, so
 * the cap is a politeness bound as much as a time bound. `query.limit` may lower it; nothing
 * raises it past the ceiling.
 *
 * Raised from 10/15. The model already sweeps several angles in one call, so the old cap was
 * throwing away most of what it found — a live run named 15 pages and was allowed to read 6,
 * and the note apologising for the other 9 was the tier's most common output. The point of
 * this source is to replace an evening of browsing job boards by hand; a sample of six does
 * not. The fetches are sequential and per-host rate-limited, so the ceiling is what keeps
 * that from becoming a burst at anybody's careers site.
 */
const MAX_CANDIDATES = 24;
const CANDIDATE_CEILING = 30;

/** The JSON object in a text answer, for the CLI path when the envelope carries no object. */
function looseJson(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

export const webSearch: JobSource = {
  kind: 'web_search',
  // "Key" here is model access: the Claude Code CLI signed in, or ANTHROPIC_API_KEY. The
  // sources panel words it that way rather than claiming a key exists — see accessBadge in
  // the web app.
  requiresKey: true,
  isConfigured: () => modelAccessLikely(),

  async fetch(q: SourceQuery): Promise<SourceResult> {
    // The same default the keyed aggregators use: "internship" is the product's premise,
    // not an invented role. A profile-derived brief arrives in `keywords` when there is one.
    const brief = (q.keywords ?? []).map((k) => k.trim()).filter(Boolean);
    const wanted = brief.length > 0 ? brief.join(', ') : 'internship';
    const where = q.location?.trim();

    let answer;
    try {
      answer = await generate({
        purpose: 'web_discovery',
        system: SYSTEM,
        user:
          `Find currently-open internship postings matching this brief.\n\n` +
          `Roles and keywords: ${wanted}\n` +
          (where ? `Location (remote postings also welcome): ${where}\n` : '') +
          `\nSearch the web now and return the results as the required JSON.`,
        maxTokens: 8000,
        schema: jsonSchemaOf('WebSearchFindings', Findings),
        webSearch: true,
      });
    } catch (err) {
      if (err instanceof NoModelAccessError) {
        /**
         * A gap, not a note: the web was not searched, which is coverage the user asked for
         * and did not get. Skipping it quietly would read as "the web had nothing".
         *
         * What it SAYS depends on why, and it used to say one thing for seven causes. A CLI
         * run that timed out — which a 32-turn sweep does on the default 180s ceiling — threw
         * this same error, so the student was told "no model access, sign in to the Claude
         * Code CLI" while signed in to a working CLI, about a search that had started and run
         * out of time. That is a wrong diagnosis carrying a confident remedy, on the one
         * channel this file exists to keep honest.
         */
        return {
          postings: [],
          notes: [],
          gaps: [
            err.isSetupProblem
              ? 'web_search: skipped — no model access. Sign in to the Claude Code CLI or set ' +
                'ANTHROPIC_API_KEY in .env; until then the live web is not searched.'
              : `web_search: the live web was not searched. ${err.message}`,
          ],
        };
      }
      throw err;
    }

    const raw = answer.structured ?? looseJson(answer.text);
    const parsed = Findings.safeParse(raw);
    if (!parsed.success) {
      logger.warn({ provider: answer.provider }, 'web search answer was not a findings list');
      return {
        postings: [],
        notes: [],
        gaps: [
          "web_search: the model's answer could not be read as a list of postings, so " +
            'nothing from the live web is in these results. Run it again.',
        ],
      };
    }

    if (parsed.data.results.length === 0) {
      return {
        postings: [],
        notes: [`web_search: the search found no open postings for "${wanted}".`],
      };
    }

    const cap = Math.min(q.limit ?? MAX_CANDIDATES, CANDIDATE_CEILING);
    const sift = siftCandidates(parsed.data.results, cap);

    // Every candidate the model named is fetched by THIS process, through the same
    // robots-respecting reader a hand-pasted URL goes through. Sequential on purpose: the
    // fetcher rate-limits per host, and a burst across ten employers' career sites is not
    // how a polite tool behaves.
    const postings: NormalizedPosting[] = [];
    const unreadable: string[] = [];
    let namedBySearch = 0;
    for (const candidate of sift.candidates) {
      try {
        const { posting, namedByJsonLd } = await fetchManualPosting(candidate.url);
        /**
         * The search result's naming, but only where the page itself stated none.
         *
         * The page stays the authority on every fact — description, dates, pay, location —
         * and a field the structured data actually filled keeps its own value outright. Per
         * FIELD, not per page: a JobPosting node with a description and no hiringOrganization
         * reports usedJsonLd true while its company is a hostname fragment, and gating on the
         * page-level flag skipped the repair because some other field was structured. What this
         * repairs is the JS-rendered page whose raw HTML names nothing: the reader fell back
         * to "Untitled posting" and a vendor hostname fragment, which is strictly less true
         * than the title the search index showed the model. G2 puts the real page in front
         * of the user before anything else happens either way.
         */
        let renamed = false;
        if (!namedByJsonLd.title && isFurnitureTitle(posting.title) && candidate.title !== '') {
          posting.title = candidate.title;
          renamed = true;
        }
        if (
          !namedByJsonLd.company &&
          isHostFragment(posting.company, candidate.url) &&
          candidate.company !== ''
        ) {
          posting.company = candidate.company;
          renamed = true;
        }
        if (renamed) namedBySearch++;
        postings.push(posting);
      } catch (err) {
        const host = URL.canParse(candidate.url) ? new URL(candidate.url).hostname : candidate.url;
        unreadable.push(`${host}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    /**
     * Repeats and unusable links, folded into the headline rather than given lines of their
     * own.
     *
     * `siftCandidates` counts four reasons and its docstring promised each one "becomes a
     * sentence in the run report"; only aggregators and the cap ever did, so a run where the
     * model returned mostly junk showed an unexplained gap between "named N" and "M read
     * cleanly" with nothing accounting for it. They go in the headline because the prompt
     * asks the model to sweep several angles and this file's own docstring calls a duplicate
     * "ordinary search-result noise" — a line of its own on every ordinary run is exactly the
     * warning fatigue the rest of this change was about.
     */
    const aside = [
      sift.duplicates > 0
        ? `${sift.duplicates} ${sift.duplicates === 1 ? 'was a repeat' : 'were repeats'}`
        : null,
      sift.malformed > 0
        ? `${sift.malformed} had ${sift.malformed === 1 ? 'a URL' : 'URLs'} that could not be read`
        : null,
    ].filter((x): x is string => x !== null);

    const notes: string[] = [
      `web_search: the model searched the live web and named ${parsed.data.results.length} ` +
        `pages${aside.length > 0 ? ` (${aside.join(', ')})` : ''}; ` +
        `${postings.length} read cleanly. This tier samples what a search surfaces — ` +
        'it is not a complete sweep of any board.',
    ];
    if (sift.aggregators > 0) {
      notes.push(
        `web_search: dropped ${sift.aggregators} aggregator ${
          sift.aggregators === 1 ? 'link' : 'links'
        } (LinkedIn, Indeed and the like) — their terms refuse automated reads, and the ` +
          "employer's own posting is what gets fetched instead.",
      );
    }
    if (namedBySearch > 0) {
      notes.push(
        `web_search: ${namedBySearch} ${namedBySearch === 1 ? 'posting' : 'postings'} kept the ` +
          "search result's own name because the page stated none — worth a look at G2.",
      );
    }
    const gaps: string[] = [];

    /**
     * COVERAGE NOT OBTAINED IS A GAP, NOT A NOTE.
     *
     * A note sets neither `degraded` nor `skipped`, so a run that named forty pages, read
     * twenty-four and left sixteen unfetched reported itself as complete: the summary said
     * "web_search: N found" with a green tick, and the sentence about the other sixteen sat
     * among the ordinary status lines nobody reads as a warning. The Workday and
     * SmartRecruiters detail-page caps already report theirs as gaps for exactly this reason;
     * this one was the odd source out.
     *
     * "Run it again for another sample" stays, because unlike a robots refusal this IS a gap
     * the student can act on.
     */
    if (sift.overCap > 0) {
      gaps.push(
        `web_search: read the first ${cap} candidates and left ${sift.overCap} unfetched. ` +
          'Run it again for another sample.',
      );
    }

    if (unreadable.length > 0) {
      gaps.push(
        `web_search: ${unreadable.length} of ${sift.candidates.length} pages the search found ` +
          `could not be read (${unreadable.slice(0, 2).join('; ')}${
            unreadable.length > 2 ? '; …' : ''
          }).`,
      );
    }

    return { postings, notes, ...(gaps.length > 0 ? { gaps } : {}) };
  },
};
