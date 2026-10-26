/**
 * sa103f-2026.ts — SINGLE SOURCE OF TRUTH for UK sole-trader expense compliance.
 *
 * Every category's HMRC box mapping, the verbatim HMRC wording behind it, its
 * deductibility, the operative routing rule shown to the AI, and the numeric
 * thresholds that drift annually all live HERE and nowhere else. categories.ts
 * (presentation) and receiptService.ts (the AI prompt) DERIVE from this file —
 * they do not carry their own copy. This is what keeps compliance from drifting
 * out of sync across the codebase.
 *
 * `hmrcText` is quoted (near-)verbatim from HMRC's SA103F Notes 2026, the boxes
 * 17–30 guidance. `rule` is the distilled, model-facing instruction — it folds
 * the HMRC scope together with SoleTax product decisions that are NOT in the
 * HMRC text (e.g. splitting parking out of vehicle running costs for the mileage
 * rule). The human review gate on every receipt is the compliance backstop.
 *
 * ANNUAL UPDATE: HMRC publish new SA103F Notes each December. When the 2027
 * edition lands, replace the source PDF, update SA103F_EDITION, re-audit every
 * `box` / `hmrcText` / `rule` / threshold against the new notes, and re-run the
 * 50-receipt test set. The `taxYear` stamp below is what makes staleness visible.
 */

import { HMRCCategory } from './types';

export const SA103F_EDITION = {
  source: 'SA103F Notes 2026',
  taxYear: '2025-26',                       // 6 April 2025 – 5 April 2026
  auditedOn: '2026-06-04',
  pdf: 'docs/compliance/sources/SA103F_Notes_2026.pdf',   // version-controlled copy in this repo
  // CI fails (scripts/check-compliance-currency.mjs) once today passes this date,
  // so a missed December review can't ship silently. Bump it each annual review.
  // HMRC publish the next edition each December; this allows until the SA filing
  // deadline to adopt it. See docs/compliance/COMPLIANCE.md.
  reviewBy: '2027-01-31',
} as const;

export interface SA103FCategory {
  id: HMRCCategory;
  /** SA103F box this category totals into, e.g. 'Box 20'. '—' when not an allowable box. */
  box: string;
  /** HMRC's own title for that box, verbatim from SA103F Notes 2026. */
  boxTitle: string;
  /** What HMRC says belongs in this box — quoted (near-)verbatim from the Notes. */
  hmrcText: string;
  /** Is expenditure in this category allowable against tax at all? */
  deductible: boolean;
  /** May the AI assign this directly? client_entertainment is reached via the meal gate, not the model. */
  aiSelectable: boolean;
  /** Operative, model-facing routing rule — HMRC scope + SoleTax product decisions. */
  rule: string;
  /** Business Income Manual reference for a non-obvious rule, if any. */
  bim?: string;
  /**
   * §E LOCKED RULE (2026-06-10): the mileage flat rate replaces "the actual
   * costs of buying and running your vehicle, for example insurance, repairs,
   * servicing, fuel" — claiming both is double-claiming. When the mileage flat
   * rate is in use for the year, receipts in a `mileageConflict` category must
   * be EXCLUDED from the tax-estimate deductions (conservative: recorded, kept,
   * amber-flagged — never summed alongside the allowance), and the receipt
   * review should warn. Parking/tolls/public transport (travel_transport) are
   * explicitly claimable on top — no conflict.
   */
  mileageConflict?: boolean;
  /**
   * §E LOCKED RULE: the working-from-home simplified flat rate (£10/£18/£26 a
   * month by hours) replaces the actual-cost home-use method — claiming both is
   * double-claiming. When the flat rate is in use this year, receipts in a
   * `homeConflict` category (home_office) are EXCLUDED from the estimate (kept,
   * amber-flagged, never summed alongside the flat rate), exactly like
   * `mileageConflict`. Set only on home-use costs, NOT separate premises rent.
   */
  homeConflict?: boolean;
}

export const SA103F_CATEGORIES: SA103FCategory[] = [
  {
    id: 'materials_supplies',
    box: 'Box 17',
    boxTitle: 'Cost of goods bought for resale or goods used',
    hmrcText:
      'The cost of raw materials, direct costs of producing goods sold, commissions, and any discounts.',
    deductible: true,
    aiSelectable: true,
    rule: 'Trade materials and consumables used to do the job: timber, pipe, paint, fixings, sand, cable, plasterboard, adhesives. Builders-merchant stock (Travis Perkins, Jewson, Wolseley, B&Q, Toolstation, Selco) — but a durable tool or test instrument from these shops is tools_equipment, not materials. Judge by the ITEMS, not the shop; for a mixed basket pick where most of the money went.',
  },
  {
    id: 'tools_equipment',
    box: 'Box 22',
    boxTitle: 'Repairs and maintenance of property and equipment',
    hmrcText:
      'Any repairs and maintenance of business premises and equipment.',
    // New tool purchases may instead qualify for the Annual Investment Allowance
    // under traditional accounting; under cash basis they are a normal expense — BIM35000.
    deductible: true,
    aiSelectable: true,
    rule: 'Durable tools and work equipment, and their repair: drills, saws, levels, socket sets, breakers, test instruments (voltage testers, test leads, multimeters, PAT testers), extension leads, hire of plant/tools. Anything that lasts and gets used again is tools_equipment EVEN when bought at a materials shop (Screwfix, Toolstation, B&Q). Not consumables that get used up on the job.',
    bim: 'BIM35000',
  },
  {
    id: 'van_vehicle',
    box: 'Box 20',
    boxTitle: 'Car, van and travel expenses',
    hmrcText:
      'Car and van insurance, repairs, servicing, fuel, parking, hire charges, vehicle licence fees, motoring organisation membership, train, bus, air and taxi fares, hotel room costs and meals on overnight business trips.',
    deductible: true,
    aiSelectable: true,
    // HMRC Box 20 also covers parking and public transport, but SoleTax routes
    // those to travel_transport so they survive the simplified mileage rule
    // (running costs are replaced by the per-mile flat rate — src/tax/rates,
    // §E; parking/tolls are claimable on top).
    rule: 'Vehicle running costs: fuel/diesel/petrol, vehicle insurance, repairs, servicing, MOT, tyres, vehicle licence, breakdown cover, and vehicle parts/accessories (floor mats, washer fluid, oil, bulbs, wiper blades). NOT parking or public transport — those go to travel_transport.',
    bim: 'BIM47700',
    mileageConflict: true,
  },
  {
    id: 'travel_transport',
    box: 'Box 20',
    boxTitle: 'Car, van and travel expenses',
    hmrcText:
      'Train, bus, air and taxi fares, parking and hotel room costs (part of car, van and travel expenses). Travel between home and a regular place of business is disallowable.',
    deductible: true,
    aiSelectable: true,
    rule: 'Parking, tolls, congestion charge, and public transport: train, bus, tram, taxi and air fares. These are claimable on top of the mileage allowance, so keep them OUT of van_vehicle.',
    bim: 'BIM47200',
  },
  {
    id: 'phone_internet',
    box: 'Box 23',
    boxTitle: 'Phone, fax, stationery and other office costs',
    hmrcText:
      'Phone and fax running costs, postage, stationery and printing costs, small office equipment and computer software (if under 2 years old).',
    deductible: true,
    aiSelectable: true,
    rule: 'Mobile phone bills, landline, and broadband/internet connection. The connectivity itself — not software subscriptions.',
  },
  {
    id: 'office_stationery',
    box: 'Box 23',
    boxTitle: 'Phone, fax, stationery and other office costs',
    hmrcText:
      'Postage, stationery and printing costs, and small office equipment.',
    deductible: true,
    aiSelectable: true,
    rule: 'Stationery, postage, printing, paper, pens, folders, stamps, and small office sundries.',
  },
  {
    id: 'software_subscriptions',
    box: 'Box 23',
    boxTitle: 'Phone, fax, stationery and other office costs',
    hmrcText:
      'Computer software (if under 2 years old) sits in Box 23. Trade or professional subscriptions sit in Box 30.',
    deductible: true,
    aiSelectable: true,
    // Box 23 for software under two years old; Box 30 for trade/professional subscriptions — BIM35800.
    rule: 'Software and SaaS subscriptions: Google Workspace, Microsoft 365, Canva, Adobe, Xero, Dropbox, app subscriptions. A design tool used to make adverts is still software here — NOT advertising.',
    bim: 'BIM35800',
  },
  {
    id: 'advertising_marketing',
    box: 'Box 24',
    boxTitle: 'Advertising and business entertainment costs',
    hmrcText:
      'Advertising in newspapers and directories, mailshots, free samples, and website costs. Entertaining clients, suppliers and customers is disallowable and goes in box 39.',
    deductible: true,
    aiSelectable: true,
    // Promotional items (register §D, gov.uk expenses page rewritten 2026-10-01):
    // free samples / prizes of things you SELL count; giveaways of things you do
    // NOT sell count when they display your business name or logo, never food,
    // drink or tobacco, capped per recipient per tax year (the figure lives in
    // src/tax/rates-2026-27.ts PROMOTIONAL_GIFT_LIMIT; the claimability card
    // states it). Kept figure-free here so the prompt never carries a rate.
    rule: 'Paid advertising and ad platforms: Meta/Facebook Ads, Google Ads, flyers, leaflets, signage, sponsorship, listings. Spend that buys reach or promotion — not the software tool used to create it. Also promotional giveaways: free samples or prizes of your own products, and items printed with the business name or logo (diaries, keyrings, pens). Food, drink or tobacco bought to give away is NOT advertising unless it is what the business sells.',
    bim: 'BIM45000',
  },
  {
    id: 'meals_on_job',
    box: 'Box 20',
    boxTitle: 'Car, van and travel expenses',
    hmrcText:
      'Meals on overnight business trips are part of car, van and travel expenses. Other meals are disallowable.',
    deductible: true,
    aiSelectable: true,
    // BIM47705 + BIM37670 (S57A ITTOIA 2005): the REASONABLE costs of overnight
    // subsistence are deductible, and a day meal also qualifies where travel is
    // allowable AND the place is outside the normal pattern (one-off journey, or an
    // itinerant site-to-site trade) — the claimability card's `detail` carries the
    // full conditions (register §L; the external accountant reviewer's review 2026-08-04). The gate chain
    // (complianceRules.ts, reworked 2026-08-05, the external accountant reviewer-approved): who with
    // (client/team = entertaining, BIM45000) → away overnight? → where were you
    // working that day? — any 'claimed' answer settles deductibility with its basis.
    rule: 'Food and drink: cafés, restaurants, Greggs, McDonald\'s, takeaways, coffee. Always categorise food here — a later step asks the user whether it was a solo working meal or a client/team meal.',
    bim: 'BIM47705',
  },
  {
    id: 'accommodation',
    box: 'Box 20',
    boxTitle: 'Car, van and travel expenses',
    hmrcText:
      'Hotel room costs on overnight business trips are part of car, van and travel expenses.',
    deductible: true,
    aiSelectable: true,
    rule: 'Hotels, B&Bs, and overnight lodging on a business trip away from the normal base.',
    bim: 'BIM47705',
  },
  {
    id: 'insurance',
    box: 'Box 21',
    boxTitle: 'Rent, rates, power and insurance costs',
    hmrcText:
      'Property insurance sits in Box 21; vehicle insurance sits in Box 20; professional indemnity insurance sits in Box 28.',
    deductible: true,
    aiSelectable: true,
    rule: 'Business insurance: public liability, tools/contents, professional indemnity, employer\'s liability. (Van/vehicle insurance goes to van_vehicle.)',
  },
  {
    id: 'premises_rent',
    box: 'Box 21',
    boxTitle: 'Rent, rates, power and insurance costs',
    hmrcText:
      'Rent for business premises, business and water rates, light, heat, power, property insurance, and security. The cost of buying premises is disallowable.',
    deductible: true,
    aiSelectable: true,
    rule: 'Workshop/yard/unit rent, storage units, business rates, and utilities (light, heat, power) for business premises.',
  },
  {
    id: 'subcontractors',
    box: 'Box 18',
    boxTitle: 'Construction industry (Box 18) / Wages and staff costs (Box 19)',
    hmrcText:
      'Box 18: total payments made to subcontractors for any type of construction work (CIS). Box 19: subcontract labour costs not included elsewhere.',
    deductible: true,
    aiSelectable: true,
    rule: 'Payments to another worker for labour: subcontractors, labourers, day-rate workers, trade-to-trade labour (incl. handwritten labour receipts). Record who was paid as the merchant.',
  },
  {
    id: 'professional_fees',
    box: 'Box 28',
    boxTitle: 'Accountancy, legal and other professional fees',
    hmrcText:
      'Fees for accountants, solicitors, surveyors, architects and other professionals, and indemnity insurance premiums. Legal costs of buying property or large equipment, and settling tax disputes, are disallowable.',
    deductible: true,
    aiSelectable: true,
    rule: 'Fees paid to professionals for their services: accountant, bookkeeper, solicitor, surveyor, architect, consultant.',
  },
  {
    id: 'training',
    box: 'Box 30',
    boxTitle: 'Other business expenses',
    hmrcText:
      'Other sundry running costs. Training is allowable only where it maintains or updates existing skills for the current trade.',
    deductible: true,
    aiSelectable: true,
    // Deductible only to update/maintain existing trade skills; training to acquire
    // skills for a NEW trade is disallowable — BIM35660.
    rule: 'Courses, certifications and trade card renewals that keep existing skills current: CSCS, CPCS, first aid, ticket renewals, refresher courses.',
    bim: 'BIM35660',
  },
  {
    id: 'bank_charges',
    box: 'Box 26',
    boxTitle: 'Bank, credit card and other financial charges',
    hmrcText:
      'Any bank, overdraft and credit card charges, hire purchase and lease interest, and alternative finance payments. Do not include capital repayments.',
    deductible: true,
    aiSelectable: true,
    rule: 'Account fees and transaction charges: monthly business-account fees, card charges, payment-processor fees (Stripe, SumUp, PayPal, Mettle).',
  },
  {
    id: 'interest_finance_charges',
    box: 'Box 25',
    boxTitle: 'Interest on bank and other loans',
    hmrcText:
      'Any interest on bank and other business loans, fees for buying goods and hire purchase. Do not include repayments against the borrowed amount; the non-business proportion is disallowable.',
    deductible: true,
    aiSelectable: true,
    rule: 'Interest and finance charges on borrowing for the business: business loan interest, overdraft interest, hire-purchase / finance-agreement interest on a van or equipment.',
  },
  {
    id: 'uniform_clothing',
    box: 'Box 30',
    boxTitle: 'Other business expenses',
    // SA103F Box 30: "the cost of ordinary clothing [is a] disallowable expense".
    // The allowable side is gov.uk's clothing test, rewritten 2026-10-01 (register
    // §D): buying, cleaning or repairing the four kinds below, never everyday
    // clothing. "Branded" is not HMRC's test: the old "branded uniform" wording
    // went with the rewrite (shirts are on HMRC's everyday list) — BIM37910 agrees
    // the bar is the 'everyday' wardrobe.
    hmrcText:
      'The cost of ordinary clothing is disallowable, even if only worn for work. You can only claim for buying, cleaning or repairing protective clothing needed for your work, clothing that protects your everyday clothes (such as aprons or overalls) if you only use it for work, specialist clothing or uniforms that are not everyday clothing, and costumes for acting, entertaining or advertising your business. Everyday clothing, such as suits, shirts, dresses or ordinary shoes, is not claimable even if worn only for work.',
    deductible: true,
    aiSelectable: true,
    rule: 'Workwear that is not everyday clothing, and cleaning or repairing it: protective gear (hi-vis, safety boots, hard hats, work gloves, knee pads), aprons or overalls used only for work, specialist clothing or uniforms that are not everyday clothes, and costumes for acting, entertaining or advertising. NOT everyday clothing (suits, shirts, dresses, ordinary shoes), even if only worn for work.',
    bim: 'BIM37910',
  },
  {
    id: 'home_office',
    box: 'Box 21',
    boxTitle: 'Rent, rates, power and insurance costs',
    hmrcText:
      'Business use of your home — the business proportion of rent, rates, light, heat and power, or the HMRC simplified-expenses flat rate. Personal/living costs are disallowable.',
    deductible: true,
    aiSelectable: true,
    rule: 'Costs of working from home (business proportion or simplified flat rate). Rarely a receipt — usually set up once in account settings.',
    bim: 'BIM75010',
    // §E: if the working-from-home flat rate is in use, these actual-cost receipts
    // are EXCLUDED (no double-claim) — same mechanism as the van mileageConflict.
    homeConflict: true,
  },
  {
    id: 'other_business',
    box: 'Box 30',
    boxTitle: 'Other business expenses',
    hmrcText:
      'Trade or professional journals and subscriptions, other sundry running costs and net VAT payments.',
    deductible: true,
    aiSelectable: true,
    rule: 'A genuine business cost that does not clearly fit any other category. Use this — with a LOW confidence score — when unsure which category fits, so the user reviews it. Never discard a real business expense to not_business out of uncertainty.',
  },
  {
    id: 'client_entertainment',
    box: '— (disallowable, Box 24 → Box 39)',
    boxTitle: 'Advertising and business entertainment costs (disallowable portion)',
    // SA103F Box 24 (first sentence) + gov.uk's entertainment and food-and-drink
    // sections, rewritten 2026-10-01 (register §D). HMRC now says "cannot
    // usually", and names the carve-outs: an event for employees where they are
    // the main attendees, food or drink provided to employees, food or drink that
    // is part of the service sold, and food or drink usually sold given away as a
    // promotion. Those carve-outs are NOT this category. "Employees" is HMRC's
    // word — never widened to subcontractors or anyone else working alongside.
    hmrcText:
      'Entertaining clients, suppliers and customers, and hospitality at events, is disallowable and must be put in box 39. You cannot usually claim for food or drinks provided to clients, suppliers or customers, for example the cost of lunch during a meeting discussing work, or for tickets to sporting, music or other entertainment events.',
    deductible: false,
    aiSelectable: false, // reached via the meal gate, not the model
    rule: 'Client, supplier or customer entertainment: meals, drinks, event hospitality or tickets for people the business deals with. Recorded for the books but not deductible. Food or drink for your own employees, a staff event where employees are the main attendees, and food or drink that is part of the service you sell are HMRC carve-outs and do not belong here.',
    bim: 'BIM45000',
  },
  {
    id: 'not_business',
    box: '—',
    boxTitle: 'Not a business expense',
    hmrcText:
      'Private (non-business) costs are not allowable. Examples HMRC give of non-allowable items: own drawings, the cost of entertaining, the cost of buying a car, depreciation, and losses on assets.',
    deductible: false,
    aiSelectable: true,
    rule: 'ONLY for clearly personal purchases: the weekly food shop, toiletries, cinema, personal (non-work) clothing. Do not use this just because the category is unclear.',
  },
];

export const SA103F_MAP = new Map<HMRCCategory, SA103FCategory>(
  SA103F_CATEGORIES.map((c) => [c.id, c]),
);

/** HMRC box + wording for a category. Used for display, export, and V2 submission. */
export function getSA103F(id: HMRCCategory): SA103FCategory {
  return SA103F_MAP.get(id) ?? SA103F_MAP.get('other_business')!;
}

/** Categories the AI may assign directly (excludes the gate-only client_entertainment). */
export const AI_SELECTABLE_CATEGORIES: HMRCCategory[] = SA103F_CATEGORIES
  .filter((c) => c.aiSelectable)
  .map((c) => c.id);

/**
 * Plain-English, user-facing explanation of what each category covers — the copy
 * shown in the category info sheet (the "?" on the category chip). Brand voice:
 * short, plain, no tax jargon, never names the box. Kept here next to the
 * compliance data so the annual SA103F review updates the explanation alongside
 * the rule (re-check these when deductibility or scope changes). The sheet pairs
 * this with the verbatim HMRC box wording (hmrcText) for the accountant reference.
 * Record<HMRCCategory, …> so the type system flags any category left without copy.
 */
export const CATEGORY_USER_TEXT: Record<HMRCCategory, string> = {
  materials_supplies:
    'Materials you buy in and use up on a job. Timber, paint, fabric, ingredients, hair colour. The things that go into the work or get used up doing it.',
  tools_equipment:
    'Tools and kit that last, plus repairs to them. Drills, saws, a camera, a treadmill, a salon chair. The one-off buy, not the materials you use up.',
  van_vehicle:
    'Running your van or car for work. Fuel, insurance, servicing, repairs, MOT, tyres, road tax. Parking and public transport go under Travel.',
  travel_transport:
    'Getting there without the van. Parking, tolls, the congestion charge, trains, buses, taxis. You can claim these on top of your mileage.',
  phone_internet:
    'Your phone and broadband for work. The line and the connection. Apps and online subscriptions sit under Software.',
  office_stationery:
    'Office supplies and postage. Printing, paper, pens, stamps, folders.',
  software_subscriptions:
    'Software and online subscriptions. Google Workspace, Microsoft 365, Canva, Adobe, Xero, Dropbox, app subscriptions.',
  advertising_marketing:
    'Getting your name out. Facebook and Google ads, flyers, leaflets, signage, sponsorship, listings, free samples, and giveaways with your logo on.',
  meals_on_job:
    "Food and drink while you're working. We'll ask whether it was just you or a client or your team, since that changes what you can claim.",
  accommodation:
    'Somewhere to stay when you work away. Hotels, B&Bs, and overnight stays on a job away from home.',
  insurance:
    'Cover for the business. Public liability, tools and contents, professional indemnity. Van insurance goes under Van & vehicle.',
  premises_rent:
    'Renting somewhere to work. Workshop, yard, unit, or storage, plus business rates and the utilities that come with it.',
  subcontractors:
    'Paying someone else for labour. A subbie, a labourer, a freelancer you bring in, a second pair of hands. Record who you paid as the name.',
  professional_fees:
    'Paying a professional for their work. Accountant, bookkeeper, solicitor, surveyor, architect, consultant.',
  training:
    "Keeping your skills current. Ticket and course renewals like CSCS, first aid, refreshers. Learning a brand new trade doesn't count.",
  bank_charges:
    'What the bank and card take. Account fees, card charges, and payment-processor fees like Stripe, SumUp, or PayPal.',
  interest_finance_charges:
    "Interest on money you borrowed for the business. Loan and overdraft interest, finance on a van or kit. Not the repayments themselves.",
  uniform_clothing:
    "Workwear that isn't everyday clothing. Hi-vis, safety boots, hard hats, overalls, a specialist uniform, and cleaning or repairing them. Everyday clothes don't count, even if you only wear them for work.",
  home_office:
    'Working from home. A flat monthly amount based on your hours, set once in your settings. Rarely a receipt.',
  other_business:
    "A genuine business cost that doesn't fit the others. Trade journals, subscriptions, the odd one-off. Put it here and we'll flag it for a look.",
  client_entertainment:
    "Meals or hospitality for clients, suppliers or customers. We keep it on record, but HMRC doesn't let you claim it. Food and staff events for your own employees are different: those can count.",
  not_business:
    'A personal purchase. The food shop, toiletries, day-to-day clothes. Kept out of your tax, just on record.',
};

/** User-facing plain-English description for a category (the info sheet). */
export function getCategoryUserText(id: HMRCCategory): string {
  return CATEGORY_USER_TEXT[id] ?? CATEGORY_USER_TEXT.other_business;
}

/**
 * The category list + per-category routing rules injected into the AI prompt —
 * generated from this file so the prompt can never drift from the source of truth.
 */
export function buildCategoryRulesBlock(): string {
  const lines = SA103F_CATEGORIES
    .filter((c) => c.aiSelectable)
    .map((c) => `- ${c.id}: ${c.rule}`);
  return lines.join('\n');
}

/**
 * Product heuristics versioned with this edition. ⚠ Tax-year-keyed HMRC figures
 * (mileage flat rates, use-of-home bands, VAT threshold, trading allowance)
 * moved to `src/tax/rates-2026-27.ts` on 2026-06-10 — they change each APRIL,
 * not on this file's December SA103F cycle, and pinning them here is exactly
 * how the 45p→55p 2026-27 mileage rise went stale. Never re-add them here.
 */
export const SA103F_THRESHOLDS = {
  // SoleTax UI heuristic (NOT an HMRC limit): meals at/over this pre-flag the
  // client/team-meal gate rather than a solo working meal.
  mealClientGateThresholdPence: 2500, // £25
} as const;
