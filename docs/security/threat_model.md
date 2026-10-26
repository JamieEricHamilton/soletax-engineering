# SoleTax — Threat Model (Stage 1, written S121, 2026-07-07)

The written companion to `security_plan.md` §"Threat model" — assets, adversaries,
trust boundaries, the data-flow map, and the control that answers each threat,
each grounded in the actual code (file references, not intentions). Review
alongside `security_plan.md` before every submission and whenever a feature
touches data handling, auth, a third-party SDK, or a new table/bucket.

---

## 1. Assets, by sensitivity

| Asset | Where it lives | Sensitivity |
|---|---|---|
| Receipt images + invoice PDFs | Device (`Documents/`), Supabase Storage (`receipts`/`income` buckets) | HIGH — financial PII, may show card fragments, addresses |
| Income/turnover, tax position | Encrypted MMKV stores, Supabase rows | HIGH |
| Profile incl. bank sort code + account number (invoice footer) | `profile-store` (encrypted MMKV), Supabase `user_settings` | HIGH |
| Trips (home/client GPS coordinates, timestamps) | `trips-store` (encrypted MMKV), Supabase `trips` | HIGH — location history |
| Auth session (access + refresh token) | `auth-store` (encrypted MMKV; Keychain-held key) | CRITICAL — impersonation |
| Identity (name, email, trade) | Stores + Supabase auth | MEDIUM |
| Anthropic API key | Supabase Edge Function secret ONLY (never on device — audit C1) | CRITICAL — cost abuse |
| MMKV encryption key | iOS Keychain (`AFTER_FIRST_UNLOCK`) | CRITICAL — unlocks everything above |

## 2. Adversaries → the control that answers each

**(a) Another authenticated user reading others' rows/files (multi-tenant).**
RLS `auth.uid() = user_id` on every table; per-folder Storage policies; proven by
the 24/24 live RLS isolation test (S113), now a weekly CI job
(`.github/workflows/security.yml`). `search_user_records` EXECUTE revoked from
clients (20260702_security_hardening.sql) — service_role/edge-fn only.

**(b) An attacker who extracts the app binary.**
No privileged secrets ship: the Anthropic key is server-side
(`claude-extract` edge fn); the device carries only public/client keys —
Supabase publishable anon key (RLS-bound), Mixpanel token, Sentry DSN,
RevenueCat public key, Google OAuth client ids, Transistor licence JWTs
(deliberately public, gitleaks-allowlisted). gitleaks in CI keeps it that way.

**(c) A network attacker (MITM).**
TLS everywhere (Supabase, Sentry, Mixpanel, RevenueCat, Apple). No sensitive
data in URLs. Certificate pinning deliberately NOT adopted for V1
(maintenance cost vs. a threat already requiring a compromised CA — revisit
post-revenue, security_plan §5).

**(d) A lost/stolen device.**
As of S121, all 15 MMKV instances are AES-256 encrypted at rest
(`src/lib/secureStorage.ts`; key in Keychain, `AFTER_FIRST_UNLOCK`); the
Supabase session (incl. refresh token) lives in the encrypted `auth-store`,
migrated out of plaintext AsyncStorage with the legacy copy scrubbed
(`src/lib/supabase.ts`). iOS file protection covers files pre-first-unlock;
CI gate `scripts/test-secure-storage.ts` fails any future raw `createMMKV(`
call site or new AsyncStorage import. Receipt image files in `Documents/`
rely on iOS Data Protection + device passcode (documented residual, §5).
Biometric app lock: REVISED 2026-07-07 (S122) — IN as an opt-in toggle,
default OFF (protects the unlocked-phone case without taxing the two-tap
loop by default); queued next session, security_plan §2.

**(e) A malicious receipt (prompt injection into the categoriser).**
The AI call runs server-side with a fixed prompt; output is schema-validated
and never auto-committed — the human review gate (ReceiptConfirmScreen) is the
backstop, and the tax engine clamps corrupt numbers. A hostile receipt can at
worst propose wrong fields to a human.

**(f) Abuse (anon-account spam, OTP flooding, AI cost).**
Supabase auth rate limits + Resend 60s OTP min-interval; the edge fn
authenticates callers; `beta_signups` INSERT is bounded (shape + length,
20260707_advisor_hardening.sql) though deliberately open to the public form.
Residual: per-user AI-call caps are still a 🔲 (security_plan §9) — bounded
today by authenticated-caller + human-in-the-loop capture volume.

**(g) A sub-processor breach.**
Minimisation is the control: Sentry gets no PII (`sendDefaultPii:false`,
route-name breadcrumbs only — `_layout.tsx`); Mixpanel is opt-in, anonymous
(per-install random id, never the Supabase uid), EU-resident
(`api-eu.mixpanel.com`); RevenueCat sees subscription identity only; Anthropic
receives receipt images transiently via the edge fn (no training on API data);
Resend sees email addresses. DPAs + the sub-processor list live in the privacy
policy (<WEBSITE_HOST>/privacy).

## 3. Trust boundaries + data-flow map

```
[iOS device]
  app (JS + native) ── encrypted MMKV (key: Keychain) ── Documents/ images
      │ anon key + user JWT (TLS)
      ▼
[Supabase eu-west]  Postgres (RLS) · Storage (per-folder policies) · Auth (OTP/OAuth/anon)
      │ service_role (server-side only)
      ├─ edge fn claude-extract ──→ [Anthropic API]   (receipt image, transient)
      ├─ edge fn support-agent ───→ [Anthropic API]   (chat + tool results)
      ├─ edge fn report-notify ───→ [Resend]          (report email → Jamie)
      └─ edge fn delete-account ──  (erasure: rows + storage + auth user)
[device-direct third parties]
  Sentry (de.sentry.io — crashes, no PII) · Mixpanel EU (opt-in, anonymous)
  RevenueCat/Apple (subscription) · Apple/Google (sign-in id tokens)
  Transistor SDK: NO sync url configured — location never leaves the device
  except as our own trips rows (backgroundLocation.ts has no `url:`).
```

Boundary rules: nothing crosses device→cloud except through the Supabase
client (RLS-bound) or the listed device-direct SDKs; nothing crosses
cloud→third-party except through the four edge functions with server-held
secrets; `service_role` never ships in the app (grep-audited + gitleaks).

## 4. Storage encryption — loss/recovery semantics (decided S121)

- Key: 32-byte random (expo-crypto), Keychain `AFTER_FIRST_UNLOCK` (not
  ThisDeviceOnly — the key migrates inside ENCRYPTED backups, so a phone
  upgrade keeps local data).
- Reinstall: Keychain persists, container wiped → fresh stores encrypt with
  the existing key. Works.
- Restore from unencrypted backup / keychain loss: files restore, key doesn't →
  stores open empty by design (`secureStorage.ts` refuses to re-key over
  encrypted files — the key-created marker) and cloud restore rebuilds from
  Supabase on sign-in. Local-only unsynced edits from the final pre-backup
  minutes are the accepted exposure.
- Pre-first-unlock headless relaunch (Transistor, `startOnBoot`): Keychain and
  the MMKV files share the same first-unlock boundary — no new failure mode vs.
  the pre-encryption behaviour; a read in that window throws rather than
  re-keys.

## 5. Residual risks — accepted, with rationale

| Risk | Why accepted | Revisit when |
|---|---|---|
| Receipt image FILES on device not app-encrypted (iOS Data Protection only) | Passcode + Class C protection; images must stay OS-readable for share/PDF flows | Post-beta, if a low-cost wrap emerges |
| No certificate pinning | TLS + HSTS; pinning breaks on cert rotation, high maintenance. RATIFIED out for V1 (Jamie, 2026-07-07) | Post-revenue / CREST prep |
| Biometric app lock is opt-in, default OFF (decided IN 2026-07-07, queued) | Default-off users stay exposed to unlocked-phone snooping — their explicit choice; two-tap capture stays friction-free by default | Beta feedback on the default |
| Per-user AI cost cap missing | Server-side key + authenticated callers + human-paced capture | Before public launch (security_plan §9 🔲) |
| Advisor: deny-all RLS INFO trio (`extract_turns`, `support_reports`, `support_turns`) | Deliberate — service_role-only tables | Never (by design) |
| Advisor: anonymous sign-ins WARN | Capture-before-signup architecture (locked); anon users are RLS-scoped identically | Never (by design) |
| Advisor: HIBP leaked-password protection off | Pro-plan feature AND no password flow exists | If Pro + passwords ever appear |
| ~~HMRC sandbox client secret was pasted in chat (2026-06-21)~~ | CLOSED — rotated S121 (new secret live-verified, token call 200); old secret revoked in the Developer Hub, confirmed 2026-07-07 | — |

## 6. Maintenance

Owned alongside `security_plan.md` (same review cadence). Adding a store, a
bucket, an edge function, or an SDK = add its row/flow here in the same PR.
CI backstops: gitleaks, npm-audit gate, semgrep, weekly RLS isolation run,
`test-secure-storage.ts` (encryption-at-rest gate).
