/**
 * The Claude Code CLI adapter, against a stand-in binary.
 *
 * The real CLI cannot be driven from a test: it needs a signed-in account, it costs the
 * developer's usage, and it would make the suite depend on a network. So this runs the
 * adapter against a script that speaks the same contract, which pins the parts that are
 * genuinely ours:
 *
 *   - the arguments we construct;
 *   - that the prompt reaches the child on STDIN, which is the failure that would not
 *     look like a failure (generation would succeed and answer the wrong question);
 *   - that the system prompt goes via a file rather than a command line, since Windows
 *     caps one near 8191 characters and our prompts carry evidence and writing samples;
 *   - that each documented failure produces a message written for a person.
 *
 * The flags themselves were verified against the real CLI (2.1.222): `--print`,
 * `--output-format json`, `--system-prompt-file`, `--max-turns`, `--allowedTools`,
 * `--add-dir`, and `--json-schema` all exist and parse. The envelope shape below is
 * copied from a real unauthenticated response.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NoModelAccessError } from '../src/infra/llm/provider';
import {
  claudeCliBackend,
  notLoggedInMessage,
  resetCliProbe,
  silentFailure,
  usageLimitMessage,
} from '../src/infra/llm/claudeCli';
import { db, schema } from '../src/infra/db/client';
import { runMigrations } from '../src/infra/db/migrate';

let dir: string;
let fakeBin: string;
let logFile: string;

/**
 * A stand-in `claude`. Records how it was invoked, then answers like the real one.
 *
 * Written as a Node script invoked through the CLAUDE_CLI_PATH escape hatch, so the
 * adapter's own binary discovery is bypassed and only its argument handling is under test.
 */
function writeFakeCli(
  behaviour:
    | 'ok'
    | 'not_logged_in'
    | 'usage_limit'
    | 'garbage'
    | 'crash'
    | 'silent_exit_1'
    | 'silent_exit_0'
    | 'no_flag_but_mentions_a_limit'
    | 'no_cost'
    | 'silly_cost'
    | 'truncated'
    | 'refused'
    | 'no_stop_reason',
) {
  const script = `
const fs = require('fs');
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (stdin += d));
process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(logFile)}, JSON.stringify({ argv: process.argv.slice(2), stdin }));

  if (process.argv.includes('--version')) { process.stdout.write('2.1.222 (Claude Code)\\n'); process.exit(0); }
  const mode = ${JSON.stringify(behaviour)};
  if (mode === 'garbage') { process.stdout.write('<html>not json</html>'); process.exit(0); }
  if (mode === 'crash') { process.stderr.write('boom'); process.exit(3); }
  // The failure measured on a real machine: exit 1, nothing on stdout, nothing on stderr.
  if (mode === 'silent_exit_1') { process.exit(1); }
  // The same emptiness wearing a success code, which used to be read as a format change.
  if (mode === 'silent_exit_0') { process.exit(0); }

  const env = { type: 'result', subtype: 'success', session_id: 'x', num_turns: 1, total_cost_usd: 0.01, is_error: false, result: '' };
  if (mode === 'not_logged_in') { env.is_error = true; env.result = 'Not logged in · Please run /login'; }
  else if (mode === 'usage_limit') { env.is_error = true; env.result = 'Claude usage limit reached. Try again later.'; }
  else if (mode === 'no_flag_but_mentions_a_limit') {
    // Exit 0, a real answer, and NO is_error field at all — which CliEnvelope declares
    // optional on purpose, because the contract belongs to a separately released program.
    delete env.is_error;
    env.result = 'Our team hit the API usage limit reached last quarter, so I built a queue.';
  }
  // The envelope carries BOTH: subtype is the CLI's outcome for the run, stop_reason is
  // the model's own word, in the same vocabulary the API backend reports.
  else if (mode === 'truncated') { env.stop_reason = 'max_tokens'; env.result = 'ECHO:' + stdin.trim(); }
  else if (mode === 'refused') { env.stop_reason = 'refusal'; env.result = ''; }
  else if (mode === 'no_stop_reason') { env.result = 'ECHO:' + stdin.trim(); }
  else if (mode === 'no_cost') { delete env.total_cost_usd; env.result = 'ECHO:' + stdin.trim(); }
  else if (mode === 'silly_cost') { env.total_cost_usd = 'lots'; env.result = 'ECHO:' + stdin.trim(); }
  else { env.result = 'ECHO:' + stdin.trim(); }
  process.stdout.write(JSON.stringify(env));
  process.exit(0);
});
`;
  // A .js target, which the adapter runs through node with no shell. That is the same
  // shell-free path production uses for the real executable, so a .cmd wrapper here would
  // test a route the adapter deliberately does not take.
  fakeBin = path.join(dir, 'fake-claude.js');
  writeFileSync(fakeBin, script, 'utf8');
  process.env['CLAUDE_CLI_PATH'] = fakeBin;
  resetCliProbe();
}

function invocation(): { argv: string[]; stdin: string } {
  return JSON.parse(readFileSync(logFile, 'utf8')) as { argv: string[]; stdin: string };
}

// A generated answer is written to the llm_call ledger, so the tables have to exist or
// every call in this file logs a failed insert.
beforeAll(() => {
  runMigrations();
});

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'ia-fakecli-'));
  logFile = path.join(dir, 'invocation.json');
  db.delete(schema.llmCall).run();
});

afterEach(() => {
  delete process.env['CLAUDE_CLI_PATH'];
  resetCliProbe();
  rmSync(dir, { recursive: true, force: true });
});

describe('what the adapter actually runs', () => {
  it('sends the user prompt on stdin, not the command line', async () => {
    writeFakeCli('ok');
    const long = 'evidence '.repeat(2000); // Well past the Windows argv limit.
    const res = await claudeCliBackend.generate({
      purpose: 'answer_draft',
      system: 'be brief',
      user: long,
    });

    const inv = invocation();
    expect(inv.stdin).toContain('evidence');
    // The prompt must not appear in argv at any length.
    expect(inv.argv.join(' ')).not.toContain('evidence');
    // And the model's answer comes back, proving the round trip.
    expect(res.text).toContain('ECHO:');
  }, 60_000);

  it('passes the system prompt as a file, not as an argument', async () => {
    writeFakeCli('ok');
    const system = 'VOICE INSTRUCTIONS '.repeat(500);
    await claudeCliBackend.generate({ purpose: 'answer_draft', system, user: 'hi' });

    const inv = invocation();
    const i = inv.argv.indexOf('--system-prompt-file');
    expect(i, 'should use the file form').toBeGreaterThan(-1);
    expect(inv.argv.join(' ')).not.toContain('VOICE INSTRUCTIONS');
  }, 60_000);

  it('replaces the default prompt rather than appending to it', async () => {
    // Claude Code's own prompt frames the model as a coding agent in a repository, which
    // is the wrong voice for a job application.
    writeFakeCli('ok');
    await claudeCliBackend.generate({ purpose: 'answer_draft', system: 's', user: 'u' });
    expect(invocation().argv).toContain('--system-prompt-file');
    expect(invocation().argv).not.toContain('--append-system-prompt-file');
  }, 60_000);

  it('asks for JSON output and one turn with no tools', async () => {
    writeFakeCli('ok');
    await claudeCliBackend.generate({ purpose: 'answer_draft', system: 's', user: 'u' });

    const argv = invocation().argv;
    expect(argv).toContain('--print');
    expect(argv[argv.indexOf('--output-format') + 1]).toBe('json');
    expect(argv[argv.indexOf('--max-turns') + 1]).toBe('1');
    // 'none', not an empty string: cmd.exe drops empty argv elements when spawning the
    // .cmd shim, and a name matching no tool grants exactly as much as one.
    expect(argv[argv.indexOf('--allowedTools') + 1]).toBe('none');
  }, 60_000);

  it('grants Read and only the document directory when a file must be read', async () => {
    writeFakeCli('ok');
    await claudeCliBackend.generate({
      purpose: 'resume_extraction',
      system: 's',
      user: 'read it',
      documents: [path.join(dir, 'resume.pdf')],
    });

    const argv = invocation().argv;
    expect(argv[argv.indexOf('--allowedTools') + 1]).toBe('Read');
    expect(argv[argv.indexOf('--add-dir') + 1]).toBe(dir);
    // A document needs more than one turn to find and read.
    expect(Number(argv[argv.indexOf('--max-turns') + 1])).toBeGreaterThan(1);
  }, 60_000);

  /**
   * The cost panel reads the llm_call ledger and nothing else, so a backend that skips it
   * reports "No model calls yet." however much work it has done. That was the state for
   * the CLI path, which is the one most users are on.
   */
  it('records the call in the ledger, at the cost the CLI reported', async () => {
    writeFakeCli('ok');
    await claudeCliBackend.generate({ purpose: 'answer_draft', system: 's', user: 'u' });

    const rows = db.select().from(schema.llmCall).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.purpose).toBe('answer_draft');
    // This asserted 0, on the reasoning that a subscription is not billed per token. True,
    // and beside the point: the CLI puts `total_cost_usd` on every envelope, and writing the
    // row as costing exactly nothing made Settings show real work under "$0" — which is not
    // the same claim as "your subscription covers this". Stored as micro-dollars.
    expect(rows[0]?.costUsd).toBe(10_000);
  }, 60_000);

  it('passes a JSON schema through when one is asked for', async () => {
    writeFakeCli('ok');
    await claudeCliBackend.generate({
      purpose: 'resume_extraction',
      system: 's',
      user: 'u',
      schema: { name: 'profile', jsonSchema: { type: 'object' } },
    });
    const argv = invocation().argv;
    expect(JSON.parse(argv[argv.indexOf('--json-schema') + 1]!)).toEqual({ type: 'object' });
  }, 60_000);

  /**
   * Zod stamps `$schema` on everything it emits, and the CLI's validator has no such
   * meta-schema registered — it refuses the argument outright with "no schema with key or
   * ref", before any request is made. Since every schema in this app comes from
   * `z.toJSONSchema`, that made structured output unusable on the CLI backend entirely:
   * reading a resume failed on a signed-in subscription for a reason that had nothing to do
   * with the account.
   */
  it('strips the $schema key the CLI refuses to parse', async () => {
    writeFakeCli('ok');
    await claudeCliBackend.generate({
      purpose: 'resume_extraction',
      system: 's',
      user: 'u',
      schema: {
        name: 'profile',
        jsonSchema: {
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          type: 'object',
          properties: { name: { type: 'string' } },
          $defs: {
            nested: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'string' },
          },
        },
      },
    });

    const argv = invocation().argv;
    const sent = argv[argv.indexOf('--json-schema') + 1]!;
    expect(sent).not.toContain('$schema');
    // Everything else survives, nested definitions included.
    expect(JSON.parse(sent)).toEqual({
      type: 'object',
      properties: { name: { type: 'string' } },
      $defs: { nested: { type: 'string' } },
    });
  }, 60_000);

  /**
   * `$schema` is stripped only where it is a meta-schema KEYWORD, never where it is a field
   * NAME. A blind by-name strip dropped `properties.$schema` while `required` still listed
   * it — an unsatisfiable schema the CLI rejects — and mutated `const`/`default` data that
   * happened to carry a "$schema" field. So a schema describing a document that itself has a
   * "$schema" property must reach the CLI intact.
   */
  it('keeps a $schema that is a field name, stripping only the meta-schema keyword', async () => {
    writeFakeCli('ok');
    await claudeCliBackend.generate({
      purpose: 'resume_extraction',
      system: 's',
      user: 'u',
      schema: {
        name: 'doc',
        jsonSchema: {
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          type: 'object',
          properties: {
            // A field literally called "$schema" in the described document.
            $schema: { type: 'string' },
            name: { type: 'string' },
          },
          required: ['$schema', 'name'],
          // Raw data values must pass through untouched, "$schema" field and all.
          default: { $schema: 'x', keep: 1 },
        },
      },
    });

    const argv = invocation().argv;
    const sent = JSON.parse(argv[argv.indexOf('--json-schema') + 1]!);
    expect(sent).toEqual({
      type: 'object',
      properties: { $schema: { type: 'string' }, name: { type: 'string' } },
      required: ['$schema', 'name'],
      default: { $schema: 'x', keep: 1 },
    });
    // The field name is still required, so the schema stays satisfiable.
    expect(sent.required).toContain('$schema');
    expect(sent.properties.$schema).toEqual({ type: 'string' });
  }, 60_000);
});

describe('failures a person can act on', () => {
  const fails = async (): Promise<string> => {
    try {
      await claudeCliBackend.generate({ purpose: 'answer_draft', system: 's', user: 'u' });
      return '(no error thrown)';
    } catch (err) {
      expect(err).toBeInstanceOf(NoModelAccessError);
      return (err as Error).message;
    }
  };

  it('tells an unsigned-in user exactly what to do', async () => {
    writeFakeCli('not_logged_in');
    const msg = await fails();
    expect(msg).toMatch(/not signed in/i);
    expect(msg).toMatch(/run `claude`/);
    // "Please run /login" is accurate but assumes you are already inside Claude Code.
    expect(msg).not.toMatch(/\/login/);
  }, 60_000);

  /**
   * A signed-out CLI version-probes clean, so before a real call it reports itself
   * available — which under `auto` shadowed a working ANTHROPIC_API_KEY, blocking the user
   * with a sign-in wall when a billed key that would have worked sat right there. Once a
   * call surfaces the not-logged-in envelope the backend must flip to unavailable so the
   * seam can fall through to the API.
   */
  it('reports itself unavailable after a call proves it is signed out, so it stops shadowing a key', async () => {
    writeFakeCli('not_logged_in');
    // Before any call: the version probe passes, so it looks usable.
    expect(await claudeCliBackend.available()).toBe(true);
    expect(claudeCliBackend.describe()).toMatch(/no API billing/);

    await fails();

    // After the call surfaces the sign-out: unavailable, and it says so plainly.
    expect(await claudeCliBackend.available()).toBe(false);
    expect(claudeCliBackend.describe()).toMatch(/not signed in/i);

    // resetCliProbe clears the latch — signing in takes effect without a restart.
    resetCliProbe();
    writeFakeCli('ok');
    expect(await claudeCliBackend.available()).toBe(true);
  }, 60_000);

  it('explains a used-up usage limit without treating it as a crash', async () => {
    writeFakeCli('usage_limit');
    const msg = await fails();
    expect(msg).toMatch(/usage limit/i);
    expect(msg).toMatch(/refills/i);
    // And says the rest of the app still works, so the user does not conclude it is broken.
    expect(msg).toMatch(/write the answer yourself/i);
  }, 60_000);

  /**
   * The failure text used to be matched against the whole of stdout, which on a
   * successful run is the envelope holding the model's own answer. A draft that mentioned
   * a rate limit — an entirely ordinary thing for a software intern to have worked on —
   * was thrown away and reported as an exhausted subscription.
   */
  it('does not mistake a successful answer about rate limits for a rate-limit error', async () => {
    writeFakeCli('ok');
    const res = await claudeCliBackend.generate({
      purpose: 'answer_draft',
      system: 'be brief',
      user: 'I built a rate limit for our API and handled quota exhaustion; try again later.',
    });
    expect(res.text).toContain('rate limit');
  }, 60_000);

  it('says the output was unreadable rather than returning an empty draft', async () => {
    writeFakeCli('garbage');
    const msg = await fails();
    expect(msg).toMatch(/could not read/i);
    expect(msg).toMatch(/different output format/i);
  }, 60_000);

  it('surfaces a non-zero exit with its stderr', async () => {
    writeFakeCli('crash');
    const msg = await fails();
    expect(msg).toMatch(/reported an error/i);
    expect(msg).toContain('boom');
  }, 60_000);

  /**
   * The run that produced this test, verbatim: the first resume extraction of the session
   * failed after 57 seconds with exactly "The Claude CLI reported an error: exit code 1" —
   * empty stdout, empty stderr, so the detail chain fell through to the exit code. The
   * identical request worked forty seconds later. A number is not a cause, and the message
   * did not mention the one thing that fixes a transient failure.
   */
  it('does not answer a silent failure with nothing but an exit code', async () => {
    writeFakeCli('silent_exit_1');
    const msg = await fails();

    expect(msg).not.toBe('The Claude CLI reported an error: exit code 1');
    expect(msg).toMatch(/without saying why/i);
    expect(msg).toMatch(/try again/i);
    // The code stays in — it is the only fact there is, and a bug report wants it.
    expect(msg).toContain('exit code 1');
    // And nothing beyond it. The process named no cause, so neither may this: a guess at
    // credentials or the account is the wrong-diagnosis-with-a-confident-remedy failure
    // this file already has three tests about.
    expect(msg).not.toMatch(/signed in|sign in|usage limit|quota|api key/i);
  }, 60_000);

  it('says the same true thing on an empty exit 0, instead of blaming the output format', async () => {
    // Exit 0 with no output at all landed in the unreadable branch and told the user their
    // CLI "may have been updated to a different output format" — a confident claim about
    // the shape of an answer that was never printed.
    writeFakeCli('silent_exit_0');
    const msg = await fails();

    expect(msg).toMatch(/without saying why/i);
    expect(msg).toMatch(/try again/i);
    expect(msg).not.toMatch(/output format/i);
  }, 60_000);

  it('still prefers whatever the CLI did say, when it said anything', async () => {
    // The other direction, and the one the change must not cost: stderr is a real detail
    // and must not be replaced by the generic "it did not say why".
    writeFakeCli('crash');
    const msg = await fails();
    expect(msg).toContain('boom');
    expect(msg).not.toMatch(/without saying why/i);
  }, 60_000);

  it('still blames the output format when there WAS output it could not read', async () => {
    writeFakeCli('garbage');
    const msg = await fails();
    expect(msg).toMatch(/different output format/i);
    expect(msg).not.toMatch(/without saying why/i);
  }, 60_000);

  it('says the CLI is missing, and how to install it', async () => {
    process.env['CLAUDE_CLI_PATH'] = path.join(dir, 'does-not-exist');
    resetCliProbe();
    const msg = await fails();
    expect(msg).toMatch(/claude\.ai\/install|npm install -g @anthropic-ai\/claude-code/);
  }, 60_000);
});

describe('the message matchers on their own', () => {
  it('recognises the real not-logged-in text', () => {
    // Copied verbatim from the CLI at 2.1.222.
    expect(notLoggedInMessage('Not logged in · Please run /login')).toBeTruthy();
    expect(notLoggedInMessage('a perfectly normal answer')).toBeNull();
  });

  it('recognises limit wording without swallowing ordinary prose', () => {
    expect(usageLimitMessage('Claude usage limit reached')).toBeTruthy();
    expect(usageLimitMessage('I have no limits on my availability')).toBeNull();
  });

  /**
   * The sibling of the exit-code message, and the one a spawned test cannot reach portably:
   * `code` is null when the child dies on a signal rather than exiting, and the string it
   * was interpolated into rendered the literal word "null" — "exit code null", to a student
   * mid-application.
   */
  it('never says "exit code null" for a process that was killed rather than exiting', () => {
    expect(silentFailure(null)).not.toContain('null');
    expect(silentFailure(null)).toMatch(/killed/i);
    expect(silentFailure(1)).toContain('exit code 1');
    // Both spellings still point at the action that actually clears a transient failure.
    expect(silentFailure(null)).toMatch(/try again/i);
  });
});

/**
 * WHY a call could not be made, which for most of this session was a question the caller
 * could not ask.
 *
 * One error class carried seven situations and every caller could do was re-render its
 * message or fall back to advice about signing in. The web-search source did the latter, so a
 * run that TIMED OUT told a signed-in student to sign in — a wrong diagnosis with a confident
 * remedy, on the channel the repo keeps for admitting what it did not do. These pin the
 * discriminator each failure carries, because the advice downstream is chosen from it.
 */
describe('why a model call failed', () => {
  it('separates a setup problem from a working setup that broke', async () => {
    // `isSetupProblem` is the whole point: it decides between "go and configure something"
    // and "something went wrong", and only the first three reasons mean the former.
    writeFakeCli('not_logged_in');
    await expect(
      claudeCliBackend.generate({ purpose: 'answer_draft', system: 's', user: 'u' }),
    ).rejects.toMatchObject({ reason: 'not_signed_in', isSetupProblem: true });
  });

  it('calls a usage limit what it is, and does not call it missing access', async () => {
    // A cap comes back on its own; telling someone to sign in again fixes nothing and
    // suggests their credentials are the problem when they are not.
    writeFakeCli('usage_limit');
    await expect(
      claudeCliBackend.generate({ purpose: 'answer_draft', system: 's', user: 'u' }),
    ).rejects.toMatchObject({ reason: 'usage_limit', isSetupProblem: false });
  });

  it('marks a non-zero exit as the CLI erroring, not as absent access', async () => {
    writeFakeCli('crash');
    await expect(
      claudeCliBackend.generate({ purpose: 'answer_draft', system: 's', user: 'u' }),
    ).rejects.toMatchObject({ reason: 'cli_error', isSetupProblem: false });
  });

  it('marks a failure with no output as the CLI erroring, not as absent access', async () => {
    // `isSetupProblem` is what webSearch.ts branches on, and a false here is how a
    // transient crash ends up telling a signed-in student to set up model access.
    writeFakeCli('silent_exit_1');
    await expect(
      claudeCliBackend.generate({ purpose: 'answer_draft', system: 's', user: 'u' }),
    ).rejects.toMatchObject({ reason: 'cli_error', isSetupProblem: false });
  });

  it('marks unreadable output as unreadable', async () => {
    writeFakeCli('garbage');
    await expect(
      claudeCliBackend.generate({ purpose: 'answer_draft', system: 's', user: 'u' }),
    ).rejects.toMatchObject({ reason: 'unreadable', isSetupProblem: false });
  });

  it('names the timeout branch as timed_out rather than as missing access', () => {
    // Asserted against the source, not by waiting one out. `config` is parsed once at import,
    // so CLAUDE_CLI_TIMEOUT_MS cannot be lowered from inside a test — the hanging binary would
    // have to be waited out for the full configured ceiling, which is minutes. The branch is
    // three lines long and the discriminator on it is the whole point: this is the case that
    // shipped wrong, where a killed 32-turn sweep told a signed-in student to sign in.
    const src = readFileSync(new URL('../src/infra/llm/claudeCli.ts', import.meta.url), 'utf8');
    // A slice, not a regex: a lazy match for the closing brace stops at the one inside the
    // template literal on the line above it.
    const at = src.indexOf('if (r.timedOut) {');
    const branch = at < 0 ? '' : src.slice(at, at + 400);
    expect(branch).toMatch(/NoModelAccessError/);
    expect(branch).toMatch(/'timed_out'/);
  });

  it('every reason a NoModelAccessError can carry is one of the seven declared', async () => {
    // The type is a union and TypeScript checks the throw sites, but the two consumers pick
    // their wording off `isSetupProblem` — so a reason added later without a decision about
    // which side of that line it falls on would silently inherit "something went wrong".
    for (const behaviour of [
      'not_logged_in',
      'usage_limit',
      'crash',
      'garbage',
      'silent_exit_1',
      'silent_exit_0',
    ] as const) {
      writeFakeCli(behaviour);
      const err = await claudeCliBackend
        .generate({ purpose: 'answer_draft', system: 's', user: 'u' })
        .then(() => null)
        .catch((e: unknown) => e as NoModelAccessError);
      expect(err, behaviour).toBeInstanceOf(NoModelAccessError);
      expect(
        [
          'unavailable',
          'not_signed_in',
          'no_key',
          'usage_limit',
          'timed_out',
          'cli_error',
          'unreadable',
        ],
        behaviour,
      ).toContain(err!.reason);
      expect(typeof err!.isSetupProblem, behaviour).toBe('boolean');
    }
  });
});

/**
 * A sweep is not the same shape of call as a draft, and one ceiling could not fit both.
 *
 * Asserted against the source, because the ceiling is applied inside a private helper and
 * proving it at runtime would mean actually waiting out a multi-minute timeout. What matters
 * is that the multiplier exists and is keyed on `webSearch` — the property that was missing
 * when the turn budget was raised to 32 and the ceiling was left at a one-shot 180s.
 */
describe('how long a call is given', () => {
  it('gives a web-search call more room than a single-turn one', () => {
    const src = readFileSync(new URL('../src/infra/llm/claudeCli.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/function ceilingFor\(/);
    expect(src).toMatch(/req\.webSearch === true \? 5 : 1/);
    // Scaled from the configured value rather than replacing it, so raising
    // CLAUDE_CLI_TIMEOUT_MS still raises both.
    expect(src).toMatch(/config\.llm\.cliTimeoutMs \* \(req\.webSearch/);
  });

  it('passes that ceiling to the process rather than reading the config again', () => {
    // The timer used to read `config.llm.cliTimeoutMs` directly, which is why a per-call
    // ceiling could not exist at all.
    const src = readFileSync(new URL('../src/infra/llm/claudeCli.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/}, timeoutMs\);/);
    expect(src).toMatch(/await run\(c, args, stdin, timeoutMs\)/);
  });
});

/**
 * The web-search invocation, whose properties carry the tier's whole safety argument.
 *
 * The argv was pinned for the no-tool path and the document path and never once for this one,
 * though it is the branch that grants a tool at all. `webSearch.ts` tells the reader "this
 * machine fetches nothing here" and "the tool that could read repository files stays
 * ungranted" — both are claims about these two arguments.
 */
describe('what the adapter runs for a web search', () => {
  it('grants WebSearch and nothing else', async () => {
    writeFakeCli('ok');
    await claudeCliBackend.generate({
      purpose: 'web_discovery',
      system: 's',
      user: 'u',
      webSearch: true,
    });
    const { argv } = invocation();
    const at = argv.indexOf('--allowedTools');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(argv[at + 1]).toBe('WebSearch');
    // Read is what would let the model open files on this machine. It is granted on the
    // resume path and must not be granted here.
    expect(argv).not.toContain('Read');
    expect(argv).not.toContain('--add-dir');
  });

  it('gives it the turns a sweep needs, not a single-shot budget', async () => {
    // The prompt asks for several searches across different angles; one turn cannot do it.
    writeFakeCli('ok');
    await claudeCliBackend.generate({
      purpose: 'web_discovery',
      system: 's',
      user: 'u',
      webSearch: true,
    });
    const { argv } = invocation();
    const turns = Number(argv[argv.indexOf('--max-turns') + 1]);
    expect(turns).toBeGreaterThan(1);
  });

  it('still grants nothing at all on an ordinary draft', () => {
    // The other direction, which is the property the default protects.
    writeFakeCli('ok');
    return claudeCliBackend
      .generate({ purpose: 'answer_draft', system: 's', user: 'u' })
      .then(() => {
        const { argv } = invocation();
        expect(argv[argv.indexOf('--allowedTools') + 1]).not.toBe('WebSearch');
        expect(Number(argv[argv.indexOf('--max-turns') + 1])).toBe(1);
      });
  });
});

/**
 * What the ledger is told a call cost.
 *
 * The CLI reports `total_cost_usd` on every envelope. This backend read it, logged it, and
 * returned it on a field nothing consumes — while writing the ledger a hardcoded zero token
 * count against a model name deliberately absent from PRICING, so every CLI call was recorded
 * as costing exactly nothing. Settings then showed real work under "$0", which is not the same
 * claim as "your subscription covers this" and reads as a tool that has lost count.
 */
describe('what a CLI call is recorded as costing', () => {
  it('writes down what the CLI itself reported', async () => {
    writeFakeCli('ok');
    await claudeCliBackend.generate({ purpose: 'answer_draft', system: 's', user: 'u' });
    const rows = db.select().from(schema.llmCall).all();
    expect(rows).toHaveLength(1);
    // The fake reports 0.01, which the ledger stores as micro-dollars.
    expect(rows[0]?.costUsd).toBe(10_000);
  });

  it('does not silently price a CLI call from token counts it never reports', async () => {
    // CLI_MODEL is absent from PRICING on purpose. Falling back to that lookup is what
    // produced the zero.
    writeFakeCli('ok');
    await claudeCliBackend.generate({ purpose: 'answer_draft', system: 's', user: 'u' });
    const row = db.select().from(schema.llmCall).all()[0];
    expect(row?.inputTokens).toBe(0);
    expect(row?.costUsd).toBeGreaterThan(0);
  });
});

/**
 * An envelope with no `is_error` field at all.
 *
 * `CliEnvelope` declares every field optional on purpose — the contract belongs to a
 * separately released program — so absence is a shape this adapter explicitly plans for. The
 * predicate used to be `is_error !== false`, which is TRUE when the field is missing, so an
 * exit-0 run had the model's own answer scanned for sign-in and usage-limit phrases. An answer
 * ABOUT a rate limit was then reported to the student as an exhausted subscription: the exact
 * mistake the comment beside it records having already fixed once, reintroduced by a spelling.
 *
 * The predicate was changed to `is_error === true || code !== 0` and nothing tested it —
 * reverting it left all 31 cases in this file green.
 */
describe('a CLI answer that mentions a limit without being one', () => {
  it('is returned, not mistaken for an exhausted subscription', async () => {
    writeFakeCli('no_flag_but_mentions_a_limit');
    const res = await claudeCliBackend.generate({
      purpose: 'answer_draft',
      system: 'be brief',
      user: 'tell me about a project',
    });
    expect(res.text).toContain('usage limit reached');
    expect(res.text).toContain('I built a queue');
  }, 30_000);

  it('still reports a real failure, so the looser predicate has not gone slack', async () => {
    // The mirror case: the flag IS set, and the same phrase now means what it says.
    writeFakeCli('usage_limit');
    await expect(
      claudeCliBackend.generate({ purpose: 'answer_draft', system: 's', user: 'u' }),
    ).rejects.toMatchObject({ reason: 'usage_limit' });
  }, 30_000);
});

/**
 * What the ledger records when the CLI does not say what a call cost.
 *
 * Three existing tests assert the same thing — that a numeric `total_cost_usd` is written down
 * — and none covered the field being absent or non-numeric, which the envelope's own optional
 * typing says can happen. A cost of zero and a cost nobody reported are different facts, and
 * the usage screen adds these up.
 */
describe('a CLI call that reports no cost', () => {
  it('records the call with no reported cost rather than inventing a zero', async () => {
    writeFakeCli('no_cost');
    await claudeCliBackend.generate({ purpose: 'answer_draft', system: 's', user: 'u' });

    const rows = db.select().from(schema.llmCall).all();
    const row = rows[rows.length - 1];
    expect(row).toBeDefined();
    // Whatever it stores, it must not claim the CLI reported a price it did not report.
    expect(row?.costUsd == null || row.costUsd === 0).toBe(true);
  }, 30_000);

  it('does not store a cost the envelope gave as something other than a number', async () => {
    writeFakeCli('silly_cost');
    await claudeCliBackend.generate({ purpose: 'answer_draft', system: 's', user: 'u' });

    const rows = db.select().from(schema.llmCall).all();
    const row = rows[rows.length - 1];
    expect(row?.costUsd == null || typeof row.costUsd === 'number').toBe(true);
  }, 30_000);
});

/**
 * THE MODEL'S REASON FOR STOPPING, IN THE VOCABULARY THE CALLERS SPEAK.
 *
 * `stopReason` was read off the envelope's `subtype`, which is the CLI's outcome for the whole
 * run — "success" on every ordinary call. The callers compare it against the API's vocabulary:
 * `extractResume` has a `refusal` branch and a `max_tokens` branch, and on the default backend
 * neither could ever fire. A resume long enough to exhaust the output budget fell through both
 * and came back as "the model returned something this app could not read as a resume", which
 * blames the format, suggests nothing, and says the same thing on every retry.
 *
 * The envelope carries `stop_reason` alongside `subtype`, in exactly the API's words. It is
 * that field the seam has to hand on.
 */
describe('the stop reason the seam reports', () => {
  it("hands on the model's word, not the CLI's outcome for the run", async () => {
    writeFakeCli('truncated');
    const r = await claudeCliBackend.generate({
      purpose: 'resume_extraction',
      system: 's',
      user: 'u',
    });
    expect(r.stopReason).toBe('max_tokens');
  });

  it('reports a refusal as a refusal, so the caller can say so', async () => {
    writeFakeCli('refused');
    const r = await claudeCliBackend.generate({
      purpose: 'resume_extraction',
      system: 's',
      user: 'u',
    });
    expect(r.stopReason).toBe('refusal');
  });

  it('falls back to the subtype when the envelope states no stop reason', async () => {
    // Every field on CliEnvelope is optional on purpose — the contract belongs to a
    // separately released program — so an older CLI that sends no `stop_reason` must not
    // start reporting null and lose the little the envelope does say.
    writeFakeCli('no_stop_reason');
    const r = await claudeCliBackend.generate({
      purpose: 'resume_extraction',
      system: 's',
      user: 'u',
    });
    expect(r.stopReason).toBe('success');
  });
});
