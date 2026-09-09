import { z } from 'zod';

/**
 * Search filters — see docs/05-matching.md § Filters.
 *
 * MOST OF THIS FILE IS NOT WIRED UP YET, AND THAT IS THE FIRST THING TO KNOW ABOUT IT.
 *
 * `queryPlanner.ts` is the only consumer, and it reads seven leaves: `term.seasons`,
 * `term.years`, `positionTypes`, `location.cities`, `role.roleFamilies`,
 * `role.titleIncludes` and `company.onlyCompanies`. Everything else — the whole of
 * CompensationFilter, EligibilityFilter, ApplicationFilter, ArrangementFilter, ViewFilter
 * and ProgramFlag, and the remaining Term, Location, Role and Company leaves — parses,
 * validates, and is then dropped on the floor. `POST /api/discovery/plan` accepts a fully
 * populated body and returns the same plan it would have returned for `{}`, without a note
 * saying so. Nothing in the web app sends one, so no user is affected today; an API caller
 * is, silently, and a contributor reading this header as a specification would be.
 *
 * Three rules govern the parts that ARE live:
 *
 * 1. Every filter is OPTIONAL — nobody has to state a preference to get results. What an
 *    omitted filter falls back to is mostly permissive, but not uniformly, and the
 *    exceptions are deliberate: the term block (summer, and the upcoming cycle read from the
 *    clock — see `upcomingCycleYear`) and the internship-and-co-op position types narrow to
 *    the cycle a user is actually applying for. Nothing else here
 *    narrows anything by default, because a tool that silently excludes opportunities is
 *    worse than one that shows too many. This rule used to cite `minOverlapWeeks` and the
 *    US `location.countries` default as narrowing too, and neither one narrows anything:
 *    what actually decides overlap is `MIN_OVERLAP_WEEKS`, a constant in eligibility.ts
 *    that no filter can move, and `location.countries` has no reader at all. A default
 *    described as restrictive that is in fact inert is the more dangerous kind of wrong —
 *    it invites someone to relax it and conclude the search is broader than it is.
 * 2. Filters that mirror a hard eligibility rule (age, graduation window, work
 *    authorization) are *preferences about what to show*, not the rules themselves.
 *    Eligibility is still computed deterministically in matching/eligibility.ts.
 * 3. Anything unstated in a posting is NEVER treated as disqualifying. A posting that
 *    doesn't mention pay is not "unpaid"; it's unknown, and `include*Undisclosed`
 *    defaults to true throughout.
 */

// ---------------------------------------------------------------- term & timing

export const Season = z.enum(['summer', 'fall', 'winter', 'spring', 'year_round', 'flexible']);
export type SeasonName = z.infer<typeof Season>;

/** June. The month the summer term begins, as the UTC month index a Date reports. */
const SUMMER_START_MONTH = 5;

/**
 * The month each season's term begins. A total Record, so a season added to the enum is a
 * compile error here rather than one that silently inherits the summer calendar.
 *
 * `year_round` and `flexible` name no window, so there is no month at which one of them has
 * started and nothing to roll over.
 */
const SEASON_START_MONTH: Record<SeasonName, number | null> = {
  summer: SUMMER_START_MONTH,
  fall: 8, // September
  winter: 11, // December
  spring: 0, // January
  year_round: null,
  flexible: null,
};

/**
 * The cycle a search means when nobody named a year: the next one still worth applying to.
 *
 * The year used to be written down — `default([2027])` — so every install searched summer
 * 2027 for ever. On 1 July 2027 that is a season that has already started and closed its
 * applications, and the student got an empty queue with nothing on screen saying why. docs/05
 * said "nothing in the system hardcodes summer or 2027" while this line did.
 *
 * The cycle turns over at the TERM'S START rather than when applications typically close
 * (February for most large programs), because the two mistakes are not symmetric: rolling
 * over early searches a cycle nobody has posted for yet and finds nothing, while rolling over
 * at the start of the term keeps the late and rolling postings — exactly the ones a student
 * searching in April still has a shot at — inside the search.
 *
 * The clock is a parameter because a default that drifts with the calendar cannot be tested
 * by a suite that pins dates, and an untestable date rule is how 2027 came to be a constant.
 */
export function upcomingCycleYear(season: SeasonName = 'summer', now: Date = new Date()): number {
  const startMonth = SEASON_START_MONTH[season] ?? SUMMER_START_MONTH;
  return now.getUTCMonth() >= startMonth ? now.getUTCFullYear() + 1 : now.getUTCFullYear();
}

export const TermFilter = z.object({
  /** Empty = any season. */
  seasons: z.array(Season).default(['summer']),
  /**
   * Empty = any year. The default is the upcoming cycle, READ FROM THE CLOCK.
   *
   * A thunk rather than a value: a zod default written as a literal is evaluated once when
   * the module loads, so even a computed one would freeze at whatever the year was when the
   * process started. This is parsed per request.
   */
  years: z.array(z.number().int()).default(() => [upcomingCycleYear()]),
  durationWeeks: z
    .object({ min: z.number().int().optional(), max: z.number().int().optional() })
    .default({}),
  startsBetween: z.object({ from: z.string().optional(), to: z.string().optional() }).default({}),
  endsBetween: z.object({ from: z.string().optional(), to: z.string().optional() }).default({}),
  /** Co-ops and rotational programs often span two terms. */
  allowMultiTerm: z.boolean().default(true),
  /**
   * Minimum weeks a posting's term must overlap your availability.
   *
   * Not wired up: nothing reads it. The number that actually decides the `term_overlap`
   * rule is `MIN_OVERLAP_WEEKS` in matching/eligibility.ts, and setting this one to 20 has
   * exactly the same effect as leaving it at 6 — none.
   */
  minOverlapWeeks: z.number().int().nonnegative().default(6),
  includeUndatedPostings: z.boolean().default(true),
});

// ---------------------------------------------------------------- what kind of position

export const PositionType = z.enum([
  'internship',
  'co_op',
  'fellowship',
  'apprenticeship',
  'research', // REU and lab positions
  'new_grad',
  'part_time',
  'seasonal',
  'contract',
  'externship', // short job-shadow / micro-internship
  'trainee_program',
  'volunteer',
]);

export const ProgramFlag = z.enum([
  'diversity_program',
  'first_year_or_sophomore',
  'high_school_program',
  'returnship',
  'veteran_program',
  'rotational',
  'leadership_development',
  'phd_or_research',
  'return_offer_track',
]);

// ---------------------------------------------------------------- where and how

export const WorkArrangement = z.enum([
  'onsite',
  'hybrid',
  'remote',
  'remote_geo_restricted',
  'field_or_travel',
]);

export const ArrangementFilter = z.object({
  /** Empty = any arrangement. */
  allowed: z.array(WorkArrangement).default([]),
  hybridDaysOnsite: z
    .object({
      min: z.number().int().optional(),
      max: z.number().int().optional(),
    })
    .default({}),
  /** For remote roles that restrict which states/countries you may work from. */
  remoteEligibleIn: z.array(z.string()).default([]),
  includeUnstatedArrangement: z.boolean().default(true),
});

export const LocationFilter = z.object({
  cities: z.array(z.string()).default([]),
  regions: z.array(z.string()).default([]),
  /** Not wired up: nothing reads it, so this default excludes no posting from anywhere. */
  countries: z.array(z.string()).default(['US']),
  /** Applied from the profile's base location. Ignored for remote postings. */
  radiusKm: z.number().nonnegative().optional(),
  relocationTargets: z.array(z.string()).default([]),
  willRelocate: z.boolean().default(false),
  excludeLocations: z.array(z.string()).default([]),
});

// ---------------------------------------------------------------- money

export const PayBasis = z.enum(['hour', 'week', 'month', 'year', 'total']);

export const CompensationFilter = z.object({
  paidOnly: z.boolean().default(false),
  academicCreditAcceptable: z.boolean().default(true),
  minAmount: z.number().nonnegative().optional(),
  minAmountBasis: PayBasis.default('hour'),
  currency: z.string().default('USD'),
  /** A posting that doesn't state pay is unknown, not unpaid. Keep this true. */
  includeUndisclosed: z.boolean().default(true),
  requireHousingStipend: z.boolean().default(false),
  requireRelocationAssistance: z.boolean().default(false),
});

// ---------------------------------------------------------------- who can apply

export const EligibilityFilter = z.object({
  educationLevels: z.array(z.string()).default([]),
  graduationBetween: z
    .object({ from: z.string().optional(), to: z.string().optional() })
    .default({}),
  enrollmentRequired: z.enum(['any', 'required', 'not_required']).default('any'),
  /** Hide postings whose minimum age exceeds yours. */
  excludeAboveMyAge: z.boolean().default(true),
  /** Hide postings that won't sponsor when you need sponsorship. */
  excludeIfSponsorshipUnavailable: z.boolean().default(true),
  excludeCitizenshipRequired: z.boolean().default(false),
  excludeClearanceRequired: z.boolean().default(false),
  /** Hide postings whose minimum GPA is above yours. */
  excludeAboveMyGpa: z.boolean().default(false),
  /** Show postings whose requirements couldn't be parsed. Keep true — see rule 3. */
  includeUnknownEligibility: z.boolean().default(true),
});

// ---------------------------------------------------------------- who you'd work for

export const CompanySize = z.enum(['startup', 'small', 'mid', 'large', 'enterprise']);
export const CompanySector = z.enum([
  'private',
  'public_company',
  'nonprofit',
  'government',
  'academic',
  'startup',
]);

export const CompanyFilter = z.object({
  sizes: z.array(CompanySize).default([]),
  sectors: z.array(CompanySector).default([]),
  industries: z.array(z.string()).default([]),
  /** If non-empty, ONLY these companies are searched. */
  onlyCompanies: z.array(z.string()).default([]),
  excludeCompanies: z.array(z.string()).default([]),
});

// ---------------------------------------------------------------- what you'd do

export const RoleFilter = z.object({
  roleFamilies: z.array(z.string()).default([]),
  titleIncludes: z.array(z.string()).default([]),
  titleExcludes: z.array(z.string()).default([]),
  descriptionIncludes: z.array(z.string()).default([]),
  descriptionExcludes: z.array(z.string()).default([]),
  requiredSkills: z.array(z.string()).default([]),
  /** Hide postings demanding more professional years than you have, plus tolerance. */
  excludeOverqualifiedRequirements: z.boolean().default(true),
  experienceToleranceYears: z.number().nonnegative().default(1),
});

// ---------------------------------------------------------------- cost of applying

export const ApplicationFilter = z.object({
  maxSteps: z.number().int().positive().optional(),
  maxEssays: z.number().int().nonnegative().optional(),
  maxEstimatedMinutes: z.number().int().positive().optional(),
  excludeRequiresAccount: z.boolean().default(false),
  atsVendorsAllowed: z.array(z.string()).default([]),
  atsVendorsExcluded: z.array(z.string()).default([]),
  deadlineWithinDays: z.number().int().positive().optional(),
  postedWithinDays: z.number().int().positive().optional(),
  excludeExpired: z.boolean().default(true),
  excludeRequiresCoverLetter: z.boolean().default(false),
  excludeRequiresTranscript: z.boolean().default(false),
  excludeRequiresPortfolio: z.boolean().default(false),
  excludeRequiresReferences: z.boolean().default(false),
  excludeRequiresVideoInterview: z.boolean().default(false),
});

// ---------------------------------------------------------------- presentation

export const SortKey = z.enum([
  'fit',
  'deadline',
  'posted',
  'effort',
  'compensation',
  'company',
  'title',
]);

export const ViewFilter = z.object({
  /** `all` includes ineligible postings in the collapsed, inspectable drawer. */
  eligibility: z.enum(['eligible', 'eligible_and_unknown', 'all']).default('eligible_and_unknown'),
  minScore: z.number().min(0).max(100).default(0),
  sortBy: SortKey.default('fit'),
  sortDir: z.enum(['asc', 'desc']).default('desc'),
  hideDecided: z.boolean().default(true),
});

// ---------------------------------------------------------------- the whole thing

export const SearchFilters = z.object({
  term: TermFilter.prefault({}),
  positionTypes: z.array(PositionType).default(['internship', 'co_op']),
  programFlags: z.array(ProgramFlag).default([]),
  arrangement: ArrangementFilter.prefault({}),
  location: LocationFilter.prefault({}),
  compensation: CompensationFilter.prefault({}),
  eligibility: EligibilityFilter.prefault({}),
  company: CompanyFilter.prefault({}),
  role: RoleFilter.prefault({}),
  application: ApplicationFilter.prefault({}),
  view: ViewFilter.prefault({}),
});

export const FilterPreset = z.object({
  id: z.string(),
  name: z.string().min(1),
  description: z.string().optional(),
  filters: SearchFilters,
  isDefault: z.boolean().default(false),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/**
 * Parsing `{}` yields every default. Summer 2027 internships and co-ops, US, any
 * arrangement, any pay, undisclosed-and-unknown included.
 */
export const DEFAULT_FILTERS: SearchFilters = SearchFilters.parse({});

/**
 * The starting set of named filters, meant to be editable and deletable like any other.
 *
 * Not wired up: nothing seeds `filter_preset` from this list, no route serves presets, and
 * the web app has no preset picker, so no user has ever seen one of these. The shared tests
 * are the only reader. Treat it as the intended starting set, not as shipped behaviour.
 */
export const STARTER_PRESETS: ReadonlyArray<{ name: string; description: string; patch: unknown }> =
  [
    {
      name: 'Summer 2027',
      description: 'The default cycle — internships and co-ops, any arrangement.',
      patch: {},
    },
    {
      name: 'Remote only',
      description: 'Anything you can do without moving.',
      patch: { arrangement: { allowed: ['remote', 'remote_geo_restricted'] } },
    },
    {
      name: 'Co-ops (6+ months)',
      description: 'Longer placements, often alternating with school terms.',
      patch: {
        positionTypes: ['co_op'],
        term: { seasons: [], years: [], durationWeeks: { min: 24 }, allowMultiTerm: true },
      },
    },
    {
      name: 'Paid only',
      description: 'Excludes unpaid and credit-only postings, keeps undisclosed pay.',
      patch: { compensation: { paidOnly: true, academicCreditAcceptable: false } },
    },
    {
      name: 'Quick applications',
      description: 'One-page forms, no account, no essays — for high-volume days.',
      patch: { application: { maxEssays: 0, maxSteps: 1, excludeRequiresAccount: true } },
    },
    {
      name: 'Closing soon',
      description: 'Anything with a deadline inside two weeks, deadline-sorted.',
      patch: {
        application: { deadlineWithinDays: 14 },
        view: { sortBy: 'deadline', sortDir: 'asc' },
      },
    },
    {
      name: 'Government & research',
      description: 'Federal, national labs, and academic research programs.',
      patch: {
        positionTypes: ['internship', 'fellowship', 'research'],
        company: { sectors: ['government', 'academic', 'nonprofit'] },
      },
    },
    {
      name: 'Cast a wide net',
      description: 'Every position type, every season, every year. Maximum recall.',
      patch: {
        positionTypes: [
          'internship',
          'co_op',
          'fellowship',
          'apprenticeship',
          'research',
          'new_grad',
          'part_time',
          'seasonal',
          'contract',
          'externship',
          'trainee_program',
          'volunteer',
        ],
        term: { seasons: [], years: [] },
        view: { eligibility: 'all' },
      },
    },
  ];

export type Season = z.infer<typeof Season>;
export type PositionType = z.infer<typeof PositionType>;
export type ProgramFlag = z.infer<typeof ProgramFlag>;
export type WorkArrangement = z.infer<typeof WorkArrangement>;
export type CompanySize = z.infer<typeof CompanySize>;
export type CompanySector = z.infer<typeof CompanySector>;
export type SortKey = z.infer<typeof SortKey>;
export type SearchFilters = z.infer<typeof SearchFilters>;
export type FilterPreset = z.infer<typeof FilterPreset>;
