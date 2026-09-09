import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config';
import {
  constantTimeEquals,
  decryptField,
  encryptField,
  isEncrypted,
} from '../src/infra/crypto/fieldCrypto';
import type * as KeychainModuleNS from '../src/infra/crypto/keychain';

/** The keychain module as it is re-required under the fake binding below. */
type KeychainModule = typeof KeychainModuleNS;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');

describe('field encryption', () => {
  it('round-trips', () => {
    const ct = encryptField('555-0100', 'row-1');
    expect(decryptField(ct, 'row-1')).toBe('555-0100');
  });

  it('produces opaque ciphertext that does not leak the plaintext', () => {
    const ct = encryptField('Eric Dean', 'row-1');
    expect(isEncrypted(ct)).toBe(true);
    expect(ct).not.toContain('Eric');
    expect(ct).not.toContain('Dean');
  });

  it('uses a fresh nonce, so the same plaintext encrypts differently each time', () => {
    const a = encryptField('same', 'row-1');
    const b = encryptField('same', 'row-1');
    expect(a).not.toBe(b);
    expect(decryptField(a, 'row-1')).toBe(decryptField(b, 'row-1'));
  });

  /**
   * The row id is bound in as AAD specifically so a ciphertext can't be lifted from one
   * row and pasted into another — that would otherwise be a silent way to move someone
   * else's data around, or to swap a field between records.
   */
  it('refuses to decrypt under a different row id', () => {
    const ct = encryptField('secret', 'row-1');
    expect(() => decryptField(ct, 'row-2')).toThrow();
  });

  it('detects tampering with the ciphertext', () => {
    const ct = encryptField('secret', 'row-1');
    const parts = ct.split(':');
    const flipped = Buffer.from(parts[3]!, 'base64url');
    flipped[0] = (flipped[0] ?? 0) ^ 0xff;
    parts[3] = flipped.toString('base64url');
    expect(() => decryptField(parts.join(':'), 'row-1')).toThrow();
  });

  it('rejects malformed input instead of returning garbage', () => {
    expect(() => decryptField('not-encrypted', 'row-1')).toThrow(/v1 format/);
    expect(() => decryptField('v1:a:b', 'row-1')).toThrow(/v1 format/);
  });

  it('handles unicode and empty strings', () => {
    for (const s of ['', 'café ☕', '日本語', 'a'.repeat(10_000)]) {
      expect(decryptField(encryptField(s, 'r'), 'r')).toBe(s);
    }
  });
});

/**
 * `isEncrypted` decides, for every string column of every table, whether the export tries to
 * decrypt it. A predicate that says yes to English therefore replaces the user's own writing
 * with an error message in the file they were handed as "everything this tool stored about
 * you" — and the export is the artifact they are invited to check before deleting the lot.
 */
describe('telling ciphertext apart from prose', () => {
  it('does not mistake an answer that happens to start "v1:" for ciphertext', () => {
    for (const s of [
      'v1: design, v2: build, v3: ship',
      'v1: gather requirements; v2: prototype; v3: ship it',
      'v1: I owned the parser. v2: I owned the UI. v3: I owned the deploy.',
      'v1: 9am standup, 10: design review, 2: ship',
      'v1:a:b:c',
      'v1::: ',
      'Normal answer with no colons at all',
    ]) {
      expect(isEncrypted(s), s).toBe(false);
    }
  });

  it('still recognises everything encryptField actually produces', () => {
    for (const s of ['', 'x', 'café ☕', 'a'.repeat(5_000)]) {
      expect(isEncrypted(encryptField(s, 'row-1')), JSON.stringify(s)).toBe(true);
    }
  });
});

/**
 * The credential store has to be reachable under the runtime the app SHIPS with.
 *
 * The module loaded its binding with a bare `require`, which does not exist in an ES module.
 * Both workspaces are `"type": "module"` and the server runs under tsx, so that threw on
 * every real start, was swallowed as "this platform has no credential store", and put the
 * master key in a plaintext keyfile on machines whose credential store worked perfectly. The
 * suite never noticed because Vitest hands modules a working `require`. So this runs the
 * module in a child process the way `npm start` does, and asserts on what came out.
 */
describe('master key custody, under the runtime the server actually uses', () => {
  function runUnderTsx(dataDir: string): { hasStore: boolean; bytes: number; keyfile: boolean } {
    const script = path.join(dataDir, 'probe.mjs');
    const keychain = pathToFileURL(path.join(SRC, 'infra/crypto/keychain.ts')).href;
    fs.writeFileSync(
      script,
      [
        `import fs from 'node:fs';`,
        `import path from 'node:path';`,
        `import { createRequire } from 'node:module';`,
        `let hasStore = false;`,
        `try {`,
        `  // Resolved from the module under test, not from this throwaway script's directory.`,
        `  const { Entry } = createRequire(${JSON.stringify(keychain)})('@napi-rs/keyring');`,
        `  new Entry('internship-applier', 'availability-probe').getPassword();`,
        `  hasStore = true;`,
        `} catch { hasStore = false; }`,
        `const m = await import(${JSON.stringify(keychain)});`,
        `const bytes = m.getMasterKey().length;`,
        `const keyfile = fs.existsSync(path.join(process.env.DATA_DIR, '.master.key'));`,
        `m.deleteMasterKey();`,
        `console.log('RESULT ' + JSON.stringify({ hasStore, bytes, keyfile }));`,
      ].join('\n'),
    );

    const run = spawnSync(process.execPath, ['--import', 'tsx', script], {
      encoding: 'utf8',
      // DATABASE_PATH as well as DATA_DIR, because the child inherits this worker's
      // environment and that variable is the one path that does not follow DATA_DIR.
      // `getMasterKey` now reads the database before it will mint anything, so a child left
      // pointing at the worker's app.db would be answering a question about somebody else's
      // data — the same half-isolation vitest.setup.ts exists to make impossible.
      env: {
        ...process.env,
        DATA_DIR: dataDir,
        DATABASE_PATH: path.join(dataDir, 'app.db'),
        NODE_ENV: 'test',
      },
    });
    const line = (run.stdout + run.stderr).split('\n').find((l) => l.startsWith('RESULT '));
    expect(line, `child produced no result:\n${run.stdout}\n${run.stderr}`).toBeDefined();
    return JSON.parse(line!.slice('RESULT '.length)) as ReturnType<typeof runUnderTsx>;
  }

  it('uses the OS credential store, and writes no keyfile, when there is one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keychain-'));
    const out = runUnderTsx(dir);

    expect(out.bytes).toBe(32);
    if (!out.hasStore) return; // Headless Linux, CI without libsecret: the keyfile is correct.
    expect(out.keyfile, 'the master key was written to disk despite a working keychain').toBe(
      false,
    );
  });

  /**
   * The same mistake, one module over, would be just as invisible. `require` is not the only
   * CommonJS-only name — `__dirname` and `__filename` fail the same way, in the same silence,
   * under the same runtime that the test suite does not reproduce.
   */
  it('has no CommonJS-only globals anywhere in the server source', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          walk(full);
        } else if (e.name.endsWith('.ts')) {
          const text = fs.readFileSync(full, 'utf8');
          for (const [i, line] of text.split('\n').entries()) {
            if (/(?<![.\w])(?:require\s*\(|__dirname|__filename)/.test(line)) {
              // `createRequire(import.meta.url)` is the ESM-safe form and is what to use.
              if (/createRequire\s*\(/.test(line)) continue;
              offenders.push(`${path.relative(SRC, full)}:${String(i + 1)}: ${line.trim()}`);
            }
          }
        }
      }
    };
    walk(SRC);
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});

/**
 * The app-token check compares a secret, and `!==` on strings returns as soon as it finds a
 * differing byte. The timing that leaks is small and the attacker has to already be on this
 * machine, so this is not the wall the app leans on — but a comparison helper that exists
 * and is not used by the one comparison that wants it is worse than not having one.
 */
describe('constant-time comparison', () => {
  it('is true only for an exact match', () => {
    expect(constantTimeEquals('abc123', 'abc123')).toBe(true);
    expect(constantTimeEquals('', '')).toBe(true);
  });

  it('is false for a value differing only in its last character', () => {
    expect(constantTimeEquals('abc123', 'abc124')).toBe(false);
  });

  it('is false for different lengths, without throwing', () => {
    expect(constantTimeEquals('abc', 'abcdef')).toBe(false);
    expect(constantTimeEquals('abcdef', 'abc')).toBe(false);
    expect(constantTimeEquals('', 'a')).toBe(false);
  });

  it('handles multi-byte characters by comparing bytes, not code units', () => {
    expect(constantTimeEquals('café', 'café')).toBe(true);
    expect(constantTimeEquals('café', 'cafe')).toBe(false);
  });
});

/**
 * Minting a master key is the one act in keychain.ts that cannot be undone.
 *
 * The reported failure: macOS, a week in, the key in the login Keychain and no
 * data/.master.key on disk. `getPassword()` threw — a locked keychain, a dismissed prompt, a
 * changed ACL, it does not matter which — and the catch below it treats an unavailable store
 * as "no key yet", so the fallback path generated a fresh random key and the app went on
 * writing under it. The profile, the resume text and every writing sample stayed sealed under
 * the key that was in the Keychain the whole time, unreadable and unmentioned.
 *
 * These drive the module with a credential store of their own, because the suite's stand-in
 * in vitest.setup.ts always answers and never throws — which is the one behaviour this bug
 * needed to show itself.
 */
describe('what happens when the master key cannot be found', () => {
  const KEYFILE = config.paths.masterKey;
  const DB = config.paths.database;

  interface FakeKeyring {
    /** What `getPassword()` does: hand back a key, hand back null, or throw. */
    read?: () => string | null;
    /** Thrown instead of handing over the binding at all. */
    loadError?: unknown;
    /** Everything `setPassword()` was given, so a silent re-key is visible. */
    written?: string[];
  }

  async function withCredentialStore<T>(
    fake: FakeKeyring,
    fn: (keychain: KeychainModule) => T | Promise<T>,
  ): Promise<T> {
    // The same interception point vitest.setup.ts uses, for the same reason: keychain.ts
    // reaches the binding through `createRequire`, and that ends up in `Module._load`.
    const cjs = Module as unknown as {
      _load: (request: string, parent: unknown, isMain: boolean) => unknown;
    };
    const real = cjs._load;
    cjs._load = function patched(this: unknown, request, parent, isMain) {
      if (request !== '@napi-rs/keyring') return real.call(this, request, parent, isMain);
      if (fake.loadError) throw fake.loadError;
      return {
        Entry: class {
          getPassword(): string | null {
            return fake.read ? fake.read() : null;
          }
          setPassword(value: string): void {
            fake.written?.push(value);
          }
          deletePassword(): boolean {
            return false;
          }
        },
      };
    };
    try {
      // A fresh copy of the module, because `cached` in the real one is already filled by
      // the encryption tests above and would answer before any of this ran.
      vi.resetModules();
      return await fn(await import('../src/infra/crypto/keychain'));
    } finally {
      cjs._load = real;
      vi.resetModules();
    }
  }

  /** A database that only the master key can open, which is what makes minting a loss. */
  function seedSealedRow(): void {
    const db = new Database(DB);
    db.exec('CREATE TABLE profile (id TEXT PRIMARY KEY, full_name TEXT NOT NULL)');
    db.prepare('INSERT INTO profile (id, full_name) VALUES (?, ?)').run(
      'p1',
      encryptField('Eric Dean', 'p1'),
    );
    db.close();
  }

  function clean(): void {
    for (const f of [KEYFILE, DB, `${DB}-wal`, `${DB}-shm`]) fs.rmSync(f, { force: true });
  }

  beforeEach(clean);
  afterEach(clean);

  it('refuses, rather than minting, when the credential store cannot be READ', async () => {
    seedSealedRow();
    const fake: FakeKeyring = {
      // What the macOS Security framework says through the binding when the login keychain
      // is locked, or the prompt in front of it is denied.
      read: () => {
        throw new Error('User interaction is not allowed.');
      },
      written: [],
    };

    await withCredentialStore(fake, (keychain) => {
      expect(() => keychain.getMasterKey()).toThrow(/could not be read/i);
      expect(fs.existsSync(KEYFILE), 'a fresh key was minted over sealed data').toBe(false);
      expect(fake.written, 'the store was written to on the way past').toEqual([]);
    });
  });

  it('refuses on an unreadable store even with nothing stored yet', async () => {
    // Not conditional on there being something to lose, and deliberately so: a keyfile
    // written during one locked moment is preferred over the credential store from then on
    // — see the "DIFFERENT keys" branch — so a single denied prompt would otherwise leave
    // this user on a plaintext key on disk permanently, on a machine whose keychain works.
    await withCredentialStore(
      {
        read: () => {
          throw new Error('User interaction is not allowed.');
        },
      },
      (keychain) => {
        expect(() => keychain.getMasterKey()).toThrow(/could not be read/i);
        expect(fs.existsSync(KEYFILE)).toBe(false);
      },
    );
  });

  it('still falls back to a keyfile where there is genuinely no credential store', async () => {
    // The other direction, and the one the fix above must not break: headless Linux and CI
    // have no store to read, the keyfile is the documented path there, and a tool that
    // refuses to start is a tool nobody can run.
    const absent = Object.assign(new Error("Cannot find module '@napi-rs/keyring'"), {
      code: 'MODULE_NOT_FOUND',
    });

    await withCredentialStore({ loadError: absent }, (keychain) => {
      expect(keychain.getMasterKey().length).toBe(32);
      expect(fs.existsSync(KEYFILE)).toBe(true);
    });
  });

  it('does not mint through the keyfile path either, when data is already sealed', async () => {
    // The sibling. `readFallbackKey` mints too, and it is reached whenever the binding will
    // not load, the `Entry` constructor throws, or `setPassword` is refused — so guarding
    // only the credential-store branch would have left three more ways to the same fresh
    // random key over the same database.
    seedSealedRow();
    const absent = Object.assign(new Error("Cannot find module '@napi-rs/keyring'"), {
      code: 'MODULE_NOT_FOUND',
    });

    await withCredentialStore({ loadError: absent }, (keychain) => {
      expect(() => keychain.getMasterKey()).toThrow(/already holds encrypted data/i);
      expect(fs.existsSync(KEYFILE), 'a fresh key was minted over sealed data').toBe(false);
    });
  });

  it('refuses when the store answers "empty" over a database that is not', async () => {
    // An empty store is not proof of a first run. An entry removed by a keychain repair, a
    // login item that did not survive a migration, a profile moved between accounts: the
    // ciphertext on disk is then the only evidence a key ever existed, and generating a
    // second one is the same destruction arrived at politely.
    seedSealedRow();
    const fake: FakeKeyring = { read: () => null, written: [] };

    await withCredentialStore(fake, (keychain) => {
      expect(() => keychain.getMasterKey()).toThrow(/already holds encrypted data/i);
      expect(fake.written, 'a new key was pushed into the store').toEqual([]);
      expect(fs.existsSync(KEYFILE)).toBe(false);
    });
  });

  it('still mints on a genuinely first run', async () => {
    // The direction that keeps the guard from becoming a bug of its own: no key anywhere, no
    // database, nothing to orphan. This is the path every new install takes.
    const fake: FakeKeyring = { read: () => null, written: [] };

    await withCredentialStore(fake, (keychain) => {
      const key = keychain.getMasterKey();
      expect(key.length).toBe(32);
      expect(fake.written).toEqual([key.toString('base64')]);
    });
  });

  it('mints when the database exists but holds nothing sealed yet', async () => {
    // Migrations have run and the user has not confirmed a profile: the tables are there and
    // empty. Reading "a database file exists" as "there is data" would refuse every start of
    // an install that has not been used yet.
    const db = new Database(DB);
    db.exec('CREATE TABLE profile (id TEXT PRIMARY KEY, full_name TEXT NOT NULL)');
    db.exec('CREATE TABLE writing_sample (id TEXT PRIMARY KEY, content TEXT NOT NULL)');
    db.close();

    await withCredentialStore({ read: () => null, written: [] }, (keychain) => {
      expect(keychain.getMasterKey().length).toBe(32);
    });
  });
});
