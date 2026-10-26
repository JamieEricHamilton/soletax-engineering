/**
 * ruleCards.ts — the engine-grounded "explain my bill" corpus (capability D,
 * Stage 1). docs/specs/support_agent_spec.md §5b.
 *
 * Each RuleCard promotes a `§` citation that already lives as a code comment in
 * rates-2026-27.ts into structured, retrievable data: the verbatim government
 * wording, a brand-voice plain-English restatement, and the TaxEstimate fields
 * it explains. Stage 1 is PURE DATA + the field→card wiring + a two-estimate
 * diff — no LLM, nothing user-facing, no compliance gate to clear. Stage 2 (the
 * `explain_bill` tool + grounded prompt) and Stage 3 (validation → beta) build
 * on top.
 *
 * COMPLIANCE (locked, COMPLIANCE.md #8 + the compliance-first rule):
 * - `verbatimQuote` is copied WORD-FOR-WORD from the vetted `§` blocks in
 *   rates-2026-27.ts — it must never paraphrase or add a new interpretation.
 * - `plainEnglish` restates the verbatim plainly (brand_voice.md: short
 *   sentences, no em dashes, no untranslated jargon). It introduces no figure or
 *   rule not already in the verbatim/engine.
 * - The corpus is KEYED TO THE RATES EDITION: it mirrors the 2026-27 rates file
 *   and is re-audited against the new notes in the same annual April review that
 *   rolls rates-2026-27.ts over (the integrity test fails if a fieldRef stops
 *   matching the engine; CI goes red on TAX_RATES_EDITION.reviewBy).
 */

import type { TaxEstimate } from './engine';
import { TAX_RATES_EDITION } from './rates-2026-27';

export interface RuleCardSource {
  /** compliance_sources.md register section, e.g. '§K'. */
  register: string;
  /** Primary gov.uk page and/or statute the verbatim quote is taken from. */
  citation: string;
  /** ISO date the wording was last read/verified (matches the `§` comment). */
  readDate: string;
}

export interface RuleCard {
  /** Stable id — the rule concept (and the slug a TaxEstimate line links to). */
  id: string;
  /** Terse, brand-voice title for the rule. */
  title: string;
  /** The TaxEstimate fields this card explains — the field→card wiring.
   *  Typed against the engine output so a renamed field fails the build. */
  fieldRefs: (keyof TaxEstimate)[];
  /** Plain-English explanation (brand voice). Restates the verbatim, no more. */
  plainEnglish: string;
  /** EXACT HMRC / statute wording, copied verbatim from rates-2026-27.ts. */
  verbatimQuote: string;
  source: RuleCardSource;
}

/** Corpus edition — mirrors the rates file it is copied from. */
export const RULE_CARDS_EDITION = {
  keyedToRatesEdition: TAX_RATES_EDITION.taxYear,
  reviewBy: TAX_RATES_EDITION.reviewBy,
} as const;

export const RULE_CARDS: readonly RuleCard[] = [
  {
    id: 'income-tax',
    title: 'Income Tax on your profit',
    fieldRefs: ['incomeTax', 'incomeTaxBands', 'taxableAfterAllowance'],
    plainEnglish:
      'You pay Income Tax on your profit above your tax-free Personal Allowance. ' +
      'Each band of income is taxed at its own rate. Scotland has its own bands; ' +
      'the rest of the UK uses 20%, 40% and 45%.',
    verbatimQuote:
      'England/Wales/NI bands, 2026-27: Basic rate 20% "£12,571 to £50,270"; ' +
      'Higher rate 40% "£50,271 to £125,140"; Additional rate 45% "over £125,140".',
    source: { register: '§K', citation: 'https://www.gov.uk/income-tax-rates', readDate: '2026-06-10' },
  },
  {
    // Scotland's own income-tax ladder. Swapped in for `income-tax` when the
    // estimate's nation is 'scotland' (explainBill.applyNationIncomeTaxCard), so a
    // Scottish user is never quoted the rest-of-UK 20/40/45 bands their figures
    // weren't taxed under. Verbatim mirrors INCOME_TAX_BANDS_SCOTLAND in
    // rates-2026-27.ts (§K, read 2026-06-10). NIC, savings + dividends stay UK-wide.
    id: 'income-tax-scotland',
    title: 'Income Tax on your profit',
    fieldRefs: ['incomeTax', 'incomeTaxBands', 'taxableAfterAllowance'],
    plainEnglish:
      'You pay Scottish Income Tax because you live in Scotland. It comes off your ' +
      'profit above your tax-free Personal Allowance, and each band of income is ' +
      'taxed at its own Scottish rate.',
    verbatimQuote:
      'Scotland bands, 2026-27: Starter rate 19% "£12,571 to £16,537"; Basic rate 20% ' +
      '"£16,538 to £29,526"; Intermediate rate 21% "£29,527 to £43,662"; Higher rate ' +
      '42% "£43,663 to £75,000"; Advanced rate 45% "£75,001 to £125,140"; Top rate 48% ' +
      '"over £125,140". "You pay Scottish Income Tax if you live in Scotland."',
    source: { register: '§K', citation: 'https://www.gov.uk/scottish-income-tax', readDate: '2026-06-10' },
  },
  {
    id: 'personal-allowance',
    title: 'Your tax-free Personal Allowance',
    fieldRefs: ['personalAllowance', 'adjustedNetIncome'],
    plainEnglish:
      'Most people get £12,570 of income tax-free each year. If your adjusted net ' +
      'income goes over £100,000 it shrinks by £1 for every £2 above that, and is ' +
      'gone by £125,140.',
    verbatimQuote:
      '"The standard Personal Allowance is £12,570". "Your personal allowance goes ' +
      'down by £1 for every £2 that your adjusted net income is above £100,000".',
    source: { register: '§K', citation: 'https://www.gov.uk/income-tax-rates', readDate: '2026-06-10' },
  },
  {
    id: 'trading-allowance',
    title: 'The £1,000 trading allowance',
    fieldRefs: ['deductionApplied', 'deductionBasis'],
    plainEnglish:
      'Your first £1,000 of self-employment income can be tax-free instead of ' +
      'claiming your actual expenses. SoleTax uses whichever leaves you better off, ' +
      'and here the allowance takes more off than your expenses would.',
    verbatimQuote:
      'HS222: "Receipts from self-employment and miscellaneous income of £1,000 or ' +
      'less are exempt from tax under the trading income allowance." "Individuals ' +
      'with total receipts of more than £1,000 can elect to calculate their profits ' +
      'by deducting the allowance instead of allowable business expenses."',
    source: { register: '§C', citation: 'HS222 How to calculate your taxable profits (2026); https://www.gov.uk/government/publications/how-to-calculate-your-taxable-profits-hs222-self-assessment-helpsheet', readDate: '2026-06-23' },
  },
  {
    id: 'business-expenses',
    title: 'Your business expenses',
    fieldRefs: ['deductionApplied', 'deductionBasis'],
    plainEnglish:
      'These are your allowable business expenses for the year. They come off your ' +
      'income to work out your taxable profit, so you only pay tax on what is left. ' +
      'SoleTax uses your actual expenses here because they take more off than the ' +
      '£1,000 trading allowance would.',
    verbatimQuote:
      'HS222: "Individuals with total receipts of more than £1,000 can elect to ' +
      'calculate their profits by deducting the allowance instead of allowable ' +
      'business expenses (including capital allowances)." (So your taxable profit is ' +
      'your income minus your allowable business expenses unless you take the allowance.)',
    source: { register: '§C', citation: 'HS222 How to calculate your taxable profits (2026); https://www.gov.uk/government/publications/how-to-calculate-your-taxable-profits-hs222-self-assessment-helpsheet', readDate: '2026-06-23' },
  },
  {
    id: 'dividend-tax',
    title: 'Tax on dividends',
    fieldRefs: ['dividendTax', 'dividendTaxBands', 'dividendIncome'],
    plainEnglish:
      'Dividends are taxed on top of your other income. The first £500 each year is ' +
      'tax-free. Above that the rate depends on the band the dividends fall in.',
    verbatimQuote:
      '"You also get a dividend allowance of £500 each year"; "you only pay tax on ' +
      'any dividend income above the dividend allowance". Rates 2026-27: ordinary ' +
      '10.75%, upper 35.75%, additional 39.35%.',
    source: { register: '§S', citation: 'https://www.gov.uk/tax-on-dividends', readDate: '2026-06-20' },
  },
  {
    id: 'savings-tax',
    title: 'Tax on savings interest',
    fieldRefs: ['savingsTax', 'savingsTaxBands', 'savingsIncome'],
    plainEnglish:
      'Some savings interest is tax-free through your Personal Savings Allowance and ' +
      'the starting rate for savings. Interest above that is taxed at your main rate.',
    verbatimQuote:
      'Personal Savings Allowance: basic-rate £1,000, higher-rate £500, ' +
      'additional-rate £0. Starting rate for savings: £5,000 at 0%, where "Every £1 ' +
      'of other income above your Personal Allowance reduces your starting rate for ' +
      'savings by £1".',
    source: { register: '§T', citation: 'https://www.gov.uk/apply-tax-free-interest-on-savings', readDate: '2026-06-20' },
  },
  {
    id: 'hicbc',
    title: 'High Income Child Benefit Charge',
    fieldRefs: ['hicbcCharge', 'hicbcPercent', 'adjustedNetIncome'],
    plainEnglish:
      'If your adjusted net income is over £60,000 and you claim Child Benefit, some ' +
      'of it is added back to your tax bill. It is 1% of your Child Benefit for every ' +
      '£200 over £60,000. At £80,000 or more, all of it is added back. Because it is ' +
      'part of your Income Tax, it also counts towards your payments on account.',
    verbatimQuote:
      '"You’ll pay back 1% of your Child Benefit for every £200 you earn over the ' +
      'threshold" (threshold £60,000); "If you or your partner earn £80,000 or more, ' +
      'you’ll have to pay all of it back". Statutory: ITEPA 2003 s681C.',
    source: { register: '§U', citation: 'https://www.gov.uk/child-benefit-tax-charge; ITEPA 2003 s681C', readDate: '2026-06-20' },
  },
  {
    id: 'child-benefit',
    title: 'Child Benefit weekly rates',
    fieldRefs: ['childBenefitReceived', 'childBenefitChildren'],
    plainEnglish:
      'Child Benefit is £27.05 a week for your eldest or only child, and £17.90 a ' +
      'week for each other child.',
    verbatimQuote: '"Eldest or only child £27.05 — Other children £17.90" (per week, tax year 2026 to 2027).',
    source: { register: '§U', citation: 'gov.uk Rates and allowances: tax credits, Child Benefit and Guardian’s Allowance', readDate: '2026-06-20' },
  },
  {
    id: 'pension-gift-aid',
    title: 'Pension and Gift Aid relief',
    fieldRefs: ['pensionGiftAidRelief', 'reliefGrossedUp', 'pensionContributionsNet', 'giftAidDonationsNet'],
    plainEnglish:
      'Pension contributions and Gift Aid donations get tax relief. They widen the ' +
      'band taxed at the basic rate and lower your adjusted net income, which can also ' +
      'ease the Personal Allowance taper and the Child Benefit charge.',
    verbatimQuote:
      'Pension: "your pension provider claims tax relief … at the basic 20% rate". ' +
      'Gift Aid: "claim an extra 25p for every £1". Both gross up the net amount at ' +
      '20% (gross = net ÷ 0.8).',
    source: { register: '§V', citation: 'https://www.gov.uk/tax-on-your-private-pension/pension-tax-relief; https://www.gov.uk/donating-to-charity/gift-aid', readDate: '2026-06-20' },
  },
  {
    id: 'class-4-nic',
    title: 'Class 4 National Insurance',
    fieldRefs: ['class4Nic', 'class4Bands'],
    plainEnglish:
      'Self-employed people pay Class 4 National Insurance on their profit. It is 6% ' +
      'on profit between £12,570 and £50,270, then 2% on profit above £50,270.',
    verbatimQuote: 'Class 4, 2026-27: "6% on profits over £12,570 up to £50,270", "2% on profits over £50,270".',
    source: { register: '§J', citation: 'https://www.gov.uk/self-employed-national-insurance-rates', readDate: '2026-06-10' },
  },
  {
    id: 'class-2-nic',
    title: 'Class 2 National Insurance',
    fieldRefs: ['class2Status'],
    plainEnglish:
      'If your profit is £7,105 or more, Class 2 National Insurance counts as paid, ' +
      'so there is nothing extra to pay. Below that it is voluntary.',
    verbatimQuote:
      'Profits ≥ £7,105: "Class 2 contributions are treated as having been paid to ' +
      'protect your National Insurance record" — nothing to pay.',
    source: { register: '§J', citation: 'https://www.gov.uk/self-employed-national-insurance-rates', readDate: '2026-06-10' },
  },
  {
    id: 'student-loan',
    title: 'Student loan repayments',
    fieldRefs: ['studentLoan'],
    plainEnglish:
      'If you have a student loan, HMRC collects repayments through your tax return. ' +
      'It is 9% of income over your plan’s threshold, or 6% for a Postgraduate Loan.',
    verbatimQuote:
      '"9% of your income over the threshold if you’re on Plan 1, 2, 4 or 5 / 6% of ' +
      'your income over the threshold if you’re on a Postgraduate Loan plan." HMRC ' +
      '"will work out how much you repay each year from your Self Assessment tax return."',
    source: { register: '§O', citation: 'https://www.gov.uk/repaying-your-student-loan/what-you-pay', readDate: '2026-06-10' },
  },
  {
    id: 'payments-on-account',
    title: 'Payments on account',
    fieldRefs: ['paymentsOnAccount', 'totalOwed'],
    // Year-anchored (the external accountant reviewer's review 2026-08-04: dateless "31 January and 31 July"
    // let the assistant attribute this estimate's payments to the WRONG year's
    // deadlines). The anchors are part of the 2026-27 edition — re-anchor at the
    // April swap with the rest of this file.
    plainEnglish:
      'If your bill is £1,000 or more, HMRC asks for two advance payments towards ' +
      'next year. This line shows each payment: you pay that amount twice, once on ' +
      '31 January 2028 and once on 31 July 2028, alongside the bill itself on ' +
      '31 January 2028. Anything due in January or July 2027 comes from your ' +
      'previous year’s bill, which this app does not hold. You skip the advance ' +
      'payments if you paid more than 80% of your tax at source.',
    verbatimQuote:
      '"You must make these 2 payments, unless either: the amount of tax you owed last ' +
      'year was less than £1,000" or "last year you paid more than 80% of the tax you ' +
      'owed outside of Self Assessment". Each is "half of the tax you owed last year", ' +
      'due "31 January and 31 July".',
    source: { register: '§N', citation: 'https://www.gov.uk/understand-self-assessment-bill/payments-on-account; SALF303 (TMA 1970 s59A)', readDate: '2026-06-10' },
  },
  {
    id: 'cis',
    title: 'CIS deductions already paid',
    fieldRefs: ['cisDeductionsWithheld', 'balancingPayment', 'cisRefundDue'],
    plainEnglish:
      'Under the Construction Industry Scheme, contractors take tax off your payments ' +
      'before you are paid. That counts as tax already paid towards your bill. If they ' +
      'held back more than you owe, HMRC pays the difference back.',
    verbatimQuote:
      'CIS deductions "count as advance payments towards your tax and National ' +
      'Insurance bill". Rates: "20% for registered subcontractors", "30% for ' +
      'unregistered subcontractors", "0% if the subcontractor has ‘gross payment’ status".',
    source: { register: '§I', citation: 'https://www.gov.uk/what-you-must-do-as-a-cis-contractor/make-deductions-and-pay-subcontractors', readDate: '2026-06-11' },
  },
];

// ── Field → card wiring ──────────────────────────────────────────────────────

const CARD_BY_ID: ReadonlyMap<string, RuleCard> = new Map(RULE_CARDS.map((c) => [c.id, c]));

/** The rule-card with this id, or undefined. */
export function cardById(id: string): RuleCard | undefined {
  return CARD_BY_ID.get(id);
}

/** Every rule-card that explains a given TaxEstimate field. */
export function cardsForField(field: keyof TaxEstimate): RuleCard[] {
  return RULE_CARDS.filter((c) => c.fieldRefs.includes(field));
}

// ── The bill's explainable lines + the two-estimate diff ─────────────────────

/** A money line on the user's bill: how to read its £ figure off an estimate,
 *  and the rule-card(s) that explain it. The labels mirror the Tax screen. */
export interface EstimateLine {
  key: string;
  label: string;
  amount: (e: TaxEstimate) => number;
  cardIds: string[];
}

/** The lines an "explain my bill" answer can talk about, in breakdown order.
 *  `total` is the headline; its movement is explained by the component lines. */
export const ESTIMATE_LINES: readonly EstimateLine[] = [
  { key: 'deduction', label: 'Your deduction', amount: (e) => e.deductionApplied, cardIds: ['trading-allowance'] },
  { key: 'income-tax', label: 'Income Tax', amount: (e) => e.incomeTax, cardIds: ['income-tax', 'personal-allowance'] },
  { key: 'savings-tax', label: 'Tax on savings', amount: (e) => e.savingsTax, cardIds: ['savings-tax'] },
  { key: 'dividend-tax', label: 'Tax on dividends', amount: (e) => e.dividendTax, cardIds: ['dividend-tax'] },
  { key: 'national-insurance', label: 'National Insurance', amount: (e) => e.class4Nic, cardIds: ['class-4-nic', 'class-2-nic'] },
  { key: 'hicbc', label: 'Child Benefit charge', amount: (e) => e.hicbcCharge, cardIds: ['hicbc', 'child-benefit'] },
  { key: 'pension-gift-aid', label: 'Pension and Gift Aid relief', amount: (e) => e.pensionGiftAidRelief, cardIds: ['pension-gift-aid'] },
  { key: 'student-loan', label: 'Student loan', amount: (e) => e.studentLoan, cardIds: ['student-loan'] },
  { key: 'cis', label: 'CIS already paid', amount: (e) => e.cisDeductionsWithheld, cardIds: ['cis'] },
  // Label carries the each-of-two semantics WITH the number (the external accountant reviewer's review
  // 2026-08-04: a bare "Towards next year" amount got halved into a fake "each").
  { key: 'payments-on-account', label: 'Towards next year (each of two payments)', amount: (e) => e.paymentsOnAccount.each, cardIds: ['payments-on-account'] },
  { key: 'total', label: 'Estimated tax', amount: (e) => e.firstYearJanuaryTotal, cardIds: [] },
];

/** The rule-cards wired to a given bill line (resolved from cardIds). */
export function cardsForLine(key: string): RuleCard[] {
  const line = ESTIMATE_LINES.find((l) => l.key === key);
  if (!line) return [];
  return line.cardIds.map((id) => CARD_BY_ID.get(id)).filter((c): c is RuleCard => c !== undefined);
}

export interface EstimateDelta {
  key: string;
  label: string;
  before: number;
  after: number;
  /** after − before (positive = the line went up). */
  delta: number;
  /** The rule-cards that explain why this line is what it is. */
  cards: RuleCard[];
}

/**
 * What changed between two estimates — the engine-grounded basis for "why did
 * my tax move when I…?". Returns the bill lines whose £ figure differs by more
 * than `epsilon` (default £0.50 — whole-pound material), each with the
 * rule-card(s) that explain it, biggest mover first. Pure: reads only the two
 * TaxEstimates. No new figure is derived — every number is echoed from an
 * estimate (the echo-only guardrail, §5b).
 */
export function diffEstimates(
  before: TaxEstimate,
  after: TaxEstimate,
  opts: { epsilon?: number } = {},
): EstimateDelta[] {
  const epsilon = opts.epsilon ?? 0.5;
  const deltas: EstimateDelta[] = [];
  for (const line of ESTIMATE_LINES) {
    const b = line.amount(before);
    const a = line.amount(after);
    if (Math.abs(a - b) > epsilon) {
      deltas.push({ key: line.key, label: line.label, before: b, after: a, delta: a - b, cards: cardsForLine(line.key) });
    }
  }
  return deltas.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
}
