/**
 * The loop between resolving a company and planning a run, over the wire.
 *
 * `queryPlanner` states that a Workday target enters the plan only through an actual
 * resolution, "which arrives here in knownBoards", and docs/04 repeats it. Nothing built
 * that route: knownBoards comes from `source` rows, and the only writer of those is
 * `ensureSource`, which fires once per PERSISTED POSTING inside a run. So a resolved board
 * became a plan target only if the user retyped it into the run list by hand, ran it, and
 * that run came back with at least one posting — and for Workday, whose adapter searches
 * for "intern", a board resolved outside internship season legitimately returns nothing and
 * could never enter a plan at all, while the plan's own note told the user to go and
 * resolve the board they had just resolved.
 *
 * These go through `app.inject` rather than calling the route bodies, because the defect
 * was in the wiring between two routes and reading either one alone showed nothing wrong.
 * `globalThis.fetch` is replaced, so no test here reaches the network.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { CandidateProfile } from '@ia/shared';
import { buildApp } from '../src/app';
import { runMigrations } from '../src/infra/db/migrate';
import { saveProfile } from '../src/core/profile/repository';

const realFetch = globalThis.fetch;
let app: FastifyInstance;

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

/**
 * One Workday tenant and nothing else anywhere. SmartRecruiters answers what it really
 * answers for an id it has no company for, which is also what it answers for a company with
 * nothing posted: 200 and `totalFound: 0`.
 */
function install(): void {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    if (url === 'https://wdcorp.wd1.myworkdayjobs.com/wday/cxs/wdcorp/External/jobs') {
      return Promise.resolve(json({ total: 57, jobPostings: [{ title: 'Intern' }] }));
    }
    if (url.includes('api.smartrecruiters.com')) {
      return Promise.resolve(json({ offset: 0, limit: 1, totalFound: 0, content: [] }));
    }
    // A real board at somebody else's company, reachable only through the first word of a
    // two-word name. See the "first word" test below.
    if (url === 'https://api.ashbyhq.com/posting-api/job-board/vector') {
      return Promise.resolve(json({ jobs: [{ id: 1 }, { id: 2 }] }));
    }
    return Promise.resolve(new Response('Not Found', { status: 404 }));
  }) as typeof globalThis.fetch;
}

const CONFIRMED = {
  id: 'prof_discovery_route',
  fullName: 'Rosa Alvarez',
  pronouns: null,
  email: 'rosa@example.edu',
  dateOfBirth: '2006-03-15',
  address: { country: 'US' },
  links: { other: [] },
  workAuthorization: { country: 'US', status: 'citizen', needsSponsorship: false },
  citizenships: ['US'],
  education: [],
  experience: [],
  projects: [],
  skills: [],
  certifications: [],
  languages: [],
  availability: { start: '2027-06-01', end: '2027-08-20', flexible: true },
  locationPrefs: {
    base: { city: 'New Brunswick', region: 'NJ', country: 'US' },
    additionalBases: [],
    maxCommuteKm: 50,
    remoteOk: true,
    hybridOk: true,
    relocateTo: [],
  },
  preferences: { companySizes: [], roleFamilies: [], industries: [], excludeCompanies: [] },
  derived: {
    age: 20,
    isMinor: false,
    academicLevel: 'undergrad',
    academicYear: 2,
    expectedGraduation: '2028-05',
    yearsProfessionalExperience: 0,
    seniorityBand: 'entry_intern',
  },
  confirmedAt: '2026-08-03T00:00:00Z',
  needsReview: [],
  createdAt: '2026-08-03T00:00:00Z',
  updatedAt: '2026-08-03T00:00:00Z',
} as unknown as CandidateProfile;

interface Plan {
  targets: Array<{ source: string; board: string; reason: string }>;
  notes: string[];
}

const plan = async (onlyCompanies: string[] = []): Promise<Plan> => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/discovery/plan',
    payload: {
      filters: {
        term: { seasons: ['summer'], years: [2027] },
        positionTypes: ['internship'],
        role: { roleFamilies: [], titleIncludes: [], titleExcludes: [] },
        location: { cities: [], remote: true },
        company: { onlyCompanies, excludeCompanies: [] },
      },
    },
  });
  expect(res.statusCode, res.body).toBe(200);
  return JSON.parse(res.body) as Plan;
};

beforeAll(async () => {
  runMigrations();
  saveProfile(CONFIRMED);
  install();
  app = await buildApp({ skipAuth: true });
  await app.ready();
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await app.close();
});

describe('POST /api/companies/resolve, then POST /api/discovery/plan', () => {
  it('puts the resolved Workday board in the plan, addressed tenant@host/site', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/companies/resolve',
      payload: { name: 'Wdcorp' },
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = JSON.parse(res.body) as {
      matches: Array<{ source: string; board: string; jobCount: number; fromFullName: boolean }>;
      notes: string[];
    };
    expect(body.matches).toEqual([
      { source: 'workday', board: 'wdcorp@wd1/External', jobCount: 57, fromFullName: true },
    ]);
    // The vendor that cannot be checked is named, so an answer of one board does not read
    // as "and nowhere else".
    expect(body.notes.join(' ')).toMatch(/SmartRecruiters/);

    // The plan, with no run in between and no posting ever persisted.
    const workday = (await plan()).targets.filter((t) => t.source === 'workday');
    expect(workday).toEqual([
      {
        source: 'workday',
        board: 'wdcorp@wd1/External',
        reason: 'a board already resolved, by a run or on the Discover screen',
      },
    ]);
  });

  it('promotes it to the pinned company that owns the tenant, and stops telling them to resolve it', async () => {
    const pinned = await plan(['Wdcorp']);
    expect(pinned.targets.filter((t) => t.board !== '')).toEqual([
      {
        source: 'workday',
        board: 'wdcorp@wd1/External',
        reason: 'company you pinned (its Workday board)',
      },
    ]);
    // The note that used to run beside the resolved board: five unverified guesses, and
    // advice to go and resolve a board the user had already resolved.
    expect(pinned.notes.join(' ')).not.toMatch(/no resolved board yet/i);
  });

  it('writes down no board for a name nothing answered for', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/companies/resolve',
      payload: { name: 'Nowherecorp' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect((JSON.parse(res.body) as { matches: unknown[] }).matches).toEqual([]);

    // SmartRecruiters answered 200 for that name, as it does for every name. If that were
    // still read as a board, this plan would carry a permanent target for a board that does
    // not exist, and every name ever typed into Discover would leave one behind.
    const after = await plan();
    expect(after.targets.filter((t) => t.board.includes('nowherecorp'))).toEqual([]);
  });

  /**
   * The first word of a two-word name is somebody else's whole name. "Vector Health" yields
   * the slug "vector", and ashby:vector is a real board with real openings at a different
   * company — so the write guard cannot be "only boards that answered", which this one does.
   * It is shown, because it may be the right board and the student can see at a glance; it
   * is not written down, because a row here becomes an enabled search target the student
   * cannot tell from a real resolution and can only switch off in Settings, never remove.
   */
  it('shows a board found only under the first word, and writes down none of it', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/companies/resolve',
      payload: { name: 'Vector Health' },
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = JSON.parse(res.body) as {
      matches: Array<{ source: string; board: string; fromFullName: boolean }>;
      notes: string[];
    };
    expect(body.matches).toEqual([
      { source: 'ashby', board: 'vector', jobCount: 2, fromFullName: false },
    ]);

    const after = await plan();
    expect(after.targets.filter((t) => t.board === 'vector')).toEqual([]);

    /**
     * And it SAYS so, naming the board.
     *
     * `fromFullName` rode in the response and no consumer read it — Discovery.tsx renders
     * every element of `matches` identically, vendor, board, "2 open jobs" and an Add button
     * whose plan target reads "Vector Health, resolved to this board". So the guess reached
     * the student as a resolution and one press put somebody else's board into a run. `notes`
     * is the one channel that screen prints verbatim under the list.
     */
    const note = body.notes.find((n) => n.includes('ashby:vector'));
    expect(note, body.notes.join(' | ')).toBeTruthy();
    expect(note).toMatch(/first word/i);
  });

  it('says nothing about first words when the full name is what answered', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/companies/resolve',
      payload: { name: 'Wdcorp' },
    });
    expect(res.statusCode, res.body).toBe(200);
    // The caveat has to be absent from a confirmed resolution, or it is noise on every
    // answer and the reader stops reading it — which is where the unread flag started.
    expect((JSON.parse(res.body) as { notes: string[] }).notes.join(' ')).not.toMatch(
      /first word/i,
    );
  });
});
