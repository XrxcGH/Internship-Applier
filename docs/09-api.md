# 09 — API

Fastify, bound to `127.0.0.1` only. JSON over REST, plus one SSE stream. Request bodies are
validated with Zod schemas from `packages/shared`, so the frontend and backend can't drift.

**This document was rewritten against the routes that exist.** It previously described three
endpoint groups that were never built and a dozen paths under names they do not have. Every
row below was read out of `apps/server/src/routes`; anything unbuilt is marked as such
rather than listed as if it worked.

That rewrite fixed the routes that were listed and did not check for the ones that were not,
which is the other half of the same claim. `routes/tracker.ts` was missing entirely except
for its status endpoint, `POST /api/discovery/paste` was missing while the URL path beside it
was documented — and that pair is the one that decides whether a LinkedIn posting can be used
at all — and `POST /api/profile/blank`, added later, was the only way past G1 on a machine
with no model and appeared nowhere. All are below. A document that says it lists every route
is read as a closed list, so an omission here is a stronger error than a wrong description.

**Auth:** none — loopback-only, single user, single machine. A random per-run token is
required in an `X-App-Token` header on every `/api/*` route except `/api/health` and
`/api/session`. The frontend fetches it from `GET /api/session` (`apps/web/src/lib/session.ts`),
not from Vite or the served `index.html`. What that token is and is not worth is set out
honestly in docs/10 § Data in transit: it stops a stray page in another tab, and it does not
stop a local process, which could read `data/app.db` directly anyway.

Errors use a consistent envelope:

```jsonc
{ "error": { "code": "PROFILE_NOT_CONFIRMED", "message": "…", "details": {} } }
```

## Session & health

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Liveness, runtime version, uptime, table count, profile state. No token needed. |
| `GET` | `/api/session` | Hands the UI its `X-App-Token`. No token needed, by necessity. |

## Profile & documents

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/profile` | Current profile including `derived` and `needsReview`. |
| `PUT` | `/api/profile` | Update fields. Recomputes `derived`. Does **not** confirm. |
| `POST` | `/api/profile/confirm` | **G1.** Rejects with `PROFILE_INCOMPLETE` while `needsReview` is non-empty. Sets `confirmedAt`. |
| `POST` | `/api/profile/reviewed/:path` | Clears one `needsReview` entry the wizard has no dedicated control for. |
| `POST` | `/api/resumes` | Multipart upload. Returns `{ documentId, filename, mime, sha256 }`. Extraction is a separate call, not a task. |
| `GET` | `/api/resumes` | List documents. |
| `POST` | `/api/resumes/:id/extract` | Read the document into a draft profile. Returns `{ profile, needsReview }`. |
| `POST` | `/api/profile/blank` | A draft profile with nothing in it, for a machine with no model. Same `{ profile, needsReview }` envelope as the extract route above, built from the same `toDraftProfile`, so every unset field arrives flagged. Stores nothing; the client sends it back through `PUT /api/profile`. |
| `POST` | `/api/resumes/:id/primary` | Set the default resume for applications. |
| `DELETE` | `/api/resumes/:id` | Delete the row and the file, and promote the newest remaining resume if this was the primary. |

## Writing voice

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` `POST` | `/api/writing-samples` | List and add samples. |
| `DELETE` | `/api/writing-samples/:id` | Remove one. |
| `POST` | `/api/style-profile/compute` | Recompute `StyleProfile` from the current samples. |
| `GET` | `/api/style-profile` | Metrics plus the plain-language summary shown in the UI. |
| `GET` | `/api/answer-library` | The reusable answer library. |
| `DELETE` | `/api/answer-library/:id` | Remove a canonical answer. |

> **Not built:** `PUT /api/answer-templates/:id` and `POST /api/answer-templates/:id/approve`.
> The library is read and delete only; entries are added by approving an answer at G3.

## Discovery

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/sources` | Configured sources with health and last run. |
| `GET` | `/api/sources/available` | Every adapter the server knows, and whether it has a key. |
| `PUT` | `/api/sources/:id` | Enable, disable, or reconfigure one. |
| `POST` | `/api/discovery/plan` | Returns the planned targets for review. Runs nothing. |
| `POST` | `/api/discovery/run` | Runs the plan. Progress via SSE; the summary is returned when it finishes. |
| `GET` | `/api/discovery/runs` | Recent run summaries. |
| `GET` | `/api/discovery/runs/:id` | One summary: per-source counts, errors, skips, duplicates. |
`GET /api/discovery/stats` — `{ total, open }`: every stored posting, and how many are still open. Nothing is grouped by source and nothing reports freshness.
| `GET` | `/api/postings` | The raw posting table, for inspection. |
| `POST` | `/api/discovery/manual` | Body: `{ url }`. The paste-a-URL path — fetch, normalize, store one posting. Answers 400 `SOURCE_REFUSED` for a host on the sourcing-policy list, before any request goes out. |
| `POST` | `/api/discovery/paste` | Body: `{ text, title, company, url, readOn? }`, every field required and `text` at least 40 characters. The paste-**the-text** path, and the only one that takes a LinkedIn, Indeed, Glassdoor or Handshake posting: the user read it themselves, the URL is stored as the dedupe key and never fetched. No network on this path at all, so it has no 502 branch. |
`POST /api/companies/resolve` — probes six vendors per slug candidate (Greenhouse, Lever, Ashby, SmartRecruiters, Workable by GET, Workday by a bounded POST), across up to three candidates. docs/04 § Company target list states the request bound.
| `POST` | `/api/discovery/refresh` | Re-check open/closed and deadlines across the table. |
| `POST` | `/api/postings/:id/refresh` | The same, for one posting. |

## Matching

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/matches` | Filterable list with posting summary, score, breakdown and badges. |
| `GET` | `/api/matches/:id` | Full detail: posting, requirement checklist with quotes, blockers, breakdown, rationale. |
| `POST` | `/api/matches/:id/decision` | Body: `{ action: 'approved'\|'skipped'\|'rejected'\|'saved', reason?, reasonTags? }`. `approved` creates an `application` and returns its id — it does **not** submit anything. |
| `POST` | `/api/matches/recompute` | Re-run matching after a profile change. |

## Applications & answers

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/applications` | List with answer and blocked counts. |
| `GET` | `/api/applications/:id` | Detail: status, answers with evidence and flags, model access. |
| `POST` | `/api/applications/:id/questions` | Add a question to answer. (There is no form-analysis endpoint; questions are entered or come from the fill run's form map.) |
| `POST` | `/api/answers/:id/draft` | Draft one answer. Redrafting is the same call. |
| `PATCH` | `/api/answers/:id` | Update the text; recomputes edit distance and re-runs FactGuard. |
| `POST` | `/api/answers/:id/approve` | **G3.** Rejects with `UNVERIFIED_CLAIMS` while a blocking flag remains, and with `PROFILE_INCOMPLETE` if there is no confirmed profile to check against. |
| `POST` | `/api/answers/:id/unapprove` | Withdraw approval. |
| `DELETE` | `/api/answers/:id` | Remove a question and its answer. |
| `GET` | `/api/model-access` | Which backend is available and what it can do. |
| `POST` | `/api/model-access/test` | Round-trip the backend. Answers 200 with `ok: false` on failure, so the detail survives. |

> **Renamed since this doc was first written**, listed so old references resolve:
> `/api/applications/:id/analyze` → `/api/applications/:id/questions`;
> `/api/applications/:id/answers/draft` → per-answer `/api/answers/:id/draft`;
> `PUT /api/answers/:id` → `PATCH`; `/api/answers/:id/regenerate` → the same `/draft` call;
> `/api/cost` → `/api/costs`; `/api/answer-templates` → `/api/answer-library`.

## Filling & submission

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/applications/:id/fill` | Rejects with `PROFILE_INCOMPLETE` without a confirmed profile, and `ANSWERS_NOT_APPROVED` if any answer lacks `approvedAt`. Streams steps over SSE. Answers **409** `FILL_BROWSER_BUSY` while a different application has the browser open, and `FILL_IN_PROGRESS` while this one is already opening. |
| `GET` | `/api/applications/:id/fill` | The current run: filled fields, read-backs, skips, and why. |
| `POST` | `/api/applications/:id/fill/continue` | Resume after a pause (login wall, needs-input). Answers **409** `FILL_IN_PROGRESS` while a call is already driving the page — one caller at a time, claimed before the first await rather than from the run's state, which lags several seconds behind. |
| `DELETE` | `/api/applications/:id/fill` | Abandon the run and close the browser. |
| `POST` | `/api/applications/:id/mark-submitted` | **G4.** Records that the user submitted it. Requires `{ confirmed: true }` — rejects with `CONFIRMATION_REQUIRED` without it, and `ILLEGAL_TRANSITION` from a status the model does not allow `submitted` to follow. |
| `POST` | `/api/applications/:id/status` | Manual status transition with an optional note. |

There is deliberately **no** `POST /api/applications/:id/submit`. The server has no code
path that clicks a submit control; docs/07 § G4 sets out how that is enforced.

One correction to what this section used to say. `mark-submitted` is **not** the only writer
of `submitted_at` — `/status` also writes it when the user moves an application to
`submitted`. Both are user-initiated, so G4 holds, but "the only endpoint" was false, and the
same false claim sat in the schema comment.

The `{ confirmed: true }` body is real and enforced. It was declared in the shared schema
and read by nothing for a while, which made the one machine-checkable half of G4 decorative:
any bare POST — a double-click, a retry after a dropped connection, a client firing on the
wrong row — stamped an application submitted. The route now parses the body and applies the
same transition check the status route does.

> **Not built:** a `dryRun` flag on `/fill`, and `GET /api/applications/:id/presubmit`.
> The pre-submit review is served by `GET /api/applications/:id/fill`.

## Tracker

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/tracker` | Everything the board, the table and the nudges read: each application with its `derived` state, the reminders due, and the outcome stats. |
| `GET` | `/api/applications/:id/draft-message` | `?kind=follow_up` (default) or `withdrawal`. Returns `{ kind, text, note }`. It is a **draft**: nothing in this app has mail credentials and nothing sends email. |
| `GET` | `/api/tracker/export.csv` | The whole tracker as CSV, `content-disposition: attachment`. Values that would become a spreadsheet formula are neutralised (docs/11 § M7). |

`POST /api/applications/:id/status` is the fourth route in `routes/tracker.ts` and is listed
under § Filling & submission above, beside `mark-submitted`, because those two are the pair
that can write `submitted_at`. Two refusals worth stating where the tracker is documented:
it answers 409 `ILLEGAL_TRANSITION` for any move the status model does not allow a user to
make, and 409 `ANSWERS_NOT_APPROVED` for a move that newly claims `filled` or
`awaiting_submit` while any answer lacks `approvedAt` — gate G3 holds on this column too,
because the board and the CSV export are what the user keeps as their record.

## Cost & privacy

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/costs` | Token and spend rollups by purpose, read from the `llm_call` ledger. |
| `GET` | `/api/privacy/export` | Full JSON export of everything stored, decrypted. |
| `GET` | `/api/privacy/delete-preview` | What would be destroyed, with real counts. |
| `POST` | `/api/privacy/delete-all` | Requires `{ confirm: 'delete everything' }`. Wipes every table, the files, the browser profile, and the key. |

> **Not built:** the whole Settings group (`GET`/`PUT /api/settings`,
> `POST /api/settings/keys`), the Browser-session group (`/api/browser/*`), and the Tasks
> group (`/api/tasks*`). Settings are environment variables; browser sessions live in the
> Playwright profile directory; discovery reports its own progress rather than exposing a
> task queue.

## Events (SSE)

`GET /api/events` — one long-lived stream, `text/event-stream`.

```ts
type AppEvent =                                                              // publisher?
  | { type: 'extraction.progress'; documentId: string; stage: string; pct: number }      // none
  | { type: 'discovery.progress'; runId: string; source: string; found: number; new: number | null }
  | { type: 'discovery.source_failed'; runId: string; source: string; error: string }
  | { type: 'discovery.done'; runId: string;
      summary: { sources: number; found: number; new: number; duplicates: number;
                 errors: number; skipped: string[] } }
  | { type: 'match.new'; matchId: string; score: number }                                // none
  | { type: 'draft.progress'; applicationId: string; questionId: string; stage: string }
  | { type: 'fill.step'; applicationId: string; field: string; status: 'ok'|'mismatch'|'skipped'|'failed'; note?: string }
  | { type: 'fill.needs_input'; applicationId: string; reason: 'login'|'captcha'; detail: string }
  | { type: 'fill.done'; applicationId: string; filled: number; mismatched: number; failed: number; skipped: number }
  | { type: 'task.failed'; taskId: string; kind: string; error: string };                // none
```

Three of those members have **no publisher at all** — `extraction.progress`, `match.new` and
`task.failed` are declared and nothing ever sends them; `packages/shared/src/events.ts` marks
each one. Two more details the shape above now states rather than glosses: `discovery.progress`
carries `new: number | null`, and null is the only value the runner currently sends, because
how many are new is not known until every source has been fetched — zero has to keep meaning
zero. And `discovery.done`'s `summary` is its own small object, **not** the `RunSummary` the
`/runs` endpoints return, so a consumer reading `summary.bySource` or `summary.closed` off the
stream gets `undefined`; the run summary proper comes back in the POST response.

`fill.needs_input` has exactly two reasons. `unknown_field` was removed from the schema
outright — `packages/shared/test/events.test.ts` asserts the schema rejects it — because the
screen that renders these treats "not login" as "bot check", so a third reason would have told
the user to solve a challenge that is not on the page.

Each event carries a monotonic `seq`, and a heartbeat comment goes out every 20s to keep the
connection alive. The stream is served and the events are published; **the frontend does not
consume it yet** — there is no `EventSource` anywhere in `apps/web/src`, and each screen
refetches instead. Reconnect-and-replay from `Last-Event-ID` is therefore untested.

`fill.needs_input` never carries `reason: 'unknown_field'`. `detectIntervention` is the only
thing that builds an intervention and it returns `login`, `captcha` or nothing at all — a
field the classifier cannot place is skipped and listed in the pre-submit review, which is
not a reason to stop and hand the browser back. It matters because the review screen treats
every reason that is not `login` as a bot check, so a run halted on `unknown_field` would
tell the user to solve a challenge that is not on the page.

## Server-side invariants

Enforced in the route layer, above the core modules:

1. `/api/discovery/*` and `/api/matches/*` reject with `PROFILE_NOT_CONFIRMED` while
   `confirmedAt` is null, via an `onRequest` hook on each of those two route modules.
   **This is narrower than it used to claim.** There is no blanket guard: `writing.ts`,
   `tracker.ts` and `privacy.ts` have none, and the fill and approve routes enforce the same
   idea themselves with a different code (`PROFILE_INCOMPLETE`). Those two are the ones
   where an unconfirmed profile would produce wrong output rather than an empty screen.
2. `/fill` rejects unless every answer for the application has `approvedAt`.
3. `/answers/:id/approve` rejects while an unresolved `unsupported` or `overstated` flag
   exists, and refuses outright when there is no confirmed profile to check against — a
   check that cannot run is not a check that passed.
4. `submitted_at` is written only by a user action: `mark-submitted` or a `/status`
   transition to `submitted`. No fill or drafting path can write it.
5. `/api/applications/:id/status` rejects a transition into `filled` or `awaiting_submit`
   while any answer for that application lacks `approvedAt`. This is invariant 2 again on a
   second surface, and it was missing from this list along with the rest of the tracker
   module: `/fill` is where G3 stops anything reaching an employer, but the status column is
   what the board and the CSV export report, and `answers_ready → filled → awaiting_submit`
   is a legal walk for a user. Only a transition that newly claims one of those two is
   checked — re-recording a status a row already holds claims nothing new.
6. Decrypted 🔒 fields are returned on the profile route, the export route, and as
   `readBack` on the fill-run routes. **The last of those used to be left out**, which made
   this read as a stronger promise than the code keeps: `serializeRun` puts the value read
   off the page into every field result, so `GET /api/applications/:id/fill` and both POST
   variants return the decrypted name, email, phone and address. That is not a leak — same
   local user, loopback-only, the same values the profile route already returns — and it is
   the point of read-back verification, which is worthless if the value read back does not
   come back. Date of birth is never included in a fill plan, whatever a form field is
   classified as.
