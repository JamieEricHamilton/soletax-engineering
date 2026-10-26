/**
 * test-rule-cards.ts — Stage 1 of the engine-grounded "explain my bill"
 * capability (support_agent_spec.md §5b): the rule-card corpus, the field→card
 * wiring, and the two-estimate diff.
 *
 * These are integrity + grounding tests, not new tax maths: the corpus must stay
 * pinned to real engine fields (so it can't drift when the engine changes), the
 * wiring must resolve, and the diff must echo engine figures only — the basis
 * for "why did my tax move when I added kids?". The HICBC scenario below is
 * hand-computed from the verbatim §U rates so the annual review can recheck it.
 *
 * Run:  npx tsx scripts/test-rule-cards.ts   (or: npm run test:tax)
 */

import {
  calculateTaxEstimate,
  cardById,
  cardsForField,
  cardsForLine,
  diffEstimates,
  ESTIMATE_LINES,
  RULE_CARDS,
  type TaxEstimate,
} from '../src/tax';

let failures = 0;
let checks = 0;

function check(name: string, actual: unknown, expected: unknown) {
  checks++;
  if (actual !== expected) {
    failures++;
    console.error(`  ✗ ${name}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function ok(name: string, cond: boolean) {
  check(name, cond, true);
}

console.log('\nRule-card corpus — Stage 1 grounding layer (support_agent_spec §5b)\n');

// A real estimate to pin fieldRefs and line accessors against.
const sample = calculateTaxEstimate({
  taxYear: '2026-27',
  nation: 'england-wales-ni',
  incomeReceived: 78_550,
  deductibleExpenses: 2_000,
  childBenefitChildren: 2,
});

// ── 1. Corpus integrity ──────────────────────────────────────────────────────
{
  const ids = RULE_CARDS.map((c) => c.id);
  check('1 corpus · ids are unique', new Set(ids).size, ids.length);
  for (const c of RULE_CARDS) {
    ok(`1 corpus · ${c.id} has a title`, c.title.trim().length > 0);
    ok(`1 corpus · ${c.id} has plain English`, c.plainEnglish.trim().length > 0);
    ok(`1 corpus · ${c.id} has a verbatim quote`, c.verbatimQuote.trim().length > 0);
    ok(`1 corpus · ${c.id} cites a source`, c.source.citation.trim().length > 0 && c.source.register.trim().length > 0);
    ok(`1 corpus · ${c.id} stamps a read date`, /^\d{4}-\d{2}-\d{2}$/.test(c.source.readDate));
    ok(`1 corpus · ${c.id} names ≥1 field`, c.fieldRefs.length > 0);
    // Every fieldRef must be a real key on the engine output — guards drift.
    for (const f of c.fieldRefs) ok(`1 corpus · ${c.id} fieldRef '${String(f)}' exists on TaxEstimate`, f in sample);
    // Brand voice: no em dashes in user-facing plain English (brand_voice.md).
    ok(`1 corpus · ${c.id} plain English has no em dash`, !c.plainEnglish.includes('—'));
  }
}

// ── 2. Field → card + line wiring ────────────────────────────────────────────
{
  check('2 wiring · cardById resolves', cardById('hicbc')?.id, 'hicbc');
  check('2 wiring · cardById unknown → undefined', cardById('nope'), undefined);

  const hicbcFieldCards = cardsForField('hicbcCharge').map((c) => c.id);
  ok('2 wiring · hicbcCharge → hicbc card', hicbcFieldCards.includes('hicbc'));
  ok('2 wiring · class4Nic → class-4-nic card', cardsForField('class4Nic').some((c) => c.id === 'class-4-nic'));

  for (const line of ESTIMATE_LINES) {
    // Every cardId on a line resolves to a real card.
    check(`2 wiring · line '${line.key}' cards resolve`, cardsForLine(line.key).length, line.cardIds.length);
    // Every line reads a finite £ figure off a real estimate.
    ok(`2 wiring · line '${line.key}' reads a number`, Number.isFinite(line.amount(sample)));
  }
}

// ── 3. diffEstimates — the "why did it move?" basis ──────────────────────────
{
  // Same profit, drop from 2 children to 0 — only the HICBC-driven lines move.
  const base = { taxYear: '2026-27', nation: 'england-wales-ni' as const, incomeReceived: 78_550, deductibleExpenses: 2_000 };
  const twoKids: TaxEstimate = calculateTaxEstimate({ ...base, childBenefitChildren: 2 });
  const noKids: TaxEstimate = calculateTaxEstimate({ ...base, childBenefitChildren: 0 });

  // Hand-computed §U (ANI £76,550): % = floor((76,550−60,000)/200) = 82;
  // Child Benefit (2 kids) = (27.05+17.90)×52 = £2,337.40 → floor £2,337;
  // HICBC = floor(2,337 × 0.82) = £1,916. With 0 kids the charge is £0.
  check('3 diff · HICBC(2 kids) = 1916', Math.round(twoKids.hicbcCharge), 1916);
  check('3 diff · HICBC(0 kids) = 0', noKids.hicbcCharge, 0);

  const deltas = diffEstimates(twoKids, noKids);
  const keys = deltas.map((d) => d.key);

  ok('3 diff · empty when nothing changes', diffEstimates(twoKids, twoKids).length === 0);
  ok('3 diff · HICBC line moved', keys.includes('hicbc'));
  ok('3 diff · NI line did NOT move (same profit)', !keys.includes('national-insurance'));
  ok('3 diff · the total moved', keys.includes('total'));
  // §U / S82: HICBC sits inside the payments-on-account base, so the POA moves too.
  ok('3 diff · payments on account moved (HICBC in the POA base)', keys.includes('payments-on-account'));

  const hicbcDelta = deltas.find((d) => d.key === 'hicbc')!;
  check('3 diff · HICBC before echoes the estimate', Math.round(hicbcDelta.before), 1916);
  check('3 diff · HICBC after echoes the estimate', hicbcDelta.after, 0);
  check('3 diff · HICBC delta = after − before', Math.round(hicbcDelta.delta), -1916);
  ok('3 diff · HICBC delta carries the hicbc rule-card', hicbcDelta.cards.some((c) => c.id === 'hicbc'));

  // Echo-only guardrail: every figure equals a line read off one of the estimates.
  for (const d of deltas) {
    const line = ESTIMATE_LINES.find((l) => l.key === d.key)!;
    ok(`3 diff · '${d.key}' before is echoed`, d.before === line.amount(twoKids));
    ok(`3 diff · '${d.key}' after is echoed`, d.after === line.amount(noKids));
  }

  // Biggest mover first — the total swings by the HICBC plus its POA half.
  check('3 diff · sorted, biggest mover first', deltas[0].key, 'total');
}

// ─────────────────────────────────────────────────────────────────────────────
if (failures > 0) {
  console.error(`\n❌ ${failures}/${checks} rule-card checks FAILED`);
  process.exit(1);
}
console.log(`✅ All ${checks} rule-card checks passed (corpus integrity + field/line wiring + estimate diff)`);
