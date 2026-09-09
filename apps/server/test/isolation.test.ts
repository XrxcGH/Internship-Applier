/**
 * The suite must not be able to touch the developer's real data.
 *
 * This exists because it already happened, twice, in the same shape. First `DATABASE_PATH`
 * was isolated but the data directory was not, so the privacy tests — which exercise a real
 * `rm -rf` — deleted the actual `data/resumes`, `data/artifacts`, and the master key file.
 * Then the data directory was isolated and the OS credential store was not: `keychain.ts`
 * addresses it by a fixed service and account name that owes nothing to DATA_DIR, so
 * `npm test` went on deleting the developer's real master key and writing back a random one
 * that decrypts nothing. Both times every test still passed.
 *
 * The assertions below cover paths AND the credential store, because the first version of
 * this file checked six `config.paths.*` strings and nothing else — and a credential-store
 * entry is not a path, which is exactly why it went on being destroyed underneath a test
 * whose stated job was to stop that. Anything a test run can reach that outlives the
 * process belongs here, whether or not it looks like a file.
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { config, Env, REPO_ROOT } from '../src/config';
import { deleteMasterKey, getMasterKey } from '../src/infra/crypto/keychain';

interface KeyringModule {
  isInMemoryTestDouble?: boolean;
}

function requireKeyring(): KeyringModule {
  // Loaded the same way keychain.ts loads it, so this tests the path production takes.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('@napi-rs/keyring') as KeyringModule;
}

/**
 * Everything the stand-in credential store is currently holding.
 *
 * Read through the shared symbol rather than by service and account name, because those are
 * `keychain.ts`'s business and it is free to change them. What this file is entitled to
 * assert is narrower and more durable: whatever names it uses, the secret ends up in this
 * Map and nowhere the machine keeps.
 */
function storedSecrets(): string[] {
  const store = (globalThis as Record<symbol, unknown>)[Symbol.for('ia.test.credentialStore')];
  expect(store, 'the credential-store stand-in was never installed').toBeInstanceOf(Map);
  return [...(store as Map<string, string>).values()];
}

const insideRepoData = (p: string): boolean => {
  const repoData = path.resolve(REPO_ROOT, 'data');
  const rel = path.relative(repoData, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

describe('the test suite writes nowhere near the real data directory', () => {
  it('puts every writable path under a temporary root', () => {
    for (const [name, p] of Object.entries({
      data: config.paths.data,
      resumes: config.paths.resumes,
      artifacts: config.paths.artifacts,
      browserProfile: config.paths.browserProfile,
      masterKey: config.paths.masterKey,
      database: config.paths.database,
    })) {
      expect(insideRepoData(p), `${name} resolves to ${p}`).toBe(false);
    }
  });

  it('derives every writable path from the same root', () => {
    // A path that does not descend from DATA_DIR is one the next isolation change misses.
    for (const p of [
      config.paths.resumes,
      config.paths.artifacts,
      config.paths.browserProfile,
      config.paths.masterKey,
    ]) {
      expect(path.relative(config.paths.data, p).startsWith('..'), p).toBe(false);
    }
  });

  it('is pinned to no model access, so no test can spend real usage', () => {
    expect(config.llm.provider).toBe('none');
  });
});

/**
 * The other containment this file is the right home for: not where the process writes, but
 * who can reach it.
 *
 * `SERVER_HOST` was a bare string, so `SERVER_HOST=0.0.0.0` in .env bound the API to every
 * interface while index.ts printed `server listening (loopback only)` on top of it and
 * docs/10 stated the loopback bind as an invariant. Nothing had ever checked the value, so
 * the banner and the doc were claims rather than facts.
 *
 * Asserted on `Env`, the schema config.ts parses `process.env` with, because a bad value
 * there reaches `process.exit(1)` — which in a worker takes the whole run down — and a test
 * that re-typed the rule into its own `z.object` would be testing zod.
 *
 * Both directions, because the cheap way to pass the first test is to refuse everything, and
 * a startup that refuses `localhost` is a tool that will not run.
 */
describe('the API can only be told to bind loopback', () => {
  it('refuses a host that would put the port on the network', () => {
    for (const host of ['0.0.0.0', '::', '*', '192.168.1.7', '10.0.0.4', 'example.com', '']) {
      // The empty string is in here on purpose: `SERVER_HOST=` in a .env file looks like an
      // unset variable and is not one — Node reads '' as every interface, same as 0.0.0.0.
      const parsed = Env.safeParse({ SERVER_HOST: host });
      expect(parsed.success, `SERVER_HOST=${JSON.stringify(host)} was accepted`).toBe(false);
    }
  });

  it('accepts every spelling of loopback a person reasonably uses', () => {
    for (const host of ['127.0.0.1', '127.0.0.2', 'localhost', '::1', '::ffff:127.0.0.1']) {
      const parsed = Env.safeParse({ SERVER_HOST: host });
      expect(parsed.success, `SERVER_HOST=${host} was refused`).toBe(true);
      if (parsed.success) expect(parsed.data.SERVER_HOST).toBe(host);
    }
  });

  it('binds loopback when nothing is set, which is how it actually runs', () => {
    expect(Env.parse({}).SERVER_HOST).toBe('127.0.0.1');
    expect(config.server.host).toBe('127.0.0.1');
  });
});

describe('the test suite cannot reach the real OS credential store', () => {
  it('resolves the keyring to an in-memory stand-in, however it is asked for', async () => {
    expect(requireKeyring().isInMemoryTestDouble).toBe(true);
    // The same check through `import`, because rewriting keychain.ts's `require` into an
    // `await import` is a one-line tidy-up and must not quietly reopen this.
    const imported = (await import('@napi-rs/keyring')) as unknown as KeyringModule;
    expect(imported.isInMemoryTestDouble).toBe(true);
  });

  it('refuses to load a credential-store package nobody has stubbed', () => {
    // A guard listing one module by name is how this hole reopens: swapping the keyring for
    // another package would restore the original accident with the suite still green.
    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('keyring-of-the-future');
    }).toThrow(/credential store/i);
  });

  it('sends the master key to the stand-in rather than to the machine', () => {
    const key = getMasterKey();
    expect(key.length).toBe(32);
    expect(storedSecrets()).toContain(key.toString('base64'));
  });

  it('destroys only the stand-in when delete-all destroys the master key', () => {
    // This is the exact call the privacy tests reach through POST /api/privacy/delete-all,
    // and the one that used to wipe the developer's real Credential Manager entry while
    // every test in the suite went on passing.
    const key = getMasterKey();
    expect(storedSecrets()).toContain(key.toString('base64'));

    deleteMasterKey();
    expect(storedSecrets()).not.toContain(key.toString('base64'));
  });
});
