/**
 * gapCredit.ts - TYPE STUB for the showcase repo.
 *
 * In the production repo this module (and the rail/line indices it depends on,
 * ~600 KB of transport-network data) implements the mileage gap-credit model.
 * That IP is deliberately left out of the public showcase; trips/types.ts only
 * needs the shape, so the shape is all that is kept here.
 */
export interface GapCreditGapDetail {
  fromIndex: number;
  toIndex: number;
  straightLineMiles: number;
  roadMiles: number;
  creditedMiles: number;
}
export interface TripGapCredit {
  gapCreditMiles: number;
  source: string;
  gaps: GapCreditGapDetail[];
  suspendedMiles?: number;
}
