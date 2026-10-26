/**
 * golden-set/reference.ts — compute OUR figures for a scenario on a chosen tax year,
 * so they can be diffed against TaxCalc.
 *
 * WHY A 2025-26 PATH: TaxCalc's full 2026-27 edition isn't out until ~March 2027 and
 * its "What If? Planner" doesn't yet have 2026-27 rates loaded. So we validate the
 * ENGINE'S LOGIC against TaxCalc's accurate 2025-26 computation. The interaction rules
 * we care about (beneficial PA allocation, savings starting-rate band + PSA, dividend
 * stacking, Scotland) are structurally identical across the two years — ONLY three
 * figures changed, all already verbatim in compliance_sources.md:
 *   • dividend ordinary/upper rates  10.75/35.75 (2026-27)  ←  8.75/33.75 (2025-26)  [§S]
 *   • Child Benefit weekly  £27.05/£17.90 (2026-27)  ←  £26.05/£17.25 (2025-26)       [§U]
 *   • Scottish starter/basic ceilings  £16,537/£29,526 (2026-27) ← £15,397/£27,491    [§P/§K]
 * Everything else (PA, taper, rUK bands, savings rates/bands/PSA, Class 4, pension
 * relief, HICBC thresholds, trading allowance) is FROZEN across both years.
 *
 * The income-tax stack reuses scripts/_ref-beneficial.ts — the SAME engine-independent
 * reference the test suite proves equal to the production engine — with the year's rates
 * injected. The SELF-CHECK below proves referenceFigures(·, 2026-27) == the production
 * engine on every scenario, so the 2025-26 numbers are genuinely "our engine's logic on
 * 2025-26", not a separate calculator.
 */

import type { UKNation } from '../../src/tax';
import { refAllocate, refTaxForSplit, type RefRates } from '../_ref-beneficial';
import { SCENARIOS, runEngine, type Scenario, type Figures } from './scenarios';

export type TaxYear = '2025-26' | '2026-27';

interface YearRates {
  rukBands: [number, number][]; // [upToTaxable, rate]
  scotBands: [number, number][]; // [upToTaxable, rate]
  divRates: [number, number, number];
  savRates: [number, number, number];
  divAllowance: number;
  startingRateBand: number;
  psaBasic: number;
  psaHigher: number;
  ukBasic: number;
  ukHigher: number;
  c4Lower: number;
  c4Upper: number;
  c4Main: number;
  c4Addl: number;
  hicbcThreshold: number;
  hicbcUpper: number;
  hicbcStep: number;
  cbEldest: number; // weekly
  cbOther: number; // weekly
  cbWeeks: number;
  reliefRate: number;
}

// Frozen-across-both-years figures, factored out so the deltas are obvious.
const FROZEN = {
  rukBands: [[37_700, 0.2], [125_140, 0.4], [Infinity, 0.45]] as [number, number][],
  savRates: [0.2, 0.4, 0.45] as [number, number, number],
  divAllowance: 500,
  startingRateBand: 5_000,
  psaBasic: 1_000,
  psaHigher: 500,
  ukBasic: 37_700,
  ukHigher: 125_140,
  c4Lower: 12_570,
  c4Upper: 50_270,
  c4Main: 0.06,
  c4Addl: 0.02,
  hicbcThreshold: 60_000,
  hicbcUpper: 80_000,
  hicbcStep: 200,
  cbWeeks: 52,
  reliefRate: 0.2,
};

// Scottish bands as TAXABLE-income ceilings (income ceiling − £12,570 PA; the top
// boundary is £125,140 of TAXABLE income per ITA 2007 s10). Rates 19/20/21/42/45/48
// unchanged across both years — only the starter + basic ceilings moved.
const SCOT_2026_27: [number, number][] = [[3_967, 0.19], [16_956, 0.2], [31_092, 0.21], [62_430, 0.42], [125_140, 0.45], [Infinity, 0.48]];
const SCOT_2025_26: [number, number][] = [[2_827, 0.19], [14_921, 0.2], [31_092, 0.21], [62_430, 0.42], [125_140, 0.45], [Infinity, 0.48]];

const RATES: Record<TaxYear, YearRates> = {
  '2026-27': {
    ...FROZEN,
    scotBands: SCOT_2026_27,
    divRates: [0.1075, 0.3575, 0.3935],
    cbEldest: 27.05,
    cbOther: 17.9,
  },
  '2025-26': {
    ...FROZEN,
    scotBands: SCOT_2025_26,
    divRates: [0.0875, 0.3375, 0.3935],
    cbEldest: 26.05,
    cbOther: 17.25,
  },
};

const round2 = (n: number): number => Math.round(n * 100) / 100;
// ITA 2007 s35(3): tapered PA rounds UP to a whole £1 (frozen PA £12,570, £100k taper).
const taperedPA = (ani: number): number => Math.ceil(Math.max(0, 12_570 - Math.max(0, ani - 100_000) / 2));

function buildRefRates(y: YearRates, nation: UKNation, ext: number): RefRates {
  const base = nation === 'scotland' ? y.scotBands : y.rukBands;
  const basicIdx = base.findIndex(([, r]) => r >= 0.2 - 1e-9);
  return {
    schedule: base.map(([lim, r], i): [number, number] => (i >= basicIdx && Number.isFinite(lim) ? [lim + ext, r] : [lim, r])),
    nationEdges: base.map(([lim]) => lim).filter(Number.isFinite),
    ukBasic: y.ukBasic + ext,
    ukHigher: y.ukHigher + ext,
    savRates: y.savRates,
    divRates: y.divRates,
    divAllowance: y.divAllowance,
    startingRateBand: y.startingRateBand,
    psaBasic: y.psaBasic,
    psaHigher: y.psaHigher,
    psaAdditional: 0,
  };
}

/** Our figures for a scenario on the given tax year — same composition as the engine
 *  (no other income / student loan / CIS in these scenarios, so incomeTax is the full
 *  income tax on profit and total = incomeTax + hicbc + class4; Class 2 £0). */
export function referenceFigures(s: Scenario, year: TaxYear): Figures {
  const y = RATES[year];
  const profit = s.profit;
  const savings = s.savings ?? 0;
  const dividends = s.dividends ?? 0;
  const children = s.children ?? 0;
  const ext = ((s.pensionNet ?? 0) + (s.giftAidNet ?? 0)) / (1 - y.reliefRate); // §V grossed-up relief
  const ani = Math.max(0, profit + savings + dividends - ext);

  const r = buildRefRates(y, s.nation, ext);
  const allowance = taperedPA(ani);
  const parts = refTaxForSplit(refAllocate(profit, savings, dividends, allowance, r), r);
  const incomeTax = parts.nsTax + parts.savTax + parts.divTax;

  const class4 = Math.max(0, Math.min(profit, y.c4Upper) - y.c4Lower) * y.c4Main + Math.max(0, profit - y.c4Upper) * y.c4Addl;

  const cb = children > 0 ? (y.cbEldest + (children - 1) * y.cbOther) * y.cbWeeks : 0;
  const pct = cb > 0 && ani > y.hicbcThreshold ? Math.min(100, Math.floor((ani - y.hicbcThreshold) / y.hicbcStep)) : 0;
  // ITEPA 2003 s681C(3): the CB total and the charge are each rounded DOWN to a whole
  // £ (CB floored first). Confirmed vs TaxCalc on 2025-26 (golden G24/25/26/28/30).
  const hicbc = Math.floor(Math.floor(cb) * (pct / 100));

  return {
    incomeTax: round2(incomeTax),
    hicbc: round2(hicbc),
    class4: round2(class4),
    total: round2(incomeTax + hicbc + class4),
  };
}

/** SELF-CHECK: prove this reference reproduces the PRODUCTION engine on 2026-27 across
 *  every scenario. If it does, its 2025-26 output is the engine's logic on 2025-26 —
 *  not a separate calculator. Returns the list of any disagreements. */
export function selfCheck(): string[] {
  const fails: string[] = [];
  for (const s of SCENARIOS) {
    const ref = referenceFigures(s, '2026-27');
    const eng = runEngine(s).figures;
    for (const k of ['incomeTax', 'hicbc', 'class4', 'total'] as (keyof Figures)[]) {
      if (Math.abs(ref[k] - eng[k]) >= 0.005) {
        fails.push(`${s.id} ${k}: reference £${ref[k].toFixed(2)} vs engine £${eng[k].toFixed(2)}`);
      }
    }
  }
  return fails;
}

// Run directly (tsx scripts/golden-set/reference.ts) → just run the self-check.
if (import.meta.url === `file://${process.argv[1]}`) {
  const fails = selfCheck();
  if (fails.length) {
    console.error(`❌ reference != production engine on 2026-27 (${fails.length}):`);
    for (const f of fails) console.error(`   ${f}`);
    process.exit(1);
  }
  console.log(`✅ reference == production engine on 2026-27 across all ${SCENARIOS.length} scenarios — 2025-26 mode is the engine's logic.`);
}
