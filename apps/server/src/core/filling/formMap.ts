/// <reference lib="dom" />
/**
 * Reading a page into a FormMap — docs/07-form-automation.md § Building a FormMap.
 *
 * The whole page is read before anything is typed. That ordering is deliberate: it means
 * the redline pass and the "what is unknown here?" question are both answered while the
 * form is still untouched, so a run can be abandoned without having half-filled it.
 *
 * WHERE THE LABEL ACTUALLY LIVES. Six places, in descending reliability, because real ATS
 * forms use all of them and several use different ones on the same page:
 *
 *   1. `aria-labelledby` pointing at an element  (explicit, and survives restyling)
 *   2. `<label for=...>` or a wrapping `<label>` (the standard)
 *   3. `aria-label`                              (explicit, common in component libraries)
 *   4. a preceding sibling's text                (the ATS div-soup pattern)
 *   5. the enclosing container's own first text  (worse, but still better than nothing)
 *   6. `placeholder`                             (weakest; often an example, not a name)
 *
 * Extraction runs inside the page rather than over a serialized DOM, because resolving a
 * label means walking the tree — through open shadow roots — and reading computed style,
 * and shipping the whole document back to Node to do that would be slower and lossier.
 */
import { randomUUID } from 'node:crypto';
import type { Frame, Page } from 'playwright';
import type { FormField } from '@ia/shared';
import { ulid } from 'ulid';
import { logger } from '../../infra/logger';
import { classifyField, type FieldDescriptor } from './classify';
import { checkRedline } from './redlines';
import { FILLABLE_CONTROLS } from './selectors';

/** What the in-page scanner returns, before classification happens in Node. */
interface RawField extends FieldDescriptor {
  locator: string;
  control: FormField['control'];
  required: boolean;
  maxLength?: number;
  options?: Array<{ value: string; label: string; locator?: string }>;
  visible: boolean;
  /** Radio only: this input's own choice text, as distinct from the group's question. */
  optionLabel?: string;
  /** Radio only: the question the whole group answers, from its fieldset legend. */
  groupLabel?: string;
  /** Radio only: the value attribute, which is what distinguishes it within its group. */
  optionValue?: string;
}

/**
 * Runs inside the browser. Written as a single self-contained function because Playwright
 * serializes it across the boundary — it cannot close over anything from this module.
 *
 * `selector` is FILLABLE_CONTROLS, handed in as an argument for exactly that reason. It used
 * to be a second copy of the same string written out here, with a comment saying a test
 * asserted the two matched. No such test existed, and a drift between them is not a cosmetic
 * problem: this walk numbers the controls that an index locator later resolves with
 * `.nth()`, so the two disagreeing lands a typed value on the wrong element — and the
 * exclusions in that string are what keep `input[type=image]` out of a list the fill path
 * clicks, which on that element submits the form.
 */
/* c8 ignore start — executes in the page context, covered by the fixture tests. */
const SCAN = (selector: string): unknown => {
  const text = (el: Element | null): string =>
    (el?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);

  /**
   * The tree an element's ids are scoped to: its shadow root, or the document.
   *
   * Strategies 1 and 2 used to query `document` directly, which is wrong in both
   * directions for a control inside a shadow root. It cannot see the label sitting beside
   * it in the same shadow root, so the two strongest strategies silently returned nothing
   * — and ids are scoped per root, so a light-DOM element that happens to share the id
   * could be returned instead, giving the field a completely unrelated label at the
   * highest confidence the resolver has.
   */
  const rootOf = (el: HTMLElement): Document | ShadowRoot =>
    el.getRootNode() as Document | ShadowRoot;

  const labelFor = (el: HTMLElement): string => {
    const root = rootOf(el);
    // 1. aria-labelledby
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const joined = by
        .split(/\s+/)
        .map((id) => text(root.querySelector(`#${CSS.escape(id)}`)))
        .filter(Boolean)
        .join(' ');
      if (joined) return joined;
    }
    // 2. <label for> / wrapping label
    if (el.id) {
      const l = root.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l && text(l)) return text(l);
    }
    const wrapping = el.closest('label');
    if (wrapping && text(wrapping)) return text(wrapping);

    // 3. aria-label
    const aria = el.getAttribute('aria-label');
    if (aria?.trim()) return aria.trim();

    const CONTROLS = 'input, textarea, select, [role=combobox], [contenteditable=true]';

    // 4. previous sibling text, walking back over empty nodes.
    //
    // Stops at the first sibling that IS or CONTAINS another control. Without that guard
    // the walk sails past a neighbouring input and returns ITS label, which is worse than
    // returning nothing: the field gets confidently classified as the wrong thing.
    let prev = el.previousElementSibling;
    for (let i = 0; i < 3 && prev; i++) {
      if (prev.matches(CONTROLS) || prev.querySelector(CONTROLS)) break;
      const t = text(prev);
      if (t && t.length < 200) return t;
      prev = prev.previousElementSibling;
    }

    // 5. the container's own text, but ONLY when the container wraps this control alone.
    //
    // A <form> is also a parent, and searching it for something label-shaped would hand
    // back the first label on the page for every unlabelled field on it.
    const parent = el.parentElement;
    if (parent && parent.querySelectorAll(CONTROLS).length === 1) {
      const own = Array.from(parent.childNodes)
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => (n.textContent ?? '').trim())
        .filter(Boolean)
        .join(' ');
      if (own) return own.slice(0, 200);
      const labelish = parent.querySelector('[class*="label" i], legend, dt, h1, h2, h3, h4');
      if (labelish && text(labelish)) return text(labelish);
    }

    // 6. placeholder, last
    return (el.getAttribute('placeholder') ?? '').trim();
  };

  /**
   * A radio's OWN choice text — "Yes", not "Are you authorized to work?".
   *
   * Deliberately narrower than labelFor, which starts at aria-labelledby and so returns
   * the group's legend for every radio in the group. Ticking a radio on the strength of
   * that label means ticking one without knowing which choice it is.
   */
  const optionLabelFor = (el: HTMLElement): string => {
    if (el.id) {
      const l = rootOf(el).querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l) return text(l);
    }
    const wrapping = el.closest('label');
    if (wrapping) return text(wrapping);
    const aria = (el.getAttribute('aria-label') ?? '').trim();
    if (aria) return aria;
    const sib = el.nextElementSibling;
    if (sib && !sib.matches('input, select, textarea')) return text(sib);
    return (el.getAttribute('value') ?? '').trim();
  };

  /** The question a radio group answers, which lives on the fieldset, not the input. */
  /**
   * The heading of the block a control sits inside — a fieldset legend, a table caption, the
   * heading that opens a section.
   *
   * A label on its own cannot tell two identical questions apart: the "Start Date" column of
   * a work-history table and the "Start date" this internship asks about are the same six
   * characters, and the classifier only ever saw the label. So a row of the applicant's
   * employment history was filled with the date they become AVAILABLE, at 0.92 confidence,
   * verified by read-back and shown in the review as a field that went right — a false
   * statement about their work history in a document submitted in their name.
   *
   * Nearest container wins, and it is read from the shapes forms actually use rather than
   * from a class name: a legend, a caption, an aria-label on the group, or the last heading
   * before the block. An empty string means nothing was found, which the classifier treats as
   * "no container known" rather than as "top level".
   */
  const sectionFor = (el: HTMLElement): string => {
    const block = el.closest('fieldset, table, section, [role=group], [role=region]');
    if (!block) return '';

    const legend = block.querySelector('legend, caption');
    if (legend) return text(legend);

    const aria = (block.getAttribute('aria-label') ?? '').trim();
    if (aria) return aria;

    // The heading that introduces the block, whether it is inside it or immediately above.
    const inside = block.querySelector('h1, h2, h3, h4, h5, h6');
    if (inside) return text(inside);
    for (let sib = block.previousElementSibling; sib; sib = sib.previousElementSibling) {
      if (/^h[1-6]$/i.test(sib.tagName)) return text(sib);
    }
    return '';
  };

  const groupLabelFor = (el: HTMLElement): string => {
    const group = el.closest('fieldset, [role=radiogroup]');
    if (!group) return '';
    const legend = group.querySelector('legend');
    if (legend) return text(legend);
    const aria = (group.getAttribute('aria-label') ?? '').trim();
    if (aria) return aria;
    const by = group.getAttribute('aria-labelledby');
    if (by) {
      const parts = by
        .split(/\s+/)
        .map((id) => text(rootOf(el).querySelector(`#${CSS.escape(id)}`)))
        .filter(Boolean);
      if (parts.length) return parts.join(' ');
    }
    return '';
  };

  /**
   * One step up the composed tree: the parent element, or the host of the shadow root the
   * element sits at the top of.
   *
   * A shadow root is a document fragment, so `parentElement` is null there and a plain
   * parent walk ends at the boundary instead of carrying on into the page. Reading the host
   * is what makes a walk continue across as many nested roots as a component library cares
   * to build.
   */
  const ancestorOf = (el: HTMLElement): HTMLElement | null => {
    if (el.parentElement) return el.parentElement;
    const root = el.getRootNode() as { host?: HTMLElement };
    // A Document is also a root and has no host, which is where the walk genuinely ends.
    return root.host ?? null;
  };

  /**
   * Is this control really on screen?
   *
   * A bounding box alone was wrong in both directions, and each direction cost something
   * different.
   *
   * `visibility: hidden` and `opacity: 0` keep a non-zero rect, so those fields were
   * classified, planned, and then spent the full five-second wait before failing — noise
   * in a report whose entire value is that its warnings mean something.
   *
   * The other direction is worse. A field parked off-screen at `left: -9999px` has a
   * perfectly good rect and Playwright considers it visible, so the tool typed into it.
   * That is the classic honeypot, and honeypots are deliberately given attractive names
   * — "email", "website" — precisely so a classifier recognizes them. Filling one is how
   * a form decides you are a bot.
   *
   * THE CHECKS HAVE TO WALK UP THE TREE, because none of the properties that hide a field
   * have to be set on the field itself. `getComputedStyle` does not inherit `opacity`, so a
   * honeypot inside `<div style="opacity:0">` reported opacity 1, a full-size rect and
   * `visibility: visible` — it passed every test here, was classified "Email Address" at
   * 0.97, and had the applicant's real address typed into it. The same for a wrapper with
   * `height: 0; overflow: hidden`, which clips its children away without touching their
   * rects. Both are as common a honeypot as `left: -9999px`, and because nothing re-reads
   * the label at fill time (see `locatorFor` below) the run signed off "ok" over a form
   * that had just flagged the applicant as a bot.
   *
   * AND THE TREE IT WALKS IS THE COMPOSED ONE, host by host, not the light DOM alone.
   * `parentElement` is null at the top of a shadow tree, because a ShadowRoot is a document
   * fragment and not an element — so the walk simply stopped there and every control inside
   * an open shadow root, at any depth, skipped all of these checks. The same two honeypots
   * wrapped in a custom element came back "Email address" at 0.97 with nothing above them
   * ever examined, which is the ordinary shape of a design-system input: the fix above was
   * only ever half a fix while it could not cross a host.
   */
  const isVisible = (el: HTMLElement, rect: DOMRect): boolean => {
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    if (style.display === 'none') return false;
    if (Number(style.opacity) === 0) return false;
    // Off to the left or above the document entirely. A generous margin, because a field
    // in a horizontal carousel or a not-yet-opened accordion is legitimately off-viewport.
    if (rect.right < -500 || rect.bottom < -500) return false;

    // Only the two properties an ancestor can hide a child with WITHOUT that showing up in
    // the child's own computed style or rect. `visibility` and `display: none` are already
    // answered above — the first inherits, so the element's own value is the effective one
    // and a child that sets `visibility: visible` back on is genuinely visible; the second
    // leaves the child with a 0x0 rect.
    for (let a = ancestorOf(el); a; a = ancestorOf(a)) {
      const s = getComputedStyle(a);
      // Opacity is not inherited and a child cannot undo it, so a fully transparent
      // ancestor hides everything under it however solid the child's own style looks.
      if (Number(s.opacity) === 0) return false;
      // A clipping ancestor with no room in it. An ordinary `overflow: hidden` wrapper of a
      // normal size is everywhere in real forms and must keep its children fillable, and
      // `display: contents` and inline boxes are skipped because their rects say nothing
      // about what they clip.
      if (s.display === 'contents' || s.display === 'inline') continue;
      if (s.overflowX !== 'visible' || s.overflowY !== 'visible') {
        const r = a.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
      }
    }
    return true;
  };

  /**
   * How many elements on the page share each id, each name, and each name+value pair.
   *
   * Counted in one pass over the COMPOSED tree, which is the only count that answers the
   * question a locator actually asks. `document.querySelectorAll` does not enter shadow
   * roots and Playwright's CSS engine does, so the two disagreed in the worst possible
   * direction: two instances of the same web component, each with `<input id="inner"
   * name="email">` in its shadow root, were counted as one and handed the locator
   * `[name="email"]`, which Playwright then resolved to three elements. Every field of that
   * shape failed with a raw strict-mode error printed at the user as its note, and an id was
   * never counted at all — `#id` was returned on sight, so two components with the same
   * internal id could never be filled.
   *
   * Ids are counted over EVERY element, not just the fillable ones: a locator that resolves
   * to a control and a <div> is just as ambiguous as one resolving to two controls.
   */
  const idCounts = new Map<string, number>();
  const nameCounts = new Map<string, number>();
  const nameValueCounts = new Map<string, number>();
  const bump = (m: Map<string, number>, key: string): void => {
    m.set(key, (m.get(key) ?? 0) + 1);
  };
  const census = (node: Document | ShadowRoot | Element): void => {
    for (const child of Array.from(node.children ?? [])) {
      const el = child as HTMLElement;
      if (el.id) bump(idCounts, el.id);
      const name = el.getAttribute('name');
      if (name !== null) {
        bump(nameCounts, name);
        const value = el.getAttribute('value');
        // Joined through JSON so a name ending in a space cannot be confused with a
        // value beginning with one.
        if (value !== null) bump(nameValueCounts, JSON.stringify([name, value]));
      }
      census(el);
      if (el.shadowRoot) census(el.shadowRoot);
    }
  };

  /** A selector that will still find this element later, and find only it. */
  const locatorFor = (el: HTMLElement, index: number): string => {
    if (el.id && idCounts.get(el.id) === 1) return `#${CSS.escape(el.id)}`;
    const name = el.getAttribute('name');
    if (name !== null && nameCounts.get(name) === 1) {
      return `[name="${CSS.escape(name)}"]`;
    }
    // Radios in a group share a name and are told apart by value, so the name alone can
    // never address one of them.
    const value = el.getAttribute('value');
    if (name !== null && value !== null) {
      const pair = JSON.stringify([name, value]);
      if (nameValueCounts.get(pair) === 1) {
        return `[name="${CSS.escape(name)}"][value="${CSS.escape(value)}"]`;
      }
    }
    // Fall back to position among all controls, in the composed order `collect` walks —
    // which is the order Playwright's `.nth()` resolves in.
    //
    // This is the weakest locator here and it has no safety net. The comment that used to
    // sit on this line claimed a label read-back at fill time caught a shifted index;
    // there is no such read-back anywhere in fill.ts, which reads the value only. A wrong
    // element that accepts what was typed is reported as "ok".
    return `__index__${String(index)}`;
  };

  const controlOf = (el: HTMLElement): string => {
    const tag = el.tagName.toLowerCase();
    if (tag === 'textarea') return 'textarea';
    if (tag === 'select') return (el as HTMLSelectElement).multiple ? 'multiselect' : 'select';
    if (el.getAttribute('role') === 'combobox') return 'combobox';
    if (el.isContentEditable) return 'richtext';
    const type = (el.getAttribute('type') ?? 'text').toLowerCase();
    if (type === 'radio') return 'radio';
    if (type === 'checkbox') return 'checkbox';
    if (type === 'file') return 'file';
    if (type === 'date' || type === 'month') return 'date';
    return 'text';
  };

  /**
   * Every fillable control, in COMPOSED ORDER — the order Playwright will see them in.
   *
   * An index locator is nothing but a position, and there is no label re-verification at
   * fill time, so a disagreement between this walk and `.nth()` means a wrong element that
   * accepts the typed value is reported "ok". Positions are also numbered here, before the
   * redline pass has removed anything, so a slip does not stop at putting the portfolio URL
   * in the GitHub box: it can land a value on a control the redline pass deliberately
   * refused to touch.
   *
   * Two orderings have been wrong here already. Collecting a whole root's light-DOM matches
   * before descending into any shadow root put every shadow control at the end, when
   * Playwright puts it where its host sits. Descending into a host's shadow root at the
   * host's own position fixed that for a host with nothing inside it in the light DOM — and
   * only for that host. Give the host slotted children, which is the ordinary shape of a
   * real web component, and the two orders cross again: Playwright walks the host's own
   * children first and reaches the shadow root afterwards. That is the order below, and it
   * is the one to preserve.
   */
  const collect = (node: Document | ShadowRoot | Element, out: HTMLElement[]): void => {
    for (const child of Array.from(node.children ?? [])) {
      const el = child as HTMLElement;
      if (el.matches(selector)) out.push(el);
      collect(el, out);
      if (el.shadowRoot) collect(el.shadowRoot, out);
    }
  };

  const els: HTMLElement[] = [];
  collect(document, els);
  // Counted before any locator is written, and over the whole page rather than per field,
  // because "is this id unique?" is a question about everything else on the page.
  census(document);

  return els.map((el, index) => {
    const control = controlOf(el);
    const input = el as HTMLInputElement & HTMLSelectElement;
    const label = labelFor(el);
    const rect = el.getBoundingClientRect();

    return {
      locator: locatorFor(el, index),
      label,
      optionLabel: control === 'radio' ? optionLabelFor(el) : undefined,
      groupLabel: control === 'radio' ? groupLabelFor(el) : undefined,
      section: sectionFor(el) || undefined,
      optionValue: control === 'radio' ? (el.getAttribute('value') ?? '') : undefined,
      name: el.getAttribute('name') ?? undefined,
      id: el.id || undefined,
      autocomplete: el.getAttribute('autocomplete') ?? undefined,
      placeholder: el.getAttribute('placeholder') ?? undefined,
      type: control === 'textarea' ? 'textarea' : (el.getAttribute('type') ?? undefined),
      control,
      // An asterisk in the label is how a great many forms mark required, and it is not
      // reflected in the attribute.
      required:
        el.hasAttribute('required') ||
        el.getAttribute('aria-required') === 'true' ||
        /\*\s*$/.test(label),
      maxLength: input.maxLength && input.maxLength > 0 ? input.maxLength : undefined,
      options:
        control === 'select' || control === 'multiselect'
          ? Array.from(input.options ?? []).map((o) => ({ value: o.value, label: o.text }))
          : undefined,
      visible: isVisible(el, rect),
    };
  });
};
/* c8 ignore stop */

/**
 * Helpers the browser has to be handed along with the scanner, as source text.
 *
 * SCAN is written as a closed-over-nothing function so Playwright can serialize it into the
 * page — but Playwright serializes the function's own source and nothing else, and the
 * compiler puts things next to it. Both ways the server actually starts (`npm start` and
 * `npm run dev`) go through tsx, whose esbuild transform keeps function names: every named
 * arrow in SCAN — `text`, `labelFor`, `collect` and the rest — is rewritten to
 * `__name(fn, "fn")`, and `__name` is declared once at MODULE scope, which the page never
 * receives. SCAN threw `__name is not defined` on the first line of every frame of every
 * page, scanFrame swallowed it as a lost frame, and the run told the user "0 fields found:
 * 0 fillable, 0 left for you, 0 not recognized" about a form with twenty inputs. Nothing was
 * typed and nothing was submitted, but the entire form-filling feature had never once run
 * outside the tests — and the tests passed because vitest transforms without keepNames.
 *
 * Declaring the helper alongside the scanner fixes it for any number of nested helpers, so
 * adding one to SCAN cannot bring this back. It is declared INSIDE the wrapper rather than
 * on `globalThis` because the page belongs to whoever's application form this is and adding
 * globals to it is not ours to do. If some future compiler injects a helper that is not
 * listed here, `scanExpression` refuses to build rather than letting the page fail quietly;
 * adding the name and its source text below is the whole repair.
 */
const PAGE_HELPERS: Record<string, string> = {
  __name: '(fn) => fn',
};

/**
 * Compiler helpers the serialized scanner calls that the page would not have.
 *
 * An injected helper is always CALLED, never merely mentioned, which is what separates it
 * from the `__index__` that appears inside a locator string.
 */
export function unshimmedHelpers(source: string): string[] {
  const missing = new Set<string>();
  for (const m of source.matchAll(/\b(__[A-Za-z][\w$]*)\s*\(/g)) {
    const name = m[1]!;
    if (!(name in PAGE_HELPERS)) missing.add(name);
  }
  return [...missing].sort();
}

/** The scanner as one expression the page can run with nothing else in scope. */
export function scanExpression(): string {
  const source = SCAN.toString();
  const missing = unshimmedHelpers(source);
  if (missing.length > 0) {
    throw new Error(
      `The page scanner was compiled against helpers the browser cannot see: ` +
        `${missing.join(', ')}. Add them to PAGE_HELPERS in formMap.ts.`,
    );
  }
  const preamble = Object.entries(PAGE_HELPERS)
    .map(([name, impl]) => `const ${name} = ${impl};`)
    .join(' ');
  // The one thing the scanner needs from this module. Handing it over as an argument is
  // what stops the page's copy of the fillable-control selector from drifting away from the
  // one `fill.ts` resolves index locators against.
  return `(() => { ${preamble} return (${source})(${JSON.stringify(FILLABLE_CONTROLS)}); })()`;
}

/**
 * How a frame is addressed once the page has been read.
 *
 * The URL alone is not an identity. Every `srcdoc` iframe reports `about:srcdoc` and every
 * blank one reports `about:blank`, so a page with two essay editors collapsed both onto the
 * first: the second answer overwrote the first, the second editor stayed empty, and both
 * were reported filled. Carrying the frame's position alongside its URL tells those apart,
 * and a position that no longer holds the same URL is treated as a frame that is gone
 * rather than quietly retargeted.
 */
export function frameKey(index: number, url: string): string {
  return `${String(index)}|${url}`;
}

/** Reads back what `frameKey` wrote. */
export function parseFrameKey(key: string): { index: number; url: string } {
  const at = key.indexOf('|');
  if (at < 0) return { index: -1, url: key };
  return { index: Number(key.slice(0, at)), url: key.slice(at + 1) };
}

export interface FormMap {
  url: string;
  /**
   * A mark left in the document the moment its controls were numbered.
   *
   * The URL cannot answer "is this still the same document": `?step=2` in the address bar is
   * a new document after `location.href =` and the same one after `history.pushState`, which
   * is what an application form built as a single-page app does on every step. A value on
   * `window` can answer it — a real navigation throws the window away and takes the mark with
   * it, a pushState does not — so this is what `executePlan` re-reads after each field.
   *
   * Undefined when the stamp could not be written, which a strict CSP can cause. The check
   * then falls back to the URL comparison alone, which is where it was before.
   */
  documentToken?: string;
  fields: FormField[];
  /** Fields that were found but cannot be acted on, kept so the UI can list them. */
  unknown: FormField[];
  redlined: FormField[];
}

/**
 * Playwright's own words for "that frame is not there any more".
 *
 * A frame navigating or detaching mid-scan is normal on a form that re-renders while it is
 * being read, and losing one is survivable. Anything else is a fault in this file, and
 * returning an empty list for it is precisely how a scanner that had never worked outside
 * the tests looked like a page with no fields on it.
 */
const FRAME_GONE =
  /execution context was destroyed|frame (was |got )?detached|target (page, context or browser )?(has been )?closed|navigating and changing the content|cannot find context/i;

async function scanFrame(frame: Frame): Promise<RawField[]> {
  const expression = scanExpression();
  try {
    return (await frame.evaluate(expression)) as RawField[];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (FRAME_GONE.test(message)) {
      logger.warn({ frame: frame.url(), err: message }, 'frame went away while it was read');
      return [];
    }
    logger.error({ frame: frame.url(), err: message }, 'the page scanner failed');
    throw err;
  }
}

/**
 * Reads every frame of the page into one map.
 *
 * Invisible controls are dropped: forms routinely carry hidden inputs for CSRF tokens and
 * for the branches of a conditional the user has not reached, and neither is ours to fill.
 */
/**
 * Collapses each radio group into one field whose options are its buttons.
 *
 * A radio group is one question with several answers, but the scanner sees N independent
 * inputs — and when the label resolver reaches the fieldset's legend, all N carry the
 * same question as their label. That produced N fields with identical semantics, each
 * ticked in turn, the last one silently unticking the rest, and read-backs recorded for
 * choices that were no longer selected. Whether the tool had ticked "Yes" or "No" was
 * decided by document order.
 *
 * Grouped, the question is the field and the buttons are its options, so choosing means
 * matching the intended value against each button's own text.
 */
function groupRadios(raw: RawField[]): RawField[] {
  const out: RawField[] = [];
  const groups = new Map<string, number>();

  for (const r of raw) {
    if (r.control !== 'radio' || !r.name) {
      out.push(r);
      continue;
    }

    const resolved = r.label ?? '';
    const option = {
      value: r.optionValue || r.optionLabel || resolved,
      label: r.optionLabel || r.optionValue || resolved,
      locator: r.locator,
    };

    const at = groups.get(r.name);
    if (at === undefined) {
      groups.set(r.name, out.length);
      out.push({
        ...r,
        // The group's question, when the page states one. Falling back to this radio's
        // resolved label keeps the old behaviour for an ungrouped stray.
        label: r.groupLabel || r.label,
        options: [option],
        // A group with no visible member is not fillable; visible if any member is.
        visible: r.visible,
      });
    } else {
      const existing = out[at]!;
      existing.options = [...(existing.options ?? []), option];
      existing.visible ||= r.visible;
      existing.required ||= r.required;
    }
  }

  return out;
}

export async function buildFormMap(page: Page): Promise<FormMap> {
  const fields: FormField[] = [];

  const frames = page.frames();
  for (const [frameIndex, frame] of frames.entries()) {
    const raw = groupRadios(await scanFrame(frame));
    const isMain = frame === page.mainFrame();

    raw.forEach((r) => {
      if (!r.visible) return;

      const classification = classifyField(r);
      const red = checkRedline(r);

      fields.push({
        id: ulid(),
        // The scanner's own position within this frame, carried through untouched. It
        // used to be re-derived from this loop's index as well, which happened to agree
        // — until grouping radios made the two disagree and every index locator after
        // the first radio group pointed at the wrong element.
        locator: r.locator,
        label: r.label || '(no label found)',
        // Carried onto the stored field, not only used for classification: the review screen
        // shows the student a list of labels, and two rows both reading "Start Date" are the
        // same six characters there too.
        section: r.section,
        control: r.control,
        required: r.required,
        maxLength: r.maxLength,
        options: r.options,
        semantic: classification.semantic,
        redlineCategory: red?.category,
        confidence: classification.confidence,
        frame: isMain ? undefined : frameKey(frameIndex, frame.url()),
      });
    });
  }

  return {
    url: page.url(),
    documentToken: await stampDocument(page),
    fields,
    unknown: fields.filter((f) => f.semantic === 'unknown'),
    redlined: fields.filter((f) => f.semantic === 'REDLINE'),
  };
}

/**
 * Marks the document, and hands back the mark.
 *
 * An ordinary property on `window`, which is exactly what makes it work: every navigation
 * builds a new window object and the property goes with the old one, while `history.pushState`
 * keeps both. NOT `window.name` — that survives same-origin navigation BY DESIGN, which is
 * the whole point of it, so a reload kept the stamp and this check answered "same document"
 * about a DOM that had just been rebuilt. Caught by the test below, which reloads and asks.
 *
 * Any failure — a CSP that refuses evaluation, a frame that has gone — answers undefined, and
 * the caller treats an absent stamp as "cannot tell" rather than as "it moved": a check that
 * fires when it is broken is worse than one that admits it does not know.
 */
async function stampDocument(page: Page): Promise<string | undefined> {
  const token = `ia-${randomUUID()}`;
  try {
    await page.evaluate((t: string) => {
      (window as unknown as Record<string, string>)['__iaDocumentToken'] = t;
    }, token);
    return token;
  } catch {
    return undefined;
  }
}

/**
 * Whether the page is still showing the document whose controls were numbered.
 *
 * Reads the stamp `stampDocument` left. A real navigation — `location.href =`, a form posting
 * to itself, a reload — builds a new window and the property goes with the old one; a
 * `history.pushState` step in a single-page application keeps both, and so keeps every locator
 * in the plan valid. The URL can distinguish neither case, which is why this exists.
 *
 * Lives here rather than in fill.ts because this is browser-side code, and this is the file
 * the lint rule against `window` on the server exempts for exactly that reason.
 *
 * An absent expected token means the stamp could not be written at all, and an unreadable page
 * means the question cannot be asked. Both answer true: this exists to catch a document that
 * went away, and a check that fires when it is merely broken would stop fills going fine.
 */
export async function stillSameDocument(
  page: Page,
  expected: string | undefined,
): Promise<boolean> {
  if (expected === undefined) return true;
  try {
    return (
      (await page.evaluate(
        () => (window as unknown as Record<string, string | undefined>)['__iaDocumentToken'],
      )) === expected
    );
  } catch {
    return true;
  }
}

/** One line for the run log and the pre-submit summary. */
export function summarizeMap(map: FormMap): string {
  const fillable = map.fields.length - map.unknown.length - map.redlined.length;
  return (
    `${map.fields.length} fields found: ${fillable} fillable, ` +
    `${map.redlined.length} left for you, ${map.unknown.length} not recognized.`
  );
}
