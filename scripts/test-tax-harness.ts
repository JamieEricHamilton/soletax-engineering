/**
 * test-tax-harness.ts — hardened, INDEPENDENT verification of the tax engine.
 *
 * WHY THIS EXISTS (2026-06-20): the band-ceiling bug — additional rate started
 * at £112,570 instead of £125,140 of taxable income — survived because the
 * worked examples in test-tax-engine.ts were hand-derived with the SAME wrong
 * mental model as the code. A test computed from the code's own logic confirms
 * the code instead of checking it. This harness removes that blind spot with
 * four independent layers, none of which trusts the engine's own derivation:
 *
 *   1. DIFFERENTIAL — two reference income-tax calculators in deliberately
 *      different shapes (analytic band slabs + a £1 marginal integrator), each
 *      restating the bands from gov.uk / Hardman's ¶3-000A/B — NOT importing the
 *      engine's constants. A placement bug must be made identically in three
 *      different algorithms to survive, swept across every £ from 0 to 200k.
 *   2. BOUNDARY-COMPLETE — every threshold tested at {just below, at, just above}.
 *   3. INVARIANTS — properties true for ANY input: monotonic, marginal rate
 *      bounded, no 45%/48% before £125,140 taxable, bands reconcile to totals.
 *   4. EXTERNAL ANCHORS — points confirmed against an independent public
 *      calculator (listentotaxman), tying the references to ground truth.
 *
 * If the engine and a reference disagree, ONE of them is wrong — investigate,
 * don't pick. (That is how income-tax.co.uk's £44,460 was caught as a bad oracle
 * vs listentotaxman + legislation's £44,703.)
 *
 * Run: npx tsx scripts/test-tax-harness.ts   (part of npm run test:tax)
 */

import { calculateTaxEstimate, type TaxEstimate, type UKNation } from '../src/tax';
import { incomeTaxOn } from '../src/tax/engine';
import { refAllocate, refAllocateExhaustive, refTaxForSplit, type RefRates } from './_ref-beneficial';

let failures = 0;
let checks = 0;
const EPS = 0.005; // half a penny — float tolerance only

function check(name: string, actual: number | string | boolean, expected: number | string | boolean) {
  checks++;
  const ok =
    typeof actual === 'number' && typeof expected === 'number'
      ? Math.abs(actual - expected) < EPS
      : actual === expected;
  if (!ok) {
    failures++;
    console.error(`  ✗ ${name}: expected ${expected}, got ${actual}`);
  }
}

function assert(name: string, condition: boolean, detail = '') {
  checks++;
  if (!condition) {
    failures++;
    console.error(`  ✗ ${name}${detail ? ': ' + detail : ''}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// INDEPENDENT references — bands RESTATED from gov.uk Income Tax / Scottish
// Income Tax + Hardman's ¶3-000A/B (TAXABLE-income bands). Deliberately not
// imported from rates-2026-27.ts, so a wrong engine constant shows up here as a
// DISAGREEMENT rather than a shared blind spot.
// ─────────────────────────────────────────────────────────────────────────────
type Slab = { upToTaxable: number; rate: number };
const REF_RUK: Slab[] = [
  { upToTaxable: 37_700, rate: 0.2 },
  { upToTaxable: 125_140, rate: 0.4 }, // higher-rate LIMIT = £125,140 of TAXABLE income
  { upToTaxable: Infinity, rate: 0.45 },
];
const REF_SCOT: Slab[] = [
  { upToTaxable: 3_967, rate: 0.19 },
  { upToTaxable: 16_956, rate: 0.2 },
  { upToTaxable: 31_092, rate: 0.21 },
  { upToTaxable: 62_430, rate: 0.42 },
  { upToTaxable: 125_140, rate: 0.45 }, // advanced→top boundary = £125,140 TAXABLE
  { upToTaxable: Infinity, rate: 0.48 },
];
const refSchedule = (nation: UKNation): Slab[] => (nation === 'scotland' ? REF_SCOT : REF_RUK);

const refPersonalAllowance = (total: number): number =>
  // ITA 2007 s35(3): the tapered allowance is rounded UP to the nearest whole £1.
  Math.ceil(Math.max(0, 12_570 - Math.max(0, total - 100_000) / 2));

// ─────────────────────────────────────────────────────────────────────────────
// Investment-income constants — RESTATED from gov.uk/tax-on-dividends (§S),
// gov.uk savings rules (§T) + Hardman's; NOT imported from the engine. Shared by
// the §5 (dividends) and §6 (savings) sections and by the beneficial-allocation
// reference (ITA 2007 s25(2)). The UK taxable limits (37,700 / 125,140) position
// savings AND dividends for ALL nations, including Scotland.
// ─────────────────────────────────────────────────────────────────────────────
const DIV_ALLOWANCE = 500;
const DIV_RATES = { ordinary: 0.1075, upper: 0.3575, additional: 0.3935 };
const DIV_LIMITS = { ordinaryUpTo: 37_700, upperUpTo: 125_140 };
const PSA = { basic: 1_000, higher: 500, additional: 0 };
const STARTING_RATE_BAND = 5_000;
const SAV_RATES = { basic: 0.2, higher: 0.4, additional: 0.45 };

/** Build the rate bundle the beneficial reference needs, for a nation. The §5/§6
 *  sweeps carry no pension (ext = 0); `ext` lets the allocation validation also cover
 *  the §V band-extension regime the fuzz exercises (the 20% band and everything above
 *  it widen by the grossed-up contribution; Scotland's 19% starter band is untouched). */
function refRates(nation: UKNation, ext = 0): RefRates {
  const schedule = refSchedule(nation).map((s): [number, number] => [s.upToTaxable, s.rate]);
  const basicIdx = schedule.findIndex(([, r]) => r >= SAV_RATES.basic - 1e-9);
  return {
    schedule: schedule.map(([lim, r], i): [number, number] => (i >= basicIdx && Number.isFinite(lim) ? [lim + ext, r] : [lim, r])),
    nationEdges: refSchedule(nation).map((s) => s.upToTaxable).filter(Number.isFinite),
    ukBasic: DIV_LIMITS.ordinaryUpTo + ext,
    ukHigher: DIV_LIMITS.upperUpTo + ext,
    savRates: [SAV_RATES.basic, SAV_RATES.higher, SAV_RATES.additional],
    divRates: [DIV_RATES.ordinary, DIV_RATES.upper, DIV_RATES.additional],
    divAllowance: DIV_ALLOWANCE,
    startingRateBand: STARTING_RATE_BAND,
    psaBasic: PSA.basic,
    psaHigher: PSA.higher,
    psaAdditional: PSA.additional,
  };
}

/** Component income taxes (non-savings / savings / dividends) under the 2026-27
 *  BENEFICIAL PA allocation — the engine-independent reference used by §5/§6. */
function refComponents(nonSav: number, savings: number, dividends: number, nation: UKNation) {
  const r = refRates(nation);
  const allowance = refPersonalAllowance(nonSav + savings + dividends);
  return refTaxForSplit(refAllocate(nonSav, savings, dividends, allowance, r), r);
}

/** Reference A — analytic band slabs (subtractive). */
function refIncomeTaxAnalytic(total: number, nation: UKNation): number {
  const taxable = Math.max(0, total - refPersonalAllowance(total));
  let tax = 0;
  let lower = 0;
  for (const s of refSchedule(nation)) {
    if (taxable <= lower) break;
    tax += (Math.min(taxable, s.upToTaxable) - lower) * s.rate;
    lower = s.upToTaxable;
  }
  return tax;
}

/** Reference B — £1 marginal integrator. A different algorithm: the rate is a
 *  function of taxable-income-so-far, summed pound by pound. Exact at integer
 *  taxable amounts; used only at spot points (it is O(taxable)). */
function marginalRate(taxableSoFar: number, nation: UKNation): number {
  for (const s of refSchedule(nation)) if (taxableSoFar < s.upToTaxable) return s.rate;
  return refSchedule(nation)[refSchedule(nation).length - 1].rate;
}
function refIncomeTaxStepwise(total: number, nation: UKNation): number {
  const taxable = Math.max(0, total - refPersonalAllowance(total));
  let tax = 0;
  for (let x = 0; x < taxable; x += 1) tax += Math.min(1, taxable - x) * marginalRate(x, nation);
  return tax;
}

const NATIONS: UKNation[] = ['england-wales-ni', 'scotland'];
const engineIncomeTax = (total: number, nation: UKNation) => incomeTaxOn(total, nation).tax;

console.log('Tax engine HARDENED harness — differential + boundary + invariants + anchors\n');

// ─────────────────────────────────────────────────────────────────────────────
// 0. The two references must agree with EACH OTHER (different algorithms) — if
//    they don't, the harness itself is untrustworthy.
// ─────────────────────────────────────────────────────────────────────────────
for (const nation of NATIONS) {
  for (const total of [0, 12_570, 30_000, 50_270, 75_000, 100_000, 125_140, 130_000, 180_000]) {
    check(
      `0 references agree · ${nation} · £${total}`,
      refIncomeTaxAnalytic(total, nation),
      refIncomeTaxStepwise(total, nation),
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 0a. The beneficial PA allocation (ITA 2007 s25(2)) used by the §5/§6 references
//     must find the TRUE minimum. refAllocate is a fast breakpoint search; validate
//     its tax against refAllocateExhaustive — a £1 brute force with NO vertex logic —
//     so a "missed vertex" bug (the one the engine hit in S75) can't hide in the
//     reference. Both nations, with and without a §V band extension. Small grids so
//     the O(savings × dividends) exhaustive stays fast.
// ─────────────────────────────────────────────────────────────────────────────
{
  const nsVals = [0, 12_570, 30_000, 45_000, 50_000, 90_000, 120_000];
  const savVals = [0, 200, 1_000, 2_000];
  const divVals = [0, 500, 2_000, 6_000];
  const extVals = [0, 8_000];
  let allocMis = 0;
  let allocChecks = 0;
  for (const nation of NATIONS)
    for (const ns of nsVals)
      for (const sav of savVals)
        for (const div of divVals)
          for (const ext of extVals) {
            if (sav === 0 && div === 0) continue;
            const r = refRates(nation, ext);
            const allowance = refPersonalAllowance(ns + sav + div - ext);
            const fast = refTaxForSplit(refAllocate(ns, sav, div, allowance, r), r).total;
            const exhaustive = refTaxForSplit(refAllocateExhaustive(ns, sav, div, allowance, r), r).total;
            allocChecks++;
            if (Math.abs(fast - exhaustive) >= EPS) allocMis++;
          }
  assert(`0a beneficial reference == £1 exhaustive optimum (${allocChecks} cases, both nations ± band-extension)`, allocMis === 0, `${allocMis} mismatches`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. DIFFERENTIAL — engine income tax vs the independent analytic reference,
//    swept £0→£200,000. Coarse grid everywhere + dense ±3 around every band
//    edge, PA start, and the taper window. This is what catches a wrong ceiling.
// ─────────────────────────────────────────────────────────────────────────────
const BAND_EDGES = [
  0, 1, 12_570, 16_537, 29_526, 43_662, 50_270, 75_000, 100_000, 125_140, 137_710,
];
const sweep = new Set<number>();
for (let i = 0; i <= 200_000; i += 250) sweep.add(i);
for (const edge of BAND_EDGES) for (let d = -3; d <= 3; d++) if (edge + d >= 0) sweep.add(edge + d);
const sweepPoints = [...sweep].sort((a, b) => a - b);

for (const nation of NATIONS) {
  let mismatches = 0;
  for (const total of sweepPoints) {
    if (Math.abs(engineIncomeTax(total, nation) - refIncomeTaxAnalytic(total, nation)) >= EPS) {
      mismatches++;
      if (mismatches <= 3) {
        console.error(
          `  ✗ 1 differential · ${nation} · £${total}: engine ${engineIncomeTax(total, nation).toFixed(2)} vs ref ${refIncomeTaxAnalytic(total, nation).toFixed(2)}`,
        );
      }
    }
  }
  assert(`1 differential sweep · ${nation} (${sweepPoints.length} points)`, mismatches === 0, `${mismatches} mismatches`);
}

// Stepwise (third algorithm) cross-check at the boundary-critical points.
for (const nation of NATIONS) {
  for (const total of [49_999, 50_270, 50_271, 124_999, 125_140, 125_141, 130_000, 160_000]) {
    check(`1 stepwise xcheck · ${nation} · £${total}`, engineIncomeTax(total, nation), refIncomeTaxStepwise(total, nation));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. EXTERNAL ANCHORS — independently confirmed against a public calculator.
// ─────────────────────────────────────────────────────────────────────────────
// rUK £130,000 → £44,703 IT. Verified 2026-06-20 vs listentotaxman (45% on
// £4,860 = £2,187); legislation (ITA 2007) + Hardman's ¶3-000A agree.
// income-tax.co.uk gave £44,460 — itself a taper-zone bug; NOT used as an oracle.
check('2 anchor · rUK £130k IT (listentotaxman £44,703)', engineIncomeTax(130_000, 'england-wales-ni'), 44_703);
check('2 anchor · reference matches the external anchor too', refIncomeTaxAnalytic(130_000, 'england-wales-ni'), 44_703);
// Scotland £130,000 → £50,034.35 — same £125,140 TAXABLE advanced→top boundary
// (Hardman's ¶3-000B), the externally-confirmed boundary applied to Scottish rates.
check('2 anchor · Scotland £130k IT (Hardman’s ¶3-000B boundary)', engineIncomeTax(130_000, 'scotland'), 50_034.35);

// ─────────────────────────────────────────────────────────────────────────────
// 3. INVARIANTS — must hold for ANY income. Catch a different class of bug than
//    the differential (discontinuities, non-monotonicity, mis-placed top rates).
// ─────────────────────────────────────────────────────────────────────────────
for (const nation of NATIONS) {
  // 3a. No 45%/48% top-band tax charged at or below £125,140 of TAXABLE income.
  //     (This invariant alone would have caught the original bug.)
  let earlyTop = 0;
  for (let total = 0; total <= 200_000; total += 137) {
    const { taxable, lines } = incomeTaxOn(total, nation);
    const topRate = nation === 'scotland' ? 0.48 : 0.45;
    const topAmount = lines.filter((l) => l.rate === topRate).reduce((s, l) => s + l.amount, 0);
    if (taxable <= 125_140 + EPS && topAmount > EPS) earlyTop++;
  }
  assert(`3a no top rate ≤ £125,140 taxable · ${nation}`, earlyTop === 0, `${earlyTop} violations`);

  // 3b. Monotonic + bounded marginal: income tax never falls as income rises, and a
  //     single £1 adds at most 90p. The economic taper marginal is 67.5% (Scotland),
  //     but ITA 2007 s35(3) rounds the tapered Personal Allowance UP to a whole £1, so
  //     in the £100k–125,140 zone one extra £1 of income can ALSO shed up to £1 of
  //     allowance on the rounding step — an instantaneous marginal of up to 2× the
  //     band rate (Scotland advanced 45% → 90p). This is legitimate, not a band bug;
  //     the precise band placement is guaranteed by the differential sweep above.
  let lastTax = 0;
  let monoViol = 0;
  let marginViol = 0;
  for (let total = 0; total <= 200_000; total += 1) {
    const t = engineIncomeTax(total, nation);
    if (t < lastTax - EPS) monoViol++;
    if (t - lastTax > 0.90 + EPS) marginViol++;
    lastTax = t;
  }
  assert(`3b income tax monotonic · ${nation}`, monoViol === 0, `${monoViol} decreases`);
  assert(`3b marginal IT ≤ 90p/£1 incl. s35(3) PA-rounding step (no jumps) · ${nation}`, marginViol === 0, `${marginViol} jumps`);

  // 3c. Band lines reconcile to the tax total at every point.
  let reconViol = 0;
  for (let total = 0; total <= 200_000; total += 311) {
    const { lines, tax } = incomeTaxOn(total, nation);
    if (Math.abs(lines.reduce((s, l) => s + l.tax, 0) - tax) >= EPS) reconViol++;
  }
  assert(`3c IT band lines reconcile · ${nation}`, reconViol === 0, `${reconViol} mismatches`);
}

// 3d. Full-estimate invariants over a profit sweep (no other income).
for (const nation of NATIONS) {
  let neg = 0;
  let estReconViol = 0;
  let estMono = 0;
  let lastOwed = 0;
  for (let income = 0; income <= 200_000; income += 250) {
    const e = calculateTaxEstimate({ taxYear: '2026-27', nation, incomeReceived: income, deductibleExpenses: 0 });
    if ([e.incomeTax, e.class4Nic, e.taxableProfit, e.totalTax, e.totalOwed, e.balancingPayment].some((v) => v < -EPS)) neg++;
    if (Math.abs(e.incomeTaxBands.reduce((s, l) => s + l.tax, 0) - e.incomeTax) >= EPS) estReconViol++;
    if (Math.abs(e.class4Bands.reduce((s, l) => s + l.tax, 0) - e.class4Nic) >= EPS) estReconViol++;
    if (Math.abs(e.incomeTax + e.class4Nic - e.totalTax) >= EPS) estReconViol++;
    if (e.totalOwed < lastOwed - EPS) estMono++;
    lastOwed = e.totalOwed;
  }
  assert(`3d estimate fields non-negative · ${nation}`, neg === 0, `${neg} negatives`);
  assert(`3d estimate bands reconcile · ${nation}`, estReconViol === 0, `${estReconViol} mismatches`);
  assert(`3d total owed monotonic in profit · ${nation}`, estMono === 0, `${estMono} decreases`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. BOUNDARY-COMPLETE — the other thresholds at {below, at, above}. These guard
//    the components the differential reference doesn't cover (NIC, Class 2, POA).
// ─────────────────────────────────────────────────────────────────────────────
const est = (incomeReceived: number, extra: Partial<Parameters<typeof calculateTaxEstimate>[0]> = {}): TaxEstimate =>
  calculateTaxEstimate({ taxYear: '2026-27', nation: 'england-wales-ni', incomeReceived, deductibleExpenses: 0, ...extra });
// taxable profit EXACTLY P: £1,000 expenses ≥ the trading allowance, so the
// engine keeps the expenses and does NOT swap in the £1,000 allowance (which
// would otherwise shift profit by £1,000 — the trap that made the first draft of
// these boundary expectations wrong; the engine was right, the inputs were naive).
const profitEst = (P: number): TaxEstimate =>
  calculateTaxEstimate({ taxYear: '2026-27', nation: 'england-wales-ni', incomeReceived: P + 1_000, deductibleExpenses: 1_000 });
check('4 profitEst sets taxable profit exactly', profitEst(40_000).taxableProfit, 40_000);

// Class 4 lower limit £12,570 (on PROFIT directly): nothing at/below, 6% above.
check('4 C4 · profit £12,570 (at) = 0', profitEst(12_570).class4Nic, 0);
check('4 C4 · profit £12,571 (above) = 6% of £1', profitEst(12_571).class4Nic, 0.06);
// Class 4 upper limit £50,270: main rate up to here, 2% above.
check('4 C4 · profit £50,270 (at) main only', profitEst(50_270).class4Nic, (50_270 - 12_570) * 0.06);
check('4 C4 · profit £50,271 (above) adds 2%', profitEst(50_271).class4Nic, (50_270 - 12_570) * 0.06 + 0.02);
// Class 2 small-profits threshold £7,105.
check('4 C2 · profit £7,104 (below) voluntary', profitEst(7_104).class2Status, 'below-threshold-voluntary');
check('4 C2 · profit £7,105 (at) treated-as-paid', profitEst(7_105).class2Status, 'treated-as-paid');
// Trading allowance £1,000 — the better-deduction choice flips at expenses = £1,000.
check('4 trading allowance · expenses £999 → allowance wins', est(30_000, { deductibleExpenses: 999 }).deductionBasis, 'trading-allowance');
check('4 trading allowance · expenses £1,001 → expenses win', est(30_000, { deductibleExpenses: 1_001 }).deductionBasis, 'expenses');
// PA taper end: taxable profit £125,140 → PA exactly 0; £125,138 → PA just above 0.
check('4 PA taper · profit £125,140 (at) → PA 0', profitEst(125_140).personalAllowance, 0);
assert('4 PA taper · profit £125,138 (below) → PA > 0', profitEst(125_138).personalAllowance > 0);

// POA £1,000 de-minimis on the relevant amount (IT + Class 4, net of CIS).
const poaLow = profitEst(16_000); // bill ≈ £891.80 (< £1,000) → no POA
const poaHigh = profitEst(40_000); // bill ≈ £7,131.80 → POA required
assert('4 POA · small bill (<£1,000) not required', poaLow.totalTax < 1_000 && poaLow.paymentsOnAccount.required === false);
assert('4 POA · large bill required', poaHigh.paymentsOnAccount.required === true);
check('4 POA · instalment = half the relevant amount', poaHigh.paymentsOnAccount.each, poaHigh.totalTax / 2);

// ─────────────────────────────────────────────────────────────────────────────
// 5. DIVIDENDS (§S) — independent references + differential sweep + gov.uk anchor
//    + invariants. Same four-layer discipline applied to the new calc from line 1.
// ─────────────────────────────────────────────────────────────────────────────
// Dividend constants + the beneficial reference now live at the top of the file
// (shared with §6). Under the 2026-27 BENEFICIAL PA allocation the dividend tax
// depends on the nation's bands (the PA can be moved onto/off dividends to minimise
// tax), so every reference here is threaded with `nation`.
/** Reference A — analytic dividend tax via the beneficial split (top slice). */
function refDividendTax(nonDiv: number, dividends: number, nation: UKNation): number {
  return refComponents(nonDiv, 0, dividends, nation).divTax;
}
/** Reference NSNDI tax via the beneficial split (taper coupled to dividends in ANI). */
function refNsndiTax(nonDiv: number, dividends: number, nation: UKNation): number {
  return refComponents(nonDiv, 0, dividends, nation).nsTax;
}
/** Reference B — a £1 marginal integrator over the beneficial split's dividend slice
 *  (a structurally different shape from refTaxForSplit's analytic stack). */
function refDividendTaxStepwise(nonDiv: number, dividends: number, nation: UKNation): number {
  const r = refRates(nation);
  const { tNs, tSav, tDiv } = refAllocate(nonDiv, 0, dividends, refPersonalAllowance(nonDiv + dividends), r);
  let tax = 0;
  let allowanceLeft = DIV_ALLOWANCE;
  for (let i = 0; i < tDiv; i += 1) {
    const slice = Math.min(1, tDiv - i);
    const pos = tNs + tSav + i;
    let rate: number;
    if (allowanceLeft > 0) {
      rate = 0;
      allowanceLeft -= slice;
    } else if (pos < DIV_LIMITS.ordinaryUpTo) rate = DIV_RATES.ordinary;
    else if (pos < DIV_LIMITS.upperUpTo) rate = DIV_RATES.upper;
    else rate = DIV_RATES.additional;
    tax += slice * rate;
  }
  return tax;
}
const engineDivTax = (nonDiv: number, dividends: number, nation: UKNation) => incomeTaxOn(nonDiv, nation, dividends).dividendTax;
const engineNsndi = (nonDiv: number, dividends: number, nation: UKNation) => incomeTaxOn(nonDiv, nation, dividends).tax;

// 5.0 references agree with each other (two different algorithms), both nations.
for (const nation of NATIONS) {
  for (const [nd, dv] of [[0, 5_000], [30_000, 3_000], [45_000, 20_000], [120_000, 30_000], [200_000, 50_000]] as [number, number][]) {
    check(`5.0 dividend refs agree · ${nation} · nd£${nd} dv£${dv}`, refDividendTax(nd, dv, nation), refDividendTaxStepwise(nd, dv, nation));
  }
}

// 5.1 DIFFERENTIAL — engine dividend tax + taper-coupled NSNDI tax vs references.
const ndGrid = [0, 10_000, 20_000, 30_000, 40_000, 48_000, 50_000, 60_000, 90_000, 100_000, 118_000, 125_140, 150_000];
const dvGrid = [0, 100, 499, 500, 501, 1_000, 2_000, 5_000, 10_000, 30_000, 60_000, 100_000];
for (const nation of NATIONS) {
  let divMis = 0;
  let nsndiMis = 0;
  for (const nd of ndGrid)
    for (const dv of dvGrid) {
      if (Math.abs(engineDivTax(nd, dv, nation) - refDividendTax(nd, dv, nation)) >= EPS) divMis++;
      if (Math.abs(engineNsndi(nd, dv, nation) - refNsndiTax(nd, dv, nation)) >= EPS) nsndiMis++;
    }
  assert(`5.1 dividend-tax differential · ${nation} (${ndGrid.length * dvGrid.length} pairs)`, divMis === 0, `${divMis} mismatches`);
  assert(`5.1 NSNDI-tax taper-coupled differential · ${nation}`, nsndiMis === 0, `${nsndiMis} mismatches`);
}
for (const [nd, dv] of [[30_000, 10_000], [48_000, 10_000], [120_000, 20_000]] as [number, number][]) {
  check(`5.1 dividend stepwise xcheck · nd£${nd} dv£${dv}`, engineDivTax(nd, dv, 'england-wales-ni'), refDividendTaxStepwise(nd, dv, 'england-wales-ni'));
}

// 5.2 EXTERNAL/PRIMARY ANCHOR — gov.uk's own 2026-27 worked example (read 2026-06-20
// from gov.uk/tax-on-dividends): £29,570 wages + £3,000 dividends → 20% on £17,000
// wages = £3,400; £500 dividends @ 0% + £2,500 @ 10.75% = £268.75.
check('5.2 gov.uk example · wages/NSNDI IT £3,400', engineNsndi(29_570, 3_000, 'england-wales-ni'), 3_400);
check('5.2 gov.uk example · dividend tax £268.75', engineDivTax(29_570, 3_000, 'england-wales-ni'), 268.75);

// 5.3 INVARIANTS.
for (const nation of NATIONS) {
  let lastDt = 0;
  let dtMono = 0;
  for (let dv = 0; dv <= 60_000; dv += 100) {
    const dt = engineDivTax(40_000, dv, nation);
    if (dt < lastDt - EPS) dtMono++;
    lastDt = dt;
  }
  assert(`5.3 dividend tax monotonic in dividends · ${nation}`, dtMono === 0, `${dtMono} decreases`);
}
// Dividends use UK RATES regardless of nation. NB under the beneficial PA allocation
// the dividend TAX is NOT nation-invariant in general — the allocation depends on the
// nation's bands (the PA can be moved onto/off dividends to minimise tax), so a
// Scottish trader's dividend tax can differ from an rUK one with the same inputs (this
// is correct, not a bug — the rate ladder is identical, the PA split differs). The
// nation-invariance holds only where there is no other income to trade the PA against,
// i.e. PURE dividends — assert it there.
let nationDiff = 0;
for (const dv of dvGrid) {
  if (Math.abs(engineDivTax(0, dv, 'scotland') - engineDivTax(0, dv, 'england-wales-ni')) >= EPS) nationDiff++;
}
assert('5.3 pure-dividend tax identical rUK vs Scotland (UK rates §S)', nationDiff === 0, `${nationDiff} differ`);
// The first £500 of taxable dividends is always the 0% allowance.
{
  const e = incomeTaxOn(40_000, 'england-wales-ni', 5_000);
  const allowanceLine = e.dividendLines.find((l) => l.rate === 0);
  assert('5.3 dividend allowance = £500 @ 0%', !!allowanceLine && Math.abs((allowanceLine?.amount ?? 0) - 500) < EPS);
}
// No dividend additional rate (39.35%) while the slice sits below £125,140 taxable.
{
  const e = incomeTaxOn(40_000, 'england-wales-ni', 40_000); // top of dividends ≈ £67.4k taxable
  assert('5.3 no dividend additional rate below £125,140 taxable', !e.dividendLines.some((l) => Math.abs(l.rate - 0.3935) < 1e-9 && l.amount > EPS));
}

// 5.4 FULL ESTIMATE — dividend tax flows into totalTax (the set-aside total).
{
  const e = calculateTaxEstimate({ taxYear: '2026-27', nation: 'england-wales-ni', incomeReceived: 46_000, deductibleExpenses: 1_000, dividendIncome: 20_000 });
  check('5.4 totalTax = profit IT + dividend tax + Class 4', e.totalTax, e.incomeTax + e.dividendTax + e.class4Nic);
  assert('5.4 dividend tax > 0 when dividends present', e.dividendTax > 0);
  const g = calculateTaxEstimate({ taxYear: '2026-27', nation: 'england-wales-ni', incomeReceived: 30_570, deductibleExpenses: 1_000, dividendIncome: 3_000 });
  check('5.4 gov.uk example via public estimate · dividend tax £268.75', g.dividendTax, 268.75);
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. SAVINGS (§T) — independent references + differential + gov.uk anchor + invariants.
//    The fiddliest calc (starting-rate band shrinks against other income; PSA set
//    by the top rate) → leaned hardest on the differential layer.
// ─────────────────────────────────────────────────────────────────────────────
// PSA / starting-rate band / savings rates now live at the top (shared with §5 and
// the beneficial reference). Under the beneficial PA allocation the savings tax also
// depends on the nation's bands, so every reference here is threaded with `nation`.
const refPSA = (totalTaxable: number) => (totalTaxable > DIV_LIMITS.upperUpTo ? PSA.additional : totalTaxable > DIV_LIMITS.ordinaryUpTo ? PSA.higher : PSA.basic);
/** Reference A — analytic savings tax via the beneficial split (middle slice). */
function refSavingsTax(nonSav: number, savings: number, dividends: number, nation: UKNation): number {
  return refComponents(nonSav, savings, dividends, nation).savTax;
}
/** Reference B — a £1 marginal integrator over the beneficial split's savings slice,
 *  tracking the starting-rate band + PSA (a different shape from refTaxForSplit). */
function refSavingsTaxStepwise(nonSav: number, savings: number, dividends: number, nation: UKNation): number {
  const r = refRates(nation);
  const allowance = refPersonalAllowance(nonSav + savings + dividends);
  const { tNs, tSav } = refAllocate(nonSav, savings, dividends, allowance, r);
  const totalTaxable = Math.max(0, nonSav + savings + dividends - allowance);
  let tax = 0;
  let srLeft = Math.max(0, STARTING_RATE_BAND - tNs);
  let psaLeft = refPSA(totalTaxable);
  for (let i = 0; i < tSav; i += 1) {
    const slice = Math.min(1, tSav - i);
    const pos = tNs + i;
    if (srLeft > 0) {
      srLeft -= slice;
    } else if (psaLeft > 0) {
      psaLeft -= slice;
    } else if (pos < DIV_LIMITS.ordinaryUpTo) tax += slice * SAV_RATES.basic;
    else if (pos < DIV_LIMITS.upperUpTo) tax += slice * SAV_RATES.higher;
    else tax += slice * SAV_RATES.additional;
  }
  return tax;
}
const engineSavTax = (nonSav: number, savings: number, dividends: number, nation: UKNation) => incomeTaxOn(nonSav, nation, dividends, savings).savingsTax;

// 6.0 references agree (two different algorithms), both nations.
for (const nation of NATIONS) {
  for (const [ns, sv, dv] of [[0, 4_000, 0], [16_000, 200, 0], [30_000, 2_000, 0], [45_000, 5_000, 10_000], [120_000, 3_000, 0]] as [number, number, number][]) {
    check(`6.0 savings refs agree · ${nation} · ns£${ns} sv£${sv} dv£${dv}`, refSavingsTax(ns, sv, dv, nation), refSavingsTaxStepwise(ns, sv, dv, nation));
  }
}

// 6.1 DIFFERENTIAL — engine savings tax vs reference across an income grid × both
//     nations, with and without dividends (the savings↔dividends stack interaction).
const nsGrid = [0, 5_000, 12_570, 13_000, 16_000, 17_570, 20_000, 30_000, 45_000, 50_000, 90_000, 120_000, 150_000];
const svGrid = [0, 100, 200, 1_000, 1_500, 2_000, 5_000, 10_000, 30_000];
for (const nation of NATIONS) {
  let savMis = 0;
  for (const ns of nsGrid) for (const sv of svGrid) for (const dv of [0, 8_000]) {
    if (Math.abs(engineSavTax(ns, sv, dv, nation) - refSavingsTax(ns, sv, dv, nation)) >= EPS) savMis++;
  }
  assert(`6.1 savings-tax differential · ${nation} (${nsGrid.length * svGrid.length * 2} cases)`, savMis === 0, `${savMis} mismatches`);
}
for (const [ns, sv] of [[30_000, 2_000], [16_000, 200], [60_000, 1_000]] as [number, number][]) {
  check(`6.1 savings stepwise xcheck · ns£${ns} sv£${sv}`, engineSavTax(ns, sv, 0, 'england-wales-ni'), refSavingsTaxStepwise(ns, sv, 0, 'england-wales-ni'));
}

// 6.2 EXTERNAL/PRIMARY ANCHOR — gov.uk's own worked example (read 2026-06-20 from
// gov.uk/apply-tax-free-interest-on-savings): £16,000 wages + £200 interest → the
// £3,430 wages above the PA cut the £5,000 starting-rate band to £1,570, so the
// £200 interest is tax-free (£0).
check('6.2 gov.uk example · £16k + £200 interest → £0 savings tax', engineSavTax(16_000, 200, 0, 'england-wales-ni'), 0);
// A positive case hand-traced from the same gov.uk rules: £30,000 + £2,000 interest
// → no starting rate (other income > £5,000 over PA); £1,000 PSA @ 0% + £1,000 @ 20% = £200.
check('6.2 gov.uk rules · £30k + £2k interest → £200 savings tax', engineSavTax(30_000, 2_000, 0, 'england-wales-ni'), 200);

// 6.3 INVARIANTS.
// NB the savings-tax COMPONENT is NOT monotonic in savings under the beneficial PA
// allocation — adding savings can pull PA onto the savings (when that minimises tax),
// LOWERING the reported savings tax while total tax still rises. So assert the right
// invariant: TOTAL income tax (non-savings + savings + dividends) is non-decreasing in
// savings (more income never less tax) — the component alone legitimately is not.
for (const nation of NATIONS) {
  let lastTotal = 0;
  let totalMono = 0;
  for (let sv = 0; sv <= 40_000; sv += 100) {
    const e = incomeTaxOn(40_000, nation, 0, sv);
    const total = e.tax + e.savingsTax + e.dividendTax;
    if (total < lastTotal - EPS) totalMono++;
    lastTotal = total;
  }
  assert(`6.3 total income tax monotonic in savings · ${nation}`, totalMono === 0, `${totalMono} decreases`);
}
// Savings use UK RATES regardless of nation; like dividends (§5.3), the beneficial PA
// allocation makes the savings TAX nation-dependent in general (the split differs by
// nation). Nation-invariance holds only with no other income to trade the PA against —
// PURE savings — assert it there.
let savNationDiff = 0;
for (const sv of svGrid) {
  if (Math.abs(engineSavTax(0, sv, 0, 'scotland') - engineSavTax(0, sv, 0, 'england-wales-ni')) >= EPS) savNationDiff++;
}
assert('6.3 pure-savings tax identical rUK vs Scotland (UK rates §T)', savNationDiff === 0, `${savNationDiff} differ`);
{
  const lowOther = incomeTaxOn(13_000, 'england-wales-ni', 0, 6_000); // £430 over PA → SR band £4,570
  assert('6.3 starting-rate band present when other income just over PA', lowOther.savingsLines.some((l) => l.name === 'Starting rate for savings' && l.amount > EPS));
  const highOther = incomeTaxOn(17_570, 'england-wales-ni', 0, 6_000); // exactly £5,000 over PA → none
  assert('6.3 no starting-rate band when other income ≥ £17,570', !highOther.savingsLines.some((l) => l.name === 'Starting rate for savings' && l.amount > EPS));
}

// 6.4 FULL ESTIMATE — savings tax flows into totalTax (the set-aside).
{
  const e = calculateTaxEstimate({ taxYear: '2026-27', nation: 'england-wales-ni', incomeReceived: 31_000, deductibleExpenses: 1_000, savingsIncome: 2_000 });
  check('6.4 savings tax in totalTax', e.totalTax, e.incomeTax + e.dividendTax + e.savingsTax + e.hicbcCharge + e.class4Nic);
  check('6.4 estimate savings tax £200 (profit £30k + £2k interest)', e.savingsTax, 200);
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. HICBC (§U) — independent references + differential + boundary + invariants +
//    hand-traced anchors. The charge is a STEP function (1% per complete £200), so
//    the boundary deck (the £200-step edges + the £80k cap + the round-down) does
//    the heavy lifting here alongside the differential sweep.
// ─────────────────────────────────────────────────────────────────────────────
// Constants RESTATED from gov.uk/child-benefit-tax-charge + ITEPA 2003 s681C + the
// 2026-27 Child Benefit rates table — NOT imported from the engine.
const HICBC_THRESHOLD = 60_000;
const HICBC_UPPER = 80_000;
const HICBC_STEP = 200;
const CB_WEEKLY = { eldest: 27.05, additional: 17.9 };
const CB_WEEKS = 52;
const cbAnnual = (children: number): number =>
  children <= 0 ? 0 : (CB_WEEKLY.eldest + (children - 1) * CB_WEEKLY.additional) * CB_WEEKS;

/** Reference — a DIFFERENT shape from the engine's floor division: count complete
 *  £200 bands above £60,000 with a loop, cap at 100%, 100% at/above £80,000.
 *  ITEPA 2003 s681C(3): the CB total is rounded DOWN to a whole £ FIRST, then the
 *  charge is rounded DOWN to a whole £ (confirmed vs TaxCalc on the golden set). */
function refHicbc(ani: number, children: number): number {
  const cb = Math.floor(cbAnnual(children)); // s681C(3): CB total → whole £
  if (cb <= 0 || ani <= HICBC_THRESHOLD) return 0;
  if (ani >= HICBC_UPPER) return cb;
  let pct = 0;
  for (let band = HICBC_THRESHOLD + HICBC_STEP; band <= ani + EPS; band += HICBC_STEP) pct += 1;
  return Math.floor(cb * (Math.min(100, pct) / 100)); // s681C(3): charge → whole £
}
// Drive the engine to an EXACT adjusted net income: profit = ani (expenses £1,000 ≥
// the trading allowance so it isn't swapped in), no other income/savings/dividends.
const hicbcEst = (ani: number, children: number, nation: UKNation = 'england-wales-ni'): number =>
  calculateTaxEstimate({ taxYear: '2026-27', nation, incomeReceived: ani + 1_000, deductibleExpenses: 1_000, childBenefitChildren: children }).hicbcCharge;
// Sanity: the driver sets ANI exactly.
check('7 driver sets ANI exactly', calculateTaxEstimate({ taxYear: '2026-27', nation: 'england-wales-ni', incomeReceived: 71_000, deductibleExpenses: 1_000, childBenefitChildren: 1 }).adjustedNetIncome, 70_000);

// 7.1 DIFFERENTIAL — engine vs the loop reference across ANI × children × both nations.
const aniGrid = [0, 30_000, 59_999, 60_000, 60_001, 60_199, 60_200, 60_201, 62_500, 65_000, 70_000, 72_345, 75_000, 79_999, 80_000, 80_001, 100_000, 150_000];
const childGrid = [0, 1, 2, 3, 4];
for (const nation of NATIONS) {
  let mis = 0;
  for (const ani of aniGrid)
    for (const c of childGrid) {
      if (Math.abs(hicbcEst(ani, c, nation) - refHicbc(ani, c)) >= EPS) {
        if (mis < 3) console.error(`  ✗ 7.1 HICBC · ${nation} · ANI £${ani} · ${c} kids: engine ${hicbcEst(ani, c, nation).toFixed(2)} vs ref ${refHicbc(ani, c).toFixed(2)}`);
        mis++;
      }
    }
  assert(`7.1 HICBC differential · ${nation} (${aniGrid.length * childGrid.length} cases)`, mis === 0, `${mis} mismatches`);
}

// 7.2 PRIMARY ANCHORS — hand-traced from the verbatim formula + 2026-27 CB rates,
// with the s681C(3) whole-£ round-down (CB floored first, then charge) applied.
// 1 child CB = £27.05 × 52 = £1,406.60 → floor £1,406. @ £70k: 50% → £703.00 → £703.
check('7.2 anchor · 1 child @ £70k → 50% → floor(£1,406 × 50%) = £703', hicbcEst(70_000, 1), 703);
// 2 children CB = (27.05+17.90) × 52 = £2,337.40 → floor £2,337. @ £75k: 75% →
// £1,752.75 → £1,752 (NOT £1,753.05 — the CB-floored-first round-down, golden G30).
check('7.2 anchor · 2 children @ £75k → 75% → floor(£2,337 × 75%) = £1,752', hicbcEst(75_000, 2), 1_752);
// @ £80,000 the charge is 100% of the Child Benefit, floored to a whole £.
check('7.2 anchor · 1 child @ £80k → 100% → floor(£1,406.60) = £1,406', hicbcEst(80_000, 1), 1_406);
check('7.2 anchor · 3 children @ £90k → 100% → floor(full CB)', hicbcEst(90_000, 3), Math.floor(cbAnnual(3)));
// Round-DOWN to a whole % (ITEPA s681C): £62,500 → 12.5 → floor 12%, not 12.5%;
// then floor(£1,406 × 12%) = floor(£168.72) = £168.
check('7.2 round-down · 1 child @ £62,500 → 12% → floor(£1,406 × 12%) = £168', hicbcEst(62_500, 1), 168);

// 7.3 BOUNDARY-COMPLETE — the £200-step edges, the £80k cap, the no-charge floor.
check('7.3 boundary · ANI £60,000 (at threshold) → £0', hicbcEst(60_000, 1), 0);
check('7.3 boundary · ANI £60,199 (just below first step) → £0', hicbcEst(60_199, 1), 0);
check('7.3 boundary · ANI £60,200 (first complete £200) → 1% → floor(£1,406 × 1%) = £14', hicbcEst(60_200, 1), 14);
check('7.3 boundary · ANI £79,999 (just below cap) → 99% → floor(£1,406 × 99%) = £1,391', hicbcEst(79_999, 1), 1_391);
check('7.3 boundary · ANI £80,001 (above cap) → 100% → floor(£1,406.60) = £1,406', hicbcEst(80_001, 1), 1_406);
check('7.3 boundary · 0 children → £0 even at £150k', hicbcEst(150_000, 0), 0);

// 7.4 INVARIANTS.
for (const nation of NATIONS) {
  // Monotonic non-decreasing in ANI; never exceeds the full Child Benefit (100% cap).
  let lastH = 0;
  let mono = 0;
  let overCap = 0;
  for (let ani = 55_000; ani <= 95_000; ani += 50) {
    const h = hicbcEst(ani, 2, nation);
    if (h < lastH - EPS) mono++;
    if (h > cbAnnual(2) + EPS) overCap++;
    lastH = h;
  }
  assert(`7.4 HICBC monotonic in ANI · ${nation}`, mono === 0, `${mono} decreases`);
  assert(`7.4 HICBC never exceeds full CB (100% cap) · ${nation}`, overCap === 0, `${overCap} over cap`);
}
// HICBC depends only on ANI + children, not the Income Tax bands → identical rUK vs Scotland.
let hNationDiff = 0;
for (const ani of aniGrid) for (const c of childGrid) {
  if (Math.abs(hicbcEst(ani, c, 'scotland') - hicbcEst(ani, c, 'england-wales-ni')) >= EPS) hNationDiff++;
}
assert('7.4 HICBC identical rUK vs Scotland (UK-wide charge §U)', hNationDiff === 0, `${hNationDiff} differ`);
// A deduction that drops ANI below a £200 step reduces the charge (relief flows through).
{
  const input = { taxYear: '2026-27', nation: 'england-wales-ni' as UKNation, incomeReceived: 71_000, deductibleExpenses: 1_000, childBenefitChildren: 1 };
  const relief = calculateTaxEstimate(input).totalOwed - calculateTaxEstimate({ ...input, deductibleExpenses: 1_400 }).totalOwed;
  // £400 less ANI = two fewer £200 steps = 2% less of £1,406.60 (£28.132), on top of 42% IT+C4 on £400 (£168).
  assert('7.4 deduction reduces HICBC (relief includes the clawback unwind)', relief > 0.42 * 400 + EPS, `relief ${relief.toFixed(2)} should exceed the 42% IT+C4 alone`);
}

// 7.5 FULL ESTIMATE — HICBC flows into totalTax AND the payments-on-account base
//     (SA110 keeps it inside A356), unlike the student loan.
{
  const e = calculateTaxEstimate({ taxYear: '2026-27', nation: 'england-wales-ni', incomeReceived: 71_000, deductibleExpenses: 1_000, childBenefitChildren: 2 });
  assert('7.5 HICBC charged (profit £70k, 2 kids)', e.hicbcCharge > 0);
  check('7.5 totalTax includes HICBC', e.totalTax, e.incomeTax + e.dividendTax + e.savingsTax + e.hicbcCharge + e.class4Nic);
  check('7.5 HICBC inside the POA base (each = totalTax/2, no CIS)', e.paymentsOnAccount.each, e.totalTax / 2);
  // Vs the same profit with no Child Benefit claimed: POA each is HIGHER by exactly half the charge.
  const noKids = calculateTaxEstimate({ taxYear: '2026-27', nation: 'england-wales-ni', incomeReceived: 71_000, deductibleExpenses: 1_000 });
  check('7.5 HICBC lifts the POA base by half the charge', e.paymentsOnAccount.each - noKids.paymentsOnAccount.each, e.hicbcCharge / 2);
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. PENSION / GIFT AID relief (§V) — band extension. Independent references that
//    extend the bands themselves + a relief anchor derived straight from the gov.uk
//    rule "relief = (marginal rate − 20%) × gross", which does NOT depend on the
//    band-shift mechanism (so it independently pins the engine's shift maths).
// ─────────────────────────────────────────────────────────────────────────────
// Reference schedule with the basic-rate (20%) band — and everything above it —
// widened by `ext`. RESTATED here (not imported from the engine's extendBands).
function refSchedExt(nation: UKNation, ext: number): Slab[] {
  const sched = refSchedule(nation);
  const basicIdx = sched.findIndex((s) => s.rate >= 0.2 - 1e-9);
  return sched.map((s, i) => (i >= basicIdx && Number.isFinite(s.upToTaxable) ? { ...s, upToTaxable: s.upToTaxable + ext } : s));
}
/** Reference A — analytic, extended bands, taper on (total − ext). */
function refIncomeTaxExt(total: number, nation: UKNation, ext: number): number {
  const taxable = Math.max(0, total - refPersonalAllowance(total - ext));
  let tax = 0;
  let lower = 0;
  for (const s of refSchedExt(nation, ext)) {
    if (taxable <= lower) break;
    tax += (Math.min(taxable, s.upToTaxable) - lower) * s.rate;
    lower = s.upToTaxable;
  }
  return tax;
}
/** Reference B — £1 marginal integrator over the extended schedule (different shape). */
function refIncomeTaxExtStepwise(total: number, nation: UKNation, ext: number): number {
  const taxable = Math.max(0, total - refPersonalAllowance(total - ext));
  const sched = refSchedExt(nation, ext);
  let tax = 0;
  for (let x = 0; x < taxable; x += 1) {
    let rate = sched[sched.length - 1].rate;
    for (const s of sched) if (x < s.upToTaxable) { rate = s.rate; break; }
    tax += Math.min(1, taxable - x) * rate;
  }
  return tax;
}
const engineIncomeTaxExt = (total: number, nation: UKNation, ext: number) => incomeTaxOn(total, nation, 0, 0, ext).tax;

// 8.0 references agree with each other (two different algorithms, several ext values).
for (const nation of NATIONS)
  for (const [total, ext] of [[50_000, 10_000], [80_000, 10_000], [110_000, 10_000], [150_000, 25_000], [30_000, 5_000]] as [number, number][]) {
    check(`8.0 ext refs agree · ${nation} · £${total}+${ext}`, refIncomeTaxExt(total, nation, ext), refIncomeTaxExtStepwise(total, nation, ext));
  }

// 8.1 DIFFERENTIAL — engine income tax with band extension vs the reference, swept
//     income × ext × both nations (the savings/dividend limits also extend in-engine).
const extIncGrid = [0, 12_570, 20_000, 40_000, 50_270, 55_000, 80_000, 85_000, 100_000, 110_000, 125_140, 150_000, 180_000];
const extGrid = [0, 1_000, 5_000, 10_000, 25_000, 40_000];
for (const nation of NATIONS) {
  let mis = 0;
  for (const total of extIncGrid)
    for (const ext of extGrid) {
      if (Math.abs(engineIncomeTaxExt(total, nation, ext) - refIncomeTaxExt(total, nation, ext)) >= EPS) {
        if (mis < 3) console.error(`  ✗ 8.1 ext · ${nation} · £${total}+${ext}: engine ${engineIncomeTaxExt(total, nation, ext).toFixed(2)} vs ref ${refIncomeTaxExt(total, nation, ext).toFixed(2)}`);
        mis++;
      }
    }
  assert(`8.1 band-extension differential · ${nation} (${extIncGrid.length * extGrid.length} cases)`, mis === 0, `${mis} mismatches`);
}

// 8.2 PRIMARY ANCHOR — relief = (marginal rate − 20%) × gross, the gov.uk rule, with
//     the gross sized to sit wholly in one band above basic. Both the engine and the
//     reference must hit the hand value (so a wrong shift shows up either way).
const reliefEngine = (total: number, nation: UKNation, gross: number) => engineIncomeTaxExt(total, nation, 0) - engineIncomeTaxExt(total, nation, gross);
const reliefRef = (total: number, nation: UKNation, gross: number) => refIncomeTaxExt(total, nation, 0) - refIncomeTaxExt(total, nation, gross);
for (const [total, nation, gross, expected, label] of [
  [80_000, 'england-wales-ni', 10_000, 2_000, 'rUK 40% → 20% top-up'],
  [150_000, 'england-wales-ni', 10_000, 2_500, 'rUK 45% → 25% top-up'],
  [55_000, 'scotland', 10_000, 2_200, 'Scotland 42% → 22% top-up'],
  [85_000, 'scotland', 10_000, 2_500, 'Scotland 45% advanced → 25%'],
  [150_000, 'scotland', 10_000, 2_800, 'Scotland 48% top → 28%'],
] as [number, UKNation, number, number, string][]) {
  check(`8.2 anchor engine · ${label}`, reliefEngine(total, nation, gross), expected);
  check(`8.2 anchor ref · ${label}`, reliefRef(total, nation, gross), expected);
}
// PA-restoration interaction (the £100k trap): rUK £110k + £10k gross → ANI £100k →
// PA restored (£5k @ 40% = £2,000) PLUS the £10k band shift (£2,000) = £4,000.
check('8.2 anchor · rUK £110k taper-restoration relief £4,000', reliefEngine(110_000, 'england-wales-ni', 10_000), 4_000);

// 8.3 BOUNDARY / REGRESSION — ext = 0 reproduces the no-extension engine exactly.
{
  let drift = 0;
  for (const nation of NATIONS) for (const total of extIncGrid) {
    if (Math.abs(engineIncomeTaxExt(total, nation, 0) - engineIncomeTax(total, nation)) >= EPS) drift++;
  }
  assert('8.3 ext=0 reproduces the base engine (regression)', drift === 0, `${drift} drifted`);
}
// Gross-up: NET £8,000 → GROSS £10,000 (÷ 0.8), via the full estimate.
{
  const e = calculateTaxEstimate({ taxYear: '2026-27', nation: 'england-wales-ni', incomeReceived: 81_000, deductibleExpenses: 1_000, pensionContributionsNet: 8_000 });
  check('8.3 gross-up · net £8,000 → gross £10,000', e.reliefGrossedUp, 10_000);
  // Gift Aid grosses up the same way and adds to the band extension.
  const g = calculateTaxEstimate({ taxYear: '2026-27', nation: 'england-wales-ni', incomeReceived: 81_000, deductibleExpenses: 1_000, pensionContributionsNet: 4_000, giftAidDonationsNet: 4_000 });
  check('8.3 pension + Gift Aid gross together', g.reliefGrossedUp, 10_000);
}

// 8.4 INVARIANTS — more contribution never raises income tax; relief is monotonic
//     in the gross and never exceeds the maximum marginal relief (band shift
//     (marginal − 20%) PLUS PA-restoration (marginal ÷ 2) → ≤ 47.5p/£1 in the
//     Scottish advanced-rate taper zone; cap at 50p). £120k sits in the taper zone,
//     so this deliberately exercises the band-extension × PA-restoration interaction.
for (const nation of NATIONS) {
  let nonDecreasingTax = 0;
  let reliefMono = 0;
  let overCap = 0;
  let lastRelief = 0;
  for (let gross = 0; gross <= 50_000; gross += 250) {
    const taxNow = engineIncomeTaxExt(120_000, nation, gross);
    const taxMore = engineIncomeTaxExt(120_000, nation, gross + 250);
    if (taxMore > taxNow + EPS) nonDecreasingTax++; // tax must not rise with more relief
    const relief = engineIncomeTaxExt(120_000, nation, 0) - taxNow;
    if (relief < lastRelief - EPS) reliefMono++;
    if (relief > 0.5 * gross + EPS) overCap++; // ≤ 50p/£1 (max marginal relief ≈ 47.5p)
    lastRelief = relief;
  }
  assert(`8.4 income tax non-increasing in contribution · ${nation}`, nonDecreasingTax === 0, `${nonDecreasingTax} rose`);
  assert(`8.4 relief monotonic in gross · ${nation}`, reliefMono === 0, `${reliefMono} fell`);
  assert(`8.4 relief ≤ 50p/£1 of gross · ${nation}`, overCap === 0, `${overCap} over`);
}

// 8.5 FULL ESTIMATE — the contributions reduce totalTax; the headline relief output
//     matches; and the cross-calc interactions (§U HICBC + §K taper) both engage.
{
  // Pension drops ANI £70k → £60k, wiping out the HICBC a £70k/2-kids sole trader owes.
  const withKidsNoPension = calculateTaxEstimate({ taxYear: '2026-27', nation: 'england-wales-ni', incomeReceived: 71_000, deductibleExpenses: 1_000, childBenefitChildren: 2 });
  const withKidsPension = calculateTaxEstimate({ taxYear: '2026-27', nation: 'england-wales-ni', incomeReceived: 71_000, deductibleExpenses: 1_000, childBenefitChildren: 2, pensionContributionsNet: 8_000 });
  assert('8.5 HICBC present without the pension', withKidsNoPension.hicbcCharge > 0);
  check('8.5 pension cuts ANI to £60k → HICBC £0', withKidsPension.hicbcCharge, 0);
  check('8.5 pension ANI reduced by the gross', withKidsPension.adjustedNetIncome, 60_000);
  // headline relief output = the IT saved on the combined position (here £10k @ 40% = £2,000).
  const e = calculateTaxEstimate({ taxYear: '2026-27', nation: 'england-wales-ni', incomeReceived: 81_000, deductibleExpenses: 1_000, pensionContributionsNet: 8_000 });
  check('8.5 pensionGiftAidRelief headline (£10k @ 40% → £2,000)', e.pensionGiftAidRelief, 2_000);
  check('8.5 relief actually lowers totalTax', calculateTaxEstimate({ taxYear: '2026-27', nation: 'england-wales-ni', incomeReceived: 81_000, deductibleExpenses: 1_000 }).totalTax - e.totalTax, 2_000);
  // No contributions → byte-for-byte unchanged (zero relief, ANI unreduced).
  const none = calculateTaxEstimate({ taxYear: '2026-27', nation: 'england-wales-ni', incomeReceived: 81_000, deductibleExpenses: 1_000 });
  check('8.5 no contribution · relief £0', none.pensionGiftAidRelief, 0);
  check('8.5 no contribution · gross £0', none.reliefGrossedUp, 0);
}

// ─────────────────────────────────────────────────────────────────────────────
if (failures > 0) {
  console.error(`\n❌ ${failures}/${checks} HARNESS checks FAILED`);
  process.exit(1);
}
console.log(`✅ All ${checks} harness checks passed (differential sweep + anchors + invariants + boundaries)`);
