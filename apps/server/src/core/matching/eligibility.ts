/**
 * Hard eligibility rules — docs/05 § Stage 1.
 *
 * THE most consequential module in this system. A false `ineligible` silently costs the
 * user an opportunity they'll never know existed, so every rule here is:
 *
 *   - pure, with the clock injected, so it is exhaustively testable;
 *   - tri-state — `unknown` is a first-class outcome, never rounded to `fail`;
 *   - obliged to cite evidence for every `fail` (a test enforces this).
 *
 * No model decides any of this. The LLM's only job upstream was to extract requirements
 * and quote them; the judgement is plain TypeScript over structured fields.
 */
import { workLocations } from '@ia/shared';
import type { ConfirmedProfile, JobRequirement, RuleResult } from '@ia/shared';
import {
  ageFrom,
  deriveYearsExperience,
  hasDualEnrollment,
  WEIGHTED_TYPES,
} from '../ingestion/deriveFields';
import { validateValue } from './requirementValues';

export interface PostingFacts {
  id: string;
  company: string;
  title: string;
  isOpen: boolean;
  closesAt: string | null;
  locations: Array<{ city?: string; region?: string; country?: string; remote: boolean }>;
  workArrangement: string | null;
  term: { season: string | null; year: number | null; start?: string; end?: string };
}

export interface RuleInput {
  profile: ConfirmedProfile;
  posting: PostingFacts;
  requirements: JobRequirement[];
  now: Date;
}

export type EligibilityStatus = 'eligible' | 'ineligible' | 'unknown';

export interface EligibilityOutcome {
  eligibility: EligibilityStatus;
  rules: RuleResult[];
  blockers: RuleResult[];
}

// ---------------------------------------------------------------- helpers

const pass = (rule: string, because: string, extra: Partial<RuleResult> = {}): RuleResult => ({
  rule,
  status: 'pass',
  because,
  ...extra,
});

const fail = (
  rule: string,
  because: string,
  extra: Partial<RuleResult> & ({ requirementId: string } | { evidence: string }),
): RuleResult => ({ rule, status: 'fail', because, ...extra });

const unknown = (rule: string, because: string, extra: Partial<RuleResult> = {}): RuleResult => ({
  rule,
  status: 'unknown',
  because,
  ...extra,
});

const na = (rule: string, because: string): RuleResult => ({
  rule,
  status: 'not_applicable',
  because,
});

/**
 * The requirement that speaks for a group of same-kind clauses none of which binds.
 *
 * An ambiguous clause outranks a merely preferred one: if any of them could not be read
 * confidently, the honest answer is a question rather than a clean pass.
 */
function speaksFor(reqs: JobRequirement[]): JobRequirement {
  return reqs.find((r) => r.necessity === 'unclear') ?? reqs[0]!;
}

interface StatedMinimum {
  req: JobRequirement;
  min: number;
}

/**
 * Every minimum a posting actually states, lowest first.
 *
 * A posting states more than one of the same kind far more often than it looks: "interns
 * who drive company vehicles must be 21 years of age. All applicants must be 18 years or
 * older to apply." is two `age` requirements, both `required`, both extracted at the same
 * confidence. Picking one of them by a sort let a clause written for a subset of applicants
 * decide the whole rule — a 19-year-old was told the posting requires 21+ and lost it,
 * purely because the vehicle sentence was printed first. Putting the sentences in the other
 * order passed the same person.
 *
 * So every stated minimum is read, and the outcome is decided by where the user falls
 * against all of them: clearing the highest passes, falling below the lowest is the only
 * thing that can disqualify, and landing in between is a question — the posting has told
 * that user two different things and only they can say which one is aimed at them.
 */
function statedMinima(reqs: JobRequirement[]): StatedMinimum[] {
  const out: StatedMinimum[] = [];
  for (const req of reqs) {
    const value = typedValue<{ min: number }>(req);
    if (value) out.push({ req, min: value.min });
  }
  return out.sort((a, b) => a.min - b.min);
}

/**
 * What a requirement the posting did not insist on is allowed to do to a verdict.
 *
 * A posting that says "a Master's is preferred" has already told the user they may apply
 * without one, and failing them on it hid postings that had explicitly welcomed them —
 * "PhD candidates preferred but not required" disqualified an undergraduate on a sentence
 * that says the opposite. Wording nobody could read confidently arrives as `unclear`, and
 * the extraction prompt promises the model that unclear is non-blocking; that promise held
 * for the experience rule and for no other, so a model that hedged honestly still cost the
 * user the posting.
 *
 * A preference passes. An ambiguity is a question for the user to settle, which is exactly
 * what `unknown` is for. Returns null when the posting really does state the requirement,
 * and the rule should go on to do its own work.
 */
function softRequirement(rule: string, req: JobRequirement, what: string): RuleResult | null {
  if (req.necessity === 'preferred') {
    return pass(rule, `${what} is listed as preferred, not required.`, { requirementId: req.id });
  }
  if (req.necessity === 'unclear') {
    return unknown(rule, `${what} is worded too ambiguously to judge — check the posting.`, {
      requirementId: req.id,
    });
  }
  return null;
}

function typedValue<T>(req: JobRequirement): T | null {
  const v = validateValue(req.kind, req.value);
  return v.ok ? (v.value as T) : null;
}

function toYearMonth(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * `profile.derived` is computed when the profile is saved and never again, so a rule that
 * reads it is judging the user as they were on the day they last touched their profile
 * while every other half of the comparison uses the clock passed in here.
 *
 * That gap is a birthday. A student who filled in the wizard at 17 stayed 17 for every
 * matching run afterwards, so "must be 18 to apply" hard-failed them for months after they
 * turned 18 — a false `ineligible` on a fact the profile already contained. Experience
 * drifts the same way: an open-ended job goes on accruing months while the stored figure
 * stands still, and it was the stale 1.6 years that fell short of a three-year requirement
 * the real 2.2 clears.
 *
 * Anything derived from a date and a clock is therefore recomputed here against `now`. The
 * rest of `derived` — academic level, expected graduation — comes from dates the user typed
 * and does not move on its own, so it is read as stored.
 */
function currentAge(profile: ConfirmedProfile, now: Date): number | null {
  // The stored age is still the answer for a profile with no date of birth on it.
  return ageFrom(profile.dateOfBirth, now) ?? profile.derived.age;
}

/**
 * How long after leaving high school a student is still read as on the way somewhere.
 *
 * A high-school diploma is not the end of anybody's education in this population, and the
 * resume rarely says what comes next: a rising freshman admitted in April lists the school
 * he is leaving and not the one he is going to. Reading "you graduated 2026-06" off that
 * and hard-failing him on "must be currently enrolled" filtered out the postings written
 * for exactly him, two months after he stopped being a high schooler, with no override at
 * G2 or G3. Three years covers a gap year and then some; past that the silence really has
 * started to mean something, and someone who left school in 2011 is still refused on a
 * current-students-only posting.
 */
const HIGH_SCHOOL_CONTINUATION_MONTHS = 36;

function monthsSince(ym: string, now: Date): number {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  return (now.getUTCFullYear() - y) * 12 + (now.getUTCMonth() + 1 - m);
}

/**
 * Has this person left high school recently enough that whatever came next simply has not
 * been written down yet? Their expectedGraduation is a high-school date, which answers a
 * different question from the one a posting about degrees is asking.
 */
function recentlyLeftHighSchool(profile: ConfirmedProfile, now: Date): boolean {
  if (profile.derived.academicLevel !== 'high_school') return false;
  const grad = profile.derived.expectedGraduation;
  // No graduation date is derivation saying it CANNOT TELL, and it withholds one whenever a
  // student has two entries of the same rank with one still open — a transfer, a magnet or
  // governor's-school line beside the home high school, the same school read twice. That is
  // an ordinary young resume, and treating the silence as proof of nothing-since flipped the
  // very student this escape was built for from `unknown` to a hard `ineligible`: one extra
  // high-school line, and the same person was refused. A date the app admits it does not have
  // may never be read as an answer, so an unknown graduation keeps the escape open.
  if (!grad) return true;
  if (grad >= toYearMonth(now)) return false;
  return monthsSince(grad, now) <= HIGH_SCHOOL_CONTINUATION_MONTHS;
}

function currentExperienceYears(profile: ConfirmedProfile, now: Date): number {
  // Experience only accrues, so the stored figure can only ever be stale downwards; taking
  // the larger of the two means an incomplete experience list can never invent a shortfall
  // that the stored figure did not already have.
  return Math.max(profile.derived.yearsProfessionalExperience, deriveYearsExperience(profile, now));
}

// ---------------------------------------------------------------- the rules

export function ageMinimum({ profile, requirements, now }: RuleInput): RuleResult {
  const reqs = requirements.filter((r) => r.kind === 'age');
  if (reqs.length === 0) return na('age_minimum', 'The posting does not state a minimum age.');

  const binding = reqs.filter((r) => r.necessity === 'required');
  if (binding.length === 0) {
    return softRequirement('age_minimum', speaksFor(reqs), 'A minimum age')!;
  }

  const minima = statedMinima(binding);
  if (minima.length === 0) {
    return unknown('age_minimum', 'A minimum age is mentioned but could not be parsed.', {
      requirementId: binding[0]!.id,
    });
  }

  const lowest = minima[0]!;
  const highest = minima[minima.length - 1]!;

  const age = currentAge(profile, now);
  if (age === null) {
    return unknown(
      'age_minimum',
      `This posting requires you to be at least ${lowest.min}. Add your date of birth to check.`,
      { requirementId: lowest.req.id, profileRef: 'dateOfBirth' },
    );
  }

  if (age >= highest.min) {
    return pass('age_minimum', `You are ${age}; the posting requires ${highest.min}+.`, {
      requirementId: highest.req.id,
      profileRef: 'derived.age',
    });
  }

  if (age < lowest.min) {
    return fail('age_minimum', `You are ${age}; this posting requires ${lowest.min}+.`, {
      requirementId: lowest.req.id,
      profileRef: 'derived.age',
    });
  }

  return unknown(
    'age_minimum',
    `You are ${age}, and this posting states more than one minimum age ` +
      `(${minima.map((m) => m.min).join(' and ')}) — check which one applies to you.`,
    { requirementId: highest.req.id, profileRef: 'derived.age' },
  );
}

const LEVEL_ORDER = ['high_school', 'associate', 'bachelor', 'master', 'doctorate'];
const ACADEMIC_TO_LEVEL: Record<string, string> = {
  high_school: 'high_school',
  undergrad: 'bachelor',
  masters: 'master',
  phd: 'doctorate',
  bootcamp: 'other',
  none: 'none',
};

export function educationLevel({ profile, requirements, now }: RuleInput): RuleResult {
  const reqs = requirements.filter((r) => r.kind === 'education_level');
  if (reqs.length === 0) {
    return na('education_level', 'The posting does not state an education level.');
  }

  // "Bachelor's or Master's degree" arrives as two separate requirements, one per level,
  // and reading only the first of them let the sort order decide the rule. When the model
  // was the one to spot the master's clause it outranked the regex's bachelor's on
  // confidence and hard-failed an undergraduate the posting had explicitly welcomed.
  // Every level a posting names is an alternative, so they are pooled and meeting any one
  // of them is enough.
  //
  // Only the levels the posting insists on are pooled into `wanted`. A level it merely
  // prefers must never subtract from one it requires, and on its own it cannot disqualify
  // anybody — see softRequirement.
  const wanted = new Map<string, JobRequirement>();
  const merelyLiked = new Map<string, JobRequirement>();
  let parsedAny = false;

  for (const r of reqs) {
    const levels = typedValue<{ levels: string[] }>(r)?.levels ?? [];
    if (levels.length > 0) parsedAny = true;
    const into = r.necessity === 'required' ? wanted : merelyLiked;
    for (const level of levels) if (!into.has(level)) into.set(level, r);
  }

  if (!parsedAny) {
    return unknown('education_level', 'An education requirement could not be parsed.', {
      requirementId: (reqs.find((r) => r.necessity === 'required') ?? reqs[0]!).id,
    });
  }

  if (wanted.size === 0) {
    return softRequirement(
      'education_level',
      speaksFor([...merelyLiked.values()]),
      'A degree level',
    )!;
  }

  const openToAny = wanted.get('any');
  if (openToAny) {
    return pass('education_level', 'Open to any education level.', {
      requirementId: openToAny.id,
    });
  }

  // Whatever the user is measured against has to be a level the posting insists on, or the
  // checklist quotes a sentence that had nothing to do with the verdict: a posting reading
  // "must be enrolled in a PhD program" beside "a bachelor's in mathematics is a plus"
  // rejected an undergraduate and printed the bachelor's sentence — the one welcoming
  // them — as the reason. Only `wanted` is ever cited from here down.
  const binding = [...wanted.values()];

  const mine = ACADEMIC_TO_LEVEL[profile.derived.academicLevel] ?? 'none';
  const mineRank = LEVEL_ORDER.indexOf(mine);

  // A level that is not on the degree ladder cannot be compared with one that is, and
  // comparing it anyway meant a rank of -1 satisfied nothing and hard-failed the user. That
  // covers 'none' and anything else off the ladder — a bootcamp today, whatever the profile
  // schema learns to say next.
  if (mine === 'none' || mineRank === -1) {
    return unknown(
      'education_level',
      mine === 'none'
        ? 'No education history on file to check against.'
        : `Your education (${mine}) is not one of the degree levels this posting names — check it.`,
      { requirementId: binding[0]!.id, profileRef: 'education' },
    );
  }

  // "Enrolled in a Bachelor's" is satisfied by anyone at or above that level.
  const met = [...wanted].find(([level]) => {
    const rank = LEVEL_ORDER.indexOf(level);
    return rank === -1 ? false : mineRank >= rank;
  });

  if (met) {
    return pass('education_level', `Your level (${mine}) meets the requirement.`, {
      requirementId: met[1].id,
      profileRef: 'derived.academicLevel',
    });
  }

  const asked = [...wanted.keys()].join(' or ');

  // Two shapes of young applicant fall short of a degree level on paper and are still not
  // people this rule may refuse.
  //
  // The first is dual enrollment. Deriving that student as `undergrad` used to tell a
  // high-school junior "Your level (bachelor) meets the requirement" — a green tick on a
  // hard gate he had not cleared — and deriving him honestly as `high_school` would simply
  // move the error to the other side of the line and refuse a student whose community
  // college transcript may well be what the posting means. Neither answer is ours to give.
  //
  // The second is the student who has left high school and not yet written down where they
  // went. Refusing them on a degree level quotes a resume that stops one line too early.
  //
  // The sentence says what the resume fails to establish, not what the coursework does. It
  // used to read "runs alongside high school rather than after it", which is a claim about
  // the user's own record that the derivation cannot always back: a high-school line with
  // no dates on it sets the coursework aside because nothing on the page places it either
  // way, and telling that student his coursework runs alongside school is an invention.
  if (hasDualEnrollment(profile, now)) {
    return unknown(
      'education_level',
      `This posting wants ${asked}. Your resume does not place your college coursework ` +
        'after high school, so only you can say whether it counts — check the posting.',
      { requirementId: binding[0]!.id, profileRef: 'education' },
    );
  }

  if (recentlyLeftHighSchool(profile, now)) {
    return unknown(
      'education_level',
      `This posting wants ${asked} and your education history stops at high school. ` +
        'If you have enrolled somewhere since, add it to your profile; otherwise check the posting.',
      { requirementId: binding[0]!.id, profileRef: 'education' },
    );
  }

  return fail('education_level', `This posting wants ${asked}; your level is ${mine}.`, {
    requirementId: binding[0]!.id,
    profileRef: 'derived.academicLevel',
  });
}

export function graduationWindow({ profile, requirements }: RuleInput): RuleResult {
  // A posting routinely names more than one window — "juniors graduating between December
  // 2026 and June 2027, sophomores graduating between December 2027 and June 2028" — and
  // each one is an alternative, not an extra condition. Consulting only whichever sorted
  // first told a sophomore who matched the second sentence that she graduated outside the
  // window, quoting the sentence written for juniors. Every window is read, and matching
  // any one of them is enough.
  const reqs = requirements.filter((r) => r.kind === 'graduation_window');
  if (reqs.length === 0) {
    return na('graduation_window', 'The posting does not state a graduation window.');
  }

  const parsed: Array<{ req: JobRequirement; from?: string; to?: string }> = [];
  for (const r of reqs) {
    const value = typedValue<{ from?: string; to?: string }>(r);
    if (value && (value.from || value.to)) parsed.push({ req: r, ...value });
  }

  if (parsed.length === 0) {
    return unknown('graduation_window', 'A graduation window is mentioned but unparseable.', {
      requirementId: reqs[0]!.id,
    });
  }

  const grad = profile.derived.expectedGraduation;
  if (!grad) {
    return unknown(
      'graduation_window',
      'This posting restricts graduation dates, but yours is not on file.',
      { requirementId: parsed[0]!.req.id, profileRef: 'derived.expectedGraduation' },
    );
  }

  const label = (w: { from?: string; to?: string }) => `${w.from ?? 'any'} to ${w.to ?? 'any'}`;
  const inside = (w: { from?: string; to?: string }) =>
    !(w.from !== undefined && grad < w.from) && !(w.to !== undefined && grad > w.to);

  const met = parsed.find(inside);
  if (met) {
    return pass('graduation_window', `You graduate ${grad}, inside the ${label(met)} window.`, {
      requirementId: met.req.id,
      profileRef: 'derived.expectedGraduation',
    });
  }

  const binding = parsed.filter((w) => w.req.necessity === 'required');
  if (binding.length === 0) {
    return softRequirement(
      'graduation_window',
      speaksFor(parsed.map((w) => w.req)),
      'A graduation window',
    )!;
  }

  // A graduation window is about the degree the employer is hiring for, and a profile whose
  // only date is a high-school one has not got that date yet. The college date is LATER
  // than the one on file by an unknown amount, so a window this user falls short of is a
  // window their real graduation could still land in: a senior finishing school in 2026-11
  // was refused a "graduating 2029 to 2030" posting on his high-school date, which is the
  // class he would be in. Being too EARLY is therefore a question. Being too late is not:
  // a window that closed before the user had even left school is one no later degree can
  // reach backwards into, so that refusal still stands.
  const tooEarly = binding.filter((w) => w.from !== undefined && grad < w.from);
  if (profile.derived.academicLevel === 'high_school' && tooEarly.length > 0) {
    return unknown(
      'graduation_window',
      `This posting wants graduation between ${tooEarly.map(label).join(' or ')}, and the ` +
        `only graduation date on file is high school in ${grad}. Add the programme you are ` +
        'going on to, or check the posting.',
      { requirementId: tooEarly[0]!.req.id, profileRef: 'derived.expectedGraduation' },
    );
  }

  // Naming every window the user was actually measured against, so the sentence cannot
  // quote one date range while the posting offered another.
  return fail(
    'graduation_window',
    `You graduate ${grad}; this posting wants graduation between ${binding.map(label).join(' or ')}.`,
    { requirementId: binding[0]!.req.id, profileRef: 'derived.expectedGraduation' },
  );
}

export function enrollment({ profile, requirements, now }: RuleInput): RuleResult {
  const reqs = requirements.filter((r) => r.kind === 'enrollment');
  if (reqs.length === 0) return na('enrollment', 'The posting does not require active enrolment.');

  // Every clause is read. A posting says this twice as a matter of course — "current
  // students only" in the header, "recent graduates are also welcome to apply" in the small
  // print — and judging it on whichever of them was extracted with the higher confidence let
  // a coin toss filter out every graduate on a posting that had written them an invitation
  // in so many words.
  const parsed: Array<{ req: JobRequirement; required: boolean }> = [];
  for (const r of reqs) {
    const value = typedValue<{ required: boolean }>(r);
    if (value) parsed.push({ req: r, required: value.required });
  }

  if (parsed.length === 0) {
    return unknown('enrollment', 'An enrolment requirement could not be parsed.', {
      requirementId: reqs[0]!.id,
    });
  }

  const demands = parsed.filter((p) => p.required);
  const waivers = parsed.filter((p) => !p.required);

  // Nothing here asks for enrolment at all, so there is no requirement to fall short of.
  if (demands.length === 0) {
    return pass('enrollment', 'Enrolment is not required.', { requirementId: waivers[0]!.req.id });
  }

  // A waiver the posting states outright settles it, because a posting cannot both welcome
  // graduates and disqualify them.
  //
  // Only one it states outright, though. How firmly a waiver is worded has to count for as
  // much as how firmly the demand is, and it did not: a welcoming aside the extractor could
  // barely read — `unclear`, confidence 0.3 — overturned a flat "must be currently enrolled"
  // all by itself, so a graduate was told they were eligible on the weakest sentence in the
  // posting while the posting's own rule said otherwise. The same principle already governs
  // the other rules here: only `required` clauses are pooled into the education levels a
  // posting wants, and only a `required` refusal to sponsor closes the work-authorization
  // door. A softer waiver is handled at the bottom, where it can raise a question but not
  // answer one.
  const stated = waivers.find((p) => p.req.necessity === 'required');
  if (stated) {
    return pass('enrollment', 'Enrolment is not required.', { requirementId: stated.req.id });
  }

  // Only now does how firmly the posting asks for enrolment matter: "preferably still
  // enrolled" was read as a rule and filtered recent graduates out of postings that had
  // merely expressed a wish.
  const demanded = demands.map((p) => p.req);
  const binding = demanded.filter((r) => r.necessity === 'required');
  if (binding.length === 0) {
    return softRequirement('enrollment', speaksFor(demanded), 'Active enrolment')!;
  }
  const req = binding[0]!;

  const grad = profile.derived.expectedGraduation;
  if (!grad) {
    return unknown('enrollment', 'Active enrolment is required; your graduation date is unknown.', {
      requirementId: req.id,
      profileRef: 'derived.expectedGraduation',
    });
  }

  if (grad >= toYearMonth(now)) {
    return pass('enrollment', `You are still enrolled (graduating ${grad}).`, {
      requirementId: req.id,
      profileRef: 'derived.expectedGraduation',
    });
  }

  // The posting insists on enrolment, this user has already graduated, and somewhere else
  // the posting hints that graduates may apply anyway. That is the posting contradicting
  // itself on the one sentence that would filter this user out, and only they can say which
  // of the two was written for them — the same answer the citizenship rule gives to a soft
  // clause naming a nationality the user holds. Hiding the posting on the strict sentence
  // alone would bury the one that invited them.
  const hint = waivers[0];
  if (hint) {
    return unknown(
      'enrollment',
      `This posting requires active enrolment and you graduated ${grad}, but it also ` +
        'suggests enrolment is not needed — check the posting.',
      { requirementId: hint.req.id, profileRef: 'derived.expectedGraduation' },
    );
  }

  // Leaving high school is not finishing your education, and this tool's users are the
  // people that is least true of. A rising freshman's resume names the school he is walking
  // out of and not the one he starts in September, so the only date on file says "graduated
  // 2026-06" and it filtered him out of every current-students-only posting written for
  // him. See HIGH_SCHOOL_CONTINUATION_MONTHS: recently enough and this is a question, long
  // enough ago and the refusal stands.
  if (recentlyLeftHighSchool(profile, now)) {
    return unknown(
      'enrollment',
      `This posting requires active enrolment. Your education history ends with high ` +
        `school in ${grad} and does not say what came next, so only you can say whether ` +
        'you are enrolled now.',
      { requirementId: req.id, profileRef: 'derived.expectedGraduation' },
    );
  }

  return fail('enrollment', `This posting requires active enrolment; you graduated ${grad}.`, {
    requirementId: req.id,
    profileRef: 'derived.expectedGraduation',
  });
}

interface WorkAuthValue {
  sponsorshipUnavailable?: boolean;
  requiresExistingAuthorization?: boolean;
}

export function workAuthorization({ profile, requirements }: RuleInput): RuleResult {
  const reqs = requirements.filter((r) => r.kind === 'work_auth');
  if (reqs.length === 0) {
    return na('work_authorization', 'The posting does not mention work authorization.');
  }

  const parsed: Array<{ req: JobRequirement; value: WorkAuthValue }> = [];
  for (const req of reqs) {
    const value = typedValue<WorkAuthValue>(req);
    if (value) parsed.push({ req, value });
  }

  if (parsed.length === 0) {
    return unknown('work_authorization', 'A work-authorization clause could not be parsed.', {
      requirementId: reqs[0]!.id,
    });
  }

  const auth = profile.workAuthorization;
  if (auth.status === 'unknown') {
    return unknown('work_authorization', 'Your work-authorization status is not on file.', {
      requirementId: reqs[0]!.id,
      profileRef: 'workAuthorization.status',
    });
  }

  if (!auth.needsSponsorship) {
    return pass('work_authorization', 'You do not need sponsorship.', {
      requirementId: reqs[0]!.id,
      profileRef: 'workAuthorization.needsSponsorship',
    });
  }

  // A posting can say both "must be authorized to work in the US" and "we do not sponsor".
  // Judging it on whichever of the two sorted first told a user who needs sponsorship that
  // the posting "does not rule it out" while one of its own sentences did exactly that, so
  // every clause is read and any refusal the posting states decides.
  //
  // Requiring existing authorization is deliberately not a blocker by itself: plenty of
  // employers write that line and sponsor anyway, and treating it as a refusal would hide
  // postings the user could actually get.
  //
  // Only a refusal the posting actually states closes the door. A clause that merely says
  // the employer would rather not sponsor, or one nobody could read confidently, used to
  // hard-fail every applicant who needs a visa on wording that never ruled them out — and
  // this is the rule where that costs the most, because these are the postings a
  // sponsorship-dependent student most needs to see.
  const refusals = parsed.filter((p) => p.value.sponsorshipUnavailable);
  const stated = refusals.find((p) => p.req.necessity === 'required');
  if (stated) {
    return fail(
      'work_authorization',
      'You need sponsorship and this posting states it is not available.',
      { requirementId: stated.req.id, profileRef: 'workAuthorization.needsSponsorship' },
    );
  }

  const hedged = refusals.find((p) => p.req.necessity === 'unclear');
  if (hedged) {
    return unknown(
      'work_authorization',
      'You need sponsorship, and the posting is too vague about whether it offers any — check it.',
      { requirementId: hedged.req.id, profileRef: 'workAuthorization.needsSponsorship' },
    );
  }

  const wished = refusals[0];
  if (wished) {
    return pass(
      'work_authorization',
      'You need sponsorship; the posting would rather you did not, but it does not rule it out.',
      { requirementId: wished.req.id, profileRef: 'workAuthorization.needsSponsorship' },
    );
  }

  return pass('work_authorization', 'You need sponsorship; the posting does not rule it out.', {
    requirementId: parsed[0]!.req.id,
    profileRef: 'workAuthorization.needsSponsorship',
  });
}

export function citizenship({ profile, requirements }: RuleInput): RuleResult {
  const reqs = requirements.filter((r) => r.kind === 'citizenship');
  if (reqs.length === 0) {
    return na('citizenship', 'The posting does not state a citizenship requirement.');
  }

  // "Requires US citizenship and an active security clearance" is two requirements, and
  // reading only one of them dropped the clearance advisory on the floor — the user was
  // told the citizenship requirement was met and never heard about the clearance at all.
  //
  // Which countries qualify is read from EVERY clause, however firmly each is worded, and
  // how firmly they are worded decides only what happens to someone who matches none of
  // them. Pooling just the `required` clauses meant a posting that requires US citizenship
  // and adds "Canadian citizens may also apply" hard-failed a Canadian on the strength of
  // the first sentence while the second sentence was written for exactly that person.
  // "U.S. citizens preferred" beside a hard rule is the opposite case and must not widen
  // anything, which is why a softer clause is only ever consulted about the user's own
  // nationality, never added to the list the rejection quotes.
  const required: string[] = [];
  let requiredFrom: JobRequirement | undefined;
  const merelyLiked: Array<{ req: JobRequirement; countries: string[] }> = [];
  let clearanceFrom: JobRequirement | undefined;
  let parsedAny = false;

  for (const r of reqs) {
    const value = typedValue<{ countries?: string[]; clearanceRequired?: boolean }>(r);
    if (!value) continue;
    parsedAny = true;
    if (value.countries?.length) {
      if (r.necessity === 'required') {
        required.push(...value.countries);
        requiredFrom ??= r;
      } else {
        merelyLiked.push({ req: r, countries: value.countries });
      }
    }
    if (value.clearanceRequired) clearanceFrom ??= r;
  }

  if (!parsedAny) {
    return unknown('citizenship', 'A citizenship clause could not be parsed.', {
      requirementId: reqs[0]!.id,
    });
  }

  const holds = (countries: string[]): boolean =>
    countries.some((c) => profile.citizenships.some((m) => m.toUpperCase() === c.toUpperCase()));

  if (requiredFrom && required.length) {
    if (profile.citizenships.length === 0) {
      return unknown(
        'citizenship',
        `This posting requires ${required.join(' or ')} citizenship; yours is not on file.`,
        { requirementId: requiredFrom.id, profileRef: 'citizenships' },
      );
    }
    if (!holds(required)) {
      // A softer clause naming a nationality the user actually holds is the posting
      // contradicting itself, and the user is the only one who can resolve it. Hiding the
      // posting on the strict sentence alone would bury the sentence that invited them.
      const invited = merelyLiked.find((m) => holds(m.countries));
      if (invited) {
        return unknown(
          'citizenship',
          `This posting requires ${required.join(' or ')} citizenship but also mentions ` +
            `${invited.countries.join(' or ')}, which you hold — check whether you qualify.`,
          { requirementId: invited.req.id, profileRef: 'citizenships' },
        );
      }
      return fail(
        'citizenship',
        `Requires ${required.join(' or ')} citizenship; you hold ${profile.citizenships.join(', ')}.`,
        { requirementId: requiredFrom.id, profileRef: 'citizenships' },
      );
    }
  }

  if (clearanceFrom) {
    return unknown(
      'citizenship',
      'This posting requires a security clearance. The tool cannot verify that — check yourself.',
      { requirementId: clearanceFrom.id },
    );
  }

  if (!requiredFrom && merelyLiked.length > 0) {
    return softRequirement(
      'citizenship',
      speaksFor(merelyLiked.map((m) => m.req)),
      'A citizenship requirement',
    )!;
  }

  return pass('citizenship', 'Citizenship requirement met.', {
    requirementId: (requiredFrom ?? reqs[0]!).id,
  });
}

/**
 * Locations are compared as text, not as distances.
 *
 * Nothing upstream geocodes a posting, so there are no coordinates to measure with and
 * `locationPrefs.maxCommuteKm` decides nothing in this rule. A city the rule does not
 * recognise comes back `unknown` for the user to judge, rather than being guessed at.
 */
export function location({ profile, posting }: RuleInput): RuleResult {
  const arrangement = posting.workArrangement;
  const prefs = profile.locationPrefs;

  // "Remote" and "offers remote" are different postings, and only the first one can be
  // failed on a remote preference. Greenhouse writes "New York, NY or Remote" as ONE
  // location, which parseLocation turns into {city:'New York', remote:true} — so a
  // `.some(l => l.remote)` test used to hard-fail a user living in New York who simply
  // prefers to go in. A remote flag is disqualifying only when nowhere else is offered.
  //
  // `workArrangement` gets the same treatment, and for a sharper reason: it is one word
  // scraped out of the description, not a field any board fills in. "Our teams collaborate
  // with remote colleagues across the world" on a posting headed "Location: New York, NY"
  // came back `remote`, and "some full-time roles are hybrid" came back `hybrid` on a
  // posting that says interns are onsite five days a week — both then hid an office job in
  // the user's own city from them. An office the posting names outranks a word from its
  // prose, so neither arrangement can hard-fail while the posting offers somewhere to go;
  // the location comparison below decides those, and it can only pass or ask.
  const offices = posting.locations.filter((l) => l.city || l.region);

  const remoteOnly =
    (arrangement === 'remote' && offices.length === 0) ||
    (posting.locations.length > 0 &&
      posting.locations.every((l) => l.remote && !l.city && !l.region));

  if (remoteOnly) {
    return prefs.remoteOk
      ? pass('location', 'Remote, which you accept.', { profileRef: 'locationPrefs.remoteOk' })
      : fail('location', 'This posting is remote and you have remote turned off.', {
          evidence: `workArrangement=${arrangement ?? 'remote'}`,
          profileRef: 'locationPrefs.remoteOk',
        });
  }

  if (prefs.remoteOk && posting.locations.some((l) => l.remote)) {
    return pass('location', 'Offered remote, which you accept.', {
      profileRef: 'locationPrefs.remoteOk',
    });
  }

  if (arrangement === 'hybrid' && !prefs.hybridOk && offices.length === 0) {
    return fail('location', 'This posting is hybrid and you have hybrid turned off.', {
      evidence: 'workArrangement=hybrid',
      profileRef: 'locationPrefs.hybridOk',
    });
  }

  if (posting.locations.length === 0) {
    return unknown('location', 'The posting does not say where the role is based.');
  }

  // Empty strings are the enemy of `includes`. A base city starts as '' and the wizard lets a
  // user fill in the state alone, which made label.includes('') true and passed EVERY posting
  // on earth with "within your commute area" — a confident sentence about a comparison that
  // never happened. `workLocations` drops the empty ones; the same hole in an empty relocation
  // target is guarded by the filter below.
  //
  // Every place the user can work from is checked, not only the home address: a student based
  // at home AND at school should see a posting in either city as a match, not have the campus
  // one come back "not your home city" for want of a place to compare it against.
  const bases = workLocations(prefs).map((b) => ({
    city: b.city.toLowerCase(),
    label: `${b.city} ${b.region}`.toLowerCase().trim(),
  }));
  const targets = prefs.relocateTo.map((t) => t.trim().toLowerCase()).filter(Boolean);

  const matches = posting.locations.some((l) => {
    const label = [l.city, l.region].filter(Boolean).join(' ').toLowerCase();
    if (!label) return false;
    if (bases.some((b) => b.city && (label.includes(b.city) || b.label.includes(label))))
      return true;
    return targets.some((t) => label.includes(t) || t.includes(label));
  });

  if (matches) {
    return pass('location', 'In one of your locations, or a relocation target.', {
      profileRef: 'locationPrefs',
    });
  }

  const where = posting.locations
    .map((l) => [l.city, l.region].filter(Boolean).join(', '))
    .filter(Boolean)
    .join(' / ');

  // Without coordinates we cannot measure a radius, so this is `unknown`, not `fail`.
  // Guessing here would hide postings in a neighbouring town.
  return unknown(
    'location',
    `Based in ${where}, which is not one of your locations or a stated relocation target. ` +
      'Distance cannot be measured without coordinates — check whether it works for you.',
    { evidence: where, profileRef: 'locationPrefs.base' },
  );
}

/** Weeks of overlap between the posting's term and the user's availability window. */
export function overlapWeeks(
  term: { start?: string; end?: string },
  avail: { start?: string; end?: string },
): number | null {
  if (!term.start || !term.end || !avail.start || !avail.end) return null;

  // Starts open at the first of the month, ends close at the end of it. Treating both as
  // the first was the bug: it shortened every month-precision term by up to 30 days.
  const ts = Date.parse(monthStart(term.start));
  const te = endBound(term.end);
  const as = Date.parse(monthStart(avail.start));
  const ae = endBound(avail.end);
  if ([ts, te, as, ae].some(Number.isNaN)) return null;

  const start = Math.max(ts, as);
  const end = Math.min(te, ae);
  return end <= start ? 0 : (end - start) / (1000 * 60 * 60 * 24 * 7);
}

/**
 * A month-only bound has to be widened at the END, not just parsed.
 *
 * `2027-08` as a term end means "through August", but reading it as 2027-08-01 threw away
 * up to a month of overlap — and always in the direction of a hard fail. A June-to-August
 * internship against a July-to-September availability computed three weeks of overlap
 * instead of seven and came back `ineligible`.
 *
 * A day-precision start is already exact and is left alone.
 */
function monthStart(d: string): string {
  return /^\d{4}-\d{2}$/.test(d) ? `${d}-01` : d;
}

/** The instant a bound stops covering: the first moment past the day or month it names. */
function endBound(d: string): number {
  if (/^\d{4}-\d{2}$/.test(d)) {
    const [y, m] = d.split('-').map(Number);
    // Month is 1-based here and 0-based in Date.UTC, so this is already "the next month".
    return Date.UTC(y!, m!, 1);
  }

  // A plain date covers the whole of the day it names, exactly as a plain month covers the
  // whole of its month. Reading it as midnight threw away the last day of the user's own
  // availability window, which is always a day-precision date: somebody free from June 1
  // through July 12 has the six weeks this rule demands to the hour, and was refused with
  // "only about 6 week(s); 6 are needed".
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) {
    const midnight = Date.parse(`${d}T00:00:00Z`);
    return Number.isNaN(midnight) ? midnight : midnight + 24 * 60 * 60 * 1000;
  }

  return Date.parse(d);
}

const MIN_OVERLAP_WEEKS = 6;

/**
 * Typical Northern-Hemisphere academic terms. US-only is a locked v1 decision
 * (docs/11 § Decisions), so these are safe; revisit if other markets are added.
 */
const SEASON_MONTHS: Record<string, { start: number; end: number }> = {
  summer: { start: 6, end: 8 },
  fall: { start: 9, end: 12 },
  winter: { start: 1, end: 3 },
  spring: { start: 3, end: 5 },
};

/** The months "Summer 2027" covers, or null when the posting names no season and year. */
function seasonWindow(term: PostingFacts['term']): { start: string; end: string } | null {
  if (!term.season || !term.year) return null;
  const months = SEASON_MONTHS[term.season];
  if (!months) return null;
  return {
    start: `${term.year}-${String(months.start).padStart(2, '0')}`,
    end: `${term.year}-${String(months.end).padStart(2, '0')}`,
  };
}

/**
 * The window a posting's term covers, and whether it is firm enough to reject somebody on.
 *
 * Measured against real postings, almost none state explicit start and end dates, so
 * requiring them made `term_overlap` return `unknown` for 100% of a 302-posting run —
 * which badged the entire queue and destroyed the signal the tri-state exists to carry.
 * A season plus a year is enough to answer the only question this rule asks.
 *
 * `term.start`/`term.end` look like structured fields and are nothing of the kind: no board
 * publishes them, and every one of them comes from a regex that hunts the description for
 * any "<month> <year> to <month> <year>" it can find. That regex cannot tell a term from an
 * application window, so "applications are accepted from September 2026 through November
 * 2026 for our Summer 2027 program" was stored as a term of 2026-09..2026-11 — and, being
 * treated as exact, hard-failed every summer-2027 student on the deadline for the job they
 * were reading about. A window is only firm when the posting's own season and year back it
 * up; on its own it can raise a question and nothing more.
 */
export function deriveTermWindow(term: PostingFacts['term']): {
  window: { start: string; end: string } | null;
  approximate: boolean;
  /** Where the window came from, so the sentence shown to the user can say so. */
  source: 'text' | 'season' | null;
} {
  const season = seasonWindow(term);

  if (term.start && term.end) {
    const window = { start: term.start, end: term.end };
    const corroborated = season !== null && (overlapWeeks(window, season) ?? 0) > 0;
    return { window, approximate: !corroborated, source: 'text' };
  }

  if (season) return { window: season, approximate: true, source: 'season' };

  return { window: null, approximate: false, source: null };
}

interface TermCandidate {
  window: { start: string; end: string };
  approximate: boolean;
  /** How the sentence shown to the user should name this window. */
  inferredAs: string;
  /** Why it cannot be relied on, when it cannot. */
  caveat: string;
  requirementId?: string;
}

export function termOverlap({ profile, posting, requirements }: RuleInput): RuleResult {
  const derived = deriveTermWindow(posting.term);
  const candidates: TermCandidate[] = [];

  if (derived.window) {
    candidates.push({
      window: derived.window,
      approximate: derived.approximate,
      inferredAs:
        derived.source === 'season'
          ? `a ${posting.term.season} ${posting.term.year} term`
          : `a ${derived.window.start} to ${derived.window.end} term`,
      caveat:
        derived.source === 'season'
          ? 'The posting gives no exact dates'
          : 'Those dates were read out of the description and nothing in the posting confirms they are the term',
    });
  } else {
    // Dates a posting states only in prose ("runs June through August 2027") reach the rule
    // as term_dates requirements, and without them it went not_applicable on postings that
    // plainly said when the role runs. A posting naming more than one window — a spring
    // cohort and a summer one — is naming alternatives, so every one of them is measured
    // and the best overlap decides; taking whichever was extracted most confidently judged
    // a summer student against the spring dates. Extracted dates stay approximate, so they
    // can raise a question and never hard-fail anyone.
    for (const req of requirements.filter((r) => r.kind === 'term_dates')) {
      const value = typedValue<{ start?: string; end?: string }>(req);
      if (!value?.start || !value.end) continue;
      candidates.push({
        window: { start: value.start, end: value.end },
        approximate: true,
        inferredAs: `a ${value.start} to ${value.end} term`,
        caveat: 'The posting gives these dates only in its text',
        requirementId: req.id,
      });
    }
  }

  if (candidates.length === 0) {
    // The posting simply doesn't say when the role runs. That's missing information
    // about the posting, not an unresolved question about the user's eligibility, so
    // flagging it would put a badge on nearly every row and mean nothing.
    return na('term_overlap', 'The posting does not say when the role runs.');
  }

  const cite = (c: TermCandidate) => (c.requirementId ? { requirementId: c.requirementId } : {});

  if (!profile.availability.start || !profile.availability.end) {
    return unknown(
      'term_overlap',
      'Your availability window is not set, so overlap cannot be checked.',
      { profileRef: 'availability', ...cite(candidates[0]!) },
    );
  }

  let best: { candidate: TermCandidate; weeks: number } | null = null;
  for (const candidate of candidates) {
    const weeks = overlapWeeks(candidate.window, profile.availability);
    if (weeks === null) continue;
    if (!best || weeks > best.weeks) best = { candidate, weeks };
  }

  if (!best) {
    return unknown(
      'term_overlap',
      'Either the posting or your availability has unreadable dates, so overlap cannot be checked.',
      cite(candidates[0]!),
    );
  }

  const { candidate, weeks } = best;

  if (weeks >= MIN_OVERLAP_WEEKS) {
    return pass('term_overlap', `Overlaps your availability by about ${Math.round(weeks)} weeks.`, {
      profileRef: 'availability',
      ...cite(candidate),
    });
  }

  // A window nothing in the posting confirms is a guess about the calendar, not a fact
  // about the user. Never let one produce a hard rejection.
  if (candidate.approximate) {
    return unknown(
      'term_overlap',
      `Inferred ${candidate.inferredAs} from the posting, which looks like ` +
        `about ${Math.round(weeks)} week(s) of overlap with your availability. ${candidate.caveat} — check it.`,
      { profileRef: 'availability', ...cite(candidate) },
    );
  }

  // The verdict is decided on the exact overlap while the sentence quoted a rounded one, so
  // a window five and a half weeks long was refused with "only about 6 week(s); 6 are
  // needed" — a rejection that reads as an argument for accepting. A shortfall is reported
  // rounded DOWN, so the number in the sentence can never reach the threshold it missed.
  const short = Math.floor(weeks * 10) / 10;
  return fail(
    'term_overlap',
    `Overlaps your availability by only about ${short} weeks; ${MIN_OVERLAP_WEEKS} are needed.`,
    {
      evidence: `term ${candidate.window.start}..${candidate.window.end}`,
      profileRef: 'availability',
    },
  );
}

export function deadline({ posting, now }: RuleInput): RuleResult {
  if (!posting.closesAt) return na('deadline', 'No closing date stated.');

  // A date with no time means the whole of that day, not its first instant. USAJOBS and
  // JSON-LD both hand over bare dates, and Date.parse puts those at midnight UTC — which
  // closed the posting a full day early and reported "Closed on <today>" to a user who
  // still had hours to apply. Close of business, generously: end of that day.
  //
  // End of day is read in UTC, and deliberately so. Stretching it to UTC-10 to cover the
  // westmost US zone was tried and reverted: it is a different rule from the one docs/05
  // § Rules states ("the whole of that day"), and it carries the deadline ten hours into
  // the following day, so "Closed on <date>" stops being true of the date it names.
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(posting.closesAt.trim());
  const closes = dateOnly
    ? Date.parse(`${posting.closesAt.trim()}T23:59:59Z`)
    : Date.parse(posting.closesAt);
  if (Number.isNaN(closes)) return unknown('deadline', 'The closing date could not be read.');

  return closes >= now.getTime()
    ? pass('deadline', `Closes ${posting.closesAt.slice(0, 10)}.`, { evidence: posting.closesAt })
    : fail('deadline', `Closed on ${posting.closesAt.slice(0, 10)}.`, {
        evidence: posting.closesAt,
      });
}

export function postingOpen({ posting }: RuleInput): RuleResult {
  return posting.isOpen
    ? pass('posting_open', 'Still listed as open.')
    : fail('posting_open', 'This posting is no longer open.', { evidence: 'isOpen=false' });
}

const EXPERIENCE_TOLERANCE_YEARS = 1;

export function experienceCeiling({ profile, requirements, now }: RuleInput): RuleResult {
  const reqs = requirements.filter((r) => r.kind === 'experience_years');
  if (reqs.length === 0) {
    return na('experience_ceiling', 'No professional-experience requirement stated.');
  }

  // Wording that could not be read confidently used to be reported as "listed as
  // preferred" — a claim about the posting that it never made. It is a question now.
  const binding = reqs.filter((r) => r.necessity === 'required');
  if (binding.length === 0) {
    return softRequirement('experience_ceiling', speaksFor(reqs), 'Professional experience')!;
  }

  // "One year of programming experience required; three years of Python preferred, five for
  // the senior track" is several requirements of one kind, and the same rule applies to
  // them as to a minimum age: the lowest is the one that gates applying at all.
  const minima = statedMinima(binding);
  if (minima.length === 0) {
    return unknown('experience_ceiling', 'An experience requirement could not be parsed.', {
      requirementId: binding[0]!.id,
    });
  }

  const lowest = minima[0]!;
  const highest = minima[minima.length - 1]!;
  const mine = currentExperienceYears(profile, now);
  const ceiling = mine + EXPERIENCE_TOLERANCE_YEARS;

  if (highest.min <= ceiling) {
    return pass('experience_ceiling', `Wants ${highest.min}y; you have about ${mine}y.`, {
      requirementId: highest.req.id,
      profileRef: 'derived.yearsProfessionalExperience',
    });
  }

  if (lowest.min > ceiling) {
    /**
     * "You have about 0" has to mean nothing counted, not nothing was dated.
     *
     * `deriveYearsExperience` skips every entry with no start date — rightly, since guessing
     * one turned an undated line into decades — and `experience.N.startDate` is a dismissible
     * G1 flag, so a real multi-year job whose date the extractor could not read, or whose flag
     * the user waved off, contributes zero. Failing on that told a qualified applicant
     * "Requires 2 years of professional experience; you have about 0" on the strength of data
     * the app knows it does not have, and a wrongly-ineligible posting is the worst outcome
     * this file has. When the countable total is zero and there ARE weighted entries the dates
     * are missing from, the honest answer is the tri-state's third branch.
     */
    const undated = profile.experience.filter(
      (e) => !e.startDate && (WEIGHTED_TYPES as readonly string[]).includes(e.type),
    );
    if (mine === 0 && undated.length > 0) {
      return unknown(
        'experience_ceiling',
        `This posting wants ${lowest.min} years of professional experience. ` +
          `${undated.length === 1 ? 'One entry on your profile has' : `${undated.length} entries on your profile have`} ` +
          'no start date, so how long you worked cannot be measured — fill the dates in at G1 ' +
          'and this answers itself.',
        { requirementId: lowest.req.id, profileRef: 'derived.yearsProfessionalExperience' },
      );
    }
    return fail(
      'experience_ceiling',
      `Requires ${lowest.min} years of professional experience; you have about ${mine}.`,
      { requirementId: lowest.req.id, profileRef: 'derived.yearsProfessionalExperience' },
    );
  }

  return unknown(
    'experience_ceiling',
    `You have about ${mine} years, and this posting states more than one length of ` +
      `experience (${minima.map((m) => m.min).join(' and ')} years) — check which one applies to you.`,
    { requirementId: highest.req.id, profileRef: 'derived.yearsProfessionalExperience' },
  );
}

export function excludedCompany({ profile, posting }: RuleInput): RuleResult {
  const company = posting.company.toLowerCase().trim();

  // An entry matches whole words in the company name, which is what makes "Amazon" catch
  // "Amazon Web Services". It used to match anywhere at all, and a bare substring buried
  // companies the user had never heard of: "Meta" hid Metabase, "AI" hid Airbnb and
  // Chainalysis, and a single "X" hid Netflix — a false `ineligible` the user could not
  // explain even after reading their own exclude list. The word boundary is the whole fix;
  // the exact-match arm below keeps an entry like "Yahoo!" working, since punctuation at
  // the end of a word has no boundary after it.
  //
  // The sentence, too, claimed the company itself was on the list, so the same user was
  // told "Metabase is on your exclude list" about a name they could not find in their own
  // settings. Naming the entry that actually matched makes the rejection something they
  // can act on.
  const hit = profile.preferences.excludeCompanies.find((entry) => {
    const needle = entry.toLowerCase().trim();
    if (needle === '') return false;
    if (needle === company) return true;
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'u').test(company);
  });

  if (!hit) return pass('excluded_company', 'Not on your exclude list.');

  const isWholeName = hit.toLowerCase().trim() === company;
  return fail(
    'excluded_company',
    isWholeName
      ? `${posting.company} is on your exclude list.`
      : `${posting.company} matches "${hit.trim()}" on your exclude list.`,
    { evidence: posting.company, profileRef: 'preferences.excludeCompanies' },
  );
}

/**
 * A postdoctoral position, which by definition asks for a doctorate somebody has finished.
 *
 * Read off the TITLE rather than out of the requirements, because postings for these rarely
 * bother to state the degree — the word carries it. "Post-doctoral" means after the doctorate;
 * there is no reading of it that admits an undergraduate.
 *
 * This is the only rule in the file that infers a requirement from a title, and it is drawn as
 * narrowly as the word allows. "Fellow" and "Fellowship" are NOT enough and must not be added:
 * the Anthropic Fellows Program and a hundred like it are open to exactly the people this
 * would then hide the list from. An eligibility failure removes a posting from the queue, so
 * the bar for inferring one is that the word cannot mean anything else.
 *
 * Found by running a real search: a postdoctoral fellowship sat in the top fifteen eligible
 * matches for an undergraduate, with the score breakdown noting "fellowship vs your
 * entry_intern band" and nothing acting on it.
 */
const POSTDOCTORAL = /\bpost[-\s]?doc(?:toral|torate)?\b/i;

/**
 * The title naming a student post in its own right.
 *
 * The docstring above says the bar is that the word "cannot mean anything else" — and it can.
 * A university's postdoc office hires students to run it: "Research Intern, Postdoctoral
 * Affairs Office", "Summer Intern - Postdoc Program Support", "Intern, Post-Doctoral
 * Recruiting" all match POSTDOCTORAL, and all three are internships an undergraduate or a
 * high-school student can hold. Every one of them came back a hard `ineligible` and left the
 * queue — a FALSE ineligible, which this file's header calls the worst thing it can produce,
 * arrived at by reading the word "postdoctoral" as the post rather than as the subject.
 */
const STUDENT_POST = /\b(?:intern|interns|internship|co[-\s]?op|apprentice|trainee)\b/i;

export function postdoctoral({ profile, posting }: RuleInput): RuleResult {
  if (!POSTDOCTORAL.test(posting.title)) {
    return na('postdoctoral', 'The posting is not a postdoctoral position.');
  }

  /**
   * Two readings, so no verdict. A title holding both words is either a postdoctoral post or
   * a student one beside postdoctoral work, and nothing in the title settles which — so this
   * says so rather than picking. `unknown` keeps the posting in front of the user with the
   * doubt written on it, which is what the tri-state is for; `fail` would hide a job they
   * could have had, and `pass` would waste their time silently.
   */
  if (STUDENT_POST.test(posting.title)) {
    return unknown(
      'postdoctoral',
      'The title says both "postdoctoral" and an internship, so it may be a postdoctoral post ' +
        'or a student one supporting that work. Check the posting.',
      { evidence: posting.title, profileRef: 'education' },
    );
  }

  const mine = ACADEMIC_TO_LEVEL[profile.derived.academicLevel] ?? 'none';
  if (mine === 'doctorate') {
    return pass('postdoctoral', 'A postdoctoral position, and you have a doctorate.', {
      evidence: posting.title,
    });
  }

  return fail(
    'postdoctoral',
    'This is a postdoctoral position, which asks for a doctorate you have not finished.',
    { evidence: posting.title, profileRef: 'education' },
  );
}

export const RULES = [
  postingOpen,
  deadline,
  ageMinimum,
  educationLevel,
  postdoctoral,
  graduationWindow,
  enrollment,
  workAuthorization,
  citizenship,
  location,
  termOverlap,
  experienceCeiling,
  excludedCompany,
] as const;

export function evaluateEligibility(input: RuleInput): EligibilityOutcome {
  const rules = RULES.map((rule) => rule(input));
  const blockers = rules.filter((r) => r.status === 'fail');

  const eligibility: EligibilityStatus =
    blockers.length > 0
      ? 'ineligible'
      : rules.some((r) => r.status === 'unknown')
        ? 'unknown'
        : 'eligible';

  return { eligibility, rules, blockers };
}
