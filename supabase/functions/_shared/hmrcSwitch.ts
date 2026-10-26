/**
 * hmrcSwitch.ts — whether filing is ON for a surface and an account (go-live
 * plan B14 + E6, spec §11, built 2026-10-02 S230).
 *
 * The server decides; the app and the portal ask. The rules, from the spec:
 *   - OFF is the default: no row, an error, an old cache all mean off. This
 *     is the opposite of the emergency stop (`hmrc_filing` remote flag),
 *     which fails open and cannot be the on switch.
 *   - `paused` is the server-side emergency stop and WINS over "on": card
 *     state 1, "Sending is paused".
 *   - `allow_list` (a list of account ids) limits filing to named accounts —
 *     kept for a rollback or a cautious re-start, never a launch stage
 *     (ruling S5: on for everyone on release day).
 *   - The app and the portal have separate rows, so one can be live without
 *     the other.
 *   - The server enforces it too: a send while filing is off is refused,
 *     whatever the client believed.
 *
 * Pure module; the rows live in `hmrc_filing_switch` (service role only).
 */

export type Surface = "app" | "portal";

export interface SwitchRow {
  surface: Surface;
  enabled: boolean;
  paused: boolean;
  allow_list: string[] | null;
}

export type SwitchState =
  | { on: true; reason: null }
  | { on: false; reason: "off" | "paused" | "not_allowed" };

export function evaluateSwitch(row: SwitchRow | null | undefined, uid: string): SwitchState {
  if (!row) return { on: false, reason: "off" };
  if (row.paused) return { on: false, reason: "paused" };
  if (!row.enabled) return { on: false, reason: "off" };
  if (Array.isArray(row.allow_list) && !row.allow_list.includes(uid)) return { on: false, reason: "not_allowed" };
  return { on: true, reason: null };
}

export function parseSurface(raw: unknown): Surface {
  return raw === "portal" ? "portal" : "app";
}
