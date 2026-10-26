/**
 * period.ts — THE SHARED PERIOD (Jamie, 4 Sep 2026: "I think shared
 * everywhere. If I set it to quarter on Home it mirrors on every tab;
 * changing it changes it everywhere — one shared toggle mirrored on every
 * page … on both app and portal").
 *
 * ONE `Period`, ONE window maths, ONE phrase. The maths is Home's (the MTD
 * quarter from taxYear.ts — 6 Apr / 6 Jul / 6 Oct / 6 Jan — and the 6 April
 * tax year), lifted here verbatim from dashboardData so the three record
 * tabs' heroes, Home's figures, and the list filters' "This quarter" chip
 * (dateRange.ts) can never disagree on what a quarter is. The phrase is the
 * hero's: "in September" · "this quarter" · "this year" — Home has always
 * read "Profit in September"; the tabs now read "Claimed in September" /
 * "Received in September" / "Business miles in September" from the same
 * word.
 *
 * Where the lens is HELD is each surface's own: the app's persisted
 * `periodStore` (MMKV) and the portal's `lib/period` (localStorage). Both
 * default to Month (dashboard_spec §3a, locked 2026-06-11).
 */
import { format } from 'date-fns';
import { currentMtdQuarter, getTaxYear, mtdQuarters, taxYearDates, taxYearStartYear } from './taxYear';

export type Period = 'month' | 'quarter' | 'year';

export const DEFAULT_PERIOD: Period = 'month';

export const PERIOD_OPTIONS: { label: string; value: Period }[] = [
  { label: 'Month', value: 'month' },
  { label: 'Quarter', value: 'quarter' },
  { label: 'Tax year', value: 'year' },
];

export const isPeriod = (v: unknown): v is Period => v === 'month' || v === 'quarter' || v === 'year';

export interface PeriodRange {
  /** [start, end) of the selected period. */
  start: Date;
  end: Date;
  /** The previous period, for the delta line. */
  prev: { start: Date; end: Date };
  /** "in September" · "this quarter" · "this year" — the hero's phrase. */
  periodLabel: string;
  /** "on August" · "on last quarter" · "on last year" — the delta's phrase. */
  deltaLabel: string;
}

/** [start, end) of the selected period, plus the previous period for the delta. */
export function periodRanges(period: Period, now: Date): PeriodRange {
  if (period === 'month') {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const prevStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    return {
      start,
      end,
      prev: { start: prevStart, end: start },
      periodLabel: `in ${format(now, 'MMMM')}`,
      deltaLabel: `on ${format(prevStart, 'MMMM')}`,
    };
  }
  if (period === 'quarter') {
    const taxYear = getTaxYear(now);
    const q = currentMtdQuarter(taxYear, now) ?? mtdQuarters(taxYear)[3];
    const end = new Date(q.end.getFullYear(), q.end.getMonth(), q.end.getDate() + 1);
    // Previous MTD quarter; Q1's predecessor is last tax year's Q4.
    const prevQ =
      q.index === 1
        ? mtdQuarters(`${taxYearStartYear(taxYear) - 1}-${String(taxYearStartYear(taxYear)).slice(-2)}`)[3]
        : mtdQuarters(taxYear)[q.index - 2];
    const prevEnd = new Date(prevQ.end.getFullYear(), prevQ.end.getMonth(), prevQ.end.getDate() + 1);
    return {
      start: q.start,
      end,
      prev: { start: prevQ.start, end: prevEnd },
      periodLabel: 'this quarter',
      deltaLabel: 'on last quarter',
    };
  }
  const taxYear = getTaxYear(now);
  const { start, end } = taxYearDates(taxYear);
  const endExcl = new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1);
  const prevYearStart = taxYearStartYear(taxYear) - 1;
  const prev = taxYearDates(`${prevYearStart}-${String(prevYearStart + 1).slice(-2)}`);
  return {
    start,
    end: endExcl,
    prev: { start: prev.start, end: start },
    periodLabel: 'this year',
    deltaLabel: 'on last year',
  };
}

/** The selected period as an epoch-ms window, [start, end). */
export interface PeriodWindow {
  start: number;
  end: number;
}

export function periodWindow(period: Period, now: Date = new Date()): PeriodWindow {
  const r = periodRanges(period, now);
  return { start: r.start.getTime(), end: r.end.getTime() };
}

export const inPeriod = (t: number, w: PeriodWindow): boolean => t >= w.start && t < w.end;

/** "in September" · "this quarter" · "this year". */
export function periodPhrase(period: Period, now: Date = new Date()): string {
  return periodRanges(period, now).periodLabel;
}
