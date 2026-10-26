/**
 * ipScope.ts — which addresses belong in Gov-Client-Local-IPs.
 *
 * HMRC's fraud-prevention spec (MOBILE_APP_VIA_SERVER profile, read verbatim
 * 2026-09-09, spec v3.3): "Gov-Client-Local-IPs — A list of all local IPv4
 * and IPv6 addresses available to the originating device." The public
 * address travels separately in Gov-Client-Public-IP. The spec never defines
 * "local"; HMRC's Fraud Prevention Header team defined it by exclusion in
 * their 2026-09-09 review of our 19 Aug via-server submission, whose list
 * carried the Mac's global IPv6 addresses: "At least 1 of the IPs is public.
 * If there is an application error, you need to correct it."
 *
 * This module makes that rule exact and auditable, in three scopes:
 *
 *   LOCAL   — what HMRC's own validator accepts in the header. Fixed
 *             empirically on 2026-09-20 (S227): the the test device capture on cellular
 *             carried the phone's 464XLAT addresses 192.0.0.2 / 192.0.0.6 and
 *             the Test FPH validator graded them "At least 1 of the IPs is
 *             public", although IANA marks 192.0.0.0/24 not globally
 *             reachable. A 21-candidate probe of /validate (one address per
 *             call) pinned the validator's local set exactly: RFC 1918
 *             (10/8, 172.16/12, 192.168/16), 169.254/16, 127/8, fe80::/10,
 *             fc00::/7, ::1 and the deprecated site-local fec0::/10. Nothing
 *             else — CGNAT 100.64/10 included — passes. These rows carry
 *             `hmrcLocal`.
 *   SPECIAL — blocks IANA marks "Globally Reachable: False" (the RFC 6890
 *             attribute) that are NOT in HMRC's set: 100.64/10 shared address
 *             space, 192.0.0.0/24 (the 464XLAT CLAT /29, NAT64 discovery),
 *             benchmarking, documentation, reserved, discard, SRv6, the
 *             local-use NAT64 prefix. Never sent in the header (HMRC would
 *             call them public) and never treated as public either.
 *   PUBLIC  — everything else.
 *
 * Loopback and the unspecified address are none of these: they describe no
 * network path and are never sent. Longest prefix wins, exactly as the
 * registry nests (192.0.0.9/32 True inside 192.0.0.0/24 False).
 *
 * Registry snapshots: docs/compliance/sources/iana-ipv4-special-registry.csv
 * and iana-ipv6-special-registry.csv (fetched 2026-09-09; register entry in
 * docs/compliance/compliance_sources.md). Every row carrying a True/False
 * value is encoded below. Rows the registry marks N/A or leaves blank
 * (Teredo, 6to4, the deprecated 6to4 relay, deprecated ORCHID) are encoded
 * as PUBLIC: a tunnel or relay address is a path to the internet, and a
 * Teredo address would otherwise inherit "local" from its 2001::/23 parent.
 * fec0::/10 is not in the IANA registry (deprecated by RFC 3879) and is
 * encoded here only because HMRC's validator accepts it.
 *
 * Pure and dependency-free — no Deno, Node or React Native globals — so the
 * same file is imported by the edge function (Deno), the evidence scripts
 * (Node ≥ 22.18 type-strips it), the app (Metro) and the keystone test
 * `scripts/test-ip-scope.ts` (tsx, in `npm run test:tax`). Only erasable
 * TypeScript syntax is used (no enums, no parameter properties).
 */

export type IpScope = 'local' | 'special' | 'public' | 'loopback' | 'unspecified' | 'invalid';

type Role = 'loopback' | 'unspecified' | 'invalid';

interface RegistryRow {
  cidr: string;
  /** IANA "Globally Reachable" — true = public. */
  reachable: boolean;
  name: string;
  /** Blocks that are neither local nor public: never a network path. */
  role?: Role;
  /** In the set HMRC's validator accepts as local (probe 2026-09-20). Unreachable rows without it are SPECIAL. */
  hmrcLocal?: true;
}

// iana-ipv4-special-registry (rows with a True/False Globally Reachable value,
// plus the blank 192.88.99.0/24 row encoded public — see the header).
const IPV4_ROWS: RegistryRow[] = [
  { cidr: '0.0.0.0/8', reachable: false, name: '"This network"', role: 'invalid' },
  { cidr: '0.0.0.0/32', reachable: false, name: '"This host on this network"', role: 'unspecified' },
  { cidr: '10.0.0.0/8', reachable: false, name: 'Private-Use', hmrcLocal: true },
  { cidr: '100.64.0.0/10', reachable: false, name: 'Shared Address Space (CGNAT) — HMRC calls it public' },
  { cidr: '127.0.0.0/8', reachable: false, name: 'Loopback', role: 'loopback' },
  { cidr: '169.254.0.0/16', reachable: false, name: 'Link Local', hmrcLocal: true },
  { cidr: '172.16.0.0/12', reachable: false, name: 'Private-Use', hmrcLocal: true },
  { cidr: '192.0.0.0/24', reachable: false, name: 'IETF Protocol Assignments — HMRC calls it public' },
  { cidr: '192.0.0.0/29', reachable: false, name: 'IPv4 Service Continuity Prefix (464XLAT CLAT — the the test device advisory, 2026-09-20)' },
  { cidr: '192.0.0.8/32', reachable: false, name: 'IPv4 dummy address' },
  { cidr: '192.0.0.9/32', reachable: true, name: 'Port Control Protocol Anycast' },
  { cidr: '192.0.0.10/32', reachable: true, name: 'Traversal Using Relays around NAT Anycast' },
  { cidr: '192.0.0.170/32', reachable: false, name: 'NAT64/DNS64 Discovery' },
  { cidr: '192.0.0.171/32', reachable: false, name: 'NAT64/DNS64 Discovery' },
  { cidr: '192.0.2.0/24', reachable: false, name: 'Documentation (TEST-NET-1)' },
  { cidr: '192.31.196.0/24', reachable: true, name: 'AS112-v4' },
  { cidr: '192.52.193.0/24', reachable: true, name: 'AMT' },
  { cidr: '192.88.99.0/24', reachable: true, name: 'Deprecated (6to4 Relay Anycast) — registry value blank' },
  { cidr: '192.88.99.2/32', reachable: false, name: '6a44-relay anycast address' },
  { cidr: '192.168.0.0/16', reachable: false, name: 'Private-Use', hmrcLocal: true },
  { cidr: '192.175.48.0/24', reachable: true, name: 'Direct Delegation AS112 Service' },
  { cidr: '198.18.0.0/15', reachable: false, name: 'Benchmarking' },
  { cidr: '198.51.100.0/24', reachable: false, name: 'Documentation (TEST-NET-2)' },
  { cidr: '203.0.113.0/24', reachable: false, name: 'Documentation (TEST-NET-3)' },
  { cidr: '240.0.0.0/4', reachable: false, name: 'Reserved' },
  { cidr: '255.255.255.255/32', reachable: false, name: 'Limited Broadcast', role: 'invalid' },
];

// iana-ipv6-special-registry (same encoding; ::ffff:0:0/96 is handled by
// unwrapping the embedded IPv4 and classifying that instead).
const IPV6_ROWS: RegistryRow[] = [
  { cidr: '::1/128', reachable: false, name: 'Loopback Address', role: 'loopback' },
  { cidr: '::/128', reachable: false, name: 'Unspecified Address', role: 'unspecified' },
  { cidr: '64:ff9b::/96', reachable: true, name: 'IPv4-IPv6 Translat.' },
  { cidr: '64:ff9b:1::/48', reachable: false, name: 'IPv4-IPv6 Translat.' },
  { cidr: '100::/64', reachable: false, name: 'Discard-Only Address Block' },
  { cidr: '100:0:0:1::/64', reachable: false, name: 'Dummy IPv6 Prefix' },
  { cidr: '2001::/23', reachable: false, name: 'IETF Protocol Assignments' },
  { cidr: '2001::/32', reachable: true, name: 'TEREDO — registry value N/A' },
  { cidr: '2001:1::1/128', reachable: true, name: 'Port Control Protocol Anycast' },
  { cidr: '2001:1::2/128', reachable: true, name: 'Traversal Using Relays around NAT Anycast' },
  { cidr: '2001:1::3/128', reachable: true, name: 'DNS-SD Service Registration Protocol Anycast' },
  { cidr: '2001:2::/48', reachable: false, name: 'Benchmarking' },
  { cidr: '2001:3::/32', reachable: true, name: 'AMT' },
  { cidr: '2001:4:112::/48', reachable: true, name: 'AS112-v6' },
  { cidr: '2001:10::/28', reachable: true, name: 'Deprecated (previously ORCHID) — registry value blank' },
  { cidr: '2001:20::/28', reachable: true, name: 'ORCHIDv2' },
  { cidr: '2001:30::/28', reachable: true, name: 'Drone Remote ID Protocol Entity Tags (DETs) Prefix' },
  { cidr: '2001:db8::/32', reachable: false, name: 'Documentation' },
  { cidr: '2002::/16', reachable: true, name: '6to4 — registry value N/A' },
  { cidr: '2620:4f:8000::/48', reachable: true, name: 'Direct Delegation AS112 Service' },
  { cidr: '3fff::/20', reachable: false, name: 'Documentation' },
  { cidr: '5f00::/16', reachable: false, name: 'Segment Routing (SRv6) SIDs' },
  { cidr: 'fc00::/7', reachable: false, name: 'Unique-Local', hmrcLocal: true },
  { cidr: 'fe80::/10', reachable: false, name: 'Link-Local Unicast', hmrcLocal: true },
  { cidr: 'fec0::/10', reachable: false, name: 'Deprecated site-local (RFC 3879; not an IANA row) — HMRC validator accepts', hmrcLocal: true },
];

// ── parsing ───────────────────────────────────────────────────────────────────

/** Strict dotted quad → 4 bytes, or null. Leading zeros are rejected (octal
 *  ambiguity); nothing that collects interface addresses emits them. */
export function parseIpv4(s: string): Uint8Array | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const part = m[i + 1];
    if (part.length > 1 && part[0] === '0') return null;
    const n = Number(part);
    if (n > 255) return null;
    out[i] = n;
  }
  return out;
}

/** RFC 4291 text form → 16 bytes, or null. Accepts one `::`, an embedded
 *  IPv4 in the last position, no zone suffix (strip it first — see stripZone). */
export function parseIpv6(s: string): Uint8Array | null {
  if (s.length < 2 || s.length > 45 || /[^0-9a-fA-F:.]/.test(s)) return null;
  const dbl = s.indexOf('::');
  if (dbl !== -1 && s.indexOf('::', dbl + 1) !== -1) return null;
  const head = dbl === -1 ? s : s.slice(0, dbl);
  const tail = dbl === -1 ? '' : s.slice(dbl + 2);
  const headParts = head === '' ? [] : head.split(':');
  const tailParts = tail === '' ? [] : tail.split(':');

  const groups: number[] = [];
  const pushGroup = (g: string, mayBeIpv4: boolean): boolean => {
    if (g.includes('.')) {
      if (!mayBeIpv4) return false;
      const v4 = parseIpv4(g);
      if (!v4) return false;
      groups.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
      return true;
    }
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return false;
    groups.push(parseInt(g, 16));
    return true;
  };
  for (let i = 0; i < headParts.length; i++) {
    if (!pushGroup(headParts[i], dbl === -1 && i === headParts.length - 1)) return null;
  }
  const headCount = groups.length;
  for (let i = 0; i < tailParts.length; i++) {
    if (!pushGroup(tailParts[i], i === tailParts.length - 1)) return null;
  }

  if (dbl === -1) {
    if (groups.length !== 8) return null;
  } else {
    // `::` stands for at least one zero group.
    if (groups.length > 7) return null;
    const zeros = 8 - groups.length;
    groups.splice(headCount, 0, ...new Array<number>(zeros).fill(0));
  }
  const out = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    out[i * 2] = groups[i] >> 8;
    out[i * 2 + 1] = groups[i] & 0xff;
  }
  return out;
}

/** `fe80::1%en0` → `fe80::1`. iOS/macOS getnameinfo appends the interface
 *  zone to link-local IPv6; the header carries the address alone. */
export function stripZone(s: string): string {
  const i = s.indexOf('%');
  return i === -1 ? s : s.slice(0, i);
}

export function parseIp(raw: string): { family: 4 | 6; bytes: Uint8Array } | null {
  const s = stripZone(raw.trim());
  const v4 = parseIpv4(s);
  if (v4) return { family: 4, bytes: v4 };
  const v6 = parseIpv6(s);
  return v6 ? { family: 6, bytes: v6 } : null;
}

// ── matching ──────────────────────────────────────────────────────────────────

interface Entry extends RegistryRow {
  bytes: Uint8Array;
  len: number;
}

function compile(rows: RegistryRow[], family: 4 | 6): Entry[] {
  return rows.map((row) => {
    const [addr, lenStr] = row.cidr.split('/');
    const bytes = family === 4 ? parseIpv4(addr) : parseIpv6(addr);
    const len = Number(lenStr);
    if (!bytes || !Number.isInteger(len) || len < 0 || len > bytes.length * 8) {
      throw new Error(`ipScope: bad registry row ${row.cidr}`);
    }
    return { ...row, bytes, len };
  });
}

const IPV4_TABLE = compile(IPV4_ROWS, 4);
const IPV6_TABLE = compile(IPV6_ROWS, 6);

function inPrefix(bytes: Uint8Array, prefix: Uint8Array, len: number): boolean {
  const full = len >> 3;
  for (let i = 0; i < full; i++) if (bytes[i] !== prefix[i]) return false;
  const rem = len & 7;
  if (rem === 0) return true;
  const mask = (0xff << (8 - rem)) & 0xff;
  return (bytes[full] & mask) === (prefix[full] & mask);
}

function isIpv4Mapped(v6: Uint8Array): boolean {
  for (let i = 0; i < 10; i++) if (v6[i] !== 0) return false;
  return v6[10] === 0xff && v6[11] === 0xff;
}

function classifyBytes(bytes: Uint8Array, table: Entry[]): IpScope {
  let best: Entry | null = null;
  for (const e of table) {
    if (inPrefix(bytes, e.bytes, e.len) && (!best || e.len > best.len)) best = e;
  }
  if (!best) return 'public';
  if (best.role) return best.role;
  if (best.reachable) return 'public';
  return best.hmrcLocal ? 'local' : 'special';
}

/** The scope of one address string (zone suffix tolerated). */
export function classifyIp(raw: string): IpScope {
  const parsed = parseIp(raw);
  if (!parsed) return 'invalid';
  if (parsed.family === 4) return classifyBytes(parsed.bytes, IPV4_TABLE);
  if (isIpv4Mapped(parsed.bytes)) return classifyBytes(parsed.bytes.slice(12), IPV4_TABLE);
  return classifyBytes(parsed.bytes, IPV6_TABLE);
}

export function isPublicIp(raw: string): boolean {
  return classifyIp(raw) === 'public';
}

// ── the header ────────────────────────────────────────────────────────────────

/**
 * The addresses that go in Gov-Client-Local-IPs, in collection order: zone
 * suffixes stripped, duplicates and anything that is not LOCAL (HMRC's own
 * set — SPECIAL blocks such as CGNAT and 464XLAT drop too) removed.
 * An empty result means the header is OMITTED (list values "must not be
 * empty"; an empty header is placeholder-class).
 */
export function localIpsForHeader(addresses: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of addresses) {
    if (typeof raw !== 'string') continue;
    const s = stripZone(raw.trim());
    if (!s || classifyIp(s) !== 'local') continue;
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

/**
 * The encoded header value, or '' when there is nothing to send. Spec: every
 * IPv6 value percent-encoded, separators (commas) never — IPv4 values contain
 * nothing that encodes, so one rule covers both.
 */
export function encodeLocalIpsHeader(addresses: readonly string[]): string {
  return localIpsForHeader(addresses).map(encodeURIComponent).join(',');
}
