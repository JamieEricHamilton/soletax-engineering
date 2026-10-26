/**
 * breakdownLines.ts — the "HOW YOUR TAX IS WORKED OUT" line builder, factored
 * PURE out of the Tax screen (S214, the portal build). Which lines appear, the
 * CIS cap, the POA line and the rounding reconciliation are MONEY-DISPLAY
 * LOGIC: the app's Tax screen and the web portal's tax screen both consume
 * THIS, so the two surfaces can never show a differently-composed bill.
 *
 * Copy register: these label/sub strings are in-app copy (brand voice,
 * mechanism-free) — they render verbatim on both surfaces.
 */
import { roundBreakdownPounds, type TaxEstimate } from './engine';

/** Whole-pound display for estimates — the rounding is the estimate signal. */
export const gbpWhole = (pounds: number) => `£${Math.round(pounds).toLocaleString('en-GB')}`;

export interface BillLine {
  label: string;
  sub: string;
  /** Raw pounds (negative = a credit line, e.g. CIS already paid). */
  value: number;
  /** Whole pounds after the shared reconciliation (lines sum to the total). */
  rounded: number;
}

export interface BillBreakdown {
  lines: BillLine[];
  /** The January figure in whole pounds — bill + first POA when required. */
  total: number;
}

/**
 * The January figure (bill + first POA when required) as display lines —
 * rounded once, reconciled (tax_screen_spec §6). Mirrors the engine exactly;
 * computes nothing new.
 */
export function billBreakdown(estimate: TaxEstimate): BillBreakdown {
  const gbp = gbpWhole;
  const lines: { label: string; sub: string; value: number }[] = [];
  const it = estimate.incomeTaxBands;
  lines.push({
    label: 'Income Tax',
    sub:
      it.length === 0
        ? 'Nothing to pay at your profit'
        : it.length === 1
          ? `${Math.round(it[0].rate * 100)}% on ${gbp(it[0].amount)}`
          : `${it.length} rates applied`,
    value: estimate.incomeTax,
  });
  // §T/§S savings + dividend tax — assessed as Income Tax at SA, never taken at
  // source, so each is its own line (and part of the total the hero shows).
  if (estimate.savingsTax > 0) {
    lines.push({
      label: 'Tax on savings',
      sub: 'On interest beyond your tax-free amount',
      value: estimate.savingsTax,
    });
  }
  if (estimate.dividendTax > 0) {
    lines.push({
      label: 'Tax on dividends',
      sub: 'On dividends beyond your tax-free amount',
      value: estimate.dividendTax,
    });
  }
  const c4 = estimate.class4Bands;
  lines.push({
    label: 'National Insurance',
    sub:
      c4.length === 0
        ? 'Class 4, nothing at your profit'
        : c4.length === 1
          ? `Class 4, ${Math.round(c4[0].rate * 100)}% on ${gbp(c4[0].amount)}`
          : `Class 4, ${c4.length} rates`,
    value: estimate.class4Nic,
  });
  // §U High Income Child Benefit Charge — a charge added to the bill, not tax
  // deducted at source; kept in the January total (and the POA base, per SA110).
  if (estimate.hicbcCharge > 0) {
    lines.push({
      label: 'Child Benefit charge',
      sub: 'Paying back some Child Benefit',
      value: estimate.hicbcCharge,
    });
  }
  if (estimate.studentLoan > 0) {
    lines.push({
      label: 'Student loan',
      sub: 'Collected with your tax return',
      value: estimate.studentLoan,
    });
  }
  // §I: CIS already withheld nets the January figure — shown capped at the
  // bill (anything beyond it is the refund strip, not a negative bill).
  const cisApplied = Math.min(estimate.cisDeductionsWithheld, estimate.totalOwed);
  if (cisApplied > 0) {
    lines.push({
      label: 'CIS already paid',
      sub: 'Tax your contractors held back',
      value: -cisApplied,
    });
  }
  if (estimate.paymentsOnAccount.required) {
    lines.push({
      label: 'Towards next year',
      sub: 'Half of what’s left, due the same day',
      value: estimate.paymentsOnAccount.each,
    });
  }
  const rounded = roundBreakdownPounds(lines.map((l) => l.value));
  return {
    lines: lines.map((l, i) => ({ ...l, rounded: rounded.lines[i] })),
    total: rounded.total,
  };
}
