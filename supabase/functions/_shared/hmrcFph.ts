/**
 * hmrcFph.ts — the two fraud-prevention header sets SoleTax sends (plan E1 +
 * E2, built 2026-10-02 S230; the mobile builder moved here from
 * hmrc-submit/index.ts unchanged in substance so both sets are pinned by one
 * test, scripts/test-hmrc-server.ts).
 *
 * MOBILE_APP_VIA_SERVER (the app) — passed HMRC's evaluation 29 Sep 2026.
 * WEB_APP_VIA_SERVER (the portal) — HMRC's page read verbatim 2026-09-29
 * (register §H): 16 headers in its order: Connection-Method,
 * Browser-JS-User-Agent, Device-ID, Multi-Factor, Public-IP,
 * Public-IP-Timestamp, Public-Port, Screens, Timezone, User-IDs, Window-Size,
 * Vendor-Forwarded, Vendor-License-IDs, Vendor-Product-Name, Vendor-Public-IP,
 * Vendor-Version. NOT in the web set: Local-IPs (+ timestamp), MAC-Addresses,
 * the device User-Agent; change log v3.2: "For the web application via server
 * connection method, you do not need to submit a value for
 * Gov-Client-Browser-Do-Not-Track." Two headers are omitted in BOTH sets by
 * fact, accepted by HMRC's Fraud Prevention Header team 2026-09-09 ("please
 * omit the headers in future submissions") and re-declared for the browser
 * method by one email (plan E7): Gov-Client-Multi-Factor (single-factor
 * email-code sign-in) and Gov-Vendor-License-IDs (no licence keys exist).
 * The two sets are never mixed: a request declares its surface and gets
 * exactly that method's headers.
 *
 * The ingress envelope (S225) supplies the public IP, its timestamp, the port
 * and the "by" of hop 1 for BOTH methods — "Where multiple services manage
 * your intermediary servers, headers must contain data from all services."
 *
 * Pure module: DNS and the request object stay in the function; this takes
 * resolved values and returns the header record.
 */
import { encodeLocalIpsHeader } from "./ipScope.ts";

export type ConnectionMethod = "MOBILE_APP_VIA_SERVER" | "WEB_APP_VIA_SERVER";

export interface Ingress {
  clientIp: string; //   the device's public address as the ingress saw it → Gov-Client-Public-IP
  clientPort: number; // the device's public TCP source port              → Gov-Client-Public-Port
  receivedAt: string; // ISO ms, stamped by the ingress on receipt          → Gov-Client-Public-IP-Timestamp
  ingressIp: string; //  the address the ingress received the request on   → Gov-Vendor-Public-IP, hop 1 "by"
  peerIp: string; //     the ingress's egress address as Supabase saw it    → hop 2 "for"
}

/** Device-collected values the APP sends with every HMRC-bound request. */
export interface MobileDeviceFph {
  deviceId: string;
  timezone: string; // "UTC+01:00"
  localIps: string[];
  localIpsTimestamp: string;
  localIpsSource?: "interfaces" | "primary-ipv4" | "none";
  screen: { width: number; height: number; scalingFactor: number; colourDepth: number };
  window: { width: number; height: number };
  osFamily: string;
  osVersion: string;
  deviceManufacturer: string;
  deviceModel: string;
  appVersion: string;
}

/** Browser-collected values the PORTAL sends with every HMRC-bound request. */
export interface WebDeviceFph {
  deviceId: string; // generated once, kept in the browser; "The identifier should not expire"
  browserJsUserAgent: string; // "Pass the value as reported by the browser"
  timezone: string; // "UTC±<hh>:<mm>"
  screen: { width: number; height: number; scalingFactor: number; colourDepth: number };
  window: { width: number; height: number };
  webVersion: string; // the portal build, Gov-Vendor-Version's client half
}

export interface FphContext {
  uid: string;
  email: string; // the sign-in identifier — the spec's User-IDs "need to contain" value
  receivedAt: string; // stamped at request entry
  serverIp: string | null; // the project host's public A record (hop 2 "by")
  ingress: Ingress | null;
  directClientIp: string; // legacy direct path only (no ingress configured)
  vendorVersion: string;
}

const pe = encodeURIComponent; // spec: percent-encode keys+values, never separators
const TZ_RE = /^UTC[+-]\d{2}:\d{2}$/;

const positiveInt = (n: unknown) => typeof n === "number" && Number.isInteger(n) && n > 0;

/** What a browser must have collected before the server will build its set.
 *  Returns the field names that are missing or malformed (empty = fine). */
export function invalidWebFphFields(fph: Partial<WebDeviceFph> | null | undefined): string[] {
  const bad: string[] = [];
  if (!fph) return ["fph"];
  if (!fph.deviceId || typeof fph.deviceId !== "string") bad.push("deviceId");
  if (!fph.browserJsUserAgent || typeof fph.browserJsUserAgent !== "string") bad.push("browserJsUserAgent");
  if (!fph.timezone || !TZ_RE.test(fph.timezone)) bad.push("timezone");
  if (!fph.screen || !positiveInt(fph.screen.width) || !positiveInt(fph.screen.height)) bad.push("screen");
  if (fph.screen && (typeof fph.screen.scalingFactor !== "number" || !positiveInt(fph.screen.colourDepth))) bad.push("screen");
  if (!fph.window || !positiveInt(fph.window.width) || !positiveInt(fph.window.height)) bad.push("window");
  if (!fph.webVersion || typeof fph.webVersion !== "string") bad.push("webVersion");
  return [...new Set(bad)];
}

export function invalidMobileFphFields(fph: Partial<MobileDeviceFph> | null | undefined): string[] {
  const bad: string[] = [];
  if (!fph) return ["fph"];
  if (!fph.deviceId || typeof fph.deviceId !== "string") bad.push("deviceId");
  if (!fph.timezone || !TZ_RE.test(fph.timezone)) bad.push("timezone");
  if (!fph.screen || !positiveInt(fph.screen.width) || !positiveInt(fph.screen.height)) bad.push("screen");
  if (!fph.window || !positiveInt(fph.window.width) || !positiveInt(fph.window.height)) bad.push("window");
  for (const k of ["osFamily", "osVersion", "deviceManufacturer", "deviceModel", "appVersion"] as const) {
    if (!fph[k] || typeof fph[k] !== "string") bad.push(k);
  }
  return bad;
}

/** The public-network half shared by both methods. */
function publicHop(headers: Record<string, string>, ctx: FphContext): void {
  if (ctx.ingress) {
    // Via the ingress (S225) — the spec's via-server picture exactly:
    //   hop 1: the device → the ingress (by = the address the ingress received
    //          the request on = Gov-Vendor-Public-IP; for = the device)
    //   hop 2: the ingress → the Supabase edge over the internet (by = the
    //          project host's public A record; for = the ingress's egress
    //          address as Cloudflare reported it)
    // "Do not include hops within a private network." The gateway→runtime hop
    // is private and is not listed.
    headers["Gov-Client-Public-IP"] = ctx.ingress.clientIp;
    headers["Gov-Client-Public-IP-Timestamp"] = ctx.ingress.receivedAt;
    headers["Gov-Client-Public-Port"] = String(ctx.ingress.clientPort);
    headers["Gov-Vendor-Public-IP"] = ctx.ingress.ingressIp;
    headers["Gov-Vendor-Forwarded"] =
      `by=${pe(ctx.ingress.ingressIp)}&for=${pe(ctx.ingress.clientIp)},by=${ctx.serverIp ? pe(ctx.serverIp) : ""}&for=${pe(ctx.ingress.peerIp)}`;
  } else {
    // Legacy direct path (reachable only while no ingress is configured):
    // one hop, no port — the declared absence. Keys with no applicable value
    // stay present but empty; a fabricated IP never does.
    headers["Gov-Vendor-Forwarded"] = `by=${ctx.serverIp ? pe(ctx.serverIp) : ""}&for=${pe(ctx.directClientIp)}`;
    if (ctx.serverIp) headers["Gov-Vendor-Public-IP"] = ctx.serverIp;
    if (ctx.directClientIp) {
      headers["Gov-Client-Public-IP"] = ctx.directClientIp;
      headers["Gov-Client-Public-IP-Timestamp"] = ctx.receivedAt;
    }
  }
}

/** User-IDs: the spec's "need to contain" value is the SIGN-IN identifier
 *  (SoleTax signs in by email); the internal account id is the "should
 *  include" second value. */
function userIds(ctx: FphContext): string {
  return ctx.email ? `soletax=${pe(ctx.email)}&soletax-account=${pe(ctx.uid)}` : `soletax=${pe(ctx.uid)}`;
}

export function buildMobileFph(fph: MobileDeviceFph, ctx: FphContext): Record<string, string> {
  const headers: Record<string, string> = {
    "Gov-Client-Connection-Method": "MOBILE_APP_VIA_SERVER",
    "Gov-Client-Device-ID": fph.deviceId,
    "Gov-Client-Timezone": fph.timezone,
    "Gov-Client-Screens":
      `width=${fph.screen.width}&height=${fph.screen.height}&scaling-factor=${fph.screen.scalingFactor}&colour-depth=${fph.screen.colourDepth}`,
    "Gov-Client-Window-Size": `width=${fph.window.width}&height=${fph.window.height}`,
    "Gov-Client-User-Agent":
      `os-family=${pe(fph.osFamily)}&os-version=${pe(fph.osVersion)}&device-manufacturer=${pe(fph.deviceManufacturer)}&device-model=${pe(fph.deviceModel)}`,
    "Gov-Client-User-IDs": userIds(ctx),
    "Gov-Vendor-Version": `soletax-ios=${pe(fph.appVersion)}&soletax-server=${pe(ctx.vendorVersion)}`,
    "Gov-Vendor-Product-Name": pe("SoleTax"),
  };
  publicHop(headers, ctx);
  // Gov-Client-Local-IPs: the shared classifier at the one choke point —
  // local-scope addresses only; a device with none gets the header OMITTED,
  // never empty (list values "must not be empty").
  const localIps = encodeLocalIpsHeader(Array.isArray(fph.localIps) ? fph.localIps : []);
  if (localIps) {
    headers["Gov-Client-Local-IPs"] = localIps;
    headers["Gov-Client-Local-IPs-Timestamp"] = fph.localIpsTimestamp;
  }
  // Gov-Client-Multi-Factor and Gov-Vendor-License-IDs: omitted by fact,
  // accepted by HMRC 2026-09-09.
  return headers;
}

export function buildWebFph(fph: WebDeviceFph, ctx: FphContext): Record<string, string> {
  const headers: Record<string, string> = {
    "Gov-Client-Connection-Method": "WEB_APP_VIA_SERVER",
    // "JavaScript-reported user agent string from the originating device.
    // Pass the value as reported by the browser."
    "Gov-Client-Browser-JS-User-Agent": fph.browserJsUserAgent,
    "Gov-Client-Device-ID": fph.deviceId,
    "Gov-Client-Screens":
      `width=${fph.screen.width}&height=${fph.screen.height}&scaling-factor=${fph.screen.scalingFactor}&colour-depth=${fph.screen.colourDepth}`,
    "Gov-Client-Timezone": fph.timezone,
    "Gov-Client-User-IDs": userIds(ctx),
    "Gov-Client-Window-Size": `width=${fph.window.width}&height=${fph.window.height}`,
    "Gov-Vendor-Product-Name": pe("SoleTax"),
    "Gov-Vendor-Version": `soletax-web=${pe(fph.webVersion)}&soletax-server=${pe(ctx.vendorVersion)}`,
  };
  publicHop(headers, ctx);
  // Omitted by fact, as for the app: Gov-Client-Multi-Factor,
  // Gov-Vendor-License-IDs. Not in the web set at all: Gov-Client-Local-IPs,
  // Gov-Client-MAC-Addresses, Gov-Client-User-Agent; Do-Not-Track not needed
  // for this method (change log v3.2).
  return headers;
}

/** The header names each method sends when the ingress is present — the
 *  shape the tests pin and the evidence scripts eyeball. */
export const MOBILE_HEADER_NAMES = [
  "Gov-Client-Connection-Method", "Gov-Client-Device-ID", "Gov-Client-Timezone", "Gov-Client-Screens",
  "Gov-Client-Window-Size", "Gov-Client-User-Agent", "Gov-Client-User-IDs", "Gov-Vendor-Version",
  "Gov-Vendor-Product-Name", "Gov-Client-Public-IP", "Gov-Client-Public-IP-Timestamp", "Gov-Client-Public-Port",
  "Gov-Vendor-Public-IP", "Gov-Vendor-Forwarded", "Gov-Client-Local-IPs", "Gov-Client-Local-IPs-Timestamp",
] as const;

export const WEB_HEADER_NAMES = [
  "Gov-Client-Connection-Method", "Gov-Client-Browser-JS-User-Agent", "Gov-Client-Device-ID", "Gov-Client-Screens",
  "Gov-Client-Timezone", "Gov-Client-User-IDs", "Gov-Client-Window-Size", "Gov-Vendor-Product-Name", "Gov-Vendor-Version",
  "Gov-Client-Public-IP", "Gov-Client-Public-IP-Timestamp", "Gov-Client-Public-Port", "Gov-Vendor-Public-IP", "Gov-Vendor-Forwarded",
] as const;

/** Headers that must NEVER appear in the web set. */
export const WEB_FORBIDDEN_HEADERS = [
  "Gov-Client-Local-IPs", "Gov-Client-Local-IPs-Timestamp", "Gov-Client-MAC-Addresses", "Gov-Client-User-Agent",
  "Gov-Client-Browser-Do-Not-Track", "Gov-Client-Multi-Factor", "Gov-Vendor-License-IDs",
] as const;
