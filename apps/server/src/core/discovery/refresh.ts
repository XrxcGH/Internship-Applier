/**
 * Freshness — docs/04 § Freshness.
 *
 * Nothing is ever hard-deleted. A closed posting stays in the database so the tracker,
 * the application history, and the stats all remain intact; it is only marked closed.
 *
 * The rule this file keeps, everywhere: NOT LOOKED AT IS NOT THE SAME STATE AS FOUND GONE.
 * `is_open = false` is read by the `posting_open` eligibility rule as a hard fail with no
 * override, so every write of it here has to be backed by something that actually happened —
 * the employer's own closing date, a source that named the posting closed, or a 404 from its
 * page. A silence is not any of those.
 */
import { and, asc, eq, isNotNull, lt, sql } from 'drizzle-orm';
import { db, schema } from '../../infra/db/client';
import { HttpError, politeFetch, scrubUrl } from '../../infra/http/fetcher';
import { logger } from '../../infra/logger';
import { isAggregatorUrl } from './sourcingPolicy';

export interface RefreshSummary {
  checked: number;
  /**
   * Open postings whose address is on a board this tool will not open, so their freshness
   * could not be probed at all. Named rather than folded into `checked`, because a posting
   * nobody looked at is not a posting that was found still open.
   */
  notChecked: number;
  /**
   * Postings this pass deliberately did not re-fetch, because the only answer available
   * would have been a page this process already read within the response cache's six hours.
   * Named for the same reason as `notChecked`: a body from this morning is not a check made
   * now, and reporting it as one is how "verified just now" gets said about a posting that
   * was taken down at nine.
   */
  notRefetched: number;
  closedByDeadline: number;
  closedByFetch: number;
  closedAsStale: number;
  errors: number;
}

const STALE_DAYS = 45;

/**
 * How long `politeFetch` will answer a repeat GET out of a body it already holds.
 *
 * fetcher.ts's `CACHE_TTL_MS`, restated because it is not exported. Restating it is only
 * safe because of what it is used for below: it decides whether this pass BOTHERS to ask,
 * and the count it feeds is true either way. Drift makes this file ask more often or less
 * often than it needs to; it can never make the summary claim a check that did not happen.
 */
const RESPONSE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * When this process last got an answer for a URL out of a freshness check.
 *
 * Same process and same six hours as the fetcher's body cache, so it dies with it. Pruned
 * on every pass rather than left to grow: the memoisation map in `run.ts` that nothing ever
 * cleared is the cautionary tale, and a map keyed by every posting URL a long-running server
 * has ever checked is the same shape of leak.
 */
const lastAnsweredAt = new Map<string, number>();

export async function refreshPostings(
  opts: { limit?: number; now?: Date; checkUrls?: boolean; postingId?: string } = {},
): Promise<RefreshSummary> {
  const now = opts.now ?? new Date();
  const summary: RefreshSummary = {
    checked: 0,
    notChecked: 0,
    notRefetched: 0,
    closedByDeadline: 0,
    closedByFetch: 0,
    closedAsStale: 0,
    errors: 0,
  };

  // Every stage is scoped when a single posting was asked for. Stages 1 and 2 used to run
  // over the whole table regardless, so "refresh this one posting" quietly re-evaluated and
  // closed every other row in the database, then reported the result as though it were
  // about the requested one.
  const onlyRequested = opts.postingId ? eq(schema.jobPosting.id, opts.postingId) : undefined;

  // 1. Deadline in the past — pure data, no network needed.
  //
  // A closing date with no time means the whole of that day, not its first instant. Feeds
  // hand over bare dates ("2026-08-05"), and a bare date sorts before every timestamp on
  // that day, so a posting flipped to closed at 00:00 UTC on its own deadline — for a US
  // Pacific user, from 17:00 the evening before. The user was then told "This posting is no
  // longer open" on the last and most urgent day they could still apply, in the same rule
  // list where the deadline rule said "Closes 2026-08-05", because that rule already reads a
  // bare date as end of day. Pad here so the two agree.
  const closesAtEndOfDay = sql`(CASE WHEN length(${schema.jobPosting.closesAt}) = 10 THEN ${schema.jobPosting.closesAt} || 'T23:59:59.999Z' ELSE ${schema.jobPosting.closesAt} END)`;
  const expired = db
    .update(schema.jobPosting)
    .set({ isOpen: false })
    .where(
      and(
        eq(schema.jobPosting.isOpen, true),
        isNotNull(schema.jobPosting.closesAt),
        sql`${closesAtEndOfDay} < ${now.toISOString()}`,
        onlyRequested,
      ),
    )
    .run();
  summary.closedByDeadline = expired.changes;

  // 2. Not seen in a long time — and only where somebody has actually been looking.
  const staleCutoff = new Date(now.getTime() - STALE_DAYS * 86_400_000).toISOString();

  /**
   * Evidence that this posting's absence was noticed by something, rather than merely not
   * contradicted: a source that has this posting on file has been searched, successfully,
   * inside the staleness window.
   *
   * `last_seen_at` is not "we checked and it was gone", it is "nothing has re-sighted this",
   * and this file already knows those are different everywhere else. Stage 3 refuses to open
   * a Handshake or LinkedIn address at all and counts it `notChecked` on the stated ground
   * that a posting nobody looked at is not a posting found closed — and then this stage
   * closed exactly those postings on day 46, because nothing can ever move their
   * `last_seen_at`. The reported case: a posting pasted on 2026-10-01 with a stated deadline
   * of 2027-01-15 was marked closed by the first refresh after 2026-11-15 — three months
   * before the employer said it shut — and `posting_open` then hard-failed it with no
   * override. A false ineligible, on a job the student had read themselves and could still
   * have applied for, produced by a refresh that had not looked at anything.
   *
   * Its siblings all arrive the same way, because they all end in a `last_seen_at` that
   * nothing moved, and this one condition covers every one of them:
   *   - a per-URL check that failed with a 500 or timed out. Stage 3 deliberately leaves
   *     those open — "the site is having a bad day, not the job is gone" — and this stage
   *     closed them anyway six weeks later, undoing that care.
   *   - a host whose robots.txt could not be read, which is a refusal to look, not a finding.
   *   - a board whose adapter broke, lost its API key, or was never in the run at all: the
   *     whole board's postings go quiet together and were closed en masse.
   *   - the ordinary case of a student who did not run a search for seven weeks.
   *
   * `last_run_at` is stamped only on the way out of a SUCCESSFUL fetch of that board, so a
   * source that errored or was skipped does not count as having looked. `manual:pasted` — the
   * source every pasted posting is filed under — is not a source the runner can search at
   * all, so it never has a `last_run_at` and a pasted posting can no longer be closed by
   * silence. A posting with no source rows at all is in the same position: nothing that could
   * have re-sighted it exists, so its absence says nothing.
   *
   * The other direction is deliberately left intact: a board that HAS been re-read since and
   * no longer lists the posting still closes it on day 46. That is a real check with a real
   * negative result, and it is the whole reason this stage exists.
   */
  const looked = sql`EXISTS (
    SELECT 1 FROM ${schema.jobPostingSource} jps
      JOIN ${schema.source} src ON src.id = jps.source_id
     WHERE jps.posting_id = ${schema.jobPosting.id}
       AND src.last_run_at IS NOT NULL
       AND src.last_run_at > ${staleCutoff}
  )`;

  const stale = db
    .update(schema.jobPosting)
    .set({ isOpen: false })
    .where(
      and(
        eq(schema.jobPosting.isOpen, true),
        lt(schema.jobPosting.lastSeenAt, staleCutoff),
        looked,
        onlyRequested,
      ),
    )
    .run();
  summary.closedAsStale = stale.changes;

  if (!opts.checkUrls) return summary;

  // 3. Optional per-URL check. Only 404/410 closes a posting — a 500 or a timeout means
  //    the site is having a bad day, not that the job is gone.
  // Two fixes live in this query.
  //
  // `postingId` narrows to one row. Without it, "refresh this posting" from the UI
  // checked whichever rows the unordered query happened to return, then reported the
  // result as though it were about the requested one.
  //
  // And the batch case now only considers OPEN postings. This pass can only ever close
  // something, so an already-closed row spends a slot from the limit and can never change
  // state — it was starving the open postings the check exists for.
  const candidates = db
    .select({ id: schema.jobPosting.id, url: schema.jobPosting.canonicalUrl })
    .from(schema.jobPosting)
    .where(onlyRequested ?? eq(schema.jobPosting.isOpen, true))
    // Oldest first. Unordered, which rows got checked was down to whatever SQLite
    // returned, so with more postings than the limit the same arbitrary subset could be
    // rechecked run after run while others were never looked at again.
    .orderBy(asc(schema.jobPosting.lastSeenAt))
    .limit(opts.postingId ? 1 : (opts.limit ?? 50))
    .all();

  for (const [url, at] of lastAnsweredAt) {
    if (now.getTime() - at >= RESPONSE_CACHE_TTL_MS) lastAnsweredAt.delete(url);
  }

  for (const c of candidates) {
    /**
     * A stored address on a board this tool will not open is not checked, and says so.
     *
     * This loop walks every open posting and `politeFetch`es its canonical URL, filtered
     * only on is_open — no host check anywhere. A posting brought in through the paste path
     * carries the aggregator address as its canonical URL BY DESIGN: that path exists so a
     * student can bring a Handshake or LinkedIn posting without this tool ever contacting
     * those sites, and it stores the link on the explicit undertaking that storing an address
     * is not visiting one. Refreshing then visited it — unattended, on a timer, robots.txt
     * request and all — which is the exact automated access the whole path was built to avoid.
     *
     * Counted rather than skipped in silence: a posting nobody could re-check is a posting
     * whose freshness is unknown, and reporting it as checked would be the false-completeness
     * this file's summary exists to prevent.
     */
    if (isAggregatorUrl(c.url)) {
      summary.notChecked++;
      continue;
    }

    /**
     * A re-check inside the response cache's window is not a check, so it is not made and
     * not counted as one.
     *
     * `politeFetch` answers a repeat GET of the same URL out of a body it already holds —
     * six hours, and only successful responses are ever stored, so a hit is always a 200 —
     * without a single byte leaving the machine. This loop then stamped `last_seen_at = now`
     * and counted the posting under `checked`, so "checked just now, still open" was said
     * about a page this process last read at breakfast, and a role taken down at nine read
     * as open all day. `POST /api/postings/:id/refresh` is the sharp end: a student clicks
     * Check again on the one posting they care about, and is told it was verified when
     * nothing at all was asked of the employer.
     *
     * Skipping is what makes the count EXACT rather than a guess about the state of somebody
     * else's map: whatever the fetcher would have done with the request, this pass did not
     * make it, so "not re-fetched" is true unconditionally. If the cached body had been
     * evicted the only cost is a check deferred, never a check claimed.
     *
     * What this cannot see is an entry some OTHER path put there — `POST /api/discovery/manual`
     * fetches the page, and so do the source adapters — so a check within six hours of one of
     * those still comes out of the cache and is still counted here as checked. Closing that
     * needs the fetcher's own cache to be bypassable; the mechanism is already in there (a
     * request carrying a `jsonBody` is neither served from the cache nor stored in it) but it
     * is fetcher.ts's to expose, and this file must not fake it by mangling the URL — a
     * cache-busting fragment would be dropped on the first redirect hop and would fill the
     * shared cache with entries nothing will ever read.
     */
    const answeredAt = lastAnsweredAt.get(c.url);
    if (answeredAt !== undefined && now.getTime() - answeredAt < RESPONSE_CACHE_TTL_MS) {
      summary.notRefetched++;
      continue;
    }

    summary.checked++;
    try {
      await politeFetch(c.url, { rps: 1, timeoutMs: 12_000 });
      // Recorded only on the way out of a successful fetch, which is exactly when the
      // fetcher stores a body: a 404 or a 500 is never cached, so a re-check after one of
      // those really would go out and must not be skipped.
      lastAnsweredAt.set(c.url, now.getTime());
      db.update(schema.jobPosting)
        .set({ lastSeenAt: now.toISOString() })
        .where(eq(schema.jobPosting.id, c.id))
        .run();
    } catch (err) {
      if (err instanceof HttpError && (err.status === 404 || err.status === 410)) {
        db.update(schema.jobPosting)
          .set({ isOpen: false })
          .where(eq(schema.jobPosting.id, c.id))
          .run();
        summary.closedByFetch++;
      } else {
        summary.errors++;
        logger.debug({ err, url: scrubUrl(c.url) }, 'refresh check failed; leaving posting open');
      }
    }
  }

  return summary;
}
