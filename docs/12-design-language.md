# 12 — Design language

## The idea: a working dossier

This app handles your resume, your voice, and your record of who you asked for a job. Its
whole design thesis is *receipts* — every filter decision quotes the job description that
caused it, every generated sentence points at the profile fact behind it, every gate is a
signature you supply. The interface should feel like a **case file you are building and
signing**, not a SaaS dashboard.

So: editorial type, rules and marginalia, stamps for state changes, and a surface that reads
as a working surface rather than a canvas. Dark is the primary theme and light is a real
alternative, not an inversion.

> The palette below is **blueprint** — one blue-violet ink family whose neutrals are tinted
> rather than gray, with a cyan accent. It replaced "warm stone" (a warm-neutral ramp, sage
> accent), which replaced "drafting table" (cool graphite, azure); this document described
> each older one long after it was gone, so every hex value and contrast ratio here is
> re-measured against `apps/web/src/index.css` as it ships rather than carried over.

What this deliberately isn't: a purple gradient on white, a grid of rounded cards with
drop shadows, Inter at three weights, an emoji in every heading.

## Typography

Three faces, each with a job. All **self-hosted via `@fontsource`** — pulling them from a CDN
would leak a request to Google on every launch and break offline use. Written as "the app
promises nothing leaves your machine", which is not the promise the app can make: the resume,
the posting text and every draft go to a model (docs/10 § What gets sent to the LLM). What it
does promise is that nothing leaves for anyone the user did not ask for — no telemetry, no
analytics, no third party — and a font request is precisely that kind of leak. The privacy
stance and the type stack have to agree, on the true version of the stance.

| Role | Face | Why |
| --- | --- | --- |
| Display — headings, numerals, the running head | **Instrument Serif** | High-contrast, slightly editorial, a little sharp. Carries a page without shouting. Its italic is genuinely lovely and does the work of a second weight. |
| Body — prose, job descriptions, generated answers | **Newsreader** | Variable serif with optical sizing, built for reading long text on screen. Job descriptions and drafted essays are the two longest things a user reads here; they deserve a reading face, not a UI face. |
| Data — scores, quotes, field labels, evidence refs | **IBM Plex Mono** | A grotesque mono with real personality. Used for anything that is *quoted or measured* — verbatim JD text, field keys, token counts — so the eye learns that mono means "this is evidence, not our words." |

That last rule is the important one: **mono is semantic here, not decorative.** If it's set
in Plex Mono, it came from somewhere else and can be traced.

Scale is a modular 1.2 ratio off a 16px base, with display sizes set tighter
(`letter-spacing: -0.02em`) and small caps used for section eyebrows.

## Color

ONE hue, and the neutrals belong to it. Every surface, rule and text tone is the same
blue-violet ink at a different lightness — tinted, not gray — with a cyan accent from the same
cool half of the wheel and three signals at matched chroma beside it. Defined as CSS custom
properties in `apps/web/src/index.css`; both themes ship.

```
                     dark (default)      light
--paper              #0d1220             #f1f3fa      the page
--paper-raised       #151b2c             #fbfcfe      cards, panels
--paper-sunk         #080b15             #e2e6f2      wells, tracks
--ink                #e9ecf7             #121729      body
--ink-dim            #a7aecb             #414965      secondary
--ink-faint          #8b93b3             #59617e      eyebrows, small print
--rule               #242b42             #cbd1e3      hairlines
--rule-strong        #5d6789             #7b83a1      structural dividers
--accent             #67d3e8             #0f5f77      THE accent. Used sparingly.
--verified           #63d3a4             #136b4c      claim supported, rule passed
--caution            #e3bd6b             #7a5410      unknown / needs your input
--redline            #ef8f95             #a8353f      redlined field, unsupported claim
```

Why tinted neutrals. A true-gray ramp plus one accent is the shape almost every interface
defaults to, and the warm beige-and-stone scheme that briefly replaced it here is the other
default. Neither reads as a decision anybody made. A palette whose greys are all one hue
does, and it costs nothing — the tint is small enough that no surface reads as coloured, and
large enough that the whole screen agrees with itself.

An earlier palette drew its accent and its three signals from four unrelated places — azure,
green, amber, coral — so five hues shared a screen and the interface read as a dashboard
rather than as a document.

Discipline: **the accent is the only decorative colour.** Moss, ochre and terracotta are
reserved for the verification states in docs/05 and docs/06 — if something is green it means
a claim was verified, not that it is a nice button. A UI where colour is load-bearing cannot
also use colour for flair.

And colour is never the only carrier. Every signal is paired with a Lucide icon at its call
site — a drawn mark, not a typed glyph — so the state survives a monochrome screen and a
colour-blind reader. That pairing is what allowed the hues to be quietened this far.
`lucide-react` is the only icon dependency; there are no emoji anywhere in the interface.

## Type scale

Seven steps, each named, declared as theme tokens in `index.css`. Twelve distinct sizes were
in use across 158 call sites before this, every one an arbitrary value — `text-[0.9375rem]`
sixty-four times, `text-[0.6875rem]` once. That is not a scale but a pile of exceptions, and
it is why two paragraphs doing the same job on different screens did not look alike. Four
sizes were folded into their nearest neighbour, since a 1px difference is not a decision
anybody made deliberately.

```
--text-2xs    0.75rem     mono eyebrows, badges, field keys
--text-xs     0.875rem    fine print, hints
--text-sm     0.9375rem   secondary prose
--text-base   1rem        body
--text-lg     1.125rem    lead paragraphs, the G3 answer
--text-xl     1.25rem     section subheads
--text-2xl    1.75rem     page subheads
```

The page title is fluid rather than stepped: `clamp(2.25rem, 1.35rem + 3.8vw, 4rem)`. It was
52px below `sm` and 64px above, so a 375px phone rendered a 52px headline across a 327px
column — three words to a line, with the running head taking most of the first screen before
a word of content.

## Background and depth

Not flat fills, and no images:

1. A **drafting grid** — a repeating linear gradient at low alpha (`--grid-alpha`), so
   surfaces read as a working surface rather than as `<div>`s.
2. A soft **glow** — an off-centre radial gradient (`--glow-alpha`), which is what keeps the
   dark theme from reading as a black rectangle.

Both alphas are tokens, so the depth can be tuned in one place per theme.

## Motion

One orchestrated arrival beats twenty fidgety micro-interactions.

- **Page load:** a staggered reveal down the page via `animation-delay` steps of 60ms —
  masthead, then each section, then list rows. CSS only.
- **Stamps:** state changes that represent a human decision (approve a posting, approve an
  answer, mark submitted) animate as a rubber stamp — a fast scale-down from 1.4 with a
  slight rotation and an opacity settle. These are the moments the whole app is about, so
  they're the only place with a showy animation.
- **Rules draw in:** section hairlines animate `scaleX` from 0 on first paint.
- Everything respects `prefers-reduced-motion: reduce`, which collapses all of the above to
  a plain opacity fade.

## Layout

Editorial, not dashboard:

- A **running head** across the top — project name, current section, and the gate you're at
  — set in small caps with a hairline under it. It's a document header.
- **Numbered sections** (`01`, `02`) in the margin, mono, dim. Reinforces "file, in order."
- Asymmetric measure: prose columns cap at ~68ch for readability; data tables run full width.
- Hairline rules instead of card borders and shadows wherever possible. Cards are for things
  you can act on; everything else is ruled sections.

## Components carrying meaning

| Element | Treatment |
| --- | --- |
| Verbatim JD quote | Plex Mono, `--ink-dim`, left accent hairline border, slight indent — a pull quote from a source |
| Requirement pass/fail | Icon + text + color; never color alone |
| Claim highlight | Underline in the verdict color, not a background fill — the text stays readable |
| Redlined field | Oxblood hatch pattern (repeating-linear-gradient), not a plain red box — reads as "struck out," not "error" |
| Gate | Numbered `G1`–`G4` in mono, with the stamp animation on completion |
| Score bar | Thin ruled bar with an accent fill, breakdown shown as stacked hairlines |

## Accessibility, which the aesthetic must not cost

### Measured contrast

Not asserted — computed against the tokens as they ship. Every value is a ratio against
`--paper` in that theme. Target: every text colour ≥ 4.5:1 against all three surfaces.

| Token | Dark | Light |
| --- | --- | --- |
| `--ink` (body) | 15.58 | 15.31 |
| `--ink-dim` | 8.70 | 6.65 |
| `--ink-faint` (eyebrows, small print) | 6.23 | 5.68 |
| `--accent` | 7.47 | 6.60 |
| `--verified` | 7.80 | 5.91 |
| `--caution` | 8.37 | 5.27 |
| `--redline` | 6.83 | 5.40 |

`--rule` sits at about 1.6 in both themes and is decorative by design — a hairline, never
a carrier of meaning. `--rule-strong` is the structural divider. The lowest text ratio
anywhere, across all three surfaces in both themes, is 4.75 (`--caution` on light
`--paper-sunk`).

Light mode failed three of these on its first pass and the tokens were deepened until it
did not. Re-measure after any palette edit: the ratios are cheap to compute and the claim
is worthless unchecked. The numbers above were re-measured when this document was corrected,
because for a while it described a palette the app no longer had — which is the failure mode
this instruction exists to prevent.
- Color is never the only signal — every state has an icon and a text label.
- Focus rings are a 2px accent outline with a 2px offset, visible on every interactive
  element, never removed.
- `prefers-reduced-motion` and `prefers-color-scheme` both honored; theme is also
  manually overridable.
- Serif body text is set at 17px with generous leading, which reads better than 14px sans
  for the long-form content this app is full of.
