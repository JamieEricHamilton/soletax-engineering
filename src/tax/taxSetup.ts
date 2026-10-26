/**
 * taxSetup.ts — the five Tax-setup questions as data (pure; no store, no UI).
 *
 * The Account → Profile "Tax setup" section asks exactly what the estimate
 * needs to be right (decided 2026-06-10/11, tracker + tax_screen_spec §6):
 *   ① nation — Scotland sets its own Income Tax bands (§K; the engine branches)
 *   ② other income — a PAYE job/pension/rental fills the bands first; without
 *     it the estimate can badly UNDERSTATE the bill (engine otherTaxableIncome)
 *   ③ student loan plan (+ postgrad) — repaid through SA (§O)
 *   ④ last-year turnover band — MTD mandation wave, so the app can say
 *     honestly WHEN quarterly updates apply (§H; MTD_MANDATION)
 *   ⑤ CIS — contractors withhold tax at source; the engine nets the per-job
 *     withheld amounts off the bill (§I + SALF303)
 *
 * The persisted answers live in src/profile/taxSetupStore.ts (Zustand + MMKV);
 * this file owns the shape, the completeness rules and the engine mapping so
 * the worked-example suite can cover them under Node (no native imports).
 */

import { MTD_MANDATION, type StudentLoanPlan, type UKNation } from './rates-2026-27';
import type { TaxProfile, YearStarterDeclared } from './selectors';
import type { UseOfHomeBand } from './useOfHome';
import { previousTaxYear } from '../lib/taxYear';

// ── The answers ──────────────────────────────────────────────────────────────

/** Q4 bands — edges chosen to match the §H qualifying-income thresholds. */
export type TurnoverBand = 'under-20k' | '20k-30k' | '30k-50k' | 'over-50k';

export interface TaxSetup {
  /** ① Where they live. Undefined = not answered yet. */
  nation?: UKNation;
  /** ② Whether any money besides the business comes in (job, pension, rent). */
  hasOtherIncome?: boolean;
  /** ②b £/year of that other income — required once hasOtherIncome is true. */
  otherTaxableIncome?: number;
  /** ③ 'none' is an ANSWER (no loan); undefined means not asked yet. */
  studentLoan?: 'none' | StudentLoanPlan;
  /** ③b Postgraduate Loan — can exist alongside a plan or on its own (§O). */
  postgradLoan?: boolean;
  /** ④ Roughly what the business brought in last tax year. */
  turnoverBand?: TurnoverBand;
  /** ④b Which tax year the band describes (e.g. '2025-26') — §H mandation
   *  thresholds are tested against SPECIFIC years, so the answer must carry
   *  the year it was about or it goes stale silently. */
  turnoverBandYear?: string;
  /** ④c The year BEFORE the band year can already have mandated them under an
   *  EARLIER §H wave (e.g. over £50k in 2024-25 → quarterly updates since
   *  April 2026) — the band answer alone can't see that, so when a wave tests
   *  that prior year we ask one binary follow-up: over its threshold or not. */
  priorYearOverThreshold?: boolean;
  /** ④d Which tax year that follow-up describes (year-keyed like ④b). */
  priorYearTaxYear?: string;
  /** ⑤ Whether contractors take tax off before paying them (CIS, §I). */
  cisSubcontractor?: boolean;

  // ── ⑥ "A few more things" — boundary detectors (coverage_matrix.md §3/§4).
  // None of these feed the estimate MATHS. Each surfaces an honest exclusion
  // note (estimateExclusions) so the estimate never hands a confident wrong
  // number for an out-of-scope situation — detect-and-flag, not detect-and-model.
  /** Income from outside the UK (SA106 / Foreign Tax Credit Relief — out of V1). */
  hasForeignIncome?: boolean;
  /** Sold property/shares/crypto/a business asset (SA108 capital gains — out of V1). */
  hasCapitalGains?: boolean;
  /** They have savings interest or dividends (§S/§T). The detector flag; the £
   *  amounts below feed the engine when it is on (each its own slice + allowances). */
  hasSavingsDividends?: boolean;
  /** ⑥b £/year savings interest (§T — middle slice, PSA + starting-rate band).
   *  Modelled only while hasSavingsDividends is true. */
  savingsIncome?: number;
  /** ⑥c £/year dividends (§S — top slice, £500 allowance). Modelled only while
   *  hasSavingsDividends is true. */
  dividendIncome?: number;
  /** They or a partner claim Child Benefit (§U HICBC). The detector flag; the
   *  children count below drives the charge when it is on. */
  claimsChildBenefit?: boolean;
  /** ⑦c How many children Child Benefit is claimed for (§U). Drives the HICBC
   *  once adjusted net income clears £60k; assumes the user is the higher earner.
   *  Modelled only while claimsChildBenefit is true. */
  childBenefitChildren?: number;
  /** VAT registered (V1 figures should be net of VAT — flagged, not handled). */
  vatRegistered?: boolean;
  /** A partnership, employees, or a second trade (outside the sole-trader scope). */
  hasOtherSituations?: boolean;
  /** Pays into a personal pension and/or Gift Aid (§V). The detector flag; the £
   *  amounts below feed the band-extension relief when it is on. */
  hasPensionContributions?: boolean;
  /** ⑦a £/year NET personal pension paid under relief at source (§V — grossed up
   *  ÷ 0.8, extends the basic-rate band, lowers ANI). Modelled only while
   *  hasPensionContributions is true. */
  pensionContributionsNet?: number;
  /** ⑦b £/year NET Gift Aid donations (§V — same relief mechanism as a pension).
   *  Modelled only while hasPensionContributions is true. */
  giftAidDonationsNet?: number;
  /** ⑥ "Other income or sales" group answered — toggled an item OR tapped its own
   *  "This doesn't apply to me" (a positive choice; absence ≠ skipped). Each group
   *  carries its own done flag + its own opt-out button — no single shared "none". */
  moneyDone?: boolean;
  /** ⑦ "Your situation" group answered — same positive-choice rule. */
  situationDone?: boolean;
  /** §E working-from-home simplified flat rate band (the hours-from-home tier).
   *  Sets the use-of-home deduction and excludes home_office receipts (the
   *  double-claim guard). Absent / 'none' = not using the flat rate. */
  useOfHomeBand?: UseOfHomeBand;

  // ── ⑨ "Before SoleTax" — the mid-year starter (NOT a counted question).
  // Most users adopt partway through a tax year; MTD quarterly updates are
  // CUMULATIVE from 6 April (§H), so without these figures the estimate AND a
  // filed update silently exclude everything pre-app. Whole pounds (like
  // otherTaxableIncome), whole miles; year-keyed like ④b so the answer can
  // never silently go stale into a new tax year.
  // COMPLIANCE (§H [VERBATIM 2026-07-09]): totals are an accuracy device, not
  // digital records — HMRC's catch-up rule wants item-level records from the
  // tax-year start and no easement sanctions lump totals. The filing flow's
  // disclosure (dark, ships with the feature UI) owns that information line.
  /** £ received for work between 6 April and starting with SoleTax. */
  yearStarterIncome?: number;
  /** £ of business costs paid in that window. UI copy excludes vehicle running
   *  costs when mileage is in use (§E: the flat rate replaces actuals). */
  yearStarterExpenses?: number;
  /** Car/van business miles driven in that window (§E cumulative 10k switch). */
  yearStarterMiles?: number;
  /** Which tax year the starter figures describe (e.g. '2026-27'). */
  yearStarterTaxYear?: string;
  /** The cutover boundary: the figures describe 6 April → this moment (the day
   *  they STARTED with SoleTax — derived from their earliest record's
   *  createdAt at answer time, NOT the day they answered, or live captures
   *  made before a late answer would wrongly eat the lump). Records whose
   *  effective date lands before it automatically replace their slice of the
   *  declared figures (the S137 remainder mechanic). */
  yearStarterCutoverMs?: number;
  /** Answered — figures entered OR "nothing before the app" (a positive choice,
   *  same rule as moneyDone/situationDone). Drives the nudge, not the count. */
  yearStarterDone?: boolean;
}

/**
 * The "Before SoleTax" DECLARED totals for ONE tax year, engine-shaped
 * (integer pence + whole miles + the cutover) — null when unanswered,
 * answered-as-nothing, or year-stale. The ONLY door between the stored answer
 * and the maths: every caller (estimate hook, MTD pack, filing, export)
 * passes this, so a stale prior-year answer can never leak into a new year's
 * figures. What COUNTS is the remainder after pre-cutover records — the
 * subtraction lives in selectEstimateInputs / buildMtdPack, which see the
 * records; a missing cutover (legacy answer) reads as 0 = no decrement.
 */
export function yearStarterForYear(setup: TaxSetup, taxYear: string): YearStarterDeclared | null {
  if (setup.yearStarterTaxYear !== taxYear) return null;
  const pounds = (v: number | undefined): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.max(0, v) : 0;
  const incomePence = Math.round(pounds(setup.yearStarterIncome) * 100);
  const expensesPence = Math.round(pounds(setup.yearStarterExpenses) * 100);
  const miles = pounds(setup.yearStarterMiles);
  if (incomePence <= 0 && expensesPence <= 0 && miles <= 0) return null;
  return { incomePence, expensesPence, miles, cutoverMs: pounds(setup.yearStarterCutoverMs) };
}

/**
 * The tax year with DECLARED Before-SoleTax business miles, or null. Feeds
 * dashboardData.estimateFlags: the engine's §E flat-rate-in-use decision counts
 * declared starter miles (selectors.ts — `miles + declaredMiles > 0`), so
 * Home's displayed figures must too, or a mid-year switcher who declared miles
 * but hasn't driven yet sees van/fuel receipts counted on Home while the
 * estimate excludes them (S143 — the exact divergence class audit High #6
 * closed, one input short).
 */
export function starterMilesTaxYear(setup: TaxSetup): string | null {
  const miles = setup.yearStarterMiles;
  if (typeof miles !== 'number' || !Number.isFinite(miles) || miles <= 0) return null;
  return setup.yearStarterTaxYear ?? null;
}

// ── Completeness (drives the Tax screen caveat + the section's progress) ─────

/** Per-question answered checks, in display order. The takings question (④)
 *  counts as answered only once the prior-year follow-up is too, when one
 *  applies — a band answer alone can hide an already-running mandation. */
export function taxSetupAnswers(setup: TaxSetup): boolean[] {
  return [
    setup.nation !== undefined,
    setup.hasOtherIncome !== undefined &&
      (!setup.hasOtherIncome || setup.otherTaxableIncome !== undefined),
    setup.studentLoan !== undefined,
    setup.turnoverBand !== undefined && priorYearAnswerSettled(setup),
    setup.cisSubcontractor !== undefined,
    setup.moneyDone === true,
    setup.situationDone === true,
    // Working-from-home flat rate: answered once a band is chosen, including
    // 'none' (= doesn't work from home / under 25 hrs). The screener sets it on
    // commit, so onboarding always lands this answered.
    setup.useOfHomeBand !== undefined,
  ];
}

/** True when no prior-year follow-up applies, or it's answered for the RIGHT
 *  year (an answer about a different year is stale and doesn't count). */
function priorYearAnswerSettled(setup: TaxSetup): boolean {
  if (!setup.turnoverBandYear) return true; // legacy guard — band UI always sets it
  const prior = previousTaxYear(setup.turnoverBandYear);
  if (!mtdWaveForYear(prior)) return true;
  return setup.priorYearOverThreshold !== undefined && setup.priorYearTaxYear === prior;
}

export function taxSetupAnsweredCount(setup: TaxSetup): number {
  return taxSetupAnswers(setup).filter(Boolean).length;
}

export const TAX_SETUP_QUESTION_COUNT = 8;

/** All answered — clears the Tax screen caveat and the export note. */
export function isTaxSetupComplete(setup: TaxSetup): boolean {
  return taxSetupAnsweredCount(setup) === TAX_SETUP_QUESTION_COUNT;
}

// ── Engine mapping ───────────────────────────────────────────────────────────

/**
 * The answers as the engine's TaxProfile. Unanswered questions map to
 * undefined so the engine falls back to its documented defaults (rUK,
 * business-only income) — the caveat label covers the gap until then.
 *
 * The §S/§T/§U/§V figures (savings, dividends, Child Benefit children, pension,
 * Gift Aid) are gated on their detector flag: an amount only reaches the engine
 * while its flag is on, so untoggling a group stops applying it without losing
 * the typed value. An on flag with no amount maps to undefined → the engine's 0.
 */
export function toTaxProfile(setup: TaxSetup): TaxProfile {
  return {
    nation: setup.nation,
    otherTaxableIncome:
      setup.hasOtherIncome === undefined
        ? undefined
        : setup.hasOtherIncome
          ? setup.otherTaxableIncome
          : 0,
    studentLoanPlan:
      setup.studentLoan && setup.studentLoan !== 'none' ? setup.studentLoan : undefined,
    postgradLoan: setup.postgradLoan,
    savingsIncome: setup.hasSavingsDividends ? setup.savingsIncome : undefined,
    dividendIncome: setup.hasSavingsDividends ? setup.dividendIncome : undefined,
    childBenefitChildren: setup.claimsChildBenefit ? setup.childBenefitChildren : undefined,
    pensionContributionsNet: setup.hasPensionContributions ? setup.pensionContributionsNet : undefined,
    giftAidDonationsNet: setup.hasPensionContributions ? setup.giftAidDonationsNet : undefined,
  };
}

// ── ⑥ Estimate exclusions — the detect-and-flag boundary ─────────────────────

/**
 * One honest "what your estimate leaves out" note. Each maps to a
 * coverage_matrix.md §3 boundary. Surfaced on the Tax screen so an out-of-scope
 * situation is DISCLOSED, never silently wrong — the failure mode that kills
 * trust is a confident wrong number, not an admitted exclusion.
 */
export interface EstimateExclusion {
  key: string;
  title: string;
  note: string;
}

/**
 * The active notes for a setup, in display order. Pure — the Tax screen renders
 * these; it computes nothing. Two kinds:
 *  • genuinely out-of-scope items (foreign, capital gains, VAT, other situations)
 *    → an honest "this isn't in your estimate" line.
 *  • now-modelled items (§S/§T savings & dividends, §V pension/Gift Aid, §U HICBC)
 *    → only a note when there's something to say: a NUDGE to add the £ figure when
 *    the flag is on but no amount is entered (so it's silently absent otherwise),
 *    or, for Child Benefit, the higher-earner ASSUMPTION the charge is built on.
 *    Once the amount is in, the figure lives in the estimate's breakdown, not here.
 * No figure is computed here — the maths stays in the sourced + harness-tested
 * engine; these are disclosures and prompts only.
 */
export function estimateExclusions(setup: TaxSetup): EstimateExclusion[] {
  const out: EstimateExclusion[] = [];
  if (setup.hasForeignIncome)
    out.push({
      key: 'foreign',
      title: 'Money from outside the UK',
      note: 'Your estimate leaves this out. Income from abroad needs an accountant.',
    });
  if (setup.hasCapitalGains)
    out.push({
      key: 'capital-gains',
      title: 'Selling things of value',
      note: 'Selling property, shares or crypto is taxed on its own. It’s not in this estimate.',
    });
  // §S/§T — modelled once the amounts are in; nudge while they're missing.
  if (setup.hasSavingsDividends && !((setup.savingsIncome ?? 0) > 0 || (setup.dividendIncome ?? 0) > 0))
    out.push({
      key: 'savings-dividends',
      title: 'Savings and dividends',
      note: 'Add how much in Account → Tax setup and your estimate will work out the tax.',
    });
  // §U HICBC — disclose the higher-earner assumption once it's being charged;
  // nudge for the children count while it's missing.
  if (setup.claimsChildBenefit)
    out.push(
      (setup.childBenefitChildren ?? 0) > 0
        ? {
            key: 'child-benefit',
            title: 'Child Benefit',
            note: 'We’ve worked out the charge assuming you’re the higher earner. It applies to whoever earns over £60,000.',
          }
        : {
            key: 'child-benefit',
            title: 'Child Benefit',
            note: 'Add how many children you claim for in Account → Tax setup so we can check the charge.',
          },
    );
  if (setup.vatRegistered)
    out.push({
      key: 'vat',
      title: 'VAT',
      note: 'Keep your figures without VAT. Your estimate doesn’t handle VAT yet.',
    });
  // §V — modelled once the amounts are in; nudge while they're missing.
  if (setup.hasPensionContributions && !((setup.pensionContributionsNet ?? 0) > 0 || (setup.giftAidDonationsNet ?? 0) > 0))
    out.push({
      key: 'pension',
      title: 'Pension and Gift Aid',
      note: 'Add what you pay in Account → Tax setup. It can lower your bill.',
    });
  if (setup.hasOtherSituations)
    out.push({
      key: 'other-situations',
      title: 'A partnership, staff or a second business',
      note: 'These need handling your estimate doesn’t cover. Worth checking with an accountant.',
    });
  return out;
}

// ── MTD mandation (§H) ───────────────────────────────────────────────────────

export type MtdStart =
  /** The band's floor clears a threshold tested against the band's own year. */
  | { kind: 'mandated'; startsApril: number }
  /** The floor clears a threshold tested against a LATER year — likely, if
   *  income holds up. Honest copy says "likely", never a promise. */
  | { kind: 'likely'; startsApril: number }
  /** Below every threshold the band's year can answer — not required yet. */
  | { kind: 'not-yet' }
  /** The band describes a year no §H wave tests (stale answer) — say nothing. */
  | { kind: 'unknown' };

const BAND_FLOOR: Record<TurnoverBand, number> = {
  'under-20k': 0,
  '20k-30k': 20_000,
  '30k-50k': 30_000,
  'over-50k': 50_000,
};

/**
 * When MTD quarterly updates start for someone whose qualifying income in
 * `bandTaxYear` fell in `band` (§H: thresholds are tested per SPECIFIC tax
 * year). A band only PROVES mandation for waves testing its own year; for
 * waves testing later years it can only say "likely". Bands sit exactly on
 * the thresholds so a floor ≥ threshold is a true "over".
 */
export function mtdStartForTurnoverBand(band: TurnoverBand, bandTaxYear: string): MtdStart {
  const floor = BAND_FLOOR[band];

  // The wave the band's own year proves (band edges sit on the thresholds, so
  // floor ≥ threshold reads the whole band as over it — "roughly" answers).
  for (const wave of MTD_MANDATION) {
    if (wave.testedTaxYear === bandTaxYear && floor >= wave.threshold) {
      return { kind: 'mandated', startsApril: wave.startsApril };
    }
  }

  // No proof from its own year — a wave testing a LATER year can only make it
  // "likely" (their income then hasn't happened yet). Year strings compare
  // lexicographically ('2026-27' > '2025-26').
  const knowsOwnYear = MTD_MANDATION.some((w) => w.testedTaxYear === bandTaxYear);
  for (const wave of MTD_MANDATION) {
    if (wave.testedTaxYear > bandTaxYear && floor >= wave.threshold) {
      return { kind: 'likely', startsApril: wave.startsApril };
    }
  }

  return knowsOwnYear ? { kind: 'not-yet' } : { kind: 'unknown' };
}

/** The §H wave whose qualifying-income test is the given tax year, if any. */
export function mtdWaveForYear(taxYear: string) {
  return MTD_MANDATION.find((w) => w.testedTaxYear === taxYear);
}

/**
 * The prior-year follow-up as an MtdStart: "over" the threshold the §H wave
 * tests for that year is a PROVEN mandation from that wave's April; "under"
 * proves nothing on its own (the band answer carries the rest).
 */
export function mtdStartForPriorYear(over: boolean, priorTaxYear: string): MtdStart {
  const wave = mtdWaveForYear(priorTaxYear);
  if (!wave) return { kind: 'unknown' };
  return over ? { kind: 'mandated', startsApril: wave.startsApril } : { kind: 'not-yet' };
}

/** Strongest answer wins (mandated > likely > not-yet > unknown); on a tie,
 *  the EARLIER April — understating an active obligation is the failure mode
 *  this exists to prevent. */
export function combineMtdStarts(a: MtdStart, b: MtdStart): MtdStart {
  const rank = { mandated: 0, likely: 1, 'not-yet': 2, unknown: 3 } as const;
  if (rank[a.kind] !== rank[b.kind]) return rank[a.kind] < rank[b.kind] ? a : b;
  if ('startsApril' in a && 'startsApril' in b) {
    return a.startsApril <= b.startsApril ? a : b;
  }
  return a;
}

/**
 * The one §H answer for a setup: the band's wave combined with the prior-year
 * follow-up (when answered for the right year). Null until the band exists.
 * Both the Tax screen's quarterly line and the setup card's result line read
 * THIS — never the band alone, which can miss an already-running mandation.
 */
export function mtdStartForSetup(setup: TaxSetup): MtdStart | null {
  if (!setup.turnoverBand || !setup.turnoverBandYear) return null;
  const fromBand = mtdStartForTurnoverBand(setup.turnoverBand, setup.turnoverBandYear);
  const prior = previousTaxYear(setup.turnoverBandYear);
  if (setup.priorYearOverThreshold !== undefined && setup.priorYearTaxYear === prior) {
    return combineMtdStarts(fromBand, mtdStartForPriorYear(setup.priorYearOverThreshold, prior));
  }
  return fromBand;
}
