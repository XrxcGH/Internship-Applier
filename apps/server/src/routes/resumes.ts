import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { desc, eq } from 'drizzle-orm';
import { ulid } from 'ulid';
import { config } from '../config';
import { db, schema, sqlite } from '../infra/db/client';
import { encryptField } from '../infra/crypto/fieldCrypto';
import { describeAccess, NoModelAccessError } from '../infra/llm';
import {
  extensionForMime,
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

/** Long enough for any name a person types, short enough for every filesystem it may land on. */
const MAX_ATTACHMENT_NAME = 120;

/**
 * The name an employer's form will receive this file under — which is NOT the name it is
 * stored under.
 *
 * `storedResumeFilename` deliberately throws the student's name away when it builds the path,
 * for the reasons written on it, so this column is the ONLY surviving copy of the name they
 * would recognise and it is the one the attachment has to carry. That makes it a name another
 * system will write down, and the raw multipart field is not obliged to be one:
 *
 *   - `resume`, with no extension at all — the type is decided by the MIME, not the name, so
 *     this uploads fine and is then refused by every upload widget filtering on ".pdf,.docx";
 *   - `resume.txt:evil`, the same colon that once stored a resume in an NTFS alternate data
 *     stream here, pointed this time at whatever the employer's server saves it to;
 *   - `../../etc/passwd.pdf`, which a file picker cannot produce but this endpoint can: it is
 *     HTTP, and the multipart filename is just a string somebody sends;
 *   - `resume<U+202E>fdp.exe`, which most file listings render as `resumeexe.pdf`;
 *   - 300 characters of name, over the limit of nearly everything it will land on.
 *
 * Ordinary names go through untouched, because the point of keeping it is recognition: "My CV
 * (final) 2027.txt" is what the student will look for in their own folder, and renaming it for
 * them would be a worse answer than the bug.
 */
function attachmentFilename(raw: string | undefined, mime: string): string {
  const ext = extensionForMime(mime);
  // A separator means everything before it was a path, not a name. `pop()` on a split is the
  // same last-segment rule `path.basename` applies, minus the platform disagreement about
  // whether a backslash separates anything.
  const base = (raw ?? '').split(/[\\/]/).pop() ?? '';
  const cleaned = base
    // Control characters, and the format characters that reorder what a name LOOKS like.
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    // Reserved on Windows; ':' also starts an alternate data stream.
    .replace(/[:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    // Windows silently drops a trailing dot or space and unix-likes hide a leading dot, so in
    // either case the name that lands is not the name that was sent.
    .replace(/^[. ]+/, '')
    .replace(/[. ]+$/, '');
  const named = cleaned === '' ? 'resume' : cleaned;
  const room = MAX_ATTACHMENT_NAME - ext.length;
  const capped =
    named.length > room ? named.slice(0, room).replace(/[. ]+$/, '') || 'resume' : named;
  // The extension follows the type the bytes were VALIDATED as, so the form's filter accepts
  // it and the employer's reader opens it with the right thing.
  return capped.toLowerCase().endsWith(ext) ? capped : `${capped}${ext}`;
}

/**
 * The row goes in, and it is the primary one; whatever was primary before is not any more.
 *
 * This used to be `isPrimary: nothing else claims it`, which is true only of the FIRST upload
 * ever. A student who fixed a typo, re-uploaded and carried on applying kept attaching the
 * original file to every form afterwards — and nothing in the interface can undo that:
 * `POST /api/resumes/:id/primary` exists and apps/web has never called it, so the first file
 * they ever chose was the one every employer received, permanently.
 *
 * The newest upload wins, which is the rule the delete branch below already follows when it
 * promotes a survivor. The two now agree: the most recent resume is the one this tool
 * attaches unless the user names another through the endpoint above.
 *
 * Both statements together, because `is_primary` is a plain column with no uniqueness behind
 * it. Inserting a second primary without clearing the first leaves two, and the fill route
 * takes whichever `.find((r) => r.isPrimary)` reaches first — an order SQLite never promised.
 */
const insertAsPrimary = sqlite.transaction((row: typeof schema.resumeDocument.$inferInsert) => {
  db.update(schema.resumeDocument).set({ isPrimary: false }).run();
  db.insert(schema.resumeDocument)
    .values({ ...row, isPrimary: true })
    .run();
});

/**
 * The sentence a failure wrote for the student, or nothing.
 *
 * Extraction fails in ways somebody sat down and wrote an answer to — "This .docx unpacks to
 * 394MB… Export it again from your word processor, or save it as a PDF", "This resume is
 * longer than one reading can return… Try the shorter version" — and the catch below replaced
 * all of them with one fixed sentence ending "Try again", which for every one of these is
 * advice that fails identically forever. That is the same defect `extractProfile.ts` names in
 * its own comment about the max_tokens branch, one layer further out.
 *
 * The reason it flattened them was real, and is kept: `err.message` from the filesystem is an
 * ABSOLUTE PATH, and from a parser an internal shape. Neither can be handed to a user. So this
 * separates the two structurally rather than by trusting the thrower:
 *
 *   - exactly `Error`, never a subclass — a ZodError's message is a dump of its issues, a
 *     SyntaxError from JSON.parse names a byte offset, an HttpError describes a request;
 *   - none of the properties Node hangs on a system error, whose message is the syscall and
 *     the path: "ENOENT: no such file or directory, open 'C:\\Users\\…\\01J….pdf'";
 *   - one line, sentence-length, and carrying no separator — which is what a path is made of.
 *
 * Everything authored above passes; the one message in these modules that does not is
 * `Unsupported document type: ${mime}`, whose slash comes from the MIME. That one describes an
 * upstream type check having been fooled, so falling back to the generic sentence is right.
 * The bias is deliberate: an authored message that stops matching these rules degrades to the
 * generic one, and a path never becomes a message.
 */
function authoredMessage(err: unknown): string | undefined {
  if (!(err instanceof Error)) return undefined;
  if (Object.getPrototypeOf(err) !== Error.prototype) return undefined;
  const sys = err as { code?: unknown; errno?: unknown; syscall?: unknown; path?: unknown };
  if (
    sys.code !== undefined ||
    sys.errno !== undefined ||
    sys.syscall !== undefined ||
    sys.path !== undefined
  ) {
    return undefined;
  }
  const message = err.message.trim();
  if (message === '' || message.length > 400) return undefined;
  if (/[\n\r\\/]/.test(message)) return undefined;
  return message;
}

/**
 * How a document that could not be read is reported, either way.
 *
 * The opening clause is the same in both branches on purpose — it names the file, which is the
 * one thing the student needs when three uploads are in flight — so the two replies differ
 * only in the part that carries information.
 *
 * 422 rather than 502 for the authored ones: "bad gateway" tells a client something upstream
 * had a blip and the request is worth repeating, and every message that reaches this branch is
 * a deterministic property of the file or of its length. Nothing about repeating it changes.
 */
function unreadable(
  filename: string,
  err: unknown,
): { status: number; body: { error: { code: string; message: string } } } {
  const authored = authoredMessage(err);
  const opening = `Reading "${filename}" did not finish.`;
  return authored
    ? {
        status: 422,
        body: { error: { code: 'VALIDATION_FAILED', message: `${opening} ${authored}` } },
      }
    : {
        status: 502,
        body: {
          error: {
            code: 'INTERNAL',
            message: `${opening} The server log has the details. Try again, or upload the file in a different format.`,
          },
        },
      };
}

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
    // Two names, for two jobs: this one is shown to the student and attached to the form, the
    // one below is where the bytes go. See `attachmentFilename` for why they are not the same
    // string and why neither is `file.filename` verbatim.
    const filename = attachmentFilename(file.filename, mime);
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
     *
     * That promise was not being kept, and could not be from here: the message below goes to
     * the log, the row keeps a null, and extraction had nothing to say but its own generic
     * "No text could be read from this document." The extract route reads the file again when
     * it finds that null, which is what carries these sentences — the ones that say to export
     * the .docx again or save it as a PDF — to the person actually holding the file.
     */
    const text = await extractText(stored, mime).catch((err: unknown) => {
      logger.warn(
        { err, mime, filename },
        'could not read any text out of this document; extraction will read it again and refuse it',
      );
      return null;
    });

    insertAsPrimary({
      id,
      filename,
      path: encryptField(stored, id),
      mime,
      bytes: bytes.byteLength,
      sha256,
      rawText: text ? encryptField(text, id) : null,
    });

    return reply.code(201).send({ documentId: id, filename, mime, sha256 });
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
    let text = doc.rawText ? decryptField(doc.rawText, doc.id) : undefined;

    /**
     * Read again here when the upload stored no text, which is the only way the sentence
     * explaining WHY it could not be read ever reaches the person holding the file.
     *
     * The upload above accepts the file and logs the failure, saying the student "is told, in
     * a sentence naming the file" at this step. They were not: with `rawText` null,
     * `extractResume` throws its own generic "No text could be read from this document", and
     * the four authored sentences that actually say what to do about a .docx — export it
     * again, save it as a PDF, upload the resume rather than an archive of one — died in the
     * log at upload time and were never anywhere the student could see them.
     *
     * PDFs are excluded because `extractText` returns null for them WITHOUT failing: they go
     * to the model as bytes, so no stored text is the normal case rather than a failure.
     *
     * Doing the read again also makes the "Try again" the old reply offered true for once: a
     * transient failure at upload — a descriptor exhausted, a file still being written by the
     * syncing client that put it there — poisoned the document permanently, because nothing
     * ever revisited that null and the only cure was uploading the same file a second time.
     */
    if (!text?.trim() && doc.mime !== 'application/pdf') {
      try {
        text = (await extractText(filePath, doc.mime)) ?? undefined;
      } catch (err) {
        logger.warn({ err, documentId: doc.id }, 'the stored document still yields no text');
        const failure = unreadable(doc.filename, err);
        return reply.code(failure.status).send(failure.body);
      }
    }

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
       * A failure that wrote its own sentence keeps it; everything else says so generically
       * and leaves the detail in the log above, which has it in full and with its stack.
       *
       * This returned `err.message` verbatim once — an absolute path, for anything thrown by
       * the filesystem — and then nothing but the generic sentence, which threw away every
       * message written to be read. `authoredMessage` is the difference between the two.
       */
      const failure = unreadable(doc.filename, err);
      return reply.code(failure.status).send(failure.body);
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
     *
     * Asked of the rows that remain rather than of the row just removed, so it also heals a
     * table that arrived here with no primary at all — which is the state every database
     * written before the upload rule was fixed is in, if its primary was ever deleted.
     *
     * The id breaks a tie on the timestamp. `created_at` is stamped to the millisecond, which
     * two uploads over HTTP will not share but two rows written by a test or a restore
     * certainly can, and a ULID sorts by the time it was minted — so this is the same
     * "newest" by a finer clock rather than a second rule.
     */
    const remaining = db
      .select()
      .from(schema.resumeDocument)
      .orderBy(desc(schema.resumeDocument.createdAt), desc(schema.resumeDocument.id))
      .all();
    const newest = remaining[0];
    if (newest && !remaining.some((r) => r.isPrimary)) {
      db.update(schema.resumeDocument)
        .set({ isPrimary: true })
        .where(eq(schema.resumeDocument.id, newest.id))
        .run();
    }

    return reply.code(204).send();
  });
}
