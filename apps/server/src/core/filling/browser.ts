/**
 * Browser lifecycle — docs/07-form-automation.md § Browser.
 *
 * HEADED BY DEFAULT, and that is a product decision rather than a technical one. The user
 * watches the form being filled, on the real page, and is the one who submits it. A
 * headless run would take the human out of a loop the whole design depends on. Headless is
 * used only against the local fixture site in tests.
 *
 * PERSISTENT CONTEXT. Many ATS platforms require an account. `launchPersistentContext`
 * against data/browser-profile/ means the user signs in once per vendor and the session
 * survives restarts. No password is ever stored by this app: the profile directory belongs
 * to Chromium, and `credential_ref` holds a path, never a secret.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. No fingerprint spoofing, no proxy rotation, no
 * user-agent forgery, no timing models tuned against bot detection. The browser identifies
 * as exactly what it is: Chromium, driven by automation, on the user's own machine. If a
 * site does not want that, the correct response is to stop and hand control back, which is
 * what `awaiting_user` exists for.
 */
import {
  chromium,
  type BrowserContext,
  type Frame,
  type Page,
  type Response,
  type Route,
} from 'playwright';
import { mkdir } from 'node:fs/promises';
import { config } from '../../config';
import { logger } from '../../infra/logger';
import { scrubUrl } from '../../infra/http/fetcher';
import { isAggregatorUrl } from '../discovery/sourcingPolicy';
import { assertPublicHost, PrivateAddressError } from '../../infra/http/publicHost';

export interface SessionOptions {
  /** Headless is for the fixture site only. */
  headless?: boolean;
  /** Override the profile directory. Tests use a throwaway one. */
  profileDir?: string;
}

/**
 * An address Chromium opened a socket to that this tool would never have allowed it to.
 *
 * Discovered after the fact, because the browser is the thing that resolves the name. See
 * `dialledPrivately`.
 */
export interface PrivateDial {
  /** The name in the address bar, which answered a public address when the guard asked it. */
  host: string;
  /** The address the document was actually served from. */
  address: string;
}

export interface BrowserSession {
  context: BrowserContext;
  page: Page;
  /**
   * The first document this session was served from an address on this machine or its
   * network, or null on every ordinary run.
   *
   * Read by run.ts before it reads a page and before it types into one: the request has
   * already happened by the time this is set, and refusing everything after it is the only
   * thing left that helps.
   */
  privateDial: PrivateDial | null;
  /**
   * Resolves once every document response seen so far has been judged.
   *
   * A verdict costs a lookup, so it is not in `privateDial` the instant `goto` returns.
   * Reading the field without awaiting this is a check that passes for the wrong reason.
   */
  dialsJudged: () => Promise<void>;
  close: () => Promise<void>;
}

/**
 * Typing cadence, in milliseconds between keystrokes.
 *
 * Not an evasion measure, and the number is smaller than docs/07 originally specified
 * for a reason worth recording. What makes hostile widgets work is that real key events
 * fire at all — `fill()` assigns a value without them, and React-controlled inputs,
 * autocomplete comboboxes, and rich-text editors ignore that entirely. The PACING is only
 * there so a debouncing widget has time to keep up.
 *
 * The original 40-120ms was a guess, and measuring it showed the cost: the fill suite
 * spent 76 seconds almost entirely on sleeps between keystrokes. This range keeps enough
 * slack for a debounce while being four times cheaper, and the fixture's commit-on-key
 * widget still passes, which is the property that actually matters.
 */
export const TYPING_DELAY = { min: 10, max: 30 } as const;

export function keyDelay(): number {
  return TYPING_DELAY.min + Math.random() * (TYPING_DELAY.max - TYPING_DELAY.min);
}

/**
 * Refuses a page load whose host is on this machine or its network.
 *
 * `startRun` checks the address it is ABOUT to open, and then Chromium takes over and follows
 * 3xx, meta-refresh and `location =` by itself — the same argument the aggregator block above
 * makes, and the same answer. A host that answers `302 Location: http://192.168.1.1/setup.cgi`
 * would otherwise have this profile, the persistent one holding the student's real logins and
 * LAN cookies, issue that request.
 *
 * Refusing the REQUEST rather than noticing afterwards is the point: nothing reaches the host
 * at all, no cookies, no Referer, no TLS handshake carrying SNI.
 *
 * Only document navigations, because a careers page legitimately loads fonts, images and
 * analytics from all over, and a lookup per subresource would be both slow and wrong — a CDN
 * behind a split-horizon DNS is not an attack on anybody.
 */
async function guardAddress(
  route: Route,
  url: string,
  rebound: ReadonlySet<string>,
): Promise<void> {
  // The suite drives the fixture site on 127.0.0.1, so the guard cannot run here — which is
  // why the DECISION is a separate function with no `config.isTest` in it, and is tested
  // directly. A guard whose only code path is switched off under test is a guard nothing holds.
  if (!config.isTest) {
    // A name that has already served this browser a private address is not asked a second
    // time. The next lookup is the attacker's to answer, and one relapse is all the evidence
    // this needs: from here on the request never leaves, which is the outcome the lookup was
    // only ever trying to reach.
    const relapsed = rebound.has(hostOf(url));
    if (relapsed || (await blocksNavigation(url))) {
      logger.warn(
        { url: scrubUrl(url), rebound: relapsed },
        'blocked a navigation to a private address',
      );
      await route.abort('blockedbyclient');
      return;
    }
  }
  await route.continue();
}

/** The host of a URL, or '' if it is not one. Never used as a key when it is empty. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/**
 * The same question `blocksNavigation` asks, put to the address Chromium ACTUALLY DIALLED.
 *
 * `blocksNavigation` resolves the NAME in this process and then hands the name to Chromium,
 * which resolves it AGAIN with its own resolver a moment later. Nothing pins the answer between
 * the two, so a host whose DNS the attacker controls answers a public address to the guard and
 * `127.0.0.1` to the browser — classic rebinding, and the guard will have approved an address
 * that was never used. infra/http/publicHost.ts names that gap in its own header and closes it
 * for fetches with `guardedLookup`, which judges the address the connector dials. A browser
 * takes no lookup hook, so this is the browser's half of the same pair.
 *
 * IT CANNOT UN-SEND THE REQUEST, and pretending otherwise would leave the wrong lesson here: by
 * the time a response has an address behind it, this profile — the persistent one carrying the
 * student's real logins and LAN cookies — has already made the request. What it stops is
 * everything after. run.ts refuses the run before the page is read and before a key is pressed,
 * and `guardAddress` latches the name so the next request to it never leaves at all.
 *
 * Asked as a URL because that is the shape the address check takes, and it costs nothing:
 * `dns.lookup` hands a literal straight back without a network round trip, which is exactly the
 * property publicHost.ts relies on to catch an address written directly into a link.
 */
export async function dialledPrivately(address: string): Promise<boolean> {
  const url = literalUrl(address);
  // An address that cannot be written as one is not an address this can vouch for. publicHost.ts
  // errs the same way on bytes it cannot parse, for the same reason.
  if (url === null) return true;
  return blocksNavigation(url);
}

function literalUrl(address: string): string | null {
  /**
   * CHROMIUM HANDS BACK IPv6 ALREADY BRACKETED, AND THIS FAILS CLOSED.
   *
   * `response.serverAddr()` reports `{"ipAddress":"127.0.0.1"}` for v4 and
   * `{"ipAddress":"[::1]"}` for v6 — measured against this repo's own Playwright. Wrapping a
   * bracketed address again builds `http://[[2606:…]]/`, `new URL` throws, and
   * `dialledPrivately` takes its fail-closed branch and calls a public employer's page
   * private. Chromium prefers IPv6 wherever a AAAA record exists, so on an ordinary
   * dual-stack connection that is not an edge case — it is most fills, refused with a 400
   * telling the student their employer's careers page is "an address on this machine or its
   * own network", and no override anywhere.
   *
   * publicHost.ts's own header warns about exactly this shape of mistake: a guard that tests
   * for "the one spelling that never arrives", and over-blocking not being a safe direction.
   *
   * The brackets come off BEFORE the zone id is split, not after: a bracketed zoned address
   * `[fe80::1%eth0]` split first leaves `[fe80::1` — an unclosed bracket that falls back into
   * the same fail-closed branch this exists to stop.
   */
  const unbracketed = address.trim().replace(/^\[(.*)\]$/, '$1');
  // A zone id names an interface rather than an address, and no URL parser will take one.
  const bare = unbracketed.split('%')[0] ?? '';
  try {
    return new URL(`http://${bare.includes(':') ? `[${bare}]` : bare}/`).href;
  } catch {
    return null;
  }
}

/**
 * Records the first document served from an address this tool refuses.
 *
 * Only documents, matching the route guard: a careers page legitimately loads fonts and
 * analytics from all over, and where the SITE the student's browser visits lives is the whole
 * question.
 */
async function noteDial(
  session: BrowserSession,
  response: Response,
  rebound: Set<string>,
): Promise<void> {
  // The first one is enough. run.ts refuses on it, and a refused run reads nothing further.
  if (session.privateDial) return;

  // A response with no socket behind it — served from the cache, or by a service worker — says
  // nothing about where this browser dialled, and inventing a verdict from it would stop runs
  // on ordinary pages.
  const addr = await response.serverAddr().catch(() => null);
  if (!addr) return;
  if (!(await dialledPrivately(addr.ipAddress))) return;

  const host = hostOf(response.url());
  session.privateDial = { host, address: addr.ipAddress };
  if (host) rebound.add(host);
  logger.warn(
    { url: scrubUrl(response.url()), address: addr.ipAddress },
    'a document was served from a private address by a name that resolved public',
  );
}

/**
 * Whether a document navigation to this address must be refused.
 *
 * Exported for the tests and for nothing else. Only a PrivateAddressError is an answer about
 * the address: a malformed URL or a resolver that threw is not, and Chromium should be left to
 * try it and fail in its own words rather than have one invented for it here.
 */
export async function blocksNavigation(url: string): Promise<boolean> {
  try {
    await assertPublicHost(url);
    return false;
  } catch (err) {
    return err instanceof PrivateAddressError;
  }
}

export async function openSession(opts: SessionOptions = {}): Promise<BrowserSession> {
  const profileDir = opts.profileDir ?? config.paths.browserProfile;
  await mkdir(profileDir, { recursive: true });

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: opts.headless ?? false,
    viewport: { width: 1280, height: 900 },
    // No `--disable-blink-features=AutomationControlled`. That flag's only purpose is to
    // hide `navigator.webdriver` from bot detection, which is exactly the evasion this
    // file's header and docs/07 promise not to do. It was here, and it made those
    // promises false. The browser identifies as automated because it is.
  });

  /** Names this session has already been served a private address by. See `guardAddress`. */
  const rebound = new Set<string>();

  /**
   * The sourcing policy, enforced at the network layer rather than at the call site.
   *
   * `startRun` tests the URL it is ABOUT to open, and then a real browser takes over. Chromium
   * follows 3xx by itself, and meta-refresh and `location =` besides — so an employer "Apply"
   * link that bounces to LinkedIn, Indeed, Handshake or Glassdoor put THIS profile on that
   * host, and this profile is the persistent one carrying the student's own logins. The form
   * mapper would then read that page and a continue would type their name, email and approved
   * answers into it.
   *
   * `politeFetch` closed the identical hole for HTTP fetches by re-checking each redirect hop.
   * A route handler is the browser's equivalent and is stronger than checking `page.url()`
   * after the fact: it refuses the REQUEST, so nothing is sent to the host at all — no cookies,
   * no Referer, no TLS handshake carrying SNI — where a post-hoc check only notices after the
   * page has already been fetched with the session attached.
   *
   * Scoped to top-level document navigations. A careers page legitimately loads fonts, images
   * and analytics from all over, and aborting a subresource would break pages this tool is
   * meant to fill; what the policy is about is which SITE the student's browser visits.
   */
  await context.route('**/*', (route) => {
    const request = route.request();
    if (request.resourceType() !== 'document') {
      void route.continue();
      return;
    }
    if (isAggregatorUrl(request.url())) {
      logger.warn(
        { url: scrubUrl(request.url()) },
        'blocked a navigation to a board this tool does not open',
      );
      void route.abort('blockedbyclient');
      return;
    }
    void guardAddress(route, request.url(), rebound);
  });

  const page = context.pages()[0] ?? (await context.newPage());

  /** Every verdict so far, in order, so `dialsJudged` can be awaited rather than hoped over. */
  let judged: Promise<void> = Promise.resolve();

  const session: BrowserSession = {
    context,
    page,
    privateDial: null,
    dialsJudged: () => judged,
    close: async () => {
      await context.close().catch(() => undefined);
    },
  };

  /**
   * What the route guard above cannot see: which address the request it approved went to.
   *
   * See `dialledPrivately`. Gated on `config.isTest` for the same reason the route guard is —
   * the suite drives the fixture site on 127.0.0.1, which every one of these would refuse —
   * and the decision it defers to is a separate function with no `config.isTest` in it, tested
   * directly, while run.ts's half is tested against a stubbed session.
   */
  if (!config.isTest) {
    context.on('response', (response) => {
      if (response.request().resourceType() !== 'document') return;
      // Chained rather than fired and forgotten: a verdict still in flight when run.ts asks is
      // a verdict that arrives after the typing.
      judged = judged.then(() => noteDial(session, response, rebound)).catch(() => undefined);
    });
  }

  logger.info({ headless: opts.headless ?? false, profileDir }, 'browser session opened');

  return session;
}

/**
 * Signals that the run must stop and hand control to the person.
 *
 * Login walls and bot checks are not obstacles to be worked around. The tool pauses, says
 * what it found, and waits. There is no solver, no bypass, and no third-party service.
 *
 * There are exactly two, and there used to be a third. `unknown_field` was declared here and
 * built nowhere: `detectIntervention` below is the only thing that ever constructs an
 * Intervention, and it returns `login`, `captcha` or nothing at all. A field the classifier
 * cannot place is skipped and reported in the review, which is not a reason to stop and take
 * the browser back from the user.
 *
 * A reason with no producer is not harmless here, because the screen that renders these
 * treats "not login" as "bot check" — so the first code to halt a run on `unknown_field`
 * would have told the user to go and solve a challenge that is not on the page. The type is
 * the honest place to say the third case does not exist.
 */
export type InterventionReason = 'login' | 'captcha';

export interface Intervention {
  reason: InterventionReason;
  detail: string;
}

/**
 * A login wall means a PASSWORD FIELD. Nothing else is sufficient on its own.
 *
 * Sign-in button text used to sit in this list and any one of the four was enough to
 * trigger the verdict — and Playwright's has-text is a case-insensitive substring match,
 * so the sign-in link in a career site's global header stopped the run. Because the same
 * detector runs again on continue, that verdict could never be cleared: the run sat in
 * awaiting_user permanently, on a page that had no login wall at all.
 */
const PASSWORD_FIELDS = ['input[type=password]', 'input[name*="password" i]'];

/**
 * A bot check is recognized by WHO IS SERVING IT, never by the word "challenge".
 *
 * `iframe[title*="challenge" i]` used to be in this list, and Playwright's title match is a
 * case-insensitive substring, so it fired on every embedded coding assessment — HackerRank,
 * Codility and CodeSignal all title their frame something like "Coding Challenge". And
 * because this detector runs again on every continue, that verdict could never be cleared:
 * the run sat in awaiting_user saying the page was running a bot check, while the
 * application form beside the assessment was never read or filled.
 */
const BOT_CHECK_SIGNS = [
  'iframe[src*="recaptcha"]',
  'iframe[src*="hcaptcha"]',
  'iframe[src*="challenges.cloudflare.com"]',
  'iframe[src*="arkoselabs"]',
  'iframe[src*="funcaptcha"]',
  'iframe[src*="perimeterx"]',
  // DataDome and GeeTest, which serve from their own hosts rather than a branded path.
  'iframe[src*="captcha-delivery"]',
  'iframe[src*="geetest"]',
  '[class*="cf-turnstile"]',
  '#challenge-running',
];

/**
 * Controls a person fills in with their own details, which is what an application asks for.
 *
 * The excluded types are the ones no application form identifies an applicant with: a
 * password is the thing being detected, a checkbox is "remember me" as often as it is a
 * question, and search, reset and image belong to the page's furniture rather than its form.
 */
const PLAIN_CONTROLS = [
  'input:not([type=password]):not([type=hidden]):not([type=submit]):not([type=button])' +
    ':not([type=checkbox]):not([type=search]):not([type=reset]):not([type=image])',
  'select',
];

/**
 * The furniture every career site puts around its pages.
 *
 * Counting controls across the whole DOCUMENT is what broke the login detector: a search box
 * in the header, a language picker in the footer and the sign-in form's own email field come
 * to three, so an ordinary branded sign-in page counted as an application form and the run
 * carried on to offer to type the user's email into it. What sits in the header is never
 * what the employer is asking the applicant.
 */
const PAGE_CHROME = [
  'header',
  'nav',
  'footer',
  '[role=banner]',
  '[role=navigation]',
  '[role=contentinfo]',
];

/** One CSS union of "these controls, but only inside those containers". */
function inside(roots: string[], controls: string[]): string {
  return roots.flatMap((r) => controls.map((c) => `${r} ${c}`)).join(', ');
}

/**
 * Looks for a reason to stop before touching anything.
 *
 * Checked before filling rather than after a failure, because typing a name into what
 * turns out to be a login form is exactly the mistake worth preventing.
 */
export async function detectIntervention(page: Page): Promise<Intervention | null> {
  for (const frame of page.frames()) {
    if (frame.isDetached()) continue;
    // A frame that cannot be read is not evidence of anything. `buildFormMap` cannot read it
    // either, so nothing in it will be filled and there is nothing here to stop.
    const found = await inspectFrame(frame).catch(() => null);
    if (found) return found;
  }
  return null;
}

/**
 * The same questions, asked of one frame.
 *
 * THIS USED TO BE ASKED OF THE PAGE, WHICH MEANS THE MAIN FRAME AND NOTHING ELSE —
 * `page.locator()` is `page.mainFrame().locator()` and does not enter iframes. `buildFormMap`
 * iterates `page.frames()` and scans all of them. So the scanner saw one document set and the
 * detector saw another, and everything in the gap between them was filled without ever being
 * checked.
 *
 * Which is most embedded ATS flows, and one line of markup for a hostile page. Verified
 * against a page whose only content is an iframe holding a branded sign-in form: the detector
 * answered null, the main-frame locator counted zero password fields, and the scanner mapped
 * the sign-in box's email input as `semantic: 'email'`. The run never entered `awaiting_user`
 * — it typed the student's address into a sign-in box. A bot check inside the application
 * iframe went the same way: filled, while browser.ts's own header promises this stops for one.
 *
 * The `applicationish` rescue is scoped to the frame the password field is in, so a sign-in
 * iframe sitting beside a real application form is still caught rather than excused by its
 * neighbour. PAGE_CHROME is per-frame for the same reason: an iframe has no header or footer
 * belonging to the document around it.
 */
async function inspectFrame(frame: Frame): Promise<Intervention | null> {
  for (const sel of BOT_CHECK_SIGNS) {
    if ((await frame.locator(sel).count()) > 0) {
      return {
        reason: 'captcha',
        detail:
          'This page is running a bot check. Complete it yourself in the browser window, ' +
          'then continue. This tool does not solve or bypass these.',
      };
    }
  }

  // A password field is only a login wall if there is no application form around it.
  // Plenty of application pages carry an optional account-creation section.
  const passwords = await Promise.all(
    PASSWORD_FIELDS.map(async (s) => (await frame.locator(s).count()) > 0),
  );
  if (passwords.some(Boolean)) {
    /**
     * What tells an application form apart from a sign-in box.
     *
     * Requiring a resume field or a textarea was too narrow — a first wizard step of
     * plain name/email/phone inputs is an application form and was not rescued. But
     * "any control at all" is too wide in the other direction, because a login box has an
     * email field. A sign-in form is two controls; an application form asks for more than
     * that even at its shortest.
     *
     * What went wrong was the counting rather than the threshold, so the controls the page's
     * own furniture supplies are taken back out — by where they sit and by their type, which
     * are the same rule said twice. See PAGE_CHROME.
     */
    const [uploads, essays, plainAnywhere, plainInChrome] = await Promise.all([
      frame.locator('input[type=file]').count(),
      frame.locator('textarea, [contenteditable=true]').count(),
      frame.locator(PLAIN_CONTROLS.join(', ')).count(),
      frame.locator(inside(PAGE_CHROME, PLAIN_CONTROLS)).count(),
    ]);
    const plain = plainAnywhere - plainInChrome;
    const applicationish = uploads > 0 || essays > 0 || plain >= 3;
    if (!applicationish) {
      return {
        reason: 'login',
        detail:
          'This site needs you signed in before it will show the application. Sign in ' +
          'yourself in the browser window that is open, then continue. This tool never ' +
          'types into a password field.',
      };
    }
  }

  return null;
}
