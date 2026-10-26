#!/usr/bin/env node
/**
 * Two-account RLS isolation test — security plan Stage 2 / audit High #10
 * residue (project_review_2026-07.md). Empirically proves, against the LIVE
 * database with ONLY the anon key (exactly the credentials an attacker has),
 * that one authenticated user cannot read, alter, delete, spoof-insert, or
 * RPC-tunnel into another user's records.
 *
 * What it checks (user B attacking user A, both fresh anonymous sign-ins):
 *   1. receipts + income: B select/update/delete A's row → 0 rows; B insert AS A
 *      → 42501 (income = the primary jobs/quotes/invoices table, added S175)
 *   2. trips + other_income + user_settings: B read-probes → 0 rows
 *   3. search_user_records RPC with A's uid → permission denied
 *      (the 20260702_security_hardening revoke — the cross-tenant hole stays shut)
 *   4. storage receipts bucket: B can't download or delete A's object;
 *      A CAN delete its own (the 20260702 DELETE policy works for the owner)
 *   5. support_reports: default-deny for clients (select 0 rows, insert 42501)
 *   6. extract_turns/support_turns/import_turns/server_events: authenticated
 *      client reads 0 rows (service-role-only tables)
 *   7. notify_beta_signup/notify_support_report: EXECUTE revoked (not client-callable)
 *   8. support_sessions (S216): B select/update/delete A's chat → 0 rows; B insert
 *      AS A → 42501; NO client DELETE even for the owner (tombstoning UPDATE is
 *      the only delete path — and it works for the owner)
 *   9. allocate_document_number RPC (S216): auth.uid()-derived, no uid argument —
 *      B's allocation draws from B's own fresh counter and never advances A's
 *  10. remote_flags (S218, hardening C1): the kill switches are readable WITHOUT
 *      a session (a broken-auth client must still hear a switch) and by any
 *      authenticated user — but NO client can write one (select-only grant;
 *      flips are service_role/dashboard only)
 *
 * Run: node scripts/test-rls-isolation.mjs   (reads .env.local; live network)
 * NOT in test:tax — CI has no secrets. Re-run after any policy/schema change.
 * Leaves behind: the two anonymous auth users (deletable only with the service
 * key; indistinguishable from the app's own anon users) — all rows + storage
 * objects are cleaned up.
 */
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

// .env.local is absent in CI (the D3 per-migration workflow) — there the
// target comes entirely from the SOLETAX_TARGET_* env vars below.
let env = {};
try {
  env = Object.fromEntries(
    readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
      .split('\n')
      .filter((l) => l.includes('='))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );
} catch { /* CI */ }
// SOLETAX_TARGET_URL/_ANON_KEY point the sweep at another project (the
// staging ritual, D1). Default = prod via .env.local, unchanged.
const URL_ = process.env.SOLETAX_TARGET_URL || env.EXPO_PUBLIC_SUPABASE_URL;
const ANON = process.env.SOLETAX_TARGET_ANON_KEY || env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
if (!URL_ || !ANON) {
  console.error('✗ EXPO_PUBLIC_SUPABASE_URL / _ANON_KEY missing from .env.local');
  process.exit(1);
}

let passed = 0;
const failures = [];
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.error(`  ✗ ${name} ${detail}`); }
};

const A = createClient(URL_, ANON, { auth: { persistSession: false } });
const B = createClient(URL_, ANON, { auth: { persistSession: false } });

const { data: aAuth, error: aErr } = await A.auth.signInAnonymously();
const { data: bAuth, error: bErr } = await B.auth.signInAnonymously();
if (aErr || bErr) {
  console.error('✗ anonymous sign-in failed', aErr ?? bErr);
  process.exit(1);
}
const aUid = aAuth.user.id;
console.log(`Signed in: A=${aUid.slice(0, 8)}… B=${bAuth.user.id.slice(0, 8)}…\n`);

// ── Seed A's data (shapes mirror the app's storageServices) ───────────────────
const receiptId = randomUUID();
const tripId = randomUUID();
const otherIncomeId = randomUUID();
const incomeId = randomUUID();
const seed = async (label, promise) => {
  const { error } = await promise;
  check(`seed: A inserts own ${label}`, !error, error?.message ?? '');
};
console.log('── Seeding as A ──');
await seed('receipt', A.from('receipts').insert({
  id: receiptId, user_id: aUid, captured_at: Date.now(), image_path: null,
  merchant: 'RLS-TEST', amount: 123, date: '2026-07-03', category: 'office_costs',
  category_confidence: 1, category_source: 'user', tax_year: '2026-27',
  processing_status: 'complete', review_status: 'approved', sync_status: 'synced',
}));
await seed('trip', A.from('trips').insert({
  id: tripId, user_id: aUid, start_time: Date.now() - 600_000, end_time: Date.now(),
  distance_miles: 1.0, purpose: null, detection_method: 'manual', tax_year: '2026-27',
  start_address: null, end_address: null, start_lat: 51.5, start_lng: -0.01,
  end_lat: 51.51, end_lng: -0.02, sync_status: 'synced',
}));
await seed('other_income row', A.from('other_income').insert({
  id: otherIncomeId, user_id: aUid, tax_year: '2026-27', created_at_ms: Date.now(),
  amount: 100, date: '2026-07-03', kind: 'other', note: 'RLS-TEST', sync_status: 'synced',
}));
// income = the PRIMARY financial table (jobs/quotes/invoices). Added S175 after
// the security-coverage review found it was claimed-probed but untouched.
await seed('income (job) row', A.from('income').insert({
  id: incomeId, user_id: aUid, created_at_ms: Date.now(), client: 'RLS-TEST-CLIENT',
  amount: 500, date: '2026-07-03', status: 'paid', tax_year: '2026-27', sync_status: 'synced',
}));
await seed('user_settings row', A.from('user_settings').upsert({
  user_id: aUid, identity: { firstName: 'RLS-TEST' },
}));
const storagePath = `${aUid}/2026-27/${receiptId}.jpg`;
{
  const { error } = await A.storage.from('receipts').upload(storagePath, new Blob(['rls-test']), { contentType: 'image/jpeg', upsert: true });
  check('seed: A uploads own storage object', !error, error?.message ?? '');
}

// ── B attacks ─────────────────────────────────────────────────────────────────
console.log('\n── B attacking A ──');
{
  const { data } = await B.from('receipts').select('id').eq('id', receiptId);
  check('B cannot SELECT A\'s receipt', (data ?? []).length === 0);
}
{
  const { data } = await B.from('receipts').update({ merchant: 'HACKED' }).eq('id', receiptId).select();
  check('B UPDATE of A\'s receipt affects 0 rows', (data ?? []).length === 0);
}
{
  const { data } = await B.from('receipts').delete().eq('id', receiptId).select();
  check('B DELETE of A\'s receipt affects 0 rows', (data ?? []).length === 0);
}
{
  const { error } = await B.from('receipts').insert({
    id: randomUUID(), user_id: aUid, captured_at: Date.now(), image_path: null,
    merchant: 'SPOOF', amount: 9.99, date: '2026-07-03', category: 'office_costs',
    category_confidence: 1, category_source: 'user', tax_year: '2026-27',
    processing_status: 'complete', review_status: 'approved', sync_status: 'synced',
  });
  check('B INSERT with A\'s user_id rejected (WITH CHECK)', Boolean(error), error ? '' : 'insert SUCCEEDED');
}
for (const [table, col, val] of [['trips', 'id', tripId], ['other_income', 'id', otherIncomeId], ['user_settings', 'user_id', aUid]]) {
  const { data } = await B.from(table).select(col).eq(col, val);
  check(`B cannot SELECT A's ${table} row`, (data ?? []).length === 0);
}
// income — the primary financial table gets the full receipts-style treatment.
{
  const { data } = await B.from('income').select('id,client,amount').eq('id', incomeId);
  check('B cannot SELECT A\'s income (job) row', (data ?? []).length === 0);
}
{
  const { data } = await B.from('income').update({ client: 'HACKED' }).eq('id', incomeId).select();
  check('B UPDATE of A\'s income affects 0 rows', (data ?? []).length === 0);
}
{
  const { data } = await B.from('income').delete().eq('id', incomeId).select();
  check('B DELETE of A\'s income affects 0 rows', (data ?? []).length === 0);
}
{
  const { error } = await B.from('income').insert({
    id: randomUUID(), user_id: aUid, created_at_ms: Date.now(), client: 'SPOOF',
    amount: 1, date: '2026-07-03', status: 'paid', tax_year: '2026-27', sync_status: 'synced',
  });
  check('B INSERT into income with A\'s user_id rejected (WITH CHECK)', Boolean(error), error ? '' : 'insert SUCCEEDED');
}
// AI turn logs — service-role-only, RLS-enabled with no client policy. Any
// authenticated client must read 0 rows (surface.ts extract_turns/support_turns/
// import_turns, now probe:rls-isolation).
for (const t of ['extract_turns', 'support_turns', 'import_turns', 'server_events']) {
  const { data } = await B.from(t).select('*').limit(1);
  check(`${t}: authenticated client reads 0 rows (service-role only)`, (data ?? []).length === 0);
}
// Trigger-internal webhook functions — EXECUTE revoked from anon/authenticated
// (20260703/20260704), so a client cannot invoke them directly.
for (const fn of ['notify_beta_signup', 'notify_support_report']) {
  const { error } = await B.rpc(fn, {});
  check(`${fn}: not client-callable (EXECUTE revoked / not exposed)`, Boolean(error), error ? '' : 'RPC SUCCEEDED — client can invoke it');
}
{
  const { error } = await B.rpc('search_user_records', { p_uid: aUid, p_query: 'RLS-TEST' });
  check('B blocked from search_user_records RPC (20260702 revoke holds)',
    Boolean(error) && /permission denied/i.test(error?.message ?? ''),
    error ? `unexpected error: ${error.message}` : 'RPC SUCCEEDED — cross-tenant hole is OPEN');
}
{
  const { data, error } = await B.storage.from('receipts').download(storagePath);
  check('B cannot download A\'s receipt image', Boolean(error) && !data);
}
{
  const { data } = await B.storage.from('receipts').remove([storagePath]);
  // Storage reports success on RLS-filtered deletes — affected list must be empty…
  check('B remove() of A\'s image deletes nothing', (data ?? []).length === 0);
  const { data: still, error: aDlErr } = await A.storage.from('receipts').download(storagePath);
  // …and the object must still be there for A.
  check('A\'s image survives B\'s delete attempt', Boolean(still) && !aDlErr);
}
{
  const { data } = await B.from('support_reports').select('id').limit(1);
  check('support_reports: B reads 0 rows (default-deny)', (data ?? []).length === 0);
  const { error } = await B.from('support_reports').insert({ user_id: aUid, kind: 'rls_test' });
  check('support_reports: B insert rejected', Boolean(error), error ? '' : 'insert SUCCEEDED');
}

// ── support_sessions — chat transcripts (folded in S216 per the surface.ts
// note: user content, the support_reports sensitivity class). Owner-scoped
// select/insert/update WITH CHECK; NO client DELETE policy at all — deletion
// is the tombstoning UPDATE (the sync spine's design).
console.log('\n── support_sessions (chat history) ──');
const chatId = randomUUID();
await seed('chat session', A.from('support_sessions').insert({
  id: chatId, user_id: aUid, title: 'RLS-TEST-CHAT', created_at_ms: Date.now(),
  updated_at_ms: Date.now(), deleted_at_ms: null,
  messages: [{ id: 'm1', role: 'user', text: 'rls probe' }],
}));
{
  const { data } = await B.from('support_sessions').select('id,title,messages').eq('id', chatId);
  check('B cannot SELECT A\'s chat transcript', (data ?? []).length === 0);
}
{
  const { data } = await B.from('support_sessions').update({ title: 'HACKED' }).eq('id', chatId).select();
  check('B UPDATE of A\'s chat affects 0 rows', (data ?? []).length === 0);
}
{
  const { error } = await B.from('support_sessions').insert({
    id: randomUUID(), user_id: aUid, title: 'SPOOF', created_at_ms: Date.now(),
    updated_at_ms: Date.now(), deleted_at_ms: null, messages: [],
  });
  check('B INSERT of a chat AS A rejected (WITH CHECK)', Boolean(error), error ? '' : 'insert SUCCEEDED');
}
{
  const { data } = await B.from('support_sessions').delete().eq('id', chatId).select();
  check('B DELETE of A\'s chat affects 0 rows', (data ?? []).length === 0);
}
{
  const { data } = await A.from('support_sessions').delete().eq('id', chatId).select();
  check('even A\'s own hard DELETE is a no-op (no client DELETE — tombstones only)', (data ?? []).length === 0);
}
{
  const { data, error } = await A.from('support_sessions')
    .update({ deleted_at_ms: Date.now(), updated_at_ms: Date.now() }).eq('id', chatId).select();
  check('A tombstones own chat (the real delete path works)', !error && (data ?? []).length === 1, error?.message ?? '');
}

// ── allocate_document_number — the sequence allocator RPC (folded in S216 per
// the surface.ts note). SECURITY INVOKER + auth.uid()-derived with NO uid
// argument: allocation can only ever draw from the CALLER's own counter, so
// the cross-tenant probe is that two users' allocations never interfere.
console.log('\n── allocate_document_number (sequence allocator) ──');
{
  const a1 = await A.rpc('allocate_document_number', { p_kind: 'invoice' });
  const b1 = await B.rpc('allocate_document_number', { p_kind: 'invoice' });
  const a2 = await A.rpc('allocate_document_number', { p_kind: 'invoice' });
  check('A allocates from its own counter', !a1.error && typeof a1.data?.seq === 'number', a1.error?.message ?? JSON.stringify(a1.data));
  check('B allocates from its OWN counter (fresh sequence, not A\'s)', !b1.error && b1.data?.seq === 1, b1.error?.message ?? `seq=${b1.data?.seq}`);
  check('A\'s counter advanced by exactly its own calls (B\'s allocation never touched it)',
    !a2.error && a2.data?.seq === a1.data?.seq + 1, `a1=${a1.data?.seq} a2=${a2.data?.seq}`);
  const bad = await B.rpc('allocate_document_number', { p_kind: 'creditnote' });
  check('unknown kind rejected', Boolean(bad.error), bad.error ? '' : `SUCCEEDED: ${JSON.stringify(bad.data)}`);
}

// ── remote_flags — the kill switches (hardening C1, S218). Global read-only
// config, zero user data. The read path must work with NO session at all
// (fail-open clients fetch at launch, possibly pre-auth); every write path
// must be shut for clients — a flippable kill switch is an attacker's
// feature-outage button.
console.log('\n── remote_flags (kill switches) ──');
{
  const N = createClient(URL_, ANON, { auth: { persistSession: false } }); // never signs in
  const { data, error } = await N.from('remote_flags').select('key,enabled');
  check('sessionless client reads the switches (anon-role read path)',
    !error && (data ?? []).length >= 4, error?.message ?? `rows=${(data ?? []).length}`);
  const { data: bData } = await B.from('remote_flags').select('key,enabled');
  check('authenticated client reads the switches', (bData ?? []).length >= 4);
  const { data: up, error: upErr } = await B.from('remote_flags')
    .update({ enabled: false }).eq('key', 'receipt_capture').select();
  check('client cannot FLIP a switch (update rejected)',
    Boolean(upErr) || (up ?? []).length === 0, upErr ? '' : `affected=${(up ?? []).length}`);
  const { error: insErr } = await B.from('remote_flags')
    .insert({ key: 'rls_test_switch', enabled: false });
  check('client cannot INSERT a switch', Boolean(insErr), insErr ? '' : 'insert SUCCEEDED');
  const { data: del, error: delErr } = await B.from('remote_flags')
    .delete().eq('key', 'receipt_capture').select();
  check('client cannot DELETE a switch', Boolean(delErr) || (del ?? []).length === 0);
  const { data: still } = await A.from('remote_flags').select('enabled').eq('key', 'receipt_capture');
  check('receipt_capture still ON after the attack round', still?.[0]?.enabled === true);
}

// ── A's own access still works + cleanup ──────────────────────────────────────
console.log('\n── A cleanup (owner paths still work) ──');
{
  const { data } = await A.from('receipts').select('merchant').eq('id', receiptId);
  check('A still sees own receipt, unmodified', data?.[0]?.merchant === 'RLS-TEST');
}
{
  const { data, error } = await A.storage.from('receipts').remove([storagePath]);
  check('A deletes own image (20260702 DELETE policy works)', !error && (data ?? []).length === 1, error?.message ?? `affected=${(data ?? []).length}`);
}
for (const [table, col, val] of [['receipts', 'id', receiptId], ['income', 'id', incomeId], ['trips', 'id', tripId], ['other_income', 'id', otherIncomeId], ['user_settings', 'user_id', aUid]]) {
  const { error } = await A.from(table).delete().eq(col, val);
  check(`cleanup: A deletes own ${table} row`, !error, error?.message ?? '');
}
{
  // B's allocator call created a user_settings row for B — clean it too.
  const { error } = await B.from('user_settings').delete().eq('user_id', bAuth.user.id);
  check('cleanup: B deletes own user_settings row', !error, error?.message ?? '');
}
await A.auth.signOut();
await B.auth.signOut();

console.log(`\n${failures.length === 0 ? '✅' : '❌'} RLS isolation: ${passed} passed, ${failures.length} failed`);
console.log('Note: the two anonymous auth users remain (service-key-only to remove; same as app anon users), plus A\'s tombstoned RLS-TEST chat row (no client DELETE on support_sessions — by design).');
process.exit(failures.length === 0 ? 0 : 1);
