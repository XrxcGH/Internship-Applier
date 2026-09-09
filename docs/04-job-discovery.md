# 04 — Job discovery

## Sourcing policy

Sources are tiered by legitimacy, and the tier determines whether we build an adapter.

**Tier A — official, documented APIs. Build adapters.** These exist to be consumed
programmatically; using them is what they're for.

| Source | Endpoint shape | Notes |
| --- | --- | --- |
| Greenhouse Job Board | `boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true` | Public, no key. Huge coverage — most tech companies. |
| Lever Postings | `api.lever.co/v0/postings/{company}?mode=json` | Public, no key. |
| Ashby Job Board | `api.ashbyhq.com/posting-api/job-board/{name}` | Public. |
| Workday | POST to `{tenant}.{host}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs` | Public, no key. The board's own frontend speaks this exact API to render the careers page; boards are addressed as `tenant@host/site`. |
| SmartRecruiters | `api.smartrecruiters.com/v1/companies/{id}/postings?q={term}` | Public. Searched server-side; descriptions cost one detail request each. |
| Workable | `apply.workable.com/api/v1/widget/accounts/{id}?details=true` | Public. `details=true` is what puts the descriptions in the one response. |
| Recruitee / Teamtailor / Personio | per-vendor public board JSON | Smaller coverage, cheap to add. |
| USAJOBS | `data.usajobs.gov/api/search` | Free API key. Federal internships + Pathways. |
| Adzuna | `api.adzuna.com/v1/api/jobs/{country}/search` | Free tier key. Good aggregate coverage. |
| Arbeitnow | `www.arbeitnow.com/api/job-board-api` | Free, no key. The whole board, newest first, no server-side search. |
| Remotive | `remotive.com/api/remote-jobs` | Free, no key, remote-only. Not actually read — its robots.txt refuses us; see below. |
| RemoteOK / The Muse / Findwork | documented JSON endpoints | Free, remote-heavy. |
| SimplifyJobs Summer internship lists | public GitHub repo README/JSON | Community-maintained, well-structured, explicitly published for this. |

Twelve of those ship today: Greenhouse, Lever, Ashby, Workday, SmartRecruiters and
Workable in `sources/ats.ts`; Adzuna, USAJOBS, Arbeitnow, Remotive and the SimplifyJobs
list (`github_list`) in `sources/aggregators.ts`; and the model-driven web search
(`web_search`) in `sources/webSearch.ts` — Tier B below. The rest are in the table because
they qualify under this policy, not because an adapter exists — each is a small
self-contained addition when someone wants it.

**What each host says about being read.** "Documented" is not the same as "welcome", and
`robots.txt` is the most explicit machine-readable statement of intent a host publishes. All
five new endpoints were asked under the identifying agent string this tool sends, and they
answer differently. `www.arbeitnow.com`, `apply.workable.com` and the per-tenant
`*.myworkdayjobs.com` hosts allow the paths these adapters use; `remotive.com` carries
`Disallow: /api/*`, which covers its jobs endpoint; and `api.smartrecruiters.com` answers
`User-agent: *` / `Disallow: /`, its one `Allow: /v1/companies/` being scoped to LinkedInBot
alone. So the Remotive adapter asks robots.txt rather than opting out of it, is refused, and
reports the refusal as a coverage gap in plain words — a source the tool chose not to read
is a different thing from a source that searched and found nothing, and only one of them is
honest as "0 found".

**SmartRecruiters is now held to the same rule.** It used not to be: its adapter and the
resolver probe both went through `fetchJson`, whose `isDocumentedApi` default skips the
robots check, so two hosts published the same refusal and got opposite answers depending on
which default each adapter happened to inherit. Both now pass `isDocumentedApi: false`, so
the file decides. A refusal ends the whole source rather than each of its six searches in
turn — `robots.txt` answers for the origin, and reporting it per-search would print the same
no six times dressed as "these searches could not be read", which says the board broke when
it did not. The company probe files it under `unproven` instead of logging a failure, for the
same reason: being told not to look is not a vendor being unreachable.

The other four ATS hosts were asked under the agent string this tool sends and permit the
paths their adapters use — `boards-api.greenhouse.io` disallows only `/embed/`,
`api.lever.co` answers `Allow: /`, `apply.workable.com` an empty `Disallow:`, and
`api.ashbyhq.com` answers 401, which RFC 9309 § 2.3.1 and this codebase both read as
allow-all. Their `isDocumentedApi` is deliberately left alone rather than flipped on the
strength of one reading: for a host that permits, asking changes nothing today and quietly
makes four more sources fail closed if one of those files ever changes shape.

What it costs, stated plainly: SmartRecruiters is not in the keyless default plan — it is a
guessable vendor, so it only runs once a company is named or resolved — but on one real
installation 201 of 2,709 stored postings had come through it. That coverage is now gone,
and the run says so rather than showing a clean zero.

**Tier B — the live web, searched through the user's own model access. Built.** The
`web_search` source (`core/discovery/sources/webSearch.ts`) asks the model to search the web
for postings matching the plan's brief — on the CLI path through Claude Code's WebSearch
tool, on the API path through Anthropic's server-side web-search tool, so Anthropic's own
search infrastructure runs the queries and no search engine is scraped and no extra key is
needed. The model's answer is a list of **candidate URLs and nothing more**: every page it
names is then fetched by this process through `fetchManualPosting` — the same polite,
robots-respecting, JSON-LD-reading path a hand-pasted URL takes — so what gets stored is what
the employer's page says, never what the model claims. The prompt demands the employer's own
careers or ATS page; aggregator links that come back anyway are dropped and counted out loud
(`siftCandidates`). Each run reads a bounded sample of candidates and its report says so —
this tier samples what a search surfaces, it is not a complete sweep of anything.

It costs one model call per run, so nothing adds it silently: the query planner never plans
it, a `source` row left by a previous run never becomes a plan chip for it, and the only way
it enters a run is the Discover screen's button, whose label names the cost. The original
design here named a search-provider key (Brave or Google); that was never built and no longer
needs to be — `BRAVE_SEARCH_API_KEY` in `.env.example` is still read by nothing.

**Tier C — not scraped.** LinkedIn, Indeed, Glassdoor, Handshake, and similar sites whose
terms of service prohibit automated access, or whose listings sit behind authentication —
Handshake is both at once: every listing sits behind a student login and its terms prohibit
automated access. There is no adapter for these and none should be added. Instead:

**How a Tier C posting reaches the tool anyway**, in the order the user should expect
to need them:

1. **Tier B finds it.** This is the one that matters, and it is why Tier B exists. Almost
   every listing on those sites is a repost of a page this tool reads legitimately, so the
   web-search prompt turns an aggregator hit into a lead rather than a link: when a search
   result is a LinkedIn or Handshake listing, it names the employer and the role, and the
   model searches again for that employer's own posting and returns THAT. The student gets
   the job without the tool touching the site that refuses it.
2. **Paste a URL.** A single page the user is already looking at, fetched because they asked.
3. **Paste the text** (`POST /api/discovery/paste`, `readPastedPosting`). The fallback for a
   posting with no fetchable page at all — a Handshake listing behind the school login. The
   student copies the description out of the account they are entitled to read; the same
   parsers run over it, and the URL is stored as identity and as their way back but is never
   fetched. Storing an address is not visiting one.

What is deliberately NOT built, and will not be: signing in to any of those sites, storing a
credential for one, or driving a browser session against one. A stored login replaying itself
is precisely the automated access the terms forbid, and the account carrying the ban would be
the student's own — for Handshake that is their university careers office, not a website
signup. The cost of not doing it is small, because of 1.

## Company target list

Beyond query-driven search, the user can name companies they care about. `resolveCompany`
probes known ATS endpoints for a company slug:

```
acme → try boards-api.greenhouse.io/v1/boards/acme/jobs
     → try api.lever.co/v0/postings/acme
     → try api.ashbyhq.com/posting-api/job-board/acme
     → try api.smartrecruiters.com/v1/companies/acme/postings?limit=1
     → try apply.workable.com/api/v1/widget/accounts/acme
     → POST acme.{wd1,wd5}.myworkdayjobs.com/wday/cxs/acme/{acme,External,careers}/jobs
```

All six vendors are tried for one slug candidate before the next candidate is tried, and a
candidate that turns up a board with openings on it ends the search; whichever boards
answered come back sorted by how many jobs they hold. A board that answered with nothing
posted today is still returned, with a count of zero, because it answers the question that
was asked — which vendor this company uses — but it does **not** end the search, because a
slug some other company owns answers exactly the same way: `apply.workable.com` has a real,
empty account named "stripe" belonging to somebody other than the Stripe on Greenhouse, and
stopping there buried the hyphenated slug the caller was actually asking for. A 404 is the
ordinary "no board here" and passes without comment; anything else is logged, because a
timeout or a 503 means that vendor was never actually checked and an empty answer would
read as "this company has no board there".

SmartRecruiters is the one vendor that cannot be read this way. It answers 200 with
`totalFound: 0` for every company id there is, invented ones included, so a zero there is
not "a board with nothing posted" — it carries no information at all, and `Ubisoft` and
`McDonalds`, both real SmartRecruiters companies, answer it exactly as a made-up name does.
Only a count above zero is treated as a board. That loses a genuine SmartRecruiters board
in a quiet week, so the resolve returns a second list beside its matches — `notes` — saying
in the student's words that no SmartRecruiters board could be confirmed for this name.
Reading a 200 as proof was worse: it returned a SmartRecruiters board for *every* name
typed into Discover, including companies that do not exist, and an invented board is a fact
the student has no way to check.

The Workday probe is deliberately bounded, because it is the one vendor whose board
address cannot be enumerated: a board is (tenant, host, site), the site name is chosen
freely by the company, and Workday runs many `wdN` hosts — so an exhaustive probe does not
exist, and an unbounded one is a crawl wearing a resolver's name. Only the two hosts that
hold the bulk of tenants (`wd1`, `wd5`) and three site candidates (the slug itself,
`External`, `careers`) are tried — at most six POSTs per slug candidate, each asking the
cxs jobs endpoint for a single posting. That endpoint is the same query every visitor's
browser sends to render the company's own careers page, and a hit answers with the board's
true total. Three answers count as the ordinary "not Workday" and pass without comment: a
404, which is what a real tenant returns for every site name that is not the one it chose
and is therefore the commonest answer this probe gets; a 422 from the cxs service, since
the `wd1`/`wd5` wildcard DNS answers even for names with no tenant behind them; and a
tenant host that fails DNS outright, which also has its remaining site candidates skipped,
since no site can live on a host that is not there.
The worst case for one resolve is eleven requests per slug candidate — five GETs and six
Workday POSTs — and `slugCandidates` yields at most three candidates, so a resolve tops
out at 33 probes.

A board that answered under the company's FULL NAME is written down. `resolveCompany` itself
still writes nothing — it probes and returns — but `POST /api/companies/resolve` records each
such match as a `source` row,
and that row is the only way a resolved board reaches the query planner.

A match found only under the company's first word is shown to the user and deliberately NOT
written down (`if (!m.fromFullName) continue`). "Vector Health" reduces to the slug "vector",
and `ashby:vector` is a real board with real openings belonging to somebody else — persisted,
it would become an enabled source row the student cannot tell from a real resolution, and the
plan chip would then state it as fact. One press of "Find their boards" resolves up to eight
names at once. It used to be
written by the discovery run instead, once per persisted posting, so a board only became a
plan target if the user re-typed it into the run list, ran it, and that run came back with
at least one posting. A Workday board resolved outside internship season returns nothing and
so could never become a target at all, while the planner's note told the user to resolve a
board they had just resolved. Only boards that positively answered are written, so this
cannot mint a row for a board that is not there.

**Not built:** the domain fallback — fetching `acme.com` when none of the vendors answers and
looking for a careers link and an ATS fingerprint in the HTML — and the mapping cache.
Resolving the same company twice re-probes every vendor from scratch.

## Query planning

`queryPlanner` turns the confirmed profile into a bounded set of source queries. It does
**not** ask the model to invent queries freely; it composes them from profile facts:

```ts
QueryPlan {
  targets      // {source, board, reason}[] — the boards a run hits; capped at 40, except
               // for the pinned and keyless targets the cap gives way to (below)
  roleFamilies // inferred from the profile, top 4
  keywords     // roleFamilies + the filters' own role families and title-includes
  termTokens   // "summer 2027 internship", "summer 2027 co-op", … — from the filters
  locations    // base city, relocation targets, "remote"
  notes        // every truncation, guess and gap, in plain sentences
}
```

`targets` is the part that costs requests, and companies the user pinned by name go in
first and survive the cap. Slicing one concatenated list dropped them silently as soon as
the pinned list alone exceeded 40 — losing exactly the boards that had been asked for by
name. A pinned company with no resolved board is guessed on the four vendors whose board
address is just a slug — Greenhouse, Lever, Ashby and Workable — with a
note saying the guess is unverified so it can be pointed at the resolve endpoint.
SmartRecruiters shares that address shape and is deliberately not among them: its host
refuses this tool (see § Sourcing policy), so a guess there could only ever come back
refused, and planning one would put "This search was not complete" on every run that pins
any company. The plan note says so, because a user who pinned a company that really does
hire through SmartRecruiters needs to be told to go and paste a URL rather than left to
read the silence as "nothing open". Workday
is never guessed: its board address includes an arbitrary site name, so a "guess" would be
a blind walk over hosts and site names inside a discovery run, and a Workday target enters
the plan only through an actual resolution, which reaches it as the `source` row the resolve
route writes. The keyless sources that need no board at all — the SimplifyJobs community
list (`github_list`) and Arbeitnow — are planned by default and survive the cap too, because
for a fresh install they are the entire plan. Surviving means surviving after a run has used
them, which is the case that was broken: once a run wrote their `source` rows they arrived as
ordinary known boards, fell into the capped remainder, and eight pinned companies were enough
to cut them all — the community list among them, the highest-coverage source in the product,
gone without a word.

Remotive is keyless too and is deliberately NOT planned by default. Its own robots.txt
refuses the path its adapter reads, the adapter honours that and reports the refusal — so
planning it put "This search was not complete" on every run the user took the plan for,
about a source that cannot contribute until the site changes its mind. A standing refusal is
not a coverage gap anyone can act on; it is noise that teaches the user to stop reading the
warnings that matter. The adapter stays, as honest as ever, for anyone who adds it by hand.

The cap therefore gives way to what it must, and pinning enough companies plans more targets
than the cap allows. When that happens the plan says so in a note, as plainly as it reports
a truncation, because a plan that quietly overruns its own stated bound is no more
inspectable than one that quietly drops targets.

Role families are derived deterministically — no model call. `inferRoleFamilies` counts how
many terms of each entry in a curated 21-family taxonomy appear in the profile, ranks the
families with at least one hit by hit count, and keeps the top four.

It reads the profile as two separate corpora, because they can afford different amounts of
reach:

- the **stem corpus** — skills, experience titles and bullets, project names and
  descriptions, fields of study, coursework and honors — where a term may match as a
  prefix, so `biolog` reaches "biological";
- the **organization corpus** — the organization named on each experience — where every
  term must be a whole word. A young applicant's field is often stated only there ("Sample
  Robotics" with nothing in the bullets), so the line has to count; but under a prefix stem
  "Brandeis University" scored the `brand` term and a campus dining job came back wanting
  marketing roles.

A school's own name is identity, not role evidence, so each education institution is
subtracted from the organization corpus before anything is counted: "Student Ambassador,
Design and Architecture Senior High" was minting a design family for a student with no
design work behind it, while the rest of that line — "Speech & Debate Team", written after
the school name — still counts.

Both corpora then pass through `scrubFalseSignals`, which removes the phrases that borrow a
taxonomy stem without being evidence of it. "robots.txt" is an SEO artifact and "robotic
process automation" an ops one, and both handed a marketing resume robotics queries;
"tutorial" starts with the `tutor` stem, so following a React tutorial read as teaching;
"self-taught" and "mentored by" describe learning rather than teaching; and a clock time is
not a job title, so "Worked 4 to 9 PM shifts on weekends" no longer hands a cashier a
product-management search plan. Scrubbing the phrase is deliberate — narrowing the stem
instead would cost the genuine uses.

Matching is word-boundary anchored rather than a bare substring test, and that distinction
is the whole point of curating the taxonomy: `includes('ml')` is true of "html",
`includes('ai')` of "email", `includes('ui')` of "building", so a resume mentioning HTML and
email used to come back wanting machine-learning roles. In the stem corpus, terms of three
characters or fewer must be whole words and longer ones need only start at a boundary,
because entries like `biolog` and `prototyp` are deliberate stems; in the organization
corpus every term is whole-word regardless of length.

The user sees and can edit the query list before a run — discovery is not a black box
either.

## Pipeline

```
plan queries
   │
   ├─▶ [Tier A adapters]   ─┐
   ├─▶ [company targets]   ─┤
   └─▶ [manual paste-a-URL]─┤
                            ▼
                    normalize → NormalizedPosting
                            │
                            ▼
                    dedupe (3 stages)
                            │
                            ▼
              persist job_posting + job_posting_source
                            │
                            ▼
        matching run (doc 05) — extracts job_requirement, then scores
```

A run is one pass, not a resumable pipeline. `runDiscovery` fans the targets out across a
small worker pool, collects everything, dedupes, persists, and writes a **single** `task`
row at the end — already `status: 'done'` — purely so `GET /api/discovery/runs/:id` can
answer afterwards. There is no queue, no worker loop, and nothing to resume from; a run
that dies halfway is re-run. `runDiscovery` does publish `discovery.progress`,
`discovery.source_failed` and `discovery.done` onto the SSE stream at `GET /api/events`, but
nothing in the frontend subscribes to it — `EventSource` appears nowhere in `apps/web/src`
(docs/08 § Real-time). So a run reports itself only in the response that arrives when it is
already over: while it is running, the screen sits there with no indication of which board is
being fetched or how far along it is.

### Normalization

Each adapter implements one interface:

```ts
interface JobSource {
  kind: SourceKind;
  /** Whether this source needs an API key the user hasn't supplied. */
  requiresKey: boolean;
  isConfigured(): boolean;
  fetch(query: SourceQuery): Promise<SourceResult>;
}
```

`fetch` returns `{ postings: NormalizedPosting[]; notes: string[]; gaps?: string[]; closed?: string[] }` — one
call, one array, already normalized. Normalization is not a separate method: each adapter
maps its own vendor payload inline, because the mapping is the only part that differs
between sources and a second method would only be a place to forget to call.

`notes` is how a source says it did less than it looks like it did. A source that needs an
API key the user hasn't supplied is still called, and answers with an empty list and a note
saying exactly that — which is why the run summary can report a coverage gap instead of
showing zero postings and no reason.

`gaps` is a second, separate list carrying the coverage we did not get: a page of results
we stopped at, rows that could not be read. It is **not a subset of `notes`** — the runner
concatenates the two into the source report, so a line written into both is printed to the
user twice. Adzuna and USAJOBS return an empty `notes` beside a populated `gaps`;
`github_list` returns a status line in one and a different coverage-loss line in the other.
The runner also marks a source degraded for a gap and repeats it in the run summary's
`skipped` list, which is where the UI gets "the search was incomplete" from. A plain note
does neither, so a source that quietly returned its first fifty of eight hundred matches
used to read as complete coverage.

What decides between the two is what the student lost, never who decided to lose it. A cap
the adapter applied on purpose is still coverage not obtained: Workday and SmartRecruiters
fetch at most 20 detail pages per board, and an internship past that number ships with no
description at all — which is the same empty posting the student gets when a detail fetch
*failed*, and that has always been a gap. So the cap is a gap too. Postings whose titles are
not internship shaped are a note instead, and the difference is real: those were not what
the student came for, they still carry a title, a company and a link, and nothing was lost
by not spending a request on them.

### What counts as internship shaped

A Workday or SmartRecruiters list row carries no description text at all, so a description
costs one request per posting, and `internshipShaped` decides which postings earn one. It is
a single exported function that everything in the discovery path asks, the smoke script
included.

It used to be answered three times over. `ats.ts` tested one pattern, `aggregators.ts`
tested a narrower one, and the smoke script carried a third, so whichever source happened
to find a row decided whether the student ever saw it — and the narrowest answer belonged
to the German-heavy feed, which is exactly where the words it could not read actually live.
Unifying them took Arbeitnow from 24 internship postings to 65 on the same feed, and the
half that lost used to write a note stating as fact that a Praktikum is a title which does
not look internship shaped.

The vocabulary is multilingual because these boards are. SmartRecruiters is Europe-heavy —
one real board answers `?q=Praktikum` with 202 matches — and `\bstudent\b` cannot see itself
inside the German "Werkstudent", so that stem is matched unanchored. Praktikum, Werkstudent,
Praxissemester, stagiaire, alternance, prácticas, becario, pasante, estágio and tirocinio all
pass, alongside intern, internship, co-op, new grad, university and apprentice. The
boundaries cut both ways and are the harder half: "Internal Audit Manager" and "International
Sales Lead" have to stay out, "Early Stage Sales" and "Stage Manager" are phases and venues
rather than internships, and the German adjective "praktisch" is not one either.

Only SmartRecruiters searches that vocabulary server-side, once per term, because its `q=`
is a precise term match and cannot express "any of these words" in one query: it ORs two
words and collapses at three. Rarest term first, so a board posting only in English does not
spend its whole row budget before the English terms come up; the budget is shared across the
searches, and a search that never ran because the budget was gone is reported as a gap beside
a search that was truncated. The search list is deliberately shorter than the filter reads: a
word in the filter costs nothing, while a word in the search list costs one request per board
per run.

Workday deliberately does not, and the difference is measured rather than assumed. Its
`searchText` is fuzzy where SmartRecruiters' `q=` is exact, so asking it the vocabulary
returns noise: one live tenant answers 919 rows for "intern" and 1779 for "prácticas", the
latter ordinary senior engineering roles. Spending the row budget across those searches read
189 rows holding 9 internships, where a single "intern" search read 200 holding most of the
board's real ones. What is precise on one API is noise on the other, so the title filter is
shared between them and the search strategy is not.

`closed` is a fourth channel, and a different kind of thing from the other three: canonical
URLs the source itself says are no longer open. The community list marks a finished role
`active: false`, and that row used to be skipped and forgotten — the best closure evidence in
the pipeline, costing no request, thrown away, so a stored posting stayed open until the
45-day staleness window expired it and the queue went on offering an application that could
no longer be made. `runDiscovery` applies these after every source has been read, and a
posting the same run also fetched OPEN stays open: the sighting is the stronger signal, and
it is matched by stored row rather than by URL, because dedupe merges two addresses for one
job onto one row. The count appears on the run summary as `closed` and on the Discover
screen's headline.

Normalization is deterministic parsing, not an LLM call: title/company/location/dates come
straight from structured source fields. Discovery makes no model calls at all — requirement
extraction is the matching run's job (doc 05), and it is cached per posting.

Term detection (`summer 2027` vs `fall`) is a small deterministic parser over title + dates
+ description, with an `unknown` outcome rather than a guess. `unknown` postings are shown
with a badge, not filtered out.

### Dedupe

Three stages, cheapest first:

1. **Canonical URL.** Strip tracking params (`utm_*`, `gh_src`, `gh_jid`, `lever-*`, `ref`,
   `source`, `src`, `trk`), force https, lowercase the host, drop `www.` and the fragment,
   sort the remaining query and trim a trailing slash. A unique index does the work.
2. **Fingerprint.** The plain joined string
   `normalizeCompany(company) + '|' + fingerprintTitle(title) + '|' + primary city`. Not
   hashed — there is nothing to hide and the raw key is readable in the database when you
   are working out why two rows did or didn't merge. This stage merges on that key alone,
   with no different-source guard, so every token the title normalizer throws away costs a
   posting outright. `fingerprintTitle` is therefore the cautious form: it strips a
   *labelled* requisition id ("Req #9931", "Job ID 4471") and a bracketed aside that holds
   nothing else, and it keeps roman numerals, season words and years. Under the aggressive
   form, "Machine Learning Intern I" and "Machine Learning Intern II" collapsed onto one row
   and one of two real openings never appeared in the queue, and a "(Summer 2026)" and a
   "(Fall 2026)" requisition became one. That aggressive form, `normalizeTitle`, belongs to
   stage 3, which can afford it because it only ever merges across different sources.
3. **Same title, different source.** Merge when the stemmed, stopword-stripped token *sets*
   of the two titles are equal, the company matches, and the posting comes from a source
   the surviving row hasn't already been seen on.

Stage 3 began as character-trigram similarity and that does not work here. Measured against
real pairs:

```
0.767  "Software Engineer Intern"  vs  "Software Engineering Intern"        ← same job
0.758  "Software Engineer Intern"  vs  "Software Engineer Intern, Backend"  ← DIFFERENT job
0.613  "Software Engineer Intern"  vs  "Hardware Engineer Intern"           ← DIFFERENT job
```

The pair that must merge and the pair that must not sit 0.009 apart, so no threshold
separates them, and an embedding would face the same problem for the same reason. Character
overlap is the wrong signal: what distinguishes these titles is whether one carries a
discriminating token — backend, hardware, design — that the other lacks. Set equality
catches engineer/engineering and refuses every pair that shouldn't merge. It errs toward not
merging, which is the safe direction: a visible duplicate is a minor annoyance, a silently
hidden posting is the worst failure this tool has.

The different-source requirement is part of the same caution. Two similar titles from one
board are almost always distinct requisitions, and merging them would hide one.

Duplicates are merged, not dropped: the surviving row keeps a `job_posting_source` link for
every source that saw it, so the UI can show "found on Greenhouse + Adzuna" and a source
going dark doesn't silently lose postings. Persistence applies the URL and fingerprint keys
against the database as well, so the same job found on Greenhouse in one run and Adzuna in
the next merges across runs rather than becoming two rows with two decisions to make.

### Freshness

`refreshPostings` runs **on demand, not on a schedule.** There is no timer, cron entry or
job runner anywhere in the repo; the only callers are `POST /api/discovery/refresh` for the
whole table and `POST /api/postings/:id/refresh` for one row. Nothing in the drafting or
filling path calls it either, so re-checking before an application goes out is something the
user does rather than something the tool enforces.

What a refresh does, in order:

- **Deadline passed.** `closes_at` in the past → `is_open = 0`. Pure SQL, no network.
- **Not seen in 45 days.** `last_seen_at` older than that → `is_open = 0`. The count comes
  back in the summary as `closedAsStale`; nothing records a per-row reason.
- **Optional URL check** (`checkUrls`). GET the canonical URL — oldest `last_seen_at` first,
  50 rows per call by default, open postings only, since this pass can only ever close
  something. Only 404 and 410 close a posting: a 500 or a timeout means the site is having a
  bad day, not that the job is gone, so those are counted as errors and the posting is left
  open. A successful fetch bumps `last_seen_at`.

There is no re-fetch by external ID for any source, and no HEAD request — `politeFetch`
takes no method. The canonical URL is the only probe.

Deadline pressure reaches the user through the tracker rather than through this pass: an
application carries its own `deadline_at`, and `buildReminders` (doc 11 § M7) raises it as
the highest-urgency reminder as the date nears and again once it has gone by.

Nothing is hard-deleted. A closed posting stays in the DB so the tracker and stats stay
intact.

## Politeness and caching

Implemented once in `infra/http`, used by every adapter:

- Per-domain token bucket, default 1 rps, configurable per call.
- Honors `Retry-After`, but capped at 60s — waiting longer than that is not politeness, it
  is a run that appears to have hung. An absent or unparseable header falls through to
  exponential backoff with full jitter on 429/5xx. 5 attempts max.
- Conditional requests via stored `ETag`/`Last-Modified`; response cache with 6h default TTL
  keyed on URL. Re-running discovery within the TTL costs almost nothing.
- Every fetch is a GET except one. Workday's board endpoint is the single public board API
  that answers only to POST — the same query the company's own careers page sends — so
  `fetchJson` takes a `jsonBody` and sends it as a POST body. A request carrying a body is
  neither served from the response cache nor stored in it: the cache is keyed on URL alone,
  and one Workday board URL answers a different page for every offset and search term, so
  caching by URL would hand every later query the first query's answer.
- User-Agent: `internship-applier/0.1 (+local personal job-search tool)`.
- `robots.txt` fetched and cached per origin for every page fetch — the manual paste-a-URL
  path and the refresh URL check. Documented API endpoints opt out with `isDocumentedApi`,
  which `fetchJson` defaults on; the two keyless feed adapters and the SmartRecruiters board
  adapter pass `isDocumentedApi: false` and let each host answer for itself (§ Sourcing
  policy says which hosts say what). The SmartRecruiters company probe in
  `resolveCompany.ts` asks too, through its own `asksRobots` flag.
  A disallowed path raises a 403, which surfaces in the run summary rather than being
  silently skipped. `Allow:` is deliberately unimplemented: ignoring one can only make this
  refuse a fetch it could have made, which is the direction to be wrong in. A robots.txt
  that cannot be read at all raises the same 403, because a host that will not answer has
  not given permission.

The concurrency cap lives in the discovery runner rather than here: `runDiscovery` fans
targets out across **4** workers by default, so a run can't saturate the user's link.

## Run reporting

Every discovery run produces a summary the UI shows: per source — postings found, how many
were new, every error, the source's own notes, and whether it was degraded. Run totals carry
found, new, duplicates and `closed`, plus a `skipped` list naming each source that contributed less
than it looks like it did. If a source was rate-limited, missing a key, or unknown to the
runner, that is stated. Silent truncation would read as "we searched everywhere" when we
didn't, which is exactly the failure mode that makes an automated search tool untrustworthy.

## Checking it against the real internet

```bash
npm run smoke:discovery
```

`scripts/smoke-discovery.ts` points a hand-picked list of real boards at the real endpoints
and prints what came back: per source, how many postings, how many look student-facing, and
how many carry a location, a term year and a pay figure. It writes nothing — no database, no
`source` rows, no `job_posting` rows — and it exits non-zero if a source that should have
been reachable was not.

**The list has not caught up with the adapters.** Five of the shipping sources — Workday,
SmartRecruiters, Workable, Arbeitnow and Remotive — are not in it, so the one check that
exists to notice an endpoint moving does not watch them, and "5 sources reachable" says
nothing at all about the five that landed most recently. The script also counts
"student-facing" with its own English-only pattern rather than calling `internshipShaped`,
so on a European board that number reads low against the postings the run would actually
keep.

It exists because every other check in this repo runs against a fixture, and a fixture cannot
answer the question that actually matters: whether these endpoints are still there, still
shaped the way `normalize.ts` expects, and still returning postings a student could apply to.
It is not part of `npm test` or `npm run check` — it depends on somebody else's servers being
up, and a suite that goes red when Greenhouse has a bad afternoon teaches people to ignore
it. Run it when an adapter changes, or when the results look wrong.

A keyed source with no key reports itself skipped and does not count as a failure; that is
the same honesty the run summary owes the user.
