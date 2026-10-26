/**
 * hmrcEnv.ts — which HMRC environment an account files against, and the
 * credentials for it (go-live plan A1 + A2, decision D2, built 2026-10-02 S230).
 *
 * D2 (Jamie, 29 Sep 2026): "one server function, production by default,
 * sandbox only for accounts we mark on the server". Two belts on top of it:
 *
 *   1. PRODUCTION IS OFF until the server says so. `HMRC_PRODUCTION_ENABLED`
 *      must read exactly "true" (or "1"/"on"); unset, blank or anything else
 *      keeps EVERY account on HMRC's test service — the pre-go-live shape the
 *      weekly evidence sweep depends on. Phase 1 deploys with it unset.
 *   2. Production NEVER silently falls back to sandbox. If production is
 *      enabled and its credentials are missing, the call is refused with
 *      PRODUCTION_NOT_CONFIGURED (plan §8 risk 1: "A customer believes they
 *      filed when the update went to sandbox" — the environment is chosen
 *      here, once, and stamped on every receipt).
 *
 * Addresses are HMRC's own (authorisation docs + reference guide, register §H
 * 2026-09-29): production APIs "https://api.service.hmrc.gov.uk", production
 * sign-in "https://www.tax.service.gov.uk"; the sandbox pair is the
 * test-api / test-www twin the pipeline has used since S130.
 *
 * Secret names: the sandbox pair keeps its historical names (the CI evidence
 * sweep and the Mac scripts read them); production gets `_PROD` twins. The
 * client secret is "the equivalent of a password" (HMRC) — it lives only in
 * Supabase secrets, never in a binary, never in a log.
 *
 * Pure module: no Deno globals at import time, so `scripts/test-hmrc-server.ts`
 * pins it under tsx the way test-ip-scope.ts pins ipScope.ts.
 */

export type HmrcEnvironment = "sandbox" | "production";
export type AccountMode = "sandbox" | null;

export const HMRC_HOSTS: Record<HmrcEnvironment, { api: string; authorize: string }> = {
  sandbox: {
    api: "https://test-api.service.hmrc.gov.uk",
    authorize: "https://test-www.tax.service.gov.uk/oauth/authorize",
  },
  production: {
    api: "https://api.service.hmrc.gov.uk",
    authorize: "https://www.tax.service.gov.uk/oauth/authorize",
  },
};

export const SECRET_NAMES: Record<HmrcEnvironment, { clientId: string; clientSecret: string; baseUrl: string; authUrl: string }> = {
  sandbox: { clientId: "HMRC_CLIENT_ID", clientSecret: "HMRC_CLIENT_SECRET", baseUrl: "HMRC_BASE_URL", authUrl: "HMRC_AUTH_URL" },
  production: { clientId: "HMRC_CLIENT_ID_PROD", clientSecret: "HMRC_CLIENT_SECRET_PROD", baseUrl: "HMRC_BASE_URL_PROD", authUrl: "HMRC_AUTH_URL_PROD" },
};

/** The production master switch: exactly "true" / "1" / "on" (trimmed, any case). */
export function parseProductionEnabled(raw: string | undefined | null): boolean {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "true" || v === "1" || v === "on";
}

/** D2: production by default once enabled; a server-marked account stays on
 *  the test service; nobody reaches production while the switch is off. */
export function resolveEnvironment(input: { productionEnabled: boolean; accountMode: AccountMode }): HmrcEnvironment {
  if (!input.productionEnabled) return "sandbox";
  return input.accountMode === "sandbox" ? "sandbox" : "production";
}

export interface HmrcCredentials {
  environment: HmrcEnvironment;
  clientId: string;
  clientSecret: string;
  api: string;
  authorize: string;
}

export type CredentialsResult =
  | { ok: true; credentials: HmrcCredentials }
  | { ok: false; code: "PRODUCTION_NOT_CONFIGURED" | "SANDBOX_NOT_CONFIGURED"; missing: string[] };

/** The credential set for an environment, read through `getEnv` so the
 *  function passes Deno.env.get and the tests pass a map. Base URLs default
 *  to HMRC's published hosts; the id and secret never default. */
export function credentialsFor(environment: HmrcEnvironment, getEnv: (name: string) => string | undefined): CredentialsResult {
  const names = SECRET_NAMES[environment];
  const clientId = (getEnv(names.clientId) ?? "").trim();
  const clientSecret = (getEnv(names.clientSecret) ?? "").trim();
  const missing: string[] = [];
  if (!clientId) missing.push(names.clientId);
  if (!clientSecret) missing.push(names.clientSecret);
  if (missing.length) {
    return { ok: false, code: environment === "production" ? "PRODUCTION_NOT_CONFIGURED" : "SANDBOX_NOT_CONFIGURED", missing };
  }
  const api = (getEnv(names.baseUrl) ?? "").trim() || HMRC_HOSTS[environment].api;
  const authorize = (getEnv(names.authUrl) ?? "").trim() || HMRC_HOSTS[environment].authorize;
  return { ok: true, credentials: { environment, clientId, clientSecret, api, authorize } };
}

/** A2: a stored connection is only usable in the environment its keys came
 *  from. Anything else asks the customer to reconnect. */
export function connectionMatches(storedEnvironment: string | null | undefined, environment: HmrcEnvironment): boolean {
  return storedEnvironment === environment;
}

/** The sandbox-only tools (A5): HMRC's header validator and the test-support
 *  business factory do not exist in production and are refused there. */
export const SANDBOX_ONLY_ACTIONS: ReadonlySet<string> = new Set(["validate", "createTestBusiness"]);
