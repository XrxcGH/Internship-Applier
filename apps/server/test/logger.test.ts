import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import { buildLogger } from '../src/infra/logger';
import { HttpError, scrubUrl } from '../src/infra/http/fetcher';

/**
 * What a log line is allowed to say, and what it must not stop saying.
 *
 * The redaction list is applied at the logger rather than at call sites, so that a new log
 * line is safe by default. It held `'*.url'` and `'err.url'` — beside a comment explaining
 * why neither was necessary, since credential-bearing URLs are scrubbed at the call site and
 * `HttpError` scrubs in its constructor. The censor won anyway, so every fetch failure in the
 * app logged `url: "[redacted]"` and no line ever named the address that failed. On a tool
 * whose diagnostic story is "the report says what it could not read", that is the one field
 * worth keeping.
 *
 * Safety is by construction now, which means it has to be checked rather than assumed — and
 * checked on the logger the app actually builds. This file used to stand up its own pino
 * instance with its own hand-typed list of seven paths, none of them the PII ones, and assert
 * against that: every test below would have passed with `logger.ts` redacting nothing at all.
 * `buildLogger` exists so a test can vary the destination and nothing else.
 */
function capture(): { log: ReturnType<typeof buildLogger>; lines: () => unknown[] } {
  const written: string[] = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      written.push(String(chunk));
      cb();
    },
  });

  return {
    log: buildLogger(sink),
    lines: () => written.map((l) => JSON.parse(l) as unknown),
  };
}

/**
 * The app pins the level to `warn` under NODE_ENV=test, so that Fastify's per-request info
 * logs stay out of the suite's output. Writing at `warn` here is what keeps these assertions
 * on the real configuration instead of a copy with the level turned up.
 */
describe('what a failure log names', () => {
  it('names the host that failed', () => {
    const { log, lines } = capture();
    log.error({ err: new HttpError('404 Not Found', 404, 'https://boards.greenhouse.io/acme/x') });
    expect(JSON.stringify(lines())).toContain('boards.greenhouse.io');
  });

  it('does not name a credential that rode in on the query string', () => {
    // Adzuna puts app_id and app_key there, and HttpError scrubs in its constructor — which
    // is the construction the redaction list now relies on instead of a censor.
    const err = new HttpError(
      '401 Unauthorized',
      401,
      'https://api.adzuna.com/v1/search?app_id=A1&app_key=SECRETKEY',
    );
    expect(err.url).not.toContain('SECRETKEY');
    expect(err.url).toContain('api.adzuna.com');

    const { log, lines } = capture();
    log.error({ err });
    expect(JSON.stringify(lines())).not.toContain('SECRETKEY');
  });

  it('scrubs the same parameters wherever a URL is logged by hand', () => {
    // The other route into a log record: a call site passing `url: scrubUrl(...)`.
    const scrubbed = scrubUrl('https://api.adzuna.com/v1/search?app_id=A1&app_key=SECRETKEY');
    expect(scrubbed).not.toContain('SECRETKEY');
    expect(scrubbed).toContain('api.adzuna.com');
  });

  it('still censors the things the list does hold', () => {
    // This assertion is the one that showed what a self-written config was hiding: it passed
    // for as long as the test built its own logger, and failed the moment it was pointed at
    // the app's, because `apiKey` had never been on the real list at all.
    const { log, lines } = capture();
    log.warn({ apiKey: 'sk-ant-real', req: { headers: { authorization: 'Bearer x' } } });
    const out = JSON.stringify(lines());
    expect(out).not.toContain('sk-ant-real');
    expect(out).toContain('[redacted]');
  });
});

/**
 * The columns this app takes a credential store and AES-256-GCM to protect, and what it
 * therefore must not print in plaintext beside them.
 */
describe('the fields that are encrypted at rest', () => {
  it('censors every profile field the schema marks encrypted, at any depth', () => {
    const { log, lines } = capture();
    log.warn({
      run: {
        profile: {
          fullName: 'Eric Dean',
          pronouns: 'he/him',
          email: 'eric@example.com',
          phone: '555-0100',
          dateOfBirth: '2004-03-11',
          address: '221B Baker Street, London',
        },
      },
    });

    const out = JSON.stringify(lines());
    for (const value of [
      'Eric Dean',
      'he/him',
      'eric@example.com',
      '555-0100',
      '2004-03-11',
      'Baker Street',
    ]) {
      expect(out, value).not.toContain(value);
    }
  });

  it('censors a field read-back, which is the plaintext of those same columns', () => {
    // core/filling/fill.ts reads every field back after typing into it, and what comes back
    // is the value itself: the approved answer for an essay box, the street address for an
    // address box. A local log file is a plaintext copy of exactly what this app promises to
    // keep sealed, and stdout is where these logs go.
    const { log, lines } = capture();
    log.warn({ readBack: '221B Baker Street, London', field: { readBack: 'he/him' } });

    const out = JSON.stringify(lines());
    expect(out).not.toContain('Baker Street');
    expect(out).not.toContain('he/him');
  });
});

/**
 * `note` is the only thing on a 'field not filled' line that says why, and part of it is the
 * user's own words. Both halves matter, so both are pinned.
 */
describe('a note that quotes what the page is holding', () => {
  it('empties the quotes and keeps the sentence', () => {
    const { log, lines } = capture();
    log.warn(
      {
        label: 'Home address',
        status: 'mismatch',
        note: 'The page shows "221B Baker Street, London" instead. Check this one.',
      },
      'field not filled',
    );

    const out = JSON.stringify(lines());
    expect(out, 'the address went to the log verbatim').not.toContain('Baker Street');
    // The half that has to survive: which field, what went wrong, and what to do about it.
    expect(out).toContain('The page shows');
    expect(out).toContain('Check this one');
    expect(out).toContain('Home address');
    expect(out).toContain('mismatch');
  });

  it('covers the sibling note that quotes a value from the profile', () => {
    // Written the same way in the select, radio and combobox branches of fill.ts, where the
    // quoted value is whatever the plan pulled out of the profile.
    const { log, lines } = capture();
    log.warn({ note: 'No option matching "University of Leipzig". Choose it yourself.' });

    const out = JSON.stringify(lines());
    expect(out).not.toContain('Leipzig');
    expect(out).toContain('No option matching');
  });

  it('leaves a note that quotes nothing exactly as it was', () => {
    // The other direction. Most notes carry no user data at all, and a censor that ate them
    // would leave the warning saying nothing but a status.
    const { log, lines } = capture();
    log.warn({ note: 'The page did not keep this value. Fill it in yourself.' });

    expect(JSON.stringify(lines())).toContain(
      'The page did not keep this value. Fill it in yourself.',
    );
  });
});

describe('the redaction list itself', () => {
  it('holds no url path, so a failure can name its address', () => {
    // The property is the ABSENCE of an entry, and these three shapes are the ones that
    // would swallow it: a bare `url`, `err.url`, and the `*.url` wildcard that covers every
    // other single-segment parent.
    const { log, lines } = capture();
    log.warn({
      url: 'https://boards.greenhouse.io/acme/one',
      err: { url: 'https://jobs.lever.co/acme/two' },
      source: { url: 'https://api.adzuna.com/v1/three' },
    });

    const out = JSON.stringify(lines());
    expect(out).toContain('boards.greenhouse.io');
    expect(out).toContain('jobs.lever.co');
    expect(out).toContain('api.adzuna.com');
  });

  it('still holds the header paths, which no runtime default would supply', () => {
    const { log, lines } = capture();
    log.warn({
      req: {
        headers: {
          'x-app-token': 'the-run-token',
          authorization: 'Bearer x',
          cookie: 'session=abc',
        },
      },
    });

    const out = JSON.stringify(lines());
    expect(out).not.toContain('the-run-token');
    expect(out).not.toContain('Bearer x');
    expect(out).not.toContain('session=abc');
  });
});
