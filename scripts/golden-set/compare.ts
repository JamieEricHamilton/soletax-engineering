/**
 * golden-set/compare.ts — diff the SA package's figures against the engine.
 *
 * Reads scripts/golden-set/package-results.csv (which you fill from the package via
 * the worksheet), recomputes each scenario with the engine, and prints a per-field
 * comparison. Blank cells are skipped. A penny or two of difference is just the
 * package rounding to whole pounds; anything bigger is flagged to INVESTIGATE — that
 * is the signal worth its weight, because the package is HMRC-recognised and we are
 * not (yet).
 *
 * Run:  npm run golden:compare
 * Tol:  GOLDEN_TOL=2 npm run golden:compare   (default £1.00 — flag diffs above it)
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { SCENARIOS, runEngine, type Figures } from './scenarios';
import { referenceFigures, selfCheck, type TaxYear } from './reference';

const here = path.dirname(fileURLToPath(import.meta.url));
const TOL = Number(process.env.GOLDEN_TOL ?? 1); // £ — at/under this, treat as rounding

// --year 2025-26 → diff against the engine's logic on 2025-26 (what TaxCalc computes
// today); default 2026-27 → diff against the live production engine.
// Accepts `--year 2025-26`, `--year=2025-26`, or a bare `2025-26` arg.
const YEAR: TaxYear = process.argv.some((a) => a.includes('2025-26')) ? '2025-26' : '2026-27';
const figuresFor = (s: (typeof SCENARIOS)[number]): Figures =>
  YEAR === '2025-26' ? referenceFigures(s, '2025-26') : runEngine(s).figures;

// In 2025-26 mode, first prove the reference IS the engine's logic (== production
// engine on 2026-27) — otherwise a mismatch with TaxCalc could be our reference, not
// the engine.
if (YEAR === '2025-26') {
  const fails = selfCheck();
  if (fails.length) {
    console.error('Reference self-check FAILED — the 2025-26 reference does not match the production engine on 2026-27, so it cannot be trusted:');
    for (const f of fails) console.error(`  ${f}`);
    process.exit(1);
  }
}

// CSV columns → engine Figures keys
const COL_TO_FIELD: Record<string, keyof Figures> = { income_tax: 'incomeTax', hicbc: 'hicbc', class4: 'class4', total: 'total' };

let raw: string;
try {
  raw = readFileSync(path.join(here, 'package-results.csv'), 'utf8');
} catch {
  console.error('No package-results.csv yet — run `npm run golden:worksheet` first, then fill it in.');
  process.exit(1);
}

const rows = raw
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#') && !l.startsWith('scenario,'));

const entered = new Map<string, Partial<Record<string, number>>>();
for (const line of rows) {
  const [id, ...cells] = line.split(',');
  const cols = ['income_tax', 'hicbc', 'class4', 'total'];
  const rec: Partial<Record<string, number>> = {};
  cols.forEach((c, i) => {
    const v = (cells[i] ?? '').trim();
    if (v !== '') rec[c] = Number(v);
  });
  entered.set(id.trim(), rec);
}

const filled = SCENARIOS.filter((s) => {
  const r = entered.get(s.id);
  return r && Object.keys(r).length > 0;
});

if (filled.length === 0) {
  console.log('No package figures entered yet. Fill scripts/golden-set/package-results.csv, then re-run.');
  console.log(`(${SCENARIOS.length} scenarios are waiting; see worksheet.md for what to enter.)`);
  process.exit(0);
}

console.log(`Golden-set compare — engine (${YEAR}${YEAR === '2025-26' ? ', logic check vs TaxCalc' : ''}) vs SA package (tolerance £${TOL.toFixed(2)}; ${filled.length}/${SCENARIOS.length} scenarios entered)\n`);

let investigate = 0;
let rounding = 0;
let exact = 0;
const flagged: string[] = [];

for (const s of filled) {
  const figures = figuresFor(s);
  const rec = entered.get(s.id)!;
  const parts: string[] = [];
  let worstFlag = false;
  for (const col of Object.keys(COL_TO_FIELD)) {
    if (!(col in rec)) continue;
    const field = COL_TO_FIELD[col];
    const pkg = rec[col]!;
    const eng = figures[field];
    const diff = Math.abs(pkg - eng);
    let mark: string;
    if (diff < 0.005) {
      mark = '✓';
      exact++;
    } else if (diff <= TOL) {
      mark = '~';
      rounding++;
    } else {
      mark = '✗';
      investigate++;
      worstFlag = true;
    }
    parts.push(`${col}: engine £${eng.toFixed(2)} vs package £${pkg.toFixed(2)} ${mark}${diff >= 0.005 ? ` (Δ£${diff.toFixed(2)})` : ''}`);
  }
  const head = `${worstFlag ? '✗' : '✓'} ${s.id}  ${s.note}`;
  console.log(head);
  for (const p of parts) console.log(`     ${p}`);
  if (worstFlag) flagged.push(`${s.id} — ${s.note}`);
}

console.log('');
console.log(`Summary: ${exact} exact, ${rounding} within £${TOL.toFixed(2)} (rounding), ${investigate} to INVESTIGATE.`);
if (flagged.length) {
  console.log('\n✗ Scenarios needing investigation (engine and HMRC-recognised package disagree by more than the tolerance):');
  for (const f of flagged) console.log(`   - ${f}`);
  console.log('\nResolve each from the PRIMARY source (legislation / gov.uk), not by trusting either calculator.');
  process.exit(1);
}
console.log('\nAll entered scenarios agree with the HMRC-recognised package within rounding. ✅');
