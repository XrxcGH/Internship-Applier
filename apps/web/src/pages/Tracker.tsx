import { ExternalLink } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import {
  downloadFile,
  getDraftMessage,
  getTracker,
  setStatus,
  type Rate,
  type TrackedApp,
  type TrackerView,
} from '../lib/api';
import { recordSubmittedByHand, refusal, REPORTABLE } from '../lib/tracker';
import { Page, RunningHead, Section } from '../components/Chrome';
import { Badge, Button, Empty, Notice } from '../components/Controls';

/**
 * The tracker — docs/11 § M7.
 *
 * Built around one idea: an applicant's real question is never "what is my response rate",
 * it is "what should I do next". So the nudges come first, the board is second, and the
 * numbers are last and refuse to say more than they know.
 */

const COLUMNS = [
  { key: 'preparing', label: 'Preparing', statuses: ['draft', 'answers_ready', 'filled'] },
  { key: 'to_submit', label: 'Ready for you', statuses: ['awaiting_submit'] },
  { key: 'waiting', label: 'Waiting', statuses: ['submitted', 'acknowledged'] },
  { key: 'talking', label: 'Talking', statuses: ['interview'] },
  { key: 'closed', label: 'Closed', statuses: ['offer', 'rejected', 'withdrawn', 'ghosted'] },
];

const ATTENTION_TONE: Record<string, 'redline' | 'caution' | 'verified' | 'neutral'> = {
  deadline_passed: 'redline',
  deadline_soon: 'caution',
  awaiting_your_submit: 'caution',
  ready_to_fill: 'verified',
  unfinished: 'neutral',
  silent: 'neutral',
  none: 'neutral',
};

/** A rate, or the reason there is not one worth showing. */
function RateFigure({ label, rate }: { label: string; rate: Rate }) {
  return (
    <div className="u-card-flat px-5 py-4">
      <p className="u-eyebrow mb-1.5">{label}</p>
      {rate.value === null ? (
        <>
          <p className="u-data text-faint text-xl">
            {rate.numerator} of {rate.denominator}
          </p>
          <p className="text-faint mt-1.5 text-sm leading-snug">{rate.why}</p>
        </>
      ) : (
        <>
          <p className="u-data text-ink text-2xl">{Math.round(rate.value * 100)}%</p>
          <p className="text-faint mt-1 text-sm">
            {rate.numerator} of {rate.denominator}
          </p>
        </>
      )}
    </div>
  );
}

function Card({
  app,
  column,
  onStatus,
  onDraft,
  busy,
}: {
  app: TrackedApp;
  /**
   * The column this card is sitting in, so it can decline to repeat it.
   *
   * The board partitions by `derived.effectiveStatus` and every card then badged that same
   * field — so under "Ready for you" every card read "awaiting submit", and under "Talking"
   * every card read "interview". One fact, stated twice, on every card in two of the five
   * columns. Where a column holds several statuses the badge does distinguish something, and
   * there it stays.
   */
  column: { label: string; statuses: string[] };
  onStatus: (status: string) => void;
  onDraft: () => void;
  busy: boolean;
}) {
  const tone = ATTENTION_TONE[app.derived.attention] ?? 'neutral';

  return (
    <li className="u-card px-4 py-4">
      <p className="u-eyebrow truncate">{app.company}</p>
      <p className="mt-1.5 text-base leading-snug">{app.title}</p>

      {app.derived.nudge && (
        <p
          className="mt-2.5 text-sm leading-snug"
          style={{ color: tone === 'neutral' ? 'var(--ink-dim)' : `var(--${tone})` }}
        >
          {app.derived.nudge}
        </p>
      )}

      <div className="border-rule mt-3 flex flex-wrap items-center gap-2 border-t pt-3">
        {column.statuses.length > 1 && (
          <Badge tone={tone === 'neutral' ? undefined : tone}>
            {app.derived.effectiveStatus.replace(/_/g, ' ')}
          </Badge>
        )}
        {app.source && <Badge>{app.source}</Badge>}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <select
          aria-label={`Report a status change for ${app.title} at ${app.company}`}
          className="u-data bg-raised text-ink border-rule focus:border-accent rounded border px-2 py-1.5 outline-none"
          value=""
          disabled={busy}
          onChange={(e) => e.target.value && onStatus(e.target.value)}
        >
          <option value="">Report…</option>
          {REPORTABLE.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>
        {/* The states a follow-up is FOR, which is not the same as the states a nudge fires
            in. The gate was submitted-or-ghosted, so an application sitting in the
            fourteen-to-forty-five-day nudge window at `acknowledged` or `interview` got a
            reminder whose detail reads "A draft is below." pointing at a button the card did
            not draw. The server half was already right: GET /api/applications/:id/draft-message
            returns the proper text for both of those. */}
        {(app.status === 'submitted' ||
          app.status === 'acknowledged' ||
          app.status === 'interview' ||
          app.derived.effectiveStatus === 'ghosted') && (
          <Button size="sm" onClick={onDraft}>
            Draft a follow-up
          </Button>
        )}
        <a
          href={app.applyUrl}
          target="_blank"
          rel="noreferrer noopener"
          aria-label={`Open the posting for ${app.title} at ${app.company}`}
          className="text-faint hover:text-ink px-1 py-1 transition-colors"
        >
          <ExternalLink aria-hidden size={15} />
        </a>
      </div>
    </li>
  );
}

export function Tracker({ onOpenQueue }: { onOpenQueue?: () => void }) {
  const [view, setView] = useState<TrackerView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ text: string; note: string } | null>(null);

  const refresh = useCallback(() => {
    getTracker()
      .then(setView)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(refresh, [refresh]);

  const report = async (id: string, status: string, from: string): Promise<void> => {
    setBusy(id);
    setError(null);
    try {
      /**
       * "I submitted it" walks the fill steps rather than asking for one hop it cannot take.
       *
       * G4 is the point of the product — the student presses Submit on the real page — and
       * the case that happens in most is the one where this tool could NOT fill the form: an
       * aggregator redirect it refuses to open, a login wall, a bot check, a run that filled
       * nothing. Every one of those leaves the application short of `awaiting_submit`, so the
       * single hop was refused and the only status the student could pick for an application
       * they had actually sent was "Withdrawn".
       *
       * The server always allowed the walk — see `recordSubmittedByHand`. Only this button
       * did not know how to ask.
       */
      if (status === 'submitted') {
        await recordSubmittedByHand(id, from, setStatus);
      } else {
        await setStatus(id, status);
      }
      refresh();
    } catch (err) {
      setError(refusal(err, status));
    } finally {
      setBusy(null);
    }
  };

  const showDraft = async (id: string): Promise<void> => {
    setError(null);
    try {
      const d = await getDraftMessage(id);
      setDraft({ text: d.text, note: d.note });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  if (!view) {
    return (
      <Page>
        <RunningHead section="Tracker" />
        {error ? (
          <Notice tone="redline">{error}</Notice>
        ) : (
          <p className="text-dim a-pulse">Loading…</p>
        )}
      </Page>
    );
  }

  const { applications, reminders, stats } = view;

  return (
    <Page>
      <RunningHead
        section="Tracker"
        lede={
          <>
            Where every application stands, and what each one needs from you. Statuses after
            submitting are <em>yours to report</em>: this tool never submitted anything, so it has
            no way to know what happened next.
          </>
        }
      />

      {error && <Notice tone="redline">{error}</Notice>}

      {draft && (
        <div className="u-card mb-8 px-5 py-5">
          <div className="mb-3 flex items-start justify-between gap-4">
            <p className="u-eyebrow">Follow-up draft</p>
            <Button size="sm" onClick={() => setDraft(null)}>
              Close
            </Button>
          </div>
          <pre className="u-quote text-sm whitespace-pre-wrap">{draft.text}</pre>
          <p className="text-faint mt-3 text-sm">{draft.note}</p>
          <div className="mt-3">
            <Button
              size="sm"
              variant="primary"
              onClick={() => void navigator.clipboard.writeText(draft.text)}
            >
              Copy
            </Button>
          </div>
        </div>
      )}

      {applications.length === 0 ? (
        <Empty title="Nothing tracked yet.">
          Approve a posting in the queue and it appears here.
          {/* The control, not just the instruction. Applications' identical empty state
              carries a button back to the queue; this one named the next step and left the
              reader to find it in the nav. */}
          {onOpenQueue && (
            <div className="mt-4 flex justify-center">
              <Button variant="primary" onClick={onOpenQueue}>
                Open the queue
              </Button>
            </div>
          )}
        </Empty>
      ) : (
        <>
          {reminders.length > 0 && (
            <Section n="01" title="What needs you" step={3}>
              <ul className="space-y-2.5">
                {reminders.map((r, i) => (
                  <li
                    key={i}
                    className={`rounded px-4 py-3 ${r.urgency <= 1 ? 'u-tint-caution' : 'u-card-flat'}`}
                  >
                    <p className="text-base leading-snug">{r.headline}</p>
                    <p className="text-dim mt-1 text-sm leading-snug">{r.detail}</p>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          <Section
            n={reminders.length > 0 ? '02' : '01'}
            title="The board"
            step={4}
            actions={
              <Button
                size="sm"
                onClick={() =>
                  void downloadFile('/api/tracker/export.csv', 'applications.csv').catch(
                    (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
                  )
                }
              >
                Export CSV
              </Button>
            }
          >
            <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-5">
              {COLUMNS.map((col) => {
                const inCol = applications.filter((a) =>
                  col.statuses.includes(a.derived.effectiveStatus),
                );
                return (
                  <div key={col.key}>
                    <p className="u-eyebrow border-rule mb-3 border-b pb-2">
                      {col.label} · {inCol.length}
                    </p>
                    {inCol.length === 0 ? (
                      <p className="text-faint text-sm">Empty.</p>
                    ) : (
                      <ul className="space-y-3">
                        {inCol.map((a) => (
                          <Card
                            key={a.id}
                            app={a}
                            column={col}
                            busy={busy === a.id}
                            onStatus={(s) => void report(a.id, s, a.status)}
                            onDraft={() => void showDraft(a.id)}
                          />
                        ))}
                      </ul>
                    )}
                  </div>
                );
              })}
            </div>
          </Section>

          <Section n={reminders.length > 0 ? '03' : '02'} title="How it is going" step={5}>
            {stats.notes.length > 0 && (
              <ul className="mb-5 space-y-1.5">
                {stats.notes.map((n, i) => (
                  <li key={i} className="text-dim u-prose text-base">
                    {n}
                  </li>
                ))}
              </ul>
            )}

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div className="u-card-flat px-5 py-4">
                <p className="u-eyebrow mb-1.5">Submitted</p>
                <p className="u-data text-ink text-2xl">{stats.funnel.submitted}</p>
                <p className="text-faint mt-1 text-sm">of {stats.funnel.total} tracked</p>
              </div>
              <RateFigure label="Heard back" rate={stats.responseRate} />
              <RateFigure label="Reached interview" rate={stats.interviewRate} />
              <div className="u-card-flat px-5 py-4">
                <p className="u-eyebrow mb-1.5">Typical reply time</p>
                {stats.medianDaysToResponse === null ? (
                  <p className="text-faint text-sm leading-snug">Not enough replies yet to say.</p>
                ) : (
                  <p className="u-data text-ink text-2xl">{stats.medianDaysToResponse} days</p>
                )}
              </div>
            </div>

            <p className="text-faint u-prose mt-5 text-sm italic">
              Percentages only appear once there are enough applications for one to mean something.
              Below that you get the counts, which are the honest version.
            </p>
          </Section>
        </>
      )}
    </Page>
  );
}
