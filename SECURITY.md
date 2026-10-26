# Security

SoleTax holds UK sole traders' financial records. Security posture, threat
model, and the staged verification route (self-audit → free tooling in CI →
post-revenue CREST pen-test) are documented in
[`docs/security/security_plan.md`](docs/security/security_plan.md).

## Reporting a vulnerability

Email **<SECURITY_CONTACT_EMAIL>** with the subject line `SECURITY`. Include what
you found, where, and steps to reproduce. You'll get a human reply from the
founder — normally within 2 working days.

Please don't access other users' data while demonstrating an issue: two test
accounts of your own are enough for any cross-tenant proof. Good-faith
research reported this way will never be met with legal action.

No bug bounty is offered at this stage.

## What runs in CI (Stage 2)

- Secret scan: `gitleaks` (allowlist + rationale: `.gitleaks.toml`)
- Dependency gate: `scripts/check-npm-audit.mjs` — fails on any high/critical
  advisory not in the hand-justified baseline
  (`scripts/npm-audit-baseline.json`)
- SAST: `semgrep` (`p/default`; excluded rules + rationale in
  `.github/workflows/security.yml`)
- Multi-tenant isolation: `scripts/test-rls-isolation.mjs` — 24 live checks
  against the real backend, weekly + on demand

The disclosure contact is also published at
`https://<WEBSITE_HOST>/.well-known/security.txt`.
