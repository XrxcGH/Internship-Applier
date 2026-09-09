import { ArrowRight, ExternalLink } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  daysUntil,
  decide,
  getMatch,
  listMatches,
  locationLabel,
  payLabel,
  recompute,
  REJECT_REASONS,
  termLabel,
  type MatchDetail,
  type MatchRow,
} from '../lib/matches';
import { queueKeyAction, type QueueKeyAction } from '../lib/queueKeys';
import { Page, RunningHead, Section } from '../components/Chrome';
import { Button, Empty, Notice } from '../components/Controls';
import { RequirementChecklist, ScoreBreakdownBars } from '../components/RequirementChecklist';

type Band = 'eligible' | 'eligible_and_unknown' | 'all';

const BADGE: Record<string, { label: string; color: string }> = {
  eligible: { label: 'eligible', color: 'var(--verified)' },
  unknown: { label: 'check', color: 'var(--caution)' },
  ineligible: { label: 'filtered', color: 'var(--redline)' },
};

/**
 * How much of a stored description the disclosure below the decision buttons will draw.
 *
 * A ceiling rather than the whole string because a few Workday postings carry forty thousand
 * characters of boilerplate, and the browser lays out every one of them the moment the
 * <details> opens.
 */
const DESCRIPTION_LIMIT = 8000;

/**
 * The description as it will be shown, and where it had to stop.
 *
 * `slice(0, 8000)` was applied unconditionally with nothing after it: no ellipsis, no note,
 * no link. The text simply ended, mid-sentence, under a summary that says "Full job
 * description" — and the paragraph an internship posting most often puts last is the one
 * naming a hard requirement ("must be a US citizen", "must be enrolled through spring 2028").
 * At G2 the user is deciding on that text; a cut it cannot see is a decision made on half a
 * posting.
 */
export function descriptionExcerpt(text: string): { shown: string; cutAt: number | null } {
  if (text.length <= DESCRIPTION_LIMIT) return { shown: text, cutAt: null };
  return { shown: `${text.slice(0, DESCRIPTION_LIMIT)}…`, cutAt: DESCRIPTION_LIMIT };
}

/** What the detail column has to draw right now. */
export type PaneState = 'failed' | 'loading' | 'ready';

/**
 * Three states, because the pane had one.
 *
 * It rendered on `current && detail`, and `detail` is set to null the instant the selection
 * moves and left null when the fetch rejects. So the column was blank while a match loaded
 * and blank forever after a match failed to load, and the two were indistinguishable from
 * each other and from a posting with nothing in it — beside a list of rows the user had just
 * clicked, at the gate where they are about to approve one.
 */
export function detailPaneState(detail: MatchDetail | null, error: string | null): PaneState {
  if (error !== null) return 'failed';
  return detail === null ? 'loading' : 'ready';
}

/**
 * Whether a keypress may act, given what the detail pane is actually showing.
 *
 * The four decision keys were armed from the moment a row was selected, and a row is
 * selected the instant the list lands — a whole round trip before its posting arrives, and
 * for good after that posting fails to arrive. So `a` pressed over "Reading the posting…"
 * created a real application, and `a` pressed over "This posting would not open." created one
 * too: an approval at G2 for a posting whose title, requirements, score and rationale the
 * user had never been shown. The buttons were not the hole — they render inside
 * `current && detail` and so are simply absent in both states — but this screen calls itself
 * keyboard-first, and the keys had no such door.
 *
 * `j`, `k` and Escape stay live in every state deliberately. Moving off a posting that will
 * not load is exactly what someone stuck at a dead pane needs to do, and a sheet that cannot
 * be closed is worse than one that cannot be opened.
 */
export function keyActionAllowed(action: QueueKeyAction, pane: PaneState): boolean {
  if (action === 'next' || action === 'prev' || action === 'close-sheet') return true;
  return pane === 'ready';
}

/**
 * The deadline chip on a queue row: what it says, and whether it is drawn in urgency red.
 *
 * `daysUntil` reads `closesAt` with `Date.parse`, and a date with no time — which is what
 * USAJOBS's ApplicationCloseDate and JSON-LD's validThrough both hand over — parses to the
 * FIRST instant of that day. So a posting closing "2026-09-09" turned red and read `closed`
 * from midnight UTC on the 9th, for the whole of the last day the student could still apply;
 * anywhere west of Greenwich it read `closed` before the 9th had begun locally.
 *
 * The server does not agree with that reading anywhere: `deadline` in eligibility.ts and the
 * closing sweep in refresh.ts both stretch a bare date to the end of its day, so the
 * checklist in the pane beside this chip said "Closes 2026-09-09 — met" while the row it was
 * opened from called the posting closed. A false `closed` is this queue hiding a job the
 * student could still have got, which is the direction this repo does not take.
 *
 * End of day in UTC, matching those two, rather than a local or generous one: eligibility.ts
 * records that a wider stretch was tried and reverted because it carries the deadline into
 * the following day. The other direction is untouched — a timestamp that has genuinely
 * passed, and a bare date from yesterday, both still read `closed`.
 */
export function deadlineChip(closesAt: string | null): { text: string; urgent: boolean } | null {
  const trimmed = closesAt?.trim() ?? null;
  const instant =
    trimmed !== null && /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? `${trimmed}T23:59:59.999Z` : trimmed;
  const days = daysUntil(instant);
  if (days === null) return null;
  return { text: days < 0 ? 'closed' : `${days}d left`, urgent: days < 7 };
}

/**
 * The review queue — docs/08 § Matches. Gate G2 lives here.
 *
 * Keyboard-first: triaging forty postings should feel like triaging email. There is
 * deliberately no bulk-approve and no multi-select — one posting, one decision.
 */
export function Matches({
  onOpenApplications,
  onOpenDiscovery,
  onBusy,
}: {
  onOpenApplications?: () => void;
  onOpenDiscovery?: () => void;
  onBusy?: (what: string | null) => void;
}) {
  const [rows, setRows] = useState<MatchRow[]>([]);
  /**
   * Whether the first list has come back yet.
   *
   * `listMatches` walks up to twenty pages one round trip at a time, so on a full store the
   * first answer takes seconds — and for every one of them `rows` is empty, which the empty
   * state below read as "Nothing in the queue." The screen asserted the queue was empty and
   * pointed the user at Discover, over a queue that was about to fill.
   */
  const [loaded, setLoaded] = useState(false);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [band, setBand] = useState<Band>('eligible_and_unknown');
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<MatchDetail | null>(null);
  /**
   * A failed detail fetch, kept beside the pane it belongs to rather than in the page banner.
   *
   * The catch below set the page-level `error`, at the top of the screen above the band
   * chips, while the pane the user was looking at stayed empty — so the posting they had just
   * clicked read as one with no title, no requirements and no score, and the sentence saying
   * why was somewhere off the top of a scrolled queue. The message belongs where the hole is.
   */
  const [detailError, setDetailError] = useState<string | null>(null);
  /** Bumped by the pane's own "Try again", which is what re-runs the fetch below. */
  const [detailAttempt, setDetailAttempt] = useState(0);
  const [rejecting, setRejecting] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  /**
   * The in-flight guard for triage actions.
   *
   * A ref rather than the `busy` state, because the keyboard handler and the action it
   * calls are both closures captured at render: a second keypress inside one round-trip
   * would read the stale `busy` and go through anyway. A ref is current at the moment it
   * is read, which is what a guard has to be.
   */
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  /** Approvals made this session, so triage never has to stop to go look at them. */
  const [approved, setApproved] = useState(0);
  /**
   * Decisions of any kind made this session, so the empty state can tell two cases apart.
   *
   * `act` and `reject` drop the decided row from `rows` locally rather than reloading, so
   * deciding the last posting in a band empties the list — and the empty state then told the
   * student "either nothing has been searched yet, or what is stored has not been scored" and
   * sent them to Discover, about postings they had personally just triaged, with the counts
   * chip beside it still showing them.
   */
  const [decided, setDecided] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  // The nav lives above this screen and unmounting it would throw the in-flight guard away,
  // so what is running has to be visible up there. Recompute is the expensive one: it
  // re-extracts requirements with the model, at cost. See the comment on `Nav`.
  useEffect(() => onBusy?.(busy), [busy, onBusy]);

  /**
   * Only the newest list is allowed to paint.
   *
   * `listMatches` walks up to twenty pages one round trip at a time, so "all" is reliably
   * slower to come back than "eligible". Switch bands while the wider one is still walking
   * and its answer landed last: the queue filled with the rows and the counts of a band
   * nobody had selected, sitting under the chip for the band they had. The detail fetch
   * just below already guards itself this way; the list did not.
   *
   * A sequence number rather than a per-effect cancellation flag, because the "Recompute"
   * button calls this too and that call has no effect to be torn down.
   */
  const listSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = (listSeq.current += 1);
    setError(null);
    try {
      const r = await listMatches({ eligibility: band, minScore: 0, hideDecided: true });
      if (seq !== listSeq.current) return;
      setLoaded(true);
      setRows(r.matches);
      setCounts(r.counts);
      // Validated against the rows that just arrived. Keeping a selection that is not in
      // the new band left the detail pane blank beside a populated list — no message, no
      // empty state, nothing to click.
      setSelected((prev) =>
        prev !== null && r.matches.some((m) => m.id === prev) ? prev : (r.matches[0]?.id ?? null),
      );
    } catch (e) {
      if (seq !== listSeq.current) return;
      // Loaded in the sense that matters here: the fetch is over, so the empty state is no
      // longer speaking for a request still in flight. The error banner says what happened.
      setLoaded(true);
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [band]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    // Cleared first. Without this the pane rendered the PREVIOUS posting's title,
    // rationale, requirements and score beside the NEW posting's location, because
    // the selected row updates synchronously and the detail only when the fetch resolves.
    // On a failed fetch the mismatch stayed on screen for the rest of the session.
    setDetail(null);
    // And the previous posting's failure with it, or moving off a match that would not load
    // left its error sitting over the next one, which loads fine.
    setDetailError(null);
    // And the reject sheet, which belongs to the posting it was opened over. Clicking a
    // different row with the sheet open left `rejecting` true while the pane holding it was
    // unmounted: the seven reason buttons vanished, every key but Escape stayed swallowed by
    // a sheet nobody could see, and when the new posting landed the sheet reappeared over IT
    // — one press from filing "Pay is too low" against a posting picked for another reason
    // entirely. Same class as the armed keys above: a G2 decision must land on the posting
    // the user was actually judging.
    setRejecting(false);
    if (!selected) return;
    let cancelled = false;
    getMatch(selected)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch((e: unknown) => {
        if (!cancelled) setDetailError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [selected, detailAttempt]);

  const move = useCallback(
    (delta: number) => {
      setSelected((cur) => {
        const i = rows.findIndex((r) => r.id === cur);
        const next = rows[Math.max(0, Math.min(rows.length - 1, i + delta))];
        return next?.id ?? cur;
      });
    },
    [rows],
  );

  const act = useCallback(
    async (action: 'approved' | 'skipped' | 'saved', reason?: string, tags: string[] = []) => {
      // One decision at a time. Two 'a' presses inside one round-trip both decided the
      // same match: the banner counted two applications for one, and the second row
      // removal indexed a list the id had already left, blanking the detail pane.
      if (!selected || busyRef.current) return;
      busyRef.current = true;
      setBusy(action === 'approved' ? 'Approving' : action === 'saved' ? 'Saving' : 'Skipping');
      try {
        const r = await decide(selected, action, reason, tags);
        setDecided((n) => n + 1);
        if (action === 'approved' && r.applicationId) setApproved((n) => n + 1);
        setRows((prev) => {
          const i = prev.findIndex((x) => x.id === selected);
          const next = prev.filter((x) => x.id !== selected);
          setSelected(next[Math.min(i, next.length - 1)]?.id ?? null);
          return next;
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        busyRef.current = false;
        setBusy(null);
        setRejecting(false);
      }
    },
    [selected],
  );

  const reject = useCallback(
    async (tag: string, label: string) => {
      if (!selected || busyRef.current) return;
      busyRef.current = true;
      setBusy('Rejecting');
      try {
        await decide(selected, 'rejected', label, [tag]);
        setDecided((n) => n + 1);
        setRows((prev) => {
          const i = prev.findIndex((x) => x.id === selected);
          const next = prev.filter((x) => x.id !== selected);
          setSelected(next[Math.min(i, next.length - 1)]?.id ?? null);
          return next;
        });
      } catch (e) {
        // The catch act() has always had. Without it a failed rejection became an
        // unhandled promise rejection, the sheet still closed, and the UI looked like it
        // had worked while the row stayed in the queue.
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        busyRef.current = false;
        setBusy(null);
        setRejecting(false);
      }
    },
    [selected],
  );

  // Read once and shared, because the pane's three states now decide two things: what the
  // detail column draws, and whether a decision key is allowed to fire over it.
  const pane = detailPaneState(detail, detailError);

  // Keyboard triage. What each press means — and the chords that mean nothing here — is
  // decided by queueKeyAction, which is tested on its own; whether that meaning may be acted
  // on over what is currently drawn is decided by keyActionAllowed, likewise.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = queueKeyAction(e, { rejecting });
      if (action === null) return;
      // Not ours to swallow either: a key that may not act does not get preventDefault. The
      // pane says out loud, in both states where this returns false, that decisions are held
      // — a press that vanishes without a word is the thing being fixed, not the fix.
      if (!keyActionAllowed(action, pane)) return;
      // Escape is left alone deliberately: it closes dialogs and leaves full screen, and
      // taking it over so the sheet can close is not worth breaking either of those.
      if (action !== 'close-sheet') e.preventDefault();
      switch (action) {
        case 'next':
          move(1);
          break;
        case 'prev':
          move(-1);
          break;
        case 'approve':
          void act('approved');
          break;
        case 'skip':
          void act('skipped');
          break;
        case 'reject':
          setRejecting(true);
          break;
        case 'save':
          void act('saved');
          break;
        case 'close-sheet':
          setRejecting(false);
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [move, act, rejecting, pane]);

  /**
   * Focus follows the selection, not just the scroll.
   *
   * j and k move the selection and swap the entire detail pane — posting title, rationale,
   * requirements, score, and the four decision buttons — and this effect only scrolled. Focus
   * stayed wherever it was and the replaced content sits in no live region, so on the screen
   * this file describes as keyboard-first, a keyboard user pressing j heard nothing at all and
   * then acted on a posting they had not been told they were looking at.
   *
   * Focusing the row itself rather than announcing separately: the row IS the label for what
   * the pane now shows, so moving focus there reads the company and title without a second
   * copy of them living in a live region that could disagree with the pane.
   *
   * `preventScroll` because the scroll below places the row deliberately: `block: 'nearest'`
   * keeps the list still, where focusing alone would jump the row to the centre.
   */
  useEffect(() => {
    const row = listRef.current?.querySelector<HTMLElement>(`[data-id="${selected}"]`);
    row?.querySelector('button')?.focus({ preventScroll: true });
    row?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const current = rows.find((r) => r.id === selected);

  return (
    <Page>
      {/* Every other gated screen carries a lede saying what its gate does — G1's on
          Onboarding, G3's on Applications, and Discover's "it arrives as a posting for you to
          judge at G2". The screen where G2 actually happens named the gate and said nothing,
          so the one irreversible-feeling decision on it went unexplained. */}
      <RunningHead
        section="The queue"
        gate="G2"
        lede={
          <>
            One posting, one decision. <strong>Approving creates an application</strong> you then
            write and review at G3 — nothing is sent to anyone, here or there.
          </>
        }
      />

      <div className="a-rise a-step-2 mb-6 flex flex-wrap items-center gap-2.5">
        {(
          [
            ['eligible', 'Eligible'],
            ['eligible_and_unknown', 'Eligible + check'],
            ['all', 'Everything, incl. filtered'],
          ] as Array<[Band, string]>
        ).map(([value, label]) => (
          /* `aria-pressed` because which band is showing was signalled by colour alone —
             a tinted border and background, nothing else — against this repo's own standard
             that colour is never the only signal. A screen-reader user could hear the three
             options and not which one they were looking at. */
          <button
            key={value}
            onClick={() => setBand(value)}
            aria-pressed={band === value}
            className={`u-data rounded-full border px-3.5 py-1.5 text-2xs tracking-wide uppercase transition-colors ${
              band === value
                ? 'border-accent text-accent bg-accent/10'
                : 'border-rule text-faint hover:text-dim hover:border-rule-strong'
            }`}
          >
            {label}
          </button>
        ))}
        <span className="u-data text-faint ml-auto text-2xs">
          {counts['eligible'] ?? 0} eligible · {counts['unknown'] ?? 0} to check ·{' '}
          {counts['ineligible'] ?? 0} filtered
        </span>
        {/* Guarded by the same ref as the triage actions, and greyed out while it runs.
            This was the one control on the page with neither: a recompute takes a while
            and answers nothing until it is done, so a second impatient click started a
            second full matching run — which re-extracts requirements with the model, at
            cost, for postings the first run is extracting at that moment. Whichever run
            finished first also cleared the "Recomputing…" line, so the rest carried on
            invisibly. */}
        <Button
          size="sm"
          disabled={busy !== null}
          onClick={() => {
            if (busyRef.current) return;
            busyRef.current = true;
            setBusy('Recomputing');
            void recompute()
              .then(load)
              .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
              .finally(() => {
                busyRef.current = false;
                setBusy(null);
              });
          }}
        >
          Recompute
        </Button>
      </div>

      {error && <Notice tone="redline">{error}</Notice>}
      {/* A live region, as Discover has. Recompute takes as long as it takes and says
          nothing while it runs, so a screen-reader user pressing it got no announcement that
          anything had started or finished. */}
      <div role="status" aria-live="polite">
        {busy && <p className="u-data text-accent a-pulse mb-4">{busy}…</p>}
      </div>

      {/* Approvals accumulate without interrupting triage — the link is there when wanted. */}
      {approved > 0 && (
        <div className="u-tint-verified mb-6 flex flex-wrap items-center justify-between gap-3 rounded px-4 py-3">
          <span className="text-dim text-base">
            {approved === 1 ? '1 application created' : `${approved} applications created`}. Answers
            are waiting for your review.
          </span>
          {onOpenApplications && (
            <Button size="sm" variant="primary" onClick={onOpenApplications}>
              Review answers (G3)
              <ArrowRight aria-hidden size={15} />
            </Button>
          )}
        </div>
      )}

      {/* This once opened with "Run discovery" and there was no screen, button or shortcut
          anywhere in the app that ran discovery, so someone told at G1 that confirming
          unlocks discovery arrived here, pressed the only button, and got the same empty
          queue back. It then said so plainly and quoted the two endpoints to POST by hand.
          Discover exists now, so this points at it — and at the other reason the queue can
          look empty, which is postings that are stored but have never been scored. */}
      {!loaded && !error && <p className="text-dim a-pulse">Reading the queue…</p>}

      {loaded && rows.length === 0 && !error && (
        /* Two different empty queues, and only one of them is a problem. Reaching the end of
           a band you have just triaged is the ordinary, successful ending of this screen, and
           it was met with the diagnosis written for a queue that had never been filled. */
        <Empty title={decided > 0 ? 'That is the whole band.' : 'Nothing in the queue.'}>
          {decided > 0 ? (
            <p>
              You decided {decided} {decided === 1 ? 'posting' : 'postings'} just now, and there are
              none left in this band. Widen the band above to see what was filtered out and why, or
              search again for more.
            </p>
          ) : (
            <p>
              Either nothing has been searched yet, or what is stored has not been scored. Discover
              does both, and it also takes a single posting URL you paste in. Recompute, above,
              scores whatever is already here — and widening the band shows what was filtered out,
              and why.
            </p>
          )}
          {onOpenDiscovery && (
            <div className="mt-4 flex justify-center">
              <Button variant="primary" onClick={onOpenDiscovery}>
                {decided > 0 ? 'Search for more' : 'Go to Discover'}
                <ArrowRight aria-hidden size={15} />
              </Button>
            </div>
          )}
        </Empty>
      )}

      {/* The whole grid, not just the <ul>. The list carries `u-card` — border, radius,
          shadow, backdrop blur — and rendered with zero children whenever the queue is empty,
          during the first fetch, and after a failed load: a 21rem-wide, 2px-tall bordered
          sliver sitting beside an empty detail column, under the empty state that had already
          explained there was nothing. Guarding only the list would leave the grid's own gap
          behind. Applications.tsx already guards the identical shape. */}
      {rows.length > 0 && (
        <div className="grid gap-8 lg:grid-cols-[minmax(0,21rem)_minmax(0,1fr)]">
          {/* list */}
          <ul
            ref={listRef}
            className="u-card divide-rule/50 max-h-[calc(100dvh-13rem)] divide-y overflow-y-auto lg:sticky lg:top-20"
          >
            {rows.map((m) => {
              const deadline = deadlineChip(m.closesAt);
              const badge = BADGE[m.eligibility]!;
              return (
                <li key={m.id} data-id={m.id}>
                  <button
                    onClick={() => setSelected(m.id)}
                    aria-current={selected === m.id ? 'true' : undefined}
                    className={`relative w-full px-4 py-3.5 text-left transition-colors ${
                      selected === m.id ? 'bg-accent/10' : 'hover:bg-ink/[0.04]'
                    }`}
                  >
                    {selected === m.id && (
                      <span
                        className="absolute inset-y-0 left-0 w-[2px]"
                        style={{ background: 'var(--accent)' }}
                      />
                    )}
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-base">{m.title}</span>
                      <span className="u-data text-faint shrink-0 text-2xs">{m.score}</span>
                    </div>
                    <div className="text-dim mt-0.5 truncate text-sm">{m.company}</div>
                    <div className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1">
                      <span
                        className="u-data text-2xs tracking-widest uppercase"
                        style={{ color: badge.color }}
                      >
                        {badge.label}
                      </span>
                      <span className="u-data text-faint text-2xs">{locationLabel(m)}</span>
                      {deadline && (
                        <span
                          className="u-data text-2xs"
                          style={{
                            color: deadline.urgent ? 'var(--redline)' : 'var(--ink-faint)',
                          }}
                        >
                          {deadline.text}
                        </span>
                      )}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>

          {/* detail */}
          <div>
            {/* A slow read and a dead one said the same thing, which was nothing at all.
                Both now speak, and the failure carries the control that actually re-runs the
                fetch that failed rather than one that quietly re-reads something else. */}
            {pane === 'loading' && (
              <>
                <p className="text-dim a-pulse">Reading the posting…</p>
                {/* Said, not merely done. The decision keys are held in both of these
                    states — see keyActionAllowed — and a key that stops working without a
                    word is how someone comes to believe they approved something. */}
                <p className="text-faint mt-3 u-prose text-sm">
                  <span className="u-data">a</span>, <span className="u-data">s</span>,{' '}
                  <span className="u-data">l</span> and <span className="u-data">x</span> are held
                  until it is on screen — G2 is a decision about a posting you have read.{' '}
                  <span className="u-data">j</span> and <span className="u-data">k</span> still
                  move.
                </p>
              </>
            )}
            {pane === 'failed' && (
              <Notice tone="redline">
                <strong>This posting would not open.</strong> {detailError}
                <div className="mt-3">
                  <Button size="sm" onClick={() => setDetailAttempt((n) => n + 1)}>
                    Try again
                  </Button>
                </div>
                <p className="mt-3 u-prose text-sm">
                  Nothing about this posting is on screen, so the decision keys are held here too.{' '}
                  <span className="u-data">j</span> and <span className="u-data">k</span> still move
                  you off it.
                </p>
              </Notice>
            )}
            {current && detail && (
              <>
                <Section n="01" title="The posting" step={3}>
                  <div className="u-card px-5 py-5">
                    <h3 className="u-display mb-1 text-3xl">{detail.posting.title}</h3>
                    <p className="text-dim">{detail.posting.company}</p>
                    {/* A <ul>, not a <dl>. These are five facts about one posting, not five
                        term/definition pairs, and a description list whose children are bare
                        spans announces itself as a definition list containing nothing. */}
                    <ul className="u-data text-faint border-rule mt-4 flex flex-wrap gap-x-5 gap-y-1.5 border-t pt-3 text-2xs">
                      <li>{locationLabel(current)}</li>
                      <li>{termLabel(detail.posting.term)}</li>
                      <li>{payLabel(detail.posting.compensation)}</li>
                      <li>{detail.posting.positionType ?? 'type not stated'}</li>
                      <li>{detail.posting.atsVendor}</li>
                    </ul>
                    <p className="mt-5 u-prose text-base leading-relaxed">
                      {detail.match.rationale}
                    </p>
                  </div>
                </Section>

                <Section n="02" title="Requirements, with the text that decided each" step={4}>
                  <RequirementChecklist
                    rules={detail.match.rules}
                    requirements={detail.requirements}
                  />
                </Section>

                <Section n="03" title={`Fit — ${detail.match.score}/100`} step={5}>
                  <ScoreBreakdownBars breakdown={detail.match.breakdown} />
                  <p className="text-faint mt-4 u-prose text-sm italic">
                    This score only orders the queue. It <strong>never</strong> filters anything
                    out.
                  </p>
                </Section>

                <Section n="04" title="Your call" step={6}>
                  <DecisionRow
                    busy={busy}
                    rejecting={rejecting}
                    onRejecting={setRejecting}
                    act={act}
                    reject={reject}
                    applyUrl={detail.posting.applyUrl}
                  />
                </Section>

                <details className="u-card-flat mt-8 px-5 py-4">
                  <summary className="u-eyebrow hover:text-ink cursor-pointer transition-colors">
                    Full job description
                  </summary>
                  <FullDescription
                    text={detail.posting.descriptionText}
                    applyUrl={detail.posting.applyUrl}
                  />
                </details>
              </>
            )}
          </div>
        </div>
      )}

      <footer className="a-rise a-step-8 mt-12">
        <hr className="u-rule mb-3" />
        {/* Only what the buttons cannot say. Each decision button already carries its own
            key, so four fifths of this line was a second copy of them — and the one binding
            a user genuinely cannot discover from a control was buried among the repeats. */}
        <p className="u-eyebrow">j&nbsp;/&nbsp;k&nbsp;move&nbsp;between&nbsp;postings</p>
      </footer>
    </Page>
  );
}

/**
 * Gate G2's four decisions, and the one link out.
 *
 * Split out of the pane so the disabling below can be tested rather than only looked at.
 *
 * EVERY control here is held while anything at all is running, which is the fix: `act` and
 * `reject` both open with `if (!selected || busyRef.current) return`, and nothing on screen
 * said so. During a Recompute — which takes as long as it takes, re-extracting requirements
 * with the model — all four buttons stayed lit, and pressing Approve returned at that first
 * line. No application was created, no row left the list, no message appeared: the user had
 * approved a posting and the screen agreed with them that nothing had happened. The same held
 * for a second press during any decision's own round trip.
 *
 * The sentence beside them is for the keyboard, which cannot be greyed out. `a`, `s`, `l` and
 * the reject sheet run through the same guard and drop just as silently, so the reason they
 * are doing nothing is written where someone reaching for them will read it.
 */
export function DecisionRow({
  busy,
  rejecting,
  onRejecting,
  act,
  reject,
  applyUrl,
}: {
  busy: string | null;
  rejecting: boolean;
  onRejecting: (value: boolean) => void;
  act: (action: 'approved' | 'skipped' | 'saved') => void;
  reject: (tag: string, label: string) => void;
  applyUrl: string;
}) {
  const held = busy !== null;

  return (
    <>
      {rejecting ? (
        <div>
          <p className="text-dim mb-3 text-base">Why not this one?</p>
          <div className="flex flex-wrap gap-2">
            {REJECT_REASONS.map((r) => (
              <Button key={r.tag} disabled={held} onClick={() => reject(r.tag, r.label)}>
                {r.label}
              </Button>
            ))}
            {/* Not held: closing the sheet asks the server for nothing, and taking away the
                way out of a sheet whose seven other buttons have just gone grey would leave
                the user with no move at all. */}
            <Button onClick={() => onRejecting(false)}>Cancel</Button>
          </div>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap gap-3">
            <Button variant="solid" disabled={held} onClick={() => act('approved')}>
              Approve (A)
            </Button>
            <Button disabled={held} onClick={() => act('saved')}>
              Save (L)
            </Button>
            <Button disabled={held} onClick={() => act('skipped')}>
              Skip (S)
            </Button>
            {/* Reject opens the sheet rather than deciding, so it spends nothing itself — but
                every button inside that sheet is held, and offering a sheet that can only be
                cancelled is a worse answer than not opening it. */}
            <Button variant="danger" disabled={held} onClick={() => onRejecting(true)}>
              Reject (X)
            </Button>
            <a
              href={applyUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="u-data border-rule text-dim hover:text-ink hover:border-rule-strong hover:bg-ink/[0.04] inline-flex items-center rounded border px-4 py-2 tracking-wide uppercase transition-colors"
            >
              Open posting
              <ExternalLink aria-hidden size={14} />
            </a>
          </div>
          {/* The second sentence is here because Save, Skip and Reject look like
            three outcomes and behave like one. Each is written down as its own
            decision on the server, and nothing in this interface reads any of
            them back: there is no saved list, no decided view and no undo, so
            someone who pressed Save meaning "come back to this" watched the
            posting leave the queue for good and went looking for a screen that
            does not exist. Say so until one does. */}
          <p className="text-faint mt-4 u-prose text-sm">
            Approving creates an application you review at gate G3. It does not submit anything —
            you do that <em>yourself</em>, on the real page. Save and Skip both take the posting out
            of the queue, as does Reject. Each is recorded as its own decision, but nothing here
            reads any of them back yet, so treat all three as final.
          </p>
        </>
      )}
      {held && (
        <p className="text-caution mt-4 u-prose text-sm">
          {busy} — decisions are held until it finishes, by button and by key alike.
        </p>
      )}
    </>
  );
}

/**
 * The stored description, and the truth about where it ends.
 *
 * The cut used to be silent: the text stopped and the summary above it went on saying "Full
 * job description". Both halves of the honest version matter — the ellipsis, so the reader
 * can see the sentence was severed, and the line underneath, so they know there is more and
 * where to read it.
 */
export function FullDescription({ text, applyUrl }: { text: string; applyUrl: string }) {
  const { shown, cutAt } = descriptionExcerpt(text);

  // An empty description is its own claim. A feed that stored a posting with no body left
  // this disclosure opening onto a blank box, which reads as a rendering fault rather than as
  // "there was nothing to store".
  if (text.trim() === '') {
    return (
      <p className="text-faint mt-4 u-prose text-sm">
        This posting was stored without a description. The requirements above were read from
        whatever the source did send.{' '}
        <a
          href={applyUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="text-dim hover:text-ink underline underline-offset-4"
        >
          Read it on the posting
        </a>
        .
      </p>
    );
  }

  return (
    <>
      <div className="text-dim mt-4 u-prose text-sm leading-relaxed whitespace-pre-wrap">
        {shown}
      </div>
      {cutAt !== null && (
        <p className="text-faint mt-3 u-prose text-sm">
          Cut here, after {cutAt.toLocaleString()} characters of {text.length.toLocaleString()}. The
          rest is on the posting, and a requirement stated in it is one this page has not shown you.{' '}
          <a
            href={applyUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="text-dim hover:text-ink underline underline-offset-4"
          >
            Read the whole thing
          </a>
          .
        </p>
      )}
    </>
  );
}
