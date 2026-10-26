/**
 * dashboardData.ts — the Home screen's period figures, computed with the SAME
 * canonical rules as the tax estimate (src/tax/selectors.ts): income counts
 * when the money arrived (`paidJobDate`, cash basis §F), expenses via
 * `classifyReceiptForEstimate` on the receipt's effective date. Pure — no store
 * imports, no clock reads; worked-example checks live in
 * scripts/test-tax-selectors.ts (the dashboard section).
 *
 * Period semantics (locked 2026-06-11):
 * - Default period is MONTH (the felt pulse); Quarter = the MTD quarter
 *   (src/lib/taxYear.ts §H boundaries); Tax year = 6 Apr–5 Apr.
 * - Profit = received − expenses for the period. Cash basis: an unpaid invoice
 *   is never inside profit.
 * - OUTSTANDING is the current stock of unpaid jobs — deliberately NOT
 *   period-scoped (money owed now is owed now; mirrors the Jobs hero).
 * - The delta pill is positive-only (calm Home — a down month shows nothing).
 */
import { format } from 'date-fns';

import type { Job, OtherIncome } from '../income/types';
import type { Receipt } from '../receipts/types';
import type { Trip } from '../trips/types';
import { classifyReceiptForEstimate, paidJobDate, parseISOMs, receiptEffectiveDate } from '../tax/selectors';
import { isHomeFlatRateInUse, type UseOfHomeBand } from '../tax/useOfHome';
import { periodRanges, type Period } from './period';
import { getTaxYear, taxYearDates } from './taxYear';

/** Home's lens — the shared Period (./period) under its original name. */
export type HomePeriod = Period;

/**
 * The §E flat-rate flags every displayed expense figure must respect — the same
 * YEAR-level decisions the tax engine makes (mtdPack.ts): the mileage flat rate
 * is in use for any tax year with business miles (so van/fuel receipts are
 * excluded from that year's figures — the double-claim rule), and the
 * use-of-home flat rate follows the tax-setup band. Displayed totals built
 * without these silently disagree with the estimate (audit 2026-07, High #6).
 */
export interface EstimateFlags {
  /** Tax years ('2026-27') with any business miles — mileage flat rate in use. */
  mileageFlatRateYears: ReadonlySet<string>;
  /** §E working-from-home flat rate in use (tax-setup band, not 'none'). */
  homeFlatRateInUse: boolean;
}

/** Build the flags from raw data (callers own the store reads — this stays pure).
 *  `starterMilesYear` is the tax year with DECLARED Before-SoleTax miles
 *  (taxSetup.starterMilesTaxYear) — the engine's flat-rate decision counts the
 *  declared miles too (selectors.ts `miles + declaredMiles > 0`), so a switcher
 *  who declared miles but hasn't driven a recorded trip yet still has the
 *  mileage flat rate in use for that year (S143). */
export function estimateFlags(
  trips: Trip[],
  useOfHomeBand: UseOfHomeBand | undefined,
  starterMilesYear?: string | null,
): EstimateFlags {
  const years = new Set<string>();
  for (const t of trips) {
    if (t.purpose === 'business' && t.distanceMiles > 0) years.add(t.taxYear);
  }
  if (starterMilesYear) years.add(starterMilesYear);
  return { mileageFlatRateYears: years, homeFlatRateInUse: isHomeFlatRateInUse(useOfHomeBand) };
}

/** Per-receipt classifier options under the flags — keyed by the RECEIPT's tax
 *  year, matching the engine's year-level rule. */
function flagsFor(r: Receipt, flags: EstimateFlags) {
  return {
    flatRateInUse: flags.mileageFlatRateYears.has(r.taxYear),
    homeFlatRateInUse: flags.homeFlatRateInUse,
  };
}

export interface HomeFigures {
  receivedPence: number;
  expensesPence: number;
  /** received − expenses for the period (can be negative — render calmly). */
  profitPence: number;
  /** Current stock of unpaid jobs — not period-scoped. */
  outstandingPence: number;
  /** Hero label suffix: 'in June' / 'this quarter' / 'this year'. */
  periodLabel: string;
  /** Profit change vs the previous period; null when it isn't positive. */
  deltaPence: number | null;
  /** 'on May' / 'on last quarter' / 'on last year'. */
  deltaLabel: string;
}

export interface MonthBar {
  label: string; // 'Apr' … 'Mar'
  profitPence: number;
  isCurrent: boolean;
}

/**
 * The precomputed counting view every Home figure derives from. One pass over
 * the stores per data change instead of one per period window: at import scale
 * (S142: 11k records) the old per-window walks re-parsed and re-classified
 * every record ~15× per store write (2 hero periods + 12 chart months + year),
 * which is what made a classify tap pause. Build it once in a memo; the window
 * sums below are numeric scans.
 *
 * Income events = paid+approved jobs (cash basis, `paidJobDate`) AND approved
 * other income by its received date (S142, Jamie: imported/other income must
 * count on Home exactly as it already does in the tax estimate — same rules as
 * selectors.ts: approved, positive, `goods_own_use` excluded as an add-back).
 */
export interface ProfitIndex {
  /** [receivedMs, pence] per counted income event. */
  income: [number, number][];
  /** [dateMs, pence] per counted (deductible) receipt. */
  expenses: [number, number][];
  /** Current stock of unpaid jobs — not period-scoped. */
  outstandingPence: number;
}

export function buildProfitIndex(
  jobs: Job[],
  receipts: Receipt[],
  otherIncome: OtherIncome[],
  flags: EstimateFlags,
): ProfitIndex {
  const income: [number, number][] = [];
  let outstandingPence = 0;
  for (const j of jobs) {
    if (typeof j.amount !== 'number' || !Number.isFinite(j.amount) || j.amount <= 0) continue;
    if (j.status === 'unpaid') outstandingPence += Math.round(j.amount);
    if (j.status !== 'paid' || j.reviewStatus !== 'approved') continue;
    income.push([paidJobDate(j).date.getTime(), Math.round(j.amount)]);
  }
  for (const o of otherIncome) {
    if (o.reviewStatus !== 'approved') continue;
    if (o.kind === 'goods_own_use') continue; // Box 60 add-back — not money received
    if (typeof o.amount !== 'number' || !Number.isFinite(o.amount) || o.amount <= 0) continue;
    const ms = parseISOMs(o.date);
    income.push([Number.isNaN(ms) ? o.createdAt : ms, Math.round(o.amount)]);
  }
  const expenses: [number, number][] = [];
  for (const r of receipts) {
    const c = classifyReceiptForEstimate(r, flagsFor(r, flags));
    if (!c.counted) continue;
    expenses.push([receiptEffectiveDate(r).date.getTime(), c.pence]);
  }
  return { income, expenses, outstandingPence };
}

function sumIn(events: [number, number][], start: Date, end: Date): number {
  const s = start.getTime();
  const e = end.getTime();
  let sum = 0;
  for (const [t, p] of events) {
    if (t >= s && t < e) sum += p;
  }
  return sum;
}

function profitIn(index: ProfitIndex, start: Date, end: Date): number {
  return sumIn(index.income, start, end) - sumIn(index.expenses, start, end);
}

// periodRanges — the window maths — lives in ./period since 4 Sep 2026 (the
// shared period: the record tabs' heroes and the list filters read the SAME
// month / MTD-quarter / tax-year windows Home does).

export function homeFigures(
  index: ProfitIndex,
  period: HomePeriod,
  now: Date = new Date(),
): HomeFigures {
  const { start, end, prev, periodLabel, deltaLabel } = periodRanges(period, now);

  const receivedPence = sumIn(index.income, start, end);
  const expensesPence = sumIn(index.expenses, start, end);
  const profitPence = receivedPence - expensesPence;

  const delta = profitPence - profitIn(index, prev.start, prev.end);
  return {
    receivedPence,
    expensesPence,
    profitPence,
    // Outstanding: every currently-unpaid job (the Jobs-hero rule — quotes and
    // void never count; review status irrelevant, owed is owed).
    outstandingPence: index.outstandingPence,
    periodLabel,
    deltaPence: delta > 0 ? delta : null,
    deltaLabel,
  };
}

/** Profit per month for the WHOLE tax year — all 12 months, April through March
 *  (a fixed axis, like Apple Wallet's fixed week). Months with no activity come
 *  back at 0; the chart renders no bar for them (not a stub), so the axis always
 *  holds its shape without looking sparse or fat. */
export function monthlyProfitSeries(index: ProfitIndex, now: Date = new Date()): MonthBar[] {
  const { start } = taxYearDates(getTaxYear(now));
  const bars: MonthBar[] = [];
  // Note: April's bucket is the calendar month — the 1–5 April tail belongs to
  // the previous tax year for tax purposes, but a month chart reads by month.
  const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  for (let i = 0; i < 12; i++) {
    const cursor = new Date(start.getFullYear(), start.getMonth() + i, 1); // Apr…Mar
    const next = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
    bars.push({
      label: format(cursor, 'MMM'),
      profitPence: profitIn(index, cursor, next),
      isCurrent: cursor.getTime() === currentMonthStart.getTime(),
    });
  }
  return bars;
}

/** Tax-year-to-date profit (the chart header's 'this year' figure). */
export function yearProfitPence(index: ProfitIndex, now: Date = new Date()): number {
  const { start, end } = taxYearDates(getTaxYear(now));
  const endExcl = new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1);
  return profitIn(index, start, endExcl);
}
