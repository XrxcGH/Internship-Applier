# 02 — Architecture

## Shape

A local-first app: one Node process serving a local API + a browser-based UI, driving a
Playwright-controlled browser window. Nothing is hosted; there is no multi-tenant server.

```
┌─────────────────────────────────────────────────────────────────────┐
│  Browser tab · http://127.0.0.1:5173                                │
│  React + TypeScript UI                                              │
│    Onboarding · Discover · Matches · Application workspace · Tracker│
└───────────────┬─────────────────────────────────────────────────────┘
                │ REST (JSON) + SSE (progress/events)
┌───────────────▼─────────────────────────────────────────────────────┐
│  Node process · Fastify @ 127.0.0.1:8787                            │
│                                                                     │
│  ┌───────────┐ ┌───────────┐ ┌──────────┐ ┌──────────┐ ┌─────────┐  │
│  │ Ingestion │ │ Discovery │ │ Matching │ │ Writing  │ │ Filling │  │
│  │  resume→  │ │  sources→ │ │ rules +  │ │ voice +  │ │ adapters│  │
│  │  profile  │ │  postings │ │ scoring  │ │ factguard│ │ + forms │  │
│  └─────┬─────┘ └─────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬────┘  │
│        └─────────────┴────────────┴────────────┴───────────┘        │
│                              │                                      │
│        ┌─────────────────────┼──────────────────────┐               │
│        ▼                     ▼                      ▼               │
│  ┌───────────┐        ┌────────────┐         ┌────────────┐         │
│  │ Run log   │        │  SQLite    │         │ LLM client │         │
│  │ (`task`   │        │  (Drizzle) │         │ (Anthropic)│         │
│  │  table —  │        │  app.db    │         │ opus/haiku │         │
│  │  finished │        └────────────┘         └────────────┘         │
│  │ summaries)│                                                      │
│  └───────────┘                                                      │
└───────────────┬─────────────────────────────────────────────────────┘
                │ CDP
┌───────────────▼─────────────────────────────────────────────────────┐
│  Playwright Chromium — HEADED, visible to the user                   │
│  Persistent profile dir · per-site storage state · user logs in here │
└─────────────────────────────────────────────────────────────────────┘
```

## Stack and why

| Layer | Choice | Rationale |
| --- | --- | --- |
| Language | TypeScript (Node 24) | See [ADR-001](#adr-001--typescript-over-python) below. Short version: the riskiest module is Playwright form automation, where Node is the reference implementation; the frontend is TypeScript regardless, so TS-everywhere means one toolchain instead of two. |
| Backend | Fastify 5 | Small, fast, first-class TS types, native SSE via `reply.raw`, plugin model fits the module split. |
| DB | SQLite via `better-sqlite3` + Drizzle ORM | Single file, zero-ops, synchronous, good enough for one user. Drizzle gives typed queries + migrations without a heavy runtime. |
| Browser | Playwright (`playwright` npm) | Best-in-class selector engine, `getByLabel`/`getByRole` map directly onto form-field semantics, persistent contexts, tracing for debugging. |
| Frontend | React 19 + Vite + TypeScript | Fast dev loop; the UI is form- and list-heavy, which React handles well. |
| Styling | Tailwind 4, no component library | shadcn/ui and Radix were planned and not adopted: the interface turned out to need six components, all of them plain HTML controls, and a dependency that exists to supply a dialog and a combobox we never built is a dependency that only carries risk. |
| Data fetching | `fetch` in `lib/api.ts` | TanStack Query was planned and not adopted. The screens are few and each one owns a single `refresh()`; a cache layer would be more machinery than the thing it caches. |
| Client state | React `useState` in `App.tsx` | Zustand was planned and not adopted. The only genuinely global state is which view is open, which is one `useState`. |
| LLM | Anthropic TS SDK, `claude-opus-5` | Structured extraction, drafting, field classification. `claude-haiku-4-5` for high-volume cheap classification. |
| Validation | Zod | One schema per boundary: API bodies, LLM structured outputs, config. |
| Testing | Vitest + Playwright test | Unit/integration in Vitest; form-filling tested against a local fixture site. |
| Logging | Pino | Structured JSON to **stdout**, pretty in dev, with PII redaction applied at the logger. There is no file destination and no rotation — see docs/10 § Logging. |

### ADR-001 — TypeScript over Python

**Status:** accepted 2026-08-03. **Revisit if:** the maintainer is substantially more fluent
in Python than TypeScript.

Both platforms were evaluated with Python 3.14.6 and Node 24.16.0 available on the machine.
This was a close call (~60/40), and the reasoning is recorded here so it can be re-litigated
honestly rather than from memory.

**Where Python is genuinely better:**

- Stdlib `sqlite3` — no native build. Node's `better-sqlite3` needs prebuilt binaries and is
  a real (if usually painless) Windows risk. `@libsql/client` sidesteps this if it bites.
- `textstat` / `nltk` / `spaCy` for the `StyleProfile` metrics in doc 06.
- FastAPI + Pydantic auto-generates OpenAPI, from which TypeScript types can be generated —
  arguably a *better* single source of truth than Zod schemas imported by both sides.
- `numpy` for the embedding math in dedupe and skill matching.
- pytest + pandas make the extraction-quality and FactGuard eval harnesses (doc 11) nicer.

**Why TypeScript was chosen anyway:**

1. **The long pole is Playwright.** Form automation (M6) is the largest, riskiest module and
   the one most likely to overrun. Node is Playwright's reference implementation: features
   land there first, and nearly all community knowledge about ATS-specific breakage —
   Workday's shadow DOM, iframe traversal, React-controlled inputs that ignore
   programmatic value assignment — is written in JS. Optimizing the language choice around
   the highest-risk module is the right trade.
2. **Python's classic advantage for this domain is already designed out.** The usual reason
   to pick Python for a resume tool is PDF extraction and NLP. The design routes PDFs
   directly to Claude's native document support (doc 02 § Notable stack decisions), which
   handles scanned documents better than an OCR pipeline. And the `StyleProfile` metrics are
   sentence segmentation plus counting — Node's built-in `Intl.Segmenter` covers the hard
   part in well under 200 lines.
3. **The frontend is TypeScript either way.** So the real question is one toolchain or two.
   For a solo, single-user, locally-run app, a second dependency tree, linter, test runner,
   and upgrade treadmill is a permanent tax that the Python-side wins don't cover.

**Rejected as non-reasons:** "Python isn't installed" (it is, as of 2026-08-03) and "shared
Zod types" (OpenAPI codegen from Pydantic is an equally good single source of truth).

**Minor tax on the Python side, noted for completeness:** Python 3.14 is recent enough that
Windows wheels for some C extensions can still lag.

### Notable stack decisions

**Resume parsing goes through Claude's native PDF support, not a PDF library.** The
`document` content block accepts base64 PDF directly, so the primary ingestion path is
`PDF bytes → Claude → structured JSON` with no `pdfjs`/OCR dependency and no layout-mangling.
Local text extraction (`mammoth` for DOCX, plain read for TXT/MD) exists as the fallback for
non-PDF formats and as a cheap re-run path when the raw text is already cached. Scanned
PDFs work because Claude reads them as images.

**No Redis, no external queue — and no internal one either.** This was planned as a `task`
table plus an in-process async worker pool, and neither the pool nor the worker loop was ever
built. § Concurrency below describes what actually runs: long work happens inside the request
that asked for it, and the `task` table holds finished discovery-run summaries so
`GET /api/discovery/runs/:id` can answer afterwards. Adding a broker would have been the
single biggest ops cost for no benefit at this scale; the worker loop turned out to be
unnecessary as well.

**Headed browser by default.** The user should see the form being filled. Headless mode
exists only for the test fixture site.

**`undici` is a direct dependency even though Node bundles a copy.** The outbound address
guard has to run at the moment the socket is opened, or a name whose DNS the attacker controls
can answer a public address to the check and a private one to the connection (doc 10 § Data in
transit). That means supplying the connector, which means a dispatcher — and Node does not
expose the undici it ships. The two are not interchangeable either: an `Agent` from the npm
package handed to `globalThis.fetch` is rejected outright with `invalid onRequestStart method`,
because the versions do not share a dispatcher contract. So `fetch` and `Agent` are imported
from the same copy, and `infra/http/fetcher.ts` is the only file that imports either.

## Processes and lifecycle

One command starts everything:

```bash
npm run dev
```

- `apps/server` — Fastify on `127.0.0.1:8787`, bound to loopback only. Owns the DB and the
  Playwright browser.
- `apps/web` — Vite dev server on `127.0.0.1:5173`, proxying `/api` to the server.
- Playwright browser launches lazily on the first fill request and persists for the session.

In production packaging (M8), `apps/web` is built to static files served by Fastify, and the
whole thing ships as a single `npx internship-applier` command that opens the browser to
the local UI. Electron/Tauri wrapping is deliberately deferred — it adds a build pipeline
and a code-signing problem for a UI that works fine in a browser tab.

## Module layout

```
internship-applier/
├─ apps/
│  ├─ server/
│  │  └─ src/
│  │     ├─ index.ts                 # Fastify bootstrap, loopback listener
│  │     ├─ app.ts                   # route registration, loopback + token guard
│  │     ├─ routes/                  # thin HTTP layer, Zod-validated → calls core/
│  │     │  ├─ health.ts  profile.ts  resumes.ts  discovery.ts  matches.ts
│  │     │  ├─ writing.ts  answers.ts  filling.ts  tracker.ts  privacy.ts
│  │     │  └─ events.ts             # SSE
│  │     ├─ core/
│  │     │  ├─ ingestion/            # resume → CandidateProfile
│  │     │  │  ├─ extractText.ts     # DOCX/TXT/MD; PDF passes through as bytes
│  │     │  │  ├─ extractProfile.ts  # Claude structured output
│  │     │  │  ├─ toProfile.ts       # extraction → draft profile + needsReview
│  │     │  │  └─ deriveFields.ts    # age, academic level, YOE, seniority band
│  │     │  ├─ profile/repository.ts # field-encrypted persistence, gate G1
│  │     │  ├─ discovery/
│  │     │  │  ├─ sources/           # ats.ts, aggregators.ts, types.ts (doc 04)
│  │     │  │  ├─ queryPlanner.ts    # profile → search targets
│  │     │  │  ├─ resolveCompany.ts  # company name → board slug, by probing
│  │     │  │  ├─ manualPosting.ts   # paste-a-URL (fetched) and paste-the-text (never is)
│  │     │  │  ├─ sourcingPolicy.ts  # the hosts nothing in this app opens (doc 10)
│  │     │  │  ├─ normalize.ts       # source payload → JobPosting
│  │     │  │  ├─ dedupe.ts          # URL → fingerprint → title-token match
│  │     │  │  ├─ refresh.ts         # re-check open/closed, deadlines
│  │     │  │  └─ run.ts             # orchestration + per-source reporting
│  │     │  ├─ matching/
│  │     │  │  ├─ extractRequirements.ts  # JD text → structured requirements
│  │     │  │  ├─ quoteGuard.ts      # every requirement must quote the JD
│  │     │  │  ├─ requirementValues.ts    # per-kind value validation
│  │     │  │  ├─ eligibility.ts     # hard rules — pure, deterministic, tested
│  │     │  │  ├─ score.ts           # soft fit scoring + breakdown
│  │     │  │  ├─ rationale.ts       # short natural-language explanation
│  │     │  │  └─ run.ts             # per-posting evaluation, cached extraction
│  │     │  ├─ writing/
│  │     │  │  ├─ styleProfile.ts    # writing samples → measured StyleProfile
│  │     │  │  ├─ answerLibrary.ts   # reusable canonical answers
│  │     │  │  ├─ retrieve.ts        # profile → the evidence set for a question
│  │     │  │  ├─ draft.ts           # generate answer from question + profile
│  │     │  │  ├─ factGuard.ts       # claim → profile evidence, or flag
│  │     │  │  ├─ tellScrub.ts       # machine-sounding phrasing
│  │     │  │  └─ styleCritic.ts     # measure draft vs StyleProfile → flags only
│  │     │  ├─ filling/
│  │     │  │  ├─ browser.ts         # Playwright lifecycle, persistent context
│  │     │  │  ├─ formMap.ts         # DOM → FormField[] semantic map
│  │     │  │  ├─ selectors.ts       # the one fillable-control selector
│  │     │  │  ├─ classify.ts        # deterministic matcher → LLM fallback
│  │     │  │  ├─ plan.ts            # FormMap + profile + answers → FillPlan
│  │     │  │  ├─ fill.ts            # typing, selects, uploads, read-back
│  │     │  │  ├─ redlines.ts        # fields that must never be auto-filled
│  │     │  │  └─ run.ts             # one fill run, up to gate G4
│  │     │  ├─ tracking/             # status transitions, reminders, stats, CSV
│  │     │  └─ privacy/              # export everything, delete everything, costs
│  │     ├─ infra/
│  │     │  ├─ db/                   # drizzle schema, migrations, client
│  │     │  ├─ llm/                  # provider seam: claude_cli | api | none
│  │     │  ├─ http/                 # fetch wrapper: rate limit, cache, backoff
│  │     │  ├─ crypto/               # AES-GCM field encryption, keychain
│  │     │  ├─ events.ts             # in-proc event bus → SSE
│  │     │  └─ logger.ts             # pino + PII redaction
│  │     └─ config.ts                # env + settings, Zod-validated
│  └─ web/
│     └─ src/                        # see doc 08
├─ packages/
│  ├─ shared/                        # Zod schemas + TS types used by both apps
│  └─ fixtures/                      # local mock application site for tests
├─ docs/
└─ data/                             # gitignored: app.db, resumes/, artifacts/,
                                     #   browser-profile/, scratch/ — doc 10 § Data at rest
```

## Data flow: one application, end to end

1. **Ingest.** User uploads `resume.pdf`. Stored under `data/resumes/`. `extractProfile`
   sends it to Claude with a strict JSON schema → draft `CandidateProfile`.
2. **G1 · Confirm.** UI shows the extracted profile in an editable form. User corrects it,
   adds DOB, work authorization, availability window, location preferences. Saved as
   confirmed.
3. **Discover.** `queryPlanner` turns the profile into source queries. `runDiscovery` fans
   out over four concurrent targets, normalizes results into `job_posting`, dedupes. The
   fan-out lives inside the request that asked for it — this said "worker", which is the one
   word § Notable stack decisions spends a paragraph saying was never built.
4. **Match.** For each new posting: `requirements` extracts structured requirements from the
   JD; `eligibility` runs hard rules (pure functions); survivors get a `score` with a
   per-dimension breakdown and a `rationale`.
5. **G2 · Approve.** Matches land in the review queue. User approves, skips, or rejects with
   a reason. The reason and its tags are stored on the `decision` row and **nothing reads
   them**: `score.ts` never sees a decision, and no query in the server joins that table.
   This step used to say they "feed preference learning", which is a promise that ranking
   improves as you triage — so a user giving honest reject reasons was paying a real cost
   into a mechanism that does not exist.
6. **Draft.** Approving creates an application and nothing else — it opens no browser, drafts
   nothing and submits nothing (docs/08 § Queue). Questions are added by the user or read off
   the `FormMap` a fill run builds, and each answer is drafted on request, one call per
   answer: retrieve relevant profile facts → generate in the user's `StyleProfile` →
   `factGuard` verifies → `tellScrub` flags machine register, and between them those two get
   one revision pass. `styleCritic` is **not** in that chain and revises nothing: it runs
   later, in `routes/answers.ts`, and every drift it measures becomes a flag the user reads
   at G3 (docs/06 § ⑤). Written the old way round, the pipeline read as though something
   rewrote the draft toward the voice target before anyone saw it.
7. **G3 · Review.** Answer workspace shows each question, the draft, the supporting profile
   evidence, and any unsupported-claim flags. User edits and approves each one.
8. **Fill.** The visible browser fills the form field by field. Redlined fields
   (SSN/ID/attestations/EEO/consent) are skipped and listed for the user.
9. **G4 · Submit.** The pre-submit review lists every field the tool filled, every field it
   refused, and every read-back that did not match, and then the user clicks Submit in the
   browser themselves. The tool records the submission afterwards, when the user says so.
   (No screenshot is captured; `application.screenshot_path` exists in the schema and is
   never written. See docs/07 § G4.)
10. **Track.** Application moves through the tracker, every transition entered by the user
    and checked against the status model. Deadline and follow-up reminders surface as drafts
    only — `GET /api/applications/:id/draft-message` returns text and nothing sends it.
    **Not built:** the read-only email ingestion this step listed as optional. No IMAP or
    Gmail client exists in `apps/` or `packages/`, so no status ever updates itself, and a
    reader who took this literally would have been waiting for a mailbox to move a card that
    only they can move.

## Concurrency and rate limiting

- Discovery runs a bounded worker pool, default 4 concurrent targets (`runDiscovery`).
  There is no general task queue: `infra/queue/` was planned and never built, and the
  `task` table is used to persist run summaries rather than to schedule work.
- Per-domain token bucket in `infra/http` — default 1 request/sec/domain, honors
  `Retry-After`, exponential backoff with jitter on 429/5xx.
- Response cache keyed by URL + ETag, 6h default TTL, so re-running discovery is cheap.
- Identifiable User-Agent. `robots.txt` respected for any generic page fetch (source APIs
  are exempt as documented API surfaces).
- LLM calls: `claude-opus-5` for extraction and drafting. `claude-haiku-4-5` runs the
  web-search discovery source, where the judgement is "which URLs" and the facts come from
  this process fetching the pages itself.

  Rationale is NOT among them, though this line listed it: `core/matching/rationale.ts`
  imports only types and composes its sentences in TypeScript, and docs/05 says so outright
  — "There is no prompt and no model call." A reader auditing what this tool sends anywhere
  would have counted one call too many, in the document that exists to be that audit.

  **Not built:** prompt caching. No call anywhere sends a cache breakpoint. The paragraph
  this replaces also had the contents wrong: drafting never sends the confirmed profile at
  all, only the specific evidence retrieved for the question being answered (docs/06 § ③),
  so the profile was never the repeated context it described.

## Failure posture

| Failure | Behavior |
| --- | --- |
| Source API down | That source is marked degraded for the run; others continue; UI shows which sources ran. |
| Resume extraction low-confidence | Profile fields marked `needs_review`; G1 cannot be completed until they're touched. |
| Requirement text unparseable | Posting surfaces with `eligibility: unknown` and the raw text quoted — never silently filtered out. |
| Form field unclassifiable | Left blank and listed in the pre-submit review, with its label and why it was skipped. (No screenshot crop — see § G4 above.) |
| Login wall hit | Browser pauses, UI says "log in in the open window, then Continue." Tool never types credentials. |
| LLM refusal / error | Surfaced verbatim to the user for that step; no silent retry loop, no fabricated fallback. |
