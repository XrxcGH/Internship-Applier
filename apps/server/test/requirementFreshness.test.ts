/**
 * Requirements belong to the description they were read from.
 *
 * `runMatching` extracts a posting's requirements once and then trusts a stamp:
 * `requirementsExtractedAt === null || opts.reextract`. Nothing ever cleared that stamp, so
 * requirements read from one description outlived it.
 *
 * The shape that costs the student: a board answers a listing with an empty or one-line
 * description, the posting is stored, matching finds no requirements in it and stamps the
 * row — and when a later run brings the real description, the row keeps its stamp and the
 * text is never read at all. Eligibility then reasons about a posting whose stated rules it
 * has never seen, for as long as that posting exists, and the only way out was a manual
 * re-extract of the whole table.
 *
 * The control matters as much as the fix. Clearing on every sighting would re-run the model
 * pass over every posting on every discovery run for anyone with an API key, which is a bill
 * rather than a bug — so a re-sighting that brings the same text must leave the stamp alone.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { NormalizedPosting } from '../src/core/discovery/sources/types';
import { db, schema } from '../src/infra/db/client';
import { runMigrations } from '../src/infra/db/migrate';
import { saveManualPosting } from '../src/core/discovery/run';

const URL_ = 'https://example.test/jobs/requirement-freshness';

function posting(descriptionText: string): NormalizedPosting {
  return {
    externalId: 'rf-1',
    canonicalUrl: URL_,
    applyUrl: URL_,
    company: 'Sample Robotics',
    companyDomain: null,
    title: 'Summer Engineering Intern',
    descriptionText,
    descriptionHtml: null,
    locations: [],
    positionType: null,
    workArrangement: null,
    hybridDaysOnsite: null,
    remoteEligibleIn: [],
    programFlags: [],
    term: { season: null, year: null, durationWeeks: null, multiTerm: false },
    compensation: null,
    requires: {},
    postedAt: null,
    closesAt: null,
    atsVendor: 'unknown',
  };
}

/** The state a posting is in once matching has read it: requirements, and a stamp saying so. */
function stamp(id: string): void {
  db.update(schema.jobPosting)
    .set({ requirementsExtractedAt: '2026-09-01T00:00:00.000Z' })
    .where(eq(schema.jobPosting.id, id))
    .run();
}

function stampOf(id: string): string | null {
  return (
    db
      .select({ at: schema.jobPosting.requirementsExtractedAt })
      .from(schema.jobPosting)
      .where(eq(schema.jobPosting.id, id))
      .all()[0]?.at ?? null
  );
}

beforeEach(() => {
  runMigrations();
  db.delete(schema.jobPosting).where(eq(schema.jobPosting.canonicalUrl, URL_)).run();
});

describe('a posting whose description changed under its requirements', () => {
  it('drops the stamp, so the new text is read', () => {
    const id = saveManualPosting(posting('Software Engineering Intern.'));
    stamp(id);
    expect(stampOf(id)).not.toBeNull();

    const again = saveManualPosting(
      posting('Software Engineering Intern.\n\nApplicants must be at least 18 years of age.'),
    );
    expect(again).toBe(id);
    expect(stampOf(id)).toBeNull();
  });

  it('keeps the stamp when the same posting is seen again unchanged', () => {
    // The half that keeps this from becoming a bill: `freshFields` proposes the identical
    // text on an ordinary re-sighting, and re-extracting then would put a model call on every
    // posting on every run for anyone with an API key.
    const text = 'Software Engineering Intern.\n\nApplicants must be at least 18 years of age.';
    const id = saveManualPosting(posting(text));
    stamp(id);

    expect(saveManualPosting(posting(text))).toBe(id);
    expect(stampOf(id)).toBe('2026-09-01T00:00:00.000Z');
  });

  it('keeps the stamp when a later sighting carries no description at all', () => {
    // `freshFields` already refuses to overwrite something with nothing, so an empty
    // description is not a change — and treating it as one would throw away requirements read
    // from the full text on the strength of a source that answered with less.
    const id = saveManualPosting(posting('Applicants must be at least 18 years of age.'));
    stamp(id);

    saveManualPosting(posting(''));
    expect(stampOf(id)).toBe('2026-09-01T00:00:00.000Z');
  });
});

/**
 * WHICH STORED ROW A SIGHTING IS ALLOWED TO WRITE.
 *
 * `persist` looks a posting up by `canonical_url OR fingerprint`, and those two halves can
 * match DIFFERENT stored rows: this posting's own row by address, and somebody else's by
 * fingerprint — company, normalised title and primary city, which two requisitions at one
 * company in one city share readily. The lookup had no ORDER BY and took `[0]`, so which row
 * got written was whatever SQLite's plan returned first: a sighting could overwrite a
 * different job's row and leave its own untouched.
 *
 * The apply URL is the half that reaches the student. `freshFields` takes it from whatever
 * sighting arrived last, so a fingerprint-only match — an aggregator's copy, a web-search hit
 * — could repoint a row whose canonical URL is the employer's own ATS page. G4 is the student
 * clicking that link on a real application, so it has to point where the row says it is from.
 */
describe('a sighting that matches one row by address and another by fingerprint', () => {
  const OTHER_URL = 'https://example.test/jobs/hijack-other';

  function twin(canonicalUrl: string, applyUrl: string): NormalizedPosting {
    // Same company, title and (absent) city, so both rows carry one fingerprint.
    return { ...posting('A role.'), canonicalUrl, applyUrl, externalId: null };
  }

  beforeEach(() => {
    db.delete(schema.jobPosting).where(eq(schema.jobPosting.canonicalUrl, OTHER_URL)).run();
    db.delete(schema.jobPosting).where(eq(schema.jobPosting.id, 'neighbour_row')).run();
  });

  it('writes the row at its own address, not the fingerprint neighbour', () => {
    // Two stored rows sharing one fingerprint is a real state — the fingerprint's definition
    // has changed before, and `persist` rewrites it on every sighting precisely so the table
    // heals — so the neighbour is inserted directly rather than through `persist`, which
    // would merge the two on that same key and leave nothing to choose between.
    const mine = saveManualPosting(twin(URL_, 'https://example.test/apply/mine'));
    const fp = db
      .select({ fingerprint: schema.jobPosting.fingerprint })
      .from(schema.jobPosting)
      .where(eq(schema.jobPosting.id, mine))
      .all()[0]!.fingerprint;

    db.insert(schema.jobPosting)
      .values({
        id: 'neighbour_row',
        canonicalUrl: OTHER_URL,
        applyUrl: OTHER_URL,
        company: 'Sample Robotics',
        title: 'Summer Engineering Intern',
        descriptionText: 'A different requisition that happens to share the key.',
        fingerprint: fp,
        isOpen: true,
      } as never)
      .run();

    // A sighting at MY address, with both rows matching the `or`.
    expect(saveManualPosting(twin(URL_, 'https://example.test/apply/mine'))).toBe(mine);

    // The neighbour was not touched: still its own address, still its own description.
    const neighbour = db
      .select({
        applyUrl: schema.jobPosting.applyUrl,
        descriptionText: schema.jobPosting.descriptionText,
      })
      .from(schema.jobPosting)
      .where(eq(schema.jobPosting.id, 'neighbour_row'))
      .all()[0];
    expect(neighbour?.applyUrl).toBe(OTHER_URL);
    expect(neighbour?.descriptionText).toMatch(/different requisition/);
  });

  it('does not let a sighting at another address repoint where the student applies', () => {
    const id = saveManualPosting(twin(URL_, 'https://boards.greenhouse.io/acme/jobs/1/apply'));

    // The same job seen by an aggregator, at its own address, offering its own apply link.
    saveManualPosting(twin(OTHER_URL, 'https://aggregator.test/redirect?job=1'));

    const applyUrl = db
      .select({ applyUrl: schema.jobPosting.applyUrl })
      .from(schema.jobPosting)
      .where(eq(schema.jobPosting.id, id))
      .all()[0]?.applyUrl;
    expect(applyUrl).toBe('https://boards.greenhouse.io/acme/jobs/1/apply');
  });

  it('still lets the same page correct its own apply URL', () => {
    // A sighting at the SAME canonical URL is the same page, and a moved apply link is a
    // correction the row should take.
    const id = saveManualPosting(twin(URL_, 'https://example.test/apply/old'));
    saveManualPosting(twin(URL_, 'https://example.test/apply/new'));

    const applyUrl = db
      .select({ applyUrl: schema.jobPosting.applyUrl })
      .from(schema.jobPosting)
      .where(eq(schema.jobPosting.id, id))
      .all()[0]?.applyUrl;
    expect(applyUrl).toBe('https://example.test/apply/new');
  });
});
