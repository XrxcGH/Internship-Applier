import { beforeEach, describe, expect, it } from 'vitest';
import { db, schema, sqlite } from '../src/infra/db/client';
import { runMigrations } from '../src/infra/db/migrate';
import { refreshPostings } from '../src/core/discovery/refresh';

/** Mid-morning UTC on 2026-08-05, so a deadline of "2026-08-05" is today and still live. */
const NOW = new Date('2026-08-05T09:00:00.000Z');

function seed(rows: Array<{ id: string; closesAt: string | null; lastSeenAt?: string }>): void {
  sqlite.prepare('DELETE FROM job_posting_source').run();
  sqlite.prepare('DELETE FROM job_posting').run();
  sqlite.prepare('DELETE FROM source').run();
  for (const r of rows) {
    db.insert(schema.jobPosting)
      .values({
        id: r.id,
        company: 'Acme',
        title: `Intern ${r.id}`,
        canonicalUrl: `https://acme.com/jobs/${r.id}`,
        applyUrl: `https://acme.com/jobs/${r.id}`,
        fingerprint: `acme|intern ${r.id}|nyc`,
        descriptionText: 'A job.',
        isOpen: true,
        closesAt: r.closesAt,
        firstSeenAt: '2026-07-01T00:00:00Z',
        lastSeenAt: r.lastSeenAt ?? '2026-08-01T00:00:00Z',
      })
      .run();
  }
}

/**
 * A source row and a posting filed under it — the provenance every stored posting has.
 *
 * `lastRunAt` is the whole point of these helpers: `run.ts` stamps it on the way out of a
 * SUCCESSFUL fetch of that board, so null means "this board has never been searched" and an
 * old value means "not searched lately". Both are the shape the staleness stage has to be
 * able to tell apart from "searched, and this posting was not in it".
 */
function filedUnder(postingId: string, label: string, lastRunAt: string | null): void {
  db.insert(schema.source)
    .values({ id: label, kind: label.split(':')[0] ?? 'greenhouse', label, lastRunAt })
    .onConflictDoNothing()
    .run();
  db.insert(schema.jobPostingSource)
    .values({ postingId, sourceId: label, externalId: null })
    .onConflictDoNothing()
    .run();
}

function openIds(): string[] {
  return (
    sqlite.prepare('SELECT id FROM job_posting WHERE is_open = 1 ORDER BY id').all() as Array<{
      id: string;
    }>
  ).map((r) => r.id);
}

describe('refreshPostings', () => {
  beforeEach(() => {
    runMigrations();
  });

  /**
   * Feeds hand over bare dates, and a bare date sorts before every timestamp on that day.
   * A posting whose deadline is today was therefore closed at 00:00 UTC — for a US Pacific
   * user, from 17:00 the evening before — and the student was told "This posting is no
   * longer open" on the last and most urgent day they could still apply. The deadline rule
   * in eligibility already reads a bare date as end of day; this is the other half of that.
   */
  it('leaves a date-only deadline open for the whole of its last day', async () => {
    seed([
      { id: 'today', closesAt: '2026-08-05' },
      { id: 'tomorrow', closesAt: '2026-08-06' },
      { id: 'endOfToday', closesAt: '2026-08-05T23:59:59Z' },
      { id: 'midnightToday', closesAt: '2026-08-05T00:00:00Z' },
      { id: 'yesterday', closesAt: '2026-08-04' },
      { id: 'noDeadline', closesAt: null },
    ]);

    const summary = await refreshPostings({ now: NOW });

    expect(summary.closedByDeadline).toBe(2);
    expect(openIds()).toEqual(['endOfToday', 'noDeadline', 'today', 'tomorrow']);
  });

  /**
   * "Refresh this one posting" used to re-evaluate the whole table first, so refreshing an
   * expired posting could close every other row whose bare deadline happened to be today,
   * and then report the count as though it were about the one that was asked for.
   */
  it('touches only the posting it was asked about', async () => {
    seed([
      { id: 'today', closesAt: '2026-08-05' },
      { id: 'midnightToday', closesAt: '2026-08-05T00:00:00Z' },
      { id: 'yesterday', closesAt: '2026-08-04' },
    ]);

    const summary = await refreshPostings({ now: NOW, postingId: 'yesterday' });

    expect(summary.closedByDeadline).toBe(1);
    expect(openIds()).toEqual(['midnightToday', 'today']);
  });

  it('closes a posting a board has been re-read without and has not listed since', async () => {
    seed([
      { id: 'fresh', closesAt: null, lastSeenAt: '2026-08-01T00:00:00Z' },
      { id: 'stale', closesAt: null, lastSeenAt: '2026-05-01T00:00:00Z' },
    ]);
    // The board both were found on was searched successfully yesterday and did not carry
    // `stale`. That is a real check with a real negative result, and it must still close.
    filedUnder('fresh', 'greenhouse:acme', '2026-08-04T00:00:00Z');
    filedUnder('stale', 'greenhouse:acme', '2026-08-04T00:00:00Z');

    const summary = await refreshPostings({ now: NOW });

    expect(summary.closedAsStale).toBe(1);
    expect(openIds()).toEqual(['fresh']);
  });
});

/**
 * Silence is not a finding — docs/04 § Freshness.
 *
 * `last_seen_at` says only that nothing has re-sighted a posting, and the refresh has plenty
 * of ways to see nothing without ever having looked: a fetch that failed, a board that was
 * skipped or lost its key, a host whose robots.txt could not be read, an address on a board
 * this tool will not open at all, or a student who ran no search for seven weeks. Every one
 * of them ends in the same frozen timestamp, and the staleness stage read all of them as
 * "this job is gone" — writing `is_open = false`, which `posting_open` hard-fails with no
 * override at G3. A false ineligible, produced by a refresh that checked nothing.
 */
describe('closing a posting as stale', () => {
  beforeEach(() => {
    runMigrations();
  });

  it('leaves a pasted posting open, because nothing can ever re-sight one', async () => {
    // The reported case, to its own dates. A Handshake posting pasted on 2026-10-01, whose
    // employer states it closes on 2027-01-15, marked closed by the first refresh after
    // 2026-11-15 — three months early, on a job the student had read themselves. Nothing
    // moves its `last_seen_at`: stage 3 refuses to open the address (`notChecked`), and
    // `manual:pasted` is not a board the runner can search, so no sighting is possible.
    seed([{ id: 'pasted', closesAt: '2027-01-15', lastSeenAt: '2026-10-01T00:00:00Z' }]);
    filedUnder('pasted', 'manual:pasted', null);

    const summary = await refreshPostings({ now: new Date('2026-12-01T09:00:00.000Z') });

    expect(summary.closedAsStale).toBe(0);
    expect(openIds()).toEqual(['pasted']);
  });

  it('leaves a posting open when its board has never been searched successfully', async () => {
    // The sibling with the widest blast radius: an adapter that broke, or a keyed source
    // whose key went missing, is skipped on every run — `last_run_at` is stamped only on the
    // way out of a successful fetch — so the whole board's postings go quiet together and
    // were closed en masse forty-five days later.
    seed([{ id: 'onBrokenBoard', closesAt: null, lastSeenAt: '2026-05-01T00:00:00Z' }]);
    filedUnder('onBrokenBoard', 'adzuna:us', null);

    const summary = await refreshPostings({ now: NOW });

    expect(summary.closedAsStale).toBe(0);
    expect(openIds()).toEqual(['onBrokenBoard']);
  });

  it('leaves a posting open when nobody has run a search inside the window', async () => {
    // A student who stopped searching for seven weeks — over an exam term, say — came back
    // to a queue that had closed itself. The last search of this board is older than the
    // staleness cutoff, so it cannot be the check that found the posting gone.
    seed([{ id: 'unsearched', closesAt: null, lastSeenAt: '2026-05-01T00:00:00Z' }]);
    filedUnder('unsearched', 'greenhouse:acme', '2026-05-02T00:00:00Z');

    const summary = await refreshPostings({ now: NOW });

    expect(summary.closedAsStale).toBe(0);
    expect(openIds()).toEqual(['unsearched']);
  });

  it('leaves a posting with no source on file open', async () => {
    // Nothing that could have re-sighted it exists, so its silence says nothing at all.
    seed([{ id: 'noProvenance', closesAt: null, lastSeenAt: '2026-05-01T00:00:00Z' }]);

    const summary = await refreshPostings({ now: NOW });

    expect(summary.closedAsStale).toBe(0);
    expect(openIds()).toEqual(['noProvenance']);
  });

  it('still closes it when one of its several sources has been re-read', async () => {
    // Postings merge: the same job is filed under the community list and under the company
    // board. One board that has actually been searched since is evidence enough, and the
    // pasted or broken sibling alongside it must not veto that.
    seed([{ id: 'merged', closesAt: null, lastSeenAt: '2026-05-01T00:00:00Z' }]);
    filedUnder('merged', 'manual:pasted', null);
    filedUnder('merged', 'greenhouse:acme', '2026-08-04T00:00:00Z');

    const summary = await refreshPostings({ now: NOW });

    expect(summary.closedAsStale).toBe(1);
    expect(openIds()).toEqual([]);
  });

  it('does not close a posting whose per-URL check failed rather than 404ed', async () => {
    // Stage 3 leaves a refusal, a 500 or a timeout open on purpose — "the site is having a
    // bad day, not the job is gone" — and stage 2 then closed it anyway once the bad days
    // added up to forty-five, undoing that care in the one file that states the rule.
    seed([{ id: 'flaky', closesAt: null, lastSeenAt: '2026-05-01T00:00:00Z' }]);
    filedUnder('flaky', 'greenhouse:acme', null);

    const real = globalThis.fetch;
    globalThis.fetch = (async (input: unknown) =>
      String(input).endsWith('/robots.txt')
        ? new Response('', { status: 404 })
        : new Response('go away', { status: 403 })) as typeof globalThis.fetch;
    try {
      const summary = await refreshPostings({
        now: NOW,
        checkUrls: true,
        postingId: 'flaky',
      });
      expect(summary.errors).toBe(1);
      expect(summary.closedAsStale).toBe(0);
      expect(openIds()).toEqual(['flaky']);
    } finally {
      globalThis.fetch = real;
    }
  });
});

/**
 * A stored address on a board this tool will not open.
 *
 * `POST /api/discovery/paste` exists so a student can bring a Handshake, LinkedIn or Indeed
 * posting WITHOUT this tool contacting those sites, and it stores their address as the
 * posting's identity on the undertaking that storing an address is not visiting one. This
 * loop walks every open posting and fetches its canonical URL, filtered on `is_open` alone —
 * so refreshing issued an unattended, timed GET at app.joinhandshake.com, robots.txt request
 * and all. The careful path armed the visit it was built to avoid.
 */
function seedAggregator(): void {
  sqlite.prepare('DELETE FROM job_posting').run();
  for (const [id, url] of [
    ['h1', 'https://app.joinhandshake.com/jobs/1'],
    ['l1', 'https://www.linkedin.com/jobs/view/2'],
    ['a1', 'https://boards.greenhouse.io/acme/jobs/3'],
  ] as const) {
    db.insert(schema.jobPosting)
      .values({
        id,
        company: 'Acme',
        title: `Intern ${id}`,
        canonicalUrl: url,
        applyUrl: url,
        fingerprint: `acme|intern ${id}|nyc`,
        descriptionText: 'A job.',
        isOpen: true,
        closesAt: null,
        firstSeenAt: '2026-07-01T00:00:00Z',
        lastSeenAt: '2026-08-01T00:00:00Z',
      })
      .run();
  }
}

describe('refreshing a posting whose address this tool will not open', () => {
  it('does not fetch it, and counts it as unchecked rather than as checked', async () => {
    // Counted rather than skipped in silence: a posting nobody could re-check is a posting
    // whose freshness is unknown, and reporting it as checked would be exactly the false
    // completeness this summary exists to prevent.
    seedAggregator();
    const real = globalThis.fetch;
    const reached: string[] = [];
    globalThis.fetch = (async (input: unknown) => {
      reached.push(String(input));
      return new Response('', { status: 404 });
    }) as typeof globalThis.fetch;

    try {
      const summary = await refreshPostings({ now: NOW, checkUrls: true, limit: 10 });
      expect(summary.notChecked).toBe(2);
      expect(reached.join(' ')).not.toMatch(/joinhandshake|linkedin/);
    } finally {
      globalThis.fetch = real;
    }
  });

  it('still checks the ones it is allowed to open', async () => {
    seedAggregator();
    const real = globalThis.fetch;
    const reached: string[] = [];
    globalThis.fetch = (async (input: unknown) => {
      reached.push(String(input));
      return new Response('ok', { status: 200 });
    }) as typeof globalThis.fetch;

    try {
      const summary = await refreshPostings({ now: NOW, checkUrls: true, limit: 10 });
      expect(summary.checked).toBe(1);
      expect(reached.join(' ')).toMatch(/boards\.greenhouse\.io/);
    } finally {
      globalThis.fetch = real;
    }
  });

  it('does not close a posting merely because it could not be checked', async () => {
    // The worst possible reading of "unchecked": a Handshake posting the student pasted
    // themselves disappearing from their queue because this tool declined to visit it.
    seedAggregator();
    const real = globalThis.fetch;
    globalThis.fetch = (async () => new Response('', { status: 404 })) as typeof globalThis.fetch;
    try {
      await refreshPostings({ now: NOW, checkUrls: true, limit: 10 });
      expect(openIds()).toContain('h1');
      expect(openIds()).toContain('l1');
    } finally {
      globalThis.fetch = real;
    }
  });
});

/**
 * A check that never left the machine.
 *
 * `politeFetch` answers a repeat GET of the same URL out of a body it already holds, for six
 * hours, and only successful responses are ever stored — so a hit is always a 200. The
 * freshness loop then stamped `last_seen_at = now` and counted the posting under `checked`,
 * and the student was told their posting had been verified just now when nothing had been
 * asked of the employer at all. `POST /api/postings/:id/refresh` is the sharp end: clicking
 * Check again on the one posting that matters most cannot report a fresh answer it did not get.
 */
describe('a freshness check inside the response cache window', () => {
  beforeEach(() => {
    runMigrations();
  });

  /** Requests for the posting itself. robots.txt is fetched too and is not the subject here. */
  function countingFetch(reached: string[]): typeof globalThis.fetch {
    return (async (input: unknown) => {
      const url = String(input);
      if (!url.endsWith('/robots.txt')) reached.push(url);
      return new Response('still hiring', { status: 200 });
    }) as typeof globalThis.fetch;
  }

  it('is not made, and is not counted as a check', async () => {
    seed([{ id: 'cacheWindow', closesAt: null }]);
    const real = globalThis.fetch;
    const reached: string[] = [];
    globalThis.fetch = countingFetch(reached);

    try {
      const first = await refreshPostings({ now: NOW, checkUrls: true, limit: 10 });
      expect(first.checked).toBe(1);
      expect(first.notRefetched).toBe(0);
      expect(reached).toHaveLength(1);

      const again = await refreshPostings({ now: NOW, checkUrls: true, limit: 10 });
      // Nothing went out — that was true before this fix too. What changed is that the
      // summary no longer says it did.
      expect(reached).toHaveLength(1);
      expect(again.checked).toBe(0);
      expect(again.notRefetched).toBe(1);
    } finally {
      globalThis.fetch = real;
    }
  });

  it('leaves last_seen_at where it was, rather than stamping a sighting nobody made', async () => {
    seed([{ id: 'cacheStamp', closesAt: null, lastSeenAt: '2026-08-01T00:00:00Z' }]);
    const real = globalThis.fetch;
    globalThis.fetch = countingFetch([]);

    try {
      await refreshPostings({ now: NOW, checkUrls: true, postingId: 'cacheStamp' });
      const seen = () =>
        (
          sqlite
            .prepare('SELECT last_seen_at AS a FROM job_posting WHERE id = ?')
            .get('cacheStamp') as {
            a: string;
          }
        ).a;
      expect(seen()).toBe(NOW.toISOString());

      // An hour later, from a cached body: the timestamp must not move again, because the
      // evidence behind it did not.
      const hourLater = new Date(NOW.getTime() + 3_600_000);
      const summary = await refreshPostings({
        now: hourLater,
        checkUrls: true,
        postingId: 'cacheStamp',
      });
      expect(summary.notRefetched).toBe(1);
      expect(seen()).toBe(NOW.toISOString());
    } finally {
      globalThis.fetch = real;
    }
  });

  it('asks again once the answer it has is older than the cache would keep it', async () => {
    // The other direction: this is a six-hour window, not a permanent silence, or a posting
    // checked once would never be checked again for the life of the process.
    //
    // Only the summary is asserted, and deliberately. Whether the request is answered by the
    // employer or by the fetcher's own map is not something this file can see or control: an
    // entry another path put there — `POST /api/discovery/manual` fetches the page, and so do
    // the source adapters — is still served silently. Closing that needs a no-store option on
    // politeFetch, which lives in fetcher.ts.
    seed([{ id: 'cacheExpiry', closesAt: null }]);
    const real = globalThis.fetch;
    globalThis.fetch = countingFetch([]);

    try {
      await refreshPostings({ now: NOW, checkUrls: true, limit: 10 });
      const later = await refreshPostings({
        now: new Date(NOW.getTime() + 7 * 3_600_000),
        checkUrls: true,
        limit: 10,
      });
      expect(later.notRefetched).toBe(0);
      expect(later.checked).toBe(1);
    } finally {
      globalThis.fetch = real;
    }
  });

  it('does not remember a 404 as an answer it could reuse', async () => {
    // The fetcher stores only successful responses, so a re-check after a 404 or a 500 really
    // would go out and must not be skipped. Getting this backwards would silence the one
    // status that closes a posting.
    seed([{ id: 'cacheMiss', closesAt: null }]);
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: unknown) =>
      String(input).endsWith('/robots.txt')
        ? new Response('', { status: 404 })
        : new Response('gone', { status: 404 })) as typeof globalThis.fetch;

    try {
      const first = await refreshPostings({ now: NOW, checkUrls: true, postingId: 'cacheMiss' });
      expect(first.closedByFetch).toBe(1);

      const again = await refreshPostings({ now: NOW, checkUrls: true, postingId: 'cacheMiss' });
      expect(again.checked).toBe(1);
      expect(again.notRefetched).toBe(0);
    } finally {
      globalThis.fetch = real;
    }
  });
});
