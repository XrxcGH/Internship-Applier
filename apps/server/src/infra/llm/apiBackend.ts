/**
 * The Anthropic API as a model backend — the ANTHROPIC_API_KEY path.
 *
 * Wraps the existing SDK client in the same `Backend` interface the CLI uses, so nothing
 * upstream has to know which one it is talking to.
 */
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { logger } from '../logger';
import { getClient, hasApiKey, MODELS, recordCall } from './client';
import {
  NoModelAccessError,
  type Backend,
  type GenerateRequest,
  type GenerateResult,
} from './provider';

/**
 * The user turn, with any requested documents attached.
 *
 * `documents` names files on disk because that is the only form the CLI backend can use —
 * it has no way to accept bytes, so it is granted Read on the file and opens it itself.
 * This path has the opposite constraint: the API takes a base64 block and cannot read a
 * path. Both halves have to exist for the seam to mean anything, and while this one did
 * not, a request carrying a PDF reached the API with the field silently dropped and the
 * model was asked to extract a resume it had never been shown.
 *
 * Every path in `req.documents` is a PDF by the seam's contract (see provider.ts) — only
 * PDFs are attached; everything else is extracted to text upstream. So ATTACH THEM ALL,
 * matching the CLI backend, which passes every path through by name. The earlier version
 * filtered by a `.pdf` filename suffix instead, but the caller selects a document by its
 * MIME type and the stored name carries no extension when the upload had none — so a real
 * PDF named `resume` was silently dropped here and the model was asked to extract a file
 * it never saw, exactly the failure this seam existed to end, and only on the API path.
 */
async function userContent(req: GenerateRequest): Promise<string | ContentBlock[]> {
  const documents = req.documents ?? [];
  if (documents.length === 0) return req.user;

  const blocks: ContentBlock[] = [];
  for (const file of documents) {
    blocks.push({
      type: 'document',
      source: {
        type: 'base64',
        media_type: 'application/pdf',
        data: (await readFile(file)).toString('base64'),
      },
    });
  }
  blocks.push({ type: 'text', text: req.user });
  return blocks;
}

type ContentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'document';
      source: { type: 'base64'; media_type: 'application/pdf'; data: string };
    };

/** Purposes map to model tiers per docs/02. */
function modelFor(purpose: GenerateRequest['purpose']): string {
  switch (purpose) {
    case 'resume_extraction':
    case 'requirement_extraction':
      return MODELS.extraction;
    // Web discovery is judgment-light on purpose: the model's only job is to run searches
    // and hand back candidate URLs, and every page it names is then fetched and parsed by
    // this process's own deterministic readers. A bad candidate costs one wasted fetch,
    // which the run report counts out loud — not a wrong fact in the queue. The cheap
    // model does that fine, and a discovery run may make this call often.
    case 'web_discovery':
    case 'field_classification':
      return MODELS.classification;
    case 'fact_guard':
    case 'style_critic':
      return MODELS.verification;
    default:
      return MODELS.drafting;
  }
}

// ──────────────────────────────────────────────────────────────── proving the key

/**
 * What a live check found, cached for the life of the process.
 *
 * `available()` used to be `hasApiKey()`, which is the PRESENCE of a string in the
 * environment and nothing more. A key that had been revoked, or pasted one character short,
 * satisfies that completely: GET /api/model-access answered "Anthropic API key (billed per
 * token)", the Draft button was offered, and the first real call — after the profile, after
 * the approval, at the moment the user wanted an answer — was where they found out. Under
 * `auto` it is worse, because a dead key is picked up as the fallback and then reported as
 * working model access.
 *
 * So the key gets proved the way the CLI already is: with the smallest call that needs
 * credentials. `models.list` is a GET, it is not billed, and it answers 401 for a key the
 * API will not take.
 *
 * FOUR STATES, NOT TWO, AND THAT IS THE WHOLE POINT. Only an authentication answer is proof
 * the key is bad. A laptop on a train, a proxy refusing the connection, a 429, a 500 at
 * Anthropic — none of those are the key's fault, and reporting them as one sends someone to
 * reissue a key that was fine while hiding a backend that would have worked again a minute
 * later. `unreachable` is therefore treated as available: the real call still tells the
 * truth if the key is genuinely dead, and it now latches this the moment it does.
 */
type KeyProof = 'unproved' | 'working' | 'rejected' | 'unreachable';
let keyProof: KeyProof = 'unproved';

/** 401/403 are the two answers that are about the KEY. Everything else is about the trip. */
function isRejection(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  return status === 401 || status === 403;
}

/** Forget the live check, so a corrected key takes effect without restarting the server. */
export function resetApiProbe(): void {
  keyProof = 'unproved';
}

/**
 * Whether the API has told us, in so many words, that it will not take this key.
 *
 * Read by `describeAccess`, which otherwise reports a rejected key as "No model access
 * configured." — true in effect, and useless to someone looking straight at a key they set.
 */
export function apiKeyRejected(): boolean {
  return keyProof === 'rejected';
}

/** What to tell someone the API refused. Written for a person, not for a log line. */
const KEY_REJECTED_MESSAGE =
  'The Anthropic API rejected ANTHROPIC_API_KEY. A key that has been revoked, or copied ' +
  'without its last few characters, looks exactly like this from here.\n\n' +
  'Issue a new key at console.anthropic.com, put it in the .env file at the root of this ' +
  'project, and restart the server.';

async function proveKey(): Promise<boolean> {
  if (!hasApiKey()) return false;
  if (keyProof !== 'unproved') return keyProof !== 'rejected';

  try {
    // No retries: a key the API will not take is not taken on the second attempt either, and
    // this runs on the path that renders a settings screen. A short ceiling for the same
    // reason — the SDK's own default is minutes.
    await getClient().models.list({ limit: 1 }, { timeout: 10_000, maxRetries: 0 });
    keyProof = 'working';
  } catch (err) {
    keyProof = isRejection(err) ? 'rejected' : 'unreachable';
    if (keyProof === 'rejected') logger.warn('the Anthropic API rejected ANTHROPIC_API_KEY');
    else logger.debug({ err }, 'could not verify ANTHROPIC_API_KEY; assuming it works');
  }
  return keyProof !== 'rejected';
}

/**
 * The other half of proving the key: what a REAL call discovers.
 *
 * A key can be revoked between the probe and the draft, and the probe can be skipped
 * entirely when a cached backend is reused. Left alone, the user got the SDK's own
 * `AuthenticationError: 401 {"type":"error","error":{...}}` rendered into the answer pane —
 * a sentence written for a stack trace, not for someone with a job application open.
 *
 * Latching matters as much as the wording. The CLI backend already does exactly this for a
 * signed-out install, and for the same reason: until `available()` starts saying false, the
 * seam goes on choosing this backend and, under `auto`, goes on shadowing a Claude Code CLI
 * that would have worked. With the latch set, `generate()` in index.ts sees a
 * NoModelAccessError from a backend that has just become unavailable and re-resolves.
 */
async function withKeyLatch<T>(call: Promise<T>): Promise<T> {
  try {
    return await call;
  } catch (err) {
    if (!isRejection(err)) throw err;
    keyProof = 'rejected';
    logger.warn('the Anthropic API rejected ANTHROPIC_API_KEY on a live call');
    throw new NoModelAccessError(KEY_REJECTED_MESSAGE, 'no_key');
  }
}

export const apiBackend: Backend = {
  kind: 'api',

  available(): Promise<boolean> {
    return proveKey();
  },

  describe(): string {
    return hasApiKey() ? 'Anthropic API key (billed per token)' : 'Anthropic API key (not set)';
  },

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    if (!hasApiKey()) {
      throw new NoModelAccessError('No ANTHROPIC_API_KEY is configured.', 'no_key');
    }

    const model = modelFor(req.purpose);
    const started = Date.now();

    const response = await withKeyLatch(
      getClient().messages.create({
        model,
        max_tokens: req.maxTokens ?? 4000,
        system: req.system,
        thinking: { type: 'adaptive' },
        ...(req.schema
          ? {
              output_config: {
                // Resume extraction runs at 'high': it is a one-shot read of a whole document
                // where a missed section is a lost job, and it ran at 'high' before extraction
                // moved onto this seam. The move hardcoded 'medium' for every schema request,
                // silently downgrading it. Bulk, cheaper purposes stay at 'medium'.
                effort:
                  req.purpose === 'resume_extraction' ? ('high' as const) : ('medium' as const),
                format: {
                  type: 'json_schema' as const,
                  schema: req.schema.jsonSchema,
                },
              },
            }
          : {}),
        // The server-side web-search tool: Anthropic's own infrastructure runs the searches,
        // so nothing here scrapes a search engine and no extra key is involved. Capped so a
        // single discovery call cannot run away with the bill — each use is billed.
        ...(req.webSearch
          ? {
              tools: [
                // Eight was a one-pass budget. The discovery prompt asks for a SWEEP across several
                // angles — role, each location, recency, employer kind — and eight searches cannot
                // cover them, so the model spent its budget on the first two angles and stopped.
                { type: 'web_search_20250305' as const, name: 'web_search' as const, max_uses: 16 },
              ],
            }
          : {}),
        messages: [{ role: 'user' as const, content: await userContent(req) }],
      }),
    );

    recordCall({
      purpose: req.purpose,
      model,
      usage: response.usage as never,
      latencyMs: Date.now() - started,
      stopReason: response.stop_reason,
    });

    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('')
      .trim();

    let structured: unknown;
    if (req.schema && text) {
      try {
        structured = JSON.parse(text);
      } catch {
        structured = undefined;
      }
    }

    return { text, structured, stopReason: response.stop_reason, provider: 'api' };
  },
};

/** Convenience for callers that already hold a Zod schema. */
export function jsonSchemaOf(name: string, schema: z.ZodType): GenerateRequest['schema'] {
  return {
    name,
    jsonSchema: z.toJSONSchema(schema, { target: 'draft-2020-12' }) as Record<string, unknown>,
  };
}
