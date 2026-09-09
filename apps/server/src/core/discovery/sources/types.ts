import type { SourceKind } from '@ia/shared';
import { HttpError } from '../../../infra/http/fetcher';

/** A posting as it comes off a source, before eligibility or scoring. */
export interface NormalizedPosting {
  externalId: string | null;
  canonicalUrl: string;
  applyUrl: string;
  company: string;
  companyDomain: string | null;
  title: string;
  descriptionText: string;
  descriptionHtml: string | null;
  locations: Array<{ city?: string; region?: string; country?: string; remote: boolean }>;
  positionType: string | null;
  workArrangement: string | null;
  hybridDaysOnsite: number | null;
  remoteEligibleIn: string[];
  programFlags: string[];
  term: {
    season: string | null;
    year: number | null;
    start?: string;
    end?: string;
    durationWeeks: number | null;
    multiTerm: boolean;
  };
  compensation: Record<string, unknown> | null;
  requires: Record<string, boolean>;
  postedAt: string | null;
  closesAt: string | null;
  atsVendor: string;
}

export interface SourceQuery {
  /** Board slug / company token for ATS sources. */
  board?: string;
  keywords?: string[];
  location?: string;
  limit?: number;
}

export interface SourceResult {
  postings: NormalizedPosting[];
  /** Anything skipped or truncated is reported, never silently dropped (docs/04). */
  notes: string[];
  /**
   * The notes that describe coverage we did not get — a page of results we stopped at,
   * rows that could not be read — as opposed to a plain status line. The runner marks the
   * source degraded for these and repeats them in the run summary's `skipped` list, which
   * is where the UI gets "the search was incomplete" from. A note in `notes` alone does
   * neither, so a source that quietly returned its first fifty of eight hundred matches
   * read as complete coverage.
   */
  gaps?: string[];
  /**
   * Postings this source says are no longer open, as canonical URLs.
   *
   * A source that publishes its own closure signal is the best evidence there is that a
   * posting has gone, and it was being thrown away: the community list marks a finished role
   * `active: false` and the adapter simply skipped the row. Nothing closed, nothing said —
   * the stored posting stayed open until forty-five days of not-being-seen expired it, and
   * in the meantime the queue went on offering a student an application they could no longer
   * make. `refreshPostings` can only ask a URL whether it 404s; this is the source telling us
   * outright, and it costs no request at all.
   *
   * Empty and absent mean the same thing — "this source does not say" — and neither is ever
   * read as "everything else is still open".
   */
  closed?: string[];
}

/**
 * A response that is not shaped like a list of postings, said out loud.
 *
 * `data.jobs ?? []` was the shape every adapter here used, and it cannot tell a board with
 * nothing posted from an endpoint that has changed, moved, or started answering with an
 * error object. Both came out as "0 found", not degraded, nothing in `skipped` — a run
 * reporting a clean, complete search of a source it had in fact failed to read, which is the
 * one failure this file's `gaps` channel exists to prevent.
 *
 * An absent key is a genuine empty board on several of these APIs, so only a key that is
 * PRESENT and not an array counts as drift.
 */
export function wrongShape(source: string, value: unknown): SourceResult | null {
  if (value === undefined || value === null || Array.isArray(value)) return null;
  return {
    postings: [],
    notes: [],
    gaps: [
      `${source}: the source answered with something that is not a list of postings, so ` +
        'nothing from it is in these results. Its API may have changed.',
    ],
  };
}

export interface JobSource {
  kind: SourceKind;
  /** Whether this source needs an API key the user hasn't supplied. */
  requiresKey: boolean;
  isConfigured(): boolean;
  fetch(query: SourceQuery): Promise<SourceResult>;
}

/**
 * A numeric entity, decoded as a code point rather than a UTF-16 unit.
 *
 * String.fromCharCode takes the number modulo 65536, so `&#128077;` (a thumbs-up, the
 * kind of thing a job description puts in a perks list) came out as an unrelated CJK
 * character. Anything outside the Unicode range is left as written rather than throwing —
 * a stray `&#99999999;` in one posting must not take down the whole source.
 */
function decodeNumericEntity(match: string, digits: string): string {
  const cp = Number(digits);
  return Number.isInteger(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : match;
}

/**
 * The named entities that actually turn up in job descriptions.
 *
 * `&amp;` is deliberately absent: it is decoded last, on its own, so that "&amp;lt;" ends
 * up as the literal text "&lt;" rather than as a tag. Anything not listed is left exactly
 * as written, because a stray "&foo;" printed as-is is easier to read past than a wrong
 * guess at what it meant.
 */
const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
  shy: '',
  quot: '"',
  apos: "'",
  lt: '<',
  gt: '>',
  lsquo: '‘',
  rsquo: '’',
  sbquo: '‚',
  ldquo: '“',
  rdquo: '”',
  bdquo: '„',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  bull: '•',
  middot: '·',
  laquo: '«',
  raquo: '»',
  copy: '©',
  reg: '®',
  trade: '™',
  deg: '°',
  plusmn: '±',
  times: '×',
  divide: '÷',
  frac12: '½',
  frac14: '¼',
  frac34: '¾',
  euro: '€',
  pound: '£',
  yen: '¥',
  cent: '¢',
  sect: '§',
  para: '¶',
  dagger: '†',
  prime: '′',
  minus: '−',
  aacute: 'á',
  agrave: 'à',
  acirc: 'â',
  auml: 'ä',
  aring: 'å',
  atilde: 'ã',
  aelig: 'æ',
  ccedil: 'ç',
  eacute: 'é',
  egrave: 'è',
  ecirc: 'ê',
  euml: 'ë',
  iacute: 'í',
  igrave: 'ì',
  icirc: 'î',
  iuml: 'ï',
  ntilde: 'ñ',
  oacute: 'ó',
  ograve: 'ò',
  ocirc: 'ô',
  ouml: 'ö',
  otilde: 'õ',
  oslash: 'ø',
  uacute: 'ú',
  ugrave: 'ù',
  ucirc: 'û',
  uuml: 'ü',
  yacute: 'ý',
  szlig: 'ß',
};

function decodeNamedEntity(match: string, name: string): string {
  const exact = NAMED_ENTITIES[name];
  if (exact !== undefined) return exact;
  const lower = NAMED_ENTITIES[name.toLowerCase()];
  if (lower === undefined) return match;
  // The table is written in lower case, and "&Eacute;" is simply the capital of "&eacute;".
  return /^[A-Z]/.test(name) ? lower.toUpperCase() : lower;
}

/**
 * One decoding pass, shared by both entry points below so the two cannot drift apart.
 *
 * Only decimal `&#39;` used to be handled, and boards write the hexadecimal `&#x27;` just
 * as often. A posting that asked for a "bachelor&#x27;s program" reached the requirement
 * parsers with the raw entity still in it — the degree pattern needs a space where the
 * "&" sits, so the education requirement was never extracted — and the same literal junk
 * was shown to the user in the description pane. `&mdash;` and the accented names were in
 * the same position: written out in full on screen.
 *
 * The ampersand is always last. Decoding it first turned a description that talked about
 * the "&amp;lt;code&amp;gt; tag" into one that talked about the "<code> tag".
 */
function decodeAll(text: string): string {
  return text
    .replace(/&([a-z][a-z0-9]{1,9});/gi, decodeNamedEntity)
    .replace(/&#(\d+);/g, decodeNumericEntity)
    .replace(/&#x([0-9a-f]+);/gi, (m, hex: string) =>
      decodeNumericEntity(m, String(parseInt(hex, 16))),
    )
    .replace(/&amp;/gi, '&');
}

/**
 * Turns HTML entities back into the characters they stand for.
 *
 * Separate from stripHtml because order matters and the two are needed at different
 * points. Greenhouse returns its job content ESCAPED — `&lt;p&gt;About the role&lt;/p&gt;`
 * — so stripping tags first finds none to strip, and the decode afterwards puts the
 * markup back as literal text. Every requirement parser and the model then read `<p>` and
 * `<li>` as part of the job description, and the UI rendered them on screen.
 */
export function decodeEntities(html: string): string {
  return decodeAll(html);
}

/**
 * The same three tag-removing passes the regexes did, without the backtracking.
 *
 * THIS FUNCTION WAS FIVE CHAINED REGEXES AND IT WAS QUADRATIC. `/<[^>]+>/g` is the expensive
 * one: at every `<` the `[^>]+` runs to the end of the input looking for a `>`, fails, and
 * gives back one character at a time. Measured before the rewrite on a body that is simply
 * the character `<` repeated — 10 KB took 61ms, 20 KB 221ms, 40 KB 909ms, 80 KB 18.3 SECONDS.
 * Repeated `<script` and `<meta ` behave the same way. A one megabyte page, which any host
 * can serve and nothing here caps, is minutes.
 *
 * It matters because this is pointed at whatever a fetch returned: a careers page the model
 * named, a link pasted into the manual box, a `description` on an open feed anyone can post a
 * row to. Node is single-threaded, so for the whole of that time the server does nothing else
 * — not the health check, not the event stream, and not a fill run standing on a real
 * employer's form. No timeout can end it either, because a timeout needs the event loop too.
 *
 * THE PASSES STAY IN THIS ORDER AND SEPARATE, which a first attempt at this did not, and 1,150
 * of 20,000 generated documents came out different. Removing `<br>` BEFORE the general tag
 * pass is what stops a stray `<` swallowing it: in `a < b<br/>` the general pass would
 * otherwise read `< b<br/` as one tag and take the line break with it. Each pass here does
 * exactly what its regex did, one scan at a time instead of by backtracking.
 */
export function stripHtml(html: string): string {
  const withoutScripts = removeElements(removeElements(html, 'script'), 'style');

  return decodeAll(
    removeTags(
      withoutScripts.replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n').replace(/<br\s*\/?>/gi, '\n'),
    ),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * A script or style element and everything inside it, replaced by a space — INCLUDING when
 * its closing tag never arrives.
 *
 * This was exactly what `/<script[\s\S]*?<\/script>/gi` did, an opener with no closer after it
 * left in the text as it was found. So a page whose `<script>` was never closed put its
 * JAVASCRIPT SOURCE into the stored job description, and that is not a cosmetic leak: a string
 * inside one such script — `var gate = "Applicants must be U.S. citizens."` — was read by the
 * deterministic requirement pass as a citizenship rule the employer had stated, and hard-failed
 * a student who is not a citizen out of a posting nobody had closed to them. An unterminated
 * element now runs to the end of the input, which is what a browser does with one too: nothing
 * after it is content, and a description that comes back short is a posting the reader tells
 * the user it could barely read, which is the recoverable half of this trade.
 *
 * Malformed closers are the same failure arriving late. `</script >`, `</SCRIPT\n>` and
 * `</script/>` all end the element in a browser and none of them is the literal `</script>`
 * this used to search for, so each one leaked the whole rest of the page as well.
 *
 * THE OPENER'S PRECISION IS NOW LOAD-BEARING, where before an over-eager match only cost a
 * little extra furniture. The old prefix match had no tag boundary — `<scriptural>` opened a
 * script span — and against the rule above, one custom element named `<script-loader>` or
 * `<style-guide>` with no `</script>` behind it would have deleted the rest of the posting.
 * Both ends therefore require what an HTML parser requires: the name followed by whitespace,
 * `/` or `>`.
 *
 * Once no closer can be found ahead of one opener, none can be found ahead of any later one,
 * and the scan stops there. Without that, a body of repeated `<script` would scan to the end
 * of the string once per occurrence — the same quadratic cost arriving by a different road.
 */
function removeElements(html: string, name: string): string {
  const open = `<${name}`;
  const close = `</${name}`;
  const out: string[] = [];
  let at = 0;

  for (;;) {
    const start = findElement(html, open, at);
    if (start === -1) break;

    out.push(html.slice(at, start), ' ');

    const end = findElement(html, close, start + open.length);
    if (end === -1) return out.join('');

    // The closing tag runs to its own `>`, which is where a browser resumes reading content.
    // A closer with no `>` after it is another unterminated tag: the rest is not content.
    const shut = html.indexOf('>', end + close.length);
    if (shut === -1) return out.join('');
    at = shut + 1;
  }

  out.push(html.slice(at));
  return out.join('');
}

/**
 * What `/<[^>]+>/g` did: each `<` up to the first `>` after it, replaced by a space.
 *
 * `[^>]+` cannot cross a `>`, so the greedy match always ended at the FIRST one — which is
 * why this is an `indexOf` and not a search. Two cases have to be left alone to match it:
 * `<>`, which fails because `[^>]+` needs at least one character, and a `<` with no `>` after
 * it anywhere, which the regex never matched and left in the text as the literal character.
 */
function removeTags(html: string): string {
  const out: string[] = [];
  let at = 0;

  for (;;) {
    const open = html.indexOf('<', at);
    if (open === -1) break;

    const shut = html.indexOf('>', open + 1);
    if (shut === -1) break;

    if (shut === open + 1) {
      // `<>` is not a tag. Copy it and carry on from just after the `<`, exactly where the
      // regex engine would have resumed.
      out.push(html.slice(at, open + 1));
      at = open + 1;
      continue;
    }

    out.push(html.slice(at, open), ' ');
    at = shut + 1;
  }

  out.push(html.slice(at));
  return out.join('');
}

/**
 * Where a tag next appears, ignoring case, without copying the document to find out.
 *
 * `html.toLowerCase().indexOf(...)` is the obvious way and is two separate mistakes. It builds
 * a whole lowercase copy of the input on every call, which is the quadratic cost this rewrite
 * exists to remove, arriving by a third road. And lowercasing can change a string's length —
 * `'İ'.toLowerCase()` is two characters — so an index found in the copy can point somewhere
 * else in the original, which is a wrong answer rather than a slow one.
 *
 * `tag` is `<script` or `</script`, and what follows the name has to be something an HTML
 * parser accepts as the end of it. See `removeElements` for why that boundary is not optional.
 */
function findElement(html: string, tag: string, from: number): number {
  for (let at = html.indexOf('<', from); at !== -1; at = html.indexOf('<', at + 1)) {
    if (html.slice(at, at + tag.length).toLowerCase() !== tag) continue;
    if (endsTagName(html[at + tag.length])) return at;
  }
  return -1;
}

/**
 * What may follow a tag name — the five characters HTML counts as whitespace, the self-closing
 * slash, and the bracket. End of input is deliberately not one of them: `<script` with nothing
 * after it is the literal text a truncated page ended on, never an element that swallows the
 * rest of the document.
 */
function endsTagName(ch: string | undefined): boolean {
  return ch !== undefined && (ch === '>' || ch === '/' || /[ \t\n\f\r]/.test(ch));
}

/**
 * Whether a failed fetch is robots.txt refusing us, put into words for the student.
 *
 * Lives here rather than beside one adapter because three sources now need it: Remotive,
 * whose feed the host disallows, and the SmartRecruiters board adapter and company probe,
 * which read a host answering `User-agent: * / Disallow: /`. A second copy is how the two
 * would come to word the same refusal differently.
 *
 * politeFetch raises both robots outcomes as a 403 — the path is disallowed, or the file
 * could not be read and so nothing may be assumed — and a 403 the server itself sent is
 * also a 403, so the message is what separates them. Returning null for anything else lets
 * a real HTTP failure travel on to the runner's own error handling, which already reports
 * it; only the robots case needs saying differently, because "we chose not to ask" is not
 * the same story as "we asked and it broke".
 */
export function robotsRefusal(source: string, err: unknown): string | null {
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
