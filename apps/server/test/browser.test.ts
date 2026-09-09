/**
 * Proves the browser toolchain actually works on this machine, against the fixture site
 * and never against a real employer's form.
 *
 * These are slow by the standards of the rest of the suite (a real Chromium launches), so
 * they are deliberately few: enough to know Playwright, the persistent context, the
 * fixture, and the intervention detector are all wired correctly. The behavioural fill
 * tests build on this.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureServer, submissions, type FixtureServer } from '@ia/fixtures';
import {
  blocksNavigation,
  detectIntervention,
  dialledPrivately,
  openSession,
  type BrowserSession,
} from '../src/core/filling/browser';
import { removeTempDir } from './support/tempDir';

let fixture: FixtureServer;
let session: BrowserSession;
let profileDir: string;

beforeAll(async () => {
  fixture = await startFixtureServer(0);
  profileDir = mkdtempSync(path.join(tmpdir(), 'ia-browser-'));
  session = await openSession({ headless: true, profileDir });
}, 120_000);

afterAll(async () => {
  // Closing Chromium is not reliably quick on a loaded machine, and the default hook
  // timeout is 10s — this teardown timed out in a full-suite run where every test in
  // the file had passed. Launching it already carries an explicit budget; so does this.
  await session?.close();
  await fixture?.close();
  removeTempDir(profileDir);
}, 60_000);

describe('browser session', () => {
  it('opens the fixture and reads its fields', async () => {
    await session.page.goto(`${fixture.url}/simple`);
    expect(await session.page.locator('#first').count()).toBe(1);
    expect(await session.page.locator('#apply input, #apply textarea').count()).toBe(5);
  }, 60_000);

  it('reaches fields inside an iframe', async () => {
    await session.page.goto(`${fixture.url}/nasty`);
    const frame = session.page.frameLocator('#extra');
    expect(await frame.locator('#f-start').count()).toBe(1);
  }, 60_000);

  it('reaches a field inside shadow DOM', async () => {
    await session.page.goto(`${fixture.url}/nasty`);
    // Playwright pierces open shadow roots, which is why the fixture uses mode: 'open'.
    expect(await session.page.locator('#shadow-portfolio').count()).toBe(1);
  }, 60_000);
});

describe('typing widgets that ignore programmatic values', () => {
  it('shows why fill() is not enough', async () => {
    await session.page.goto(`${fixture.url}/nasty`);
    const school = session.page.locator('#f-school');

    // fill() sets the value in one shot. The widget commits only on a key event, so its
    // model stays empty — the exact failure real autocomplete and rich-text fields show.
    await school.fill('Rutgers University');
    expect(await school.inputValue()).toBe('Rutgers University');
    expect(await school.getAttribute('data-committed')).toBe('');

    // Real keystrokes commit it.
    await school.fill('');
    await school.pressSequentially('Rutgers University', { delay: 5 });
    expect(await school.getAttribute('data-committed')).toBe('Rutgers University');
  }, 60_000);
});

describe('stopping instead of working around', () => {
  it('recognises a login wall', async () => {
    await session.page.goto(`${fixture.url}/login`);
    const found = await detectIntervention(session.page);
    expect(found?.reason).toBe('login');
    expect(found?.detail).toContain('never types into a password field');
  }, 60_000);

  it('does not cry login on an ordinary application page', async () => {
    await session.page.goto(`${fixture.url}/simple`);
    expect(await detectIntervention(session.page)).toBeNull();
  }, 60_000);

  /**
   * A "Sign in" button in the global header is on practically every career site, and it
   * used to be sufficient on its own — Playwright's has-text is a case-insensitive
   * substring match. Worse, the same detector runs again on continue, so the run sat in
   * awaiting_user forever on a page with no login wall at all. A password field is now
   * required, and button text is not evidence of anything.
   */
  it('is not fooled by a sign-in button in the page header', async () => {
    await session.page.goto(`${fixture.url}/wizard`);
    expect(await session.page.locator('#hdr-signin').count()).toBe(1);
    expect(await detectIntervention(session.page)).toBeNull();
  }, 60_000);

  /**
   * The detector has to look where the scanner looks.
   *
   * `page.locator()` is `page.mainFrame().locator()` and does not enter iframes, while
   * `buildFormMap` iterates `page.frames()` and scans all of them. So the two saw different
   * document sets, and everything in the gap was filled without ever being checked — which is
   * most embedded ATS flows, and one line of markup for a hostile page. Verified before the
   * fix: the detector answered null on a page whose only content was an iframe holding a
   * sign-in form, and the scanner mapped that form's email box as `semantic: 'email'`. The run
   * did not stop; it typed the student's address into a sign-in box.
   */
  const inFrame = async (inner: string): Promise<void> => {
    const page = session.page;
    await page.setContent(
      `<h1>Careers</h1><iframe srcdoc='${inner}' width="600" height="300"></iframe>`,
    );
    await page.waitForTimeout(200);
  };

  it('sees a login wall one iframe deep', async () => {
    await inFrame(
      '<form><input id="e" type="email"><input id="p" type="password"><button>Sign in</button></form>',
    );
    expect((await detectIntervention(session.page))?.reason).toBe('login');
  }, 60_000);

  it('sees a bot check one iframe deep', async () => {
    await inFrame('<iframe src="https://challenges.cloudflare.com/turnstile"></iframe>');
    expect((await detectIntervention(session.page))?.reason).toBe('captcha');
  }, 60_000);

  it('is not talked out of a sign-in frame by a real form beside it', async () => {
    // The `applicationish` rescue is scoped to the frame the password field is in, so the
    // application form in the outer document cannot excuse the sign-in box in the inner one.
    await session.page.setContent(
      `<form><input name="first"><input name="last"><input name="email" type="email">
         <textarea name="why"></textarea><input type="file" name="resume"></form>
       <iframe srcdoc='<form><input type="email"><input type="password"><button>Sign in</button></form>'></iframe>`,
    );
    await session.page.waitForTimeout(200);
    expect((await detectIntervention(session.page))?.reason).toBe('login');
  }, 60_000);

  it('still says nothing about an ordinary application in a frameless page', async () => {
    // The direction that matters if this is written too widely: stopping a run that had no
    // reason to stop puts the browser back in the user's hands for nothing.
    await session.page.setContent(
      `<form><input name="first"><input name="last"><input name="email" type="email">
         <textarea name="why"></textarea></form>`,
    );
    expect(await detectIntervention(session.page)).toBeNull();
  }, 60_000);
});

describe('gate G4', () => {
  it('nothing in this suite has submitted a form', () => {
    // The fixture records every POST it receives. This is a stronger check than grepping
    // for .click(): it asserts no form was actually submitted, however it happened.
    expect(submissions).toEqual([]);
  });
});

/**
 * Whether the signed-in browser may navigate somewhere.
 *
 * `startRun` checks the address it is ABOUT to open, and then Chromium takes over and follows
 * 3xx, meta-refresh and `location =` by itself — so a careers host answering
 * `302 Location: http://192.168.1.1/setup.cgi` would otherwise have the PERSISTENT profile,
 * the one holding the student's real logins and LAN cookies, issue that request.
 *
 * The decision is a separate function from the route handler precisely so it can be tested:
 * the handler is gated on `config.isTest`, because this suite drives the fixture site on
 * 127.0.0.1, and a guard whose only code path is switched off under test is one nothing holds.
 */
describe('which addresses the signed-in browser may be navigated to', () => {
  it('refuses this machine and its network', async () => {
    for (const url of [
      'http://127.0.0.1:8787/api/profile',
      'http://localhost:5173/',
      'http://192.168.1.1/setup.cgi',
      'http://169.254.169.254/latest/meta-data/',
      'http://[::1]:8787/',
    ]) {
      expect(await blocksNavigation(url), url).toBe(true);
    }
  }, 30_000);

  it('allows an ordinary employer, or the fill path would stop working', async () => {
    expect(await blocksNavigation('https://example.com/careers/1')).toBe(false);
  }, 30_000);

  it('lets Chromium fail in its own words when the address is not an address', async () => {
    // A malformed URL or a resolver that threw is not a verdict ABOUT the address. Blocking on
    // those would turn a DNS outage into "this is on your private network", which is a false
    // statement, and would hide the real reason the page did not load.
    for (const url of ['not a url at all', 'http://this-name-does-not-resolve.invalid/']) {
      expect(await blocksNavigation(url), url).toBe(false);
    }
  }, 30_000);
});

/**
 * The other half of that guard: the address Chromium ACTUALLY dialled.
 *
 * `blocksNavigation` resolves the NAME in this process and then hands the name to Chromium,
 * which resolves it AGAIN with its own resolver a moment later. Nothing pins the answer between
 * the two, so a host whose DNS the attacker controls answers a public address to the guard and
 * 127.0.0.1 to the browser — classic rebinding, and the guard will have approved an address that
 * was never used. infra/http/publicHost.ts names that gap in its own header and closes it for
 * fetches with `guardedLookup`, which judges the address the connector dials; a browser takes no
 * lookup hook, so this is the browser's half of that pair.
 *
 * Tested as a function for the same reason `blocksNavigation` is: the listener that feeds it is
 * gated on `config.isTest`, because this suite is served from 127.0.0.1 and every response in it
 * would otherwise be a verdict. run.ts's half — refusing the run on the verdict, before the page
 * is read and before a key is pressed — is pinned against a stubbed session in fillRun.test.ts.
 */
describe('the address the browser turned out to dial', () => {
  it('refuses this machine and its network, in every notation one arrives in', async () => {
    for (const address of [
      '127.0.0.1',
      '10.0.0.5',
      '192.168.1.1',
      '169.254.169.254', // the cloud metadata address
      '::1',
      // The v4 address inside a v6 one. Chromium reports a socket to 127.0.0.1 over a v6
      // stack like this, and it delivers packets to 127.0.0.1 whatever it is spelled like.
      '::ffff:127.0.0.1',
      // A link-local address arrives carrying the interface it is scoped to, which is not
      // part of the address and which no URL parser will take.
      'fe80::1%eth0',
      /**
       * THE SPELLING CHROMIUM ACTUALLY SENDS. Measured against this repo's own Playwright:
       * `response.serverAddr()` reports v4 bare — `{"ipAddress":"127.0.0.1"}` — and v6
       * BRACKETED, `{"ipAddress":"[::1]"}`. Every case above this one is a spelling the
       * browser never produces for v6, so the guard was tested entirely on inputs it does not
       * receive. Brackets are stripped before the zone id, or a bracketed zoned address is
       * left with an unclosed bracket and lands in the fail-closed branch again.
       */
      '[::1]',
      '[::ffff:127.0.0.1]',
      '[fe80::1%eth0]',
    ]) {
      expect(await dialledPrivately(address), address).toBe(true);
    }
  }, 30_000);

  it('allows an ordinary employer, or every fill would stop on its first page', async () => {
    for (const address of [
      '93.184.216.34',
      '2606:2800:220:1:248:1893:25c8:1946',
      /**
       * And the same address as the browser sends it. Without the bracket strip this built
       * `http://[[2606:…]]/`, `new URL` threw, and the fail-closed branch called a public
       * employer's page private — so the run was refused with a 400 saying the careers page
       * was "an address on this machine or its own network", and there is no override. Chromium
       * prefers IPv6 wherever a AAAA record exists, so on a dual-stack connection that is not
       * an edge case; it is most fills.
       */
      '[2606:2800:220:1:248:1893:25c8:1946]',
      '[2a00:1450:4001:80b::200e]',
    ]) {
      expect(await dialledPrivately(address), address).toBe(false);
    }
  }, 30_000);

  it('refuses an address it cannot read at all', async () => {
    // Unreadable means refused, the same way publicHost.ts treats bytes it cannot parse: this
    // is a verdict on something already served to the signed-in profile, and the safe direction
    // is to stop the run rather than to vouch for an address nothing here understands.
    expect(await dialledPrivately('not an address')).toBe(true);
  }, 30_000);
});
