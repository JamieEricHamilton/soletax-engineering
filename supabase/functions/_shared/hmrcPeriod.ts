/**
 * hmrcPeriod.ts — standard quarters, due dates and the period start (spec §6
 * "Rules that come from HMRC", built 2026-10-02 S230).
 *
 * HMRC's rules, verbatim in the register (§H 2026-09-29):
 *   - "Each update invalidates the previous submission because all periods
 *     start from 6 April" — updates are cumulative from the tax year's start.
 *   - "The deadline for meeting a quarterly obligation is one month and 2
 *     days after the obligation period end date."
 *   - SEB 5.0: `RULE_START_DATE_NOT_ALIGNED_TO_COMMENCEMENT_DATE: Start date
 *     does not align to the commencement date` — a business that began after
 *     6 April sends from its start date, so the period start is the LATER of
 *     6 April and HMRC's `commencementDate` (Business Details 2.0: "Business
 *     start date, must be in the past").
 *   - SEB 5.0: `RULE_EARLY_DATA_SUBMISSION_NOT_ACCEPTED: Cannot submit data
 *     more than 10 days before end of Period`. The spec leaves early sending
 *     for later: the server accepts a period only once it has ended.
 *   - Standard quarters end 5 July, 5 October, 5 January and 5 April (the
 *     checklist HMRC accepted: standard quarters only).
 *
 * Dates are ISO `YYYY-MM-DD` strings throughout; no timezone arithmetic (a
 * tax-year date is a calendar fact, not an instant).
 */

export const TAX_YEAR_RE = /^2[0-9]{3}-[0-9]{2}$/;

/** HMRC's quarterly-update rule (end-to-end service guide, register §H
 *  2026-09-29, verbatim): "Customers with an annual turnover (sales) of less
 *  than £90,000 can report their total income and expenses in their quarterly
 *  updates (no further breakdown required)." At or over it HMRC needs every
 *  cost under its own heading, which SoleTax does not send (decision D3: turn
 *  them away until the VAT tier). The same figure is the VAT registration
 *  threshold in src/tax/rates-2026-27.ts; scripts/test-hmrc-server.ts pins
 *  the two equal so neither can drift alone. */
export const TURNOVER_LIMIT_GBP = 90_000;

export function taxYearStart(taxYear: string): string {
  const y = Number(taxYear.slice(0, 4));
  return `${y}-04-06`;
}

export function taxYearEnd(taxYear: string): string {
  const y = Number(taxYear.slice(0, 4)) + 1;
  return `${y}-04-05`;
}

/** "2026-27" for any date from 6 Apr 2026 to 5 Apr 2027. */
export function taxYearFor(isoDate: string): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const startYear = m > 4 || (m === 4 && d >= 6) ? y : y - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
}

/** The four standard quarter ends of a tax year. */
export function standardQuarterEnds(taxYear: string): [string, string, string, string] {
  const y = Number(taxYear.slice(0, 4));
  return [`${y}-07-05`, `${y}-10-05`, `${y + 1}-01-05`, `${y + 1}-04-05`];
}

export function isStandardQuarterEnd(taxYear: string, periodEnd: string): boolean {
  return standardQuarterEnds(taxYear).includes(periodEnd);
}

/** Which quarter (1–4) a standard period end belongs to; 0 if none. */
export function quarterNumber(taxYear: string, periodEnd: string): number {
  return standardQuarterEnds(taxYear).indexOf(periodEnd) + 1;
}

function addMonthsAndDays(isoDate: string, months: number, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1 + months, d + days));
  return dt.toISOString().slice(0, 10);
}

/** "one month and 2 days after the obligation period end date": 5 Oct → 7 Nov. */
export function dueDateFor(periodEnd: string): string {
  return addMonthsAndDays(periodEnd, 1, 2);
}

/** The later of 6 April and the business's commencement date, when that date
 *  falls inside the tax year. A business that began before the year starts
 *  from 6 April; one that begins after the year's end has nothing to send. */
export function periodStartFor(taxYear: string, commencementDate: string | null | undefined): string {
  const start = taxYearStart(taxYear);
  if (!commencementDate || !/^\d{4}-\d{2}-\d{2}$/.test(commencementDate)) return start;
  return commencementDate > start ? commencementDate : start;
}

/** A period is sendable once it has ended (today ≥ periodEnd). */
export function periodHasEnded(periodEnd: string, todayIso: string): boolean {
  return todayIso >= periodEnd;
}

/** HMRC's own validation of the cumulative payload (SEB 5.0): both values
 *  present, "even if the values are zero", 0 ≤ v ≤ 99999999999.99, two
 *  decimals. Returns the field that fails, or null. */
export function invalidMoneyField(fields: Record<string, unknown>): string | null {
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v !== "number" || !Number.isFinite(v)) return k;
    if (v < 0 || v > 99999999999.99) return k;
    if (Math.round(v * 100) !== v * 100) return k;
  }
  return null;
}
