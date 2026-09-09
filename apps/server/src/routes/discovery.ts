import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { desc, eq, sql } from 'drizzle-orm';
import { DEFAULT_FILTERS, SearchFilters, type ConfirmedProfile } from '@ia/shared';
import { ulid } from 'ulid';
import { db, schema } from '../infra/db/client';
import { getProfile, isProfileConfirmed } from '../core/profile/repository';
import {
  ALL_SOURCES,
  getRun,
  listRuns,
  postingStats,
  runDiscovery,
  saveManualPosting,
  type DiscoveryTarget,
} from '../core/discovery/run';
import { resolveCompany, type Resolution } from '../core/discovery/resolveCompany';
import { fetchManualPosting, readPastedPosting } from '../core/discovery/manualPosting';
import { AGGREGATOR_REFUSAL, isAggregatorUrl } from '../core/discovery/sourcingPolicy';
import { refreshPostings } from '../core/discovery/refresh';
import { planQueries, type PlannedTarget } from '../core/discovery/queryPlanner';

const SOURCE_NAMES = Object.keys(ALL_SOURCES) as [string, ...string[]];

const RunBody = z.object({
  targets: z
    .array(
      z.object({
        source: z.enum(SOURCE_NAMES),
        board: z.string().default(''),
        keywords: z.array(z.string()).optional(),
        location: z.string().optional(),
      }),
    )
    .min(1)
    .max(200),
});

const ResolveBody = z.object({ name: z.string().min(1) });
const ManualBody = z.object({ url: z.string().url() });

/**
 * A pasted posting. Every field is required and none is guessed.
 *
 * The text has a floor because the whole point is that requirements get read out of it, and a
 * one-line paste would sail through as a posting that "states no requirements" — which then
 * reads downstream as a role with nothing to check rather than one nobody checked. The URL is
 * validated as a URL because it is the dedupe key, and stored without ever being fetched.
 */
const PasteBody = z.object({
  text: z.string().trim().min(40),
  title: z.string().trim().min(1),
  company: z.string().trim().min(1),
  url: z.string().url(),
  readOn: z.string().trim().max(60).optional(),
});

/**
 * What `planQueries` actually reads out of a SearchFilters body.
 *
 * `positionTypes` whole, and six leaves out of the four blocks it opens at all. Everything
 * else in the shape — see the header of packages/shared/src/filters.ts — parses, validates
 * and is then dropped without a word.
 */
const READ_WHOLE = ['positionTypes'];
const PARTLY_READ = ['term', 'location', 'role', 'company'];
const READ_LEAVES = [
  'term.seasons',
  'term.years',
  'location.cities',
  'role.roleFamilies',
  'role.titleIncludes',
  'company.onlyCompanies',
];

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => sameValue(x, b[i]));
  }
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
  return [...keys].every((k) => sameValue(x[k], y[k]));
}

/**
 * The filters this caller set that the plan then ignored.
 *
 * A body with `compensation.paidOnly` or `eligibility.excludeCitizenshipRequired` set came
 * back with exactly the plan an empty body would have produced, and nothing said so — the
 * web app sends no filters, so only an API caller met this, and they met it silently and had
 * to infer it by reading the planner. Naming them is the least this can do until the filters
 * are wired up.
 *
 * Worked out from the body rather than from a hand-written list, so a block or a leaf added
 * to SearchFilters later is reported as ignored by default. That is the safe direction: a
 * filter that is read but listed here reads as an over-warning, a filter that is dropped and
 * not listed reads as a search that quietly did not do what was asked.
 */
function ignoredFilters(filters: SearchFilters): string[] {
  const given = filters as unknown as Record<string, unknown>;
  const fallback = DEFAULT_FILTERS as unknown as Record<string, unknown>;
  const out: string[] = [];

  for (const key of Object.keys(given)) {
    if (READ_WHOLE.includes(key)) continue;

    if (PARTLY_READ.includes(key)) {
      const g = (given[key] ?? {}) as Record<string, unknown>;
      const f = (fallback[key] ?? {}) as Record<string, unknown>;
      for (const leaf of new Set([...Object.keys(g), ...Object.keys(f)])) {
        const path = `${key}.${leaf}`;
        if (READ_LEAVES.includes(path)) continue;
        if (!sameValue(g[leaf], f[leaf])) out.push(path);
      }
      continue;
    }

    if (!sameValue(given[key], fallback[key])) out.push(key);
  }

  return out;
}

/**
 * A resolution, written down, because that is the only way one reaches a plan.
 *
 * `queryPlanner` says a Workday target enters the plan only through an actual resolution,
 * "which arrives here in knownBoards", and knownBoards is built below out of `source` rows.
 * Nothing created a source row from a resolution: `ensureSource` fires once per PERSISTED
 * POSTING inside a run, so a resolved board only became a plan target if the user re-typed
 * it into the run list by hand, ran it, AND that run came back with at least one posting.
 * For Workday, whose adapter searches for "intern" by default, a board resolved outside
 * internship season legitimately returns nothing and could therefore never become a plan
 * target at all, while the planner's own note told the user to "resolve it in Discover to
 * find the right board" for the board they had just resolved.
 *
 * Only boards that positively answered are written. `resolveCompany` no longer reports a
 * vendor whose answer proves nothing, so this cannot mint a row for a board that is not
 * there — which is the thing that would make it worse than the gap it closes.
 *
 * A board with nothing posted today is written down too, and that is deliberate: it is the
 * case this exists for. A run only ever created a row for a board that returned postings,
 * so the boards that could not reach a plan were exactly the quiet ones, and a company's
 * ATS does not stop being its ATS between seasons. The cost is a plan chip that finds
 * nothing until the board fills; the chip names its board, and the source can be switched
 * off in Settings.
 *
 * The select-then-insert is `ensureSource` again, in the one other place that needs it;
 * that function is private to run.ts. Two resolves of the same name racing would write the
 * label twice, as they would through run.ts, and the planner dedupes on `source:board`.
 */
function rememberResolvedBoards(matches: Resolution[]): void {
  for (const m of matches) {
    /**
     * A board found only under the company's FIRST WORD is a guess, and a guess may be
     * shown but never written down.
     *
     * The guard above says this cannot mint a row for a board that is not there, which is
     * true and beside the point: the board is there and belongs to somebody else. "Vector
     * Health" yields the slug "vector", and ashby:vector is a real board with seven real
     * openings at another company. Written here it became an enabled source row the student
     * cannot tell from a real resolution, and the plan chip then stated it as fact — "a
     * board already resolved" — for a company they have never heard of. One press of "Find
     * the boards" did it for up to eight names at once, and the row can only be switched
     * off in Settings, never removed.
     */
    if (!m.fromFullName) continue;
    const label = `${m.source}:${m.board}`;
    const existing = db
      .select({ id: schema.source.id })
      .from(schema.source)
      .where(eq(schema.source.label, label))
      .all();
    if (existing.length > 0) continue;
    db.insert(schema.source).values({ id: ulid(), kind: m.source, label, enabled: true }).run();
  }
}

/**
 * Says out loud which of the boards being returned are guesses.
 *
 * A board found only under the company's FIRST WORD is marked `fromFullName: false` and is
 * otherwise indistinguishable from a confirmed resolution — same shape, same array, same
 * "N open jobs" beside it. Nothing outside this file read that flag: `rememberResolvedBoards`
 * uses it to refuse WRITING the guess down, which fixed what the app does by itself and
 * nothing at all about what it tells the user. Discovery.tsx renders every element of
 * `matches` identically, down to an Add button whose plan target reads "<name>, resolved to
 * this board" — so ashby:vector, which is a real board with real openings belonging to
 * somebody else, reached the student as Vector Health's board, and one press put it into a
 * run under the word "resolved".
 *
 * The guesses stay in `matches`, because they are worth showing — the student can often tell
 * at a glance, and a shape change would drop them from the one client that shows them. What
 * goes in `notes` is the caveat, per board and named, since `notes` is the channel this route
 * already uses for "what the probes could not prove" and Discovery.tsx prints every line of it
 * directly under the board list.
 */
function guessNotes(name: string, matches: Resolution[]): string[] {
  const guesses = matches.filter((m) => !m.fromFullName);
  if (guesses.length === 0) return [];

  const listed = guesses.map((m) => `${m.source}:${m.board}`).join(', ');
  // Both numbers are ordinary here — one press of "Find the boards" resolves up to eight
  // names — so the sentence has to agree either way rather than say "board(s)".
  const one = guesses.length === 1;
  const subject = one ? 'it' : 'they';
  const object = one ? 'it' : 'them';
  const noun = one ? 'That board is' : 'Those boards are';
  return [
    `Found only under the first word of "${name}": ${listed}. A company's first word is ` +
      `frequently another company's whole name, so ${subject} may belong to a different ` +
      `employer — open ${object} and check before adding ${object} to a run. ${noun} not ` +
      'saved as a search target either way.',
  ];
}

export async function discoveryRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Gate G1: discovery is meaningless against an unconfirmed profile, since eligibility
   * would have nothing to check against.
   */
  app.addHook('onRequest', async (req, reply) => {
    // Safe to compare against a literal path because app.ts has already rewritten the
    // target to its one canonical spelling. Before it did, `POST /%61pi/discovery/run`
    // routed here, slipped past this line, and ran a complete discovery run against a
    // profile the user had never confirmed.
    if (!req.url.startsWith('/api/discovery')) return;
    if (!isProfileConfirmed()) {
      return reply.code(409).send({
        error: {
          code: 'PROFILE_NOT_CONFIRMED',
          message: 'Confirm your profile first (gate G1) — eligibility needs something to check.',
        },
      });
    }
  });

  app.post('/api/discovery/run', async (req, reply) => {
    const parsed = RunBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Expected { targets: [{ source, board }] }.',
          details: { issues: parsed.error.issues },
        },
      });
    }
    return runDiscovery(parsed.data.targets as DiscoveryTarget[]);
  });

  app.post('/api/companies/resolve', async (req, reply) => {
    const parsed = ResolveBody.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: { code: 'VALIDATION_FAILED', message: 'Expected { name }.' } });
    }
    const { matches, notes } = await resolveCompany(parsed.data.name);
    rememberResolvedBoards(matches);
    // `notes` carries the vendors that could not be checked at all. Without it an empty
    // `matches` reads as "this company has no board at any vendor we asked", which is a
    // stronger claim than the probes can make for SmartRecruiters.
    //
    // The guess note goes first: it is about a row the reader is looking at and can act on,
    // where the vendor notes are about something absent.
    return {
      name: parsed.data.name,
      matches,
      notes: [...guessNotes(parsed.data.name, matches), ...notes],
    };
  });

  app.get('/api/discovery/stats', async () => postingStats());

  /** The editable plan — shown as chips before a run so the search isn't a black box. */
  app.post('/api/discovery/plan', async (req, reply) => {
    const profile = getProfile();
    if (!profile?.confirmedAt) {
      return reply
        .code(409)
        .send({ error: { code: 'PROFILE_NOT_CONFIRMED', message: 'Confirm your profile first.' } });
    }

    const body = z.object({ filters: SearchFilters.optional() }).safeParse(req.body ?? {});
    if (!body.success) {
      return reply.code(400).send({
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Expected { filters }.',
          details: { issues: body.error.issues },
        },
      });
    }
    const filters = body.data.filters ?? DEFAULT_FILTERS;

    const knownBoards = db
      .select({ label: schema.source.label, kind: schema.source.kind })
      .from(schema.source)
      .where(eq(schema.source.enabled, true))
      .all()
      // Filtered on the source kind the runner actually knows, not on "the label has a
      // colon in it". Pasting a single job URL creates a `manual:pasted` source row, and
      // that heuristic turned it into a permanent plan chip for a source that does not
      // exist — which the run endpoint then rejected outright. The cast that used to sit
      // on `source` hid exactly this mismatch from the type checker.
      // web_search is additionally excluded even though the runner knows it: its source
      // row exists after any run that used it, and a chip born from that row would put a
      // MODEL-SPENDING target into every future plan silently. It costs money each run, so
      // only the Discover screen's button — a deliberate press, labelled with the cost —
      // ever adds it.
      .filter((s) => s.label.includes(':') && s.kind in ALL_SOURCES && s.kind !== 'web_search')
      .map((s) => ({
        source: s.kind as PlannedTarget['source'],
        // Everything after the FIRST colon, not the second field of a split: a Workday
        // board is addressed "tenant@host/site" and any vendor may one day put a colon in
        // a board name, and a split would hand the runner a truncated address that 404s.
        board: s.label.slice(s.label.indexOf(':') + 1),
        // Not "from a previous run" any more: a board resolved on the Discover screen is
        // written down as a source row too, which is what gets a Workday board into a plan.
        reason: 'a board already resolved, by a run or on the Discover screen',
      }));

    const plan = planQueries(profile as ConfirmedProfile, filters, knownBoards);

    const ignored = ignoredFilters(filters);
    if (ignored.length > 0) {
      plan.notes.push(
        `The query planner does not read these filters, so they made no difference to this ` +
          `plan: ${ignored.join(', ')}. It is the plan an empty filter body would have ` +
          'produced for them.',
      );
    }

    return plan;
  });

  app.get<{ Params: { id: string } }>('/api/discovery/runs/:id', async (req, reply) => {
    const run = getRun(req.params.id);
    if (!run) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'No such run.' } });
    }
    return run;
  });

  app.get('/api/discovery/runs', async () => listRuns());

  /**
   * The manual path (docs/04 § Tier C). The user brings a posting from anywhere —
   * including sites this tool deliberately will not crawl.
   */
  app.post('/api/discovery/manual', async (req, reply) => {
    const parsed = ManualBody.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: { code: 'VALIDATION_FAILED', message: 'Expected { url }.' } });
    }
    /**
     * Refused before the request, not after.
     *
     * This route handed whatever URL it was given straight to , so a LinkedIn or
     * Handshake link pasted into the box above made this process contact that host — robots.txt
     * first, then the page — on a screen that tells the student in the very next paragraph
     * that those sites refuse automated readers. The app predicted the refusal and made the
     * request anyway. The message points at the box that does work for those postings.
     */
    if (isAggregatorUrl(parsed.data.url)) {
      return reply
        .code(400)
        .send({ error: { code: 'SOURCE_REFUSED', message: AGGREGATOR_REFUSAL } });
    }

    try {
      const { posting, usedJsonLd, notes } = await fetchManualPosting(parsed.data.url);
      const id = saveManualPosting(posting);
      return { postingId: id, posting, usedJsonLd, notes };
    } catch (err) {
      return reply.code(502).send({
        error: {
          code: 'SOURCE_UNAVAILABLE',
          message: `Could not read that URL: ${(err as Error).message}`,
        },
      });
    }
  });

  /**
   * A posting the user read themselves on a site this tool will not fetch — docs/04 § Tier C.
   *
   * Handshake, LinkedIn and Indeed all prohibit automated access, and Handshake is behind a
   * university login besides. The student reading their own account is not automated access,
   * so this takes the text from THEM. The URL is stored and never fetched: see
   * `readPastedPosting`, which is where the reasoning lives.
   */
  app.post('/api/discovery/paste', async (req, reply) => {
    const parsed = PasteBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Expected { text, title, company, url }.',
          details: { issues: parsed.error.issues },
        },
      });
    }
    // No fetch and no network of any kind on this path, so there is nothing here that can
    // fail the way a fetch fails — a 502 branch would be dead code pretending to be care.
    const { posting, usedJsonLd, notes } = readPastedPosting(parsed.data);
    const id = saveManualPosting(posting);
    return { postingId: id, posting, usedJsonLd, notes };
  });

  app.post('/api/discovery/refresh', async (req, reply) => {
    const body = z
      .object({
        checkUrls: z.boolean().default(false),
        // SQLite reads a negative LIMIT as no limit at all, so `limit: -1` inverted the
        // cap: one request went out and checked every open-or-stale posting URL in the
        // database, rate limiter and all.
        limit: z.number().int().min(1).max(200).default(50),
      })
      .safeParse(req.body ?? {});
    if (!body.success) {
      return reply.code(400).send({
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Expected { checkUrls?, limit? }.',
          details: { issues: body.error.issues },
        },
      });
    }
    return refreshPostings(body.data);
  });

  app.post<{ Params: { id: string } }>('/api/postings/:id/refresh', async (req, reply) => {
    const row = db
      .select()
      .from(schema.jobPosting)
      .where(eq(schema.jobPosting.id, req.params.id))
      .all()[0];
    if (!row) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'No such posting.' } });
    }
    const summary = await refreshPostings({ checkUrls: true, postingId: req.params.id });
    const after = db
      .select({ isOpen: schema.jobPosting.isOpen })
      .from(schema.jobPosting)
      .where(eq(schema.jobPosting.id, req.params.id))
      .all()[0];
    return { isOpen: after?.isOpen ?? row.isOpen, summary };
  });

  /** Which sources exist, whether they need a key, and whether that key is present. */
  app.get('/api/sources/available', async () =>
    Object.entries(ALL_SOURCES).map(([name, s]) => ({
      name,
      requiresKey: s.requiresKey,
      configured: s.isConfigured(),
    })),
  );

  app.put<{ Params: { id: string } }>('/api/sources/:id', async (req, reply) => {
    const body = z.object({ enabled: z.boolean() }).safeParse(req.body);
    if (!body.success) {
      return reply
        .code(400)
        .send({ error: { code: 'VALIDATION_FAILED', message: 'Expected { enabled }.' } });
    }
    const row = db
      .select({ id: schema.source.id })
      .from(schema.source)
      .where(eq(schema.source.id, req.params.id))
      .all()[0];
    if (!row) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'No such source.' } });
    }

    db.update(schema.source)
      .set({ enabled: body.data.enabled })
      .where(eq(schema.source.id, req.params.id))
      .run();
    return { id: req.params.id, enabled: body.data.enabled };
  });

  app.get('/api/postings', async (req, reply) => {
    const q = z
      .object({ limit: z.coerce.number().int().min(1).max(200).default(50) })
      .safeParse(req.query ?? {});
    if (!q.success) {
      return reply.code(400).send({
        error: { code: 'VALIDATION_FAILED', message: 'Expected a limit between 1 and 200.' },
      });
    }

    return db
      .select({
        id: schema.jobPosting.id,
        company: schema.jobPosting.company,
        title: schema.jobPosting.title,
        canonicalUrl: schema.jobPosting.canonicalUrl,
        positionType: schema.jobPosting.positionType,
        workArrangement: schema.jobPosting.workArrangement,
        term: schema.jobPosting.term,
        compensation: schema.jobPosting.compensation,
        locations: schema.jobPosting.locations,
        atsVendor: schema.jobPosting.atsVendor,
        isOpen: schema.jobPosting.isOpen,
        firstSeenAt: schema.jobPosting.firstSeenAt,
      })
      .from(schema.jobPosting)
      .orderBy(desc(schema.jobPosting.firstSeenAt))
      .limit(q.data.limit)
      .all();
  });

  app.get('/api/sources', async () => {
    return db
      .select({
        id: schema.source.id,
        kind: schema.source.kind,
        label: schema.source.label,
        enabled: schema.source.enabled,
        lastRunAt: schema.source.lastRunAt,
        postings: sql<number>`(
          SELECT count(*) FROM job_posting_source jps WHERE jps.source_id = ${schema.source.id}
        )`,
      })
      .from(schema.source)
      .all();
  });
}
