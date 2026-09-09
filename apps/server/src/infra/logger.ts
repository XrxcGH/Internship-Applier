import { pino, type DestinationStream, type LoggerOptions } from 'pino';
import { config } from '../config';

/**
 * PII redaction is applied at the logger level, not at call sites, so a new log
 * statement can't accidentally leak a resume field. See docs/10-security-privacy.md.
 *
 * Two mechanisms, because neither covers the other's ground. The paths below are pino's
 * own redaction and reach into anything, including objects a serializer produced. But a
 * pino path wildcard matches exactly ONE segment, so the list stops at `{profile: {email}}`
 * and a record one level deeper — `{run: {profile: {email}}}` — printed the address, the
 * phone number and the date of birth in full. `censorPii` below closes that by walking the
 * record itself.
 */
const REDACTED_PATHS = [
  'fullName',
  'email',
  'phone',
  'dateOfBirth',
  'address',
  // Encrypted at rest beside the other five — schema.ts marks it `ENCRYPTED`, and doc 10
  // promises "any 🔒 field" is censored here — and it was the one of the six that appeared
  // in neither list. A profile record logged at any level printed it in full.
  'pronouns',
  'profile.fullName',
  'profile.email',
  'profile.phone',
  'profile.dateOfBirth',
  'profile.address',
  'profile.pronouns',
  '*.fullName',
  '*.email',
  '*.phone',
  '*.dateOfBirth',
  '*.pronouns',
  // Was missing while every other PII field had a wildcard, so a nested address slipped
  // through the one mechanism meant to make call sites safe by default.
  '*.address',
  // What the page held after the tool typed into it, which is the user's own sentence or
  // their street address coming straight back out of the form. See `PII_KEYS` below.
  'readBack',
  '*.readBack',
  // NO `url` PATH HERE, AND THAT IS THE POINT.
  //
  // Some source URLs carry credentials in the query string (Adzuna app_id/app_key), so this
  // list used to hold `'*.url'` and `'err.url'`. The comment beside them already explained
  // why they were unnecessary — credential-bearing URLs are scrubbed at the call site, and
  // `HttpError` scrubs in its constructor, "so the value in `err.url` is already safe before
  // this list sees it" — and then redacted the field anyway. The result: every fetch failure
  // in the app logged `url: "[redacted]"`, so no log line ever named the address that failed.
  // On a tool whose whole diagnostic story is "the run report says what it could not read",
  // that is the one field worth having.
  //
  // Safety here is by construction rather than by censor, and it is checked: `scrubUrl` is
  // the only way a URL reaches a log record — see the logger tests, which assert both that a
  // failure names its host and that an Adzuna key is gone by the time it is written.
  'req.headers["x-app-token"]',
  'req.headers.authorization',
  'req.headers.cookie',
  // Found by pointing the logger tests at this list instead of at the copy they used to
  // write for themselves: that copy held `password` and `apiKey` and asserted both were
  // censored, and this list had never held either. Nothing logs them today, which is exactly
  // why nobody noticed the promise was empty — the header entries above cover a credential
  // in flight, and these cover one at rest getting swept into a record.
  'password',
  '*.password',
  'apiKey',
  '*.apiKey',
  // The per-run token from `config`, which is a plain object and so would otherwise print in
  // full the first time anyone logs the configuration they started with.
  'appToken',
  '*.appToken',
];

const CENSOR = '[redacted]';

/** The field names that are PII wherever they turn up, at whatever depth. */
const PII_KEYS = new Set([
  'fullName',
  'pronouns',
  'email',
  'phone',
  'dateOfBirth',
  'address',
  // A read-back is the value the employer's form is holding after this tool typed into it:
  // the approved answer for an essay field, the street address for an address field. It is
  // the plaintext of the exact columns the rest of this app encrypts.
  'readBack',
]);

/**
 * Keys whose value is a sentence with a field value quoted inside it.
 *
 * `censorPii` cannot censor these wholesale and neither can a pino path, because the
 * sentence around the quotes is the entire diagnostic: 'field not filled' logs `note`, and
 * `note` is the only thing on that line that says WHY. So the quotes are emptied and the
 * sentence kept — 'The page shows "[redacted]" instead. Check this one.'
 *
 * The failure this closes: core/filling/fill.ts writes `The page shows "${readBack}"
 * instead.` on a mismatch and warns with it, so an essay field whose text the page trimmed
 * put the student's whole approved answer into the log, and an address field put their home
 * address there. A local log file is still a plaintext copy of the columns this app takes
 * an OS credential store and AES-256-GCM to protect.
 *
 * Three more notes in that same file are written the same way and are covered by the same
 * rule: `No option matching "${value}". Choose it yourself.` in the select, radio and
 * combobox branches, where the quoted value is whatever the plan pulled out of the profile
 * — the user's city, their university, their date of availability.
 */
const VALUE_KEYS = new Set(['note']);
const QUOTED_VALUE = /"[^"]*"/g;

/**
 * Deep enough for any record this app actually builds. Below it the whole subtree is
 * censored rather than passed through: an object nested that far is either a mistake or
 * something adversarial, and neither is worth printing a name out of.
 */
const MAX_CENSOR_DEPTH = 8;

/**
 * Only plain objects and arrays are walked.
 *
 * Anything with a real prototype — an Error, a Fastify request, a Playwright handle — is
 * left alone and handed to pino as it was. Copying those would be expensive on every single
 * log line and would break the serializers that know how to render them; the paths above
 * still cover them to the depth pino reaches. Nothing is mutated in place, because a record
 * being logged is usually still in use by the caller and replacing a field with
 * "[redacted]" would corrupt the value it is about to write to the database.
 *
 * `done` maps each original to its censored copy, and the copy is registered BEFORE its
 * children are walked. That is what makes a cycle come out as a cycle. Remembering only
 * that an object had been visited and returning the original on the second encounter put
 * the uncensored object straight back into the record, so a self-referential run object
 * printed the email address it had just censored one line above.
 */
function censorPii(value: unknown, depth: number, done: WeakMap<object, unknown>): unknown {
  if (typeof value !== 'object' || value === null) return value;

  const already = done.get(value);
  if (already !== undefined) return already;
  if (depth > MAX_CENSOR_DEPTH) return CENSOR;

  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    done.set(value, copy);
    for (const v of value) copy.push(censorPii(v, depth + 1, done));
    return copy;
  }

  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;

  const copy: Record<string, unknown> = {};
  done.set(value, copy);
  for (const [key, v] of Object.entries(value)) {
    if (PII_KEYS.has(key)) copy[key] = CENSOR;
    else if (typeof v === 'string' && VALUE_KEYS.has(key)) {
      copy[key] = v.replace(QUOTED_VALUE, `"${CENSOR}"`);
    } else copy[key] = censorPii(v, depth + 1, done);
  }
  return copy;
}

/**
 * The logger the app runs on, built here so that a test can run the same one.
 *
 * The logger tests used to stand up their own pino instance with their own hand-typed copy
 * of `REDACTED_PATHS` — seven paths, none of them the PII ones — and assert against that.
 * So everything above was held by nothing: deleting the whole list, or the `censorPii`
 * formatter with it, would have left every assertion green while the app printed names and
 * addresses. A test that builds its own subject proves only that pino works.
 *
 * The destination is the one thing a caller may vary, because a test has to read the line
 * back. Everything that decides what a line SAYS is fixed here.
 */
export function buildLogger(destination?: DestinationStream) {
  const options: LoggerOptions = {
    // Tests run at `warn` so Fastify's per-request info logs stay out of the output.
    level: config.isTest ? 'warn' : config.logLevel,
    redact: { paths: REDACTED_PATHS, censor: CENSOR },
    formatters: {
      log: (record) => censorPii(record, 0, new WeakMap()) as Record<string, unknown>,
    },
  };

  // pino refuses a transport and a destination together, and pino-pretty's coloured,
  // column-aligned output is not something a test can read a field back out of anyway.
  if (destination) return pino(options, destination);

  return pino({
    ...options,
    ...(config.isDev
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
          },
        }
      : {}),
  });
}

export const logger = buildLogger();

export type Logger = typeof logger;
