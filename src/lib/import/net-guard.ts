import net from "node:net";

/**
 * Decides whether an IP address is somewhere a server-side fetch must never go:
 * loopback, private networks, link-local (including cloud metadata at
 * 169.254.169.254), CGNAT, multicast and the IPv6 equivalents. Anything that
 * isn't a valid IP is treated as blocked.
 */
export function isBlockedIp(ip: string): boolean {
  // Strip an IPv6 zone id ("fe80::1%en0") before parsing.
  const address = ip.split("%")[0];
  const family = net.isIP(address);
  if (family === 4) return isBlockedV4(parseV4(address));
  if (family === 6) return isBlockedV6(address);
  return true;
}

function parseV4(ip: string): number[] {
  return ip.split(".").map(Number);
}

function isBlockedV4([a, b, c]: number[]): boolean {
  return (
    a === 0 || // "this network"
    a === 10 || // private
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local + cloud metadata
    (a === 172 && b >= 16 && b <= 31) || // private
    (a === 192 && b === 0 && (c === 0 || c === 2)) || // IETF + TEST-NET-1
    (a === 192 && b === 168) || // private
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && c === 100) || // TEST-NET-2
    (a === 203 && b === 0 && c === 113) || // TEST-NET-3
    a >= 224 // multicast, reserved, broadcast
  );
}

/** Expands any IPv6 text form to its 8 16-bit groups. */
function expandV6(ip: string): number[] | null {
  let text = ip.toLowerCase();
  // An embedded IPv4 tail ("::ffff:1.2.3.4") becomes two hex groups.
  const tail = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) {
    const [a, b, c, d] = parseV4(tail[1]);
    text =
      text.slice(0, -tail[1].length) +
      `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...rest];
  const nums = groups.map((g) => parseInt(g, 16));
  return nums.length === 8 && nums.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff)
    ? nums
    : null;
}

function isBlockedV6(ip: string): boolean {
  const g = expandV6(ip);
  if (!g) return true;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g;

  // :: and ::1
  if (g.slice(0, 7).every((n) => n === 0) && (g7 === 0 || g7 === 1)) return true;

  const v4 = [g6 >> 8, g6 & 255, g7 >> 8, g7 & 255];
  // IPv4-mapped (::ffff:a.b.c.d) and deprecated IPv4-compatible (::a.b.c.d):
  // judge by the IPv4 address inside.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0xffff || g5 === 0)) {
    return isBlockedV4(v4);
  }
  // NAT64 (64:ff9b::/96) embeds an IPv4 address the same way.
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return isBlockedV4(v4);
  }
  // 6to4 (2002::/16) embeds the IPv4 address in the next 32 bits.
  if (g0 === 0x2002) return isBlockedV4([g1 >> 8, g1 & 255, g2 >> 8, g2 & 255]);

  return (
    (g0 & 0xfe00) === 0xfc00 || // unique local fc00::/7
    (g0 & 0xffc0) === 0xfe80 || // link-local fe80::/10
    (g0 & 0xffc0) === 0xfec0 || // deprecated site-local
    (g0 & 0xff00) === 0xff00 || // multicast
    (g0 === 0x2001 && g1 === 0x0db8) // documentation
  );
}
