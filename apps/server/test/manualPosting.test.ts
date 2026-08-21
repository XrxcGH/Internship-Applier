import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { fetchManualPosting } from '../src/core/discovery/manualPosting';

/**
 * Reading a page the model named, or a student pasted, as a posting.
 *
 * Every other test of this path mocks it, so what the reader does with a real page was held by
 * nothing — and a real run stored a posting titled "Jobs search — Google Careers", company
 * "Google", which then came back as one of fifteen ELIGIBLE matches. A row naming a role that
 * does not exist, in the queue the student is meant to work through.
 *
 * `guessTitle` falls back to the page's own `<title>`, which on a search-results page is the
 * site's furniture rather than a job.
 */
const running: Server[] = [];

afterEach(() => {
  while (running.length > 0) running.pop()?.close();
});

async function serve(html: string): Promise<string> {
  const server = createServer((req, res) => {
    if ((req.url ?? '') === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('User-agent: *\nAllow: /\n');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(html);
  });
  running.push(server);
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return `http://127.0.0.1:${String(address.port)}/jobs/results/12345-software-engineering-intern`;
}

const body = (title: string, text = 'x'.repeat(400)) =>
  `<html><head><title>${title}</title></head><body><p>${text}</p></body></html>`;

describe('a page that does not name one job', () => {
  it('is refused rather than stored as a posting', async () => {
    const url = await serve(body('Jobs search — Google Careers'));
    await expect(fetchManualPosting(url)).rejects.toThrow(/does not name a single job/);
  }, 30_000);

  it('says what to do instead of only that it refused', async () => {
    const url = await serve(body('Search results | Careers'));
    await expect(fetchManualPosting(url)).rejects.toThrow(/open the posting itself/);
  }, 30_000);

  it('refuses each of the listing shapes, and none of them quietly', async () => {
    for (const title of ['Job Search - Acme', 'Search Jobs at Acme', 'Jobs search']) {
      const url = await serve(body(title));
      await expect(fetchManualPosting(url), title).rejects.toThrow(/does not name a single job/);
    }
  }, 60_000);
});

describe('a page that does name one job', () => {
  it('is read, and keeps the title the page gave it', async () => {
    const url = await serve(body('Operations Intern, Summer 2027 — Acme'));
    const { posting } = await fetchManualPosting(url);
    expect(posting.title).toBe('Operations Intern, Summer 2027 — Acme');
  }, 30_000);

  it('is not refused for having the word "search" in the role', async () => {
    // The edge this rule has to stay clear of. "Search Engineer" is a job; "job search" is not.
    const url = await serve(body('Search Engineer Intern'));
    const { posting } = await fetchManualPosting(url);
    expect(posting.title).toBe('Search Engineer Intern');
  }, 30_000);

  it('trusts structured data over the page title, whatever the title says', async () => {
    // A page that states it IS a posting is one, even if its <title> is site furniture. The
    // rule is only consulted when nothing structured named the job.
    const ld = {
      '@type': 'JobPosting',
      title: 'Robotics Intern',
      description: 'A real posting.',
      hiringOrganization: { name: 'Acme' },
    };
    const url = await serve(
      `<html><head><title>Jobs search — Acme Careers</title>` +
        `<script type="application/ld+json">${JSON.stringify(ld)}</script></head><body>ok</body></html>`,
    );
    const { posting } = await fetchManualPosting(url);
    expect(posting.title).toBe('Robotics Intern');
  }, 30_000);
});
