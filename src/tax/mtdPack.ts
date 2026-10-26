/**
 * mtdPack.ts — the MTD-shaped aggregation behind the "export everything" pack.
 *
 * Turns the raw stores (jobs, receipts, trips) into the two shapes HMRC's
 * Making Tax Digital for Income Tax actually wants (register §H, verbatim
 * 2026-06-11):
 *
 *  1. The FINAL DECLARATION / annual position — turnover and each SA103F expense
 *     box total (the self-employment page), with the §E mileage allowance folded
 *     into Box 20 (Car, van and travel expenses).
 *  2. The QUARTERLY UPDATES — the same category totals, CUMULATIVE from the start
 *     of the tax year to each quarter end (§H: "Each time you send a quarterly
 *     update it will cover from the start of the tax year to the end of the
 *     update period"). Quarter boundaries come from `mtdQuarters` (§H model).
 *
 * COMPLIANCE: this module never re-implements the income/expense rules. It reuses
 * the canonical estimate selectors — `classifyReceiptForEstimate` (category
 * deductibility, the user's compliance answer, the §E van double-claim
 * exclusion, the private-use split), `paidJobDate`/`receiptEffectiveDate` (cash
 * basis) and `calculateMileageAllowance` (§E) — so the pack can only ever agree
 * with the in-app tax estimate. The reconciliation is asserted in
 * scripts/test-export.ts: the annual figures here equal `selectEstimateInputs`,
 * and the cumulative Q4 column equals the annual column.
 *
 * The quarterly-update CATEGORIES are the SA103F box set (register §H: "This is
 * the SA103F box set — src/receipts/sa103f-2026.ts already maps every category
 * onto it"), so no new categorisation layer is needed.
 *
 * Quarterly submission ships in V1 behind a flag, live on HMRC recognition
 * (decision 2026-07-08; final declaration follows in 2027). This pack is
 * data-only — turnover, expenses and net profit, no tax computation. The Tax
 * screen owns the estimate.
 */

import { parseISO } from 'date-fns';
import type { Job, OtherIncome } from '../income/types';
import type { Receipt } from '../receipts/types';
import { effectiveMiles, type Trip } from '../trips/types';
import { SA103F_CATEGORIES, SA103F_MAP } from '../receipts/sa103f-2026';
import { getIncomeKind, GOODS_FOR_OWN_USE } from '../income/incomeBoxes-2026';
import { getTaxYear, mtdQuarters, taxYearDates, type MtdQuarterVariant } from '../lib/taxYear';
import { homeFlatRateMonthly, isHomeFlatRateInUse, type UseOfHomeBand } from './useOfHome';
import { mileageAllowanceFromTotals, isMotorcycle } from './mileage';
import {
  classifyReceiptForEstimate,
  paidJobDate,
  receiptEffectiveDate,
  type YearStarterDeclared,
  type YearStarterTotals,
} from './selectors';

/** One line of a quarterly update / final declaration: a category and its total. */
export interface MtdLine {
  /** 'Turnover' for income, otherwise the SA103F box, e.g. 'Box 20'. */
  box: string;
  /** HMRC's own title for the line (verbatim from SA103F Notes via sa103f-2026.ts). */
  title: string;
  /** Total for the period, in integer pence. */
  pence: number;
  kind: 'income' | 'expense';
}

/** The totals for one period (a quarter's cumulative position, or the year). */
export interface MtdPeriodTotals {
  /** Income + each used expense box, in canonical order (Turnover, "Before
   *  SoleTax" income if any, Box 60 if any, then Box 17→30, then "Before
   *  SoleTax" costs if any). */
  lines: MtdLine[];
  /** Whole-year TURNOVER (SA103F Box 15) for the period — Box-15 income (jobs +
   *  Box-15 other-income kinds) PLUS the "Before SoleTax" starter income (what a
   *  cumulative update files as turnover). The Turnover LINE stays app-only; the
   *  starter shows on its own line. Box-16 income is NOT here (S143 refund
   *  ruling: "turnover" is the £90k-easement-watched figure — Box 16 must never
   *  inflate it); it rides `otherIncomePence`. */
  turnoverPence: number;
  /** SA103F Box-16 "Any other business income" (letting, VAT repayments,
   *  refunds/rebates) — trading income that is NOT turnover. Counts into net
   *  profit and files as the update's "other" income, never as turnover. */
  otherIncomePence: number;
  /** SA103F Box-60 goods-for-own-use add-back (integer pence). NOT turnover; added
   *  back to net profit. 0 when none. */
  goodsOwnUsePence: number;
  /** Sum of every expense box — INCLUDES the §E mileage allowance (in Box 20). */
  totalExpensesPence: number;
  /** turnover + Box-60 add-back − total expenses (may be negative: a loss). */
  netProfitPence: number;
}

export interface MtdQuarterTotals extends MtdPeriodTotals {
  index: 1 | 2 | 3 | 4;
  /** Inclusive period end (§H: 5 Jul / 5 Oct / 5 Jan / 5 Apr for 'standard'). */
  end: Date;
  /** §H deadline for the cumulative update covering this quarter. */
  deadline: Date;
}

export interface MtdPack {
  taxYear: string;
  variant: MtdQuarterVariant;
  /** The final-declaration / whole-year position. */
  annual: MtdPeriodTotals;
  /** The four cumulative quarterly updates. */
  quarters: MtdQuarterTotals[];
  /** §E: is the mileage flat rate in use this year (drives the van exclusion)? */
  flatRateInUse: boolean;
  /** Business miles counted this year — app trips PLUS "Before SoleTax" starter
   *  miles (the basis for the Box 20 mileage allowance). */
  businessMiles: number;
  /** The §E mileage allowance for the year, in integer pence (folded into Box 20). */
  mileagePence: number;
  /** §E: is the working-from-home flat rate in use (drives the home_office exclusion)? */
  homeFlatRateInUse: boolean;
  /** The §E use-of-home flat rate for the year, in integer pence (folded into Box 21). */
  useOfHomePence: number;
  /** "Before SoleTax" starter totals COUNTED into every period (null when
   *  none) — the remainder after pre-cutover records (S137), not the declared
   *  figures. The £ appear as their own labelled lines; the miles are already
   *  inside `businessMiles`/`mileagePence`. Display surfaces read this to
   *  annotate rather than re-derive. */
  yearStarter: YearStarterTotals | null;
}

const MILEAGE_BOX = 'Box 20'; // Car, van and travel expenses — where §E mileage lands.
const HOME_BOX = 'Box 21'; // Rent, rates, power, insurance — where §E use-of-home lands.

/**
 * Whole tax-year months elapsed to `upToMs` (Infinity = annual ⇒ 12), clamped
 * [0,12]. The §E home flat rate accrues per month, so the cumulative quarterly
 * columns step ~3/6/9/12. Whole-month floor (no partial-month bump) — slightly
 * conservative mid-year, exact (12) at year end where the tax figure is taken.
 */
function homeMonthsElapsed(taxYear: string, upToMs: number): number {
  if (!Number.isFinite(upToMs)) return 12;
  const start = taxYearDates(taxYear).start;
  const end = new Date(upToMs);
  if (end.getTime() <= start.getTime()) return 0;
  const months = (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth());
  return Math.max(0, Math.min(12, months));
}

/** Box → HMRC title, derived from the single source of truth (first use wins). */
const BOX_TITLE: Map<string, string> = (() => {
  const m = new Map<string, string>();
  for (const c of SA103F_CATEGORIES) {
    if (c.deductible && !m.has(c.box)) m.set(c.box, c.boxTitle);
  }
  return m;
})();

/** 'Box 20' → 20 for numeric ordering; anything unparsed sorts last. */
function boxNum(box: string): number {
  const m = /Box (\d+)/.exec(box);
  return m ? Number(m[1]) : 999;
}

/** Inclusive end-of-day in local time — a record dated on the period end still counts. */
function dayEndMs(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999).getTime();
}

interface Aggregate {
  turnoverPence: number;
  /** Box-16 "Any other business income" up to the cutoff (integer pence). */
  otherIncomePence: number;
  /** SA103F Box-60 goods-for-own-use add-back up to the cutoff (integer pence). */
  goodsOwnUsePence: number;
  /** Receipt deductions by SA103F box (mileage NOT included — added at line time). */
  expenseByBox: Map<string, number>;
  /** §E mileage allowance up to the cutoff, in integer pence. */
  mileagePence: number;
  /** §E working-from-home flat rate accrued to the cutoff, in integer pence. */
  useOfHomePence: number;
  /** Raw car/van business miles accumulated to the cutoff (seed-inclusive) —
   *  the pre-cutover aggregate reads this for the starter-miles subtraction. */
  carVanMiles: number;
}

/**
 * Aggregate turnover, expenses-by-box and the mileage allowance for the tax year
 * up to (and including) `upToMs`. Pass `Infinity` for the whole year. The year
 * bound is enforced by `getTaxYear(...) === taxYear` (both ends); `upToMs` adds
 * the cumulative cutoff for a quarter. Every per-record rule is the canonical
 * estimate selector — nothing is re-implemented here.
 */
function aggregateUpTo(
  jobs: Job[],
  receipts: Receipt[],
  trips: Trip[],
  otherIncome: OtherIncome[],
  taxYear: string,
  flatRateInUse: boolean,
  homeFlatRateInUse: boolean,
  homeMonthlyRate: number,
  starterMiles: number,
  upToMs: number,
): Aggregate {
  // ── Income: paid + approved jobs, by the year (and date) the money arrived ──
  let turnoverPence = 0;
  let goodsOwnUsePence = 0;
  for (const j of jobs) {
    if (j.status !== 'paid') continue;
    const { date } = paidJobDate(j);
    if (getTaxYear(date) !== taxYear) continue;
    if (j.reviewStatus !== 'approved') continue;
    if (typeof j.amount !== 'number' || !Number.isFinite(j.amount) || j.amount <= 0) continue;
    if (date.getTime() > upToMs) continue; // cumulative cutoff
    turnoverPence += Math.round(j.amount);
  }

  // ── Other income: approved rows, same year + cumulative cutoff as jobs,
  // routed by the kind's SA103F box (incomeBoxes-2026, the single source):
  // Box 15 kinds are turnover; Box 16 kinds (letting, VAT repayments,
  // refunds/rebates) are "any other business income" — trading income but NOT
  // turnover, so they never inflate the £90k-easement-watched figure or file
  // as turnover (S143 refund ruling). Box 60 (goods_own_use) stays the
  // add-back exception in its own bucket. Net profit counts all three. ──
  let otherIncomePence = 0;
  for (const o of otherIncome) {
    const parsed = parseISO(o.date);
    const when = Number.isNaN(parsed.getTime()) ? new Date(o.createdAt) : parsed;
    if (getTaxYear(when) !== taxYear) continue;
    if (o.reviewStatus !== 'approved') continue;
    if (typeof o.amount !== 'number' || !Number.isFinite(o.amount) || o.amount <= 0) continue;
    if (when.getTime() > upToMs) continue; // cumulative cutoff
    if (o.kind === 'goods_own_use') goodsOwnUsePence += Math.round(o.amount);
    else if (getIncomeKind(o.kind).box === 'Box 16') otherIncomePence += Math.round(o.amount);
    else turnoverPence += Math.round(o.amount);
  }

  // ── Expenses: approved, deductible receipts, grouped by SA103F box ──
  const expenseByBox = new Map<string, number>();
  for (const r of receipts) {
    const { date } = receiptEffectiveDate(r);
    if (getTaxYear(date) !== taxYear) continue;
    if (date.getTime() > upToMs) continue;
    const c = classifyReceiptForEstimate(r, { flatRateInUse, homeFlatRateInUse });
    if (!c.counted) continue;
    const box = SA103F_MAP.get(r.category)!.box; // counted ⇒ deductible ⇒ meta exists
    expenseByBox.set(box, (expenseByBox.get(box) ?? 0) + c.pence);
  }

  // ── §E mileage: cumulative business miles up to the cutoff → flat-rate allowance,
  // segmented by vehicle class. Car/van miles telescope through the 10k switch;
  // motorcycle miles are flat 24p and never pooled into that threshold. The
  // "Before SoleTax" starter miles pre-date every app record, so they sit in
  // the car/van pool for EVERY cutoff — the 10k switch works on the TRUE
  // cumulative year (§E: the switch is on cumulative business miles).
  let carVanMiles = starterMiles;
  let motorcycleMiles = 0;
  for (const t of trips) {
    if (t.taxYear !== taxYear || t.purpose !== 'business') continue;
    if (t.startTime > upToMs) continue;
    if (isMotorcycle(t.vehicleType)) motorcycleMiles += effectiveMiles(t);
    else carVanMiles += effectiveMiles(t);
  }
  const mileagePence = Math.round(mileageAllowanceFromTotals(carVanMiles, motorcycleMiles) * 100);

  // §E working-from-home: monthly flat rate × whole months elapsed to the cutoff.
  const useOfHomePence = homeFlatRateInUse
    ? Math.round(homeMonthlyRate * homeMonthsElapsed(taxYear, upToMs) * 100)
    : 0;

  return { turnoverPence, otherIncomePence, goodsOwnUsePence, expenseByBox, mileagePence, useOfHomePence, carVanMiles };
}

/** The label both starter lines carry — display surfaces key off it. */
export const YEAR_STARTER_BOX = 'Before SoleTax';

/**
 * Assemble the lines for one period from its aggregate, using `boxes` as the row
 * template (the year's used boxes) so every quarter is the same rectangular shape.
 * The mileage allowance is folded into Box 20. `includeGoodsOwnUse` keeps the Box-60
 * add-back line present in EVERY period (0 in periods before it) when the year has
 * any, so the quarter columns stay the same shape as the annual.
 *
 * The "Before SoleTax" starter £ appear as their OWN labelled lines (never folded
 * silently into Turnover or a real SA103F box — the export must show what came
 * from the app's records and what the user brought in as pre-app totals), but
 * they DO count into turnoverPence / totalExpensesPence / netProfitPence: those
 * are the whole-year figures a cumulative update files (§H). Starter lines are
 * identical in every period — the window (6 April → adopting SoleTax) pre-dates
 * every app record, so it is fully accrued at every cumulative cutoff.
 */
function buildPeriod(
  agg: Aggregate,
  boxes: string[],
  includeGoodsOwnUse: boolean,
  includeOtherIncome: boolean,
  starter: YearStarterTotals | null,
): MtdPeriodTotals {
  const starterIncome = starter?.incomePence ?? 0;
  const starterExpenses = starter?.expensesPence ?? 0;
  const lines: MtdLine[] = [
    { box: 'Turnover', title: 'Turnover', pence: agg.turnoverPence, kind: 'income' },
  ];
  if (starterIncome > 0) {
    lines.push({
      box: YEAR_STARTER_BOX,
      title: 'Money in before SoleTax',
      pence: starterIncome,
      kind: 'income',
    });
  }
  // Box 16 "Any other business income" — its own line whenever the YEAR has
  // any (kept in every period, like Box 60, so the quarter columns stay the
  // same rectangular shape). Trading income, never turnover.
  if (includeOtherIncome) {
    lines.push({
      box: 'Box 16',
      title: 'Any other business income',
      pence: agg.otherIncomePence,
      kind: 'income',
    });
  }
  // Box 60 goods-for-own-use — an add-back, sits with income (raises net profit).
  if (includeGoodsOwnUse) {
    lines.push({
      box: GOODS_FOR_OWN_USE.box,
      title: GOODS_FOR_OWN_USE.boxTitle,
      pence: agg.goodsOwnUsePence,
      kind: 'income',
    });
  }
  let totalExpensesPence = 0;
  for (const box of boxes) {
    const receipts = agg.expenseByBox.get(box) ?? 0;
    const pence =
      box === MILEAGE_BOX
        ? receipts + agg.mileagePence
        : box === HOME_BOX
          ? receipts + agg.useOfHomePence
          : receipts;
    totalExpensesPence += pence;
    lines.push({ box, title: BOX_TITLE.get(box) ?? box, pence, kind: 'expense' });
  }
  if (starterExpenses > 0) {
    totalExpensesPence += starterExpenses;
    lines.push({
      box: YEAR_STARTER_BOX,
      title: 'Costs before SoleTax',
      pence: starterExpenses,
      kind: 'expense',
    });
  }
  const turnoverPence = agg.turnoverPence + starterIncome;
  return {
    lines,
    turnoverPence,
    otherIncomePence: agg.otherIncomePence,
    goodsOwnUsePence: agg.goodsOwnUsePence,
    totalExpensesPence,
    netProfitPence:
      turnoverPence + agg.otherIncomePence + agg.goodsOwnUsePence - totalExpensesPence,
  };
}

/**
 * Build the full MTD pack for a tax year. Pure and deterministic: same arrays in,
 * same numbers out (no store reads, no clock reads).
 */
export function buildMtdPack(
  jobs: Job[],
  receipts: Receipt[],
  trips: Trip[],
  otherIncome: OtherIncome[],
  taxYear: string,
  opts: {
    variant?: MtdQuarterVariant;
    useMileageFlatRate?: boolean;
    useOfHomeBand?: UseOfHomeBand;
    /** "Before SoleTax" DECLARED starter for THIS tax year — callers pass
     *  `yearStarterForYear(setup, taxYear)` (the year-key check lives there).
     *  The pack derives what COUNTS: the remainder after pre-cutover records. */
    yearStarter?: YearStarterDeclared | null;
  } = {},
): MtdPack {
  const variant = opts.variant ?? 'standard';

  // "Before SoleTax" starter, sanitised (pure function, callers vary).
  const safe = (v: number | undefined): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.max(0, v) : 0;
  const declared: YearStarterDeclared | null = opts.yearStarter
    ? {
        incomePence: Math.round(safe(opts.yearStarter.incomePence)),
        expensesPence: Math.round(safe(opts.yearStarter.expensesPence)),
        miles: safe(opts.yearStarter.miles),
        cutoverMs: safe(opts.yearStarter.cutoverMs),
      }
    : null;

  // The §E flat rate is a YEAR-level decision (default: in use when any business
  // miles were driven — app trips OR pre-app declared starter miles), applied
  // identically to every period — never per quarter.
  const tripMiles = trips
    .filter((t) => t.taxYear === taxYear && t.purpose === 'business')
    .reduce((sum, t) => sum + effectiveMiles(t), 0);
  const flatRateInUse = opts.useMileageFlatRate ?? tripMiles + (declared?.miles ?? 0) > 0;

  // §E working-from-home flat rate — a year-level band (tax-setup), accrued monthly.
  const homeFlatRateInUse = isHomeFlatRateInUse(opts.useOfHomeBand);
  const homeMonthlyRate = homeFlatRateMonthly(opts.useOfHomeBand);

  // The remainder (S137): counted starter = declared − counted records dated
  // before the cutover, floored at 0 — backfilled records automatically
  // replace their slice of the lump. The pre-cutover sums come from the SAME
  // aggregator as every period (identical counting rules by construction);
  // goods-for-own-use is excluded (not money in, never part of the lump).
  const starter: YearStarterTotals | null = (() => {
    if (!declared) return null;
    if (declared.cutoverMs <= 0) {
      // Legacy answer (no cutover) — no decrement; strip to the counted shape.
      return { incomePence: declared.incomePence, expensesPence: declared.expensesPence, miles: declared.miles };
    }
    const pre = aggregateUpTo(
      jobs, receipts, trips, otherIncome, taxYear,
      flatRateInUse, homeFlatRateInUse, homeMonthlyRate,
      0, declared.cutoverMs - 1,
    );
    let preExpenses = 0;
    for (const v of pre.expenseByBox.values()) preExpenses += v;
    return {
      // The declared "money in" lump covers ALL pre-app income, so pre-cutover
      // Box-16 records eat it exactly as turnover records do (the 15/16 split
      // is a filing distinction, not a remainder one).
      incomePence: Math.max(0, declared.incomePence - pre.turnoverPence - pre.otherIncomePence),
      expensesPence: Math.max(0, declared.expensesPence - preExpenses),
      miles: Math.max(0, declared.miles - pre.carVanMiles),
    };
  })();
  const starterMiles = starter?.miles ?? 0;
  const businessMiles = tripMiles + starterMiles;

  const agg = (upToMs: number) =>
    aggregateUpTo(jobs, receipts, trips, otherIncome, taxYear, flatRateInUse, homeFlatRateInUse, homeMonthlyRate, starterMiles, upToMs);

  // Annual first — it defines the row template (which boxes are used all year).
  const annualAgg = agg(Infinity);
  const boxes = Array.from(
    new Set<string>([
      ...annualAgg.expenseByBox.keys(),
      ...(annualAgg.mileagePence > 0 ? [MILEAGE_BOX] : []),
      ...(annualAgg.useOfHomePence > 0 ? [HOME_BOX] : []),
    ]),
  ).sort((a, b) => boxNum(a) - boxNum(b));

  const includeGoodsOwnUse = annualAgg.goodsOwnUsePence > 0;
  const includeOtherIncome = annualAgg.otherIncomePence > 0;
  const annual = buildPeriod(annualAgg, boxes, includeGoodsOwnUse, includeOtherIncome, starter);

  const quarters: MtdQuarterTotals[] = mtdQuarters(taxYear, variant).map((q) => {
    return { index: q.index, end: q.end, deadline: q.deadline, ...buildPeriod(agg(dayEndMs(q.end)), boxes, includeGoodsOwnUse, includeOtherIncome, starter) };
  });

  return {
    taxYear,
    variant,
    annual,
    quarters,
    flatRateInUse,
    businessMiles,
    mileagePence: annualAgg.mileagePence,
    homeFlatRateInUse,
    useOfHomePence: annualAgg.useOfHomePence,
    yearStarter: starter && (starter.incomePence > 0 || starter.expensesPence > 0 || starter.miles > 0) ? starter : null,
  };
}
