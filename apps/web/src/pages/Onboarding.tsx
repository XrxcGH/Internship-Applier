import { ChevronDown, ChevronUp, Plus } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { bulletlessExperience, EducationLevel, isEmailShaped, lostTheEvidence } from '@ia/shared';
import type { CandidateProfile, EducationEntry, WorkLocation } from '@ia/shared';
import * as api from '../lib/api';
import {
  ANSWERED_IN_WIZARD,
  flagLabel,
  isAnswered,
  isDismissible,
  OPTIONAL_WIZARD_FIELDS,
} from '../lib/review';
import {
  dateProblem,
  readUrlField,
  remapListFlags,
  remapTypedBoxes,
  tidyList,
} from '../lib/profileEdit';
import { Page, RunningHead, Section } from '../components/Chrome';
import { Button, Notice, SelectField, TextField } from '../components/Controls';
import {
  CertificationsEditor,
  ExperienceEditor,
  LanguagesEditor,
  LinksEditor,
  ListEditor,
  PreferencesEditor,
  ProjectsEditor,
  SkillsEditor,
} from '../components/ProfileEditors';

type Step = 'upload' | 'confirm' | 'facts' | 'done';

/** The three numbers a school row can hold, in the order the boxes are laid out. */
const GPA_PARTS = ['value', 'scale', 'weighted'] as const;
type GpaPart = (typeof GPA_PARTS)[number];

const GPA_LABELS: Record<GpaPart, string> = {
  value: 'Unweighted GPA',
  scale: 'Scale',
  weighted: 'Weighted GPA',
};

const LEVEL_LABELS: Record<EducationEntry['level'], string> = {
  high_school: 'High school',
  associate: 'Associate',
  bachelor: 'Bachelor',
  master: 'Master',
  doctorate: 'Doctorate',
  other: 'Something else',
};

/**
 * What one edit does to the review list. The whole of G1's clearing rule lives here.
 *
 * A flag clears only when the field now holds an answer. Any onChange used to clear it,
 * including a change BACK to the unanswered value. The work-authorization select exposes its
 * "Select…" placeholder as a real option, and home city and state accept an empty string, so
 * a user could satisfy three of the six facts G1 exists to collect by touching a control and
 * undoing it, then confirm a profile whose location and work authorization were still blank.
 * G1 only means something if it checks the value rather than the interaction.
 *
 * An optional wizard field is the exception: its blank is a real answer, so re-flagging one
 * left empty would trap a person who has nothing to put there.
 *
 * `raise: false` is the education editor, where re-flagging is the wrong half of the rule
 * rather than the whole rule being wrong. The six facts are flagged from the moment the
 * profile is built, so raising one back always restores a flag that was there. An education
 * field is not: most are never flagged at all, and coursework, a field of study and a
 * graduation date are all optional on the profile shape, so putting a flag on a school the
 * extractor was happy with because someone cleared a date they never had invents work at a
 * gate that blocks on its list being empty. The opposite must not happen, and does not: a
 * GPA flag the extractor DID raise stays raised until a real number is behind it, whatever
 * gets typed into the boxes in between.
 *
 * That is the whole of the rule for a field that is EMPTY on both sides of the edit. It said
 * nothing about a field going from full to empty, and that gap was a false red one keystroke
 * wide: a student who filled the GPA in, cleared the flag, and then typed "4.32 weighted"
 * into the box beside it lost the number with no flag to show for it. So a caller may pass
 * `raise` per edit, and the GPA boxes do exactly that on the keystroke that empties them —
 * see `editGpaBox`.
 */
export function nextReviewFlags(
  needsReview: string[],
  path: string,
  value: unknown,
  options?: { raise?: boolean },
): string[] {
  if (OPTIONAL_WIZARD_FIELDS.has(path) || isAnswered(value)) {
    return needsReview.filter((f) => f !== path);
  }
  return (options?.raise ?? true) ? [...new Set([...needsReview, path])] : needsReview;
}

export interface GpaBoxes {
  value: string;
  scale: string;
  weighted: string;
}

/**
 * A GPA box read as a number, or undefined when it holds nothing usable.
 *
 * `Number('')` is 0, so a check that skipped the blank test would store a GPA of zero for
 * every box the student left alone, and a zero on the profile is a number FactGuard is
 * happy to contradict a true sentence with. Blank has to mean absent.
 *
 * A figure above the scale is allowed through on purpose. 4.32 on a 4.0 scale is the
 * ordinary shape of an American high-school transcript, and rejecting it here would throw
 * away the exact number this editor was built to capture.
 *
 * Digits and a decimal point, and nothing else. `Number` understands more spellings than a
 * transcript does: "0x4" came back as 4 and "1e2" as 100, so a box the student can see
 * holding one thing was stored as another, silently and with the note that names an
 * unreadable box staying quiet. A half-typed "3." and a leading ".9" both still read, because
 * both are things a person types on the way to a real number.
 */
function readGpaNumber(text: string): number | undefined {
  const trimmed = text.trim();
  if (trimmed === '' || /[^0-9.]/.test(trimmed)) return undefined;
  const n = Number(trimmed);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * What the three GPA boxes on a school row add up to, and what to say when they add up to
 * nothing the profile can hold.
 *
 * A weighted-only transcript is the case this exists for. A high school that prints
 * "4.32 weighted GPA" and no unweighted figure had its number dropped during ingestion and
 * `education.0.gpa` raised for the user to fix, and then there was no control anywhere on
 * G1 to fix it with: the true sentence "I carry a 4.32 weighted GPA at Sample High School"
 * came back `unsupported`, which blocks at G3 with no override, and the only affordance on
 * the gate was a button that deleted the flag and left the number gone for good.
 *
 * Nothing here is inferred. A weighted figure is never copied into the unweighted slot to
 * complete the pair: that would put a number the student never earned onto the profile and
 * hand a fabricated unweighted GPA a green tick at the gate that is supposed to catch one.
 * Where the pair is still incomplete the note says so out loud instead.
 */
export function readGpaBoxes(boxes: GpaBoxes): {
  gpa: EducationEntry['gpa'];
  note: string | null;
} {
  const filled = GPA_PARTS.filter((part) => boxes[part].trim() !== '');
  const unreadable = filled.find((part) => readGpaNumber(boxes[part]) === undefined);
  if (unreadable !== undefined) {
    // Not "not being stored YET". A row that already held a GPA loses it on this keystroke —
    // one "4.32 weighted" typed into the weighted box took a correct 3.968/4 off the profile
    // and the note told the student nothing had gone. What re-raises the flag is
    // `editGpaBox`; this says the same thing in words.
    return {
      gpa: undefined,
      note:
        `${GPA_LABELS[unreadable]} reads "${boxes[unreadable].trim()}", which is not a number. ` +
        "Nothing in this row's GPA is stored while that is true, and any figure that was " +
        'already there has come off your profile with it.',
    };
  }

  const value = readGpaNumber(boxes.value);
  const scale = readGpaNumber(boxes.scale);
  const weighted = readGpaNumber(boxes.weighted);

  // A GPA of 0 is a fact; a GPA out of 0 is not. The same "any number at or above zero"
  // predicate reads both boxes, and a scale of 0 slipped through it onto the profile, where
  // the shared schema takes a plain number and the evidence line quoted "GPA 3.9/0" back to
  // the student at G3 as the proof that their own sentence was real.
  if (scale === 0) {
    return {
      gpa: undefined,
      note:
        `Scale reads "${boxes.scale.trim()}", and a GPA is out of something. Put the number ` +
        'your school grades out of there — usually 4, sometimes 5 or 100 — and this row ' +
        'stores again.',
    };
  }

  if (value !== undefined && scale !== undefined) {
    return {
      gpa: weighted === undefined ? { value, scale } : { value, scale, weighted },
      note: null,
    };
  }
  if (filled.length === 0) return { gpa: undefined, note: null };
  return {
    gpa: undefined,
    note:
      'A GPA is stored as an unweighted number together with its scale, so those two boxes ' +
      'both need a number before anything is kept. Your weighted figure is stored beside ' +
      'them once they are filled in.',
  };
}

/** Where one GPA box keeps the text the user typed into it. */
export function gpaBoxKey(index: number, part: GpaPart): string {
  return `education.${index}.gpa.${part}`;
}

/**
 * What the three boxes should show: what the user typed if they have typed, and otherwise
 * whatever the profile holds.
 *
 * Held as text rather than read straight off the profile because a box bound to a parsed
 * number cannot be typed into. "3." parses to 3, the box re-renders as "3", and the decimal
 * point that was just pressed is gone before the next digit lands.
 *
 * Touching any one box records all three, which is what stops a half-typed unweighted
 * figure from blanking a scale the profile already held: an incomplete pair stores no GPA
 * at all, and without this the scale box would fall back to a `gpa` that had just gone
 * undefined and empty itself while the user was mid-keystroke.
 */
export function gpaBoxesFor(
  entry: EducationEntry,
  index: number,
  typed: Record<string, string>,
): GpaBoxes {
  const stored: Record<GpaPart, number | undefined> = {
    value: entry.gpa?.value,
    scale: entry.gpa?.scale,
    weighted: entry.gpa?.weighted,
  };
  const read = (part: GpaPart): string => {
    const held = stored[part];
    return typed[gpaBoxKey(index, part)] ?? (held === undefined ? '' : String(held));
  };
  return { value: read('value'), scale: read('scale'), weighted: read('weighted') };
}

/**
 * Drops the blank rows every "Add" button can leave behind, on the way to the server.
 *
 * "Add" starts a row empty, and a row left empty would otherwise be stored. The education
 * evidence line joins these with commas, so three abandoned rows put ", , ," into the text
 * FactGuard quotes back to the user as proof that their own award is real. Surrounding
 * whitespace goes with them, because " National Honor Society" and "National Honor Society"
 * are one award and only one of the two matches what a draft says.
 *
 * Experience bullets get the same treatment for a sharper version of the same reason: a
 * blank bullet is an evidence item whose text is the empty string, which matches nothing and
 * dilutes the retrieval budget that decides which real bullets the drafting step gets to see.
 *
 * Addresses are repaired rather than dropped. `links` and a project's `url` are the profile's
 * two `z.string().url()` fields, people type "github.com/rosa", and ingestion already adds
 * the missing scheme on the way in — so a link typed here and a link read off the resume end
 * up stored the same way instead of one of them failing the save. Text that is not an address
 * at all is LEFT AS TYPED, because `savingProblems` names it and holds every button that
 * saves: silently deleting what someone just typed is the worse of the two.
 *
 * Every list is guarded rather than assumed. This runs on whatever the wizard is holding, and
 * a profile that reached it without one of these arrays would throw here — on the one code
 * path between the user's edits and the server.
 */
export function tidyProfileLists(profile: CandidateProfile): CandidateProfile {
  // An unparseable address keeps what was typed, so the notice can name it and the user can
  // see what they wrote; an empty one becomes absent rather than the empty string, which is
  // not a URL and would fail the very save this function exists to let through.
  const url = (raw: string | undefined): string | undefined => {
    const text = (raw ?? '').trim();
    if (text === '') return undefined;
    return readUrlField(text).url ?? text;
  };
  return {
    ...profile,
    education: (profile.education ?? []).map((e) => ({
      ...e,
      institution: e.institution.trim(),
      coursework: tidyList(e.coursework),
      honors: tidyList(e.honors),
    })),
    ...(profile.experience && {
      experience: profile.experience.map((e) => ({
        ...e,
        organization: e.organization.trim(),
        title: e.title.trim(),
        bullets: tidyList(e.bullets) ?? [],
        skills: tidyList(e.skills),
      })),
    }),
    ...(profile.projects && {
      projects: profile.projects.map((p) => ({
        ...p,
        name: p.name.trim(),
        description: p.description.trim(),
        url: url(p.url),
        bullets: tidyList(p.bullets) ?? [],
        skills: tidyList(p.skills),
      })),
    }),
    ...(profile.skills && {
      skills: profile.skills.map((s) => ({ ...s, name: s.name.trim() })),
    }),
    // Certifications and languages are TRIMMED here and never dropped, which is the
    // difference between tidying and deleting. The first version of this filtered out any
    // row whose name trimmed to empty, and that quietly destroyed data the user could not
    // get back: clear a certification's name meaning to retype it, press Continue — which
    // does not save — then Confirm, and the whole row went, issuer and date with it, with
    // no message and no flag. It also shifted every later row's index while its flags stayed
    // where they were, pointing the gate's amber at rows that had moved or gone.
    //
    // A blank name is named by `savingProblems` instead, the way every other required field
    // is, so an abandoned "Add" row is something the user clears with Remove rather than
    // something the save clears for them.
    ...(profile.certifications && {
      certifications: profile.certifications.map((c) => ({
        ...c,
        name: c.name.trim(),
        issuer: c.issuer?.trim(),
      })),
    }),
    ...(profile.languages && {
      languages: profile.languages.map((l) => ({
        name: l.name.trim(),
        proficiency: l.proficiency.trim(),
      })),
    }),
    ...(profile.links && {
      links: {
        ...profile.links,
        github: url(profile.links.github),
        linkedin: url(profile.links.linkedin),
        portfolio: url(profile.links.portfolio),
      },
    }),
    /**
     * The preference lists, tidied like every other free-text list on this screen.
     *
     * `preferences` was the one block this function spread past without naming, so the empty
     * string `ListEditor` appends on Add went to the server intact. A blank industry then made
     * `descriptionText.includes('')` true for every posting, scoring a perfect domain match on
     * the dimension that means the company does something the student cares about; a blank
     * excluded company would have matched every employer name the same way.
     */
    ...(profile.preferences && {
      preferences: {
        ...profile.preferences,
        // `?? []` because these three are required arrays on the schema (each carries a
        // `.default([])`), while `tidyList` preserves an undefined it was given — it is shared
        // with the optional lists on education and projects, where absent and empty differ.
        industries: tidyList(profile.preferences.industries) ?? [],
        excludeCompanies: tidyList(profile.preferences.excludeCompanies) ?? [],
        companySizes: tidyList(profile.preferences.companySizes) ?? [],
      },
    }),
  };
}

/**
 * School rows whose name has been emptied.
 *
 * `institution` is the one field on an education entry the profile schema insists on, so a
 * name deleted by hand made the next Save answer "Profile did not match the expected shape"
 * with nothing on screen saying which row meant it. Same accident the availability dates
 * below already carry a comment about, one level further into the profile.
 */
export function blankInstitutions(profile: CandidateProfile): number[] {
  return profile.education.flatMap((e, i) => (e.institution.trim() === '' ? [i] : []));
}

/**
 * Every reason the next save would come back as a shape error, in words, before it is tried.
 *
 * The server answers a breach of the profile schema with "Profile did not match the expected
 * shape" and names no field, so a single emptied box anywhere in these editors used to be a
 * wall with nothing on it. That was survivable while `institution` was the only required
 * field a user could reach; with editors for experience, projects and skills it is six more,
 * and each one is a box somebody can clear by holding backspace.
 *
 * The list is exhaustive by construction: it names every `.min(1)` string and every
 * `.url()` on CandidateProfile that this wizard renders a control for. A new required control
 * belongs here on the same day, or it reintroduces the wall.
 *
 * Numbering is 1-based because that is what the entry cards are labelled with on screen.
 */
export function savingProblems(profile: CandidateProfile): string[] {
  const out: string[] = [];
  const date = (label: string, value: string | undefined): void => {
    const problem = dateProblem(value);
    if (problem) out.push(`${label}: ${problem}.`);
  };

  const schools = blankInstitutions(profile);
  if (schools.length === 1) out.push(`School ${schools[0]! + 1} has no name.`);
  else if (schools.length > 1) {
    out.push(`Schools ${schools.map((i) => i + 1).join(', ')} have no name.`);
  }
  (profile.education ?? []).forEach((e, i) => {
    date(`School ${i + 1} started`, e.startDate);
    date(`School ${i + 1} finishes`, e.endDate);
  });

  (profile.experience ?? []).forEach((e, i) => {
    if (e.title.trim() === '') out.push(`Entry ${i + 1} has no title.`);
    if (e.organization.trim() === '') out.push(`Entry ${i + 1} has no organization.`);
    date(`Entry ${i + 1} started`, e.startDate);
    date(`Entry ${i + 1} finished`, e.endDate);
  });

  (profile.projects ?? []).forEach((p, i) => {
    if (p.name.trim() === '') out.push(`Project ${i + 1} has no name.`);
    const { problem } = readUrlField(p.url);
    if (problem) out.push(`Project ${i + 1}: ${problem}.`);
    date(`Project ${i + 1} started`, p.startDate);
    date(`Project ${i + 1} finished`, p.endDate);
  });

  (profile.skills ?? []).forEach((s, i) => {
    if (s.name.trim() === '') out.push(`Skill ${i + 1} has no name.`);
  });

  // Blank names, so the save no longer deletes the row on the user's behalf. See
  // `tidyProfileLists`: it used to drop these, taking the issuer and the date with them.
  (profile.certifications ?? []).forEach((c, i) => {
    if (c.name.trim() === '') out.push(`Certification ${i + 1} has no name.`);
    date(`Certification ${i + 1} earned`, c.date);
  });

  (profile.languages ?? []).forEach((l, i) => {
    if (l.name.trim() === '') out.push(`Language ${i + 1} has no name.`);
  });

  // The schema takes an address or the empty string and nothing in between, and this box has
  // always stored raw text. A scraped address "fixed" to "rosa.dean (at) gmail.com" was the
  // same unnamed wall as the dates: every save button live, and a shape error naming no field.
  //
  // Asked of the shared schema rather than of a regex written here. This was a hand-rolled
  // pattern described as "the loose shape the schema takes", and it was looser:
  // `rosa..dean@gmail.com`, `rosa@gmail.c` and `#rosa@x.io` all passed it and failed Zod, which
  // is precisely the wall this whole function exists to remove.
  if (profile.email !== undefined && !isEmailShaped(profile.email)) {
    out.push(`"${profile.email}" is not an email address.`);
  }

  for (const key of ['github', 'linkedin', 'portfolio'] as const) {
    const { problem } = readUrlField(profile.links?.[key]);
    if (problem) out.push(`Your ${key} link: ${problem}.`);
  }

  return out;
}

/**
 * The withdrawals from two writes in a row, listed once each.
 *
 * "I have checked this" saves and then clears a flag, which is two writes, and each answers
 * with its own sweep. An answer can only lose its approval once, so a name appearing in both
 * lists would be the same withdrawal counted twice — and "2 answers lost their approval"
 * when one did is the app being wrong about the thing it is apologising for.
 */
export function mergeWithdrawn(
  first: api.WithdrawnApproval[],
  second: api.WithdrawnApproval[],
): api.WithdrawnApproval[] {
  const seen = new Set(first.map((w) => w.answerId));
  return [...first, ...second.filter((w) => !seen.has(w.answerId))];
}

export function Onboarding({
  onDone,
  onBusy,
  onFindPostings,
}: {
  onDone: () => void;
  onBusy?: (what: string | null) => void;
  /** Absent in tests and in any host with no Discover screen; the button hides itself. */
  onFindPostings?: () => void;
}) {
  const [step, setStep] = useState<Step>('upload');
  const [profile, setProfile] = useState<CandidateProfile | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * The raw text sitting in the GPA boxes, keyed by `gpaBoxKey`.
   *
   * Beside the profile rather than in it, because the profile stores GPAs as numbers and a
   * number cannot be typed one character at a time. See `gpaBoxesFor`.
   */
  const [typed, setTyped] = useState<Record<string, string>>({});
  /**
   * What the last save cost at G3, if it cost anything.
   *
   * Set from the save response on every path that writes, and reset by the same assignment
   * when a save costs nothing, so this never describes a write two writes ago.
   */
  const [withdrawn, setWithdrawn] = useState<api.WithdrawnApproval[]>([]);

  // The nav lives above this screen. Reading a resume takes a model call and the better part
  // of a minute, and unmounting mid-read loses the extraction with no way to know it happened.
  // See the comment on `Nav`.
  useEffect(() => onBusy?.(busy), [busy, onBusy]);

  /**
   * Picks up the profile that already exists, if there is one.
   *
   * Without this, "Revisit profile" dropped a confirmed user back on the dropzone with no
   * way past it except uploading their resume a second time — so correcting a home city
   * meant re-extracting the whole document.
   */
  useEffect(() => {
    let cancelled = false;
    api
      .getProfile()
      .then((p) => {
        if (cancelled || !p) return;
        // Never overtakes an upload that is already running: whatever the extractor
        // produces is newer than what was on disk when this request went out.
        setStep((s) => (s === 'upload' ? 'confirm' : s));
        setProfile((prev) => prev ?? p);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const flagged = useCallback(
    (path: string) => profile?.needsReview.includes(path) ?? false,
    [profile],
  );

  /** Reads a dotted path out of the profile, so `clears` can check its own field. */
  function at(obj: unknown, path: string): unknown {
    return path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], obj);
  }

  const patch = useCallback(
    (
      fn: (p: CandidateProfile) => CandidateProfile,
      clears?: string,
      options?: { raise?: boolean },
    ) => {
      setProfile((prev) => {
        if (!prev) return prev;
        const next = fn(prev);
        if (!clears) return next;

        // The rule itself is `nextReviewFlags`, at the top of this file, so that the gate's
        // one contract is a function the tests can hold rather than an expression inside a
        // state updater no test can reach.
        return {
          ...next,
          needsReview: nextReviewFlags(next.needsReview, clears, at(next, clears), options),
        };
      });
    },
    [],
  );

  /**
   * Replaces one school row, naming the flag the edit answers.
   *
   * `raise: false` by default, for the reason `nextReviewFlags` gives. A row may override it
   * per edit: the GPA boxes do, on the one keystroke that takes a number the profile already
   * held back off it. See `editGpaBox`.
   */
  /**
   * A change that moved entries around, with this list's review flags moved to match.
   *
   * Flags are positional — `experience.3.startDate` — and nothing could move an entry until
   * the editors added Up, Down and Remove. Without this, one Remove made the gate's amber
   * markers point at the wrong rows, and removing the last flagged entry left a flag
   * addressing a row that no longer exists: invisible on screen, and still counted by the
   * gate that blocks until the list is empty.
   */
  const editList = useCallback(
    (
      prefix: string,
      fn: (p: CandidateProfile) => CandidateProfile,
      moved?: number[],
      clears?: string,
    ) => {
      setProfile((prev) => {
        if (!prev) return prev;
        const next = fn(prev);
        const remapped = moved ? remapListFlags(next.needsReview, prefix, moved) : next.needsReview;
        // The clearing rule has to run on THIS path too, and it did not. `replaceAll` in the
        // skills editor sends a removal down here and every other edit down `patch`, so the
        // `skills` corpus flag — raised when an extraction came back with no skills at all —
        // was cleared by "Add skill" (a one-row list is answered) and then never re-raised by
        // "Remove skill", which is the obvious way out once `savingProblems` blocks the blank
        // name. Net change nothing, flag gone, Confirm unlocked: the identical touch-and-undo
        // hole `isAnswered([])` was widened to close, one code path over.
        const needsReview = clears ? nextReviewFlags(remapped, clears, at(next, clears)) : remapped;
        return { ...next, needsReview };
      });
    },
    [],
  );

  const editEducation = useCallback(
    (index: number, next: EducationEntry, clears?: string, options?: { raise?: boolean }) => {
      patch(
        (p) => ({ ...p, education: p.education.map((e, i) => (i === index ? next : e)) }),
        clears,
        { raise: false, ...options },
      );
    },
    [patch],
  );

  /**
   * Saves, and says whether it worked.
   *
   * The boolean is what lets Continue save on the way past. It catches its own error and
   * resolves either way — a caller chaining `.then(() => setStep('facts'))` would advance
   * straight past a server rejection, which is the opposite of the guarantee the button now
   * makes — so the outcome has to come back as a value rather than as a rejection.
   */
  async function persist(): Promise<boolean> {
    if (!profile) return false;
    setBusy('Saving…');
    setError(null);
    try {
      const saved = await api.saveProfile(tidyProfileLists(profile));
      setProfile(saved.profile);
      setWithdrawn(saved.withdrawnApprovals);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(null);
    }
  }

  /**
   * Marks one flag reviewed without throwing away what is typed on this step.
   *
   * The endpoint answers with the profile as it stands ON DISK, and this screen replaces
   * its whole state with that answer. So clearing a flag straight from the wizard blanked
   * every date, city and selection entered since the last Save, brought back the flags
   * those answers had already cleared, pushed the "still flagged" count back up, and said
   * nothing at all about why. Saving first makes the profile that comes back the one the
   * user is looking at.
   */
  async function checkedOff(path: string) {
    if (!profile) return;
    setBusy('Saving…');
    setError(null);
    try {
      const saved = await api.saveProfile(tidyProfileLists(profile));
      const cleared = await api.clearReviewFlag(path);
      setProfile(cleared.profile);
      // Both calls write, so both sweep. The second one finds nothing the first already took
      // — an answer only loses its approval once — but merging is what keeps that a fact
      // about the server rather than an assumption made here.
      setWithdrawn(mergeWithdrawn(saved.withdrawnApprovals, cleared.withdrawnApprovals));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function confirm() {
    setBusy('Confirming…');
    setError(null);
    try {
      const saved = await api.saveProfile(tidyProfileLists(profile!));
      setWithdrawn(saved.withdrawnApprovals);
      await api.confirmProfile();
      setStep('done');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  const remaining = profile?.needsReview.length ?? 0;

  /**
   * Every emptied box the profile schema will not take, named, with every button that saves
   * held until they are gone. The server answers a breach with a shape error naming no field,
   * and saying which one is cheaper than a wall nobody can read.
   *
   * Shown on both steps because Confirm saves too, and a Confirm greyed out with the reason
   * on the previous screen is the same wall with an extra click in front of it.
   *
   * Four buttons save, not three: Save, Continue, Confirm, and "I have checked this" beside a
   * flag on the facts step — which saves the profile first so that the flag it clears is not
   * clearing it on stale facts. That fourth one was left off this hold once, and it is
   * reachable in precisely the state the hold is for (a flag still open is why the button is
   * rendered at all), so clicking it put the shape error back on screen under the notice that
   * exists to replace it. Any new button that calls the server with this profile belongs here.
   *
   * This used to be schools alone, which was the whole list while `institution` was the only
   * required field a user could reach. The experience, project and skill editors made it six
   * more. `savingProblems` is the list, and it is a function so a test can hold it.
   */
  const nameless = profile ? savingProblems(profile) : [];
  const namelessNotice = nameless.length > 0 && (
    <Notice tone="caution">
      <strong>This cannot be saved yet.</strong>
      <ul className="mt-2 space-y-1">
        {nameless.map((problem) => (
          <li key={problem} className="u-prose">
            {problem}
          </li>
        ))}
      </ul>
      <p className="mt-2">
        Each of those is a box the file has to have something in. Type it back, or put a dash there
        if you would rather not say — and remove the row outright if it should not be there at all.
      </p>
    </Notice>
  );

  return (
    <Page>
      <RunningHead
        section="Establish the file"
        gate="G1"
        lede="Your resume is read once and turned into a structured profile. Everything the reader
              was unsure about is flagged, and nothing downstream runs until you have corrected it
              yourself."
      />

      {error && <Notice tone="redline">{error}</Notice>}
      {/* Above the step, not inside one, so that the withdrawal a Confirm caused is still on
          screen on the step Confirm moves to. */}
      <WithdrawnNotice items={withdrawn} />
      {busy && <p className="u-data text-accent mb-6">{busy}</p>}

      {step === 'upload' && (
        <UploadStep
          onExtracted={(p, withdrawn) => {
            setProfile(p);
            // What this read cost, said on the screen that cost it. Re-extraction replaces
            // every fact at once, so it withdraws more approvals than any other write —
            // and this was the one write path that read the list off the wire and dropped
            // it. Assigned rather than merged: a new resume is a new profile, and a notice
            // left over from an earlier save would be describing a profile that is gone.
            setWithdrawn(withdrawn);
            // Whatever was typed into the old profile's GPA boxes belongs to the old
            // profile. Left in place, a second resume would show the first one's numbers
            // beside a school it never mentioned.
            setTyped({});
            setStep('confirm');
          }}
          onError={setError}
          setBusy={setBusy}
          busy={busy}
        />
      )}

      {step === 'confirm' && profile && (
        <>
          <Section n="02" title="What the reader found" step={3}>
            <div className="divide-rule/60 divide-y">
              <TextField
                label="Full name"
                value={profile.fullName}
                flagged={flagged('fullName')}
                onChange={(e) => patch((p) => ({ ...p, fullName: e.target.value }), 'fullName')}
              />
              <TextField
                label="Pronouns"
                hint="Kept for your own reference. Never typed into a form — a pronoun question on an application is yours to answer."
                value={profile.pronouns ?? ''}
                flagged={flagged('pronouns')}
                onChange={(e) =>
                  patch((p) => ({ ...p, pronouns: e.target.value || null }), 'pronouns')
                }
              />
              <TextField
                label="Email"
                type="email"
                value={profile.email}
                flagged={flagged('email')}
                onChange={(e) => patch((p) => ({ ...p, email: e.target.value }), 'email')}
              />
              <TextField
                label="Phone"
                value={profile.phone ?? ''}
                // The three fields around this one all pass their flag; this did not, so a
                // `phone` flag sent the student to "the previous step" and then gave them
                // nothing to look for once they were on it.
                flagged={flagged('phone')}
                onChange={(e) => patch((p) => ({ ...p, phone: e.target.value }), 'phone')}
              />
            </div>

            {/* The lines under each entry are counted beside the entries, because the
                count on its own hid the failure this block exists to show. A real resume
                came back as "Experience — 27 entries · Projects — none found · Skills —
                none found", and every one of those twenty-seven entries was a bare title
                with nothing under it: the reader had dropped the description of everything
                the person had actually done, and the screen reported it as a healthy
                number. What is stored is what a generated sentence gets checked against
                later, so an entry count is the wrong measure of it on its own. */}
            <dl className="mt-8 space-y-1">
              <Summary
                label="Experience"
                n={profile.experience.length}
                extra={lineLabel(profile.experience.reduce((t, e) => t + e.bullets.length, 0))}
              />
              <Summary
                label="Projects"
                n={profile.projects.length}
                extra={lineLabel(profile.projects.reduce((t, p) => t + p.bullets.length, 0))}
              />
              <Summary label="Skills" n={profile.skills.length} />
            </dl>

            {/* The threshold is `lostTheEvidence`, in @ia/shared, and it is not "every entry
                is bare": the resume this was written for had twenty-seven entries carrying
                ONE line between them, and an exact-zero test called that fine. The server
                raises `experience.bullets` from the same function, so the flag and this
                paragraph cannot disagree about one profile. */}
            {lostTheEvidence(profile.experience) && (
              <Notice tone="caution">
                {bulletlessExperience(profile.experience)} of those {profile.experience.length}{' '}
                entries kept none of the lines printed under them on your resume. The titles,
                organizations and dates are here and can be checked; what you did is not. Sentences
                about the work itself have nothing behind them, and gate G3 refuses a sentence it
                cannot trace to a fact — with no override. Uploading the file again reads it afresh;
                below, you can also put the lines back by hand.
              </Notice>
            )}

            <p className="text-faint mt-4 text-sm italic">
              Everything the reader took off your resume is below, and all of it can be corrected,
              reordered, added to and thrown out. What is stored here is the whole of what the rest
              of this app knows about you.
            </p>

            <EducationEditor
              entries={profile.education}
              flagged={flagged}
              typed={typed}
              onEntry={editEducation}
              onTyped={(boxes) => setTyped((prev) => ({ ...prev, ...boxes }))}
              onList={(next, moved) => {
                editList('education', (prev) => ({ ...prev, education: next }), moved);
                // The typed GPA text moves with its row too. `editList` remaps needsReview and
                // knows nothing about these boxes, so a half-typed figure for the second
                // school reappeared on the third — over whatever GPA that school really had.
                if (moved) setTyped((prev) => remapTypedBoxes(prev, 'education', moved));
              }}
            />

            {/* `patch` unchanged from the identity fields above, so an edit in here clears the
                flag it answers by the same rule. The entry editors pass no `clears` for a
                field nobody flagged, which keeps `nextReviewFlags` from inventing work at a
                gate that blocks on its list being empty. */}
            <ExperienceEditor
              profile={profile}
              flagged={flagged}
              edit={patch}
              editList={editList}
            />
            <ProjectsEditor profile={profile} flagged={flagged} edit={patch} editList={editList} />
            <SkillsEditor profile={profile} flagged={flagged} edit={patch} editList={editList} />
            <CertificationsEditor
              profile={profile}
              flagged={flagged}
              edit={patch}
              editList={editList}
            />
            <LanguagesEditor profile={profile} flagged={flagged} edit={patch} editList={editList} />
            <LinksEditor profile={profile} flagged={flagged} edit={patch} editList={editList} />

            <PreferencesEditor
              preferences={profile.preferences}
              onChange={(next) =>
                patch((p) => ({ ...p, preferences: { ...p.preferences, ...next } }))
              }
            />
          </Section>

          {namelessNotice}

          <div className="flex flex-wrap gap-3">
            <Button disabled={busy !== null || nameless.length > 0} onClick={() => void persist()}>
              Save
            </Button>
            {/* Saves on the way past, and only advances if the save took.
                Continue used to move the step and nothing else, so an edit made here and
                followed by Continue lived in React state alone: the nav bar blocks only on
                `busy`, and leaving through it unmounts this component, so a corrected school
                name or a chosen role family was gone with nothing on screen having said so. */}
            <Button
              variant="primary"
              disabled={busy !== null || nameless.length > 0}
              onClick={() => {
                void persist().then((ok) => {
                  if (ok) setStep('facts');
                });
              }}
            >
              Save and continue
            </Button>
            {/* The way back to the dropzone. This screen is where anyone who already has a
                profile now lands, so without it a new resume could never be uploaded a
                second time. */}
            <Button disabled={busy !== null} onClick={() => setStep('upload')}>
              Upload a different resume
            </Button>
          </div>
        </>
      )}

      {step === 'facts' && profile && (
        <>
          <Section n="03" title="What a resume never says" step={3}>
            {/* Only the date of birth on this step is encrypted. The other five facts go
                into the database as plain JSON, exactly as docs/03 marks them. Saying all
                six were encrypted put the strongest promise this app makes directly above
                the immigration-status select, which is the one control a person is most
                likely to hesitate over — and it was the promise persuading them to
                answer. If the encrypted set ever widens, this sentence widens with it. */}
            <p className="text-dim mb-6 u-prose text-base">
              Eligibility turns on these six facts, and none of them appear on a resume. All six are
              stored in the database file on this machine. Your date of birth is encrypted there,
              the way your contact details are. The other five sit in that file as plain text.
            </p>

            <div className="divide-rule/60 divide-y">
              <TextField
                label="Date of birth"
                type="date"
                hint="Many postings require 18+. Used only for local filtering, never auto-filled into a form."
                value={profile.dateOfBirth ?? ''}
                flagged={flagged('dateOfBirth')}
                onChange={(e) =>
                  patch((p) => ({ ...p, dateOfBirth: e.target.value || null }), 'dateOfBirth')
                }
              />

              <SelectField
                label="Work authorization"
                hint="Drives the sponsorship and citizenship rules."
                value={profile.workAuthorization.status}
                flagged={flagged('workAuthorization.status')}
                onChange={(e) =>
                  patch(
                    (p) => ({
                      ...p,
                      workAuthorization: {
                        ...p.workAuthorization,
                        status: e.target.value as CandidateProfile['workAuthorization']['status'],
                        needsSponsorship: e.target.value === 'requires_sponsorship',
                      },
                    }),
                    'workAuthorization.status',
                  )
                }
              >
                <option value="unknown">Select…</option>
                <option value="citizen">US citizen</option>
                <option value="permanent_resident">Permanent resident</option>
                <option value="student_visa">Student visa (F-1/J-1)</option>
                <option value="work_visa">Work visa</option>
                <option value="requires_sponsorship">Will need sponsorship</option>
                <option value="other">Other</option>
              </SelectField>

              {/* Clearing a date has to read as absent, not as an empty string. The profile
                  schema wants YYYY-MM-DD or nothing at all, so a date box emptied by hand
                  made the next Save — and Confirm, which saves first — come back with
                  "Profile did not match the expected shape" and no clue which field meant
                  it. Same treatment the date of birth above already gets. */}
              <TextField
                label="Available from"
                type="date"
                hint="A posting's term must overlap this window by at least six weeks."
                value={profile.availability.start ?? ''}
                flagged={flagged('availability.start')}
                onChange={(e) =>
                  patch(
                    (p) => ({
                      ...p,
                      availability: { ...p.availability, start: e.target.value || undefined },
                    }),
                    'availability.start',
                  )
                }
              />
              <TextField
                label="Available until"
                type="date"
                value={profile.availability.end ?? ''}
                flagged={flagged('availability.end')}
                onChange={(e) =>
                  patch(
                    (p) => ({
                      ...p,
                      availability: { ...p.availability, end: e.target.value || undefined },
                    }),
                    'availability.end',
                  )
                }
              />
              <TextField
                label="Home city"
                hint="Your address, and the first place searched. Add others below."
                value={profile.locationPrefs.base.city}
                flagged={flagged('locationPrefs.base.city')}
                onChange={(e) =>
                  patch(
                    (p) => ({
                      ...p,
                      locationPrefs: {
                        ...p.locationPrefs,
                        base: { ...p.locationPrefs.base, city: e.target.value },
                      },
                    }),
                    'locationPrefs.base.city',
                  )
                }
              />
              <TextField
                label="State"
                value={profile.locationPrefs.base.region}
                flagged={flagged('locationPrefs.base.region')}
                onChange={(e) =>
                  patch(
                    (p) => ({
                      ...p,
                      locationPrefs: {
                        ...p.locationPrefs,
                        base: { ...p.locationPrefs.base, region: e.target.value },
                      },
                    }),
                    'locationPrefs.base.region',
                  )
                }
              />
            </div>

            <WorkLocationsEditor
              locations={profile.locationPrefs.additionalBases}
              onChange={(next) =>
                patch((p) => ({
                  ...p,
                  locationPrefs: { ...p.locationPrefs, additionalBases: next },
                }))
              }
            />
          </Section>

          <Section n="04" title="Sign off" step={4}>
            {remaining > 0 ? (
              <Notice tone="caution">
                {remaining} field{remaining === 1 ? '' : 's'} still flagged. Confirmation is blocked
                until each one has been looked at. That is the whole point of this gate.
                {/* Every flag needs a way off this list. The extractor can flag a field
                    this wizard has no input for — anything nested in education or
                    experience — and without a control those flags could never be cleared,
                    which locked G1 shut with no way forward. Anything the wizard CAN
                    answer gets pointed at its control instead.

                    Which of the two a flag gets is `isDismissible` and nothing else. This
                    row used to decide it here with `ANSWERED_IN_WIZARD[f] ? …`, so the
                    rule the tests hold to and the rule that shipped were two separate
                    expressions that only happened to agree — and they would stop agreeing
                    the day a hint was written as an empty string, which is falsy here and
                    still a real entry to `isDismissible`. That day the button appears
                    beside a field with a control, and one click marks a fact reviewed
                    while it is still blank. */}
                <ul className="mt-3 space-y-1.5">
                  {profile.needsReview.slice(0, 12).map((f) => (
                    <li key={f} className="flex flex-wrap items-center justify-between gap-3">
                      {/* The field named the way the student would name it. This printed the
                          dotted path — education.0.gpa — which for every flag outside the nine
                          with a hint beside them was an internal identifier and a button, with
                          nothing to say which box on which row it meant. */}
                      <span>{flagLabel(f)}</span>
                      {isDismissible(f) ? (
                        <Button
                          size="sm"
                          disabled={busy !== null || nameless.length > 0}
                          onClick={() => void checkedOff(f)}
                        >
                          I have checked this
                        </Button>
                      ) : (
                        <span className="text-faint text-sm">{ANSWERED_IN_WIZARD[f]}</span>
                      )}
                    </li>
                  ))}
                </ul>
                {profile.needsReview.length > 12 && (
                  <p className="text-faint mt-2 text-sm">
                    and {profile.needsReview.length - 12} more
                  </p>
                )}
              </Notice>
            ) : (
              <Notice tone="verified">
                Nothing left flagged. Confirming unlocks matching and the queue.
              </Notice>
            )}

            {namelessNotice}

            {/* This step collects the six facts a resume never contains — date of birth,
                work authorization, both availability dates, home city and state — plus every
                additional work location. Until now its only two controls were Back, which
                changed the step and saved nothing, and Confirm, which is disabled while any
                flag is still open: precisely the state a person is in WHILE they are filling
                this in. So everything typed here lived in React state alone, and leaving
                through the nav — which blocks only on `busy` — unmounted the screen and took
                it. The confirm step already had this fixed; this one did not. */}
            <div className="mt-4 flex flex-wrap gap-3">
              <Button
                disabled={busy !== null || nameless.length > 0}
                onClick={() => {
                  void persist().then((ok) => {
                    if (ok) setStep('confirm');
                  });
                }}
              >
                Save and go back
              </Button>
              <Button
                disabled={busy !== null || nameless.length > 0}
                onClick={() => void persist()}
              >
                Save
              </Button>
              <Button
                variant="primary"
                disabled={remaining > 0 || nameless.length > 0}
                onClick={() => void confirm()}
              >
                Confirm profile
              </Button>
            </div>
          </Section>
        </>
      )}

      {step === 'done' && (
        <Section n="05" title="Confirmed" step={3}>
          <div className="u-tint-verified rounded px-5 py-6">
            <p className="a-stamp u-data text-verified mb-3 text-lg tracking-widest uppercase">
              profile established
            </p>
            {/* This once read "matching and the queue", deliberately, because there was no
              discovery screen to unlock and someone who read otherwise went looking for
              one. There is now, and confirming is what lifts the 409 the discovery routes
              answer an unconfirmed profile with, so the qualifier had become the wrong
              half of the sentence. */}
            <p className="text-dim">Searching is unlocked, and so is everything after it.</p>
          </div>
          {/* This screen leaves, rather than being left. Confirming used to navigate for
              the user, which meant the stamp above was rendered and unmounted in the same
              breath and nobody ever saw it.

              Discover leads, because the queue of a brand-new user is empty by construction:
              nothing has been searched yet. Sending them to G2 first showed them an empty
              state as the reward for finishing G1. */}
          <div className="mt-5 flex flex-wrap gap-3">
            {onFindPostings && (
              <Button variant="primary" onClick={onFindPostings}>
                Find postings
              </Button>
            )}
            <Button variant={onFindPostings ? undefined : 'primary'} onClick={onDone}>
              Open the queue (G2)
            </Button>
          </div>
        </Section>
      )}
    </Page>
  );
}

function UploadStep({
  onExtracted,
  onError,
  setBusy,
  busy,
}: {
  onExtracted: (p: CandidateProfile, withdrawn: api.WithdrawnApproval[]) => void;
  onError: (m: string) => void;
  setBusy: (m: string | null) => void;
  busy: string | null;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [filename, setFilename] = useState<string | null>(null);

  async function handle(file: File) {
    // One at a time. The dropzone stayed clickable during extraction, so two runs could
    // overlap: the first to settle cleared the "Reading it…" indicator while the second
    // was still going, and whichever finished last silently won.
    if (busy !== null) return;
    setFilename(file.name);
    onError('');
    try {
      setBusy('Storing the document…');
      const { documentId } = await api.uploadResume(file);
      setBusy('Reading it. This takes a few seconds…');
      const read = await api.extractResume(documentId);
      onExtracted(read.profile, read.withdrawnApprovals);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  /**
   * The same handover as `handle`, without the file or the model.
   *
   * Shares the one-at-a-time guard and the busy indicator, because it is the same screen
   * leaving for the same next step; the only difference is how much of the profile is filled
   * in when it gets there.
   */
  async function byHand() {
    if (busy !== null) return;
    onError('');
    try {
      setBusy('Setting up an empty profile…');
      const started = await api.blankProfile();
      onExtracted(started.profile, started.withdrawnApprovals);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Section n="01" title="Your resume" step={3}>
      <button
        disabled={busy !== null}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const f = e.dataTransfer.files[0];
          if (f) void handle(f);
        }}
        className="border-rule hover:border-accent w-full border border-dashed px-6 py-14 text-center transition-colors disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span className="u-data text-dim block">
          {filename ?? 'drop a file, or click to choose'}
        </span>
        <span className="text-faint mt-2 block text-sm">PDF, DOCX, TXT, or Markdown</span>
      </button>
      <input
        ref={inputRef}
        type="file"
        accept=".pdf,.docx,.txt,.md"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void handle(f);
        }}
      />
      {/* "The file stays on this machine" sat one sentence after "read directly by the
          model", and the two cannot both be true: a PDF is base64-encoded whole and sent
          to the model to be read. This is the first thing a new user does, under the
          strongest privacy promise on the screen, so it says what really happens instead.
          The other formats are named too: they send their extracted text, which is the
          same promise being broken more quietly. */}
      <p className="text-faint mt-5 u-prose text-sm">
        PDFs are sent to the model and read there rather than through a text-extraction library,
        because that copes with scans and multi-column layouts far better. A DOCX or a text file has
        its extracted text sent instead. <em>The copy that is kept lives on this machine.</em>
      </p>

      {/* The way past this screen for anyone the dropzone cannot serve.

          Reading a resume is the one step here that needs a model, and without one this screen
          was the end of the application: the upload failed with an error telling the user that
          "profile fields must be entered by hand" — which is what GET /api/model-access has
          always said — while offering nowhere to enter them. Everything downstream is gated on
          G1, so a missing model did not reduce the tool, it stopped it.

          Deliberately quiet, and deliberately not hidden behind a model-access check. It is
          the slower road for everyone, so it should not compete with the dropzone; but a user
          whose CLI is signed out, or whose extraction keeps failing, or who would simply
          rather not send the file, all need the same door and none of them shows up in a
          capability probe. */}
      <p className="text-faint mt-6 text-sm">
        No model on this machine, or would rather not send the file?{' '}
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void byHand()}
          className="text-accent underline underline-offset-4 disabled:opacity-50"
        >
          Fill the profile in yourself
        </button>
        . Every box starts empty and flagged, and G1 still has to be passed the same way.
      </p>
    </Section>
  );
}

/**
 * The G1 control for everything the reader read out of the education section.
 *
 * G1 is the gate where an extraction error is corrected, and until this existed there was no
 * input for any nested education field anywhere in the app: the screen showed a count
 * ("Education: 2") and a note saying entries were not editable yet. Every flag the extractor
 * raised in here — an unreadable start or end date, a level it could only call "other", and
 * a GPA the profile shape could not hold — had exactly one way off the list, the button that
 * deletes the flag, which left the fact itself missing for good. For the GPA that ended in a
 * true sentence blocked at G3 with no override.
 */
export function EducationEditor({
  entries,
  flagged,
  typed,
  onEntry,
  onTyped,
  onList,
}: {
  entries: EducationEntry[];
  flagged: (path: string) => boolean;
  typed: Record<string, string>;
  onEntry: (
    index: number,
    next: EducationEntry,
    clears?: string,
    options?: { raise?: boolean },
  ) => void;
  onTyped: (boxes: Record<string, string>) => void;
  /**
   * Adding, removing and reordering the list itself.
   *
   * `moved` is `oldIndexForNew`, the permutation `remapListFlags` needs: every flag on this
   * list is addressed positionally (`education.1.gpa`), so a row removed from the middle
   * would otherwise leave each flag below it pointing at its neighbour — the GPA warning for
   * the second school landing on the third.
   */
  onList: (next: EducationEntry[], moved?: number[]) => void;
}) {
  /** A fresh school, in the shape the schema demands of a new row. */
  const blank = (): EducationEntry => ({
    institution: '',
    level: 'bachelor',
  });

  const move = (index: number, delta: number): void => {
    const to = index + delta;
    if (to < 0 || to >= entries.length) return;
    const next = [...entries];
    // Both indices are in range — the guard above returns otherwise — but the compiler reads
    // an indexed access as possibly undefined, and a bare swap would widen the array type.
    [next[index], next[to]] = [next[to]!, next[index]!];
    const moved = entries.map((_, i) => (i === index ? to : i === to ? index : i));
    onList(next, moved);
  };

  const remove = (index: number): void => {
    onList(
      entries.filter((_, i) => i !== index),
      entries.map((_, i) => i).filter((i) => i !== index),
    );
  };
  return (
    <div className="mt-10">
      <div className="mb-3 flex items-baseline justify-between gap-4">
        <h3 className="u-eyebrow">Education</h3>
        <span className="u-data text-faint">
          {entries.length === 0
            ? 'none found'
            : `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`}
        </span>
      </div>

      {entries.length === 0 ? (
        <p className="text-faint u-prose text-sm">
          No school was read off your resume. Add one here, or upload a different file.
        </p>
      ) : (
        /* Never sliced or capped. A resume can carry three schools and a school can carry
           twenty-six honors, and a list that quietly stops at some round number is an
           extraction error the user cannot see, let alone correct. */
        <ul className="space-y-6">
          {entries.map((entry, index) => (
            <li key={index} className="u-card-flat px-5 py-4">
              {/* The controls every other list on this screen already had, and education
                  did not — so a school the extractor invented could not be deleted and one
                  it missed could not be added. The blocking notice tells the user to "remove
                  the row outright if it should not be there at all", which was impossible
                  here, and the empty state's only offered action was uploading a different
                  file: a resume whose education section was misread had no correction at all.
                  ProfileEditors states the rule this broke — anything the wizard cannot edit
                  is an extraction error made permanent. */}
              <div className="mb-3 flex items-center justify-between gap-3">
                <span className="u-data text-faint text-2xs tracking-widest uppercase">
                  School {index + 1}
                </span>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Button
                    size="sm"
                    disabled={index === 0}
                    aria-label={`Move school ${String(index + 1)} up`}
                    onClick={() => move(index, -1)}
                  >
                    <ChevronUp aria-hidden size={14} />
                  </Button>
                  <Button
                    size="sm"
                    disabled={index === entries.length - 1}
                    aria-label={`Move school ${String(index + 1)} down`}
                    onClick={() => move(index, 1)}
                  >
                    <ChevronDown aria-hidden size={14} />
                  </Button>
                  <Button
                    size="sm"
                    aria-label={`Remove school ${String(index + 1)}`}
                    onClick={() => remove(index)}
                  >
                    Remove
                  </Button>
                </div>
              </div>
              <EducationRow
                entry={entry}
                index={index}
                flagged={flagged}
                typed={typed}
                onEntry={onEntry}
                onTyped={onTyped}
              />
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4">
        <Button size="sm" onClick={() => onList([...entries, blank()])}>
          <Plus aria-hidden size={14} />
          Add a school
        </Button>
      </div>
    </div>
  );
}

function EducationRow({
  entry,
  index,
  flagged,
  typed,
  onEntry,
  onTyped,
}: {
  entry: EducationEntry;
  index: number;
  flagged: (path: string) => boolean;
  typed: Record<string, string>;
  onEntry: (
    index: number,
    next: EducationEntry,
    clears?: string,
    options?: { raise?: boolean },
  ) => void;
  onTyped: (boxes: Record<string, string>) => void;
}) {
  const path = (field: string) => `education.${index}.${field}`;
  const boxes = gpaBoxesFor(entry, index, typed);
  const { note } = readGpaBoxes(boxes);
  const gpaFlagged = flagged(path('gpa'));

  /**
   * Every box records all three, so an incomplete pair cannot blank a number the profile
   * already held while the user is still typing the one beside it.
   */
  const editGpaBox = (part: GpaPart, text: string) => {
    const next: GpaBoxes = { ...boxes, [part]: text };
    onTyped({
      [gpaBoxKey(index, 'value')]: next.value,
      [gpaBoxKey(index, 'scale')]: next.scale,
      [gpaBoxKey(index, 'weighted')]: next.weighted,
    });
    const { gpa } = readGpaBoxes(next);
    // The keystroke that takes a stored GPA back off the profile raises the flag again, and
    // it is the only edit in this editor that raises anything. A profile arriving with a
    // correct 3.9/4 lost it to one "4.0 scale" typed into the scale box: nothing was flagged,
    // so `remaining` stayed 0 and Confirm was live, the server takes a profile with no GPA
    // happily, and the student's own true sentence about that GPA then came back
    // `unsupported` at G3, where there is no override. Raising here is safe in the direction
    // the blanket `raise: false` protects — a row that never held a GPA raises nothing, so
    // the student whose school publishes none is not sent to a gate to explain it.
    const lost = gpa === undefined && entry.gpa !== undefined;
    onEntry(index, { ...entry, gpa }, path('gpa'), { raise: lost });
  };

  return (
    <>
      <div className="grid gap-x-8 sm:grid-cols-2">
        <TextField
          label="School"
          value={entry.institution}
          flagged={flagged(path('institution'))}
          onChange={(e) =>
            onEntry(index, { ...entry, institution: e.target.value }, path('institution'))
          }
        />
        <SelectField
          label="Level"
          hint="Decides whether a posting counts you as a student, so an entry the reader could not place is flagged for you."
          value={entry.level}
          flagged={flagged(path('level'))}
          onChange={(e) =>
            onEntry(
              index,
              { ...entry, level: e.target.value as EducationEntry['level'] },
              path('level'),
            )
          }
        >
          {EducationLevel.options.map((level) => (
            <option key={level} value={level}>
              {LEVEL_LABELS[level]}
            </option>
          ))}
        </SelectField>
        <TextField
          label="Field of study"
          hint="Leave it empty for a high school."
          value={entry.fieldOfStudy ?? ''}
          flagged={flagged(path('fieldOfStudy'))}
          onChange={(e) =>
            onEntry(
              index,
              { ...entry, fieldOfStudy: e.target.value || undefined },
              path('fieldOfStudy'),
            )
          }
        />
        {/* Month rather than day. The profile stores YYYY-MM, and a full date picker would
            hand it a day it cannot store and fail the save on a field nobody typed a day
            into on purpose. Emptying one has to read as absent, the same way the
            availability dates below do. */}
        <TextField
          label="Started"
          type="month"
          value={entry.startDate ?? ''}
          flagged={flagged(path('startDate'))}
          onChange={(e) =>
            onEntry(index, { ...entry, startDate: e.target.value || undefined }, path('startDate'))
          }
        />
        <TextField
          label="Finishes"
          type="month"
          hint="An expected graduation date is fine here."
          value={entry.endDate ?? ''}
          flagged={flagged(path('endDate'))}
          onChange={(e) =>
            onEntry(index, { ...entry, endDate: e.target.value || undefined }, path('endDate'))
          }
        />
      </div>

      {/* All three boxes carry the same flag, because the extractor raises one flag for the
          whole GPA: a transcript printing only "4.32 weighted" is missing the unweighted
          number and the scale, and pointing the amber at one box would say the other two
          were fine. `inputMode` rather than a number input, so a decimal point survives
          being typed and nothing rounds a true 3.968 to something the student never had. */}
      <div className="mt-4 grid gap-x-8 sm:grid-cols-3">
        {GPA_PARTS.map((part) => (
          <TextField
            key={part}
            label={GPA_LABELS[part]}
            inputMode="decimal"
            value={boxes[part]}
            flagged={gpaFlagged}
            onChange={(e) => editGpaBox(part, e.target.value)}
          />
        ))}
      </div>
      {note && <p className="text-faint u-prose mt-2 text-sm">{note}</p>}

      <ListEditor
        label="Coursework"
        singular="Course"
        items={entry.coursework ?? []}
        onChange={(next) => onEntry(index, { ...entry, coursework: next }, path('coursework'))}
      />
      <ListEditor
        label="Honors"
        singular="Honor"
        hint="Awards, placements and honor societies. For a young applicant these are most of the evidence a claim can be checked against, so spell each one out the way it is written on the certificate."
        items={entry.honors ?? []}
        onChange={(next) => onEntry(index, { ...entry, honors: next }, path('honors'))}
      />
    </>
  );
}

/**
 * What the last save cost at G3, said out loud on the screen that cost it.
 *
 * The server re-checks every approved answer against the profile a write just stored and
 * takes the approval off the ones it no longer supports. The client used to throw that list
 * away — `saveProfile` was `.then(CandidateProfile.parse)`, and a Zod object parse drops the
 * key — so correcting a school name here silently un-approved an answer and said nothing.
 * The student went on believing a sentence was approved that the app had un-approved, and
 * the first news of it was the fill refusing at G4, by which time the reason was three
 * screens away. G3 means a human checked this text against the profile; when the profile
 * moves under it, the person who moved it is the one who has to be told.
 *
 * Every claim is printed, with the server's own reason beside it, because "an answer needs
 * reviewing" without the sentence that lost it sends the student back to hunt for a
 * difference they cannot see.
 */
export function WithdrawnNotice({ items }: { items: api.WithdrawnApproval[] }) {
  if (items.length === 0) return null;
  const one = items.length === 1;
  return (
    <Notice tone="caution">
      That save took the approval off {one ? 'one answer' : `${items.length} answers`}. Your profile
      no longer supports something {one ? 'it says' : 'they say'}, so {one ? 'it is' : 'they are'}{' '}
      back to unapproved and {one ? 'has' : 'have'} to be reviewed again at G3 before anything can
      be filled in with {one ? 'it' : 'them'}. Nothing was sent anywhere.
      <ul className="mt-3 space-y-3">
        {items.map((w) => (
          <li key={w.answerId}>
            <span className="u-data">{w.question}</span>
            {w.claims.map((c, i) => (
              <p key={i} className="text-faint mt-1 text-sm">
                "{c.claim}" — {c.reason}
              </p>
            ))}
          </li>
        ))}
      </ul>
    </Notice>
  );
}

function Summary({ label, n, extra }: { label: string; n: number; extra?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-6">
      <dt className="text-dim text-base">{label}</dt>
      <dd className="u-data" style={{ color: n > 0 ? 'var(--ink)' : 'var(--ink-faint)' }}>
        {n === 0 ? 'none found' : `${n} entr${n === 1 ? 'y' : 'ies'}`}
        {/* Only alongside entries. "none found · no lines under them" says one thing twice. */}
        {n > 0 && extra && <span className="text-faint"> · {extra}</span>}
      </dd>
    </div>
  );
}

/** How much detail came with a set of entries, said in a way zero cannot hide inside. */
function lineLabel(lines: number): string {
  if (lines === 0) return 'no lines under them';
  return `${lines} ${lines === 1 ? 'line' : 'lines'} of detail`;
}

/**
 * The places the user can work from besides their home address.
 *
 * A student is routinely reachable from more than one city — home over the summer, campus
 * during term, a sublet for an internship they already took — and the profile held exactly
 * one. Everything downstream then read that single city as the whole answer: the location
 * rule told them a posting in their own college town was "not your home city", the score
 * gave it 0.4 as though they had never heard of the place, and the query planner never
 * searched it at all. So a posting they could have walked to ranked below a remote one.
 *
 * `base` stays separate above rather than becoming row zero here, because it is the ADDRESS
 * a form is filled from — one field, always answered. These are for matching and searching,
 * where every place counts the same; `workLocations()` in the shared package is the reader
 * that puts them back on equal footing.
 */
export function WorkLocationsEditor({
  locations,
  onChange,
}: {
  locations: WorkLocation[];
  onChange: (next: WorkLocation[]) => void;
}) {
  const edit = (index: number, field: keyof WorkLocation, value: string): void => {
    onChange(locations.map((l, i) => (i === index ? { ...l, [field]: value } : l)));
  };

  return (
    <div className="mt-8">
      <div className="mb-2 flex items-baseline justify-between gap-4">
        <h3 className="u-eyebrow">Other places you can work</h3>
        <span className="u-data text-faint">
          {locations.length === 0 ? 'none' : `${locations.length} added`}
        </span>
      </div>
      <p className="text-faint u-prose mb-4 text-sm">
        School, a second home, anywhere you could take a job in person. Each one is searched and
        matched exactly like your home city — give each a city, since a state on its own is not
        enough to match a posting against. Remote and hybrid postings are accepted for you
        everywhere, and this wizard has no control to turn either one off.
      </p>

      {locations.length > 0 && (
        <ul className="mb-4 space-y-3">
          {locations.map((loc, index) => (
            <li key={index} className="u-card-flat px-5 py-4">
              <div className="grid gap-4 sm:grid-cols-[1fr_8rem_10rem_auto] sm:items-end">
                <TextField
                  label="City"
                  value={loc.city}
                  onChange={(e) => edit(index, 'city', e.target.value)}
                />
                <TextField
                  label="State"
                  value={loc.region}
                  onChange={(e) => edit(index, 'region', e.target.value)}
                />
                <TextField
                  label="What it is"
                  hint="Optional — for you"
                  value={loc.label ?? ''}
                  onChange={(e) => edit(index, 'label', e.target.value)}
                />
                {/* Named by row, like every other list on this screen. Three buttons whose
                    only accessible name is "Remove", beside fields labelled City / State /
                    What it is in every row, give a screen-reader user pulling up the button
                    list nothing at all to choose between. */}
                <Button
                  size="sm"
                  aria-label={`Remove location ${String(index + 1)}`}
                  onClick={() => onChange(locations.filter((_, i) => i !== index))}
                >
                  Remove
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <Button
        size="sm"
        onClick={() => onChange([...locations, { city: '', region: '', country: 'US' }])}
      >
        + Add a location
      </Button>
    </div>
  );
}
