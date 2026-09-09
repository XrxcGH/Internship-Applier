/**
 * Polite HTTP client — see docs/04-job-discovery.md § Politeness and caching.
 *
 * One place for rate limiting, backoff, conditional requests, and robots.txt so every
 * source adapter is well-behaved by construction rather than by remembering to be.
 */
import { logger } from '../logger';
import { config } from '../../config';
import { Agent, fetch as undiciFetch, Response } from 'undici';
import { assertPublicHost, guardedLookup } from './publicHost';
import { isAggregatorUrl } from '../../core/discovery/sourcingPolicy';

const USER_AGENT = 'internship-applier/0.1 (+local personal job-search tool)';
const DEFAULT_RPS = 1;
const MAX_ATTEMPTS = 5;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

interface Bucket {
  tokens: number;
  last: number;
  rps: number;
}

interface CacheEntry {
  body: string;
  etag?: string;
  lastModified?: string;
  at: number;
  status: number;
}

const buckets = new Map<string, Bucket>();
const cache = new Map<string, CacheEntry>();
const robots = new Map<string, RobotsEntry>();

/**
 * How many response bodies to keep at once, and how much they may come to.
 *
 * The TTL above decides whether a hit is SERVED, never whether an entry is dropped, so
 * every distinct URL a session touched used to stay resident for the life of the process.
 * A server left running across a few scheduled refreshes fetches thousands of posting
 * pages, and their HTML sat in memory with nothing bounding it.
 *
 * A COUNT ALONE IS NOT A BOUND ON MEMORY, and adding the 16MB body cap is what made that
 * obvious: five hundred entries of up to sixteen megabytes is an eight gigabyte ceiling, and
 * the bodies are attacker-influenced in exactly the sense that matters — a run reads whatever
 * pages a feed named. Both limits apply, whichever is reached first. 64MB is far more than a
 * session of ordinary postings occupies, and it is a number the machine can actually hold.
 */
const MAX_CACHE_ENTRIES = 500;
const MAX_CACHE_BYTES = 64 * 1024 * 1024;
let cachedBytes = 0;

/**
 * How much of a response this will hold in memory before giving up on it.
 *
 * `res.text()` reads until the connection closes, and a host decides when that is. Nothing
 * here capped it, so a page that streams for as long as it likes was read for as long as it
 * likes: memory first, then whatever the body gets handed to. The addresses this fetches are
 * not chosen by a person — a board feed's row, a model's answer to a web search, a link pasted
 * into the manual box — so "the host would not do that" is not an argument available here.
 *
 * 16 MB is far above any real posting or board feed; the largest thing this legitimately
 * reads is a whole Greenhouse board, a few megabytes of JSON. robots.txt gets its own much
 * smaller number, because a robots file that is not a few kilobytes is not a robots file.
 */
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const MAX_ROBOTS_BYTES = 512 * 1024;

/**
 * The body, or a refusal — never the first N bytes passed off as the whole thing.
 *
 * Truncating would hand a half-read posting to the parsers with nothing anywhere saying a
 * word was missing, and a requirement that decides whether a student is eligible could sit in
 * the half that was dropped. The stream is cancelled on the way out so the socket closes
 * rather than being left to run.
 *
 * `Response.text()` decodes as UTF-8 whatever the charset header says — that is what the
 * Fetch standard specifies — so decoding that way here changes nothing about the result.
 */
async function readCapped(
  res: Response,
  limit: number,
  url: string,
  what: 'page' | 'robots.txt',
): Promise<string> {
  const body = res.body;
  if (!body) return '';

  const decoder = new TextDecoder('utf-8');
  const reader = body.getReader();
  let read = 0;
  let out = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      read += value.byteLength;
      if (read > limit) {
        throw new HttpError(
          `This ${what} was over ${describeSize(limit)} and was not read. ` +
            (what === 'page'
              ? 'A job posting is a page, not a download.'
              : 'A robots file that large is not a robots file.'),
          508,
          url,
          { retryable: false },
        );
      }
      out += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  return out + decoder.decode();
}

/**
 * Could this body be text at all, or is it bytes?
 *
 * Nothing looked at Content-Type, so whatever came back with a 200 was decoded as UTF-8 and
 * stored as the posting's description. A careers link that turns out to be
 * `application/pdf` put `%PDF-1.4` and the replacement character through `stripHtml` and into
 * the description a student reads at G3 — and requirement extraction ran over the same
 * mojibake, which is the reason this is not merely cosmetic: a phrase invented by a decoder
 * is not something the posting says, and eligibility is decided on it.
 *
 * The list is an allowlist because the failure it guards is "these bytes are not language",
 * and the interesting half is why it is not `text/*` plus `application/json`: USAJOBS answers
 * `application/hal+json` and Atom and RSS feeds answer `+xml`, so an equality check on
 * `application/json` would have refused every federal posting — a false failure of exactly the
 * kind this repo cares more about than the one it is fixing. `+json` and `+xml` are the
 * structured-suffix registrations from RFC 6838 § 4.2.8, so the rule is the standard's, not a
 * list of vendors to keep adding to.
 *
 * A response that names no type at all is allowed through by the caller below, and only a
 * response that names one this does not recognise is refused. A server that said nothing has
 * not said "binary", and small employer sites omit the header.
 */
function isTextualType(mediaType: string): boolean {
  if (mediaType.startsWith('text/')) return true;
  return /^application\/(?:json|xml|[\w.+-]+\+(?:json|xml))$/.test(mediaType);
}

/**
 * A byte count a person can read, in the unit that suits it.
 *
 * `Math.round(limit / 1024 / 1024)` was the whole of this, and the robots.txt cap is 512KB —
 * which came out as "over 1MB", a number that appears nowhere in the code and is twice the real
 * limit. A refusal that misstates its own threshold sends whoever reads it looking for a setting
 * that does not exist.
 */
function describeSize(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${String(Math.round(bytes / 1024 / 1024))}MB`
    : `${String(Math.round(bytes / 1024))}KB`;
}

/**
 * A cached body, if it is still worth having.
 *
 * Past the TTL an entry earns its keep only through its validators: an etag or a
 * last-modified turns the next request into a 304 instead of a download. Without either,
 * an expired body is a stale page taking up room and is dropped here.
 */
function readCache(url: string): CacheEntry | undefined {
  const entry = cache.get(url);
  if (!entry) return undefined;
  if (Date.now() - entry.at < CACHE_TTL_MS) return entry;
  if (entry.etag ?? entry.lastModified) return entry;
  dropFromCache(url);
  return undefined;
}

function rememberResponse(url: string, entry: CacheEntry): void {
  // Deleting before setting moves the key to the end, so map order is the order the bodies
  // were WRITTEN, not the order they were last read — reads leave the order alone on
  // purpose. What decides whether an entry is still worth anything here is its age: it is
  // dead six hours after it was fetched, and being read does not make it any fresher. So
  // the first key is the entry closest to expiring and is exactly the one to drop.
  // Promoting on read would invert that, keeping a body with minutes of life left and
  // evicting one downloaded seconds ago. The 304 path re-inserts as well, because a
  // not-modified answer really does restart the clock on that body.
  const replaced = cache.get(url);
  if (replaced) cachedBytes -= replaced.body.length;
  cache.delete(url);
  cache.set(url, entry);
  cachedBytes += entry.body.length;

  while (cache.size > MAX_CACHE_ENTRIES || cachedBytes > MAX_CACHE_BYTES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    // One entry can be larger than the whole budget, in which case evicting everything else
    // would not help and the loop has to stop rather than empty the cache to no purpose.
    if (cache.size === 1 && cachedBytes > MAX_CACHE_BYTES) break;
    dropFromCache(oldest.value);
  }
}

/** The one place an entry leaves the cache, so the byte total cannot drift away from it. */
function dropFromCache(url: string): void {
  const entry = cache.get(url);
  if (!entry) return;
  cachedBytes -= entry.body.length;
  cache.delete(url);
}

/**
 * The connector every request in this module goes through.
 *
 * `undiciFetch` and `Agent` both come from the `undici` package rather than from Node's globals,
 * and they have to come from the SAME copy. Node bundles its own undici and does not expose it,
 * so an Agent from the npm package handed to `globalThis.fetch` is rejected — measured, it fails
 * with "invalid onRequestStart method", because the two versions do not share a dispatcher
 * contract. Importing both keeps them matched.
 *
 * What the dispatcher buys is `guardedLookup`: the address a connection is actually made to is
 * the address that gets range-checked, so a name cannot answer one thing to `assertPublicHost`
 * and another to the connection a moment later. See publicHost.ts for why BOTH checks are
 * needed — a connector never resolves an IP LITERAL, so the up-front check is what covers those.
 *
 * There is no test-only variant of it, and that is the same fact from the other side: the suite
 * runs its servers on `127.0.0.1`, which is a literal, so the lookup is never consulted and the
 * guard has nothing to refuse. The tests exercise the client production uses, unmodified.
 */
const dispatcher = new Agent({ connect: { lookup: guardedLookup } });

/**
 * The fetch this module calls.
 *
 * Several suites drive the source adapters by replacing `globalThis.fetch` with a fixture
 * router — which is the right way to test an adapter, and stopped working the moment this file
 * started calling undici's `fetch` instead of the global one. Rather than give the fetcher a
 * seam that exists only for tests, it notices when one has been installed.
 *
 * UNDER TEST ONLY, and the `config.isTest` is the load-bearing half of that sentence. Deciding
 * purely on "has the global changed" would mean that anything patching `globalThis.fetch` in a
 * running app — a polyfill, an instrumentation library, an npm postinstall with opinions —
 * silently took every request out through a client with no guarded connector and no
 * range-checked address, with nothing anywhere saying so. A guard that can be turned off by a
 * third party's import is not a guard. In production this is always undici with the dispatcher,
 * whatever the global says.
 *
 * Everything else — including the suites that run real local servers — goes through undici with
 * the guarded dispatcher, so the client under test is the client that ships.
 */
const nativeFetch = globalThis.fetch;

function httpFetch(
  url: string,
  init: Parameters<typeof undiciFetch>[1],
): ReturnType<typeof undiciFetch> {
  if (config.isTest && globalThis.fetch !== nativeFetch) {
    return (globalThis.fetch as unknown as typeof undiciFetch)(url, init);
  }
  return undiciFetch(url, init);
}

export interface FetchOptions {
  /** Requests per second for this host. Defaults to 1. */
  rps?: number;
  /**
   * Redirect hops left. Internal — callers leave it alone.
   *
   * A redirect to another origin is a request to a host nobody checked, so it is followed by
   * RE-ENTERING this function rather than by `fetch` following it silently. See the loop.
   */
  hopsLeft?: number;
  headers?: Record<string, string>;
  /** Skip robots.txt. Only for documented API endpoints, never for page fetches. */
  isDocumentedApi?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  /**
   * A JSON request body, which makes the request a POST. Workday's board endpoint is the
   * one public board API that answers only to POST — the same query every visitor's browser
   * sends to render the company's own careers page — and this option exists for that shape
   * alone. A request with a body is never served from the response cache and never stored
   * in it, because the cache is keyed by URL and two different queries to one URL would
   * otherwise read as the same page.
   */
  jsonBody?: unknown;
}

/**
 * Strips credential-shaped query parameters out of a URL.
 *
 * Adzuna requires its app id and key in the query string, and there is no way around
 * that. What there is a way around is carrying them onward: the assembled URL was logged
 * verbatim on every retry and stored on the error, which pino's default serializer then
 * copies out of `err.url` when the discovery run logs the failure. Live API credentials
 * in a log file, in an app whose stated posture is that logs are redacted.
 */
export function scrubUrl(raw: string): string {
  try {
    const u = new URL(raw);
    for (const key of [...u.searchParams.keys()]) {
      if (/key|secret|token|password|app_id|apikey/i.test(key))
        u.searchParams.set(key, '[redacted]');
    }
    return u.toString();
  } catch {
    return raw;
  }
}

export class HttpError extends Error {
  readonly url: string;

  /**
   * Whether trying the same request again could possibly answer differently.
   *
   * The retry rule reads the STATUS — under 500 and not 429 means give up — which is right for
   * anything a server said and wrong for anything this process worked out for itself. The
   * redirect-limit error is raised locally from a counter with status 508, so it fell into the
   * retry path and the terminal hop re-ran its whole attempt loop: five requests and four
   * backoff sleeps to re-derive a number that had not changed.
   *
   * Set explicitly rather than inferred from the status, because the status here is describing
   * the situation to a human, not classifying it for the loop.
   */
  readonly retryable: boolean;

  constructor(
    message: string,
    readonly status: number,
    url: string,
    opts: { retryable?: boolean } = {},
  ) {
    super(message);
    this.name = 'HttpError';
    this.url = scrubUrl(url);
    this.retryable = opts.retryable ?? true;
  }
}

async function takeToken(host: string, rps: number): Promise<void> {
  const b = buckets.get(host) ?? { tokens: rps, last: Date.now(), rps };
  b.rps = rps;

  const now = Date.now();
  b.tokens = Math.min(rps, b.tokens + ((now - b.last) / 1000) * rps);
  b.last = now;

  if (b.tokens < 1) {
    const waitMs = ((1 - b.tokens) / rps) * 1000;
    buckets.set(host, b);
    await sleep(waitMs);
    return takeToken(host, rps);
  }

  b.tokens -= 1;
  buckets.set(host, b);
}

/**
 * Does a Disallow pattern match this path?
 *
 * The REP allows `*` as a wildcard and a trailing `$` as an end anchor, and a plain
 * `startsWith` treated both as literal characters — so "/*?page=" and "/*\/apply$" could
 * never match anything and were silently treated as permission to fetch. Every failure
 * mode of this function has to err toward NOT fetching.
 *
 * `target` is the path AND the query string, because the REP matches against both. Feeding
 * it a bare pathname put "/*?page=" back in the same place: a site that had disallowed
 * paginating through its listings got paginated through anyway, while the plain path rules
 * next to it in the same file were obeyed.
 */
/**
 * The spellings of a path a disallow rule has to be tested against.
 *
 * `URL` does not decode percent-escapes in `pathname`, so
 * `new URL('https://example.com/%61pi/jobs').pathname` is `/%61pi/jobs` — which matches a
 * `Disallow: /api/` rule under no comparison at all, while the origin server decodes the
 * escape and serves the resource its robots.txt asked automated clients to leave alone. The
 * student's address does the crawling, against a promise this tool made on their behalf.
 *
 * This is the same trick `app.ts` documents and defends against for its own routing — never
 * compare a raw request target against a literal path — and it had not been carried over here.
 *
 * Both forms are tested and either one matching is a refusal, because every failure mode of
 * this check is already meant to err toward not fetching. A malformed escape decodes to
 * nothing, so the raw form stands alone rather than the whole check falling over.
 */
function robotsTargets(u: URL): string[] {
  const raw = u.pathname + u.search;
  try {
    const decoded = decodeURIComponent(raw);
    return decoded === raw ? [raw] : [raw, decoded];
  } catch {
    return [raw];
  }
}

/**
 * Wildcard matching by scanning, because compiling these to a regex was a denial of service.
 *
 * Every `*` used to become `.*` in a regex built from a pattern the HOST supplies, and a run of
 * those against a path of repeating characters is the textbook catastrophic-backtracking shape.
 * Measured on the compiled form this replaces — `Disallow: /a*a*a*a*a*a*b` against `/aaaa…` —
 * 442ms at six wildcards, 25.5 SECONDS at eight, and ten never returned at all. Exponential,
 * not merely slow.
 *
 * robots.txt is fetched from every host this tool touches, including one a model named, and the
 * file is entirely under that host's control. Node is single-threaded, so the whole server stops
 * for as long as the match runs, and no timeout can end it because a timeout needs the event
 * loop too. Nothing was required to do this but a robots.txt.
 *
 * The scan cannot backtrack: each literal segment is found once, at its earliest position, and
 * the cursor only ever moves forward. Earliest is the correct greedy choice because only
 * existence matters and it leaves the most room for whatever follows — which is the reasoning a
 * backtracking engine has to rediscover by trying every alternative.
 */
function robotsMatches(pattern: string, target: string): boolean {
  if (pattern === '/') return true;

  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const parts = body.split('*');

  // No wildcard at all: a plain prefix, or the whole path when the rule is anchored.
  if (parts.length === 1) return anchored ? target === body : target.startsWith(body);

  const first = parts[0]!;
  if (!target.startsWith(first)) return false;
  let at = first.length;

  for (const segment of parts.slice(1, -1)) {
    if (segment === '') continue;
    const found = target.indexOf(segment, at);
    if (found === -1) return false;
    at = found + segment.length;
  }

  const last = parts[parts.length - 1]!;
  if (last === '') return true;
  if (!anchored) return target.indexOf(last, at) !== -1;
  return target.length - last.length >= at && target.endsWith(last);
}

/**
 * What a host's robots.txt says, or that it would not say.
 *
 * `unreadable` carries the reason rather than a flag, because the refusal it produces is
 * shown to the user on the source-health line and "robots.txt disallows /careers/" would be
 * a false claim about a file nobody managed to read.
 */
interface Robots {
  disallow: Set<string>;
  unreadable: string | null;
}

interface RobotsEntry {
  value: Robots;
  at: number;
}

/**
 * How long a failed robots.txt lookup is believed before trying again.
 *
 * A successful parse is kept for the life of the process — a site's rules do not change
 * during one run. A failure is a statement about one moment, and caching it forever is how
 * a five-minute outage became a permanent verdict either way round.
 */
const ROBOTS_RETRY_MS = 5 * 60 * 1000;

/**
 * Conservative parse: collects Disallow paths that apply to `*` or to us.
 *
 * "Conservative" was aspirational. Consecutive User-agent lines form ONE group under the
 * REP, but `applies` was reassigned by each line in turn, so
 *
 *     User-agent: *
 *     User-agent: AdsBot
 *     Disallow: /careers/
 *
 * left `applies` false and threw away a rule that binds us. Grouping is now accumulated
 * until the first non-User-agent line, which is what the standard actually says.
 *
 * Missing `Allow:` support stays missing on purpose: ignoring an Allow can only make this
 * refuse a fetch it could have made, and that is the direction to be wrong in.
 */
/**
 * How many redirects a robots.txt gets. RFC 9309 § 2.3.1.2 asks for at least five.
 */
const MAX_ROBOTS_REDIRECTS = 5;

/**
 * The robots.txt request, under the same rules as every other request in this file.
 *
 * It used to be a bare `fetch`, and a bare `fetch` follows redirects: Node's default is
 * `redirect: 'follow'`, up to twenty hops, to anywhere. So the one request in this module
 * whose entire purpose is politeness was the one with no private-address check, no aggregator
 * check and no hop cap on where it ended up. A host answering `301 Location:
 * http://127.0.0.1:11434/api/tags` — or 192.168.1.1, or 169.254.169.254 — got this process to
 * issue an attacker-chosen GET inside the user's own network. `Location:
 * https://www.linkedin.com/jobs/view/123` got it to fetch a board this tool refuses to open,
 * from the student's own address, past the boundary the whole sourcing policy exists to hold.
 *
 * Redirects are still followed, because a site moving its robots.txt to `www` is ordinary and
 * refusing outright would read as a complete disallow and quietly stop reading that employer.
 * They are followed one at a time, with every hop checked, which is what the main loop does.
 */
async function fetchRobots(url: string): Promise<Response> {
  let at = url;

  for (let hop = 0; ; hop++) {
    if (!config.isTest) await assertPublicHost(at);
    if (isAggregatorUrl(at)) {
      // Said differently for the first hop, because on the first hop nothing has redirected
      // anywhere and "robots.txt redirects to www.linkedin.com" is simply not what happened.
      // An error that misdescribes the situation costs whoever reads it the time to work out
      // that it did not mean what it said.
      throw new HttpError(
        hop === 0
          ? `${new URL(at).hostname} is a job board this tool does not open.`
          : `robots.txt redirects to ${new URL(at).hostname}, which this tool does not open.`,
        403,
        at,
      );
    }

    const res = await httpFetch(at, {
      headers: { 'user-agent': USER_AGENT },
      redirect: 'manual',
      signal: AbortSignal.timeout(8000),
      dispatcher,
    });

    // 304/305/306 carry a Location that does not mean "go here"; only the redirect statuses do.
    const redirecting = res.status === 301 || res.status === 302 || res.status === 303;
    const permanent = res.status === 307 || res.status === 308;
    if (!redirecting && !permanent) return res;

    const location = res.headers.get('location');
    // A redirect nobody can follow is a robots.txt nobody can read, which this file already
    // treats as a complete disallow rather than as permission.
    if (location === null || hop >= MAX_ROBOTS_REDIRECTS) {
      return new Response(null, { status: 502, statusText: 'unfollowable robots.txt redirect' });
    }
    at = new URL(location, at).toString();
  }
}

async function disallowedPaths(origin: string): Promise<Robots> {
  const cached = robots.get(origin);
  if (cached && (!cached.value.unreadable || Date.now() - cached.at < ROBOTS_RETRY_MS)) {
    return cached.value;
  }

  const paths = new Set<string>();
  let unreadable: string | null = null;
  try {
    const res = await fetchRobots(`${origin}/robots.txt`);

    /**
     * What a robots.txt we did not get back actually means.
     *
     * RFC 9309 § 2.3.1 gives three answers, and this collapsed them into one: anything that
     * was not a 200 fell into the same `catch`-and-carry-on as a DNS failure, cached an
     * empty disallow set for the life of the process, and read as "nothing here is off
     * limits". A site in a maintenance window served 503 for its robots.txt and got its
     * whole careers section crawled — including, once the maintenance ended, the paths it
     * had been disallowing all along, because the empty set was never revisited.
     *
     * 4xx really is allow-all: the file is absent and the site has said nothing. 5xx is a
     * complete disallow, because the site's answer is "ask me later" and assuming
     * permission is helping ourselves to it. 429 belongs with the 5xx group rather than
     * with its own status class — it is the server saying it cannot answer right now, which
     * is the one thing the status class does not tell you.
     */
    if (res.status === 429 || res.status >= 500) {
      unreadable = `${String(res.status)} ${res.statusText}`;
    } else if (res.ok) {
      // `group` collects the agents named since the last rule line; `applies` is whether
      // any of them is us. A rule line ends the run of agent lines.
      let group: string[] = [];
      let applies = false;
      let inGroup = false;

      const robots = await readCapped(res, MAX_ROBOTS_BYTES, `${origin}/robots.txt`, 'robots.txt');
      for (const raw of robots.split('\n')) {
        const line = raw.split('#')[0]!.trim();
        if (!line) continue;
        const [k, ...rest] = line.split(':');
        const key = k?.toLowerCase().trim();
        const value = rest.join(':').trim();

        if (key === 'user-agent') {
          if (inGroup) {
            group = [];
            inGroup = false;
          }
          group.push(value);
          applies = group.some(
            (a) => a === '*' || USER_AGENT.toLowerCase().startsWith(a.toLowerCase()),
          );
        } else if (key === 'disallow') {
          inGroup = true;
          if (applies && value) paths.add(value);
        } else if (key === 'allow' || key === 'crawl-delay') {
          inGroup = true;
        }
      }
    }
  } catch (err) {
    // A timeout, a DNS failure, a TLS error: we do not know what this site permits.
    unreadable = err instanceof Error ? err.message : String(err);
  }

  const value: Robots = { disallow: paths, unreadable };
  robots.set(origin, { value, at: Date.now() });
  return value;
}

/**
 * How many redirects one address may take before this gives up.
 *
 * Five is what browsers and curl settle on. Each hop is a full re-entry — its own robots.txt
 * read, its own rate-limit token — so a chain is not free, and a cycle has to end somewhere.
 */
const MAX_REDIRECTS = 5;

export async function politeFetch(url: string, opts: FetchOptions = {}): Promise<string> {
  const u = new URL(url);
  const host = u.host;

  /**
   * Not this machine, and not its network.
   *
   * A person chose none of the URLs that reach here directly: they come from a board API's
   * response, a model's answer, or a link pasted into the manual box. Without this, any of
   * the three could point at `http://127.0.0.1:8787`, a router's admin page, or a NAS — and
   * whatever answered was stored as a posting's description and shown as one.
   *
   * Skipped under test because the whole fetcher suite runs against local servers on
   * 127.0.0.1, which is the only honest way to test an HTTP client. The rule itself is not
   * skipped with it: `publicHost.test.ts` exercises the range logic directly, so the decision
   * is covered even though this call site is not the thing making it.
   */
  if (!config.isTest) await assertPublicHost(url);

  /**
   * The sourcing policy, applied to the address this was ASKED for — not only to where a
   * redirect later goes.
   *
   * The redirect hop below already makes the argument for this one: "politeFetch does not know
   * its caller's policy, but it does know that no path in this app may open these hosts." That
   * was true of the destination and left untrue of the origin. Every caller checked the string
   * it was about to pass, the redirect hop checked where it ended up, and the entry itself
   * checked nothing — so the rule held only for as long as every caller remembered it.
   *
   * What made that more than theoretical is `isDocumentedApi`. It skips robots.txt, and
   * robots.txt was the only thing standing in front of an aggregator URL handed straight to
   * this function: same origin, so `fetchRobots` refused it by accident of geography rather
   * than by design. Measured with the flag set — the request went out and LinkedIn answered
   * 404, from the student's own address, against a rule this repo states as never fetched.
   */
  if (isAggregatorUrl(url)) {
    throw new HttpError(
      `${u.hostname} is a job board this tool does not open, so nothing was fetched from it.`,
      403,
      url,
      { retryable: false },
    );
  }

  if (!opts.isDocumentedApi) {
    const rules = await disallowedPaths(u.origin);
    if (rules.unreadable !== null) {
      throw new HttpError(
        `${u.origin}/robots.txt could not be read (${rules.unreadable}), so nothing is ` +
          'fetched from this host until it can be. Try again in a few minutes.',
        403,
        url,
      );
    }
    for (const p of rules.disallow) {
      if (robotsTargets(u).some((target) => robotsMatches(p, target))) {
        throw new HttpError(`robots.txt disallows ${u.pathname}`, 403, url);
      }
    }
  }

  // A POST is a query, not a page: the cache is keyed by URL alone, so serving or storing
  // one would hand every later query the first query's answer.
  const hit = opts.jsonBody === undefined ? readCache(url) : undefined;
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.body;

  let lastErr: unknown;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    await takeToken(host, opts.rps ?? DEFAULT_RPS);

    try {
      /**
       * A caller's header REPLACES the default of the same name, whatever case it spells it in.
       *
       * `...opts.headers` reads as if it did that, and does only when the spelling happens to
       * match. The USAJOBS adapter sends `'User-Agent'`, capitalised the way the vendor's own
       * docs write it, so the object carried `user-agent` AND `User-Agent` as two distinct
       * keys — and undici's `Headers` lowercases them into one and APPENDS. Measured, the
       * request went out with
       *
       *     user-agent: internship-applier/0.1 (+local personal job-search tool), <registered agent>
       *
       * USAJOBS requires the User-Agent to be the address registered against the API key, and
       * that joined string is not it, so the one source of federal internships and Pathways
       * identifies itself as something neither side ever configured.
       *
       * Normalising rather than special-casing user-agent, because every default here has the
       * same shape and the same adapter proves it: its `Accept: application/json` arrived with
       * this function's whole default accept list joined in front of it. A caller spelling
       * `Content-Type`, `If-None-Match` or `If-Modified-Since` would have joined ours the same
       * way — and for a conditional header, a joined value is one no server can match, so a
       * revalidation would silently stop revalidating.
       */
      const headers: Record<string, string> = {
        'user-agent': USER_AGENT,
        accept: 'application/json, text/html;q=0.9, */*;q=0.5',
      };
      for (const [name, value] of Object.entries(opts.headers ?? {})) {
        headers[name.toLowerCase()] = value;
      }
      if (hit?.etag) headers['if-none-match'] = hit.etag;
      if (hit?.lastModified) headers['if-modified-since'] = hit.lastModified;

      if (opts.jsonBody !== undefined) headers['content-type'] = 'application/json';

      const res = await httpFetch(url, {
        headers,
        ...(opts.jsonBody !== undefined
          ? { method: 'POST', body: JSON.stringify(opts.jsonBody) }
          : {}),
        // Followed by hand, below. See the block that reads this.
        redirect: 'manual',
        signal: opts.signal ?? AbortSignal.timeout(opts.timeoutMs ?? 20_000),
        dispatcher,
      });

      /**
       * A redirect is a request to a host this function has not checked yet.
       *
       * Node's fetch defaults to `redirect: 'follow'`, so a 301 to another origin was fetched
       * with that origin's robots.txt never consulted, its rate-limit bucket never touched,
       * and — for the discovery and manual paths — the aggregator rule never re-applied, since
       * every caller checks the string it was about to pass and nothing re-checks where it
       * actually went. Aggregator listings are reached through exactly this shape: a short
       * link, or an employer page that bounces to a board. docs/04 § Politeness states the
       * stronger claim, that robots.txt is respected for any generic page fetch.
       *
       * So it re-enters `politeFetch` for the new address, which puts the new host through
       * every check the original went through. Bounded by a hop count, because a redirect
       * cycle is otherwise a stack overflow, and `Location` is resolved against the current
       * URL because a relative one is legal and common.
       */
      // 304 is a 3xx and is NOT a redirect: it is the answer to a conditional request and
      // carries no Location, so this branch threw `304 with no Location header` on it and the
      // handler below — which returns the cached body — became unreachable. Every ETag and
      // Last-Modified revalidation failed instead of hitting cache, which is the opposite of
      // what docs/04 § Politeness says this code does. 305 and 306 are also not redirects a
      // client follows: one is a dead proxy directive and the other was withdrawn.
      if (res.status >= 300 && res.status < 400 && ![304, 305, 306].includes(res.status)) {
        const location = res.headers.get('location');
        if (location === null) {
          throw new HttpError(`${res.status} with no Location header`, res.status, url);
        }
        const hopsLeft = opts.hopsLeft ?? MAX_REDIRECTS;
        if (hopsLeft <= 0) {
          throw new HttpError(
            `More than ${MAX_REDIRECTS} redirects starting at this address, so it was not ` +
              'followed any further.',
            508,
            url,
            // Counted here, not reported by anybody. Re-fetching cannot produce a shorter chain.
            { retryable: false },
          );
        }
        const next = new URL(location, url).toString();
        /**
         * The sourcing policy, re-applied to where the redirect actually goes.
         *
         * Every caller checks the string it is ABOUT to pass and nothing re-checks the
         * destination, so a short link or an employer page that bounces to a board would have
         * reached the board with the rule satisfied on the wrong URL. This is the one check
         * that cannot wait for the recursion: politeFetch does not know its caller's policy,
         * but it does know that no path in this app may open these hosts.
         */
        if (isAggregatorUrl(next)) {
          throw new HttpError(
            `This address redirects to ${new URL(next).hostname}, which this tool does not ` +
              'open. Nothing was fetched from it.',
            403,
            next,
          );
        }
        /**
         * Neither the body nor the caller's headers cross an origin.
         *
         * The POST body because re-POSTing a query to wherever a 302 points is how one query's
         * answer ends up somewhere nobody asked, and the vendor endpoint that option exists
         * for does not redirect anyway.
         *
         * The headers because on this codebase they are a CREDENTIAL. The only caller that
         * sets any is the USAJOBS adapter, and what it sets is the user's own API key — so a
         * 30x from that host, or from anything down a chain starting there, handed the key to
         * whatever the Location named. Browsers and curl both strip authorization on a
         * cross-origin redirect for exactly this reason. Same-origin they are kept, since that
         * is the ordinary case of an API redirecting within itself and the key is meant for
         * that host.
         */
        const crossOrigin = new URL(next).origin !== u.origin;
        return politeFetch(next, {
          ...opts,
          hopsLeft: hopsLeft - 1,
          jsonBody: undefined,
          ...(crossOrigin
            ? {
                headers: undefined,
                /**
                 * And the robots exemption is dropped with them.
                 *
                 * `isDocumentedApi` says "this exact URL is a vendor's published API, so its
                 * robots.txt is not the right question to ask of it" — a claim about the address
                 * the CALLER named, and `fetchJson` sets it by default, so every ATS and
                 * aggregator request carries it. Spread through a cross-origin hop it became a
                 * claim about wherever the Location pointed, and that host's rules were never
                 * read at all. `MAX_REDIRECTS` says each hop gets "its own robots.txt check",
                 * and for the commonest caller in the app it did not.
                 */
                isDocumentedApi: false,
              }
            : {}),
        });
      }

      if (res.status === 304 && hit) {
        rememberResponse(url, { ...hit, at: Date.now() });
        return hit.body;
      }

      if (res.status === 429 || res.status >= 500) {
        // Kept so the throw at the end of the loop carries the real status. Without it, a
        // source that answered 429 five times in a row surfaced as HttpError(status 0),
        // and the per-source health line the user reads said only that something failed —
        // not that it was a rate limit rather than an outage or a dead network.
        lastErr = new HttpError(`${res.status} ${res.statusText}`, res.status, url);

        // Waiting after the final attempt delays the error by up to thirty seconds and
        // changes nothing, because there is no attempt left to make.
        if (attempt === MAX_ATTEMPTS - 1) break;

        /**
         * Two bugs lived in one line here.
         *
         * `Number(null)` is 0 and `Number.isFinite(0)` is true, so an ABSENT Retry-After —
         * the common case on a 500 — produced a zero wait and the exponential backoff
         * documented in docs/04 never ran at all. And when the header WAS present it was
         * honoured uncapped, so a "Retry-After: 1800" parked a whole discovery run inside
         * one fetch for half an hour. An HTTP-date value is NaN and falls through to
         * backoff, which is the right outcome.
         */
        const header = res.headers.get('retry-after');
        const seconds = header === null ? Number.NaN : Number(header);
        const waitMs =
          Number.isFinite(seconds) && seconds > 0
            ? Math.min(seconds * 1000, MAX_RETRY_AFTER_MS)
            : backoffMs(attempt);
        logger.debug({ url: scrubUrl(url), status: res.status, waitMs }, 'retrying after backoff');
        await sleep(waitMs);
        continue;
      }

      if (!res.ok) throw new HttpError(`${res.status} ${res.statusText}`, res.status, url);

      /**
       * What came back has to be capable of being a posting before it is read as one.
       *
       * Checked here and NOT in `fetchRobots`, deliberately: a robots.txt this refused would be
       * an unreadable robots.txt, which this file treats as a complete disallow, so a host
       * serving its rules as `application/octet-stream` — or as a `text/html` soft-404 page —
       * would take that whole employer's site dark. The direction of harm is opposite in the
       * two places, so the rule is applied in only one of them.
       *
       * Refused before the body is read, so a 300MB video is never decoded at all, and the
       * stream is cancelled so the socket closes rather than being left to run — the same care
       * `readCapped` takes on its way out. Not retryable: the same URL answers with the same
       * PDF five times, and five backoff sleeps only delay the message the user needs to see.
       */
      const mediaType = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
      if (mediaType !== '' && !isTextualType(mediaType)) {
        await res.body?.cancel().catch(() => undefined);
        throw new HttpError(
          `This address answered with ${mediaType}, not a page, so nothing was read from it. ` +
            'Its bytes would have been stored as the posting description and read as its ' +
            'requirements. If the posting is a PDF or another download, open the page that ' +
            'links to it and use that address instead.',
          415,
          url,
          { retryable: false },
        );
      }

      const body = await readCapped(res, MAX_BODY_BYTES, url, 'page');
      if (opts.jsonBody === undefined) {
        rememberResponse(url, {
          body,
          etag: res.headers.get('etag') ?? undefined,
          lastModified: res.headers.get('last-modified') ?? undefined,
          at: Date.now(),
          status: res.status,
        });
      }
      return body;
    } catch (err) {
      lastErr = err;
      // `retryable` first: a locally-derived failure cannot change by being repeated, whatever
      // status it wears for the reader's benefit.
      if (err instanceof HttpError && !err.retryable) throw err;
      if (err instanceof HttpError && err.status < 500 && err.status !== 429) throw err;
      if (attempt === MAX_ATTEMPTS - 1) break;
      await sleep(backoffMs(attempt));
    }
  }

  throw lastErr instanceof Error ? lastErr : new HttpError('request failed after retries', 0, url);
}

/**
 * A documented API endpoint, parsed.
 *
 * `isDocumentedApi` defaults on here, so every call through this function skips robots.txt.
 * That is right for the endpoints it exists for — Greenhouse, Lever, Ashby and Adzuna all
 * publish these as APIs — and wrong for anything that renders a page for humans. A page
 * goes through politeFetch even when it happens to return JSON. Pass
 * `isDocumentedApi: false` if a caller is ever unsure; the default is a convenience, not a
 * claim about the URL.
 */
export async function fetchJson<T>(url: string, opts: FetchOptions = {}): Promise<T> {
  return JSON.parse(await politeFetch(url, { isDocumentedApi: true, ...opts })) as T;
}

/**
 * The longest a server's Retry-After is allowed to hold up a run.
 *
 * Deliberately close to the backoff ceiling. Waiting longer than this is not politeness,
 * it is a run that appears to have hung.
 */
const MAX_RETRY_AFTER_MS = 60_000;

/** Exponential backoff with full jitter. */
function backoffMs(attempt: number): number {
  return Math.random() * Math.min(30_000, 500 * 2 ** attempt);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
