import { useMemo, useRef, useState } from 'react';
import type { Answer, AnswerEvidence } from '../lib/api';
import { Badge, Button, Empty, Notice } from './Controls';

/**
 * Gate G3 — one answer, reviewed.
 *
 * The design brief for this screen is a single sentence: make it faster to check a claim
 * than to ignore it. So the evidence sits beside the text rather than behind a
 * disclosure, clicking a highlighted sentence scrolls its evidence into view, and the
 * approve button states its own blocker instead of just going grey.
 */

const VERDICT_LABEL: Record<AnswerEvidence['verdict'], string> = {
  supported: 'Backed by your profile',
  inferred: 'Loosely tied to your profile',
  unsupported: 'Not in your profile',
  overstated: 'Overstates your profile',
};

const VERDICT_TONE: Record<AnswerEvidence['verdict'], 'verified' | 'caution' | 'redline'> = {
  supported: 'verified',
  inferred: 'caution',
  unsupported: 'redline',
  overstated: 'redline',
};

interface Segment {
  text: string;
  index: number | null;
  verdict: AnswerEvidence['verdict'] | null;
}

/**
 * The answer as this card receives it, plus the one field only some responses carry.
 *
 * `PATCH /api/answers/:id` answers with `verified`, which is false when the edit was saved
 * without a confirmed profile and so was never read against one. Nothing between there and
 * here keeps it: `saveAnswer` types the response as `Answer`, which does not name the field,
 * and Applications stores `{ styleNote }` out of that response and drops the rest. Declared
 * optional so this card can use it the moment it arrives and does not lie in the meantime.
 */
export type ReviewedAnswer = Answer & { verified?: boolean };

/**
 * Did the fact-check run against the text that is on screen right now?
 *
 * `null` is a real answer and the important one. An unchecked answer and a checked one with
 * nothing to flag both arrive here holding `evidence: []`, and the panel printed the same
 * sentence over both — at the gate whose entire job is telling someone what has and has not
 * been checked before they put their name to it. So this returns `true` only on proof, and
 * declines to answer rather than guessing.
 *
 * What counts as proof, and why each one:
 *   `verified`   — the server's own statement about this text. Believed either way.
 *   `evidence`   — a listed claim only exists because the guard produced it.
 *   `flags`      — likewise; an ai_tell or a style_drift comes out of the same pass.
 *   `styleNote`  — written by the same pass, and survives a save in Applications' notes.
 *   `unresolved` — a boolean the draft response always sends, so its PRESENCE is the proof,
 *                  not its value. `false` here means "checked, nothing left unresolved".
 *
 * The reuse path is why none of this can be inferred from text alone: adding a question
 * pre-fills a previously approved answer, and when no profile is confirmed it stores that
 * text with `evidence: []` and `flags: []` and no verification at all.
 */
export function wasChecked(answer: {
  evidence: AnswerEvidence[];
  flags: Answer['flags'];
  styleNote?: string | null;
  unresolved?: boolean;
  verified?: boolean;
}): boolean | null {
  if (answer.verified !== undefined) return answer.verified;
  if (answer.evidence.length > 0 || answer.flags.length > 0) return true;
  if (answer.unresolved !== undefined) return true;
  if (answer.styleNote) return true;
  return null;
}

export interface EvidenceNote {
  state: 'no-text' | 'checked' | 'unchecked' | 'unknown';
  text: string;
}

/**
 * What the evidence column says when it has no claims to list.
 *
 * One sentence used to cover four situations: no answer written yet, an answer checked and
 * found to need no backing, an answer saved without a confirmed profile and so never read
 * against one, and an answer whose payload simply does not say. "Nothing to check yet.
 * Claims appear here as soon as there is text." is true of the first, reassuring and false
 * about the third, and flatly self-contradicting on the other two, where there IS text.
 */
export function evidenceNote(answer: {
  text: string;
  evidence: AnswerEvidence[];
  flags: Answer['flags'];
  styleNote?: string | null;
  unresolved?: boolean;
  verified?: boolean;
}): EvidenceNote {
  if (answer.text.trim().length === 0) {
    return {
      state: 'no-text',
      text: 'Nothing to check yet. Claims appear here as soon as there is text.',
    };
  }
  const checked = wasChecked(answer);
  if (checked === true) {
    return {
      state: 'checked',
      text: 'Read against your profile, and no claim in it needed backing.',
    };
  }
  if (checked === false) {
    return {
      state: 'unchecked',
      text: 'Not read against your profile — that needs a confirmed one (G1). Nothing here backs a word of this yet.',
    };
  }
  return {
    state: 'unknown',
    text: 'No claims are listed against this text. That may mean the check found nothing needing backing, or that it has not run on this version — nothing here says which. Saving it again runs it.',
  };
}

/**
 * Splits the answer into highlighted claims and the plain text between them.
 *
 * Spans are found here rather than trusted from the server: the user edits this text
 * locally, and a stale span would underline the wrong words — which is worse than no
 * underline at all. A claim that no longer appears verbatim simply stops highlighting.
 */
function segment(text: string, evidence: AnswerEvidence[]): Segment[] {
  const hits: Array<{ start: number; end: number; i: number }> = [];
  let cursor = 0;

  evidence.forEach((e, i) => {
    const at = text.indexOf(e.claim, cursor);
    if (at < 0) return;
    hits.push({ start: at, end: at + e.claim.length, i });
    cursor = at + e.claim.length;
  });

  const out: Segment[] = [];
  let pos = 0;
  for (const h of hits) {
    if (h.start > pos) out.push({ text: text.slice(pos, h.start), index: null, verdict: null });
    out.push({ text: text.slice(h.start, h.end), index: h.i, verdict: evidence[h.i]!.verdict });
    pos = h.end;
  }
  if (pos < text.length) out.push({ text: text.slice(pos), index: null, verdict: null });
  return out;
}

/** The same word-sequence comparison the server's edit fraction makes, so "unchanged" means the same thing here. */
function sameWords(a: string, b: string): boolean {
  return (a.match(/\S+/g) ?? []).join(' ') === (b.match(/\S+/g) ?? []).join(' ');
}

function EditMeter({ answer }: { answer: ReviewedAnswer }) {
  const draftWords = (answer.draftText.match(/\S+/g) ?? []).length;
  if (draftWords === 0) return null;
  const pct = Math.min(100, Math.round((answer.editDistance / draftWords) * 100));

  /**
   * An answer nobody has approved is never described as approved.
   *
   * The server writes this line from the distance between the draft and the current text
   * alone, and for a freshly drafted answer those are the same string — so every brand
   * new answer arrived reading "You approved this unchanged." while the header beside it
   * said "not approved" and the button below it still said "Approve (G3)". This is the
   * one screen whose job is telling someone what they have and have not put their name
   * to, so it cannot be the screen that invents an approval. Only the zero-edit line
   * claims anything about approval; the others are true whether or not it happened.
   */
  const summary =
    answer.approvedAt === null && sameWords(answer.draftText, answer.text)
      ? 'Unedited so far.'
      : answer.editSummary;

  return (
    <div className="flex items-center gap-3">
      <div className="bg-sunk h-1 w-24 overflow-hidden rounded-full">
        <div
          className="h-full rounded-full transition-[width] duration-500"
          style={{ width: `${String(Math.max(pct, 2))}%`, background: 'var(--accent)' }}
        />
      </div>
      <span className="text-faint text-sm">{summary}</span>
    </div>
  );
}

export function AnswerReview({
  answer,
  canDraft,
  busy,
  onDraft,
  onSave,
  onApprove,
  onUnapprove,
  onDelete,
}: {
  answer: ReviewedAnswer;
  canDraft: boolean;
  /**
   * The one action in flight anywhere on the page, as `verb:answerId`, or null.
   *
   * The whole key rather than a per-card verb, because every card has to go quiet while
   * any request is running. This used to be told only about drafting and approving on its
   * own answer, so a save, a reopen or a delete left every button live — and starting a
   * draft on a second answer while the first was still running meant the first one
   * finishing re-enabled the second's button mid-request, ready to fire the same paid
   * call again.
   */
  busy: string | null;
  onDraft: () => void;
  /** May return a promise; Save waits for it, so a rejection keeps the editor open. */
  onSave: (text: string) => void | Promise<boolean | void>;
  onApprove: () => void;
  onUnapprove: () => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(answer.text);
  const [active, setActive] = useState<number | null>(null);
  const evidenceRefs = useRef<Array<HTMLLIElement | null>>([]);

  const drafting = busy === `draft:${answer.id}`;
  const approving = busy === `approve:${answer.id}`;

  /**
   * Highlight and evidence move together.
   *
   * The evidence column is as long as the answer has claims, so on a long answer the
   * entry that just lit up was frequently below the fold — the reader clicked a
   * highlighted sentence and, as far as they could tell, nothing happened.
   */
  const show = (index: number) => {
    const next = active === index ? null : index;
    setActive(next);
    if (next !== null) evidenceRefs.current[next]?.scrollIntoView({ block: 'nearest' });
  };

  const shown = editing ? text : answer.text;
  const segments = useMemo(
    () => segment(answer.text, answer.evidence),
    [answer.text, answer.evidence],
  );

  const blocking = answer.evidence.filter(
    (e) => e.verdict === 'unsupported' || e.verdict === 'overstated',
  );
  /**
   * The reasons, in the same order as the claims they belong to.
   *
   * The server builds its flags from guard.blocking and its evidence from guard.claims,
   * in that order, so the two line up index for index. They used to be joined by a
   * `find()` that referenced neither the claim nor its index — so with two or more
   * flagged claims, every row after the first printed the FIRST claim's reason. On the
   * one screen the G3 gate is built around, that tells the user the wrong thing about why
   * their sentence is blocked.
   */
  const blockingNotes = answer.flags.filter(
    (f) => f.type === 'unsupported' || f.type === 'overstated',
  );
  const tells = answer.flags.filter((f) => f.type === 'ai_tell');
  const drift = answer.flags.filter((f) => f.type === 'style_drift');
  const words = (answer.text.match(/\S+/g) ?? []).length;

  return (
    <article className="u-card overflow-hidden">
      {/* ── question */}
      <header className="border-rule flex flex-wrap items-start justify-between gap-4 border-b px-6 py-5">
        <div className="min-w-0 flex-1">
          <p className="text-lg leading-snug">{answer.questionText}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Badge>{answer.archetype.replace(/_/g, ' ')}</Badge>
            {words > 0 && (
              <Badge>
                {words} {words === 1 ? 'word' : 'words'}
              </Badge>
            )}
            {answer.reusedFrom && (
              <Badge tone="accent">reused · {answer.reusedFrom.useCount}×</Badge>
            )}
          </div>
        </div>
        {answer.approvedAt ? (
          <span className="a-stamp u-data text-verified shrink-0 text-2xs tracking-widest uppercase">
            approved
          </span>
        ) : (
          <span className="u-data text-faint shrink-0 text-2xs tracking-widest uppercase">
            not approved
          </span>
        )}
      </header>

      {/* The editing check matters. Without it, the empty-state card stayed on screen
          above the textarea during "Write it myself", and its own "Write it myself"
          button reset the text to empty — wiping whatever had been typed below, with no
          undo. "Remove question", one button along, deleted the answer outright. */}
      {answer.text.trim().length === 0 && !editing ? (
        <div className="px-6 py-8">
          <Empty title="No answer yet.">
            {canDraft
              ? 'Draft one from your profile, or write it yourself. Either way, it gets fact-checked.'
              : 'Write it yourself below. It still gets fact-checked against your profile.'}
          </Empty>
          <div className="mt-4 flex flex-wrap gap-3">
            {canDraft && (
              <Button variant="solid" onClick={onDraft} disabled={busy !== null}>
                {drafting ? 'Drafting…' : 'Draft it'}
              </Button>
            )}
            <Button
              onClick={() => {
                setEditing(true);
                setText('');
              }}
            >
              Write it myself
            </Button>
            <Button variant="danger" size="sm" onClick={onDelete} disabled={busy !== null}>
              Remove question
            </Button>
          </div>
        </div>
      ) : null}

      {(answer.text.trim().length > 0 || editing) && (
        <div className="grid gap-0 lg:grid-cols-[1fr_20rem]">
          {/* ── the answer */}
          <div className="border-rule px-6 py-5 lg:border-r">
            {editing ? (
              /* The box the whole of G3 is built around, and it announced itself as
                 "edit text, blank" — no label, no aria-label, not even a placeholder, on the
                 one screen this file has already twice been rewritten to serve: the claim
                 highlights and the evidence list both became real buttons so a keyboard or
                 screen-reader user could reach what they mean. The edit box those fixes exist
                 to serve was left nameless. Named from the question rather than wrapped in
                 the repo's TextArea, whose visible label would repeat the question already
                 shown in this card's header. */
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={Math.max(8, Math.ceil(text.length / 70) + 2)}
                autoFocus
                aria-label={`Your answer to: ${answer.questionText}`}
                className="border-rule focus:border-accent u-prose w-full resize-y rounded border bg-transparent p-4 outline-none transition-colors"
              />
            ) : (
              <p className="u-prose text-lg whitespace-pre-wrap">
                {segments.map((s, i) =>
                  s.index === null ? (
                    <span key={i}>{s.text}</span>
                  ) : (
                    /* A real button. These were `<span onClick>` with the verdict in a
                       hover-only `title`, so on the screen where a claim's backing
                       evidence is the entire point, a keyboard or screen-reader user
                       could reach Approve but never find out what a highlight meant. */
                    <button
                      key={i}
                      type="button"
                      className={`u-claim u-claim-${s.verdict!}`}
                      data-active={active === s.index}
                      aria-pressed={active === s.index}
                      onClick={() => show(s.index!)}
                      title={VERDICT_LABEL[s.verdict!]}
                    >
                      {s.text}
                      <span className="sr-only"> — {VERDICT_LABEL[s.verdict!]}</span>
                    </button>
                  ),
                )}
              </p>
            )}

            <div className="mt-5 flex flex-wrap items-center justify-between gap-4">
              <EditMeter answer={answer} />
              <div className="flex flex-wrap gap-2">
                {editing ? (
                  <>
                    <Button
                      variant="solid"
                      size="sm"
                      disabled={busy !== null}
                      onClick={() => {
                        // Awaited, and only closed on success. Closing first meant a
                        // failed save left the typed answer nowhere: the view falls back
                        // to the stale stored text, and Edit overwrites the local copy on
                        // the way back in.
                        void Promise.resolve(onSave(text)).then((ok) => {
                          if (ok !== false) setEditing(false);
                        });
                      }}
                    >
                      Save
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => {
                        setText(answer.text);
                        setEditing(false);
                      }}
                    >
                      Cancel
                    </Button>
                  </>
                ) : (
                  <>
                    <Button
                      size="sm"
                      onClick={() => {
                        setText(answer.text);
                        setEditing(true);
                      }}
                    >
                      Edit
                    </Button>
                    {canDraft && (
                      <Button size="sm" onClick={onDraft} disabled={busy !== null}>
                        {drafting ? 'Drafting…' : 'Redraft'}
                      </Button>
                    )}
                  </>
                )}
              </div>
            </div>

            {/* ── flags */}
            {blocking.length > 0 && (
              <div className="u-tint-redline mt-5 rounded px-4 py-3">
                <p className="u-data text-redline mb-2 text-2xs tracking-widest uppercase">
                  {blocking.length === 1
                    ? '1 claim blocks approval'
                    : `${blocking.length} claims block approval`}
                </p>
                <ul className="space-y-2">
                  {blocking.map((b, i) => (
                    <li key={i} className="text-dim text-base">
                      <span className="text-ink">“{b.claim}”</span>
                      <br />
                      {blockingNotes[i]?.note ?? VERDICT_LABEL[b.verdict]}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {tells.length > 0 && (
              <div className="u-tint-caution mt-4 rounded px-4 py-3">
                <p className="u-data text-caution mb-2 text-2xs tracking-widest uppercase">
                  reads as machine-written
                </p>
                <ul className="text-dim space-y-1 text-base">
                  {tells.slice(0, 6).map((t, i) => (
                    <li key={i}>{t.note}</li>
                  ))}
                </ul>
              </div>
            )}

            {drift.length > 0 && (
              <div className="text-faint mt-4 text-base">
                {drift.map((d, i) => (
                  <p key={i}>{d.note}</p>
                ))}
              </div>
            )}

            {answer.styleNote && (
              <p className="text-faint mt-4 text-sm italic">{answer.styleNote}</p>
            )}

            {/* ── the gate */}
            <div className="border-rule mt-6 border-t pt-5">
              {answer.approvedAt ? (
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span className="text-dim text-base">
                    You approved this. It will be filled in for you; you still submit it{' '}
                    <em>yourself</em>.
                  </span>
                  <Button size="sm" onClick={onUnapprove} disabled={busy !== null}>
                    Reopen
                  </Button>
                </div>
              ) : blocking.length > 0 ? (
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span className="text-dim text-base">
                    Fix the flagged {blocking.length === 1 ? 'claim' : 'claims'} above, or add the
                    missing facts to your profile.
                  </span>
                  <Button variant="solid" disabled title="Flagged claims block approval.">
                    Approve (G3)
                  </Button>
                </div>
              ) : (
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span className="text-dim text-base">
                    Read it once more. Approving means you stand behind <em>every sentence</em>.
                  </span>
                  <Button
                    variant="solid"
                    onClick={onApprove}
                    disabled={busy !== null || editing || shown.trim().length === 0}
                  >
                    {approving ? 'Checking…' : 'Approve (G3)'}
                  </Button>
                </div>
              )}
            </div>
          </div>

          {/* ── evidence */}
          <aside className="bg-sunk/40 px-5 py-5">
            <p className="u-eyebrow mb-3">Evidence</p>
            {answer.evidence.length === 0 ? (
              /* Four states behind what used to be one sentence — see `evidenceNote`. Only
                 the definite negative is coloured: an answer that has not been read against
                 the profile is a warning, and an answer whose payload cannot say either way
                 is an absence of information rather than bad news, so it is not dressed as
                 one. Neither blocks the gate — approving re-verifies on the server — but the
                 user is deciding whether to stand behind the sentence, and what has actually
                 been checked is the thing they are entitled to know. */
              <p
                className={`text-sm ${
                  evidenceNote(answer).state === 'unchecked' ? 'text-caution' : 'text-faint'
                }`}
              >
                {evidenceNote(answer).text}
              </p>
            ) : (
              <ol className="space-y-3">
                {answer.evidence.map((e, i) => (
                  <li
                    key={i}
                    ref={(el) => {
                      evidenceRefs.current[i] = el;
                    }}
                  >
                    {/* The click target is a button, not the <li>. Same reason as the
                        claim highlights: this list is how a keyboard user finds out
                        which fact backs which sentence. */}
                    <button
                      type="button"
                      onClick={() => show(i)}
                      aria-pressed={active === i}
                      className={`block w-full rounded px-3 py-2.5 text-left transition-colors ${
                        active === i ? 'bg-accent/12' : 'hover:bg-ink/[0.04]'
                      }`}
                    >
                      <span className="mb-1.5 block">
                        <Badge tone={VERDICT_TONE[e.verdict]}>{VERDICT_LABEL[e.verdict]}</Badge>
                      </span>
                      <span className="text-dim block text-sm leading-snug">
                        {e.claim.length > 90 ? `${e.claim.slice(0, 90)}…` : e.claim}
                      </span>
                      {e.quote && (
                        <span className="u-quote mt-2 block text-2xs">
                          {e.quote.length > 140 ? `${e.quote.slice(0, 140)}…` : e.quote}
                        </span>
                      )}
                      {e.profileRef && (
                        <span className="u-data text-faint mt-1.5 block text-2xs">
                          {e.profileRef}
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ol>
            )}

            {answer.unresolved && (
              <Notice tone="caution">
                The draft still had unsupported claims after one revision. That is the model
                failing, <em>not you</em>. Edit it directly.
              </Notice>
            )}
          </aside>
        </div>
      )}
    </article>
  );
}
