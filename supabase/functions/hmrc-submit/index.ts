/**
 * hmrc-submit — the DIRECT FILING pipeline, hardened for production (go-live
 * plan phase 1, A1–A8; spec §11 the switch, §14 data; built 2026-10-02 S230).
 *
 * Connection methods: MOBILE_APP_VIA_SERVER for the app (passed HMRC's
 * fraud-prevention evaluation 29 Sep 2026) and WEB_APP_VIA_SERVER for the
 * portal (plan E1/E2, register §H 2026-09-29). The clients NEVER call HMRC:
 * this function holds the OAuth client secrets, the customer's HMRC tokens
 * and National Insurance number (AES-256-GCM, HMRC_TOKEN_KEY), and writes one
 * audit row per submission attempt to hmrc_submissions.
 *
 * What changed for production (each a pure rule in _shared/, pinned by
 * scripts/test-hmrc-server.ts):
 *   A1  environment per account (hmrcEnv): production by default once
 *       HMRC_PRODUCTION_ENABLED reads "true", sandbox for accounts marked in
 *       hmrc_account_modes; production credentials under _PROD names; a
 *       missing production secret REFUSES (never a silent sandbox fallback).
 *   A2  a stored connection must match the account's environment or the
 *       customer is asked to reconnect.
 *   A3  the National Insurance number is stored encrypted on the connection
 *       row (D5); production refuses every HMRC call without it; the
 *       HMRC_TEST_NINO fallback exists only in sandbox.
 *   A4  one refresh at a time per account (HMRC refresh tokens are
 *       single-use): a claim on hmrc_connections.refreshing_at; the losers
 *       wait for the winner's token.
 *   A5  validate + createTestBusiness are refused outside sandbox.
 *   A6  429s are retried with HMRC's Retry-After (hmrcFetch).
 *   A7  HMRC's codes map to the spec's copy (hmrcErrors); our-fault codes
 *       raise a server event.
 *   A8  security/surface.ts carries the new secrets, hosts and tables.
 *   B14/E6 the on switch: hmrc_filing_switch per surface, OFF by default,
 *       paused wins, enforced on every send.
 *   F-3 sends are rate-limited per account (hmrc_submit_turns).
 *
 * The HMRC ingress (S225) still fronts every HMRC-calling action: the
 * envelope (public IP, port, receipt time, the ingress's address) is REQUIRED
 * once HMRC_INGRESS_HOST is configured — 428 without it. The portal dials the
 * same host, so its browser header set carries the port too.
 *
 * Actions (POST, platform-verified JWT; `surface` = "app" | "portal"):
 *   status         → connection, business, filing switch, environment
 *   connect        → { authorizeUrl } (state = HMAC-bound uid + env + surface)
 *   disconnect     → forgets keys, number and business
 *   saveNino       → stores the number encrypted; returns its ending
 *   businesses     → HMRC's list (Business Details 2.0)
 *   selectBusiness → reads the business's details, stores the id + the
 *                    quarter type + the dates, returns any turnaway
 *   obligations    → HMRC's record of the year's quarters (Obligations 3.0)
 *   submit         → PUT the cumulative update (SEB 5.0); the receipt
 *   calculate      → HMRC's in-year estimate (Individual Calculations 8.0)
 *   validate       → sandbox only: grade this header set on HMRC's validator
 *   createTestBusiness → sandbox only: HMRC's test-support factory
 */
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { classifyIp, parseIp } from "../_shared/ipScope.ts";
import { withCors } from "../_shared/cors.ts";
import { logServerEvent } from "../_shared/serverEvents.ts";
import { admitTurn, DAY_MS, HOUR_MS } from "../_shared/rateLimit.ts";
import {
  connectionMatches, credentialsFor, type HmrcCredentials, type HmrcEnvironment, parseProductionEnabled,
  resolveEnvironment, SANDBOX_ONLY_ACTIONS,
} from "../_shared/hmrcEnv.ts";
import { isValidNino, ninoEnding, normaliseNino, scrubNino } from "../_shared/hmrcNino.ts";
import { COPY, hmrcCodeOf, type Outcome, outcomeForCode, turnawayOutcome } from "../_shared/hmrcErrors.ts";
import { hmrcFetch } from "../_shared/hmrcFetch.ts";
import { evaluateSwitch, parseSurface, type Surface, type SwitchRow } from "../_shared/hmrcSwitch.ts";
import {
  dueDateFor, invalidMoneyField, isStandardQuarterEnd, periodHasEnded, periodStartFor, TAX_YEAR_RE,
  taxYearFor, TURNOVER_LIMIT_GBP,
} from "../_shared/hmrcPeriod.ts";
import {
  buildMobileFph, buildWebFph, type FphContext, type Ingress, invalidMobileFphFields, invalidWebFphFields,
  type MobileDeviceFph, type WebDeviceFph,
} from "../_shared/hmrcFph.ts";

// Gov-Vendor-Version's server half — MUST move with every deploy of this
// function (FPH audit 2026-07-27 advisory: a frozen version reads as stale
// data to HMRC's manual review). Bump it in the same edit as any change here.
// 0.4.0 = the HMRC ingress envelope (Gov-Client-Public-Port collected).
// 0.5.0 = production hardening: per-account environment, the stored National
//         Insurance number, the browser (WEB_APP_VIA_SERVER) header set, the
//         on switch, 429 back-off, HMRC's codes mapped to copy.
// 0.5.1 = the portal deploy gate's preview origin admitted by CORS (no
//         behaviour change on any HMRC call).
// 0.5.2 = SANDBOX MODE made whole for a test-service account (the App Review
//         demo, the evidence legs, the integration walks): businesses and
//         sends always address HMRC's STATEFUL store; a test-service account
//         with no stateful self-employment gets one from the factory; and
//         because HMRC's Obligations 3.0 sandbox is NOT stateful (empirical
//         2026-07-08, re-proven 2026-10-02: NO_OBLIGATIONS_FOUND for a
//         created business under every scenario), obligations in sandbox are
//         HMRC's own CUMULATIVE simulation for the current tax year,
//         attributed to the chosen business. Production untouched.
// 0.5.3 = obligation statuses normalised to the contract's "Open" /
//         "Fulfilled" (Obligations 3.0 returns lowercase; every client was
//         built to the contract).
// 0.5.4 = sandbox: the business RETRIEVE (selectBusiness) addresses the
//         STATEFUL store like the list, so a test-service account whose test
//         user already holds a business is no longer turned away (the app's
//         simulator walk, S230).
const VENDOR_VERSION = "0.5.4";
const SCOPES = "read:self-assessment write:self-assessment";
const BUSINESS_ID_RE = /^X[A-Z0-9]{1}IS[0-9]{11}$/;
const PRODUCTION_ENABLED = parseProductionEnabled(Deno.env.get("HMRC_PRODUCTION_ENABLED"));
const HMRC_CALLING_ACTIONS = new Set(["validate", "businesses", "selectBusiness", "obligations", "submit", "calculate", "createTestBusiness"]);
// Sends per account: generous for a real quarter (a correction or two), tight
// against a loop (open item F-3).
const SUBMIT_WINDOWS = [{ scope: "hour" as const, ms: HOUR_MS, limit: 12 }, { scope: "day" as const, ms: DAY_MS, limit: 40 }];

const withTimeout = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error("dns timeout")), ms))]);

/** Public A/AAAA records of a hostname as a PUBLIC resolver sees them (1.1.1.1,
 *  then DNS-over-HTTPS) — the device's view, never the platform resolver's
 *  internal one (proven wrong on-platform 2026-07-27). [] on total failure. */
async function resolvePublic(host: string, types: ("A" | "AAAA")[]): Promise<string[]> {
  const out = new Set<string>();
  for (const type of types) {
    try {
      const records = await withTimeout(Deno.resolveDns(host, type, { nameServer: { ipAddr: "1.1.1.1" } }), 2000);
      for (const r of records) out.add(String(r));
    } catch { /* DoH below */ }
  }
  if (out.size === 0) {
    for (const type of types) {
      try {
        const r = await fetch(
          `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`,
          { headers: { Accept: "application/dns-json" }, signal: AbortSignal.timeout(3000) },
        );
        const j = await r.json();
        const want = type === "A" ? 1 : 28;
        for (const a of (j.Answer ?? []) as { type: number; data: string }[]) if (a.type === want) out.add(a.data);
      } catch { /* omit — never a wrong value */ }
    }
  }
  return [...out];
}

// ── the HMRC ingress envelope (S225) ──────────────────────────────────────────
const INGRESS_HOST = (Deno.env.get("HMRC_INGRESS_HOST") ?? "").trim();
const INGRESS_SECRET = Deno.env.get("HMRC_INGRESS_SECRET") ?? "";
const INGRESS_EGRESS_IPS = (Deno.env.get("HMRC_INGRESS_EGRESS_IPS") ?? "").split(",").map((s) => s.trim()).filter(Boolean);

function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

function sameIp(a: string, b: string): boolean {
  const pa = parseIp(a);
  const pb = parseIp(b);
  if (!pa || !pb || pa.family !== pb.family) return false;
  return pa.bytes.every((byte, i) => byte === pb.bytes[i]);
}

let ingressAddrCache: { addrs: string[]; at: number } | null = null;
async function ingressAddresses(): Promise<string[]> {
  if (ingressAddrCache && Date.now() - ingressAddrCache.at < 300_000) return ingressAddrCache.addrs;
  const resolved = await resolvePublic(INGRESS_HOST, ["A", "AAAA"]);
  const addrs = [...new Set([...INGRESS_EGRESS_IPS, ...resolved])];
  if (addrs.length) ingressAddrCache = { addrs, at: Date.now() };
  return addrs;
}

type IngressRead =
  | { ok: true; ingress: Ingress }
  | { ok: false; status: number; error: string; code: string };

async function readIngress(req: Request, fallbackReceivedAt: string): Promise<IngressRead> {
  if (!INGRESS_SECRET) return { ok: false, status: 500, error: "ingress secret not configured", code: "INGRESS_MISCONFIGURED" };
  const presented = req.headers.get("x-soletax-ingress-secret") ?? "";
  if (!presented || !timingSafeEqual(presented, INGRESS_SECRET)) {
    return { ok: false, status: 428, error: "ingress required", code: "INGRESS_REQUIRED" };
  }
  const clientIp = (req.headers.get("x-soletax-client-ip") ?? "").trim();
  const clientPort = Number(req.headers.get("x-soletax-client-port"));
  const ingressIp = (req.headers.get("x-soletax-ingress-ip") ?? "").trim();
  const receivedMs = Number(req.headers.get("x-soletax-received-at"));
  const peerIp = req.headers.get("cf-connecting-ip")?.trim() ||
    (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim();
  const bad = (what: string): IngressRead => ({ ok: false, status: 400, error: `ingress envelope: ${what}`, code: "INGRESS_ENVELOPE" });
  if (classifyIp(clientIp) !== "public") return bad("client ip");
  if (!Number.isInteger(clientPort) || clientPort < 1 || clientPort > 65535 || clientPort === 80 || clientPort === 443) {
    return bad("client port");
  }
  if (classifyIp(ingressIp) !== "public") return bad("ingress ip");
  const allowed = await ingressAddresses();
  if (!allowed.some((a) => sameIp(a, peerIp))) {
    return { ok: false, status: 403, error: "ingress origin mismatch", code: "INGRESS_ORIGIN" };
  }
  const skewOk = Number.isFinite(receivedMs) && Math.abs(Date.now() - receivedMs) < 300_000;
  const receivedAt = skewOk ? new Date(receivedMs).toISOString() : fallbackReceivedAt;
  return { ok: true, ingress: { clientIp, clientPort, receivedAt, ingressIp, peerIp } };
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

// ── crypto: AES-256-GCM for tokens + the number, HMAC-SHA256 for OAuth state ─

const b64 = {
  enc: (buf: ArrayBuffer | Uint8Array) =>
    btoa(String.fromCharCode(...new Uint8Array(buf instanceof Uint8Array ? buf : new Uint8Array(buf)))),
  dec: (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)),
};
const b64url = {
  enc: (buf: ArrayBuffer | Uint8Array) => b64.enc(buf).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
};

async function aesKey(): Promise<CryptoKey> {
  const raw = b64.dec(Deno.env.get("HMRC_TOKEN_KEY")!);
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function encrypt(plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(), new TextEncoder().encode(plain));
  const out = new Uint8Array(12 + ct.byteLength);
  out.set(iv);
  out.set(new Uint8Array(ct), 12);
  return b64.enc(out);
}

async function decrypt(enc: string): Promise<string> {
  const buf = b64.dec(enc);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf.slice(0, 12) }, await aesKey(), buf.slice(12));
  return new TextDecoder().decode(pt);
}

async function hmacKey(): Promise<CryptoKey> {
  const raw = b64.dec(Deno.env.get("HMRC_TOKEN_KEY")!);
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

/** The OAuth state: uid-bound, 10-minute expiry, and since 0.5.0 it carries
 *  the environment the authorize URL was built for and the surface to return
 *  to — the callback must exchange the code with the SAME credentials. */
export async function signState(uid: string, env: HmrcEnvironment, surface: Surface): Promise<string> {
  const payload = new TextEncoder().encode(JSON.stringify({ uid, exp: Date.now() + 600_000, n: crypto.randomUUID(), env, surface }));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(), payload);
  return `${b64url.enc(payload)}.${b64url.enc(sig)}`;
}

// ── the project host's public address (hop 2 "by") ────────────────────────────
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;
let projectHostIpCache: string | null = null;
async function projectHostIp(): Promise<string | null> {
  if (projectHostIpCache) return projectHostIpCache;
  const projectUrl = Deno.env.get("SUPABASE_URL");
  if (!projectUrl) return null;
  const host = new URL(projectUrl).hostname;
  if (IPV4_RE.test(host)) return (projectHostIpCache = host);
  const [a] = await resolvePublic(host, ["A"]);
  if (a && IPV4_RE.test(a)) return (projectHostIpCache = a);
  return null;
}

// ── connection + token lifecycle ──────────────────────────────────────────────

type Connection = {
  user_id: string;
  access_token_enc: string;
  refresh_token_enc: string;
  expires_at: string;
  environment: string;
  nino_enc: string | null;
  business_id: string | null;
  business_name: string | null;
  quarterly_period_type: string | null;
  commencement_date: string | null;
  cessation_date: string | null;
  refreshing_at: string | null;
};

const tokenFresh = (c: Connection) => new Date(c.expires_at).getTime() - Date.now() > 120_000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

class HmrcError extends Error {
  constructor(public code: string, message: string, public detail?: unknown) {
    super(message);
  }
}

/** A4: one refresh per account at a time. The winner claims
 *  `refreshing_at`, rotates the pair and clears the claim; everyone else
 *  waits for the fresh token to appear on the row. A stale claim (older than
 *  20s, a crashed refresh) can be taken over. */
async function freshAccessToken(
  admin: SupabaseClient,
  conn: Connection,
  creds: HmrcCredentials,
  govHeaders: Record<string, string>, // FPH on the token refresh too — the legal duty covers "all associated APIs and endpoints"
): Promise<string> {
  if (tokenFresh(conn)) return decrypt(conn.access_token_enc);
  const cutoff = new Date(Date.now() - 20_000).toISOString();
  const { data: claimed } = await admin.from("hmrc_connections")
    .update({ refreshing_at: new Date().toISOString() })
    .eq("user_id", conn.user_id)
    .or(`refreshing_at.is.null,refreshing_at.lt.${cutoff}`)
    .select("user_id");
  if (claimed && claimed.length) {
    try {
      const r = await hmrcFetch(`${creds.api}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", ...govHeaders },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: await decrypt(conn.refresh_token_enc),
          client_id: creds.clientId,
          client_secret: creds.clientSecret,
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.access_token) {
        // invalid_grant = the refresh token is spent or withdrawn (or HMRC's
        // 18-month limit): reconnect. Anything else is HMRC being unwell.
        if (r.status === 429 || r.status >= 500) throw new HmrcError("BUSY", "hmrc token endpoint busy", { status: r.status });
        throw new HmrcError("RECONNECT", "hmrc reconnect required", { status: r.status, error: data?.error });
      }
      const { error } = await admin.from("hmrc_connections").update({
        access_token_enc: await encrypt(data.access_token),
        refresh_token_enc: await encrypt(data.refresh_token ?? ""),
        expires_at: new Date(Date.now() + (data.expires_in ?? 14400) * 1000).toISOString(),
        refreshing_at: null,
        updated_at: new Date().toISOString(),
      }).eq("user_id", conn.user_id);
      if (error) throw new HmrcError("INTERNAL", `token persist failed: ${error.message}`);
      return data.access_token;
    } catch (e) {
      await admin.from("hmrc_connections").update({ refreshing_at: null }).eq("user_id", conn.user_id);
      throw e;
    }
  }
  // Someone else holds the claim: wait for their token.
  for (let i = 0; i < 25; i++) {
    await sleep(300);
    const { data: row } = await admin.from("hmrc_connections").select("*").eq("user_id", conn.user_id).maybeSingle();
    const c = row as Connection | null;
    if (!c) throw new HmrcError("RECONNECT", "hmrc reconnect required");
    if (tokenFresh(c)) return decrypt(c.access_token_enc);
    if (!c.refreshing_at) break; // the other refresh ended without a fresh token
  }
  throw new HmrcError("BUSY", "token refresh did not complete");
}

// ── per-request context ───────────────────────────────────────────────────────

interface Ctx {
  admin: SupabaseClient;
  uid: string;
  email: string;
  surface: Surface;
  environment: HmrcEnvironment;
  creds: HmrcCredentials;
  receivedAt: string;
  todayIso: string;
  ingress: Ingress | null;
  req: Request;
  body: Record<string, unknown>;
}

async function loadConnection(ctx: Ctx): Promise<Connection | null> {
  const { data } = await ctx.admin.from("hmrc_connections").select("*").eq("user_id", ctx.uid).maybeSingle();
  return (data as Connection) ?? null;
}

/** A2: a usable connection, in the account's environment. */
function requireConnection(ctx: Ctx, c: Connection | null): Response | null {
  if (!c) return json({ error: "not connected", code: "RECONNECT" }, 409);
  if (!connectionMatches(c.environment, ctx.environment)) {
    return json({ error: "connection belongs to another environment", code: "RECONNECT", reason: "environment" }, 409);
  }
  return null;
}

/** A3: the number the HMRC URL is keyed on. Production: the stored number
 *  only. Sandbox: stored → a valid body override (the evidence scripts) →
 *  HMRC_TEST_NINO. */
async function resolveNino(ctx: Ctx, c: Connection): Promise<string | null> {
  const stored = c.nino_enc ? normaliseNino(await decrypt(c.nino_enc)) : null;
  if (stored && isValidNino(stored)) return stored;
  if (ctx.environment !== "sandbox") return null;
  const bodyNino = typeof ctx.body.nino === "string" ? normaliseNino(ctx.body.nino) : "";
  if (bodyNino && isValidNino(bodyNino)) return bodyNino;
  const test = normaliseNino(Deno.env.get("HMRC_TEST_NINO") ?? "");
  return test && isValidNino(test) ? test : null;
}

/** The fraud-prevention set for the caller's surface; 400 names any missing
 *  browser or device field so the client can fix its collection. */
async function buildHeaders(ctx: Ctx): Promise<{ headers: Record<string, string> } | { response: Response }> {
  const fphCtx: FphContext = {
    uid: ctx.uid,
    email: ctx.email,
    receivedAt: ctx.receivedAt,
    serverIp: await projectHostIp(),
    ingress: ctx.ingress,
    directClientIp: ctx.req.headers.get("cf-connecting-ip")?.trim() ||
      (ctx.req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim(),
    vendorVersion: VENDOR_VERSION,
  };
  const fph = ctx.body.fph as Partial<MobileDeviceFph & WebDeviceFph> | undefined;
  if (ctx.surface === "portal") {
    const bad = invalidWebFphFields(fph as Partial<WebDeviceFph>);
    if (bad.length) return { response: json({ error: "fph payload invalid", code: "FPH_INVALID", fields: bad }, 400) };
    return { headers: buildWebFph(fph as WebDeviceFph, fphCtx) };
  }
  const bad = invalidMobileFphFields(fph as Partial<MobileDeviceFph>);
  if (bad.length) return { response: json({ error: "fph payload invalid", code: "FPH_INVALID", fields: bad }, 400) };
  return { headers: buildMobileFph(fph as MobileDeviceFph, fphCtx) };
}

async function switchRow(ctx: Ctx): Promise<SwitchRow | null> {
  const { data } = await ctx.admin.from("hmrc_filing_switch").select("surface, enabled, paused, allow_list").eq("surface", ctx.surface).maybeSingle();
  return (data as SwitchRow) ?? null;
}

const connectionMethodFor = (surface: Surface) => surface === "portal" ? "WEB_APP_VIA_SERVER" : "MOBILE_APP_VIA_SERVER";

/** What the client shows for a stored business that cannot file. */
function storedTurnaway(c: Connection, todayIso: string): Outcome | null {
  if (c.cessation_date && c.cessation_date <= todayIso) return turnawayOutcome("ceased", "BUSINESS_CEASED");
  if (c.quarterly_period_type === "calendar") return turnawayOutcome("calendar_quarters", "CALENDAR_QUARTERS");
  return null;
}

function publicBusiness(c: Connection) {
  return c.business_id
    ? {
      id: c.business_id,
      name: c.business_name,
      quarterlyPeriodType: c.quarterly_period_type,
      commencementDate: c.commencement_date,
      cessationDate: c.cessation_date,
    }
    : null;
}

/** HMRC's refusal → the HTTP answer the client branches on: 422 with the
 *  outcome for a refusal HMRC made, 502 when HMRC is busy. Our-fault codes
 *  page us. */
async function hmrcFailure(ctx: Ctx, where: string, status: number, body: unknown): Promise<Response> {
  const outcome = outcomeForCode(hmrcCodeOf(status, body));
  if (outcome.alert) {
    console.error(scrubNino(`hmrc-submit ${where}: our fault ${outcome.code} (${status}) ${JSON.stringify(body ?? {}).slice(0, 300)}`));
    await logServerEvent(ctx.admin, {
      userId: ctx.uid,
      source: "hmrc-submit",
      kind: "our_fault",
      detail: { where, code: outcome.code, status, surface: ctx.surface, environment: ctx.environment },
    });
  }
  return json({ error: outcome.kind === "busy" ? "hmrc busy" : "hmrc refused", outcome, hmrcStatus: status }, outcome.kind === "busy" ? 502 : 422);
}

type BusinessDetails = {
  businessId: string;
  typeOfBusiness: string;
  tradingName: string | null;
  quarterlyPeriodType: string | null;
  commencementDate: string | null;
  cessationDate: string | null;
};

async function fetchBusinessDetails(ctx: Ctx, nino: string, businessId: string, access: string, govHeaders: Record<string, string>): Promise<{ ok: true; business: BusinessDetails } | { ok: false; status: number; body: unknown }> {
  const r = await hmrcFetch(`${ctx.creds.api}/individuals/business/details/${nino}/${businessId}`, {
    headers: {
      Accept: "application/vnd.hmrc.2.0+json",
      Authorization: `Bearer ${access}`,
      ...govHeaders,
      // Sandbox (0.5.4): the RETRIEVE must address the same STATEFUL store the
      // list does, or a test-service account's own business comes back as
      // HMRC's canned 404 — the "not signed up" turnaway (the app walk, S230).
      ...(ctx.environment === "sandbox" ? { "Gov-Test-Scenario": "STATEFUL" } : {}),
    },
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: false, status: r.status, body: data };
  return {
    ok: true,
    business: {
      businessId: data.businessId ?? businessId,
      typeOfBusiness: data.typeOfBusiness ?? "",
      tradingName: data.tradingName ?? null,
      quarterlyPeriodType: data.quarterlyTypeChoice?.quarterlyPeriodType ?? null,
      commencementDate: data.commencementDate ?? null,
      cessationDate: data.cessationDate ?? null,
    },
  };
}

/**
 * Sandbox only: HMRC's Self Assessment Test Support API — a stateful
 * self-employment business + MTD Mandated status for the tax year, stored as
 * the chosen business so a test-service account's screens read like a
 * customer's. Used by `createTestBusiness` and, since 0.5.2, by `businesses`
 * when a test-service account has nothing in the stateful store.
 */
async function createSandboxBusiness(
  ctx: Ctx,
  nino: string,
  access: string,
  taxYear: string,
  fphHeaders: Record<string, string>,
): Promise<{ ok: true; businessId: string } | { ok: false; stage: "create" | "status"; status: number; detail: unknown; businessId?: string }> {
  const [yy] = taxYear.split("-");
  const tsHeaders = { Accept: "application/vnd.hmrc.1.0+json", "Content-Type": "application/json", Authorization: `Bearer ${access}`, ...fphHeaders };
  const created = await hmrcFetch(`${ctx.creds.api}/individuals/self-assessment-test-support/business/${nino}`, {
    method: "POST",
    headers: tsHeaders,
    body: JSON.stringify({
      typeOfBusiness: "self-employment",
      tradingType: "Electrical work",
      tradingName: "SoleTax Demo Electrical",
      firstAccountingPeriodStartDate: `${yy}-04-06`,
      firstAccountingPeriodEndDate: `${Number(yy) + 1}-04-05`,
      accountingType: "CASH",
      quarterlyTypeChoice: { quarterlyPeriodType: "standard", taxYearOfChoice: taxYear },
      businessAddressLineOne: "1 Demo Way",
      businessAddressLineTwo: "St Albans",
      businessAddressPostcode: "AL1 1AA",
      businessAddressCountryCode: "GB",
    }),
  });
  const cData = await created.json().catch(() => ({}));
  if (created.status !== 201 || !cData?.businessId) return { ok: false, stage: "create", status: created.status, detail: cData };
  const status = await hmrcFetch(`${ctx.creds.api}/individuals/self-assessment-test-support/itsa-status/${nino}/${taxYear}`, {
    method: "POST",
    headers: tsHeaders,
    body: JSON.stringify({
      itsaStatusDetails: [{
        submittedOn: new Date().toISOString().replace(/\.\d{3}Z$/, ".000Z"),
        status: "MTD Mandated",
        statusReason: "Sign up - return available",
      }],
    }),
  });
  if (status.status !== 204) {
    const sData = await status.json().catch(() => ({}));
    return { ok: false, stage: "status", status: status.status, detail: sData, businessId: cData.businessId };
  }
  await storeBusiness(ctx, {
    businessId: cData.businessId, typeOfBusiness: "self-employment", tradingName: "SoleTax Demo Electrical",
    quarterlyPeriodType: "standard", commencementDate: `${yy}-04-06`, cessationDate: null,
  });
  return { ok: true, businessId: cData.businessId };
}

async function storeBusiness(ctx: Ctx, b: BusinessDetails): Promise<void> {
  await ctx.admin.from("hmrc_connections").update({
    business_id: b.businessId,
    business_name: b.tradingName,
    quarterly_period_type: b.quarterlyPeriodType,
    commencement_date: b.commencementDate,
    cessation_date: b.cessationDate,
    updated_at: new Date().toISOString(),
  }).eq("user_id", ctx.uid);
}

// ── the handler ───────────────────────────────────────────────────────────────

async function handle(req: Request): Promise<Response> {
  // Gov-Client-Public-IP-Timestamp's fallback source — collected the moment the
  // backend receives the client request (the spec's collection point).
  const receivedAt = new Date().toISOString();
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
  const uid = userData?.user?.id;
  const email = userData?.user?.email ?? "";
  if (userErr || !uid) return json({ error: "unauthorised" }, 401);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad request" }, 400);
  }
  const action = String(body.action ?? "");
  const surface = parseSurface(body.surface);

  // A1: the account's environment, then the credentials for it — refused
  // outright when production is enabled and its secrets are missing.
  const { data: modeRow } = await admin.from("hmrc_account_modes").select("mode").eq("user_id", uid).maybeSingle();
  const environment = resolveEnvironment({ productionEnabled: PRODUCTION_ENABLED, accountMode: modeRow?.mode === "sandbox" ? "sandbox" : null });
  const credsRead = credentialsFor(environment, (name) => Deno.env.get(name));
  if (!credsRead.ok) {
    console.error(`hmrc-submit ${action}: ${credsRead.code} (${credsRead.missing.join(", ")})`);
    return json({ error: "hmrc not configured", code: credsRead.code }, 503);
  }
  const creds = credsRead.credentials;

  // A5: the sandbox-only tools do not exist in production.
  if (SANDBOX_ONLY_ACTIONS.has(action) && environment !== "sandbox") {
    return json({ error: "sandbox only", code: "SANDBOX_ONLY" }, 400);
  }

  // The HMRC ingress envelope (S225): REQUIRED for every action that calls
  // HMRC once HMRC_INGRESS_HOST is configured.
  let ingress: Ingress | null = null;
  if (INGRESS_HOST && HMRC_CALLING_ACTIONS.has(action)) {
    const read = await readIngress(req, receivedAt);
    if (!read.ok) return json({ error: read.error, code: read.code }, read.status);
    ingress = read.ingress;
  }

  const ctx: Ctx = { admin, uid, email, surface, environment, creds, receivedAt, todayIso: receivedAt.slice(0, 10), ingress, req, body };

  try {
    switch (action) {
      case "status": {
        const c = await loadConnection(ctx);
        const sw = evaluateSwitch(await switchRow(ctx), uid);
        if (!c) return json({ connected: false, environment, productionEnabled: PRODUCTION_ENABLED, filing: sw, ninoEnding: null, business: null, turnaway: null });
        const matches = connectionMatches(c.environment, environment);
        const ending = c.nino_enc ? ninoEnding(await decrypt(c.nino_enc)) : null;
        return json({
          connected: matches,
          reconnect: matches ? null : "environment",
          environment,
          productionEnabled: PRODUCTION_ENABLED,
          expiresAt: c.expires_at,
          connectedAt: (c as unknown as { connected_at?: string }).connected_at ?? null,
          ninoEnding: ending || null,
          business: publicBusiness(c),
          turnaway: storedTurnaway(c, ctx.todayIso),
          filing: sw,
        });
      }

      case "connect": {
        const state = await signState(uid, environment, surface);
        const redirect = `${Deno.env.get("SUPABASE_URL")}/functions/v1/hmrc-oauth-callback`;
        const url = new URL(creds.authorize);
        url.search = new URLSearchParams({
          response_type: "code",
          client_id: creds.clientId,
          scope: SCOPES,
          state,
          redirect_uri: redirect,
        }).toString();
        return json({ authorizeUrl: url.toString(), environment });
      }

      case "disconnect": {
        // Keys, the number and the business go together (spec §8); the audit
        // trail of sent updates stays — it is the customer's record.
        await admin.from("hmrc_connections").delete().eq("user_id", uid);
        await logServerEvent(admin, { userId: uid, source: "hmrc-submit", kind: "disconnected", detail: { surface, environment } });
        return json({ connected: false });
      }

      case "saveNino": {
        // Spec step 2. The shape check is HMRC's published format (hmrcNino);
        // HMRC itself answers FORMAT_NINO / CLIENT_OR_AGENT_NOT_AUTHORISED for
        // a number it cannot match, at the next call.
        const raw = typeof body.nino === "string" ? body.nino : "";
        const nino = normaliseNino(raw);
        if (!isValidNino(nino)) {
          return json({ error: "That doesn't look right. It's two letters, six numbers and a letter.", code: "NINO_FORMAT" }, 400);
        }
        const c = await loadConnection(ctx);
        const refused = requireConnection(ctx, c);
        if (refused) return refused;
        const { error } = await admin.from("hmrc_connections").update({
          nino_enc: await encrypt(nino),
          // A new number means a fresh business lookup.
          business_id: null, business_name: null, quarterly_period_type: null, commencement_date: null, cessation_date: null,
          updated_at: new Date().toISOString(),
        }).eq("user_id", uid);
        if (error) throw new HmrcError("INTERNAL", `nino persist failed: ${error.message}`);
        return json({ saved: true, ninoEnding: ninoEnding(nino) });
      }

      case "validate": {
        // Sandbox only (A5, checked above): grade this EXACT header set on
        // HMRC's Test Fraud Prevention Headers API. Echoes the built set.
        const built = await buildHeaders(ctx);
        if ("response" in built) return built.response;
        const govHeaders = built.headers;
        const t = await hmrcFetch(`${creds.api}/oauth/token`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", ...govHeaders },
          body: new URLSearchParams({ grant_type: "client_credentials", client_id: creds.clientId, client_secret: creds.clientSecret }),
        });
        const tok = await t.json().catch(() => ({}));
        if (!tok.access_token) return json({ error: "app token failed", detail: tok }, 502);
        const r = await hmrcFetch(`${creds.api}/test/fraud-prevention-headers/validate`, {
          headers: { Accept: "application/vnd.hmrc.1.0+json", Authorization: `Bearer ${tok.access_token}`, ...govHeaders },
        });
        const fph = body.fph as Partial<MobileDeviceFph> | undefined;
        return json(
          {
            status: r.status,
            headersSent: govHeaders,
            connectionMethod: connectionMethodFor(surface),
            localIpsSource: fph?.localIpsSource ?? null,
            ingress: ingress
              ? { via: INGRESS_HOST, clientPort: ingress.clientPort, ingressIp: ingress.ingressIp, peerIp: ingress.peerIp }
              : { via: null, required: Boolean(INGRESS_HOST) },
            ...(await r.json().catch(() => ({}))),
          },
          r.ok ? 200 : 502,
        );
      }

      case "businesses": {
        const built = await buildHeaders(ctx);
        if ("response" in built) return built.response;
        const c = await loadConnection(ctx);
        const refused = requireConnection(ctx, c);
        if (refused) return refused;
        const nino = await resolveNino(ctx, c!);
        if (!nino) return json({ error: "national insurance number required", code: "NINO_REQUIRED" }, 409);
        const access = await freshAccessToken(admin, c!, creds, built.headers);
        const listBusinesses = async () => {
          const r = await hmrcFetch(`${creds.api}/individuals/business/details/${nino}/list`, {
            headers: {
              Accept: "application/vnd.hmrc.2.0+json",
              Authorization: `Bearer ${access}`,
              ...built.headers,
              // Sandbox (0.5.2): a test-service account's businesses live in
              // HMRC's STATEFUL store; the canned list is "Company X", ceased
              // in 2019, which turned every fresh sandbox account away.
              ...(environment === "sandbox" ? { "Gov-Test-Scenario": "STATEFUL" } : {}),
            },
          });
          const data = await r.json().catch(() => ({}));
          if (!r.ok) return { ok: false as const, status: r.status, data };
          const businesses = ((data.listOfBusinesses ?? []) as Record<string, unknown>[]).map((b) => ({
            businessId: b.businessId,
            typeOfBusiness: b.typeOfBusiness,
            tradingName: b.tradingName ?? null,
            tradingType: b.tradingType ?? null,
          }));
          return { ok: true as const, businesses };
        };
        let listed = await listBusinesses();
        if (!listed.ok) return hmrcFailure(ctx, "businesses", listed.status, listed.data);
        let businesses = listed.businesses;
        let selfEmployments = businesses.filter((b) => b.typeOfBusiness === "self-employment");
        if (environment === "sandbox" && !selfEmployments.length) {
          // A test-service account with nothing in the stateful store (a fresh
          // demo account, or one whose test business HMRC purged after 7 days):
          // make one, so the screens read like a customer's. Sandbox only.
          const made = await createSandboxBusiness(ctx, nino, access, taxYearFor(ctx.todayIso), built.headers);
          if (!made.ok) return json({ error: "test business create failed", stage: made.stage, status: made.status, detail: made.detail }, 502);
          listed = await listBusinesses();
          if (!listed.ok) return hmrcFailure(ctx, "businesses", listed.status, listed.data);
          businesses = listed.businesses;
          selfEmployments = businesses.filter((b) => b.typeOfBusiness === "self-employment");
        }
        return json({
          businesses,
          // Spec step 3: property-only is a turnaway before anything is chosen.
          turnaway: businesses.length && !selfEmployments.length ? turnawayOutcome("property_only", "NOT_SELF_EMPLOYMENT") : null,
        });
      }

      case "selectBusiness": {
        // Spec step 3 + the calendar-quarters check (plan §4 ⚠): the RETRIEVE
        // call carries the quarter type and the dates; the list does not.
        const businessId = String(body.businessId ?? "");
        if (!BUSINESS_ID_RE.test(businessId)) return json({ error: "invalid businessId format", code: "BUSINESS_ID_FORMAT" }, 400);
        const built = await buildHeaders(ctx);
        if ("response" in built) return built.response;
        const c = await loadConnection(ctx);
        const refused = requireConnection(ctx, c);
        if (refused) return refused;
        const nino = await resolveNino(ctx, c!);
        if (!nino) return json({ error: "national insurance number required", code: "NINO_REQUIRED" }, 409);
        const access = await freshAccessToken(admin, c!, creds, built.headers);
        const read = await fetchBusinessDetails(ctx, nino, businessId, access, built.headers);
        if (!read.ok) return hmrcFailure(ctx, "selectBusiness", read.status, read.body);
        if (read.business.typeOfBusiness !== "self-employment") {
          return json({ error: "not a self-employment", code: "NOT_SELF_EMPLOYMENT", outcome: turnawayOutcome("property_only", "NOT_SELF_EMPLOYMENT") }, 409);
        }
        await storeBusiness(ctx, read.business);
        const stored = await loadConnection(ctx);
        return json({ business: publicBusiness(stored!), turnaway: storedTurnaway(stored!, ctx.todayIso) });
      }

      case "obligations": {
        // HMRC's record of the year's quarterly obligations (Obligations 3.0).
        // The fulfilled/open status is HMRC's own: a quarter filed through
        // previous software arrives as Fulfilled; nobody marks one by hand.
        const built = await buildHeaders(ctx);
        if ("response" in built) return built.response;
        const c = await loadConnection(ctx);
        const refused = requireConnection(ctx, c);
        if (refused) return refused;
        const nino = await resolveNino(ctx, c!);
        if (!nino) return json({ error: "national insurance number required", code: "NINO_REQUIRED" }, 409);
        const businessId = c!.business_id ?? (typeof body.businessId === "string" ? body.businessId : undefined);
        if (businessId && !BUSINESS_ID_RE.test(businessId)) return json({ error: "invalid businessId format", code: "BUSINESS_ID_FORMAT" }, 400);
        const access = await freshAccessToken(admin, c!, creds, built.headers);
        // SANDBOX (0.5.2): HMRC's Obligations 3.0 sandbox is NOT stateful — a
        // business created through the test-support API has no obligations
        // under any scenario (NO_OBLIGATIONS_FOUND; empirical 2026-07-08,
        // re-proven 2026-10-02, register §H). Its documented CUMULATIVE
        // scenario returns the current tax year's four cumulative periods, all
        // open, for HMRC's canned business XBIS12345678901 (OAS 3.0 test-data
        // table). A test-service account therefore reads that simulation,
        // unfiltered, and the self-employment group is attributed to the
        // business it chose, so the screens read like a customer's. A send
        // still goes to the stateful store, so a sent quarter stays "open"
        // here: the honest "sent, HMRC not showing it yet" state. Production
        // reads HMRC's record for the chosen business, unaltered.
        const sandboxSim = environment === "sandbox";
        const query = !sandboxSim && businessId ? `?typeOfBusiness=self-employment&businessId=${businessId}` : "";
        const r = await hmrcFetch(`${creds.api}/obligations/details/${nino}/income-and-expenditure${query}`, {
          headers: {
            Accept: "application/vnd.hmrc.3.0+json",
            Authorization: `Bearer ${access}`,
            ...built.headers,
            ...(sandboxSim ? { "Gov-Test-Scenario": "CUMULATIVE" } : {}),
          },
        });
        const data = await r.json().catch(() => ({}));
        if (r.status === 404 && data?.code === "NO_OBLIGATIONS_FOUND") return json({ obligations: [] });
        if (!r.ok) return hmrcFailure(ctx, "obligations", r.status, data);
        type Group = { businessId?: string; typeOfBusiness?: string; obligationDetails?: Record<string, unknown>[] };
        const groups = (data.obligations ?? []) as Group[];
        const kept = sandboxSim ? groups.filter((g) => g.typeOfBusiness === "self-employment").slice(0, 1) : groups;
        // The contract's status values are "Open" | "Fulfilled"; Obligations
        // 3.0's enum is lowercase `open` / `fulfilled` (OAS, read 2026-10-02).
        // Normalised HERE, once, so every client reads the contract.
        const normaliseStatus = (s: unknown) => {
          const v = String(s ?? "").toLowerCase();
          return v === "fulfilled" ? "Fulfilled" : v === "open" ? "Open" : String(s ?? "");
        };
        const obligations = kept.flatMap((g) =>
          (g.obligationDetails ?? []).map((o) => ({
            ...o,
            status: normaliseStatus(o.status),
            businessId: sandboxSim && businessId ? businessId : (g.businessId ?? o.businessId),
          }))
        );
        return json({ obligations, ...(sandboxSim ? { simulation: "CUMULATIVE" } : {}) });
      }

      case "submit": {
        // The switch first (spec §11: enforced on the server whatever the
        // client believed), then the figures, then HMRC.
        const sw = evaluateSwitch(await switchRow(ctx), uid);
        if (!sw.on) return json({ error: "filing is off", code: "FILING_OFF", reason: sw.reason }, 403);

        const { taxYear, periodEnd, periodIncome, periodExpenses, acknowledged } = body as {
          taxYear?: string; periodEnd?: string;
          periodIncome?: Record<string, unknown>; periodExpenses?: Record<string, unknown>; acknowledged?: boolean;
        };
        if (!taxYear || !TAX_YEAR_RE.test(taxYear)) return json({ error: "invalid taxYear", code: "TAX_YEAR_FORMAT" }, 400);
        if (!periodEnd || !isStandardQuarterEnd(taxYear, periodEnd)) {
          return json({ error: "periodEnd must be a standard quarter end", code: "PERIOD_END_INVALID" }, 400);
        }
        if (!periodHasEnded(periodEnd, ctx.todayIso)) return json({ error: "the quarter has not ended", code: "TOO_EARLY" }, 400);
        if (acknowledged !== true) return json({ error: "acknowledgement required", code: "ACKNOWLEDGEMENT_REQUIRED" }, 400);
        // HMRC: "Submissions must include values for income and expenses, even
        // if the values are zero." Under £90,000 the one consolidated total.
        const income = { turnover: periodIncome?.turnover, other: periodIncome?.other ?? 0 };
        const expenses = { consolidatedExpenses: periodExpenses?.consolidatedExpenses };
        const badField = invalidMoneyField({ ...income, ...expenses } as Record<string, unknown>);
        if (badField) return json({ error: `invalid figure: ${badField}`, code: "FIGURES_INVALID", field: badField }, 400);
        // D3: turnover at or over the threshold is turned away — HMRC needs
        // every cost under its own heading from there, which we do not send.
        if ((income.turnover as number) >= TURNOVER_LIMIT_GBP) {
          return json({ error: "turnover limit", code: "TURNOVER_LIMIT", outcome: turnawayOutcome("turnover_limit", "TURNOVER_LIMIT") }, 409);
        }

        const built = await buildHeaders(ctx);
        if ("response" in built) return built.response;
        const c = await loadConnection(ctx);
        const refused = requireConnection(ctx, c);
        if (refused) return refused;
        const nino = await resolveNino(ctx, c!);
        if (!nino) return json({ error: "national insurance number required", code: "NINO_REQUIRED" }, 409);
        const businessId = c!.business_id ?? (environment === "sandbox" && typeof body.businessId === "string" ? body.businessId : null);
        if (!businessId || !BUSINESS_ID_RE.test(businessId)) return json({ error: "business required", code: "BUSINESS_REQUIRED" }, 409);
        const stored = storedTurnaway(c!, ctx.todayIso);
        if (stored) return json({ error: "cannot file for this business", code: stored.code, outcome: stored }, 409);

        const limited = await admitTurn(admin, "hmrc_submit_turns", uid, SUBMIT_WINDOWS);
        if (limited) return json({ error: "too many sends", code: "RATE_LIMITED", scope: limited }, 429);

        const access = await freshAccessToken(admin, c!, creds, built.headers);
        let commencement = c!.commencement_date;
        const putOnce = async (periodStart: string) => {
          const payload = {
            periodDates: { periodStartDate: periodStart, periodEndDate: periodEnd },
            periodIncome: income,
            periodExpenses: expenses,
          };
          const r = await hmrcFetch(
            `${creds.api}/individuals/business/self-employment/${nino}/${businessId}/cumulative/${taxYear}`,
            {
              method: "PUT",
              headers: {
                Accept: "application/vnd.hmrc.5.0+json",
                "Content-Type": "application/json",
                Authorization: `Bearer ${access}`,
                ...built.headers,
                // A test-service account's business exists only in HMRC's
                // stateful store (0.5.2; `statefulTest` is implied there).
                ...(environment === "sandbox" ? { "Gov-Test-Scenario": "STATEFUL" } : {}),
              },
              body: JSON.stringify(payload),
            },
          );
          const errBody = r.ok ? null : await r.json().catch(() => null);
          return { r, payload, errBody, periodStart };
        };

        let attempt = await putOnce(periodStartFor(taxYear, commencement));
        if (!attempt.r.ok && hmrcCodeOf(attempt.r.status, attempt.errBody) === "RULE_START_DATE_NOT_ALIGNED_TO_COMMENCEMENT_DATE") {
          // Spec §10: re-read HMRC's commencement date and retry exactly once.
          const read = await fetchBusinessDetails(ctx, nino, businessId, access, built.headers);
          if (read.ok && read.business.commencementDate && read.business.commencementDate !== commencement) {
            await storeBusiness(ctx, read.business);
            commencement = read.business.commencementDate;
            attempt = await putOnce(periodStartFor(taxYear, commencement));
          }
        }
        const { r, payload, errBody, periodStart } = attempt;
        const correlationId = r.headers.get("x-correlationid");
        const outcome = r.ok ? null : outcomeForCode(hmrcCodeOf(r.status, errBody));

        // The audit row — success or failure, every attempt is recorded.
        const { data: audit, error: auditErr } = await admin.from("hmrc_submissions").insert({
          user_id: uid,
          environment,
          surface,
          connection_method: connectionMethodFor(surface),
          business_id: businessId,
          tax_year: taxYear,
          period_start: periodStart,
          period_end: periodEnd,
          payload,
          http_status: r.status,
          correlation_id: correlationId,
          error: errBody,
          outcome_kind: outcome?.kind ?? "sent",
          outcome_code: outcome?.code ?? null,
        }).select("id, created_at").single();
        if (auditErr) console.error(`audit insert failed for ${uid}: ${auditErr.message}`);

        if (!r.ok) return hmrcFailure(ctx, "submit", r.status, errBody);
        await logServerEvent(admin, { userId: uid, source: "hmrc-submit", kind: "sent", detail: { surface, environment, taxYear, periodEnd } });
        return json({
          submitted: true,
          receipt: {
            submissionId: audit?.id ?? null,
            submittedAt: audit?.created_at ?? new Date().toISOString(),
            correlationId,
            businessId,
            taxYear,
            periodStart,
            periodEnd,
            dueDate: dueDateFor(periodEnd),
            environment,
            surface,
          },
        });
      }

      case "calculate": {
        // Individual Calculations (MTD) 8.0 — HMRC's own in-year projection,
        // shown with the accuracy disclaimer HMRC's standards require, apart
        // from SoleTax's own estimate.
        const { taxYear } = body as { taxYear?: string };
        if (!taxYear || !TAX_YEAR_RE.test(taxYear)) return json({ error: "invalid taxYear", code: "TAX_YEAR_FORMAT" }, 400);
        const built = await buildHeaders(ctx);
        if ("response" in built) return built.response;
        const c = await loadConnection(ctx);
        const refused = requireConnection(ctx, c);
        if (refused) return refused;
        const nino = await resolveNino(ctx, c!);
        if (!nino) return json({ error: "national insurance number required", code: "NINO_REQUIRED" }, 409);
        const access = await freshAccessToken(admin, c!, creds, built.headers);

        const trig = await hmrcFetch(
          `${creds.api}/individuals/calculations/${nino}/self-assessment/${taxYear}/trigger/in-year`,
          { method: "POST", headers: { Accept: "application/vnd.hmrc.8.0+json", Authorization: `Bearer ${access}`, ...built.headers } },
        );
        const trigData = await trig.json().catch(() => ({}));
        const calculationId = trigData?.calculationId ?? trig.headers.get("location")?.split("/").pop();
        if (!trig.ok || !calculationId) return hmrcFailure(ctx, "calculate.trigger", trig.status, trigData);

        let calc: Record<string, unknown> | null = null;
        for (let i = 0; i < 6; i++) {
          await sleep(1500);
          const g = await hmrcFetch(
            `${creds.api}/individuals/calculations/${nino}/self-assessment/${taxYear}/${calculationId}`,
            { headers: { Accept: "application/vnd.hmrc.8.0+json", Authorization: `Bearer ${access}`, ...built.headers } },
          );
          if (g.status === 200) { calc = await g.json().catch(() => null); break; }
          if (g.status !== 404) return hmrcFailure(ctx, "calculate.retrieve", g.status, await g.json().catch(() => null));
        }
        if (!calc) return json({ error: "calculation not ready", code: "CALC_NOT_READY", calculationId, outcome: outcomeForCode("RULE_CALCULATION_IN_PROGRESS") }, 504);

        const c2 = (calc as { calculation?: Record<string, Record<string, unknown>> }).calculation ?? {};
        const eoy = (c2.endOfYearEstimate ?? {}) as Record<string, number>;
        const tc = (c2.taxCalculation ?? {}) as Record<string, number>;
        const meta = (calc as { metadata?: Record<string, unknown> }).metadata ?? {};
        return json({
          calculated: true,
          estimate: {
            calculationId,
            calculationTimestamp: meta.calculationTimestamp ?? null,
            taxYear,
            environment,
            incomeTaxNicAmount: eoy.incomeTaxNicAmount ?? null,
            incomeTaxAmount: eoy.incomeTaxAmount ?? null,
            totalNicAmount: eoy.totalNicAmount ?? null,
            totalEstimatedIncome: eoy.totalEstimatedIncome ?? null,
            totalTaxableIncome: eoy.totalTaxableIncome ?? null,
            totalIncomeTaxAndNicsDue: tc.totalIncomeTaxAndNicsDue ?? null,
          },
        });
      }

      case "createTestBusiness": {
        // Sandbox only (A5): HMRC's Self Assessment Test Support API — a
        // stateful self-employment business + MTD Mandated status for the
        // evidence legs and the App Review demo account.
        const { taxYear } = body as { taxYear?: string };
        if (!taxYear || !TAX_YEAR_RE.test(taxYear)) return json({ error: "invalid taxYear", code: "TAX_YEAR_FORMAT" }, 400);
        const built = await buildHeaders(ctx);
        if ("response" in built) return built.response;
        const c = await loadConnection(ctx);
        const refused = requireConnection(ctx, c);
        if (refused) return refused;
        const nino = await resolveNino(ctx, c!);
        if (!nino) return json({ error: "national insurance number required", code: "NINO_REQUIRED" }, 409);
        const access = await freshAccessToken(admin, c!, creds, built.headers);
        const made = await createSandboxBusiness(ctx, nino, access, taxYear, built.headers);
        if (!made.ok) return json({ error: made.stage === "create" ? "test business create failed" : "itsa status set failed", stage: made.stage, status: made.status, detail: made.detail, businessId: made.businessId }, 502);
        return json({ created: true, businessId: made.businessId, taxYear, environment });
      }

      default:
        return json({ error: "unknown action" }, 400);
    }
  } catch (e) {
    const err = e as HmrcError;
    if (err.code === "RECONNECT") return json({ error: "hmrc reconnect required", code: "RECONNECT", outcome: outcomeForCode("RECONNECT") }, 409);
    if (err.code === "BUSY") return json({ error: "hmrc busy", code: "BUSY", outcome: outcomeForCode("HTTP_5XX") }, 502);
    if (err.name === "TimeoutError" || err.name === "AbortError" || /timeout|network/i.test(err.message ?? "")) {
      // A send may have reached HMRC: the audit trail and HMRC's obligations
      // are the truth; the client reads them before offering another send.
      console.error(scrubNino(`hmrc-submit ${action}: unconfirmed (${err.message})`));
      return json({ error: "unconfirmed", code: "UNCONFIRMED", message: COPY.unconfirmed }, 502);
    }
    console.error(scrubNino(`hmrc-submit ${action}: ${err.message}`));
    return json({ error: "internal" }, 500);
  }
}

Deno.serve(withCors(handle));
