/**
 * selectors.ts — the estimate-input selectors: the wiring between the data
 * stores (jobs, receipts, trips) and the pure engine. THE RISKY CODE: the
 * engine's arithmetic is CI-protected by worked examples, so a wrong estimate
 * can only come from feeding it the wrong inputs. Every rule here is therefore
 * explicit, pure (no store imports, no clock reads), and covered by its own
 * worked-example suite (scripts/test-tax-selectors.ts, part of `npm run
 * test:tax`).
 *
 * THE RULES (tax_screen_spec.md §6, locked):
 * - Income (§F cash basis): PAID jobs only, approved only, by the tax year the
 *   money was RECEIVED (paidAt) — never the invoice date, never the stored
 *   taxYear field (it is keyed to the job date, which is the wrong year for a
 *   cross-year payment). Quotes are NEVER turnover; void is cancelled.
 * - Deductions: APPROVED receipts only; category deductibility derives from
 *   sa103f-2026.ts (the single source — never hardcode category names);
 *   `deductible === false` (the user's compliance answer) excludes; the
 *   deductible figure is the split businessAmount (SA103F private-use
 *   apportionment), never the face amount; unconverted foreign receipts are
 *   excluded until they have a GBP amount.
 * - §E double-claim (LOCKED): when the mileage flat rate is in use for the
 *   year, receipts in a `mileageConflict` category (van_vehicle) are EXCLUDED
 *   from deductions — the flat rate replaces vehicle running costs. This is a
 *   compliance rule, not an optimisation: it applies even when actual costs
 *   would be larger. Parking/tolls/public transport stay claimable on top.
 * - Units: stores hold integer PENCE; the engine takes POUNDS. Sums are exact
 *   integer pence throughout; the pounds conversion happens once, at the end.
 *
 * Everything that is excluded (and why) is counted in `diagnostics`, so the
 * Tax screen can explain itself ("2 receipts awaiting review aren't counted
 * yet") and a silent data problem becomes a visible number instead of a
 * plausible-looking wrong estimate.
 */

import { parseISO } from 'date-fns';

import type { Job, OtherIncome } from '../income/types';
import { businessAmount } from '../receipts/allocations';
import { SA103F_MAP } from '../receipts/sa103f-2026';
import type { Receipt } from '../receipts/types';
import { getTaxYear, monthsUntil, saDeadline } from '../lib/taxYear';
import { taxReliefForDeduction, type TaxEstimate, type TaxEstimateInput } from './engine';
import { mileageAllowanceFromTotals } from './mileage';
import { homeFlatRateAnnual, isHomeFlatRateInUse, type UseOfHomeBand } from './useOfHome';
import type { StudentLoanPlan, UKNation } from './rates-2026-27';

// ── Receipt classification ───────────────────────────────────────────────────

export type ReceiptExclusionReason =
  | 'not-approved'                // still in review — amount unconfirmed
  | 'category-not-deductible'     // sa103f deductible:false (client_entertainment, not_business)
  | 'user-marked-not-deductible'  // the compliance-card answer (deductible === false)
  | 'mileage-conflict'            // §E: flat rate in use replaces vehicle running costs
  | 'home-conflict'               // §E: working-from-home flat rate replaces actual home costs
  | 'unconverted-foreign'         // foreign currency, no GBP amount yet
  | 'invalid-amount'              // NaN / negative — corrupt, never summed
  | 'zero-amount';                // contributes nothing; kept out of "counted"

export type ReceiptEstimateClassification =
  | { counted: true; pence: number; clampedSplit: boolean }
  | { counted: false; reason: ReceiptExclusionReason };

/**
 * Whether (and at what value) one receipt counts toward the estimate's
 * deductions. Pure per-receipt rule — year filtering is the caller's job.
 * Also the canonical predicate for any "claimed/deductible total" figure
 * (the Receipts hero uses it), so the rule can never drift between surfaces.
 */
export function classifyReceiptForEstimate(
  r: Receipt,
  opts: { flatRateInUse: boolean; homeFlatRateInUse?: boolean },
): ReceiptEstimateClassification {
  if (r.reviewStatus !== 'approved') return { counted: false, reason: 'not-approved' };

  // Category deductibility from the single source of truth (sa103f-2026.ts).
  // An unknown category (data from a future version) is treated as NOT
  // deductible — conservative, and visible in the diagnostics.
  const meta = SA103F_MAP.get(r.category);
  if (!meta || !meta.deductible) return { counted: false, reason: 'category-not-deductible' };

  // The user's own compliance answer always wins (undefined = category default).
  if (r.deductible === false) return { counted: false, reason: 'user-marked-not-deductible' };

  // §E double-claim rule: never sum vehicle running costs alongside the flat rate.
  if (opts.flatRateInUse && meta.mileageConflict) {
    return { counted: false, reason: 'mileage-conflict' };
  }

  // §E double-claim rule: never sum actual home costs alongside the home flat rate.
  if (opts.homeFlatRateInUse && meta.homeConflict) {
    return { counted: false, reason: 'home-conflict' };
  }

  if (typeof r.amount !== 'number' || !Number.isFinite(r.amount) || r.amount < 0) {
    return { counted: false, reason: 'invalid-amount' };
  }

  // A foreign receipt is only countable once its GBP amount exists (the amount
  // gate enforces this for new saves; historic/queued data may still lack it).
  const isForeign = !!r.currency && r.currency !== 'GBP';
  if (isForeign && r.amount <= 0) return { counted: false, reason: 'unconverted-foreign' };

  if (r.amount === 0) return { counted: false, reason: 'zero-amount' };

  // The allowable figure is the business portion (face amount minus the
  // personal split). businessAmount() does not clamp — corrupt data
  // (personalAmount > amount) would go NEGATIVE and silently SUBTRACT from
  // the year's deductions, so clamp to 0 and flag it.
  const business = businessAmount(r);
  const clampedSplit = business < 0;
  const pence = Math.round(Math.max(0, business));
  return { counted: true, pence, clampedSplit };
}

// ── Date-string parse cache ──────────────────────────────────────────────────
// parseISO dominated the per-write recompute walks at import scale (S142: a
// classify tap re-ran every dashboard/estimate walk over 11k records, each row
// re-parsing its date string). Record dates repeat heavily and never change
// for a given string, so cache epoch-ms per distinct string (NaN included).
const isoMsCache = new Map<string, number>();

/** parseISO(s).getTime(), cached per distinct string. */
export function parseISOMs(s: string): number {
  let ms = isoMsCache.get(s);
  if (ms === undefined) {
    if (isoMsCache.size > 20_000) isoMsCache.clear(); // imports cap distinct dates; belt-and-braces bound
    ms = parseISO(s).getTime();
    isoMsCache.set(s, ms);
  }
  return ms;
}

// ── Job (income) classification ──────────────────────────────────────────────

/**
 * The date that decides WHEN a paid job's income counts (§F cash basis: when
 * the money was RECEIVED). Fallback chain, most→least truthful: paidAt (the
 * mark-paid moment) → job date (invoice date) → createdAt. The stored
 * job.taxYear is NEVER used — it is derived from the job date at save time,
 * which is the wrong year for a payment received after 5 April.
 * Exported: the dashboard's period figures use the same rule (one canon).
 */
export function paidJobDate(j: Job): { date: Date; basis: 'paidAt' | 'jobDate' | 'createdAt' } {
  if (typeof j.paidAt === 'number' && j.paidAt > 0) {
    return { date: new Date(j.paidAt), basis: 'paidAt' };
  }
  const ms = parseISOMs(j.date);
  if (!Number.isNaN(ms)) return { date: new Date(ms), basis: 'jobDate' };
  return { date: new Date(j.createdAt), basis: 'createdAt' };
}

/**
 * Resolve a job's { status, paidAt } when the user toggles paid/unpaid.
 *
 * paidAt is the cash-basis received-date (§F): it decides the tax year and MTD
 * quarter the money lands in (paidJobDate above). So it must NEVER be silently
 * overwritten or lost — that would move income into the wrong period. Two rules:
 *
 *   • Never re-stamp on re-mark. Only a genuine non-paid → paid transition gets
 *     `now`. Re-marking an already-paid job (e.g. a bulk "Paid" that happens to
 *     include it) keeps the real date. A legacy paid job with no stored date is
 *     left undated (so paidJobDate keeps falling back to the job date, not today).
 *   • Marking unpaid sets the date ASIDE, not bin. It stays on the record but is
 *     ignored while unpaid — every reader gates on status==='paid' — so re-paying
 *     RESTORES the original date instead of stamping today. No date is ever lost.
 *
 * `now` is injected for testability. Callers guarantee a non-quote job.
 */
export function nextPaidState(
  job: Pick<Job, 'status' | 'paidAt'>,
  paid: boolean,
  now: number,
): { status: 'paid' | 'unpaid'; paidAt: number | undefined } {
  if (!paid) {
    // Set the received-date aside (kept on the record, ignored while unpaid).
    return { status: 'unpaid', paidAt: job.paidAt };
  }
  // Keep any stored date (a re-mark, or a restore after an unpaid blip). Only a
  // job with no remembered date that wasn't already paid gets today's stamp.
  const paidAt = job.paidAt ?? (job.status === 'paid' ? undefined : now);
  return { status: 'paid', paidAt };
}

/**
 * The date a receipt's expense counts on (cash-basis proxy): the receipt's own
 * date, falling back to the capture moment when it doesn't parse. Exported for
 * the dashboard's period figures — the same rule the estimate uses.
 */
export function receiptEffectiveDate(r: Receipt): { date: Date; dateInvalid: boolean } {
  const ms = parseISOMs(r.date);
  const dateInvalid = Number.isNaN(ms);
  return { date: new Date(dateInvalid ? r.capturedAt : ms), dateInvalid };
}

// ── The selection ────────────────────────────────────────────────────────────

/** "Before SoleTax" year-starter totals — the pre-app year-to-date figures a
 *  mid-year adopter enters (Tax setup). MTD quarterly updates are CUMULATIVE
 *  from 6 April (§H), so without these both the estimate and a filed update
 *  silently exclude everything pre-app. Integer pence + whole miles.
 *  COMPLIANCE (§H [VERBATIM 2026-07-09] "the easement list is complete"):
 *  these totals are an accuracy device for the figures — they are NOT digital
 *  records; HMRC's catch-up rule wants item-level records from the tax-year
 *  start, and the filing flow's disclosure owns that information line. */
export interface YearStarterTotals {
  incomePence: number;
  expensesPence: number;
  /** Car/van business miles driven pre-app (feeds the §E cumulative 10k
   *  switch). Motorcycle pre-app miles are out of the V1 shape — the lump
   *  can't be split by vehicle without more questions. */
  miles: number;
}

/**
 * The starter as DECLARED (what the user typed) plus the cutover boundary.
 * The figures describe the window 6 April → `cutoverMs` (the day they started
 * with SoleTax). What actually COUNTS is a REMAINDER, derived live:
 * `counted = max(0, declared − records now in the app dated before the
 * cutover)` — so backfilling real pre-app records automatically eats the lump
 * and double-counting is impossible by construction (S137 remainder
 * mechanic). `cutoverMs: 0` (legacy answers without one) disables the
 * decrement — nothing is dated before 1970.
 */
export interface YearStarterDeclared extends YearStarterTotals {
  cutoverMs: number;
}

export interface EstimateSelectionInput {
  /** Tax year being estimated, e.g. '2026-27' (src/lib/taxYear.ts format). */
  taxYear: string;
  jobs: Job[];
  receipts: Receipt[];
  /** Non-invoiced / other business income (cash takings, tips, asset sales,
   *  letting, VAT repayments). Summed into turnover exactly like a paid job. */
  otherIncome?: OtherIncome[];
  /** Business miles driven this tax year (trips layer; 0 until it ships). The
   *  TOTAL across all vehicles — drives `flatRateInUse`. */
  businessMiles?: number;
  /** Of `businessMiles`, the subset driven on a MOTORCYCLE (flat 24p, no 10k
   *  switch — §E). The remainder is car/goods-vehicle miles. Default 0 = all car. */
  motorcycleMiles?: number;
  /**
   * Override for "is the §E flat rate in use this year?". Default: true when
   * businessMiles > 0. Exists for the future per-vehicle actual-costs choice —
   * never set it true alongside van_vehicle receipts you intend to count.
   */
  useMileageFlatRate?: boolean;
  /** §E working-from-home band (tax-setup). Sets the flat-rate home deduction and
   *  excludes home_office (actual-cost) receipts. Absent/'none' = not used. */
  useOfHomeBand?: UseOfHomeBand;
  /** "Before SoleTax" DECLARED totals for THIS tax year (null/absent = none
   *  entered). Callers pass `yearStarterForYear(setup, taxYear)` — the
   *  year-key check lives there, so a stale prior-year answer can never leak
   *  in. What counts is the remainder after pre-cutover records (see
   *  YearStarterDeclared). */
  yearStarter?: YearStarterDeclared | null;
  /** Car/van business miles from trips dated BEFORE the starter cutover —
   *  the miles half of the remainder subtraction. Callers compute it via
   *  `selectBusinessMilesByVehicle(trips, taxYear, cutoverMs)` (selectors
   *  can't take raw trips without an import cycle). Default 0. */
  carVanMilesBeforeCutover?: number;
}

export interface EstimateInputDiagnostics {
  /** Paid + approved jobs whose money landed in this tax year. */
  jobsCounted: number;
  /** Paid jobs still awaiting review — excluded; the UI should nudge. */
  jobsPaidAwaitingReview: number;
  /** Counted via the job/invoice date because paidAt was missing. */
  jobsMissingPaidAt: number;
  /** Counted via createdAt because the job date didn't parse. */
  jobsInvalidDate: number;
  /** NaN / negative amounts — never summed. */
  jobsInvalidAmount: number;
  /** Counted jobs carrying a CIS withheld amount (§I netting). */
  jobsWithCis: number;
  /** CIS withheld exceeded the job amount — clamped down, data needs fixing. */
  jobsCisClamped: number;

  /** Approved other-income rows summed into turnover this tax year (excludes the
   *  Box-60 goods-for-own-use add-back, which is counted separately below). */
  otherIncomeCounted: number;
  /** Other income still awaiting review (a grey 'other' kind) — excluded; nudge. */
  otherIncomeAwaitingReview: number;
  /** NaN / non-positive other-income amounts — never summed. */
  otherIncomeInvalidAmount: number;
  /** Box-60 goods-for-own-use add-backs folded into the taxable base this year.
   *  Not "income received" (no cash) but it raises taxable profit and counts
   *  toward total receipts (SA103F: total receipts include boxes 15, 16, 59, 60). */
  goodsOwnUseCounted: number;

  /** Approved receipts counted into deductions for this tax year. */
  receiptsCounted: number;
  /** This year's receipts still awaiting review — excluded; nudge material. */
  receiptsAwaitingReview: number;
  /** Excluded by category rule or the user's compliance answer. */
  receiptsNotDeductible: number;
  /** §E exclusions — count + pence, for the receipt-review amber note. */
  receiptsMileageConflict: { count: number; pence: number };
  /** §E home-flat-rate exclusions — home_office receipts dropped (count + pence). */
  receiptsHomeConflict: { count: number; pence: number };
  /** Foreign receipts with no GBP amount yet. */
  receiptsUnconvertedForeign: number;
  receiptsInvalidAmount: number;
  receiptsZeroAmount: number;
  /** Counted via capturedAt because the receipt date didn't parse. */
  receiptsInvalidDate: number;
  /** personalAmount exceeded the face amount — clamped to £0, data needs fixing. */
  receiptsClampedSplit: number;
}

export interface EstimateInputs {
  taxYear: string;
  /** Exact integer-pence sums (the source of truth for the £ figures below). */
  incomeReceivedPence: number;
  /** SA103F Box-60 goods-for-own-use add-back this year (integer pence). NOT in
   *  incomeReceivedPence (turnover): a separate add-back to taxable profit, folded
   *  into the engine's turnover by toTaxEstimateInput. */
  goodsOwnUsePence: number;
  receiptDeductionsPence: number;
  /** "Before SoleTax" starter figures COUNTED this year (0 when none) — the
   *  remainder after pre-cutover records: max(0, declared − recorded). Kept OUT
   *  of incomeReceivedPence / receiptDeductionsPence — those stay app-recorded
   *  sums (what the export's per-record lines reconcile against) — but folded
   *  into the engine's incomeReceived / deductibleExpenses below, and into the
   *  mileage allowance via the §E cumulative pool. */
  yearStarterIncomePence: number;
  yearStarterExpensesPence: number;
  yearStarterMiles: number;
  /** The subtraction's other half — counted records dated before the starter
   *  cutover (0 when no starter). The Tax-setup card shows the arithmetic
   *  "declared − recorded = counted" from these; they are already inside
   *  incomeReceivedPence / receiptDeductionsPence like any other record. */
  yearStarterRecordedIncomePence: number;
  yearStarterRecordedExpensesPence: number;
  yearStarterRecordedMiles: number;
  /** §I: CIS withheld at source across the year's counted (paid + approved)
   *  jobs — advance payments the engine nets off the bill. */
  cisWithheldPence: number;
  /** £ mileage allowance for the year's business miles (§E flat rate). */
  mileageAllowance: number;
  /** Whether the §E flat rate is treated as in use (drives the van exclusion). */
  flatRateInUse: boolean;
  /** £ working-from-home flat-rate allowance for the year (§E; band × 12). */
  useOfHomeAllowance: number;
  /** Whether the §E home flat rate is in use (drives the home_office exclusion). */
  homeFlatRateInUse: boolean;
  /** Engine-ready £ values (incomeReceived / deductibleExpenses include the conversions). */
  incomeReceived: number;
  /** Receipt deductions + mileage allowance — what the engine expects (§E included). */
  deductibleExpenses: number;
  /** Engine-ready £ CIS withheld (cisWithheldPence converted once). */
  cisDeductionsWithheld: number;
  diagnostics: EstimateInputDiagnostics;
}

/** A stored pence figure as a safe non-negative integer (0 for junk). */
function clampPence(v: number | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0;
}

/**
 * Gather the engine's inputs for one tax year from raw store arrays.
 * Pure and deterministic: same arrays in, same numbers out.
 */
export function selectEstimateInputs(input: EstimateSelectionInput): EstimateInputs {
  const { taxYear, jobs, receipts } = input;

  const miles =
    typeof input.businessMiles === 'number' && Number.isFinite(input.businessMiles)
      ? Math.max(0, input.businessMiles)
      : 0;
  const motorcycleMiles =
    typeof input.motorcycleMiles === 'number' && Number.isFinite(input.motorcycleMiles)
      ? Math.min(miles, Math.max(0, input.motorcycleMiles))
      : 0;

  // "Before SoleTax" starter (S137 remainder mechanic, sanitised — a corrupt
  // store can't poison the maths): what counts is the DECLARED figure minus
  // counted records dated before the cutover, so a backfilled record
  // automatically replaces its slice of the lump and double-counting is
  // impossible. Miles subtract here (the caller supplies pre-cutover trip
  // miles); the £ halves accumulate in the loops below. Counted miles join
  // the car/van pool so the §E 10k switch telescopes over the TRUE year.
  const starter = input.yearStarter;
  const declaredIncomePence = clampPence(starter?.incomePence);
  const declaredExpensesPence = clampPence(starter?.expensesPence);
  const declaredMiles =
    typeof starter?.miles === 'number' && Number.isFinite(starter.miles)
      ? Math.max(0, starter.miles)
      : 0;
  const cutoverMs =
    typeof starter?.cutoverMs === 'number' && Number.isFinite(starter.cutoverMs)
      ? starter.cutoverMs
      : 0;
  const recordedStarterMiles =
    typeof input.carVanMilesBeforeCutover === 'number' && Number.isFinite(input.carVanMilesBeforeCutover)
      ? Math.max(0, input.carVanMilesBeforeCutover)
      : 0;
  const starterMiles = Math.max(0, declaredMiles - recordedStarterMiles);
  let recordedStarterIncomePence = 0;
  let recordedStarterExpensesPence = 0;

  const carVanMiles = Math.max(0, miles - motorcycleMiles) + starterMiles;
  const flatRateInUse = input.useMileageFlatRate ?? miles + declaredMiles > 0;
  // Year-total allowance, segmented by §E vehicle class: car/van miles telescope
  // through the 10k switch in one call; motorcycle miles are flat 24p.
  const mileageAllowance = mileageAllowanceFromTotals(carVanMiles, motorcycleMiles);

  // §E working-from-home flat rate (band × 12). When in use, home_office receipts
  // are excluded below (the double-claim guard).
  const useOfHomeAllowance = homeFlatRateAnnual(input.useOfHomeBand);
  const homeFlatRateInUse = isHomeFlatRateInUse(input.useOfHomeBand);

  const diagnostics: EstimateInputDiagnostics = {
    jobsCounted: 0,
    jobsPaidAwaitingReview: 0,
    jobsMissingPaidAt: 0,
    jobsInvalidDate: 0,
    jobsInvalidAmount: 0,
    jobsWithCis: 0,
    jobsCisClamped: 0,
    otherIncomeCounted: 0,
    otherIncomeAwaitingReview: 0,
    otherIncomeInvalidAmount: 0,
    goodsOwnUseCounted: 0,
    receiptsCounted: 0,
    receiptsAwaitingReview: 0,
    receiptsNotDeductible: 0,
    receiptsMileageConflict: { count: 0, pence: 0 },
    receiptsHomeConflict: { count: 0, pence: 0 },
    receiptsUnconvertedForeign: 0,
    receiptsInvalidAmount: 0,
    receiptsZeroAmount: 0,
    receiptsInvalidDate: 0,
    receiptsClampedSplit: 0,
  };

  // ── Income: paid + approved jobs, by the year the money arrived ──
  let incomeReceivedPence = 0;
  let goodsOwnUsePence = 0; // Box-60 add-back, tracked apart from turnover
  let cisWithheldPence = 0;
  for (const j of jobs) {
    if (j.status !== 'paid') continue; // quoted / unpaid / void: never turnover

    const { date, basis } = paidJobDate(j);
    if (getTaxYear(date) !== taxYear) continue; // another year's income

    if (j.reviewStatus !== 'approved') {
      diagnostics.jobsPaidAwaitingReview += 1; // AI-read amount unconfirmed
      continue;
    }
    if (typeof j.amount !== 'number' || !Number.isFinite(j.amount) || j.amount < 0) {
      diagnostics.jobsInvalidAmount += 1;
      continue;
    }
    if (j.amount === 0) continue; // unpriced job marked paid — nothing to add

    incomeReceivedPence += Math.round(j.amount);
    diagnostics.jobsCounted += 1;
    if (date.getTime() < cutoverMs) recordedStarterIncomePence += Math.round(j.amount);
    if (basis === 'jobDate') diagnostics.jobsMissingPaidAt += 1;
    if (basis === 'createdAt') diagnostics.jobsInvalidDate += 1;

    // §I: CIS withheld rides only with income that counts — netting tax from
    // money the estimate doesn't contain would understate the bill. A withheld
    // figure can never exceed the payment it came from: clamp UP-counting is
    // the trust-destroying direction (a too-big credit hides real tax due).
    const cis = typeof j.cisWithheld === 'number' && Number.isFinite(j.cisWithheld)
      ? Math.max(0, Math.round(j.cisWithheld))
      : 0;
    if (cis > 0) {
      const capped = Math.min(cis, Math.round(j.amount));
      cisWithheldPence += capped;
      diagnostics.jobsWithCis += 1;
      if (capped < cis) diagnostics.jobsCisClamped += 1;
    }
  }

  // ── Other income: approved rows, by the year the money arrived (cash basis) ──
  // Counts into turnover exactly like a paid job: approved only (a grey 'other'
  // kind awaiting review is excluded until confirmed), positive finite amount,
  // year from the received date with a createdAt fallback. The SA103F box (15 vs
  // 16) is immaterial to the maths — both feed turnover identically.
  //
  // Box 60 (goods_own_use) is the exception: it is NOT money received and NOT
  // turnover, so it is kept OUT of incomeReceivedPence and tracked in its own
  // goodsOwnUsePence. It is still an ADD-BACK to taxable profit (folded into the
  // engine's turnover in toTaxEstimateInput) and counts toward total receipts
  // (SA103F: "Total receipts include boxes 15, 16, 59, 60"). Keeping it separate
  // means incomeReceivedPence stays clean turnover (Box 15/16) — what the export's
  // turnover line reconciles against — and the "received" displays exclude it.
  for (const o of input.otherIncome ?? []) {
    const ms = parseISOMs(o.date);
    const when = new Date(Number.isNaN(ms) ? o.createdAt : ms);
    if (getTaxYear(when) !== taxYear) continue; // another year's income
    if (o.reviewStatus !== 'approved') {
      diagnostics.otherIncomeAwaitingReview += 1;
      continue;
    }
    if (typeof o.amount !== 'number' || !Number.isFinite(o.amount) || o.amount <= 0) {
      diagnostics.otherIncomeInvalidAmount += 1;
      continue;
    }
    if (o.kind === 'goods_own_use') {
      goodsOwnUsePence += Math.round(o.amount);
      diagnostics.goodsOwnUseCounted += 1;
    } else {
      incomeReceivedPence += Math.round(o.amount);
      diagnostics.otherIncomeCounted += 1;
      if (when.getTime() < cutoverMs) recordedStarterIncomePence += Math.round(o.amount);
    }
  }

  // ── Deductions: approved receipts, by expense date (cash basis proxy) ──
  let receiptDeductionsPence = 0;
  for (const r of receipts) {
    // Year first: a receipt belongs to the year of its expense date; fall back
    // to the capture moment when the date string doesn't parse.
    const { date: when, dateInvalid } = receiptEffectiveDate(r);
    if (getTaxYear(when) !== taxYear) continue; // another year's expense

    const c = classifyReceiptForEstimate(r, { flatRateInUse, homeFlatRateInUse });
    if (!c.counted) {
      switch (c.reason) {
        case 'not-approved':
          diagnostics.receiptsAwaitingReview += 1;
          break;
        case 'category-not-deductible':
        case 'user-marked-not-deductible':
          diagnostics.receiptsNotDeductible += 1;
          break;
        case 'mileage-conflict':
          diagnostics.receiptsMileageConflict.count += 1;
          diagnostics.receiptsMileageConflict.pence += Math.round(
            Math.max(0, businessAmount(r)),
          );
          break;
        case 'home-conflict':
          diagnostics.receiptsHomeConflict.count += 1;
          diagnostics.receiptsHomeConflict.pence += Math.round(Math.max(0, businessAmount(r)));
          break;
        case 'unconverted-foreign':
          diagnostics.receiptsUnconvertedForeign += 1;
          break;
        case 'invalid-amount':
          diagnostics.receiptsInvalidAmount += 1;
          break;
        case 'zero-amount':
          diagnostics.receiptsZeroAmount += 1;
          break;
      }
      continue;
    }

    receiptDeductionsPence += c.pence;
    diagnostics.receiptsCounted += 1;
    if (when.getTime() < cutoverMs) recordedStarterExpensesPence += c.pence;
    if (c.clampedSplit) diagnostics.receiptsClampedSplit += 1;
    if (dateInvalid) diagnostics.receiptsInvalidDate += 1;
  }

  // The remainder: declared minus what's now recorded (floored at 0 — records
  // beyond the declaration mean the estimate was low; records win).
  const starterIncomePence = Math.max(0, declaredIncomePence - recordedStarterIncomePence);
  const starterExpensesPence = Math.max(0, declaredExpensesPence - recordedStarterExpensesPence);

  return {
    taxYear,
    incomeReceivedPence,
    goodsOwnUsePence,
    receiptDeductionsPence,
    yearStarterIncomePence: starterIncomePence,
    yearStarterExpensesPence: starterExpensesPence,
    yearStarterMiles: starterMiles,
    yearStarterRecordedIncomePence: starter ? recordedStarterIncomePence : 0,
    yearStarterRecordedExpensesPence: starter ? recordedStarterExpensesPence : 0,
    yearStarterRecordedMiles: starter ? Math.min(declaredMiles, recordedStarterMiles) : 0,
    cisWithheldPence,
    mileageAllowance,
    flatRateInUse,
    useOfHomeAllowance,
    homeFlatRateInUse,
    // The single pence→pounds boundary. The engine works in £. The counted
    // starter joins here: the estimate covers the WHOLE year, not just the
    // app-recorded part of it.
    incomeReceived: (incomeReceivedPence + starterIncomePence) / 100,
    deductibleExpenses:
      (receiptDeductionsPence + starterExpensesPence) / 100 + mileageAllowance + useOfHomeAllowance,
    cisDeductionsWithheld: cisWithheldPence / 100,
    diagnostics,
  };
}

// ── Engine binding ───────────────────────────────────────────────────────────

/** The Account → Profile "Tax setup" answers (editable, change mid-year). */
export interface TaxProfile {
  nation?: UKNation;
  /** £ other taxable income this year (PAYE job, pension, rental). */
  otherTaxableIncome?: number;
  studentLoanPlan?: StudentLoanPlan;
  postgradLoan?: boolean;
  /** £ savings interest this year (§T). */
  savingsIncome?: number;
  /** £ dividends this year (§S). */
  dividendIncome?: number;
  /** Number of children Child Benefit is claimed for (§U HICBC). */
  childBenefitChildren?: number;
  /** £ NET personal pension contributions this year (§V relief at source). */
  pensionContributionsNet?: number;
  /** £ NET Gift Aid donations this year (§V). */
  giftAidDonationsNet?: number;
}

/** Merge a selection with the Tax-setup profile into the engine's input.
 *  CIS withheld comes from the SELECTION (per-job recorded amounts — facts
 *  about money already withheld), not from the profile's yes/no answer. */
export function toTaxEstimateInput(
  selection: EstimateInputs,
  profile: TaxProfile = {},
): TaxEstimateInput {
  return {
    taxYear: selection.taxYear,
    nation: profile.nation,
    // Box-60 goods-for-own-use is folded into the engine's turnover here (an
    // add-back to taxable profit), so it raises the bill without ever appearing
    // as cash "received" anywhere upstream. incomeReceived stays clean turnover.
    incomeReceived: selection.incomeReceived + selection.goodsOwnUsePence / 100,
    deductibleExpenses: selection.deductibleExpenses,
    otherTaxableIncome: profile.otherTaxableIncome,
    dividendIncome: profile.dividendIncome,
    savingsIncome: profile.savingsIncome,
    studentLoanPlan: profile.studentLoanPlan,
    postgradLoan: profile.postgradLoan,
    cisDeductionsWithheld: selection.cisDeductionsWithheld,
    childBenefitChildren: profile.childBenefitChildren,
    pensionContributionsNet: profile.pensionContributionsNet,
    giftAidDonationsNet: profile.giftAidDonationsNet,
  };
}

/**
 * The "≈ £X off your tax" win-line figure for a SLICE of the year's deductions
 * (this month's claimed receipts, the year's mileage allowance). The exact
 * two-estimate difference — never `slice × marginal rate`, never a flat rate
 * (locked; memory project_tax_relief_estimate_deferred). Returns 0 below the
 * thresholds — the UI shows NOTHING then, not £0. Only reinstates what the
 * estimate actually contains (a capture-month slice can include receipts dated
 * outside the tax year).
 */
export function reliefForDeductionSlice(
  binding: { selection: EstimateInputs; profile?: TaxProfile },
  slicePounds: number,
): number {
  if (slicePounds <= 0) return 0;
  const input = toTaxEstimateInput(binding.selection, binding.profile);
  const reinstated = Math.min(slicePounds, input.deductibleExpenses);
  if (reinstated <= 0) return 0;
  const without = { ...input, deductibleExpenses: input.deductibleExpenses - reinstated };
  return taxReliefForDeduction(without, reinstated);
}

/**
 * The covered-led set-aside: the §N January total spread over the months left,
 * rounded UP (conservative bias — over-save beats bill shock, locked
 * 2026-06-10). One formula for the Tax screen and the Home tax card.
 */
export function monthlySetAside(estimate: TaxEstimate, now: Date = new Date()): number {
  return Math.ceil(estimate.firstYearJanuaryTotal / monthsUntil(saDeadline(estimate.taxYear), now));
}
