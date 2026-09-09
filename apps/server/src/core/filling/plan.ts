/**
 * Turning a FormMap plus a profile into a list of intended values — docs/07 § Fill.
 *
 * Pure. No browser, no I/O, so what the tool is *about to type* is fully testable and can
 * be shown to the user before a single keystroke happens.
 *
 * THE PLAN IS ALLOWED TO BE INCOMPLETE. Every field the plan cannot fill confidently comes
 * back as a `skip` with a reason, and the reasons are the interesting output: "this is
 * yours to answer", "your profile has no GPA", "I could not tell what this field is".
 * A plan that silently omitted them would leave the user to discover the gaps by reading
 * the finished form, which is exactly the review burden this design tries to remove.
 */
import type {
  AnswerEvidence,
  AnswerFlag,
  ApplicationAnswer,
  ConfirmedProfile,
  FormField,
} from '@ia/shared';
import { guardDraft } from '../writing/factGuard';
import { retrieveEvidence } from '../writing/retrieve';
import { isActionable } from './classify';
import { checkRedline } from './redlines';

export interface FillAction {
  field: FormField;
  value: string;
  /** Where the value came from, shown in the pre-submit review. */
  source: 'profile' | 'answer' | 'file';
  /** Absolute path, for file inputs. */
  filePath?: string;
  /**
   * The name the file should reach the employer under.
   *
   * The stored copy is named for its row — `01M21C4W42ZZYMRE4SP4QRKJ50.pdf` — because a
   * user-supplied filename is not something to build a path out of. Playwright's
   * `setInputFiles(path)` uploads under that basename, so the employer received a ULID where
   * the student's own "Maya Okonkwo Resume.pdf" should have been, on the one document in the
   * application a human actually opens.
   */
  fileName?: string;
}

export interface FillSkip {
  field: FormField;
  reason: 'redline' | 'unknown' | 'no_data' | 'needs_answer';
  note: string;
}

export interface FillPlan {
  actions: FillAction[];
  skips: FillSkip[];
}

export interface PlanInput {
  fields: FormField[];
  profile: ConfirmedProfile;
  /** Approved answers, keyed however the caller likes; matched by question text. */
  answers: ApplicationAnswer[];
  resumePath?: string;
  /** The name the stored resume was uploaded under, for the employer's copy. */
  resumeFilename?: string;
}

// ───────────────────────────────────────── approval measured against the profile of today

/**
 * The flag types that mean FactGuard rejected a claim, as opposed to the amber ones that
 * mean the sentence reads like a machine wrote it. Only these two block.
 */
const BLOCKING_FLAG_TYPES: ReadonlySet<AnswerFlag['type']> = new Set(['unsupported', 'overstated']);

/** The verdicts that block, from the evidence side. Kept next to the flag list so they cannot drift. */
const BLOCKING_VERDICTS: ReadonlySet<AnswerEvidence['verdict']> = new Set([
  'unsupported',
  'overstated',
]);

/**
 * What the G3 card says beside a sentence whose approval was withdrawn.
 *
 * The user approved this once, saw a green tick, and is now looking at the same answer
 * marked not approved. Without a sentence saying why, that reads as the tool losing their
 * work. The guard's own reason ("Kestrel Analytics" does not appear anywhere on your
 * profile) is true but answers a question they did not ask, because when they approved it
 * the entry was there.
 */
export const APPROVAL_WITHDRAWN_NOTE =
  'Your profile changed after you approved this answer, so it was checked again and this ' +
  'sentence no longer matches what your profile says.';

export interface ApprovalRecheck {
  /** True when the text still passes FactGuard against the profile as it stands now. */
  ok: boolean;
  /** The claims that now block, for a message that names them. */
  blocking: Array<{ claim: string; reason: string }>;
  /** Every checked claim, in guard order, ready to replace the stored `evidence` column. */
  evidence: AnswerEvidence[];
  /** The blocking claims as flags, in the same order. Style and AI-tell flags are not recomputed here. */
  factFlags: AnswerFlag[];
}

/**
 * The corpus size gate G3 verifies against: everything the profile holds, not a corpus
 * sized for a prompt.
 *
 * `retrieveEvidence` treats `limit` as a floor on the verification corpus, and its default
 * floor is sized for what a model should read. Taking that default meant a fact the student
 * typed into their own profile was not a fact the gate could check an answer against: on a
 * resume of sixteen activities with three bullets each, twenty of those bullets were outside
 * the corpus, and `I raised the entry fees through the Calloway boosters` came back from
 * approval as `409 UNVERIFIED_CLAIMS: "Calloway" does not appear anywhere on your profile`.
 * It appears on their profile. There is no override at G3, and the remedy the message offers
 * had already been done.
 *
 * Truncation was never a fabrication defence, which is why asking for everything is safe:
 * every item in the corpus is a fact the profile already holds, and the checks that catch
 * invention — names, dates, GPAs, durations, offices — are exact rather than lexical.
 *
 * This asks for everything and now GETS everything, which it did not always. `retrieveEvidence`
 * used to clamp whatever it was handed to its own `MAX_EVIDENCE_ITEMS` of 60, so the value
 * below bought sixty facts however large the ask and the false red above simply moved from
 * forty facts to sixty. That ceiling now bounds only a caller that states no preference, and
 * an explicit limit is honoured: on the sixteen-activity fixture in filling.route.test.ts,
 * limit=80, limit=200 and MAX_SAFE_INTEGER each returned 60 items of 66 before that change and
 * return all 66 after it. If a later edit puts a ceiling back over an explicit limit, the
 * approval on `Ran the Pemberton fundraiser for Art Club.` in that suite is what goes red.
 *
 * One constant rather than a number written twice, because the two gates have to ask for the
 * same thing: every gate that re-checks an approval asks for exactly what the approve route
 * asked for, so a sentence cannot pass one gate and fail the other over corpus size alone.
 */
export const WHOLE_PROFILE = Number.MAX_SAFE_INTEGER;

/**
 * The posting's words in the one shape every gate must use.
 *
 * Retrieval ranks by keyword overlap, so the query decides which facts are in the corpus and
 * which fall off the end of it. The approve route ranked against `<title> at <company>` plus
 * the description and the two re-check call sites ranked against the description alone —
 * different query, different ordering, and on a profile bigger than the ceiling a different
 * set of facts. A claim built from an item only one side holds is a fabrication to the other,
 * and the re-check is the side that withdraws a tick the user already earned.
 *
 * One function, so a call site cannot supply half of it again.
 */
export function gatePostingContext(posting: {
  title: string;
  company: string;
  description: string;
}): string {
  return `${posting.title} at ${posting.company}\n\n${posting.description}`;
}

export interface RecheckInput {
  /** The text as it would be typed: `finalText || draftText`. */
  text: string;
  questionText: string;
  profile: ConfirmedProfile;
  /**
   * The employer's name and the role title from the posting.
   *
   * Load-bearing, and the reason this takes the posting at all. FactGuard reads a proper
   * noun with nothing behind it as an invention, and the company's own name is nowhere on
   * the candidate's profile — so a re-check run without these turns "What draws me to
   * Northwind Systems is the documentation" red at the last gate before the form, over a
   * sentence G3 approved and would approve again. That is a false red on a true sentence
   * with no override anywhere, which this repo treats as the worst thing it can do.
   */
  contextNames?: string[];
  /**
   * The posting's words, built by `gatePostingContext` so retrieval ranks the same way it
   * did at G3. Handing the description alone is what the two call sites used to do, and it
   * is not the same query.
   */
  postingContext?: string;
}

/**
 * Re-runs gate G3's own check against the profile as it stands right now.
 *
 * Deliberately identical to the pass `routes/answers.ts` runs at approval time — same
 * retrieval options, same context names, same guard. Anything more permissive would mean
 * the tool typing a sentence it would refuse to approve; anything stricter would mean
 * refusing a sentence it would approve. Either way the two gates would be answering the
 * same question differently, and the user would be told one thing on the review screen and
 * another at the form.
 *
 * Pure, and no model call: `retrieveEvidence` and `guardDraft` are both deterministic, so
 * a re-check on an unchanged profile always agrees with the approval it is re-checking.
 *
 * "Deliberately identical" has to include `limit`, and once did not. This call took the
 * default floor while the approve route passed `WHOLE_PROFILE`, so the re-check verified
 * against a corpus twenty items smaller than the one that granted the tick — and the twenty
 * it lost were the second and third bullets of the lower-ranked entries, which is where the
 * tool names and award names FactGuard treats as distinctive proper nouns live. On a busy
 * sixteen-activity profile that withdrew approvals on a profile save that changed nothing at
 * all, and refused the fill outright with no profile edit anywhere in between: `Ran the
 * Larkspur fundraiser for Math League.` was approved at G3 and then came back
 * `"Larkspur" does not appear anywhere on your profile.` at the last gate before the form.
 */
export function recheckApproval(input: RecheckInput): ApprovalRecheck {
  const evidence = retrieveEvidence(input.profile, input.questionText, {
    postingContext: input.postingContext ?? '',
    limit: WHOLE_PROFILE,
  });
  const guard = guardDraft(input.text, evidence, input.contextNames ?? []);

  return {
    ok: guard.blocking.length === 0,
    blocking: guard.blocking.map((c) => ({
      claim: c.claim,
      reason: c.reason ?? 'Not supported by your profile.',
    })),
    evidence: guard.claims.map((c) => ({
      claim: c.claim,
      verdict: c.verdict,
      profileRef: c.profileRef,
      quote: c.quote,
    })),
    factFlags: guard.blocking.map((c) => ({
      type: c.verdict === 'overstated' ? ('overstated' as const) : ('unsupported' as const),
      span: c.span,
      note: c.reason ?? 'Not supported by your profile.',
    })),
  };
}

/**
 * The columns to write when a re-check withdraws an approval.
 *
 * Shared so the two callers that can discover a stale approval — the profile write, which
 * causes it, and the fill loader, which is the last place to catch one caused elsewhere —
 * cannot leave the row in two different shapes.
 *
 * The style and AI-tell flags already on the row are kept. They were computed against the
 * user's writing, which a profile edit does not touch, and dropping them would quietly
 * empty the amber half of the review screen every time a fact changed.
 */
export function withdrawnApprovalColumns(
  existingFlags: AnswerFlag[] | null | undefined,
  recheck: ApprovalRecheck,
): { approvedAt: null; evidence: AnswerEvidence[]; flags: AnswerFlag[] } {
  const kept = (existingFlags ?? []).filter((f) => !BLOCKING_FLAG_TYPES.has(f.type));
  return {
    approvedAt: null,
    evidence: recheck.evidence,
    flags: [
      ...recheck.factFlags.map((f) => ({ ...f, note: `${f.note} ${APPROVAL_WITHDRAWN_NOTE}` })),
      ...kept,
    ],
  };
}

/**
 * An approved answer that is carrying a rejection, which is a state nothing legitimate
 * produces: approval writes `guard.blocking` empty by definition, so blocking flags beside
 * an approval stamp mean the flags were recomputed after the stamp was granted.
 *
 * Checked on both columns rather than one. They are written together today, and a writer
 * that updated the evidence and forgot the flags would otherwise hand this the one field
 * it was not reading and get a green tick for it.
 */
export function carriesBlockingVerdict(answer: ApplicationAnswer): boolean {
  return (
    (answer.flags ?? []).some((f) => BLOCKING_FLAG_TYPES.has(f.type)) ||
    (answer.evidence ?? []).some((e) => BLOCKING_VERDICTS.has(e.verdict))
  );
}

// ───────────────────────────────────────────────────────────────────── profile values

const firstName = (full: string): string => full.trim().split(/\s+/)[0] ?? '';
const lastName = (full: string): string => {
  const parts = full.trim().split(/\s+/);
  return parts.length > 1 ? parts[parts.length - 1]! : '';
};

/**
 * Most recent education entry, which is what an application means by "school".
 *
 * A missing end date means "Present", not "the beginning of time". Coalescing it to ''
 * and sorting descending put the degree the user is actually enrolled in LAST, so an
 * application asking for school, degree, major, GPA and graduation date was filled from
 * whatever they finished before it — usually their high school. Ongoing entries sort
 * first; ties between two ongoing entries fall back to which started later.
 */
function currentEducation(p: ConfirmedProfile) {
  return [...p.education].sort((a, b) => {
    const aOngoing = !a.endDate;
    const bOngoing = !b.endDate;
    if (aOngoing !== bOngoing) return aOngoing ? -1 : 1;
    if (aOngoing && bOngoing) return (b.startDate ?? '').localeCompare(a.startDate ?? '');
    return (b.endDate ?? '').localeCompare(a.endDate ?? '');
  })[0];
}

const DEGREE_LABEL: Record<string, string> = {
  high_school: 'High School',
  associate: 'Associate',
  bachelor: "Bachelor's",
  master: "Master's",
  doctorate: 'Doctorate',
  other: 'Other',
};

/**
 * The value for one semantic, or null when the profile does not have it.
 *
 * Returning null rather than an empty string matters: an empty string is a value, and
 * typing one into a required field would satisfy the form's validation while telling the
 * employer nothing.
 */
export function valueFor(field: FormField, p: ConfirmedProfile): string | null {
  const edu = currentEducation(p);

  switch (field.semantic) {
    case 'first_name':
      return firstName(p.fullName) || null;
    case 'last_name':
      return lastName(p.fullName) || null;
    case 'full_name':
      return p.fullName || null;
    case 'email':
      return p.email || null;
    case 'phone':
      return p.phone ?? null;
    case 'address_line1':
      return p.address.line1 ?? null;
    case 'city':
      return p.address.city ?? p.locationPrefs.base.city ?? null;
    case 'region':
      return p.address.region ?? p.locationPrefs.base.region ?? null;
    case 'postal':
      return p.address.postal ?? null;
    case 'country':
      return p.address.country || null;
    case 'linkedin':
      return p.links.linkedin ?? null;
    case 'github':
      return p.links.github ?? null;
    case 'portfolio':
      return p.links.portfolio ?? null;
    case 'website':
      return p.links.portfolio ?? p.links.other[0] ?? null;
    case 'school':
      return edu?.institution ?? null;
    case 'degree':
      return edu ? (DEGREE_LABEL[edu.level] ?? edu.level) : null;
    case 'major':
      return edu?.fieldOfStudy ?? null;
    case 'gpa':
      return edu?.gpa ? String(edu.gpa.value) : null;
    case 'graduation_date':
      return edu?.endDate ?? p.derived.expectedGraduation ?? null;
    case 'enrollment_status':
      return p.derived.academicLevel === 'none' ? null : 'Currently enrolled';
    case 'work_auth':
      // The question is "are you authorized", and the profile knows.
      return p.workAuthorization.status === 'unknown'
        ? null
        : p.workAuthorization.needsSponsorship
          ? 'No'
          : 'Yes';
    case 'sponsorship_needed':
      return p.workAuthorization.status === 'unknown'
        ? null
        : p.workAuthorization.needsSponsorship
          ? 'Yes'
          : 'No';
    case 'start_date':
      return p.availability.start ?? null;
    case 'end_date':
      return p.availability.end ?? null;
    case 'hours_available':
      return p.availability.hoursPerWeek ? String(p.availability.hoursPerWeek) : null;
    case 'salary_expectation':
      return p.preferences.minStipend ? String(p.preferences.minStipend) : null;
    default:
      return null;
  }
}

/**
 * Semantics the profile has no field for AT ALL, and the sentence to print instead.
 *
 * `valueFor` returns null for these the same way it returns null for a GPA the user never
 * entered, and the generic sentence below treats both the same: "Your profile has no referral
 * source to fill in." That sentence is true of the GPA and false of this one — it reads as a
 * gap the user could go and close, when in fact no profile this tool can hold would ever
 * answer "How did you hear about us?". A user who went looking for the setting would not find
 * it, because there is nothing to find.
 *
 * The upload semantics are here for the same reason from the other direction. They are
 * normally answered by the file branch above, but a form that says "Paste your resume below"
 * classifies as `resume_upload` on a textarea, misses that branch, and produced "Your profile
 * has no resume upload to fill in." about a box that wants pasted text.
 */
const NO_PROFILE_SOURCE: Partial<Record<FormField['semantic'], string>> = {
  referral_source:
    'How you heard about a posting is not something this tool records, so this one is yours to fill in.',
  resume_upload: 'This asks for your resume as text rather than a file. Paste it in yourself.',
  cover_letter_upload:
    'This asks for your cover letter as text rather than a file. Paste it in yourself.',
  transcript_upload:
    'This asks for your transcript as text rather than a file. Paste it in yourself.',
};

/**
 * How to name a semantic in the "your profile has no ___" sentence.
 *
 * Only the ones whose machine name does not survive having its underscores swapped for
 * spaces. That transform is fine for `first_name` and `graduation_date`, and it produced
 * "Your profile has no sponsorship needed to fill in.", "no address line1", "no work auth"
 * and "no gpa" — sentences that are either not English or not the name of anything the user
 * has ever seen in the profile editor. Whenever a semantic is added whose name is an
 * abbreviation, an acronym or a predicate rather than a noun, give it an entry here.
 */
const NO_DATA_NOUN: Partial<Record<FormField['semantic'], string>> = {
  address_line1: 'street address',
  postal: 'postal code',
  region: 'state or region',
  gpa: 'GPA',
  linkedin: 'LinkedIn URL',
  github: 'GitHub URL',
  work_auth: 'work authorization status',
  sponsorship_needed: 'sponsorship status',
  hours_available: 'weekly availability',
  salary_expectation: 'minimum stipend',
};

/**
 * Loose match between a form's question and an approved answer's question.
 *
 * SYMMETRIC ON PURPOSE, and strict. An answer is approved at G3 as the answer to one
 * specific question. The old one-way score — what fraction of the answer's words appear
 * anywhere in the field's label — let a neighbouring question's answer clear the bar
 * whenever the two shared vocabulary, so "Why do you want to work here?" could be filled
 * with the text approved for "Why do you want to work in this field?". That is the user's
 * name on words they never vouched for in that context.
 *
 * Requiring coverage in BOTH directions means a near-miss now falls through to "no
 * approved answer for this question", which is a prompt, not a mistake.
 */
const MATCH_FLOOR = 0.7;

function matchAnswer(field: FormField, answers: ApplicationAnswer[]): ApplicationAnswer | null {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  const significant = (s: string) => new Set(s.split(' ').filter((w) => w.length > 3));

  const target = norm(field.label);
  if (!target) return null;
  const targetWords = significant(target);
  if (targetWords.size === 0) return null;

  let best: { a: ApplicationAnswer; score: number } | null = null;
  for (const a of answers) {
    const words = significant(norm(a.questionText));
    if (words.size === 0) continue;
    const shared = [...words].filter((w) => targetWords.has(w)).length;
    // The weaker of the two directions, so neither question can carry the match alone.
    const score = Math.min(shared / words.size, shared / targetWords.size);
    if (!best || score > best.score) best = { a, score };
  }
  return best && best.score >= MATCH_FLOOR ? best.a : null;
}

export function buildFillPlan(input: PlanInput): FillPlan {
  const actions: FillAction[] = [];
  const skips: FillSkip[] = [];

  for (const field of input.fields) {
    // Belt and braces. The map already marked redlines, but this is the last gate before
    // a value is chosen, and it re-derives rather than trusting the label it was handed.
    const red = checkRedline({ label: field.label, name: field.locator });
    if (field.semantic === 'REDLINE' || red) {
      skips.push({
        field,
        reason: 'redline',
        note: red?.note ?? 'Left for you to complete.',
      });
      continue;
    }

    // A weak guess is the same answer as no guess. classify.ts promises that anything below
    // the confidence floor is left blank, and this is the only place that promise can be
    // kept — nothing between the scanner and here reads `confidence` at all, so a
    // classification scored 0.4 would have been typed into the form as if it were certain.
    // Every stage-1 rule scores well above the floor today, so nothing changes until a
    // weaker source of classifications exists, which is exactly when it needs to be here.
    if (!isActionable(field)) {
      skips.push({
        field,
        reason: 'unknown',
        note: 'This tool could not tell what this field is asking for, so it left it blank.',
      });
      continue;
    }

    if (field.control === 'file') {
      if (field.semantic === 'resume_upload' && input.resumePath) {
        actions.push({
          field,
          // The name, not the path: this is the string the pre-submit review shows the
          // student beside the field, and a stored path tells them nothing about which
          // resume is going.
          value: input.resumeFilename ?? input.resumePath,
          source: 'file',
          filePath: input.resumePath,
          fileName: input.resumeFilename,
        });
      } else {
        skips.push({
          field,
          reason: 'no_data',
          note:
            field.semantic === 'resume_upload'
              ? 'No resume file is attached to this application.'
              : 'Attach this file yourself.',
        });
      }
      continue;
    }

    if (field.semantic === 'essay') {
      const answer = matchAnswer(field, input.answers);
      if (!answer) {
        skips.push({
          field,
          reason: 'needs_answer',
          note: 'Add this question in the workspace and approve an answer for it first.',
        });
      } else if (!answer.approvedAt) {
        // Gate G3, enforced again here. An unapproved answer never reaches a form.
        skips.push({
          field,
          reason: 'needs_answer',
          note: 'You have not approved this answer yet.',
        });
      } else if (carriesBlockingVerdict(answer)) {
        // Approval is a point in time, and this is the check that notices when it has been
        // outlived. An answer approved with the profile as it was, then re-checked against
        // the profile as it is, comes back here still stamped approved but carrying a
        // rejection — that is the only way those two states meet. Reading the stamp alone
        // let a sentence quoting a job the user had since deleted go into an employer's
        // form with this tool's tick beside it.
        //
        // Read off the stored verdicts rather than re-running the guard here, on purpose.
        // This function has the profile but not the posting, and FactGuard without the
        // employer's name turns "What draws me to Northwind Systems" red — a false block
        // on a true sentence, at the last gate, where there is nothing to override it.
        // The verdicts below were produced by a check that did have the name.
        skips.push({
          field,
          reason: 'needs_answer',
          note:
            'This answer was approved against an older version of your profile and no longer ' +
            'matches it. Review it again before this goes anywhere.',
        });
      } else {
        const text = answer.finalText || answer.draftText;
        actions.push({
          field,
          // Respect the form's own budget rather than letting it truncate silently.
          value: field.maxLength ? text.slice(0, field.maxLength) : text,
          source: 'answer',
        });
      }
      continue;
    }

    const value = valueFor(field, input.profile);
    if (value === null || value === '') {
      const noSource = NO_PROFILE_SOURCE[field.semantic];
      skips.push({
        field,
        reason: 'no_data',
        note:
          noSource ??
          `Your profile has no ${NO_DATA_NOUN[field.semantic] ?? field.semantic.replace(/_/g, ' ')} to fill in.`,
      });
      continue;
    }

    actions.push({
      field,
      value: field.maxLength ? value.slice(0, field.maxLength) : value,
      source: 'profile',
    });
  }

  return { actions, skips };
}

/**
 * One line describing a plan before a single key has been pressed.
 *
 * Not what the pre-submit review renders — that counts the run's RESULTS, after the fact.
 * This counts the INTENT, which is the only thing that exists while the form is still
 * untouched, and it is what the fill suite asserts a redline-only page produces.
 */
export function summarizePlan(plan: FillPlan): string {
  const red = plan.skips.filter((s) => s.reason === 'redline').length;
  const other = plan.skips.length - red;
  return (
    `${plan.actions.length} field${plan.actions.length === 1 ? '' : 's'} to fill, ` +
    `${red} left for you, ${other} with nothing to put in ${other === 1 ? 'it' : 'them'}.`
  );
}
