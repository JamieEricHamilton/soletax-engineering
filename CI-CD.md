# CI/CD — the portal pipeline

Answers three questions for `portal/` (the web app at the portal host, Vite + React,
Cloudflare Pages). Source: `.github/workflows/production/portal-deploy.yml`,
`compliance-check.yml`, `security.yml`, `secrets.yml`.

## What runs on a pull request

Three workflows, in parallel. A PR cannot merge green unless all pass.

1. **Secret scan** (`secrets.yml`) — gitleaks 8.30.1 over the full git history, no path
   filter. Allowlist in `.gitleaks.toml`, every entry with a public-by-design rationale.
   Fetch and detect are separate steps so a GitHub Releases 503 can never read as a
   finding.
2. **Security** (`security.yml`, path-filtered so docs-only commits skip it) —
   - `npm audit` against `scripts/npm-audit-baseline.json`, both the root lockfile and
     `portal/package-lock.json`; fails on a **new** high/critical only, so the gate
     cannot be silenced by an advisory nobody can fix today.
   - Semgrep `p/default`, `--error`, with five excluded rules each annotated with why.
3. **Compliance check** (`compliance-check.yml`) — compliance-currency date alarm
   (tax-rates and SA103F review dates), citation-key check, `npm ci`, `tsc --noEmit`,
   `expo lint`, `npm run test:tax` (60 scripts; includes `test-portal-cors.ts`,
   `test-security-coverage.ts`, `test-no-service-role-in-bundle.mjs`). Note the root
   `tsc` excludes `portal/` — the portal is typechecked in its own build step below, so
   a PR touching only `portal/` relies on the deploy workflow's build, which also runs
   on `workflow_dispatch` for a pre-merge check.
4. **Not on PRs**: the RLS per-migration sweep and the portal deploy gate target
   production and the built bundle respectively, so they run after merge (below) or on
   `workflow_dispatch` when a pre-merge check is wanted.

Concurrency groups are keyed by workflow + event + ref: a newer push cancels the
superseded PR run, but a push can never cancel a scheduled run.

## What runs on merge to main

Everything above runs again on the push event, plus:

- **Portal deploy** (`portal-deploy.yml`, paths `portal/**` and the workflow file itself,
  20-minute job ceiling, `concurrency: portal-deploy` with cancel-in-progress):
  1. `npm ci` in `portal/` with the portal's own lockfile cached.
  2. Resolution stubs at the repo root — the portal imports the shared `../src` tax
     engine, which resolves `date-fns` and the Expo tsconfig by walking up into the root
     `node_modules`; in a portal-only install those are copied/stubbed in. A new bare
     import in the shared tree must be added here and to `portal/package.json`.
  3. **Design-parity census ratchet** (`portal/scripts/source-census.mjs --check`) —
     counts of off-design-system values may only go down.
  4. `npm run build` — typecheck + Vite bundle.
  5. **CORS keystone** (`scripts/test-portal-cors.ts`) — every browser-called function
     wraps `withCors` with an exact-origin allowlist.
  6. **Playwright deploy gate** (`scripts/portal-deploy-gate.mjs`) over `vite preview`
     of the **built** `dist`: bundle secret hygiene, logged-out render, then an anonymous
     session (the shipped publishable key) seeds own-row data and pins every route plus
     the `remote_flags` read, zero console errors. The chat composer is present but never
     submitted — no model calls in CI. Playwright install has its own 6-minute timeout
     after two runner-side stalls.
  7. `wrangler pages deploy dist` to the portal's Cloudflare Pages project. The
     marketing site is a separate Pages project so origins, CSPs and blast radii stay
     isolated.
- **RLS per migration** — any merge touching `supabase/migrations/**` re-runs the
  24-check isolation sweep against production with anonymous clients and the public
  anon key, on the commit that changed the policy surface. Never cancelled mid-sweep.

## How deployments work

- **Portal and website**: push-to-main deploys, gated as above, no human step. Rollback
  is a revert commit (the same pipeline redeploys) or a Cloudflare Pages rollback to
  the previous deployment for an instant fix while the revert lands.
- **Credentials**: a single Cloudflare API token scoped to Pages, in GitHub secrets.
  No Supabase Management API token is in Actions by rule; the deploy gate uses only
  the public anon key.
- **What is not in the pipeline**: edge functions (`supabase functions deploy` by hand
  after local Deno checks), migrations (`supabase db push` after the local staging
  ritual: restore a production copy, apply the candidate, run the RLS sweep on the
  copy), and the iOS app (local archive, scripted TestFlight attach and App Review
  submission via the App Store Connect API). These are the top items in the README's
  gaps list.
- **Scheduling**: nightly and weekly workflows are dispatched by a Cloudflare Worker
  "fleet clock" at the exact minute; the cron trigger in each file is a fallback with a
  guard that skips when the clock's run already happened, failing open so a duplicate
  beats a missed sweep.
