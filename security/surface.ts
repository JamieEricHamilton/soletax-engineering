/**
 * surface.ts — the SINGLE SOURCE OF TRUTH for SoleTax's attack surface: every
 * place the app can be attacked, each claimed by exactly one of a probe, a dated
 * risk-acceptance, a deferral, or a not-applicable ruling.
 *
 * This is the keystone pattern's SECOND application (after src/support/
 * coverage.ts). The CI gate `scripts/test-security-coverage.ts` (in
 * `npm run test:tax`, and a step in security.yml) DISCOVERS the real surface from
 * the filesystem — edge functions, CI workflows, Worker routes, wired secret
 * references, edge-function egress hosts, and migration grant/RLS objects — and
 * FAILS when a discovered element is claimed by no entry here. So a NEW edge
 * function / workflow / Worker route / wired secret / outbound host / granted
 * table cannot ship un-triaged: CI stops it until someone adds a probe or writes
 * a dated acceptance. It converts "we find a bonus issue whenever we happen to
 * look" into "you cannot add unwatched surface without CI going red."
 *
 * ⚠ SCOPE — repo-expressed surface ONLY (security_coverage_gate_brief §5). This
 * gate does NOT see dashboard-level drift: Supabase project settings, Cloudflare
 * UI config, or tables created outside migrations (e.g. the `receipts` table was
 * dashboard-created, so it isn't filesystem-discovered — it's declared below as a
 * known extra). Watching that surface would need broad admin tokens in CI, a
 * property Jamie deliberately keeps out (the S172 ruling — the backup AGE key and
 * Supabase admin token stay local, which is why backup-drill and the pentest run
 * locally). This is an UNTESTED-SURFACE gate, not a vulnerability scanner: it
 * makes the scanners' structural blind spot (surface growth) visible; it does not
 * replace them.
 *
 * ENFORCEMENT DIRECTION per kind (see the gate):
 *   edge-function / workflow / worker-route — BIDIRECTIONAL: a discovered element
 *     with no entry fails; an entry naming an element that no longer exists fails.
 *   secret / outbound / db-grant — ONE-DIRECTIONAL: a discovered element with no
 *     entry fails, but declared extras are allowed (local-only .env.local keys,
 *     client-side egress hosts, dashboard-created tables legitimately exceed what
 *     the repo expresses).
 *
 * Pure data + types only (no imports) so tsx reads it directly, exactly like
 * coverage.ts. Locked build rule: PROJECT_RULES "security-coverage rule".
 */

export type SurfaceKind =
  | 'edge-function' // supabase/functions/<name> (minus _shared)
  | 'workflow' //      .github/workflows/<name>.yml
  | 'worker-route' //  a route on a Cloudflare Worker: "<worker>:<path>"
  | 'secret' //        a credential referenced by a workflow (secrets.X) or Worker (env.X)
  | 'outbound' //      an external host an edge function talks to
  | 'db-grant'; //     a table / RPC with an RLS policy or grant in a migration

export type SurfaceClaim =
  /** A named check in the probe registry actively tests this surface. */
  | { kind: 'probe'; probe: string }
  /** A deliberate, dated risk-acceptance (no automated probe, and that's fine).
   *  Optional reviewBy (YYYY-MM-DD): the gate FAILS once it's overdue, so an
   *  acceptance can't silently rot — set it on anything whose safety could drift. */
  | { kind: 'accepted'; why: string; since: string; reviewBy?: string }
  /** Planned; the trigger that must fold in a probe. */
  | { kind: 'deferred'; until: string }
  /** Surfaced but genuinely no attack value. */
  | { kind: 'not-applicable'; why: string };

export interface SurfaceElement {
  kind: SurfaceKind;
  /** The discovered identity. For the bidirectional kinds it MUST equal what the
   *  gate discovers (dir name, `<name>.yml`, `<worker>:<path>`). */
  id: string;
  what: string;
  claim: SurfaceClaim;
  note?: string;
}

export interface Probe {
  id: string;
  /** Repo-relative path that must exist on disk (the gate checks — a probe claim
   *  can't name a check that was deleted). */
  file: string;
  what: string;
}

/** The probe registry. A `{ kind: 'probe' }` claim must name one of these ids,
 *  and each file below must exist (the gate asserts both). */
export const PROBES: Probe[] = [
  {
    id: 'hmrc-pentest',
    file: 'scripts/hmrc-pentest.mjs',
    what: 'the scripted pentest — tenant isolation (T-AC, incl. the T-AC-4-seed positive control so receipt isolation is never vacuous), the search-RPC BOLA vector (T-IN/AC-RPC), token-table secrecy (T-TK), hmrc-submit authN (T-AU), the Claude-proxy + assistant authN (T-AU-CE) and per-user rate-limit/cost cap (T-RL — seeds the caller to the hour limit, asserts 429 scope=hour before any model call), exact-origin CORS on the four browser-called functions (T-CO — portal origin granted, foreign origins get nothing, preflight + real response; static half in scripts/test-portal-cors.ts), delete-account authN + BOLA (T-DA), report-notify webhook secret (T-RN), OAuth-callback integrity (T-OA), misconfig/verbosity (T-MC), the HMRC ingress envelope (T-IG — direct/forged/foreign-origin refusals, the host serves one path, JWT enforced through it, client envelope headers overwritten; S225)',
  },
  {
    id: 'rls-isolation',
    file: 'scripts/test-rls-isolation.mjs',
    what: '24 live RLS isolation checks — cross-tenant SELECT/UPDATE/DELETE/INSERT across receipts, trips, other_income, user_settings, support_reports + storage objects + the search RPC revoke',
  },
  {
    id: 'verify-sync-spine',
    file: 'scripts/verify-sync-spine.mjs',
    what: 'the sync spine live probe (20260812) — proves the sync_spine_guard trigger through the authenticated RLS path on all four record tables: a stale write silently loses, a newer one wins, soft-delete tombstone semantics both ways (incl. resurrect-by-newer-edit), legacy unstamped writers get server-stamped, a future device clock is clamped, and search_user_records never surfaces a tombstone',
  },
  {
    id: 'verify-oauth-web',
    file: 'scripts/verify-oauth-web.mjs',
    what: 'web OAuth config probe (portal session 4) — /authorize for google + apple 302s to the right IdP with the right client id (web/Services ID first in the comma list, never the bundle id) and our callback; Google\'s consent page + Apple\'s authorize page render with no OAuth config error (proves the console/portal registrations without a login). Secrets\' VALIDITY is out of reach here (used only at token exchange) — that half is the interactive sign-in + the apple-siwa-secret-rotation clock',
  },
  {
    id: 'gitleaks',
    file: '.gitleaks.toml',
    what: 'secret scan on EVERY push, docs included (secrets.yml — deliberately UNfiltered in the S187 budget redesign: docs commits are where pasted credentials land; weekly full pass also in security.yml) — proves a credential VALUE never lands in the repo; allowlist = .gitleaks.toml',
  },
  {
    id: 'semgrep',
    file: '.github/workflows/security.yml',
    what: 'SAST p/default on every code push (path-filtered S187: docs/fleet/md commits skip — semgrep excludes docs anyway) — incl. the mutable-action-tag rule that keeps every workflow SHA-pinned',
  },
  {
    id: 'npm-audit',
    file: 'scripts/check-npm-audit.mjs',
    what: 'dependency gate — fails on NEW high/critical advisories vs the recorded baseline',
  },
  {
    id: 'edge-health',
    file: 'scripts/edge-health-check.mjs',
    what: 'daily reachability/health probe of the deployed edge functions',
  },
  {
    id: 'worker-act',
    file: 'scripts/test-worker-act.mjs',
    what: 'live probes of the fleet-clock Worker — /act (the RETIRED button rail, 2026-07-21) must answer 404 with no confirm form, proving the rail stays dead; /test/* rejects a missing/wrong admin bearer (401) and non-POST (405); /mail (the email bridge read model, S199), /dmarc (the DMARC instrument read model, B8 S218) and /uptime (the uptime probe read model, C2 S218) all reject missing/wrong MAIL_READ_KEY bearers (401) and non-GET (405)',
  },
  {
    id: 'uptime-probe',
    file: 'scripts/test-uptime-probe.mjs',
    what: 'the 15-min uptime probe\'s drill (C2, S218; in test:tax): the cron-coverage pin — every fleet BEATS entry still fires under the repacked two-expression wrangler.toml grid, and all 96 quarter-hour firings exist for the probe cadence — plus the pure alert state machine (blips never alert; the Nth consecutive failure alerts exactly once; recovery sends one all-clear) and the target-table invariants (edge fns probed unauthenticated so 401 = healthy at zero model cost; no privileged credential in any probe)',
  },
  {
    id: 'mail-fence',
    file: 'scripts/test-mail-fence.mjs',
    what: 'the email bridge\'s forged-sender-dropped drill (§2b fence 1): unit-tests the pure DKIM fence (workers/fleet-clock/src/fence.mjs) — forged Authentication-Results headers inside the message body are ignored (first-header + Cloudflare-authserv-id rule), non-allowlisted signers and lookalike domains drop, missing verification fails closed',
  },
  {
    id: 'dmarc-parser',
    file: 'scripts/test-dmarc-parser.mjs',
    what: 'the DMARC instrument\'s parser drill (B8, S218): unit-tests workers/fleet-clock/src/dmarc.mjs — pass counting (either aligned mechanism), auth_results never bleeding into the policy_evaluated verdict, the <WEBSITE_HOST> domain gate, and the zip (central-directory) / gzip / plain-XML container paths, with containers built in-test via node zlib',
  },
  {
    id: 'no-service-role-in-bundle',
    file: 'scripts/test-no-service-role-in-bundle.mjs',
    what: 'static grep (in test:tax): the SUPABASE_SERVICE_ROLE_KEY name/value never appears in client-shipped trees (src/, website/, the Expo config) — catches the EXPO_PUBLIC_ inlining trap and any client-side use; decodes JWT literals and flags only role=service_role (the anon key + the Transistor licence are correctly ignored). Proven to fail on planted exposure (S182).',
  },
];

export const SURFACE: SurfaceElement[] = [
  // ── Edge functions (supabase/functions/*) ──────────────────────────────────
  {
    kind: 'edge-function',
    id: 'claude-extract',
    what: 'Receipt OCR proxy: authenticated client → Claude Haiku (image → structured expense JSON).',
    claim: { kind: 'probe', probe: 'hmrc-pentest' },
    note: 'T-AU-CE probes authN (no-auth / forged bearer / anon-key-as-user → 401); T-RL probes the per-user rate-limit / cost cap (seeds extract_turns to the hour limit → 429 scope=hour before any model call); T-CO probes the exact-origin CORS layer (S214: browser-called by the portal via _shared/cors.ts withCors — portal origin granted, foreign origins get nothing).',
  },
  {
    kind: 'edge-function',
    id: 'claude-import-map',
    what: 'Switcher-import mapping proxy: authenticated client → Claude (bank/CSV column mapping).',
    claim: { kind: 'probe', probe: 'hmrc-pentest' },
    note: 'T-AU-CE probes authN (no-auth / forged bearer / anon-key-as-user → 401); T-RL probes the rate-limit / cost cap (seeds import_turns to the hour limit → 429 scope=hour before any model call); T-CO probes the exact-origin CORS layer (S214, _shared/cors.ts withCors — browser-called by the portal since S217 portal session 12, prompt + validation client-side as on the app, same import_turns caps per user).',
  },
  {
    kind: 'edge-function',
    id: 'delete-account',
    what: 'GDPR erasure: authenticated client → cascade delete of the caller\'s rows + storage objects.',
    claim: { kind: 'probe', probe: 'hmrc-pentest' },
    note: 'T-DA probes authN (no-auth / forged / anon-key → 401) AND the BOLA vector: a throwaway user D deletes its account while passing a SECOND user E\'s uid in the body — E\'s rows survive, proving deletion is scoped to the JWT uid, never the caller-supplied param (the search_user_records lesson). T-CO probes the exact-origin CORS layer (S214, _shared/cors.ts withCors). Browser-called from the portal since session 8 (S215) — the web two-beat delete flow; E2E-proven from the portal origin (200 → auth user 404).',
  },
  {
    kind: 'edge-function',
    id: 'hmrc-oauth-callback',
    what: '--no-verify-jwt OAuth code→token exchange behind an HMAC-signed, uid-bound, 10-min state envelope; bounces to soletax://hmrc-filing.',
    claim: { kind: 'probe', probe: 'hmrc-pentest' },
    note: 'T-OA-1/2/5 probe empty/forged/denied state; T-OA-write confirms no forged callback writes or overwrites tokens.',
  },
  {
    kind: 'edge-function',
    id: 'hmrc-submit',
    what: 'JWT-verified quarterly-update filing: holds the HMRC client secret + AES-256-GCM user tokens; forwards the fraud-prevention header set; writes an audit row per attempt.',
    claim: { kind: 'probe', probe: 'hmrc-pentest' },
    note: 'T-AU-1/2/3 probe missing/forged/anon-as-user bearer; T-MC-1/2 probe the removed debug dump + error verbosity; the hmrc_connections table it fronts is covered by T-TK.',
  },
  {
    kind: 'edge-function',
    id: 'report-notify',
    what: '--no-verify-jwt webhook: the pg_net AFTER-INSERT trigger on support_reports → Resend email.',
    claim: { kind: 'probe', probe: 'hmrc-pentest' },
    note: 'T-RN probes the secret gate: GET → 405, POST with no / wrong x-report-secret → 401 (so knowing the URL or the anon key can\'t spam email). The probe never sends the real secret, so no email fires.',
  },
  {
    kind: 'edge-function',
    id: 'welcome-email',
    what: '--no-verify-jwt webhook: the pg_net AFTER-INSERT trigger on user_settings → the founder welcome via Resend (S184). GET ?u= renders the unsubscribe confirm page (never writes — scanner-prefetch-proof); POST ?u= is the tokenised suppression (RFC 8058 one-click + the confirm form).',
    claim: { kind: 'accepted', why: 'the report-notify idiom on every SEND path — x-welcome-secret gates every POST without ?u= (401 on missing/wrong), so URL/anon-key knowledge can\'t send mail; sends a fixed founder-signed template to the row\'s own user only (no caller-controlled recipient except the secret-gated test path). The unauthenticated POST ?u= path is token-scoped (unguessable per-user token is the auth) and only ever suppresses — worst case for a leaked/bruted token is an unwanted unsubscribe, never a send or a read.', since: '2026-07-23' },
    note: 'Fold a T-WE probe into hmrc-pentest at the next probe sweep (same shape as T-RN: GET-without-token 400, POST no/wrong secret 401).',
  },
  {
    kind: 'edge-function',
    id: 'signup-notify',
    what: '--no-verify-jwt webhook: the auth.users triggers (20260901 — email confirmed + not beta_cohort + not internal) → the instant real-signup email to Jamie via Resend (S222, portal_live_plan §2.3; the ratified at-detection exception to the one-briefing law).',
    claim: { kind: 'accepted', why: 'the report-notify idiom — x-signup-secret gates every POST (401 on missing/wrong), so URL/anon-key knowledge can\'t send mail; recipient is HARDCODED to the founder\'s mailbox (never caller-controlled), and a forged call for a user the trigger never claimed in signup_notifications sends nothing (404). Worst case for a leaked secret is spam to Jamie, never a user email or a read.', since: '2026-09-01' },
    note: 'Fold a T-SN probe into hmrc-pentest at the next probe sweep (POST no/wrong secret 401, unclaimed user 404).',
  },
  {
    kind: 'edge-function',
    id: 'trial-reminder',
    what: '--no-verify-jwt daily job: pg_cron → public.run_trial_reminder() → pg_net (20260904) → the trial-ending email to accounts on day 12–13 of a real 14-day trial (identity.trialStartMs; the growth census\'s exclusions verbatim), RevenueCat-checked (paying accounts skipped), one send per account (trial_reminders ledger, claimed before the send), every run logged in trial_reminder_runs for the nightly census. Web reminders leg 1, S223 late.',
    claim: {
      kind: 'accepted',
      why: 'the report-notify idiom — x-trial-secret gates every POST (401 on missing/wrong); recipients are NEVER caller-controlled: the fn computes them from the trial clock + the ledger (test mode sends the render to one secret-gated address, no ledger); without REVENUECAT_FLEET_KEY the fn is not armed and sends nothing (a paying customer must never read "your trial is ending"); an unreadable RevenueCat answer is a skip, never a send.',
      since: '2026-09-04',
    },
    note: 'Fold a T-TR probe into hmrc-pentest at the next probe sweep (POST no/wrong secret 401; dry run writes a run row and no ledger row).',
  },
  {
    kind: 'edge-function',
    id: 'handoff',
    what: 'The web→phone hand-off (Phase 3, S223 late, 20260904_handoff): op "mint" (JWT-verified in the handler — getUser on the bearer, never a body uid; browser-called, withCors) issues a ONE-TIME 60-second token and the universal link that carries it; op "redeem" (no JWT — the app has no session yet) flips the token single-use (UPDATE … WHERE used_at IS NULL … RETURNING) and returns a magic-link token_hash for that account via admin.generateLink (no email sent) — the app verifies it exactly as an emailed link, login-CSRF guard included.',
    claim: {
      kind: 'accepted',
      why: 'the token is 256 random bits stored as a SHA-256 hash, usable once, dead after a minute, swept daily; redeem has no other input, so there is nothing to enumerate; mint is JWT-bound and rate-limited (handoff_turns 60/hour, 300/day) and refuses anonymous or email-less accounts; the app side refuses to swap an established permanent user onto another account (src/app/open.tsx, the S123 guard).',
      since: '2026-09-04',
    },
    note: 'Fold a T-HO probe into hmrc-pentest at the next probe sweep (mint without a bearer 401; redeem of a random token 410; a second redeem of a real token 410).',
  },
  {
    kind: 'edge-function',
    id: 'mapkit-token',
    what: 'The trip map on the web (gap Phase C, S223, 2026-09-04): mints a 30-minute Apple MapKit JS token (ES256, the "SoleTax MapKit JS" key — environment.md C33) for the signed-in portal user; browser-called, withCors, verify_jwt=true + getUser on the bearer in the handler. Reads and writes nothing.',
    claim: {
      kind: 'accepted',
      why: 'the private key never leaves the edge env (only tokens do); every token carries an `origin` claim equal to the caller\'s allowlisted Origin (MapKit JS refuses it on any other page) and dies within 30 minutes; a non-browser caller (no allowlisted Origin) is refused (403) and an unauthenticated one 401; the worst case for a leaked token is map tiles on our own origin for half an hour — no user data is reachable through it.',
      since: '2026-09-04',
    },
    note: 'Fold a T-MK probe into hmrc-pentest at the next probe sweep (no bearer 401; bearer but no allowlisted Origin 403; a token\'s payload carries origin + a ≤30-min exp).',
  },
  {
    kind: 'edge-function',
    id: 'review-signin',
    what: '--no-verify-jwt fixed-code sign-in for the ONE allowlisted Apple App Review demo account (S202, rejection_audit R2): email allowlist from a secret + constant-time SHA-256 code compare + global 10/hour attempt window (review_signin_attempts, service-role-only, fail-CLOSED) → admin generateLink token_hash the app exchanges via verifyOtp.',
    claim: {
      kind: 'accepted',
      why: 'auth boundary analysed at build (S202): sessions are mintable ONLY for the single env-allowlisted review address — every other email gets the identical generic 401, so no real account is reachable through this path regardless of client behaviour; the code is compared constant-time against a secret, brute force is bounded by the global 10/hour fail-CLOSED window over a rotating 6-digit code, and the feature is dark (404) until both secrets are set. Blast radius of a leaked code: the seeded demo account, which never holds a real user\'s data.',
      since: '2026-08-03',
      reviewBy: '2026-12-01',
    },
    note: 'Rotate REVIEW_ACCOUNT_CODE after each Apple review cycle (submission_checklist §E). Fold a T-RS probe into hmrc-pentest at the next probe sweep: wrong code → 401, 11th attempt in an hour → 429, unset-secrets project → 404, and a minted token_hash signs into ONLY the review uid.',
  },
  {
    kind: 'edge-function',
    id: 'send-invoice',
    what: 'JWT-verified invoice/quote email relay (portal session 6): getUser, then service-role reads pinned to the caller\'s uid (own income row + documents entry + its Storage PDF + business profile) → Resend from <INVOICES_EMAIL> with the trader\'s business as display name and their own email as Reply-To. Rate-limited via send_invoice_turns (20/h, 50/d, 300/m).',
    claim: { kind: 'accepted', why: 'the welcome-email precedent for an accepted send-path fn, with a TIGHTER caller boundary: verify_jwt=true at the gateway (config.toml) + in-fn getUser, every query filtered by the verified uid (never a body-supplied one), recipient/message validated + header-injection-sanitised, attachment only ever the caller\'s own stored document. Blast radius of a compromised account: rate-capped mail from invoices@ carrying that user\'s own documents.', since: '2026-08-12', reviewBy: '2026-12-01' },
    note: 'Fold a T-SI probe into hmrc-pentest at the next sweep (no-auth/forged → 401; foreign jobId → 404; seeded send_invoice_turns → 429; T-CO CORS shape). Live-proven at ship: real send E2E + foreign-job 404 + no-JWT 401.',
  },
  {
    kind: 'edge-function',
    id: 'support-agent',
    what: 'JWT-verified Ask-SoleTax assistant: getUser then a service-role search_user_records call scoped to the caller.',
    claim: { kind: 'probe', probe: 'hmrc-pentest' },
    note: 'T-AU-CE probes the function\'s OWN authN endpoint (no-auth / forged / anon-key → 401 — the review\'s L-finding: the probe must hit the endpoint, not only its RPC); T-RL probes the rate-limit / cost cap (seeds support_turns to the hour limit → 429 scope=hour before any model call); T-IN/AC-RPC + rls-isolation prove search_user_records rejects a foreign p_uid (the BOLA vector it fronts); T-CO probes the exact-origin CORS layer (S214, _shared/cors.ts withCors — the SSE stream carries the grant too).',
  },

  // ── CI workflows (.github/workflows/*.yml) ──────────────────────────────────
  // Shared baseline for all: third-party actions are SHA-pinned (the semgrep
  // mutable-action-tag rule enforces it; Dependabot keeps pins fresh), permissions
  // are least-privilege, and every workflow runs only trusted in-repo code. Per-
  // workflow notes below flag the distinctive secret / blast radius.
  {
    kind: 'workflow',
    id: 'backup.yml',
    what: 'Nightly encrypted backup to R2: DB + storage buckets + the full-history repo bundle (the mirror, S178 — restore: runbooks.md §6).',
    claim: { kind: 'accepted', why: 'SHA-pinned; least-privilege. The AGE private key + restore/decrypt stay LOCAL, never in CI (S172) — CI only writes ciphertext to R2. The repo bundle carries committed state only, so it can never contain a secret.', since: '2026-07-21' },
  },
  {
    kind: 'workflow',
    id: 'competitor-hunter.yml',
    what: 'Daily competitor discovery (App Store / Google Play / Product Hunt scrape + Haiku relevance screen).',
    claim: { kind: 'accepted', why: 'SHA-pinned; least-privilege; ANTHROPIC_API_KEY is its only secret. Proposes into candidates.json, never enrols (fleet law).', since: '2026-07-21' },
  },
  {
    kind: 'workflow',
    id: 'competitor-watch.yml',
    what: 'Daily competitor page + app-store diff.',
    claim: { kind: 'accepted', why: 'SHA-pinned; least-privilege; read-only external fetches + Haiku labelling.', since: '2026-07-21' },
  },
  {
    kind: 'workflow',
    id: 'domain-watch.yml',
    what: 'Daily soletax.co.uk drop watch (S216): RDAP + the Nominet public drop list, deterministic, no model.',
    claim: { kind: 'accepted', why: 'Read-only public fetches (RDAP + droplists.nominet.uk); no secrets beyond the standard findings-commit token; no model call. Entry added S217 — S216 (an unsealed-draft session) missed the same-commit rule.', since: '2026-08-17' },
  },
  {
    kind: 'workflow',
    id: 'compliance-check.yml',
    what: 'Typecheck + lint + test:tax on every push (this gate\'s host once test-security-coverage joins test:tax).',
    claim: { kind: 'accepted', why: 'SHA-pinned; runs only repo code + tests; no deploy credentials.', since: '2026-07-21' },
  },
  {
    kind: 'workflow',
    id: 'auto-retry.yml',
    what: 'One automatic re-run of a listed workflow\'s failed jobs on its FIRST failed attempt (S218 hardening B4 — heals transient runner/network failures; real defects fail again and stay red).',
    claim: { kind: 'accepted', why: 'Default GITHUB_TOKEN with actions:write only (re-run existing runs — cannot alter code, secrets, or workflow definitions); no checkout, no third-party actions, one curl to the GitHub API; loop-safe via the run_attempt==1 guard; compliance-watch (red-by-design) and the single-use-token HMRC sweep are excluded by list.', since: '2026-08-18' },
  },
  {
    kind: 'workflow',
    id: 'rls-per-migration.yml',
    what: 'Path-filtered RLS backstop (S218 hardening D3): any supabase/migrations/** push to main re-runs test-rls-isolation.mjs against PROD — tenant isolation is re-proven on the exact commit that changed the policy surface, not at the next weekly slot. The pre-prod half is the local D1 staging ritual.',
    claim: { kind: 'accepted', why: 'Credential-light: anonymous sign-ins with the public SUPABASE_ANON_KEY only (already an Actions secret for edge-health) — no admin or Management API credential enters CI. SHA-pinned actions; a targeted --no-save supabase-js install instead of the full root tree; 10-min timeout; queue-not-cancel concurrency so an isolation proof is never killed mid-sweep. Each run leaves two anonymous auth users (the recorded rls-isolation precedent); rows and storage objects are cleaned up.', since: '2026-08-18' },
  },
  {
    kind: 'workflow',
    id: 'compliance-reminder.yml',
    what: 'Annual SA103F-review issue opener + the reviewBy CI backstop.',
    claim: { kind: 'accepted', why: 'SHA-pinned; opens an issue via the built-in GITHUB_TOKEN; no external secrets.', since: '2026-07-21' },
  },
  {
    kind: 'workflow',
    id: 'compliance-watch.yml',
    what: 'Daily gov.uk / legislation source diff → Fable-drafted PRs behind the corpus validator.',
    claim: { kind: 'accepted', why: 'SHA-pinned; drafts PRs (human-merged), never pushes to main; ANTHROPIC_API_KEY + GITHUB_TOKEN.', since: '2026-07-21' },
  },
  {
    kind: 'workflow',
    id: 'data-invariants.yml',
    what: 'Nightly read-only data-invariant sweep over prod (S218 hardening E1): one SQL round trip as backup_reader proves the invariants no code path should break — fk-orphans, duplicate trip siblings, duplicate document numbers, future sync stamps (LWW poisoning), negative values, time inversions — plus a growth-watched tier (anon-held records, settingsless uids, giant values). Findings ride the 06:00 briefing; a hard break reds the run and opens a tracking issue.',
    claim: { kind: 'accepted', why: 'SHA-pinned; credentials are BACKUP_READER_PASSWORD (already an Actions secret for backup.yml + edge-health; the role is read-only so the sweep cannot write even if compromised) and REVENUECAT_FLEET_KEY (S222 growth census — a dedicated RC v2 READ-only mint, fleet tier; empty until minted and the census degrades to SQL-only); SELECTs + read-only RC GETs per run; commits findings + ledger only.', since: '2026-08-18' },
  },
  {
    kind: 'workflow',
    id: 'edge-health.yml',
    what: 'Daily edge-function reachability probe (hosts the edge-health probe).',
    claim: { kind: 'accepted', why: 'SHA-pinned; unauthenticated liveness checks only; commits a finding.', since: '2026-07-21' },
  },
  // fleet-action.yml + the Worker /act route RETIRED 2026-07-21 (the button
  // doctrine: the briefing carries no decision buttons; decisions land in
  // sessions via the fleet registers). The rail lives in git history; the
  // worker-act probe now asserts /act stays a 404.
  {
    kind: 'workflow',
    id: 'fleet-analyst.yml',
    what: 'F6 — daily event check + Monday deep pass over the fleet ledgers/dossiers; first-Monday monthly intel draft PR (human-merged).',
    claim: { kind: 'accepted', why: 'SHA-pinned; least-privilege (contents + pull-requests write for the draft-PR leg); reads only committed fleet data; ANTHROPIC_API_KEY + the built-in GITHUB_TOKEN; drafts PRs, never pushes doc changes to main.', since: '2026-07-21' },
  },
  {
    kind: 'workflow',
    id: 'fleet-strategist.yml',
    what: 'F7 — chains on every analyst completion (workflow_run); proposes angles into fleet/strategist/angles.json, never decides.',
    claim: { kind: 'accepted', why: 'SHA-pinned; contents write only (fleet/ data commits); consumes the committed digest + repo-read locked decisions; ANTHROPIC_API_KEY is its only secret. Proposals are session-ratified, no auto-apply path.', since: '2026-07-21' },
  },
  {
    kind: 'workflow',
    id: 'fleet-briefing.yml',
    what: 'The 06:00 UTC briefing assembler + sender (verdict-in-subject; Fable polish behind validators).',
    claim: { kind: 'accepted', why: 'SHA-pinned; reads the committed findings, sends via RESEND_API_KEY; ANTHROPIC_API_KEY for polish. No decision buttons (the button doctrine, 2026-07-21).', since: '2026-07-21' },
  },
  {
    kind: 'workflow',
    id: 'fleet-steward.yml',
    what: 'Weekly fleet-fitness pass vs the capacity rulebook → proposals settled in sessions; budget-rule breaches auto-queue (no buttons).',
    claim: { kind: 'accepted', why: 'SHA-pinned; produces register entries only, never applies changes; actions:read for the CI-minutes budget metric; Fable-only.', since: '2026-07-21' },
  },
  {
    kind: 'workflow',
    id: 'hmrc-evidence.yml',
    what: 'Weekly HMRC sandbox evidence sweep (stateful evidence + FPH validation-feedback).',
    claim: { kind: 'accepted', why: 'CI-OWNED. It preflights the secrets-write PAT BEFORE consuming the SINGLE-USE HMRC refresh token and reseals the rotation straight back; the local sweep is retired. Secrets: the HMRC_* set + FLEET_SECRETS_PAT.', since: '2026-07-21' },
    note: '⚠ NEVER run hmrc-endpoint-sweep.mjs locally — it burns the single-use token the weekly run depends on. The DIVIDENDS_CLEANUP leg (S175) is dispatch-gated, never on the cron.',
  },
  {
    kind: 'workflow',
    id: 'listening-watch.yml',
    what: 'Daily Google Alerts + Hacker News sweep → Fable-drafted replies (human posts).',
    claim: { kind: 'accepted', why: 'SHA-pinned; GOOGLE_ALERT_FEEDS + ANTHROPIC_API_KEY; the Reddit Data API leg stays declared-disabled (application DECLINED 29 Jul 2026 — reapply is Jamie\'s open decision). Drafts only, never auto-posts.', since: '2026-07-21' },
  },
  {
    kind: 'workflow',
    id: 'journo-radar.yml',
    what: 'The journo radar (agent 16, S199): Google News coverage sweep + the §2b email-bridge digest scan → live request alerts to Jamie.',
    claim: { kind: 'accepted', why: 'SHA-pinned; least-privilege; secrets = ANTHROPIC_API_KEY + RESEND_API_KEY + MAIL_READ_KEY (read-only bearer on the Worker /mail route — worst case it reads copies of two public PR newsletters). Alerts Jamie only; no outward send path, no Gmail credential anywhere in the fleet.', since: '2026-07-31' },
  },
  {
    kind: 'workflow',
    id: 'secrets.yml',
    what: 'The per-push secret scan (gitleaks, full history, NO path filter) — split out of security.yml in the S187 budget redesign so docs-only commits stay secret-scanned while skipping the expensive gates. Docs commits (the setup manifest, the session log) are the likeliest place a pasted credential lands.',
    claim: { kind: 'accepted', why: 'SHA-pinned; least-privilege; same gitleaks version + .gitleaks.toml allowlist as the weekly pass (keep in step); RESEND_API_KEY only for the on-hit alert path.', since: '2026-07-25' },
  },
  {
    kind: 'workflow',
    id: 'security.yml',
    what: 'The Security Stage-2 gate itself — per code push: npm-audit + semgrep (path-filtered S187); weekly Monday full pass: + gitleaks, surface-coverage, RLS, fleet-report. Hosts the semgrep, npm-audit and rls-isolation probes (per-push gitleaks moved to secrets.yml).',
    claim: { kind: 'accepted', why: 'SHA-pinned; the gate host. Path filter is ignore-list polarity (new paths are checked by default); the per-push surface-coverage duplicate was removed S187 — every push still runs it via test:tax in compliance-check.yml. The fleet-report job\'s GITHUB_TOKEN carries contents: write plus three READ scopes for the GitHub alerts line (vulnerability-alerts, security-events, pull-requests — 2026-10-03); no PAT enters this workflow.', since: '2026-07-21' },
  },
  {
    kind: 'workflow',
    id: 'site-health.yml',
    what: 'Daily site link/asset/sitemap resolve + the engine-review drift guard.',
    claim: { kind: 'accepted', why: 'SHA-pinned; read-only external fetches; the GSC + web-analytics digest legs are read-only-scoped credentials that quietly skip when unset.', since: '2026-07-21' },
  },
  {
    kind: 'workflow',
    id: 'website-deploy.yml',
    what: 'Deploy-on-merge: any website push to main auto-publishes to Cloudflare Pages.',
    claim: { kind: 'accepted', why: 'triggered only by pushes to main (trusted code); publishes with a Pages-scoped CLOUDFLARE_API_TOKEN; SHA-pinned.', since: '2026-07-21' },
    note: 'Part B: a check that the deploy token is Pages-scoped only (least-privilege), not account-wide.',
  },
  {
    kind: 'workflow',
    id: 'portal-deploy.yml',
    what: 'Deploy-on-merge for the web portal (S214): any portal/ push to main builds (tsc + Vite), passes the D2 deploy gate (S218 — CORS keystone + portal-deploy-gate.mjs: dist secret hygiene, logged-out render, an ANONYMOUS-session route sweep over the built dist with seeded own-row data + the remote_flags read pinned, zero console errors, chat composer present but never submitted), then publishes to the soletax-portal Pages project (<PORTAL_HOST>).',
    claim: { kind: 'accepted', why: 'same shape as website-deploy: pushes to main only (trusted code); the same Pages-scoped CLOUDFLARE_API_TOKEN; SHA-pinned actions; npm ci against a committed lockfile with min-release-age=7. The D2 gate adds NO credentials to Actions — it signs in anonymously with the publishable key the bundle already ships (the Management API token stays out of CI, the standing pentest rule); each run leaves one anonymous auth user behind (the rls-isolation precedent) and deletes its rows.', since: '2026-08-12' },
    note: 'The portal itself holds no secrets — public client keys only (the Supabase publishable key + the RevenueCat Web Billing rcb_ key when it lands, both public by design); RLS/RC entitlements are the enforcement layers. Its origin CSP pins connect-src to the Supabase host over https AND wss (S215: the Realtime socket — CSP schemes don\'t cross-match, so wss is listed explicitly) plus, since portal session 8 (billing), api.revenuecat.com + e.revenue.cat + Stripe\'s own published Stripe.js directive set (script/frame js.stripe.com + *.js.stripe.com, frame hooks.stripe.com for 3DS, connect api.stripe.com, img/font da08ctfrofx1b.cloudfront.net — RC\'s checkout asset CDN, read from the shipped purchases-js bundle). style-src carries \'unsafe-inline\' because RC\'s checkout injects component styles at runtime (Svelte) — a deliberate, recorded trade: script-src stays locked to self + Stripe\'s hosts, and style injection without script execution is the low rung of that ladder. No wildcards beyond Stripe\'s own *.js.stripe.com. Since S215 session 9 the origin also registers a service worker (portal/public/sw.js — the PWA shell): same-origin GETs only, navigations network-first (deploys never served stale), hashed /assets cache-first, third-party hosts (Supabase/RC/Stripe) explicitly untouched; sw.js ships with Cache-Control: no-cache so a deployed SW replaces the browser\'s copy on next load. ★ SESSION-10 HARDENING PASS DONE (S216, 2026-08-14): (1) SW code-reviewed against the claims above — verbatim true (same-origin GETs only, network-first navigations with an ok-guard so error pages never enter the cache, hashed /assets cache-first, third-party hosts untouched); (2) SESSION-STORAGE POSTURE (recorded decision): supabase-js persists the auth session (access + refresh JWT) in localStorage on this origin — the standard SPA posture, accepted: the threat class is XSS, and the mitigations are the strict CSP above (script-src pinned to self + Stripe\'s hosts, no inline/eval), zero privileged keys client-side (publishable keys only), server-side enforcement (RLS + RC entitlements) behind every read, and short-lived access tokens rotated via refresh. An HttpOnly-cookie session would need a server session layer the portal deliberately does not have; revisit only if one arrives. The dock/UI sessionStorage flags hold no data. (3) RATE-LIMIT REVIEW: every model-invoking browser-callable fn carries per-user hour/day/month caps with scoped 429s (claude-extract 120/100/500 · support-agent 60/100/1000 · send-invoice 20/50/300); delete-account deliberately uncapped (destructive one-shot, authN + BOLA probed); auth OTP/magic-link rides Supabase\'s platform limits, exercised daily by the edge-health magic-link probe. (4) rls-isolation extended (47 checks live): support_sessions cross-tenant sweep + the allocator RPC — see those entries. (5) THE FILING ROOM (S230, 2026-10-02): connect-src also names the HMRC ingress, <HMRC_INGRESS_HOST> — every hmrc-submit call from the portal travels through it (the ingress reads the browser\'s TCP source port for HMRC\'s WEB_APP_VIA_SERVER set); HMRC\'s own sign-in is a top-level navigation, which connect-src does not govern. portal/public/_headers carries the directive; no other host was added.',
  },

  // ── Worker routes (workers/<worker>/src/index.mjs) ──────────────────────────
  {
    kind: 'worker-route',
    id: 'fleet-clock:/',
    what: 'Public GET → a static description string ("SoleTax fleet clock… No data lives here.").',
    claim: { kind: 'not-applicable', why: 'no data, no mutation, no auth surface — a constant string.' },
  },
  // fleet-clock:/act RETIRED 2026-07-21 with the button rail (the button
  // doctrine) — the route is gone from the Worker source, so discovery no
  // longer finds it; the worker-act probe asserts it answers 404 and serves
  // no confirm form, so a regression re-opening the rail goes red.
  {
    kind: 'worker-route',
    id: 'fleet-clock:/test/*',
    what: 'Admin test lever: POST /test/dispatch/<workflow>, /test/watchdog/<first|final>, and /test/email-sim (runs the deployed DKIM fence on supplied headers — no mail sent), guarded by a CLOCK_ADMIN_KEY bearer.',
    claim: { kind: 'probe', probe: 'worker-act' },
    note: 'worker-act probes the admin gate: no bearer and a wrong bearer both → 401 (before any dispatch), and a non-POST → 405. It never sends the real CLOCK_ADMIN_KEY, so nothing is dispatched.',
  },
  {
    kind: 'worker-route',
    id: 'fleet-clock:/mail',
    what: 'The email bridge\'s read model (§2b, S199): GET-only list of KV-stored bridge mail (accepted digests; ?rejected=1 lists headers-only rejects), guarded by a MAIL_READ_KEY bearer. The inbound leg is the Worker\'s email() handler (two lanes on the envelope recipient — <ALERT_EMAIL> = the SOS digest lane, <DMARC_EMAIL> = the B8 DMARC lane — via Email Routing) — not URL-addressable, so not route-discovered; its DKIM fence is the mail-fence probe, its store the FLEET_MAIL KV binding below.',
    claim: { kind: 'probe', probe: 'worker-act' },
    note: 'worker-act: missing + wrong bearer → 401, non-GET → 405. Contents at risk behind the gate = copies of two public PR newsletters (the §2b blast-radius argument).',
  },
  {
    kind: 'worker-route',
    id: 'fleet-clock:/dmarc',
    what: 'The DMARC evidence instrument\'s read model (hardening item B8, S218): GET-only list of parsed rua aggregate-report SUMMARIES (counts + failing sources — never raw report bytes, never instructions) under the dmarc: KV prefix, guarded by the same MAIL_READ_KEY bearer as /mail. The inbound leg is the email() handler\'s dmarc@ lane: fail-closed DKIM fence over DMARC_REPORTER_DOMAINS (dmarc.mjs), so a forged "all passing" report cannot launder the p=quarantine flip evidence; the flip itself is session-only (the dmarc-quarantine clock), never automated.',
    claim: { kind: 'probe', probe: 'worker-act' },
    note: 'worker-act: missing + wrong bearer → 401, non-GET → 405; the parser + fence logic is the dmarc-parser probe. Contents at risk behind the gate = aggregate mail-authentication counts about our own domain (who sent as <WEBSITE_HOST>, pass/fail) — no message content, no user data.',
  },
  {
    kind: 'worker-route',
    id: 'fleet-clock:/uptime',
    what: 'The 15-min uptime probe\'s read model (hardening C2, S218): GET-only per-target state (fails, alertedAt) + the recent down/up event ledger from the uptime: KV keys, guarded by the same MAIL_READ_KEY bearer as /mail. The probe itself runs in scheduled() on every quarter-hour cron firing (src/uptime.mjs): shallow unauthenticated liveness over Supabase auth, the PostgREST remote_flags read (the publishable key only — public by design), and the two edge fns where 401 IS the healthy answer (auth enforced, zero model cost); alert + all-clear emails ride the watchdog\'s existing Resend path after 2 consecutive failures.',
    claim: { kind: 'probe', probe: 'worker-act' },
    note: 'worker-act: missing + wrong bearer → 401, non-GET → 405; the state machine + cron-coverage pin is the uptime-probe drill (in test:tax). Contents at risk behind the gate = up/down history of our own public endpoints — no user data, no secrets (the probe sends none).',
  },

  // ── Secrets / credentials (referenced by a workflow secrets.X or a Worker env.X)
  // All share the same attack-relevant property: the VALUE must never enter the
  // repo — gitleaks is the standing probe over the whole set. Rotation: the whole
  // CI/Worker set joins the annual April rotation (reference_env_local_tokens).
  // The GitHub built-in GITHUB_TOKEN is not a repo secret and is skipped by the gate.
  { kind: 'secret', id: 'ANTHROPIC_API_KEY', what: 'Claude API key — the AI fleet + Claude proxies.', claim: { kind: 'probe', probe: 'gitleaks' } },
  { kind: 'secret', id: 'OPENAI_API_KEY', what: 'OpenAI key — the AI share-of-voice panel.', claim: { kind: 'probe', probe: 'gitleaks' } },
  { kind: 'secret', id: 'GEMINI_API_KEY', what: 'Gemini key — the AI share-of-voice panel.', claim: { kind: 'probe', probe: 'gitleaks' } },
  { kind: 'secret', id: 'PERPLEXITY_API_KEY', what: 'Perplexity key — the AI share-of-voice panel.', claim: { kind: 'probe', probe: 'gitleaks' } },
  { kind: 'secret', id: 'RESEND_API_KEY', what: 'Resend key — the briefing + alert + report-notify email path (workflows AND the Worker).', claim: { kind: 'probe', probe: 'gitleaks' } },
  { kind: 'secret', id: 'HMRC_CLIENT_ID', what: 'HMRC OAuth client id (sandbox).', claim: { kind: 'probe', probe: 'gitleaks' } },
  { kind: 'secret', id: 'HMRC_CLIENT_SECRET', what: 'HMRC OAuth client secret — never ships in the app binary (the via-server lock).', claim: { kind: 'probe', probe: 'gitleaks' } },
  { kind: 'secret', id: 'HMRC_USER_REFRESH', what: 'The SINGLE-USE HMRC user refresh token — rotates on every evidence run; CI-owned.', claim: { kind: 'probe', probe: 'gitleaks' }, note: '⚠ never run two copies of the sweep concurrently; local runs are retired.' },
  { kind: 'secret', id: 'HMRC_TEST_NINO', what: 'HMRC sandbox test National Insurance number.', claim: { kind: 'probe', probe: 'gitleaks' } },
  { kind: 'secret', id: 'HMRC_FPH_DEVICE_ID', what: 'Fraud-prevention-header device id — the MAC context only since 2026-08-19 (no longer CI-wired; lives on in .env.local for the local scripts).', claim: { kind: 'probe', probe: 'gitleaks' } },
  { kind: 'secret', id: 'HMRC_FPH_CI_DEVICE_ID', what: 'CI\'s own FPH device id — a real generated UUIDv4 persisted as a repo secret (HMRC\'s 2026-08-19 review flagged the old hash-derived pseudo-UUID; spec wants generated-and-stored).', claim: { kind: 'probe', probe: 'gitleaks' } },
  { kind: 'secret', id: 'FLEET_SECRETS_PAT', what: 'GitHub PAT that reseals the rotated HMRC token back into repo secrets.', claim: { kind: 'probe', probe: 'gitleaks' } },
  // FLEET_ACTION_KEY retired 2026-07-21 with the button rail — unwired from all
  // workflows; delete the stored GitHub + Worker secret values at leisure.
  { kind: 'secret', id: 'CLOUDFLARE_ACCOUNT_ID', what: 'Cloudflare account id for deploys.', claim: { kind: 'probe', probe: 'gitleaks' } },
  { kind: 'secret', id: 'REVIEW_ACCOUNT_EMAIL', what: 'The ONE allowlisted Apple App Review demo-account address (review-signin edge fn).', claim: { kind: 'probe', probe: 'gitleaks' }, note: 'Not actually sensitive (it goes in the ASC demo-account field) — held as a secret so the allowlist is config, not code.' },
  { kind: 'secret', id: 'REVIEW_ACCOUNT_CODE', what: 'The fixed review sign-in code (review-signin edge fn) — rotates after each Apple review cycle.', claim: { kind: 'probe', probe: 'gitleaks' }, note: 'Blast radius: the seeded demo account only. Local copy in .env.local; goes in the ASC demo-account field.' },
  { kind: 'secret', id: 'CLOUDFLARE_API_TOKEN', what: 'Cloudflare API token — Pages publish (website-deploy + portal-deploy).', claim: { kind: 'probe', probe: 'gitleaks' } },
  { kind: 'secret', id: 'SUPABASE_URL', what: 'Supabase project URL — the RLS isolation test.', claim: { kind: 'probe', probe: 'gitleaks' } },
  { kind: 'secret', id: 'SUPABASE_ANON_KEY', what: 'Supabase anon key — the RLS isolation test (client-role check).', claim: { kind: 'probe', probe: 'gitleaks' } },
  { kind: 'secret', id: 'SUPABASE_S3_ACCESS_KEY_ID', what: 'Supabase S3 access key — storage backup path.', claim: { kind: 'probe', probe: 'gitleaks' } },
  { kind: 'secret', id: 'SUPABASE_S3_SECRET_ACCESS_KEY', what: 'Supabase S3 secret — storage backup path.', claim: { kind: 'probe', probe: 'gitleaks' } },
  { kind: 'secret', id: 'R2_ACCESS_KEY_ID', what: 'Cloudflare R2 access key — encrypted backup destination.', claim: { kind: 'probe', probe: 'gitleaks' } },
  { kind: 'secret', id: 'R2_SECRET_ACCESS_KEY', what: 'Cloudflare R2 secret — encrypted backup destination.', claim: { kind: 'probe', probe: 'gitleaks' } },
  { kind: 'secret', id: 'R2_ENDPOINT', what: 'Cloudflare R2 endpoint URL for backups.', claim: { kind: 'probe', probe: 'gitleaks' } },
  { kind: 'secret', id: 'BACKUP_READER_PASSWORD', what: 'Password gating the backup-reader path.', claim: { kind: 'probe', probe: 'gitleaks' } },
  { kind: 'secret', id: 'REVENUECAT_FLEET_KEY', what: 'RevenueCat v2 secret key, READ-only customer rows (growth census, S222) — a dedicated fleet-tier mint, never the Mac\'s soletax-mac-read key (environment.md C20 custody). Empty until minted; the census degrades to SQL-only.', claim: { kind: 'probe', probe: 'gitleaks' } },
  { kind: 'secret', id: 'COMPANIES_HOUSE_API_KEY', what: 'Companies House API key — the incorporation/name watch.', claim: { kind: 'probe', probe: 'gitleaks' } },
  { kind: 'secret', id: 'SENTRY_READ_TOKEN', what: 'Sentry read token — crash-report reads for the fleet.', claim: { kind: 'probe', probe: 'gitleaks' } },
  { kind: 'secret', id: 'REDDIT_CLIENT_ID', what: 'Reddit app client id — listening leg (declared-disabled until API approval).', claim: { kind: 'probe', probe: 'gitleaks' } },
  { kind: 'secret', id: 'REDDIT_CLIENT_SECRET', what: 'Reddit app client secret — listening leg (declared-disabled).', claim: { kind: 'probe', probe: 'gitleaks' } },
  { kind: 'secret', id: 'GOOGLE_ALERT_FEEDS', what: 'The set of Google Alerts RSS feed URLs the listening watch reads.', claim: { kind: 'probe', probe: 'gitleaks' } },
  { kind: 'secret', id: 'HEALTHCHECK_URL', what: 'Dead-man\'s-switch ping URL for a scheduled job.', claim: { kind: 'probe', probe: 'gitleaks' } },
  { kind: 'secret', id: 'CLOUDFLARE_ANALYTICS_API_TOKEN', what: 'Cloudflare API token scoped to Account Analytics:Read ONLY (the site-health web-analytics digest, S188). Expires 30 Apr 2027; lives in Actions secrets AND .env.local (two-place rotation).', claim: { kind: 'probe', probe: 'gitleaks' }, note: 'Read-only aggregate traffic stats — worst case it reads our own pageview counts. Cannot write, cannot touch DNS/Pages/Workers.' },
  { kind: 'secret', id: 'SENTRY_ORG_READ_TOKEN', what: 'Sentry Personal Token "SoleTax reader" (minted 2026-08-18, S218 — the first platform-reader under Jamie\'s one-read-everything-token-per-platform ruling): org:read + project:read + event:read + member:read + team:read + alerts:read, NO write/admin. .env.local only; April re-mint convention.', claim: { kind: 'probe', probe: 'gitleaks' }, note: 'Read-only across the org — a leaker could read error events/alert config (operational data, no user financial records) but cannot resolve issues, silence alerts, or touch settings. Minted because the new alerts platform (detectors/workflows) needs org:read, which the deliberately-narrow S198 tokens lack; used for the C3 verification.' },
  { kind: 'secret', id: 'STAGING_DB_PASSWORD', what: 'Postgres password for the soletax-staging project (hardening D1, S218) — the staging ritual\'s restore/reset connection. .env.local only, never in CI.', claim: { kind: 'probe', probe: 'gitleaks' }, note: '⚠ Staging holds a COPY OF PROD USER DATA after each ritual run (that is the point — a toy dataset rehearses nothing), so this credential is inside the same perimeter as prod\'s: same region, RLS restored from the same dump, sweeps prove isolation on the copy (rls-isolation 54/54 on staging, 18 Aug). The project auto-pauses free-plan idle after ~7 days, shrinking the live window between rituals.' },
  { kind: 'secret', id: 'STAGING_SUPABASE_REF', what: 'Project ref of soletax-staging (<SUPABASE_SCRATCH_PROJECT_REF>) — not itself a credential; declared so the second Supabase project is on the register and the discovery scan stays bidirectionally honest.', claim: { kind: 'probe', probe: 'gitleaks' }, note: 'scripts/staging-ritual.mjs refuses to run if this equals the prod ref (the destructive reset can only ever see staging).' },
  { kind: 'secret', id: 'GSC_CREDENTIALS', what: 'Base64 Google service-account JSON for the site-health Search Console digest (read-only webmasters scope; <GCP_SERVICE_ACCOUNT>, Restricted user on <WEBSITE_HOST>).', claim: { kind: 'probe', probe: 'gitleaks' }, note: 'Read-only Search Console access only — worst case it reads our own search stats. Shared in a chat once (S176), so rotate at the next credential cycle.' },
  { kind: 'secret', id: 'CLOCK_ADMIN_KEY', what: 'Worker bearer guarding fleet-clock /test/*.', claim: { kind: 'probe', probe: 'gitleaks' } },
  { kind: 'secret', id: 'MAIL_READ_KEY', what: 'Bearer guarding fleet-clock GET /mail (the email bridge read model, S199). Lives as a Worker secret AND a repo Actions secret (the journo radar reads with it). April rotation.', claim: { kind: 'probe', probe: 'gitleaks' }, note: 'Worst case if leaked: read access to stored copies of two public PR newsletters — the deliberately tiny §2b blast radius.' },
  { kind: 'secret', id: 'FLEET_MAIL', what: 'Not a credential: the fleet-clock Worker\'s KV namespace BINDING for bridge mail (env.FLEET_MAIL matches the secret-discovery pattern). Accepted digests 30-day TTL; rejected mail headers-only, 7-day TTL.', claim: { kind: 'probe', probe: 'gitleaks' }, note: 'Declared so the discovery scan stays bidirectionally honest; gitleaks covers the none-case (no value exists to leak).' },
  { kind: 'secret', id: 'GITHUB_DISPATCH_PAT', what: 'Worker PAT (Actions RW + Contents R, soletax-only) that dispatches each beat on time.', claim: { kind: 'probe', probe: 'gitleaks' }, note: 'The approved worker-pat-narrowing proposal will drop Contents:Read for a KV sent-marker.' },
  // Edge-function secrets (Deno.env.get in supabase/functions) — added S175 after
  // the review found the MOST POWERFUL credentials were entirely un-inventoried.
  // These are Supabase function secrets (supabase secrets set), never in the repo.
  { kind: 'secret', id: 'SUPABASE_SERVICE_ROLE_KEY', what: '⚠ THE crown-jewel key — full RLS BYPASS. Used by every edge function server-side; never on the device (the anon key is the only client key).', claim: { kind: 'probe', probe: 'no-service-role-in-bundle' }, note: 'no-service-role-in-bundle greps src/, website/ and the Expo config so the key\'s name/value can never ship to a client (the EXPO_PUBLIC_ inlining trap); gitleaks still runs repo-wide on every push for value-in-repo secrecy, and the pentest T-TK/T-AC prove the client never reads it at runtime.' },
  { kind: 'secret', id: 'HMRC_TOKEN_KEY', what: '⚠ AES-256-GCM key that decrypts EVERY user\'s stored HMRC tokens (hmrc_connections). Server-side only.', claim: { kind: 'probe', probe: 'gitleaks' }, note: 'T-TK-3 proves stored tokens are ciphertext, not plaintext; the key itself lives only in Supabase secrets.' },
  { kind: 'secret', id: 'HMRC_INGRESS_SECRET', what: 'The HMRC ingress envelope secret (S225, infra/hmrc-ingress): hmrc-submit trusts the forwarded client IP / TCP source port / receipt time only when this matches (constant-time) AND the request reached Supabase from the ingress\'s own address.', claim: { kind: 'probe', probe: 'gitleaks' }, note: 'Lives in Supabase secrets + /etc/caddy/ingress.env on the ingress (0600, root) + .env.local (environment.md C34). hmrc-pentest T-IG-2a/2b: a wrong secret → 428; the REAL secret presented from a non-ingress origin → 403 — a leaked secret alone opens nothing.' },
  { kind: 'secret', id: 'HMRC_INGRESS_HOST', what: 'Not a credential — the ingress hostname (<HMRC_INGRESS_HOST>). Its presence switches hmrc-submit into envelope-REQUIRED mode for every HMRC-calling action, so no path can produce a port-less header set.', claim: { kind: 'not-applicable', why: 'a public hostname, declared because the gate discovers every Deno.env.get; the secret above is the credential.' } },
  { kind: 'secret', id: 'HMRC_INGRESS_EGRESS_IPS', what: 'Not a credential — optional extra addresses the ingress may egress from (unioned with the resolved A/AAAA of HMRC_INGRESS_HOST for the origin belt).', claim: { kind: 'not-applicable', why: 'public addresses, declared because the gate discovers every Deno.env.get.' } },
  { kind: 'secret', id: 'REPORT_NOTIFY_SECRET', what: 'Shared secret the pg_net trigger sends as x-report-secret; report-notify does nothing without it.', claim: { kind: 'probe', probe: 'gitleaks' }, note: 'T-RN proves a missing/wrong value is rejected 401.' },
  { kind: 'secret', id: 'WELCOME_EMAIL_SECRET', what: 'Shared secret the pg_net trigger sends as x-welcome-secret; welcome-email does nothing without it (the REPORT_NOTIFY_SECRET idiom).', claim: { kind: 'probe', probe: 'gitleaks' }, note: 'Vault name welcome_email_secret on the trigger side; same 401-on-missing/wrong gate as report-notify.' },
  { kind: 'secret', id: 'TRIAL_REMINDER_SECRET', what: 'Shared secret the pg_cron runner sends as x-trial-secret; trial-reminder does nothing without it (the REPORT_NOTIFY_SECRET idiom, S223 late).', claim: { kind: 'probe', probe: 'gitleaks' }, note: 'Vault name trial_reminder_secret + the edge env, same value; regenerate both together (openssl rand -hex 32) if ever lost — they only need to match each other.' },
  { kind: 'secret', id: 'MAPKIT_JS_KEY_P8', what: 'Apple MapKit JS private key ("SoleTax MapKit JS", Key ID <MAPKIT_KEY_ID>, Maps ID maps.io.soletax.web — environment.md C33), held as one edge-env line with literal \\n; mapkit-token signs 30-minute origin-bound tokens with it. One-time download from Apple: the durable copies are 1Password + ~/.mapkit on the Mac + .env.local (rides backup:native).', claim: { kind: 'probe', probe: 'gitleaks' }, note: 'Revoke at developer.apple.com → Keys if ever exposed and mint a successor (two keys per Maps ID are allowed, so the swap is zero-downtime).' },
  { kind: 'secret', id: 'MAPKIT_JS_KEY_ID', what: 'The MapKit JS key identifier (the JWT kid) — public-ish, paired with the .p8.', claim: { kind: 'probe', probe: 'gitleaks' } },
  { kind: 'secret', id: 'MAPKIT_TEAM_ID', what: 'The Apple Team ID (the JWT iss) — public, on every App Store listing.', claim: { kind: 'probe', probe: 'gitleaks' } },
  { kind: 'secret', id: 'REVENUECAT_FLEET_KEY', what: 'The fleet-tier RevenueCat v2 READ key, in the edge env for trial-reminder\'s paying check (the same mint the data-invariants workflow holds as a GitHub secret). Missing → the fn runs not-armed and sends nothing.', claim: { kind: 'probe', probe: 'gitleaks' }, note: 'Never the Mac\'s soletax-mac-read key (environment.md C20). Pasted into the edge env by Jamie from 1Password (clock trial-reminder-rc-key).' },
  { kind: 'secret', id: 'SIGNUP_NOTIFY_SECRET', what: 'Shared secret the auth.users triggers send as x-signup-secret; signup-notify does nothing without it (the REPORT_NOTIFY_SECRET idiom, S222).', claim: { kind: 'probe', probe: 'gitleaks' }, note: 'Vault name signup_notify_secret on the trigger side; same 401-on-missing/wrong gate as report-notify.' },
  { kind: 'secret', id: 'REPORT_FROM', what: 'The verified Resend From address for report emails (config, not a credential).', claim: { kind: 'probe', probe: 'gitleaks' } },
  { kind: 'secret', id: 'HMRC_BASE_URL', what: 'Env-configured HMRC API host — the sandbox→production switch (no code change). This is how the deferred production egress host goes live.', claim: { kind: 'probe', probe: 'gitleaks' }, note: 'Declaring it here is the answer to the "env-var host evades outbound discovery" review finding: the host switch is a triaged config element, and outbound:api.service.hmrc.gov.uk stays deferred until it flips.' },
  { kind: 'secret', id: 'HMRC_AUTH_URL', what: 'Env-configured HMRC OAuth authorize host — the sandbox→production switch.', claim: { kind: 'probe', probe: 'gitleaks' } },
  // ★ Production hardening (go-live plan phase 1, S230 2026-10-02): the sandbox
  // pair above keeps its names (the CI evidence sweep reads them); production
  // gets _PROD twins and a master switch. _shared/hmrcEnv.ts picks per account.
  { kind: 'secret', id: 'HMRC_PRODUCTION_ENABLED', what: 'Not a credential — the production master switch (A1): exactly "true" turns production on for every account not marked sandbox in hmrc_account_modes; unset keeps everyone on HMRC\'s test service. Phase 1 deploys with it UNSET; Jamie\'s go flips it (plan phase 4/5).', claim: { kind: 'not-applicable', why: 'a boolean flag, declared because the gate discovers every Deno.env.get; scripts/test-hmrc-server.ts pins that anything but "true"/"1"/"on" means off.' } },
  { kind: 'secret', id: 'HMRC_CLIENT_ID_PROD', what: 'HMRC OAuth client id (PRODUCTION application 768e19f0…, granted 29 Sep 2026). In 1Password until Jamie\'s go; then Supabase secrets only.', claim: { kind: 'probe', probe: 'gitleaks' } },
  { kind: 'secret', id: 'HMRC_CLIENT_SECRET_PROD', what: '⚠ HMRC PRODUCTION client secret — "the equivalent of a password" (HMRC). Never in a binary, never in a log; hmrc-submit REFUSES production calls (503 PRODUCTION_NOT_CONFIGURED) rather than fall back to sandbox when it is missing.', claim: { kind: 'probe', probe: 'gitleaks' }, note: 'Up to 5 secrets may exist on the Hub application; rotate by minting the successor first (zero-downtime), then revoking.' },
  { kind: 'secret', id: 'HMRC_BASE_URL_PROD', what: 'Optional override of HMRC\'s production API host (defaults to https://api.service.hmrc.gov.uk in _shared/hmrcEnv.ts).', claim: { kind: 'not-applicable', why: 'a public hostname, declared because the gate discovers every Deno.env.get.' } },
  { kind: 'secret', id: 'HMRC_AUTH_URL_PROD', what: 'Optional override of HMRC\'s production sign-in host (defaults to https://www.tax.service.gov.uk/oauth/authorize).', claim: { kind: 'not-applicable', why: 'a public hostname, declared because the gate discovers every Deno.env.get.' } },
  { kind: 'secret', id: 'PORTAL_URL', what: 'Not a credential — where hmrc-oauth-callback returns a PORTAL-originated HMRC sign-in (defaults to https://<PORTAL_HOST>; the Tax page reads ?hmrc=connected|denied|error).', claim: { kind: 'not-applicable', why: 'our own public origin, declared because the gate discovers every Deno.env.get.' } },

  // ── Outbound integrations (external hosts an EDGE FUNCTION talks to) ─────────
  // The gate discovers hosts in supabase/functions/**; declared client-side hosts
  // (Mixpanel/Sentry/RevenueCat/Maps) are extras — the app is a different trust
  // boundary and is not filesystem-discovered here.
  { kind: 'outbound', id: 'api.anthropic.com', what: 'Claude model calls — claude-extract, claude-import-map, support-agent.', claim: { kind: 'accepted', why: 'first-party AI provider; server-side ANTHROPIC key; no user PII beyond the request payload.', since: '2026-07-21' } },
  { kind: 'outbound', id: '<PORTAL_HOST>', what: 'NOT egress — the portal origin literal in _shared/cors.ts ALLOWED_ORIGINS (the exact-origin CORS grant, S214). No function ever makes a request to it.', claim: { kind: 'not-applicable', why: 'an inbound Origin-header allowlist value, not an outbound call; the grant behaviour itself is probed (T-CO) and statically gated (scripts/test-portal-cors.ts).' } },
  { kind: 'outbound', id: 'api.resend.com', what: 'Transactional email — report-notify + welcome-email + send-invoice + signup-notify + trial-reminder (+ the fleet email path).', claim: { kind: 'accepted', why: 'first-party email provider; server-side RESEND key.', since: '2026-07-21' } },
  { kind: 'outbound', id: 'api.revenuecat.com', what: 'RevenueCat v2 customer read (active_entitlements) — trial-reminder skips anyone already paying; the same read the nightly growth census makes from CI.', claim: { kind: 'accepted', why: 'first-party billing provider; READ-only with the fleet-tier key (REVENUECAT_FLEET_KEY, never the Mac\'s soletax-mac-read key — environment.md C20 custody); the uid is the only thing sent.', since: '2026-09-04' } },
  { kind: 'outbound', id: 'www.gov.uk', what: 'NOT egress: the GOV.UK links the filing turnaways hand the client as a next step ("GOV.UK\'s software list", "How to sign up") in _shared/hmrcErrors.ts (S230). No function ever fetches them; the client opens them in the browser.', claim: { kind: 'not-applicable', why: 'link-only strings in customer copy, discovered because the host literal sits in an edge-function module.' } },
  { kind: 'outbound', id: '<WEBSITE_HOST>', what: 'NOT egress: the unsubscribe link URL embedded in the welcome email body (<WEBSITE_HOST>/unsubscribe → Pages _redirects → the fn\'s GET). The fn never fetches it.', claim: { kind: 'accepted', why: 'our own domain, link-only — moved onto the sender\'s domain because a mismatched link host is a spam signal (the first test landed in junk).', since: '2026-07-23' } },
  { kind: 'outbound', id: 'test-api.service.hmrc.gov.uk', what: 'HMRC sandbox MTD APIs — hmrc-submit.', claim: { kind: 'accepted', why: 'HMRC\'s own sandbox; the whole reason the via-server architecture exists.', since: '2026-07-21' } },
  { kind: 'outbound', id: 'test-www.tax.service.gov.uk', what: 'HMRC sandbox OAuth authorize endpoint — the connect flow / hmrc-oauth-callback.', claim: { kind: 'accepted', why: 'HMRC\'s own OAuth host.', since: '2026-07-21' } },
  // api.ipify.org REMOVED 2026-07-27 (FPH audit A1): the egress-IP lookup was the
  // wrong value for Gov-Vendor-Public-IP (spec wants the INGRESS the device sent
  // to) — hmrc-submit now resolves its own request host's public A record via
  // 1.1.1.1 (plain DNS, not an HTTP egress), falling back to the DoH host below.
  { kind: 'outbound', id: 'cloudflare-dns.com', what: 'DNS-over-HTTPS FALLBACK for the Gov-Vendor-Public-IP ingress lookup (hmrc-submit) — resolves our own hostname\'s public A record when direct DNS to 1.1.1.1 is unavailable.', claim: { kind: 'accepted', why: 'only our own hostname is sent; the public-resolver view is spec-required (the platform resolver returns the internal origin view no device ever dials).', since: '2026-07-27' } },
  { kind: 'outbound', id: '1.1.1.1', what: 'Plain DNS (port 53, Deno.resolveDns nameServer) — the PRIMARY path for the same ingress lookup; not an HTTP fetch, declared first-class so no reviewer finds the fallback host without the primary dial.', claim: { kind: 'accepted', why: 'a DNS query for our own hostname to Cloudflare\'s public resolver; carries no user data.', since: '2026-07-27' } },
  { kind: 'outbound', id: 'api.service.hmrc.gov.uk', what: 'HMRC PRODUCTION MTD APIs — in code since S230 (2 Oct 2026) as _shared/hmrcEnv.ts HMRC_HOSTS.production.api, reachable only when HMRC_PRODUCTION_ENABLED reads "true" and the account is not marked sandbox.', claim: { kind: 'deferred', until: 'Jamie\'s go on HMRC_PRODUCTION_ENABLED (go-live plan phases 4–5, aim 7 Nov 2026; this weekend if the build lands). Same probe surface as the sandbox host — fold hmrc-pentest onto prod when it goes live.' }, note: 'Declared ahead of use so the host cannot appear in an edge function un-triaged; test-hmrc-server pins that the switch off → every account sandbox.' },
  { kind: 'outbound', id: 'www.tax.service.gov.uk', what: 'HMRC PRODUCTION OAuth authorize endpoint — _shared/hmrcEnv.ts HMRC_HOSTS.production.authorize; the connect flow builds the authorize URL against it and hmrc-oauth-callback exchanges the code with the matching production credentials (the environment rides the signed state).', claim: { kind: 'deferred', until: 'the same go as api.service.hmrc.gov.uk.' }, note: 'HMRC\'s own OAuth host, the production twin of test-www.' },
  { kind: 'outbound', id: '<HMRC_INGRESS_HOST>', what: 'NOT edge-fn egress — INGRESS: the host the app + the edge spike dial for hmrc-submit (S225). A Caddy server SoleTax controls (infra/hmrc-ingress) that terminates TLS, reads the TCP peer port (Gov-Client-Public-Port — unobservable behind the Supabase/Cloudflare edge) and reverse-proxies to the function under the envelope secret. Public internet-facing surface: 443 (Caddy), 80 (ACME), 22 (key-only, ufw-limited).', claim: { kind: 'probe', probe: 'hmrc-pentest' }, note: 'LIVE 2026-09-09 (droplet 599087411, 46.101.15.148). T-IG-1 direct call without the envelope → 428 · T-IG-2a forged envelope + wrong secret → 428 · T-IG-2b the REAL secret from a foreign origin → 403 (origin belt) · T-IG-3a-c /healthz ok, / 404, other functions 404 through it · T-IG-4a JWT still enforced through the ingress (401) · T-IG-4b client-supplied envelope headers are overwritten (200, not 403). 60/60 on the first live run. Daily liveness: the edge-health agent.' },
  { kind: 'outbound', id: 'api-eu.mixpanel.com', what: 'Opt-in anonymous product analytics (client-side; EU-resident endpoint).', claim: { kind: 'accepted', why: 'client-side, opt-in per PECR, anonymous ($device id, no identify/IP geo). Not an edge-fn egress — declared for completeness.', since: '2026-07-21' } },

  // ── DB grant / RLS surface (tables + RPCs with a policy/grant in a migration) ─
  { kind: 'db-grant', id: 'income', what: 'Jobs / quotes / invoices — the sole trader\'s PRIMARY financial records (amounts, client names/addresses, job detail) — owner-scoped RLS.', claim: { kind: 'probe', probe: 'rls-isolation' }, note: '⚠ Dashboard-created table (like receipts): its RLS lives in the Supabase project, NOT in a migration, so discovery only sees it via the account-deletion grant. The active rls-isolation probe (added S175 after the review found it was claimed-but-unprobed — the single most sensitive table) is therefore the real guard: B select/update/delete → 0 rows, B insert-as-A → 42501.' },
  { kind: 'db-grant', id: 'other_income', what: 'Non-invoiced income (cash/tips/asset sale) — owner-scoped RLS.', claim: { kind: 'probe', probe: 'rls-isolation' } },
  { kind: 'db-grant', id: 'trips', what: 'Mileage trips — owner-scoped RLS; cross-tenant SELECT/INSERT probed.', claim: { kind: 'probe', probe: 'rls-isolation' } },
  { kind: 'db-grant', id: 'user_settings', what: 'Per-user singleton settings backup — owner-scoped RLS (WITH CHECK on INSERT).', claim: { kind: 'probe', probe: 'rls-isolation' }, note: 'Portal session 13 (S217): the portal WRITES the three blobs (stamped _editedAtMs, blob-level LWW with the app reconcile) under the same own-row RLS the probe covers, and the row joined the supabase_realtime publication (20260817) — realtime respects RLS like the 20260813 record tables, no new grant.' },
  { kind: 'db-grant', id: 'receipts', what: 'Expense receipts (table + the receipts storage bucket) — owner-scoped RLS + owner-scoped storage policies.', claim: { kind: 'probe', probe: 'rls-isolation' }, note: 'Dashboard-created table (not in migrations) → not filesystem-discovered; declared as a known critical extra. Storage bucket policies added in 20260702_security_hardening.sql.' },
  { kind: 'db-grant', id: 'hmrc_connections', what: 'Encrypted HMRC token store — RLS no-policies (service-role only).', claim: { kind: 'probe', probe: 'hmrc-pentest' }, note: 'T-TK-1/2/3 prove authenticated + anon read nothing and stored tokens are ciphertext, not JWT-shaped plaintext.' },
  { kind: 'db-grant', id: 'hmrc_submissions', what: 'Quarterly-update audit trail — read-own RLS. Since 20261002: + surface, connection_method, outcome_kind, outcome_code (never a figure beyond the payload, never the number).', claim: { kind: 'probe', probe: 'hmrc-pentest' }, note: 'T-AC-1/2/3 prove tenant isolation + that a client can\'t insert a row as another user.' },
  { kind: 'db-grant', id: 'hmrc_account_modes', what: 'Accounts marked for HMRC\'s TEST service once production is on (decision D2: the App Review demo account, the weekly evidence accounts) — RLS no-policies, service-role only, edited by us by SQL (20261002_hmrc_filing_live).', claim: { kind: 'probe', probe: 'hmrc-pentest' }, note: 'T-SW-1: authenticated + anon read 0 rows and cannot insert — a customer can never put themselves on the sandbox list.' },
  { kind: 'db-grant', id: 'hmrc_filing_switch', what: 'The filing ON switch per surface (app | portal): enabled / paused / allow_list — OFF by default, paused wins, enforced on every send (spec §11). RLS no-policies, service-role only (20261002_hmrc_filing_live).', claim: { kind: 'probe', probe: 'hmrc-pentest' }, note: 'T-SW-2: clients read nothing and cannot flip it; the app learns the state only through hmrc-submit status.' },
  { kind: 'db-grant', id: 'hmrc_submit_turns', what: 'Per-account send counter for the rate limit on submit (12/hour, 40/day; open item F-3) — service-role only, the admitTurn idiom.', claim: { kind: 'probe', probe: 'hmrc-pentest' }, note: 'T-SW-3: authenticated reads 0 rows.' },
  { kind: 'db-grant', id: 'support_reports', what: 'Bug / feedback / missed-trip intake — default-deny RLS.', claim: { kind: 'probe', probe: 'rls-isolation' } },
  { kind: 'db-grant', id: 'support_sessions', what: 'Ask SoleTax chat history on the sync spine (20260813, portal session 7) — full transcripts as jsonb, owner-scoped RLS (select/insert/update own, WITH CHECK; no client DELETE — deletes are tombstoning updates; service-role wipe via delete-account).', claim: { kind: 'probe', probe: 'verify-sync-spine' }, note: 'verify-sync-spine\'s five-table guard sweep inserts + stale-edits this table through the authenticated RLS path (a cross-tenant write would 42501 there); in the delete-account TABLES list same-commit. ✅ FOLDED into rls-isolation (S216, 2026-08-14): the full receipts-style cross-tenant treatment — B select/update/delete A\'s transcript 0 rows, B insert-as-A 42501, no client DELETE even for the owner (the tombstoning UPDATE is the only delete path, proven working) — 47-check run green live.' },
  { kind: 'db-grant', id: 'search_user_records', what: 'The SECURITY DEFINER records-search RPC (the p_uid BOLA vector).', claim: { kind: 'probe', probe: 'hmrc-pentest' }, note: 'Client EXECUTE revoked (20260702 + 20260720 re-revoke, re-asserted in 20260812_sync_spine\'s re-declaration); T-IN/AC-RPC + rls-isolation prove a foreign p_uid returns nothing.' },
  { kind: 'db-grant', id: 'sync_spine_guard', what: 'BEFORE INSERT/UPDATE trigger fn on the four record tables (20260812_sync_spine): the LWW guard + server_updated_at cursor stamp. NOT security definer — runs as the invoking role inside writes already scoped by owner-RLS; reads/writes only the row in flight, so it widens no tenant boundary. Since 20260818 (C4) its reject branch also calls log_sync_reject (the separate definer helper below) so a silently-lost stale write leaves an audit trace — wrapped so an audit failure degrades to the old silence, never breaking the write.', claim: { kind: 'probe', probe: 'verify-sync-spine' }, note: 'scripts/verify-sync-spine.mjs proves the guard live through the authenticated RLS path on all four tables (stale write loses / newer wins / tombstone semantics / future-clock clamp) and since C4 asserts the sync_reject audit event lands with the row + both stamps; rls-isolation continues to prove the underlying tables\' owner scoping, which the trigger cannot bypass.' },
  { kind: 'db-grant', id: 'extract_turns', what: 'Claude receipt-extract turn log — service-role write, client default-deny.', claim: { kind: 'probe', probe: 'rls-isolation' }, note: 'rls-isolation asserts an authenticated client reads 0 rows (RLS-enabled, no client policy, service-role grant only).' },
  { kind: 'db-grant', id: 'import_turns', what: 'Claude import-map turn log — service-role write, client default-deny.', claim: { kind: 'probe', probe: 'rls-isolation' }, note: 'rls-isolation asserts an authenticated client reads 0 rows.' },
  { kind: 'db-grant', id: 'support_turns', what: 'Ask-SoleTax assistant turn log — service-role write, client default-deny.', claim: { kind: 'probe', probe: 'rls-isolation' }, note: 'rls-isolation asserts an authenticated client reads 0 rows.' },
  { kind: 'db-grant', id: 'review_signin_attempts', what: 'review-signin global brute-force window — service-role only (RLS on, no policies, anon/authenticated revoked; the fn fails CLOSED when it cannot count).', claim: { kind: 'accepted', why: 'holds no user data at all (timestamps + a success flag); the extract_turns pattern with clients fully revoked — the only writer is the service-role edge fn. Fold into the rls-isolation 0-rows sweep at the next probe pass alongside the turn tables.', since: '2026-08-03', reviewBy: '2026-12-01' } },
  { kind: 'db-grant', id: 'notify_beta_signup', what: 'Trigger-internal SECURITY DEFINER webhook fn (beta-signup → pg_net).', claim: { kind: 'probe', probe: 'rls-isolation' }, note: 'rls-isolation asserts an authenticated client cannot call it (EXECUTE revoked from anon/authenticated, 20260704) — the search_user_records revoke check, extended to the notify fns.' },
  { kind: 'db-grant', id: 'notify_support_report', what: 'Trigger-internal SECURITY DEFINER webhook fn (support-report → pg_net → report-notify).', claim: { kind: 'probe', probe: 'rls-isolation' }, note: 'rls-isolation asserts an authenticated client cannot call it (EXECUTE revoked, 20260703).' },
  { kind: 'db-grant', id: 'welcome_emails', what: 'Founder-welcome send ledger + unsubscribe suppression — RLS no-policies (service-role only).', claim: { kind: 'accepted', why: 'no client grant exists (service_role only, RLS enabled with zero policies — the extract_turns shape); holds no content, only send/suppress timestamps + the unsub token.', since: '2026-07-23' }, note: 'Add to the rls-isolation zero-rows list at the next probe sweep.' },
  { kind: 'db-grant', id: 'notify_welcome_email', what: 'Trigger-internal SECURITY DEFINER webhook fn (first user_settings insert → pg_net → welcome-email).', claim: { kind: 'accepted', why: 'EXECUTE revoked from public/anon/authenticated in 20260723 (the notify_support_report idiom); body only ever forwards the row\'s own user_id.', since: '2026-07-23' }, note: 'Add to rls-isolation\'s cannot-call list at the next probe sweep.' },
  { kind: 'db-grant', id: 'signup_notifications', what: 'Instant-signup-email dedupe ledger (S222) — RLS no-policies (service-role only).', claim: { kind: 'accepted', why: 'no client grant exists (service_role only, RLS enabled with zero policies — the welcome_emails shape); holds only user_id + email + a timestamp, claimed INSERT-or-skip by the trigger so confirmed-state churn can never double-email.', since: '2026-09-01' }, note: 'Add to the rls-isolation zero-rows list at the next probe sweep. Erasure: rows cascade on auth.users delete.' },
  { kind: 'db-grant', id: 'trial_reminders', what: 'Trial-ending email dedupe ledger (web reminders leg 1, 20260904) — RLS no-policies (service-role only; backup_reader SELECT for the nightly census).', claim: { kind: 'accepted', why: 'no client grant exists (service_role + the read-only census role, RLS enabled with zero policies — the signup_notifications shape); holds only user_id + email + a timestamp, claimed by the fn BEFORE each send; erased by delete-account (TABLES) and cascades with auth.users.', since: '2026-09-04' } },
  { kind: 'db-grant', id: 'trial_reminder_runs', what: 'The trial-reminder fn\'s run log (one row per daily run: mode, candidates, sent, skipped) — RLS no-policies (service-role insert; backup_reader SELECT for the census).', claim: { kind: 'accepted', why: 'no client grant exists; carries counts only, never a user id or an address; the briefing\'s "not-armed" line reads it.', since: '2026-09-04' } },
  { kind: 'db-grant', id: 'run_trial_reminder', what: 'pg_cron-called SECURITY DEFINER runner (09:10 UTC → Vault secret → pg_net → trial-reminder; 20260904).', claim: { kind: 'accepted', why: 'EXECUTE revoked from public/anon/authenticated (the notify_support_report idiom); reads one Vault secret and posts a fixed empty body to a fixed URL; every path fails open (a missing secret or a failed post is a no-op, never an error).', since: '2026-09-04' } },
  { kind: 'db-grant', id: 'handoff_tokens', what: 'Web→phone hand-off token hashes (Phase 3, 20260904_handoff) — RLS no-policies (service-role only).', claim: { kind: 'accepted', why: 'no client grant exists; holds SHA-256 hashes only (never the token), each usable once and dead after 60 s, swept daily by pg_cron; erased by delete-account (TABLES) and cascades with auth.users.', since: '2026-09-04' } },
  { kind: 'db-grant', id: 'handoff_turns', what: 'The hand-off mint rate ledger (the extract_turns shape) — RLS no-policies (service-role only).', claim: { kind: 'accepted', why: 'no client grant exists; user_id + timestamp only; erased by delete-account (TABLES).', since: '2026-09-04' } },
  { kind: 'db-grant', id: 'notify_signup', what: 'Trigger-internal SECURITY DEFINER webhook fn (auth.users insert/confirm → pg_net → signup-notify; S222).', claim: { kind: 'accepted', why: 'EXECUTE revoked from public/anon/authenticated in 20260901 (the notify_support_report idiom); every path fails open so it can never block an auth write; body only ever forwards the row\'s own user_id + email.', since: '2026-09-01' }, note: 'Add to rls-isolation\'s cannot-call list at the next probe sweep.' },
  { kind: 'db-grant', id: 'allocate_document_number', what: 'The invoice/quote sequence allocator RPC (20260812_invoice_sequencing, portal session 6) — client-callable by design.', claim: { kind: 'accepted', why: 'SECURITY INVOKER, derives the user from auth.uid() and never takes a uid argument (the search_user_records lesson applied at design time); locks + updates only the caller\'s own user_settings row under existing RLS. Grant names the full argument list so a redeclare cannot silently widen it.', since: '2026-08-12', reviewBy: '2026-12-01' }, note: 'Live-proven at ship: 6-way concurrent race allocates 6 distinct numbers; anon/no-JWT calls rejected. ✅ FOLDED into rls-isolation (S216, 2026-08-14): two-user probe — B\'s allocation draws a fresh seq from B\'s OWN counter, A\'s counter advances by exactly A\'s calls, unknown kind rejected — green live.' },
  { kind: 'db-grant', id: 'user_settings_seq_guard', what: 'BEFORE UPDATE trigger fn on user_settings (20260812_invoice_sequencing): clamps the two blob counters to GREATEST(old,new) so the app\'s blind whole-blob profile push can never rewind a portal-allocated sequence.', claim: { kind: 'accepted', why: 'not security definer — runs as the invoking role inside a write already scoped by the user_settings own-row RLS; touches only the row in flight, EXECUTE revoked from clients (trigger fns fire regardless).', since: '2026-08-12' } },
  { kind: 'db-grant', id: 'send_invoice_turns', what: 'send-invoice rate-limit turn log — service-role write, client default-deny.', claim: { kind: 'probe', probe: 'rls-isolation' }, note: 'The extract_turns shape (RLS enabled, no client policy, service-role grant only); rls-isolation asserts an authenticated client reads 0 rows. Erasure: in delete-account\'s TABLES list same-commit.' },
  { kind: 'db-grant', id: 'remote_flags', what: 'The remote kill switches (20260818, hardening C1) — one row per gated feature (receipt_capture / switcher_import / hmrc_filing / ask_soletax), select-only for anon + authenticated (deliberately readable WITHOUT a session — a broken-auth client must still hear a switch), writes service-role/dashboard only. Zero user data: booleans + copy strings.', claim: { kind: 'probe', probe: 'rls-isolation' }, note: 'rls-isolation §10: sessionless + authenticated reads work; client update/insert/delete all rejected and the switch state survives the attack round — a client-flippable switch would be an attacker\'s feature-outage button, so the write paths are the probe\'s whole point.' },
  { kind: 'db-grant', id: 'remote_flags_touch', what: 'BEFORE UPDATE trigger fn on remote_flags (20260818): server-stamps updated_at on every flip so the dashboard edit never depends on the operator filling the column in.', claim: { kind: 'accepted', why: 'not security definer — fires only inside writes clients cannot perform at all (no client write grant or policy on remote_flags); touches only the row in flight; EXECUTE revoked from clients (trigger fns fire regardless).', since: '2026-08-18' } },
  { kind: 'db-grant', id: 'server_events', what: 'The C4 operational audit table (20260818_server_events): extraction failures, import-map events and sync rejects — status codes, counts and ids ONLY, never raw content. Service-role only (RLS enabled, zero client policies); 90-day pg_cron retention; in delete-account\'s TABLES list (erasure never rests on the cascade).', claim: { kind: 'probe', probe: 'rls-isolation' }, note: 'rls-isolation asserts an authenticated client reads 0 rows (the extract_turns shape); verify-sync-spine proves the write path E2E (the sync_reject event lands on a real stale write). Retention decision recorded in the migration header.' },
  { kind: 'db-grant', id: 'log_sync_reject', what: 'SECURITY DEFINER helper (20260818, C4): the sync guard\'s ONE write path into server_events from client trigger context — fixed-shape insert, identity from auth.uid() (never an argument; the search_user_records lesson), search_path pinned.', claim: { kind: 'accepted', why: 'EXECUTE deliberately granted to authenticated — the guard trigger runs as the invoking role and needs it. Accepted surface: a hostile client can insert NOISE rows shaped like sync rejects (bounded by the fixed columns, 90-day retention, and no read-back — the table has no client SELECT); it cannot read, alter, or reach any other row. p_row_id/p_table are length-clamped in the insert.', since: '2026-08-18', reviewBy: '2026-12-01' }, note: 'The E2E drill caught the original uuid-typed p_row_id silently never matching from the trigger (record ids are text) — the 42883 was eaten by the guard\'s exception shield, which is exactly why verify-sync-spine now pins the event landing.' },
];
