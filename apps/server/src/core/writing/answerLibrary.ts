/**
 * Answer library — docs/06 § ⑥.
 *
 * "Why do you want to work here?" gets asked by every company on the list. Drafting it
 * forty times costs forty model calls and produces forty slightly different answers, one
 * of which is the worst. Drafting it once, approving it once, and reusing it is both
 * cheaper and better.
 *
 * THE RULE THAT MATTERS: an answer that names the company is never reused for a different
 * company. The failure mode here is the one that ends an application immediately — a
 * cover letter addressed to the wrong employer — and no amount of convenience is worth
 * risking it. Two mechanisms enforce it. Question archetypes carry a `companySpecific`
 * flag, and reuse across companies is refused for those regardless of how similar the
 * question text is; and any stored answer whose own text names the company it was written
 * for is refused for a different company whatever its archetype says.
 *
 * THE COMPANY IS NOT THE ONLY THING AN ANSWER CAN BE WRONG ABOUT. A stored answer also
 * commits to a city and a start date, and those belong to the POSTING rather than to the
 * employer: "Yes — I can be on-site in Columbus three days a week" pre-filled itself into an
 * Austin application, and "I am available from June 8 through August 14" pre-filled itself
 * into a fall co-op. Neither names a company, so neither check above saw anything, and at G3
 * both read as the student's own sentence — because they are. A third mechanism therefore
 * refuses to reuse an answer that PROMISES a place or a date; past narration ("I tutored in
 * Columbus last summer") is untouched, because a fact about the writer stays true whichever
 * posting reads it. See `promisesAParticular`.
 *
 * Reuse pre-fills; it does not approve. Gate G3 still applies to every answer on every
 * application. What reuse buys is a fast confirm instead of a fresh review, and the card
 * says where the text came from.
 */
import { desc, eq } from 'drizzle-orm';
import { ulid } from 'ulid';
import { db, schema } from '../../infra/db/client';

export type Archetype =
  | 'why_company'
  | 'why_role'
  | 'proud_of'
  | 'challenge'
  | 'teamwork'
  | 'failure'
  | 'learning'
  | 'leadership'
  | 'technical_interest'
  | 'availability'
  | 'relocation'
  | 'how_heard'
  | 'anything_else'
  | 'other';

interface ArchetypeRule {
  archetype: Archetype;
  /** True when a good answer names the company, so it cannot be reused elsewhere. */
  companySpecific: boolean;
  pattern: RegExp;
}

/**
 * Order matters: the first match wins, so the narrower patterns come first.
 * "Why do you want to work at Acme" is why_company, not why_role, even though both
 * contain "why do you want".
 */
const RULES: ArchetypeRule[] = [
  {
    archetype: 'why_company',
    companySpecific: true,
    pattern:
      /\b(why (?:do you want to|would you like to|are you interested in) (?:work|intern|join)|why (?:us|our (?:company|team|firm))|what (?:draws|drew|attracts?) you to (?:us|our)|interest in (?:our|this) company)\b/i,
  },
  {
    archetype: 'why_role',
    companySpecific: false,
    pattern:
      /\b(why (?:are you |this )?(?:interested in |applying (?:for|to) )?this (?:role|position|internship|opportunity)|what (?:interests|excites) you about this (?:role|position))\b/i,
  },
  {
    archetype: 'proud_of',
    companySpecific: false,
    pattern:
      /\b(proud(?:est)? of|something you (?:built|made|created|shipped)|favou?rite project|best (?:work|project)|tell (?:us|me) about a project)\b/i,
  },
  {
    archetype: 'challenge',
    companySpecific: false,
    pattern:
      /\b(challeng(?:e|ing)|difficult (?:problem|situation|bug)|obstacle|overc(?:ame|ome)|hardest)\b/i,
  },
  {
    archetype: 'failure',
    companySpecific: false,
    pattern: /\b(fail(?:ed|ure)|mistake|went wrong|did ?n[o']t (?:go|work) (?:well|out))\b/i,
  },
  {
    archetype: 'teamwork',
    companySpecific: false,
    pattern: /\b(team|collaborat|group (?:project|setting)|disagree(?:ment)? with a)\b/i,
  },
  {
    archetype: 'leadership',
    companySpecific: false,
    pattern: /\b(lead(?:ership)?|led a|took (?:the )?initiative|mentor)\b/i,
  },
  {
    archetype: 'learning',
    companySpecific: false,
    pattern:
      /\b(learn(?:ed|ing)? (?:something|a new)|taught yourself|picked up (?:a|new)|self.?taught)\b/i,
  },
  {
    archetype: 'technical_interest',
    companySpecific: false,
    pattern:
      /\b(what (?:area|part|kind) of (?:engineering|software|technology)|technical interests?|what do you (?:like|enjoy) (?:building|working on))\b/i,
  },
  {
    archetype: 'availability',
    companySpecific: false,
    pattern: /\b(available|availability|start date|when (?:can|could) you (?:start|begin))\b/i,
  },
  {
    archetype: 'relocation',
    companySpecific: false,
    pattern: /\b(relocat|willing to move|able to (?:work|be) (?:in|on.?site))\b/i,
  },
  {
    archetype: 'how_heard',
    companySpecific: true,
    pattern: /\b(how did you (?:hear|find out|learn) about|where did you (?:hear|find))\b/i,
  },
  {
    archetype: 'anything_else',
    companySpecific: false,
    pattern: /\b(anything else|additional information|is there anything|other information)\b/i,
  },
];

export interface Classified {
  archetype: Archetype;
  companySpecific: boolean;
  /** Stable lookup key. Archetype for recognised questions, a text hash otherwise. */
  key: string;
}

/** Strip a question to comparable words, so trivial rewordings share a key. */
function canonical(question: string): string {
  return (
    question
      .toLowerCase()
      .replace(/\(.*?\)/g, ' ')
      // Only strip a stated limit, so a count has to follow. Without that requirement,
      // "What excites you about working within fintech?" and the same question about
      // healthcare both truncated to "what excites about working" and shared one reuse
      // key, so approving the fintech answer pre-filled the healthcare application with it.
      .replace(
        /\b(?:max(?:imum)?|no more than|up to|within|limit(?:ed)?(?: to)?)\b[^a-z]*\d+.*$/i,
        ' ',
      )
      .replace(/\b\d+\s*(?:words?|characters?)\b/g, ' ')
      .replace(/[^a-z\s]/g, ' ')
      .replace(
        /\b(?:please|kindly|briefly|the|a|an|your|you|us|we|our|is|are|do|does|to|of|in|for|and|or|that|this)\b/g,
        ' ',
      )
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/** Small stable hash. Not security-relevant — this is a bucket label. */
function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

export function classifyQuestion(question: string): Classified {
  for (const rule of RULES) {
    if (rule.pattern.test(question)) {
      return {
        archetype: rule.archetype,
        companySpecific: rule.companySpecific,
        key: rule.archetype,
      };
    }
  }
  // Unrecognised questions still get reuse, but only for a near-identical restatement.
  return { archetype: 'other', companySpecific: false, key: `q:${hash(canonical(question))}` };
}

// ─────────────────────────────────────────────────────────────── edit distance

/**
 * Levenshtein over words, not characters. The G3 meter is answering "how much of this did
 * you rewrite", and a user who replaces one word in a sentence has not rewritten the
 * sentence — character distance would say otherwise.
 */
export function wordEditDistance(a: string, b: string): number {
  const x = a.toLowerCase().match(/\S+/g) ?? [];
  const y = b.toLowerCase().match(/\S+/g) ?? [];
  if (x.length === 0) return y.length;
  if (y.length === 0) return x.length;

  let prev = Array.from({ length: y.length + 1 }, (_, i) => i);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) {
      cur[j] = Math.min(
        prev[j]! + 1,
        cur[j - 1]! + 1,
        prev[j - 1]! + (x[i - 1] === y[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[y.length]!;
}

/** 0 = untouched, 1 = rewritten from scratch. */
export function editFraction(draft: string, final: string): number {
  const longest = Math.max((draft.match(/\S+/g) ?? []).length, (final.match(/\S+/g) ?? []).length);
  if (longest === 0) return 0;
  return Math.min(1, wordEditDistance(draft, final) / longest);
}

/**
 * What the meter says out loud. Heavy editing is not a failure — it is the signal that
 * the voice model needs the edited version as a sample.
 */
export function describeEditing(fraction: number): string {
  if (fraction === 0) return 'You approved this unchanged.';
  if (fraction < 0.15) return 'You changed a few words.';
  if (fraction < 0.4) return 'You reworked about a third of this.';
  if (fraction < 0.75) return 'You rewrote most of this.';
  return 'You rewrote this almost entirely. Worth saving as a writing sample.';
}

// ─────────────────────────────────────────────────────────────── persistence

export interface LibraryEntry {
  id: string;
  key: string;
  text: string;
  useCount: number;
  lastUsedAt: string | null;
  approvedAt: string | null;
  /** The company this text was written for, when it names one. */
  company: string | null;
}

interface StoredVariants {
  company?: string | null;
}

function toEntry(row: typeof schema.answerTemplate.$inferSelect): LibraryEntry {
  const variants = (row.variants ?? {}) as StoredVariants;
  return {
    id: row.id,
    key: row.questionKey,
    text: row.canonicalText,
    useCount: row.useCount,
    lastUsedAt: row.lastUsedAt,
    approvedAt: row.approvedAt,
    company: variants.company ?? null,
  };
}

/**
 * Does this text name the company it was written for?
 *
 * Word-run containment over letters and digits, so "Meta" does not match "metadata".
 *
 * THE DISTINCTIVE PART OF THE NAME IS WHAT COUNTS, not the whole stored string. Companies
 * are recorded as they appear on the posting — "Stripe, Inc.", "Acme Analytics" — while
 * the sentence a person actually writes says "Stripe" or "Acme". Requiring the full run
 * meant the check passed on exactly the answers it exists to catch, and a cover letter
 * naming the previous employer went out to the next one. Legal suffixes are dropped and
 * each remaining word is enough on its own; short words are excluded because a company
 * called "Box" or "On" would otherwise match half the English language.
 *
 * TWO THINGS THIS GETS WRONG IF YOU REORDER IT. The legal suffix comes off BEFORE the
 * whole-name check, not after: with the suffix still attached, "IBM Corp." was looked for
 * as the run "ibm corp", which appears in nobody's prose, and the word pass behind it then
 * threw "ibm" away for being three letters. So an answer opening "IBM is where mainframes
 * still matter" was correctly withheld when the posting said "IBM" and handed to the next
 * employer when it said "IBM Corp." — the guarantee in the header turned on whether the
 * posting's company field happened to carry a full stop. And the short-word floor applies
 * to ordinary words only: IBM, SAP, AWS and GE are the whole distinctive name, not a
 * fragment of one, and an all-caps run is never the sort of everyday word the floor exists
 * to exclude. Erring towards `true` here costs a reuse; erring towards `false` addresses a
 * cover letter to the wrong company.
 */
const LEGAL_SUFFIX = /\b(inc|llc|ltd|corp|corporation|co|gmbh|plc|sa|nv|ag|limited)\b/g;
const LEGAL_SUFFIX_WORD = /^(inc|llc|ltd|corp|corporation|co|gmbh|plc|sa|nv|ag|limited)$/i;

function namesCompany(text: string, company: string): boolean {
  const flatten = (s: string): string =>
    ` ${s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()} `;

  const haystack = flatten(text);
  const bare = flatten(company).replace(LEGAL_SUFFIX, ' ').replace(/\s+/g, ' ').trim();
  if (bare.length > 1 && haystack.includes(` ${bare} `)) return true;

  return company
    .split(/[^A-Za-z0-9]+/)
    .filter((w) => w.length > 0 && !LEGAL_SUFFIX_WORD.test(w))
    .filter((w) => w.length > 3 || /^[A-Z0-9]{2,}$/.test(w))
    .some((w) => haystack.includes(` ${w.toLowerCase()} `));
}

// ───────────────────────────────────── particulars that belong to one posting

/**
 * Sentences that PROMISE something, rather than describe something that happened.
 *
 * This is the whole distinction the place and date check below rests on. "I tutored in
 * Columbus every Saturday" is a fact about the writer and stays true on every application
 * they ever send; "I can be on-site in Columbus three days a week" is an undertaking to one
 * employer about one posting, and carrying it to the next posting hands the student a
 * commitment they never made. Refusing every answer that mentions a city or a month would
 * empty the library — most good answers narrate — so only the promising clause is read.
 *
 * The vocabulary is the one an applicant actually uses for availability, location and
 * travel. `start` is deliberately narrow: bare "started" opens half the sentences on a
 * resume, so only its forward-looking forms ("can start", "start date", "starting in June")
 * count.
 */
const COMMITMENT_CLAUSE = new RegExp(
  [
    String.raw`\bavailab(?:le|ility)\b`,
    String.raw`\b(?:can|could|able to|willing to|happy to|ready to|free to|hoping to|planning to|plan to|expect to|intend to)\s+(?:\w+\s+){0,2}?(?:start|begin|work|be|commute|attend|relocate|move|join|intern|travel)\b`,
    String.raw`\bstart(?:ing)?\s+(?:date|in|on|from|as early as|no earlier than)\b`,
    String.raw`\b(?:relocat|commut)\w*`,
    String.raw`\bon-?site\b`,
    String.raw`\bin person\b`,
    String.raw`\bwork(?:ing)?\s+(?:from|out of)\b`,
  ].join('|'),
  'i',
);

/**
 * A date the next posting can disagree with: a month, a season, a year, a calendar date.
 *
 * The numeric form takes a slash and not a hyphen. "6/8" is a date; "I can work 3-5 days a
 * week" is a range, and refusing that would throw away the most reusable availability answer
 * there is. An ISO date keeps its year, so `20\d{2}` still catches it.
 */
const DATED = new RegExp(
  [
    String.raw`\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b`,
    String.raw`\b(?:spring|summer|fall|autumn|winter)\b`,
    String.raw`\b20\d{2}\b`,
    String.raw`\b\d{1,2}\s*/\s*\d{1,2}\b`,
    String.raw`\b\d{1,2}(?:st|nd|rd|th)\b`,
  ].join('|'),
  'i',
);

/**
 * May, the one month that is also the commonest modal verb in this kind of writing.
 *
 * In the list above it would have refused every answer containing "I may be free earlier",
 * which is most of them. Capitalised it is the month; lowercase it is the month only where a
 * modal cannot stand — next to a day number, or behind a preposition.
 */
const MAY_CAPITALISED = /\bMay\b/;
const MAY_AS_MONTH =
  /\bmay\s+\d{1,2}\b|\b\d{1,2}\s+may\b|\b(?:in|from|by|until|till|before|after|during|through)\s+may\b/i;

const statesADate = (s: string): boolean =>
  DATED.test(s) || MAY_CAPITALISED.test(s) || MAY_AS_MONTH.test(s);

/**
 * A place the next posting can disagree with.
 *
 * There is no gazetteer here and there does not need to be one: inside a clause that is
 * already promising something, a capitalised word after a locative preposition is a city, a
 * campus or an employer, and all three are things the next posting may not share. "in
 * Columbus", "to Austin, TX", "out of the Cleveland office". Case matters — "at your office"
 * promises nothing anybody can be wrong about.
 */
const PLACED =
  /\b(?:in|at|to|near|around|outside|from|within|inside|of)\s+(?:the\s+)?[A-Z][A-Za-z.'’-]+(?:[ -](?:of\s+)?[A-Z][A-Za-z.'’-]+){0,3}/;

/** Sentences, roughly. Enough to keep a promise in one line from tainting the next. */
const sentences = (text: string): string[] => text.split(/(?<=[.!?;])\s+|\n+/);

/**
 * Does this stored answer promise a place or a date that the next posting may not share?
 *
 * The `availability` and `relocation` archetypes hand over the WHOLE text rather than the
 * promising clauses within it, because for those two the question itself is the promise and
 * the answer is frequently a fragment with no verb at all: "June 8 through August 14.",
 * "Columbus or remote." Nothing in those sentences matches a commitment vocabulary, and they
 * are the two answers most certain to be wrong on the next posting.
 */
function promisesAParticular(text: string, archetype: Archetype): boolean {
  const clauses =
    archetype === 'availability' || archetype === 'relocation'
      ? [text]
      : sentences(text).filter((s) => COMMITMENT_CLAUSE.test(s));

  return clauses.some((c) => statesADate(c) || PLACED.test(c));
}

/**
 * An approved answer to reuse, or null.
 *
 * Refuses to cross companies for company-specific archetypes — see the header. Also
 * refuses anything never approved: an unapproved draft is not a library entry.
 */
export function findReusable(question: string, company: string | null): LibraryEntry | null {
  const { key, companySpecific, archetype } = classifyQuestion(question);

  const row = db
    .select()
    .from(schema.answerTemplate)
    .where(eq(schema.answerTemplate.questionKey, key))
    .orderBy(desc(schema.answerTemplate.lastUsedAt))
    .all()[0];

  if (!row?.approvedAt) return null;
  const entry = toEntry(row);

  const sameCompany =
    entry.company !== null &&
    company !== null &&
    entry.company.toLowerCase() === company.toLowerCase();

  if (companySpecific && !sameCompany) return null;

  // The archetype flag says whether a good answer to this QUESTION names the company. It
  // says nothing about what the writer actually typed. An approved "why are you interested
  // in this role?" answer reading "This role at Acme sits right at the intersection of data
  // and product" was handed straight to the next application and written into its final
  // text, and the card only said "reused · 1×" — so the Beta Corp form went out talking
  // about Acme. What matters is whether the text names its own company, not which bucket
  // the question fell into.
  if (!sameCompany && entry.company && namesCompany(entry.text, entry.company)) return null;

  /**
   * And the same argument for the two things a stored answer promises that are not the
   * company: where the student will be, and when they can start.
   *
   * `sameCompany` buys no exemption here, and that is the point rather than an oversight.
   * The unit this file can see is the employer; the unit a start date and an office belong
   * to is the POSTING, and one employer posts a summer internship and a fall co-op in two
   * cities. A stored "I am available from June 8 through August 14" is wrong for the second
   * Northwind posting exactly as it is wrong for Beta Corp's, and nothing reaching this
   * function can tell the two apart.
   *
   * The honest fix one layer up is for the caller to hand over the posting's city and term
   * alongside its company, so this becomes a comparison instead of a refusal; until then a
   * refusal costs one re-draft of a one-line answer, and the alternative is a commitment the
   * student never made arriving at G3 already written in their own voice.
   */
  if (promisesAParticular(entry.text, archetype)) return null;

  return entry;
}

/** Records an approved answer so the next application can reuse it. */
export function saveApproved(question: string, text: string, company: string | null): void {
  const { key } = classifyQuestion(question);
  const now = new Date().toISOString();

  const existing = db
    .select()
    .from(schema.answerTemplate)
    .where(eq(schema.answerTemplate.questionKey, key))
    .all()[0];

  if (existing) {
    db.update(schema.answerTemplate)
      .set({
        canonicalText: text,
        variants: { company },
        useCount: existing.useCount + 1,
        lastUsedAt: now,
        approvedAt: now,
      })
      .where(eq(schema.answerTemplate.id, existing.id))
      .run();
    return;
  }

  db.insert(schema.answerTemplate)
    .values({
      id: ulid(),
      questionKey: key,
      canonicalText: text,
      variants: { company },
      useCount: 1,
      lastUsedAt: now,
      approvedAt: now,
    })
    .run();
}

export function listLibrary(): LibraryEntry[] {
  return db
    .select()
    .from(schema.answerTemplate)
    .orderBy(desc(schema.answerTemplate.lastUsedAt))
    .all()
    .map(toEntry);
}
