import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  daysUntil,
  locationLabel,
  payLabel,
  REJECT_REASONS,
  termLabel,
  type MatchDetail,
} from '../src/lib/matches';
import { queueKeyAction, type QueueKeyAction } from '../src/lib/queueKeys';
import {
  deadlineChip,
  DecisionRow,
  descriptionExcerpt,
  detailPaneState,
  FullDescription,
  keyActionAllowed,
  type PaneState,
} from '../src/pages/Matches';

/**
 * The four pure helpers behind the G2 queue. Each of them carries a docstring describing a
 * user-visible bug that was fixed and, until now, could have come back without a single
 * test failing.
 */

describe('daysUntil', () => {
  it('reports a deadline that has passed as negative, never as minus zero', () => {
    // Math.ceil on a small negative number gives -0, which is not less than zero and
    // prints as "0" — so the queue put a posting that closed three hours ago in urgency
    // red reading "0d left".
    const threeHoursAgo = new Date(Date.now() - 3 * 3600_000).toISOString();
    const days = daysUntil(threeHoursAgo);
    expect(days).not.toBeNull();
    expect(days! < 0).toBe(true);
    expect(Object.is(days, -0)).toBe(false);
    expect(days).toBe(-1);
  });

  it('rounds an upcoming deadline up, so part of a day still counts as a day', () => {
    expect(daysUntil(new Date(Date.now() + 3 * 3600_000).toISOString())).toBe(1);
    expect(daysUntil(new Date(Date.now() + 6.5 * 86_400_000).toISOString())).toBe(7);
  });

  it('answers nothing for a posting with no deadline or an unreadable one', () => {
    expect(daysUntil(null)).toBeNull();
    expect(daysUntil('whenever')).toBeNull();
  });
});

/**
 * The chip the queue row draws from that number, on the one day it matters most.
 *
 * `daysUntil` parses `closesAt` as an instant, and a date with no time — USAJOBS's
 * ApplicationCloseDate and JSON-LD's validThrough both send one — is the FIRST instant of
 * that day. So a posting closing "2026-09-09" was drawn in urgency red reading `closed` from
 * midnight UTC on the 9th, through the whole of the final day the student could still apply,
 * and from the afternoon of the 8th anywhere west of Greenwich.
 *
 * The server never read it that way: `deadline` in eligibility.ts and the closing sweep in
 * refresh.ts both stretch a bare date to the end of its day, so the requirement checklist in
 * the pane said "Closes 2026-09-09 — met" beside a row calling the same posting closed. A
 * false `closed` hides a job the student could still have got.
 */
describe('deadlineChip', () => {
  const dateOnly = (offsetDays: number): string =>
    new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
  const at = (ms: number): string => new Date(Date.now() + ms).toISOString();

  it('does not call a posting closed for the whole of its final day', () => {
    expect(deadlineChip(dateOnly(0))).toEqual({ text: '1d left', urgent: true });
  });

  it('ignores the whitespace the field can arrive with, as the server does', () => {
    expect(deadlineChip(` ${dateOnly(0)} `)).toEqual({ text: '1d left', urgent: true });
  });

  it('still closes a bare date once its day is over', () => {
    // The other direction. The cheap way to pass the test above is to stop closing anything,
    // and a queue that never says `closed` sends the student to apply through a dead form.
    expect(deadlineChip(dateOnly(-1))).toEqual({ text: 'closed', urgent: true });
  });

  it('still closes a timestamp that has genuinely passed', () => {
    expect(deadlineChip(at(-3 * 3600_000))).toEqual({ text: 'closed', urgent: true });
    expect(deadlineChip(at(-40 * 86_400_000))).toEqual({ text: 'closed', urgent: true });
  });

  it('counts the days left, and reddens only the last week of them', () => {
    expect(deadlineChip(at(3 * 86_400_000))).toEqual({ text: '3d left', urgent: true });
    expect(deadlineChip(at(6 * 86_400_000))).toEqual({ text: '6d left', urgent: true });
    expect(deadlineChip(at(7 * 86_400_000))).toEqual({ text: '7d left', urgent: false });
    expect(deadlineChip(at(20 * 86_400_000))).toEqual({ text: '20d left', urgent: false });
  });

  it('draws no chip at all rather than guessing at a date it cannot read', () => {
    expect(deadlineChip(null)).toBeNull();
    expect(deadlineChip('whenever')).toBeNull();
    expect(deadlineChip('')).toBeNull();
  });
});

describe('payLabel', () => {
  it('gives one display form per period token', () => {
    // "$110000–130000/year" was what a yearly salary used to look like, in the pane where
    // someone is deciding whether to apply.
    expect(payLabel({ min: 110_000, max: 130_000, period: 'year' })).toBe('$110,000–$130,000/yr');
    expect(payLabel({ min: 45, period: 'hour' })).toBe('$45/hr');
    expect(payLabel({ min: 1800, period: 'week' })).toBe('$1,800/wk');
    expect(payLabel({ min: 7200, period: 'month' })).toBe('$7,200/mo');
    expect(payLabel({ min: 20_000, period: 'total' })).toBe('$20,000 total');
  });

  it('falls back to hourly for an unknown or absent period', () => {
    expect(payLabel({ min: 45 })).toBe('$45/hr');
    expect(payLabel({ min: 45, period: 'fortnight' })).toBe('$45/hr');
  });

  it('says so plainly when there is no number to show', () => {
    expect(payLabel(null)).toBe('Pay not disclosed');
    expect(payLabel({ period: 'year' })).toBe('Pay not disclosed');
    expect(payLabel({ min: '45' })).toBe('Pay not disclosed');
  });

  it('puts unpaid and credit-only ahead of any figure', () => {
    expect(payLabel({ unpaid: true, min: 45 })).toBe('Unpaid');
    expect(payLabel({ academicCreditOnly: true, min: 45 })).toBe('Credit only');
  });
});

describe('locationLabel', () => {
  it('calls it remote whichever field says so', () => {
    expect(locationLabel({ locations: null, workArrangement: 'remote' })).toBe('Remote');
    expect(locationLabel({ locations: [{ remote: true }], workArrangement: null })).toBe('Remote');
  });

  it('uses the first location, and never renders a stray comma', () => {
    expect(
      locationLabel({ locations: [{ city: 'Ithaca', region: 'NY' }], workArrangement: 'onsite' }),
    ).toBe('Ithaca, NY');
    expect(locationLabel({ locations: [{ city: 'Ithaca' }], workArrangement: null })).toBe(
      'Ithaca',
    );
    expect(locationLabel({ locations: [{ region: 'NY' }], workArrangement: null })).toBe('NY');
  });

  it('says the posting did not state one rather than showing an empty gap', () => {
    expect(locationLabel({ locations: null, workArrangement: null })).toBe('Location not stated');
    expect(locationLabel({ locations: [], workArrangement: null })).toBe('Location not stated');
    expect(locationLabel({ locations: [{}], workArrangement: null })).toBe('Location not stated');
  });
});

describe('termLabel', () => {
  it('shows whichever half of the term the posting gave', () => {
    expect(termLabel({ season: 'summer', year: 2027 })).toBe('summer 2027');
    expect(termLabel({ season: 'fall_winter', year: null })).toBe('fall winter');
    expect(termLabel({ season: null, year: 2027 })).toBe('2027');
  });

  it('says the posting did not state one', () => {
    expect(termLabel(null)).toBe('Term not stated');
    expect(termLabel({ season: null, year: null })).toBe('Term not stated');
  });
});

/**
 * The currency the posting actually stated.
 *
 * This printed "$" whatever `currency` held, which was survivable only while the parser
 * could read nothing but dollars. It reads symbols now — and Ashby alone returns GBP and SEK
 * on an ordinary board — so a €2,000 stipend would have been shown as "$2,000/mo". Not a
 * formatting slip: a wrong number in the pane where someone decides whether to apply.
 */
describe('payLabel, in currencies that are not dollars', () => {
  it('uses the symbol the currency is written with', () => {
    expect(payLabel({ min: 25, period: 'hour', currency: 'GBP' })).toBe('£25/hr');
    expect(payLabel({ min: 2000, period: 'month', currency: 'EUR' })).toBe('€2,000/mo');
    expect(payLabel({ min: 30, period: 'hour', currency: 'CAD' })).toBe('CA$30/hr');
  });

  it('writes out a currency it has no symbol for, rather than guessing one', () => {
    // "2,000 SEK" cannot be mistaken for a different currency. "$2,000" can.
    expect(payLabel({ min: 2000, period: 'month', currency: 'SEK' })).toBe('2,000 SEK/mo');
  });

  it('still defaults to dollars, which is what a bare $ on these boards means', () => {
    expect(payLabel({ min: 30, period: 'hour' })).toBe('$30/hr');
  });

  it('carries the currency across both ends of a range', () => {
    expect(payLabel({ min: 25, max: 35, period: 'hour', currency: 'GBP' })).toBe('£25–£35/hr');
  });
});

/**
 * The detail column, which had one state and needed three.
 *
 * It rendered on `current && detail`. `detail` is nulled the instant the selection moves and
 * stays null when the fetch rejects, so the column was blank while a match loaded, blank
 * forever after a match failed to load, and blank for a posting with nothing in it — three
 * different facts drawn identically, beside a row the user had just clicked, at the gate
 * where they are about to approve it.
 */
describe('detailPaneState', () => {
  const loaded = {
    match: {},
    posting: {},
    requirements: [],
    decision: null,
  } as unknown as MatchDetail;

  it('tells a failure apart from a slow load, which is the whole point of it', () => {
    expect(detailPaneState(null, null)).toBe('loading');
    expect(detailPaneState(null, 'Failed to fetch')).toBe('failed');
    expect(detailPaneState(null, null)).not.toBe(detailPaneState(null, 'Failed to fetch'));
  });

  it('calls a loaded posting ready, and lets a failure beat a detail left over from before', () => {
    expect(detailPaneState(loaded, null)).toBe('ready');
    expect(detailPaneState(loaded, 'Failed to fetch')).toBe('failed');
  });
});

describe('the detail column itself', () => {
  const page = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/pages/Matches.tsx'),
    'utf8',
  );
  const pane = page.slice(page.indexOf('{/* detail */}'), page.indexOf('<footer'));

  it('draws something for each of the three states', () => {
    // Read once into `pane` now, because the same three states also decide whether a
    // decision key may fire — see the keyboard block below.
    expect(page).toMatch(/const pane = detailPaneState\(detail, detailError\);/);
    expect(pane).toMatch(/pane === 'loading'/);
    expect(pane).toMatch(/pane === 'failed'/);
    expect(pane).toMatch(/Reading the posting/);
    expect(pane).toMatch(/\{current && detail && \(/);
  });

  it('keeps the failure beside the hole rather than only in the page banner', () => {
    // The catch used to set the page-level `error`, which sits above the band chips — so on a
    // scrolled queue the pane went blank and the sentence explaining why was off the top.
    expect(page).toMatch(/setDetailError\(e instanceof Error/);
    expect(pane).toMatch(/\{detailError\}/);
  });

  it('offers a retry that re-runs the fetch that failed', () => {
    expect(pane).toMatch(/setDetailAttempt\(\(n\) => n \+ 1\)/);
    expect(page).toMatch(/\}, \[selected, detailAttempt\]\)/);
  });
});

/**
 * The other half of that hole: the keys, which had no such door.
 *
 * Drawing the two blank states was only half the fix. A row is selected the instant the list
 * lands — a whole round trip before its posting arrives, and for good after that posting
 * fails to arrive — and `act` guards only `!selected || busyRef.current`. So `a` pressed over
 * "Reading the posting…" created a real application, and `a` pressed over "This posting would
 * not open." created one too: an approval at G2 for a posting whose title, requirements,
 * score and rationale the user had never been shown. The four buttons are absent in both
 * states because they render inside `current && detail`; on a screen this file calls
 * keyboard-first, the buttons were never the way in.
 */
describe('keyActionAllowed', () => {
  const PANES: PaneState[] = ['loading', 'failed', 'ready'];
  const DECISIONS: QueueKeyAction[] = ['approve', 'skip', 'save', 'reject'];

  it('will not decide a posting the user cannot see', () => {
    for (const state of ['loading', 'failed'] as PaneState[]) {
      for (const action of DECISIONS) {
        expect(keyActionAllowed(action, state), `${action} over a ${state} pane`).toBe(false);
      }
    }
  });

  it('leaves every decision live once the posting is on screen', () => {
    // The other direction, and the cheap way to pass the test above is a queue nobody can
    // triage by keyboard at all.
    for (const action of DECISIONS) {
      expect(keyActionAllowed(action, 'ready'), action).toBe(true);
    }
  });

  it('never holds the keys that only move, or close the sheet', () => {
    // Moving off a posting that will not load is exactly what someone stuck at a dead pane
    // needs to do, and a sheet that cannot be closed is worse than one that cannot open.
    for (const state of PANES) {
      expect(keyActionAllowed('next', state), state).toBe(true);
      expect(keyActionAllowed('prev', state), state).toBe(true);
      expect(keyActionAllowed('close-sheet', state), state).toBe(true);
    }
  });

  it('classifies every action the key map can actually produce', () => {
    // Enumerated from queueKeyAction rather than from a list written here, so a seventh
    // binding cannot be added to the key map and left unclassified — the failure mode this
    // repo's source-of-truth tests exist for.
    const produced = [
      ...['j', 'k', 'a', 's', 'x', 'l'].map((key) => queueKeyAction({ key }, { rejecting: false })),
      queueKeyAction({ key: 'Escape' }, { rejecting: true }),
    ];
    expect(produced).not.toContain(null);

    const held = produced
      .filter((a): a is QueueKeyAction => a !== null && !keyActionAllowed(a, 'loading'))
      .sort();
    expect(held).toEqual(['approve', 'reject', 'save', 'skip']);
  });
});

describe('the queue over a pane with nothing in it', () => {
  const page = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/pages/Matches.tsx'),
    'utf8',
  );

  it('runs every keypress past the pane state before acting on it', () => {
    expect(page).toMatch(/if \(!keyActionAllowed\(action, pane\)\) return;/);
    // And re-reads the handler when the pane changes, or the listener registered while the
    // posting was loading would go on refusing keys after it arrived.
    expect(page).toMatch(/\}, \[move, act, rejecting, pane\]\)/);
  });

  it('says the keys are held, in both of the states where they are', () => {
    // Held silently is the bug in a different costume: a press that vanishes without a word
    // is how someone comes to believe they approved something.
    const detail = page.slice(page.indexOf('{/* detail */}'), page.indexOf('<footer'));
    const loading = detail.slice(
      detail.indexOf("pane === 'loading'"),
      detail.indexOf("pane === 'failed'"),
    );
    const failed = detail.slice(
      detail.indexOf("pane === 'failed'"),
      detail.indexOf('{current && detail'),
    );
    expect(loading).toMatch(/held/);
    expect(failed).toMatch(/held/);
  });

  it('closes the reject sheet when the selection moves off the posting it was opened over', () => {
    // Reachable with the mouse, which the key guard above does not cover: open the sheet on
    // A, click row B, and `rejecting` stayed true through a pane that had unmounted — every
    // key but Escape swallowed by a sheet nobody could see, and the sheet reappearing over B
    // one press from filing A's reason against it.
    const selectionEffect = page.slice(
      page.indexOf('setDetail(null);'),
      page.indexOf('const move ='),
    );
    expect(selectionEffect).toMatch(/setRejecting\(false\);/);
  });
});

/**
 * Gate G2's four decisions.
 *
 * `act` and `reject` both open with `if (!selected || busyRef.current) return`, and nothing
 * on screen said so. During a Recompute — which re-extracts requirements with the model and
 * takes as long as it takes — all four buttons stayed lit, and pressing Approve returned at
 * that first line: no application created, no row removed, no message. The user approved a
 * posting and the screen agreed that nothing had happened.
 */
describe('the G2 decision row', () => {
  const row = (over: Partial<Parameters<typeof DecisionRow>[0]> = {}): string =>
    renderToStaticMarkup(
      createElement(DecisionRow, {
        busy: null,
        rejecting: false,
        onRejecting: () => undefined,
        act: () => undefined,
        reject: () => undefined,
        applyUrl: 'https://example.test/apply',
        ...over,
      }),
    );

  const disabledCount = (html: string): number => (html.match(/disabled=""/g) ?? []).length;

  it('holds all four decisions while anything at all is running', () => {
    const html = row({ busy: 'Recomputing' });
    expect(disabledCount(html)).toBe(4);
  });

  it('names what is holding them, for the keys that cannot be greyed out', () => {
    // a, s, l and the reject sheet go through the same guard and drop just as silently, so
    // the reason has to be written where someone reaching for them will read it.
    expect(row({ busy: 'Recomputing' })).toContain('Recomputing');
    expect(row({ busy: 'Approving' })).toMatch(/decisions are held until it finishes/);
  });

  it('holds the reject sheet too, and leaves Cancel alive', () => {
    const html = row({ busy: 'Recomputing', rejecting: true });
    // Every reason button is a decision and no-ops the same way; Cancel asks the server for
    // nothing, and a sheet whose only live control is missing is worse than not opening it.
    expect(disabledCount(html)).toBe(REJECT_REASONS.length);
    expect(html).toContain('Cancel');
  });

  it('leaves every control live when nothing is running', () => {
    // The other direction, so this cannot be "fixed" into a queue nobody can triage.
    expect(disabledCount(row())).toBe(0);
    expect(disabledCount(row({ rejecting: true }))).toBe(0);
    expect(row()).toContain('Approve (A)');
    expect(row()).not.toMatch(/decisions are held/);
  });
});

/**
 * The description under the decision buttons.
 *
 * `slice(0, 8000)` with nothing after it: no ellipsis, no note, no link. The text stopped
 * mid-sentence under a summary reading "Full job description" — and the paragraph an
 * internship posting most often puts last is the one naming a hard requirement.
 */
describe('the full job description disclosure', () => {
  it('leaves a description that fits exactly as it is', () => {
    expect(descriptionExcerpt('Short posting.')).toEqual({ shown: 'Short posting.', cutAt: null });
    // Exactly at the ceiling is not a cut, and adding an ellipsis there would say it was.
    const atTheLimit = 'x'.repeat(8000);
    expect(descriptionExcerpt(atTheLimit)).toEqual({ shown: atTheLimit, cutAt: null });
  });

  it('marks the cut where it makes one', () => {
    const long = `${'x'.repeat(8000)}Must be a US citizen.`;
    const { shown, cutAt } = descriptionExcerpt(long);
    expect(cutAt).toBe(8000);
    expect(shown.endsWith('…')).toBe(true);
    expect(shown).not.toContain('Must be a US citizen.');
  });

  it('says where it stopped and where the rest is', () => {
    const html = renderToStaticMarkup(
      createElement(FullDescription, {
        text: 'x'.repeat(9000),
        applyUrl: 'https://example.test/apply',
      }),
    );
    expect(html).toContain('Cut here');
    expect(html).toContain(
      `after ${(8000).toLocaleString()} characters of ${(9000).toLocaleString()}`,
    );
    expect(html).toContain('https://example.test/apply');
  });

  it('says nothing about cutting when nothing was cut', () => {
    const html = renderToStaticMarkup(
      createElement(FullDescription, {
        text: 'A short posting body.',
        applyUrl: 'https://example.test/apply',
      }),
    );
    expect(html).toContain('A short posting body.');
    expect(html).not.toContain('Cut here');
  });

  it('does not open onto a blank box for a posting stored without a body', () => {
    const html = renderToStaticMarkup(
      createElement(FullDescription, { text: '   ', applyUrl: 'https://example.test/apply' }),
    );
    expect(html).toMatch(/stored without a description/);
  });
});
