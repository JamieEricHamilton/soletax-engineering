# Production workflows (reference copies)

These eight files are copied from the production repository's
`.github/workflows/` and are **not active in this repo** (GitHub only runs
workflows at the top level of `.github/workflows/`). They are here to be read.

What was changed for publication: Supabase project refs, hostnames, bucket and
Pages project names, email addresses and the backup public key are replaced
with `<PLACEHOLDERS>`. Action SHA pins, triggers, path filters, concurrency
groups, permissions blocks, timeouts and the inline comments are unchanged.
Standard provider secret names (`CLOUDFLARE_API_TOKEN`, `SUPABASE_URL`, …) are
kept because they carry no value and renaming them would make the files harder
to read.

| File | Trigger | Purpose |
|---|---|---|
| `secrets.yml` | every push + PR, no path filter | gitleaks over full history; alert email on a hit |
| `security.yml` | code push/PR (path-filtered) + Monday full pass | npm-audit baseline gate, Semgrep SAST, weekly live RLS test and fleet report |
| `compliance-check.yml` | code push/PR + Monday | compliance-currency date alarm, citation keys, tsc, lint, `test:tax` |
| `portal-deploy.yml` | push to main touching `portal/**` | build, census ratchet, CORS keystone, Playwright deploy gate, Cloudflare Pages |
| `rls-per-migration.yml` | push to main touching `supabase/migrations/**` | re-prove tenant isolation against prod with anon-key-only clients |
| `backup.yml` | nightly 03:00 UTC | pg_dump as a read-only role + storage sync + repo bundle, age-encrypted to R2, dead-man ping |
| `edge-health.yml` | daily (fleet clock + cron fallback) | probe every edge function; SQL for failed HMRC submissions in the last 25h |
| `data-invariants.yml` | nightly | read-only invariant sweep: FK orphans, duplicates, LWW poisoning, negatives |

`CI-CD.md` at the repo root walks through the portal pipeline step by step.
