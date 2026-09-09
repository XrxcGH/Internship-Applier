import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { desc, eq } from 'drizzle-orm';
import { ulid } from 'ulid';
import { config } from '../config';
import { db, schema } from '../infra/db/client';
import { encryptField } from '../infra/crypto/fieldCrypto';
import { describeAccess, NoModelAccessError } from '../infra/llm';
import {
  extractText,
  mimeFromFilename,
  storedResumeFilename,
  SUPPORTED_MIME,
} from '../core/ingestion/extractText';
import { extractResume } from '../core/ingestion/extractProfile';
import { toDraftProfile } from '../core/ingestion/toProfile';
import { getProfileHeader, getUserEnteredFacts, saveProfile } from '../core/profile/repository';
import { sweepApprovals } from './profile';
import { logger } from '../infra/logger';

const MAX_BYTES = 12 * 1024 * 1024;

export async function resumeRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/resumes', async (req, reply) => {
    const file = await req.file({ limits: { fileSize: MAX_BYTES } });
    if (!file) {
      return reply
        .code(400)
        .send({ error: { code: 'VALIDATION_FAILED', message: 'No file in the request.' } });
    }

    const mime = SUPPORTED_MIME.has(file.mimetype)
      ? file.mimetype
      : mimeFromFilename(file.filename);

    if (!SUPPORTED_MIME.has(mime)) {
      return reply.code(400).send({
        error: {
          code: 'VALIDATION_FAILED',
          message: `Unsupported file type. Accepted: PDF, DOCX, TXT, Markdown.`,
        },
      });
    }

    const bytes = await file.toBuffer();
    const id = ulid();
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    // The extension comes from the validated type, never from the name the student's file
    // arrived under. See `extensionForMime` for what a name was able to do to this path.
    const stored = path.join(config.paths.resumes, storedResumeFilename(id, mime));

    await mkdir(config.paths.resumes, { recursive: true });
    await writeFile(stored, bytes, { mode: 0o600 });

    /**
     * A failure here is not a fallback, whatever this line used to say.
     *
     * It logged "will rely on the model", which is true for a PDF — those are passed to the
     * model as bytes and `extractText` returns null for them WITHOUT throwing. So this catch
     * cannot fire for a PDF at all. It fires only for DOCX, TXT and Markdown, and for exactly
     * those the extractor refuses outright rather than falling back: with no text there is
     * nothing to send. The one message this branch could ever print described the one case it
     * could never be printed for.
     *
     * The upload is still accepted and the text stored as null, because the failure is worth
     * seeing at extraction time — where the student is told, in a sentence naming the file —
     * rather than as a rejected upload that leaves them guessing which of the two steps broke.
     */
    const text = await extractText(stored, mime).catch((err: unknown) => {
      logger.warn(
        { err, mime, filename: file.filename },
        'could not read any text out of this document; extraction will refuse it',
      );
      return null;
    });

    db.insert(schema.resumeDocument)
      .values({
        id,
        filename: file.filename,
        path: encryptField(stored, id),
        mime,
        bytes: bytes.byteLength,
        sha256,
        rawText: text ? encryptField(text, id) : null,
        // Primary when nothing else claims it — not merely when the table is empty.
        // That older test left the app with no primary at all after the primary was
        // deleted, and no later upload could ever become one.
        isPrimary: !db
          .select()
          .from(schema.resumeDocument)
          .all()
          .some((r) => r.isPrimary),
      })
      .run();

    return reply.code(201).send({ documentId: id, filename: file.filename, mime, sha256 });
  });

  app.get('/api/resumes', async () => {
    return db
      .select({
        id: schema.resumeDocument.id,
        filename: schema.resumeDocument.filename,
        mime: schema.resumeDocument.mime,
        bytes: schema.resumeDocument.bytes,
        isPrimary: schema.resumeDocument.isPrimary,
        createdAt: schema.resumeDocument.createdAt,
      })
      .from(schema.resumeDocument)
      .all();
  });

  /**
   * Runs extraction and produces a DRAFT profile. Nothing downstream can read it until
   * the user confirms at gate G1.
   */
  app.post<{ Params: { id: string } }>('/api/resumes/:id/extract', async (req, reply) => {
    /**
     * Reading a resume needs SOME model, and no longer a particular one.
     *
     * This used to demand an Anthropic API key outright, because extraction called the SDK
     * directly rather than going through the backend seam. Someone with a Claude Code
     * subscription saw a model-access screen reporting "connected", uploaded a resume, and
     * was told to add a key in Settings — where no key field exists. No extraction means no
     * profile, no profile means no G1, and everything downstream is gated on G1, so the tool
     * stopped dead on its first screen with a sentence that could not be acted on.
     *
     * Extraction now runs on the same seam as drafting, so the only question left is whether
     * any backend is reachable at all — and the answer to that names whichever one the user
     * has, rather than assuming the answer is an API key.
     */
    const access = await describeAccess();
    if (!access.available) {
      // With LLM_PROVIDER=none the resolver short-circuits before it ever looks at the CLI
      // or a key, so "sign in to the CLI" and "set ANTHROPIC_API_KEY" are both no-ops here —
      // the only action that changes anything is flipping the switch back. Give that advice
      // in that state, and the CLI/key advice in every other state where it does apply.
      // `access.description` has already said WHICH state this is; the advice says what to do
      // about it and must not say the state over again. The `none` branch opened with "Model
      // calls are switched off" behind a description reading "Model calls are switched off
      // (LLM_PROVIDER=none)", so the one screen a blocked user reads told them the same thing
      // twice and gave the impression of a message assembled rather than written.
      const advice =
        config.llm.provider === 'none'
          ? 'Set LLM_PROVIDER=auto (or remove the line) in the .env file at the root of this ' +
            'project and restart the server.'
          : 'Either sign in to the Claude Code CLI by running `claude` once in a terminal, ' +
            'or set ANTHROPIC_API_KEY in the .env file at the root of this project and ' +
            'restart the server.';
      // "without either" needs the two things the sentence before it offered. The switched-off
      // branch offers one, and the word pointed at nothing.
      const tail =
        config.llm.provider === 'none'
          ? 'Everything else — matching, eligibility, the writing checks — works without a model.'
          : 'Everything else — matching, eligibility, the writing checks — works without either.';
      return reply.code(400).send({
        error: {
          code: 'NO_MODEL_ACCESS',
          message: `Reading a resume needs a model, and none is reachable. ${access.description} ${advice} ${tail}`,
        },
      });
    }

    const rows = db
      .select()
      .from(schema.resumeDocument)
      .where(eq(schema.resumeDocument.id, req.params.id))
      .all();
    const doc = rows[0];
    if (!doc) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'No such document.' } });
    }

    const { decryptField } = await import('../infra/crypto/fieldCrypto');
    const filePath = decryptField(doc.path, doc.id);

    /**
     * The stored file, checked before anything reads it.
     *
     * `extractResume` stats the decrypted path, so a resume whose file has been moved,
     * deleted by a cleaner, or lost to a restored backup threw ENOENT — and the catch below
     * flattened that into a 502 carrying `err.message`, which for ENOENT is the ABSOLUTE PATH
     * of the file. That is a filesystem layout handed to whatever is reading the response, in
     * an error the user can do nothing with. 409 rather than 404: the document row exists, it
     * is the bytes behind it that are gone, and the fix is to upload it again.
     */
    if (!existsSync(filePath)) {
      logger.warn({ documentId: doc.id }, 'stored resume file is missing');
      return reply.code(409).send({
        error: {
          code: 'NOT_FOUND',
          message:
            `The stored copy of "${doc.filename}" is no longer on this machine, so it cannot ` +
            'be read again. Upload the file once more.',
        },
      });
    }
    const text = doc.rawText ? decryptField(doc.rawText, doc.id) : undefined;

    try {
      const extraction = await extractResume({ path: filePath, mime: doc.mime, text });
      // The id, read straight off the columns without decrypting anything.
      //
      // Loading the whole profile to get it meant a stored row that no longer parses took
      // down the one request that would have replaced it: a single unusable field — a
      // year-only graduation date, a link with no scheme — threw here, came back as a 502,
      // and made the promise the error itself makes ("Re-uploading your resume will rebuild
      // the profile") untrue. That property still holds below, where the user's own answers
      // are read column by column and any that will not parse is simply left behind.
      const existing = getProfileHeader();
      const draft = toDraftProfile(extraction);
      /**
       * Merged over the draft, not replaced by it.
       *
       * This carried across exactly one field — the id — so re-uploading a resume silently
       * destroyed the date of birth, the work authorization, the citizenships, the
       * availability window, the chosen role families, every additional work location and
       * every preference. Those are the facts G1 exists to collect and precisely the ones a
       * resume cannot restate, and the control that did it is offered on the confirm step as
       * "Upload a different resume" — a phrase that promises a better reading of the same
       * person, not the loss of everything they typed.
       *
       * `getUserEnteredFacts` parses those columns one at a time and omits any that will not
       * parse, so the property the header-only read was protecting still holds: no stored
       * value can block a re-extraction.
       */
      const kept = existing ? (getUserEnteredFacts() ?? {}) : {};
      /**
       * `locationPrefs` is merged a level deeper, and the order of these keys is load-bearing.
       *
       * `getUserEnteredFacts` returns that object with `base` deliberately removed — the new
       * resume is the better evidence for where somebody lives — so a shallow spread REPLACED
       * the draft's whole `locationPrefs` with a base-less one. `base` is required by the
       * schema and `saveProfile` parses before it writes, so every re-upload over an existing
       * profile failed with "The fields at fault: locationPrefs.base", which is the exact
       * outcome the comment above promises cannot happen. The explicit key must come AFTER
       * `...kept` or the spread overwrites it again and nothing changes.
       */
      // Re-extraction keeps the existing id so history and foreign keys survive.
      const saved = saveProfile(
        existing
          ? {
              ...draft,
              ...kept,
              locationPrefs: { ...draft.locationPrefs, ...(kept.locationPrefs ?? {}) },
              id: existing.id,
            }
          : draft,
      );
      /**
       * The same approval sweep PUT /api/profile runs, because this is the same event by a
       * different door — and the more violent version of it, since a re-extraction replaces
       * every fact at once rather than editing one.
       *
       * Without it, an answer approved at G3 against the old profile kept its green tick and
       * an evidence panel quoting entries the new extraction had not produced. Nothing
       * false-green reached an employer: `load()` in routes/filling.ts re-checks before a key
       * is pressed and refuses. But it refused at the form, minutes later, on a card that had
       * been telling the user all along that the answer was fine — so the tool looked like it
       * had lost their approvals rather than like it had noticed something.
       *
       * The key is spelled the same way PUT /api/profile spells it, on purpose: the wizard
       * and the upload screen both need to say the same sentence to the user, and a client
       * reading two different shapes for one fact would end up saying it in only one place.
       */
      const withdrawnApprovals = sweepApprovals(saved, 'resume_reextracted');
      return { profile: saved, needsReview: saved.needsReview, withdrawnApprovals };
    } catch (err) {
      logger.error({ err }, 'resume extraction failed');
      // A no-model failure carries a message written for the user (sign in, set a key) and
      // is not an internal error — flattening it to a 502 INTERNAL both mislabels it and
      // drops that guidance. The signed-out CLI reaches here on a machine that also has a
      // key, because the pre-call guard sees the CLI as available and only the real call
      // reveals it is not; the seam then falls through to the key, but if even the key is
      // gone this is where the user must be told. Answer drafting already returns 503
      // NO_MODEL_ACCESS for the same case; match it.
      if (err instanceof NoModelAccessError) {
        return reply.code(503).send({ error: { code: 'NO_MODEL_ACCESS', message: err.message } });
      }
      /**
       * A generic failure says so generically, and the detail goes to the log.
       *
       * This returned `err.message` verbatim, which for anything thrown by the filesystem is
       * an absolute path and for anything thrown by a parser is an internal shape. The user
       * can act on neither, and the response is the wrong place for both — the log above
       * already has the error in full, with its stack.
       */
      return reply.code(502).send({
        error: {
          code: 'INTERNAL',
          message:
            `Reading "${doc.filename}" did not finish. The server log has the details. Try ` +
            'again, or upload the file in a different format.',
        },
      });
    }
  });
  /** Which resume gets attached to applications by default. */
  app.post<{ Params: { id: string } }>('/api/resumes/:id/primary', async (req, reply) => {
    const row = db
      .select({ id: schema.resumeDocument.id })
      .from(schema.resumeDocument)
      .where(eq(schema.resumeDocument.id, req.params.id))
      .all()[0];
    if (!row) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'No such document.' } });
    }
    db.update(schema.resumeDocument).set({ isPrimary: false }).run();
    db.update(schema.resumeDocument)
      .set({ isPrimary: true })
      .where(eq(schema.resumeDocument.id, req.params.id))
      .run();
    return { id: req.params.id, isPrimary: true };
  });

  /** Deletes the row AND the file on disk — see docs/10 § User control. */
  app.delete<{ Params: { id: string } }>('/api/resumes/:id', async (req, reply) => {
    const row = db
      .select()
      .from(schema.resumeDocument)
      .where(eq(schema.resumeDocument.id, req.params.id))
      .all()[0];
    if (!row) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'No such document.' } });
    }
    try {
      const { decryptField } = await import('../infra/crypto/fieldCrypto');
      await rm(decryptField(row.path, row.id), { force: true });
    } catch (err) {
      logger.warn({ err, id: row.id }, 'could not remove resume file; removing the row anyway');
    }
    db.delete(schema.resumeDocument).where(eq(schema.resumeDocument.id, req.params.id)).run();

    /**
     * Something has to be primary if anything is left.
     *
     * Deleting the primary used to leave none, and the fill run then had no resume to
     * attach — reported as a skipped field with "No file to attach", which is honest but
     * easy to miss on a form with thirty rows. The most recent survivor is promoted.
     */
    if (row.isPrimary) {
      const next = db
        .select()
        .from(schema.resumeDocument)
        .orderBy(desc(schema.resumeDocument.createdAt))
        .all()[0];
      if (next) {
        db.update(schema.resumeDocument)
          .set({ isPrimary: true })
          .where(eq(schema.resumeDocument.id, next.id))
          .run();
      }
    }

    return reply.code(204).send();
  });
}
