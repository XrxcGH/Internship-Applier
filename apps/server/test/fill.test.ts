/**
 * Filling a real form, end to end, against the fixture.
 *
 * This is the M6 release gate from docs/11: the nastiest form fills correctly, every
 * redlined field is skipped, and no code path submits.
 *
 * The read-back assertions are the ones worth reading. It is easy to write a filler that
 * reports success because it called a method without error; the question that matters is
 * whether the page kept the value.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright';
import type { ApplicationAnswer, ConfirmedProfile, FormField } from '@ia/shared';
import {
  resetSubmissions,
  startFixtureServer,
  submissions,
  type FixtureServer,
} from '@ia/fixtures';
import { detectIntervention, openSession, type BrowserSession } from '../src/core/filling/browser';
import { CONFIDENCE_FLOOR } from '../src/core/filling/classify';
import { buildFormMap, frameKey } from '../src/core/filling/formMap';
import { buildFillPlan, summarizePlan, type FillAction } from '../src/core/filling/plan';
import {
  chooseOption,
  describeFill,
  executePlan,
  sameDocument,
  type FillResult,
  type SelectOption,
} from '../src/core/filling/fill';
import { removeTempDir } from './support/tempDir';

let fixture: FixtureServer;
let session: BrowserSession;
let workDir: string;
let resumePath: string;

const PROFILE = {
  id: 'p1',
  fullName: 'Rosa Alvarez',
  pronouns: null,
  email: 'rosa@example.edu',
  phone: '+1 555 0100',
  dateOfBirth: '2006-03-15',
  address: {
    line1: '12 Elm St',
    city: 'New Brunswick',
    region: 'NJ',
    postal: '08901',
    country: 'US',
  },
  links: { github: 'https://github.com/rosa', portfolio: 'https://rosa.dev', other: [] },
  workAuthorization: { country: 'US', status: 'citizen', needsSponsorship: false },
  citizenships: ['US'],
  education: [
    {
      institution: 'Rutgers University',
      level: 'bachelor',
      fieldOfStudy: 'Computer Science',
      startDate: '2024-09',
      endDate: '2028-05',
      gpa: { value: 3.62, scale: 4 },
      coursework: [],
      honors: [],
    },
  ],
  experience: [],
  projects: [],
  skills: [],
  certifications: [],
  languages: [],
  availability: { start: '2027-06-01', end: '2027-08-20', hoursPerWeek: 40, flexible: true },
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
    yearsProfessionalExperience: 0.2,
    seniorityBand: 'entry_intern',
  },
  confirmedAt: '2026-08-03T00:00:00Z',
  needsReview: [],
  createdAt: '2026-08-03T00:00:00Z',
  updatedAt: '2026-08-03T00:00:00Z',
} as ConfirmedProfile;

const WHY_ANSWER = {
  id: 'a0',
  applicationId: 'app1',
  questionText: 'Why do you want this internship?',
  fieldKey: 'why',
  answerType: 'long_text',
  draftText: '',
  finalText: 'I want to spend a summer on the unglamorous parts of developer tooling.',
  editDistance: 0,
  evidence: [],
  flags: [],
  approvedAt: '2026-08-04T00:00:00Z',
} as unknown as ApplicationAnswer;

const APPROVED_ANSWER = {
  id: 'a1',
  applicationId: 'app1',
  questionText: 'Tell us about a project you are proud of.',
  fieldKey: 'essay',
  answerType: 'long_text',
  draftText: '',
  finalText: 'I built a tide chart that works offline, because kayakers have no signal.',
  editDistance: 0,
  evidence: [],
  flags: [],
  approvedAt: '2026-08-04T00:00:00Z',
} as unknown as ApplicationAnswer;

beforeAll(async () => {
  fixture = await startFixtureServer(0);
  workDir = mkdtempSync(path.join(tmpdir(), 'ia-fill-'));
  resumePath = path.join(workDir, 'resume.txt');
  writeFileSync(resumePath, 'Rosa Alvarez — resume', 'utf8');
  session = await openSession({ headless: true, profileDir: path.join(workDir, 'profile') });
  resetSubmissions();
}, 120_000);

afterAll(async () => {
  // Same reason as the launch above carrying 120s: closing Chromium is not reliably quick on a
  // loaded machine, and the default hook timeout is 10s.
  await session?.close();
  await fixture?.close();
  removeTempDir(workDir);
}, 60_000);

async function run(pathname: string, answers: ApplicationAnswer[] = []) {
  await session.page.goto(`${fixture.url}${pathname}`);
  const map = await buildFormMap(session.page);
  const plan = buildFillPlan({ fields: map.fields, profile: PROFILE, answers, resumePath });
  const result = await executePlan(session.page, plan);
  return { map, plan, result };
}

describe('the simple form', () => {
  it('fills every field and the page keeps the values', async () => {
    const { result } = await run('/simple', [WHY_ANSWER, APPROVED_ANSWER]);
    const bad = result.results.filter((r) => r.status !== 'ok');
    expect(bad.map((r) => `${r.field.label}: ${r.status} ${r.note ?? ''}`)).toEqual([]);

    expect(await session.page.locator('#first').inputValue()).toBe('Rosa');
    expect(await session.page.locator('#last').inputValue()).toBe('Alvarez');
    expect(await session.page.locator('#email').inputValue()).toBe('rosa@example.edu');
    expect(await session.page.locator('#why').inputValue()).toContain('developer tooling');
  }, 90_000);

  it('attaches the resume', async () => {
    const { result } = await run('/simple', [WHY_ANSWER, APPROVED_ANSWER]);
    const file = result.results.find((r) => r.field.semantic === 'resume_upload')!;
    expect(file.status).toBe('ok');
    expect(file.readBack).toContain('resume.txt');
  }, 90_000);

  /**
   * THE NAME THE EMPLOYER RECEIVES.
   *
   * The stored copy is named for its database row — `01M21C4W42ZZYMRE4SP4QRKJ50.pdf` —
   * because a user-supplied filename is not a thing to build a path out of. But
   * `setInputFiles(path)` uploads under that basename, so the one document in the whole
   * application a human being actually opens arrived at the employer called a ULID. Read back
   * off the page's own file input, which is what the employer's form will submit.
   */
  it('sends it under the name the student uploaded, not the name it is stored as', async () => {
    const stored = path.join(workDir, '01M21C4W42ZZYMRE4SP4QRKJ50.txt');
    writeFileSync(stored, 'Rosa Alvarez — resume', 'utf8');

    await session.page.goto(`${fixture.url}/simple`);
    const map = await buildFormMap(session.page);
    const plan = buildFillPlan({
      fields: map.fields,
      profile: PROFILE,
      answers: [WHY_ANSWER, APPROVED_ANSWER],
      resumePath: stored,
      resumeFilename: 'Rosa Alvarez Resume.txt',
    });
    const result = await executePlan(session.page, plan);

    const file = result.results.find((r) => r.field.semantic === 'resume_upload')!;
    expect(file.status).toBe('ok');
    expect(file.readBack).toContain('Rosa Alvarez Resume.txt');
    expect(file.readBack).not.toContain('01M21C4W42ZZYMRE4SP4QRKJ50');
  }, 90_000);

  it('still attaches it when no name travelled with the file', async () => {
    // `load()` sets the path and the name together or not at all, so an absent name is an
    // older stored row rather than a bug — and a ULID reaching the employer beats no resume.
    await session.page.goto(`${fixture.url}/simple`);
    const map = await buildFormMap(session.page);
    const plan = buildFillPlan({
      fields: map.fields,
      profile: PROFILE,
      answers: [WHY_ANSWER, APPROVED_ANSWER],
      resumePath,
    });
    const result = await executePlan(session.page, plan);
    const file = result.results.find((r) => r.field.semantic === 'resume_upload')!;
    expect(file.status).toBe('ok');
    expect(file.readBack).toContain('resume.txt');
  }, 90_000);

  it('reports honestly when it is done', async () => {
    const { result } = await run('/simple', [WHY_ANSWER, APPROVED_ANSWER]);
    // The summary must not read as finished, because it is not.
    expect(describeFill(result)).toMatch(/submit it yourself/i);
  }, 90_000);
});

describe('an unapproved answer never reaches a form', () => {
  it('refuses to type an answer that has not passed G3', async () => {
    const unapproved = { ...WHY_ANSWER, approvedAt: null } as ApplicationAnswer;
    const { plan, result } = await run('/simple', [unapproved]);

    const essaySkip = plan.skips.find((s) => s.field.semantic === 'essay');
    expect(essaySkip?.reason).toBe('needs_answer');
    expect(essaySkip?.note).toMatch(/not approved/i);

    // And the box on the page is genuinely still empty.
    expect(await session.page.locator('#why').inputValue()).toBe('');
    expect(result.results.find((r) => r.field.semantic === 'essay')?.status).toBe('skipped');
  }, 90_000);

  it('leaves an essay blank when no answer exists at all', async () => {
    const { plan } = await run('/simple', []);
    expect(plan.skips.find((s) => s.field.semantic === 'essay')?.reason).toBe('needs_answer');
    expect(await session.page.locator('#why').inputValue()).toBe('');
  }, 90_000);
});

describe('the hostile form', () => {
  it('fills the widgets that ignore programmatic values', async () => {
    await run('/nasty', []);
    // The commit-on-keystroke widget: proof that typing, not fill(), was used.
    expect(await session.page.locator('#f-school').getAttribute('data-committed')).toBe(
      'Rutgers University',
    );
  }, 90_000);

  it('drives a div-based combobox by opening it and clicking an option', async () => {
    await run('/nasty', []);
    expect(await session.page.locator('#f-degree').getAttribute('data-value')).toBe('bachelor');
  }, 90_000);

  it('fills fields inside an iframe', async () => {
    await run('/nasty', []);
    const frame = session.page.frameLocator('#extra');
    expect(await frame.locator('#f-start').inputValue()).toBe('2027-06-01');
    expect(await frame.locator('#f-auth').inputValue()).toBe('Yes');
  }, 90_000);

  /**
   * The profile is authorized to work, so the answer is Yes. What makes this test worth
   * having is the No: the radios are labelled by the legend, so before grouping, both
   * classified as the same question and both were ticked in turn — the last one winning.
   * A tool that answers a work-authorization question by document order is worse than one
   * that leaves it blank.
   */
  it('ticks the radio that matches the answer, and leaves the other alone', async () => {
    await run('/nasty', []);
    expect(await session.page.locator('#f-auth-yes').isChecked()).toBe(true);
    expect(await session.page.locator('#f-auth-no').isChecked()).toBe(false);
  }, 90_000);

  it('reports the radio group once, with the choice it made', async () => {
    const { result } = await run('/nasty', []);
    const radios = result.results.filter((r) => r.field.control === 'radio');
    expect(radios).toHaveLength(1);
    expect(radios[0]!.status).toBe('ok');
    expect(radios[0]!.readBack).toBe('Yes');
  }, 90_000);

  it('types an approved answer into a contenteditable essay box', async () => {
    const why = {
      ...WHY_ANSWER,
      questionText: 'Why do you want this internship?',
    } as ApplicationAnswer;
    await run('/nasty', [why]);
    expect(await session.page.locator('#f-why').innerText()).toContain('developer tooling');
  }, 90_000);

  it('respects a maxlength budget rather than letting the form truncate silently', async () => {
    const long = {
      ...APPROVED_ANSWER,
      finalText: 'x'.repeat(2000),
    } as ApplicationAnswer;
    const { plan } = await run('/nasty', [long]);
    const essay = plan.actions.find((a) => a.field.semantic === 'essay');
    expect(essay?.value.length).toBe(600);
  }, 90_000);

  /**
   * The half of that the test above does not follow: what reaches the page and the report.
   *
   * The plan's 600-character slice was typed into the box, read back whole, and reported
   * filled. The student approved 2000 characters at G3 and the employer would have received
   * the first 600 of them, stopping mid-word, with a green tick beside the field — the tool
   * doing exactly what its own test name blames the form for. On this fixture the box says
   * "600 characters max" in its label, so there is a number to tell them, and there is a
   * shorter answer they can approve.
   */
  it('does not type an approved answer the box cannot hold, and names the limit', async () => {
    const long = {
      ...APPROVED_ANSWER,
      finalText: `I built a tide chart that works offline. ${'x'.repeat(2000)}`,
    } as ApplicationAnswer;
    const { result } = await run('/nasty', [long]);
    const essay = result.results.find((r) =>
      r.field.label.startsWith('Tell us about a project you are proud of.'),
    )!;

    expect(essay.status).toBe('skipped');
    expect(essay.note).toContain('600 characters');
    // And the employer's box is empty rather than holding two thirds of a sentence.
    expect(await session.page.locator('#f-essay').inputValue()).toBe('');
  }, 90_000);
});

describe('redlines, on a live page', () => {
  it('types nothing at all into the redline form', async () => {
    const { plan, result } = await run('/redlines', [WHY_ANSWER, APPROVED_ANSWER]);

    expect(plan.actions).toEqual([]);
    expect(result.filled).toBe(0);

    // Every input on the page is still empty, and every checkbox still unchecked.
    const values = await session.page.evaluate(() =>
      Array.from(document.querySelectorAll('input, select')).map((el) => {
        const i = el as HTMLInputElement;
        return i.type === 'checkbox' ? String(i.checked) : i.value;
      }),
    );
    expect(values.filter((v) => v !== '' && v !== 'false')).toEqual([]);
  }, 90_000);

  it('tells the user why each one was left, in their words', async () => {
    const { plan } = await run('/redlines', []);
    const notes = plan.skips.map((s) => s.note).join(' ');
    expect(notes).toMatch(/yours to give|only you can make it|type this yourself/i);
    expect(summarizePlan(plan)).toMatch(/left for you/);
  }, 90_000);
});

/**
 * Dropdowns, without a browser, because the interesting part is the matching.
 *
 * The fixture's only fillable select offers "Yes" and "No" and has no substring collisions
 * in it, which is why a rule that matched prose labels by substring passed the whole suite
 * while sending twenty-one of the fifty US state codes to the wrong state. These lists are
 * the ordinary ones an application actually shows.
 */
const COUNTRIES: SelectOption[] = [
  { value: '', label: 'Please select' },
  { value: 'AU', label: 'Australia' },
  { value: 'BD', label: 'Bangladesh' },
  { value: 'BR', label: 'Brazil' },
  { value: 'DE', label: 'Germany' },
  { value: 'IE', label: 'Ireland' },
  { value: 'IL', label: 'Israel' },
  { value: 'US', label: 'United States' },
  { value: 'VN', label: 'Vietnam' },
];

/**
 * Sixteen states rather than fifty, chosen because eight of these codes went somewhere
 * else: IA and OR to California, LA and MA to Alabama, NE to Connecticut, VA to Nevada,
 * WA to Delaware — and CT to "Select a state", which does not fill a required field, it
 * blanks one. The four states beginning with "New" are here so that ambiguity has
 * something to be ambiguous about.
 */
const STATES: SelectOption[] = [
  { value: '', label: 'Select a state' },
  { value: 'AL', label: 'Alabama' },
  { value: 'CA', label: 'California' },
  { value: 'CT', label: 'Connecticut' },
  { value: 'DE', label: 'Delaware' },
  { value: 'IA', label: 'Iowa' },
  { value: 'LA', label: 'Louisiana' },
  { value: 'MA', label: 'Massachusetts' },
  { value: 'NE', label: 'Nebraska' },
  { value: 'NV', label: 'Nevada' },
  { value: 'NH', label: 'New Hampshire' },
  { value: 'NJ', label: 'New Jersey' },
  { value: 'NM', label: 'New Mexico' },
  { value: 'NY', label: 'New York' },
  { value: 'OR', label: 'Oregon' },
  { value: 'VA', label: 'Virginia' },
  { value: 'WA', label: 'Washington' },
];

const SPONSORSHIP: SelectOption[] = [
  { value: '', label: 'Select an option' },
  { value: '1', label: 'Yes, now or in the future' },
  { value: '2', label: 'No, not now or in the future' },
];

describe('choosing an option in a dropdown', () => {
  /**
   * "US" is the profile's default country, and "Australia" contains the letters u-s. The
   * substring rule reached that label before it ever looked at the option carrying the
   * value "US", so the out-of-the-box profile selected the wrong country.
   */
  it('prefers an option that carries the value over a label that merely contains it', () => {
    expect(chooseOption(COUNTRIES, 'US')?.label).toBe('United States');
    expect(chooseOption(COUNTRIES, 'DE')?.label).toBe('Germany');
    expect(chooseOption(COUNTRIES, 'IE')?.label).toBe('Ireland');
    expect(chooseOption(COUNTRIES, 'IL')?.label).toBe('Israel');
    // And the same question asked with the full name still works.
    expect(chooseOption(COUNTRIES, 'United States')?.value).toBe('US');
  });

  it('sends every state code to its own state', () => {
    const codes = STATES.map((s) => s.value).filter(Boolean);
    const wrong = codes.filter((code) => chooseOption(STATES, code)?.value !== code);
    expect(wrong).toEqual([]);
  });

  /**
   * The one that decides applications. "No, not now or in the future" contains "no", and so
   * does "Yes, now or in the future" — a candidate who needs no sponsorship was recorded as
   * needing it, and one not authorized to work was recorded as authorized. Whole leading
   * words are what tell the two apart.
   */
  it('answers a prose sponsorship question on the side the profile meant', () => {
    expect(chooseOption(SPONSORSHIP, 'No')?.label).toBe('No, not now or in the future');
    expect(chooseOption(SPONSORSHIP, 'Yes')?.label).toBe('Yes, now or in the future');
  });

  it('never chooses the placeholder, which would blank the field rather than fill it', () => {
    expect(chooseOption(SPONSORSHIP, 'Select an option')).toBeUndefined();
    expect(chooseOption(COUNTRIES, 'Please select')).toBeUndefined();
  });

  it('refuses when two options fit equally well', () => {
    expect(chooseOption(STATES, 'New')).toBeUndefined();
  });

  it('will not identify an option from a single character', () => {
    const levels: SelectOption[] = [
      { value: 'a', label: 'A Levels' },
      { value: 'b', label: 'Baccalaureate' },
    ];
    expect(chooseOption(levels, 'A')?.value).toBe('a'); // an exact value still counts
    expect(chooseOption(levels, 'X')).toBeUndefined();
  });

  it('leaves a value it cannot place for the user', () => {
    expect(chooseOption(STATES, 'Ontario')).toBeUndefined();
  });
});

/** A `<select>` with no browser: it keeps the value it is given, or refuses it. */
function selectStub(options: SelectOption[], behaviour: { ignores?: boolean } = {}) {
  let held = '';
  const locator = {
    waitFor: () => Promise.resolve(),
    selectOption: (v: string) => {
      if (behaviour.ignores) return Promise.resolve();
      const hit = options.find((o) => o.value === v);
      if (!hit) return Promise.reject(new Error(`no option with value "${v}"`));
      held = hit.value;
      return Promise.resolve();
    },
    inputValue: () => Promise.resolve(held),
  };
  return {
    locator,
    get held() {
      return held;
    },
  };
}

/** A text box with no browser, reachable by a plain selector or by index. */
function textStub(afterType?: () => void) {
  let held = '';
  const locator = {
    nth: () => locator,
    waitFor: () => Promise.resolve(),
    click: () => Promise.resolve(),
    fill: (v: string) => {
      held = v;
      return Promise.resolve();
    },
    pressSequentially: (v: string) => {
      held += v;
      afterType?.();
      return Promise.resolve();
    },
    inputValue: () => Promise.resolve(held),
  };
  return {
    locator,
    get held() {
      return held;
    },
  };
}

/**
 * A single-line `<input>` that reacts to a keystroke the way the browser does.
 *
 * `pressSequentially` presses one key per character, and Playwright's US layout aliases both
 * "\n" and "\r" to Enter — so an Enter arriving here is the browser's implicit submission of
 * a form whose only text control is this box. The stub records it as a POST, which is the
 * outcome the fixture's `submissions` counter records against a real server.
 */
function keySubmittingInputStub() {
  let held = '';
  const submissions: string[] = [];
  const locator = {
    nth: () => locator,
    waitFor: () => Promise.resolve(),
    click: () => Promise.resolve(),
    fill: (v: string) => {
      held = v;
      return Promise.resolve();
    },
    pressSequentially: (v: string) => {
      for (const ch of v) {
        if (ch === '\n' || ch === '\r') submissions.push('POST /api/submit');
        else held += ch;
      }
      return Promise.resolve();
    },
    inputValue: () => Promise.resolve(held),
  };
  return {
    locator,
    submissions,
    get held() {
      return held;
    },
  };
}

/** A contenteditable box: no value, text content, and a page-level keyboard writing into it. */
function richtextStub(initial = '') {
  let held = initial;
  const locator = {
    nth: () => locator,
    waitFor: () => Promise.resolve(),
    click: () => Promise.resolve(),
    fill: (v: string) => {
      held = v;
      return Promise.resolve();
    },
    getAttribute: () => Promise.resolve(null),
    innerText: () => Promise.resolve(held),
  };
  return {
    locator,
    insertText: (t: string) => {
      held += t;
      return Promise.resolve();
    },
    get held() {
      return held;
    },
  };
}

/** A div-based combobox, whose options are elements to be read and clicked. */
function comboStub(options: SelectOption[]) {
  let held = '';
  const optionList = {
    count: () => Promise.resolve(options.length),
    evaluateAll: (fn: (els: unknown[]) => unknown) =>
      Promise.resolve(
        fn(
          options.map((o) => ({
            getAttribute: (n: string) => (n === 'data-value' ? o.value : null),
            textContent: o.label,
          })),
        ),
      ),
    nth: (i: number) => ({
      click: () => {
        held = options[i]!.value;
        return Promise.resolve();
      },
    }),
  };
  const locator = {
    nth: () => locator,
    waitFor: () => Promise.resolve(),
    click: () => Promise.resolve(),
    getAttribute: (n: string) => Promise.resolve(n === 'data-value' ? held : null),
    innerText: () => Promise.resolve(held),
    /**
     * A real Locator has this, and the option-scope walk uses it.
     *
     * `fillOne` scopes a declaration-less combobox to the nearest ancestor that actually
     * contains options, so a neighbouring question's identical "Yes" cannot be clicked for
     * this one. These stubs model a single widget with no surrounding document, so there is no
     * such ancestor: answering `count: 0` is the truthful answer and sends the code down its
     * frame fallback, which is what these cases were written against. The scoping itself is
     * exercised against real Chromium in the option-scope tests.
     */
    locator: () => ({ count: () => Promise.resolve(0) }),
  };
  return {
    locator,
    optionList,
    get held() {
      return held;
    },
  };
}

/**
 * A date input, which rejects a value of the wrong granularity exactly as the browser does.
 *
 * Playwright sets the value and then compares: when the input refuses it, `input.value` comes
 * back empty and Playwright throws "Malformed value" — two words written for a Playwright
 * maintainer that the user was shown next to their graduation date.
 */
function dateStub(kind: 'date' | 'month') {
  let held = '';
  const locator = {
    nth: () => locator,
    waitFor: () => Promise.resolve(),
    evaluate: (fn: (el: unknown) => string) => Promise.resolve(fn({ type: kind })),
    fill: (v: string) => {
      const shaped = kind === 'date' ? /^\d{4}-\d{2}-\d{2}$/ : /^\d{4}-\d{2}$/;
      if (!shaped.test(v)) return Promise.reject(new Error('Malformed value'));
      held = v;
      return Promise.resolve();
    },
    inputValue: () => Promise.resolve(held),
  };
  return {
    locator,
    get held() {
      return held;
    },
  };
}

function fieldOf(over: Partial<FormField>): FormField {
  return {
    id: 'f1',
    locator: '#control',
    label: 'A field',
    control: 'select',
    required: false,
    semantic: 'country',
    confidence: 1,
    ...over,
  } as FormField;
}

/**
 * Gives a stub the `and()` that `locate` narrows every locator with.
 *
 * `locate` intersects the stored selector with FILLABLE_CONTROLS, because the page can swap a
 * text input for a submit button between the scan and the fill — see fill.ts. Every stub here
 * stands for a control that IS fillable, so the intersection is the stub itself; returning it
 * unchanged is what real Playwright would do for these elements.
 *
 * What that means is that these cases cannot demonstrate the guard, only that it does not get
 * in the way. The guard itself is proved against real Chromium by 'a form that mutates under
 * the filler' below, which drives `executePlan` over a page that swaps a control mid-fill.
 *
 * This comment used to point at fixture.test.ts, which contains one test about the fixture
 * server starting up. A pointer to coverage that does not exist is worse than no pointer:
 * it is the reason somebody stops looking.
 *
 * Mutated rather than copied: the stubs close over their own state and several tests read it
 * back afterwards, so a spread would leave the assertions watching a discarded object.
 */
/** Stands in for a selector a stub has nothing for. Only ever used as the argument to `and()`. */
const UNMATCHED = { count: () => Promise.resolve(0), nth: () => UNMATCHED };

function withAnd(loc: unknown): unknown {
  if (loc === null || typeof loc !== 'object') return loc;
  const stub = loc as {
    and?: () => unknown;
    nth?: (i: number) => unknown;
    evaluate?: (fn: unknown, arg?: unknown) => unknown;
    __wrapped?: true;
  };
  if (stub.__wrapped) return loc;
  stub.__wrapped = true;
  if (!('and' in stub)) stub.and = () => loc;

  // `nth()` hands back a fresh object the frame stub never produced — the option inside a
  // combobox is reached that way — and that object is clicked, so it needs the same surface.
  const nth = stub.nth?.bind(stub);
  if (nth) stub.nth = (i: number) => withAnd(nth(i));

  /**
   * `refuseIfCanSubmit` asks the page, over the composed tree, whether anything RENDERED inside
   * this control can submit the form — the one question a selector cannot answer, because
   * slotted content is not a DOM descendant. Every stub here stands for an ordinary control
   * with nothing of the sort in it, so the honest answer is `null`.
   *
   * Told apart from the read-back evaluates by the argument the guard passes, and layered over
   * whatever `evaluate` the stub already had rather than replacing it. A stub that had none
   * still throws for any other use, so a real need for one surfaces instead of quietly
   * answering undefined.
   */
  const existing = stub.evaluate?.bind(stub);
  stub.evaluate = (fn: unknown, arg?: unknown) => {
    if (arg !== null && typeof arg === 'object' && 'selector' in arg) return Promise.resolve(null);
    if (!existing) throw new Error('this stub has no evaluate() for that call');
    return existing(fn, arg);
  };
  return loc;
}

function pageOfFrames(
  frames: { url: string | (() => string); locator: unknown | ((sel: string) => unknown) }[],
  keyboard: { insertText?: (t: string) => Promise<void> } = {},
): Page {
  const built = frames.map((f) => ({
    url: () => (typeof f.url === 'function' ? f.url() : f.url),
    isDetached: () => false,
    locator: (sel: string) => {
      // `locate` asks for FILLABLE_CONTROLS twice over: `.nth(n)` on it for an index locator,
      // which the stubs answer properly, and as the right-hand side of `and()`, which they
      // have no entry for. Only the second needs help, and it is told apart by the stub
      // failing to produce anything rather than by matching on the selector — the index path
      // asks for the same string and must keep getting the real answer.
      let resolved: unknown;
      try {
        resolved =
          typeof f.locator === 'function' ? (f.locator as (s: string) => unknown)(sel) : f.locator;
      } catch {
        resolved = undefined;
      }
      if (resolved === undefined || resolved === null) return UNMATCHED;
      return withAnd(resolved);
    },
  }));
  return {
    mainFrame: () => built[0],
    frames: () => built,
    keyboard: { insertText: keyboard.insertText ?? (() => Promise.resolve()) },
  } as unknown as Page;
}

/**
 * `source` defaults to 'profile', which is what nearly every case here is about.
 *
 * It is a parameter because the source is not decoration: 'answer' means these are the words
 * the user read and approved at G3, and fill.ts holds them to a stricter standard than a
 * phone number the page is free to reformat. See 'an approved answer that does not fit the box'.
 */
async function fillOnce(
  page: Page,
  field: FormField,
  value: string,
  source: FillAction['source'] = 'profile',
) {
  const result = await executePlan(page, {
    actions: [{ field, value, source }],
    skips: [],
  });
  return result.results[0]!;
}

/**
 * What the user is shown about a dropdown after it has been set.
 *
 * Re-reading a select cannot tell a good choice from a bad one — the page holds whatever it
 * was told — so the report used to print the value that was ASKED for whenever it differed
 * from the option code. The page said "Australia" and the report said "US", with a tick
 * beside it, on the one field a reader most needed to look at.
 */
describe('a dropdown reports the words the page is now showing', () => {
  it('shows the option label rather than the value that was planned', async () => {
    const select = selectStub(COUNTRIES);
    const page = pageOfFrames([{ url: 'http://form.test/', locator: select.locator }]);
    const r = await fillOnce(page, fieldOf({ label: 'Country', options: COUNTRIES }), 'US');

    expect(select.held).toBe('US');
    expect(r.status).toBe('ok');
    expect(r.readBack).toBe('United States');
  });

  it('reports a mismatch when the page does not keep the choice', async () => {
    const select = selectStub(COUNTRIES, { ignores: true });
    const page = pageOfFrames([{ url: 'http://form.test/', locator: select.locator }]);
    const r = await fillOnce(page, fieldOf({ label: 'Country', options: COUNTRIES }), 'US');

    expect(r.status).toBe('mismatch');
    expect(r.readBack).toBe('Please select');
    expect(r.note).toMatch(/Please select/);
  });

  it('leaves the dropdown untouched when nothing matches', async () => {
    const select = selectStub(STATES);
    const page = pageOfFrames([{ url: 'http://form.test/', locator: select.locator }]);
    const r = await fillOnce(page, fieldOf({ label: 'State', options: STATES }), 'Ontario');

    expect(r.status).toBe('skipped');
    expect(r.note).toMatch(/Choose it yourself/);
    expect(select.held).toBe('');
  });
});

/**
 * Which document a value goes into.
 *
 * A URL is not a frame's identity: every `srcdoc` iframe reports `about:srcdoc` and every
 * blank one `about:blank`, so a page with two essay editors sent both answers into the
 * first, left the second empty, and reported both filled. And when the recorded frame had
 * gone, falling back to the main document meant an index locator resolved in a completely
 * different page — which is how an approved essay was typed into a Social Security Number
 * box the redline pass had deliberately left alone.
 */
describe('the frame a field was found in', () => {
  it('tells two frames with the same URL apart', async () => {
    const main = textStub();
    const editorA = textStub();
    const editorB = textStub();
    const page = pageOfFrames([
      { url: 'http://form.test/', locator: main.locator },
      { url: 'about:srcdoc', locator: editorA.locator },
      { url: 'about:srcdoc', locator: editorB.locator },
    ]);

    // Neither editor has an id, so both fall back to the same index locator. The frame is
    // the only thing that distinguishes them.
    const q1 = fieldOf({
      id: 'q1',
      label: 'Question 1',
      control: 'textarea',
      semantic: 'essay',
      locator: '__index__0',
      frame: frameKey(1, 'about:srcdoc'),
    });
    const q2 = fieldOf({
      id: 'q2',
      label: 'Question 2',
      control: 'textarea',
      semantic: 'essay',
      locator: '__index__0',
      frame: frameKey(2, 'about:srcdoc'),
    });

    const result = await executePlan(page, {
      actions: [
        { field: q1, value: 'answer one', source: 'answer' },
        { field: q2, value: 'answer two', source: 'answer' },
      ],
      skips: [],
    });

    expect(result.results.map((r) => r.status)).toEqual(['ok', 'ok']);
    expect(editorA.held).toBe('answer one');
    expect(editorB.held).toBe('answer two');
  });

  it('says so rather than typing into a different document when the frame is gone', async () => {
    const main = textStub();
    const page = pageOfFrames([{ url: 'http://form.test/', locator: main.locator }]);
    const essay = fieldOf({
      label: 'Tell us about a project',
      control: 'textarea',
      semantic: 'essay',
      locator: '__index__0',
      frame: frameKey(1, 'about:srcdoc'),
    });

    const r = await fillOnce(page, essay, 'I built a tide chart that works offline.');

    expect(r.status).toBe('failed');
    expect(r.note).toMatch(/no longer there/i);
    // The main document, where the fallback used to land, is untouched.
    expect(main.held).toBe('');
  });
});

/**
 * What the page holds afterwards, and how much of it is enough.
 *
 * Read-back exists to catch a form that quietly refuses a value. Accepting any non-empty
 * prefix meant a controlled component that committed the first keystroke and dropped the
 * other 599 was reported "filled", with a green tick, above the words "Read the page, then
 * submit it yourself".
 */
describe('how much of a value counts as kept', () => {
  const ESSAY = `I built a tide chart that works offline. ${'x'.repeat(560)}`;

  function essayField() {
    return fieldOf({
      label: 'Tell us about a project',
      control: 'textarea',
      semantic: 'essay',
      locator: '#essay',
    });
  }

  it('calls a box holding one character of a 600-character answer a mismatch', async () => {
    const box = {
      nth: () => box,
      waitFor: () => Promise.resolve(),
      click: () => Promise.resolve(),
      fill: () => Promise.resolve(),
      pressSequentially: () => Promise.resolve(),
      // A controlled component that commits the first keystroke and ignores the rest.
      inputValue: () => Promise.resolve('I'),
    };
    const page = pageOfFrames([{ url: 'http://form.test/', locator: box }]);
    const r = await fillOnce(page, essayField(), ESSAY);

    expect(r.status).toBe('mismatch');
    expect(r.readBack).toBe('I');
    expect(describeFill({ results: [r], filled: 0, mismatched: 1, failed: 0 })).toMatch(
      /still needs you/,
    );
  });

  it('still forgives a form that trims a few characters off the end', async () => {
    const kept = ESSAY.slice(0, ESSAY.length - 5);
    const box = {
      nth: () => box,
      waitFor: () => Promise.resolve(),
      click: () => Promise.resolve(),
      fill: () => Promise.resolve(),
      pressSequentially: () => Promise.resolve(),
      inputValue: () => Promise.resolve(kept),
    };
    const page = pageOfFrames([{ url: 'http://form.test/', locator: box }]);
    expect((await fillOnce(page, essayField(), ESSAY)).status).toBe('ok');
  });

  /**
   * The same page and the same five characters, against words the user approved at G3.
   *
   * `KEPT_ENOUGH` is a tenth, and it applied to everything. A tenth of a reformatted phone
   * number is the form being helpful; a tenth of an essay is the last two sentences of it. An
   * ATS that caps a textarea from its own `input` handler — a character counter that slices,
   * with no maxlength attribute for the scanner to have read — kept 570 of 600 approved
   * characters and the run reported the field filled, in green, above "Read the page, then
   * submit it yourself". The test above is unchanged: the allowance is right where it came
   * from, and an approved answer is the case it was never meant to cover.
   */
  it('calls a box that dropped the end of an approved answer a mismatch, at the same five', async () => {
    const kept = ESSAY.slice(0, ESSAY.length - 5);
    const box = {
      nth: () => box,
      waitFor: () => Promise.resolve(),
      click: () => Promise.resolve(),
      fill: () => Promise.resolve(),
      pressSequentially: () => Promise.resolve(),
      inputValue: () => Promise.resolve(kept),
    };
    const page = pageOfFrames([{ url: 'http://form.test/', locator: box }]);
    const r = await fillOnce(page, essayField(), ESSAY, 'answer');

    expect(r.status).toBe('mismatch');
    // The two numbers, not the essay printed back at them: how much of the end is missing is
    // the one thing the student cannot see by looking at the box.
    expect(r.note).toContain('596 characters of the 601 you approved');
    expect(r.note).not.toContain(kept);
  });

  it('still calls an approved answer the page kept whole ok, however it respaced it', async () => {
    // The direction that would make the rule above unusable if it were wrong: a box that
    // doubles the space after a full stop has dropped no words at all.
    const respaced = ESSAY.replace('offline. ', 'offline.  ');
    const box = {
      nth: () => box,
      waitFor: () => Promise.resolve(),
      click: () => Promise.resolve(),
      fill: () => Promise.resolve(),
      pressSequentially: () => Promise.resolve(),
      inputValue: () => Promise.resolve(respaced),
    };
    const page = pageOfFrames([{ url: 'http://form.test/', locator: box }]);
    expect((await fillOnce(page, essayField(), ESSAY, 'answer')).status).toBe('ok');
  });

  it('clears a contenteditable first, so a second run does not answer twice', async () => {
    const answer = 'I build things that outlive the semester.';
    const box = richtextStub(answer);
    const page = pageOfFrames([{ url: 'http://form.test/', locator: box.locator }], {
      insertText: box.insertText,
    });
    const r = await fillOnce(
      page,
      fieldOf({ label: 'Why?', control: 'richtext', semantic: 'essay', locator: '#why' }),
      answer,
    );

    expect(box.held).toBe(answer);
    expect(r.status).toBe('ok');
  });
});

/**
 * An approved answer that is longer than the box the form gives it.
 *
 * 'respects a maxlength budget rather than letting the form truncate silently' above pins one
 * thing: `plan.actions[…].value` comes out 600 characters long for a 2000-character answer.
 * It follows the slice and stops there. What happens NEXT is that the page keeps all 600, the
 * read-back matches all 600, and the run reports the field filled — so a student who approved
 * 2000 characters at G3 sends an employer 600 of them ending mid-word, under a green tick,
 * with nothing anywhere saying a word was lost. The form was never the one truncating.
 *
 * There are only two honest endings, and this file is downstream of the first: shorten the
 * answer BEFORE approval where the user can see what goes, or report the field as not filled
 * and say why. Silently cutting it and calling it filled is not one of them.
 */
describe('an approved answer that does not fit the box', () => {
  const CAP = 200;

  function cappedEssay(maxLength?: number) {
    return fieldOf({
      label: 'Tell us about a project you are proud of. (200 characters max)',
      control: 'textarea',
      semantic: 'essay',
      locator: '#essay',
      maxLength,
    });
  }

  it('is not typed at all, and the field is reported as still needing the user', async () => {
    const box = textStub();
    const page = pageOfFrames([{ url: 'http://form.test/', locator: box.locator }]);
    // What `plan.ts` hands over: an answer already cut to the field's own budget.
    const r = await fillOnce(page, cappedEssay(CAP), 'y'.repeat(CAP), 'answer');

    expect(r.status).toBe('skipped');
    expect(r.note).toContain('200 characters');
    expect(r.note).toMatch(/Shorten the answer/);
    // Nothing was typed. Half an approved answer sitting in an employer's box is worse than
    // an empty box, because an empty box is visible from across the room.
    expect(box.held).toBe('');
    expect(describeFill({ results: [r], filled: 0, mismatched: 0, failed: 0 })).toMatch(
      /still needs you/,
    );
  });

  it('still types an approved answer that fits, so this is not a blanket refusal', async () => {
    const box = textStub();
    const page = pageOfFrames([{ url: 'http://form.test/', locator: box.locator }]);
    const answer = 'z'.repeat(CAP - 1);
    const r = await fillOnce(page, cappedEssay(CAP), answer, 'answer');

    expect(r.status).toBe('ok');
    expect(box.held).toBe(answer);
  });

  it('types an approved answer into a box that declares no budget at all', async () => {
    const box = textStub();
    const page = pageOfFrames([{ url: 'http://form.test/', locator: box.locator }]);
    const answer = 'w'.repeat(4000);
    const r = await fillOnce(page, cappedEssay(undefined), answer, 'answer');

    expect(r.status).toBe('ok');
    expect(box.held).toBe(answer);
  });

  /**
   * The sibling this deliberately does NOT cover, pinned so a later edit does not extend the
   * rule over it by accident.
   *
   * `plan.ts` runs the same `slice(0, field.maxLength)` on profile values one branch below the
   * answers. The identical test there would fire on nearly every form that sets a maxlength at
   * all: a state field is `maxlength="2"` and holds "NJ", a postal field `maxlength="5"` and
   * holds "08901", a phone `maxlength="10"`. Those caps are the length of the data, so a value
   * ending on the cap says nothing — and a page of correct fields marked "needs you" is how
   * you teach someone to click past the one that matters. On an approved answer the cap is a
   * budget nobody wrote to, so landing exactly on it is evidence.
   */
  it('leaves a profile value that ends on its own cap alone, because "NJ" is not a cut', async () => {
    const box = textStub();
    const page = pageOfFrames([{ url: 'http://form.test/', locator: box.locator }]);
    const state = fieldOf({
      label: 'State',
      control: 'text',
      semantic: 'region',
      locator: '#state',
      maxLength: 2,
    });
    const r = await fillOnce(page, state, 'NJ');

    expect(r.status).toBe('ok');
    expect(box.held).toBe('NJ');
  });
});

/**
 * Radios and comboboxes are option lists too.
 *
 * `chooseOption` was hardened after prose labels matched by letters sent "US" to Australia
 * and "No" to "Yes, now or in the future". Both of these branches went on matching by
 * letters afterwards — and they are the branches that answer work authorization and
 * sponsorship, the two questions that decide an application on their own.
 */
describe('option lists that are not <select>', () => {
  const ENROLLMENT = [
    { value: 'a', label: 'Currently enrolled part-time', locator: '#a' },
    { value: 'b', label: 'Currently enrolled full-time', locator: '#b' },
    { value: 'c', label: 'Not currently enrolled', locator: '#c' },
  ];

  function radioStub() {
    let checked = false;
    const locator = {
      nth: () => locator,
      waitFor: () => Promise.resolve(),
      check: () => {
        checked = true;
        return Promise.resolve();
      },
      isChecked: () => Promise.resolve(checked),
    };
    return {
      locator,
      get checked() {
        return checked;
      },
    };
  }

  it('leaves a radio group alone when two options begin with the answer', async () => {
    const buttons = new Map(ENROLLMENT.map((o) => [o.locator, radioStub()]));
    const page = pageOfFrames([
      { url: 'http://form.test/', locator: (sel: string) => buttons.get(sel)!.locator },
    ]);
    const r = await fillOnce(
      page,
      fieldOf({
        label: 'Enrollment status',
        control: 'radio',
        semantic: 'enrollment_status',
        locator: '#a',
        options: ENROLLMENT,
      }),
      'Currently enrolled',
    );

    expect(r.status).toBe('skipped');
    expect(r.note).toMatch(/Choose it yourself/);
    expect([...buttons.values()].filter((b) => b.checked)).toEqual([]);
  });

  it('still ticks the radio when exactly one option is the answer', async () => {
    const options = [
      { value: 'yes', label: 'Yes', locator: '#yes' },
      { value: 'no', label: 'No', locator: '#no' },
    ];
    const buttons = new Map(options.map((o) => [o.locator, radioStub()]));
    const page = pageOfFrames([
      { url: 'http://form.test/', locator: (sel: string) => buttons.get(sel)!.locator },
    ]);
    const r = await fillOnce(
      page,
      fieldOf({
        label: 'Are you authorized to work?',
        control: 'radio',
        semantic: 'work_auth',
        locator: '#yes',
        options,
      }),
      'Yes',
    );

    expect(r.status).toBe('ok');
    expect(r.readBack).toBe('Yes');
    expect(buttons.get('#yes')!.checked).toBe(true);
    expect(buttons.get('#no')!.checked).toBe(false);
  });

  it('picks the sponsorship option meant, not the one carrying the letters', async () => {
    const combo = comboStub(SPONSORSHIP.filter((o) => o.value !== ''));
    const page = pageOfFrames([
      {
        url: 'http://form.test/',
        locator: (sel: string) =>
          sel.startsWith('[role=option]') ? combo.optionList : combo.locator,
      },
    ]);
    const r = await fillOnce(
      page,
      fieldOf({
        label: 'Do you now or will you in the future require sponsorship?',
        control: 'combobox',
        semantic: 'sponsorship_needed',
        locator: '#sponsor',
      }),
      'No',
    );

    expect(combo.held).toBe('2');
    expect(r.status).toBe('ok');
    expect(r.readBack).toBe('No, not now or in the future');
  });

  it('leaves a combobox for the user when a decoy option is in the way', async () => {
    const combo = comboStub([
      { value: '0', label: 'Not sure' },
      { value: '1', label: 'Prefer not to say' },
    ]);
    const page = pageOfFrames([
      {
        url: 'http://form.test/',
        locator: (sel: string) =>
          sel.startsWith('[role=option]') ? combo.optionList : combo.locator,
      },
    ]);
    const r = await fillOnce(
      page,
      fieldOf({ label: 'Sponsorship', control: 'combobox', locator: '#sponsor' }),
      'No',
    );

    expect(r.status).toBe('skipped');
    expect(combo.held).toBe('');
  });
});

/**
 * A month is not a day.
 *
 * The profile stores a graduation as "2027-05" and an availability as "2027-06-01", and the
 * scanner reports `<input type=date>` and `<input type=month>` as the same kind of control.
 * Whichever the employer used, one of them was handed a value it cannot hold, and the user
 * was shown Playwright's own words — "Malformed value" — beside the commonest education
 * field on an application form.
 */
describe('a date input gets a date its own shape', () => {
  it('pads a graduation month out to a day for an input that wants one', async () => {
    const box = dateStub('date');
    const page = pageOfFrames([{ url: 'http://form.test/', locator: box.locator }]);
    const r = await fillOnce(
      page,
      fieldOf({ label: 'Expected graduation', control: 'date', semantic: 'graduation_date' }),
      '2027-05',
    );

    expect(box.held).toBe('2027-05-01');
    expect(r.status).toBe('ok');
    expect(r.note).toMatch(/only the month/i);
  });

  it('trims an availability date down to a month for an input that wants one', async () => {
    const box = dateStub('month');
    const page = pageOfFrames([{ url: 'http://form.test/', locator: box.locator }]);
    const r = await fillOnce(
      page,
      fieldOf({ label: 'Available from', control: 'date', semantic: 'start_date' }),
      '2027-06-01',
    );

    expect(box.held).toBe('2027-06');
    expect(r.status).toBe('ok');
  });
});

/**
 * A run that found nothing has not filled anything.
 *
 * "All 0 fields filled. Read the page, then submit it yourself." was rendered under a green
 * "0 filled" badge on any page whose form had not appeared yet — a career-site SPA, a form
 * behind an "Apply now" step — and the application was walked on to awaiting_submit behind it.
 */
describe('what the user is told when there was nothing to fill', () => {
  it('says nothing was typed rather than that everything was', () => {
    const said = describeFill({ results: [], filled: 0, mismatched: 0, failed: 0 });
    expect(said).toMatch(/nothing was typed/i);
    expect(said).not.toMatch(/all 0 fields filled/i);
  });
});

/**
 * The two guards in `buildFillPlan` that nothing on a real page can reach.
 *
 * Every other test in this file feeds the planner fields the scanner produced, and the
 * scanner only ever emits a semantic it recognised at 0.8 to 0.99 with the redline pass
 * already applied — so in `field.semantic === 'REDLINE' || red` the second disjunct never
 * decides, and the confidence floor never has anything below it to refuse. Both exist for
 * the classifier docs/07 § Classification specifies and this project has not built: an LLM
 * fallback that returns its own semantic and its own confidence, neither of which has been
 * anywhere near the redline table. These synthetic fields are what that stage would hand
 * over on a bad day.
 */
describe('the plan re-checks what it was handed', () => {
  const plan = (over: Partial<FormField>) =>
    buildFillPlan({
      fields: [fieldOf({ locator: '#x', control: 'text', ...over })],
      profile: PROFILE,
      answers: [],
    });

  it('refuses a redlined label however confidently it was classified', () => {
    // A social security number arriving labelled as a first name, at 0.97. Trusting the
    // handed-down semantic would type the applicant's given name into an SSN box on an
    // employer's form.
    const { actions, skips } = plan({
      label: 'Social Security Number',
      semantic: 'first_name',
      confidence: 0.97,
    });
    expect(actions).toEqual([]);
    expect(skips.map((s) => s.reason)).toEqual(['redline']);
    expect(skips[0]!.note).toMatch(/type this yourself/i);
  });

  /**
   * Every redline category, not only the identity number that prompted this. A guard that
   * covered one category and missed its six siblings is how this class of hole reopens.
   */
  it.each([
    ['government_id', 'Social Security Number'],
    ['financial', 'Bank account number'],
    ['credential', 'Password'],
    ['attestation', 'I certify that the above is true'],
    ['consent', 'I consent to a background check'],
    ['eeo_demographic', 'Race / Ethnicity'],
    ['ai_disclosure', 'Did you use AI to write this application?'],
  ])('refuses a %s field the classifier called fillable', (_category, label) => {
    const { actions, skips } = plan({ label, semantic: 'first_name', confidence: 0.99 });
    expect(actions).toEqual([]);
    expect(skips.map((s) => s.reason)).toEqual(['redline']);
  });

  it('leaves a field blank when the guess was below the confidence floor', () => {
    // The profile HAS a phone number, so nothing but the floor can refuse this one.
    const { actions, skips } = plan({
      label: 'Some field',
      semantic: 'phone',
      confidence: 0.4,
    });
    expect(actions).toEqual([]);
    expect(skips.map((s) => s.reason)).toEqual(['unknown']);
    expect(skips[0]!.note).toMatch(/could not tell what this field is/i);
  });

  it('fills the same field once the guess reaches the floor', () => {
    // Without this the test above would still pass if the planner had simply stopped
    // filling phone numbers.
    const { actions, skips } = plan({
      label: 'Some field',
      semantic: 'phone',
      confidence: CONFIDENCE_FLOOR,
    });
    expect(skips).toEqual([]);
    expect(actions.map((a) => a.value)).toEqual(['+1 555 0100']);
  });
});

/**
 * Which document the plan is being typed into.
 *
 * The iframe half of this has a guard; the main document did not, and `frameFor` handed back
 * `page.mainFrame()` whatever address it was showing. A country `<select>` whose onchange
 * sets `location.href` is enough — an everyday form pattern — and every remaining locator
 * then resolved in a page the scanner had never read and the redline pass had never seen.
 */
describe('the page moving under a fill', () => {
  it('stops the plan instead of typing into whatever loaded next', async () => {
    let url = 'http://form.test/step1';
    const country = textStub(() => {
      url = 'http://form.test/step2';
    });
    const next = textStub();
    const page = pageOfFrames([
      {
        url: () => url,
        locator: (sel: string) => (sel === '#country' ? country.locator : next.locator),
      },
    ]);

    const result = await executePlan(
      page,
      {
        actions: [
          {
            field: fieldOf({ label: 'Country', locator: '#country', control: 'text' }),
            value: 'US',
            source: 'profile',
          },
          {
            field: fieldOf({
              label: 'Tell us about a project',
              control: 'textarea',
              semantic: 'essay',
              locator: '__index__1',
            }),
            value: 'I built a tide chart that works offline.',
            source: 'answer',
          },
        ],
        skips: [],
      },
      { documentUrl: 'http://form.test/step1' },
    );

    expect(result.results[1]!.status).toBe('failed');
    expect(result.results[1]!.note).toMatch(/moved to a different address/i);
    // Nothing was typed into the document that replaced the form.
    expect(next.held).toBe('');
  });

  it('does not object to a form that only adds a query string to its own address', async () => {
    let url = 'http://form.test/apply';
    const first = textStub(() => {
      url = 'http://form.test/apply?step=2#top';
    });
    const second = textStub();
    const page = pageOfFrames([
      {
        url: () => url,
        locator: (sel: string) => (sel === '#a' ? first.locator : second.locator),
      },
    ]);

    const result = await executePlan(
      page,
      {
        actions: [
          {
            field: fieldOf({ label: 'First name', locator: '#a', control: 'text' }),
            value: 'Rosa',
            source: 'profile',
          },
          {
            field: fieldOf({ label: 'Last name', locator: '#b', control: 'text' }),
            value: 'Alvarez',
            source: 'profile',
          },
        ],
        skips: [],
      },
      { documentUrl: 'http://form.test/apply' },
    );

    expect(result.results.map((r) => r.status)).toEqual(['ok', 'ok']);
    expect(second.held).toBe('Alvarez');
  });
});

/**
 * A sign-in page is still a sign-in page with a career site's furniture around it.
 *
 * The escape hatch that rescues a real application form from the login verdict counted every
 * control in the document, so a header search box, a footer language picker and the sign-in
 * form's own email field made three — and the run went on to offer to type the user's email
 * into a password-protected sign-in box.
 */
describe('telling a login wall from an application form', () => {
  it('still calls it a login wall when the page chrome supplies the controls', async () => {
    await session.page.goto(`${fixture.url}/login`);
    await session.page.setContent(
      '<header><input type="search" name="q" placeholder="Search jobs">' +
        '<select name="lang"><option>English</option></select></header>' +
        '<main><form><input id="e" type="email"><input id="p" type="password">' +
        '<button type="submit">Sign in</button></form></main>' +
        '<footer><select name="region"><option>United States</option></select></footer>',
    );
    expect((await detectIntervention(session.page))?.reason).toBe('login');
  }, 30_000);

  it('still lets an application form carrying an account section through', async () => {
    await session.page.setContent(
      '<header><input type="search" name="q"></header>' +
        '<form><input id="n" name="name"><input id="e" type="email">' +
        '<input id="ph" name="phone"><input id="pw" type="password">' +
        '<textarea id="w" name="why"></textarea></form>',
    );
    expect(await detectIntervention(session.page)).toBeNull();
  }, 30_000);
});

describe('gate G4 — the whole point', () => {
  const TWO_PARAGRAPHS = 'Para one about infrastructure.\n\nPara two about reliability.';

  it('has not submitted a single form across this entire suite', () => {
    // The fixture counts POSTs. This asserts the outcome, not the implementation.
    expect(submissions).toEqual([]);
  });

  it('has no submit control in any fill plan', async () => {
    const { plan } = await run('/simple', [WHY_ANSWER, APPROVED_ANSWER]);
    for (const a of plan.actions) {
      expect(a.field.locator).not.toMatch(/submit/i);
      expect(a.field.control).not.toBe('button');
    }
  }, 90_000);

  /**
   * The one that is not about clicking.
   *
   * `pressSequentially` presses a key per character and Playwright's layout aliases "\n" and
   * "\r" to Enter, so a two-paragraph answer the user had approved but not yet seen on the
   * page pressed Enter twice in a single-line box — and in a form whose only text control is
   * that box, Enter is submit. The application went to the employer, the field was reported
   * as a mismatch and the rest as timeouts, and nothing in the run said a word about it.
   *
   * Every essay control in the fixture is a <textarea>, where Enter inserts a line and
   * submits nothing, which is why the POST counter above never caught this.
   */
  it('types a multi-line answer into a single-line input without pressing Enter', async () => {
    const box = keySubmittingInputStub();
    const page = pageOfFrames([{ url: 'http://form.test/apply', locator: box.locator }]);
    const r = await fillOnce(
      page,
      fieldOf({
        label: 'In a sentence or two, why do you want to intern with our team this summer?',
        control: 'text',
        semantic: 'essay',
        locator: '#q',
      }),
      TWO_PARAGRAPHS,
    );

    expect(box.submissions).toEqual([]);
    expect(box.held).toBe('Para one about infrastructure.  Para two about reliability.');
    expect(r.status).toBe('ok');
    expect(r.note).toMatch(/one line/i);
  });

  it('keeps a multi-line answer whole in a textarea, still without pressing Enter', async () => {
    const box = keySubmittingInputStub();
    const typed: string[] = [];
    const page = pageOfFrames([{ url: 'http://form.test/apply', locator: box.locator }], {
      insertText: (t) => {
        typed.push(t);
        return Promise.resolve();
      },
    });
    await fillOnce(
      page,
      fieldOf({
        label: 'Tell us about a project',
        control: 'textarea',
        semantic: 'essay',
        locator: '#essay',
      }),
      TWO_PARAGRAPHS,
    );

    expect(box.submissions).toEqual([]);
    // The breaks went in as text, which fires no key events at all.
    expect(typed).toEqual(['\n', '\n']);
  });

  /**
   * The same thing against a real browser and a real server, because the stub above can only
   * prove that this code does not hand Playwright a line break — not that Playwright and
   * Chromium behave as described. The fixture records every POST it receives.
   */
  it('does not submit a real single-input form given a multi-line answer', async () => {
    await session.page.goto(`${fixture.url}/simple`);
    await session.page.setContent(
      '<form method="POST" action="/g4-implicit-submit">' +
        '<label for="q">In a sentence or two, why do you want to intern with our team?</label>' +
        '<input id="q" name="q"></form>',
    );
    // If this were about:blank the form could not reach the fixture and the test would
    // prove nothing.
    expect(session.page.url()).toContain(fixture.url);
    const before = session.page.url();

    const r = await fillOnce(
      session.page,
      fieldOf({
        label: 'In a sentence or two, why do you want to intern with our team?',
        control: 'text',
        semantic: 'essay',
        locator: '#q',
      }),
      TWO_PARAGRAPHS,
    );

    expect(submissions).toEqual([]);
    expect(session.page.url()).toBe(before);
    expect(r.status).toBe('ok');
    expect(await session.page.locator('#q').inputValue()).toBe(
      'Para one about infrastructure.  Para two about reliability.',
    );
  }, 60_000);
});

/**
 * The one sentence in this app that must never be a claim.
 *
 * `describeFill` ended every partial run with "Nothing has been submitted." — including the
 * run where `executePlan` detected a mid-fill navigation, which run.ts itself attributes to
 * "a select whose onchange navigates, a form that submits itself". `selectOption`, `check`
 * and `click` all fire the page's own handlers, so a form that submits itself on change
 * genuinely can have been submitted, and nothing in this process can tell. Printing the
 * promise anyway is the exact failure the G4 guarantee exists to prevent: not a submission,
 * but a false statement that there was not one.
 */
describe('what the summary promises after a page moved', () => {
  const partial = (over: Partial<FillResult> = {}): FillResult => ({
    // Only the two properties describeFill reads. The full FieldResult carries a planned
    // field with a dozen more, none of which changes a sentence.
    results: [
      { field: { label: 'Name', selector: '#n' }, status: 'ok' },
      { field: { label: 'Essay', selector: '#e' }, status: 'skipped', note: 'not reached' },
    ] as unknown as FillResult['results'],
    filled: 1,
    mismatched: 0,
    failed: 0,
    ...over,
  });

  it('says nothing was submitted when the page never moved', () => {
    expect(describeFill(partial())).toContain('Nothing has been submitted.');
  });

  /**
   * And the ending where EVERY field succeeded, which is the one most likely to reach this.
   *
   * A navigation caused by the LAST field leaves every result `ok`, and the all-clear branch
   * returned before the sentence about the page moving was ever built — so the run printed
   * "All 3 fields filled. Read the page, then submit it yourself." and said nothing about the
   * navigation at all. That is the exact case `movedTo` exists for, and it sent the student to
   * submit a form that may already have submitted itself.
   */
  const allFilled = (over: Partial<FillResult> = {}): FillResult => ({
    results: [
      { field: { label: 'Name', selector: '#n' }, status: 'ok' },
      { field: { label: 'Email', selector: '#e' }, status: 'ok' },
    ] as unknown as FillResult['results'],
    filled: 2,
    mismatched: 0,
    failed: 0,
    ...over,
  });

  it('does not print the all-clear when the page moved under a fully successful run', () => {
    const text = describeFill(allFilled({ movedTo: 'https://careers.acme.com/thanks' }));
    expect(text).toContain('https://careers.acme.com/thanks');
    expect(text).toMatch(/a page can submit itself/);
    // The sentence that sends them off to submit it must not be there: it may be done already.
    expect(text).not.toMatch(/submit it yourself/);
  });

  it('still gives the plain all-clear when nothing moved', () => {
    const text = describeFill(allFilled());
    expect(text).toBe('All 2 fields filled. Read the page, then submit it yourself.');
  });

  it('stops promising it when the page moved, and names where it went', () => {
    const text = describeFill(partial({ movedTo: 'https://careers.acme.com/apply?step=2' }));
    expect(text).not.toContain('Nothing has been submitted.');
    expect(text).toContain('https://careers.acme.com/apply?step=2');
  });

  it('still says what this tool did not do, which is all it honestly can', () => {
    // Not silence either: the student needs to know the tool did not submit, and that the
    // page might have. Both halves, or the sentence is as misleading as the old one.
    const text = describeFill(partial({ movedTo: 'https://careers.acme.com/step2' }));
    expect(text).toMatch(/did not submit/i);
    expect(text).toMatch(/a page can submit itself/i);
  });

  it('still reports how many fields were filled either way', () => {
    for (const r of [partial(), partial({ movedTo: 'https://x.example/2' })]) {
      expect(describeFill(r)).toMatch(/1 filled/);
    }
  });
});

/**
 * A document replaced without the address changing.
 *
 * `sameDocument` compares the URL, and the URL cannot answer the question: `?step=2` is a new
 * document after `location.href =` and the SAME one after `history.pushState`, which is what
 * an application form built as a single-page app does on every step. Tightening the URL rule
 * would stop fills that are going fine — there is a test above asserting exactly that — and
 * leaving it loose lets a real navigation past. So the document is stamped when its controls
 * are numbered, and the stamp is re-read after each field: a navigation loses it, a pushState
 * keeps it.
 */
describe('the document token', () => {
  it('is written when the form is scanned', async () => {
    await session.page.goto(`${fixture.url}/simple`);
    const map = await buildFormMap(session.page);
    expect(map.documentToken).toMatch(/^ia-/);
    await expect(
      session.page.evaluate(
        () => (window as unknown as Record<string, string | undefined>)['__iaDocumentToken'],
      ),
    ).resolves.toBe(map.documentToken);
  });

  it('survives a pushState, so an SPA step does not stop a fill', async () => {
    await session.page.goto(`${fixture.url}/simple`);
    const map = await buildFormMap(session.page);
    await session.page.evaluate(() => {
      history.pushState({}, '', '?step=2');
    });
    // The address changed and the document did not — every locator in the plan is still valid.
    await expect(
      session.page.evaluate(
        () => (window as unknown as Record<string, string | undefined>)['__iaDocumentToken'],
      ),
    ).resolves.toBe(map.documentToken);
  });

  it('is lost to a reload of the same address, which the URL check cannot see', async () => {
    await session.page.goto(`${fixture.url}/simple`);
    const map = await buildFormMap(session.page);
    await session.page.reload();
    // Same URL, new document: `sameDocument` says nothing moved and every index locator now
    // describes a DOM that has been rebuilt.
    expect(sameDocument(session.page.url(), map.url)).toBe(true);
    await expect(
      session.page.evaluate(
        () => (window as unknown as Record<string, string | undefined>)['__iaDocumentToken'],
      ),
    ).resolves.not.toBe(map.documentToken);
  });

  it('is lost to a real navigation to a different page', async () => {
    await session.page.goto(`${fixture.url}/simple`);
    const map = await buildFormMap(session.page);
    await session.page.goto(`${fixture.url}/login`);
    await expect(
      session.page.evaluate(
        () => (window as unknown as Record<string, string | undefined>)['__iaDocumentToken'],
      ),
    ).resolves.not.toBe(map.documentToken);
  });
});

/**
 * Which question's options a dropdown is allowed to see.
 *
 * A combobox that declares `aria-controls` names its own listbox and there is no ambiguity.
 * A hand-rolled one — the shape `IMPLICIT_SUBMIT` exists for — declares nothing, and the
 * fallback was the WHOLE FRAME: `chooseOption` then picked the first option anywhere in the
 * document whose value or label matched. Yes/no options are duplicated across every yes/no
 * question on an application form, so "Yes" for "are you authorized to work" and "Yes" for
 * "do you require sponsorship" are indistinguishable by value or label. The answer to one
 * question could be clicked in another, and read-back would compare the right value against
 * the right box and call it filled.
 */
describe('which options a declaration-less combobox can reach', () => {
  const TWO_QUESTIONS = `<form>
    <div id="q1">
      <label id="l1" for="c1">Are you authorized to work in the US?</label>
      <div id="c1" role="combobox" aria-labelledby="l1" tabindex="0"
           style="width:200px;height:28px;border:1px solid">Choose</div>
      <div role="listbox">
        <div role="option" data-value="auth-yes">Yes</div>
        <div role="option" data-value="auth-no">No</div>
      </div>
    </div>
    <div id="q2">
      <label id="l2" for="c2">Do you now or in the future require sponsorship?</label>
      <div id="c2" role="combobox" aria-labelledby="l2" tabindex="0"
           style="width:200px;height:28px;border:1px solid">Choose</div>
      <div role="listbox">
        <div role="option" data-value="spon-yes">Yes</div>
        <div role="option" data-value="spon-no">No</div>
      </div>
    </div>
  </form>`;

  it('picks each question’s own option, not the first one on the page', async () => {
    // THE REAL PATH. Two tests used to sit here re-implementing the ancestor walk inside the
    // test's own `evaluate` and asserting on that — facts about this fixture's DOM, not about
    // `fillOne`, which is where the scoping lives. Neither could fail if the xpath scope in
    // fill.ts went away.
    //
    // Both questions are yes/no, and the whole-frame fallback offered the FIRST "Yes" on the
    // page to every one of them — so the sponsorship answer was taken from the work-auth
    // question's list.
    const page = await session.context.newPage();
    try {
      await page.setContent(
        TWO_QUESTIONS +
          `<script>
            window.__clicked = [];
            document.addEventListener('click', function (e) {
              var t = e.target;
              if (t && t.getAttribute && t.getAttribute('role') === 'option') {
                window.__clicked.push(t.getAttribute('data-value'));
              }
            });
          </script>`,
      );

      const map = await buildFormMap(page);
      const sponsorship = map.fields.find((f) => f.semantic === 'sponsorship_needed');
      expect(sponsorship, 'the fixture must map a sponsorship question').toBeDefined();

      await executePlan(page, buildFillPlan({ fields: map.fields, profile: PROFILE, answers: [] }));

      const clicked = await page.evaluate(
        () => (window as unknown as { __clicked: string[] }).__clicked,
      );
      // Every option this run clicked came from the question it belonged to.
      expect(clicked.length).toBeGreaterThan(0);
      for (const value of clicked) {
        expect(value, `clicked ${value}`).toMatch(/^(auth|spon)-/);
      }
      // And the sponsorship answer specifically came out of the sponsorship list.
      expect(clicked.some((v) => v.startsWith('spon-'))).toBe(true);
    } finally {
      await page.close();
    }
  }, 90_000);
});

/**
 * A page that changes what a locator points at, between the scan and the fill.
 *
 * The two are separated by seconds and the page owns what happens in between. A stored
 * locator is a plain CSS string, and it used to be handed to `frame.locator()` with nothing
 * checking that it still resolved to something fillable — so a page could serve two ordinary
 * text inputs, nothing in the markup excluded by anything, and swap the second for a
 * `<button>` with no `type` attribute (which IS `type="submit"`) the moment the FIRST field
 * received a real key event, which `pressSequentially` guarantees.
 *
 * Verified in Chromium before `locate` narrowed every locator: `#q2` resolved to the button,
 * the click landed before `fill()` could throw, and the form was submitted. Nothing in
 * selectors.ts can prevent that — the element was entirely legal when it was scanned — which
 * is why this runs against a real browser and not the stubs above.
 */
describe('a form that mutates under the filler', () => {
  const MUTATING = `<form id="f" action="/submitted" method="POST">
    <input id="q1" type="text" aria-label="Full name">
    <input id="q2" type="text" aria-label="Email address">
  </form>
  <script>
    window.__submitted = false;
    document.getElementById('f').addEventListener('submit', function (e) {
      e.preventDefault();
      window.__submitted = true;
    });
    document.getElementById('q1').addEventListener('keydown', function once() {
      document.getElementById('q1').removeEventListener('keydown', once);
      var b = document.createElement('button');
      b.id = 'q2';
      b.textContent = 'Email address';
      document.getElementById('q2').replaceWith(b);
    });
  </script>`;

  it('does not click a control that became a submit button after the scan', async () => {
    const page = await session.context.newPage();
    try {
      await page.setContent(MUTATING);

      // What the scan legitimately sees: two ordinary text inputs.
      const map = await buildFormMap(page);
      expect(map.fields.map((f) => f.locator)).toEqual(['#q1', '#q2']);

      // THE REAL PATH. An earlier version of this test built
      // `page.locator('#q2').and(page.locator(FILLABLE_CONTROLS))` itself and asserted that it
      // matched nothing — which is a fact about Playwright's `and()` and about the
      // FILLABLE_CONTROLS constant, not about `locate()`. Reverting the narrowing in fill.ts
      // left it green, and left the whole 1,900-test suite green with it. Reconstructing the
      // fix inside the test is what made the test unable to notice the fix going away.
      const plan = buildFillPlan({ fields: map.fields, profile: PROFILE, answers: [] });
      const result = await executePlan(page, plan);

      // The first field types, which is what fires the swap.
      expect(result.results[0]?.status).toBe('ok');

      // The second resolves to nothing, so it fails BEFORE anything is clicked — and says so
      // in words the student can act on, rather than in Playwright's.
      const second = result.results[1];
      expect(second?.status).toBe('failed');
      expect(second?.note).toMatch(/must not touch|is not there now/);
      expect(second?.note).not.toMatch(/locator\.|Timeout \d+ms/);

      expect(
        await page.evaluate(() => (window as unknown as { __submitted: boolean }).__submitted),
      ).toBe(false);
    } finally {
      await page.close();
    }
  }, 60_000);
});

/**
 * A submit control that is RENDERED inside a widget without being inside it.
 *
 * `:has()` walks the DOM tree, and slotted content is not in it. A custom element whose shadow
 * root is `<div role="combobox"><slot></slot></div>` renders whatever light-DOM children the
 * host was given inside that div, so a page author writes
 *
 *     <x-combo><input type="submit" value="Email address"></x-combo>
 *
 * and the div's only DOM child is the `<slot>`. Every `:not(:has(...))` clause answers "nothing
 * dangerous in there", the scanner maps the div as a combobox, and the fill path's first act on
 * a combobox is to click it — onto the submit control rendered in its place. Verified through
 * `buildFormMap`, `buildFillPlan` and `executePlan` against real Chromium before the fix: the
 * form was submitted, and the run reported "Nothing has been submitted."
 *
 * No selector can see this, because the relationship is a rendering one and not a structural
 * one. `fill.ts` asks the page over the composed tree instead, immediately before it clicks.
 */
describe('a widget that renders a submit control it does not contain', () => {
  const SLOTTED = `<form id="f" action="/submitted" method="POST">
      <input id="name" type="text" autocomplete="name" aria-label="Full name">
      <x-combo id="combo" aria-label="Email address">
        <input type="submit" value="Email address" style="width:220px;height:30px">
      </x-combo>
    </form>
    <script>
      window.__submitted = false;
      document.getElementById('f').addEventListener('submit', function (e) {
        e.preventDefault();
        window.__submitted = true;
      });
      customElements.define('x-combo', class extends HTMLElement {
        connectedCallback() {
          var root = this.attachShadow({ mode: 'open' });
          root.innerHTML =
            '<div role="combobox" aria-label="Email address" autocomplete="email" ' +
            'style="display:inline-block"><slot></slot></div>';
        }
      });
    </script>`;

  it('is not clicked, and the ordinary field beside it still fills', async () => {
    const page = await session.context.newPage();
    try {
      await page.setContent(SLOTTED);
      await page.waitForTimeout(200);

      // The scanner does map it — the shadow div really is a `[role=combobox]` that no
      // exclusion can see through — so the guard has to be the thing that stops the click.
      const map = await buildFormMap(page);
      expect(map.fields.some((f) => f.control === 'combobox')).toBe(true);

      const plan = buildFillPlan({ fields: map.fields, profile: PROFILE, answers: [] });
      const result = await executePlan(page, plan);

      const combo = result.results.find((r) => r.field.control === 'combobox');
      expect(combo?.status).toBe('failed');
      expect(combo?.note).toMatch(/can submit the form/);
      // And it says what to do, rather than only that something went wrong.
      expect(combo?.note).toMatch(/yourself/i);

      expect(result.results.find((r) => r.field.semantic === 'full_name')?.status).toBe('ok');
      expect(
        await page.evaluate(() => (window as unknown as { __submitted: boolean }).__submitted),
      ).toBe(false);
    } finally {
      await page.close();
    }
  }, 90_000);

  it('leaves an ordinary shadow-DOM combobox alone', async () => {
    // The over-refusal direction, which matters as much: a real web component that wraps its
    // own listbox must still be filled, or this guard costs coverage on exactly the forms it
    // was built for.
    //
    // This used to assert that `page.locator(FILLABLE_CONTROLS).nth(0)` resolved to a DIV —
    // a fact about the fixture and the selector constant, true whether or not the guard
    // over-refuses. It drives the real path now.
    const page = await session.context.newPage();
    try {
      await page.setContent(`<form>
          <x-ok id="ok" aria-label="Country" aria-controls="lb"></x-ok>
          <div id="lb" role="listbox">
            <div role="option">US</div>
            <div role="option">Canada</div>
          </div>
        </form>
        <script>
          customElements.define('x-ok', class extends HTMLElement {
            connectedCallback() {
              this.attachShadow({ mode: 'open' }).innerHTML =
                '<div role="combobox" aria-label="Country" tabindex="0" ' +
                'style="width:200px;height:28px;border:1px solid">Pick one</div>';
            }
          });
        </script>`);
      await page.waitForTimeout(200);

      const map = await buildFormMap(page);
      const combo = map.fields.find((f) => f.control === 'combobox');
      expect(combo, 'the fixture must map a combobox').toBeDefined();

      const result = await executePlan(
        page,
        buildFillPlan({ fields: map.fields, profile: PROFILE, answers: [] }),
      );
      const picked = result.results.find((r) => r.field.control === 'combobox');

      // Whatever else happens to it, the guard must not be what stopped it.
      expect(picked?.note ?? '').not.toMatch(/can submit the form/);
      expect(picked?.note ?? '').not.toMatch(/more of the page than a form field/);
    } finally {
      await page.close();
    }
  }, 90_000);
});

/**
 * The SECOND click in a combobox — the one that picks an option.
 *
 * `SAFE_OPTION` has exactly the blind spot `FILLABLE_CONTROLS` did: a custom element whose
 * shadow root is `<div role="option"><slot></slot></div>`, given `<x-opt>US<input
 * type="submit"></x-opt>`, renders the submit control inside an element that matches
 * `[role=option]` while containing only a `<slot>` in the DOM. Measured on such a page:
 * `document.querySelectorAll(SAFE_OPTION)` sees one option and Playwright — which pierces
 * shadow roots — sees two, so the trap is what the option locator resolves.
 *
 * `refuseIfItCanSend` was added to that click in the same commit as the first one, and nothing
 * tested it: deleting the call left all 70 cases in this file green.
 */
describe('an option that renders a submit control it does not contain', () => {
  const SLOTTED_OPTION = `<form id="f" action="/submitted" method="POST">
      <div id="combo" role="combobox" aria-label="Country" aria-controls="lb" tabindex="0">Pick one</div>
      <div id="lb" role="listbox">
        <x-opt><input type="submit" value="go" style="width:60px;height:20px"></x-opt>
        <div role="option">Canada</div>
      </div>
    </form>
    <script>
      window.__submitted = false;
      document.getElementById('f').addEventListener('submit', function (e) {
        e.preventDefault();
        window.__submitted = true;
      });
      customElements.define('x-opt', class extends HTMLElement {
        connectedCallback() {
          // The label lives in the SHADOW root and the submit control is slotted in beside
          // it, which is what makes this reachable: the option matches by its text while the
          // thing rendering inside it is not a DOM descendant, so no :has() clause sees it.
          this.attachShadow({ mode: 'open' }).innerHTML =
            '<div role="option">US<slot></slot></div>';
        }
      });
    </script>`;

  it('is refused before it is clicked', async () => {
    const page = await session.context.newPage();
    try {
      await page.setContent(SLOTTED_OPTION);
      await page.waitForTimeout(200);

      const map = await buildFormMap(page);
      const combo = map.fields.find((f) => f.control === 'combobox');
      expect(combo?.semantic).toBe('country');

      const result = await executePlan(
        page,
        buildFillPlan({ fields: map.fields, profile: PROFILE, answers: [] }),
      );

      // The note is what discriminates: with the guard removed the option IS clicked and the
      // failure becomes an ordinary read-back mismatch instead. The submitted check below is a
      // belt rather than the point — this particular click does not reach the slotted control,
      // and a test that leaned on it would be pinning the fixture's geometry, not the guard.
      const picked = result.results.find((r) => r.field.control === 'combobox');
      expect(picked?.status).not.toBe('ok');
      expect(picked?.note).toMatch(/can submit the form/);
      expect(
        await page.evaluate(() => (window as unknown as { __submitted: boolean }).__submitted),
      ).toBe(false);
    } finally {
      await page.close();
    }
  }, 90_000);
});

/**
 * Reading back a combobox that is an `<input>`.
 *
 * `controlOf` calls anything carrying `role="combobox"` a combobox before it looks at the tag,
 * which is right: that is the shape ARIA 1.2 prescribes and the one every major component
 * library ships. But an input has no text content — its value lives in `.value` — so reading
 * back with `innerText()` returned the empty string and every one of them was reported as a
 * MISMATCH, a correctly filled field flagged for the student to go and check, on the commonest
 * dropdown shape on the web.
 *
 * The `inputValue()` step that fixed it had no test: removing it left all 1,936 server tests
 * green.
 */
describe('a combobox that is an input rather than a div', () => {
  const INPUT_COMBO = `<form id="f">
      <input id="combo" role="combobox" aria-label="Country" aria-controls="lb" readonly>
      <div id="lb" role="listbox">
        <div role="option">US</div>
        <div role="option">Canada</div>
      </div>
    </form>
    <script>
      // What a real widget does when an option is chosen: it writes the value into the input.
      document.getElementById('lb').addEventListener('click', function (e) {
        var t = e.target;
        if (t && t.getAttribute('role') === 'option') {
          document.getElementById('combo').value = t.textContent.trim();
        }
      });
    </script>`;

  it('reads the value out of the input, rather than reporting a mismatch', async () => {
    const page = await session.context.newPage();
    try {
      await page.setContent(INPUT_COMBO);

      const map = await buildFormMap(page);
      const combo = map.fields.find((f) => f.control === 'combobox');
      expect(combo?.semantic).toBe('country');

      const result = await executePlan(
        page,
        buildFillPlan({ fields: map.fields, profile: PROFILE, answers: [] }),
      );

      const picked = result.results.find((r) => r.field.control === 'combobox');
      expect(picked?.status, picked?.note).toBe('ok');
      // And the page really did keep it, so this is not a read that agreed with itself.
      expect(await page.locator('#combo').inputValue()).toBe('US');
    } finally {
      await page.close();
    }
  }, 90_000);
});
