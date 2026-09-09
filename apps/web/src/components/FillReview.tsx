import { ExternalLink } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
  continueFill,
  discardFill,
  getFill,
  markSubmitted,
  startFill,
  type FillFieldResult,
  type FillRunView,
  type SkippedField,
} from '../lib/api';
import { samePage, skipReason } from '../lib/fill';
import { Badge, Button, Empty, Notice } from './Controls';

/**
 * Gate G4 — the pre-submit review.
 *
 * This screen exists to be the last thing between a filled form and a person's name on
 * it, so it is built around what still needs them rather than what got done. The counts
 * lead with "left for you", the fields that need attention sort to the top, and the only
 * button that says anything about submitting is the one that records that the USER did.
 *
 * There is no button here that submits. Not a disabled one, not one behind a
 * confirmation. The tool opens the page, fills what it can, and stops.
 */

const STATUS_TONE = {
  ok: 'verified',
  mismatch: 'caution',
  failed: 'redline',
  skipped: 'caution',
} as const;

const STATUS_LABEL = {
  ok: 'filled',
  mismatch: 'check this',
  failed: 'could not fill',
  skipped: 'left for you',
} as const;

/** Needs-attention first. A list that opens with thirty green rows buries the four amber ones. */
function ordered(fields: FillFieldResult[]): FillFieldResult[] {
  const rank = { failed: 0, mismatch: 1, skipped: 2, ok: 3 };
  return [...fields].sort((a, b) => rank[a.status] - rank[b.status]);
}

/**
 * True while the server is driving the page right now — still opening it, or typing into it.
 *
 * No control on this screen may offer to start work while this is true. The run lives on the
 * server, so switching to the tracker and back, or reloading the tab, brought this screen up
 * fresh in the middle of a fill and showed "Fill the form" over a form that was already being
 * typed into. Pressing it started a second run against the same page, and two runs do not take
 * turns: typing goes character by character into whatever is focused, so the second run stole
 * focus mid-word and the rest of the first run's value landed in the wrong box. Read-back does
 * not catch it either — it accepts a value that starts with what was intended, so a name cut
 * off after three letters still reports as filled and the review says "18 filled" over a form
 * holding fragments.
 *
 * `reading` is the one state that means two different things: a run that has finished reading
 * stays in it. A summary only exists once the form map is built, so it is what separates "still
 * reading the page" from "read it, waiting for you".
 */
function working(run: FillRunView): boolean {
  if (run.state === 'opening' || run.state === 'filling') return true;
  return run.state === 'reading' && run.summary === null;
}

/** What it is doing, in the words of someone watching the browser do it. */
function workingLabel(run: FillRunView): string {
  return run.state === 'filling'
    ? 'Typing your answers into the form.'
    : 'Opening the application page and reading the form.';
}

/** How often to re-ask the server whether the run has finished, in milliseconds. */
const POLL_MS = 1500;

/**
 * How many polls in a row may fail before this screen admits it is no longer live.
 *
 * More than one, because a single dropped request during a fill is not worth a banner
 * over. Not unbounded, which is what an empty catch amounts to: with the server gone the
 * panel kept asking every second and a half, kept failing, and kept the sentence "This
 * screen updates on its own when it is finished" on display over a run it could no longer
 * see. Three misses is about four and a half seconds, which is a dead connection rather
 * than a hiccup.
 */
const POLL_FAILURES_ALLOWED = 3;

export function FillReview({
  applicationId,
  applyUrl,
  canFill,
  blockedReason,
  submittedAt,
  skippedFields,
  onChanged,
}: {
  applicationId: string;
  applyUrl: string;
  canFill: boolean;
  blockedReason: string | null;
  /** When the user told us they submitted it, as recorded on the server. Null until they do. */
  submittedAt: string | null;
  /**
   * What the last run left for the user, read back from the application rather than from
   * the run. Empty for an application that has never been filled.
   */
  skippedFields: SkippedField[];
  onChanged: () => void;
}) {
  const [run, setRun] = useState<FillRunView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * Whether the first "is a run already open?" answer has come back yet.
   *
   * Without it the screen assumed "no run" for the length of that request and painted the
   * opening card, so someone reopening this panel over a live browser was shown "Open and
   * read the form" for a moment. Starting a run discards the one already open, so a click
   * landing in that moment closed the browser the user had just signed into.
   */
  const [checked, setChecked] = useState(false);
  /**
   * Whether that first question came back at all, as opposed to came back "no run".
   *
   * `checked` was set in `finally`, so a failed check was indistinguishable from a clean
   * "nothing open" — the same hole the panel already guards against DURING the request, one
   * step later. The screen then drew the card offering "Open and read the form" over a browser
   * it had simply failed to ask about, and starting a run discards the one already open: the
   * user signs in at a login wall, the poll or the reload trips on a dropped request, and the
   * button in front of them closes the browser they just signed into.
   */
  const [checkFailed, setCheckFailed] = useState(false);
  /** Bumped by the "Try again" below, which is what re-asks — the check is the retry. */
  const [checkAttempt, setCheckAttempt] = useState(0);
  /** Set once the poll below has given up, so nothing on screen goes on promising to update itself. */
  const [pollLost, setPollLost] = useState(false);
  /**
   * Remembered locally, because marking submitted clears the run.
   *
   * With the run gone and nothing on this screen carrying the application's status, the
   * panel fell back to its opening card — inviting the user to open and fill the form
   * they had just told it they submitted. This covers the moment between the click and
   * the reload of the record it changed; the `submittedAt` prop covers every mount after.
   */
  const [markedAt, setMarkedAt] = useState<string | null>(null);

  /**
   * Whether the user has said they sent this one, however this screen came to know it.
   *
   * The local memory above only survived as long as the panel did. Come back to the
   * application from the list, or reload the tab, and the panel offered "Open and read
   * the form" for an application already sitting in the tracker as submitted — and that
   * button really does open a browser and plan a fill, so following it meant applying to
   * the same posting twice.
   */
  const submitted = markedAt ?? submittedAt;

  /**
   * Picks up a run the server already has open. Returns null when there is none.
   *
   * The run lives on the server, but this screen only ever knew about the one it started
   * itself. Reload the tab — or just switch to the tracker and back — while a run was
   * paused at a login wall, and the panel offered "Open and read the form" as if nothing
   * were happening. Pressing it closed the browser the user had just signed into and
   * started again from the top.
   */
  useEffect(() => {
    let cancelled = false;
    setChecked(false);
    setCheckFailed(false);
    getFill(applicationId)
      .then((r) => {
        if (!cancelled) setRun(r);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setCheckFailed(true);
      })
      .finally(() => {
        if (!cancelled) setChecked(true);
      });
    return () => {
      cancelled = true;
    };
  }, [applicationId, checkAttempt]);

  /**
   * Follows a run this screen is not the one driving.
   *
   * The work happens on the server, so when the browser is filling a form that some earlier
   * mount of this screen started, nothing here would ever hear that it finished: the panel sat
   * on "typing your answers in" until the user reloaded the tab by hand. Asking again every
   * second and a half costs a local request and ends by itself the moment the run settles.
   */
  const settled = useRef(onChanged);
  useEffect(() => {
    settled.current = onChanged;
  });
  const follow = run !== null && busy === null && working(run);
  useEffect(() => {
    if (!follow) return;
    let cancelled = false;
    let failures = 0;
    setPollLost(false);
    const timer = setInterval(() => {
      getFill(applicationId)
        .then((r) => {
          if (cancelled) return;
          failures = 0;
          setRun(r);
          // A finished fill moves the application to awaiting_submit on the server, so the
          // rest of the panel is out of date the instant the run stops working.
          if (!r || !working(r)) settled.current();
        })
        .catch(() => {
          // A single dropped poll is not worth an error banner over a run that is still
          // going, so the next tick just asks again. A server that has died, or a socket
          // that broke mid-run, is different: every tick fails, and swallowing all of them
          // left this panel asking forever while telling the user it would update itself.
          // Count them, and stop pretending after the third.
          if (cancelled) return;
          failures += 1;
          if (failures >= POLL_FAILURES_ALLOWED) {
            clearInterval(timer);
            setPollLost(true);
          }
        });
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [follow, applicationId]);

  const act = async (key: string, fn: () => Promise<FillRunView | null>): Promise<void> => {
    setBusy(key);
    setError(null);
    try {
      setRun(await fn());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      // A request that fails does not mean the work never started. "Fill the form" holds the
      // connection open for the entire fill, so a dropped connection or a timeout lands here
      // while the browser is still typing — and this screen was left holding the run exactly
      // as it was before the click, which is the state whose card offers "Fill the form".
      // Someone who had just been told the fill failed pressed it again, and a second run
      // started typing into the same page as the first. Ask the server what really happened.
      await getFill(applicationId)
        .then((r) => setRun(r))
        .catch(() => {
          // Nothing to fall back to: if the server cannot be reached, no control on this
          // screen can start work either, and the banner above already says what went wrong.
        });
    } finally {
      setBusy(null);
      onChanged();
    }
  };

  if (!canFill) {
    return (
      <Notice tone="caution">
        <strong>Not ready to fill yet.</strong>{' '}
        {blockedReason ?? 'Approve every answer first (gate G3).'}
      </Notice>
    );
  }

  const needsAttention = run?.fields?.filter((f) => f.status !== 'ok').length ?? 0;

  return (
    <div className="space-y-5">
      {error && <Notice tone="redline">{error}</Notice>}

      {!checked && <p className="text-faint u-data">Checking for an open browser…</p>}

      {/* Which page this report is actually about.
          The run opens the application's saved link, but a sign-in redirect, a wizard step
          or a link that has gone stale can leave the browser somewhere else entirely, and
          everything below — the counts, the field list, the gate — describes the page that
          was read, not the one that was asked for. It sits up here rather than beside
          either link because it is true of every card underneath it, and the one card it
          matters most on, the G4 gate, has no link of its own. */}
      {run?.pageUrl && !samePage(run.pageUrl, applyUrl) && (
        <div className="u-tint-caution rounded px-5 py-4">
          <p className="u-eyebrow mb-1.5">Read from a different address</p>
          <p className="text-dim text-sm leading-snug">
            The browser ended up somewhere other than the link saved with this application.
            Everything below is about the page it read:
          </p>
          <a
            href={run.pageUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="u-data text-dim hover:text-ink mt-1.5 block break-all underline underline-offset-4"
          >
            {run.pageUrl}
          </a>
        </div>
      )}

      {/* What the last run left for the user, after that run is gone.
          The list on the review card below belongs to the run, and the run is discarded
          when the browser closes, when a second one starts and when the server stops —
          so someone who filled a form on Monday, closed the browser and came back on
          Tuesday had nothing anywhere telling them which nine boxes still needed their
          own typing. This copy is read back from the application, so it survives all
          three. The card that starts a fresh run stays underneath it: this is a record of
          what happened, not a reason to take the way forward away.

          Gated on `submitted === null` alongside the start-a-fill card below: once the user
          has told us they sent it, the form these boxes belong to is gone, and "they still
          need you" printed directly above the SUBMITTED stamp was telling someone to go back
          and finish a page that no longer exists. A submitted application shows the stamp
          only. */}
      {checked && !run && submitted === null && skippedFields.length > 0 && (
        <div className="u-card px-5 py-5">
          <p className="u-eyebrow mb-2">Left for you by the last fill</p>
          <p className="text-dim u-prose mb-3 text-sm">
            The last run did not complete these. Unless you have since typed them into the form
            yourself, they still need you.
          </p>
          <ul className="divide-rule/60 divide-y">
            {skippedFields.map((f, i) => (
              <li key={i} className="flex flex-wrap items-start gap-4 py-2.5">
                <span className="min-w-0 flex-1">
                  <span className="block text-base leading-snug">{f.label}</span>
                  <span className="text-dim mt-1 block text-sm leading-snug">{skipReason(f)}</span>
                </span>
                <Badge tone={f.reason === 'redline' ? 'redline' : 'caution'}>
                  {f.reason === 'redline' ? 'never auto-filled' : 'left for you'}
                </Badge>
              </li>
            ))}
          </ul>
        </div>
      )}

      {checked && !run && submitted !== null && (
        <div className="u-tint-verified rounded px-5 py-5">
          <p className="a-stamp u-data text-verified mb-2 text-lg tracking-widest uppercase">
            submitted
          </p>
          <p className="text-dim">
            Recorded on {submitted.slice(0, 10)}. It is on the tracker now — that is where replies,
            follow-ups and deadlines live.
          </p>
        </div>
      )}

      {/* The one card that must not appear over an unanswered question. Everything else on
          this screen is a report; this is the control that discards whatever run is already
          open, so it is the one place where "I could not find out" has to be said out loud
          instead of being rendered as "there is nothing open". */}
      {checked && checkFailed && submitted === null && (
        <div className="u-card-flat px-5 py-5">
          <p className="u-eyebrow mb-2">Could not tell</p>
          <p className="text-dim u-prose">
            This panel asked the server whether a browser is already open on this application and
            got no answer. Starting a fill closes any run that is open, so nothing is offered here
            until the question has one.
          </p>
          <div className="mt-4 flex flex-wrap gap-3">
            <Button disabled={busy !== null} onClick={() => setCheckAttempt((n) => n + 1)}>
              Ask again
            </Button>
            {/* Kept here rather than only on the card this one replaces. Holding back the
                fill is the safe move; holding back the link to the posting as well would
                leave a user whose server has stopped answering with no way forward at all,
                and opening it themselves spends nothing and closes no browser. */}
            <a
              href={applyUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="u-data border-rule text-dim hover:text-ink hover:border-rule-strong hover:bg-ink/[0.04] inline-flex items-center rounded border px-4 py-2 tracking-wide uppercase transition-colors"
            >
              Open posting myself
              <ExternalLink aria-hidden size={14} />
            </a>
          </div>
        </div>
      )}

      {checked && !checkFailed && !run && submitted === null && (
        <div className="u-card-flat px-5 py-5">
          <p className="text-dim u-prose">
            This opens the application page in a browser you can watch, reads the form, and shows
            you what it plans to type <em>before</em> typing anything.
          </p>
          <div className="mt-4 flex flex-wrap gap-3">
            <Button
              variant="solid"
              disabled={busy !== null}
              onClick={() => void act('start', () => startFill(applicationId))}
            >
              {busy === 'start' ? 'Opening…' : 'Open and read the form'}
            </Button>
            <a
              href={applyUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="u-data border-rule text-dim hover:text-ink hover:border-rule-strong hover:bg-ink/[0.04] inline-flex items-center rounded border px-4 py-2 tracking-wide uppercase transition-colors"
            >
              Open posting myself
              <ExternalLink aria-hidden size={14} />
            </a>
          </div>
        </div>
      )}

      {run?.intervention && (
        <Notice tone="caution">
          <strong>
            {run.intervention.reason === 'login' ? 'This site wants you signed in.' : 'Bot check.'}
          </strong>{' '}
          {run.intervention.detail}
          <div className="mt-3">
            <Button
              size="sm"
              variant="primary"
              disabled={busy !== null}
              onClick={() => void act('continue', () => continueFill(applicationId))}
            >
              {busy === 'continue' ? 'Checking…' : 'I have done that, continue'}
            </Button>
            {/* A way out. Continuing re-runs the same detector, so someone who decides
                not to sign in got the identical pause back every time, with the browser
                still open and no control anywhere on screen to close it. */}
            <Button
              size="sm"
              disabled={busy !== null}
              onClick={() =>
                void act('discard', async () => {
                  await discardFill(applicationId);
                  return null;
                })
              }
            >
              {busy === 'discard' ? 'Closing…' : 'Close the browser and stop'}
            </Button>
          </div>
        </Notice>
      )}

      {/* A run that is mid-flight gets a card with nothing on it to press twice. The only
          control is the way out, because stopping is the one thing a person watching the
          browser type into the wrong box actually needs. */}
      {/* Announced, because this panel re-fetches every 1.5s and swaps its whole body as the
          run moves opening -> filling -> done, and it told the user in words that it "updates
          on its own" — a promise it kept for everyone except the people who cannot see it
          happen. This is also the screen where a browser is typing into a real application
          form, so the transitions are the ones most worth hearing. */}
      {run && !run.intervention && working(run) && (
        <div className="u-card-flat px-5 py-5" role="status" aria-live="polite">
          <p className="u-eyebrow mb-2">Working</p>
          <p className="text-dim">
            {workingLabel(run)} The browser is open in front of you — watch it there.{' '}
            {pollLost
              ? 'This screen has lost contact with the server and is no longer following the run. Reload the page once the server answers again.'
              : 'This screen updates on its own when it is finished.'}
          </p>
          <div className="mt-4 flex flex-wrap gap-3">
            <Button
              disabled={busy !== null}
              onClick={() =>
                void act('discard', async () => {
                  await discardFill(applicationId);
                  return null;
                })
              }
            >
              {busy === 'discard' ? 'Closing…' : 'Close the browser and stop'}
            </Button>
          </div>
        </div>
      )}

      {/* A failed run is excluded rather than lumped in with the states that are still
          going: it has nothing to fill, and offering "Fill the form" for it put a button
          on screen whose only outcome was a second error. */}
      {run &&
        !run.intervention &&
        !working(run) &&
        run.state !== 'done' &&
        run.state !== 'failed' && (
          <div className="u-card-flat px-5 py-5">
            <p className="u-eyebrow mb-2">What it found</p>
            <p className="text-dim">{run.summary ?? run.message}</p>
            <div className="mt-4 flex flex-wrap gap-3">
              <Button
                variant="solid"
                disabled={busy !== null}
                onClick={() => void act('continue', () => continueFill(applicationId))}
              >
                {busy === 'continue' ? 'Filling…' : 'Fill the form'}
              </Button>
              <Button
                disabled={busy !== null}
                onClick={() =>
                  void act('discard', async () => {
                    await discardFill(applicationId);
                    return null;
                  })
                }
              >
                {busy === 'discard' ? 'Closing…' : 'Close the browser'}
              </Button>
            </div>
          </div>
        )}

      {run?.state === 'done' && run.counts && (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <Badge tone={needsAttention === 0 ? 'verified' : 'caution'}>
              {run.counts.filled} filled
            </Badge>
            {run.counts.skipped > 0 && (
              <Badge tone="caution">{run.counts.skipped} left for you</Badge>
            )}
            {run.counts.mismatched > 0 && (
              <Badge tone="caution">{run.counts.mismatched} to check</Badge>
            )}
            {run.counts.failed > 0 && <Badge tone="redline">{run.counts.failed} failed</Badge>}
          </div>

          <p className="text-dim u-prose">{run.message}</p>

          <div className="u-card overflow-hidden">
            <ul className="divide-rule/60 divide-y">
              {ordered(run.fields ?? []).map((f, i) => (
                <li key={i} className="flex flex-wrap items-start gap-4 px-5 py-3.5">
                  <span className="min-w-0 flex-1">
                    <span className="block text-base leading-snug">{f.label}</span>
                    {f.note && (
                      <span className="text-dim mt-1 block text-sm leading-snug">{f.note}</span>
                    )}
                    {f.status === 'ok' && f.readBack && (
                      <span className="u-data text-faint mt-1 block truncate">{f.readBack}</span>
                    )}
                  </span>
                  <Badge tone={STATUS_TONE[f.status]}>{STATUS_LABEL[f.status]}</Badge>
                </li>
              ))}
            </ul>
          </div>

          {/* A FORM WITH MORE THAN ONE STEP, WHICH THIS SCREEN USED TO DEAD-END ON.

              Plenty of ATS forms are a wizard: page one is name and email, page two is the
              essays. The run fills page one, reaches `done`, and this block offered only "I
              submitted it" and "Close the browser" — so the student's approved answers, sitting
              ready for page two, could only be typed by hand.

              The server was ready the whole time. `continueRun` has no state guard, re-reads the
              page with `buildFormMap` and fills whatever is on it NOW; the route allows it
              (`load()`'s FILL_PATH includes awaiting_submit and advancing from it is a no-op),
              and fillRun.test.ts already pins a second continue going through. Only the button
              was missing. */}
          <div className="u-card-flat px-5 py-4">
            <p className="text-dim u-prose text-sm">
              Is this form more than one page? Move to the next step in the browser yourself — the
              tool never presses a button that sends anything — then fill that page too.
            </p>
            <Button
              size="sm"
              className="mt-3"
              disabled={busy !== null}
              onClick={() => void act('continue', () => continueFill(applicationId))}
            >
              Fill the next step
            </Button>
          </div>

          {/* The gate itself. */}
          <div className="u-tint-accent rounded px-5 py-5">
            <p className="u-eyebrow mb-2">Gate G4</p>
            <p className="text-dim u-prose">
              The browser is still open on the filled form. Read it, complete anything left for you,
              and <strong>submit it yourself</strong>. This tool has no button that submits an
              application, by design.
            </p>
            <div className="mt-4 flex flex-wrap gap-3">
              <Button
                variant="primary"
                disabled={busy !== null}
                onClick={() =>
                  void act('mark', async () => {
                    const r = await markSubmitted(applicationId);
                    setMarkedAt(r.submittedAt ?? new Date().toISOString());
                    return null;
                  })
                }
              >
                {busy === 'mark' ? 'Recording…' : 'I submitted it'}
              </Button>
              <Button
                disabled={busy !== null}
                onClick={() =>
                  void act('discard', async () => {
                    await discardFill(applicationId);
                    return null;
                  })
                }
              >
                {busy === 'discard' ? 'Closing…' : 'Close the browser'}
              </Button>
            </div>
          </div>
        </>
      )}

      {run?.state === 'failed' && (
        <>
          <Empty title="The run could not finish.">{run.message}</Empty>
          {/* The failed run stays on the server until something clears it, and the card
              that starts a fill only shows when there is no run at all. Without this the
              screen was a dead end: an error, and no control that led anywhere. */}
          <div className="flex flex-wrap gap-3">
            <Button
              disabled={busy !== null}
              onClick={() =>
                void act('discard', async () => {
                  await discardFill(applicationId);
                  return null;
                })
              }
            >
              {busy === 'discard' ? 'Closing…' : 'Close the browser and start over'}
            </Button>
            <a
              href={applyUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="u-data border-rule text-dim hover:text-ink hover:border-rule-strong hover:bg-ink/[0.04] inline-flex items-center rounded border px-4 py-2 tracking-wide uppercase transition-colors"
            >
              Open posting myself
              <ExternalLink aria-hidden size={14} />
            </a>
          </div>
        </>
      )}
    </div>
  );
}
