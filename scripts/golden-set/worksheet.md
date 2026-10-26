# Golden-set worksheet — HMRC-recognised SA package cross-check

Tax year **2025-26** — enter these into **TaxCalc 2026** (the SA100 *base return*,
NOT the What If? Planner, which lacks 2026-27 rates). Read off the **Tax Calculation
Summary**: box 1 **Total tax** and box 4 **Class 4 NIC**. Then run
`npm run golden:compare -- --year 2025-26`. (2025-26 validates the engine's LOGIC;
the 2026-27 rate numbers are separately verbatim-sourced + cooltax-checked.)

> Leave everything else (employment, Class 2, student loan, payments on account) at
> zero/default. The engine's own answers are deliberately NOT shown here — record
> what the package says, then let the compare reveal any differences.

Self-employment entry tip: enter **turnover £1,000 above the profit** with **£1,000
expenses** (e.g. profit £5,000 → turnover £6,000, expenses £1,000) and DON'T claim
the £1,000 trading allowance — that gives the exact taxable profit shown below.

## G01 — Plain basic-rate trader

```
Self-employment taxable profit:  £30,000
Resident in:                     England / Wales / NI
```

Record from the package → `income_tax`, `hicbc`, `class4`, `total`.

## G02 — Higher-rate trader

```
Self-employment taxable profit:  £60,000
Resident in:                     England / Wales / NI
```

Record from the package → `income_tax`, `hicbc`, `class4`, `total`.

## G03 — Plain trader, Scotland

```
Self-employment taxable profit:  £30,000
Resident in:                     Scotland
```

Record from the package → `income_tax`, `hicbc`, `class4`, `total`.

## G04 — gov.uk example: £16k + £200 interest → £0 (starting-rate band)

```
Self-employment taxable profit:  £16,000
Savings interest (untaxed):      £200
Resident in:                     England / Wales / NI
```

Record from the package → `income_tax`, `hicbc`, `class4`, `total`.

## G05 — PSA basic: £30k + £2k interest

```
Self-employment taxable profit:  £30,000
Savings interest (untaxed):      £2,000
Resident in:                     England / Wales / NI
```

Record from the package → `income_tax`, `hicbc`, `class4`, `total`.

## G06 — Starting-rate band partly used: £13k + £6k interest

```
Self-employment taxable profit:  £13,000
Savings interest (untaxed):      £6,000
Resident in:                     England / Wales / NI
```

Record from the package → `income_tax`, `hicbc`, `class4`, `total`.

## G07 — PSA higher (£500): £60k + £2k interest

```
Self-employment taxable profit:  £60,000
Savings interest (untaxed):      £2,000
Resident in:                     England / Wales / NI
```

Record from the package → `income_tax`, `hicbc`, `class4`, `total`.

## G08 — PSA nil (additional): £130k + £2k interest

```
Self-employment taxable profit:  £130,000
Savings interest (untaxed):      £2,000
Resident in:                     England / Wales / NI
```

Record from the package → `income_tax`, `hicbc`, `class4`, `total`.

## G09 — Savings UK-rated under Scottish bands: £30k + £2k

```
Self-employment taxable profit:  £30,000
Savings interest (untaxed):      £2,000
Resident in:                     Scotland
```

Record from the package → `income_tax`, `hicbc`, `class4`, `total`.

## G10 — Scotland higher + savings: £50k + £5k

```
Self-employment taxable profit:  £50,000
Savings interest (untaxed):      £5,000
Resident in:                     Scotland
```

Record from the package → `income_tax`, `hicbc`, `class4`, `total`.

## G11 — gov.uk example: £29,570 + £3,000 dividends → £268.75

```
Self-employment taxable profit:  £29,570
Dividend income:                 £3,000
Resident in:                     England / Wales / NI
```

Record from the package → `income_tax`, `hicbc`, `class4`, `total`.

## G12 — Dividends ordinary→upper: £45k + £20k

```
Self-employment taxable profit:  £45,000
Dividend income:                 £20,000
Resident in:                     England / Wales / NI
```

Record from the package → `income_tax`, `hicbc`, `class4`, `total`.

## G13 — Dividends UK-rated under Scottish bands: £45k + £20k

```
Self-employment taxable profit:  £45,000
Dividend income:                 £20,000
Resident in:                     Scotland
```

Record from the package → `income_tax`, `hicbc`, `class4`, `total`.

## G14 — Dividends upper→additional + £100k taper: £120k + £30k

```
Self-employment taxable profit:  £120,000
Dividend income:                 £30,000
Resident in:                     England / Wales / NI
```

Record from the package → `income_tax`, `hicbc`, `class4`, `total`.

## G15 — Dividends use leftover PA: £10k + £10k

```
Self-employment taxable profit:  £10,000
Dividend income:                 £10,000
Resident in:                     England / Wales / NI
```

Record from the package → `income_tax`, `hicbc`, `class4`, `total`.

## G16 — Beneficial split (B1): £5k profit + £5k savings + £10k dividends → £207.48

```
Self-employment taxable profit:  £5,000
Savings interest (untaxed):      £5,000
Dividend income:                 £10,000
Resident in:                     England / Wales / NI
```

Record from the package → `income_tax`, `hicbc`, `class4`, `total`.

## G17 — Beneficial split, Scotland: £5k + £5k savings + £10k dividends

```
Self-employment taxable profit:  £5,000
Savings interest (untaxed):      £5,000
Dividend income:                 £10,000
Resident in:                     Scotland
```

Record from the package → `income_tax`, `hicbc`, `class4`, `total`.

## G18 — Beneficial: £2.5k + £2k savings + £10k dividends

```
Self-employment taxable profit:  £2,500
Savings interest (untaxed):      £2,000
Dividend income:                 £10,000
Resident in:                     England / Wales / NI
```

Record from the package → `income_tax`, `hicbc`, `class4`, `total`.

## G19 — Beneficial, no profit: £0 + £5k savings + £15k dividends

```
Self-employment taxable profit:  £0
Savings interest (untaxed):      £5,000
Dividend income:                 £15,000
Resident in:                     England / Wales / NI
```

Record from the package → `income_tax`, `hicbc`, `class4`, `total`.

## G20 — Higher-rate interaction: £45k + £1k savings + £8k dividends

```
Self-employment taxable profit:  £45,000
Savings interest (untaxed):      £1,000
Dividend income:                 £8,000
Resident in:                     England / Wales / NI
```

Record from the package → `income_tax`, `hicbc`, `class4`, `total`.

## G21 — Taper + PSA: £100k + £5k savings

```
Self-employment taxable profit:  £100,000
Savings interest (untaxed):      £5,000
Resident in:                     England / Wales / NI
```

Record from the package → `income_tax`, `hicbc`, `class4`, `total`.

## G22 — Taper + dividends: £110k + £10k

```
Self-employment taxable profit:  £110,000
Dividend income:                 £10,000
Resident in:                     England / Wales / NI
```

Record from the package → `income_tax`, `hicbc`, `class4`, `total`.

## G23 — Odd-pound taper (s35(3) round-up): £100,417

```
Self-employment taxable profit:  £100,417
Resident in:                     England / Wales / NI
```

Record from the package → `income_tax`, `hicbc`, `class4`, `total`.

## G24 — HICBC partial: £65k, 1 child

```
Self-employment taxable profit:  £65,000
Child Benefit — children:        1  (you are the higher earner)
Resident in:                     England / Wales / NI
```

Record from the package → `income_tax`, `hicbc`, `class4`, `total`.

## G25 — HICBC + dividends: £70k + £5k, 2 children

```
Self-employment taxable profit:  £70,000
Dividend income:                 £5,000
Child Benefit — children:        2  (you are the higher earner)
Resident in:                     England / Wales / NI
```

Record from the package → `income_tax`, `hicbc`, `class4`, `total`.

## G26 — HICBC 100%: £85k, 3 children

```
Self-employment taxable profit:  £85,000
Child Benefit — children:        3  (you are the higher earner)
Resident in:                     England / Wales / NI
```

Record from the package → `income_tax`, `hicbc`, `class4`, `total`.

## G27 — Pension band-extension: £60k + £10k net pension

```
Self-employment taxable profit:  £60,000
Personal pension paid (NET):     £10,000  (relief at source)
Resident in:                     England / Wales / NI
```

Record from the package → `income_tax`, `hicbc`, `class4`, `total`.

## G28 — Pension lowers HICBC: £70k + £5k net pension, 2 children

```
Self-employment taxable profit:  £70,000
Personal pension paid (NET):     £5,000  (relief at source)
Child Benefit — children:        2  (you are the higher earner)
Resident in:                     England / Wales / NI
```

Record from the package → `income_tax`, `hicbc`, `class4`, `total`.

## G29 — Scotland + savings + pension: £50k + £5k savings + £5k net pension

```
Self-employment taxable profit:  £50,000
Savings interest (untaxed):      £5,000
Personal pension paid (NET):     £5,000  (relief at source)
Resident in:                     Scotland
```

Record from the package → `income_tax`, `hicbc`, `class4`, `total`.

## G30 — All at once, Scotland: £75k + £3k savings + £8k dividends + £6k net pension, 2 children

```
Self-employment taxable profit:  £75,000
Savings interest (untaxed):      £3,000
Dividend income:                 £8,000
Personal pension paid (NET):     £6,000  (relief at source)
Child Benefit — children:        2  (you are the higher earner)
Resident in:                     Scotland
```

Record from the package → `income_tax`, `hicbc`, `class4`, `total`.
