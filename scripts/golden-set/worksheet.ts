/**
 * golden-set/worksheet.ts — generate the BLIND data-entry pack.
 *
 * Writes two files into scripts/golden-set/:
 *   • worksheet.md          — for each scenario, exactly what to type into the SA
 *                             package. NO engine figures (so reading the package's
 *                             numbers can't be anchored to ours — an honest oracle).
 *   • package-results.csv   — a blank table to record the package's output per
 *                             scenario; `npm run golden:compare` reads it back.
 *
 * Run:  npm run golden:worksheet
 */

import { writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { SCENARIOS, entryLines } from './scenarios';

const here = path.dirname(fileURLToPath(import.meta.url));
// Accepts `--year 2025-26`, `--year=2025-26`, or a bare `2025-26` arg.
const YEAR = process.argv.some((a) => a.includes('2025-26')) ? '2025-26' : '2026-27';

// ── worksheet.md ──────────────────────────────────────────────────────────────
const md: string[] = [];
md.push('# Golden-set worksheet — HMRC-recognised SA package cross-check');
md.push('');
if (YEAR === '2025-26') {
  md.push('Tax year **2025-26** — enter these into **TaxCalc 2026** (the SA100 *base return*,');
  md.push('NOT the What If? Planner, which lacks 2026-27 rates). Read off the **Tax Calculation');
  md.push('Summary**: box 1 **Total tax** and box 4 **Class 4 NIC**. Then run');
  md.push('`npm run golden:compare -- --year 2025-26`. (2025-26 validates the engine\'s LOGIC;');
  md.push('the 2026-27 rate numbers are separately verbatim-sourced + cooltax-checked.)');
} else {
  md.push('Tax year **2026-27**. For each scenario: start a fresh return, enter ONLY the');
  md.push('figures listed, read off the computed **Income Tax**, **High Income Child Benefit');
  md.push('Charge** (if shown separately), **Class 4 NIC**, and the **total tax/NIC due**,');
  md.push('and write them into `package-results.csv`. Then run `npm run golden:compare`.');
}
md.push('');
md.push('> Leave everything else (employment, Class 2, student loan, payments on account) at');
md.push('> zero/default. The engine\'s own answers are deliberately NOT shown here — record');
md.push('> what the package says, then let the compare reveal any differences.');
md.push('');
md.push('Self-employment entry tip: enter **turnover £1,000 above the profit** with **£1,000');
md.push('expenses** (e.g. profit £5,000 → turnover £6,000, expenses £1,000) and DON\'T claim');
md.push('the £1,000 trading allowance — that gives the exact taxable profit shown below.');
md.push('');
for (const s of SCENARIOS) {
  md.push(`## ${s.id} — ${s.note}`);
  md.push('');
  md.push('```');
  for (const line of entryLines(s)) md.push(line);
  md.push('```');
  md.push('');
  md.push('Record from the package → `income_tax`, `hicbc`, `class4`, `total`.');
  md.push('');
}
writeFileSync(path.join(here, 'worksheet.md'), md.join('\n'));

// ── package-results.csv (blank template — never clobber entered data) ──────────
const csvPath = path.join(here, 'package-results.csv');
if (existsSync(csvPath)) {
  console.log(`Wrote scripts/golden-set/worksheet.md (${SCENARIOS.length} scenarios).`);
  console.log('package-results.csv already exists — left untouched (delete it to regenerate a blank).');
} else {
  const csv: string[] = [];
  csv.push('# Enter the PACKAGE\'s figures (pounds, decimals ok). Leave a cell blank to skip it.');
  csv.push('# income_tax = income tax on all income EXCL the Child Benefit charge (savings + dividends included).');
  csv.push('# hicbc      = High Income Child Benefit Charge (0 if no children).');
  csv.push('# class4     = Class 4 NIC.   total = total tax + NIC due (Class 2 £0, no student loan / CIS).');
  csv.push('scenario,income_tax,hicbc,class4,total');
  for (const s of SCENARIOS) csv.push(`${s.id},,,,`);
  writeFileSync(csvPath, csv.join('\n') + '\n');
  console.log(`Wrote scripts/golden-set/worksheet.md + a blank package-results.csv (${SCENARIOS.length} scenarios).`);
}
console.log('Enter each scenario into the SA package, fill package-results.csv, then: npm run golden:compare');
