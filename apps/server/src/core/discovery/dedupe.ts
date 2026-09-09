/**
 * Three-stage dedupe — docs/04 § Dedupe. Cheapest test first.
 *
 * Duplicates are MERGED, not dropped: the surviving posting keeps every source that saw
 * it, so the UI can say "found on Greenhouse and Adzuna" and a source going dark doesn't
 * silently lose postings. It keeps every place they named too — see `merge` — because the
 * merge is between two sightings of one job, and neither of them is the whole of it.
 */
import { fingerprintTitle, normalizeCompany, normalizeTitle } from './normalize';
import type { NormalizedPosting } from './sources/types';

/**
 * The stage-2 key, built from the CAUTIOUS title form.
 *
 * Stage 2 merges on this alone, with no different-source guard, so every token the title
 * normaliser throws away costs the user a posting outright — "Machine Learning Intern I"
 * and "Machine Learning Intern II" collapsed onto one row, and one of two real openings
 * simply never appeared in the queue. `normalizeTitle` is deliberately aggressive because
 * stage 3 wants it that way, and stage 3 can afford it: it merges only across different
 * sources. This key cannot, so it uses `fingerprintTitle`, which keeps anything that could
 * distinguish two requisitions.
 *
 * Erring this way costs almost nothing. The worst case is a duplicate the user can see and
 * ignore; the other direction hides a job they will never know existed.
 */
export function fingerprint(p: {
  company: string;
  title: string;
  locations: Array<{ city?: string }>;
}): string {
  const loc = p.locations[0]?.city?.toLowerCase().trim() ?? '';
  return [normalizeCompany(p.company), fingerprintTitle(p.title), loc].join('|');
}

export interface Deduped {
  posting: NormalizedPosting;
  sources: string[];
  /** Which stage caught each merge, for the run summary. */
  mergedBy: Array<'url' | 'fingerprint' | 'title'>;
}

/**
 * Stage-3 title matching.
 *
 * This began as character-trigram Jaccard similarity, which does not work here.
 * Measured against real pairs:
 *
 *   0.767  "Software Engineer Intern"  vs  "Software Engineering Intern"        ← same job
 *   0.758  "Software Engineer Intern"  vs  "Software Engineer Intern, Backend"  ← DIFFERENT job
 *   0.613  "Software Engineer Intern"  vs  "Hardware Engineer Intern"           ← DIFFERENT job
 *   0.600  "Frontend Engineer Intern"  vs  "Backend Engineer Intern"            ← DIFFERENT job
 *
 * The pair that must merge and the pair that must not sit 0.009 apart, so no threshold
 * separates them. Character overlap is the wrong signal: what distinguishes these titles
 * is whether one carries a *discriminating token* (backend, hardware, design) the other
 * lacks — not how many characters they share.
 *
 * So: merge only when the stemmed, stopword-stripped token SETS are equal. That catches
 * engineer/engineering and refuses every pair above that shouldn't merge. It errs toward
 * not merging, which is the safe direction — a visible duplicate is a minor annoyance,
 * a silently hidden posting is the worst failure mode this tool has.
 */
const TITLE_STOPWORDS = new Set(['the', 'a', 'an', 'of', 'for', 'and', 'to', 'in', 'at']);

/** Deliberately crude — enough for engineer/engineering, not a linguistic stemmer. */
function stem(token: string): string {
  if (token.length > 5 && token.endsWith('ing')) return token.slice(0, -3);
  if (token.length > 4 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  return token;
}

export function titleTokens(title: string): Set<string> {
  return new Set(
    normalizeTitle(title)
      .split(' ')
      .filter((t) => t && !TITLE_STOPWORDS.has(t))
      .map(stem),
  );
}

export function titlesMatch(a: string, b: string): boolean {
  const ta = titleTokens(a);
  const tb = titleTokens(b);
  if (ta.size === 0 || tb.size === 0) return false;
  if (ta.size !== tb.size) return false;
  for (const t of ta) if (!tb.has(t)) return false;
  return true;
}

type Place = NormalizedPosting['locations'][number];

/** Place names as the boards print them — "Boston", "boston ", "Boston/Cambridge" — reduced
 *  enough that two spellings of one office compare equal. */
function placeToken(value: string | undefined): string {
  return (value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Two values that are both stated and different. A stated value against nothing is not a
 *  disagreement — most boards give a city and no country at all. */
function contradicts(a: string | undefined, b: string | undefined): boolean {
  const x = placeToken(a);
  const y = placeToken(b);
  return x !== '' && y !== '' && x !== y;
}

function samePlace(a: Place, b: Place): boolean {
  const city = placeToken(a.city);
  if (city === '' || city !== placeToken(b.city)) return false;
  // Region and country can only ever BREAK a city match, never make one: "Cambridge, MA" and
  // "Cambridge, GB" are the same word and different continents, while "Cambridge, MA" and a
  // bare "Cambridge" are one office written twice.
  return !contradicts(a.region, b.region) && !contradicts(a.country, b.country);
}

/**
 * Whether two sightings could be the same opening, as far as WHERE they say it is.
 *
 * Stage 3 matched on company + title tokens + a different source and ignored the city
 * outright — and a company running one internship programme posts the SAME title in every
 * office it runs it in. "Software Engineer Intern" in Austin off the company board and
 * "Software Engineering Intern" in Seattle off an aggregator are two requisitions with two
 * apply URLs, and stage 3 folded them onto one row: the survivor kept Austin, the Seattle
 * sighting's location and apply URL went in the bin, and a student in Seattle was shown a job
 * in Texas instead of the one down the road. Stage 2 cannot catch this — its key already
 * contains the city, so the two never meet there — which leaves this the only place the
 * distinction can be kept.
 *
 * Deliberately weak in one direction, because that is what stage 3 is FOR: a sighting that
 * names no city contradicts nothing, so it still merges. That is the ordinary aggregator
 * case — the community list and Adzuna routinely carry no location for a job a company board
 * places precisely, and a remote-only listing names no city by definition — and refusing
 * those would leave behind the duplicate this stage exists to remove. Two sightings that both
 * name a place have to agree on one of them.
 */
export function locationsCouldMatch(a: Place[], b: Place[]): boolean {
  const named = (places: Place[]): Place[] => places.filter((l) => placeToken(l.city) !== '');
  const [left, right] = [named(a), named(b)];
  if (left.length === 0 || right.length === 0) return true;
  return left.some((x) => right.some((y) => samePlace(x, y)));
}

/** Identity of one location row, so the union below does not stack "Boston" on "Boston". */
function placeKey(l: Place): string {
  return [placeToken(l.city), placeToken(l.region), placeToken(l.country), l.remote].join('|');
}

export function dedupe(incoming: Array<{ posting: NormalizedPosting; source: string }>): {
  unique: Deduped[];
  duplicates: number;
  notes: string[];
} {
  const byUrl = new Map<string, Deduped>();
  const byFingerprint = new Map<string, Deduped>();
  const notes: string[] = [];
  let duplicates = 0;

  for (const { posting, source } of incoming) {
    // Stage 1 — canonical URL.
    const existingByUrl = byUrl.get(posting.canonicalUrl);
    if (existingByUrl) {
      merge(existingByUrl, posting, source, 'url');
      duplicates++;
      continue;
    }

    // Stage 2 — company + normalized title + primary location.
    const fp = fingerprint(posting);
    const existingByFp = byFingerprint.get(fp);
    if (existingByFp) {
      merge(existingByFp, posting, source, 'fingerprint');
      duplicates++;
      continue;
    }

    // Stage 3 — same company, same role, different wording, a location neither sighting
    // contradicts, and crucially a DIFFERENT source. Two similar titles from one source are
    // almost always distinct requisitions, and merging them would hide one.
    let matched: Deduped | undefined;
    for (const candidate of byFingerprint.values()) {
      if (normalizeCompany(candidate.posting.company) !== normalizeCompany(posting.company)) {
        continue;
      }
      if (candidate.sources.includes(source)) continue;
      // Two named, different cities are two openings, whatever the titles say. See
      // `locationsCouldMatch`: this used to read "different location OR wording", and the
      // location half of that is what cost a student the posting in their own city.
      if (!locationsCouldMatch(candidate.posting.locations, posting.locations)) continue;
      if (titlesMatch(candidate.posting.title, posting.title)) {
        matched = candidate;
        break;
      }
    }
    if (matched) {
      merge(matched, posting, source, 'title');
      duplicates++;
      continue;
    }

    const entry: Deduped = { posting, sources: [source], mergedBy: [] };
    byUrl.set(posting.canonicalUrl, entry);
    byFingerprint.set(fp, entry);
  }

  if (duplicates > 0) notes.push(`merged ${duplicates} duplicate posting(s) across sources`);

  return { unique: [...byFingerprint.values()], duplicates, notes };
}

/**
 * A merge keeps every place either sighting named, not just the survivor's.
 *
 * The surviving row used to carry only its own `locations`, so a merge silently threw away
 * wherever the other source said the job was — and the sharp end of that is a hard ineligible,
 * not a cosmetic loss. The `location` rule in eligibility fails a posting outright when every
 * location it has is remote with no city and the user has remote turned off. A Greenhouse
 * sighting listing `[{remote: true}]` merged with an aggregator sighting naming Boston kept
 * the remote-only list, so a student who does not want a remote internship was told "This
 * posting is remote and you have remote turned off" about a job with an office in their own
 * city. The mirror case loses `Offered remote, which you accept`, and the ordinary case just
 * loses the city the queue sorts and explains itself by.
 *
 * APPENDED, never prepended, and that ordering is load-bearing: `fingerprint` above keys on
 * `locations[0].city`, persistence matches stored rows on that same key across runs and
 * rewrites the column from it on every sighting, so re-ordering here would move the row out
 * from under the key that found it.
 *
 * The apply URL is deliberately NOT merged. It has to stay consistent with the canonical URL
 * the row is stored under — pairing a Greenhouse row with an aggregator's apply link would
 * send the student somewhere the row does not claim to come from — and the case where the
 * discarded apply URL actually mattered was a second city's posting being swallowed whole,
 * which stage 3 no longer does.
 */
function merge(
  entry: Deduped,
  incoming: NormalizedPosting,
  source: string,
  by: Deduped['mergedBy'][number],
): void {
  if (!entry.sources.includes(source)) entry.sources.push(source);
  entry.mergedBy.push(by);

  const seen = new Set(entry.posting.locations.map(placeKey));
  const added = incoming.locations.filter((l) => {
    const key = placeKey(l);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  // A copy rather than a push: these postings belong to the caller, and a source that hands
  // the same object to two runs must not find its locations growing underneath it.
  if (added.length > 0) {
    entry.posting = { ...entry.posting, locations: [...entry.posting.locations, ...added] };
  }
}
