import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SourceKind } from '@ia/shared';
import {
  accessBadge,
  alreadyStored,
  boardMeaning,
  durationLabel,
  keylessTargets,
  mergeTargets,
  needsBoard,
  runHeadline,
  sourceLabel,
  unavailableReason,
  splitCompanies,
  targetKey,
  whenLabel,
  whyCannotRun,
  type AvailableSource,
  type RunSummary,
  type RunTarget,
} from '../src/lib/discovery';
import { retryLabel, scoredLine, scoringFailed } from '../src/pages/Discovery';

/**
 * The pure helpers behind the Discover screen.
 *
 * Everything here decides something the user then spends real requests on — which boards a
 * run fetches, whether the Run button is live, and what the summary says happened — so each
 * one is decidable in a test rather than only by pressing the button and watching.
 */

function target(over: Partial<RunTarget> = {}): RunTarget {
  return { source: 'greenhouse', board: 'acme', reason: 'resolved', ...over };
}

function summary(over: Partial<RunSummary> = {}): RunSummary {
  return {
    runId: 'r1',
    startedAt: '2026-08-11T10:00:00.000Z',
    finishedAt: '2026-08-11T10:00:12.000Z',
    targets: 1,
    found: 0,
    new: 0,
    duplicates: 0,
    bySource: [],
    skipped: [],
    ...over,
  };
}

describe('mergeTargets', () => {
  it('refuses a board already in the list, whatever brought it there', () => {
    // The planner knows boards a previous run resolved, and "Find their boards" resolves
    // the same company by hand. Sending greenhouse:acme twice fetches it twice, counts it
    // twice in `found`, and files the second copy under duplicates — so the report reads
    // as though the board had answered one query with another query's jobs.
    const list = mergeTargets(
      [target({ reason: 'already resolved from a previous run' })],
      [target({ reason: 'company you pinned' })],
    );
    expect(list).toHaveLength(1);
    expect(list[0]!.reason).toBe('already resolved from a previous run');
  });

  it('tells two vendors of the same company apart', () => {
    const list = mergeTargets(
      [target({ source: 'greenhouse', board: 'acme' })],
      [target({ source: 'lever', board: 'acme' })],
    );
    expect(list.map(targetKey)).toEqual(['greenhouse:acme', 'lever:acme']);
  });

  it('keeps the order things were added in', () => {
    const list = mergeTargets(
      [target({ board: 'a' })],
      [target({ board: 'b' }), target({ board: 'a' }), target({ board: 'c' })],
    );
    expect(list.map((t) => t.board)).toEqual(['a', 'b', 'c']);
  });

  it('leaves the list it was given alone', () => {
    const before = [target({ board: 'a' })];
    mergeTargets(before, [target({ board: 'b' })]);
    expect(before).toHaveLength(1);
  });
});

describe('splitCompanies', () => {
  it('accepts commas, semicolons and one per line', () => {
    expect(splitCompanies('Figma, Stripe; Anthropic\nLinear')).toEqual([
      'Figma',
      'Stripe',
      'Anthropic',
      'Linear',
    ]);
  });

  it('drops a repeat regardless of case, keeping the spelling first written', () => {
    // The planner turns each unresolved name into five unverified board guesses, so a
    // list holding both spellings spends ten of a forty-target cap on one company.
    expect(splitCompanies('Stripe, stripe, STRIPE')).toEqual(['Stripe']);
  });

  it('is empty for whitespace and stray separators', () => {
    expect(splitCompanies('')).toEqual([]);
    expect(splitCompanies('   ')).toEqual([]);
    expect(splitCompanies(',,;\n , ')).toEqual([]);
  });
});

describe('whyCannotRun', () => {
  it('will not send an empty list, which the server answers with a 400', () => {
    expect(whyCannotRun([])).toMatch(/Nothing to search/);
  });

  it('refuses a company board with no board name', () => {
    // All six ATS vendors answer an empty board with a note rather than an error — "no
    // board token supplied" — so the target costs a slot, reports zero found, and looks
    // from the outside like a company with nothing open. Workday, SmartRecruiters and
    // Workable were waved through for the whole of the change that added them.
    for (const source of [
      'greenhouse',
      'lever',
      'ashby',
      'workday',
      'smartrecruiters',
      'workable',
    ]) {
      expect(needsBoard(source)).toBe(true);
      expect(whyCannotRun([target({ source, board: '' })])).toMatch(/no board name/);
      expect(whyCannotRun([target({ source, board: '   ' })])).toMatch(/no board name/);
    }
  });

  it('allows the sources that never take one', () => {
    for (const source of ['github_list', 'adzuna', 'usajobs', 'arbeitnow', 'remotive']) {
      expect(needsBoard(source)).toBe(false);
      expect(whyCannotRun([target({ source, board: '' })])).toBeNull();
    }
  });

  it('holds the list to the ceiling the run endpoint declares', () => {
    const many = Array.from({ length: 201 }, (_, i) => target({ board: `b${String(i)}` }));
    expect(whyCannotRun(many)).toMatch(/at most 200/);
    expect(whyCannotRun(many.slice(0, 200))).toBeNull();
  });
});

describe('runHeadline', () => {
  it('accounts for every posting fetched', () => {
    // "412 fetched, 3 new" on its own reads as though 409 postings went missing. They were
    // stored by an earlier run, which is the ordinary outcome of searching a board twice.
    const s = summary({ found: 412, new: 3, duplicates: 9 });
    expect(alreadyStored(s)).toBe(400);
    expect(runHeadline(s)).toBe('412 postings fetched · 3 new · 400 already stored · 9 merged');
  });

  it('says none rather than zero when a run turned up nothing unseen', () => {
    expect(runHeadline(summary({ found: 40, new: 0 }))).toBe(
      '40 postings fetched · none new · 40 already stored',
    );
  });

  it('does not claim a posting was already stored when the arithmetic goes the other way', () => {
    // `found` counts what the adapters returned and `new` counts rows inserted; a posting
    // pasted by URL between the fetch and the insert is enough to make new exceed the gap,
    // and a negative "-1 already stored" would be a nonsense the user has to explain.
    expect(alreadyStored(summary({ found: 2, new: 3 }))).toBe(0);
    expect(runHeadline(summary({ found: 2, new: 3 }))).toBe('2 postings fetched · 3 new');
  });

  it('counts one posting in the singular', () => {
    expect(runHeadline(summary({ found: 1, new: 1 }))).toBe('1 posting fetched · 1 new');
  });

  it('says plainly when every source came back with nothing', () => {
    expect(runHeadline(summary())).toBe('No source returned a posting.');
  });
});

describe('durationLabel', () => {
  it('picks the unit that reads', () => {
    const at = (ms: number): string =>
      durationLabel(
        '2026-08-11T10:00:00.000Z',
        new Date(Date.parse('2026-08-11T10:00:00.000Z') + ms).toISOString(),
      );
    expect(at(420)).toBe('420ms');
    expect(at(12_000)).toBe('12s');
    expect(at(95_000)).toBe('1m 35s');
  });

  it('says so rather than inventing a number it cannot compute', () => {
    expect(durationLabel('whenever', '2026-08-11T10:00:00.000Z')).toBe('unknown');
    expect(durationLabel('2026-08-11T10:00:12.000Z', '2026-08-11T10:00:00.000Z')).toBe('unknown');
  });
});

describe('whenLabel', () => {
  const ago = (ms: number): string => whenLabel(new Date(Date.now() - ms).toISOString());

  it('answers in the coarsest unit that still answers the question', () => {
    expect(ago(5_000)).toBe('just now');
    expect(ago(7 * 60_000)).toBe('7m ago');
    expect(ago(3 * 3_600_000)).toBe('3h ago');
    expect(ago(30 * 3_600_000)).toBe('yesterday');
    expect(ago(5 * 86_400_000)).toBe('5d ago');
  });

  it('does not read a clock that moved as a run from the future', () => {
    expect(ago(-60_000)).toBe('just now');
  });

  it('does not print an unreadable timestamp back at the user', () => {
    expect(whenLabel('whenever')).toBe('at an unknown time');
  });
});

describe('the source table', () => {
  /**
   * Derived from the shared enum, never from a list written here.
   *
   * The version of this block that named three sources by hand was titled "names every
   * source the runner knows" and stayed green through the change that shipped Workday,
   * SmartRecruiters, Workable, Arbeitnow and Remotive — five sources with no label and no
   * board meaning, one of them rendering as the raw word "workday" in the Sources card of
   * section 01, which lists whatever /api/sources/available returns. A test that asserts a
   * fallback rather than the registry lets the next new source through the same way.
   */
  const KINDS = SourceKind.options;

  it('names every source kind the product has, and passes an unknown one through', () => {
    for (const kind of KINDS) {
      expect(sourceLabel(kind), `${kind} has no label`).not.toBe(kind);
    }
    expect(sourceLabel('github_list')).toBe('Community list');
    expect(sourceLabel('usajobs')).toBe('USAJOBS');
    expect(sourceLabel('smartrecruiters')).toBe('SmartRecruiters');
    expect(sourceLabel('something_new')).toBe('something_new');
  });

  it('says what the board field means for every kind, so an empty box is never a mystery', () => {
    for (const kind of KINDS) {
      expect(boardMeaning(kind), `${kind} has no board meaning`).not.toBe('a board name');
    }
    expect(boardMeaning('greenhouse')).toMatch(/Greenhouse board URL/);
    expect(boardMeaning('adzuna')).toMatch(/not used/);
    expect(boardMeaning('github_list')).toMatch(/upcoming season/);
    // Not "a board name": a Workday board is a tenant, a host and a site name, and a box
    // that says "a board name" for that address invites a slug that fetches nothing.
    expect(boardMeaning('workday')).toMatch(/tenant@host\/site/);
  });

  it('guards exactly the vendors whose adapters refuse an empty board', () => {
    // The six fetches in sources/ats.ts that open with noBoard(). Every other kind either
    // searches by keyword or carries its address some other way.
    const refuses = new Set([
      'greenhouse',
      'lever',
      'ashby',
      'workday',
      'smartrecruiters',
      'workable',
    ]);
    for (const kind of KINDS) {
      expect(needsBoard(kind), `needsBoard disagrees with the ${kind} adapter`).toBe(
        refuses.has(kind),
      );
    }
    expect(needsBoard('something_new')).toBe(false);
  });
});

describe('the resolve response', () => {
  const read = (rel: string) =>
    readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), rel), 'utf8');

  /**
   * The server returns `{ name, matches, notes }` and the notes are half the answer: an empty
   * `matches` reads as "no vendor has a board under this name", and the server says in a note
   * that it cannot make that claim for SmartRecruiters, which answers a name it has never
   * heard of exactly as it answers a real company with nothing posted. The client typed the
   * response as `{ name, matches }` and `findBoards` kept only those two, so the sentence that
   * qualifies the result never reached the screen and the screen stated the strong claim.
   */
  it('keeps the notes the server sends', () => {
    const lib = read('../src/lib/discovery.ts');
    expect(lib).toMatch(/resolveCompany[\s\S]{0,200}notes: string\[\]/);

    const page = read('../src/pages/Discovery.tsx');
    // Carried through the state that backs the list, not just typed at the boundary.
    expect(page).toMatch(/notes: r\.notes/);
    expect(page).toMatch(/notes\.map\(/);
  });

  /**
   * Rendered in both branches. The server pushes the SmartRecruiters note whenever that
   * vendor was found under no slug candidate, which happens just as often on a name that
   * resolved somewhere else, so hanging the notes off the empty branch alone would drop them
   * exactly when another board answered.
   */
  it('does not hide the notes behind the empty-result branch', () => {
    // Scoped to the resolution card. The page renders `plan.notes` and `manual.notes`
    // elsewhere, and an unscoped search finds one of those instead.
    const card = read('../src/pages/Discovery.tsx').slice(
      read('../src/pages/Discovery.tsx').indexOf('matches.length === 0 ? ('),
    );
    const emptyBranch = card.slice(0, card.indexOf(') : ('));
    expect(emptyBranch).not.toMatch(/notes\.map\(/);

    const notesAt = card.indexOf('notes.map(');
    const closesList = card.indexOf('</ul>', card.indexOf('matches.map('));
    expect(notesAt).toBeGreaterThan(closesList);
  });

  /** And the empty branch may not claim more than the probes can prove. */
  it('does not say that none of the vendors has a board', () => {
    const page = read('../src/pages/Discovery.tsx');
    expect(page).not.toMatch(/None of the six vendors/);
    expect(page).toMatch(/No board answered under that name/);
  });
});

describe('keylessTargets', () => {
  const source = (name: string, requiresKey = false): AvailableSource => ({
    name,
    requiresKey,
    configured: true,
  });

  it('offers every source that needs neither a key nor a board', () => {
    // The hard-coded version of this row offered the community list alone and went on
    // doing so after Arbeitnow shipped, so a run built by hand searched a keyless feed
    // fewer than the tool had and said nothing about it.
    //
    // Remotive is keyless and board-free and is deliberately NOT offered: its robots.txt
    // refuses the path its adapter reads, so a one-press button for it answers every press
    // with a refusal. It is excluded by having no `addReason`, which is what the filter now
    // tests — it used to test mere presence in the facts table, so removing the reason left
    // the button rendering under a fabricated caption.
    const list = keylessTargets([
      source('greenhouse'),
      source('workday'),
      source('adzuna', true),
      source('usajobs', true),
      source('arbeitnow'),
      source('remotive'),
      source('github_list'),
    ]);
    expect(list.map((t) => t.source)).toEqual(['github_list', 'arbeitnow']);
    expect(list.every((t) => t.board === '')).toBe(true);
    expect(list.every((t) => t.reason !== '')).toBe(true);
  });

  it('offers the community list before the source read lands, and if it fails', () => {
    // A fresh install has nothing else, and the button that adds it must not wait on a
    // fetch that may never answer.
    expect(keylessTargets(null).map((t) => t.source)).toEqual(['github_list']);
    expect(keylessTargets([]).map((t) => t.source)).toEqual(['github_list']);
  });

  it('does not offer the community list twice when the server also reports it', () => {
    const list = keylessTargets([source('github_list'), source('arbeitnow')]);
    expect(list.map((t) => t.source)).toEqual(['github_list', 'arbeitnow']);
  });

  /**
   * Not offered at all, which is stronger than the blank-reason guard this replaced.
   *
   * `needsBoard` answers false for a name the table has never heard of — the right way to be
   * wrong when LABELLING something, and wrong as a filter: an unrecognised source got a
   * one-press button, was added with an empty board, passed the run guard, and reached the
   * adapter's own "no board was supplied" path, under a reason line inventing that it is
   * "searched without a company". A source this file cannot describe is one it cannot
   * honestly offer in a single press.
   */
  it('does not offer a one-press button for a source it has never heard of', () => {
    const offered = keylessTargets([source('some_new_feed'), source('arbeitnow')]);
    expect(offered.map((t) => t.source)).toEqual(['github_list', 'arbeitnow']);
  });

  /** It still appears everywhere the fallback label is the honest answer. */
  it('still labels an unknown source rather than blanking it', () => {
    expect(sourceLabel('some_new_feed')).toBe('some_new_feed');
    expect(boardMeaning('some_new_feed')).toBe('a board name');
  });

  it('produces targets the Run button accepts', () => {
    expect(whyCannotRun(keylessTargets([source('arbeitnow'), source('remotive')]))).toBeNull();
  });
});

describe('accessBadge', () => {
  const src = (over: Partial<AvailableSource>): AvailableSource => ({
    name: 'adzuna',
    requiresKey: true,
    configured: false,
    ...over,
  });

  it('says what web search actually needs, which is not a key', () => {
    // "key set" about a signed-in Claude Code CLI would describe a credential that does
    // not exist; "no key" would send the user hunting for one that is not the fix.
    expect(accessBadge(src({ name: 'web_search', configured: true }))).toBe('model access');
    expect(accessBadge(src({ name: 'web_search', configured: false }))).toBe('no model access');
  });

  it('keeps the key words for the sources that really take one', () => {
    expect(accessBadge(src({ configured: true }))).toBe('key set');
    expect(accessBadge(src({ configured: false }))).toBe('no key');
  });

  it('says no key needed for the keyless ones', () => {
    expect(accessBadge(src({ name: 'github_list', requiresKey: false }))).toBe('no key needed');
  });
});

describe('a source that cannot contribute at all', () => {
  const source = (name: string, requiresKey = false): AvailableSource => ({
    name,
    requiresKey,
    configured: !requiresKey,
  });

  it('is not offered as a one-press button, however keyless it is', () => {
    // Remotive passes every other test keylessTargets applies — no key, no board, known to
    // the facts table — and its adapter still refuses before it sends a request. The gate is
    // `addReason`: a source nobody has written a reason to offer has no one-press offer.
    const list = keylessTargets([source('remotive'), source('github_list')]);
    expect(list.map((t) => t.source)).not.toContain('remotive');
  });

  it('says why, where the source is listed', () => {
    // The limitation is not deleted along with the button. A run failing is not the only
    // place a coverage gap may be admitted, and it is the worst one.
    expect(unavailableReason('remotive')).toMatch(/declines automated reads/i);
    expect(unavailableReason('github_list')).toBeNull();
  });

  it('never captions an offer with a search that will not happen', () => {
    // The fallback reason read "…, searched without a company", which was a claim, and false
    // for the one source that ever reached it.
    for (const t of keylessTargets([source('github_list'), source('arbeitnow')])) {
      expect(t.reason, t.source).not.toMatch(/searched without a company/);
    }
  });
});

/**
 * The two halves of one press, told apart.
 *
 * "Search and score" runs a search and then a scoring pass, and the scoring failure is
 * caught rather than thrown on purpose — the search's postings are stored and losing that
 * report to an error from the step after it would throw away the expensive half. The catch
 * was the whole fix; drawing its sentence was not.
 */
describe('the report a scoring pass leaves behind', () => {
  it('reads back what was scored, in the one sentence both callers now share', () => {
    // `run` and `score` each built this from their own template literal, a word apart from
    // drifting.
    const r = scoredLine({ matched: 31, eligible: 12, unknown: 7, ineligible: 12 });
    expect(r.ok).toBe(true);
    expect(r.message).toBe('31 scored — 12 eligible, 7 to check, 12 filtered.');
  });

  it('does not report a scoring FAILURE as good news', () => {
    // Both lines went into `<Notice tone="verified">`, so "scoring them did not run" arrived
    // in the green tint, inside the block a user reads as the receipt for a run they have
    // just waited two minutes for.
    const r = scoringFailed(new Error('fetch failed'));
    expect(r.ok).toBe(false);
    expect(r.message).toContain('fetch failed');
  });

  it('says the search itself survived, so nobody re-runs the expensive half', () => {
    const message = scoringFailed(new Error('boom')).message;
    expect(message).toMatch(/postings are stored/);
    expect(message).toMatch(/Score what is stored/);
  });

  it('reads a thrown non-Error rather than printing [object Object] at the user', () => {
    expect(scoringFailed('gateway timed out').message).toContain('gateway timed out');
  });
});

describe('where that line is drawn', () => {
  const page = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/pages/Discovery.tsx'),
    'utf8',
  );

  it('takes its tone from the outcome, at BOTH places the state prints', () => {
    // Section 04's run summary and section 05's pasted-posting card render the same `scored`
    // state, each with the tone hard-coded. Fixing one leaves the Tier C user — the one who
    // only ever pastes a posting, and so meets scoring nowhere else — with the green failure.
    expect(page).not.toMatch(/tone="verified">\{scored\}/);
    expect((page.match(/scored\.ok \? 'verified'/g) ?? []).length).toBe(2);
  });
});

describe('retryLabel', () => {
  it('names the action the button is about to run again', () => {
    // A run costs a fan-out of real requests to third-party APIs, so the control that starts
    // one over says so before it is pressed.
    expect(retryLabel({ label: 'Searching' })).toBe('Try searching again');
    expect(retryLabel({ label: 'Probing the boards' })).toBe('Try probing the boards again');
    expect(retryLabel({ label: 'Scoring' })).toBe('Try scoring again');
    expect(retryLabel({ label: 'Reading the page' })).toBe('Try reading the page again');
    expect(retryLabel({ label: 'Storing what you pasted' })).toBe(
      'Try storing what you pasted again',
    );
  });

  it('keeps the plain wording when the failure was one of the four reads', () => {
    // There the re-read IS the retry, and naming it would be a distinction without one.
    expect(retryLabel(null)).toBe('Try again');
  });
});

/**
 * The banner's own button.
 *
 * It called `refresh(pinned)` whatever had failed — the four reads, and `setError(null)`
 * first. So a search that died after ninety seconds, a probe that timed out and a pasted URL
 * that came back 404 all answered "Try again" by wiping the red banner and re-counting the
 * stored postings. Nothing was retried, and clearing the only evidence of the failure is how
 * a thing that did not happen comes to look like a thing that did.
 */
describe('"Try again" on Discover', () => {
  const page = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/pages/Discovery.tsx'),
    'utf8',
  );

  it('runs the action that failed rather than re-reading the page', () => {
    const banner = page.slice(page.indexOf('{error && ('), page.indexOf('role="status"'));
    expect(banner).toMatch(/guarded\(retry\.label, retry\.work\)/);
    expect(banner).toMatch(/retryLabel\(retry\)/);
  });

  it('records the retry inside `guarded`, which is what covers all five spending actions', () => {
    // At the call sites this would have been five separate fixes and the next action added
    // would have been a sixth omission. `guarded` is the one door the probe, the run, the
    // scoring, the URL read and the pasted posting all go through.
    expect(page).toMatch(/catch \(err\) \{[\s\S]{0,400}setRetry\(\{ label, work \}\)/);
    // Five labelled call sites, all of them spending something. If a sixth is added it goes
    // through the same door and is retryable the day it lands.
    expect((page.match(/guarded\('/g) ?? []).length).toBe(5);
  });

  it('still falls back to a re-read when it was a read that failed', () => {
    expect(page).toMatch(/else refresh\(pinned\)/);
  });
});
