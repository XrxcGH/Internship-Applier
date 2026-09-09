# internship-applier

A local-first desktop tool that reads your resume, finds summer internships you're
actually eligible for, and — once **you** approve each one — drafts application answers
in your own writing voice and pre-fills the application form for your review.

**Status: built through M8.** Resume ingestion, discovery, matching, the review queue, the
writing engine, form filling, the tracker, and packaging are all implemented, and each of
them has tests — `npm test` prints how many, which is a more honest answer than a number
written down here and left to rot. See [`docs/11-roadmap.md`](docs/11-roadmap.md) for what
each milestone covers and, more usefully, what is still untested.

Two gaps worth knowing before you rely on it. Both are on the *filling* side, not the
finding side: discovery has six vendor adapters — Greenhouse, Lever, Ashby, Workday,
SmartRecruiters and Workable — and a live run has returned real postings through them. This
paragraph used to say no Workday adapter existed, which read as a hole in the search when
the search is the part that has been exercised against the real internet.

The gaps: none of the per-vendor ATS adapters is built **for filling a form**, so every form
is filled by the generic label-driven mapper, which has never been pointed at a real posting
from any of those vendors — `core/filling` holds the mapper and no vendor file. And answer
drafting has not been exercised against a live model. That one is untried rather than
unavailable: the Claude Code CLI backend exists and both resume extraction and discovery have
run through it, so drafting could be run the same way and simply has not been.

## Running it

```bash
npm install
npm start          # builds the interface and serves everything from one URL
```

Then open the address it prints. `npm run dev` runs the API and the Vite dev server
separately while you are working on it.

If you are going to commit anything from this checkout, run `npm run hooks:install` first.
It points git at `.githooks`, whose pre-commit hook refuses commits containing your resume,
the database, a `.env`, or an Anthropic key. Git does not use that directory until you say
so, so a fresh clone has no such protection.

Three things need a model: reading your resume into a profile, drafting an answer, and the
web-search discovery source — the one that finds postings nobody told it about, which spends
one model call per run and only when you press its button. Each will use the [Claude Code
CLI](https://code.claude.com/docs) if you have one installed and signed in, against a
subscription you already pay for, or an `ANTHROPIC_API_KEY` if you set one.

**Everything else works without either**: the board adapters, matching, eligibility,
fact-checking, and the writing checks all run on your machine. See
[`docs/14-model-access.md`](docs/14-model-access.md).

---

## What it does

```
resume.pdf ──▶ profile ──▶ search ──▶ eligibility filter ──▶ YOU approve ──▶ draft answers
                  ▲                                                              │
                  └──────────── you edit + confirm ◀──────────────────────────────┘
                                        │
                                        ▼
                            form pre-filled in a visible browser
                                        │
                                        ▼
                              YOU click Submit · tracked
```

## What it deliberately does *not* do

These are hard constraints in the design, not settings:

- **Never submits an application you haven't seen and approved.** The tool fills the
  form; a human presses Submit.
- **Never invents facts.** Every generated sentence must trace back to something in your
  confirmed profile. Unsupported claims are flagged in red and block submission.
- **Never types credentials, SSNs, government IDs, or payment details.** Those fields are
  skipped and handed to you.
- **Never creates accounts or solves CAPTCHAs.** You log in; the tool reuses the session.
- **Never answers "did you use AI to write this?"** That question is surfaced to you,
  unanswered.
- **Never scrapes sites whose terms forbid it.** Discovery runs on official ATS/job-board
  APIs and public job feeds. See [`docs/04-job-discovery.md`](docs/04-job-discovery.md).

## Documentation

| Doc | Contents |
| --- | --- |
| [01 — Overview](docs/01-overview.md) | Goals, non-goals, principles, legal/ethical posture |
| [02 — Architecture](docs/02-architecture.md) | Stack, processes, module layout, data flow |
| [03 — Data model](docs/03-data-model.md) | SQLite schema, core TypeScript types |
| [04 — Job discovery](docs/04-job-discovery.md) | Sources, fetch pipeline, dedupe, freshness |
| [05 — Matching](docs/05-matching.md) | Hard eligibility rules, fit scoring, age handling |
| [06 — Writing engine](docs/06-writing-engine.md) | Voice profile, drafting, fact-checking, review gate |
| [07 — Form automation](docs/07-form-automation.md) | Playwright, ATS adapters, field mapping, submit gate |
| [08 — Frontend](docs/08-frontend.md) | Screens, components, state, keyboard-first review UX |
| [09 — API](docs/09-api.md) | REST + SSE surface between frontend and backend |
| [10 — Security & privacy](docs/10-security-privacy.md) | PII, encryption, minors, credentials, deletion |
| [11 — Roadmap](docs/11-roadmap.md) | Milestones, testing strategy, risks, open questions |
| [12 — Design language](docs/12-design-language.md) | Type, palette, motion, measured contrast |
| [13 — Dependency audit](docs/13-dependency-audit.md) | Standing assessments for `npm audit` findings |
| [14 — Model access](docs/14-model-access.md) | Claude Code CLI vs API key, and what runs without either |

## Environment (verified on this machine)

- Node v24.16.0, npm 11.13.0, git — present
- Python — **not used**, and not installed here either; nothing in `apps/` or `packages/`
  runs a Python process. Both stacks were weighed with Python on the machine, so see
  [ADR-001](docs/02-architecture.md#adr-001--typescript-over-python) for why the choice went
  to TypeScript despite Python being a reasonable fit for this domain
- Platform: Windows 11

## Next step

`npm install`, then `npm start`, then open the address it prints — see § Running it above.

After that, [`docs/11-roadmap.md`](docs/11-roadmap.md) § Status is the honest account of
what each milestone actually shipped, what was verified against real postings, and what has
never been run outside the test suite.
