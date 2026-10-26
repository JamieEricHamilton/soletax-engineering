/**
 * test-tax-engine.ts — the worked-example test set for the tax-estimate engine.
 *
 * Every expected figure below is HAND-COMPUTED from the verbatim gov.uk bands in
 * src/tax/rates-2026-27.ts (register §J/§K, tax year 2026-27) — the derivation
 * is shown beside each case so the annual review can recompute them against the
 * new year's figures. This set must pass before any UI binds to the engine, and
 * must be recomputed + re-run whenever the rates file changes.
 *
 * Run:  npx tsx scripts/test-tax-engine.ts   (or: npm run test:tax)
 */

import {
  calculateMileageAllowance,
  calculateTaxEstimate,
  roundBreakdownPounds,
  taxReliefForDeduction,
  type TaxEstimate,
  type UKNation,
} from '../src/tax';
import { incomeTaxOn } from '../src/tax/engine';
import { refAllocateExhaustive, refTaxForSplit, type RefRates } from './_ref-beneficial';

let failures = 0;
let checks = 0;

function close(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.005; // half a penny — float tolerance only
}

function check(name: string, actual: number | string, expected: number | string) {
  checks++;
  const ok = typeof actual === 'number' && typeof expected === 'number'
    ? close(actual, expected)
    : actual === expected;
  if (!ok) {
    failures++;
    console.error(`  ✗ ${name}: expected ${expected}, got ${actual}`);
  }
}

/** Internal consistency every estimate must satisfy. */
function checkReconciles(name: string, e: TaxEstimate) {
  check(`${name} · IT bands reconcile`, e.incomeTaxBands.reduce((s, l) => s + l.tax, 0), e.incomeTax);
  check(`${name} · C4 bands reconcile`, e.class4Bands.reduce((s, l) => s + l.tax, 0), e.class4Nic);
  check(`${name} · total reconciles`, e.incomeTax + e.class4Nic, e.totalTax);
}

const YEAR = '2026-27';
const rUK = (incomeReceived: number, deductibleExpenses: number) =>
  calculateTaxEstimate({ taxYear: YEAR, nation: 'england-wales-ni', incomeReceived, deductibleExpenses });
const scot = (incomeReceived: number, deductibleExpenses: number) =>
  calculateTaxEstimate({ taxYear: YEAR, nation: 'scotland', incomeReceived, deductibleExpenses });

console.log('Tax engine worked examples — rates 2026-27 (§J/§K verbatim)\n');

// ── England/Wales/NI ─────────────────────────────────────────────────────────

{ // 1. Nothing earned → nothing due.
  const e = rUK(0, 0);
  check('1 rUK £0 · total', e.totalTax, 0);
  check('1 rUK £0 · class2', e.class2Status, 'below-threshold-voluntary');
  checkReconciles('1', e);
}

{ // 2. £900 income, no expenses → trading allowance covers it all (§K): profit 0.
  const e = rUK(900, 0);
  check('2 trading allowance · basis', e.deductionBasis, 'trading-allowance');
  check('2 trading allowance · profit', e.taxableProfit, 0);
  check('2 trading allowance · total', e.totalTax, 0);
  checkReconciles('2', e);
}

{ // 3. Profit £25,000 (30,000 − 5,000).
  // IT: (25,000 − 12,570) × 20% = 12,430 × 0.20 = 2,486.
  // C4: (25,000 − 12,570) × 6% = 745.80.  Total 3,231.80.
  const e = rUK(30_000, 5_000);
  check('3 rUK 25k · IT', e.incomeTax, 2_486);
  check('3 rUK 25k · C4', e.class4Nic, 745.8);
  check('3 rUK 25k · total', e.totalTax, 3_231.8);
  check('3 rUK 25k · class2', e.class2Status, 'treated-as-paid');
  check('3 rUK 25k · PA', e.personalAllowance, 12_570);
  checkReconciles('3', e);
}

{ // 4. Profit £60,000 (70,000 − 10,000) — crosses into higher rate.
  // IT: 37,700 × 20% + (60,000 − 50,270) × 40% = 7,540 + 3,892 = 11,432.
  // C4: 37,700 × 6% + 9,730 × 2% = 2,262 + 194.60 = 2,456.60.  Total 13,888.60.
  const e = rUK(70_000, 10_000);
  check('4 rUK 60k · IT', e.incomeTax, 11_432);
  check('4 rUK 60k · C4', e.class4Nic, 2_456.6);
  check('4 rUK 60k · total', e.totalTax, 13_888.6);
  check('4 rUK 60k · IT band count', e.incomeTaxBands.length, 2);
  checkReconciles('4', e);
}

{ // 5. Profit £110,000 (115,000 − 5,000) — inside the PA taper.
  // PA: 12,570 − (110,000 − 100,000)/2 = 7,570. Taxable: 102,430.
  // IT: 37,700 × 20% + (102,430 − 37,700) × 40% = 7,540 + 25,892 = 33,432.
  // C4: 2,262 + (110,000 − 50,270) × 2% = 2,262 + 1,194.60 = 3,456.60.
  const e = rUK(115_000, 5_000);
  check('5 rUK 110k · PA', e.personalAllowance, 7_570);
  check('5 rUK 110k · IT', e.incomeTax, 33_432);
  check('5 rUK 110k · C4', e.class4Nic, 3_456.6);
  check('5 rUK 110k · total', e.totalTax, 36_888.6);
  checkReconciles('5', e);
}

{ // 6. Profit £130,000 (140,000 − 10,000) — PA fully tapered to £0.
  // Additional rate (45%) starts at £125,140 of TAXABLE income (ITA 2007
  // higher-rate limit; Hardman's ¶3-000A). EXTERNAL ANCHOR 2026-06-20:
  // listentotaxman gives £44,703 IT for £130k (45% on £4,860 = £2,187) —
  // legislation + Hardman's + listentotaxman agree. (income-tax.co.uk's £44,460
  // was itself a taper-zone calculator bug; our old £45,331.50 started 45% at
  // £112,570 — both wrong in opposite directions, truth in the middle.)
  // Taxable 130,000: 37,700 × 20% + (125,140 − 37,700) × 40% + (130,000 − 125,140) × 45%
  //   = 7,540 + 34,976 + 2,187 = 44,703.
  // C4: 2,262 + (130,000 − 50,270) × 2% = 2,262 + 1,594.60 = 3,856.60.
  const e = rUK(140_000, 10_000);
  check('6 rUK 130k · PA', e.personalAllowance, 0);
  check('6 rUK 130k · IT', e.incomeTax, 44_703);
  check('6 rUK 130k · C4', e.class4Nic, 3_856.6);
  check('6 rUK 130k · total', e.totalTax, 48_559.6);
  check('6 rUK 130k · IT band count', e.incomeTaxBands.length, 3);
  checkReconciles('6', e);
}

{ // 7. Profit £10,000 — under the PA and the Class 4 limit, over £7,105:
  // nothing due, Class 2 treated as paid (§J).
  const e = rUK(12_000, 2_000);
  check('7 rUK 10k · total', e.totalTax, 0);
  check('7 rUK 10k · class2', e.class2Status, 'treated-as-paid');
  checkReconciles('7', e);
}

{ // 8. Profit £5,000 — under £7,105: nothing due, voluntary Class 2 available (§J).
  const e = rUK(6_000, 1_000);
  check('8 rUK 5k · total', e.totalTax, 0);
  check('8 rUK 5k · class2', e.class2Status, 'below-threshold-voluntary');
  check('8 rUK 5k · basis', e.deductionBasis, 'expenses'); // £1,000 expenses = allowance; expenses win the tie
  checkReconciles('8', e);
}

{ // 9. £30,000 income but only £500 expenses → the £1,000 trading allowance is
  // the better deduction (§K): profit 29,000.
  // IT: (29,000 − 12,570) × 20% = 3,286.  C4: 16,430 × 6% = 985.80.
  const e = rUK(30_000, 500);
  check('9 rUK allowance-better · basis', e.deductionBasis, 'trading-allowance');
  check('9 rUK allowance-better · profit', e.taxableProfit, 29_000);
  check('9 rUK allowance-better · IT', e.incomeTax, 3_286);
  check('9 rUK allowance-better · C4', e.class4Nic, 985.8);
  checkReconciles('9', e);
}

// ── Scotland (§K Scottish bands; NIC identical — not devolved) ───────────────

{ // 10. Profit £25,000. Taxable 12,430.
  // Starter 3,967 × 19% = 753.73; Basic (12,430 − 3,967) = 8,463 × 20% = 1,692.60.
  // IT = 2,446.33. C4 = 745.80 (same as rUK). Total 3,192.13.
  const e = scot(30_000, 5_000);
  check('10 scot 25k · IT', e.incomeTax, 2_446.33);
  check('10 scot 25k · C4', e.class4Nic, 745.8);
  check('10 scot 25k · total', e.totalTax, 3_192.13);
  checkReconciles('10', e);
}

{ // 11. Profit £60,000. Taxable 47,430.
  // Starter 3,967×19% = 753.73; Basic 12,989×20% = 2,597.80;
  // Intermediate 14,136×21% = 2,968.56; Higher (47,430 − 31,092) = 16,338×42% = 6,861.96.
  // IT = 13,182.05. C4 = 2,456.60. Total 15,638.65.
  const e = scot(70_000, 10_000);
  check('11 scot 60k · IT', e.incomeTax, 13_182.05);
  check('11 scot 60k · C4', e.class4Nic, 2_456.6);
  check('11 scot 60k · total', e.totalTax, 15_638.65);
  checkReconciles('11', e);
}

{ // 12. Profit £110,000 — PA tapers to 7,570. Taxable 102,430.
  // Starter 753.73 + Basic 2,597.80 + Intermediate 2,968.56
  // + Higher (62,430 − 31,092) = 31,338×42% = 13,161.96
  // + Advanced (102,430 − 62,430) = 40,000×45% = 18,000.  IT = 37,482.05.
  const e = scot(115_000, 5_000);
  check('12 scot 110k · PA', e.personalAllowance, 7_570);
  check('12 scot 110k · IT', e.incomeTax, 37_482.05);
  check('12 scot 110k · C4', e.class4Nic, 3_456.6);
  check('12 scot 110k · total', e.totalTax, 40_938.65);
  checkReconciles('12', e);
}

{ // 13. Profit £130,000 — PA £0. Taxable 130,000. The advanced band runs to
  // £125,140 of TAXABLE income and the 48% top rate starts there (Hardman's
  // ¶3-000B "taxable band £62,431–125,140") — same £125,140 taxable boundary as
  // the rUK additional rate in case 6 (fixed 2026-06-20).
  // 753.73 + 2,597.80 + 2,968.56 + 13,161.96
  // + Advanced (125,140 − 62,430) = 62,710×45% = 28,219.50
  // + Top (130,000 − 125,140) = 4,860×48% = 2,332.80.  IT = 50,034.35.
  const e = scot(140_000, 10_000);
  check('13 scot 130k · PA', e.personalAllowance, 0);
  check('13 scot 130k · IT', e.incomeTax, 50_034.35);
  check('13 scot 130k · C4', e.class4Nic, 3_856.6);
  check('13 scot 130k · total', e.totalTax, 53_890.95);
  check('13 scot 130k · IT band count', e.incomeTaxBands.length, 6);
  checkReconciles('13', e);
}

// ── Dividends (§S — top slice, £500 allowance, UK rates even for Scotland) ───
// (Independently re-verified by the differential harness; D1 is gov.uk's own example.)

{ // D1. gov.uk worked example (2026-27): profit £29,570 (30,570 − 1,000) + £3,000
  //  dividends. NSNDI taxable 17,000 → 20% = 3,400. Dividends: £500 @ 0% +
  //  £2,500 @ 10.75% = 268.75. (https://www.gov.uk/tax-on-dividends, read 2026-06-20)
  const e = calculateTaxEstimate({ taxYear: YEAR, nation: 'england-wales-ni', incomeReceived: 30_570, deductibleExpenses: 1_000, dividendIncome: 3_000 });
  check('D1 gov.uk · NSNDI IT', e.incomeTax, 3_400);
  check('D1 gov.uk · dividend tax', e.dividendTax, 268.75);
  check('D1 gov.uk · totalTax = IT + dividend + C4', e.totalTax, e.incomeTax + e.dividendTax + e.class4Nic);
}

{ // D2. Dividends span ordinary→upper: profit £45,000 (46,000 − 1,000) + £20,000
  //  dividends, rUK. NSNDI taxable 32,430. Dividends from 32,430: £500 @ 0%
  //  (→32,930); ordinary (37,700 − 32,930) = 4,770 @ 10.75% = 512.775; upper
  //  (20,000 − 500 − 4,770) = 14,730 @ 35.75% = 5,265.975. Dividend tax = 5,778.75.
  const e = calculateTaxEstimate({ taxYear: YEAR, nation: 'england-wales-ni', incomeReceived: 46_000, deductibleExpenses: 1_000, dividendIncome: 20_000 });
  check('D2 ordinary→upper · dividend tax', e.dividendTax, 5_778.75);
}

{ // D3. Scotland uses the UK dividend rates + UK band limits (NOT Scottish bands):
  //  identical inputs to D2 give the SAME dividend tax (§S; ITA 2007 s.11D(6)).
  const e = calculateTaxEstimate({ taxYear: YEAR, nation: 'scotland', incomeReceived: 46_000, deductibleExpenses: 1_000, dividendIncome: 20_000 });
  check('D3 Scotland dividend tax = UK treatment', e.dividendTax, 5_778.75);
}

// ── Savings interest (§T — middle slice, starting-rate band + PSA, UK rates) ──
// (Independently re-verified by the differential harness; S1 is gov.uk's example.)

{ // S1. gov.uk worked example: profit £16,000 (17,000 − 1,000) + £200 interest.
  //  The £3,430 non-savings income over the PA cuts the £5,000 starting-rate band
  //  to £1,570, so the £200 interest is tax-free. (gov.uk/apply-tax-free-interest-on-savings)
  const e = calculateTaxEstimate({ taxYear: YEAR, nation: 'england-wales-ni', incomeReceived: 17_000, deductibleExpenses: 1_000, savingsIncome: 200 });
  check('S1 gov.uk · savings tax', e.savingsTax, 0);
}

{ // S2. Profit £30,000 + £2,000 interest, rUK. No starting rate (non-savings income
  //  £17,430 > £5,000 over PA); £1,000 PSA @ 0% + £1,000 @ 20% = £200.
  const e = calculateTaxEstimate({ taxYear: YEAR, nation: 'england-wales-ni', incomeReceived: 31_000, deductibleExpenses: 1_000, savingsIncome: 2_000 });
  check('S2 basic-rate · savings tax', e.savingsTax, 200);
}

{ // S3. Scotland uses UK savings rates (not Scottish bands): same inputs as S2
  //  give the SAME savings tax (§T; register §K — savings stay UK-wide).
  const e = calculateTaxEstimate({ taxYear: YEAR, nation: 'scotland', incomeReceived: 31_000, deductibleExpenses: 1_000, savingsIncome: 2_000 });
  check('S3 Scotland savings tax = UK treatment', e.savingsTax, 200);
}

// ── Beneficial PA allocation (ITA 2007 s25(2)) — worked example ──────────────
// 2026-27: the Personal Allowance is deducted "in the way which will result in the
// greatest reduction in liability" (s25(2)), NOT simply non-savings-first. The key
// case: do not waste PA on income a 0% band already covers (savings starting-rate
// band / PSA, or the dividend allowance).

{ // B1. Profit £5,000 (6,000 − 1,000) + £5,000 savings interest + £10,000 dividends, rUK.
  //  Total £20,000; PA £12,570 → £7,430 must remain taxable. Beneficial split: shield all
  //  £5,000 profit + £7,570 dividends, leaving taxable = £5,000 savings + £2,430 dividends.
  //  Tax: savings £5,000 all inside the £5,000 starting-rate band @ 0% (non-savings taxable
  //  is £0); dividends £500 @ 0% (allowance) + £1,930 @ 10.75% = £207.475. Total £207.475.
  //  Fixed non-savings-first would instead spend PA on the (already 0%) savings and leave
  //  £6,930 of dividends taxable @ 10.75% = £744.98 — £537.50 too high. s25(2) forbids it.
  const e = calculateTaxEstimate({ taxYear: YEAR, nation: 'england-wales-ni', incomeReceived: 6_000, deductibleExpenses: 1_000, savingsIncome: 5_000, dividendIncome: 10_000 });
  check('B1 beneficial · NSNDI IT', e.incomeTax, 0);
  check('B1 beneficial · savings tax', e.savingsTax, 0);
  check('B1 beneficial · dividend tax (s25(2) optimum, not £744.98 fixed)', e.dividendTax, 207.475);
  check('B1 beneficial · totalTax', e.totalTax, 207.475);
}

// ── Beneficial PA allocation (ITA 2007 s25(2)) == the true £1 optimum ─────────
// The engine splits the Personal Allowance across non-savings / savings / dividends
// for the GREATEST reduction in liability (2026-27). It does so with a fast vertex
// search; here we PROVE that search finds the genuine minimum by comparing the
// engine's income tax to a £1 exhaustive brute force (refAllocateExhaustive — no
// vertex logic) over every PA distribution. This is the permanent home of the S75
// throwaway /tmp/verify-pa.ts proof (it caught a missed-vertex bug in the first
// optimiser). Rates RESTATED below, not imported from the engine, so this stays an
// independent oracle. Default grid is a fast subset; PA_DEEP=1 runs the full sweep.
// ⚠ When 2027-28 rates land the law switches to a FIXED order (s25(3A)); that year's
// engine must set BENEFICIAL_PA_ALLOCATION=false and this guard's expectation flips
// to the fixed split (see the rollover note in src/tax/engine.ts).
{
  const REF_RUK: [number, number][] = [[37_700, 0.2], [125_140, 0.4], [Infinity, 0.45]];
  const REF_SCOT: [number, number][] = [[3_967, 0.19], [16_956, 0.2], [31_092, 0.21], [62_430, 0.42], [125_140, 0.45], [Infinity, 0.48]];
  const refPA = (ani: number) => Math.ceil(Math.max(0, 12_570 - Math.max(0, ani - 100_000) / 2)); // ITA 2007 s35(3)
  const refRates = (nation: UKNation, ext: number): RefRates => {
    const base = nation === 'scotland' ? REF_SCOT : REF_RUK;
    const basicIdx = base.findIndex(([, r]) => r >= 0.2 - 1e-9);
    return {
      schedule: base.map(([lim, r], i): [number, number] => (i >= basicIdx && Number.isFinite(lim) ? [lim + ext, r] : [lim, r])),
      nationEdges: base.map(([lim]) => lim).filter(Number.isFinite),
      ukBasic: 37_700 + ext,
      ukHigher: 125_140 + ext,
      savRates: [0.2, 0.4, 0.45],
      divRates: [0.1075, 0.3575, 0.3935],
      divAllowance: 500,
      startingRateBand: 5_000,
      psaBasic: 1_000,
      psaHigher: 500,
      psaAdditional: 0,
    };
  };
  const deep = process.env.PA_DEEP === '1';
  const nsVals = deep
    ? [12_570, 30_000, 40_000, 45_000, 48_000, 50_270, 55_000, 60_000, 75_000, 100_000, 110_000, 120_000]
    : [12_570, 30_000, 45_000, 50_270, 60_000, 100_000, 120_000];
  const savVals = deep ? [0, 1_000, 2_000] : [0, 500, 1_000];
  const divVals = deep ? [0, 2_000, 6_000, 9_000] : [0, 500, 2_000];
  const extVals = [0, 5_000];
  const nations: UKNation[] = ['england-wales-ni', 'scotland'];
  let cases = 0;
  let mismatches = 0;
  for (const nation of nations)
    for (const ns of nsVals)
      for (const sav of savVals)
        for (const div of divVals)
          for (const ext of extVals) {
            if (sav === 0 && div === 0) continue; // no investment income → nothing to allocate
            const eng = incomeTaxOn(ns, nation, div, sav, ext);
            const engTotal = eng.tax + eng.savingsTax + eng.dividendTax;
            const r = refRates(nation, ext);
            const allowance = refPA(ns + sav + div - ext);
            const opt = refTaxForSplit(refAllocateExhaustive(ns, sav, div, allowance, r), r).total;
            cases++;
            if (Math.abs(engTotal - opt) >= 0.01) {
              mismatches++;
              if (mismatches <= 5) console.error(`  ✗ PA-opt ${nation} ns£${ns} sav£${sav} div£${div} ext£${ext}: engine £${engTotal.toFixed(2)} vs £1-exhaustive £${opt.toFixed(2)}`);
            }
          }
  check(`PA beneficial allocation == £1 exhaustive optimum (${cases} cases${deep ? ', DEEP' : ''})`, mismatches, 0);
}

// ── HICBC (§U — 1% of Child Benefit per complete £200 of ANI over £60k) ──────
// 2026-27 Child Benefit (gov.uk, read 2026-06-20): eldest/only £27.05/wk, each
// other £17.90/wk; annual = weekly × 52. ITEPA 2003 s681C(3) rounds DOWN to a whole
// number at three points: the percentage, the CB total (floored FIRST), and the
// charge. Confirmed penny-exact vs TaxCalc on the golden set (incl. G30, the
// CB-floored-first discriminator). The charge is Income Tax due → in totalTax + POAs.

{ // H1. Profit £70,000, 1 child. ANI £70,000 → (70,000−60,000)/200 = 50%.
  //  CB = £27.05 × 52 = £1,406.60 → floor £1,406. Charge = floor(50% × £1,406) = £703.
  const e = calculateTaxEstimate({ taxYear: YEAR, nation: 'england-wales-ni', incomeReceived: 71_000, deductibleExpenses: 1_000, childBenefitChildren: 1 });
  check('H1 · ANI', e.adjustedNetIncome, 70_000);
  check('H1 · CB received', e.childBenefitReceived, 1_406.6);
  check('H1 · HICBC percent', e.hicbcPercent, 50);
  check('H1 · HICBC charge (s681C(3) floored)', e.hicbcCharge, 703);
  check('H1 · totalTax = IT + dividend + savings + HICBC + C4', e.totalTax, e.incomeTax + e.dividendTax + e.savingsTax + e.hicbcCharge + e.class4Nic);
}

{ // H2. Profit £75,000, 2 children. ANI £75,000 → 75%. CB = (27.05+17.90)×52 =
  //  £2,337.40 → floor £2,337. Charge = floor(75% × £2,337) = floor(£1,752.75) = £1,752
  //  (NOT £1,753.05 — CB floored before the % per s681C(3); golden G30 proved this).
  const e = calculateTaxEstimate({ taxYear: YEAR, nation: 'england-wales-ni', incomeReceived: 76_000, deductibleExpenses: 1_000, childBenefitChildren: 2 });
  check('H2 · CB received (2 children)', e.childBenefitReceived, 2_337.4);
  check('H2 · HICBC charge (CB floored first)', e.hicbcCharge, 1_752);
}

{ // H3. Profit £85,000, 3 children → ANI £85k ≥ £80k → 100% (full CB).
  //  CB = (27.05 + 2×17.90) × 52 = 62.85 × 52 = £3,268.20 → floor £3,268.
  const e = calculateTaxEstimate({ taxYear: YEAR, nation: 'england-wales-ni', incomeReceived: 86_000, deductibleExpenses: 1_000, childBenefitChildren: 3 });
  check('H3 · HICBC percent capped', e.hicbcPercent, 100);
  check('H3 · HICBC charge = floor(full CB)', e.hicbcCharge, 3_268);
}

{ // H4. Round-DOWN (ITEPA s681C): profit £62,500, 1 child. (62,500−60,000)/200
  //  = 12.5 → floor 12%, NOT 12.5%. Charge = floor(12% × £1,406) = floor(£168.72) = £168.
  const e = calculateTaxEstimate({ taxYear: YEAR, nation: 'england-wales-ni', incomeReceived: 63_500, deductibleExpenses: 1_000, childBenefitChildren: 1 });
  check('H4 · round-down percent', e.hicbcPercent, 12);
  check('H4 · round-down charge (floored)', e.hicbcCharge, 168);
}

{ // H5. No charge below the threshold / when no Child Benefit is claimed.
  const atThreshold = calculateTaxEstimate({ taxYear: YEAR, nation: 'england-wales-ni', incomeReceived: 61_000, deductibleExpenses: 1_000, childBenefitChildren: 2 });
  check('H5 · ANI £60,000 (at threshold) → £0', atThreshold.hicbcCharge, 0);
  const noClaim = calculateTaxEstimate({ taxYear: YEAR, nation: 'england-wales-ni', incomeReceived: 101_000, deductibleExpenses: 1_000 });
  check('H5 · no children claimed → £0', noClaim.hicbcCharge, 0);
  check('H5 · Scotland same charge as rUK (UK-wide)', calculateTaxEstimate({ taxYear: YEAR, nation: 'scotland', incomeReceived: 76_000, deductibleExpenses: 1_000, childBenefitChildren: 2 }).hicbcCharge, 1_752);
}

{ // H6. HICBC rides the POAs (SA110 keeps it in the base) — unlike the student
  //  loan. Profit £70,000, 2 children: HICBC = floor(50% × £2,337) = £1,168.50 → £1,168.
  //  POA each = totalTax/2 (no CIS), and exceeds the no-claim case by half the charge.
  const e = calculateTaxEstimate({ taxYear: YEAR, nation: 'england-wales-ni', incomeReceived: 71_000, deductibleExpenses: 1_000, childBenefitChildren: 2 });
  check('H6 · HICBC charge (floored)', e.hicbcCharge, 1_168);
  check('H6 · POA each = totalTax/2', e.paymentsOnAccount.each, e.totalTax / 2);
  const noKids = calculateTaxEstimate({ taxYear: YEAR, nation: 'england-wales-ni', incomeReceived: 71_000, deductibleExpenses: 1_000 });
  check('H6 · POA base lifted by half the charge', e.paymentsOnAccount.each - noKids.paymentsOnAccount.each, e.hicbcCharge / 2);
}

// ── Pension / Gift Aid relief (§V — relief at source, basic-rate band extension) ─
// NET contributions gross up at 20% (÷ 0.8); the gross widens the basic-rate band
// (higher/additional income drops to basic) and reduces adjusted net income (the PA
// taper + the §U HICBC). Applied to the combined position; Class 4 + student loan
// untouched. (Independently re-verified by the differential harness §8.)

{ // P1. rUK higher-rate sole trader: profit £80,000, NET pension £8,000 → gross
  //  £10,000. £10k of 40% income drops to 20% → relief 20% × 10,000 = £2,000.
  //  IT 19,432 → 17,432; Class 4 unchanged.
  const e = calculateTaxEstimate({ taxYear: YEAR, nation: 'england-wales-ni', incomeReceived: 81_000, deductibleExpenses: 1_000, pensionContributionsNet: 8_000 });
  check('P1 · grossed up (£8,000 ÷ 0.8)', e.reliefGrossedUp, 10_000);
  check('P1 · IT after band extension', e.incomeTax, 17_432);
  check('P1 · relief headline', e.pensionGiftAidRelief, 2_000);
  check('P1 · Class 4 unaffected', e.class4Nic, 2_856.6);
}

{ // P2. Gift Aid grosses up + extends the band identically: £8,000 net Gift Aid on
  //  the same profit gives the same £2,000 relief.
  const e = calculateTaxEstimate({ taxYear: YEAR, nation: 'england-wales-ni', incomeReceived: 81_000, deductibleExpenses: 1_000, giftAidDonationsNet: 8_000 });
  check('P2 · Gift Aid relief = pension relief', e.pensionGiftAidRelief, 2_000);
}

{ // P3. Scotland advanced-rate (45%) payer: profit £85,000, net pension £8,000 →
  //  gross £10,000. £10k of 45% income → 20%: relief 25% × 10,000 = £2,500.
  const e = calculateTaxEstimate({ taxYear: YEAR, nation: 'scotland', incomeReceived: 86_000, deductibleExpenses: 1_000, pensionContributionsNet: 8_000 });
  check('P3 · Scotland 45% → 25% top-up relief', e.pensionGiftAidRelief, 2_500);
}

{ // P4. The £100k PA-trap: profit £110,000, net pension £8,000 → gross £10,000 →
  //  ANI £100,000 → PA restored to £12,570 (£5k @ 40% = £2,000) PLUS the £10k band
  //  shift (£2,000) = £4,000 relief.
  const e = calculateTaxEstimate({ taxYear: YEAR, nation: 'england-wales-ni', incomeReceived: 111_000, deductibleExpenses: 1_000, pensionContributionsNet: 8_000 });
  check('P4 · PA restored by the lowered ANI', e.personalAllowance, 12_570);
  check('P4 · taper-zone relief', e.pensionGiftAidRelief, 4_000);
}

{ // P5. HICBC interaction: profit £70,000, 2 children, net pension £8,000 → gross
  //  £10,000 → ANI £60,000 → HICBC wiped from £1,168 (s681C(3) floored) to £0.
  const noPension = calculateTaxEstimate({ taxYear: YEAR, nation: 'england-wales-ni', incomeReceived: 71_000, deductibleExpenses: 1_000, childBenefitChildren: 2 });
  const e = calculateTaxEstimate({ taxYear: YEAR, nation: 'england-wales-ni', incomeReceived: 71_000, deductibleExpenses: 1_000, childBenefitChildren: 2, pensionContributionsNet: 8_000 });
  check('P5 · HICBC before pension', noPension.hicbcCharge, 1_168);
  check('P5 · pension cuts ANI to £60k', e.adjustedNetIncome, 60_000);
  check('P5 · HICBC wiped to £0', e.hicbcCharge, 0);
}

{ // P6. No contribution → byte-for-byte unchanged (zero relief, ANI unreduced).
  const e = calculateTaxEstimate({ taxYear: YEAR, nation: 'england-wales-ni', incomeReceived: 81_000, deductibleExpenses: 1_000 });
  check('P6 · no contribution · gross £0', e.reliefGrossedUp, 0);
  check('P6 · no contribution · relief £0', e.pensionGiftAidRelief, 0);
  check('P6 · IT matches the un-extended case', e.incomeTax, 19_432);
}

// ── taxReliefForDeduction — the "off your tax" win-lines ─────────────────────

{ // 14. rUK basic-rate payer (profit 30,000): £100 deduction = 20% + 6% = £26.
  const r = taxReliefForDeduction(
    { taxYear: YEAR, nation: 'england-wales-ni', incomeReceived: 35_000, deductibleExpenses: 5_000 },
    100,
  );
  check('14 relief rUK basic · £100', r, 26);
}

{ // 15. Band crossing at 50,270 (profit 50,300, £100 deduction):
  // IT: 30 @ 40% + 70 @ 20% = 26. C4: 30 @ 2% + 70 @ 6% = 4.80. Relief 30.80.
  const r = taxReliefForDeduction(
    { taxYear: YEAR, nation: 'england-wales-ni', incomeReceived: 55_300, deductibleExpenses: 5_000 },
    100,
  );
  check('15 relief rUK band-cross · £100', r, 30.8);
}

{ // 16. PA-taper zone (profit 100,100, £100 deduction): the 60%-effective band.
  // IT diff 60 (40% + taper unwind) + C4 2 = £62.
  const r = taxReliefForDeduction(
    { taxYear: YEAR, nation: 'england-wales-ni', incomeReceived: 105_100, deductibleExpenses: 5_000 },
    100,
  );
  check('16 relief rUK taper-zone · £100', r, 62);
}

{ // 17. Scotland basic (profit 25,000, taxable 12,430 → Scottish basic 20%):
  // £100 × (20% + 6%) = £26.
  const r = taxReliefForDeduction(
    { taxYear: YEAR, nation: 'scotland', incomeReceived: 30_000, deductibleExpenses: 5_000 },
    100,
  );
  check('17 relief scot basic · £100', r, 26);
}

{ // 18. Below all thresholds → no relief; the UI shows nothing, not £0.
  const r = taxReliefForDeduction(
    { taxYear: YEAR, nation: 'england-wales-ni', incomeReceived: 10_000, deductibleExpenses: 2_000 },
    100,
  );
  check('18 relief below thresholds', r, 0);
}

// ── Disclosure ───────────────────────────────────────────────────────────────

{ // 19. Asking about a year the rates file doesn't cover discloses the mismatch.
  const e = calculateTaxEstimate({
    taxYear: '2027-28', nation: 'england-wales-ni', incomeReceived: 30_000, deductibleExpenses: 5_000,
  });
  check('19 stale-year disclosure · taxYear', e.taxYear, '2027-28');
  check('19 stale-year disclosure · ratesTaxYear', e.ratesTaxYear, '2026-27');
}

// ── Other income (the onboarding "any other income?" answer) ─────────────────

{ // 20. £30,000 PAYE job + £25,000 profit (rUK). The job fills the allowance
  // and most of the basic band first, so the profit straddles into 40%:
  // taxable(other) = 17,430; taxable(total) = 42,430.
  // IT(total) = 37,700×20% + 4,730×40% = 7,540 + 1,892 = 9,432.
  // IT(other) = 17,430×20% = 3,486.  Attributable = 5,946
  //   (= 20,270 @ 20% [4,054] + 4,730 @ 40% [1,892]).
  // C4 unchanged: 745.80 (profit only). Total 6,691.80.
  const e = calculateTaxEstimate({
    taxYear: YEAR, nation: 'england-wales-ni',
    incomeReceived: 30_000, deductibleExpenses: 5_000, otherTaxableIncome: 30_000,
  });
  check('20 other-income · IT', e.incomeTax, 5_946);
  check('20 other-income · C4', e.class4Nic, 745.8);
  check('20 other-income · total', e.totalTax, 6_691.8);
  check('20 other-income · band count', e.incomeTaxBands.length, 2);
  checkReconciles('20', e);
}

{ // 21. £90,000 salary + £20,000 profit — the profit DRAGS the taper:
  // PA(other alone, ANI 90,000) = 12,570 → taxable 77,430,
  //   IT(other) = 7,540 + 39,730×40% = 23,432 (≈ what PAYE collects).
  // PA(total, ANI 110,000) = 7,570 → taxable 102,430,
  //   IT(total) = 7,540 + 64,730×40% = 33,432.
  // Attributable = 10,000 (the 60%-effective zone: 20,000 @ 40% + 5,000
  // of allowance unwound @ 40%). C4 = (20,000 − 12,570)×6% = 445.80.
  const e = calculateTaxEstimate({
    taxYear: YEAR, nation: 'england-wales-ni',
    incomeReceived: 25_000, deductibleExpenses: 5_000, otherTaxableIncome: 90_000,
  });
  check('21 taper-drag · PA', e.personalAllowance, 7_570);
  check('21 taper-drag · IT', e.incomeTax, 10_000);
  check('21 taper-drag · exposure exceeds profit', e.taxableAfterAllowance, 25_000);
  check('21 taper-drag · C4', e.class4Nic, 445.8);
  checkReconciles('21', e);
}

// ── Student loans (§O) ───────────────────────────────────────────────────────

{ // 22. Plan 2, £40,000 profit, no other income:
  // SL = 9% × (40,000 − 29,385) = 9% × 10,615 = 955.35. Excluded from totalTax,
  // included in totalOwed.
  const e = calculateTaxEstimate({
    taxYear: YEAR, nation: 'england-wales-ni',
    incomeReceived: 45_000, deductibleExpenses: 5_000, studentLoanPlan: 'plan2',
  });
  check('22 plan2 · SL', e.studentLoan, 955.35);
  check('22 plan2 · totalOwed', e.totalOwed, e.totalTax + 955.35);
  checkReconciles('22', e);
}

{ // 23. Plan 2 + Postgraduate Loan, £40,000 profit:
  // 955.35 + 6% × (40,000 − 21,000) = 955.35 + 1,140 = 2,095.35.
  const e = calculateTaxEstimate({
    taxYear: YEAR, nation: 'england-wales-ni',
    incomeReceived: 45_000, deductibleExpenses: 5_000, studentLoanPlan: 'plan2', postgradLoan: true,
  });
  check('23 plan2+PGL · SL', e.studentLoan, 2_095.35);
}

{ // 24. Plan 1 with a £20,000 PAYE job + £20,000 profit: PAYE already repays on
  // the salary BELOW the threshold (£20,000 < £26,900 → repays £0), so SA
  // collects on the whole excess: 9% × (40,000 − 26,900) = 1,179.
  const e = calculateTaxEstimate({
    taxYear: YEAR, nation: 'england-wales-ni',
    incomeReceived: 25_000, deductibleExpenses: 5_000,
    otherTaxableIncome: 20_000, studentLoanPlan: 'plan1',
  });
  check('24 plan1 + other · SL', e.studentLoan, 1_179);
}

{ // 25. No plan set → £0, and relief helper unaffected.
  const e = calculateTaxEstimate({
    taxYear: YEAR, nation: 'england-wales-ni', incomeReceived: 45_000, deductibleExpenses: 5_000,
  });
  check('25 no plan · SL', e.studentLoan, 0);
  check('25 no plan · totalOwed=totalTax', e.totalOwed, e.totalTax);
}

{ // 26. Relief includes the loan: Plan 2 payer at £40,000 profit, £100 deduction
  // = 20% IT + 6% C4 + 9% SL = £35.
  const r = taxReliefForDeduction(
    {
      taxYear: YEAR, nation: 'england-wales-ni',
      incomeReceived: 45_000, deductibleExpenses: 5_000, studentLoanPlan: 'plan2',
    },
    100,
  );
  check('26 relief incl. SL · £100', r, 35);
}

// ── Payments on account (§N) ─────────────────────────────────────────────────

{ // 27. Profit £25,000 → bill £3,231.80 ≥ £1,000 → POA required, each £1,615.90.
  // First-year 31 Jan: 3,231.80 + 1,615.90 = £4,847.70 (the 150% surprise).
  const e = rUK(30_000, 5_000);
  check('27 POA · required', String(e.paymentsOnAccount.required), 'true');
  check('27 POA · each', e.paymentsOnAccount.each, 1_615.9);
  check('27 POA · first-year January', e.firstYearJanuaryTotal, 4_847.7);
}

{ // 28. Profit £16,000 → IT 686 + C4 205.80 = £891.80 < £1,000 → no POAs;
  // January = just the bill.
  const e = rUK(18_000, 2_000);
  check('28 POA · not required', String(e.paymentsOnAccount.required), 'false');
  check('28 POA · each', e.paymentsOnAccount.each, 0);
  check('28 POA · first-year January', e.firstYearJanuaryTotal, 891.8);
}

{ // 29. Student loan rides the balancing payment, NOT the POAs (§N verbatim):
  // plan 2, profit £40,000: bill (IT+C4) = 5,486 + 1,645.80 = 7,131.80;
  //   IT = (40,000−12,570)×20% = 5,486; C4 = 27,430×6% = 1,645.80.
  // POA each = 3,565.90 (no SL inside). January = 7,131.80 + 955.35 + 3,565.90.
  const e = calculateTaxEstimate({
    taxYear: YEAR, nation: 'england-wales-ni',
    incomeReceived: 45_000, deductibleExpenses: 5_000, studentLoanPlan: 'plan2',
  });
  check('29 POA excl. SL · each', e.paymentsOnAccount.each, 3_565.9);
  check('29 POA excl. SL · first-year January', e.firstYearJanuaryTotal, 11_653.05);
}

// ── CIS netting (§I + SALF303 — deductions withheld are advance payments) ────

{ // 32. Typical CIS subbie, withholding covers the whole bill → refund, no POAs.
  // Profit £35,000 (40,000 − 5,000): IT = 22,430 × 20% = 4,486;
  // C4 = 22,430 × 6% = 1,345.80; totalTax = totalOwed = 5,831.80.
  // CIS withheld £7,200 (20% on £36,000 of labour): relevant = max(0,
  // 5,831.80 − 7,200) = 0 < £1,000 → no POAs. Balancing £0;
  // refund 7,200 − 5,831.80 = 1,368.20. January total £0.
  const e = calculateTaxEstimate({
    taxYear: YEAR, nation: 'england-wales-ni',
    incomeReceived: 40_000, deductibleExpenses: 5_000, cisDeductionsWithheld: 7_200,
  });
  check('32 CIS full cover · totalOwed (gross)', e.totalOwed, 5_831.8);
  check('32 CIS full cover · balancing', e.balancingPayment, 0);
  check('32 CIS full cover · refund', e.cisRefundDue, 1_368.2);
  check('32 CIS full cover · POA required', String(e.paymentsOnAccount.required), 'false');
  check('32 CIS full cover · January', e.firstYearJanuaryTotal, 0);
  checkReconciles('32', e);
}

{ // 33. Partial cover: same profit, CIS withheld £4,000.
  // Relevant = 5,831.80 − 4,000 = 1,831.80 ≥ £1,000, and 1,831.80/5,831.80
  // = 0.314 ≥ 1/5 → POAs required, each = 915.90 (half the RELEVANT amount,
  // SALF303 — not half the gross bill). Balancing 1,831.80;
  // January = 1,831.80 + 915.90 = 2,747.70.
  const e = calculateTaxEstimate({
    taxYear: YEAR, nation: 'england-wales-ni',
    incomeReceived: 40_000, deductibleExpenses: 5_000, cisDeductionsWithheld: 4_000,
  });
  check('33 CIS partial · balancing', e.balancingPayment, 1_831.8);
  check('33 CIS partial · refund', e.cisRefundDue, 0);
  check('33 CIS partial · POA required', String(e.paymentsOnAccount.required), 'true');
  check('33 CIS partial · POA each (net basis)', e.paymentsOnAccount.each, 915.9);
  check('33 CIS partial · January', e.firstYearJanuaryTotal, 2_747.7);
}

{ // 34. The SALF303 "1 to 5" proportion test: >80% met at source kills POAs even
  // when the relevant amount clears £1,000. Profit £50,000 (55,000 − 5,000):
  // IT = 37,430 × 20% = 7,486; C4 = 37,430 × 6% = 2,245.80; totalTax 9,731.80.
  // CIS £8,200: relevant = 1,531.80 ≥ £1,000 BUT 1,531.80/9,731.80 = 0.157 < 0.2
  // → no POAs. January = balancing only = 1,531.80.
  const e = calculateTaxEstimate({
    taxYear: YEAR, nation: 'england-wales-ni',
    incomeReceived: 55_000, deductibleExpenses: 5_000, cisDeductionsWithheld: 8_200,
  });
  check('34 CIS 80%-at-source · totalTax', e.totalTax, 9_731.8);
  check('34 CIS 80%-at-source · POA required', String(e.paymentsOnAccount.required), 'false');
  check('34 CIS 80%-at-source · January', e.firstYearJanuaryTotal, 1_531.8);
}

{ // 35. Student loan rides the balancing payment and IS netted by CIS (the SA
  // calculation deducts at-source tax from the TOTAL liability). Plan 2,
  // profit £35,000: SL = (35,000 − 29,385) × 9% = 505.35; totalOwed = 6,337.15.
  // CIS £6,000: relevant (IT+C4 only) = max(0, 5,831.80 − 6,000) = 0 → no POAs.
  // Balancing = 6,337.15 − 6,000 = 337.15 (the SL remainder); refund £0.
  const e = calculateTaxEstimate({
    taxYear: YEAR, nation: 'england-wales-ni',
    incomeReceived: 40_000, deductibleExpenses: 5_000,
    studentLoanPlan: 'plan2', cisDeductionsWithheld: 6_000,
  });
  check('35 CIS + SL · totalOwed (gross)', e.totalOwed, 6_337.15);
  check('35 CIS + SL · balancing', e.balancingPayment, 337.15);
  check('35 CIS + SL · refund', e.cisRefundDue, 0);
  check('35 CIS + SL · POA required', String(e.paymentsOnAccount.required), 'false');
  check('35 CIS + SL · January', e.firstYearJanuaryTotal, 337.15);
}

{ // 36. No CIS → identical to example 27 (regression: the relevant amount
  // equals the gross bill when nothing is withheld); negative input guarded.
  const e = calculateTaxEstimate({
    taxYear: YEAR, nation: 'england-wales-ni',
    incomeReceived: 30_000, deductibleExpenses: 5_000, cisDeductionsWithheld: 0,
  });
  check('36 CIS zero · each', e.paymentsOnAccount.each, 1_615.9);
  check('36 CIS zero · January', e.firstYearJanuaryTotal, 4_847.7);
  check('36 CIS zero · balancing = totalOwed', e.balancingPayment, e.totalOwed);
  const g = calculateTaxEstimate({
    taxYear: YEAR, nation: 'england-wales-ni',
    incomeReceived: 30_000, deductibleExpenses: 5_000, cisDeductionsWithheld: -50,
  });
  check('36 CIS negative guard · treated as 0', g.cisDeductionsWithheld, 0);
  check('36 CIS negative guard · January', g.firstYearJanuaryTotal, 4_847.7);
}

// ── Mileage flat rate (§E — 55p for 2026-27, RAISED from 45p) ────────────────

{ // 30. HMRC's own worked example from the live page (read 2026-06-10):
  // "10,000 miles x 55p = £5,500. 1,000 miles x 25p = £250. Total = £5,750".
  check('30 mileage · HMRC worked example', calculateMileageAllowance(11_000, 0), 5_750);
  // Crossing the threshold mid-trip: 9,500 cumulative + 1,000-mile trip
  // = 500×55p + 500×25p = £400.
  check('30 mileage · threshold crossing', calculateMileageAllowance(1_000, 9_500), 400);
  // Fully over the threshold: 100 miles at 25p = £25.
  check('30 mileage · over threshold', calculateMileageAllowance(100, 12_000), 25);
  // Zero and negative guard.
  check('30 mileage · zero', calculateMileageAllowance(0, 0), 0);
}

// ── Rounding reconciliation (display helper) ─────────────────────────────────

{ // 31. Lines that each round up would overshoot the total — the helper must
  // keep sum(lines) === total. 2,486.4 + 745.8 → total 3,232 (3,232.2 rounds
  // down); naive rounding gives 2,486 + 746 = 3,232 ✓; adversarial case:
  // 1.5 + 1.5 + 1.5 → total 5 (4.5 rounds to 5 banker-free), lines must sum 5.
  const a = roundBreakdownPounds([2_486.4, 745.8]);
  check('31 rounding · sum equals total (a)', a.lines[0] + a.lines[1], a.total);
  const b = roundBreakdownPounds([1.5, 1.5, 1.5]);
  check('31 rounding · sum equals total (b)', b.lines.reduce((s, v) => s + v, 0), b.total);
  check('31 rounding · total (b)', b.total, 5);
  const c = roundBreakdownPounds([0.3, 0.3, 0.4]);
  check('31 rounding · sum equals total (c)', c.lines.reduce((s, v) => s + v, 0), c.total);
}

{ // 32. Per-line STABILITY (no cross-scenario wobble). A line's whole-pound
  // display must depend ONLY on its own value — never on the other lines on
  // screen. Regression for the £2,807-vs-£2,808 NI flip: NI of £x.60 must always
  // show £x+1 (natural half-up), whether or not a HICBC line sits beside it, and
  // the unavoidable ±£1 reconciliation pound must land on the largest line.
  const withHicbc = roundBreakdownPounds([18_052.0, 2_460.6, 1_916.0, 11_377.8]);
  const noHicbc = roundBreakdownPounds([18_052.0, 2_460.6, 11_377.8]);
  check('32 stability · NI shows half-up with HICBC', withHicbc.lines[1], 2_461);
  check('32 stability · NI shows half-up without HICBC', noHicbc.lines[1], 2_461);
  check('32 stability · small lines untouched (HICBC)', withHicbc.lines[2], 1_916);
  // The residual settles on the largest line (Income Tax), never the small ones.
  check('32 stability · residual on largest line', withHicbc.lines[0], 18_051);
  check('32 stability · sum still equals total', withHicbc.lines.reduce((s, v) => s + v, 0), withHicbc.total);
  // Every line except the largest equals its own half-up rounding, regardless of neighbours.
  for (const profile of [
    [9_999.5, 2_787.6, 2_033.4],
    [9_999.5, 2_787.6, 2_033.4, 6_400.5],
    [40_000.0, 2_787.6, 500.5, 500.5],
  ]) {
    const r = roundBreakdownPounds(profile);
    const largest = profile.reduce((bi, v, i) => (Math.abs(v) > Math.abs(profile[bi]) ? i : bi), 0);
    profile.forEach((v, i) => {
      if (i !== largest) check(`32 stability · line ${v} natural half-up`, r.lines[i], Math.round(v));
    });
    check(`32 stability · profile reconciles`, r.lines.reduce((s, v) => s + v, 0), r.total);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
if (failures > 0) {
  console.error(`\n❌ ${failures}/${checks} checks FAILED`);
  process.exit(1);
}
console.log(`✅ All ${checks} checks passed (worked examples incl. dividends/savings/HICBC, rates 2026-27)`);
