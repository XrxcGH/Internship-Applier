import { ArrowLeft, ExternalLink } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import {
  addQuestion,
  ApiError,
  approveAnswer,
  deleteAnswer,
  draftAnswer,
  getApplication,
  listApplications,
  saveAnswer,
  unapproveAnswer,
  type Answer,
  type ApplicationDetail,
  type ApplicationSummary,
} from '../lib/api';
import { Field, Page, RunningHead, Section } from '../components/Chrome';
import { Badge, Button, Empty, Notice, TextArea } from '../components/Controls';
import { AnswerReview } from '../components/AnswerReview';
import { FillReview } from '../components/FillReview';

/** Questions worth having on hand — most applications ask some version of these. */
const COMMON_QUESTIONS = [
  'Why do you want to work here?',
  'Tell us about a project you are proud of.',
  'Describe a technical challenge you worked through.',
  'What are you hoping to learn from this internship?',
  'Is there anything else you would like us to know?',
];

export function Applications({ onBack }: { onBack: () => void }) {
  const [list, setList] = useState<ApplicationSummary[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    listApplications()
      .then(setList)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(refresh, [refresh]);

  if (openId) {
    return (
      <Detail
        id={openId}
        // GET /api/applications/:id now answers with the application's own state, so the
        // detail no longer has to look itself up in the list beside it. That lookup was
        // right only while the list happened to be loaded and happened to hold this row —
        // otherwise it read null and the fill panel offered to open and fill a form the user
        // had already told it they sent. Kept as the fallback for the first paint, before
        // the detail request lands.
        submittedAt={list?.find((a) => a.id === openId)?.submittedAt ?? null}
        onBack={() => {
          setOpenId(null);
          refresh();
        }}
      />
    );
  }

  return (
    <Page>
      <RunningHead
        section="Applications"
        gate="G3"
        lede={
          <>
            Everything you approved in the queue. Each one needs its questions answered and every
            answer <em>read</em> before anything gets filled in.
          </>
        }
      />

      {error && <Notice tone="redline">{error}</Notice>}

      {/* Yields to the error, as Tracker already does. Keyed only on 'list === null',
          a failed load pulsed "Loading…" under the red banner forever. */}
      {list === null && !error && <p className="text-dim a-pulse text-sm">Loading…</p>}

      {list?.length === 0 && (
        <Empty title="No applications yet.">
          Approve a posting in the queue and it lands here.{' '}
          {/* An inline link inside a sentence, so it keeps the underline rather than becoming
              a Button — but it still has to be hittable: at 31px it was the one control in the
              app under the 44px a touch device wants, because it carried no vertical padding. */}
          <button
            onClick={onBack}
            className="text-accent inline-flex min-h-11 items-center underline underline-offset-4"
          >
            Open the queue
          </button>
        </Empty>
      )}

      {/* Three across on a monitor, two on a laptop, one on a phone. These cards are a
          company, a title and two fields — at one per row they left most of the frame empty,
          and at two they still did on anything above about 1600px. */}
      {list && list.length > 0 && (
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {list.map((a, i) => {
            const ready = a.answerCount > 0 && a.approvedCount === a.answerCount;
            return (
              <li key={a.id} className={`a-rise a-step-${String(Math.min(i + 2, 8))}`}>
                <button
                  onClick={() => setOpenId(a.id)}
                  className="u-card hover:border-rule-strong block w-full px-5 py-5 text-left transition-colors"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <p className="u-eyebrow truncate">{a.company}</p>
                      <p className="mt-1.5 text-lg leading-snug">{a.title}</p>
                    </div>
                    {/* A brand-new application has nothing to review, and saying "in
                        review" directly above "no questions yet" reads as a bug. The
                        detail header already distinguishes this case. */}
                    {/* Submitted outranks everything else on the card. An application
                        the user has already sent still has every answer approved, so it
                        was badged "ready" — reading as work still to do. */}
                    {a.submittedAt ? (
                      <Badge tone="verified">submitted</Badge>
                    ) : a.blockedCount > 0 ? (
                      <Badge tone="redline">{a.blockedCount} flagged</Badge>
                    ) : a.answerCount === 0 ? (
                      <Badge>no questions yet</Badge>
                    ) : ready ? (
                      // Not 'ready'. The Tracker files this same record under Preparing and
                      // badges it 'answers ready', and reserves 'Ready for you' for an
                      // application whose form is filled and waiting on a human to submit. One
                      // word meant two opposite things depending on which screen you were on.
                      <Badge tone="verified">answers approved</Badge>
                    ) : (
                      <Badge tone="caution">in review</Badge>
                    )}
                  </div>

                  <div className="border-rule mt-4 border-t pt-3">
                    <Field
                      label="Answers approved"
                      value={
                        a.answerCount === 0
                          ? 'no questions yet'
                          : `${a.approvedCount} of ${a.answerCount}`
                      }
                      tone={ready ? 'var(--verified)' : undefined}
                    />
                    {a.deadlineAt && <Field label="Closes" value={a.deadlineAt.slice(0, 10)} />}
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Page>
  );
}

function Detail({
  id,
  submittedAt,
  onBack,
}: {
  id: string;
  submittedAt: string | null;
  onBack: () => void;
}) {
  const [app, setApp] = useState<ApplicationDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [newQuestion, setNewQuestion] = useState('');
  /**
   * The three things the server says once and never says again.
   *
   * `unresolved` — the draft still had unsupported claims after the model's own revision —
   * and the style note come back on the draft and the save responses only. `reusedFrom`
   * comes back only on the response that adds a question. None of the three is stored with
   * the answer, so the refresh that follows every action re-fetched a payload without them
   * and they were thrown away unread. AnswerReview renders all three, so the sentence
   * telling someone the MODEL failed rather than they did had never once reached the
   * screen, and neither had the "reused" badge on an answer pulled from the library. Kept
   * beside the answers and merged in below.
   */
  const [notes, setNotes] = useState<
    Record<
      string,
      { styleNote?: string | null; unresolved?: boolean; reusedFrom?: Answer['reusedFrom'] }
    >
  >({});

  const refresh = useCallback(() => {
    getApplication(id)
      .then(setApp)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [id]);

  useEffect(refresh, [refresh]);

  /**
   * Wraps an action so every failure surfaces as a sentence rather than a dead button.
   *
   * Returns whether it worked, because some callers need to know. The editor in
   * AnswerReview closes on save, and closing it after a FAILED save threw away whatever
   * the user had typed — the view falls back to the stored text and there is no copy of
   * the new one anywhere.
   *
   * The key is always `verb:id`. Drafting used to pass the bare answer id while its four
   * siblings passed prefixes, and the value handed to AnswerReview recognised only two of
   * the five — so a save, a reopen or a delete left every button on the card enabled and
   * a second click fired the request again.
   */
  const run = async (key: string, fn: () => Promise<unknown>): Promise<boolean> => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      refresh();
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.code === 'UNVERIFIED_CLAIMS') {
        // The server refused. Refresh so the flags it just recomputed are visible.
        refresh();
      }
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setBusy(null);
    }
  };

  if (!app) {
    return (
      <Page>
        <Button onClick={onBack}>
          <ArrowLeft aria-hidden size={15} />
          Applications
        </Button>
        {error ? (
          <Notice tone="redline">{error}</Notice>
        ) : (
          <p className="text-dim a-pulse mt-8 text-sm">Loading…</p>
        )}
      </Page>
    );
  }

  const approved = app.answers.filter((a) => a.approvedAt).length;
  const ready = app.answers.length > 0 && approved === app.answers.length;

  return (
    <Page>
      <div className="mb-8">
        <Button onClick={onBack}>
          <ArrowLeft aria-hidden size={15} />
          Applications
        </Button>
      </div>

      <RunningHead section={app.title} gate="G3" />

      <div className="mb-10 flex flex-wrap items-center gap-3">
        <Badge tone="accent">{app.company}</Badge>
        {/* The posting itself, in every state. Section 01 tells the student to paste each
            question off the application page, and the only link to that page lived inside
            FillReview — which takes an early return when the form cannot be filled yet, which
            is exactly the state a brand-new application is in. So the screen asked them to go
            and read something it would not let them open. */}
        <a
          href={app.applyUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="u-data text-accent inline-flex min-h-9 items-center gap-1.5 underline underline-offset-4"
        >
          Open the posting
          <ExternalLink aria-hidden size={13} />
        </a>
        <Badge tone={ready ? 'verified' : 'caution'}>
          {app.answers.length === 0
            ? 'no questions yet'
            : `${approved} of ${app.answers.length} approved`}
        </Badge>
        {app.canDraft ? (
          <Badge tone="verified">{app.modelAccess.description}</Badge>
        ) : (
          /* A state, not an explanation. The notice immediately below is the only place the
             workaround needs describing, and this said the same thing in the same words —
             the reader met one reassurance twice before reaching a control. */
          <Badge tone="caution">no model</Badge>
        )}
      </div>

      {error && <Notice tone="redline">{error}</Notice>}

      {/* A user who cannot draft needs to know the rest of the tool still works, or they
          will reasonably conclude it is broken and stop. */}
      {!app.canDraft && (
        <Notice tone="caution">
          <strong>Drafting is unavailable.</strong> {app.modelAccess.description} You can still
          write each answer yourself: it gets fact-checked against your profile, flagged for
          machine-sounding phrasing, and measured against your voice exactly the same way.
        </Notice>
      )}

      <Section n="01" title="Questions from the form" step={3}>
        {app.answers.length === 0 ? (
          <Empty title="No questions added yet.">
            Paste each free-text question from the application below. Reading them off the page
            directly is not something this tool does yet.
          </Empty>
        ) : (
          <div className="space-y-6">
            {app.answers.map((a) => (
              <AnswerReview
                key={a.id}
                answer={{ ...a, ...notes[a.id] }}
                canDraft={app.canDraft}
                busy={busy}
                onDraft={() =>
                  void run(`draft:${a.id}`, async () => {
                    const drafted = await draftAnswer(a.id);
                    setNotes((n) => ({
                      ...n,
                      [a.id]: { styleNote: drafted.styleNote, unresolved: drafted.unresolved },
                    }));
                  })
                }
                onSave={(text) =>
                  run(`save:${a.id}`, async () => {
                    const saved = await saveAnswer(a.id, text);
                    // The whole entry is replaced rather than merged: the user has just
                    // rewritten the text, so whatever the model failed to resolve in its
                    // own draft is no longer a statement about what is on screen.
                    setNotes((n) => ({ ...n, [a.id]: { styleNote: saved.styleNote } }));
                  })
                }
                onApprove={() => void run(`approve:${a.id}`, () => approveAnswer(a.id))}
                onUnapprove={() => void run(`un:${a.id}`, () => unapproveAnswer(a.id))}
                onDelete={() => void run(`del:${a.id}`, () => deleteAnswer(a.id))}
              />
            ))}
          </div>
        )}
      </Section>

      <Section n="02" title="Add a question" step={4}>
        {/* A real label, not a placeholder standing in for one. A placeholder is the
            accessible name only until the box has text in it, at which point the control
            goes nameless — and it disappears visually the moment anyone starts typing. */}
        <TextArea
          label="The question, as the form asks it"
          value={newQuestion}
          onChange={(e) => setNewQuestion(e.target.value)}
          rows={3}
          placeholder="Paste the question exactly as the form asks it."
        />
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button
            variant="solid"
            disabled={newQuestion.trim().length < 3 || busy !== null}
            onClick={() =>
              void run('add', async () => {
                const added = await addQuestion(id, newQuestion.trim());
                if (added.reusedFrom) {
                  setNotes((n) => ({ ...n, [added.id]: { reusedFrom: added.reusedFrom } }));
                }
                setNewQuestion('');
              })
            }
          >
            Add question
          </Button>
          <span className="text-faint text-sm">
            If you have answered it before, the previous answer is pulled in automatically.
          </span>
        </div>

        <div className="mt-6">
          <p className="u-eyebrow mb-2.5">Common ones</p>
          <div className="flex flex-wrap gap-2">
            {COMMON_QUESTIONS.map((q) => (
              <button
                key={q}
                onClick={() => setNewQuestion(q)}
                className="u-card-flat hover:border-rule-strong text-dim hover:text-ink rounded-full px-3 py-1.5 text-sm transition-colors"
              >
                {q}
              </button>
            ))}
          </div>
        </div>
      </Section>

      <Section n="03" title="Fill the form" step={5}>
        <p className="text-faint u-prose mb-5 text-base">
          Sensitive fields are <em>never</em> auto-filled: government IDs, bank details, passwords,
          demographic questions, and anything you have to attest to. Each one gets listed for you
          with the reason.
        </p>
        <FillReview
          applicationId={app.id}
          applyUrl={app.applyUrl}
          canFill={app.answers.length > 0 && ready}
          blockedReason={
            app.answers.length === 0
              ? 'Add the form’s questions above and approve an answer for each one first.'
              : // Not a second count. The header badge already says how many are approved,
                // counting UP; this counted DOWN over the same two numbers, so a reader had
                // to subtract to satisfy themselves the two sentences were one fact.
                'Every answer needs your approval at gate G3 before the form can be filled — ' +
                'the count is at the top of this page.'
          }
          // The application's own answer first; the list row only while the detail request
          // is still in flight. The other way round, a detail opened before the list had
          // settled showed a submitted application as unsubmitted and offered to fill it.
          submittedAt={app.submittedAt ?? submittedAt}
          // Read back from the application rather than from the fill run, which is why it
          // is still here after the browser has been closed. An application saved before
          // this column existed has nothing in it, which is the same as nothing skipped.
          skippedFields={app.skippedFields ?? []}
          onChanged={refresh}
        />
      </Section>
    </Page>
  );
}
