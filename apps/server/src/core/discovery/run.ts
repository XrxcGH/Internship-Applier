/**
 * Discovery orchestration — docs/04 § Pipeline.
 *
 * Every run produces a summary the UI shows: per source, what was fetched, what was new,
 * what was merged, and what failed. Silent truncation would read as "we searched
 * everywhere" when we didn't, which is the failure mode that makes an automated search
 * tool untrustworthy — so degradation is always reported.
 */
import { and, desc, eq, or, sql } from 'drizzle-orm';
import { ulid } from 'ulid';
import { db, schema } from '../../infra/db/client';
import { logger } from '../../infra/logger';
import { publish } from '../../infra/events';
import { HttpError } from '../../infra/http/fetcher';
import { ATS_SOURCES } from './sources/ats';
import { AGGREGATOR_SOURCES } from './sources/aggregators';
import { webSearch } from './sources/webSearch';
import { dedupe } from './dedupe';
import { refreshPostings } from './refresh';
import { fingerprint } from './dedupe';
import type { JobSource, NormalizedPosting } from './sources/types';

/** Every source the runner knows about, keyless and keyed alike. */
export const ALL_SOURCES: Record<string, JobSource> = {
  ...ATS_SOURCES,
  ...AGGREGATOR_SOURCES,
  web_search: webSearch,
};

export type SourceName = keyof typeof ALL_SOURCES;

export interface DiscoveryTarget {
  source: string;
  /** Board slug for ATS sources; a repo for github_list; unused for aggregators. */
  board: string;
  keywords?: string[];
  location?: string;
}

export interface SourceReport {
  source: string;
  board: string;
  found: number;
  new: number;
  errors: string[];
  notes: string[];
  degraded: boolean;
}

export interface RunSummary {
  runId: string;
  startedAt: string;
  finishedAt: string;
  targets: number;
  found: number;
  new: number;
  duplicates: number;
  /** Stored postings a source said outright have closed, and which this run shut. */
  closed: number;
  bySource: SourceReport[];
  /** Populated whenever coverage was reduced. Never left implicit. */
  skipped: string[];
}

export async function runDiscovery(
  targets: DiscoveryTarget[],
  opts: { concurrency?: number } = {},
): Promise<RunSummary> {
  const runId = ulid();
  const startedAt = new Date().toISOString();

  /**
   * THE ONLY THING THAT EVER RUNS THE FRESHNESS PASS.
   *
   * `refreshPostings` is wired to two routes and docs/04 § Freshness says on-demand is the
   * design — "there is no timer, cron entry or job runner anywhere in the repo", deliberately.
   * What nothing noticed is that no CALLER exists either: apps/web has no client for either
   * route, so a user of the interface could never trigger one and a posting that closed months
   * ago stayed `is_open = 1` and kept passing the `posting_open` rule for ever. Only somebody
   * driving the API by hand could clear it.
   *
   * A discovery run is the right moment: the student is already waiting, and stages 1 and 2 are
   * pure SQL — a deadline that has passed, and a board re-read without the posting in it — so
   * this costs two UPDATEs and no network at all.
   *
   * `checkUrls` is deliberately NOT set. That stage fans out a request per posting, which
   * would make every discovery run silently minutes longer; re-fetching one posting to see
   * whether it is still there stays what the per-posting route is for.
   *
   * Failure here must not cost the run. A student pressed "find postings" — losing the whole
   * search because a tidy-up query threw would be trading the thing they asked for against
   * housekeeping they never mentioned.
   */
  try {
    await refreshPostings({});
  } catch (err) {
    logger.warn({ err }, 'freshness pass before the discovery run failed; searching anyway');
  }

  const reports: SourceReport[] = [];
  const collected: Array<{ posting: NormalizedPosting; source: string }> = [];
  const skipped: string[] = [];
  const closedUrls: string[] = [];

  const limit = opts.concurrency ?? 4;
  const queue = [...targets];

  async function worker(): Promise<void> {
    for (;;) {
      const target = queue.shift();
      if (!target) return;

      const adapter = ALL_SOURCES[target.source];
      const report: SourceReport = {
        source: target.source,
        board: target.board,
        found: 0,
        new: 0,
        errors: [],
        notes: [],
        degraded: false,
      };

      if (!adapter) {
        report.errors.push(`unknown source "${target.source}"`);
        report.degraded = true;
        skipped.push(`${target.source}/${target.board}: unknown source`);
        reports.push(report);
        publish({
          type: 'discovery.source_failed',
          runId,
          source: target.source,
          error: 'unknown source',
        });
        continue;
      }

      // A keyed source with no key is a real coverage gap and is reported as one. The
      // adapter may say so in `notes` (the keyed aggregators do) or in `gaps` (web_search
      // does, since an unsearched web is coverage the user asked for and did not get) —
      // this branch used to read only `notes`, so an adapter that chose the more honest
      // channel had its explanation dropped on the floor.
      if (adapter.requiresKey && !adapter.isConfigured()) {
        const result = await adapter.fetch({ board: target.board });
        report.notes = [...result.notes, ...(result.gaps ?? [])];
        report.degraded = true;
        skipped.push(...report.notes);
        reports.push(report);
        continue;
      }

      try {
        const result = await adapter.fetch({
          board: target.board,
          keywords: target.keywords,
          location: target.location,
        });
        /**
         * Stamped on the way out of a successful fetch, for every target that was searched.
         *
         * `last_run_at` was declared on the table and read by `GET /api/sources`, and no code
         * in this app ever wrote it — so the Settings list would have told the user "never
         * run" about boards this machine had searched an hour earlier. Here rather than in
         * `ensureSource`, which fires once per PERSISTED POSTING: a board searched honestly
         * that had nothing open would never have been stamped, which is the opposite of what
         * "last searched" means and the case the column is most useful for.
         */
        // `ensureSource` first, because a bare UPDATE matched no row the first time a board
        // was searched. Source rows are written in two places: `ensureSource` from `persist()`,
        // which runs after the whole worker loop, and the resolve route. So every guessed
        // vendor slug and every keyless aggregator was stamped before its row existed, and the
        // Settings list said "not searched yet" about the boards a run had just been through —
        // which is the exact sentence this column was added to stop showing.
        const label = `${target.source}:${target.board}`;
        ensureSource(label);
        db.update(schema.source)
          .set({ lastRunAt: new Date().toISOString() })
          .where(eq(schema.source.label, label))
          .run();
        report.found = result.postings.length;
        report.notes = [...result.notes, ...(result.gaps ?? [])];
        // A source naming its own closed roles is the best evidence of a closure there is,
        // and it costs no request. Collected here and applied after every source has been
        // read, so a posting one source calls closed and another returns as open in the
        // same run stays open — the sighting is the stronger signal.
        if (result.closed?.length) closedUrls.push(...result.closed);
        // A source that came back short says so here. Without this a run that stopped at
        // the first page of a paginated source, or dropped rows it could not read, was
        // reported to the user as a complete search of that source.
        if (result.gaps?.length) {
          report.degraded = true;
          skipped.push(...result.gaps);
        }
        for (const p of result.postings) {
          collected.push({ posting: p, source: `${target.source}:${target.board}` });
        }
        // How many are new is not knowable here: nothing is compared against the stored
        // postings until persist() runs after every source has been fetched. Sending 0
        // would read on a live counter as "found these, none new" — indistinguishable from
        // a source that genuinely turned up nothing unseen — and then jump to the real total
        // at discovery.done. null says "not counted yet"; the true per-source totals arrive
        // on discovery.done.
        publish({
          type: 'discovery.progress',
          runId,
          source: `${target.source}:${target.board}`,
          found: result.postings.length,
          new: null,
        });
      } catch (err) {
        /**
         * A board address that answers "gone" heals the plan instead of haunting it.
         *
         * Every resolved board lives on as a `source` row, and rows are what future plans
         * are built from — so a Workday board whose tenant or site name stopped answering
         * re-entered every plan forever, failed every run, and each report carried a raw
         * "422 Unprocessable Entity" the user could do nothing about except read it again
         * next time. 404, 410 and 422 are the address itself being wrong, not the site
         * having a bad day (a 5xx or a timeout changes nothing here), and only a target
         * WITH a board is touched: a keyword source's row names no address to be wrong
         * about, and disabling one on a stray 4xx would switch a whole source off.
         */
        const message = err instanceof Error ? err.message : String(err);
        const gone =
          err instanceof HttpError && [404, 410, 422].includes(err.status) && target.board !== '';

        /**
         * Whether THIS run actually switched a row off, rather than whether it tried.
         *
         * The first version of this said "dropped from future plans" on the strength of the
         * status code alone, and most of these targets have no row to drop: the planner
         * builds five GUESSED vendor boards per pinned company, four of which 404 because the
         * company was never on them. One pinned name therefore produced four paragraphs each
         * asserting that an address had stopped answering and been removed, when neither had
         * happened — a confident sentence about a thing the run did not do, which is the one
         * kind of report this file exists to avoid. Scoping the update to rows still enabled
         * makes `changes` mean exactly "this run switched it off".
         */
        let disabled = 0;
        if (gone) {
          const label = `${target.source}:${target.board}`;
          disabled = db
            .update(schema.source)
            .set({ enabled: false })
            .where(and(eq(schema.source.label, label), eq(schema.source.enabled, true)))
            .run().changes;
        }

        const said =
          disabled > 0
            ? `${target.source}/${target.board}: this board address no longer answers ` +
              `(HTTP ${(err as HttpError).status}), so it was dropped from future plans. If the ` +
              'company moved its board, resolve it again in Discover.'
            : gone
              ? `${target.source}/${target.board}: no board of that name there ` +
                `(HTTP ${(err as HttpError).status}), so nothing was searched on it.`
              : `${target.source}/${target.board}: ${message}`;
        report.errors.push(said);
        report.degraded = true;
        skipped.push(said);
        logger.warn({ err, target, disabled }, 'discovery source failed');
        publish({
          type: 'discovery.source_failed',
          runId,
          source: `${target.source}:${target.board}`,
          error: message,
        });
      }

      reports.push(report);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, targets.length || 1) }, worker));

  const { unique, duplicates } = dedupe(collected);
  const inserted = persist(unique);
  // `persist` reports the row each posting landed in, which is the only identity that
  // survives dedupe merging two addresses onto one job.
  const closed = closePostings(closedUrls, new Set(inserted.ids));

  for (const r of reports) {
    r.new = inserted.perSource.get(`${r.source}:${r.board}`) ?? 0;
  }

  const summary: RunSummary = {
    runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    targets: targets.length,
    found: collected.length,
    new: inserted.total,
    duplicates,
    closed,
    bySource: reports,
    skipped,
  };

  logger.info(
    { runId, found: summary.found, new: summary.new, duplicates, closed, skipped: skipped.length },
    'discovery run complete',
  );

  publish({
    type: 'discovery.done',
    runId,
    summary: {
      sources: targets.length,
      found: summary.found,
      new: summary.new,
      duplicates,
      errors: reports.filter((r) => r.errors.length > 0).length,
      skipped,
    },
  });

  persistRun(summary);
  return summary;
}

/** Run summaries are kept so `GET /api/discovery/runs/:id` can answer after the fact. */
function persistRun(summary: RunSummary): void {
  db.insert(schema.task)
    .values({
      id: summary.runId,
      kind: 'discovery_run',
      payload: summary,
      status: 'done',
      finishedAt: summary.finishedAt,
    })
    .run();
}

export function getRun(runId: string): RunSummary | null {
  const row = db.select().from(schema.task).where(eq(schema.task.id, runId)).all()[0];
  return row && row.kind === 'discovery_run' ? (row.payload as RunSummary) : null;
}

export function listRuns(limit = 20): RunSummary[] {
  return db
    .select()
    .from(schema.task)
    .where(eq(schema.task.kind, 'discovery_run'))
    .orderBy(desc(schema.task.createdAt))
    .limit(limit)
    .all()
    .map((r) => r.payload as RunSummary);
}

/** Adds a manually-pasted posting (docs/04 § Tier C). Returns its id. */
export function saveManualPosting(posting: NormalizedPosting): string {
  const { unique } = dedupe([{ posting, source: 'manual:pasted' }]);
  // The id comes back from persist rather than a second lookup by URL. Now that
  // persistence also matches on fingerprint, a pasted posting can merge into a row that
  // was discovered under a different URL — and a URL lookup would find nothing and return
  // an empty id for a posting that was saved perfectly well.
  return persist(unique).ids[0] ?? '';
}

/**
 * Whether a value carries any information at all, however deeply it is wrapped.
 *
 * A null test is not enough, and getting this wrong broke the very rule `freshFields` is
 * written to keep. `term` is ALWAYS an object — a source that could read no season, year or
 * duration still returns `{season: null, year: null, durationWeeks: null, multiTerm: false}`
 * — and `requires` is `{}` when the description was empty. Both are non-null, so both sailed
 * past a null check and overwrote a good stored term with nothing, which is exactly what
 * happens when the community list, which carries neither, re-sights a Greenhouse posting.
 *
 * `false` counts as nothing and `0` counts as something, and that asymmetry is deliberate.
 * Every boolean on a NormalizedPosting is a parser flag whose `false` means "no evidence of
 * this" — `multiTerm` is literally `duration !== null && duration > 20` — while `0` is a real
 * measurement: `hybridDaysOnsite: 0` says fully remote, and losing it would be losing a fact.
 */
function carriesNothing(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (typeof value === 'boolean') return value === false;
  if (typeof value === 'number') return false;
  if (Array.isArray(value)) return value.every(carriesNothing);
  if (typeof value === 'object') return Object.values(value).every(carriesNothing);
  return false;
}

/**
 * What a later sighting is allowed to change about a posting already on file.
 *
 * A row was written once and then never touched again except for its timestamps, so anything
 * the employer added after we first saw it never landed: a deadline announced a week later,
 * a pay band filled in, a description rewritten. The deadline is the one that bites — stage 1
 * of `refreshPostings` closes a posting whose `closesAt` has passed, and a `closesAt` that
 * arrives after first sight could never reach the column, so that stage had nothing to read
 * for most of the table. It also meant a parser improvement only ever applied to postings
 * discovered after it shipped.
 *
 * ONLY NON-EMPTY VALUES, and that is the whole safety of it. The same posting is seen through
 * different sources — the community list carries no description at all, and a run that
 * re-sighted a Greenhouse posting through it would blank the description, the pay and the
 * requirements if this overwrote blindly. A later sighting may add what was missing and
 * correct what changed; it may never replace something with nothing.
 *
 * Company, title and canonical URL are deliberately absent. Those three are what dedupe
 * matched on, so rewriting them from a different source's spelling would move the row out
 * from under the key that found it.
 */
/**
 * A JSON column merged leaf by leaf, so a thinner sighting cannot erase the detail in it.
 *
 * "Never replace something with nothing" was applied per COLUMN, and `term` and
 * `compensation` are whole objects. The community list always produces a season and a year —
 * its own text carries "Summer 2027" — so its `term` never counts as empty, and re-sighting a
 * Greenhouse posting through it replaced `{season, year, start, end, durationWeeks}` with
 * `{season, year}`. `term.start`/`end` are what the eligibility rule treats as the firm
 * window, so a corroborated window silently degraded to a season-approximate one, on every
 * run, for every posting the list also carries.
 */
function mergeLeaves(stored: unknown, fresh: unknown): unknown {
  if (
    typeof stored !== 'object' ||
    stored === null ||
    Array.isArray(stored) ||
    typeof fresh !== 'object' ||
    fresh === null ||
    Array.isArray(fresh)
  ) {
    return fresh;
  }
  const out: Record<string, unknown> = { ...(stored as Record<string, unknown>) };
  for (const [key, value] of Object.entries(fresh as Record<string, unknown>)) {
    if (!carriesNothing(value)) out[key] = value;
  }
  return out;
}

/** What the Ashby adapter stamps on a figure the employer published themselves. */
const EMPLOYER_STATED = 'stated by the employer on the job board';

function freshFields(
  p: NormalizedPosting,
  stored?: Record<string, unknown>,
): Record<string, unknown> {
  const set: Record<string, unknown> = {};
  const put = (column: string, value: unknown): void => {
    if (carriesNothing(value)) return;
    set[column] = value;
  };
  const merge = (column: string, value: unknown): void => {
    if (carriesNothing(value)) return;
    set[column] = mergeLeaves(stored?.[column], value);
  };

  put('applyUrl', p.applyUrl);
  put('descriptionText', p.descriptionText);
  put('descriptionHtml', p.descriptionHtml);
  put('locations', p.locations);
  put('positionType', p.positionType);
  put('workArrangement', p.workArrangement);
  put('hybridDaysOnsite', p.hybridDaysOnsite);
  put('remoteEligibleIn', p.remoteEligibleIn);
  put('programFlags', p.programFlags);
  merge('term', p.term);
  merge('requires', p.requires);

  /**
   * A figure the employer published outranks one a regex found, whichever arrives later.
   *
   * `ashbyPay` reads the band Ashby states and marks it; everything else is the text parser's
   * best reading of prose. Replacing the first with the second is the exact harm that adapter
   * was written to end — Ramp's internship states $11,700 a month, and a later, thinner
   * sighting carrying a predicted $85,000 a year would have put it straight back. Within one
   * run the order the sources happen to finish in decides which arrives last, so this cannot
   * be left to chance.
   */
  const storedComp = stored?.['compensation'] as { raw?: string } | null | undefined;
  const freshIsStated = (p.compensation as { raw?: string } | null)?.raw === EMPLOYER_STATED;
  if (!(storedComp?.raw === EMPLOYER_STATED && !freshIsStated)) put('compensation', p.compensation);
  put('postedAt', p.postedAt);
  put('closesAt', p.closesAt);
  return set;
}

/**
 * Closes the postings a source said outright are no longer open.
 *
 * Matched on canonical URL, which is the key the source published them under and the one
 * stage 1 of dedupe already normalizes. A URL we have never stored matches nothing and costs
 * one indexed lookup; there is no reason to complain about it, because a source listing its
 * own closed roles will always name plenty we never saw open.
 */
function closePostings(urls: string[], seenOpen: Set<string>): number {
  let closed = 0;
  for (const url of new Set(urls)) {
    const rows = db
      .select({ id: schema.jobPosting.id })
      .from(schema.jobPosting)
      .where(and(eq(schema.jobPosting.canonicalUrl, url), eq(schema.jobPosting.isOpen, true)))
      .all();
    for (const row of rows) {
      /**
       * The row, not the URL, is what "we also saw this open" has to be about.
       *
       * The caller used to hold back a closed URL only when the same run had fetched THAT
       * URL open — and persistence merges by fingerprint as well as by URL, so the same job
       * seen open on Greenhouse and closed on the community list is one stored row reached
       * by two different addresses. The Greenhouse sighting re-opened the row, the list's
       * closure then shut it, and a posting a student could still have applied to left the
       * queue. Not a corner: the community list is the cold-start default, so a row first
       * stored from it and later seen on a company board is the ordinary provenance.
       */
      if (seenOpen.has(row.id)) continue;
      db.update(schema.jobPosting)
        .set({ isOpen: false, lastSeenAt: new Date().toISOString() })
        .where(eq(schema.jobPosting.id, row.id))
        .run();
      closed += 1;
    }
  }
  return closed;
}

interface PersistResult {
  total: number;
  perSource: Map<string, number>;
  /** The row id each entry ended up in, new or matched, in the order given. */
  ids: string[];
}

function persist(unique: ReturnType<typeof dedupe>['unique']): PersistResult {
  const perSource = new Map<string, number>();
  const ids: string[] = [];
  let total = 0;

  for (const entry of unique) {
    const p = entry.posting;
    const fp = fingerprint(p);

    /**
     * Cross-run matching, which used to be stage 1 only.
     *
     * dedupe() applies all three stages WITHIN a run, but persistence compared against
     * the database by canonical URL alone — so the same job found on Greenhouse in one
     * run and Adzuna in the next was stored twice, each copy with its own match row and
     * its own G2 decision to make. The fingerprint column and its index were written on
     * every insert and read by nothing.
     *
     * The fingerprint (company + normalized title + primary city) is the same stage-2
     * key, so this is the existing rule applied across runs rather than a new one.
     */
    const candidates = db
      .select({ id: schema.jobPosting.id, canonicalUrl: schema.jobPosting.canonicalUrl })
      .from(schema.jobPosting)
      .where(
        or(
          eq(schema.jobPosting.canonicalUrl, p.canonicalUrl),
          eq(schema.jobPosting.fingerprint, fp),
        ),
      )
      .all();

    /**
     * THE EXACT KEY WINS OVER THE APPROXIMATE ONE.
     *
     * The two halves of that `or` can match DIFFERENT stored rows: this posting's own row by
     * canonical URL, and somebody else's by fingerprint — company, normalised title and
     * primary city, which two requisitions at one company in one city share readily. Taking
     * `[0]` left the choice to whatever order SQLite's plan happened to return, so a sighting
     * could update a different job's row and leave its own untouched: one posting overwritten
     * with another's description and dates, and the real one never refreshed.
     *
     * A canonical URL is unique in this table and is the address the posting was actually
     * found at. A fingerprint is a similarity heuristic. When both answer, the address decides.
     */
    const exact = candidates.find((c) => c.canonicalUrl === p.canonicalUrl);
    const existing = exact ? [exact] : candidates;
    const matchedByUrl = exact !== undefined;

    const now = new Date().toISOString();

    if (existing[0]) {
      const stored = db
        .select()
        .from(schema.jobPosting)
        .where(eq(schema.jobPosting.id, existing[0].id))
        .all()[0];
      const fresh = freshFields(p, stored);

      /**
       * A SIGHTING AT A DIFFERENT ADDRESS MAY NOT REWRITE WHERE THE STUDENT APPLIES.
       *
       * `freshFields` takes the apply URL from whatever sighting arrived last. On a
       * fingerprint-only match that sighting is a DIFFERENT page — an aggregator's copy, a
       * web-search hit — and the row then sends the student somewhere other than the address
       * it claims to come from. G4 is the student clicking that link on a real application,
       * so it has to point where the row says it does.
       *
       * A sighting at the same canonical URL is the same page and may correct it freely, and
       * an empty stored value is not a correction but a gap being filled.
       */
      if (!matchedByUrl && typeof stored?.applyUrl === 'string' && stored.applyUrl !== '') {
        delete fresh['applyUrl'];
      }

      /**
       * REQUIREMENTS BELONG TO THE TEXT THEY WERE READ FROM.
       *
       * `runMatching` extracts once and then trusts the stamp: `requirementsExtractedAt ===
       * null || opts.reextract`. Nothing ever cleared that stamp, so requirements read from
       * one description outlived it. The shape that costs the student: a board answers a
       * listing with an empty or one-line description, the posting is stored, matching finds
       * no requirements in it and stamps the row — and when a later run brings the real
       * description, the row keeps the stamp and the requirements are never read at all.
       * Eligibility then reasons about a posting whose stated rules it has never seen, and the
       * only way out was a full manual re-extract of every posting in the table.
       *
       * Cleared only when the text ACTUALLY changed. `freshFields` already refuses to
       * overwrite something with nothing, so a run that re-sees the same posting normally
       * proposes the identical text and this is a no-op — which matters, because clearing on
       * every sighting would re-run the model pass over the whole table on every discovery
       * run for users who have an API key.
       */
      const descriptionChanged =
        typeof fresh['descriptionText'] === 'string' &&
        fresh['descriptionText'] !== stored?.descriptionText;
      if (descriptionChanged) fresh['requirementsExtractedAt'] = null;

      db.update(schema.jobPosting)
        // The fingerprint is rewritten, not just the timestamps. Its definition became more
        // cautious — it used to erase the tokens that tell "Intern I" from "Intern II" —
        // and rows stored under the old key would otherwise keep matching two distinct
        // requisitions onto one row forever. Recomputing on every sighting means the table
        // heals itself as postings are seen again, with no data migration to get wrong.
        .set({ lastSeenAt: now, isOpen: true, fingerprint: fp, ...fresh })
        .where(eq(schema.jobPosting.id, existing[0].id))
        .run();
      linkSources(existing[0].id, entry.sources, p.externalId);
      ids.push(existing[0].id);
      continue;
    }

    const id = ulid();
    db.insert(schema.jobPosting)
      .values({
        id,
        externalId: p.externalId,
        canonicalUrl: p.canonicalUrl,
        applyUrl: p.applyUrl,
        company: p.company,
        companyDomain: p.companyDomain,
        title: p.title,
        descriptionHtml: p.descriptionHtml,
        descriptionText: p.descriptionText,
        locations: p.locations,
        positionType: p.positionType,
        workArrangement: p.workArrangement,
        hybridDaysOnsite: p.hybridDaysOnsite,
        remoteEligibleIn: p.remoteEligibleIn,
        programFlags: p.programFlags,
        term: p.term,
        compensation: p.compensation,
        requires: p.requires,
        postedAt: p.postedAt,
        closesAt: p.closesAt,
        isOpen: true,
        atsVendor: p.atsVendor,
        fingerprint: fp,
        firstSeenAt: now,
        lastSeenAt: now,
      })
      .run();

    linkSources(id, entry.sources, p.externalId);
    ids.push(id);
    total++;
    for (const s of entry.sources) perSource.set(s, (perSource.get(s) ?? 0) + 1);
  }

  return { total, perSource, ids };
}

/** Provenance: a merged posting keeps every source that saw it. */
function linkSources(postingId: string, sources: string[], externalId: string | null): void {
  for (const s of sources) {
    const sourceId = ensureSource(s);
    db.insert(schema.jobPostingSource)
      .values({ postingId, sourceId, externalId })
      .onConflictDoNothing()
      .run();
  }
}

/**
 * The source row for a label, looked up every time on purpose.
 *
 * This used to memoise label → row id in a module-level Map that nothing ever cleared. "Delete
 * everything" in Settings truncates the source table, and foreign keys are on — so the first
 * discovery run after a delete handed the job_posting_source insert an id for a row that no
 * longer existed and the whole run died on "FOREIGN KEY constraint failed". The user saw a 500
 * from a search, or a 502 saying "Could not read that URL" about a URL that had been fetched
 * and parsed perfectly, and it happened on every run until someone restarted the process. The
 * delete reply says "Restart the app to begin again", but that is advice and the app keeps
 * running.
 *
 * The lookup it replaces is one indexed hit on a table with a handful of rows, a few times per
 * run. Cached state that outlives the database it describes is not worth that.
 */
function ensureSource(label: string): string {
  const kind = label.split(':')[0] ?? 'manual';
  const rows = db
    .select({ id: schema.source.id })
    .from(schema.source)
    .where(eq(schema.source.label, label))
    .all();

  const id = rows[0]?.id ?? ulid();
  if (!rows[0]) {
    db.insert(schema.source).values({ id, kind, label, enabled: true }).run();
  }
  return id;
}

/** Counts for the dashboard. */
export function postingStats(): { total: number; open: number } {
  const total =
    db
      .select({ n: sql<number>`count(*)` })
      .from(schema.jobPosting)
      .all()[0]?.n ?? 0;
  const open =
    db
      .select({ n: sql<number>`count(*)` })
      .from(schema.jobPosting)
      .where(eq(schema.jobPosting.isOpen, true))
      .all()[0]?.n ?? 0;
  return { total, open };
}
