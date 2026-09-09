# 01 — Overview

## The problem

Finding summer internships is a volume game played under an information deficit. Postings
are scattered across hundreds of company career pages and a dozen aggregators; most of
them are not open to you (wrong education level, wrong term, wrong work authorization,
closed weeks ago, requires 3 years of professional experience for an "internship"); and
each application asks the same twelve questions in a slightly different order, plus two or
three short essays.

The expensive parts are **finding the eligible subset** and **re-typing the same
information**. The valuable part — deciding what to say about yourself and whether you
want the job — is the part a human should keep.

## Goals

1. **Ingest** a resume/CV (PDF, DOCX, TXT, MD) and turn it into a structured, *user-confirmed*
   profile.
2. **Discover** summer internship postings continuously from legitimate sources.
3. **Filter** hard: only surface postings the user is actually eligible for, given age,
   education level, graduation date, work authorization, location, availability window,
   and experience level.
4. **Rank** the eligible set by fit, with a visible, auditable rationale — never a black-box score.
5. **Confirm** — one explicit human approval per application. No bulk-apply, no auto-apply.
6. **Draft** application answers in the user's own writing voice, grounded strictly in
   confirmed profile facts.
7. **Pre-fill** the application form in a visible browser so the user reviews the real page
   before submitting.
8. **Track** every application, deadline, and outcome.

## Non-goals

- Not a general job board. Summer internships are the scope; the eligibility model is built
  around student/early-career constraints.
- Not a mass-application tool. Throughput is deliberately capped by the per-application
  human approval gate.
- Not a hosted service. Everything runs on the user's machine against the user's own
  accounts and API key. There is no server holding other people's resumes.
- Not a resume writer. It reads your resume; it doesn't rewrite it. (Possible later, out of
  scope now.)

## Design principles

**Local-first.** Resume, profile, writing samples, application history, and browser session
state live on the user's disk. The only network egress is: job-source APIs, the Anthropic
API, and the application sites themselves.

**Deterministic code decides; the model reads and writes.** Every eligibility decision — age,
dates, authorization, deadlines, seniority — is made by plain TypeScript against structured
fields. The LLM's jobs are narrow and checkable: extract structure from unstructured text,
classify form fields, and draft prose. It never gets the final say on whether the user
qualifies for something, and never on whether to submit.

**Every claim is traceable.** Generated application text is validated sentence-by-sentence
against the confirmed profile. A sentence that can't be traced to a profile fact is
surfaced as a warning the user must resolve.

**Human gates are structural, not optional.** Four of them:

| Gate | What the user must do |
| --- | --- |
| G1 · Profile confirm | Review and correct extracted resume data before it's used anywhere |
| G2 · Application approve | Explicitly approve each individual posting before any drafting happens |
| G3 · Answer review | Open, read, and actively approve every generated answer |
| G4 · Submit | Click Submit themselves, in the real browser, on the real page |

None of these can be disabled by a config flag. G4 in particular is the difference between
"a tool that helps me apply" and "a bot that applies as me."

**Fail visible.** When something can't be determined — an ambiguous form field, a
requirement the parser didn't understand, a posting whose eligibility is unclear — the tool
says so and asks. It does not guess and proceed.

## Legal and ethical posture

This section is load-bearing; treat it as a spec, not a disclaimer.

### On sourcing

Discovery uses official, documented APIs (Greenhouse, Lever, Ashby, Workday,
SmartRecruiters, Workable, USAJOBS, Adzuna, and similar) plus public job feeds and structured
`JobPosting` JSON-LD from company career pages. It does **not** scrape sites whose terms of
service prohibit automated access or that require authentication to view listings — notably
LinkedIn, Indeed, Glassdoor and Handshake.

There are two manual paths, and only one of them takes those postings. **Paste a URL**
(`POST /api/discovery/manual`) fetches the address you give it, so it refuses those hosts
outright with `SOURCE_REFUSED` before any request goes out — the refusal is a rule in
`core/discovery/sourcingPolicy.ts` rather than a check in one adapter, because a stored
address is fetched again later by the freshness refresh and opened by the signed-in
form-filling browser. **Paste the text** (`POST /api/discovery/paste`) is the one that
supports them: you read the posting there yourself, which is not automated access, and hand
over the text. Its URL is stored as the posting's identity and never fetched.

This document previously said the URL path was where LinkedIn, Indeed and Glassdoor were
supported. It is the path that refuses them, so a reader holding exactly the posting the
other box exists for was sent to the one box that will not take it. The running app recovers
that reader — `AGGREGATOR_REFUSAL` names the paste-the-text box in the same sentence as the
refusal — but the document sending them there in the first place should not have been the
part that was wrong. Details in [`04-job-discovery.md`](04-job-discovery.md).

### On authorship and "human writing style"

The requested behavior — application text that reads as human-written — is implemented as
**style transfer from the user's own writing**, not as evasion of AI detection. The
difference matters in the design:

- The voice model is built from writing samples the user supplies (past essays, emails,
  cover letters). The output targets *their* sentence rhythm, vocabulary, and habits — not a
  generic "sounds human" register.
- Every factual claim is grounded in the user's confirmed profile and checked against it.
- The user must read and actively edit/approve every answer before it can be submitted (G3).
  The UI tracks edit distance and nudges when a draft is approved untouched.
- If an application asks whether AI was used, the tool surfaces the question and leaves it
  blank. The user answers it.

The honest framing to hold onto: **the user is the author.** The tool drafts in their voice
from their facts, and they review, revise, and vouch for every word before it goes out.
That is a legitimate writing assistant. What it is not — and what the design actively
prevents — is a system that fabricates credentials or lets someone submit text they have
never read.

One thing worth stating plainly to the user during onboarding: some employers ask about AI
use and some disqualify for undisclosed use. That's their call to make, and the tool should
make it easy to make honestly rather than quietly making it for them.

### On automation of submission

The tool fills forms. It does not submit them. It also will not:

- solve CAPTCHAs or defeat bot detection;
- tick certification/attestation checkboxes ("I certify the above is true"), EEO
  self-identification, or consent boxes — those are personal statements;
- create accounts or enter passwords;
- enter SSN, government ID, bank, or payment details.

Human-like typing cadence *is* used, for one reason only: many modern form widgets are
JavaScript-driven and break on programmatic value assignment. It is a compatibility
measure, and the design does not add fingerprint spoofing, proxy rotation, or other
detection-evasion machinery.

### On minors

Summer internships are frequently sought by people under 18, and the user may be one. The
design handles this explicitly rather than ignoring it — see
[`10-security-privacy.md`](10-security-privacy.md) § Guardian mode. Age is user-entered,
never inferred from the resume, and used for eligibility filtering (many postings require
18+) and for tightening the handling of a minor's personal data.

## Who this is for

A single user running it on their own machine, applying to their own internships, with
their own Anthropic API key. Multi-user, team, or hosted deployments are out of scope and
would change the privacy model substantially.
