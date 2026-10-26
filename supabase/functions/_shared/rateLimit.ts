/**
 * Per-user AI-cost cap shared by the Claude-calling Edge Functions
 * (claude-extract, support-agent, claude-import-map) — security_plan §"Abuse / rate limiting",
 * closed 2026-07-07 (S123, caps ratified by Jamie: extraction 100/day +
 * 500/month; support 100 messages/day).
 *
 * Each function already logs every accepted call to a service-role-only
 * counter table ((user_id, created_at) indexed, no retention job — rows live
 * until account deletion, so a 30-day window is always countable). This
 * helper counts the caller's rows over each window in parallel, and either
 * returns the first exceeded window's scope (caller replies 429) or records
 * the new turn and returns null.
 *
 * Windows are ROLLING (last 60 min / 24 h / 30 d), not calendar buckets — no
 * timezone edge cases, and the counter can't be gamed by bursting either side
 * of midnight. Count-then-insert is not atomic; a concurrent burst can
 * overshoot a limit by a handful of calls, which is immaterial for a cost cap
 * (each call is ~£0.003). A failed count (DB error) fails OPEN, matching the
 * pre-existing hourly check — availability over strictness for an abuse
 * backstop.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

export interface RateWindow {
  scope: "hour" | "day" | "month";
  ms: number;
  limit: number;
}

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;
export const MONTH_MS = 30 * DAY_MS;

// Checks every window, then records the turn if all pass. Returns the scope
// of the first exceeded window (tightest window first as passed by the
// caller), or null when the call is admitted.
export async function admitTurn(
  admin: SupabaseClient,
  table: "extract_turns" | "support_turns" | "import_turns" | "send_invoice_turns" | "handoff_turns" | "hmrc_submit_turns",
  userId: string,
  windows: RateWindow[],
): Promise<RateWindow["scope"] | null> {
  const now = Date.now();
  const counts = await Promise.all(
    windows.map(async (w) => {
      const since = new Date(now - w.ms).toISOString();
      const { count } = await admin
        .from(table)
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .gte("created_at", since);
      return count ?? 0;
    }),
  );
  for (let i = 0; i < windows.length; i++) {
    if (counts[i] >= windows[i].limit) return windows[i].scope;
  }
  await admin.from(table).insert({ user_id: userId });
  return null;
}
