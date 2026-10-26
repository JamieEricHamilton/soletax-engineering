/**
 * explainBill.ts — the `explain_bill` payload builder (capability D, Stage 2a).
 * docs/specs/support_agent_spec.md §5b.
 *
 * This is the DETERMINISTIC, ungated core of the explainer: given the user's own
 * TaxEstimate (and optionally a previous one for "why did it change?"), it
 * assembles exactly the grounded payload the LLM is later handed — the bill's
 * lines with their echoed £ figures + the verbatim rule-card(s) that explain
 * each. The model in Stage 2b explains FROM this payload and nothing else, so the
 * compliance-sensitive guardrails are enforced HERE, in code, not left to a
 * prompt:
 *   • Echo-only — every figure is read straight off an estimate via the
 *     ESTIMATE_LINES accessors (or is a difference of two such figures). No new
 *     number is ever derived.
 *   • Minimisation — only the curated grounded drivers are exposed (no raw
 *     income/expense inputs, no PII; TaxEstimate carries no client data anyway),
 *     and zero lines are dropped (nothing to explain).
 *   • Cite-or-explain-nothing — a line carries its rule-card(s); a line with no
 *     card (the headline total) is explained by its components, never invented.
 *
 * Stage 2b (the gated part, Jamie's infra call) wires this payload into the
 * Supabase Edge Function `support-agent` + the grounded synthesis prompt; it
 * ships OFF until the §8 validation set passes.
 */

import type { TaxEstimate } from './engine';
import type { UKNation } from './rates-2026-27';
import { cardById, diffEstimates, ESTIMATE_LINES, cardsForLine, type RuleCard } from './ruleCards';

/** A rule-card projected to the fields the model is given (no internal wiring). */
export interface ExplainCard {
  id: string;
  title: string;
  plainEnglish: string;
  verbatimQuote: string;
  source: RuleCard['source'];
}

/** One bill line in the payload. `before`/`after`/`delta` are present only in
 *  'diff' mode (the "why did it move?" case). */
export interface ExplainLine {
  key: string;
  label: string;
  amount: number;
  cards: ExplainCard[];
  before?: number;
  after?: number;
  delta?: number;
}

/** Curated, echo-only drivers the model may reference for context. Deliberately
 *  NOT the raw income/expense inputs — only the computed drivers behind the bill. */
export interface ExplainBillContext {
  taxableProfit: number;
  adjustedNetIncome: number;
  personalAllowance: number;
  deductionBasis: TaxEstimate['deductionBasis'];
  hicbcPercent: number;
  class2Status: TaxEstimate['class2Status'];
}

export interface ExplainBillPayload {
  /** 'single' = explain this bill; 'diff' = explain what changed vs `against`. */
  mode: 'single' | 'diff';
  taxYear: string;
  nation: UKNation;
  /** The lines the model may talk about, biggest-figure/biggest-mover first. */
  lines: ExplainLine[];
  /** Grounded drivers (of the current estimate) the model may reference. */
  context: ExplainBillContext;
}

function toExplainCard(c: RuleCard): ExplainCard {
  return { id: c.id, title: c.title, plainEnglish: c.plainEnglish, verbatimQuote: c.verbatimQuote, source: c.source };
}

// The deduction line is wired to the trading-allowance card by default, but the
// figure shown is the bigger of (actual expenses, £1,000 allowance). Explain the
// one actually in use — a £25k expenses deduction must NOT be described as the
// £1,000 allowance. Keyed off the engine's own deductionBasis.
function applyDeductionBasis<T extends { key: string; label: string; cards: ExplainCard[] }>(
  line: T,
  estimate: TaxEstimate,
): T {
  if (line.key !== 'deduction') return line;
  const trading = estimate.deductionBasis === 'trading-allowance';
  const card = cardById(trading ? 'trading-allowance' : 'business-expenses');
  return {
    ...line,
    label: trading ? 'Trading allowance' : 'Your expenses',
    cards: card ? [toExplainCard(card)] : line.cards,
  };
}

// The income-tax line is wired to the rest-of-UK `income-tax` card by default.
// For a Scottish user, swap in the Scotland card so the rule they're shown quotes
// the Scottish ladder (19/20/21/42/45/48%) their figures were actually taxed
// under, never the rUK 20/40/45 bands. The personal-allowance card is UK-wide and
// stays. NIC, savings and dividends are UK-wide either way, so only this line moves.
function applyNationIncomeTaxCard<T extends { key: string; cards: ExplainCard[] }>(
  line: T,
  estimate: TaxEstimate,
): T {
  if (line.key !== 'income-tax' || estimate.nation !== 'scotland') return line;
  const scot = cardById('income-tax-scotland');
  if (!scot) return line;
  return { ...line, cards: line.cards.map((c) => (c.id === 'income-tax' ? toExplainCard(scot) : c)) };
}

function contextOf(e: TaxEstimate): ExplainBillContext {
  return {
    taxableProfit: e.taxableProfit,
    adjustedNetIncome: e.adjustedNetIncome,
    personalAllowance: e.personalAllowance,
    deductionBasis: e.deductionBasis,
    hicbcPercent: e.hicbcPercent,
    class2Status: e.class2Status,
  };
}

/**
 * Assemble the grounded payload for an "explain my bill" turn.
 *
 * Single mode (no `against`): every bill line with a non-zero figure (plus the
 * headline total, always), each with its rule-card(s), largest figure first.
 * Diff mode (`against` = a previous estimate): only the lines that changed,
 * each with before/after/delta + its rule-card(s), biggest mover first — the
 * engine-grounded answer to "why did my tax move when I…?".
 */
export function buildExplainBillPayload(
  estimate: TaxEstimate,
  opts: { against?: TaxEstimate } = {},
): ExplainBillPayload {
  const base = { taxYear: estimate.taxYear, nation: estimate.nation, context: contextOf(estimate) };

  if (opts.against) {
    const deltas = diffEstimates(opts.against, estimate);
    return {
      ...base,
      mode: 'diff',
      lines: deltas
        .map((d) => ({
          key: d.key,
          label: d.label,
          amount: d.after,
          before: d.before,
          after: d.after,
          delta: d.delta,
          cards: d.cards.map(toExplainCard),
        }))
        .map((line) => applyDeductionBasis(line, estimate))
        .map((line) => applyNationIncomeTaxCard(line, estimate)),
    };
  }

  const lines = ESTIMATE_LINES.map((line) => ({ line, amount: line.amount(estimate) }))
    .filter(({ line, amount }) => amount !== 0 || line.key === 'total')
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))
    .map(({ line, amount }) => ({
      key: line.key,
      label: line.label,
      amount,
      cards: cardsForLine(line.key).map(toExplainCard),
    }))
    .map((line) => applyDeductionBasis(line, estimate))
    .map((line) => applyNationIncomeTaxCard(line, estimate));

  return { ...base, mode: 'single', lines };
}
