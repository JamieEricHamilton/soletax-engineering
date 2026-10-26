/**
 * Trip types — the mileage data layer (CLAUDE.md → Data Structures).
 *
 * Distance is ALWAYS the Transistor SDK odometer (`location.odometer /
 * 1609.344`) — never Haversine, never recomputed from the path (locked
 * architecture decision #3).
 *
 * Deliberate deviation from the CLAUDE.md interface: `ratePerMile` and
 * `mileageAllowance` are NOT persisted. The §E flat rate switches on
 * CUMULATIVE business miles for the tax year, so reclassifying any earlier
 * trip can change a later trip's rate — a persisted figure goes stale the
 * moment that happens (and rate corrections like the 2026 45p→55p catch
 * would strand wrong figures in storage). Both are derived on read via
 * `selectTripAllowances` in store.ts, which walks trips chronologically
 * through `calculateMileageAllowance` (src/tax — the single §E source).
 */

import type { TripVehicleType } from '../tax';
import type { TripGapCredit } from '../tracking/gapCredit';
import type { PathPoint } from './tripPath';

export type TripPurpose = 'business' | 'personal';

export interface TripEndpoint {
  lat: number;
  lng: number;
  /** Short place label from best-effort reverse geocoding ("Shooters Hill Rd").
   *  Absent when geocoding failed or the trip was recorded headless. */
  address?: string;
}

export interface Trip {
  id: string;
  /** Local-only, never uploaded — the auth uid this record was created/restored
   *  under (S142 uid guard; see Receipt.ownerUid). */
  ownerUid?: string;
  /** Unix ms. */
  startTime: number;
  /** Unix ms. */
  endTime: number;
  startLocation: TripEndpoint;
  endLocation: TripEndpoint;
  /** SDK odometer at trip end ÷ 1609.344. */
  distanceMiles: number;
  /**
   * ★ S147 — the road-matched gap credit (locked #3 AS AMENDED 2026-07-11):
   * distance GPS provably missed, recovered by road-matching between
   * high-confidence anchors at trip close. Stored as a SEPARATE auditable
   * component beside the odometer miles (guardrail 3) — `distanceMiles`
   * stays pure odometer, surfaces show "X mi + Y mi recovered", and §E
   * consumes `effectiveMiles(trip)`. The full per-gap audit trail rides
   * inside; only the capped scalar syncs (`gap_credit_miles`).
   */
  gapCredit?: TripGapCredit;
  /**
   * ★ S153 — the user endpoint correction (locked #3 extended, ruled
   * 2026-07-14): the user asserted the trip's true start/end (address search
   * or pin drag) and the claim adjusts by the SIGNED road-matched difference
   * — road(corrected → other anchor) − road(recorded → other anchor), Apple
   * MKDirections both terms, never straight-line. The machine may never
   * invent a start (S152); the user's word is final (§11.3 two-author
   * model). Same shape discipline as gapCredit: `distanceMiles` stays pure
   * odometer, only the signed scalar syncs (`user_adjust_miles`), the
   * per-end audit rides locally. §E consumes `effectiveMiles(trip)`.
   * Compliance: §E/§G/§H require accurate business-miles records only — no
   * original-vs-corrected forensics are mandated (checked 2026-07-14), so
   * the recorded anchor is kept for REVERT, not as an HMRC requirement.
   */
  userAdjust?: TripUserAdjust;
  /** null = unsorted (the To-sort queue). */
  purpose: TripPurpose | null;
  /**
   * §E vehicle class — drives the flat rate. `'car'` (cars + goods vehicles): 55p
   * first 10k cumulative miles then 25p. `'motorcycle'`: flat 24p, NO 10k switch
   * and never counted toward the car/van threshold (compliance_sources.md §E,
   * read 2026-06-29). There is no bicycle rate in simplified expenses. Additive +
   * optional — undefined means `'car'` everywhere (existing trips need no migration).
   */
  vehicleType?: TripVehicleType;
  /** `'core_motion'` = passive detection · `'manual'` = typed-in past trip ·
   *  `'manual_start'` (S152) = a user-initiated LIVE recording ("Record a trip
   *  now") — GPS/odometer identical to core_motion; the user asserting a real
   *  journey suppresses the rail auto-discard (§11.3, the two-author model). */
  detectionMethod: 'core_motion' | 'manual' | 'manual_start';
  /** S152: the user answered "It's my drive" on the live card's rail-thinking
   *  line — rail suspicion silenced for this trip. Local-only audit +
   *  calibration flag; never synced. */
  railOverridden?: boolean;
  /** S152: the station-stop detector fired on this trip (live, or on the kept
   *  piece's own span at close). A visible label ("Looks like a train
   *  journey") — NEVER an auto-discard (the adversarial ruling: ordinary
   *  drives on station-dense corridors fire the same prongs; S80 wins).
   *  Local-only; calibration gold once beta actions flow. */
  railSuspect?: boolean;
  /** ★ S213: the machine's own reason for railSuspect (the first firing
   *  prong's why-string). Powers the index-gap ledger signal — a Train answer
   *  whose railWhy shows no line-topology match flags a possible line-index
   *  blind spot in the diagnostic bundle. Local-only; never synced. */
  railWhy?: string;
  /** ★ S213: auto-classified personal by the usual-train-route memory (≥3 of
   *  the user's own consistent Train answers on this station pair). The gate
   *  does NOT ask; the row shows the quiet "usual train" line instead and the
   *  purpose toggle is the one-tap revert. Local-only; never synced. */
  railAutoTrain?: boolean;
  /** ★ S213 (Phase 1b route drawing): the driven path, simplified to
   *  ≤150 points at 1e-5° (src/trips/tripPath.ts) from the session trail at
   *  close. DISPLAY-ONLY — distance is always the SDK odometer (locked #3);
   *  never re-measure anything from this. Absent on manual entries, thin-trail
   *  recoveries and pre-S213 rows → the map falls back to pins-only. Syncs as
   *  `path_points` (jsonb [[lat,lng],…]) so the route survives a reinstall. */
  pathCoordinates?: PathPoint[];
  /** ★ S213 road-snapping (ruled: display-only inference is fine): absent =
   *  the recorded trace; 'road-matched' = pathCoordinates was routed along
   *  the road network (routeSnap.ts) on first view. Local-only, not synced —
   *  a restored trip simply re-snaps on its next view (self-healing). */
  pathSource?: 'road-matched';
  /** Tax year the trip was DRIVEN in (BIM75005 — the rate follows this). */
  taxYear: string;
  // ── Backup lifecycle (mirrors Job/Receipt). Trips sync as structured rows to the
  // `trips` table so they survive a reinstall AND fold into the records search
  // (mileage_tracking.md §9). Absent on trips made before sync existed → the
  // self-healing drain treats them as needs-upload. No Storage step (no media).
  syncStatus?: 'local' | 'uploading' | 'synced' | 'upload_failed';
  /** Unix ms the backup last succeeded. */
  syncedAt?: number;
  /** Last content edit, ms, any client — the sync spine's LWW authority (see
   *  Receipt.updatedAtMs). Absent on pre-spine records → rank at endTime. */
  updatedAtMs?: number;
  /** Future trip↔job link (maps Phase 2). Stored now so no re-migration is needed. */
  linkedJobId?: string;
}

/** One corrected endpoint — the local audit + revert record (S153). */
export interface TripEndpointCorrection {
  end: 'start' | 'end';
  /** The recorded anchor this correction replaced — "Undo" restores it. */
  recorded: TripEndpoint;
  /** SIGNED road-matched miles the correction adds to the claim. */
  deltaMiles: number;
  /** Unix ms the user applied it. */
  appliedAt: number;
}

/** S153 user endpoint correction — mirrors TripGapCredit's shape discipline. */
export interface TripUserAdjust {
  /** SIGNED total, miles — the ONLY value that syncs or feeds §E. */
  adjustMiles: number;
  /** Where the road distances came from ('apple-directions' | 'restored'). */
  source: string;
  /** Per-end audit + revert detail (local-only, like gapCredit.gaps). */
  corrections: TripEndpointCorrection[];
}

/**
 * The miles a trip claims under §E: odometer miles + the capped gap credit +
 * the signed user endpoint correction (floored at 0 — a correction can never
 * drive a claim negative). THE single accessor — every consumer that turns
 * distance into £ or totals (trip selectors, the tax estimate, the MTD pack,
 * the export workbook, the support digests) reads this, never
 * `distanceMiles + …` by hand, so the components can never drift apart
 * across surfaces.
 *
 * ★ S207 (BF-13 F4): a rail-shaped gap's credit is SUSPENDED
 * (gapCredit.suspendedMiles) and counts only once the user answered the
 * Train/Car gate with "Car" (railOverridden). Pure derivation — the answer
 * and its undo are both plain state flips, nothing is ever recomputed.
 */
export function effectiveMiles(
  trip: Pick<Trip, 'distanceMiles' | 'gapCredit' | 'userAdjust' | 'railOverridden'>,
): number {
  return Math.max(
    0,
    trip.distanceMiles +
      (trip.gapCredit?.gapCreditMiles ?? 0) +
      (trip.railOverridden ? (trip.gapCredit?.suspendedMiles ?? 0) : 0) +
      (trip.userAdjust?.adjustMiles ?? 0),
  );
}

/**
 * A trip currently being recorded, mirrored to MMKV so a JS/process reload
 * mid-drive (OOM kill + background relaunch, RN crash, dev Fast Refresh) cannot
 * lose it. The live event handlers (src/tracking/backgroundLocation.ts) hold the
 * authoritative in-memory copy; this is a throttled snapshot that the next init
 * recovers from (src/tracking/tripRecovery.ts). Without it, a reload nulls the
 * in-memory trip-start and the trip-end handler silently drops the trip even
 * though the SDK captured it natively.
 */
export interface InFlightTrip {
  /** Unix ms. */
  startTime: number;
  startLocation: TripEndpoint;
  /** Unix ms of the last snapshot — freshness for the recovery decision. */
  lastUpdate: number;
  /** SDK odometer (metres) at the last snapshot. */
  lastOdometerMetres: number;
  lastLocation: TripEndpoint;
  /** Accumulated classifier evidence (mirrors TripEvidence in tripClassifier). */
  activityCounts: Record<string, number>;
  maxSpeedMps: number;
  /**
   * ★ S148 (the live trip split): raw SDK odometer metres already persisted as
   * finished trips by an eager close THIS session — the odometer is NOT reset
   * mid-session, so every consumer that turns a raw odometer reading into this
   * trip's distance must subtract it (decideRecovery's snapshot close,
   * reconcileFinalDistance, the live keep-path close). Absent = 0 (no eager
   * close has run). Increment-based paths (segmentTrip over the truncated
   * trail / recovered window) need no subtraction — the consumed samples are
   * gone from their input.
   */
  consumedOdometerMetres?: number;
  // ── S152 Live Trip Card fields (all optional — pre-card mirrors need no
  // migration). These ride the MIRROR so a kill/relaunch reconstructs the
  // card's state, not just the trip (§11.3 "recovery reconciles").
  /** Minted at trip START (not close): the id the journey's FIRST kept piece
   *  persists under, the notification identifier, and the reconcile key that
   *  stops recovery/reopen creating sibling rows. */
  tripId?: string;
  /** User-initiated live recording ("Record a trip now"). */
  manualStart?: boolean;
  /** "It's my drive" tapped — rail suspicion silenced for this trip. */
  railOverride?: boolean;
  /** The live rail hint fired at least once this session — sticky, so the
   *  persisted row keeps its label even after walk samples dilute the trail
   *  (the adversarial pass's dilution finding). */
  railHintSeen?: boolean;
  /** ★ S214 (the live-card evidence gate — Jamie's ruling 2026-08-12:
   *  "Walking should not trigger a 'recording this trip' line"): sticky, set
   *  the first time the session produces vehicle evidence (one in_vehicle
   *  reading or one fix at probation speed — tripClassifier.hasVehicleEvidence,
   *  the probation exit's exact complement). The card/live surfaces render an
   *  auto session ONLY once this is set (manual starts never wait); a
   *  pedestrian session records silently and dies silently. Persisted so a
   *  reload keeps the card's state; absent on pre-S214 mirrors → the session
   *  re-earns it from fresh evidence within seconds of real driving. */
  vehicleEvidence?: boolean;
  /** "Ignore this journey" tapped — the session keeps recording (cheap, and
   *  undo stays trivial) but the close persists NOTHING. */
  ignored?: boolean;
  /** ★ S213: "Train" answered on the LIVE gate (Jamie's ruling 2026-08-11:
   *  mark-and-keep-recording — killing GPS mid-train just re-promotes at the
   *  next station stop and mints a junk second trip). Rides WITH `ignored`
   *  (the close persists nothing, same as Ignore); this flag routes the
   *  close's ledger entry to the train verdict and writes the rail chain
   *  context. Cleared by the same un-ignore undo. */
  trainConfirmed?: boolean;
  /** persistTrip THREW at close — the mirror is now the trip's only copy,
   *  held for next-init recovery. The card must NOT render this as a live
   *  session (adversarial pass 2026-07-13: a zombie card's Ignore tap made
   *  recovery destroy the only surviving copy). */
  persistFailed?: boolean;
  /** Set when this session REOPENED a just-closed trip (started within
   *  SPLIT_TRIP_GAP_MS of its auto-close): the close MERGES into that row via
   *  updateTrip instead of adding a sibling. */
  reopenOfTripId?: string;
}

/**
 * S152: the reopen memo — written when a session auto-closes, consulted by the
 * NEXT promotion. Driving resumed within SPLIT_TRIP_GAP_MS of `endTime` (and
 * the close was NOT a manual Finish — the user's word is final) → the new
 * session continues the same trip: one card, one classification, one row.
 * Persisted (MMKV) so a relaunch inside the window still reopens.
 */
export interface LastClosedTripMemo {
  tripId: string;
  /** Unix ms of the persisted trip's end (last movement, not close time). */
  endTime: number;
  /** A manual Finish never reopens. */
  manualFinish: boolean;
  /** Where the trip ended (S191) — the rail-shaped-reopen veto's geography.
   *  Optional: memos persisted before S191 lack it → no veto, the old
   *  behaviour. */
  endLat?: number;
  endLng?: number;
}
