// IP address classification for the SSRF guard. Runtime-neutral (no Node APIs).
// Blocks every range that is not globally routable unicast: RFC 6890 special-purpose
// registries for IPv4 and IPv6, plus IPv4-mapped/translated IPv6 forms.

const V4_BLOCKS = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
  ['255.255.255.255', 32],
];

export function parseIPv4(s) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const p = m.slice(1).map(Number);
  if (p.some((n) => n > 255)) return null;
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}

function inV4(ip, base, bits) {
  const b = parseIPv4(base);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return ((ip & mask) >>> 0) === ((b & mask) >>> 0);
}

/** Expand an IPv6 string to 8 16-bit groups, or null. Handles :: and a trailing dotted quad. */
export function parseIPv6(s) {
  if (typeof s !== 'string') return null;
  s = s.replace(/^\[|\]$/g, '').split('%')[0].toLowerCase();
  if (!s.includes(':')) return null;
  let tail = [];
  const dq = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (dq) {
    const v4 = parseIPv4(dq[1]);
    if (v4 === null) return null;
    tail = [v4 >>> 16, v4 & 0xffff];
    s = s.slice(0, -dq[1].length);
    if (s.endsWith(':') && !s.endsWith('::')) s = s.slice(0, -1);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const groups = [...head, ...rest].map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  if (groups.some(Number.isNaN)) return null;
  const total = groups.length + tail.length;
  if (halves.length === 1 && total !== 8) return null;
  if (total > 8) return null;
  const zeros = new Array(8 - total).fill(0);
  return halves.length === 2
    ? [...head.map((g) => parseInt(g, 16)), ...zeros, ...rest.map((g) => parseInt(g, 16)), ...tail]
    : [...groups, ...tail];
}

/** True when the address is NOT safe to fetch (private, loopback, reserved...). Unknown strings are unsafe. */
export function isBlockedIP(addr) {
  const v4 = parseIPv4(addr);
  if (v4 !== null) return V4_BLOCKS.some(([b, n]) => inV4(v4, b, n));
  const g = parseIPv6(addr);
  if (!g) return true;
  const all0 = g.every((x) => x === 0);
  if (all0) return true; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
  // IPv4-mapped ::ffff:a.b.c.d, IPv4-compatible ::a.b.c.d, NAT64 64:ff9b::/96 -> check the embedded IPv4
  const embedded = (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && (g[5] === 0xffff || g[5] === 0))
    || (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0);
  if (embedded) {
    const ip = `${g[6] >>> 8}.${g[6] & 255}.${g[7] >>> 8}.${g[7] & 255}`;
    return isBlockedIP(ip);
  }
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if ((g[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  if (g[0] === 0x2001 && g[1] < 0x0200) return true; // 2001::/23 IETF protocol assignments (Teredo etc.)
  if (g[0] === 0x2002) return true; // 6to4 (embeds arbitrary IPv4)
  if (g[0] === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true; // discard-only 100::/64
  if ((g[0] & 0xe000) !== 0x2000) return true; // outside 2000::/3 global unicast
  return false;
}

export const isIPLiteral = (h) => parseIPv4(h) !== null || parseIPv6(h) !== null;
