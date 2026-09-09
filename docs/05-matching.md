# 05 — Matching: eligibility and fit

Two distinct stages with different trust models.

**Eligibility is deterministic.** Hard rules run in pure TypeScript over structured fields.
A model never decides whether the user qualifies for something. Outcome is a tri-state:
`eligible` / `ineligible` / `unknown` — never a silent drop.

**Fit is advisory.** A 0–100 score with a visible per-dimension breakdown, used only for
ordering the review queue. It never filters anything out on its own.

## Filters

Defined in `packages/shared/src/filters.ts`. Filters are meant to shape *what you're shown*;
they are not the eligibility rules, which stay deterministic and run regardless.

**Most of the table below is not applied to anything yet.** `core/discovery/queryPlanner.ts`
is the only consumer of a filter set, and it reads seven leaves: `term.seasons`,
`term.years`, `positionTypes`, `location.cities`, `role.roleFamilies`, `role.titleIncludes`
and `company.onlyCompanies`. Everything else in the Groups table parses and validates and is
then ignored — `POST /api/discovery/plan` returns the same plan for a fully populated filter
set as it does for `{}` — though it now says which leaves it dropped, in a plan note. The
Discover screen sends exactly one of the seven, `company.onlyCompanies`, and nothing else, so
no user meets the silent half; an API caller sending a fuller body gets the note. Read the
table as the intended model, not as shipped behaviour, and check `queryPlanner.ts` before
relying on a group.

Three rules govern the parts that are live:

1. **Every default is permissive.** An unset filter widens the search, never narrows it —
   with the deliberate exception of the season/year and position-type defaults, which pin
   the search to the cycle the user is applying for.
2. **Unstated is not disqualifying.** A posting that doesn't mention pay is unknown, not
   unpaid. Every `include*Undisclosed` / `includeUnknown*` flag defaults to true.
3. **Filters that mirror a hard rule are preferences about display**, not the rule itself.

### Groups

| Group | Covers |
| --- | --- |
| **Term** | Seasons (summer/fall/winter/spring/year-round/flexible), years, duration in weeks, start & end windows, multi-term (co-op) allowance, minimum overlap with your availability, whether to include undated postings |
| **Position type** | Internship, co-op, fellowship, apprenticeship, research/REU, new-grad, part-time, seasonal, contract, externship, trainee program, volunteer |
| **Program flags** | Diversity programs, first-year/sophomore-specific, high-school programs, returnships, veteran programs, rotational, leadership development, PhD/research, return-offer track |
| **Arrangement** | On-site, hybrid, remote, geo-restricted remote, field/travel; hybrid days-on-site range; which states/countries a remote role permits |
| **Location** | Cities, regions, countries, radius from your base, relocation targets, exclusions |
| **Compensation** | Paid-only, academic credit acceptable, minimum by hour/week/month/year/total, currency, housing stipend, relocation assistance, include-undisclosed |
| **Eligibility** | Education levels, graduation window, enrollment requirement, hide-above-my-age, sponsorship availability, citizenship/clearance requirements, GPA ceiling, include-unknown |
| **Company** | Size, sector (private/public/nonprofit/government/academic/startup), industries, only-these-companies, exclusions |
| **Role** | Role families, title include/exclude, description include/exclude, required skills, overqualified-requirement exclusion with a years tolerance |
| **Application** | Max steps, max essays, max estimated minutes, account required, ATS vendor allow/deny, deadline window, posted-within, and whether to exclude postings demanding a cover letter, transcript, portfolio, references, or a video interview |
| **View** | Eligibility band shown (`eligible` / `eligible_and_unknown` / `all`), minimum score, sort key and direction, hide-already-decided |

### Defaults

`DEFAULT_FILTERS` is Summer 2027, internships and co-ops, United States, any work
arrangement, any compensation, undisclosed and unknown included, sorted by fit. The season
and year are ordinary values — nothing in the system hardcodes summer or 2027.

### Presets

`filter_preset` rows are named, saved filter sets. Eight starters are defined in
`STARTER_PRESETS`: *Summer 2027*, *Remote only*, *Co-ops (6+ months)*, *Paid only*, *Quick
applications*, *Closing soon*, *Government & research*, and *Cast a wide net* (every
position type, every season, every year, ineligible postings shown — maximum recall).

> **Not built:** nothing loads them. No code seeds the `filter_preset` table, no route reads
> or writes it, and there is no control for saving, editing or deleting a preset. The eight
> sit in `packages/shared/src/filters.ts` as data, waiting for the screen that offers them.

## Stage 0 — Requirement extraction

Turns unstructured JD text into `job_requirement` rows. This *is* an LLM call
(`claude-opus-5`, structured output, `strict: true`), and it is deliberately narrow: it
extracts and quotes, it does not judge.

```ts
const RequirementSchema = z.object({
  requirements: z.array(z.object({
    kind: z.enum(['age','education_level','graduation_window','enrollment','work_auth',
                  'citizenship','location','term_dates','experience_years','skill','other']),
    operator: z.enum(['min','max','equals','one_of','between','present']),
    value: z.unknown(),                       // typed per kind, validated after parse
    necessity: z.enum(['required','preferred','unclear']),
    sourceQuote: z.string(),                  // MUST be verbatim from the JD
    confidence: z.number().min(0).max(1),
  })),
});
```

Two guards on the output:

1. **Quote verification.** Every `sourceQuote` is checked to actually appear in
   `description_text` (whitespace-normalized). A hallucinated quote drops that requirement
   and logs a warning — an invented requirement could wrongly disqualify the user.
2. **Value typing.** `value` is re-validated against a per-`kind` Zod schema after parsing.
   Anything that fails becomes `kind: 'other'` with `necessity: 'unclear'`, which routes to
   `unknown` rather than to a rejection.

Caching: requirements are extracted once per posting and reused across profile changes.
The prompt prefix (system + extraction schema + few-shot) is stable, which is what would
make it cacheable. **Not built:** prompt caching. No call anywhere sends a cache breakpoint,
so every extraction pays for the whole prefix.

## Stage 1 — Hard eligibility rules

Each rule is a pure function, individually unit-tested, returning a `RuleResult`:

```ts
type RuleResult = {
  rule: string;
  status: 'pass' | 'fail' | 'unknown' | 'not_applicable';
  because: string;            // human-readable, shown in the UI
  requirementId?: string;     // links to the verbatim JD quote
  profileRef?: string;        // which profile field decided it
  evidence?: string;          // verbatim text for rules that read the posting directly
};

type RuleInput = {
  profile: ConfirmedProfile;
  posting: PostingFacts;          // just the posting fields the rules read
  requirements: JobRequirement[];
  now: Date;                      // injected, never read from the clock, so tests are stable
};

type EligibilityRule = (input: RuleInput) => RuleResult;
```

### The rules

Thirteen of them, in `RULES` in `eligibility.ts`. There are two distinct ways a rule declines
to decide and the difference is load-bearing: **`not_applicable`** means the posting never
raised the question, **`unknown`** means it did and the tool could not settle it. Only
`unknown` badges a posting in the queue and pushes it below the eligible ones — a rule that
doesn't apply is not a question anyone needs to look at, and treating the two the same
badged nearly every row and meant nothing.

| Rule | Logic | When it doesn't decide |
| --- | --- | --- |
| `posting_open` | `is_open = 1`. | Always decides. |
| `deadline` | `closes_at` in the future. A date with no time means the whole of that day, not its first instant — bare dates parse to midnight UTC, which closed postings a day early on people who still had hours to apply. | `not_applicable` with no closing date; `unknown` if the date can't be read. |
| `age_minimum` | `derived.age >= req.value`. Common values: 16, 18. | `not_applicable` if no minimum is stated; `unknown` if one is and DOB is absent — the single highest-value missing field, so the user is prompted for it. |
| `education_level` | `derived.academicLevel` ∈ required set. Handles "currently enrolled in a Bachelor's" vs "must have completed". | `not_applicable` if no level is stated; `unknown` if the clause is unparseable or there is no education history to check against. |
| `postdoctoral` | The only rule that reads the TITLE rather than a requirement: postings for these rarely state the degree, because the word carries it. Drawn as narrowly as the word allows — "fellow" and "fellowship" are deliberately not enough, or it would hide the programmes an undergraduate most wants to see. | `not_applicable` unless the title says "postdoctoral"/"postdoc"; `unknown` when the title ALSO names a student post ("Research Intern, Postdoctoral Affairs Office"), because the office that runs a postdoc programme hires students to run it and the title alone cannot say which this is. |
| `graduation_window` | `expectedGraduation` within the stated window. Very common ("graduating Dec 2027 – Jun 2028") and a frequent silent disqualifier. | `not_applicable` if no window is stated; `unknown` if the window or your expected graduation can't be read. |
| `enrollment` | Many internships require active enrolment during the term or return-to-school after. Checks the graduation date against the requirement. | `not_applicable` if enrolment isn't required; `unknown` if the clause is unparseable or your graduation date is unknown. |
| `work_authorization` | `fail` when the posting requires authorization without sponsorship and `workAuthorization.needsSponsorship` is set. | `not_applicable` if unmentioned; `unknown` if the clause is unparseable or your status is not on file. |
| `citizenship` | Federal/defense postings requiring US citizenship, checked against `profile.citizenships`. | `not_applicable` if unstated. A clearance requirement always returns `unknown` — the tool cannot verify one and says so. |
| `location` | Text comparison, not distance. Nothing geocodes a posting, so `locationPrefs.maxCommuteKm` decides nothing here: the rule matches the posting's cities against every place you work from — your home address plus any additional bases — and against your relocation targets, and weighs remote and hybrid against your stated preferences. | `unknown` when the posting doesn't say where the role is based, and `unknown` for a location that is none of your places and not a target — a radius can't be measured without coordinates, and guessing would hide a job in the next town. Never `not_applicable`. |
| `term_overlap` | The posting's term window must overlap `availability` by ≥ 6 weeks. The window comes from explicit dates, else from "Summer 2027" and similar, else from an extracted `term_dates` requirement — an inferred window can raise a question but never hard-fails anyone. | `not_applicable` when the posting doesn't say when the role runs. |
| `experience_ceiling` | `fail` if required professional years > `derived.yearsProfessionalExperience + 1`. Catches "internships" wanting 3+ years. | `not_applicable` if no experience requirement is stated; `unknown` if it's unparseable. Experience listed as preferred rather than required passes. |
| `excluded_company` | `company` contains an entry from `preferences.excludeCompanies`. | Always decides. |

`eligibility` = `ineligible` if any rule fails; else `unknown` if any rule is unknown; else
`eligible`. `not_applicable` never moves the outcome.

> **Deferred with Guardian mode:** an `age_work_permit` rule, which would attach an advisory
> (never a fail) when the user is a minor and the posting's jurisdiction requires a work
> permit or restricts hours. The locked decision of 2026-08-03 puts Guardian mode out of v1
> — see docs/10 § Guardian mode and docs/11 § Decisions — so it is not in `RULES`.

### How the three states are presented

- **eligible** — in the queue, ranked by fit.
- **unknown** — in the queue, badged, with the specific unresolved question stated
  ("This posting's graduation window couldn't be parsed — here's what it says: '…'"). The
  user decides. Unknowns are shown *below* eligible items but never hidden.
- **ineligible** — collapsed into a "Filtered (N)" drawer, expandable, each with its
  blocker and the verbatim JD quote that caused it. This exists so the user can catch the
  tool being wrong. A filter you can't inspect is a filter you can't trust.

## Stage 2 — Fit scoring

Weighted sum over normalized dimensions.

> **Not built:** user-adjustable weights. `DEFAULT_WEIGHTS` in `score.ts` is the only set
> that ever applies — `scoreMatch` takes an optional `weights` argument and no caller
> passes one, and there is no settings API to store an alternative. The defaults below are
> therefore the real behaviour, not a starting point.

A dimension with no data behind it scores a neutral 0.5 and is marked as having no
evidence, which keeps it out of the rationale. An empty required-skill list used to score a
perfect 1.0, so a posting nobody had extracted skills from outranked one the user genuinely
matched, and the rationale led with "the required skills line up — no required skills
listed".

| Dimension | Default weight | Computation |
| --- | --- | --- |
| Required-skill coverage | 30 | Fraction of `necessity: 'required'` skill requirements matched against the user's skill names. Exact match on a normalized name, then a small hand-written alias table (`js`/`node` → javascript, `k8s` → kubernetes, and a handful more). The alias list is deliberately short: a wrong alias inflates a score silently. |
| Preferred-skill coverage | 12 | Same over `preferred`. |
| Role-family alignment | 18 | Fraction of the posting title's terms that appear in the user's own vocabulary — experience titles, skill names and project names — after dropping stopwords and the words every internship title carries (`intern`, `internship`, `summer`). Cheap, explainable, and traceable to a specific word on the user's resume. |
| Domain/interest match | 10 | Substring match of each stated industry against the whole job description, lowercased. There is no company-industry field anywhere — `job_posting` has no industry column and `PostingFacts` carries none — so this asks whether the word appears in the posting at all. No stated industries scores a neutral 0.5. |
| Seniority fit | 10 | Membership, not distance: each seniority band has a fixed list of position types, and a posting scores 1.0 if its `positionType` is on the list, 0.25 if it is not, 0.5 if the posting states none. No requirement is read and nothing is measured. |
| Location desirability | 8 | A fixed ladder, not a preference ranking: 1.0 for a posting in any place you work from, 0.9 remote, 0.8 a relocation target, 0.4 otherwise. `remoteOk` and `hybridOk` never enter this dimension — they are hard rules in stage 1, and a posting that reaches scoring has already cleared them. |
| Compensation | 6 | Only when disclosed; unstated compensation is neutral, never penalized. |
| Application effort | 6 | **Not built** — inverse of `apply_effort.estMinutes` + essay count is what it would compute, but nothing writes `apply_effort` (docs/03), so every posting takes the `effort === null` branch and scores the neutral 0.6 with the note "effort unknown". A one-click Greenhouse form and a 40-minute Workday wizard are ordered identically today, and 6 of the 100 weight points are a constant. |

Score is clamped 0–100 and stored with the full breakdown so the UI can show the bars.

**There are no embeddings anywhere in the app.** Skill coverage is exact-plus-alias and role
alignment is token overlap; `core/writing/retrieve.ts` carries the same note about
retrieval, and dedupe rejected them for its own reasons in docs/04. Embeddings would help
the two skill rows most — "React" against "ReactJS", "Postgres" against "relational
databases" — and `job_posting.embedding` is already in the schema waiting for them. Until
something writes that column, every bar traces to a word the user can point at, which is
worth something on its own.

**`rationale`** is a 2–3 sentence explanation generated from the breakdown — and it is
required to include the honest downside. There is no prompt and no model call:
`core/matching/rationale.ts` composes the sentences in TypeScript from the scored
dimensions and the rule results. The highest-scoring dimension that actually has evidence
behind it becomes the reason to apply. The downside is any eligibility rule that came back
`unknown`, plus the lowest-scoring dimension whenever it falls below 0.6; if neither applies
it says outright that nothing stands out as a likely rejection reason. Dimensions that scored
neutrally for lack of data are never named on either side, because a missing number is not
evidence of anything. All of which means it cannot invent a reason it has no number for, and
it reads exactly the same with or without an API key. A model polish pass over these
sentences is **not built**; if one is added it has to take the same breakdown as its only
source of facts, for the same reason. A ranking tool that only tells you why things are good
is a ranking tool you stop believing.

## Preference learning — NOT BUILT

Rejections do carry structured `reason_tags` (`wrong_role`, `wrong_location`, `company`,
`too_senior`, `low_pay`, `effort`, `not_interested`), and they are persisted to
`decision.reason_tags`. **Nothing reads them.** There is no weight adjustment, no
five-rejection threshold, no bounded range, and no Settings panel showing learned weights
or offering a reset — Settings has five sections and none of them is this.

The tags are being collected against the day this is built. Until then the ranking is the
same for the first posting as for the five hundredth, which is worth knowing if you are
wondering why the queue never seems to learn.

The guardrails below are the design, not the current behaviour:

- Learned weights would be shown in Settings with a "why" and a one-click reset.
- Learning would only ever reorder. It would never convert an `eligible` posting into a
  hidden one.

## Testing

`eligibility.ts` is the highest-stakes module in the system — a bug there silently costs the
user opportunities. It gets:

- A golden fixture set covering each rule's pass/fail/unknown paths. These are synthetic:
  `eligibility.test.ts` builds them from `profile()`, `posting()` and `req()` factories, so
  every scenario is a structured requirement object rather than prose. No job-description
  text is exercised anywhere in the suite. **Not built:** the ~60 real anonymized JD
  excerpts with hand-labeled expected outcomes this line used to claim. The gap that leaves
  is the step *before* these rules — whether requirement extraction turned the posting's
  actual words into the right requirement object in the first place.
- Property tests: no rule may return `fail` without either a `requirementId` or posting
  `evidence` — seven of the fourteen fail paths (location twice, term overlap,
  deadline, posting open, excluded company, postdoctoral) cite evidence rather than a requirement, because they
  fail on something the posting says rather than on a requirement it states; `unknown`
  inputs can never produce `fail`; adding a profile fact can never turn `eligible` into
  `ineligible` for an unchanged posting.
- A regression test per bug found, forever.
