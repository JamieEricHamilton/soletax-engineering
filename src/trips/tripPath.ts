/**
 * Trip path simplification (S213 — the Phase 1b route drawing).
 *
 * A trip's driven path persists as `Trip.pathCoordinates`: the session trail
 * simplified with Douglas-Peucker to ≤ MAX_PATH_POINTS and rounded to 1e-5°
 * (~1 m), so a two-hour drive stays a few KB in MMKV and in the synced
 * `path_points` column. DISPLAY-ONLY — distance is always the SDK odometer
 * (locked decision #3); nothing may ever be re-measured from this path.
 */

export interface PathPoint {
  lat: number;
  lng: number;
}

export const MAX_PATH_POINTS = 150;

/** Consecutive path points further apart than this draw as SEPARATE polyline
 *  segments — a straight chord across an untracked pause (reopen/Continue
 *  merge) or a long GPS blackout would read as a route we recorded. */
export const PATH_SEGMENT_BREAK_M = 2000;

const M_PER_DEG_LAT = 111_320;

function hopMetres(a: PathPoint, b: PathPoint): number {
  return Math.hypot(
    (b.lat - a.lat) * M_PER_DEG_LAT,
    (b.lng - a.lng) * M_PER_DEG_LAT * Math.cos((a.lat * Math.PI) / 180),
  );
}

/** Perpendicular distance (metres) from `p` to the segment a→b, on the local
 *  equirectangular plane — exact enough at trip scale for a display tolerance. */
function perpDistM(p: PathPoint, a: PathPoint, b: PathPoint): number {
  const cosLat = Math.cos((a.lat * Math.PI) / 180);
  const ax = a.lng * M_PER_DEG_LAT * cosLat;
  const ay = a.lat * M_PER_DEG_LAT;
  const bx = b.lng * M_PER_DEG_LAT * cosLat;
  const by = b.lat * M_PER_DEG_LAT;
  const px = p.lng * M_PER_DEG_LAT * cosLat;
  const py = p.lat * M_PER_DEG_LAT;
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function douglasPeucker(points: PathPoint[], toleranceM: number): PathPoint[] {
  if (points.length <= 2) return points;
  const keep = new Array<boolean>(points.length).fill(false);
  keep[0] = keep[points.length - 1] = true;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [lo, hi] = stack.pop()!;
    let maxD = 0;
    let maxI = -1;
    for (let i = lo + 1; i < hi; i++) {
      const d = perpDistM(points[i], points[lo], points[hi]);
      if (d > maxD) {
        maxD = d;
        maxI = i;
      }
    }
    if (maxI !== -1 && maxD > toleranceM) {
      keep[maxI] = true;
      stack.push([lo, maxI], [maxI, hi]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/**
 * Simplify a driven trail to a persistable path: dedupe → Douglas-Peucker at
 * 12 m display tolerance, tolerance doubling until the result fits
 * `maxPoints` → round 1e-5. Fewer than 2 usable points → [] (no path;
 * consumers fall back to pins-only).
 */
export function simplifyPath(
  samples: readonly { lat: number; lng: number }[],
  maxPoints: number = MAX_PATH_POINTS,
): PathPoint[] {
  const deduped: PathPoint[] = [];
  for (const s of samples) {
    if (!Number.isFinite(s.lat) || !Number.isFinite(s.lng)) continue;
    const prev = deduped[deduped.length - 1];
    if (prev && prev.lat === s.lat && prev.lng === s.lng) continue;
    deduped.push({ lat: s.lat, lng: s.lng });
  }
  if (deduped.length < 2) return [];
  let toleranceM = 12;
  let out = douglasPeucker(deduped, toleranceM);
  while (out.length > maxPoints && toleranceM < 100_000) {
    toleranceM *= 2;
    out = douglasPeucker(deduped, toleranceM);
  }
  const rounded = out.map((p) => ({
    lat: Math.round(p.lat * 1e5) / 1e5,
    lng: Math.round(p.lng * 1e5) / 1e5,
  }));
  // Rounding can collapse near-neighbours onto one coordinate — dedupe again.
  return rounded.filter(
    (p, i) => i === 0 || p.lat !== rounded[i - 1].lat || p.lng !== rounded[i - 1].lng,
  );
}

/**
 * Split a path into drawable segments at untracked jumps (> PATH_SEGMENT_BREAK_M
 * between consecutive points): a reopen/Continue pause or a GPS blackout must
 * never draw as a road we recorded. Segments shorter than 2 points drop.
 */
export function pathSegments(points: readonly PathPoint[]): PathPoint[][] {
  const segments: PathPoint[][] = [];
  let current: PathPoint[] = [];
  for (const p of points) {
    const prev = current[current.length - 1];
    if (prev && hopMetres(prev, p) > PATH_SEGMENT_BREAK_M) {
      if (current.length >= 2) segments.push(current);
      current = [];
    }
    current.push(p);
  }
  if (current.length >= 2) segments.push(current);
  return segments;
}
