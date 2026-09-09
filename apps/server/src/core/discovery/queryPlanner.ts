/**
 * Query planning — docs/04 § Query planning.
 *
 * Turns the confirmed profile plus the active filters into a bounded, INSPECTABLE set of
 * discovery targets. The user sees and can edit the plan before a run, because a search
 * tool whose queries you can't see is one you can't reason about when it misses things.
 *
 * Role families come from the profile deterministically and are filtered against a
 * curated taxonomy, so a bad inference can't send forty queries for a role the user has
 * no evidence for.
 */
import { upcomingCycleYear, workLocations } from '@ia/shared';
import type { RoleFamily } from '@ia/shared';
import type { ConfirmedProfile, SearchFilters, Season, SourceKind } from '@ia/shared';
import { AGGREGATOR_SOURCES } from './sources/aggregators';
import { slugCandidates } from './resolveCompany';

export interface PlannedTarget {
  /**
   * Any source the runner can be pointed at. Written against the shared SourceKind rather
   * than the registries' key types, because the registries and this file are routinely
   * extended in separate changes; only the two kinds a PLAN must never carry are excluded.
   * `manual` is not a runnable target at all (a pasted address is the whole target), and
   * `web_search` is runnable but spends a model call — so only the Discover screen's
   * button, a deliberate press labelled with the cost, ever adds it. A plan chip would put
   * that spend into every future run silently.
   */
  source: Exclude<SourceKind, 'web_search' | 'manual'>;
  board: string;
  /** Why this target is in the plan — shown next to each chip in the UI. */
  reason: string;
}

export interface QueryPlan {
  targets: PlannedTarget[];
  keywords: string[];
  roleFamilies: string[];
  termTokens: string[];
  locations: string[];
  notes: string[];
}

/**
 * Curated taxonomy. A role family only enters the plan if the profile actually evidences
 * it — this is the guard against a plan full of roles the user never did.
 */
export const ROLE_TAXONOMY: Record<RoleFamily, string[]> = {
  // "engineer" is gone from this list: as a prefix stem it matched the word "Engineering"
  // inside science-FAIR names ("Sample Regional Science and Engineering Fair"), so a
  // debate-and-theatre student with a Behavioral Sciences award got software queries. The
  // terms that remain are ones only a software resume says — and "computer science" /
  // "usaco" / "algorithm" are what a competition-programming high schooler actually
  // prints, which used to evidence nothing at all.
  'software engineering': [
    'software',
    'developer',
    'programming',
    'backend',
    'frontend',
    'fullstack',
    'swe',
    'computer science',
    'usaco',
    'algorithm',
    'coding',
  ],
  'data science': ['data', 'analytics', 'statistics', 'pandas', 'sql', 'analysis'],
  'machine learning': [
    'machine learning',
    'ml',
    'ai',
    'deep learning',
    'pytorch',
    'tensorflow',
    'nlp',
  ],
  // "product" alone matched "photograph products" in an Etsy-shop bullet and handed a
  // sticker seller a product-management family, which then evicted the marketing family
  // their state-championship award had genuinely earned. Only the qualified form counts.
  'product management': ['product manag', 'roadmap', 'pm', 'stakeholder'],
  // "design" alone is one of the commonest resume VERBS in every domain — "Designed
  // weekly practice plans" gave a swim coach UX queries — and it sits inside school names
  // ("Design and Architecture Senior High") and theatre credits ("Lighting Designer").
  // A genuine UX resume says ux/ui/figma/wireframe or a qualified "«x» design".
  design: [
    'ux',
    'ui',
    'figma',
    'prototyp',
    'wireframe',
    'user experience',
    'user interface',
    'graphic design',
    'product design',
    'visual design',
  ],
  'hardware engineering': ['hardware', 'circuit', 'pcb', 'embedded', 'fpga', 'verilog'],
  // FIRST alone is four seasons of a student's life, and the word "robotics" appeared
  // nowhere in this table — so the resumes most likely to say it (team captains, mentors,
  // competition volunteers) inferred no family from it and none of their searches asked
  // for robotics internships, which is the one query they would have typed themselves.
  robotics: ['robotics', 'robot', 'mechatronics', 'ros', 'first robotics'],
  'mechanical engineering': ['mechanical', 'cad', 'solidworks', 'thermodynamic'],
  'electrical engineering': ['electrical', 'signal', 'power systems'],
  'civil engineering': ['civil', 'structural', 'geotechnical'],
  // "biolog" is a word-START stem, so it cannot see itself inside "microbiology" — a
  // Regeneron ISEF Finalist in Microbiology whose resume never prints the bare word
  // "Biology" inferred no biology family and the search they would have typed never ran.
  // The sub-disciplines are stems of their own.
  biology: [
    'biology',
    'biolog',
    'microbiolog',
    'neurobiolog',
    'biochem',
    'genom',
    'molecular',
    'lab',
  ],
  chemistry: ['chemistry', 'chemical', 'organic synthesis'],
  finance: ['finance', 'financial', 'accounting', 'investment', 'valuation', 'trading'],
  consulting: ['consulting', 'strategy', 'advisory'],
  // The four families below exist because their students inferred NOTHING: a hospital
  // volunteer with HOSA honors, a swim coach who tutors at two community centers, an
  // editor-in-chief with CSPA and NSPA awards, and a debate captain who volunteered in a
  // state representative's office each fell to the "no role family could be inferred"
  // note — so the one search each of them would have typed by hand never ran. Terms are
  // deliberately qualified against prose homonyms: bare "editor" is a text editor, bare
  // "patient" is a temperament, bare "policy" is a privacy policy, bare "debate" is
  // "debated tradeoffs" in an engineering bullet.
  healthcare: [
    'hospital',
    'clinical',
    'patient care',
    'patient transport',
    'pre-med',
    'premed',
    'nursing',
    'medical',
    'medicine',
    'hosa',
    'public health',
    'healthcare',
    'health care',
  ],
  education: [
    'tutor',
    'teaching',
    'taught',
    'teacher',
    'mentor',
    'coach',
    'camp counselor',
    'classroom',
    'curriculum',
    'youth',
  ],
  journalism: [
    'journalism',
    'journalist',
    'newspaper',
    'yearbook',
    'editor-in-chief',
    'editorial',
    'news writing',
    'student press',
    'copy editor',
    'section editor',
    'broadcast journalism',
    'quill and scroll',
    'cspa',
    'nspa',
  ],
  'public policy': [
    'public policy',
    'legislative',
    'legislature',
    'model united nations',
    'model un',
    'mun',
    'mock trial',
    'debate team',
    'debate club',
    'debate captain',
    'debate tournament',
    'debater',
    'speech and debate',
    'speech & debate',
    'lincoln-douglas',
    'student government',
    'political science',
    'government',
    'civic',
    'pre-law',
  ],
  marketing: ['marketing', 'brand', 'seo', 'content', 'growth'],
  operations: ['operations', 'supply chain', 'logistics'],
  research: ['research', 'publication', 'thesis', 'laboratory'],
};

/**
 * Every place a taxonomy term appears in the corpus, as [start, end) spans.
 *
 * A bare `corpus.includes(t)` is what this used to be, and the short terms made a mockery
 * of the curated list that is supposed to stop a bad inference from sending forty queries
 * for a role the user has no evidence for: "ml" is inside "html", "ai" inside "email",
 * "training" and "detail", "ui" inside "building", "lab" inside "collaborate", "pm"
 * inside "rpm". A resume mentioning HTML and email got machine-learning queries.
 *
 * Short terms (three characters or fewer) must be whole words — they are acronyms, and an
 * acronym embedded in a longer word is a different word. Longer terms need only start at
 * a word boundary, because several entries are deliberate stems: "biolog" is meant to
 * catch "biological", "prototyp" to catch "prototyping" — EXCEPT in `stems: false` text,
 * where an employer name that merely begins with a stem ("Brandeis" under the "brand" stem)
 * must not mint a family it has no other evidence for.
 */
function termSpans(corpus: string, term: string, stems: boolean): Array<[number, number]> {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = stems && term.length > 3 ? `\\b${escaped}` : `\\b${escaped}\\b`;
  const re = new RegExp(pattern, 'gi');
  const out: Array<[number, number]> = [];
  for (const m of corpus.matchAll(re)) out.push([m.index, m.index + m[0].length]);
  return out;
}

/**
 * How many DISTINCT pieces of evidence a family has in a corpus.
 *
 * Counting matched terms let one string stand for several: "FIRST Robotics" is hit by
 * "robotics", by the "robot" stem, and by "first robotics" all at once, so a single
 * water-handing volunteer line scored robotics 3 and evicted a family the resume genuinely
 * evidenced from the four-slot plan. Overlapping matches describe the same evidence, so they
 * are merged and counted once; two separate mentions in different parts of the corpus still
 * count as two.
 */
function evidenceCount(corpus: string, terms: string[], stems: boolean): number {
  const spans = terms.flatMap((t) => termSpans(corpus, t, stems)).sort((a, b) => a[0] - b[0]);
  let count = 0;
  let lastEnd = -1;
  for (const [start, end] of spans) {
    if (start >= lastEnd) {
      count++;
      lastEnd = end;
    } else if (end > lastEnd) {
      lastEnd = end;
    }
  }
  return count;
}

/**
 * Idioms that borrow a taxonomy stem without being its evidence, scrubbed before matching
 * rather than by narrowing the stem, because the genuine uses must keep counting:
 *
 *   - "robots.txt" is an SEO artefact and "robotic process automation" an ops one — the
 *     "robot" stem matched both, and a marketing resume was handed robotics queries;
 *   - "tutorial(s)" starts with the "tutor" stem, so following a React tutorial would
 *     read as teaching experience;
 *   - "self-taught" and "taught/teaching myself" describe learning, not teaching; being
 *     "mentored by" someone is receiving mentorship, not giving it. Each would mint an
 *     education family for a resume with no teaching in it;
 *   - a clock time is not a job title. "PM" is the product-management acronym and is only
 *     two letters, so it matches as a whole word — and the first resume any of this is
 *     built for says "Worked 4 to 9 PM shifts on weekends", which handed a cashier a
 *     product-management search plan. Hourly students write their hours down; this has to
 *     read them as hours.
 */
function scrubFalseSignals(corpus: string): string {
  return corpus
    .replace(/\brobots\.txt\b/gi, ' ')
    .replace(/\brobotic process automation\b/gi, ' ')
    .replace(/\btutorials?\b/gi, ' ')
    .replace(/\bself-taught\b/gi, ' ')
    .replace(/\b(?:taught|teaching)\s+myself\b/gi, ' ')
    .replace(/\bmentored by\b/gi, ' ')
    .replace(/\b\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?(?!\w)/gi, ' ')
    .replace(/\b[ap]\.?m\.?\s+(?=shift|slot|hours|block|rush|closing|opening)/gi, ' ');
}

export function inferRoleFamilies(profile: ConfirmedProfile): string[] {
  // Titles, bullets, projects and coursework are where a stem is meant to reach ("biolog" ->
  // "biological"), so they carry stems.
  const stemCorpus = scrubFalseSignals(
    [
      ...profile.skills.map((s) => s.name),
      ...profile.experience.map((e) => `${e.title} ${e.bullets.join(' ')}`),
      ...profile.projects.map((p) => `${p.name} ${p.description}`),
      ...profile.education.flatMap((e) => [
        e.fieldOfStudy ?? '',
        ...(e.coursework ?? []),
        ...(e.honors ?? []),
      ]),
    ]
      .join(' ')
      .toLowerCase(),
  );

  // Organisation names are evidence too — a robotics club is stated in the org, not the
  // bullets — but only as whole words. Under a prefix stem "Brandeis University" scored the
  // "brand" (marketing) term and a dining-services campus job minted marketing queries; a
  // whole-word match still reads "Sample Robotics" as robotics without inventing the rest.
  let orgCorpus = scrubFalseSignals(
    profile.experience
      .map((e) => e.organization ?? '')
      .join(' ')
      .toLowerCase(),
  );

  // A school's NAME is identity, not role evidence. Young resumes write clubs as
  // "Student Ambassador, Design and Architecture Senior High", and the school name's own
  // words minted a design family with zero design work behind it. The institution field is
  // already kept out of the corpus; it gets the same treatment when it reappears inside an
  // experience organisation, while the rest of that org line ("Speech & Debate Team",
  // written after the school's name) keeps counting.
  for (const e of profile.education) {
    const inst = e.institution?.toLowerCase().trim();
    if (inst && inst.length > 3) orgCorpus = orgCorpus.split(inst).join(' ');
  }

  const scored = Object.entries(ROLE_TAXONOMY)
    .map(([family, terms]) => ({
      family,
      hits: evidenceCount(stemCorpus, terms, true) + evidenceCount(orgCorpus, terms, false),
    }))
    .filter((s) => s.hits > 0)
    .sort((a, b) => b.hits - a.hits);

  return scored.slice(0, 4).map((s) => s.family);
}

const SUMMER_START_MONTH = 5; // June

/**
 * The month each season's term begins, as the UTC month index a Date reports.
 *
 * Two things read it: which YEAR a search means when it names a season and no year, and
 * whether the year it WAS given has already come and gone. Written as a total Record so
 * that a season added to the enum is a compile error here rather than a season that
 * silently inherits the summer calendar.
 *
 * `year_round` and `flexible` are null on purpose: they name no window, so there is no
 * month at which one of them has "started" and nothing to roll over.
 */
const SEASON_START_MONTH: Record<Season, number | null> = {
  summer: SUMMER_START_MONTH,
  fall: 8, // September
  winter: 11, // December
  spring: 0, // January
  year_round: null,
  flexible: null,
};

/**
 * The cycle a search means when it names a season but no year: the next occurrence whose
 * applications are still plausibly open.
 *
 * This used to be `new Date().getUTCFullYear() + 1`, which is wrong for half of every year
 * and in the direction that hides jobs: on 15 January 2027 it asked for "summer 2028
 * internship", a cycle whose postings do not exist yet, while summer 2027 — still open,
 * still being applied to that week — went unsearched. Summer hiring runs roughly the
 * preceding autumn through spring, so the cycle only turns over once the term itself has
 * begun: before 1 June 2027 the answer is 2027, from 1 June 2027 it is 2028.
 *
 * The rollover is the term's start rather than the month applications typically close
 * (February for most large programs) because the two mistakes are not symmetric. Rolling
 * over early searches a cycle nobody has posted for yet and finds nothing; rolling over at
 * the start of the term keeps late and rolling postings — exactly the ones a student
 * searching in April still has a shot at — inside the search.
 *
 * The clock is a parameter because a default that drifts with the calendar cannot be
 * tested by a suite that pins dates, and an untestable date rule is how the year 2027 came
 * to be written down as a constant in the first place.
 */
/**
 * Re-exported from `@ia/shared`, where it now lives, so the tests and callers that import it
 * from here keep working.
 *
 * It moved because `DEFAULT_FILTERS` needs it too: the term filter's year default was the
 * literal `[2027]`, so a planner that derived the cycle from the clock still received 2027
 * from the filters and used it — the fix was real and unreachable on the default path. A
 * second copy in shared would have been the drift this file's own SEASON_START_MONTH comment
 * warns about, so there is one.
 */
export { upcomingCycleYear };

/** Whether that season of that year has already started, and so stopped taking applications. */
function seasonHasBegun(season: Season, year: number, now: Date): boolean {
  const startMonth = SEASON_START_MONTH[season];
  if (startMonth === null) return false;
  const thisYear = now.getUTCFullYear();
  return thisYear > year || (thisYear === year && now.getUTCMonth() >= startMonth);
}

/**
 * "summer 2027 internship", "2027 summer analyst", … — from the filters, and when the
 * filters name no year, from the clock rather than from a year somebody typed once.
 */
export function termTokens(filters: SearchFilters, now: Date = new Date()): string[] {
  const seasons: Season[] = filters.term.seasons.length ? filters.term.seasons : ['summer'];
  const types = filters.positionTypes.length ? filters.positionTypes : ['internship'];

  const out: string[] = [];
  for (const s of seasons) {
    // Per season, because "fall" with no year does not mean the same year "winter" does:
    // in September 2027 that autumn has already started, so the open fall cycle is fall
    // 2028 — while winter 2027, which begins in December, is still open and still the
    // winter a search made that month means.
    const years = filters.term.years.length ? filters.term.years : [upcomingCycleYear(s, now)];
    for (const y of years) {
      for (const t of types.slice(0, 3)) {
        out.push(`${s.replace('_', ' ')} ${String(y)} ${t.replace('_', '-')}`);
      }
    }
  }
  return [...new Set(out)];
}

/**
 * The vendors a pinned company's slug is guessed on: exactly those whose board address IS
 * a slug. Workday is deliberately absent, and it is not an oversight to fix — a Workday
 * board is addressed by (tenant, host, site) and the site name is chosen freely by the
 * company, so there is no address to build from a name. A "guessed" Workday target would
 * be a blind walk over hosts and site names inside a discovery run, which is the crawl the
 * bounded probe in resolveCompany exists to avoid. A Workday target enters the plan only
 * through an actual resolution, which arrives here in `knownBoards` because
 * `routes/discovery.ts` writes each resolution down as a `source` row. It did not for a
 * while: `ensureSource` fires once per persisted posting inside a run, so nothing built a
 * row from a resolution, and this sentence described a route into the plan that no Workday
 * board could take.
 *
 * SmartRecruiters is absent for a different reason, and the same one that keeps Remotive out
 * of the default plan (see § Sourcing policy): `api.smartrecruiters.com` answers
 * `User-agent: * / Disallow: /`, the adapter honours that, and a guessed target there can
 * therefore only ever come back refused. Planning it would put "This search was not complete"
 * on every run that pins any company, about a source that cannot contribute until the site
 * changes its mind — and a standing refusal is not a coverage gap anyone can act on, it is
 * noise that teaches the user to stop reading the warnings that matter. The adapter stays,
 * as honest as ever, for anyone who adds the board by hand.
 */
const GUESSABLE_VENDORS = ['greenhouse', 'lever', 'ashby', 'workable'] as const;

/** How the reason strings spell each vendor, since the kind is a lowercase identifier. */
const VENDOR_NAMES: Partial<Record<PlannedTarget['source'], string>> = {
  greenhouse: 'Greenhouse',
  lever: 'Lever',
  ashby: 'Ashby',
  smartrecruiters: 'SmartRecruiters',
  workable: 'Workable',
  workday: 'Workday',
};

/** One target per `source:board`, keeping the first reason given for it. */
function dedupeTargets(targets: PlannedTarget[]): PlannedTarget[] {
  const seen = new Set<string>();
  return targets.filter((t) => {
    const key = `${t.source}:${t.board}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function planQueries(
  profile: ConfirmedProfile,
  filters: SearchFilters,
  knownBoards: PlannedTarget[] = [],
  opts: { maxTargets?: number; now?: Date } = {},
): QueryPlan {
  const notes: string[] = [];
  // Injected, like refresh.ts and matching/run.ts: the term tokens are dated, and a plan
  // whose dates come from the wall clock cannot be pinned by a test.
  const now = opts.now ?? new Date();

  /**
   * What the user SAID, or failing that what the resume suggests. Said wins outright.
   *
   * The inference used to be unconditional and the filter was merely added to it, so a family
   * read off a resume could not be removed by any means the interface offered — a student
   * whose resume mentions one coding class got software-engineering queries forever, and the
   * only note on the subject told them to "set role families in the filters", which is the
   * thing that did not work. An explicit answer to "what are you looking for" is better
   * evidence than anything read off a resume.
   *
   * A per-request filter still wins over the stored preference, because it is the more recent
   * and more specific statement of the same intent.
   */
  const chosen = filters.role.roleFamilies.length
    ? filters.role.roleFamilies
    : profile.preferences.roleFamilies;
  const inferred = chosen.length > 0 ? [] : inferRoleFamilies(profile);
  const roleFamilies = chosen.length > 0 ? chosen : inferred;

  if (chosen.length > 0) {
    notes.push(
      `Searching for the ${chosen.length === 1 ? 'role family you chose' : `${chosen.length} role families you chose`}: ` +
        `${chosen.join(', ')}. Your resume was not consulted for this — change it on your profile.`,
    );
  } else if (roleFamilies.length === 0) {
    notes.push(
      'No role family could be inferred from your profile, so keyword search will be broad. ' +
        'Add skills or projects, or choose what you are looking for on your profile.',
    );
  }

  const locations = [
    ...(filters.location.cities.length
      ? filters.location.cities
      : // Every place the user can work from seeds the keyword search, not only the home
        // address — a student based at home and at school wants both cities searched.
        workLocations(profile.locationPrefs).map((b) => b.city)),
    ...profile.locationPrefs.relocateTo,
    ...(profile.locationPrefs.remoteOk ? ['remote'] : []),
  ].filter(Boolean);

  // `filters.role.roleFamilies` is not listed again: it is already `roleFamilies` above when
  // it was set, and adding it a second time put every chosen family into the keyword list twice.
  const keywords = [...roleFamilies, ...filters.role.titleIncludes].filter(Boolean);

  /**
   * Company targets the user pinned.
   *
   * A pinned name used to become exactly one Greenhouse target whose board was the name
   * with every non-alphanumeric character deleted. A company on Lever or Ashby, or one
   * whose Greenhouse token is hyphenated, produced a target that 404s — and the user, who
   * had explicitly asked for that company, got nothing back and no explanation.
   *
   * A board already resolved for that company is used as-is; otherwise the first slug
   * candidate is tried across the five vendors whose board address is just a slug, and a
   * note says the guess was unverified so the resolve endpoint can be pointed at it.
   */
  const pinned: PlannedTarget[] = [];
  const promoted = new Set<PlannedTarget>();
  for (const c of filters.company.onlyCompanies) {
    const slugs = slugCandidates(c);
    const already = knownBoards.filter((b) => {
      // A Workday board is addressed "tenant@host/site", so the company it belongs to is
      // the tenant before the "@", not the whole address — without this split, a pinned
      // company whose Workday board HAD been resolved fell through to the guess branch
      // and the one vendor that cannot be guessed was the one that needed the promotion.
      // Every other vendor's board has no "@" and passes through the split unchanged.
      const tenant = b.board.toLowerCase().split('@')[0] ?? '';
      return slugs.includes(tenant);
    });
    if (already.length > 0) {
      for (const b of already) promoted.add(b);
      // The reason names the vendor, because the chip is a promise about where the run
      // will look and "company you pinned" alone left the user unable to tell a resolved
      // Lever board from a guess three chips over.
      pinned.push(
        ...already.map((b) => ({
          ...b,
          reason: `company you pinned (its ${VENDOR_NAMES[b.source] ?? b.source} board)`,
        })),
      );
      continue;
    }
    /**
     * A name a board slug cannot be guessed from is said so, not guessed at anyway.
     *
     * `slugCandidates` strips everything outside [a-z0-9], so a name written in a non-Latin
     * script — "삼성電子", "字节跳动" — or one that is nothing but a stripped company suffix
     * ("Co.") leaves it with no candidates at all. `slugs[0]!` was then `undefined`, the
     * non-null assertion hid it from the type checker, and `board: undefined` was dropped
     * outright by JSON.stringify on the way out — so the plan answered with targets that
     * had no `board` key despite PlannedTarget promising a string, and the first thing on
     * the client to call `.trim()` on it threw during render. The app has no error
     * boundary, so the screen went blank and stayed blank until a reload.
     */
    const slug = slugs[0];
    if (slug === undefined) {
      notes.push(
        `"${c}" has no resolved board, and a board name cannot be guessed from it — the ` +
          'vendors take names written in the Latin alphabet. Find its board on the Discover ' +
          'screen, or paste one of its job URLs directly.',
      );
      continue;
    }
    for (const source of GUESSABLE_VENDORS) {
      pinned.push({
        source,
        board: slug,
        reason: `company you pinned (board "${slug}" unverified, guessed on ${VENDOR_NAMES[source] ?? source})`,
      });
    }
    notes.push(
      `"${c}" has no resolved board yet, so its name was guessed as "${slug}" on ` +
        'Greenhouse, Lever, Ashby and Workable. A Workday board cannot be guessed from a ' +
        'name, so if this company hires through Workday, resolve it in Discover to find the ' +
        'right board. SmartRecruiters is not guessed at all: it asks automated clients to ' +
        'stay off its API and this tool does what it asks, so if this company hires there, ' +
        'open its board yourself and paste a job URL.',
    );
  }

  /**
   * The sources that need no board and no key, planned by default.
   *
   * The community list came first, and it was the cold start: targets used to come only
   * from pinned companies and from boards a PREVIOUS run had already resolved, so a fresh
   * install planned nothing, and the note it printed sent the user to look for companies
   * and paste URLs without mentioning the one source that is a single click and covers
   * more postings than everything else here combined. It only ever healed after a run that
   * this plan could not have produced. Arbeitnow and Remotive sit under the same policy —
   * keyless, no company needed — so they are planned by default for the same reason, not
   * under a new one.
   *
   * An empty board reads the whole source: the list for the upcoming season, the feeds by
   * keyword (aggregators.ts). A source already resolved as a source row is not planned
   * twice, because it arrives in `knownBoards` and would otherwise be fetched once per
   * copy. And each entry is planned only when the runner actually has its adapter — a plan
   * that names a source the run endpoint would reject is a plan that cannot be run as
   * shown, which defeats the point of showing it.
   */
  const KEYLESS_DEFAULTS: ReadonlyArray<{ source: PlannedTarget['source']; reason: string }> = [
    {
      source: 'github_list',
      reason: 'the community internship list — no company or key needed',
    },
    {
      source: 'arbeitnow',
      reason: 'the Arbeitnow public job feed, keyless and searched without a company',
    },
    /**
     * Remotive is deliberately NOT here, and the reason is its own robots.txt: the host asks
     * automated clients to stay off the API path, the adapter honours that and reports the
     * refusal — so planning it by default put a permanent "this search was not complete"
     * warning on every run the user took the plan for, about a source that can never
     * contribute until the site changes its mind. A standing refusal is not a coverage gap
     * the user can act on; it is noise that teaches them to stop reading the warnings that
     * matter. The adapter stays, honest as ever, for anyone who adds the source by hand.
     */
  ];
  const keylessSources = new Set<PlannedTarget['source']>(KEYLESS_DEFAULTS.map((d) => d.source));
  const community: PlannedTarget[] = KEYLESS_DEFAULTS.filter(
    (d) => d.source in AGGREGATOR_SOURCES && !knownBoards.some((b) => b.source === d.source),
  ).map((d) => ({ source: d.source, board: '', reason: d.reason }));

  // Pinned targets survive truncation, because the comment above is a promise: the user
  // asked for those by name. Slicing the concatenated list dropped them silently once the
  // pinned list alone exceeded the cap. The community list survives for the same reason:
  // dropping the only target a new user has is dropping the whole plan.
  const max = opts.maxTargets ?? 40;
  // A board promoted into the pinned list is not searched twice.
  const rest = knownBoards.filter((b) => !promoted.has(b));
  /**
   * A keyless default that a run has already turned into a `source` row is still a keyless
   * default, and survives the cap as one.
   *
   * The list above only builds a target for a keyless source that is NOT yet in
   * knownBoards, so that a source is not planned twice. Once a run had created its row it
   * arrived as an ordinary known board instead, fell into the capped remainder, and eight
   * pinned companies were enough to cut all three: the community list, the
   * highest-coverage source in the product, silently left the plan the moment the user had
   * both used it once and pinned eight companies. It survived the case with no pinned
   * companies only by ordering luck, because the source table happened to list those rows
   * before the company boards.
   */
  const keylessKnown = rest.filter((b) => keylessSources.has(b.source));
  const capped = rest.filter((b) => !keylessSources.has(b.source));
  const kept = [...community, ...keylessKnown, ...pinned];
  const room = Math.max(0, max - kept.length);
  /**
   * One target per board, whatever put it there.
   *
   * Two spellings of one company — "Stripe" and "Stripe Inc" — are two different strings to
   * `onlyCompanies` and one slug to `slugCandidates`, so each produced its own greenhouse,
   * lever and ashby target. A duplicated target is fetched twice, counted twice in `found`,
   * and filed as a duplicate of itself; on the Discover screen the two chips also collided
   * on their React key.
   */
  const targets = dedupeTargets([...kept, ...capped.slice(0, room)]);
  const dropped = capped.length - room;

  if (dropped > 0) {
    /**
     * Names the cap and what fell outside it, not the final size.
     *
     * It used to interpolate `targets.length`, which is the number AFTER the exempt targets
     * are added back — so beside the over-cap note below the pair read as a contradiction:
     * "Plan truncated to 53 targets" on one line and "53 targets, more than the usual cap of
     * 40" on the next. Both were true and together they were nonsense.
     */
    notes.push(
      `${String(dropped)} targets did not fit the cap of ${String(max)} and were dropped. ` +
        'Raise the cap or narrow the filters.',
    );
  }
  // And the other side of the same cap, which nothing said at all: what survives it is
  // exempt from it, so pinning ten companies plans fifty-three targets against a stated cap
  // of forty. Every one of those is a request the user did not ask for by number, and a
  // plan that quietly ignores its own documented bound is not the inspectable plan this
  // file promises.
  if (targets.length > max) {
    notes.push(
      `This plan has ${targets.length} targets, more than the usual cap of ${max}. Companies ` +
        'you pinned and the sources that need no board are never dropped, so the cap gave ' +
        'way to them. Pin fewer companies to bring it down.',
    );
  }
  if (targets.length === 0) {
    notes.push(
      'No company boards resolved yet. Add companies in Discover, or paste a job URL directly.',
    );
  }

  /**
   * A plan aimed at a season that has already started, said out loud.
   *
   * The year in the term filter is a stated number, and `DEFAULT_FILTERS` states 2027 —
   * so from June 2027 every default plan asks for "summer 2027 internship", a season whose
   * postings closed months earlier, and the run comes back with nothing. The failure has no
   * symptom: zero results from a closed cycle look exactly like zero results from a thin
   * week. The planner will not silently rewrite a year the caller asked for — the plan is
   * meant to be inspectable, and a filter that quietly means something else is the opposite
   * of that — but it must not let the user read the silence as "there is nothing out there".
   *
   * It fires only when EVERY season/year pair in the filter has begun. A search for
   * "summer 2027, winter 2027" made in August 2027 still has winter genuinely open, and
   * telling that user their cycle has closed would be its own false alarm.
   */
  const seasons: Season[] = filters.term.seasons.length ? filters.term.seasons : ['summer'];
  const askedYears = filters.term.years;
  if (
    askedYears.length > 0 &&
    seasons.every((s) => askedYears.every((y) => seasonHasBegun(s, y, now)))
  ) {
    const asked = seasons.flatMap((s) =>
      askedYears.map((y) => `${s.replace('_', ' ')} ${String(y)}`),
    );
    const open = [
      ...new Set(seasons.map((s) => `${s.replace('_', ' ')} ${String(upcomingCycleYear(s, now))}`)),
    ];
    notes.push(
      `Every term this plan searches has already begun: ${asked.join(', ')}. Applications ` +
        'close before a season starts, so a run of this plan will find little or nothing — ' +
        `the cycle now open is ${open.join(', ')}. If you did not ask for that year ` +
        'yourself it came from the term.years default, which is a written-down number ' +
        'rather than one read off the clock; send term.years with the plan request to ' +
        'search the open cycle.',
    );
  }

  return {
    targets,
    keywords: [...new Set(keywords)],
    roleFamilies,
    termTokens: termTokens(filters, now),
    locations: [...new Set(locations)],
    notes,
  };
}
