import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Who is allowed to touch the browser, and when.
 *
 * Three defects, one root: the run registry had no mutual exclusion around its ASYNC setup.
 * Every check it did make was correct about the moment it ran and wrong about the seconds
 * either side of it.
 *
 *   1. `continueRun` guarded on `run.state === 'filling'`, but a continue spends its first
 *      several seconds in `detectIntervention` and `buildFormMap` with the state still
 *      reading `reading`. Two continues inside that window both reached `executePlan`,
 *      against one page and one keyboard — and `insertText` types into whatever has focus,
 *      so one run's approved essay lands in the box the other just clicked into, on a real
 *      employer's form, in the user's name.
 *   2. `startRun` registered its run and THEN awaited `openSession`. A second start found
 *      `session` still undefined, so the discard closed nothing, deleted the entry, and
 *      registered its own — leaving the first launch's BrowserContext attached to an object
 *      no longer in `runs`, unreachable by discard, by shutdown, and by the close delete-all
 *      does before removing the profile directory it is still holding a lock on.
 *   3. Every run launches against one shared Chromium profile directory, so two applications
 *      cannot be filled at once — but nothing said so, and the second failed on the profile
 *      lock as a 502 carrying a raw Playwright message about a directory.
 *
 * The browser is mocked because none of this is about a browser. It is about what happens in
 * the gaps between awaits, and a real Chromium makes those gaps untestable.
 */

const h = vi.hoisted(() => ({
  opened: 0,
  closed: 0,
  /**
   * Where the stubbed page reports itself to be after a navigation.
   *
   * A real browser follows redirects itself, so the run re-checks the LANDED url against the
   * sourcing policy — an employer 'Apply' link that bounces to a board would otherwise put the
   * signed-in profile on it. Default is an ordinary employer page; a test that wants the
   * refusal sets this.
   */
  landsOn: 'https://careers.acme.com/apply',
  /** Held by `openSession` while set, so a launch can be caught mid-flight. */
  openGate: null as Promise<void> | null,
  /**
   * The address the stubbed browser turns out to have dialled, when a test wants a private one.
   *
   * browser.ts judges the address behind each document response because the guard before the
   * request only ever saw a NAME, and the browser resolves that name again for itself. Null is
   * every ordinary page.
   */
  dialsPrivatelyTo: null as string | null,
  /** Held by `detectIntervention` while set, which is the window defect 1 lived in. */
  readGate: null as Promise<void> | null,
  /** How many `executePlan` calls were in the page at the same moment. */
  executing: 0,
  peakExecuting: 0,
  executed: 0,
}));

vi.mock('../src/core/filling/browser', () => ({
  openSession: vi.fn(async () => {
    if (h.openGate) await h.openGate;
    h.opened += 1;
    // `closedByUser` is how a test spells "the person clicked the X on the Chromium
    // window", which is the ordinary end of this flow and which nothing in the server
    // listens for.
    const session = {
      context: {},
      page: {
        goto: async () => undefined,
        isClosed: () => session.closedByUser,
        // A real Playwright Page has this, and the run reads it to check where a navigation
        // actually LANDED — a browser follows redirects on its own, so the URL it was sent to
        // is not necessarily the host that ends up with the session. A stub without it is a
        // model of a Page that cannot exist.
        url: () => h.landsOn,
      },
      closedByUser: false,
      /**
       * What browser.ts records when the address Chromium actually dialled turns out to be one
       * this tool refuses, and the barrier the run has to await before reading it.
       *
       * The real verdict costs a lookup and lands after `goto` has already returned, so the
       * stub publishes it only when `dialsJudged` is awaited. That is deliberate: a run that
       * reads `privateDial` without the barrier passes this stub's check for the wrong reason,
       * which is the same wrong reason it would pass against a real browser.
       */
      privateDial: null as { host: string; address: string } | null,
      dialsJudged: async () => {
        session.privateDial = h.dialsPrivatelyTo
          ? { host: 'careers.acme.com', address: h.dialsPrivatelyTo }
          : null;
      },
      close: async () => {
        h.closed += 1;
        session.closedByUser = true;
      },
    };
    return session;
  }),
  detectIntervention: vi.fn(async () => {
    if (h.readGate) await h.readGate;
    return null;
  }),
}));

vi.mock('../src/core/filling/formMap', () => ({
  buildFormMap: vi.fn(async () => ({ url: 'http://form.test/1', fields: [{ label: 'Name' }] })),
  summarizeMap: vi.fn(() => 'one field'),
}));

vi.mock('../src/core/filling/plan', () => ({
  buildFillPlan: vi.fn(() => ({ actions: [{ label: 'Name' }], skips: [] })),
  // The run's pre-fill message reports the PLAN as well as the map — what will be typed, not
  // just what was found — so this mock has to carry the whole module surface the run imports.
  summarizePlan: vi.fn(() => '1 field to fill, 0 left for you, 0 with nothing to put in them.'),
}));

vi.mock('../src/core/filling/fill', () => ({
  executePlan: vi.fn(async () => {
    h.executing += 1;
    h.peakExecuting = Math.max(h.peakExecuting, h.executing);
    await new Promise((r) => setTimeout(r, 5));
    h.executing -= 1;
    h.executed += 1;
    return { results: [], filled: 1, mismatched: 0, failed: 0 };
  }),
  describeFill: vi.fn(() => 'filled 1'),
  sameDocument: vi.fn(() => true),
}));

const { closeAllRuns, continueRun, discardRun, getRun, SourceRefusedError, startRun } =
  await import('../src/core/filling/run');

function gate(): { open: () => void; promise: Promise<void> } {
  let open!: () => void;
  const promise = new Promise<void>((r) => {
    open = r;
  });
  return { open, promise };
}

function input(applicationId: string) {
  return {
    applicationId,
    applyUrl: 'http://form.test/1',
    profile: {} as never,
    answers: [],
    headless: true,
  };
}

beforeEach(() => {
  h.opened = 0;
  h.closed = 0;
  h.openGate = null;
  h.readGate = null;
  h.executing = 0;
  h.peakExecuting = 0;
  h.executed = 0;
  h.landsOn = 'https://careers.acme.com/apply';
  h.dialsPrivatelyTo = null;
});

afterEach(async () => {
  await closeAllRuns();
});

describe('two callers driving one page', () => {
  it('lets only one continue into executePlan, however slow the read is', async () => {
    // The defect exactly: both calls are inside `detectIntervention` when the second one
    // arrives, so `state` says `reading` for both and the old guard saw nothing to refuse.
    await startRun(input('app-1'));
    const read = gate();
    h.readGate = read.promise;

    const first = continueRun(input('app-1'));
    const second = continueRun(input('app-1')).then(
      () => 'resolved',
      (e: Error) => e.message,
    );

    read.open();
    await first;
    expect(await second).toMatch(/already being filled/i);
    expect(h.executed).toBe(1);
    // The assertion that names the harm: never two keyboards in one page.
    expect(h.peakExecuting).toBe(1);
  });

  it('lets a second continue through once the first has finished', async () => {
    // The refusal has to be a moment, not a latch — the ordinary flow continues twice, once
    // after signing in and once for the next wizard step.
    await startRun(input('app-1'));
    await continueRun(input('app-1'));
    await continueRun(input('app-1'));
    expect(h.executed).toBe(2);
  });

  it('releases the browser even when the fill throws', async () => {
    const { executePlan } = await import('../src/core/filling/fill');
    vi.mocked(executePlan).mockRejectedValueOnce(new Error('the page went away'));
    await startRun(input('app-1'));
    await expect(continueRun(input('app-1'))).rejects.toThrow(/page went away/);
    // A claim leaked here would wedge the application for the life of the process, and the
    // only symptom would be "already being filled" about a run that ended minutes ago.
    await expect(continueRun(input('app-1'))).resolves.toBeDefined();
  });
});

describe('two starts racing to open one browser', () => {
  it('opens one session and orphans none', async () => {
    const open = gate();
    h.openGate = open.promise;

    const first = startRun(input('app-1'));
    const second = startRun(input('app-1')).then(
      () => 'resolved',
      (e: Error) => e.message,
    );

    open.open();
    await first;
    expect(await second).toMatch(/already being filled/i);

    // One launch, and it is the one the registry holds. The orphan was a second launch whose
    // context nothing could ever reach: not discard, not shutdown, not the close delete-all
    // does before removing the profile directory.
    expect(h.opened).toBe(1);
    expect(getRun('app-1')?.session).toBeDefined();

    await discardRun('app-1');
    expect(h.closed).toBe(1);
  });

  it('closes a session whose run was discarded while the browser was opening', async () => {
    // Discard does not wait for the claim — shutdown and delete-all have to be able to close
    // a browser whatever else is happening — so this window stays open and has to be handled
    // where the launch lands.
    const open = gate();
    h.openGate = open.promise;

    const starting = startRun(input('app-1')).then(
      (r) => r.state,
      (e: Error) => e.message,
    );
    // Let the start get as far as registering its run and awaiting the launch. Discarding
    // before that point is a different case entirely — there is nothing registered to
    // discard — and it is the window AFTER registration that leaks a browser.
    await new Promise((r) => setTimeout(r, 0));
    expect(getRun('app-1')).toBeDefined();

    await discardRun('app-1');
    open.open();

    expect(await starting).toMatch(/discarded while the browser was opening/i);
    expect(h.opened).toBe(1);
    expect(h.closed).toBe(1);
    expect(getRun('app-1')).toBeUndefined();
  });
});

describe('two applications, one profile directory', () => {
  it('refuses the second and says what to do about it', async () => {
    // Chromium locks the shared profile directory, so this always failed — as a 502 whose
    // message was a raw Playwright complaint about a path. The ordinary way to reach it is
    // to park run A on a login wall and go and start application B.
    await startRun(input('app-1'));
    const second = await startRun(input('app-2')).then(
      () => 'resolved',
      (e: Error) => e.message,
    );

    expect(second).toMatch(/another application has the browser open/i);
    expect(second).toMatch(/one application can be filled at a time/i);
    expect(h.opened).toBe(1);
    expect(getRun('app-2')).toBeUndefined();
  });

  it('lets the second application through once the first is discarded', async () => {
    await startRun(input('app-1'));
    await discardRun('app-1');
    await expect(startRun(input('app-2'))).resolves.toMatchObject({ state: 'reading' });
    expect(h.opened).toBe(2);
  });

  it('does not count a run that failed to open as holding the browser', async () => {
    const { openSession } = await import('../src/core/filling/browser');
    vi.mocked(openSession).mockRejectedValueOnce(new Error('chromium would not start'));
    const failed = await startRun(input('app-1'));
    expect(failed.state).toBe('failed');

    // A run with no session holds no window, and treating it as if it did would lock the
    // user out of every other application until they found the discard button.
    await expect(startRun(input('app-2'))).resolves.toMatchObject({ state: 'reading' });
  });
});

describe('a browser window the user closed themselves', () => {
  it('does not go on holding the profile against every other application', async () => {
    // The ordinary end of the designed flow: fill, review, submit on the real page, close
    // the Chromium window with the X. Nothing in the server listens for that, so the
    // finished run sat in the registry holding a dead session and `browserHeldBy` refused
    // every OTHER application — "another application has the browser open", about a browser
    // that was not open. Before the mutual exclusion existed, starting the next one worked.
    await startRun(input('app-1'));
    const run = getRun('app-1')!;
    await run.session!.close();

    await expect(startRun(input('app-2'))).resolves.toMatchObject({ state: 'reading' });
    expect(getRun('app-1')).toBeUndefined();
  });

  it('still refuses while the window is genuinely open', async () => {
    // The guard has to keep doing its job, or two applications race the profile lock again.
    await startRun(input('app-1'));
    const refused = await startRun(input('app-2')).then(
      () => 'resolved',
      (e: Error) => e.message,
    );
    expect(refused).toMatch(/another application has the browser open/i);
    // And it names which one, which the shared error code promises and the message did not.
    expect(refused).toMatch(/form\.test/);
  });

  /**
   * Continuing into a window that has gone.
   *
   * Nothing refused it, and the whole call went through: `detectIntervention` reads every frame
   * of a dead page, each read throws, and a frame that cannot be read is treated as proving
   * nothing, so it answers null; `buildFormMap` scans the same frames and `scanFrame` matches
   * Playwright's "target closed" against FRAME_GONE, so it returns no fields rather than
   * raising. The empty plan then landed on the branch that describes an empty PAGE — "Check the
   * page in the browser window — the form may not have loaded yet." — about a browser window
   * the user had closed. The one move that sentence asks for is the one that cannot help.
   *
   * The stubbed page reports itself closed the same way a real one does, so this test is about
   * the check rather than about Playwright.
   */
  it('says the window is gone rather than blaming the page for loading slowly', async () => {
    await startRun(input('app-1'));
    await getRun('app-1')!.session!.close(); // the X on the Chromium window

    const message = await continueRun(input('app-1')).then(
      () => 'resolved',
      (e: Error) => e.message,
    );

    expect(message).toMatch(/browser window was closed/i);
    expect(message).not.toMatch(/may not have loaded/i);
    // The prefix routes/filling.ts matches to answer 409 NO_RUN. A 502 here would say the
    // employer's site broke, and invite a retry of a call that cannot ever work again.
    expect(message).toMatch(/^No open fill run for this application/);
    // And nothing was typed at a page that is not there.
    expect(h.executed).toBe(0);
    // Forgotten, so the panel offers the card that opens a fresh browser rather than a Fill
    // button whose only outcome is this message a second time.
    expect(getRun('app-1')).toBeUndefined();
  });
});

describe('a fill the user stops while it is typing', () => {
  it('is not recorded as a fill that finished', async () => {
    // Discard is offered mid-fill on purpose. It closes the context under `executePlan`,
    // every per-field error is caught and becomes `status: failed`, so the fill returned
    // NORMALLY with a pile of failures and the run was marked `done` — which walked the
    // application through `filled` to `awaiting_submit` and wrote a `filled` event. The user
    // pressed stop; the tracker said the form was filled and ready to submit.
    await startRun(input('app-1'));

    const { executePlan } = await import('../src/core/filling/fill');
    vi.mocked(executePlan).mockImplementationOnce(async () => {
      await discardRun('app-1');
      return { results: [], filled: 0, mismatched: 0, failed: 18 } as never;
    });

    await expect(continueRun(input('app-1'))).rejects.toThrow(/stopped while it was filling/i);
    expect(getRun('app-1')).toBeUndefined();
  });
});

/**
 * Where the navigation LANDED, which a browser decides for itself.
 *
 * `startRun` checks the string it is about to open, and then Playwright takes over — and a
 * real browser follows 3xx, meta-refresh and `location =` on its own. So an employer "Apply"
 * link that bounces to LinkedIn, Indeed, Handshake or Glassdoor put the PERSISTENT, SIGNED-IN
 * profile on that host, the form mapper read it, and a continue would have typed the
 * student's name, email and approved answers into it. `politeFetch` closed the identical hole
 * for plain fetches by re-checking every hop; this is the browser's half of that.
 */
describe('a page that redirects somewhere this tool will not go', () => {
  it('refuses after the navigation, before anything reads the page', async () => {
    h.landsOn = 'https://www.linkedin.com/jobs/view/9';
    await expect(startRun(input('app-1'))).rejects.toThrow(/does not open/i);
  });

  it('names the host it actually landed on, not the one it was given', async () => {
    // The student pasted an employer URL and got a refusal; without the host they would have
    // no way to tell that the redirect, rather than their link, is what stopped it.
    h.landsOn = 'https://app.joinhandshake.com/jobs/5';
    await expect(startRun(input('app-1'))).rejects.toThrow(/app\.joinhandshake\.com/);
  });

  it('closes the browser rather than leaving it parked on that host', async () => {
    // A refusal that left the session open would leave the signed-in profile sitting on the
    // page, holding the profile-directory lock every later run needs.
    h.landsOn = 'https://www.indeed.com/viewjob?jk=1';
    await startRun(input('app-1')).catch(() => undefined);
    expect(h.closed).toBeGreaterThan(0);
    expect(getRun('app-1')).toBeUndefined();
  });

  it('lets an ordinary employer page through', async () => {
    // The other direction, which matters just as much: a refusal that fired on a normal
    // careers page would break the feature entirely.
    h.landsOn = 'https://careers.acme.com/apply?step=2';
    await expect(startRun(input('app-1'))).resolves.toMatchObject({ applicationId: 'app-1' });
  });
});

/**
 * A page served from an address the browser picked after the guard had approved the name.
 *
 * The address check in front of a navigation resolves the NAME in this process, and then
 * Chromium resolves the same name AGAIN for itself. Nothing pins the answer between the two, so
 * a host whose DNS the attacker controls answers a public address to the guard and 127.0.0.1 to
 * the browser a moment later — and the browser doing the dialling is the persistent profile
 * carrying the student's real logins and LAN cookies. infra/http/publicHost.ts names that gap in
 * its own header and closes it for fetches with `guardedLookup`; the browser takes no lookup
 * hook, so browser.ts judges the address behind each document response instead and this is where
 * the run acts on the verdict.
 *
 * The request has already gone out by then and nothing here can call it back. What these pin is
 * everything after it: the page is not read, no key is pressed, and the window does not stay
 * parked on that host.
 */
describe('a page served from an address the browser resolved for itself', () => {
  it('refuses the run rather than reading the page', async () => {
    h.dialsPrivatelyTo = '192.168.1.1';
    const err = await startRun(input('app-1')).catch((e: unknown) => e);

    // Ours, not the site's: routes/filling.ts turns this into a 400 that names the refusal,
    // where a 502 would blame the employer and invite a retry.
    expect(err).toBeInstanceOf(SourceRefusedError);
    expect((err as Error).message).toMatch(/192\.168\.1\.1/);
    // The name is worth saying too, because the student's link is not what was wrong with it.
    expect((err as Error).message).toMatch(/careers\.acme\.com/);
  });

  it('closes the browser rather than leaving it parked on that address', async () => {
    h.dialsPrivatelyTo = '127.0.0.1';
    await startRun(input('app-1')).catch(() => undefined);
    expect(h.closed).toBe(1);
    expect(getRun('app-1')).toBeUndefined();
  });

  it('refuses a continue too, and types nothing', async () => {
    // The start was clean; the rebinding happens on the wizard step the user clicked through
    // while the run was parked. This is the check that stands between it and the keyboard.
    await startRun(input('app-1'));
    h.dialsPrivatelyTo = '169.254.169.254';

    await expect(continueRun(input('app-1'))).rejects.toThrow(/169\.254\.169\.254/);
    expect(h.executed).toBe(0);

    /**
     * AND THE WINDOW GOES WITH THE REFUSAL.
     *
     * This describe's own header says the browser "does not stay parked on that host", and
     * only the START test pinned it — the continue refusal threw from outside `drive()`'s try,
     * so the run stayed registered with its page open on the host that had just rebound. That
     * page is the persistent profile carrying the student's real logins, and `context.route`
     * judges DOCUMENTS only, so the attacker page's own XHR back to the now-private name is
     * never seen by the address guard at all. Leaving the tab open is what lets the read the
     * whole rule exists to prevent go on happening.
     */
    expect(h.closed).toBeGreaterThan(0);
    expect(getRun('app-1')).toBeUndefined();
  });

  it('lets an ordinary public address through', async () => {
    // The direction that costs a student a job if it goes wrong: an employer whose careers
    // page is served from an ordinary address must fill exactly as before.
    h.dialsPrivatelyTo = null;
    await expect(startRun(input('app-1'))).resolves.toMatchObject({ state: 'reading' });
    await expect(continueRun(input('app-1'))).resolves.toMatchObject({ state: 'done' });
    expect(h.executed).toBe(1);
  });
});

/**
 * What the run says it is about to do, before anybody presses continue.
 *
 * The message is two lines because they answer different questions: the MAP line says what the
 * page turned out to contain, which is how someone tells a form that failed to render from one
 * that rendered and had little on it, and the PLAN line says what this run will actually type.
 *
 * The plan half was added to `run.message` and nothing asserted it. `summarizePlan` was added
 * to the mock above at the same time, purely so the module surface matched and the run stopped
 * throwing — so dropping the plan half from run.ts again left every case in this file green.
 * A stub added to silence a failure is not coverage of the thing that failed.
 */
describe('the message a run carries before it fills anything', () => {
  it('reports the plan as well as the map', async () => {
    await startRun(input('app-msg'));
    const run = getRun('app-msg');

    expect(run?.message).toContain('one field'); // the map half
    expect(run?.message).toContain('1 field to fill'); // the plan half
    expect(run?.message).toMatch(/left for you/);
  });
});
