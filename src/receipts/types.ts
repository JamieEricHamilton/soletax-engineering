export type HMRCCategory =
  | 'materials_supplies'
  | 'tools_equipment'
  | 'van_vehicle'
  | 'travel_transport'
  | 'phone_internet'
  | 'office_stationery'
  | 'software_subscriptions'
  | 'advertising_marketing'
  | 'meals_on_job'
  | 'accommodation'
  | 'insurance'
  | 'premises_rent'
  | 'subcontractors'
  | 'professional_fees'
  | 'training'
  | 'bank_charges'
  | 'interest_finance_charges'
  | 'uniform_clothing'
  | 'home_office'
  | 'other_business'
  | 'client_entertainment'
  | 'not_business';

// One portion of a split receipt assigned to a specific job (pence, GBP).
export interface Allocation {
  jobId: string;
  amount: number;
}

export interface Receipt {
  id: string;
  // Local-only (never uploaded — payload builders are explicit-column): the
  // auth uid this record was created/restored under. The drain refuses to
  // upload a row owned by a different account (S142 uid guard,
  // records_at_scale §3 — the batch that landed under two uids).
  ownerUid?: string;
  capturedAt: number;
  imageUri?: string;                 // absent for a manually-typed expense (lost receipt, no photo)
  imagePath?: string;                // Supabase Storage path once synced (for restore-on-reinstall)
  // 'import' = a row from the switcher importer (docs/specs/switcher_importer.md)
  // — an expense line from the user's previous software; no photo exists.
  imageSource: 'camera' | 'library' | 'share' | 'manual' | 'import';
  // The import batch this receipt arrived in — one tap reverts the whole batch
  // (the always-revert rule). Absent on non-imported receipts.
  importBatchId?: string;
  merchant: string;
  amount: number;                    // in pence, always GBP
  currency?: string;                 // ISO code if foreign (e.g. 'EUR') — absent means GBP
  foreignAmount?: number;            // original amount in foreign currency
  date: string;                      // ISO YYYY-MM-DD
  dateConfidence?: number;           // 0–1, AI's confidence in the date read; undefined = high (manual/edited). MMKV-only, not synced.
  category: HMRCCategory;
  categoryConfidence: number;        // 0–1
  categorySource: 'ai' | 'manual';
  notes?: string;
  // The job this receipt's cost belongs to (a materials receipt snapped against a
  // job). A normal expense receipt has none. Drives the job hub's Costs tab and
  // the job-profit readout. This is the SIMPLE single-link field for the common
  // (95%) case. When the receipt is split across jobs, `allocations` below is the
  // source of truth and `jobId` mirrors the largest allocation (so the synced row
  // / restore still points at a sensible primary job). Read links via the helpers
  // in `allocations.ts`, never `jobId` directly.
  jobId?: string;
  // Amount-split: portions of this receipt tied to specific jobs. Present only when
  // the user has split the receipt (opt-in). The sum of allocations + personalAmount
  // must not exceed `amount`; any remainder is a general (unallocated) business
  // expense. Synced as a jsonb column (20260619) so a restore recovers the split.
  allocations?: Allocation[];
  // The personal / not-business portion (pence). Excluded from allowable expenses +
  // MTD (SA103F private-use apportionment). Synced (20260619), like `allocations`.
  personalAmount?: number;
  taxYear: string;                   // e.g. "2025-26"
  processingStatus: 'queued' | 'processing' | 'complete' | 'failed';
  reviewStatus: 'needs_review' | 'approved';
  // Why this record was flagged needs_review (ImportRowFlag values from the
  // importer, kept as plain strings so an older build tolerates newer flags).
  // Shown as a plain line in the queue rows + entry screens so review is never
  // blind (S143). SYNCED since 2026-07-13 (ruling — was local-only): a restore
  // must keep the questions a record still owes; copy map: import/reviewReasons.ts.
  reviewReasons?: string[];
  // Unix ms the user last tapped "Not now" on the Home "To sort" card — snoozes
  // the nag until the next calendar day (isReceiptInToSort). The receipt stays
  // needs_review and in the Receipts review queue. MMKV-only, not synced.
  reviewSnoozedAt?: number;
  syncStatus: 'local' | 'uploading' | 'synced' | 'upload_failed';
  syncedAt?: number;                 // Unix ms when the backup last succeeded — drives the brief "Backed up" flash
  // Unix ms of the last CONTENT edit, on whichever client made it — the sync
  // spine's LWW authority (20260812_sync_spine.sql): between two copies of a
  // record, the newer stamp wins, everywhere. Stamped by the stores on every
  // content edit (src/lib/syncStamp.ts); housekeeping (syncStatus etc.) never
  // bumps it. Absent on pre-spine local records → rank at capturedAt.
  updatedAtMs?: number;
  // Set by compliance swipes at review time. undefined = deductible by default (per category).
  // false = user confirmed not deductible (clothing, training, meals). Used by tax estimate.
  deductible?: boolean;
  // meals_on_job only — WHICH claimable basis the gate chain settled on
  // (2026-08-05 rework, register §L): 'overnight' = the BIM47705 overnight rule;
  // 'away_day' = the s57A day-trip rule ("Not my usual place"). Feeds the
  // export's per-meal audit tag (BIM37670: adequate contemporaneous records).
  // Absent on legacy rows and not-claimable walks. Synced (meal_basis).
  mealBasis?: 'overnight' | 'away_day';
  // The gate walk this record's deductibility was decided by, in question order
  // (2026-08-06 — the persistent gate card: settled answers render on the saved
  // record with a Change link, so a decision is never write-once). Written on
  // every gated save; records from older builds reconstruct via
  // storedGateDecisions() where unambiguous. Synced (gate_decisions jsonb) —
  // like reviewReasons, a restore must keep the record's answers.
  gateDecisions?: Array<'claimed' | 'unclaimed'>;
  // One-step undo snapshot (MMKV-only, never synced): the *other* version of the
  // user-editable fields after an AI/auto overwrite, powering the persistent
  // Revert ⇄ Redo toggle. `mine` = true when `values` is what the user typed
  // (i.e. the AI version is currently applied). See memory/feedback_always_revert.
  revertSnapshot?: { values: ReceiptValues; mine: boolean };
}

// The user-editable fields that an AI/auto overwrite can replace — snapshotted for
// the Revert ⇄ Redo toggle.
export interface ReceiptValues {
  amount: number;
  merchant: string;
  date: string;
  category: HMRCCategory;
  categorySource: 'ai' | 'manual';
  categoryConfidence: number;
  deductible?: boolean;
  notes?: string;
  currency?: string;
  foreignAmount?: number;
}
