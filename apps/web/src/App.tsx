import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { HealthResponse } from '@ia/shared';
import { fetchHealth } from './lib/api';
import {
  Field,
  Nav,
  Page,
  RunningHead,
  Section,
  type ProfileStatus,
  type View,
} from './components/Chrome';
import { Button, Notice } from './components/Controls';
import { Onboarding } from './pages/Onboarding';
import { Discovery } from './pages/Discovery';
import { Matches } from './pages/Matches';
import { Applications } from './pages/Applications';
import { Voice } from './pages/Voice';
import { Tracker } from './pages/Tracker';
import { Settings } from './pages/Settings';

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; health: HealthResponse }
  | { kind: 'error'; message: string };

// No `view` on these. They were a second navigation and are a statement now, so a field
// naming where each one leads is a field nothing reads — and the next person to see it would
// reasonably wire it back up.
const GATES = [
  {
    id: 'G1',
    label: 'Confirm profile',
    note: 'You correct what was read from your resume.',
  },
  {
    id: 'G2',
    label: 'Approve posting',
    note: 'One explicit approval, per application.',
  },
  {
    id: 'G3',
    label: 'Review answers',
    note: 'You read and edit every generated sentence.',
  },
  { id: 'G4', label: 'Submit', note: 'You click Submit yourself, on the real page.' },
];

/**
 * The build tracker that used to live on this screen is gone.
 *
 * Nine cards, M0 through M8, every one of them reading "done" — so the section carried no
 * information even to the person who wrote it, and to a student looking for an internship it
 * was a stranger's project plan occupying the third of the home page. What a milestone list
 * answers is "is this finished", which the app answers better by working; what the user
 * needs this screen for is the next thing to do. The gates above are the honest half of what
 * this was trying to say, and they stay.
 */

export function App() {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [view, setView] = useState<View>('home');
  /**
   * What the open screen is in the middle of, so the nav can refuse to unmount it.
   *
   * Held here rather than on the screens because the nav is here. Each long operation is
   * guarded by a `busyRef` inside the component that started it, and unmounting that
   * component throws the guard away — see the comment on `Nav`. A screen with nothing in
   * flight reports null and nothing is locked.
   */
  const [busy, setBusy] = useState<string | null>(null);

  // Whatever the last screen was doing, it is not doing it here. Without this a screen
  // unmounted by anything other than the nav — the Home gate buttons, `onDone` — could
  // leave the bar locked with no way to clear it but a reload.
  useEffect(() => setBusy(null), [view]);

  const refresh = useCallback(() => {
    fetchHealth()
      .then((health) => setState({ kind: 'ready', health }))
      .catch((err: unknown) =>
        setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) }),
      );
  }, []);

  useEffect(refresh, [refresh]);

  /**
   * The four states the nav needs told apart. `confirmed` stays a boolean for the Home
   * button, which genuinely only cares whether G1 is done.
   */
  const profile: ProfileStatus =
    state.kind === 'loading'
      ? 'checking'
      : state.kind === 'error'
        ? 'unreachable'
        : state.health.profileConfirmed
          ? 'confirmed'
          : 'unconfirmed';
  const confirmed = profile === 'confirmed';

  /**
   * The way back from a failed health check.
   *
   * `refresh` is a `useCallback(…, [])` wired to one `useEffect`, so a single failed fetch
   * pinned the app for the life of the tab — with four nav destinations greyed out and no
   * control anywhere to ask again. Settings already learned this lesson and put a "Try again"
   * inside its error banner; the landing screen is the one place it was not applied.
   *
   * The loading reset lives HERE and not inside `refresh` itself: `Onboarding`'s `onDone`
   * calls refresh too, and flipping to 'loading' there would drop `confirmed` and re-lock the
   * whole nav at the moment the queue mounts.
   */
  const retry = useCallback(() => {
    setState({ kind: 'loading' });
    refresh();
  }, [refresh]);

  const body = (): ReactNode => {
    if (view === 'setup') {
      return (
        <Onboarding
          // Called by the confirmation screen, not by the confirm request. Navigating the
          // moment the request returned unmounted Onboarding in the same render, so the
          // "profile established" stamp — the one acknowledgement G1 gives the user for
          // the work they just did — was never on screen for a single frame.
          onBusy={setBusy}
          onDone={() => {
            refresh();
            setView('queue');
          }}
          // `refresh()` on this path too, and it is not optional: `confirmed` is derived from
          // the health fetch, and the whole nav is locked on it until that answer arrives.
          onFindPostings={() => {
            refresh();
            setView('discovery');
          }}
        />
      );
    }
    if (view === 'voice') return <Voice />;
    if (view === 'discovery')
      return <Discovery onOpenQueue={() => setView('queue')} onBusy={setBusy} />;
    if (view === 'queue') {
      return (
        <Matches
          onOpenApplications={() => setView('applications')}
          onOpenDiscovery={() => setView('discovery')}
          onBusy={setBusy}
        />
      );
    }
    if (view === 'applications') return <Applications onBack={() => setView('queue')} />;
    if (view === 'tracker') return <Tracker onOpenQueue={() => setView('queue')} />;
    if (view === 'settings') return <Settings />;
    return (
      <Home
        state={state}
        confirmed={confirmed}
        profile={profile}
        onNavigate={setView}
        onRetry={retry}
      />
    );
  };

  return (
    <>
      {/* A skip link and a main landmark, which the app had neither of.

          Every screen is reached through the same eight-item nav, so a keyboard or
          screen-reader user tabbed past all eight on every navigation to reach the content,
          and had no landmark to jump to instead. The link is visually hidden until it takes
          focus, which is the one time it is useful. */}
      <a href="#main" className="u-skip-link">
        Skip to content
      </a>
      <Nav view={view} onNavigate={setView} profile={profile} busy={busy} />
      <main id="main" tabIndex={-1}>
        {body()}
      </main>
    </>
  );
}

function Home({
  state,
  confirmed,
  profile,
  onNavigate,
  onRetry,
}: {
  state: State;
  confirmed: boolean;
  profile: ProfileStatus;
  onNavigate: (v: View) => void;
  /** Asks the server again after a failed health check. See `retry` in App. */
  onRetry: () => void;
}) {
  return (
    <Page>
      <RunningHead
        section="A working dossier"
        gate={profile === 'unconfirmed' ? 'G1' : undefined}
        /* "Nothing is sent anywhere until you sign for it" was the first sentence of the
           product and it was not true. Reading a resume sends it to the model; drafting an
           answer sends the posting's text and the facts behind it. Both are the user's own
           model access — their Claude subscription or their key — and neither is an employer,
           but "nowhere" is not what a reader takes from "nothing is sent anywhere", and this
           is the screen carrying the strongest privacy promise in the app.

           The guarantee that IS true is the one worth making: nothing reaches an EMPLOYER
           without the user, because no code path can submit. Settings lists what leaves the
           machine and where it goes. */
        lede={
          <>
            Every filter decision here quotes the job description that caused it. Every drafted
            sentence points at the fact behind it. <strong>Nothing reaches an employer</strong>{' '}
            until you send it yourself — and what leaves this machine at all is listed in Settings.
          </>
        }
      />

      {/* The status panel is a short list and the gates need room, so they sit side by
          side rather than stacking down the middle of a laptop screen. */}
      <div className="grid gap-x-14 lg:grid-cols-[24rem_minmax(0,1fr)]">
        <Section n="01" title="Where to start" step={4}>
          {state.kind === 'loading' && <p className="text-dim a-pulse">Checking the server…</p>}

          {state.kind === 'error' && (
            <div>
              <Notice tone="redline">
                <strong>The interface cannot reach the server.</strong> Nothing below is live.
              </Notice>
              <p className="u-quote mt-3">{state.message}</p>
              <p className="text-dim mt-4">
                Start it with <span className="u-data">npm run dev</span>.
              </p>
              {/* Without this the app is pinned for the life of the tab: the health fetch
                  runs from one useEffect with a stable callback, so nothing asks again. */}
              <div className="mt-4">
                <Button onClick={onRetry}>Try again</Button>
              </div>
            </div>
          )}

          {state.kind === 'ready' && (
            <>
              {/* A dead database inside a 200 answer, which the redline branch above
                  cannot catch: it is gated on the fetch or the parse failing, and
                  `db: { connected: false }` parses perfectly well. Deleting the old
                  "Ledger" row without this would leave that state reported nowhere. */}
              {!state.health.db.connected && (
                <Notice tone="redline">
                  <strong>The local database is not answering.</strong> Nothing you do here will be
                  saved.
                </Notice>
              )}
              {/* Runtime, uptime and a table count used to sit here, above everything else on
                  the first screen of the app: a health-check readout served to a student
                  before they were told what to do. So did a "Status" row that could only ever
                  read "ok" — the shared schema types it `z.literal('ok')`, so any other
                  answer fails the parse and lands in the error branch above instead.

                  The profile row stays. It is not the nav pill in miniature: that reads
                  local/setup rather than confirmed, and it is hidden below the sm breakpoint. */}
              <div className="u-card-flat divide-rule/60 divide-y px-5 py-2">
                <Field
                  label="Profile"
                  value={state.health.profileConfirmed ? 'confirmed' : 'not yet established'}
                  tone={state.health.profileConfirmed ? 'var(--verified)' : 'var(--caution)'}
                />
              </div>

              <div className="mt-6 flex flex-wrap gap-3">
                <Button variant="solid" onClick={() => onNavigate('setup')}>
                  {confirmed ? 'Revisit profile' : 'Establish profile (G1)'}
                </Button>
                {confirmed && (
                  <>
                    {/* Ahead of the queue on purpose. A confirmed profile with nothing
                        searched yet reaches an empty queue, and the button that fixes
                        that was reachable only from the nav bar. */}
                    <Button variant="primary" onClick={() => onNavigate('discovery')}>
                      Find postings
                    </Button>
                    <Button onClick={() => onNavigate('queue')}>Open the queue (G2)</Button>
                    <Button onClick={() => onNavigate('voice')}>Set up your voice</Button>
                  </>
                )}
              </div>
            </>
          )}
        </Section>

        <Section n="02" title="The four gates" step={5}>
          {/* A statement of the four gates, which is what the heading says it is — not a second
              navigation.

              Every card was a button, and two of them went where Section 01 above already
              sends the reader with real primary buttons, which the persistent nav offers a
              third time: three routes to two destinations on one screen. The other two were
              permanently disabled — G3 has no view of its own and G4 is not a screen at all —
              so half of "the four gates" rendered as dead controls with nothing to say why,
              and a dead control reads as a broken one. */}
          <ol className="grid gap-3 sm:grid-cols-2">
            {GATES.map((g, i) => (
              <li
                key={g.id}
                className={`u-card-flat flex gap-4 px-5 py-4 a-rise a-step-${String(Math.min(i + 5, 8))}`}
              >
                <span className="u-data text-accent w-7 shrink-0 pt-1">{g.id}</span>
                <span>
                  <span className="block text-lg leading-snug">{g.label}</span>
                  <span className="text-dim mt-1 block text-base leading-snug">{g.note}</span>
                </span>
              </li>
            ))}
          </ol>
          <p className="text-faint u-prose mt-6">
            {/* The promise is the point and stays; the proof was in developer's terms. A
                student does not know what a lint rule or a CI check is, and listing three of
                them made the sentence about how the project is built rather than about what
                the tool will not do to them. What survives is the fact and the reason it can
                be relied on — that the capability is absent rather than merely switched off. */}
            <em>None of these can be switched off.</em> Nothing in this tool can submit an
            application — the ability was never built, so the last click on a real application page
            is always yours.
          </p>
        </Section>
      </div>

      <footer className="a-rise a-step-8 mt-16">
        <hr className="u-rule a-draw a-step-8 mb-4" />
        {/* Not "local only". Settings names six things that do leave this machine — the
            job-source lookups, the resume when the model reads it, the search brief, a
            posting's text, whatever is sent while drafting, and the application sites —
            and the upload step says outright that a PDF is sent to the model. This was the
            last line a new user reads on the landing screen, and it contradicted all of it. */}
        <p className="u-eyebrow">
          no&nbsp;telemetry&nbsp;· stored&nbsp;on&nbsp;your&nbsp;machine&nbsp;·
          what&nbsp;leaves&nbsp;is&nbsp;listed&nbsp;in&nbsp;Settings
        </p>
      </footer>
    </Page>
  );
}
