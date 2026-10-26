/**
 * engine.ts — the compliance-bound tax-estimate engine (pure functions, no I/O).
 *
 * Every rate/threshold comes from rates-2026-27.ts (the single source of truth,
 * verbatim gov.uk — register §E/§J/§K/§N/§O); nothing numeric lives here. The
 * engine is deliberately UI-free: the Tax screen, the Home tax card and the
 * "off your tax" win-lines all derive from these results.
 *
 * THE MODEL — "what will Self Assessment ask me for?":
 * - Cash basis (§F/HS222): callers pass income RECEIVED, not invoiced.
 * - Other income (PAYE job, pension, rental — the onboarding "any other
 *   income?" answer) fills the bands and the allowance FIRST. The estimate is
 *   the business-attributable bill: tax(other + profit) − tax(other alone).
 *   Tax on the other income itself is assumed already collected (PAYE) — if it
 *   isn't (e.g. rental), the SA bill will be higher; UI copy discloses.
 * - Savings (§T) then dividends (§S) stack on top of non-savings income (savings
 *   the middle slice, dividends the top): each has its own 0% allowances and UK
 *   rates/limits, UK-wide even for Scotland. NEVER taxed at source, so unlike
 *   PAYE other income both are INCLUDED in the set-aside total as their own
 *   lines, not merely disclosed (decided 2026-06-20).
 * - Pension (relief at source) + Gift Aid (§V): the NET contribution is grossed up
 *   at the 20% basic rate (gross = net ÷ 0.8), and that gross EXTENDS the basic-rate
 *   band (so higher/additional-rate income drops to basic — the extra relief) AND
 *   reduces adjusted net income. Applied to the combined position only (PAYE never
 *   gives SA relief); Class 4 NIC and student loans are unaffected (RAS doesn't
 *   reduce them).
 * - Adjusted net income for the PA taper AND the §U HICBC = profit + other income +
 *   savings + dividends − the grossed-up pension/Gift Aid contributions (§V).
 * - High Income Child Benefit Charge (§U): if the user claims Child Benefit and
 *   that SAME adjusted net income exceeds £60,000, a clawback of 1% of the year's
 *   Child Benefit per complete £200 over £60,000 (100% at £80,000+; ITEPA 2003
 *   s681C). It is part of Income Tax due, never collected at source, so it is
 *   INCLUDED in the set-aside total AND sits inside the payments-on-account base
 *   (SA110 box A356 removes only Class 2 + student/postgrad loans + coded-out —
 *   not HICBC), unlike the student loan. Two deliberate simplifications (logged
 *   S78): it assumes the user is the liable (higher-earning) partner, and that
 *   Child Benefit was received for the WHOLE year at the standard weekly rates
 *   (children count × rate × 52). A mid-year birth, a claim that started/stopped,
 *   or a child ageing out lowers the real receipt — so the charge is then
 *   slightly OVER-stated, never under (safe for a set-aside). We ask only the
 *   children count, not the £ received, because HMRC fixes the per-child weekly
 *   rate; an "actual Child Benefit" override is intentionally NOT built (the
 *   over-statement is the conservative direction — decided S78).
 * - Trading allowance vs actual expenses is a per-year filing choice; the
 *   engine assumes whichever gives the lower tax and discloses the basis.
 * - Student loans (§O): plan rate over the threshold on TOTAL income, minus
 *   what the threshold maths says the other income already repaid (PAYE
 *   deducts on salary). Repaid through SA, but EXCLUDED from POAs (§N).
 * - CIS (§I): deductions contractors withheld at source "count as advance
 *   payments towards your tax and National Insurance bill" — HMRC takes them
 *   off the SA bill, refunding any excess. The engine nets cisDeductionsWithheld
 *   off the January balance AND off the POA basis (SALF303: POAs are 50% of the
 *   RELEVANT amount = assessed minus deducted at source).
 * - Payments on account (§N/SALF303): required once the relevant amount
 *   (IT + Class 4, net of CIS withheld) is £1,000+ AND at least 1/5 of the
 *   assessed bill; each instalment is half the relevant amount (31 Jan/31 Jul).
 *   The PAYE side of the 80%-at-source exemption can't be evaluated from app
 *   data — UI copy discloses it; the CIS side IS evaluated here.
 * - Losses: a cash-basis loss shows as £0 taxable profit here. Loss relief is
 *   an accountant conversation, not an estimate feature.
 *
 * Worked-example test set: scripts/test-tax-engine.ts (hand-computed from the
 * verbatim bands — re-run on every rates change; part of the annual review).
 */

import {
  CHILD_BENEFIT,
  CLASS_2_NIC,
  CLASS_4_NIC,
  DEFAULT_NATION,
  DIVIDEND_TAX,
  HICBC,
  INCOME_TAX_BANDS_RUK,
  INCOME_TAX_BANDS_SCOTLAND,
  PAYMENTS_ON_ACCOUNT,
  PENSION_GIFT_AID,
  PERSONAL_ALLOWANCE,
  SAVINGS_TAX,
  STUDENT_LOAN,
  TAX_RATES_EDITION,
  TRADING_ALLOWANCE,
  type IncomeTaxBand,
  type StudentLoanPlan,
  type UKNation,
} from './rates-2026-27';

export interface TaxEstimateInput {
  /** Tax year being estimated, e.g. '2026-27' (src/lib/taxYear.ts getTaxYear()). */
  taxYear: string;
  /** Which Income Tax bands apply. NIC is UK-wide regardless (§J). */
  nation?: UKNation;
  /** £ business income actually RECEIVED this tax year (cash basis, §F). */
  incomeReceived: number;
  /** £ allowable expenses for the year, including the mileage allowance (§E).
   *  Must EXCLUDE van_vehicle running-cost receipts whenever the mileage flat
   *  rate is in use (§E / sa103f-2026.ts mileageConflict) — never both. */
  deductibleExpenses: number;
  /** £ other taxable income this year (PAYE job, pension, rental) — the
   *  onboarding answer. Fills the bands + allowance before profit. Default 0. */
  otherTaxableIncome?: number;
  /** £ dividend income this year (§S). Taxed as the TOP slice with its own £500
   *  allowance + UK rates/limits; NEVER taxed at source, so its tax is INCLUDED
   *  in the set-aside total (not merely disclosed). Default 0. */
  dividendIncome?: number;
  /** £ savings interest this year (§T). Taxed as the MIDDLE slice (above other
   *  income, below dividends) with the starting-rate band + PSA; never at source,
   *  so its tax is INCLUDED in the set-aside total. Default 0. */
  savingsIncome?: number;
  /** Student loan plan from onboarding (§O). Undefined/absent = no loan. */
  studentLoanPlan?: StudentLoanPlan;
  /** Postgraduate Loan — repaid in addition to a plan loan (§O). */
  postgradLoan?: boolean;
  /** £ CIS deductions contractors withheld at source this year (§I) — advance
   *  payments toward the bill. Nets the January balance and the POA basis. */
  cisDeductionsWithheld?: number;
  /** Number of children Child Benefit is claimed for (§U). Drives the High Income
   *  Child Benefit Charge once adjusted net income exceeds £60,000. Assumes the
   *  user is the liable (higher-earning) partner. Default 0 / absent = no charge. */
  childBenefitChildren?: number;
  /** £ NET personal pension contributions paid this year under relief at source
   *  (§V). Grossed up at the 20% basic rate (÷ 0.8) → extends the basic-rate band
   *  and reduces adjusted net income. Default 0. (Net-pay/salary-sacrifice schemes
   *  are out of scope — they reduce taxable pay directly, not modelled here.) */
  pensionContributionsNet?: number;
  /** £ NET Gift Aid donations this year (§V). Grossed up at 20% (÷ 0.8) — same
   *  band-extension + ANI-reduction effect as a pension contribution. Default 0. */
  giftAidDonationsNet?: number;
}

export interface BandLine {
  name: string;
  rate: number;
  /** Verbatim gov.uk income range, for the "How we work this out" disclosure. */
  range: string;
  /** £ of income falling in this band. */
  amount: number;
  /** £ tax charged by this band (amount × rate, unrounded). */
  tax: number;
}

export interface TaxEstimate {
  /** The year the caller asked about. */
  taxYear: string;
  /** The year the applied rates actually cover — differs only if the rates file
   *  is stale for the requested year; the UI MUST disclose a mismatch. */
  ratesTaxYear: string;
  nation: UKNation;

  incomeReceived: number;
  deductibleExpenses: number;
  otherTaxableIncome: number;
  /** Which deduction produced the lower tax: actual expenses, or the £1,000
   *  trading allowance (§K) when expenses come to less than that. */
  deductionBasis: 'expenses' | 'trading-allowance';
  deductionApplied: number;
  /** £ profit after the applied deduction, floored at 0 (no loss relief here). */
  taxableProfit: number;

  /** Personal Allowance after the over-£100k taper on TOTAL income (§K). */
  personalAllowance: number;
  /** £ newly exposed to Income Tax by the profit (can exceed the profit when
   *  it drags the allowance taper — that extra exposure is real). */
  taxableAfterAllowance: number;

  /** Income Tax attributable to the business: tax(other + profit) − tax(other),
   *  on NON-dividend income (the PA taper uses total income incl. dividends). */
  incomeTax: number;
  /** The band slices the PROFIT occupies (combined minus other-alone, per band). */
  incomeTaxBands: BandLine[];

  /** §S dividend income this year (echoed input, clamped ≥ 0). */
  dividendIncome: number;
  /** §S dividend tax due at SA — top slice, £500 allowance, UK ordinary/upper/
   *  additional rates positioned by the UK band limits (even for Scotland).
   *  INCLUDED in totalTax (dividends are never taxed at source). 0 when none. */
  dividendTax: number;
  /** Dividend band slices: the £500 allowance (0%) + ordinary/upper/additional. */
  dividendTaxBands: BandLine[];

  /** §T savings interest this year (echoed input, clamped ≥ 0). */
  savingsIncome: number;
  /** §T savings-interest tax due at SA — middle slice, 0% starting-rate band +
   *  PSA, then 20/40/45 by UK band position (UK-wide even for Scotland). INCLUDED
   *  in totalTax (never taxed at source). 0 when none. */
  savingsTax: number;
  /** Savings band slices: starting rate (0%) + PSA (0%) + basic/higher/additional. */
  savingsTaxBands: BandLine[];

  /** §U adjusted net income the HICBC (and the PA taper) test against: profit +
   *  other income + savings + dividends (pension/Gift Aid relief not yet modelled). */
  adjustedNetIncome: number;
  /** §U number of children Child Benefit is claimed for (echoed input, clamped ≥ 0). */
  childBenefitChildren: number;
  /** §U annual Child Benefit those children attract (2026-27 weekly rates × 52). */
  childBenefitReceived: number;
  /** §U the clawback percentage applied (0–100) — floor((ANI − £60,000)/£200),
   *  capped 100, 0 at/below £60,000 (ITEPA 2003 s681C). */
  hicbcPercent: number;
  /** §U High Income Child Benefit Charge = hicbcPercent% × childBenefitReceived.
   *  Part of Income Tax due → INCLUDED in totalTax and the POA basis (never taxed
   *  at source). 0 when no children are claimed or ANI ≤ £60,000. */
  hicbcCharge: number;

  /** §V NET pension contributions this year (echoed input, clamped ≥ 0). */
  pensionContributionsNet: number;
  /** §V NET Gift Aid donations this year (echoed input, clamped ≥ 0). */
  giftAidDonationsNet: number;
  /** §V the grossed-up pension + Gift Aid total (net ÷ 0.8): the amount the
   *  basic-rate band is extended by, and adjusted net income is reduced by. */
  reliefGrossedUp: number;
  /** §V Income Tax saved by the contributions on the combined position — the
   *  higher/additional-rate top-up beyond the 20% already given at source, plus any
   *  PA the lowered ANI restores. 0 when no contributions / already basic rate. */
  pensionGiftAidRelief: number;

  /** Class 4 NIC on profit (§J) — UK-wide, unaffected by the allowance or other income. */
  class4Nic: number;
  class4Bands: BandLine[];
  /** §J: ≥ £7,105 profit → Class 2 treated as paid (nothing due, record protected);
   *  below → nothing due, voluntary Class 2 available. Never a charge. */
  class2Status: 'treated-as-paid' | 'below-threshold-voluntary';

  /** Student loan repayment collected via SA, attributable to the profit (§O).
   *  0 when no plan is set. Excluded from POAs — paid in the balancing payment. */
  studentLoan: number;

  /** Income Tax (incl. dividend + savings tax + HICBC) + Class 4 — what SA assesses
   *  and the payments-on-account base (gross of CIS withheld). HICBC sits here, not
   *  with the student loan, because SA110 keeps it inside the POA base (§U). */
  totalTax: number;
  /** totalTax + studentLoan — everything SA will collect, gross of CIS. */
  totalOwed: number;

  /** £ CIS withheld at source (echoed input, clamped ≥ 0). §I: advance payments. */
  cisDeductionsWithheld: number;
  /** The January balancing payment: totalOwed minus CIS withheld, floor £0. */
  balancingPayment: number;
  /** §I: withheld beyond the bill — "If you're due a tax refund, HMRC will pay
   *  the money back." 0 for non-CIS users. */
  cisRefundDue: number;

  /** §N/SALF303 payments on account, assuming this estimate becomes the SA bill.
   *  Computed on the RELEVANT amount: (IT + Class 4) minus CIS withheld. */
  paymentsOnAccount: {
    /** Relevant amount ≥ £1,000 AND ≥ 1/5 of the assessed bill. The PAYE side
     *  of the 80%-at-source exemption is NOT evaluated here — UI copy must
     *  mention it for users with large PAYE income. CIS withholding IS counted. */
    required: boolean;
    /** Half the relevant amount — due 31 January and 31 July. */
    each: number;
  };
  /** First SA year's 31 January total: the balancing payment (incl. student
   *  loan, net of CIS withheld) PLUS the first payment on account — the "150%
   *  surprise" the set-aside must cover. Equals the balancing payment when
   *  POAs aren't required; £0 when CIS already covers everything. */
  firstYearJanuaryTotal: number;
}

function bandsFor(nation: UKNation): IncomeTaxBand[] {
  return nation === 'scotland' ? INCOME_TAX_BANDS_SCOTLAND : INCOME_TAX_BANDS_RUK;
}

/** PA after the §K taper: −£1 per £2 of adjusted net income over £100,000, floor £0.
 *  ITA 2007 s35(3): the allowance remaining after the taper, if "not a multiple of
 *  £1, is to be rounded UP to the nearest amount which is a multiple of £1" (in the
 *  taxpayer's favour). Matters only for odd-pound ANI in the £100k–125,140 zone;
 *  without the round-up the estimate over-taxes by ≤ ~£0.24 (caught 2026-06-21 by the
 *  cooltaxtool independent oracle — our self-authored references shared the omission;
 *  register §K, legislation.gov.uk/ukpga/2007/3/section/35). */
function taperedPersonalAllowance(adjustedNetIncome: number): number {
  const excess = Math.max(0, adjustedNetIncome - PERSONAL_ALLOWANCE.taperThreshold);
  return Math.ceil(Math.max(0, PERSONAL_ALLOWANCE.standard - excess / PERSONAL_ALLOWANCE.taperDivisor));
}

/** Slice taxable income across bands (ceilings are taxable-income amounts). */
function sliceIntoBands(taxable: number, bands: IncomeTaxBand[]): BandLine[] {
  const lines: BandLine[] = [];
  let floor = 0;
  for (const band of bands) {
    const amount = Math.max(0, Math.min(taxable, band.upToTaxable) - floor);
    if (amount > 0) {
      lines.push({ name: band.name, rate: band.rate, range: band.range, amount, tax: amount * band.rate });
    }
    floor = band.upToTaxable;
    if (taxable <= floor) break;
  }
  return lines;
}

// UK income-tax band limits (taxable income) — savings AND dividends are
// positioned by these for ALL nations, including Scotland (§T / §S / register §K).
const UK_BASIC_RATE_LIMIT = INCOME_TAX_BANDS_RUK[0].upToTaxable; // £37,700
const UK_HIGHER_RATE_LIMIT = INCOME_TAX_BANDS_RUK[1].upToTaxable; // £125,140

/** §V pension/Gift Aid relief at source: extend the basic-rate (20%) band — and
 *  every band above it — by the grossed-up contribution. For Scotland the 19%
 *  starter band sits BELOW the 20% basic band and is left unchanged (extending the
 *  20% band ⇔ the SA top-ups of 1/22/25/28% = each Scottish rate − 20%). For rUK
 *  this lifts both the £37,700 and £125,140 limits; SA110 box A119 confirms both. */
function extendBands(bands: IncomeTaxBand[], ext: number): IncomeTaxBand[] {
  if (ext <= 0) return bands;
  const basicIdx = bands.findIndex((b) => b.rate >= PENSION_GIFT_AID.basicRate - 1e-9);
  return bands.map((b, i) =>
    i >= basicIdx && Number.isFinite(b.upToTaxable) ? { ...b, upToTaxable: b.upToTaxable + ext } : b,
  );
}

/** §T: tax TAXABLE savings interest — the MIDDLE slice (above non-savings income,
 *  below dividends), starting at `offset`. The 0% starting-rate band and the 0%
 *  Personal Savings Allowance both consume band space; the remainder is taxed at
 *  the main rates 20/40/45 by UK band position — UK-wide even for Scotland. */
function sliceSavings(
  taxableSavings: number,
  offset: number,
  startingRateBand: number,
  psa: number,
  ukBasic: number,
  ukHigher: number,
): BandLine[] {
  if (taxableSavings <= 0) return [];
  const lines: BandLine[] = [];
  let pos = offset;
  let remaining = taxableSavings;
  const sr = Math.min(remaining, Math.max(0, startingRateBand));
  if (sr > 0) {
    lines.push({ name: 'Starting rate for savings', rate: 0, range: '0%', amount: sr, tax: 0 });
    pos += sr;
    remaining -= sr;
  }
  const ps = Math.min(remaining, Math.max(0, psa));
  if (ps > 0) {
    lines.push({ name: 'Personal savings allowance', rate: 0, range: '0%', amount: ps, tax: 0 });
    pos += ps;
    remaining -= ps;
  }
  const steps = [
    { upTo: ukBasic, rate: SAVINGS_TAX.basicRate, name: 'Savings basic rate' },
    { upTo: ukHigher, rate: SAVINGS_TAX.higherRate, name: 'Savings higher rate' },
    { upTo: Infinity, rate: SAVINGS_TAX.additionalRate, name: 'Savings additional rate' },
  ];
  for (const s of steps) {
    if (remaining <= 0) break;
    if (pos >= s.upTo) continue;
    const amount = Math.min(remaining, s.upTo - pos);
    lines.push({ name: s.name, rate: s.rate, range: `${(s.rate * 100).toFixed(0)}%`, amount, tax: amount * s.rate });
    pos += amount;
    remaining -= amount;
  }
  return lines;
}

/** §S: tax TAXABLE dividends as the TOP slice, starting at `offset` (the taxable
 *  non-dividend income already occupying the band structure). The £500 allowance
 *  is a 0% rate that STILL consumes band space; the ordinary/upper/additional
 *  steps follow the UK taxable-income limits (37,700 / 125,140) for ALL nations
 *  — Scottish taxpayers use UK dividend rates AND UK band limits (§S). */
function sliceDividends(taxableDividends: number, offset: number, ukBasic: number, ukHigher: number): BandLine[] {
  if (taxableDividends <= 0) return [];
  const lines: BandLine[] = [];
  const allowanceUsed = Math.min(DIVIDEND_TAX.allowance, taxableDividends);
  if (allowanceUsed > 0) {
    lines.push({ name: 'Dividend allowance', rate: 0, range: `first £${DIVIDEND_TAX.allowance}`, amount: allowanceUsed, tax: 0 });
  }
  let pos = offset + allowanceUsed; // the 0% allowance still advances the band position
  let remaining = taxableDividends - allowanceUsed;
  const steps = [
    { upTo: ukBasic, rate: DIVIDEND_TAX.ordinaryRate, name: 'Dividend ordinary rate' },
    { upTo: ukHigher, rate: DIVIDEND_TAX.upperRate, name: 'Dividend upper rate' },
    { upTo: Infinity, rate: DIVIDEND_TAX.additionalRate, name: 'Dividend additional rate' },
  ];
  for (const s of steps) {
    if (remaining <= 0) break;
    if (pos >= s.upTo) continue;
    const amount = Math.min(remaining, s.upTo - pos);
    lines.push({ name: s.name, rate: s.rate, range: `${(s.rate * 100).toFixed(2)}%`, amount, tax: amount * s.rate });
    pos += amount;
    remaining -= amount;
  }
  return lines;
}

// ── Personal Allowance allocation across income types — ITA 2007 s25 ────────────
// 2026-27 (this engine's only year): s25(2) requires reliefs/allowances be deducted
// "in the way which will result in the greatest reduction in the taxpayer's liability"
// — i.e. the PA is split across non-savings / savings / dividends to MINIMISE tax
// (beneficial allocation), NOT simply non-savings-first. It differs from non-savings-
// first only for higher/additional-rate taxpayers with savings/dividends, where moving
// PA onto investment income can drop it into a 0% nil band or out of a higher band; the
// difference is always in the taxpayer's favour (s25(2) = the minimum), so the fixed
// order can only ever OVER-state.
//
// ⚠ ROLLOVER GUARD — FROM 2027-28 the law switches (ITA 2007 s25(3A), FA 2025) to a
// FIXED order: non-property/savings/dividend income first, then property, savings,
// dividends — which IS non-savings-first. To make that transition impossible to forget,
// this flag is KEYED TO THE RATES EDITION rather than a bare `true`: it is on ONLY for
// 2026-27, so the day TAX_RATES_EDITION.taxYear is bumped to the next year it AUTOMATICALLY
// turns off and the engine falls back to the `fixed` split below (which already implements
// s25(3A)). A new year that genuinely needs beneficial allocation again would have to add
// itself here deliberately. (CI also goes red on 6 April 2027 via TAX_RATES_EDITION.reviewBy,
// forcing the whole rates file — this flag included — to be re-confirmed for the new year.)
// [Sources, all read 2026-06-21: legislation.gov.uk ITA 2007 s16 (order) + s25 (greatest
// reduction / s25(3A) from 2027-28); gov.uk "Change to tax rates for property, savings
// and dividend income — technical note"; HMRC SAIM1110 worked example; register §K.]
const BENEFICIAL_PA_ALLOCATION = TAX_RATES_EDITION.taxYear === '2026-27';

interface Split { taxableNs: number; taxableSav: number; taxableDiv: number; }

/** Income tax (non-savings + savings + dividends) for an EXPLICIT taxable split — the
 *  three taxable amounts already net of their PA allocation. Positions stack
 *  non-savings → savings → dividends; savings/dividends use UK rates + (extended) UK
 *  limits even for Scotland. The PSA is set by the top rate on the TOTAL taxable (the
 *  three summed — invariant across allocations). Pure: holds no PA-allocation policy. */
function taxForSplit(s: Split, nation: UKNation, ext: number) {
  const bands = extendBands(bandsFor(nation), ext);
  const ukBasic = UK_BASIC_RATE_LIMIT + ext;
  const ukHigher = UK_HIGHER_RATE_LIMIT + ext;
  const totalTaxable = s.taxableNs + s.taxableSav + s.taxableDiv;

  const lines = sliceIntoBands(s.taxableNs, bands);
  const tax = lines.reduce((a, l) => a + l.tax, 0);

  const psa =
    totalTaxable > ukHigher ? SAVINGS_TAX.psaAdditional
      : totalTaxable > ukBasic ? SAVINGS_TAX.psaHigher : SAVINGS_TAX.psaBasic;
  const startingRateBand = Math.max(0, SAVINGS_TAX.startingRateBand - s.taxableNs);
  const savingsLines = sliceSavings(s.taxableSav, s.taxableNs, startingRateBand, psa, ukBasic, ukHigher);
  const savingsTax = savingsLines.reduce((a, l) => a + l.tax, 0);

  const dividendLines = sliceDividends(s.taxableDiv, s.taxableNs + s.taxableSav, ukBasic, ukHigher);
  const dividendTax = dividendLines.reduce((a, l) => a + l.tax, 0);

  return { lines, tax, savingsLines, savingsTax, dividendLines, dividendTax, total: tax + savingsTax + dividendTax };
}

/** The fixed non-savings → savings → dividends PA split (2027-28 rule; the default
 *  candidate, and the only behaviour when there's no investment income). */
function fixedSplit(nonSavings: number, savings: number, dividends: number, allowance: number): Split {
  const aNs = Math.min(allowance, nonSavings);
  const aSav = Math.min(allowance - aNs, savings);
  const aDiv = Math.min(allowance - aNs - aSav, dividends);
  return { taxableNs: nonSavings - aNs, taxableSav: savings - aSav, taxableDiv: dividends - aDiv };
}

/** Allocate the (fixed-size) PA across the three income types to MINIMISE tax — the
 *  s25(2) "greatest reduction" rule (2026-27). The tax function is piecewise-linear in
 *  the split, so its minimum sits at a VERTEX where some taxable amount lands on a band
 *  or nil-band edge; we enumerate those breakpoint candidates (plus the fixed split and
 *  the feasible extremes) and keep the cheapest valid one. When savings = dividends = 0
 *  there is nothing to move, so it returns the fixed split unchanged. Proven equal to an
 *  exhaustive £1 search in scripts/test-tax-engine.ts. */
function allocatePersonalAllowance(
  nonSavings: number, savings: number, dividends: number, allowance: number, nation: UKNation, ext: number,
): Split {
  const fixed = fixedSplit(nonSavings, savings, dividends, allowance);
  if (!BENEFICIAL_PA_ALLOCATION || (savings <= 0 && dividends <= 0)) return fixed;

  const T = Math.max(0, nonSavings + savings + dividends - allowance);
  const ukBasic = UK_BASIC_RATE_LIMIT + ext;
  const ukHigher = UK_HIGHER_RATE_LIMIT + ext;

  // The tax kinks where a type boundary lands on a band edge OR a 0% nil band fills
  // exactly. Candidate positions for each boundary:
  //  • non-savings (taxableNs): band edges + the starting-rate cliff (£5,000) + extremes
  //  • savings taxable: 0, its nil-band capacities (starting rate, PSA), its full amount
  //  • dividends taxable: 0, the £500 dividend allowance, its full amount
  // The optimum is a VERTEX where TWO boundaries are pinned — so we fix every pair of
  // candidates and DERIVE the third (= T − the two). Fixing only ns+sav (the prior bug)
  // missed vertices where savings AND dividends both sit exactly in their nil bands.
  const nsEdges = [
    0, Math.min(nonSavings, T), Math.max(0, T - savings - dividends),
    SAVINGS_TAX.startingRateBand, ukBasic, ukHigher,
    ...bandsFor(nation).map((b) => b.upToTaxable).filter((x) => Number.isFinite(x)),
  ];
  const savCaps = [
    0, savings, SAVINGS_TAX.psaBasic, SAVINGS_TAX.psaHigher,
    SAVINGS_TAX.startingRateBand, SAVINGS_TAX.startingRateBand + SAVINGS_TAX.psaBasic,
  ];
  const divCaps = [0, DIVIDEND_TAX.allowance, dividends];

  let best = fixed;
  let bestTax = taxForSplit(fixed, nation, ext).total;
  const consider = (tNs: number, tSav: number, tDiv: number) => {
    if (tNs < -1e-9 || tSav < -1e-9 || tDiv < -1e-9) return;
    if (tNs > nonSavings + 1e-9 || tSav > savings + 1e-9 || tDiv > dividends + 1e-9) return;
    if (Math.abs(tNs + tSav + tDiv - T) > 1e-6) return; // must use exactly T of taxable income
    const split = { taxableNs: Math.max(0, tNs), taxableSav: Math.max(0, tSav), taxableDiv: Math.max(0, tDiv) };
    const t = taxForSplit(split, nation, ext).total;
    if (t < bestTax - 1e-9) { bestTax = t; best = split; }
  };
  for (const ns of nsEdges) for (const sav of savCaps) consider(ns, sav, T - ns - sav);      // pin ns + sav
  for (const sav of savCaps) for (const div of divCaps) consider(T - sav - div, sav, div);    // pin sav + div
  for (const ns of nsEdges) for (const div of divCaps) consider(ns, T - ns - div, div);        // pin ns + div
  return best;
}

/** Full Income Tax position for given non-savings/non-dividend income + optional
 *  savings + dividends. The income stacks NON-SAVINGS → SAVINGS (§T) → DIVIDENDS
 *  (§S, top). The PA taper uses TOTAL income; the PA is then allocated across the three
 *  to minimise tax per ITA 2007 s25(2) (see allocatePersonalAllowance). Non-savings is
 *  taxed at the nation's bands; savings and dividends at UK rates positioned by UK band
 *  limits (even for Scotland). `bandExtension` (§V) is the grossed-up pension/Gift Aid
 *  contribution: it widens the basic-rate band (and the UK savings/dividend limits) and
 *  reduces the taper's adjusted net income. `.tax` is the non-savings/non-dividend
 *  income tax — unchanged for callers passing neither extra. Exported for the harness. */
export function incomeTaxOn(nonSavingsNonDividend: number, nation: UKNation, dividends = 0, savings = 0, bandExtension = 0) {
  const ext = Math.max(0, bandExtension);
  const total = nonSavingsNonDividend + savings + dividends;
  // §V: the grossed-up pension/Gift Aid contribution reduces adjusted net income for
  // the PA taper (and widens the bands below).
  const allowance = taperedPersonalAllowance(total - ext);

  // ITA 2007 s25(2): split the PA across non-savings/savings/dividends for the greatest
  // reduction in liability (2026-27). taxable = the non-savings taxable amount.
  const split = allocatePersonalAllowance(nonSavingsNonDividend, savings, dividends, allowance, nation, ext);
  const { taxableNs: taxable, taxableSav: savingsTaxable, taxableDiv: dividendTaxable } = split;

  const { lines, tax, savingsLines, savingsTax, dividendLines, dividendTax } = taxForSplit(split, nation, ext);

  return { allowance, taxable, lines, tax, savingsTaxable, savingsLines, savingsTax, dividendTaxable, dividendLines, dividendTax };
}

/** §O: annual student-loan repayment on a given total income. */
function studentLoanOn(totalIncome: number, plan?: StudentLoanPlan, postgrad?: boolean): number {
  let due = 0;
  if (plan) {
    const p = STUDENT_LOAN.plans[plan];
    due += Math.max(0, totalIncome - p.threshold) * p.rate;
  }
  if (postgrad) {
    due += Math.max(0, totalIncome - STUDENT_LOAN.postgrad.threshold) * STUDENT_LOAN.postgrad.rate;
  }
  return due;
}

/** Per-band difference: the slices the profit occupies on top of other income. */
function diffBandLines(combined: BandLine[], baseline: BandLine[]): BandLine[] {
  const base = new Map(baseline.map((l) => [l.name, l]));
  return combined
    .map((l) => {
      const b = base.get(l.name);
      return b ? { ...l, amount: l.amount - b.amount, tax: l.tax - b.tax } : l;
    })
    .filter((l) => l.amount > 0.000001);
}

export function calculateTaxEstimate(input: TaxEstimateInput): TaxEstimate {
  const nation = input.nation ?? DEFAULT_NATION;
  const incomeReceived = Math.max(0, input.incomeReceived);
  const deductibleExpenses = Math.max(0, input.deductibleExpenses);
  const otherTaxableIncome = Math.max(0, input.otherTaxableIncome ?? 0);
  const dividendIncome = Math.max(0, input.dividendIncome ?? 0);
  const savingsIncome = Math.max(0, input.savingsIncome ?? 0);
  const childBenefitChildren = Math.max(0, Math.floor(input.childBenefitChildren ?? 0));
  const pensionContributionsNet = Math.max(0, input.pensionContributionsNet ?? 0);
  const giftAidDonationsNet = Math.max(0, input.giftAidDonationsNet ?? 0);
  // §V relief at source: gross the NET pension + Gift Aid up at the 20% basic rate
  // (net ÷ 0.8). This single gross figure both extends the basic-rate band and
  // reduces adjusted net income (the PA taper + the §U HICBC).
  const reliefGrossedUp = (pensionContributionsNet + giftAidDonationsNet) / (1 - PENSION_GIFT_AID.basicRate);

  // §K trading allowance: claimed INSTEAD of actual expenses, cannot create a
  // loss. Assume the filing choice a rational filer makes — the larger deduction
  // (capped at income either way) — and disclose the basis.
  const useTradingAllowance = incomeReceived > 0 && deductibleExpenses < TRADING_ALLOWANCE;
  const deductionApplied = useTradingAllowance
    ? Math.min(TRADING_ALLOWANCE, incomeReceived)
    : deductibleExpenses;
  const taxableProfit = Math.max(0, incomeReceived - deductionApplied);

  // Income Tax attributable to the business: the combined position minus the
  // position the other income holds on its own (≈ what PAYE already collects,
  // including the full allowance an employer tax code gives it). Taper falls on
  // whichever side actually causes it — combined uses combined ANI, the
  // baseline its own. §V pension/Gift Aid relief is applied to the COMBINED side
  // only (PAYE never gives SA relief), so the full relief lands in this difference.
  const combined = incomeTaxOn(otherTaxableIncome + taxableProfit, nation, dividendIncome, savingsIncome, reliefGrossedUp);
  const baseline = incomeTaxOn(otherTaxableIncome, nation, 0, 0);
  const incomeTax = combined.tax - baseline.tax;
  const incomeTaxBands = diffBandLines(combined.lines, baseline.lines);
  const taxableAfterAllowance = combined.taxable - baseline.taxable;

  // §V relief figure (disclosure): the Income Tax the contributions save on the
  // combined position — the higher/additional-rate top-up beyond the 20% already
  // given at source, plus any PA the lowered ANI restores. combinedNoExt is the same
  // position WITHOUT the band extension. (Not subtracted again anywhere — it is
  // already reflected inside `incomeTax`; this is just the visible headline.)
  const combinedNoExt =
    reliefGrossedUp > 0
      ? incomeTaxOn(otherTaxableIncome + taxableProfit, nation, dividendIncome, savingsIncome, 0)
      : combined;
  const pensionGiftAidRelief =
    combinedNoExt.tax + combinedNoExt.savingsTax + combinedNoExt.dividendTax -
    (combined.tax + combined.savingsTax + combined.dividendTax);

  // §S/§T Dividends + savings: the user's full tax on each, computed at the
  // combined position (they sit on top of all their non-savings income). NEVER
  // taxed at source, so — unlike PAYE other income — both are INCLUDED in the
  // set-aside total, not just disclosed (decided 2026-06-20). The PAYE-collected
  // baseline (other income alone) carries neither, so they are not netted out.
  const dividendTax = combined.dividendTax;
  const dividendTaxBands = combined.dividendLines;
  const savingsTax = combined.savingsTax;
  const savingsTaxBands = combined.savingsLines;

  // §U High Income Child Benefit Charge: 1% of the year's Child Benefit per
  // COMPLETE £200 of adjusted net income over £60,000, capped at 100% above
  // £80,000 (ITEPA 2003 s681C). s681C(3) rounds DOWN to a whole number at THREE
  // points: the percentage, the Child Benefit total, and the resulting charge —
  // see hicbcCharge below.
  // ANI is the same figure the PA taper uses (profit + other income + savings +
  // dividends; pension/Gift Aid relief not yet modelled). The charge is Income Tax
  // due, never collected at source → part of totalTax + the POA basis (SA110
  // A277→A328→A340; box A356 keeps it), and assumes the user is the liable partner.
  const adjustedNetIncome = Math.max(
    0,
    otherTaxableIncome + taxableProfit + savingsIncome + dividendIncome - reliefGrossedUp,
  );
  const childBenefitReceived =
    childBenefitChildren > 0
      ? (CHILD_BENEFIT.weeklyEldest + (childBenefitChildren - 1) * CHILD_BENEFIT.weeklyAdditional) *
        CHILD_BENEFIT.weeksPerYear
      : 0;
  const hicbcPercent =
    childBenefitReceived > 0 && adjustedNetIncome > HICBC.threshold
      ? Math.min(100, Math.floor((adjustedNetIncome - HICBC.threshold) / HICBC.incomeStep))
      : 0;
  // ITEPA 2003 s681C(3): the Child Benefit total AND the charge are each rounded
  // DOWN to a whole number of pounds (the % too — floored above). The CB is floored
  // FIRST, then the charge. Confirmed penny-exact vs TaxCalc (HMRC-recognised) on the
  // golden set, incl. the CB-floored-first discriminator (golden G30: floor(£2,251) ×
  // 92% = £2,070.92 → £2,070, NOT floor(£2,251.60 × 92%) = £2,071). childBenefitReceived
  // itself keeps the true pennies for display; only the charge maths floors.
  const hicbcCharge = Math.floor(Math.floor(childBenefitReceived) * (hicbcPercent / 100));

  // Class 4 NIC (§J): on profit directly, UK-wide; other income is irrelevant
  // (employment NIC is Class 1, the employer's problem).
  const class4Bands: BandLine[] = [];
  const mainBand = Math.max(
    0,
    Math.min(taxableProfit, CLASS_4_NIC.upperProfitsLimit) - CLASS_4_NIC.lowerProfitsLimit,
  );
  if (mainBand > 0) {
    class4Bands.push({
      name: 'Class 4 main rate',
      rate: CLASS_4_NIC.mainRate,
      range: `£${CLASS_4_NIC.lowerProfitsLimit.toLocaleString('en-GB')} to £${CLASS_4_NIC.upperProfitsLimit.toLocaleString('en-GB')}`,
      amount: mainBand,
      tax: mainBand * CLASS_4_NIC.mainRate,
    });
  }
  const upperBand = Math.max(0, taxableProfit - CLASS_4_NIC.upperProfitsLimit);
  if (upperBand > 0) {
    class4Bands.push({
      name: 'Class 4 additional rate',
      rate: CLASS_4_NIC.additionalRate,
      range: `over £${CLASS_4_NIC.upperProfitsLimit.toLocaleString('en-GB')}`,
      amount: upperBand,
      tax: upperBand * CLASS_4_NIC.additionalRate,
    });
  }
  const class4Nic = class4Bands.reduce((sum, line) => sum + line.tax, 0);

  // §O student loan via SA: the combined repayment minus what the other income
  // repays on its own (PAYE deducts on salary as it's paid). If the other
  // income is NOT PAYE-taxed, SA will also collect its share — UI discloses.
  const studentLoan =
    studentLoanOn(otherTaxableIncome + taxableProfit, input.studentLoanPlan, input.postgradLoan) -
    studentLoanOn(otherTaxableIncome, input.studentLoanPlan, input.postgradLoan);

  // §S/§T/§U dividend + savings tax + HICBC are all Income Tax assessed at SA →
  // part of totalTax (and so the POA basis below); none is collected at source.
  // (HICBC stays here rather than with the student loan because SA110 keeps it
  // inside the POA base — §U.) Student loan is unaffected — the unearned-income
  // (>£2,000) student-loan rule is not yet modelled (coverage_matrix §5; immaterial
  // unless savings+dividends >£2,000 + a plan).
  const totalTax = incomeTax + dividendTax + savingsTax + hicbcCharge + class4Nic;
  const totalOwed = totalTax + studentLoan;

  // §I: CIS deductions withheld at source are advance payments toward the bill.
  // HMRC nets them off everything SA collects (student loan included — the SA
  // calculation deducts at-source tax from the total liability); any excess
  // comes back as a refund.
  const cisWithheld = Math.max(0, input.cisDeductionsWithheld ?? 0);
  const balancingPayment = Math.max(0, totalOwed - cisWithheld);
  const cisRefundDue = Math.max(0, cisWithheld - totalOwed);

  // §N/SALF303: POAs are each 50% of the RELEVANT amount — the IT + Class 4
  // bill minus tax deducted at source (CIS here; student loan never enters
  // POAs). Not due when the relevant amount is under £1,000 or under 1/5 of
  // the assessed bill (the 80%-met-at-source exemption, evaluable for CIS).
  const relevantAmount = Math.max(0, totalTax - cisWithheld);
  const poaRequired =
    relevantAmount >= PAYMENTS_ON_ACCOUNT.minimumBill &&
    relevantAmount >= totalTax * PAYMENTS_ON_ACCOUNT.relevantProportionFloor;
  const poaEach = poaRequired ? relevantAmount * PAYMENTS_ON_ACCOUNT.instalmentShare : 0;

  return {
    taxYear: input.taxYear,
    ratesTaxYear: TAX_RATES_EDITION.taxYear,
    nation,
    incomeReceived,
    deductibleExpenses,
    otherTaxableIncome,
    deductionBasis: useTradingAllowance ? 'trading-allowance' : 'expenses',
    deductionApplied,
    taxableProfit,
    personalAllowance: combined.allowance,
    taxableAfterAllowance,
    incomeTax,
    incomeTaxBands,
    dividendIncome,
    dividendTax,
    dividendTaxBands,
    savingsIncome,
    savingsTax,
    savingsTaxBands,
    adjustedNetIncome,
    childBenefitChildren,
    childBenefitReceived,
    hicbcPercent,
    hicbcCharge,
    pensionContributionsNet,
    giftAidDonationsNet,
    reliefGrossedUp,
    pensionGiftAidRelief,
    class4Nic,
    class4Bands,
    class2Status:
      taxableProfit >= CLASS_2_NIC.smallProfitsThreshold
        ? 'treated-as-paid'
        : 'below-threshold-voluntary',
    studentLoan,
    totalTax,
    totalOwed,
    cisDeductionsWithheld: cisWithheld,
    balancingPayment,
    cisRefundDue,
    paymentsOnAccount: { required: poaRequired, each: poaEach },
    firstYearJanuaryTotal: balancingPayment + poaEach,
  };
}

/**
 * Exact £ a deduction takes off the bill — the "≈ £X off your tax" win-lines
 * (Receipts/Mileage heroes). Recomputes the estimate with the extra deduction
 * and returns the difference in TOTAL owed (Income Tax + Class 4 + student
 * loan), so band crossings, the 60%-effective PA-taper zone, NIC and the 9%
 * loan rate all land exactly (strictly better than marginal-rate × £).
 * Returns 0 when the user is below the thresholds — the UI should then show
 * nothing rather than a £0 win-line.
 */
export function taxReliefForDeduction(input: TaxEstimateInput, deduction: number): number {
  if (deduction <= 0) return 0;
  const before = calculateTaxEstimate(input);
  const after = calculateTaxEstimate({
    ...input,
    deductibleExpenses: input.deductibleExpenses + deduction,
  });
  return before.totalOwed - after.totalOwed;
}

/**
 * Round a set of £ lines to whole pounds so they still sum EXACTLY to the
 * rounded total — the Tax screen's breakdown must reconcile to its total row,
 * and that total must equal the hero / Home figure round(firstYearJanuaryTotal)
 * (spec §8). Pass the unrounded lines; the total is their unrounded sum, rounded
 * once.
 *
 * Every line is rounded half-up, so an identical line value ALWAYS shows the
 * same whole pound regardless of the other lines on screen — no cross-scenario
 * wobble (e.g. NI of £x.60 always shows £x+1, never £x). Half-up rounding can
 * leave the summed lines a pound off the rounded total (in practice always
 * within ±£1); that reconciliation pound is settled on the LARGEST line(s),
 * where ±£1 is imperceptible — never on a small, scrutinised line like NI or the
 * HICBC. (The previous largest-remainder method floored every line first, so a
 * clearly-above-.5 line could be left floored down whenever other lines
 * outranked it on fractional part — that was the source of the £2,807-vs-£2,808
 * NI wobble between two estimates of the same profit.)
 */
export function roundBreakdownPounds(lines: number[]): { lines: number[]; total: number } {
  const total = Math.round(lines.reduce((s, v) => s + v, 0));
  const rounded = lines.map((v) => Math.round(v));
  let residual = total - rounded.reduce((s, v) => s + v, 0);
  // Lines ordered largest-magnitude first; the residual pound lands here.
  const byMagnitude = lines.map((_, i) => i).sort((a, b) => Math.abs(lines[b]) - Math.abs(lines[a]));
  for (let k = 0; residual !== 0 && byMagnitude.length > 0; k++) {
    const i = byMagnitude[k % byMagnitude.length];
    const step = residual > 0 ? 1 : -1;
    rounded[i] += step;
    residual -= step;
  }
  return { lines: rounded, total };
}
