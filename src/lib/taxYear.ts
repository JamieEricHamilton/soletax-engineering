// UK tax year runs April 6 → April 5. Returns e.g. "2025-26".
//
// Single source of truth for the tax-year boundary, shared by receipts and
// income (and anything else that buckets records by year). Re-exported from
// the stores for backward compatibility with existing imports.
export function getTaxYear(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = date.getMonth() + 1; // 1-indexed
  const day = date.getDate();
  const isBeforeNewTaxYear = month < 4 || (month === 4 && day < 6);
  const startYear = isBeforeNewTaxYear ? year - 1 : year;
  return `${startYear}-${String(startYear + 1).slice(-2)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Compliance dates (register §G/§H/§N — date RULES live here, never figures).
// Every deadline/quarter/retention date shown anywhere in the UI derives from
// these helpers — worked-example tests in scripts/test-tax-dates.ts (part of
// `npm run test:tax`).
// ─────────────────────────────────────────────────────────────────────────────

/** '2026-27' → 2026. Throws on a malformed year string (programmer error). */
export function taxYearStartYear(taxYear: string): number {
  const m = /^(\d{4})-(\d{2})$/.exec(taxYear);
  if (m) {
    const start = Number(m[1]);
    if (String(start + 1).slice(-2) === m[2]) return start;
  }
  throw new Error(`Invalid tax year string: "${taxYear}" (expected e.g. "2026-27")`);
}

/** The tax year before the given one ('2026-27' → '2025-26'). */
export function previousTaxYear(taxYear: string): string {
  const start = taxYearStartYear(taxYear) - 1;
  return `${start}-${String(start + 1).slice(-2)}`;
}

/** The tax year's boundary dates: 6 April → 5 April (local time). */
export function taxYearDates(taxYear: string): { start: Date; end: Date } {
  const y = taxYearStartYear(taxYear);
  return { start: new Date(y, 3, 6), end: new Date(y + 1, 3, 5) };
}

/**
 * The Self Assessment online filing + payment deadline for a tax year:
 * 31 January following the end of the year (§H — "You must submit your tax
 * return by 31 January following the end of the relevant tax year"). The §N
 * balancing payment and first payment on account share this date.
 * e.g. 2026-27 (ends 5 Apr 2027) → 31 January 2028.
 */
export function saDeadline(taxYear: string): Date {
  return new Date(taxYearStartYear(taxYear) + 2, 0, 31);
}

/**
 * The SECOND payment on account for a tax year (§N/SALF303): due 31 July
 * following the balancing-payment/first-POA date. The first POA shares the
 * 31 January `saDeadline`; the second falls the following 31 July.
 * e.g. 2026-27 → first POA 31 Jan 2028 (saDeadline), second POA 31 July 2028.
 */
export function poaJulyDeadline(taxYear: string): Date {
  return new Date(taxYearStartYear(taxYear) + 2, 6, 31);
}

/**
 * The IMMINENT next statutory deadline (31 Jan or 31 Jul) at or after `now`, with
 * the tax year whose return/payment it is. Both 31 Jan (SA + first POA) and
 * 31 Jul (second POA) for a tax year fall in calendar year `startYear + 2`, so
 * the owning year of a deadline in calendar year C is always C − 2.
 *
 * This is what a DEADLINE REMINDER must track — the next real 31 Jan/31 Jul —
 * NOT `saDeadline(getTaxYear(now))`, which is the IN-PROGRESS year's deadline
 * (10–22 months out) used by the Tax-screen countdown + the set-aside. From a
 * user's second year on, those diverge: the imminent 31 Jan is the completed
 * year's return; the in-progress year's is a year further out.
 */
function nextAnnualUkDeadline(month0: number, day: number, now: Date): { date: Date; taxYear: string } {
  const y = now.getFullYear();
  let date = new Date(y, month0, day);
  if (endOfDay(date) < now) date = new Date(y + 1, month0, day);
  const startYear = date.getFullYear() - 2;
  return { date, taxYear: `${startYear}-${String(startYear + 1).slice(-2)}` };
}

/** Next Self Assessment / first-POA deadline (31 Jan) at/after `now` + its tax year. */
export function nextSelfAssessmentDeadline(now: Date = new Date()): { date: Date; taxYear: string } {
  return nextAnnualUkDeadline(0, 31, now);
}

/** Next second payment-on-account deadline (31 Jul) at/after `now` + its tax year. */
export function nextPoaJulyDeadline(now: Date = new Date()): { date: Date; taxYear: string } {
  return nextAnnualUkDeadline(6, 31, now);
}

/**
 * How long this year's records must be kept (§G, VERBATIM: "at least 5 years
 * after the 31 January submission deadline of the relevant tax year").
 * e.g. 2026-27 → deadline 31 Jan 2028 → kept until end of January 2033.
 * Never apply RK BK1's shorter non-business retention (§G caveat).
 */
export function recordsRetentionUntil(taxYear: string): Date {
  const deadline = saDeadline(taxYear);
  return new Date(deadline.getFullYear() + 5, deadline.getMonth(), deadline.getDate());
}

/**
 * MTD quarter model (§H, VERBATIM 2026-06-11). Two variants, both modelled now
 * (decided 2026-06-11); the calendar election UI ships with V2 submission:
 * - 'standard': periods anchored to 6 April; quarter slices end 5 Jul / 5 Oct /
 *   5 Jan / 5 Apr.
 * - 'calendar': the §H election for 1 Apr–31 Mar accounting periods; slices end
 *   30 Jun / 30 Sep / 31 Dec / 31 Mar.
 * Deadlines are identical for both: 7 August / 7 November / 7 February / 7 May.
 * NOTE (§H): the updates themselves are CUMULATIVE (each covers from the start
 * of the year), so a correction simply rides the next update. The slices here
 * are the natural display model for the quarter stepper.
 */
export type MtdQuarterVariant = 'standard' | 'calendar';

export interface MtdQuarter {
  index: 1 | 2 | 3 | 4;
  start: Date;
  end: Date;
  /** §H: when the cumulative update covering this quarter is due. */
  deadline: Date;
}

export function mtdQuarters(taxYear: string, variant: MtdQuarterVariant = 'standard'): MtdQuarter[] {
  const y = taxYearStartYear(taxYear);
  // [startMonth, startDay, startYearOffset, endMonth, endDay, endYearOffset] —
  // months 0-indexed, offsets relative to the tax-year start year. The two
  // variants spill differently: standard Q3 ends 5 Jan (+1); calendar Q3 ends
  // 31 Dec of the SAME year — only its Q4 crosses into the next.
  const slices =
    variant === 'standard'
      ? [
          [3, 6, 0, 6, 5, 0],   // 6 Apr – 5 Jul
          [6, 6, 0, 9, 5, 0],   // 6 Jul – 5 Oct
          [9, 6, 0, 0, 5, 1],   // 6 Oct – 5 Jan (+1)
          [0, 6, 1, 3, 5, 1],   // 6 Jan (+1) – 5 Apr (+1)
        ]
      : [
          [3, 1, 0, 5, 30, 0],  // 1 Apr – 30 Jun
          [6, 1, 0, 8, 30, 0],  // 1 Jul – 30 Sep
          [9, 1, 0, 11, 31, 0], // 1 Oct – 31 Dec
          [0, 1, 1, 2, 31, 1],  // 1 Jan (+1) – 31 Mar (+1)
        ];
  // §H deadlines, shared by both variants: 7 Aug / 7 Nov / 7 Feb (+1) / 7 May (+1).
  const deadlines = [
    new Date(y, 7, 7),
    new Date(y, 10, 7),
    new Date(y + 1, 1, 7),
    new Date(y + 1, 4, 7),
  ];
  return slices.map(([sm, sd, sOff, em, ed, eOff], i) => ({
    index: (i + 1) as 1 | 2 | 3 | 4,
    start: new Date(y + sOff, sm, sd),
    end: new Date(y + eOff, em, ed),
    deadline: deadlines[i],
  }));
}

/** The quarter `now` falls in (clamped to Q1 before the year opens; null after it ends). */
export function currentMtdQuarter(
  taxYear: string,
  now: Date = new Date(),
  variant: MtdQuarterVariant = 'standard',
): MtdQuarter | null {
  const quarters = mtdQuarters(taxYear, variant);
  if (now < quarters[0].start) return quarters[0];
  for (const q of quarters) {
    if (now <= endOfDay(q.end)) return q;
  }
  return null;
}

/**
 * The next MTD quarterly-update SUBMISSION deadline at or after `now` (§H:
 * 7 Aug / 7 Nov / 7 Feb / 7 May). Looks across the previous AND current tax
 * years so the prior year's trailing Q4 (due 7 May, still open in the 6 Apr–
 * 7 May window after the tax year rolls over on 6 Apr) is never skipped — the
 * current quarter's own deadline is not always the imminent one. Returns the
 * owning tax year + quarter; null only if neither year yields a future deadline
 * (unreachable in practice: the current tax year always has one ahead of now).
 */
export function nextMtdUpdate(
  now: Date = new Date(),
  variant: MtdQuarterVariant = 'standard',
): { taxYear: string; quarter: MtdQuarter } | null {
  const thisYear = getTaxYear(now);
  const candidates = [previousTaxYear(thisYear), thisYear]
    .flatMap((ty) => mtdQuarters(ty, variant).map((quarter) => ({ taxYear: ty, quarter })))
    .sort((a, b) => a.quarter.deadline.getTime() - b.quarter.deadline.getTime());
  return candidates.find((c) => endOfDay(c.quarter.deadline) >= now) ?? null;
}

/** Whole days from `from` until `date` (end of day), floored at 0. */
export function daysUntil(date: Date, from: Date = new Date()): number {
  const ms = endOfDay(date).getTime() - from.getTime();
  return Math.max(0, Math.ceil(ms / 86_400_000));
}

/** Whole months (rounded up, min 1) from `from` until `date` — the set-aside divisor. */
export function monthsUntil(date: Date, from: Date = new Date()): number {
  const months =
    (date.getFullYear() - from.getFullYear()) * 12 + (date.getMonth() - from.getMonth());
  const adjusted = date.getDate() >= from.getDate() ? months : months - 1;
  return Math.max(1, adjusted);
}

function endOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
}
