import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readdirSync, statSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { config } from '../src/config';
import { db, schema } from '../src/infra/db/client';
import { runMigrations } from '../src/infra/db/migrate';
import path from 'node:path';
import {
  extensionForMime,
  storedResumeFilename,
  SUPPORTED_MIME,
} from '../src/core/ingestion/extractText';

/**
 * What a resume gets stored as on disk.
 *
 * The upload route built that name with `path.extname(file.filename)`, which puts a string
 * the student's file arrived with straight into a filesystem path. `extname` reads the last
 * segment only, so it can never contain a separator and this was never a traversal — but on
 * Windows it could carry a colon. Verified before the fix: uploading `resume.txt:evil` wrote
 * the resume into an NTFS alternate data stream, and the folder then listed a 0-byte
 * `<id>.txt`. Nothing appeared broken, because every reader downstream used the same full
 * string; the resume was simply absent from any copy of that folder the student ever made.
 * A 300-character extension failed louder — the write threw ENOENT and the upload 500'd.
 */
describe('the name a resume is stored under', () => {
  it('is one of four, whatever the file was called', () => {
    for (const mime of SUPPORTED_MIME) {
      expect(['.pdf', '.docx', '.md', '.txt']).toContain(extensionForMime(mime));
    }
  });

  it('carries nothing a filename could have smuggled into the path', () => {
    const id = '01JABCDEFGHJKMNPQRSTVWXYZ';

    // Each of these is a name a browser will send, paired with what `path.extname` hands back
    // for it — the string the old code appended to the path.
    const hostile = [
      'resume.txt:evil', // an NTFS alternate data stream
      `resume.${'y'.repeat(300)}`, // ENOENT on write
      'resume.pdf ', // trailing space: Windows strips it, so the path moves
      'resume..',
      'resume.pdf.txt',
      String.raw`resume.a\b`,
      'resume.a/b',
    ];

    // What the old line would have produced for each, against what the new one does. The
    // stored names collapse to a single value: the name the file arrived under changes
    // nothing about where it lands.
    // `path.win32` explicitly, not the ambient `path`: a backslash is a separator on Windows
    // and an ordinary character elsewhere, so the plain call gives different answers on the
    // machine this runs on and on CI. The bug being pinned is a Windows one; name it.
    const wouldHaveBeen = new Set(hostile.map((f) => `${id}${path.win32.extname(f)}`));
    const areNow = new Set(hostile.map(() => storedResumeFilename(id, 'application/pdf')));

    // Six, not seven: the two names carrying a separator both give back an empty extension,
    // because `extname` reads the last path segment and a separator starts a new one. That is
    // the reason this was a Windows-stream and path-length bug rather than a traversal.
    expect(wouldHaveBeen.size).toBe(6);
    expect(path.win32.extname(String.raw`resume.a\b`)).toBe('');
    expect([...areNow]).toEqual([`${id}.pdf`]);
    expect(path.win32.basename(`${id}.pdf`)).toBe(`${id}.pdf`);
    expect(path.posix.basename(`${id}.pdf`)).toBe(`${id}.pdf`);

    // Structural, not incidental: there is no filename parameter for anyone to pass one to.
    expect(storedResumeFilename).toHaveLength(2);

    // If either of these ever stops holding, the names above are no longer hostile and this
    // test is guarding nothing — read it again rather than deleting it.
    expect(path.win32.extname('resume.txt:evil')).toBe('.txt:evil');
    expect(path.win32.extname(`resume.${'y'.repeat(300)}`)).toHaveLength(301);
  });

  it('gives an unsupported type no extension rather than a guessed one', () => {
    expect(extensionForMime('application/octet-stream')).toBe('');
    expect(extensionForMime('text/html')).toBe('');
  });
});

/**
 * The same property, asked of the ROUTE — which is where the bug actually was.
 *
 * Everything above exercises `storedResumeFilename`, and the fix was not in
 * `storedResumeFilename`: it was in `routes/resumes.ts`, which used to build the path with
 * `path.extname(file.filename)`. Reverting that one line to its vulnerable form and running
 * the entire server suite left all 1,919 tests green. A helper can be perfect while nothing
 * calls it.
 *
 * So this drives a real multipart upload through the real route and looks at what landed on
 * disk. `vitest.setup.ts` points DATA_DIR at a fresh temp directory per test file, so the
 * files written here are disposable.
 */
describe('what POST /api/resumes actually writes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    runMigrations();
    app = await buildApp({ skipAuth: true });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  const upload = async (filename: string, body: string) => {
    const boundary = '----iaStoredNameTest';
    const payload = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
          'Content-Type: text/plain\r\n\r\n',
      ),
      Buffer.from(body, 'utf8'),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    return app.inject({
      method: 'POST',
      url: '/api/resumes',
      headers: {
        host: '127.0.0.1:8787',
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload,
    });
  };

  const uploadedName = async (filename: string): Promise<string> => {
    const res = await upload(filename, 'Eric Dean');
    expect(res.statusCode, res.body).toBe(201);
    return (res.json() as { filename: string }).filename;
  };

  const storedNames = (): string[] =>
    existsSync(config.paths.resumes) ? readdirSync(config.paths.resumes) : [];

  it('names the file by its type, whatever the upload was called', async () => {
    const before = storedNames().length;
    const res = await upload('resume.txt:evil', 'Eric Dean — Half Moon Bay');
    expect(res.statusCode).toBe(201);

    const written = storedNames();
    expect(written).toHaveLength(before + 1);
    // A ULID and one of the four extensions, and nothing else. On Windows the old code put
    // this content into an NTFS alternate data stream and left a 0-byte `<id>.txt` here.
    for (const name of written) {
      expect(name, name).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}\.(pdf|docx|md|txt)$/);
      expect(name).not.toContain(':');
      expect(statSync(path.join(config.paths.resumes, name)).size).toBeGreaterThan(0);
    }
  });

  it('keeps the name the student chose, because that is what they will recognise', async () => {
    // The stored path is not the filename: the original is kept in the row and is what the
    // interface shows. Refusing the upload, or renaming it in the UI, would be a worse answer
    // than the bug.
    const res = await upload('My CV (final) 2027.txt', 'Eric Dean');
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ filename: 'My CV (final) 2027.txt' });
  });

  it('is not fooled by an extension long enough to break the write', async () => {
    // 300 characters of extension made the old code throw ENOENT and 500 the upload.
    const res = await upload(`resume.${'y'.repeat(300)}`, 'Eric Dean');
    // The type is decided by the MIME, so this is an ordinary .txt and simply works.
    expect(res.statusCode).toBe(201);
    for (const name of storedNames()) expect(name.length).toBeLessThan(64);
  });

  /**
   * The OTHER name — the one an employer's form receives.
   *
   * The stored path is a ULID by design, and `core/filling` attaches the file BY THAT PATH,
   * so the name arriving at the employer was `01M21C4W42ZZYMRE4SP4QRKJ50.pdf`. The only copy
   * of the name a human would recognise is `resume_document.filename`, which makes that
   * column the attachment name and therefore a string another system writes down — while it
   * was being stored exactly as the multipart field sent it.
   *
   * The tests above pin what a hostile name cannot do to OUR filesystem. These pin the same
   * property one hop further out, plus the plainer failure: an upload widget filtering on
   * ".pdf,.docx" refuses a file called `resume`, and the type here comes from the MIME, so
   * that name uploads perfectly happily.
   */
  it('gives the attachment the extension its validated type earns', async () => {
    // Accepted on the strength of its Content-Type, with no extension anywhere in the name.
    expect(await uploadedName('resume')).toBe('resume.txt');
    // Already correct, so untouched — including the case the student chose.
    expect(await uploadedName('Resume.TXT')).toBe('Resume.TXT');
  });

  it('hands the employer nothing it refused to write here', async () => {
    // Left of a separator is a path, not a name; a file picker cannot send one, and this is
    // an HTTP endpoint where the filename is just a string somebody writes.
    expect(await uploadedName('../../etc/passwd.txt')).toBe('passwd.txt');
    expect(await uploadedName(String.raw`C:\Users\eric\resume.txt`)).toBe('resume.txt');
    // The colon that stored a resume in an NTFS alternate data stream here, aimed this time
    // at whatever the employer's server saves the attachment to.
    expect(await uploadedName('resume.txt:evil')).not.toContain(':');
    // Windows drops a trailing dot or space and unix-likes hide a leading dot, so in either
    // case the name that lands is not the name that was sent.
    expect(await uploadedName('resume.txt ')).toBe('resume.txt');
    expect(await uploadedName('.resume.txt')).toBe('resume.txt');
    // A name that is nothing at all still has to be something.
    expect(await uploadedName('')).toBe('resume.txt');
    // Bounded: 307 characters is over the limit of nearly every filesystem it may land on.
    const long = await uploadedName(`resume.${'y'.repeat(300)}`);
    expect(long.length).toBeLessThanOrEqual(120);
    expect(long.endsWith('.txt')).toBe(true);
  });

  it('leaves the last extension the one the bytes actually are', async () => {
    // U+202E RIGHT-TO-LEFT OVERRIDE: file listings render this name as "resumeexe.pdf".
    // Asserted by property rather than by string, because what a multipart header does to a
    // non-ASCII byte on the way in is busboy's business and not what this is about.
    const spoofed = await uploadedName('resume\u202Efdp.exe');
    expect(spoofed).not.toContain('\u202E');
    expect(spoofed.endsWith('.txt')).toBe(true);
  });

  /**
   * Which of the uploaded resumes the next fill attaches.
   *
   * `isPrimary` was set to "nothing else claims it", which is true only of the FIRST upload
   * ever. A student who found a typo, fixed it and re-uploaded went on attaching the original
   * to every form — and nothing in apps/web calls `POST /api/resumes/:id/primary`, so there
   * was no way to correct it from the interface at all.
   *
   * Both directions matter here: the newest has to win, AND exactly one row may claim it.
   * `is_primary` has no uniqueness behind it, and the fill route takes whichever
   * `.find((r) => r.isPrimary)` reaches first — so two primaries is the same bug wearing a
   * different hat, with the outcome decided by an order SQLite never promised.
   */
  const listed = async (): Promise<{ id: string; isPrimary: boolean; filename: string }[]> => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/resumes',
      headers: { host: '127.0.0.1:8787' },
    });
    expect(res.statusCode).toBe(200);
    return res.json() as { id: string; isPrimary: boolean; filename: string }[];
  };

  const idOf = async (filename: string): Promise<string> => {
    const res = await upload(filename, 'Eric Dean');
    expect(res.statusCode, res.body).toBe(201);
    return (res.json() as { documentId: string }).documentId;
  };

  const remove = async (id: string) => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/resumes/${id}`,
      headers: { host: '127.0.0.1:8787' },
    });
    expect(res.statusCode).toBe(204);
  };

  it('makes the newest upload the one that gets attached', async () => {
    db.delete(schema.resumeDocument).run();
    const first = await idOf('first.txt');
    const second = await idOf('second.txt');
    const third = await idOf('third.txt');

    expect((await listed()).filter((r) => r.isPrimary).map((r) => r.id)).toEqual([third]);
    expect([first, second]).not.toContain(third);
  });

  it('promotes the newest survivor when the attached one is deleted', async () => {
    db.delete(schema.resumeDocument).run();
    const first = await idOf('first.txt');
    const second = await idOf('second.txt');
    await remove(second);

    // Not "leaves none", which made the fill report a skipped upload field with "No file to
    // attach" — honest, and easy to miss on a form with thirty rows.
    expect((await listed()).filter((r) => r.isPrimary).map((r) => r.id)).toEqual([first]);
  });

  it('leaves the attached one alone when a different resume is deleted', async () => {
    db.delete(schema.resumeDocument).run();
    const first = await idOf('first.txt');
    const second = await idOf('second.txt');
    await remove(first);

    expect((await listed()).filter((r) => r.isPrimary).map((r) => r.id)).toEqual([second]);
  });

  it('heals a table that arrived here with no primary at all', async () => {
    // The state every database written under the old rule is in if its primary was ever
    // deleted: rows, none of them attachable, and no upload could claim the flag either.
    db.delete(schema.resumeDocument).run();
    const first = await idOf('first.txt');
    const second = await idOf('second.txt');
    const third = await idOf('third.txt');
    db.update(schema.resumeDocument).set({ isPrimary: false }).run();
    expect((await listed()).some((r) => r.isPrimary)).toBe(false);

    await remove(first);
    expect((await listed()).filter((r) => r.isPrimary).map((r) => r.id)).toEqual([third]);
    expect(second).not.toBe(third);
  });

  it('still lets the user name one, and does not leave two', async () => {
    db.delete(schema.resumeDocument).run();
    const first = await idOf('first.txt');
    await idOf('second.txt');
    const res = await app.inject({
      method: 'POST',
      url: `/api/resumes/${first}/primary`,
      headers: { host: '127.0.0.1:8787' },
    });
    expect(res.statusCode).toBe(200);
    expect((await listed()).filter((r) => r.isPrimary).map((r) => r.id)).toEqual([first]);
  });
});
