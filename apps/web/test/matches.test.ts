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
import {
  DecisionRow,
  descriptionExcerpt,
  detailPaneState,
  FullDescription,
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
    expect(pane).toMatch(/detailPaneState\(detail, detailError\) === 'loading'/);
    expect(pane).toMatch(/detailPaneState\(detail, detailError\) === 'failed'/);
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
