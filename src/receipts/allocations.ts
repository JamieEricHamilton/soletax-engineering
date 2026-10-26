/**
 * Receipt → job allocation helpers. A receipt can be split across several jobs
 * (each portion an `Allocation`) plus a personal/not-business portion. This is the
 * single place that normalises the model so every consumer — the job hub's cost
 * total, the receipt card, the deductible/expense totals — agrees.
 *
 * Back-compat: a receipt that predates splitting carries the simple single `jobId`
 * and no `allocations`. Such a receipt is read as one allocation of its full
 * business amount to that job, so existing single-linked receipts keep showing the
 * full cost on their job.
 *
 * Compliance: `businessAmount` (= total − personal) is the allowable expense. The
 * personal proportion is disallowable (SA103F private-use apportionment).
 */
import { Allocation, Receipt } from './types';

// The allowable (deductible) portion of a receipt — the full spend minus the
// personal/not-business part the user split off.
export function businessAmount(r: Receipt): number {
  return r.amount - (r.personalAmount ?? 0);
}

// The receipt's job links, normalised. Uses `allocations` when the receipt has been
// split; otherwise falls back to the legacy single `jobId` (as one allocation of the
// full business amount).
export function receiptJobLinks(r: Receipt): Allocation[] {
  if (r.allocations && r.allocations.length > 0) return r.allocations;
  if (r.jobId) return [{ jobId: r.jobId, amount: businessAmount(r) }];
  return [];
}

// Ids of the jobs this receipt is linked to (one for a simple link, several when split).
export function receiptJobIds(r: Receipt): string[] {
  return receiptJobLinks(r).map((a) => a.jobId);
}

// True when the receipt is linked to any job at all.
export function isReceiptLinked(r: Receipt): boolean {
  return receiptJobLinks(r).length > 0;
}

// The portion of a receipt assigned to a given job (undefined if not linked to it).
export function allocationForJob(r: Receipt, jobId: string): number | undefined {
  const link = receiptJobLinks(r).find((a) => a.jobId === jobId);
  return link?.amount;
}

// Total of the receipt currently assigned to jobs (the sum of all slices).
export function allocatedToJobs(r: Receipt): number {
  return receiptJobLinks(r).reduce((s, a) => s + a.amount, 0);
}

// The business amount still free to assign to another job or to personal — i.e.
// the deductible amount not yet pinned to a job. 0 once a receipt is fully split.
export function unallocatedAmount(r: Receipt): number {
  return Math.max(0, businessAmount(r) - allocatedToJobs(r));
}

// Total a job has spent across all receipts — the sum of the slices pointing at it
// (the allocated portion, never the full receipt amount). This is the job hub's
// "Spent" figure and feeds profit.
export function jobSpent(jobId: string, receipts: Receipt[]): number {
  let sum = 0;
  for (const r of receipts) {
    const slice = allocationForJob(r, jobId);
    if (slice) sum += slice;
  }
  return sum;
}

// The legacy `jobId` to persist alongside `allocations` so the synced row / a
// Phase-6 restore still points at a sensible primary job: the largest allocation.
export function primaryJobId(allocations: Allocation[]): string | undefined {
  if (allocations.length === 0) return undefined;
  return allocations.reduce((a, b) => (b.amount > a.amount ? b : a)).jobId;
}

// Compact "first job + count" label for a receipt's links — "Mike" (one),
// "Mike +2" (several), "" (none). `nameOf` resolves a job id to its client name.
export function jobLinkLabel(
  jobIds: string[],
  nameOf: (id: string) => string | undefined,
): string {
  if (jobIds.length === 0) return '';
  const first = nameOf(jobIds[0]) || 'Job';
  return jobIds.length === 1 ? first : `${first} +${jobIds.length - 1}`;
}

// ── The two writes, normalised ONCE (S223 late — the web's Jobs sheet and
//    Costs tab share these with the app's, so no surface can drift on what
//    a split means) ─────────────────────────────────────────────────────────

/** What a receipt persists after its Jobs sheet is saved. Zero/blank rows are
 *  dropped; nothing assigned clears the link; ONE job at the full amount with
 *  no personal normalises to the plain legacy `jobId` link (no allocations)
 *  so it keeps tracking the receipt's amount if that's edited later; `jobId`
 *  mirrors the largest slice either way. `>=` also catches a draft made before
 *  the receipt's amount was edited down. */
export function normaliseSplit(
  total: number,
  allocations: Allocation[],
  personalAmount: number | undefined,
): { allocations: Allocation[] | undefined; personalAmount: number | undefined; jobId: string | undefined } {
  const cleaned = allocations.filter((a) => a.jobId && a.amount > 0);
  const personal = personalAmount && personalAmount > 0 ? personalAmount : undefined;
  const plainLink = cleaned.length === 1 && !personal && cleaned[0].amount >= total;
  return {
    allocations: cleaned.length && !plainLink ? cleaned : undefined,
    personalAmount: personal,
    jobId: primaryJobId(cleaned),
  };
}

/** One job's slice set from the JOB side (the Costs tab's inline edit): the
 *  other jobs' slices and personal stay as they are; the slice is clamped to
 *  what the receipt has left, so a single edit can never over-allocate it. A
 *  zero drops the job. */
export function withJobSlice(r: Receipt, jobId: string, amount: number): Allocation[] {
  const others = receiptJobLinks(r).filter((l) => l.jobId !== jobId);
  const otherTotal = others.reduce((s, a) => s + a.amount, 0);
  const available = Math.max(0, r.amount - (r.personalAmount ?? 0) - otherTotal);
  const clamped = Math.min(Math.max(0, Math.round(amount)), available);
  return clamped > 0 ? [...others, { jobId, amount: clamped }] : others;
}
