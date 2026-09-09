/**
 * Master key custody — see docs/10-security-privacy.md.
 *
 * The 256-bit field-encryption key lives in the OS credential store (Windows Credential
 * Manager / macOS Keychain / libsecret). It is never written to disk in plaintext and
 * never appears in a config file.
 *
 * If the OS store is not THERE — headless Linux without libsecret, CI — we fall back to a
 * keyfile with owner-only permissions and log a loud warning. Failing shut instead would
 * make the app unusable in exactly the environments where people run tests; failing
 * silently would be worse. So: fall back, but be noisy.
 *
 * A store that is there and will not answer is the opposite case and this file used to
 * treat it as the same one. A locked keychain, a denied prompt, an entry whose ACL no
 * longer matches: those mean a key we cannot see, not a key that does not exist, and the
 * fallback path ends in `randomBytes`. See `UnreadableKeychainError` and `mintKey` — no
 * branch here mints a key over a database that already holds ciphertext.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { config } from '../../config';
import { logger } from '../logger';

const SERVICE = 'internship-applier';

/**
 * Under NODE_ENV=test the key lives in its own account, never the user's.
 *
 * The credential store is keyed by service and account, so it does not follow DATA_DIR the
 * way every file this app writes does — and a test run that mints a key, or a "delete
 * everything" test that removes one, is operating on the developer's own installation.
 * vitest.setup.ts closes that off for anything loaded inside a Vitest worker by handing out
 * an in-memory stand-in. It cannot close it off for code that runs the module in a separate
 * process, which is the only way to check that the store is reachable under the runtime the
 * server actually starts with. A separate account name makes that safe wherever it runs from,
 * and costs a real user nothing.
 */
const ACCOUNT = config.isTest ? 'field-encryption-key.test' : 'field-encryption-key';
const KEY_BYTES = 32;

let cached: Buffer | null = null;

interface Entry {
  getPassword(): string | null;
  setPassword(v: string): void;
  deletePassword?(): boolean;
}

/**
 * The credential store, or the reason there isn't one.
 *
 * `absent` is the supported, boring case — a platform with no credential store to talk to.
 * Everything else is a fault on our side and is logged loudly, because the two used to be
 * the same silent `null` and that is how the bug below went unnoticed for so long.
 */
interface KeyStore {
  entry: Entry | null;
  absent: boolean;
}

const requireFromHere = createRequire(import.meta.url);

/**
 * Is the credential store genuinely not there, or did we fail to reach one that is?
 *
 * A ReferenceError, a TypeError or a SyntaxError is never the platform's fault — it is this
 * file's — so those always count as a failure worth shouting about. Only a missing module,
 * a native binding that will not load, or a message naming the platform's own secret service
 * counts as "this machine has no credential store", and anything unrecognised is treated as
 * our fault rather than the machine's, because being noisy about a working store is
 * recoverable and being quiet about a broken one is what put every user on a keyfile.
 */
function isStoreAbsent(err: unknown): boolean {
  if (err instanceof ReferenceError || err instanceof SyntaxError || err instanceof TypeError) {
    return false;
  }
  const code = (err as { code?: unknown }).code;
  if (
    code === 'MODULE_NOT_FOUND' ||
    code === 'ERR_MODULE_NOT_FOUND' ||
    code === 'ERR_DLOPEN_FAILED'
  ) {
    return true;
  }
  const message = err instanceof Error ? err.message : String(err);
  return /native binding|libsecret|secret service|dbus|no such (file|interface)/i.test(message);
}

/**
 * Opens the OS credential store, or explains why it could not.
 *
 * The load used to be a bare `require`, which does not exist in an ES module — and both
 * workspaces are `"type": "module"`, and the server runs under tsx. So this threw
 * `ReferenceError: require is not defined` on every single real start, the bare `catch`
 * turned that into "no credential store on this platform", and the master key went to the
 * plaintext keyfile that the docs describe as the fallback for headless Linux and CI. Every
 * user was on the fallback, on machines whose credential store worked perfectly, while the
 * header of this file told them their key was in the OS store. The suite never caught it
 * because Vitest gives modules a working `require` and the shipped runtime does not: any
 * check that a module loads has to run the way the app runs.
 */
function openKeyStore(): KeyStore {
  let Ctor: new (service: string, account: string) => Entry;
  try {
    ({ Entry: Ctor } = requireFromHere('@napi-rs/keyring') as {
      Entry: new (service: string, account: string) => Entry;
    });
  } catch (err) {
    if (isStoreAbsent(err)) {
      logger.debug({ err }, 'no OS credential store on this platform; using the keyfile fallback');
      return { entry: null, absent: true };
    }
    logger.error(
      { err },
      'the OS credential-store binding is installed but could not be loaded. This is a bug in ' +
        'this app, not a limitation of your machine: the master key is about to go to a ' +
        'plaintext keyfile that it did not need to go to.',
    );
    return { entry: null, absent: false };
  }

  try {
    return { entry: new Ctor(SERVICE, ACCOUNT), absent: false };
  } catch (err) {
    if (isStoreAbsent(err)) {
      logger.debug({ err }, 'no OS credential store on this platform; using the keyfile fallback');
      return { entry: null, absent: true };
    }
    logger.error({ err }, 'could not open the OS credential store entry for the master key');
    return { entry: null, absent: false };
  }
}

function keyfilePath(): string {
  return config.paths.masterKey;
}

/**
 * The tables whose every row carries at least one column only the master key can open.
 *
 * Named as tables rather than columns so the list cannot drift as columns are added:
 * `profile.full_name` and `profile.email` are NOT NULL and ENCRYPTED, as are
 * `resume_document.path` and `writing_sample.content`, so one row in any of them IS
 * ciphertext. See infra/db/schema.ts, where each column is marked.
 */
const TABLES_HOLDING_CIPHERTEXT = ['profile', 'resume_document', 'writing_sample'];

/**
 * Is there already something on this machine that a brand new key would orphan?
 *
 * Asked immediately before minting, because minting is the one irreversible act in this
 * file. Every other mistake here — the wrong storage location, a noisy warning, a refusal
 * to start — is recoverable by the user; a fresh random key written over a database sealed
 * under the old one takes their profile, their resume text and their writing samples with
 * it, and the first sign is an authentication failure with nothing attached that names a
 * cause.
 *
 * Opened read-write although nothing here writes: SQLite cannot open a WAL database
 * read-only unless the `-shm` sidecar already exists or can be created, and a spurious
 * "cannot tell" on a perfectly healthy database would be a refusal to start. This process
 * opens the same file read-write moments later anyway.
 */
function databaseHoldsCiphertext(): boolean {
  const file = config.paths.database;
  if (!fs.existsSync(file)) return false;

  let sqlite: InstanceType<typeof Database> | null = null;
  try {
    sqlite = new Database(file, { fileMustExist: true });
    sqlite.pragma('busy_timeout = 5000');
    const named = sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as {
      name: string;
    }[];
    const present = new Set(named.map((r) => r.name));
    for (const table of TABLES_HOLDING_CIPHERTEXT) {
      // Absent before the first migration, which is a genuinely empty install.
      if (!present.has(table)) continue;
      const row = sqlite.prepare(`SELECT count(*) AS n FROM "${table}"`).get() as { n: number };
      if (row.n > 0) return true;
    }
    return false;
  } catch (err) {
    // A database file that is there and will not answer is not a database that is empty,
    // and this is the same distinction the rest of the file turns on. Guessing "empty"
    // here would put the mint back one level down from where it was taken out.
    logger.error(
      { err, file },
      'could not check whether the database already holds encrypted data; assuming it does ' +
        'rather than risk replacing the key that opens it',
    );
    return true;
  } finally {
    try {
      sqlite?.close();
    } catch {
      /* Nothing left to do about it, and the caller's answer is already decided. */
    }
  }
}

/**
 * A brand new master key, which is only ever safe when there is nothing already sealed.
 *
 * Every path that mints goes through here, and that is the point: the reported failure came
 * in through the credential store, but `readFallbackKey` mints too, and it is reached by a
 * binding that will not load, by an `Entry` constructor that throws, and by a `setPassword`
 * that is refused. Guarding the branch someone happened to be looking at would have left
 * three other ways to the same fresh random key over the same sealed database.
 */
function mintKey(why: string): Buffer {
  if (databaseHoldsCiphertext()) throw new WouldOrphanStoredDataError(why);
  return randomBytes(KEY_BYTES);
}

/**
 * The keyfile, when the credential store is empty and we are about to adopt it.
 *
 * A keyfile of the wrong length throws for the same reason `readFallbackKey` does: it is a
 * key that exists and cannot be read, which is not the same as no key at all. Returning
 * null here would have sent the caller on to mint a fresh random key and store THAT in the
 * credential store, quietly abandoning every field already sealed under the real one. The
 * two read paths have to agree, or the guard only covers whichever one the machine happens
 * to take.
 *
 * The same rule decides what a read failure means, and it used to stop one step short.
 * "Missing" is the only condition that is genuinely no key at all; a file that is there and
 * will not open — locked by an editor, owned by another user, on a volume that just went
 * away — is a key we must not replace, and swallowing that error handed the caller a null
 * that read as a first run. Every field already sealed under that file would have been
 * abandoned for a fresh random key, because the file was busy for a second.
 */
function existingFallbackKey(): Buffer | null {
  const file = keyfilePath();

  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8').trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new UnreadableKeyfileError(file, err);
  }

  const key = Buffer.from(raw, 'base64');
  if (key.length !== KEY_BYTES) throw new CorruptKeyfileError(file);
  return key;
}

/**
 * The keyfile, minting one only if there is genuinely no key there.
 *
 * Reads through `existingFallbackKey` rather than repeating the checks. A truncated or
 * overwritten keyfile used to be handed back as-is from here. Nothing checked it, so the
 * first encryptField call died on `RangeError: Invalid key length` from deep inside
 * node:crypto — an error that names no file, offers no way forward, and appears on every
 * profile read and every resume upload. The file is almost always recoverable from a backup;
 * the user just has to be told which file it is. Two copies of that check drift apart, and
 * only the path a given machine happens to take is protected, so there is one copy.
 */
function readFallbackKey(): Buffer {
  const file = keyfilePath();
  const existing = existingFallbackKey();
  if (existing) return existing;

  const key = mintKey(
    `There is no usable master key in the OS credential store and none at ${file}`,
  );
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, key.toString('base64'), { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* best effort on Windows; ACLs are applied at the data/ level */
  }
  return key;
}

/**
 * The kind of error here that must never be swallowed.
 *
 * Distinct from "the credential store is unavailable", which is survivable and falls back
 * to a keyfile. A key of the wrong length means something wrote over ours, and generating
 * a replacement would abandon every field already encrypted under the real one.
 */
export class CorruptMasterKeyError extends Error {
  constructor() {
    super(
      'The master key in the OS credential store is not a valid key. This tool will not ' +
        'generate a replacement, because doing so would make everything already stored ' +
        'unreadable. Restore the credential-store entry, or delete your data and start again.',
    );
    this.name = 'CorruptMasterKeyError';
  }
}

/**
 * The same condition, one storage location over.
 *
 * The keyfile is not a lesser path — on any machine where the OS credential store is
 * unavailable it holds the only copy of the key — so a damaged one deserves the same care
 * as a damaged credential-store entry, and the same refusal to mint a replacement.
 */
export class CorruptKeyfileError extends Error {
  constructor(file: string) {
    super(
      `The master key file at ${file} is not a valid key. This tool will not generate a ` +
        'replacement, because doing so would make everything already stored unreadable. ' +
        'Restore that file from a backup, or delete your data and start again.',
    );
    this.name = 'CorruptKeyfileError';
  }
}

/**
 * The keyfile is there and will not open.
 *
 * Same family, same refusal. A file that exists and cannot be read is not an absent key, and
 * treating it as one — which is what swallowing the read error amounted to — mints a
 * replacement over the top of a key that was only ever locked for a moment.
 */
export class UnreadableKeyfileError extends Error {
  constructor(file: string, cause: unknown) {
    super(
      `The master key file at ${file} exists but could not be read: ` +
        `${cause instanceof Error ? cause.message : String(cause)}. This tool will not ` +
        'generate a replacement, because doing so would make everything already stored ' +
        'unreadable. Close anything holding that file open and try again.',
      { cause },
    );
    this.name = 'UnreadableKeyfileError';
  }
}

/**
 * The credential store answered the door and would not say anything.
 *
 * The distinction this class exists to draw: `getPassword()` returning null means there is
 * no key yet, and `getPassword()` THROWING means we do not know whether there is one. A
 * locked macOS login Keychain throws. So does a prompt the user dismissed, and so does an
 * entry whose ACL no longer matches the binary asking. All three used to land in the same
 * catch as "this platform has no credential store", and the reported consequence is the
 * worst thing in this file: a week-old install, key in the Keychain, no data/.master.key on
 * disk, one denied prompt — and the fallback path minted a fresh random key and started
 * writing under it, while the profile, the resume text and every writing sample stayed
 * sealed under the key still sitting in the Keychain, unreadable and unmentioned.
 *
 * Refusing costs an unlock and a restart. Guessing cost all of it.
 */
export class UnreadableKeychainError extends Error {
  constructor(cause: unknown) {
    super(
      'The master key could not be read from the OS credential store: ' +
        `${cause instanceof Error ? cause.message : String(cause)}. This tool will not ` +
        'generate a replacement, because anything already stored is encrypted under the key ' +
        'that store is holding. Unlock your keychain, or allow the access prompt, and start ' +
        'again.',
      { cause },
    );
    this.name = 'UnreadableKeychainError';
  }
}

/**
 * There is no key to be found, and there is already data that only a key opens.
 *
 * The other half of the same rule. Even a credential store that answers cleanly can answer
 * "empty" — an entry deleted by a keychain repair, a login item migrated to a new machine,
 * a profile moved between accounts — and a data directory full of ciphertext is then the
 * only remaining evidence that a key ever existed. Minting there is not a first run; it is
 * the same destruction arrived at politely.
 */
export class WouldOrphanStoredDataError extends Error {
  constructor(why: string) {
    super(
      `${why}, and this database already holds encrypted data. This tool will not generate a ` +
        'new key, because everything already stored was sealed under the old one and would ' +
        'become permanently unreadable. Restore the credential-store entry or the key file ' +
        'from a backup, or delete your data and start again.',
    );
    this.name = 'WouldOrphanStoredDataError';
  }
}

/**
 * Every error in this file that means "there is a key here and we must not overwrite it".
 *
 * Listed once, because the catch in `getMasterKey` re-throws these rather than treating them
 * as an unavailable credential store, and a list that names only the error someone happened
 * to be looking at leaves its siblings falling through to the fallback path — which is
 * exactly the path that mints a new key.
 */
const KEY_MUST_NOT_BE_REPLACED = [
  CorruptMasterKeyError,
  CorruptKeyfileError,
  UnreadableKeyfileError,
  UnreadableKeychainError,
  WouldOrphanStoredDataError,
];

function mustNotBeReplaced(err: unknown): boolean {
  return KEY_MUST_NOT_BE_REPLACED.some((E) => err instanceof E);
}

/**
 * The key is on disk in plaintext, and the user is told so every single start.
 *
 * Not downgraded to a one-time notice: the whole point of the credential store is that this
 * does not happen, and a warning that scrolls past once is how a fallback becomes permanent.
 *
 * `why` is a parameter rather than a fixed sentence because there is more than one way to
 * end up here, and the warning stated the commonest one as fact. Told "the OS credential
 * store was unavailable" by a machine whose credential store answers fine, a user goes
 * looking for a fault that is not there.
 */
function warnKeyfileInUse(why: string): void {
  logger.warn(
    { file: keyfilePath() },
    `USING A KEYFILE FOR FIELD ENCRYPTION. ${why}, so the master key sits on disk under ` +
      'data/ with owner-only permissions. Anyone who can read that directory can decrypt ' +
      'your profile.',
  );
}

/**
 * Reads the entry, keeping "there is no key" apart from "we could not look".
 *
 * A read that fails on a machine with no credential store to read is the supported fallback
 * case and stays on the old path: a headless Linux box answers `getPassword` with a d-bus or
 * secret-service failure, and failing shut there would make the app unusable in exactly the
 * environment the keyfile exists for. Anything else is a store that is present and would not
 * answer, and the one thing that must not follow is a new key.
 */
function readStoredKey(entry: Entry): string | null {
  try {
    return entry.getPassword();
  } catch (err) {
    if (isStoreAbsent(err)) throw err;
    throw new UnreadableKeychainError(err);
  }
}

export function getMasterKey(): Buffer {
  if (cached) return cached;

  const store = openKeyStore();
  if (store.entry) {
    const entry = store.entry;
    try {
      const existing = readStoredKey(entry);
      if (existing) {
        const key = Buffer.from(existing, 'base64');
        if (key.length !== KEY_BYTES) {
          logger.error('master key in the OS keychain has the wrong length; refusing to use it');
          throw new CorruptMasterKeyError();
        }

        /**
         * Two different keys, and only one of them can be the one the data is sealed under.
         *
         * A keyfile is only ever written by a run that had to fall back, and a run that fell
         * back encrypted everything it wrote under that file. So when both exist and differ,
         * the file is the key something on this machine is definitely sealed under, and the
         * credential-store entry may be sealing nothing at all — it is what a run under a
         * different data directory leaves behind. Preferring the store entry here would have
         * turned every name, email, phone number, date of birth, address and resume already
         * on disk into an authentication failure with no explanation attached.
         *
         * Neither copy is touched. Whichever one turns out to be wanted is still there, and
         * the message says where both live so the choice stays the user's.
         */
        const onDisk = existingFallbackKey();
        if (onDisk && !onDisk.equals(key)) {
          logger.error(
            { file: keyfilePath() },
            'the OS credential store and the master key file hold DIFFERENT keys. Using the ' +
              'file, because anything written while the credential store was unavailable is ' +
              'sealed under it. Neither key has been changed. If your data was written under ' +
              'the credential-store key instead, move the key file aside and restart.',
          );
          warnKeyfileInUse('The OS credential store holds a different key from the key file');
          cached = onDisk;
          return cached;
        }

        cached = key;
        return cached;
      }
      /**
       * An empty credential store is not necessarily a first run.
       *
       * The fallback keyfile is a supported path — headless, CI — so a profile can already
       * be encrypted under it by the time the store becomes usable.
       * Minting a fresh key here regardless meant name, email, phone, date of birth,
       * address and resume text all stopped decrypting the moment the keychain started
       * working, with nothing but an authentication failure to explain it. The keyfile is
       * left where it is: the credential store may not persist what we just wrote, and one
       * copy of the key is worth more than a tidy data directory. "Delete everything"
       * still removes both.
       */
      const adopted = existingFallbackKey();
      const key =
        adopted ??
        mintKey(
          `The OS credential store holds no master key and there is none at ${keyfilePath()}`,
        );
      entry.setPassword(key.toString('base64'));
      logger.info(
        adopted
          ? 'adopted the existing keyfile as the field-encryption key in the OS credential store'
          : 'generated a new field-encryption key in the OS credential store',
      );
      cached = key;
      return cached;
    } catch (err) {
      /**
       * A corrupt key is not an unavailable store, and it must not fall through.
       *
       * The throw above was inside this try, so "refusing to use it" was followed
       * immediately by minting a fresh random key in a keyfile — silently re-keying the
       * database. Every field written before that point (name, email, phone, date of
       * birth, address, resume text) becomes undecryptable while new writes succeed, and
       * nothing tells the user their data just became unreadable. Failing shut is the
       * only honest option: the old key may still be recoverable, and a mixed-key
       * database is not.
       */
      if (mustNotBeReplaced(err)) throw err;
      logger.warn({ err }, 'OS credential store unavailable; falling back to a keyfile');
    }
  }

  warnKeyfileInUse('The OS credential store was unavailable');
  cached = readFallbackKey();
  return cached;
}

/**
 * What became of the credential-store copy of the key.
 *
 * `absent` covers both "this platform has no credential store" and "there was no entry to
 * remove", which are the same thing from the user's side: nothing of theirs is left in it.
 * Only `unreachable` and `failed` are worth telling anyone about.
 */
export type KeychainDeletion = 'deleted' | 'absent' | 'unreachable' | 'failed';

/**
 * Destroys the master key everywhere it lives.
 *
 * "Delete everything" removed the keyfile but left the OS credential store untouched, so
 * on a machine where the keychain was available — the normal case — the key survived a
 * wipe that promised to take it. Everything encrypted with it stayed decryptable by the
 * next install.
 *
 * Best effort by design: a keychain that refuses is reported, not thrown, because the rest
 * of the deletion still needs to finish. Reported precisely, though — a plain false meant
 * that "nothing was there" and "we could not look" read identically, and every single
 * deletion ended by telling the user to go and remove a keychain entry by hand that in most
 * cases had never existed.
 */
export function deleteMasterKey(): { keychain: KeychainDeletion; keyfile: boolean } {
  let keychain: KeychainDeletion;
  const store = openKeyStore();
  if (!store.entry) {
    keychain = store.absent ? 'absent' : 'unreachable';
  } else if (!store.entry.deletePassword) {
    keychain = 'failed';
  } else {
    try {
      // `false` from the binding means there was no entry under this account to begin with.
      keychain = store.entry.deletePassword() ? 'deleted' : 'absent';
    } catch (err) {
      logger.warn({ err }, 'could not remove the master key from the OS credential store');
      keychain = 'failed';
    }
  }

  let keyfile = false;
  try {
    const file = keyfilePath();
    if (fs.existsSync(file)) {
      fs.rmSync(file, { force: true });
      keyfile = true;
    }
  } catch {
    keyfile = false;
  }

  cached = null;
  return { keychain, keyfile };
}
