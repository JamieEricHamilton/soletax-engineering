/**
 * hmrcNino.ts — the National Insurance number's shape, as HMRC publishes it
 * (go-live plan A3, spec step 2, built 2026-10-02 S230).
 *
 * Source, read verbatim 2026-10-02 from HMRC's Business Details (MTD) 2.0 OAS
 * (`api-documentation/docs/api/service/business-details-api/2.0/oas/resolved`,
 * the `nino` path parameter on every operation): "National Insurance number,
 * in the format `AA999999A`" — two letters, six digits, one letter. The
 * schema carries no finer pattern (the same text on the Self Employment
 * Business 5.0 and Obligations 3.0 specs), and HMRC answers `FORMAT_NINO: The
 * provided NINO is invalid` for anything it does not accept. So this module
 * checks exactly the published shape and no more: the old `[A-D]` suffix
 * restriction was ours, not HMRC's, and is dropped.
 *
 * The number is personal data under decision D5: it travels to the server
 * once, is stored encrypted beside the HMRC keys, and the only thing that
 * ever comes back is its ending ("ends 56 C"). Nothing here logs it.
 */

/** HMRC's published shape: `AA999999A`. */
export const NINO_RE = /^[A-Z]{2}[0-9]{6}[A-Z]$/;

/** Upper-case, spaces and hyphens removed — what a person types as
 *  "qq 12 34 56 c" is the same number. */
export function normaliseNino(raw: string): string {
  return String(raw ?? "").toUpperCase().replace(/[\s-]+/g, "");
}

export function isValidNino(raw: string): boolean {
  return NINO_RE.test(normaliseNino(raw));
}

/** The masked form the app and the portal show after entry: the last two
 *  digits and the final letter, "56 C". Never more. */
export function ninoEnding(nino: string): string {
  const n = normaliseNino(nino);
  if (!NINO_RE.test(n)) return "";
  return `${n.slice(6, 8)} ${n.slice(8)}`;
}

/** Crash-report and log scrubbing: anything shaped like a number (with or
 *  without spaces) becomes "[nino]". Used by the server's own error logging. */
export function scrubNino(text: string): string {
  return String(text ?? "").replace(/\b[A-Za-z]{2}\s?[0-9]{2}\s?[0-9]{2}\s?[0-9]{2}\s?[A-Za-z]\b/g, "[nino]");
}
