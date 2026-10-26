# SoleTax: Security Runbooks (public, redacted edition)

> This is the showcase copy of the production runbook. The structure, the
> ordering rules and the breach-response clock are verbatim. Credential names,
> where each credential lives, dashboard paths, vendor account details,
> precedents, run IDs and anything else an attacker could use to shorten their
> own runbook have been removed or generalised. The production file is ~340
> lines and carries all of it.

**When to open this file:** a credential leaked (or might have), a dependency or
sub-processor got breached, something is spending money it shouldn't, or a
routine rotation is due. Work top to bottom; don't improvise the order under
pressure - that's what this file is for.

**One rule that overrides everything: revoke first, investigate second.** Every
key can be rotated without data loss. None of them are worth an hour of "let's
check the logs first" while they're live in an attacker's hands.

---

## 1. Key inventory - the shape of it

The production inventory is a numbered table: one row per credential, with
four columns - where it lives, blast radius if leaked, how to rotate it, and
whether it is public-by-design. Nineteen rows at the time of writing. The
classes, from worst to least:

| Class | Examples (by role, not name) | Blast radius | Where it is allowed to live |
|---|---|---|---|
| **Total** | database superuser password, Supabase `service_role` key | Bypasses RLS: every user's rows and storage | Edge-function secrets / platform-injected only. Never the client, never CI. |
| **Spend** | LLM provider API key | Money, capped per-user in-app but not for a direct key-holder | Edge-function secrets only |
| **Read-everything** | the backup role's password (read-only, `BYPASSRLS`) | Exposes user data, cannot alter it | CI secret + the founder's local env |
| **Admin control plane** | Supabase / Sentry / Cloudflare personal access tokens | Project config, secrets, deploys, DNS | Local env on one machine only - deliberately kept out of CI |
| **Recovery** | backup private key (`age`) | Decrypts every backup - but useless without the bucket. The real risk is LOSS, not leak | Local env + password manager; the workflow holds only the public key |
| **Sending-as-us** | transactional email / SMTP key, OAuth provider secret | Phishing our own users; OAuth code-exchange abuse | Auth-provider dashboard settings only |
| **Public by design** | anon/publishable key, Sentry DSN, analytics token, OAuth client ids, RevenueCat public SDK key, location-SDK licence | None alone; the anon key matters only combined with an RLS bug | Ship in the bundle. Don't page yourself over them appearing in the binary. |
| **Device-scoped** | MMKV encryption key | One device's local data; never leaves the device | iOS Keychain, `AFTER_FIRST_UNLOCK` |

Two invariants the inventory enforces, and CI checks where it can:
- Nothing in the **Total** or **Spend** class is ever present in the client
  bundle (`scripts/test-no-service-role-in-bundle.mjs`) or in GitHub Actions.
- Every wired secret reference in the repo is claimed in `security/surface.ts`
  or the surface-coverage gate fails.

---

## 2. Rotation runbooks - the pattern

Each credential has a numbered sequence. They all follow the same shape:

1. Mint the new one at the provider.
2. Install it where it lives (`supabase secrets set …` for edge functions -
   takes effect on the next invocation, no redeploy; CI secret; or the auth
   provider setting).
3. Smoke-test the one path that uses it (one receipt scan, one OTP email, one
   sign-in).
4. **Delete** the old one at the provider (not "deactivate").
5. Check the provider's usage log for the leak window; write anomalies into
   the incident log (§4).

Per-key notes that change the sequence:
- **Anon key:** the old key keeps working until revoked, and revoking strands
  every un-updated install. Ship the app update first; revoke last. Alone it
  is RLS-bound - if the worry is paired with an RLS defect, fix the defect
  first; the key is not the vulnerability.
- **`service_role`:** a leak is a personal-data breach until proven otherwise.
  Open §3 immediately; do not stop at rotation.
- **Admin PATs:** they sit on one machine. If the machine is the leak (theft,
  malware), rotate everything in the local env in one sitting and treat it as
  an incident.
- **SMTP key:** a leak means someone can send *as us*. Check the send log;
  unexplained sends → §3 and consider warning affected addresses.

---

## 3. Breach response - the ordered checklist

### Hour 0–1: contain
1. Flip the relevant kill switch (`remote_flags` for app features;
   `hmrc_filing_switch.paused = true` for filing) so nothing more goes out.
2. Rotate the suspected credential (§2). Revoke first.
3. Snapshot what you can see (dashboard logs, `server_events`,
   `hmrc_submissions`) before it ages out.

### Hour 1–24: assess
4. Scope: which tables, which users, which window. The RLS boundary means a
   single-account compromise stays single-account; an infra-credential
   compromise does not.
5. Decide whether personal data was accessible. If in doubt, assume yes.
6. Write the running incident note (what, when, how found, who knows).

### Hour 24–72: notify (legal clock)
7. **ICO within 72 hours of awareness** where the breach is likely to result
   in a risk to individuals (UK GDPR Art. 33). Data subjects without undue
   delay where the risk is high (Art. 34).
8. **HMRC** - only when the breach touches HMRC data (OAuth tokens, a National
   Insurance number, a business id, the `hmrc_submissions` rows, or anything a
   filing call carried). The Developer Hub terms require a ticket with HMRC
   within 72 hours *and* the ICO notice, both on the same clock from
   awareness. Treat the production client secret as compromised and rotate it
   in the Developer Hub. The terms also require encryption of access tokens
   and PII at rest and in transit, so the assessment states whether the
   encrypted columns or their key were exposed.
9. **Sub-processor breaches** (Supabase, Anthropic, Mixpanel, Sentry,
   RevenueCat, Resend get breached, not us): same assessment path - we are
   still the controller; their notification starts *our* 72-hour clock.

### After: close
10. Root cause + fix + **a regression gate**. A fix without a gate re-breaks
    silently.
11. Write it up in §4: date, window, cause, blast radius, notifications made,
    gate added.
12. Re-run the Security workflow and the RLS isolation test before calling
    it closed.

---

## 4. Incident log

*(empty - long may it stay so)*

---

## 5. Standing cadence

- **Rotate on departure:** any time a device or collaborator with credential
  access leaves the picture.
- **Annual sweep:** rotate the admin-class and spend-class keys and re-verify
  the inventory each April, on the same calendar entry as the tax-rates
  review.
- **New machine / OS reinstall:** the local env migrates by hand; confirm no
  copy remains on the old machine.
- **Backup-restore rehearsal - annually, and it has been done:** nightly
  `backup.yml` → artifact pulled from object storage → decrypted with the
  private key → restored into a scratch project → row counts, policy counts,
  index/trigger counts and per-table md5 checksums compared to production.
  The first rehearsal found two tooling gotchas (an rclone connection-string
  form that breaks on `://` in an endpoint, and `information_schema.triggers`
  hiding triggers on tables the querying role doesn't own) - both recorded in
  the workflow and script headers.
- **Repo mirror:** the same nightly job bundles the whole repo
  (`git bundle --all`) and encrypts it alongside the database, covering the
  compound failure of GitHub account loss plus a dead workstation.

---

## 6–13. The stranger runbooks (headings only in this edition)

The production file continues with one runbook per failure mode in the
degradation register, each written so that someone who has never seen the
system could execute it:

- Auth-email outage - swap the SMTP provider in the auth settings.
- Backend down (Supabase outage) - what users see, what still works (the app
  keeps capturing offline), how we find out, what to tell people.
- Bad release + kill switch - `remote_flags` first, then roll back the portal
  deploy / expire the TestFlight build.
- Corruption found - stop writes with the switch, identify the window from
  the nightly data-invariants sweep, restore from the last clean backup into
  a scratch project, reconcile.
- Account compromise - single user vs founder infra, and the different
  blast radii the RLS boundary gives each.
