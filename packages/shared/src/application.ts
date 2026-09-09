import { z } from 'zod';

export const ApplicationStatus = z.enum([
  'draft',
  'answers_ready',
  'filled',
  'awaiting_submit',
  'submitted',
  'acknowledged',
  'interview',
  'offer',
  'rejected',
  'withdrawn',
  'ghosted',
]);

/**
 * Semantic meaning of a form field. `REDLINE` fields are NEVER auto-filled — see
 * docs/07-form-automation.md § Redlines.
 */
export const FieldSemantic = z.enum([
  'first_name',
  'last_name',
  'full_name',
  'email',
  'phone',
  'address_line1',
  'city',
  'region',
  'postal',
  'country',
  'linkedin',
  'github',
  'portfolio',
  'website',
  'school',
  'degree',
  'major',
  'gpa',
  'graduation_date',
  'enrollment_status',
  'resume_upload',
  'cover_letter_upload',
  'transcript_upload',
  'work_auth',
  'sponsorship_needed',
  'start_date',
  'end_date',
  'hours_available',
  'essay',
  'referral_source',
  'salary_expectation',
  'REDLINE',
  'unknown',
]);

export const RedlineCategory = z.enum([
  'government_id',
  'financial',
  'credential',
  'attestation',
  'consent',
  'eeo_demographic',
  'ai_disclosure',
]);

export const FormField = z.object({
  id: z.string(),
  locator: z.string(),
  label: z.string(),
  /**
   * The heading of the block this control sits inside — a fieldset legend, the caption of a
   * history table, the heading of one repeated row — when the scanner can find one.
   *
   * Populated by `formMap.ts` from the nearest legend, caption, aria-label or heading, and
   * read by `classify.ts`. Still optional: the scanner cannot always find one, and anything
   * reading it must treat undefined as "no container known", never as "this field is at the
   * top level of the form".
   *
   * It exists because a label on its own cannot tell two identical questions apart. The
   * "Start Date" column of a work-history row and the "Start date" this internship asks about
   * are the same six characters, and the label was all the classifier got — so a row of the
   * applicant's employment history received the date they become available, at 0.92
   * confidence, verified by read-back and shown in the review as a field that went right.
   * That is a false statement about their work history in a form submitted in their name. The
   * rules can only disqualify the phrasings that name the container out loud ("Previous
   * employer start date"); a bare column heading has to know what it is a column of.
   *
   * The container may only ever DISQUALIFY a semantic, never confer one — a heading is a
   * single string shared by every control in the block, so letting it satisfy a positive rule
   * would classify everything under "Previous Employment" as employment whatever its own
   * label said. See the rule loop in classify.ts.
   *
   * What it does NOT yet fix: repeated rows of one table share a section and so are still
   * indistinguishable from each other, which is why every row of a repeated table receives
   * the same profile value.
   */
  section: z.string().optional(),
  control: z.enum([
    'text',
    'textarea',
    'select',
    'multiselect',
    'radio',
    'checkbox',
    'file',
    'date',
    'combobox',
    'richtext',
  ]),
  required: z.boolean(),
  maxLength: z.number().int().positive().optional(),
  /**
   * The choices, for a control that has them.
   *
   * `locator` is set only for a radio group, where the options are separate elements
   * rather than children of one control — the group's own locator matches all of them,
   * so choosing an option means addressing that option's own input.
   */
  options: z
    .array(z.object({ value: z.string(), label: z.string(), locator: z.string().optional() }))
    .optional(),
  semantic: FieldSemantic,
  redlineCategory: RedlineCategory.optional(),
  confidence: z.number().min(0).max(1),
  /**
   * Not built: nothing sets this, and nothing reads it. A wizard is walked by re-reading the
   * page after each advance, so a map only ever describes the step the browser is currently
   * on and its fields have no other step to name. The field is kept because a scanner that
   * read a whole wizard in one pass is where a step number would come from.
   */
  step: z.number().int().optional(),
  frame: z.string().optional(),
});

export const ClaimVerdict = z.enum(['supported', 'inferred', 'unsupported', 'overstated']);

export const AnswerFlag = z.object({
  type: z.enum(['unsupported', 'overstated', 'style_drift', 'ai_tell']),
  span: z.object({ start: z.number().int(), end: z.number().int() }),
  note: z.string(),
});

export const AnswerEvidence = z.object({
  claim: z.string(),
  verdict: ClaimVerdict,
  profileRef: z.string().nullable(),
  quote: z.string().nullable(),
});

export const ApplicationAnswer = z.object({
  id: z.string(),
  applicationId: z.string(),
  questionText: z.string(),
  fieldKey: z.string(),
  answerType: z.enum(['short_text', 'long_text', 'select', 'multi', 'boolean', 'file', 'date']),
  draftText: z.string(),
  finalText: z.string(),
  /** draft → final. Surfaced in the UI; zero triggers a re-read nudge at gate G3. */
  editDistance: z.number().int().nonnegative(),
  evidence: z.array(AnswerEvidence).default([]),
  flags: z.array(AnswerFlag).default([]),
  /** Null blocks form filling. Set only by an explicit user action (gate G3). */
  approvedAt: z.string().datetime().nullable(),
});

export const Application = z.object({
  id: z.string(),
  matchId: z.string(),
  status: ApplicationStatus,
  applyUrl: z.string().url(),
  atsVendor: z.string(),
  /**
   * Not built: nothing writes this. No route accepts a per-application resume choice, so it
   * is always null and every fill falls back to whichever resume is marked primary. The
   * field is kept because choosing a different resume for one application — a research lab
   * that should see the research CV — is what it would record.
   */
  resumeDocumentId: z.string().nullable(),
  /**
   * Gate G4. Written only where the user themselves says it was submitted: POST
   * /api/applications/:id/mark-submitted, and a user status change to 'submitted' via
   * POST /api/applications/:id/status. Never by the fill run.
   *
   * This used to say "written ONLY by mark-submitted", which was one endpoint short. The
   * count is not what makes G4 hold — a user action is — but this is the file both apps
   * import the type from, so it is the description someone auditing what can stamp this
   * column reads first, and it sent them to look at one route out of two.
   */
  submittedAt: z.string().datetime().nullable(),
  deadlineAt: z.string().datetime().nullable(),
  screenshotPath: z.string().nullable(),
  /** Redlined and unclassifiable fields the user must handle themselves. */
  skippedFields: z
    .array(
      z.object({
        label: z.string(),
        reason: z.enum(['redline', 'unclassified', 'no_match', 'failed']),
        category: RedlineCategory.optional(),
      }),
    )
    .default([]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type ApplicationStatus = z.infer<typeof ApplicationStatus>;
export type FieldSemantic = z.infer<typeof FieldSemantic>;
export type RedlineCategory = z.infer<typeof RedlineCategory>;
export type FormField = z.infer<typeof FormField>;
export type ClaimVerdict = z.infer<typeof ClaimVerdict>;
export type AnswerFlag = z.infer<typeof AnswerFlag>;
export type AnswerEvidence = z.infer<typeof AnswerEvidence>;
export type ApplicationAnswer = z.infer<typeof ApplicationAnswer>;
export type Application = z.infer<typeof Application>;
