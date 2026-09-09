import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { fetchManualPosting, guessCompany } from '../src/core/discovery/manualPosting';
import { stripHtml } from '../src/core/discovery/sources/types';

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

/** A page served with a JSON-LD JobPosting block, for the fields the reader takes from it. */
const withLd = (ld: unknown, title = 'Data Science Intern — Acme Robotics') =>
  `<html><head><title>${title}</title>` +
  `<script type="application/ld+json">${JSON.stringify(ld)}</script></head>` +
  `<body><p>${'x'.repeat(400)}</p></body></html>`;

/**
 * WHO THE POSTING SAYS THE EMPLOYER IS, when the page lives on somebody else's board.
 *
 * The student pastes `https://job-boards.greenhouse.io/acme-robotics/jobs/4512` and the posting
 * was stored with company "job-boards"; `boards.greenhouse.io/acme/...` stored "greenhouse",
 * because the host-prefix strip eats "boards." and leaves the VENDOR standing where the
 * employer should be. That name is then the one the application carries: at G3 the single most
 * ordinary sentence a "why this company" answer contains is the employer's own name, and a name
 * the application has never heard of is refused there with NO override.
 *
 * Both directions are pinned. The vendor must never be stored as the employer, and a host that
 * really is the employer's own must still be read as one.
 */
describe('the employer read out of a posting address', () => {
  it('takes the employer from the board path on every board that puts it there', () => {
    // The reported case is the first line. The rest are its siblings: every multi-tenant ATS
    // this repo names puts the employer's own slug in the path, and each one produced the
    // vendor's name instead. The slug is also what the ATS adapters store as `company`
    // (`ats.ts` uses `q.board`), so the same posting found both ways still merges on the
    // dedupe fingerprint.
    const cases: Array<[string, string]> = [
      ['https://job-boards.greenhouse.io/acme-robotics/jobs/4512', 'acme-robotics'],
      ['https://boards.greenhouse.io/acme/jobs/4512', 'acme'],
      ['https://job-boards.eu.greenhouse.io/acme/jobs/4512?gh_src=abc', 'acme'],
      // Greenhouse's embedded form names the board in a query parameter instead.
      ['https://boards.greenhouse.io/embed/job_app?for=acme&token=4512', 'acme'],
      ['https://jobs.lever.co/acme/6c3f1a2b-0000-4d5e-8f90-abcdefabcdef', 'acme'],
      ['https://jobs.eu.lever.co/acme/6c3f1a2b/apply', 'acme'],
      ['https://jobs.ashbyhq.com/acme/8f2b1c3d-1111-4a5b-9c0d-abcdefabcdef', 'acme'],
      ['https://jobs.smartrecruiters.com/AcmeRobotics/743999123456-intern', 'AcmeRobotics'],
      ['https://apply.workable.com/acme/j/AB12CD34EF/', 'acme'],
    ];
    for (const [url, company] of cases) expect(guessCompany(url), url).toBe(company);
  });

  it('never answers with the vendor for a board that names an employer', () => {
    for (const url of [
      'https://job-boards.greenhouse.io/acme-robotics/jobs/4512',
      'https://jobs.lever.co/acme/6c3f1a2b',
      'https://jobs.ashbyhq.com/acme/8f2b1c3d',
    ]) {
      expect(guessCompany(url), url).not.toMatch(/greenhouse|lever|ashby|job-boards/i);
    }
  });

  it("still reads a company's own careers host as the company", () => {
    // The other direction, and the case that must not regress: on these hosts the name in the
    // address IS the employer, and a Workday tenant is a subdomain rather than a path segment.
    expect(guessCompany('https://careers.acme.com/jobs/4512')).toBe('acme');
    expect(guessCompany('https://acme.wd5.myworkdayjobs.com/en-US/acme/job/4512')).toBe('acme');
    expect(guessCompany('https://acme.taleo.net/careersection/2/jobdetail.ftl?job=4512')).toBe(
      'acme',
    );
  });

  it('does not mistake a board path with no employer in it for one', () => {
    // A board root and Workable's short link name nobody. Falling back to the hostname
    // fragment is deliberate: webSearch's `isHostFragment` repair keys on the stored company
    // being part of the hostname, so a made-up "unknown" here would switch that repair off.
    expect(guessCompany('https://boards.greenhouse.io/')).toBe('greenhouse');
    expect(guessCompany('https://apply.workable.com/j/AB12CD34EF')).toBe('workable');
    expect(guessCompany('https://jobs.lever.co/')).toBe('lever');
  });

  it('lets the page overrule the address when it names the employer itself', async () => {
    const url = await serve(
      withLd({
        '@type': 'JobPosting',
        title: 'Data Science Intern',
        description: 'A real posting.',
        hiringOrganization: { name: 'Acme Robotics, Inc.' },
      }),
    );
    const { posting, namedByJsonLd } = await fetchManualPosting(url);
    expect(posting.company).toBe('Acme Robotics, Inc.');
    expect(namedByJsonLd.company).toBe(true);
  }, 30_000);

  it('reads a hiringOrganization written as a bare string', async () => {
    // schema.org expects an Organization node and plenty of career pages write the name
    // directly instead. Reading only `.name` threw that away and fell through to the address.
    const url = await serve(
      withLd({
        '@type': 'JobPosting',
        title: 'Data Science Intern',
        description: 'A real posting.',
        hiringOrganization: 'Acme Robotics',
      }),
    );
    const { posting, namedByJsonLd } = await fetchManualPosting(url);
    expect(posting.company).toBe('Acme Robotics');
    expect(namedByJsonLd.company).toBe(true);
  }, 30_000);

  it('does not store a blank company because the structured data left the name empty', async () => {
    // `??` only falls through on null and undefined, so an empty `name` was stored verbatim —
    // a posting with no employer at all, and `namedByJsonLd.company` false beside it saying
    // the page had named one.
    const url = await serve(
      withLd({
        '@type': 'JobPosting',
        title: 'Data Science Intern',
        description: 'A real posting.',
        hiringOrganization: { name: '   ' },
      }),
    );
    const { posting, namedByJsonLd } = await fetchManualPosting(url);
    expect(posting.company.trim()).not.toBe('');
    expect(namedByJsonLd.company).toBe(false);
  }, 30_000);

  it('does not store a blank title because the structured data left it empty', async () => {
    const url = await serve(
      withLd({ '@type': 'JobPosting', title: '', description: 'A real posting.' }),
    );
    const { posting } = await fetchManualPosting(url);
    expect(posting.title.trim()).not.toBe('');
  }, 30_000);
});

/**
 * SCRIPT SOURCE IS NOT JOB DESCRIPTION, and an unclosed tag is where it got in.
 *
 * A page whose `<script>` is never closed leaked its JavaScript straight through into
 * `descriptionText`, because the strip kept an opener it could find no closer for. A string
 * inside that script — `var gate = "Applicants must be U.S. citizens."` — was then read by the
 * deterministic requirement pass as a citizenship rule the employer had stated, and hard-failed
 * a student who is not a citizen out of a job nobody said they could not have.
 *
 * The other direction matters just as much: an employer who writes about build scripts, or a
 * page carrying a `<script-loader>` element, must come through with every word intact.
 */
describe('a posting page whose script tag is never closed', () => {
  const RUNAWAY =
    '<script type="text/javascript">\n' +
    '  window.dataLayer = window.dataLayer || [];\n' +
    '  var gate = "Applicants must be U.S. citizens.";\n' +
    '  document.addEventListener("load", function () { render(gate); });\n';

  it('keeps the description and leaves the script source out of it', async () => {
    const url = await serve(
      `<html><head><title>Data Science Intern — Acme</title></head><body>` +
        `<p>Acme Robotics is hiring a data science intern for Summer 2027 in Los Angeles. ` +
        `You will write build scripts and styles for the analysis pipeline. ${'x'.repeat(200)}</p>` +
        `${RUNAWAY}</body></html>`,
    );
    const { posting } = await fetchManualPosting(url);
    expect(posting.descriptionText).toMatch(/hiring a data science intern for Summer 2027/);
    // The employer's own words about scripts survive; the script's own words do not.
    expect(posting.descriptionText).toMatch(/build scripts and styles/);
    expect(posting.descriptionText).not.toMatch(/U\.S\. citizens/);
    expect(posting.descriptionText).not.toMatch(/dataLayer|addEventListener/);
  }, 30_000);

  it('says the page was unreadable rather than storing its JavaScript as the posting', async () => {
    // The runaway script comes first here, which is where analytics snippets usually sit, and
    // a browser renders nothing after it either. An unreadable page is a posting the student
    // is told to check; a page of JavaScript read as requirements is a rejection.
    const url = await serve(
      `<html><head><title>Data Science Intern — Acme</title>${RUNAWAY}</head>` +
        `<body><p>Acme Robotics is hiring.</p></body></html>`,
    );
    const { posting, notes } = await fetchManualPosting(url);
    expect(posting.descriptionText).not.toMatch(/U\.S\. citizens/);
    expect(notes.join(' ')).toMatch(/very little text/i);
  }, 30_000);

  it('drops the contents of script and style when the closing tag is malformed', () => {
    // A closer only has to be `</script` followed by a space, a slash or the bracket — which
    // is what a browser ends the element on, and what the literal `</script>` search missed.
    expect(stripHtml('a<script>var gate = "U.S. citizens";</script >b')).toBe('a b');
    expect(stripHtml('a<script>var gate = "U.S. citizens";</SCRIPT\n>b')).toBe('a b');
    expect(stripHtml('a<script>var gate = "U.S. citizens";</script/>b')).toBe('a b');
    expect(stripHtml('a<style>.p{content:"U.S. citizens"}</style >b')).toBe('a b');
  });

  it('drops the contents of an unclosed script or style to the end of the page', () => {
    expect(stripHtml('Real text.<script>var gate = "U.S. citizens";')).toBe('Real text.');
    expect(stripHtml('Real text.<style>.a{color:red}')).toBe('Real text.');
    expect(stripHtml('Real text.<SCRIPT src=x>var gate = "U.S. citizens";')).toBe('Real text.');
  });

  it('leaves alone the words a job description really uses', () => {
    // The overcorrection to guard against: dropping to the end of the page is destructive, so
    // only a real script element may trigger it. A custom element whose name merely starts
    // with "script" is not one — `<script-loader>` is a legal custom element name — and a
    // prefix match with no tag boundary would take the rest of the posting with it.
    expect(stripHtml('<p>You will write build scripts and page styles.</p>')).toBe(
      'You will write build scripts and page styles.',
    );
    expect(stripHtml('a<script-loader></script-loader>b')).toBe('a b');
    expect(stripHtml('a<styleguide-note>b</styleguide-note>c')).toBe('a b c');
  });
});
