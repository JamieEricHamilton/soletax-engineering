/**
 * test-tax-selectors.ts — the worked-example test set for the estimate-input
 * selectors (src/tax/selectors.ts). The engine's arithmetic is protected by
 * scripts/test-tax-engine.ts; THESE checks protect the wiring — the rules that
 * decide which jobs/receipts/miles count. A selector bug produces a
 * plausible-looking wrong estimate, so every rule and every guard has a case.
 *
 * Run:  npx tsx scripts/test-tax-selectors.ts   (or: npm run test:tax)
 */

import {
  calculateTaxEstimate,
  classifyReceiptForEstimate,
  combineMtdStarts,
  estimateExclusions,
  isTaxSetupComplete,
  monthlySetAside,
  nextPaidState,
  mtdStartForPriorYear,
  mtdStartForSetup,
  mtdStartForTurnoverBand,
  reliefForDeductionSlice,
  selectEstimateInputs,
  taxReliefForDeduction,
  taxSetupAnsweredCount,
  taxSetupAnswers,
  toTaxEstimateInput,
  toTaxProfile,
  homeFlatRateAnnual,
  homeFlatRateMonthly,
  starterMilesTaxYear,
  yearStarterForYear,
  type EstimateInputs,
  type MtdStart,
  type UseOfHomeBand,
  type YearStarterDeclared,
} from '../src/tax';
import { buildProfitIndex, estimateFlags, homeFigures, monthlyProfitSeries, yearProfitPence, type EstimateFlags } from '../src/lib/dashboardData';
import type { Job, OtherIncome } from '../src/income/types';
import type { HMRCCategory, Receipt } from '../src/receipts/types';

let failures = 0;
let checks = 0;

function close(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.005; // half a penny — float tolerance only
}

function check(name: string, actual: number | string | boolean, expected: number | string | boolean) {
  checks++;
  const ok = typeof actual === 'number' && typeof expected === 'number'
    ? close(actual, expected)
    : actual === expected;
  if (!ok) {
    failures++;
    console.error(`  ✗ ${name}: expected ${expected}, got ${actual}`);
  }
}

/** Internal consistency every selection must satisfy. */
function checkSelectionReconciles(name: string, s: EstimateInputs) {
  check(
    `${name} · income £ = (pence + starter)/100`,
    s.incomeReceived,
    (s.incomeReceivedPence + s.yearStarterIncomePence) / 100,
  );
  check(
    `${name} · deductions £ = (pence + starter)/100 + mileage + use-of-home`,
    s.deductibleExpenses,
    (s.receiptDeductionsPence + s.yearStarterExpensesPence) / 100 + s.mileageAllowance + s.useOfHomeAllowance,
  );
  check(`${name} · pence are integers`, Number.isInteger(s.incomeReceivedPence) && Number.isInteger(s.receiptDeductionsPence), true);
}

// Local-time timestamp helper — getTaxYear reads local date fields, so test
// dates are built in local time too (timezone-proof on any machine).
const T = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12).getTime();

let seq = 0;

/** A paid, approved, £1,000 manual job received 10 June 2026 (TY 2026-27). */
function job(over: Partial<Job> = {}): Job {
  return {
    id: `j${++seq}`,
    createdAt: T(2026, 6, 1),
    amount: 100_000,
    date: '2026-06-01',
    status: 'paid',
    paidAt: T(2026, 6, 10),
    source: 'manual',
    taxYear: '2026-27',
    reviewStatus: 'approved',
    syncStatus: 'local',
    ...over,
  };
}

/** An approved £100 materials receipt dated 1 June 2026 (TY 2026-27). */
function receipt(over: Partial<Receipt> = {}): Receipt {
  return {
    id: `r${++seq}`,
    capturedAt: T(2026, 6, 1),
    imageSource: 'camera',
    merchant: 'Test Merchant',
    amount: 10_000,
    date: '2026-06-01',
    category: 'materials_supplies',
    categoryConfidence: 1,
    categorySource: 'manual',
    taxYear: '2026-27',
    processingStatus: 'complete',
    reviewStatus: 'approved',
    syncStatus: 'local',
    ...over,
  };
}

const YEAR = '2026-27';
const select = (over: { jobs?: Job[]; receipts?: Receipt[]; otherIncome?: OtherIncome[]; businessMiles?: number; motorcycleMiles?: number; useMileageFlatRate?: boolean; useOfHomeBand?: UseOfHomeBand; taxYear?: string; yearStarter?: YearStarterDeclared | null; carVanMilesBeforeCutover?: number }) =>
  selectEstimateInputs({ taxYear: YEAR, jobs: [], receipts: [], ...over });

let oiSeq = 0;
function otherInc(over: Partial<OtherIncome> & Pick<OtherIncome, 'amount' | 'kind'>): OtherIncome {
  oiSeq += 1;
  return {
    id: `oi${oiSeq}`,
    createdAt: T(2026, 6, 1),
    date: '2026-06-01',
    taxYear: YEAR,
    reviewStatus: 'approved',
    syncStatus: 'local',
    ...over,
  };
}

console.log('Estimate-input selector worked examples — tax_screen_spec §6 rules\n');

// ── Income: job status, review, year ─────────────────────────────────────────

{ // S1. Empty stores → zeros everywhere, flat rate not in use.
  const s = select({});
  check('S1 empty · income', s.incomeReceived, 0);
  check('S1 empty · deductions', s.deductibleExpenses, 0);
  check('S1 empty · flat rate', s.flatRateInUse, false);
  checkSelectionReconciles('S1', s);
}

{ // S2. Only PAID jobs are turnover: quoted £500, unpaid £800, void £300 are
  // all excluded; one paid £1,000 counts. (A quote is NEVER income.)
  const s = select({
    jobs: [
      job({ status: 'quoted', amount: 50_000, paidAt: undefined }),
      job({ status: 'unpaid', amount: 80_000, paidAt: undefined }),
      job({ status: 'void', amount: 30_000, paidAt: undefined }),
      job({ amount: 100_000 }),
    ],
  });
  check('S2 status gate · income £1,000', s.incomeReceived, 1_000);
  check('S2 status gate · jobs counted', s.diagnostics.jobsCounted, 1);
  checkSelectionReconciles('S2', s);
}

{ // S3. Cash basis across the year boundary: invoiced 20 Mar 2026 (TY 25-26,
  // stored taxYear '2025-26') but PAID 1 May 2026 → income of 2026-27, and the
  // stored taxYear field must be ignored in both directions.
  const crossYear = job({ date: '2026-03-20', taxYear: '2025-26', paidAt: T(2026, 5, 1) });
  const in2627 = select({ jobs: [crossYear] });
  check('S3 cross-year · counts in 2026-27', in2627.incomeReceived, 1_000);
  const in2526 = select({ jobs: [crossYear], taxYear: '2025-26' });
  check('S3 cross-year · NOT in 2025-26', in2526.incomeReceived, 0);
}

{ // S4. Missing paidAt on a paid job → falls back to the job date (counted,
  // flagged); garbage date too → falls back to createdAt (counted, flagged).
  const s = select({
    jobs: [
      job({ paidAt: undefined, date: '2026-07-01' }),
      job({ paidAt: undefined, date: 'not-a-date', createdAt: T(2026, 8, 2) }),
    ],
  });
  check('S4 fallbacks · both counted', s.incomeReceived, 2_000);
  check('S4 fallbacks · missing paidAt flagged', s.diagnostics.jobsMissingPaidAt, 1);
  check('S4 fallbacks · invalid date flagged', s.diagnostics.jobsInvalidDate, 1);
}

{ // S5. A paid job still awaiting review (AI-read amount unconfirmed) is
  // excluded — the human review gate is part of the estimate too.
  const s = select({ jobs: [job({ reviewStatus: 'needs_review' })] });
  check('S5 review gate · excluded', s.incomeReceived, 0);
  check('S5 review gate · flagged', s.diagnostics.jobsPaidAwaitingReview, 1);
}

{ // S6. Corrupt amounts never reach the sum: NaN and negative are flagged;
  // a £0 paid job just contributes nothing.
  const s = select({
    jobs: [
      job({ amount: Number.NaN }),
      job({ amount: -5_000 }),
      job({ amount: 0 }),
      job({ amount: 100_000 }),
    ],
  });
  check('S6 amount guards · income £1,000', s.incomeReceived, 1_000);
  check('S6 amount guards · invalid flagged', s.diagnostics.jobsInvalidAmount, 2);
  check('S6 amount guards · counted', s.diagnostics.jobsCounted, 1);
}

// ── Deductions: review, category, compliance answer ──────────────────────────

{ // S7. Review gate + category rules from sa103f-2026.ts (the single source):
  // needs_review excluded; client_entertainment and not_business excluded by
  // the category's own deductible flag; materials counted.
  const s = select({
    receipts: [
      receipt({ reviewStatus: 'needs_review' }),
      receipt({ category: 'client_entertainment' }),
      receipt({ category: 'not_business' }),
      receipt({ amount: 12_345 }),
    ],
  });
  check('S7 gates · deductions £123.45', s.deductibleExpenses, 123.45);
  check('S7 gates · awaiting review', s.diagnostics.receiptsAwaitingReview, 1);
  check('S7 gates · not deductible', s.diagnostics.receiptsNotDeductible, 2);
  check('S7 gates · counted', s.diagnostics.receiptsCounted, 1);
  checkSelectionReconciles('S7', s);
}

{ // S8. The user's compliance answer wins over the category default:
  // deductible === false excludes; undefined means the category default.
  const s = select({
    receipts: [
      receipt({ category: 'uniform_clothing', deductible: false }),
      receipt({ category: 'uniform_clothing', deductible: true, amount: 4_000 }),
      receipt({ category: 'training', amount: 6_000 }), // undefined → default in
    ],
  });
  check('S8 compliance answer · £100', s.deductibleExpenses, 100);
  check('S8 compliance answer · excluded', s.diagnostics.receiptsNotDeductible, 1);
}

{ // S9. An unknown category (data written by a future app version) is
  // conservative: excluded, never summed.
  const s = select({ receipts: [receipt({ category: 'future_thing' as HMRCCategory })] });
  check('S9 unknown category · excluded', s.deductibleExpenses, 0);
  check('S9 unknown category · flagged', s.diagnostics.receiptsNotDeductible, 1);
}

{ // S10. Splits: the deductible figure is businessAmount (face − personal),
  // never the face amount. £100 with £40 personal → £60.
  const s = select({ receipts: [receipt({ amount: 10_000, personalAmount: 4_000 })] });
  check('S10 split · £60', s.deductibleExpenses, 60);
}

{ // S11. Corrupt split (personal £120 > face £100): businessAmount would be
  // NEGATIVE and silently subtract from the year's deductions — must clamp to
  // £0 and flag. A clean £50 receipt alongside stays intact.
  const s = select({
    receipts: [
      receipt({ amount: 10_000, personalAmount: 12_000 }),
      receipt({ amount: 5_000 }),
    ],
  });
  check('S11 clamped split · £50 not £30', s.deductibleExpenses, 50);
  check('S11 clamped split · flagged', s.diagnostics.receiptsClampedSplit, 1);
}

{ // S12. Foreign currency: no GBP amount yet → excluded until converted;
  // converted (GBP amount present) → counted at the GBP amount.
  const s = select({
    receipts: [
      receipt({ currency: 'EUR', foreignAmount: 117_50, amount: 0 }),
      receipt({ currency: 'EUR', foreignAmount: 117_50, amount: 8_500 }),
    ],
  });
  check('S12 foreign · only converted counts', s.deductibleExpenses, 85);
  check('S12 foreign · unconverted flagged', s.diagnostics.receiptsUnconvertedForeign, 1);
}

{ // S13. £0 GBP receipt contributes nothing and is not "counted".
  const s = select({ receipts: [receipt({ amount: 0 })] });
  check('S13 zero · deductions', s.deductibleExpenses, 0);
  check('S13 zero · flagged', s.diagnostics.receiptsZeroAmount, 1);
  check('S13 zero · not counted', s.diagnostics.receiptsCounted, 0);
}

{ // S14. Corrupt receipt amounts (NaN / negative) never reach the sum.
  const s = select({
    receipts: [receipt({ amount: Number.NaN }), receipt({ amount: -2_000 })],
  });
  check('S14 invalid amounts · deductions', s.deductibleExpenses, 0);
  check('S14 invalid amounts · flagged', s.diagnostics.receiptsInvalidAmount, 2);
}

// ── §E: mileage allowance + the double-claim rule ────────────────────────────

{ // S15. No business miles → flat rate NOT in use → a van_vehicle receipt
  // (actual running costs) counts normally.
  const s = select({ receipts: [receipt({ category: 'van_vehicle', amount: 20_000 })] });
  check('S15 van, no miles · counted', s.deductibleExpenses, 200);
  check('S15 van, no miles · flat rate off', s.flatRateInUse, false);
}

{ // S16. Business miles logged → flat rate in use → the van receipt is
  // EXCLUDED (§E: the flat rate replaces running costs — never both), while
  // travel_transport (parking/tolls/train) stays claimable on top.
  // 100 miles × 55p = £55; + £30 parking = £85 deductions.
  const s = select({
    businessMiles: 100,
    receipts: [
      receipt({ category: 'van_vehicle', amount: 20_000 }),
      receipt({ category: 'travel_transport', amount: 3_000 }),
    ],
  });
  check('S16 §E rule · deductions £85', s.deductibleExpenses, 85);
  check('S16 §E rule · mileage £55', s.mileageAllowance, 55);
  check('S16 §E rule · van excluded (count)', s.diagnostics.receiptsMileageConflict.count, 1);
  check('S16 §E rule · van excluded (pence)', s.diagnostics.receiptsMileageConflict.pence, 20_000);
  checkSelectionReconciles('S16', s);
}

{ // S17. The explicit override forces the rule even with zero miles (the
  // future per-vehicle "flat rate chosen" state): van excluded, allowance £0.
  const s = select({
    useMileageFlatRate: true,
    receipts: [receipt({ category: 'van_vehicle', amount: 20_000 })],
  });
  check('S17 override · van excluded', s.deductibleExpenses, 0);
  check('S17 override · allowance 0', s.mileageAllowance, 0);
  check('S17 override · flat rate on', s.flatRateInUse, true);
}

{ // S18. Year-total mileage maths (§E, threshold on cumulative miles):
  // 12,000 miles = 10,000 × 55p + 2,000 × 25p = £5,500 + £500 = £6,000.
  const s = select({ businessMiles: 12_000 });
  check('S18 mileage year total · £6,000', s.mileageAllowance, 6_000);
  check('S18 mileage year total · in deductions', s.deductibleExpenses, 6_000);
}

{ // S19. Mileage input guards: NaN and negative read as zero miles.
  check('S19 mileage NaN', select({ businessMiles: Number.NaN }).mileageAllowance, 0);
  check('S19 mileage negative', select({ businessMiles: -50 }).mileageAllowance, 0);
}

// ── Tax-year boundaries and dates ────────────────────────────────────────────

{ // S20. The 6 April boundary, receipt side: 5 Apr 2026 belongs to 2025-26;
  // 6 Apr 2026 and 5 Apr 2027 belong to 2026-27; 6 Apr 2027 to 2027-28.
  const s = select({
    receipts: [
      receipt({ date: '2026-04-05', amount: 1_000 }),
      receipt({ date: '2026-04-06', amount: 2_000 }),
      receipt({ date: '2027-04-05', amount: 4_000 }),
      receipt({ date: '2027-04-06', amount: 8_000 }),
    ],
  });
  check('S20 boundary · only the middle two', s.deductibleExpenses, 60);
}

{ // S21. The stored receipt taxYear field is never trusted either: a stale
  // '2026-27' label on a receipt dated 1 Mar 2026 (TY 2025-26) is excluded.
  const s = select({ receipts: [receipt({ date: '2026-03-01', taxYear: '2026-27' })] });
  check('S21 stored year ignored', s.deductibleExpenses, 0);
}

{ // S22. Unparseable receipt date → falls back to the capture moment
  // (counted in the capture year, flagged for fixing).
  const s = select({
    receipts: [receipt({ date: 'garbage', capturedAt: T(2026, 6, 15), amount: 7_700 })],
  });
  check('S22 date fallback · counted', s.deductibleExpenses, 77);
  check('S22 date fallback · flagged', s.diagnostics.receiptsInvalidDate, 1);
}

// ── Pence exactness and the engine binding ───────────────────────────────────

{ // S23. Integer-pence sums stay exact: 33.33 + 33.33 + 33.34 = £100.00
  // exactly (no float drift from summing pounds).
  const s = select({
    receipts: [receipt({ amount: 3_333 }), receipt({ amount: 3_333 }), receipt({ amount: 3_334 })],
  });
  check('S23 pence exactness · £100', s.receiptDeductionsPence, 10_000);
  check('S23 pence exactness · pounds', s.deductibleExpenses, 100);
}

{ // S24. End-to-end against the engine's own worked example 3: £30,000
  // received − £5,000 expenses → profit £25,000 → IT £2,486 + C4 £745.80
  // = £3,231.80 (rUK). Selection feeds the engine through toTaxEstimateInput.
  const s = select({
    jobs: [job({ amount: 1_800_000 }), job({ amount: 1_200_000 })],
    receipts: [receipt({ amount: 300_000 }), receipt({ amount: 200_000 })],
  });
  check('S24 e2e · income £30,000', s.incomeReceived, 30_000);
  check('S24 e2e · deductions £5,000', s.deductibleExpenses, 5_000);
  const e = calculateTaxEstimate(toTaxEstimateInput(s, { nation: 'england-wales-ni' }));
  check('S24 e2e · engine total £3,231.80', e.totalTax, 3_231.8);
  check('S24 e2e · rates year', e.ratesTaxYear, '2026-27');
}

{ // S25. The win-line binding: at £25,000 profit (basic rate + Class 4 main),
  // £100 more deduction relieves 20% + 6% = £26 exactly.
  const s = select({
    jobs: [job({ amount: 3_000_000 })],
    receipts: [receipt({ amount: 500_000 })],
  });
  const relief = taxReliefForDeduction(toTaxEstimateInput(s, { nation: 'england-wales-ni' }), 100);
  check('S25 win-line · £26 per £100', relief, 26);
}

{ // S26. Profile passthrough: every Tax-setup answer lands on the engine input.
  const s = select({});
  const input = toTaxEstimateInput(s, {
    nation: 'scotland',
    otherTaxableIncome: 18_000,
    studentLoanPlan: 'plan2',
    postgradLoan: true,
  });
  check('S26 profile · nation', input.nation as string, 'scotland');
  check('S26 profile · other income', input.otherTaxableIncome ?? 0, 18_000);
  check('S26 profile · plan', input.studentLoanPlan ?? '', 'plan2');
  check('S26 profile · postgrad', input.postgradLoan === true, true);
  check('S26 profile · year carried', input.taxYear, YEAR);
}

{ // S27. The classifier is the single deductible rule for ALL surfaces (the
  // Receipts hero uses it): spot-check the discriminated results directly.
  const ok = classifyReceiptForEstimate(receipt({ amount: 4_200 }), { flatRateInUse: false });
  check('S27 classifier · counted', ok.counted === true, true);
  check('S27 classifier · pence', ok.counted ? ok.pence : -1, 4_200);
  const ent = classifyReceiptForEstimate(receipt({ category: 'client_entertainment' }), { flatRateInUse: false });
  check('S27 classifier · entertainment reason', ent.counted ? '' : ent.reason, 'category-not-deductible');
  const van = classifyReceiptForEstimate(receipt({ category: 'van_vehicle' }), { flatRateInUse: true });
  check('S27 classifier · van reason', van.counted ? '' : van.reason, 'mileage-conflict');
}

// ── Dashboard period figures (src/lib/dashboardData.ts — same canon) ─────────

// No §E flat rates in play — the baseline flags for the period-maths examples.
const NO_FLAGS: EstimateFlags = { mileageFlatRateYears: new Set(), homeFlatRateInUse: false };

{ // S28. Month figures at 11 Jun 2026: a June payment counts, May's doesn't;
  // a June receipt counts; outstanding is the CURRENT unpaid stock regardless
  // of period or date; delta = June profit − May profit when positive.
  const NOW = new Date(2026, 5, 11);
  const js = [
    job({ paidAt: T(2026, 6, 5), amount: 100_000 }),         // June: £1,000 in
    job({ paidAt: T(2026, 5, 20), amount: 40_000 }),          // May: £400 in
    job({ status: 'unpaid', paidAt: undefined, amount: 75_000, date: '2026-02-01' }), // owed now
    job({ status: 'quoted', paidAt: undefined, amount: 999_999 }), // never counts anywhere
  ];
  const rs = [
    receipt({ date: '2026-06-02', amount: 20_000 }),           // June: £200 out
    receipt({ date: '2026-05-10', amount: 10_000 }),           // May: £100 out
  ];
  const f = homeFigures(buildProfitIndex(js, rs, [], NO_FLAGS), 'month', NOW);
  check('S28 month · received £1,000', f.receivedPence, 100_000);
  check('S28 month · expenses £200', f.expensesPence, 20_000);
  check('S28 month · profit £800', f.profitPence, 80_000);
  check('S28 month · outstanding £750 (stock)', f.outstandingPence, 75_000);
  check('S28 month · label', f.periodLabel, 'in June');
  // June profit 800 − May profit (400−100=300) = +500 → pill shows.
  check('S28 month · delta +£500', f.deltaPence ?? -1, 50_000);
  check('S28 month · delta label', f.deltaLabel, 'on May');
}

{ // S29. Quarter figures use the MTD quarter (Q1: 6 Apr–5 Jul) — a payment on
  // 10 Apr is inside Q1; one on 5 Apr 2026 belongs to last tax year's Q4.
  const NOW = new Date(2026, 5, 11);
  const js = [
    job({ paidAt: T(2026, 4, 10), amount: 60_000 }),
    job({ paidAt: T(2026, 4, 5), amount: 30_000 }),
  ];
  const f = homeFigures(buildProfitIndex(js, [], [], NO_FLAGS), 'quarter', NOW);
  check('S29 quarter · only 10 Apr counts', f.receivedPence, 60_000);
  check('S29 quarter · label', f.periodLabel, 'this quarter');
}

{ // S30. Monthly series = ALL 12 tax-year months (Apr…Mar, a fixed axis). At
  // 11 Jun 2026, Apr/May/Jun carry data (Jun current); empty/future months are
  // 0 (no bar drawn); year-to-date profit sums the whole tax year.
  const NOW = new Date(2026, 5, 11);
  const js = [
    job({ paidAt: T(2026, 4, 20), amount: 50_000 }),
    job({ paidAt: T(2026, 6, 5), amount: 100_000 }),
  ];
  const rs = [receipt({ date: '2026-05-15', amount: 20_000 })];
  const series = monthlyProfitSeries(buildProfitIndex(js, rs, [], NO_FLAGS), NOW);
  check('S30 series · 12 bars', series.length, 12);
  check('S30 series · starts Apr', series[0].label, 'Apr');
  check('S30 series · ends Mar', series[11].label, 'Mar');
  check('S30 series · Apr +£500', series[0].profitPence, 50_000);
  check('S30 series · May −£200', series[1].profitPence, -20_000);
  check('S30 series · Jun +£1,000 current', series[2].profitPence, 100_000);
  check('S30 series · current flag', series[2].isCurrent, true);
  check('S30 series · Jul empty = 0', series[3].profitPence, 0);
  check('S30 series · exactly one current', series.filter((b) => b.isCurrent).length, 1);
  check('S30 year profit £1,300', yearProfitPence(buildProfitIndex(js, rs, [], NO_FLAGS), NOW), 130_000);
}

{ // S31. Down month → no delta pill (calm Home, positive-only).
  const NOW = new Date(2026, 5, 11);
  const js = [
    job({ paidAt: T(2026, 5, 20), amount: 100_000 }), // May: £1,000
    job({ paidAt: T(2026, 6, 5), amount: 20_000 }),   // June: £200 — down
  ];
  const f = homeFigures(buildProfitIndex(js, [], [], NO_FLAGS), 'month', NOW);
  check('S31 down month · no pill', f.deltaPence === null, true);
}

{ // S31b. §E flags on the dashboard (audit High #6): with business miles in the
  // year, a van_vehicle receipt drops OUT of the figures (double-claim rule) —
  // exactly as the estimate excludes it — while materials still count. The
  // home band likewise excludes actual home costs. estimateFlags() derives both
  // from raw data (business miles per tax year; the tax-setup band).
  const NOW = new Date(2026, 5, 11);
  const js = [job({ paidAt: T(2026, 6, 5), amount: 100_000 })];
  const rs = [
    receipt({ date: '2026-06-02', amount: 20_000 }),                             // materials: counts
    receipt({ date: '2026-06-03', amount: 15_000, category: 'van_vehicle' }),    // fuel: §E-excluded
    receipt({ date: '2026-06-04', amount: 12_000, category: 'premises_rent' }),  // rent: NOT home-conflicted
  ];
  const trip = {
    id: 't1', startTime: T(2026, 6, 1), endTime: T(2026, 6, 1),
    startLocation: { lat: 0, lng: 0 }, endLocation: { lat: 0, lng: 0 },
    distanceMiles: 10, purpose: 'business' as const, detectionMethod: 'manual' as const,
    taxYear: '2026-27',
  };
  const flags = estimateFlags([trip], '25-50');
  check('S31b flags · year has miles', flags.mileageFlatRateYears.has('2026-27'), true);
  check('S31b flags · other year clear', flags.mileageFlatRateYears.has('2025-26'), false);
  check('S31b flags · home band on', flags.homeFlatRateInUse, true);
  const f = homeFigures(buildProfitIndex(js, rs, [], flags), 'month', NOW);
  check('S31b month · van excluded, rent+materials count (£320)', f.expensesPence, 32_000);
  const bare = homeFigures(buildProfitIndex(js, rs, [], NO_FLAGS), 'month', NOW);
  check('S31b no-flags baseline · all three count (£470)', bare.expensesPence, 47_000);
}

{ // S31b2. Declared Before-SoleTax miles switch the §E flat rate on for Home's
  // figures exactly as the engine does (S143 — selectors.ts counts
  // `miles + declaredMiles > 0`; estimateFlags used to see only recorded
  // trips, so a mid-year switcher with declared miles and NO trips yet had
  // van/fuel receipts excluded from the estimate but counted on Home).
  const NOW = new Date(2026, 5, 11);
  const js = [job({ paidAt: T(2026, 6, 5), amount: 100_000 })];
  const rs = [
    receipt({ date: '2026-06-02', amount: 20_000 }),                          // materials: counts
    receipt({ date: '2026-06-03', amount: 15_000, category: 'van_vehicle' }), // fuel: §E-excluded
  ];
  const flags = estimateFlags([], undefined, '2026-27'); // declared miles, no trips
  check('S31b2 flags · declared-miles year has the flat rate', flags.mileageFlatRateYears.has('2026-27'), true);
  const f = homeFigures(buildProfitIndex(js, rs, [], flags), 'month', NOW);
  check('S31b2 month · van excluded on declared miles alone (£200)', f.expensesPence, 20_000);
  check('S31b2 null starter year is a no-op', estimateFlags([], undefined, null).mileageFlatRateYears.size, 0);
  // The sanitiser: no/zero/invalid declared miles → no year.
  check('S31b2 starterMilesTaxYear · zero miles → null', starterMilesTaxYear({ yearStarterMiles: 0, yearStarterTaxYear: '2026-27' } as never) === null, true);
  check('S31b2 starterMilesTaxYear · miles without a year → null', starterMilesTaxYear({ yearStarterMiles: 120 } as never) === null, true);
  check('S31b2 starterMilesTaxYear · declared → the year', starterMilesTaxYear({ yearStarterMiles: 120, yearStarterTaxYear: '2026-27' } as never) === '2026-27', true);
}

{ // S31c. Other income counts on Home exactly as in the estimate (S142, Jamie:
  // imported income was invisible on the profit surfaces). Approved rows count
  // as money in by their received date; needs_review is excluded until sorted;
  // goods_own_use is an add-back, never "received"; a prior-month row stays out
  // of this month but lands in its own chart month and the year total.
  const NOW = new Date(2026, 5, 11);
  const js = [job({ paidAt: T(2026, 6, 5), amount: 100_000 })]; // June: £1,000 in
  const oi = [
    otherInc({ amount: 30_000, kind: 'sales', date: '2026-06-03' }),               // June: counts
    otherInc({ amount: 20_000, kind: 'sales', date: '2026-05-08' }),               // May: other month
    otherInc({ amount: 40_000, kind: 'sales', date: '2026-06-04', reviewStatus: 'needs_review' }), // To sort: excluded
    otherInc({ amount: 50_000, kind: 'goods_own_use', date: '2026-06-05' }),       // add-back: excluded
  ];
  const index = buildProfitIndex(js, [], oi, NO_FLAGS);
  const f = homeFigures(index, 'month', NOW);
  check('S31c month · received £1,300 (job + June sales)', f.receivedPence, 130_000);
  const series = monthlyProfitSeries(index, NOW);
  check('S31c series · May carries the £200 sales row', series[1].profitPence, 20_000);
  check('S31c year profit £1,500', yearProfitPence(index, NOW), 150_000);
}

{ // S31d. The 'refund' kind (S143 ruling, register §F): a supplier refund is
  // Box 16 trading income — it counts into profit on Home and in the estimate
  // exactly like other approved income, with the amount POSITIVE (never a
  // negative expense).
  const NOW = new Date(2026, 5, 11);
  const js = [job({ paidAt: T(2026, 6, 5), amount: 100_000 })];
  const oi = [otherInc({ amount: 4_500, kind: 'refund', date: '2026-06-08' })];
  const f = homeFigures(buildProfitIndex(js, [], oi, NO_FLAGS), 'month', NOW);
  check('S31d refund counts as money in on Home (£1,045)', f.receivedPence, 104_500);
  const sel = selectEstimateInputs({ taxYear: '2026-27', jobs: js, receipts: [], otherIncome: oi, businessMiles: 0 });
  check('S31d refund counts in the estimate income', sel.incomeReceivedPence, 104_500);
  check('S31d refund is one counted other-income row', sel.diagnostics.otherIncomeCounted, 1);
}

// ── The win-line + set-aside derivations ─────────────────────────────────────

{ // S32. reliefForDeductionSlice — the "≈ £X off your tax" figure. At £25,000
  // profit (rUK), a £100 slice relieves 20% IT + 6% Class 4 = £26. A slice
  // LARGER than the year's deductions reinstates only what the estimate holds:
  // slice £6,000 against £5,000 of deductions = tax(trading-allowance basis,
  // £29,000 profit: IT £3,286 + C4 £985.80 = £4,271.80) − tax(expenses basis,
  // £25,000 profit: £3,231.80) = £1,040. Zero/empty slices are 0.
  const s = select({
    jobs: [job({ amount: 3_000_000 })],
    receipts: [receipt({ amount: 500_000 })],
  });
  const binding = { selection: s };
  check('S32 relief · £26 per £100', reliefForDeductionSlice(binding, 100), 26);
  check('S32 relief · over-slice clamps (£1,040)', reliefForDeductionSlice(binding, 6_000), 1_040);
  check('S32 relief · zero slice', reliefForDeductionSlice(binding, 0), 0);
  // Below the thresholds (income inside the Personal Allowance): no relief —
  // the UI must show NOTHING, not £0.
  const tiny = select({ jobs: [job({ amount: 800_000 })], receipts: [receipt({ amount: 50_000 })] });
  check('S32 relief · below thresholds → 0', reliefForDeductionSlice({ selection: tiny }, 500), 0);
}

{ // S33. monthlySetAside — conservative (rounded UP), January-total based:
  // £4,847.70 over the 19 months from 11 Jun 2026 → £256; with one month
  // left it's the whole remaining bill.
  const e = calculateTaxEstimate({
    taxYear: YEAR, nation: 'england-wales-ni', incomeReceived: 30_000, deductibleExpenses: 5_000,
  });
  check('S33 set-aside · 19 months → £256', monthlySetAside(e, new Date(2026, 5, 11)), 256);
  check('S33 set-aside · 1 month → £4,848', monthlySetAside(e, new Date(2028, 0, 15)), 4_848);
}

// ── CIS netting wiring (§I — per-job withheld amounts) ───────────────────────

{ // S34. CIS withheld rides ONLY with income that counts: the unpaid job, the
  // paid-but-unreviewed job and last year's job contribute no CIS; withheld
  // can never exceed the job amount (£800 claimed on a £500 job clamps to
  // £500 and is flagged); negatives are ignored.
  const s = select({
    jobs: [
      job({ amount: 100_000, cisWithheld: 20_000 }),                            // £200 counts
      job({ status: 'unpaid', paidAt: undefined, cisWithheld: 10_000 }),        // not income
      job({ reviewStatus: 'needs_review', cisWithheld: 10_000 }),               // unreviewed
      job({ paidAt: T(2025, 6, 10), date: '2025-06-01', cisWithheld: 10_000 }), // TY 2025-26
      job({ amount: 50_000, cisWithheld: 80_000 }),                             // clamps to £500
      job({ amount: 100_000, cisWithheld: -5_000 }),                            // ignored
    ],
  });
  check('S34 CIS · income £2,500', s.incomeReceived, 2_500);
  check('S34 CIS · withheld pence', s.cisWithheldPence, 70_000);
  check('S34 CIS · withheld £', s.cisDeductionsWithheld, 700);
  check('S34 CIS · jobs with CIS', s.diagnostics.jobsWithCis, 2);
  check('S34 CIS · clamped flagged', s.diagnostics.jobsCisClamped, 1);
  check('S34 CIS · engine input carries it', toTaxEstimateInput(s).cisDeductionsWithheld ?? 0, 700);
  checkSelectionReconciles('S34', s);
}

{ // S35. End to end: the engine example-32 subbie through the selectors.
  // £40,000 paid job with £7,200 withheld + £5,000 of receipts → profit
  // £35,000, bill £5,831.80, CIS covers it → January £0, refund £1,368.20.
  const s = select({
    jobs: [job({ amount: 4_000_000, cisWithheld: 720_000 })],
    receipts: [receipt({ amount: 500_000 })],
  });
  const e = calculateTaxEstimate(toTaxEstimateInput(s, { nation: 'england-wales-ni' }));
  check('S35 CIS end-to-end · January £0', e.firstYearJanuaryTotal, 0);
  check('S35 CIS end-to-end · balancing £0', e.balancingPayment, 0);
  check('S35 CIS end-to-end · refund', e.cisRefundDue, 1_368.2);
  check('S35 CIS end-to-end · POA off', e.paymentsOnAccount.required, false);
}

// ── Tax setup (the seven questions → engine profile + exclusions) ────────────

{ // S36. Completeness: 'none'/false are ANSWERS, undefined is not; "other
  // income: yes" needs the amount before it counts; the engine mapping turns
  // 'none' into no plan and "no other income" into an explicit £0.
  check('S36 setup · empty = 0 answered', taxSetupAnsweredCount({}), 0);
  check('S36 setup · nation = 1', taxSetupAnsweredCount({ nation: 'scotland' }), 1);
  check('S36 setup · other-income yes w/o amount doesn\'t count',
    taxSetupAnsweredCount({ hasOtherIncome: true }), 0);
  check('S36 setup · other-income yes + amount counts',
    taxSetupAnsweredCount({ hasOtherIncome: true, otherTaxableIncome: 6_000 }), 1);
  const full = {
    nation: 'england-wales-ni',
    hasOtherIncome: false,
    studentLoan: 'none',
    turnoverBand: '30k-50k',
    turnoverBandYear: '2025-26',
    // S54: ④ also needs the prior-year follow-up when a §H wave tests that
    // year (2024-25 → the £50k wave) — see the S54 block for the rule's cases.
    priorYearOverThreshold: false,
    priorYearTaxYear: '2024-25',
    cisSubcontractor: true,
    // ⑥/⑦ "few more things" groups — each answered (S58).
    moneyDone: true,
    situationDone: true,
    // ⑧ working-from-home band — the 8th counted question.
    useOfHomeBand: 'none',
  } as const;
  check('S36 setup · full = complete', isTaxSetupComplete(full), true);
  const p = toTaxProfile(full);
  check('S36 setup · none → no plan', p.studentLoanPlan === undefined, true);
  check('S36 setup · no other income → explicit £0', p.otherTaxableIncome ?? -1, 0);
  const p2 = toTaxProfile({ hasOtherIncome: true, otherTaxableIncome: 6_000, studentLoan: 'plan2' });
  check('S36 setup · other income £6,000', p2.otherTaxableIncome ?? -1, 6_000);
  check('S36 setup · plan carries', p2.studentLoanPlan ?? 'none', 'plan2');
  check('S36 setup · unanswered other income stays undefined',
    toTaxProfile({}).otherTaxableIncome === undefined, true);
}

{ // S37. MTD mandation from the band (§H: thresholds tested per SPECIFIC
  // year). A 2025-26 band ≥ £30k is PROVEN (the £30k wave tests 2025-26 →
  // April 2027); £20k–30k only makes the 2028 wave "likely" (it tests
  // 2026-27, which hasn't finished); under £20k proves nothing yet.
  const m = (b: Parameters<typeof mtdStartForTurnoverBand>[0], y: string) => {
    const r = mtdStartForTurnoverBand(b, y);
    return r.kind === 'mandated' || r.kind === 'likely' ? `${r.kind}-${r.startsApril}` : r.kind;
  };
  check('S37 MTD · over-50k 2025-26', m('over-50k', '2025-26'), 'mandated-2027');
  check('S37 MTD · 30k-50k 2025-26', m('30k-50k', '2025-26'), 'mandated-2027');
  check('S37 MTD · 20k-30k 2025-26', m('20k-30k', '2025-26'), 'likely-2028');
  check('S37 MTD · under-20k 2025-26', m('under-20k', '2025-26'), 'not-yet');
  check('S37 MTD · over-50k 2024-25', m('over-50k', '2024-25'), 'mandated-2026');
  check('S37 MTD · 30k-50k 2024-25', m('30k-50k', '2024-25'), 'likely-2027');
  check('S37 MTD · under-20k 2023-24 (untested year)', m('under-20k', '2023-24'), 'unknown');
}

{ // S54. Prior-year follow-up (§H): the year BEFORE the band year can already
  // have mandated them under an EARLIER wave — over £50k in 2024-25 means
  // quarterly updates run from April 2026 NO MATTER what 2025-26 brought in.
  // The band alone can't see that (the 2026-06-11 device find); every §H line
  // must read the combined mtdStartForSetup, never the band on its own.
  const fmt = (r: MtdStart | null) =>
    !r ? 'null' : r.kind === 'mandated' || r.kind === 'likely' ? `${r.kind}-${r.startsApril}` : r.kind;

  check('S54 prior · over £50k 2024-25 → mandated 2026', fmt(mtdStartForPriorYear(true, '2024-25')), 'mandated-2026');
  check('S54 prior · under £50k 2024-25 proves nothing', fmt(mtdStartForPriorYear(false, '2024-25')), 'not-yet');
  check('S54 prior · untested year says nothing', fmt(mtdStartForPriorYear(true, '2023-24')), 'unknown');

  check('S54 combine · mandated beats likely',
    fmt(combineMtdStarts({ kind: 'likely', startsApril: 2027 }, { kind: 'mandated', startsApril: 2027 })), 'mandated-2027');
  check('S54 combine · earlier April wins a tie',
    fmt(combineMtdStarts({ kind: 'mandated', startsApril: 2027 }, { kind: 'mandated', startsApril: 2026 })), 'mandated-2026');
  check('S54 combine · not-yet beats unknown',
    fmt(combineMtdStarts({ kind: 'unknown' }, { kind: 'not-yet' })), 'not-yet');

  // The full setup answer — the exact case found on-device 2026-06-11: over
  // £50k in 2025-26 alone reads April 2027; the prior-year answer decides
  // whether quarterly updates have actually been running since April 2026.
  const base = { turnoverBand: 'over-50k', turnoverBandYear: '2025-26' } as const;
  check('S54 setup · over-50k 2025-26 + prior over → ALREADY mandated 2026',
    fmt(mtdStartForSetup({ ...base, priorYearOverThreshold: true, priorYearTaxYear: '2024-25' })), 'mandated-2026');
  check('S54 setup · over-50k 2025-26 + prior under → 2027',
    fmt(mtdStartForSetup({ ...base, priorYearOverThreshold: false, priorYearTaxYear: '2024-25' })), 'mandated-2027');
  check('S54 setup · declining business: under-20k 2025-26 + prior over → 2026',
    fmt(mtdStartForSetup({ turnoverBand: 'under-20k', turnoverBandYear: '2025-26', priorYearOverThreshold: true, priorYearTaxYear: '2024-25' })), 'mandated-2026');
  check('S54 setup · unanswered follow-up falls back to the band',
    fmt(mtdStartForSetup(base)), 'mandated-2027');
  check('S54 setup · STALE follow-up (wrong year) is ignored',
    fmt(mtdStartForSetup({ ...base, priorYearOverThreshold: true, priorYearTaxYear: '2023-24' })), 'mandated-2027');
  check('S54 setup · no band yet → null', fmt(mtdStartForSetup({})), 'null');

  // Completeness: the takings question (④) now needs the follow-up too.
  const rest = {
    nation: 'england-wales-ni',
    hasOtherIncome: false,
    studentLoan: 'none',
    cisSubcontractor: false,
    moneyDone: true, // ⑥/⑦ groups answered (S58)
    situationDone: true,
  } as const;
  check('S54 complete · band alone no longer answers ④', taxSetupAnswers({ ...rest, ...base })[3], false);
  check('S54 complete · band + follow-up answers ④',
    taxSetupAnswers({ ...rest, ...base, priorYearOverThreshold: true, priorYearTaxYear: '2024-25' })[3], true);
  check('S54 complete · stale follow-up does NOT answer ④',
    taxSetupAnswers({ ...rest, ...base, priorYearOverThreshold: true, priorYearTaxYear: '2023-24' })[3], false);
  check('S54 complete · whole setup completes with the follow-up',
    isTaxSetupComplete({ ...rest, ...base, priorYearOverThreshold: false, priorYearTaxYear: '2024-25', useOfHomeBand: 'none' }), true);
}

{ // S58. ⑥ "Other income or sales" + ⑦ "Your situation" — the boundary
  // detectors (coverage_matrix.md §3/§4), now TWO separately-counted questions,
  // each answered by a positive choice (toggle an item OR its own "this doesn't
  // apply to me" → moneyDone / situationDone). None of the flags changes the
  // estimate maths — they only drive the honest exclusion notes.
  const five = {
    nation: 'england-wales-ni',
    hasOtherIncome: false,
    studentLoan: 'none',
    turnoverBand: 'under-20k',
    turnoverBandYear: '2025-26',
    priorYearOverThreshold: false,
    priorYearTaxYear: '2024-25',
    cisSubcontractor: false,
  } as const;
  check('S58 setup · both groups unanswered → 5 of 8', taxSetupAnsweredCount(five), 5);
  check('S58 setup · money group only → 6 of 8',
    taxSetupAnsweredCount({ ...five, moneyDone: true }), 6);
  check('S58 setup · both groups → complete',
    isTaxSetupComplete({ ...five, moneyDone: true, situationDone: true, useOfHomeBand: 'none' }), true);
  check('S58 setup · ⑥ money is the 6th answered flag',
    taxSetupAnswers({ ...five, moneyDone: true })[5], true);
  check('S58 setup · ⑦ situation is the 7th answered flag',
    taxSetupAnswers({ ...five, situationDone: true })[6], true);

  // estimateExclusions — disclosures only; a group marked done with nothing ticked = no notes.
  check('S58 excl · none set = empty', estimateExclusions({}).length, 0);
  check('S58 excl · groups done but nothing ticked = empty',
    estimateExclusions({ moneyDone: true, situationDone: true }).length, 0);
  check('S58 excl · foreign income flagged',
    estimateExclusions({ hasForeignIncome: true }).map((e) => e.key).join(), 'foreign');
  check('S58 excl · all seven flags → seven notes',
    estimateExclusions({
      hasForeignIncome: true, hasCapitalGains: true, hasSavingsDividends: true,
      claimsChildBenefit: true, vatRegistered: true, hasPensionContributions: true,
      hasOtherSituations: true,
    }).length, 7);
  check('S58 excl · stable display order',
    estimateExclusions({ hasOtherSituations: true, hasForeignIncome: true }).map((e) => e.key).join(','),
    'foreign,other-situations');
}

{ // S73. §S/§T/§U/§V £-input wiring (the documented calcs become reachable here).
  // The arithmetic is the engine + harness's job; THIS protects the wiring + the
  // gate: an amount only reaches the engine while its detector flag is on, and a
  // toggled-on-but-empty group maps to undefined → the engine's 0.
  const on = {
    hasSavingsDividends: true, savingsIncome: 1_200, dividendIncome: 3_000,
    claimsChildBenefit: true, childBenefitChildren: 2,
    hasPensionContributions: true, pensionContributionsNet: 4_000, giftAidDonationsNet: 500,
  } as const;
  const p = toTaxProfile(on);
  check('S73 profile · savings maps', p.savingsIncome ?? -1, 1_200);
  check('S73 profile · dividends maps', p.dividendIncome ?? -1, 3_000);
  check('S73 profile · CB children maps', p.childBenefitChildren ?? -1, 2);
  check('S73 profile · pension maps', p.pensionContributionsNet ?? -1, 4_000);
  check('S73 profile · Gift Aid maps', p.giftAidDonationsNet ?? -1, 500);

  // Gate: amounts present but the flag OFF → nothing reaches the engine (so
  // untoggling stops applying it without losing the typed value).
  const offFlags = {
    savingsIncome: 1_200, dividendIncome: 3_000, childBenefitChildren: 2,
    pensionContributionsNet: 4_000, giftAidDonationsNet: 500,
  } as const;
  const pOff = toTaxProfile(offFlags);
  check('S73 gate · savings gated off', pOff.savingsIncome === undefined, true);
  check('S73 gate · dividends gated off', pOff.dividendIncome === undefined, true);
  check('S73 gate · CB children gated off', pOff.childBenefitChildren === undefined, true);
  check('S73 gate · pension gated off', pOff.pensionContributionsNet === undefined, true);
  check('S73 gate · Gift Aid gated off', pOff.giftAidDonationsNet === undefined, true);

  // The selection→engine bridge forwards every field, and the engine receives it
  // (it echoes the inputs back in its outputs — proof the calc is reachable).
  const sel = selectEstimateInputs({ taxYear: '2026-27', jobs: [], receipts: [] });
  const input = toTaxEstimateInput(sel, p);
  check('S73 bridge · dividends forwarded', input.dividendIncome ?? -1, 3_000);
  check('S73 bridge · savings forwarded', input.savingsIncome ?? -1, 1_200);
  check('S73 bridge · CB children forwarded', input.childBenefitChildren ?? -1, 2);
  check('S73 bridge · pension forwarded', input.pensionContributionsNet ?? -1, 4_000);
  check('S73 bridge · Gift Aid forwarded', input.giftAidDonationsNet ?? -1, 500);
  const est = calculateTaxEstimate(input);
  check('S73 reachable · engine echoes dividends', est.dividendIncome, 3_000);
  check('S73 reachable · engine echoes CB children', est.childBenefitChildren, 2);

  // ★ The Tax-screen breakdown (src/app/tax.tsx) is hand-assembled, so every
  // component of totalOwed MUST be one of its lines or the breakdown total
  // silently desyncs from the hero (firstYearJanuaryTotal). This locks the exact
  // component set — savings + dividend tax + HICBC were the ones the £-input
  // wiring made non-zero; if a new component is ever added to totalOwed, this
  // restated identity forces a matching breakdown line.
  const full2 = calculateTaxEstimate({
    taxYear: '2026-27', nation: 'england-wales-ni',
    incomeReceived: 70_000, deductibleExpenses: 5_000,
    dividendIncome: 3_000, savingsIncome: 1_200,
    childBenefitChildren: 2, pensionContributionsNet: 4_000, giftAidDonationsNet: 500,
  });
  check('S73 reconcile · totalOwed = breakdown components',
    full2.incomeTax + full2.savingsTax + full2.dividendTax + full2.hicbcCharge + full2.class4Nic + full2.studentLoan,
    full2.totalOwed);
  check('S73 reconcile · savings tax exercised (> 0)', full2.savingsTax > 0, true);
  check('S73 reconcile · dividend tax exercised (> 0)', full2.dividendTax > 0, true);
  check('S73 reconcile · HICBC exercised (> 0)', full2.hicbcCharge > 0, true);

  // estimateExclusions — modelled items: nudge while the amount's missing,
  // suppressed once it's in; Child Benefit always notes (disclosure or nudge).
  check('S73 excl · savings/div flag, no amount → nudge present',
    estimateExclusions({ hasSavingsDividends: true }).some((e) => e.key === 'savings-dividends'), true);
  check('S73 excl · savings/div flag + amount → suppressed',
    estimateExclusions({ hasSavingsDividends: true, savingsIncome: 500 }).some((e) => e.key === 'savings-dividends'), false);
  check('S73 excl · pension flag, no amount → nudge present',
    estimateExclusions({ hasPensionContributions: true }).some((e) => e.key === 'pension'), true);
  check('S73 excl · pension flag + Gift Aid amount → suppressed',
    estimateExclusions({ hasPensionContributions: true, giftAidDonationsNet: 250 }).some((e) => e.key === 'pension'), false);
  check('S73 excl · CB flag, no count → nudge present',
    estimateExclusions({ claimsChildBenefit: true }).some((e) => e.key === 'child-benefit'), true);
  check('S73 excl · CB flag + count → disclosure present',
    estimateExclusions({ claimsChildBenefit: true, childBenefitChildren: 1 }).some((e) => e.key === 'child-benefit'), true);
  // All flags + all amounts → only the genuinely out-of-scope four + the CB disclosure.
  check('S73 excl · all flags + amounts → 5 notes',
    estimateExclusions({
      hasForeignIncome: true, hasCapitalGains: true, vatRegistered: true, hasOtherSituations: true,
      hasSavingsDividends: true, savingsIncome: 100, dividendIncome: 100,
      claimsChildBenefit: true, childBenefitChildren: 1,
      hasPensionContributions: true, pensionContributionsNet: 100, giftAidDonationsNet: 0,
    }).length, 5);
}

// ── End-to-end through the ENGINE: the two newest inputs reach the bill ────────
// Base (= S24): £30,000 jobs − £5,000 receipts → £25,000 profit → £3,231.80 (rUK).
// The marginal rate across £12,570–£50,270 is 20% IT + 6% Class 4 = 26%, so each
// £ added to / removed from taxable profit moves the bill by 26p (exact pennies).
const baseJobs = [job({ amount: 1_800_000 }), job({ amount: 1_200_000 })]; // £30,000
const baseReceipts = [receipt({ amount: 300_000 }), receipt({ amount: 200_000 })]; // £5,000

{ // S74. Mileage reaches the bill: 1,000 business miles → £550 §E allowance folds
  // into deductibleExpenses → profit −£550 → bill −£143 (550 × 26%).
  const s = select({ jobs: baseJobs, receipts: baseReceipts, businessMiles: 1_000 });
  check('S74 mileage e2e · allowance £550', s.mileageAllowance, 550);
  check('S74 mileage e2e · deductions £5,000 + £550', s.deductibleExpenses, 5_550);
  const e = calculateTaxEstimate(toTaxEstimateInput(s, { nation: 'england-wales-ni' }));
  check('S74 mileage e2e · bill £3,231.80 − £143 = £3,088.80', e.totalTax, 3_088.8);
}

{ // S75. Other income reaches the bill: £2,000 cash takings → turnover +£2,000 →
  // profit +£2,000 → bill +£520 (2000 × 26%).
  const s = select({
    jobs: baseJobs,
    receipts: baseReceipts,
    otherIncome: [otherInc({ amount: 200_000, kind: 'cash_takings' })],
  });
  check('S75 other-income e2e · turnover £32,000', s.incomeReceivedPence, 3_200_000);
  check('S75 other-income e2e · counted 1', s.diagnostics.otherIncomeCounted, 1);
  const e = calculateTaxEstimate(toTaxEstimateInput(s, { nation: 'england-wales-ni' }));
  check('S75 other-income e2e · bill £3,231.80 + £520 = £3,751.80', e.totalTax, 3_751.8);
}

{ // S76. Box 60 goods-for-own-use reaches the bill AS AN ADD-BACK: £1,000 raises
  // taxable profit (+£260) but turnover stays clean £30,000 and it isn't counted as
  // income — proving the add-back is folded into the engine's turnover, not cash in.
  const s = select({
    jobs: baseJobs,
    receipts: baseReceipts,
    otherIncome: [otherInc({ amount: 100_000, kind: 'goods_own_use' })],
  });
  check('S76 box60 e2e · turnover stays clean £30,000', s.incomeReceivedPence, 3_000_000);
  check('S76 box60 e2e · add-back £1,000 tracked apart', s.goodsOwnUsePence, 100_000);
  check('S76 box60 e2e · counted as add-back, not income', s.diagnostics.goodsOwnUseCounted, 1);
  check('S76 box60 e2e · not counted as other income', s.diagnostics.otherIncomeCounted, 0);
  const input = toTaxEstimateInput(s, { nation: 'england-wales-ni' });
  check('S76 box60 e2e · engine turnover folds the add-back (£31,000)', input.incomeReceived, 31_000);
  check('S76 box60 e2e · bill £3,231.80 + £260 = £3,491.80', calculateTaxEstimate(input).totalTax, 3_491.8);
}

// ── §E working-from-home flat rate ───────────────────────────────────────────
{ // U1. Band → monthly/annual rate (the §E table; bands £10/£18/£26 a month).
  check('U1 rate · none = £0/mo', homeFlatRateMonthly('none'), 0);
  check('U1 rate · undefined = £0/mo', homeFlatRateMonthly(undefined), 0);
  check('U1 rate · 25-50 = £10/mo', homeFlatRateMonthly('25-50'), 10);
  check('U1 rate · 51-100 = £18/mo', homeFlatRateMonthly('51-100'), 18);
  check('U1 rate · 101+ = £26/mo', homeFlatRateMonthly('101-plus'), 26);
  check('U1 annual · 25-50 = £120/yr', homeFlatRateAnnual('25-50'), 120);
  check('U1 annual · 101+ = £312/yr', homeFlatRateAnnual('101-plus'), 312);
  check('U1 annual · none = £0/yr', homeFlatRateAnnual('none'), 0);
}

{ // U2. The flat rate folds into deductibleExpenses (no receipts/mileage).
  const s = select({ jobs: [job()], useOfHomeBand: '51-100' });
  check('U2 · useOfHomeAllowance = £216 (£18 × 12)', s.useOfHomeAllowance, 216);
  check('U2 · homeFlatRateInUse true', s.homeFlatRateInUse, true);
  check('U2 · deductibleExpenses = £216', s.deductibleExpenses, 216);
  checkSelectionReconciles('U2', s);
}

{ // U3. 'none'/absent ⇒ no allowance, not in use.
  const s = select({ jobs: [job()], useOfHomeBand: 'none' });
  check('U3 none · allowance £0', s.useOfHomeAllowance, 0);
  check('U3 none · not in use', s.homeFlatRateInUse, false);
  const s2 = select({ jobs: [job()] });
  check('U3 absent · allowance £0', s2.useOfHomeAllowance, 0);
}

{ // U4. THE double-claim guard: with the flat rate on, a home_office receipt is
  // EXCLUDED (counted instead as the flat rate) — never both. Off, it counts.
  const home = receipt({ id: 'rh', category: 'home_office', amount: 30_000 }); // £300 actual
  const off = select({ receipts: [home] });
  check('U4 off · home_office receipt counts (£300)', off.deductibleExpenses, 300);
  check('U4 off · no home flat rate', off.useOfHomeAllowance, 0);

  const on = select({ receipts: [home], useOfHomeBand: '25-50' });
  check('U4 on · home_office receipt EXCLUDED (flat rate instead)', on.receiptDeductionsPence, 0);
  check('U4 on · home-conflict diagnostic counts it (£300)', on.diagnostics.receiptsHomeConflict.count, 1);
  check('U4 on · deductibleExpenses = the £120 flat rate, not the £300 receipt', on.deductibleExpenses, 120);
  checkSelectionReconciles('U4 on', on);
}

{ // U5. The classifier predicate directly (the canonical rule both surfaces use).
  const home = receipt({ category: 'home_office', amount: 5_000 });
  check('U5 · home_office counts when home flat rate OFF',
    classifyReceiptForEstimate(home, { flatRateInUse: false, homeFlatRateInUse: false }).counted, true);
  check('U5 · home_office EXCLUDED when home flat rate ON',
    classifyReceiptForEstimate(home, { flatRateInUse: false, homeFlatRateInUse: true }).counted, false);
}

{ // U6. Mileage + use-of-home stack independently into deductibleExpenses.
  const s = select({ jobs: [job()], businessMiles: 100, useOfHomeBand: '101-plus' });
  // mileage 100 × 55p = £55; home £26 × 12 = £312.
  check('U6 · mileage £55', s.mileageAllowance, 55);
  check('U6 · use-of-home £312', s.useOfHomeAllowance, 312);
  check('U6 · deductibleExpenses = £55 + £312 = £367', s.deductibleExpenses, 367);
  checkSelectionReconciles('U6', s);
}

// ── Paid/unpaid toggle (nextPaidState) — the received-date is the tax-period
//    date (§F), so it must never be silently overwritten or lost. ─────────────
{
  const MAR3 = Date.UTC(2026, 2, 3, 12); // real date the money arrived
  const NOW = Date.UTC(2026, 6, 12, 9); // "today" when the toggle is tapped

  // Genuine unpaid → paid stamps today.
  const fresh = nextPaidState({ status: 'unpaid', paidAt: undefined }, true, NOW);
  check('P1 · unpaid→paid status', fresh.status, 'paid');
  check('P1 · unpaid→paid stamps now', fresh.paidAt ?? 0, NOW);

  // Re-marking an already-paid job keeps the real date (the bulk-paid bug).
  const remark = nextPaidState({ status: 'paid', paidAt: MAR3 }, true, NOW);
  check('P2 · re-pay keeps original date (no overwrite)', remark.paidAt ?? 0, MAR3);

  // A legacy paid job with no stored date is NOT stamped today (keeps the
  // job-date fallback in paidJobDate, rather than jumping to today).
  const legacy = nextPaidState({ status: 'paid', paidAt: undefined }, true, NOW);
  check('P3 · legacy paid stays undated', legacy.paidAt ?? -1, -1);

  // Marking unpaid sets the date aside (kept on the record, not binned).
  const unpaid = nextPaidState({ status: 'paid', paidAt: MAR3 }, false, NOW);
  check('P4 · unpay status', unpaid.status, 'unpaid');
  check('P4 · unpay keeps date set aside', unpaid.paidAt ?? 0, MAR3);

  // Re-paying after an unpaid blip RESTORES the original date, never today.
  const restored = nextPaidState(unpaid, true, NOW);
  check('P5 · re-pay after unpay restores original date', restored.paidAt ?? 0, MAR3);
}

// ── ⑨ "Before SoleTax" — the mid-year starter (S137) ─────────────────────────
{
  // yearStarterForYear is the ONLY door between the stored answer and the maths.
  const answer = {
    yearStarterIncome: 4_200,
    yearStarterExpenses: 900,
    yearStarterMiles: 350,
    yearStarterTaxYear: YEAR,
    yearStarterDone: true,
  };
  const t = yearStarterForYear(answer, YEAR)!;
  check('YS1 · pounds → integer pence (income)', t.incomePence, 420_000);
  check('YS1 · pounds → integer pence (expenses)', t.expensesPence, 90_000);
  check('YS1 · miles pass through', t.miles, 350);
  check('YS2 · stale year never leaks → null', yearStarterForYear(answer, '2027-28') === null, true);
  check(
    'YS3 · answered-as-nothing → null',
    yearStarterForYear({ yearStarterTaxYear: YEAR, yearStarterDone: true }, YEAR) === null,
    true,
  );
  check(
    'YS4 · junk values sanitised → null',
    yearStarterForYear({ yearStarterIncome: NaN, yearStarterMiles: -5, yearStarterTaxYear: YEAR }, YEAR) === null,
    true,
  );

  // The selection fold: whole-year engine figures; app-recorded pence unchanged.
  const s = select({ yearStarter: { incomePence: 420_000, expensesPence: 90_000, miles: 0, cutoverMs: 0 } });
  check('YS5 · engine income includes the starter £4,200', s.incomeReceived, 4_200);
  check('YS5 · app-recorded income pence stay 0', s.incomeReceivedPence, 0);
  check('YS5 · engine deductions include the starter £900', s.deductibleExpenses, 900);
  checkSelectionReconciles('YS5', s);

  // Starter miles alone switch the §E flat rate on and earn the allowance.
  const m = select({ yearStarter: { incomePence: 0, expensesPence: 0, miles: 100, cutoverMs: 0 } });
  check('YS6 · flat rate in use from starter miles alone', m.flatRateInUse, true);
  check('YS6 · allowance = 100 × 55p', m.mileageAllowance, 55);

  // The 10k switch telescopes over the TRUE cumulative year: 9,900 pre-app +
  // 200 recorded = 10,100 → 10,000 at 55p + 100 at 25p.
  const tele = select({ businessMiles: 200, yearStarter: { incomePence: 0, expensesPence: 0, miles: 9_900, cutoverMs: 0 } });
  check('YS7 · 10k switch fires across starter + recorded miles', tele.mileageAllowance, 10_000 * 0.55 + 100 * 0.25);

  // ── The remainder (S137): pre-cutover records eat the declared lump ────────
  const CUT = T(2026, 7, 1); // "started with SoleTax" on 1 Jul 2026
  const DECL: YearStarterDeclared = { incomePence: 420_000, expensesPence: 90_000, miles: 0, cutoverMs: CUT };

  // A £1,000 job paid 10 Jun (pre-cutover) replaces its slice of the £4,200 —
  // the whole-year engine figure is UNCHANGED (that's the whole point).
  const r1 = select({ jobs: [job()], yearStarter: DECL });
  check('YS8 · pre-cutover job eats the lump', r1.yearStarterIncomePence, 320_000);
  check('YS8 · recorded slice exposed', r1.yearStarterRecordedIncomePence, 100_000);
  check('YS8 · whole-year engine income unchanged', r1.incomeReceived, 4_200);
  checkSelectionReconciles('YS8', r1);

  // A job paid AFTER the cutover is new money — the lump stays whole.
  const r2 = select({ jobs: [job({ paidAt: T(2026, 8, 10), date: '2026-08-10' })], yearStarter: DECL });
  check('YS9 · post-cutover job leaves the lump whole', r2.yearStarterIncomePence, 420_000);
  check('YS9 · engine income = job + lump', r2.incomeReceived, 5_200);

  // A record that doesn't COUNT (pending review) never eats the lump either —
  // decrementing on an uncounted record would understate the year.
  const r3 = select({ receipts: [receipt({ reviewStatus: 'needs_review', date: '2026-05-01' })], yearStarter: DECL });
  check('YS10 · uncounted record never eats the lump', r3.yearStarterExpensesPence, 90_000);

  // Floor at 0 — backfilled records beyond the declaration win.
  const r4 = select({ jobs: [job(), job(), job(), job(), job()], yearStarter: DECL });
  check('YS11 · lump floors at 0 (records win)', r4.yearStarterIncomePence, 0);
  check('YS11 · engine income = records alone', r4.incomeReceived, 5_000);

  // Miles: pre-cutover trip miles subtract via carVanMilesBeforeCutover.
  const r5 = select({
    businessMiles: 120,
    carVanMilesBeforeCutover: 80,
    yearStarter: { incomePence: 0, expensesPence: 0, miles: 100, cutoverMs: CUT },
  });
  check('YS12 · counted starter miles = 100 − 80', r5.yearStarterMiles, 20);
  check('YS12 · recorded miles exposed', r5.yearStarterRecordedMiles, 80);
  check('YS12 · allowance over trips + counted starter', r5.mileageAllowance, (120 + 20) * 0.55);
}

// ─────────────────────────────────────────────────────────────────────────────
if (failures > 0) {
  console.error(`\n❌ ${failures}/${checks} checks FAILED`);
  process.exit(1);
}
console.log(`✅ All ${checks} checks passed (worked examples: selectors + dashboard + derivations + ⑥ boundary exclusions + §5 £-input wiring + engine e2e: mileage/other-income/Box 60 + §E use-of-home + ⑨ year starter)`);
