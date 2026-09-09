# 06 — Writing engine

This module produces the free-text answers on an application: cover-letter-style fields,
"why this company," "describe a project," short-answer essays. It has two jobs that are
easy to confuse and must stay separate:

- **Say true things.** Every claim traces to a confirmed profile fact. This is enforced.
- **Say them the way the user would.** Style transfer from the user's own writing.

## What "human writing style" means here

The goal is text the user would plausibly have written, because it is built from their
facts and shaped by their measured writing habits — and because they read and revise it
before it goes anywhere. It is a writing assistant that sounds like *you*, not a generic
"make it undetectable" filter.

Two things follow from that framing, and both are in the design:

- The style target is the user's own `StyleProfile`, computed from real samples. There is
  no "sound more human" prompt in this system, because that produces a different generic
  register, not the user's.
- The tool never claims authorship on the user's behalf. If a form asks about AI
  assistance, that field is redlined (doc 07) and left for the user.

Worth surfacing to the user during onboarding, once, without nagging: some employers ask
about AI use and some treat undisclosed use as grounds for withdrawal. The tool's job is to
make an honest answer easy — draft from your facts, in your voice, reviewed by you — not to
make the question go away.

## Building the voice model

### Input

During onboarding the user pastes 2–5 samples of their own writing — a college essay, an
email to a teacher, a past cover letter, a long Slack/Discord message. 300+ words total is
enough to be useful; 1000+ is good. Samples are stored 🔒 and never sent anywhere except
as few-shot context in drafting calls.

If the user has no samples, the tool says so plainly and falls back to a neutral,
plain-register default — and marks generated answers as "generic voice" in the UI so the
user knows to edit more heavily.

### Measurement

`styleProfile.ts` computes the `StyleProfile` (schema in doc 03) with plain text analysis —
no LLM needed for the metrics themselves:

- Sentence length mean **and standard deviation.** The stdev is the important one: uniform
  sentence length is the single loudest tell of machine-generated prose, and most people
  write with high variance.
- Contraction rate, first-person density, hedge rate.
- Punctuation habits — em-dash vs parenthetical vs semicolon, exclamation frequency.
- Paragraph length distribution; list usage.
- Favored transitions and opening patterns, extracted as literal n-grams from the samples.
- Vocabulary tier via a frequency-band lookup.

`describeStyle` turns those same metrics into plain sentences — "You vary sentence length a
lot", "You reach for em dashes and parentheses more than most people" — which are stored as
`style_profile.qualitative_notes` and shown back to the user on the Voice page. They are
assembled in TypeScript from the numbers above; there is no model call.

> **Not built:** the short LLM pass this section used to describe, which was to add
> qualitative notes (register, warmth, directness, humor) that the metrics cannot capture,
> and feed them to the drafting prompt as guidance. Neither half exists. Nothing reads
> `qualitativeNotes` except the endpoint that returns it to the Voice page, so those
> sentences never reach the model at all — the prompt's voice section is built by
> `voiceInstructions`, straight from the metrics.

## Drafting an answer

```
question + field constraints (max length, tone hints from the form)
        │
        ▼
  ① retrieve relevant profile facts   ← deterministic keyword + skill overlap
        │
        ▼
  ② check the answer library          ← reuse an approved canonical answer if one fits
        │
        ▼
  ③ generate  (claude-opus-5, StyleProfile + few-shot from real samples)
        │
        ▼
  ④ factGuard  — every claim ↔ profile evidence, or flag
  ⑥ tell-scrub — flag known AI-register phrasing
        │        (both run on the draft; a blocking claim or a named tell
        │         buys exactly one revision, then it goes to the user)
        ▼
  ⑤ styleCritic — measure against StyleProfile; drift becomes a flag
        │
        ▼
     draft + evidence + flags  →  G3 review UI
```

The numbering follows the sections below rather than the order things run. FactGuard and
tell-scrub are the pair inside `draft.ts`, and between them they own the single revision
pass. StyleCritic runs later, on the review side, and only ever produces a flag.

### ① Retrieval, not invention

The prompt is given a bounded evidence set, not the whole profile: the experience bullets,
projects, courses, and skills most relevant to the question and the posting. Retrieval is
deterministic — keyword and skill overlap, no model call and no embeddings, the same as the
matching scorer (docs/05 § Fit score). Each evidence item carries its `profileRef` so the
generated text can cite it. Embedding similarity as a second pass was the plan and is not
built; until it is, an evidence item is only found by a word the question and the profile
actually share.

The system prompt states the constraint directly: *use only the supplied facts; if the
question asks for something not in the evidence, say so in a `needs_input` field rather
than inventing it.* When that fires, the UI asks the user for the missing detail instead of
producing a plausible fabrication.

### ② Answer library

Recurring questions (`why_this_company`, `greatest_strength`, `describe_a_project`,
`why_this_role`, `tell_us_about_yourself`) map to `answer_template` rows. Once the user has
approved a canonical answer, later applications adapt it — company-specific details swapped
in, length adjusted — rather than generating from scratch. Benefits: less generation
surface area for errors, and a consistent story across applications, which matters if two
recruiters at the same company compare notes.

### ③ Generation

`claude-opus-5`, adaptive thinking. `buildSystemPrompt` assembles the system message in
this order:

1. Role, then the hard rules: the no-invention rule, the no-upgrading rule, and the list of
   constructions that get flagged automatically.
2. **VOICE** — `voiceInstructions(style)`: the measured metrics stated as sentences, never
   as adjectives. "Write naturally" is what every model already thinks it is doing.
3. **LENGTH** — the form's word ceiling, or 120–200 words when it states none. In practice
   always the latter. The ceiling arrives as `maxWords` on the draft request, and nothing
   carries a form's `maxLength` from the FormMap into that request: `Applications.tsx` calls
   `draftAnswer(id)` with no second argument, so a caller driving the API by hand is the only
   way a form's own limit ever reaches the prompt.
4. **EVIDENCE** — the retrieved set, one fact per line, each tagged with its ref.
5. **HOW THIS PERSON ACTUALLY WRITES** — up to three verbatim writing samples, each capped
   at 1200 characters.

The user message carries the question and, when there is one, the posting text — explicitly
labelled as untrusted background rather than instructions.

The model never sees the confirmed profile, only the evidence set, and it is told that
facts outside that set do not exist for the task. That is what makes FactGuard's verdicts
mean something: a claim can only be "supported" by something that was actually supplied.

> **Not built:** prompt caching. This section described a stable prefix carrying a
> `cache_control` breakpoint; the API backend sends no `cache_control` at all, so every
> draft pays full price for the whole prompt. Adding it would also mean reordering: the
> evidence set changes with every answer and currently sits *before* the writing samples,
> which do not, so there is no long stable prefix to break on as written.

### ④ FactGuard

The anti-hallucination gate, and the reason this tool is safe to use on a job application.

The draft is decomposed into claims (sentence-level, with sub-clause splitting for compound
sentences). Each claim is classified:

| Verdict | Meaning | UI treatment |
| --- | --- | --- |
| `supported` | Maps to a specific profile fact | Green underline; hover shows the evidence |
| `inferred` | Reasonable restatement (e.g. "I enjoy backend work" from three backend projects) | Amber; shown with the inference stated |
| `unsupported` | No profile basis | **Red. Blocks approval** until the sentence is edited or the fact is added to the profile |
| `overstated` | Supported fact, inflated (2 months → "extensive experience") | Red, with the original fact quoted alongside |

Implementation, in the order the layers actually matter:

1. **Deterministic, and the only layer that runs.** `factGuard.ts` extracts durations, GPAs,
   organisation and institution names, and skills from the draft and compares them against
   the evidence set. No model, no API key, fully testable — which is why the adversarial
   suite runs on every commit rather than only when a key is configured.
2. **Model verdicts — built, tested, and not wired in.** `mergeModelVerdicts` implements the
   merge policy (the model may downgrade a verdict, never clear one) and the adversarial
   suite covers it, but nothing in the drafting path or the G3 route produces model
   verdicts, so no claim at runtime is ever decided by one.

The consequence, stated plainly because it is the sort of thing a reader assumes the other
way round: semantic overstatement the regexes cannot reach — "I led the migration" when the
evidence says "helped with the migration" — is caught by the human at G3 and by nothing
else.

`unsupported` and `overstated` flags are hard blockers on `approved_at`, and there is no way
to click past one. `POST /api/answers/:id/approve` re-verifies the text at approval time and
answers 409 `UNVERIFIED_CLAIMS` while any blocking flag stands. It reads no body at all, so
there is no parameter an override could arrive in, and `AnswerReview.tsx` renders the Approve
button disabled rather than offering a second one.

Two things clear a block, and both change what is being checked rather than who is checking:

- **Edit the sentence** so it claims what the evidence supports. The next verification runs
  on the edited text.
- **Add the fact to your profile**, then approve again. The re-check runs against the profile
  as it stands, so a true fact that was simply never on the resume clears the block here and
  for every later answer. This is the route out of a false red, and it is the one the screen
  names: *"Fix the flagged claims above, or add the missing facts to your profile."*

> **Not built:** the "this is true, it's just not on my resume" acknowledgement this section
> used to promise. It was the worst sentence in these documents, because the only reader who
> ever reaches it is the one holding a false red — and it sent that reader hunting the
> interface for a control that has never existed, on the one screen where being stuck is
> already the problem. There is no such button, no request field, and no branch in the route.
> docs/11 § M5 has said the opposite all along: "G3 enforced server-side with no override".
> `answers.test.ts` asserts the bulk-approve half — three plausible approve-everything paths
> all answer 404. The no-override half is true of the code and guarded by nothing: the
> handler takes no body, so today there is no field an override could arrive in, and no test
> would go red if one were added.

### ⑤ StyleCritic

Measures the draft with the same analyzer used on the samples and compares to the target
`StyleProfile`. It runs in the answers route, not in `draft.ts`: each drift past a severity
of 0.4 — sentence-length stdev, contraction rate, paragraph shape, punctuation habits —
becomes a `style_drift` flag on the answer, and the user sees it at G3.

> **Not built:** the style revision pass this section used to describe, which was to rewrite
> toward the target with an instruction not to change any factual content, then re-run
> FactGuard on the result. Nothing rewrites for style. That is a smaller loss than it
> sounds: the one revision the drafting pipeline does allow is spent on fabrications and
> tells, which are the two that block approval, and style drift the user can see is
> something they can fix in the editor without a model rewriting their facts on the way past.

### ⑥ Tell-scrub

Implemented in `core/writing/tellScrub.ts`. A lint pass over known machine-register
patterns. It **flags**, it doesn't silently rewrite — the user decides.

#### What this is and isn't for

The goal is that a draft reads like the person who is going to sign it, because it is
their facts in their voice and they will edit and submit it themselves. Text that reads as
machine-written is worse writing, and on an application it also misrepresents who did the
thinking.

It is **not** tuned against AI-detection classifiers, and that is a deliberate line. Two
reasons, one principled and one practical:

- The AI-disclosure question on a form is redlined (docs/07) — the tool leaves it blank for
  the user to answer. Building a detector-evasion layer while doing that would be
  incoherent.
- Detector evasion doesn't work anyway. The measures those tools lean on — perplexity and
  burstiness — are [documented as unreliable](https://www.pangram.com/blog/why-perplexity-and-burstiness-fail-to-detect-ai),
  with high false-positive rates on non-native and neurodivergent writers. Optimising
  against a noisy classifier produces worse prose, not safer prose.

What actually makes this honest is unchanged and structural: FactGuard grounds every claim
in the confirmed profile, and gate G3 means the user has read and edited every sentence.

#### Checks

Grounded in the stylometry literature and current editorial reporting (sources below).
Fifteen categories, in two families.

**Lexical** — `cliche_opener`, `overused_word`, `hollow_intensifier`, `corporate_register`,
`assistant_voice`, plus three from the research:

| Check | What it catches |
| --- | --- |
| `contrast_reframe` | "It's not just X, it's Y" / "not only… but also". Reported as the most reliable current giveaway: it performs insight without adding any. |
| `false_payoff` | "Here's the kicker", "it's worth noting", "when it comes to" — promises a payoff, delivers a generality. |
| `summary_closer` | "In short", "Firstly/Secondly" — essay scaffolding in a 100-word answer. |

**Statistical** — the literature's most consistent findings are lower perplexity, flatter
sentence variation, and higher lexical repetitiveness:

| Check | Measure |
| --- | --- |
| `uniform_rhythm` | Sentence-length standard deviation. The loudest single tell. |
| `low_lexical_diversity` | Type-token ratio over content words in a fixed window. Function words excluded (everyone repeats those); fixed window because raw TTR falls with length regardless of author. |
| `repeated_openers` | ≥3 sentences and ≥50% opening with the same word. "I did X. I did Y. I did Z." is the most common shape of a generated answer. |
| `em_dash_density` | Judged against the user's own measured rate, not an absolute — some people genuinely write with lots of em-dashes. |
| `triadic_overuse`, `transition_stack`, `symmetric_paragraphs` | Structural rhythms nobody produces by accident. |

Structural checks are skipped below 25 words. That floor was originally 60, which silently
skipped them on exactly the length most application answers are.

#### The app audits its own copy

`npm run audit:copy` runs the same detector over this application's interface text, and it
is part of `npm run check`. A tool that flags machine-sounding prose in your application
while writing it on its own buttons has no standing. The first run of this dropped the
interface's em-dash rate from 1.13 to 0.32 per 100 words.

#### Sources

- [Feature-Based Detection of AI-Generated Text: Stylometric and Perplexity Markers](https://www.researchgate.net/publication/398588043_Feature-Based_Detection_of_AI-Generated_Text_An_Analysis_of_Stylometric_and_Perplexity_Markers_in_Contemporary_Large_Language_Models)
- [A Comparative Analysis of AI-Generated and Human-Written Text](https://papers.ssrn.com/sol3/Delivery.cfm/5833302.pdf?abstractid=5833302&mirid=1)
- [Counter Turing Test CT²: AI-Generated Text Detection is Not as Easy as You May Think](https://arxiv.org/pdf/2310.05030)
- [Why Perplexity and Burstiness Fail to Detect AI — Pangram Labs](https://www.pangram.com/blog/why-perplexity-and-burstiness-fail-to-detect-ai)
- [15 New Giveaway Signs Of AI Writing — Forbes, May 2026](https://www.forbes.com/sites/jodiecook/2026/05/21/15-new-giveaway-signs-of-ai-writing-may-2026-update/)

#### Flagged patterns

- Opener clichés: "I am excited to apply", "I am writing to express my interest".
- Overused abstractions: "delve", "tapestry", "landscape", "leverage" (as a verb),
  "in today's fast-paced world", "passionate about" (unless it's in the user's samples).
- Structural tells: three consecutive triadic lists; every paragraph the same length;
  `Furthermore`/`Moreover`/`Additionally` stacked as paragraph openers; perfectly
  symmetrical intro-body-conclusion in a 150-word answer.
- Em-dash density above the user's measured rate.
- Uniform sentence length (stdev below the user's measured floor).

Each flag is shown with its note and the span it refers to, quoted. **Not built:** the
one-click "rewrite this span" action this line used to promise. `AnswerReview.tsx` is the only
place flags are rendered and all three families — blocking claims, AI tells, style drift — are
static lists; the editing affordances on that card are a whole-answer Edit and a Redraft.
Fixing one flag means editing the answer.

## G3 — The review gate

Not a rubber stamp. The workspace shows, per question:

- The question exactly as it appears on the form, with a word count beside it. Two words this
  bullet used to carry and should not have. **Not a *live* counter:** the badge is measured
  off `answer.text`, the saved text, not off the textarea, so it sits still while you type
  and moves when the edit is saved. **And no *length limit*:** `maxWords` is a parameter on
  the draft call that `Applications.tsx` never sends, so no ceiling reaches the prompt from
  the UI and none is displayed anywhere on the card. A form's own `maxLength` is read by the
  FormMap and applied at fill time — `plan.ts` truncates to it — which is a later gate and a
  different number.
- The draft in an editor.
- An evidence panel: every claim, its verdict, and the profile fact behind it.
- Flags, each quoted with the span it refers to, in three lists — blocking claims, AI tells,
  style drift. **Static lists:** there is no per-flag action, for the same reason § ⑥ gives
  for the "rewrite this span" button that was never built. Fixing a flag means editing the
  answer.
- An **edit distance meter** — a bar and a sentence, always on the card, reading "Unedited so
  far." until something changes. **Not a dialog:** there is no confirm step anywhere in
  `apps/web/src`, so approving an untouched draft is one click like any other. What stands in
  for it is the line beside the Approve button, shown whether or not anything was edited:
  *"Read it once more. Approving means you stand behind every sentence."* Weaker than the
  interruption this section used to describe, and the honest account of what happens.

`approved_at` is set only by an explicit per-answer action. Form filling refuses to start
while any answer is unapproved (doc 03, invariant 2).

## What the engine will not do

- Fabricate experience, skills, dates, GPAs, employers, or references.
- Claim proficiency the profile doesn't evidence.
- Write in a voice the user hasn't provided samples for and then pass it off as tuned.
- Answer AI-disclosure questions (redlined — doc 07).
- Produce text that is submitted without the user having read it (structurally impossible:
  `approved_at` is required, and it's set by a UI action, not by any generation path).
