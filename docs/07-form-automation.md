# 07 — Form automation

Fills application forms in a **visible** browser so the user watches it happen and reviews
the real page before submitting. It does not submit.

## Browser

Playwright Chromium, launched via `launchPersistentContext` against
`data/browser-profile/`, **headed by default**. Headless is used only for the local test
fixture site.

Why persistent: many ATS platforms require an account, and a persistent profile means the
user logs in once per vendor and the session survives. Storage state per domain is
referenced from `credential_ref` — which stores **a path to a Playwright storage-state file,
never a password**.

**Nothing installs the browser, so the first fill on a fresh clone fails.** `npm install`
brings in the `playwright` package and no browser: this version declares no install script
(the lockfile records no `hasInstallScript` for `playwright` or `playwright-core`), and no
script in `package.json` runs `playwright install`. Every other part of the tool works
without one — ingestion, discovery, matching and drafting never open a browser — so the
gap does not show up until `openSession` calls `launchPersistentContext`, which is on a real
application at the moment the user asked for a form to be filled. What they get is a 502
`FILL_FAILED` carrying Playwright's own message, which does at least name the remedy:

```bash
npx playwright install chromium
```

Chromium is the only browser `openSession` ever launches, so that is the whole download. The
right home for it is a `postinstall` in the root `package.json`; until that exists, it is a
manual first-run step, documented in the README's § Running it and here.

**One profile directory means one browser, which means one application at a time.** Chromium
locks `data/browser-profile/`, so a second `launchPersistentContext` against it cannot
succeed. Runs are keyed per application and nothing used to stop a second one being started —
the ordinary way in is to park run A on a login wall and go and start application B — so B
failed on the lock and surfaced as a 502 carrying a raw Playwright complaint about a path.
`POST /fill` now refuses with 409 `FILL_BROWSER_BUSY` and says which action clears it.

Within one run, exactly one caller drives the page at a time, and the claim is taken
**before the first await** rather than read off the run's state. `continueRun` spends its
first several seconds in `detectIntervention` and `buildFormMap` with the state still reading
`reading`, so a guard on `state === 'filling'` — which is what this had — let two continues
through into `executePlan` against one page and one keyboard. `insertText` types into
whatever has focus, so one run's approved essay could land in the box the other had just
clicked into, on a live form. See `claimBrowser` in `core/filling/run.ts`.

### Login handling

When a fill run hits a login wall:

1. The run pauses.
2. The UI says: *"This site needs you to be signed in. Log in in the browser window that's
   open, then click Continue."*
3. The user logs in themselves. The tool does not type into password fields, does not
   create accounts, and does not read credentials from a password manager.
4. On Continue, storage state is saved and the run resumes.

Same for CAPTCHAs and any bot-check challenge: pause, hand it to the user, resume. There is
no solving, no bypass, no third-party solver integration.

## Typing rather than assigning — and why

Fills use `locator.pressSequentially()` rather than `fill()`, for a purely mechanical
reason: React/Vue-controlled inputs, autocomplete comboboxes, and rich-text editors
frequently ignore programmatic value assignment and only update on real key events.
Instant `fill()` breaks them. The fixture's `/nasty` page reproduces this exactly, and
`fill.test.ts` asserts both halves of it.

That is the whole rationale. The design deliberately does **not** include canvas/WebGL
fingerprint spoofing, proxy or IP rotation, user-agent randomization, or timing models
tuned against bot-detection heuristics. The browser identifies as what it is.

**On the delay between keystrokes.** This originally specified 40–120ms, described as
"human cadence". That framing was wrong and the number was a guess. What makes hostile
widgets work is that key events fire *at all*; the pacing only buys time for a debouncing
widget to keep up. Measuring it showed the cost — the fill suite spent 76 seconds almost
entirely asleep between keystrokes — so it is now **10–30ms**, and **0 for text over 120
characters**, where an essay would otherwise cost a minute a field. The commit-on-key
fixture still passes, which is the property that actually matters.

Two control types opt out of typing entirely:

- **`date`** holds a structured value, not text. Typing an ISO string into a segmented
  date editor produces nothing; `fill()` is the only thing that sets it.
- **`combobox`** (the div-based kind) has no value to set at all. It gets opened and an
  option gets clicked, the same way a person would.

## Building a FormMap

Before filling anything, the page is read into a semantic map:

```ts
type FormField = {
  id: string;
  locator: string;                 // stable Playwright selector
  label: string;                   // resolved from <label>, aria-label, aria-labelledby,
                                   // placeholder, or nearest preceding text node
  control: 'text' | 'textarea' | 'select' | 'multiselect' | 'radio' | 'checkbox'
         | 'file' | 'date' | 'combobox' | 'richtext';
  required: boolean;
  maxLength?: number;
  options?: Array<{ value: string; label: string }>;
  semantic: FieldSemantic;         // what it MEANS — see below
  confidence: number;
  step?: number;                   // multi-step wizards
  frame?: string;                  // iframe path if nested
};

type FieldSemantic =
  | 'first_name' | 'last_name' | 'full_name' | 'email' | 'phone'
  | 'address_line1' | 'city' | 'region' | 'postal' | 'country'
  | 'linkedin' | 'github' | 'portfolio' | 'website'
  | 'school' | 'degree' | 'major' | 'gpa' | 'graduation_date' | 'enrollment_status'
  | 'resume_upload' | 'cover_letter_upload' | 'transcript_upload'
  | 'work_auth' | 'sponsorship_needed' | 'start_date' | 'end_date' | 'hours_available'
  | 'essay'            // free-text question → writing engine
  | 'referral_source' | 'salary_expectation'
  | 'REDLINE'          // never auto-filled — see below
  | 'unknown';
```

### Classification

Two-stage, cheap-first:

1. **Deterministic matcher.** A rule table over normalized label + `name` + `id` +
   `autocomplete` attributes. Handles the ~80% of fields that are recognizable
   (`autocomplete="email"`, `name="first_name"`, label "Graduation Date"). Zero cost, fully
   testable, high precision.
2. **LLM fallback** (`claude-haiku-4-5`, structured output) for the remainder. Gets the
   label, surrounding text, control type, and options; returns `{semantic, confidence}`.
   Low confidence (< 0.75) → treated as `unknown`.

`unknown` fields are **left blank** and surfaced for the user by label. They are never
guessed at. There is no cropped screenshot of the field, as this section used to promise —
nothing in the app captures a screenshot at all; see § The submit gate below.

> **Not built:** stage 2. Nothing in the classification path calls a model — there is no
> `claude-haiku-4-5` request, and the descriptor stage 1 works from carries no
> surrounding-text field for a model to read, so the seam that would feed one does not exist
> either. What ships is stage 1 and the `unknown` behaviour above: a field the rule table
> cannot name is left blank and handed to the user. That is the safe half of the two-stage
> design, so its absence costs coverage rather than correctness — the fields it would have
> recovered are the odd, one-off custom questions, and today those are all typed by hand.

> **Not built:** the classification cache. There is no store keyed on
> `(ats_vendor, normalized_label)`, so every field is classified from scratch on every run.
> Stage 1 is a rule table and costs nothing, so what a cache would really save is a repeat
> model call on the same odd label from the same vendor — worth having, not there yet.

## Redlines — fields that are never auto-filled

Hard-coded, not configurable. Detected by semantic classification *and* by a keyword
blocklist over labels, so a mislabeled field still gets caught.

| Category | Examples | Behavior |
| --- | --- | --- |
| Government/financial identifiers | SSN, SIN, national ID, passport number, driver's license, bank account, routing, credit card | Skipped. Listed for the user. The tool never stores these either. |
| Credentials | password, security questions | Skipped. |
| Attestations | "I certify the information above is true and complete", signature fields, e-sign | Skipped — this is a personal legal statement. |
| Consent | terms of service, privacy policy, background-check authorization, marketing opt-in | Skipped — consent is the user's to give. |
| EEO / demographic self-ID | race, ethnicity, gender, veteran status, disability status | Skipped — voluntary self-identification, and not the tool's to answer. |
| AI-disclosure | "Did you use AI to write any part of this application?" | Skipped and **highlighted** for the user with a note that it needs their answer. |

Every redlined field lands in `application.skipped_fields` and is enumerated in the
pre-submit checklist, so the user knows exactly what's left to do.

## ATS adapters

Strategy pattern over a common interface; a generic adapter handles the long tail.

```ts
interface AtsAdapter {
  vendor: AtsVendor;
  detect(page: Page): Promise<boolean>;
  mapForm(page: Page): Promise<FormMap>;      // may override generic mapping
  fill(page: Page, plan: FillPlan): Promise<FillResult>;
  locateSubmit(page: Page): Promise<Locator | null>;  // located, never clicked
}
```

| Adapter | Notes |
| --- | --- |
| `greenhouse` | Simple, single-page, predictable `name` attributes. Best case. |
| `lever` | Single-page, clean. Custom question blocks need label resolution. |
| `ashby` | React-heavy; requires key events, not `fill()`. Comboboxes need option matching. |
| `smartrecruiters` | Multi-section, moderate. |
| `workday` | **The hard one.** Multi-step wizard, heavy shadow DOM, dynamic IDs, per-step validation, account creation gate. Gets step-aware state, per-step screenshots, and generous waits. |
| `icims` / `taleo` | Legacy, iframe-heavy, frequently server-rendered. |
| `generic` | Pure `FormMap`-driven. Handles anything that isn't recognized. |

Detection order: URL host → embedded script fingerprints → DOM markers → `generic`.

> **Not built:** any of the per-vendor adapters, and the interface above is the design
> rather than shipped code — there is no `locateSubmit`, and nothing takes the per-step
> screenshots the Workday row describes. What runs today is the generic `FormMap`-driven
> path, which handles all of these in principle because it works from labels and roles
> rather than vendor markup, but has never been pointed at a real posting from any of them.
> docs/11 § M6 has the detail.

## Filling

Per field, by control type:

- **text/textarea** — `pressSequentially`, on a value `buildFillPlan` has already cut to the
  field's `maxLength`; verify the value stuck by reading it back. Keystroke pacing is
  dropped past 120 characters, because nothing is watching an essay box.
- **select** — `chooseOption` tries the option's `value` attribute, then the whole label,
  then the options whose opening *words* are the intended answer — and that last pass only
  counts when exactly one option fits, and only for an answer longer than a single
  character. An option carrying an empty `value` is the "Select an option" placeholder and
  is never chosen; picking it would blank a field rather than fill one. Anything below that
  bar is left blank and flagged. There is no similarity score and no threshold; the ordering
  is the whole mechanism, and it is what stops "US" landing on "Australia" and "No" landing
  on "Yes, now or in the future". What the report prints is the label the page now displays,
  resolved back through the option list, because a `<select>` reads back its option's value
  attribute — usually a code — and printing the planned answer instead made the one field a
  reader most needs to check look like the one they can trust.

  **The same function chooses for every option list on the form** — `<select>`, radio groups
  and div comboboxes alike. Each of the other two kept a matcher of its own after this one
  was hardened, and each went on making this exact mistake on the sponsorship question. One
  list, one rule.
- **combobox/autocomplete** — click the control open, then read *every* `[role=option]` out
  of the listbox and choose between them in memory, by `chooseOption`. Reading them all
  first is the point. Asking the page for the first option whose text merely *contains* the
  intended value — which is what this used to do, on the first 24 characters,
  case-insensitively — picks "Australia" for "US", "Nevada" for "VA" and "Yes, now or in
  the future" for "No", and it has already clicked the wrong one by the time anything can
  object. The options are read from the listbox the control names in `aria-controls` or
  `aria-owns`, and only from the frame at large when it names none, or names one that is not
  in the document: an ATS that renders every question's options into one document will
  otherwise offer up an option belonging to a different question entirely. A control that offers no options, or none that clear
  `chooseOption`'s bar, is left blank and flagged rather than guessed at. Nothing types a
  prefix and nothing waits for the listbox to narrow. Like a `<select>` this cannot be
  verified by re-reading — the widget holds whatever it was told — so the report prints the
  words the page now shows, and a control left holding something other than the option that
  was clicked comes back as a mismatch in the pre-submit review.
- **radio/checkbox** — a grouped radio is matched against each button's *own* label, by
  `chooseOption`, and that button is checked — never whichever button happened to carry the
  group's question as its label. Radios kept a three-step matcher of their own (exact label,
  then the option's value, then any label starting with the answer) after `chooseOption` was
  hardened, and it did the same damage one control down: with "Currently enrolled part-time"
  and "Currently enrolled full-time" both on the page, the answer "Currently enrolled" ticked
  whichever came first in the document and reported it filled. `chooseOption` refuses a
  leading-word match when two options fit, so that question is left for the user instead. A
  stray checkbox or ungrouped radio is only ever ticked, never unticked, and only for an
  affirmative value; anything else is left exactly as the page had it. (Never for redlined
  categories.)
- **date** — `fill()` on the native input. A date input holds a structured value, so typing
  an ISO string into its segmented editor produces nothing. `input[type=date]` and
  `input[type=month]` reach the filler as the same kind of control, so the value is reshaped
  to whatever the input on the page can actually hold: a graduation stored as "2027-05"
  becomes "2027-05-01" for a day input, with a note telling the user the day was assumed,
  and an availability stored as "2027-06-01" is trimmed to "2027-06" for a month input.
  Without that, whichever granularity the employer used, one of the two was handed a value
  the input cannot take, and Playwright's "Malformed value" was what the user saw next to
  their graduation date. There is no picker-widget fallback: a date control that is neither
  of those native inputs is a field the user finishes.
- **file** — `setInputFiles` with the primary resume, on the resume field only. Every other
  file field is skipped with "Attach this file yourself."
- **richtext** — click to focus, then `keyboard.insertText`; verify via `data-value` or
  `innerText`.
- **multi-step** — the tool never clicks Next. It fills the step that is on screen and
  stops. The user advances the wizard in the browser window that is already open and tells
  the app to continue, which re-reads the page and re-plans from scratch — filling against
  a map built before the user moved is how a value lands in the wrong box. No screenshot is
  taken per step, or ever.

> **Not built:** generated cover letters and transcripts. `classify.ts` recognizes a
> `cover_letter_upload` field, but nothing in the server produces such a document, so those
> fields are skipped like any other non-resume upload.

> **Not built:** anywhere to *enter* a street address, so the address block on every form is
> the user's. The plumbing on this side is complete — `classify.ts` recognizes
> `street-address` and `postal-code`, and `valueFor` reads `profile.address.line1` and
> `.postal` straight out — but nothing ever writes them. Ingestion refuses to guess
> (`toProfile.ts` drops a postcode out of "Portland, OR 97214" rather than "asserting a piece
> of the user's address that nobody has checked") and defers to G1; the G1 editor collects a
> home city and a state and stops. So `line1`, `line2` and `postal` are empty on every profile
> this tool has ever held, and the pre-submit review says *"Your profile has no street address
> to fill in."* and *"Your profile has no postal code to fill in."* — the same sentence used
> for a GPA nobody entered, which reads as a gap the user could go and close when there is no
> control anywhere to close it with. `NO_PROFILE_SOURCE` exists for exactly that mismatch and
> these two do not qualify for it: unlike "How did you hear about us?", this is a field the
> profile is *supposed* to have.
>
> The rest of the block survives on fallbacks, so what is actually retyped by hand each time
> is the street line and the postcode: `city` and `region` fall back to `locationPrefs.base`,
> and `country` defaults to `US`. The fix is a field on the G1 screen (docs/08 § Onboarding),
> not a change here.

Every write is followed by a read of what the page then holds, and a field that did not take
is reported rather than assumed. On a `<select>` or a combobox that read is worth less than
it looks: the control holds whatever it was told, so re-reading cannot tell a right choice
from a wrong one. There it is the matching rule above, not the read-back, that keeps the
answer honest — and the report prints the words the page displays so a wrong choice is at
least visible to the person reviewing the form.

## The submit gate (G4)

The strongest structural guarantee in the system.

1. Filling completes. The browser stays open, on the form, with the values in place.
2. The UI shows a **pre-submit review**: field by field what was filled, the full text of
   every essay answer, every read-back that did not match what was typed, and the list of
   skipped and redlined fields still needing the user.
3. The user finds the submit button and clicks it themselves, in the browser.
4. The user confirms in the app that they submitted.

There is no `autoSubmit` setting, no `--yes` flag, and no code path on the server that can
submit a form.

**How that is actually enforced**, because a promise is worth what its enforcement is worth:

- an ESLint `no-restricted-syntax` rule over `apps/server/src/**`. It carries a selector for
  each way a submit control gets named — the receiver (`submitBtn.click()`), a selector
  string or template anywhere inside the call (`page.click('button[type=submit]')`,
  `page.locator('#submit-application').click()`), and the routes that name nothing at all:
  `requestSubmit()`, a zero-argument `.submit()`, `new SubmitEvent` or a plain
  `new Event('submit')`, a `dispatchEvent` of one, and `.press('Enter')` or `.down('Enter')`,
  because Enter submits a single-input form in every browser;
- a CI step, `scripts/g4-scan.ts`, scanning the same tree as text, so a
  `// eslint-disable-next-line` cannot buy anyone a submit call. It self-tests against a
  dozen written-out submit paths before it will report a clean tree, because the version
  before it could not tell "there is no submit path" from "my pattern matches nothing" and
  printed the same reassuring line either way;
- a test in `app.test.ts` that runs `scanSource` — the same exported function the CI step
  runs, rather than a second table of patterns kept beside it — over the whole of
  `apps/server/src`. Not `core/filling` alone: that is eight files of seventy-two, so a
  `page.click('button[type=submit]')` in a route handler or a browser helper would have
  passed unremarked, and nothing stops a submit path being written outside the filling
  module. The test re-runs the scanner's own self-test from inside the suite, so a scanner
  that had quietly stopped matching anything turns a test red instead of reporting every
  file clean. The same test asserts that `POST /api/applications/:id/submit` is a 404;
- and a fixture test asserting the mock ATS recorded **zero** POSTs across the entire suite,
  which is the only one of the four that checks the outcome rather than the source text.

**All four of those answer a different question from the one a hostile page asks.** They
establish that no code here *writes* a submit call. They say nothing about a page arranging for
an ordinary-looking click to land on a control that submits, and every one of these was found
doing exactly that, verified in Chromium:

- `<input type="submit" role="combobox">` — an ARIA role on a submit control, which the
  exclusions covered for `<button>` and not for `input`;
- `<div role="combobox">` wrapping a stretched submit input, or a `<label role="combobox">`
  around one — a click lands on what is under the cursor, not on the element that was located,
  and Playwright's actionability check is satisfied by a descendant;
- a page that swaps a text input for a `<button>` with no `type` attribute the moment the
  *previous* field takes a keystroke, so the element was entirely legal when it was scanned;
- a custom element whose shadow root is `<div role="combobox"><slot></slot></div>`, given
  `<x-combo><input type="submit"></x-combo>`. The submit control renders inside the div
  without being its descendant, so no `:has()` can see it.

So there are two more layers, and they are runtime rather than source:

- **`selectors.ts` states once what must never be resolved** — anything that can submit or
  reset, and anything *containing* one, and every `<label>`, whatever it wraps or points at —
  and every clause of both selectors carries it. `locate()` narrows every stored locator with
  it again at fill time, because the scan and the fill are seconds apart and the page owns what
  happens in between.
- **`refuseIfItCanSend()` asks the page** over the composed tree — shadow roots entered, slots
  resolved to what was assigned them — immediately before each click. That is the one question
  a selector cannot answer, because the relationship is a rendering one and not a structural
  one.

**Where the layers currently differ**, since anyone adding a new submit shape needs to know
where it has to go. The CI step and the test share one function, so those two cannot
drift apart. The lint rule is necessarily a separate list — syntax selectors, not regexes —
and it is the narrower one: it does not yet look for a `\n` or `\r` standing in for Enter,
whether handed straight to `.press()` or sitting inside the string given to `.type()` or
`.pressSequentially()`, which press one real key per character. That shape is caught in CI
and by the test but not in the editor, which is the wrong way round for the layer meant to
stop the mistake being written in the first place.

For a long time two of those were decorative. The lint rule matched on
`callee.object.name`, which only exists when the receiver is a bare identifier, so it saw
`submitBtn.click()` and could not see `page.click('button[type=submit]')`; the CI step
grepped for `click\(\).*submit`, where `click\(\)` means literally empty parentheses, so a
click with a selector argument never matched. Both passed, green, on a file that did nothing
but submit forms seven different ways. The rule that keeps them honest: a G4 pattern has to
match the control wherever it is named — receiver, selector string, or a locator chained
ahead of the click — and cover the ways to submit that are not clicks. One pattern per
reported example is a gate with a hole in it.

And the second rule, which is why the layers are shaped the way they are above: a new submit
shape has to reach every gate that claims to look for it. There were three copies of the same
pattern list for a while, and the copy in the test could not see `page.keyboard.press('Enter')`
or a typed newline — separately maintained lists drift the moment one of them is updated on
its own. That is what `g4-scan.ts` exports `scanSource` for, and the test now drives it, so
there are two lists to keep in step rather than three.

> **Not built:** a CI check for any endpoint that could write `submitted_at` without the
> user. This section used to list one; `.github/` and `scripts/` contain no such check. The
> G4 step scans for submit paths in source, which is a different question from which
> endpoints can stamp the column.

Two things this section used to claim were never built, said plainly rather than quietly
dropped. **No screenshot is captured** — `application.screenshot_path` exists in the schema
and nothing writes it. **The submit button is not located or highlighted** — there is no
`locateSubmit`, and the tool never touches that control at all. The enforcement above is
static and behavioural; there is no runtime guard.

## Testing

- **Fixture site** (`packages/fixtures`) — a dependency-free `node:http` server (the package
  declares no dependencies at all) serving deliberately nasty forms: React-controlled
  inputs, shadow-DOM widgets, an iframe form, a 3-step wizard, a fake login wall, a combobox
  with near-miss options, and a page containing every redlined field type. Playwright tests
  run headless against it — but read § Browser before trusting that they run *in CI*:
  `.github/workflows/ci.yml` goes straight from `npm ci` to `npm test` with no browser install
  between them, and `selectors.test.ts` and `fill.test.ts` both call `chromium.launch()`
  unconditionally. Whatever the browser-backed tests are worth, they are worth it on a machine
  where someone has run the install command by hand.
- **Redline test** — asserts that no redlined field is ever written, on every fixture.
- **The plan step** — `buildFillPlan` produces the complete list of intended values, with a
  reason attached to every skip, before anything is typed. It is a pure function over the
  form map, the profile and the approved answers, so most of what a dry run would tell you
  is assertable in a unit test with no browser at all.

> **Not built:** recorded page snapshots — saved HTML from real ATS pages, scrubbed of PII,
> as regression fixtures for `formMap` + `classify`. This section listed them as a layer
> that exists; the repo holds two `.html` files and both belong to the web app. The
> synthetic fixture site is the only form corpus these modules are tested against, which
> means nothing here would notice a real ATS changing its markup. Worth building: it is the
> mitigation docs/11 names for the highest-likelihood risk in the form-filling work.

> **Not built:** a `--dry-run` flag or a "Preview fill" control. docs/08 and docs/09
> described both; neither exists. The plan above is the closest real thing, and it is not
> currently surfaced on its own before a run.
