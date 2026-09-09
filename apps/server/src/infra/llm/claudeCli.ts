/**
 * The Claude Code CLI as a model backend — docs/14-model-access.md.
 *
 * WHY THIS EXISTS. A Claude Max subscription is not an API key, and Anthropic explicitly
 * prohibits using a subscription's OAuth token inside another product. So this backend
 * does the one thing that is not that: it runs Anthropic's own client as a subprocess on
 * the user's own machine. The CLI authenticates itself. This process never reads
 * ~/.claude, never handles a token, and never talks to api.anthropic.com.
 *
 * WHAT THIS IS FOR: a personal tool, run locally, by the person whose subscription it is.
 * WHAT IT IS NOT: a way to ship software that borrows other people's subscriptions.
 * docs/14 says so next to the policy text.
 *
 * THREE CONSTRAINTS SHAPE THE INVOCATION, and they are not obvious:
 *
 *   1. `--bare` cannot be used. It skips credential discovery and then demands an
 *      ANTHROPIC_API_KEY, which is exactly what we do not have. Tools/skills/MCP are
 *      disabled with `--allowedTools` instead.
 *
 *   2. Long text cannot go on the command line. Windows caps a command line near 8191
 *      characters and our prompts carry an evidence block plus writing samples. The
 *      system prompt goes to a temp file via `--system-prompt-file`; the user content
 *      goes on stdin, which the CLI reads as input data.
 *
 *   3. `--system-prompt-file` REPLACES Claude Code's default prompt rather than appending
 *      to it. That is what we want: the default frames the model as a coding agent
 *      working in a repository, which is the wrong voice for a job application.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from '../../config';
import { logger } from '../logger';
import { CLI_MODEL, recordCall } from './client';
import {
  NoModelAccessError,
  type Backend,
  type GenerateRequest,
  type GenerateResult,
} from './provider';

const INSTALL_HINT =
  'Install it, then run `claude` once and sign in with your Claude account:\n\n' +
  '  irm https://claude.ai/install.ps1 | iex        (PowerShell, recommended)\n' +
  '  winget install Anthropic.ClaudeCode\n' +
  '  npm install -g @anthropic-ai/claude-code\n\n' +
  'If it is installed somewhere unusual, set CLAUDE_CLI_PATH in .env to the full path.';

/**
 * Binaries to try, in order of preference.
 *
 * The native installer produces a real `claude.exe`, which Node can spawn directly. An
 * npm global install produces a `claude.cmd` shim, and Windows cannot execute a .cmd
 * without a shell. Preferring the .exe keeps `shell: false`, so nothing we pass is ever
 * re-parsed by cmd.exe.
 */
interface Candidate {
  bin: string;
}

/**
 * Where to look, best first.
 *
 * NOTHING HERE USES A SHELL, and that is the important property. The npm install puts a
 * `claude.cmd` shim on PATH, and Node cannot execute a .cmd without `shell: true` — which
 * concatenates arguments instead of escaping them (Node's own DEP0190 warning). Measured:
 * `--json-schema {"type":"object"}` reaches the CLI mangled and is rejected as invalid
 * JSON. So the shim is skipped entirely in favour of the real executable it wraps, which
 * both the npm package and the native installer ship.
 */
function candidates(): Candidate[] {
  // Read from the environment rather than the frozen config snapshot, so setting this
  // takes effect without a restart.
  const override = process.env['CLAUDE_CLI_PATH'] ?? config.llm.cliPath;
  if (override) return [{ bin: override }];

  if (process.platform !== 'win32') return [{ bin: 'claude' }];

  const home = process.env['USERPROFILE'] ?? os.homedir();
  const appData = process.env['APPDATA'] ?? path.join(home, 'AppData', 'Roaming');

  return [
    // Native installer.
    { bin: path.join(home, '.local', 'bin', 'claude.exe') },
    // npm global: the executable the .cmd shim calls. Named explicitly rather than
    // trusting PATH, because a server started before the install has a stale environment.
    {
      bin: path.join(
        appData,
        'npm',
        'node_modules',
        '@anthropic-ai',
        'claude-code',
        'bin',
        'claude.exe',
      ),
    },
    { bin: 'claude.exe' },
  ];
}

/** Interpreted targets, so a JS entry point can be pointed at directly. */
const JS_ENTRY = /\.(c|m)?js$/i;

/** Resolves a candidate to something spawnable with no shell involved. */
function commandFor(c: Candidate): { file: string; prefix: string[] } {
  return JS_ENTRY.test(c.bin)
    ? { file: process.execPath, prefix: [c.bin] }
    : { file: c.bin, prefix: [] };
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * How long one call may take, given what it was allowed to do.
 *
 * A single-turn draft and a multi-turn web sweep are not the same shape of request, and one
 * ceiling could not fit both: the sweep was raised to 32 turns — each of them a live search
 * and a page read — while the ceiling stayed at the 180s written for a one-shot call. So the
 * sweep was killed partway through, every time, on a machine where running the identical
 * search by hand takes several minutes and works.
 *
 * What made it costly rather than merely slow is where the timeout LANDED: as a
 * NoModelAccessError, which the web-search source reported to the student as "no model
 * access — sign in to the Claude Code CLI", to someone already signed in. A wrong diagnosis
 * with a confident remedy.
 *
 * Scaled from the configured ceiling rather than replacing it, so raising
 * CLAUDE_CLI_TIMEOUT_MS still raises both.
 */
function ceilingFor(req: { webSearch?: boolean }): number {
  return config.llm.cliTimeoutMs * (req.webSearch === true ? 5 : 1);
}

async function run(
  c: Candidate,
  args: string[],
  stdin: string,
  timeoutMs: number,
): Promise<RunResult> {
  return new Promise((resolve) => {
    let child;
    try {
      const { file, prefix } = commandFor(c);
      child = spawn(file, [...prefix, ...args], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        // Never a shell. See `candidates()` for what that costs and why it is worth it.
        shell: false,
      });
    } catch (err) {
      resolve({ code: null, stdout: '', stderr: String(err), timedOut: false });
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => (stdout += d));
    child.stderr.on('data', (d: string) => (stderr += d));

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: `${stderr}\n${err.message}`, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });

    // The child may exit before stdin drains; `close` reports the real outcome.
    child.stdin.on('error', () => undefined);
    child.stdin.end(stdin, 'utf8');
  });
}

// ───────────────────────────────────────────────────────────── capability probe

let found: Candidate | null = null;
let version = '';
let failure: string | null = null;
/**
 * Set once a real call proves the installed CLI is signed out.
 *
 * `--version` needs no credentials, so `probe()` cannot tell a signed-in CLI from a
 * signed-out one — only an actual generate can. Until that happened, a signed-out CLI
 * reported itself `available: true` and, under `auto`, shadowed a working ANTHROPIC_API_KEY:
 * the user was told to sign in when a billed key that would have worked sat right there.
 * Once a call surfaces the not-logged-in envelope we latch this, so `available()` says
 * false and the seam can fall through to the API. `resetCliProbe` clears it — signing in
 * takes effect without a restart.
 */
let signedOut = false;

async function probe(): Promise<Candidate | null> {
  if (found) return found;
  if (failure) return null;

  for (const c of candidates()) {
    if (path.isAbsolute(c.bin) && !existsSync(c.bin)) continue;
    // A version probe is the smallest call there is; it never needs the sweep's ceiling.
    const r = await run(c, ['--version'], '', config.llm.cliTimeoutMs);
    if (r.code === 0 && /\d+\.\d+/.test(r.stdout)) {
      found = c;
      // `--version` prints "2.1.222 (Claude Code)". Keep the number; the name is already
      // in every sentence this gets interpolated into.
      version = (/[\d.]+/.exec(r.stdout)?.[0] ?? r.stdout).trim();
      logger.info({ bin: c.bin, version }, 'model calls will use the Claude Code CLI');
      return found;
    }
  }

  failure = config.llm.cliPath
    ? `CLAUDE_CLI_PATH is set to ${config.llm.cliPath}, but running it did not work.`
    : 'The `claude` command was not found on this machine.';
  return null;
}

/** Lets the app notice a CLI installed after startup, and gives tests a clean slate. */
export function resetCliProbe(): void {
  found = null;
  version = '';
  failure = null;
  signedOut = false;
}

// ────────────────────────────────────────────────────────────── response parsing

/**
 * The `--output-format json` envelope.
 *
 * Every field is optional on purpose. This contract belongs to a separately released
 * program, so a field that changes shape should surface as a readable error from
 * `extractText`, not as a crash at a property access.
 */
interface CliEnvelope {
  type?: string;
  subtype?: string;
  /**
   * The MODEL's reason for stopping — "end_turn", "max_tokens", "tool_use", "refusal" — in
   * the same vocabulary the API backend reports.
   *
   * Distinct from `subtype`, which is the CLI's own outcome for the whole run ("success",
   * "error_max_turns"). `stopReason` was read off `subtype`, so on the default backend it
   * carried "success" where callers expected the model's word, and both guards in
   * `extractResume` — the refusal branch and the truncation branch — were unreachable. A
   * resume long enough to exhaust the output budget came back as "the model returned
   * something this app could not read as a resume", which blames the format, suggests
   * nothing, and says the same thing on every retry.
   */
  stop_reason?: string;
  is_error?: boolean;
  result?: unknown;
  structured_output?: unknown;
  total_cost_usd?: number;
  session_id?: string;
  num_turns?: number;
}

function parseEnvelope(stdout: string): CliEnvelope | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as CliEnvelope;
  } catch {
    // Some versions emit newline-delimited objects; the last complete one is the result.
    const lines = trimmed.split('\n').filter((l) => l.trim().startsWith('{'));
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        return JSON.parse(lines[i]!) as CliEnvelope;
      } catch {
        continue;
      }
    }
    return null;
  }
}

function extractText(env: CliEnvelope): string {
  if (typeof env.result === 'string') return env.result.trim();
  if (env.result && typeof env.result === 'object') {
    const r = env.result as { text?: unknown; content?: unknown };
    if (typeof r.text === 'string') return r.text.trim();
    if (Array.isArray(r.content)) {
      return r.content
        .map((b: unknown) =>
          b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string'
            ? (b as { text: string }).text
            : '',
        )
        .join('')
        .trim();
    }
  }
  return '';
}

/**
 * Usage exhaustion is the failure a subscription user will actually hit, and an exit code
 * teaches them nothing. Matched on the CLI's own words: the docs do not promise a distinct
 * exit code, and they do say a failure is printed as the result on stdout.
 */
export function usageLimitMessage(text: string): string | null {
  if (!/usage limit|rate limit|limit reached|quota|try again (later|at|in)/i.test(text)) {
    return null;
  }
  return (
    'Your Claude usage limit is currently used up, so nothing could be generated. It refills ' +
    'on a rolling window. Everything else here still works: write the answer yourself and it ' +
    'gets fact-checked against your profile exactly the same way.'
  );
}

/**
 * The other failure a subscription user actually hits, and the first one they will hit.
 *
 * Verified against the real CLI: an unauthenticated run exits with `is_error: true` and
 * `result: "Not logged in · Please run /login"`. That is accurate but assumes you are
 * sitting in Claude Code, which the person reading this is not.
 */
export function notLoggedInMessage(text: string): string | null {
  if (!/not logged in|please run \/login|\bunauthorized\b|no credentials/i.test(text)) {
    return null;
  }
  return (
    'The Claude Code CLI is installed but not signed in yet.\n\n' +
    'Open a terminal, run `claude`, and sign in with your Claude account. It only needs ' +
    'doing once. Then come back and press Test.'
  );
}

/**
 * What to say when the CLI failed and told us nothing whatsoever about why.
 *
 * Measured on a real machine, not imagined: the first resume extraction of the session
 * exited 1 after 57 seconds with EMPTY stdout and EMPTY stderr, so the detail chain below
 * fell through to its last link and the entire sentence a person got was "The Claude CLI
 * reported an error: exit code 1". The identical request succeeded forty seconds later, so
 * whatever it was, it was transient. The number names no cause, and the one action that
 * actually works — do it again — was the one thing the message did not mention.
 *
 * It says no more than that on purpose. The process gave no reason, so anything here about
 * credentials, the network or the account would be a diagnosis invented in this file. The
 * exit code stays in for a bug report; the rest is only what is known.
 *
 * SIBLINGS COVERED, both written the same way and both reached by the same empty-handed
 * failure:
 *   - `exit code ${String(r.code)}` renders the literal word "null" when the child died on
 *     a signal instead of exiting, which is the same non-explanation with a worse noun;
 *   - an exit-0 run that printed nothing at all used to land in the `unreadable` branch and
 *     be reported as "it may have been updated to a different output format" — a confident
 *     claim about a program that produced no output to have a format.
 */
export function silentFailure(code: number | null): string {
  const how = code === null ? 'it was killed before it could exit' : `exit code ${String(code)}`;
  return (
    `The Claude CLI stopped without saying why: no output, no error text (${how}).\n\n` +
    'This is usually transient — the same request generally works on the next attempt, so ' +
    'try again. If it keeps happening, run `claude` once in a terminal and see whether it ' +
    'answers there.'
  );
}

// ─────────────────────────────────────────────────────────────────── the backend

/** Short, fixed, and safe on any command line. The real content arrives on stdin. */
const STDIN_DIRECTIVE =
  'The full task is provided on standard input. Read it and respond to it directly.';

/**
 * An allowlist entry that matches no tool, which is how "grant nothing" is expressed.
 *
 * See the call site: the obvious spelling, an empty string, is silently dropped when the
 * npm .cmd shim is spawned through cmd.exe on Windows.
 */
const NO_TOOLS = 'none';

/**
 * The schema, in the dialect `--json-schema` will actually take.
 *
 * Zod stamps `"$schema": "https://json-schema.org/draft/2020-12/schema"` on everything it
 * emits, and the CLI's validator has no such meta-schema registered — it rejects the whole
 * argument before the request is even made, with
 *
 *     Error: --json-schema is not a valid JSON Schema:
 *     no schema with key or ref "https://json-schema.org/draft/2020-12/schema"
 *
 * The same schema with that one key removed is accepted. Nothing else about it changes, and
 * the API path keeps the key because the API wants it, so this strips rather than rewrites.
 * Recursive, because a nested `$defs` entry can carry its own.
 *
 * STRIP THE KEYWORD, NOT THE NAME. `$schema` is a meta-schema keyword only at a schema
 * position. Inside `properties`/`$defs`/etc. the child keys are field NAMES: a schema that
 * describes a document with a field literally called "$schema" would, under a blind
 * by-name strip, lose that property while `required` still listed it — an unsatisfiable
 * schema the CLI rejects. And `const`/`default`/`enum`/`examples` hold raw data values, not
 * schemas, so a data object carrying a "$schema" field must pass through untouched. So we
 * keep every name in a name→subschema map, never descend into data values, and drop
 * `$schema` only where it is a keyword.
 */
const SCHEMA_MAPS = new Set([
  'properties',
  'patternProperties',
  '$defs',
  'definitions',
  'dependentSchemas',
]);
const DATA_VALUES = new Set(['const', 'default', 'enum', 'examples']);

function forCli(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(forCli);
  if (schema === null || typeof schema !== 'object') return schema;

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    if (k === '$schema') continue;
    if (DATA_VALUES.has(k)) {
      out[k] = v;
    } else if (SCHEMA_MAPS.has(k) && v !== null && typeof v === 'object' && !Array.isArray(v)) {
      const cleaned: Record<string, unknown> = {};
      for (const [name, sub] of Object.entries(v as Record<string, unknown>)) {
        cleaned[name] = forCli(sub);
      }
      out[k] = cleaned;
    } else {
      out[k] = forCli(v);
    }
  }
  return out;
}

export const claudeCliBackend: Backend = {
  kind: 'claude_cli',

  async available(): Promise<boolean> {
    // A CLI that is installed but signed out cannot serve a request, so it must not report
    // itself available — otherwise it shadows a working API key under `auto`.
    return (await probe()) !== null && !signedOut;
  },

  describe(): string {
    if (!found) return 'Claude Code CLI (not installed)';
    if (signedOut) return 'Claude Code CLI (installed, not signed in)';
    return `Claude Code CLI ${version} — your subscription, no API billing`;
  },

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const c = await probe();
    if (!c) {
      throw new NoModelAccessError(
        `${failure ?? 'The Claude Code CLI is unavailable.'}\n\n${INSTALL_HINT}`,
        'unavailable',
      );
    }

    /**
     * Under the app's own root, not the machine's temp directory.
     *
     * The file written below is `req.system`, and for drafting that carries the user's name,
     * their city, the evidence facts, and up to three DECRYPTED writing samples. In
     * `os.tmpdir()` it was outside the one root config.ts insists everything lives under, so
     * a process killed mid-generation stranded a plaintext copy of the user's own writing
     * somewhere "delete everything" does not look — while that endpoint went on promising no
     * copy is kept anywhere.
     */
    await mkdir(config.paths.scratch, { recursive: true });
    const dir = await mkdtemp(path.join(config.paths.scratch, 'ia-claude-'));
    const systemFile = path.join(dir, 'system.txt');

    try {
      await writeFile(systemFile, req.system, 'utf8');

      const wantsDocuments = (req.documents?.length ?? 0) > 0;
      const wantsWebSearch = req.webSearch === true;

      // `req.maxTokens` has no counterpart on this path. The CLI publishes no flag for an
      // output cap, and every flag below was checked against the real binary rather than
      // guessed, so length here is bounded by the word target the prompt already states.
      // The API path applies it as a hard limit; expect the two to differ a little.
      //
      // Turn budgets: a document read is a couple of Read calls; a web search is a
      // conversation with the search tool — each query and each result read is a turn, and
      // a discovery pass runs several queries before it has enough to answer with.
      const args = [
        '--print',
        STDIN_DIRECTIVE,
        '--output-format',
        'json',
        // Replaces Claude Code's coding-agent prompt outright. See the header.
        '--system-prompt-file',
        systemFile,
        '--max-turns',
        // Sixteen was a one-pass budget: each search is a turn, and the discovery prompt
        // asks for a sweep across several angles — role, each location, recency, employer
        // kind. The model ran out of turns partway through and answered with what it had.
        wantsWebSearch ? '32' : wantsDocuments ? '6' : '1',
      ];

      if (wantsWebSearch) {
        // WebSearch only — Anthropic's own search runs the queries, this machine fetches
        // nothing here, and the tool that could read repository files stays ungranted. The
        // model's answer is a list of candidate URLs; what becomes a stored posting is
        // decided by this process fetching each one through the robots-respecting fetcher,
        // never by the model's word.
        args.push('--allowedTools', 'WebSearch');
      } else if (wantsDocuments) {
        // A PDF cannot be passed inline; it has to be read from disk, which needs the
        // Read tool and an explicitly permitted directory. Only the directories holding
        // the requested files are granted, never the repository.
        args.push('--allowedTools', 'Read');
        for (const d of new Set(req.documents!.map((f) => path.dirname(f)))) {
          args.push('--add-dir', d);
        }
      } else {
        // NOT an empty string. `--allowedTools ""` parses fine from a shell, but an
        // empty argv element is dropped when the .cmd shim is spawned through cmd.exe,
        // and the CLI then rejects the flag as missing its argument. This is an
        // allowlist, so a name that matches no tool grants nothing — and unlike an empty
        // string it survives the trip. `--max-turns 1` bounds it regardless.
        args.push('--allowedTools', NO_TOOLS);
      }

      if (req.schema) {
        args.push('--json-schema', JSON.stringify(forCli(req.schema.jsonSchema)));
      }

      const stdin = wantsDocuments
        ? `${req.user}\n\nThe files to read:\n${req.documents!.join('\n')}\n`
        : req.user;

      const timeoutMs = ceilingFor(req);
      const started = Date.now();
      const r = await run(c, args, stdin, timeoutMs);

      if (r.timedOut) {
        throw new NoModelAccessError(
          `The Claude CLI did not finish within ${Math.round(timeoutMs / 1000)}s and was stopped. ` +
            'Try again, or raise CLAUDE_CLI_TIMEOUT_MS in .env.',
          'timed_out',
        );
      }

      const env = parseEnvelope(r.stdout);

      /**
       * Sign-in and usage-limit failures arrive inside a successful-looking JSON envelope
       * with is_error set, so they are matched on the text before the generic error path
       * flattens them into "the CLI reported an error: Not logged in".
       *
       * ONLY ON A FAILED RUN, though. This used to match against the whole of stdout,
       * which on a SUCCESSFUL run is the envelope containing the model's own answer — so
       * a perfectly good draft that happened to contain "rate limit", "quota" or
       * "unauthorized" was thrown away and reported to the user as an exhausted
       * subscription. An answer about a rate-limiting project is not a rate-limit error.
       */
      /**
       * The same definition of failure the throw seventeen lines below uses.
       *
       * `is_error !== false` is true whenever the field is ABSENT, and `CliEnvelope` declares
       * every field optional on purpose — "this contract belongs to a separately released
       * program" — so absence is a shape this file explicitly plans for. An exit-0 run whose
       * envelope simply omitted the flag therefore had the model's own answer scanned for
       * sign-in and usage-limit phrases, which is the exact mistake the comment above records
       * having already fixed once: an answer ABOUT a rate limit is not a rate-limit error.
       */
      if (env?.is_error === true || r.code !== 0) {
        const combined = `${env ? extractText(env) : r.stdout}\n${r.stderr}`;
        const notSignedIn = notLoggedInMessage(combined);
        if (notSignedIn) {
          // Latch it: the version probe cannot see this, so without the flag `available()`
          // would keep claiming the CLI can serve requests and keep shadowing the API key.
          signedOut = true;
          throw new NoModelAccessError(notSignedIn, 'not_signed_in');
        }

        const limit = usageLimitMessage(combined);
        if (limit) throw new NoModelAccessError(limit, 'usage_limit');
      }

      // A crash is diagnosed before a parse failure, because a crashed process produces
      // no output and "the output format must have changed" is then exactly the wrong
      // thing to tell someone. Order matters more than either message.
      if (env?.is_error === true || r.code !== 0) {
        // The chain is right in structure — the CLI's own words first, then whatever it put
        // on stderr — but the last link used to be the exit code, and that link is the one
        // that reaches a person. See `silentFailure` for the run that produced neither.
        const detail = (env ? extractText(env) : '') || r.stderr.trim();
        logger.error(
          { code: r.code, detail: detail.slice(0, 300) || '(no output on either stream)' },
          'claude cli reported an error',
        );
        throw new NoModelAccessError(
          detail ? `The Claude CLI reported an error: ${detail}` : silentFailure(r.code),
          'cli_error',
        );
      }

      if (!env) {
        // Exit 0 and not one byte on either stream. That is the same silent failure as the
        // branch above wearing a success code, and the message below — written for output
        // whose SHAPE changed — would tell the user their CLI has been updated to a
        // different output format, on the evidence of no output at all.
        if (!r.stdout.trim() && !r.stderr.trim()) {
          logger.error({ code: r.code }, 'claude cli produced no output at all');
          throw new NoModelAccessError(silentFailure(r.code), 'cli_error');
        }

        logger.error(
          { code: r.code, stdout: r.stdout.slice(0, 400), stderr: r.stderr.slice(0, 400) },
          'could not parse Claude CLI output',
        );
        throw new NoModelAccessError(
          // Reason 'unreadable': the CLI is installed, signed in and answering — it is the SHAPE
          // of the answer that changed. Telling this user to set up model access would send
          // them to fix the one thing that is demonstrably working.
          'The Claude CLI ran but returned something this app could not read. It may have been ' +
            'updated to a different output format.\n\n' +
            `Exit code: ${String(r.code)}\n` +
            `Output began: ${r.stdout.slice(0, 200) || '(empty)'}\n` +
            `Errors: ${r.stderr.slice(0, 200) || '(none)'}`,
          'unreadable',
        );
      }

      const text = extractText(env);
      const latencyMs = Date.now() - started;
      logger.debug(
        { purpose: req.purpose, ms: latencyMs, costUsd: env.total_cost_usd, chars: text.length },
        'claude cli call',
      );

      // The cost panel reads the llm_call ledger and nothing else, and this backend wrote
      // nothing to it. A user whose drafting all runs through the CLI — the preferred
      // backend under `auto` — opened the panel after twenty answers and read "No model
      // calls yet.", with no per-purpose counts and no way to trace a bad draft back.
      recordCall({
        purpose: req.purpose,
        model: CLI_MODEL,
        // The CLI reports no token counts, and CLI_MODEL is deliberately absent from PRICING,
        // so there is nothing here to price from — which is why the cost has to come from the
        // envelope. Without it every CLI call was written down as costing exactly zero.
        usage: { input_tokens: 0, output_tokens: 0 },
        reportedUsd: typeof env.total_cost_usd === 'number' ? env.total_cost_usd : undefined,
        latencyMs,
        stopReason: env.stop_reason ?? env.subtype ?? null,
      });

      return {
        text,
        structured: env.structured_output,
        stopReason: env.stop_reason ?? env.subtype ?? null,
        provider: 'claude_cli',
        costUsd: env.total_cost_usd,
      };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  },
};

/**
 * End-to-end check, exposed so the user can confirm the wiring rather than discovering a
 * problem mid-draft.
 *
 * It verifies the part that documentation is least explicit about: that content on stdin
 * actually reaches the model. If stdin were ignored, ordinary generation would not fail —
 * it would quietly answer the wrong question, which is far worse than an error.
 */
export async function selfTest(): Promise<{ ok: boolean; detail: string }> {
  const c = await probe();
  if (!c) return { ok: false, detail: failure ?? 'The Claude Code CLI is not installed.' };

  try {
    const res = await claudeCliBackend.generate({
      purpose: 'answer_draft',
      system: 'You are being tested. Reply with exactly the word the user gives you, nothing else.',
      user: 'The word is: haddock. Reply with that word only.',
    });
    const ok = /haddock/i.test(res.text);
    return {
      ok,
      detail: ok
        ? `Working. ${claudeCliBackend.describe()}`
        : `The CLI answered, but did not see the input sent to it. It replied: ${res.text.slice(0, 120) || '(nothing)'}`,
    };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}
