import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MODELS } from '../src/infra/llm/client';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * The API backend, which had no test file at all.
 *
 * Its last bug was a silent drop: documents were filtered by a `.pdf` filename suffix, while
 * the caller selects a document by MIME type and the stored name carries no extension when
 * the upload had none — so a real PDF named `resume` was discarded here and the model was
 * asked to extract a file it never saw. That is the exact failure the backend seam exists to
 * end, and it happened on this path only, so the CLI path's tests could not have caught it.
 *
 * The SDK is mocked because the alternative is a live billed request. What is under test is
 * everything this file decides before the request goes out: which model, what is attached,
 * which tools are granted, and how a failure is classified.
 */

const h = vi.hoisted(() => ({
  sent: [] as Array<Record<string, unknown>>,
  reply: {
    content: [{ type: 'text', text: 'answered' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 5 },
  } as Record<string, unknown>,
  hasKey: true,
  /** What the live key check runs into, and how many times it has been run. */
  probeFails: null as { status?: number; message: string } | null,
  probes: 0,
  /** What a real generate runs into. The API answers 401 for a key it will not take. */
  createFails: null as { status?: number; message: string } | null,
}));

vi.mock('../src/infra/llm/client', async (importOriginal) => {
  const real = await importOriginal<object>();
  return {
    ...real,
    hasApiKey: () => h.hasKey,
    getClient: () => ({
      messages: {
        create: (body: Record<string, unknown>) => {
          h.sent.push(body);
          if (h.createFails) return Promise.reject(Object.assign(new Error('x'), h.createFails));
          return Promise.resolve(h.reply);
        },
      },
      // GET /v1/models: authenticated, not billed, and the smallest thing that can tell a
      // live key from a dead one.
      models: {
        list: () => {
          h.probes += 1;
          if (h.probeFails) return Promise.reject(Object.assign(new Error('x'), h.probeFails));
          return Promise.resolve({ data: [] });
        },
      },
    }),
  };
});

/**
 * The suite pins LLM_PROVIDER=none (vitest.setup.ts), which is right everywhere else and
 * would make every question in this file answer itself: the resolver short-circuits before
 * it ever looks at a key. This file is about what the API path does when it IS the path, so
 * only that one field is overridden — `paths` and the rest stay real, and the override is
 * local to this test file.
 */
vi.mock('../src/config', async (importOriginal) => {
  const real = await importOriginal<{ config: { llm: Record<string, unknown> } }>();
  return {
    ...real,
    config: { ...real.config, llm: { ...real.config.llm, provider: 'api' } },
  };
});

const { apiBackend, apiKeyRejected } = await import('../src/infra/llm/apiBackend');
const { NoModelAccessError } = await import('../src/infra/llm/provider');
const { describeAccess, modelAccessLikely, resetBackend } = await import('../src/infra/llm');
const { runMigrations } = await import('../src/infra/db/migrate');

let dir: string;

beforeAll(() => {
  // A generated answer is written to the llm_call ledger, so the tables have to exist.
  runMigrations();
});

beforeEach(() => {
  h.sent = [];
  h.hasKey = true;
  h.probeFails = null;
  h.createFails = null;
  h.probes = 0;
  // Drops both the cached backend choice and the cached verdict on the key, which are
  // process-wide and would otherwise leak the previous test's 401 into this one.
  resetBackend();
  dir = mkdtempSync(path.join(tmpdir(), 'ia-apibackend-'));
});

/** A file with no extension at all — the shape that used to be dropped. */
function storedPdf(name: string): string {
  const file = path.join(dir, name);
  writeFileSync(file, Buffer.from('%PDF-1.4 fake'), { mode: 0o600 });
  return file;
}

describe('attaching a document', () => {
  it('attaches a PDF whose stored name has no extension', () => {
    // The regression: the upload route names the stored file by ULID, so a resume uploaded
    // without an extension has none. Filtering on `.pdf` dropped it silently.
    return apiBackend
      .generate({
        purpose: 'resume_extraction',
        system: 's',
        user: 'u',
        documents: [storedPdf('01JABCDEF')],
      })
      .then(() => {
        const content = (h.sent[0]?.['messages'] as Array<{ content: unknown }>)[0]?.content;
        expect(Array.isArray(content)).toBe(true);
        const blocks = content as Array<{ type: string }>;
        expect(blocks.filter((b) => b.type === 'document')).toHaveLength(1);
      });
  });

  it('sends the prompt as plain text when there is nothing to attach', () => {
    return apiBackend
      .generate({ purpose: 'answer_draft', system: 's', user: 'the prompt' })
      .then(() => {
        const content = (h.sent[0]?.['messages'] as Array<{ content: unknown }>)[0]?.content;
        expect(content).toBe('the prompt');
      });
  });

  it('puts the text after the documents, so the model reads the file first', () => {
    return apiBackend
      .generate({
        purpose: 'resume_extraction',
        system: 's',
        user: 'u',
        documents: [storedPdf('a')],
      })
      .then(() => {
        const blocks = (h.sent[0]?.['messages'] as Array<{ content: Array<{ type: string }> }>)[0]
          ?.content;
        expect(blocks?.[blocks.length - 1]?.type).toBe('text');
      });
  });
});

describe('what the request asks for', () => {
  it('grants web search only when the caller asked for it', () => {
    return apiBackend
      .generate({ purpose: 'web_discovery', system: 's', user: 'u', webSearch: true })
      .then(() => {
        const tools = h.sent[0]?.['tools'] as Array<{ type: string }> | undefined;
        expect(tools?.[0]?.type).toBe('web_search_20250305');
      });
  });

  it('grants nothing on an ordinary draft', () => {
    // The property the default protects, and the one no test held.
    return apiBackend.generate({ purpose: 'answer_draft', system: 's', user: 'u' }).then(() => {
      expect(h.sent[0]?.['tools']).toBeUndefined();
    });
  });

  it('sends the cheap model for discovery and the extraction model for a resume', async () => {
    // Discovery is judgment-light by design: the model names candidate URLs and this process
    // fetches and parses every one of them.
    //
    // THE VALUES, not their inequality. This asserted only that the two differed, and three of
    // the four entries in MODELS are the same string today — so the mapping could be swapped
    // end for end, sending the expensive model to discovery and the cheap one to a resume, and
    // the two would still differ and the test would still pass.
    await apiBackend.generate({ purpose: 'web_discovery', system: 's', user: 'u' });
    await apiBackend.generate({ purpose: 'resume_extraction', system: 's', user: 'u' });

    expect(h.sent[0]?.['model']).toBe(MODELS.classification);
    expect(h.sent[1]?.['model']).toBe(MODELS.extraction);
  });

  it("sends the verification model for the two checks that read somebody else's work", async () => {
    // `fact_guard` and `style_critic` are the passes that judge a draft, and both were mapped
    // by a `case` with nothing asserting where it pointed.
    await apiBackend.generate({ purpose: 'fact_guard', system: 's', user: 'u' });
    await apiBackend.generate({ purpose: 'field_classification', system: 's', user: 'u' });

    expect(h.sent[0]?.['model']).toBe(MODELS.verification);
    expect(h.sent[1]?.['model']).toBe(MODELS.classification);
  });
});

describe('when there is no key', () => {
  it('says so as a setup problem, not as something that broke', () => {
    // `isSetupProblem` decides between "go and configure something" and "something went
    // wrong", and the callers pick their wording from it.
    h.hasKey = false;
    return apiBackend.generate({ purpose: 'answer_draft', system: 's', user: 'u' }).then(
      () => expect.unreachable('should have refused'),
      (err: unknown) => {
        expect(err).toBeInstanceOf(NoModelAccessError);
        expect((err as InstanceType<typeof NoModelAccessError>).reason).toBe('no_key');
        expect((err as InstanceType<typeof NoModelAccessError>).isSetupProblem).toBe(true);
      },
    );
  });

  it('does not send a request at all', () => {
    h.hasKey = false;
    return apiBackend
      .generate({ purpose: 'answer_draft', system: 's', user: 'u' })
      .catch(() => undefined)
      .then(() => {
        expect(h.sent).toHaveLength(0);
      });
  });
});

/**
 * Whether the key WORKS, which was never the question this backend asked.
 *
 * `available()` was `hasApiKey()` — the presence of a string in the environment. A revoked
 * key satisfies that, and so does one pasted a few characters short: GET /api/model-access
 * answered that model access was available, the Draft button was offered, and the first real
 * call was where the user found out. Under `auto` a dead key is picked up as the fallback and
 * then reported as working access.
 *
 * The mirror direction is pinned just as hard, because it is the one an over-strict fix
 * breaks: a laptop with no network, a 429, a 500 at the other end. None of those are the
 * key's fault, and calling them one sends someone to reissue a key that was fine.
 */
describe('proving the key rather than trusting that one is set', () => {
  const draft = { purpose: 'answer_draft' as const, system: 's', user: 'u' };

  it('does not report a revoked key as working model access', async () => {
    h.probeFails = { status: 401, message: 'invalid x-api-key' };
    expect(await apiBackend.available()).toBe(false);
    expect(apiKeyRejected()).toBe(true);
  });

  it('names that state, instead of reporting it as no key at all', async () => {
    // "No model access configured." in front of someone looking straight at the
    // ANTHROPIC_API_KEY line they filled in reads as the app failing to notice it.
    h.probeFails = { status: 401, message: 'invalid x-api-key' };
    const access = await describeAccess();
    expect(access.available).toBe(false);
    expect(access.description).toMatch(/ANTHROPIC_API_KEY/);
    expect(access.description).toMatch(/rejected/i);
  });

  it('reports a key that works as working, which is the direction that must not break', async () => {
    expect(await apiBackend.available()).toBe(true);
    const access = await describeAccess();
    expect(access.available).toBe(true);
    expect(access.provider).toBe('api');
  });

  for (const [what, failure] of [
    ['a machine with no network', { message: 'getaddrinfo ENOTFOUND api.anthropic.com' }],
    ['a rate-limited key, which is a working key', { status: 429, message: 'slow down' }],
    ['an outage at the other end', { status: 500, message: 'internal server error' }],
  ] as Array<[string, { status?: number; message: string }]>) {
    it(`does not call the key bad because of ${what}`, async () => {
      h.probeFails = failure;
      expect(await apiBackend.available()).toBe(true);
      expect(apiKeyRejected()).toBe(false);
    });
  }

  it('checks once and remembers, and forgets again when asked to', async () => {
    // This runs behind a settings screen and behind every draft; it cannot be a round trip
    // each time. It also cannot be permanent, or a corrected key needs a restart — the
    // Test button calls resetBackend() for exactly that.
    await apiBackend.available();
    await apiBackend.available();
    expect(h.probes).toBe(1);

    resetBackend();
    await apiBackend.available();
    expect(h.probes).toBe(2);
  });

  it('does not go looking when there is no key to check', async () => {
    h.hasKey = false;
    expect(await apiBackend.available()).toBe(false);
    expect(h.probes).toBe(0);
  });

  it('stops calling drafting likely once the key is known bad', async () => {
    // `modelAccessLikely` is sync and deliberately optimistic — it only gates whether a
    // button is offered. Optimism has one limit: a key the API has already answered 401 for
    // is not a maybe.
    expect(modelAccessLikely()).toBe(true);
    h.probeFails = { status: 401, message: 'invalid x-api-key' };
    await apiBackend.available();
    expect(modelAccessLikely()).toBe(false);
  });

  /**
   * The other half: a key can be revoked between the check and the draft, and a cached
   * backend skips the check entirely. Left alone the user got the SDK's own
   * `AuthenticationError: 401 {"type":"error",...}` rendered into the answer pane.
   */
  it('turns a 401 on a real call into a sentence, and marks it a setup problem', async () => {
    h.createFails = { status: 401, message: '401 {"type":"error","error":{}}' };
    const err = await apiBackend
      .generate(draft)
      .then(() => null)
      .catch((e: unknown) => e as InstanceType<typeof NoModelAccessError>);

    expect(err).toBeInstanceOf(NoModelAccessError);
    expect(err!.reason).toBe('no_key');
    expect(err!.isSetupProblem).toBe(true);
    expect(err!.message).toMatch(/rejected/i);
    expect(err!.message).toMatch(/console\.anthropic\.com/);
  });

  it('latches unavailable after that, so the seam stops choosing it', async () => {
    // The same latch the CLI backend keeps for a signed-out install, and for the same
    // reason: until `available()` says false, `auto` goes on shadowing whatever else works.
    expect(await apiBackend.available()).toBe(true);
    h.createFails = { status: 401, message: 'nope' };
    await apiBackend.generate(draft).catch(() => undefined);
    expect(await apiBackend.available()).toBe(false);
  });

  it('leaves an overload alone — it is not the key, and it comes back on its own', async () => {
    h.createFails = { status: 529, message: 'overloaded_error' };
    const err = await apiBackend
      .generate(draft)
      .then(() => null)
      .catch((e: unknown) => e);

    // Passed through as itself: turning it into "your key was rejected" would be a wrong
    // diagnosis with a confident remedy.
    expect(err).not.toBeInstanceOf(NoModelAccessError);
    expect(apiKeyRejected()).toBe(false);
    expect(await apiBackend.available()).toBe(true);
  });
});
