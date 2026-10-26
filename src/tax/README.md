# `src/tax` — the tax-estimate engine

The compliance-bound calculation layer behind every tax figure in SoleTax: the
Tax screen, the Home tax card, the set-aside number, and the "≈ £X off your
tax" win-lines. Headless and pure — no I/O, no store imports, no UI. Screens
render it; they never compute tax themselves.

**If you are new to this codebase, read in this order:**
1. This file (the map).
2. The header comment in [`engine.ts`](./engine.ts) (the tax model and its assumptions).
3. The test suites ([`scripts/test-tax-engine.ts`](../../scripts/test-tax-engine.ts),
   [`scripts/test-tax-selectors.ts`](../../scripts/test-tax-selectors.ts)) — every
   expected figure is hand-derived in a comment beside its check; they are the
   executable specification.
4. [`docs/compliance/compliance_sources.md`](../../docs/compliance/compliance_sources.md)
   — the register of verbatim gov.uk sources every figure cites (§E mileage,
   §J NIC, §K Income Tax, §N payments on account, §O student loans, §H MTD).
5. [`docs/compliance/COMPLIANCE.md`](../../docs/compliance/COMPLIANCE.md) — the
   standing maintenance obligations (the annual April rates cycle is row 9).

---

## Architecture

```
gov.uk (verbatim, dated reads)
   │
   ▼
docs/compliance/compliance_sources.md     ← the source register (§ sections)
   │
   ▼
rates-2026-27.ts      every figure cited to its § section, edition-stamped,
   │                  CI-checked for staleness (reviewBy)
   ▼
engine.ts             pure maths: estimate, relief, rounding
   ▲
   │  £ inputs
selectors.ts          the wiring: which jobs/receipts/miles count (pence → £)
   ▲
   │  raw arrays
src/income/store.ts · src/receipts/store.ts · trips (pending)
```

Two invariants hold everywhere:

- **No figure lives outside `rates-2026-27.ts`.** Rates, bands, thresholds and
  allowances are never restated — not in this README, not in specs, not in UI
  copy, not in other code. A yearly rate change is a one-file edit plus the
  register. (`CLAUDE.md` → "HMRC Rate Logic".)
- **Units:** the stores hold integer **pence**; the engine works in **pounds**.
  The conversion happens once, in `selectors.ts`. If you are multiplying or
  dividing by 100 anywhere else, stop.

## Files

| File | What it is |
|---|---|
| [`rates-2026-27.ts`](./rates-2026-27.ts) | The single source of every tax-year figure. Each constant carries its register § citation. Edition-stamped (`TAX_RATES_EDITION.reviewBy`); `scripts/check-compliance-currency.mjs` fails CI once stale. |
| [`engine.ts`](./engine.ts) | `calculateTaxEstimate` (the estimate), `taxReliefForDeduction` (the win-lines), `roundBreakdownPounds` (display reconciliation). The full model — cash basis, other-income attribution, trading allowance, Scotland branch, student loans, payments on account — is documented in its header. |
| [`mileage.ts`](./mileage.ts) | `calculateMileageAllowance` — THE flat-rate calculator (§E), including the cumulative-miles rate switch. Never reimplement it. |
| [`selectors.ts`](./selectors.ts) | The estimate-input selectors: which jobs/receipts/miles count, with every exclusion surfaced in a diagnostics object. The rules are locked in `docs/specs/tax_screen_spec.md` §6 and explained in the file header. |
| [`index.ts`](./index.ts) | The barrel — import from `@/tax`. |

## API quick reference

- `calculateTaxEstimate(input)` → the estimate. Key outputs:
  - `totalTax` (Income Tax + Class 4, gross) vs `totalOwed` (+ student loan)
    vs `balancingPayment` (totalOwed net of CIS withheld — the January
    balance) vs `firstYearJanuaryTotal` (balancing payment + first payment on
    account — what the set-aside must cover). `cisRefundDue` is the §I excess
    HMRC pays back. POAs run on the SALF303 relevant amount (net of
    `cisDeductionsWithheld`), with both de minimis tests applied.
  - `ratesTaxYear` — if it differs from the requested `taxYear`, the rates file
    is stale for that year and **the UI must disclose it** (the "stale rates"
    state). CI catches the repo; phones already in pockets are why this field
    exists.
  - Per-band lines (`incomeTaxBands`, `class4Bands`) reconcile exactly to their
    totals — asserted by the test suite.
- `taxReliefForDeduction(input, deduction)` → the exact £ a deduction takes off
  the bill (two-estimate difference). **Never approximate with
  `deduction × marginal rate`** — band crossings, the personal-allowance taper
  zone, NIC and student loans make that wrong.
- `roundBreakdownPounds(lines)` → whole-pound display lines that still sum
  exactly to the rounded total (largest-remainder).
- `selectEstimateInputs({ taxYear, jobs, receipts, businessMiles })` → engine
  inputs + diagnostics. The rules in one breath: income = paid + approved jobs
  by the year the money **arrived** (cash basis — never the stored `taxYear`
  field); deductions = approved receipts, category deductibility derived from
  `src/receipts/sa103f-2026.ts`, the user's compliance answer respected, the
  personal-split `businessAmount` (clamped ≥ 0), foreign receipts only once
  converted; van running-cost receipts are excluded whenever the mileage flat
  rate is in use (the §E double-claim rule).
- `classifyReceiptForEstimate(receipt, { flatRateInUse })` → the canonical
  per-receipt deductible rule. Any surface showing a "claimed/deductible"
  figure must use it (the Receipts hero does) so totals can never drift from
  the estimate.
- `toTaxEstimateInput(selection, profile)` → merges the Account → Profile
  "Tax setup" answers (nation, other income, student loan) into engine input.
  Per-job CIS withheld amounts ride the SELECTION (facts about money already
  withheld), not the profile's yes/no answer.
- `taxSetup.ts` → the five Tax-setup questions as data: `TaxSetup`,
  `isTaxSetupComplete` (drives the Tax screen caveat), `toTaxProfile` (answers
  → engine profile) and the §H mandation mappers. **Every §H line reads
  `mtdStartForSetup(setup)`** — the band's wave (`mtdStartForTurnoverBand`)
  combined with the prior-year follow-up (`mtdStartForPriorYear` +
  `combineMtdStarts`): the year BEFORE the band year can already have mandated
  them under an earlier wave (over £50k in 2024-25 → quarterly updates since
  April 2026), which the band alone cannot see. The takings question only
  counts as answered once the follow-up is too (when a wave tests that year).
  The persisted store is `src/profile/taxSetupStore.ts`.

## Tests & CI

```
npm run test:tax
```

Runs both worked-example suites (engine + selectors; a few hundred checks).
Every expected value is hand-computed from the verbatim sources, with the
derivation in a comment. `.github/workflows/compliance-check.yml` runs this on
every push, plus the rates-staleness check.

**Rules:** the suites must pass before any UI binds to the engine; they must be
recomputed and re-run whenever `rates-2026-27.ts` changes; a new selection rule
or guard gets a worked example in the same commit.

## The annual April cycle (and Budgets)

Tax-year figures change every 6 April (and can change at fiscal events). The
procedure is `COMPLIANCE.md` row 9; the short version:

1. Re-read every register entry tagged *annual* (§E/§H/§I/§J/§K/§N/§O) from the
   live gov.uk pages — never from memory, never trusting last year's read.
2. Create the new year's rates file, update `TAX_RATES_EDITION.reviewBy`.
3. Recompute the worked examples by hand; make both suites green.
4. **Ship the build BEFORE 6 April** — CI going red does not update phones
   already in pockets; the `ratesTaxYear` stale-state is the safety net, not
   the plan.

Cautionary tale: the 2026-27 mileage flat rate rose on 6 April 2026 and the
codebase carried the old figure for two months because an earlier read had
captured the "before 6 April" column of HMRC's table. Never accept a single
automated read of a figure; demand the table's column headers and a second
source (see the register's §E entry).

### The mid-year fiscal event playbook (added 2026-07-19)

A Budget or fiscal statement can change figures *inside* a tax year. The 2022
precedent: the NIC Primary Threshold moved in July, then the 1.25pp rate rise
was reversed that November — and for **self-assessment** HMRC resolved the
split year into single **annualised composite rates** (Class 4 ran 9.73%/2.73%
for 2022-23). That precedent is why the year-keyed model survives most in-year
changes unmodified: sole-trader Class 4/Class 2 and Income Tax are assessed
annually, so an in-year change almost always lands here as **one revised
figure for the year**, not date-banded logic.

What ships within a week of an in-year change taking effect:

1. **Read the primary publication** (the HMRC policy paper / gov.uk rates
   page, not press coverage). First question: effective this tax year, or next
   6 April? Next April → the normal cycle, no rush.
2. **Wait for HMRC's own annualised/composite figure** for the affected year.
   Never derive a pro-rata figure ourselves — HMRC publishes the number the
   SA return will use; ours must match it.
3. Update the year's rates file with the new figure, verbatim-cited (source +
   date read), and update the register entry (`[VERBATIM]`, dated).
4. Recompute the affected worked examples **by hand**; both suites green.
5. `npm run build:engine-review` + redeploy (no CI guard — the harness serves
   a stale engine otherwise), then ship the app build. Old builds keep the old
   estimate until users update — the estimate is illustrative and labelled, so
   this is tolerable for days, not months.
6. The rare true date-banded case (e.g. a flat rate changing mid-year where
   the rate follows the event date, per BIM75005 for mileage): that IS an
   engine change — a dated band in the rates file, fixture-pinned both sides
   of the boundary. Flag it, don't rush it inside the week.

Fiscal event dates are announced weeks ahead. When one is scheduled, diary the
week after it to re-read every *annual*-tagged register entry, same as April.

## Known model boundaries

Documented honestly because the UI must disclose them, not paper over them:

- Loss relief is out of scope (a loss shows as £0 taxable profit).
- Pension contributions / Gift Aid don't reduce the modelled taper income.
- The PAYE side of the 80%-paid-at-source payments-on-account exemption can't
  be evaluated from app data — UI copy mentions it. The CIS side IS evaluated
  (§N/SALF303: POAs run on the relevant amount, net of `cisDeductionsWithheld`).
- Cash basis is assumed (the HS222 default for this ICP); accruals users are
  out of scope for the estimate.
- The estimate is illustrative and labelled as such — V1 files nothing.
