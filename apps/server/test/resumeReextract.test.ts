import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { CandidateProfile } from '@ia/shared';
import type * as llm from '../src/infra/llm';
import { buildApp } from '../src/app';
import { db, schema } from '../src/infra/db/client';
import { runMigrations } from '../src/infra/db/migrate';
import { NoModelAccessError } from '../src/infra/llm';
import {
  getProfile,
  getProfileHeader,
  getUserEnteredFacts,
  saveProfile,
} from '../src/core/profile/repository';

/**
 * The model, replaced — so the reading itself is real and only the answer is stubbed.
 *
 * `extractResume` is left alone deliberately: the sentences under test below are the ones IT
 * writes, and a test that stubbed the extractor would be checking its own fixtures rather
 * than the messages a student actually receives.
 */
const model: { result?: unknown; error?: unknown; calls: { user?: string }[] } = { calls: [] };

vi.mock('../src/infra/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof llm>();
  return {
    ...actual,
    // Available, so the route gets past its model-access guard and on to reading the file.
    describeAccess: () =>
      Promise.resolve({
        provider: 'api',
        available: true,
        description: 'A stub backend.',
        limitations: [],
      }),
    generate: (req: { user?: string }) => {
      model.calls.push(req);
      if (model.error) throw model.error;
      return Promise.resolve(model.result);
    },
  };
});

/**
 * Re-uploading a resume over a profile that already exists.
 *
 * `POST /api/resumes/:id/extract` used to carry one field across — the id — so a re-upload
 * destroyed the date of birth, the work authorization, the availability window, the chosen
 * role families and every additional work location: the facts G1 collects, and precisely the
 * ones a resume cannot restate.
 *
 * The repair introduced a worse bug, and no test caught it because the only coverage was of
 * `getUserEnteredFacts` in isolation. `getUserEnteredFacts` returns `locationPrefs` with
 * `base` deliberately removed — the new resume is the better evidence for where someone
 * lives — and the route merged it with a SHALLOW spread, so that base-less object REPLACED
 * the draft's whole `locationPrefs` rather than merging into it. `base` is required by the
 * schema, `saveProfile` parses before it writes, and every re-upload therefore failed with
 * "The fields at fault: locationPrefs.base." The route's own comment promises the opposite:
 * no stored value can block a re-extraction.
 *
 * So these exercise the MERGE, not the reader.
 */

const NOW = new Date('2026-08-20T00:00:00Z');

function stored(): CandidateProfile {
  return {
    id: 'prof_reextract',
    fullName: 'Rosa Alvarez',
    pronouns: null,
    email: 'rosa@example.edu',
    phone: '+1 555 0100',
    dateOfBirth: '2006-03-15',
    address: { city: 'Half Moon Bay', region: 'CA', country: 'US' },
    links: { other: [] },
    workAuthorization: { country: 'US', status: 'citizen', needsSponsorship: false },
    citizenships: ['US'],
    education: [],
    experience: [],
    projects: [],
    skills: [],
    certifications: [],
    languages: [],
    availability: { start: '2027-06-01', end: '2027-08-20', flexible: false },
    locationPrefs: {
      base: { city: 'Half Moon Bay', region: 'CA', country: 'US' },
      additionalBases: [{ city: 'Los Angeles', region: 'CA', country: 'US', label: 'school' }],
      maxCommuteKm: 50,
      remoteOk: false,
      hybridOk: true,
      relocateTo: ['Seattle'],
    },
    preferences: {
      companySizes: [],
      industries: ['robotics'],
      excludeCompanies: ['Acme'],
      roleFamilies: ['robotics'],
    },
    derived: {},
    confirmedAt: null,
    needsReview: [],
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  } as unknown as CandidateProfile;
}

/** What `toDraftProfile` produces from a fresh reading: a new base, and defaults for the rest. */
function freshDraft(): CandidateProfile {
  return {
    ...stored(),
    id: 'prof_fresh',
    fullName: 'Rosa Alvarez',
    dateOfBirth: null,
    workAuthorization: { country: 'US', status: 'unknown', needsSponsorship: false },
    citizenships: [],
    availability: { flexible: true },
    locationPrefs: {
      // The new resume says somewhere else. This is the value that must survive.
      base: { city: 'Austin', region: 'TX', country: 'US' },
      additionalBases: [],
      maxCommuteKm: 50,
      remoteOk: true,
      hybridOk: true,
      relocateTo: [],
    },
    preferences: {
      companySizes: [],
      industries: [],
      excludeCompanies: [],
      roleFamilies: [],
    },
  } as unknown as CandidateProfile;
}

/** Exactly what routes/resumes.ts does, so the merge itself is what is under test. */
function reextract(): CandidateProfile {
  const existing = getProfileHeader();
  const draft = freshDraft();
  const kept = existing ? (getUserEnteredFacts() ?? {}) : {};
  return saveProfile(
    existing
      ? {
          ...draft,
          ...kept,
          locationPrefs: { ...draft.locationPrefs, ...(kept.locationPrefs ?? {}) },
          id: existing.id,
        }
      : draft,
    NOW,
  );
}

beforeAll(() => {
  runMigrations();
});

beforeEach(() => {
  db.delete(schema.profile).run();
});

describe('re-extracting a resume over an existing profile', () => {
  it('succeeds at all', () => {
    // The regression this file exists for: the save threw, so re-uploading a resume answered
    // 502 and the student could not replace their resume by any route at all.
    saveProfile(stored(), NOW);
    expect(() => reextract()).not.toThrow();
  });

  it('takes the home city from the NEW resume', () => {
    // The one location fact a resume genuinely restates, and the reason `base` is stripped
    // from what gets carried across.
    saveProfile(stored(), NOW);
    expect(reextract().locationPrefs.base.city).toBe('Austin');
  });

  it('keeps every fact a resume cannot contain', () => {
    saveProfile(stored(), NOW);
    const after = reextract();
    expect(after.dateOfBirth).toBe('2006-03-15');
    expect(after.workAuthorization.status).toBe('citizen');
    expect(after.citizenships).toEqual(['US']);
    expect(after.availability).toMatchObject({ start: '2027-06-01', flexible: false });
    expect(after.preferences.roleFamilies).toEqual(['robotics']);
    expect(after.preferences.excludeCompanies).toEqual(['Acme']);
  });

  it('keeps the rest of locationPrefs, which the student typed', () => {
    // The half of that object that is NOT the base: additional places they work from, where
    // they would move to, and whether they will take remote work.
    saveProfile(stored(), NOW);
    const prefs = reextract().locationPrefs;
    expect(prefs.additionalBases).toHaveLength(1);
    expect(prefs.additionalBases[0]?.city).toBe('Los Angeles');
    expect(prefs.relocateTo).toEqual(['Seattle']);
    expect(prefs.remoteOk).toBe(false);
  });

  it('keeps the id, so history and foreign keys survive', () => {
    saveProfile(stored(), NOW);
    expect(reextract().id).toBe('prof_reextract');
    expect(getProfile()?.id).toBe('prof_reextract');
  });

  it('takes the draft whole when there is no profile to merge with', () => {
    // First upload: nothing to carry, and nothing to fail on.
    expect(getProfileHeader()).toBeNull();
    const saved = reextract();
    expect(saved.locationPrefs.base.city).toBe('Austin');
    expect(saved.dateOfBirth).toBeNull();
  });
});

/**
 * What the student is told when the reading does not work.
 *
 * `POST /api/resumes/:id/extract` caught everything and answered with one fixed sentence:
 * `Reading "cv.docx" did not finish. The server log has the details. Try again, or upload the
 * file in a different format.` Behind it were messages somebody had sat down and written —
 * "This .docx unpacks to 394MB… Export it again from your word processor, or save it as a
 * PDF", "This resume is longer than one reading can return… Try the shorter version of your
 * resume" — and every one of them was replaced by advice ("Try again") that fails identically
 * on every attempt, because each of these failures is a fixed property of the file.
 *
 * The text-extraction half was not merely flattened, it was unreachable: the upload logs that
 * failure and stores no text, and the extract route then produced `extractResume`'s own
 * generic "No text could be read from this document." So the four sentences that say what to
 * DO about a .docx lived in a log file the student never opens.
 *
 * The reason the flattening existed is real, and is pinned here too: `err.message` from the
 * filesystem is an absolute path, and handing one to whoever is reading the response is worse
 * than saying nothing. Both directions in the same block on purpose — the cheap way to pass
 * the first three of these is to go back to returning `err.message`.
 */
describe('what POST /api/resumes/:id/extract says when the reading fails', () => {
  const HOST = '127.0.0.1:8787';
  const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ skipAuth: true });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    model.result = undefined;
    model.error = undefined;
    model.calls = [];
  });

  const upload = async (filename: string, body: string, type = 'text/plain'): Promise<string> => {
    const boundary = '----iaExtractMessageTest';
    const payload = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
          `Content-Type: ${type}\r\n\r\n`,
      ),
      Buffer.from(body, 'utf8'),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await app.inject({
      method: 'POST',
      url: '/api/resumes',
      headers: { host: HOST, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });
    // A document no text can be read out of is still accepted here, on purpose. The whole
    // question below is what the step that was supposed to explain why actually says.
    expect(res.statusCode, res.body).toBe(201);
    return (res.json() as { documentId: string }).documentId;
  };

  const extract = async (id: string) => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/resumes/${id}/extract`,
      headers: { host: HOST },
    });
    return { status: res.statusCode, body: res.json() as unknown };
  };

  const errorOf = (body: unknown): { code: string; message: string } =>
    (body as { error: { code: string; message: string } }).error;

  it('repeats what the .docx reader said, which is the half that says what to do', async () => {
    // Not a zip at all, so `readZipBounds` refuses it before mammoth is even loaded. This is
    // the sentence the upload could only put in a log.
    const id = await upload('cv.docx', 'PK is what this is missing', DOCX);
    const { status, body } = await extract(id);

    expect(status).toBe(422);
    expect(errorOf(body).message).toContain('cv.docx');
    expect(errorOf(body).message).toContain('its archive directory is missing');
    // The advice that could never work: every read of this file fails the same way.
    expect(errorOf(body).message).not.toContain('Try again');
  });

  it('names an empty document as empty rather than as a server problem', async () => {
    const id = await upload('blank.txt', '');
    const { status, body } = await extract(id);

    expect(status).toBe(422);
    expect(errorOf(body).message).toContain('blank.txt');
    expect(errorOf(body).message).toContain('No text could be read from this document.');
    // Nothing was asked of the model, because there was nothing to ask about.
    expect(model.calls).toHaveLength(0);
  });

  it('keeps the sentence a cut-off reading wrote, advice and all', async () => {
    const id = await upload('long.txt', 'Rosa Alvarez — robotics, Half Moon Bay');
    model.result = { text: '', stopReason: 'max_tokens', provider: 'api' };
    const { status, body } = await extract(id);

    expect(status).toBe(422);
    expect(errorOf(body).message).toContain('longer than one reading can return');
    expect(errorOf(body).message).toContain('Try the shorter version of your resume');
  });

  it('hands back no path, whatever the failure had to say about one', async () => {
    const id = await upload('rosa.txt', 'Rosa Alvarez — robotics');
    // Exactly the shape Node throws, message and properties. This is what the route returned
    // verbatim once, and it is a map of the machine to whoever is reading the response.
    model.error = Object.assign(
      new Error(
        "ENOENT: no such file or directory, open 'C:\\Users\\eric\\AppData\\ia\\resumes\\01J.txt'",
      ),
      {
        errno: -4058,
        code: 'ENOENT',
        syscall: 'open',
        path: 'C:\\Users\\eric\\AppData\\ia\\resumes\\01J.txt',
      },
    );
    const { status, body } = await extract(id);

    expect(status).toBe(502);
    expect(errorOf(body).code).toBe('INTERNAL');
    expect(errorOf(body).message).toContain('The server log has the details');
    expect(errorOf(body).message).not.toContain('C:\\Users');
    expect(errorOf(body).message).not.toContain('ENOENT');
  });

  it('hands back nothing a parser said either', async () => {
    const id = await upload('rosa.txt', 'Rosa Alvarez — robotics');
    // A TypeError stands in for the family — ZodError, SyntaxError, anything whose message is
    // written for whoever is debugging it. What they have in common is being a subclass.
    model.error = new TypeError("Cannot read properties of undefined (reading 'bullets')");
    const { status, body } = await extract(id);

    expect(status).toBe(502);
    expect(errorOf(body).message).not.toContain('Cannot read properties');
    expect(errorOf(body).message).toContain('rosa.txt');
  });

  it('still tells someone with no model access what to do about it', async () => {
    // The one class already carried through, unchanged by any of this: 503, its own message,
    // and no suggestion to upload the file in a different format.
    const id = await upload('rosa.txt', 'Rosa Alvarez — robotics');
    model.error = new NoModelAccessError(
      'The Claude Code CLI is signed out. Run `claude` once in a terminal.',
      'not_signed_in',
    );
    const { status, body } = await extract(id);

    expect(status).toBe(503);
    expect(errorOf(body).code).toBe('NO_MODEL_ACCESS');
    expect(errorOf(body).message).toContain('Run `claude` once in a terminal.');
  });

  it('reads the file again rather than treating one bad read as permanent', async () => {
    // A read that failed at upload — a descriptor exhausted, a file still being written by
    // the syncing client that put it there — left `raw_text` null forever and nothing ever
    // looked at the document again: extraction refused it on every attempt, and the only cure
    // was uploading the identical file a second time.
    const id = await upload(
      'rosa.txt',
      'Rosa Alvarez\nrosa@example.edu\nRobotics Club — line follower',
    );
    db.update(schema.resumeDocument)
      .set({ rawText: null })
      .where(eq(schema.resumeDocument.id, id))
      .run();

    model.result = {
      text: '',
      stopReason: 'end_turn',
      provider: 'api',
      structured: {
        fullName: 'Rosa Alvarez',
        pronouns: null,
        email: 'rosa@example.edu',
        phone: null,
        location: 'Half Moon Bay, CA',
        links: { github: null, linkedin: null, portfolio: null },
        education: [],
        experience: [],
        projects: [],
        skills: [],
        certifications: [],
        languages: [],
        needsReview: [],
      },
    };

    const { status, body } = await extract(id);
    expect(status).toBe(200);
    expect((body as { profile: CandidateProfile }).profile.fullName).toBe('Rosa Alvarez');
    // The recovered text reached the model, which is the only way it could have: with none,
    // the extractor refuses before the call is made.
    expect(model.calls[0]?.user).toContain('Robotics Club');
  });
});
