/**
 * _ref-beneficial.ts — ONE independently-coded reference for the 2026-27 BENEFICIAL
 * Personal-Allowance allocation (ITA 2007 s25(2): deduct the PA "in the way which
 * will result in the greatest reduction in the taxpayer's liability").
 *
 * Shared by test-tax-harness.ts and test-tax-fuzz.ts so there is exactly ONE
 * beneficial reference, not a re-derivation in each. It holds only the allocation
 * LOGIC and the band-stacking maths — NEVER a tax constant: every rate, limit and
 * allowance is INJECTED by the caller (each caller restates them from the compliance
 * register), so the differential cross-check against src/tax/engine.ts stays honest.
 *
 * Independence note: the breakpoint search below deliberately mirrors the engine's
 * candidate construction and tie-break (start from the fixed non-savings-first split;
 * only a STRICT improvement replaces it) so that, where the tax-minimising split is
 * non-unique, the reference reports the SAME component breakdown the engine reports —
 * otherwise a flat optimum would trip the per-component differential with both sides
 * correct. Optimality itself (that this search finds the true minimum) is NOT taken on
 * trust: refAllocateExhaustive — a true £1 brute force with no vertex logic — is the
 * ground truth, and the harness asserts refAllocate == refAllocateExhaustive. The
 * engine carries its own exhaustive guard in test-tax-engine.ts.
 *
 * From 2027-28 the law switches to a fixed order (ITA 2007 s25(3A), FA 2025) — when
 * that year is added, the reference for it is just `fixedSplit`.
 */

export interface RefRates {
  schedule: [number, number][]; // national bands [upToTaxable, rate], Infinity-terminated, EXTENDED by any §V band-extension
  nationEdges: number[]; // UN-extended national band edges — candidate positions (matches the engine's candidate set)
  ukBasic: number; // EXTENDED UK basic-rate limit (37,700 + ext)
  ukHigher: number; // EXTENDED UK higher-rate limit (125,140 + ext)
  savRates: [number, number, number]; // savings basic/higher/additional
  divRates: [number, number, number]; // dividend ordinary/upper/additional
  divAllowance: number; // £500 @ 0%, consumes band space
  startingRateBand: number; // £5,000 starting rate for savings
  psaBasic: number;
  psaHigher: number;
  psaAdditional: number;
}

export interface RefSplit {
  tNs: number; // taxable non-savings/non-dividend income
  tSav: number; // taxable savings interest
  tDiv: number; // taxable dividends
}

export interface RefParts {
  nsTax: number;
  savTax: number;
  divTax: number;
  total: number;
}

/** Income tax for an EXPLICIT taxable split (the three amounts already net of their
 *  PA allocation). Stacks non-savings → savings (§T) → dividends (§S, top); savings
 *  and dividends use UK rates at the (extended) UK limits for ALL nations. The PSA is
 *  set by the top rate reached on the TOTAL taxable (invariant across allocations). */
export function refTaxForSplit(s: RefSplit, r: RefRates): RefParts {
  const totalTaxable = s.tNs + s.tSav + s.tDiv;

  // Non-savings at the nation's (extended) bands.
  let nsTax = 0;
  let lower = 0;
  for (const [lim, rate] of r.schedule) {
    if (s.tNs <= lower) break;
    nsTax += (Math.min(s.tNs, lim) - lower) * rate;
    lower = lim;
  }

  // Savings (middle slice): 0% starting-rate band (shrunk £1/£1 by non-savings
  // taxable), then 0% PSA, then UK savings rates at UK limits.
  const psa = totalTaxable > r.ukHigher ? r.psaAdditional : totalTaxable > r.ukBasic ? r.psaHigher : r.psaBasic;
  const sr = Math.max(0, r.startingRateBand - s.tNs);
  let savTax = 0;
  let pos = s.tNs;
  let rem = s.tSav;
  {
    const a = Math.min(rem, sr);
    pos += a;
    rem -= a;
  }
  {
    const a = Math.min(rem, psa);
    pos += a;
    rem -= a;
  }
  for (const [lim, rate] of [[r.ukBasic, r.savRates[0]], [r.ukHigher, r.savRates[1]], [Infinity, r.savRates[2]]] as [number, number][]) {
    if (rem <= 0) break;
    if (pos >= lim) continue;
    const a = Math.min(rem, lim - pos);
    savTax += a * rate;
    pos += a;
    rem -= a;
  }

  // Dividends (top slice): £500 allowance @ 0% (still advances the band position),
  // then UK dividend rates at UK limits.
  let divTax = 0;
  let dpos = s.tNs + s.tSav;
  let drem = s.tDiv;
  {
    const a = Math.min(drem, r.divAllowance);
    dpos += a;
    drem -= a;
  }
  for (const [lim, rate] of [[r.ukBasic, r.divRates[0]], [r.ukHigher, r.divRates[1]], [Infinity, r.divRates[2]]] as [number, number][]) {
    if (drem <= 0) break;
    if (dpos >= lim) continue;
    const a = Math.min(drem, lim - dpos);
    divTax += a * rate;
    dpos += a;
    drem -= a;
  }

  return { nsTax, savTax, divTax, total: nsTax + savTax + divTax };
}

/** The fixed non-savings → savings → dividends PA split (the 2027-28 rule; also the
 *  baseline beneficial candidate and the only behaviour with no investment income). */
export function fixedSplit(nonSav: number, savings: number, dividends: number, allowance: number): RefSplit {
  const aNs = Math.min(allowance, nonSav);
  const aSav = Math.min(allowance - aNs, savings);
  const aDiv = Math.min(allowance - aNs - aSav, dividends);
  return { tNs: nonSav - aNs, tSav: savings - aSav, tDiv: dividends - aDiv };
}

/** Beneficial allocation (2026-27): split the fixed-size PA across the three income
 *  types to MINIMISE tax. Breakpoint search — the tax is piecewise-linear in the
 *  split so the minimum is at a vertex where two type-boundaries sit on a band/nil-band
 *  edge; pin every pair and derive the third. Proven == refAllocateExhaustive. */
export function refAllocate(nonSav: number, savings: number, dividends: number, allowance: number, r: RefRates): RefSplit {
  const fixed = fixedSplit(nonSav, savings, dividends, allowance);
  if (savings <= 0 && dividends <= 0) return fixed;

  const T = Math.max(0, nonSav + savings + dividends - allowance);
  const nsCand = [
    0, Math.min(nonSav, T), Math.max(0, T - savings - dividends),
    r.startingRateBand, r.ukBasic, r.ukHigher, ...r.nationEdges,
  ];
  const savCaps = [0, savings, r.psaBasic, r.psaHigher, r.startingRateBand, r.startingRateBand + r.psaBasic];
  const divCaps = [0, r.divAllowance, dividends];

  let best = fixed;
  let bestTax = refTaxForSplit(fixed, r).total;
  const consider = (tNs: number, tSav: number, tDiv: number) => {
    if (tNs < -1e-9 || tSav < -1e-9 || tDiv < -1e-9) return;
    if (tNs > nonSav + 1e-9 || tSav > savings + 1e-9 || tDiv > dividends + 1e-9) return;
    if (Math.abs(tNs + tSav + tDiv - T) > 1e-6) return;
    const split = { tNs: Math.max(0, tNs), tSav: Math.max(0, tSav), tDiv: Math.max(0, tDiv) };
    const t = refTaxForSplit(split, r).total;
    if (t < bestTax - 1e-9) {
      bestTax = t;
      best = split;
    }
  };
  for (const ns of nsCand) for (const sav of savCaps) consider(ns, sav, T - ns - sav);
  for (const sav of savCaps) for (const div of divCaps) consider(T - sav - div, sav, div);
  for (const ns of nsCand) for (const div of divCaps) consider(ns, T - ns - div, div);
  return best;
}

/** Ground truth: the true £1 exhaustive optimum over the PA shield distribution. No
 *  vertex logic — a brute force — so a "missed vertex" bug in refAllocate (or the
 *  engine) shows up as a disagreement. O(savings × dividends): SMALL grids only. */
export function refAllocateExhaustive(nonSav: number, savings: number, dividends: number, allowance: number, r: RefRates): RefSplit {
  const total = nonSav + savings + dividends;
  const U = Math.min(allowance, total); // PA actually used
  let best = fixedSplit(nonSav, savings, dividends, allowance);
  let bestTax = refTaxForSplit(best, r).total;
  const maxShDiv = Math.min(U, dividends);
  for (let shDiv = 0; shDiv <= maxShDiv; shDiv++) {
    const maxShSav = Math.min(U - shDiv, savings);
    for (let shSav = 0; shSav <= maxShSav; shSav++) {
      const shNs = U - shDiv - shSav;
      if (shNs < 0 || shNs > nonSav) continue;
      const split = { tNs: nonSav - shNs, tSav: savings - shSav, tDiv: dividends - shDiv };
      const t = refTaxForSplit(split, r).total;
      if (t < bestTax - 1e-9) {
        bestTax = t;
        best = split;
      }
    }
  }
  return best;
}
