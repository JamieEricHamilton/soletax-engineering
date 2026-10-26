# SoleTax — Security Phase (the dedicated pre-launch hardening + audit)

> **Status: PLANNED. Runs as the final V1 phase, after the build is in its final state (mileage calibration + RevenueCat + everything else done), before App Store submission. Added 2026-06-21 (Session 78) at Jamie's direction.**

Security is ranked **equal to compliance**: SoleTax is a UK **data controller** holding people's financial PII (income, expenses, receipt images, tax position, identity). A breach is existential — it ends the accountant-distribution trust flywheel (see `soletax_brief.md` §Accountant validation: "lose anyone's trust once and it's game over") and carries UK GDPR liability. This document is the **living checklist Jamie combs over** the same way compliance was combed over `coverage_matrix.md`: walk every item, ask "what's still a gap / a risk," address it, refine, and prove it with **free tooling**. A paid human pen-test is **deferred to post-revenue** — see the route below.

This is the security twin of `docs/compliance/coverage_matrix.md`. Keep it accurate; tick items only when verified, not when intended.

---

## The route — decided 2026-06-21 (S78): foundations ourselves, free tools to prove it, CREST later

Bootstrapped, low budget until revenue. The decided approach — and a sound one, because **a pen-test validates security, it does not create it**: build the foundations ourselves to a thorough, disciplined standard, prove them with **free** tooling, and fold in a paid human **CREST** pen-test once the app earns. The dominant risk (multi-tenant data isolation) is *deterministic* and testable for free — so the free route genuinely secures the app; the paid human test is later validation + a trust credential, not the foundation.

**Why a small, well-built app can be secured for free:** the surface we OWN is small. Supabase is managed + SOC 2 / ISO 27001 (we inherit infra security — encryption at rest, patching, DDoS); Apple IAP + RevenueCat process every payment (we never touch card data → almost no PCI scope); OTP + OAuth means no password store to breach. What's left is mostly OUR config + the client app, which is auditable for free.

### Stage 1 — Build the foundations ourselves (free; this is where security actually comes from)
Walk every domain below to a thorough, disciplined standard on the final code state; close every 🔲/❓; encrypt MMKV, secure the session token, move the Claude key server-side, scrub PII, lock down Supabase config, write the threat model. Be as thorough and disciplined as the compliance pass was.

### Stage 2 — Prove it with FREE tooling (the launch gate)
| Risk | Free tool(s) |
|---|---|
| **Multi-tenant isolation (RLS) — #1** | Our own **RLS isolation test** (two test accounts; every cross-read/write/delete across every table + Storage bucket — deterministic + exhaustive, so for THIS risk it beats a pen-test) + Supabase **Security Advisor** (dashboard, flags any RLS-off table) |
| Leaked secrets | `gitleaks` / `trufflehog` / GitHub secret scanning |
| Vulnerable dependencies | `npm audit` + **Dependabot** |
| Code-level bugs (injection, unsafe patterns) | **Semgrep** (free, has React Native security rules) / GitHub **CodeQL** |
| Runtime / API probing (DAST) | **OWASP ZAP** (free, open-source) + **Aikido free tier** — its SCA / secrets / SAST / cloud-posture scanning is **free**; only the AI *Pentest* add-on is paid |

These run in **CI** (the security `test:tax` equivalent) so a regression can't ship silently. **★ Launch gate = Stage 1 done + Stage 2 clean + the RLS isolation test green.** V1 ships public on this (parallels the mileage reliability gate as a hard pre-launch gate). A short `SECURITY.md` + threat model + a `security.txt` disclosure contact land in the repo (handover-proof, like `COMPLIANCE.md`).

**★ The Security Coverage Gate (the Stage-2 enforcement layer, PART A + B LIVE 2026-07-21).** The tools above are *re-checkers* of known-bad patterns; none of them notices that the **attack surface itself grew** — a new edge function, Worker endpoint, model-key, or egress host lands unprobed until a human happens to look. `security/surface.ts` + `scripts/test-security-coverage.ts` close that structural blind spot: the manifest is the **machine twin of "The domains" comb-over below (§57)** — the same enumeration, but the gate *discovers the real surface from the repo* and fails CI when any element is unclaimed (a probe, or a dated `accepted`/`deferred`/`not-applicable`). It runs in `npm run test:tax` **and** as the `surface-coverage` job in `security.yml`. So the comb-over is no longer a thing someone has to remember to re-walk — a new surface can't ship un-triaged. **Part B (the offensive probes) is built + green** (82 elements, 59 actively probed): `test-worker-act.mjs` (the `/act` HMAC + `/test/*` admin gate), the pentest's edge-function authN + report-notify secret + delete-account BOLA checks, and the RLS test's `income` (primary financial table) + turn-log + notify-fn-EXECUTE checks. The gate was itself hardened against a 4-dimension adversarial self-review (its worst blind spot — a table shipped with no RLS — now fails loudly; the service-role key is now inventoried). Full spec + status: `docs/security/security_coverage_gate_brief.md`; the locked build rule is PROJECT_RULES "security-coverage rule".

### Stage 3 — Human CREST pen-test (DEFERRED to post-revenue — fold back into the business when it earns)
Once SoleTax generates revenue, commission a paid **CREST-accredited** human pen-test — for the depth (an independent expert's adversarial creativity on novel logic flaws) and the **credential** (CREST is the badge the UK accountant / HMRC audience recognizes), ideally before HMRC recognition / enterprise accountant deals. **Honest note:** this is precisely the assurance the free route can't fully replicate (independent creativity + unknown-unknowns + the credential) — but it's the *marginal* layer on a foundation that's already solid, not the foundation itself. Tools like **Aikido's AI Pentest** (~€3,500 flat, IDOR/cross-tenant focus, "no high/critical = don't pay") are a middle option to consider here too; CREST-human carries more weight for the trust story.

### ⚠ Sequencing caveat — the pre-beta baseline (do NOT defer these to the final phase)

Most hardening rightly waits for the final code state. **But beta (27 July) puts REAL testers' REAL financial data into the live backend.** A small baseline therefore must be verified **before the beta build ships**, because the exposure window opens the moment the first tester saves a receipt:

- **B1. RLS cross-tenant isolation is proven** (§2) — a misconfigured policy = a live data breach during beta. Cheapest control, highest impact. Non-negotiable before beta.
- **B2. No secret is extractable that grants broad access** (§3) — the Supabase `service_role` key is never on the device; the anon key is the only client key.
- **B3. Privacy policy + in-app account deletion exist** (§7) — these are *also* Apple TestFlight/App Store gates and UK-GDPR obligations, independent of security.
- **B4. PII is scrubbed from Sentry/Mixpanel** (§6) — don't bleed real financial data into third-party dashboards from day one.

Everything else (device-storage encryption, API-key server-side move, the full Stage-1 audit + Stage-2 free-tool suite) is the dedicated final phase; the Stage-3 CREST human test is post-revenue. **This pre-beta baseline is a recommendation flagged for Jamie's decision — the default remains "full phase last."**

---

## Threat model (assets → adversaries → surfaces)

**Assets, by sensitivity:** receipt images + invoices (PII + financial), income/turnover + tax position, identity (name, email, trade), auth credentials/session tokens, the Anthropic API key, business client names/addresses on invoices.

**Adversaries:** (a) another *authenticated user* trying to read others' rows/files (the multi-tenant threat — RLS is the whole defence); (b) an attacker who *extracts the app binary* (API keys, hardcoded secrets, logic); (c) a *network* attacker (MITM); (d) a *lost/stolen unlocked device*; (e) a *malicious receipt* (prompt injection into the AI categoriser); (f) *abuse* (someone spamming anonymous accounts / the OTP endpoint / the AI to run up cost); (g) a *sub-processor* breach (Supabase/Anthropic/Mixpanel/Sentry/RevenueCat).

**Primary attack surfaces:** the Supabase REST/Realtime/Storage API (RLS is the only thing between users), the auth flow (OTP/magic-link/OAuth + the anon→permanent link), the deep-link `auth-callback` route, the on-device Claude API call, the app binary, local storage (MMKV/cache), and every third-party SDK.

---

## The domains (the comb-over checklist)

Status key: ✅ in place · 🟡 partial · 🔲 to do · ❓ verify during the phase.

### 1. Authorization & multi-tenant isolation (RLS) — THE critical domain
- ✅ RLS enabled on `receipts`, `income`, `user_settings`, support tables; `auth.uid() = user_id` "own X only" policies (`docs/setup/supabase-setup.sql`, migrations).
- ✅ Storage object policies scope each file to the user's own folder (`(storage.foldername(name))[1] = auth.uid()::text`) on the `receipts` + `income` buckets.
- 🔲 **B1 — Automated cross-tenant isolation test.** Sign in as user A and user B; prove A cannot SELECT/UPDATE/DELETE any of B's rows, nor read/list/download B's Storage objects, across **every** table + bucket. Run in CI. *(Enabling a policy ≠ proving it; a single `using` clause that returns true is a breach.)*
- 🔲 **Service-role audit.** Confirm `service_role` (and any key that bypasses RLS) is used **only** server-side (Edge Functions), never shipped in the app. Grep the bundle.
- ❓ **Anonymous-user scope.** Anon sign-ins are ON (needed for capture-before-signup). Confirm an anon user is RLS-isolated identically and can do nothing cross-tenant; bound what an unauthenticated/anon principal can reach.
- ❓ **Buckets are private** (no public read); signed URLs (if any) are short-lived + scoped.
- ❓ Every NEW table/bucket added later inherits RLS + `grant ... to authenticated` (the known gotcha) — make it a checklist item in the migration template.

### 2. Authentication & session security
- ✅ Anon→permanent linking preserves `auth.uid()` (records survive reinstall); native Apple/Google via `signInWithIdToken`; email via single `signInWithOtp`.
- ✅ **Session token storage — CLOSED 2026-07-07 (S121).** It WAS plaintext AsyncStorage (confirmed on-sim: the session JSON sat readable in `RCTAsyncLocalStorage_V1/manifest.json`). Now: the session (incl. refresh token) lives in the AES-256-encrypted `auth-store` MMKV instance (key in the Keychain) via a custom auth-storage adapter in `src/lib/supabase.ts`, with a lazy one-time migration that pulls the legacy AsyncStorage copy across and DELETES the plaintext original (nobody gets signed out; no plaintext lingers). Proven on-sim: planted a real legacy session → new build migrated it into `auth-store` and scrubbed the manifest. CI: `scripts/test-secure-storage.ts` fails any new AsyncStorage import outside the adapter.
- ✅ **OAuth nonce — CLOSED 2026-07-07 (S123 audit).** Live config read via the Management API: only **Google** has `skip_nonce_check = True`, and it must stay ON — `@react-native-google-signin` exposes no nonce parameter (documented Supabase posture for native RN Google sign-in; risk-accepted, the token is still audience-bound to our web client id). **Apple has no skip flag and now gets a real nonce**: `signInWithApple` generates a random nonce per attempt, hands Apple the SHA-256 and Supabase the raw value (`src/lib/auth.ts`), so a captured identity token can't be replayed. ⚠ Verify Apple sign-in once on the test device before beta (sim can't run the Apple sheet e2e).
- ✅ OTP rate-limit exists (Resend 60s min-interval; a new OTP invalidates the prior) — confirm it's sufficient against enumeration/abuse.
- ✅ **Sign-out server-side revocation — CLOSED 2026-07-07 (S123 audit): N/A by design.** There is NO user-facing sign-out in V1 — the only two `signOut` calls are dev-only (`devResetToFreshAnon`, deliberately `scope:'local'` per its comment) and post-account-deletion (`deleteAccount.ts`, where the auth user is already erased server-side, killing every session/refresh token with it). Refresh-token rotation is ON with a 10 s reuse interval (Management API, verified live), so a stale local copy can't be replayed after rotation. Caveat recorded: the dev-only local reset leaves a server session to expire naturally — acceptable, dev builds only. If a user-facing sign-out ever ships, it must use the default `scope:'global'`.
- ✅ **Biometric app lock — SHIPPED + SIM-PROVEN 2026-07-07 (S123).** Opt-in, default OFF, exactly the ratified shape: `expo-local-authentication@~55.0.15` (SDK-pinned, pod linked), `NSFaceIDUsageDescription` (app.json + native plist), `AppLockGate` root overlay in `_layout` (last sibling, zIndex 300, covers every gate), Account → SECURITY → "Unlock with Face ID" toggle. Enabling requires one successful auth (proves enrolment before the lock can stand in the doorway); re-locks on true `background` only (NOT `inactive` — the Face ID prompt itself passes through inactive); cold launch starts locked (synchronous MMKV hydration, no unlocked flash); **fail-open when the device has no passcode AND no biometrics** (never brick an opt-in lock). Labels resolve from hardware — the iOS 17 floor includes Touch ID SEs. All five behaviours proven on-sim (enable-with-check ×15PM, background-return lock+unlock, cold-launch lock + auto-prompt, instant disable, SE3 "Unlock with Touch ID" label — Jamie eyeballed the SE3 shot). Store: `security/appLockStore` (secure MMKV, coverage.ts out-of-scope entry). the test device sign-off rides the held build (post-ride-validation).
- ✅ **Deep-link `auth-callback` — AUDITED + HARDENED 2026-07-07 (S123).** Findings: no open-redirect (the route always `router.replace('/')`, no param-driven navigation); `token_hash`/`code` are server-verified (a forged value just fails). The real exposure was **login-CSRF**: any app/webpage can fire `soletax://auth-callback` with fragment tokens (`setSession`) or another account's magic-link material, silently swapping the device onto an attacker's account — future captures would then sync to the attacker. **Guard shipped:** the route now refuses to consume auth material when the device is already signed into a permanent account (`isPermanentUser()` check) — legit sign-ins (onboarding auth step, returning-user reinstall) are always anon at that moment, so no real flow is turned away. Supporting fact (verified via the Management API): every live email template emits only the 6-digit `{{ .Token }}` — no production email links to this route at all today, so the change is zero-user-impact. Residual (accepted): an anon user mid-onboarding could still be link-swapped, but holds no data at that point; revisit only if templates ever reintroduce links.

### 3. Secrets & key management
- ✅ No secrets committed (`.gitignore` covers `.env*.local`, `*.key`; `git ls-files` clean).
- ✅ **The Claude API key — server-side since S109 (claude-extract Edge Function), and the per-user COST CAP closed 2026-07-07 (S123).** The key never ships; who-may-call and what-a-call-may-cost are both server-enforced. Caps (ratified by Jamie, S123): claude-extract **120/hour (burst) + 100/day + 500/month** per user; support-agent **60/hour + 100/day + 1,000/month** (the month figure is the same-shape backstop, my choice — flag if it should differ). Shared gate `supabase/functions/_shared/rateLimit.ts` counting the existing `extract_turns`/`support_turns` service-role tables over rolling windows; a 429 carries `{scope}` and Ask SoleTax shows honest wait copy for day/month. Worst-case abuse ≈ £1.50/user/month on extraction. **E2E-proven live:** a throwaway anon user made 100 minimal calls (all 200), and call 101 returned `429 {scope:"day"}` — exact boundary; deployed to production, Ask SoleTax streams normally under the gate.
- ❓ Confirm only the Supabase **anon** key (public-safe, RLS-bound) is in the app; the `service_role` key is server-only.
- ❓ RevenueCat / Mixpanel / Sentry keys are the correct *public/client* keys, not privileged server keys.
- ✅ **Key rotation runbook — WRITTEN 2026-07-07 (S123): `docs/security/runbooks.md`.** Full 15-credential inventory with blast radius + per-key rotation steps (Anthropic/service_role/anon/PATs/SMTP/Google secret), the ordered breach-response checklist (contain → assess → the UK GDPR 72-hour ICO clock → user notification), an incident log, and the annual rotation cadence tied to the April compliance cycle. Backup-restore rehearsal stays OPEN (runbooks §5 — needs a restore-target decision, do once before beta).
- ❓ EAS build secrets / env vars are scoped and not embedded in JS where avoidable.

### 4. Data at rest
- ✅ **Device — MMKV encrypted at rest — CLOSED 2026-07-07 (S121).** ALL 15 MMKV instances (every store + the Supabase default instance + the new `auth-store`) are AES-256 encrypted via `src/lib/secureStorage.ts` — a 32-byte random key generated on-device (expo-crypto) and held in the iOS Keychain (`AFTER_FIRST_UNLOCK`, migrates only in encrypted backups). Existing plaintext files are encrypted IN PLACE on first open (per-instance Keychain markers make an interrupted migration self-healing; the wrapper refuses to re-key over encrypted files if the Keychain is unreadable, so a pre-first-unlock headless relaunch can never wipe data). Proven on-sim before/after: `strings` on `profile-store` showed the full profile incl. bank sort code + account number pre-migration; post-migration 0 readable matches and the app state was identical. CI gate: `scripts/test-secure-storage.ts` (in `npm run test:tax`) fails any raw `createMMKV(` call site outside the wrapper, any new AsyncStorage import, or a silent downgrade of AES-256/keychain class. Loss semantics + full design: `threat_model.md` §4.
- ❓ **Cached files** — receipt images / generated PDFs / audio in `cacheDirectory` are sensitive; confirm iOS Data Protection class + a cleanup/eviction policy.
- ✅ **Supabase region — CONFIRMED `eu-west-1` (EU ✓, 2026-07-07 via Management API). Backups: the entry-tier plan keeps ZERO automated ones** (`pitr_enabled:false`, `backups:[]`) — **closed same day by our own nightly pipeline** (Jamie ratified DIY over Pro; Pro deferred to a *capacity* decision): `.github/workflows/backup.yml`, 03:00 UTC — DB (read-only role) + both storage buckets → age-encrypted → R2 (EU jurisdiction), 35-day retention, healthchecks.io dead-man's switch. **E2E-proven from the live R2 artifact: decrypt → restore → content-identical** (runbooks §5).

### 5. Data in transit
- ✅ TLS everywhere by default (Supabase, Anthropic, RevenueCat over HTTPS).
- ❓ No sensitive data in URLs, query strings, or logs.
- 🔲 **Optional: certificate pinning** for the Supabase + Anthropic endpoints — decide cost/benefit in-phase (raises MITM bar, adds maintenance).

### 6. Third-party data flows / sub-processors / PII minimization
- 🔲 **Data-flow map** — exactly what PII leaves the device and to whom: receipt **images → Anthropic** (OCR); analytics events → **Mixpanel**; crash/breadcrumbs → **Sentry**; subscription identity → **RevenueCat**; everything → **Supabase**.
- 🟡 **B4 — Scrub PII from Mixpanel + Sentry.** **Mixpanel half CLOSED 2026-07-07 (S123 audit, no findings):** all 5 `track()` call sites + the catalog audited — every property is an enum/bool/route-name (`screen` uses expo-router pathnames; no dynamic segments exist, so no ids ride along); no `identify()`/`alias()`/people calls anywhere (per-install random id only); `setUseIpAddressForGeolocation(false)`; `trackAutomaticEvents: false`; EU endpoint; consent-routed (declined drops, undecided stays on-device); the only super property is `{dev:true}` on dev devices. The `FORBIDDEN_PROP_KEYS` lint in `test-analytics` keeps it true in CI. **Remaining tail: the Sentry half** — `sendDefaultPii:false` + route-name-only breadcrumbs are already in place; still to do is a `beforeSend` audit/redaction pass over event payloads (exception messages can quote user strings).
- 🔲 **Anthropic data handling** — confirm API inputs are **not** used for training and the retention posture (zero/limited data retention) is acceptable for receipt images; document it.
- 🔲 **Sub-processor list + DPAs** — a signed/accepted Data Processing Agreement with Supabase, Anthropic, RevenueCat, Mixpanel, Sentry, and the email provider (Resend); list them all in the privacy policy.

### 7. Privacy & legal (UK GDPR / DPA 2018) — overlaps the runway's 24 July privacy item
- 🔲 **Privacy policy** — lawful basis, data categories, retention, sub-processors, user rights, contact. Hosted at a stable URL (TestFlight external + App Store both require it).
- 🔲 **Terms of service.**
- 🔲 **B3 — In-app account deletion** that purges Supabase rows **and** Storage objects (Apple **requires** in-app deletion; UK GDPR right to erasure). Test it actually removes everything.
- 🟡 **Data export / DSAR** — the user can get their data; the MTD export pack partly serves this (extend to "all my data" if needed).
- 🔲 **ICO registration** as a data controller (UK; an annual data-protection fee, ~£40–60 for a small org).
- ❓ **Analytics consent / ATT** — if Mixpanel does anything that counts as tracking, App Tracking Transparency + a consent path; otherwise document why not.
- ❓ Retention: the 5-year **records** rule (compliance §G) is about the user's tax records; GDPR **minimization** still applies to PII we hold beyond that purpose.

### 8. Client / app hardening
- 🔲 **Strip PII from production logs** — no `console.log` of amounts/names/tokens; guard debug logging behind `__DEV__`; audit Sentry breadcrumbs.
- 🔲 **Prompt-injection** — a receipt image's text could try to manipulate the AI categoriser. The human review gate is the backstop (no silent auto-categorisation), but confirm a malicious receipt can't exfiltrate, change another field, or break JSON parsing. Treat AI output as untrusted; validate/clamp it (the tax engine already clamps corrupt numbers).
- ❓ **Input validation** — Supabase client is parameterized (no SQL injection), but validate/bound all user input and AI output before it reaches storage or the engine.
- 🔲 **Optional:** screenshot/app-switcher blur for the financial screens; jailbreak detection (decide in-phase — diminishing returns).

### 9. Backend / infrastructure & abuse
- 🔲 **DB roles & grants audit** — `anon` vs `authenticated` vs `service_role`; least privilege; no table grants broader than needed.
- 🟡 **Abuse / rate limiting** — **AI-cost abuse CLOSED 2026-07-07 (S123): per-user caps live on BOTH Claude functions** (see §3 — hour/day/month windows, E2E-proven at the exact 100/day boundary). Remaining tails: anonymous-account spam (each anon signup is free to mint; the caps are per-user, so a scripted signup loop multiplies them — bounded by Supabase auth rate limits, review pre-beta) and OTP-send flooding (Resend 60 s min-interval stands).
- 🔲 **Monitoring/alerting** — Supabase logs + Sentry alerting on auth anomalies, RLS-denied spikes, error-rate spikes.
- ✅ Edge Functions authenticate the caller and enforce per-user limits — **verified + extended 2026-07-07 (S123)**: all four functions resolve the JWT to a user id before any work; the two Claude-calling functions additionally enforce the hour/day/month cost caps (`_shared/rateLimit.ts`).

### 10. Supply chain / dependencies
- 🔲 **`npm audit`** clean (or triaged); enable **Dependabot**.
- ❓ Native SDKs (Transistor background-geolocation, RevenueCat, MMKV, expo-*) pinned + reviewed for their own data handling (the Transistor SDK sees location — confirm it isn't phoning location anywhere but our backend).
- ❓ Lockfile integrity; no unexpected postinstall scripts.

### 11. Operational / incident response
- 🔲 **Breach response plan** — UK GDPR requires ICO notification within **72 hours** of a qualifying breach; write the runbook (detect → contain → assess → notify → remediate) before launch.
- 🔲 **Key-rotation runbook** (links §3).
- ✅ **Backup/restore tested — DONE 2026-07-07** (restore-from-Supabase already proven for the user flow; the DB-level rehearsal is now done too: dump → scratch project → content-identical verify — runbooks §5). ⚠ The rehearsal's finding: **no automated backups exist on the entry-tier plan** — the Pro-vs-scheduled-dump decision (+ storage-objects backup) is the remaining pre-beta tail (§4 line).

### 12. Verification & sign-off (the staged route above)
- 🔲 **Stage 1 — Self-audit comb-over** — Jamie walks this whole doc, evidences each ✅, closes each 🔲/❓ (the compliance-style pass). This is the foundation.
- ✅ **Stage 2 — free tooling in CI — PRE-BUILT 2026-07-07 (S120)**, seven weeks ahead of the gate week, all baselines audited by hand and green: `.github/workflows/security.yml` runs on every push/PR — secret scan (**gitleaks** 8.30.1 vs `.gitleaks.toml`; full 425-commit history audited: only the 3 deliberate public keys, allowlisted with rationale) + the **npm-audit baseline gate** (`scripts/check-npm-audit.mjs` fails on any high/critical NOT in the hand-justified `scripts/npm-audit-baseline.json` — 9 known build-toolchain advisories, none in the app bundle; never casual-`npm audit fix`, the S112 pod lesson) + **Semgrep** `p/default` (pinned 1.168.0; 5 excluded rules each hand-verified, rationale in the workflow; it caught + fixed a real gap in our own Dependabot config on day one) — plus the **RLS isolation test** as a weekly scheduled CI job (⚠ Jamie one-time: add `SUPABASE_URL` + `SUPABASE_ANON_KEY` repo secrets; the job skips gracefully until then). **Dependabot** configured (npm + github-actions, weekly, 7-day supply-chain cooldown, RN/Expo majors ignored); all workflow actions SHA-pinned. STILL FOR THE GATE WEEK (needs the final build/live surfaces): OWASP ZAP + the Aikido free tier. **Supabase Security Advisor read-through — DONE EARLY 2026-07-07 (S121):** both actionable WARNs fixed live + recorded in `supabase/migrations/20260707_advisor_hardening.sql` (`pg_trgm` → `extensions` schema, RPC smoke-tested after; `beta_signups` INSERT bounded to the form's real shape — 201 for a valid signup, junk/oversized now 401, test row cleaned). Remaining findings accepted with rationale (deny-all service-role tables; anon sign-ins = the architecture; HIBP is Pro-plan-gated AND moot with no password flow) — see `threat_model.md` §5. Re-run the Advisor in the gate week as a regression check.
- ✅ **`SECURITY.md`** committed (disclosure contact <SECURITY_CONTACT_EMAIL>, subject `SECURITY`; safe-harbour wording; no bounty) + **`security.txt` LIVE** at https://<WEBSITE_HOST>/.well-known/security.txt (RFC 9116; expires 2027-07-07) — 2026-07-07 (S120). ✅ **The written threat model — DONE 2026-07-07 (S121): `docs/security/threat_model.md`** (assets → adversaries → the control answering each, trust boundaries + data-flow map, encryption loss/recovery semantics, the accepted-risk register).
- 🔲 **Stage 3 — human CREST pen-test — DEFERRED to post-revenue** (not launch-blocking): independent expert attack for depth + the trust credential, before HMRC recognition / enterprise deals. Fold the cost back in once the app earns.

---

## Current-state snapshot (from the 2026-06-21 recon, pre-phase)

**Already solid:** per-table RLS + per-user Storage policies; no secrets in the repo; `grant ... to authenticated` discipline; dependency-update is a standing COMPLIANCE.md item; the team already flagged the on-device API key as a known move-server-side item.

**Biggest open risks going in:** (1) RLS is enabled but **never adversarially tested** — the one where a bug is catastrophic; (2) the **Claude API key is on the device**; (3) **MMKV is unencrypted** + session-token storage unconfirmed; (4) the whole **GDPR/legal layer** (privacy policy, account deletion, DPAs, ICO) is unstarted; (5) the human external review is deliberately deferred (Stage 3, post-revenue).

## Decisions
**DECIDED 2026-06-21 (S78) — the security budget route:** build the foundations ourselves (Stage 1, free, thorough + disciplined), prove with free tooling incl. our own RLS isolation test (Stage 2 = the launch gate), and do a paid human **CREST** pen-test later, once the app generates revenue (Stage 3). Rationale: low budget pre-revenue; a pen-test validates security rather than creating it; the catastrophic risk (RLS multi-tenant isolation) is free + deterministic to prove. This is a responsible posture for a bootstrapped V1 beta with a limited user base.

**Still open (resolve during the phase):**
- ~~Move the Claude receipt-OCR call server-side for V1?~~ RESOLVED — server-side since audit C1 (claude-extract edge fn).
- ~~Biometric app lock~~ — **RESOLVED (Jamie, 2026-07-07): IN as opt-in, default OFF** — revises the S121 OUT recommendation; **SHIPPED + sim-proven S123 same day** (see §2 for the full closure).
- ~~Certificate pinning~~ — **RATIFIED OUT for V1 (Jamie, 2026-07-07)** (breaks on cert rotation, real maintenance, marginal gain over TLS for this threat model). Revisit at CREST prep.
- Honour the **pre-beta baseline** (B1–B4 before 27 July), or accept the risk of a real-data beta on un-audited infra? *(B1 proven S113 + weekly CI; B3 done; B4 partially — Sentry PII-off done, Mixpanel audit outstanding; B2 grep-audited.)*
- When (which revenue milestone) triggers the Stage-3 CREST test, and which UK CREST firm.
- Sentry Session Replay — **S121 recommendation: stays OFF for beta** (the S58 scroll-jank suspect + a financial-PII screen-capture surface; `_layout.tsx` documents the sample rates at 0). If ever enabled: low session rate + full masking, post-beta.

---

## Maintenance
- Reviewed before every App Store submission and whenever a new feature touches data handling, auth, a third-party SDK, or a new table/bucket (add the row before building, like the compliance matrix).
- Owner: keep in lockstep with `docs/setup/supabase-setup.sql` (the RLS source of truth), the migrations, and `COMPLIANCE.md` #7 (dependency/security updates).
