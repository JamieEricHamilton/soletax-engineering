/**
 * test-security-coverage.ts — the CI forcing-function that keeps SoleTax's
 * attack-surface manifest (security/surface.ts) in lockstep with the repo. It
 * makes silent surface growth impossible to ship: a NEW edge function / workflow
 * / Worker route / wired secret / edge-function egress host / granted table turns
 * CI red until someone claims it with a probe or a dated acceptance.
 *
 * The keystone pattern's second application (after test-support-coverage.ts).
 * It DISCOVERS the real surface from the filesystem — never a hand-typed list of
 * what exists (that rots exactly like the pentest probe list does) — and proves:
 *
 *   1. KEYSTONE — every discovered surface element is claimed by exactly one
 *      manifest entry. An unclaimed element FAILS.
 *   2. NO-GHOST (bidirectional kinds only) — every manifest entry for an
 *      edge-function / workflow / worker-route names an element that still exists.
 *   3. Every { kind: 'probe' } claim names a probe in the PROBES registry.
 *   4. Every PROBES file exists on disk (a probe claim can't cite a deleted check).
 *
 * Enforcement direction (mirrors the surface.ts header):
 *   • edge-function / workflow / worker-route — BIDIRECTIONAL (checks 1 + 2).
 *   • secret / outbound / db-grant — ONE-DIRECTIONAL (check 1 only): discovered ⊆
 *     declared, but declared extras are allowed (local-only .env.local keys,
 *     client-side egress hosts, dashboard-created tables legitimately exceed the
 *     repo-expressed surface — see the surface.ts SCOPE note).
 *
 * Scope: repo-expressed surface only. It is an untested-surface gate, not a
 * vulnerability scanner. Run: npx tsx scripts/test-security-coverage.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SURFACE, PROBES, type SurfaceKind } from '../security/surface';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

let failures = 0;
function fail(msg: string): void {
  failures++;
  console.error(`❌ ${msg}`);
}

const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel: string): boolean => fs.existsSync(path.join(ROOT, rel));
const lsDirs = (rel: string): string[] => {
  const dir = path.join(ROOT, rel);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
};

// ── Discovery: the real surface, straight from the filesystem ────────────────

/** supabase/functions/<name> (directories, minus the _shared helper module). */
function discoverEdgeFunctions(): string[] {
  return lsDirs('supabase/functions').filter((n) => n !== '_shared').sort();
}

/** .github/workflows/*.yml (+ .yaml). */
function discoverWorkflows(): string[] {
  const dir = path.join(ROOT, '.github/workflows');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort();
}

/** Every route a Cloudflare Worker exposes, as "<worker>:<path>". Reads ALL
 *  .mjs/.js under workers/<worker>/src (not just index) and matches the common
 *  dispatch shapes: url.pathname === "x", url.pathname.startsWith("x/"),
 *  router-style .get/.post/... ("/x"), and switch `case "/x":`. A startsWith
 *  prefix normalises to "<prefix>/*". ⚠ Residual brittleness (surface.ts SCOPE):
 *  a route built by an exotic router or a regex match can still evade this — a
 *  known limit of static discovery, not full coverage. */
function discoverWorkerRoutes(): string[] {
  const out: string[] = [];
  for (const worker of lsDirs('workers')) {
    const srcDir = `workers/${worker}/src`;
    const files: string[] = [];
    const collect = (rel: string): void => {
      if (!exists(rel)) return;
      for (const e of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
        if (e.isDirectory()) collect(`${rel}/${e.name}`);
        else if (/\.(mjs|js|ts)$/.test(e.name)) files.push(`${rel}/${e.name}`);
      }
    };
    collect(srcDir);
    if (!files.length) {
      for (const p of ['index.mjs', 'index.js']) if (exists(`workers/${worker}/${p}`)) files.push(`workers/${worker}/${p}`);
    }
    const routes = new Set<string>();
    for (const f of files) {
      const src = read(f);
      for (const m of src.matchAll(/url\.pathname\s*===\s*["'`]([^"'`]+)["'`]/g)) routes.add(m[1]);
      for (const m of src.matchAll(/url\.pathname\.startsWith\(\s*["'`]([^"'`]+)["'`]/g)) routes.add(`${m[1].replace(/\/$/, '')}/*`);
      for (const m of src.matchAll(/\.(?:get|post|put|patch|delete|all|use|on)\(\s*["'`](\/[^"'`]*)["'`]/g)) routes.add(m[1]);
      for (const m of src.matchAll(/case\s+["'`](\/[^"'`]+)["'`]\s*:/g)) routes.add(m[1]);
    }
    for (const r of routes) out.push(`${worker}:${r}`);
  }
  return out.sort();
}

/** Secrets/credentials wired into the deployed surface: secrets.X across
 *  workflows + env.X across Workers + Deno.env.get("X") across edge functions.
 *  The edge-function scan (added after the review found the service-role key and
 *  HMRC_TOKEN_KEY entirely un-inventoried) is what makes the most powerful
 *  credentials — full RLS bypass, token decryption, the env-configured HMRC host
 *  URLs — visible to the gate. GITHUB_TOKEN is the Actions built-in, excluded. */
function discoverSecretRefs(): string[] {
  const found = new Set<string>();
  for (const wf of discoverWorkflows()) {
    for (const m of read(`.github/workflows/${wf}`).matchAll(/secrets\.([A-Z0-9_]+)/g)) found.add(m[1]);
  }
  for (const worker of lsDirs('workers')) {
    for (const p of ['src/index.mjs', 'src/index.js', 'index.mjs', 'index.js']) {
      const rel = `workers/${worker}/${p}`;
      if (!exists(rel)) continue;
      for (const m of read(rel).matchAll(/env\.([A-Z0-9_]+)/g)) found.add(m[1]);
    }
  }
  const fnsDir = path.join(ROOT, 'supabase/functions');
  if (fs.existsSync(fnsDir)) {
    const walk = (rel: string): void => {
      for (const e of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
        const child = `${rel}/${e.name}`;
        if (e.isDirectory()) walk(child);
        else if (e.name.endsWith('.ts')) {
          for (const m of read(child).matchAll(/Deno\.env\.get\(\s*["'`]([A-Z0-9_]+)["'`]/g)) found.add(m[1]);
        }
      }
    };
    walk('supabase/functions');
  }
  found.delete('GITHUB_TOKEN');
  return [...found].sort();
}

/** External hosts an edge function talks to at runtime (literal https URLs under
 *  supabase/functions/**). Imports are npm:/relative here, so this is clean
 *  runtime egress; a denylist guards against schema/registry hosts if any appear. */
function discoverOutboundHosts(): string[] {
  const IGNORE = /(^|\.)(deno\.land|esm\.sh|jsr\.io|w3\.org|schema\.org|localhost)$/;
  const found = new Set<string>();
  const walk = (rel: string): void => {
    for (const e of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
      const child = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(child);
      else if (e.name.endsWith('.ts')) {
        // Strip /* */ blocks and //-line comments first — a docs link in a
        // comment is not an egress host, and would otherwise turn CI red (alert
        // fatigue). ⚠ The line-comment strip must NOT eat the // in https:// —
        // only match // that isn't preceded by a colon (keep the leading char).
        const src = read(child).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
        for (const m of src.matchAll(/https?:\/\/([a-zA-Z0-9.-]+)/g)) {
          const host = m[1].toLowerCase();
          if (!IGNORE.test(host)) found.add(host);
        }
      }
    }
  };
  if (exists('supabase/functions')) walk('supabase/functions');
  return [...found].sort();
}

// SQL keywords that can appear in the object position of a grant and must never
// be read as a table/function name (`grant usage on schema public`, `... on all
// tables in schema ...`, `... on sequence ...`). The review's junk-token fix.
const SQL_NONOBJECTS = new Set(['schema', 'all', 'sequence', 'usage', 'table', 'function', 'public', 'to', 'from', 'on']);

/** Read every migration with comments stripped (prose like "revoke … on both
 *  classes" or "create table … won't …" must never be read as DDL). */
function migrationSql(): { file: string; sql: string }[] {
  const migDir = path.join(ROOT, 'supabase/migrations');
  if (!fs.existsSync(migDir)) return [];
  return fs.readdirSync(migDir).filter((f) => f.endsWith('.sql')).map((f) => ({
    file: f,
    sql: read(`supabase/migrations/${f}`).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' '),
  }));
}

/** Tables + RPCs that carry an RLS policy / grant / revoke OR are created in a
 *  migration (create table / create function). Discovering create-table too
 *  (the review's "single most important improvement") closes the worst blind
 *  spot: a table shipped with NO RLS + no grant was previously invisible, yet
 *  Supabase default privileges leave it readable by any authenticated user.
 *  storage.objects is a bucket-level policy (covered by the receipts entry). */
function discoverDbGrants(): string[] {
  const found = new Set<string>();
  const qualified = (schema: string | undefined, name: string): void => {
    if (schema && schema.toLowerCase() === 'storage') return; // bucket policy, not a table
    if (SQL_NONOBJECTS.has(name.toLowerCase())) return;
    found.add(name);
  };
  for (const { sql } of migrationSql()) {
    for (const m of sql.matchAll(/create\s+policy\s+"[^"]*"\s+on\s+(?:(\w+)\.)?(\w+)/gi)) qualified(m[1], m[2]);
    for (const m of sql.matchAll(/alter\s+table\s+(?:(\w+)\.)?(\w+)\s+enable\s+row\s+level\s+security/gi)) qualified(m[1], m[2]);
    // [^;]*? keeps the match inside a single statement (no crossing into the next).
    for (const m of sql.matchAll(/\b(?:grant|revoke)\b[^;]*?\bon\s+(?:function\s+|table\s+)?(?:(\w+)\.)?(\w+)/gi)) qualified(m[1], m[2]);
    for (const m of sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:(\w+)\.)?(\w+)/gi)) qualified(m[1], m[2]);
    for (const m of sql.matchAll(/create\s+(?:or\s+replace\s+)?function\s+(?:(\w+)\.)?(\w+)/gi)) qualified(m[1], m[2]);
  }
  return [...found].sort();
}

/** Migration-created tables that have NO `enable row level security` anywhere.
 *  Under Supabase default privileges such a table is readable by every
 *  authenticated user — the highest-severity surface. The gate fails on any that
 *  isn't explicitly claimed not-applicable in the manifest. */
function discoverTablesWithoutRls(): string[] {
  const created = new Set<string>();
  const rlsOn = new Set<string>();
  for (const { sql } of migrationSql()) {
    for (const m of sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:(\w+)\.)?(\w+)/gi)) {
      if (!(m[1] && m[1].toLowerCase() === 'storage') && !SQL_NONOBJECTS.has(m[2].toLowerCase())) created.add(m[2]);
    }
    for (const m of sql.matchAll(/alter\s+table\s+(?:(\w+)\.)?(\w+)\s+enable\s+row\s+level\s+security/gi)) rlsOn.add(m[2]);
  }
  return [...created].filter((t) => !rlsOn.has(t)).sort();
}

// ── The gate ─────────────────────────────────────────────────────────────────

const DISCOVERY: Record<SurfaceKind, { label: string; found: string[]; bidirectional: boolean }> = {
  'edge-function': { label: 'edge function', found: discoverEdgeFunctions(), bidirectional: true },
  workflow: { label: 'workflow', found: discoverWorkflows(), bidirectional: true },
  'worker-route': { label: 'Worker route', found: discoverWorkerRoutes(), bidirectional: true },
  secret: { label: 'wired secret', found: discoverSecretRefs(), bidirectional: false },
  outbound: { label: 'edge-function egress host', found: discoverOutboundHosts(), bidirectional: false },
  'db-grant': { label: 'granted table / RPC', found: discoverDbGrants(), bidirectional: false },
};

console.log('Security coverage — CI gate (security_coverage_gate_brief §3)\n');

for (const kind of Object.keys(DISCOVERY) as SurfaceKind[]) {
  const { label, found, bidirectional } = DISCOVERY[kind];
  const claimed = new Set(SURFACE.filter((e) => e.kind === kind).map((e) => e.id));
  const foundSet = new Set(found);

  // 1. KEYSTONE — every discovered element is claimed.
  for (const id of found) {
    if (!claimed.has(id)) {
      fail(`${label} "${id}" is NOT classified in security/surface.ts. Add an entry (a probe, a dated 'accepted', a 'deferred', or 'not-applicable') — a new ${label} can't ship un-triaged.`);
    }
  }
  // 2. NO-GHOST — bidirectional kinds only.
  if (bidirectional) {
    for (const id of claimed) {
      if (!foundSet.has(id)) {
        fail(`surface.ts claims ${label} "${id}", which no longer exists in the repo. Remove or update the entry.`);
      }
    }
  }
  console.log(`  ${label}: discovered ${found.length}, claimed ${claimed.size}${bidirectional ? '' : ' (one-directional: declared extras allowed)'}.`);
}

// 3. Every probe claim names a registry probe.
const probeIds = new Set(PROBES.map((p) => p.id));
for (const e of SURFACE) {
  if (e.claim.kind === 'probe' && !probeIds.has(e.claim.probe)) {
    fail(`surface element "${e.id}" claims probe "${e.claim.probe}", which isn't in the PROBES registry.`);
  }
}
// 4. Every registry probe's file exists.
for (const p of PROBES) {
  if (!exists(p.file)) fail(`PROBES entry "${p.id}" names file "${p.file}", which doesn't exist.`);
}

// 5. NO-RLS TABLE — a migration-created table with no RLS is readable by any
//    authenticated user (Supabase default privileges). Fail unless it's claimed
//    not-applicable with a written reason (the review's top-priority hardening).
const naDbGrants = new Set(SURFACE.filter((e) => e.kind === 'db-grant' && e.claim.kind === 'not-applicable').map((e) => e.id));
for (const t of discoverTablesWithoutRls()) {
  if (!naDbGrants.has(t)) {
    fail(`table "${t}" is created in a migration with NO 'enable row level security' — it is readable by any authenticated user. Enable RLS + an owner policy, or claim it not-applicable in surface.ts with why.`);
  }
}

// 6. REVIEW-BY — an 'accepted' risk-acceptance can carry an optional reviewBy
//    date; the gate fails once it's overdue, so acceptances can't silently rot
//    (mirrors the compliance reviewBy backstop). (tsx runtime: Date is fine.)
const today = new Date().toISOString().slice(0, 10);
for (const e of SURFACE) {
  if (e.claim.kind === 'accepted' && e.claim.reviewBy && e.claim.reviewBy < today) {
    fail(`surface element "${e.id}" has an OVERDUE risk-acceptance (reviewBy ${e.claim.reviewBy}). Re-examine it and either add a probe or renew the acceptance with a new date.`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
const total = SURFACE.length;
// Honesty breakdown — green must never be read as "all tested". Most of the
// surface is claimed by a written acceptance, not an active probe.
const byClaim = SURFACE.reduce<Record<string, number>>((acc, e) => { acc[e.claim.kind] = (acc[e.claim.kind] ?? 0) + 1; return acc; }, {});
const breakdown = `${byClaim.probe ?? 0} actively probed · ${byClaim.accepted ?? 0} accepted · ${byClaim.deferred ?? 0} deferred · ${byClaim['not-applicable'] ?? 0} n/a`;
if (failures > 0) {
  console.error(`\n❌ ${failures} coverage problem(s). The attack-surface manifest has drifted from the repo — fix security/surface.ts.`);
  process.exit(1);
}
console.log(`\n✅ Surface holds — ${total} elements, all claimed (${breakdown}); ${PROBES.length} probes present.`);
console.log(`   Note: "claimed" ≠ "tested". ${byClaim.probe ?? 0}/${total} elements have an active probe; the rest are written acceptances/deferrals (repo-expressed surface only — dashboard drift is out of scope).`);
