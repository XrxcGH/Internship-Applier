import { ArrowRight } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  accessBadge,
  addManualPosting,
  addPastedPosting,
  availableSources,
  boardMeaning,
  durationLabel,
  getPlan,
  keylessTargets,
  listRuns,
  mergeTargets,
  postingStats,
  resolveCompany,
  runHeadline,
  sourceLabel,
  unavailableReason,
  splitCompanies,
  startRun,
  targetKey,
  whenLabel,
  whyCannotRun,
  type AvailableSource,
  type ManualResult,
  type QueryPlan,
  type Resolution,
  type RunSummary,
  type RunTarget,
} from '../lib/discovery';
import { recompute } from '../lib/matches';
import { Page, RunningHead, Section } from '../components/Chrome';
import { Badge, Button, Empty, Notice, TextArea, TextField } from '../components/Controls';

/**
 * Discover — docs/04, and the screen its own planner notes have been pointing at.
 *
 * Everything here was reachable over HTTP for the whole of M2 and by nothing else: the
 * queue's empty state told people to POST to `/api/discovery/run` themselves, the planner
 * wrote notes saying "Resolve it in Discover" about a screen that did not exist, and the
 * overview listed M2 as "Discovery (server only)". This is that screen.
 *
 * Two things it deliberately does not do. It does not run on its own — no schedule, no
 * background worker, nothing outbound happens on this page until a button is pressed. And it
 * does not show live progress: `runDiscovery` publishes onto the SSE stream, no client
 * listens (docs/08 § Real-time), and a bar measuring nothing would be worse than a sentence
 * saying there is nothing to measure.
 */

/** How many company names one press of "Find their boards" will probe. */
const RESOLVE_LIMIT = 8;

/**
 * The one-line report a scoring pass leaves behind, and whether it is good news.
 *
 * `ok` exists because the failure sentence was drawn in the same green `verified` Notice as
 * the success one. A run whose scoring half died came back as "The search finished and its
 * postings are stored, but scoring them did not run: fetch failed" tinted like a completed
 * job — the user reads the run summary as a receipt, and the only thing telling them half of
 * it had not happened was the sentence itself, in the colour this app uses for "done".
 */
export interface ScoreReport {
  ok: boolean;
  message: string;
}

/**
 * The success line, written once.
 *
 * `run` and `score` each built this same sentence from their own template literal, so the
 * two could — and would — drift apart by a word.
 */
export function scoredLine(r: {
  matched: number;
  eligible: number;
  unknown: number;
  ineligible: number;
}): ScoreReport {
  return {
    ok: true,
    message: `${r.matched} scored — ${r.eligible} eligible, ${r.unknown} to check, ${r.ineligible} filtered.`,
  };
}

/**
 * Scoring failed, and the search in front of it did not.
 *
 * Says which half survived. Searching is the expensive half — a fan-out of real requests
 * over minutes — and someone told only "scoring failed" reasonably assumes the postings went
 * with it and runs the whole thing again.
 */
export function scoringFailed(err: unknown): ScoreReport {
  return {
    ok: false,
    message:
      'The search finished and its postings are stored, but scoring them did not run: ' +
      (err instanceof Error ? err.message : String(err)) +
      ' Press "Score what is stored" to try that half again.',
  };
}

/** One failed action, kept so the error banner's button can run it again. */
interface Retry {
  label: string;
  work: () => Promise<void>;
}

/**
 * What "Try again" is offering, in the words of the thing that failed.
 *
 * A bare "Try again" under a dead search reads as "re-read this page", which is exactly what
 * that button used to do. A run costs a fan-out of real requests to third-party APIs, so the
 * control that starts one over has to say so before it is pressed rather than after.
 */
export function retryLabel(retry: { label: string } | null): string {
  if (retry === null) return 'Try again';
  return `Try ${retry.label.charAt(0).toLowerCase()}${retry.label.slice(1)} again`;
}

export function Discovery({
  onOpenQueue,
  onBusy,
}: {
  onOpenQueue?: () => void;
  onBusy?: (what: string | null) => void;
}) {
  const [stats, setStats] = useState<{ total: number; open: number } | null>(null);
  const [sources, setSources] = useState<AvailableSource[] | null>(null);
  const [plan, setPlan] = useState<QueryPlan | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);

  const [companies, setCompanies] = useState('');
  const [resolutions, setResolutions] = useState<
    Array<{ name: string; matches: Resolution[]; notes: string[] }>
  >([]);
  const [resolveNote, setResolveNote] = useState<string | null>(null);

  const [targets, setTargets] = useState<RunTarget[]>([]);
  const [summary, setSummary] = useState<RunSummary | null>(null);
  const [scored, setScored] = useState<ScoreReport | null>(null);

  const [manualUrl, setManualUrl] = useState('');
  // The paste-the-text fallback, for the three boards that refuse automated readers.
  const [pastedTitle, setPastedTitle] = useState('');
  const [pastedCompany, setPastedCompany] = useState('');
  const [pastedUrl, setPastedUrl] = useState('');
  const [pastedText, setPastedText] = useState('');
  const [manual, setManual] = useState<ManualResult | null>(null);

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /**
   * The action to run again when the banner's "Try again" is pressed, or null when the
   * failure came from the four reads and re-reading really is the retry.
   *
   * That button called `refresh(pinned)` whatever had failed, and `refresh` re-reads the
   * stats, the sources, the run list and the plan — nothing else — beginning with
   * `setError(null)`. So a search that died after ninety seconds, a company probe that timed
   * out, a pasted URL that came back 404: every one of them answered "Try again" by wiping
   * the red banner and re-counting the postings. Nothing was retried, and clearing the only
   * evidence of the failure is precisely how a thing that did not happen comes to look like a
   * thing that did.
   *
   * Kept as `{label, work}` rather than a bound closure so the button can name what it is
   * about to spend, and so the retry goes back in through `guarded` — a retried run needs the
   * in-flight guard and the busy label just as much as the first press did.
   */
  const [retry, setRetry] = useState<Retry | null>(null);

  /**
   * The in-flight guard, as on the queue.
   *
   * `busy` disables every button that spends anything, but only from the render after it is
   * set, and a run costs a fan-out of real requests to third-party APIs. A second press
   * inside that gap started a second complete run over the same boards, and whichever
   * finished first cleared the label while the other carried on invisibly.
   */
  const busyRef = useRef(false);

  /**
   * Only the newest read is allowed to paint, exactly as the queue does with `listSeq`.
   *
   * Every one of these four fetches can be in flight more than once — "Rebuild" and "Rebuild
   * the plan with these" both call `refresh`, and a run calls it again when it finishes — and
   * responses come back in whatever order the network gives them. Without a sequence number
   * the last answer to LAND wins rather than the last one ASKED: type "Stripe", rebuild,
   * clear the field, rebuild again, and if the first answer is slower the screen settles on
   * Stripe's guessed boards and its caution note for a company that is no longer in the box.
   * The same race let a failure from an abandoned read overwrite the banner after a newer
   * read had already succeeded.
   */
  const readSeq = useRef(0);

  // The nav lives above this screen and unmounting it would throw the in-flight guard
  // away, so what is running has to be visible up there. See the comment on `Nav`.
  useEffect(() => onBusy?.(busy), [busy, onBusy]);

  const fail = useCallback((err: unknown) => {
    setError(err instanceof Error ? err.message : String(err));
  }, []);

  /**
   * Reads the four things this screen shows that it did not just do.
   *
   * The plan is fetched with whatever companies are pinned at the time, so re-planning after
   * editing that field is this same call. It is a POST because the planner takes a filter
   * body; it changes nothing on the server.
   */
  const refresh = useCallback(
    (pinned: string[] = []) => {
      const seq = (readSeq.current += 1);
      const fresh =
        <T,>(set: (value: T) => void) =>
        (value: T): void => {
          if (seq === readSeq.current) set(value);
        };
      const failFresh = (err: unknown): void => {
        if (seq === readSeq.current) fail(err);
      };

      setError(null);
      // Cleared, so a read that fails after an action failed leaves the button offering the
      // reads it just tried rather than the run from five minutes ago.
      setRetry(null);
      void postingStats().then(fresh(setStats)).catch(failFresh);
      void availableSources().then(fresh(setSources)).catch(failFresh);
      void listRuns().then(fresh(setRuns)).catch(failFresh);
      void getPlan(pinned).then(fresh(setPlan)).catch(failFresh);
    },
    [fail],
  );

  useEffect(() => {
    refresh();
  }, [refresh]);

  /** Wraps one spending action in the guard, the label, and the error banner. */
  const guarded = useCallback(
    async (label: string, work: () => Promise<void>): Promise<void> => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(label);
      setError(null);
      setRetry(null);
      try {
        await work();
      } catch (err) {
        fail(err);
        // Recorded here rather than at the five call sites, so every action on this page that
        // spends anything is retryable by the one button: the board probe, the run, the
        // scoring, the URL read and the pasted posting all pass through `guarded`. Fixing
        // this for the search alone would have left the other four clearing their own banner.
        setRetry({ label, work });
      } finally {
        busyRef.current = false;
        setBusy(null);
      }
    },
    [fail],
  );

  const pinned = splitCompanies(companies);
  /**
   * The companies as they are NOW, for the work that finishes later.
   *
   * `run` captures `pinned` when the button is pressed, and the field stays editable through
   * a search that can take minutes because typing in it spends nothing. So the plan rebuilt
   * when the run finished was the plan for the list as of the click: the box could read
   * "Figma" while the chips underneath it described Stripe, and it only came right if the
   * user happened to press Rebuild again.
   */
  const pinnedRef = useRef(pinned);
  pinnedRef.current = pinned;

  const addTargets = (incoming: RunTarget[]): void => {
    setTargets((prev) => mergeTargets(prev, incoming));
  };

  const findBoards = (): Promise<void> =>
    guarded('Probing the boards', async () => {
      setResolutions([]);
      setResolveNote(
        pinned.length > RESOLVE_LIMIT
          ? `Probing the first ${RESOLVE_LIMIT} of ${pinned.length} names. The rest are not ` +
              'probed: take these out of the box above and press it again for the next ' +
              `${RESOLVE_LIMIT}.`
          : null,
      );
      const found: Array<{ name: string; matches: Resolution[]; notes: string[] }> = [];
      // One name at a time. Each resolution already probes six vendors across up to three
      // slug candidates — five keyless boards by GET, plus a bounded Workday probe that
      // spends up to six POSTs of its own per candidate — and the fetcher rate-limits per
      // host, so firing them together buys nothing and looks to Greenhouse like a burst.
      for (const name of pinned.slice(0, RESOLVE_LIMIT)) {
        const r = await resolveCompany(name);
        found.push({ name, matches: r.matches, notes: r.notes });
        setResolutions([...found]);
      }
    });

  const run = (): Promise<void> =>
    guarded('Searching', async () => {
      setSummary(null);
      setScored(null);
      const result = await startRun(targets);
      setSummary(result);
      /**
       * Scored in the same press, because searching without scoring produces nothing the
       * user can act on.
       *
       * A run stores postings and scores none of them, and the queue only ever shows what has
       * been scored. So the two controls sat side by side with no ordering signal, and a
       * first-time user who finished a search and took the button naming the next gate —
       * "Open the queue (G2)" — arrived at a queue unchanged by the run they had just waited
       * for, whose own empty state then sent them back here.
       *
       * The scoring failure is caught rather than thrown: the search itself succeeded, its
       * postings are stored, and losing that report to an error from the step after it would
       * throw away the expensive half of the press.
       */
      try {
        setScored(scoredLine(await recompute()));
      } catch (err) {
        setScored(scoringFailed(err));
      }
      // The stats and the run list both moved; the plan may have too, since a board that
      // answered is a board the next plan knows about. Read through `refresh` rather than
      // fetching here, so these answers are subject to the same last-asked-wins rule as
      // every other read on the page — and with the companies as they stand NOW, not as
      // they stood when the button was pressed minutes ago.
      refresh(pinnedRef.current);
    });

  const score = (): Promise<void> =>
    guarded('Scoring', async () => {
      // Cleared before the request rather than replaced after it. A failure here is caught by
      // `guarded` and drawn as the red banner, and the green line from the last SUCCESSFUL
      // scoring stayed on screen underneath it — "31 scored — 12 eligible…" sitting directly
      // below the sentence saying scoring had just failed.
      setScored(null);
      setScored(scoredLine(await recompute()));
    });

  const paste = (): Promise<void> =>
    guarded('Reading the page', async () => {
      setManual(null);
      const r = await addManualPosting(manualUrl.trim());
      setManual(r);
      setManualUrl('');
      // Through `refresh` like every other read, and this was the fifth that was not: it
      // called `postingStats` directly, so it neither bumped the sequence nor was checked
      // against it. A slow "Rebuild" still in flight would land afterwards and paint the
      // count as it stood BEFORE the posting was stored — the last-to-land-wins race the
      // sequence guard exists to end, on the one read that had not been given it.
      refresh(pinnedRef.current);
    });

  // Mirrors PasteBody on the server, so the button is dead until the request would be
  // accepted rather than offering a press that comes back 400.
  const canPaste =
    pastedTitle.trim() !== '' &&
    pastedCompany.trim() !== '' &&
    pastedUrl.trim() !== '' &&
    pastedText.trim().length >= 40;

  const pasteText = (): Promise<void> =>
    guarded('Storing what you pasted', async () => {
      setManual(null);
      const r = await addPastedPosting({
        text: pastedText.trim(),
        title: pastedTitle.trim(),
        company: pastedCompany.trim(),
        url: pastedUrl.trim(),
      });
      setManual(r);
      setPastedTitle('');
      setPastedCompany('');
      setPastedUrl('');
      setPastedText('');
      refresh(pinnedRef.current);
    });

  const blocked = whyCannotRun(targets);

  return (
    <Page>
      <RunningHead
        section="Discover"
        lede={
          <>
            Where postings come from. Nothing on this page reaches the network until you press
            something, and nothing found here enters the queue as a decision — it arrives as a
            posting for you to judge at <strong>G2</strong>.
          </>
        }
      />

      {error && (
        <Notice tone="redline">
          {error}
          <div className="mt-3">
            <Button
              size="sm"
              disabled={busy !== null}
              onClick={() => {
                if (retry) void guarded(retry.label, retry.work);
                else refresh(pinned);
              }}
            >
              {retryLabel(retry)}
            </Button>
          </div>
        </Notice>
      )}
      {/* A live region, because a search takes minutes and says nothing while it runs. A
          screen-reader user pressing Search otherwise got no announcement that anything had
          started, finished, or failed — the page simply changed under them. */}
      <div role="status" aria-live="polite">
        {busy && <p className="u-data text-accent a-pulse mb-4">{busy}…</p>}
      </div>

      <Section n="01" title="What is stored, and where this looks" step={3}>
        <div className="grid gap-6 lg:grid-cols-2">
          <div className="u-card-flat px-5 py-5">
            <h3 className="u-eyebrow mb-3">Stored here</h3>
            {stats === null && !error && <p className="text-dim a-pulse">Counting…</p>}
            {stats && (
              <>
                <p className="u-data text-xl">
                  {stats.total} {stats.total === 1 ? 'posting' : 'postings'} · {stats.open} still
                  open
                </p>
                <p className="text-faint u-prose mt-3 text-sm">
                  A posting is stored the moment it is found and scored only when you ask. The queue
                  shows whatever has been scored.
                </p>
                {onOpenQueue && (
                  <div className="mt-4">
                    {/* Held while anything is running, like its twin below the summary.
                        Leaving one exit enabled meant a user could start a search, leave
                        for the queue, come back to a remounted screen with a fresh guard —
                        `busyRef` starts false again — and press Search a second time,
                        starting a concurrent run over the same boards. The server has no
                        run lock, so the guard on this page is the only one there is, and a
                        guard with a door beside it is not a guard. */}
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={busy !== null}
                      onClick={onOpenQueue}
                    >
                      Open the queue (G2)
                      <ArrowRight aria-hidden size={15} />
                    </Button>
                  </div>
                )}
              </>
            )}
          </div>

          <div className="u-card-flat px-5 py-5">
            <h3 className="u-eyebrow mb-3">Sources</h3>
            {sources === null && !error && <p className="text-dim a-pulse">Asking…</p>}
            {sources && (
              <ul className="divide-rule/60 divide-y">
                {sources.map((s) => (
                  <li key={s.name} className="py-2.5">
                    <div className="flex items-center justify-between gap-4">
                      <span className="text-base">{sourceLabel(s.name)}</span>
                      <Badge tone={s.configured ? 'verified' : 'caution'}>{accessBadge(s)}</Badge>
                    </div>
                    {/* A standing limitation, said where the source is listed rather than
                        only after a run has failed to reveal it. */}
                    {unavailableReason(s.name) && (
                      <p className="text-faint u-prose mt-1 text-xs">{unavailableReason(s.name)}</p>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <p className="text-faint u-prose mt-4 text-sm">
              The two keyed sources read <span className="u-data">ADZUNA_APP_ID</span> /{' '}
              <span className="u-data">ADZUNA_APP_KEY</span> and{' '}
              <span className="u-data">USAJOBS_API_KEY</span> /{' '}
              <span className="u-data">USAJOBS_USER_AGENT</span> from the .env file at the root of
              this project. Both keys are free. Without them those sources are skipped, and every
              run says so out loud rather than searching less and looking the same.
            </p>
          </div>
        </div>
      </Section>

      <Section
        n="02"
        title="The plan, read out of your profile"
        step={4}
        actions={
          <Button size="sm" disabled={busy !== null} onClick={() => refresh(pinned)}>
            Rebuild
          </Button>
        }
      >
        {plan === null && !error && <p className="text-dim a-pulse">Planning…</p>}
        {plan && (
          <>
            <div className="u-card-flat divide-rule/60 divide-y px-5 py-1">
              <PlanRow label="Role families" values={plan.roleFamilies} />
              <PlanRow label="Keywords" values={plan.keywords} />
              <PlanRow label="Term" values={plan.termTokens} />
              <PlanRow label="Locations" values={plan.locations} />
            </div>

            {plan.notes.map((note) => (
              <Notice key={note} tone="caution">
                {note}
              </Notice>
            ))}

            {plan.targets.length === 0 ? (
              <Empty title="The plan has no boards in it.">
                It only knows boards a previous run resolved, plus any company you pin below. The
                keyless feeds need neither, so add one in section 04 and the queue has something in
                it a minute later.
              </Empty>
            ) : (
              <div className="mt-5">
                <ul className="flex flex-wrap gap-2">
                  {plan.targets.map((t) => (
                    <li
                      key={`${targetKey(t)}|${t.reason}`}
                      className="border-rule text-dim rounded-full border px-3.5 py-1.5"
                    >
                      <span className="u-data text-2xs tracking-wide uppercase">
                        {sourceLabel(t.source)}
                      </span>{' '}
                      <span className="text-sm">{t.board}</span>{' '}
                      <span className="text-faint text-xs">— {t.reason}</span>
                    </li>
                  ))}
                </ul>
                <div className="mt-4">
                  <Button
                    variant="primary"
                    onClick={() =>
                      addTargets(
                        plan.targets.map((t) => ({
                          source: t.source,
                          board: t.board,
                          reason: t.reason,
                        })),
                      )
                    }
                  >
                    Put these {plan.targets.length} in the run
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </Section>

      <Section n="03" title="Companies you want searched" step={5}>
        <div className="max-w-2xl">
          <TextField
            label="Company names"
            hint="Commas or semicolons between them. Case does not matter, and a repeat is dropped."
            value={companies}
            onChange={(e) => setCompanies(e.target.value)}
            placeholder="Figma, Stripe, Anthropic"
          />
        </div>

        {/* One button, not two. This row also held "Rebuild the plan with these", which
            called `refresh(pinned)` — the identical call section 02's "Rebuild" makes, with
            the identical argument. Two names for one action, described in the prose below as
            though they did different things. */}
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button
            variant="primary"
            disabled={busy !== null || pinned.length === 0}
            onClick={() => void findBoards()}
          >
            Find their boards
          </Button>
          <span className="text-faint u-data text-2xs">
            {pinned.length} {pinned.length === 1 ? 'name' : 'names'}
          </span>
        </div>

        <p className="text-faint u-prose mt-4 text-sm">
          Rebuilding the plan above guesses each name as a slug on Greenhouse, Lever, Ashby,
          SmartRecruiters and Workable, and says in a note that it guessed. Finding the boards asks
          those five, and Workday as well, which one the company really uses and how many jobs it
          has open today — slower, and the one that gives you a target worth running. Workday is
          never guessed either way, because its address is a tenant and a site name the company
          chose rather than anything you can build from a company name.
        </p>

        {resolveNote && <Notice tone="caution">{resolveNote}</Notice>}

        {resolutions.length > 0 && (
          <ul className="mt-5 space-y-3">
            {resolutions.map(({ name, matches, notes }) => (
              <li key={name} className="u-card-flat px-5 py-4">
                <div className="flex flex-wrap items-baseline justify-between gap-3">
                  <span className="text-lg">{name}</span>
                  {matches.length === 0 && (
                    <span className="u-data text-caution text-2xs tracking-widest uppercase">
                      no board answered
                    </span>
                  )}
                </div>
                {matches.length === 0 ? (
                  <p className="text-faint u-prose mt-2 text-sm">
                    No board answered under that name. The company may use a vendor this tool does
                    not read, iCIMS and Taleo among them, in which case paste the posting URL in
                    section 05.
                  </p>
                ) : (
                  <ul className="mt-3 space-y-2">
                    {matches.map((m) => (
                      <li
                        key={`${m.source}:${m.board}`}
                        className="flex flex-wrap items-center gap-3"
                      >
                        <span className="u-data text-2xs tracking-wide uppercase">
                          {sourceLabel(m.source)}
                        </span>
                        <span className="text-dim text-sm">{m.board}</span>
                        <span className="text-faint u-data text-2xs">
                          {m.jobCount} open {m.jobCount === 1 ? 'job' : 'jobs'}
                        </span>
                        <Button
                          size="sm"
                          onClick={() =>
                            addTargets([
                              {
                                source: m.source,
                                board: m.board,
                                reason: `${name}, resolved to this board`,
                              },
                            ])
                          }
                        >
                          Add
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
                {/*
                  Shown in BOTH branches, because the caveat is not only about finding
                  nothing: the server pushes the SmartRecruiters note whenever that vendor
                  was found under no slug candidate, which happens just as often on a name
                  that resolved somewhere else. Dropping it let the screen state that no
                  vendor has a board under the name, which is a stronger claim than the
                  probes can make.
                */}
                {notes.map((note) => (
                  <p key={note} className="text-faint u-prose mt-2 text-xs">
                    {note}
                  </p>
                ))}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section n="04" title="The run" step={6}>
        <div className="mb-5 flex flex-wrap items-center gap-3">
          {/* Every source that needs no key and no board, read off what the server reports.
              This used to be one hard-coded Community list button, and it stayed that way
              when Arbeitnow and Remotive shipped: two keyless feeds the user could only run
              by taking the whole plan, which is a quieter way of searching less. */}
          {keylessTargets(sources).map((t) => (
            <Button key={t.source} onClick={() => addTargets([t])}>
              + {sourceLabel(t.source)}
            </Button>
          ))}
          {(sources ?? [])
            .filter((s) => s.requiresKey && s.configured)
            .map((s) => (
              <Button
                key={s.name}
                onClick={() =>
                  addTargets([
                    {
                      source: s.name,
                      board: '',
                      // Web search costs a model call and the button says so, because a
                      // reason that reads like the free ones would hide the one difference
                      // that matters. Its brief also leads with the plan's term token —
                      // "summer 2027 internship" is most of what makes a web search find
                      // THIS cycle's postings rather than last year's.
                      reason:
                        s.name === 'web_search'
                          ? 'a live web search through your model access — one model call'
                          : 'keyword search',
                      keywords:
                        s.name === 'web_search'
                          ? [...(plan?.termTokens.slice(0, 1) ?? []), ...(plan?.keywords ?? [])]
                          : (plan?.keywords ?? []),
                      location: plan?.locations[0],
                    },
                  ])
                }
              >
                + {sourceLabel(s.name)}
              </Button>
            ))}
          {targets.length > 0 && (
            <Button size="sm" onClick={() => setTargets([])}>
              Clear
            </Button>
          )}
        </div>

        {targets.length === 0 ? (
          <Empty title="Nothing queued to search.">
            Add one of the keyless feeds above, or a company board from section 03, or take the plan
            from section 02 whole.
          </Empty>
        ) : (
          <ul className="u-card divide-rule/50 divide-y">
            {targets.map((t) => (
              <li
                key={targetKey(t)}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-baseline gap-2.5">
                    <span className="u-data text-accent text-2xs tracking-wide uppercase">
                      {sourceLabel(t.source)}
                    </span>
                    <span className="text-base">
                      {t.board || <span className="text-faint">{boardMeaning(t.source)}</span>}
                    </span>
                  </div>
                  <div className="text-faint mt-0.5 text-xs">
                    {t.reason}
                    {t.keywords && t.keywords.length > 0 && ` · ${t.keywords.join(', ')}`}
                    {t.location && ` · ${t.location}`}
                  </div>
                </div>
                <Button
                  size="sm"
                  onClick={() =>
                    setTargets((prev) => prev.filter((x) => targetKey(x) !== targetKey(t)))
                  }
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <Button
            variant="solid"
            disabled={busy !== null || blocked !== null}
            onClick={() => void run()}
          >
            {busy === 'Searching'
              ? 'Searching…'
              : busy === 'Scoring'
                ? 'Scoring…'
                : targets.length === 0
                  ? 'Search and score'
                  : `Search ${targets.length} ${targets.length === 1 ? 'target' : 'targets'} and score`}
          </Button>
          {/* Only once there IS a list. With an empty one, the card above, a button reading
              "Search 0 targets" and this span all said the same thing three ways, two of them
              listing overlapping fixes. `whyCannotRun` still drives `disabled` either way —
              this hides the sentence, not the rule — and the two blockers the card cannot
              express, a missing board name and the 200-target ceiling, still print verbatim
              exactly when they apply. */}
          {blocked && targets.length > 0 && <span className="text-faint text-sm">{blocked}</span>}
        </div>

        <p className="text-faint u-prose mt-4 text-sm">
          A run fetches four boards at a time and answers when the last one is done, which is
          anything from a few seconds to a couple of minutes. Scoring then reads each new posting
          for its requirements — that is the step here that can spend a model call, and it is the
          same work the queue&apos;s Recompute button does. There is no progress on the way: the
          server publishes it and no screen in this app listens yet, so this page waits rather than
          drawing a bar it cannot fill honestly.
        </p>

        {summary && (
          <div className="mt-6">
            <div className="u-tint-verified rounded px-5 py-4">
              <p className="u-data text-lg">{runHeadline(summary)}</p>
              <p className="text-faint mt-1 text-xs">
                {summary.targets} {summary.targets === 1 ? 'target' : 'targets'} in{' '}
                {durationLabel(summary.startedAt, summary.finishedAt)}
              </p>
            </div>

            {summary.skipped.length > 0 && (
              <Notice tone="caution">
                <strong>This search was not complete.</strong>
                <ul className="mt-2 space-y-1.5">
                  {summary.skipped.map((s, i) => (
                    <li key={i} className="u-prose text-sm">
                      {s}
                    </li>
                  ))}
                </ul>
              </Notice>
            )}

            <ul className="u-card divide-rule/50 mt-4 divide-y">
              {summary.bySource.map((r, i) => (
                <li key={`${r.source}:${r.board}:${i}`} className="px-4 py-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-3">
                    <span className="text-base">
                      <span className="u-data text-2xs tracking-wide uppercase">
                        {sourceLabel(r.source)}
                      </span>{' '}
                      {r.board}
                    </span>
                    <span className="u-data text-faint text-xs">
                      {r.found} found · {r.new} new
                      {r.degraded && <span className="text-caution"> · came back short</span>}
                    </span>
                  </div>
                  {[...r.errors, ...r.notes].map((line, j) => (
                    <p key={j} className="text-faint u-prose mt-1.5 text-xs">
                      {line}
                    </p>
                  ))}
                </li>
              ))}
            </ul>

            <div className="mt-5 flex flex-wrap items-center gap-3">
              <Button variant="primary" disabled={busy !== null} onClick={() => void score()}>
                {busy === 'Scoring' ? 'Scoring…' : 'Score what is stored'}
              </Button>
              {onOpenQueue && (
                <Button disabled={busy !== null} onClick={onOpenQueue}>
                  Open the queue (G2)
                  <ArrowRight aria-hidden size={15} />
                </Button>
              )}
            </div>
            {/* The tone follows the outcome. Both of this page's scoring lines were drawn
                `verified` whatever they said, so the sentence reporting that scoring did NOT
                run arrived tinted green, inside the block the user reads as the receipt for
                the run. */}
            {scored && <Notice tone={scored.ok ? 'verified' : 'caution'}>{scored.message}</Notice>}
            <p className="text-faint u-prose mt-3 text-sm">
              Finding a posting does not score it. Scoring reads each new posting for its
              requirements, which is the one step on this page that can spend money on a model call,
              and it is also what the queue&apos;s own Recompute button does.
            </p>
          </div>
        )}
      </Section>

      <Section n="05" title="One posting you found yourself" step={7}>
        <div className="max-w-2xl">
          <TextField
            label="Paste the address of a job posting"
            hint="Any site. The page is fetched once, because you asked for it."
            value={manualUrl}
            onChange={(e) => setManualUrl(e.target.value)}
            placeholder="https://…"
          />
        </div>
        <div className="mt-4">
          <Button
            variant="primary"
            disabled={busy !== null || manualUrl.trim() === ''}
            onClick={() => void paste()}
          >
            {busy === 'Reading the page' ? 'Reading…' : 'Read it and store it'}
          </Button>
        </div>

        {/* Handshake, LinkedIn and Indeed. The address alone is not enough for these: their
            terms refuse automated reads and Handshake is behind a university login, so the
            fetch above would come back with a sign-in wall rather than a posting. The student
            reading their own account is not automated access, so the text comes from them. */}
        <div className="border-rule/60 mt-10 border-t pt-8">
          <h3 className="u-eyebrow mb-2">Handshake, LinkedIn or Indeed</h3>
          <p className="text-dim u-prose mb-5">
            Those three refuse automated readers, and Handshake needs your school login, so the box
            above will only reach a sign-in page. Open the posting there yourself, copy its
            description, and paste it here — everything after this point works the same way it does
            for any other posting.
          </p>

          <div className="grid max-w-3xl gap-5 sm:grid-cols-2">
            <TextField
              label="Job title"
              value={pastedTitle}
              onChange={(e) => setPastedTitle(e.target.value)}
              placeholder="Software Engineering Intern"
            />
            <TextField
              label="Company"
              value={pastedCompany}
              onChange={(e) => setPastedCompany(e.target.value)}
              placeholder="Acme"
            />
          </div>
          <div className="mt-5 max-w-3xl">
            <TextField
              label="Link to the posting"
              hint="Stored so you can get back to it. Never opened by this tool."
              value={pastedUrl}
              onChange={(e) => setPastedUrl(e.target.value)}
              placeholder="https://app.joinhandshake.com/jobs/…"
            />
          </div>
          <div className="mt-5 max-w-3xl">
            <TextArea
              label="The job description"
              hint="Paste the whole thing. Requirements are read out of this text."
              rows={8}
              value={pastedText}
              onChange={(e) => setPastedText(e.target.value)}
            />
          </div>
          <div className="mt-4">
            <Button
              variant="primary"
              disabled={busy !== null || !canPaste}
              onClick={() => void pasteText()}
            >
              {busy === 'Storing what you pasted' ? 'Storing…' : 'Store this posting'}
            </Button>
          </div>
        </div>

        {manual && (
          <div className="u-card-flat mt-5 px-5 py-4" role="status" aria-live="polite">
            <p className="text-lg">{manual.posting.title}</p>
            <p className="text-dim">{manual.posting.company}</p>
            <p className="text-faint u-data mt-3 text-xs">
              {manual.usedJsonLd
                ? 'Read from the structured job data the page publishes.'
                : 'The page published no structured job data, so this was read from its text.'}
            </p>
            {manual.notes.map((n, i) => (
              <p key={i} className="text-faint u-prose mt-1.5 text-xs">
                {n}
              </p>
            ))}
            {/* The control, not a pointer to one. This read "press Score what is stored
                above", and that button lives inside the run-summary block — which only a
                search renders. The Tier C user pastes a posting and never runs a search, so
                for exactly the person section 05 exists to serve, the named button was
                nowhere on the page. */}
            <p className="text-faint u-prose mt-3 text-sm">
              Stored, and not yet scored. Scoring reads it for its requirements and puts it in front
              of you at G2.
            </p>
            <div className="mt-4">
              <Button variant="primary" disabled={busy !== null} onClick={() => void score()}>
                {busy === 'Scoring' ? 'Scoring…' : 'Score what is stored'}
              </Button>
            </div>
            {/* The same state, drawn the same way as in the run summary above — this second
                copy had the tone hard-coded too, and the Tier C user who only ever pastes
                postings meets scoring HERE and nowhere else. */}
            {scored && <Notice tone={scored.ok ? 'verified' : 'caution'}>{scored.message}</Notice>}
          </div>
        )}
      </Section>

      <Section n="06" title="Earlier runs" step={8}>
        {runs.length === 0 ? (
          <Empty title="No run has been recorded on this machine." />
        ) : (
          <ul className="space-y-3">
            {runs.map((r) => (
              <li key={r.runId} className="u-card-flat px-5 py-4">
                <details>
                  <summary className="hover:text-ink cursor-pointer transition-colors">
                    <span className="u-data text-sm">{runHeadline(r)}</span>
                    <span className="text-faint u-data ml-3 text-2xs">
                      {whenLabel(r.startedAt)} · {durationLabel(r.startedAt, r.finishedAt)} ·{' '}
                      {r.targets} {r.targets === 1 ? 'target' : 'targets'}
                      {r.skipped.length > 0 && (
                        <span className="text-caution">
                          {' '}
                          · {r.skipped.length} gap{r.skipped.length === 1 ? '' : 's'}
                        </span>
                      )}
                    </span>
                  </summary>
                  <ul className="divide-rule/50 mt-3 divide-y">
                    {r.bySource.map((s, i) => (
                      <li
                        key={`${s.source}:${s.board}:${i}`}
                        className="flex flex-wrap items-baseline justify-between gap-3 py-2"
                      >
                        <span className="text-dim text-sm">
                          {sourceLabel(s.source)} {s.board}
                        </span>
                        <span className="u-data text-faint text-xs">
                          {s.found} found · {s.new} new
                        </span>
                      </li>
                    ))}
                  </ul>
                  {r.skipped.map((s, i) => (
                    <p key={i} className="text-caution u-prose mt-2 text-xs">
                      {s}
                    </p>
                  ))}
                </details>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <footer className="a-rise a-step-8 mt-12">
        <hr className="u-rule mb-3" />
        <p className="u-eyebrow">
          official&nbsp;APIs&nbsp;and&nbsp;public&nbsp;feeds&nbsp;only&nbsp;·
          nothing&nbsp;is&nbsp;crawled&nbsp;behind&nbsp;a&nbsp;terms&nbsp;wall
        </p>
      </footer>
    </Page>
  );
}

/** One line of the plan. An empty list says so instead of leaving a blank. */
function PlanRow({ label, values }: { label: string; values: string[] }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 py-2.5">
      <span className="text-dim text-base">{label}</span>
      <span className="u-data text-right">
        {values.length > 0 ? values.join(' · ') : <span className="text-faint">none inferred</span>}
      </span>
    </div>
  );
}
