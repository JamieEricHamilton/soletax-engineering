# Golden-set validation — status & handover

**Purpose:** cross-check the tax engine against **TaxCalc** (an HMRC-recognised SA package) to kill compliance risk #1 — the savings/dividend/beneficial-PA-allocation interaction that had no independent oracle. See `coverage_matrix.md` §6.

**As of 2026-06-21 (Session 77): 30 / 30 scenarios validated. ONE real engine bug found + fixed (HICBC whole-£ round-down, ITEPA s681C(3)); otherwise zero discrepancies.**

★ **FINDING (S77) — HICBC was not floored to whole pounds.** The remaining 5 HICBC scenarios (G24/G25/G26/G28/G30) all read ~£0.30–0.99 below the engine: TaxCalc floors the Child Benefit total AND the charge to whole £ per **ITEPA 2003 s681C(3)** (G30 proved CB-floored-FIRST: £2,070, not £2,071). The engine had floored only the percentage. Fixed in `engine.ts` + harness §7 + fuzz + worked examples H1–H6 + this golden reference; register §U updated [VERBATIM s681C(3)]. The cooltaxtool oracle had *shared* the omission (it returns £703.30 not £703), so it never flagged it — HICBC removed from that differential, authority moved here. After the fix: `npm run golden:compare -- --year 2025-26` → **57 fields exact, 7 within £1 (dividend half-penny round-down), 0 to investigate.**

---

## Why we validate on the 2025-26 tax year (read this first)

TaxCalc's full **2026-27** edition ships ~**late March 2027**, and its **What If? Planner does not yet have 2026-27 rates** (it says so in a red banner). So we validate the engine's **LOGIC** against TaxCalc's accurate **2025-26** computation. The interaction *rules* are structurally identical across the two years — only three figures changed, all already verbatim in `compliance_sources.md`:

| Figure | 2025-26 | 2026-27 | Source |
|---|---|---|---|
| Dividend ordinary / upper rate | 8.75% / 33.75% | 10.75% / 35.75% | §S (FA 2026 s.4) |
| Child Benefit weekly (eldest / other) | £26.05 / £17.25 | £27.05 / £17.90 | §U |
| Scottish starter / basic ceiling | £15,397 / £27,491 | £16,537 / £29,526 | §P/§K |

Everything else (PA, £100k taper, rUK bands, savings rates/bands/PSA, Class 4, pension relief, HICBC thresholds, trading allowance) is **frozen**. The 2026-27 rate *numbers* are separately verbatim-sourced + cooltaxtool-checked, so the 2025-26 logic match closes the gap.

`reference.ts` computes our 2025-26 figures using the **same** `_ref-beneficial.ts` machinery the test suite proves equal to the production engine; its `selfCheck()` re-proves `reference(·, 2026-27) == production engine` on all 30 scenarios, so 2025-26 mode is genuinely the engine's logic, not a separate calculator.

---

## How to use it

1. **Open TaxCalc → "TaxCalc 2026"** (this IS the 2025-26 tax year). The base SA100 return — **NOT** the What If? Planner.
2. For each scenario, enter ONLY the income listed, then read the **Tax Calculation Summary**: **box 1 (Total tax)** and **box 4 (Class 4 NICs due)**.
3. Record into `package-results.csv` (`scenario,income_tax,hicbc,class4,total`) — fill **`class4`** (box 4) and **`total`** (box 1); leave `income_tax`/`hicbc` blank (the compare diffs on `total` + `class4`). Blank cells are skipped.
4. Run **`npm run golden:compare -- --year 2025-26`** → diffs vs our reference, flags anything beyond a £1 rounding tolerance, exits non-zero on a real mismatch. (A ~1p difference is just TaxCalc's half-penny rounding.)

### TaxCalc entry recipe (one return, reused per scenario)
- **Self-employment** (`Your work` → Self Employment): enter **turnover = profit + £1,000**, **expenses = £1,000** (gives a clean taxable profit and stops the £1,000 trading allowance auto-applying — **do NOT tick the trading allowance**). Income on the *Income* sub-page; expenses total in "Total allowable expenses" on the *Allowable Expenses* sub-page.
- **Savings** (`Other income` → Savings and investments → **Bank and building society**): put the amount in **"UK Interest received with no tax taken off"** (the **Untaxed** heading). ⚠️ NOT the "Taxed UK Interest" box.
- **Dividends** (same section → **Shares and unit trusts**): top box "Dividends and other qualifying distributions from UK companies".
- **Scotland** (`Personal details` → Your address): tick **"Subject to tax using Scottish income tax rates"** (the postcode alone does NOT flip it).
- **HICBC** (children): enter the Child Benefit received (2025-26 rates × 52 — see table below) + number of children, in the Child Benefit / HICBC section (`Tax reliefs and allowances` area; TaxCalc computes the charge from CB + ANI).
- **Pension** (`Tax reliefs and allowances` → pension contributions): enter the **NET** personal contribution under "Payments to registered pension schemes (relief at source)".

### ⚠️ Gotchas seen this session (every mismatch so far was data-entry, not the engine)
- **Savings in the "Taxed" box** → TaxCalc adds a phantom 20% credit → a too-low total or a refund. Fingerprint: result = our value − 20% of the grossed-up savings. (Hit on G19, G09, G10, G17.)
- **Leftover values not cleared** when reusing the return (e.g. dividends from the previous scenario). (Hit on G09 — carried £10k dividends.)
- A **refund (box 2 populated)** with all-untaxed income is impossible → always a data-entry slip.

---

## Done (30) — all validated vs TaxCalc, both nations

**Session 76 (15):** `G01 G02 G03 G06 G07 G08 G09 G10 G12 G13 G14 G16 G17 G19 G20`
**Session 77 (15):** `G04 G05 G11 G15 G18 G21 G22 G23` (easy) · `G24 G25 G26 G27 G28 G29 G30` (fiddly)

Covers: beneficial PA allocation (basic / higher / zero-profit), savings starting-rate band + PSA (all 3 levels), dividend bands (ordinary→upper→additional), the £100k taper + odd-pound s35(3) round-up, Scotland with savings + dividends on UK rates, the PA-onto-savings 40%-dodge, HICBC (partial / 100% / pension-lowered / CB-floored-first), and pension band-extension (rUK + Scotland). `package-results.csv` holds the TaxCalc figures; `npm run golden:compare -- --year 2025-26` → **57 exact, 7 within £1 (dividend half-penny round-down), 0 to investigate.**

### The 15 added in S77 — TaxCalc-confirmed values (= engine after the s681C(3) fix)
Turnover = profit + £1,000, expenses = £1,000. box 1 = total tax incl HICBC + Class 4.

| ID | Profit | Sav | Div | Pension(net) | Children | Nation | box 1 (TaxCalc) | box 4 | HICBC |
|----|--------|-----|-----|--------------|----------|--------|-----------------|-------|-------|
| G04 | 16,000 | 200 | – | – | – | rUK | £891.80 | 205.80 | – |
| G05 | 30,000 | 2,000 | – | – | – | rUK | £4,731.80 | 1,045.80 | – |
| G11 | 29,570 | – | 3,000 | – | – | rUK | £4,638.75 | 1,020.00 | – |
| G15 | 10,000 | – | 10,000 | – | – | rUK | £606.37¹ | 0 | – |
| G18 | 2,500 | 2,000 | 10,000 | – | – | rUK | £0.00 | 0 | – |
| G21 | 100,000 | 5,000 | – | – | – | rUK | £33,488.60 | 3,256.60 | – |
| G22 | 110,000 | – | 10,000 | – | – | rUK | £42,094.85 | 3,456.60 | – |
| G23 | 100,417 | – | – | – | – | rUK | £30,946.94 | 3,264.94 | – |
| G24 | 65,000 | – | – | – | 1 | rUK | £16,326.60 | 2,556.60 | £338 |
| G25 | 70,000 | – | 5,000 | – | 2 | rUK | £21,295.35 | 2,656.60 | £1,688 |
| G26 | 85,000 | – | – | – | 3 | rUK | £27,536.60 | 2,956.60 | £3,148 |
| G27 | 60,000 | – | – | 10,000 | – | rUK | £11,942.60 | 2,456.60 | – |
| G28 | 70,000 | – | – | 5,000 | 2 | rUK | £17,243.60 | 2,656.60 | £405 |
| G29 | 50,000 | 5,000 | – | 5,000 | – | **SCOT** | £10,684.60 | 2,245.80 | – |
| G30 | 75,000 | 3,000 | 8,000 | 6,000 | 2 | **SCOT** | £26,221.65 | 2,756.60 | £2,070 |

¹ G15: engine £606.38 vs TaxCalc £606.37 — TaxCalc rounds the half-penny dividend tax down (HMRC convention); within tolerance. The HICBC rows are penny-exact after the s681C(3) floor fix (was £338.65 / £1,688.70 / £3,148.60 / £405.29 / £2,071.47 pre-fix — see the FINDING note at top).

Net pension entered as the **gross** in TaxCalc's relief-at-source box (÷0.8): G27 £12,500, G28/G29 £6,250, G30 £7,500. Child Benefit (2025-26): 1 child £1,354.60, 2 children £2,251.60, 3 children £3,148.60.

**Risk #1 is now fully closed → ~9.7/10.** The only remaining ceiling is real users' actual HMRC bills (post-launch). Next: resume the MTD export (still parked per Jamie).
