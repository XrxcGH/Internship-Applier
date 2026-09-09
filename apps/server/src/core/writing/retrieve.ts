/**
 * Evidence retrieval — docs/06 § ① Retrieval, not invention.
 *
 * Facts come out of the profile carrying a `ref` that points back at where they came from.
 * Two consumers read them, and they want opposite things:
 *
 *   - the drafting prompt wants few, because a smaller prompt drafts better and every
 *     draft and revision pays for it. `formatEvidence` bounds that side;
 *   - FactGuard wants ALL of them, because every sentence it sees has to be traceable to
 *     one of these items and a fact that was never supplied cannot be "supported" — so a
 *     fact left out here is, at gate G3, something the student never did.
 *
 * `retrieveEvidence` therefore returns the corpus and `formatEvidence` prints the prompt.
 * They were one number for a long time, and the number was the guard's problem.
 *
 * Deterministic: keyword and skill overlap, no model call, no embeddings yet.
 */
import type { ConfirmedProfile } from '@ia/shared';

export interface Evidence {
  /** Stable path back into the profile, e.g. "experience.0.bullets.2". */
  ref: string;
  kind:
    'experience' | 'project' | 'education' | 'skill' | 'certification' | 'language' | 'identity';
  /** The verbatim fact. FactGuard compares generated claims against this text. */
  text: string;
  /** Structured values pulled out for the deterministic checks. */
  facts: {
    organization?: string;
    title?: string;
    institution?: string;
    startDate?: string;
    endDate?: string;
    gpa?: { value: number; scale: number; weighted?: number };
    skills?: string[];
    /**
     * Awards, as structured phrases and not only prose. FactGuard grants organisation and
     * school names shortening allowances it can only grant a name it can see whole; with
     * honors living solely inside the education TEXT, "an NSPA Honorable Mention" was an
     * invented name because the profile spells out four more words in the middle.
     */
    honors?: string[];
    /**
     * Languages with the proficiency the profile actually records, as structure rather
     * than only inside the item text.
     *
     * The text alone is not enough for a check. "My Spanish is fluent." folds to two
     * content tokens, one of them 'spanish', so lexical coverage is 0.5 and the claim is
     * returned `supported` — quoting `Languages: Spanish (Conversational)` underneath it
     * as proof. Proficiency inflation on a thin resume is the same class of lie as
     * position inflation, which factGuard caps at amber precisely so a human at G3 is
     * never handed a green tick with the contradicting line printed beside it. Making the
     * verdict is factGuard's job; supplying the two values to compare is this file's, and
     * without them the comparison would mean re-parsing prose this file just formatted.
     */
    languages?: Array<{ name: string; proficiency: string }>;
  };
  score: number;
}

const STOPWORDS = new Set(
  (
    'the a an and or but of to in for on with at by from as is are was were be been it this that ' +
    'you your we our i my me they their what how why when which who whom will would can could ' +
    'about tell us describe give example time why do did does have has had ' +
    // Function words long enough to survive the length filter. Kept here rather than in a
    // second list so retrieval and FactGuard score against the same notion of "content".
    'where while there then than also just very really still after before because though into ' +
    'over more most much some any all like being them these those such under both each ' +
    'through during without within across among between able'
  ).split(' '),
);

/** Content tokens — shared by retrieval scoring and FactGuard's support scoring. */
export function tokens(s: string): string[] {
  return (
    (s.toLowerCase().match(/[\p{L}0-9+#.]+/gu) ?? [])
      // The dot is in the class so "node.js" and ".NET" survive whole, but it also glued
      // the full stop onto the last word of every sentence: "store." never matched the
      // evidence token "store", so each claim quietly lost a content word and coverage
      // came out low enough to push honest sentences from green to amber.
      .map((t) => t.replace(/^\.+|\.+$/g, ''))
      .filter((t) => t.length > 2 && !STOPWORDS.has(t))
  );
}

function overlap(a: Set<string>, b: string[]): number {
  if (b.length === 0) return 0;
  let hits = 0;
  for (const t of b) if (a.has(t)) hits++;
  return hits / b.length;
}

/**
 * How many facts the corpus carries when the caller states no preference.
 *
 * It is a floor and not a cut: see the cap comment in `retrieveEvidence`. Forty covers an
 * ordinary busy young-applicant profile — a dozen or so activities, a school or two, a
 * project, the skills line, the languages line and a certification — whole.
 */
const DEFAULT_EVIDENCE_LIMIT = 40;

/**
 * The ceiling on the DEFAULT corpus — what a caller that stated no preference gets.
 *
 * Sixty is roughly a thirty-bullet flagship activity plus everything else a resume of that
 * size carries. Past it the round-robin is already giving every entry its headline fact
 * and several of its bullets, and the marginal item is the twentieth bullet of the
 * lowest-ranked club.
 *
 * It deliberately does NOT clamp a caller that asked for more. It used to, and that made
 * `limit` a hard cut above sixty instead of the floor this file documents it as: the G3
 * gate passes `Number.MAX_SAFE_INTEGER` to mean "no cut at the gate" (routes/answers.ts),
 * got sixty, and on a sixteen-activity resume the ten bullets past the ceiling were
 * outside the corpus — so "I repaired damaged spines with the Gaylord book tape the
 * librarian ordered", a bullet the student typed into their own profile, came back
 * `unsupported` at G3 where there is no override. A ceiling that overrules the caller who
 * knows what they need is deciding which of the student's facts are true.
 */
const MAX_EVIDENCE_ITEMS = 60;

/**
 * How many evidence lines the drafting prompt is allowed. The corpus is sized for the
 * guard; this is sized for the model. Twenty-four fits one fact about every entry on a
 * two-dozen-entry resume, which is the shape this tool is built for.
 *
 * This is the cap that defends COST, and it is the only one that has to: `formatEvidence`
 * applies it to whatever array it is handed, so the prompt stays twenty-four lines even
 * when the corpus behind it is the whole profile. MAX_EVIDENCE_ITEMS defends nothing on
 * this side.
 */
const PROMPT_EVIDENCE_LINES = 24;

export interface RetrieveOptions {
  /**
   * Floor on the size of the verification corpus, not a hard cut. The first round of the
   * selection below — one fact from every entry the profile holds — is kept whole even
   * when it runs past this, because dropping an entry's only fact is what turns a true
   * sentence into an `unsupported` block at G3 where there is no override.
   *
   * Nothing clamps it from above either. `Number.MAX_SAFE_INTEGER` is the documented way
   * for the G3 gate to say "no cut here", and it has to mean that: MAX_EVIDENCE_ITEMS
   * bounds only the caller who omits this field.
   */
  limit?: number;
  /** Posting text, so "why this role" pulls the relevant side of the profile. */
  postingContext?: string;
}

/**
 * Who the writer is, in one line. Always included, whatever the question is about.
 *
 * FactGuard treats a proper noun with nothing behind it as a fabrication, so before this
 * existed "I'm based in New Brunswick" was blocked at G3 with `"New Brunswick" does not
 * appear anywhere on your profile` — a true sentence, about a fact the profile holds, with
 * no override available and no way to satisfy the message it offered. The user's own name
 * failed the same way whenever a draft signed off with it.
 */
function identityEvidence(profile: ConfirmedProfile): Evidence | null {
  const name = profile.fullName?.trim() ?? '';
  const prefs = profile.locationPrefs;
  const base = prefs?.base;
  const place = [base?.city, base?.region]
    .map((s) => s?.trim())
    .filter(Boolean)
    .join(', ');

  /**
   * Every place the user works from, because this line is the ONLY producer of the user's own
   * location in the evidence corpus — no education or experience entry carries one.
   *
   * A student who added their school city at G1 wrote a true sentence about it and FactGuard
   * returned a blocking `unsupported` — "Los Angeles does not appear anywhere on your
   * profile" — at the one gate with no override, about a fact the profile now holds, offering
   * a remedy the student had already carried out. That is the exact failure this function's
   * own header records having fixed once for the home city; adding more places to the profile
   * reopened it for all of them.
   *
   * The base is read separately and named as the address rather than taken as the first of
   * the list. A profile with a blank base and one added city would otherwise print "based in
   * ⟨that city⟩" — asserting an address the profile does not hold, in the one evidence item
   * whose whole job is to be true.
   */
  const others = (prefs?.additionalBases ?? [])
    .map((b) =>
      [b.city, b.region]
        .map((x) => x?.trim())
        .filter(Boolean)
        .join(', '),
    )
    .filter((label) => label !== '' && label !== place);

  if (!name && !place && others.length === 0) return null;

  const where = place
    ? `based in ${place}` +
      (others.length ? `, and also works in person from ${others.join('; ')}` : '')
    : `works in person from ${others.join('; ')}`;
  const hasWhere = place !== '' || others.length > 0;

  const text =
    name && hasWhere ? `${name}, ${where}` : name || where.replace(/^w/, (c) => c.toUpperCase());
  return { ref: 'identity', kind: 'identity', text, facts: {}, score: 1 };
}

/**
 * Builds the evidence set for one question.
 *
 * The identity line above is always included regardless of score. Everything else is
 * ranked by keyword overlap and then selected by round-robin over the profile's entries,
 * so every entry contributes a fact before any entry contributes a second — see the long
 * note at the selection step for the false reds that shape forced.
 */
export function retrieveEvidence(
  profile: ConfirmedProfile,
  question: string,
  opts: RetrieveOptions = {},
): Evidence[] {
  const query = new Set([...tokens(question), ...tokens(opts.postingContext ?? '')]);
  const items: Evidence[] = [];

  // Real work — the entries whose dates and employers FactGuard interrogates hardest.
  const workRefs = new Set<string>();

  profile.experience.forEach((e, i) => {
    if (
      e.type === 'job' ||
      e.type === 'internship' ||
      e.type === 'freelance' ||
      e.type === 'research'
    ) {
      workRefs.add(`experience.${i}`);
    }
    const skills = e.skills ?? [];
    e.bullets.forEach((b, j) => {
      items.push({
        ref: `experience.${i}.bullets.${j}`,
        kind: 'experience',
        text: b,
        facts: {
          organization: e.organization,
          title: e.title,
          startDate: e.startDate,
          endDate: e.endDate,
          skills,
        },
        score: overlap(query, tokens(`${b} ${e.title} ${skills.join(' ')}`)) + 0.15,
      });
    });

    // The role itself, even when its bullets don't match — dates and titles are the
    // facts most often misstated, so they must be in the evidence set to be checkable.
    //
    // The location belongs in the text for the opposite reason. It was left out, so
    // "I interned at Acme Analytics in Columbus" came back blocking at G3 with
    // `"Columbus" does not appear anywhere on your profile` — while the profile held
    // exactly that city on exactly that job. There is no override at G3, and the fix the
    // message suggests was already done.
    items.push({
      ref: `experience.${i}`,
      kind: 'experience',
      text:
        `${e.title} at ${e.organization}${e.location ? ` in ${e.location}` : ''} ` +
        `(${e.startDate ?? 'date not stated'} to ${e.endDate ?? 'present'})`,
      facts: {
        organization: e.organization,
        title: e.title,
        startDate: e.startDate,
        endDate: e.endDate,
        skills,
      },
      score: overlap(query, tokens(`${e.title} ${e.organization}`)) + 0.3,
    });
  });

  profile.projects.forEach((p, i) => {
    // The span belongs here for the same reason the role line above carries one, and a
    // project was the one dated entry kind this file dropped it from. FactGuard's duration
    // check pools evidence on `facts.startDate` and scopes a claim to the entry whose NAME
    // it uses, so an undated project is in neither: "I worked on Trail Tracker for two
    // years", about a project the profile records as running exactly two years, scoped to
    // nothing and was measured against the longest entry the profile DID date — a
    // three-month internship — and came back `overstated` at G3, where there is no
    // override, quoting the internship as the reason.
    //
    // It failed just as quietly the other way. On the ordinary shape of a young
    // applicant's resume, where the longest dated entry is a four-year club, the same
    // sentence about a two-month project cleared that club's ceiling and went to an
    // employer as a green tick. One missing pair of fields, both bug directions.
    //
    // The dates go in the TEXT as well as in `facts`, the way experience, education and
    // certifications already put theirs there: the text is what a reviewer reads the
    // sentence against at G3, and it is what gets quoted beside a claim the check blocks.
    // Printed only when the profile holds one of them — "(date not stated to present)" on
    // every undated project would be asserting an ongoing project the profile never
    // claimed, in items whose whole job is to be true.
    const span =
      p.startDate || p.endDate
        ? ` (${p.startDate ?? 'date not stated'} to ${p.endDate ?? 'present'})`
        : '';
    items.push({
      ref: `projects.${i}`,
      kind: 'project',
      text:
        `${p.name}: ${p.description}${p.bullets.length ? ` ${p.bullets.join(' ')}` : ''}` + span,
      facts: {
        title: p.name,
        skills: p.skills ?? [],
        startDate: p.startDate,
        endDate: p.endDate,
      },
      score:
        overlap(query, tokens(`${p.name} ${p.description} ${(p.skills ?? []).join(' ')}`)) + 0.1,
    });
  });

  profile.education.forEach((e, i) => {
    const course = (e.coursework ?? []).join(', ');
    // Honors are evidence, and for a student early in their path they are most of it. A
    // resume whose experience section is titles without bullets carries its substance in
    // the awards — and while these were left out of the text, every true sentence about
    // one ("I was a Dean's List semifinalist") was blocked at G3 as an invented name,
    // because the only place the award existed was a field nothing quoted.
    const honors = (e.honors ?? []).join(', ');
    items.push({
      ref: `education.${i}`,
      kind: 'education',
      text:
        `${e.level} in ${e.fieldOfStudy ?? 'an unspecified field'} at ${e.institution}` +
        `${e.endDate ? `, ending ${e.endDate}` : ''}` +
        `${e.gpa ? `, GPA ${e.gpa.value}/${e.gpa.scale}` : ''}` +
        `${e.gpa?.weighted ? ` (${e.gpa.weighted} weighted)` : ''}` +
        `${course ? `. Coursework: ${course}` : ''}` +
        `${honors ? `. Honors: ${honors}` : ''}`,
      facts: {
        institution: e.institution,
        startDate: e.startDate,
        endDate: e.endDate,
        gpa: e.gpa,
        honors: e.honors ?? [],
      },
      score:
        overlap(query, tokens(`${e.fieldOfStudy ?? ''} ${e.institution} ${course} ${honors}`)) +
        0.25,
    });
  });

  const skillNames = profile.skills.map((s) => s.name);
  if (skillNames.length > 0) {
    items.push({
      ref: 'skills',
      kind: 'skill',
      text: `Skills: ${skillNames.join(', ')}`,
      facts: { skills: skillNames },
      score: overlap(query, tokens(skillNames.join(' '))) + 0.2,
    });
  }

  // Languages the profile holds, on one line the way the skills line works.
  //
  // Nothing read this field. It survives extraction (`languages` on ResumeExtraction),
  // toProfile copies it, the database persists it, and then it stopped: the guard was
  // never shown it, so "I am conversational in Spanish" came back blocking at G3 with
  // `"Spanish" does not appear anywhere on your profile` — about a word the profile
  // stores verbatim, with no override and a remedy the user had already performed. A
  // language that happened to be echoed by an AP course escaped by accident; a heritage
  // language with no course or club to echo it never did, so the block landed hardest on
  // exactly the students most likely to have one.
  //
  // The proficiency belongs in the text rather than being dropped: it is the one thing a
  // reviewer at G3 can hold "I am fluent" up against.
  const languages = profile.languages ?? [];
  if (languages.length > 0) {
    items.push({
      ref: 'languages',
      kind: 'language',
      text: `Languages: ${languages.map((l) => `${l.name} (${l.proficiency})`).join(', ')}`,
      // The names go in `facts.skills` too, because "I have experience with Tagalog" is
      // checked against the held-skill list rather than against the prose. `facts.languages`
      // carries the same names with their recorded proficiency, which is what a check on
      // "My Spanish is fluent." against a profile that says Conversational needs — see the
      // field's own note on Evidence.
      facts: {
        skills: languages.map((l) => l.name),
        languages: languages.map((l) => ({ name: l.name, proficiency: l.proficiency })),
      },
      score: overlap(query, tokens(languages.map((l) => l.name).join(' '))) + 0.2,
    });
  }

  profile.certifications.forEach((c, i) => {
    items.push({
      ref: `certifications.${i}`,
      kind: 'certification',
      text: `${c.name}${c.issuer ? ` from ${c.issuer}` : ''}${c.date ? ` (${c.date})` : ''}`,
      // The date a card was earned is the ceiling on "I have been CPR certified for N
      // years" — the one duration claim a certification can support. Without it the entry
      // was undated, fell out of the duration pool entirely, and the claim was measured
      // against the longest JOB on the profile instead: a true sentence about a card the
      // student has held since freshman year came back blocking at G3 quoting a two-month
      // internship as the reason.
      facts: { title: c.name, organization: c.issuer, startDate: c.date },
      score: overlap(query, tokens(c.name)) + 0.05,
    });
  });

  const identity = identityEvidence(profile);
  const ranked = items.sort((a, b) => b.score - a.score);

  // ── selection.
  //
  // One ranked cut used to decide everything, and a ranked cut is the wrong instrument,
  // because the base scores encode a priority ordering that a young applicant's resume
  // inverts. A bullet-less club role line scores +0.3, the skills line +0.2, a project
  // +0.1, a bullet +0.15 and a certification +0.05 — so on a generic question, where no
  // keyword overlap breaks the tie, the clubs simply ate the budget. At eight activities
  // plus one job every one of these came back BLOCKING at G3, each a verbatim
  // restatement of something the profile holds:
  //
  //   "I am certified in First Aid/CPR/AED through the American Red Cross."
  //   "I built Trail Tracker, a trail-condition map for the county park system."
  //   "I have experience with Python and use it for data work."
  //
  // Raising the keyword score does not rescue them, either: `overlap` divides by the
  // EVIDENCE token count, so a question naming the certification outright still scored
  // 0.30 and tied the clubs. And bullets past roughly the seventh on one entry fell the
  // same way, so "I designed the intake mechanism in Onshape" — a line the student typed
  // into their own profile — was an invented name.
  //
  // So the set is built by round-robin over ENTRIES instead. Each experience entry, each
  // school, each project, each certification, the skills line and the languages line is
  // one bucket, holding its own items in score order (an experience bucket holds the role
  // line and then its bullets). Every bucket contributes its headline fact before any
  // bucket contributes a second. That is the guarantee: every kind of evidence the
  // profile holds is represented before any kind gets a second slot, and no single
  // verbose entry can starve the others.
  const bucketOf = (ref: string): string => ref.replace(/\.bullets\.\d+$/, '');
  const mustKeep = (e: Evidence): boolean => e.kind === 'education' || workRefs.has(e.ref);

  // Insertion order is ranked order, so buckets come out ordered by their best item, and
  // each bucket's own items come out in score order — the role line first, then its
  // bullets. That ordering is also what the drafting prompt reads off the head of the
  // returned array, so it stays relevance-ordered rather than being reshuffled by rules
  // that only matter at the ceiling.
  const buckets = new Map<string, Evidence[]>();
  for (const item of ranked) {
    const key = bucketOf(item.ref);
    const list = buckets.get(key);
    if (list) list.push(item);
    else buckets.set(key, [item]);
  }

  // ── the cap, and the trade-off it encodes.
  //
  // The cap is a COST guard, never a correctness knob, so it is not allowed to cut into
  // the first round: dropping an entry's only fact is what produced every false red
  // above. `limit` is therefore a floor and never a cut, in both directions — a caller
  // asking for FEWER items still gets the whole first round, and a caller asking for MORE
  // gets what it asked for. MAX_EVIDENCE_ITEMS only bounds the corpus of a caller that
  // stated no preference; the drafting prompt is bounded separately and unconditionally by
  // PROMPT_EVIDENCE_LINES in `formatEvidence`, which is the cap that actually defends cost.
  //
  // The trade-off chosen here is that the VERIFICATION corpus and the DRAFTING prompt are
  // no longer the same thing. FactGuard has to see everything the profile holds or a true
  // sentence about a held fact is red with no override, while the prompt drafts better
  // small — so `formatEvidence` bounds what the model reads and this set stays whole. The
  // price is real and is worth naming: a bigger corpus is a bigger token union for
  // FactGuard's lexical coverage score, which nudges a few vague fabrications from red to
  // amber. That is the right direction to spend on. Retrieval truncation was never a
  // fabrication defence — every item here is a fact the profile actually holds, and the
  // checks that catch invention (names, dates, GPAs, durations, offices, skills) are
  // exact, not lexical. A narrow corpus bought nothing against a liar and blocked honest
  // students, which is the trade this file exists to refuse.
  const firstRound = buckets.size + (identity ? 1 : 0);
  const effectiveLimit =
    opts.limit === undefined
      ? Math.min(MAX_EVIDENCE_ITEMS, Math.max(DEFAULT_EVIDENCE_LIMIT, firstRound))
      : Math.max(opts.limit, firstRound);
  const cap = Math.max(0, effectiveLimit - (identity ? 1 : 0));

  // Only a profile with more entries than the ceiling can lose a whole entry, and when
  // that happens the thing to lose is a club, never a school or a job. Schools and real
  // jobs are few and carry the dates, GPAs and employers FactGuard interrogates hardest:
  // a sixteen-activity resume once dropped the student's only real job, and "I worked as
  // a math tutor at Bright Minds Tutoring Center" came back red at G3 as an invented
  // employer, while a second school falling the same way blocked a dual-enrollment GPA
  // with the OTHER school's number quoted as the profile's.
  if (buckets.size > cap) {
    const droppable = [...buckets.entries()].filter(([, list]) => !list.some(mustKeep)).reverse();
    for (const [key] of droppable) {
      if (buckets.size <= cap) break;
      buckets.delete(key);
    }
    // A profile that is nothing but schools and jobs can still overflow. Then the lowest
    // ranked go, which is the ordinary ranked cut and the best available answer.
    for (const key of [...buckets.keys()].reverse()) {
      if (buckets.size <= cap) break;
      buckets.delete(key);
    }
  }

  const chosen: Evidence[] = [];
  for (let round = 0; chosen.length < cap; round++) {
    let placed = false;
    for (const list of buckets.values()) {
      const item = list[round];
      if (!item) continue;
      chosen.push(item);
      placed = true;
      if (chosen.length >= cap) break;
    }
    if (!placed) break;
  }

  // The old guarantee still holds: at least one experience item of any kind. Round zero
  // covers it whenever an experience bucket exists, but a profile whose every bucket is a
  // school could otherwise leave the drafting prompt with nothing to write from.
  if (chosen.length > 0 && !chosen.some((c) => c.kind === 'experience')) {
    const exp = ranked.find((r) => r.kind === 'experience');
    if (exp) chosen[chosen.length - 1] = exp;
  }

  return identity ? [identity, ...chosen] : chosen;
}

/**
 * The evidence block as the drafting prompt sees it.
 *
 * Bounded, and separately from the corpus above. The retrieved set is sized so FactGuard
 * can never call a held fact invented, which on a busy resume means it is larger than a
 * prompt wants — and a fatter prompt drafts worse and costs more on every draft and every
 * revision.
 *
 * TAKING THE HEAD OF THE ARRAY WAS NOT ENOUGH, and the reason is the same base-score
 * ordering the selection above already had to work around. The array is round-robin over
 * entries, but the buckets come out ordered by their best item, and a bare role line scores
 * +0.3 while a school scores +0.25 and a certification +0.05. On the resume this was found
 * with — twenty-seven activities, twenty-six of them carrying no bullets at all — the first
 * twenty-four lines were twenty-four bare "Title at Org (dates)" strings. The eleven honors
 * and four certifications, which on that profile are the ONLY substance it holds, were in
 * the corpus and never in the prompt: the model was asked to write about a person and shown
 * nothing they had done.
 *
 * So the prompt is filled by round-robin over KINDS, in the order below, taking one line
 * from each in turn. Experience leads because it is what most questions ask about; identity
 * is pulled out and always first, since a draft that cannot use the writer's own name or
 * city gets those blocked at G3. Within a kind the order is untouched, so it stays the
 * relevance order the retrieval built.
 *
 * Facts below the line are not lost, they are only unwritten-about: the student can still
 * state them themselves at G3 and the guard will recognise them, because the corpus that
 * guard reads is the whole set rather than this slice.
 */
const PROMPT_KIND_ORDER: Array<Evidence['kind']> = [
  'experience',
  'education',
  'project',
  'skill',
  'certification',
  'language',
];

export function formatEvidence(evidence: Evidence[]): string {
  const byKind = new Map<string, Evidence[]>();
  const identity: Evidence[] = [];
  for (const e of evidence) {
    if (e.kind === 'identity') identity.push(e);
    else {
      const list = byKind.get(e.kind);
      if (list) list.push(e);
      else byKind.set(e.kind, [e]);
    }
  }

  // Listed order first, then anything whose kind this list has not been told about — a new
  // kind must never be silently invisible to the prompt just because nobody updated a
  // constant.
  const kinds = [
    ...PROMPT_KIND_ORDER.filter((k) => byKind.has(k)),
    ...[...byKind.keys()].filter((k) => !PROMPT_KIND_ORDER.includes(k as Evidence['kind'])),
  ];

  const chosen: Evidence[] = [...identity];
  for (let round = 0; chosen.length < PROMPT_EVIDENCE_LINES; round++) {
    let placed = false;
    for (const kind of kinds) {
      const item = byKind.get(kind)?.[round];
      if (!item) continue;
      chosen.push(item);
      placed = true;
      if (chosen.length >= PROMPT_EVIDENCE_LINES) break;
    }
    if (!placed) break;
  }

  return chosen
    .slice(0, PROMPT_EVIDENCE_LINES)
    .map((e) => `[${e.ref}] ${e.text}`)
    .join('\n');
}
