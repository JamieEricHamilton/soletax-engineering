/**
 * useOfHome.ts — §E simplified working-from-home flat rate.
 *
 * gov.uk simplified expenses (compliance_sources.md §E, read 2026-06-10): a flat
 * MONTHLY rate by the hours worked from home that month — under 25 hrs/month can't
 * use it (25–50 = £10, 51–100 = £18, 101+ = £26). The flat rate REPLACES the
 * actual-cost route (the `home_office` category, Box 21) — never both, the
 * homeConflict (mirrors the §E mileage van conflict, sa103f-2026.ts).
 *
 * V1 captures one representative monthly band and applies it across the full tax
 * year (× 12). KNOWN BOUNDARY: a part-year trader who worked fewer months would
 * claim less than ×12 — but ×12 is the steady full-year figure HMRC's own example
 * uses, and over-claiming is the only unsafe direction, so we keep ×12 and
 * document it (like the per-vehicle mileage bound). The £ figures come from
 * `USE_OF_HOME_FLAT_RATES` (the single rate source) — never hardcode them here.
 */
import { USE_OF_HOME_FLAT_RATES } from './rates-2026-27';

/** The hours-worked-from-home band the user picks ('none' = under 25 / not used). */
export type UseOfHomeBand = 'none' | '25-50' | '51-100' | '101-plus';

const MONTHS_PER_YEAR = 12;

const BAND_MIN_HOURS: Record<Exclude<UseOfHomeBand, 'none'>, number> = {
  '25-50': 25,
  '51-100': 51,
  '101-plus': 101,
};

/** £/month for a band (0 for 'none'/undefined), read from the §E rate table. */
export function homeFlatRateMonthly(band: UseOfHomeBand | undefined): number {
  if (!band || band === 'none') return 0;
  const minHours = BAND_MIN_HOURS[band];
  return USE_OF_HOME_FLAT_RATES.find((b) => b.minHours === minHours)?.perMonth ?? 0;
}

/** £/year — the steady full-year flat-rate deduction (monthly × 12). */
export function homeFlatRateAnnual(band: UseOfHomeBand | undefined): number {
  return homeFlatRateMonthly(band) * MONTHS_PER_YEAR;
}

/** Is the flat rate in use this year (a band ≥ 25 hrs chosen)? Drives the
 *  home_office receipt exclusion (the double-claim guard). */
export function isHomeFlatRateInUse(band: UseOfHomeBand | undefined): boolean {
  return homeFlatRateMonthly(band) > 0;
}
