/**
 * golden-set/scenarios.ts — the curated cross-check set for an EXTERNAL oracle.
 *
 * WHY: every automated check we run (worked examples, harness, fuzz, cooltaxtool)
 * confirms the engine agrees with OUR OWN reading of the rules. The one residual
 * risk (coverage_matrix §6 #1) is a SHARED MISREADING of the hard savings ↔
 * dividends ↔ starting-rate/PSA/allowance ↔ PA-allocation interaction, which no
 * free oracle covers. The fix is an HMRC-RECOGNISED Self Assessment package as the
 * judge: type these scenarios into it, read off its tax, diff against the engine.
 *
 * These ~30 scenarios are deliberately weighted to that hard corner (low-income +
 * savings + dividends where the beneficial PA allocation bites, both nations, the
 * £100k taper, HICBC, pension band-extension) — not the easy mainstream cases the
 * existing tests already nail.
 *
 * Flow:
 *   npm run golden:worksheet   → a BLIND worksheet (inputs only) + a blank results CSV
 *   (you enter each scenario into the SA package, record its figures in the CSV)
 *   npm run golden:compare     → diffs your CSV against the engine, flags mismatches
 *
 * Convention: to make a clean "taxable profit = £P", incomeReceived = P + 1,000 and
 * deductibleExpenses = 1,000 (so the £1,000 trading allowance never engages). Other
 * income / student loan / CIS are kept at 0 so the package entry stays simple and the
 * engine's `incomeTax` is the full income tax on profit (nothing netted out).
 */

import { calculateTaxEstimate, type TaxEstimate, type UKNation } from '../../src/tax';

export interface Scenario {
  id: string;
  note: string; // the angle this case probes
  nation: UKNation;
  profit: number; // taxable self-employment profit
  savings?: number; // savings interest
  dividends?: number; // dividend income
  pensionNet?: number; // net personal pension contribution (relief at source)
  giftAidNet?: number; // net Gift Aid donation
  children?: number; // children claimed Child Benefit for (drives HICBC)
}

export const SCENARIOS: Scenario[] = [
  // ── Mainstream sanity (the existing tests already cover these; included so a
  //    gross package-vs-engine mismatch shows up before the hard cases) ──────────
  { id: 'G01', note: 'Plain basic-rate trader', nation: 'england-wales-ni', profit: 30_000 },
  { id: 'G02', note: 'Higher-rate trader', nation: 'england-wales-ni', profit: 60_000 },
  { id: 'G03', note: 'Plain trader, Scotland', nation: 'scotland', profit: 30_000 },

  // ── Savings: starting-rate band + PSA by top rate, both nations ───────────────
  { id: 'G04', note: 'gov.uk example: £16k + £200 interest → £0 (starting-rate band)', nation: 'england-wales-ni', profit: 16_000, savings: 200 },
  { id: 'G05', note: 'PSA basic: £30k + £2k interest', nation: 'england-wales-ni', profit: 30_000, savings: 2_000 },
  { id: 'G06', note: 'Starting-rate band partly used: £13k + £6k interest', nation: 'england-wales-ni', profit: 13_000, savings: 6_000 },
  { id: 'G07', note: 'PSA higher (£500): £60k + £2k interest', nation: 'england-wales-ni', profit: 60_000, savings: 2_000 },
  { id: 'G08', note: 'PSA nil (additional): £130k + £2k interest', nation: 'england-wales-ni', profit: 130_000, savings: 2_000 },
  { id: 'G09', note: 'Savings UK-rated under Scottish bands: £30k + £2k', nation: 'scotland', profit: 30_000, savings: 2_000 },
  { id: 'G10', note: 'Scotland higher + savings: £50k + £5k', nation: 'scotland', profit: 50_000, savings: 5_000 },

  // ── Dividends: £500 allowance + ordinary/upper/additional, both nations ───────
  { id: 'G11', note: 'gov.uk example: £29,570 + £3,000 dividends → £268.75', nation: 'england-wales-ni', profit: 29_570, dividends: 3_000 },
  { id: 'G12', note: 'Dividends ordinary→upper: £45k + £20k', nation: 'england-wales-ni', profit: 45_000, dividends: 20_000 },
  { id: 'G13', note: 'Dividends UK-rated under Scottish bands: £45k + £20k', nation: 'scotland', profit: 45_000, dividends: 20_000 },
  { id: 'G14', note: 'Dividends upper→additional + £100k taper: £120k + £30k', nation: 'england-wales-ni', profit: 120_000, dividends: 30_000 },
  { id: 'G15', note: 'Dividends use leftover PA: £10k + £10k', nation: 'england-wales-ni', profit: 10_000, dividends: 10_000 },

  // ── Beneficial PA allocation (ITA 2007 s25(2)) — the #1 risk corner ───────────
  { id: 'G16', note: 'Beneficial split (B1): £5k profit + £5k savings + £10k dividends → £207.48', nation: 'england-wales-ni', profit: 5_000, savings: 5_000, dividends: 10_000 },
  { id: 'G17', note: 'Beneficial split, Scotland: £5k + £5k savings + £10k dividends', nation: 'scotland', profit: 5_000, savings: 5_000, dividends: 10_000 },
  { id: 'G18', note: 'Beneficial: £2.5k + £2k savings + £10k dividends', nation: 'england-wales-ni', profit: 2_500, savings: 2_000, dividends: 10_000 },
  { id: 'G19', note: 'Beneficial, no profit: £0 + £5k savings + £15k dividends', nation: 'england-wales-ni', profit: 0, savings: 5_000, dividends: 15_000 },
  { id: 'G20', note: 'Higher-rate interaction: £45k + £1k savings + £8k dividends', nation: 'england-wales-ni', profit: 45_000, savings: 1_000, dividends: 8_000 },

  // ── £100k taper zone with investment income (+ the s35(3) odd-pound round-up) ─
  { id: 'G21', note: 'Taper + PSA: £100k + £5k savings', nation: 'england-wales-ni', profit: 100_000, savings: 5_000 },
  { id: 'G22', note: 'Taper + dividends: £110k + £10k', nation: 'england-wales-ni', profit: 110_000, dividends: 10_000 },
  { id: 'G23', note: 'Odd-pound taper (s35(3) round-up): £100,417', nation: 'england-wales-ni', profit: 100_417 },

  // ── HICBC (charge inside the bill) ────────────────────────────────────────────
  { id: 'G24', note: 'HICBC partial: £65k, 1 child', nation: 'england-wales-ni', profit: 65_000, children: 1 },
  { id: 'G25', note: 'HICBC + dividends: £70k + £5k, 2 children', nation: 'england-wales-ni', profit: 70_000, dividends: 5_000, children: 2 },
  { id: 'G26', note: 'HICBC 100%: £85k, 3 children', nation: 'england-wales-ni', profit: 85_000, children: 3 },

  // ── Pension band-extension interacting with the above ─────────────────────────
  { id: 'G27', note: 'Pension band-extension: £60k + £10k net pension', nation: 'england-wales-ni', profit: 60_000, pensionNet: 10_000 },
  { id: 'G28', note: 'Pension lowers HICBC: £70k + £5k net pension, 2 children', nation: 'england-wales-ni', profit: 70_000, pensionNet: 5_000, children: 2 },
  { id: 'G29', note: 'Scotland + savings + pension: £50k + £5k savings + £5k net pension', nation: 'scotland', profit: 50_000, savings: 5_000, pensionNet: 5_000 },

  // ── Everything-on hard case ───────────────────────────────────────────────────
  { id: 'G30', note: 'All at once, Scotland: £75k + £3k savings + £8k dividends + £6k net pension, 2 children', nation: 'scotland', profit: 75_000, savings: 3_000, dividends: 8_000, pensionNet: 6_000, children: 2 },
];

/** The numbers we compare against the package, computed by the engine. With other
 *  income / student loan / CIS all zero, `incomeTax` is the full income tax on profit,
 *  so incomeTax(all sources) = incomeTax + savingsTax + dividendTax. */
export interface Figures {
  incomeTax: number; // income tax on non-savings + savings + dividends (EXCL HICBC)
  hicbc: number; // High Income Child Benefit Charge
  class4: number; // Class 4 NIC
  total: number; // total tax to set aside (= incomeTax + hicbc + class4; Class 2 £0, no SL/CIS)
}

export function runEngine(s: Scenario): { estimate: TaxEstimate; figures: Figures } {
  const estimate = calculateTaxEstimate({
    taxYear: '2026-27',
    nation: s.nation,
    incomeReceived: s.profit + 1_000,
    deductibleExpenses: 1_000,
    savingsIncome: s.savings ?? 0,
    dividendIncome: s.dividends ?? 0,
    pensionContributionsNet: s.pensionNet ?? 0,
    giftAidDonationsNet: s.giftAidNet ?? 0,
    childBenefitChildren: s.children ?? 0,
  });
  const figures: Figures = {
    incomeTax: round2(estimate.incomeTax + estimate.savingsTax + estimate.dividendTax),
    hicbc: round2(estimate.hicbcCharge),
    class4: round2(estimate.class4Nic),
    total: round2(estimate.totalTax),
  };
  return { estimate, figures };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Human-readable "what to enter into the SA package" for a scenario. */
export function entryLines(s: Scenario): string[] {
  const lines = [`Self-employment taxable profit:  £${s.profit.toLocaleString()}`];
  if (s.savings) lines.push(`Savings interest (untaxed):      £${s.savings.toLocaleString()}`);
  if (s.dividends) lines.push(`Dividend income:                 £${s.dividends.toLocaleString()}`);
  if (s.pensionNet) lines.push(`Personal pension paid (NET):     £${s.pensionNet.toLocaleString()}  (relief at source)`);
  if (s.giftAidNet) lines.push(`Gift Aid donations (NET):        £${s.giftAidNet.toLocaleString()}`);
  if (s.children) lines.push(`Child Benefit — children:        ${s.children}  (you are the higher earner)`);
  lines.push(`Resident in:                     ${s.nation === 'scotland' ? 'Scotland' : 'England / Wales / NI'}`);
  return lines;
}
