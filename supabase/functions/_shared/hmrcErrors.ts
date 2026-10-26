/**
 * hmrcErrors.ts — HMRC's codes never reach the customer raw (go-live plan A7,
 * spec §9 turnaways + §10 refusals, built 2026-10-02 S230).
 *
 * Every code below is HMRC's own, from the compliance register (§H, the
 * 2026-09-29 entry "The documented error codes and business fields for the
 * operations the filing feature calls", read from HMRC's OAS). Every message
 * is the spec's copy, signed off 29 Sep 2026; each says that nothing was sent
 * where that is the fact. The client receives the OUTCOME (kind + copy) and
 * the code for the audit row — it never has to know an HMRC code to render a
 * screen.
 *
 * Kinds, and what the client does with them:
 *   turnaway   — a calm screen with heading, line and next step (spec §9)
 *   refusal    — an inline message under the Send button (spec §10)
 *   reconnect  — card state 3: the sign-in has expired or was withdrawn
 *   nothing_due — card state 9
 *   busy       — HMRC is busy: the server already retried quietly
 *   our_fault  — a format or body code: our bug, never theirs; the server
 *                alerts and the customer sees one honest line
 *   covered    — a later update already stands (nothing to do)
 *
 * Pure module (tsx-testable). The mapping is pinned code-by-code in
 * scripts/test-hmrc-server.ts.
 */

export type OutcomeKind =
  | "turnaway"
  | "refusal"
  | "reconnect"
  | "nothing_due"
  | "busy"
  | "our_fault"
  | "covered"
  | "calc_in_progress"
  | "calc_needs_update";

export interface Outcome {
  kind: OutcomeKind;
  /** HMRC's code, or a synthetic one of ours (HTTP_429, HTTP_5XX, NETWORK). */
  code: string;
  /** For refusals and the one-line states. Always true to the facts. */
  message: string;
  /** Turnaways only: the spec §9 screen. */
  turnaway?: { id: TurnawayId; heading: string; line: string; next: { label: string; target: string } | null };
  /** True when HMRC stored nothing — the copy says so too. */
  nothingSent: boolean;
  /** Our side should be paged: a code that only our own mistake can produce. */
  alert: boolean;
}

export type TurnawayId =
  | "turnover_limit"
  | "calendar_quarters"
  | "not_signed_up"
  | "annual"
  | "ceased"
  | "property_only"
  | "insolvent";

/** The seven turnaways of spec §9, copy verbatim. `target` names a door the
 *  client already knows ("export", a URL, or "contact-hmrc"). */
export const TURNAWAYS: Record<TurnawayId, Outcome["turnaway"]> = {
  turnover_limit: {
    id: "turnover_limit",
    heading: "This update needs different software",
    line: "Once sales reach £90,000 in a tax year, HMRC needs each cost sent under its own heading. SoleTax sends one total. Your records and your export stay here.",
    next: { label: "Export my records", target: "export" },
  },
  calendar_quarters: {
    id: "calendar_quarters",
    heading: "Your quarters run to the month end",
    line: "You chose calendar quarters with HMRC. SoleTax sends standard quarters, which end on the 5th.",
    next: { label: "GOV.UK's software list", target: "https://www.gov.uk/guidance/find-software-thats-compatible-with-making-tax-digital-for-income-tax" },
  },
  not_signed_up: {
    id: "not_signed_up",
    heading: "HMRC doesn't have you down for Making Tax Digital yet",
    line: "Sign up on GOV.UK, then come back and connect.",
    next: { label: "How to sign up", target: "https://www.gov.uk/guidance/sign-up-your-business-for-making-tax-digital-for-income-tax" },
  },
  annual: {
    id: "annual",
    heading: "Nothing to send each quarter",
    line: "HMRC has this business reporting once a year for now.",
    next: null,
  },
  ceased: {
    id: "ceased",
    heading: "HMRC shows this business as closed",
    line: "",
    next: { label: "Contact HMRC", target: "contact-hmrc" },
  },
  property_only: {
    id: "property_only",
    heading: "SoleTax sends self-employment updates",
    line: "Rental income under Making Tax Digital needs separate software.",
    next: { label: "GOV.UK's software list", target: "https://www.gov.uk/guidance/find-software-thats-compatible-with-making-tax-digital-for-income-tax" },
  },
  insolvent: {
    id: "insolvent",
    heading: "HMRC can't take this update from software",
    line: "",
    next: { label: "Contact HMRC", target: "contact-hmrc" },
  },
};

export const COPY = {
  ninoMismatch: "HMRC didn't match that number to your sign-in. Check it in Tax → Quarterly updates → Connection.",
  coveredByLater: "HMRC already has a later update. This one is covered by it.",
  periodClosed: "HMRC has closed this period to changes.",
  ourFault: "That didn't go through. Nothing was sent. We've been told and we're on it.",
  busy: "HMRC is busy right now. Nothing was sent. Try again in a few minutes.",
  calcInProgress: "HMRC is still working it out. Try again in a minute.",
  calcNeedsUpdate: "HMRC needs your first update before it can estimate.",
  reconnect: "HMRC asks for a fresh sign-in every 18 months. About a minute.",
  offline: "You're offline. Nothing was sent. Try again when you're back online.",
  unconfirmed: "We couldn't confirm that with HMRC. Check Sent updates in a minute before sending again.",
} as const;

/** A turnaway outcome for a case we detect ourselves (the £90,000 guard, a
 *  stored calendar-quarters business, a ceased business, property only). */
export const turnawayOutcome = (id: TurnawayId, code: string): Outcome => ({
  kind: "turnaway",
  code,
  message: TURNAWAYS[id]!.line || TURNAWAYS[id]!.heading,
  turnaway: TURNAWAYS[id],
  nothingSent: true,
  alert: false,
});
const turnaway = turnawayOutcome;

/** The spec §10 table, code → outcome. Unknown RULE_/FORMAT_ codes fall to
 *  our_fault (a body we built wrongly), unknown everything else to busy. */
export function outcomeForCode(code: string): Outcome {
  switch (code) {
    case "CLIENT_OR_AGENT_NOT_AUTHORISED":
      return { kind: "refusal", code, message: COPY.ninoMismatch, nothingSent: true, alert: false };
    case "MATCHING_RESOURCE_NOT_FOUND":
    case "NO_BUSINESS_FOUND":
      return turnaway("not_signed_up", code);
    case "NO_OBLIGATIONS_FOUND":
      return { kind: "nothing_due", code, message: "Nothing to send yet.", nothingSent: true, alert: false };
    case "RULE_SUBMISSION_END_DATE_CANNOT_MOVE_BACKWARDS":
      return { kind: "covered", code, message: COPY.coveredByLater, nothingSent: true, alert: false };
    case "RULE_OUTSIDE_AMENDMENT_WINDOW":
      return { kind: "refusal", code, message: COPY.periodClosed, nothingSent: true, alert: false };
    case "RULE_END_DATE_NOT_ALIGNED_WITH_REPORTING_TYPE":
    case "RULE_START_DATE_NOT_ALIGNED_WITH_REPORTING_TYPE":
      return turnaway("calendar_quarters", code);
    case "RULE_START_AND_END_DATE_NOT_ALLOWED":
      return turnaway("annual", code);
    case "RULE_INSOLVENT_TRADER":
      return turnaway("insolvent", code);
    case "RULE_CALCULATION_IN_PROGRESS":
      return { kind: "calc_in_progress", code, message: COPY.calcInProgress, nothingSent: true, alert: false };
    case "RULE_NO_INCOME_SUBMISSIONS_EXIST":
      return { kind: "calc_needs_update", code, message: COPY.calcNeedsUpdate, nothingSent: true, alert: false };
    case "RULE_START_DATE_NOT_ALIGNED_TO_COMMENCEMENT_DATE":
      // The server retries once with HMRC's own commencement date before this
      // outcome is ever returned (spec §10): if it still fails, it is ours.
      return { kind: "our_fault", code, message: COPY.ourFault, nothingSent: true, alert: true };
    case "HTTP_429":
    case "HTTP_5XX":
    case "NETWORK":
      return { kind: "busy", code, message: COPY.busy, nothingSent: true, alert: false };
    case "INVALID_GRANT":
    case "RECONNECT":
      return { kind: "reconnect", code, message: COPY.reconnect, nothingSent: true, alert: false };
    default:
      if (/^(FORMAT_|RULE_|MISSING_|RANGE_|INVALID_|TAX_YEAR_)/.test(code)) {
        return { kind: "our_fault", code, message: COPY.ourFault, nothingSent: true, alert: true };
      }
      return { kind: "busy", code, message: COPY.busy, nothingSent: true, alert: false };
  }
}

/** HMRC error bodies carry `code` at the top and, for 400s, an `errors[]`
 *  list of specific codes. The most specific code wins. */
export function hmrcCodeOf(status: number, body: unknown): string {
  if (status === 429) return "HTTP_429";
  if (status >= 500) return "HTTP_5XX";
  const b = (body ?? {}) as { code?: unknown; errors?: { code?: unknown }[] };
  const inner = Array.isArray(b.errors) ? b.errors.find((e) => typeof e?.code === "string")?.code : undefined;
  if (typeof inner === "string" && inner) return inner;
  if (typeof b.code === "string" && b.code) return b.code;
  return `HTTP_${status}`;
}

export function outcomeFor(status: number, body: unknown): Outcome {
  return outcomeForCode(hmrcCodeOf(status, body));
}
