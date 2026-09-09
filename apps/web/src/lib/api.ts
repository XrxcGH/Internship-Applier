import { CandidateProfile, HealthResponse } from '@ia/shared';
import { appToken, clearToken } from './session';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * The one fetch wrapper. Exported because `lib/matches.ts` needs it too.
 *
 * It used to keep a near-identical copy of this function that threw a plain Error, so a
 * 404 from the match endpoints arrived at the queue indistinguishable from a 500 — and
 * the 401 token recovery below had to be remembered in two places.
 */
export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      accept: 'application/json',
      'x-app-token': await appToken(),
      ...(init?.headers ?? {}),
    },
  });
  if (res.status === 401) clearToken();

  const body: unknown = res.status === 204 ? null : await res.json().catch(() => null);

  if (!res.ok) {
    const e = body as { error?: { code?: string; message?: string; details?: unknown } } | null;
    throw new ApiError(
      e?.error?.message ?? `${path} responded ${res.status}`,
      res.status,
      e?.error?.code,
      e?.error?.details,
    );
  }
  return body as T;
}

export const fetchHealth = () => request<HealthResponse>('/api/health').then(HealthResponse.parse);

export async function uploadResume(file: File): Promise<{ documentId: string }> {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch('/api/resumes', {
    method: 'POST',
    body: form,
    headers: { 'x-app-token': await appToken() },
  });
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    // Same recovery `request()` does. This path bypasses it, so a token that died with a
    // server restart stayed cached and every retry of the upload sent it again — healing
    // only when the user happened to do something else, or reloaded the page.
    if (res.status === 401) clearToken();
    const e = body as { error?: { message?: string; code?: string; details?: unknown } } | null;
    throw new ApiError(
      e?.error?.message ?? `Upload failed (${res.status})`,
      res.status,
      e?.error?.code,
      e?.error?.details,
    );
  }
  return body as { documentId: string };
}

/**
 * Reading a resume is a profile write, and it costs approvals like any other.
 *
 * The route answers with `withdrawnApprovals` — its own comment says the key "is spelled the
 * same way PUT /api/profile spells it, on purpose: the wizard and the upload screen both need
 * to say the same sentence to the user" — and this typed the response without it and returned
 * two of the three fields. Re-extraction is the most violent profile write there is: it
 * replaces every fact at once, so it withdraws the most. The student uploaded a corrected
 * resume, was told nothing, went on believing their answers were approved, and found out at
 * G4 when the fill refused.
 *
 * Third time for this exact shape of loss. `readProfileWrite` above was written for it on the
 * profile endpoints, and `DeleteResult.failed` for it on delete-all. The client is not the
 * place a fact goes missing.
 */
export const extractResume = (id: string) =>
  request<unknown>(`/api/resumes/${id}/extract`, { method: 'POST' }).then(readDraftProfile);

/**
 * The same draft an extraction produces, with nothing in it.
 *
 * For the machine with no model, where the dropzone cannot work. Shaped exactly like
 * `extractResume` so the screen that consumes it does not have to know which of the two it
 * called — the difference between them is how full the profile arrives, not what it is.
 */
export const blankProfile = () =>
  request<unknown>('/api/profile/blank', { method: 'POST' }).then(readDraftProfile);

export const getProfile = () =>
  request<unknown>('/api/profile')
    .then(CandidateProfile.parse)
    .catch((err: unknown) => {
      if (err instanceof ApiError && err.status === 404) return null;
      throw err;
    });

/** One G3 approval a profile write took away, and the claims that cost it. */
export interface WithdrawnApproval {
  answerId: string;
  applicationId: string;
  question: string;
  claims: Array<{ claim: string; reason: string }>;
}

/** A profile write, and what it cost. */
export interface ProfileWrite {
  profile: CandidateProfile;
  withdrawnApprovals: WithdrawnApproval[];
}

/**
 * Reads a profile-write response without throwing away the half of it that is not a profile.
 *
 * Both writing endpoints answer with the saved profile PLUS `withdrawnApprovals` — the
 * answers whose G3 approval that write invalidated (routes/profile.ts). This function used
 * to be `.then(CandidateProfile.parse)` at each call site, and a Zod object parse drops
 * unknown keys, so the list was read off the wire and discarded one line later. The student
 * then went on believing an answer was still approved after the app had un-approved it, and
 * found out at G4 when the fill refused. Whatever the caller does with it, the client is not
 * the place that loses it.
 *
 * The list defaults to empty rather than being required, because an unconfirmed profile
 * cannot have produced an approval and the server answers those writes without the field.
 */
function readProfileWrite(body: unknown): ProfileWrite {
  const withdrawn = (body as { withdrawnApprovals?: unknown } | null)?.withdrawnApprovals;
  return {
    profile: CandidateProfile.parse(body),
    withdrawnApprovals: Array.isArray(withdrawn) ? (withdrawn as WithdrawnApproval[]) : [],
  };
}

/** A draft profile, plus the flags the reader raised on it. */
export interface DraftProfileRead extends ProfileWrite {
  needsReview: string[];
}

/**
 * THE TWO PROFILE RESPONSE SHAPES ARE NOT THE SAME, AND THIS IS THE OTHER ONE.
 *
 * `PUT /api/profile` and `POST /api/profile/reviewed/:path` answer with the profile at the
 * top level. The two draft endpoints — resume extraction and the blank profile — answer with
 * it NESTED, as `{ profile, needsReview }`, because they also have to carry the flag list;
 * docs/09 line 41 documents that shape.
 *
 * `extractResume` called `readProfileWrite`, which runs `CandidateProfile.parse` on the body
 * itself. Handed the envelope, that parse throws — so uploading a resume, the first thing
 * this application asks anyone to do, ended at a wall of raw Zod JSON on the G1 screen while
 * the server sat there having read the resume perfectly. It reproduced on the first upload
 * to a clean install, every time, and nothing caught it: no web test exercised this function,
 * and every server-side test asserted the route's JSON rather than what the client made of
 * it, which is exactly the seam the bug lived in.
 *
 * Two readers, named for the two shapes, so the next endpoint has to pick one on purpose.
 */
function readDraftProfile(body: unknown): DraftProfileRead {
  const r = body as { profile?: unknown; needsReview?: unknown } | null;
  const withdrawn = (body as { withdrawnApprovals?: unknown } | null)?.withdrawnApprovals;
  return {
    profile: CandidateProfile.parse(r?.profile),
    withdrawnApprovals: Array.isArray(withdrawn) ? (withdrawn as WithdrawnApproval[]) : [],
    needsReview: Array.isArray(r?.needsReview) ? (r.needsReview as string[]) : [],
  };
}

export const saveProfile = (p: CandidateProfile) =>
  request<unknown>('/api/profile', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(p),
  }).then(readProfileWrite);

export const confirmProfile = () =>
  request<unknown>('/api/profile/confirm', { method: 'POST' }).then(CandidateProfile.parse);

export const clearReviewFlag = (path: string) =>
  request<unknown>(`/api/profile/reviewed/${encodeURIComponent(path)}`, { method: 'POST' }).then(
    readProfileWrite,
  );

// ─────────────────────────────────────────────────────── writing samples & voice

export interface SampleSummary {
  id: string;
  kind: string;
  wordCount: number;
  preview: string;
}

export interface SamplesResponse {
  samples: SampleSummary[];
  totalWords: number;
  adequacy: { level: 'none' | 'thin' | 'enough' | 'plenty'; message: string };
}

export const listSamples = () => request<SamplesResponse>('/api/writing-samples');

export const addSample = (content: string, kind = 'other') =>
  request<{ id: string }>('/api/writing-samples', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content, kind }),
  });

export const deleteSample = (id: string) =>
  request<null>(`/api/writing-samples/${id}`, { method: 'DELETE' });

export interface StyleResponse {
  metrics: Record<string, unknown>;
  description: string[];
  computedAt?: string;
}

export const computeStyle = () =>
  request<StyleResponse>('/api/style-profile/compute', { method: 'POST' });

export const getStyle = () =>
  request<StyleResponse>('/api/style-profile').catch((err: unknown) => {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  });

// ───────────────────────────────────────────────────── applications & answers

export interface ApplicationSummary {
  id: string;
  status: string;
  company: string;
  title: string;
  applyUrl: string;
  deadlineAt: string | null;
  submittedAt: string | null;
  createdAt: string;
  answerCount: number;
  approvedCount: number;
  blockedCount: number;
}

export interface AnswerFlag {
  type: 'unsupported' | 'overstated' | 'style_drift' | 'ai_tell';
  span: { start: number; end: number };
  note: string;
}

export interface AnswerEvidence {
  claim: string;
  verdict: 'supported' | 'inferred' | 'unsupported' | 'overstated';
  profileRef: string | null;
  quote: string | null;
}

export interface Answer {
  id: string;
  applicationId: string;
  questionText: string;
  fieldKey: string;
  answerType: string;
  draftText: string;
  finalText: string;
  text: string;
  editDistance: number;
  editSummary: string;
  evidence: AnswerEvidence[];
  flags: AnswerFlag[];
  approvedAt: string | null;
  archetype: string;
  styleNote?: string | null;
  reusedFrom?: { useCount: number; company: string | null } | null;
  revised?: boolean;
  unresolved?: boolean;
}

export interface ModelAccess {
  provider: 'api' | 'claude_cli' | 'none';
  available: boolean;
  description: string;
  limitations: string[];
}

/**
 * A field the last fill run did not fill, as stored on the application itself.
 *
 * The live version of this list belongs to the fill run, and the run is gone the moment
 * the browser closes, a second run starts or the server restarts. This copy is read back
 * from the application, so what the user still has to type by hand outlives all three.
 */
export interface SkippedField {
  label: string;
  reason: 'redline' | 'unclassified' | 'no_match' | 'failed';
  /** Which redline it is, when `reason` is `redline`. Absent otherwise. */
  category?: string | null;
}

export interface ApplicationDetail {
  id: string;
  company: string;
  title: string;
  description: string;
  applyUrl: string;
  answers: Answer[];
  /** Empty for an application that has never been filled. */
  skippedFields: SkippedField[];
  canDraft: boolean;
  modelAccess: ModelAccess;
  /**
   * Where this application has got to, from the endpoint that loaded it.
   *
   * The detail screen used to read these off the summary list beside it, which is only
   * right while that list is loaded and contains this row — otherwise an application the
   * user has already submitted rendered as unsubmitted.
   */
  status: string;
  submittedAt: string | null;
}

export const getModelAccess = () => request<ModelAccess>('/api/model-access');

export const testModelAccess = () =>
  request<ModelAccess & { tested: boolean; ok?: boolean; detail?: string }>(
    '/api/model-access/test',
    { method: 'POST' },
  );

export const listApplications = () =>
  request<{ applications: ApplicationSummary[] }>('/api/applications').then((r) => r.applications);

export const getApplication = (id: string) => request<ApplicationDetail>(`/api/applications/${id}`);

export const addQuestion = (applicationId: string, questionText: string) =>
  request<Answer>(`/api/applications/${applicationId}/questions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ questionText }),
  });

export const deleteAnswer = (id: string) =>
  request<null>(`/api/answers/${id}`, { method: 'DELETE' });

export const draftAnswer = (id: string, maxWords?: number) =>
  request<Answer>(`/api/answers/${id}/draft`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ maxWords }),
  });

export const saveAnswer = (id: string, text: string) =>
  request<Answer>(`/api/answers/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  });

/** Gate G3. Rejects with 409 UNVERIFIED_CLAIMS while any claim is unsupported. */
export const approveAnswer = (id: string) =>
  request<Answer>(`/api/answers/${id}/approve`, { method: 'POST' });

export const unapproveAnswer = (id: string) =>
  request<Answer>(`/api/answers/${id}/unapprove`, { method: 'POST' });

// ───────────────────────────────────────────────────────────────── form filling

export interface FillFieldResult {
  label: string;
  semantic: string;
  redlineCategory: string | null;
  status: 'ok' | 'mismatch' | 'failed' | 'skipped';
  readBack: string | null;
  note: string | null;
}

export interface FillRunView {
  applicationId: string;
  state: 'opening' | 'reading' | 'awaiting_user' | 'filling' | 'done' | 'failed';
  /** The address the run was asked to open — the application's own apply URL. */
  url: string;
  /**
   * The address the form was actually read from, which is not always the one above: a
   * sign-in redirect, a wizard step or a stale link can put the browser somewhere else.
   * Null until the page has been read.
   */
  pageUrl: string | null;
  message: string;
  startedAt: string;
  // Only the two reasons the server can actually raise (core/filling/browser.ts,
  // `InterventionReason`). It once listed a third, `unknown_field`, that no server code path
  // produces — and the review banner branches two ways, `login` one way and everything else
  // to "Bot check.", so a phantom third reason would have headlined a CAPTCHA that was not on
  // the page. The client union tracks what the server sends, not what it once might have.
  intervention: { reason: 'login' | 'captcha'; detail: string } | null;
  summary: string | null;
  fields?: FillFieldResult[];
  counts: { filled: number; mismatched: number; failed: number; skipped: number } | null;
}

export const startFill = (id: string) =>
  request<FillRunView>(`/api/applications/${id}/fill`, { method: 'POST' });

export const continueFill = (id: string) =>
  request<FillRunView>(`/api/applications/${id}/fill/continue`, { method: 'POST' });

export const getFill = (id: string) =>
  request<FillRunView>(`/api/applications/${id}/fill`).catch((err: unknown) => {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  });

export const discardFill = (id: string) =>
  request<null>(`/api/applications/${id}/fill`, { method: 'DELETE' });

/** Gate G4. Records that YOU submitted it. Opens nothing, clicks nothing. */
export const markSubmitted = (id: string) =>
  request<{ id: string; status: string; submittedAt: string }>(
    `/api/applications/${id}/mark-submitted`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // The server refuses the call without this and answers CONFIRMATION_REQUIRED. It is
      // the user stating they clicked Submit on the real page, which is the only evidence
      // this app can ever have that an application was actually sent.
      body: JSON.stringify({ confirmed: true }),
    },
  );

// ─────────────────────────────────────────────────────────────────── tracker

export interface DerivedState {
  effectiveStatus: string;
  attention:
    | 'deadline_soon'
    | 'deadline_passed'
    | 'unfinished'
    | 'ready_to_fill'
    | 'awaiting_your_submit'
    | 'silent'
    | 'none';
  nudge: string | null;
  daysSinceSubmitted: number | null;
  /** Days since the last thing that happened, which is the number the silence nudge quotes. */
  daysQuiet: number | null;
  daysUntilDeadline: number | null;
}

export interface TrackedApp {
  id: string;
  status: string;
  company: string;
  title: string;
  applyUrl: string;
  source: string | null;
  createdAt: string;
  updatedAt: string;
  submittedAt: string | null;
  deadlineAt: string | null;
  answerCount: number;
  approvedCount: number;
  derived: DerivedState;
}

export interface Reminder {
  applicationId: string;
  kind: 'deadline' | 'follow_up' | 'still_open';
  urgency: number;
  headline: string;
  detail: string;
}

export interface Rate {
  value: number | null;
  numerator: number;
  denominator: number;
  why?: string;
}

export interface TrackerStats {
  funnel: Record<string, number>;
  responseRate: Rate;
  interviewRate: Rate;
  medianDaysToResponse: number | null;
  bySource: Array<{
    key: string;
    submitted: number;
    responded: number;
    advanced: number;
    responseRate: Rate;
  }>;
  notes: string[];
}

export interface TrackerView {
  applications: TrackedApp[];
  reminders: Reminder[];
  stats: TrackerStats;
}

export const getTracker = () => request<TrackerView>('/api/tracker');

export const setStatus = (id: string, status: string) =>
  request<{ id: string; status: string }>(`/api/applications/${id}/status`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status }),
  });

export const getDraftMessage = (id: string, kind: 'follow_up' | 'withdrawal' = 'follow_up') =>
  request<{ kind: string; text: string; note: string }>(
    `/api/applications/${id}/draft-message?kind=${kind}`,
  );

// ───────────────────────────────────────────────────────── privacy and costs

export interface CostSummary {
  totalUsd: number;
  totalCalls: number;
  byPurpose: Array<{
    purpose: string;
    calls: number;
    inputTokens: number;
    outputTokens: number;
    usd: number;
  }>;
  byModel: Array<{ model: string; calls: number; usd: number }>;
  recent: Array<{ purpose: string; model: string; usd: number; latencyMs: number; at: string }>;
  note: string;
}

export const getCosts = () => request<CostSummary>('/api/costs');

export interface DeletePreview {
  items: Array<{ label: string; count: number }>;
  confirmationPhrase: string;
  warning: string;
}

export const getDeletePreview = () => request<DeletePreview>('/api/privacy/delete-preview');

/**
 * What a delete actually managed, including the part of it that did not.
 *
 * `failed` was missing from this type, so the one list that says which of your files are
 * still on the disk was read off the wire and dropped one line later — and Settings rendered
 * the message alone, in green. Same class of loss as `withdrawnApprovals` above: the client
 * is not the place a fact goes missing.
 */
export interface DeleteResult {
  message: string;
  deletedRows: number;
  deletedPaths: string[];
  failed: Array<{ path: string; reason: string }>;
}

export const deleteEverything = (confirm: string) =>
  request<DeleteResult>('/api/privacy/delete-all', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confirm }),
  }).then((r) => ({ ...r, failed: r.failed ?? [] }));

/**
 * Downloads a protected endpoint as a file.
 *
 * A plain `<a href="/api/...">` cannot carry the X-App-Token header, so it would come
 * back 401 and the browser would save the error body as the file. Fetching it here,
 * with the header, and handing the browser a blob is the only way a download works
 * against an authenticated route.
 */
export async function downloadFile(path: string, fallbackName: string): Promise<void> {
  const res = await fetch(path, { headers: { 'x-app-token': await appToken() } });
  if (!res.ok) {
    // As in uploadResume: a raw fetch has to clear a dead token itself.
    if (res.status === 401) clearToken();
    const body: unknown = await res.json().catch(() => null);
    const e = body as { error?: { message?: string; code?: string } } | null;
    throw new ApiError(
      e?.error?.message ?? `Download failed (${res.status})`,
      res.status,
      e?.error?.code,
    );
  }

  // The server names the file; fall back if the header is missing or unparseable.
  const disposition = res.headers.get('content-disposition') ?? '';
  const named = /filename="([^"]+)"/.exec(disposition)?.[1];

  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = named ?? fallbackName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
