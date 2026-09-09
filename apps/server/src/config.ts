import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { z } from 'zod';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '../../..');

/**
 * Loopback, and nothing else.
 *
 * `SERVER_HOST` was a bare `z.string()`. Putting `SERVER_HOST=0.0.0.0` in .env bound the API
 * to every interface on the machine, and index.ts went on printing `server listening
 * (loopback only)` over the top of it — a line that had never once checked what it asserted.
 * docs/10 states the bind as an invariant ("The local API binds `127.0.0.1` only, never
 * `0.0.0.0`"), so the choice was to check the value or to stop claiming it. Checked: the
 * claim is the one worth keeping, and binding wider buys nothing anyway. The `onRequest`
 * hook in app.ts already answers 403 to any connection that did not arrive from loopback, so
 * a 0.0.0.0 bind produces a port the LAN can reach and cannot use. All that is left of it is
 * the exposure.
 *
 * Accepted, because refusing any of these would be a lie in the other direction:
 *   - the whole 127.0.0.0/8 block, not just 127.0.0.1 — 127.0.0.2 is as loopback as .1;
 *   - `localhost`, which is what a person types;
 *   - `::1` and `::ffff:127.0.0.1`, the IPv6 spellings of the same interface.
 * Refused: `0.0.0.0`, `::`, `*`, a LAN or public address, a hostname, and the empty string —
 * `SERVER_HOST=` in .env leaves Node listening on every interface, which is the accident this
 * exists to stop and the one that looks the most like a typo.
 *
 * This fails closed. An odd-but-genuine spelling — `127.1`, or a bracketed `[::1]`, which
 * Node would try to resolve as a name and fail on anyway — is refused at startup with a
 * message naming the forms that work, rather than parsed loosely. A refusal here costs one
 * clear error; a value waved through costs a LAN-visible port.
 */
function isLoopbackHost(value: string): boolean {
  const host = value.trim().toLowerCase();
  if (host === 'localhost' || host === '::1' || host === '::ffff:127.0.0.1') return true;

  const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!octets) return false;
  const parts = octets.slice(1).map(Number);
  return parts.every((n) => n <= 255) && parts[0] === 127;
}

/**
 * Exported so a test can assert the refusal on the schema the app actually parses with.
 *
 * A bad value here reaches `process.exit(1)` below, which in a test worker would take the
 * runner down with it, and a test that re-typed the rule into its own `z.object` would prove
 * only that zod works — the same trap logger.test.ts describes at length.
 */
export const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  SERVER_HOST: z
    .string()
    .default('127.0.0.1')
    .refine(isLoopbackHost, {
      message:
        'SERVER_HOST must be a loopback address: 127.0.0.1 (the default), any 127.x.x.x, ' +
        'localhost, or ::1. This server binds loopback only — see docs/10-security-privacy.md.',
    }),
  SERVER_PORT: z.coerce.number().int().positive().default(8787),
  WEB_PORT: z.coerce.number().int().positive().default(5173),
  /**
   * Where the SQLite file goes, if it must live somewhere other than DATA_DIR. Leave it
   * unset — an explicit value here is the one way to put the database outside the root
   * everything else is under. See `paths` below.
   */
  DATABASE_PATH: z.string().optional(),
  /** The single root for everything this app writes. Tests point it at a temp directory. */
  DATA_DIR: z.string().default('./data'),

  /**
   * Where model calls go. See docs/14-model-access.md.
   *
   * `auto`      — use the Claude Code CLI if it is installed, else an API key, else
   *               run with no model at all (everything except drafting and resume
   *               extraction still works).
   * `claude_cli` — spawn the user's own `claude` binary. Their subscription, their
   *               credentials; this process never sees a token.
   * `api`       — ANTHROPIC_API_KEY against the Anthropic API.
   * `none`      — refuse model calls outright, with a clear message.
   */
  LLM_PROVIDER: z.enum(['auto', 'claude_cli', 'api', 'none']).default('auto'),
  /** Override if the binary is not on PATH. */
  CLAUDE_CLI_PATH: z.string().optional(),
  /** Per-call ceiling. A hung CLI must not wedge a request forever. */
  CLAUDE_CLI_TIMEOUT_MS: z.coerce.number().int().positive().default(180_000),
});

/**
 * Load .env before reading the environment.
 *
 * Without this, every variable documented in .env.example was silently ignored: the file
 * existed, the docs described it, and nothing read it. A setting that appears to work and
 * does not is worse than one that is missing.
 *
 * Real environment variables still win, which is what makes CI and one-off overrides work.
 */
const ENV_FILE = path.join(REPO_ROOT, '.env');
// Never in tests. `loadEnvFile` does not override variables already set, so the suite's
// isolation would survive anyway, but a hermetic run should not depend on that or on
// what a particular developer happens to keep in their .env.
if (process.env['NODE_ENV'] !== 'test' && existsSync(ENV_FILE)) {
  try {
    process.loadEnvFile(ENV_FILE);
  } catch {
    console.warn('Found a .env file but could not read it; using the environment as-is.');
  }
}

const parsed = Env.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:', z.treeifyError(parsed.error));
  process.exit(1);
}

const env = parsed.data;

/**
 * The one directory everything is written under. A guard rather than a convenience: see
 * the comment on `paths` below for what a half-isolated version of this cost.
 */
const DATA_DIR = path.resolve(REPO_ROOT, env.DATA_DIR);

export const config = {
  env: env.NODE_ENV,
  isDev: env.NODE_ENV === 'development',
  isTest: env.NODE_ENV === 'test',
  logLevel: env.LOG_LEVEL,

  server: {
    /**
     * Loopback only, and now checked rather than asserted — see `isLoopbackHost` above.
     * Startup refuses anything else, which is what makes index.ts's "(loopback only)" line
     * and the docs/10 invariant true statements about the running process.
     */
    host: env.SERVER_HOST,
    port: env.SERVER_PORT,
  },

  web: {
    origin: `http://127.0.0.1:${env.WEB_PORT}`,
  },

  llm: {
    provider: env.LLM_PROVIDER,
    cliPath: env.CLAUDE_CLI_PATH,
    cliTimeoutMs: env.CLAUDE_CLI_TIMEOUT_MS,
  },

  /**
   * Everything the app writes lives under ONE root, and every path below derives from it.
   *
   * This was not always true, and the consequence was severe: the test suite pointed
   * DATABASE_PATH at a temp file while `resumes`, `artifacts`, `browser-profile` and the
   * master key stayed hardcoded to the repository, so `npm test` deleted the real ones
   * through the privacy tests. One root means isolating the tests is a single variable
   * and cannot be half-done.
   *
   * The database was the last path still holding out. It came from its own variable with
   * its own default, so moving DATA_DIR to an encrypted volume moved the resumes and the
   * master key there and left the database — every posting, answer and application — sitting
   * in the repository, which is precisely the half-isolation this comment says cannot
   * happen. Setting DATABASE_PATH still moves it on purpose; not setting it can no longer
   * move it by accident.
   *
   * `migrations` is the one path that does not derive from the root, and it is read-only.
   */
  paths: {
    root: REPO_ROOT,
    data: DATA_DIR,
    database: env.DATABASE_PATH
      ? path.resolve(REPO_ROOT, env.DATABASE_PATH)
      : path.resolve(DATA_DIR, 'app.db'),
    resumes: path.resolve(DATA_DIR, 'resumes'),
    artifacts: path.resolve(DATA_DIR, 'artifacts'),
    browserProfile: path.resolve(DATA_DIR, 'browser-profile'),
    /**
     * Scratch space for the CLI backend, under the root rather than in the OS temp directory.
     *
     * The prompt handed to the Claude Code CLI is written to a file, and for drafting that
     * prompt carries the user's name, their city, the evidence facts, and up to three
     * DECRYPTED writing samples. It went to `%TEMP%/ia-claude-*`, cleaned by a `finally` —
     * so a process killed mid-generation stranded it, outside the one place "delete
     * everything" looks. A wipe that promises no copy is kept anywhere would have left the
     * user's own writing sitting in plaintext in a world-readable temp directory.
     */
    scratch: path.resolve(DATA_DIR, 'scratch'),
    masterKey: path.resolve(DATA_DIR, '.master.key'),
    migrations: path.resolve(REPO_ROOT, 'apps/server/drizzle'),
  },

  /**
   * Random per-run token required in X-App-Token on every route. Stops other local
   * processes and stray browser pages from driving the API. Not a security boundary
   * against a compromised machine — see docs/10-security-privacy.md § Threat model.
   */
  appToken: crypto.randomUUID(),
} as const;

export type Config = typeof config;
