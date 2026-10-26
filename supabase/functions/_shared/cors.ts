/**
 * cors.ts — the shared exact-origin CORS layer for browser-called edge
 * functions (the web portal, S214). LOCKED POSTURE: the allowlist below is the
 * complete set of origins that may read responses — never `*`, never a
 * reflected arbitrary Origin, never a suffix match.
 *
 * CORS here is response-READABILITY, not auth: every function still requires
 * the caller's Supabase JWT, and RLS scopes all data. What this layer decides
 * is only which web origins a browser will hand the response bytes to.
 *
 * Usage — wrap the whole handler, exactly once:
 *
 *   import { withCors } from "../_shared/cors.ts";
 *   Deno.serve(withCors(async (req) => { ... }));
 *
 * The wrapper answers OPTIONS preflights itself and appends the CORS headers
 * to EVERY Response the handler returns (success, error, SSE stream), so no
 * individual `new Response(...)` call site can forget them. Non-browser
 * callers (the app, curl) and disallowed origins get no Access-Control grant.
 *
 * security/surface.ts notes this layer on each browser-called function;
 * scripts/test-portal-cors.ts is the CI keystone (wrapper present, allowlist
 * exact-origin); scripts/hmrc-pentest.mjs T-CO probes it live.
 */

/** The complete origin allowlist. Exact string match on the Origin header. */
export const ALLOWED_ORIGINS = [
  // The portal — the only production browser client.
  "https://<PORTAL_HOST>",
  // The portal dev server (Vite). Exact-origin, not a wildcard: useless
  // without a user JWT (CORS gates readability, the JWT gates the data), and
  // it keeps the local dev loop against real functions working.
  "http://localhost:5173",
  // The portal preview server (vite preview) — the documented QA-loop BASE
  // (portal-qa-shoot.mjs / the capture E2E). Same JWT-gated rationale.
  "http://localhost:4173",
  // The portal DEPLOY GATE preview (portal/scripts/portal-deploy-gate.mjs,
  // `vite preview --port 4521 --strictPort`, run in CI before every portal
  // deploy): its signed-in route sweep renders the Tax page, whose filing
  // status read calls hmrc-submit, so this origin must be granted or the
  // browser logs a CORS error and the gate fails (S230, 2026-10-02). Same
  // JWT-gated rationale as the two above. (No apostrophes in this comment:
  // test-portal-cors.ts reads the list with a quote-pair regex.)
  "http://localhost:4521",
] as const;

// The supabase.com/docs/guides/functions/cors recommended list (v2.112.3) —
// covers supabase-js functions.invoke as well as the portal's raw fetch.
const ALLOW_HEADERS =
  "authorization, x-client-info, apikey, content-type, x-retry-count, traceparent, tracestate, baggage";

/** The request's Origin if allowlisted, else null (exact match only). */
export function allowedOrigin(req: Request): string | null {
  const origin = req.headers.get("origin");
  return origin && (ALLOWED_ORIGINS as readonly string[]).includes(origin)
    ? origin
    : null;
}

/**
 * The OPTIONS preflight response, or null when the request is not a
 * preflight. Disallowed origins get the same 204 but WITHOUT the
 * Access-Control-* grant — the browser then blocks the real request.
 */
export function preflight(req: Request): Response | null {
  if (req.method !== "OPTIONS") return null;
  const origin = allowedOrigin(req);
  const headers: Record<string, string> = { Vary: "Origin" };
  if (origin) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Methods"] = "POST, OPTIONS";
    headers["Access-Control-Allow-Headers"] = ALLOW_HEADERS;
    headers["Access-Control-Max-Age"] = "86400";
  }
  return new Response(null, { status: 204, headers });
}

/**
 * Wrap a Deno.serve handler: answer preflights, then append the CORS headers
 * to whatever Response the handler returns. Rebuilding the Response around
 * the same body preserves streaming (SSE bodies pass through untouched).
 */
export function withCors(
  handler: (req: Request) => Response | Promise<Response>,
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const pre = preflight(req);
    if (pre) return pre;
    const res = await handler(req);
    const headers = new Headers(res.headers);
    // Caches must key on Origin or one origin's grant would leak to another.
    headers.append("Vary", "Origin");
    const origin = allowedOrigin(req);
    if (origin) headers.set("Access-Control-Allow-Origin", origin);
    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers,
    });
  };
}
