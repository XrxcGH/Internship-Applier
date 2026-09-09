/**
 * The documents, checked against the code instead of against a memory of the code.
 *
 * README.md said "505 tests" for four commits after the suite had passed a thousand, and
 * docs/04 described a "16-family taxonomy" that had grown to 21, a `resolveCompany` domain
 * fallback that was never built, and a stage-2 fingerprint built from `normalizeTitle` when
 * the code had moved to `fingerprintTitle`. Every one of those drifted silently because
 * nothing in apps/server/test, apps/web/test or packages/shared/test opened a .md file, so
 * a wrong number in a document cost nothing until a reader believed it.
 *
 * The rule this file follows: a countable claim in a document is asserted against whatever
 * in the code DETERMINES the number, never against a second copy of the number. Where the
 * value is exported it is imported and measured; where it is a module-private constant the
 * declaration itself is matched, so moving the constant is what breaks the test rather than
 * a paraphrase in the prose.
 *
 * One claim is deliberately absent: the size of this test suite. Counting the tests from
 * inside the tests is circular, it would fail on every commit that adds a case, and a
 * green-but-meaningless assertion is worse than no assertion. The README no longer states
 * a test count at all — it points at `npm test`, which answers the question honestly at the
 * moment it is asked — and the first check below is what keeps a number from creeping back.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ConfirmedProfile, SearchFilters } from '@ia/shared';
import { ROLE_TAXONOMY, planQueries } from '../src/core/discovery/queryPlanner';
import { ALL_SOURCES } from '../src/core/discovery/run';
import { canonicalUrl, fingerprintTitle, normalizeTitle } from '../src/core/discovery/normalize';
import { ATS_SOURCES, internshipShaped } from '../src/core/discovery/sources/ats';
import { AGGREGATOR_SOURCES } from '../src/core/discovery/sources/aggregators';
import { slugCandidates } from '../src/core/discovery/resolveCompany';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * Line endings normalised on the way in.
 *
 * Several checks below parse structure rather than prose: a fenced block opened with a
 * newline, a declaration matched across lines. This repo is developed on Windows, where an
 * ordinary edit can rewrite a file from LF to CRLF without changing a word of it, and a pin
 * that goes red because a line ending changed is a false alarm. False alarms are how a suite
 * of documentation checks stops being read.
 */
function read(rel: string): string {
  return readFileSync(path.join(REPO_ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
}

/**
 * Markdown here is hard-wrapped at 96 columns, so a sentence is routinely split across two
 * lines and "21-family\ntaxonomy" would not match a regex written the way the phrase reads.
 * Every prose assertion runs against the whitespace-collapsed form, or a harmless reflow
 * would look like a fact changing.
 */
function flat(md: string): string {
  return md.replace(/\s+/g, ' ');
}

function walk(dir: string, keep: RegExp): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : walk(full, keep);
    return keep.test(e.name) ? [full] : [];
  });
}

const README = read('README.md');
const DOC04 = read('docs/04-job-discovery.md');
const FLAT_README = flat(README);
const FLAT_DOC04 = flat(DOC04);

/** Spelled-out counts in the prose, so "Six of those ship today" can be measured. */
const WORD_NUMBERS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
};

/**
 * Does this stretch of prose name that source kind?
 *
 * Most kinds are ordinary words in the document — "Arbeitnow", "SmartRecruiters" — and the
 * kind is the word lowercased. The community list is the exception: it is named for the
 * people who maintain it rather than for its kind, so the document writes the identifier in
 * backticks beside the name and that spelling counts too.
 */
function namesSource(text: string, kind: string): boolean {
  return new RegExp(`\\b${kind.replace('_', '[ _]')}\\b|\`${kind}\``, 'i').test(text);
}

/** The items of a written list — "Greenhouse, Lever and Ashby" — as three strings. */
function listedItems(prose: string): string[] {
  return prose
    .split(/,| and /)
    .map((s) => s.trim())
    .filter(Boolean);
}

describe('README.md', () => {
  /**
   * The anti-drift guard, and the reason this file exists at all. "505 tests" was wrong for
   * four commits; its replacement, "1249 tests across 42 files", was wrong within the hour
   * (46 files by the time the audit ran) and put TWO volatile numbers in the sentence where
   * there had been one. A count of the suite cannot be checked from inside the suite without
   * circularity, so the honest move is not to state it.
   */
  it('states no test count, because no test can check one without counting itself', () => {
    expect(FLAT_README).not.toMatch(/\b[\d,]+ tests\b/);
    expect(FLAT_README).not.toMatch(/\b\d+ (?:test )?files\b/);
  });

  it('points at the command that answers the question instead', () => {
    expect(FLAT_README).toMatch(/`npm test`/);
  });

  it('names only npm scripts that exist', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    // `npm run x` is always a script. The bare form may be npm's own command instead —
    // `npm install` and `npm audit` are named in the README and belong to npm, not to us.
    const NPM_OWN = new Set(['install', 'audit', 'ci', 'init']);
    const named = [...README.matchAll(/`npm (run )?([a-z][a-z:]*)`/g)];
    expect(named.length).toBeGreaterThan(0);
    for (const [, isRun, cmd] of named) {
      const known = cmd! in pkg.scripts || (isRun === undefined && NPM_OWN.has(cmd!));
      expect({ cmd, known }).toEqual({ cmd, known: true });
    }
  });

  /**
   * Both directions. A dead link is the obvious failure; a doc added to docs/ and never
   * linked from the README is the one that actually happens, and it makes the documentation
   * table read as complete when it is not — the same dishonesty the run summary's `skipped`
   * list exists to avoid. This counts links anywhere in the README, not table rows, because
   * several docs are also linked from the prose and either place is a way in.
   */
  it('links every doc in docs/, and nothing that is not there', () => {
    const linked = new Set([...README.matchAll(/\(docs\/([0-9a-z-]+\.md)\)/g)].map((m) => m[1]!));
    const onDisk = new Set(
      readdirSync(path.join(REPO_ROOT, 'docs')).filter((f) => f.endsWith('.md')),
    );
    for (const doc of linked)
      expect({ doc, exists: onDisk.has(doc) }).toEqual({ doc, exists: true });
    for (const doc of onDisk)
      expect({ doc, linked: linked.has(doc) }).toEqual({ doc, linked: true });
  });

  /**
   * "none of the per-vendor ATS adapters (Greenhouse, Lever, Ashby, Workday) is built" is
   * the correction the last repair made to a sentence that had claimed they existed and
   * were merely untested. The claim is checkable: core/filling holds the generic mapper and
   * no vendor file.
   */
  it('is right that no per-vendor ATS fill adapter is built', () => {
    expect(FLAT_README).toMatch(/none of the per-vendor ATS adapters/);
    const filling = readdirSync(path.join(REPO_ROOT, 'apps/server/src/core/filling'));
    expect(filling.filter((f) => /greenhouse|lever|ashby|workday/i.test(f))).toEqual([]);
    expect(filling).toContain('formMap.ts');
  });

  /**
   * The § Environment block said "Python 3.14.6, pip 26.1.2 — present" on a machine with no
   * interpreter at all: `python --version` and `py -V` both fail and the only python.exe is
   * the 0-byte Microsoft Store alias. That is the same drift as the test count, one heading
   * down — a pinned measurement nothing re-measures.
   *
   * Only the durable half is asserted here. Whether an interpreter is installed is a fact
   * about the reader's machine, not about this repo, so a test that demanded its absence
   * would go red for any contributor who has Python for other work. What the repo can be
   * held to is that it does not need one.
   */
  it('is right that nothing here runs a Python process', () => {
    expect(FLAT_README).toMatch(/Python — \*\*not used\*\*/);
    const sources = [
      ...walk(path.join(REPO_ROOT, 'apps'), /\.tsx?$/),
      ...walk(path.join(REPO_ROOT, 'packages'), /\.tsx?$/),
    ];
    expect(sources.length).toBeGreaterThan(0);
    for (const f of sources) {
      const spawnsPython =
        /(?:spawn|spawnSync|exec|execSync|execFile|execFileSync)\(\s*['"`]py(?:thon3?)?['"`]/.test(
          readFileSync(f, 'utf8'),
        );
      expect({ f, spawnsPython }).toEqual({ f, spawnsPython: false });
    }
  });

  /**
   * The Node version in that same block is a measurement and will differ on another machine,
   * so it cannot be asserted equal to anything. It CAN be held to the floor the repo itself
   * declares: a README that told a reader to run this on a Node older than `engines` would be
   * wrong on every machine, not just this one.
   */
  it('claims a Node version that satisfies the engines floor', () => {
    const claimed = Number(/Node v(\d+)\.\d+\.\d+/.exec(FLAT_README)?.[1]);
    const pkg = JSON.parse(read('package.json')) as { engines: { node: string } };
    const floor = Number(/(\d+)/.exec(pkg.engines.node)?.[1]);
    expect(floor).toBeGreaterThan(0);
    expect(claimed).toBeGreaterThanOrEqual(floor);
  });

  it('names an environment variable the server actually reads', () => {
    expect(FLAT_README).toMatch(/`ANTHROPIC_API_KEY`/);
    const serverFiles = walk(path.join(REPO_ROOT, 'apps/server/src'), /\.ts$/);
    const readers = serverFiles.filter((f) =>
      readFileSync(f, 'utf8').includes('ANTHROPIC_API_KEY'),
    );
    expect(readers.length).toBeGreaterThan(0);
  });
});

describe('docs/04 — job discovery, § Query planning', () => {
  /**
   * The taxonomy grew from 16 to 21 families while the document went on saying 16. It is
   * exported for exactly this: counting the keys is the only reading that cannot disagree
   * with the object, and re-parsing the source text was worse than useless — the naive line
   * regex returned 24, because the table's own comments contain commas and colons.
   */
  it('states the taxonomy size that ROLE_TAXONOMY actually has', () => {
    const claimed = /(\d+)-family taxonomy/.exec(FLAT_DOC04);
    expect(claimed?.[1]).toBe(String(Object.keys(ROLE_TAXONOMY).length));
  });

  it('states the target cap planQueries actually applies', () => {
    const claimed = Number(/capped at (\d+)/.exec(FLAT_DOC04)?.[1]);
    expect(claimed).toBeGreaterThan(0);
    const boards = Array.from({ length: claimed * 3 }, (_, i) => ({
      source: 'greenhouse' as const,
      board: `b${i}`,
      reason: 'resolved',
    }));
    const plan = planQueries(profileFixture(), filtersFixture(), boards);
    expect(plan.targets).toHaveLength(claimed);
  });

  it('states the number of role families a plan keeps', () => {
    const claimed = Number(/top (\d+)/.exec(FLAT_DOC04)?.[1]);
    expect(claimed).toBeGreaterThan(0);
    const evidenced = Object.entries(ROLE_TAXONOMY).map(([, terms]) => terms[0]!);
    const plan = planQueries(
      profileFixture({ skills: evidenced.map((name) => ({ name })) }),
      filtersFixture(),
    );
    expect(plan.roleFamilies).toHaveLength(claimed);
  });

  /**
   * The cap is a promise about how many requests a run costs, and two kinds of target are
   * exempt from it — so the number alone is only half the fact. Pinning the exemption
   * behaviourally is the only way to keep the sentence honest: the check above plans
   * nothing but resolved boards, which is exactly the path that stays under the cap, and it
   * stayed green while eight pinned companies pushed a plan to fifty-three targets.
   */
  it('is right about what the cap gives way to, and about a plan going over it', () => {
    const claimed = Number(/capped at (\d+)/.exec(FLAT_DOC04)?.[1]);
    const pins = Array.from({ length: claimed }, (_, i) => `Company ${i}`);
    const plan = planQueries(
      profileFixture(),
      filtersFixture({ company: { onlyCompanies: pins, excludeCompanies: [] } }),
    );
    expect(plan.targets.length).toBeGreaterThan(claimed);
    // And the plan says so itself rather than quietly overrunning its own documented bound.
    expect(plan.notes.some((n) => n.includes(String(claimed)))).toBe(true);
  });

  /**
   * The sources that need no board are the whole plan on a fresh install, and the document
   * promises they survive the cap. They did not: the planner skipped building a default
   * target for a keyless source that a previous run had already written a `source` row for,
   * so it arrived as an ordinary known board instead and eight pinned companies cut all
   * three — including the community list, the highest-coverage source in the product. The
   * set is read out of a plan rather than written down here, so adding a fourth keyless
   * default cannot leave this test checking three.
   */
  it('is right that the sources needing no board survive the cap, resolved or not', () => {
    const fresh = planQueries(profileFixture(), filtersFixture()).targets.filter(
      (t) => t.board === '',
    );
    expect(fresh.length).toBeGreaterThan(0);

    const claimed = Number(/capped at (\d+)/.exec(FLAT_DOC04)?.[1]);
    const pins = Array.from({ length: claimed }, (_, i) => `Company ${i}`);
    // Exactly what routes/discovery.ts builds from the `source` table once a run has used
    // them, which is the state the promise used to be false in.
    const known = fresh.map((t) => ({ ...t, reason: 'a board already resolved' }));
    const plan = planQueries(
      profileFixture(),
      filtersFixture({ company: { onlyCompanies: pins, excludeCompanies: [] } }),
      known,
    );
    for (const t of fresh) {
      expect({ source: t.source, kept: plan.targets.some((k) => k.source === t.source) }).toEqual({
        source: t.source,
        kept: true,
      });
    }

    const listed =
      /keyless sources that need no board at all — ([^—]+) — are planned by default/.exec(
        FLAT_DOC04,
      )?.[1] ?? '';
    expect(listedItems(listed)).toHaveLength(fresh.length);
    for (const t of fresh) {
      expect({ source: t.source, named: namesSource(listed, t.source) }).toEqual({
        source: t.source,
        named: true,
      });
    }
  });

  /**
   * The vendors a pinned name is guessed on went from three to five in one change. Reading
   * them off a plan rather than off the constant also pins the half of the sentence that
   * matters most: Workday is not among them, because its board address is not a slug and a
   * guessed one would be a blind walk over hosts and site names inside a run.
   */
  it('names the vendors a pinned company is actually guessed on, and no others', () => {
    const plan = planQueries(
      profileFixture(),
      filtersFixture({ company: { onlyCompanies: ['Acme Widget'], excludeCompanies: [] } }),
    );
    const guessed = [
      ...new Set(plan.targets.filter((t) => /unverified/.test(t.reason)).map((t) => t.source)),
    ];
    expect(guessed.length).toBeGreaterThan(0);
    expect(guessed).not.toContain('workday');

    const sentence =
      /guessed on the (\w+) vendors whose board address is just a slug — ([^—]+) —/.exec(
        FLAT_DOC04,
      );
    expect(sentence).toBeTruthy();
    expect(WORD_NUMBERS[sentence![1]!.toLowerCase()]).toBe(guessed.length);
    expect(listedItems(sentence![2]!)).toHaveLength(guessed.length);
    for (const source of guessed) {
      expect({ source, named: namesSource(sentence![2]!, source) }).toEqual({
        source,
        named: true,
      });
    }
    expect(FLAT_DOC04).toMatch(/Workday is never guessed/);
  });

  /**
   * The document quotes the whole-word threshold as a number of characters. It is a
   * module-private constant in an expression, so the declaration is what gets matched.
   */
  it('states the stem length above which a prefix match is allowed', () => {
    const word = /terms of (\w+) characters or fewer/.exec(FLAT_DOC04)?.[1]?.toLowerCase() ?? '';
    const claimed = WORD_NUMBERS[word];
    expect(claimed).toBeGreaterThan(0);
    expect(read('apps/server/src/core/discovery/queryPlanner.ts')).toMatch(
      new RegExp(`term\\.length > ${claimed}`),
    );
  });
});

describe('docs/04 — job discovery, § Sourcing policy and § Normalization', () => {
  it('counts the sources that ship as the runner counts them', () => {
    const claimed = /(\w+) of those ship today/.exec(FLAT_DOC04)?.[1]?.toLowerCase() ?? '';
    expect(WORD_NUMBERS[claimed]).toBe(Object.keys(ALL_SOURCES).length);
  });

  /**
   * The total alone was not enough. Five adapters landed in one change, the sentence that
   * names them also says which FILE each lives in, and a count of eleven stays green while
   * a source moves between the two files or is named on the wrong side. Both halves are
   * measured against their own registry, and each registered kind has to be named on its
   * own side and nowhere near the other.
   */
  it('splits the shipping sources between the two adapter files the way the registries do', () => {
    const halves =
      /of those ship today: (.+?) in `sources\/ats\.ts`; (.+?) in `sources\/aggregators\.ts`; and (.+?) in `sources\/webSearch\.ts`/.exec(
        FLAT_DOC04,
      );
    expect(halves).toBeTruthy();
    const [ats, aggregators] = [halves![1]!, halves![2]!];

    expect(listedItems(ats)).toHaveLength(Object.keys(ATS_SOURCES).length);
    expect(listedItems(aggregators)).toHaveLength(Object.keys(AGGREGATOR_SOURCES).length);

    for (const kind of Object.keys(ATS_SOURCES)) {
      expect({
        kind,
        ats: namesSource(ats, kind),
        aggregators: namesSource(aggregators, kind),
      }).toEqual({ kind, ats: true, aggregators: false });
    }
    for (const kind of Object.keys(AGGREGATOR_SOURCES)) {
      expect({
        kind,
        ats: namesSource(ats, kind),
        aggregators: namesSource(aggregators, kind),
      }).toEqual({ kind, ats: false, aggregators: true });
    }
  });

  /**
   * Which adapters let robots.txt answer for the host, and which opt out of asking.
   *
   * § Sourcing policy makes three claims a reader would act on: that the two keyless feed
   * adapters ask, that Remotive is refused when it does, and that SmartRecruiters is still
   * reading a host whose robots.txt disallows every agent but LinkedInBot. The third is an
   * admission, and an admission has to die with the bug it describes — if the adapter is
   * fixed and this test goes red, the paragraph comes out rather than the assertion.
   *
   * The host files themselves cannot be checked here: a unit test that fetched robots.txt
   * would be a network test, and this suite has none. What is checkable is which side of
   * the switch each adapter sits on.
   */
  it('is right about which adapters ask robots.txt and which opt out of asking', () => {
    const source = [
      read('apps/server/src/core/discovery/sources/ats.ts'),
      read('apps/server/src/core/discovery/sources/aggregators.ts'),
    ].join('\n');
    const asks = new Set(
      [...source.matchAll(/export const (\w+): JobSource = \{([\s\S]*?)\n\};/g)]
        .filter(([, , body]) => /isDocumentedApi: false/.test(body!))
        .map(([, name]) => name!.toLowerCase()),
    );

    expect(asks).toContain('arbeitnow');
    expect(asks).toContain('remotive');
    expect(FLAT_DOC04).toMatch(/the two keyless feed adapters pass `isDocumentedApi: false`/);
    expect(asks.size).toBe(2);

    // The refusal is reported rather than thrown, which is what makes it a coverage gap the
    // student reads instead of a source error.
    expect(source).toMatch(/robotsRefusal\('remotive', err\)/);
    expect(FLAT_DOC04).toMatch(/Not actually read — its robots\.txt refuses us/);

    // ...and the outstanding one. Remove the paragraph when this stops being true.
    expect(asks.has('smartrecruiters')).toBe(false);
    expect(FLAT_DOC04).toMatch(/\*\*SmartRecruiters is not yet held to that rule\.\*\*/);
  });

  /**
   * The Tier A table quotes an endpoint shape per row, and that is the part of the table a
   * reader would act on. A host nothing fetches is either a source that was never built or
   * one that has moved, and both read from the table as "this ships and this is where it
   * goes". Placeholders are stripped first, because `{tenant}.{host}.myworkdayjobs.com` is
   * a shape rather than a name.
   */
  it('quotes endpoint hosts that an adapter actually fetches', () => {
    const tierA = DOC04.slice(0, DOC04.indexOf('**Tier B'));
    const adapters = [
      read('apps/server/src/core/discovery/sources/ats.ts'),
      read('apps/server/src/core/discovery/sources/aggregators.ts'),
    ].join('\n');

    const hosts = new Set<string>();
    for (const [, cell] of tierA.matchAll(/`([^`]+)`/g)) {
      const host = /([a-z0-9{}.-]*[a-z0-9-]+\.(?:com|io|co|gov|org))/i.exec(cell!)?.[1];
      if (host) hosts.add(host.replace(/^.*\}/, ''));
    }
    expect(hosts.size).toBeGreaterThan(0);
    for (const host of hosts) {
      expect({ host, fetched: adapters.includes(host) }).toEqual({ host, fetched: true });
    }
  });

  /**
   * The audit finding this file was written for. The document called `gaps` "the subset of
   * those notes"; no shipped adapter does that — adzuna and usajobs return `notes: []` beside
   * a populated `gaps`, and github_list returns a status line in one and a different
   * coverage-loss line in the other. It matters because run.ts CONCATENATES the two arrays,
   * so an adapter author who followed the document and wrote the gap line into both would
   * have it printed twice in the report the user reads.
   */
  it('does not call `gaps` a subset of `notes`', () => {
    expect(FLAT_DOC04).not.toMatch(/`gaps` is the subset of those notes/);
    expect(FLAT_DOC04).toMatch(/not a subset of `notes`/);
    const aggregators = read('apps/server/src/core/discovery/sources/aggregators.ts');
    expect(aggregators).toMatch(/return \{ postings, notes: \[\], gaps \};/);
    expect(read('apps/server/src/core/discovery/run.ts')).toMatch(
      /report\.notes = \[\.\.\.result\.notes, \.\.\.\(result\.gaps \?\? \[\]\)\];/,
    );
  });

  /**
   * Both directions, which is the whole point and is what this check was missing.
   *
   * It used to read the field names OUT of the document and assert each one exists in
   * `types.ts` — so it stayed green while `closed?: string[]` was added to the interface and
   * the document went on quoting a three-field shape. That is the worst way for this
   * particular fact to rot: an adapter author following the doc would throw away the closure
   * evidence the field exists to carry, which is precisely the bug that field was added to
   * fix. A quoted shape has to name every member the interface has.
   */
  it('quotes the SourceResult shape the interface declares, member for member', () => {
    const quoted = /`fetch` returns `\{([^`]+)\}`/.exec(FLAT_DOC04)?.[1];
    expect(quoted).toBeTruthy();

    const types = read('apps/server/src/core/discovery/sources/types.ts');
    const body = /export interface SourceResult \{([\s\S]*?)\n\}/.exec(types)?.[1] ?? '';
    const declared = [...body.matchAll(/^\s{2}(\w+)(\??):/gm)].map((m) => `${m[1]!}${m[2]!}`);
    expect(declared.length).toBeGreaterThan(3);

    for (const member of declared) {
      expect({ member, quoted: quoted!.includes(`${member}:`) }).toEqual({ member, quoted: true });
    }
  });

  /**
   * The § Normalization rule for which channel a shortfall goes down, executed rather than
   * read. Ten of thirty internships came back as empty shells with `gaps` empty and the run
   * summary clean, because the detail-page cap was reported as a plain note — and the
   * identical empty posting from a FAILED detail fetch was already a gap. The document now
   * states the rule; these are the two branches it is a rule about.
   */
  it('is right about which channel a detail-fetch shortfall goes down', () => {
    const ats = read('apps/server/src/core/discovery/sources/ats.ts');
    const channels = (condition: RegExp) =>
      [
        ...ats.matchAll(
          new RegExp(`if \\(${condition.source}\\) \\{(?:\\s*//[^\\n]*)*\\s*(\\w+)\\.push`, 'g'),
        ),
      ].map((m) => m[1]!);

    // The internships that were left without a description: coverage not obtained.
    const capped = channels(/wanted\.length > toFetch\.length/);
    expect(capped.length).toBeGreaterThan(0);
    expect([...new Set(capped)]).toEqual(['gaps']);

    // The rows that are not internships: a status line, and nothing the student came for.
    const filtered = channels(/usable\.length > wanted\.length/);
    expect(filtered.length).toBeGreaterThan(0);
    expect([...new Set(filtered)]).toEqual(['notes']);

    const claimed = Number(/fetch at most (\d+) detail pages per board/.exec(FLAT_DOC04)?.[1]);
    expect(claimed).toBeGreaterThan(0);
    for (const name of ['WORKDAY_MAX_DETAILS', 'SR_MAX_DETAILS']) {
      expect(ats).toMatch(new RegExp(`const ${name} = ${claimed};`));
    }
  });

  /**
   * The vocabulary, run rather than quoted. The document lists the words that pass and the
   * phrases that must not, and both halves matter: an English-only pattern dropped every
   * Praktikum on a Europe-heavy board, and a pattern loose enough to keep them would fill
   * the queue with "International Sales Lead". Reading the list out of the prose is what
   * stops the document from listing a language the function no longer reads.
   */
  it('is right about the words `internshipShaped` reads and the phrases it refuses', () => {
    const sentence = /([^.]+) all pass, alongside ([^.]+)\./.exec(FLAT_DOC04);
    expect(sentence).toBeTruthy();
    const passing = [...listedItems(sentence![1]!), ...listedItems(sentence![2]!)];
    expect(passing.length).toBeGreaterThan(10);
    for (const word of passing) {
      expect({ word, shaped: internshipShaped(word) }).toEqual({ word, shaped: true });
    }

    const boundaries = /The boundaries cut both ways[^.]+\./.exec(FLAT_DOC04)?.[0] ?? '';
    const refused = [...boundaries.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
    expect(refused.length).toBeGreaterThan(2);
    for (const phrase of refused) {
      expect({ phrase, shaped: internshipShaped(phrase) }).toEqual({ phrase, shaped: false });
    }
  });

  /**
   * "Deliberately shorter than the filter reads" is the sentence that keeps somebody from
   * turning the whole vocabulary into searches, which would cost one request per word per
   * board per run. Both lists are module-private, so their declarations are counted.
   */
  it('is right that fewer terms are searched for than are recognised', () => {
    const ats = read('apps/server/src/core/discovery/sources/ats.ts');
    const searched = [
      ...(/const INTERNSHIP_SEARCHES = \[([\s\S]*?)\] as const;/.exec(ats)?.[1] ?? '').matchAll(
        /'[^']+'/g,
      ),
    ].length;
    const recognised = [
      ...(/const INTERNSHIP_TITLE: RegExp\[\] = \[([\s\S]*?)\n\];/.exec(ats)?.[1] ?? '').matchAll(
        /^\s*(?:\/[^\n]*|[A-Z_]+),$/gm,
      ),
    ].length;
    expect(searched).toBeGreaterThan(0);
    expect(recognised).toBeGreaterThan(searched);
    expect(FLAT_DOC04).toMatch(/search list is deliberately shorter than the filter reads/);

    /**
     * The document says only SmartRecruiters spends the vocabulary on searches, and that
     * Workday sends one. That is a claim about behaviour, so it is pinned to behaviour.
     *
     * The previous pin counted `[...INTERNSHIP_SEARCHES]` occurrences and demanded two — a
     * literal duplication count, not a fact anyone documented. When Workday was measured and
     * reverted to a single search (its `searchText` is fuzzy, so the vocabulary read FEWER
     * internships than "intern" alone), a correct, evidence-backed change turned the suite
     * red and the only way to satisfy the pin was to undo it.
     */
    expect([...ats.matchAll(/\[\.\.\.INTERNSHIP_SEARCHES\]/g)]).toHaveLength(1);
    expect(FLAT_DOC04).toMatch(/Only SmartRecruiters searches that vocabulary server-side/);
    expect(FLAT_DOC04).toMatch(/Workday deliberately does not/);
    // And the reason has to be the one the code acts on, not a restatement of the rule.
    expect(FLAT_DOC04).toMatch(/`searchText` is fuzzy/);
  });

  /**
   * The same shape of miss one section over: § Run reporting listed the totals a summary
   * carries, `closed` landed on `RunSummary`, and nothing held the sentence to the type.
   */
  it('names every total the run summary actually carries', () => {
    const listed = /Run totals carry ([^.]+?), plus a `skipped` list/.exec(FLAT_DOC04)?.[1] ?? '';
    expect(listed).toBeTruthy();

    const run = read('apps/server/src/core/discovery/run.ts');
    const body = /export interface RunSummary \{([\s\S]*?)\n\}/.exec(run)?.[1] ?? '';
    const counted = [...body.matchAll(/^\s{2}(\w+): number;/gm)].map((m) => m[1]!);
    // `targets` is the size of the plan rather than a total about postings, and the sentence
    // is about what a run turned up.
    for (const total of counted.filter((c) => c !== 'targets')) {
      expect({ total, listed: listed.includes(total) }).toEqual({ total, listed: true });
    }
  });
});

/**
 * The resolver is the part of this document that has drifted hardest: the probe list grew
 * from three vendors to six inside one change, and the prose that describes the walk, its
 * order and its request bound is prose a reader has no way to check. Every claim here is
 * measured against `resolveCompany.ts` rather than against a memory of it.
 */
describe('docs/04 — job discovery, § Company target list', () => {
  const RESOLVER = read('apps/server/src/core/discovery/resolveCompany.ts');

  /** The GET probe declarations, as one block, so the Workday probe below cannot leak in. */
  const PROBES = /const PROBES[\s\S]*?\n\];/.exec(RESOLVER)?.[0] ?? '';
  const WORKDAY_PROBE = /async function probeWorkday[\s\S]*?\n\}\n/.exec(RESOLVER)?.[0] ?? '';

  /** The hosts the resolver probes, in probe order, with slug and host placeholders as `*`. */
  function probedHosts(): string[] {
    const gets = [...PROBES.matchAll(/url: \([a-z]\) =>\s*`https:\/\/([^/`]+)/g)].map((m) => m[1]!);
    const workday = /const url = `https:\/\/([^/`]+)/.exec(WORKDAY_PROBE)?.[1];
    return [...gets, ...(workday === undefined ? [] : [workday])].map((h) =>
      h.replace(/\$\{[A-Za-z.]+\}/g, '*'),
    );
  }

  /** The same list as the § Company target list code block writes it, in written order. */
  function documentedHosts(): string[] {
    const block = /```\nacme →[\s\S]*?\n```/.exec(DOC04)?.[0] ?? '';
    return [...block.matchAll(/(?:try|POST) ([^\s/]+)/g)].map((m) =>
      m[1]!.replace(/\{[^}]*\}/g, '*').replace(/\bacme\b/g, '*'),
    );
  }

  /** Two hosts × three site names — the two halves of the Workday budget, from the code. */
  const workdayHosts = [
    ...(/const WORKDAY_HOSTS = \[([^\]]*)\]/.exec(RESOLVER)?.[1] ?? '').matchAll(/'[^']+'/g),
  ].length;
  const workdaySites = listedItems(
    /function workdaySiteCandidates[\s\S]*?new Set\(\[([^\]]*)\]/.exec(RESOLVER)?.[1] ?? '',
  ).length;

  it('lists the endpoints the resolver probes, in the order it probes them', () => {
    expect(probedHosts().length).toBeGreaterThan(1);
    expect(documentedHosts()).toEqual(probedHosts());
  });

  it('states how many vendors are asked about one slug before the next slug is tried', () => {
    const claimed = /All (\w+) vendors are tried for one slug candidate/.exec(FLAT_DOC04)?.[1];
    expect(WORD_NUMBERS[claimed?.toLowerCase() ?? '']).toBe(probedHosts().length);
  });

  it('states the Workday probe budget the code actually spends', () => {
    expect(workdayHosts).toBeGreaterThan(0);
    expect(workdaySites).toBeGreaterThan(0);
    const hosts = /the (\w+) hosts that hold the bulk of tenants/.exec(FLAT_DOC04)?.[1];
    const sites = /and (\w+) site candidates/.exec(FLAT_DOC04)?.[1];
    const posts = /at most (\w+) POSTs per slug candidate/.exec(FLAT_DOC04)?.[1];
    expect(WORD_NUMBERS[hosts?.toLowerCase() ?? '']).toBe(workdayHosts);
    expect(WORD_NUMBERS[sites?.toLowerCase() ?? '']).toBe(workdaySites);
    expect(WORD_NUMBERS[posts?.toLowerCase() ?? '']).toBe(workdayHosts * workdaySites);
  });

  /**
   * The finding this block was written for. The document named two answers the Workday
   * probe passes over in silence; the code has three, and the missing one — a plain 404 —
   * is what a real tenant returns for every site name that is not its own. A reader
   * auditing the probe's manners against the document would have found an undocumented
   * silent branch and no way to tell whether it was deliberate.
   */
  it('names every answer the Workday probe passes over without a word', () => {
    const statuses = [...WORKDAY_PROBE.matchAll(/err\.status === (\d{3})/g)].map((m) => m[1]!);
    const skipsDeadHost = /isAbsentHost\(err\)\) break;/.test(WORKDAY_PROBE);
    expect(statuses.length).toBeGreaterThan(0);
    expect(skipsDeadHost).toBe(true);

    const sentence =
      /(\w+) answers count as the ordinary "not Workday" and pass without comment: ([^.]+)\./.exec(
        FLAT_DOC04,
      );
    expect(sentence).toBeTruthy();
    expect(WORD_NUMBERS[sentence![1]!.toLowerCase()]).toBe(statuses.length + 1);
    for (const status of statuses) {
      expect({ status, named: sentence![2]!.includes(status) }).toEqual({ status, named: true });
    }
    expect(sentence![2]).toMatch(/DNS/);
  });

  /**
   * A claim of absence next to a claim of presence, and the pair is the point. The document
   * said for a long time that a resolution reaches the planner, and separately that nothing
   * wrote one down; both sentences were in the file at once and the route between them did
   * not exist. `ensureSource` is private to run.ts and fires per persisted posting, so the
   * only other writer is the resolve route itself.
   */
  it('is right that the resolve route writes a resolution down and the resolver does not', () => {
    expect(RESOLVER).not.toMatch(/insert\(schema\.source\)/);
    const routes = read('apps/server/src/routes/discovery.ts');
    const handler = /app\.post\('\/api\/companies\/resolve'[\s\S]*?\n {2}\}\);/.exec(routes)?.[0];
    expect(handler).toBeTruthy();
    // The insert lives in a helper the handler calls, so the write is looked for in the file
    // and the call to it in the handler — a handler that stopped calling it is the failure.
    expect(routes).toMatch(/insert\(schema\.source\)/);
    expect(handler).toMatch(/rememberResolvedBoards/);
  });

  /**
   * The request bound, arithmetic and all. It is the sentence that makes this a resolver
   * rather than a crawler, so every number in it is derived from the probes the code
   * declares — and the candidate count is measured by running `slugCandidates`, including a
   * name that reaches the ceiling so the document cannot claim a looser bound than it has.
   */
  it('states a request bound that matches the probes the code makes', () => {
    const gets = [...PROBES.matchAll(/source: '[a-z]+'/g)].length;
    const posts = workdayHosts * workdaySites;
    const perCandidate = gets + posts;

    const worst =
      /worst case for one resolve is (\w+) requests per slug candidate — (\w+) GETs and (\w+) Workday POSTs/.exec(
        FLAT_DOC04,
      );
    expect(worst).toBeTruthy();
    expect(WORD_NUMBERS[worst![2]!.toLowerCase()]).toBe(gets);
    expect(WORD_NUMBERS[worst![3]!.toLowerCase()]).toBe(posts);
    expect(WORD_NUMBERS[worst![1]!.toLowerCase()]).toBe(perCandidate);

    const candidates =
      WORD_NUMBERS[
        /`slugCandidates` yields at most (\w+) candidates/.exec(FLAT_DOC04)?.[1]?.toLowerCase() ??
          ''
      ] ?? 0;
    expect(candidates).toBeGreaterThan(0);
    for (const name of ['Acme', 'Acme Widget Co', 'One Two Three Four Five Inc', 'Foo-Bar Baz']) {
      expect({ name, count: slugCandidates(name).length <= candidates }).toEqual({
        name,
        count: true,
      });
    }
    // ...and the bound is tight, so it cannot be inflated to make the arithmetic work.
    expect(slugCandidates('Acme Widget Co')).toHaveLength(candidates);

    const total = Number(/a resolve tops out at (\d+) probes/.exec(FLAT_DOC04)?.[1]);
    expect(total).toBe(perCandidate * candidates);
  });
});

describe('docs/04 — job discovery, § Dedupe', () => {
  it('names the function stage 2 actually builds its key from', () => {
    const dedupe = read('apps/server/src/core/discovery/dedupe.ts');
    const key = /return \[([^\]]*)\]\.join\('\|'\)/.exec(dedupe)?.[1] ?? '';
    expect(key).toContain('fingerprintTitle');
    expect(key).not.toContain('normalizeTitle(');
    expect(FLAT_DOC04).toMatch(/fingerprintTitle\(title\)/);
    expect(FLAT_DOC04).not.toMatch(/normalizeTitle\(title\)` \+/);
  });

  /**
   * The document justifies the cautious form with three specific pairs that must not merge.
   * Asserting the sentences without asserting the behaviour would be back to checking a copy
   * of the fact, so the pairs are run through the function.
   */
  it('is right that the fingerprint keeps roman numerals, season words and years', () => {
    expect(fingerprintTitle('Machine Learning Intern I')).not.toBe(
      fingerprintTitle('Machine Learning Intern II'),
    );
    expect(fingerprintTitle('Software Engineer Intern (Summer 2026)')).not.toBe(
      fingerprintTitle('Software Engineer Intern (Fall 2026)'),
    );
    // ...and the aggressive form, which the document assigns to stage 3, does collapse them.
    expect(normalizeTitle('Machine Learning Intern I')).toBe(
      normalizeTitle('Machine Learning Intern II'),
    );
  });

  it('is right that a labelled requisition id is stripped', () => {
    expect(fingerprintTitle('Data Analyst Intern (Req #9931)')).toBe(
      fingerprintTitle('Data Analyst Intern'),
    );
    expect(fingerprintTitle('Data Analyst Intern (Job ID 4471)')).toBe(
      fingerprintTitle('Data Analyst Intern'),
    );
  });

  it('lists the tracking parameters stage 1 actually strips', () => {
    const listed = [
      ...(/Strip tracking params \(([^)]*)\)/.exec(FLAT_DOC04)?.[1] ?? '').matchAll(
        /`([a-z_*-]+)`/g,
      ),
    ].map((m) => m[1]!.replace(/\*$/, ''));
    expect(listed).not.toHaveLength(0);
    for (const param of listed) {
      const url = canonicalUrl(
        `https://example.com/j/1?${param}${param.endsWith('_') ? 'x' : ''}=v`,
      );
      expect({ param, url }).toEqual({ param, url: 'https://example.com/j/1' });
    }
  });
});

describe('docs/04 — job discovery, § Freshness and § Politeness', () => {
  const refresh = read('apps/server/src/core/discovery/refresh.ts');
  const fetcher = read('apps/server/src/infra/http/fetcher.ts');
  const run = read('apps/server/src/core/discovery/run.ts');

  it('states the staleness window refresh.ts declares', () => {
    const claimed = Number(/Not seen in (\d+) days/.exec(FLAT_DOC04)?.[1]);
    expect(refresh).toMatch(new RegExp(`const STALE_DAYS = ${claimed};`));
  });

  it('states the URL-check page size refresh.ts defaults to', () => {
    const claimed = Number(/(\d+) rows per call by default/.exec(FLAT_DOC04)?.[1]);
    expect(refresh).toMatch(new RegExp(`opts\\.limit \\?\\? ${claimed}`));
  });

  it('states the only two statuses that close a posting', () => {
    const claimed = /Only (\d{3}) and (\d{3}) close a posting/.exec(FLAT_DOC04);
    expect(refresh).toMatch(
      new RegExp(`err\\.status === ${claimed?.[1]} \\|\\| err\\.status === ${claimed?.[2]}`),
    );
  });

  it('states the worker count runDiscovery defaults to', () => {
    const claimed = Number(/\*\*(\d+)\*\* workers by default/.exec(FLAT_DOC04)?.[1]);
    expect(run).toMatch(new RegExp(`opts\\.concurrency \\?\\? ${claimed}`));
  });

  it('states the rate limit, retry cap, attempt count and cache TTL the fetcher declares', () => {
    expect(fetcher).toMatch(
      new RegExp(`const DEFAULT_RPS = ${/default (\d+) rps/.exec(FLAT_DOC04)?.[1]};`),
    );
    // The constant is written with a numeric separator, so 60s is `60_000`, not `60000`.
    expect(fetcher).toMatch(
      new RegExp(`const MAX_RETRY_AFTER_MS = ${/capped at (\d+)s/.exec(FLAT_DOC04)?.[1]}_000;`),
    );
    expect(fetcher).toMatch(
      new RegExp(`const MAX_ATTEMPTS = ${/(\d+) attempts max/.exec(FLAT_DOC04)?.[1]};`),
    );
    expect(fetcher).toMatch(
      new RegExp(
        `const CACHE_TTL_MS = ${/(\d+)h default TTL/.exec(FLAT_DOC04)?.[1]} \\* 60 \\* 60 \\* 1000;`,
      ),
    );
  });

  it('quotes the User-Agent the fetcher actually sends', () => {
    const quoted = /User-Agent: `([^`]+)`/.exec(FLAT_DOC04)?.[1];
    expect(quoted).toBeTruthy();
    expect(fetcher).toContain(`const USER_AGENT = '${quoted}'`);
  });

  /**
   * The POST exception, in both directions. A body has to bypass the cache on the way in
   * AND on the way out: reading it back would serve one Workday offset's page for every
   * other offset, and writing it would poison the entry for whatever GETs that URL next.
   * The document is where a reader learns the cache is keyed on URL, so it owes them the
   * one request shape that key cannot describe.
   */
  it('is right that a request with a body neither reads nor writes the response cache', () => {
    expect(FLAT_DOC04).toMatch(/neither served from the response cache nor stored in it/);
    expect(fetcher).toMatch(/opts\.jsonBody === undefined \? readCache\(url\) : undefined/);
    expect(fetcher).toMatch(/if \(opts\.jsonBody === undefined\) \{\s*rememberResponse\(/);
    expect(fetcher).toMatch(/method: 'POST', body: JSON\.stringify\(opts\.jsonBody\)/);
  });

  it('states the status a robots.txt-disallowed path raises', () => {
    const claimed = /A disallowed path raises a (\d{3})/.exec(FLAT_DOC04)?.[1];
    expect(fetcher).toMatch(
      new RegExp(`robots\\.txt disallows \\$\\{u\\.pathname\\}\`, ${claimed}`),
    );
  });
});

/**
 * The one check in this repo that talks to the real internet, and therefore the only thing
 * that can notice an endpoint moving. Its target list is hand-written and five adapters
 * landed without being added to it, so the document says which sources it does not watch —
 * and both assertions below are written to die the moment that stops being true.
 */
describe('docs/04 — job discovery, § Checking it against the real internet', () => {
  const SMOKE = read('scripts/smoke-discovery.ts');

  it('names exactly the shipping sources the smoke run does not reach', () => {
    const covered = new Set([...SMOKE.matchAll(/\{ source: '(\w+)'/g)].map((m) => m[1]!));
    expect(covered.size).toBeGreaterThan(0);
    const missing = Object.keys(ALL_SOURCES).filter((k) => !covered.has(k));

    const sentence = /Five of the shipping sources — ([^—]+) — are not in it/.exec(FLAT_DOC04);
    if (missing.length === 0) {
      // Somebody finished the job. The paragraph is now a lie in the other direction.
      expect(sentence).toBeNull();
      return;
    }
    expect(sentence).toBeTruthy();
    expect(listedItems(sentence![1]!)).toHaveLength(missing.length);
    for (const kind of missing) {
      expect({ kind, named: namesSource(sentence![1]!, kind) }).toEqual({ kind, named: true });
    }
  });

  /**
   * The claim flipped, so the pin flips with it: the smoke script was the last place the
   * question was answered twice, and it now asks the shared function like everything else.
   * Pinned in both directions — the document must say so, and the script must actually do
   * it — because a document claiming a unification that quietly came apart is how the
   * original three-way split went unnoticed.
   */
  it('is right that the smoke script asks the shared function', () => {
    expect(SMOKE).toContain('internshipShaped');
    // No second definition hiding beside the import.
    expect(SMOKE).not.toMatch(/const INTERN\w* = \//);
    expect(FLAT_DOC04).toMatch(/everything in the discovery path asks, the smoke script/);
    expect(FLAT_DOC04).not.toMatch(/still carries a copy/);
  });
});

describe('docs/04 — job discovery, § Pipeline reporting', () => {
  it('names routes that are actually declared', () => {
    const routeFiles = walk(path.join(REPO_ROOT, 'apps/server/src/routes'), /\.ts$/)
      .map((f) => readFileSync(f, 'utf8'))
      .join('\n');
    const declared = new Set(
      [...routeFiles.matchAll(/app\.(?:get|post|put|patch|delete)(?:<[^>]*>)?\('([^']+)'/g)].map(
        (m) => m[1]!,
      ),
    );
    const named = new Set([...DOC04.matchAll(/`(?:GET|POST) (\/api\/[^`]+)`/g)].map((m) => m[1]!));
    expect(named.size).toBeGreaterThan(0);
    for (const route of named) {
      expect({ route, declared: declared.has(route) }).toEqual({ route, declared: true });
    }
  });

  it('names the SSE events the runner actually publishes', () => {
    const run = read('apps/server/src/core/discovery/run.ts');
    const named = [...DOC04.matchAll(/`(discovery\.[a-z_]+)`/g)].map((m) => m[1]!);
    expect(named.length).toBeGreaterThan(0);
    for (const event of named) {
      expect({ event, published: run.includes(`type: '${event}'`) }).toEqual({
        event,
        published: true,
      });
    }
  });

  /**
   * Two claims of ABSENCE, which are the ones a reader has no way to check and the ones that
   * rot first: something gets wired up and the paragraph saying it is not wired up survives.
   */
  it('is right that nothing in the web app subscribes to the stream', () => {
    expect(FLAT_DOC04).toMatch(/`EventSource` appears nowhere in `apps\/web\/src`/);
    for (const f of walk(path.join(REPO_ROOT, 'apps/web/src'), /\.tsx?$/)) {
      expect({ f, uses: readFileSync(f, 'utf8').includes('EventSource') }).toEqual({
        f,
        uses: false,
      });
    }
  });

  it('is right that no server file reads BRAVE_SEARCH_API_KEY', () => {
    expect(FLAT_DOC04).toMatch(
      /`BRAVE_SEARCH_API_KEY` in `\.env\.example` is (?:still )?read by nothing/,
    );
    for (const f of walk(path.join(REPO_ROOT, 'apps/server/src'), /\.ts$/)) {
      expect({ f, reads: readFileSync(f, 'utf8').includes('BRAVE_SEARCH_API_KEY') }).toEqual({
        f,
        reads: false,
      });
    }
  });
});

function profileFixture(over: Record<string, unknown> = {}): ConfirmedProfile {
  return {
    id: 'p1',
    fullName: 'A',
    email: 'a@b.c',
    skills: [],
    experience: [],
    projects: [],
    education: [],
    locationPrefs: {
      base: { city: 'Boston', region: 'MA', country: 'US' },
      additionalBases: [],
      maxCommuteKm: 50,
      remoteOk: true,
      hybridOk: true,
      relocateTo: [],
    },
    // Required on ConfirmedProfile and read by planQueries on every call. The fixture casts
    // through `unknown`, so leaving it out typechecked and then threw at runtime.
    preferences: { companySizes: [], industries: [], excludeCompanies: [], roleFamilies: [] },
    ...over,
  } as unknown as ConfirmedProfile;
}

function filtersFixture(over: Record<string, unknown> = {}): SearchFilters {
  return {
    term: { seasons: ['summer'], years: [2027] },
    positionTypes: ['internship'],
    role: { roleFamilies: [], titleIncludes: [], titleExcludes: [] },
    location: { cities: [], remote: true },
    company: { onlyCompanies: [], excludeCompanies: [] },
    ...over,
  } as unknown as SearchFilters;
}

/**
 * Two copies of one map, on opposite sides of the client/server boundary.
 *
 * `ANSWERED_IN_WIZARD` lists the flags a student cannot wave off, because a control on the
 * wizard answers them. The server copy drives the 409 that refuses a dismissal; the web copy
 * drives whether an "I have checked this" button renders at all. Both files document the
 * duplication and say the two must be edited together, and nothing enforced it: the web test
 * only ever read the web copy, and no server test imported the server one.
 *
 * Disagreement is silent and lands on the user either way. A path on the server and not the
 * web gets a button that the server then refuses; a path on the web and not the server gets
 * no button and no refusal — a flag with no way to clear it, which is G1 locked shut.
 */
describe('the two copies of ANSWERED_IN_WIZARD', () => {
  /** The keys of an object literal in a source file, read without importing across apps. */
  function keysOf(rel: string, declaration: string): string[] {
    const src = read(rel);
    const at = src.indexOf(declaration);
    expect({ rel, found: at >= 0 }).toEqual({ rel, found: true });
    const body = src.slice(at, src.indexOf('};', at));
    return [...body.matchAll(/^\s{2}'?([A-Za-z][\w.]*)'?:/gm)].map((m) => m[1]!).sort();
  }

  it('name exactly the same paths', () => {
    const server = keysOf(
      'apps/server/src/core/profile/reviewFlags.ts',
      'export const ANSWERED_IN_WIZARD',
    );
    const web = keysOf('apps/web/src/lib/review.ts', 'export const ANSWERED_IN_WIZARD');
    expect(server.length).toBeGreaterThan(0);
    expect(web).toEqual(server);
  });

  it('agree that phone is NOT among them', () => {
    // The one that came out, and the reason this test exists. `phone` is optional on the
    // schema, so a blank is a complete answer — but while it was in these maps the flag was
    // non-dismissible on the web and refused on the server, and clearing the box locked G1
    // for anyone who did not want to give a number.
    for (const rel of [
      'apps/server/src/core/profile/reviewFlags.ts',
      'apps/web/src/lib/review.ts',
    ]) {
      const keys = keysOf(rel, 'export const ANSWERED_IN_WIZARD');
      expect({ rel, hasPhone: keys.includes('phone') }).toEqual({ rel, hasPhone: false });
    }
  });
});

/**
 * docs/10 § Limits on what one page or one upload may cost.
 *
 * Every number in that section is a promise about a constant somewhere in the source, and a
 * promise nobody checks is a number that drifts. These read the figure OUT of the prose and
 * assert the code declares it, so changing one without the other turns a test red — which is
 * the same contract the docs/04 sections above are held to.
 */
/**
 * The number of eligibility rules, bound to the array that decides it.
 *
 * docs/05 said "Twelve of them", listed twelve in its table, and closed the section with a
 * blockquote asserting outright that "there is no thirteenth rule" — while `RULES` held
 * thirteen. The missing one, `postdoctoral`, is the only rule in the file that infers a hard
 * verdict from a posting's TITLE, so the one rule a false-ineligible report would most need
 * to find was the one the documentation said did not exist. docs/14 repeated the wrong count
 * in its own sentence about what runs without a model.
 *
 * Asserted against `RULES.length` rather than against the digit, so adding a rule is what
 * turns this red — which is precisely what did not happen last time.
 */
describe('docs/05 — matching, § The rules', () => {
  const DOC05 = read('docs/05-matching.md');
  const NUMBER_WORDS = [
    'zero',
    'one',
    'two',
    'three',
    'four',
    'five',
    'six',
    'seven',
    'eight',
    'nine',
    'ten',
    'eleven',
    'twelve',
    'thirteen',
    'fourteen',
    'fifteen',
    'sixteen',
    'seventeen',
    'eighteen',
    'nineteen',
    'twenty',
  ];

  /**
   * The rule names, read out of the `RULES` declaration itself rather than listed again here.
   * Adding a rule to the array is then what turns this red — which is exactly what failed to
   * happen when `postdoctoral` was added.
   */
  const ruleNames = (): string[] => {
    const src = read('apps/server/src/core/matching/eligibility.ts');
    const block = /export const RULES = \[([\s\S]*?)\] as const;/.exec(src);
    expect(block, 'the RULES declaration moved; this pin needs updating').not.toBeNull();
    return block![1]!
      .split(',')
      .map((s) => s.trim())
      .filter((s) => /^[A-Za-z]\w*$/.test(s))
      .map((s) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`));
  };

  it('counts the rules the same way RULES does', () => {
    const spelled = NUMBER_WORDS[ruleNames().length];
    expect(spelled, `RULES holds ${ruleNames().length}, which this test cannot spell`).toBeTruthy();
    expect(DOC05).toMatch(new RegExp(`^${spelled!} of them, in \`RULES\``, 'im'));
    expect(read('docs/14-model-access.md')).toMatch(
      new RegExp(`\\b${spelled!} eligibility rules\\b`, 'i'),
    );
  });

  it('gives every rule in RULES a row of its own in the table', () => {
    for (const name of ruleNames()) {
      expect(DOC05, name).toContain(`| \`${name}\` |`);
    }
  });

  /**
   * The sentence that outlived the rule it denied. "There is no thirteenth rule" was written
   * about Guardian mode's absent `age_work_permit`, and read as a promise that `RULES` was
   * closed at twelve — so a reader chasing a false-ineligible had the documentation tell them
   * the rule that caused it could not exist.
   */
  it('does not deny a rule by counting to one past the last one', () => {
    expect(DOC05).not.toMatch(/there\s+is\s+no\s+\w+\s+rule/i);
  });
});

describe('docs/10 — security & privacy, § Limits', () => {
  const DOC10 = flat(read('docs/10-security-privacy.md'));
  const fetcher = read('apps/server/src/infra/http/fetcher.ts');
  const extractText = read('apps/server/src/core/ingestion/extractText.ts');
  const resumes = read('apps/server/src/routes/resumes.ts');
  const requirements = read('apps/server/src/core/matching/extractRequirements.ts');

  it('states the response body and robots.txt caps the fetcher declares', () => {
    const body = Number(/A response body stops at (\d+)MB/.exec(DOC10)?.[1]);
    const robots = Number(/`robots.txt` at (\d+)KB/.exec(DOC10)?.[1]);
    expect(fetcher).toMatch(new RegExp(`const MAX_BODY_BYTES = ${body} \\* 1024 \\* 1024;`));
    expect(fetcher).toMatch(new RegExp(`const MAX_ROBOTS_BYTES = ${robots} \\* 1024;`));
  });

  it('states both bounds on the response cache', () => {
    const claimed = /cache holds (\d+) entries and (\d+)MB/.exec(DOC10);
    expect(fetcher).toMatch(new RegExp(`const MAX_CACHE_ENTRIES = ${claimed?.[1]};`));
    expect(fetcher).toMatch(
      new RegExp(`const MAX_CACHE_BYTES = ${claimed?.[2]} \\* 1024 \\* 1024;`),
    );
  });

  it('states the redirect cap, which is the same for a page and for a robots.txt', () => {
    const hops = Number(/Redirects stop at (\d+) hops/.exec(DOC10)?.[1]);
    expect(fetcher).toMatch(new RegExp(`const MAX_REDIRECTS = ${hops};`));
    expect(fetcher).toMatch(new RegExp(`const MAX_ROBOTS_REDIRECTS = ${hops};`));
  });

  it('states the upload cap and both document limits', () => {
    const upload = Number(/An upload stops at (\d+)MB/.exec(DOC10)?.[1]);
    const unpacked = Number(/may not declare more than \*\*(\d+)MB\*\* unpacked/.exec(DOC10)?.[1]);
    const chars = /yield more than \*\*([\d,]+) characters\*\*/.exec(DOC10)?.[1];
    expect(resumes).toMatch(new RegExp(`const MAX_BYTES = ${upload} \\* 1024 \\* 1024;`));
    expect(extractText).toMatch(
      new RegExp(`const MAX_DOCX_UNPACKED_BYTES = ${unpacked} \\* 1024 \\* 1024;`),
    );
    // Written with underscores in the source and commas in the prose; same number either way.
    expect(extractText).toMatch(new RegExp(`const MAX_TEXT_CHARS = ${chars?.replace(/,/g, '_')};`));
  });

  it('states the three text windows the requirement extractor clamps to', () => {
    const claimed = /clamped to (\d+), (\d+) and (\d+) characters/.exec(DOC10);
    expect(requirements).toMatch(new RegExp(`const MAX_LEAD = ${claimed?.[1]};`));
    expect(requirements).toMatch(new RegExp(`const MAX_CLAUSE_SPAN = ${claimed?.[2]};`));
    expect(requirements).toMatch(new RegExp(`const MAX_TRAIL = ${claimed?.[3]};`));
  });

  it('does not claim a robots.txt regex that is no longer there', () => {
    // The section says wildcard matching is "a forward scan, not a compiled regex". That is a
    // claim about the code, and the code is what it is checked against.
    expect(DOC10).toMatch(/forward scan, not a compiled regex/);
    expect(fetcher).not.toMatch(/new RegExp\(`\^\$\{source\}/);
    expect(fetcher).toMatch(/function robotsMatches/);
  });
});

/**
 * docs/07 § The submit gate — the two RUNTIME layers, as opposed to the four source scans.
 *
 * The four listed before them establish that no code here writes a submit call. They say
 * nothing about a page arranging for an ordinary-looking click to land on something that
 * submits, which is what the two below are for, and what every shape listed in that section
 * was found doing.
 */
describe('docs/07 — form automation, § The submit gate', () => {
  const DOC07 = flat(read('docs/07-form-automation.md'));
  const selectors = read('apps/server/src/core/filling/selectors.ts');
  const fill = read('apps/server/src/core/filling/fill.ts');

  it('names a guard that exists and asks the page rather than the selector', () => {
    expect(DOC07).toMatch(/`refuseIfItCanSend\(\)` asks the page/);
    expect(fill).toMatch(/async function refuseIfItCanSend\(/);
    // The composed tree is the whole point: shadow roots entered, slots resolved.
    expect(fill).toMatch(/shadowRoot/);
    expect(fill).toMatch(/assignedElements/);
  });

  it('states the exclusion is written once and carried by every clause', async () => {
    expect(DOC07).toMatch(/states once what must never be resolved/);
    const { NEVER_TOUCH, FILLABLE_CONTROLS, SAFE_OPTION } =
      await import('../src/core/filling/selectors');
    expect(FILLABLE_CONTROLS.split(NEVER_TOUCH).length - 1).toBe(5);
    expect(SAFE_OPTION).toContain(NEVER_TOUCH);
    // And the three things the doc says it covers.
    expect(NEVER_TOUCH).toContain(':not(label)');
    expect(NEVER_TOUCH).toMatch(/:not\(:has\(/);
    expect(selectors).toMatch(/export const SUBMIT_CAPABLE/);
  });

  it('states that every stored locator is narrowed again at fill time', () => {
    expect(DOC07).toMatch(/narrows every stored locator with it again at fill time/);
    expect(fill).toMatch(/\.and\(frame\.locator\(FILLABLE_CONTROLS\)\)/);
  });
});
