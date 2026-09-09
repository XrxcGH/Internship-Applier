/**
 * Where model calls go — see docs/14-model-access.md.
 *
 * Two backends sit behind one interface:
 *
 *   `claude_cli` spawns the user's own installed `claude` binary. The CLI handles its
 *   own authentication, so this process never reads, stores, or transmits a credential.
 *   That distinction is the whole point: Anthropic prohibits using a Claude subscription's
 *   OAuth token inside another product, and this design has no way to do that even by
 *   accident. There is no code path here that opens ~/.claude.
 *
 *   `api` uses ANTHROPIC_API_KEY against the Anthropic API, billed per token.
 *
 * Everything that is not drafting or resume extraction works with NEITHER. Discovery,
 * matching, eligibility, FactGuard, StyleCritic, and the tell-scrub are all deterministic.
 * A missing model is a reduced tool, not a broken one, and `describeAccess` says so.
 */
import type { LlmPurpose } from './client';

export type ProviderKind = 'api' | 'claude_cli' | 'none';

export interface GenerateRequest {
  purpose: LlmPurpose;
  /**
   * Instructions. This must stand on its own: on the CLI path it REPLACES Claude Code's
   * default system prompt rather than adding to it (see claudeCli.ts), which is deliberate
   * — the default frames the model as a coding agent in a repository, the wrong voice for a
   * job application. A prompt written as a fragment to be appended to something gets no
   * something.
   */
  system: string;
  user: string;
  maxTokens?: number;
  /** Ask for a validated object rather than prose. */
  schema?: { name: string; jsonSchema: Record<string, unknown> };
  /** Absolute paths to documents the model must read (resume PDFs). */
  documents?: string[];
  /**
   * Let the model search the live web while it answers.
   *
   * This is discovery's Tier B (docs/04): the model runs searches and returns candidate
   * posting URLs, and everything it names is then fetched by THIS process through the
   * polite, robots-respecting fetcher — the model's word is never stored as a fact. On the
   * CLI path this grants the WebSearch tool; on the API path it attaches the server-side
   * web-search tool. Anthropic's infrastructure does the searching either way, so no search
   * engine is scraped and no extra key is needed.
   */
  webSearch?: boolean;
}

export interface GenerateResult {
  text: string;
  /** Present only when `schema` was requested and the backend returned an object. */
  structured?: unknown;
  stopReason: string | null;
  provider: ProviderKind;
  /** The CLI reports its own cost; the API path computes it from usage. */
  costUsd?: number;
}

/** Thrown when no backend can serve the request. The message is shown to the user. */
/**
 * Why a model call could not be made — and it is NOT always "no access".
 *
 * One class carried seven different situations, and callers could only re-render its message
 * or fall back to advice about signing in. The web-search source did the latter, so a CLI run
 * that TIMED OUT told the student to sign in to a CLI they were already signed in to, and
 * said the live web "is not searched" without saying that the search had in fact started and
 * run out of time. The advice named a cause that was not the cause and prescribed an action
 * that would change nothing.
 *
 *   `unavailable`     no CLI on PATH and no key — the genuine no-access case
 *   `not_signed_in`   the CLI is installed and has no credentials
 *   `no_key`          the API backend was selected with no ANTHROPIC_API_KEY, or with one
 *                     the API answered 401 for — both are "the key needs sorting out"
 *   `usage_limit`     the subscription's cap was reached; it comes back on its own
 *   `timed_out`       the call was still running when the per-call ceiling expired
 *   `cli_error`       the CLI exited non-zero, reported an error of its own, or stopped
 *                     without producing a single byte to say why
 *   `unreadable`      it answered in a shape this app could not parse
 *
 * The first three are the ones where "set up model access" is the right thing to say. The
 * rest are failures of a working setup, and telling someone to fix their setup is wrong.
 */
export type NoModelAccessReason =
  | 'unavailable'
  | 'not_signed_in'
  | 'no_key'
  | 'usage_limit'
  | 'timed_out'
  | 'cli_error'
  | 'unreadable';

export class NoModelAccessError extends Error {
  readonly reason: NoModelAccessReason;

  constructor(message: string, reason: NoModelAccessReason = 'unavailable') {
    super(message);
    this.name = 'NoModelAccessError';
    this.reason = reason;
  }

  /** Whether the fix is "set model access up", as opposed to "something went wrong". */
  get isSetupProblem(): boolean {
    return (
      this.reason === 'unavailable' || this.reason === 'not_signed_in' || this.reason === 'no_key'
    );
  }
}

export interface Backend {
  kind: ProviderKind;
  /** Cheap check. Must not throw. */
  available(): Promise<boolean>;
  generate(req: GenerateRequest): Promise<GenerateResult>;
  /** One sentence for the UI, naming what is and is not available. */
  describe(): string;
}
