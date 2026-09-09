/**
 * robots.txt, and what happens when a host will not hand one over — docs/04 § Politeness.
 *
 * RFC 9309 § 2.3.1 gives three different answers for three different failures, and the
 * fetcher collapsed them into one: anything that was not a 200 fell into the same
 * catch-and-carry-on as a DNS failure, cached an empty disallow set for the life of the
 * process, and read as "nothing here is off limits". A site in a maintenance window served
 * 503 for its robots.txt and had its whole careers section crawled — including, once the
 * maintenance ended, the paths it had been disallowing all along.
 *
 * These run against real local servers rather than a stubbed `fetch`, because the thing
 * under test is what the fetcher does with a status code it was handed, and a stub would be
 * the test asserting its own assumption about how the request is made. Each case gets its
 * own server, so each gets its own origin — the robots cache is keyed by origin and lives
 * for the life of the process.
 */
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { HttpError, politeFetch } from '../src/infra/http/fetcher';

interface Reply {
  status: number;
  body: string;
}

const SERVER_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');

const running: Server[] = [];

afterEach(() => {
  while (running.length > 0) running.pop()?.close();
});

/** A host on a fresh port, so it gets a robots cache entry of its own. */
async function host(reply: (url: string) => Reply): Promise<string> {
  const server = createServer((req, res) => {
    const out = reply(req.url ?? '/');
    res.writeHead(out.status, { 'content-type': 'text/plain' });
    res.end(out.body);
  });
  running.push(server);

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return `http://127.0.0.1:${String(address.port)}`;
}

const page = (url: string): Reply =>
  url === '/robots.txt' ? { status: 404, body: '' } : { status: 200, body: `page ${url}` };

describe('a robots.txt that could not be read', () => {
  /**
   * Every status that means "ask me later", not only the 503 that started this. 429 is in
   * here because it is the one case the status class does not tell you about: it is not a
   * 5xx, and grouping it by its class would read a rate limit as the site having said
   * nothing at all.
   */
  it.each([[429], [500], [502], [503]])(
    'refuses the fetch on %i, and says the file was unreadable rather than inventing a rule',
    async (status) => {
      const origin = await host((url) =>
        url === '/robots.txt' ? { status, body: 'maintenance' } : page(url),
      );

      const err = await politeFetch(`${origin}/careers/1`).then(
        () => null,
        (e: unknown) => e as HttpError,
      );

      expect(err).toBeInstanceOf(HttpError);
      expect(err?.status).toBe(403);
      // The refusal is shown to the user on the source-health line, so "robots.txt
      // disallows /careers/" would be a false claim about a file nobody managed to read.
      expect(err?.message).toMatch(/robots\.txt could not be read/);
      expect(err?.message).toContain(String(status));
      expect(err?.message).not.toMatch(/disallows/);
    },
  );

  it.each([[404], [403], [410]])(
    'treats %i as the site having said nothing, and fetches',
    async (status) => {
      // Absent is not the same as unavailable. A site with no robots.txt to serve has not
      // restricted anything, and refusing here would turn every board without one into a
      // dead source.
      const origin = await host((url) =>
        url === '/robots.txt' ? { status, body: '' } : page(url),
      );
      expect(await politeFetch(`${origin}/careers/1`)).toBe('page /careers/1');
    },
  );
});

describe('a robots.txt that states a rule', () => {
  it('obeys the disallowed path and leaves the rest of the site alone', async () => {
    const origin = await host((url) =>
      url === '/robots.txt'
        ? { status: 200, body: 'User-agent: *\nDisallow: /careers/\n' }
        : page(url),
    );

    const err = await politeFetch(`${origin}/careers/x`).then(
      () => null,
      (e: unknown) => e as HttpError,
    );
    expect(err?.status).toBe(403);
    expect(err?.message).toMatch(/disallows/);

    // A rule that refused everything would be indistinguishable from a broken parse.
    expect(await politeFetch(`${origin}/jobs/x`)).toBe('page /jobs/x');
  });
});

describe('a request that carries a body', () => {
  /**
   * `jsonBody` exists for exactly one endpoint family: Workday's board API answers only to
   * POST, with the same query every visitor's browser sends to render the company's own
   * careers page. Two properties matter and both are held here.
   */
  it('sends a POST with the JSON body and the right content type', async () => {
    let seen: { method?: string; type?: string; body?: string } = {};
    const server = createServer((req, res) => {
      if (req.url === '/robots.txt') {
        res.writeHead(404).end();
        return;
      }
      let chunks = '';
      req.on('data', (c: Buffer) => (chunks += c.toString()));
      req.on('end', () => {
        seen = { method: req.method, type: req.headers['content-type'], body: chunks };
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
      });
    });
    running.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    const origin = `http://127.0.0.1:${String(address.port)}`;

    await politeFetch(`${origin}/wday/cxs/acme/External/jobs`, {
      isDocumentedApi: true,
      jsonBody: { appliedFacets: {}, limit: 1, offset: 0, searchText: 'intern' },
    });
    expect(seen.method).toBe('POST');
    expect(seen.type).toBe('application/json');
    expect(JSON.parse(seen.body ?? '{}')).toMatchObject({ searchText: 'intern' });
  });

  /**
   * The response cache is keyed by URL alone. Two different queries POST to one URL, so a
   * cached answer would hand the second query the first query's postings; a body request
   * must neither read the cache nor write it.
   */
  it('never serves a POST from the cache a GET filled, and never fills it', async () => {
    let calls = 0;
    const origin = await host((url) => {
      if (url === '/robots.txt') return { status: 404, body: '' };
      calls++;
      return { status: 200, body: `answer ${String(calls)}` };
    });

    // A GET primes the cache; the POSTs must not see it, and must each hit the server.
    expect(await politeFetch(`${origin}/jobs`, { isDocumentedApi: true })).toBe('answer 1');
    expect(
      await politeFetch(`${origin}/jobs`, { isDocumentedApi: true, jsonBody: { offset: 0 } }),
    ).toBe('answer 2');
    expect(
      await politeFetch(`${origin}/jobs`, { isDocumentedApi: true, jsonBody: { offset: 20 } }),
    ).toBe('answer 3');
    // And the POSTs must not have poisoned the cache for the next GET.
    expect(await politeFetch(`${origin}/jobs`, { isDocumentedApi: true })).toBe('answer 1');
  });
});

/**
 * Where a redirect actually goes is a host nobody checked.
 *
 * Node's fetch defaults to `redirect: 'follow'`, so a 301 to another origin was fetched with
 * that origin's robots.txt never read, its rate-limit bucket never touched, and the sourcing
 * rule never re-applied — every caller checks the string it is about to pass, and nothing
 * re-checked the destination. Aggregator listings are reached through exactly this shape: a
 * short link, or an employer page that bounces to a board.
 */

/** A host that can answer with headers, which the plain helper above cannot. */
async function hostWithHeaders(
  reply: (url: string) => { status: number; body: string; headers?: Record<string, string> },
): Promise<string> {
  const server = createServer((req, res) => {
    const out = reply(req.url ?? '/');
    res.writeHead(out.status, { 'content-type': 'text/plain', ...(out.headers ?? {}) });
    res.end(out.body);
  });
  running.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return `http://127.0.0.1:${String(address.port)}`;
}

/** Records the credential header each request carried, so a leak is visible. */
async function hostRecording(
  received: Array<string | undefined>,
  reply: (url: string) => { status: number; body: string; headers?: Record<string, string> },
): Promise<string> {
  const server = createServer((req, res) => {
    received.push(req.headers['authorization-key'] as string | undefined);
    const out = reply(req.url ?? '/');
    res.writeHead(out.status, { 'content-type': 'text/plain', ...(out.headers ?? {}) });
    res.end(out.body);
  });
  running.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return `http://127.0.0.1:${String(address.port)}`;
}

/** Records the HTTP method of each request, so a replayed POST body is visible. */
async function hostRecordingMethod(
  methods: string[],
  reply: (url: string) => { status: number; body: string; headers?: Record<string, string> },
): Promise<string> {
  const server = createServer((req, res) => {
    methods.push(req.method ?? '');
    const out = reply(req.url ?? '/');
    res.writeHead(out.status, { 'content-type': 'text/plain', ...(out.headers ?? {}) });
    res.end(out.body);
  });
  running.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return `http://127.0.0.1:${String(address.port)}`;
}

describe('following a redirect', () => {
  it('reads the DESTINATION host robots.txt, not the one it started at', async () => {
    // The whole point. The first host allows everything; the second forbids the path the
    // redirect lands on, and that refusal has to be the one that counts.
    const blocked = await hostWithHeaders((url) =>
      url === '/robots.txt'
        ? { status: 200, body: 'User-agent: *\nDisallow: /private' }
        : { status: 200, body: 'secret' },
    );
    const start = await hostWithHeaders((url) =>
      url === '/robots.txt'
        ? { status: 404, body: '' }
        : { status: 301, body: '', headers: { location: `${blocked}/private/job` } },
    );

    await expect(politeFetch(`${start}/go`)).rejects.toThrow(/robots\.txt disallows \/private/);
  });

  it('follows one that is allowed, and answers with the destination body', async () => {
    const target = await hostWithHeaders((url) =>
      url === '/robots.txt' ? { status: 404, body: '' } : { status: 200, body: 'arrived' },
    );
    const start = await hostWithHeaders((url) =>
      url === '/robots.txt'
        ? { status: 404, body: '' }
        : { status: 302, body: '', headers: { location: `${target}/job` } },
    );

    await expect(politeFetch(`${start}/go`)).resolves.toBe('arrived');
  });

  it('resolves a relative Location against the address it came from', async () => {
    // Legal and common, and a naive `new URL(location)` would throw on it.
    const server = await hostWithHeaders((url) =>
      url === '/robots.txt'
        ? { status: 404, body: '' }
        : url === '/go'
          ? { status: 302, body: '', headers: { location: '/landed' } }
          : { status: 200, body: 'relative ok' },
    );
    await expect(politeFetch(`${server}/go`)).resolves.toBe('relative ok');
  });

  // Six sequential round trips against a live local server, each a full re-entry with its
  // own robots read. It fits inside the default timeout alone and not always under the load
  // of the whole suite, which is a property of the harness rather than of the code.
  it('gives up on a cycle rather than recursing forever', { timeout: 20_000 }, async () => {
    const server = await hostWithHeaders((url) =>
      url === '/robots.txt'
        ? { status: 404, body: '' }
        : { status: 302, body: '', headers: { location: '/loop' } },
    );
    // `rps` raised only so the test is not fighting the rate limiter: every hop is a full
    // re-entry and takes its own token, so five hops at the default 1/s is five seconds — the
    // limiter doing its job, and longer than the default test timeout.
    await expect(politeFetch(`${server}/loop`, { rps: 50 })).rejects.toThrow(
      /More than 5 redirects/,
    );
  });

  it('refuses a redirect that lands on a board this tool will not open', async () => {
    // The one check that cannot wait for the recursion: politeFetch does not know its
    // caller's policy, but it does know no path in this app may open these hosts.
    const start = await hostWithHeaders((url) =>
      url === '/robots.txt'
        ? { status: 404, body: '' }
        : {
            status: 301,
            body: '',
            headers: { location: 'https://www.linkedin.com/jobs/view/123' },
          },
    );
    await expect(politeFetch(`${start}/go`)).rejects.toThrow(/does not\s+open/);
  });

  it('says so when a redirect names nowhere to go', async () => {
    const start = await hostWithHeaders((url) =>
      url === '/robots.txt' ? { status: 404, body: '' } : { status: 302, body: '' },
    );
    await expect(politeFetch(`${start}/go`)).rejects.toThrow(/no Location header/);
  });
});

/**
 * Two things a redirect must not carry, and one status that is not a redirect at all.
 */
describe('what survives a redirect, and what does not', () => {
  it('does not mistake a 304 for a redirect', async () => {
    // 304 is a 3xx and is NOT a redirect: it answers a conditional request and carries no
    // Location. The redirect branch caught it first and threw `304 with no Location header`,
    // which made the ETag/Last-Modified handler below it unreachable — every revalidation
    // failed where docs/04 § Politeness says it hits cache. Asserted on a COLD cache, because
    // a warm one is served without a request at all and never reaches this branch.
    const server = await hostWithHeaders((url) =>
      url === '/robots.txt' ? { status: 404, body: '' } : { status: 304, body: '' },
    );
    // The observable difference: it used to fail with the REDIRECT branch's complaint about
    // a missing Location. It now falls through to the ordinary not-ok path, which is correct
    // for a 304 nobody asked a conditional question — a server should not send one — and
    // which leaves the cached-body handler below reachable for the case that matters.
    const err = await politeFetch(`${server}/page`, { rps: 50 }).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).not.toMatch(/no Location header/);
    expect(err?.message).toMatch(/304/);
  });

  it('does not carry the caller’s headers across an origin', async () => {
    // The only caller that sets any is the USAJOBS adapter, and what it sets is the user's own
    // API key — so a 30x from that host handed the key to whatever Location named. Browsers
    // and curl both strip authorization on a cross-origin redirect for this reason.
    const received: Array<string | undefined> = [];
    const target = await hostRecording(received, () => ({ status: 200, body: 'arrived' }));
    const start = await hostWithHeaders((url) =>
      url === '/robots.txt'
        ? { status: 404, body: '' }
        : { status: 302, body: '', headers: { location: `${target}/landed` } },
    );

    await expect(
      politeFetch(`${start}/go`, { rps: 50, headers: { 'authorization-key': 'SECRET' } }),
    ).resolves.toBe('arrived');

    // Every request the destination saw, including its robots.txt read.
    expect(received).not.toContain('SECRET');
    expect(received.filter(Boolean)).toHaveLength(0);
  });

  it('keeps them on a same-origin hop, where the credential belongs', async () => {
    // An API redirecting within itself is the ordinary case, and the key is meant for it.
    const received: Array<string | undefined> = [];
    const server = await hostRecording(received, (url) =>
      url === '/go'
        ? { status: 302, body: '', headers: { location: '/landed' } }
        : { status: 200, body: 'same origin' },
    );
    await expect(
      politeFetch(`${server}/go`, { rps: 50, headers: { 'authorization-key': 'SECRET' } }),
    ).resolves.toBe('same origin');
    expect(received).toContain('SECRET');
  });
});

/**
 * What a redirect drops on its way out of an origin, and what a locally-derived failure costs.
 */
describe('a redirect leaving the origin the caller named', () => {
  it('asks the destination host its own robots.txt, exemption or no exemption', async () => {
    // `isDocumentedApi` says "this exact URL is a vendor's published API", which is a claim
    // about the address the CALLER named — and `fetchJson` sets it by default, so every ATS
    // and aggregator request carries it. Spread through a cross-origin hop it became a claim
    // about wherever Location pointed, and that host's rules were never consulted.
    const blocked = await hostWithHeaders((url) =>
      url === '/robots.txt'
        ? { status: 200, body: 'User-agent: *\nDisallow: /' }
        : { status: 200, body: 'should not be reached' },
    );
    const start = await hostWithHeaders((url) =>
      url === '/robots.txt'
        ? { status: 404, body: '' }
        : { status: 302, body: '', headers: { location: `${blocked}/jobs` } },
    );

    await expect(
      politeFetch(`${start}/api/jobs`, { rps: 50, isDocumentedApi: true }),
    ).rejects.toThrow(/robots\.txt disallows/);
  });

  it('keeps the exemption on a same-origin hop, where the claim still holds', async () => {
    // A documented API redirecting within itself is still that API.
    const server = await hostWithHeaders((url) =>
      url === '/robots.txt'
        ? { status: 200, body: 'User-agent: *\nDisallow: /' }
        : url === '/api/jobs'
          ? { status: 302, body: '', headers: { location: '/api/v2/jobs' } }
          : { status: 200, body: 'vendor api' },
    );
    await expect(
      politeFetch(`${server}/api/jobs`, { rps: 50, isDocumentedApi: true }),
    ).resolves.toBe('vendor api');
  });

  it('does not replay a POST body to wherever a 302 points', async () => {
    // Re-POSTing a query to a host that merely redirected is how one query's answer ends up
    // somewhere nobody asked. Only Workday's board endpoint sends a body at all.
    const methods: string[] = [];
    const target = await hostRecordingMethod(methods, () => ({ status: 200, body: 'arrived' }));
    const start = await hostWithHeaders((url) =>
      url === '/robots.txt'
        ? { status: 404, body: '' }
        : { status: 307, body: '', headers: { location: `${target}/landed` } },
    );

    await expect(
      politeFetch(`${start}/query`, { rps: 50, jsonBody: { searchText: 'intern' } }),
    ).resolves.toBe('arrived');
    expect(methods).not.toContain('POST');
  });

  it('gives up on a cycle without re-running the attempt loop', async () => {
    // The hop-exhaustion error is derived from a counter, not reported by a server, so
    // retrying cannot answer differently — yet it wore status 508 and the retry rule reads the
    // status, so the terminal hop re-fetched five times with backoff sleeps between.
    let requests = 0;
    const server = await hostWithHeaders((url) => {
      if (url === '/robots.txt') return { status: 404, body: '' };
      requests++;
      return { status: 302, body: '', headers: { location: '/loop' } };
    });

    await expect(politeFetch(`${server}/loop`, { rps: 50 })).rejects.toThrow(/More than 5/);
    // Six hops, and no attempt loop on the last one.
    expect(requests).toBeLessThanOrEqual(6);
  });
});

/**
 * How much of an answer this is willing to hold.
 *
 * `res.text()` reads until the connection closes, and the host decides when that is. Nothing
 * capped it, so a page that streams for as long as it likes was read for as long as it likes.
 * The addresses reaching this function are not chosen by a person — a board feed's row, a
 * model's answer to a web search, a link pasted into the manual box — so "a real host would
 * not do that" is not an argument available here.
 */
describe('a response that will not stop arriving', () => {
  /** A host that streams far past any cap, in chunks, the way a real one would. */
  async function endlessHost(totalBytes: number): Promise<string> {
    const server = createServer((req, res) => {
      if ((req.url ?? '') === '/robots.txt') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('User-agent: *\nAllow: /\n');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      const chunk = 'x'.repeat(64 * 1024);
      let sent = 0;
      const pump = (): void => {
        while (sent < totalBytes) {
          sent += chunk.length;
          if (!res.write(chunk)) {
            res.once('drain', pump);
            return;
          }
        }
        res.end();
      };
      pump();
    });
    running.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    return `http://127.0.0.1:${String(address.port)}`;
  }

  it('gives up rather than reading a body without end', async () => {
    const origin = await endlessHost(256 * 1024 * 1024);
    const started = Date.now();

    await expect(politeFetch(`${origin}/huge`, { rps: 100 })).rejects.toThrow(/not a download/);
    // It has to stop at the cap, not read all 256MB and complain afterwards.
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 30_000);

  it('refuses rather than truncating, because half a posting reads as a whole one', async () => {
    // A requirement that decides whether a student is eligible can sit in the half that would
    // have been dropped, and nothing downstream would know a word was missing.
    const origin = await endlessHost(256 * 1024 * 1024);
    await expect(politeFetch(`${origin}/huge`, { rps: 100 })).rejects.toBeInstanceOf(HttpError);
  }, 30_000);

  it('does not disturb a response of an ordinary size', async () => {
    const origin = await host(() => ({ status: 200, body: '<p>A normal posting</p>' }));
    expect(await politeFetch(`${origin}/job/1`, { rps: 100 })).toBe('<p>A normal posting</p>');
  });
});

/**
 * Where a robots.txt is allowed to send this.
 *
 * It used to be a bare `fetch`, and a bare `fetch` follows redirects — Node's default is
 * `redirect: 'follow'`, up to twenty hops, to anywhere. So the one request in the module whose
 * entire purpose is politeness was the one with no private-address check, no aggregator check
 * and no hop cap on its destination. A host answering `301 Location:
 * http://127.0.0.1:11434/api/tags` got this process to issue an attacker-chosen GET inside the
 * user's own network; `Location: https://www.linkedin.com/...` got it to fetch a board this
 * tool refuses to open, from the student's own address.
 *
 * Redirects are still followed — a site moving its robots.txt to `www` is ordinary, and
 * refusing outright would read as a complete disallow and quietly stop reading that employer.
 * They are followed one at a time, with every hop checked.
 */
describe('a robots.txt that redirects', () => {
  /** A host whose robots.txt bounces somewhere, and whose pages are otherwise fine. */
  async function bouncingRobots(to: string | ((n: number) => string)): Promise<string> {
    let hop = 0;
    const server = createServer((req, res) => {
      if ((req.url ?? '').startsWith('/robots.txt')) {
        hop++;
        res.writeHead(301, { location: typeof to === 'string' ? to : to(hop) });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('a job posting');
    });
    running.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    return `http://127.0.0.1:${String(address.port)}`;
  }

  it('will not be sent to a board this tool does not open', async () => {
    const origin = await bouncingRobots('https://www.linkedin.com/robots.txt');
    // Refused, and refused as unreadable — which this file already treats as a complete
    // disallow, so the page is not fetched either.
    await expect(politeFetch(`${origin}/job/1`, { rps: 100 })).rejects.toThrow(/could not be read/);
  }, 30_000);

  it('gives up on a redirect that never lands, rather than following it twenty times', async () => {
    // COUNTED, not just refused. The refusal alone does not distinguish a five-hop cap from
    // Node's own twenty, or from no cap at all — an endless redirect fails the fetch either
    // way, eventually. What the fix changed is HOW MANY requests the host gets first.
    let hops = 0;
    const origin = await bouncingRobots((n) => {
      hops = n;
      return `/robots.txt?n=${String(n)}`;
    });
    await expect(politeFetch(`${origin}/job/1`, { rps: 100 })).rejects.toThrow(/could not be read/);

    // The first request plus MAX_ROBOTS_REDIRECTS follow-ups. RFC 9309 § 2.3.1.2 asks for at
    // least five, so this is the floor the standard names and not an arbitrary number.
    expect(hops).toBe(6);
  }, 30_000);

  it('still follows an ordinary move, so a site that relocates its file is still read', async () => {
    const server = createServer((req, res) => {
      const url = req.url ?? '';
      if (url === '/robots.txt') {
        res.writeHead(301, { location: '/static/robots.txt' });
        res.end();
        return;
      }
      if (url === '/static/robots.txt') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('User-agent: *\nDisallow: /private/\n');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('a job posting');
    });
    running.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    const origin = `http://127.0.0.1:${String(address.port)}`;

    // The relocated file is read, and its rules are obeyed: the allowed path comes back and
    // the disallowed one is refused.
    expect(await politeFetch(`${origin}/job/1`, { rps: 100 })).toBe('a job posting');
    await expect(politeFetch(`${origin}/private/x`, { rps: 100 })).rejects.toThrow(/robots/i);
  }, 30_000);
});

/**
 * A Disallow spelled a different way is the same Disallow.
 *
 * `URL` does not decode percent-escapes in `pathname`, so `/%61pi/jobs` was compared against
 * `Disallow: /api/` and matched nothing — while the origin server decodes the escape and
 * serves the very resource its robots.txt asked automated clients to leave alone. The harm
 * lands on the student: their address does the crawling, against a promise this tool made on
 * their behalf. It is the same trick app.ts documents for its own routing, not carried over.
 */
describe('a disallowed path spelled in escapes', () => {
  async function withRules(rules: string): Promise<string> {
    const server = createServer((req, res) => {
      if ((req.url ?? '') === '/robots.txt') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(rules);
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`served ${req.url ?? ''}`);
    });
    running.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    return `http://127.0.0.1:${String(address.port)}`;
  }

  it('is refused however the path is written', async () => {
    const origin = await withRules('User-agent: *\nDisallow: /api/\nDisallow: /private/*\n');
    for (const path of ['/api/jobs', '/%61pi/jobs', '/ap%69/jobs', '/private/%78']) {
      await expect(politeFetch(`${origin}${path}`, { rps: 100 }), path).rejects.toThrow(/robots/i);
    }
  }, 30_000);

  it('still fetches a path no rule covers', async () => {
    const origin = await withRules('User-agent: *\nDisallow: /api/\n');
    expect(await politeFetch(`${origin}/careers/1`, { rps: 100 })).toBe('served /careers/1');
    // An escape in an allowed path is not itself a reason to refuse.
    expect(await politeFetch(`${origin}/careers/%41`, { rps: 100 })).toBe('served /careers/%41');
  }, 30_000);

  it('does not fall over on an escape that decodes to nothing', async () => {
    const origin = await withRules('User-agent: *\nDisallow: /api/\n');
    expect(await politeFetch(`${origin}/careers/%zz`, { rps: 100 })).toBe('served /careers/%zz');
  }, 30_000);
});

/**
 * A robots.txt is written by the host, and this one is hostile.
 *
 * Every `*` in a Disallow used to become `.*` in a compiled regex, and a run of those against a
 * path of repeating characters is the textbook catastrophic-backtracking shape. Measured on the
 * implementation this replaced: 442ms at six wildcards, 25.5 SECONDS at eight, and ten never
 * returned. Node is single-threaded, so the whole server stops for the duration and no timeout
 * can end it, because a timeout needs the event loop too.
 *
 * robots.txt is fetched from every host this tool touches, including one a model named. Nothing
 * was required to do this but a robots.txt.
 */
describe('a robots.txt built to make matching expensive', () => {
  it('answers instead of hanging', async () => {
    // Sixteen wildcards. The old matcher would not have returned from this within the life of
    // the test — it took 25 seconds at eight — so a regression shows up as a timeout.
    const rules = `User-agent: *\nDisallow: /${'a*'.repeat(16)}b\n`;
    const server = createServer((req, res) => {
      if ((req.url ?? '') === '/robots.txt') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(rules);
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('a job posting');
    });
    running.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    const origin = `http://127.0.0.1:${String(address.port)}`;

    // A path of exactly the shape the pattern chews on.
    const path = `/${'a'.repeat(2000)}`;
    expect(await politeFetch(`${origin}${path}`, { rps: 100 })).toBe('a job posting');
  }, 20_000);

  it('still obeys a wildcard rule that means something', async () => {
    const server = createServer((req, res) => {
      if ((req.url ?? '') === '/robots.txt') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('User-agent: *\nDisallow: /jobs/*/apply\nDisallow: /*.pdf$\n');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('a job posting');
    });
    running.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    const origin = `http://127.0.0.1:${String(address.port)}`;

    // Both wildcard forms still bite...
    await expect(politeFetch(`${origin}/jobs/12/apply`, { rps: 100 })).rejects.toThrow(/robots/i);
    await expect(politeFetch(`${origin}/handbook.pdf`, { rps: 100 })).rejects.toThrow(/robots/i);
    // ...and neither over-reaches. `$` anchors, so a path that merely contains .pdf is fine.
    expect(await politeFetch(`${origin}/jobs/12/description`, { rps: 100 })).toBe('a job posting');
    expect(await politeFetch(`${origin}/a.pdf.html`, { rps: 100 })).toBe('a job posting');
  }, 20_000);
});

/**
 * What the response cache is allowed to hold.
 *
 * It was bounded by entry COUNT alone, which is not a bound on memory — and adding the 16MB
 * body cap is what made that plain: five hundred entries at up to sixteen megabytes each is an
 * eight gigabyte ceiling, on bodies that are attacker-influenced in the sense that matters,
 * since a run reads whatever pages a feed named.
 */
describe('how much the response cache may keep', () => {
  it('drops old bodies once the bytes add up, not only once the count does', async () => {
    // Each body is ~1MB against a 64MB budget, so this stays well under 500 entries — the count
    // limit cannot be what evicts here, which is the whole point.
    const big = 'x'.repeat(1024 * 1024);
    const hits: string[] = [];
    const server = createServer((req, res) => {
      const url = req.url ?? '';
      if (url === '/robots.txt') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('User-agent: *\nAllow: /\n');
        return;
      }
      hits.push(url);
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(big);
    });
    running.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    const origin = `http://127.0.0.1:${String(address.port)}`;

    for (let i = 0; i < 90; i++) {
      expect(await politeFetch(`${origin}/job/${String(i)}`, { rps: 1000 })).toHaveLength(
        big.length,
      );
    }
    expect(hits).toHaveLength(90);

    // The FIRST body is 90MB of traffic ago, past a 64MB budget, so it must have been evicted —
    // asking for it again reaches the server. Counting requests is the observable proof;
    // measuring the heap would pass or fail on garbage collection timing.
    await politeFetch(`${origin}/job/0`, { rps: 1000 });
    expect(hits.filter((h) => h === '/job/0')).toHaveLength(2);

    // And the cache is still a cache: the most recent body is served without a second request.
    await politeFetch(`${origin}/job/89`, { rps: 1000 });
    expect(hits.filter((h) => h === '/job/89')).toHaveLength(1);
  }, 120_000);
});

/**
 * Which client the fetcher actually uses.
 *
 * Several suites drive the source adapters by replacing `globalThis.fetch` with a fixture
 * router, and that stopped working the moment this module started calling undici's `fetch`
 * instead of the global one — so it notices when a router has been installed. The `isTest` half
 * of that condition is the load-bearing half: deciding purely on "has the global changed" means
 * anything patching `globalThis.fetch` in a running app takes every request out through a
 * client with no guarded connector and no range-checked address, silently. A guard a third
 * party's import can switch off is not a guard.
 */
describe('the client this module calls', () => {
  it('uses a fixture router when a test installs one', async () => {
    const real = globalThis.fetch;
    let calls = 0;
    try {
      globalThis.fetch = ((): Promise<globalThis.Response> => {
        calls++;
        return Promise.resolve(new globalThis.Response('from the router'));
      }) as typeof globalThis.fetch;
      // No robots fetch reaches a real host either — the router answers that too.
      expect(await politeFetch('http://127.0.0.1:1/job/1', { rps: 100 })).toBe('from the router');
      expect(calls).toBeGreaterThan(0);
    } finally {
      globalThis.fetch = real;
    }
  });

  it('keys that on config.isTest, not on the global alone', () => {
    // Read off the source, because the branch it guards cannot be reached from inside a suite
    // where `config.isTest` is true by definition. What is pinned is that the flag is part of
    // the condition at all — without it, production follows whatever patched the global.
    const src = readFileSync(path.join(SERVER_SRC, 'infra/http/fetcher.ts'), 'utf8');
    expect(src).toMatch(/config\.isTest && globalThis\.fetch !== nativeFetch/);
  });
});

/**
 * A header the caller sets replaces the fetcher's own — it does not join it.
 *
 * `...opts.headers` looks like it replaces, and does only when the spelling matches. The
 * USAJOBS adapter sends `'User-Agent'`, capitalised the way the vendor's docs write it, so the
 * object carried `user-agent` and `User-Agent` as two keys and undici's `Headers` lowercased
 * them into one and APPENDED. Measured against a local server, the request went out as
 * `user-agent: internship-applier/0.1 (+local personal job-search tool), student@example.edu`.
 * USAJOBS requires the User-Agent to be the address registered against the key, so the one
 * source of federal internships and Pathways identified itself as something neither side
 * configured — and `Accept: application/json` from the same adapter arrived joined too.
 */
describe('a header the caller sets', () => {
  /** Records the full header set of every request, so a joined value is visible. */
  async function hostSeeingHeaders(
    seen: Array<{ url: string; headers: Record<string, string | string[] | undefined> }>,
  ): Promise<string> {
    const server = createServer((req, res) => {
      seen.push({ url: req.url ?? '', headers: req.headers });
      if ((req.url ?? '') === '/robots.txt') {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('a job posting');
    });
    running.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    return `http://127.0.0.1:${String(address.port)}`;
  }

  type Seen = Array<{ url: string; headers: Record<string, string | string[] | undefined> }>;

  it('replaces the user-agent rather than being appended to it', async () => {
    const seen: Seen = [];
    const origin = await hostSeeingHeaders(seen);

    // Exactly what the USAJOBS adapter passes, capitalisation included.
    await politeFetch(`${origin}/api/search`, {
      rps: 100,
      isDocumentedApi: true,
      headers: { 'Authorization-Key': 'KEY', 'User-Agent': 'student@example.edu' },
    });

    const page = seen.find((s) => s.url === '/api/search');
    expect(page?.headers['user-agent']).toBe('student@example.edu');
    // The failure this closes, spelled out: the vendor saw both agents in one line.
    expect(page?.headers['user-agent']).not.toContain('internship-applier');
    expect(page?.headers['user-agent']).not.toContain(',');
    // And the credential still arrives, since normalising the names must not drop any.
    expect(page?.headers['authorization-key']).toBe('KEY');
  });

  it('replaces it when the caller spells the name in lower case too', async () => {
    // The spelling that happened to work before. It has to keep working.
    const seen: Seen = [];
    const origin = await hostSeeingHeaders(seen);
    await politeFetch(`${origin}/api/search`, {
      rps: 100,
      isDocumentedApi: true,
      headers: { 'user-agent': 'student@example.edu' },
    });
    expect(seen.find((s) => s.url === '/api/search')?.headers['user-agent']).toBe(
      'student@example.edu',
    );
  });

  it('joins nothing on Accept either, which is the same bug wearing another name', async () => {
    const seen: Seen = [];
    const origin = await hostSeeingHeaders(seen);
    await politeFetch(`${origin}/api/search`, {
      rps: 100,
      isDocumentedApi: true,
      headers: { Accept: 'application/json' },
    });
    // Before the fix: 'application/json, text/html;q=0.9, */*;q=0.5, application/json'.
    expect(seen.find((s) => s.url === '/api/search')?.headers.accept).toBe('application/json');
  });

  it('still identifies this tool when the caller sets no agent at all', async () => {
    // The other direction. Overcorrecting into "the caller's headers are the headers" would
    // send a request with no user-agent, and a board is entitled to refuse an anonymous one.
    const seen: Seen = [];
    const origin = await hostSeeingHeaders(seen);
    await politeFetch(`${origin}/job/1`, { rps: 100 });

    const page = seen.find((s) => s.url === '/job/1');
    expect(page?.headers['user-agent']).toMatch(/^internship-applier\/[\d.]+ \(\+local/);
    expect(page?.headers.accept).toContain('text/html');
    // The robots.txt read speaks for the tool whatever a caller asked for: that request is a
    // promise this tool makes, not a call on the caller's API key.
    expect(seen.find((s) => s.url === '/robots.txt')?.headers['user-agent']).toMatch(
      /^internship-applier\//,
    );
  });
});

/**
 * What came back has to be capable of being a posting before it is read as one.
 *
 * Nothing looked at Content-Type, so whatever arrived with a 200 was decoded as UTF-8 and
 * stored as the posting's description. A careers link that turns out to be a PDF put `%PDF-1.4`
 * and a run of replacement characters through `stripHtml` and into the text a student reads at
 * G3 — and requirement extraction ran over the same mojibake, so a phrase no posting contains
 * could decide whether that student is eligible.
 */
describe('a response that is not a page at all', () => {
  /** A host that answers with a chosen Content-Type, or with none at all. */
  async function typedHost(type: string | null, body: string, hits: string[]): Promise<string> {
    const server = createServer((req, res) => {
      if ((req.url ?? '') === '/robots.txt') {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('');
        return;
      }
      hits.push(req.url ?? '');
      res.writeHead(200, type === null ? {} : { 'content-type': type });
      res.end(body);
    });
    running.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    return `http://127.0.0.1:${String(address.port)}`;
  }

  it.each([
    ['application/pdf'],
    ['image/png'],
    ['application/octet-stream'],
    ['application/zip'],
    ['video/mp4'],
    ['font/woff2'],
    ['application/javascript'],
  ])('refuses %s rather than storing its bytes as a description', async (type) => {
    const hits: string[] = [];
    const origin = await typedHost(type, '%PDF-1.4 binary', hits);

    const err = await politeFetch(`${origin}/job/1`, { rps: 100 }).then(
      () => null,
      (e: unknown) => e as HttpError,
    );

    expect(err).toBeInstanceOf(HttpError);
    expect(err?.status).toBe(415);
    expect(err?.message).toContain(type);
    expect(err?.message).toMatch(/not a page/);
    // Derived from what the server said rather than reported as a failure, so retrying asks
    // the same question five times and only delays the sentence the user needs to read.
    expect(hits).toHaveLength(1);
  });

  it.each([
    ['text/html'],
    ['text/html; charset=UTF-8'],
    ['text/plain'],
    ['application/json'],
    // USAJOBS answers hal+json and feeds answer +xml. An equality check on `application/json`
    // would have refused every federal posting — a false failure of exactly the kind this repo
    // cares more about than the one being fixed.
    ['application/hal+json'],
    ['application/rss+xml'],
    ['application/ld+json'],
  ])('reads %s, because that is a body made of language', async (type) => {
    const hits: string[] = [];
    const origin = await typedHost(type, 'a job posting', hits);
    expect(await politeFetch(`${origin}/job/1`, { rps: 100 })).toBe('a job posting');
  });

  it('reads a response that names no type, because saying nothing is not saying binary', async () => {
    // Small employer sites omit the header, and refusing them would hide the jobs on them.
    const hits: string[] = [];
    const origin = await typedHost(null, '<p>A normal posting</p>', hits);
    expect(await politeFetch(`${origin}/job/1`, { rps: 100 })).toBe('<p>A normal posting</p>');
  });

  it('does not apply the rule to robots.txt, where the harm runs the other way', async () => {
    // A robots.txt this refused would be an unreadable robots.txt, which this file treats as a
    // COMPLETE disallow — so a host serving its rules as octet-stream would take that whole
    // employer's site dark. Same check, opposite direction of harm, so it lives in one place.
    const server = createServer((req, res) => {
      if ((req.url ?? '') === '/robots.txt') {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end('User-agent: *\nDisallow: /private/\n');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('a job posting');
    });
    running.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    const origin = `http://127.0.0.1:${String(address.port)}`;

    // Read, and obeyed: the allowed page comes back and the disallowed one is refused.
    expect(await politeFetch(`${origin}/job/1`, { rps: 100 })).toBe('a job posting');
    await expect(politeFetch(`${origin}/private/x`, { rps: 100 })).rejects.toThrow(/robots/i);
  });
});
