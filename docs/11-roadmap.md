# 11 — Roadmap, testing, risks

## Status

| Milestone | State | Notes |
| --- | --- | --- |
| M0 Skeleton | **done** | 19-table schema, CI, G4 guards, pre-commit hook |
| M1 Resume → profile | **done** | Claude-native PDF ingestion, field encryption, G1 enforced in the repository |
| M2 Discovery | **done** | Six ATS board adapters — Greenhouse, Lever, Ashby, Workday, SmartRecruiters, Workable — plus the aggregators and web search, a polite fetcher, 3-stage dedupe, run reporting. Verified live: 424 postings from two real boards, with a failing board correctly reported as degraded rather than dropped. Named in full because "Greenhouse/Lever/Ashby" was written when that was the whole registry, and it was still being read as the whole registry after three more shipped. |
| M3 Matching | **done** | Deterministic + LLM requirement extraction with quote verification, 12 pure eligibility rules, scoring, rationale. Verified live: 816 postings → 420 eligible / 244 unknown / 152 ineligible, 203 requirements, 0 dropped, 0 errors. |
| M4 Review queue | **done** | Keyboard-first triage, requirement checklist with verbatim quotes, score breakdown, reject reasons, G2 approval creating an application. Verified live against 123 real matches. |
| M5 Writing engine | **done** | Bounded evidence retrieval, drafting with the measured voice, two-layer FactGuard, StyleCritic, answer library, G3 workspace. The adversarial suite passes: every planted fabrication caught, and the false-positive half passes too. G3 enforced server-side with no override. |
| M6 Form automation | **done** | Playwright with a persistent context, FormMap over six label-resolution strategies, redline enforcement, fill with read-back verification, pause/resume for login walls, pre-submit review, G4. The fixture counts POSTs, so "nothing was submitted" is asserted as an outcome rather than inferred from the source. |
| M7 Tracker | **done** | Status model where the tool cannot claim a submission, ghosting derived from silence rather than asked for, reminders as drafts, CSV export that cannot become a spreadsheet formula, and outcome rates that refuse to appear below ten observations. |
| M8 Hardening and packaging | **done** | Export everything decrypted, delete everything for real behind a typed phrase, a cost panel that reads the ledger, and the built interface served from Fastify so the whole app is one command. Guardian mode remains deferred by the locked decision in docs/10. |

All M1 and M2 deferrals are now complete: query planner, Adzuna/USAJOBS adapters, the SimplifyJobs community list, manual paste-a-URL, freshness/refresh, SSE progress, source management, writing-sample capture with StyleProfile, and resume set-primary/delete.

## Milestones

Each milestone is independently demoable. Nothing after M0 depends on a big-bang
integration.

### M0 — Skeleton (½ day)

pnpm/npm workspace; `apps/server` (Fastify + health route), `apps/web` (Vite + React +
Tailwind + shadcn), `packages/shared` (Zod schemas), `packages/fixtures` stub. Drizzle wired
to SQLite with the first migration. Pino logging. Vitest + Playwright configured. CI running
lint + typecheck + tests. `.gitignore` and the PII pre-commit hook in place.

**Done when:** `npm run dev` serves a UI that reads a health endpoint, and CI is green.

### M1 — Resume → confirmed profile (2 days)

Upload endpoint + storage. Claude-native PDF extraction with structured output; DOCX/TXT/MD
text path. `deriveFields`. Field-level encryption + keychain. The G1 onboarding wizard.

**Done when:** a real resume produces a profile the user corrects and confirms, and
`confirmed_at` gates everything else.

### M2 — Discovery (3 days)

`infra/http` (rate limit, cache, backoff, robots). Adapters: Greenhouse, Lever, Ashby,
USAJOBS, Adzuna, the SimplifyJobs list. Company resolution. Query planner + editable plan.
Normalization, three-stage dedupe, refresh. Run summaries + SSE progress.

**Done when:** a run over real sources returns deduped summer-internship postings with an
honest per-source report.

### M3 — Matching (3 days)

Requirement extraction with quote verification. The eligibility rule set as pure functions
with the golden fixture suite. Scoring + breakdown + rationale. The `eligible` /
`unknown` / `ineligible` tri-state end to end.

**Done when:** every posting in the queue can be traced to a pass/fail per requirement with
the verbatim JD quote, and the filtered drawer explains every exclusion.

### M4 — Review queue (2 days)

The Matches screen: virtualized list, detail pane, requirement checklist, score breakdown,
keyboard triage, reject-reason capture, G2 approval creating an application.

**Done when:** 100 matches can be triaged from the keyboard without touching the mouse.

### M5 — Writing engine (4 days)

Writing-sample capture and `StyleProfile` computation. Retrieval. Drafting. FactGuard (LLM
verdicts + deterministic checks on numbers/dates/names). StyleCritic. Tell-scrub. Answer
library. The G3 workspace with claim highlighting, evidence panel, flags, and the
edit-distance meter.

**Done when:** a drafted answer reads like the user, every claim shows its evidence, and a
deliberately planted false claim is caught and blocks approval.

**Built.** FactGuard is two layers and the deterministic one runs with no API key, so the
adversarial suite runs on every commit rather than only when a key is configured. The model
layer is written and tested — it may downgrade a verdict but never clear one — and is **not
wired into any production path**: neither `draftAnswer` nor the G3 route asks for model
verdicts, so semantic overstatement that the deterministic checks cannot reach is caught by
the human at G3 and by nothing else. docs/06 § ④ has the detail.

Half the suite guards the opposite direction, which turned out to matter as much. A checker
that flags honest sentences teaches you to click through warnings, and then it protects
nothing. Four false-positive classes were found and closed: evaluative sentences
("It was not glamorous work") no longer turn red on weak lexical overlap alone; durations
need first person and a working verb before they are measured against employment; sentence
adverbs are not employers; and a name at the end of a sentence no longer arrives with the
full stop attached, which had made "TypeScript." look exactly like a fabrication.

Gate G3 is enforced in `routes/answers.ts`, which re-verifies at approval time and returns
409 while any claim is unsupported. There is no override parameter and no bulk-approve
endpoint. `answers.test.ts` asserts the second — three plausible approve-everything paths
all answer 404. It does not assert the first, which this line used to claim it did: the
handler reads no body, so there is nowhere for an override to arrive, but that is a fact
about the code as written and no test would go red if a parameter were added tomorrow.

**Not done:** drafting itself has never run against a live model. The reason is no longer
that there is no key: the Claude Code CLI backend exists and resume extraction and discovery
have both been exercised live through it, so drafting could be run the same way. It simply
has not been. Everything downstream of generation is verified; generation is not.

### M6 — Form automation (5 days — the long pole)

Browser lifecycle and persistent context. `FormMap` + two-stage classification. Redline
enforcement. Fill strategies per control type with read-back verification. Adapters:
generic, Greenhouse, Lever, Ashby, then Workday. Pause/resume for login and unknown fields.
Pre-submit review + G4. The fixture site and its Playwright suite.

**Done when:** the fixture site's nastiest form fills correctly, every redlined field is
skipped, and there is no code path that clicks Submit.

**Built.** The fixture grew into something worth testing against: aria-labelledby-only
labels, placeholder-only fields, a label in a preceding sibling div, a div-based combobox,
shadow DOM, a mislabeled redline, a nested iframe, and a wizard whose fields do not exist
until you advance.

Three findings worth keeping:

- **The G4 guard had to change shape.** Its first version banned every `.click()` in
  `core/filling`, which was correct until the filler needed to focus a text input and pick
  a combobox option. A guard that forbids something legitimate gets deleted or worked
  around. It is now narrower (only submit-shaped targets) and wider (`requestSubmit()`,
  `form.submit()`, and pressing Enter, which submits a single-input form). The behavioural
  check is stronger than any of it: the fixture counts POSTs.
- **The redline table was US-centric.** Testing it against 447 researched real-world labels
  found 269 misses, overwhelmingly non-US: Aadhaar, NRIC, Codice Fiscale, CPF, BSB, IFSC.
  A table that is safe for a US applicant and porous for everyone else is not finished.
- **Broadening a blocklist causes its own damage.** Probing after the fix found three
  false positives it had just introduced — "GitHub username", "Professional
  certifications", "Declaration of major". All three now have tests keeping them fillable.

**Not done:** the per-vendor ATS *form-filling* adapters (Greenhouse, Lever, Ashby, Workday).
The word "filling" is load-bearing and was missing: adapters under those same four names ship
in M2 and fetch postings perfectly well, so "no Workday adapter" read as a hole in discovery
and got repeated that way into the README. `core/filling` holds `formMap.ts` and no vendor
file; `core/discovery/sources/ats.ts` holds six vendors. The generic mapper handles all four
in principle, since it works from labels and roles rather than vendor markup, but that is
untested against a real posting from any of them. Research on their DOM structure was
gathered and is in the run journal.

### M7 — Tracker (2 days)

Status model + kanban + table + CSV export. Deadline and follow-up reminders as drafts.
Outcome stats by source.

**Not built, and the M7 row above marks the milestone done without them:** the read-only
Gmail/IMAP ingestion for status updates — there is no mail client anywhere in `apps/` or
`packages/`, so no status ever updates itself and every transition is the user's — and the
by-answer-variant half of the outcome stats. `computeStats` groups by source and by nothing
else; `answer_template.variants` stores a company variant that no statistic reads. Both were
listed here as though shipped, and docs/02 § Data flow was still telling the reader a mailbox
would move their cards.

### M8 — Hardening & packaging (3 days)

Privacy export/delete. Cost panel. Error taxonomy and recovery paths. Docs.
Single-command packaging (`npx internship-applier`) serving the built UI from Fastify.

Guardian mode was scoped into this milestone and is **deferred out of v1** by the locked
decision below. None of it was built; docs/10 § Guardian mode keeps the spec.

**Rough total: ~24 working days** for one person. M6 is the most likely to overrun; Workday
alone could eat several days and is the right thing to cut to a later milestone if the
schedule slips.

## Testing strategy

| Layer | Approach |
| --- | --- |
| **Eligibility rules** | The highest-stakes code. `eligibility.test.ts` covers every rule's pass/fail/unknown paths through synthetic profile and posting factories, plus property tests (no `fail` without a `requirementId` or posting evidence; `unknown` never yields `fail`; adding a profile fact never turns `eligible` into `ineligible`) and a regression test per bug, permanently. **Not built:** the corpus of ~60 hand-labeled real JD excerpts this row used to promise — no job-description text is exercised by any test. |
| **Source adapters** | Normalization is pure and unit-tested: `normalize.test.ts` covers season and year, position type, work arrangement, term dates and duration, compensation, URL and title identity, and reading HTML out of a feed. **Not built:** recorded HTTP fixtures — neither `nock` nor `msw` is installed in any workspace — and the weekly CI job that was to hit the live APIs for schema drift and open an issue without failing the main build. CI triggers on push to `main` and on pull requests; there is no `schedule` block. |
| **Extraction quality** | `extraction.test.ts` unit-tests quote verification, the deterministic regex pass, value validation, and an end-to-end extraction with no model call. **Not built:** the eval harness — a set of anonymized resumes with hand-labeled expected profiles, reporting per-field precision/recall, to be run before any extraction-prompt change ships. There is no labelled resume set and nothing measures precision or recall, so a prompt change ships on unit tests alone. |
| **FactGuard** | An adversarial suite: drafts with planted fabrications (invented employer, inflated duration, wrong GPA, nonexistent skill). Every one must be caught. This suite is a release gate. |
| **StyleProfile** | Metric computation unit-tested against hand-measured samples — `styleProfile.test.ts` covers text segmentation, `computeStyleProfile`, and the adequacy check. **Not built:** the round-trip test that a draft targeting a profile lands back within tolerance. Nothing currently checks that the voice instructions the drafting prompt is given actually move the output toward the profile. |
| **Form filling** | Playwright against `packages/fixtures` in CI (headless). Never against live employer forms in CI. **Not built:** recorded real-ATS HTML snapshots (PII-scrubbed) as regression fixtures for mapping/classification — see docs/07 § Testing. |
| **Redlines** | A dedicated suite asserting no redlined field is ever written, across every fixture form. Release gate. |
| **Submit gate** | An ESLint rule, a CI source scan, and a test that drives the CI scanner's own `scanSource` — all three over the whole of `apps/server/src` rather than `filling/` alone, because the browser session is reachable from a route handler and scoping to the filling module left the routes covered by nothing. They look for a submit-shaped click and the other routes to submission. Behind all three, a fixture assertion that the mock ATS recorded zero POSTs across the suite. Release gate. There is no runtime guard — docs/07 § The submit gate (G4) is the authority on which layers exist and where they still differ. |
| **API contracts** | Shared Zod schemas mean a contract break is a typecheck failure. Integration tests cover each server-side invariant in doc 09. |
| **E2E** | **Not built:** one full happy path against the fixture site — upload → confirm → discover (mocked) → match → approve → draft → review → fill → pre-submit, stopping short of submission by design. Every stage is covered on its own, and nothing yet runs them in sequence, so a break in the handoff between two of them is exactly the bug this suite would catch and the current tests would not. |

## Risks

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| ATS DOM changes break filling | High | Medium | Semantic `FormMap` over brittle selectors; generic adapter as fallback; read-back verification means silent wrong-fills surface as errors. The recorded snapshots that would catch drift before a user hits it are **not built** — until they are, the first thing that notices a real ATS changing its markup is a failed run. |
| Workday complexity | High | Medium | Explicitly last in M6; ship the other four adapters first; degrade to "we mapped the form, here's what to paste" rather than a broken fill. |
| Source API changes / rate limits | Medium | Medium | Many independent sources; per-source health and degradation; a 6-hour response cache. **Not built:** the weekly drift check — CI runs on push and pull request only, with no `schedule` trigger. |
| Requirement extraction gets eligibility wrong | Medium | **High** | Tri-state with `unknown`; quote verification; the inspectable filtered drawer; the synthetic per-rule scenarios and property tests in `eligibility.test.ts`. A false `ineligible` is the worst bug this app can have. |
| FactGuard misses a fabrication | Low | **High** | Deterministic checks on numbers, dates, names and skills; adversarial release-gate suite; the human review gate as the last line — which, with the model pass unwired, is the only thing behind a semantic overstatement. |
| Generated text still reads as machine-written | Medium | Low | StyleCritic + tell-scrub + the edit-distance nudge. Ultimately the user edits; the tool's job is a good first draft, not a final one. |
| LLM cost surprises the user | Medium | Low | A live cost panel, read from the `llm_call` ledger rather than estimated. **The other three mitigations are not built:** nothing sends a cache breakpoint, no call requests Haiku (the model is mapped but no caller asks for that purpose), and there is no spending cap. |
| Local PII exposure | Low | High | Field encryption, keychain, restrictive ACLs, redacted logs, pre-commit hook, export/delete. |
| User over-applies to poor fits | Medium | Low | Rationale states the likely rejection reason; effort estimates; per-application friction is deliberate. |

## Decisions (locked 2026-08-03)

| Question | Decision | Consequence |
| --- | --- | --- |
| Build order | **M0 only, then reassess** | Skeleton is built; M1+ starts on explicit go-ahead. |
| Submit behavior | **G4 as designed — the user clicks Submit in the browser** | No auto-submit path exists anywhere in the codebase. Enforced by an ESLint rule, a CI source scan, a test driving that same scanner over the server tree, and a zero-POST fixture assertion — the last of which is the only one that checks the outcome rather than the source text. |
| Age | **18 or older** | Guardian mode is **deferred out of v1**. DOB is still collected (18+ requirements are common) and still encrypted; the minor-specific handling in doc 10 is not built. |
| Market | **United States only** | Sources: USAJOBS, Adzuna-US, US ATS boards. Work-authorization rules built for US visa/sponsorship status and citizenship requirements. UK/EU adapters deferred. |

## Still open

1. **Target term.** Summer 2026 is past as of August 2026; the default term filter is
   assumed to be **Summer 2027** unless told otherwise. Trivially changed in settings.
2. **Field / role family.** Assumed to be derived from the resume, with the query plan
   editable by the user before each run. No hardcoded taxonomy needed up front.
3. **Model access (CLI or API key).** Needed from M1 onward — but not necessarily a key. The
   default backend is `auto` (see docs/14): the Claude Code CLI if it is installed, otherwise
   an Anthropic API key, otherwise no model at all. A user on the CLI needs no key. The design
   assumes `claude-opus-5` for extraction and drafting, with `claude-haiku-4-5` for bulk field
   classification. FactGuard's determinations are made without a model in the shipping path
   (its model layer is not wired into any production path — see the M5 note above). M0 does
   not call any model at all.

## Deferred (explicitly not v1)

Resume tailoring per posting · referral/network detection · interview scheduling ·
multi-user support · mobile UI · Electron/Tauri packaging · browser-extension companion ·
automatic follow-up email sending (drafts only, always).
