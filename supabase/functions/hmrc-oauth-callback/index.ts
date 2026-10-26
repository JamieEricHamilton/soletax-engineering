/**
 * hmrc-oauth-callback — the redirect target for the HMRC user-authorisation
 * flow (the token exchange needs the client secret, so it happens HERE,
 * never in a client). Hardened 2026-10-02 (S230, go-live plan A1 + E3).
 *
 * Deployed with --no-verify-jwt (HMRC's browser redirect carries no Supabase
 * JWT). Security model: the `state` parameter is an HMAC-SHA256-signed
 * envelope minted by hmrc-submit's `connect` action for a verified user —
 * unforgeable without HMRC_TOKEN_KEY, 10-minute expiry, and it binds the
 * resulting tokens to exactly that user id. Since 0.5.0 it also carries the
 * ENVIRONMENT the authorize URL was built for (sandbox | production) and the
 * SURFACE to return to (app | portal): the code is exchanged with the SAME
 * credentials and host, and the connection row is stamped with that
 * environment (A2 reads nothing else).
 *
 * On success the encrypted token pair is upserted to hmrc_connections (any
 * previously chosen business is cleared — ids differ between environments
 * and step 3 re-reads it; the National Insurance number stays, it is the
 * person's) and the browser is bounced back: the app via its deep link, the
 * portal to its Tax page with the same status vocabulary.
 */
import { createClient } from "npm:@supabase/supabase-js@2";
import { credentialsFor, type HmrcEnvironment } from "../_shared/hmrcEnv.ts";

const APP_RETURN = "soletax://hmrc-filing";
const PORTAL_URL = (Deno.env.get("PORTAL_URL") ?? "https://<PORTAL_HOST>").replace(/\/$/, "");
const PORTAL_RETURN_PATH = "/tax"; // the portal's Tax page reads ?hmrc=connected|denied|error

const b64 = {
  enc: (buf: ArrayBuffer | Uint8Array) =>
    btoa(String.fromCharCode(...new Uint8Array(buf instanceof Uint8Array ? buf : new Uint8Array(buf)))),
  dec: (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)),
};
const b64urlDec = (s: string) => b64.dec(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));

type State = { uid: string; env: HmrcEnvironment; surface: "app" | "portal" };

async function verifyState(state: string): Promise<State | null> {
  try {
    const [payloadB64, sigB64] = state.split(".");
    const raw = b64.dec(Deno.env.get("HMRC_TOKEN_KEY")!);
    const key = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    const payload = b64urlDec(payloadB64);
    const okSig = await crypto.subtle.verify("HMAC", key, b64urlDec(sigB64), payload);
    if (!okSig) return null;
    const { uid, exp, env, surface } = JSON.parse(new TextDecoder().decode(payload));
    if (!uid || Date.now() > exp) return null;
    // A state minted before 0.5.0 carries no env: it was built for the
    // sandbox (the only environment that existed), and the app.
    return { uid, env: env === "production" ? "production" : "sandbox", surface: surface === "portal" ? "portal" : "app" };
  } catch {
    return null;
  }
}

async function encrypt(plain: string): Promise<string> {
  const raw = b64.dec(Deno.env.get("HMRC_TOKEN_KEY")!);
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plain));
  const out = new Uint8Array(12 + ct.byteLength);
  out.set(iv);
  out.set(new Uint8Array(ct), 12);
  return b64.enc(out);
}

function bounce(surface: "app" | "portal", params: Record<string, string>): Response {
  const q = new URLSearchParams(surface === "portal" ? { hmrc: params.status, ...(params.reason ? { reason: params.reason } : {}) } : params);
  const url = surface === "portal" ? `${PORTAL_URL}${PORTAL_RETURN_PATH}?${q}` : `${APP_RETURN}?${q}`;
  // 302 back; the HTML fallback covers browsers that block the app scheme.
  return new Response(
    `<html><body><p>Returning to SoleTax… <a href="${url}">Tap here if nothing happens.</a></p></body></html>`,
    { status: 302, headers: { Location: url, "Content-Type": "text/html" } },
  );
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const stateRaw = url.searchParams.get("state") ?? "";
  const hmrcError = url.searchParams.get("error");

  const state = await verifyState(stateRaw);
  // "They said no on HMRC's screen" — still bounce to the right surface when
  // the state is readable; an unreadable state can only go to the app.
  if (hmrcError) return bounce(state?.surface ?? "app", { status: "denied" });
  if (!state || !code) return bounce(state?.surface ?? "app", { status: "error", reason: "bad_state" });

  const creds = credentialsFor(state.env, (name) => Deno.env.get(name));
  if (!creds.ok) {
    console.error(`hmrc callback: ${creds.code}`);
    return bounce(state.surface, { status: "error", reason: "not_configured" });
  }

  // No Gov- headers on this exchange, deliberately (FPH audit 2026-07-27): the
  // request reaching us is HMRC's browser redirect, so the device half of the
  // via-server profile does not exist at this hop. The refresh + API legs
  // (hmrc-submit) carry the full set.
  const r = await fetch(`${creds.credentials.api}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: creds.credentials.clientId,
      client_secret: creds.credentials.clientSecret,
      redirect_uri: `${Deno.env.get("SUPABASE_URL")}/functions/v1/hmrc-oauth-callback`,
    }),
  });
  const tok = await r.json().catch(() => ({}));
  if (!r.ok || !tok.access_token) {
    console.error(`hmrc token exchange failed for ${state.uid}: ${r.status}`);
    return bounce(state.surface, { status: "error", reason: "exchange_failed" });
  }

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { error } = await admin.from("hmrc_connections").upsert({
    user_id: state.uid,
    access_token_enc: await encrypt(tok.access_token),
    refresh_token_enc: await encrypt(tok.refresh_token ?? ""),
    expires_at: new Date(Date.now() + (tok.expires_in ?? 14400) * 1000).toISOString(),
    scope: tok.scope ?? null,
    environment: state.env,
    business_id: null,
    business_name: null,
    quarterly_period_type: null,
    commencement_date: null,
    cessation_date: null,
    refreshing_at: null,
    updated_at: new Date().toISOString(),
  });
  if (error) {
    console.error(`hmrc connection persist failed for ${state.uid}: ${error.message}`);
    return bounce(state.surface, { status: "error", reason: "persist_failed" });
  }
  return bounce(state.surface, { status: "connected" });
});
