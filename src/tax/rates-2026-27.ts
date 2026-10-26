/**
 * rates-2026-27.ts — SINGLE SOURCE OF TRUTH for the tax-estimate rates.
 *
 * Every figure the estimate engine uses — Personal Allowance + taper, Income Tax
 * bands (England/Wales/NI AND Scotland), Class 4 NIC, the Class 2 nuance, the
 * trading allowance — lives HERE and nowhere else, quoted from the live gov.uk
 * pages per the compliance-first rule (PROJECT_RULES.md rule 6). The engine
 * (engine.ts) and any UI derive from this file; they do not carry their own copy.
 *
 * Sources (docs/compliance/compliance_sources.md §J + §K, all [VERBATIM]):
 *   §K  https://www.gov.uk/income-tax-rates                       read 2026-06-10
 *   §K  https://www.gov.uk/scottish-income-tax                    read 2026-06-10
 *   §J  https://www.gov.uk/self-employed-national-insurance-rates read 2026-06-10
 *   §D  https://www.gov.uk/expenses-if-youre-self-employed         read 2026-10-04
 *       (the promotional-items limit only; not an estimate input)
 *
 * ANNUAL UPDATE: these figures cover the tax year 6 April 2026 – 5 April 2027
 * and change every April (and at fiscal events). Re-read the three live pages,
 * re-audit every figure, re-run scripts/test-tax-engine.ts (recomputing the
 * worked examples by hand), then bump `reviewBy`. CI fails loud once `reviewBy`
 * passes (scripts/check-compliance-currency.mjs) so a stale year can't ship.
 */

export const TAX_RATES_EDITION = {
  source: 'gov.uk Income Tax rates / Scottish Income Tax / self-employed NICs',
  taxYear: '2026-27',                       // 6 April 2026 – 5 April 2027
  auditedOn: '2026-06-10',
  // Rates expire when the next tax year starts on 6 April 2027 — the estimate
  // must not run a new year on old rates, so CI goes red on day one of 2027-28
  // unless the annual re-read has landed. See docs/compliance/COMPLIANCE.md.
  reviewBy: '2027-04-05',
} as const;

/** Which set of Income Tax bands applies. NIC is UK-wide either way (§J). */
export type UKNation = 'england-wales-ni' | 'scotland';

/**
 * Until the user profile carries a nation, everything assumes England/Wales/NI.
 * Welsh rates of income tax are currently set at parity with England/NI — if the
 * Senedd ever diverges, Wales needs its own branch here.
 */
export const DEFAULT_NATION: UKNation = 'england-wales-ni';

export interface IncomeTaxBand {
  /** gov.uk's band name, verbatim. */
  name: string;
  rate: number;
  /** Verbatim gov.uk total-income range (shown with the standard PA) — for disclosure UI. */
  range: string;
  /**
   * Band ceiling as TAXABLE income (income above the possibly-tapered PA).
   *
   * ⚠ The basic/starter/intermediate/higher(Scot) limits ARE legislated
   * taxable-income limits, and for those the verbatim TOTAL-income range end
   * happens to equal limit + standard PA — so range_end − standard_PA recovers
   * the taxable limit. The TOP ceiling is the exception: the higher-rate limit
   * (rUK additional / Scottish advanced→top boundary) is **£125,140 of TAXABLE
   * income** directly (ITA 2007 s.10; Hardman's ¶3-000A/B list it verbatim as
   * the "taxable income band …–125,140"). It is NOT range_end − PA — the 45%/48%
   * rate starts at £125,140 of taxable income, which only coincides with
   * £125,140 of TOTAL income because the PA has tapered to £0 by that point.
   *
   * Encoding it as 125,140 − 12,570 = 112,570 was the original bug (fixed
   * 2026-06-20): it started 45%/48% ~£12,570 early (£130k rUK over-taxed by
   * £628.50). Externally re-anchored vs listentotaxman (£44,703 IT for £130k).
   * RULE: verify a ceiling AT its boundary against an independent oracle, never
   * by re-deriving it from the range — value-correct ≠ placement-correct.
   */
  upToTaxable: number;
}

// §K [VERBATIM, read 2026-06-10] https://www.gov.uk/income-tax-rates
// "The standard Personal Allowance is £12,570". Taper: "Your personal allowance
// goes down by £1 for every £2 that your adjusted net income is above £100,000"
// — reaching £0 at £125,140.
export const PERSONAL_ALLOWANCE = {
  standard: 12_570,
  taperThreshold: 100_000,
  taperDivisor: 2, // £1 of allowance lost per £2 over the threshold
} as const;

// §K [VERBATIM, read 2026-06-10] "Your first £1,000 of income from
// self-employment" is the tax-free trading allowance. Claimed INSTEAD of actual
// expenses (a filing choice) — the engine assumes whichever is better and
// discloses the basis. It cannot create a loss.
export const TRADING_ALLOWANCE = 1_000;

// §K [VERBATIM, read 2026-06-10] England/Wales/NI bands, 2026-27.
export const INCOME_TAX_BANDS_RUK: IncomeTaxBand[] = [
  { name: 'Basic rate', rate: 0.20, range: '£12,571 to £50,270', upToTaxable: 37_700 },   // 50,270 − 12,570
  { name: 'Higher rate', rate: 0.40, range: '£50,271 to £125,140', upToTaxable: 125_140 }, // higher-rate LIMIT = £125,140 TAXABLE (ITA 2007 s.10; Hardman's ¶3-000A) — NOT 125,140−PA
  { name: 'Additional rate', rate: 0.45, range: 'over £125,140', upToTaxable: Infinity },
];

// §K [VERBATIM, read 2026-06-10] https://www.gov.uk/scottish-income-tax —
// "You pay Scottish Income Tax if you live in Scotland." Applies to wages,
// pension and most other taxable income (trading profit included); savings +
// dividends stay on UK-wide rates. Same Personal Allowance + taper.
export const INCOME_TAX_BANDS_SCOTLAND: IncomeTaxBand[] = [
  { name: 'Starter rate', rate: 0.19, range: '£12,571 to £16,537', upToTaxable: 3_967 },        // 16,537 − 12,570
  { name: 'Basic rate', rate: 0.20, range: '£16,538 to £29,526', upToTaxable: 16_956 },         // 29,526 − 12,570
  { name: 'Intermediate rate', rate: 0.21, range: '£29,527 to £43,662', upToTaxable: 31_092 },  // 43,662 − 12,570
  { name: 'Higher rate', rate: 0.42, range: '£43,663 to £75,000', upToTaxable: 62_430 },        // 75,000 − 12,570
  { name: 'Advanced rate', rate: 0.45, range: '£75,001 to £125,140', upToTaxable: 125_140 },    // advanced→top boundary = £125,140 TAXABLE (Hardman's ¶3-000B) — NOT 125,140−PA
  { name: 'Top rate', rate: 0.48, range: 'over £125,140', upToTaxable: Infinity },
];

// §S [VERBATIM, read 2026-06-20] https://www.gov.uk/tax-on-dividends — page states
// "the rates from 6 April 2026 to 5 April 2027". "You also get a dividend allowance
// of £500 each year"; "you only pay tax on any dividend income above the dividend
// allowance" (the £500 is a 0% RATE that still uses band space — Hardman's ¶3-000E
// n.2 / SAIM §Q). Rates 2026-27: ordinary 10.75%, upper 35.75%, additional 39.35%
// (⚠ ordinary/upper RAISED from 8.75/33.75 — FA 2026 s.4). Dividends are the TOP
// slice: "add your total dividend income to your other income" to find the band;
// the PA covers dividends only after non-dividend income. ⚠ SCOTLAND uses these UK
// rates AND the UK band limits (37,700 / 125,140 TAXABLE) — NOT Scottish bands
// (ITA 2007 s.11D(6); Hardman's ¶3-000E n.3). The 125,140 upper boundary is the
// same taxable limit as the income-tax higher-rate limit (fixed 2026-06-20).
export const DIVIDEND_TAX = {
  allowance: 500,
  ordinaryRate: 0.1075,
  upperRate: 0.3575,
  additionalRate: 0.3935,
  ordinaryUpToTaxable: 37_700, // UK basic-rate limit (taxable) — ordinary rate up to here
  upperUpToTaxable: 125_140, // UK higher-rate limit (taxable) — upper rate up to here, additional above
} as const;

// §T [VERBATIM, read 2026-06-20] https://www.gov.uk/apply-tax-free-interest-on-savings
// Personal Savings Allowance (a 0% nil band that still uses band space): basic-rate
// taxpayer £1,000, higher-rate £500, additional-rate £0 — set by the top rate on
// TOTAL income. Starting rate for savings: £5,000 at 0%, reduced £1-for-£1 by
// non-savings income above the PA ("Every £1 of other income above your Personal
// Allowance reduces your starting rate for savings by £1"; gone at £17,570 =
// 12,570 + 5,000). Savings sit BETWEEN non-savings income and dividends, taxed at
// the MAIN rates 20/40/45 by UK band position — UK-wide even for Scotland (§K).
export const SAVINGS_TAX = {
  psaBasic: 1_000,
  psaHigher: 500,
  psaAdditional: 0,
  startingRateBand: 5_000, // 0% starting rate, reduced £1-for-£1 by non-savings income over the PA
  basicRate: 0.2,
  higherRate: 0.4,
  additionalRate: 0.45,
} as const;

// §U [VERBATIM, read 2026-06-20] High Income Child Benefit Charge.
// https://www.gov.uk/child-benefit-tax-charge: "You'll pay back 1% of your Child
// Benefit for every £200 you earn over the threshold" (threshold £60,000); "If you
// or your partner earn £80,000 or more, you'll have to pay all of it back".
// Statutory formula — ITEPA 2003 s681C (L=£60,000, X=£200, sub. by F(No.2)A 2024):
// appropriate % = (ANI − L) ÷ X, "rounded down to the nearest whole number" if not
// whole, capped at 100%; charge = appropriate% × total Child Benefit for the year.
// "Adjusted net income … includes savings interest and dividends … before any
// Personal Allowances and less certain tax reliefs" — the SAME ANI as the §K PA
// taper. The charge is part of Income Tax due → it sits INSIDE the payments-on-
// account base (SA110 working sheet box A356 = A340 minus only Class 2 + student/
// postgrad loan + coded-out; HICBC, via A277→A328→A340, is NOT removed) — unlike
// the student loan. Whoever has the higher income is liable; the estimate assumes
// the SoleTax user.
export const HICBC = {
  threshold: 60_000,  // ANI floor — no charge at or below £60,000
  upperLimit: 80_000, // ANI at/above which the charge is 100% of the Child Benefit
  incomeStep: 200,    // £ of ANI over the threshold per 1% of Child Benefit clawed back
} as const;

// §U [VERBATIM, read 2026-06-20] Child Benefit weekly rates, tax year 2026 to 2027
// — HMRC "Rates and allowances: tax credits, Child Benefit and Guardian's
// Allowance": "Eldest or only child £27.05 — Other children £17.90" (per week).
// The annual amount used for the HICBC = weekly × 52. ⚠ RAISED from 2025-26's
// £26.05 / £17.25 (uprated 6 April 2026) — Hardman's ¶2-600 prints the 2025-26
// figures; gov.uk wins on currency. Annual amount derived in engine.ts.
export const CHILD_BENEFIT = {
  weeklyEldest: 27.05,
  weeklyAdditional: 17.90,
  weeksPerYear: 52,
} as const;

// §V [VERBATIM, read 2026-06-20] Pension (relief at source) + Gift Aid relief.
// gov.uk/tax-on-your-private-pension/pension-tax-relief: "your pension provider
// claims tax relief … at the basic 20% rate"; Gift Aid (gov.uk/donating-to-charity/
// gift-aid): "claim an extra 25p for every £1" — both gross up the NET amount at the
// 20% basic rate (gross = net ÷ 0.8 = net × 1.25). Higher/additional-rate relief is
// given by EXTENDING the basic-rate band by the grossed-up amount (SA110 box A119 =
// A117+A118 extends both "BR band £37,700 + A119" and "AHR band £125,140 + A119");
// for Scotland the same gross extends the Scottish 20% basic band (SA top-ups
// 1/22/25/28% = each Scottish rate − 20%; the 19% starter band is unchanged). The
// gross also reduces adjusted net income (gov.uk/guidance/adjusted-net-income steps
// 2–3: "for every £1 … take £1.25"), relieving the §K PA taper AND the §U HICBC.
// The basicRate here is the relief-at-source rate (UK basic 20%), NOT a Scottish
// rate — the gross-up is 20% UK-wide.
export const PENSION_GIFT_AID = {
  basicRate: 0.20, // relief-at-source rate; gross = net / (1 − basicRate) = net × 1.25
} as const;

// §J [VERBATIM, read 2026-06-10] https://www.gov.uk/self-employed-national-insurance-rates
// Class 4, 2026-27: "6% on profits over £12,570 up to £50,270", "2% on profits
// over £50,270". Class 4 thresholds apply to PROFIT directly — the Personal
// Allowance plays no part. NIC is not devolved: identical for Scotland.
export const CLASS_4_NIC = {
  lowerProfitsLimit: 12_570,
  upperProfitsLimit: 50_270,
  mainRate: 0.06,
  additionalRate: 0.02,
} as const;

// §J [VERBATIM, read 2026-06-10] — the Class 2 nuance. Profits ≥ £7,105:
// "Class 2 contributions are treated as having been paid to protect your
// National Insurance record" — nothing to pay; NEVER add £3.65/week to the
// estimate. Under £7,105: nothing due; voluntary Class 2 at £3.65/week exists
// to protect the NI record (the only place that figure applies).
export const CLASS_2_NIC = {
  smallProfitsThreshold: 7_105,
  voluntaryWeeklyRate: 3.65,
} as const;

// §E [VERBATIM, read 2026-06-10] https://www.gov.uk/simpler-income-tax-simplified-expenses/vehicles
// "Flat rate per mile for 2026-2027 tax year": cars and goods vehicles 55p
// (first 10,000 miles) then 25p; motorcycles 24p. ⚠ RAISED from 45p — the
// table's other column is "Flat rate per mile before 6 April 2026" (45p).
// Confirmed independently by BIM75005, which also sets the year-keying rule:
// "a business should use the mileage rates that apply to that tax year" — a
// trip's rate follows the tax year it was driven in, not today's rate.
// The flat rate replaces "the actual costs of buying and running your vehicle,
// for example insurance, repairs, servicing, fuel" (the van_vehicle receipt
// conflict — see sa103f-2026.ts mileageConflict). "You can claim all other
// travel expenses (for example train journeys) and parking on top." Not
// available for a vehicle with capital allowances claimed; once used for a
// vehicle, must keep using it for that vehicle.
export const MILEAGE_FLAT_RATES = {
  carFirst10k: 0.55,
  carAfter10k: 0.25,
  motorcycle: 0.24,
  thresholdMiles: 10_000,
} as const;

// §E [VERBATIM, read 2026-06-10] https://www.gov.uk/simpler-income-tax-simplified-expenses/working-from-home
// "You can only use simplified expenses if you work for 25 hours or more a
// month from home." Bands unchanged for 2026-27 (re-verified live).
export const USE_OF_HOME_FLAT_RATES = [
  { minHours: 101, perMonth: 26 },
  { minHours: 51, perMonth: 18 },
  { minHours: 25, perMonth: 10 },
] as const;

// [VERBATIM, read 2026-06-10] https://www.gov.uk/vat-registration/when-to-register
// "You must register if … your total taxable turnover for the last 12 months
// goes over £90,000 (the VAT threshold)". V1 surfaces this as a warning only.
export const VAT_REGISTRATION_THRESHOLD = 90_000;

// §D [VERBATIM, read 2026-10-04] https://www.gov.uk/expenses-if-youre-self-employed/marketing-entertainment-subscriptions
// (rewritten at source 2026-10-01) — promotional items you do not sell: "You can
// claim for most promotional items that display your business name or logo …
// You cannot claim for food, drink, or tobacco. The maximum you can claim is £50
// per recipient per tax year. This limit applies to the total cost of all items
// given to the same person during the tax year." Information only: the app
// states the limit (claimability card), it never tracks spend per recipient.
export const PROMOTIONAL_GIFT_LIMIT = { perRecipientPerTaxYear: 50 } as const;

// §O [VERBATIM, read 2026-06-10] https://www.gov.uk/repaying-your-student-loan/what-you-pay
// "You'll repay either: 9% of your income over the threshold if you're on
// Plan 1, 2, 4 or 5 / 6% of your income over the threshold if you're on a
// Postgraduate Loan plan." Self-employed: "HM Revenue and Customs (HMRC) will
// work out how much you repay each year from your Self Assessment tax return."
// ⚠ The page presents these as current without naming the tax year — treated
// as 2026-27 at the read date; thresholds change every April (annual re-read).
export type StudentLoanPlan = 'plan1' | 'plan2' | 'plan4' | 'plan5';
export const STUDENT_LOAN = {
  plans: {
    plan1: { threshold: 26_900, rate: 0.09 },
    plan2: { threshold: 29_385, rate: 0.09 },
    plan4: { threshold: 33_795, rate: 0.09 },
    plan5: { threshold: 25_000, rate: 0.09 },
  },
  postgrad: { threshold: 21_000, rate: 0.06 }, // repaid IN ADDITION to a plan loan
} as const;

// §N [VERBATIM, read 2026-06-10] https://www.gov.uk/understand-self-assessment-bill/payments-on-account
// "You must make these 2 payments, unless either: the amount of tax you owed
// last year was less than £1,000" or "last year you paid more than 80% of the
// tax you owed outside of Self Assessment" (e.g. via PAYE). Each instalment is
// "half of the tax you owed last year", due "by midnight on 31 January and
// 31 July". POA covers Income Tax + Class 4; anything owed for capital gains
// or student loans is paid through the balancing payment, NOT the POAs.
//
// §N [VERBATIM, read 2026-06-11] The statutory basis — SALF303 (TMA 1970 s59A),
// https://www.gov.uk/hmrc-internal-manuals/self-assessment-legal-framework/salf303:
// "The payments on account are each equal to 50% of the RELEVANT AMOUNT" — "the
// amount by which the total income tax assessed exceeds the amount of any income
// tax deducted at source" (CIS deductions are tax deducted at source). Not due
// "where the relevant amount is less than: a fixed amount of £1,000, or the
// proportion the relevant amount bears to the assessed amount is less than
// 1 to 5" — i.e. "if more than 80% of the assessed tax is met by income tax
// deducted at source no payments on account are required".
export const PAYMENTS_ON_ACCOUNT = {
  /** £1,000 de minimis — tested against the RELEVANT (net-of-at-source) amount. */
  minimumBill: 1_000,
  instalmentShare: 0.5,
  /** SALF303's "1 to 5" proportion: relevant ÷ assessed below this → no POAs. */
  relevantProportionFloor: 0.2,
} as const;

// §I [VERBATIM, read 2026-06-11] https://www.gov.uk/what-you-must-do-as-a-cis-contractor/make-deductions-and-pay-subcontractors
// CIS deduction rates: "20% for registered subcontractors", "30% for
// unregistered subcontractors", "0% if the subcontractor has 'gross payment'
// status". The deduction applies to the LABOUR element only — the contractor
// first takes away VAT, materials, plant hire, consumable stores and fuel
// (except for travelling), then deducts the percentage "from the amount left".
// CIS 340 (stored PDF): "the deduction rates may change" — re-check at the
// annual April review; never quote these figures from anywhere but here.
// At Self Assessment the deductions "count as advance payments towards your
// tax and National Insurance bill" (§I) — the engine nets them off the bill.
export const CIS_DEDUCTION_RATES = {
  standard: 0.20,   // registered subcontractors
  higher: 0.30,     // unregistered / unverified
  grossPayment: 0,  // gross payment status — no deduction
} as const;

// §H [VERBATIM, read 2026-06-06] https://www.gov.uk/guidance/find-out-if-and-when-you-need-to-use-making-tax-digital-for-income-tax
// MTD for Income Tax mandation: qualifying income over the threshold FOR THE
// STATED TAX YEAR pulls you in from the start date. "Qualifying income" has a
// specific definition (gross self-employment + property income, not profit).
// Phased: re-check annually — later waves may be announced.
export const MTD_MANDATION = [
  { threshold: 50_000, testedTaxYear: '2024-25', startsApril: 2026 },
  { threshold: 30_000, testedTaxYear: '2025-26', startsApril: 2027 },
  { threshold: 20_000, testedTaxYear: '2026-27', startsApril: 2028 },
] as const;
