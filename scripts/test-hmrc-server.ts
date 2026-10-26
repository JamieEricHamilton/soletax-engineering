/**
 * test-hmrc-server.ts — the filing server's pure rules, pinned (go-live plan
 * phase 1 "proof it is closed", built 2026-10-02 S230; in `npm run test:tax`).
 *
 * What it pins, module by module under supabase/functions/_shared/:
 *   hmrcEnv     — A1/A2: production is OFF unless the switch reads "true";
 *                 a marked account never reaches production; an unmarked one
 *                 never reaches sandbox once production is on; missing
 *                 production credentials REFUSE, never fall back; a stored
 *                 connection only matches its own environment.
 *   hmrcNino    — A3: HMRC's published shape `AA999999A`, normalisation,
 *                 the masked ending, the log scrubber.
 *   hmrcErrors  — A7: every code in spec §10 maps to its copy; unknown
 *                 FORMAT_/RULE_ codes are ours (alert), unknown others "busy";
 *                 HMRC's nested `errors[]` wins over the top-level code.
 *   hmrcFetch   — A6: a 429 is retried with HMRC's Retry-After when sent,
 *                 a doubling delay otherwise, capped, then handed back.
 *   hmrcSwitch  — B14/E6: off by default; paused wins; allow-lists.
 *   hmrcPeriod  — spec §6: cumulative from 6 April or the commencement date,
 *                 standard quarter ends, "one month and 2 days", the
 *                 money-field rules from SEB 5.0.
 *   hmrcFph     — E1/E2: the mobile set is byte-for-byte what passed HMRC's
 *                 evaluation; the web set carries exactly HMRC's 16 less the
 *                 two agreed omissions and none of the device headers; the
 *                 two are never mixed.
 */
import {
  connectionMatches, credentialsFor, parseProductionEnabled, resolveEnvironment, SANDBOX_ONLY_ACTIONS,
} from "../supabase/functions/_shared/hmrcEnv.ts";
import { isValidNino, ninoEnding, normaliseNino, scrubNino } from "../supabase/functions/_shared/hmrcNino.ts";
import { COPY, hmrcCodeOf, outcomeFor, outcomeForCode, TURNAWAYS } from "../supabase/functions/_shared/hmrcErrors.ts";
import { hmrcFetch, retryDelayMs } from "../supabase/functions/_shared/hmrcFetch.ts";
import { evaluateSwitch, parseSurface } from "../supabase/functions/_shared/hmrcSwitch.ts";
import {
  dueDateFor, invalidMoneyField, isStandardQuarterEnd, periodHasEnded, periodStartFor, quarterNumber,
  standardQuarterEnds, taxYearEnd, taxYearFor, taxYearStart, TURNOVER_LIMIT_GBP,
} from "../supabase/functions/_shared/hmrcPeriod.ts";
import { VAT_REGISTRATION_THRESHOLD } from "../src/tax/rates-2026-27";
import {
  buildMobileFph, buildWebFph, invalidMobileFphFields, invalidWebFphFields, MOBILE_HEADER_NAMES,
  WEB_FORBIDDEN_HEADERS, WEB_HEADER_NAMES,
} from "../supabase/functions/_shared/hmrcFph.ts";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) pass++;
  else {
    fail++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// ── hmrcEnv ───────────────────────────────────────────────────────────────────
console.log("hmrcEnv");
check("switch off → unset", parseProductionEnabled(undefined) === false);
check("switch off → blank", parseProductionEnabled("  ") === false);
check("switch off → 'yes' is not on", parseProductionEnabled("yes") === false);
check("switch on → 'true'", parseProductionEnabled("true") === true);
check("switch on → ' TRUE '", parseProductionEnabled(" TRUE ") === true);
check("switch on → '1'", parseProductionEnabled("1") === true);
check("off: unmarked account → sandbox", resolveEnvironment({ productionEnabled: false, accountMode: null }) === "sandbox");
check("off: marked account → sandbox", resolveEnvironment({ productionEnabled: false, accountMode: "sandbox" }) === "sandbox");
check("on: unmarked account → production", resolveEnvironment({ productionEnabled: true, accountMode: null }) === "production");
check("on: marked account → sandbox", resolveEnvironment({ productionEnabled: true, accountMode: "sandbox" }) === "sandbox");
const env = (m: Record<string, string>) => (k: string) => m[k];
const sandboxOnly = env({ HMRC_CLIENT_ID: "id", HMRC_CLIENT_SECRET: "sec" });
const prodToo = env({ HMRC_CLIENT_ID: "id", HMRC_CLIENT_SECRET: "sec", HMRC_CLIENT_ID_PROD: "pid", HMRC_CLIENT_SECRET_PROD: "psec" });
const sb = credentialsFor("sandbox", sandboxOnly);
check("sandbox creds resolve", sb.ok && sb.credentials.clientId === "id" && sb.credentials.api === "https://test-api.service.hmrc.gov.uk");
check("sandbox authorize is the test host", sb.ok && sb.credentials.authorize === "https://test-www.tax.service.gov.uk/oauth/authorize");
const pMissing = credentialsFor("production", sandboxOnly);
check("production without its secrets REFUSES", !pMissing.ok && pMissing.code === "PRODUCTION_NOT_CONFIGURED");
check("…and names both missing secrets", !pMissing.ok && eq(pMissing.missing, ["HMRC_CLIENT_ID_PROD", "HMRC_CLIENT_SECRET_PROD"]));
const p = credentialsFor("production", prodToo);
check("production creds resolve to HMRC's live hosts", p.ok && p.credentials.clientId === "pid" && p.credentials.api === "https://api.service.hmrc.gov.uk" && p.credentials.authorize === "https://www.tax.service.gov.uk/oauth/authorize");
const sbOverride = credentialsFor("sandbox", env({ HMRC_CLIENT_ID: "id", HMRC_CLIENT_SECRET: "sec", HMRC_BASE_URL: "https://test-api.service.hmrc.gov.uk/" }));
check("sandbox base URL secret still honoured", sbOverride.ok && sbOverride.credentials.api === "https://test-api.service.hmrc.gov.uk/");
check("connection matches its own environment", connectionMatches("sandbox", "sandbox") && connectionMatches("production", "production"));
check("sandbox connection under a production account is a mismatch", !connectionMatches("sandbox", "production"));
check("missing environment is a mismatch", !connectionMatches(null, "production") && !connectionMatches(undefined, "sandbox"));
check("validate + createTestBusiness are sandbox-only", SANDBOX_ONLY_ACTIONS.has("validate") && SANDBOX_ONLY_ACTIONS.has("createTestBusiness") && !SANDBOX_ONLY_ACTIONS.has("submit"));

// ── hmrcNino ──────────────────────────────────────────────────────────────────
console.log("hmrcNino");
check("HMRC's example TC663795B is valid", isValidNino("TC663795B"));
check("lower case + spaces normalise", normaliseNino("qq 12 34 56 c") === "QQ123456C" && isValidNino("qq 12 34 56 c"));
check("hyphens normalise", normaliseNino("QQ-123456-C") === "QQ123456C");
check("suffix E is HMRC's shape (no [A-D] of ours)", isValidNino("AB123456E"));
check("seven digits invalid", !isValidNino("AB1234567C"));
check("one letter prefix invalid", !isValidNino("A1234567C"));
check("empty invalid", !isValidNino("") && !isValidNino("   "));
check("ending is '56 C'", ninoEnding("QQ 12 34 56 C") === "56 C");
check("ending of an invalid number is empty", ninoEnding("nope") === "");
check("scrubber masks spaced and unspaced numbers", scrubNino("saved QQ123456C and AB 12 34 56 C ok") === "saved [nino] and [nino] ok");
check("scrubber leaves a business id alone", scrubNino("XAIS12345678901") === "XAIS12345678901");

// ── hmrcErrors ────────────────────────────────────────────────────────────────
console.log("hmrcErrors");
const o = outcomeForCode;
check("CLIENT_OR_AGENT_NOT_AUTHORISED → the number-mismatch line", o("CLIENT_OR_AGENT_NOT_AUTHORISED").kind === "refusal" && o("CLIENT_OR_AGENT_NOT_AUTHORISED").message === COPY.ninoMismatch);
check("MATCHING_RESOURCE_NOT_FOUND → not signed up", o("MATCHING_RESOURCE_NOT_FOUND").turnaway?.id === "not_signed_up");
check("NO_BUSINESS_FOUND → not signed up", o("NO_BUSINESS_FOUND").turnaway?.id === "not_signed_up");
check("NO_OBLIGATIONS_FOUND → nothing due", o("NO_OBLIGATIONS_FOUND").kind === "nothing_due");
check("…CANNOT_MOVE_BACKWARDS → covered by a later update", o("RULE_SUBMISSION_END_DATE_CANNOT_MOVE_BACKWARDS").kind === "covered" && o("RULE_SUBMISSION_END_DATE_CANNOT_MOVE_BACKWARDS").message === COPY.coveredByLater);
check("OUTSIDE_AMENDMENT_WINDOW → period closed", o("RULE_OUTSIDE_AMENDMENT_WINDOW").message === COPY.periodClosed);
check("END_DATE_NOT_ALIGNED_WITH_REPORTING_TYPE → calendar quarters", o("RULE_END_DATE_NOT_ALIGNED_WITH_REPORTING_TYPE").turnaway?.id === "calendar_quarters");
check("START_DATE_NOT_ALIGNED_WITH_REPORTING_TYPE → calendar quarters", o("RULE_START_DATE_NOT_ALIGNED_WITH_REPORTING_TYPE").turnaway?.id === "calendar_quarters");
check("START_AND_END_DATE_NOT_ALLOWED → annual", o("RULE_START_AND_END_DATE_NOT_ALLOWED").turnaway?.id === "annual");
check("START_DATE_NOT_ALIGNED_TO_COMMENCEMENT_DATE → ours, alerted", o("RULE_START_DATE_NOT_ALIGNED_TO_COMMENCEMENT_DATE").kind === "our_fault" && o("RULE_START_DATE_NOT_ALIGNED_TO_COMMENCEMENT_DATE").alert);
check("INSOLVENT_TRADER → insolvent turnaway", o("RULE_INSOLVENT_TRADER").turnaway?.id === "insolvent");
check("CALCULATION_IN_PROGRESS → its line", o("RULE_CALCULATION_IN_PROGRESS").message === COPY.calcInProgress);
check("NO_INCOME_SUBMISSIONS_EXIST → its line", o("RULE_NO_INCOME_SUBMISSIONS_EXIST").message === COPY.calcNeedsUpdate);
check("HTTP_429 → busy", o("HTTP_429").kind === "busy" && o("HTTP_429").message === COPY.busy);
check("HTTP_5XX → busy", o("HTTP_5XX").kind === "busy");
check("INVALID_GRANT → reconnect", o("INVALID_GRANT").kind === "reconnect");
check("an unknown FORMAT_ code is ours and alerts", o("FORMAT_VALUE").kind === "our_fault" && o("FORMAT_VALUE").alert);
check("an unknown RULE_ code is ours and alerts", o("RULE_BOTH_EXPENSES_SUPPLIED").kind === "our_fault");
check("an unknown other code is busy, not ours", o("SERVER_ERROR").kind === "busy" && !o("SERVER_ERROR").alert);
check("every outcome says nothing was sent", ["CLIENT_OR_AGENT_NOT_AUTHORISED", "FORMAT_VALUE", "HTTP_429", "RULE_INSOLVENT_TRADER"].every((c) => o(c).nothingSent));
check("the our-fault copy says nothing was sent", COPY.ourFault.includes("Nothing was sent"));
check("the busy copy says nothing was sent", COPY.busy.includes("Nothing was sent"));
check("turnaway copy: £90,000 names the next step", TURNAWAYS.turnover_limit!.next?.label === "Export my records");
check("turnaway copy: calendar quarters → GOV.UK's list", TURNAWAYS.calendar_quarters!.next?.target.startsWith("https://www.gov.uk/") === true);
check("nested errors[] code wins", hmrcCodeOf(400, { code: "INVALID_REQUEST", errors: [{ code: "FORMAT_VALUE", message: "x" }] }) === "FORMAT_VALUE");
check("top-level code when no errors[]", hmrcCodeOf(403, { code: "CLIENT_OR_AGENT_NOT_AUTHORISED" }) === "CLIENT_OR_AGENT_NOT_AUTHORISED");
check("429 is HTTP_429 whatever the body", hmrcCodeOf(429, { code: "MESSAGE_THROTTLED_OUT" }) === "HTTP_429");
check("503 is HTTP_5XX", hmrcCodeOf(503, {}) === "HTTP_5XX");
check("a bodiless 404 is HTTP_404 → busy", outcomeFor(404, null).kind === "busy");

// ── hmrcFetch ─────────────────────────────────────────────────────────────────
console.log("hmrcFetch");
const dopts = { baseDelayMs: 400, maxDelayMs: 5000, random: () => 0 };
check("Retry-After seconds honoured", retryDelayMs(0, "2", dopts) === 2000);
check("Retry-After capped", retryDelayMs(0, "60", dopts) === 5000);
check("no header: 400, 800, 1600", retryDelayMs(0, null, dopts) === 400 && retryDelayMs(1, null, dopts) === 800 && retryDelayMs(2, null, dopts) === 1600);
check("jitter added", retryDelayMs(0, null, { ...dopts, random: () => 0.5 }) === 600);
async function fetchChecks() {
{
  const calls: number[] = [];
  const sleeps: number[] = [];
  let n = 0;
  const fetchImpl = (async () => {
    calls.push(++n);
    if (n < 3) return new Response("{}", { status: 429, headers: { "retry-after": "1" } });
    return new Response("{\"ok\":true}", { status: 200 });
  }) as unknown as typeof fetch;
  const res = await hmrcFetch("https://example.invalid/x", { method: "GET" }, { fetchImpl, sleep: async (ms) => { sleeps.push(ms); }, random: () => 0 });
  check("two 429s then 200: three calls, two sleeps of Retry-After", res.status === 200 && calls.length === 3 && eq(sleeps, [1000, 1000]));
}
{
  let n = 0;
  const fetchImpl = (async () => { n++; return new Response("{}", { status: 429 }); }) as unknown as typeof fetch;
  const res = await hmrcFetch("https://example.invalid/x", {}, { fetchImpl, sleep: async () => {}, retries: 3, random: () => 0 });
  check("all 429: four attempts, the last 429 handed back", res.status === 429 && n === 4);
}
{
  let n = 0;
  const fetchImpl = (async () => { n++; return new Response("{}", { status: 500 }); }) as unknown as typeof fetch;
  const res = await hmrcFetch("https://example.invalid/x", {}, { fetchImpl, sleep: async () => {} });
  check("a 500 is NOT retried (a reached submission is never resent blind)", res.status === 500 && n === 1);
}
}

// ── hmrcSwitch ────────────────────────────────────────────────────────────────
console.log("hmrcSwitch");
check("no row → off", eq(evaluateSwitch(null, "u1"), { on: false, reason: "off" }));
check("disabled → off", eq(evaluateSwitch({ surface: "app", enabled: false, paused: false, allow_list: null }, "u1"), { on: false, reason: "off" }));
check("enabled → on", eq(evaluateSwitch({ surface: "app", enabled: true, paused: false, allow_list: null }, "u1"), { on: true, reason: null }));
check("paused wins over enabled", eq(evaluateSwitch({ surface: "app", enabled: true, paused: true, allow_list: null }, "u1"), { on: false, reason: "paused" }));
check("allow-list admits a named account", evaluateSwitch({ surface: "portal", enabled: true, paused: false, allow_list: ["u1"] }, "u1").on);
check("allow-list refuses the rest", eq(evaluateSwitch({ surface: "portal", enabled: true, paused: false, allow_list: ["u1"] }, "u2"), { on: false, reason: "not_allowed" }));
check("an empty allow-list admits nobody", !evaluateSwitch({ surface: "portal", enabled: true, paused: false, allow_list: [] }, "u1").on);
check("surface parses: portal / anything else is app", parseSurface("portal") === "portal" && parseSurface("app") === "app" && parseSurface(undefined) === "app" && parseSurface("desktop") === "app");

// ── hmrcPeriod ────────────────────────────────────────────────────────────────
console.log("hmrcPeriod");
check("tax year start/end", taxYearStart("2026-27") === "2026-04-06" && taxYearEnd("2026-27") === "2027-04-05");
check("taxYearFor: 5 Apr is the old year, 6 Apr the new", taxYearFor("2026-04-05") === "2025-26" && taxYearFor("2026-04-06") === "2026-27" && taxYearFor("2026-12-31") === "2026-27" && taxYearFor("2027-01-05") === "2026-27");
check("standard quarter ends", eq(standardQuarterEnds("2026-27"), ["2026-07-05", "2026-10-05", "2027-01-05", "2027-04-05"]));
check("5 Oct is a standard end, 30 Sep is not", isStandardQuarterEnd("2026-27", "2026-10-05") && !isStandardQuarterEnd("2026-27", "2026-09-30"));
check("quarter numbers", quarterNumber("2026-27", "2026-10-05") === 2 && quarterNumber("2026-27", "2027-04-05") === 4 && quarterNumber("2026-27", "2026-09-30") === 0);
check("due: 5 Oct → 7 Nov (one month and 2 days)", dueDateFor("2026-10-05") === "2026-11-07");
check("due: 5 Jan → 7 Feb", dueDateFor("2027-01-05") === "2027-02-07");
check("due: 5 Apr → 7 May", dueDateFor("2027-04-05") === "2027-05-07");
check("due: 5 Jul → 7 Aug", dueDateFor("2026-07-05") === "2026-08-07");
check("period start: began before the year → 6 April", periodStartFor("2026-27", "2019-03-01") === "2026-04-06");
check("period start: began mid-year → the commencement date", periodStartFor("2026-27", "2026-06-15") === "2026-06-15");
check("period start: no commencement known → 6 April", periodStartFor("2026-27", null) === "2026-04-06");
check("period start: began on 6 April → 6 April", periodStartFor("2026-27", "2026-04-06") === "2026-04-06");
check("sendable once ended", periodHasEnded("2026-10-05", "2026-10-05") && periodHasEnded("2026-10-05", "2026-10-06") && !periodHasEnded("2026-10-05", "2026-10-04"));
check("money: zero is fine (HMRC: 'even if the values are zero')", invalidMoneyField({ turnover: 0, other: 0, consolidatedExpenses: 0 }) === null);
check("money: two decimals fine", invalidMoneyField({ turnover: 2000.99 }) === null);
check("money: three decimals rejected", invalidMoneyField({ turnover: 2000.999 }) === "turnover");
check("money: negative rejected", invalidMoneyField({ turnover: -1 }) === "turnover");
check("money: over the max rejected", invalidMoneyField({ other: 100000000000 }) === "other");
check("money: a string rejected", invalidMoneyField({ turnover: "12" as unknown as number }) === "turnover");
check("the £90,000 turnover limit equals the VAT registration threshold in the rates file (neither drifts alone)", TURNOVER_LIMIT_GBP === VAT_REGISTRATION_THRESHOLD && TURNOVER_LIMIT_GBP === 90_000);

// ── hmrcFph ───────────────────────────────────────────────────────────────────
console.log("hmrcFph");
const ingress = { clientIp: "81.2.69.142", clientPort: 51234, receivedAt: "2026-10-02T15:00:00.000Z", ingressIp: "146.190.1.2", peerIp: "146.190.1.2" };
const ctx = { uid: "11111111-2222-3333-4444-555555555555", email: "qa@example.com", receivedAt: "2026-10-02T15:00:00.100Z", serverIp: "104.18.1.1", ingress, directClientIp: "", vendorVersion: "0.5.0" };
const mobile = {
  deviceId: "9d1b1c5e-1b5f-4b1e-9d6a-0c1e3f1a2b3c", timezone: "UTC+01:00",
  localIps: ["192.168.1.20", "fe80::1%en0", "2a01:4b00::1"], localIpsTimestamp: "2026-10-02T14:59:59.000Z",
  screen: { width: 430, height: 932, scalingFactor: 3, colourDepth: 24 }, window: { width: 430, height: 932 },
  osFamily: "iOS", osVersion: "26.0", deviceManufacturer: "Apple", deviceModel: "iPhone 15 Pro Max", appVersion: "1.0.4",
};
const mh = buildMobileFph(mobile, ctx);
check("mobile: method", mh["Gov-Client-Connection-Method"] === "MOBILE_APP_VIA_SERVER");
check("mobile: exactly the evaluated header names", eq(Object.keys(mh).sort(), [...MOBILE_HEADER_NAMES].sort()));
check("mobile: local IPs filtered to local scope, zone stripped, values percent-encoded", mh["Gov-Client-Local-IPs"] === "192.168.1.20,fe80%3A%3A1");
check("mobile: user ids = sign-in email + account", mh["Gov-Client-User-IDs"] === "soletax=qa%40example.com&soletax-account=11111111-2222-3333-4444-555555555555");
check("mobile: vendor version ios + server", mh["Gov-Vendor-Version"] === "soletax-ios=1.0.4&soletax-server=0.5.0");
check("mobile: public ip/port/timestamp from the ingress", mh["Gov-Client-Public-IP"] === "81.2.69.142" && mh["Gov-Client-Public-Port"] === "51234" && mh["Gov-Client-Public-IP-Timestamp"] === ingress.receivedAt);
check("mobile: forwarded = two internet hops", mh["Gov-Vendor-Forwarded"] === "by=146.190.1.2&for=81.2.69.142,by=104.18.1.1&for=146.190.1.2");
check("mobile: vendor public ip = the ingress address", mh["Gov-Vendor-Public-IP"] === "146.190.1.2");
check("mobile: no multi-factor, no licence ids", !("Gov-Client-Multi-Factor" in mh) && !("Gov-Vendor-License-IDs" in mh));
const mhNoLocal = buildMobileFph({ ...mobile, localIps: ["2a01:4b00::1"] }, ctx);
check("mobile: only public local addresses → the header is OMITTED, never empty", !("Gov-Client-Local-IPs" in mhNoLocal) && !("Gov-Client-Local-IPs-Timestamp" in mhNoLocal));
check("mobile fph validation: good set passes", eq(invalidMobileFphFields(mobile), []));
check("mobile fph validation: bad timezone named", invalidMobileFphFields({ ...mobile, timezone: "Europe/London" }).includes("timezone"));

const web = {
  deviceId: "c0ffee00-1111-2222-3333-444444444444",
  browserJsUserAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36",
  timezone: "UTC+01:00", screen: { width: 412, height: 915, scalingFactor: 2.625, colourDepth: 24 }, window: { width: 412, height: 780 },
  webVersion: "portal-2026.10.02",
};
const wh = buildWebFph(web, ctx);
check("web: method", wh["Gov-Client-Connection-Method"] === "WEB_APP_VIA_SERVER");
check("web: exactly HMRC's 16 less the two agreed omissions", eq(Object.keys(wh).sort(), [...WEB_HEADER_NAMES].sort()) && Object.keys(wh).length === 14);
check("web: browser user agent passed as reported", wh["Gov-Client-Browser-JS-User-Agent"] === web.browserJsUserAgent);
check("web: none of the device headers", WEB_FORBIDDEN_HEADERS.every((h) => !(h in wh)));
check("web: screens + window", wh["Gov-Client-Screens"] === "width=412&height=915&scaling-factor=2.625&colour-depth=24" && wh["Gov-Client-Window-Size"] === "width=412&height=780");
check("web: vendor version web + server", wh["Gov-Vendor-Version"] === "soletax-web=portal-2026.10.02&soletax-server=0.5.0");
check("web: the same public hop as mobile", wh["Gov-Client-Public-Port"] === "51234" && wh["Gov-Vendor-Forwarded"] === mh["Gov-Vendor-Forwarded"]);
check("web: user ids identical to mobile", wh["Gov-Client-User-IDs"] === mh["Gov-Client-User-IDs"]);
check("web fph validation: good set passes", eq(invalidWebFphFields(web), []));
check("web fph validation: names every missing field", eq(invalidWebFphFields({ ...web, browserJsUserAgent: "", screen: { width: 0, height: 915, scalingFactor: 2, colourDepth: 24 } }), ["browserJsUserAgent", "screen"]));
check("web fph validation: nothing → fph", eq(invalidWebFphFields(null), ["fph"]));
{
  const legacy = buildWebFph(web, { ...ctx, ingress: null, directClientIp: "81.2.69.142" });
  check("web without the ingress: no port, one hop, timestamp from receipt", !("Gov-Client-Public-Port" in legacy) && legacy["Gov-Vendor-Forwarded"] === "by=104.18.1.1&for=81.2.69.142" && legacy["Gov-Client-Public-IP-Timestamp"] === ctx.receivedAt);
}

fetchChecks().then(() => {
  console.log(`\n${fail === 0 ? "✅" : "❌"} hmrc server rules: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
});
