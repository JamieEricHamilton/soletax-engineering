// serverEvents — the C4 audit writer (S218). One fire-and-forget insert into
// public.server_events (service-role-only; 90-day pg_cron retention). detail
// carries STATUS AND COUNTS ONLY — never raw content: no receipt text, no
// images, no chat, no record bodies. An audit failure must never break the
// request path, so this swallows everything.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

export async function logServerEvent(
  admin: SupabaseClient,
  event: {
    userId: string | null;
    source: string;
    kind: string;
    detail?: Record<string, unknown>;
  },
): Promise<void> {
  try {
    await admin.from("server_events").insert({
      user_id: event.userId,
      source: event.source,
      kind: event.kind,
      detail: event.detail ?? {},
    });
  } catch {
    // never let the audit break the request
  }
}
