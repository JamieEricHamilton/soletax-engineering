/**
 * categorisationEasement.ts — the §H digital record-keeping categorisation
 * easement and its £90k edge (S143; MUST hold before the filing flag flips).
 *
 * [VERBATIM, register §H, digital record-keeping direction (reg 15,
 * S.I. 2026/336), read 2026-06-11]: "You can choose to categorise your digital
 * records in less detail for a tax year" below the VAT registration threshold
 * — "If you're a sole trader, you only need to record whether a transaction is
 * income or an expense"; "If your turnover reaches £90,000, you will need to
 * categorise all digital records for that income source in full before you
 * can send your quarterly update."
 *
 * Two product consequences, both deterministic:
 *  - IMPORT: uncategorised rows land in the neutral Box 30 bucket under the
 *    easement. Once the year's turnover (existing + the file's own income)
 *    reaches the threshold, that easement is gone — those rows must flag for
 *    real categorisation (apply.ts requireFullCategorisation).
 *  - FILING: an update must not be sent while turnover has reached the
 *    threshold and records remain easement-bucketed (filingService gate) —
 *    the direction's "before you can send" is a blocking rule, not advice.
 *
 * The threshold figure itself lives ONLY in rates-2026-27.ts (the VAT
 * registration threshold, §register; re-read each April).
 */
import { VAT_REGISTRATION_THRESHOLD } from './rates-2026-27';
import type { Receipt } from '../receipts/types';

/** The rates figure is pounds; records are integer pence — converted once,
 *  here (the selectors.ts seam rule). */
const THRESHOLD_PENCE = VAT_REGISTRATION_THRESHOLD * 100;

/** "If your turnover reaches £90,000" — at or over the threshold, the
 *  income-vs-expense easement no longer applies and every digital record
 *  needs its full category before a quarterly update can be sent. */
export function fullCategorisationRequired(turnoverPence: number): boolean {
  return turnoverPence >= THRESHOLD_PENCE;
}

/**
 * Whether a receipt is still sitting in the import's neutral easement bucket:
 * imported, landed as other_business by the mapper's fallback (confidence 0.3
 * — commitImport's encoding of "no real category was ever chosen"; a mapped
 * translation gets 0.9), and never re-categorised by the user (a manual edit
 * sets categorySource 'manual'). These are the records the £90k edge makes
 * un-fileable until each gets a real category.
 */
export function isEasementBucketed(r: Receipt): boolean {
  return (
    r.imageSource === 'import' &&
    r.category === 'other_business' &&
    r.categorySource === 'ai' &&
    r.categoryConfidence <= 0.3
  );
}
