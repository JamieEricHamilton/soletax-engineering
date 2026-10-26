/**
 * incomeBoxes-2026.ts — SINGLE SOURCE OF TRUTH for UK sole-trader INCOME
 * compliance (the income-side sibling of receipts/sa103f-2026.ts, which owns the
 * EXPENSE boxes 17–30).
 *
 * Turnover is NOT only invoiced jobs. The SA103F income side has three places a
 * sole trader's money lands, and every one must have a home in the app or the
 * user under-reports:
 *
 *   • Box 15  Your turnover            — all trade receipts: cash/card sales, tips,
 *                                        fees, commissions (invoiced OR not).
 *   • Box 16  Any other business income — trading income not in turnover: letting
 *                                        part of business premises, net VAT
 *                                        repayments, third-party-rule profit.
 *   • Box 60  Goods/services for own use — an ADD-BACK (not money received): the
 *                                        cost of stock taken out of the business
 *                                        for private use, added to taxable profit.
 *
 * COMPLIANCE — grounded, never from memory (CLAUDE.md compliance-first rule):
 *   - `hmrcText` is quoted (near-)verbatim from HMRC's SA103F Notes 2026 (boxes
 *     15, 16, 60) — the same edition stamped in sa103f-2026.ts (SA103F_EDITION).
 *   - The cash-basis treatment of an ASSET SALE is grounded in HS222 (2026) §11:
 *     "If you're using cash basis, you can only claim capital allowances on cars.
 *     The cost of all other equipment and vehicles is an allowable expense." So a
 *     cash-basis trader never claims capital allowances on tools/vans → there is
 *     NO balancing charge (Box 59) on their disposal; the sale proceeds are simply
 *     a taxable business receipt (income). Building a "Box 59 balancing charge"
 *     surface for these users would be WRONG — this is why asset_sale routes to
 *     income, not to a balancing-charge mechanism.
 *   - For the tax MATHS the box label is immaterial: Box 15 and Box 16 both feed
 *     net profit identically and both count toward turnover thresholds (SA103F:
 *     "Total receipts from self-employment include any entries in box 15, box 16,
 *     box 59 and box 60"). The box only matters for the eventual V2 HMRC
 *     submission mapping. So mis-reading 15-vs-16 cannot make the estimate wrong;
 *     OMITTING income can. The product priority is therefore: give every kind of
 *     income an obvious home, and never auto-classify a genuinely grey one.
 *   - The compliance line (information, not recommendation): we APPLY a published
 *     rule to a clear fact pattern; where the fact pattern is grey (a grant could
 *     be capital or revenue; an insurance payout depends what was insured) we
 *     `requiresReview` and never silently route — that's an accountant's call.
 *
 * ANNUAL UPDATE: this file tracks the SA103F edition in sa103f-2026.ts. When the
 * 2027 notes land, re-audit every `box` / `hmrcText` against the new income-box
 * guidance alongside the expense re-audit, and re-confirm the HS222 cash-basis
 * disposal treatment.
 */

import { SA103F_EDITION } from '../receipts/sa103f-2026';
import type { OtherIncomeKind } from './types';

/** Re-exported so callers can stamp income compliance to the same edition as
 *  expenses — there is one SA103F edition for the whole return. */
export { SA103F_EDITION };

export interface IncomeKindMeta {
  id: OtherIncomeKind;
  /** SA103F box this kind totals into. Box 15/16 are turnover/other income; Box 60
   *  is goods-for-own-use, an ADD-BACK (see `addBack`). */
  box: 'Box 15' | 'Box 16' | 'Box 60';
  /** HMRC's own title for that box, verbatim from SA103F Notes 2026. */
  boxTitle: string;
  /** What HMRC says belongs here — quoted (near-)verbatim from the Notes / HS222. */
  hmrcText: string;
  /**
   * Whether this kind must land in the review queue rather than being trusted
   * as-classified. True only for genuinely grey fact patterns the rules don't
   * settle (the `other` bucket, which catches grants) — for those we flag, never
   * guess. The plain kinds (a cash sale, a tip) are unambiguous Box 15.
   */
  requiresReview: boolean;
  /** Plain-English, user-facing label (brand voice: no tax jargon, never a box number). */
  label: string;
  /** Plain-English helper shown under the option (the "what counts" line). */
  userText: string;
  /** True for an ADD-BACK (Box 60 goods-for-own-use): captured via the same Other
   *  sheet, but it is NOT money received — it is excluded from the "received"
   *  displays and the records search, and folded into taxable profit on its own.
   *  Undefined/false = a real income receipt (Box 15/16). */
  addBack?: boolean;
  /** Source citation for a non-obvious routing rule (gov.uk / helpsheet ref). */
  source?: string;
  /** Hidden from the manual "Other income" picker — either the kind is only
   *  created programmatically (e.g. 'sales' rows from the switcher importer) or
   *  it is RETIRED from manual entry (e.g. 'vat_repayment'). Existing rows of a
   *  hidden kind stay fully readable, computing and searchable — hiding only
   *  stops NEW manual rows. */
  pickerHidden?: boolean;
}

/**
 * The income kinds a user can record as "other income", each routed to its
 * SA103F box. Order is the display order in the picker (most common first).
 */
export const INCOME_KINDS: IncomeKindMeta[] = [
  {
    id: 'cash_takings',
    box: 'Box 15',
    boxTitle: 'Your turnover',
    hmrcText:
      'Turnover is the total amount received by your business before taking off any expenses. This includes all payments — cash, card, cheque or any other method — tips, fees and commissions.',
    requiresReview: false,
    label: 'Cash or card sale',
    userText:
      'Money taken without an invoice. Cash in hand, a card payment, a market or stall sale, selling a product on the side.',
  },
  {
    id: 'sales',
    box: 'Box 15',
    boxTitle: 'Your turnover',
    // The switcher importer's income rows (docs/specs/switcher_importer.md §4/§7):
    // item-level sales the user recorded in their PREVIOUS software — invoiced or
    // not, they are plain trade receipts, i.e. Box 15 turnover, identical in
    // treatment to cash_takings. A dedicated kind (rather than reusing
    // cash_takings) keeps the display label honest ("Sales income") and the
    // provenance queryable; it is never offered in the manual picker.
    hmrcText:
      'Turnover is the total amount received by your business before taking off any expenses. This includes all payments — cash, card, cheque or any other method — tips, fees and commissions.',
    requiresReview: false,
    label: 'Sales income',
    userText: 'Money in, brought over from your previous bookkeeping records.',
    pickerHidden: true,
  },
  {
    id: 'tips',
    box: 'Box 15',
    boxTitle: 'Your turnover',
    hmrcText:
      'Turnover includes tips, fees and commissions received by your business.',
    requiresReview: false,
    label: 'Tips',
    userText: 'Tips you kept from your work.',
  },
  {
    id: 'asset_sale',
    box: 'Box 15',
    boxTitle: 'Your turnover',
    // Cash-basis disposal: HS222 §11 — capital allowances only apply to cars, so
    // tools/vans were expensed and their sale proceeds come back as a taxable
    // receipt. Not a Box 59 balancing charge (that needs claimed capital
    // allowances / traditional accounting).
    hmrcText:
      'Under cash basis you can only claim capital allowances on cars; the cost of all other equipment and vehicles is an allowable expense (HS222 §11). The proceeds of selling such an asset are a taxable business receipt.',
    requiresReview: false,
    label: 'Sold something the business owned',
    userText:
      'Money from selling a tool, van or bit of kit the business owned. The amount you got for it counts as income.',
    source: 'HS222 (2026) §11 — Capital allowances and balancing charges (cash basis)',
  },
  {
    id: 'letting',
    box: 'Box 16',
    boxTitle: 'Any other business income',
    hmrcText:
      'Box 16: income which constitutes trading income but is not included in your turnover. For example, income from letting part of your business accommodation, or payments for the right to cross your land.',
    requiresReview: false,
    label: 'Renting out business space',
    userText: 'Letting out part of your workshop, yard or business premises.',
  },
  {
    id: 'vat_repayment',
    box: 'Box 16',
    boxTitle: 'Any other business income',
    hmrcText:
      'If you record your figures including VAT, put any net VAT repayment you received from us in box 16 (SA103F Notes, Box 16 / VAT).',
    requiresReview: false,
    label: 'A VAT refund from HMRC',
    userText:
      'A VAT refund HMRC paid you. Only add this if you keep your figures with VAT included.',
    // RETIRED from the manual picker 2026-08-04 (the external accountant reviewer's review verdict, Jamie
    // ruled): the app supports ONE bookkeeping method — figures WITHOUT VAT —
    // under which a VAT repayment is never Box-16 income, so offering it only
    // contradicted the tax-setup guidance and confused the most qualified user
    // it will ever meet ("For reference I was confused, and I'm an accountant").
    // Existing rows stay readable, computing and searchable (always-revert —
    // nothing strands); the flat-rate-scheme wrinkle goes to the V3 VAT scoping.
    pickerHidden: true,
  },
  {
    id: 'refund',
    box: 'Box 16',
    boxTitle: 'Any other business income',
    // The refund ruling (2026-07-10, register §F): money back on a business
    // cost is a trade RECEIPT under cash basis — never a negative expense.
    // BIM72015 (receipts are "any amounts received in connection with the
    // trade"), BIM72020 (capital refunds explicitly brought into account as
    // receipts of the trade), and the SA103F Box-16 precedent (net VAT
    // repayments → box 16). Box 15 turnover stays untouched, so refunds
    // never inflate the §H £90k categorisation-easement figure. The optional
    // OtherIncome.refundCategory preserves which cost it refunds.
    hmrcText:
      'Box 16: income which constitutes trading income but is not included in your turnover. Under cash basis, receipts are any amounts received in connection with the trade (BIM72015); refunds of amounts brought into account are receipts of the trade (BIM72020).',
    requiresReview: false,
    label: 'A refund or rebate',
    userText:
      'Money back from a supplier, or a rebate on a business cost. It counts as business income, which evens out the cost it refunds.',
    source: 'BIM72015 / BIM72020 + SA103F Notes 2026 Box 16 (register §F, ruling 2026-07-10)',
  },
  {
    id: 'other',
    box: 'Box 16',
    boxTitle: 'Any other business income',
    // The grey bucket. Grants can be capital or revenue; an insurance payout
    // depends what was insured; a recovered debt depends on the accounting basis.
    // The rules don't settle these from a one-line description → review, never
    // auto-route. (The compliance line: information not recommendation.)
    // The rent steer: private rental income is a PROPERTY business (SA105),
    // never Box 16 trade income — Box 16's own wording is "income which
    // constitutes trading income". Until the V1.5 property bucket exists
    // (soletax_brief §V1.5 candidate), the right home for it is the Tax-setup
    // other-income figure, so the estimate stays right and trade records stay
    // clean. Guard by copy, not a gate.
    hmrcText:
      'Box 16: other income which constitutes trading income but is not included in your turnover. Whether a specific receipt (for example a grant, an insurance payout or a recovered debt) is trading income, capital, or non-taxable depends on the facts.',
    requiresReview: true,
    label: 'Something else',
    userText:
      'Other money in, like a grant or a payout, that doesn’t fit above. These can be tricky, so we’ll set it aside for you to check. Rent from letting a property isn’t business income: add it in Account → Tax setup instead.',
  },
  {
    id: 'goods_own_use',
    box: 'Box 60',
    boxTitle: 'Goods and services for your own use',
    // An ADD-BACK, not money received: if you take stock/goods out of the business
    // for private use, the cost is added back to taxable profit (cash basis → cost;
    // SA103F Box 60). Captured via the Other sheet, but excluded from "received" +
    // search and folded into the estimate on its own. Unambiguous (the user knows
    // what they took) → no review.
    hmrcText:
      'If you take goods or stock out of the business, put the disallowable amount (usually the cost) in box 60. If you use traditional accounting use the normal sale price instead.',
    requiresReview: false,
    addBack: true,
    label: 'Stock you took for yourself',
    userText:
      'Materials or stock you took out of the business for personal use. This is not money you received, but we add back what it cost you, so your tax stays right.',
  },
];

export const INCOME_KIND_MAP = new Map<OtherIncomeKind, IncomeKindMeta>(
  INCOME_KINDS.map((k) => [k.id, k]),
);

/** Box + wording for an income kind. Falls back to the grey `other` bucket. */
export function getIncomeKind(id: OtherIncomeKind): IncomeKindMeta {
  return INCOME_KIND_MAP.get(id) ?? INCOME_KIND_MAP.get('other')!;
}

/**
 * The review status a freshly-saved OtherIncome of this kind should take. Grey
 * kinds land 'needs_review' (flag, don't guess); unambiguous kinds are
 * 'approved' on save (the user typed them — they ARE the review). Mirrors the
 * receipt/job manual-entry rule.
 */
export function initialReviewStatus(kind: OtherIncomeKind): 'needs_review' | 'approved' {
  return getIncomeKind(kind).requiresReview ? 'needs_review' : 'approved';
}

// ── Box 60 — Goods and services for own use (an ADD-BACK, not money received) ──
// As of Phase 3 this is captured as an OtherIncome row with kind 'goods_own_use'
// (the INCOME_KINDS entry above), via the same Other sheet. It is a profit
// ADD-BACK, not income received: the cost is added back to taxable profit and it
// is excluded from the "received" displays + records search. Under cash basis the
// amount is the COST (V1); under traditional accounting it's the normal selling
// price. This constant documents the rule + the `basis` (cost) the entered amount
// represents; the kind meta above is the source for label/box/HMRC text.
export const GOODS_FOR_OWN_USE = {
  box: 'Box 60',
  boxTitle: 'Goods and services for your own use',
  hmrcText:
    'If you take goods or stock out of the business, put the disallowable amount (usually the cost) in box 60. If you use traditional accounting use the normal sale price instead.',
  /** V1 is cash basis → the add-back is the COST of the goods taken. */
  basis: 'cost' as const,
  label: 'Stock you took for yourself',
  userText:
    'Materials or stock you took out of the business for personal use. We add back what it cost you.',
} as const;
