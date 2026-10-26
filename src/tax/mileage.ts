/**
 * mileage.ts — THE mileage-allowance calculator (§E simplified expenses).
 *
 * Single source for the flat-rate maths: trips, the Mileage tab and the
 * estimate inputs all call this — never reimplement the 10,000-mile switch.
 * Rates come from rates-2026-27.ts (verbatim §E, re-read each April).
 *
 * BIM75005: the rate follows the tax year the miles were driven in. This file
 * carries the CURRENT year's rates; historic years would need their year's
 * figure (no historic trips exist yet — trips layer ships 2026-27 onward).
 *
 * §E vehicle classes (compliance_sources.md §E, read 2026-06-29): cars + goods
 * vehicles take the 55p→25p switch on CUMULATIVE car/van miles; motorcycles are
 * a flat 24p with NO threshold and are NEVER pooled into the car/van cumulative.
 * There is no bicycle rate in simplified expenses.
 */

import { MILEAGE_FLAT_RATES } from './rates-2026-27';

/** §E vehicle class. No bicycle — there's no self-employed simplified bike rate. */
export type TripVehicleType = 'car' | 'motorcycle';

/**
 * £ allowance for a CAR/GOODS-VEHICLE trip of `miles`, given the car/van miles
 * already driven this tax year (the 55p→25p switch is on CUMULATIVE car/van
 * miles, not per trip). Motorcycle miles do NOT belong in `cumulative…`.
 */
export function calculateMileageAllowance(miles: number, cumulativeMilesThisTaxYear: number): number {
  if (miles <= 0) return 0;
  const cumulative = Math.max(0, cumulativeMilesThisTaxYear);
  const milesUnderThreshold = Math.max(0, MILEAGE_FLAT_RATES.thresholdMiles - cumulative);
  const milesAtStandardRate = Math.min(miles, milesUnderThreshold);
  const milesAtReducedRate = Math.max(0, miles - milesAtStandardRate);
  return (
    milesAtStandardRate * MILEAGE_FLAT_RATES.carFirst10k +
    milesAtReducedRate * MILEAGE_FLAT_RATES.carAfter10k
  );
}

/** undefined vehicleType means car (existing trips need no migration). */
export const isMotorcycle = (v?: TripVehicleType): boolean => v === 'motorcycle';

/**
 * £ allowance for ONE trip, dispatched by vehicle class. Motorcycle = flat 24p
 * (no threshold, `cumulativeCarVanMiles` ignored). Car/goods vehicle = the 10k
 * cumulative switch. The caller advances `cumulativeCarVanMiles` with CAR/VAN
 * miles only — never motorcycle miles.
 */
export function tripAllowance(
  miles: number,
  vehicleType: TripVehicleType | undefined,
  cumulativeCarVanMiles: number,
): number {
  if (miles <= 0) return 0;
  if (isMotorcycle(vehicleType)) return miles * MILEAGE_FLAT_RATES.motorcycle;
  return calculateMileageAllowance(miles, cumulativeCarVanMiles);
}

/**
 * Year-total allowance from segmented totals — the estimate/pack path. Car/van
 * total telescopes through the 10k switch in one call; motorcycle total is flat.
 */
export function mileageAllowanceFromTotals(carVanMiles: number, motorcycleMiles: number): number {
  return (
    calculateMileageAllowance(Math.max(0, carVanMiles), 0) +
    Math.max(0, motorcycleMiles) * MILEAGE_FLAT_RATES.motorcycle
  );
}
